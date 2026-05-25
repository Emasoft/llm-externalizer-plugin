# Testing

## `npm test` is offline and free — by design

The default suite makes **zero** real LLM calls and bills **$0.00**. Every
integration test spawns the MCP server against a synthetic **local, unreachable
backend** (`http://127.0.0.1:1`, a single non-ensemble model). Tool calls
fail fast on `ECONNREFUSED`; the tests assert the plumbing, validation,
progress, and answer-mode behaviour around the call — never the model's output.

This is enforced two ways, so a future refactor can't silently start spending:

- `src/test-helpers.ts` — `resolveTestConfig()` defaults to the local backend.
  The real `~/.llm-externalizer/settings.yaml` is used **only** when a test
  passes `requireLiveBackend: true`.
- `src/test-helpers.test.ts` — a free regression guard that fails if the
  default ever resolves to a billing backend.

> Cost-safety rationale and the incident that motivated it: `design/tasks/TRDD-20260525_103153+0200-e82f2c49-test-cost-safety.md`.

## Running the real-LLM (live) tests — these cost money

Live suites are gated behind `LIVE_TESTS=1` **and** `OPENROUTER_API_KEY`; with
either missing they self-skip (default `npm test` reports them skipped):

```bash
# All live suites — runs against your ACTIVE profile (may be a premium ensemble!)
LIVE_TESTS=1 OPENROUTER_API_KEY=$KEY npx vitest run src/live.test.ts

# Live security-scan smoke only
LIVE_TESTS=1 OPENROUTER_API_KEY=$KEY npx vitest run src/security_scan/security_scan_live.test.ts
```

The live suites use your configured backend, so a 3-model ensemble with
reasoning models will bill accordingly. Point your active profile at a cheap
model before running them repeatedly.

`CALIBRATE=1` similarly opts into the calibration suites under
`src/mass_scouting/`.
