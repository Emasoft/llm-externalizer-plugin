# Runtime-Specific Launch Recipes

## Table of Contents

- [Default workflow (runtime-agnostic)](#default-workflow-runtime-agnostic)
- [Runtime 1 — `mlx_lm.server` (official, Python-native)](#runtime-1--mlx_lmserver-official-python-native)
- [Runtime 2 — vMLX (`vmlx serve`, MLX-native, built-in doctor/bench)](#runtime-2--vmlx-vmlx-serve-mlx-native-built-in-doctorbench)
- [Runtime 3 — LM Studio MLX runtime (GUI / `lms` CLI)](#runtime-3--lm-studio-mlx-runtime-gui--lms-cli)
- [Listing & comparing MLX models](#listing--comparing-mlx-models)
- [Converting a non-MLX HF repo to MLX](#converting-a-non-mlx-hf-repo-to-mlx)
- [Common gotchas](#common-gotchas)
- [Examples](#examples)

## Default workflow (runtime-agnostic)

1. **Gate on Apple Silicon.** `[[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]]` must be true. If not, redirect to `huggingface-local-models` (llama.cpp Metal works on arm64 + x86_64).
2. **Pick the runtime** from the three-runtime table. The setup wizard's environment detector reports which are already installed.
3. **Find an MLX model.** Search `mlx-community/` on HF. Examples:
   - `mlx-community/Qwen2.5-Coder-7B-Instruct-4bit`
   - `mlx-community/Llama-3.2-3B-Instruct-4bit`
   - `mlx-community/Meta-Llama-3.1-8B-Instruct-4bit`
   - `mlx-community/Qwen3-8B-4bit`
4. **Pick a quantization** from the budget table. Smallest compatible quant is usually best default for scan workloads.
5. **Download** via the `hf` CLI:
   ```bash
   hf download mlx-community/<repo-name> --local-dir ~/models/<short-name>
   ```
   MLX repos are usually directories of safetensors shards — omit per-file argument. LM Studio MLX runtime can download via GUI instead.
6. **Run** with per-runtime recipe below.
7. **Wire** into `~/.llm-externalizer/settings.yaml` using matching preset.

## Runtime 1 — `mlx_lm.server` (official, Python-native)

```bash
uv tool install mlx-lm
hf download mlx-community/Qwen2.5-Coder-7B-Instruct-4bit \
    --local-dir ~/models/qwen2.5-coder-7b-mlx
mlx_lm.server --model ~/models/qwen2.5-coder-7b-mlx \
    --port 8082 --host 127.0.0.1
```

The server exposes `http://127.0.0.1:8082/v1/chat/completions` and `/v1/models`. Port 8082 avoids the default-8080 collision with `llama-server`. Use `generic-local` preset:

```yaml
profiles:
  mlx-qwen2.5-coder-7b:
    mode: local
    api: generic-local
    url: "http://127.0.0.1:8082/v1"
    model: "qwen2.5-coder-7b-mlx"     # match basename mlx_lm reports at /v1/models
    timeout: 600
    context_window: 32768
```

Then run `llm-ext reset` to purge caches and reload settings (no server to restart).

## Runtime 2 — vMLX (`vmlx serve`, MLX-native, built-in doctor/bench)

For install + tuned-serve flags + `vmlx doctor`/`vmlx bench` reliability+perf checks, invoke `Skill(skill: "vmlx-setup")`. Once `vmlx serve <model-id> --port 8000` is running (optionally `--continuous-batching --enable-prefix-cache --enable-pld --kv-cache-quantization q8` for scan workloads), wire with `vllm-local` preset:

```yaml
profiles:
  vmlx-local:
    mode: local
    api: vllm-local
    model: "mlx-community/Qwen3-8B-4bit"    # same id you passed to `vmlx serve`
    # url defaults to http://localhost:8000 — override only on a custom port
    # api_token: $LM_API_TOKEN              # only if you started vmlx with --api-key
```

For the **vLLM-on-Apple-Silicon** path (vLLM core + community MLX plugin), use `Skill(skill: "vllm-metal-setup")` instead — also lands on `vllm-local` at `:8000`.

## Runtime 3 — LM Studio MLX runtime (GUI / `lms` CLI)

LM Studio ships its own MLX runtime alongside its llama.cpp runtime. Enable once per machine in **Settings → Runtimes**, then either:

- **GUI path:** in model browser, filter to MLX format, click Download. Open Local Server, select model, **Start Server**. Default port 1234.
- **Headless `lms` CLI** (LM Studio must be launched once to bootstrap CLI):
  ```bash
  lms server start                              # starts the local server on :1234
  lms get mlx-community/Qwen3-8B-4bit           # downloads if missing
  lms load mlx-community/Qwen3-8B-4bit          # loads model into server
  lms ls --json                                 # list loaded models (id used by API)
  lms log stream                                # tail server logs
  ```

Use `lmstudio-local` preset:

```yaml
profiles:
  lmstudio-mlx:
    mode: local
    api: lmstudio-local
    url: "http://localhost:1234"          # the preset's default — included for clarity
    model: "<id-from-lms-ls>"             # exact id reported by `lms ls --json`
    api_token: $LM_API_TOKEN              # only if LM Studio's API key is set
    timeout: 600
    context_window: 32768
```

LM Studio MLX is recommended for users who don't want to touch a terminal — model swap is one click, GUI shows unified-memory usage live.

## Listing & comparing MLX models

The companion `huggingface-best` skill can find the highest-scoring model that fits, using HF benchmark leaderboards. For MLX-specific discovery:

```bash
# Browse the mlx-community namespace
hf api GET '/api/models?author=mlx-community&limit=50'

# Get file list of a specific repo
hf api GET '/api/models/mlx-community/Qwen2.5-Coder-7B-Instruct-4bit/tree/main?recursive=true'
```

`scripts/setup/recommend-models.py` already filters whatcani.run's featured artifacts by runtime — on Apple Silicon it surfaces `mlx_lm` entries first.

## Converting a non-MLX HF repo to MLX

```bash
mlx_lm.convert --hf-path <original-hf-repo> \
    --mlx-path ~/models/<short-name>-q4 \
    --quantize --q-bits 4
```

The output directory is usable by all three runtimes. vMLX also ships `vmlx convert` (similar flags, JANG quant support) — see `Skill(skill: "vmlx-setup")`.

## Common gotchas

1. **Intel Macs**: MLX requires Apple Silicon. On Intel, `mlx-lm` installs but fails at runtime, and vMLX/LM Studio MLX refuse to start. Redirect to `huggingface-local-models`.
2. **Unified memory pressure**: Loading a 27B 4bit on a 32 GB Mac with Chrome+IDE+Claude Code open will swap. Close apps, lower `--max-model-len`/`context_window`, or pick a smaller quant.
3. **Repos with only BF16 weights**: see "Converting a non-MLX HF repo to MLX" above.
4. **Tokenizer not registered**: `mlx_lm` fails at load with `tokenizer not registered`. Pick a different repo (older/more popular family) or `uv tool upgrade mlx-lm`. vMLX and LM Studio MLX share `mlx-lm` core.
5. **Model name in settings.yaml**: each runtime's `/v1/models` reports a different id — `mlx_lm.server` uses directory basename, vMLX uses full HF repo id, LM Studio uses whatever `lms ls --json` reports. Match exactly.
6. **Port collisions**: 8082 here for `mlx_lm.server`, 8000 for vMLX, 1234 for LM Studio — keep distinct.
7. **Memory limit on 8 GB Macs**: an 8 GB Apple Silicon Mac with OS+Chrome+Claude Code already consumes ~5-6 GB. Only smallest 4bit ≤3B models leave margin. Recommend `remote-ensemble` instead.
8. **Structured output**: all three runtimes claim OpenAI compatibility but per-model honoring of `response_format: json_schema` must be verified empirically via wizard Step 5.

## Examples

**Example 1 — M2 Pro 32 GB, vMLX runtime, 13B Q4:**

```bash
hf download mlx-community/Qwen3.6-32B-Instruct-4bit --local-dir ~/models/qwen3.6-32b-4bit
vmlx serve ~/models/qwen3.6-32b-4bit --port 8000
```

Settings.yaml fragment: `mode: local`, `api: vllm-local`, `model: "mlx-community/Qwen3.6-32B-Instruct-4bit"`, `url: http://localhost:8000`.

**Example 2 — M3 Max 64 GB, mlx_lm.server, 70B 4bit:**

```bash
hf download mlx-community/Llama-3.3-70B-Instruct-4bit --local-dir ~/models/l3-70b-4bit
mlx_lm.server --model ~/models/l3-70b-4bit --host 127.0.0.1 --port 8082
```
