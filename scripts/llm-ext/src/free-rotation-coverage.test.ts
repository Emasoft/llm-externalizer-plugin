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

/** Drop every comment LINE (a `//` line, a ` * ...` continuation line inside
 *  a block comment, or a block-comment opener line) before a guard checks
 *  for a deleted name — fix-queue 98(4b): the four guards below used to
 *  strip only `//` lines, so a name mentioned in a multi-line doc comment
 *  (this project's own "why this was deleted" convention) could still read
 *  as live code. One shared filter so the four call sites cannot drift
 *  apart on which comment shapes they recognise. */
function stripComments(src: string): string {
  return src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

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
    // The predicate must be free_only OR the master switch. TRDD-OE27RD7I
    // addendum 4 deleted the third arm this used to OR in (sticky auto-free
    // on a low balance / prior 402) -- keying off freeOnly alone was the
    // original defect this guard exists to catch either way.
    expect(index).toMatch(
      /function isFreeModeActive\(\)[\s\S]{0,200}freeOnly[\s\S]{0,80}forceFreeByMasterSwitch/,
    );
    expect(index).not.toContain("autoFreeEngaged");
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

  it("the one-time profile migration runs at BOOT, strictly before the dispatch pre-flight (P6c-a item 3, amendment 3)", () => {
    // ORDER IS THE WHOLE POINT. The migration ADOPTS an unmarked section that
    // is provably one of ours by stamping the generated marker on it. If the
    // maintainer ran first it would see that same section WITHOUT the marker,
    // conclude it was hand-authored, and back the entire settings.yaml up —
    // announcing "your previous version was saved" about a file the user never
    // touched. Both calls are correct in isolation; only their order is not.
    const index = read("index.ts");
    const migrateAt = index.indexOf("migrateProfileSections(getSettingsPath()");
    const preflightAt = index.indexOf("// P6b dynamic-profile pre-flight BEGIN");
    expect(migrateAt, "index.ts must call migrateProfileSections at boot").toBeGreaterThan(-1);
    expect(preflightAt).toBeGreaterThan(-1);
    expect(
      migrateAt,
      "the migration must run BEFORE the dispatch pre-flight that maintains free/paid",
    ).toBeLessThan(preflightAt);
    // And inside the settings-loading IIFE, not merely earlier in the file:
    // ensureSettingsExist() is what created/repaired the document it migrates.
    const ensureAt = index.indexOf("ensureSettingsExist()");
    expect(ensureAt).toBeGreaterThan(-1);
    expect(ensureAt).toBeLessThan(migrateAt);
  });

  it("the dynamic-profile maintainer AND the legacy auto-reconcile pre-flight are wired at the ONE shared dispatcher (P6b item 1, addendum F)", () => {
    // Same class of bug as the rotation-wiring guard: the reconcile/maintainer
    // helper being correct is worthless if a funnel never calls it. Skills /
    // slash-commands / agents all wrap the CLI, which routes every tool call
    // through dispatchCallTool — so this one call is what makes "always assess
    // first" hold for every surface.
    //
    // P6b rewired this block: a DYNAMIC effective profile ('free'/'paid') goes
    // through maintainDynamicProfiles + dynamicProfileGate; a STATIC one gets
    // runModelReconcile()'s dead-id WARNING and nothing else (P6c-a retired the
    // lazy-population half, so the dynamic arm is the only writer).
    // This replaces the old single-regex assertion (which matched
    // `runModelReconcile()` immediately after the skip-list check) — that
    // shape no longer exists on purpose; asserting it would re-forbid the very
    // rewiring this test is supposed to confirm happened.
    const index = read("index.ts");

    // P6b-fix2 S-8: the block is delimited by two unique anchors in index.ts
    // instead of measured in characters. Every `[\s\S]{0,N}` window here was a
    // silent countdown — one of them had 25 characters of headroom, so the next
    // comment line added to the dispatch pre-flight would have reddened it for
    // a reason with nothing to do with the wiring. Extract the block once,
    // assert ORDER inside it with indexOf, and adding prose to it is free.
    const BEGIN = "// P6b dynamic-profile pre-flight BEGIN";
    const END = "// P6b dynamic-profile pre-flight END";
    const from = index.indexOf(BEGIN);
    const to = index.indexOf(END);
    expect(from, `index.ts must carry the '${BEGIN}' anchor`).toBeGreaterThan(-1);
    expect(to, `index.ts must carry the '${END}' anchor`).toBeGreaterThan(from);
    const preflight = index.slice(from, to);

    /** Position of `needle` inside the pre-flight block; -1 when absent. */
    const at = (needle: string): number => preflight.indexOf(needle);
    const ordered = (...needles: string[]): void => {
      let prev = -1;
      for (const n of needles) {
        const i = at(n);
        expect(i, `${n} must appear in the dispatch pre-flight block`).toBeGreaterThan(-1);
        expect(i, `${n} must come after the step before it`).toBeGreaterThan(prev);
        prev = i;
      }
    };

    expect(
      at("RECONCILE_SKIP_TOOLS.has(name)"),
      "dispatch must gate on RECONCILE_SKIP_TOOLS before EITHER path",
    ).toBeGreaterThan(-1);
    expect(at("isDynamicProfileName(effective)")).toBeGreaterThan(at("RECONCILE_SKIP_TOOLS.has(name)"));

    // C2b-wire (TRDD-OE27RD7I): the dynamic arm's own maintainer call moved
    // OFF this dispatch site onto a detached detector — every tool call on a
    // dynamic profile used to pay for a full in-process catalog fetch+patch,
    // which is what card C's 100ms `settings status` latency acceptance
    // forbids. Nothing here writes settings.yaml synchronously anymore, so
    // there is no reload to order before the gate either — asserting the old
    // "maintain -> reload-if-written -> gate" order would re-forbid the very
    // rewiring this test is supposed to confirm happened.
    // D2: the detector is SCHEDULED in this block (before the gate, inside the
    // dynamic arm) and SPAWNED in dispatchCallToolInner's `finally`, after the
    // work. Spawned here, it held the profile's one lock while this same
    // command's models failed, so the update the failure requests found the
    // lock held and started nothing (proven by empty-pool-wait.test.ts /
    // profile-chain-402.test.ts's "exactly one update-requested child").
    ordered("detectAfterDispatch = effective;", "dynamicProfileGate(");

    // C2b-wire acceptance (spec's "spawns exactly one detector for a dynamic
    // profile and none for a static one or a RECONCILE_SKIP_TOOLS tool"):
    // exactly one call site in the whole file; the ONLY thing that arms it is
    // the assignment strictly inside the `isDynamicProfileName(effective)`
    // branch of THIS block (already proven gated on
    // `!RECONCILE_SKIP_TOOLS.has(name)` by the outer `if` this whole
    // `preflight` slice is extracted from) — never the STATIC `else` arm below,
    // which only ever runs runModelReconcile().
    const spawnCalls = (index.match(/spawnDetachedDetector\(/g) ?? []).length;
    expect(spawnCalls, "spawnDetachedDetector( must appear exactly once in index.ts").toBe(1);
    const arms = (index.match(/detectAfterDispatch = /g) ?? []).length;
    expect(arms, "the detector must be armed at exactly one site").toBe(1);
    const staticArmAt = preflight.indexOf("} else {");
    expect(staticArmAt, "the static-profile else arm must exist in this block").toBeGreaterThan(-1);
    expect(
      at("detectAfterDispatch = effective;"),
      "the detector must be armed before the static-profile else arm, never inside it",
    ).toBeLessThan(staticArmAt);
    // ...and spawned only AFTER the work: in the finally that follows the
    // whole dispatch, past this block's END anchor.
    const spawnAt = index.indexOf("spawnDetachedDetector({ profile: detectAfterDispatch");
    expect(spawnAt, "the detector must be spawned from the armed profile").toBeGreaterThan(to);
    expect(index.lastIndexOf("} finally {", spawnAt)).toBeGreaterThan(to);

    // P6b-fix S7: this asserted `runModelReconcile\(\)`, which the function
    // DECLARATION (`async function runModelReconcile(): Promise<void>`) also
    // satisfies, so deleting the actual CALL left the test green. Scoping to
    // the block kills that class of false match outright — the declaration is
    // nowhere near it — and the trailing `;` still pins a CALL, not a mention.
    expect(
      at("await runModelReconcile();"),
      "a STATIC effective profile must still get the reconcile dead-id warning",
    ).toBeGreaterThan(-1);
    expect(index).toContain("reconcileModelsBeforeWork");

    // P6b-fix B2: the legacy arm's own name must come from the IN-MEMORY
    // effective profile, never from a fresh loadSettings() of the disk
    // `active:` key — that mismatch is what routed `--profile <static>` runs
    // into a lockless write of the generated `profiles.free` section and
    // pinned isStatic to false for every static profile.
    expect(index, "the legacy reconcile deps must key on the in-memory effective name").toMatch(
      /const sActiveName = effectiveProfileName\(activeSettings\);/,
    );
    expect(index, "isStatic must derive from that same name").toMatch(
      /isStatic: !isDynamicProfileName\(sActiveName\)/,
    );
    // P6b-fix2 S-8: the last char-count window in this test, replaced by an
    // ordering assertion over two strings that each occur once.
    const nameAt = index.indexOf("const reconcileProfileName = effectiveProfileName(activeSettings);");
    const refusalAt = index.indexOf("if (isDynamicProfileName(reconcileProfileName))");
    expect(nameAt, "the legacy free-pool writer must resolve its name from the in-memory profile").toBeGreaterThan(-1);
    expect(refusalAt, "the legacy free-pool writer must refuse a dynamic profile name").toBeGreaterThan(nameAt);

    // The CLI inherits the reconcile pre-flight because it dispatches every
    // command through dispatchCallTool (asserted just above) — there is now
    // ONE funnel, not two (the standalone MCP server was removed).
    const cliMain = read("cli/main.ts");
    expect(cliMain, "the CLI main must dispatch through the shared dispatcher").toContain(
      "dispatchCallTool",
    );
  });

  it("credit exhaustion (402) NEVER borrows the free pool — the completion path stays inside its own profile (TRDD-OE27RD7I addendum 4)", () => {
    // USER, no exceptions: "no switching to free models ... must exist anymore".
    // The paid->free rotation body and the engage-then-retry-on-free
    // machinery it needed were deleted outright from
    // provider/completion.ts — a 402 now falls straight into the generic
    // deterministic-4xx classification and is thrown honestly, same as any
    // other terminal 4xx. This test used to assert the OPPOSITE (that the
    // borrow existed and completed the call); it now asserts the borrow is
    // genuinely gone, not just renamed or relocated.
    const completion = read("provider/completion.ts");
    // Positive anchor: a wrong path or an empty read would make every
    // `.not.toContain()` below pass vacuously. Pin the read to the real file
    // by requiring content only completion.ts has, plus a length floor.
    expect(completion).toContain("chatCompletionWithRetry");
    expect(completion.length).toBeGreaterThan(1000);
    // Strip //-comment lines first: the deleted names are still MENTIONED in
    // explanatory comments documenting the deletion (see this same file's
    // "circuit breaker" test below for the identical pattern) — the guard
    // must check the LIVE code contains none of them, not the prose about it.
    const completionCode = stripComments(completion);
    expect(completionCode).not.toContain("completeOnFreePool(");
    expect(completionCode).not.toContain("onCreditExhausted(");
    expect(completionCode).not.toContain("engageFreeAfterCreditExhaustion");
    expect(completionCode).not.toContain("autoFreeEngageHook");
  });

  it("the circuit breaker is TRANSPORT-only and half-opens after aborting (2026-08-04 livelock guards)", () => {
    const completion = read("provider/completion.ts");
    // 1. The empty/glitch response path must NOT feed the GLOBAL breaker: an
    //    HTTP 200 with an empty or all-reasoning body is a MODEL-shape failure
    //    with its own retry ladder. Counting them let a parallel scan over
    //    reasoning-heavy free models trip a provider-wide "SERVER ISSUE"
    //    verdict while a live probe showed the provider healthy. Exactly ONE
    //    recordServiceFailure() call site may remain: the thrown-request
    //    (network/timeout/non-2xx) branch.
    //    Strip //-comment lines first (the guard notes in completion.ts
    //    mention the function by name), then count EVERY textual occurrence —
    //    definition + call sites, however nested or guarded. The old per-line
    //    anchor (/^\s*recordServiceFailure\(\);/m) only saw calls standing
    //    alone on a line, so a reintroduced `if (x) recordServiceFailure();`
    //    was invisible to the exact test built to block it (ultracode F13).
    //    2 = the function definition + the ONE transport-error call site.
    const codeOnly = stripComments(completion);
    const failureRefs = codeOnly.match(/\brecordServiceFailure\(\)/g) ?? [];
    expect(
      failureRefs.length,
      "recordServiceFailure() must appear exactly twice: its definition + the single transport-error call site",
    ).toBe(2);
    // 2. The exhausted-backoff abort must HALF-OPEN the breaker before
    //    returning. The only other reset is recordServiceSuccess(), which needs
    //    a completed request — and a tripped breaker aborts every call BEFORE
    //    any request, so without this reset the tripped state was permanent and
    //    the rotation layer livelocked on a pool of instant aborts.
    expect(completion).toMatch(
      /SERVER ISSUE DETECTED[\s\S]{0,900}consecutiveFailures = 0;[\s\S]{0,200}backoffAttempt = 0;[\s\S]{0,400}return message;/,
    );
    // 3. The rotation layer must refuse to classify the breaker's GLOBAL
    //    verdict as per-model unavailability (its text contains "overloaded",
    //    which the transient branch would otherwise match).
    const rotation = read("free-rotation.ts");
    expect(rotation).toMatch(/server issue detected[\s\S]{0,400}return null;/);
  });

  it("the direct-HTTP tools' fetch decorator has NO paid→free credit switch wired (TRDD-OE27RD7I addendum 4)", () => {
    // withFreeRotation's PAID-mode branch used to engage session-wide free mode
    // on a 402 and rotate the call onto the free pool — the direct-HTTP-tools
    // twin of the completion.ts borrow above. That branch was deleted; PAID
    // mode now always sends the request as-is, including a 402. This test used
    // to assert the hook WAS registered/wired; it now asserts the opposite —
    // none of the deleted machinery's names remain as live source.
    const rotation = read("free-rotation.ts");
    // Positive anchor: a wrong path or an empty read would make every
    // `.not.toContain()` below pass vacuously. Pin the read to the real file
    // by requiring content only free-rotation.ts has, plus a length floor.
    expect(rotation).toContain("withFreeRotation");
    expect(rotation.length).toBeGreaterThan(1000);
    // Same comment-stripping rationale as the completion.ts guard above: the
    // deletion is documented in a comment naming the dead function, which is
    // not itself a regression — only a live (non-comment) reference is.
    const rotationCode = stripComments(rotation);
    expect(rotationCode).not.toContain("completeOnFreePool(");
    expect(rotationCode).not.toContain("onCreditExhausted(");
    expect(rotationCode).not.toContain("engageFreeAfterCreditExhaustion");
    expect(rotationCode).not.toContain("autoFreeEngageHook");
  });

  it("no low-balance auto-free threshold exists anymore (TRDD-OE27RD7I addendum 4) — the paid credit is used down to $0, and a 402 is honest, never a switch", () => {
    const index = read("index.ts");
    expect(index).toContain("chatCompletionWithProfileFallback"); // positive anchor
    expect(index.length).toBeGreaterThan(1000);
    const indexCode = stripComments(index);
    // parseFreeBelowUsd/MIN_BALANCE_FOR_PAID_USD were the proactive
    // early-switch threshold and its dollar-value env override — deleted
    // outright, no opt-out. The guaranteed (and now ONLY) 402 behaviour is
    // the honest classifyError failure, never a switch.
    expect(indexCode).not.toContain("parseFreeBelowUsd");
    expect(indexCode).not.toContain("MIN_BALANCE_FOR_PAID_USD");
    expect(indexCode).not.toContain("LLM_EXT_FREE_BELOW_USD");
  });

  it("stripComments also drops block-comment lines (' * ...', '/*...'), not just '//' (fix-queue 98(4b))", () => {
    // Before this fix, a name mentioned only inside a `/** ... */` doc
    // comment (this project's own "why this was deleted" convention) still
    // read as live code to every guard above, because the shared filter
    // only recognised a `//` line comment.
    // dogfood sweep · promise-vs-code: these are fixture STRINGS feeding
    // stripComments' own unit test, not live calls — the trailing markers below
    // are the harness's documented escape hatch (same-line comment, in a test
    // file, hit inside a string literal).
    const src = [
      "const kept = 1;",
      "// dropped: completeOnFreePool(", // absence-assert
      "/* dropped: onCreditExhausted( */", // absence-assert
      " * dropped: engageFreeAfterCreditExhaustion",
      "const alsoKept = 2;",
    ].join("\n");
    const filtered = stripComments(src);
    expect(filtered).toContain("kept = 1");
    expect(filtered).toContain("alsoKept = 2");
    expect(filtered).not.toContain("completeOnFreePool(");
    expect(filtered).not.toContain("onCreditExhausted(");
    expect(filtered).not.toContain("engageFreeAfterCreditExhaustion");
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
