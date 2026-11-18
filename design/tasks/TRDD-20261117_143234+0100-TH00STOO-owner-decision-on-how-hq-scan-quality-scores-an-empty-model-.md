---
trdd-id: TH00STOO
title: Owner decision on how hq-scan-quality scores an empty model reply
column: planned
status: tasked
created: 2026-11-17T14:32:34+0100
updated: 2026-11-18T15:44:10+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: audit
min-approval-requirement: user
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-18T15:44:10+0100
---

# Owner decision on how hq-scan-quality scores an empty model reply

Owner decision for TRDD-90BXJ2KO. scripts/llm-ext/src/benchmark/hq-scan-quality.ts:230 scores the high_quality_scan fitness run on the raw aggregate; isTransientFailureReason (:143-151) makes 408, 429, 5xx and malformed bodies abstain (INCONCLUSIVE) and counts an empty 200 reply, a timeout and any other 4xx as model facts (FAIL), as TRDD-FUHTNE04 chose (an agent decision) and hq-scan-quality.test.ts:132-139 pins. Option A: keep it (a model that answers empty fails). Option B: an empty 200 abstains like a malformed body, matching the answered-only rule of TRDD-90BXJ2KO; cost: couldPassIfAnswered is optimistic, so a model that always replies empty stays INCONCLUSIVE on every run and never gets a verdict. No measurement of how often an empty 200 recurs on retry was found. Recording rule: the owner answers A or B in the conversation; the agent writes it verbatim on TRDD-90BXJ2KO as a line starting OWNER ANSWER hq-empty-reply, applies it, and clears the block.

## Approval log
2026-11-18T15:34:35+0100 main agent ruling (delegated by USER 2026-11-18, "solve all issues yourself. i need results."; not an owner answer): option A, an empty 200 stays FAIL (hq-scan-quality.ts:230, pinned by hq-scan-quality.test.ts:132-139). Why: B turns a persistent model defect into a non-verdict that never ends; a FAIL is re-probed on the next run. No code change. Evidence: triage reports b3-review2 (TH00STOO) and b1-blocked (90BXJ2KO).
- 2026-11-18T15:44:10+0100 — APPROVED by main-agent@llm-externalizer-plugin (min-approval-requirement: user). ruled A by the main agent under the 2026-11-18 USER delegation, see Approval log.
