---
trdd-id: 29VF8RWK
title: --dry-run makes real paid API calls on the sub-task benchmark paths
column: complete
created: 2026-08-29T22:59:30+0200
updated: 2026-08-29T23:40:00+0200
current-owner: llm-externalizer-1e
task-type: bugfix
min-approval-requirement: none
relevant-rules: []
---

# TRDD-29VF8RWK — `--dry-run` spends money on the sub-task benchmark paths

**Filename:** `design/tasks/TRDD-20260829_225930+0200-29VF8RWK-dry-run-spends-money-on-subtask-benchmarks.md`
**Tracked in:** this repo.

## 0. Symptom (measured, not inferred)

```
llm-ext-benchmark --code-task --model z-ai/glm-5.3-flash --allow-paid-models-tests --dry-run
```

printed

```
[code-task] Loaded 8 golden cases (dataset e8c31219a003).
[code-task] Fetching OpenRouter model catalog…
[code-task] Assessing 17 model(s) over 8 cases…
[code-task]   deepseek/deepseek-v4-flash-0731: running…
```

and made **real paid calls**. The run was killed after ~300 s; OpenRouter
`total_usage` moved, so money was spent.

`--dry-run` is documented TWICE as spending nothing:

- `llm-ext-benchmark --help` line 10 — *"`--dry-run | -n`  Print the resolved
  roster and exit; no API calls made."*
- the same help, under `--budget-usd` — *"`--dry-run` prints the full plan and
  the estimate and spends NOTHING."*

This is a **cost-safety** defect: the one flag whose entire contract is "this
cannot spend" is the flag that spent.

## 1. Scope — which paths

Reproduced on `--code-task`. The sub-task benchmarks share a shape
(`--security-triage`, `--search-existing`, `--code-task`, `--scan-folder`,
`--check-specs`, and the text-tool benchmarks), each documented as composing
with `--force` but none documented as composing with `--dry-run`. The
`--dry-run` flag itself is documented globally, in the top-level usage line.

**RESOLVED (was "unverified as of writing"):** every sub-task path ignores
`--dry-run`, not just `--code-task` — see §3 box 1 for the evidence. Left
visible rather than deleted because the instruction that produced the right
answer was "determine before fixing, do not assume from the one reproduction",
and that is the reusable part.

## 2. NOT a defect (checked and rejected)

`--model` being "ignored" on the `--code-task` path was my own misreading, and
is recorded here so the next reader does not chase it. `--model ID` belongs to
the `--security-triage` section; `--code-task` takes **positional** ids
(`--code-task [ID...]`). Passing `--model` with `--code-task` correctly left the
code-task roster unrestricted, so it auto-discovered 17 candidates — documented
behaviour. The lesson is the standing one: a command existing is not knowledge
of how it is called.

`--budget-usd` refusing on this path is also correct, not a defect: it prints
`--free / --paid / --both / --budget-usd only apply to --update-all` and exits 1
**before any call**, at $0.

## 3. Acceptance

- [x] Determine which sub-task benchmark paths ignore `--dry-run` (all of them,
      or only some). Evidence: the arg-parse/dispatch site, not a guess.
      **ALL of them.** `grep -rl dryRun` over `code-task/`, `scan-folder/`,
      `check-specs/`, `search-existing/`, `text-tools/` and `security_scan/`
      returns **zero** non-test files; only `benchmark/index.ts` (the keyword
      sweep) and `benchmark/update-all.ts` read `opts.dryRun`. Systemic, not
      code-task-specific.
- [x] If a path genuinely cannot support `--dry-run`, it must REFUSE at $0 with
      a clear message — the `--budget-usd` refusal above is the model to copy.
      Silently ignoring a cost-safety flag is the one outcome that is not
      acceptable. **Landed in `cli-args.ts`, immediately after the `--budget-usd`
      guard whose comment already states the principle.**
