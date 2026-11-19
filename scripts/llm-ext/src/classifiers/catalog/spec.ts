// L3 (plan §3): the DecisionSpec type. Every classify command and browse decision is declared with it; run-decision.ts and the browse loop only read it (plan §4).
import type { ZodType } from "zod";
import type { Question } from "../l1/questions.js";
import type { Invalid, Valid, ValidationPolicy } from "../l1/validate.js";
import type { ChunkMeta } from "../l2/fan-out.js";
import type { ThresholdSpec as ThresholdRange } from "../l2/policy-kit.js";

import type { RenderOptions, TextRender } from "../l2/render-text.js";

// Plan §5 "Partial failure": a failed request makes its units invalid_response (per-item) or fails the whole result (whole-result).
export type SplitClass = "per-item" | "whole-result";

// Plan §4 + D5: untrusted text goes in state referenced by index; short caller parameters may sit in the instructions.
export type Injection = "index-scoped" | "params-in-instructions";

// Plan §4 "default thresholds + ranges": the range is declared here so L2-10 range checks and the docs read one place; `help` is the flags/defaults text §4 gives to the catalog.
export interface ThresholdSpec extends ThresholdRange { help: string }
export type Thresholds = Record<string, number>;

// Plan §5 SplitJob, as the spec produces it: shared state, units with their own state part and questions, and the questions that must travel in one request.
// Derived: §3 names `Built` without defining it; L2-01 should alias its SplitJob input to this shape.
export interface BuiltUnit { kind: "atomic" | "text"; state: unknown; questions: Record<string, Question> }
export interface Built {
  sharedState: unknown;
  units: BuiltUnit[];
  unsplittable: Record<string, Question>;
  // Plan §5: rewrites `claims[i]`-style references when a chunk starts at `offset`.
  renumber?: (units: BuiltUnit[], offset: number) => BuiltUnit[];
  // Optional (review C4-01): set when `build` cut the input (plan §5 truncate-and-flag); the runner forwards it as ProjectCtx.truncated.
  truncated?: boolean;
  /**
   * E65: set to true ONLY by a spec that built zero questions BY DESIGN (extract: every field decided by the regex alone, has an invalid pattern, or lost all its candidates as not verbatim in the cut document; findings: no window could be sent).
   * The runner then calls no model and projects from empty answers. WHY an opt-in flag and not "zero questions means skip": a build that yields no question in any other spec is refused ("nothing to ask for this input (no question was built)"), not returned as a clean result with exit 0.
   */
  noCall?: true;
}

// Derived: §3 names `Answers` without defining it. Per question key: the validated answer, or the reason it was refused (plan §6 answer-set rule).
export type Answers = Record<string, Valid<unknown> | Invalid>;

// Derived: §3 names `ProjectCtx` without defining it. `truncated` is the §5 truncate-and-flag signal behind the incomplete-context policy (auto demoted to review).
export interface ProjectCtx {
  truncated: boolean;
  // Optional (review C4-01): per ORIGINAL question key of a chunked item, how many chunks it had and which lines decided it (quicksilver's "N chunks, best lines A-B").
  chunks?: Record<string, ChunkMeta>;
}


// IN-01: how a command line becomes this spec's JSON input when the user names files instead of passing JSON. Absent = JSON only.
export interface ItemsCli {
  /** Leading positionals of the command line, in order, each written to the input field `field`; the remaining positionals are the inputs (files, directories, globs, -). */
  positional: readonly { name: string; field: string }[];
  /** The input field that receives the collected items [{id, text}]. */
  itemsField: string;
  /** Input fields every file-mode run sets (rank and find: mode "files", so each file travels as its own text unit). */
  fixed?: Record<string, unknown>;
  /** false: --lines is refused (find searches the lines of a file itself). */
  lines?: false;
}


// IN-06: a command whose one input is a single text (test-output: the log). `llm-ext classify <id> FILE` or `-` writes the file (or stdin) whole into `field`; there is no items list, so --items, --lines and the other collect options are refused (only --max-bytes applies).
// WHY a variant and not an ItemsCli with one item: the spec input is a string field, and a list of items would have to be glued back into it.
export interface DocumentCli {
  document: { field: string };
}
export type CliSpec = ItemsCli | DocumentCli;

