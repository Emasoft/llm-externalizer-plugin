# Local model calibration design (P6, TRDD-1OOAH3LD, TRDD-ZGSGGHQG)

Status: revision 3 (2026-10-29), the last design round. It follows the round-1 review (`reports/llama-cpp-profile/20261029_033854+0100-calibration-design-review.md`, findings F1-F22), the round-2 review (`reports/llama-cpp-profile/20261029_040800+0100-calibration-design-review-round2.md`, verdict "implement after fixes", findings N1-N9 and A1-A8) and the coordinator's binding decisions for both rounds. Nothing is implemented yet. Next it goes to the user with the questions in section 11. Section 12 maps every finding to what changed.

Sources:
- design/specs/local-profiles-goal-program.md: P6a, P6, P7, P8 and P9;
- design/specs/TRDD-1OOAH3LD-local-llama-design.md: increment 4 and the user decisions;
- design/specs/TRDD-ZGSGGHQG-locals-mlx-design.md: L3 items 3 and 4;
- design/specs/local-engine-broker-design.md: point 8, the server-count safeguard with roles main and cal;
- reports/locals-mlx/20261028_200451+0100-six-model-smoke.md.

User rulings this design follows (card 1OOAH3LD):
- L58: input errors grow above 35-40 % of the window; "test it well".
- L62-63: thinking can be disabled for simple tasks like text editing, and enabled for bug search.
- L68: "No, wait" to using a model while it is being calibrated. Here a request for such a model is held until its record is complete; it is never served early (section 2).
- L73: calibration is triggered only when a new or updated model is added or edited in the profile.
- L86-87: not having enough memory is not a failure; the request waits in a queue.

## 1. What calibration decides, per model

| Decision | Recorded as | Used by |
|---|---|---|
| Calibration window W | `window_tokens` (at most 32768 unless the user extends it, section 11), with `free_ram_bytes` at measurement | the grid's upper bound |
| Safe input size, per task kind | `fill_tokens.fact`, `fill_tokens.aggregate`, `fill_tokens.bug` (absolute tokens, at most 0.40 × W) | P7 input sizing (section 6) |
| Thinking works, both ways | `thinking_works.off`, `thinking_works.on` | Phase A pass rule and a report; thinking itself follows the ruling (4.4) |
| Output floor, per task kind | `min_output_tokens.<kind>` | a lower bound on `max_tokens`, never below the command's own default (section 6) |
| json_schema works (thinking off and on) | `structured_output.off`, `structured_output.on`, `structured_output.array40` | whether `response_format` is sent (P8, P9) |
| Main server shape | `main.slots`, `main.slot_ctx` | broker: `-np`/`-c` for llama-server, `--slots`/`--max-context` for Locals |
| Scouting shape | `scouting.share_tokens`, `scouting.slots`, `scouting.slot_ctx`, `scouting.accuracy` | P9 mass-scouting |
| Speed | `speed.prefill_tps`, `speed.decode_tps`, `speed.aggregate_tps`, `speed.load_avg` | trial timeouts, the user-facing estimate and the batch rotation |
| Tokens per character | `chars_per_token` | P7 byte-to-token conversion where the engine has no `/tokenize` |

**Task kinds.** Three, scored without another model:
- **fact** (retrieval and editing): `llm ask`, `describe`, `scan folder`, edit-style commands. Thinking off (ruling L62-63).
- **aggregate** (combining information from the whole input): `summarize`, `topics`, `cluster`, `sem-deduplicate`, `session compact`. Thinking off.
- **bug** (analysis): `scan security`, `scan quality`, `scan impl`, `check imports|refs|specs|rules|plan|diff`, `llm code`. Thinking on (ruling L62-63).

P7 owns the exact command-to-kind table; a command missing from it is refused on a local profile until it is classified (the P10 matrix).

## 2. Where it runs, and what requests do meanwhile

**The runner.** `llm-ext __calibrate` is a detached child, started like the broker:
- an `ensureCalibrator({dir, version})` with a spawn lock and a state file `calibrator-local.json` (pid, version);
- one runner per config dir;
- a version handover finishes the current trial, saves progress and exits, as the broker does.

**Order of work.** One model at a time, across both engines; its record is written before the next starts. When a model is waiting with held jobs, it does not preempt the model being calibrated: it goes first in line after it (A5). Then the rest of that profile's models (second, third), because the fallback chain may need them; then models queued by `models calibrate`.

**The cal server.** The runner starts its own server through `claimAndSpawn(role: "cal")`, so the registry's limit of at most one main plus one cal per engine applies unchanged (spec point 8).
- A private free port, a log `<engine>-server-cal.log`, and the same kill-safety checks as the main server. The identity marker is the engine's own: the log path on the llama-server argv, and `-X llm-ext-server=<marker>` for Locals.
- **Log cap** (F22): llama-server keeps its log file open, so a rename does not cap it. When the log passes 50 MB, the runner restarts the cal server at the next trial boundary, and the old log is kept as `.1` (the existing rotation at start).
- The runner restarts the cal server freely to change `-np`/`-c` or `--slots`/`--max-context` (user ruling 2026-10-28); user-facing main servers keep refuse-on-change.

**Orphan sweep** (F20). The registry sweep also removes a `cal` entry whose owner pid is dead or is not a live `__calibrate` process, and kills its server with the usual kill-safety checks. So a SIGKILLed runner can resume (no `SlotBusyError`) and its server's memory is freed.

**Held jobs: the broker's new job state** (coordinator decision 1, N1).
- `JobState` gains `held`. On `POST /v1/jobs` for a managed local model, the broker reads that model's record with the same reader P7 uses. If there is no record with `status: ok`, the job is created `held` (not `queued`), the model is added to `calibration/queue.json`, and `ensureCalibrator` is called. That is trigger 1 of section 3.
- A held job is outside the scheduler: it is not in `allQueued()`, it has no deadline, it takes no part in deadline or starvation rotation, it never counts towards the minimum slice, and it never makes the broker start a main server.
- Every 5 seconds the broker re-reads the record of each model with held jobs. When the record has `status: ok`, the held jobs move to `queued` with `submittedAt` set to that moment, so their queue deadline counts from release. When the record has `status: calibration-failed` or `engine-check-failed`, the held jobs fail with the record's message. That is a model error, so the client's normal fallback to `second_model`/`third_model` follows; the next model is held in turn if it has no record.
- While held, a job is bounded only by the client's `--command_timeout`. When the client gives up, the job is cancelled like any abandoned job. Waiting is never an error.
- A held job is not a model error, so it never triggers the client's fallback to the next model.
- The long-poll reply for a held job carries `state: held` and the calibration progress line ("waiting for calibration of <id>: phase X, step k of n, about N minutes left"), which the client prints once a minute.
- **`/v1/health`** keeps its totals and adds per-model counts: `models: [{engine, model, queued, running, held}]`. Held jobs are not in the `queued` total.
- Provisional use (serving after Phase A) is removed. It comes back only if the user approves it (section 11, Q2).

**Yielding to user work** (user decision "Calibrate when idle").
- Before every calibration request, the runner reads `/v1/health` (through `broker-local.json` and its token). If no broker is running, the broker is idle.
- The runner pauses only for `queued + running > 0` on a model OTHER than the one it calibrates. Held jobs never pause it, and neither do jobs for its own model, which are all held (A3).
- It also pauses when the 1-minute load average is above 1.5 × the core count, because the user's own servers are invisible to the broker. Every speed figure stores the load average at measurement (`speed.load_avg`).
- In-flight calibration requests are aborted on a pause; an aborted trial is not counted and runs again later. A paused runner prints one line every 30 s.
- It resumes once both conditions have been clear for 5 seconds in a row.
- **Stopping the cal server while paused** (F14): at once when memory falls below the floor (darwin memory_pressure free % under `LLM_EXT_BROKER_MEMORY_FLOOR` + 10; elsewhere, more than 60 % of RAM resident), otherwise after 5 minutes paused. It restarts on resume.
- **Minimum slice** (F14, A4): after 15 minutes paused with no finished trial, the runner runs one trial to completion even if the broker is busy and even if the load is above the limit. Only the memory floor still stops it. Progress shows "paused by user work" with the paused time.

