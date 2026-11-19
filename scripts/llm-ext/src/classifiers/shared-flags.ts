// C4-02 (TRDD-V8Q20MLW): the shared (non-threshold) flags of every classify command; a leaf module with NO imports.
// WHY a leaf: tools/definitions.ts is loaded at every CLI start and must not drag the runner (transport, fan-out, planner, report) in just to list these flags.
// WHY one list: definitions.ts builds the entries' shared flags from it and run-decision.ts parses from it, so the declared flags and the parser cannot drift.
interface FlagBase {
  flag: string;
  /** The tool-schema property this flag maps to. */
  property: string;
  help: string;
}
export interface ValueFlag extends FlagBase { type: "string" | "number" }
// WHY `sets` is required by type: a boolean flag must name the RunRequest field it turns on, so a second boolean flag can never silently enable strict exit and the parser needs no runtime check.
export interface BooleanFlag extends FlagBase { type: "boolean"; sets: "strictExit" | "json" | "estimate" }
export type SharedFlag = ValueFlag | BooleanFlag;

export const SHARED_FLAGS: readonly SharedFlag[] = [
  { flag: "--input", property: "input", type: "string", help: "Path of the JSON input file; without it the JSON is read from stdin." },
  { flag: "--profile", property: "profile", type: "string", help: "Classifier profile to run on (default: the active classifier profile)." },
  { flag: "--max-budget", property: "max_budget", type: "number", help: "Opt-in spend cap in USD; a run whose estimate exceeds it is refused and a running one stops at it." },
  { flag: "--chunk-chars", property: "chunk_chars", type: "number", help: "Size in characters at which a long text item is split into chunks." },
  // TRDD-LFTQCFUX: the planner already takes maxQuestionsPerRequest (l2/planner.ts LimitsInput); this flag is the only way a command line sets it. WHY a shared flag: the cap bounds every classify command, and run-decision.ts reads it from this list like --chunk-chars. WHY two sentences: cli/main.ts firstLine prints only the first line and cuts it past 96 characters, so the first line carries the cost (more requests) and the second the refusal (planner.ts unit-too-many-questions: a cap below the questions of one unit refuses every unit).
  { flag: "--max-questions-per-request", property: "max_questions_per_request", type: "number", help: "Most questions per request (whole number, 1 or more); a low cap multiplies the request count.\nA value below the questions of one unit is refused for the whole run (rule-check asks 2 per rule, so 1 is refused)." },
  { flag: "--default", property: "default", type: "string", help: "Default label of every choice question over text; a chunk whose top label is the default does not vote." },
  { flag: "-o", property: "output_dir", type: "string", help: "Directory for the JSON report (the JSON envelope, as --json prints it)." },
  { flag: "--strict-exit", property: "strict_exit", type: "boolean", help: "Exit non-zero when the result needs attention.", sets: "strictExit" },
  // IN-07 (Q4): text is the default stdout of a command whose spec has a text form; --json prints the envelope unchanged. WHY a shared flag: every command takes it, whatever its spec.
  { flag: "--json", property: "json", type: "boolean", help: "Print the JSON envelope instead of the text form.", sets: "json" },
  // TRDD-58CFBQHN: the dry run of every decision command, listed here so their --help shows it: help rows come from this list (tools/definitions.ts) and the parser reads it back (run-decision.ts), so a flag the help prints is a flag the parser sets, with no second declaration to drift. `classify ping` reads PING_FLAGS, not this list, and the launcher refuses --estimate and --preview for it, so its help rightly shows neither; --preview is refused for every classify command (launcher.ts runClassifyCommand) and stays out. The sentence is checked against estimate-output.ts (it prints the estimated input cost and says it is an estimate, not a ceiling) and run-decision.ts (the run returns before the first request); it is under 96 characters because cli/main.ts firstLine cuts a longer help row with "...", which would hide "nothing is sent".
  { flag: "--estimate", property: "estimate", type: "boolean", help: "Dry run: print the estimated input cost (an estimate, not a ceiling); nothing is sent to Jev.", sets: "estimate" },
];

// IN-01: the file-input flags of the classify commands whose spec declares `cli` (catalog/spec.ts); quicksilver's input options, ported as collectInputs options.
// WHY `option` names the CollectOptions key: run-decision.ts and input-args.ts copy a parsed flag into it without a per-flag branch, so a flag cannot be declared and then silently dropped.
// WHY a union on `type`: each flag's `option` is then typed by its value type, so run-decision.ts assigns a parsed value to a typed CollectOptions with no cast.
export type InputFlag =
  | (FlagBase & { type: "string"; option: "items" | "ext" })
  | (FlagBase & { type: "number"; option: "limit" | "maxBytes" })
  | (FlagBase & { type: "boolean"; option: "lines" | "followSymlinks" });
export type BooleanInputFlag = Extract<InputFlag, { type: "boolean" }>;


// Help sentences checked against collectInputs and its helpers in l2/inputs.ts (named by symbol, not line, so they cannot go stale): --items (the opts.items branch, parseItems), --lines (pushLines), --ext (the exts filter in the file loop only), --limit (push), --max-bytes (readNamed for a named file or an --items file, stdinText for stdin, and the size skip of a walked file in the file loop), --follow-symlinks (walk, entries, expand and the follow branch in the file loop).
export const INPUT_FLAGS: readonly InputFlag[] = [
  { flag: "--items", property: "items", type: "string", option: "items", help: "JSONL file of items ({\"id\",\"text\"} per line, or plain lines); - reads stdin." },
  { flag: "--lines", property: "lines", type: "boolean", option: "lines", help: "Judge each non-blank line of every input as its own item (ids name:N)." },
  { flag: "--ext", property: "ext", type: "string", option: "ext", help: "Only files with these extensions, comma separated (ts,tsx); applies to files found from the inputs, not to --items or stdin." },
  { flag: "--limit", property: "limit", type: "number", option: "limit", help: "Refuse to run on more items than this, a whole number of 1 or more (default 5000)." },
  { flag: "--max-bytes", property: "max_bytes", type: "number", option: "maxBytes", help: "Files over this many bytes are skipped and listed; an --items file or stdin over it is refused. A whole number from 1 to 104857600 (the 100 MB cap)." },
  { flag: "--follow-symlinks", property: "follow_symlinks", type: "boolean", option: "followSymlinks", help: "Read the targets of symlinks instead of skipping the links; a broken link or a target outside the allowed roots is still skipped and listed." },
];
