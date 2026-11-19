// C4-03 (TRDD-4Q1IVJOE): NEEDS BUILD. Spawns the compiled CLI (dist/llm-ext.js, `npm run build` first, Amendment G). No test here sends a request: help, refusals and the missing-key path end before the first decisions request.
// Hermeticity: each run gets its own empty temp dir as LLM_EXT_CONFIG_DIR and HOME (removed in finally); the decisions catalog the missing-key case needs is written into that dir from the recorded P-02 fixture, so no network is used.
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { loadDecisionsCatalog } from "../classifiers/l0/catalog.js";
import { replayFixture, type RecordedReply } from "../classifiers/l0/test-fetch.js";
import { CLI_SCRIPT } from "../test-helpers.js";

const execFileAsync = promisify(execFile);
const SETTINGS = [
  "active: mine",
  "active_classifier: cl",
  "profiles:",
  "  mine:",
  "    profile-type: paid",
  "    mode: remote",
  "    api: openrouter-remote",
  "    api_key: $C403_NO_SUCH_KEY",
  "    model: vendor/mine",
  "  cl:",
  "    profile-type: classifier",
  "    api: openrouter-remote",
  "    api_key: $C403_NO_SUCH_KEY",
  "    model: typesafe/jev-1.13",
  "",
].join("\n");
const INPUT = JSON.stringify({ question: "Does it fail?", items: [{ text: "boom" }] });

