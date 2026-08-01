// Ensemble coverage of the health ledger (P1 zero-token model pipeline).
//
// Before P1 the ledger only informed tools that own a per-tool selector benchmark
// (security_scan, search_existing_implementations). The ENSEMBLE slots — which serve
// every other tool — had no automated verdict at all: the skill asked the AGENT to
// read the retry history and decide whether a 404 was "persistent". planEnsembleRotation
// closes that gap with the code threshold.
//
// The ledger here is a REAL file read by the REAL readModelEvents (eventsPath is the
// module's own injectable IO seam, not a mock of the thing under test). Only the
// settings resolver is faked — it is the seam that would otherwise read the developer's
// own ~/.llm-externalizer.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { planEnsembleRotation, renderEnsembleRotationSection } from "./auto-replace.js";
import type { EnsembleReader } from "./auto-replace.js";

const NOW = new Date("2026-07-11T12:00:00+0200");

/** A ledger line in the exact on-disk format appendModelEvent writes. */
function line(model: string, hoursAgo: number, kind: string, detail: string): string {
  const at = new Date(NOW.getTime() - hoursAgo * 3_600_000);
  const ts = at.toISOString().replace(/\.\d{3}Z$/, "") + "+0000";
  return `${ts} - ${model} - ${kind} - ${detail}`;
}

const reader = (): EnsembleReader => ({
  profileName: "ens",
  slots: [
    { slot: "model", modelId: "v/first" },
    { slot: "second_model", modelId: "v/second" },
    { slot: "third_model", modelId: "v/third" },
  ],
});

describe("planEnsembleRotation", () => {
  let dir = "";
  let ledger = "";

  beforeEach(() => {
    dir = mkdtempSync(join("/tmp", "ensrot-"));
    ledger = join(dir, "model-events.log");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reports every slot healthy on an EMPTY ledger — a quiet model never rotates", () => {
    writeFileSync(ledger, "");
    const plan = planEnsembleRotation({
      eventsPath: ledger,
      settingsReader: reader,
      persistence: { now: NOW },
    });
    expect(plan.profileName).toBe("ens");
    expect(plan.slots).toHaveLength(3);
    expect(plan.rotationNeeded).toBe(false);
    expect(plan.brokenSlots).toEqual([]);
    expect(plan.slots[0].verdict.reason).toMatch(/no model-scoped failure/);
  });

  it("flags ONLY the slot whose model crossed the threshold", () => {
    writeFileSync(
      ledger,
      [
        line("v/second", 5, "non_retryable_failure", "HTTP 404"),
        line("v/second", 3, "non_retryable_failure", "HTTP 404"),
        line("v/second", 1, "non_retryable_failure", "HTTP 404"),
        // Noise that must NOT rotate anything: rate limits and a healed old break.
        line("v/first", 2, "rate_limit_429", "429 during call"),
        line("v/third", 40, "non_retryable_failure", "HTTP 404"),
        line("v/third", 39, "non_retryable_failure", "HTTP 404"),
        line("v/third", 38, "non_retryable_failure", "HTTP 404"),
        "",
      ].join("\n"),
    );
    const plan = planEnsembleRotation({
      eventsPath: ledger,
      settingsReader: reader,
      persistence: { now: NOW },
    });
    expect(plan.rotationNeeded).toBe(true);
    expect(plan.brokenSlots.map((s) => s.slot)).toEqual(["second_model"]);
    expect(plan.brokenSlots[0].modelId).toBe("v/second");
    expect(plan.brokenSlots[0].verdict.httpStatus).toBe(404);
    // The 429-only slot and the aged-out slot stay healthy.
    expect(plan.slots.find((s) => s.slot === "model")?.verdict.persistentlyBroken).toBe(false);
    expect(plan.slots.find((s) => s.slot === "third_model")?.verdict.persistentlyBroken).toBe(false);
  });

  it("does not rotate on a 5xx burst against a live ensemble model", () => {
    writeFileSync(
      ledger,
      [
        line("v/first", 3, "non_retryable_failure", "HTTP 503"),
        line("v/first", 2, "non_retryable_failure", "HTTP 503"),
        line("v/first", 1, "non_retryable_failure", "HTTP 503"),
        "",
      ].join("\n"),
    );
    const plan = planEnsembleRotation({
      eventsPath: ledger,
      settingsReader: reader,
      persistence: { now: NOW },
    });
    expect(plan.rotationNeeded).toBe(false);
  });

  it("tolerates a missing ledger file (a fresh install has no events yet)", () => {
    const plan = planEnsembleRotation({
      eventsPath: join(dir, "nope.log"),
      settingsReader: reader,
      persistence: { now: NOW },
    });
    expect(plan.rotationNeeded).toBe(false);
    expect(plan.slots).toHaveLength(3);
  });

  it("handles a profile with no configured slot at all", () => {
    writeFileSync(ledger, "");
    const plan = planEnsembleRotation({
      eventsPath: ledger,
      settingsReader: () => ({ profileName: "(unconfigured)", slots: [] }),
      persistence: { now: NOW },
    });
    expect(plan.slots).toEqual([]);
    expect(plan.rotationNeeded).toBe(false);
    expect(renderEnsembleRotationSection(plan)).toContain("No ensemble slot is configured");
  });

  it("renders a report section that states the verdict without any paraphrase needed", () => {
    writeFileSync(
      ledger,
      [
        line("v/first", 5, "non_retryable_failure", "HTTP 410"),
        line("v/first", 3, "non_retryable_failure", "HTTP 410"),
        line("v/first", 1, "non_retryable_failure", "HTTP 410"),
        "",
      ].join("\n"),
    );
    const plan = planEnsembleRotation({
      eventsPath: ledger,
      settingsReader: reader,
      persistence: { now: NOW },
    });
    const md = renderEnsembleRotationSection(plan);
    expect(md).toContain("1 of 3 slot(s) are PERSISTENTLY BROKEN");
    expect(md).toContain("**model:** `v/first` — BROKEN");
    expect(md).toContain("3 consecutive HTTP 410 failures");
    expect(md).toContain("**second_model:** `v/second` — healthy");
  });
});
