---
trdd-id: 0ETFCKCU
title: npm audit reports 19 vulnerabilities in scripts/llm-ext dependencies
column: todo
status: tasked
created: 2026-11-14T12:26:20+0100
updated: 2026-11-16T10:11:21+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: security
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-14T12:26:20+0100
blocked-by: []
pre-block-column: 
unblock-when: []
blocker-probe: 
blocker-holds-if: 
---

# npm audit reports 19 vulnerabilities in scripts/llm-ext dependencies

## Approval log

- 2026-11-14T12:26:20+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-14T12:45:49+0100 — column → blocked by main-agent@llm-externalizer-plugin. zod commit waits for a full suite; better-sqlite3 binding missing, rebuild needs the user

## Problem

2026-11-14T12:26+0100 npm ci --ignore-scripts in a fresh worktree at e02c93ea (TRDD-NQMW9AK5) reported 19 vulnerabilities: 1 low, 12 moderate, 6 high; untriaged. The lock repair changed no dependency entry, so they predate it. Earlier sweep: archived TRDD-AD8CE78F (npm audit fix, 14 advisories); this is a new occurrence.

## Evidence

2026-11-14T12:26+0100 npm audit --json counts: info 0, low 1, moderate 12, high 6, critical 0, total 19. High packages (fixAvailable true for all): brace-expansion (6 advisories: DoS via exponential-time, unbounded-length, unbounded-array and recursion expansion, and quadratic rewrite), nanoid (2: infinite loop with zero or negative size), postcss (2: path traversal via previous source map auto-loading; incomplete fix of GHSA-6g55-p6wh-862q), source-map-js (1: event-loop DoS via indexed section offsets), vite (5: cross-origin script execution via custom middleware; server.fs.allow bypass; launch-editor arbitrary command execution, existence-check bypass and escapeCmdArgs escaping on Windows), zod (1: memory exhaustion on oversized constrained collections). JSON: reports_dev/npm-audit/20261114-wt-e02c93ea-audit.json
2026-11-14T12:28+0100 Correction and completion of the 12:26 line (orchestrator read the audit JSON, local and gitignored: reports_dev/npm-audit/20261114-wt-e02c93ea-audit.json): npm counts vulnerable packages; the sixth high package, missing from the 12:26 list, is zod, a DIRECT runtime dependency (package.json dependencies: better-sqlite3, gpt-tokenizer, yaml, zod), so it is bundled into the shipped dist. Advisory GHSA-mrhx-c7xc-m3w5, Zod can exhaust memory while validating oversized constrained collections, affects <4.6.6; the lock pins zod 4.4.3 and package.json allows ^4.4.3, so 4.6.6 is inside the declared range. The other five high packages (brace-expansion, nanoid, postcss, source-map-js, vite) are transitive with no direct dependent listed, each at one node_modules path; vite and postcss come from the dev tooling (vitest), so they are dev-only unless shown otherwise. fixAvailable is the plain value true for all six (no semver-major bump object).

## Acceptance

- [ ] each high or critical advisory is fixed by a dependency update that keeps npm ci and the full test suite green, or recorded with the reason it does not apply
- [ ] moderate and low advisories triaged the same way
- [x] each high advisory is classified runtime or dev-only with evidence (npm ls or the bundle)
- [ ] Rerun the 15 sqlite-backed test files on zod 4.6.7 once TRDD-G0MS9B63 is resolved (needs the better-sqlite3 binding)

## Notes

