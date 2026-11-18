# llm-ext reference: models and settings groups

Flags are written `--name value`; booleans take `true`/`false`. Every action also accepts the global flags (`--quiet`, `--profile <name>`, `--command_timeout <s>`, `--queue_timeout <s>`; see cli-conventions.md). All text below comes from `llm-ext <group> <action> --help`.

## Contents

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
- Network give-up window (`network_give_up_seconds`, `--network_give_up`)
- Switching off or pinning the local fallback (`fallback_to_local`)

## `models` group


### `llm-ext models info`

- Usage: `llm-ext models info [model] [--flag value ...]`
- Bare argument: `--model`
- Accepted profile types: any

Query OpenRouter for detailed information about a specific model by its EXACT id (e.g. 'nvidia/nemotron-3-super-120b-a12b:free' or 'anthropic/claude-sonnet-4'). Returns model metadata, per-endpoint provider info, context length, pricing, supported request-body parameters (reasoning, temperature, top_p, etc.), quantization, uptime, latency percentiles, and throughput. Uses the /v1/models/{id}/endpoints OpenRouter endpoint. Only works when the active profile is configured for OpenRouter. Use this before calling a new model to verify which parameters it accepts and what pricing applies.

| Flag | Type | Meaning (as printed by --help; long text is truncated there) |
|---|---|---|
| `--model` | string | (required) Exact OpenRouter model id (e.g. 'nvidia/nemotron-3-super-120b-a12b:free'). Must match the id... |

Example:
```bash
llm-ext models info z-ai/glm-5.2:free
```

### `llm-ext models assess`

- Usage: `llm-ext models assess [model] [--flag value ...]`
- Bare argument: `--model`
- Accepted profile types: any

Assess ONE OpenRouter model against EVERY LLM tool's per-tool REQUIREMENTS (TRDD-f45eeaa0) — FREE: makes NO LLM call (no token cost), only a public model-catalog fetch (no API key). Reports, per tool, whether the model meets that tool's hard requirements (cost/context/output/params) and whether the tool ALSO has a benchmark gate to run before assignment. Does NOT run any benchmark. RETURNS: a per-tool OK/NO table + which qualifying tools still need a benchmark pass.

| Flag | Type | Meaning (as printed by --help; long text is truncated there) |
|---|---|---|
| `--model` | string | (required) OpenRouter model id, e.g. 'google/gemini-2.5-flash'. |

Example:
```bash
llm-ext models assess google/gemini-2.5-flash
```

### `llm-ext models health`

- Usage: `llm-ext models health [--flag value ...]`
- Bare argument: none (everything goes through flags)
- Accepted profile types: any

Self-check the CONFIGURED model(s) of the active profile (TRDD-828238b5) — FREE: makes NO LLM call (no token cost), only a public model-catalog fetch (no API key). For the main / second / third model and every tool_models entry it reports: (1) PRESENCE — is the id still in the OpenRouter catalog or deprecated/removed; (2) COST DRIFT — has the price moved vs a seeded baseline; (3) REQUIREMENTS REGRESSION — does it still meet the requirements of every tool it serves. ADVISORY only — writes a report and returns its path; never changes settings (the server is read-only). Takes no arguments.

No flags besides the global ones.

Example:
```bash
llm-ext models health
```

### `llm-ext models discover`

- Usage: `llm-ext models discover [--flag value ...]`
- Bare argument: none (everything goes through flags)
- Accepted profile types: any

Autodiscover models that newly appeared in the OpenRouter catalog since the last run (TRDD-828238b5) — FREE: makes NO LLM call (no token cost), only a public model-catalog fetch (no API key). Diffs the live catalog against a seeded snapshot and, for each new id, assesses it against every per-tool requirements gate so you can see which arrivals are worth adopting. ADVISORY only — writes a report and returns its path; never changes settings (the server is read-only). First run seeds the snapshot and reports zero arrivals.

| Flag | Type | Meaning (as printed by --help; long text is truncated there) |
|---|---|---|
| `--qualifying_only` | boolean | When true, report only arrivals that meet ≥1 tool's requirements. Default false (report... |

Example:
```bash
llm-ext models discover --qualifying_only true
```

### `llm-ext models replacements`

- Usage: `llm-ext models replacements [--flag value ...]`
- Bare argument: none (everything goes through flags)
- Accepted profile types: any

