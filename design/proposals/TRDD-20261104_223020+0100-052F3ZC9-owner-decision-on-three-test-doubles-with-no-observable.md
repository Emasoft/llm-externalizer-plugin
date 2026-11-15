---
trdd-id: 052F3ZC9
title: Owner decision on three test doubles with no observable
column: proposal
status: proposed
created: 2026-11-04T22:30:20+0100
updated: 2026-11-04T22:31:53+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: audit
min-approval-requirement: user
approved: false
---

# Owner decision on three test doubles with no observable

Three test doubles remain in the classifier tests with no observable in a real input; the owner has not decided any of them (facts from TRDD-KNSQAQ1S, Left line, and its 22:15+0100 line; JDMY8LPJ, which also ticked the no-doubles clause, records no decision for any site). Site 1: scripts/llm-ext/src/classifiers/l0/catalog.test.ts:10, vi.mock of node:fs; it counts cache reads, which have no observable without a seam. Site 2: scripts/llm-ext/src/classifiers/l2/evidence.test.ts:89, vi.spyOn of JSON.stringify; it checks the 400-character bound; the worker replacement used a 1 GB input whose RangeError guard catches only a stringify of the whole input, not the 400-character bound, so it was not committed (git stash "TRDD-KNSQAQ1S evidence.test.ts attempt" and reports_dev/knsqaq1s/20261104_130458+0100-evidence-test-attempt.diff). Site 3: scripts/llm-ext/src/classifiers/catalog/findings.test.ts:233, counting wrapper on String.prototype.split that calls through and counts the splits of one source (per the dispatching brief); KNSQAQ1S: no observable without a seam, same class as the other two. Rules in tension: the standing user rule allows a double only when nothing else is possible; the TRDD-ZB41KG62 ruling (2026-10-31) forbids every double outside the GlobalFetch seam and categories a, b, c, and these sites fall between the two. Options per site: A keep the double with a recorded exemption; B add a production seam (an injected reader or estimator) so a real observable exists (KNSQAQ1S: itself a double of no ruling category); C drop the count or bound assertion and rely on the WHY comment at the production site. Requested: one answer per site (A, B or C), recorded verbatim in the Approval log; until then TRDD-KNSQAQ1S stays blocked.

## Approval log
Recording rule: the owner answers in the conversation, one of A, B or C per site; the agent records each answer verbatim as a line starting OWNER ANSWER catalog.test.ts:10, OWNER ANSWER evidence.test.ts:89 and OWNER ANSWER findings.test.ts:233. The blocker probe of TRDD-KNSQAQ1S looks for the three lines; the agent then clears that decision predicate by hand.
