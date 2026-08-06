---
trdd-id: ad8ce78f-2fa2-420c-a473-fc706b36becc
title: Dependency security sweep — npm audit fix resolves 14 advisories + Dependabot PR 2
column: complete
created: 2026-06-09T22:42:03+0200
updated: 2026-08-06T17:35:00+0200
current-owner: claude-llm-externalizer
assignee: claude-llm-externalizer
priority: 1
severity: HIGH
effort: S
labels: [security, dependencies, dependabot]
task-type: security
approval-tier: 0
parent-trdd: null
npt: []
eht: []
blocked-by: []
relevant-rules: []
release-via: publish
delivery: direct-push
target-branch: main
publish-target: emasoft-plugins
test-requirements: [unit, typecheck]
audit-requirements: [dependency-audit]
review-requirements: []
impacts: [dependencies]
attempts: 1
test-failures: 0
last-test-result: pass
last-test-at: 2026-06-09T22:41:30+0200
implementation-commits: []
external-refs: ["github.com/Emasoft/llm-externalizer-plugin/pull/2", "github.com/Emasoft/llm-externalizer-plugin/pull/1"]
---

# TRDD-ad8ce78f — Dependency security sweep — npm audit fix resolves 14 advisories + Dependabot PR 2

**Filename:** `design/tasks/TRDD-20260609_224203+0200-ad8ce78f-dependency-security-sweep.md`
**Tracked in:** this repo (design/tasks/ is git-tracked)

## Trigger

User directive (2026-06-09): *"verify that the old open issues are still valid and not
superseded by the new issues on github repo. then implement/fix all issues valid."*

## Findings (verification pass)

1. **Issues #3–#10: all CLOSED/COMPLETED with documented fixes** — each closing
   comment names the fix commit/version (v9.11.0–v9.13.1). Spot-checked all 8 on
   2026-06-09; none need reopening, none superseded incorrectly. Zero open issues
   on `Emasoft/llm-externalizer-plugin`; zero llm-externalizer issues open on the
   `emasoft-plugins` marketplace repo.
2. **PR #1 (Dependabot, hono 4.12.5→4.12.8): CLOSED by Dependabot** ("no longer
   updatable") on 2026-03-15. hono had since reached 4.12.8 transitively — but the
   advisory surface had GROWN: `npm audit` flags hono **≤4.12.20** (15 advisories).
   So PR #1's closure left a real gap. VALID — covered by this sweep.
3. **PR #2 (Dependabot, flatted 3.4.1→3.4.2, dev): OPEN and VALID** —
   GHSA-rf6f-7fwh-wjgh (prototype pollution via `parse()`, HIGH). flatted was
   still 3.4.1 in the lockfile.
4. **`npm audit` total: 14 vulnerabilities (1 critical / 5 high / 8 moderate)**
   across 11 packages, ALL with in-range (non-breaking) fixes — including
   vitest CRITICAL GHSA-5xrq-8626-4rwp (UI server arbitrary file read/execute).

## Fix

One command, no source change: `npm audit fix` in `mcp-server/`
(updates `package-lock.json` only; `package.json` ranges already permitted all
fixed versions). Then rebuilt `dist/` so the bundled runtime deps (e.g. `yaml`)
embed the fixed versions.

| Package | Before | After | Worst advisory |
|---|---|---|---|
| vitest | 4.0.18 | 4.1.8 | CRITICAL GHSA-5xrq-8626-4rwp |
| flatted (dev) | 3.4.1 | 3.4.2 | HIGH GHSA-rf6f-7fwh-wjgh (= PR #2) |
| fast-uri | ≤3.1.1 | 3.1.2 | HIGH path traversal |
| path-to-regexp | 8.0.0–8.3.0 | 8.4.2 | HIGH ReDoS |
| picomatch | 4.0.0–4.0.3 | 4.0.4 | HIGH ReDoS |
| hono | 4.12.8 | 4.12.25 | 15 moderate advisories (≤4.12.20) |
| @hono/node-server | <1.19.13 | ≥1.19.13 | moderate middleware bypass |
| yaml (runtime) | 2.8.2 | 2.9.0 | moderate stack overflow |
| brace-expansion | ≤5.0.5 | 5.0.6 | moderate DoS ×2 |
| ip-address | ≤10.1.0 | 10.2.0 | moderate XSS |
| postcss | <8.5.10 | 8.5.15 | moderate XSS |
| qs | ≤6.15.1 | 6.15.2 | moderate DoS |

## Verification

- `npm audit` → **0 vulnerabilities** (was 14).
- `npm run build` (tsc --noEmit + esbuild) → green.
- `npm test` (zero-cost vitest suite) → **990 passed / 4 skipped (live), 0 failed**
  on the bumped vitest 4.1.8.

## PR #2 disposition

Bump applied locally on `main` (joins the 8-commit unpushed stack; push remains
user-gated). Dependabot auto-closes its PR once flatted ≥3.4.2 reaches the
default branch on the next push/publish. Commented on PR #2 with status, signed
"This is the Claude responsible for the llm-externalizer project."
