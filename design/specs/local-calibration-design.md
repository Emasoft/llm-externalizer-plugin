# Local model calibration design (P6, TRDD-1OOAH3LD, TRDD-ZGSGGHQG)

Status: revision 2 (2026-10-29), after the adversarial review `reports/llama-cpp-profile/20261029_033854+0100-calibration-design-review.md` (22 findings) and the coordinator's binding decisions. Nothing is implemented yet. P6a covers this design and the dry run in section 10; the full calibration (P6) waits for review. Section 12 maps every finding to what changed; section 11 lists the questions for the user.

Sources:
- design/specs/local-profiles-goal-program.md: P6a, P6, P7, P8 and P9;
- design/specs/TRDD-1OOAH3LD-local-llama-design.md: increment 4 and the user decisions;
- design/specs/TRDD-ZGSGGHQG-locals-mlx-design.md: L3 items 3 and 4;
- design/specs/local-engine-broker-design.md: point 8, the server-count safeguard with roles main and cal;
- reports/locals-mlx/20261028_200451+0100-six-model-smoke.md.

User rulings this design follows (card 1OOAH3LD):
- L58: input errors grow above 35-40 % of the window; "test it well".
- L62-63: thinking can be disabled for simple tasks like text editing, and enabled for bug search.
- L68: "No, wait" to using a model while it is being calibrated (read here as: the request waits, section 2).
- L73: calibration is triggered only when a new or updated model is added or edited in the profile.
- L86-87: not having enough memory is not a failure; the request waits in a queue.

## 1. What calibration decides, per model

| Decision | Recorded as | Used by |
|---|---|---|
| Calibration window W | `window_tokens` (32768 unless the user extends it, section 11) | the grid's upper bound |
| Safe input size, per task kind | `fill_tokens.fact`, `fill_tokens.aggregate`, `fill_tokens.bug` (absolute tokens, at most 0.40 × W) | P7 input sizing |
| Thinking works, both ways | `thinking_works.off`, `thinking_works.on` | a report; thinking itself follows the ruling (4.4) |
| Output cap floor, per task kind | `min_output_tokens.<kind>` | a lower bound on `max_tokens`, never below the command's own default (section 6) |
| json_schema works (thinking off and on) | `structured_output.off`, `structured_output.on` | whether `response_format` is sent (P8, P9) |
| Main server shape | `main.slots`, `main.slot_ctx` | broker: `-np`/`-c` for llama-server, `--slots`/`--max-context` for Locals |
| Scouting shape | `scouting.share_tokens`, `scouting.slots`, `scouting.slot_ctx`, `scouting.accuracy` | P9 mass-scouting |
| Speed | `speed.prefill_tps`, `speed.decode_tps`, `speed.aggregate_decode_tps`, `speed.load_avg` | the user-facing estimate and the batch rotation |
| Tokens per character | `chars_per_token` | P7 byte-to-token conversion where the engine has no `/tokenize` |

**Task kinds.** Three, scored without another model:
- **fact** (retrieval and editing): `llm ask`, `describe`, `scan folder`, edit-style commands. Thinking off (ruling L62-63).
- **aggregate** (combining information from the whole input): `summarize`, `topics`, `cluster`, `sem-deduplicate`, `session compact`. Thinking off. Review F2: these are not single-item lookups, so they get their own trials.
- **bug** (analysis): `scan security`, `scan quality`, `scan impl`, `check imports|refs|specs|rules|plan|diff`, `llm code`. Thinking on (ruling L62-63).

P7 owns the exact command-to-kind table; a command missing from it is refused on a local profile until it is classified (the P10 matrix).

## 2. Where it runs, and what requests do meanwhile

**The runner.** `llm-ext __calibrate` is a detached child, started like the broker:
- an `ensureCalibrator({dir, version})` with a spawn lock and a state file `calibrator-local.json` (pid, version);
- one runner per config dir;
- a version handover finishes the current trial, saves progress and exits, as the broker does.

