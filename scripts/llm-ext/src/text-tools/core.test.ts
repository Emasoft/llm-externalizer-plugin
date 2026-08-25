// Unit tests for text-tools/core.ts — the four single-call text tools and the
// pure helpers they are built from. Hermetic: no network, no LLM. The only
// seam mocked is TextToolsDeps, which is the module's DESIGNED injection point
// (the real index.ts wires the same shape); every helper, validator, prompt
// builder, retry loop and response-gate check runs for real.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll } from "vitest";

import {
  cleanPlainText,
  extractJson,
  fenceFor,
  literalDedup,
  parsePhraseList,
  parseSemDedupResponse,
  parseTopicsResponse,
  readInput,
  runDescribe,
  runSemDeduplicate,
  runSummarize,
  runTopics,
  type TextToolsChatMessage,
  type TextToolsDeps,
  type TextToolsResult,
} from "./core.js";

const FAKE_REPORT_PATH = "/tmp/fake-report.md";

interface SavedCall {
  tool: string;
  content: string;
  meta: { model: string; task?: string; inputFile?: string; groupId?: string };
}

interface Harness {
  deps: TextToolsDeps;
  /** One entry per ensembleStreaming call: the messages it was sent. */
  calls: TextToolsChatMessage[][];
  saved: SavedCall[];
}

/**
 * A fake-LLM harness. `replies[i]` is returned for the i-th call; the last
 * entry repeats, so a single-element array means "always answer this".
 */
function makeHarness(replies: string[]): Harness {
  const calls: TextToolsChatMessage[][] = [];
  const saved: SavedCall[] = [];
  const deps: TextToolsDeps = {
    useEnsemble: false,
    defaultTemperature: 0,
    ensembleStreaming: async (messages) => {
      const index = calls.length;
      calls.push(messages);
      return {
        content: replies[Math.min(index, replies.length - 1)],
        model: "fake",
        finishReason: "stop",
        truncated: false,
      };
    },
    formatFooter: () => "",
    saveResponse: (tool, content, meta) => {
      saved.push({ tool, content, meta });
      return FAKE_REPORT_PATH;
    },
    resolveDefaultMaxTokens: () => 1000,
  };
  return { deps, calls, saved };
}

const textOf = (result: TextToolsResult): string => result.content[0].text;

let tmpDir: string;
let populatedFile: string;
let emptyFile: string;

beforeAll(() => {
  // Prefix carries the project marker so src/test-tmpdir-guard.ts can see it;
  // mkdtempSync is auto-removed by src/test-tmpdir-tracker.ts.
  tmpDir = mkdtempSync(join(tmpdir(), "llm-ext-text-tools-"));
  populatedFile = join(tmpDir, "notes.md");
  emptyFile = join(tmpDir, "blank.md");
  writeFileSync(populatedFile, "Alpha beta gamma delta epsilon.\n", "utf-8");
  writeFileSync(emptyFile, "   \n\t\n", "utf-8");
});