**Output caps, timeouts and inconclusive trials** (N3, N4, coordinator decision 3).
- Every calibration request carries `max_tokens` 8192 with thinking on, and 2048 with thinking off.
- Trial timeout = 3 × (prompt tokens / `speed.prefill_tps` + the trial's `max_tokens` / `speed.decode_tps`), using the Phase A speeds, and at least 120 s.
- A trial that ends with `finish_reason: length` at the kind's nominal cap is rerun once on a new document; cut again, it is a FAIL in the sequential rule, never a reason to fail the model. A squeezed cap cannot occur: a grid step runs only with room for the full cap (D1, main-agent decision, 2026-10-29, amended after review; the user may override; section 4.3, "Grid steps and the window").
- A trial that times out is **inconclusive**, never a quality failure (D2, main-agent decision, 2026-10-29; the user may override: unchanged). It is rerun once. Two inconclusive runs in a row pause the step: the step is recorded `inconclusive` with both runs, the runner goes on to the next model in line, and it retries the paused step once on its next pass. If it is inconclusive again, the model gets `status: calibration-failed` with that step, and `calibration-status` reports it, so a model too slow by itself cannot hold jobs forever.
- A request that fails with no HTTP status and no timeout (a network error) is inconclusive and rerun only when the cal server is still alive when checked after the error, with the same pid and no restart in between; otherwise it counts towards the crash limit below (D3, main-agent decision, 2026-10-29; the user may override).
- A cal server crash is counted per step. After 3 crashes in the same step, the model gets `status: calibration-failed` with the step and the last log lines, the runner moves on, and `calibration-status` reports it. A resume never loops into the same crash.

**Scope.** Calibration covers managed local profiles (`server: managed`, llamacpp-local or locals-local) only: it needs a server llm-ext starts. Remote and unmanaged local profiles are not calibrated and never held (TRDD-UT7UC025 covers remote).

## 3. Triggers, records, locks and invalidation

**Triggers** (ruling L73, F1). Calibration of a model starts only on:
1. **First use:** the broker receives the first job for a managed local model without a complete record (the held path of section 2).
2. **A model the user adds or changes:** on boot, llm-ext compares the model ids of every managed local profile with `<config dir>/calibration/seen-models.json`. A new or changed id in a profile listed in `used-profiles` (same file) is added to `queue.json` and starts the runner. The first boot after install only writes the file and starts nothing; an id in a profile nobody has used waits for trigger 1.
3. **`llm-ext models calibrate --model <id> [--force]`.**

Never on boot for profiles nobody used. A model removed from every profile is dropped from the work list; its record is kept.

**Shared state files and their lock** (A8). `seen-models.json` (with `used-profiles`) and `queue.json` are changed only under the mkdir lock `calibration/state.lock` (holder pid, freed when the pid is dead), each as read-modify-write with an atomic rename:
- the broker client adds a profile to `used-profiles` when it submits a job for a managed local profile;
- boot rewrites `seen-models` only when the ids changed;
- the broker, `models calibrate` and trigger 2 add to `queue.json`; the runner removes a model when its record is written.

**Files**, under `<config dir>/calibration/<engine>/`. `<slug>` is the sanitized model id plus the first 8 hex digits of sha256(id).
- `<slug>.json`: the record. Written atomically (temp file in the same dir, then rename) and mode 0600. A record that does not parse or fails its schema check counts as missing, and the problem is logged once.
- `<slug>.progress.json`: every finished trial with its seed, step, kind, position, outcome (pass, fail or inconclusive) and completion tokens, never its input text: a seed rebuilds the input. Rewritten atomically after each trial. Resume reuses every trial whose `harness_version`, `fixture_version` and fingerprint still match, and drops the rest.
- `<slug>.lock`: a mkdir lock holding the runner's pid, free when its pid is dead or no longer `__calibrate`. A manual `models calibrate` takes the same lock.

**Fingerprint** (part of the record; N7):
- engine and model id;
- `harness_version` and `fixture_version` (constants, bumped when the method or the fixtures change);
- the artifact by content, never by repository revision: the sha256 of each weight file's blob. In the Hugging Face cache a snapshot file is a symlink to `blobs/<sha256>`, so the hash is read from the link target without hashing the file. llama: the GGUF named by `/props` `model_path`. Locals: every weight file of the snapshot. A README commit does not change it; a different quant or file does;
- the machine: total RAM bytes.

**When a record is invalid** and the model is calibrated again:
- the record is missing or corrupt;
- `harness_version` or `fixture_version` changed;
- a blob sha256 changed (new weights, different quant or file);
- total RAM changed;
- the user runs `models calibrate --model <id> --force`.

- the record's `harness` is not "production" at the current `harness_version` (D4, main-agent decision, 2026-10-29; the user may override): a record made with a custom `LLM_EXT_CALIBRATION_HARNESS` stores "custom:<sha256 of its JSON>" and never makes a model usable; `harness_version` is bumped whenever the production harness changes. Compared by id and version, never by deep-equal. The progress file stores the same id: a run of another harness id (or a progress file with none) starts fresh, so a production run never resumes trials of a custom harness, nor the reverse.

A change of `scout_accuracy_threshold` needs no new calibration: the record keeps every scored scouting candidate and the threshold is applied when the record is read (review of fb861fab; main-agent decision, 2026-10-29; the user may override).

**W and free memory** (F19, coordinator decision 11; the 25 % re-measure rule is replaced by the hard-W rule, main-agent decision 2026-10-29 after review, the user may override). Phase B measures two windows with the model unloaded (section 4.3): the hard W, from total RAM minus the floor, and the soft W, from the free memory now (the W the cal server runs at). The step grid comes from the hard W, so a busy moment never changes which steps exist; a step over the soft W waits for memory. A resume keeps every Phase B trial while the hard W is the same, however free memory moved (`windowResume`: fresh with no earlier hard W, keep when it is the same, restart when it changed); only a different hard W drops the Phase B and C results and reruns them. A RAM change also invalidates the record through the fingerprint. The record stores `free_ram_bytes` as seen when W was measured.

**An engine upgrade does not invalidate a record** (user decision "Quick check only"). The record stores `engine_version`: llama-server `--version` build, or Locals `/health` version. When that changes, the next use runs Phase A again (its jobs are held meanwhile).
- Pass: `engine_version_checked` is updated.
- Fail: the record gets `status: engine-check-failed`, and requests for that model fail with the failure and the fix (downgrade the engine, or `models calibrate --force`).

Editing other profile fields never invalidates a record.

**Precedence** (F11, N5, N6).
- Context per slot: `slot_ctx = min(the profile's context_window when set, R.main.slot_ctx)`. The user value is a cap on all three models of the profile. Without a record nothing is served (held), so `PROVISIONAL_LOCAL_CTX = 8192` applies only to a server started without the broker's record check (a test, an engine quick check).
- `request_options` the user may write: `thinking` and `max_output_tokens` (existing validator fields) win over the record. The validator is NOT extended: revision 2's `input_fill_pct` and `structured_output` are dropped (N6, coordinator decision 5). The per-call `max_payload_kb` still caps the input.
- The P5 built-ins carry no `context_window` (removed in e253b758).

## 4. The method: three phases

Every phase writes its trials to progress, so a crash or sleep resumes mid-phase. Answers are scored on the answer content only, after the engine's thinking is stripped (`reasoning_content`, and any `<think>…</think>` block left in `content`), with case, spaces and hyphens normalised.

### 4.1 Before the first load: memory estimate (F21, A7)
- KV bytes per token = sum over the layers that hold a KV cache of 2 × n_head_kv × head_dim × 2 bytes (f16).
- Which layers count: llama reads the GGUF metadata `<arch>.attention.head_count_kv`. When it is a per-layer array, a 0 entry means a layer without KV (a convolution layer in LFM3). `<arch>.attention.sliding_window` (with the per-layer pattern, when present) marks sliding-window layers, which count min(W, window) tokens instead of W. Locals reads `config.json`: `layer_types` (or `full_attention_interval`), `num_key_value_heads`, `head_dim` and `sliding_window`. When the metadata names neither, every layer counts in full, which overestimates and is safe.
- W is the largest value with weights + KV(W) + 1 GB under the free memory minus the floor, and at most 32768. Only then is the server loaded. The post-load check can still lower W (halving, at least 8192).

### 4.2 Phase A: works at all (about 10-15 min per model; runs first)
- Load the cal server with one slot at context 16384 (N8), so an 8k speed prompt plus its output fits.
- Capabilities: llama `/props` `chat_template_caps` and `n_ctx_train`; Locals `/v1/models` `context_length` and whether a `-thinking` id is listed.
- One known-answer prompt. It passes when the normalised answer contains the expected token as a whole word ("The answer is 42." passes for 42).
- **Thinking off must work** (N2, coordinator decision 2): 2 trials with thinking off (`chat_template_kwargs.enable_thinking: false`; on Locals the base id) must produce no reasoning tokens and no think block. A model whose thinking cannot be turned off fails Phase A, and is reported.
- **Leaky thinking off** (D5, main-agent decision, 2026-10-29, amended after the review of a72827f9; the user may override): the median completion length of every thinking-off reply to a short-answer question (expected answer under 20 tokens) must stay within 256 tokens: Phase A's known answer and its two thinking-off trials, then Phase B's fact and aggregate-count trials once they exist. A model that passes the checks above but not this one reasons in its visible answer: `thinking_works.off` is `"leaky"` (otherwise `true` or `false`), shown by `calibration-status`. Phase A records a first value; Phase B re-judges it with its own trials, and the record takes Phase B's value. One trial alone is not enough: LFM3 answered the known answer briefly and leaked about 700 tokens on fact answers. "leaky" does not fail Phase A; whether it should is a user decision, because the goal names the LFM3 model that does it.
- **Thinking on** (F16): 2 trials with thinking on (`enable_thinking: true`; on Locals the `-thinking` id) must produce reasoning. If they do not, the model is reported (`thinking_works.on: false`, a line in `calibration-status`), and the bug kind runs and is calibrated with thinking off. That is reported, never silent.
- json_schema: a small strict schema, 2 times per thinking mode; and an array schema with minItems = maxItems = 40, as scouting sends for its 40-record minimum (F7). HTTP 400 is recorded as unsupported with the server's text (known answer: Nanbeige GGUF = false).
- `chars_per_token` from three probe documents: `/tokenize` on llama; on Locals, `usage.prompt_tokens` of a 1-token completion.
- Speed at 2k and 8k prompt tokens (these give the trial timeouts).
- **Pass:** the server loads, the known answer passes, thinking off works. A fail gives `status: calibration-failed` with the step, and this model stops. Passing Phase A does not make the model usable: jobs stay held until the record is complete.

### 4.3 Phase B: safe input size (W from 4.1, at most 32768)
- Load the cal server with one slot at context W.
- **Steps in absolute tokens** (F3, N9): 2048, 4096, 8192 and 0.40 × W (13107 at W = 32768). The grid is adaptive: it starts at the top step and steps down only on failure. A kind's `fill_tokens` is the highest passing step.
- **Token floor:** a kind is recorded unfit only if it fails at 2048 tokens (section 6 says what happens then).

**Fact trials (multi-needle).**
- Filler: seeded synthetic prose documents in the same style as the needles, so a needle does not stand out by being the only fluent sentence.
- Planted: 5 needles "The access code for vault <name> is <8-char code>.", one at each position (5 %, 25 %, 50 %, 75 %, 95 %), plus 3 decoy vaults.
- One prefill, then 5 questions reusing the cached prompt (llama `cache_prompt: true`; Locals reuses its prefix cache when it has one). Each asks for one vault's code, code only.
- **Pass, per question:** the correct code appears and no other vault's code appears. The 5 questions share a prompt, so the next step's sequential extension (below) uses a new seed, not more questions on the same prompt.

**Aggregate trials** (A1). Separate documents from the fact trials: the same filler style with 3 to 9 vaults (the count is seeded), and no decoys. Two kinds of question, each its own trial on its own document: "how many vaults does the text name" passes on the exact number; "list every vault name" passes on the exact set (order ignored, no missing and no extra name).

**Bug trials (F5).**
- Filler: real source files from a pinned, committed fixture corpus (permissive licence, corpus hash in `fixture_version`), checked once for real bugs by a strong model when the corpus is built; flagged files are excluded.
- Every file is shown with line numbers (`  12| code`).
- Planted: one of 20 committed small functions, each with exactly one injected bug (off-by-one, inverted condition, wrong variable, missing await…), written in the style of the corpus.
- Answer: a single structured object `{"file": "...", "line": N}` (json_schema when supported, otherwise the schema in the prompt and the text parsed).
- **Pass:** the right file, and a line within ±1 of the bug.
- **Control:** every bug trial has a twin with the same function and no bug; the expected answer is `{"file": null, "line": null}`.

**Pass rule with sequential trials** (F6, A2). A counter starts with 5 trials. 5 of 5 passes; 2 or fewer fails; 3 or 4 adds 5 more trials and passes at 8 of 10 or better. Inconclusive trials are rerun and never counted.
- fact and aggregate: one counter each per step.
- bug: two separate counters per step, one for the bug trials and one for the controls. The step passes only when both pass.
- The recorded `grid` keeps every count.

**Sizing.** The prompt is built to the target through `chars_per_token`, checked against the real `usage.prompt_tokens` of the reply. A trial more than 3 % off its step is rebuilt, never scored.

**Cap cuts and reruns** (D1, D7, main-agent decision, 2026-10-29, amended after the review of a72827f9; the user may override). A trial cut at the kind's nominal cap (8192 tokens with thinking on, 2048 with thinking off) is rerun once on a new document of the same kind and size (at temperature 0 the same input repeats the same cut). Cut again, it is a FAIL in the sequential rule, so the step fails like any other and the grid steps down; at the 2048 floor the kind is unfit (`fill_tokens.<kind> = 0`). Each trial stores the cap it ran with; each grid entry counts its cuts (`cuts`), the fails that were cuts (`cut_fails`) and the largest cap a cut hit (`cut_cap`).

**Grid steps and the window** (main-agent decision, 2026-10-29, amended after review; the user may override). A step needs step + nominal cap + 64 tokens of window, the nominal cap being that of the thinking mode that actually runs (8192 thinking on; 2048 thinking off, also for bug when thinking on is broken, floor 4160). Two windows: the hard W (weights + KV + 1 GB within TOTAL RAM minus the floor, capped at 32768 and `n_ctx_train`) and the soft W (the same with the free memory now: the W the cal server runs at). Checked when each step runs, against the window the cal server has then (the post-load halving or a resume re-measure can lower it). A step that does not fit the hard W is skipped: not run, recorded in the grid as `{kind, tokens, skipped: "window", W}`, and counted as not fitting; a kind with every step skipped is unfit, window-limited, reason "window W too small for thinking on|off output". A step that fits the hard W but not the soft W makes the model wait for memory (as the broker does: no pause counted, no verdict), bounded as in "Phase B memory waits" below. Neither is ever a calibration failure: lack of memory never is (user ruling). A squeezed cap cannot occur; if it does, the runner throws "cap squeezed below nominal: step X, W Y", counted as a runner crash. The record's `window_tokens` is the smallest W any counted trial ran under.

**Phase B memory waits** (coordinator decision, 2026-10-29). Phase B waits for memory through the one mechanism Phase C uses (`calibration/memory-wait.ts`), at two places: the soft W under the smallest window calibration needs (step `B/window`; ceil(2048 / 0.4) = 5120 tokens on the production grid, the smallest step + 256 on a reduced harness), and a grid step that fits the hard W but not the soft W (step `B/<kind>/<tokens>`). The wait is saved in the progress with the bytes above the floor that a fresh reading with the model unloaded must show before the model is loaded again, so the runner re-checks it before a pass loads anything (`memoryWaitPrecheck`), and a pass on which the step would only wait again loads nothing (review M1, main-agent decision 2026-10-30; the user may override): for a window already short with the model unloaded, weights + KV + 1 GB of the window rounded up to its 256-token step, as W is computed, so the wait and the precheck decide on the same quantity; for a window the post-load halving cut, the free memory above the floor at that pass plus the shortage the halving saw; for a window cut only by the server's own context, more than total RAM minus the floor (no free memory helps, so the prechecks alone count the wait). A waiting pass is then one memory reading, about a minute after the last, so the 5-minute gap rule holds as it is; only time a runner was checking counts. A progress file written before this keeps its stored bytes: such a wait may load the model once more, and that pass stores the new value. After 30 minutes of checks the step is skipped for that pass (an inconclusive trial, `skipped: "memory-wait"`, with `passes`); rule A measures it again on the next pass and gives it up on its third. While a grid step is pending the other kinds go on, then Phase B pauses (no summary, no record). A step that only waited is never a failure. A grid step given up is recorded as `{kind, tokens, skipped: "memory-wait", W}` (W the soft W) and the walk steps down, as for a window skip; a resume does not wait for it again. A kind with a memory-wait skip and fill 0 shows as unfit, memory-limited, in `calibration-status`; a kind with fill above 0 whose higher steps were given up shows that its fill is limited by free memory (rule 3 below). `B/window` given up means no step could be loaded: the calibration is memory-limited (rule 2 below). A hard W under that smallest window (total RAM minus the floor, or the trained context, too small) can never be helped by waiting: the model is too big for this machine's memory (rule 1 below). Harness version 5 carries this.

**Memory verdicts** (coordinator decisions, 2026-10-29). One rule for each way memory can end a calibration; no other path writes a verdict from memory size.
- **Rule 1, can never fit.** A hard W under the smallest window (`B/window`) and Phase C main slots all over total RAM minus the floor (`C/main`) both give a `calibration-failed` record whose message says the model is too big for this machine's memory. The record stores what it was judged against in `memory_judged` (total RAM, `floor_pct`, the trained context). When the total RAM or `LLM_EXT_BROKER_MEMORY_FLOOR` differs, the record counts as missing: the next request holds its job and re-queues the model, the runner measures it again, and `models calibrate` needs no `--force`; this is how Phase C's over-total-RAM skip is re-checked under a new floor. A different trained context comes only with different weights, which the fingerprint already treats as stale (section 3). The floor has one source by design, the environment (`LLM_EXT_BROKER_MEMORY_FLOOR`, default 10; no settings field), read by each process that judges or reads a record (review m3, main-agent decision 2026-10-30): the broker and the runners it starts share it (a runner inherits the broker's environment), and a shell with another value (`models calibrate`, `calibration-status`) may judge differently until a broker-started runner measures the model again under the broker's floor.
- **Rule 2, only waited.** A calibration whose deciding step was given up after its 3 memory-wait passes gets `status: memory-limited`, neither a pass nor a failure: `B/window` given up, or Phase C with no main slot scored and at least one candidate given up after its memory waits (the rest over total RAM). Main slots have no transport skip: a failed throughput request is a runner crash. Held and new jobs for that model fail at once: "not enough free memory to calibrate it (...); free memory, or run llm-ext models calibrate --model <id>". The first request 1 hour or more after the record was written holds its job and re-queues the model, and the runner calibrates it again with fresh pass counters: when the memory-limited record is written, the pass-counted skips (memory-wait, timeout, transport) and the saved memory waits are dropped from the progress; over-total-RAM skips are judgments and stay. `models calibrate` queues it without `--force`. A candidate that was measured and failed still fails as before, and scouting keeps its own rule (unfit, with `scouting_unfit_reason`). This replaces "B/window given up passes with every fill 0" and, for that case, "no main slot scored fails the model". A forced calibration (`models calibrate --force`) of a model whose `status: ok` record still matches what is loaded (weights, RAM, engine build, method) and that ends this way writes no memory-limited record (review m1, main-agent decision 2026-10-30; the user may override): the ok record is kept (rewritten unchanged), the runner logs the outcome, the model leaves the queue, and requests go on using the ok record; `models calibrate --force` measures it again once memory is free. A stale ok record gives no such protection.
- **Rule 3, fill limited by free memory.** A kind whose fill is above 0 but whose higher grid steps were given up after their memory waits shows in `calibration-status` as "fill_tokens <kind> N (fill limited by free memory during calibration; `models calibrate --force` measures it again)".
- **Format.** A status value and an optional field, both additive under schema 2 (section 7). `HARNESS_VERSION` stays 5: version 5 already redoes every older record and progress (it introduced the Phase B memory waits these rules complete), and a version-5 record written before these rules was never released.

**Output floors** (F15, N4). `min_output_tokens.<kind>` = the largest completion of a PASSING, non-truncated (`finish_reason: stop`) trial of that kind, times 1.25, rounded up to 256. Failed and inconclusive trials never count. It is only used as a floor (section 6).

### 4.4 Thinking
Thinking follows the ruling: **off** for fact and aggregate, **on** for bug. There is no vote. Phase A checks that it works in both directions (4.2).

### 4.5 Phase C: server shape
**Main slots.** Correctness does not depend on the slot count, so slots are chosen with a throughput test, not graded trials:
- `slot_ctx = roundup_256(max(fill_tokens) + max(the output cap of section 6) + 512 overhead)`.
- Candidates 1, 2, 4 and 8 slots (`-np n -c n×slot_ctx`, or Locals `--slots n --max-context slot_ctx`). A candidate whose 4.1 estimate exceeds the memory budget is skipped without loading.
- n concurrent requests with a prompt of `fill_tokens.fact` tokens (the size real requests reach, not 2k) and 256 output tokens, twice; measure the parallel throughput `aggregate_tps`: the completion tokens of all n replies over the batch wall time, prefill included (so it is not a decode rate; review of a3862052, MINOR-1).
- **Choice:** the smallest n whose `aggregate_tps` is at least 90 % of the best. It replaces the provisional `MAIN_SLOTS = 2` and `LOCALS_MAIN_SLOTS = 4`.

**Scouting** (F7, A6).
- A calibration copy of the scout-accuracy fixture: the categories are shuffled by a seed (the permutation is recorded), and the category hashtags are removed from every record's `tags` (replaced by neutral tags drawn from one shared vocabulary), so the label cannot be copied from the record. The production fixture and its accuracy ledger are not changed by this.
- Shares in absolute tokens: 2048 and 4096 per request (the 40-record fixture cannot be built below about 2k tokens), at slots 4 and 8.
- Per candidate: 3 runs with different seeds, 40 records each (120 records).
- The request path: json_schema when Phase A proved the 40-item array works; otherwise the schema in the prompt and the text parsed. That text path does not exist yet in `classifyPositional`; P6 adds it, and P8/P9 reuse it.
- **Pass:** accuracy over the 120 records at or above `scout_accuracy_threshold` (default 0.95).
- **Record:** every scored candidate (`scouting_candidates`: share, slots, slot context, accuracy, records per second, seed). When the record is read, the current threshold picks the highest passing share and, at that share, the slot count with the best records per second (`scoutingFor`). If no candidate passes, scouting is unfit on that model, and mass-scouting goes to the next model of the profile that is fit (section 6). When no candidate could be scored at all, the record says why in `scouting_unfit_reason` ("over total RAM", "waited for free memory on 3 passes", "timed out on 3 passes", "lost its connection on 3 passes", or several joined by "or"), with an empty `scouting_candidates`; scouting is then unfit at any threshold, the main-slot result stands, the model is usable for everything else, and `calibration-status` prints the reason, so it never reads as an accuracy failure (coordinator decision, 2026-10-29).
- A scouting context is a different server shape: the broker keys queues by (model, ctx, engine), so mixing scouting with other commands on one model costs a stop and reload each time (about 4 s for LFM3, 52-62 s for the 4B GGUFs). That rotation cost belongs to P9 (F18).

**Speed.** llama: `timings.prompt_per_second` and `predicted_per_second`. Locals: streaming time-to-first-token for prefill, and completion tokens over the remaining wall time for decode. Plus `aggregate_tps` at the chosen slots (the parallel throughput, prefill included). Each with `load_avg`.

**Phase C as built** (main-agent decision, 2026-10-29; the user may override). The output cap in `slot_ctx` is, per kind, max(`min_output_tokens[k]`, the nominal cap of the thinking mode k runs in): a command's default `max_tokens` is a per-profile setting (`request_options.default.max_output_tokens`) that calibration cannot know. A model unfit for fact runs the throughput test at the 2048-token floor. Memory follows section 4.3's rule: a slot or scouting candidate that cannot fit total RAM minus the floor is skipped (recorded `skipped: memory`), one that fits it but not the free memory now makes the model wait; neither is a verdict. The harness carries the candidates (`mainSlots`, `scoutShares`, `scoutSlots`; production 1, 2, 4, 8 / 2048, 4096 / 4, 8; `HARNESS_VERSION` 5: 2 added the candidates, 3 discards progress made with the earlier Phase C method and Phase B resume rule, 4 redoes records made under the old scouting verdict rules, 5 redoes progress with the old `aggregate_decode_tps` key, transport failures scored as wrong, or string memory waits). Each scouting run sends one request per slot at once, each with its own calibration copy (seed = the candidate's `permutation_seed` + its index); accuracy and records per second are summed over the 3 runs, and a failed request scores all its records wrong. The record is written by the runner from the A, B and C summaries once all three passed; `thinking_works.off` is Phase B's value, `window_tokens` the smallest W of any counted trial.

**Phase C review fixes** (review of fb861fab; main-agent decision, 2026-10-29; the user may override). `slot_ctx` is sized per kind: roundup_256(max over k of (`fill_tokens[k]` + the output cap of k), or the throughput request if larger, + 512), since one slot holds one request of one kind. The main-slot throughput is the completion tokens of all n replies over the batch wall time, not a sum of each reply's own decode rate. A scouting run with a request that timed out or was lost to load (a dropped connection, HTTP 502/503/504) is repeated on the same copies (at most 2 repeats), after memory is checked again exactly as before the first run, and is never scored; a run still failing that way leaves the candidate inconclusive for this pass (`skipped: timeout`, or `skipped: transport` when no request timed out). A real error of the model (a bad reply, HTTP 400 or 500) is scored as wrong answers (review of a3862052, MINOR-6). Phase C tells these apart by the error prefixes `classifyPositional` exports, so the producer and the reader cannot drift (MINOR-4). A memory wait is bounded and visible: the progress file keeps when it started, when it was last checked, how much of it counted and the bytes the candidate needs, and `calibration-status` shows it (also while a model with an older record is calibrated again, MINOR-7). Only time a runner was checking counts: a gap of more than 5 minutes between two checks (the runner off, the machine asleep) adds nothing. A slot or scouting candidate still short of free memory after 30 minutes of checks is inconclusive for this pass (`skipped: memory-wait`). While a wait is open, a runner pass first checks free memory with the model unloaded and does not load the model while memory is still short (review of 2411e6dc, finding 2). Rule A (coordinator decision, 2026-10-29, review of 2411e6dc): an inconclusive candidate, main or scouting, is measured again on later passes, and while any candidate is still pending Phase C pauses: no verdict, no record, no pause counter, and the model stays queued, so a busy moment never decides the slot count or the scouting shape. Each such skip records `passes`, the number of runner passes on which the candidate stayed inconclusive; on the 3rd separate pass it is given up (terminal, `passes: 3`), and `calibration-status` prints each pending candidate's cause and "pass k of 3". Passes are counted, not wall time, so a sleeping machine does not use up the count, and a pass that paused on a memory wait before its 30 minutes were up records nothing and does not count. A candidate over total RAM minus the floor is terminal at once (`skipped: memory`) and keeps the floor it was judged against (`floor_pct`): under a different `LLM_EXT_BROKER_MEMORY_FLOOR` it is measured again (review of 2411e6dc, finding 11). Once nothing is pending, Phase C decides from the scored candidates: with no main-slot candidate scored, the model is too big for this machine's memory when every one is over total RAM minus the floor (rule 1, a calibration-failed record), and the calibration is memory-limited when any one was given up after its memory waits (rule 2, no verdict; 4.3 "Memory verdicts", coordinator decisions, 2026-10-29); with no scouting candidate scored, scouting is unfit with `scouting_unfit_reason` (section 7) and the model stays usable. So a record has an empty `scouting_candidates` without a reason only when candidates were measured and none reached the threshold. Phase B keeps its trials on a resume while the hard W is the same; only a different hard W starts Phase B again (section 3).

## 5. Time budget

The round-2 reviewer's estimate (Q5), adopted:

| | LFM3 1.7B | each 4B model |
|---|---|---|
| Per model, idle machine | about 1-2 h | about 3-6 h (the bug phase alone about 2-5 h: up to 4 steps of 10-20 thinking-on trials at about 2.5-6.5 min each) |

- **All six models, idle machine: about 16-30 h.**
- **A new profile's three models: 8-15 h or more of wall time**, because the machine is shared: the user's own requests and the load pause (its 15-minute average was already 17.8 against the 21 pause line at review time) stretch it.
- Under the held-job rule, a profile's first model is usable only when its record is complete: about 1-2 h for LFM3 and 3-6 h for a 4B model on an idle machine. The client prints this estimate when it first holds a request (section 11, Q2 offers provisional use instead).
- The dry run measures the 4B prefill rate and reasoning lengths; these replace the assumed rates before any full run.

## 6. How commands consume a record (P7, P8, P9)
For a request of task kind k on model m, with record R and the profile's `context_window` C (when set):
- `slot_ctx = min(C, R.main.slot_ctx)` (C absent: `R.main.slot_ctx`).
- `output_cap[k] = max(the command's own default max_tokens, R.min_output_tokens[k])`, or the user's `request_options.max_output_tokens` when set (coordinator decision 6). A calibrated value never lowers a command's cap.
- **Input budget (tokens)** (N5, coordinator decision 4):
  `input_budget[k] = min(R.fill_tokens[k], slot_ctx − output_cap[k] − prompt_overhead_tokens)`.
  It is converted to bytes with `/tokenize` (llama) or `R.chars_per_token` (Locals), and replaces the 400 KB default for managed local profiles. A per-call `max_payload_kb` still caps it. If the budget is below 1024 tokens (a `context_window` too small for the output cap), the command fails at once with a message naming C, the output cap and the smallest C that works.
- thinking: off for fact and aggregate, on for bug, unless Phase A reported thinking on broken (then off, reported). The user's `request_options.thinking` wins.
- `response_format`: sent only when `R.structured_output[mode]` is true.
- **Broker:** the main server starts with `R.main.slots` and `slot_ctx`; scouting requests use `R.scouting.*`; the broker dispatches at most that many requests at once.
- **Unfit kind** (F3, coordinator decision 9): a kind unfit at the 2048-token floor (or `scouting: unfit`) on model m sends the command to the next model of the same profile (second, then third) that is fit for that kind, in order. If no model of the profile is fit, the command fails with a clear message naming each model's record. Nothing is refused silently, and nothing is routed outside the profile. A kind whose answers do not fit the output cap is unfit this way, never a failed model (D1, main-agent decision, 2026-10-29; the user may override); `calibration-status` names a profile with no fit model for a kind (section 8).
- **No complete record:** the job is held (section 2), never refused.
- **Ensembles** (P8, F19): a member with no complete record is held like any other; a member unfit for the scan's kind is dropped with a warning naming its record; the scan proceeds while at least 1 member is left, and fails only when none is.
- Records are read once per command.

## 7. Record schema (version 2)
```json
{"schema": 2, "harness_version": 5, "harness": "production|custom:<sha256>", "fixture_version": 1,
 "engine": "llama|locals", "model": "<profile id>",
 "fingerprint": {"blobs": ["<sha256>"], "ram_bytes": 0},
 "engine_version": "...", "engine_version_checked": "...",
 "status": "ok|engine-check-failed|calibration-failed|memory-limited", "failed_step": null,
 // a calibration-failed record of a model too big for this machine's memory also has (rule 1, 4.3 "Memory verdicts"):
 // "memory_judged": {"total_ram_bytes": 0, "floor_pct": 10, "n_ctx_train": 0}
 "calibrated_at": "<ISO>", "duration_s": 0, "window_tokens": 32768, "free_ram_bytes": 0,
 // window_tokens: the smallest W any counted Phase B trial ran under (main-agent decision 2026-10-29, after review)
 "chars_per_token": 0,
 "capabilities": {"thinking": true, "n_ctx_train": 0},
 "thinking_works": {"off": "true|false|leaky", "on": true},
 "min_output_tokens": {"fact": 0, "aggregate": 0, "bug": 0},
 "fill_tokens": {"fact": 13107, "aggregate": 8192, "bug": 4096},
 "unfit_reasons": {"bug": "window 10240 too small for thinking on output"},
 "grid": [{"kind": "bug", "counter": "control", "tokens": 4096, "trials": 10, "passed": 8, "inconclusive": 1, "cuts": 1, "cut_fails": 0, "cut_cap": 8192},
          {"kind": "bug", "tokens": 13107, "skipped": "window", "W": 20480}],
 "structured_output": {"off": true, "on": false, "array40": true, "error": "..."},
 "main": {"slots": 2, "slot_ctx": 0},
 "scouting_candidates": [{"share_tokens": 2048, "slots": 8, "slot_ctx": 0, "accuracy": 0.97, "records_per_s": 0, "permutation_seed": 0}],
 "speed": {"prefill_tps": 0, "decode_tps": 0, "aggregate_tps": 0, "load_avg": 0}}
```
Only `status: ok` makes a model usable. The record is checked against this schema on read. Writing a record that fails the schema check is a bug and throws. Schema 2 (D6, main-agent decision, 2026-10-29; the user may override) adds `harness` (D4) and the "leaky" value of `thinking_works.off` (D5); a schema-1 record counts as missing. The optional `scouting_unfit_reason` (coordinator decision, 2026-10-29) is present only with an empty `scouting_candidates` and says why no scouting candidate was scored ("over total RAM", "waited for free memory on 3 passes", "timed out on 3 passes", "lost its connection on 3 passes", or several joined by "or"); it is an additive optional field, so the schema stays 2. The status `memory-limited` and the optional `memory_judged` (coordinator decisions, 2026-10-29; 4.3 "Memory verdicts") are additive too, so the schema stays 2: a memory-limited record, like a calibration-failed one, carries only the identity, status, `failed_step` and `message`, and `memory_judged` appears only on a calibration-failed record whose model is too big for this machine's memory.

## 8. Commands
- `llm-ext models calibration-status`: every managed model, its record status or progress, held jobs, paused time, inconclusive steps, thinking-direction problems (including `thinking_works.off: "leaky"`, D5), each unfit kind of an ok record, window-limited ("unfit for <kind>: window-limited (window W too small for thinking on|off output)"), memory-limited ("unfit for <kind>: memory-limited", a step of it given up after its memory waits) or quality-limited ("unfit for <kind>: quality-limited", with "(cut at N tokens)" when every fail was a cut at the nominal cap), and the time left; and one line per managed profile and kind that no model of it is fit for: "no model of profile X is fit for <kind>" once every model has a verdict, or "no model of profile X is fit for <kind> so far; N still calibrating" while some are still calibrating (D1, main-agent decision, 2026-10-29, amended after the review of a72827f9; the user may override). Memory verdicts (coordinator decisions, 2026-10-29, 4.3 "Memory verdicts"): a fill above 0 whose higher steps were given up after memory waits carries "(fill limited by free memory during calibration; `models calibrate --force` measures it again)" (rule 3); a memory-limited record says when it is calibrated again (rule 2); a too-big record whose total RAM or floor changed says it is judged again on the next request (rule 1).
- `llm-ext models calibrate --model <id> [--force]`: adds the model to `queue.json` and starts the runner (detached), then returns at once.
- `llm-ext models server-status` and `server-stop`: also list and stop the cal servers.

## 9. Tests (P6b, real, no mocks)
- **Scorer unit tests with degenerate answerers** (coordinator decision 16). Each must FAIL every scorer it targets, at every step:
  - always `{"file": null, "line": null}` (passes every control, fails every bug trial, so the bug step fails);
  - always the first line of the planted function, and always the last line of the file;
  - always one fixed real line of a corpus file;
  - every vault code in the document (fails "no other code");
  - always a decoy code; always the first needle's code;
  - a count that is always 5, and the list of every capitalised word;
  - scouting: the label cycle copied from the first records, a constant label, and labels copied from the record's tags (with the hashtags removed this must score near chance);
  - a reply that is only a think block (thinking-off check), a reply cut at `max_tokens` (rerun on a new document, then a fail: D1), and a reply that timed out (inconclusive, never fail).
- **Unit:**
  - scoring: fact (code, no other vault's code, thinking stripped, normalisation), aggregate (count and set), bug (file, ±1 line, control);
  - fixture determinism (same seed, same text), the shuffled and de-tagged scouting copy;
  - the adaptive grid, the token floor, the two-counter sequential rule, inconclusive handling and the paused step;
  - output floors from passing, non-truncated trials only; `max_tokens` never below the command default;
  - the input-budget formula with and without `context_window`, and the too-small-context failure;
  - the KV estimate from GGUF and config.json metadata, including per-layer and sliding-window layers;
  - slot selection;
  - triggers: first use, a changed id in a used profile, no trigger for an unused built-in; the state lock under concurrent writers;
  - record schema read and write, corrupt record counted as missing, invalidation by every listed cause (blob, RAM, versions, force), and the hard-W resume rule (Phase B kept while the hard W is the same, restarted when it changes);
  - unfit routing to the next fit model, and the ensemble rule.
- **Broker:** a held job: not in `allQueued()`, never rotated or deadline-driven, never starts a main server, released to `queued` when the record appears, failed when the record says `calibration-failed`, cancelled when its client gives up; per-model counts in `/v1/health`.
- **Real:** with the tiny GGUFs CI already uses, a full run with a reduced harness (steps 2048 and 4096, W 4096) checks the mechanics:
  - cal role in the registry, never more than 1 cal and 1 main;
  - the orphan sweep of a cal entry after SIGKILL of the runner, then a resume that reuses finished trials;
  - the crash counter (a cal server killed 3 times in one step gives `calibration-failed`);
  - a real client request for the model under calibration is held, does not pause the runner, and is served once the record is written;
  - a real request for another model pauses the runner; aborted trials are not counted;
  - an atomic record;
  - the tiny models will mostly score unfit: the test checks the verdicts and the mechanics, not their quality.
- **Opt-in** (`RUN_REAL_LOCAL_MODELS=1`): the dry run below; and (D7, main-agent decision, 2026-10-29; the user may override) a reduced-harness Phase B run on the LFM3 GGUF that checks the orphan sweep after a SIGKILL, the resume that reuses finished trials, and a cap cut scored as a fail. The tiny GGUFs cannot run Phase B: llama-server caps their slot at their trained context of 128 tokens.

## 10. P6a dry run (after the user's answers; about 1 h, LFM3 GGUF only)
`AtomicChat/LFM3-1.7B-Uncensored-GGUF:AD-Q6_K` on a cal server, with a reduced harness:
- Phase A in full;
- Phase B with steps 4096 and 13107, fact, aggregate and bug, 5 trials per counter;
- Phase C with slots 1 and 2, scouting share 2048 at slots 4, one run.

Plus the Nanbeige GGUF Phase A json_schema check only (known answer: unsupported), and one 4B bug trial at 8192 tokens with thinking on, to measure the reasoning length and prefill rate that section 5 assumes.

**Acceptance:**
- a record that passes the schema check;
- registry entries with role cal only (the main untouched);
- one SIGKILL of the runner, the orphan sweep, and a resume that reuses the finished trials;
- one real `llm ask` on the LFM3 model during the run: held, no main server started, served after the record;
- one real `llm ask` on another local model during the run that pauses calibration, with the pause and resume logged;
- `~/.locals/config.json` checksum unchanged (it is still unverified whether `locals.server` writes it), port 8321 and the user's processes untouched.

Results go to `reports/llama-cpp-profile/<ts>-p6a-dry-run.md`, with the measured trial times that replace the assumed rates in section 5.

## 11. Open questions for the user
1. **W beyond 32768** (F12). Calibrating at 32768 sizes inputs up to about 13k tokens. The user cited LFM3's 256k window. Extending W to 65536 adds the top step's trials at twice the size (several hours more per 4B model); 131072 more again. Option: offer `models calibrate --window 65536` per model later.
2. **Held until calibrated, or provisional use** (F13). As designed, a request for a model without a complete record is held until the record exists: hours for a new profile (section 5). The alternative: once a model passes Phase A (about 10-15 min), it serves requests with conservative provisional settings (8192 context per slot, one slot, thinking per the ruling) while Phases B and C finish. That is using the model during calibration, which the earlier answer "No, wait" refused. Please confirm "held", or approve provisional use.
3. **Scouting context** (F18). "Reduced context memory to make the models run faster" for mass-scouting is still the main agent's reading, to be confirmed; it costs a server reload on each switch.
4. **`~/.locals/config.json`** (F22). Its port was changed from 8321 to 9090 earlier and has not been restored. Restoring it is the user's call; calibration never touches the file.

## 12. Review findings and what changed

Round 1:

| Finding | What changed |
|---|---|
| F1 trigger too wide | Section 3: first use (via a held job), a user-added or changed model in a used profile, and `models calibrate`. Never on boot for unused profiles. |
| F2 single-needle fact | 4.3: multi-needle fact trials, and a separate aggregate kind on its own documents. |
| F3 bug unfit by W fraction, then two contradicting rules | 4.3: absolute-token steps and a 2048-token floor. Section 6: an unfit kind goes to the next fit model of the same profile, in order, else the command fails clearly. Revision 2's contradiction is gone. |
| F4 thinking text scored | Section 4: only the answer is scored, thinking stripped, normalised. |
| F5 bug rule guessable | 4.3: line-numbered files, a single `{file, line}` answer, ±1 line, a no-bug control with its own counter, a screened corpus. |
| F6 too few trials | 4.3: sequential trials, two separate counters for bug; no thinking vote. |
| F7 scouting guessable | 4.5: seeded shuffle, hashtags removed from the calibration copy, 3 runs of 40 records; 4.2: a 40-item array schema probe. |
| F8 budget too low | Section 5: the round-2 estimate, 16-30 h for all six (idle), 8-15 h or more for a new profile. |
| F9 cheaper design | Kept: Phases A, B, C. |
| F10 thinking vote overturns the ruling | 4.4: thinking follows the ruling; Phase A checks both directions. |
| F11 context_window | Done in e253b758; precedence in section 3 and the formula in section 6. |
| F12 131072 cap | W at most 32768; open question 1. |
| F13 "No, wait" | Section 2: provisional use removed; jobs are held until the record is complete; provisional use is open question 2. |
| F14 pause and starvation | Section 2: stop below the memory floor at once, otherwise after 5 min; the 15-min minimum slice overrides both the broker pause and the load pause. |
| F15 output caps | Section 6: calibrated floors only, never below the command default. |
| F16 thinking ids | 4.2: Phase A checks thinking off and on per model and engine. |
| F17 json_schema fallback | 4.5: P6 adds the schema-in-prompt text path. |
| F18 scouting swaps | 4.5: recorded, cost belongs to P9; open question 3. |
| F19 ensembles, re-calibration | Sections 3 and 6: blob, RAM and threshold triggers, `free_ram_bytes` and the hard-W resume rule (section 3), the ensemble rule. |
| F20 orphaned cal server | Section 2: the sweep covers cal entries. |
| F21 memory and crashes | 4.1: KV estimate before the first load; section 2: timeouts from the cap and decode rate, inconclusive trials, crash counter. |
| F22 logs, inputs, marker, contention | Section 2: the log cap restarts the cal server; seeds instead of inputs; the Locals marker; a load-average pause; open question 4 for the Locals config. |

Round 2:

| Finding | What changed |
|---|---|
| N1 no broker mechanism for waiting | Section 2: the `held` job state (outside the scheduler, no deadline, no rotation, never starts a main server, released when the record appears), and per-model `queued/running/held` in `/v1/health`. |
| N2 thinking-off contradiction | 4.2: thinking off must work, or Phase A fails; the "scored after stripping" path is deleted. |
| N3 timeouts as quality failures | Section 2: a cap hit or a timeout is inconclusive, rerun once; two in a row pause the step; timeouts = 3 × (prefill + cap / decode) from the measured rates. |
| N4 no reasoning cap, inflated floors | Section 2: `max_tokens` 8192 thinking on, 2048 off; 4.3: floors only from passing, non-truncated trials. |
| N5 input budget ignores context_window | Section 6: `input_budget = min(fill_tokens, slot_ctx − output_cap − overhead)`, `slot_ctx = min(context_window, R.main.slot_ctx)`, and a clear failure when the budget is too small. |
| N6 request_options fields unknown to the validator | Dropped: `input_fill_pct` and `structured_output` are removed from the design; the validator is unchanged. |
| N7 snapshot revision in the fingerprint | Section 3: blob sha256 of each weight file. |
| N8 8k speed prompt in an 8k context | 4.2: Phase A loads at 16384. |
| N9 12288 step | 4.3: dropped; steps 2048, 4096, 8192, 0.40 × W. |
| A1 aggregate rule | 4.3: separate documents, 3-9 vaults, no decoys; count and list are separate trials, each with its own pass rule. |
| A2 pooled or separate counters | 4.3: two separate sequential counters (bug, control); both must pass. |
| A3 do jobs for the calibrating model pause it | Section 2: no; only queued or running work for OTHER models pauses the runner, and held jobs never do. |
| A4 slice versus load pause | Section 2: the minimum slice overrides the load pause too; only the memory floor stops it. |
| A5 does a waiting model preempt | Section 2: no; it goes first in line after the model being calibrated. Only `status: ok` is a usable record. |
| A6 scouting sample size | 4.5: 3 runs of 40 records per candidate, accuracy over all 120. |
| A7 which layers count for KV | 4.1: the per-layer `head_count_kv` array (0 = no KV), sliding-window layers at min(W, window), Locals `layer_types`; unknown means every layer counts. |
| A8 who writes the state files, races | Section 3: the broker client writes `used-profiles`; all three files change only under `calibration/state.lock` with read-modify-write and atomic rename. |
| Q4 degenerate answerers | Section 9: scorer unit tests with degenerate answerers. |
| Q4 "exact" known answer | 4.2: whole-word match after normalisation. |
| Q4 slot test on 2k prompts | 4.5: the throughput test uses prompts of `fill_tokens.fact`, twice. |
| Q5 time estimate | Section 5: adopted. |

Round 3 (implementation, P6b step 5: `reports/llama-cpp-profile/20261029_075217+0100-p6b-5-phase-b.md`). Each is a main-agent decision, 2026-10-29; the user may override:

| Finding | What changed |
|---|---|
| D1 a cap cut failed the whole model | Section 2 and 4.3: a trial cut at `max_tokens` is rerun once on a new document; cut again, it is a FAIL in the sequential rule. The step walks down the grid like any fail, and the 2048 floor makes the kind unfit (`fill_tokens.<kind> = 0`). The model is never calibration-failed for a cap cut. Section 8: `calibration-status` says when no model of a profile is fit for a kind. |
| D2 timeouts | Section 2: unchanged, inconclusive with the pause bound, so a model too slow by itself cannot hold jobs forever. |
| D3 a network error with the server alive | Section 2: inconclusive and rerun only when the server is still alive when checked after the error, with the same pid and no restart; otherwise it counts towards the crash limit. |
| D4 the reduced harness can write a record | Section 3 and 7: the record stores `harness`: "production" (tied to `harness_version`, bumped whenever the production harness changes) or "custom:<sha256 of the LLM_EXT_CALIBRATION_HARNESS JSON>". Any id other than "production" at the current `harness_version` counts as missing. Compared by id and version, never by deep-equal. |
| D5 leaky thinking-off (LFM3 reasons in its visible answer) | 4.2: the thinking-off known-answer trial must also end with `finish_reason: stop` within 256 tokens; `thinking_works.off` is true, false or "leaky". "leaky" does not fail Phase A (whether it should is a user decision: the goal names that LFM3 model); `calibration-status` shows it. |
| D6 record fields changed | Section 7: `schema` 2. |
| D7 rerun input; real test | 4.3: a rerun uses a new document of the same kind and size (temperature 0 repeats a cut). Section 9: the tiny GGUFs cap their context at 128, so the real Phase B test is opt-in (`RUN_REAL_LOCAL_MODELS=1`, LFM3 GGUF, reduced harness: sweep, resume, a cap cut). |
| Review of a72827f9 (main-agent decision, 2026-10-29; the user may override) | D1: only a cut at the nominal cap (8192 thinking on, 2048 thinking off) is rerun then failed; a cut at a squeezed cap stays inconclusive; trials store the cap, grid entries count `cuts`, `cut_fails`, `cut_cap`; `calibration-status` says "cut at N tokens" for an unfit kind whose fails were all cuts, and a provisional "so far; N still calibrating" line. D5: the median of every short thinking-off answer (Phase A and Phase B), the record takes Phase B's value. D4: the progress file stores the harness id; a test pins PRODUCTION_HARNESS's hash to HARNESS_VERSION. |
| Squeezed grid steps (main-agent decision, 2026-10-29, amended after review; the user may override) | 4.3 "Grid steps and the window": hard W versus soft W; a step that does not fit the hard W is skipped (window-limited, recorded in the grid), one that fits only the hard W waits for memory; checked as each step runs; the nominal cap of the mode that runs; a squeezed cap throws; `window_tokens` = the smallest W of any counted trial. Section 8: `calibration-status` tells window-limited from quality-limited. |
| Phase B memory waits (coordinator decision, 2026-10-29) | 4.3 "Phase B memory waits": the bound, precheck and rule A of Phase C through one shared mechanism; a step that only waited never fails (memory-wait grid skip, the walk steps down); `B/window` given up is memory-limited (rule 2); a hard W under the smallest window is too big for this machine's memory (rule 1). |
| Memory verdicts, rule 1: can never fit (coordinator decision, 2026-10-29) | 4.3 "Memory verdicts": a hard W under the smallest window and Phase C main slots all over total RAM minus the floor give one `calibration-failed` record, "too big for this machine's memory", with `memory_judged` (total RAM, `floor_pct`, trained context); a total-RAM or floor change makes it count as missing and re-queues the model. Section 7: `memory_judged`. |
| Memory verdicts, rule 2: only waited (coordinator decision, 2026-10-29) | 4.3 "Memory verdicts": a calibration whose deciding step (`B/window`, or Phase C with no main slot scored and one given up after its memory waits) was given up gets `status: memory-limited`, neither a pass nor a failure; jobs fail at once with the fix for 1 hour, then the first request re-queues it with fresh pass counters. Replaces "B/window given up passes with every fill 0" and "no main slot scored fails the model" for that case. Section 7: the status value. |
| Memory verdicts, rule 3: fill limited by free memory (coordinator decision, 2026-10-29) | 4.3 "Memory verdicts" and section 8: a kind with fill above 0 whose higher steps were given up after memory waits shows "(fill limited by free memory during calibration; `models calibrate --force` measures it again)". |
| Phase C built (main-agent decision, 2026-10-29; the user may override) | 4.5 "Phase C as built": the output cap in `slot_ctx`, the 2048 throughput floor, candidates skipped or waiting on memory, the harness candidates (`HARNESS_VERSION` 5, pinned by a test), the scouting batch shape, and the record writer. The text path of `classifyPositional` is tested against the production scout fixture and the calibration copy. |
| Code review of 2026-10-30 (`reports/code-review/20261030_052812+0100-release-1420-five-commits.md`; main-agent decisions, 2026-10-30; the user may override) | M1: 4.3 "Phase B memory waits": a Phase B wait stores what a fresh unloaded reading must show (the step rounded to its 256-token window step, or this reading plus the post-load shortage, or more than total RAM for a server-context cap), so the precheck and the wait agree and a waiting pass loads nothing; the 5-minute gap rule is unchanged. m1: rule 2, a forced calibration that only waited keeps a current ok record. m3: rule 1, the floor comes from the environment only, by design. |
