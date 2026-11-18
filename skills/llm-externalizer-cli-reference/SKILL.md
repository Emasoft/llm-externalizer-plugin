---
name: llm-externalizer-cli-reference
description: Reference for every `llm-ext` (LLM Externalizer) CLI command, flag and default. Use it whenever you run, choose or explain an `llm-ext` command, or want to offload bounded read-only work (summarize, scan, review, audit, compare, check imports/references/specs, security triage, classify, cluster, deduplicate, extract keywords, describe a file, compact a transcript, mass-scout files, inspect OpenRouter models, show or reset settings and profiles) to a cheaper or free LLM, even when the user does not say "llm-ext".
---

# llm-ext CLI reference

`llm-ext` hands bounded, read-only LLM work (read, analyze, summarize, scan, classify) to a cheaper or free model. File contents never enter your context: the command writes a report and prints its path, so you read only the report. It examines code and never edits it.

Facts here come from the live `llm-ext --help --all` and `llm-ext <group> <action> --help` output and, where help is silent (global flags, the 402 and profile-fallback behaviour), from the CLI source under `scripts/llm-ext/src/`. If this skill and the live help disagree, the live help wins; run the help again.

## Essential rules

- Pass file paths, never pasted contents, and put one or two sentences of project context in `--instructions`: the remote model knows nothing about the repository.
- On a paid profile run the command with `--estimate` first (where it accepts it) and proceed only if the cost fits; `classify` actions take `--max_budget`.
- A 402 or a low balance never switches a command to free models; rerun with `--profile free` or ask for credit.
- Give `scout *`, `scan security` and `scan quality` a long timeout (about 20 minutes) or run them in the background; `--command_timeout <s>` is accepted by every command.
- A printed report path means the call worked; read that file, not the command output.
- Details for every rule above: the cli-conventions reference below.

## Task to command table

Grouped by reference file. Read the file for the group your task falls in. Each entry has: usage line, bare-argument flag, accepted profile types, the full description, a table of every flag with type and (required) marker, and one example.

[session-and-llm](references/session-and-llm.md): `session compact`, `llm ask|code|cluster|summarize|topics|sem-deduplicate|describe`, and the flat-to-group command name table.

- `llm-ext session compact`
- `llm-ext llm ask`
- `llm-ext llm code`
- `llm-ext llm cluster`
- `llm-ext llm summarize`
- `llm-ext llm topics`
- `llm-ext llm sem-deduplicate`
- `llm-ext llm describe`
- Flat command names (advanced)

| You want to | Run |
|---|---|
| Ask a general question about files, summarize, translate, compare | `llm ask` |
| Review code for bugs with a code-review prompt | `llm code` |
| Summarize a text with a hard size limit | `llm summarize` |
| Extract keywords, keyphrases and language | `llm topics` |
| Remove semantically duplicate phrases from a list | `llm sem-deduplicate` |
| Describe in a few lines what a file is and does | `llm describe` |
| Cluster sentences by meaning | `llm cluster` |
| Compact a whole Claude Code session transcript (JSONL) | `session compact` |

[scan-and-check](references/scan-and-check.md): `scan folder|security|quality|impl`, `check imports|refs|specs|rules|plan|diff`.

- `llm-ext scan folder`
- `llm-ext scan security`
- `llm-ext scan quality`
- `llm-ext scan impl`
- `llm-ext check imports`
- `llm-ext check refs`
- `llm-ext check specs`
- `llm-ext check rules`
- `llm-ext check plan`
- `llm-ext check diff`

| You want to | Run |
|---|---|
| Run one instruction over every file of a folder (cheap ensemble) | `scan folder` |
| Same, with one strong paid model (deep audit) | `scan quality` |
| Adjudicate suspected-malicious code (injection-hardened) | `scan security` |
| Find an existing implementation of a feature across a codebase | `scan impl` |
| Verify import paths exist | `check imports` |
| Find broken symbol references | `check refs` |
| Check source files against a spec file | `check specs` |
| Diff two files, a file pair batch, or two git refs with an LLM summary | `check diff` |
| Build the review plan so the host agent reviews with its own model ($0) | `check plan` |
| See which per-path review rule applies to a file | `check rules` |

