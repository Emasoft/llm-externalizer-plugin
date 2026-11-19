# llm-ext reference: classify group

## Contents

- `llm-ext classify verify`
- `llm-ext classify screen`
- `llm-ext classify filter`
- `llm-ext classify label`
- `llm-ext classify rank`
- `llm-ext classify find`
- `llm-ext classify decide`
- `llm-ext classify compare`
- `llm-ext classify extract`
- `llm-ext classify audit`
- `llm-ext classify review`
- `llm-ext classify check`
- `llm-ext classify findings`
- `llm-ext classify test-output`
- `llm-ext classify requirements`
- `llm-ext classify rule-check`
- Request JSON shapes (`--input` of `classify filter`, `label`, `find`)
- `llm-ext classify ping`

Output: a classify command prints its text form on stdout and the receipt line (items, time, Jev tokens and cost) as the last line. Add `--json` to print the JSON envelope instead; the receipt then goes to stderr, so stdout stays one parseable JSON document. A script that parses the output must pass `--json`. `--estimate` prices the run from the catalog and sends no question to Jev (no API key needed; it writes no `-o` report). It is not offline: unless the files are cached it fetches the public decisions catalog and the model's endpoint prompt limit from openrouter.ai, without a key, and it exits 5 (`llm-ext: decisions catalog unavailable and cache expired: ...`) when the catalog fetch fails and no fresh cache exists. With the `local-decision` profile it needs no key and fetches nothing: the run goes straight to the local decider. The output line reads `classify <action> --estimate: no question was sent` in 14.7.5 and later (`nothing was sent` in 14.3.0 and 14.7.4, meaning the question). `-o <dir>` saves the JSON envelope of every completed run, whichever output form was printed. `classify ping --estimate` is refused with `llm-ext: --estimate is not supported by classify ping, which has no dry run; use --no-call to check the key without asking the question.` (exit 1, this wording ships in 14.7.5 and later); ping does not take `--estimate`, and its help says `--no_call` sends no question.

The `--estimate` row in the flag tables below ships in llm-ext 14.3.0 and later. The flag already worked on a development build after 14.2.0 (measured 2026-11-04: `classify filter`, `rank` and `label` with `--estimate` exit 0 and print that nothing was sent). llm-ext 14.2.0 (measured 2026-11-04) has neither: `classify filter --help` does not list `--estimate`, and `llm-ext classify filter "is this a rule" ./small.txt --estimate` exits 1 with `llm-ext: --estimate is not available for classify yet.` The same 14.2.0 message appears for `classify label ... --estimate`.

Flags are written `--name value`. Boolean flags (measured on a development build after 14.2.0 for `--json` and `--estimate` on `classify filter` and `classify requirements`) are bare switches: a value after one is taken as an extra positional (file) argument. With `--input` the error is `llm-ext: --input cannot be combined with files, --items or the other file options; pass one or the other` (command `classify filter --input filter-text.json --estimate true`); without `--input` it is the usage line `llm-ext: usage: llm-ext classify requirements <file, - for stdin> [--max-bytes N]`. `--estimate` alone works. Every action also accepts the global flags (`--quiet`, `--profile <name>`, `--command_timeout <s>`, `--queue_timeout <s>`; see cli-conventions.md). All text below comes from `llm-ext <group> <action> --help`, except the sections that say they come from live runs and the source. A flag row that `--help` cuts with `...` is written whole here.

## `classify` group


### `llm-ext classify verify`

- Usage: `llm-ext classify verify [--flag value ...]`
- Bare argument: none (everything goes through flags)
- Accepted profile types: classifier

Classify decision "verify" (catalog spec; flags, defaults and ranges are generated from it).

| Flag | Type | Meaning (as printed by --help; a row that --help cuts with `...` is given whole) |
|---|---|---|
| `--auto` | number | relation confidence at or above which a grounded verdict is auto-accepted (default 0.8, range 0.5..1) |
| `--chunk_chars` | number | Size in characters at which a long text item is split into chunks. |
| `--default` | string | Default label of every choice question over text; a chunk whose top label is the default does not vote. |
| `--estimate` | boolean | Dry run: print the estimated input cost (an estimate, not a ceiling); nothing is sent to Jev. |
| `--input` | string | Path of the JSON input file; without it the JSON is read from stdin. |
| `--json` | boolean | Print the JSON envelope instead of the text form. |
| `--max_budget` | number | Opt-in spend cap in USD; a run whose estimate exceeds it is refused and a running one stops at it. |
| `--max_questions_per_request` | number | Most questions per request (whole number, 1 or more); a low cap multiplies the request count. |
| `--output_dir` | string | Directory for the JSON report (the JSON envelope, as --json prints it). |
| `--profile` | string | Classifier profile to run on (default: the active classifier profile). |
| `--strict_exit` | boolean | Exit non-zero when the result needs attention. |
| `--subject_at` | number | same-subject probability a contradiction needs; lower and it is unknown (default 0.5, range 0..1) |

Example:
```bash
llm-ext classify verify --input ./request.json
```

### `llm-ext classify screen`

- Usage: `llm-ext classify screen [--flag value ...]`
- Bare argument: none (everything goes through flags)
- Accepted profile types: classifier

Classify decision "screen" (catalog spec; flags, defaults and ranges are generated from it).

| Flag | Type | Meaning (as printed by --help; a row that --help cuts with `...` is given whole) |
|---|---|---|
| `--block` | number | injection probability at or above which the text is blocked (default 0.75, range 0..1) |
| `--chunk_chars` | number | Size in characters at which a long text item is split into chunks. |
| `--default` | string | Default label of every choice question over text; a chunk whose top label is the default does not vote. |
| `--estimate` | boolean | Dry run: print the estimated input cost (an estimate, not a ceiling); nothing is sent to Jev. |
| `--input` | string | Path of the JSON input file; without it the JSON is read from stdin. |
| `--json` | boolean | Print the JSON envelope instead of the text form. |
| `--max_budget` | number | Opt-in spend cap in USD; a run whose estimate exceeds it is refused and a running one stops at it. |
| `--max_questions_per_request` | number | Most questions per request (whole number, 1 or more); a low cap multiplies the request count. |
| `--output_dir` | string | Directory for the JSON report (the JSON envelope, as --json prints it). |
| `--profile` | string | Classifier profile to run on (default: the active classifier profile). |
| `--review` | number | injection probability at or above which the text goes to review (default 0.25, range 0..1) |
| `--skip` | number | substance or relevance probability below which the text is skipped (default 0.3, range 0..1) |
| `--strict_exit` | boolean | Exit non-zero when the result needs attention. |

Example:
```bash
llm-ext classify screen --input ./request.json
```

### `llm-ext classify filter`

- Usage: `llm-ext classify filter "<question>" <files, directories, globs, - for stdin> [--items FILE] [--lines] [--flag value ...]`, or `llm-ext classify filter --input <file.json> [--flag value ...]` (or the JSON input on stdin)
- Bare arguments: the question first (a positional, never a flag), then the inputs
- Accepted profile types: classifier

Classify decision "filter" (catalog spec; flags, defaults and ranges are generated from it).

