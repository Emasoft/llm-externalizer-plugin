---
trdd-id: LFTQCFUX
title: classify preset that says duplicate, updated version or new for a rule against existing rules
column: todo
status: tasked
created: 2026-11-04T10:29:26+0100
updated: 2026-11-18T02:12:50+0100
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
