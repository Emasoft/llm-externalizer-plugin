---
name: llm-externalizer-cli-reference
description: Reference for every `llm-ext` (LLM Externalizer) CLI command, flag and default. Use it whenever you run, choose or explain an `llm-ext` command, or want to offload bounded read-only work (summarize, scan, review, audit, compare, check imports/references/specs, security triage, classify, cluster, deduplicate, extract keywords, describe a file, compact a transcript, mass-scout files, inspect OpenRouter models, show or reset settings and profiles) to a cheaper or free LLM, even when the user does not say "llm-ext".
---

# llm-ext CLI reference

`llm-ext` hands bounded, read-only LLM work (read, analyze, summarize, scan, classify) to a cheaper or free model. File contents never enter your context: the command writes a report and prints its path, so you read only the report. It examines code and never edits it.

Facts here come from the live `llm-ext --help --all` and `llm-ext <group> <action> --help` output and, where help is silent (global flags, the 402 and profile-fallback behaviour), from the CLI source under `scripts/llm-ext/src/`. If this skill and the live help disagree, the live help wins; run the help again.

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
- Global flags on every action (place them AFTER the group and action; `llm-ext --quiet scout ...` is rejected as an unknown command): `--quiet` (suppress banner and progress lines) and `--profile <name>` (settings profile for this call only; an unknown name fails fast and lists the profiles). Two more flags, parsed globally but accepted per command: `--estimate` (dry-runs the invocation and prints the predicted cost instead of dispatching; on the `free` profile it refuses while no free model is usable yet) and `--preview` (dry-runs the file selection and prints each candidate as included or excluded with the reason). Not every command accepts both: about a third of the commands that send model requests accept both, a few only one, and about a third neither (for example `scout run`, `scout chain`, `scan security`, `llm cluster`, `session compact`); a refused flag exits with an error and spends nothing. In a build that includes the per-command dry-run listing (in no release yet), a command's `--help` lists only the dry-run flags it accepts; older builds list both on every command. Where accepted, they make zero LLM calls. In a build that includes classify `--estimate` (in no release yet), the 15 `classify` decision commands accept `--estimate` (no decision request is sent) but not `--preview`; `classify ping` accepts neither (it prints "--estimate is not available for classify yet"). `classify` actions also take `--max_budget`.
- Two more global flags, also AFTER the action, accepted by every command: `--command_timeout <s>` (aliases `--command-timeout`, `--timeout`; `=` or a space; whole seconds, at most 2147483; no limit by default): any command still running when it expires exits 124. On expiry a command that sends model requests starts no new model request on any profile (remote ones included; a request already in flight is not aborted) and cancels its jobs at the local broker, then writes the per-file results already complete, lists every unfinished file in its summary (with the timeout as the reason) and exits 124. Any command still running 30 s after the timeout is killed (exit 124); that is how a command that sends no model requests ends. `--queue_timeout <s>` (alias `--queue-timeout`) applies only to local models served through the broker: once a request's wait nears it, its model gets the server after the current model's minimum slice, so the worst wait is about the queue timeout plus the minimum run (default 300 s; a large value such as 99990 lets the request wait); waiting is never an error.
- `--stop_on_errors` (alias `--stop-on-errors`; no value; also AFTER the action, accepted by every command): ends the command on the first model of the profile chain that does not respond or is not found, instead of falling back to the next model (the default). It starts no new model request, keeps the finished results, lists the unfinished files with the model and cause, and exits 6 (124 stays `--command_timeout`). A request waiting for memory is never such a failure. It covers the profile fallback chain and the free-pool rotation, not an ensemble member or the classify commands.
- Even actions that make no LLM call (for example `scout build-fieldset`) were observed refusing to run in a brand-new empty config home while no `free` model had been benchmarked yet in that config home ("no model of the 'free' profile is working right now ... retry later"). That is a profile-readiness gate, not a syntax error; wait or use a configured profile.
- A typo in a group or action name exits non-zero and suggests the right verb.
- Help text for flag descriptions is cut at about 100 characters with "..."; the action description above the flag list is complete.

## Where output goes

Reports are written to `<project>/reports/llm-externalizer/` and the path is printed on stdout. Read that file (with your normal file-reading tool) instead of asking for the content. Pass `--output_dir <abs path>` (many actions) to redirect; `-o <dir>` is a working global shorthand for the action's output option (`--output_dir`; for `session compact` it maps to `--output`), e.g. `llm-ext session compact ./session.jsonl -o /tmp`. Actions with no output option (for example `settings show`) refuse it with "no output option".
Intermediate output (the per-file pieces of a merged run, a partial run, model-pool benchmark and health reports) defaults to `<root>/reports_dev/llm-externalizer/<sub>/`; final reports stay in `reports/llm-externalizer/` (TRDD-PNU8XECB). Files you write yourself follow the same split: scratch to the `*_dev` folders (gitignored), final files to the tracked ones.

