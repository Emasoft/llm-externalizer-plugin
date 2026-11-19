# llm-ext reference: CLI conventions

Invocation grammar, global flags, output location, profiles, managed local models, cost rules, usage rules and failure modes shared by every `llm-ext` command.

## Contents

- Invocation grammar
- Where output goes
- Profiles and settings
- Managed local model profiles
- Cost rules
- Usage rules that save you trouble
- Limits and failure modes

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
- Flags are `--snake_case value`. Array and object flags are typed `[array]`/`[object]`/`[oneOf]` in help; JSON is the safe encoding for them (a JSON array passed to `--field` was accepted by the parser in a trial run). Always run `<group> <action> --help` once before using an action you have not used, because required flags (marked `(required)`) differ per action. Outside `classify`, a bare `--` is refused: in the release after 14.7.4 the error names it (`llm-ext: a bare '--' is not supported by '<command>': ...`), earlier releases print `llm-ext: unknown flag -- for '<command>'`; pass every input as a named flag or as the command's positional argument.
- Global flags on every action (place them AFTER the group and action; `llm-ext --quiet scout ...` is rejected as an unknown command): `--quiet` (suppress banner and progress lines) and `--profile <name>` (settings profile for this call only; an unknown name fails fast and lists the profiles). Two more flags, parsed globally but accepted per command: `--estimate` (dry-runs the invocation and prints the predicted cost instead of dispatching; on the `free` profile it refuses while no free model is usable yet) and `--preview` (dry-runs the file selection and prints each candidate as included or excluded with the reason). Not every command accepts both: about a third of the commands that send model requests accept both, a few only one, and about a third neither (for example `scout run`, `scout chain`, `scan security`, `llm cluster`, `session compact`); a refused flag exits with an error and spends nothing (`llm cluster` has no `--estimate` row in its help; given anyway, it exits 1 with `llm-ext: estimate aborted — file resolution failed: no input_files_paths or folder_path given`, whether the input is the bare argument or `--input_file`, because the dry run reads only `input_files_paths` and `folder_path`, which `llm cluster` does not take; measured on 14.7.3). In llm-ext 14.3.0 and later, a command's `--help` lists only the dry-run flags it accepts; older builds list both on every command. Where accepted, they make zero LLM calls. In llm-ext 14.3.0 and later, the `classify` decision commands (15 in 14.3.0; 16 since 14.7.0, which adds `rule-check`) accept `--estimate` (no decision request is sent, no API key is needed; unless cached, it fetches the public decisions catalog and the model's endpoint limit from openrouter.ai, so it is not offline) but not `--preview`; `classify ping` accepts neither (it prints "--estimate is not supported by classify ping, which has no dry run; use --no-call to check the key without asking the question"). `classify` actions also take `--max_budget`.
- Two more global flags, also AFTER the action, accepted by every command: `--command_timeout <s>` (aliases `--command-timeout`, `--timeout`; `=` or a space; whole seconds, at most 2147483; no limit by default): any command still running when it expires exits 124. On expiry a command that sends model requests starts no new model request on any profile (remote ones included; a request already in flight is not aborted) and cancels its jobs at the local broker, then writes the per-file results already complete, lists every unfinished file in its summary (with the timeout as the reason) and exits 124. Any command still running 30 s after the timeout is killed (exit 124); that is how a command that sends no model requests ends. `--queue_timeout <s>` (alias `--queue-timeout`) applies only to local models served through the broker: once a request's wait nears it, its model gets the server after the current model's minimum slice, so the worst wait is about the queue timeout plus the minimum run (default 300 s; a large value such as 99990 lets the request wait); waiting is never an error.
- `--stop_on_errors` (alias `--stop-on-errors`; no value; also AFTER the action, accepted by every command): ends the command on the first model of the profile chain that does not respond or is not found, instead of falling back to the next model (the default). It starts no new model request, keeps the finished results, lists the unfinished files with the model and cause, and exits 6 (124 stays `--command_timeout`). A request waiting for memory is never such a failure. It covers the profile fallback chain and the free-pool rotation, not an ensemble member or the classify commands.
- `--network_give_up <s>` (alias `--network-give-up`; `=` or a space; whole seconds; also AFTER the action, accepted by every command; default 30, settings.yaml key `network_give_up_seconds`, 1-299: below the 300 s retry window, a larger value is an error): how long consecutive network-level failures of the remote service (refused or reset connections, failing name lookup, unreachable network) are retried before the call ends with the network error instead of retrying for up to 5 minutes. Armed only when a strict provider probe gets no genuine answer AND a local profile is ready now; otherwise the existing retries run unchanged. After the give-up, a `free` or `paid` command finishes on the ready local profile with one stderr warning and stays local for the rest of the command; a static user-defined profile ends with the network error. The settings.yaml section `fallback_to_local` switches this fallback off (`enabled: false`, and the window is then never armed) or pins it to one managed local profile (`profile`). See models-and-settings.md.
- Even actions that make no LLM call (for example `scout build-fieldset`) were observed refusing to run in a brand-new empty config home while no `free` model had been benchmarked yet in that config home ("no model of the 'free' profile is working right now ... retry later"). That is a profile-readiness gate, not a syntax error; wait or use a configured profile.
- A typo in a group or action name exits non-zero and suggests the right verb.
- Help text for flag descriptions is cut at about 100 characters with "..."; the action description above the flag list is complete. The `classify` flag tables in classify.md are the exception: they give such a row whole.

