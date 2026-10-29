---
name: llm-externalizer-create-profile
description: Use when an agent needs its OWN llm-ext profile in settings.yaml, or when two agents are fighting over one profile's model. Trigger with "create a profile", "add an llm-ext profile", "which model should my agent use", "my llm-ext calls are refused", "IRON RULE not validated for".
argument-hint: "[profile-name]"
effort: low
---

# LLM Externalizer — creating your own profile

## THE ONE RULE

**Create your OWN profile. Never edit someone else's, and never edit the active
one unless it is yours.**

`~/.llm-externalizer/settings.yaml` is a **shared, machine-global file**. On this
machine 20+ agents use `llm-ext`. A profile block is the unit of ownership: yours
is yours, everyone else's is off limits. Scope every call with `--profile
<your-profile>` — note that the `active:` line names the current default profile
for any *unscoped* call, so changing it affects every other agent's unscoped
calls too; prefer `--profile` over touching it.

Measured 2026-08-29, and the reason this skill exists: two agents edited one
profile's `tool_models` twenty minutes apart, each with correct reasoning from its
own evidence, neither able to see the other's. Nothing errored. The config simply
ended up in a state neither would have chosen. **Two writers on one block is not a
merge conflict — it is a silent overwrite.**

Profiles do **not** inherit. A new profile starts empty, so copy in what you need
(`free_models`, `tool_models`). That is a feature: it is what makes your block
independent of everyone else's.

## Use it without touching `active:`

```bash
llm-ext <group> <action> <input> --profile <your-profile>
```

`--profile` selects your profile for one call, and takes precedence over the
shared `active:` line and the built-in `free` default. Omitting `--profile`
falls back to `active:` in settings.yaml, then to `free` if `active:` is also
absent — so on a shared machine, always pass `--profile <your-profile>`
rather than relying on whatever `active:` currently names.

## The schema (verified against `config.ts::Profile`, 2026-08-29)

```yaml
# active: <profile-name>        # top level — names the current default profile; note: affects every unscoped call, prefer --profile
allow_paid_models: false        # top level — DEFAULT false; absent means false
profiles:
  <your-profile-name>:
    mode: local | remote | remote-ensemble    # REQUIRED
    api: <preset>                             # REQUIRED — see presets below
    model: <model-id>                         # REQUIRED
    api_key: $OPENROUTER_API_KEY              # env-var ref, or a literal
    # -- optional --
    url: <override the preset's URL>
    api_token: $VAR                           # local servers
    second_model: <id>                        # remote-ensemble only
    third_model: <id>                         # remote-ensemble only
    free_only: true|false                     # use ONLY free_models
    free_models: ["<id>:free", ...]           # every entry MUST end ':free'
    tool_models: { <tool>: <model-id>, ... }  # per-command overrides
    high_quality_model: { ... }               # high_quality_scan only
    timeout: <seconds>
    context_window: <tokens, 0 = auto>
    app_name: <string>                        # OpenRouter dashboard label
    http_referer: <string>
    providers: [{api: <preset>, models: [<id>, ...], api_key: $VAR, url: <override>}]
      # extra providers this profile may send to, keyed by model id — e.g. a
      # chat-b-ai-remote binding lets one profile mix OpenRouter + b.ai models.
      # A binding's non-`:free` model is billable unless its resolved URL host
      # equals the preset's default host (an overridden `url:` makes it billable).
