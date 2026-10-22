---
trdd-id: HVYKK7UF
title: P-01 Paid probe of the decisions API
column: complete
status: archived
created: 2026-10-07T18:45:48+0200
updated: 2026-10-09T22:17:06+0200
current-owner: user
created-by: user
task-type: spike
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T18:45:48+0200
---

# P-01 Paid probe of the decisions API (no go-ahead needed, D12)

## Goal
Capture real replies from the decisions API (both endpoints, every question type and size, the error statuses) as raw fixtures, and print and record what the probe cost.

## Approval log

- 2026-10-07T18:45:48+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-09T21:43:14+0200 — column → todo by user. USER 2026-10-09: complete the jev plan
- 2026-10-09T21:43:15+0200 — column → dev. probe started 2026-10-09
- 2026-10-09T22:17:06+0200 — COMPLETE by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan.

## Plan refs

§1 D2 (no spend cap, no go-ahead for Jev calls), D12, D21; §6 (final tolerances come from these fixtures); §7 (error bodies, `max_tokens_exceeded`); §5 (second context limit); §16 P table.

## Depends on

none (plan npt: —)

## Files

To be listed at card start. Raw captures are the input of P-03, which owns `src/classifiers/__fixtures__/` (relative to `scripts/llm-ext/`).

## Reuse

Read the code at card start.

## Steps

1. (derived from done-when) Take the API key from the environment only; never print it, never write it into a fixture.
2. Capture a noul reply.
3. Capture choice replies with 2, 3, 10 and 60 options.
4. Capture score replies with 3, 5 and 10 criteria.
5. Capture each of these on both endpoints, `decisions` and `systemone`.
6. Capture the error replies for 400, 401, 404 and 413, and the exact OpenRouter body for `max_tokens_exceeded`.
7. Find the allowed characters and the maximum length of a question key and a criteria key (E30 pattern).
8. Record the response headers.
9. Record the shape of the context limit (if a second limit exists, state + longest question, note it for §5 `ModelLimits`).
10. Print the total cost of the probe and record it on the card. No cap, no go-ahead (D2, D12).

## Acceptance

- [x] fixtures for noul
- [x] fixtures for choice with 2, 3, 10 and 60 options
- [x] fixtures for score with 3, 5 and 10 criteria
- [x] fixtures from both endpoints
- [x] error fixtures for 400, 401, 404, 413 and `max_tokens_exceeded`
- [x] allowed question-key characters and length recorded
- [x] headers recorded
- [x] context-limit shape recorded
- [x] probe cost printed and recorded on the card, never capped
- [x] definition of done for a probe card: raw replies saved outside the repo (reports/), cost printed and recorded on the card
RESULT 2026-10-09 (verified by the coordinator: 294 files under reports/classifiers-probe/p01/, grep for the API key = 0 in all, no Authorization header saved): 97 requests, total cost 0.002526 USD per the worker's sum of usage.cost over 78 replies (the coordinator did not re-sum); report reports/classifiers-probe/20261009-p01-report.md; repeatable script p01/probe.sh. Both endpoints answer every case: /api/alpha/decisions and /api/v1/systemone. DIFFERENCES FROM THE PLAN, each owed to a later card: (1) an unknown model id returns 400, not 404 (404 only for a wrong URL path) — L0-01 must classify by the error body, not the status alone; (2) the only refused question key is the empty one; lengths up to 5000 and every tested character are accepted — the D14 id rule is our own, not the API's (E30); (3) ONE context limit of about 32k tokens on state plus questions together, no second limit — section 5 ModelLimits needs no second-limit field; (4) 413 only above 52,428,800 bytes; a 12 MB body gets 400 with body {"error":{"message":"HTTP 400: {\"detail\":{\"error_type\":\"max_tokens_exceeded\"}}","code":400}}, no usage and no cost.

## Out of scope

Sanitizing and storing fixtures (P-03), the catalog snapshot (P-02), tolerance numbers (P-04).
