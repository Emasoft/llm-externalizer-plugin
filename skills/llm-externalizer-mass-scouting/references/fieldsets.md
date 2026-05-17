# Fieldsets — types, bundled sets, authoring

## Table of Contents

- [Fieldset format](#fieldset-format)
- [Bundled fieldsets](#bundled-fieldsets)
- [Build-fieldset shorthand](#build-fieldset-shorthand)
- [Propose-fieldset](#propose-fieldset)

## Fieldset format

A fieldset is a JSON file describing what the LLM should extract per file.
Each field has `name`, `description`, and a `type`:

```json
{
  "version": 1,
  "fieldset_name": "ts-code-audit",
  "fields": [
    { "name": "is_async",
      "description": "true if the file declares async / await",
      "type": { "kind": "bool" } },
    { "name": "frameworks",
      "description": "JS/TS frameworks the file uses",
      "type": { "kind": "array_string", "max_items": 8 } },
    { "name": "complexity_1_to_10",
      "description": "subjective complexity 1..10",
      "type": { "kind": "int", "min": 1, "max": 10 } }
  ]
}
```

Supported `kind`s: `bool`, `string` (with `max_length`), `enum` (with
`values`), `array_string` (with `max_items`), `array_enum` (with `values` +
`max_items`, dedup'd), `array_object` (with `item_fields` + `exact_items` OR
`min_items`/`max_items`, **positional, no dedup** — use this when each item
is a typed record), `int` (`min` / `max`), `number` (`min` / `max`).

## Bundled fieldsets

Pass `--fields-file bundled:<name>` to use a plugin-shipped fieldset:

| Name | What it captures |
|---|---|
| `bundled:code-audit` | summary, language, has_tests, complexity, issues[], external_deps[] |
| `bundled:skill-audit` | skill_name, has_frontmatter, description_quality, trigger_count, has_examples, issues[] |
| `bundled:security-audit` | has_secrets, uses_eval, input_validation, severity, vulnerabilities[], cwe_categories[] |
| `bundled:pr-review` | summary, category, needs_review, breaks_api, test_coverage, risks[] |

Run `mass-scout list-bundled-fieldsets --json` (or
`mass_scout_list_bundled_fieldsets`) to get the field-by-field breakdown
without opening the JSON.

## Build-fieldset shorthand

For ad-hoc fieldsets, use the shorthand parser via `build-fieldset`:

```bash
llm-externalizer mass-scout build-fieldset --name code-audit \
  --field 'summary:string(200)=One-sentence summary of this file.' \
  --field 'has_tests:bool=True if file contains test cases.' \
  --field 'complexity:enum(low,medium,high)=Estimated code complexity.' \
  --field 'issues:array_string(5)=Up to 5 quality issues.' \
  --out /tmp/code-audit.json
```

Shorthand syntax (`NAME:TYPE=DESCRIPTION`):
- `name:bool=desc` — boolean
- `name:string(120)=desc` — string with max_length
- `name:enum(a,b,c)=desc` — enum with values
- `name:array_string(8)=desc` — array of strings, max 8 items
- `name:array_enum(a,b,c)=desc` — array of enum values
- `name:array_enum(a,b,c)(8)=desc` — array of enum values, max 8 items
- `name:int(1-10)=desc` — int with min..max
- `name:number(0.0-1.0)=desc` — float with min..max

Prefer `array_enum` over `array_string` for a fixed tag vocabulary (OS
names, hardware tags, severity labels): `array_string` lets the model emit
any string so values drift off your intended set, while `array_enum`
constrains them to the listed values.

For `array_object`, write the JSON by hand or use `propose-fieldset`.

## Propose-fieldset

If you don't know what fields to capture, ask the LLM to propose them:

```bash
llm-externalizer mass-scout propose-fieldset \
  --goal "find every Python module that talks to a database" \
  --samples /path/sample1.py,/path/sample2.py \
  --out /tmp/proposed.json
```

The output is a validated fieldset JSON — you can use it as-is or edit it.
