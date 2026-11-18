// SP-07 (TRDD-UQ8TYKC9), plan §9 `classify rank` (D29: jev-mcp rerank + quicksilver rank + claude-jev relevance): every candidate gets a 5-level relevance score. Question text is our own wording (D17); rules from the plan row, quicksilver 0.3.0 cmdRank and the card.
import { z } from "zod";
import { score } from "../l1/questions.js";
import { SCORE_POLICY } from "../l1/validate.js";
import type { ScoreAnswer } from "../l1/validate-score.js";
import { IdError, indexKey } from "../l2/ids.js";
import { InputError } from "../l2/input-error.js";
import { PolicyError } from "../l2/policy-kit.js";
import { dataGuard, positionalIds, renumberByPosition } from "./shared.js";
import { clip, f2, type TextRender } from "../l2/render-text.js";
import type { Answers, BuiltUnit, DecisionSpec, Thresholds } from "./spec.js";

const rankInputSchema = z
  .object({
    query: z.string().min(1),
    // json: candidates packed into shared requests (atomic); files: each candidate (a file text) travels alone and the planner chunks it (text) - plan §5.
    mode: z.enum(["json", "files"]).default("json"),
    candidates: z.array(z.object({ id: z.string().optional(), text: z.string() })).min(1),
    // Plan §9 `--head N`: send only the first N bytes of every candidate (claude-jev relevance); absent means the whole text.
    head: z.number().int().min(1).optional(),
    // `--all`: list every ranked candidate instead of the top N.
    all: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    try {
      candidateIds(v);
    } catch (e) {
      if (!(e instanceof IdError)) throw e;
      ctx.addIssue({ code: "custom", message: e.message });
    }
  });

export type RankInput = z.output<typeof rankInputSchema>;

// D14: caller ids are checked in json mode; in files mode the id is a path label, so only uniqueness is required. A missing id is its position.
// D14: see positionalIds.
function candidateIds(i: Pick<RankInput, "mode" | "candidates">): string[] {
  return positionalIds(i.candidates, i.mode);
}

// Plan §9: quicksilver's 5-level relevance rubric, reworded (qs 0.3.0 carries no licence); relevance = score / 4.
const LEVELS = [
  "Unrelated to the query.",
  "Same general topic as the query, but no help in answering it.",
  "Partly relevant: has some information useful for the query.",
  "Relevant: substantially addresses the query.",
  "Directly and specifically answers or matches the query.",
];
const MAX_LEVEL = LEVELS.length - 1;
const KEY = "rank";

// WHY the first `bytes` bytes, backed off to a character boundary (a UTF-8 continuation byte is 10xxxxxx): a multibyte character is never sent cut in half, and at most N bytes are sent (E34/E72; commit 79b8b5fd).
function headOf(text: string, bytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= bytes) return text;
  let end = bytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}

/** `chunk` is set only for a candidate that was cut into chunks: how many, and the source lines of the chunk that decided it (qs "N chunks, best lines A-B"). */
export interface RankRow { id: string; score: number; relevance: number; confidence: number | null; headCut: boolean; chunk?: { chunks: number; bestLines?: [number, number] } }
export interface RankResult {
  /** The candidates to show: sorted by relevance, cut by keep-at and top (or all). */
  rows: RankRow[];
  /** Candidates that were ranked, before keep-at and top. */
  total: number;
  /** Candidates whose answer was refused; they are never ranked. */
  invalid: { id: string; reason: string }[];
}

function assertTop(t: Thresholds): void {
  // WHY a whole number: quicksilver checks --top as an integer before any work, because unchecked numeric flags silently broke its runs (qs.mjs:91-98).
  if (!Number.isInteger(t.top)) throw new PolicyError(`--top must be a whole number, got ${t.top}`);
}

