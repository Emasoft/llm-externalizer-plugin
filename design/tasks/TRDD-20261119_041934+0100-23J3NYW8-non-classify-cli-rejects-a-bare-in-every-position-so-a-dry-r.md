---
trdd-id: 23J3NYW8
title: Non-classify CLI rejects a bare -- in every position so a dry-run flag after it is consumed and the command fails
column: backburner
status: tasked
created: 2026-11-19T04:19:34+0100
updated: 2026-11-19T04:24:07+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-19T04:19:34+0100
---

# Non-classify CLI rejects a bare -- in every position so a dry-run flag after it is consumed and the command fails

Measured by the main agent on 2026-11-19, built CLI at commit 4c1ab0c2, temp HOME and config dir, fake key: a bare -- makes each command measured (scan folder, scan_folder, llm ask) exit 1 with empty stdout and 'llm-ext: unknown flag -- for <invocation>' as the last stderr line: before the positional (scan folder -- <dir>, with and without --estimate), at the start of the flat form (scan_folder -- --folder_path <dir> --estimate), on llm ask (llm ask -- <file> --instructions x --estimate) and at the end (scan folder <dir> --estimate --). Cause (code read): parseFlags in scripts/llm-ext/src/cli/main.ts (about line 292) dies on any token whose name after the two dashes is not a schema property, and the empty name of -- never is; the --estimate and --preview strips (about lines 862 and 870) take the flag from anywhere in argv first, so a dry-run flag after -- is consumed and the run then fails. The classify path differs: its runner reads every token after -- as a positional (run-decision.ts) and the launcher hoists --estimate (87c34c1d). Current behaviour is pinned in scripts/llm-ext/src/cli/estimate-positional-cli.test.ts (the it.each of four cases added in 4c1ab0c2). Decide: support -- as the POSIX end of options (the tokens after it are positionals, a dry-run flag after it is a file name), or reject it with an error that names -- as unsupported. Either way update the four pinned cases. Found while working TRDD-FP2SAF4P (item 11).

## Approval log

- 2026-11-19T04:19:34+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Notes

2026-11-19T04:24:07+0100 scope correction and full-capture re-measurement (main agent, 2026-11-19): the first body said every non-classify command; only scan folder, scan_folder and llm ask were run. Code scope: parseFlags is called once, at scripts/llm-ext/src/cli/main.ts line 876, for every non-classify tool that reaches that dispatch; commands handled before line 876 were not checked. Re-run on the built CLI at 4c1ab0c2 with the PAID test settings of estimate-positional-cli.test.ts, stdout and stderr captured to separate files and read whole: controls 'llm ask <file> --instructions x --estimate' and 'scan folder <dir> --estimate' exit 0 and print the ESTIMATE block; 'scan folder -- <dir> --estimate', 'scan folder -- <dir>', 'scan_folder -- --folder_path <dir> --estimate', 'llm ask -- <file> --instructions x --estimate', 'scan folder <dir> --estimate --' and 'scan folder <dir> -- --preview' each exit 1 with empty stdout, and the last stderr line is 'llm-ext: unknown flag -- for <invocation>'.
