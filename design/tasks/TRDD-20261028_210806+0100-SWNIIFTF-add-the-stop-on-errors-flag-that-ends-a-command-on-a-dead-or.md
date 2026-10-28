---
trdd-id: SWNIIFTF
title: Add the --stop_on_errors flag that ends a command on a dead or missing model
column: todo
status: tasked
created: 2026-10-28T21:08:06+0100
updated: 2026-10-28T21:08:06+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-10-28T21:08:06+0100
---

# Add the --stop_on_errors flag that ends a command on a dead or missing model

The user ruled on 2026-10-28, verbatim: "no, maybe i'm wrong.. it should do by default the fallback in case of errors. instead the optional flag --stop_on_errors will make it fail and exit if a model is not responding or not found. But beware: not having enough memory is not a failure, it only put the requests in a queue, waiting fot the memory to be freed enough to run another request pending."

Scope: add the optional global flag --stop_on_errors (also --stop-on-errors) to every llm-ext command. Default behaviour is unchanged: on a model that does not respond, is not found, or whose local server fails, the profile fallback chain is walked. With the flag, the first such failure ends the command with a non-zero exit and an error naming the model and the cause. Low memory is never a failure: a local request waiting in the broker queue for memory does not trigger the flag. The flag supersedes the dropped --no_stop_on_fail idea. Related cards: TRDD-1OOAH3LD, TRDD-ZGSGGHQG (broker design points 6 and 15 in design/specs/local-engine-broker-design.md).

Done when: tests prove (a) a default run falls back on a dead model, (b) the flag exits non-zero on the same dead model, (c) a request queued for memory with the flag set still completes.

## Approval log

- 2026-10-28T21:08:06+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
