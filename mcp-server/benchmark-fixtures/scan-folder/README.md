# scan_folder (MASS SEARCH) benchmark corpus

Twelve **real** source files, copied **verbatim** out of this repository's own
`mcp-server/src/` tree at commit `8f5547d`. Nothing here is written for the
benchmark, nothing is synthesized, nothing is edited — every byte is production
code that really ships.

They live OUTSIDE `src/` on purpose (exactly like `benchmark-fixtures/code-task/`):
`tsc`, `eslint` and `vitest` never look here, so the snapshots do not have to
compile against today's tree. Their relative imports (`./types.js`,
`../scan-pipeline.js`, …) dangle by design — the benchmark never compiles them, it
only feeds their TEXT to a model, which is exactly what `scan_folder` does in real
use.

## Provenance

| Fixture | Copied verbatim from | Bytes |
|---|---|---|
| `src/embeddings.ts` | `mcp-server/src/cluster/embeddings.ts` | 7,119 |
| `src/free-pool-auto-bench.ts` | `mcp-server/src/free-pool-auto-bench.ts` | 8,468 |
| `src/rule-install.ts` | `mcp-server/src/rule-install.ts` | 6,430 |
| `src/preflight_benchmark.ts` | `mcp-server/src/cluster/preflight_benchmark.ts` | 8,245 |
| `src/jsonl.ts` | `mcp-server/src/cluster/jsonl.ts` | 5,105 |
| `src/report.ts` | `mcp-server/src/security_scan/report.ts` | 8,893 |
| `src/doc-inventory.ts` | `mcp-server/src/doc-inventory.ts` | 4,132 |
| `src/project-root.ts` | `mcp-server/src/project-root.ts` | 1,884 |
| `src/rate-limiter.ts` | `mcp-server/src/rate-limiter.ts` | 7,186 |
| `src/unionfind.ts` | `mcp-server/src/cluster/unionfind.ts` | 4,501 |
| `src/security-triage-dataset.ts` | `mcp-server/src/benchmark/security-triage/dataset.ts` | 10,689 |
| `src/search-existing-dataset.ts` | `mcp-server/src/benchmark/search-existing/dataset.ts` | 8,446 |

Subdirectories were flattened (`cluster/embeddings.ts` → `src/embeddings.ts`).
The last two were renamed only to avoid a basename collision (both are
`dataset.ts` upstream); their bytes are untouched. Total: **81,098 bytes**.

## Why these ten, and what they are for

The corpus is not a random sample. Each query in `src/benchmark/scan-folder/dataset.ts`
partitions these ten files into a MATCH set and a NO_MATCH set, and the partition is
derived **mechanically from the bytes on disk** (a `truthRegex` in the dataset) — never
hand-listed. The dataset's checked-in `expectedMatchFiles` is only a tripwire:
`validateDataset` recomputes the set from disk and THROWS if the two disagree.

| Fixture | spawns a process | writes to the filesystem | uses `node:crypto` |
|---|---|---|---|
| `embeddings.ts` | **yes** (`spawnSync`) | **yes** | no |
| `free-pool-auto-bench.ts` | **yes** (`spawn`) | **yes** | no |
| `rule-install.ts` | no | **yes** | **yes** (`randomBytes`) |
| `preflight_benchmark.ts` | no | **yes** | **yes** (`createHash`) |
| `jsonl.ts` | no | **yes** (`createWriteStream`) | no |
| `report.ts` | no | **yes** | no |
| `doc-inventory.ts` | no | no — **reads only** | no |
| `project-root.ts` | no | no — **reads only** | no |
| `security-triage-dataset.ts` | no — but **describes** shell injection | no — **reads only** | no — but **describes** broken hashes |
| `search-existing-dataset.ts` | no | no — **reads only** | no — but says "touches crypto/signing" |
| `rate-limiter.ts` | no | no — no I/O at all | no |
| `unionfind.ts` | no | no — pure computation | no |

**The traps are what make this corpus worth running.**

- The four **read-only** filesystem files `import` from `node:fs` and are full of
  `readFileSync` / `existsSync` / `readdirSync` / `statSync`. They are the exact trap
  a model that keyword-matches "fs" instead of reading the code falls into.
- **`security-triage-dataset.ts` is the sharpest one.** It is the security-triage
  benchmark's dataset, so it is real source whose job is to *describe threats*: it is
  saturated with `command_injection`, "shell sink", "shell=True", `insecure_crypto`,
  "a broken hash (md5/sha1)", "password hashing" — and it imports neither
  `child_process` nor `crypto`, and only ever reads from disk. A model that
  pattern-matches vocabulary answers MATCH on **all three** queries. A model that
  reads the code answers NO_MATCH on all three.
- `rate-limiter.ts` and `unionfind.ts` are the never-touches-I/O controls.

Without the mention-only traps, a plain `grep` would score 0.91 and clear the 0.85
gate — the benchmark would have measured nothing. With them, the keyword strategy
scores ~0.77 and **fails**. There is a test (`bench-runner.test.ts`) that asserts
exactly this.

## Rules for editing this corpus

1. **Never edit a fixture's bytes.** They are verbatim snapshots; an edit makes them
   synthesized code and the corpus stops being real. Add or remove whole files instead.
2. **After any add/remove, re-run the tests.** `validateDataset` recomputes every truth
   set from disk. If a query loses its positives (or its negatives), it throws — a query
   that cannot be wrong measures nothing.
3. **Filenames must not leak the answer.** The model is shown each file's path in the
   `<filename>` tag, so a fixture called `spawns-a-process.ts` would be scored on its
   name, not on its code.