describe("pure helpers", () => {
  it("readInput reads a real file and reports it as the source path", () => {
    const got = readInput({ input_file: populatedFile });
    expect(got.error).toBeUndefined();
    expect(got.text).toBe("Alpha beta gamma delta epsilon.\n");
    expect(got.sourcePath).toBe(populatedFile);
  });

  it("readInput takes inline content and reports no source path", () => {
    const got = readInput({ input_content: "inline payload" });
    expect(got.error).toBeUndefined();
    expect(got.text).toBe("inline payload");
    expect(got.sourcePath).toBeUndefined();
  });

  it("readInput rejects both-sources, no-source and a whitespace-only file", () => {
    expect(
      readInput({ input_file: populatedFile, input_content: "x" }).error,
    ).toBe("Provide input_file OR input_content, not both.");
    expect(readInput({}).error).toBe(
      "Either input_file or input_content is required.",
    );
    expect(readInput({ input_file: emptyFile }).error).toBe(
      `Input file is empty: ${emptyFile}`,
    );
  });

  it("parsePhraseList parses a JSON string array and trims its entries", () => {
    expect(parsePhraseList('["alpha", " beta ", "gamma"]')).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
  });

  it("parsePhraseList parses one phrase per line, dropping blank lines", () => {
    expect(parsePhraseList("alpha\n\n  beta  \ngamma\n")).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
  });

  it("parsePhraseList splits a single comma-separated line", () => {
    expect(parsePhraseList("alpha, beta ,gamma")).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
  });

  it("literalDedup keys case- and whitespace-insensitively but keeps the first spelling", () => {
    const got = literalDedup([
      "Rasterize",
      "rasterize",
      "render  to image",
      "render to image",
      "other",
    ]);
    expect(got.survivors).toEqual(["Rasterize", "render  to image", "other"]);
    expect(got.removed).toEqual(["rasterize", "render to image"]);
  });

  it("extractJson unwraps a fenced ```json block", () => {
    expect(extractJson('```json\n{"language":"en"}\n```')).toEqual({
      language: "en",
    });
  });

  it("extractJson finds JSON surrounded by prose", () => {
    expect(
      extractJson('Sure! Here it is: {"a": 1, "b": [2]} — hope that helps.'),
    ).toEqual({ a: 1, b: [2] });
  });

  it("extractJson returns undefined when nothing parses", () => {
    expect(extractJson("no json here at all, just prose")).toBeUndefined();
  });

  it("cleanPlainText strips a wrapping code fence and surrounding quotes", () => {
    expect(cleanPlainText("```\nhello world\n```")).toBe("hello world");
    expect(cleanPlainText('  "quoted answer"  ')).toBe("quoted answer");
  });

  it("fenceFor returns a fence strictly longer than the longest backtick run inside", () => {
    expect(fenceFor("plain text")).toBe("```");
    expect(fenceFor("a ```` b ``` c")).toBe("`````");
  });
});

describe("parseTopicsResponse", () => {
  it("accepts a valid payload and trims/filters its entries", () => {
    const got = parseTopicsResponse(
      '{"language":" en ","keywords":[" alpha ",""],"keyphrases":["greek letters"]}',
    );
    expect(got).toEqual({
      language: "en",
      keywords: ["alpha"],
      keyphrases: ["greek letters"],
    });
  });

  it("rejects a payload missing the keyphrases field", () => {
    expect(
      parseTopicsResponse('{"language":"en","keywords":["alpha"]}'),
    ).toBeUndefined();
  });

  it("rejects a payload whose keyword and keyphrase arrays are both empty", () => {
    expect(
      parseTopicsResponse('{"language":"en","keywords":[],"keyphrases":[]}'),
    ).toBeUndefined();
  });
});

describe("parseSemDedupResponse", () => {
  it("accepts a case-normalized survivor and maps it back to the original input spelling", () => {
    const got = parseSemDedupResponse('["computer programming", "Rasterize"]', [
      "Computer Programming",
      "Rasterize",
      "coding",
    ]);
    expect(got.error).toBeUndefined();
    expect(got.survivors).toEqual(["Computer Programming", "Rasterize"]);
  });

  it("rejects a survivor that is not in the input list", () => {
    const got = parseSemDedupResponse('["quantum flux"]', ["computer programming"]);
    expect(got.survivors).toBeUndefined();
    expect(got.error).toContain("invented/reworded");
  });

  it("rejects a response that is not a JSON array of strings", () => {
    const got = parseSemDedupResponse('{"survivors": ["alpha"]}', ["alpha"]);
    expect(got.survivors).toBeUndefined();
    expect(got.error).toBe("response is not a JSON array of strings");
  });
});

