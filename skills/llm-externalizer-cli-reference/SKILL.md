---
name: llm-externalizer-cli-reference
description: Reference for every `llm-ext` (LLM Externalizer) CLI command, flag and default. Use it whenever you run, choose or explain an `llm-ext` command, or want to offload bounded read-only work (summarize, scan, review, audit, compare, check imports/references/specs, security triage, classify, cluster, deduplicate, extract keywords, describe a file, compact a transcript, mass-scout files, inspect OpenRouter models, show or reset settings and profiles) to a cheaper or free LLM, even when the user does not say "llm-ext".
---

# llm-ext CLI reference

`llm-ext` hands bounded, read-only LLM work (read, analyze, summarize, scan, classify) to a cheaper or free model. File contents never enter your context: the command writes a report and prints its path, so you read only the report. It examines code and never edits it.

Facts here come from the live `llm-ext --help --all` and `llm-ext <group> <action> --help` output and, where help is silent (global flags, the 402 or low-balance free fallback), from the CLI source under `scripts/llm-ext/src/`. If this skill and the live help disagree, the live help wins; run the help again.

## Invocation grammar

```
llm-ext <group> <action> [bare-input] [--flag value ...]
llm-ext --help                      groups and their actions
llm-ext --help --all                also every flat command (advanced)
llm-ext <group> --help              one group's actions
llm-ext <group> <action> --help     one action's parameters (safe: makes no LLM call)
llm-ext --version
```

- The bare argument is shorthand for one flag that differs per action (`scan folder ./src` means `--folder_path ./src`; `llm summarize notes.md` means `--input_file`). Each action's reference entry names its bare flag. Actions with no bare argument take only flags.
- Flags are `--snake_case value`. Array and object flags are typed `[array]`/`[object]`/`[oneOf]` in help; JSON is the safe encoding for them (a JSON array passed to `--field` was accepted by the parser in a trial run). Always run `<group> <action> --help` once before using an action you have not used, because required flags (marked `(required)`) differ per action.
- Global flags on every action (place them AFTER the group and action; `llm-ext --quiet scout ...` is rejected as an unknown command): `--quiet` (suppress banner and progress lines) and `--profile <name>` (settings profile for this call only; an unknown name fails fast and lists the profiles). Two more global boolean flags are not listed in help: `--estimate` (dry-runs the invocation and prints the predicted cost instead of dispatching) and `--preview` (dry-runs the file selection and prints each candidate as included or excluded with the reason). Both make zero LLM calls and can be combined. Neither is available for `classify` actions yet (the CLI prints "--estimate is not available for classify yet"); use `--max_budget` there.
- Two more global flags, also AFTER the action, accepted by every command: `--command_timeout <s>` (aliases `--command-timeout`, `--timeout`; `=` or a space; whole seconds, at most 2147483; no limit by default) acts only on commands that send model requests: on expiry the command starts no new model request on any profile (remote ones included; a request already in flight is not aborted) and cancels its jobs at the local broker, then writes the per-file results already complete, lists every unfinished file in its summary (with the timeout as the reason) and exits 124. A command that sends no model requests is not stopped by it; it is only ended (exit 124) if it is still running 30 s after the timeout. `--queue_timeout <s>` (alias `--queue-timeout`) applies only to local models served through the broker: once a request's wait nears it, its model gets the server after the current model's minimum slice, so the worst wait is about the queue timeout plus the minimum run (default 300 s; a large value such as 99990 lets the request wait); waiting is never an error.
- Even actions that make no LLM call (for example `scout build-fieldset`) were observed refusing to run in a brand-new empty config home while no `free` model had been benchmarked yet in that config home ("no model of the 'free' profile is working right now ... retry later"). That is a profile-readiness gate, not a syntax error; wait or use a configured profile.
- A typo in a group or action name exits non-zero and suggests the right verb.
- Help text for flag descriptions is cut at about 100 characters with "..."; the action description above the flag list is complete.

## Where output goes

Reports are written to `<project>/reports/llm-externalizer/` and the path is printed on stdout. Read that file (with your normal file-reading tool) instead of asking for the content. Pass `--output_dir <abs path>` (many actions) to redirect; `-o <dir>` is a working global shorthand for the action's output option (`--output_dir`; for `session compact` it maps to `--output`), e.g. `llm-ext session compact ./session.jsonl -o /tmp`. Actions with no output option (for example `settings show`) refuse it with "no output option".

