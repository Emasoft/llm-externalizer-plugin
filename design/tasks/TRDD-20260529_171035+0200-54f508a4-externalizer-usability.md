---
trdd-id: 54f508a4-266c-4838-979b-cea5b82823c3
title: LLM Externalizer usability + output-quality fixes — surfaced by a live code_task test
status: in-progress
created: 2026-05-29T17:10:35+0200
updated: 2026-05-30T01:53:21+0200
---

# TRDD-54f508a4 — LLM Externalizer usability + output-quality fixes

**Filename:** `design/tasks/TRDD-20260529_171035+0200-54f508a4-externalizer-usability.md`
**Tracked in:** `Emasoft/llm-externalizer-plugin` (this repo)

## How this was found

Live dogfood test (2026-05-29, v9.15.0): ran `node bin/llm-ext code_task` on a
real source file (`mcp-server/src/rule-install.ts`) under auto-free (balance
$0.10 < $1 → free pool). The run **succeeded** and produced a useful, grounded
report (4 findings, all referencing real code, zero hallucinations — including
one cross-platform bug the human reviewer had missed). But the run also exposed
several usability + output-quality problems. This TRDD investigates the causes
and proposes solutions.

Report evaluated: `reports/llm-externalizer/20260529_170119+0200-code_task-rule-install.ts-3b8393.md`

---

## Category A — the externalizer's own usability / output quality

### ISSUE 1 — `user_id` privacy leak + raw-JSON flood in logs AND the report file  [severity: HIGH / privacy]

**Root cause.** At the 4 HTTP-error construction sites the raw provider
response body is embedded verbatim into the thrown `Error` message:

- `mcp-server/src/index.ts:3148`, `:3153` (chat path)
- `mcp-server/src/index.ts:3367`, `:3372` (JSON path)

```ts
throw new Error(`API error ${res.status} (${backend.type}): ${text}`);
```

`text` is the full OpenRouter error envelope, e.g.
`{"error":{...},"user_id":"user_2g2eD6sJXkPdZVmNmxorPcNPLBo"}`. That message
then flows UNMODIFIED into every consumer because the ensemble stores it as the
failed model's content (`index.ts:4410-4413`, `content = \`ERROR: ${errMsg}\``):

- slot-retry console log — `index.ts:4174`
- ensemble rotation log — `index.ts:4436`
- **report file** "Unavailable models" section — `index.ts:4444`
- all-failed summary — `index.ts:4428`

**Impact.** (a) The OpenRouter account id is written into a report file the user
may attach to a PR / share — a privacy leak. (b) The console is flooded with
multi-line JSON blobs on every retry, obscuring the result.

**Proposed solution.** Add a pure, exported `sanitizeProviderError(raw, maxLen=200)`
that parses the envelope, keeps only `error.message` + `metadata.raw` +
`provider_name`, caps length, and scrubs `user_id` / `sk-…` tokens (belt &
suspenders for the unparseable path). Apply it at the 4 construction sites only
— a SINGLE SOURCE that cleans every downstream consumer. **Safe for
`classifyError`** (`index.ts:3622-3658`): it regex-matches the literal
`API error <status>` prefix, which lives in the template OUTSIDE the sanitized
`text`, so 401/402/403/429 classification (and the 402→auto-free hook) is
unaffected. Add offline unit tests (zero spend). **STATUS: helper drafted in
index.ts (uncommitted, not yet wired).**

### ISSUE 2 — three uncoordinated retry counters confuse the reader  [severity: MINOR / UX]

**Root cause.** Three independent retry layers each log their own counter with
no shared label:

- HTTP layer — `HTTP <status> (attempt N/6), retrying in Xs` (`index.ts:2682`, `RETRY_MAX_ATTEMPTS`)
- model/truncation layer — `Request error: … — retrying (N/3)` (`index.ts:4174`, `MAX_TRUNCATION_RETRIES`)
- circuit breaker — `N consecutive failures detected — waiting 60s` (`index.ts:4072`)

**Impact.** Interleaved `1/6`, `1/3`, and `backoff 1/3` lines read as chaos; the
user cannot tell which loop is active or whether progress is being made.

**Proposed solution.** Prefix each layer with a stable tag (`[http-retry]`,
`[model-retry]`, `[circuit-breaker]`) and include the model id where known.
Low-risk, log-string-only change; no control-flow change.

### ISSUE 3 — 429 retry log volume (the wall of noise)  [severity: MINOR / UX]

**Root cause.** `index.ts:2682` logs one line per HTTP retry attempt. The free
tier's per-minute cap (X-RateLimit-Limit 16-20, frequently Remaining 0) makes a
single ensemble call emit dozens of 429 lines across rotating models.

**Impact.** Alarming flood; hides the actual outcome.

