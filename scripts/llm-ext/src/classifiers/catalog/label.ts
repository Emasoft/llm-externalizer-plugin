// SP-05 (TRDD-KKMJA9B5), plan §9 `classify label` (jev-mcp classify + quicksilver classify): items are labelled with one class each. Question text is our own wording (D17); the rules come from the plan row, quicksilver 0.3.0 cmdClassify/mergeChunks and the card.
import { z } from "zod";
import { choice } from "../l1/questions.js";
import { DEFAULT_POLICY } from "../l1/validate.js";
import type { ChoiceAnswer } from "../l1/validate-choice.js";
import { defaultLabel } from "../l2/chunker.js";
import { IdError, indexKey } from "../l2/ids.js";
import { InputError } from "../l2/input-error.js";
import { marginMet, PolicyError } from "../l2/policy-kit.js";
import { dataGuard, positionalIds, renumberByPosition } from "./shared.js";
import type { Answers, BuiltUnit, DecisionSpec, Thresholds } from "./spec.js";

// E59: the whole class catalog is sent with every request, so its serialized size is bounded (budget measure inferred from the plan row: the JSON length of the classes).
const CATALOG_BUDGET = 8000;

const labelInputSchema = z
  .object({
    // json: items packed into shared requests (atomic); files: each item (a file text) travels alone and the planner chunks it (text) - plan §5.
    mode: z.enum(["json", "files"]).default("json"),
    items: z.array(z.object({ id: z.string().optional(), text: z.string() })).min(1),
    classes: z.array(z.object({ id: z.string().min(1), description: z.string().nullable().optional() })).min(2).max(255),
    default: z.string().optional(),
    purpose: z.string().optional(),
    context: z.string().optional(),
  })
  .superRefine((v, ctx) => {
    const ids = v.classes.map((c) => c.id);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "duplicate class id" });
    // Why refuse: l1/validate-choice.ts stores probabilities in a plain {}, where `probs["__proto__"] = p` is silently dropped, so every answer for such a class would fail its sum check; failing here names the cause.
    if (ids.includes("__proto__")) ctx.addIssue({ code: "custom", message: 'a class id may not be "__proto__"' });
    if (v.default !== undefined && !ids.includes(v.default)) ctx.addIssue({ code: "custom", message: `default must be one of the class ids: ${ids.join(", ")}` });
    const size = JSON.stringify(v.classes).length;
    if (size > CATALOG_BUDGET) ctx.addIssue({ code: "custom", message: `the class catalog is ${size} characters, over the ${CATALOG_BUDGET}-character budget` });
    try {
      itemIds(v);
    } catch (e) {
      if (!(e instanceof IdError)) throw e;
      ctx.addIssue({ code: "custom", message: e.message });
    }
  });

type LabelClass = { id: string; description: string | null };

export type LabelInput = z.output<typeof labelInputSchema>;

// D14: caller ids are checked in json mode; in files mode the id is a path label, so only uniqueness is required. A missing id is its position.
// D14: see positionalIds.
function itemIds(i: Pick<LabelInput, "mode" | "items">): string[] {
  return positionalIds(i.items, i.mode);
}

// The default label drives the chunk merge (E117), which the runner performs; it needs this value from the spec.
// The default label drives the chunk merge (E117), which the runner performs; spec.chunkDefaults hands it over.
export const labelDefault = (i: Pick<LabelInput, "classes" | "default">): string => defaultLabel(i.classes.map((c) => c.id), i.default);

export interface LabelRow {
  id: string;
  label: string | null;
  confidence: number | null;
  probabilities: Record<string, number> | null;
  accepted: boolean;
  auto: boolean;
  review: boolean;
  tie: boolean;
  runnerUp: { label: string; probability: number } | null;
  /** Top minus runner-up probability (jev-mcp marginOf: 0 for a lone option); null when the answer was refused. */
  margin: number | null;
  invalid: string | null;
}
export interface LabelResult {
  rows: LabelRow[];
  byId: Record<string, LabelRow>;
  counts: Record<string, number>;
}

