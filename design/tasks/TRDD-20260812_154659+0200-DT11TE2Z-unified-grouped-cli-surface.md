---
trdd-id: DT11TE2Z
title: A thin grouped launcher in front of the existing commands
column: complete
approval-tier: 0
created: 2026-08-12T15:46:59+0200
updated: 2026-08-12T16:14:45+0200
current-owner: claude-llm-externalizer
assignee: null
priority: 1
severity: MEDIUM
effort: S
labels: [cli, ux]
task-type: feature
parent-trdd: null
npt: []
eht: []
blocked-by: []
release-via: publish
target-branch: main
test-requirements: [unit, typecheck, lint]
impacts: []
implementation-commits: [470d175]
---

# A thin grouped launcher: `llm-ext <group> <action> <input> -o <out>`

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative) — 2026-08-12

**NEXT ACTION:** implement the launcher as ONE new module + a hook in `main.ts`. Nothing else.

### ⛔ SUPERSEDED — do NOT carry forward

An earlier revision of this card planned a **7-phase internal refactor**: unify four name
registries, rename all 45 commands, sweep ~60 skills/agents/commands, breaking change, tier 3.
**The owner corrected that as over-engineering:**

> "i told you to create a simple launcher. it will examine the command and dispatch the real cli ts"

That plan is **withdrawn in full**. The 45 existing commands **stay exactly as they are** and keep
working under their current names. The launcher does not rename them, does not touch dispatch,
does not modify the catalog, and breaks nothing. It is a **front door**, not a renovation.

*(The recon did surface a genuine standing bug — command names duplicated across four registries
in `src`. That is real, but it is NOT this card and must not be smuggled in. If it matters, it
earns its own card.)*

## What this is

A translation layer. It reads `<group> <action>`, maps to an existing command name, converts a
positional input into that command's primary flag, and hands off to the dispatch that already
exists. ~One module, one table, one hook.

```
llm-ext session compact <session>.jsonl -o /tmp/summary.md
   -> existing: session_summary --transcript <session>.jsonl --output /tmp/summary.md

llm-ext llm ask ./prompt.md -o ./resp.md --profile free
   -> existing: chat --input_files_paths ./prompt.md --output ./resp.md --profile free
```

Unmapped flags pass through untouched, so every existing parameter keeps working without the
table having to know about it. **The table only needs to know: group, action, target command,
and which flag the positional fills.**

## The map (7 groups — the owner picked fully-grouped from three offered shapes)

| group | action → existing command |
|---|---|
| **session** | `compact` → `session_summary` (positional → `transcript`) |
| **llm** | `ask` → `chat` · `code` → `code_task` · `cluster` → `cluster_synonyms` (positional → `input_files_paths`) |
| **scan** | `folder` → `scan_folder` · `security` → `security_scan` · `quality` → `high_quality_scan` · `impl` → `search_existing_implementations` (positional → `folder_path`) |
| **check** | `imports` → `check_imports` · `refs` → `check_references` · `specs` → `check_against_specs` · `rules` → `rules_check` · `plan` → `review_plan` · `diff` → `compare_files` |
| **scout** | `run` → `mass_scout` · `search` · `get` · `export` · `chain` · `diff` · `estimate` · `register` · `jobs` · … → the `mass_scout_*` family |
| **models** | `info` → `or_model_info` · `assess` → `assess_model` · `health` → `check_model_health` · `discover` → `discover_new_models` · `replacements` → `check_tool_replacements` |
| **config** | `show` → `get_settings` · `profile` → `profile` · `reset` → `reset` · `status` → `discover` · `scan-local` → `scan_local_llm_services` |

## Requirements

1. **Per-layer help.** `llm-ext --help` leads with the 7 groups. `llm-ext scan --help` lists that
   group's actions. `llm-ext scan folder --help` shows that command's parameters — delegate to the
   existing per-command help rather than duplicating parameter docs (a second copy would drift).
2. **Did-you-mean**, at BOTH layers: a bad group (`scna` → `scan`) and a bad action within a good
   group (`scan foldr` → `scan folder`). Levenshtein over that layer's candidates, suggest the
   closest 1-3 within a small edit distance, **exit non-zero**. Suggest NOTHING when the input is
   far from every candidate — a confidently wrong suggestion is worse than none. Never auto-run a
   guess.
3. **Positional input** for actions that have an obvious primary input, mapped to that command's
   existing flag. `-o` / `--output` maps to the existing output flag.
4. **Existing flat names keep working.** They are the real commands; the launcher dispatches to
   them. Nothing is deprecated or removed by this card.

## Acceptance — ALL MET 2026-08-12 (`470d175`)

- [x] The owner's two examples run as written (with `compact` under `session`) —
      `session compact --help` delegates to `session-summary`, `llm ask --help` to `chat`.
- [x] Every group/action pair resolves to a real command — a test asserts every target exists in
      the catalog, so a typo in the map fails the suite rather than at runtime.
- [x] Help at all three layers; top level lists 7 groups, the flat catalog moved behind
      `--help --all`.
- [x] Mistyped group → *"did you mean group: scan, scout?"*; mistyped action → *"did you mean:
      scan folder?"* (grouped form, not the flat name); both exit 1; `zzzzqqq` suggests nothing.
- [x] Existing flat commands untouched — the launcher engages only when `argv[0]` is a group, and
      no flat command name is a group name.
- [x] tsc 0 · eslint 0 · vitest **1915 passed / 4 skipped / 0 failed** (1899 before) · build clean.

## Notes and lessons learned

**Two verification failures of my own, both of which nearly cost the implementer real work.** I
reported the agent's results as "partly false" twice; both times the tool was correct and my
harness was lying:

1. **`$?` after a pipe reports the LAST command.** `./bin/llm-ext scna | head` then `echo $?`
   measures `head`, not the CLI — so every error path read as `exit=0`. Measure the process
   directly (`cmd > file 2>&1; echo $?`), never through a pipe.
2. **zsh does NOT word-split unquoted `$var`** (bash does). `for c in "scan foldr"; do llm-ext $c`
   passes ONE argv token `"scan foldr"`, so the CLI correctly reported an unknown command — and I
   read that as a broken launcher. When testing argv handling, write the arguments literally.

Both belong to the same family: *a test harness is code, and an untested harness fails silently in
the direction of "the product is broken".* Before filing a defect against a component, confirm the
observation reproduces under a differently-shaped command.

## Notes

Scope discipline: if implementing this starts requiring changes to `index.ts` dispatch, the
catalog, or any existing command's parameters, **stop** — that is the withdrawn plan creeping
back. The launcher only rewrites argv and delegates.
