# Configuration Guide

## Table of Contents

- [Modes](#modes)
- [API Presets](#api-presets)
- [Profile Fields](#profile-fields)
- [Auth Resolution](#auth-resolution)
- [Manual Edit Workflow](#manual-edit-workflow)
- [Validation Rules](#validation-rules)
- [Ensemble Mode](#ensemble-mode)
- [Environment Variables](#environment-variables)
- [Troubleshooting](#troubleshooting)

## Modes

| Mode | Behavior |
|------|----------|
| `local` | Sequential requests to a local server |
| `remote` | Parallel requests, single model via OpenRouter |
| `remote-ensemble` | Parallel requests, three models in parallel, combined report |

## API Presets

Each profile uses an `api` preset that bundles protocol + default connection settings.

### Local presets (mode: local)

| Preset | Protocol | Default URL | Auth |
|--------|----------|-------------|------|
| `lmstudio-local` | LM Studio native API | `http://localhost:1234` | `$LM_API_TOKEN` |
| `ollama-local` | OpenAI-compatible | `http://localhost:11434` | (none) |
| `vllm-local` | OpenAI-compatible | `http://localhost:8000` | `$VLLM_API_KEY` |
| `llamacpp-local` | OpenAI-compatible | `http://localhost:8080` | (none) |
| `generic-local` | OpenAI-compatible | (url required) | `$LM_API_TOKEN` |

### Remote presets (mode: remote / remote-ensemble)

| Preset | Protocol | Default URL | Auth |
|--------|----------|-------------|------|
| `openrouter-remote` | OpenRouter API | `https://openrouter.ai/api` | `$OPENROUTER_API_KEY` |
| `chat-b-ai-remote` | OpenAI-compatible | `https://api.b.ai` | `$BAI_API_KEY` |

## Profile Fields

| Field | Required | Description |
|-------|----------|-------------|
| `mode` | Yes | `local`, `remote`, or `remote-ensemble` |
| `api` | Yes | API preset name from the presets table |
| `model` | Yes | Model identifier (e.g. `thecluster/qwen3.5-27b-mlx`) |
| `url` | No | Override preset default URL |
| `api_key` | No | API key for remote presets (env var ref or direct value) |
| `api_token` | No | Auth token for local presets (env var ref or direct value) |
| `second_model` | Required for `remote-ensemble`; optional in every mode on a STATIC profile (manual fallback list) | Second model identifier |
| `third_model` | Only for `remote-ensemble` on a DYNAMIC profile; optional in every mode on a STATIC profile | Third model identifier |
| `timeout` | No | Request timeout in seconds |
| `context_window` | No | Context window override (0 = auto-detect) |
| `tool_models` | No | Per-tool model map — run each LLM tool on a different model (keys are LLM-tool names, e.g. `security_scan`). Absent ⇒ the profile's `model` is used for every tool. |
| `providers` | No | Extra providers this profile may send to — a list of `{api, models, api_key?, url?}` bindings. Each listed model goes to ITS provider's endpoint with ITS key; every other model uses the profile-level `api`. |

### `providers` — more than one provider in one profile

`api` names the profile's PRIMARY provider. `providers` adds others, and binds
each one to the exact model ids it serves:

```yaml
bai-and-openrouter:
  mode: remote
  api: openrouter-remote          # primary: everything not listed below
  api_key: $OPENROUTER_API_KEY
  model: deepseek/deepseek-v4-flash:free
  free_only: true
  free_models:
    - deepseek/deepseek-v4-flash:free
  providers:
    - api: chat-b-ai-remote
      api_key: $BAI_API_KEY       # this provider's own account
      models: [glm-5.3-flash]
  tool_models:
    code_task: glm-5.3-flash      # intended target — read the limitation below
```

`glm-5.3-flash` is sent to `https://api.b.ai` with `$BAI_API_KEY`; everything
else goes to OpenRouter with `$OPENROUTER_API_KEY`. Each provider uses its own
key — the profile-level `api_key` belongs to the primary and is never sent to a
binding's endpoint.

`free_models` is the pool the *free rotation* draws from and every entry there
must end in `:free`, so a b.ai model cannot live in it. Under
`mode: remote-ensemble` the ensemble fans out over `free_models` only, so a
binding's model does not take an ensemble slot.

**Known limitation — a binding's model is not reliably selected yet.** The
transport half is built and tested: a request carrying `glm-5.3-flash` goes to
`https://api.b.ai` with `$BAI_API_KEY`, and the primary's key is never sent
there. What is not yet enforced is that a request *carries* it — model
**selection** runs upstream of routing, and the free-pool reconcile, price-0
auto-discovery, and the 402 fallback (which stays within the selected
profile's own pool) can each substitute a different model, including ids from
neither this profile nor any binding. A
measured run with `tool_models: {code_task: glm-5.3-flash}` was served by an
auto-discovered OpenRouter model instead. Until selection honours the profile,
read `providers:` as the transport half of the feature.

`chat-b-ai-remote` is a free provider, so its models are allowed under
`free_only` even though they carry no `:free` suffix — that suffix is an
OpenRouter naming convention, not a property of the model. Setting `url:` on a
binding to a different **host or scheme** voids that exemption (plain `http://`
to the provider's own host voids it too — a bearer token in cleartext is not the
free path being claimed), and the models then have to earn it the normal way.

A binding that omits `api_key` does **not** inherit the profile's key — it falls
back to its own preset's default env var (`$BAI_API_KEY` for `chat-b-ai-remote`).

Local presets work as bindings too, so one profile can mix remote and local:
`- {api: ollama-local, url: "http://localhost:11434", models: ["qwen3:14b"]}`.
Quote any model id containing a colon inside a flow-style `[...]` list.

## Auth Resolution

Auth fields accept either:
- **`$ENV_VAR_NAME`** — resolved from process environment at runtime
- **`"direct-value"`** — used as-is

Default env vars are set by the API preset. If `discover` shows the token is resolved, auth is working. If it shows `(NOT SET)`, the env var is missing from the shell/process environment `llm-ext` runs in — check the plugin keychain or your exported env vars.

## Manual Edit Workflow

**Model & profile configuration is user-only.** There is no command that writes `settings.yaml` — the only supported path is:

**Step 1** — Open `~/.llm-externalizer/settings.yaml` in your editor. You can also run `"$CLAUDE_PLUGIN_ROOT/bin/llm-ext" get-settings` first — it copies the file to the output directory and returns the copy's path, but you are expected to transfer your edits back to the real file yourself.

**Step 2** — Edit the YAML. The structure:

```yaml
# active: <profile-name>   # the default profile when --profile is omitted;
                            # a fresh install writes `active: free`

profiles:
  my-profile-name:
    mode: local                # REQUIRED: local | remote | remote-ensemble
    api: lmstudio-local        # REQUIRED: preset name
    model: "model-name-or-id"  # REQUIRED: model identifier
    # OPTIONAL fields:
    # url: "http://localhost:1234"
    # api_token: $LM_API_TOKEN
    # api_key: $OPENROUTER_API_KEY
    # second_model: "model-id"         # required for remote-ensemble
    # third_model: "model-id"          # optional for remote-ensemble
    # timeout: 300
    # context_window: 100000           # 0 = auto-detect
    # tool_models:                     # optional per-tool model map
    #   security_scan: "qwen/qwen-2.5-7b-instruct"
```

**Step 3** — Save the file.

**Step 4** — Reload. Either restart Claude Code, or run `"$CLAUDE_PLUGIN_ROOT/bin/llm-ext" reset` to reload without restarting.

**Step 5** — Verify with `discover`.

**CRITICAL**: The file on disk IS the source of truth. Every profile you want to keep must appear in the file — a missing profile is a deleted profile after reload.

## Validation Rules

Validation runs at load time — on any `llm-ext` command, and again after `reset`. If validation fails, the error is written to stderr and the affected profile becomes unusable. Rules:

- `mode` must be `local`, `remote`, or `remote-ensemble`
- `api` must be a valid preset name
- `local` mode requires a `-local` preset; `remote`/`remote-ensemble` requires `openrouter-remote` or `chat-b-ai-remote`
- `remote-ensemble` requires `second_model`
- a DYNAMIC profile (`free`/`paid`) refuses `second_model` outside `remote-ensemble` and
  `third_model` anywhere but `remote-ensemble`; a STATIC profile has neither restriction — both
  are allowed in every mode as a manual fallback list
- Remote presets require a resolvable `api_key`
- `providers` must be a list; each binding needs a known `api` preset and a
  non-empty `models` **list** (a bare string is rejected — it would otherwise be
  dropped silently and the provider would simply never be used)
- a model id may appear in only ONE binding (routing is keyed by model id, so a
  second binding for the same id could never receive it — two accounts of one
  provider serving the same model needs per-binding names, which do not exist
  yet — put each account in its own profile)
- a remote binding needs its own resolvable `api_key`; a local one needs none
- `lmstudio-local` cannot be a binding (its native API is only reachable as the
  profile-level `api`); use `generic-local` with an explicit `url` instead
- `generic-local` requires an explicit `url`, as a binding and as `api`

To recover: edit the file to fix the issue, save, and run `"$CLAUDE_PLUGIN_ROOT/bin/llm-ext" reset` (or restart Claude Code).

## Ensemble Mode

On OpenRouter with `remote-ensemble` mode, read-only content tools run on three models in parallel. The current default ensemble is `google/gemini-2.5-flash`, `x-ai/grok-4.1-fast`, and `qwen/qwen3.6-plus`. Results are combined in one report with per-model sections.

- Per-model file size limits: grok skipped >20,000 lines, qwen skipped >40,000 lines, gemini skipped >50,000 lines
- On local backends, ensemble is a no-op (single model only)

## Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENROUTER_API_KEY` | OpenRouter API key (default for openrouter-remote preset) |
| `BAI_API_KEY` | chat.b.ai API key (default for chat-b-ai-remote preset) |
| `LM_API_TOKEN` | LM Studio / generic-local auth token |
| `VLLM_API_KEY` | vLLM auth token |
| `LLM_EXT_CONFIG_DIR` | Override settings directory (default: `~/.llm-externalizer`); also relocates the benchmark markdown reports under `<cfg>/reports/benchmark/`, alongside the JSON sidecar, lock, ledger, state and backups that already live there |
| `LLM_EXT_OUTPUT_DIR` | Override output directory (default: `<main-project-dir>/reports/llm-externalizer/`, anchored on `$CLAUDE_PROJECT_DIR` verbatim — never git) |
| `LLM_EXT_INSTALL_RULE` | Set to `0` to opt out of the auto-install of the `use-llm-externalizer` rule into `~/.claude/rules/` |
| `LLM_EXT_CATALOG_TTL_MS` | How long the OpenRouter catalog snapshot is trusted before the `free`/`paid` maintainer re-checks it (default `600000` = 10 min) |
| `LLM_EXT_DISABLE_AUTO_RECONCILE` | Set to `1` to turn off ALL dynamic maintenance of the `free`/`paid` profiles (no availability/price re-checks, no background benchmarking) |

`free`, `paid`, and `local` are three built-in DYNAMIC profiles (see `docs/setup-and-configuration.md`) —
llm-ext owns their `settings.yaml` sections and keeps them working on its own; every other profile name is
STATIC and is used exactly as written.

### Static profiles: all manual, no benchmarks or updates (14.1.0)

A STATIC profile's `model` / `second_model` / `third_model` / `free_models` / `paid_models` /
`tool_models` are a hand-authored fallback sequence, tried in the order you wrote them — llm-ext
never benchmarks, ranks, filters, or rewrites them, and the background model-reconcile pass never
touches the file (it only prints a once-per-window warning if a listed id falls out of the
OpenRouter catalog). This is also why `second_model`/`third_model` are allowed in **every** mode
on a static profile, not just `remote-ensemble` — `mode: remote`/`mode: local` walk them as a
fallback list for single-model commands, the same list `remote-ensemble` fans out for an ensemble.
(A DYNAMIC profile keeps the old restriction: its own `second_model`/`third_model` are
machine-written specifically for `remote-ensemble`, so setting them by hand in another mode is
still refused.)

Because every model in a static profile is something YOU chose, it is exempt from the two gates
that exist to protect an AUTO-PICKED id: the benchmark-verdict "IRON RULE" (a paid OpenRouter
model may only be sent by a tool it has proven it passes) and the price-ceiling check. A static
`free_only` profile's cost safety is NOT part of that exemption, though — a listed model still
must carry the `:free` suffix (or route to a non-billable provider), so a static profile can never
accidentally bill you.

### What an AUTO-PICKED model must prove before llm-ext will use it (14.1.0)

Every id llm-ext picked on its own — the dynamic `free`/`paid` profiles' own ranked pools, and any
reserved-ensemble slot substitute — must clear two independent gates before it is ever sent, and
each fails CLOSED, never open, when the evidence is missing:

- **A recorded benchmark PASS, not merely "not proven to fail."** A catalog id that has never
  been benchmarked at all is not auto-adopted into a served `free_models` pool, and it never
  enters live rotation or an ensemble slot, even while it still waits in the background
  benchmark queue. Only a model with an actual passing verdict on record is eligible. This
  applies on a profile's very FIRST population too (14.1.0/D3c-1b): an unpopulated `free`/`paid`
  profile never writes a catalog id into its served pool with no recorded pass — every candidate
  is queued for its first benchmark and the profile is refused ("retry later — the profile update
  is underway") until at least one clears it. The one exception is a reserved manual slot (a
  static profile's own listed models, or the b.ai free-provider slot in a dynamic `free`
  profile) — those are exempt from the benchmark requirement by provenance, not by having passed
  anything; see the reserved-slot ranking gap noted just below.
- **A price check under the ceiling, at send time.** For a paid auto-picked model, both the input
  AND output price (USD / million tokens) must be at or under
  `profiles.paid.selection.price_ceiling_usd_per_million` (default `1.3`), read from llm-ext's
  own on-disk catalog cache — not just once when the model was first admitted to the pool (a
  provider can raise its price in between), but a real disk read against data that can itself be
  up to several minutes stale (the periodic background catalog refresh, not a live fetch on every
  request), so a price hike is caught with that same delay, not instantly. If llm-ext has no
  recorded price for the model at all, the send is refused rather than risking an unbounded bill;
  running any command once, so llm-ext can populate its catalog cache, is what clears this.

Both checks are independent of, and run in addition to, the free_only `:free`-suffix cost-safety
check, which applies to every model regardless of provenance.

The b.ai free-provider slot (`glm-5.3-flash` on a machine with `BAI_API_KEY` set) is exempt from
the benchmark-pass requirement above, same as any other manually-listed model. Since 14.1.0 (D5)
that exemption rides the real reserved-slot mechanism: the `bai-reserved-seed` migration seeds
`ensemble.reserved: [{provider: bai, model: glm-5.3-flash}]` (plus the `bai` provider group) into
the dynamic `free` profile once per machine, and reserved slots are read ONLY by the ensemble
commands' fan-out — they never serve the single-model free chain. Reserved slots (at most 2) are
mandatory ensemble members, exempt from the benchmark requirement and from unusable-substitution
by provenance; the remaining ensemble seats come from the profile's ranking. A b.ai-only machine
(that is, one with `BAI_API_KEY` but no `OPENROUTER_API_KEY`) therefore has no single-model free
service — the `free_models` pool stays empty and commands refuse with the export-a-key message
until an OpenRouter key is set; the b.ai slot still serves ensemble commands.

### The ownership boundary inside a dynamic profile (14.1.0)

Inside `free`/`paid`/`local`, llm-ext rewrites only its own GENERATED keys (`mode`, `api`, `model`,
`free_models`, `tool_models`, etc.) on every update — it never touches a USER-OWNED subsection you add
yourself. As of 14.1.0 every dynamic profile's USER-OWNED set includes `selection` (the auto-pick
constraints) and `high_quality_model`; `paid` additionally owns `providers` (nothing generates a provider
binding on `paid` today, so it is yours to hand-edit there — `free` and `local` still generate their own
`providers` binding and refuse a hand-written one). Your edits to an owned key survive every regeneration
byte for byte, comments included. Any other key inside a dynamic profile is refused rather than silently
dropped — rename your own hand-picked profile instead of using `free`/`paid`/`local` if you want to choose
every model yourself.

The `paid` profile's auto-pick price ceiling (USD per million tokens, input AND output each `<=` this)
now lives at `profiles.paid.selection.price_ceiling_usd_per_million`, not the old top-level
`ensemble_price_ceiling_usd_per_million` key. On first boot after upgrading, llm-ext moves the value there
for you and deletes the old key; if it finds BOTH keys set to different values it leaves the file alone and
refuses every command until you delete the top-level key by hand.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `discover` shows `(NOT SET)` for auth token | Env var missing from the process environment `llm-ext` runs in | Export the env var in your shell (or set it in the plugin keychain), then re-run |
| Connection refused to local server | LM Studio / Ollama not running | Start the local server, verify URL and port |
| Validation error on reload | Invalid profile config | Check validation rules above; ensure mode/api preset match |
| Ensemble returns only one model's results | File exceeds size limit for one model | Normal behavior — grok limit is 20K lines, qwen 40K lines, gemini 50K lines |
| Tools return "not configured" | `--profile <name>` names a profile missing from settings.yaml, or settings.yaml itself is missing | Open `~/.llm-externalizer/settings.yaml`, confirm the profile exists under `profiles:` (or drop `--profile` to use the built-in `free` profile), save, run `"$CLAUDE_PLUGIN_ROOT/bin/llm-ext" reset` |
| No command exists to write `settings.yaml` | Expected — model & profile config is user-only | Edit `~/.llm-externalizer/settings.yaml` manually instead |
