---
trdd-id: XIS2EGGK
title: network-give-up ECONNRESET case stalls about 7 s in the full suite only
column: todo
status: tasked
created: 2026-11-19T13:55:58+0100
updated: 2026-11-19T13:55:58+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: spike
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-19T13:55:58+0100
---

# network-give-up ECONNRESET case stalls about 7 s in the full suite only

In the 14.7.6 publish gate (dry run at 96e0682e, 2026-11-19) the case "ARMED, resets on every attempt (ECONNRESET ...)" of scripts/llm-ext/src/network-give-up.test.ts took 8961 ms (assertion value 8921 ms) in the full suite. In that run the rest of the file took about 14.6 s against about 13.5 s alone (+8 percent), while this case took 2036 to 2098 ms in 20 solo runs, 10 of them under host load 105 to 120. So the extra 7 s belongs to this case in the full suite and is not uniform CPU contention. Its hint and network-code assertions passed, so the window armed and gave up. Candidates, none verified: the strict probe (strictProviderAnswer, PROBE_TIMEOUT_MS 5 s, network-give-up.ts) or a connect to the reset server stalled on a timer, for example loopback connect delays under the connection churn of the suite. The upper bound of the case was raised from 5 s to 20 s (see the WHY comment there), so a stall under 20 s no longer fails the gate; this card keeps it visible. Task: reproduce it (the file alongside the heaviest network test files), record a timestamp for each attempt and for the probe start and end, name the stall, then fix the code if it is a defect or record it as an environment limit with evidence. Acceptance: (1) the stall reproduced, or shown to need the full suite, with per-attempt and probe timestamps; (2) a cause named with evidence, and a fix or a ruling.

## Approval log

- 2026-11-19T13:55:58+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
