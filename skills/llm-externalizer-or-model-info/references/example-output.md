# or_model_info — Example Output

## Table of Contents
- [Sample response](#sample-response)
- [Reading the output](#reading-the-output)
- [Percentiles explained](#percentiles-explained)
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

## Percentiles explained

Percentile values (p50, p75, p90, p99) describe the *distribution* of latency and
throughput across many real requests to the provider in the last 30 minutes.

- **p50** — the **median**. Half of all requests finished *faster* than this, the
  other half *slower*. This is the "typical" case. If p50 latency is 2,000 ms, a
  normal request takes ~2 seconds.
- **p75** — the 75th percentile. 3 out of 4 requests finished faster than this.
  1 in 4 requests is slower. Useful for budget planning.
- **p90** — the 90th percentile. 9 out of 10 requests finished faster. 1 in 10 is
  slower. The "uncommonly bad" case — users will hit this often enough to notice.
- **p99** — the 99th percentile. The **worst 1%** of requests. This is the
  tail-latency number — what your unluckiest users see. If p99 is 100 seconds,
  roughly 1 request in 100 will take that long or more.

Example from Nemotron :free:
- `p50 12000ms · p75 27000ms · p90 53000ms · p99 107000ms`
- Most calls (p50) take ~12 s.
- A quarter of calls (p75) take more than 27 s.
- 10% of calls take more than 53 s.
- 1% of calls take **more than 107 seconds** — you must set generous timeouts to
  avoid dropping these.

Percentiles are the right way to measure latency because averages hide tail
behaviour: a single 100-second outlier can drag the mean up dramatically, but the
p50 tells you what the typical user experiences.

**Throughput percentiles** work the same way but higher is better (more tokens
per second). p50 throughput of 15 tok/s means half the time you'll generate
faster than 15 tok/s, half the time slower. p99 of 50 tok/s means the best 1%
of runs hit that speed.

## Comparing multiple endpoints

For models hosted by multiple providers (e.g. `meta-llama/llama-3.3-70b-instruct`),
the `## Endpoints` section shows one block per provider. Compare `pricing`, `latency`,
`uptime`, and `quantization` across them to pick the best one for your use case.
