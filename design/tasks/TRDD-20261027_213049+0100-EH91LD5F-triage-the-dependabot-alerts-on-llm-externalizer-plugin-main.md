---
trdd-id: EH91LD5F
title: Triage the Dependabot alerts on llm-externalizer-plugin main
column: human_review
status: tasked
created: 2026-10-27T21:30:49+0100
updated: 2026-11-14T19:11:41+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: security
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-10-27T21:30:49+0100
implementation-commits: [2e18ac01]
---

# Triage the Dependabot alerts on llm-externalizer-plugin main

On 2026-10-27, git push to main printed: GitHub found 84 vulnerabilities on the default branch (2 critical, 23 high, 54 moderate, 5 low), https://github.com/Emasoft/llm-externalizer-plugin/security/dependabot. A dependabot/npm_and_yarn/mcp-server/npm_and_yarn branch is open on the remote. Counts are a snapshot from that push message; re-read them with gh api repos/Emasoft/llm-externalizer-plugin/dependabot/alerts before acting.

## Acceptance
- [x] each critical and high alert is fixed, or recorded with why the vulnerable code is not reachable
- [ ] the open dependabot branch is merged or closed with a reason

## Approval log

- 2026-10-27T21:30:49+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-14T19:11:41+0100 — column → human_review by main-agent@llm-externalizer-plugin. box 1 done (2e18ac01); box 2 needs the USER to close Dependabot PR #2, an outward-facing act

## Notes

2026-11-14T19:10:38+0100: open alerts re-read with gh api on main: 3 critical, 10 high, 23 medium, 7 low. Of the 13 critical and high: zod is already fixed on release/13.6.1 (4.6.7). The two mcp-server alerts (136, 137) concern a directory this branch removed; they close when the branch reaches main. Ten were fixed with minimal lockfile bumps in 2e18ac01 (postcss, source-map-js, brace-expansion, certifi, anyio, sentence-transformers, fsspec, transformers, filelock; filelock is a resolver-accepted 3 to 4 major, runtime untested). vite (118) is left as is: GHSA-587h-7wmj-h5pm is a Windows-only launch-editor flaw in vite's dev server, which this project never starts. That rests on the alert summary, not the full advisory body. No documented install path reads uv.lock's embeddings entries. Report: reports_dev/eh91ld5f/20261114_190826+0100-lock-bumps.md (Round 2).
Open: the Dependabot PR #2 (mcp-server flatted bump) is to be closed with the reason that mcp-server/ is removed on the release branch. Closing it is outward-facing, so it waits for the USER. The alerts on main close only when this branch is merged to main, and alert 118 should be dismissed on GitHub as not used. Both are user actions.
2026-11-14T19:11:39+0100: review of 2e18ac01. (a) The full advisory GHSA-587h-7wmj-h5pm (gh api /advisories) names the affected code as launch-editor, reached through launch-editor-middleware, the dev server's open-in-editor route. Its Impact section says 'Only apps that runs on Windows is affected'. Patched vite versions: 8.1.6, 8.2.4, 8.3.3. This project never starts a vite dev server, has no @vitest/ui and no browser mode, and does not ship vite. (b) The new dev versions in the npm lock (postcss 8.5.33, source-map-js 1.2.2, brace-expansion 5.0.13, nanoid 3.3.20) have not run locally: node_modules still holds the old ones. The first real run is the next CI run or a fresh npm ci; npm rebuild alone does not pick them up. Owed check: watch that CI run. (c) The uv collateral movers also include click 8.5.1, hf-xet 1.8.0, safetensors 0.8.0 and tokenizers 0.23.3; none is installed by a documented path. (d) The Python lock entries were fixed rather than recorded as unreachable, to keep the lock coherent for anyone who runs uv sync --all-extras. (e) Medium and low alerts are out of this card's scope. The npm side is owned by TRDD-0ETFCKCU. The Python medium and low alerts (uv.lock) have no card; they are recorded here for the next triage.
