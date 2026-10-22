// row99 fix-queue: main()'s settings/active-profile resolution used to catch
// any failure and silently run the sweep anyway ("best-effort on bad
// settings" — a fallback CLAUDE.md's fail-fast rule forbids). It must now
// FAIL FAST for every phase that reads the resolved free_only/free
// pool/target profile, and keep working for the handful of phases that
// genuinely never read them (settingsIndependentPhase in index.ts).
//
// These spawn the bundle built HERE, from the CURRENT source, with esbuild —
// exactly pick-lock.test.ts's pattern (dist/benchmark.js may be stale; this
// suite must never regenerate it, and must never assert against a build that
// predates the change under test). Hermetic: every case fails, or returns,
// strictly before any network call — see the comment on each case for why
// the code path in index.ts's main() cannot reach a fetch.

import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "../test-tmp-root.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBenchmarkTestBundle, cleanupTestBundle, type TestBundle } from "./test-bundle.js";

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";

const BENCHMARK_DIR = dirname(fileURLToPath(import.meta.url));

let bundle: TestBundle;
let benchJs = "";

beforeAll(async () => {
  // entryPoints (not stdin): src/benchmark/index.ts self-executes main() when
  // it IS the process entry point (see its `import.meta.url === …argv[1]`
  // guard at the bottom of the file) — the same property dist/benchmark.js
  // relies on, so bundling the real file reproduces that behavior exactly.
  bundle = await buildBenchmarkTestBundle(BENCHMARK_DIR, "row99-bundle-");
  benchJs = bundle.benchJs;
});

afterAll(() => {
  cleanupTestBundle(bundle);
});

