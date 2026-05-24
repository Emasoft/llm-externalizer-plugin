---
name: llm-externalizer-cluster-synonyms
description: |-
  Cluster SENTENCES (or short labels treated as sentences) by full-sentence
  meaning equivalence — file-in, file-out, ZERO orchestrator tokens. The whole
  batch+verify+canonicalise loop runs inside the MCP server; you get back only
  the output paths. NOT a word-level synonym lookup — the unit of comparison is
  the full sentence/label. Built for taxonomy work, ontology cleanup, and label
  canonicalisation over large term sets (10k–1M items). Resumable from a prior
  checkpoint; budget-capped; backend-agnostic (uses the active profile's model).
  Trigger with "cluster synonyms", "dedupe these labels by meaning", "canonicalise
  this taxonomy", or "merge equivalent-meaning sentences".
allowed-tools:
  - mcp__llm-externalizer__cluster_synonyms
argument-hint: "input_file=<abs JSONL path> output_dir=<abs path> [embeddings_file=<path>] [policy_file=<path>] [resume_from=<checkpoint.sqlite>]"
effort: high
---

# cluster_synonyms — full-sentence meaning-equivalence clustering

Aggregate synonymous / equivalent-meaning items across a large term set. The
unit of comparison is the **full sentence/label**, not the word — so "cancel a
subscription" and "stop my plan" can land in the same cluster while a word-level
synonym table would miss it. Everything runs inside the MCP server: you pass a
JSONL file in and get four output files back, spending no orchestrator tokens on
the loop itself.

## Pipeline

1. **Pre-flight model benchmark** — qualifies the active profile's model.
2. **Phase 0 setup** — load the JSONL, compute (or load) embeddings.
3. **Phase 1** — embedding-clustered batching + per-batch grouping, with a
   recursive split-and-retry ladder (each failed batch retries 3×, then splits
   in half and recurses; max depth 3 → 8 leaf sub-batches, 45-call hard cap per
   source batch).
4. **Phase 2** — cross-cluster verification with transitive-closure merge
   (≥3 distinct items from each cluster must co-occur in a response to merge).
5. **Phase 3** — canonical-label selection.
6. **Phase 4** — emit `clusters.jsonl` + `clusters_summary.json` + `stats.json`
   + `checkpoint.sqlite`.

> STATUS (per TRDD-220ea89f): Phase 1 is live; Phase 2/3 ship next release.
> Until then `clusters.jsonl` reflects Phase 1 partitions and canonical labels
> are picked by a length heuristic. The output bundle is always valid.

## Inputs

| Field | Required | Description |
|---|---|---|
| `input_file` | yes | Absolute path to a JSONL file. Each line is `{ "id": string, "sentence": string }`; optional `"context"` (free-text disambiguator). `"label"` is accepted as an alias for `"sentence"`. |
| `output_dir` | yes | Absolute output directory (created if missing). Receives `clusters.jsonl`, `clusters_summary.json`, `stats.json`, `checkpoint.sqlite`. |
| `embeddings_file` | no | Absolute path to a precomputed float32 memmap (one row per item, dim D) with a sibling `.meta.json` `{shape:[N,D], dtype, model}`. If absent, the tool computes embeddings via the Python sidecar (sentence-transformers/all-MiniLM-L6-v2). |
| `policy_file` | no | Absolute path to a JSON file of policy knobs (batch size, budget cap, thresholds, …). Defaults apply per field. Backend / model / ensemble are NOT policy knobs — they come from the active profile. |
| `resume_from` | no | Absolute path to a prior `checkpoint.sqlite` from this tool. Resumes from where the previous run stopped (after a budget cap, abort, or any early termination). |

## Output

```
cluster_synonyms OK
  items_in:        <N>
  clusters_out:    <C>
  reduction_pct:   <P>%
  llm_calls_total: <K>
  walltime_s:      <S>
  budget_exhausted: <bool>
  warnings:        <W>
  outputs:
    <abs path>/clusters.jsonl
    <abs path>/clusters_summary.json
    <abs path>/stats.json
    <abs path>/checkpoint.sqlite
```

Return the four `outputs` paths to the user — they are the deliverable.
`clusters_summary.json` is the human-readable view (one entry per cluster with
`size`, `canonical`, and member `{id, sentence}` rows); `clusters.jsonl` is the
per-item assignment stream; `stats.json` records the run metrics; resume from
`checkpoint.sqlite`.

## CLI equivalent

```
bin/llm-externalizer cluster-synonyms --input-json '<json>'
```

The `--input-json` value is the same object documented in the Inputs table
(e.g. `{"input_file":"/abs/in.jsonl","output_dir":"/abs/out"}`). An explicit
`--output-dir <path>` flag overrides the `output_dir` embedded in the JSON.
`--timeout-hours <n>` caps wall time (default 4h; 0 disables). The CLI spawns
the MCP server and calls this same tool, so the clustering core
(`runClusterSynonyms`) and LLM transport are identical to the MCP path.

## Environment

Backend, model, and ensemble selection come from the active llm-externalizer
profile (`~/.llm-externalizer/settings.yaml`) — there are no model flags. For
the OpenRouter backends set `$OPENROUTER_API_KEY` (or configure the plugin's
`userConfig.openrouter_api_key`). Computing embeddings on the fly requires the
Python sidecar with sentence-transformers available; supply `embeddings_file`
to skip it.
