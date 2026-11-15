// C4-03 (TRDD-4Q1IVJOE): the classify group of the launcher, in process. Real catalog, real tool table, real runner, real settings file, real input files; replies are the recorded P-01/P-02 fixtures served through the GlobalFetch seam (the only double).
// Hermeticity: LLM_EXT_CONFIG_DIR points at a temp dir under /tmp holding a real settings.yaml, the catalog cache and the report; no test touches ~/.llm-externalizer. A GlobalFetch that throws stands for "no request may happen".
// Stdin: the runner takes it through deps.readStdin (main.ts passes readAllStdin, which refuses a TTY and then reads process.stdin), which each runClassifyCommand test below gets as a real ended stream and asserts was never read (TRDD-S3QEQBYV); no test in this file reads stdin.
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { DECISION_SPECS } from "../classifiers/catalog/index.js";
import { INPUT_FLAGS, SHARED_FLAGS } from "../classifiers/shared-flags.js";
import { spec as filterSpec } from "../classifiers/catalog/filter.js";
import { replayFixture, syntheticResponse, type RecordedReply } from "../classifiers/l0/test-fetch.js";
import type { GlobalFetch } from "../classifiers/l0/transport.js";
import type { ArgvDeps } from "../classifiers/run-decision.js";
import { loadSettings, type Profile } from "../config.js";
import { buildTools } from "../tools/definitions.js";
import { classifyArgv, classifyHelpNote, classifySpecFor, GROUPS, NOT_YET_USABLE_CLASSIFY_IDS, NOT_YET_USABLE_NOTE, resolveInvocation, runClassifyCommand, type ToolDef } from "./launcher.js";
import { readAllFrom } from "./read-all.js";

const KEY = "sk-or-v1-C403SECRETKEYVALUE0123456789abcdef";
const tools = buildTools("") as Array<ToolDef & { acceptedProfileTypes: readonly string[] }>;
const fx = (dir: string, n: string): RecordedReply => JSON.parse(readFileSync(new URL(`../classifiers/__fixtures__/${dir}/${n}.json`, import.meta.url), "utf8")) as RecordedReply;

describe("the classify group is generated from the registry", () => {
  it("has exactly one action per registered spec id plus ping, and each action resolves back to its spec", () => {
    // WHY derived from DECISION_SPECS: a spec added to the registry appears here with no edit, which is what "generated" means.
    expect(Object.keys(GROUPS.classify!)).toEqual([...DECISION_SPECS.map((s) => s.id), "ping"]);
    for (const s of DECISION_SPECS) {
      const action = GROUPS.classify![s.id]!;
      expect(action).toEqual({ command: `classify_${s.id.replaceAll("-", "_")}` });
      expect(classifySpecFor(action.command)).toBe(s);
    }
    expect(classifySpecFor("chat")).toBeUndefined();
  });
  it("every action names a tool of the real catalog that only accepts classifier profiles", () => {
    for (const a of Object.values(GROUPS.classify!)) {
      const t = tools.find((x) => x.name === a.command);
      expect(t, a.command).toBeDefined();
      expect(t!.acceptedProfileTypes).toEqual(["classifier"]);
    }
  });
  it("a typo in the action suggests the right verb, and the group alone is a help request", () => {
    expect(resolveInvocation(["classify", "veryfy"], tools)).toEqual({ kind: "error", message: "unknown action 'veryfy' in group 'classify'.", suggestions: ["classify verify"] });
    expect(resolveInvocation(["classify"], tools)).toEqual({ kind: "group-help", group: "classify" });
    expect(resolveInvocation(["classify", "filter", "--help"], tools)).toMatchObject({ kind: "action-help", command: "classify_filter" });
  });
});

