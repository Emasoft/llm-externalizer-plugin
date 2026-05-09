# Mass-scouting glossary

## Table of Contents

- [Terms](#terms)
- [Model selection guide](#model-selection-guide)
- [Privacy](#privacy)

## Terms

- **fieldset** — JSON description of what to extract per file (fields[] with
  name + description + type).
- **JSON Schema (compiled)** — what fieldset.ts emits at compile time; what
  the LLM is forced to obey via `response_format: json_schema`.
- **bucket** — the preclassifier's category for a file (sourcecode,
  rules_to_eval, documentation, config, log, binary, unknown). Used to scope
  `scout`/`estimate` with `--bucket`.
- **short_id** — sequential integer assigned at register time. Stable per-DB,
  much cheaper than fingerprints to print/reference.
- **fingerprint** — SHA-256 of the file body. Identity for the body cache (so
  re-registering the same content is a no-op).
- **sentinel bucket** — `chain:<jobId>` label set during a chain run on
  matching rows; restored after the run completes (success or error).
- **smoke test** — first 5 files run sequentially before the worker pool fans
  out. Aborts early if the fieldset is broken.
- **circuit breaker** — fan-out aborts after N consecutive per-file failures
  (default 5). Prevents a broken model+schema combination from burning the
  whole budget.
- **regex bypass** — `search` heuristic that runs deterministic regex over
  cached bodies for queries like "all emails", "urls in domain X", "all
  ipv4". No LLM call, no cost.

## Model selection guide

Default: `qwen/qwen-2.5-7b-instruct` (cheapest with adequate JSON-schema
adherence).

| Goal | Model | Why |
|---|---|---|
| Cheapest per-file (1k+ files) | `qwen/qwen-2.5-7b-instruct` | $0.04/M in, ~95% schema adherence |
| Better short-text accuracy | `google/gemini-2.5-flash` | 2-3× more reliable on short bodies, still cheap |
| Reasoning-heavy fieldsets | `anthropic/claude-haiku-4-5` | Best small-model reasoning; ~10× more expensive |
| Free-tier (slow) | `nvidia/nemotron-3-super-120b-a12b:free` | $0; rate-limited; logged by provider |

## Privacy

- File bodies are sent to the configured provider — usually OpenRouter,
  which proxies to a third-party model host. **Do not scout files containing
  secrets, PII, or unreleased proprietary code unless your legal/compliance
  setup permits.** The `:free` tier explicitly logs prompts.
- The SQLite registry holds the cached bodies on YOUR disk under the user's
  project — that part stays local.
- Reports under `reports/mass_scouting/` may contain excerpts of scouted
  bodies. `reports/` and `reports_dev/` MUST be in `.gitignore`.