interface Run { stdout: string; stderr: string; exitCode: number | null; left: string[] }
async function run(args: string[], opts: { settings?: string; catalog?: boolean; files?: Record<string, string> } = {}): Promise<Run> {
  const dir = mkdtempSync("/tmp/__llm_ext_c403_cfg_");
  if (opts.settings !== undefined) writeFileSync(join(dir, "settings.yaml"), opts.settings);
  writeFileSync(join(dir, "in.json"), INPUT);
  for (const [name, text] of Object.entries(opts.files ?? {})) writeFileSync(join(dir, name), text);
  if (opts.catalog) {
    const rec = JSON.parse(readFileSync(new URL("../classifiers/__fixtures__/p02/models-decisions.json", import.meta.url), "utf8")) as RecordedReply;
    await loadDecisionsCatalog({ fetch: async () => replayFixture(rec), path: join(dir, "decisions-catalog-cache.json") });
  }
  const before = new Set(readdirSync(dir));
  try {
    try {
      const o = await execFileAsync("node", [CLI_SCRIPT, ...args.map((a) => a.replace("@DIR", dir))], { env: { ...process.env, HOME: dir, LLM_EXT_CONFIG_DIR: dir, LLM_EXT_INSTALL_RULE: "0", C403_NO_SUCH_KEY: "" }, timeout: 30_000 });
      return { stdout: o.stdout, stderr: o.stderr, exitCode: 0, left: readdirSync(dir).filter((f) => !before.has(f)) };
    } catch (e) {
      const x = e as { stdout?: string; stderr?: string; code?: number | null };
      return { stdout: x.stdout ?? "", stderr: x.stderr ?? "", exitCode: x.code ?? null, left: readdirSync(dir).filter((f) => !before.has(f)) };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("llm-ext classify (built CLI)", () => {
  it("classify --help lists every action and creates no settings file", async () => {
    const r = await run(["classify", "--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("llm-ext classify <action>");
    for (const id of ["verify", "filter", "test-output"]) expect(r.stdout).toContain(`  ${id}`);
    expect(r.left).toEqual([]);
  });
  it("classify filter --help shows the thresholds with default and range and creates no settings file", async () => {
    const r = await run(["classify", "filter", "--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/--threshold .*\(default 0\.5, range 0\.\.1\)/);
    expect(r.stdout).toContain("--max_budget");
    // TRDD-58CFBQHN (issue 16 item 5): the decision commands list --estimate; this pins the RENDERED row, uncut (cli/main.ts firstLine cuts a long row with "..."), which the schema test in tools/definitions-classify.test.ts cannot see. classify refuses --preview, so its help never lists it.
    expect(r.stdout).toMatch(/--estimate\s+\[boolean\] Dry run: print the estimated input cost \(an estimate, not a ceiling\); nothing is sent to Jev\./);
    // A second --estimate row must fail here, for example from the cli/main.ts dry-run block if a classify tool enters PROFILE_AWARE_TOOLS (src/cli/dry-run-flags.ts) with estimate: true. Since the per-flag split (TRDD-58CFBQHN step 2, e0d4fabe) that block prints only the flags DRY_RUN_SUPPORT accepts, so --preview may not appear and this count may be the only guard.
    expect(r.stdout.match(/--estimate\s+\[boolean\]/g)).toHaveLength(1);
    expect(r.stdout).not.toContain("--preview");
    expect(r.left).toEqual([]);
  });
  it("classify extract --help no longer says it is not usable from the command line", async () => {
    const r = await run(["classify", "extract", "--help"]);
    expect(r.stdout).not.toContain("Not usable from the command line yet");
  });
  // WHY a single-match field: zero or one candidate is decided by the regex alone (noCall, E65), so the run needs no profile, key or network, yet only the real regex worker can produce the match.
  it("classify extract runs the regex worker (built CLI): a one-match field is found with no model call", async () => {
    const r = await run(["classify", "extract", "--input", "@DIR/extract.json"], { files: { "extract.json": JSON.stringify({ document: "Product Version 1.2.3", fields: [{ id: "v", pattern: "Version", description: "the word" }] }) } });
    expect(r.stderr).not.toContain("no regex matches");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("single_match");
    expect(r.stdout).toContain("Version");
  });
  it("a global --profile before the group keeps the help guarantee", async () => {
    const r = await run(["--profile", "x", "classify", "--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("llm-ext classify <action>");
    expect(r.left).toEqual([]);
  });
  // WHY these three: leadingToken skips the global boolean flags, so a leading --quiet must not make a classify command load the engine (which creates the settings file).
  // WHY exit 0 and the help text (TRDD-118TUPJJ): global help advertises --quiet as global, so main.ts moves a leading --quiet behind the command; it used to be refused as "unknown command".
  it.each([
    [["--quiet", "classify", "--help"]],
    [["--quiet", "classify", "filter", "--help"]],
    [["--profile", "x", "--quiet", "classify", "--help"]],
  ])("a leading --quiet before classify shows the help and creates no settings: %j", async (args) => {
    const r = await run(args);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("llm-ext classify");
    expect(r.left).toEqual([]);
  });
  // WHY these four pin CURRENT behaviour: a non-classify help loads the engine and creates settings.yaml (open owner decision recorded on PF-04 about migration on read-only commands). Whoever changes that must update them.
  it.each([
    [["scan", "--help"]],
    [["session", "--help"]],
    [["chat", "--help"]],
    [["--profile", "x", "scan", "--help"]],
  ])("current behaviour: non-classify help loads the engine and creates settings.yaml: %j", async (args) => {
    const r = await run(args);
    expect(r.left).toContain("settings.yaml");
  });
  // WHY exit 0 and the group help (TRDD-118TUPJJ): a leading --quiet is a global flag, not a command word; the engine is still loaded for a non-classify group, so settings.yaml is still created.
  it.each([
    [["--quiet", "scan", "--help"], "llm-ext scan <action>"],
    [["--quiet", "session", "--help"], "llm-ext session <action>"],
  ])("a leading --quiet before a non-classify group shows that group help and creates settings.yaml: %j", async (args, heading) => {
    const r = await run(args);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(heading);
    expect(r.left).toContain("settings.yaml");
  });
  it("a typo suggests the right verb and exits 1", async () => {
    const r = await run(["classify", "veryfy"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("did you mean: classify verify?");
    expect(r.left).toEqual([]);
  });
  it("a text profile given with --profile is refused (exit 1)", async () => {
    const r = await run(["classify", "filter", "--profile", "mine", "--input", "@DIR/in.json"], { settings: SETTINGS });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("classify filter does not accept profile 'mine' (type 'paid'); accepted profile types: classifier.");
    expect(r.stdout).toBe("");
  });
  it("default invocation (text `active:`, classifier `active_classifier:`) is not refused; a missing key exits 3, stdout empty", async () => {
    const r = await run(["classify", "filter", "--input", "@DIR/in.json"], { settings: SETTINGS, catalog: true });
    expect(r.stderr).toContain("C403_NO_SUCH_KEY");
    expect(r.exitCode).toBe(3);
    expect(r.stdout).toBe("");
  });
  it("--preview is refused as not supported by classify", async () => {
    const r = await run(["classify", "filter", "--preview", "--input", "@DIR/in.json"], { settings: SETTINGS });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("--preview is not supported by classify; use --estimate to price the run without sending a question to Jev.");
  });
  it("a non-classify group's --help still loads the engine: the default settings file is created", async () => {
    const r = await run(["scan", "--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("llm-ext scan <action>");
    expect(r.left).toContain("settings.yaml");
  });
});