[scout](references/scout.md): all 16 `scout` actions (the mass-scouting pipeline: register, preclassify, estimate, run, search, export and helpers).

- `llm-ext scout run`
- `llm-ext scout register`
- `llm-ext scout preclassify`
- `llm-ext scout estimate`
- `llm-ext scout search`
- `llm-ext scout search-xjob`
- `llm-ext scout get`
- `llm-ext scout export`
- `llm-ext scout jobs`
- `llm-ext scout audit-sample`
- `llm-ext scout body-get`
- `llm-ext scout build-fieldset`
- `llm-ext scout propose-fieldset`
- `llm-ext scout diff`
- `llm-ext scout chain`
- `llm-ext scout list-fieldsets`

| You want to | Run |
|---|---|
| Extract structured fields from thousands of files | `scout register`, `preclassify`, `estimate`, `run`, then `search`/`export` |
| Design the fieldset for a scout run | `scout build-fieldset`, `propose-fieldset`, `list-fieldsets` |
| Inspect, compare, or chain scout jobs | `scout jobs`, `diff`, `chain`, `get`, `body-get`, `audit-sample`, `search-xjob` |

[models-and-settings](references/models-and-settings.md): `models info|assess|health|discover|replacements|calibrate|calibration-status`, `settings show|profile|profiles|reset|status|scan-local`, and the managed local models (`local_llama`, `locals-mlx`).

- `llm-ext models info`
- `llm-ext models assess`
- `llm-ext models health`
- `llm-ext models discover`
- `llm-ext models replacements`
- `llm-ext models calibrate`
- `llm-ext models calibration-status`
- `llm-ext settings show`
- `llm-ext settings profile`
- `llm-ext settings profiles`
- `llm-ext settings reset`
- `llm-ext settings status`
- `llm-ext settings scan-local`
- Managed local models
- Local inference governor
- Local decider fallback (`local_fallback`)

| You want to | Run |
|---|---|
| Look up an OpenRouter model's pricing, context, parameters | `models info` |
| Check a model against every tool's requirements | `models assess` |
| Check the configured models are healthy (free, no LLM call) | `models health` |
| See new OpenRouter models, or plan replacements for degraded ones | `models discover`, `models replacements` |
| Calibrate a managed local model, or see calibration progress | `models calibrate`, `models calibration-status` |
| List or stop the managed local servers llm-ext started; see the local inference governor figures and last denial | `models server-status`, `models server-stop` |
| Show effective settings, list profiles, check service and auth | `settings show`, `profile`, `profiles`, `status` |
| Reload settings after a manual edit | `settings reset` |
| Find local LLM servers (LM Studio, Ollama, vLLM, llama.cpp, Jan) | `settings scan-local` |

[classify](references/classify.md): the 16 `classify` decisions (`verify screen filter label rank find decide compare extract audit review check findings test-output requirements rule-check`).

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

Output: a classify command prints its text form on stdout and the receipt line (items, time, Jev tokens and cost) as the last line. Add `--json` to print the JSON envelope instead; the receipt then goes to stderr, so stdout stays one parseable JSON document. A script that parses the output must pass `--json`. `--estimate` prices the run from the catalog and sends nothing (no API key needed; it writes no `-o` report). `-o <dir>` saves the JSON envelope of every completed run, whichever output form was printed. `classify ping --estimate` is refused with `llm-ext: --estimate is not available for classify yet.` (exit 1, measured on a development build of commit 153fe531); ping does not take `--estimate`, and its help says `--no_call` sends no question.

The `--estimate` row in the flag tables below ships in llm-ext 14.3.0 and later. The flag already worked on a development build (measured 2026-11-04: `classify filter`, `rank` and `label` with `--estimate` exit 0 and print that nothing was sent). llm-ext 14.2.0 (measured 2026-11-04) has neither: `classify filter --help` does not list `--estimate`, and `llm-ext classify filter "is this a rule" ./small.txt --estimate` exits 1 with `llm-ext: --estimate is not available for classify yet.` The same 14.2.0 message appears for `classify label ... --estimate`.

