// SP-04 (TRDD-NGXUX45F), plan §9 `classify find` (jev-mcp find + quicksilver find): pick the best candidate (JSON mode) or the matching lines of files (file-line mode). `top` has two meanings: ranked candidates in json mode, listed lines in files mode. Question text is our own wording (D17); rules from the plan row, quicksilver 0.3.0 cmdFind and the card. JSON mode follows jev-mcp jev_find (server.ts:504-572, lib.ts:112-126): the verdict rests on the exists probability alone (plan row: "best/exists, 0.7/0.35", attention "exists != answered").
import { z } from "zod";
import { choice, noul } from "../l1/questions.js";
import { DEFAULT_POLICY, type NoulAnswer } from "../l1/validate.js";
import type { ChoiceAnswer } from "../l1/validate-choice.js";
import { CHUNK_CHARS_DEFAULT, chunkText } from "../l2/chunker.js";
import { IdError, indexKey } from "../l2/ids.js";
import { PolicyError } from "../l2/policy-kit.js";
import { dataGuard, NONE, positionalIds, renumberByPosition } from "./shared.js";
import type { Answers, Built, BuiltUnit, DecisionSpec, Thresholds } from "./spec.js";

const findInputSchema = z
  .object({
    query: z.string().min(1),
    // json: items are candidates (best + exists over all of them); files: items are file texts searched line by line.
    mode: z.enum(["json", "files"]).default("json"),
    items: z.array(z.object({ id: z.string().optional(), text: z.string() })).min(1),
  })
  .superRefine((v, ctx) => {
    try {
      itemIds(v);
    } catch (e) {
      if (!(e instanceof IdError)) throw e;
      ctx.addIssue({ code: "custom", message: e.message });
    }
    // Why refuse: a job with no line has no question, and the planner would fail later with a message about questions instead of the input.
    // Why 2..250: a choice needs two options, and jev-mcp caps candidates at 250, the Choice option limit (jev-mcp lib.ts:6 MAX_CANDIDATES = 250, enforced by candidatesSchema .min(1).max(MAX_CANDIDATES) at server.ts:164; min(1) there because it has no 2-option need, ours does). The plan row sets no bound. The real ceiling is the request size: the planner refuses when the candidates do not fit in one request.
    if (v.mode === "json" && (v.items.length < 2 || v.items.length > 250)) ctx.addIssue({ code: "custom", message: "json mode needs 2 to 250 candidates (2: a choice needs two options; 250: jev-mcp's cap; the real ceiling is the request size, the planner refuses candidates that do not fit in one request)" });
    if (v.mode === "files" && !v.items.some((it) => fileLines(it.text).length > 0)) ctx.addIssue({ code: "custom", message: "the files have no non-blank line to search" });
  });

export type FindInput = z.output<typeof findInputSchema>;

// D14: caller ids are checked in json mode; in files mode the id is a path label, so only uniqueness is required. A missing id is its position.
// D14: see positionalIds.
function itemIds(i: Pick<FindInput, "mode" | "items">): string[] {
  return positionalIds(i.items, i.mode);
}

export interface FindHit { id: string; line: number; text: string; score: number }
export interface FindResult {
  mode: "json" | "files";
  /** answered / partial / absent are answers (json: by the exists probability; files: answered iff a line scored, else absent); invalid means no usable answer at all. */
  status: "answered" | "partial" | "absent" | "invalid";
  /** json mode: candidates by best-choice probability, descending, ties in input order, cut by top. */
  ranked: { id: string; probability: number }[];
  /** json mode: the best answer was a tie between its top two candidates; raises attention even when answered. */
  tie: boolean;
  /** json mode: p(a candidate matches). */
  exists: number | null;
  /** files mode: matching lines, best first. */
  hits: FindHit[];
  /** Questions whose answer was refused, by question key. */
  invalid: { key: string; reason: string }[];
}

const quoted = (q: string): string => `The query is: ${JSON.stringify(q)}.`;

// Plan §9 / E129 (qs I:1075-1120): non-blank lines keyed by 1-based number; a line longer than one chunk is cut into pieces keyed N, N.2, N.3, ... that all map back to line N.
// Why the constant: build() cannot see the run's --chunk-chars, so pieces and chunks are bounded by the default; a smaller planner chunk-chars would make the planner refuse (never cut) an oversized chunk.
function fileLines(text: string): { n: string; text: string }[] {
  const out: { n: string; text: string }[] = [];
  text.split(/\r?\n/).forEach((line, idx) => {
    if (line.trim() === "") return;
    chunkText(line, CHUNK_CHARS_DEFAULT).forEach((piece, p) => out.push({ n: p === 0 ? String(idx + 1) : `${idx + 1}.${p + 1}`, text: piece.text }));
  });
  return out;
}