READ-ONLY advisory auto-replacement planner (TRDD-828238b5 A7) — for every LLM tool that HAS a per-tool benchmark (security_scan, search_existing_implementations), asks 'is its incumbent model degraded?' by aggregating the durable model-health ledger, and (only when degraded, or when `force` is set) runs that tool's ADVISORY benchmark to surface the best SAME-OR-CHEAPER replacement. On a healthy/empty ledger it runs NO benchmark and recommends keeping every incumbent (zero false positives). ADVISORY ONLY — writes a markdown report + returns its path; it NEVER rewrites settings. To actually adopt a recommendation, run the CLI `llm-ext-benchmark --auto-replace --apply` (the sole writer path; this command is read-only by design and never mutates settings).

| Flag | Type | Meaning (as printed by --help; long text is truncated there) |
|---|---|---|
| `--allow_paid_models_tests` | boolean | Opt-in to benchmarking PAID (non-free) models when a degraded incumbent triggers a... |
| `--force` | boolean | Run every benchmarked tool's benchmark even when its incumbent is NOT degraded — an explicit... |
| `--models` | array | Explicit candidate model id(s) forwarded to each benchmark that runs. When omitted, each... |
| `--output_dir` | string | Report dir; defaults to <main-root>/reports_dev/llm-externalizer/auto-replace/. |
| `--profile` | string | Selects the settings profile for this invocation only (a key under `profiles:` in ~/.llm-externalizer/settings.yaml). When omitted, the `active:` key in settings.yaml decides, and 'free' is used when that is missing too. Never modifies settings.yaml. An unknown name fails fast and lists the available profiles. |

Example:
```bash
llm-ext models replacements
```

### `llm-ext models calibrate`

- Usage: `llm-ext models calibrate [--flag value ...]`
- Bare argument: none (everything goes through flags)
- Accepted profile types: any

Queue ONE model of a managed local profile (`server: managed`, api `llamacpp-local` or `locals-local`) for calibration and start the detached calibration runner. Calibration measures what the model can do on this machine (safe input size per task kind, output caps, json_schema support, server slots). Until the model has a complete record, requests for it wait (they are held). This can take hours. The command returns at once; follow it with `llm-ext models calibration-status`. A model that already has a record is refused unless `--force` is set. A model of a managed profile is also calibrated once, automatically, on its first use or when a model id changes in a profile that has been used.

| Flag | Type | Meaning (as printed by --help; long text is truncated there) |
|---|---|---|
| `--model` | string | (required) The model id exactly as a managed local profile names it (model, second_model or third_model). |
| `--force` | boolean | Calibrate again even when a valid record exists. Default false. |

Example:
```bash
llm-ext models calibrate --model LiquidAI/LFM3-1.7B-MLX-4bit
```

### `llm-ext models calibration-status`

- Usage: `llm-ext models calibration-status`
- Bare argument: none
- Accepted profile types: any

Show the calibration state of every model of the managed local profiles: calibrated (with the date), failed (with the step and reason), or its progress and queue state. Takes no parameters.

Example:
```bash
llm-ext models calibration-status
```

## `settings` group


### `llm-ext settings show`

- Usage: `llm-ext settings show [--flag value ...]`
- Bare argument: none (everything goes through flags)
- Accepted profile types: any

Read-only view of settings.yaml. Prints the EFFECTIVE profile's fully resolved settings (mode, backend, model(s), timeout, context window, auth status) to stdout, and also copies the raw settings file to the output directory, returning the copy's path for manual editing. This tool cannot write settings — model & profile changes are user-only. Edit ~/.llm-externalizer/settings.yaml manually in your editor, then call the 'reset' tool (or restart Claude Code) to reload.

No flags besides the global ones.

Example:
```bash
llm-ext settings show
```

### `llm-ext settings profile`

- Usage: `llm-ext settings profile [--flag value ...]`
- Bare argument: none (everything goes through flags)
- Accepted profile types: any

