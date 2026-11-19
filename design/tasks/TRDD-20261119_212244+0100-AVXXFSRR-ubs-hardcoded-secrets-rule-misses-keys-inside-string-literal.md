---
trdd-id: AVXXFSRR
title: ubs hardcoded-secrets rule misses keys inside string literals, so the pre-commit hook needs a second secret scanner
column: todo
status: tasked
created: 2026-11-19T21:22:44+0100
updated: 2026-11-19T22:05:38+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: security
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: manager
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-19T21:22:44+0100
release-via: publish
---

# ubs hardcoded-secrets rule misses keys inside string literals, so the pre-commit hook needs a second secret scanner

## Approval log

- 2026-11-19T21:22:44+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-19T21:23:00+0100 — column → todo by main-agent@llm-externalizer-plugin. queued for the next release, main agent ruling

## Problem

- The pre-commit hook (.githooks/pre-commit) relies on ubs 5.5.26 alone for hardcoded secrets. A scratch test on 2026-11-19 (ten variants of a fake sk-or-v1 key in a TypeScript test file, one ubs --staged run each, every run Files scanned 1) found the rule js.security.hardcoded-secrets flags only a property-shaped line with an unescaped quoted value: a bare object property (flagged), and a template-literal line with plain double quotes (flagged, also inside a 13-line vitest file).
- It passed, Critical 0: the key as a string array element (escaped or plain inner quotes, also in a 13-line file), as a single string, and as a template-literal line with escaped quotes. A real key written in these forms would pass the gate too.
- Mechanism, a hypothesis from the rule source (sec_hardcoded_secrets.py in the ubs install, not isolated by a test): the rule lexes each statement alone, needs the value to start with a quote right after the colon, and a colon inside a string literal is masked.
- Owner order: "fix. and ubs hook must be stricter. update homebrew version too." ubs is a third-party tool: no issue is filed on its repository from here (only Emasoft repos).

## Proposed fix

- Add a second scanner on the staged content to .githooks/pre-commit, failing closed like the ubs gate: gitleaks (available through Homebrew; the hook must fail with a clear message when it is missing), run with protect --staged or git diff --cached piped to gitleaks stdin; a project allowlist for the known fake test fixtures, each entry with a reason. Check trufflehog and detect-secrets as alternatives and record why one was chosen.

## Acceptance

- [ ] the hook refuses a staged fake key in each form ubs passed (array element, single string, escaped template line), shown by a scratch commit per form
- [ ] the existing test fixtures pass through an allowlist entry with a reason
- [ ] a missing scanner fails the commit with a message naming it
- [ ] a fake key in a staged Markdown or other non-code file is refused. The ubs gate scans no such file by design (UBS_ALLOW_NO_SCAN=1 in .githooks/pre-commit, comment: a commit that stages no scannable language is not a scan failure); commit d802a2d3 printed "UBS did not run any scanner: nothing was checked (this is NOT a pass)" and went through.

## Notes

2026-11-19T21:33:20+0100 main agent: mandated-by: manager was written when this card was created with trddgrep new. A guarded edit to none was refused ("mandated-by: is written only by the create/approve code paths, never by a generic field write"). The issuer is the main agent, as the Approval log says. The field is left as written.
