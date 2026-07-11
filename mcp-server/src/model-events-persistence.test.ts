// The ROTATION threshold (P1 zero-token model pipeline).
//
// These test the REAL rule that replaced an agent judgment: the ensemble-autoselect
// skill used to tell the agent "confirm the failure is persistent (one model, 3+
// retries, same 400|404|410)" and let it eyeball the retry history. That is now
// assessModelPersistence. Every clause of the rule gets a test, because each one is
// the difference between rotating a working ensemble and leaving a dead model in it.
//
// Pure function + injected clock + synthetic events: no mocks of anything under test.

import { describe, it, expect } from "vitest";

import {
  assessModelPersistence,
  parseEventHttpStatus,
  parseEventTimestamp,
  PERSISTENCE_MIN_CONSECUTIVE,
  PERSISTENCE_WINDOW_HOURS,
  ROTATE_WORTHY_STATUSES,
  type ModelEvent,
  type ModelEventKind,
} from "./model-events.js";

const NOW = new Date("2026-07-11T12:00:00+0200");

/** Build a ledger event `hoursAgo` before NOW, in the ledger's own timestamp format. */
function ev(
  model: string,
  hoursAgo: number,
  detail: string,
  kind: ModelEventKind = "non_retryable_failure",
): ModelEvent {
  const at = new Date(NOW.getTime() - hoursAgo * 3_600_000);
  // Ledger format: YYYY-MM-DDTHH:MM:SS±HHMM (offset with NO colon).
  const iso = at.toISOString().replace(/\.\d{3}Z$/, "") + "+0000";
  return { timestamp: iso, model, kind, detail };
}

/** Chronological (oldest first) — the order the append-only ledger produces. */
function failures(model: string, spec: [hoursAgo: number, status: number][]): ModelEvent[] {
  return spec.map(([h, s]) => ev(model, h, `HTTP ${s}`));
}

describe("parseEventHttpStatus — the ledger's status contract", () => {
  it("reads the status every write site spells as `HTTP <code>`", () => {
    expect(parseEventHttpStatus("HTTP 404")).toBe(404);
    expect(parseEventHttpStatus("HTTP 400 (JSON mode)")).toBe(400);
    expect(parseEventHttpStatus("HTTP 503 (judge)")).toBe(503);
  });

  it("returns null when the detail carries no status (an unclassifiable failure)", () => {
    expect(parseEventHttpStatus("blank JSON body")).toBeNull();
    expect(parseEventHttpStatus("")).toBeNull();
    // A bare number is not a status — the `HTTP ` prefix is the contract.
    expect(parseEventHttpStatus("404 things happened")).toBeNull();
  });
});

describe("parseEventTimestamp — ±HHMM offsets must not depend on engine leniency", () => {
  it("parses the ledger's colon-less offset", () => {
    expect(parseEventTimestamp("2026-07-11T12:00:00+0200")).toBe(
      Date.parse("2026-07-11T12:00:00+02:00"),
    );
    expect(parseEventTimestamp("2026-07-11T12:00:00-0500")).toBe(
      Date.parse("2026-07-11T12:00:00-05:00"),
    );
  });

  it("returns null on a malformed stamp instead of throwing", () => {
    expect(parseEventTimestamp("not-a-date")).toBeNull();
    expect(parseEventTimestamp("")).toBeNull();
  });
});

