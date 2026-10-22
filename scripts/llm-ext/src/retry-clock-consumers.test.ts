/**
 * retry-clock-consumers.test.ts — TRDD-YG72CYY7 inc 1 review fixes F3 and F5:
 * what the message-based consumers and the per-file classifier do with a
 * RetryDeadlineError. Real functions, no mocks.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { RetryDeadlineError, failureText } from "./provider/http.js";
import { callWithFreeRotation, memoryRotationStore, resetCooldownCacheForTests } from "./free-rotation.js";
import { summarizeSession, type CallModelFn } from "./session_summary/driver.js";

import type { RetryClock } from "./provider/http.js";

const TRAIL = { attempts: 4, elapsedMs: 300_000, lastStatus: 500, lastProvider: "openrouter" };
/** Neutral message (no "429/502/503/overloaded"), real cause in `.cause`. */
const deadlineError = (cause: string) => new RetryDeadlineError(TRAIL, new Error(cause));

describe("F3: consumers read the cause of a RetryDeadlineError, not its neutral message", () => {
  it("failureText returns the cause text for a RetryDeadlineError and the message for any other error", () => {
    expect(failureText(deadlineError("API error 500 (openrouter): overloaded"))).toBe(
      "API error 500 (openrouter): overloaded",
    );
    expect(failureText(new Error("plain"))).toBe("plain");
    expect(failureText("str")).toBe("str");
    // A network failure outliving the window still shows the endpoint-dead token.
    expect(failureText(deadlineError("fetch failed ECONNREFUSED"))).toMatch(/ECONNREFUSED/);
  });

  it("free rotation rethrows a RetryDeadlineError unchanged: the second model is never called and neither model is recorded unavailable", async () => {
    const called: string[] = [];
    const store = memoryRotationStore();
    const dl = deadlineError("API error 503 (openrouter): provider overloaded");
    const err = await callWithFreeRotation(
      { id: "p:free", maxOutput: 1000 },
      [{ id: "f1:free", maxOutput: 1000 }],
      async (m) => {
        called.push(m);
        throw dl;
      },
      { now: () => 0, store },
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBe(dl);
    expect(called).toEqual(["p:free"]);
    expect(Object.keys(store.get(0).models)).toEqual([]);
  });

  it("c: a model that fails with its own availability error while the shared clock closes ends the rotation with a RetryDeadlineError carrying that error; only the tried model is recorded unavailable", async () => {
    const called: string[] = [];
    const store = memoryRotationStore();
    const clock: RetryClock = { startedAt: Date.now(), deadlineAt: Date.now() + 100_000, attempts: 3, lastStatus: 503 };
    const plain = new Error("API error 503 (openrouter): provider overloaded");
    const err = await callWithFreeRotation(
      { id: "p:free", maxOutput: 1000 },
      [{ id: "f1:free", maxOutput: 1000 }],
      async (m) => {
        called.push(m);
        clock.expired = true;
        throw plain;
      },
      { now: () => 0, store, retryClock: clock },
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RetryDeadlineError);
    expect((err as RetryDeadlineError).cause).toBe(plain);
    expect((err as RetryDeadlineError).trail.attempts).toBe(3);
    expect(called).toEqual(["p:free"]);
    expect(Object.keys(store.get(0).models)).toEqual(["p:free"]);
  });

  it("c2: a clock already closed before the first candidate means zero calls and a RetryDeadlineError whose cause is clock.lastError", async () => {
    const called: string[] = [];
    const store = memoryRotationStore();
    const last = new Error("API error 503 (openrouter): provider overloaded");
    const clock: RetryClock = { startedAt: Date.now(), expired: true, lastError: last };
    const err = await callWithFreeRotation(
      { id: "p:free", maxOutput: 1000 },
      [{ id: "f1:free", maxOutput: 1000 }],
      async (m) => {
        called.push(m);
        return "ok";
      },
      { now: () => 0, store, retryClock: clock },
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RetryDeadlineError);
    expect((err as RetryDeadlineError).cause).toBe(last);
    expect(called).toEqual([]);
    expect(Object.keys(store.get(0).models)).toEqual([]);
  });

});

describe("F3: session_summary never gets longer on a RetryDeadlineError", () => {
  let dir: string;
  let prevConfigDir: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join("/tmp", "retry-clock-driver-"));
    prevConfigDir = process.env.LLM_EXT_CONFIG_DIR;
    process.env.LLM_EXT_CONFIG_DIR = mkdtempSync(join("/tmp", "llm-ext-rcc-cooldowns-"));
    resetCooldownCacheForTests();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (prevConfigDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
    else process.env.LLM_EXT_CONFIG_DIR = prevConfigDir;
  });

  it("fails fast with the checkpoint after ONE call, not maxRetries+1 five-minute windows", async () => {
    const transcript = join(dir, "in.jsonl");
    writeFileSync(
      transcript,
      JSON.stringify({ type: "user", uuid: "u1", parentUuid: null, timestamp: "t", message: { role: "user", content: "hello" } }) + "\n",
    );
    const checkpointPath = join(dir, "checkpoint.json");
    let calls = 0;
    const callModel = vi.fn<CallModelFn>(async () => {
      calls++;
      throw deadlineError("API error 500 (openrouter): provider overloaded");
    });
    await expect(
      summarizeSession({
        transcriptPath: transcript,
        checkpointPath,
        modelId: "vendor/m:free",
        modelMaxContext: 1_000_000,
        modelMaxCompletionTokens: 65_536,
        maxRetriesPerChunk: 5,
        callModel,
      }),
    ).rejects.toThrow(/Checkpoint saved at/);
    expect(calls).toBe(1);
  });
});

