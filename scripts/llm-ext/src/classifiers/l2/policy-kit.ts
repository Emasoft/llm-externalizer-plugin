// L2-10: the shared threshold math of decision specs (bands, margin, max-gated, range checks). Holds no decision default.

/** Refusal of a threshold, probability or flag value (CLI exit 1). */
export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

// WHY a tolerance: gaps are computed from decimal probabilities, and 0.7 - 0.2 is 0.49999999999999994, which would reject a margin of exactly 0.5 the caller meant as met.
const EPS = 1e-9;

function probability(name: string, v: number): void {
  if (!Number.isFinite(v) || v < 0 || v > 1) throw new PolicyError(`${name} must be a number from 0 to 1, got ${v}`);
}

/**
 * Filter band: matched = p >= threshold; borderline = |p - threshold| < band. A p between threshold and
 * threshold + band is in both, as quicksilver prints it (E128).
 */
export function band(p: number, threshold: number, width: number): { matched: boolean; borderline: boolean } {
  probability("p", p);
  probability("threshold", threshold);
  if (!Number.isFinite(width) || width < 0) throw new PolicyError(`band must be a non-negative number, got ${width}`);
  // WHY width - EPS: the band edge itself is outside the band, and 0.5 + 0.15 is not exactly 0.65 in floats.
  return { matched: p >= threshold, borderline: Math.abs(p - threshold) < width - EPS };
}

/** True when the top option leads the runner-up by at least `margin`; a single option has no runner-up and meets any margin. */
export function marginMet(top: number, runnerUp: number | undefined, margin: number): boolean {
  probability("top", top);
  probability("margin", margin);
  if (runnerUp === undefined) return true;
  probability("runner-up", runnerUp);
  // WHY refuse: a runner-up above the top means the caller passed the options unsorted, and the gap would be negative noise.
  if (runnerUp > top) throw new PolicyError(`runner-up ${runnerUp} is above top ${top}`);
  return top - runnerUp >= margin - EPS;
}

/** Max-gated rule: the largest value decides, gated when it reaches `at`. */
export function maxGate(values: readonly number[], at: number): { max: number; gated: boolean } {
  // WHY refuse empty: Math.max of nothing is -Infinity, which would never gate and let an unchecked item pass.
  if (values.length === 0) throw new PolicyError("max-gate needs at least one value");
  probability("gate threshold", at);
  for (const v of values) probability("value", v);
  const max = Math.max(...values);
  return { max, gated: max >= at };
}

/** Range and default of one threshold flag, owned by the decision spec. */
export interface ThresholdSpec {
  default: number;
  min: number;
  max: number;
}

function inRange(name: string, v: number, spec: ThresholdSpec): number {
  if (!Number.isFinite(v) || v < spec.min || v > spec.max) {
    throw new PolicyError(`--${name} must be a number from ${spec.min} to ${spec.max}, got ${v}`);
  }
  return v;
}

// WHY a strict pattern: Number() accepts "", " ", "0x10" and "1e-1", so a typo in a flag would become a different threshold instead of an error.
const PLAIN_DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)$/;

/** Parses the text of a threshold flag and refuses anything outside the spec range. */
export function parseThresholdFlag(name: string, raw: string, spec: ThresholdSpec): number {
  if (!PLAIN_DECIMAL.test(raw)) throw new PolicyError(`--${name} must be a plain decimal number, got ${JSON.stringify(raw)}`);
  return inRange(name, Number(raw), spec);
}

/** Every threshold of a spec: its default, or the flag override, range-checked. Unknown flag names are refused. */
export function resolveThresholds(
  specs: Readonly<Record<string, ThresholdSpec>>,
  overrides: Readonly<Record<string, string | number>>,
): Record<string, number> {
  for (const name of Object.keys(overrides)) {
    if (!Object.hasOwn(specs, name)) throw new PolicyError(`unknown threshold --${name}`);
  }
  const out: Record<string, number> = {};
  for (const [name, spec] of Object.entries(specs)) {
    // WHY check the default too: a spec with a default outside its own range is a catalog bug that must fail at once, not at a later comparison.
    inRange(name, spec.default, spec);
    const given = overrides[name];
    if (given === undefined) out[name] = spec.default;
    else out[name] = typeof given === "string" ? parseThresholdFlag(name, given, spec) : inRange(name, given, spec);
  }
  return out;
}
