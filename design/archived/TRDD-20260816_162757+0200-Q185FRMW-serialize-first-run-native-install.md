---
trdd-id: Q185FRMW
title: Serialize the first-run native-dependency self-install in launcher.mjs
column: complete
created: 2026-08-16T16:27:57+0200
updated: 2026-08-19T09:52:00+0200
implementation-commits: [cf9026d]
current-owner: llm-externalizer-session
task-type: bugfix
approval-tier: 0
external-refs: [https://github.com/Emasoft/llm-externalizer-plugin/issues/13]
---

# Serialize the first-run native-dependency self-install in launcher.mjs

Closes issue #13. Tier 0: own repo, own scope, reversible, no baseline,
governance, or release surface. Ruling confirmed by the fleet manager session
2026-08-16.

## The defect

`scripts/llm-ext/launcher.mjs` self-installs native deps into
`~/.llm-externalizer/native` on first run. Nothing serializes that path, so two
`llm-ext` processes starting on a fresh machine race. Verified first-hand
against the working tree at `7cc4521`, not taken on a scanner's word:

| # | Site | Failure |
|---|---|---|
| 1 | `installDeps` `spawnSync(npm, {cwd: dataDir})` (~:113) | two npm processes sharing one `node_modules` — ENOTEMPTY/EEXIST mid-extract, or a spurious FATAL exit |
| 2 | `linkNodeModules` `existsSync(dst)` (~:146) then `symlinkSync` (~:182) | TOCTOU. Loser gets EEXIST; the catch assumes "Windows without Developer Mode" and falls back to `cpSync`, which throws again on the existing dst — uncaught, surfaces as a misleading FATAL |
| 3 | `dataDirHasDeps` (~:76-78), used at ~:258 | bare `existsSync` on `better-sqlite3/package.json`. A process can read "deps present" between package.json extraction and the native binary landing, then link a half-written tree |

`grep` for flock/mutex/exclusive-create over the file returns only npm's own
`package-lock.json`. No cross-process guard exists.

Race 3 is what makes this worth fixing rather than tolerating. Races 1 and 2
self-heal on retry and the window opens once per machine — on its own that is a
"do nothing" verdict. But 3 leaves a *linked* incomplete tree, so the damage
outlives the process that caused it. Reachability is not theoretical: this host
runs many concurrent Claude sessions, any of which can invoke `llm-ext`.

## The fix

One exclusive-create lock around the existing install+link critical section
(`launcher.mjs` ~:257-268):

- `mkdirSync(join(dataDir, ".install.lock"))` **without** `recursive` — atomic
  exclusive-create on POSIX and Windows, throws EEXIST when held. Stdlib only.
- **No `flock(2)`, no native addon** — ruled out fleet-wide 2026-07-17.
- Contender waits ~1s and retries, capped at the `300_000` ms already used by
  `installDeps`' spawnSync timeout. Reuse that constant; do not mint a second.
- **Re-check `dataDirHasDeps` inside the lock.** This is the line that closes
  race 3; a check outside the lock is worthless.
- Release in `finally`.
- **Stale-lock break:** if the lock dir's mtime is older than that same timeout,
  remove and retry once. Without this, one crash mid-install bricks every future
  run — strictly worse than the race being fixed.
- Existing FATAL reporting path preserved; a lock timeout surfaces through it.

Deliberate ceiling, marked in-code with a `ponytail:` comment: one global
install lock. Per-package locking only if it ever measurably matters.

**Explicitly not doing:** staging-dir + atomic-rename redesign, per-package
locks, a retry framework, any refactor the three races do not touch.

## Test — deterministic exclusion, never a real race

A test that spawns two processes and asserts both survived **passes with the
lock deleted**, because it depends on natural scheduling to produce the
collision. That test would make this card worthless. Required shape, in-process:

1. Acquire the lock.
2. Assert a second acquisition does NOT succeed while held (short timeout).
3. Release.
4. Assert the contender then does acquire and complete.
5. Stale case: create the lock, force mtime past the timeout with
   `utimesSync`, assert acquisition breaks it and succeeds.

No real sleeping anywhere — manipulate mtime. Step 2's negative assertion is
load-bearing: **neuter the lock and it must fail.** Confirm that before
reporting.

`scripts/llm-ext/vitest.config.ts` uses an EXPLICIT include list, not a glob. An
unregistered `*.test.ts` passes by hand and never runs in CI. Register it and
confirm the test name appears in a full-suite run.

## Acceptance

- [x] All three races closed by the single lock (`install-lock.mjs`, wrapped in `launcher.mjs` ~:266-283)
- [x] `mkdirSync` exclusive-create; no native addon
- [x] `dataDirHasDeps` re-checked inside the lock (launcher.mjs:272, with the no-hoist comment)
- [x] Stale-lock break present, with a comment saying why (install-lock.mjs:43-55)
- [x] Deterministic exclusion test, negative assertion verified to fail without the lock (neuter proof re-run 2026-08-19: lock bypassed → exclusion test FAILED exit=1; restored → 2/2 green)
- [x] Test registered in the vitest include list (`src/install-lock.test.ts`) and green in the v13.5.9 full-suite publish gate
- [x] `tsc --noEmit` clean; full `scripts/llm-ext` suite green (v13.5.9 publish gates: typecheck OK, test OK)
- [x] Ships correctly — launcher.mjs runs as-is (no build step), shipped in v13.5.9; issue #13 CLOSED

## Approval log

- 2026-08-16T16:27:57+0200 — Tier 0, self-authorized per the approval-tier rule;
  ruling corroborated by the fleet manager session (own repo, own scope,
  reversible, no release surface). No human approval required.
- 2026-08-19T09:52:00+0200 — COMPLETE. Implementation had already landed in
  cf9026d (2026-08-16) but the card was never advanced past `planned` — stale
  column, not missing work. This session verified every acceptance box
  first-hand: read install-lock.mjs + test + launcher wiring, re-ran the
  neuter proof (lock bypassed → exclusion test fails; restored → green),
  confirmed vitest registration, and confirmed the fix shipped in the
  v13.5.9 release (cf9026d is an ancestor of the tag). Issue #13 CLOSED.
