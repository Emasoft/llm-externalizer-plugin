#!/usr/bin/env python3
"""Compute sentence embeddings for cluster_synonyms.

Reads one sentence per line from --input, writes a contiguous float32
binary memmap to --output, plus a sibling <output>.meta.json describing
the shape and model. Invoked by the MCP server's TypeScript code via
`uv run` so the heavy sentence-transformers / torch deps stay out of
the Node runtime. See TRDD-220ea89f §6.4 for the protocol.

Protocol:
  argv  : --input PATH --output PATH [--model NAME] [--batch-size N]
  stdin : (ignored)
  stdout: one line "OK <count> <dim> <output_path>" on success
  stderr: progress + errors
  exit  : 0 = ok, 1 = failure
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import NoReturn

DEFAULT_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
DEFAULT_BATCH = 64


def die(msg: str, code: int = 1) -> NoReturn:
    print(f"compute_embeddings: {msg}", file=sys.stderr)
    sys.exit(code)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Compute sentence embeddings for cluster_synonyms",
    )
    parser.add_argument("--input", required=True, help="Plain-text input file (one sentence per line).")
    parser.add_argument("--output", required=True, help="Output path for the float32 binary memmap.")
    parser.add_argument("--model", default=DEFAULT_MODEL, help=f"Embedding model id (default: {DEFAULT_MODEL}).")
    parser.add_argument("--batch-size", type=int, default=DEFAULT_BATCH, help=f"Encoder batch size (default: {DEFAULT_BATCH}).")
    args = parser.parse_args()

    input_path = Path(args.input).resolve()
    output_path = Path(args.output).resolve()

    if not input_path.exists():
        die(f"input file not found: {input_path}")

    # Import torch / sentence-transformers AFTER arg parse so --help is fast.
    # die() is NoReturn, so anything past it is unreachable — Pyright still
    # can't infer that across the try/except, so we assign after import.
    try:
        import numpy as np  # type: ignore[import-not-found]
        from sentence_transformers import SentenceTransformer  # type: ignore[import-not-found]
    except ImportError as e:
        die(
            "sentence-transformers / numpy not installed. Install with:\n"
            "  uv pip install 'sentence-transformers>=3.0' 'numpy>=1.26'\n"
            f"underlying ImportError: {e}",
        )
    # Past the except branch, both symbols are bound.
    assert np is not None
    assert SentenceTransformer is not None

    # Read sentences (one per line, blank lines skipped, line order preserved).
    sentences: list[str] = []
    with input_path.open("r", encoding="utf-8") as fh:
        for raw in fh:
            s = raw.rstrip("\n").rstrip("\r")
            if s.strip() == "":
                continue
            sentences.append(s)
    n = len(sentences)
    if n == 0:
        die("input file has zero non-blank lines")

    print(f"compute_embeddings: loaded {n} sentences from {input_path}", file=sys.stderr)
    print(f"compute_embeddings: loading model {args.model}", file=sys.stderr)

    model = SentenceTransformer(args.model)
    dim = model.get_sentence_embedding_dimension()
    if dim is None:
        die(f"model {args.model} did not report an embedding dimension")

    # Pre-create the output file at full size so subsequent batch writes can
    # land in-place at correct offsets.
    output_path.parent.mkdir(parents=True, exist_ok=True)
    bytes_per_row = dim * 4
    with output_path.open("wb") as fh:
        fh.truncate(n * bytes_per_row)

    mm = np.memmap(output_path, dtype="float32", mode="r+", shape=(n, dim))
    bs = max(1, args.batch_size)
    for start in range(0, n, bs):
        end = min(start + bs, n)
        batch = sentences[start:end]
        emb = model.encode(batch, batch_size=bs, convert_to_numpy=True, show_progress_bar=False)
        mm[start:end, :] = emb.astype("float32")
        print(f"compute_embeddings: {end}/{n}", file=sys.stderr)
    mm.flush()
    del mm

    meta_path = output_path.with_suffix(output_path.suffix + ".meta.json")
    meta = {
        "shape": [n, dim],
        "dtype": "float32",
        "model": args.model,
    }
    meta_path.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")

    print(f"OK {n} {dim} {output_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