// Plan §9 "One band set": accepted drives the text listing, auto the JSON field; auto >= min-confidence keeps "low confidence" inside "not auto".
function assertBands(t: Thresholds): void {
  if (t.auto < t["min-confidence"]) throw new PolicyError(`--auto (${t.auto}) must be at least --min-confidence (${t["min-confidence"]})`);
}

const KEY = "label";

// Why rewrite by position: the planner packs units into requests and a state wire is {shared, units:[...]}, so `units[i]` must name the unit's place inside ITS request, whatever the job-wide index or chunk offset was.
function failRow(id: string, invalid: string): LabelRow {
  return { id, label: null, confidence: null, probabilities: null, accepted: false, auto: false, review: true, tie: false, runnerUp: null, margin: null, invalid };
}


// IN-02: --labels "a:hint,b" as quicksilver 0.3.0 parseLabels (qs.mjs:991-996): split on commas, trim, drop blanks, the FIRST colon ends the label and the rest (colons included) is its hint; no colon = no description.
// WHY an array of {id, description} and not qs's object: a repeated label stays visible, so the schema's "duplicate class id" refuses it instead of the last one silently winning.
function parseLabelsFlag(raw: string): LabelClass[] {
  return raw.split(",").map((s) => s.trim()).filter(Boolean).map((l) => {
    const [id, ...hint] = l.split(":");
    // WHY here: the schema would refuse the empty id as "classes.0.id: ..." without naming the flag the user typed.
    if (id!.trim() === "") throw new InputError(`--labels: empty label before ":" in ${JSON.stringify(l)}`);
    return { id: id!.trim(), description: hint.length > 0 ? hint.join(":").trim() : null };
  });
}

// IN-02: --labels-json {"label": "description"} as qs.mjs:987-990, but a non-object or a non-string description is refused here, where qs would build nonsense classes from it.
function parseLabelsJson(text: string): LabelClass[] {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    throw new InputError(`--labels-json is not valid JSON: ${(e as Error).message}`);
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new InputError('--labels-json must be a JSON object {"label": "description", ...}');
  return Object.entries(v).map(([id, d]) => {
    if (d !== null && typeof d !== "string") throw new InputError(`--labels-json description of ${JSON.stringify(id)} must be a string or null`);
    return { id, description: d };
  });
}

