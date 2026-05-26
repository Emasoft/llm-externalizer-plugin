---
name: llm-externalizer-mass-scout-list-bundled-fieldsets
description: |-
  List the plugin-shipped fieldsets that other mass-scout tools accept
  as `--fields-file bundled:<name>`. Skip the "what fields do I write?"
  cliff entirely when one of the standard sets fits your use case.
allowed-tools:
  - mcp__llm-externalizer__mass_scout_list_bundled_fieldsets
argument-hint: "[--json]"
effort: low
---

# Mass-scout — list bundled fieldsets

Enumerate the fieldsets shipped with the plugin. Each can be passed
straight into `mass_scout` (or `mass_scout_chain`) as
`--fields-file bundled:<name>` — no authoring required.

Current bundled sets cover: `code-audit` (bug-finding scout for source
files), `skill-audit` (Claude Code skill triage), `security-audit`
(security review fields), `pr-review` (pull-request triage). The exact
list is read at runtime; this command is the authoritative source —
do not assume the list from memory.

## Inputs

| Flag | Required | Description |
|---|---|---|
| `--json` | no | Return a JSON array of `{name, path, fields[]}` objects (one per bundled set), so a caller can pick the right one programmatically |

## Output

Default: a human-readable list — one bundled set per line with its name,
absolute path, and the field names it defines.

With `--json`: a top-level JSON array
`[{name, path, fields: [...]}, ...]` for programmatic dispatch (e.g. a
selector agent that picks a bundled set based on the user's goal).

## Example

```
/llm-externalizer:llm-externalizer-mass-scout-list-bundled-fieldsets
```

Prints every bundled fieldset with its field roster. Pick one whose
fields match what you want to extract, then run
`mass_scout --fields-file bundled:<name>` against your corpus.

## When NOT to use this

If your goal is unusual or domain-specific, the bundled sets will
under-cover the questions you actually want answered. Use
`mass_scout_propose_fieldset` (LLM-driven) or
`mass_scout_build_fieldset` (manual shorthand) to author a custom set
instead.