## Where output goes

Reports are written to `<project>/reports/llm-externalizer/` and the path is printed on stdout. Read that file (with your normal file-reading tool) instead of asking for the content. Pass `--output_dir <abs path>` (many actions) to redirect; `-o <dir>` is a working global shorthand for the action's output option (`--output_dir`; for `session compact` it maps to `--output`), e.g. `llm-ext session compact ./session.jsonl -o /tmp`. Actions with no output option (for example `settings show`) refuse it with "no output option".
Intermediate output (the per-file pieces of a merged run, a partial run, model-pool benchmark and health reports) defaults to `<root>/reports_dev/llm-externalizer/<sub>/`; final reports stay in `reports/llm-externalizer/` (TRDD-PNU8XECB). llm-ext creates `<root>/reports_dev/llm-externalizer/` with a `.gitignore` of `*` (never overwriting an existing one) so its intermediate files are never committed; this does not apply to a folder you chose with `LLM_EXT_SCRATCH_DIR` or `LLM_EXT_OUTPUT_DIR`. Files you write yourself follow the same split: scratch to the `*_dev` folders (gitignored), final files to the tracked ones.

Scout and classify actions have their own output rules; see their reference files.

## Profiles and settings

- Settings live in `~/.llm-externalizer/settings.yaml` (override the directory with the env var `LLM_EXT_CONFIG_DIR`). A legacy `settings.yml` is not read.
- A profile is a key under `profiles:`. Precedence: `--profile` flag, then the `active:` key, then the built-in `free` profile.
- Profile types gate actions: each action lists "Accepted profile types" in its help: `local`, `free`, `paid`, `any`, plus the special `classifier` (all `classify` actions) and `scouting` (scout actions that call the LLM). A mismatch fails fast.
- Configuration is user-only. The CLI is read-only: `settings show|profile|profiles|status` inspect, `settings reset` clears caches and reloads, `settings scan-local` finds local LLM servers. To change a model, profile or key, tell the user to edit `settings.yaml`, then run `llm-ext settings reset`.
- Test or worker runs that must not touch the real configuration need a throwaway home: `T=$(mktemp -d); HOME=$T LLM_EXT_CONFIG_DIR=$T/cfg LLM_EXT_INSTALL_RULE=0 llm-ext ...`. Running with the real HOME can rewrite the user's global rule file.

## Managed local model profiles

The built-in `local_llama` and `locals-mlx` profiles (managed servers, request broker, calibration) are described at the end of [models-and-settings](models-and-settings.md). Select one with `--profile local_llama` or `--profile locals-mlx`; calibration of a model can take hours and is checked with `llm-ext models calibration-status`.

Every local model run (managed or a direct send to a server on this machine) is admitted by a machine-wide governor: RAM and CPU limits and `max_inferences`, set under `local_governor` in `settings.yaml` or by `LLM_EXT_GOVERNOR_*` env. A wait is never an error; `llm-ext models server-status` shows the figures, each waiter with its own limits, and the last denial. Details and what it does not promise: the "Local inference governor" section of [models-and-settings](models-and-settings.md).

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
- Input shaping flag: `--line_numbers` on `llm ask`, `scan folder` and `scan quality` prefixes every file line with its number (`NNNNNN | `). Default off. About 9 bytes more per line.
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

