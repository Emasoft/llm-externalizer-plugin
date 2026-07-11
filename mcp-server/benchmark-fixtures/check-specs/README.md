# check_against_specs (SPEC ADHERENCE) benchmark corpus — P2d

**Nothing here was authored for the benchmark.** The spec is a real, shipped
project document; every source file is a byte-for-byte snapshot of a real
revision of a real file in this repository, taken straight out of git. The four
VIOLATION fixtures are the exact bytes that a real commit replaced *because they
really violated this spec* — the violations shipped, drained a real OpenRouter
balance, and were really fixed.

## The spec

`spec/TESTING.md` — verbatim copy of `mcp-server/TESTING.md` at `a4d6241`.

It is the cost-safety contract this repo lives by, and it states two rules a
source file can be checked against:

- **R1 — the default suite must not bill.** `resolveTestConfig()` defaults to a
  local, unreachable backend; the user's real `~/.llm-externalizer/settings.yaml`
  is used **only** when a test passes `requireLiveBackend: true`.
- **R2 — a real-LLM suite must self-skip unless it is opted into.** Live suites
  are gated behind `LIVE_TESTS=1` **and** `OPENROUTER_API_KEY`; with either
  missing they skip.

## The incident that is the ground truth

`TESTING.md` did not exist until commit **`31ce212`** — *"fix(tests): zero-spend
test suite — default to local-unreachable backend (TRDD-e82f2c49)"*. That commit
wrote the spec **and** fixed the four files that violated it. Its message records
the damage in the OpenRouter activity export: **$26.46 over 2 days, $17.67 (67%)
of it in the single hour `npm test` ran ~10×.**

So each label is anchored in real history, not in an opinion:

- a **VIOLATION** fixture is the pre-fix blob (`31ce212^` = `b816534`) of a file
  that commit changed, and the commit message names the violation;
- its **CLEAN** twin is the post-fix blob (`31ce212`) of the same file;
- the remaining CLEAN fixtures are untouched files from `a4d6241` (HEAD at
  authoring time) that the incident never involved.

## Provenance