interface LineChunk { file: string; lines: { n: string; text: string }[] }

// A request chunk holds at most --chunk lines and CHUNK_CHARS_DEFAULT characters, so it fits Jev's context; build and project both call this, so the keys they derive agree.
function lineChunks(i: FindInput, t: Thresholds): LineChunk[] {
  const ids = itemIds(i);
  const out: LineChunk[] = [];
  i.items.forEach((it, f) => {
    let cur: LineChunk["lines"] = [];
    let size = 0;
    for (const l of fileLines(it.text)) {
      if (cur.length > 0 && (cur.length >= t.chunk || size + l.text.length > CHUNK_CHARS_DEFAULT)) {
        out.push({ file: ids[f]!, lines: cur });
        cur = [];
        size = 0;
      }
      cur.push(l);
      size += l.text.length;
    }
    if (cur.length > 0) out.push({ file: ids[f]!, lines: cur });
  });
  return out;
}

function assertCounts(t: Thresholds, mode: "json" | "files"): void {
  // Why json only: answered/absent are not used in files mode, which must not be refused for flags it ignores.
  if (mode === "json" && t.answered < t.absent) throw new PolicyError(`--answered (${t.answered}) must be at least --absent (${t.absent})`);
  for (const name of ["top", "chunk"] as const) if (!Number.isInteger(t[name])) throw new PolicyError(`--${name} must be a whole number, got ${t[name]}`);
}

// Why rewrite by position: the planner packs units into requests and a state wire is {shared, units:[...]}, so `units[i]` must name the unit's place inside ITS request, whatever the job-wide index was.
// Both modes ask a fixed set of keys; any other set means an answer was lost or invented, and a partial silent result would be worse than stopping.
function assertKeys(answers: Answers, expected: string[]): void {
  const got = Object.keys(answers);
  if (got.length !== expected.length || !expected.every((k) => Object.hasOwn(answers, k))) {
    throw new Error(`internal error: find answers are (${got.join(", ")}) but the questions asked were (${expected.join(", ")})`);
  }
}