**Order of work.** One model at a time, across both engines. Its record is written before the next starts. A model a request is waiting for goes first; then the rest of that profile's models (second, third), because the fallback chain may need them; then models queued by `models calibrate`.

**The cal server.** The runner starts its own server through `claimAndSpawn(role: "cal")`, so the registry's limit of at most one main plus one cal per engine applies unchanged (spec point 8).
- A private free port, a log `<engine>-server-cal.log`, and the same kill-safety checks as the main server. The identity marker is the engine's own: the log path on the llama-server argv, and `-X llm-ext-server=<marker>` for Locals (review F22).
- The log is capped: it is rotated at 50 MB, keeping one old file (F22).
- The runner restarts the cal server freely to change `-np`/`-c` or `--slots`/`--max-context` (user ruling 2026-10-28); user-facing main servers keep refuse-on-change.

**Orphan sweep** (F20). The registry sweep also removes a `cal` entry whose owner pid is dead or is not a live `__calibrate` process, and kills its server with the usual kill-safety checks. So a SIGKILLed runner can resume (no `SlotBusyError`) and its server's memory is freed.

**Yielding to user work** (user decision "Calibrate when idle"):
- Before every calibration request, the runner reads the broker's `/v1/health` (through `broker-local.json` and its token). If no broker is running, the broker is idle.
- If `queued + running > 0` for a model other than the one under calibration, the runner pauses. In-flight calibration requests are aborted; an aborted trial is not counted and runs again later. A paused runner prints one line every 30 s. Waiting is never an error.
- The runner also pauses when the 1-minute load average is above 1.5 × the core count, because the user's own servers are invisible to the broker (F22). Every speed figure stores the load average at measurement (`speed.load_avg`).
- The runner resumes once the broker reports 0 and 0 and the load is below the limit, for 5 seconds in a row.
- **Stopping the cal server while paused** (F14): at once when memory falls below the floor (darwin memory_pressure free % under `LLM_EXT_BROKER_MEMORY_FLOOR` + 10; elsewhere, more than 60 % of RAM resident), otherwise after 5 minutes paused. It restarts on resume.
- **Minimum slice** (F14): after 15 minutes paused with no finished trial, the runner runs one trial to completion even if the broker is busy; the memory floor still applies. User traffic therefore cannot starve calibration. Progress shows "paused by user work" with the paused time.
- **Timeouts and crashes** (F21): every trial has a timeout of 3 × its expected time from the measured speeds (at least 120 s); a timeout counts as a failed trial. A cal server crash is counted per step; after 3 crashes in the same step the model's record gets `status: calibration-failed` with the step and the last log lines, the runner moves on, and `calibration-status` reports it. A resume never loops into the same crash.

**Requests while a model is calibrating** (coordinator proposal; the user is asked to confirm, section 11 Q2):
- A request for a managed local model with no usable record **waits in the broker queue**; it does not fail ("waiting is never an error", ruling L86-87). The wait stays bounded by `--command_timeout`, and the queue line shows "waiting for calibration of <id>: step k of n, about N minutes left".
- Only the model under calibration (or queued for it) waits. Other models and remote profiles are not affected.
- **Provisional use.** Once a model has passed Phase A (works at all, about 10-15 min), it serves requests at once with conservative provisional settings until Phases B and C finish: context `PROVISIONAL_LOCAL_CTX` (8192 per slot), input budget 0.40 × 8192 minus the prompt overhead, thinking per the ruling, output caps at the command's default, one slot, no `response_format` unless Phase A proved it works. The runner treats its own provisional requests as user work for pausing.
- **Fallback when the fallback models are equally uncalibrated.** A model error normally falls back to `second_model`, then `third_model`. A fallback model that has no record and has not passed Phase A is skipped, not used and not waited on. If no model in the chain is usable, the request waits for the first model of the chain to pass Phase A. If a model's Phase A fails, that model is reported as not working (`status: calibration-failed`) and the chain moves on to the next.
- N comes from the progress file (remaining trials times the measured mean trial time), recomputed after every trial and excluding paused time (F19).

