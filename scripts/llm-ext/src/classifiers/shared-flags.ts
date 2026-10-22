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
export interface BooleanFlag extends FlagBase { type: "boolean"; sets: "strictExit" }
export type SharedFlag = ValueFlag | BooleanFlag;

export const SHARED_FLAGS: readonly SharedFlag[] = [
  { flag: "--input", property: "input", type: "string", help: "Path of the JSON input file; without it the JSON is read from stdin." },
  { flag: "--profile", property: "profile", type: "string", help: "Classifier profile to run on (default: the active classifier profile)." },
  { flag: "--max-budget", property: "max_budget", type: "number", help: "Opt-in spend cap in USD; a run whose estimate exceeds it is refused and a running one stops at it." },
  { flag: "--chunk-chars", property: "chunk_chars", type: "number", help: "Size in characters at which a long text item is split into chunks." },
  { flag: "--default", property: "default", type: "string", help: "Default label of every choice question over text; a chunk whose top label is the default does not vote." },
  { flag: "-o", property: "output_dir", type: "string", help: "Directory for the JSON report (same text as stdout)." },
  { flag: "--strict-exit", property: "strict_exit", type: "boolean", help: "Exit non-zero when the result needs attention.", sets: "strictExit" },
];

// IN-01: the file-input flags of the classify commands whose spec declares `cli` (catalog/spec.ts); quicksilver's input options, ported as collectInputs options.
// WHY `option` names the CollectOptions key: run-decision.ts and input-args.ts copy a parsed flag into it without a per-flag branch, so a flag cannot be declared and then silently dropped.
// WHY a union on `type`: each flag's `option` is then typed by its value type, so run-decision.ts assigns a parsed value to a typed CollectOptions with no cast.
export type InputFlag =
  | (FlagBase & { type: "string"; option: "items" | "ext" })
  | (FlagBase & { type: "number"; option: "limit" | "maxBytes" })
  | (FlagBase & { type: "boolean"; option: "lines" | "followSymlinks" });
export type BooleanInputFlag = Extract<InputFlag, { type: "boolean" }>;


// Help sentences checked against l2/inputs.ts: --items 332-337, --lines pushLines 328-330, --ext 354 (file loop only), --limit 325, --max-bytes 146/305 (named file and stdin refused) and 373 (walked file skipped), --follow-symlinks 223-231 and 356-362.
export const INPUT_FLAGS: readonly InputFlag[] = [
  { flag: "--items", property: "items", type: "string", option: "items", help: "JSONL file of items ({\"id\",\"text\"} per line, or plain lines); - reads stdin." },
  { flag: "--lines", property: "lines", type: "boolean", option: "lines", help: "Judge each non-blank line of every input as its own item (ids name:N)." },
  { flag: "--ext", property: "ext", type: "string", option: "ext", help: "Only files with these extensions, comma separated (ts,tsx); applies to files found from the inputs, not to --items or stdin." },
  { flag: "--limit", property: "limit", type: "number", option: "limit", help: "Refuse to run on more items than this, a whole number of 1 or more (default 5000)." },
  { flag: "--max-bytes", property: "max_bytes", type: "number", option: "maxBytes", help: "Files over this many bytes are skipped and listed; an --items file or stdin over it is refused. A whole number from 1 to 104857600 (the 100 MB cap)." },
  { flag: "--follow-symlinks", property: "follow_symlinks", type: "boolean", option: "followSymlinks", help: "Read the targets of symlinks instead of skipping the links; a broken link or a target outside the allowed roots is still skipped and listed." },
];


// Help sentences checked against l2/inputs.ts: --items 331-335, --lines pushLines 326-328, --ext 354 (file loop only), --limit 325, --max-bytes 146/305 (named file, stdin refused) and 373 (walked file skipped), --follow-symlinks 223-231 and 356-362.