**Proposed solution.** Aggregate per model: log the first 429 + a single rolling
summary (`model X: 429 ×N, rotating`) instead of one line per attempt; use
`X-RateLimit-Reset` for the wait hint when present. Hot path — preserve retry
behavior, only reduce log frequency.

### ISSUE 4 — no clear success summary; report path buried  [severity: MINOR / UX]

**Root cause.** The CLI prints the tool result (report path) to stdout with no
success banner, while stderr carries the retry noise; merged in a terminal the
path is easy to miss after a noisy run (`cli.ts` result printing; no `✓` line).

**Proposed solution.** Emit a final delimited success line to stderr
(`✓ code_task complete — N findings — report: <path>`) so it stands out from the
error stream; keep the machine-readable path on stdout unchanged.

### ISSUE 5 — finding-severity inflation  [severity: MINOR / output quality]

**Root cause.** The code-review system prompt (`index.ts:~1379-1391`, the
`code_task` path) defines NO severity rubric, so models self-assign
CRITICAL/MAJOR without anchors. (Contrast: `check_against_specs` DOES define one
at `index.ts:9734`.) In the test, a theoretical TOCTOU was rated CRITICAL and a
Windows-only test-path issue MAJOR.

**Proposed solution.** Add a compact severity rubric to the code-review system
prompt, mirroring the `check_against_specs` precedent: CRITICAL = demonstrably
exploitable / data loss / crash in normal use; MAJOR = wrong behavior on a
common path; MINOR = edge case / degraded UX; NIT = style/quality. Instruct
"default to the LOWER severity when uncertain; reserve CRITICAL for
exploitable issues."

### ISSUE 6 — a proposed fix in the finding was ineffective  [informational / model-dependent]

**Root cause.** The free model proposed re-running `underAllowedRoot` after
`mkdirSync` to close the TOCTOU — which does not actually close it (the write is
still separated from the check). This is model capability, not a code bug.

**Proposed solution.** None code-side. Partially mitigated by Issue 5 (better
calibration) and the existing ensemble/verification design (multiple models). For
high-stakes reviews, use a stronger model/profile. Document as a known
free-model limitation.

---

## Category B — genuine bugs the test correctly found in the scanned file

These are real bugs in `mcp-server/src/rule-install.ts` (our own code) that the
externalizer surfaced. Fixing them is good hygiene but is separate from
"externalizer usability." Listed for completeness.

### ISSUE 7 — tmp-file leak on rename failure  [MINOR]
`rule-install.ts:152-159`. If `renameSync` throws, the `.tmp.<pid>` written at
:155 is never unlinked. **Fix:** best-effort `unlinkSync(tmp)` in the catch.

### ISSUE 8 — `/tmp` hardcoded breaks on Windows  [MINOR]
`rule-install.ts:102`. The literal `/tmp` allowed-root does not exist on Windows
(affects the test-sandbox root; the `$HOME` root still works in production).
**Fix:** `os.tmpdir()`.

### ISSUE 9 — tmp name uses only `process.pid`  [NIT]
`rule-install.ts:154`. Collides if `installUsageRule` runs concurrently in one
process (low risk — called once at boot). **Fix:** append a random suffix.

---

## Proposed execution order (when greenlit)

1. **Issue 1** (privacy leak) — sanitizer + wire 4 sites + unit tests. Highest value, bounded, single-source. *(helper already drafted)*
2. **Issue 5** (severity rubric) — system-prompt edit. Bounded, improves every code review.
3. **Issue 4** (success summary) — CLI banner. Bounded.
4. **Issue 2** (retry labels) + **Issue 3** (429 aggregation) — log-only changes in hot retry paths; do together, test carefully.
5. **Issues 7-9** (rule-install.ts) — optional bonus fixes; trivial.
6. Issue 6 — doc note only.

Each phase: build + lint + full test suite (zero-spend) + commit. **No push** until the user approves (standing rule).

## Status log

- 2026-05-29 17:10 — TRDD authored from the live test evaluation. Issue 1's
  `sanitizeProviderError` helper drafted in index.ts (uncommitted, unwired)
  while root-causing. Awaiting greenlight to implement the full set.
- 2026-05-30 01:53 — **Phase 1 (Issue 1) COMPLETE.** `sanitizeProviderError`
  wired into all 4 error-construction sites (index.ts:3148/3153/3367/3372) — the
  single source that cleans the console flood AND the user_id leak in the report
  file. Provider name reordered before the verbose detail so it survives the
  200-char cap. 10 offline unit tests added (provider-error-sanitize.test.ts,
  registered in vitest.config.ts). build + lint clean; full suite 980/984 (was
  970; +10), zero regressions (classifyError-dependent suites still green →
  the `API error <status>` prefix is preserved outside the sanitized body).
  Remaining: Issues 5, 4, 2/3, and the rule-install.ts bonus (7-9).
