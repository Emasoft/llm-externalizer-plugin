// C4-02 (TRDD-V8Q20MLW), plan §4: the classify tool entries in definitions.ts are generated from the catalog; this test pins that they equal their spec and that the shared flags are the ones the parser accepts.
import { describe, expect, it } from "vitest";
import { DECISION_SPECS, getSpec } from "../classifiers/catalog/index.js";
import type { AnySpec } from "../classifiers/catalog/spec.js";
import { runDecisionArgv, type ArgvDeps } from "../classifiers/run-decision.js";
import { INPUT_FLAGS, SHARED_FLAGS } from "../classifiers/shared-flags.js";
import { readAllFrom } from "../cli/read-all.js";
import { PassThrough, type Readable } from "node:stream";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { loadSettings, PROFILE_TYPES } from "../config.js";
import { resolveClassifierProfile } from "../classifiers/l2/profile.js";
import { ACCEPTED_PROFILE_TYPES, buildTools, classifierPingTool, classifierProfileRows, classifyToolName, classifyTools, thresholdProperty } from "./definitions.js";

type Prop = { type: string; minimum?: number; maximum?: number; default?: number; description: string };
const entries = classifyTools();
const props = (e: (typeof entries)[number]) => e.inputSchema.properties as Record<string, Prop>;