| Flag | Type | Meaning (as printed by --help; a row that --help cuts with `...` is given whole) |
|---|---|---|
| `--auto` | number | p at or above which (or p + auto <= 1 below which) an item counts as decided (default 0.85, range 0.5..1) |
| `--band` | number | width around the threshold inside which an item is borderline (default 0.15, range 0..0.5) |
| `--chunk_chars` | number | Size in characters at which a long text item is split into chunks. |
| `--context` | string | File of earlier messages (- reads stdin) as background, never scored; sent with every request (since 14.7.3). |
| `--default` | string | Default label of every choice question over text; a chunk whose top label is the default does not vote. |
| `--estimate` | boolean | Dry run: print the estimated input cost (an estimate, not a ceiling); nothing is sent to Jev. |
| `--ext` | string | Only files with these extensions, comma separated (ts,tsx); applies to files found from the inputs, not to --items or stdin. |
| `--follow_symlinks` | boolean | Read the targets of symlinks instead of skipping the links; a broken link or a target outside the allowed roots is still skipped and listed. |
| `--input` | string | Path of the JSON input file; without it the JSON is read from stdin. |
| `--items` | string | JSONL file of items ({"id","text"} per line, or plain lines); - reads stdin. |
| `--json` | boolean | Print the JSON envelope instead of the text form. |
| `--limit` | number | Refuse to run on more items than this, a whole number of 1 or more (default 5000). |
| `--lines` | boolean | Judge each non-blank line of every input as its own item (ids name:N). |
| `--max_budget` | number | Opt-in spend cap in USD; a run whose estimate exceeds it is refused and a running one stops at it. |
| `--max_bytes` | number | Files over this many bytes are skipped and listed; an --items file or stdin over it is refused. A whole number from 1 to 104857600 (the 100 MB cap). |
| `--max_questions_per_request` | number | Most questions per request (whole number, 1 or more); a low cap multiplies the request count. |
| `--no_collapse` | boolean | Print every row of a --lines run; by default rows whose text differs only in numbers are shown once as ×N with their line numbers. |
| `--output_dir` | string | Directory for the JSON report (the JSON envelope, as --json prints it). |
| `--profile` | string | Classifier profile to run on (default: the active classifier profile). |
| `--save` | string | Write every answered row ([{id, p}], JSON, best first) to this file. |
| `--strict_exit` | boolean | Exit non-zero when the result needs attention. |
| `--threshold` | number | p at or above which an item is matched (default 0.5, range 0..1) |

Example:
```bash
llm-ext classify filter "Does this line report a failure (not a warning)?" --items ./items.jsonl
llm-ext classify filter "Does this text ask to cancel the subscription?" ./a.txt ./b.txt --context ./context.txt   # since 14.7.3; the context is background, never scored; live check 3 ran this form (file inputs), not --items or --lines
```

### `llm-ext classify label`

- Usage: `llm-ext classify label <files, directories, globs, - for stdin> [--items FILE] [--lines] [--flag value ...]`, or `llm-ext classify label --input <file.json> [--flag value ...]` (or the JSON input on stdin)
- Bare arguments: the inputs (files, directories, globs, `-` for stdin); the labels come from `--labels` or `--labels-json`
- Accepted profile types: classifier

Classify decision "label" (catalog spec; flags, defaults and ranges are generated from it).

| Flag | Type | Meaning (as printed by --help; a row that --help cuts with `...` is given whole) |
|---|---|---|
| `--auto` | number | --auto: lowest confidence that makes a label automatic (must be >= --min-confidence) (default 0.85, range 0..1) |
| `--chunk_chars` | number | Size in characters at which a long text item is split into chunks. |
| `--context` | string | File of earlier messages (- reads stdin) as background, never scored; sent with every request. |
| `--default` | string | Default label of every choice question over text; a chunk whose top label is the default does not vote. |
| `--estimate` | boolean | Dry run: print the estimated input cost (an estimate, not a ceiling); nothing is sent to Jev. |
| `--ext` | string | Only files with these extensions, comma separated (ts,tsx); applies to files found from the inputs, not to --items or stdin. |
| `--follow_symlinks` | boolean | Read the targets of symlinks instead of skipping the links; a broken link or a target outside the allowed roots is still skipped and listed. |
| `--input` | string | Path of the JSON input file; without it the JSON is read from stdin. |
| `--items` | string | JSONL file of items ({"id","text"} per line, or plain lines); - reads stdin. |
| `--json` | boolean | Print the JSON envelope instead of the text form. |
| `--labels` | string | Classes as "a:hint,b": comma separated, text after the first colon is the hint (2 to 255 labels). |
| `--labels_json` | string | Classes as a JSON object {"label": "description"}, or @file holding one (2 to 255 labels). |
| `--limit` | number | Refuse to run on more items than this, a whole number of 1 or more (default 5000). |
| `--lines` | boolean | Judge each non-blank line of every input as its own item (ids name:N). |
| `--margin` | number | --margin: lowest gap between the top two class probabilities for an automatic label (default 0.5, range 0..1) |
| `--max_budget` | number | Opt-in spend cap in USD; a run whose estimate exceeds it is refused and a running one stops at it. |
| `--max_bytes` | number | Files over this many bytes are skipped and listed; an --items file or stdin over it is refused. A whole number from 1 to 104857600 (the 100 MB cap). |
| `--max_questions_per_request` | number | Most questions per request (whole number, 1 or more); a low cap multiplies the request count. |
| `--min_confidence` | number | --min-confidence: below this a label is listed as low confidence (default 0.6, range 0..1) |
| `--only` | string | Show only these classes (comma separated); the count line still lists all. |
| `--output_dir` | string | Directory for the JSON report (the JSON envelope, as --json prints it). |
| `--profile` | string | Classifier profile to run on (default: the active classifier profile). |
| `--save` | string | Write every labelled item ([{id, label, confidence}], JSON) to this file. |
| `--strict_exit` | boolean | Exit non-zero when the result needs attention. |
| `--verbose` | boolean | List every item with its confidence, grouped by class; a ? marks a low-confidence one. |

Example:
```bash
llm-ext classify label --labels "bug,feature,question" --items ./items.jsonl
llm-ext classify label --labels "bug,feature,question" --items ./items.jsonl --context ./context.txt   # ships in llm-ext 14.3.0 and later; measured effect on verdicts: see "Measured effect of --context" below
```

### `llm-ext classify rank`

- Usage: `llm-ext classify rank "<query>" <files, directories, globs, - for stdin> [--items FILE] [--lines] [--flag value ...]`, or `llm-ext classify rank --input <file.json> [--flag value ...]` (or the JSON input on stdin)
- Bare arguments: the query first (a positional, never a flag), then the inputs
- Accepted profile types: classifier

Classify decision "rank" (catalog spec; flags, defaults and ranges are generated from it).

| Flag | Type | Meaning (as printed by --help; a row that --help cuts with `...` is given whole) |
|---|---|---|
| `--all` | boolean | List every ranked candidate instead of the top N. |
| `--chunk_chars` | number | Size in characters at which a long text item is split into chunks. |
| `--default` | string | Default label of every choice question over text; a chunk whose top label is the default does not vote. |
| `--estimate` | boolean | Dry run: print the estimated input cost (an estimate, not a ceiling); nothing is sent to Jev. |
| `--ext` | string | Only files with these extensions, comma separated (ts,tsx); applies to files found from the inputs, not to --items or stdin. |
| `--follow_symlinks` | boolean | Read the targets of symlinks instead of skipping the links; a broken link or a target outside the allowed roots is still skipped and listed. |
| `--head` | number | Send at most the first N bytes of every candidate, cut at a character boundary (a whole number of at least 1). |
| `--input` | string | Path of the JSON input file; without it the JSON is read from stdin. |
| `--items` | string | JSONL file of items ({"id","text"} per line, or plain lines); - reads stdin. |
| `--json` | boolean | Print the JSON envelope instead of the text form. |
| `--keep_at` | number | --keep-at: drop candidates whose relevance is below this (default 0, range 0..1) |
| `--limit` | number | Refuse to run on more items than this, a whole number of 1 or more (default 5000). |
| `--lines` | boolean | Judge each non-blank line of every input as its own item (ids name:N). |
| `--max_budget` | number | Opt-in spend cap in USD; a run whose estimate exceeds it is refused and a running one stops at it. |
| `--max_bytes` | number | Files over this many bytes are skipped and listed; an --items file or stdin over it is refused. A whole number from 1 to 104857600 (the 100 MB cap). |
| `--max_questions_per_request` | number | Most questions per request (whole number, 1 or more); a low cap multiplies the request count. |
| `--output_dir` | string | Directory for the JSON report (the JSON envelope, as --json prints it). |
| `--profile` | string | Classifier profile to run on (default: the active classifier profile). |
| `--strict_exit` | boolean | Exit non-zero when the result needs attention. |
| `--top` | number | --top: how many candidates to list (ignored with --all) (default 10, range 1..100000) |

