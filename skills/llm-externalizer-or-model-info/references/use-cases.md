# or_model_info — Use Cases

## Table of Contents
- [1. Verify supported parameters](#1-verify-supported-parameters-before-integrating-a-model)
- [2. Compare pricing across providers](#2-compare-pricing-across-providers-hosting-the-same-model)
- [3. Debug slow or failing calls](#3-debug-slow-or-failing-calls)
- [4. Check quantization](#4-check-quantization-for-quality-trade-offs)
- [5. Confirm context length and max tokens](#5-confirm-context-length-and-max-tokens)
- [6. Check reasoning support](#6-check-reasoning-support)

## 1. Verify supported parameters before integrating a model

```json
{ "tool": "or_model_info", "model": "anthropic/claude-sonnet-4.5" }
```

Check the `supported_parameters` list for the fields you need. The `:free` tier of a
model often has a reduced set — for example `nvidia/nemotron-3-super-120b-a12b:free`
does NOT support `frequency_penalty`, `presence_penalty`, `top_k`, `min_p`, `stop`,
or `repetition_penalty`, while the paid `nvidia/nemotron-3-super-120b-a12b` does
support all of them.

## 2. Compare pricing across providers hosting the same model

```json
{ "tool": "or_model_info", "model": "meta-llama/llama-3.3-70b-instruct" }
```

The output has one section per endpoint (provider), each with its own `pricing`,
`quantization`, `latency`, and `uptime`. Pick the cheapest that meets your quality
and latency requirements.

## 3. Debug slow or failing calls

```json
{ "tool": "or_model_info", "model": "<the-model-you're-calling>" }
```

Look at `uptime_last_30m`. Below 95% means the provider is struggling — the
empty-response or timeout failures you're seeing may be upstream, not in your code.
Check the `latency_last_30m` p99 to set realistic per-request timeouts.

## 4. Check quantization for quality trade-offs

```json
{ "tool": "or_model_info", "model": "meta-llama/llama-3.3-70b-instruct" }
```

Quantization levels (`fp16`, `int8`, `int4`, `unknown`) indicate the precision each
endpoint runs the model at. Lower quantization = faster + cheaper but lower quality
output. Compare across endpoints if you care about fidelity.

## 5. Confirm context length and max tokens

```json
{ "tool": "or_model_info", "model": "google/gemini-2.5-flash" }
```

Each endpoint reports `context_length`, `max_completion_tokens`, and `max_prompt_tokens`.
Use these to estimate whether a large input/output will fit and to set the right
`max_tokens` budget in your requests.

## 6. Check reasoning support

```json
{ "tool": "or_model_info", "model": "<any-model-id>" }
```

Look for `reasoning` in `supported_parameters`. If present, the model accepts the
`reasoning.effort` field via OpenRouter's chat/completions endpoint. If absent,
sending reasoning is a no-op — the field will be silently dropped. The `:thinking`
variant of a model (e.g. `anthropic/claude-3.7-sonnet:thinking`) typically has
reasoning enabled by default.
