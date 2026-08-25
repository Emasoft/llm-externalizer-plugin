# LLM Externalizer — Tool Use-Cases (when to reach for what)

A decision guide for agents. Each entry says **what the tool is for**, **when to
pick it**, and **what to use instead** when it's the wrong fit. For parameters
and behavior see [agent-usage-reference.md](agent-usage-reference.md) or run
`llm-ext <command> --help`, generated from the same catalog the commands run
from.

The golden rule for all of them: **pass file paths, never file contents**, and
read the returned report path when you need the result — output stays out of
your context.

---

## Quick "which tool?" table

| Your goal | Tool |
|---|---|
| Summarize / explain / translate / generate text from files | `chat` |
| Summarize ONE text under a hard character budget | `summarize` |
| Extract keywords / keyphrases / language (topics + themes) from a text | `topics` |
| Deduplicate a bounded phrase list by MEANING (not literal match) | `sem_deduplicate` |
| "What is this file, what is it for, how would it be used?" (any kind) | `describe` |
| Find bugs in a handful of specific code files | `code_task` |
| Audit a whole directory tree for issues | `scan_folder` |
| "Is this feature/function already implemented anywhere?" (cross-file) | `search_existing_implementations` |
| Did a refactor break symbol references / imports? | `check_references` / `check_imports` |
| Does the code match a spec / contract? | `check_against_specs` |
| What changed between two file versions? | `compare_files` |
| Triage suspected-malicious code (is this a threat?) | `security_scan` |
| Extract the same structured fields from MANY files / a corpus | `mass_scout` (+ family) |
| Canonicalize / dedupe 10k–1M short labels by meaning | `cluster_synonyms` |
| Will model X work for tool Y? / pick a per-tool model | `assess_model`, `security_triage_benchmark`, `search_existing_benchmark` |
| Are my CONFIGURED models still valid? (removed? price up? lost a capability?) | `check_model_health` |
| Has a tool's model DEGRADED? recommend a replacement (advisory) | `check_tool_replacements` |
| Are there NEW models I should consider? (newer / cheaper arrivals) | `discover_new_models` |
| Is the backend healthy? what model/profile is active? | `discover` |
| I edited settings.yaml — reload it | `reset` |

---

## Analysis tools

### `chat`
General-purpose text work: summarize, compare, translate, draft, generate
boilerplate, answer a factual question about a file. **Use when** the task is
prose/text and not specifically code-review. **Instead:** for code-bug hunting
use `code_task` (it carries a code-review system prompt).

### `code_task`
Code-optimized analysis with a code-review persona. **Use when** you have a
known, bounded set of code files (≤5 ideal) and want bugs / logic flaws / risks.
**Instead:** a whole directory → `scan_folder`; cross-file "does X exist" →
`search_existing_implementations`.

### `scan_folder`
Auto-discovers files in a directory tree (honors `.gitignore`) and reviews each.
**Use when** you want to audit an entire codebase or subtree. Defaults to one
report per file. **Instead:** a few explicit files → `code_task`; a `.md`-heavy
docs tree → it skips `.md` by default (pass `instructions` for semantic search).

### `compare_files`
Auto-computes the diff between two files and has the LLM summarize what changed.
**Use when** you want a human-readable "what's different / what broke" between
versions. **Instead:** validating references after a rename → `check_references`.

### `check_references`
Resolves local imports, sends source + dependencies, and validates that symbol
references are still valid. **Use after a refactor / rename** to catch dangling
references. **Instead:** just checking import *paths* exist on disk →
`check_imports` (lighter).

### `check_imports`
The LLM extracts the import statements; the server then checks each path exists
on disk. **Use when** you only care "do these imports resolve?" after moving
files. **Instead:** deeper symbol-level validation → `check_references`.

### `check_against_specs`
Compares source files against specification/contract files. **Use when** you have
a written spec (API contract, RFC, design doc) and want to know whether the
implementation conforms. **Instead:** free-form review → `code_task`.