Example:
```bash
llm-ext classify rank "where do we issue refunds?" ./src
```

### `llm-ext classify find`

- Usage: `llm-ext classify find "<query>" <files, directories, globs, - for stdin> [--items FILE] [--flag value ...]`, or `llm-ext classify find --input <file.json> [--flag value ...]` (or the JSON input on stdin)
- Bare arguments: the query first (a positional, never a flag), then the inputs; `--lines` is refused (find searches the lines of each file itself)
- Accepted profile types: classifier

Classify decision "find" (catalog spec; flags, defaults and ranges are generated from it).

| Flag | Type | Meaning (as printed by --help; a row that --help cuts with `...` is given whole) |
|---|---|---|
| `--absent` | number | --absent: json mode, exists probability below this is absent (between absent and answered is partial) (default 0.35, range 0..1) |
| `--answered` | number | --answered: json mode, lowest exists probability that counts as answered (default 0.7, range 0..1) |
| `--chunk` | number | --chunk: file mode, lines per request (default 150, range 1..250) |
| `--chunk_chars` | number | Size in characters at which a long text item is split into chunks. |
| `--default` | string | Default label of every choice question over text; a chunk whose top label is the default does not vote. |
| `--estimate` | boolean | Dry run: print the estimated input cost (an estimate, not a ceiling); nothing is sent to Jev. |
| `--ext` | string | Only files with these extensions, comma separated (ts,tsx); applies to files found from the inputs, not to --items or stdin. |
| `--follow_symlinks` | boolean | Read the targets of symlinks instead of skipping the links; a broken link or a target outside the allowed roots is still skipped and listed. |
| `--input` | string | Path of the JSON input file; without it the JSON is read from stdin. |
| `--items` | string | JSONL file of items ({"id","text"} per line, or plain lines); - reads stdin. |
| `--json` | boolean | Print the JSON envelope instead of the text form. |
| `--limit` | number | Refuse to run on more items than this, a whole number of 1 or more (default 5000). |
| `--lines` | boolean | Judge each non-blank line of every input as its own item (ids name:N). |
| `--max_budget` | number | Opt-in spend cap in USD; a run whose estimate exceeds it is refused and a running one stops at it. |
| `--max_bytes` | number | Files over this many bytes are skipped and listed; an --items file or stdin over it is refused. A whole number from 1 to 104857600 (the 100 MB cap). |
| `--max_questions_per_request` | number | Most questions per request (whole number, 1 or more); a low cap multiplies the request count. |
| `--min_score` | number | --min-score: file mode, drop lines scoring below this (default 0.05, range 0..1) |
| `--output_dir` | string | Directory for the JSON report (the JSON envelope, as --json prints it). |
| `--profile` | string | Classifier profile to run on (default: the active classifier profile). |
| `--strict_exit` | boolean | Exit non-zero when the result needs attention. |
| `--top` | number | --top: how many ranked candidates (json) or lines (files) to list (default 5, range 1..100000) |

Example:
```bash
llm-ext classify find "the retry backoff logic" ./src/big_module.py
```

### `llm-ext classify decide`

- Usage: `llm-ext classify decide [--flag value ...]`
- Bare argument: none (everything goes through flags)
- Accepted profile types: classifier

Classify decision "decide" (catalog spec; flags, defaults and ranges are generated from it).

| Flag | Type | Meaning (as printed by --help; a row that --help cuts with `...` is given whole) |
|---|---|---|
| `--chunk_chars` | number | Size in characters at which a long text item is split into chunks. |
| `--default` | string | Default label of every choice question over text; a chunk whose top label is the default does not vote. |
| `--estimate` | boolean | Dry run: print the estimated input cost (an estimate, not a ceiling); nothing is sent to Jev. |
| `--input` | string | Path of the JSON input file; without it the JSON is read from stdin. |
| `--json` | boolean | Print the JSON envelope instead of the text form. |
| `--max_budget` | number | Opt-in spend cap in USD; a run whose estimate exceeds it is refused and a running one stops at it. |
| `--max_questions_per_request` | number | Most questions per request (whole number, 1 or more); a low cap multiplies the request count. |
| `--output_dir` | string | Directory for the JSON report (the JSON envelope, as --json prints it). |
| `--profile` | string | Classifier profile to run on (default: the active classifier profile). |
| `--strict_exit` | boolean | Exit non-zero when the result needs attention. |

Example:
```bash
llm-ext classify decide --input ./request.json
```

### `llm-ext classify compare`

- Usage: `llm-ext classify compare [--flag value ...]`
- Bare argument: none (everything goes through flags)
- Accepted profile types: classifier

Classify decision "compare" (catalog spec; flags, defaults and ranges are generated from it).

| Flag | Type | Meaning (as printed by --help; a row that --help cuts with `...` is given whole) |
|---|---|---|
| `--auto` | number | --auto: lowest top probability that makes a relation automatic (default 0.85, range 0..1) |
| `--chunk_chars` | number | Size in characters at which a long text item is split into chunks. |
| `--default` | string | Default label of every choice question over text; a chunk whose top label is the default does not vote. |
| `--estimate` | boolean | Dry run: print the estimated input cost (an estimate, not a ceiling); nothing is sent to Jev. |
| `--input` | string | Path of the JSON input file; without it the JSON is read from stdin. |
| `--json` | boolean | Print the JSON envelope instead of the text form. |
| `--margin` | number | --margin: lowest gap between the top two relation probabilities for an automatic relation (default 0.5, range 0..1) |
| `--max_budget` | number | Opt-in spend cap in USD; a run whose estimate exceeds it is refused and a running one stops at it. |
| `--max_questions_per_request` | number | Most questions per request (whole number, 1 or more); a low cap multiplies the request count. |
| `--output_dir` | string | Directory for the JSON report (the JSON envelope, as --json prints it). |
| `--profile` | string | Classifier profile to run on (default: the active classifier profile). |
| `--strict_exit` | boolean | Exit non-zero when the result needs attention. |

Example:
```bash
llm-ext classify compare --input ./request.json
```

### `llm-ext classify extract`

- Usage: `llm-ext classify extract [--flag value ...]`
- Bare argument: none (everything goes through flags)
- Accepted profile types: classifier

Classify decision "extract" (catalog spec; flags, defaults and ranges are generated from it).

