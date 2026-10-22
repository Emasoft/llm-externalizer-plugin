---
trdd-id: 3SFY82YX
title: Anchor the status regexes in classifyUnavailable on our own leading API error prefix
column: backburner
status: tasked
created: 2026-10-10T11:00:58+0200
updated: 2026-10-10T11:01:54+0200
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-10-10T11:00:58+0200
---

# Anchor the status regexes in classifyUnavailable on our own leading API error prefix

## Goal

classifyUnavailable (scripts/llm-ext/src/free-rotation.ts) matches its 401 guard (~567-574, TRDD-8GE0OJ5R) and STATUS_CODE_RE for 404/410 (~701) anywhere in the text. A 5xx or 404 whose body quotes an upstream 'HTTP 401' would return null and lose its transient, daily-quota or gone verdict; an upstream 'HTTP 404' inside another status would add a false gone. Anchor both on our own leading 'API error NNN' / 'HTTP NNN' form, checking first that every caller passes the message from its start.
2026-10-10T11:01:54+0200 Correction (review): the defect is INFERRED, not observed: no recorded body quotes an upstream 'HTTP 401' or 'HTTP 404' inside another status, and nobody has checked whether an OpenRouter 5xx body can contain one. Box 3 (golden snapshot) is a guard that passes on HEAD by construction.

## Acceptance

- [ ] a 502 whose body quotes an upstream 'HTTP 401' keeps its old verdict (test, failing before)
- [ ] a 5xx quoting 'HTTP 404' is not classified gone (test, failing before)
- [ ] the classifyUnavailable golden snapshot in issue16-burst.test.ts stays green
- [ ] definition of done: typecheck, lint and eslint . --quiet clean, full npm test green, one commit with the TRDD id in its subject

## Related

TRDD-8GE0OJ5R (the 401 guard), TRDD-YG72CYY7 (still-open list).

## Approval log

- 2026-10-10T11:00:58+0200 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
