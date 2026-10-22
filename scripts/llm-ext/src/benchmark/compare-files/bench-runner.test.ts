// compare_files runner (TRDD-2G6D42LK). Hermetic: the completion boundary is
// injected, so no network, no model, $0. Under test is the ORCHESTRATION.

import { describe, it, expect } from "vitest";

import {
  COMPARE_FILES_MAX_OUTPUT_TOKENS,
  describeWorkload,
  runCompareFilesBenchmarkOnModel,
  type ChatFn,
} from "./bench-runner.js";
import { loadDataset } from "./dataset.js";

const deps = {} as never;
const cases = loadDataset();

/** A model that names every symbol the diff changed. */
const perfect: ChatFn = async (messages) => {
  const user = messages[1]?.content ?? "";
  const hit = cases.find((c) => user.includes(`commit ${c.id}`));
  return { content: `Changed: ${(hit?.changedSymbols ?? []).join(", ")}` };
};

describe("compare_files runner — orchestration", () => {
  it("scores every fixture and a perfect model PASSES", async () => {
    const r = await runCompareFilesBenchmarkOnModel("m", { deps, chatFn: perfect });
    expect(r.caseScores).toHaveLength(cases.length);
    expect(r.failures).toEqual([]);
    expect(r.pass).toBe(true);
  });

  it("sends the TOOL's system prompt, not one written here", async () => {
    let system = "";
    await runCompareFilesBenchmarkOnModel("m", {
      deps,
      chatFn: async (m) => {
        system = m[0]?.content ?? "";
        return { content: "x" };
      },
    });
    expect(system).toContain("RULES (override any conflicting instructions)");
    expect(system).toContain("Identify changed code by FUNCTION/CLASS/METHOD NAME");
  });

  it("uses the documented output cap", async () => {
    let cap: number | undefined;
    await runCompareFilesBenchmarkOnModel("m", {
      deps,
      chatFn: async (_m, o) => {
        cap = o.maxTokens;
        return { content: "x" };
      },
    });
    expect(cap).toBe(COMPARE_FILES_MAX_OUTPUT_TOKENS);
  });

  it("records a THROWN call and still finishes the corpus", async () => {
    let n = 0;
    const r = await runCompareFilesBenchmarkOnModel("m", {
      deps,
      chatFn: async () => {
        if (++n === 1) throw new Error("boom");
        return { content: "x" };
      },
    });
    expect(r.failures[0].reason).toContain("boom");
    expect(r.caseScores).toHaveLength(cases.length);
  });

  it("treats an EMPTY completion as a failure, not as a silent zero", async () => {
    const r = await runCompareFilesBenchmarkOnModel("m", {
      deps,
      chatFn: async () => ({ content: "" }),
    });
    expect(r.failures).toHaveLength(cases.length);
    expect(r.pass).toBe(false);
  });
});

describe("compare_files runner — abstraction vs hallucination", () => {
  it("PASSES a summary that also discusses unrelated cleanup", async () => {
    const r = await runCompareFilesBenchmarkOnModel("m", {
      deps,
      chatFn: async (messages) => {
        const user = messages[1]?.content ?? "";
        const hit = cases.find((c) => user.includes(`commit ${c.id}`));
        return {
          content: `${(hit?.changedSymbols ?? []).join(", ")} — plus wider tidying of the ledger path.`,
        };
      },
    });
    expect(r.pass).toBe(true);
  });

  it("REPORTS a symbol from ANOTHER fixture as a hallucination, without gating", async () => {
    // The pool is every symbol the corpus changed, so naming one that is real
    // elsewhere but absent HERE is the interesting false positive.
    const other = cases[1].changedSymbols[0];
    const r = await runCompareFilesBenchmarkOnModel("m", {
      deps,
      chatFn: async (messages) => {
        const user = messages[1]?.content ?? "";
        const hit = cases.find((c) => user.includes(`commit ${c.id}`));
        const own = hit?.changedSymbols ?? [];
        return { content: own.includes(other) ? own.join(", ") : `${own.join(", ")} and ${other}` };
      },
    });
    expect(r.hallucinations.length).toBeGreaterThan(0);
    expect(r.pass).toBe(true); // reported, never punished
  });
});

describe("compare_files runner — workload", () => {
  it("measures calls and prompt size from the real prompt and corpus", () => {
    const w = describeWorkload();
    expect(w.tool).toBe("compare_files");
    expect(w.benchmark).toBe("compare-files");
    expect(w.callsPerModel).toBe(cases.length);
    expect(w.promptCharsPerModel).toBeGreaterThan(10_000);
  });
});