| Flag | Type | Meaning (as printed by --help; a row that --help cuts with `...` is given whole) |
|---|---|---|
| `--auto` | number | --auto: lowest top probability that makes a pick found (default 0.85, range 0..1) |
| `--candidate_cap` | number | --candidate-cap: most regex matches kept per field; more are cut and the field cannot be found with certainty (default 20, range 2..100) |
| `--chunk_chars` | number | Size in characters at which a long text item is split into chunks. |
| `--default` | string | Default label of every choice question over text; a chunk whose top label is the default does not vote. |
| `--estimate` | boolean | Dry run: print the estimated input cost (an estimate, not a ceiling); nothing is sent to Jev. |
| `--input` | string | Path of the JSON input file; without it the JSON is read from stdin. |
| `--json` | boolean | Print the JSON envelope instead of the text form. |
| `--margin` | number | --margin: lowest gap between the top two candidates for a pick to be found (default 0.5, range 0..1) |
| `--max_budget` | number | Opt-in spend cap in USD; a run whose estimate exceeds it is refused and a running one stops at it. |
| `--max_questions_per_request` | number | Most questions per request (whole number, 1 or more); a low cap multiplies the request count. |
| `--output_dir` | string | Directory for the JSON report (the JSON envelope, as --json prints it). |
| `--profile` | string | Classifier profile to run on (default: the active classifier profile). |
| `--strict_exit` | boolean | Exit non-zero when the result needs attention. |

Example:
```bash
llm-ext classify extract --input ./request.json
```

### `llm-ext classify audit`

- Usage: `llm-ext classify audit [--flag value ...]`
- Bare argument: none (everything goes through flags)
- Accepted profile types: classifier

Classify decision "audit" (catalog spec; flags, defaults and ranges are generated from it).

| Flag | Type | Meaning (as printed by --help; a row that --help cuts with `...` is given whole) |
|---|---|---|
| `--chunk_chars` | number | Size in characters at which a long text item is split into chunks. |
| `--default` | string | Default label of every choice question over text; a chunk whose top label is the default does not vote. |
| `--estimate` | boolean | Dry run: print the estimated input cost (an estimate, not a ceiling); nothing is sent to Jev. |
| `--input` | string | Path of the JSON input file; without it the JSON is read from stdin. |
| `--json` | boolean | Print the JSON envelope instead of the text form. |
| `--max_budget` | number | Opt-in spend cap in USD; a run whose estimate exceeds it is refused and a running one stops at it. |
| `--max_questions_per_request` | number | Most questions per request (whole number, 1 or more); a low cap multiplies the request count. |
| `--output_dir` | string | Directory for the JSON report (the JSON envelope, as --json prints it). |
| `--profile` | string | Classifier profile to run on (default: the active classifier profile). |
| `--strict_exit` | boolean | Exit non-zero when the result needs attention. |
| `--wrong_at` | number | --wrong-at: a record's largest check probability at or above which its value is flagged wrong and the audit escalates (default 0.7, range 0.5..1) |

Example:
```bash
llm-ext classify audit --input ./request.json
```

### `llm-ext classify review`

- Usage: `llm-ext classify review [--flag value ...]`
- Bare argument: none (everything goes through flags)
- Accepted profile types: classifier

Classify decision "review" (catalog spec; flags, defaults and ranges are generated from it).

| Flag | Type | Meaning (as printed by --help; a row that --help cuts with `...` is given whole) |
|---|---|---|
| `--auto_accept` | number | --auto-accept: safe_to_apply, minimum score confidence and every claim's confidence at or above this may stand as auto (default 0.8, range 0..1) |
| `--chunk_chars` | number | Size in characters at which a long text item is split into chunks. |
| `--claims` | string | File with one claim per non-empty line (- reads stdin), judged against the evidence; up to 16. Needs evidence in the JSON input; without --claims only the review half runs. |
| `--composite_floor` | number | --composite-floor: the weighted composite must be at or above this for auto (default 0.7, range 0..1) |
| `--default` | string | Default label of every choice question over text; a chunk whose top label is the default does not vote. |
| `--estimate` | boolean | Dry run: print the estimated input cost (an estimate, not a ceiling); nothing is sent to Jev. |
| `--input` | string | Path of the JSON input file; without it the JSON is read from stdin. |
| `--json` | boolean | Print the JSON envelope instead of the text form. |
| `--max_budget` | number | Opt-in spend cap in USD; a run whose estimate exceeds it is refused and a running one stops at it. |
| `--max_questions_per_request` | number | Most questions per request (whole number, 1 or more); a low cap multiplies the request count. |
| `--output_dir` | string | Directory for the JSON report (the JSON envelope, as --json prints it). |
| `--profile` | string | Classifier profile to run on (default: the active classifier profile). |
| `--review_at` | number | --review-at: minimum score confidence, safe_to_apply or claim confidence below this escalates (must not be above --auto-accept) (default 0.5, range 0..1) |
| `--strict_exit` | boolean | Exit non-zero when the result needs attention. |

Example:
```bash
llm-ext classify review --input ./request.json
```

### `llm-ext classify check`

- Usage: `llm-ext classify check [--flag value ...]`
- Bare argument: none (everything goes through flags)
- Accepted profile types: classifier

Classify decision "check" (catalog spec; flags, defaults and ranges are generated from it).

| Flag | Type | Meaning (as printed by --help; a row that --help cuts with `...` is given whole) |
|---|---|---|
| `--chunk_chars` | number | Size in characters at which a long text item is split into chunks. |
| `--default` | string | Default label of every choice question over text; a chunk whose top label is the default does not vote. |
| `--estimate` | boolean | Dry run: print the estimated input cost (an estimate, not a ceiling); nothing is sent to Jev. |
| `--input` | string | Path of the JSON input file; without it the JSON is read from stdin. |
| `--json` | boolean | Print the JSON envelope instead of the text form. |
| `--max_budget` | number | Opt-in spend cap in USD; a run whose estimate exceeds it is refused and a running one stops at it. |
| `--max_questions_per_request` | number | Most questions per request (whole number, 1 or more); a low cap multiplies the request count. |
| `--output_dir` | string | Directory for the JSON report (the JSON envelope, as --json prints it). |
| `--preset` | string | Which check: invariant-check or criterion-vs-tests (the JSON input must not hold `preset` too). |
| `--profile` | string | Classifier profile to run on (default: the active classifier profile). |
| `--strict_exit` | boolean | Exit non-zero when the result needs attention. |

Example:
```bash
llm-ext classify check --input ./request.json
```

### `llm-ext classify findings`

- Usage: `llm-ext classify findings [--flag value ...]`
- Bare argument: none (everything goes through flags)
- Accepted profile types: classifier

Classify decision "findings" (catalog spec; flags, defaults and ranges are generated from it).

| Flag | Type | Meaning (as printed by --help; a row that --help cuts with `...` is given whole) |
|---|---|---|
| `--already_handled` | number | --already-handled: p at or above which the finding is dropped as already handled (default 0.4, range 0..1) |
| `--chunk_chars` | number | Size in characters at which a long text item is split into chunks. |
| `--default` | string | Default label of every choice question over text; a chunk whose top label is the default does not vote. |
| `--estimate` | boolean | Dry run: print the estimated input cost (an estimate, not a ceiling); nothing is sent to Jev. |
| `--input` | string | Path of the JSON input file; without it the JSON is read from stdin. |
| `--json` | boolean | Print the JSON envelope instead of the text form. |
| `--max_budget` | number | Opt-in spend cap in USD; a run whose estimate exceeds it is refused and a running one stops at it. |
| `--max_questions_per_request` | number | Most questions per request (whole number, 1 or more); a low cap multiplies the request count. |
| `--output_dir` | string | Directory for the JSON report (the JSON envelope, as --json prints it). |
| `--profile` | string | Classifier profile to run on (default: the active classifier profile). |
| `--reachable` | number | --reachable: lowest p that the problem can happen; below it a real finding is kept with low confidence (default 0.7, range 0..1) |
| `--real` | number | --real: lowest p that the finding is a real problem; below it the finding is dropped (default 0.5, range 0..1) |
| `--strict_exit` | boolean | Exit non-zero when the result needs attention. |

Example:
```bash
llm-ext classify findings --input ./request.json
```

### `llm-ext classify test-output`

- Usage: `llm-ext classify test-output [--flag value ...]`
- Bare argument: none (everything goes through flags)
- Accepted profile types: classifier

