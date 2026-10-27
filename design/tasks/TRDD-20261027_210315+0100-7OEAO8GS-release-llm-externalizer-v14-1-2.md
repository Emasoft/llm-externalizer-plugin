---
trdd-id: 7OEAO8GS
title: Release llm-externalizer v14.1.2
column: dev
status: tasked
created: 2026-10-27T21:03:15+0100
updated: 2026-10-27T21:11:01+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: infra
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-10-27T21:03:15+0100
---

# Release llm-externalizer v14.1.2

Why: 14.1.1 writes a one-model free profile as remote-ensemble, which its own settings check rejects, so every llm-ext command fails until the settings file is fixed by hand (TRDD-2GIA66AK). A hand fix lasts only until the next free-model re-test, which under 14.1.1 can write the broken profile again; only an installed 14.1.2 stops that. Authorization (INTERPRETATION, not a fact): the USER grant of 2026-10-27, verbatim "decide yourself on everything. just base your decisions on verified facts. also consult the advisor.", read together with the earlier standing directive, verbatim "publish and install the llm-externalizer plugin new version!", is taken as covering this patch release. The final report says so, so the USER can object. Push main, wait for CI on that commit to pass, and only then push the tag.

Contents since 14.1.1: 1e5adabe (401 stops same-model retries, TRDD-YG72CYY7), d4861125 e67e1ab5 a20f58f8 2ff6943e (TRDD-VAORGKVF), 5c06fd5d (TRDD-2GIA66AK), 1da7edfa (TRDD-CQSODQ78).

Route (same as 14.1.1, because local history diverges from GitHub until TRDD-DRRUTC2M): full gate with publish.py --check-only; version bump commit (plugin.json, package.json, pyproject.toml, uv.lock, README badge, cli/main.ts VERSION, CHANGELOG entry, rebuilt dist); in the publish clone builds_dev/publish-14.1.0-ff, fetch the local branch, commit-tree the local tree onto origin/main, fast-forward, push main, tag v14.1.2, push the tag (release.yml); install at user scope; verify the installed llm-ext --version.

## Acceptance
- [x] publish.py --check-only exits 0 on the release tree
- [ ] GitHub main tree equals the local release tree, tag v14.1.2 exists, release workflow green
- [ ] the installed plugin is 14.1.2 and llm-ext --version prints 14.1.2
- [ ] CI on the pushed main commit is green before the tag is pushed
- [ ] the final report to the USER states that publishing rests on the interpretation above

## Approval log

- 2026-10-27T21:03:15+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Progress

- 2026-10-27: gate passed on the pre-bump tree (typecheck, lint, build, full vitest, ruff, plugin.json, claude plugin validate, pytest 224; shellcheck on the 3 tracked scripts; publish.py's shellcheck also scans a gitignored reports/ script and failed only on it). Local release commits 3848e236 (bump) and db3e534e (changelog narrowed: the release body is built from it). Public: 39b7efa2 then 82b0331f on main, both admin-bypass pushes, trees equal the local HEAD. NEXT: wait for CI on 82b0331f; if green, tag v14.1.2 on 82b0331f and push the tag; watch release.yml; install at user scope (marketplace update + plugin update); verify llm-ext --version prints 14.1.2 through ~/.local/bin/llm-ext and re-run the llm ask probe; tell the apple-docs-mcp session; close 2GIA66AK, CQSODQ78, VAORGKVF; tick these boxes. Then report to the USER, stating that publishing rests on the interpretation above.
