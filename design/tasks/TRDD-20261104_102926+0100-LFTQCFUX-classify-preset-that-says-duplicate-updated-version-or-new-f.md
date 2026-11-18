---
trdd-id: LFTQCFUX
title: classify preset that says duplicate, updated version or new for a rule against existing rules
column: todo
status: tasked
created: 2026-11-04T10:29:26+0100
updated: 2026-11-18T03:25:27+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-04T10:29:26+0100
implementation-commits: [5ade58a1, 737cd18d, 1b58e098, 3516d3d8]
---

# classify preset that says duplicate, updated version or new for a rule against existing rules

Gap G2 of TRDD-Q2VTMG4P (capabilities C3 and C5). classify find (find.ts:13-30) ranks the nearest rules and says whether the phrase exists, and classify compare (compare.ts:27-31) only says same_fact, contradicts or different_facts for two passages given as JSON. No command returns the three outcomes the user's pipeline needs: duplicate, updated version of rule X, or new. Add a preset or spec (for example a label preset with classes duplicate, updated_version, new, fed the candidate rule found by find) that reads rules from a file such as PRRD.md or TRDD files, and test it on the user's loading-screen example.

## Approval log

- 2026-11-04T10:29:26+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Notes

Code line numbers were reported by a read-only audit on 2026-11-04 and are not re-read; confirm them at card start. When this ships, update the requirements-pipeline reference of TRDD-Q2VTMG4P.
2026-11-04T13:22:52+0100 the skill page skills/llm-externalizer-cli-reference/references/requirements-pipeline.md step 2b documents the current two-command workaround (classify label per candidate rule plus a reading rule) and calls the single command a gap without naming this card; update that paragraph when this card ships.
2026-11-17T15:13:50+0100: parent skills card TRDD-Q2VTMG4P is archived (complete). When this card ships, update skills/llm-externalizer-cli-reference/references/requirements-pipeline.md (and classify.md where the command is documented) yourself; no live card tracks the C1 to C5 map any more.

## USER decisions

2026-11-18T02:12:35+0100 USER verbatim: "be sure to respond to the needs of the 3-pillars-system plugin claude. coordinate with it as with the janitor for the other issue."

## Contract (agreed with the 3-pillars session 2026-11-18; two points await the owner)

- Command: `llm-ext classify rule-check`, one phrase per call. Input JSON (--input or stdin): {"phrase": "<text>", "rules": [{"id": "<opaque id, echoed unchanged, e.g. G7.4>", "text": "<plain rule text>"}]}. It runs the find step over `rules` itself; no 250-candidate limit for the caller.
- Output (--json on stdout): {"outcome": "duplicate" | "updated_version" | "new" | "uncertain", "rule_id": "<id or null>", "conflict": <bool, set when the phrase contradicts the matched rule>, "ambiguous": <bool, set when two or more candidates qualify as updated_version>, "candidates": [{"id", "label", "confidence", "probabilities": {"duplicate", "updated_version", "new"}}], "reason": "<one line>"}. Never a forced label: no label at or above 0.6 gives outcome uncertain.
- Flags: --context <file> as in classify label; documented exit codes for answered, uncertain and failed; it writes no file (the caller writes rules through prrdgrep). Rule text arrives without the trailing {created:..., updated:...} metadata block (the caller strips it).
- The reference must state how many Jev requests of which kind one call makes. Planned switches, kept possible for the owner: --pairwise (skip find, label every phrase-rule pair one by one, for short lists) and --split-checks (ask duplicate and version as two separate label requests). Their cost in requests goes to the owner if high.
- OWNER'S CALL, open: (a) whether a contradicting phrase is merged or put to the owner; (b) whether each Jev request must hold one candidate and one existing rule, with the duplicate and version checks as two different requests (owner drafts of 2026-11-03).
- Acceptance includes a request file for the loading-screen example (phrase, r1, r2, u1, u2) that the 3-pillars session runs once; the main agent messages that session when rule-check is committed and when it is released.
- PN7F00RF: the 3-pillars session parses PRRD.md with prrdgrep and passes the rules as items, so the PRRD extraction is not needed for this consumer.

## Progress

2026-11-18T02:38:40+0100 The classify code forced five contract changes, accepted by the 3-pillars session on 2026-11-18 with four conditions. Changes: no find step (each rule is judged as a phrase-rule pair, pairs packed per request, no 250 cap); with --json the fields sit under .decision of the envelope; without --strict-exit every answered run exits 0 and the consumer branches on .decision.outcome and treats any non-zero exit as a failed check; precedence duplicate over updated_version over new at 0.6, ambiguous on two or more updated_version; ids [A-Za-z0-9_.:-]{1,64}, echoed unchanged. Conditions: A, any unanswered pair makes the outcome uncertain and lists the rule ids; B, document stopped and degraded, preferably a stopped run is always uncertain; C, each candidate carries its contradicts answer and conflict is true when any rule is contradicted, even one labelled new; D, candidates list only the pairs that are not a confident new, plus a count of the confident-new pairs. Request: a flag for the per-request question cap (one pair per request, as in the owner draft of 2026-11-03), its cost to the owner first. Design spec: design/specs/LFTQCFUX-rule-check-design.md.
2026-11-18T03:17:27+0100 Part 1 rule-check committed as 5ade58a1 and Part 2 --max-questions-per-request as 737cd18d, both through the fail-closed ubs hook with 0 critical; docs and the classify-launch test fix pending commit; live check 1 outcome matched (duplicate r1) but r2 came back new (0.40, 0.42, n=2) where the classify label recipe of 2026-11-04 gave updated_version 0.86, an open quality item for the relation question wording; live check 2 (new phrase vs 25 janitor PRRD rules) gave new, 25 confident.
2026-11-18T03:24:27+0100 The classify-launch test fix landed as 1b58e098 and the docs as 3516d3d8 (the earlier line saying they were pending is superseded). r2 measurement, samples of 5, not rates: on the current build r2 was updated_version at confidence >= 0.6 in 0 of 5 runs (example and caseA without r1), the old classify label recipe in 5 of 5, and a scratch build with the updated_version class text reworded gave 4 of 5 on caseA but turned the example outcome from duplicate r1 into uncertain in 5 of 5; caseA never came out new (uncertain 5 of 5 on the current build). Report: reports/sonnet-worker/20261118_032342+0100-r2-measurement.md
2026-11-18T03:25:26+0100 Clarification of the line above (review findings): the 0.6 in the r2 counts is the default --min-confidence of rule-check (rule-check.ts lines 132-133), not p(updated_version). Label-only, r2 was updated_version at any confidence in 3 of 5 (caseA) and 1 of 5 (example) on the current build, 5 of 5 on each input on the scratch build with reworded class text, and 5 of 5 on its one input (pair alone) in the old recipe reconstructed from git show 3516d3d8 (a different prompt structure, not the original run files). The scratch build comes from git archive HEAD (without the uncommitted TN8OUZ50 edit). 1b58e098 is the classify-launch test fix (checked with git show --stat); all 25 runs had no warnings, no degraded, not stopped.

## Corrections

2026-11-18T03:17:27+0100 The message of 5ade58a1 says the fail-closed pre-commit gate "blocks every file this change touches"; correct is that it blocks the commit that stages them (amend needs the USER OTP).