Scout and classify actions have their own output rules; see their reference files.

## Profiles and settings

- Settings live in `~/.llm-externalizer/settings.yaml` (override the directory with the env var `LLM_EXT_CONFIG_DIR`). A legacy `settings.yml` is not read.
- A profile is a key under `profiles:`. Precedence: `--profile` flag, then the `active:` key, then the built-in `free` profile.
- Profile types gate actions: each action lists "Accepted profile types" in its help: `local`, `free`, `paid`, `any`, plus the special `classifier` (all `classify` actions) and `scouting` (scout actions that call the LLM). A mismatch fails fast.
- Configuration is user-only. The CLI is read-only: `settings show|profile|profiles|status` inspect, `settings reset` clears caches and reloads, `settings scan-local` finds local LLM servers. To change a model, profile or key, tell the user to edit `settings.yaml`, then run `llm-ext settings reset`.
- Test or worker runs that must not touch the real configuration need a throwaway home: `T=$(mktemp -d); HOME=$T LLM_EXT_CONFIG_DIR=$T/cfg LLM_EXT_INSTALL_RULE=0 llm-ext ...`. Running with the real HOME can rewrite the user's global rule file.

## Managed local models

Two local profiles are built in and added to `settings.yaml` once, never active by default: select one with `--profile local_llama` or `--profile locals-mlx`.

| Profile | Engine | Models (`model`, `second_model`, `third_model`) |
|---|---|---|
| `local_llama` | GGUF models through llama.cpp's `llama-server` (api `llamacpp-local`) | `AtomicChat/LFM3-1.7B-Uncensored-GGUF:AD-Q6_K`, `bartowski/Nanbeige_Nanbeige4.2-3B-GGUF/Nanbeige_Nanbeige4.2-3B-Q6_K.gguf`, `insraq/Qwen3.5-4B-EmperoAI-Qwen3.8-Distill-Heretic-Abliterated-MTP-GGUF/Qwen3.5-4B-EmperoAI-Qwen3.8-Distill-Heretic-Abliterated-MTP-GGUF-Q8_0.gguf` |
| `locals-mlx` | MLX models through the Locals server (api `locals-local`; macOS on Apple silicon only) | `LiquidAI/LFM3-1.7B-MLX-4bit`, `mlx-community/Nanbeige4.2-3B-OptiQ-4bit`, `mlx-community/Qwen3.5-4B-MLX-4bit` |

Both use `server: managed`: llm-ext starts and stops the model server itself. You do not run it. `local_llama` needs a llama.cpp build with LFM3 support.

- **Request broker.** A local broker serves all managed profiles. Per engine it runs one model at a time. It groups the queued requests by model and rotates to the next model when the current one has had its minimum slice and another model's request is nearing `--queue_timeout`. If a model fails, the command falls back to the next model of the same profile.
- **Calibration.** A model of a managed profile is calibrated once, automatically: on its first use, or when a model id changes in a profile that has been used (a profile nobody used is never calibrated on its own). Requests for it are held until its record is complete, which can take hours. Held requests are bounded only by `--command_timeout`. Check progress with `llm-ext models calibration-status`. Start or redo it by hand with `llm-ext models calibrate --model <id> [--force]`; `--force` is required when a record already exists.
- Calibration runs when the machine is idle: it pauses while other local jobs run or the load is high.
## Cost rules

- Default profile `free` costs nothing. Paid profiles (for example `scan quality` and `scan security` accept only `paid`) cost money.
- On a paid profile, run the command with `--estimate` first and proceed only if the predicted cost fits. `scout estimate` is the dedicated cost and time estimator for scouting, and `classify` actions take `--max_budget` (USD cap, refuses a run whose estimate exceeds it).
- On a low balance or an HTTP 402 the tool switches to free models at no cost. An empty wallet is never a reason to refuse the tool or to do the work yourself. If a report path is printed, the call worked.

## Usage rules that save you trouble

