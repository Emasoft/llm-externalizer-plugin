// check_imports benchmark runner (TRDD-f45eeaa0). Hermetic: the completion call
// is stubbed at the injected seam, so no network, no model, $0. What is under
// test is the ORCHESTRATION — per-file iteration, response reading, failure
// accounting, scoring, aggregation — not the model's quality, which only a real
// run can measure.

import { describe, it, expect } from "vitest";

import {
  CHECK_IMPORTS_MAX_OUTPUT_TOKENS,
  checkImportsWorkloadShape,
  runCheckImportsBenchmarkOnModel,
  type ChatJsonFn,
} from "./bench-runner.js";
import { loadDataset } from "./dataset.js";

const deps = {} as never;

/**
 * Identify which fixture a rendered block belongs to.
 *
 * NOT `find(c => text.includes(c.file))` — that was wrong and the corpus caught
 * it: free-rotation.ts mentions "provider/completion.ts" in a comment, so a
 * plain includes() matched completion.ts first and the "perfect" stub answered
 * with the WRONG file's specifiers (TP 1, FP 12). readFileAsCodeBlock puts the
 * filename tag at the START, so the correct fixture is the one occurring
 * EARLIEST, not the first one in iteration order.
 */
function fixtureOf(text: string) {
  let best: { c: ReturnType<typeof loadDataset>[number]; at: number } | null = null;
  for (const c of loadDataset()) {
    const at = text.indexOf(c.file);
    if (at !== -1 && (best === null || at < best.at)) best = { c, at };
  }
  return best?.c;
}

/** A stub that answers with whatever the oracle says is true — a perfect model. */
const perfect: ChatJsonFn = async (messages) => {
  const hit = fixtureOf(messages[1]?.content ?? "");
  return { parsed: { paths: hit ? [...hit.specifiers] : [] } } as never;
};

describe("check_imports runner — orchestration", () => {
  it("scores every fixture and a perfect model PASSES", async () => {
    const r = await runCheckImportsBenchmarkOnModel("test/model", { deps, chatJson: perfect });
    expect(r.modelId).toBe("test/model");
    expect(r.caseScores).toHaveLength(loadDataset().length);
    expect(r.failures).toEqual([]);
    expect(r.pass).toBe(true);
  });

  it("reports progress once per fixture", async () => {
    const seen: number[] = [];
    const n = loadDataset().length;
    await runCheckImportsBenchmarkOnModel("m", {
      deps,
      chatJson: perfect,
      onProgress: (done, total) => {
        seen.push(done);
        expect(total).toBe(n);
      },
    });
    expect(seen).toEqual(Array.from({ length: n }, (_, i) => i + 1));
  });

  it("sends the REAL schema and temperature 0 — fidelity, not approximation", async () => {
    let opts: Record<string, unknown> | undefined;
    await runCheckImportsBenchmarkOnModel("m", {
      deps,
      chatJson: async (_m, o) => {
        opts = o as Record<string, unknown>;
        return { parsed: { paths: [] } } as never;
      },
    });
    expect(opts?.temperature).toBe(0);
    expect(opts?.maxTokens).toBe(CHECK_IMPORTS_MAX_OUTPUT_TOKENS);
    expect((opts?.jsonSchema as { name?: string })?.name).toBeTruthy();
  });

  it("sends the tool's own system prompt, not one written here", async () => {
    let system = "";
    await runCheckImportsBenchmarkOnModel("m", {
      deps,
      chatJson: async (m) => {
        system = m[0]?.content ?? "";
        return { parsed: { paths: [] } } as never;
      },
    });
    expect(system).toContain("Extract ALL file path references and import statements");
    expect(system).toContain("file path strings, configuration references");
  });
});

describe("check_imports runner — bad answers are not silently zeroed", () => {
  it("records a THROWN call as a failure and still finishes the corpus", async () => {
    let n = 0;
    const r = await runCheckImportsBenchmarkOnModel("m", {
      deps,
      chatJson: async () => {
        n += 1;
        if (n === 1) throw new Error("boom");
        return { parsed: { paths: [] } } as never;
      },
    });
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].reason).toContain("boom");
    // The sweep completed over the REMAINING fixtures rather than aborting.
    expect(r.caseScores).toHaveLength(loadDataset().length);
  });

  it("treats a non-array `paths` as UNUSABLE, not as an empty answer", async () => {
    const r = await runCheckImportsBenchmarkOnModel("m", {
      deps,
      chatJson: async () => ({ parsed: { paths: "not-an-array" } }) as never,
    });
    expect(r.failures.length).toBe(loadDataset().length);
    expect(r.pass).toBe(false);
  });

  it("FAILS a model that returns nothing — the corpus has real imports to find", async () => {
    const r = await runCheckImportsBenchmarkOnModel("m", {
      deps,
      chatJson: async () => ({ parsed: { paths: [] } }) as never,
    });
    expect(r.pass).toBe(false);
  });
});

describe("check_imports runner — extra paths are surfaced, never punished", () => {
  it("PASSES a model that returns every import plus config-ish extras", async () => {
    // The tool's prompt asks for "file path strings, configuration references".
    // A model obeying it must not be marked down — this is the runner-level
    // counterpart of the scorer's recall-only decision.
    const r = await runCheckImportsBenchmarkOnModel("m", {
      deps,
      chatJson: async (messages) => {
        const hit = fixtureOf(messages[1]?.content ?? "");
        return {
          parsed: { paths: [...(hit?.specifiers ?? []), "./tsconfig.json", "some/config/ref"] },
        } as never;
      },
    });
    expect(r.pass).toBe(true);
    expect(r.extraPaths.length).toBeGreaterThan(0);
    expect(r.extraPaths[0].paths).toContain("./tsconfig.json");
  });
});

describe("check_imports runner — workload shape", () => {
  it("describes the corpus for cost estimation", () => {
    const shape = checkImportsWorkloadShape();
    expect(shape.files).toBe(loadDataset().length);
    expect(shape.totalSpecifiers).toBeGreaterThan(0);
  });
});
