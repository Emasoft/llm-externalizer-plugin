---
name: llm-externalizer-mass-scout-build-fieldset
description: |-
  Compose a JSON fieldset from --field shorthand tokens. Use this when
  you know the shape you want and prefer one-liner field definitions
  over hand-writing JSON.
allowed-tools:
  - Bash
argument-hint: "--name <id> --field \"name:type=desc\" [--field \"...\"] ... [--out <path>]"
effort: low
---

# Mass-scout — build fieldset

Generate a valid fieldset JSON from compact shorthand tokens, ready to
pass to `mass_scout` as `--fields-file`. Saves you hand-authoring the
JSON when you already know the field shapes you want.

Shorthand forms supported by the parser:

| Token | Meaning |
|---|---|
| `name:bool=desc` | boolean field |
| `name:string(120)=desc` | string with a `max_length` |
| `name:enum(a,b,c)=desc` | fixed-vocabulary enum |
| `name:array_string(8)=desc` | array of free-form strings (`max_items`) |
| `name:array_enum(a,b,c)(8)=desc` | array of enum values (`max_items`) |
| `name:int(1-10)=desc` | integer in a closed range |
| `name:number(0.0-1.0)=desc` | float in a closed range |

Prefer `array_enum` over `array_string` whenever you have a fixed tag
vocabulary — that way the model cannot drift off your allowed values.

## Inputs

| Flag | Required | Description |
|---|---|---|
| `--name <id>` | yes | Fieldset name (lowercase identifier) |
| `--field "..."` | yes | One or more shorthand tokens. Repeat the flag once per field |
| `--out <path>` | no | Write the JSON to this path instead of stdout |

## Output

A validated fieldset JSON object, either to stdout (default) or to the
file specified by `--out`. The shape matches what `mass_scout` accepts
via `--fields-file`, so you can pipe `build-fieldset` straight into a
scout run.

## Example

```
${CLAUDE_PLUGIN_ROOT}/bin/llm-ext mass-scout-build-fieldset \
  --name auth-audit \
  --field "is_login:bool=true if file authenticates a user" \
  --field "auth_method:enum(jwt,oauth2,session,basic,none)=mechanism in use" \
  --field "vulnerability_severity:enum(none,low,medium,high,critical)=worst observed" \
  --out /tmp/auth-audit.fields.json
```

Writes a 3-field fieldset to `/tmp/auth-audit.fields.json`. Feed it into
`mass_scout` as `--fields-file /tmp/auth-audit.fields.json`.

## Errors

- Bad shorthand syntax → exit 1 with the offending token and the
  expected form for that type.
- Duplicate field name within the same fieldset → exit 1 with a clear
  message listing the duplicate.
