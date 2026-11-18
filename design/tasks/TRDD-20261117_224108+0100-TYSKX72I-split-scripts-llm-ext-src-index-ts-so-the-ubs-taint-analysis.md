---
trdd-id: TYSKX72I
title: Split scripts/llm-ext/src/index.ts so the ubs taint analysis finishes on every part
column: backburner
status: tasked
created: 2026-11-17T22:41:08+0100
updated: 2026-11-18T12:37:26+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: refactor
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-17T22:41:08+0100
---

# Split scripts/llm-ext/src/index.ts so the ubs taint analysis finishes on every part

USER 2026-11-17 verbatim: 'why partial runs? we cannot risk to commit bugged code.' So the strict ubs pre-commit hook (TRDD-KZA573Q7) blocks a partial run. Measured 2026-11-17, one run: ubs 5.5.26 on index.ts (8572 lines) ran 26 s, 0 critical, then exited 2 because taint_js stopped at its work limit (Partial: ANALYZER_ERROR ... Taint dataflow work limit exceeded). The limit is fixed in ubs code (taint_js.py line 2995: work_limit = max(500_000, 128 * len(code))), no env var or config raises it. Consequence: every commit that stages index.ts is blocked by the hook. Goal: split index.ts into modules each of which ubs --staged scans without a partial run, with no behaviour change. Unknown and to measure first: whether the limit is exceeded because of file size or because of specific functions (the limit grows with code length, so size alone may not be the cause); scan halves or the largest functions to find out before splitting.

## Approval log

- 2026-11-17T22:41:08+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Constraints

Each split step must pass ubs --staged with no partial run and no critical finding before its commit; --no-verify is not allowed for this work.
Scope: only the 22 src .ts files over 60 KB were scanned, each alone; a staged combination of smaller files can still run partial (seen 2026-11-17 with ubs 5.4.17 elsewhere: two files timed out together while each passed alone).

## Progress

2026-11-18T02:53:52+0100 Split measured in a scratch copy (reports/sonnet-worker/20261118_024512+0100-tyskx72i-split.md in the main checkout): index.ts alone with a one-line comment edit ends partial (js.taint.command work limit, 0 critical). Moving the spawnSync and execFileSync calls of index.ts and config.ts into a small module spawn-sync.ts passes the hook only when spawn-sync.ts is committed first on its own and left out of the commit that stages index.ts and config.ts; staging spawn-sync.ts together with index.ts is partial again. That passes by hiding the sinks from the scanner for that commit, so it is a USER decision of the same kind as D1, not taken. index.ts has 0 matches of the ubs request-source patterns but 2 occurrences of the word params, which the ubs source-free test also counts (taint_js.py near line 3059), so the hidden calls could still carry findings. Measured once per case, comment-level edits only.
2026-11-18T12:37:25+0100 main agent (written by worker): Measurement by worker (reports_dev/tyskx72i-measure/20261118_115659+0100-report.md; driver numbers from an instrumented copy of the ubs taint analysis, plus real hook scans): the ubs limit is fixed in code at 128 x file length (taint_js.py:2995; no env var, flag or config found by grep). Baseline: js.taint.command spends 4.82x the limit, 91% inside dispatchCallToolInner. Getter rewrites (getCurrentBackend calls replaced by the module variable) do not help (4.82x and 4.44x). Emptying compare_files, which holds all four spawnSync sinks, stops the rule from running at all (call_sinks 0): rejected, like the params rename, because it removes the analysis. Emptying the five largest other cases (chat, session_summary, batch_check, check_references, check_imports; 1687 lines) with compare_files kept gives 0.74x (driver; no real scan). The compare_files ref arguments are guarded against a leading dash (index.ts L7381).
2026-11-18T12:37:26+0100 main agent (written by worker): Decision by the main agent under the USER delegation of 2026-11-18: route = move those five case handlers out of dispatchCallToolInner into their own modules (dependencies passed in, no import of index.ts), compare_files stays in index.ts so the taint rule keeps covering its sinks; a real hook scan must pass with margin, else more cases move (the full handler split of TRDD-HCNC6433 option A). Scheduled after the 14.7.2 publish; TRDD-TN8OUZ50 then ships with it.
