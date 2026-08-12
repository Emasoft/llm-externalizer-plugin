---
name: llm-externalizer-mass-scout-diff
description: |-
  Compare two scout jobs row-by-row and report which fingerprints are
  only in one, only in the other, identical, or have changed fields.
  Confirms that a re-scout actually changed what you expected.
allowed-tools:
  - Bash
argument-hint: "--db-path <path> --from-job <id> --to-job <id> [--json]"
effort: low
---

# Mass-scout — diff

Compute a structural diff between two completed mass-scout jobs in the
same DB. Each file fingerprint is bucketed as `only_from` / `only_to` /
`identical` / `changed`; for the `changed` bucket, the tool also lists
which `result_json` keys differ.

Use after a fieldset tweak, a model swap, or a partial re-register to
confirm the new job actually moved the data you expected — and didn't
silently regress other rows.

## Inputs

| Flag | Required | Description |
|---|---|---|
| `--db-path <path>` | yes | Absolute path to the SQLite registry holding both jobs |
| `--from-job <id>` | yes | Baseline `job_id` |
| `--to-job <id>` | yes | Comparison `job_id` (must differ from `--from-job`) |
| `--json` | no | Return a structured JSON envelope instead of human-readable summary |

## Output

Default: a markdown summary with four sections (only-in-from, only-in-to,
identical, changed) and a per-changed-row list of differing `result_json`
keys. Fast to read.

With `--json`: a top-level object
`{ from_job, to_job, only_from: [...], only_to: [...], identical: [...], changed: [{ fingerprint, changed_keys: [...] }, ...] }`
for downstream programmatic comparison.

## Example

```
${CLAUDE_PLUGIN_ROOT}/bin/llm-ext mass-scout-diff --db-path /tmp/scout.db --from-job baseline --to-job after-fieldset-tweak
```

Reports which files appeared/disappeared between `baseline` and the
new job, and — for files present in both — which fields the model
extracted differently. A small `changed` list means the tweak was
targeted; a large one means the new fieldset moved many rows and is
worth a manual audit (combine with `mass_scout_audit_sample`).

## Errors

- `--from-job` and `--to-job` are the same → exit 1 with a usage error.
- Either job missing from the DB → exit 1 listing the unknown job_id.
