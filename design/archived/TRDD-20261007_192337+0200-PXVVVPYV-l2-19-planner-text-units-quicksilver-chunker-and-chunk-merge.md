---
trdd-id: PXVVVPYV
title: L2-19 Planner text units, quicksilver chunker and chunk-merge rules (§5)
column: complete
status: archived
created: 2026-10-07T19:23:37+0200
updated: 2026-10-10T03:07:50+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T19:23:37+0200
implementation-commits: [86833ff1, d01128bb, f651b119, da2da099]
---

# L2-19 Planner text units, quicksilver chunker and chunk-merge rules (§5)

## Goal
Planner `text` units: the quicksilver 0.3.0 chunker and the chunk-merge rules of §5.

## Approval log

- 2026-10-07T19:23:37+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T03:07:28+0200 — column → todo by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-8 work committed
- 2026-10-10T03:07:28+0200 — column → dev by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-8 work committed
- 2026-10-10T03:07:50+0200 — COMPLETE by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-8 work committed.

## Plan refs

§5 (Unit kinds, Chunk merge, JSON states), §2b (UditAkhourii/quicksilver), D28, D31, §14 row 36; E114, E115, E116, E117, E118.

## Depends on

L2-01 (TRDD-YB1KEVKC), L2-06 (TRDD-SNZ17S5L)

## Files

- `scripts/llm-ext/src/classifiers/l2/planner.ts`
- `scripts/llm-ext/src/classifiers/l2/planner.test.ts`
- `scripts/llm-ext/vitest.config.ts`

## Reuse

Read the code at card start.

## Steps

1. `--chunk-chars` default 60,000, range 1,000–90,000, kept under the model limit (§5).
2. Cut rule: pull the end back to just after the last newline if that newline is at least 500 chars past the chunk start, else cut mid-line; the next chunk starts 500 chars before the end snapped forward to the next line start, so overlap is at most 500 chars; each chunk records its 1-based line range; nothing is truncated (§5).
3. JSON state: an object or array larger than one chunk is split into groups of whole top-level entries; a single entry larger than one chunk is refused naming the key (E116).
4. Merge: yes/no takes the highest `noul`; score the highest `score`; choice the highest `confidence`, where a chunk whose top label is the default label (`--default`, else the last label) does not vote, and an item with no voting chunk gets the default label at its best confidence (E117).
5. Ties go to the earliest chunk (E118); a null confidence counts as lowest.
6. The result carries `chunks` and `best_lines` (E114).

## Acceptance

- [x] `--chunk-chars`
- [x] at most 500-char line-snapped overlap
- [x] JSON-state grouping
- [x] noul, score and choice merges with the default-label rule
- [x] `chunks` and `best_lines` reported
- [x] E114: one file larger than `--chunk-chars` → split per §5, every chunk judged, merged by the §5 rule, `best_lines` reported
- [x] E115: no newline within 500 chars before the cut → cut falls mid-line, next chunk overlaps by ≤ 500 chars
- [x] E116: one JSON state entry larger than one chunk → refused naming the key
- [x] E117: `label`: every chunk's top label is the default → item gets the default label at its best confidence
- [x] E118: two chunks tie on the merge value → earliest chunk wins
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules
RESULT 2026-10-10: committed 86833ff1 (chunker, planner expansion, tests), d01128bb (chunk merge wired in l2/fan-out.ts runPlan, shared with L2-04 and L2-05), f651b119 (test include list), da2da099 (rebuilt dist) — l2/chunker.ts (chunkText with the 500-char line-snapped overlap and 1-based line ranges, chunkJsonState grouping whole top-level entries, mergeChunks with the default-label no-vote rule and earliest-chunk ties, defaultLabel, assertChunkChars), l2/planner.ts expands text units into chunks (chunkOf, ChunkInfo, refusals state-entry-too-large and reserved-question-key), runPlan merges chunk answers key#cN into one answer per key and reports chunks, best_chunk and best_lines; chunker.test.ts, planner.test.ts and fan-out.test.ts cover E114 to E118. build then full suite on the committed tree: 249 files / 4051 passed / 0 failed, tsc and eslint clean, no temp-dir leak. Deviations: --chunk-chars is an upper bound: the effective size halves (floor 1000) until every chunk fits the token budget, refused as unit-too-large only when 1000-char chunks do not fit; surrogate pairs are never split. OPEN ITEMS: a spec with index references into a chunked JSON state must map them through chunkOf(u).entries (renumber does not apply to JSON groups); label in json mode cannot chunk a long item, and the unit-too-large message does not point to files mode (proposed wording: use files mode, each item is then cut into chunks); specs pass defaultLabels only when the user gave --default.

## Out of scope

Core packing (L2-01), file reading and walking (L2-06), flags on commands (C4 and SP cards).