const YAML = `active: bare
allow_paid_models: true
profiles:
  bare:
    mode: remote
    api: openrouter-remote
    model: vendor/whatever
    api_key: "sk-test-fake-openrouter-key"
`;

/** index.ts reads settings once at import; re-import fresh against a throwaway config dir. */
async function loadFreshIndex() {
  const cfgDir = mkdtempSync(join("/tmp", "llm-ext-rcc-cfg-"));
  writeFileSync(join(cfgDir, "settings.yaml"), YAML, "utf-8");
  const prev = process.env.LLM_EXT_CONFIG_DIR;
  process.env.LLM_EXT_CONFIG_DIR = cfgDir;
  vi.resetModules();
  const idx = await import("./index.js");
  // Same module registry as idx: the classes index.ts's own instanceof sees.
  const { ProfileExhaustedError } = await import("./profile-fallback.js");
  const { RetryDeadlineError: Deadline } = await import("./provider/http.js");
  return {
    idx,
    ProfileExhaustedError,
    Deadline,
    cleanup: () => {
      if (prev === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
      else process.env.LLM_EXT_CONFIG_DIR = prev;
      rmSync(cfgDir, { recursive: true, force: true });
    },
  };
}


describe("N5(b): the per-file reason of a chain exhaustion carries the deadline cause", () => {
  it("appends the first RetryDeadlineError message to the reason without changing the classification", async () => {
    const { idx, ProfileExhaustedError, Deadline, cleanup } = await loadFreshIndex();
    try {
      const dl = new Deadline(TRAIL, new Error("API error 500 (openrouter): overloaded"));
      const v = idx.__classifyErrorForTests(
        new ProfileExhaustedError("p", "static", [new Error("API error 403 (openrouter): Access forbidden"), dl]),
      );
      expect(v).toMatchObject({ unrecoverable: true, serviceLevel: false, countsAsFailure: true });
      expect(v.reason).toContain(dl.message);
    } finally {
      cleanup();
    }
  });
});

describe("N1 (non-free path only; free path left for round B): an ensemble slot keeps the real cause of a RetryDeadlineError", () => {
  it("callEnsembleSlotWithRotation: a RetryDeadlineError whose cause is not an availability or payment error escapes the rotation and becomes an error entry carrying the neutral sentence, the real cause text, and the thrown error", async () => {
    const { idx, Deadline, cleanup } = await loadFreshIndex();
    try {
      // A 400 is neither "unavailable" (classifyUnavailable) nor a payment
      // error, so callWithFreeRotation rethrows it: the code path under test is
      // the function's FINAL catch, not the rotation.
      const dl = new Deadline(TRAIL, new Error("API error 400 (openrouter): bad request shape"));
      const entry = await idx.callEnsembleSlotWithRotation(
        { id: "p:free", maxOutput: 1000 },
        [],
        () => 0,
        async () => {
          throw dl;
        },
        { now: () => 0, store: memoryRotationStore() },
      );
      expect(entry.error).toBe(true);
      expect(entry.cause).toBe(dl);
      expect(entry.content).toContain(dl.message);
      expect(entry.content).toContain("API error 400");
    } finally {
      cleanup();
    }
  });
});

describe("N1 regression guard: a static chain exhaustion made only of RetryDeadlineErrors is final for the file", () => {
  it("classifyError gives the same verdict as the mixed-chain case: unrecoverable, not service-level, counts as a failure", async () => {
    const { idx, ProfileExhaustedError, Deadline, cleanup } = await loadFreshIndex();
    try {
      const dl = new Deadline(TRAIL, new Error("API error 503 (openrouter): overloaded"));
      const v = idx.__classifyErrorForTests(new ProfileExhaustedError("p", "static", [dl, dl]));
      expect(v).toMatchObject({ unrecoverable: true, serviceLevel: false, countsAsFailure: true });
      expect(v.reason).toContain(dl.message);
    } finally {
      cleanup();
    }
  });
});
describe("pickEnsembleAllFailedError: which error an all-failed ensemble throws", () => {
  type Slot = { model: string; content: string; usage: undefined; truncated: boolean; error: boolean; cause?: unknown };
  const slot = (cause?: unknown): Slot => ({ model: "m", content: "ERROR: x", usage: undefined, truncated: false, error: true, cause });
  const dl = (Deadline: typeof RetryDeadlineError) => new Deadline(TRAIL, new Error("API error 503 (openrouter): overloaded"));

  it("all closed windows: static ProfileExhaustedError carrying those causes", async () => {
    const { idx, ProfileExhaustedError, Deadline, cleanup } = await loadFreshIndex();
    try {
      const a = dl(Deadline);
      const b = dl(Deadline);
      const out = idx.pickEnsembleAllFailedError("p", [slot(a), slot(b)], new Error("all"));
      expect(out).toBeInstanceOf(ProfileExhaustedError);
      expect((out as InstanceType<typeof ProfileExhaustedError>).causes).toEqual([a, b]);
    } finally {
      cleanup();
    }
  });

  it("a closed window plus a cause-less entry: ProfileExhaustedError with the one defined cause", async () => {
    const { idx, ProfileExhaustedError, Deadline, cleanup } = await loadFreshIndex();
    try {
      const a = dl(Deadline);
      const out = idx.pickEnsembleAllFailedError("p", [slot(a), slot()], new Error("all"));
      expect(out).toBeInstanceOf(ProfileExhaustedError);
      expect((out as InstanceType<typeof ProfileExhaustedError>).causes).toEqual([a]);
    } finally {
      cleanup();
    }
  });

  it("a closed window plus a deterministic 400: ProfileExhaustedError", async () => {
    const { idx, ProfileExhaustedError, Deadline, cleanup } = await loadFreshIndex();
    try {
      const out = idx.pickEnsembleAllFailedError(
        "p",
        [slot(dl(Deadline)), slot(new Error("API error 400 (openrouter): bad request"))],
        new Error("all"),
      );
      expect(out).toBeInstanceOf(ProfileExhaustedError);
      // The trace that makes this final for the file: classifyError reaches its deadline branch.
      expect(idx.__classifyErrorForTests(out)).toMatchObject({ unrecoverable: true, serviceLevel: false, countsAsFailure: true });
    } finally {
      cleanup();
    }
  });

  it.each([
    ["401 (service-level)", new Error("API error 401 (openrouter): bad key")],
    ["403 (service-level)", new Error("API error 403 (openrouter): forbidden")],
    ["a plain 503", new Error("API error 503 (openrouter): overloaded")],
    ["429 (rate limit)", new Error("API error 429 (openrouter): slow down")],
    ["408 (timeout)", new Error("API error 408 (openrouter): timeout")],
    ["413 (too large)", new Error("API error 413 (openrouter): too large")],
    ["a context overflow 400", new Error("API error 400 (openrouter): maximum context length is 8192 tokens")],
    ["a non-Error cause", "API error 400 (openrouter): bad request"],
  ])("a closed window plus %s keeps allFailed (same object)", async (_label, other) => {
    const { idx, Deadline, cleanup } = await loadFreshIndex();
    try {
      const allFailed = new Error("all");
      expect(idx.pickEnsembleAllFailedError("p", [slot(dl(Deadline)), slot(other)], allFailed)).toBe(allFailed);
    } finally {
      cleanup();
    }
  });

  it("no closed window at all, and an empty list, keep allFailed", async () => {
    const { idx, cleanup } = await loadFreshIndex();
    try {
      const allFailed = new Error("all");
      expect(idx.pickEnsembleAllFailedError("p", [slot(new Error("API error 400 x")), slot()], allFailed)).toBe(allFailed);
      expect(idx.pickEnsembleAllFailedError("p", [], allFailed)).toBe(allFailed);
    } finally {
      cleanup();
    }
  });


  it("a dispatchClosed-false deadline plus a dispatchClosed-true deadline keeps allFailed (same object)", async () => {
    const { idx, Deadline, cleanup } = await loadFreshIndex();
    try {
      // dispatchClosed false: a provider Retry-After refusal beyond an OPEN
      // window (round C0a item 2) — an ordinary rate-limit error, not a closed
      // dispatch. The open-window deadline alone must not make the file final.
      const open = new Deadline(TRAIL, new Error("API error 429 (openrouter): slow down"), undefined, false);
      const closed = dl(Deadline);
      const allFailed = new Error("all");
      expect(idx.pickEnsembleAllFailedError("p", [slot(open), slot(closed)], allFailed)).toBe(allFailed);
      expect(idx.pickEnsembleAllFailedError("p", [slot(closed), slot(open)], allFailed)).toBe(allFailed);
    } finally {
      cleanup();
    }
  });

  it("a dispatchClosed-false deadline alone keeps allFailed", async () => {
    const { idx, Deadline, cleanup } = await loadFreshIndex();
    try {
      const open = new Deadline(TRAIL, new Error("API error 429 (openrouter): slow down"), undefined, false);
      const allFailed = new Error("all");
      expect(idx.pickEnsembleAllFailedError("p", [slot(open)], allFailed)).toBe(allFailed);
    } finally {
      cleanup();
    }
  });
  it("classifyError names every closed window with its real cause, not just the first", async () => {
    const { idx, ProfileExhaustedError, Deadline, cleanup } = await loadFreshIndex();
    try {
      const a = new Deadline(TRAIL, new Error("API error 503 (openrouter): alpha overloaded"));
      const b = new Deadline(TRAIL, new Error("API error 500 (openrouter): beta exploded"));
      const v = idx.__classifyErrorForTests(new ProfileExhaustedError("p", "static", [a, b]));
      expect(v.reason).toContain("alpha overloaded");
      expect(v.reason).toContain("beta exploded");
    } finally {
      cleanup();
    }
  });
});
describe("F5: classifyError with a RetryDeadlineError", () => {
  it("a dynamic-profile exhaustion carrying one still aborts the batch (classified by its causes first)", async () => {
    const { idx, ProfileExhaustedError, Deadline, cleanup } = await loadFreshIndex();
    try {
      const dl = new Deadline(TRAIL, new Error("API error 500 (openrouter): overloaded"));
      const verdict = idx.__classifyErrorForTests(new ProfileExhaustedError("p", "dynamic", [dl]));
      expect(verdict).toMatchObject({ unrecoverable: true, serviceLevel: true });
    } finally {
      cleanup();
    }
  });

  it("a mixed chain of service-level causes plus one RetryDeadlineError is judged per file, and the file counts as a failed outcome", async () => {
    const { idx, ProfileExhaustedError, Deadline, cleanup } = await loadFreshIndex();
    try {
      const dl = new Deadline(TRAIL, new Error("API error 500 (openrouter): overloaded"));
      const mixed = idx.__classifyErrorForTests(
        new ProfileExhaustedError("p", "static", [new Error("API error 403 (openrouter): Access forbidden"), dl]),
      );
      expect(mixed).toMatchObject({ unrecoverable: true, serviceLevel: false, countsAsFailure: true });
      const direct = idx.__classifyErrorForTests(dl);
      expect(direct).toMatchObject({ unrecoverable: true, serviceLevel: false, countsAsFailure: true });
      // Every cause service-level: still aborts the batch, as before the clock.
      const all403 = idx.__classifyErrorForTests(
        new ProfileExhaustedError("p", "static", [new Error("API error 403 (openrouter): Access forbidden")]),
      );
      expect(all403).toMatchObject({ unrecoverable: true, serviceLevel: true });
      expect(all403).not.toHaveProperty("countsAsFailure");
    } finally {
      cleanup();
    }
  });
});
