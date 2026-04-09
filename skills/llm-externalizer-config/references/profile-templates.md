# LLM Externalizer — Profile Templates

## Table of Contents

- [Local LM Studio](#local-lm-studio)
- [Local Ollama](#local-ollama)
- [Local vLLM](#local-vllm)
- [Local llama.cpp](#local-llamacpp)
- [Local generic](#local-generic-custom-url)
- [Remote single model (OpenRouter)](#remote-single-model-openrouter)
- [Remote single model (Claude)](#remote-single-model-claude)
- [Remote ensemble](#remote-ensemble-two-models-in-parallel)
- [Complete settings.yaml example](#complete-settingsyaml-example)

Ready-to-use YAML profile blocks. Copy into `~/.llm-externalizer/settings.yaml` under `profiles:`.

## Local LM Studio

```yaml
  local-lmstudio:
    mode: local
    api: lmstudio-local
    model: "thecluster/qwen3.5-27b-mlx"
```

Auth auto-detected from `$LM_API_TOKEN` if set.

## Local Ollama

```yaml
  local-ollama:
    mode: local
    api: ollama-local
    model: "qwen3:14b"
```

No auth needed.

## Local vLLM

```yaml
  local-vllm:
    mode: local
    api: vllm-local
    model: "Qwen/Qwen2.5-72B-Instruct"
```

Auth from `$VLLM_API_KEY` if set.

## Local llama.cpp

```yaml
  local-llamacpp:
    mode: local
    api: llamacpp-local
    model: "default"
```

No auth needed.

## Local generic (custom URL)

```yaml
  local-custom:
    mode: local
    api: generic-local
    model: "my-model"
    url: "http://my-server:8080"
```

`url` is required for generic-local. Auth from `$LM_API_TOKEN` if set.

## Remote single model (OpenRouter)

```yaml
  remote-gemini:
    mode: remote
    api: openrouter-remote
    model: "google/gemini-2.5-flash"
    api_key: $OPENROUTER_API_KEY
```

## Remote single model (Claude)

```yaml
  remote-claude:
    mode: remote
    api: openrouter-remote
    model: "anthropic/claude-sonnet-4"
    api_key: $OPENROUTER_API_KEY
```

## Remote ensemble (three models in parallel)

```yaml
  remote-ensemble:
    mode: remote-ensemble
    api: openrouter-remote
    model: "google/gemini-2.5-flash"
    second_model: "x-ai/grok-4.1-fast"
    third_model: "qwen/qwen3.6-plus"
    api_key: $OPENROUTER_API_KEY
```

## Complete settings.yaml example

```yaml
active: remote-ensemble

profiles:
  local-lmstudio:
    mode: local
    api: lmstudio-local
    model: "thecluster/qwen3.5-27b-mlx"

  local-ollama:
    mode: local
    api: ollama-local
    model: "qwen3:14b"

  remote-gemini:
    mode: remote
    api: openrouter-remote
    model: "google/gemini-2.5-flash"
    api_key: $OPENROUTER_API_KEY

  remote-ensemble:
    mode: remote-ensemble
    api: openrouter-remote
    model: "google/gemini-2.5-flash"
    second_model: "x-ai/grok-4.1-fast"
    api_key: $OPENROUTER_API_KEY
```
