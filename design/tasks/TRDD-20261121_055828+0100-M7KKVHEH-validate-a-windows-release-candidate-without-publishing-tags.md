---
trdd-id: M7KKVHEH
title: Validate a Windows release candidate without publishing tags
column: backburner
status: tasked
created: 2026-11-21T05:58:28+0100
updated: 2026-11-26T19:56:47+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: infra
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-21T05:58:28+0100
---

# Validate a Windows release candidate without publishing tags

## Evidence

GitHub has no Windows run for local candidate eda167386728f560fd934f00f902e0c3d4da70e6. The Windows workflow accepts manual dispatch but requires a GitHub ref. The pre-push hook requires the canonical publisher. Its only push path also sends release tags.

## Acceptance

Run Windows CI on a pinned candidate without publishing tags or changing main. Preserve the full publish validation gate and pre-push hook. Record the run URL, tested commit, result, and any differences from the release. Keep TRDD-VQ0VEK3L and TRDD-1Y9UK5MK open until verified on Windows.

## Approval log

- 2026-11-21T05:58:28+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Notes

2026-11-26T19:56:47+0100 USER kept 92076520 ("Keep it"). A rerun of --prepare without --patch stops with git-cliff found no bumpable commits (the version already moved); --prepare --patch made 0f1bc55d v14.7.10 and failed local validation on the broken Homebrew llama-server, so each failed prepare leaves one more unpushed release commit.