**Scope.** Calibration covers managed local profiles (`server: managed`, llamacpp-local or locals-local) only: it needs a server llm-ext starts. Remote and unmanaged local profiles are not calibrated and never wait (TRDD-UT7UC025 covers remote).

## 3. Triggers, records, locks and invalidation

**Triggers** (coordinator decision 1, ruling L73, F1). Calibration of a model starts only on:
1. **First use:** the first request on a managed local profile whose model has no record. The add-once built-in profiles (P5) therefore cost nothing (no download, no GPU time) until the user uses one.
2. **A model the user adds or changes:** on boot, llm-ext compares the model ids of every managed local profile with `<config dir>/calibration/seen-models.json` (written at the end of every boot). An id that is new or changed in a profile the user has used before (it has a record for any of its models, or appears in `used-profiles` in the same file) starts calibration for that id. The first boot after install only writes the file and starts nothing; an id in a profile nobody has used waits for trigger 1.
3. **`llm-ext models calibrate --model <id> [--force]`.**

Never on boot for profiles nobody used. A model removed from every profile is dropped from the work list; its record is kept.

**Files**, under `<config dir>/calibration/<engine>/`. `<slug>` is the sanitized model id plus the first 8 hex digits of sha256(id).
- `<slug>.json`: the record. Written atomically (temp file in the same dir, then rename) and mode 0600. A record that does not parse or fails its schema check counts as missing, and the problem is logged once.
- `<slug>.progress.json`: every finished trial with its seed, step, kind, position and score, never its input text (F22): a seed rebuilds the input. Rewritten atomically after each trial. Resume reuses every trial whose `harness_version`, `fixture_version` and fingerprint still match, and drops the rest.
- `<slug>.lock`: a mkdir lock holding the runner's pid. It is free when its pid is dead or no longer `__calibrate`, the same identity rule as the broker state. A manual `models calibrate` takes the same lock.
- `<config dir>/calibration/queue.json`: the ids queued by `models calibrate` and by trigger 2, so a queued model survives a runner restart (F19: revision 1 said "queues" with no queue file).

**Fingerprint** (part of the record):
- engine and model id;
- `harness_version` and `fixture_version` (constants, bumped when the method or the fixtures change);
- the resolved artifact (F19: a different quant or file under the same id changes it):
  - llama: `/props` `model_path`, that file's size, and the Hugging Face snapshot revision taken from the path;
  - Locals: the snapshot revision in `models--org--name/refs/main`, and the names and total size of the weight files;
- the machine: total RAM bytes (F19).

**When a record is invalid** and the model is calibrated again:
- the record is missing or corrupt;
- `harness_version` or `fixture_version` changed;
- the artifact changed (new snapshot, different quant or file);
- total RAM changed (W and Phase C depend on it);
- the user runs `models calibrate --model <id> --force`.

A change of `scout_accuracy_threshold` re-runs only the scouting part of Phase C (F19).

**An engine upgrade does not invalidate a record** (user decision "Quick check only"). The record stores `engine_version`: llama-server `--version` build, or Locals `/health` version. When that changes, the next use runs Phase A again.
- Pass: `engine_version_checked` is updated.
- Fail: the record gets `status: engine-check-failed`, and requests for that model are refused with the failure and the fix (downgrade the engine, or `models calibrate --force`).

Editing other profile fields never invalidates a record.

**Precedence** (coordinator decision 4, F11).
- Context per slot: the profile's `context_window` (a cap on all three models of the profile: each uses min(user value, its record)), then the record, then `PROVISIONAL_LOCAL_CTX = 8192` (code constant, in place since the P5 fixes).
- `request_options` the user writes (thinking, `max_output_tokens`, `input_fill_pct`, `structured_output`) win over the record, which wins over built-in defaults (increment 1 rule).
- The P5 built-ins carry no `context_window` (removed in the P5 fixes, before any dist build carried it).

