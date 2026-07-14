// Free-model rotation — the cross-call cooldown registry and the rotation
// executor. Everything here is hermetic: an injected clock, an injected RAM-only
// store, and a mocked callOne. No network, no LLM, no writes to the real
// ~/.llm-externalizer (the persistence tests point LLM_EXT_CONFIG_DIR at a tmp
// dir and exercise the REAL atomic writer).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import {
  AllFreeModelsExhaustedError,
  applyUnavailable,
  callWithFreeRotation,
  classifyUnavailable,
  clearCooldown,
  computeCooldownUntil,
  cooldownFilePath,
  earliestReset,
  emptyStore,
  getCooldownStore,
  isCooling,
  memoryRotationStore,
  nextUtcMidnight,
  orderByAvailability,
  pruneExpired,
  recordAvailable,
  recordUnavailable,
  resetCooldownCacheForTests,
} from "./free-rotation";

const T0 = Date.UTC(2026, 6, 14, 10, 0, 0); // 2026-07-14T10:00:00Z
const slot = (id: string) => ({ id, maxOutput: 1000 });

describe("classifyUnavailable — decides WHETHER to rotate and for HOW LONG", () => {
  it("classifies a spent DAILY free quota as daily-quota, not a transient 429", () => {
    // OpenRouter phrases the daily cap as a 429 too. Treating it as transient
    // would send us back into the same wall every 30s until midnight UTC.
    expect(classifyUnavailable("Rate limit exceeded: free-models-per-day")).toBe("daily-quota");
    expect(classifyUnavailable("429: you have exceeded your daily quota")).toBe("daily-quota");
    expect(classifyUnavailable("Daily limit reached for this model")).toBe("daily-quota");
  });

  it("classifies a plain 429 / overload as transient", () => {
    expect(classifyUnavailable("HTTP 429: too many requests")).toBe("transient");
    expect(classifyUnavailable("503 overloaded")).toBe("transient");
    expect(classifyUnavailable("Provider temporarily unavailable")).toBe("transient");
  });

  it("classifies an unroutable model (no endpoints / 404) as gone", () => {
    expect(classifyUnavailable("No endpoints found for model")).toBe("gone");
    expect(classifyUnavailable("404 not found")).toBe("gone");
  });

  it("returns null for a REAL defect — a 400, a bad key, a schema error", () => {
    // The load-bearing negative: rotating on a real bug would burn the entire
    // approved pool while hiding the one error the user needs to see.
    expect(classifyUnavailable("invalid api key")).toBeNull();
    expect(classifyUnavailable("400 bad request: messages[0].role is invalid")).toBeNull();
    expect(classifyUnavailable("")).toBeNull();
  });
});

describe("cooldown maths", () => {
  it("nextUtcMidnight is the next 00:00 UTC — when free daily quotas reset", () => {
    expect(nextUtcMidnight(T0)).toBe(Date.UTC(2026, 6, 15, 0, 0, 0));
    // One minute before midnight still rolls to the NEXT day's midnight.
    expect(nextUtcMidnight(Date.UTC(2026, 6, 14, 23, 59, 0))).toBe(Date.UTC(2026, 6, 15, 0, 0, 0));
  });

  it("a daily-quota cooldown lasts until UTC midnight, whatever the strike count", () => {
    expect(computeCooldownUntil("daily-quota", 1, T0)).toBe(Date.UTC(2026, 6, 15, 0, 0, 0));
    expect(computeCooldownUntil("daily-quota", 9, T0)).toBe(Date.UTC(2026, 6, 15, 0, 0, 0));
  });

  it("a transient cooldown backs off exponentially and caps at 5 minutes", () => {
    expect(computeCooldownUntil("transient", 1, T0)).toBe(T0 + 30_000);
    expect(computeCooldownUntil("transient", 2, T0)).toBe(T0 + 60_000);
    expect(computeCooldownUntil("transient", 3, T0)).toBe(T0 + 120_000);
    expect(computeCooldownUntil("transient", 8, T0)).toBe(T0 + 300_000); // capped
  });

  it("applyUnavailable ignores a non-availability error — a real bug never cools a healthy model", () => {
    const s = applyUnavailable(emptyStore(), "a:free", "invalid api key", T0);
    expect(s.models["a:free"]).toBeUndefined();
  });

  it("transient strikes accumulate only while the previous cooldown is still in force", () => {
    let s = applyUnavailable(emptyStore(), "a:free", "429", T0);
    expect(s.models["a:free"].strikes).toBe(1);
    s = applyUnavailable(s, "a:free", "429", T0 + 1_000); // still cooling → escalate
    expect(s.models["a:free"].strikes).toBe(2);
    // A model that has been healthy since its last 429 starts the ladder over.
    s = applyUnavailable(s, "a:free", "429", T0 + 999_999);
    expect(s.models["a:free"].strikes).toBe(1);
  });

  it("a success clears the cooldown immediately — recovery is not rate-limited", () => {
    const s = applyUnavailable(emptyStore(), "a:free", "429", T0);
    expect(isCooling(s, "a:free", T0)).toBe(true);
    expect(isCooling(clearCooldown(s, "a:free"), "a:free", T0)).toBe(false);
  });

  it("pruneExpired drops entries whose cooldown has elapsed", () => {
    const s = applyUnavailable(emptyStore(), "a:free", "429", T0);
    expect(Object.keys(pruneExpired(s, T0 + 10_000).models)).toEqual(["a:free"]);
    expect(Object.keys(pruneExpired(s, T0 + 60_000).models)).toEqual([]);
  });

  it("earliestReset reports the soonest moment any of the ids frees up", () => {
    let s = applyUnavailable(emptyStore(), "a:free", "free-models-per-day", T0); // midnight
    s = applyUnavailable(s, "b:free", "429", T0); // +30s
    expect(earliestReset(s, ["a:free", "b:free"], T0)).toBe(T0 + 30_000);
    // An id with no cooldown at all is available NOW.
    expect(earliestReset(s, ["a:free", "c:free"], T0)).toBe(T0);
  });
});

