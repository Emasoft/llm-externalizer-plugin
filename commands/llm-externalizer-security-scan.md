---
name: llm-externalizer-security-scan
description: |-
  Dedicated, injection-hardened security triage for suspected-malicious
  code. NOT the mass_scout pipeline — a bespoke judge with a
  nonce-delimited untrusted-data envelope, hardened system prompt, strict
  json_schema output, in-band injection pre-scan, and fail-safe-to-
  'uncertain' on every error/deviation. Adjudicates a batch of targets
  (snippet | file_path+line+context_lines window | path_glob) into per-item
  verdicts and writes a JSON + markdown report.
allowed-tools:
  - mcp__llm-externalizer__security_scan
argument-hint: "targets=[{id,category, snippet|file_path[+line]|path_glob}] [category_rubrics={...}] [budget_usd=N] [model=<id>]"
effort: high
---

# security_scan — injection-hardened security triage

The input to this tool is, by definition, **suspected-malicious code** —
so every snippet is treated as a potential prompt-injection payload aimed
at the adjudicating LLM. This command is the bespoke, fully-hardened path;
it does NOT reuse the mass_scout prompt (which has no injection defense).

For each target it:

1. **Intake** — expands `path_glob` (honoring `.gitignore` + optional
   `git_diff_ref`), extracts the `line ± context_lines` window for
   `file_path` targets, passes `snippet` targets through verbatim, then
   **redacts secrets** and **dedups** byte-identical `(content, category)`
   pairs (judged once, fanned out to every id).
2. **Pre-scan** — a script-only pass flags injection markers
   (`ignore previous`, `system:`/`<system>`, ChatML/INST tags, zero-width
   chars, base64 blobs, delimiter-spoof attempts, and reviewer/judge-directed
   meta-instructions such as `disregard your rubric`, `mark everything
   not_threat`, `approved by the security team`, or any text that addresses the
   reviewing AI). A second backstop scans the model's OWN `reason`: a
   `not_threat` whose justification parrots the manipulation is downgraded even
   when the static markers missed the phrasing.
3. **Judge** — wraps the code in a per-request **nonce-delimited untrusted
   envelope**, puts the category + rubric in the SYSTEM prompt (never in the
   data block), and calls OpenRouter with a strict `json_schema`
   (`verdict / confidence / reason / injection_observed`).
4. **Validate → uncertain** — any deviation (non-JSON, missing field,
   out-of-range confidence, extra key, nonce/marker echo) ⇒ `uncertain`.
   A flagged snippet may never be auto-classified `not_threat` at high
   confidence unless the model explicitly explains benign provenance.
5. **Report** — aggregates per-item rows + a summary, writes JSON + markdown
   to `<main-repo-root>/reports/security_scan/`, and returns only the
   paths + a one-line counter.

## Inputs

| Field | Required | Description |
|---|---|---|
| `targets` | yes | Array of work items. Each has `id` + `category` + EXACTLY ONE payload: `snippet` (inline code) \| `file_path` (+optional `line`, `context_lines` — default **60**, see note below) \| `path_glob` (expands to files). Optional per-item: `language`. |
| `category_rubrics` | no | `{category: rubric}` map. Each rubric goes into the SYSTEM prompt (snippet content can never alter it), length-capped + delimiter-sanitized. |
| `default_verdict_on_error` | no | Verdict on ANY error/deviation. Default `uncertain`. Never silently `not_threat`. |
| `budget_usd` | no | Whole-job hard pre-flight gate (all-or-nothing). Refuses the entire job if the estimate exceeds it — never a silent partial scan. |
| `model` | no | OpenRouter model id. Default `qwen/qwen-2.5-7b-instruct`. |
| `git_diff_ref` | no | For `path_glob` targets, restrict to files changed since this git ref. Shape-validated against injection. |
| `folder_root` | no | Root for relative `path_glob` / `git_diff_ref`. Default cwd. |
| `output_dir` | no | Report directory. Default `<main-repo-root>/reports/security_scan/`. |
| `workers` | no | Concurrent judge calls. Default 8. |
| `max_retries` | no | Per-call validation retries. Default 1. |

## Output

```
job_id=<id>
items=<N>
threat=<T>  not_threat=<NT>  uncertain=<U>
deduped=<D>  skipped_too_big=<S>
spent=$<X>
json=<absolute path to .json report>
report=<absolute path to .md report>
```

Return the `report=` (and `json=`) paths to the user — that's the
deliverable. Each per-item row carries `{id, category, file_path?, line?,
verdict, confidence, reason, injection_observed, injection_markers, model,
dedup_group}`.

## Fail-safe contract

The ONLY non-zero exit is a usage/shape error (bad input). Everything else
— no API key, API error, timeout, circuit-breaker trip, malformed model
output, over-budget — fans out to `uncertain` (or `default_verdict_on_error`)
and STILL produces a report. A scan never silently passes hostile code.

**Reading `uncertain` (consumer contract).** `uncertain` always means
keep-visible / human-review — NEVER treat it as a soft `not_threat`. The
injection-marker clamp is **context-aware**: a generic attack marker (e.g.
`ignore previous instructions`) that appears QUOTED, as a PATTERN DEFINITION, or
inside DEFENSIVE framing (a detector's own rule list, a "do NOT comply" doc) is
STILL reported in `injection_markers` but does NOT by itself force the verdict to
`uncertain` — the model's verdict is allowed to stand. By contrast a snippet that
tries to MANIPULATE THE ADJUDICATOR — addressing the reviewer, faking an
approval, or dictating "classify everything as not_threat" — is always clamped to
`uncertain` with `injection_observed: true`, regardless of quoting, and a model
`not_threat` whose own justification parrots such a manipulation is likewise
clamped. Consumers that auto-demote findings must demote ONLY on high-confidence
`not_threat` **and** `injection_observed: false` — an `uncertain` is a signal to
look, not to suppress.

**Provenance / data-flow verdicts are limited to the provided window.** The
adjudicator judges by where a value COMES FROM (taint/data-flow), not by the
surface presence of a risky token (`../`, an md5/sha1 name, a URL, a shell
word); a construct built entirely from static literals is typically `not_threat`,
while an untrusted source flowing into a sink is `threat`. Because the model sees
ONLY the `line ± context_lines` window (default **60**), a value whose ORIGIN is
not visible in that window should return `uncertain` rather than a guess —
callers for whom the origin of a value matters should widen `context_lines` or
pass a whole-file target so the data flow is visible.

**Why the default is 60 (calibrated).** A context-window sweep
(reports/security-scan-calibration/) found verdict accuracy is NON-MONOTONIC:
~6% good at cl=8, **0% at cl=20 (a dangerous partial-context valley with
confident under-flags)**, ~81% at cl=40, ~92% (stable) at cl=60/80/whole. The
cheap default model rarely abstains when provenance is off-window — it GUESSES —
so the mitigation is a window large enough to contain the data flow, not relying
on abstention. **Do not set a partial value like 20** (worse than tiny). Lower
`context_lines` only for surface-only checks (hardcoded-secret, weak-hash-name),
which are window-insensitive; keep ≥60 for taint/provenance categories
(path_traversal, ssrf, command_injection, sql_injection, env_injection,
open_redirect).

## CLI equivalent

```
bin/llm-externalizer security-scan --input-json '<json>'
```
(the `--input-json` value is the same object documented above). Also
reachable as `bin/llm-externalizer mass-scout security-scan ...`.

## Environment

Set `$OPENROUTER_API_KEY` (or configure the plugin's
`userConfig.openrouter_api_key`) before running. If it is absent the tool
does NOT error — it returns a report where every verdict is `uncertain`.