## 4. The method: three phases

Every phase writes its trials to progress, so a crash or sleep resumes mid-phase. Answers are scored on the answer content only, after the engine's thinking is stripped (`reasoning_content`, and any `<think>…</think>` block left in `content`), with case, spaces and hyphens normalised (F4).

### 4.1 Before the first load: memory estimate (F21)
- llama: read n_layer, n_head_kv and head_dim from the GGUF header (`gguf` metadata, no load needed), plus the file size. Locals: the model's `config.json` (num_hidden_layers, num_key_value_heads, head_dim) and the weight files' size. For hybrid models (LFM3, Qwen3.5), count only the attention layers.
- KV bytes per token = 2 × n_attention_layers × n_head_kv × head_dim × 2 bytes (f16).
- W is capped so that weights + W × KV bytes per token + 1 GB stays under the free memory minus the floor. Only then is the server loaded. The post-load measurement can still lower W (halving, at least 8192), but the first load is no longer the largest gamble.

### 4.2 Phase A: works at all (about 10-15 min per model; runs first)
- Load the cal server with one slot at context 8192.
- Capabilities: llama `/props` `chat_template_caps` and `n_ctx_train`; Locals `/v1/models` `context_length` and whether a `-thinking` id is listed.
- One known-answer prompt (exact answer required).
- **Thinking both ways** (F10, F16), per model and per engine: 2 trials with thinking off (`chat_template_kwargs.enable_thinking: false`; on Locals the base id) must produce no reasoning tokens and no think block; 2 trials with thinking on (`enable_thinking: true`; on Locals the `-thinking` id) must produce reasoning. A model where either direction does not work is **reported** (`thinking_works.off|on: false` and a line in `calibration-status`); the setting is never switched silently. If thinking on does not work, bug-kind commands run with thinking off and the report says so; if thinking off does not work, fact and aggregate answers are scored after stripping.
- json_schema: a small strict schema, 2 times per thinking mode. HTTP 400 is recorded as unsupported with the server's text (known answer: Nanbeige GGUF = false). A second probe with an array of 20 items (`minItems`/`maxItems`), as scouting uses (F7).
- `chars_per_token` from three probe documents: `/tokenize` on llama; on Locals, `usage.prompt_tokens` of a 1-token completion.
- Speed at 2k and 8k prompt tokens.
- **Pass:** the server loads, the known answer is exact, thinking off works. A pass makes the model usable with provisional settings (section 2). A fail records `status: calibration-failed` with the step and stops this model.

### 4.3 Phase B: safe input size (at a fixed W of 32768)
- W = min(32768, n_ctx_train, the 4.1 estimate). Extending W beyond 32768 is a user decision (section 11 Q1).
- Load the cal server with one slot at context W.
- **Steps in absolute tokens** (F3): 2048, 4096, 8192, 12288 and 0.40 × W (13107 at W = 32768). The grid is adaptive: it starts at the top step and steps down only on failure. A kind's `fill_tokens` is the highest passing step.
- **Token floor** (F3): a kind is recorded unfit only if it fails at 2048 tokens. An unfit kind goes into the P10 table under class (b) or (c), with the command routed elsewhere, never silently refused.

**Fact trials (multi-needle, F2).**
- Filler: seeded synthetic prose documents in the same style as the needles, so a needle does not stand out by being the only fluent sentence.
- Planted: 5 needles "The access code for vault <name> is <8-char code>.", spread across the five positions (5 %, 25 %, 50 %, 75 %, 95 %), plus 3 decoy vaults.
- One prefill, then 5 questions reusing the cached prompt (llama `cache_prompt: true`; Locals reuses its prefix cache when it has one, otherwise it pays a prefill per question). Each question asks for one vault's code, code only.
- **Pass, per question:** the correct code appears and no other vault's code appears.

