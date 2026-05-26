---
name: llm-externalizer-mass-scout-propose-fieldset
description: |-
  Ask the LLM to propose a fieldset JSON for a natural-language goal,
  optionally seeded with sample files. Resolves the "what fields do I
  write?" UX cliff.
allowed-tools:
  - mcp__llm-externalizer__mass_scout_propose_fieldset
argument-hint: "--goal \"...\" [--samples a.ts,b.ts,...] [--model <id>] [--out <path>]"
effort: low
---

# Mass-scout — propose fieldset

Send a one-sentence goal (plus optional sample files) to the LLM and
get back a validated fieldset JSON. Use this when you know what you
want to extract from a corpus but don't yet know what fields to ask the
scout LLM to fill in for each file. The proposed fieldset can be tweaked
by hand or passed straight into `mass_scout`.

## Inputs

| Flag | Required | Description |
|---|---|---|
| `--goal "..."` | yes | One-sentence statement of what you want to find / extract |
| `--samples a.ts,b.ts,...` | no | Comma-separated paths to seed the LLM with real file content (~3-5 samples is usually enough) |
| `--model <id>` | no | Model id used to compose the fieldset. Default: qwen/qwen-2.5-7b-instruct (overridden to the active free model when `free_only` is set in `settings.yaml`) |
| `--out <path>` | no | Write the validated fieldset JSON to this path instead of stdout |

## Output

A validated fieldset JSON ready to pass to `mass_scout` as
`--fields-file`. Inspect it, prune fields you don't need, then run the
scout. The MCP tool only emits a fieldset that passes the same
validation the rest of the pipeline enforces, so you don't ship a
malformed schema.

## Example

```
/llm-externalizer:llm-externalizer-mass-scout-propose-fieldset \
  --goal "Audit every Express route handler for auth / input-validation gaps" \
  --samples src/routes/users.ts,src/routes/admin.ts,src/middleware/auth.ts \
  --out /tmp/route-audit.fields.json
```

Asks the LLM to compose a fieldset that captures the questions the goal
implies (auth presence, input-validation strategy, etc.), seeded with
three representative files. Output is written to
`/tmp/route-audit.fields.json` for the user to review before scouting.

## Cost note

This tool makes one LLM call (~1–4k input + ≤1k output). Under
`free_only` it uses the active free model; otherwise it bills via the
profile's primary model. For cost-free shape generation when you
already know the fields, use `mass_scout_build_fieldset` instead.

## Errors

- Empty / missing `--goal` → exit 1 with usage error.
- Sample file unreadable → exit 1 listing the path.
- LLM returned invalid JSON or a fieldset that fails validation → exit 1
  with the parser / validator diagnostic so the failure is debuggable.
