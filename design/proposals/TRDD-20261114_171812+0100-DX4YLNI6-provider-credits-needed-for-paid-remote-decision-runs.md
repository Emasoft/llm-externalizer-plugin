---
trdd-id: DX4YLNI6
title: Provider credits needed for paid remote decision runs
column: proposal
status: proposed
created: 2026-11-14T17:18:12+0100
updated: 2026-11-14T17:18:12+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: infra
min-approval-requirement: user
assignee: user
approved: false
---

# Provider credits needed for paid remote decision runs

USER action: fund the provider key the maintainer uses for paid live checks. A remote decision call with an unfunded key fails with HTTP 402 ("Insufficient credits"), and the run still exits 0 because the local decider answers instead. So a paid live check silently tests the local model. `classify ping` without --no_call shows the remote error; `classify ping --no_call` checks the key only, not the balance (TRDD-VUPK2NM7). The account details are kept out of this card on purpose.

Blocks: the remote rerun of TRDD-WYY3SPDX Acceptance box 2. Done when a `classify ping` without --no_call answers from the remote model. The agent checks that and closes this card: the user only needs to add credits, not touch the board. If the user decides not to fund it, the agent moves this card to cancelled. WYY3SPDX then unblocks and ships with the docs caveat from its release-hold note.

## Approval log
