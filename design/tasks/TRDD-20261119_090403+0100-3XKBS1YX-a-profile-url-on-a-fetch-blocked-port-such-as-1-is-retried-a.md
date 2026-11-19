---
trdd-id: 3XKBS1YX
title: A profile url on a fetch-blocked port such as 1 is retried as four full ladders and reports only fetch failed
column: complete
status: tasked
created: 2026-11-19T09:04:03+0100
updated: 2026-11-19T09:51:47+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-19T09:04:03+0100
implementation-commits: [354a9bbf]
release-via: publish
---

# A profile url on a fetch-blocked port such as 1 is retried as four full ladders and reports only fetch failed

Found by the TRDD-CBOTP0DY timing measurement (report reports_dev/cbotp0dy-timing/20261119_085633+0100-refused-connection-timing.md). Node fetch refuses ports on the WHATWG bad-ports list (1, 6000, 6665-6669, 10080 and others) with TypeError fetch failed whose cause is Error bad port with no code (bare-fetch repro on node v26.12.1; the cause inside the CLI is inferred, not captured). provider/http.ts classifyFailure returns no verdict for a code-less error (about line 901), so the call runs the generic backoff ladder, and completion.ts runs that ladder 4 times (MAX_TRUNCATION_RETRIES=3, about lines 1400 and 1757-1790): about 13 s, then 'the models in the selected profile are all failing'. Fix: classify a bad-port rejection as a final stop with a message that names the url and the port, with a test. The index.test.ts unreachable-backend tests use 127.0.0.1:1 and so take this path; move them to a closed ephemeral port so they exercise ECONNREFUSED (TRDD-CBOTP0DY). Size S.

## Approval log

- 2026-11-19T09:04:03+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-19T09:51:47+0100 — column → complete by main-agent@llm-externalizer-plugin. fix in 354a9bbf; published with the next release

## Notes

2026-11-19T09:10:02+0100 main agent: provenance of the body: the port list (1, 6000, 6665-6669, 10080) is quoted from the WHATWG Fetch bad-ports list, not read in this session; 'bad port' with no code was captured on a bare fetch on node v26.12.1 only, and node 24 (the CI version, ci.yml and windows.yml) is unchecked; key the fix on the behaviour of every node version in engines (>=20.3.0) and CI. Impact to check first: about 25 test files use 127.0.0.1:1, among them network-give-up.test.ts and network-give-up-dispatch.test.ts, which may rely on port 1 failing as a network error.
2026-11-19T09:51:46+0100 main agent: fix in 354a9bbf (main agent checks: classify-failure.test.ts 28 of 28, tsc and strict lint exit 0). About a dozen tests still use 127.0.0.1:1 as an unreachable backend and now take the stop path; port 1 never gave ECONNREFUSED, so they never covered the refused path; follow-up card IQQQC98L.

## Acceptance

- [x] A fetch bad-port rejection gives a stop verdict at the first failure, with a hint naming host and port (354a9bbf; classify-failure.test.ts verdict-table case)
- [x] The stop also ends the outer completion.ts retry loop: chatCompletionWithRetry to 127.0.0.1:1 fails inside 5 s (test in 354a9bbf; completion.ts:1761 read by the main agent); by the worker report both real-fetch tests fail with the new branch disabled
- [~] The rejection shape was measured on node 20.5.1, 22.23.4 and 26.12.1 (worker); node 24, the CI version, is not installed here, so the CI run of the next release is the first node 24 check of the two real-fetch tests
- [x] The index.test.ts unreachable-backend tests no longer use port 1: the shared LOCAL_TEST_URL moved to refused port 29871 in a249ab64 (TRDD-CBOTP0DY); the other tests still on port 1 moved to their own card (see Notes)
