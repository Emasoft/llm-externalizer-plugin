---
trdd-id: W9DK4L3N
title: Retire the legacy dist-cli entry point so llm-ext is the only runtime surface
column: dev
approval-tier: 3
created: 2026-08-06T18:01:10+0200
updated: 2026-08-11T20:22:00+0200
scope-approved: option-A-and-B
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

## ⏵ OPTION A DONE 2026-08-07 — option B still NOT approved

`src/cli.ts` now consults the supported path's own pre-flight
(`resolveMassScoutFreeModelOverride`, `index.ts:971`) through a new side-effect-free module
`src/cli-mass-scout-free.ts`, instead of carrying its own model-resolution logic. `parseFlags`
was deduplicated out of `cli.ts` into that module rather than left in two places.

Only the six model-aware / spend-capable subcommands are intercepted
(`register`, `estimate`, `scout`, `propose-fieldset`, `chain`, `security-scan`); everything else
returns argv byte-for-byte, so the read-only subcommands keep their zero-network-call behaviour.
`security-scan` needed a different injection point because its model lives inside the
`--input-json` payload rather than in a flag.

Verified: suite 1795 passed / 0 failed, `tsc --noEmit` clean, lint clean, `npm run build` green,
and the fix confirmed present in the rebuilt `dist/cli.js`. Closes TRDD-8d8d33c8.

**`package.json` was not touched — `bin` is still `{"llm-externalizer": "dist/cli.js"}`.**
Option B stays unapproved; it is a deliberate breaking change for a future major, not a
side effect of a bugfix.

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

- [x] `profile` available in the `llm-ext` catalog (absorbs TRDD-K3PW7Q2M) — verified
      `definitions.ts:655` + `./bin/llm-ext profile --help` exit 0. K3PW7Q2M archived.
- [ ] one shared dispatch path; `dist/cli.js` holds no independent command logic — **NOT MET.**
      `src/cli.ts` is still an esbuild entry point (`esbuild.config.mjs:68-69`) with its own
      command table, and tests still read it. It is retired as the PUBLISHED entry point (nothing
      installs it any more) but is not gone as code. See "Remaining" below.
- [x] auto-free-on-low-balance active on BOTH entry points — closed at the cause by option A
      (`d0c6c69`): one shared resolver via `src/cli-mass-scout-free.ts`, so there is no second
      copy that can drift. Moot for the published surface as of option B (both bin names now run
      the same bundle). TRDD-8d8d33c8 archived as superseded.
- [x] no capability reachable from only one binary — `bin` maps BOTH `llm-ext` and
      `llm-externalizer` to `dist/llm-ext.js`, so the published names are the same program.
      All seven legacy verbs RESOLVE; two needed new aliases (below).

      **CORRECTION — my verification was weaker than the claim I drew from it.** I tested
      `<verb> --help` for all seven and reported "all seven exit 0". That proves VERB RESOLUTION,
      not ARGUMENT CONVENTION, and the two differ: the legacy CLI took the model id
      POSITIONALLY (`llm-externalizer model-info <id>`, `src/cli.ts:890,893`) while this CLI
      accepts only named flags. Measured: `./bin/llm-ext or-model-info "google/gemini-2.5-flash"`
      exits 1 ("unexpected argument"); `--model "google/gemini-2.5-flash"` exits 0.
      So a legacy npm user's REAL invocation still breaks — the alias restores the verb, not the
      calling convention. This is covered by the `BREAKING CHANGE:` footer on `15eb6e4`, but the
      breakage is broader than that footer implies and should be stated plainly in release notes.
      Open question for a follow-up: translate the legacy positional into `--model` inside the
      alias, or accept it as part of the declared break.
- [x] unit + typecheck + lint clean — vitest 1832 pass / 0 fail / 4 skip, `tsc --noEmit` clean,
      `eslint` clean, all re-run independently on a quiet machine.
- [x] (option B only) `package.json` bin re-pointed; the breaking change is recorded in the
      commit as `feat(cli)!` + a `BREAKING CHANGE:` footer. NOT hand-written into CHANGELOG.md
      on purpose — `publish.py` regenerates that file with git-cliff from commits, so a manual
      entry would be overwritten.

## Remaining (why this card is still `dev`, not `complete`)

Option B is DONE. What is left is the dead code option A never removed: `src/cli.ts` still
builds to `dist/cli.js`, which nothing installs and nothing invokes.

**BLAST RADIUS — measured 2026-08-11, so nobody re-derives it:**

| step | detail |
|---|---|
| delete `src/cli.ts` | a true entry point — **nothing imports it** (`grep` for `from "./cli.js"` returns only itself) |
| delete `src/cli-mass-scout-free.ts` + `src/cli-mass-scout-free.test.ts` | orphaned: `cli.ts` is its only consumer |
| drop the esbuild target | `esbuild.config.mjs:68-69`, plus the committed `dist/cli.js` bundle |
| update **4 test files** that read `cli.ts` as a source | `free-rotation-coverage.test.ts`, `cli-mass-scout-free.test.ts`, `cluster/wiring.test.ts`, `security_scan/wiring.test.ts` |
| `resolveMassScoutFreeModelOverride` | STAYS — still used internally at `index.ts:2743`; only its `export` becomes unnecessary |

**THE JUDGMENT CALL IS THE TEST ROW, NOT THE DELETIONS.** Those four tests assert coverage
properties ACROSS BOTH entry points (e.g. that free-rotation reaches every send path). Removing
one entry point means deciding, per assertion, whether it still means anything or has been
silently weakened — a change that stays green while dropping a guarantee. So this is not a
"delete the dead code" task and must not be handed to an agent as one.

Two defensible outcomes, USER's call:
(a) remove fully and rewrite the four tests to assert the single-entry-point invariant; or
(b) leave `cli.ts` building as an unpublished artifact and close this card as-is, accepting one
    dead bundle against the no-legacy-code rule.

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

- 2026-08-11T20:22:00+0200 — **OPTION B APPROVED AND SHIPPED** (tier 3, owner: "i approve all,
  just verify each before doing it"). Verification changed the work rather than merely
  confirming it: the card justified B with "anyone invoking `llm-externalizer <cmd>` keeps
  working", and measured against the live catalog that was FALSE — `model-info` and
  `search-existing` exited 1, their tools having been renamed to `or_model_info` and
  `search_existing_implementations`. Shipping B on that premise would have silently broken two
  documented invocations for every npm install. So `LEGACY_COMMAND_ALIASES` (`src/cli/main.ts`)
  landed FIRST, then the re-point, which makes the claim true; a regression test spawns the real
  launcher for all seven verbs so a future rename fails loudly instead of reaching users.
  Commits `15eb6e4` (feature, `BREAKING CHANGE:` footer), `85b1c27` (dist), `5bb05f5` (lockfile).
  Card stays `dev`: the legacy bundle is retired as an entry point but still exists as code.