- Pass file paths, never pasted contents (`--input_files_content` exists but wastes your context).
- The remote model knows nothing about the repository: put one or two sentences of project context in `--instructions`.
- The model never sees the whole file set at once: files are packed into batches of about 400 KB. For cross-file questions about a whole codebase use `scan impl`.
- `--answer_mode` only controls report layout: 0 one report per file, 1 one per group, 2 a single merged report.
- Group files with `---GROUP:id---` ... `---/GROUP:id---` markers in the file list to get one isolated report per group.
- Secret handling flags: `--scan_secrets` (abort if secrets are found), `--redact_secrets`, `--redact_regex`.
- Give `scout *`, `scan security`, `scan quality` a long timeout (about 20 minutes) or run them in the background.

## Task to command table

| You want to | Run | Reference |
|---|---|---|
| Ask a general question about files, summarize, translate, compare | `llm ask` | references/session-and-llm.md |
| Review code for bugs with a code-review prompt | `llm code` | references/session-and-llm.md |
| Summarize a text with a hard size limit | `llm summarize` | references/session-and-llm.md |
| Extract keywords, keyphrases and language | `llm topics` | references/session-and-llm.md |
| Remove semantically duplicate phrases from a list | `llm sem-deduplicate` | references/session-and-llm.md |
| Describe in a few lines what a file is and does | `llm describe` | references/session-and-llm.md |
| Cluster sentences by meaning | `llm cluster` | references/session-and-llm.md |
| Compact a whole Claude Code session transcript (JSONL) | `session compact` | references/session-and-llm.md |
| Run one instruction over every file of a folder (cheap ensemble) | `scan folder` | references/scan-and-check.md |
| Same, with one strong paid model (deep audit) | `scan quality` | references/scan-and-check.md |
| Adjudicate suspected-malicious code (injection-hardened) | `scan security` | references/scan-and-check.md |
| Find an existing implementation of a feature across a codebase | `scan impl` | references/scan-and-check.md |
| Verify import paths exist | `check imports` | references/scan-and-check.md |
| Find broken symbol references | `check refs` | references/scan-and-check.md |
| Check source files against a spec file | `check specs` | references/scan-and-check.md |
| Diff two files, a file pair batch, or two git refs with an LLM summary | `check diff` | references/scan-and-check.md |
| Build the review plan so the host agent reviews with its own model ($0) | `check plan` | references/scan-and-check.md |
| See which per-path review rule applies to a file | `check rules` | references/scan-and-check.md |
| Extract structured fields from thousands of files | `scout register`, `preclassify`, `estimate`, `run`, then `search`/`export` | references/scout.md |
| Design the fieldset for a scout run | `scout build-fieldset`, `propose-fieldset`, `list-fieldsets` | references/scout.md |
| Inspect, compare, or chain scout jobs | `scout jobs`, `diff`, `chain`, `get`, `body-get`, `audit-sample`, `search-xjob` | references/scout.md |
| Look up an OpenRouter model's pricing, context, parameters | `models info` | references/models-and-settings.md |
| Check a model against every tool's requirements | `models assess` | references/models-and-settings.md |
| Check the configured models are healthy (free, no LLM call) | `models health` | references/models-and-settings.md |
| See new OpenRouter models, or plan replacements for degraded ones | `models discover`, `models replacements` | references/models-and-settings.md |
| Calibrate a managed local model, or see calibration progress | `models calibrate`, `models calibration-status` | references/models-and-settings.md |
| List or stop the managed local servers llm-ext started | `models server-status`, `models server-stop` | references/models-and-settings.md |
| Show effective settings, list profiles, check service and auth | `settings show`, `profile`, `profiles`, `status` | references/models-and-settings.md |
| Reload settings after a manual edit | `settings reset` | references/models-and-settings.md |
| Find local LLM servers (LM Studio, Ollama, vLLM, llama.cpp, Jan) | `settings scan-local` | references/models-and-settings.md |
| Per-item verdicts with probabilities (verify, screen, filter, label, rank, find, decide, compare, extract, audit, review, check, findings, test-output) | `classify <decision>` | references/classify.md |

When a task fits several rows, prefer the narrowest one (`scan impl` over `scan folder` for "does this already exist", `check imports` over `llm ask` for imports, `settings status` before debugging an auth problem).

