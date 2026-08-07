---
trdd-id: 8d8d33c8-7286-4cef-9962-d33ec6633b65
title: Standalone CLI bundle (dist/cli.js) misses auto-free-on-low-balance for mass_scout + security_scan
column: complete
created: 2026-05-31T00:45:07+0200
updated: 2026-08-07T18:50:00+0200
superseded-by: TRDD-W9DK4L3N
---

# TRDD-8d8d33c8 — Standalone CLI bundle misses auto-free-on-low-balance

## ⏵ CLOSED 2026-08-07 — fixed by TRDD-W9DK4L3N option A

Not patched in place. The gap was a symptom of two entry points with independent dispatch, so it
was closed at the cause: `src/cli.ts` now consults the SAME exported pre-flight the supported
path uses (`resolveMassScoutFreeModelOverride`, `index.ts:971`) via `injectMassScoutFreeModel`
(`cli.ts:913,927`) before forwarding to `runMassScoutCli`. No second copy of the balance /
engagement logic exists, which is what would have rotted.

Verified, not assumed: the fix is present in the built `dist/cli.js` (the shipped legacy bundle,
5 occurrences) after `npm run build` — a source-only change would have left the published binary
untouched. Tests cover the cost-safety case directly ("overrides an explicit paid `--model` when
the resolver engages free mode") and guard the read-only subcommands against gaining a network
call ("never consults the resolver (zero network calls) for a non-model sub-command").

Note for anyone re-checking this: grepping for `ensureAutoFreeDecided` / `autoFreeEngaged` on the
legacy path still returns nothing, and that is CORRECT — the legacy path delegates the decision
rather than re-implementing it. Those symbol names were the original evidence of absence; they
are not the name of the shared resolver.

**Filename:** `design/tasks/TRDD-20260531_004507+0200-8d8d33c8-massscout-cli-autofree-gap.md`
**Tracked in:** `Emasoft/llm-externalizer-plugin` (this repo)

## How this was found

User asked (2026-05-30): "are you sure even the mass scouting are working
correctly with the free models?" Investigation by reading the source (no live
test) found that mass_scout has TWO routes to the LLM with DIFFERENT free-model
coverage. One is sound; the other has a real auto-free gap. The auto-free feature
(TRDD-542bdbef) is what makes a near-empty *paid* wallet (balance < $1) fall back
to the `:free` pool instead of 403'ing — the "agents refuse" fix.

## The two routes (verified by reading code)

### Route 1 — MCP server path — ✅ COVERED
What slash commands, `bin/llm-ext mass_scout_*`, `bin/llm-externalizer`, and direct
MCP tool-calls all use. `bin/llm-ext` spawns the MCP server as a subprocess and
calls a tool; `bin/llm-externalizer` forwards to `mcp-server/dist/index.js`.
- `index.ts:6193` short-circuits every `mass_scout_*` / `security_scan` call:
  runs `ensureAutoFreeDecided()`, computes `freeActive = freeOnly || autoFreeEngaged`,
  then injects a `:free` model into `scoutArgs.model` via `resolveSubsystemFreeModel`.
- `scout.ts:233` asserts the model is `:free` (`assertFreeOnlyModel`).
- `index.ts` has 11 auto-free references. Sound by construction + unit-covered
  (`resolveSubsystemFreeModel` has 6 tests in auto-free.test.ts).
- **Caveat:** never live-tested end-to-end on the free pool — the v9.15.0 live
  smoke only ran `chat` + `code_task`. Confidence = "sound by construction +
  unit-tested", NOT "empirically verified".

### Route 2 — standalone CLI bundle (`dist/cli.js`) — ❌ GAP
`mcp-server/package.json:8` wires `dist/cli.js` as the npm bin `llm-externalizer`.
`dist/cli.js` is built from `src/cli.ts`, whose mass_scout handler dynamically
imports `runMassScoutCli` from `mass_scouting/cli.ts`. That file's model resolver
`resolveCliModel` (cli.ts:160) ONLY handles an explicit `free_only` profile via
`getActiveFreeOnly()`. It has **0** references to the auto-free-on-low-balance
machinery (`ensureAutoFreeDecided` / `autoFreeEngaged` / balance check) — confirmed
by grep across `cli.ts` (count 0) and the whole standalone CLI source.