**Aggregate trials (F2).** The same documents with 3-9 vaults. Questions: "how many vaults are named" and "list every vault name". **Pass:** the exact count, or the exact set of names (order ignored, no extra name).

**Bug trials (F5).**
- Filler: real source files from a pinned, committed fixture corpus (permissive licence, corpus hash in `fixture_version`), checked once for real bugs by a strong model when the corpus is built; flagged files are excluded.
- Every file is shown with line numbers (`  12| code`).
- Planted: one of 20 committed small functions, each with exactly one injected bug (off-by-one, inverted condition, wrong variable, missing await…), written in the style of the corpus.
- Answer format: a single structured object `{"file": "...", "line": N}` (json_schema when supported, otherwise the schema in the prompt and the text parsed).
- **Pass:** the right file, and a line within ±1 of the bug.
- **Control:** every bug trial has a twin with the same function and no bug; the expected answer is `{"file": null, "line": null}`. A step passes only if the bug trials pass AND the control trials pass at the same rate threshold. A model that "finds" a bug in the control is guessing.

**Pass rule with sequential trials (F6).** A step runs 5 trials per kind (5 questions for fact; 5 bug trials plus 5 controls for bug).
- 5 of 5: pass. 2 or fewer of 5: fail.
- 3 or 4 of 5: 5 more trials; the step passes with at least 8 of 10.
- The recorded `grid` keeps every count, so a later reader can see how close each step was.

**Sizing.** The prompt is built to the target through `chars_per_token`, checked against the real `usage.prompt_tokens` of the reply. A trial more than 3 % off its step is rebuilt, never scored.

**Output cap floors (F15).** Every Phase B answer records its completion tokens and `finish_reason`. `min_output_tokens.<kind>` = the largest completion seen for that kind, times 1.25, rounded up to 256, and only ever used as a floor (section 6).

### 4.4 Thinking
Thinking follows the ruling (F10): **off** for fact and aggregate, **on** for bug. There is no vote. Phase A checks that it works both ways (4.2).

### 4.5 Phase C: server shape
**Main slots (F9).** Correctness does not depend on the slot count, so slots are chosen with a short synthetic throughput test, not with graded trials:
- `slot_ctx = roundup_256(max(fill_tokens) + max(min_output_tokens) + 512 overhead)`, capped by the profile's `context_window` if set.
- Candidates 1, 2, 4 and 8 slots (`-np n -c n×slot_ctx`, or Locals `--slots n --max-context slot_ctx`). A candidate whose 4.1 estimate exceeds the memory budget is skipped without loading.
- n concurrent requests of a fixed 2k prompt with 256 output tokens, once; measure aggregate decode tok/s.
- **Choice:** the smallest n whose aggregate decode is at least 90 % of the best. It replaces the provisional `MAIN_SLOTS = 2` and `LOCALS_MAIN_SLOTS = 4`.

**Scouting (F7).**
- The scout-accuracy fixture with the categories **shuffled by a seed** (the permutation is recorded), instead of `SCOUT_CATEGORIES[i % 10]`; the change is made in `mass_scouting/scout-accuracy-fixture.ts` and its accuracy ledger is versioned.
- Shares in absolute tokens: 2048 and 4096 per request (the fixture cannot be built below about 2k tokens), at slots 4 and 8.
- The request path: json_schema when Phase A proved it works for a 20-item array; otherwise the schema in the prompt and the text parsed. That text path does not exist yet in `classifyPositional`; P6 adds it (F17), and P8/P9 reuse it.
- **Pass:** accuracy at or above `scout_accuracy_threshold` (default 0.95).
- **Record:** the highest passing share; at that share, the slot count with the best records per second; plus the slot context, accuracy and records per second. If no share passes: `scouting: unfit`, and mass-scouting refuses that model.
- A scouting context is a different server shape: the broker keys queues by (model, ctx, engine), so mixing scouting with other commands on one model costs a stop and reload each time (about 4 s for LFM3, 52-62 s for the 4B GGUFs). That rotation cost belongs to P9 (F18).