### `search_existing_implementations`
The cross-file specialist. Scans a whole same-language codebase and compares each
file against a REFERENCE (feature description + optional source files + optional
PR diff), emitting exhaustive `YES symbol=… lines=…` / `NO` per file. **Use when**
the question spans the WHOLE codebase: "is this already implemented?", "find every
duplicate of this function", PR duplicate-check reviews. This is the ONLY tool
built for whole-codebase cross-file questions — a different `answer_mode` on the
other tools will NOT give the LLM global visibility. **Instead:** auditing one
subtree for generic issues → `scan_folder`.

### `security_scan`
Dedicated, injection-hardened threat triage for *suspected-malicious* code.
Nonce-delimited untrusted-data envelope, hardened prompt, strict JSON output,
in-band injection pre-scan, fail-safe to `uncertain`. Per-item verdict
`threat | not_threat | uncertain`. **Use when** you're assessing whether code is
hostile (supply-chain review, untrusted snippet, plugin audit). **Instead:**
ordinary bug-finding in trusted code → `code_task` / `scan_folder` (security_scan
is heavier and narrower).

### `cluster_synonyms`
Clusters SENTENCES / short labels by full-sentence meaning equivalence (not
word-level synonyms). File-in/file-out, zero orchestrator tokens, resumable,
budget-capped. **Use when** you have 10k–1M labels to canonicalize / dedupe for a
taxonomy or ontology. **Instead:** semantic *code* search → `search_existing_implementations`.

---

## Mass-scouting tools (the corpus-extraction subsystem)

Use the `mass_scout` family when you need to extract the **same structured
fieldset from MANY files** (hundreds–thousands) and query the results — e.g.
audit every skill in a marketplace, classify a doc corpus, run a repeatable
PR-review fieldset. The full pipeline, bundled fieldsets, and a worked example
live in the `llm-externalizer-mass-scouting` skill; reach for these tools (not
`scan_folder`) whenever the output must be **structured rows you can search /
diff / export**, not prose reports.

| Tool | Use it when |
|---|---|
| `mass_scout_register` | First step — cache a folder's (or explicit files') bodies in SQLite. `--git-diff <ref>` for incremental |
| `mass_scout_preclassify` | You want a fast, script-only bucket tag (binary/sourcecode/config/documentation/log_to_classify/rules_to_eval/has_frontmatter/unknown) before spending LLM calls |
| `mass_scout_estimate` | You need the cost/time/cap-skipped numbers for a fieldset before running (honors `budget_usd`) |
| `mass_scout` | The run — compile fieldset → JSON Schema → LLM per file → repair + validate → persist |
| `mass_scout_search` | Query ONE job's results (regex / FTS5 / structured / combined) |
| `mass_scout_search_xjob` | Search ACROSS jobs, merged by bm25 |
| `mass_scout_get` | Print one result row by `short_id` |
| `mass_scout_export` | Dump a whole job to JSONL / CSV |
| `mass_scout_jobs_list` | See every scout job in the DB |
| `mass_scout_audit_sample` | Spot-check N random rows for quality |
| `mass_scout_body_get` | See exactly what the LLM saw for one file |
| `mass_scout_build_fieldset` | Compose a fieldset from `name:type=desc` shorthand |
| `mass_scout_propose_fieldset` | Let the LLM author a fieldset from a natural-language goal |
| `mass_scout_list_bundled_fieldsets` | Use a ready-made fieldset (code-audit, skill-audit, security-audit, pr-review) |
| `mass_scout_diff` | Compare two jobs row-by-row (only_in_a / only_in_b / changed) |
| `mass_scout_chain` | Re-scout only the subset of a job's results matching a filter, with a fresh fieldset |

---

## Model-qualification tools

### `assess_model`
**Free** (no LLM call, no token cost — just a public catalog fetch, no API key).
Checks ONE OpenRouter model against EVERY LLM tool's per-tool requirements
(cost / context / output / structured-output / reasoning) and reports per-tool
`OK` / `NO` + which qualifying tools also need a benchmark pass. **Use when**
deciding whether a model can back a given tool, or before adding it to
`tool_models`.

