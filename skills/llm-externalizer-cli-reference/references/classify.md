# llm-ext reference: classify group

Flags are written `--name value`; booleans take `true`/`false`. Every action also accepts the global flags (`--quiet`, `--profile <name>`, `--command_timeout <s>`, `--queue_timeout <s>`; see SKILL.md). All text below comes from `llm-ext <group> <action> --help`.

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

## `classify` group


### `llm-ext classify verify`

- Usage: `llm-ext classify verify [--flag value ...]`
- Bare argument: none (everything goes through flags)
- Accepted profile types: classifier

Classify decision "verify" (catalog spec; flags, defaults and ranges are generated from it).

| Flag | Type | Meaning (as printed by --help; long text is truncated there) |
|---|---|---|
| `--auto` | number | relation confidence at or above which a grounded verdict is auto-accepted (default 0.8, range 0.5..1) |
| `--chunk_chars` | number | Size in characters at which a long text item is split into chunks. |
| `--default` | string | Default label of every choice question over text; a chunk whose top label is the default... |
| `--input` | string | Path of the JSON input file; without it the JSON is read from stdin. |
| `--max_budget` | number | Opt-in spend cap in USD; a run whose estimate exceeds it is refused and a running one stops... |
| `--output_dir` | string | Directory for the JSON report (same text as stdout). |
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

| Flag | Type | Meaning (as printed by --help; long text is truncated there) |
|---|---|---|
| `--block` | number | injection probability at or above which the text is blocked (default 0.75, range 0..1) |
| `--chunk_chars` | number | Size in characters at which a long text item is split into chunks. |
| `--default` | string | Default label of every choice question over text; a chunk whose top label is the default... |
| `--input` | string | Path of the JSON input file; without it the JSON is read from stdin. |
| `--max_budget` | number | Opt-in spend cap in USD; a run whose estimate exceeds it is refused and a running one stops... |
| `--output_dir` | string | Directory for the JSON report (same text as stdout). |
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

| Flag | Type | Meaning (as printed by --help; long text is truncated there) |
|---|---|---|
| `--auto` | number | p at or above which (or p + auto <= 1 below which) an item counts as decided (default 0.85, range 0.5..1) |
| `--band` | number | width around the threshold inside which an item is borderline (default 0.15, range 0..0.5) |
| `--chunk_chars` | number | Size in characters at which a long text item is split into chunks. |
| `--default` | string | Default label of every choice question over text; a chunk whose top label is the default... |
| `--ext` | string | Only files with these extensions, comma separated (ts,tsx); applies to files found from the... |
| `--follow_symlinks` | boolean | Read the targets of symlinks instead of skipping the links; a broken link or a target... |
| `--input` | string | Path of the JSON input file; without it the JSON is read from stdin. |
| `--items` | string | JSONL file of items ({"id","text"} per line, or plain lines); - reads stdin. |
| `--limit` | number | Refuse to run on more items than this, a whole number of 1 or more (default 5000). |
| `--lines` | boolean | Judge each non-blank line of every input as its own item (ids name:N). |
| `--max_budget` | number | Opt-in spend cap in USD; a run whose estimate exceeds it is refused and a running one stops... |
| `--max_bytes` | number | Files over this many bytes are skipped and listed; an --items file or stdin over it is... |
| `--output_dir` | string | Directory for the JSON report (same text as stdout). |
| `--profile` | string | Classifier profile to run on (default: the active classifier profile). |
| `--strict_exit` | boolean | Exit non-zero when the result needs attention. |
| `--threshold` | number | p at or above which an item is matched (default 0.5, range 0..1) |

Example:
```bash
llm-ext classify filter "Does this line report a failure (not a warning)?" --items ./items.jsonl
```

### `llm-ext classify label`

- Usage: `llm-ext classify label <files, directories, globs, - for stdin> [--items FILE] [--lines] [--flag value ...]`, or `llm-ext classify label --input <file.json> [--flag value ...]` (or the JSON input on stdin)
- Bare arguments: the inputs (files, directories, globs, `-` for stdin); the labels come from `--labels` or `--labels-json`
- Accepted profile types: classifier

