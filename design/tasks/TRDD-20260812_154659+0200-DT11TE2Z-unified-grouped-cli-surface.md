---
trdd-id: DT11TE2Z
title: Collapse the 45 flat commands into one grouped CLI surface with per-layer help
column: todo
approval-tier: 3
created: 2026-08-12T15:46:59+0200
updated: 2026-08-12T15:46:59+0200
current-owner: claude-llm-externalizer
assignee: null
priority: 1
severity: HIGH
effort: L
labels: [cli, public-api, breaking, ux]
task-type: refactor
parent-trdd: null
npt: []
eht: []
blocked-by: []
release-via: publish
delivery: publish-only
target-branch: main
test-requirements: [unit, typecheck, lint]
review-requirements: [human-review]
impacts: [public-api]
implementation-commits: []
---

# One launcher, seven verbs — `llm-ext <group> <action>`

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative) — 2026-08-12

**NEXT ACTION:** wait for the CLI-architecture recon report (`reports/cli-restructure-recon/`),
then fill in the Phases section with real file:line targets. Do NOT start editing before that —
the rename's cost is dominated by NAME COUPLING outside the catalog (tests, skills, agents,
commands, docs), and guessing that surface is how this becomes a half-finished migration.

## The owner's directive (2026-08-12, verbatim intent)

> "even if you add many separate executable cli tools, i still want them callable from one easy to
> memorize unified cli launcher … Do not make dozens of different commands, they are hard to
> memorize."

With two worked examples:

```
llm-ext compact <claude project slug>/<session id>.jsonl -o /tmp/session_summary.md
llm-ext llm-query ./prompt.md -o "./reports/llm-externalizer/response.md" --profile free
```

Follow-up, same session: **per-layer `--help`**, and a **"did you mean …"** suggestion when a
command is mistyped.

**Half of this is already true and must not be re-solved:** `llm-ext` is ALREADY the single
launcher — one binary, one dispatcher, and TRDD-W9DK4L3N deleted the second entry point today.
What is NOT true is memorability: **45 flat commands**.

## The decision — FULLY GROUPED (owner's pick, 2026-08-12)

Offered three shapes (flat-but-fewer, hybrid flat+grouped, fully grouped). The owner chose
**fully grouped: everything nests, uniformly `<group> <action>`, no flat exceptions** — accepting
that `compact` becomes `session compact` in exchange for one predictable rule with no memorized
exception list.

**Seven top-level verbs.** The shape IS the mnemonic: you never wonder whether a command is
top-level or nested, because nothing is top-level.

## The mapping — all 45 accounted for, none silently dropped

| group | action | replaces |
|---|---|---|
| **session** | `compact` | `session-summary` |
| **llm** | `ask` · `code` · `cluster` | `chat` · `code-task` · `cluster-synonyms` |
| **scan** | `folder` · `security` · `quality` · `impl` | `scan-folder` · `security-scan` · `high-quality-scan` · `search-existing-implementations` |
| **check** | `imports` · `refs` · `specs` · `rules` · `plan` · `diff` | `check-imports` · `check-references` · `check-against-specs` · `rules-check` · `review-plan` · `compare-files` |
| **scout** | `run` · `search` · `search-xjob` · `get` · `body-get` · `export` · `chain` · `diff` · `estimate` · `register` · `jobs` · `audit-sample` · `preclassify` · `build-fieldset` · `propose-fieldset` · `fieldsets` | the 16 `mass-scout*` commands |
| **models** | `info` · `assess` · `health` · `discover` · `replacements` · `benchmark` | `or-model-info*` · `assess-model` · `check-model-health` · `discover-new-models` · `check-tool-replacements` · the 2 `*-benchmark`s |
| **config** | `show` · `profile` · `reset` · `status` · `scan-local` | `get-settings` · `profile` · `reset` · `discover` · `scan-local-llm-services` |

**Three collapses beyond renaming** — this is where 45 becomes 41 actions:
- `or-model-info` / `-json` / `-table` → **one** `models info --format text|json|table`. Three
  commands that differ only in output encoding were never three commands.
- `security-triage-benchmark` + `search-existing-benchmark` → `models benchmark --suite triage|impl`.
- `batch-check` is **DELETED**, not renamed. Its own help says *"DEPRECATED: use chat or code_task"*.
  Carrying a deprecated command through a breaking restructure would violate the project's
  no-legacy-code rule at the exact moment it is cheapest to honour.