2026-11-14T12:43+0100 zod 4.4.3 to 4.6.7 prepared, NOT committed (working tree: package.json and lock zod ^4.6.7, node_modules/zod 4.6.7 with integrity sha512-g8W2D2kU6a8untc053fX1uVBKzM7yqAxW/3zwk83+6RyF2+SKOuV+c0wBDhUwzV1PaGapmZH+rmcUzPf+3CGwg==, dist/llm-ext.js rebuilt). First install attempt was refused by jr-pkg-guard because it parsed the unexpanded $PKG and the redirect > as package names; the retry used literal paths with no redirect, so the guard checked zod and allowed it. Checks passed: 4.6.7 and 4.6.6 share publisher (GitHub Actions trusted publishing, approver colinhacks); npm audit signatures 173 verified; build (tsc + esbuild) and eslint exit 0; probe classify filter with zero propositions prints the same zod message and exit 1 before and after; npm audit after: zod absent, 5 high (brace-expansion, nanoid, postcss, source-map-js, vite), 18 total; a fresh npm ci of the new lock in builds_dev/wt-nqmw9ak5 rebuilds byte-identical dist/llm-ext.js and dist/benchmark.js (shasum e5b3276e and e3a944b8). Report reports_dev/npm-audit/20261114_124210+0100-zod-bump.md.
2026-11-14T12:43+0100 Runtime or dev-only, from npm ls in the fresh worktree: brace-expansion via eslint > minimatch; nanoid, postcss, source-map-js via vitest > vite > postcss; vite via vitest; npm ls --omit=dev lists none of the five. All five remaining high advisories are dev-only; zod was the only runtime one.
2026-11-14T12:45+0100 Blocker: the full npm test failed 196 tests in 15 files (5782 passed); every inspected failure is better-sqlite3 Could not locate the bindings file, but not all 196 were inspected, so a zod regression on sqlite-backed paths (mass_scouting, cluster, scout) is not ruled out. Cause: the plan ran npm ci in the main tree while the global npm config has ignore-scripts true, so the native binding the old node_modules had was not rebuilt; the pkg-manager-guard hook blocks agents from re-enabling install scripts. Only the user can rebuild (an npm rebuild of better-sqlite3 in scripts/llm-ext with install scripts enabled); a local card on the maintainer machine tracks it. The zod commit waits for a green full suite after that rebuild.
2026-11-14T12:47+0100 Blocked by TRDD-G0MS9B63 (better-sqlite3 binding missing; full suite cannot run). The earlier blocker note mentions a local tracking card; the project-visible blocker is TRDD-G0MS9B63.
2026-11-14T12:48+0100 Do not publish a release until TRDD-G0MS9B63 is resolved and the 15 sqlite-backed test files pass against zod 4.6.7 (commit 67f3a89f shipped it with those files unrun). The high-advisory acceptance box stays open: zod still needs the green full suite, and the five dev-only advisories are classified but neither fixed nor accepted with a recorded reason; accepting them is a decision for the user.
2026-11-14T12:53+0100 Moved back to todo: only the rerun of the 15 sqlite test files needs the binding, so it is now a checklist box naming TRDD-G0MS9B63; the advisory accept-or-fix decision does not need it. The do-not-publish note still holds.
2026-11-14T12:58+0100 Correction to the 12:53 note: only the accept branch of the advisory decision is binding-free. Fixing a dev-only advisory still needs the green full suite (the first acceptance box), so it waits for TRDD-G0MS9B63 too. The same rerun is tracked on TRDD-G0MS9B63 and on TRDD-S5KOOT2S box 2; tick them together.
2026-11-14T19:11:41+0100: TRDD-EH91LD5F fixed the high alerts on postcss, source-map-js and brace-expansion in the npm lock (2e18ac01). vite 8.0.16 was kept on purpose: GHSA-587h-7wmj-h5pm affects the dev server on Windows only. After that, npm reported 13 remaining (1 low, 12 moderate); this card owns them.
2026-11-14T19:13:26+0100: triage after 2e18ac01, from npm audit --package-lock-only (reports_dev/npm-audit/20261114-after-2e18ac01-audit.json): 14 total (1 high, 12 moderate, 1 low), and npm ls --omit=dev --package-lock-only lists none of them, so ALL are dev-only. HIGH vite: 5 advisories, all for its dev server: launch-editor GHSA-698v-4r3x-3vcv, GHSA-r825-w8mm-5pxw and GHSA-587h-7wmj-h5pm (Windows or editor launch), cross-origin script through custom middleware GHSA-9jrq-w75r-8gcw, and files outside server.fs.allow GHSA-rq7h-c2jc-7f22. MODERATE vitest and @vitest/mocker: GHSA-82fw-gwwq-j7x9 (fixed in 4.1.11) and GHSA-qxg6-89mg-rqv8 (fixed in 4.1.12); the lock has vitest 4.1.8, so this is a patch fix inside ^4.0.18. MODERATE minimatch through eslint and typescript-eslint: the fix is a major (typescript-eslint 8.36.0). MODERATE @humanfs/node (recursive copy follows symlinks) and @eslint/config-array, both through eslint. LOW esbuild: dev server on Windows; the fix is a major (0.28.2). PROPOSED next step: patch-bump vitest to 4.1.12 or later in the lock, and check whether that also lifts vite past its fixed versions. It needs the green full suite (TRDD-G0MS9B63), per the 12:58 note. Major bumps (typescript-eslint, esbuild) and accepting the dev-server-only advisories are USER decisions. NOTE: 2e18ac01 (TRDD-EH91LD5F) bumped the dev-only postcss, source-map-js and brace-expansion in the lock with no full-suite run, against the 12:58 note. Include those versions in the full-suite run after TRDD-G0MS9B63, which takes a fresh npm ci, not npm rebuild alone.
2026-11-16T10:08:22+0100 Main agent: 170f9f5b bumps vitest ^4.1.12 and eslint ^10.15.0; audit 14 -> 8 (7 moderate, 1 low, 0 high), all dev-only; no runtime lock entry changed (41 of 41, version and integrity); better-sqlite3 binding loads; tsc and eslint exit 0. AGENT DECISION (the USER may veto), under the 2026-11-15 delegation: accept the remaining 8. typescript-eslint chain: its newest 8.72.2 is still in the minimatch advisory range, no in-range fix. esbuild: the advisory is its development server; esbuild.config.mjs only calls build(). The sqlite-file rerun box stays open for the full suite before the push.
2026-11-16T10:11:21+0100 Main agent: box 2 unticked again; the moderate fixes (vitest, eslint chain) are triaged and committed but not yet run under the full suite, which runs once before the push.