export const spec: DecisionSpec<LabelInput, LabelResult> = {
  id: "label",
  // IN-02: no leading positional (the classes come from the flags); each file is one text unit (mode files, E117) and the planner chunks long ones.
  cli: {
    positional: [],
    itemsField: "items",
    fixed: { mode: "files" },
  },
  flags: [
    { flag: "--labels", property: "labels", field: "classes", help: "Classes as \"a:hint,b\": comma separated, text after the first colon is the hint (2 to 255 labels).", parse: parseLabelsFlag },
    { flag: "--labels-json", property: "labels_json", field: "classes", atFile: true, help: "Classes as a JSON object {\"label\": \"description\"}, or @file holding one (2 to 255 labels).", parse: parseLabelsJson },
  ],
  input: labelInputSchema,
  thresholds: {
    auto: { default: 0.85, min: 0, max: 1, help: "--auto: lowest confidence that makes a label automatic (must be >= --min-confidence)" },
    margin: { default: 0.5, min: 0, max: 1, help: "--margin: lowest gap between the top two class probabilities for an automatic label" },
    "min-confidence": { default: 0.6, min: 0, max: 1, help: "--min-confidence: below this a label is listed as low confidence" },
  },
  split: "per-item",
  injection: "index-scoped",
  validation: DEFAULT_POLICY,
  // E117: only files mode makes text units (chunked by the planner); the default is the caller's --default, else the last class.
  chunkDefaults: (i) => (i.mode === "files" ? Object.fromEntries(i.items.map((_, k) => [indexKey(KEY, k), labelDefault(i)])) : {}),
  build(i, t) {
    assertBands(t);
    const ids = itemIds(i);
    // Why null criteria: the descriptions live once in shared state; repeating them in every item's question would multiply the cost by the item count.
    const criteria = Object.fromEntries(i.classes.map((c) => [c.id, null]));
    const background = [i.purpose === undefined ? "" : " Use `shared.purpose` as the reason for the classification.", i.context === undefined ? "" : " Use `shared.context` as background."].join("");
    const units: BuiltUnit[] = i.items.map((it, k) => ({
      kind: i.mode === "files" ? "text" : "atomic",
      // Why a bare string for text: the planner chunks a string state by lines; an object state would be split by entries and refuse a long `text`.
      state: i.mode === "files" ? it.text : { id: ids[k], text: it.text },
      // D5, D14: the question names the unit by position and the key is built from the index; no item text and no caller id reach the instructions.
      questions: {
        [indexKey(KEY, k)]: choice(
          `Which class in \`shared.classes\` best describes \`units[${k}]\`? Answer with the class id. ${dataGuard(`the content of \`units[${k}]\``, "classify")}${background}`,
          criteria,
        ),
      },
    }));
    return {
      sharedState: { purpose: i.purpose ?? null, context: i.context ?? null, classes: i.classes.map((c) => ({ id: c.id, description: c.description ?? null })) },
      units,
      unsplittable: {},
      renumber: renumberByPosition,
    };
  },
  project(answers: Answers, i, t) {
    assertBands(t);
    const ids = itemIds(i);
    const keys = ids.map((_, k) => indexKey(KEY, k));
    // E60: the runner merges chunks back to one answer per item; a different key set means ids were lost or invented, and a partial silent result would be worse than stopping.
    const got = Object.keys(answers);
    if (got.length !== keys.length || !keys.every((k) => Object.hasOwn(answers, k))) {
      throw new Error(`internal error: label answers name ${got.length} items (${got.join(", ")}) but the input has ${keys.length}`);
    }
    // E58: caller ids and class ids are keys of these maps; a plain {} would let "__proto__" rewrite the prototype.
    const byId: Record<string, LabelRow> = Object.create(null);
    const counts: Record<string, number> = Object.create(null);
    for (const c of i.classes) counts[c.id] = 0;
    const rows = ids.map((id, k) => {
      const a = answers[keys[k]!]!;
      let row: LabelRow;
      if (!a.ok) row = failRow(id, a.reason);
      else {
        const c = a.answer as ChoiceAnswer;
        const confidence = c.confidence ?? null;
        const probabilities: Record<string, number> | null = c.probabilities ? Object.assign(Object.create(null) as Record<string, number>, c.probabilities) : null;
        const sorted = probabilities ? Object.entries(probabilities).sort((x, y) => y[1] - x[1]) : [];
        const second = sorted[1];
        // Why >= top and not p[choice]: the chosen label must be the highest one, else the margin would compare the wrong pair; marginMet needs sorted input.
        const isTop = sorted.length > 0 && probabilities![c.choice]! >= sorted[0]![1];
        // Why a null confidence is not accepted: qs writes !(conf >= min), an unknown confidence goes to review, never auto.
        const accepted = confidence !== null && confidence >= t["min-confidence"];
        const auto = confidence !== null && confidence >= t.auto && !c.tie && isTop && marginMet(sorted[0]![1], second?.[1], t.margin);
        row = {
          id, label: c.choice, confidence, probabilities, accepted, auto, review: !auto, tie: c.tie,
          runnerUp: second ? { label: second[0], probability: second[1] } : null, margin: sorted.length > 0 ? sorted[0]![1] - (second?.[1] ?? 0) : null, invalid: null,
        };
        counts[c.choice] = (counts[c.choice] ?? 0) + 1;
      }
      byId[id] = row;
      return row;
    });
    return { rows, byId, counts };
  },
  // Plan §9: review (which covers low confidence and invalid, since auto >= min-confidence) or a caller class named manual_review.
  attention: (r) => r.rows.some((row) => row.review || row.label === "manual_review"),
};
