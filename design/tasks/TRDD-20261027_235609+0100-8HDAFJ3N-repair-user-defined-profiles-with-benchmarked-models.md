---
trdd-id: 8HDAFJ3N
title: Repair user-defined profiles with benchmarked models
column: backburner
status: tasked
created: 2026-10-27T23:56:09+0100
updated: 2026-10-27T23:56:09+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-10-27T23:56:09+0100
---

# Repair user-defined profiles with benchmarked models

Parent: TRDD-UT7UC025. After the generated-profile card ships.

## Scope
Apply the repair chain to user-defined profiles too, as the USER directive says ("any profile, default or not").
- This reverses the rule in design/plans/20260918_182438+0200-profile-yaml-design.md:22 ("the user owns the four subsections... never touches the YAML nodes of a user-owned subsection"). The measure found no verbatim USER ruling behind that rule (guard introduced in a720d653, TRDD-90DM5YHO); the 2026-10-27 directive supersedes it.
- Back up settings.yaml before every write; add repaired models to the fallback list; replace the primary only when it is gone from the catalog or failed its benchmark; print every change on stderr; roll back if the repaired profile benchmarks worse.

## Acceptance
- [ ] a test shows a user profile with a removed primary gets a benchmarked replacement and a backup
- [ ] a test shows a working primary is never replaced

## Approval log

- 2026-10-27T23:56:09+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
