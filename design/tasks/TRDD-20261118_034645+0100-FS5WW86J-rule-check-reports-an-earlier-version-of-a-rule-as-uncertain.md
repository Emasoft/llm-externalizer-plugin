---
trdd-id: FS5WW86J
title: rule-check reports an earlier version of a rule as uncertain, not updated_version
column: todo
status: tasked
created: 2026-11-18T03:46:45+0100
updated: 2026-11-18T07:31:14+0100
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

Follow-up of TRDD-LFTQCFUX. On the build that ships rule-check, an earlier version of a rule is never reported as updated_version at the 0.6 default: the example r2 0 of 5 (confidence 0.33 to 0.52), and the phrase against r2, u1, u2 alone is uncertain in 5 of 5. The old recipe (classify label with three classes, r2 alone; reconstructed from git show 3516d3d8, a different prompt structure, not the original run files) gave 0.85 to 0.89 in 5 of 5. Of three prompt variants measured on 2026-11-18, none gave r1 and r2 both at 0.6 or more (packed, variant (e) reached r1 at 0.6 or more in 1 of 5 runs and r2 in none) (see the Progress of LFTQCFUX). Gate before any change to the rule-check wording or the packing default: (1) a regression run, a genuinely new phrase against the 25 janitor PRRD rules must still come out new, plus one more duplicate and updated_version pair besides the loading-screen example; (2) first experiment, the old label recipe measured on r1 too (it was measured on r2 alone); (3) 5 runs per set, interleaved, not back to back. The packing default (packed, or one rule per request, which the default profile refuses above 8 rules) is the USER decision. The 3-pillars session answer on whether uncertain routed to a person is usable goes into this card. The 3-pillars session (the consumer) asks for: a regression pair where the new phrase CONTRADICTS the earlier rule (the wording changes a value), since a wrong confident updated_version or duplicate there is the costly error; and a unit test pinning that an uncertain outcome lists the earlier-version rule in candidates with its id.

## Approval log

- 2026-11-18T03:46:45+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Notes

Author and approval fields were set by the worker from the coordinator correction of 2026-11-18: --author main-agent@llm-externalizer-plugin. trddgrep then wrote approved true, mandate true, min-approval none and approval-judge main-agent@llm-externalizer-plugin from that identity. The main agent confirmed the author and the self-approval on 2026-11-18. The project runs with one agent, and every card here has the same issuer.
2026-11-18T03:53:19+0100 3-pillars session answer (peer input, not a USER decision): uncertain routed to a person is usable meanwhile if (1) the earlier-version rule is in candidates with its rule_id, pinned by a test (rule-check.test.ts, an updated version below --min-confidence is uncertain); (2) uncertain is never reported as new, and an unanswered rule keeps the outcome uncertain; (3) the exit code and the decision fields stay stable enough to script on. An automatic merge of an earlier version waits for this card.

## Corrections

2026-11-18T04:29:34+0100 The message of commit bd71799f says that of three variants none raised r2 and kept r1 together. Correct: no variant gave r1 and r2 both at 0.6 or more. Unpacked, variant (e) raised r2 to 0.44 to 0.50 with r1 at 0.70 to 0.76; packed, (e) reached r1 at 0.6 or more in 1 of 5 runs and r2 in none. The commit is pushed with v14.7.0 and is not amended.
2026-11-18T07:31:14+0100 Correction of the Progress lines below (same day, main agent). The measurement line says the outcome is never new; measured is that the outcome for r2 on the shipped example was uncertain, not new, in 5 of 5 runs. The decision line says the loading-screen r2 miss is specific to that pair; measured is only that rule-check found the updated version on the one other pair measured (S6.1, 5 of 5), so one other pair does not show that the miss is specific to the loading-screen pair. The Acceptance boxes were written and ticked after the measurements; the three gates they restate are in the first commit of this card (bd71799f, 03:54), before the measurements. No file under scripts/llm-ext/src/classifiers differs between v14.7.0 and 52e605b5 except the test file local-decider-remote-error.test.ts (git diff --stat, run by the main agent).

## Progress

2026-11-18, measurements (report: main checkout reports/sonnet-worker/20261118_071812+0100-fs5ww86j-measurements.md; build 52e605b5, the rule-check of 14.7.0; model typesafe/jev-1.14-20261014; 5 runs per set, interleaved; 50 Jev requests, 0.0034 USD; counts, not rates). Old classify label recipe on the loading-screen pairs: r1 duplicate 5 of 5, at 0.6 or more in 3 of 5 (0.58 to 0.68); r2 updated_version 5 of 5, all at 0.6 or more (0.82 to 0.88). Current rule-check on the shipped example: duplicate r1 5 of 5 (0.68 to 0.76); r2 labelled new at 0.37 to 0.55, so it stays a candidate and the outcome is never new.
2026-11-18, regression set: a new phrase against the 25 janitor PRRD rules came out new 5 of 5 (25 confident new). A second pair on the janitor rule S6.1, written by the worker and checked by the main agent: the paraphrase came out duplicate S6.1 5 of 5 (0.97 to 0.98) under both recipes; the phrase with one detail added came out updated_version S6.1 5 of 5 at 0.67 to 0.74 under rule-check, against 2 of 5 at 0.6 or more under the old recipe. Contradiction pair on S5.1 (the phrase reverses the rule): rule-check outcome updated_version S5.1 at 0.96 to 0.97 with conflict true 5 of 5; never duplicate, never conflict false. The old recipe has no contradiction question.
2026-11-18, decision (main agent): no change to the rule-check wording or the packing default follows from this data. The old recipe is not better overall (weaker on r1 and on the S6.1 detail-added pair); rule-check finds the updated version of the second pair, so the loading-screen r2 miss is specific to that pair, and r2 stays a candidate with its id. Two USER decisions stay open: the packing default (packed, or one rule per request), and whether a contradicting phrase (updated_version with conflict true) is merged or put to the owner (LFTQCFUX open point a). Results sent to the 3-pillars session on 2026-11-18.

## Acceptance

- [x] Gate 1: a regression run where a new phrase against the 25 janitor PRRD rules still comes out new, plus one more duplicate and updated_version pair besides the loading-screen example.
- [x] Gate 2: the old label recipe measured on r1 as well as r2.
- [x] Gate 3: 5 runs per set, interleaved, not back to back.
- [x] The 3-pillars asks: a contradiction regression pair measured, and a unit test that pins an uncertain outcome listing the earlier-version rule in candidates with its id (rule-check.test.ts, the test an updated version below --min-confidence is uncertain).
- [x] The decision on a wording or packing change is recorded from the data, with the two open USER decisions named on this card.