describe("classifyArgv: the spellings the schema shows become the flags the runner parses", () => {
  it("maps snake_case properties to kebab flags, output_dir to -o, and drops --quiet in flag position", () => {
    expect(classifyArgv(["--max_budget", "2", "--chunk_chars=500", "--strict_exit", "--output_dir", "/tmp/x", "--threshold", "0.7", "--quiet"]))
      .toEqual(["--max-budget", "2", "--chunk-chars=500", "--strict-exit", "-o", "/tmp/x", "--threshold", "0.7"]);
  });
  it("a value token is never touched: not a name that looks like a flag, and not --quiet after a value flag", () => {
    expect(classifyArgv(["--input", "my_file_name.json"])).toEqual(["--input", "my_file_name.json"]);
    expect(classifyArgv(["--default", "--quiet"])).toEqual(["--default", "--quiet"]);
    expect(classifyArgv(["--input", "--x_y"])).toEqual(["--input", "--x_y"]);
    expect(classifyArgv(["-o", "--quiet"])).toEqual(["-o", "--quiet"]);
    expect(classifyArgv(["--strict_exit", "--quiet"])).toEqual(["--strict-exit"]);
  });
  it.each([
    [["-o", "/d"]],
    [["-o=/d"]],
    [["--output-dir", "/d"]],
    [["--output_dir=/d"]],
  ])("%j reaches the runner as `-o /d` (grouped path through the generic launcher rewrite, then flat path)", (spelling) => {
    // The generic launcher rewrites `-o x` to `--output_dir x` (resolveInvocation, the `token === "-o"` branch of launcher.ts).
    const grouped = resolveInvocation(["classify", "filter", ...spelling], tools);
    expect(grouped.kind).toBe("dispatch");
    expect(classifyArgv((grouped as { argv: string[] }).argv)).toEqual(["-o", "/d"]);
    expect(classifyArgv(spelling)).toEqual(["-o", "/d"]);
  });
});

describe("classifyArgv with a boolean spec flag (IN-03)", () => {
  it("`rank q --all --max_budget 5 file` keeps --all valueless: the next flag is renamed and its value kept, and `--all --quiet` drops --quiet", () => {
    expect(classifyArgv(["q", "--all", "--max_budget", "5", "f.txt"])).toEqual(["q", "--all", "--max-budget", "5", "f.txt"]);
    expect(classifyArgv(["q", "--all", "--quiet", "f.txt"])).toEqual(["q", "--all", "f.txt"]);
  });
});
describe("registry guard: a flag name has one arity everywhere (IN-03)", () => {
  it("no flag is boolean in one place and value-taking in another (spec flags, SHARED_FLAGS, INPUT_FLAGS, thresholds)", () => {
    const arity = new Map<string, Set<string>>();
    const note = (flag: string, boolean: boolean): void => { arity.set(flag, (arity.get(flag) ?? new Set()).add(boolean ? "boolean" : "value")); };
    for (const f of [...SHARED_FLAGS, ...INPUT_FLAGS]) note(f.flag, f.type === "boolean");
    for (const s of DECISION_SPECS) {
      for (const f of s.flags ?? []) note(f.flag, f.type === "boolean");
      for (const key of Object.keys(s.thresholds)) note(`--${key}`, false);
    }
    expect([...arity].filter(([, kinds]) => kinds.size > 1).map(([flag]) => flag)).toEqual([]);
    // the guard sees the spec boolean at all
    expect(arity.get("--all")).toEqual(new Set(["boolean"]));
  });
});
describe("help notes", () => {
  it("no id is in NOT_YET_USABLE_CLASSIFY_IDS now that extract's regex step is wired, so no classify tool gets the note", () => {
    expect([...NOT_YET_USABLE_CLASSIFY_IDS]).toEqual([]);
    expect(classifyHelpNote("classify_extract")).toBeUndefined();
    expect(NOT_YET_USABLE_NOTE).toBe("Not usable from the command line yet: the regex step is not wired.");
    expect(classifyHelpNote("classify_filter")).toBeUndefined();
    expect(classifyHelpNote("chat")).toBeUndefined();
  });
  it("every id of the set is a registered spec", () => {
    for (const id of NOT_YET_USABLE_CLASSIFY_IDS) expect(DECISION_SPECS.some((s) => s.id === id)).toBe(true);
  });
});

