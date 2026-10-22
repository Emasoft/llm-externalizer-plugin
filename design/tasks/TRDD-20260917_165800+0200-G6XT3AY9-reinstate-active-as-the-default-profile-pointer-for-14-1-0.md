---
trdd-id: G6XT3AY9
title: reinstate active as the default-profile pointer for 14.1.0
column: complete
created: 2026-09-17T16:58:00+0200
updated: 2026-09-23T23:43:33+0200
current-owner: coordinator-session-2026-09-17
created-by: coordinator-session-2026-09-17
task-type: feature
min-approval-requirement: none
assignee: coordinator-session-2026-09-17
mandate: true
mandated-by: none
approved: true
approval-judge: coordinator-session-2026-09-17
approval-datetime: 2026-09-17T16:58:00+0200
release-via: publish
target-release: 14.1.0
scope: project
project-id: llm-externalizer-plugin
relevant-rules: []
implementation-commits: [5502ca5, c1646e6, 1807cf8, a6fec0c, f0bb09a]
---

# reinstate active as the default-profile pointer for 14.1.0

Reinstate active: as the default-profile pointer for 14.1.0 (fix-queue row 88). See code map at llm-externalizer-plugin/reports/llm-ext-release/20260917_194500+0200-fq88-active-and-local-map.md.

## Approval log