| Fixture | Ground truth | Real path | Blob | Why |
|---|---|---|---|---|
| `src/b816534/test-helpers.ts` | **VIOLATION** | `mcp-server/src/test-helpers.ts` | `31ce212^` | R1. Its own header says *"Uses the real ~/.llm-externalizer/settings.yaml … with the real backend configured by the user."* `createTestClient` copies that settings file into every spawned test server unconditionally — there is no `requireLiveBackend` opt-in at all — so the default `npm test` billed the user's premium ensemble. This is the root cause the commit names. |
| `src/b816534/live.test.ts` | **VIOLATION** | `mcp-server/src/live.test.ts` | `31ce212^` | R2. Every `describe` makes real LLM calls and **none is gated**: no `LIVE_TESTS`, no key check, no `skipIf`. It resolves the user's real backend and runs on any invocation. |
| `src/b816534/live-extended.test.ts` | **VIOLATION** | `mcp-server/src/live-extended.test.ts` | `31ce212^` | R2. Same defect, seven ungated live `describe` blocks. |
| `src/b816534/security-scan-live.test.ts` | **VIOLATION** | `mcp-server/src/security_scan/security_scan_live.test.ts` | `31ce212^` | R2, the subtle one. It *is* gated — but on `HAS_KEY` **alone**. The spec requires **both** `LIVE_TESTS=1` **and** the key. A half-gate fired this suite on every `npm test` in any environment that had a key exported (which the dev machine did). |
| `src/31ce212/test-helpers.ts` | CLEAN | `mcp-server/src/test-helpers.ts` | `31ce212` | The fix: default → synthetic local `http://127.0.0.1:1`; real settings only under `requireLiveBackend: true`. |
| `src/31ce212/live.test.ts` | CLEAN | `mcp-server/src/live.test.ts` | `31ce212` | The fix: `describe.skipIf(!LIVE)` where `LIVE = LIVE_TESTS==='1' && OPENROUTER_API_KEY`. |
| `src/31ce212/live-extended.test.ts` | CLEAN | `mcp-server/src/live-extended.test.ts` | `31ce212` | Same fix. |
| `src/31ce212/security-scan-live.test.ts` | CLEAN | `mcp-server/src/security_scan/security_scan_live.test.ts` | `31ce212` | The fix: the half-gate becomes `LIVE_TESTS=1` **AND** the key. |
| `src/a4d6241/security-triage-live.test.ts` | CLEAN | `mcp-server/src/benchmark/security-triage/live.test.ts` | `a4d6241` | A live suite that was **already** compliant — `31ce212`'s own message cites it as the pattern the broken ones were fixed *to*. Real LLM calls, correctly double-gated. |
| `src/a4d6241/test-helpers.test.ts` | CLEAN | `mcp-server/src/test-helpers.test.ts` | `a4d6241` | The cost-safety regression guard. **The hardest CLEAN case in the corpus** — see below. |
| `src/a4d6241/config.test.ts` | CLEAN | `mcp-server/src/config.test.ts` | `a4d6241` | A settings-parser unit test. Contains the literal string `url: "https://openrouter.ai/api"` — as a YAML *fixture value* it writes to a temp file. Imports nothing but vitest, `node:fs` and local pure modules. Spends nothing. |
| `src/a4d6241/security-triage-runner.test.ts` | CLEAN | `mcp-server/src/benchmark/security-triage/runner.test.ts` | `a4d6241` | A hermetic transform test. Its own header says the real judge over `fetchImpl` is out of scope. No network. |
| `src/a4d6241/pick.test.ts` | CLEAN | `mcp-server/src/benchmark/pick.test.ts` | `a4d6241` | A pure selection/settings-writer test over temp dirs. No network. |

**4 VIOLATION / 9 CLEAN — 13 files, 131,277 bytes.** Every byte is real.

## Why this corpus is not grep-solvable

Three of the four violations and their CLEAN twins are **the same file** — they
differ by ten lines out of hundreds. No bag-of-words strategy can separate them,
because textually they are nearly identical. That is not a lucky property; it is
the whole reason the pairs are in here.

The two obvious cheap strategies both break on this corpus, and
`bench-runner.test.ts` **asserts** they score below the pass gate:

- *"flag anything that talks about OpenRouter / settings.yaml / LIVE_TESTS"* →
  it flags the compliant twins too (they talk about it **more**: the fix added
  the explanatory comments), and it flags `config.test.ts`, which contains the
  OpenRouter URL as a string constant. **F1 ≈ 0.50.**
- *"flag anything that lacks a `LIVE_TESTS` gate"* — a grep that encodes R2
  itself → it flags all four offline unit tests, which need no gate because they
  make no LLM call. **F1 ≈ 0.67.**

`test-helpers.test.ts` is the fixture that defeats the smartest cheap rule: it
contains `requireLiveBackend: true` (the R1 opt-in) and has **no** `LIVE_TESTS`
gate, so every mechanical rule above calls it a violation — yet it is compliant,
because it only *resolves a config object* and never spawns a client or touches
the network ("file read only — no network, no spend"). Getting it right requires
reading the code.

## Rebuilding it

```bash
git show 31ce212^:mcp-server/src/test-helpers.ts > src/b816534/test-helpers.ts
# …one `git show <blob>:<path>` per row of the table above.
cp mcp-server/TESTING.md spec/TESTING.md
```

These files live OUTSIDE `mcp-server/src/`, so `tsc`, `eslint` and `vitest`
never compile, lint or execute them. Their relative imports dangle by design —
`check_against_specs` reads a file's TEXT.

**Never edit a fixture's bytes.** They are historical evidence; editing one to
make a label "fit" destroys the only thing that makes the label true.
