# TRDD-65867b68-e795-4fbc-8548-639648679708 — Local-backend expansion + setup-agent benchmarking

**TRDD ID:** `65867b68-e795-4fbc-8548-639648679708`
**Filename:** `design/tasks/TRDD-65867b68-e795-4fbc-8548-639648679708-local-backend-expansion.md`
**Tracked in:** this repo (design/tasks/ is git-tracked)

**Status:** Phase 1 in progress.

**Origin:** User request (2026-05-15): expand the plugin's local-backend
support and make the setup wizard smarter. Verbatim asks:

1. Clear the pending audit task #26 (v9.10.0 remainder).
2. Add the missing test coverage backlog.
3. Improve the setup agent further: make it run **benchmarks and
   reliability tests on all candidate models** and **decide which models
   to suggest to the user** as viable local alternatives.
4. Better support for **autoconfiguring CUDA on low-VRAM GPUs using vLLM**.
5. Better **MLX** support.
6. Add a proper **install/setup/configure skill for vllm-metal**.
7. Add an **install/setup/configure skill for vMLX**
   (https://github.com/jjang-ai/vmlx) — modelled on the vllm-metal skill.
   "vllm-metal is only the beginning."

## Research notes

### vllm-metal (`vllm-project/vllm-metal`)
- Community vLLM hardware plugin; runs vLLM on Apple Silicon via MLX.
- One-line installer → venv at `~/.venv-vllm-metal`; `vllm serve <model>`
  exposes the OpenAI-compatible API on `:8000`.
- Config purely via `VLLM_METAL_*` env vars (memory fraction, paged
  attention, MLX device, prefix cache, etc.).
- Text-only models, Apple-Silicon-only, community-maintained.

### vMLX (`jjang-ai/vmlx`)
- MLX inference server for Apple Silicon. PyPI package `vmlx`.
- `uv tool install vmlx` / `pipx install vmlx` / venv.
- `vmlx serve <model>` → OpenAI + Anthropic + Ollama compatible API on
  `:8000`. Works with any `mlx-community/*` model.
- Built-in CLI: `vmlx doctor` (diagnostics), `vmlx bench` (perf
  benchmarks), `vmlx info` (metadata), `vmlx convert` (quantization incl.
  JANG adaptive). **`vmlx bench` + `vmlx doctor` directly serve ask #3.**
- Rich serve options: continuous batching, prefix cache, paged cache,
  KV-cache quantization, disk cache, JIT, speculative decoding, PLD,
  distributed pipeline parallelism.
- Apple-Silicon-only (M1/M2/M3/M4), Python 3.10+.

## Phases

### Phase 1 — backend setup skills (THIS commit)

- `skills/vllm-metal-setup/SKILL.md` — install / setup / configure
  vllm-metal; wire to the `vllm-local` preset.
- `skills/vmlx-setup/SKILL.md` — install / setup / configure vMLX;
  wire to the `vllm-local` / `generic-local` preset; surface
  `vmlx doctor` + `vmlx bench`.
- Both user-invocable (so the setup agent can invoke them on demand AND
  a user can run them directly — matches the [[setup-agent-rich-toolkit]]
  principle: wider pool, agent picks freely).

### Phase 2 — wire skills into the setup agent

- Setup agent Step 3a / install table: reference the two new skills
  instead of carrying inline install snippets.
- Add an Apple-Silicon backend-choice sub-step: LM Studio (default) vs
  Ollama vs vllm-metal vs vMLX, with the trade-offs.
- Do NOT bloat the 5-skill frontmatter preload ([[skill-preload-preserved]]):
  the new skills are invoked on demand.

### Phase 3 — benchmark + reliability + candidate selection (ask #3)

- New `scripts/setup/benchmark-models.py` — for each candidate model:
  run a short reliability suite (the 5 existing compatibility tests:
  smoke, structured output, code understanding, long context, output
  length) PLUS a throughput/latency benchmark (tokens/s, TTFT). When the
  active runner is vMLX, delegate the perf numbers to `vmlx bench`.
- Aggregate into a ranked candidate table; the setup agent presents the
  top viable models with measured (not advertised) numbers.
- Decision rule: a model is a "viable local alternative" only if it
  passes hard requirements #1 + #2 and meets a tokens/s floor for the
  user's machine.

### Phase 4 — CUDA low-VRAM autoconfig (ask #4)

- New `scripts/setup/vllm-cuda-autoconfig.py` — for Linux + NVIDIA:
  detect VRAM, then emit a tuned `vllm serve` command line
  (`--gpu-memory-utilization`, `--max-model-len`, `--quantization`,
  `--kv-cache-dtype fp8`, `--enforce-eager` / `--cpu-offload-gb` for
  low-VRAM cards, `--swap-space`).
- Setup-agent Step 3a Linux+NVIDIA branch consults it.

### Phase 5 — broader MLX support (ask #5)

- Extend `huggingface-mlx-models` skill + recommender so MLX artifacts
  (mlx_lm.server, vMLX, LM Studio MLX runtime) are first-class on
  Apple Silicon, with quant-budget guidance.

### Phase 6 — test backlog (ask #2)

- mcp-server: tests for `safe-body.ts` (safeReadText / safeReadJson cap
  behaviour), the v9.10.0 filter-warning path, statusline helpers.
- `scripts/codex/run-codex-scan.py` unit tests (rate-limit detection,
  bin packing, prompt assembly, finding count).
- Diagnostics scripts smoke tests.
- Decide runner: vitest for TS, a Python test harness for the scripts.

### Phase 7 — audit remainder (task #26 / TRDD-480419e5)

- MCP MAJORs T2.7 (watchFile race), T2.18 (gitLsFilesMultiRepo),
  `Server` → `McpServer` SDK migration, statusline T2.22-T2.26,
  README continuation. Tracked in TRDD-480419e5; this TRDD just
  cross-references it.

## Acceptance criteria

- Phase 1: both skills validate (`claude plugin validate .`), describe a
  complete install → serve → verify → wire-to-preset flow, and correctly
  state Apple-Silicon-only + community-maintained caveats.
- Later phases: each has its own acceptance bar; do not mark this TRDD
  Done until Phases 2-7 are complete or explicitly descoped.

## Notes

- vMLX and vllm-metal both expose OpenAI-compatible APIs on `:8000`, so
  no new settings.yaml preset is required — the `vllm-local` preset
  (default `http://localhost:8000`) fits both. `generic-local` is the
  explicit fallback.
- Structured output (`response_format: json_schema`, hard requirement
  #2) is NOT assumed for either backend — the setup agent's Step 5
  compatibility test must verify it empirically, as it already does for
  every backend.
- Per the cross-project rule, vllm-metal and vMLX are third-party repos:
  we read them for reference only and never edit them.
