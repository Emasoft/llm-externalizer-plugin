// IN-01 (design note EVORI1LK section 3): turns the file-mode words of a command line (positionals, --items, --lines, ...) into the JSON input of a spec that declares `cli`.
// WHY its own module: run-decision.ts is already over 300 lines and parses flags; the assembly is the ONLY caller of collectInputs, so one reader serves every command.
import { classifyCliUsage, type AnySpec, type SpecFlag } from "./catalog/spec.js";
import { collectInputs, readForJev, type CollectOptions } from "./l2/inputs.js";
import { InputError } from "./l2/input-error.js";

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
export async function readSpecFlag(flag: SpecFlag, raw: string): Promise<unknown> {
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
 * `positionals` are the non-flag tokens in order: the first `cli.positional.length` fill the spec's own fields, the rest are the inputs for collectInputs.
 * WHY stdin is read only on demand: an unconditional read would hang a command that names only files.
 * Every refusal is an InputError, which the caller prints as `llm-ext: <message>` with exit 1.
 */
export async function assembleFileInput(spec: AnySpec, positionals: readonly string[], options: CollectOptions, readStdin: () => Promise<Buffer>): Promise<FileInput> {
  const cli = spec.cli;
  // WHY refuse, not ignore: a spec with no mapping cannot know where files would go, and a silently ignored argument would run on the wrong input.
  if (cli === undefined) throw new InputError(`classify ${spec.id} does not take file inputs yet; pass --input <file.json> or JSON on stdin`);
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
