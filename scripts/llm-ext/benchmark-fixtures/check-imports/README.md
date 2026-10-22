# check_imports benchmark corpus

Five **real** source files, copied **verbatim** out of this repository's own
`scripts/llm-ext/src/` tree at commit `bbefaaa`. Nothing here is written for the
benchmark, nothing is synthesized, nothing is edited — every byte is production
code that really ships.

| fixture | copied from | why it is here |
|---|---|---|
| `config.ts` | `src/config.ts` | the richest import mix: `node:` builtins, a bare package (`yaml`), and relatives |
| `free-rotation.ts` | `src/free-rotation.ts` | `node:` builtins + relatives, **and a prose false-positive trap** (see below) |
| `completion.ts` | `src/provider/completion.ts` | the largest set (15) — tests recall, not just precision |
| `budget.ts` | `src/benchmark/budget.ts` | a **type-only** import (`import type { … } from`), erased at emit |
| `backfill-ledgers.ts` | `src/benchmark/backfill-ledgers.ts` | five sibling relatives that all resolve in-tree but dangle here |

## Why they live OUTSIDE `src/`, and why that is the point

`tsc`, `eslint` and `vitest` never look in `benchmark-fixtures/`, so these
snapshots do not have to compile against today's tree — the same arrangement
`benchmark-fixtures/scan-folder/` and `code-task/` already use.

For **this** benchmark the arrangement is not merely convenient, it *is* the
phenomenon under test. `check_imports` exists to detect **broken imports after
file moves/renames**. Copying a file out of its tree is a real relocation: its
relative imports (`./config.js`, `../security_scan/judge.js`, …) genuinely no
longer resolve. So the corpus contains authentic broken imports produced by an
authentic move — not a single path was typed to be broken.

## The trap, kept deliberately

`free-rotation.ts` line 1115 is a real statement carrying a trailing comment:

```ts
const body = await res.text(); // must read to tell "rate-limited" from "real bug"
```

The token sequence `from "real bug"` appears verbatim, on a line that also holds
executable code. A naive extractor — model **or** oracle — that scans for
`from "…"` without separating code from comment reports a phantom import named
`real bug`.

It is left in on purpose. A corpus of only easy cases measures nothing, and this
case was not planted: it occurs naturally in shipped code, which is the whole
argument for deriving benchmarks from real artifacts. It also disciplines the
ORACLE, not just the model — if the derivation rule cannot exclude this, the
rule is wrong, and the tripwire is what forces that to surface.

## Ground truth is DERIVED, never typed in

`benchmark/check-imports/dataset.ts` recomputes, from these bytes on every run:

1. the set of import specifiers each file **declares**, and
2. for each, whether it **resolves** against this fixture tree.

A checked-in expectation is kept as a **tripwire**, not as the definition:
validation recomputes both sets and throws on any disagreement, so a fixture edit
cannot silently change an answer and a mistaken rule cannot silently redefine the
truth. Two independent statements of one fact, and a hard failure when they
diverge — the same discipline `scan-folder/dataset.ts` uses.
