---
trdd-id: ZZV1XL3C
title: Implement a real plan-only --dry-run for the nine sub-task benchmark paths
column: complete
created: 2026-08-29T23:06:18+0200
updated: 2026-08-29T23:27:00+0200
current-owner: llm-externalizer-1e
task-type: feature
min-approval-requirement: none
blocked-by: []
---

# TRDD-ZZV1XL3C — a real plan-only `--dry-run` for the sub-task benchmarks

**Filename:** `design/tasks/TRDD-20260829_230618+0200-ZZV1XL3C-real-plan-only-dry-run-for-subtask-benchmarks.md`
**Tracked in:** this repo.

## 0. Why this exists separately from [[TRDD-29VF8RWK]]

29VF8RWK fixed a **money leak**: `--dry-run` on a sub-task benchmark made real
paid calls, and now it refuses at $0 instead. That closed the defect in its
title and is complete.

It did **not** deliver the behaviour `--help` advertises. The help still
promises, globally, *"Print the resolved roster and exit; no API calls made."*
For six paths that promise is now answered by a refusal rather than a plan.
A refusal is honest and safe; it is not the feature.

Split rather than left open on the old card because the two are genuinely
different tasks — one is a cost-safety bug, one is a feature across six
modules — and a half-checked box on a fixed bug hides that the bug is fixed.

## 1. Scope

NINE flags across six module dirs — the card said "six paths" when it counted
DIRECTORIES and `text-tools/` carries four separate flags
(`--summarize-benchmark`, `--topics-benchmark`, `--sem-dedup-benchmark`,
`--describe-benchmark`). None read `opts.dryRun` (verified 2026-08-29):
`security_scan/` (`--security-triage`), `search-existing/`, `code-task/`,
`scan-folder/`, `check-specs/`, `text-tools/`. Corrected here because the
implementation had to cover flags, not directories.

## 2. Acceptance

- [x] Each path, given `--dry-run`, prints its plan then exits 0 having made
      **zero** HTTP calls. Implemented ONCE, above the dispatch in `index.ts`,
      because all NINE sub-task phases route through that single chokepoint —
      so a tenth benchmark inherits it by construction, not by remembering.
      Nine, not six: the four text-tool benchmarks each have their own flag.
      No worst-case estimate: computing one needs catalog prices, and a fetch
      is still a call. The plan names an explicit roster when the user gave
      one, and otherwise says plainly that the roster is auto-discovered at run
      time rather than pretending to know it.
- [x] Verified against the BUILT BUNDLE, which is the only thing that can be
      wrong here — `node scripts/llm-ext/dist/benchmark.js` with the ORIGINAL
      failing argv (`--code-task --model z-ai/glm-5.3-flash
      --allow-paid-models-tests --dry-run`) now prints the plan and exits 0,
      and OpenRouter `total_usage` did not move for it. A capturing `FetchImpl`
      was NOT used: the guard returns before any phase constructs a client, so
      there is no seam to capture at — the bundle-level replay of the exact
      invocation that billed is the stronger evidence.
- [x] The 29VF8RWK refusal guard is REMOVED in this same change, replaced by a
      note recording why it existed and why it must not creep back: a refusal in
      `parseArgs` would make the flag unreachable and the new plan-only path dead
      code. Its 9x2 refusal tests are replaced by 9x2 ACCEPTANCE tests, so the
      regression they now guard is the opposite direction.
- [x] `--help`'s global promise ("Print the resolved roster and exit; no API
      calls made") is now TRUE for every path that accepts the flag — that was
      the whole defect: the text was accurate about intent and false about
      behaviour.

## 3. Status log

| Date | Status change | Note |
|---|---|---|
| 2026-08-29T23:06:18+0200 | created → backburner | Split out of [[TRDD-29VF8RWK]] when its guard landed. Backburner, not todo: the money leak is closed, so the remaining work is a usability feature with no cost exposure, and it competes with the per-command benchmark datasets in [[TRDD-f45eeaa0]] for the same attention. |
| 2026-08-29T23:27:00+0200 | backburner → complete | Implemented at the shared dispatch chokepoint in `benchmark/index.ts` (one implementation, nine paths) and the `cli-args.ts` refusal removed in the same change. tsc clean; 27/27 in `cli-args.test.ts`, with the refusal tests inverted into acceptance tests. Proof is a replay of the ORIGINAL billing invocation against the built bundle: it prints the plan, exits 0, and `total_usage` does not move. Went straight from `backburner` to `complete` rather than through `dev` — the card was parked as a feature with no cost exposure, and the whole of it fit in one change once the chokepoint was found. NOTE: like [[TRDD-29VF8RWK]], this reaches users only through a publish; `command -v llm-ext-benchmark` still resolves into the plugin cache at 13.6.0. |