**Speed.** llama: `timings.prompt_per_second` and `predicted_per_second`. Locals: streaming time-to-first-token for prefill, and completion tokens over the remaining wall time for decode. Plus `aggregate_decode_tps` at the chosen slots. Each with `load_avg`.

## 5. Time budget

Per model, at W = 32768, assuming an idle machine (the dry run measures the real rates; the 4B prefill rate below is still assumed):

| Phase | LFM3 1.7B (prefill about 700 tok/s, measured) | 4B models (prefill assumed about 250 tok/s, decode 34-44 tok/s measured) |
|---|---|---|
| A: works at all | about 10 min | about 15 min (two loads of 52-62 s, thinking probes) |
| B: fact + aggregate (about 6 prefills, reused for the questions) | about 5 min | about 10 min |
| B: bug, thinking on (about 3 steps × 10-20 trials at up to 13k tokens, each with up to 2-4k reasoning tokens) | about 30 min | about 60-90 min |
| C: slots + scouting | about 10 min | about 20 min |
| **Total** | **about 1 h** | **about 2-2.5 h** |

- All six models: about 2 × (1 + 2 × 2.25) ≈ **10-12 h** of machine time if every model is calibrated; less on a busy machine is not possible, more is likely (pauses and contention, F8).
- What the user actually waits for: with the first-use trigger, only the profile in use is calibrated. Its first model becomes usable after Phase A (about 10-15 min); the profile's three models finish in about 5-6 h (llama) in the background.
- The bug phase dominates because of thinking-on decode; it is the first thing to cut if the dry run shows it is slower (fewer steps, a reasoning cap).
- Revision 1 estimated 8-20 h at W = 131072; the review estimated 24-48 h for that design.

