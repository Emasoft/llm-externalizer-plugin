---
trdd-id: 2G6D42LK
title: The four remaining per-command benchmark datasets
column: complete
created: 2026-08-30T00:17:27+0200
updated: 2026-08-30T01:52:00+0200
current-owner: llm-externalizer-1e
task-type: feature
min-approval-requirement: none
blocked-by: []
---

# TRDD-2G6D42LK — the four remaining per-command benchmark datasets

**Filename:** `design/tasks/TRDD-20260830_001727+0200-2G6D42LK-remaining-per-command-benchmark-datasets.md`
**Tracked in:** this repo.

## 0. Why this exists separately from [[TRDD-f45eeaa0]]

f45eeaa0 built the **framework**: the registry, `resolveModelForTool`, the
assess surface, the selection gate, the docs. That is done and closed.

Its last acceptance box — "each LLM-using command has a benchmark dataset" — is
not a framework property. It is an **open-ended tail of INSTANCES**, and
f45eeaa0's own §1 build order always said so: *"Then add each remaining tool's
benchmark as an instance."* Eleven of fifteen have one. Keeping a finished
framework card open to carry four instances hides that the framework shipped —
the same reason [[TRDD-ZZV1XL3C]] was split out of [[TRDD-29VF8RWK]] and the A6
tail was moved off [[TRDD-828238b5]].

## 1. THE RULE THIS INHERITS — do not weaken it

**Ground truth is DERIVED from artifacts that already exist (git history, the
corpus bytes), never authored to fit the test.** The pressure to close these
four boxes will return, and it will arrive as *"just a small hand-written
fixture, only for chat"*. A rule with a name erodes slower than a habit.

`benchmark/check-imports/` is the worked example: corpus copied verbatim, truth
recomputed from the bytes each run, a checked-in tripwire that THROWS on
disagreement, and an oracle tested against the nastiest case in its own corpus.

## 2. The four, which are NOT one homogeneous backlog

### `chat` — DELIBERATELY requirements-only, PERMANENTLY. Not a gap.
A deterministic dataset over free-form conversation is either trivial or
fabricated. This is a decision, recorded so the null stops reading as unfinished
work. **Do not "fix" it.**

### `cluster_synonyms` — derivation MEASURED and rejected for this repo
The architect proposed deriving equivalence from rename commits. Measured
2026-08-30: `git log --diff-filter=R -M` yields 378 renames, but only **13**
change the BASENAME (the other 365 are TRDD archival moves, which prove nothing
about synonymy). Almost all 13 are namespace-prefix additions
(`configure.md → llm-externalizer-configure.md`) that a model would match by
SUBSTRING — the benchmark would measure string prefixing and look rigorous doing
it. The two semantically real pairs (`bug-fixer → serial-fixer`,
`fixer → parallel-fixer`) are chained and ambiguous: `fixer` maps to different
targets at different times.

The derivation is **sound in principle** — it produced `code_task` and
`check_imports` — but this repo's history is not a corpus for it. A real dataset
needs equivalence attested independently: a codebase with a genuine
alias/deprecation table, or the tool's own production cluster outputs
adjudicated once by a human and then frozen. **Do not repeat the git search.**

### `check_references` — DESIGN PASS DONE 2026-08-30; scope narrowed to make it bounded
The tool "auto-resolves local imports, reads dependencies, LLM validates all
symbols exist". Graded naively — "find every broken reference" — the oracle IS
unbounded: it would have to decide which identifiers count as references, which
admits dynamic property access, string-keyed lookup, reflection, re-export
chains, and references from templates or config. A miss could not be attributed
to the model versus the oracle.

**NARROW THE GRADED QUESTION to NAMED IMPORT BINDINGS.** `import { foo } from
"./x.js"` asserts that `x` exports `foo`; whether it does is DECIDABLE from the
bytes. That is the same move that made check_imports tractable, applied one
level deeper — and it converts an unbounded oracle into one with a finite,
nameable exclusion list: default imports, namespace imports (`* as ns`),
type-only imports, and re-export chains, each excluded EXPLICITLY and recorded
per case.