export const spec: DecisionSpec<FindInput, FindResult> = {
  id: "find",
  // IN-01: files mode searches each file line by line; --lines is refused because the lines are the unit of the search itself (qs forces it off).
  cli: { positional: [{ name: "query", field: "query" }], itemsField: "items", fixed: { mode: "files" }, lines: false },
  input: findInputSchema,
  thresholds: {
    answered: { default: 0.7, min: 0, max: 1, help: "--answered: json mode, lowest exists probability that counts as answered" },
    absent: { default: 0.35, min: 0, max: 1, help: "--absent: json mode, exists probability below this is absent (between absent and answered is partial)" },
    "min-score": { default: 0.05, min: 0, max: 1, help: "--min-score: file mode, drop lines scoring below this" },
    top: { default: 5, min: 1, max: 100000, help: "--top: how many ranked candidates (json) or lines (files) to list" },
    chunk: { default: 150, min: 1, max: 250, help: "--chunk: file mode, lines per request" },
  },
  split: "per-item",
  // Plan §9: the query stays in the instructions; the candidates and lines are in state.
  injection: "params-in-instructions",
  validation: DEFAULT_POLICY,
  // Why the explicit type: the two modes return different literal shapes (unsplittable best/exists vs {}), which only unify as Built.
  build(i, t): Built {
    assertCounts(t, i.mode);
    if (i.mode === "json") {
      const ids = itemIds(i);
      // Why unsplittable: best picks among ALL candidates, so one request must hold them all; the planner refuses (never splits) if they do not fit.
      // Why no `none` option: the exists noul answers "does any candidate match", as in jev-mcp; best only orders the candidates.
      const criteria = Object.fromEntries(ids.map((_, k) => [`u${k}`, `units[${k}]`]));
      return {
        sharedState: null,
        units: i.items.map((it, k) => ({ kind: "atomic" as const, state: { id: ids[k], text: it.text }, questions: {} })),
        unsplittable: {
          best: choice(`${quoted(i.query)} Which unit in \`units\` best matches the query? Answer with its option. ${dataGuard("the content of the units")}`, criteria),
          exists: noul(`${quoted(i.query)} Does any unit in \`units\` match the query? ${dataGuard("the content of the units")}`),
        },
      };
    }
    const units: BuiltUnit[] = lineChunks(i, t).map((c, g) => ({
      kind: "atomic",
      state: { file: c.file, lines: c.lines },
      // Why per-unit questions: a unit's questions always travel with it, which is the "per request" guarantee; each chunk needs its own line keys, so where/exists cannot be shared.
      questions: {
        [indexKey("where", g)]: choice(
          `${quoted(i.query)} Which line in \`units[${g}].lines\` best matches the query? Answer with the line's n value, or none if no line matches. ${dataGuard("the line text")}`,
          Object.fromEntries([...c.lines.map((l) => [l.n, null]), [NONE, "No line matches the query."]]),
        ),
        [indexKey("exists", g)]: noul(`${quoted(i.query)} Does any line in \`units[${g}].lines\` match the query? ${dataGuard("the line text")}`),
      },
    }));
    return { sharedState: null, units, unsplittable: {}, renumber: renumberByPosition };
  },
  project(answers, i, t) {
    assertCounts(t, i.mode);
    if (i.mode === "json") {
      assertKeys(answers, ["best", "exists"]);
      const b = answers.best!;
      const e = answers.exists!;
      const invalid: FindResult["invalid"] = [];
      if (!b.ok) invalid.push({ key: "best", reason: b.reason });
      if (!e.ok) invalid.push({ key: "exists", reason: e.reason });
      if (!b.ok || !e.ok) return { mode: "json", status: "invalid", ranked: [], tie: false, exists: e.ok ? (e.answer as NoulAnswer).noul : null, hits: [], invalid };
      const pick = b.answer as ChoiceAnswer;
      const exists = (e.answer as NoulAnswer).noul;
      const ids = itemIds(i);
      // Probabilities are required by the policy, so they are present here.
      // jev-mcp existsVerdict (lib.ts:112): >= answered is answered, < absent is absent, between is partial. Array.sort is stable, so ties keep input order (rankCandidates).
      // Why check: an absent probability would be NaN in the sort and rank that candidate arbitrarily.
      const missing = ids.findIndex((_, k) => pick.probabilities?.[`u${k}`] === undefined);
      if (missing >= 0) return { mode: "json", status: "invalid", ranked: [], tie: false, exists, hits: [], invalid: [{ key: "best", reason: `no probability for candidate ${ids[missing]}` }] };
      const ranked = ids.map((id, k) => ({ id, probability: pick.probabilities![`u${k}`]! })).sort((x, y) => y.probability - x.probability).slice(0, t.top);
      return { mode: "json", status: exists >= t.answered ? "answered" : exists < t.absent ? "absent" : "partial", ranked, tie: pick.tie, exists, hits: [], invalid };
    }
    const chunks = lineChunks(i, t);
    assertKeys(answers, chunks.flatMap((_, g) => [indexKey("where", g), indexKey("exists", g)]));
    const found: FindHit[] = [];
    const invalid: FindResult["invalid"] = [];
    let valid = 0;
    chunks.forEach((c, g) => {
      const w = answers[indexKey("where", g)]!;
      const e = answers[indexKey("exists", g)]!;
      if (!w.ok) invalid.push({ key: indexKey("where", g), reason: w.reason });
      if (!e.ok) invalid.push({ key: indexKey("exists", g), reason: e.reason });
      // Why both: a line scores p(where) x p(exists), so a chunk missing either answer has no score at all.
      if (!w.ok || !e.ok) return;
      valid++;
      const exists = (e.answer as NoulAnswer).noul;
      const text = new Map(c.lines.map((l) => [l.n, l.text]));
      for (const [n, p] of Object.entries((w.answer as ChoiceAnswer).probabilities!)) {
        if (n !== NONE) found.push({ id: c.file, line: Number(n.split(".")[0]), text: text.get(n)!, score: p * exists });
      }
    });
    // qs order: min-score, sort best first (stable), then one hit per file line (pieces of one line, and overlapping pieces, report it once), then top.
    const seen = new Set<string>();
    const hits = found
      .filter((h) => h.score >= t["min-score"])
      .sort((x, y) => y.score - x.score)
      .filter((h) => {
        const key = `${h.id}\u0000${h.line}`;
        return !seen.has(key) && seen.add(key);
      })
      .slice(0, t.top);
    return { mode: "files", status: hits.length > 0 ? "answered" : valid === 0 ? "invalid" : "absent", ranked: [], tie: false, exists: null, hits, invalid };
  },
  // Plan §9: exists other than answered, invalid, no lines; plus a tie in the best answer (review round 2).
  attention: (r) => r.status !== "answered" || r.invalid.length > 0 || r.tie,
};