## 6. How commands consume a record (P7, P9)
For a request of task kind k on model m, with record R:
- **Input budget (tokens):** `R.fill_tokens[k] − prompt_overhead_tokens`. Converted to bytes with `/tokenize` (llama) or `R.chars_per_token` (Locals). It replaces the 400 KB default for managed local profiles. An explicit per-call `max_payload_kb`, then the profile's `request_options.input_fill_pct`, still win.
- **Other request fields:**
  - `max_tokens`: max(the command's own default, `R.min_output_tokens[k]`) (coordinator decision 6, F15). A calibrated value never lowers a command's cap;
  - thinking: off for fact and aggregate, on for bug, unless Phase A reported that direction broken;
  - `response_format`: sent only when `R.structured_output[mode]` is true.
- **Broker:** the main server starts with `R.main.slots` and `R.main.slot_ctx` (capped by `context_window`); scouting requests use `R.scouting.*`; the broker dispatches at most that many requests at once.
- **Unfit:** a kind unfit at the 2048-token floor, or `scouting: unfit`, is refused on that model with a message naming the record and the P10 alternative.
- **No usable record:** the request waits (section 2), it is not refused.
- **Ensembles** (P8, F19, coordinator decision 9): a member with no usable record waits like any calibrating model; a member unfit for the scan's task kind is dropped with a warning naming the record; the scan proceeds while at least 1 member is left, and refuses only when none is.
- Records are read once per command.

## 7. Record schema (version 1)
```json
{"schema": 1, "harness_version": 1, "fixture_version": 1,
 "engine": "llama|locals", "model": "<profile id>",
 "fingerprint": {"artifact": "<path or repo>", "revision": "<snapshot>", "files": ["..."], "bytes": 0, "ram_bytes": 0},
 "engine_version": "...", "engine_version_checked": "...",
 "status": "ok|provisional|engine-check-failed|calibration-failed", "failed_step": null,
 "calibrated_at": "<ISO>", "duration_s": 0, "window_tokens": 32768,
 "chars_per_token": 0,
 "capabilities": {"thinking": true, "n_ctx_train": 0},
 "thinking_works": {"off": true, "on": true},
 "min_output_tokens": {"fact": 0, "aggregate": 0, "bug": 0},
 "fill_tokens": {"fact": 13107, "aggregate": 8192, "bug": 4096},
 "grid": [{"kind": "fact", "tokens": 13107, "trials": 5, "passed": 5}],
 "structured_output": {"off": true, "on": false, "array20": true, "error": "..."},
 "main": {"slots": 2, "slot_ctx": 0},
 "scouting": {"share_tokens": 2048, "slots": 8, "slot_ctx": 0, "accuracy": 0.97, "records_per_s": 0, "permutation_seed": 0},
 "speed": {"prefill_tps": 0, "decode_tps": 0, "aggregate_decode_tps": 0, "load_avg": 0}}
```
`status: provisional` marks a model that passed Phase A only. The record is checked against this schema on read. Writing a record that fails the schema check is a bug and throws.

## 8. Commands
- `llm-ext models calibration-status`: every managed model, its record status or progress, paused time, thinking-direction problems, and the time left.
- `llm-ext models calibrate --model <id> [--force]`: adds the model to `queue.json` and starts the runner (detached), then returns at once.
- `llm-ext models server-status` and `server-stop`: also list and stop the cal servers.

## 9. Tests (P6b, real, no mocks)
- **Unit:**
  - scoring: fact (code, no other vault's code, thinking stripped, normalisation), aggregate (count and set), bug (file, ±1 line, control);
  - fixture determinism (same seed, same text) and the shuffled scouting categories;
  - the adaptive grid, the token floor and the sequential pass rule;
  - output-cap floors, and `max_tokens` never below the command default;
  - the KV estimate from GGUF and config.json metadata;
  - slot selection;
  - triggers: first use, a changed id in a used profile, no trigger for an unused built-in;
  - record schema read and write, corrupt record counted as missing, invalidation by every listed cause (artifact, RAM, versions, force);
  - the fallback rule with uncalibrated fallback models, and the ensemble rule.
- **Real:** with the tiny GGUFs CI already uses, a full run with a reduced harness (steps 2048 and 4096, W 4096) checks the mechanics:
  - cal role in the registry, never more than 1 cal and 1 main;
  - the orphan sweep of a cal entry after SIGKILL of the runner, then a resume that reuses finished trials;
  - the crash counter (a cal server killed 3 times in one step gives `calibration-failed`);
  - a request that waits during Phase A and is served after it;
  - pause while a broker job runs (a real client job), aborted trials not counted;
  - an atomic record;
  - the tiny models will mostly score unfit: the test checks the verdicts and the mechanics, not their quality.
- **Opt-in** (`RUN_REAL_LOCAL_MODELS=1`): the dry run below.

## 10. P6a dry run (after review; about 45 minutes, LFM3 GGUF only)
`AtomicChat/LFM3-1.7B-Uncensored-GGUF:AD-Q6_K` on a cal server, with a reduced harness:
- Phase A in full;
- Phase B with steps 4096 and 13107, fact, aggregate and bug, 5 trials per step;
- Phase C with slots 1 and 2, scouting share 2048 at slots 4.

Plus the Nanbeige GGUF Phase A json_schema check only (known answer: unsupported).

**Acceptance:**
- a record that passes the schema check;
- registry entries with role cal only (the main untouched);
- one SIGKILL of the runner, the orphan sweep, and a resume that reuses the finished trials;
- one real `llm ask` on another local model during the run that pauses calibration, with the pause and resume logged;
- `~/.locals/config.json` checksum unchanged (it is still unverified whether `locals.server` writes it, F22), port 8321 and the user's processes untouched.

Results go to `reports/llama-cpp-profile/<ts>-p6a-dry-run.md`, with the measured trial times that replace the assumed rates in section 5.

## 11. Open questions for the user
1. **W beyond 32768** (F12). Calibrating at 32768 sizes inputs up to about 13k tokens. The user cited LFM3's 256k window. Extending W to 65536 doubles the Phase B time (about +1 h for a 4B model); 131072 quadruples it. Option: offer `models calibrate --window 65536` per model later.
2. **Waiting instead of refusing** (F13). The coordinator proposes that a request for a model under calibration waits in the queue (bounded by `--command_timeout`), and that a model which passed Phase A serves at once with provisional settings. This reads "No, wait" (L68) as "the request waits". Please confirm, or choose a refusal.
3. **Scouting context** (F18). "Reduced context memory to make the models run faster" for mass-scouting is still the main agent's reading, to be confirmed; it costs a server reload on each switch.

## 12. Review findings and what changed

| Finding | What changed |
|---|---|
| F1 trigger too wide | Section 3: triggers are first use, a user-added or changed model, and `models calibrate`. Never on boot for unused profiles; the P5 built-ins cost nothing until used. |
| F2 single-needle fact | 4.3: multi-needle fact trials and a separate aggregate kind (count, list) for summarize, topics, cluster, sem-deduplicate, session compact. |
| F3 bug unfit by W fraction | 4.3: steps in absolute tokens; unfit only below 2048 tokens; unfit kinds go to the P10 table. |
| F4 thinking text scored | Section 4: scoring reads the answer only, thinking stripped, case, space and hyphen normalised. |
| F5 bug rule guessable | 4.3: line-numbered files, a single `{file, line}` answer, ±1 line, a no-bug control, corpus screened for real bugs, planted functions in corpus style. |
| F6 too few trials | 4.3: sequential extra trials at 3-4 of 5 (need 8 of 10); no thinking vote (F10); caps are floors from every Phase B answer. |
| F7 scouting guessable, missing text path, fixture size | 4.5: seeded shuffled categories, shares in absolute tokens at or above the fixture minimum, a 20-item array json_schema probe, the text-parse path added in P6. |
| F8 budget too low | Section 5: new per-phase budget at W = 32768, about 10-12 h for all six, measured by the dry run; load average recorded with every speed. |
| F9 cheaper design | Adopted: Phases A, B, C (section 4). |
| F10 thinking vote overturns the ruling | 4.4: off for fact and aggregate, on for bug, no vote; Phase A only checks both directions and reports failures. |
| F11 context_window | Done in the P5 fixes: removed from the built-ins; `PROVISIONAL_LOCAL_CTX = 8192` in code; precedence user cap, then record, then provisional (section 3). |
| F12 131072 cap | W fixed at 32768; extending it is open question 1. |
| F13 "No, wait" stretched | Section 2: requests wait (bounded by `--command_timeout`), only the model under calibration waits, provisional use after Phase A, defined fallback; open question 2. |
| F14 pause rule, starvation | Section 2: stop at once below the memory floor, otherwise after 5 min; a 15-min minimum slice. |
| F15 output caps from code-only answers | 4.3 and section 6: calibrated values are only floors, never below the command's default. |
| F16 thinking ids unverified | 4.2: Phase A checks thinking off and on per model and per engine, including the Locals base and `-thinking` ids. |
| F17 json_schema fallback missing | 4.5: P6 adds the schema-in-prompt text path to `classifyPositional`; P8/P9 reuse it. |
| F18 scouting server swaps | 4.5: recorded; the rotation cost belongs to P9; open question 3. |
| F19 ensembles, re-calibration, queue | Section 3: artifact (quant or file), RAM and `scout_accuracy_threshold` triggers, `queue.json`; section 6: the ensemble rule; section 2: time left recomputed without paused time. |
| F20 orphaned cal server | Section 2: the sweep removes cal entries whose owner is not a live `__calibrate`. |
| F21 memory and crash risks | 4.1: KV per token estimated before the first load, W computed from it; section 2: per-trial timeouts and a crash counter per step. |
| F22 logs, inputs, marker, contention | Section 2: log rotated at 50 MB, the right Locals marker, a load-average pause; section 3: seeds stored instead of inputs; section 10: the `~/.locals/config.json` checksum check. |