describe("orderByAvailability — cooling models are DEFERRED, never dropped", () => {
  it("puts fresh models first and sorts the cooling ones by soonest expiry", () => {
    let s = applyUnavailable(emptyStore(), "a:free", "free-models-per-day", T0); // longest
    s = applyUnavailable(s, "b:free", "429", T0); // shortest
    const { fresh, deferred } = orderByAvailability(
      [slot("a:free"), slot("b:free"), slot("c:free")],
      s,
      T0,
    );
    expect(fresh.map((f) => f.id)).toEqual(["c:free"]);
    // Deferred — but still present. A wrong cooldown may reorder attempts; it
    // must never remove a model from the rotation entirely.
    expect(deferred.map((f) => f.id)).toEqual(["b:free", "a:free"]);
  });
});

describe("callWithFreeRotation — rotate until one answers or the pool is truly spent", () => {
  it("returns the primary's result and never touches a fallback when it succeeds", async () => {
    const called: string[] = [];
    const r = await callWithFreeRotation(
      slot("p:free"),
      [slot("f1:free")],
      async (m) => {
        called.push(m);
        return `ok:${m}`;
      },
      { now: () => T0, store: memoryRotationStore() },
    );
    expect(r).toBe("ok:p:free");
    expect(called).toEqual(["p:free"]);
  });

  it("rotates through EVERY approved free model, then throws AllFreeModelsExhausted", async () => {
    const called: string[] = [];
    const store = memoryRotationStore();
    await expect(
      callWithFreeRotation(
        slot("p:free"),
        [slot("f1:free"), slot("f2:free")],
        async (m) => {
          called.push(m);
          throw new Error("429 rate limit");
        },
        { now: () => T0, store },
      ),
    ).rejects.toBeInstanceOf(AllFreeModelsExhaustedError);
    // "Exhausted" means every model was ACTUALLY tried — not "the registry
    // believed they were all busy".
    expect(called).toEqual(["p:free", "f1:free", "f2:free"]);
    expect(isCooling(store.get(T0), "f2:free", T0)).toBe(true);
  });

  it("re-throws a NON-availability error instead of burning the pool on a real bug", async () => {
    const called: string[] = [];
    await expect(
      callWithFreeRotation(
        slot("p:free"),
        [slot("f1:free")],
        async (m) => {
          called.push(m);
          throw new Error("400 bad request: messages[0].role is invalid");
        },
        { now: () => T0, store: memoryRotationStore() },
      ),
    ).rejects.toThrow(/400 bad request/);
    expect(called).toEqual(["p:free"]); // never rotated
  });

  it("SKIPS a primary already known to be daily-capped — the whole point of the registry", async () => {
    // This is the 50-file-scan bug: without a registry every file re-tried the
    // spent primary and paid a 429 for the privilege.
    const store = memoryRotationStore(
      applyUnavailable(emptyStore(), "p:free", "free-models-per-day", T0),
    );
    const called: string[] = [];
    const r = await callWithFreeRotation(
      slot("p:free"),
      [slot("f1:free")],
      async (m) => {
        called.push(m);
        return `ok:${m}`;
      },
      { now: () => T0 + 1_000, store },
    );
    expect(r).toBe("ok:f1:free");
    expect(called).toEqual(["f1:free"]); // the spent primary was never called
  });

  it("PROBES a cooling model anyway once the pool is exhausted — a bad guess must not brick the tool", async () => {
    // Invariant 2: a cooldown is a heuristic derived from an error string. If it
    // is wrong, the tool must degrade to "one wasted 429", never to "refuses to run".
    const store = memoryRotationStore(
      applyUnavailable(emptyStore(), "p:free", "429", T0),
    );
    const called: string[] = [];
    const r = await callWithFreeRotation(
      slot("p:free"),
      [slot("f1:free")],
      async (m) => {
        called.push(m);
        if (m === "f1:free") throw new Error("429 rate limit");
        return `ok:${m}`; // the "cooling" primary is actually fine
      },
      { now: () => T0 + 1_000, store },
    );
    expect(r).toBe("ok:p:free");
    expect(called).toEqual(["f1:free", "p:free"]); // deferred, then probed
  });

  it("rotates on a failure reported as a VALUE (the ensemble slot's shape)", async () => {
    const r = await callWithFreeRotation<{ ok: boolean; detail: string }>(
      slot("p:free"),
      [slot("f1:free")],
      async (m) =>
        m === "p:free"
          ? { ok: false, detail: "429 too many requests" }
          : { ok: true, detail: "" },
      {
        now: () => T0,
        store: memoryRotationStore(),
        resultFailureDetail: (r) => (r.ok ? null : r.detail),
      },
    );
    expect(r.ok).toBe(true);
  });

  it("a SHARED cursor stops two concurrent slots claiming the same fallback", async () => {
    let next = 0;
    const claim = () => next++;
    const store = memoryRotationStore();
    const callOne = async (m: string) => {
      if (m.startsWith("p")) throw new Error("429");
      return `ok:${m}`;
    };
    const [a, b] = await Promise.all([
      callWithFreeRotation(slot("p0:free"), [slot("f1:free"), slot("f2:free")], callOne, { now: () => T0, store }, claim),
      callWithFreeRotation(slot("p1:free"), [slot("f1:free"), slot("f2:free")], callOne, { now: () => T0, store }, claim),
    ]);
    expect(new Set([a, b])).toEqual(new Set(["ok:f1:free", "ok:f2:free"]));
  });

  it("an empty approved pool fails immediately — it never silently falls back to a paid model", async () => {
    await expect(
      callWithFreeRotation(
        slot("p:free"),
        [],
        async () => {
          throw new Error("free-models-per-day");
        },
        { now: () => T0, store: memoryRotationStore() },
      ),
    ).rejects.toBeInstanceOf(AllFreeModelsExhaustedError);
  });
});