```

**`api` presets** (`llm-ext settings status` prints the live list):
`lmstudio-local`, `ollama-local`, `vllm-local`, `llamacpp-local`, `generic-local`,
`openrouter-remote`, `chat-b-ai-remote`, `locals-local`.

**Managed local servers.** On a local profile, `server: managed` (api `llamacpp-local` or `locals-local` only) makes llm-ext start and stop the model server itself, one model at a time. Only then may a profile also set `second_model` and `third_model`. The built-in profiles `local_llama` (GGUF, llama.cpp) and `locals-mlx` (MLX, Locals; macOS on Apple silicon) already do this: copy one instead of writing it from scratch. A model of a managed profile is calibrated once, automatically, on its first use or when a model id changes in a profile that has been used (or by hand with `llm-ext models calibrate --model <id>`), and its requests are held until the record is complete (see `llm-ext models calibration-status`).

**Validation is enforced, not advisory.** An unknown `api` preset, a `tool_models`
key that is not a registered tool, or a `free_models` entry missing the `:free`
suffix all reject the profile. The last one is a cost-safety chokepoint: a
free-only profile can never bill.

## THE PART THAT WILL BITE YOU: the IRON RULE

A **paid** model may only be sent by a command it has **provably passed a
benchmark for** (`benchmark/validated.ts`). Not "meets the requirements" —
*passed*. It refuses **before** the HTTP call, so a wrong pin costs $0 but the
command simply does not work.

- `:free` models are **exempt**. This is the fast path.
- A missing or corrupt ledger means **refuse**, never "assume pass".
- `llm-ext models assess --model <id>` is free and offline. It reports
  requirements for all 15 commands and marks which need their own benchmark.
  **"Meets requirements 15/15" does NOT mean usable** — that was a real
  2026-08-29 incident: a model qualified 15/15, was pinned to all 15 commands,
  and all 15 refused, because it had never passed a benchmark.

So the reliable choices are:

1. **A `:free` model** — works immediately, no benchmark needed. Best default.
2. **A paid model with a passing ledger row** — check before pinning:
   `uv run scripts/llm_ext_profile.py validated`
3. **A paid model you benchmark yourself** — real money, 10–40 min. Run it as a
   background task; the Bash tool's 500 s ceiling kills it otherwise and you pay
   for a run that writes no ledger.

## Recipes

**A free profile (recommended starting point — $0, no benchmark gate):**

```yaml
  my-agent:
    mode: remote
    api: openrouter-remote
    model: nvidia/nemotron-3-super-120b-a12b:free
    api_key: $OPENROUTER_API_KEY
```

**A free-only ensemble with a rotation pool:**

```yaml
  my-agent-pool:
    mode: remote
    api: openrouter-remote
    model: nvidia/nemotron-3-super-120b-a12b:free
    api_key: $OPENROUTER_API_KEY
    free_only: true
    free_models:
      - nvidia/nemotron-3-super-120b-a12b:free
      - google/gemma-4-31b-it:free
      - minimax/minimax-m3:free
```

**One command on a different model** (the case that caused tonight's collision —
solve it in YOUR profile, not by editing someone else's `tool_models`):

```yaml
  my-agent:
    mode: remote
    api: openrouter-remote
    model: deepseek/deepseek-v4-flash
    api_key: $OPENROUTER_API_KEY
    tool_models:
      code_task: nvidia/nemotron-3-super-120b-a12b:free
```

## Best practices

- **Name it after yourself**, not after the model: `ghbook`, `my-agent`. A
  model-named profile becomes a lie the first time you swap models — tonight
  `remote-single-glm53flash` had to be renamed when its model changed.
- **`mode: remote-ensemble` bills every model on EVERY call.** With paid
  `model` + `second_model` + `third_model` that is 3x per call. Use
  `mode: remote` unless you specifically want the ensemble.
- **Copy `free_models` into your profile.** Profiles do not inherit, and a 402
  falls back only within *your* profile's own pool — never to another
  profile. A STATIC profile (any name other than the built-in
  `free`/`paid`/`local`) with no `free_models` and no more models to fall back
  to **exits non-zero** instead of borrowing a bundled seed — pin your own
  `free_models`, or use `--profile free` for the always-on built-in pool.
- **`tool_models` pins beat a command's own default.** Without a pin some
  commands fall back to their own `DEFAULT_MODEL`, which may be a *different*
  paid model that is itself unvalidated.
- **Comment WHY a model was chosen**, with the evidence. A bare id tells the next
  agent nothing about whether it may change it.
- **Never point two profiles at one another's blocks.** Duplication is correct
  here; shared state is not.

## Scripts

`scripts/llm_ext_profile.py` (in this plugin):

```bash
uv run scripts/llm_ext_profile.py list        # every profile + its models, ownership at a glance
uv run scripts/llm_ext_profile.py validated   # paid models with a PASSING ledger row, per tool
uv run scripts/llm_ext_profile.py check <name>  # lint one profile against the schema + IRON RULE
```

`validated` is the one to run **before** pinning a paid model — it applies the
same pass predicates `validated.ts` uses, against the real ledgers.

## Do NOT

- Edit a profile you did not create.
- Change the shared `active:` line to fix your own problem — note it is the
  default for every unscoped call, so a change there affects other agents too;
  use `--profile` instead.
- Hand-edit with `sed`/a script. Read the file, then edit it visibly; a scripted
  rewrite that silently matches nothing is how a config breaks quietly.
- Pin a paid model without checking its ledger first. It will refuse at $0, and
  the failure surfaces days later, out of context, to someone who has no idea a
  config changed.
