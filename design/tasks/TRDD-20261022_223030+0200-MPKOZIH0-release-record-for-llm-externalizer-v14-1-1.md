---
trdd-id: MPKOZIH0
title: Release record for llm-externalizer v14.1.1
column: publish
status: tasked
created: 2026-10-22T22:30:30+0200
updated: 2026-10-22T22:30:31+0200
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: infra
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-10-22T22:30:30+0200
implementation-commits: [4b36c0c4, 0e5fc3e9]
release-via: publish
---

# Release record for llm-externalizer v14.1.1

Record of what shipped as v14.1.1 on 2026-10-22, so a commit id leads back to a card. Changes: Linux CI temp-dir fix (tests created config dirs under the macOS-only /private/tmp), a test proving the statusline writes its debug log only when CLAUDE_STATUSLINE_DEBUG is set, a redacted owner-login variant in a card, and a corrected changelog pointer. Public commits on main: squash 4b36c0c4, release 0e5fc3e9 (tags v14.1.1 and llm-externalizer--v14.1.1). Local working-history commits (this machine only, not on GitHub): 08585fab, a9bb8903, 5f05efe0, 2a34fffa. Post-push runs on 0e5fc3e9 all green: CI 39757155664, Release 39757155492, Notify Marketplace 39757155635. The planned rewrite of the public history will replace the two public ids; this card stays open until they are remapped.

## Approval log

- 2026-10-22T22:30:30+0200 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Acceptance

- [x] the release is on GitHub (tag v14.1.1, release workflow run 39757155492 green)
- [ ] implementation-commits holds the post-rewrite ids of the squash and release commits (or the public rewrite was dropped and the ids above are final)
