---
trdd-id: VAORGKVF
title: A refused IRON RULE call is final and never feeds the circuit breaker
column: complete
status: tasked
created: 2026-10-07T17:26:12+0200
updated: 2026-10-27T21:23:31+0100
current-owner: user
created-by: user
task-type: bugfix
min-approval-requirement: none
assignee: user
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T17:26:12+0200
release-via: publish
target-release: 14.1.0
npt: [YG72CYY7]
implementation-commits: [d4861125, e67e1ab5, a20f58f8, 2ff6943e]
---

# A refused IRON RULE call is final and never feeds the circuit breaker

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-10-24

- DECISIONS 2026-10-27 (USER grant: 'decide yourself on everything. just base your decisions on verified facts. also consult the advisor.'): (a) item 3 accepted on the dispatch-level measurement plus the read exit-code mapping, box ticked. (b) the USER had ruled on 2026-10-24, verbatim: 'When every cause is an IRON RULE refusal, drop only "retry later" from the sentence and keep "change the profile", for every profile kind.' Implemented in 2ff6943e (REFUSED_PROFILE_EXHAUSTED_MESSAGE, chosen in the ProfileExhaustedError constructor, so the batch reason and the top-level catch both get it). INTERPRETATION, not a fact: the ruling names the USER sentence; the rank-0 dynamic path throws a different sentence saying an update is underway, where retry later is true, so it is left unchanged. (c) the no-update coordinator default for tools ranked above 0 is accepted: it follows the quoted USER principle and is tested. Card ready to close after the 14.1.2 release.
- PREVIOUS NEXT ACTION: increments 1 and 2 are done (commits d4861125, e67e1ab5, a20f58f8, plus the measurement below). Acceptance items 1, 2 and 4 are met. Item 3 is met at the dispatch level (dispatchCallTool isError true in 265 ms, 0 breaker and 0 model-retry lines) but the CLI process exit code was not measured. Open questions for the owner: (a) is dispatch-level evidence enough for item 3, or is a real CLI exit-code run wanted; (b) the abort-line wording below; (c) whether the coordinator default below (no profile update for tools ranked above 0) is acceptable. Increment 2 is a one-off measurement (scripts_dev/vaorgkvf-measure.test.ts, gitignored), not a permanent test: on the dynamic path the old code also stopped the batch (4 profile updates requested and 21 retry lines before it stopped; how many files ran was not measured), so a 20-file test is not expected to add a failure that test (a) does not already show (inferred: the retry and breaker gates act per call, so 2 files already exercise them; not measured). Open question (b): for an all-refused chain the abort line still begins with the USER-specified sentence "the models in the selected profile are all failing; retry later or change the profile" (scripts/llm-ext/src/profile-fallback.ts:65-71, marked do not reword; USER text in TRDD-OE27RD7I Directive addendum 3), followed by the refusal and its Validate-it remedy. Options: keep it; drop the whole sentence when every cause is a refusal (this also drops change the profile); or drop only retry later. Scope note: addendum 3 gives that sentence for normal profiles only (those created by the user, not free/paid/local; card line 77). The measured all-refused run used the dynamic paid profile, where the sentence appears only because failDynamicProfile builds new ProfileExhaustedError(profileName, "static", causes); and the dynamic directive D2 ties retry later to an update being underway, which this path no longer starts. So for dynamic profiles the do-not-reword marker may not cover this case; for a static profile it does. Follow-up 1d (the abort text for the all-refused case) waits on this ruling; nothing changed yet.
- Trace answer for the acceptance item "were refused requests retried": YES, at the call level, measured 2026-10-24 (before-run at eb8166cf, a 20-file scan_folder on the dynamic paid chain of profile-chain-402.test.ts, no validation bypass): 240074 ms, 21 [model-retry] lines, 8 [circuit-breaker] lines, 4 profile updates requested, batch stopped with "ABORTED: Unrecoverable: no model of the paid profile is working right now; the profile update is underway in the background … retry later" and no Validate-it remedy. After (HEAD a20f58f8): 265 ms, 0 retry lines, 0 breaker lines, 0 updates, 0 POSTs, and the abort line carries the refusal and its Validate-it remedy. Each chain entry got 1 attempt plus 3 same-model retries (MAX_TRUNCATION_RETRIES=3) and every attempt fed recordServiceFailure (both traced by reading the code; only the totals were measured, 21 retry lines and 8 breaker lines, not a count per entry). At the file level it depends on the path: on the dynamic path the old update error was classified final, so the batch stopped (measured; the per-file tally was not captured, the result text had no per-file lines); on the static and raw paths classifyError returned the recoverable default, so files were retried in turn (traced by reading the code, not measured). The mutation runs for e67e1ab5 were made by a worker; its verbatim result lines are in the 084942 report below.
- Coordinator default 2026-10-24 (not a USER ruling; open question (c) above): a paid or free profile update cannot cure this refusal for scan_folder or any tool ranked above 0, because populate writes only general-keyword-results.json (rank 0; benchmark/index.ts:2032 recordGeneralKeywordPasses; traced by reading the code, not run). So for those tools failDynamicProfile returns the actionable error with no update, applying the existing USER principle "an update cannot fix every failure, and then the actionable error wins". Rank-0 tools keep the update.
- Accepted residuals: a mixed chain of refusals plus a 429 or 5xx still classifies recoverable on the static path, because SERVICE_LEVEL_STATUS_RE matches only API error 401/402/403/404/410 (checked 2026-10-24); a dynamic mixed chain is not all refusals, so it takes the update branch and ends as retry-later (traced, not tested). The refusal part of each per-file retry is instant; the 429/5xx entries are still re-sent and still feed the breaker. A refused model is not marked run-unusable (instant now). mass_scout and security_scan checks run once at job start and are out of scope. Untraced and untested: the free-rotation and multi-slot ensemble callers of failDynamicProfile; the rank-0 path that keeps the update; a tool absent from TOOL_DIFFICULTY_RANK counts as curable by an update (unverified, fails safe to the old behaviour); the regex that reads the tool name from the refusal is not pinned to the throw text (a miss fails safe to the update path). The batch-wide abort (serviceLevel: true) for a raw refusal rests on every file using the same model; the multi-slot ensemble join that could break that was not traced. The top-level catch of dispatchCallTool (index.ts:7367-7369) prints a ProfileExhaustedError message verbatim on non-batch paths: the USER sentence with no refusal and no Validate-it remedy (checked only for the construction without a detail; the constructor appends a detail when one is given); a change made only in classifyError does not reach it (which tools hit that path with an all-refused chain was not traced).
- Gotcha: a "< 5 s" wall-clock bound is flaky at host load ~66; assert counts.
- Evidence (gitignored): reports_dev/vaorgkvf/20261024_080214+0200-measure.md, 20261024_080654+0200-measure-r2.md, 20261024_085803+0200-measure-inc2.md, 20261024_084942+0200-increment1c-worker.md, 20261024_090411+0200-inc2-measurement.md, 20261024_091049+0200-measure-1d.md. Note: the message of commit 87a5affe says 4 profile updates and 21 retry lines ran before the stop as if that showed more than one file ran; whether one file can request more than one update was not checked, so the card wording (file count not measured) is the authoritative one.

