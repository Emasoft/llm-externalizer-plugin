// IN-01 (design note EVORI1LK section 3): turns the file-mode words of a command line (positionals, --items, --lines, ...) into the JSON input of a spec that declares `cli`.
// WHY its own module: run-decision.ts is already over 300 lines and parses flags; the assembly is the ONLY caller of collectInputs, so one reader serves every command.
import { classifyCliUsage, type AnySpec, type SpecFlag } from "./catalog/spec.js";
import { existsSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { HARD_MAX_BYTES, collectInputs, readForJev, type CollectOptions } from "./l2/inputs.js";
import { InputError } from "./l2/input-error.js";
import { INPUT_FLAGS } from "./shared-flags.js";

export interface FileInput {
  input: Record<string, unknown>;
  /** The reader's warnings plus one `skipped <path>: <reason>` per file it left out (E123: skipped files are listed, never dropped silently). */
  warnings: string[];
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);


/**
 * IN-02: the value of a spec-declared flag. `@file` goes through readForJev, so a directory (E41), a secret (E36), a binary or an empty file (E40) is refused exactly as for any other named input.
 * WHY here and not in the flag's own parse: parse is a pure string function of the catalog layer; the file read belongs to the input layer, once, for every spec.
 */
export async function readSpecFlag(flag: SpecFlag, raw: string, readStdin: () => Promise<Buffer>): Promise<unknown> {
  if (flag.file === true) {
    // WHY collectInputs for stdin, readForJev for a path: the same two readers as the document input (assembleDocument), so binary, empty, secret and over-size inputs are refused alike.
    const text = raw === "-" ? (await collectInputs(["-"], { stdin: await readStdin() })).items[0]!.text : (await readForJev(raw, { kind: "whole" })).text;
    return flag.parse(text);
  }
  return flag.parse(flag.atFile === true && raw.startsWith("@") ? (await readForJev(raw.slice(1), { kind: "whole" })).text : raw);
}

/**
 * IN-02: writes the spec-flag values onto the input, in file mode and in JSON mode alike. WHY refused when the input already holds the field: two sources for one field would leave it unclear which one ran (the same rule as --input with files).
 * `fields` maps an input field to the flag that set it and the parsed value.
 */
export function overlaySpecFields(input: unknown, fields: ReadonlyMap<string, { flag: string; value: unknown }>): unknown {
  if (fields.size === 0) return input;
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new InputError(`the JSON input must be an object to take ${[...fields.values()].map((f) => f.flag).join(" and ")}`);
  const out = { ...(input as Record<string, unknown>) };
  for (const [field, { flag, value }] of fields) {
    if (Object.hasOwn(out, field)) throw new InputError(`${flag} sets ${field}, which the JSON input already holds; give it in one place`);
    out[field] = value;
  }
  return out;
}

/**
 * IN-06: the one text of a `document` command (test-output): a named file, or `-` for stdin. Every refusal of a named file (missing, directory, secret, binary, empty) comes from readForJev, the same reader as every other named input.
 * Over-size is the exception (review of 3e281b35, finding 11): a file over the cap keeps its TAIL and says on stderr how many bytes were dropped, instead of being refused.
 * WHY only --max-bytes is accepted: the other collect options (--items, --lines, --ext, --limit, --follow-symlinks) describe a list of items, and this command has exactly one text; ignoring them would run on an input the user did not mean.
 * WHY readStdin is called only for `-`: an unconditional read would hang a command that names a file.
 */
async function assembleDocument(spec: AnySpec, field: string, positionals: readonly string[], options: CollectOptions, readStdin: () => Promise<Buffer>, note?: (line: string) => void): Promise<FileInput> {
  const { maxBytes, ...others } = options;
  const unsupported = Object.entries(others).filter(([, v]) => v !== undefined).map(([k]) => INPUT_FLAGS.find((f) => f.option === k)?.flag ?? k);
  if (unsupported.length > 0) throw new InputError(`classify ${spec.id} takes one file or - (stdin); ${unsupported.join(", ")} not supported (only --max-bytes applies)`);
  if (positionals.length !== 1) throw new InputError(`usage: ${classifyCliUsage(spec)!}`);
  const named = positionals[0]!;
  if (named === "-") {
    // WHY collectInputs for stdin: it already refuses binary, empty and over-size stdin and redacts secrets; nothing is duplicated here.
    const got = await collectInputs(["-"], { stdin: await readStdin(), ...(maxBytes === undefined ? {} : { maxBytes }) });
    return { input: { [field]: got.items[0]!.text }, warnings: got.warnings };
  }
  // WHY the tail mode of readForJev (review of 3e281b35, finding 11): one guard sequence and one open for the whole and the tail read. WHY tailing needs --max-bytes: without it a log over the hard cap is refused with a hint, so a huge log is never silently cut.
  const snippet = await readForJev(named, { kind: "tail" }, maxBytes === undefined ? {} : { maxBytes });
  if (snippet.droppedBytes === undefined) return { input: { [field]: snippet.text }, warnings: snippet.warnings };
  const message = `${named}: over ${maxBytes} bytes; kept the last ${Buffer.byteLength(snippet.text, "utf8")} bytes and dropped ${snippet.droppedBytes} bytes from the start`;
  note?.(message);
  return { input: { [field]: snippet.text }, warnings: [...snippet.warnings, message] };
}

/**
 * IN-06: fills the spec `fileSources.into` field (findings: `sources`) by reading, whole, each distinct file the JSON input names (`findings[].file`), in first-seen order.
 * WHY left untouched when the JSON already carries the field: the caller supplied the texts (a pipeline that read the files itself); reading again could contradict them.
 * WHY a missing or unusable file refuses the whole run and does not become the spec `file_not_supplied` row: from the command line the user named that path, and a typo would otherwise produce a quiet keep_low verdict that looks like a judgement; the pure runner path (sources supplied by the caller) keeps E71.
 * WHY a non-array list or a record without a string file is left for the input schema to refuse with its own message.
 * WHY `allowedDirs` (review round 2, major 1): the paths are DATA, written by another tool or a model, not typed by the user. The general input guard allows the whole home directory, which would let a findings JSON send ~/.config/gh/hosts.yml or a shell history; here a path must resolve (symlinks followed) inside the current directory or the directory of the --input file. No flag widens this. The caller passes the directories, so the rule cannot be skipped by omission.
 * WHY a total cap (review finding 10): the per-file cap alone lets a JSON that names many files send them all; the sum of the texts is held to HARD_MAX_BYTES, the same ceiling one file has. `totalCapBytes` is a parameter only so the refusal is testable without 100 MB of files.
 * `note` prints one line per file read, so the user sees which files left the machine; control characters and escape sequences in the path are removed first, because the path is data and could otherwise write terminal commands to the user's screen.
 */
export async function readFileSources(spec: AnySpec, input: unknown, allowedDirs: readonly string[], opts: { note?: (line: string) => void; totalCapBytes?: number } = {}): Promise<{ input: unknown; warnings: string[] }> {
  const fs = spec.fileSources;
  if (fs === undefined || input === null || typeof input !== "object" || Array.isArray(input) || Object.hasOwn(input, fs.into)) return { input, warnings: [] };
  const list = (input as Record<string, unknown>)[fs.list];
  if (!Array.isArray(list)) return { input, warnings: [] };
  const files = [...new Set(list.flatMap((r) => (r !== null && typeof r === "object" && typeof (r as Record<string, unknown>)[fs.fileKey] === "string" && (r as Record<string, string>)[fs.fileKey] !== "" ? [(r as Record<string, string>)[fs.fileKey]!] : [])))];
  if (files.length === 0) return { input, warnings: [] };
  const roots = allowedDirs.map((d) => realpathSync(d));
  const cap = opts.totalCapBytes ?? HARD_MAX_BYTES;
  let total = 0;
  const warnings: string[] = [];
  const sources: { file: string; text: string }[] = [];
  for (const file of files) {
    // WHY existsSync first: a missing file keeps its own "no such file" refusal (readForJev), and realpath of it would throw a system error.
    if (existsSync(file)) {
      const real = realpathSync(resolve(file));
      if (!roots.some((r) => real === r || real.startsWith(r + sep))) throw new InputError(`${printable(file)} is outside the directories a findings file may name: ${roots.join(", ")} (the current directory and the directory of --input); move or copy it there`);
    }
    const s = await readForJev(file, { kind: "whole" });
    total += Buffer.byteLength(s.text, "utf8");
    if (total > cap) throw new InputError(`the files named in ${fs.list} total over ${cap} bytes (stopped at ${printable(file)}); name fewer files`);
    opts.note?.(`read ${printable(file)} (${Buffer.byteLength(s.text, "utf8")} bytes) to send`);
    warnings.push(...s.warnings);
    sources.push({ file, text: s.text });
  }
  return { input: { ...(input as Record<string, unknown>), [fs.into]: sources }, warnings };
}

// Escape sequences first (so their parameters go with them), then every remaining C0 control, DEL and C1 control.
// eslint-disable-next-line no-control-regex
const printable = (p: string): string => p.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)?/g, "").replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
/**
 * `positionals` are the non-flag tokens in order: the first `cli.positional.length` fill the spec's own fields, the rest are the inputs for collectInputs.
 * WHY stdin is read only on demand: an unconditional read would hang a command that names only files.
 * Every refusal is an InputError, which the caller prints as `llm-ext: <message>` with exit 1.
 */