Read-only view of the profiles defined in settings.yaml. With no arguments, lists every profile (name, whether it is the EFFECTIVE one for this invocation, mode, backend, model(s), and whether free_only is set). With `show`, prints the full resolved detail for that one profile (concrete model, protocol, timeout, context window, free pool, per-tool overrides). This tool cannot add, switch, edit, or remove a profile — profile configuration is user-only. Edit ~/.llm-externalizer/settings.yaml manually to change a profile's fields, then call 'reset' to reload. Profile selection precedence: a `--profile <name>` flag on the invocation wins first; otherwise the `active: <name>` key in settings.yaml wins; otherwise the built-in 'free' profile is used. 'free', 'paid', and 'local' are built-in dynamic profiles that llm-ext itself owns and regenerates in the background whenever the OpenRouter catalog or the detected local endpoints change — they never need hand-editing. Within one selected profile, a failing model falls back to the next candidate in that same profile only (dynamic profiles in the order their section lists them — the benchmark's order for free and paid, probe order for local; static profiles fall back in listed order); a profile is never switched for another. A static profile whose models are all failing errors with "the models in the selected profile are all failing; retry later or change the profile"; a dynamic profile instead announces and waits for its background update.

| Flag | Type | Meaning (as printed by --help; long text is truncated there) |
|---|---|---|
| `--show` | string | Name of one profile to show full resolved detail for. Omit to list every profile instead. |

Example:
```bash
llm-ext settings profile --show free
```

### `llm-ext settings profiles`

- Usage: `llm-ext settings profiles [--flag value ...]`
- Bare argument: none (everything goes through flags)
- Accepted profile types: any

Read-only list of every profile defined in ~/.llm-externalizer/settings.yaml — the three built-in dynamic profiles ('free', 'paid', 'local', machine-managed and regenerated in the background as the OpenRouter catalog or the detected local endpoints change) plus any static profile the user has added by hand — with a marker on whichever one is EFFECTIVE for this invocation (--profile flag > settings.yaml `active:` key > built-in 'free'). One line per profile (name, mode, backend, model(s) or free_only pool size). This tool cannot add, switch, edit, or remove a profile; edit settings.yaml manually and call 'reset' to reload. Reports plainly (never crashes) if settings.yaml does not exist yet — it is created automatically the first time any llm-ext command runs.

No flags besides the global ones.

Example:
```bash
llm-ext settings profiles
```

### `llm-ext settings reset`

- Usage: `llm-ext settings reset [--flag value ...]`
- Bare argument: none (everything goes through flags)
- Accepted profile types: any

Full soft-restart. NOT IMMEDIATE — waits for all currently running LLM requests to finish before resetting. Then: reloads settings.yaml from disk, clears all caches (model list, concurrency, LM Studio detection), resets session counters (tokens/cost/calls), re-resolves the active profile, and notifies the client to refresh the tool list. Use when settings were changed externally, the backend is misbehaving, or you need a clean slate.

No flags besides the global ones.

Example:
```bash
llm-ext settings reset
```

### `llm-ext settings status`

- Usage: `llm-ext settings status [--flag value ...]`
- Bare argument: none (everything goes through flags)
- Accepted profile types: any

Check service availability, active profile, auth status, available profiles and API presets. Returns: status (online/offline), active profile name/mode/model, auth token status (shows whether env vars like $LM_API_TOKEN or $OPENROUTER_API_KEY are resolved), context window, concurrency mode, response latency, session usage, and lists of available profiles/presets for editing guidance. Call this before delegating work.

No flags besides the global ones.

Example:
```bash
llm-ext settings status
```

### `llm-ext settings scan-local`

- Usage: `llm-ext settings scan-local [--flag value ...]`
- Bare argument: none (everything goes through flags)
- Accepted profile types: any

Scan well-known local ports (LM Studio, Ollama, vLLM, llama.cpp, Jan, generic OpenAI-compatible) for a running LLM service and print the results as a NUMBERED list, with any loaded/available model ids and installed-but-stopped CLI evidence (lms, ollama). Prints only — never touches settings.yaml — unless `pick` is given: with `pick`, probes the chosen service, generates a settings.yaml profile section for it (mode local, the matching api preset, the detected model, and context_window when the server reports one), writes it, and makes it the ACTIVE profile. When run at an interactive terminal without `pick`, asks which numbered entry to configure.

| Flag | Type | Meaning (as printed by --help; long text is truncated there) |
|---|---|---|
| `--pick` | number | 1-based index from the numbered scan list to configure and activate. Omit to only print the... |

Example:
```bash
llm-ext settings scan-local
```

## Managed local models

