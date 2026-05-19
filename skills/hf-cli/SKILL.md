---
name: hf-cli
description: "Hugging Face Hub CLI (`hf`) reference for downloading, uploading, and managing models, datasets, and repos. Covers custom --local-dir placement, --include/--exclude file filters, --revision pinning, cache management, and `hf auth login` for gated repos. Use when the setup wizard's pre-built download_command needs extension. Loaded by llm-externalizer-setup-agent."
user-invocable: false
---

## Overview

Reference for the Hugging Face Hub CLI (`hf` — replaces deprecated `huggingface-cli`). Covers downloading, uploading, managing models/datasets/Spaces, custom `--local-dir`, file filters via `--include`/`--exclude`, revision pinning, cache management (`hf cache scan/delete`), and authentication (`hf auth login`).

## Prerequisites

The setup wizard reads pre-built `download_command` strings from `scripts/setup/recommend-models.py` — shell-quoted and safe to paste. Most setup runs never need to touch this skill.

Consult this skill when the recommender's command needs extension:
- Custom `--local-dir` placement (multi-user setups, per-project trees)
- File-level filtering with `--include`/`--exclude` (one shard from sharded safetensors, skip `.onnx` for safetensors)
- Pinning a specific `--revision` for reproducibility
- Cache management (`hf cache scan`, `hf cache delete <repo>`)
- Auth setup (`hf auth login`) before downloading from gated repos (Llama 3 needs a HF token tied to Meta licence acceptance)

Install (one-time):

    curl -LsSf https://hf.co/cli/install.sh | bash -s

Use `hf --help` to view available functions. Auth commands are under `hf auth` (e.g. `hf auth whoami`).

## Instructions

1. Determine which sub-command the user needs (`download`, `upload`, `cache scan`, `auth login`, etc.). See [commands](references/commands.md) for the full alphabetical reference.
2. Look up flags in the commands reference.
3. Compose the command — prefer `--local-dir` for predictable placement.
4. For gated repos: run `hf auth login` once before downloading.
5. Run the command. On failure, see Error Handling below.
6. Verify the artifact landed with `ls` / `hf cache scan`.

## Output

Return the executed command + its stdout (or relevant error) to the caller. For downloads, also report the on-disk path the artifact landed at.

## Error Handling

- **Gated repo** (`Access denied`): run `hf auth login`, accept the license on the HF web UI, retry.
- **Filename mismatch** when using shorthand `repo:QUANT`: drop down to `--hf-repo` + `--hf-file` form (see `huggingface-local-models`).
- **Disk pressure / cache bloat**: `hf cache scan` to see usage, then `hf cache delete <repo>` to free space.
- **Network timeout**: retry; for very large repos use `--max-workers 8` to parallelize, or `hf-mount` to defer fetching.

## Examples

```bash
# Download a single GGUF file to a custom dir
hf download unsloth/Qwen3.6-35B-A3B-GGUF Qwen3.6-35B-A3B-UD-Q4_K_M.gguf --local-dir ~/models/qwen

# Download an MLX repo (directory-shaped)
hf download mlx-community/Llama-3.3-70B-Instruct-4bit --local-dir ~/models/l3-70b-4bit

# Pin to a specific revision for reproducibility
hf download org/model file.safetensors --revision abc1234 --local-dir ~/models/model

# Scan and clean the cache
hf cache scan
hf cache delete org/old-model

# Authenticate before pulling a gated repo
hf auth login
```

## Resources

- [commands](references/commands.md)
  > Top-level commands · hf auth · hf buckets · hf cache · hf collections · hf datasets · hf discussions · hf endpoints · hf extensions · hf jobs · hf models · hf papers · hf repos · hf skills · hf spaces · hf webhooks · Common options · Mounting repos as local filesystems (`hf-mount`) · Tips
- Official docs: `https://huggingface.co/docs/huggingface_hub/en/guides/cli`
- `huggingface_hub` Python lib: `https://github.com/huggingface/huggingface_hub`
- `hf-mount` (on-demand mounts): `https://github.com/huggingface/hf-mount`
- `hf` install: `https://hf.co/cli/install.sh`
