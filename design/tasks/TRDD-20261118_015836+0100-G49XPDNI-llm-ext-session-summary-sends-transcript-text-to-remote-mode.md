---
trdd-id: G49XPDNI
title: llm-ext session-summary sends transcript text to remote models without redacting secrets
column: todo
status: tasked
created: 2026-11-18T01:58:36+0100
updated: 2026-11-18T02:38:40+0100
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
---

# llm-ext session-summary sends transcript text to remote models without redacting secrets

## Approval log

- 2026-11-18T01:58:36+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## USER decision

USER 2026-11-18 verbatim: "it is ok to send the session to openrouter free models, as long as you redact all secrets with the secrets-shield scanner of the janitor plugin (not sure if it is already installed)"

## Description

Measured 2026-11-18. llm-ext session_summary has no secret redaction; its only redaction is of inline data:image base64 URIs (scripts/llm-ext/src/session_summary/transcript.ts:118). The janitor 3.9.8 transcript senders (compose_agent_handoff.py, summarize_previous_session.py, llm_ext_compact.py, jev_compact.py) have no secret-redaction step either (grep for redact, shield, sanitiz, secret). The janitor shield core ships in report-sanitizer as `sanitize-reports --stdin`; on this session's 97.9 MB transcript it ran in 120 s, exit 0, 11456 replacements (cred, email, identity, path, token, url), but 11 of 35795 output lines no longer parse as JSON: on raw JSONL text the cred rule for `const token = ...` consumed the backslash of an escaped quote. So redaction must run on decoded string values (or on the rendered text llm-ext builds from the transcript), not on raw JSONL. To decide: vendor the shield core (TypeScript) into llm-ext, or call sanitize-reports, which exists only on machines with the report-sanitizer checkout. Done when session-summary sends no chunk that was not redacted with the shield rules, a test shows a fake secret in a transcript never reaches the request body, and tsc and eslint are clean.

## Progress

2026-11-18T02:38:39+0100 The janitor session offered a redaction bridge on 2026-11-18: hooks/secret-shield/redact_bridge.ts of the janitor source tree, not in installed janitor 3.9.8, to ship with 3.9.9; until then copy the whole hooks/secret-shield/ folder at janitor commit 4c46d82c. Protocol: one JSON request per stdin line {op all, t, homes, passes}, one response per line {t, h}; treat an error line, a non-zero exit, a timeout or a missing response as do-not-send. Limits: each request is redacted on its own, with no sweep across lines; rules that need the key beside the value need the raw line. Plan: per line, raw-line redaction first; if the result still parses, also redact its decoded string leaves; if not, redact the decoded leaves of the original line plus each key-value pair rendered as JSON.stringify(key) + ': ' + JSON.stringify(value); refuse the whole transcript if any line still fails. Not measured with the bridge yet: the 11 unparseable lines seen on 2026-11-18 came from whole-file sanitize-reports raw-text redaction. Open: per-line redaction does not catch a secret repeated elsewhere without context, so it does not yet meet the USER condition to redact all secrets.
