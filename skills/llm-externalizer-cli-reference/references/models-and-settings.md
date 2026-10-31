# llm-ext reference: models and settings groups

Flags are written `--name value`; booleans take `true`/`false`. Every action also accepts the global flags (`--quiet`, `--profile <name>`, `--command_timeout <s>`, `--queue_timeout <s>`; see SKILL.md). All text below comes from `llm-ext <group> <action> --help`.

## Contents

- `llm-ext models info`
- `llm-ext models assess`
- `llm-ext models health`
- `llm-ext models discover`
- `llm-ext models replacements`
- `llm-ext models calibrate`
- `llm-ext models calibration-status`
- `llm-ext models server-status` lists the registered managed local servers; `llm-ext models server-stop [--engine llama|locals] [--role main|cal|all]` stops them (only registered ones; the broker starts a new main server only when work arrives)
- `llm-ext settings show`
- `llm-ext settings profile`
- `llm-ext settings profiles`
- `llm-ext settings reset`
- `llm-ext settings status`
- `llm-ext settings scan-local`

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
| `--output_dir` | string | Report dir; defaults to <main-root>/reports/llm-externalizer/auto-replace/. |
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

| Profile | Engine | Models (`model`, `second_model`, `third_model`) |
|---|---|---|
| `local_llama` | GGUF models through llama.cpp's `llama-server` (api `llamacpp-local`) | `AtomicChat/LFM3-1.7B-Uncensored-GGUF:AD-Q6_K`, `bartowski/Nanbeige_Nanbeige4.2-3B-GGUF/Nanbeige_Nanbeige4.2-3B-Q6_K.gguf`, `insraq/Qwen3.5-4B-EmperoAI-Qwen3.8-Distill-Heretic-Abliterated-MTP-GGUF/Qwen3.5-4B-EmperoAI-Qwen3.8-Distill-Heretic-Abliterated-MTP-GGUF-Q8_0.gguf` |
| `locals-mlx` | MLX models through the Locals server (api `locals-local`; macOS on Apple silicon only) | `LiquidAI/LFM3-1.7B-MLX-4bit`, `mlx-community/Nanbeige4.2-3B-OptiQ-4bit`, `mlx-community/Qwen3.5-4B-MLX-4bit` |

Both use `server: managed`: llm-ext starts and stops the model server itself. You do not run it. `local_llama` needs a llama.cpp build with LFM3 support.

- **Request broker.** A local broker serves all managed profiles. It runs one local model server at a time, whatever the engine (the broker never runs a llama-server and a Locals server together). The calibration runner is a separate process: it may run its own short-lived calibration server beside that one, for the model being calibrated, and pauses while the broker has work for another model. It groups the queued requests by model and rotates to the next model when the current one has had its minimum slice and another model's request is nearing `--queue_timeout`. If a model fails, the command falls back to the next model of the same profile.
- **Calibration.** A model of a managed profile is calibrated once, automatically: on its first use, or when a model id changes in a profile that has been used (a profile nobody used is never calibrated on its own). Requests for it are held until its record is complete, which can take hours. Held requests are bounded only by `--command_timeout`. Check progress with `llm-ext models calibration-status`. Start or redo it by hand with `llm-ext models calibrate --model <id> [--force]`; `--force` is required when a record already exists.
- Calibration pauses while the broker has work for another model and waits a bounded time for free memory; if memory stays short, the model gets a `memory-limited` record.
