---
trdd-id: 0H5N1V9W
title: Request timeout must cover the body read, not just time-to-first-byte
column: dev
created: 2026-08-12T12:21:24+0200
updated: 2026-08-12T12:21:24+0200
current-owner: claude-llm-externalizer
task-type: bugfix
approval-tier: 0
parent-trdd: T4MZ8YQR
relevant-rules: []
implementation-commits: []
---

# Request timeout must cover the body read, not just time-to-first-byte

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-08-12

**NEXT ACTION:** implement the body-deadline fix in `src/provider/http.ts::fetchWithTimeout`,
add regression tests, run tsc + eslint + vitest + build, commit.

**The bug (verified by tracing, not assumed).** `fetchWithTimeout` arms an `AbortController`,
awaits `fetch()`, then clears the timer in a `finally`. But `fetch()` resolves on response
**HEADERS**, not on a consumed body — so the `finally` cancels the abort the moment headers land,
and the caller reads the body afterwards with **no deadline at all**. The configured timeout
bounds time-to-first-byte only; generation is unbounded.

**Measured evidence.** `settings.yaml` sets no `timeout:`, so the 300 s default applies
(`index.ts:319`). A live `session-summary` chunk reached **1890 s — 6.3× its own cap** — then the
socket died and the attempt restarted from scratch, compounding the loss. Meanwhile
`fetchWithRetry429`'s budget arithmetic (`remaining = timeout - elapsed`) believed the request had
long expired.

**Why it survived.** `index.ts:317` justifies having no hard cap with *"The MCP tool-call timeout
is inactivity-based, kept alive by heartbeat — no hard cap needed."* True under MCP, which supplied
the outer deadline. **MCP is gone; this is CLI-only.** The justification died with the transport
while the code it justified stayed. Category worth remembering: a safety argument that NAMES a
component is invalidated by deleting that component.

**Impact.** A stalled generation hangs the run forever — the retry ladder never fires, because a
retry needs a response and there is none. Violates the project's fail-fast rule. Under the new
concurrency, chunk-level p99 sets the whole wall-clock, so one unbounded chunk erases the
parallelism win.

## Blast radius (enumerated, not guessed)

`fetchWithTimeout` has **11 call sites**: 8 small metadata endpoints (`/v1/models`, `/v1/key`,
`/v1/credits`, LM Studio probes) whose bodies are tiny, and the 2 completion paths
(`completion.ts:435`, `:686`, via `fetchWithRetry429`) where the bug actually bites. Bounding the
body on the metadata calls is harmless — those bodies arrive in milliseconds.

**Verified safe to reconstruct the Response:** no caller reads `res.url`, `res.redirected`, or
`res.type` (grepped; zero hits). Node engine is `>=20`, so `TransformStream` is a global.

## Approach

Keep the `AbortController` **armed through the body read** instead of disarming at headers, so an
over-deadline generation **aborts loudly** and rotates like any other transient — rather than
hanging silently.

- On `fetch()` rejection: clear the timer, rethrow (unchanged).
- No body (204/304/HEAD): clear the timer, return as-is — nothing left to bound.
- Otherwise: pipe the body through a pass-through `TransformStream` whose terminal callbacks
  disarm the timer, and return a Response rebuilt from that stream.

**NOT the fix: raising `timeout`.** That converts an unbounded hang into a longer unbounded hang.

## Acceptance criteria

- [ ] A response whose body stalls past the deadline **aborts**, and does not hang.
- [ ] A response whose body completes within the deadline is returned intact (status, headers, body).
- [ ] The abort timer is disarmed once the body settles, so a slow-but-finished read is not killed
      afterwards, and no timer is leaked.
- [ ] `--concurrency 1` and the metadata endpoints keep working (no behavioural regression).
- [ ] tsc 0 · eslint 0 · full vitest green · build clean.

## Notes

Found while measuring TRDD-T4MZ8YQR's concurrency work. Concurrency is correct and landed
(`f2c4815`); it did not deliver the speedup because this defect dominates the wall-clock.

Also pending: janitor issue #251 states the slowness is *"inherent, not a tuning bug"*. That is
wrong and must be amended once this lands.