Classify decision "test-output" (catalog spec; flags, defaults and ranges are generated from it).

| Flag | Type | Meaning (as printed by --help; a row that --help cuts with `...` is given whole) |
|---|---|---|
| `--chunk_chars` | number | Size in characters at which a long text item is split into chunks. |
| `--default` | string | Default label of every choice question over text; a chunk whose top label is the default does not vote. |
| `--estimate` | boolean | Dry run: print the estimated input cost (an estimate, not a ceiling); nothing is sent to Jev. |
| `--evidence` | number | --evidence: lowest p that the log shows enough to tell the cause; below it a shown failure needs attention (default 0.5, range 0..1) |
| `--input` | string | Path of the JSON input file; without it the JSON is read from stdin. |
| `--json` | boolean | Print the JSON envelope instead of the text form. |
| `--max_budget` | number | Opt-in spend cap in USD; a run whose estimate exceeds it is refused and a running one stops at it. |
| `--max_bytes` | number | Files over this many bytes are skipped and listed; an --items file or stdin over it is refused. A whole number from 1 to 104857600 (the 100 MB cap). |
| `--max_questions_per_request` | number | Most questions per request (whole number, 1 or more); a low cap multiplies the request count. |
| `--output_dir` | string | Directory for the JSON report (the JSON envelope, as --json prints it). |
| `--profile` | string | Classifier profile to run on (default: the active classifier profile). |
| `--regression` | number | --regression: lowest p that the failure is a code regression; at or above it the run needs attention (default 0.5, range 0..1) |
| `--strict_exit` | boolean | Exit non-zero when the result needs attention. |

Example:
```bash
llm-ext classify test-output --input ./request.json
```


### `llm-ext classify requirements`

`classify requirements` ships in llm-ext 14.3.0 and later; an installed llm-ext without it exits 1 with `llm-ext: unknown action 'requirements' in group 'classify'.` (measured on llm-ext 14.2.0, 2026-11-04). The runs quoted in this section used a development build after 14.2.0 that includes it (measurements dated 2026-11-04); 14.3.0 is the first release that does.

- Usage: `llm-ext classify requirements <file, - for stdin> [--max-bytes N] [--flag value ...]`, or `llm-ext classify requirements --input <file.json> [--flag value ...]` (or the JSON input on stdin)
- Bare argument: the prompt file (or `-` for stdin); the earlier messages go in `--context`
- Accepted profile types: classifier

This section comes from live runs and the source, not from --help.

Purpose: pick the explicit requirements out of one user prompt. The prompt is split into sentences in code, Jev labels every sentence with one of four classes (`requirement`: a feature, behavior, property or rule the product must have from now on, even when phrased as a command; `instruction`: an action on the current work that leaves nothing new to check afterwards, such as run, rebuild, open, commit; `opinion`; `other`: question, description of how things are now, greeting), and the sentences labelled `requirement` with confidence at or above `--min_confidence` are returned verbatim, in prompt order. Every sentence is also returned with its label, so a later step can group them (see `references/requirements-pipeline.md`).

Input: the prompt as a text file (one prompt per run). The earlier messages of the conversation, which decide what "it" and "the style" refer to, go in a second file given with `--context` (`-` reads stdin); they are background for every sentence and are never scored. JSON input form: `{"prompt": "...", "context": "..."}`, `context` optional, no other key (`catalog/requirements.ts`).

| Flag | Type | Meaning (as printed by --help; a row that --help cuts with `...` is given whole) |
|---|---|---|
| `--chunk_chars` | number | Size in characters at which a long text item is split into chunks. |
| `--context` | string | File with the earlier messages of the conversation (- reads stdin), used as background for every sentence; never scored. |
| `--default` | string | Default label of every choice question over text; a chunk whose top label is the default does not vote. |
| `--estimate` | boolean | Dry run: print the estimated input cost (an estimate, not a ceiling); nothing is sent to Jev. |
| `--input` | string | Path of the JSON input file; without it the JSON is read from stdin. |
| `--json` | boolean | Print the JSON envelope instead of the text form. |
| `--max_budget` | number | Opt-in spend cap in USD; a run whose estimate exceeds it is refused and a running one stops at it. |
| `--max_bytes` | number | Files over this many bytes are skipped and listed; an --items file or stdin over it is refused. A whole number from 1 to 104857600 (the 100 MB cap). |
| `--max_questions_per_request` | number | Most questions per request (whole number, 1 or more); a low cap multiplies the request count. |
| `--min_confidence` | number | --min-confidence: a sentence is a requirement only when its label is requirement and its confidence is at or above this (default 0.6, range 0..1) |
| `--output_dir` | string | Directory for the JSON report (the JSON envelope, as --json prints it). |
| `--profile` | string | Classifier profile to run on (default: the active classifier profile). |
| `--strict_exit` | boolean | Exit non-zero when the result needs attention. |

`--json` and `--estimate` are bare switches: `--json true` fails with `llm-ext: usage: llm-ext classify requirements <file, - for stdin> [--max-bytes N]` (exit 1) and `--json=true` with `unknown option --json=true for classify requirements`. Flag spellings, from runs only (`classify requirements ./prompt.txt <flag> <value> --estimate`, each exit 0): `--min-confidence 0.7` and `--min_confidence 0.7`; `--max-bytes 100000` and `--max_bytes 100000`. For this decision the text form is the JSON document itself followed by the receipt lines; with `--json` the receipt goes to stderr.

Output (`decision` object): `requirements`: `[{id, text, probabilities, confidence}]`, the accepted requirement sentences. `sentences`: every sentence of the prompt in order, `{id, text, kind ("text" or "code"), label, probabilities, confidence, accepted, invalid}`; `accepted` is true when the label confidence is at or above `--min_confidence`. `invalid`: `[{id, reason}]` for a sentence whose answer failed. A text sentence that is not accepted, or invalid, makes the run "need attention" (`--strict_exit` turns that into a non-zero exit). Probabilities and confidences vary a little between runs of the same input.

Live example, the goal prompt (prompt file: `the colors are horrible. let's improve it a little. the loading screen background should be blue. change it and rebuild. then open the web site in chrome for me to see.`; context file: `We implemented the loading screen, but we need to improve the style. Let me see how is it now.`):

```bash
llm-ext classify requirements ./prompt.txt --context ./context.txt
```

Result (exit 0; trimmed to the relevant fields: `schema`, `snapshots`, `usage` and empty `warnings`/`degraded` omitted, per-sentence `kind`, `text` and the `probabilities` of the three losing classes omitted):

```
requirements: [ s3 "the loading screen background should be blue."  requirement 0.98, confidence 0.97 ]
s1  opinion      probability 1     confidence 1     accepted true
s2  instruction  probability 0.37 (requirement 0.34)  confidence 0.16  accepted false
s3  requirement  probability 0.98  confidence 0.97  accepted true
s4  instruction  probability 0.93  confidence 0.91  accepted true
s5  instruction  probability 0.94  confidence 0.92  accepted true
invalid: []   usage: input_tokens 1035, output_tokens 241, cost 0.00004347 USD
```

`s2` ("let's improve it a little.") is the borderline sentence: its label can flip between runs (see Known limitation); the confidence gate is what kept it out here.

`--estimate` (checked live, 2026-11-04, on a development build after 14.2.0): works for `classify requirements`. `llm-ext classify requirements ./prompt.txt --context ./context.txt --estimate` exits 0, sends no question and prints `classify requirements --estimate: nothing was sent`, `model: typesafe/jev-1.14`, `requests: 1`, `estimated input tokens: 1070`, `estimated input cost: 0.000045 USD (0.042 USD per million tokens)` and the line "This is an estimate, not a ceiling: it counts input tokens only, and small requests have measured up to 55% below the tokens the API reports."