describe("runClassifyCommand (filter spec, replayed replies)", () => {
  let tmp: string;
  let inputFile: string;
  let prev: Record<string, string | undefined>;
  beforeEach(() => {
    tmp = mkdtempSync(join("/tmp", "llm-ext-c403-"));
    prev = { LLM_EXT_CONFIG_DIR: process.env.LLM_EXT_CONFIG_DIR, C403_TEST_KEY: process.env.C403_TEST_KEY };
    process.env.LLM_EXT_CONFIG_DIR = tmp;
    process.env.C403_TEST_KEY = KEY;
    inputFile = join(tmp, "input.json");
    writeFileSync(inputFile, JSON.stringify({ question: "Does it fail?", items: [{ text: "boom" }] }));
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(tmp, { recursive: true, force: true });
  });

  const profile = (over: Record<string, unknown> = {}): Profile => ({ "profile-type": "classifier", api: "openrouter-remote", model: "typesafe/jev-1.13", api_key: "$C403_TEST_KEY", max_attempts: 1, timeout_ms: 5000, concurrency: 2, ...over }) as unknown as Profile;
  function serve(onDecision: (questions: Record<string, unknown>) => Response) {
    const urls: string[] = [];
    const fetch: GlobalFetch = async (url, init) => {
      urls.push(url);
      if (url.includes("output_modalities=decisions")) return replayFixture(fx("p02", "models-decisions"));
      if (url.endsWith("/endpoints")) return replayFixture(fx("p02", "target-endpoints"));
      return onDecision((JSON.parse(String(init.body)) as { questions: Record<string, unknown> }).questions);
    };
    return { fetch, urls };
  }
  function relabeled(questions: Record<string, unknown>): Response {
    const rec = fx("p01", "dec-noul");
    const body = JSON.parse(rec.body) as { answers: Record<string, unknown> };
    const real = body.answers.is_bug;
    body.answers = Object.fromEntries(Object.keys(questions).map((k) => [k, real]));
    return replayFixture({ ...rec, body: JSON.stringify(body) });
  }
  // The settings are a real settings.yaml in the temp LLM_EXT_CONFIG_DIR, read back by the production loader.
  const io = (fetch: GlobalFetch, over: Record<string, unknown> = {}, settingsYaml?: Record<string, unknown>) => {
    const out: string[] = [];
    const err: string[] = [];
    const written = settingsYaml ?? { active: "c", active_classifier: "c", profiles: { c: profile(over) } };
    const yamlText = stringify(written);
    writeFileSync(join(tmp, "settings.yaml"), yamlText);
    const settings = loadSettings();
    // WHY these asserts: the tests must run on exactly the settings they wrote; loadSettings is read-only, so no migration/backup may appear.
    expect(settings, "settings.yaml was not loaded").not.toBeNull();
    const profiles = (written as { profiles: Record<string, Record<string, unknown>> }).profiles;
    expect(Object.keys(settings!.profiles)).toEqual(Object.keys(profiles));
    for (const [name, p] of Object.entries(profiles)) expect((settings!.profiles[name] as unknown as Record<string, unknown>)["profile-type"]).toBe(p["profile-type"]);
    expect(existsSync(join(tmp, "backups"))).toBe(false);
    expect(readFileSync(join(tmp, "settings.yaml"), "utf8")).toBe(yamlText);
    const stdin = new PassThrough();
    stdin.end("x");
    const deps: ArgvDeps = {
      settings: settings!,
      fetch,
      catalogOptions: { path: join(tmp, "catalog.json") },
      sigint: new EventEmitter(),
      readFile: (path) => readFileSync(path, "utf8"),
      // WHY (TRDD-S3QEQBYV): a real ended stream holding one byte, read through readAllFrom; neverRead asserts it stays unread.
      readStdin: () => readAllFrom(stdin),
      stdout: (t) => out.push(t),
      stderr: (l) => err.push(l),
    };
    return { out, err, deps, stdin };
  };
  const withInput = (...rest: string[]): string[] => ["--input", inputFile, ...rest];
  // WHY (TRDD-S3QEQBYV): every test here pins its exit code, which a swallowed read (exit 1) would break, and the exit-1 tests also pin the exact message; this guard adds detection of a read that leaves the outcome unchanged (an eager or unawaited read).
  const neverRead = (stdin: PassThrough): void => { expect(stdin.readableDidRead).toBe(false); };

  it("runs a decision with the input from --input, prints the envelope and returns the runner's 0", async () => {
    const s = serve(relabeled);
    const { out, err, deps, stdin } = io(s.fetch);
    // IN-07: --json keeps the envelope on stdout (the text form is the default now).
    const code = await runClassifyCommand(filterSpec, withInput("--threshold", "0.8", "--band=0.01", "--quiet", "--json"), "c", deps);
    neverRead(stdin);
    // C4-12: under --json the receipt lines (start with "— ") go to stderr; nothing else may.
    expect(err.filter((l) => !l.startsWith("— "))).toEqual([]);
    expect(code).toBe(0);
    // stdout is exactly the envelope: one write, parseable; every other message goes to stderr.
    expect(out).toHaveLength(1);
    const env = JSON.parse(out[0]!) as { decision: { threshold: number; matched_count: number } };
    expect(env.decision).toMatchObject({ threshold: 0.8, matched_count: 1 });
  });

  it("-o (written --output_dir) and --strict_exit work end to end: the report file exists and the exit code is the runner's", async () => {
    const s = serve(relabeled);
    const { err, deps, stdin } = io(s.fetch);
    const dir = join(tmp, "reports");
    const code = await runClassifyCommand(filterSpec, withInput("--output_dir", dir, "--strict_exit"), "c", deps);
    neverRead(stdin);
    expect(code).toBe(0);
    expect(err.some((l) => l.startsWith("report: "))).toBe(true);
    expect(existsSync(dir)).toBe(true);
  });

  it("an unknown flag is refused with exit 1 before any request", async () => {
    const s = serve(() => { throw new Error("must not be called"); });
    const { err, deps, stdin } = io(s.fetch);
    expect(await runClassifyCommand(filterSpec, withInput("--bogus", "1"), "c", deps)).toBe(1);
    neverRead(stdin);
    expect(err).toEqual(["llm-ext: unknown option --bogus for classify filter"]);
    expect(s.urls).toEqual([]);
  });

  it("exit code 3 (key missing) survives unchanged", async () => {
    const s = serve(relabeled);
    delete process.env.C403_TEST_KEY;
    const { err, deps, stdin } = io(s.fetch);
    expect(await runClassifyCommand(filterSpec, withInput(), "c", deps)).toBe(3);
    neverRead(stdin);
    // The runner refused with its own message (this text proves the layer); a settings-load failure in io() would have thrown instead.
    expect(err).toEqual(["llm-ext: Profile 'c': the environment variable C403_TEST_KEY named by its api_key is not set. Fix: export C403_TEST_KEY=<your key>."]);
  });

  it("exit code 5 (request failed after retries) survives unchanged", async () => {
    const s = serve(() => syntheticResponse(500, "server error"));
    const { deps, stdin } = io(s.fetch);
    expect(await runClassifyCommand(filterSpec, withInput(), "c", deps)).toBe(5);
    neverRead(stdin);
  });

  // Profile selection on the classify path: the runner applies PT-03 to --profile, else active_classifier:, and never reads `active:`.
  const text = { "profile-type": "paid", api: "openrouter-remote", model: "some/model", api_key: "$C403_TEST_KEY" };
  const mixed = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ active: "t", active_classifier: "c", profiles: { t: text, c: profile() }, ...over });

  it("(a) no --profile, a text `active:` and a classifier `active_classifier:`: the command runs", async () => {
    const s = serve(relabeled);
    const { err, deps, stdin } = io(s.fetch, {}, mixed());
    expect(await runClassifyCommand(filterSpec, withInput("--band=0.01"), undefined, deps)).toBe(0);
    neverRead(stdin);
    expect(err).toEqual([]);
  });
  it("(b) --profile naming a text profile is refused with zero fetches", async () => {
    const s = serve(() => { throw new Error("must not be called"); });
    const { err, deps, stdin } = io(s.fetch, {}, mixed());
    expect(await runClassifyCommand(filterSpec, withInput(), "t", deps)).toBe(1);
    neverRead(stdin);
    expect(err).toEqual(["llm-ext: classify filter does not accept profile 't' (type 'paid'); accepted profile types: classifier."]);
    expect(s.urls).toEqual([]);
  });
  it("(c) --profile naming a classifier profile runs even though `active:` is a text profile", async () => {
    const s = serve(relabeled);
    const { deps, stdin } = io(s.fetch, {}, mixed({ active_classifier: undefined }));
    expect(await runClassifyCommand(filterSpec, withInput("--band=0.01"), "c", deps)).toBe(0);
    neverRead(stdin);
  });
  it("(d) no --profile and no active_classifier: the runner's own refusal, exit 1, no fetch", async () => {
    const s = serve(() => { throw new Error("must not be called"); });
    const { err, deps, stdin } = io(s.fetch, {}, mixed({ active_classifier: undefined }));
    expect(await runClassifyCommand(filterSpec, withInput(), undefined, deps)).toBe(1);
    neverRead(stdin);
    expect(err).toEqual(["llm-ext: classify filter needs a classifier profile: pass --profile <name>, or set 'active_classifier:' in settings.yaml."]);
    expect(s.urls).toEqual([]);
  });

  // C4-08 (TRDD-58CFBQHN): the launcher puts --estimate in front, so it stays an option even when typed after "--".
  // The flag after it (--output_dir) must still be rewritten.
  it("--estimate reaches the runner: exit 0, no decisions request, and the flag after it is still rewritten (--output_dir)", async () => {
    const s = serve(() => { throw new Error("must not be called"); });
    const { out, err, deps, stdin } = io(s.fetch);
    const dir = join(tmp, "est-reports");
    expect(await runClassifyCommand(filterSpec, withInput("--estimate", "--output_dir", dir), "c", deps)).toBe(0);
    neverRead(stdin);
    expect(err).toEqual([]);
    expect(out[0]).toContain("filter --estimate: nothing was sent");
    expect(s.urls.some((u) => !u.includes("output_modalities=decisions") && !u.endsWith("/endpoints"))).toBe(false);
    expect(existsSync(dir)).toBe(true);
  });
  // C4-08 (TRDD-58CFBQHN, classify only): "--" must not demote --estimate to a file name (the runner reads every token after it as a positional), so runClassifyCommand hoists it (launcher.ts:193); the question and the file after "--" stay inputs.
  it("--estimate typed after \"--\" is still the dry-run flag while the file after it is read as input: exit 0, no decisions request, stderr empty, stdin unread", async () => {
    const s = serve(() => { throw new Error("must not be called"); });
    const { out, err, deps, stdin } = io(s.fetch);
    // profileFlag undefined on purpose: this test is about --estimate only; the profile comes from active_classifier: "c" in the default settings io() writes. The --profile-after-"--" case has its own test below (TRDD-OZIIABLY).
    const code = await runClassifyCommand(filterSpec, ["--", "--estimate", "Does it fail?", inputFile], undefined, deps);
    expect(err).toEqual([]);
    expect(code).toBe(0);
    neverRead(stdin);
    const text = out.join("\n");
    expect(text).toContain("filter --estimate: nothing was sent");
    // A filter with no inputs exits 1 ("nothing to filter", IN-01), so exit 0 plus requests >= 1 means the file after "--" was read and planned.
    expect(Number(/^requests: (\d+)/m.exec(text)?.[1])).toBeGreaterThanOrEqual(1);
    // The "output_modalities=decisions" URL is the catalog listing (serve() above answers it), not a decision request: a decision request is any URL that is neither it nor /endpoints, and serve() would throw on it.
    expect(s.urls.filter((u) => !u.includes("output_modalities=decisions") && !u.endsWith("/endpoints"))).toEqual([]);
  });
  // TRDD-OZIIABLY: runClassifyCommand used to append `--profile <name>` after the argv, so after a bare "--" the runner read it as a positional (an input slot): "no such file or directory: --profile". It is now put in front, next to the hoisted --estimate, so it can never follow a "--".
  // WHY profile z differs from active_classifier c, by api_key variable: a fix that silently dropped --profile would run on c and send c's key; the Authorization header of the decision request tells the two apart.
  it("--profile z with a bare \"--\" before the question runs paid on profile z's key, not active_classifier c's: exit 0, stderr empty", async () => {
    const zKey = "z-profile-key";
    process.env.C403_Z_KEY = zKey;
    try {
      const s = serve(relabeled);
      const auth: string[] = [];
      const fetch: GlobalFetch = async (url, init) => {
        if (!url.includes("output_modalities=decisions") && !url.endsWith("/endpoints")) auth.push(String((init.headers as Record<string, string>).Authorization));
        return s.fetch(url, init);
      };
      const { err, deps, stdin } = io(fetch, {}, { active: "c", active_classifier: "c", profiles: { c: profile(), z: profile({ api_key: "$C403_Z_KEY" }) } });
      const code = await runClassifyCommand(filterSpec, ["--", "Does it fail?", inputFile], "z", deps);
      expect(err.filter((l) => !l.startsWith("— "))).toEqual([]);
      expect(code).toBe(0);
      neverRead(stdin);
      expect(auth).toEqual([`Bearer ${zKey}`]);
    } finally {
      delete process.env.C403_Z_KEY;
    }
  });
  it("--preview is refused as not available for classify yet, before any read or request", async () => {
    const flag = "--preview";
    const s = serve(() => { throw new Error("must not be called"); });
    const { err, deps, stdin } = io(s.fetch);
    expect(await runClassifyCommand(filterSpec, [flag], "c", deps)).toBe(1);
    neverRead(stdin);
    expect(err).toEqual([`llm-ext: ${flag} is not available for classify yet.`]);
    expect(s.urls).toEqual([]);
  });
});