Scout and classify actions have their own output rules; see their reference files.

## Profiles and settings

- Settings live in `~/.llm-externalizer/settings.yaml` (override the directory with the env var `LLM_EXT_CONFIG_DIR`). A legacy `settings.yml` is not read.
- A profile is a key under `profiles:`. Precedence: `--profile` flag, then the `active:` key, then the built-in `free` profile.
- Profile types gate actions: each action lists "Accepted profile types" in its help: `local`, `free`, `paid`, `any`, plus the special `classifier` (all `classify` actions) and `scouting` (scout actions that call the LLM). A mismatch fails fast.
- Configuration is user-only. The CLI is read-only: `settings show|profile|profiles|status` inspect, `settings reset` clears caches and reloads, `settings scan-local` finds local LLM servers. To change a model, profile or key, tell the user to edit `settings.yaml`, then run `llm-ext settings reset`.
- Test or worker runs that must not touch the real configuration need a throwaway home: `T=$(mktemp -d); HOME=$T LLM_EXT_CONFIG_DIR=$T/cfg LLM_EXT_INSTALL_RULE=0 llm-ext ...`. Running with the real HOME can rewrite the user's global rule file.

## Managed local models

The built-in `local_llama` and `locals-mlx` profiles (managed servers, request broker, calibration) are described at the end of `references/models-and-settings.md`. Select one with `--profile local_llama` or `--profile locals-mlx`; calibration of a model can take hours and is checked with `llm-ext models calibration-status`.

Every local model run (managed or a direct send to a server on this machine) is admitted by a machine-wide governor: RAM and CPU limits and `max_inferences`, set under `local_governor` in `settings.yaml` or by `LLM_EXT_GOVERNOR_*` env. A wait is never an error; `llm-ext models server-status` shows the figures, each waiter with its own limits, and the last denial. Details and what it does not promise: the "Local inference governor" section of `references/models-and-settings.md`.
## Cost rules

- Default profile `free` costs nothing. Paid profiles (for example `scan quality` and `scan security` accept only `paid`) cost money.
- On a paid profile, run the command with `--estimate` first where the command accepts it (a refused flag exits with an error and spends nothing), and proceed only if the predicted cost fits. `scout estimate` is the dedicated cost and time estimator for scouting, and `classify` actions take `--max_budget` (USD cap, refuses a run whose estimate exceeds it).
- A 402 or a low balance never switches the command to free models: a command sticks to its selected profile and, on a 402, falls back only to the next model of that same profile. When the profile is exhausted the command fails (non-classify commands exit 1 with the credit error, `classify` exits 3). Free runs only when selected with `--profile free` or `active: free`. An empty wallet is a reason to rerun with `--profile free` or to ask for credit, never to refuse the tool or to do the work yourself. A printed report path means that file's call worked; a multi-file run with any failed file or an abort still prints the finished report paths on stdout plus a `FAILED (n of m):` block, and exits 1.

## Usage rules that save you trouble

- Pass file paths, never pasted contents (`--input_files_content` exists but wastes your context).
- The remote model knows nothing about the repository: put one or two sentences of project context in `--instructions`.
- The model never sees the whole file set at once: files are packed into batches of about 400 KB. For cross-file questions about a whole codebase use `scan impl`.
- `--answer_mode` only controls report layout: 0 one report per file, 1 one per group, 2 a single merged report.
- Group files with `---GROUP:id---` ... `---/GROUP:id---` markers in the file list to get one isolated report per group.
- Secret handling flags: `--scan_secrets` (abort if secrets are found), `--redact_secrets`, `--redact_regex`.
- Give `scout *`, `scan security`, `scan quality` a long timeout (about 20 minutes) or run them in the background.

## Limits and failure modes

- `.md` files are EXCLUDED from folder scans by default; pass `--instructions` for a semantic search that includes them. Structural validation of plugins and skills belongs to CPV or `claude plugin validate .`, not an LLM.
- The model sees only 1-5 files per request, so it cannot cross-check a reference in file A against file B. Cross-file API validation: `check specs` with an explicit spec. "Is it already implemented?": `scan impl`.
- Batching: files are packed 1-5 per request (about 400 KB). An ensemble gives 3 responses per file; free and local profiles give 1. Default `--answer_mode` is 0 for `scan folder` and 2 for the other actions.
- Long-running actions (`scan folder|security|quality`, `scout *`, `llm code` on a big folder) need an extended Bash timeout or `run_in_background: true`. Background commands are capped at 30 min (max 2 h) in unattended sessions (`-p`, CI); interactive sessions are uncapped. There is no server process that keeps work alive between calls.
- Local models served by the broker: `llm-ext models calibration-status` and `llm-ext models calibrate --model <id> [--force]` show or force the one-time calibration.