Classify decision "label" (catalog spec; flags, defaults and ranges are generated from it).

| Flag | Type | Meaning (as printed by --help; long text is truncated there) |
|---|---|---|
| `--auto` | number | --auto: lowest confidence that makes a label automatic (must be >= --min-confidence) (default 0.85, range 0..1) |
| `--chunk_chars` | number | Size in characters at which a long text item is split into chunks. |
| `--default` | string | Default label of every choice question over text; a chunk whose top label is the default... |
| `--ext` | string | Only files with these extensions, comma separated (ts,tsx); applies to files found from the... |
| `--follow_symlinks` | boolean | Read the targets of symlinks instead of skipping the links; a broken link or a target... |
| `--input` | string | Path of the JSON input file; without it the JSON is read from stdin. |
| `--items` | string | JSONL file of items ({"id","text"} per line, or plain lines); - reads stdin. |
| `--labels` | string | Classes as "a:hint,b": comma separated, text after the first colon is the hint (2 to 255... |
| `--labels_json` | string | Classes as a JSON object {"label": "description"}, or @file holding one (2 to 255 labels). |
| `--limit` | number | Refuse to run on more items than this, a whole number of 1 or more (default 5000). |
| `--lines` | boolean | Judge each non-blank line of every input as its own item (ids name:N). |
| `--margin` | number | --margin: lowest gap between the top two class probabilities for an automatic label (default 0.5, range 0..1) |
| `--max_budget` | number | Opt-in spend cap in USD; a run whose estimate exceeds it is refused and a running one stops... |
| `--max_bytes` | number | Files over this many bytes are skipped and listed; an --items file or stdin over it is... |
| `--min_confidence` | number | --min-confidence: below this a label is listed as low confidence (default 0.6, range 0..1) |
| `--output_dir` | string | Directory for the JSON report (same text as stdout). |
| `--profile` | string | Classifier profile to run on (default: the active classifier profile). |
| `--strict_exit` | boolean | Exit non-zero when the result needs attention. |

Example:
```bash
llm-ext classify label --labels "bug,feature,question" --items ./items.jsonl
```

### `llm-ext classify rank`

- Usage: `llm-ext classify rank "<query>" <files, directories, globs, - for stdin> [--items FILE] [--lines] [--flag value ...]`, or `llm-ext classify rank --input <file.json> [--flag value ...]` (or the JSON input on stdin)
- Bare arguments: the query first (a positional, never a flag), then the inputs
- Accepted profile types: classifier

Classify decision "rank" (catalog spec; flags, defaults and ranges are generated from it).

| Flag | Type | Meaning (as printed by --help; long text is truncated there) |
|---|---|---|
| `--all` | boolean | List every ranked candidate instead of the top N. |
| `--chunk_chars` | number | Size in characters at which a long text item is split into chunks. |
| `--default` | string | Default label of every choice question over text; a chunk whose top label is the default... |
| `--ext` | string | Only files with these extensions, comma separated (ts,tsx); applies to files found from the... |
| `--follow_symlinks` | boolean | Read the targets of symlinks instead of skipping the links; a broken link or a target... |
| `--head` | number | Send at most the first N bytes of every candidate, cut at a character boundary (a whole... |
| `--input` | string | Path of the JSON input file; without it the JSON is read from stdin. |
| `--items` | string | JSONL file of items ({"id","text"} per line, or plain lines); - reads stdin. |
| `--keep_at` | number | --keep-at: drop candidates whose relevance is below this (default 0, range 0..1) |
| `--limit` | number | Refuse to run on more items than this, a whole number of 1 or more (default 5000). |
| `--lines` | boolean | Judge each non-blank line of every input as its own item (ids name:N). |
| `--max_budget` | number | Opt-in spend cap in USD; a run whose estimate exceeds it is refused and a running one stops... |
| `--max_bytes` | number | Files over this many bytes are skipped and listed; an --items file or stdin over it is... |
| `--output_dir` | string | Directory for the JSON report (same text as stdout). |
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

| Flag | Type | Meaning (as printed by --help; long text is truncated there) |
|---|---|---|
| `--absent` | number | --absent: json mode, exists probability below this is absent (between absent and answered is... (default 0.35, range 0..1) |
| `--answered` | number | --answered: json mode, lowest exists probability that counts as answered (default 0.7, range 0..1) |
| `--chunk` | number | --chunk: file mode, lines per request (default 150, range 1..250) |
| `--chunk_chars` | number | Size in characters at which a long text item is split into chunks. |
| `--default` | string | Default label of every choice question over text; a chunk whose top label is the default... |
| `--ext` | string | Only files with these extensions, comma separated (ts,tsx); applies to files found from the... |
| `--follow_symlinks` | boolean | Read the targets of symlinks instead of skipping the links; a broken link or a target... |
| `--input` | string | Path of the JSON input file; without it the JSON is read from stdin. |
| `--items` | string | JSONL file of items ({"id","text"} per line, or plain lines); - reads stdin. |
| `--limit` | number | Refuse to run on more items than this, a whole number of 1 or more (default 5000). |
| `--lines` | boolean | Judge each non-blank line of every input as its own item (ids name:N). |
| `--max_budget` | number | Opt-in spend cap in USD; a run whose estimate exceeds it is refused and a running one stops... |
| `--max_bytes` | number | Files over this many bytes are skipped and listed; an --items file or stdin over it is... |
| `--min_score` | number | --min-score: file mode, drop lines scoring below this (default 0.05, range 0..1) |
| `--output_dir` | string | Directory for the JSON report (same text as stdout). |
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

| Flag | Type | Meaning (as printed by --help; long text is truncated there) |
|---|---|---|
| `--chunk_chars` | number | Size in characters at which a long text item is split into chunks. |
| `--default` | string | Default label of every choice question over text; a chunk whose top label is the default... |
| `--input` | string | Path of the JSON input file; without it the JSON is read from stdin. |
| `--max_budget` | number | Opt-in spend cap in USD; a run whose estimate exceeds it is refused and a running one stops... |
| `--output_dir` | string | Directory for the JSON report (same text as stdout). |
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

| Flag | Type | Meaning (as printed by --help; long text is truncated there) |
|---|---|---|
| `--auto` | number | --auto: lowest top probability that makes a relation automatic (default 0.85, range 0..1) |
| `--chunk_chars` | number | Size in characters at which a long text item is split into chunks. |
| `--default` | string | Default label of every choice question over text; a chunk whose top label is the default... |
| `--input` | string | Path of the JSON input file; without it the JSON is read from stdin. |
| `--margin` | number | --margin: lowest gap between the top two relation probabilities for an automatic relation (default 0.5, range 0..1) |
| `--max_budget` | number | Opt-in spend cap in USD; a run whose estimate exceeds it is refused and a running one stops... |
| `--output_dir` | string | Directory for the JSON report (same text as stdout). |
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

| Flag | Type | Meaning (as printed by --help; long text is truncated there) |
|---|---|---|
| `--auto` | number | --auto: lowest top probability that makes a pick found (default 0.85, range 0..1) |
| `--candidate_cap` | number | --candidate-cap: most regex matches kept per field; more are cut and the field cannot be... (default 20, range 2..100) |
| `--chunk_chars` | number | Size in characters at which a long text item is split into chunks. |
| `--default` | string | Default label of every choice question over text; a chunk whose top label is the default... |
| `--input` | string | Path of the JSON input file; without it the JSON is read from stdin. |
| `--margin` | number | --margin: lowest gap between the top two candidates for a pick to be found (default 0.5, range 0..1) |
| `--max_budget` | number | Opt-in spend cap in USD; a run whose estimate exceeds it is refused and a running one stops... |
| `--output_dir` | string | Directory for the JSON report (same text as stdout). |
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

| Flag | Type | Meaning (as printed by --help; long text is truncated there) |
|---|---|---|
| `--chunk_chars` | number | Size in characters at which a long text item is split into chunks. |
| `--default` | string | Default label of every choice question over text; a chunk whose top label is the default... |
| `--input` | string | Path of the JSON input file; without it the JSON is read from stdin. |
| `--max_budget` | number | Opt-in spend cap in USD; a run whose estimate exceeds it is refused and a running one stops... |
| `--output_dir` | string | Directory for the JSON report (same text as stdout). |
| `--profile` | string | Classifier profile to run on (default: the active classifier profile). |
| `--strict_exit` | boolean | Exit non-zero when the result needs attention. |
| `--wrong_at` | number | --wrong-at: a record's largest check probability at or above which its value is flagged... (default 0.7, range 0.5..1) |

Example:
```bash
llm-ext classify audit --input ./request.json
```

### `llm-ext classify review`

- Usage: `llm-ext classify review [--flag value ...]`
- Bare argument: none (everything goes through flags)
- Accepted profile types: classifier

Classify decision "review" (catalog spec; flags, defaults and ranges are generated from it).

| Flag | Type | Meaning (as printed by --help; long text is truncated there) |
|---|---|---|
| `--auto_accept` | number | --auto-accept: safe_to_apply, minimum score confidence and every claim's confidence at or... (default 0.8, range 0..1) |
| `--chunk_chars` | number | Size in characters at which a long text item is split into chunks. |
| `--composite_floor` | number | --composite-floor: the weighted composite must be at or above this for auto (default 0.7, range 0..1) |
| `--default` | string | Default label of every choice question over text; a chunk whose top label is the default... |
| `--input` | string | Path of the JSON input file; without it the JSON is read from stdin. |
| `--max_budget` | number | Opt-in spend cap in USD; a run whose estimate exceeds it is refused and a running one stops... |
| `--output_dir` | string | Directory for the JSON report (same text as stdout). |
| `--profile` | string | Classifier profile to run on (default: the active classifier profile). |
| `--review_at` | number | --review-at: minimum score confidence, safe_to_apply or claim confidence below this... (default 0.5, range 0..1) |
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

| Flag | Type | Meaning (as printed by --help; long text is truncated there) |
|---|---|---|
| `--chunk_chars` | number | Size in characters at which a long text item is split into chunks. |
| `--default` | string | Default label of every choice question over text; a chunk whose top label is the default... |
| `--input` | string | Path of the JSON input file; without it the JSON is read from stdin. |
| `--max_budget` | number | Opt-in spend cap in USD; a run whose estimate exceeds it is refused and a running one stops... |
| `--output_dir` | string | Directory for the JSON report (same text as stdout). |
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

| Flag | Type | Meaning (as printed by --help; long text is truncated there) |
|---|---|---|
| `--already_handled` | number | --already-handled: p at or above which the finding is dropped as already handled (default 0.4, range 0..1) |
| `--chunk_chars` | number | Size in characters at which a long text item is split into chunks. |
| `--default` | string | Default label of every choice question over text; a chunk whose top label is the default... |
| `--input` | string | Path of the JSON input file; without it the JSON is read from stdin. |
| `--max_budget` | number | Opt-in spend cap in USD; a run whose estimate exceeds it is refused and a running one stops... |
| `--output_dir` | string | Directory for the JSON report (same text as stdout). |
| `--profile` | string | Classifier profile to run on (default: the active classifier profile). |
| `--reachable` | number | --reachable: lowest p that the problem can happen; below it a real finding is kept with low... (default 0.7, range 0..1) |
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

| Flag | Type | Meaning (as printed by --help; long text is truncated there) |
|---|---|---|
| `--chunk_chars` | number | Size in characters at which a long text item is split into chunks. |
| `--default` | string | Default label of every choice question over text; a chunk whose top label is the default... |
| `--evidence` | number | --evidence: lowest p that the log shows enough to tell the cause; below it a shown failure... (default 0.5, range 0..1) |
| `--input` | string | Path of the JSON input file; without it the JSON is read from stdin. |
| `--max_budget` | number | Opt-in spend cap in USD; a run whose estimate exceeds it is refused and a running one stops... |
| `--output_dir` | string | Directory for the JSON report (same text as stdout). |
| `--profile` | string | Classifier profile to run on (default: the active classifier profile). |
| `--regression` | number | --regression: lowest p that the failure is a code regression; at or above it the run needs... (default 0.5, range 0..1) |
| `--strict_exit` | boolean | Exit non-zero when the result needs attention. |

Example:
```bash
llm-ext classify test-output --input ./request.json
```
