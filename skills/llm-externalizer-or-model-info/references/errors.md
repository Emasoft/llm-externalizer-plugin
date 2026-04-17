# or_model_info — Error Handling

## Table of Contents
- [Error table](#error-table)
- [Debugging tips](#debugging-tips)

## Error table

| Error message | Cause | Resolution |
|-|-|-|
| `only works with OpenRouter backends. Active profile is '<name>' (<mode>)` | Active profile is local (LM Studio / Ollama / vLLM / llama.cpp) | Switch to a remote profile. Use `/llm-externalizer:llm-externalizer-configure` or manually edit `~/.llm-externalizer/settings.yaml` and change the `active:` field to an OpenRouter-backed profile. |
| `OpenRouter returned 404 for model '<id>'` | Model id is wrong (typo, missing vendor prefix, wrong suffix, case mismatch) | Double-check the exact id. OpenRouter ids are case-sensitive and include the vendor prefix. Common mistakes: `nemotron` instead of `nvidia/nemotron-3-super-120b-a12b:free`, `claude-sonnet` instead of `anthropic/claude-sonnet-4`. |
| `OpenRouter returned 401` | `$OPENROUTER_API_KEY` missing or invalid | Check that the env var is set in the MCP server's process environment. Run `/llm-externalizer:llm-externalizer-discover` to see the auth status. |
| `OpenRouter returned 429` | Rate limited | Wait a few seconds and retry. Free-tier keys have strict per-minute limits. |
| `No endpoints found for model '<id>'` | Model id is valid but has no active endpoints (deprecated, all providers offline) | Suggest an alternative model to the user, or check the OpenRouter status page. |
| `could not reach OpenRouter: <err>` | Network issue, DNS failure, firewall, MCP server offline | Retry once. If still failing, run `/llm-externalizer:llm-externalizer-discover` to verify service connectivity. |

## Debugging tips

- If you're unsure whether the id is correct, search OpenRouter's model catalog at
  <https://openrouter.ai/models> — every model page URL contains the exact id.
- The `:free` tier of a model is often a SEPARATE id from the paid tier. For example
  `nvidia/nemotron-3-super-120b-a12b:free` and `nvidia/nemotron-3-super-120b-a12b` are
  two different entries with different supported_parameters and pricing.
- Some models expose `:thinking` variants (e.g. `anthropic/claude-3.7-sonnet:thinking`)
  that enable reasoning by default and may have different supported_parameters.
