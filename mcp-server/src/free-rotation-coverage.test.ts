/**
 * Guard: every place that can SEND an LLM request must be rotation-aware under
 * free mode.
 *
 * WHY THIS EXISTS. Rotation was originally wired into the ensemble slots only,
 * and four other send paths were quietly left pinned to a single free model —
 * `free: true`, auto-free, ensemble:false, and the two direct-HTTP tools. Nobody
 * noticed for months because every one of them "worked": they only fail on the
 * day the pinned model's daily quota runs out. A unit test of the rotation helper
 * cannot catch that class of bug — the helper was fine, it just wasn't CALLED.
 * So this test asserts the wiring, not the logic.
 *
 * It is deliberately a source-level assertion (the same shape as
 * no-codex-invocation.test.ts): the alternative — booting every tool against a
 * fake rate-limited backend — would be slow, and would still miss a send site
 * that no test happens to exercise.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(__dirname);
const read = (p: string) => readFileSync(join(SRC, p), "utf-8");

/** Every .ts file under src/, as a path relative to src/. */
function globSrc(dir: string = SRC): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...globSrc(full));
    else if (e.name.endsWith(".ts")) out.push(relative(SRC, full));
  }
  return out;
}

describe("free-model rotation coverage — every LLM send path can rotate", () => {
  it("EVERY production FetchImpl adapter is wrapped — there are two, not one", () => {
    // The first version of this guard checked only security_scan's adapter,
    // assuming mass_scout imported it. It does not: mass_scouting/cli.ts declares
    // its OWN realFetch, and all four of its send sites use that one. The guard
    // caught it on its first run — which is the entire argument for the guard.
    //
    // Any file that binds a `realFetch` MUST bind it through withFreeRotation.
    // If one is unwrapped, security_scan silently degrades a whole scan to
    // "uncertain" the next time a free model hits its daily cap (its circuit
    // breaker force-marks every remaining item after N consecutive failures), and
    // mass_scout simply burns its retry budget against a spent model, per file.
    for (const f of ["security_scan/openrouter.ts", "mass_scouting/cli.ts"]) {
      const src = read(f);
      expect(src, `${f} declares realFetch — it must be wrapped`).toMatch(
        /realFetch\s*(:\s*FetchImpl\s*)?=\s*withFreeRotation\s*\(/,
      );
      expect(src).toContain("withFreeRotation");
    }
  });

  it("no other file binds an unwrapped realFetch", () => {
    // A third adapter appearing somewhere else is the way this regresses.
    const files = globSrc().filter((f) => !f.endsWith(".test.ts"));
    const offenders: string[] = [];
    for (const f of files) {
      const src = read(f);
      // `const realFetch ... = async` (a raw adapter) rather than `= withFreeRotation(`
      if (/\brealFetch\b[^=\n]*=\s*async/.test(src)) offenders.push(f);
    }
    expect(
      offenders,
      "these files bind a RAW realFetch that bypasses free-model rotation — wrap it in withFreeRotation()",
    ).toEqual([]);
  });

  it("ensembleStreaming rotates on every one of its four branches", () => {
    const index = read("index.ts");
    // The four single-model exits + the ensemble slots. Each must consult the
    // pool or the slot-rotation wrapper; a bare chatCompletionWithRetry on a free
    // path is the exact bug this suite exists to prevent.
    expect(index).toContain("callSingleWithFreeRotation");
    expect(index).toContain("callEnsembleSlotWithRotation");
    expect(index).toContain("buildFreeRotationPool");
    // The predicate must be free_only OR auto-free. Keying off freeOnly alone was
    // the original defect: under auto-free the fallback list came out empty while
    // the boot log promised "rotation on rate-limit".
    expect(index).toMatch(
      /function isFreeModeActive\(\)[\s\S]{0,200}freeOnly[\s\S]{0,80}autoFreeEngaged/,
    );
  });

  it("check_imports' direct JSON completions rotate", () => {
    const index = read("index.ts");
    // Both extract calls must go through the rotating wrapper. A raw
    // chatCompletionJSON( ..., providerDeps) call in check_imports means a
    // daily-capped free model hard-fails the tool.
    expect(index).toContain("chatCompletionJSONWithFreeRotation");
    const rawJsonCalls = index.match(/await chatCompletionJSON\(/g) ?? [];
    expect(
      rawJsonCalls.length,
      "a non-rotating chatCompletionJSON call was added — wrap it in chatCompletionJSONWithFreeRotation",
    ).toBe(0);
  });

  it("cluster_synonyms' rawLlmCall rotates", () => {
    const index = read("index.ts");
    // Clustering is thousands of small calls — the surest way to meet a daily cap.
    expect(index).toMatch(/csPool[\s\S]{0,400}callSingleWithFreeRotation/);
  });

  it("the auto-reconcile pre-flight is wired at BOTH runtime funnels (MCP + CLI)", () => {
    // Same class of bug as the rotation-wiring guard: the reconcile helper being
    // correct is worthless if a funnel never calls it. Skills / slash-commands /
    // agents all wrap one of these two entry points, so these two calls are what
    // make "always assess first" hold for every surface.
    const index = read("index.ts");
    expect(index, "MCP dispatch must run reconcile before work tools").toMatch(
      /RECONCILE_SKIP_TOOLS[\s\S]{0,400}runModelReconcile\(\)/,
    );
    expect(index).toContain("reconcileModelsBeforeWork");

    const cli = read("cli.ts");
    expect(cli, "the CLI main must run reconcile before work commands").toContain(
      "reconcileModelsBeforeWork(makeCliReconcileDeps())",
    );
  });

  it("the ':free' suffix rule has exactly ONE definition", () => {
    // isFreeSuffixModelId IS what the cost-safety chokepoint admits. A second
    // inline `.endsWith(":free")` in the rotation path is how a $0-but-not-':free'
    // router pseudo-model (openrouter/free) slipped into a pool and detonated a
    // 32-minute sweep at send time.
    const rotation = read("free-rotation.ts");
    expect(rotation).toContain("isFreeSuffixModelId");
    expect(rotation).not.toMatch(/endsWith\(["']:free["']\)/);
  });
});