## Reference files (read the one you need)

- `references/session-and-llm.md`: `session compact`, `llm ask|code|cluster|summarize|topics|sem-deduplicate|describe`.
- `references/scan-and-check.md`: `scan folder|security|quality|impl`, `check imports|refs|specs|rules|plan|diff`.
- `references/scout.md`: all 16 `scout` actions (the mass-scouting pipeline: register, preclassify, estimate, run, search, export and helpers).
- `references/models-and-settings.md`: `models info|assess|health|discover|replacements|calibrate|calibration-status`, `settings show|profile|profiles|reset|status|scan-local`.
- `references/classify.md`: the 14 `classify` decisions (`verify screen filter label rank find decide compare extract audit review check findings test-output`).

Each entry has: usage line, bare-argument flag, accepted profile types, the full description, a table of every flag with type and (required) marker, and one example.

## Flat command names (advanced)

`llm-ext --help --all` also lists flat commands; the groups dispatch to them, so the flat names appear in older docs, reports and settings. Map them like this:

| Flat command | Group form |
|---|---|
| `chat` | `llm ask` |
| `code-task` | `llm code` |
| `cluster-synonyms` | `llm cluster` |
| `summarize`, `topics`, `sem-deduplicate`, `describe` | `llm <same name>` |
| `session-summary` | `session compact` |
| `scan-folder` | `scan folder` |
| `security-scan` | `scan security` |
| `high-quality-scan` | `scan quality` |
| `search-existing-implementations` | `scan impl` |
| `check-imports`, `check-references`, `check-against-specs` | `check imports`, `check refs`, `check specs` |
| `rules-check`, `review-plan`, `compare-files` | `check rules`, `check plan`, `check diff` |
| `mass-scout` | `scout run` |
| `mass-scout-register`, `mass-scout-preclassify`, `mass-scout-estimate`, `mass-scout-search`, `mass-scout-search-xjob`, `mass-scout-get`, `mass-scout-export` | `scout register`, `scout preclassify`, `scout estimate`, `scout search`, `scout search-xjob`, `scout get`, `scout export` |
| `mass-scout-audit-sample`, `mass-scout-body-get`, `mass-scout-build-fieldset`, `mass-scout-propose-fieldset`, `mass-scout-diff`, `mass-scout-chain` | `scout audit-sample`, `scout body-get`, `scout build-fieldset`, `scout propose-fieldset`, `scout diff`, `scout chain` |
| `mass-scout-jobs-list` | `scout jobs` |
| `mass-scout-list-bundled-fieldsets` | `scout list-fieldsets` |
| `or-model-info` | `models info` (also `or-model-info-json`, `or-model-info-table`: flat only, same data as raw JSON or a Unicode table) |
| `assess-model` | `models assess` |
| `check-model-health` | `models health` |
| `discover-new-models` | `models discover` |
| `check-tool-replacements` | `models replacements` |
| `get-settings` | `settings show` |
| `profile` | `settings profile` |
| `list-profiles` | `settings profiles` |
| `reset` | `settings reset` |
| `discover` | `settings status` |
| `scan-local-llm-services` | `settings scan-local` |
| `classify-verify`, `classify-screen`, `classify-filter`, `classify-label`, `classify-rank`, `classify-find`, `classify-decide` | `classify verify`, `classify screen`, `classify filter`, `classify label`, `classify rank`, `classify find`, `classify decide` |
| `classify-compare`, `classify-extract`, `classify-audit`, `classify-review`, `classify-check`, `classify-findings`, `classify-test-output` | `classify compare`, `classify extract`, `classify audit`, `classify review`, `classify check`, `classify findings`, `classify test-output` |

Flat-only commands with no group form: `batch-check` (DEPRECATED: use `llm ask` or `llm code` with `--answer_mode 0 --max_retries 3`), `search-existing-benchmark` and `security-triage-benchmark` (benchmark a model for `scan impl` or `scan security` against a labeled golden set), `or-model-info-json`, `or-model-info-table`. Run `llm-ext <flat-command> --help` before using them.

Some descriptions still use underscore names (`scan_folder`, `mass_scout_search`, `search_existing_implementations`); these are the flat commands' old spellings of the group actions above.
