---
trdd-id: 51JRJ3M6
title: Dry-run preview and estimate ignore the input_file parameter
column: backburner
status: tasked
created: 2026-11-13T22:42:15+0100
updated: 2026-11-13T23:58:30+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-13T22:42:15+0100
---

# Dry-run preview and estimate ignore the input_file parameter

Measured 2026-11-13 on HEAD b9bf1f26 (reports_dev/58cfbqhn/20261113_223813+0100-dry-run-flag-measurement.md). The dry-run file resolver only reads input_files_paths and folder_path. So --preview fails with "no input_files_paths or folder_path given" for summarize, topics, sem_deduplicate and describe (llm summarize, llm topics, llm sem-deduplicate, llm describe), whose input is input_file, and --estimate fails the same way for cluster_synonyms (llm cluster). session_summary --preview fails with the same message: its input is transcript / session_id, which the resolver does not read. Two more resolver gaps found in step 2: security_scan (its files are targets[].file_path and targets[].path_glob relative to folder_root; measured on the built CLI with valid --targets, rc1 with the same resolver message; snippet targets carry inline code and no file, so a snippet-only scan has nothing to list even after the fix) and mass_scout_propose_fieldset (its optional samples parameter is a list of file paths). Fix: the resolver also resolves input_file. Then update the dry-run support table DRY_RUN_SUPPORT added by TRDD-58CFBQHN step 2 in scripts/llm-ext/src/cli/dry-run-flags.ts (its binding test will fail until the table matches) so help lists the flags. Acceptance: each listed command accepts the flag on a minimal valid input with no model request sent; help lists it; full npm test green.

## Approval log

- 2026-11-13T22:42:15+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Related

Found by TRDD-58CFBQHN step 2: its dry-run support table marks these tools as gaps pointing here; fixing this card must update that table (its binding test fails until it does).

## Measurement environment

Measured with env -i, a fake OPENROUTER_API_KEY and a paid scratch profile, because with no key the free-profile gate refuses --estimate for every command; a reproduction without a key sees every --estimate refused and must not read that as this gap.

## Notes

2026-11-13T23:56+0100 acceptance item moved here from TRDD-NNCA6WMY (now under Acceptance): the --preview refusal text; report reports_dev/58cfbqhn/20261113_235141+0100-refusals.md.

## Acceptance

- [ ] the --preview refusal names the inputs the command actually takes, or says it has no preview, instead of no input_files_paths or folder_path given (seen on models replacements, security-triage-benchmark, scout run, which take neither)
