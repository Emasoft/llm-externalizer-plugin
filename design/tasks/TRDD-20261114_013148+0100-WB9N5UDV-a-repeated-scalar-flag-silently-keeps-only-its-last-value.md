---
trdd-id: WB9N5UDV
title: A repeated scalar flag silently keeps only its last value
column: todo
status: tasked
created: 2026-11-14T01:31:48+0100
updated: 2026-11-16T09:44:32+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: user
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-14T01:31:48+0100
unblock-when: []
blocker-probe: 
blocker-holds-if: 
---

# A repeated scalar flag silently keeps only its last value

2026-11-14T01:31+0100 A scalar flag (type string, number or object) given twice keeps only its last value, silently: for example llm ask a.txt --instructions "a" --instructions "b" runs with "b" alone. Found by the review of the TRDD-OK1NN5RN fix, which makes repeated array and oneOf flags accumulate but leaves scalars as they are. Cause: scripts/llm-ext/src/cli/main.ts parseFlags assigns out[key] on every occurrence (the final assignment, line 347 before the OK1NN5RN change).

Proposed direction (fail fast, not decided): refuse a repeated scalar flag with an error naming the flag, instead of keeping the last value.

Acceptance:
- [ ] a repeated scalar flag exits non-zero with a message naming the flag, or a recorded decision says last-wins is intended
- [ ] a built-CLI test covers it

## Approval log

- 2026-11-14T01:31:48+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Notes

2026-11-14T01:33+0100 review of this card: booleans repeat last-wins too (--x true --x false); a repeated boolean is usually harmless, decide whether the refusal covers it. Whether any object-typed property reaches this path is not measured. Before refusing, check the launcher positional mapping (launcher.ts about 462-465): a command whose positional maps to a scalar flag would turn a positional plus the same explicit flag into a repeat, and the refusal would fire on it.
2026-11-14T14:41+0100 Owner decision needed (refuse or keep last-wins); a proposal was reviewed and NOT written. Measured: the main real path to a repeat is a positional plus the same scalar flag on summarize, topics, sem-deduplicate, describe, cluster (input_file), compact (transcript), folder, quality, impl (folder_path), specs, rules, info, assess (launcher.ts:461-464 maps only the first bare token; it does not mark which occurrence was positional), e.g. llm summarize a.txt --input_file b.txt runs on b.txt and silently drops a.txt. No doc, skill or test in the repo repeats a scalar flag that reaches parseFlags (classify has its own parser). Stripped before parseFlags: timeout flags (last-wins, outside parseFlags), the first --profile/--estimate/--preview only (a second one dies as unknown flag, a misleading message). One object-typed scalar exists: category_rubrics (mass_scouting/mcp-tools.ts:841). If refusal is chosen: the check must sit before the boolean branch (it continues early), the message must cover the positional case, the no-send assertion needs a server that throws, the test fits grouped-help-shape.test.ts, and the CHANGELOG note goes to TRDD-AUEJGI4T (14.3.0).
2026-11-14T14:41+0100 Qualifiers to the previous note (review): the no-repeat claim rests on one single-line regex over skills, commands, agents, docs, README and src *.md/*.test.ts; it misses commands split across lines, mixed --flag=value/--flag value, kebab vs underscore spellings, shell scripts and argv built in .ts. The a.txt/b.txt behaviour is from code reading, not a run. Whether security_scan (category_rubrics) reaches main.ts parseFlags is unverified. The decision should also cover: a second --profile, --estimate or --preview, which today dies as unknown flag (misleading), and the timeout flags, which keep last-wins outside parseFlags, so a refusal would leave two flag families inconsistent.
2026-11-14T14:41+0100 Blocked on the owner decision. To unblock, the owner records a line starting OWNER DECISION: in these Notes (refuse or last-wins, and whether it covers the stripped flags). The blocker-probe greps for that line; a decision has no other runnable check.
2026-11-14T14:42+0100 Correction to the previous note: the card is NOT blocked. A blocked card must name an open card in blocked-by and no card covers this decision, so it follows the board's existing form for owner-gated work: assignee user, column todo (like TRDD-58CFBQHN and TRDD-RPLLP8CF). Agents should not pull it; the owner unblocks it by recording a line starting OWNER DECISION: here and reassigning it.
2026-11-16T09:44:31+0100 DECISION (main agent, under the USER delegation of 2026-11-15 "on the other things, do as you think is better. but base your decisions on verified facts" and the 2026-11-16 goal "complete all TRDDs"; the USER may veto): refuse a repeated scalar flag (string, number, object) with an error naming the flag and exit non-zero, because the global rule is fail fast with no silent fallback and last-wins silently drops a value. Booleans stay last-wins (harmless, and --x false after --x true is an intentional override). Implementation follows.
