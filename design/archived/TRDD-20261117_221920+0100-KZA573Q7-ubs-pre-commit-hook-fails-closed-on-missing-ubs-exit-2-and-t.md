---
trdd-id: KZA573Q7
title: ubs pre-commit hook fails closed on missing ubs, exit 2 and timeout
column: complete
status: archived
created: 2026-11-17T22:19:20+0100
updated: 2026-11-18T16:31:43+0100
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
implementation-commits: [0ff28ba9, 6d76419b, f58897e8]
---

# ubs pre-commit hook fails closed on missing ubs, exit 2 and timeout

USER 2026-11-17 verbatim: 'fix. and ubs hook must be stricter. update homebrew version too.' USER answer to 'How strict should the ubs pre-commit hook be when the scan cannot finish?': 'Block on all (Recommended)' = missing ubs, exit 2 and timeout all block the commit with the reason printed; timeout raised to 600 s; git commit --no-verify stays the only explicit bypass; call /opt/homebrew/bin/ubs by absolute path with a minimum version 5.5.26 so a GUI git client cannot pick the old ~/.local/bin copy (5.4.33). Warnings question and tap-reset question were not answered: keep blocking on criticals only (status quo), do not run brew update-reset. Scope: .githooks/pre-commit in this repo (tracked; identical copy in the main checkout). Activation gap: core.hooksPath in the shared .git/config points to the MAIN checkout's .githooks, which is on branch release/13.6.1, so a change committed here is not the active hook until the main checkout carries it; decide how. Out of scope until asked: the machine-wide ~/.config/git/hooks/pre-commit (also runs ubs, skips linked worktrees by owner directive). Done already: Homebrew is 7.0.14 = latest release; ubs brew formula upgraded 5.4.17 to 5.5.26; tap romankurnovskii/homebrew-awesome-brew stuck rebase aborted (still diverged 871/1105, needs brew update-reset, user approval pending).

## Approval log

- 2026-11-17T22:19:20+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-18T16:31:43+0100 — COMPLETE by main-agent@llm-externalizer-plugin. acceptance met; reviewed by the main agent under the USER delegation of 2026-11-18.

## Decisions

USER 2026-11-17, Q1 (hook strictness): Block on all (Recommended).
USER 2026-11-17, partial runs: first Let finished checks decide (Recommended), then reversed, verbatim: why partial runs? we cannot risk to commit bugged code. Final: partial runs block.
Unanswered 2026-11-17 (defaults kept): warnings do not block (critical only); docs-only commits pass; tap romankurnovskii/homebrew-awesome-brew not reset.
2026-11-18T10:11:09+0100 main agent: the awesome-brew update-reset item is moot: the romankurnovskii/awesome-brew and romankurnovskii/cask taps were removed on 2026-11-18 at 09:08 on USER order, after the BrewMate cask was uninstalled at 09:08:06.

## Evidence

Commits: 0ff28ba9 hook (dev/after-14.3.0), 6d76419b same hook cherry-picked onto release/13.6.1 in the main checkout (the copy core.hooksPath runs), f58897e8 README.
Throwaway-repo cases on the final hook: index.ts copy (partial) exit 1; same with UBS_ALLOW_PARTIAL=1 exported exit 1; clean py exit 0; UBS_BIN=/nonexistent exit 1; eval(input()) exit 1. Earlier draft cases: fake 5.5.25 exit 1, fake 5.10.0 and 6.0.0 exit 0, timeout exit 1 with no scanner left. Reports: reports_dev/kza573q7/.
Measured 2026-11-17, one run: ubs 5.5.26 on index.ts 26 s, 0 critical, exit 2 (taint_js work limit, fixed in ubs code taint_js.py max(500_000, 128 * len(code))).

## Known gaps

The active hook is the main checkout working-tree copy (core.hooksPath is an absolute path to it). If the main checkout switches to a branch without commit 6d76419b, every worktree silently runs the old fail-open hook or none.
ubs refreshes helper modules over the network at run time (checksum mismatch, fetch); behaviour offline is not verified.
Commits staging index.ts are blocked until TRDD-TYSKX72I; files with ubs criticals are tracked in TRDD-25KZDVYF.

## Notes

2026-11-18T15:52:35+0100 main agent ruling (delegated by USER 2026-11-18, "solve all issues yourself. i need results."; not an owner answer): Ruling: core.hooksPath stays an absolute path to the main checkout .githooks; the activation gap listed under Known gaps is accepted and recorded. Why: a relative path would run each worktree own .githooks/pre-commit, so a worktree on a branch without that file would run no hook at all (fail open); today every worktree runs the main checkout hook, and the main checkout branch carries the strict hook (6d76419b, byte-identical to 0ff28ba9, triage B3). Residual: if the main checkout switches to a branch without the hook, every worktree runs that branch hook. Checked 2026-11-18: git config core.hooksPath prints an absolute path ending in /.githooks.
2026-11-18T16:23:49+0100 main agent check: brew list --versions ubs prints 5.5.26; brew tap lists no awesome-brew tap; brew list --versions brewmate prints nothing.

## Acceptance

- [x] missing ubs, exit 2 and timeout all block the commit with the reason printed; git commit --no-verify stays the only explicit bypass: commit 0ff28ba9 (dev/after-14.3.0) and 6d76419b (release/13.6.1, the copy core.hooksPath runs), both exist; .githooks/pre-commit prints the bypass hint at line 33 and its header names --no-verify as the one explicit bypass (line 18)
- [x] timeout raised to 600 s: .githooks/pre-commit line 78, timeout_s="${UBS_PRECOMMIT_TIMEOUT:-600}"
- [x] ubs called by absolute path /opt/homebrew/bin/ubs with minimum version 5.5.26: .githooks/pre-commit lines 42-43 (ubs_bin default and ubs_min_version="5.5.26")
- [x] partial runs block (USER 2026-11-17 reversal, why partial runs? we cannot risk to commit bugged code): commit title of 0ff28ba9 and 6d76419b says partial runs included; throwaway-repo cases recorded on the card Evidence section, reports under reports_dev/kza573q7/ exist (block-partial-worker.md, strict-hook-worker.md, revised-hook-worker.md, wording-worker.md)
- [x] README describes the gate: commit f58897e8 (docs(readme): describe the fail-closed ubs pre-commit gate; fix the hooksPath sentence)
- [x] the hook active for every worktree is the strict one: git config core.hooksPath in the main checkout is the absolute path .../llm-externalizer/.githooks, and cmp of the main checkout .githooks/pre-commit against the dev/after-14.3.0 copy shows them identical; activation gap accepted as recorded (main agent ruling 2026-11-18T15:52:35, delegated by USER 2026-11-18; not an owner answer)
- [x] ubs brew formula upgraded 5.4.17 to 5.5.26 and awesome-brew tap reset item: the card says upgrade done 2026-11-17 and the tap item is moot (taps removed 2026-11-18 09:08 on USER order, note 2026-11-18T10:11:09); not re-verified this run (card text only)
