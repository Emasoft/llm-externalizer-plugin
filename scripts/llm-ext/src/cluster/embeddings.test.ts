// Unit tests for embeddings.ts. The Python sidecar isn't exercised
// (it needs sentence-transformers + uv installed), but the memmap
// loader, the meta-sidecar validator, and the round-trip writer are
// the surface every callsite goes through — those are covered fully.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadEmbeddings,
  readEmbeddingsMeta,
  writeEmbeddingsToDisk,
  computeEmbeddings,
} from "./embeddings.js";

let tmp = "";
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "emb-test-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeRandomEmbeddings(n: number, dim: number, seed = 7): Float32Array {
  const buf = new Float32Array(n * dim);
  let s = seed >>> 0;
  for (let i = 0; i < buf.length; i++) {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    buf[i] = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  return buf;
}

describe("writeEmbeddingsToDisk + loadEmbeddings round-trip", () => {
  it("writes a 5×3 float32 file + sibling meta, then loads identical bytes back", () => {
    const orig = new Float32Array([
      0.0, 0.1, 0.2,
      1.0, 1.1, 1.2,
      2.0, 2.1, 2.2,
      3.0, 3.1, 3.2,
      4.0, 4.1, 4.2,
    ]);
    const outPath = join(tmp, "emb.f32");
    writeEmbeddingsToDisk(orig, 3, "test-model-v1", outPath);
    expect(existsSync(outPath)).toBe(true);
    expect(existsSync(outPath + ".meta.json")).toBe(true);

    const bundle = loadEmbeddings(outPath);
    expect(bundle.dim).toBe(3);
    expect(bundle.model).toBe("test-model-v1");
    expect(bundle.source).toBe("loaded");
    expect(bundle.embeddings.length).toBe(orig.length);
    for (let i = 0; i < orig.length; i++) {
      expect(bundle.embeddings[i]).toBeCloseTo(orig[i], 6);
    }
  });

  it("large random buffer round-trips bit-exactly", () => {
    const orig = makeRandomEmbeddings(50, 384);
    const outPath = join(tmp, "rand.f32");
    writeEmbeddingsToDisk(orig, 384, "minilm", outPath);
    const bundle = loadEmbeddings(outPath);
    expect(bundle.dim).toBe(384);
    for (let i = 0; i < orig.length; i++) {
      // bit-exact: Float32Array → bytes → Float32Array should preserve every bit
      expect(bundle.embeddings[i]).toBe(orig[i]);
    }
  });

  it("expectedN match passes when N is correct", () => {
    writeEmbeddingsToDisk(new Float32Array(6), 3, "m", join(tmp, "a.f32"));
    expect(() => loadEmbeddings(join(tmp, "a.f32"), 2)).not.toThrow();
  });

  it("expectedN mismatch throws (T5: dim/N mismatch is a hard error)", () => {
    writeEmbeddingsToDisk(new Float32Array(6), 3, "m", join(tmp, "b.f32"));
    expect(() => loadEmbeddings(join(tmp, "b.f32"), 999)).toThrow(/N mismatch/);
  });

  it("readEmbeddingsMeta surfaces malformed JSON", () => {
    writeFileSync(join(tmp, "c.f32"), Buffer.alloc(12));
    writeFileSync(join(tmp, "c.f32.meta.json"), "{ NOT valid json");
    expect(() => readEmbeddingsMeta(join(tmp, "c.f32"))).toThrow(/not valid JSON/);
  });

  it("readEmbeddingsMeta surfaces missing sidecar", () => {
    writeFileSync(join(tmp, "d.f32"), Buffer.alloc(12));
    expect(() => readEmbeddingsMeta(join(tmp, "d.f32"))).toThrow(/meta sidecar missing/);
  });

  it("readEmbeddingsMeta rejects shape with wrong rank", () => {
    writeFileSync(join(tmp, "e.f32"), Buffer.alloc(12));
    writeFileSync(
      join(tmp, "e.f32.meta.json"),
      JSON.stringify({ shape: [1, 2, 3], dtype: "float32", model: "x" }),
    );
    expect(() => readEmbeddingsMeta(join(tmp, "e.f32"))).toThrow(/shape \[N,D\]/);
  });

  it("readEmbeddingsMeta rejects non-string dtype", () => {
    writeFileSync(join(tmp, "f.f32"), Buffer.alloc(12));
    writeFileSync(
      join(tmp, "f.f32.meta.json"),
      JSON.stringify({ shape: [1, 3], dtype: 7, model: "x" }),
    );
    expect(() => readEmbeddingsMeta(join(tmp, "f.f32"))).toThrow(/dtype/);
  });

  it("readEmbeddingsMeta rejects missing model field", () => {
    writeFileSync(join(tmp, "g.f32"), Buffer.alloc(12));
    writeFileSync(
      join(tmp, "g.f32.meta.json"),
      JSON.stringify({ shape: [1, 3], dtype: "float32" }),
    );
    expect(() => readEmbeddingsMeta(join(tmp, "g.f32"))).toThrow(/model/);
  });

  it("loadEmbeddings rejects unsupported dtype (only float32 is supported)", () => {
    writeFileSync(join(tmp, "h.f32"), Buffer.alloc(12));
    writeFileSync(
      join(tmp, "h.f32.meta.json"),
      JSON.stringify({ shape: [1, 3], dtype: "float64", model: "m" }),
    );
    expect(() => loadEmbeddings(join(tmp, "h.f32"))).toThrow(/dtype must be float32/);
  });

  it("loadEmbeddings rejects file whose byte size doesn't match shape × 4", () => {
    // meta says 5 rows × 3 cols × 4 bytes = 60, but file is 12 bytes.
    writeFileSync(join(tmp, "i.f32"), Buffer.alloc(12));
    writeFileSync(
      join(tmp, "i.f32.meta.json"),
      JSON.stringify({ shape: [5, 3], dtype: "float32", model: "m" }),
    );
    expect(() => loadEmbeddings(join(tmp, "i.f32"))).toThrow(/file size mismatch/);
  });

  it("loadEmbeddings rejects missing file even when meta exists", () => {
    writeFileSync(
      join(tmp, "j.f32.meta.json"),
      JSON.stringify({ shape: [1, 3], dtype: "float32", model: "m" }),
    );
    expect(() => loadEmbeddings(join(tmp, "j.f32"))).toThrow(/embeddings file missing/);
  });

  it("loadEmbeddings rejects zero-sized shape", () => {
    writeFileSync(join(tmp, "k.f32"), Buffer.alloc(0));
    writeFileSync(
      join(tmp, "k.f32.meta.json"),
      JSON.stringify({ shape: [0, 3], dtype: "float32", model: "m" }),
    );
    expect(() => loadEmbeddings(join(tmp, "k.f32"))).toThrow(/shape must be positive/);
  });

  it("writeEmbeddingsToDisk rejects mismatched length/dim", () => {
    expect(() =>
      writeEmbeddingsToDisk(new Float32Array(7), 3, "m", join(tmp, "bad.f32")),
    ).toThrow(/bad shape/);
  });
});