**Consequence:** on a PAID profile with balance < $1 (exactly the scenario
auto-free exists for — and the user's current $0.10 / `remote-ensemble-geminigrok`
state), a direct `node dist/cli.js mass_scout …` (or the npm `llm-externalizer`
bin) resolves to the paid `DEFAULT_MODEL`, then the cost-safety guard
(`cli.ts:1123` / `mass_scouting/cli.ts:1123` `assertFreeOnlyModel`) THROWS. The
"agents refuse" bug is still live on this surface. Same gap applies to the
`security_scan` CLI path in the same bundle (shared `resolveCliModel`).

**Reachability:** limited. The plugin's own default surfaces (slash commands,
`bin/llm-ext`, `bin/llm-externalizer`) all take Route 1. Route 2 bites only a
caller who runs the npm `llm-externalizer` bin / `node dist/cli.js` directly.

## Root cause

The auto-free machinery (`ensureAutoFreeDecided`, `autoFreeEngaged`, `autoFreePool`,
`engageAutoFree`, the `MIN_BALANCE_FOR_PAID_USD` balance probe) is **module-private
to `index.ts`** — never extracted to a shared module. The standalone CLI
(`cli.ts` + `mass_scouting/cli.ts` + `cluster/cli.ts`) is a SEPARATE esbuild
entry (`dist/cli.js`) that doesn't import `index.ts`, so it physically cannot
reach that logic. When Phase 2 of TRDD-542bdbef wired auto-free into the
subsystems, it only covered the in-process MCP dispatch site, not the
separately-bundled CLI.

## Proposed fix (when greenlit — NOT now, user said document-only)

1. Extract the balance-probe + engage-decision into a shared module (e.g.
   `auto-free.ts`) that BOTH `index.ts` and `cli.ts` import — single source of
   truth, no duplication (honor the "one version of the code" rule).
2. In `resolveCliModel` (mass_scouting/cli.ts:160) and the security_scan CLI
   model resolution, call the shared `ensureAutoFreeDecided()` and, when auto-free
   is engaged, resolve to the free pool's top `:free` model — mirroring
   `resolveSubsystemFreeModel`. Keep the existing `free_only` branch.
3. Unit-cover the CLI resolver under (paid profile + low balance) → `:free`.
4. Extend `tests/dogfood/dogfood_test.py` to exercise the standalone
   `dist/cli.js` surface, not only the MCP path, so this class of gap is caught
   in future.
5. Optionally: a $0 free-pool live smoke of a real mass_scout run through BOTH
   routes to move Route 1 from "sound by construction" to "verified" and prove
   Route 2's fix.

## Acceptance criteria (for the future fix)

- [ ] Auto-free decision logic lives in ONE shared module imported by both entries.
- [ ] `resolveCliModel` engages auto-free on low balance (paid profile, balance < threshold) → `:free`.
- [ ] security_scan CLI path in the same bundle covered identically.
- [ ] Unit test: paid profile + balance < $1 → CLI resolves a `:free` model, no throw.
- [ ] dogfood harness covers the `dist/cli.js` standalone surface.
- [ ] build + lint + full vitest green; no push without user go.

## Related TRDDs

- `TRDD-542bdbef` — auto-free-on-low-balance (Phase 1 main dispatch, Phase 2
  subsystem MCP path). This TRDD is the CLI-bundle blind spot of that Phase 2.
- `TRDD-97ef8b63` — airtight free_only chokepoint (`assertFreeOnlyModel`) — the
  guard that throws on Route 2 today.
- `TRDD-1c973104` — dogfood harness; acceptance item 4 extends it to Route 2.

## Status log

- 2026-05-31 00:45 — TRDD authored from the user's mass_scout-free question.
  Documented per user's "Neither now — just document" decision. No code changed,
  no live test run, MCP path left as-is (sound by construction). Backlog only.
- **VERIFIED STILL OPEN 2026-08-06:** `scripts/llm-ext/dist/` still ships a second bundle (`cli.js`) beside `llm-ext.js`, and `grep -rn "ensureAutoFreeDecided\|autoFreeEngaged" scripts/llm-ext/src/mass_scouting/ scripts/llm-ext/src/cli.ts` returns zero hits — the auto-free-on-low-balance path is absent from that entry point.
