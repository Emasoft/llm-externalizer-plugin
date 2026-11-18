---
trdd-id: ZTO9K8EK
title: Machine-wide governor caps RAM and CPU use of local inference
column: complete
status: tasked
created: 2026-10-31T03:23:49+0100
updated: 2026-11-18T13:01:44+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-10-31T03:23:49+0100
implementation-commits: [5a1658b5]
release-via: publish
---

# Machine-wide governor caps RAM and CPU use of local inference

## Approval log

- 2026-10-31T03:23:49+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-16T20:16:02+0100 — column → human_review by main-agent@llm-externalizer-plugin. shipped in v14.3.0; governor-burn stage green in the v14.4.0 publish (12 passed); the card's Open questions for the USER remain
- 2026-11-18T13:01:44+0100 — column → complete by main-agent@llm-externalizer-plugin. code committed and verified on the exported commit (tsc and card tests); ships in 14.7.2; approved by the main agent under the USER delegation of 2026-11-18

## USER goal

Verbatim: "implementing a self regulating safeguard that will enforce limits to both ram and cpu core percentage of use, ensuring that even if a hundred different llm-ext cli proceses are executed at the same time, the amount of concurrent local inferences actually running will be modulated in realtime so they will never cause the sytem to surpass those limits."

## Design

Spec: design/specs/local-inference-governor-design.md (decisions D1 to D14, test table, units, open questions). Rationale: every local inference and model load that llm-ext starts takes a lease from one per-uid chokepoint first, so brokers of different config dirs share one set of limits.

## Units

1. Governor core: src/governor/ (metrics, state, controller, client) and the hermetic test setting. Check: src/governor/governor.test.ts.
2. Broker dispatch gating and rotation under denial: broker/server.ts, broker/scheduler.ts. Check: broker.test.ts, broker-governor.test.ts.
3. Direct path and calibration senders, with the wait kept out of the retry clock. Check: governor-direct.test.ts, provider/retry-clock.test.ts, calibration.test.ts.
4. Model load: load lease and projection at both spawn sites, load watchdog, giving RAM back, Locals --cache-gb. Check: governor-load.test.ts, broker.test.ts.
5. Thread budget: -t and -tb, sum across servers, measurements of real thread use. Check: governor-threads.test.ts, broker/server-commands.test.ts.
6. Settings, removal of LLM_EXT_BROKER_MEMORY_FLOOR, status, docs, third sequential test step, N-process burn test (TRDD-CBOTP0DY stability rules). Check: governor-burn.test.ts, then the full npm test.

## Open questions for the USER

Default CPU limit; RAM waits bounded only by --command_timeout; the one-inference CPU floor while over the limit; whether the thread count belongs in a calibration record identity. Details in the spec, section 5.

## Cross-session notes

2026-11-04, from the session closing TRDD-O4MSZIG5: commit 9d902ace changed governor-load.test.ts round 4 #7 so that when real RAM use is under 55 % the test skips (its note carries the live reading) instead of throwing; the unload-under-RAM-pressure behaviour is therefore tested only when the host is at or over 55 % used. The controller decides on the same reader the test checks (readMemory in governor/metrics.ts, sampled by startSampling in governor/client.ts at most once per second), so the two agree up to sampling lag. No other governor test silently needs a busy host, but the comment near governor-load.test.ts line 917 still claims the reading sits at 78 to 85 %. Deterministic coverage needs a controlled memory reading, see TRDD-BH1XNP06.
2026-11-04, addendum: a standalone rerun after that day's gate run skipped round 4 #7 at 54.8 % used (the gate run's phase 2 reporter named none of its 3 skips). TRDD-BH1XNP06 is not yet committed (the governor session's own card). The controller and reader facts above come from a read-only trace whose evidence is not committed.

## STATE
NEXT ACTION: run governor-burn.test.ts (CPU-intensive, deferred until host load drops below ~30 on 14 cores). Then full npm test.
D13 committed (d0d7765e): settings migration, unified memory floor, burn test file, docs. Gates green: tsc clean, 453 tests passed (governor+threads+config+broker), UBS bash clean. Burn test NOT yet run — host load 63 on 14 cores.
GOTCHA: stat-stamp cache in settings.ts now includes file mode (chmod fix for EACCES no longer stuck on cached error — review finding 2, fixed in follow-up commit).
implementation-commits: d0d7765e (D13 body), 4eaedcf5 (PRRD+BH1XNP06 card), bc4c02f9 (classifier comments).
implementation-commits: d0d7765e (D13 body), 4eaedcf5 (PRRD+BH1XNP06 card), bc4c02f9 (classifier comments), f6a5ffe4 (stat-stamp mode fix + card to testing).

## STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-11-11T00:15:00+0100

## Notes

2026-11-14T16:20+0100 from the review of TRDD-SWNIIFTF (archived, box (c) closed in 164fa021 on a held governor lease with max inferences 1): read by the main agent, the governor's decide() refuses for RAM at governor/controller.ts:357, :384 and :388 and for the inference window at :392-396; client.ts:275-279 treats every refusal the same (lease null, the caller keeps waiting), and a RAM refusal for a load also calls giveRamBack (client.ts:273). So a RAM wait takes the same waiter path as the tested window wait (read, not run: no test forces the RAM gate under --stop_on_errors). Not tested either: a governor acquire timeout under --stop_on_errors, which direct.ts:58 rethrows as local inference governor ... failed, request not sent; whether the stop-on-errors classifier counts that as a dead model is untraced. The 164fa021 fail-before injected stopCommand directly and bypassed that classifier.
2026-11-14T16:21+0100 correction to the previous note (review of 81cea4ee): a RAM refusal that can fit later returns no lease, like the window refusal (client.ts:275-279); the loop that then keeps waiting was not read, so keeps waiting is inferred. Not every memory shortfall is a wait: a model load whose lower bound (weights plus headroom) exceeds the whole RAM limit even alone is an immediate error (neverFits, controller.ts:232-234; thrown at broker/server.ts:1130-1132 and calibration/runner.ts:241 with neverFitsMessage). A load whose upper bound alone does not fit runs only alone and otherwise waits (controller.ts:375-386). Whether --stop_on_errors fires on the neverFits error is untested, and whether a model too large for the machine counts as not enough memory under the 2026-10-28 ruling is a user question (asked on DS6OM3KX).
2026-11-14T20:40:23+0100 Defaults 80/80 landed 51cbf755 (code, help, README, skill reference, spec, tests).

## Progress

2026-11-18T12:50:05+0100 main agent (written by worker): commit 5a1658b5 (CPU floor removed; a brokered CLI prints the governor wait reason). Committed-tree check of 5a1658b5 (export of the commit, node_modules linked): tsc exit 0; governor.test.ts 125 passed 1 skipped (most likely governor.test.ts:339, a Linux-only test run with it.runIf on linux, skipped on this darwin host; the run output does not name the skipped test); broker-governor.test.ts 17 passed; governor-load.test.ts failed 1 of 52 (the real-RAM reload-pause test, spawn count 2 instead of 1) in a run at host load average about 100, then passed 52 of 52 when rerun alone at load about 20; governor-burn.test.ts 12 passed on the working tree right before the commit. ubs gate: a rule-scoped ubs:ignore above the const SERVER template statement of governor-burn.test.ts covers its whole child script (lines 56-80). Spec D6 text still describes the floor (TRDD-ZZ2TKYCP). Ships in 14.7.2.