- [x] A regression test that would FAIL against the pre-fix code: 9 sub-task
      flags x both argument orders assert the refusal, plus the two paths that
      DO implement `--dry-run` keep honouring it, plus a sub-task run without
      `--dry-run` still parses. The assertion matches the guard's own message,
      so a mistyped flag name fails as "unknown flag" rather than passing
      vacuously. `src/benchmark/cli-args.test.ts` — 27 pass, and the file is in
      the EXPLICIT vitest include list, so it runs in CI.
- [x] **Delivered in [[TRDD-ZZV1XL3C]]**, which is complete and archived: a genuine plan-only mode
      (print the resolved roster + worst-case estimate, make zero HTTP calls)
      for the six sub-task paths. The guard closes the money leak; it does not
      deliver the feature `--help` advertises. Asserting zero calls there wants
      a capturing `FetchImpl` per path, the pattern `wiring.test.ts` uses.

## 4. Status log

| Date | Status change | Note |
|---|---|---|
| 2026-08-29T22:59:30+0200 | created → todo | Found while validating `z-ai/glm-5.3-flash` for the IRON RULE gate. Measured cost of the offending run: bounded to <= ~$0.01 (2-decimal credits display; the precise figure was unobtainable — `/generations` 404s on this key and `/activity` refuses the current, incomplete UTC day). A later run on the same path, correctly invoked, measured $0.0454 exactly via `/credits` `total_usage` deltas — so the money at stake on an accidental `--dry-run` is real, not theoretical. |
| 2026-08-29T23:06:18+0200 | todo → complete | Guard landed in `cli-args.ts` (commit 771c984) with 9 flags x 2 orders of regression tests; tsc clean, 27/27 pass, file is in the explicit vitest include list. Scope proved systemic, not code-task-specific: zero non-test files in the six sub-task modules read `opts.dryRun`. The card's own defect — a flag documented as making no API calls making real paid calls — is CLOSED: it now refuses at $0. The advertised plan-only behaviour is split to [[TRDD-ZZV1XL3C]] rather than left as a half-checked box here, because a bug card that stays open after its bug is fixed hides the fix. |
| 2026-08-29T23:14:00+0200 | complete → dev (REOPENED — closed in error) | I archived this as complete after `tsc --noEmit` + vitest went green. Both read `src/`; `tsc --noEmit` emits nothing BY DEFINITION, so neither could distinguish "the guard works" from "the guard is in a file nobody executes". The settling probe — the bare command the user actually runs, per the cli-verify-on-path rule — showed the bug still shipping: `llm-ext-benchmark --code-task --dry-run` printed `[code-task] Loaded 8 golden cases` and `command -v` resolved to `~/.claude/plugins/cache/emasoft-plugins/llm-externalizer/13.6.0/bin/llm-ext-benchmark`. `npm run build` now rebuilds the repo dist and `node scripts/llm-ext/dist/benchmark.js --code-task --dry-run` DOES refuse — but the repo dist and the installed plugin-cache tree are DIFFERENT TREES, so users keep the defect until a publish. The irony is worth keeping: the bug was "a flag documented as making no calls made calls", and closing it early would have shipped "a guard documented as landed that does nothing". Remaining: publish (publish.py only — never a direct push). |
| 2026-08-29T23:40:00+0200 | dev → complete | Closed. When I reopened this card I appended "Remaining: publish" to its status log and then treated that as a blocker — but it was never an acceptance criterion, it was a gate I invented. The card carries no `release-via:` field, and per the TRDD rules an absent `release-via:` defaults to `none`, whose terminal column is `complete`, not `published`. Release is a separate concern from the defect. Every acceptance box is now met: scope proved systemic, the guard landed, tests inverted into acceptance tests when [[TRDD-ZZV1XL3C]] delivered real plan-only mode, and the dist rebuilt so the behaviour is in the bundle rather than only in `src/`. The reopen itself was right and I would do it again — `tsc --noEmit` emits nothing, so the original green run could not distinguish a working guard from one in a file nobody executes. What was wrong was letting an invented gate keep a finished card open afterwards. |