## Calling convention (the other half of the ask)

The owner's examples change more than the names — they change the *shape* of a call:

1. **Positional primary input.** `llm-ext session compact <file>.jsonl`, not
   `--transcript <file>`. Every action gets ONE positional primary input where it has an obvious
   one (a transcript, a prompt file, a folder). Secondary inputs stay named flags.
2. **`-o` / `--output`** for the destination, everywhere, uniformly.
3. **`--profile <name>`** as a first-class flag. Today profile selection is user-only YAML editing
   (`~/.llm-externalizer/settings.yaml`); the examples call `--profile free`, so it becomes a flag.
   *Open sub-question for implementation:* whether `--profile free` merely selects an existing
   profile or implies `free_only`. Selecting an existing profile is the conservative reading and
   the one to build; do not invent a synthetic profile.
4. **NO ALIASES, NO BACK-COMPAT SHIMS.** The project rule is explicit — one version of the code,
   no legacy paths. v12.0.0 already broke the CLI surface, so this rides the same break rather
   than accumulating a second compatibility layer. This is a `feat(cli)!` with a BREAKING CHANGE
   footer.

## Help and typo recovery (owner follow-up, MANDATORY — not polish)

- **Help at every layer.** `llm-ext --help` lists the 7 groups only (not 45 lines).
  `llm-ext scan --help` lists that group's actions. `llm-ext scan folder --help` lists that
  action's parameters. Each layer's help must be *complete for its layer and silent about the
  others* — the reason a 45-line help screen fails is that it answers a question nobody asked.
- **"Did you mean …" on any unrecognised token**, at BOTH layers: a bad group
  (`llm-ext scna` → *did you mean `scan`?*) and a bad action within a good group
  (`llm-ext scan foldr` → *did you mean `scan folder`?*). Levenshtein over the candidate set for
  that layer, suggest the best 1-3 within a small edit distance, and **exit non-zero** — a
  suggestion is not a confirmation, and auto-running a guessed command is exactly the kind of
  helpful-but-wrong behaviour this project's fail-fast rule forbids.
- A mistyped command must never fall through to a generic usage dump. That is the current
  behaviour and it is what makes 45 commands feel like 450.

## Phases (each ≤5 files; fill targets from the recon report)

1. **Catalog + router.** Introduce the group/action model in the command catalog and a two-level
   resolver in the CLI dispatcher. No renames yet — prove the router with the existing names.
2. **Per-layer help + did-you-mean.** Built against the router from P1, with tests for each layer
   and for the suggestion set.
3. **Positional input + `-o` + `--profile`.** The convention change, applied uniformly.
4. **The rename itself**, group by group, tests moving with each group.
5. **Call-site sweep** — skills, agents, commands, hooks, README, docs. THE RISK LIVES HERE: a
   missed reference is a silently broken skill, not a compile error.
6. **Rebuild dist, full suite, doc-consistency gate** (it asserts command COUNTS in README.md and
   has failed on exactly this before).

## Acceptance

- [ ] `llm-ext --help` lists 7 groups, not 45 commands.
- [ ] `llm-ext <group> --help` and `llm-ext <group> <action> --help` both work for every pair.
- [ ] A mistyped group AND a mistyped action each produce a "did you mean" naming the right
      candidate, and exit non-zero.
- [ ] Every one of the 45 old commands is reachable under its new name; the mapping table above is
      the checklist. A command that lost its home is a bug, not a simplification.
- [ ] `batch-check` is gone entirely — no alias, no shim.
- [ ] The owner's two example invocations run as written (modulo `compact` → `session compact`).
- [ ] No old command name survives anywhere outside CHANGELOG/design history — verified by grep
      across src, tests, skills, agents, commands, hooks, docs.
- [ ] tsc 0 · eslint 0 · full vitest green · build clean · doc-consistency gate green.

## Notes

**Approval:** tier 3 and public-API breaking, but the owner directed it explicitly and chose the
shape from three presented options in this session. That IS the approval; recorded here so the
tier is not later read as bypassed.

**Do NOT hand the rename to an agent as a mechanical find-and-replace.** The same trap as
TRDD-W9DK4L3N: the repo contains several files named `cli.ts` and command names appear as both
kebab (`scan-folder`) and snake (`scan_folder`) — the dispatcher normalizes `-` to `_`. A blind
replace will hit namesakes and miss the snake_case half.
