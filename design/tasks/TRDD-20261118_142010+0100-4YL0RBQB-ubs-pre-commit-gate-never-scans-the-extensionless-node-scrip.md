---
trdd-id: 4YL0RBQB
title: ubs pre-commit gate never scans the extensionless node scripts bin/llm-ext and bin/llm-ext-benchmark
column: backburner
status: tasked
created: 2026-11-18T14:20:10+0100
updated: 2026-11-18T14:20:10+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-18T14:20:10+0100
---

# ubs pre-commit gate never scans the extensionless node scripts bin/llm-ext and bin/llm-ext-benchmark

(1) Verified by the main agent 2026-11-18: ubs 5.5.26 assigns a language to a file with no extension only for sh or bash shebangs (libexec/ubs:3925-3946, matches_lang). A scratch copy of bin/llm-ext (shebang #!/usr/bin/env node) scanned alone gives "no supported languages detected", exit 3.

(2) .githooks/pre-commit exports UBS_ALLOW_NO_SCAN=1 (line 72) and treats exit 3 as a pass (line 127), so a commit of only these files passes unscanned; in a mixed commit they are skipped without notice (inferred from the same detection code). Tracked files affected: bin/llm-ext, bin/llm-ext-benchmark.

(3) W's commits run the hook at the main checkout's .githooks/pre-commit: core.hooksPath is set in the main repo .git/config to that absolute path, so the gate depends on whichever branch the main checkout has checked out (byte-identical to W's own copy on 2026-11-18).

(4) Fix direction: the hook lists staged extensionless files whose shebang names node or python and either scans them under a temporary .js/.py name or blocks the commit; and the hook path should not depend on the main checkout's branch.

## Approval log

- 2026-11-18T14:20:10+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
