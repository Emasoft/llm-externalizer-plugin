# or_model_info — Example Output

## Table of Contents
- [Sample response](#sample-response)
- [Reading the output](#reading-the-output)
- [Comparing multiple endpoints](#comparing-multiple-endpoints)

## Sample response

Calling the tool with `{ "model": "nvidia/nemotron-3-super-120b-a12b:free" }` returns
markdown like this:

```markdown
# NVIDIA: Nemotron 3 Super (free)
**id**: `nvidia/nemotron-3-super-120b-a12b:free`
**architecture**: in: text · out: text · tokenizer: Other
**description**: NVIDIA Nemotron 3 Super is a 120B-parameter open hybrid MoE model,
activating just 12B parameters for maximum compute efficiency and accuracy in complex
multi-agent applications. Built on a hybrid Mamba-Transformer architecture…

## Endpoints (1)

### Nvidia
- **context_length**: 262,144 tokens
- **max_completion_tokens**: 262,144
- **quantization**: unknown
- **pricing**: prompt free, completion free
- **supported_parameters** (10): include_reasoning, max_tokens, reasoning, response_format, seed, structured_outputs, temperature, tool_choice, tools, top_p
- **uptime**: 97.1% (30m) · 97.6% (1d)
- **latency** (30m): p50 12166ms · p75 26795ms · p90 52621ms · p99 106950ms
- **throughput** (30m): p50 15 tok/s · p75 23 tok/s · p90 31 tok/s · p99 49 tok/s
```

## Reading the output

- **supported_parameters**: the canonical list of request-body fields this model's
  endpoints will accept. Anything not in this list is silently dropped by OpenRouter.
  For this model the important omissions are `frequency_penalty`, `presence_penalty`,
  `top_k`, `min_p`, `stop`, and `repetition_penalty` — sending those has no effect.

- **pricing**: shown in dollars per million tokens. `free` means the prompt and
  completion cost $0 but prompts are logged by the provider. Free-tier models are
  not suitable for sensitive or proprietary code.

- **latency percentiles**: p50 is the median time to get a response. p99 is the worst
  1% of calls. For Nemotron :free the p99 is > 100 seconds, so set generous timeouts.

- **throughput percentiles**: output tokens per second. Useful for estimating total
  time for a large response: at p50 of 15 tok/s, a 5000-token response takes ~330s.

- **uptime**: rolling 30-minute and 24-hour availability. Below 95% means the provider
  is struggling — consider switching to a different model or waiting.

## Comparing multiple endpoints

For models hosted by multiple providers (e.g. `meta-llama/llama-3.3-70b-instruct`),
the `## Endpoints` section shows one block per provider. Compare `pricing`, `latency`,
`uptime`, and `quantization` across them to pick the best one for your use case.
