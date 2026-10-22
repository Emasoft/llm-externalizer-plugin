// check_references runner (TRDD-2G6D42LK). Hermetic — completion injected, $0.

import { describe, it, expect } from "vitest";

import {
  CHECK_REFERENCES_MAX_OUTPUT_TOKENS,
  describeWorkload,
  parseVerdict,
  runCheckReferencesBenchmarkOnModel,
  type ChatFn,
} from "./bench-runner.js";
import { loadDataset } from "./dataset.js";

const deps = {} as never;
const cases = loadDataset();

describe("check_references — verdict parsing", () => {
  it("reads the anchored line in either direction", () => {
    expect(parseVerdict("VERDICT: BROKEN\nbecause it moved")).toBe(true);
    expect(parseVerdict("VERDICT: OK")).toBe(false);
  });

  it("is NOT fooled by prose containing the word broken", () => {
    // The reason the verdict is anchored rather than keyword-sniffed: a model
    // explaining "this is NOT broken" must not be scored as saying broken.
    expect(parseVerdict("This import is not broken at all.")).toBeNull();
  });

  it("returns null for an unreadable reply — never a silent OK", () => {
    expect(parseVerdict("")).toBeNull();
    expect(parseVerdict("I think it might be fine?")).toBeNull();
  });
});

describe("check_references runner — orchestration", () => {
  const oracle: ChatFn = async (messages) => {
    const user = messages[1]?.content ?? "";
    const hit = cases.find((c) => user.startsWith(`Symbol: ${c.symbol}`));
    return { content: `VERDICT: ${hit?.broken ? "BROKEN" : "OK"}` };
  };

  it("a model that answers correctly PASSES", async () => {
    const r = await runCheckReferencesBenchmarkOnModel("m", { deps, chatFn: oracle });
    expect(r.failures).toEqual([]);
    expect(r.pass).toBe(true);
  });

  it("FAILS a model that calls EVERY binding broken — the negative control biting", async () => {
    // Without the intact fixture this strategy would score perfect recall. This
    // test is the corpus's negative control doing its job end to end.
    const r = await runCheckReferencesBenchmarkOnModel("m", {
      deps,
      chatFn: async () => ({ content: "VERDICT: BROKEN" }),
    });
    expect(r.pass).toBe(false);
  });

  it("FAILS a model that calls every binding fine", async () => {
    const r = await runCheckReferencesBenchmarkOnModel("m", {
      deps,
      chatFn: async () => ({ content: "VERDICT: OK" }),
    });
    expect(r.pass).toBe(false);
  });

  it("records an unanchored reply as a failure, and finishes the corpus", async () => {
    const r = await runCheckReferencesBenchmarkOnModel("m", {
      deps,
      chatFn: async () => ({ content: "probably fine" }),
    });
    expect(r.failures).toHaveLength(cases.length);
    expect(r.verdicts).toHaveLength(cases.length);
    expect(r.pass).toBe(false);
  });

  it("records a THROWN call and still finishes", async () => {
    let n = 0;
    const r = await runCheckReferencesBenchmarkOnModel("m", {
      deps,
      chatFn: async () => {
        if (++n === 1) throw new Error("boom");
        return { content: "VERDICT: OK" };
      },
    });
    expect(r.failures[0].reason).toContain("boom");
    expect(r.verdicts).toHaveLength(cases.length);
  });

  it("uses the documented cap and temperature 0", async () => {
    let opts: { maxTokens?: number; temperature?: number } | undefined;
    await runCheckReferencesBenchmarkOnModel("m", {
      deps,
      chatFn: async (_m, o) => {
        opts = o;
        return { content: "VERDICT: OK" };
      },
    });
    expect(opts?.maxTokens).toBe(CHECK_REFERENCES_MAX_OUTPUT_TOKENS);
    expect(opts?.temperature).toBe(0);
  });
});

describe("check_references — workload", () => {
  it("measures from the real fixtures", () => {
    const w = describeWorkload();
    expect(w.tool).toBe("check_references");
    expect(w.callsPerModel).toBe(cases.length);
    expect(w.promptCharsPerModel).toBeGreaterThan(1000);
  });
});