Flags are written `--name value`. Boolean flags (measured for `--json` and `--estimate` on `classify filter` and `classify requirements`) are bare switches: a value after one is taken as an extra positional (file) argument. With `--input` the error is `llm-ext: --input cannot be combined with files, --items or the other file options; pass one or the other` (command `classify filter --input filter-text.json --estimate true`); without `--input` it is the usage line `llm-ext: usage: llm-ext classify requirements <file, - for stdin> [--max-bytes N]`. `--estimate` alone works. Every action also accepts the global flags (`--quiet`, `--profile <name>`, `--command_timeout <s>`, `--queue_timeout <s>`; see cli-conventions.md). All text below comes from `llm-ext <group> <action> --help`, except the sections that say they come from live runs and the source.

| You want to | Run |
|---|---|
| Per-item verdicts with probabilities (verify, screen, filter, label, rank, find, decide, compare, extract, audit, review, check, findings, test-output) | `classify <decision>` |
| Pick the explicit requirements out of a prompt, using earlier messages as context | `classify requirements` (ships in llm-ext 14.3.0 and later) (recipe: the requirements-pipeline reference below) |
| Label items with the earlier messages of the conversation as background | `classify label --context FILE` (ships in llm-ext 14.3.0 and later) (its effect on verdicts is measured as mixed: references/classify.md) (recipe: the requirements-pipeline reference below) |
| Say whether a new phrase duplicates, updates or is new against a list of existing rules (with a contradiction flag) | `classify rule-check --input FILE [--context FILE]` (not in llm-ext 14.6.5 or earlier, ships in the next release; request counts and `--max_questions_per_request`: references/classify.md) (recipe: step 2b of the requirements-pipeline reference below) |
| Check the classifier key and the decisions service (a free key check, then one paid question to the profile model; `--no_call` sends no question and checks the key, not the credit balance (ships in llm-ext 14.3.0 and later)) | `classify ping` (ships in llm-ext 14.3.0 and later; `--max_budget` does not apply; if the remote call fails or times out, ping may ask the local mlx-decision decider instead (see the classify reference above)) |

When a task fits several rows, prefer the narrowest one (`scan impl` over `scan folder` for "does this already exist", `check imports` over `llm ask` for imports, `settings status` before debugging an auth problem).

## Reference files (read the one you need)

[cli-conventions](references/cli-conventions.md): invocation grammar and global flags, where output goes, profiles and settings, managed local models, cost rules, usage rules, limits and failure modes. Read it before running a command you have not used.

- Invocation grammar
- Where output goes
- Profiles and settings
- Managed local model profiles
- Cost rules
- Usage rules that save you trouble
- Limits and failure modes

[requirements-pipeline](references/requirements-pipeline.md): detect the requirements in a prompt (`classify requirements`, `llm ask` grouping), check them against a rules file (`classify find`, `classify label`, `llm sem-deduplicate`) and write the result (`llm ask`).

- Step 1: extract the requirements from the prompt (C1 and C2)
- 1a. Score every sentence with Jev, using the earlier messages as context
- 1b. Group the sentences with the free LLM, given every sentence with its Jev label
- Step 2: check whether the rule already exists in the rules file (C3, C4, C5)
- 2a. Does one of the rules say the same thing? (C3)
- 2b. Is it a duplicate, an updated version or new? (C5)
- 2c. Deduplicate a list of rules (C4)
- Step 3: write the rule (the free LLM reformulates)

[consumer-guidelines](references/consumer-guidelines.md): for a project that calls `llm-ext` from its own session, scripts, hooks or CI: which profile to pass, background maintenance and timeouts, concurrency, the reports root, settings.yaml ownership, upgrades and pinning, exit codes and retries, local servers, cost and files never to pass.

- 1. Which profile to pass, and the missing `active:` key
- 2. Background maintenance: what runs, how long, who waits
- 3. Several commands at once, overlapping benchmarks
- 4. The reports root
- 5. settings.yaml: who writes it, what to leave alone
- 6. Upgrades and version pinning
- 7. Exit codes and what to retry
- 8. Local servers and a project's own server
- 9. Cost and what never to pass

## Flat command name forms

The flat command names (`chat`, `mass-scout-*`, `classify-*`, `get-settings` and the rest) map to the group forms in the table at the end of the session-and-llm reference above.