Two local profiles are built in and added to `settings.yaml` once, never active by default: select one with `--profile local_llama` or `--profile locals-mlx`.

`llm-ext models server-status` lists the registered managed local servers (with their threads) and the local inference governor figures; `llm-ext models server-stop [--engine llama|locals] [--role main|cal|all]` stops them (only registered ones; the broker starts a new main server only when work arrives)

| Profile | Engine | Models (`model`, `second_model`, `third_model`) |
|---|---|---|
| `local_llama` | GGUF models through llama.cpp's `llama-server` (api `llamacpp-local`) | `AtomicChat/LFM3-1.7B-Uncensored-GGUF:AD-Q6_K`, `bartowski/Nanbeige_Nanbeige4.2-3B-GGUF/Nanbeige_Nanbeige4.2-3B-Q6_K.gguf`, `insraq/Qwen3.5-4B-EmperoAI-Qwen3.8-Distill-Heretic-Abliterated-MTP-GGUF/Qwen3.5-4B-EmperoAI-Qwen3.8-Distill-Heretic-Abliterated-MTP-GGUF-Q8_0.gguf` |
| `locals-mlx` | MLX models through the Locals server (api `locals-local`; macOS on Apple silicon only) | `LiquidAI/LFM3-1.7B-MLX-4bit`, `mlx-community/Nanbeige4.2-3B-OptiQ-4bit`, `mlx-community/Qwen3.5-4B-MLX-4bit` |

Both use `server: managed`: llm-ext starts and stops the model server itself. You do not run it. `local_llama` needs a llama.cpp build with LFM3 support.

- **Request broker.** A local broker serves all managed profiles. It runs one local model server at a time, whatever the engine (the broker never runs a llama-server and a Locals server together). The calibration runner is a separate process: it may run its own short-lived calibration server beside that one, for the model being calibrated, and pauses while the broker has work for another model. It groups the queued requests by model and rotates to the next model when the current one has had its minimum slice and another model's request is nearing `--queue_timeout`. If a model fails, the command falls back to the next model of the same profile.
- **Calibration.** A model of a managed profile is calibrated once, automatically: on its first use, or when a model id changes in a profile that has been used (a profile nobody used is never calibrated on its own). Requests for it are held until its record is complete, which can take hours. Held requests are bounded only by `--command_timeout`. Check progress with `llm-ext models calibration-status`. Start or redo it by hand with `llm-ext models calibrate --model <id> [--force]`; `--force` is required when a record already exists.
- Calibration pauses while the broker has work for another model and waits a bounded time for free memory; if memory stays short, the model gets a `memory-limited` record.

### Local model catalog

The catalog (`scripts/llm-ext/src/local-model-catalog.ts`) lists the local models llm-ext knows, and listing a model never downloads or calibrates it. No runtime code reads the catalog yet. A test checks that every entry has a row here, with the same size and refusals cells, and that the models of the two built-in profiles and the served decider are catalog entries. In the last column, yes means llm-ext knows no reason it cannot run the model, not that it was verified: only the served decider is recorded as verified, the VL and Omni GGUFs rest on their model cards, and abliter8-ai reports its own tests on llama.cpp with a server patch.

