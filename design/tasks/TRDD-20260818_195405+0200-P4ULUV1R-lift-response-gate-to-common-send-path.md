---
trdd-id: P4ULUV1R
title: Lift the non-empty non-echo response gate from session_summary to the common send path
column: planned
created: 2026-08-18T19:54:05+0200
updated: 2026-08-18T19:54:05+0200
current-owner: llm-externalizer-claude
task-type: bugfix
approval-tier: 0
---

# Lift the non-empty/non-echo response gate to the common send path

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