### `check_model_health`
**Free** (no LLM call, no token cost — one public catalog fetch, no API key).
The mirror image of `assess_model`: instead of vetting a *candidate*, it
self-checks the model(s) your active profile is **already configured** to use
(main / second / third + every `tool_models` entry). Reports presence (removed /
deprecated = **CRITICAL**), cost drift vs a seeded baseline at
`~/.llm-externalizer/model-baseline.json` (**WARN**), and per-served-tool
requirements regression (**WARN**). Advisory only — never writes settings; emits
a report to `reports/model-health/`. **Use when** you want a periodic "are my
configured models still good?" check — caught a removed model, a price hike, or a
capability the model lost. Acting on findings is user-only (edit settings.yaml +
`reset`).

### `discover_new_models`
**Free** (no LLM call, no token cost — one public catalog fetch, no API key).
The forward-looking sibling of `check_model_health`: instead of checking the
models you already use, it surfaces models that NEWLY appeared in the OpenRouter
catalog since the last run, each assessed against every tool's requirements so
you can spot a newer/cheaper candidate worth adopting. Diffs the live catalog
against a seeded snapshot at `~/.llm-externalizer/catalog-snapshot.json`; first
run seeds and reports zero. Add `qualifying-only` to hide arrivals that fit no
tool. Report-only — adopting an arrival is user-only (vet with `assess_model` +
the tool's benchmark, then edit settings.yaml + `reset`). **Use when** you want
a periodic "anything new I should switch to?" sweep.

### `check_tool_replacements`
**READ-ONLY advisory** auto-replacement planner. Joins the durable model-health
ledger to the per-tool benchmarks: for every tool that HAS a benchmark
(`security_scan`, `search_existing_implementations`), it checks whether that
tool's configured model has DEGRADED (param-drops, reasoning-downgrades,
rate-limits, empty responses, non-retryable failures accumulating in the ledger)
and, only when it has — or when you pass `force` for an explicit audit — runs that
tool's benchmark to recommend the best SAME-OR-CHEAPER replacement. On a
healthy/empty ledger NO benchmark runs and every recommendation is "keep the
incumbent" (zero false positives, zero spend). Writes a report to
`reports/auto-replace/` and NEVER touches settings — `llm-ext` is read-only and
cannot rewrite its own config. **To adopt a recommendation**, hand-edit
`~/.llm-externalizer/settings.yaml` with the recommended model id, then run
`llm-ext reset` (configuration stays user-only — see
[Editing profiles](setup-and-configuration.md)). **Use when** you want a "has
any tool's model gone bad? what should replace it?" sweep — and let the
operator decide whether to apply.

### `security_triage_benchmark`
Qualifies model(s) for `security_scan` against a labeled golden dataset, scored
via the real judge pipeline; recommends the best **same-or-cheaper** passer
(never a pricier model). Cached per-model-per-day. **Use when** you want to swap
the `security_scan` model and need proof it actually performs.

### `search_existing_benchmark`
Qualifies model(s) for `search_existing_implementations` against a labeled
golden-fixture codebase, scored **deterministically** (precision/recall/F1 over
the known duplicate locations — no LLM judge) by driving the real search-existing
pipeline in-process; recommends the best **same-or-cheaper** passer (never a
pricier model). Cached per-model-per-day. **Use when** you want to swap the
`search_existing_implementations` model and need proof it catches duplicates
without over-flagging.

---

## Utility tools

### `discover`
**Use first** whenever something seems off: reports service health, the active
profile, model, auth-token status, context window, and concurrency mode. The
authority on "is auth working" — if it shows the token resolved, do NOT report an
auth error.

### `reset`
**Use after** you (the user) hand-edit `~/.llm-externalizer/settings.yaml` — it
reloads settings from disk and clears caches without a full Claude Code restart.

### `get_settings`
**Read-only.** Returns the path to a copy of settings.yaml for inspection.
`llm-ext` cannot write settings — configuration is user-only (edit the file by
hand, then `reset`). See [setup-and-configuration.md](setup-and-configuration.md).

### `or_model_info` / `or_model_info_table` / `or_model_info_json`
Query OpenRouter for a model's supported params, pricing, latency, and uptime, in
three output formats. **Use when** choosing a remote model or debugging why a
param (e.g. `temperature`) is being dropped for a given model.
