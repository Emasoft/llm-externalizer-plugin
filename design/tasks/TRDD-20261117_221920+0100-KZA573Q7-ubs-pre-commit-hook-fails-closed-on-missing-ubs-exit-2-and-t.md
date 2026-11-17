---
trdd-id: KZA573Q7
title: ubs pre-commit hook fails closed on missing ubs, exit 2 and timeout
column: backburner
status: tasked
created: 2026-11-17T22:19:20+0100
updated: 2026-11-17T22:19:20+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: infra
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-17T22:19:20+0100
---

# ubs pre-commit hook fails closed on missing ubs, exit 2 and timeout

USER 2026-11-17 verbatim: 'fix. and ubs hook must be stricter. update homebrew version too.' USER answer to 'How strict should the ubs pre-commit hook be when the scan cannot finish?': 'Block on all (Recommended)' = missing ubs, exit 2 and timeout all block the commit with the reason printed; timeout raised to 600 s; git commit --no-verify stays the only explicit bypass; call /opt/homebrew/bin/ubs by absolute path with a minimum version 5.5.26 so a GUI git client cannot pick the old ~/.local/bin copy (5.4.33). Warnings question and tap-reset question were not answered: keep blocking on criticals only (status quo), do not run brew update-reset. Scope: .githooks/pre-commit in this repo (tracked; identical copy in the main checkout). Activation gap: core.hooksPath in the shared .git/config points to the MAIN checkout's .githooks, which is on branch release/13.6.1, so a change committed here is not the active hook until the main checkout carries it; decide how. Out of scope until asked: the machine-wide ~/.config/git/hooks/pre-commit (also runs ubs, skips linked worktrees by owner directive). Done already: Homebrew is 7.0.14 = latest release; ubs brew formula upgraded 5.4.17 to 5.5.26; tap romankurnovskii/homebrew-awesome-brew stuck rebase aborted (still diverged 871/1105, needs brew update-reset, user approval pending).

## Approval log

- 2026-11-17T22:19:20+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
