// SP-03 (TRDD-HJTLZ4T2): the filter decision as one catalog file (plan §9 `classify filter`, §5 filter row, D5, D14, D28).
// Merges jev-mcp noul (propositions) and quicksilver filter (text items, threshold + band). Wording of the questions is our own (D17).
import { z } from "zod";
import { noul } from "../l1/questions.js";
import { DEFAULT_POLICY, type NoulAnswer } from "../l1/validate.js";
import { IdError, checkItemIds, indexKey } from "../l2/ids.js";
import { PolicyError, band } from "../l2/policy-kit.js";
import { dataGuard, isBlank } from "./shared.js";
import type { Answers, Built, BuiltUnit, DecisionSpec, Thresholds } from "./spec.js";

const text = z.string().refine((s) => !isBlank(s), "text must not be blank");
// Text items come from files, lines or stdin: their ids are paths like `a.log:12`, so D14's id pattern cannot apply; keys never use them, only uniqueness matters.
const textItems = z.strictObject({
  question: z.string().refine((s) => !isBlank(s), "question must not be blank"),
  items: z.array(z.strictObject({ id: z.string().min(1).optional(), text })).min(1),
  context: z.string().optional(),
});
// WHY the caps (jev-mcp noul): a proposition sits in an instruction, where the planner cannot chunk it.
const propositions = z.strictObject({
  propositions: z.array(z.strictObject({ id: z.string().optional(), text: text.pipe(z.string().max(2000)) })).min(1).max(64),
  context: z.string().optional(),
});
const input = z.union([textItems, propositions]);
export type FilterInput = z.infer<typeof input>;

export interface FilterRow { id: string; p: number; text: string; matched: boolean; borderline: boolean; auto: boolean }
export interface FilterResult {
  threshold: number;
  band: number;
  auto_threshold: number;
  /** p >= threshold, best first: the JSON `matched` list and the receipt count. */
  matched: FilterRow[];
  matched_count: number;
  /** |p - threshold| < band; overlaps `matched` for p in [threshold, threshold + band) (E128). */
  borderline: FilterRow[];
  /** p >= threshold + band: the first part of quicksilver's text list. */
  sure: FilterRow[];
  /** Every answered item, best first: what --save writes. */
  rows: FilterRow[];
  /** Items with no usable answer and why (invalid_response, not_sent_fatal, not_sent_budget, not_sent_timeout, aborted, or the validation reason). */
  invalid: { id: string; reason: string }[];
}

// WHY 1e-9: 0.5 + 0.15 and 1 - 0.85 are not exact in floats, and an auto exactly on the edge must be accepted.
const EPS = 1e-9;

// WHY two rules (E57): auto marks a p as decided. The yes side must clear the borderline band (auto >= threshold + band), and the no side (p + auto <= 1) must stay below it (1 - auto <= threshold - band); otherwise a borderline p could count as auto.
function checkThresholds(t: Thresholds): void {
  if (t.auto! < t.threshold! + t.band! - EPS) throw new PolicyError(`--auto (${t.auto}) must be at least threshold + band (${t.threshold! + t.band!})`);
  if (1 - t.auto! > t.threshold! - t.band! + EPS) {
    throw new PolicyError(`--auto (${t.auto}) is too low for the p + auto <= 1 rule: p <= ${1 - t.auto!} would reach into the band below the threshold (${t.threshold! - t.band!}); raise --auto or lower --band`);
  }
}

const label = (k: number): string => `proposition ${k}`;

function build(i: FilterInput, t: Thresholds): Built {
  checkThresholds(t);
  // WHY null: the planner refuses an undefined shared state because JSON would drop it.
  const sharedState = i.context ?? null;
  if ("propositions" in i) {
    const ids = i.propositions.map((p, k) => p.id ?? `proposition_${k}`);
    checkItemIds(ids);
    const units: BuiltUnit[] = i.propositions.map((p, k) => ({
      kind: "atomic",
      // WHY the caller id in state and the proposition in the instruction: keys are index-based (D14) and a short caller parameter stays in instructions (D5: "proposition" is named there, plan line 18); the context in the state is untrusted, hence the guard.
      state: { id: ids[k]! },
      questions: {
        [indexKey("p", k)]: noul(`${label(k)}: ${p.text} ${dataGuard("the state")}`, {
          true: "The proposition is likely true, given the context in the state when there is one, and general knowledge",
          false: "The proposition is likely not true",
        }),
      },
    }));
    return { sharedState, units, unsplittable: {} };
  }
  const seen = new Set<string>();
  i.items.forEach((it, k) => {
    const id = it.id ?? `item_${k}`;
    if (seen.has(id)) throw new IdError("duplicate", `duplicate item id ${JSON.stringify(id)}`);
    seen.add(id);
  });
  // WHY kind text: an item may be a long file, which the planner cuts into chunks (plan §5); the question is the caller's and stays in instructions, the item text stays in state and the guard tells the model not to obey it (D5).
  const units: BuiltUnit[] = i.items.map((it, k) => ({ kind: "text", state: it.text, questions: { [indexKey("p", k)]: noul(`${i.question} ${dataGuard("the text in the state")}`) } }));
  return { sharedState, units, unsplittable: {} };
}

