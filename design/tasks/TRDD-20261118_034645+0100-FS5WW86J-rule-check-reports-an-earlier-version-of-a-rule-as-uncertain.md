---
trdd-id: FS5WW86J
title: rule-check reports an earlier version of a rule as uncertain, not updated_version
column: todo
status: tasked
created: 2026-11-18T03:46:45+0100
updated: 2026-11-18T03:53:20+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-18T03:46:45+0100
---

# rule-check reports an earlier version of a rule as uncertain, not updated_version

Follow-up of TRDD-LFTQCFUX. On the build that ships rule-check, an earlier version of a rule is never reported as updated_version at the 0.6 default: the example r2 0 of 5 (confidence 0.33 to 0.52), and the phrase against r2, u1, u2 alone is uncertain in 5 of 5. The old recipe (classify label with three classes, r2 alone; reconstructed from git show 3516d3d8, a different prompt structure, not the original run files) gave 0.85 to 0.89 in 5 of 5. Of three prompt variants measured on 2026-11-18, none raised r2 and kept r1 together (packed, variant (e) did neither) (see the Progress of LFTQCFUX). Gate before any change to the rule-check wording or the packing default: (1) a regression run, a genuinely new phrase against the 25 janitor PRRD rules must still come out new, plus one more duplicate and updated_version pair besides the loading-screen example; (2) first experiment, the old label recipe measured on r1 too (it was measured on r2 alone); (3) 5 runs per set, interleaved, not back to back. The packing default (packed, or one rule per request, which the default profile refuses above 8 rules) is the USER decision. The 3-pillars session answer on whether uncertain routed to a person is usable goes into this card. The 3-pillars session (the consumer) asks for: a regression pair where the new phrase CONTRADICTS the earlier rule (the wording changes a value), since a wrong confident updated_version or duplicate there is the costly error; and a unit test pinning that an uncertain outcome lists the earlier-version rule in candidates with its id.

## Approval log

- 2026-11-18T03:46:45+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Notes

Author and approval fields were set by the worker from the coordinator correction of 2026-11-18: --author main-agent@llm-externalizer-plugin. trddgrep then wrote approved true, mandate true, min-approval none and approval-judge main-agent@llm-externalizer-plugin from that identity. The main agent confirmed the author and the self-approval on 2026-11-18. The project runs with one agent, and every card here has the same issuer.
2026-11-18T03:53:19+0100 3-pillars session answer (peer input, not a USER decision): uncertain routed to a person is usable meanwhile if (1) the earlier-version rule is in candidates with its rule_id, pinned by a test (rule-check.test.ts, an updated version below --min-confidence is uncertain); (2) uncertain is never reported as new, and an unanswered rule keeps the outcome uncertain; (3) the exit code and the decision fields stay stable enough to script on. An automatic merge of an earlier version waits for this card.
