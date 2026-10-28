---
trdd-id: 5Q79QZM7
title: Repair broken generated profiles inline and in the same run, detect provider outages
column: todo
status: tasked
created: 2026-10-27T23:56:08+0100
updated: 2026-10-28T01:17:08+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-10-27T23:56:08+0100
---

# Repair broken generated profiles inline and in the same run, detect provider outages

Parent: TRDD-UT7UC025 (USER directive, verbatim). First increment of the self-healing design.

## Measured facts (2026-10-27)
- An invalid ACTIVE profile makes every tool except discover/reset/get_settings/profile/list_profiles/scan_local_llm_services return NOT CONFIGURED at scripts/llm-ext/src/index.ts ~4000-4017, before the maintainer path at index.ts:4036-4054. The validation repair in dynamic-maintainer.ts:316-446 therefore never runs from a command: this is how the 2026-10-22 outage stopped everything.
- Non-active profiles get only explicit-type and classifier checks (config.ts:3184-3216), so they do not block the load.

## Scope
1. When the active profile is a marked generated section (free, paid) that fails validation, run the existing back-up-and-regenerate repair inline, then dispatch. Unmarked profiles: card TRDD for user profiles.
2. When every model of a generated profile fails at run time, run the repair in the foreground (time limit, one per run, lock on settings.yaml) and retry once in the same run, instead of only starting a background update.
3. Outage detection: when several models fail with the same 5xx or network error, treat it as a provider outage: no benchmark, report it and go to the next tier.
4. Key errors are reported first and never trigger a download.

## Acceptance
- [ ] a test with a one-model free ensemble active shows a command succeeds after the inline repair
- [ ] a test where every free model fails shows the foreground repair and the same-run retry
- [ ] a test with a provider-wide 5xx shows no benchmark run
- [ ] settings.yaml is backed up before each write and two parallel repairs never both write

## Approval log

- 2026-10-27T23:56:08+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Progress

- 2026-10-28: scope item 1 done in f8451074 (inline repair, latched, only when the active profile itself is invalid; the exact 2026-10-22 file no longer reaches the gate). Scope item 2 done in 045a66fb (waits for the recorded update outcome, retries once only when the profile changed, empty-pool gate waits too). Follow-up: multi-file tools (scan_folder) do not retry; retrying only the failed files is still open. Next: item 3 (provider outage detection) and item 4 (key errors never trigger a download).
- 2026-10-28 review of 045a66fb, to fix next (after the outage worker releases index.ts): (1) take the update baseline BEFORE requestProfileUpdate spawns, in failDynamicProfile and the empty-pool gate; (2) retry single-file tools and multi-file runs where nothing succeeded, skip the re-run only when some items already succeeded; (3) key the outcome to this update (run id or start time), not to the shared failCount; (4) count success only on lastBenchmarkAt, or say pruned-not-rebenchmarked; (5) check the updater writes its record before releasing the lock, else wait on the record; (6) tests for the baseline race and a concurrent failCount bump.