// WHY the real parser with real settings and real file I/O (TRDD-KNSQAQ1S, R4 of TRDD-ZB41KG62): every argv below fails inside runDecisionArgv before any model call, so only the flag-acceptance step is exercised. settings come from a real settings.yaml read by loadSettings (a hand-built object cast to Settings skips the production loader) and readFile is the real readFileSync, which throws ENOENT on a missing file; only fetch (GlobalFetch seam) and the output sinks are doubled. readStdin reads the real ended stream the test passes in and the test asserts readableDidRead === false (TRDD-S3QEQBYV). The temp dir is under /tmp because getConfigDir refuses os.tmpdir(); it is removed and the env restored in finally.
function parserDeps(stdin: Readable): { deps: ArgvDeps; errors: string[] } {
  const errors: string[] = [];
  const dir = mkdtempSync(join("/tmp", "llm-ext-c402-"));
  const prev = process.env.LLM_EXT_CONFIG_DIR;
  process.env.LLM_EXT_CONFIG_DIR = dir;
  let settings: ReturnType<typeof loadSettings>;
  try {
    writeFileSync(join(dir, "settings.yaml"), stringify({ active_classifier: "p", profiles: { p: { "profile-type": "classifier", model: "typesafe/jev-1.13" } } }));
    settings = loadSettings();
  } finally {
    if (prev === undefined) delete process.env.LLM_EXT_CONFIG_DIR; else process.env.LLM_EXT_CONFIG_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
  if (settings === null) throw new Error("settings.yaml was not loaded");
  const deps: ArgvDeps = {
    settings,
    fetch: async () => { throw new Error("network not allowed in this test"); },
    readFile: (p: string) => readFileSync(p, "utf8"),
    readStdin: () => readAllFrom(stdin),
    stdout: () => {},
    stderr: (l: string) => { errors.push(l); },
  };
  return { deps, errors };
}

describe("classify entries vs the catalog", () => {
  it("has one entry per registered spec, in registry order, and nothing else", () => {
    expect(entries.map((e) => e.name)).toEqual(DECISION_SPECS.map((s) => classifyToolName(s.id)));
  });

  it("every entry equals its spec: threshold flags, default, range and help text", () => {
    for (const e of entries) {
      const spec = DECISION_SPECS.find((s) => classifyToolName(s.id) === e.name);
      expect(spec, `entry ${e.name} has no spec`).toBeDefined();
      for (const [key, t] of Object.entries(spec!.thresholds)) {
        expect(props(e)[thresholdProperty(key)], `${e.name} --${key}`).toEqual({ type: "number", minimum: t.min, maximum: t.max, default: t.default, description: t.help });
      }
    }
  });

  it("an entry carries exactly the spec thresholds plus the shared flags, and for a spec with `cli` the input flags (only --max-bytes for a document spec) and its own flags", () => {
    for (const e of entries) {
      const spec = DECISION_SPECS.find((s) => classifyToolName(s.id) === e.name)!;
      // IN-06: a document spec (test-output) takes one text, so only --max-bytes of INPUT_FLAGS applies.
      const inputProps = spec.cli === undefined ? [] : "document" in spec.cli ? INPUT_FLAGS.filter((f) => f.option === "maxBytes").map((f) => f.property) : INPUT_FLAGS.map((f) => f.property);
      const expected = [...Object.keys(spec.thresholds).map(thresholdProperty), ...SHARED_FLAGS.map((f) => f.property), ...inputProps, ...(spec.flags ?? []).map((f) => f.property)].sort();
      expect(Object.keys(props(e)).sort(), e.name).toEqual(expected);
    }
  });

  it("no spec threshold flag has the name of a shared flag", () => {
    const shared = new Set(SHARED_FLAGS.flatMap((f) => [f.flag.replace(/^-+/, ""), f.property]));
    const clashes = DECISION_SPECS.flatMap((s) => Object.keys(s.thresholds).filter((k) => shared.has(k) || shared.has(thresholdProperty(k))).map((k) => `${s.id}:--${k}`));
    expect(clashes).toEqual([]);
  });

  it("a spec the registry does not hold yields its entry with no edit to definitions.ts", () => {
    const fake = { ...getSpec("filter"), id: "zz-demo", thresholds: { "zz-level": { default: 0.2, min: 0.1, max: 0.9, help: "demo level" } } } as AnySpec;
    const [entry] = classifyTools([fake]);
    expect(entry!.name).toBe("classify_zz_demo");
    expect(props(entry!)["zz_level"]).toEqual({ type: "number", minimum: 0.1, maximum: 0.9, default: 0.2, description: "demo level" });
  });
});

describe("classify entries: names and property mapping", () => {
  it("generated tool names are unique across the registry", () => {
    const names = entries.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("threshold-to-property mapping is injective and no threshold key contains an underscore", () => {
    for (const s of DECISION_SPECS) {
      const keys = Object.keys(s.thresholds);
      const properties = keys.map(thresholdProperty);
      expect(new Set(properties).size, `${s.id}: two thresholds share a property`).toBe(keys.length);
      // WHY kebab only: the threshold key is the flag users type; an underscore key would not survive the property round trip (the tool property is snake_case).
      expect(keys.filter((k) => k.includes("_")), `${s.id}: threshold keys must be kebab-case`).toEqual([]);
    }
  });
});

describe("shared flags vs the runDecisionArgv parser", () => {
  it("every boolean flag declares the request field it sets", () => {
    const booleans = SHARED_FLAGS.filter((f) => f.type === "boolean");
    expect(booleans.map((f) => [f.flag, f.sets])).toEqual([["--strict-exit", "strictExit"], ["--json", "json"], ["--estimate", "estimate"]]);
  });

  // WHY every argv below ends in --input <missing file> (TRDD-S3QEQBYV): without it the parser falls through to stdin, so a stdin double would be called and its throw swallowed by the "cannot read the JSON input" catch (run-decision.ts:546-552); with it readFile fails with ENOENT first, so the ended stream holding a byte stays unread and readableDidRead === false is a real guard. The ENOENT assertion relies on the input stage running before profile selection and on every flag value being valid (value checks run before the input stage); if production starts validating the profile first, switch the outcome assertion.
  const MISSING = "c402-missing.json";
  const ENOENT = /cannot read the JSON input c402-missing\.json: ENOENT/;

  it("recognises every flag of SHARED_FLAGS (none is refused as an unknown option)", async () => {
    for (const f of SHARED_FLAGS) {
      const stdin = new PassThrough();
      stdin.end("x");
      const { deps, errors } = parserDeps(stdin);
      const value = f.type === "boolean" ? [] : [f.type === "number" ? "1" : f.flag === "--input" ? MISSING : "x"];
      await runDecisionArgv(DECISION_SPECS[0]!, f.flag === "--input" ? [f.flag, ...value] : [f.flag, ...value, "--input", MISSING], deps);
      expect(errors.join("\n"), f.flag).not.toMatch(/unknown option/);
      expect(errors.join("\n"), f.flag).toMatch(ENOENT);
      expect(stdin.readableDidRead, f.flag).toBe(false);
    }
  });

  it("refuses a flag that is not in SHARED_FLAGS or the spec's thresholds", async () => {
    const stdin = new PassThrough();
    stdin.end("x");
    const { deps, errors } = parserDeps(stdin);
    expect(await runDecisionArgv(DECISION_SPECS[0]!, ["--not-a-flag", "1"], deps)).toBe(1);
    expect(errors.join("\n")).toMatch(/unknown option --not-a-flag/);
    expect(stdin.readableDidRead).toBe(false);
  });

  it("accepts every threshold flag of every spec", async () => {
    for (const s of DECISION_SPECS) {
      for (const key of Object.keys(s.thresholds)) {
        const stdin = new PassThrough();
        stdin.end("x");
        const { deps, errors } = parserDeps(stdin);
        await runDecisionArgv(s, [`--${key}`, "0.5", "--input", MISSING], deps);
        expect(errors.join("\n"), `${s.id} --${key}`).not.toMatch(/unknown option/);
        expect(errors.join("\n"), `${s.id} --${key}`).toMatch(ENOENT);
        expect(stdin.readableDidRead, `${s.id} --${key}`).toBe(false);
      }
    }
  });
});

describe("PF-05: classify rows of ACCEPTED_PROFILE_TYPES", () => {
  it("every classify tool has the row ['classifier'] in the table buildTools reads", () => {
    for (const e of entries) expect(ACCEPTED_PROFILE_TYPES[e.name], e.name).toEqual(["classifier"]);
  });

  it("a spec the registry does not hold gets its row with no edit to the table", () => {
    const fake = { ...getSpec("filter"), id: "zz-demo" } as AnySpec;
    expect(classifierProfileRows([fake])).toEqual({ classify_zz_demo: ["classifier"] });
  });

  it("no classify row is typed by hand in definitions.ts", () => {
    expect(readFileSync(new URL("./definitions.ts", import.meta.url), "utf8")).not.toMatch(/^\s*classify_\w+\s*:/m);
  });
});

describe("C4-03: classify tools in the catalog and the frozen profile table", () => {
  it("buildTools lists every classify tool with its generated classifier row", () => {
    const built = buildTools("");
    for (const e of entries) expect(built.find((t) => t.name === e.name)?.acceptedProfileTypes, e.name).toEqual(["classifier"]);
  });
  it("the table is frozen, so a row cannot be replaced at run time", () => {
    expect(Object.isFrozen(ACCEPTED_PROFILE_TYPES)).toBe(true);
  });
  it("the generated classifier rows are spread last: they win over any other row of the same name", () => {
    const src = readFileSync(new URL("./definitions.ts", import.meta.url), "utf8");
    const table = src.slice(src.indexOf("export const ACCEPTED_PROFILE_TYPES"));
    const body = table.slice(0, table.indexOf("});"));
    expect(body.trimEnd().endsWith("...classifierProfileRows(),")).toBe(true);
    expect(body.match(/\.\.\.classifierProfileRows\(\)/g)).toHaveLength(1);
  });
});

describe("C4-03: the declared classifier-only rule equals what the runner enforces", () => {
  // WHY derived by calling the runner's check: the declared row (help surface) and the runner's refusal are two statements of one rule; a typed list here would be a third.
  it("for every classify tool, the accepted-types row is exactly the set of profile types resolveClassifierProfile does not refuse", () => {
    const enforced = PROFILE_TYPES.filter((type) => {
      // WHY a real settings.yaml per type read by loadSettings (precedent 441ce3fa): a hand-built object cast to Settings never passes through the production loader. /tmp, not os.tmpdir(): getConfigDir only allows HOME and /tmp.
      const dir = mkdtempSync(join("/tmp", "llm-ext-c402-"));
      const prev = process.env.LLM_EXT_CONFIG_DIR;
      process.env.LLM_EXT_CONFIG_DIR = dir;
      let r: ReturnType<typeof resolveClassifierProfile>;
      try {
        writeFileSync(join(dir, "settings.yaml"), stringify({ active_classifier: "p", profiles: { p: { "profile-type": type, model: "typesafe/jev-1.13" } } }));
        const settings = loadSettings();
        if (settings === null) throw new Error("settings.yaml was not loaded");
        r = resolveClassifierProfile({ settings, command: "classify filter" });
      } finally {
        if (prev === undefined) delete process.env.LLM_EXT_CONFIG_DIR; else process.env.LLM_EXT_CONFIG_DIR = prev;
        rmSync(dir, { recursive: true, force: true });
      }
      // The refusal is plain text with no code: matched on the message built at profile-accept.ts:55 (`${command} does not accept profile ...`).
      return r.ok || !r.error.includes("does not accept profile");
    });
    expect(enforced.length).toBeGreaterThan(0);
    for (const e of entries) expect([...ACCEPTED_PROFILE_TYPES[e.name]!].sort(), e.name).toEqual([...enforced].sort());
  });
});

// TRDD-58CFBQHN increment 1: --estimate works for the 15 classify decision commands (launcher.ts passes it to runDecisionArgv), so their --help must list it with one sentence; --preview is refused for classify by design (launcher.ts runClassifyCommand) and `classify ping` refuses both, so none of those list either.
// WHY derived from the same schema objects main.ts renders help rows from (tool.inputSchema.properties): a flag the help prints and a flag the schema holds cannot differ; the 15 ids are typed once here so a decision spec added or dropped without a deliberate edit fails the first check.
describe("TRDD-58CFBQHN: classify --help lists --estimate, never --preview", () => {
  const DECISIONS = ["verify", "screen", "filter", "label", "rank", "find", "decide", "compare", "extract", "audit", "review", "check", "findings", "test-output", "requirements"];
  const SENTENCE = "Dry run: print the estimated input cost (an estimate, not a ceiling); nothing is sent to Jev.";

  it("the registry holds exactly the 15 decision commands", () => {
    expect(DECISION_SPECS.map((s) => s.id).sort()).toEqual([...DECISIONS].sort());
  });

  it("each of the 15 decision commands lists --estimate (boolean) with the one sentence, and no --preview", () => {
    expect(entries).toHaveLength(15);
    for (const e of entries) {
      expect(props(e)["estimate"], `${e.name} --estimate`).toEqual({ type: "boolean", description: SENTENCE });
      expect(props(e)["preview"], `${e.name} --preview`).toBeUndefined();
    }
  });

  it("classify ping lists neither --estimate nor --preview", () => {
    const ping = classifierPingTool().inputSchema.properties as Record<string, unknown>;
    expect(ping["estimate"]).toBeUndefined();
    expect(ping["preview"]).toBeUndefined();
  });
});

// TRDD-WYY3SPDX increment A: `--context` is a flag of label and requirements only. filter is left out on purpose: its text-items instruction never references the shared context.
describe("TRDD-WYY3SPDX: the `context` property", () => {
  it("label and requirements list context as a string; filter and every other command do not", () => {
    for (const e of entries) {
      const has = e.name === "classify_label" || e.name === "classify_requirements";
      if (has) expect(props(e)["context"]?.type, e.name).toBe("string");
      else expect(props(e)["context"], e.name).toBeUndefined();
    }
  });
});