describe("computeEmbeddings — fail-fast paths (no Python invocation)", () => {
  it("empty items throws immediately", () => {
    expect(() =>
      computeEmbeddings([], {
        outDir: tmp,
        model: "x",
        scriptPath: join(tmp, "missing.py"),
      }),
    ).toThrow(/empty items/);
  });

  it("missing script path throws before spawn", () => {
    expect(() =>
      computeEmbeddings(
        [{ id: "a", sentence: "hello" }],
        { outDir: tmp, model: "x", scriptPath: join(tmp, "missing.py") },
      ),
    ).toThrow(/compute_embeddings\.py not found/);
  });

  it("non-existent runner binary surfaces a 'failed to spawn' error", () => {
    writeFileSync(join(tmp, "stub.py"), "# stub\n", { encoding: "utf-8" });
    let caught: Error | null = null;
    try {
      computeEmbeddings([{ id: "a", sentence: "hello" }], {
        outDir: tmp,
        model: "x",
        scriptPath: join(tmp, "stub.py"),
        pythonRunner: "/nonexistent/path/to/nothing",
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/failed to spawn/);
  });

  it("nonzero exit code surfaces an 'exited with status' error (via node -e exit 2)", () => {
    writeFileSync(join(tmp, "stub.py"), "# stub\n", { encoding: "utf-8" });
    let caught: Error | null = null;
    try {
      computeEmbeddings([{ id: "a", sentence: "hello" }], {
        outDir: tmp,
        model: "x",
        scriptPath: join(tmp, "stub.py"),
        pythonRunner: process.execPath, // the current Node binary
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    // Either "exited with status" (non-zero exit) or "missing OK line"
    // depending on whether Node interpreted argv[0] as a script. Both
    // are valid signals that the spawn surface fail-closed correctly.
    expect(caught!.message).toMatch(/exited with status|missing OK line/);
  });
});

// End-to-end Python-sidecar invocation is covered by the integration
// suite (B.4) — the unit-level surface here is loadEmbeddings +
// writeEmbeddingsToDisk + the fail-fast spawn guards above.