function project(answers: Answers, i: FilterInput, t: Thresholds): FilterResult {
  checkThresholds(t);
  const entries = "propositions" in i ? i.propositions : i.items;
  const prefix = "propositions" in i ? "proposition" : "item";
  const rows: FilterRow[] = [];
  const invalid: FilterResult["invalid"] = [];
  entries.forEach((e, k) => {
    const id = e.id ?? `${prefix}_${k}`;
    const a = answers[indexKey("p", k)];
    // WHY the reason is kept: a run that was stopped, aborted or lost a request must say which items it did not answer and why, not just list them.
    if (!a?.ok) { invalid.push({ id, reason: a?.reason ?? "no answer" }); return; }
    const p = (a.answer as NoulAnswer).noul;
    const b = band(p, t.threshold!, t.band!);
    // WHY p + auto <= 1 counts as auto: a confident no is as decided as a confident yes, so only the uncertain middle needs a look.
    rows.push({ id, p, text: e.text, matched: b.matched, borderline: b.borderline, auto: p >= t.auto! - EPS || p + t.auto! <= 1 + EPS });
  });
  // WHY stable sort by p descending: ties keep input order, as quicksilver's output does.
  rows.sort((a, b) => b.p - a.p);
  const matched = rows.filter((r) => r.matched);
  return {
    threshold: t.threshold!,
    band: t.band!,
    auto_threshold: t.auto!,
    matched,
    matched_count: matched.length,
    borderline: rows.filter((r) => r.borderline),
    sure: rows.filter((r) => r.p >= t.threshold! + t.band! - EPS),
    rows,
    invalid,
  };
}

// qs `template`: numbers, hex and long ids are templated out so lines that differ only in them read as one pattern.
const template = (s: string): string => s.replace(/0x[0-9a-f]+/gi, "#").replace(/[0-9a-f]{8,}/gi, "#").replace(/\d+/g, "#").replace(/\s+/g, " ").trim();

// [3,4,5,9] -> "3-5,9"; stops after `max` numbers and points at --save for the rest.
function ranges(nums: readonly number[], max: number): string {
  const parts: string[] = [];
  let shown = 0;
  for (let a = 0; a < nums.length && shown < max; a++) {
    let b = a;
    while (b + 1 < nums.length && nums[b + 1] === nums[b]! + 1) b++;
    parts.push(b > a ? `${nums[a]}-${nums[b]}` : `${nums[a]}`);
    shown += b - a + 1;
    a = b;
  }
  return parts.join(",") + (shown < nums.length ? `,… (+${nums.length - shown}; use --save for all)` : "");
}

export interface CollapsedRow { row: FilterRow; count: number; also?: string }

/** `--lines` collapsing (qs filter, off with `--no-collapse`): rows whose text differs only in numbers become one row `×count` plus the other line numbers. Ids must end in `:<line>`. */
export function collapseRepeats(rows: readonly FilterRow[], maxNumbers = 300): CollapsedRow[] {
  const groups = new Map<string, FilterRow[]>();
  for (const r of rows) {
    const k = template(r.text);
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }
  return [...groups.values()].map((g) => {
    if (g.length === 1) return { row: g[0]!, count: 1 };
    const rest = g.slice(1).map((r) => {
      const m = /:(\d+)$/.exec(r.id);
      // WHY fail fast: a repeat list of line numbers needs a line number; guessing would print a wrong "also lines".
      if (!m) throw new Error(`cannot collapse row ${JSON.stringify(r.id)}: its id does not end in a line number (:N)`);
      return Number(m[1]);
    }).sort((a, b) => a - b);
    return { row: g[0]!, count: g.length, also: ranges(rest, maxNumbers) };
  });
}

export const spec: DecisionSpec<FilterInput, FilterResult> = {
  id: "filter",
  // IN-01: the first positional is the question; every collected file or line is a text item.
  cli: { positional: [{ name: "question", field: "question" }], itemsField: "items" },
  input,
  thresholds: {
    threshold: { default: 0.5, min: 0, max: 1, help: "p at or above which an item is matched" },
    band: { default: 0.15, min: 0, max: 0.5, help: "width around the threshold inside which an item is borderline" },
    auto: { default: 0.85, min: 0.5, max: 1, help: "p at or above which (or p + auto <= 1 below which) an item counts as decided" },
  },
  split: "per-item",
  injection: "params-in-instructions",
  validation: DEFAULT_POLICY,
  build,
  project,
  attention: (r) => r.invalid.length > 0 || r.rows.some((x) => !x.auto || x.borderline),
};
