// L3 registry (plan §3, §4): every decision spec registers itself here (SP-01..SP-21 each add one import and one entry).
import type { AnySpec, Built, SplitClass, Injection, Thresholds } from "./spec.js";
import { spec as verifySpec } from "./verify.js";
import { spec as screenSpec } from "./screen.js";
import { spec as filterSpec } from "./filter.js";
import { spec as labelSpec } from "./label.js";
import { spec as rankSpec } from "./rank.js";
import { spec as findSpec } from "./find.js";
import { spec as decideSpec } from "./decide.js";
import { spec as compareSpec } from "./compare.js";
import { spec as extractSpec } from "./extract.js";
import { spec as auditSpec } from "./audit.js";
import { spec as reviewSpec } from "./review.js";
import { spec as checkSpec } from "./check.js";
import { spec as findingsSpec } from "./findings.js";
import { spec as testOutputSpec } from "./test-output.js";

const SPLITS: readonly SplitClass[] = ["per-item", "whole-result"];
const INJECTIONS: readonly Injection[] = ["index-scoped", "params-in-instructions"];
const POLICY_VALUES: Record<string, readonly unknown[]> = {
  sum: ["fixed", "scaled"], score: ["expected-value", "integer-index"], confidence: ["reject", "coerce-null"],
  probabilities: ["required", "optional"], legend: ["ignore", "require"],
};

// Why fail at load: a spec missing its policy, split class or placement would otherwise surface as a wrong exit code in one command only.
export function assertSpecShape(s: AnySpec): void {
  const bad = (m: string): never => { throw new Error(`decision spec "${String(s?.id)}": ${m}`); };
  if (typeof s?.id !== "string" || !/^[a-z][a-z0-9-]*$/.test(s.id)) bad("id must be lowercase kebab-case");
  if (typeof s.input?.safeParse !== "function") bad("input must be a zod schema");
  if (!SPLITS.includes(s.split)) bad(`split must be one of ${SPLITS.join(", ")}`);
  if (!INJECTIONS.includes(s.injection)) bad(`injection must be one of ${INJECTIONS.join(", ")}`);
  for (const [k, allowed] of Object.entries(POLICY_VALUES)) {
    if (!allowed.includes((s.validation as unknown as Record<string, unknown> | undefined)?.[k])) bad(`validation.${k} must be one of ${allowed.join(", ")}`);
  }
  if (typeof s.validation.tie !== "number" || !(s.validation.tie >= 0)) bad("validation.tie must be a number >= 0");
  for (const [name, t] of Object.entries(s.thresholds ?? bad("thresholds missing"))) {
    const ok = [t.default, t.min, t.max].every(Number.isFinite) && t.min <= t.default && t.default <= t.max;
    if (!ok) bad(`threshold "${name}" needs finite min <= default <= max`);
    if (typeof t.help !== "string" || t.help === "") bad(`threshold "${name}" needs help text`);
  }
  for (const fn of ["build", "project", "attention"] as const) if (typeof s[fn] !== "function") bad(`${fn} must be a function`);
}

export function defineRegistry(specs: readonly AnySpec[]): readonly AnySpec[] {
  const seen = new Set<string>();
  for (const s of specs) {
    assertSpecShape(s);
    if (seen.has(s.id)) throw new Error(`decision spec id "${s.id}" registered twice`);
    seen.add(s.id);
  }
  return specs;
}

export const DECISION_SPECS: readonly AnySpec[] = defineRegistry([verifySpec, screenSpec, filterSpec, labelSpec, rankSpec, findSpec, decideSpec, compareSpec, extractSpec, auditSpec, reviewSpec, checkSpec, findingsSpec, testOutputSpec]);

export function getSpec(id: string): AnySpec {
  const s = DECISION_SPECS.find((x) => x.id === id);
  if (!s) throw new Error(`unknown decision spec "${id}"`);
  return s;
}


// Plan E117: the fan-out needs a default label for every choice question of a text unit (chunks on the default do not vote). Whether `build` can emit one depends on the input, so it is checked on a built sample.
// WHY an optional `built`: the runner already holds the built job; building again here doubled the work of every run. Without it (registry tests) the sample is built here.
export function assertChunkDefaults(s: AnySpec, input: unknown, t: Thresholds, built: Built = s.build(input, t)): void {
  const keys = built.units.filter((u) => u.kind === "text").flatMap((u) => Object.entries(u.questions).filter(([, q]) => q.type === "choice").map(([k]) => k));
  if (keys.length === 0) return;
  const defaults = s.chunkDefaults?.(input);
  if (defaults === undefined) throw new Error(`decision spec "${s.id}": build emits a text unit with a choice question (${keys[0]}) but the spec defines no chunkDefaults`);
  const missing = keys.filter((k) => !Object.hasOwn(defaults, k));
  if (missing.length > 0) throw new Error(`decision spec "${s.id}": chunkDefaults names no default label for ${missing.join(", ")}`);
}

// Plan §4 definitions check: a tool `classify_<id>` in tools/definitions.ts must name a registered spec; C4-02 adds the flag/default text comparison.
export function unregisteredClassifyTools(toolNames: readonly string[], specs: readonly AnySpec[] = DECISION_SPECS): string[] {
  const ids = new Set(specs.map((s) => s.id));
  return toolNames.filter((n) => n.startsWith("classify_") && !ids.has(n.slice("classify_".length).replaceAll("_", "-")));
}
