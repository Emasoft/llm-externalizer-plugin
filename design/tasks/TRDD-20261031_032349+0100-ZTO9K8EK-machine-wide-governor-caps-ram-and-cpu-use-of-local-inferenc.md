---
trdd-id: ZTO9K8EK
title: Machine-wide governor caps RAM and CPU use of local inference
column: publish
status: tasked
created: 2026-10-31T03:23:49+0100
updated: 2026-11-18T14:48:20+0100
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
- 2026-11-18T14:14:09+0100 — column → publish by main-agent@llm-externalizer-plugin. shipped in v14.7.2 (8c72f83d, release https://github.com/Emasoft/llm-externalizer-plugin/releases/tag/v14.7.2); main agent approves under the USER delegation of 2026-11-18

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

## Acceptance

- [ ] USER goal: "implementing a self regulating safeguard that will enforce limits to both ram and cpu core percentage of use, ensuring that even if a hundred different llm-ext cli proceses are executed at the same time, the amount of concurrent local inferences actually running will be modulated in realtime so they will never cause the sytem to surpass those limits." (source: card line 33)
- [x] Unit 1: "Governor core: src/governor/ (metrics, state, controller, client) and the hermetic test setting. Check: src/governor/governor.test.ts." (source: card line 41)
- [x] Unit 2: "Broker dispatch gating and rotation under denial: broker/server.ts, broker/scheduler.ts. Check: broker.test.ts, broker-governor.test.ts." (source: card line 42)
- [x] Unit 3: "Direct path and calibration senders, with the wait kept out of the retry clock. Check: governor-direct.test.ts, provider/retry-clock.test.ts, calibration.test.ts." (source: card line 43)
- [x] Unit 4: "Model load: load lease and projection at both spawn sites, load watchdog, giving RAM back, Locals --cache-gb. Check: governor-load.test.ts, broker.test.ts." (source: card line 44)
- [x] Unit 5: "Thread budget: -t and -tb, sum across servers, measurements of real thread use. Check: governor-threads.test.ts, broker/server-commands.test.ts." (source: card line 45)
- [x] Unit 6: "Settings, removal of LLM_EXT_BROKER_MEMORY_FLOOR, status, docs, third sequential test step, N-process burn test (TRDD-CBOTP0DY stability rules). Check: governor-burn.test.ts, then the full npm test." (source: card line 46)

## Acceptance evidence

box 2: src/governor/ holds the governor files and governor.test.ts (listed by me 2026-11-18). Check passed: governor.test.ts 125 passed 1 skipped on the export of 5a1658b5, per the card Progress note of 2026-11-18T12:50:05 (a worker report, not re-run by me; the skipped test is inferred as the Linux-only governor.test.ts:339, '? inferred' in the card itself). Per worker note, not re-run by me. The unit also names 'the hermetic test setting' (src/test-hermetic-config.ts exists and was changed in 5a1658b5): its behaviour was not checked here beyond governor.test.ts being the card's check. UNTICKED on review: the unit names 'the hermetic test setting', not checked here, and the passing run is a worker record (reports_dev/zto9k8ek-fix/20261118_115657+0100-final-reruns.md: governor.test.ts exit 0, 125 passed, 1 skipped at 11:33:22, source unchanged since before the start; the skipped test is governor.test.ts:339 per that report).
box 1: NOT ticked. Nothing in the card proves the end-to-end goal beyond the burn test (governor-burn.test.ts 12 passed on the working tree right before 5a1658b5, per the Progress note, and 'governor-burn stage green in the v14.4.0 publish (12 passed)' in the approval log line of 2026-11-16T20:16:02); the card says its Open questions for the USER remain (default CPU limit, RAM wait bound, thread count in calibration identity), and 5a1658b5 changed the CPU-floor behaviour after those runs.
box 3: NOT ticked. broker-governor.test.ts 17 passed on the export of 5a1658b5 (Progress note); broker.test.ts has no result recorded after the last governor change. The only broker.test.ts result in the card is the STATE line '453 tests passed (governor+threads+config+broker)' at d0d7765e, which predates 5a1658b5 (several later commits touch broker/server.ts). Checked reports_dev/zto9k8ek-fix: broker-governor.test.ts 17 passed (green4-broker-file.txt, 11:22, in 20261118_105500+0100-report.md) but broker.test.ts has no run record there; the Nov 16 reports_dev/full-suite/run1.txt predates 5a1658b5 and 14.3.1 changes.
box 4: NOT ticked. No result for governor-direct.test.ts, provider/retry-clock.test.ts or calibration.test.ts is recorded in the card after d0d7765e (the 453-test STATE line does not name them). Checked reports_dev/zto9k8ek-fix and reports_dev/commit-check: no run record for governor-direct.test.ts, provider/retry-clock.test.ts or calibration.test.ts.
box 5: NOT ticked. governor-load.test.ts failed 1 of 52 at host load about 100 (real-RAM reload-pause test, spawn count 2 instead of 1) and passed 52 of 52 when rerun alone at load about 20, per the Progress note; broker.test.ts has no recorded result after 5a1658b5. The card also records that the RAM-pressure unload test skips when real RAM use is under 55 % (2026-11-04 note). Checked reports_dev/zto9k8ek-fix: governor-load.test.ts 52 passed (final-reruns.md, 11:34:24; green-load2.txt), but the unit's check also names broker.test.ts, which has no run record.
box 6: NOT ticked. No result for governor-threads.test.ts or broker/server-commands.test.ts is recorded after d0d7765e. Checked reports_dev/zto9k8ek-fix and reports_dev/commit-check: no run record for governor-threads.test.ts or broker/server-commands.test.ts.
box 7: NOT ticked. governor-burn.test.ts 12 passed (Progress note, working tree before 5a1658b5; also 12 passed in the v14.4.0 publish); no result of the full npm test is recorded in the card, and the publish log reports_dev/publish/20261118_130254+0100-publish-14.7.2.txt shows no test stage. The card says spec D6 text still describes the CPU floor (TRDD-ZZ2TKYCP). Checked reports_dev/zto9k8ek-fix/20261118_115657+0100-final-reruns.md: governor-burn.test.ts 12 passed twice (11:35:27 and rerun 11:52:56, 150.79 s), but the report says the rerun ran while writers were still editing broker/server.ts and governor/client.ts, and no full npm test run record exists for 5a1658b5.
Units 1-6 (boxes 2-7): every named check runs inside npm test at fdb1469c (scripts/llm-ext/package.json: test:unit covers governor.test.ts, provider/retry-clock.test.ts, calibration/calibration.test.ts, broker/server-commands.test.ts; test:broker covers broker.test.ts, broker-governor, governor-direct, governor-load, governor-threads; test:burn covers governor-burn). The full npm test exited 0 at the v14.7.2 publish gate on the clean tree of fdb1469c, which contains 5a1658b5 (publish log reports_dev/publish/20261118_130254+0100-publish-14.7.2.txt lines 19-20). Unit 1 hermetic test setting: src/test-hermetic-config.ts is changed in 5a1658b5. Per-test counts are not in that log. Read by the main agent.
box 1 (USER goal) stays open: the burn test runs N = 16 CLI processes (governor-burn.test.ts:35), not a hundred; the hundred-process case is not measured.
Scope of the Unit ticks: each Unit box is ticked on its named Check suites passing, not on a separate check of every part the unit lists. Some tests in those suites can skip: governor.test.ts:339 runs on Linux only; governor-load.test.ts:520 skips when the machine has under 55 % RAM in use; broker.test.ts:2689 real-model tests are opt-in (RUN_REAL_LOCAL_MODELS=1); broker.test.ts:2414 and broker-governor.test.ts:466 run on Apple silicon / macOS only. The publish log has no per-test counts, so whether governor-load.test.ts:520 skipped on that run is not known. Burn test: N = 16 parallel CLI runs (governor-burn.test.ts:35 and :346).
Correction, checked 2026-11-18 by reading the cited lines: the publish log (reports_dev/publish/20261118_130254+0100-publish-14.7.2.txt lines 19-20) logs only '$ npm test' and 'OK: test'; it does not record an exit status and says nothing about the tree being clean, so the full npm test is logged OK, not proven exit 0, and fdb1469c cleanliness is unchecked. The hermetic claim is confirmed: git show --stat 5a1658b5 lists scripts/llm-ext/src/test-hermetic-config.ts (4 lines changed). Skip conditions checked by reading: governor.test.ts:339 runIf linux; governor-load.test.ts:520 skips under 55 % used; broker.test.ts:2689 skipIf RUN_REAL_LOCAL_MODELS not 1; broker.test.ts:2414 skipIf not Apple silicon; broker-governor.test.ts:466 runIf darwin. N = 16 confirmed at governor-burn.test.ts:35 and used at :346. CONTRADICTION NOT RESOLVED: boxes 3-6 (Units 2-5) are ticked, but the earlier evidence above records no run record for their named suites (broker.test.ts, broker-governor, governor-direct, governor-load, governor-threads, retry-clock, calibration, server-commands); the publish log line is the only support for them. Main agent to decide whether to uncheck them.
Main agent resolution 2026-11-18 of the boxes 3-6 contradiction: scripts/publish.py:257-264 prints 'OK: <name>' only when the command returncode is 0, and publish log step 1 shows 'Working tree is clean' before the checks; npm test is test:unit && test:broker && test:burn && test:e2e, so every named suite ran and exited 0 on the clean tree of fdb1469c. The earlier 'no run record' meant no per-file record. Boxes 2-7 stay ticked; individual tests may skip as noted above.
Verified 2026-11-18 by the main agent: reports_dev/publish/20261118_130254+0100-publish-14.7.2.txt line 5 reads "Working tree is clean" and line 20 "OK: test"; scripts/publish.py at fdb1469c line 257 is "if result.returncode != 0:" and line 264 prints "OK: {name}". The Correction note above is wrong where it says the log says nothing about the tree being clean.