| Model id | Role | Runtime | Inputs | Refusals removed | Size in bytes (weights + projector) | Runs in llm-ext |
|---|---|---|---|---|---|---|
| `AtomicChat/LFM3-1.7B-Uncensored-GGUF:AD-Q6_K` | chat | llama.cpp | text | yes | 1587969920 | yes |
| `bartowski/Nanbeige_Nanbeige4.2-3B-GGUF/Nanbeige_Nanbeige4.2-3B-Q6_K.gguf` | chat | llama.cpp | text | no | 3595603104 | yes |
| `insraq/Qwen3.5-4B-EmperoAI-Qwen3.8-Distill-Heretic-Abliterated-MTP-GGUF/Qwen3.5-4B-EmperoAI-Qwen3.8-Distill-Heretic-Abliterated-MTP-GGUF-Q8_0.gguf` | chat | llama.cpp | text | yes | 4610580640 | yes |
| `LiquidAI/LFM3-1.7B-MLX-4bit` | chat | mlx-locals | text | no | 973083386 | yes |
| `mlx-community/Nanbeige4.2-3B-OptiQ-4bit` | chat | mlx-locals | text | no | 3303644285 | yes |
| `mlx-community/Qwen3.5-4B-MLX-4bit` | chat | mlx-locals | text | no | 3034300695 | yes |
| `AtomicChat/LFM3-VL-2B-GGUF:AD-Q4_K_M` | chat | llama.cpp | text, image | no | 1132207168 + 378995488 | yes |
| `AtomicChat/LFM3-Omni-2B-GGUF:AD-Q4_K_M` | chat | llama.cpp | text, image, audio | no | 1132209888 + 949841152 | yes |
| `AtomicChat/LFM3-Audio-2B-GGUF:AD-Q4_K_M` | speech | llama.cpp | text, audio | no | 1132205824 + 570846304 | a speech model (ASR and TTS); llm-ext sends text completions only. |
| `abliter8-ai/lfm3-2b-vl-abliter8-gguf:Q4_K_M` | chat | llama.cpp | text, image | yes | 1099627392 + 378995328 | yes |
| `mizahnyx/lfm3-omni-2b-abliterated-heretic-v2-GGUF:Q4_K_M` | chat | llama.cpp | text, image, audio, video | yes | 1099629696 + 506841856 | yes |
| `baselabs/elephant-1` | decider | vendor | text, image | no | 18819722392 | CUDA-only safetensors run by the vendor engine (qev); llm-ext reaches the decider only through the mlx-decision server. |
| `sergolsub/mlx-elephant-v1-9B` | decider | vendor | text, image | no | 11380138801 | MLX weights run by the vendor loader onejev_mlx.py, not by mlx_lm or Locals; llm-ext reaches the decider only through the mlx-decision server. |
| `elephant-1` | decider | mlx-decision | text | no | not known (served by mlx-decision) | yes |

## Local inference governor

Every llm-ext process that runs a local model (the broker, a calibration run, a direct send to a model server on a loopback address: LM Studio, Ollama, llama.cpp, vLLM) asks one machine-wide governor first. Work starts only while RAM and CPU are under their limits, and never more than `max_inferences` inferences at once across all processes. Waiting is never an error: the waiter prints its reason once a minute, and only `--command_timeout` bounds the wait. A LAN or remote server is never governed.

`settings.yaml` (each key has an env override, which wins; out of range or an unknown key fails at once):

```yaml
local_governor:
  enabled: true        # LLM_EXT_GOVERNOR_ENABLED (true or false)
  ram_limit_pct: 80    # LLM_EXT_GOVERNOR_RAM_LIMIT_PCT, 50-99
  cpu_limit_pct: 80    # LLM_EXT_GOVERNOR_CPU_LIMIT_PCT, 10-100 (100 = no CPU limit)
  max_inferences: 8    # LLM_EXT_GOVERNOR_MAX_INFERENCES, 1-256
  server_threads: 0    # LLM_EXT_GOVERNOR_SERVER_THREADS, 0 = half the thread budget
```

- RAM used is anonymous + wired + compressed memory (file cache is not counted). `ram_limit_pct` also sets the free memory calibration keeps (`100 - ram_limit_pct`); setting `LLM_EXT_BROKER_MEMORY_FLOOR` is an error that names `ram_limit_pct`.
- The thread budget is `cores x cpu_limit_pct / 100`; each managed `llama-server` gets `-t T -tb T`.
- `llm-ext models server-status` prints the governor figures (on or off, window, running, waiters each with its own limits, RAM and CPU against the limits with the reading age, threads in use of the budget, the last denial) and the threads of each server. A machine idling near the RAM limit blocks loads: raise `ram_limit_pct` or free memory.
- Not promised: other programs and servers you started yourself are never stopped or slowed (their threads, models and GPU use are outside the limits); a running inference runs to its end; `enabled: false` processes, a pre-governor llm-ext still running, and servers llm-ext never sends to are invisible; just-in-time model loads by LM Studio or Ollama get no load grant; Apple Silicon GPU memory is covered only through the RAM reading and discrete-GPU VRAM not at all; the Linux and Windows readings are unverified and a cgroup memory limit is not read; with full Metal offload the thread budget limits server concurrency more than CPU use; state is per user (`/tmp/llm-ext-governor-<uid>`).
- Also not promised: a first model download holds the one load grant until it ends (up to an hour); a model that must load alone waits until no inference runs; if two config dirs set different `ram_limit_pct` values, the 30 second unload rule (a model server is asked to unload after RAM stays over the limit for 30 seconds) may never fire for the stricter one; the model servers `models calibrate` starts are counted but never asked to unload; memory growth after a model server has finished loading is not watched, and a Locals server started with context size 0 gets no `--max-context`; a request sent straight to a server you started yourself counts as a running inference, but that server's memory is not counted and it is never asked to unload; a broker started by an older llm-ext version keeps running through an upgrade, and its model servers use llama.cpp's default thread count, which is not counted; if the shell running `models calibrate` sets another `ram_limit_pct` than the broker, a too-big model may be recorded differently by the two.
- On filesystems with coarse modification times (HFS+, FAT, some network filesystems), a same-size edit of `settings.yaml` made within about 2 seconds of the previous one may not reach a running broker until the next edit.
- Not promised: other programs and servers you started yourself are never stopped or slowed (their threads, models and GPU use are outside the limits); a running inference runs to its end; `enabled: false` processes, a pre-governor llm-ext still running, and servers llm-ext never sends to are invisible; just-in-time model loads by LM Studio or Ollama get no load grant; Apple Silicon GPU memory is covered only through the RAM reading and discrete-GPU VRAM not at all; the Linux and Windows readings are unverified and a cgroup memory limit is not read; with full Metal offload the thread budget limits server concurrency more than CPU use; state is per user (`/tmp/llm-ext-governor-<uid>`).

