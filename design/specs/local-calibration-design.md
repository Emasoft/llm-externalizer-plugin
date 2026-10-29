# Local model calibration design (P6, TRDD-1OOAH3LD, TRDD-ZGSGGHQG)

Status: draft for review (P6a, 2026-10-29). Nothing is implemented yet. P6a covers this design and the dry run in the last section only; the full calibration run (P6) waits for review.

Sources:
- design/specs/local-profiles-goal-program.md: P6a, P6, P7 and P9;
- design/specs/TRDD-1OOAH3LD-local-llama-design.md: increment 4 and the user decisions;
- design/specs/TRDD-ZGSGGHQG-locals-mlx-design.md: L3 items 3 and 4;
- design/specs/local-engine-broker-design.md: point 8, the server-count safeguard with roles main and cal;
- reports/locals-mlx/20261028_200451+0100-six-model-smoke.md.

## 1. What calibration decides, per model

| Decision | Recorded as | Used by |
|---|---|---|
| Calibration window W | `window_tokens` | every fill below is a fraction of W |
| Safe input fill, per task kind | `fill.fact`, `fill.bug` (fractions, at most 0.40) | P7 input sizing |
| Thinking on or off, per task kind | `thinking.fact`, `thinking.bug` | the request options of each command |
| Output cap, per task kind | `max_output_tokens.fact`, `max_output_tokens.bug` | `max_tokens` on every request |
| json_schema works (thinking off and on) | `structured_output.off`, `structured_output.on` | whether `response_format` is sent (P8, P9) |
| Main server shape | `main.slots`, `main.slot_ctx` | broker: `-np`/`-c` for llama-server, `--slots`/`--max-context` for Locals |
| Scouting shape (the user's "reduced context for mass-scouting") | `scouting.fill`, `scouting.slots`, `scouting.slot_ctx`, `scouting.accuracy` | P9 mass-scouting |
| Speed | `speed.prefill_tps`, `speed.decode_tps`, `speed.aggregate_decode_tps` | the user-facing estimate and the batch rotation |
| Tokens per character | `chars_per_token` | P7 byte-to-token conversion where the engine has no `/tokenize` |

**Task kinds.** There are two, scored without another model:
- **fact** (retrieval, editing, summarizing): `llm ask`, `summarize`, `topics`, `describe`, `sem-deduplicate`, `cluster`, `session compact`, `scan folder`.
- **bug** (analysis): `scan security`, `scan quality`, `scan impl`, `check imports|refs|specs|rules|plan|diff`, `llm code`.

P7 owns the exact command-to-kind table; a command missing from it is refused on a local profile until it is classified (the P10 matrix).

## 2. Where it runs: a detached runner and the cal server

**The runner.** `llm-ext __calibrate` is a detached child, started like the broker:
- an `ensureCalibrator({dir, version})` with a spawn lock and a state file `calibrator-local.json` (pid, port-free, version);
- one runner per config dir;
- a version handover finishes the current trial, saves progress and exits, as the broker does.

**Order of work.** The runner serves one model at a time, across both engines, in profile order: active profile first, then the main model, the second, the third. This matches the plan's serialized rule: "one model at a time, its record written before the next starts".

**The cal server.** The runner starts its own server through `claimAndSpawn(role: "cal")`, so the registry's limit of at most one main plus one cal per engine applies unchanged (spec point 8).
- It uses a private free port, the log marker `<engine>-server-cal.log`, and the same kill-safety checks as the main server.
- The runner restarts the cal server freely to change `-np`/`-c` or `--slots`/`--max-context` (user ruling 2026-10-28); user-facing main servers keep refuse-on-change.

**Pausing for user work** (user decision "Calibrate when idle"):
- Before every calibration request, the runner reads the broker's `/v1/health` (through `broker-local.json` and its token). If no broker is running, the machine is idle.
- If `queued + running > 0`, the runner pauses. In-flight calibration requests are aborted; an aborted trial is not counted and is run again later. A paused runner prints one line every 30 s. Waiting is never an error.
- The runner resumes once the broker reports 0 and 0 for 5 seconds in a row.
- If a pause lasts more than 5 minutes, the cal server is stopped to free its memory, and restarted on resume.
- On darwin, the memory floor applies before each calibration request as well: memory_pressure free % must be at or above `LLM_EXT_BROKER_MEMORY_FLOOR` plus 10.

**A model under calibration is not usable** (user decision "No, wait"). A request for a managed local model with no valid record fails at once, in the client before it reaches the broker, with:
`model <id> is being calibrated (step k of n, about N minutes left; llm-ext models calibration-status)`
or, when no calibration is running yet:
`model <id> is not calibrated yet; calibration started in the background (about N hours)`.
N comes from the progress file (remaining trials times the measured mean trial time). Tests that need a usable model write a real record fixture; there is no bypass switch.

**Scope.** Calibration covers managed local profiles (`server: managed`, llamacpp-local or locals-local) only: it needs a server llm-ext starts. Remote and unmanaged local profiles are not refused and not calibrated (TRDD-UT7UC025 covers remote).

## 3. Trigger, records, locks and invalidation

**Trigger.** On every boot (index.ts, after settings load and migrations), llm-ext lists the (engine, model) pairs of every managed local profile, all three models. Any pair with no valid record starts the runner (`ensureCalibrator`), which works through the pairs it reads from settings.yaml plus the records. There is no separate queue file: settings.yaml and the records are the only source of truth.

A model the user adds or changes in a profile therefore starts calibration on the next command. A model removed from every profile is dropped from the work list; its record is kept.

**Files**, under `<config dir>/calibration/<engine>/`. `<slug>` is the sanitized model id plus the first 8 hex digits of sha256(id).
- `<slug>.json`: the record. Written atomically (temp file in the same dir, then rename) and mode 0600. A record that does not parse or fails its schema check counts as missing, and the problem is logged once.
- `<slug>.progress.json`: every finished trial with its inputs and score, rewritten atomically after each trial. Resume reuses every trial whose `harness_version`, `fixture_version` and fingerprint still match, and drops the rest.
- `<slug>.lock`: a mkdir lock holding the runner's pid. It has no time limit: it is free when its pid is dead or no longer `__calibrate`, the same identity rule as the broker state. A manual `llm-ext models calibrate --model <id>` takes the same lock.

**Fingerprint** (part of the record):
- engine and model id;
- `harness_version` and `fixture_version` (constants, bumped when the method or the fixtures change);
- the resolved artifact:
  - llama: `/props` `model_path`, that file's size, and the Hugging Face snapshot revision taken from the path;
  - Locals: the snapshot revision in `models--org--name/refs/main` and the total size of the weight files.

**When a record is invalid** and the model is calibrated again:
- the record is missing or corrupt;
- `harness_version` or `fixture_version` changed;
- the fingerprint changed (the model was updated: a new snapshot revision or a different file);
- the user runs `llm-ext models calibrate --model <id> --force`.

**An engine upgrade does not invalidate a record** (user decision "Quick check only"). The record stores `engine_version`: llama-server `--version` build, or Locals `/health` version. When that changes, the next use runs a quick check: the model loads, answers one short known-answer prompt, and passes one fact trial at fill 0.10.
- Pass: `engine_version_checked` is updated.
- Fail: the record gets `status: engine-check-failed`, and requests for that model are refused with the failure and the fix (downgrade the engine, or `models calibrate --force`).

Editing other profile fields never invalidates a record.

**Precedence.** Values the user writes in the profile win over the record, which wins over built-in defaults (increment 1 rule). `request_options` covers thinking, `max_output_tokens`, `input_fill_pct` and `structured_output`.

Open point for review: the P5 built-ins write `context_window: 8192`. llm-ext wrote it, but it is indistinguishable from a user value, so it would override the calibrated shape for ever. **Proposal:** remove `context_window` from `builtinLocalProfiles()` before the next dist build. No user install has received the step yet: the dist after b942e608 has not been rebuilt.

## 4. The method, in order

Every phase writes its trials to progress, so a crash or sleep resumes mid-phase.

### 4.1 Capabilities
- **llama:** `/props` → `chat_template_caps` (thinking support), `n_ctx_train` (from `/v1/models` meta).
- **Locals:** `/v1/models` → `context_length`, and whether a `-thinking` id is listed.

A capability the model lacks is recorded as unsupported, and its phase is skipped (for example, no thinking probe).

### 4.2 Window W
- Start with `W = min(n_ctx_train, 131072)`. The cap keeps 40 % prompts (52k tokens) inside the time budget.
- Load the cal server with one slot and context W.
- If the load fails, or post-load memory falls below the floor plus 10 % (darwin memory_pressure; elsewhere, more than 60 % of RAM resident), halve W and retry, down to a minimum of 8192.
- Locals prints the most it can hold ("requests up to N tokens … what fits in GPU memory", measured), and W never exceeds that N.
- Then measure `chars_per_token` with three probe documents: `/tokenize` on llama; on Locals, `usage.prompt_tokens` of a 1-token completion, because Locals has no `/tokenize`.

### 4.3 Fixtures (committed, deterministic, seeded)
**Fact trial.**
- Filler: seeded synthetic prose documents, so there is no repeated pattern and nothing the model knows by heart.
- Planted: one sentence of the form "The access code for vault <name> is <8-char code>.", plus 3 decoy vaults with different names and codes.
- Question: the code for <name>, code only.
- **Pass:** the correct code appears verbatim in the answer and no decoy code appears.

**Bug trial.**
- Filler: real source files from a pinned, committed fixture corpus (permissive-licence code, with the corpus hash in `fixture_version`).
- Planted: one of 20 committed small functions, each with exactly one injected bug (off-by-one, inverted condition, wrong variable, missing await…), with its known line and identifier, inside a file at the chosen position.
- Question: name the file and line of the single bug.
- **Pass:** the answer names that line, or the changed identifier together with the file.

**Position.** The planted item goes at 5 %, 25 %, 50 %, 75 % or 95 % of the filler, one position per repeat. 5 repeats therefore cover all five positions, and a step with more repeats cycles through them.

**Sizing.** The prompt is built to the target fill through `chars_per_token`, checked against the real `usage.prompt_tokens` of the reply. A trial whose real fill is more than 3 % off its step is rebuilt, never scored.

### 4.4 Thinking (only when supported)
- At fill 0.10, run 5 trials per task kind with thinking off and 5 with thinking on: 20 trials.
  - Thinking off: `chat_template_kwargs.enable_thinking: false`.
  - Thinking on: llama with `enable_thinking: true`; Locals with the `-thinking` id.
- **Rule:** on for that kind only if its pass count is at least the off count plus 1. Otherwise off, which is cheaper.
- The same trials give the output caps:
  - thinking off: the cap is the smallest of 256, 512, 1024 and 2048 under which at least 95 % of trials finished with `finish_reason: stop`;
  - thinking on: the cap is the p95 of (reasoning + answer tokens) times 1.25, rounded up to 256.
  - The probe runs with a generous cap (4096, or 16384 with thinking on).

### 4.5 Safe input fill (the grid)
- Grid: 0.10, 0.20, 0.30, 0.35 and 0.40 of W. Each task kind runs in its chosen thinking mode, with at least 5 repeats per step.
- **Pass rule:** a step passes for a task kind when at least 80 % of its trials pass. The task kind's fill is the highest step that passes, with every lower step also passing. The grid stops at the first failing step, which saves time. Hard cap: 0.40.
- If step 0.10 fails, step 0.05 is tried. If 0.05 also fails, the task kind is recorded as unfit (`fill: 0`), and commands of that kind are refused on that model with a clear message.

### 4.6 Structured output
- Send a small json_schema (`response_format` type `json_schema`, strict) 3 times with thinking off and 3 times with thinking on (only if thinking is supported).
- **Pass, per mode:** HTTP 200 in all 3, and every reply parses and validates against the schema.
- HTTP 400 is recorded as unsupported with the server's error text. The known answer is Nanbeige GGUF = false; this check is part of the dry-run acceptance below.

### 4.7 Main server shape (slots and context)
- **Per-slot context:** `slot_ctx = roundup_256(max(fill.fact, fill.bug) × W + max(max_output_tokens) + 512 overhead)`. This is the user's "context capped at calibrated usable share times parallel slots".
- **Slot candidates:** 1, 2, 4 and 8 (`-np n -c n×slot_ctx`, or Locals `--slots n --max-context slot_ctx`). A candidate is skipped when its load fails the memory rule of 4.2.
- **Measurement:** for each candidate, n concurrent fact trials at the fact fill, repeated twice, measuring aggregate decode tok/s and pass rate.
- **Choice:** the smallest n whose aggregate decode tok/s is at least 90 % of the best candidate and whose pass rate is at least 80 %.
- The broker then starts the main server from the record. This replaces the provisional `MAIN_SLOTS = 2` and `LOCALS_MAIN_SLOTS = 4`.

### 4.8 Scouting shape (reduced context for mass-scouting)
- **Workload:** the existing scout-accuracy fixture (`mass_scouting/scout-accuracy-fixture.ts`: frontmatter records, positional labels, at least 40 records).
- **Shares:** 0.02, 0.05 and 0.10 of W per request, at slots 4, 8 and 16 (memory rule of 4.2).
- **Pass:** accuracy at or above the scout-accuracy threshold (`scout_accuracy_threshold`, default 0.95, the existing gate). A model without structured output runs the fixture with the schema in the prompt and its text parsed, as P8/P9 do.
- **Record:** the highest passing share; then, at that share, the slot count with the best aggregate records per second; plus its slot context, measured accuracy and records per second.
- If no share passes, the record gets `scouting: unfit`, and mass-scouting refuses that model (the quality gate is kept, never skipped).
- The broker already keys queues by (model, ctx), so scouting requests run on their own server shape.

### 4.9 Speed
- llama: `timings.prompt_per_second` and `predicted_per_second`, at fill 0.10 and at the fact fill, single slot.
- Locals: streaming time-to-first-token for prefill, and completion tokens over the remaining wall time for decode.
- Plus `aggregate_decode_tps` at the chosen slots.

## 5. Time budget per model
Prompt tokens per model: about 2W for the thinking probe (20 trials at 0.10), plus up to 13.5W for the grid (5 repeats × 2 kinds × 1.35), plus small amounts for slots, scouting and json_schema. That is about 16W.

| Model | Prefill | W = 131072 |
|---|---|---|
| LFM3 1.7B | about 700 tok/s (measured) | about 50 min of prefill |
| 4B models | assumed about 250 tok/s | about 2.3 h |

Decode and loads add roughly 30 %.

- **Target:** at most 4 h wall per model, pauses not counted. After the thinking probe, the measured prefill rate gives an estimate. If the estimate exceeds 4 h, W is halved before the grid, and this is recorded as `window_reduced_for_budget: true`.
- The six models run serialized: about 8 to 20 h in total. The user is told this up front, along with the "No, wait" consequence: a profile's models are unusable until each is calibrated.

## 6. How commands consume a record (P7, P9)
For a request of task kind k on model m, with record R:
- **Input budget (tokens):** `floor(R.fill[k] × R.window_tokens) − prompt_overhead_tokens`. It is converted to bytes with `/tokenize` (llama) or `R.chars_per_token` (Locals). It replaces the 400 KB default for managed local profiles. An explicit per-call `max_payload_kb`, then the profile's `request_options.input_fill_pct`, still win.
- **Other request fields:**
  - `max_tokens`: `R.max_output_tokens[k]`;
  - thinking: `R.thinking[k]`;
  - `response_format`: sent only when `R.structured_output[mode]` is true.
- **Broker:**
  - the main server starts with `R.main.slots` and `R.main.slot_ctx`;
  - scouting requests use `R.scouting.*`;
  - the broker dispatches at most that many requests at once.
- **Unfit:** a task kind recorded as `fill: 0`, or `scouting: unfit`, is refused on that model with a message naming the record.
- **Reading:** records are read once per command; a missing or invalid record is the "No, wait" refusal of section 2.

## 7. Record schema (version 1)
```json
{"schema": 1, "harness_version": 1, "fixture_version": 1,
 "engine": "llama|locals", "model": "<profile id>",
 "fingerprint": {"artifact": "<path or repo>", "revision": "<snapshot>", "bytes": 0},
 "engine_version": "...", "engine_version_checked": "...", "status": "ok|engine-check-failed",
 "calibrated_at": "<ISO>", "duration_s": 0, "window_tokens": 0, "window_reduced_for_budget": false,
 "chars_per_token": 0,
 "capabilities": {"thinking": true, "n_ctx_train": 0},
 "thinking": {"fact": false, "bug": true},
 "max_output_tokens": {"fact": 0, "bug": 0},
 "fill": {"fact": 0.3, "bug": 0.2},
 "grid": [{"kind": "fact", "fill": 0.1, "trials": 5, "passed": 5}],
 "structured_output": {"off": true, "on": false, "error": "..."},
 "main": {"slots": 2, "slot_ctx": 0},
 "scouting": {"fill": 0.05, "slots": 8, "slot_ctx": 0, "accuracy": 0.97, "records_per_s": 0},
 "speed": {"prefill_tps": 0, "decode_tps": 0, "aggregate_decode_tps": 0}}
```
The record is checked against this schema on read. Writing a record that fails the schema check is a bug and throws.

## 8. Commands
- `llm-ext models calibration-status`: every managed model, its record status or progress, and the time left.
- `llm-ext models calibrate --model <id> [--force]`: queues the model and starts the runner (detached), then returns at once.
- `llm-ext models server-status` and `server-stop`: also list and stop the cal servers.

## 9. Tests (P6b, real, no mocks)
- **Unit:**
  - scoring (fact: exact code and no decoy; bug: line or identifier);
  - fixture determinism (same seed, same text);
  - the grid's pass rule and contiguity;
  - the 0.05 fallback;
  - the thinking rule;
  - output-cap selection;
  - slot selection;
  - record schema read and write, corrupt record counted as missing, invalidation by every listed cause.
- **Real:** with the tiny GGUFs CI already uses, a full run with a reduced harness (fills 0.10 and 0.20, 2 repeats, W 2048) checks the mechanics:
  - cal role in the registry, never more than 1 cal and 1 main;
  - an atomic record;
  - resume after SIGKILL of the runner mid-phase, reusing finished trials;
  - pause while a broker job runs (a real client job), with aborted trials not counted;
  - the "No, wait" refusal while the record is missing;
  - the tiny models will mostly score unfit: the test checks the recorded verdicts and the mechanics, not their quality.
- **Opt-in** (`RUN_REAL_LOCAL_MODELS=1`): the dry run below.

## 10. P6a dry run (after review; about 30 minutes, LFM3 GGUF only)
`AtomicChat/LFM3-1.7B-Uncensored-GGUF:AD-Q6_K` on a cal server, with a reduced harness:
- W = 32768;
- thinking probe with 2 trials per mode and kind;
- grid fills 0.10 and 0.20 with 2 repeats;
- json_schema;
- slots 1 and 2;
- scouting share 0.05 at slots 4.

Plus the Nanbeige GGUF json_schema check only (known answer: unsupported).

**Acceptance:**
- a record that passes the schema check;
- registry entries with role cal only (the main untouched);
- one SIGKILL of the runner and a resume that reuses the finished trials;
- one real `llm ask` on another local model during the run that pauses calibration, with the pause and resume logged;
- `~/.locals/config.json`, port 8321 and the user's processes untouched.

Results go to `reports/llama-cpp-profile/<ts>-p6a-dry-run.md` with the measured trial time, which calibrates the section 5 budget.

## 11. Open points for review
1. Remove `context_window: 8192` from the built-in profiles (section 3) before the next dist build.
2. The 131072 cap on W. The user cited LFM3's 256k window and said usage stays under 30-40 %. The 40 % hard cap applies to W, so with W capped at 131072 the largest calibrated prompt is about 52k tokens, not 104k. Raising the cap doubles the time.
3. The "No, wait" refusal makes `local_llama` and `locals-mlx` unusable for hours after install, until their three models are calibrated each (the P6 program line says the user is told up front).
4. The 5-minute pause rule that stops the cal server is provisional.
