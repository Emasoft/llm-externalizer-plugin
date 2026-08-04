---
trdd-id: SCLGL8T4
title: --preview — dry-run file selection with per-file exclusion reasons
column: todo
created: 2026-08-05T00:06:05+0200
updated: 2026-08-05T00:06:05+0200
current-owner: llm-externalizer-session
task-type: feature
---

# --preview selection dry-run (distilled from OpenCodeReview, NOT vendored)

## What

A global `--preview` flag (sibling of `--estimate`, a4b19bc): resolve the file set
exactly as the run would and print each file with its verdict — included, or
excluded WITH THE REASON (`gitignored`, `extension filter`, `excluded dir`,
`over size cap`, `unsupported`). Zero LLM sends. Complements `--estimate`
(which prices the selection): `--preview` answers *what*, `--estimate` answers
*how much*.

## Why (evidence)

OCR's `delegate preview` exclusion reasons (`excluded: unsupported_ext`) caught a
scope surprise instantly during the three-way test; our walker exposes no reasons —
a mis-scoped scan is discovered only after paying for it.

## Constraints

No UI, plain greppable stdout, works with zero config (Auto-DUBC), crossplatform.
Implementation: thread a reason channel through walkDir/resolveFolderPath instead
of a second walker — ONE source of truth for selection (never a parallel copy that
drifts).

## Acceptance

- [ ] `llm-ext scan-folder --preview --folder_path src/` lists every candidate with
      verdict+reason; exit 0; zero sends
- [ ] `--preview --estimate` composes (selection + price in one dry-run)
- [ ] walker emits reasons via the SAME code path the real run uses (drift-proof);
      unit tests cover each exclusion class
