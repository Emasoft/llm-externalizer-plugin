---
trdd-id: VAA2MM9N
title: BR-21 CI install Playwright for browse tests
column: backburner
status: tasked
created: 2026-10-07T20:01:53+0200
updated: 2026-10-07T20:01:56+0200
current-owner: user
created-by: user
task-type: infra
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:01:53+0200
---

# BR-21 CI install Playwright for browse tests

## Goal

A CI workflow that installs Playwright so the browse tests run.

## Approval log

- 2026-10-07T20:01:53+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

§16 row BR-21 (workflow pinned per `github.md`), BR-20 (the tests it runs), §10 (Playwright optional: the product never requires it; only CI installs it).

## Depends on

BR-20 (TRDD-285ZM25J)

## Files

- a workflow file under .github/workflows/ (name to be listed at card start)

## Reuse

Read the existing workflows at card start; the github rule: look up the latest release of each action before writing it.

## Steps

1. Read existing workflows at card start (derived from done-when).
2. Write the workflow that installs Playwright for the browse tests and runs them (derived from done-when).
3. Apply the github rule: latest major, third-party actions pinned to a SHA, top-level permissions `{}` with per-job grants, job `timeout-minutes`.

## Acceptance

- [ ] workflow pinned per `github.md`
- [ ] definition of done for a workflow card: actionlint or zizmor clean; actions at their latest major, third-party actions pinned to a SHA (pinact); top-level permissions {} with per-job grants; job timeout-minutes set; one green CI run linked on the card; one commit with the TRDD id in its subject

## Out of scope

The tests themselves (BR-20).
