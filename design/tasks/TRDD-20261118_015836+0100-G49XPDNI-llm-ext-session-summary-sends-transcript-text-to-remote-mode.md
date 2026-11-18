---
trdd-id: G49XPDNI
title: llm-ext session-summary sends transcript text to remote models without redacting secrets
column: publish
status: tasked
created: 2026-11-18T01:58:36+0100
updated: 2026-11-18T14:14:07+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: security
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-18T01:58:36+0100
implementation-commits: [b84e6dac]
release-via: publish
---

# llm-ext session-summary sends transcript text to remote models without redacting secrets

## Approval log

- 2026-11-18T01:58:36+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-18T13:01:44+0100 — column → complete by main-agent@llm-externalizer-plugin. code committed and verified on the exported commit (tsc and card tests); ships in 14.7.2; approved by the main agent under the USER delegation of 2026-11-18
- 2026-11-18T14:14:07+0100 — column → publish by main-agent@llm-externalizer-plugin. shipped in v14.7.2 (8c72f83d, release https://github.com/Emasoft/llm-externalizer-plugin/releases/tag/v14.7.2); main agent approves under the USER delegation of 2026-11-18

## USER decision

USER 2026-11-18 verbatim: "it is ok to send the session to openrouter free models, as long as you redact all secrets with the secrets-shield scanner of the janitor plugin (not sure if it is already installed)"

## Description

Measured 2026-11-18. llm-ext session_summary has no secret redaction; its only redaction is of inline data:image base64 URIs (scripts/llm-ext/src/session_summary/transcript.ts:118). The janitor 3.9.8 transcript senders (compose_agent_handoff.py, summarize_previous_session.py, llm_ext_compact.py, jev_compact.py) have no secret-redaction step either (grep for redact, shield, sanitiz, secret). The janitor shield core ships in report-sanitizer as `sanitize-reports --stdin`; on this session's 97.9 MB transcript it ran in 120 s, exit 0, 11456 replacements (cred, email, identity, path, token, url), but 11 of 35795 output lines no longer parse as JSON: on raw JSONL text the cred rule for `const token = ...` consumed the backslash of an escaped quote. So redaction must run on decoded string values (or on the rendered text llm-ext builds from the transcript), not on raw JSONL. To decide: vendor the shield core (TypeScript) into llm-ext, or call sanitize-reports, which exists only on machines with the report-sanitizer checkout. Done when session-summary sends no chunk that was not redacted with the shield rules, a test shows a fake secret in a transcript never reaches the request body, and tsc and eslint are clean.

## Progress

2026-11-18T02:38:39+0100 The janitor session offered a redaction bridge on 2026-11-18: hooks/secret-shield/redact_bridge.ts of the janitor source tree, not in installed janitor 3.9.8, to ship with 3.9.9; until then copy the whole hooks/secret-shield/ folder at janitor commit 4c46d82c. Protocol: one JSON request per stdin line {op all, t, homes, passes}, one response per line {t, h}; treat an error line, a non-zero exit, a timeout or a missing response as do-not-send. Limits: each request is redacted on its own, with no sweep across lines; rules that need the key beside the value need the raw line. Plan: per line, raw-line redaction first; if the result still parses, also redact its decoded string leaves; if not, redact the decoded leaves of the original line plus each key-value pair rendered as JSON.stringify(key) + ': ' + JSON.stringify(value); refuse the whole transcript if any line still fails. Not measured with the bridge yet: the 11 unparseable lines seen on 2026-11-18 came from whole-file sanitize-reports raw-text redaction. Open: per-line redaction does not catch a secret repeated elsewhere without context, so it does not yet meet the USER condition to redact all secrets.
2026-11-18T02:53:53+0100 Proposal of the main agent, not reviewed and not decided: session-summary sends a chunk only after it passed the janitor redact bridge of the installed janitor plugin, and refuses to send when the bridge is missing or fails (fail closed), as the reading of the USER condition to redact all secrets with the janitor secrets-shield. Cost: session-summary stops working on a machine without janitor 3.9.9 or later. Alternative: vendor the shield core into llm-ext, which then must be kept in step with the janitor. Waits for janitor 3.9.9, which per the janitor session will carry the bridge (not checked).
2026-11-18T04:49:38+0100 The ai-maestro-janitor session reports (2026-11-18, peer message, not checked here) that janitor 3.9.9 is not published: its publish stopped before any push on stricter bandit checks in CPV v5.23.1 and waits on its owner. Until then it offers the shield of its checkout (main at 32886322 or later): hooks/secret-shield/redact_bridge.ts run with bun, one NDJSON request per line, redacting each RAW JSONL line rather than decoded values, then checking every redacted line still parses (scripts/lib/transcript_redact.py redacted_transcript_copy). Coverage of escaped secrets inside JSON strings is unmeasured, so no transcript goes to an outside model until 3.9.9 is installed or that coverage is measured.
2026-11-18T05:18:31+0100: janitor peer report (cross-session, not USER approval): its transcript lane runs the shield regexes over raw JSON lines without decoding strings. On 124 synthetic cases (12 secret kinds, up to 12 escape forms): 73 removed, 45 left whole, 3 partly left, 3 lines refused. Left whole: tokens right after a \n or \t escape, every NAME=value or password=value assignment, secrets with \uXXXX escapes or escaped slashes. Its output is best-effort, never sanitized; 3.9.9 alone will not fix it; the fix is a JSON-aware filter on janitor card TRDD-BAQB9SYO. Stance unchanged: no transcript goes to an outside model.
2026-11-18T10:11:53+0100 main agent: triage 2026-11-18 at HEAD 54236bf8: no content redaction on the session-summary request path (provider/ has only sanitizeProviderError, which cleans error replies; verified by the main agent). llm-ext's own redactor (security_scan/intake.ts redactSecrets, safeRedact, fail closed) is not used by session_summary; the USER quote names the janitor secrets-shield, so using intake.ts instead is a USER decision. Fix site by the worker's reading: transcript.ts, on each raw string before the 80/160-char cuts (:526-:538), failing closed.
2026-11-18T10:24:01+0100 main agent decision under the USER delegation of 2026-11-18 ("solve all issues yourself. i need results."): the product fix uses the llm-ext redactor safeRedact (security_scan/intake.ts), fail closed, run on each raw string in transcript.ts before the 80/160-char cuts; a turn that cannot be scanned stops the run with an error before anything is sent. Reason: the shipped CLI must protect every user and cannot depend on the janitor plugin being installed. Main agent reading, not a USER statement: the USER condition that names the janitor secrets-shield is read as governing the sending of this Claude session transcript out, which stays off; this reading picks a different scanner for the product than the one the quote names, and the USER is told so. This replaces, by the main agent under the delegation, the open USER decision recorded in the 2026-11-18 note above.
2026-11-18T12:36:07+0100 main agent (written by worker): commit b84e6dac. transcript.ts scrubs every string sent to the model with safeRedact (security_scan/intake.ts) before any cut and fails closed with TranscriptRedactionError; ENV_SECRET, PEM and JWT patterns made linear in intake.ts and scan-pipeline.ts. Committed-tree check of b84e6dac (export of the commit, node_modules linked): tsc exit 0; security_scan 119, scan-pipeline 27, transcript 50, driver 81, l2 content-redact 28, l2 redact 22 tests passed. Known limits: ENV_SECRET misses 4 or more line breaks on one side of the separator (fuzz result, pinned by a DOCUMENTED LIMIT test, not proven exhaustive); the two 64 MB fail-closed tests need the redaction to exceed the 500 ms budget (5-9x on this machine) and could fail on a much faster one. The scanner deviation from the USER quote (intake.ts, not the janitor secrets-shield) was stated to the USER in the session on 2026-11-18. Ships in 14.7.2.
