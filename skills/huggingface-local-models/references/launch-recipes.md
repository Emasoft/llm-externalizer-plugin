# llama.cpp Launch Recipes & Setup

## Table of Contents

- [Install llama.cpp](#install-llamacpp)
- [Authenticate for gated repos](#authenticate-for-gated-repos)
- [Search the Hub](#search-the-hub)
- [Run directly from the Hub](#run-directly-from-the-hub)
- [Run an exact GGUF file](#run-an-exact-gguf-file)
- [Convert only when no GGUF is available](#convert-only-when-no-gguf-is-available)
- [Smoke test a local server](#smoke-test-a-local-server)
- [Quant Choice](#quant-choice)
- [Failure modes](#failure-modes)

## Install llama.cpp

```bash
brew install llama.cpp
winget install llama.cpp
```

From source:

```bash
git clone https://github.com/ggml-org/llama.cpp
cd llama.cpp
make
```

## Authenticate for gated repos

```bash
hf auth login
```

## Search the Hub

```text
https://huggingface.co/models?apps=llama.cpp&sort=trending
https://huggingface.co/models?search=Qwen3.6&apps=llama.cpp&sort=trending
https://huggingface.co/models?search=<term>&apps=llama.cpp&num_parameters=min:0,max:24B&sort=trending
```

## Run directly from the Hub

```bash
llama-cli -hf unsloth/Qwen3.6-35B-A3B-GGUF:UD-Q4_K_M
llama-server -hf unsloth/Qwen3.6-35B-A3B-GGUF:UD-Q4_K_M
```

## Run an exact GGUF file

```bash
llama-server \
    --hf-repo unsloth/Qwen3.6-35B-A3B-GGUF \
    --hf-file Qwen3.6-35B-A3B-UD-Q4_K_M.gguf \
    -c 4096
```

## Convert only when no GGUF is available

```bash
hf download <repo-without-gguf> --local-dir ./model-src
python convert_hf_to_gguf.py ./model-src \
    --outfile model-f16.gguf \
    --outtype f16
llama-quantize model-f16.gguf model-q4_k_m.gguf Q4_K_M
```

## Smoke test a local server

```bash
llama-server -hf unsloth/Qwen3.6-35B-A3B-GGUF:UD-Q4_K_M
```

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer no-key" \
  -d '{
    "messages": [
      {"role": "user", "content": "Write a limerick about exception handling"}
    ]
  }'
```

## Quant Choice

- Prefer the exact quant that HF marks as compatible on the `?local-app=llama.cpp` page.
- Keep repo-native labels such as `UD-Q4_K_M` instead of normalizing them.
- Default to `Q4_K_M` unless the repo page or hardware profile suggests otherwise.
- Prefer `Q5_K_M` or `Q6_K` for code or technical workloads when memory allows.
- Consider `Q3_K_M`, `Q4_K_S`, or repo-specific `IQ` / `UD-*` variants for tighter RAM or VRAM budgets.
- Treat `mmproj-*.gguf` files as projector weights, not the main checkpoint.

## Failure modes

- **Custom file naming in repo**: use `--hf-repo` + `--hf-file` form to bypass the default `repo:QUANT` shortcut.
- **No GGUF artifact exists**: convert from Transformers weights via `convert_hf_to_gguf.py`, then quantize with `llama-quantize`.
- **Gated repo (Llama, Gemma)**: run `hf auth login` first; the token must be tied to a license-accepted account.
- **Smoke-test fails**: re-check the launch flags (`-c` for context size, `-ngl` for Metal offload, etc.) — see [hardware](hardware.md).