- 2026-09-17T16:58:00+0200 — MANDATE issued by coordinator-session-2026-09-17 (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Directive

USER 2026-09-17 ~19:20: "active should be only one line and by default be `active: free`. there is no such profile, active is only the current choice for the default profile. If missing, the default profile would be free. free and paid and local are the 3 profiles always included in the llm-externalizer. they are dynamic, that is they are generated at each llm-ext call to be optimized to use the latest models (free: the latest free remote models, paid: the latest paid remote models, local: the detected llama.cpp/openai/lmstudio/ollama compatible endpoints detected in the local system). those 3 are dynamic and generated as soon a change is detected in the openrouter models for free/paid or locally for local). all others profiles are instead static and created by hand by the user. --profile <profile name> is the flag to pick the profile. if missing, the free profile is used by default."
USER 2026-09-17 ~19:35: "all ships in 14.1.0" (14.0.0 scope unchanged).

## Rule

Precedence: --profile <name> flag > active: <name> key in settings.yaml > built-in free.
active: is ONE top-level line naming ANY existing profile (dynamic or static); a fresh install writes active: free; a missing key means free; a value naming a profile that does not exist is a validateSettings ERROR (fail fast, no fallback).
No active: is ignored notice exists any more; active-deprecation-notice.ts and its state file are deleted, not left dormant.
This reverses the 14.0.0 decision D-B correction #2 recorded in TRDD-90DM5YHO.
COORDINATOR READING, pending USER confirmation (review of f198f02, F2): the precedence --profile > active: > free and the fail-fast on `active: nosuch` are the coordinator's readings of the directive, not its words; the directive only says a missing key means free.
IMPLEMENTED 2026-09-17: 5502ca5 (precedence, notice deleted, active-precedence.test.ts) + c1646e6 (dangling active: fails only when selected; empty/null ⇒ free; CLI_TOOLS_WITHOUT_RESOLVED_PROFILE — to be replaced by lazy resolution in OE27RD7I's phase); docs 1807cf8.
DECISION 2026-09-17 (release 4f): the CLI_TOOLS_WITHOUT_RESOLVED_PROFILE allow-list ships in 14.1.0 by decision — lazy resolution reaches beyond index.ts/cli/main.ts/config.ts twice over; lazy resolution is a 14.1.x ceiling, marked by the ponytail: comment in code.

## Inventory

Code map (section A + D + the A tests): llm-externalizer-plugin/reports/llm-ext-release/20260917_194500+0200-fq88-active-and-local-map.md
scripts/llm-ext/src/active-deprecation-notice.ts:1-69 (whole file) — DELETE (the addendum-G notice + state file, not left dormant).
scripts/llm-ext/src/index.ts:4085-4101 (discover tool case) — remove the unconditional active: is no longer used notice.
scripts/llm-ext/src/index.ts:4345-4358 (scan_local_llm_services --pick result text) — drop the NOT now active wording.
scripts/llm-ext/src/index.ts:847-854 unpopulatedDynamicProfileStub(name) — gains the local arm (also listed under Card B).
scripts/llm-ext/src/cli/main.ts:718-741 — the selection call site becomes profileOverride ?? settings.active ?? DEFAULT_PROFILE_NAME; maybeNotifyActiveDeprecated call removed.
scripts/llm-ext/src/config.ts:194-201 Settings.active type comment — update to reflect active as a live selector again.
scripts/llm-ext/src/config.ts:751-764 loadSettings() — active: parsing comment updated (selection is live again).
scripts/llm-ext/src/config.ts:877-879 effectiveProfileName(settings) becomes the single resolver used by both the CLI selection path and the display/reconcile paths.
scripts/llm-ext/src/config.ts:1070-1084 generateDefaultSettings() — emits active: free.
scripts/llm-ext/src/config.ts:2494-2531 formatActiveProfileSummary() — drop the unconditional ignored notice; report the resolved active profile.
scripts/llm-ext/src/benchmark/pick.ts:581-609 addProfileToSettings() — addProfileToSettings may again set active on --pick when asked.
Tests: scripts/llm-ext/src/config-default-settings.test.ts:95-104 flips to emits active: free.
Tests: scripts/llm-ext/src/cli/active-profile-retirement.test.ts (whole file) — replaced by an active-precedence test with the three cases (flag > active: key > built-in free).
Tests: scripts/llm-ext/src/doc-contract.test.ts:138-158 — drops the notice-string assertions.
Docs (section D): README.md:953-961,980-990,993-1013,1013-1021,1080; CHANGELOG.md:4-25,34; docs/agent-usage-reference.md:283,288; docs/setup-and-configuration.md:152,162,289; rules/use-llm-externalizer.md:9; skills/llm-externalizer-or-model-info/references/errors.md:11; skills/llm-externalizer-config/references/configuration-guide.md:135-136; skills/llm-externalizer-config/references/profile-templates.md:119; skills/llm-externalizer-config/SKILL.md:80; skills/llm-externalizer-create-profile/SKILL.md:17,31,38,44,183 — all must drop the active: is ignored / only selector wording.

## Acceptance

llm-ext settings status with active: remote-single-deepseek-v4-flash and no --profile reports that profile as selected; with --profile free reports free; with no key reports free.
A fresh settings.yaml contains exactly one active: free line.
active: nosuch fails at the CLI selection call site (cli/main.ts:739-740's die(result.error), fed by overrideActiveProfile in index.ts, gated by shouldFailProfileSelection in config.ts:1005) with a message naming the key and the missing profile — not validateSettings, which never sees a dangling active: standing alone.
grep of README/CHANGELOG/docs/rules/skills for no longer read, is ignored, only selector returns 0 hits about active:.
14.1.0 CHANGELOG entry states the reversal.

## Note from the review of 86521c6 (F3)

writeBootBanner (index.ts ~6740) labels an unpopulated profile with effectiveProfileName(activeSettings); the reinstated resolver must keep the in-memory --profile override winning over the on-disk active: in that call, or the banner names the wrong profile after --profile. (The worker minting card C appends this section to card A.)

## STATE

2026-09-17 ~22:30: A 5502ca5, A2 c1646e6, precedence wired through the chain a6fec0c+f0bb09a; allow-list ships by decision (Rule).

## Fresh check evidence

Fresh check 2026-09-23: scripts/llm-ext/src/active-deprecation-notice.ts does not exist (confirmed with ls) and no import of it anywhere in scripts/llm-ext/src (grep -rn returns 0 hits).
The dangling active: refusal lives at the CLI selection call site: cli/main.ts:739-740 'if (!result.ok && shouldFailProfileSelection(...)) die(result.error);', fed by overrideActiveProfile() in index.ts (error text 'settings.yaml active: <name> names a profile that does not exist. Available: ...') and gated by shouldFailProfileSelection in config.ts:1005 — not validateSettings. Card acceptance line edited to name this site.
grep of README.md, CHANGELOG.md, docs/, skills/, rules/ for 'no longer read'/'is ignored'/'only selector' near active: found 0 relevant hits — the only matches (README.md:580 --file-list target, CHANGELOG.md:1749 stale lock) are unrelated to active:, and the active: hits that do exist (README.md:1285, CHANGELOG.md:22,33,41, docs/setup-and-configuration.md:285) correctly describe the 14.1.0 reversal (active: reinstated), none say it is ignored. No doc carry needed on WBZJRSQB step 8.

## Acceptance checklist

- [x] active-deprecation-notice.ts deleted and unimported
- [x] dangling active: refusal site identified and card's acceptance line reworded to name it (cli/main.ts:739-740)
- [x] doc sweep (README/CHANGELOG/docs/skills/rules) for stale active: wording — 0 relevant hits
