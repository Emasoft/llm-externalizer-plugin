---
trdd-id: W9DK4L3N
title: Retire the legacy dist-cli entry point so llm-ext is the only runtime surface
column: planned
approval-tier: 3
created: 2026-08-06T18:01:10+0200
updated: 2026-08-07T15:20:00+0200
scope-approved: option-A-only
current-owner: claude-llm-externalizer
assignee: null
priority: 2
severity: HIGH
effort: M
labels: [migration, public-api, breaking, cli]
task-type: refactor
parent-trdd: null
npt: []
eht: []
blocked-by: []
release-via: publish
target-branch: main
test-requirements: [unit, typecheck, lint]
review-requirements: [human-review]
impacts: [public-api]
---

# Retire the legacy `dist/cli.js` entry point — one runtime surface, not two

## Why this is a proposal and not a task

It changes a **published npm bin**, which is a breaking public-API change. Tier 3 — your call,
not mine. Everything below is measured, so the decision can be made on facts.

## ⏵ STATE — the measured situation (2026-08-06)

The v11.0.0 migration retired the MCP server and made `llm-ext` the supported surface. It did
**not** retire the older standalone bundle, so the plugin ships **two** runtime entry points:

| | supported surface | legacy bundle |
|---|---|---|
| entry | `bin/llm-ext` → `scripts/llm-ext/dist/llm-ext.js` | `scripts/llm-ext/dist/cli.js` |
| built from | `src/cli/main.ts` | `src/cli.ts` |
| how it is reached | `$CLAUDE_PLUGIN_ROOT/bin/llm-ext` (plugin users) | `npm i -g` → the `llm-externalizer` binary |
| declared in package.json | **not a bin at all** | `bin: { "llm-externalizer": "dist/cli.js" }` |

**The published npm package advertises only the legacy entry point.** An npm consumer who
installs `llm-externalizer` today gets the surface the migration was supposed to replace.

**Behavioural divergence, verified:** `grep -rn "ensureAutoFreeDecided\|autoFreeEngaged"
scripts/llm-ext/src/mass_scouting/ scripts/llm-ext/src/cli.ts` returns **zero hits** — the
auto-free-on-low-balance protection does not exist on the legacy path. A user on that path can
be billed in a situation where the supported path would have switched to free models. That is
TRDD-8d8d33c8, and it is a symptom, not the disease.

**Capability overlap, verified** — the legacy CLI's own unknown-command message
(`src/cli.ts:974`) lists exactly 7 subcommands. Checked against the real catalog:

| legacy subcommand | in `llm-ext`? |
|---|---|
| `cluster-synonyms`, `high-quality-scan`, `security-scan`, `mass-scout` | yes, same names |
| `model-info` | yes, as `or-model-info` |
| `search-existing` | yes, as `search-existing-implementations` |
| **`profile`** | **NO — this is the only unique capability** (TRDD-K3PW7Q2M) |

So once `profile` is ported, the legacy bundle carries **zero unique function** and exists only
to behave differently from the supported surface.

## Options

**A — Unify behaviour, keep both names (NON-breaking).** Port `profile` into the `llm-ext`
catalog, then make `dist/cli.js` a thin shim that dispatches into the same catalog as
`llm-ext`. Both binaries keep working, both gain auto-free, divergence ends. Closes 8d8d33c8
and K3PW7Q2M as a side effect.

**B — A, then re-point the npm bin (BREAKING at the name level).** After A, change
`bin` to `{ "llm-ext": "dist/llm-ext.js", "llm-externalizer": "dist/llm-ext.js" }` so the
documented name is installable and the old name still resolves. Anyone invoking
`llm-externalizer <cmd>` keeps working; only someone depending on the old bundle's *distinct*
behaviour breaks — and that behaviour is the bug.

**C — Do nothing.** Two surfaces, one of them billing users the other would have protected, and
docs that must forever explain which is which. Not recommended; recorded so the choice is real.

**Recommendation: A now, B at the next major.** A is behaviour-only and reversible; B is the
one-line manifest change once A has proven stable.

## Acceptance (if approved)

- [ ] `profile` available in the `llm-ext` catalog (absorbs TRDD-K3PW7Q2M)
- [ ] one shared dispatch path; `dist/cli.js` holds no independent command logic
- [ ] auto-free-on-low-balance provably active on BOTH entry points (test, not inspection) —
      absorbs TRDD-8d8d33c8
- [ ] no capability reachable from only one binary
- [ ] unit + typecheck + lint clean; dogfood exercises both entry points
- [ ] (option B only) `package.json` bin re-pointed, CHANGELOG records the change as breaking

## Approval log

- 2026-08-07T15:20:00+0200 — **APPROVED, OPTION A ONLY** (tier 3). The owner was presented with
  A / B / C and the trade, and delegated the decision verbatim: *"do as you think is better."*
  That is a real human decision on a tier-3 item, so it authorizes the non-breaking half.
  **Option B (re-pointing the published `bin`) is NOT approved and is NOT in scope.** Rationale
  for the split: A removes an active billing exposure — the published entry point can spend where
  the supported one would have switched to free models — and is behaviour-only, reversible, and
  invisible to anyone's install. B renames a published binary, which is irreversible for existing
  consumers and carries no urgency once A has removed the behavioural difference. Reopen B as its
  own decision at the next major, with the CHANGELOG breaking note it deserves.
- Scope of this approval, concretely: unify the dispatch path so `dist/cli.js` holds no
  independent command logic, so BOTH entry points inherit auto-free-on-low-balance. Closes
  TRDD-8d8d33c8. `package.json` `bin` is untouched.
