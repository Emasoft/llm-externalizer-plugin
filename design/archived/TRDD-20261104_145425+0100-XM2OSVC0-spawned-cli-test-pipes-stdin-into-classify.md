---
trdd-id: XM2OSVC0
title: Spawned CLI test pipes stdin into classify
column: complete
status: archived
created: 2026-11-04T14:54:25+0100
updated: 2026-11-14T15:38:28+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: infra
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-04T14:54:25+0100
implementation-commits: [1c41b721]
---

# Spawned CLI test pipes stdin into classify

No committed test covers main.ts readAllStdin end to end: the TTY refusal, and the process.stdin wiring that passes stdin to readAllFrom. The spawned-CLI tests (cli/classify-launch-cli.test.ts, cli/classify-review-cli.test.ts, cli/estimate-positional-cli.test.ts, live-classify.test.ts) pass --input or file positionals; none pipes stdin. Found in the review of commit 9fec6c04 (TRDD-S3QEQBYV), confirmed by grep on 2026-11-04.

Task: add a spawned-CLI test in the style of cli/classify-launch-cli.test.ts (execFile of the built dist/llm-ext.js) with a temp HOME, LLM_EXT_CONFIG_DIR and LLM_EXT_INSTALL_RULE=0, that pipes stdin into classify filter --estimate (no model request). Truncated JSON gives exit 1 and "cannot read the JSON input from stdin"; a valid filter input gives exit 0 and the estimate. Add the file to the explicit include list in vitest.config.ts. The TTY refusal needs a pseudo-terminal; cover it only if a dependency-free way exists, otherwise record why not.

Evidence so far: on 2026-11-04 a clean git-archive export of 9fec6c04 was built; classify filter --estimate, given an open brace on stdin, exited 1 with "cannot read the JSON input from stdin". That was a one-off check, not a guard.

## Approval log

- 2026-11-04T14:54:25+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-14T15:38:28+0100 — COMPLETE by main-agent@llm-externalizer-plugin. test landed 1c41b721; TTY refusal recorded as not covered.

## Notes

2026-11-04T15:06:00+0100 Unmeasured: the success path (valid input, exit 0 with the estimate) has never been run spawned. --estimate still selects a profile and loads the catalog (run-decision.ts:255 through deps.fetch), so a spawned CLI with a fresh temp LLM_EXT_CONFIG_DIR would fetch the catalog over the network and may refuse without a classifier profile in settings.yaml. The test must seed a classifier profile and a catalog cache in the temp config dir, or show how it avoids the network. It runs against whatever dist is built; committed dist predates readAllFrom (behaviour identical), so in CI it proves the stdin behaviour, not that the shipped bundle contains the new wiring, until TRDD-6XMCY4ZE lands.
2026-11-04T15:14:31+0100 Leads for the implementer: profile and settings shape as in classifiers/receipt.test.ts (profile-type classifier, api openrouter-remote, model typesafe/jev-1.13, active and active_classifier set); --estimate skips key resolution (run-decision.ts:271), so no key is needed. Catalog cache: see l0/catalog.ts:36 (default path) and peekCache at :112-116; seed it from the recorded catalog fixture under classifiers/__fixtures__ and check any freshness rule that would still fetch. The truncated-JSON half fails before profile selection and can land first. Locally the test runs against the shared tree dist, which holds another session's uncommitted build. Put the file in the same npm test step as the other spawned CLI tests (package.json). TTY refusal lead: macOS script -q /dev/null <cmd> gives a pseudo-terminal without a dependency, but util-linux syntax differs; a lead, not solved.
2026-11-14T15:38+0100 landed as 1c41b721: src/cli/classify-stdin-cli.test.ts (in the vitest.config.ts include list, same npm test step as classify-launch-cli) spawns the committed dist with stdin piped into classify filter --estimate: truncated JSON exits 1 with cannot read the JSON input from stdin; valid input exits 0 with the estimate, no key, and one endpoints GET answered from the p02 fixture; a body over 128 KiB with multibyte text exits 0 with the whole-document estimate. Fail-before: five test-side mutations red; a scratch bundle copy whose readAllFrom keeps the first chunk only failed the large case (exit 1). Checks: three spawned-CLI files 31/31, tsc 0, eslint 0; full npm test not run (better-sqlite3 binding missing, TRDD-G0MS9B63). Not covered: the TTY refusal, because script(1) syntax differs between macOS and util-linux (file header shortcut comment). Only globalThis.fetch is observed. Report reports_dev/xm2osvc0/20261114_153038+0100-stdin-test.md.

## Acceptance

- [x] a spawned-CLI test pipes truncated JSON into classify filter --estimate: exit 1 and cannot read the JSON input from stdin (1c41b721)
- [x] the same test pipes valid filter input: exit 0 and the estimate, with no catalog fetch and no key (1c41b721)
- [x] the file is in the explicit include list of vitest.config.ts, in the same npm test step as the other spawned-CLI tests (1c41b721)
- [x] the TTY refusal is either covered dependency-free or the reason it is not is recorded (not covered: script(1) syntax differs between macOS and util-linux; recorded in the test file header and the Notes)