**THE CORPUS, and this is the part that makes it derived rather than authored:**
pair a consumer file from commit N-1 with its dependency at commit N, across a
commit that RENAMED OR REMOVED AN EXPORT. The break is real, produced by a real
refactor, and the truth follows mechanically — no fixture is edited to be wrong.
VERIFIED instance in this repo: `git log -S checkImportsWorkloadShape` shows it
introduced in `a67c9ec` and gone by `e2aecfa` (renamed to `describeWorkload`),
so a consumer at `a67c9ec` against the module at `e2aecfa` is a genuine broken
named import. Mine the corpus with `git log -S <symbol>` over export renames.

Scoring: RECALL over the broken bindings (a missed break is the failure the
command exists to prevent), precision reported and ungated — the same posture as
check_imports and compare_files, and for the same reason.

### `compare_files` — DESIGN PASS DONE 2026-08-30; a bounded derivation EXISTS
The tool "auto-computes unified diff, LLM summarises differences" — the diff is
DETERMINISTIC and only the summary is the model's. Summary *quality* does need a
judge, which is why this looked unbuildable. But a bounded sub-question does not:

  **RECALL over changed symbols.** The set of symbols a diff touches is
  mechanically derivable from the diff bytes (added/removed lines matching a
  declaration form). Score whether the summary MENTIONS them. Recall-only, the
  same shape as check_imports and as prescribed for cluster_synonyms — we can
  prove a symbol changed; we cannot prove an unmentioned one was unimportant.
  A hallucination counter (symbols named that appear nowhere in the diff) is
  reportable alongside, ungated, for the same reason precision is ungated there.

CORPUS: this repo's own commits, via the tool's GIT DIFF MODE — real diffs, no
authoring, exactly how code_task takes real pre-fix snapshots.

THE ONE EXCLUSION, found by measuring rather than assuming: `dist/` MUST be
excluded. Probing commit e2aecfa returned `resolve12`, `factory2` — bundler-
generated names from the committed bundle, not source symbols. Source-only
diffs, or the oracle's truth set is polluted with noise no summary should
mention. This is a FINITE, NAMEABLE failure mode, which is the criterion that
made check_imports the right first target.

## 3. Acceptance

- [x] `cluster_synonyms`: **DECIDED — requirements-only until a corpus exists.**
      Taking the second branch, on measurement rather than fatigue: the rename
      derivation yields 13 usable pairs, almost all substring-matchable, so a
      benchmark built on it would measure string prefixing and look rigorous.
      REVISIT WHEN, and only when, one of these appears: a codebase in scope
      with a genuine alias/deprecation table, or a frozen set of this tool's own
      production cluster outputs adjudicated once by a human. Not a fabricated
      fixture, and not an open box pretending to be work.
- [x] `check_references`: **BUILT AND GATED** — dataset (a6848c6), scorer +
      runner + describer + registry flip (78ed7cd). Named import bindings only,
      balanced corpus, precision gates. 12/15 → 13/15, bundle-verified.
- [x] `compare_files`: **BUILT AND GATED** — dataset (cceaa33), scorer
      (82cb7fa), converged prompt seam (716ae14), runner + describer + registry
      flip (0671a9a). 11/15 → 12/15, verified through the built bundle.
- [x] `chat`: closed as permanently requirements-only.

## 4. THE PRECONDITION THAT BIT ONCE — read before flipping any registry entry

A `benchmark:` id and a runner land in the **same change**, always.
`update-all` resolves an id through `WORKLOAD_DESCRIBERS` and silently `continue`s
past one it cannot run, so a descriptor naming a benchmark with no describer
claims a capability the pipeline does not have. Measured: 5 failures in
`update-all.test.ts`, led by *"labels every tool benchmark-proven or
requirement-gated — and NEVER blurs the two"*. Reverted in `d59ccdf`; done
correctly in `e2aecfa`.

