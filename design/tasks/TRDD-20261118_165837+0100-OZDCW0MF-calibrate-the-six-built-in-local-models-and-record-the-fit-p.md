---
trdd-id: OZDCW0MF
title: Calibrate the six built-in local models and record the fit per model
column: todo
status: tasked
created: 2026-11-18T16:58:37+0100
updated: 2026-11-18T17:08:07+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: infra
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-18T16:58:37+0100
parent-trdd: 1OOAH3LD
derived: true
---

# Calibrate the six built-in local models and record the fit per model

Child of TRDD-1OOAH3LD (local_llama) and TRDD-ZGSGGHQG (locals-mlx), both left open; this card is an eht of both. Also serves TRDD-TYHKAKCB (ruling D2 = A: the LFM3 GGUF via local_llama is the local model for session summaries, calibrated first on this card). Source: reports_dev/open-cards/20261118_162804+0100-set1-report.md. Scope: run llm-ext models calibrate --model <id> one model at a time in the foreground (status first with llm-ext models calibration-status); decide what the LFM3 MLX unfit result is (re-run, model swap, or harness bug); record the safe context fill per model. WATCH: hours of CPU and RAM, never concurrent with a publish or the test suite; use only models already in the Hugging Face cache; a download needs its size shown first (TRDD-4AKLHLB4 decision 2); freeing disk is the USER. Evidence at 2026-11-18: no record in the repo proves all six models calibrated (the 1OOAH3LD STATE CURRENT STATE of 2026-11-16T20:56:09 item 1 is itself INFERRED from a worker audit).

## Approval log

- 2026-11-18T16:58:37+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