export async function assembleFileInput(spec: AnySpec, positionals: readonly string[], options: CollectOptions, readStdin: () => Promise<Buffer>, note?: (line: string) => void): Promise<FileInput> {
  const cli = spec.cli;
  // WHY refuse, not ignore: a spec with no mapping cannot know where files would go, and a silently ignored argument would run on the wrong input.
  if (cli === undefined) throw new InputError(`classify ${spec.id} does not take file inputs yet; pass --input <file.json> or JSON on stdin`);
  if ("document" in cli) return assembleDocument(spec, cli.document.field, positionals, options, readStdin, note);
  if (cli.lines === false && options.lines === true) throw new InputError(`classify ${spec.id} searches the lines of each file itself; --lines is not supported`);
  if (positionals.length < cli.positional.length) {
    throw new InputError(`usage: ${classifyCliUsage(spec)!}`);
  }
  const fields = Object.fromEntries(cli.positional.map((p, k) => [p.field, positionals[k]!]));
  const specs = positionals.slice(cli.positional.length);
  // WHY refused: stdin can be read once, so `-` and `--items -` would both get the same bytes (or the second an empty read) and the user would not know which input ran.
  if (specs.includes("-") && options.items === "-") throw new InputError("`-` and `--items -` both read stdin, which can be read once; use one of them");
  const collected = await collectInputs(specs, { ...options, ...(specs.includes("-") || options.items === "-" ? { stdin: await readStdin() } : {}) });
  if (collected.items.length === 0) {
    // qs requireInputs wording: say which inputs were skipped and why, else how to name inputs.
    const s = collected.skipped;
    // WHY clip at 400: a glob or directory can skip thousands of paths, and the whole list would bury the one-line error; 400 characters still names the first several paths with their reasons. Same cap as quicksilver's requireInputs (qs.mjs), whose wording this message ports (TRDD-XHHH0N1E).
    throw new InputError(s.length > 0
      ? `nothing to ${spec.id}: ${s.length} input${s.length > 1 ? "s" : ""} skipped (${clip(s.map((x) => `${x.path}: ${x.reason}`).join(", "), 400)})`
      // WHY the note: any word on the command line selects file mode, where JSON on stdin is not read; a user who piped JSON would otherwise see only "pass files".
      : `nothing to ${spec.id}: pass files, directories, globs, --items FILE, or - for stdin (words on the command line select file mode; JSON on stdin is not read in file mode)`);
  }
  return {
    input: { ...fields, [cli.itemsField]: collected.items, ...cli.fixed },
    warnings: [...collected.warnings, ...collected.skipped.map((x) => `skipped ${x.path}: ${x.reason}`)],
  };
}