describe("persistent registry — survives across processes (the CLI and the MCP server share one quota)", () => {
  let dir: string;
  let prev: string | undefined;

  beforeEach(() => {
    prev = process.env.LLM_EXT_CONFIG_DIR;
    // mkdtemp under /tmp specifically: getConfigDir()'s traversal guard only
    // permits paths under $HOME or /tmp, and os.tmpdir() resolves to
    // /var/folders/... on macOS — which it rejects.
    dir = mkdtempSync(join("/tmp", "llm-ext-cooldown-"));
    process.env.LLM_EXT_CONFIG_DIR = dir;
    resetCooldownCacheForTests();
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
    else process.env.LLM_EXT_CONFIG_DIR = prev;
    resetCooldownCacheForTests();
  });

  it("writes a cooldown to disk and reads it back in a fresh process", () => {
    recordUnavailable("a:free", "free-models-per-day", T0);
    expect(existsSync(cooldownFilePath())).toBe(true);
    const onDisk = JSON.parse(readFileSync(cooldownFilePath(), "utf-8"));
    expect(onDisk.models["a:free"].kind).toBe("daily-quota");

    // Simulate a second process: drop the in-memory copy, re-read from disk.
    resetCooldownCacheForTests();
    expect(isCooling(getCooldownStore(T0 + 1_000), "a:free", T0 + 1_000)).toBe(true);
  });

  it("a success clears the on-disk cooldown", () => {
    recordUnavailable("a:free", "429", T0);
    recordAvailable("a:free", T0 + 1_000);
    resetCooldownCacheForTests();
    expect(isCooling(getCooldownStore(T0 + 2_000), "a:free", T0 + 2_000)).toBe(false);
  });

  it("a corrupt registry file degrades to an empty one — it never fails a live call", () => {
    writeFileSync(cooldownFilePath(), "{ not json", "utf-8");
    resetCooldownCacheForTests();
    expect(getCooldownStore(T0).models).toEqual({});
    // And it is still writable afterwards.
    expect(() => recordUnavailable("a:free", "429", T0)).not.toThrow();
  });
});