describe("main() fails fast on an unresolvable settings/active-profile (row99)", () => {
  let cfg = "";
  let root = "";

  beforeEach(() => {
    cfg = realpathSync(mkdtempSync(join(tmpdir(), "row99-cfg-")));
    root = realpathSync(mkdtempSync(join(tmpdir(), "row99-root-")));
  });
  afterEach(() => {
    rmSync(cfg, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  function run(args: string[], extraEnv: Record<string, string | undefined> = {}) {
    const env: Record<string, string | undefined> = {
      ...process.env,
      LLM_EXT_CONFIG_DIR: cfg,
      CLAUDE_PROJECT_DIR: root,
      ...extraEnv,
    };
    const r = spawnSync(process.execPath, [benchJs, ...args], { encoding: "utf-8", env });
    const finals = (r.stdout ?? "").split("\n").filter((l) => /^\[(OK|FAILED)\] /.test(l));
    return { ...r, finals, final: finals[0] ?? "" };
  }

  // (a) settings.yaml exists but is not valid YAML => loadSettings() returns
  // null (config.ts's own try/catch never throws past it) => main()'s `!s`
  // branch. A plain default sweep needs the resolved profile (freeOnly is
  // passed straight into runKeywordSweep — see index.ts main()), so this MUST
  // be refused before runKeywordSweep's OpenRouter catalog fetch, which is the
  // very next thing main() would otherwise reach. Never a network call: the
  // refusal `return` happens textually before that fetch is even referenced.
  it("(a) unreadable/invalid settings.yaml refuses the default sweep with the named cause, no network call", () => {
    writeFileSync(join(cfg, "settings.yaml"), ": : : not valid yaml : : :\n\tbad-indent", "utf-8");
    const r = run([], { OPENROUTER_API_KEY: "sk-test-literal-unused" });
    expect(r.status).not.toBe(0);
    expect(r.finals).toHaveLength(1);
    expect(r.final).toMatch(/^\[FAILED\] settings\.yaml unreadable or invalid at /);
    expect(r.final).toContain(join(cfg, "settings.yaml"));
    expect(r.final).toMatch(/no cost-mode fallback/);
  });

  // (b) settings.yaml parses fine but has no `free` profile configured (the
  // default target with no --profile) => main()'s `s && !active` branch.
  // Same reasoning: refused before the sweep's catalog fetch, so no network.
  it("(b) missing/unresolvable active profile refuses the default sweep with the named cause, no network call", () => {
    writeFileSync(join(cfg, "settings.yaml"), "profiles:\n  other:\n    mode: remote\n    api: openrouter-remote\n    model: v/x\n", "utf-8");
    const r = run([], { OPENROUTER_API_KEY: "sk-test-literal-unused" });
    expect(r.status).not.toBe(0);
    expect(r.finals).toHaveLength(1);
    expect(r.final).toMatch(/^\[FAILED\] active profile 'free' is not configured in /);
    expect(r.final).toContain(join(cfg, "settings.yaml"));
    expect(r.final).toMatch(/no cost-mode fallback/);
  });

  // (c) a settings-independent phase (a sub-task --dry-run, per
  // settingsIndependentPhase's doc comment in index.ts): the SAME broken
  // settings.yaml as (a) must NOT block it — the sub-task dry-run branch
  // returns "[dry-run] … no API calls made, $0 spent" before main() ever
  // calls loadSettings()'s result for anything, and needsApiKey(opts) is
  // false for --dry-run so no key is required either.
  //
  // row99 fix-queue item 4 NIT: this is a CONFIRMATORY pin, not a red proof
  // — --dry-run has always short-circuited before any settings read (P1's
  // dry-run chokepoint predates row99), so this case was already green on
  // HEAD before this fix-queue's changes and stays green after; only (a),
  // (b) and (d) are red-before/green-after proofs of the fail-fast behavior.
  it("(c) a settings-independent phase (--code-task --dry-run) still works with the same broken settings.yaml", () => {
    writeFileSync(join(cfg, "settings.yaml"), ": : : not valid yaml : : :\n\tbad-indent", "utf-8");
    const r = run(["--code-task", "--dry-run"]);
    expect(r.status).toBe(0);
    expect(r.finals).toHaveLength(1);
    expect(r.final).toMatch(/^\[OK\] dry run — code-task plan printed, no API calls made, \$0 spent$/);
  });

  // (d) row99 fix-queue item 1: `active:` is the live default-profile
  // pointer again (5502ca5/c1646e6, TRDD-G6XT3AY9) and benchmarkTargetProfile
  // must resolve it exactly like cli/main.ts's effectiveProfileName() does —
  // `--profile` when given, else `active:`, else the built-in default. Red
  // on HEAD: benchmarkTargetProfile(explicit) there is `explicit ||
  // DEFAULT_PROFILE_NAME`, unconditionally "free" with no --profile, so
  // --update-all's generated-target refusal would name 'free' (settings.yaml
  // never even defines a `free` profile here) instead of the `active: paid`
  // this fixture names. No network: the refusal is a usage-error-level check
  // (refuseGeneratedProfileTarget, called from main()'s generatedRefusal
  // computation) that fires before preflight/the catalog fetch.
  it("(d) with no --profile, --update-all's generated-target check resolves `active:` in settings.yaml, not the built-in default", () => {
    writeFileSync(
      join(cfg, "settings.yaml"),
      "active: paid\nprofiles:\n  paid:\n    mode: remote\n    api: openrouter-remote\n    model: v/x\n",
      "utf-8",
    );
    const r = run(["--update-all"], { OPENROUTER_API_KEY: "sk-test-literal-unused" });
    expect(r.status).not.toBe(0);
    expect(r.finals).toHaveLength(1);
    expect(r.final).toMatch(/^\[FAILED\] --update-all refused: 'paid' is a GENERATED dynamic profile/);
  });

  // (e) review-followup (row99 item 3): dryRunWouldMaskRefusal had NO test
  // proving it actually fires -- the reviewer's strongest finding on this
  // change. --code-task's real (non-dry-run) run DOES read freeOnly (unlike
  // (c)'s dry-run-is-exempt-either-way case), so a broken settings.yaml here
  // must make the dry-run say so, not print a clean [OK] with nothing else.
  // Same broken-settings fixture as (b) (missing `free` profile) so this is
  // the settingsIndependentPhase "not configured" branch -- row99 fix-queue
  // item 4 NIT: the old comment pointed at "the sibling assertion below for
  // the other branch" (the resolve-error branch), but no such sibling test
  // exists in this file; corrected rather than left dangling.
  it("(e) --code-task --dry-run on a broken settings.yaml warns the real run would refuse, but still exits 0", () => {
    writeFileSync(join(cfg, "settings.yaml"), "profiles:\n  other:\n    mode: remote\n    api: openrouter-remote\n    model: v/x\n", "utf-8");
    const r = run(["--code-task", "--dry-run"]);
    expect(r.status).toBe(0);
    expect(r.finals).toHaveLength(1);
    expect(r.final).toMatch(/^\[OK\] dry run — code-task plan printed, no API calls made, \$0 spent$/);
    expect(r.stdout).toContain("the real run would refuse: active profile 'free' is not configured in");
  });

  // (f) row99 fix-queue item 2 (S2): getConfigDir()'s M8 path-traversal guard
  // throws for a LLM_EXT_CONFIG_DIR outside both home and /tmp, BEFORE main()
  // ever reads settings.yaml or reaches a fetch -- this is the second `try`
  // (settingsPath/costGateProfile), the one S1's comment calls out as running
  // for EVERY phase. No --profile/--update-all/etc needed: a bare invocation
  // already calls getSettingsPath() -> getConfigDir() unconditionally.
  it("(f) LLM_EXT_CONFIG_DIR outside home/tmp refuses with one settings/config-could-not-be-resolved line, exit 2, no network call", () => {
    const r = run([], {
      OPENROUTER_API_KEY: "sk-test-literal-unused",
      LLM_EXT_CONFIG_DIR: "/var/row99-outside-home-and-tmp-config-dir",
    });
    expect(r.status).toBe(2);
    expect(r.finals).toHaveLength(1);
    expect(r.final).toMatch(/^\[FAILED\] settings\/config could not be resolved: /);
    expect(r.final).toContain("fix LLM_EXT_CONFIG_DIR");
    expect(r.final).not.toMatch(/--check-health|--assess-model/);
  });

  // (g)-(i) row99c SF1/SF2/SF3: on unreadable settings.yaml, every WRITE phase
  // (--update-all, --auto-replace --apply, --adopt) must refuse with the SAME
  // settings-unreadable cause main() already uses for the plain sweep — never
  // "GENERATED dynamic profile" (that check trivially passes a null target)
  // and never a network call. No OPENROUTER_API_KEY on any of these: a fetch
  // reaching OpenRouter would need one (--update-all/--auto-replace) or, for
  // --adopt (whose public catalog fetch needs no key at all), the absence of
  // any catalog-fetch marker in stdout proves assessModelById was never
  // reached. Red on 48ac0c9 for (g) and (i): (g) named 'free' via
  // benchmarkTargetProfile's DEFAULT_PROFILE_NAME fallback instead of the
  // real cause; (i) ran straight through to assessModelById's real OpenRouter
  // catalog fetch (proven manually against a git-archive of 48ac0c9 outside
  // this suite — see the r99c report). (h) was already correct on 48ac0c9
  // (it hits the same-function settings-independent-phase check further
  // down), kept here as a regression pin now that (g)/(i) share its path.
  const UNREADABLE = ": : : not valid yaml : : :\n\tbad-indent";

  it("(g) unreadable settings.yaml refuses --update-all with the settings-unreadable cause, no GENERATED wording, no network call", () => {
    writeFileSync(join(cfg, "settings.yaml"), UNREADABLE, "utf-8");
    const r = run(["--update-all"]);
    expect(r.status).toBe(2);
    expect(r.finals).toHaveLength(1);
    expect(r.final).toMatch(/^\[FAILED\] settings\.yaml unreadable or invalid at /);
    expect(r.final).toContain(join(cfg, "settings.yaml"));
    expect(r.final).not.toMatch(/GENERATED/);
    expect(r.stdout).not.toMatch(/not configured/);
  });

  it("(h) unreadable settings.yaml refuses --auto-replace --apply with the settings-unreadable cause, no GENERATED wording, no network call", () => {
    writeFileSync(join(cfg, "settings.yaml"), UNREADABLE, "utf-8");
    const r = run(["--auto-replace", "--apply"]);
    expect(r.status).toBe(2);
    expect(r.finals).toHaveLength(1);
    expect(r.final).toMatch(/^\[FAILED\] settings\.yaml unreadable or invalid at /);
    expect(r.final).toContain(join(cfg, "settings.yaml"));
    expect(r.final).not.toMatch(/GENERATED/);
  });

  it("(i) unreadable settings.yaml refuses --adopt with the settings-unreadable cause, before assessModelById's catalog fetch", () => {
    writeFileSync(join(cfg, "settings.yaml"), UNREADABLE, "utf-8");
    const r = run(["--adopt", "some/model", "--adopt-into", "model"]);
    expect(r.status).toBe(2);
    expect(r.finals).toHaveLength(1);
    expect(r.final).toMatch(/^\[FAILED\] settings\.yaml unreadable or invalid at /);
    expect(r.final).toContain(join(cfg, "settings.yaml"));
    expect(r.final).not.toMatch(/GENERATED/);
    // No network-dependent output: assessModelById's progress line and its
    // catalog-lookup error text never appear when the refusal fires first.
    expect(r.stdout).not.toContain("[adopt] assessing");
    expect(`${r.stdout}${r.stderr}`).not.toContain("OpenRouter catalog");
  });

  // (i2)-(i3) review of 43e3694 (S1): an EXPLICIT --profile/--adopt-profile
  // resolves without ever calling loadSettings() (benchmarkTargetProfileOrNull
  // returns the explicit name immediately), so the old "is the resolved
  // TARGET null" check never fired for these — the write phase fell through
  // to a real settings read further down (--update-all) or, worse, straight
  // to assessModelById's catalog fetch (--adopt), which then threw
  // uncaught instead of a clean [FAILED] refusal. Red on 43e3694: (i2)
  // reached "[adopt] assessing" before failing; (i3) fell through the
  // generated-target check entirely because updateAllTarget was 'mystatic',
  // not null.
  it("(i2) unreadable settings.yaml refuses --adopt with an explicit --adopt-profile, before assessModelById's catalog fetch", () => {
    writeFileSync(join(cfg, "settings.yaml"), UNREADABLE, "utf-8");
    const r = run(["--adopt", "x", "--adopt-into", "model", "--adopt-profile", "mystatic"]);
    expect(r.status).toBe(2);
    expect(r.finals).toHaveLength(1);
    expect(r.final).toMatch(/^\[FAILED\] settings\.yaml unreadable or invalid at /);
    expect(r.final).toContain(join(cfg, "settings.yaml"));
    expect(r.stdout).not.toContain("[adopt] assessing");
    expect(`${r.stdout}${r.stderr}`).not.toContain("OpenRouter catalog");
  });

  it("(i3) unreadable settings.yaml refuses --update-all with an explicit --profile, no network call", () => {
    writeFileSync(join(cfg, "settings.yaml"), UNREADABLE, "utf-8");
    const r = run(["--update-all", "--profile", "mystatic"]);
    expect(r.status).toBe(2);
    expect(r.finals).toHaveLength(1);
    expect(r.final).toMatch(/^\[FAILED\] settings\.yaml unreadable or invalid at /);
    expect(r.final).toContain(join(cfg, "settings.yaml"));
    // review-of-review: the test's own name claims "no network call" — prove
    // it by checking runUpdateAllPhase's onProgress marker never appears,
    // not just by the exit code/message shape (adversarial review of this
    // worker's own diff flagged the earlier version as asserting only half
    // of what its name promised).
    expect(`${r.stdout}${r.stderr}`).not.toContain("[update-all]");
  });

  // (j) --update-all is a settingsIndependentPhase, so dryRunWouldMaskRefusal
  // never fires for it (main() never gets far enough to print an [OK] with
  // a "the real run would refuse" warning) — this is the negative twin of
  // case (e), pinning that a broken settings.yaml under --update-all
  // --dry-run refuses outright instead of printing a masked-OK.
  it("(j) --update-all --dry-run on unreadable settings.yaml refuses outright, never prints 'the real run would refuse'", () => {
    writeFileSync(join(cfg, "settings.yaml"), UNREADABLE, "utf-8");
    const r = run(["--update-all", "--dry-run"]);
    expect(r.status).toBe(2);
    expect(r.finals).toHaveLength(1);
    expect(r.final).toMatch(/^\[FAILED\] settings\.yaml unreadable or invalid at /);
    expect(r.stdout).not.toContain("the real run would refuse");
  });
});

// review of 43e3694 (S3): the (j) case above (now just a regression pin for
// the outright refusal) used to be the ONLY coverage claimed for
// dryRunWouldMaskRefusal's false branch, but it is VACUOUS for that purpose:
// --update-all is caught by the settings-unreadable guard in main()'s try
// block BEFORE dryRunWouldMaskRefusal is ever consulted, so the assertion
// holds no matter what that function returns. The function is also
// unreachable through ANY CLI spawn for the phases that are genuinely
// EXEMPT for a reason other than dry-run (--check-health, --new-arrivals,
// --assess-model, --from-cache): none of them are gated on opts.dryRun
// anywhere in main(), so no argv combination ever calls the function with
// one of those flags set. The only way to prove the false branch is a
// direct call with real parsed opts — dryRunWouldMaskRefusal is exported
// from index.ts for exactly this.
describe("dryRunWouldMaskRefusal false branch (review of 43e3694, S3)", () => {
  it("an EXEMPT, NON-write command (--check-health) with --dry-run set does not mask a settings failure", async () => {
    const { dryRunWouldMaskRefusal } = await import("./index.js");
    const { parseArgs } = await import("./cli-args.js");
    const opts = parseArgs(["node", "bench", "--check-health", "--dry-run"]);
    expect(opts.dryRun).toBe(true);
    expect(opts.checkHealth).toBe(true);
    // Mutation-check (verified locally while authoring this test, not
    // shipped): forcing the implementation to
    // `return opts.dryRun && settingsFailureCause !== null;` (dropping the
    // settingsIndependentPhase re-check) turns this assertion red — proof
    // the test actually depends on the exemption, not just on cause being set.
    expect(dryRunWouldMaskRefusal(opts, "settings.yaml unreadable or invalid at /tmp/x")).toBe(false);
  });

  it("the SAME cause on a command with no other exemption (a bare sweep, only --dry-run) WOULD mask a real refusal", async () => {
    const { dryRunWouldMaskRefusal } = await import("./index.js");
    const { parseArgs } = await import("./cli-args.js");
    const opts = parseArgs(["node", "bench", "--dry-run"]);
    expect(dryRunWouldMaskRefusal(opts, "settings.yaml unreadable or invalid at /tmp/x")).toBe(true);
  });
});

// review of 43e3694 (S4): update-all's report path — proved at the unit
// level, direct-import, no CLI spawn needed (same pattern report-dir.test.ts
// uses for benchmarkSubReportDir).
describe("update-all report path (review of 43e3694, S4)", () => {
  it("nests under <mainRoot>/reports/llm-externalizer/update-all/", async () => {
    const { updateAllReportDir } = await import("./update-all.js");
    expect(updateAllReportDir("/tmp/fake-project-root")).toBe(
      "/tmp/fake-project-root/reports/llm-externalizer/update-all",
    );
  });
});
