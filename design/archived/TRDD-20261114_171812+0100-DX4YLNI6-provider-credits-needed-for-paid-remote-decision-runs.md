---
trdd-id: DX4YLNI6
title: Provider credits needed for paid remote decision runs
column: complete
status: archived
created: 2026-11-14T17:18:12+0100
updated: 2026-11-17T14:35:55+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: infra
min-approval-requirement: user
assignee: user
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-17T14:35:55+0100
---

# Provider credits needed for paid remote decision runs

USER action: fund the provider key the maintainer uses for paid live checks. A remote decision call with an unfunded key fails with HTTP 402 ("Insufficient credits"), and the run still exits 0 because the local decider answers instead. So a paid live check silently tests the local model. `classify ping` without --no_call shows the remote error; `classify ping --no_call` checks the key only, not the balance (TRDD-VUPK2NM7). The account details are kept out of this card on purpose.

Blocks: the remote rerun of TRDD-WYY3SPDX Acceptance box 2. Done when a `classify ping` without --no_call answers from the remote model. The agent checks that and closes this card: the user only needs to add credits, not touch the board. If the user decides not to fund it, the agent moves this card to cancelled. WYY3SPDX then unblocks and ships with the docs caveat from its release-hold note.

## Approval log
- 2026-11-17T14:35:44+0100: done-when met, checked by the agent as the card says. classify ping without --no_call answered from typesafe/jev-1.14-20261014 at 0.000012516 USD (RL-12 smoke, reports_dev/rl12-live-smoke/20261117-live-smoke.md:25), and classify requirements on the goal example answered from the same remote snapshot at 0.00004347 USD, cost_estimated false (reports_dev/s5koot2s/live-14.6.1.out.json). The key is funded.
- 2026-11-17T14:35:55+0100 — COMPLETE by main-agent@llm-externalizer-plugin. done-when met: remote classify ping and a remote decision call answered with billed cost on 2026-11-17.

## Acceptance checklist

- [x] a classify ping without --no_call answers from the remote model (2026-11-17: typesafe/jev-1.14-20261014, 0.000012516 USD billed)