## Issue item
Issue 16 item 2: a refused IRON RULE run does not fail fast.

## Trace and status
PARTLY (mechanism confirmed by reading, not reproduced). connection.ts:96 throws the IRON RULE not-validated error. In chatCompletionWithRetry (provider/completion.ts around 1060-1160) payment is null, it is not isPriceCeilingRefusal and not deterministic4xx (regex covers only 402/403/404/410), so recordServiceFailure() runs and the same model is retried up to MAX_TRUNCATION_RETRIES=3 with checkServiceHealthOrWait(). Five consecutive failures trip the breaker, which sleeps 60s, 120s, 350s (completion.ts:868-947). classifyError (index.ts:1985) has no rule for the message (SERVICE_LEVEL_STATUS_RE at index.ts:1915 needs API error NNN), so the file loop retries 3 times (index.ts:2227-2250, scan-folder/core.ts:276-308) and the batch aborts only after 3 consecutive failures. Siblings already fixed: price-ceiling refusal (da3a18bf), deterministic 4xx (f7ecaa9b, 613ba685). Since 59ba9351 (D3b) hand-listed models skip the gate (connection.ts:96), so it stays reachable for auto-picked models and for mass_scout / security_scan judges (mass_scouting/scout.ts:254, security_scan/judge.ts:207). Overlap: TRDD-YG72CYY7 does not cover this refusal.

## Acceptance
- [x] the IRON RULE sentence is excluded from recordServiceFailure and from the same-model retry, next to isPriceCeilingRefusal in completion.ts
- [x] classifyError returns unrecoverable for it, also when wrapped in ProfileExhaustedError
- [x] real test: an all-refused scan_folder run returns isError true with zero breaker and zero model-retry lines (measured 2026-10-24: 265 ms, 0 POSTs; 2-file permanent test in profile-chain-402.test.ts); the CLI maps isError to exit 1 (cli/main.ts, read 2026-10-27). The wall-clock bound was dropped as flaky under host load, and 2 files exercise the per-call gates the same way 20 would.
- [x] the open question in the issue correction comment (were refused requests retried) is answered in this card with the trace above

Source: GitHub issue 16 (owner-filed, 2026-10-03), verified at HEAD e4a927d2 on 2026-10-07; part of the 14.1.0 release (TRDD-WBZJRSQB).

## Approval log

- 2026-10-07T17:26:12+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-27T21:23:06+0100 — column → complete by main-agent@llm-externalizer-plugin. released in v14.1.2 and installed; USER grant 2026-10-27 to decide
- 2026-10-27T21:23:18+0100 — column → complete by main-agent@llm-externalizer-plugin. released in v14.1.2 and installed; USER grant 2026-10-27 to decide
- 2026-10-27T21:23:31+0100 — column → complete by main-agent@llm-externalizer-plugin. released in v14.1.2
