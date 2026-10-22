---
trdd-id: IQ6EHUUW
title: scout-accuracy authorization chain — verdict aging and profile round-trip
column: complete
status: archived
created: 2026-10-01T20:18:31+0200
updated: 2026-10-04T14:39:35+0200
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: refactor
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-10-01T20:18:31+0200
parent-trdd: FKAR9VPK
---

# verdict aging for the scout-accuracy ledger

Follow-up from TRDD-FKAR9VPK adversarial review F1 (ACCEPT-WITH-FINDINGS): passedModelIds() filters by dataset hash only — a PASS verdict never expires, so a model the provider later degrades or swaps stays authorized indefinitely. The hash covers fixture-version+threshold+target-size, not time. Choose and pin: either a max-age on passedModelIds() (re-probe verdicts older than N days) or an explicit date-agnostic ruling recorded here + a test asserting it. Either way the D7-era standard applies: tests pin the CHOSEN date-axis behavior, whichever it is.

## Approval log

- 2026-10-01T20:18:31+0200 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-04T14:39:35+0200 — COMPLETE by main-agent@llm-externalizer-plugin. Both residuals (date-axis + round-trip) landed and verified; earlier pin rounds v2/round-4 process debt already closed on the card.

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-10-01

RESIDUALS ROLLED IN 2026-10-01 (closure-review findings 2 and 3, so neither decays untracked): (a) THIS card also owns the writer-gate-reader round-trip gap — one test must write a profile via buildScoutingProfile->addProfileToSettings and read it through resolveScoutModel's reader (key-name drift between the two sides currently leaves both suites green); (b) the refusal-wording fix landed as fe3145a (refusals now address the USER and forbid an agent reader from running the paid benchmark). Pin the date-axis AND the round-trip test in one slice.
PIN-ROUND DISPOSITION 2026-10-01 (third review round, zero rejected): pin-test v2 landed — partial granularity consistent with its sibling pins, branch owned by a covers:-absence assertion (refusal 2 and the final refusal share an identical tail; only the covers: clause separates them), test renamed fix-round F2 pin (was mislabeled F1). POLICY on the deferred confirm gate: build an interactive confirm (--yes or TTY prompt) on the scout-accuracy benchmark ONLY IF agent-initiated benchmark spend is ever observed in practice; until then the ENFORCED daily cap (SpendLedger bookDailySpend) is the boundary — the USER-addressed refusal wording is mitigation, not enforcement. Archive-time check: reconcile the filename slug (still verdict-aging-...) with the retitled card when this card reaches a terminal move.
ROUND-4 DISPOSITION 2026-10-01 — REVIEW CHAIN TERMINATED (the round-4 fork itself ruled further rounds would only find meta-findings; no fifth round): (1) positive covers: pin landed on the coverage-message test — the refusal-2 pin's covers:-absence ownership is no longer vacuous; (2) TRIGGER-CONDITION REWRITE (replaces the earlier 'agent-initiated spend observed' policy, which no signal could ever fire): build the confirm gate if a benchmark run appears whose spend books while no interactive user session is active in the transcript logs — CHECKABLE; until then the enforced daily cap is the boundary; (3) if the confirm gate is ever built, ALSO stamp initiator context on the ledger/report entry so the trigger stays checkable going forward; (4) pin-loosening trade (tail-coherence for reword-tolerance) accepted as the round's explicit choice. Nothing else outstanding on this card's process debt.

## Acceptance

- [x] Date-axis pinned (option 1: 30-day reader-side max-age on passedModelIds, aged/unparseable dates fail closed) + writer-reader round-trip test (real writer, real gate, no drift found) + the 2026-10-31 ledger-test time-bomb fixed; 3 verbatim red proofs; coordinator reran the two test files 20/20 (commit 6e539f4; report reports/llm-externalizer/20261004_iq6ehuuw-pins.md)
