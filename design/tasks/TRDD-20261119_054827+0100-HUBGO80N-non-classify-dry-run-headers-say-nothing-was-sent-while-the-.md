---
trdd-id: HUBGO80N
title: Non-classify dry-run headers say nothing was sent while the dry run may fetch pricing
column: dev
status: tasked
created: 2026-11-19T05:48:27+0100
updated: 2026-11-19T06:25:54+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-19T05:48:27+0100
implementation-commits: [4b9e2e48]
---

# Non-classify dry-run headers say nothing was sent while the dry run may fetch pricing

Found while landing TRDD-Z8LRK2DZ (16426995, main agent 2026-11-19). Two dry-run headers outside classify still print "nothing was sent": estimate.ts:484 "ESTIMATE (dry-run — nothing was sent) — <tool>" and cli/main.ts:977 "PREVIEW (dry-run — nothing was sent) — <tool>". The --estimate branch of cli/main.ts awaits warmEstimatePricing() before it prints the estimate, so that header may claim no network while a pricing fetch runs; the --preview path is not checked. Before rewording, measure on the built CLI which of the two fetches anything (temp HOME and LLM_EXT_CONFIG_DIR, LLM_EXT_INSTALL_RULE=0, HTTPS_PROXY pointed at a closed port, a free or local profile, never a paid one), then say exactly what is not sent (no model request), and update the tests that assert the header and the docs that quote it (grep "nothing was sent" over skills/ and README.md). Related: TRDD-Z8LRK2DZ. Size S.

## Approval log

- 2026-11-19T05:48:27+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-19T06:25:54+0100 — column → dev. landed in 4b9e2e48 (main agent)

## Notes

2026-11-19T06:25:52+0100 main agent: done in 4b9e2e48. Main agent ruling (delegated by USER 2026-11-18, "solve all issues yourself. i need results."; not an owner answer): the --estimate header is now "ESTIMATE (dry-run — no prompt was sent)", because warmEstimatePricing() runs before it and sends GET <profile url>/v1/models with the profile's Authorization header on every run (fetchOpenRouterModels in index.ts caches in memory only; read by the main agent). Measured by a worker with a fetch hook on a local-mode profile (report reports_dev/hubgo80n/20261119_061906+0100-dry-run-network.md): 4 of 16 estimate runs reached the header (the built-in free and local profiles refuse at the gate on a fresh config, a keyless remote profile fails at setup), each of those 4 attempted the GET; remote profiles not measured. The --preview header stays "nothing was sent": no request in any of 16 runs on keyless and local profiles, and its branch only resolves files; a keyed remote preview was not run. v14.3.0 and v14.7.4 print the old header and fetch first (main agent). estimate.test.ts pins the new header and the absence of the old text (worker 23/23); cli-conventions.md:29 gets one bullet; dist rebuilt and holds the new header (main agent grep); tsc and lint exit 0 (main agent); UBS critical 0, the same 2 warnings on unchanged lines main.ts:205 and :857. Disclosure: the measurement worker deleted its own untracked summary-*.txt scratch files in reports_dev/hubgo80n. Open: "the release after 14.7.4" in cli-conventions.md:29 is rewritten at publish.