Limits:

- Fenced code blocks (lines between three-backtick fences, `l2/sentences.ts`) are kept in `sentences` with `kind: "code"`, `label: null`, `accepted: false` and are never scored. A prompt made only of code blocks is refused: `llm-ext: invalid input: prompt: prompt has no text sentence to score (only code blocks)` (exit 1; `catalog/requirements.ts`).
- No grouping: two consecutive sentences that form one requirement are returned as two rows, and a requirement that continues in the next sentence ("it must also ...") is not joined. Grouping is a separate step done by `llm ask`; see `references/requirements-pipeline.md`.
- Long prompts: a prompt file over `--max_bytes` is not refused; it keeps its last lines and drops the start, and prints a warning on stderr, e.g. `over 100 bytes; kept the last 71 bytes and dropped 98 bytes from the start`. Requirements in the dropped start are lost, and the only sign is that warning on stderr. When the last line alone is over the cap it is refused: `the last line alone is over 100 bytes; raise --max-bytes` (exit 1). The cap value is 1 to 104857600 bytes (`shared-flags.ts`).

Known limitation (measured 2026-11-04 on a development build after 14.2.0, TRDD-S5KOOT2S): the check used 10 vague improvement requests and 10 concrete property requests, each run alone and inside a three-sentence prompt. All 20 property runs were returned as requirements. One vague run was also returned as a requirement: "make it a bit more professional" inside "the page looks off. make it a bit more professional. rebuild it and open it for me." (confidence 0.79); sent alone, the same sentence had confidence 0.51 and was rejected. The label of a borderline sentence can change between runs (the goal example's "let's improve it a little." was argmax requirement in one run and instruction in another). In the two runs, 3 of 10 and 4 of 10 vague items had requirement as their top label and were stopped only by the gate. The `--min_confidence` gate (default 0.6) usually keeps such sentences out, not always. The check used one context ("we built the settings page yesterday.") and one opener, so the measured rate holds only for that setup. Review the returned list before writing it into a rules file.

### `llm-ext classify rule-check`

`classify rule-check` is new in llm-ext 14.7.0 (TRDD-LFTQCFUX). The runs quoted here were made on a development build after 14.6.5, 2026-11-18, remote typesafe/jev-1.14, one run per check except the example request, which ran twice (once with `--json`, once in text form), with the environment `HOME`, `LLM_EXT_CONFIG_DIR` (under `HOME`: a config directory elsewhere is refused), `LLM_EXT_OUTPUT_DIR`, `LLM_EXT_SCRATCH_DIR` set to scratch folders and `LLM_EXT_INSTALL_RULE=0`. The binary was `dist/llm-ext.js` (the `bin` of package.json).

- Usage: `llm-ext classify rule-check --input <file.json> [--context FILE] [--flag value ...]` (or the JSON input on stdin); there is no bare file argument
- Accepted profile types: classifier

This section comes from live runs and the source (`catalog/rule-check.ts`), not from --help.

Purpose: say whether a new phrase DUPLICATES one of a list of existing rules, is an UPDATED VERSION of one, or is NEW. For every rule Jev answers two questions about the pair: how the phrase relates to the rule (`duplicate`: says the same thing; `updated_version`: changes, extends or replaces the rule on the same subject; `new`: a subject the rule does not cover) and whether the phrase contradicts the rule. The outcome is then decided in code, never by the model.

Input: `{"phrase": "...", "rules": [{"id": "G7.4", "text": "..."}, ...], "context": "..."}`; `rules` has at least 1 entry, `context` is optional (the `--context` file fills it), no other key is accepted. A rule id matches `[A-Za-z0-9_.:-]{1,64}` (so PRRD ids such as `G7.4` and `S64.134` are returned unchanged), ids must be unique and `__proto__` is refused. The rule text and the phrase never appear in a question, only in the request state. Example request: `references/rule-check-example.json` with `references/rule-check-example-context.txt`.

| Flag | Type | Meaning (as printed by --help; a row that --help cuts with `...` is given whole) |
|---|---|---|
| `--chunk_chars` | number | Size in characters at which a long text item is split into chunks. |
| `--conflict` | number | --conflict: the phrase contradicts a rule when the contradiction probability is at or above this (default 0.6, range 0..1) |
| `--context` | string | File of earlier messages (- reads stdin) as background, never scored; sent with every request. |
| `--default` | string | Default label of every choice question over text; a chunk whose top label is the default does not vote. |
| `--estimate` | boolean | Dry run: print the estimated input cost (an estimate, not a ceiling); nothing is sent to Jev. |
| `--input` | string | Path of the JSON input file; without it the JSON is read from stdin. |
| `--json` | boolean | Print the JSON envelope instead of the text form. |
| `--max_budget` | number | Opt-in spend cap in USD; a run whose estimate exceeds it is refused and a running one stops at it. |
| `--max_questions_per_request` | number | Most questions per request (whole number, 1 or more); a low cap multiplies the request count. |
| `--min_confidence` | number | --min-confidence: a relation counts only when its confidence is at or above this; otherwise the rule stays a candidate (default 0.6, range 0..1) |
| `--output_dir` | string | Directory for the JSON report (the JSON envelope, as --json prints it). |
| `--profile` | string | Classifier profile to run on (default: the active classifier profile). |
| `--strict_exit` | boolean | Exit non-zero when the result needs attention. |

Notes on the rows above (from live runs and the source, not from --help). `--default` is listed but does not apply: rule-check has no choice question over text. `--max_questions_per_request` (all classify commands) multiplies the request count: rule-check asks 2 questions per rule, so 2 sends one rule per request. A value below the questions of one unit (1 for rule-check) is refused for the whole run: exit 1, `llm-ext: unit 0 (questions: rel_i0, con_i0) has 2 questions, over the limit of 1 per request` (measured). 0, 1.5 or a negative value is refused with `llm-ext: --max-questions-per-request must be a whole number of 1 or more, got ...`. The other rows behave as for the other classify commands.

Output (`decision` object): `outcome` (`duplicate`, `updated_version`, `new` or `uncertain`), `rule_id` (the matched rule, else null), `ambiguous`, `conflict`, `reason` (one line built from the result), `unanswered` (ids of the rules with no valid answer), `candidates` and `confident_new_count`. A candidate is a rule that is NOT a confident new: `{id, label, confidence, probabilities, contradicts: {yes, probability} or null, unanswered, invalid}`, sorted by the probability of `new` ascending, unanswered last. `confident_new_count` counts the other rules, so `candidates` length plus `confident_new_count` is the number of rules and a long list never prints one row per rule. The text form is the first line `outcome rule_id` (plus ` · ambiguous`, ` · conflict`), one line per answered candidate (confidence, label, id, `contradicts`), `N rules are confidently new`, and `? no answer: <id> (<reason>)` lines.

Outcome rules, in this order (a confident relation is one whose confidence is known and at or above `--min_confidence`):

0. Any rule with no valid answer (its relation or its contradiction question failed or was never sent): `uncertain`, `rule_id` null, the ids in `unanswered`. A rule nobody judged may be the duplicate, so a confident duplicate elsewhere is not reported.
1. A confident `duplicate`: `duplicate`, `rule_id` the most confident one (the first on a tie).
2. Else a confident `updated_version`: `updated_version`, `rule_id` the most confident; `ambiguous` is true when two or more qualify.
3. Else every rule is a confident `new`: `new`.
4. Else `uncertain`.

`conflict` is true when any answered rule has a contradiction probability at or above `--conflict`, whatever its relation label, so a rule labelled `new` that the phrase contradicts does not hide behind a clean `new` (it stays a candidate and is not counted in `confident_new_count`). A run "needs attention" for `uncertain`, `ambiguous` or `conflict`; only `--strict_exit` turns that into exit 1.

`stopped` and `degraded`: `degraded` is always `[]` in the envelope (no source fallback is built). `stopped` is `budget` or `timeout` when `--max_budget` or `--command_timeout` (or `--stop_on_errors`) ended the run before every request was sent. Checked in `l2/fan-out.ts` (lines 238-244, the per-item split) and tested through the real planner: a request that was not sent or that failed gives every question key of its rules a not-ok answer (reason `not_sent_budget`, `not_sent_timeout`, `aborted`, `invalid_response`, `not_sent_fatal`), so those rules arrive as unanswered. A stopped or partly failed run therefore always has outcome `uncertain` with the missing rules in `unanswered`, never `new`, and the decision is still printed. A run-wide failure (bad key, no credits, key limit, unknown model) prints no decision at all (`run-decision.ts` conclude).

Exit codes (`run-decision.ts` ExitCode, `l2/attention.ts`, `l2/cost-cap.ts`, `l2/abort.ts`, `command-stop.ts`):

| Code | Meaning |
|---|---|
| 0 | The run finished. Also when the result needs attention and `--strict_exit` is absent. |
| 1 | Refused before any request: invalid input (schema, bad id, duplicate id), a threshold or `--max_questions_per_request` out of range, a plan over the profile limit (`llm-ext: the plan needs 25 requests, over the limit of 8`, measured), an estimate over `--max_budget`; this holds with or without `--strict_exit`. Also 1: the result needs attention and `--strict_exit` is given (checked on a clean duplicate run: exit 0 with the flag), and the `--max_budget` stop (the decision is printed with the unsent rules unanswered). |
| 3 | The key is missing, rejected or out of credits (the most actionable class when several failures occurred: 3 over 4 over 5). |
| 4 | A request or the model was rejected. |
| 5 | A request failed after its retries (a failed request, not a run-wide one, still prints the decision with its rules unanswered). |
| 6 | `--stop_on_errors` stopped the run. |
| 124 | `--command_timeout` stopped the run (the decision is printed, rules not sent are unanswered). |
| 130 | Ctrl-C. |

Request counts (`--estimate`, measured with the default profile, whose limit is 8 requests per call): the 4 example rules with a context: 1 request, 1284 input tokens, 0.000054 USD; with `--max_questions_per_request 2`: 4 requests, 1716 tokens, 0.000072 USD; with 1: refused (exit 1). The 25 rules of the AI Maestro janitor PRRD (rule texts from `prrdgrep show`, metadata block removed): 1 request, 10905 tokens, 0.000458 USD; with 2: refused, `the plan needs 25 requests, over the limit of 8`; with 1: refused. A generated list of 100 short one-sentence rules: 2 requests, 26470 tokens, 0.001112 USD; with 2: refused, `the plan needs 100 requests, over the limit of 8`; with 1: refused. A cap of 2 therefore needs a profile with `max_requests_per_call` of at least the rule count (the field of the profile, see models-and-settings.md).

Live example, the example request (`rule-check-example.json`, expected per pair: r1 duplicate, r2 updated_version, u1 new, u2 new; expected outcome duplicate, rule_id r1):

```bash
llm-ext classify rule-check --input ./rule-check-example.json --context ./rule-check-example-context.txt
```

Result (exit 0; `--json` run: same decision, `warnings` and `degraded` empty, no `answered_by`, usage 1204 input and 228 output tokens, 0.000051 USD):

```
duplicate r1
0.68  duplicate  r1
0.42  new  r2
2 rules are confidently new
```

r1 matched the expectation (duplicate). r2 did NOT: it came back `new` (probabilities 0 / 0.40 / 0.60, confidence 0.40 in the `--json` run, 0.42 in the text run), not `updated_version`; u1 and u2 are the two confident news (they are counted, not listed). The outcome matches (duplicate r1). The expectation for r2 is a mismatch, reported and not changed.

Measured again on the same build (2026-11-18, 5 runs per input; samples, not rates): on the example the outcome was duplicate r1 in 5 of 5 runs, and r2 never reached updated_version at the 0.6 default (confidence 0.33 to 0.52). The same request without r1 (the phrase against r2, u1 and u2) came out `uncertain` in 5 of 5 runs and `new` in none; when r2 was labelled new its highest confidence was 0.31. With `--max_questions_per_request 2` (one rule per request) the example stayed duplicate r1 in 5 of 5, with r2 at 0.28 to 0.33. In these runs, on this one phrase pair, the earlier version came out `uncertain`, which goes to the user, and never `new`.

Second live check, a genuinely new phrase against the 25 PRRD rules (`the CLI must print its version with --version`): exit 0, `outcome` new, `confident_new_count` 25, `candidates` empty (0 below 0.6), `unanswered` empty, `conflict` false, 1 request, 8715 input and 1434 output tokens, 0.000366 USD. One run: it shows that a 25-rule list did not make this new phrase uncertain; it does not give a rate for longer lists, where every rule must be a confident new for the outcome to be `new`.

Limits: a rule is compared one pair at a time, so two rules that together make the phrase a duplicate are not seen; confidences vary a little between runs of the same input (r2 above: 0.40 and 0.42 in two runs); the updated-version case was not reproduced for r2 in these n=2 runs, which is a sample and not a rate.

### Request JSON shapes (`--input` of `classify filter`, `label`, `find`)

This section comes from live runs and the source, not from --help. All schemas are strict where marked; ids, when given, must be unique, and in json mode must match `^[A-Za-z0-9_-]{1,64}$` (`l2/ids.ts`; a missing id is its position). All paths below are under `scripts/llm-ext/src/classifiers/`. Each shape below was run live through `--input <file> --json` (exit 0) unless noted.

`classify filter` takes one of two shapes (`catalog/filter.ts`, a union, strict objects):

```json
{"question": "Is this sentence a lasting requirement about how the product must look or behave?",
 "context": "We implemented the loading screen, but we need to improve the style.",
 "items": [{"id": "s2", "text": "let's improve it a little."}, {"id": "s3", "text": "the loading screen background should be blue."}]}
```

Text-items mode: `question` and `items` (at least 1, each `text` not blank, `id` optional and any non-empty string such as a path) required; `context` optional. Live result for 3 items (s2, s3, s4): `matched` = s3 only, p 0.67; s4 p 0.38 borderline; s2 p 0.29; `threshold` 0.5.

`--context FILE` fills `context` for `classify filter` (a file of earlier messages, `-` reads stdin; since 14.7.3). The context is background for reading the items and is never scored: with a context the shared state is `{"context": "<text>"}` and each item question tells the classifier that `shared.context` is background, never to judge or classify it, and to judge only the text in `units`. It is sent with every request, so the cost grows with the number of requests. A context file that is empty or blank is refused before anything is sent (`<file>: empty input`, or `stdin: empty input` for `-`; the source comments call this E40). Without a context the request is unchanged. Giving it together with a JSON `context` is refused as for `classify label`. The propositions form keeps its own wording. Effect on verdicts: live check 3 of TRDD-7ZA3EE6Z passed on this wording (card Notes of 2026-11-18); live checks 1 and 2 with an earlier wording had failed.

```json
{"context": "We implemented the loading screen, but we need to improve the style.",
 "propositions": [{"id": "p1", "text": "The sentence 'the loading screen background should be blue.' states a lasting requirement."}]}
```

Propositions mode: `propositions` 1 to 64 entries, each `text` not blank and at most 2000 characters; `context` optional. Each proposition is judged as a statement. Live: two propositions of the form "The sentence '...' states a lasting requirement." got p 0.17 and 0.19 (nothing matched), including for the sentence that is a requirement; to sort sentences use text-items mode with a question.

`classify label` (`catalog/label.ts`, not strict):

```json
{"mode": "json", "purpose": "...", "context": "...", "default": "new",
 "items": [{"id": "pair", "text": "..."}],
 "classes": [{"id": "duplicate", "description": "..."}, {"id": "new", "description": "..."}]}
```

`items` at least 1 (`text` required, `id` optional); `classes` 2 to 255, `id` non-empty and unique, never `__proto__`, `description` a string, null or absent; `mode` `json` (default) or `files`; `default`, when given, must be one of the class ids; `purpose` and `context` optional strings (run live with `context` and `default` "new" added, `label-ctx.json`: exit 0, same label as without them); the JSON of `classes` must be at most 8000 characters (`label.ts`). Output rows: `{id, label, confidence, probabilities, accepted, auto, review, tie, runnerUp, margin, invalid}`.

`--context FILE` fills `context` (a file of earlier messages, `-` reads stdin; ships in llm-ext 14.3.0 and later). Giving it together with a JSON `context` is refused with `llm-ext: --context sets context, which the JSON input already holds; give it in one place`. The context travels in every request, so the cost grows with the number of requests (`--estimate` counts it), and a context too large for the model window is refused before anything is sent.

Measured effect of `--context` on `classify label` (TRDD-WYY3SPDX, 2026-11-17, llm-ext 14.6.1, remote typesafe/jev-1.14): the pre-registered check failed. Each case ran once and no noise floor was measured, so these numbers may not repeat. A relevant context moved one item from a near-tie control to the label it implied ("Exporting should keep the column order.": feature 0.52 to bug 0.95). On another item it moved the probability away from the implied label (feature 0.85 to 0.65), on a case that can fairly be read either way. An unrelated context changed no top label, but it shifted the near-tie item by 0.21. Treat the context as background the model may use, not as a guarantee: review any verdict that changes when you add it.

`classify find` (`catalog/find.ts`, not strict):

```json
{"query": "the loading screen background should be blue", "mode": "json",
 "items": [{"id": "r1", "text": "..."}, {"id": "u1", "text": "..."}]}
```

`query` non-empty, `items` at least 1 (`text` required), `mode` `json` (default) or `files`. In `json` mode the items are candidates and 2 to 250 are required (`find.ts`); in `files` mode each item is a file text searched line by line. The command line cannot reach json mode: positional arguments force `files` mode (`find.ts`), so give the JSON with `--input`. Output of json mode: `{mode, status ("answered" or "absent"; partial in between), ranked: [{id, probability}], tie, exists, hits, invalid}`. `ranked` probabilities are relative among the candidates (they add up to about 1); `exists` and `status` are the absolute answer, with `--answered` (default 0.7) and `--absent` (default 0.35) as cut points (`find.ts`). Live: query "the loading screen background should be blue" against r1 "make the background color of the loading dialog of a shade of blue", r2 "the background of the load panel must not be transparent.", u1, u2 (two unrelated rules): `status` answered, `exists` 0.71, ranked r1 0.97, r2 0.02, u2 0.01, u1 0; the same query against r2, u1, u2 only: `status` absent, `exists` 0.17, while r2 still ranked first with 0.96. So `find` detects a duplicate (r1) and does not flag a related older rule (r2) as present.

### `llm-ext classify ping`

- Usage: `llm-ext classify ping [--no_call]`
- Release: ships in llm-ext 14.3.0 and later (measured 2026-11-04 on llm-ext 14.2.0: `llm-ext classify ping --no_call` exits 1 with `llm-ext: unknown action 'ping' in group 'classify'.`).
- Accepted profile types: classifier

Checks the classifier key and the decisions service: a free key check (`GET /api/v1/key`, which reports the key spend and limit, never the key), then one tiny paid question to the profile model. The question is fixed and unambiguous: does the state "Water boils at 100 degrees Celsius at sea level." say that water boils at 100 degrees Celsius at sea level? A working model answers high, and the answer is printed with the side it is expected on:

```
key check: ok (profile or-jev, OPENROUTER_API_KEY accepted; ...)
decision call: ok (the remote service; model typesafe/jev-1.14-20261014, answer 0.97, expected above 0.5, cost 0.00001197 USD)
```

Ping is a round-trip check: it exits non-zero when the key check fails; when the call fails and the local decider does not answer either; when the reply has no usable answer; or when the command is stopped (`--command_timeout`, exit 124). An answer below 0.5 prints a warning line on stderr and still exits 0. The question is recorded in the usage history (a local answer is recorded under the local decider's endpoint at no cost); `--max_budget` does not apply to it.

`--no_call` is the free key check alone (`--no-call` is the same flag). On a remote profile it still needs the key: with the variable unset it exits 3 before any request, with a message that names `OPENROUTER_API_KEY`; with the key set it sends one authenticated GET (the key as a Bearer token) to `https://openrouter.ai/api/v1/key`, prints `key check: ok (...)` then `decision call: skipped (--no-call); ...`, and sends no question. With the `local-decision` profile it needs no key and makes no request (`key check: skipped (profile local-decision is local-only: ...)`).

Local decider fallback (ships in llm-ext 14.3.0 and later):

- When: only after the remote decision call fails or times out. A failed key check and `--no_call` never use it. Ctrl-C never starts it, and neither does a `--command_timeout` stop that came before it. The fallback is on by default and can be turned off; when it is off, ping says nothing about it.
- Where: the mlx-decision server that runs as a machine-wide singleton, looked up at the configured decider address first, then (macOS only) among the mlx-decision servers running on this machine. llm-ext never starts or replaces that server.
- Settings: the `local_fallback` keys (`enabled`, `url`, `startTimeoutMs`, `attemptTimeoutMs`, `requestTimeoutMs`, `maxAttempts`), their defaults and ranges are in `models-and-settings.md`, section "Local decider fallback". `enabled: false` turns the fallback off. llm-ext never starts mlx-decision; a busy machine queues the request (the governor wait line every 60 s, bounded by `--command_timeout`).
- Time: the fallback has its own 30 s cap (never longer than the configured local budget), so a decision call that fails or times out can take up to the profile timeout plus 30 s (the key check runs before it and is not counted).
- Success: exit 0, also when the local answer arrives after the remote deadline. stderr says `llm-ext: the remote call failed: <error>; answered by the local decider`, and the result line says `the local decider, no API key used` and `cost 0 USD (local)`. A local answer below 0.5 also prints the below-0.5 warning and still exits 0. A local reply with no usable answer fails as a bad response, and the "answered by the local decider" line is not printed.
- Failure (when the fallback is on): stderr says `llm-ext: the local decider fallback did not answer either: <reason>`. After a remote timeout, ping then fails as "deadline exceeded" (exit 5). After a remote error that came before the deadline, ping fails with that error and its own exit code; if the deadline ran out during the fallback, it fails as "deadline exceeded" (exit 5) and stderr also says `llm-ext: the remote call had failed before the deadline ran out: <error>`.
- Stop: a `--command_timeout` stop during the local call aborts it; the command ends as stopped (exit 124) and the CLI prints the stop line. Ping's own output does not mark the stop.
- Billing: a remote attempt that timed out on the client may still have been billed upstream; ping records no cost for it, since no reply arrived to read a cost from.

| Flag | Type | Meaning |
|---|---|---|
| `--no_call` | boolean | Only the free key check; send no question (nothing is billed). It checks only that the key is accepted, not the credit balance or the model call: a key can pass while paid calls fail with HTTP 402 Insufficient credits; the output says so (ships in llm-ext 14.3.0 and later). |