// WHY a hand-written check: the schema (int, min 1) would also refuse, but only as "head: ..." without the flag the user typed, so the flag names itself (IN-03; commit 79b8b5fd).
function parseHead(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new InputError(`--head needs a whole number of at least 1, got ${JSON.stringify(raw)}`);
  return n;
}
// IN-09 (qs rank): `relevance  id`, best first. A chunked candidate names its chunks so a score from one fragment is not read as the whole file.
function renderText(r: RankResult): TextRender {
  const lines = r.rows.map((x) => `${f2(x.relevance)}  ${clip(x.id, 200)}${x.chunk ? ` (${x.chunk.chunks} chunks${x.chunk.bestLines ? `, best lines ${x.chunk.bestLines.join("-")}` : ""})` : ""}`);
  // WHY said: a --keep-at that drops every candidate would print nothing, which reads like a failed run.
  if (lines.length === 0) lines.push("(no candidates)");
  for (const x of r.invalid) lines.push(`? no answer: ${x.id} (${x.reason})`);
  return { lines };
}
export const spec: DecisionSpec<RankInput, RankResult> = {
  id: "rank",
  // IN-01: files mode so each file travels as its own text unit (plan D31), not packed into a shared request.
  cli: {
    positional: [{ name: "query", field: "query" }],
    itemsField: "candidates",
    fixed: { mode: "files" },
  },
  // IN-03: --head and --all are inputs of the spec (rankInputSchema), so they are declared here and the overlay refuses a JSON input that already holds the field.
  flags: [
    { flag: "--head", property: "head", field: "head", type: "number", help: "Send at most the first N bytes of every candidate, cut at a character boundary (a whole number of at least 1).", parse: parseHead },
    { flag: "--all", property: "all", field: "all", type: "boolean", help: "List every ranked candidate instead of the top N.", parse: () => true },
  ],
  input: rankInputSchema,
  thresholds: {
    // WHY top 10 and --all: quicksilver rank shows 10 candidates, or every candidate with --all (qs.mjs:44, 1065-1067; plan §9 row classify rank).
    top: { default: 10, min: 1, max: 100000, help: "--top: how many candidates to list (ignored with --all)" },
    // Default 0 keeps every candidate (plain rank); the claude-jev relevance form is `--head 1500 --keep-at 0.5` (D27).
    "keep-at": { default: 0, min: 0, max: 1, help: "--keep-at: drop candidates whose relevance is below this" },
  },
  // WHY per-item: a failed request loses only the candidates it carried, every other candidate keeps its score (commit cddd9d43; plan §5 partial failure).
  split: "per-item",
  // WHY index-scoped: candidate text is untrusted, so it sits in state and the question names it by position (units[k]); only the short query stays in instructions (D5; plan §9 row classify rank).
  injection: "index-scoped",
  // WHY SCORE_POLICY, not the default: plan §6 requires probabilities for choice answers but leaves them optional for score, so a score reply without them is accepted and the score is checked against them only when present (plan §6 table, probabilities row; l1/validate.ts SCORE_POLICY).
  validation: SCORE_POLICY,
  build(i, t) {
    assertTop(t);
    const ids = candidateIds(i);
    const units: BuiltUnit[] = i.candidates.map((c, k) => {
      const text = i.head === undefined ? c.text : headOf(c.text, i.head);
      return {
        // WHY text in files mode: only a text unit is cut into chunks by the planner, and the chunk answers are merged back to the highest score per candidate (plan §5 unit kinds and chunk merge; D29; E63).
        kind: i.mode === "files" ? "text" : "atomic",
        // Why a bare string for text: the planner chunks a string state by lines (E63); an object state would be split by entries and refuse a long `text`.
        state: i.mode === "files" ? text : { id: ids[k], text },
        // D5, D14: the candidate is named by position and the key is built from the index; the short query stays in the instructions, the candidate text never does.
        questions: {
          [indexKey(KEY, k)]: score(
            `The query is: ${JSON.stringify(i.query)}. How relevant is \`units[${k}]\` to this query? ${dataGuard(`the content of \`units[${k}]\``, "rate")}`,
            LEVELS,
          ),
        },
      };
    });
    // WHY renumber by position: the planner packs units into requests and a state wire is {shared, units:[...]}, so `units[i]` must name the unit's place inside ITS request, whatever the job-wide index or chunk offset was; the questions of each unit name that place (plan §5 SplitJob renumber).
    return { sharedState: null, units, unsplittable: {}, renumber: renumberByPosition };
  },
  project(answers: Answers, i, t, ctx) {
    assertTop(t);
    const ids = candidateIds(i);
    const keys = ids.map((_, k) => indexKey(KEY, k));
    // The runner merges chunks back to one answer per candidate; a different key set means candidates were lost or invented, and a partial silent ranking would be worse than stopping.
    const got = Object.keys(answers);
    if (got.length !== keys.length || !keys.every((k) => Object.hasOwn(answers, k))) {
      throw new Error(`internal error: rank answers name ${got.length} candidates (${got.join(", ")}) but the input has ${keys.length}`);
    }
    const ranked: RankRow[] = [];
    const invalid: RankResult["invalid"] = [];
    ids.forEach((id, k) => {
      const a = answers[keys[k]!]!;
      if (!a.ok) {
        invalid.push({ id, reason: a.reason });
        return;
      }
      const s = a.answer as ScoreAnswer;
      // WHY longer than head: a candidate no longer than --head is sent whole, so only a longer one is cut (E34, E72).
      const headCut = i.head !== undefined && Buffer.byteLength(i.candidates[k]!.text, "utf8") > i.head;
      // WHY metadata only: the runner already merged a chunked candidate to its highest-scoring chunk (D29 per-file best chunk; plan §5 chunk merge: the result carries chunks and best_lines), so this only records which chunk decided and a fragment score is not read as the whole file (qs.mjs:829-840).
      const meta = ctx.chunks?.[keys[k]!];
      // WHY confidence ?? null: SCORE_POLICY keeps DEFAULT_POLICY confidence coerce-null (plan §6 table, confidence row; l1/validate.ts SCORE_POLICY), so a score without a usable confidence is still ranked.
      ranked.push({ id, score: s.score, relevance: s.score / MAX_LEVEL, confidence: s.confidence ?? null, headCut, ...(meta !== undefined && meta.chunks > 1 ? { chunk: { chunks: meta.chunks, ...(meta.best_lines ? { bestLines: meta.best_lines } : {}) } } : {}) });
    });
    // Array.sort is stable, so equal scores keep the input order.
    // WHY >= and not >: keep-at is the lowest relevance that stays (its help says "below this" is dropped), so a candidate exactly at the threshold is kept; the default 0 then keeps every candidate (inferred from the thresholds definition).
    const kept = ranked.sort((x, y) => y.score - x.score).filter((r) => r.relevance >= t["keep-at"]);
    return { rows: i.all ? kept : kept.slice(0, t.top), total: ranked.length, invalid };
  },
  // Plan §9: invalid only.
  attention: (r) => r.invalid.length > 0,
  renderText,
};
