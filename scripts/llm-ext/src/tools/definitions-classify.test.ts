// C4-02 (TRDD-V8Q20MLW), plan §4: the classify tool entries in definitions.ts are generated from the catalog; this test pins that they equal their spec and that the shared flags are the ones the parser accepts.
import { describe, expect, it } from "vitest";
import { DECISION_SPECS, getSpec } from "../classifiers/catalog/index.js";
import type { AnySpec } from "../classifiers/catalog/spec.js";
import { runDecisionArgv, type ArgvDeps } from "../classifiers/run-decision.js";
import { INPUT_FLAGS, SHARED_FLAGS } from "../classifiers/shared-flags.js";
import { readFileSync } from "node:fs";
import { PROFILE_TYPES } from "../config.js";
import { resolveClassifierProfile } from "../classifiers/l2/profile.js";
import { ACCEPTED_PROFILE_TYPES, buildTools, classifierProfileRows, classifyToolName, classifyTools, thresholdProperty } from "./definitions.js";

type Prop = { type: string; minimum?: number; maximum?: number; default?: number; description: string };
const entries = classifyTools();
const props = (e: (typeof entries)[number]) => e.inputSchema.properties as Record<string, Prop>;

// WHY the real parser with throwing file I/O: every argv below fails inside runDecisionArgv before any model call, so only the flag-acceptance step is exercised.
function parserDeps(): { deps: ArgvDeps; errors: string[] } {
  const errors: string[] = [];
  const deps: ArgvDeps = {
    settings: {} as ArgvDeps["settings"],
    fetch: async () => { throw new Error("network not allowed in this test"); },
    readFile: () => { throw new Error("no file"); },
    readStdin: async () => { throw new Error("no stdin"); },
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

  it("an entry carries exactly the spec thresholds plus the shared flags, and for a spec with `cli` the input flags and its own flags", () => {
    for (const e of entries) {
      const spec = DECISION_SPECS.find((s) => classifyToolName(s.id) === e.name)!;
      const expected = [...Object.keys(spec.thresholds).map(thresholdProperty), ...SHARED_FLAGS.map((f) => f.property), ...(spec.cli === undefined ? [] : INPUT_FLAGS.map((f) => f.property)), ...(spec.flags ?? []).map((f) => f.property)].sort();
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
    expect(booleans.map((f) => [f.flag, f.sets])).toEqual([["--strict-exit", "strictExit"]]);
  });

  it("recognises every flag of SHARED_FLAGS (none is refused as an unknown option)", async () => {
    for (const f of SHARED_FLAGS) {
      const { deps, errors } = parserDeps();
      await runDecisionArgv(DECISION_SPECS[0]!, f.type === "boolean" ? [f.flag] : [f.flag, "x"], deps);
      expect(errors.join("\n"), f.flag).not.toMatch(/unknown option/);
    }
  });

  it("refuses a flag that is not in SHARED_FLAGS or the spec's thresholds", async () => {
    const { deps, errors } = parserDeps();
    expect(await runDecisionArgv(DECISION_SPECS[0]!, ["--not-a-flag", "1"], deps)).toBe(1);
    expect(errors.join("\n")).toMatch(/unknown option --not-a-flag/);
  });

  it("accepts every threshold flag of every spec", async () => {
    for (const s of DECISION_SPECS) {
      for (const key of Object.keys(s.thresholds)) {
        const { deps, errors } = parserDeps();
        await runDecisionArgv(s, [`--${key}`, "0.5"], deps);
        expect(errors.join("\n"), `${s.id} --${key}`).not.toMatch(/unknown option/);
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
      const settings = { active: undefined, active_classifier: "p", profiles: { p: { "profile-type": type, model: "typesafe/jev-1.13" } } } as unknown as Parameters<typeof resolveClassifierProfile>[0]["settings"];
      const r = resolveClassifierProfile({ settings, command: "classify filter" });
      // The refusal is plain text with no code: matched on the message built at profile-accept.ts:55 (`${command} does not accept profile ...`).
      return r.ok || !r.error.includes("does not accept profile");
    });
    expect(enforced.length).toBeGreaterThan(0);
    for (const e of entries) expect([...ACCEPTED_PROFILE_TYPES[e.name]!].sort(), e.name).toEqual([...enforced].sort());
  });
});
