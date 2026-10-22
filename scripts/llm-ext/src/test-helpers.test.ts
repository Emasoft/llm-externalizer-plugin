// Cost-safety guard (TRDD-e82f2c49). Pure, offline, free. Asserts the DEFAULT
// test backend can never bill OpenRouter — if a future change reverts
// resolveTestConfig() to the real/remote backend, THIS test fails (for free)
// instead of the user's balance.

import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { dirname } from "node:path";
import { resolveTestConfig, runCli } from "./test-helpers";

describe("test cost-safety guard (TRDD-e82f2c49)", () => {
  it("default resolveTestConfig() is a LOCAL, unreachable backend that never bills", () => {
    const cfg = resolveTestConfig({ testName: "guard" });
    // Not the user's real/live backend.
    expect(cfg.liveBackend).toBe(false);
    // Local mode → the server never contacts openrouter.ai.
    expect(cfg.resolved.mode).toBe("local");
    expect(cfg.resolved.url).not.toMatch(/openrouter/i);
    // A guaranteed-dead local address → calls fail fast, free.
    expect(cfg.resolved.url.startsWith("http://127.0.0.1")).toBe(true);
    // Not an ensemble (no second/third model fan-out).
    expect(cfg.resolved.secondModel).toBe("");
    expect(cfg.resolved.thirdModel).toBe("");
  });

  it("requireLiveBackend:true selects the real backend, never a silent local fallback", () => {
    // Reads the real settings.yaml (file read only — no network, no spend).
    let live;
    try {
      live = resolveTestConfig({ testName: "guard-live", requireLiveBackend: true });
    } catch {
      // No resolvable live backend in this environment (e.g. CI with no API
      // key) → resolveTestConfig THROWS. That is the fail-fast contract: the
      // critical cost-safety invariant is asserted by the first test (default =
      // local, never bills); what must NEVER happen is requireLiveBackend:true
      // silently degrading to the free synthetic local backend and masking a
      // misconfiguration. The throw proves it did NOT degrade.
      return;
    }
    // When a live backend IS configured, it must be flagged live AND must be the
    // real backend — not the synthetic 127.0.0.1 unreachable one.
    expect(live.liveBackend).toBe(true);
    expect(live.resolved.url).not.toMatch(/127\.0\.0\.1/);
  });
});

// COST-SAFETY (TRDD-e82f2c49): same LIVE_TESTS=1 + OPENROUTER_API_KEY opt-in as
// live.test.ts — this test makes REAL LLM calls specifically to prove runCli()'s
// output-dir concurrency fix, and must never fire from a plain `npx vitest run`.
const LIVE =
  process.env.LIVE_TESTS === "1" &&
  typeof process.env.OPENROUTER_API_KEY === "string" &&
  process.env.OPENROUTER_API_KEY.length > 0;

describe.skipIf(!LIVE)("runCli output-dir race (TRDD-90DM5YHO)", () => {
  it("two concurrent runCli calls sharing one testName both succeed and leave no output dir behind", async () => {
    // Before the fix, outputDir was `/tmp/__llm_ext_${testName}_output` — a FIXED
    // name shared by every call using this testName. vitest runs test FILES in
    // parallel worker processes, so two files (or, as here, two concurrent calls
    // in the same file) sharing a testName could have one call's `finally`
    // rmSync the shared dir while the other's spawned CLI was still writing its
    // report into it. mkdtempSync makes each call's outputDir unique, so this
    // can no longer race.
    const cfg = resolveTestConfig({
      testName: "racecfg",
      timeout: 120,
      requireLiveBackend: true,
    });
    const before = new Set(readdirSync("/tmp"));

    const [r1, r2] = await Promise.all([
      runCli(cfg, "chat", { instructions: "Reply with exactly one word: ONE" }),
      runCli(cfg, "chat", { instructions: "Reply with exactly one word: TWO" }),
    ]);

    // Neither call's report write was clobbered by the other's cleanup.
    expect(r1.isError).toBe(false);
    expect(r2.isError).toBe(false);
    expect(r1.content[0]?.text).toMatch(/\.md$/);
    expect(r2.content[0]?.text).toMatch(/\.md$/);

    // DETERMINISTIC signal, independent of the race's timing luck: before the
    // fix outputDir was `${testName}`-derived only, so two calls sharing a
    // testName always got the SAME dir — this fails on every run of the old
    // code, not just the runs where the race window was actually hit.
    expect(dirname(r1.content[0]!.text)).not.toBe(dirname(r2.content[0]!.text));

    // Both calls' outputDir + tmpConfigDir were removed by their own `finally` —
    // no leftover /tmp/__llm_ext_*_output* entry from this test.
    const after = readdirSync("/tmp");
    const leaked = after.filter((name) => !before.has(name) && /^__llm_ext_racecfg_output/.test(name));
    expect(leaked).toEqual([]);
  });
});
