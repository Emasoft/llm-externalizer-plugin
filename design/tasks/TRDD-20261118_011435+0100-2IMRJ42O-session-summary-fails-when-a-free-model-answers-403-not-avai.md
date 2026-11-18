---
trdd-id: 2IMRJ42O
title: session-summary fails when a free model answers 403 not available in your region
column: backburner
status: tasked
created: 2026-11-18T01:14:35+0100
updated: 2026-11-18T01:18:10+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-18T01:14:35+0100
---

# session-summary fails when a free model answers 403 not available in your region

Measured 2026-11-18 00:54 +0100: llm-ext session-summary --stdout --transcript <93 MB session transcript> (14.6.3, free profile) exited 1 after 88 s; last stderr line: FAILED: session-summary: chunk 14 (slot 2) failed after 3 attempt(s) on model thinkingmachines/inkling-2-small:free: API error 403 (openrouter): This model is not available in your region. The run resumed from a checkpoint, so every rerun fails at chunk 14. The janitor handoff composer logged it as a repeated failure on 2026-11-17 16:13, 2026-11-17 22:55 and 2026-11-18 00:02 (janitor issue 364 covers its signature).

Cause: in scripts/llm-ext/src/free-rotation.ts, function classifyUnavailable, const modelSpecific403 accepts only the phrases "only available", "agentic harnesses", "not available for free", "unavailable for free". The region text matches none, so it is a generic 403 and classifyUnavailable returns null; session_summary/driver.ts then retries the same model and fails the chunk, and each resumed run fails at the same chunk.

Fix: treat "model is not available in your region" as model-specific 403 phrasing, because it names the model, not the key; a region refusal without those words stays a generic 403 under the 2-distinct-model quorum (negative test added). Observed on this one model only; no key-level 403 body was captured to compare, so a key-scoped region refusal is not ruled out. Risk: a phrase classed model-specific returns "gone" on a single refusal, so the 2-distinct-model generic-403 quorum does not protect it; if a key- or account-wide refusal ever carries the same words, healthy models would be sidelined one by one. That case is unobserved. Test in src/free-rotation.test.ts next to the "still classifies a 403 naming the model" case.

Done when: the unit test passes, tsc and eslint are clean, and a rerun of the same session-summary with the fixed build resumes chunk 14 on another free model (exit 0, or a different failure).

## Approval log

- 2026-11-18T01:14:35+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Progress

2026-11-18: driver path, as read by the coordinator (not re-read by the worker that wrote this line): classifyModelFallback returns "gone" when classifyUnavailable does, and the caller (session_summary/driver.ts, about line 1066) throws ModelUnavailableError, which passes the chunk to the next candidate; driver.test.ts (about line 2193) already covers that path for a model-specific 403. The live rerun on the real checkpoint is still to do.
2026-11-18: the negative test uses "Access in your region is blocked" (contains the old bare phrase, lacks "model is not available"); verified it fails with the old bare "in your region" match and passes with the narrowed one (127 of 127 pass). The driver-path entry above is the coordinator's own read, handed to this worker in its brief; this worker did not re-read driver.ts.
