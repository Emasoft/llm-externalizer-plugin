---
trdd-id: TH00STOO
title: Owner decision on how hq-scan-quality scores an empty model reply
column: proposal
status: proposed
created: 2026-11-17T14:32:34+0100
updated: 2026-11-17T14:32:34+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: audit
min-approval-requirement: user
approved: false
---

# Owner decision on how hq-scan-quality scores an empty model reply

Owner decision for TRDD-90BXJ2KO. scripts/llm-ext/src/benchmark/hq-scan-quality.ts:230 scores the high_quality_scan fitness run on the raw aggregate; isTransientFailureReason (:143-151) makes 408, 429, 5xx and malformed bodies abstain (INCONCLUSIVE) and counts an empty 200 reply, a timeout and any other 4xx as model facts (FAIL), as TRDD-FUHTNE04 chose (an agent decision) and hq-scan-quality.test.ts:132-139 pins. Option A: keep it (a model that answers empty fails). Option B: an empty 200 abstains like a malformed body, matching the answered-only rule of TRDD-90BXJ2KO; cost: couldPassIfAnswered is optimistic, so a model that always replies empty stays INCONCLUSIVE on every run and never gets a verdict. No measurement of how often an empty 200 recurs on retry was found. Recording rule: the owner answers A or B in the conversation; the agent writes it verbatim on TRDD-90BXJ2KO as a line starting OWNER ANSWER hq-empty-reply, applies it, and clears the block.

## Approval log