## Local decider fallback (`local_fallback`)

When the remote decision call fails, `llm-ext llm ping` and the classify decider can answer from the local mlx-decision server instead. llm-ext never starts mlx-decision: it adopts the one running server (the machine-wide singleton). A busy machine queues local decider requests instead of failing them: the governor wait line is printed every 60 s, and only `--command_timeout` bounds the wait. `enabled: false` turns the fallback off.

`settings.yaml` (the section is optional; absent keys keep their defaults; an unknown key, a removed key or a value out of range fails at once):

```yaml
local_fallback:
  enabled: true                    # false turns the fallback off
  url: http://127.0.0.1:8123       # loopback only, bare origin: no path, query or fragment
  startTimeoutMs: 300000           # 1000-900000, wait for the adopted server to finish loading its model
  attemptTimeoutMs: 200000         # 1000-600000, timeout of one attempt
  requestTimeoutMs: 400000         # 1000-600000, overall deadline; must be >= attemptTimeoutMs
  maxAttempts: 50                  # 1-100, POST attempts
```

- `enabled`: `true` by default; `false` makes the fallback silent and unused, and then a classify command on a remote classifier profile is refused (no remote-only classifier profile, see `local-decision` below).
- `url`: the first place looked at for the server; `http://127.0.0.1:<port>` or `http://localhost:<port>` only, with a real port, and no path, query or fragment (llm-ext appends `/v1/systemone` itself). Default `http://127.0.0.1:8123`, the port of the login agent. On macOS the running mlx-decision servers are also searched when this address does not answer.
- `startTimeoutMs`: how long to wait for the adopted server to load its model. Default 300000.
- `attemptTimeoutMs`: timeout of one decision attempt. Default 200000.
- `requestTimeoutMs`: overall deadline of the whole escalation; must be at least `attemptTimeoutMs`. Default 400000.
- `maxAttempts`: how many POST attempts at most. Default 50; lookups do not count.

### The local-only classifier profile `local-decision`

On a Mac with Apple silicon llm-ext adds, once and not active, the built-in classifier profile `local-decision`:

```yaml
profiles:
  local-decision:
    profile-type: classifier
    api: mlx-decision-local
    context_tokens: 16384          # the prompt limit the decider names in its own 422 reply
    max_requests_per_call: 64      # local requests run one at a time: this bounds the run time
```