describe("runSummarize", () => {
  it("saves the cleaned summary and returns the report path on the happy path", async () => {
    const h = makeHarness(['"Greek letters listed in order."']);
    const result = await runSummarize(
      { input_content: "Alpha beta gamma delta epsilon zeta eta theta.", max_chars: 200 },
      h.deps,
    );
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toBe(FAKE_REPORT_PATH);
    expect(h.calls).toHaveLength(1);
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0].tool).toBe("summarize");
    // Quotes stripped by cleanPlainText; footer is "" in this harness.
    expect(h.saved[0].content).toBe("Greek letters listed in order.");
    expect(h.saved[0].meta.model).toBe("fake");
  });

  it("fails after two over-length answers instead of truncating", async () => {
    const h = makeHarness([
      "A verbose restatement that plainly runs past the twenty-five character budget.",
    ]);
    const result = await runSummarize(
      { input_content: "Alpha beta gamma delta epsilon zeta.", max_chars: 25 },
      h.deps,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("FAILED:");
    expect(textOf(result)).toContain("over the 25-char limit");
    expect(h.calls).toHaveLength(2);
    expect(h.saved).toHaveLength(0);
  });

  it("retries once with a correction and succeeds when the second answer fits", async () => {
    const h = makeHarness([
      "A verbose restatement that plainly runs past the twenty-five character budget.",
      "Greek letters listed.",
    ]);
    const result = await runSummarize(
      { input_content: "Alpha beta gamma delta epsilon zeta.", max_chars: 25 },
      h.deps,
    );
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toBe(FAKE_REPORT_PATH);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1][1].content).toContain("your previous answer was rejected");
    expect(h.saved[0].content).toBe("Greek letters listed.");
  });
});

describe("runTopics", () => {
  it("renders the parsed topics payload into the saved report", async () => {
    const h = makeHarness([
      '{"language":"en","keywords":["alpha","beta"],"keyphrases":["greek letters"]}',
    ]);
    const result = await runTopics(
      { input_content: "Alpha beta gamma delta epsilon zeta eta theta." },
      h.deps,
    );
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toBe(FAKE_REPORT_PATH);
    expect(h.calls).toHaveLength(1);
    expect(h.saved[0].tool).toBe("topics");
    expect(h.saved[0].content).toContain("Language: en");
    expect(h.saved[0].content).toContain("- alpha");
    expect(h.saved[0].content).toContain("- greek letters");
  });

  it("fails after two answers that are not the required JSON object", async () => {
    const h = makeHarness([
      "I am unable to produce structured output for this request right now.",
    ]);
    const result = await runTopics(
      { input_content: "Alpha beta gamma delta epsilon zeta." },
      h.deps,
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(
      "response is not the required {language, keywords, keyphrases} JSON object",
    );
    expect(h.calls).toHaveLength(2);
    expect(h.saved).toHaveLength(0);
  });
});

describe("runSemDeduplicate", () => {
  it("reports the model's survivors plus the literal and semantic removals", async () => {
    const h = makeHarness(['["computer programming","rasterize"]']);
    const result = await runSemDeduplicate(
      {
        input_content:
          "computer programming\ncoding\nrasterize\nrender to image\nComputer Programming",
      },
      h.deps,
    );
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toBe(FAKE_REPORT_PATH);
    expect(h.calls).toHaveLength(1);
    const report = h.saved[0].content;
    expect(report).toContain("Deduplicated list (2 phrases):\ncomputer programming\nrasterize");
    expect(report).toContain("Removed as literal duplicates:\n- Computer Programming");
    expect(report).toContain("Removed as semantic duplicates:\n- coding\n- render to image");
    expect(report).toContain("Model: fake");
  });

  it("short-circuits without any LLM call when literal dedup leaves one phrase", async () => {
    const h = makeHarness(["should never be used"]);
    const result = await runSemDeduplicate(
      { input_content: "solo phrase\nSolo   Phrase" },
      h.deps,
    );
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toBe(FAKE_REPORT_PATH);
    expect(h.calls).toHaveLength(0);
    expect(h.saved[0].meta.model).toBe("none");
    expect(h.saved[0].content).toContain("Deduplicated list (1 phrases):\nsolo phrase");
    expect(h.saved[0].content).toContain("Model: none (literal dedup only)");
  });
});

describe("runDescribe", () => {
  it("fails on a missing input_file without calling the LLM", async () => {
    const h = makeHarness(["should never be used"]);
    const result = await runDescribe({ max_chars: 500 }, h.deps);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("FAILED: input_file is required.");
    expect(h.calls).toHaveLength(0);
    expect(h.saved).toHaveLength(0);
  });
});