describe("assessModelPersistence — the rotation threshold", () => {
  it("declares BROKEN on 3 consecutive same-status 404s inside the window", () => {
    const v = assessModelPersistence(failures("v/dead", [[5, 404], [3, 404], [1, 404]]), { now: NOW });
    const m = v.get("v/dead");
    expect(m?.persistentlyBroken).toBe(true);
    expect(m?.httpStatus).toBe(404);
    expect(m?.consecutiveFailures).toBe(3);
    expect(m?.reason).toMatch(/3 consecutive HTTP 404/);
  });

  it("does NOT rotate on 2 failures — one below the bar is still healthy", () => {
    const v = assessModelPersistence(failures("v/flaky", [[3, 404], [1, 404]]), { now: NOW });
    const m = v.get("v/flaky");
    expect(m?.persistentlyBroken).toBe(false);
    expect(m?.consecutiveFailures).toBe(2);
    expect(m?.reason).toMatch(/not yet persistent/);
  });

  it("does NOT rotate when the LATEST failure breaks the same-status run", () => {
    // 3× 404 yesterday, but the newest failure is a 400: the error class changed,
    // so this is a provider wobble, not a settled deprecation.
    const v = assessModelPersistence(
      failures("v/wobbly", [[8, 404], [6, 404], [4, 404], [1, 400]]),
      { now: NOW },
    );
    const m = v.get("v/wobbly");
    expect(m?.persistentlyBroken).toBe(false);
    expect(m?.consecutiveFailures).toBe(1);
  });

  it("rotates on any rotate-worthy status, not just 404", () => {
    for (const status of ROTATE_WORTHY_STATUSES) {
      const v = assessModelPersistence(
        failures("v/x", [[5, status], [3, status], [1, status]]),
        { now: NOW },
      );
      expect(v.get("v/x")?.persistentlyBroken, `status ${status}`).toBe(true);
    }
  });

  it("NEVER rotates on 401/403 — an auth failure is not fixed by swapping the model", () => {
    for (const status of [401, 403]) {
      const v = assessModelPersistence(
        failures("v/authless", [[5, status], [3, status], [1, status]]),
        { now: NOW },
      );
      const m = v.get("v/authless");
      expect(m?.persistentlyBroken, `status ${status}`).toBe(false);
      expect(m?.reason).toMatch(/not model-scoped/);
    }
  });

  it("NEVER rotates on a 5xx burst — that is the provider's problem, not the model's", () => {
    const v = assessModelPersistence(
      failures("v/degraded-provider", [[5, 500], [3, 502], [2, 503], [1, 500]]),
      { now: NOW },
    );
    expect(v.get("v/degraded-provider")?.persistentlyBroken).toBe(false);
  });

  it("ignores 429s entirely — free-tier rate limits are normal, not a defect", () => {
    const events: ModelEvent[] = [
      ev("v/ratelimited", 5, "429 during call", "rate_limit_429"),
      ev("v/ratelimited", 3, "429 during call", "rate_limit_429"),
      ev("v/ratelimited", 1, "429 during call", "rate_limit_429"),
    ];
    // Not even present in the map: nothing rotation-relevant on the ledger.
    expect(assessModelPersistence(events, { now: NOW }).has("v/ratelimited")).toBe(false);
  });

  it("ages failures out of the window — an old, healed break must not rotate today", () => {
    const v = assessModelPersistence(
      failures("v/healed", [[30, 404], [29, 404], [28, 404]]),
      { now: NOW },
    );
    expect(v.has("v/healed")).toBe(false);
  });

  it("counts only the IN-window part of a run that straddles the window edge", () => {
    // 2 inside 24h, 2 outside → the in-window run is 2 → below the bar.
    const v = assessModelPersistence(
      failures("v/edge", [[40, 404], [30, 404], [10, 404], [1, 404]]),
      { now: NOW },
    );
    const m = v.get("v/edge");
    expect(m?.persistentlyBroken).toBe(false);
    expect(m?.consecutiveFailures).toBe(2);
  });

  it("skips events with an unparseable timestamp rather than crashing (fail-safe)", () => {
    const good = failures("v/dead", [[5, 404], [3, 404]]);
    const broken: ModelEvent = {
      timestamp: "garbage",
      model: "v/dead",
      kind: "non_retryable_failure",
      detail: "HTTP 404",
    };
    const v = assessModelPersistence([...good, broken], { now: NOW });
    // The unplaceable event is NOT counted — it can only make us less likely to
    // rotate, never more.
    expect(v.get("v/dead")?.consecutiveFailures).toBe(2);
    expect(v.get("v/dead")?.persistentlyBroken).toBe(false);
  });

  it("skips a non_retryable_failure whose detail carries no status", () => {
    const events = [
      ...failures("v/x", [[5, 404], [3, 404]]),
      ev("v/x", 1, "socket hang up"),
    ];
    expect(assessModelPersistence(events, { now: NOW }).get("v/x")?.consecutiveFailures).toBe(2);
  });

  it("is order-insensitive — concurrent appends must not fake a trailing run", () => {
    // Same events, shuffled: the newest is still the 400, so still not broken.
    const shuffled = [
      ev("v/wobbly", 1, "HTTP 400"),
      ev("v/wobbly", 6, "HTTP 404"),
      ev("v/wobbly", 4, "HTTP 404"),
      ev("v/wobbly", 8, "HTTP 404"),
    ];
    expect(assessModelPersistence(shuffled, { now: NOW }).get("v/wobbly")?.persistentlyBroken).toBe(false);
  });

  it("keeps each model's verdict independent", () => {
    const events = [
      ...failures("v/dead", [[5, 404], [3, 404], [1, 404]]),
      ...failures("v/alive", [[2, 404]]),
    ];
    const v = assessModelPersistence(events, { now: NOW });
    expect(v.get("v/dead")?.persistentlyBroken).toBe(true);
    expect(v.get("v/alive")?.persistentlyBroken).toBe(false);
  });

  it("honors overridden thresholds", () => {
    const events = failures("v/x", [[1, 404], [2, 404]]);
    expect(
      assessModelPersistence(events, { now: NOW, minConsecutive: 2 }).get("v/x")?.persistentlyBroken,
    ).toBe(true);
    // A 1-hour window drops the 2h-old event → only 1 in-window failure.
    expect(
      assessModelPersistence(events, { now: NOW, windowHours: 1.5, minConsecutive: 2 }).get("v/x")
        ?.persistentlyBroken,
    ).toBe(false);
  });

  it("rejects nonsensical thresholds instead of silently defaulting", () => {
    expect(() => assessModelPersistence([], { windowHours: 0 })).toThrow(/windowHours must be > 0/);
    expect(() => assessModelPersistence([], { minConsecutive: 0 })).toThrow(/positive integer/);
  });

  it("pins the shipped defaults (3 failures / 24h) — changing them is a deliberate act", () => {
    expect(PERSISTENCE_MIN_CONSECUTIVE).toBe(3);
    expect(PERSISTENCE_WINDOW_HOURS).toBe(24);
    expect([...ROTATE_WORTHY_STATUSES]).toEqual([400, 404, 410, 422]);
  });
});
