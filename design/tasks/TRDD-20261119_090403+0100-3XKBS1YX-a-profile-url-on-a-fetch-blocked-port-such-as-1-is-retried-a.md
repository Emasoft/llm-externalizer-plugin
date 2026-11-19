---
trdd-id: 3XKBS1YX
title: A profile url on a fetch-blocked port such as 1 is retried as four full ladders and reports only fetch failed
column: backburner
status: tasked
created: 2026-11-19T09:04:03+0100
updated: 2026-11-19T09:10:03+0100
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
---

# A profile url on a fetch-blocked port such as 1 is retried as four full ladders and reports only fetch failed

Found by the TRDD-CBOTP0DY timing measurement (report reports_dev/cbotp0dy-timing/20261119_085633+0100-refused-connection-timing.md). Node fetch refuses ports on the WHATWG bad-ports list (1, 6000, 6665-6669, 10080 and others) with TypeError fetch failed whose cause is Error bad port with no code (bare-fetch repro on node v26.12.1; the cause inside the CLI is inferred, not captured). provider/http.ts classifyFailure returns no verdict for a code-less error (about line 901), so the call runs the generic backoff ladder, and completion.ts runs that ladder 4 times (MAX_TRUNCATION_RETRIES=3, about lines 1400 and 1757-1790): about 13 s, then 'the models in the selected profile are all failing'. Fix: classify a bad-port rejection as a final stop with a message that names the url and the port, with a test. The index.test.ts unreachable-backend tests use 127.0.0.1:1 and so take this path; move them to a closed ephemeral port so they exercise ECONNREFUSED (TRDD-CBOTP0DY). Size S.

## Approval log

- 2026-11-19T09:04:03+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Notes

2026-11-19T09:10:02+0100 main agent: provenance of the body: the port list (1, 6000, 6665-6669, 10080) is quoted from the WHATWG Fetch bad-ports list, not read in this session; 'bad port' with no code was captured on a bare fetch on node v26.12.1 only, and node 24 (the CI version, ci.yml and windows.yml) is unchecked; key the fix on the behaviour of every node version in engines (>=20.3.0) and CI. Impact to check first: about 25 test files use 127.0.0.1:1, among them network-give-up.test.ts and network-give-up-dispatch.test.ts, which may rely on port 1 failing as a network error.