Flipping one entry moves six expectations across two test files
(`registry.test.ts`'s null list; `update-all.test.ts`'s two partitions, its
`skipped`/`perToolSweeps` counts, its summary regex, `toolCalls` and
`toolsUpdated`). Verify each is INCIDENTAL — in the budget test, `ranTools` and
`spentUsd` must be UNCHANGED, proving the cap still trips at the same point.

## 5. Status log

| Date | Status change | Note |
|---|---|---|
| 2026-08-30T00:17:27+0200 | created → backburner | Split from [[TRDD-f45eeaa0]] on its closure. `backburner`, not `todo`: `chat` is decided, `cluster_synonyms` is blocked on a corpus that does not exist here, `compare_files` needs a design pass, and only `check_references` is straightforwardly buildable — with the hardest oracle of the four. Nothing here is drainable today, and saying so is better than parking it in `todo` where a puller would find no next step. |
| 2026-08-30T00:42:00+0200 | backburner (compare_files design pass DONE) | Filed yesterday as "no bounded derivation known yet"; that is now resolved. `compare_files` computes its diff DETERMINISTICALLY and the model only summarises, so summary quality needs a judge — but RECALL over mechanically-derived changed symbols does not, and that is a real gradeable question. Corpus comes from this repo's own commits through the tool's own git-diff mode. The exclusion was MEASURED, not guessed: probing commit `e2aecfa` returned `resolve12` and `factory2` — bundler names from the committed `dist/`, not source symbols — so the corpus is source-only. A finite, nameable failure mode, which is exactly the criterion that made `check_imports` the right first target. Two of the four items are now DECIDED (`chat` permanently, `cluster_synonyms` measured-and-blocked) and a third is SPECIFIED; only `check_references` still lacks a design, and its obstacle is named. |
| 2026-08-30T01:05:00+0200 | backburner (compare_files dataset + scorer BUILT; a prompt divergence found) | Dataset `cceaa33`, scorer `82cb7fa`, 22 tests. **The scorer's premise is now INDEPENDENTLY VALIDATED by the tool itself**: both compare_files system prompts instruct *"Identify code by FUNCTION/CLASS/METHOD NAME, never by line number"* — so recall-over-changed-symbols is not merely a bounded proxy, it is the output the tool explicitly asks for. **NEW FINDING, and it BLOCKS a naive runner: the tool has TWO system prompts that DIVERGE.** `index.ts:5098` (pair mode) says "provide a clear, structured summary. Group related changes. Note potential issues." `index.ts:5388` (git-diff mode) says "...summary of all changes. Note any potential issues, regressions, **or improvements**" plus a **"RULES (override any conflicting instructions)"** framing and an extra "Reference files by their full path as labeled in the user message". Same command, different questions by mode. Unlike check_imports — whose two copies were character-identical, making [[fb6d782]]'s unification behaviour-preserving — unifying these would CHANGE what one path asks. Consequences for the build: (a) the runner must drive ONE named mode and say which, or drive both and score them separately, because a model benchmarked under the git-diff RULES framing is not measured under pair mode; (b) the divergence deserves its own decision (converge, or keep deliberately and document why) BEFORE a seam is extracted, since extracting one seam from two prompts silently picks a winner. NOT unified here: that is a behaviour change needing care, not a tail-of-session edit. REMAINS for the instance: that decision, then seam → runner → describeWorkload → registry flip (with its WORKLOAD_DESCRIBERS entry, same change). |
| 2026-08-30T01:12:00+0200 | backburner (prompt divergence DECIDED and resolved) | The blocker above is cleared, decided under the standing "decide by yourself" directive. **Converged UP onto the git-diff wording**, because it is strictly the stronger instruction set — it only ADDS constraints (the `RULES (override any conflicting instructions)` framing, "or improvements", and "Reference files by their full path as labeled in the user message") and removes none. Pair mode GAINS instructions; nothing loses any. Converging DOWN would have silently weakened the git-diff path. Verified no test pinned the old pair-mode text before changing it. Now a single seam at `src/compare-files/prompt.ts`, pinned VERBATIM by its own test, with a dedicated assertion that the `Identify changed code by FUNCTION/CLASS/METHOD NAME` sentence survives — `benchmark/compare-files/score.ts` grades RECALL over changed symbols, and that is only a measurement of the TOOL while the tool asks the model to name them. **Why this had to precede the runner:** with two live prompts, a model benchmarked under one wording was never measured under the other, so one benchmark could not have spoken for the whole command whichever seam it drove. REMAINS: runner → describeWorkload → registry flip (with its `WORKLOAD_DESCRIBERS` entry, same change). |
| 2026-08-30T01:25:00+0200 | backburner (compare_files COMPLETE — 11/15 → 12/15) | Runner + `describeWorkload` + `WORKLOAD_DESCRIBERS` + registry flip landed TOGETHER (0671a9a), per the precondition. Verified through the BUILT BUNDLE: `models assess` reports `compare_files OK benchmark: compare-files`. The six moved expectations were each checked INCIDENTAL — `ranTools` still 3 and `spentUsd` still ~6, so the budget cap trips identically. **Two of four items are now BUILT OR DECIDED beyond argument** (`compare_files` shipped; `chat` permanently requirements-only), one is MEASURED-BLOCKED (`cluster_synonyms` — no corpus here), and one remains genuinely open (`check_references`). Note what unblocked this: the runner was impossible while the tool had two divergent prompts, because a model benchmarked under one wording was never measured under the other. Resolving that (716ae14) was the actual prerequisite, and it was only visible by reading the source rather than the card. |
| 2026-08-30T01:32:00+0200 | backburner (check_references design pass DONE — every item now designed, decided or built) | The last undesigned item has a design. The unbounded-oracle objection was real but it applied to the NAIVE framing ("find every broken reference"); narrowing the graded question to NAMED IMPORT BINDINGS makes it decidable from the bytes, with a finite exclusion list (default imports, `* as ns`, type-only, re-export chains) recorded per case — the check_imports move applied one level deeper. The corpus is DERIVED, not authored: pair a consumer at commit N-1 with its dependency at commit N across a commit that renamed or removed an export, so the break is a real refactor's. Verified instance: `checkImportsWorkloadShape` exists at `a67c9ec` and is gone by `e2aecfa`. **Card status: `compare_files` BUILT, `chat` DECIDED, `cluster_synonyms` MEASURED-BLOCKED, `check_references` DESIGNED.** Nothing here is now unexamined; what remains is one build, and it is specified rather than described. |
| 2026-08-30T01:52:00+0200 | backburner → complete | **EVERY ACCEPTANCE BOX IS MET, and none by lowering the bar.** `compare_files` BUILT AND GATED (0671a9a). `check_references` BUILT AND GATED (78ed7cd) — the one benchmark here where precision gates, because its oracle can see both directions and a false alarm sends a developer chasing a healthy reference. `chat` DECIDED permanently requirements-only. `cluster_synonyms` DECIDED requirements-only via this card's OWN second branch ("a recorded decision that it stays requirements-only with the reason"), taken on measurement — 13 usable rename pairs, almost all substring-matchable — with an explicit revisit condition rather than an open box pretending to be work. Coverage 11/15 → **13/15**, verified through the BUILT BUNDLE: only `chat` and `cluster_synonyms` still read `requirements-only`, which is exactly the two decided ones. Three defects were caught by the work rather than by me while building these: an oracle returning locals from function bodies, a negative-control guard rendered unreachable by check ordering, and a corpus imbalance that let "call everything broken" score exactly the F1 floor — fixed by balancing the corpus, never by moving the threshold. The DERIVED-not-authored rule (§1) held throughout: every corpus is real commits or real source, and the one command where no such corpus exists was decided rather than fabricated for. |
