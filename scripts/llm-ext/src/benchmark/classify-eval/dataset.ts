// classify-eval dataset format (plan §11, §16 EV-01): one jsonl file per decision spec, `<dir>/<specId>.jsonl`, one labelled item per line.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getSpec } from "../../classifiers/catalog/index.js";

/** One labelled item: `input` is the spec's own input object, `expected` the label the metrics (EV-05) compare the projected result to. */
export interface EvalRecord { id: string; input: unknown; expected: unknown }
export interface EvalDataset { specId: string; records: EvalRecord[]; fingerprint: string }

// WHY hash the record lines, not the file bytes: the plan (§11) only says "dataset/fingerprint", so the fingerprint must identify the dataset content; CRLF checkouts (RL-08), a trailing newline or blank lines must not change it. Same sha1/12-hex form as security-triage's byte hash. WK-02's workload-kit does not exist yet and no shared helper is exported; the kit's step replaces this copy.
export function datasetFingerprint(recordLines: readonly string[]): string {
  return createHash("sha1").update(recordLines.join("\n")).digest("hex").slice(0, 12);
}

// WHY fail at load: a malformed line found mid-run would be paid for in Jev calls before it surfaced; the input is checked against the spec's own zod schema so a spec change invalidates stale items loudly.
export function loadDataset(dir: string, specId: string): EvalDataset {
  const spec = getSpec(specId);
  const file = join(dir, `${specId}.jsonl`);
  const bytes = readFileSync(file, "utf-8");
  const fail = (line: number, msg: string): never => { throw new Error(`${file}:${line}: ${msg}`); };
  const ids = new Set<string>();
  const records: EvalRecord[] = [];
  const recordLines: string[] = [];
  bytes.split("\n").forEach((raw, i) => {
    const text = raw.replace(/\r$/, "");
    if (text.trim() === "") return;
    recordLines.push(text);
    let row: unknown;
    try { row = JSON.parse(text); } catch { return fail(i + 1, "not valid JSON"); }
    if (typeof row !== "object" || row === null || Array.isArray(row)) return fail(i + 1, "record must be a JSON object");
    const r = row as Record<string, unknown>;
    const extra = Object.keys(r).filter((k) => k !== "id" && k !== "input" && k !== "expected");
    if (extra.length > 0) fail(i + 1, `unknown field "${extra[0]}" (allowed: id, input, expected)`);
    if (typeof r.id !== "string" || r.id === "") fail(i + 1, "id must be a non-empty string");
    if (ids.has(r.id as string)) fail(i + 1, `duplicate id "${String(r.id)}"`);
    if (!("expected" in r)) fail(i + 1, "expected is required");
    const parsed = spec.input.safeParse(r.input);
    if (!parsed.success) fail(i + 1, `input rejected by spec "${specId}": ${parsed.error.message}`);
    ids.add(r.id as string);
    records.push({ id: r.id as string, input: r.input, expected: r.expected });
  });
  if (records.length === 0) throw new Error(`${file}: dataset has no records`);
  return { specId, records, fingerprint: datasetFingerprint(recordLines) };
}
