# code_task CODE-AUDIT benchmark corpus

Golden fixtures for the `code_task` per-tool model benchmark (P2b). Ground truth
lives in `mcp-server/src/benchmark/code-task/dataset.jsonl`; the scorer is
`.../score.ts` (deterministic, **no LLM judge**).

## These files are DATA, not code

Do not compile, lint, typecheck, or "fix" them. They sit outside `src/` precisely
so `tsc` / `eslint` / `vitest` never touch them, and there is deliberately **no
`tsconfig.json`** here (unlike the `search-existing/` corpus, whose fixtures are
self-contained and do compile):

- The DEFECT fixtures are **verbatim historical snapshots** — they import modules
  by paths that only make sense at their original location in `src/`, so they
  cannot resolve and are not meant to.
- Every byte is load-bearing. Editing one silently changes what the benchmark
  measures, and reformatting one can move or erase the defect being scored.

`dataset.test.ts` validates the corpus against the ground truth on every `npm
test`, so drift fails the suite rather than a paid sweep.

## Nothing here is fabricated

Every defect fixture is a real file from this repository's own git history, taken
verbatim at its **pre-fix** revision. Each listed defect really shipped and was
really fixed; the fixing commit supplies both the buggy symbol (from the diff)
and the rationale (from its message).

| Fixture | Snapshot of | Buggy symbol(s) |
|---|---|---|
| `ensemble-limits.ts` | `git show afad87d^:mcp-server/src/ensemble-limits.ts` | `resolveEnsembleModelLimits` |
| `rule-install.ts` | `git show 4c219b5^:mcp-server/src/rule-install.ts` | `underAllowedRoot`, `installUsageRule` |
| `grouping.ts` | `git show c7eac50^:mcp-server/src/grouping.ts` | `parseFileGroups`, `splitPerFileSections` |
| `cluster-synonyms-main.ts` | `git show 8bee08a^:mcp-server/src/cluster/cluster_synonyms_main.ts` | `runClusterSynonyms` |
| `config.ts` | `git show 2d0d2ae^:mcp-server/src/config.ts` | `validateProfile`, `resolveProfile` |
| `select-common.ts` | `HEAD:mcp-server/src/benchmark/select-common.ts` | *(clean)* |
| `unionfind.ts` | `HEAD:mcp-server/src/cluster/unionfind.ts` | *(clean)* |
| `model-events.ts` | `HEAD:mcp-server/src/model-events.ts` | *(clean)* |

## Two rules that governed the selection

**The latent-defect rule.** A pre-fix snapshot contains the defect its fix commit
removed *and every defect fixed later in the same file*. Scoring a model WRONG for
spotting a later-fixed bug would penalise the best models, so each snapshot is
taken at the parent of the **latest** fix commit touching that file — leaving the
listed symbols as the only defects our history knows about in it. `grouping.ts` is
the deliberate exception: it sits one fix earlier and therefore lists **both** of
its verified defects, so the invariant still holds.

**The clean fixtures** are current, unmodified `src/` files that **no fix commit
has ever touched** (`git log --grep='^fix' -- <path>` is empty). They are the
negative distractors: a model that invents defects in them loses precision. Their
filenames are neutral because the model *sees the filename* — nothing may leak the
answer.