// IN-06: the JSON input names files (findings: findings[].file) and the command reads them whole into another field when the JSON does not carry it.
// WHY a spec declaration and not `cli`: the user still passes JSON (the findings themselves are structured), so file mode and its flags do not apply.
export interface FileSources {
  /** The input field holding the array of records that name files. */
  list: string;
  /** The key of each record that holds the file path. */
  fileKey: string;
  /** The input field that receives [{file, text}], one per distinct path, in first-seen order. */
  into: string;
}
// IN-02: a flag that belongs to one spec (label: --labels, --labels-json), declared here and parsed by the shared token loop in run-decision.ts, never ad hoc per command.
export interface SpecFlag {
  flag: string;
  /** The tool-schema property this flag maps to (snake_case, like every other tool property). */
  property: string;
  /** The input field the parsed value is written to. Two flags of one spec may share a field: giving both is refused. */
  field: string;
  help: string;
  /** true: a value starting with @ names a file, read with readForJev under the named-file rules (directory, secret, binary, empty refused); `parse` then gets the file text. */
  atFile?: true;
  /** IN-05: the value is the path of a text file, or `-` for stdin (review --claims); `parse` gets its text. WHY not atFile: atFile needs an `@` prefix and accepts a literal; this flag has no literal form, and `-` matches the document input of IN-06. */
  file?: true;
  /** IN-03: boolean takes no value (rank --all); number is advertised as a number in the tool schema. Default: a string value. WHY here: the tool schema and the parser read the one declaration. */
  type?: "boolean" | "number";
  /** IN-07: true = an output option, not an input: the value goes to `renderText` under `field` and never into the JSON input (filter --no-collapse, --save). WHY: the input schema is strict, and a display option must not be accepted or refused by it. */
  render?: true;
  /** Turns the raw value (or file text) into the field value; throws InputError, whose message names the flag. Not called for a boolean flag: the runner sets the field to true itself (run-decision.ts); kept required so a value flag cannot omit it without a cast. */
  parse(raw: string): unknown;
}

export interface DecisionSpec<I, R> {
  id: string;
  /** IN-01: present only when the command accepts files, --items and --lines; every other spec is JSON only. */
  cli?: CliSpec;
  /** IN-06: read the files the JSON input names into `into`, unless the JSON already carries that field (then it is left as given). */
  fileSources?: FileSources;
  /** IN-02/IN-04: the spec's own value flags; they also work with JSON input, where they may not repeat a field the JSON already holds. WHY not under `cli`: `cli` switches on file inputs (runner and tool schema), and check takes --preset but must stay JSON-only. */
  flags?: readonly SpecFlag[];
  input: ZodType<I>;
  thresholds: Record<string, ThresholdSpec>;
  split: SplitClass;
  injection: Injection;
  validation: ValidationPolicy;
  /**
   * Optional async step the runner awaits ONCE, after the cheap flag refusals and the -o check and before `build` (TRDD-XZZ2NSWY). Its result is the input of build, chunkDefaults and project.
   * WHY a spec step and not runner code: only extract needs it (it runs its regexes in a worker, SP-22); the runner stays free of command knowledge. It receives only the abort signal, never how a worker is made.
   */
  prepare?(i: I, t: Thresholds, opts: { signal: AbortSignal }): Promise<I>;
  build(i: I, t: Thresholds): Built;
  /**
   * Default label per CHOICE question key that `build` emits over a TEXT unit (E117): the fan-out merges the chunks of such a unit, and a chunk whose top label is the default does not vote.
   * Keys are the question keys `build` produces. Required exactly when `build` can emit such a question; index.ts `assertChunkDefaults` checks it.
   */
  chunkDefaults?(i: I): Record<string, string>;
  project(answers: Answers, i: I, t: Thresholds, ctx: ProjectCtx): R;
  attention(r: R): boolean;

  /**
   * IN-07 (Q4): the text form printed to stdout unless `--json` is given; the one hook of every per-command text (filter now, label IN-08, rank and find IN-09).
   * Absent = the command prints the JSON envelope. `opts` holds the spec flags declared `render: true`. WHY the decision and not the envelope: a partial-run note, warnings and saved files are added by composeText for every spec alike.
   */
  renderText?(decision: R, opts: RenderOptions): TextRender;

}

// Registry entries are heterogeneous in I and R; the registry only reads the shape-independent fields.
export type AnySpec = DecisionSpec<any, any>;

/**
 * The file-mode command line of a spec that declares `cli`, else undefined (JSON input only). WHY one function: the
 * usage error of input-args.ts and `llm-ext classify <action> --help` print the same line, so the help can never again
 * say the command takes no bare argument while the parser needs the question as one (review before 14.2.0).
 */
export function classifyCliUsage(spec: AnySpec): string | undefined {
  const cli = spec.cli;
  if (cli === undefined) return undefined;
  if ("document" in cli) return `llm-ext classify ${spec.id} <file, - for stdin> [--max-bytes N]`;
  const lead = cli.positional.map((p) => ` "<${p.name}>"`).join("");
  return `llm-ext classify ${spec.id}${lead} <files, directories, globs, - for stdin> [--items FILE]${cli.lines === false ? "" : " [--lines]"}`;
}