| Symptom | Cause and fix |
|---|---|
| Timeout on a big file | Reasoning models get extended time automatically; otherwise split the file or raise `--command_timeout` |
| Auth error | The API key env var is not set; run `llm-ext settings status` and ask the user to set it |
| Empty response | The file exceeds the model limit; split it or change model |

Examples (add `--estimate` first on a paid profile, where the command accepts it; a free profile costs $0):

```bash
llm-ext llm code --folder_path /path/to/src --extensions '[".ts"]' --instructions "Find bugs. Node.js Express API."
llm-ext check diff --input_files_paths '["/path/old.ts","/path/new.ts"]' --instructions "Focus on API breaking changes"
llm-ext scan impl --feature_description "rate-limited HTTP client with retry backoff" --folder_path /path/to/codebase --source_files '["/path/to/pr/http_client.py"]'
```

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
| List or stop the managed local servers llm-ext started; see the local inference governor figures and last denial | `models server-status`, `models server-stop` | references/models-and-settings.md |
| Show effective settings, list profiles, check service and auth | `settings show`, `profile`, `profiles`, `status` | references/models-and-settings.md |
| Reload settings after a manual edit | `settings reset` | references/models-and-settings.md |
| Find local LLM servers (LM Studio, Ollama, vLLM, llama.cpp, Jan) | `settings scan-local` | references/models-and-settings.md |
| Per-item verdicts with probabilities (verify, screen, filter, label, rank, find, decide, compare, extract, audit, review, check, findings, test-output) | `classify <decision>` | references/classify.md |
| Pick the explicit requirements out of a prompt, using earlier messages as context | `classify requirements` (needs a release that includes it) | references/classify.md, references/requirements-pipeline.md |
| Label items with the earlier messages of the conversation as background | `classify label --context FILE` (needs a release that includes it) | references/classify.md, references/requirements-pipeline.md |
| Check the classifier key and the decisions service (a free key check, then one paid question to the profile model; `--no_call` sends no question and checks the key, not the credit balance (needs a release that includes it)) | `classify ping` (needs a release that includes it; `--max_budget` does not apply; in a build that includes it, if the remote call fails or times out, ping may ask the local mlx-decision decider instead (see `references/classify.md`)) | references/classify.md |

When a task fits several rows, prefer the narrowest one (`scan impl` over `scan folder` for "does this already exist", `check imports` over `llm ask` for imports, `settings status` before debugging an auth problem).

## Reference files (read the one you need)

- `references/session-and-llm.md`: `session compact`, `llm ask|code|cluster|summarize|topics|sem-deduplicate|describe`, and the flat-to-group command name table.
- `references/scan-and-check.md`: `scan folder|security|quality|impl`, `check imports|refs|specs|rules|plan|diff`.
- `references/scout.md`: all 16 `scout` actions (the mass-scouting pipeline: register, preclassify, estimate, run, search, export and helpers).
- `references/models-and-settings.md`: `models info|assess|health|discover|replacements|calibrate|calibration-status`, `settings show|profile|profiles|reset|status|scan-local`, and the managed local models (`local_llama`, `locals-mlx`).
- `references/classify.md`: the 15 `classify` decisions (`verify screen filter label rank find decide compare extract audit review check findings test-output requirements`).
- `references/requirements-pipeline.md`: detect the requirements in a prompt (`classify requirements`, `llm ask` grouping), check them against a rules file (`classify find`, `classify label`, `llm sem-deduplicate`) and write the result (`llm ask`).
- `references/consumer-guidelines.md`: for a project that calls `llm-ext` from its own session, scripts, hooks or CI: which profile to pass, background maintenance and timeouts, concurrency, the reports root, settings.yaml ownership, upgrades and pinning, exit codes and retries, local servers, cost and files never to pass.

Each entry has: usage line, bare-argument flag, accepted profile types, the full description, a table of every flag with type and (required) marker, and one example.

## Flat command names (advanced)

The flat command names (`chat`, `mass-scout-*`, `classify-*`, `get-settings` and the rest) map to the group forms in the table at the end of `references/session-and-llm.md`.