- Select it with `--profile local-decision` or `active_classifier: local-decision`. Every classify command and `classify ping` then asks the running mlx-decision server (elephant-1) directly: no OpenRouter call, no API key, cost 0. `--estimate` says the call is local and free and sends nothing.
- `api: mlx-decision-local` takes no `model`, `api_key`, `endpoint` or `provider` (each is refused with its name). Without `context_tokens` it plans with 16384, without `max_requests_per_call` it allows 64 requests. A request still over the decider limit ends the run with the decider 422 text, exit 4, after one attempt (never retried). A decider that is not running fails the run with its reason, exit 5; nothing remote is tried.
- A remote classifier profile plans every request to fit the decider too (at most 16384 tokens), so a request the remote side fails can still be answered locally. An input that fitted one remote request between 16384 tokens and the remote limit now takes up to about twice as many remote requests.
- It reads `url`, the timeouts and `maxAttempts` of `local_fallback`, but not `enabled`: the profile is its own fallback.
- No remote-only classifier profile: a classify command (ping included) on a remote classifier profile while `local_fallback.enabled` is `false` is refused before anything is sent, with a message pointing to `local-decision`. Other llm-ext commands are not affected.

## Network give-up window (`network_give_up_seconds`, `--network_give_up`)

When this machine cannot reach the remote service at all (connection refused or reset, name lookup failing, network unreachable), llm-ext normally keeps retrying for up to 5 minutes. With a local profile ready to answer, it stops after this many seconds of consecutive network failures and ends the call with the network error. The window is armed only when ALL THREE hold: the failure is a network-level one (a slow model that hits its own timeout does not count), a strict probe of the provider (`GET <base>/v1/models`, redirects not followed; only a 200 answer carrying a JSON `data` array counts, so a captive portal does not) gets no genuine answer, and a local profile is ready now (`locals-mlx` where the machine can run it, else `local_llama`: engine binary on the PATH, head model on disk, calibration record ok; nothing is started, downloaded or calibrated to check). Otherwise nothing changes and the existing retries run. A network blip shorter than the window still heals, and any answer from the provider, whatever its status, ends the run of failures.

```yaml
network_give_up_seconds: 30        # top-level key, integer 1-299 (below the 300 s retry window, a larger value is an error); absent = 30
```

- The flag `--network_give_up <s>` (alias `--network-give-up`; `=` or a space; whole seconds) overrides the key for one command. A malformed key or flag value fails at once; it is never read as the default.
- A local active profile has no remote to give up on: the window is not set.

What happens after the give-up (automatic local fallback):

- On the built-in `free` and `paid` profiles the command finishes on the ready local profile instead of failing. The same switch happens, with no window involved, when a provider outage is confirmed (two or more models of one provider failing with 5xx, timeouts or network errors AND its reachability probe failing), when every model of `paid` answers a certain 402 (credit at zero), and when the API key is refused (401/403). A request-specific error (400, 413, a context overflow) and a dead model inside a healthy service never switch.
- Only the head model of the local profile is sent to, and its broker job never waits for a calibration: a missing or stale calibration record fails the local send instead.
- One stderr warning names the reason, the local profile and model, and the remote profile. Fixed texts: `credit exhausted on the paid profile: top up; answered locally` and `the API key was refused (401/403): fix it; answered locally`.
- The switch is final for that command: its later requests go straight to the local profile. The next command tries the remote service again.
- A request larger than the local input budget is refused for that file (the message names the bytes, the budget and the model), never truncated; the other files go on locally.
- If the local send itself fails, one stderr line says why and the remote error is reported exactly as before. With no local profile ready, nothing changes at all.
- A static profile you wrote yourself never switches: its call ends with the network error.

## Switching off or pinning the local fallback (`fallback_to_local`)

This top-level section controls the automatic local fallback described above. It is not the `local_fallback` section, which configures the mlx-decision decider.

```yaml
fallback_to_local:
  enabled: true          # default true; false switches the fallback off
  profile: local_llama   # optional; absent = automatic (locals-mlx where the machine can run it, else local_llama)
```

- `enabled: false`: no local profile is ever treated as ready. No command switches to a local profile, and the network give-up window is never armed, so the remote retries run exactly as they would with no local profile at all. The remote error is reported unchanged.
- `profile: <name>`: only this profile is considered. It must be a profile of settings.yaml with `server: managed` and `api: llamacpp-local` or `locals-local`, so a profile you defined yourself is accepted. If it is not ready (engine binary, head model, calibration record), there is no fallback; the automatic profiles are never tried instead. A `locals-local` profile is ready only on macOS with Apple silicon. `profile:` left empty (null) means automatic, like no key; an empty string `""` is an error.
- An unknown key, a non-boolean `enabled`, or a `profile` that is empty, not a string, names no profile of settings.yaml, or names one that is not a managed local profile fails every command at once, also when `enabled: false`. An error is never read as the default.
