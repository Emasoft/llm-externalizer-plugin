---
trdd-id: P4ULUV1R
title: Lift the non-empty non-echo response gate from session_summary to the common send path
column: complete
created: 2026-08-18T19:54:05+0200
updated: 2026-08-18T23:52:00+0200
release-via: publish
implementation-commits: [bd7ce89, 478d78e, 18718e7]
current-owner: llm-externalizer-claude
task-type: bugfix
approval-tier: 0
---

# Lift the non-empty/non-echo response gate to the common send path

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-08-18 (rev 2)

PHASE 2 LANDED (this commit): (a) FINAL-ASSEMBLY gate on session-summary
— an empty assembled summary now exits non-zero on BOTH --stdout and
report-file paths (defect reported live by the ai-maestro-janitor
session: 14x exit-0-empty on one host; wording avoids availability
vocabulary so classifyUnavailable can never key on it); (b) echo gate at
the 4 remaining sites (compare_files x2 fail loudly; check_references
x2 drop the reply like an empty one); (c) 8 per-surface wiring tests
(478d78e, mutation-checked by the authoring agent, re-verified
first-hand). Acceptance notes: the generic surfaces deliberately do NOT
use the `(nonconforming)` token — janitor 3.3.16 keys it to
session_summary's schema verdict; generic failures say empty/echo.
Batch all-groups-gated already fails via the pre-existing "no group
produced anything" exit (asserted by surface test 5). check_imports
conformance comes from its mandated JSON parse (surface tests 7/8).

NEXT ACTION: dogfood (`uv run tests/dogfood/dogfood_test.py`, $0) →
publish (>=13.5.7) → message the janitor session the version (their
TRDD-PXP08ZQC rollout waits on it) → move this card testing→complete.

Phase 1 (landed bd7ce89):
- NEW `src/response-gate.ts`: `isEchoResponse`/`normalizeForEchoCheck`/
  `ECHO_MIN_RESPONSE_LENGTH` moved here from session_summary/driver.ts
  (driver re-exports `isEchoResponse` — its tests unchanged, 70/70 green)
  plus `gateLLMResponse` (null|"empty"|"echo") + `gateFailureMessage`.
- GATED: processFileCheck (scan/check/code per-file path — echo added to
  the existing empty check; source = perFileUserContent), chat
  single-shot (source = promptBase), chat batched (echoed group now
  dropped like an empty one; source = userContent).
- `src/response-gate.test.ts` added AND registered in vitest.config.ts
  (the include list is explicit — an unregistered test never runs).
- FACT CORRECTION vs the body below: empty was ALREADY gated on chat
  single-shot and processFileCheck before this card; the real gap was
  echo (everywhere) + silent inclusion of echoed batch groups.

NEXT ACTION: read reports_dev/vitest-p4uluv1r.log — full suite + build
must be green; then commit source (by name) + this card.

Remaining (Phase 2, this card stays open until decided/done):
- Per-surface stubbed-boundary tests (chat/code/scan/check) per
  acceptance box 3.
- Batched path: decide whether ALL-groups-gated should FAIL the command
  instead of producing an empty report (currently pre-existing skip
  semantics are preserved).
- check_imports: document that structure (JSON parse) covers
  conformance on that path — verify, then tick or amend box 2.
- ensembleStreaming call sites NOT in the card's acceptance list —
  AUDITED 2026-08-18 (read in place): compare_files (~index.ts:5043 and
  ~5348) and check_references (~5480 and ~5554) each already fail on
  EMPTY but accept an ECHO (a model returning the diff/source verbatim
  ships as analysis). Same one-line gate fix, user content in scope at
  every site (msgs user entry). Apply after the surface-test agent
  exits (it reads index.ts; don't shift lines under it).

## WHY

The 2026-08 compaction incident (a model REFUSAL shipped as a summary at
exit 0) was fixed for `session_summary` only: v13.5.4/13.5.5 added a
non-empty + non-echo + `(nonconforming)` response gate on that one path.
The self-audit (reports/plugin-self-audit/DELEGATION.md, Unit "response
gate", CONFIRMED) verified that the OTHER send paths — `llm chat`/`ask`,
`llm code`, `scan *`, `check *` — still treat "the model printed
something" as success: an empty, truncated, or input-echo response is
written to the report file and the command exits 0.

## Scope

- Extract the gate session_summary uses into the shared send layer so
  every LLM round-trip passes through it (one source of truth — no
  per-command copies).
- Preserve the exact `(nonconforming)` token on the failure exit path:
  ai-maestro-janitor 3.3.16 keys on that literal — renaming it is
  BREAKING (see memory `reference_prompt_frame_causes_refusal`).
- Per-command thresholds may differ (a chat answer can legitimately be
  short; a scan report cannot be empty) — the gate takes the minimum
  contract from the call site, defaulting to non-empty + non-echo.
- Echo detection: reuse session_summary's existing heuristic verbatim;
  do NOT invent a new one (field record: 0/9 refusals since 13.5.4).

## Acceptance

- [ ] One shared gate function; session_summary calls it (no behavior
      change there — its tests stay green unmodified).
- [ ] chat/ask, code, scan folder, check imports each fail non-zero with
      the `(nonconforming)` marker on an empty or echo response.
- [ ] Tests: one per surface with a stubbed empty response + one echo
      case (real code path, stub only the network boundary).
- [ ] dist rebuilt; dogfood run (`uv run tests/dogfood/dogfood_test.py`)
      green before publish.

## Notes and lessons learned

## Approval log

- 2026-08-18T23:52:00+0200 — COMPLETE. bd7ce89 (shared gate + 3 sites) +
  478d78e (8 mutation-checked surface tests) + 18718e7 (empty-final-
  summary non-zero exit + 4 more echo sites). Full suite 2117 green,
  dogfood 119/0, shipped in v13.5.7 (7b758c5). Janitor session notified
  (their TRDD-PXP08ZQC verification proceeds on their cache update).
