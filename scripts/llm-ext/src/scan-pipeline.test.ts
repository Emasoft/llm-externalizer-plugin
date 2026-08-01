/**
 * Unit tests for scan-pipeline.ts — the pure file-walking / FFD bin-packed
 * batching engine shared by scan_folder / search_existing.
 *
 * Focus: the deterministic, exported, high-value logic — the First-Fit
 * Decreasing bin packer (readAndGroupFiles), size-accounting (fenceBackticks,
 * estimateTokens), and the pure classifiers (isBinaryExtension, detectLang,
 * resolveAnswerMode, buildPerFileSectionPrompt).
 *
 * The ONLY external boundary touched is the filesystem — and for that we use
 * REAL temp dirs/files (never fs mocks), so the size-accounting and skip logic
 * is exercised against real statSync/readFileSync behaviour.
 *
 * IMPORTANT: temp files live under process.cwd() (NOT os.tmpdir()). On macOS
 * os.tmpdir() is $TMPDIR (/var/folders/...), which sanitizeInputPath REJECTS
 * because its allow-list is only cwd / $HOME / /tmp. cwd is always allowed, so
 * the real readFileAsCodeBlock path inside readAndGroupFiles actually reads the
 * files instead of silently skipping them on a traversal block.
 *
 * The FFD budget tests derive the EXACT per-file block size from the real
 * readFileAsCodeBlock output (via blockBytes()), so the pass/skip/split
 * assertions hold regardless of the fence/XML-tag/path-length overhead rather
 * than depending on a guessed constant.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  readAndGroupFiles,
  readFileAsCodeBlock,
  fenceBackticks,
  estimateTokens,
  isBinaryExtension,
  detectLang,
  resolveAnswerMode,
  buildPerFileSectionPrompt,
  type FileData,
} from "./scan-pipeline.js";

// One real temp root under cwd (an allowed sanitizeInputPath root); per-test
// files go inside it and are removed after the suite.
let root: string;

beforeAll(() => {
  root = mkdtempSync(join(process.cwd(), "scan-pipeline-test-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Write a file of exactly `size` bytes of ASCII 'a' and return its path. */
function makeFile(name: string, size: number): string {
  const p = join(root, name);
  writeFileSync(p, "a".repeat(size));
  return p;
}

/** The REAL fenced-block byte length the packer accounts for, for a given file. */
function blockBytes(filePath: string): number {
  return readFileAsCodeBlock(filePath, undefined, false, 1024 * 1024, null)
    .length;
}

/** Sum of block byte-lengths across every group (the packed payload size). */
function totalBlockBytes(groups: FileData[][]): number {
  return groups.reduce(
    (sum, g) => sum + g.reduce((s, fd) => s + fd.block.length, 0),
    0,
  );
}

describe("fenceBackticks — minimum-backtick fence sizing", () => {
  it("returns the 4-backtick floor for content with no backticks", () => {
    expect(fenceBackticks("const x = 1;\nno ticks here")).toBe("````");
  });

  it("grows to maxRun+1 when content has a run longer than the 3-backtick floor", () => {
    const content = "before ````` after"; // 5 consecutive backticks
    expect(fenceBackticks(content)).toBe("``````"); // 5 + 1 = 6
    // The fence MUST be strictly longer than the longest internal run so the
    // markdown block cannot be terminated early.
    expect(fenceBackticks(content).length).toBeGreaterThan(5);
  });
});

describe("estimateTokens — ~4-chars-per-token rounding", () => {
  it("rounds up partial tokens and returns 0 for the empty string", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1); // exactly 4 chars → 1 token
    expect(estimateTokens("abcde")).toBe(2); // 5 chars → ceil(1.25) = 2
  });
});

describe("isBinaryExtension — extension-based binary filter", () => {
  it("flags known binary extensions and the special .DS_Store basename, but not source files", () => {
    expect(isBinaryExtension("/x/photo.PNG")).toBe(true); // case-insensitive
    expect(isBinaryExtension("/x/archive.zip")).toBe(true);
    expect(isBinaryExtension("/x/.DS_Store")).toBe(true); // matched by basename, no extname
    expect(isBinaryExtension("/x/main.ts")).toBe(false);
    expect(isBinaryExtension("/x/README.md")).toBe(false);
  });
});

describe("detectLang — extension → language mapping", () => {
  it("maps known extensions case-insensitively and falls back to text for unknowns of nonexistent paths", () => {
    expect(detectLang("/x/main.TS")).toBe("typescript");
    expect(detectLang("/x/script.py")).toBe("python");
    // Unknown extension on a path that does not exist → shebang read fails →
    // the catch swallows it → "text" fallback.
    expect(detectLang("/nonexistent/file.unknownext")).toBe("text");
  });
});

describe("resolveAnswerMode — strict 0|1|2 with default fallback", () => {
  it("passes through valid modes and falls back to the default for anything else", () => {
    expect(resolveAnswerMode(0, 1)).toBe(0);
    expect(resolveAnswerMode(2, 1)).toBe(2);
    expect(resolveAnswerMode(3, 1)).toBe(1); // out of range → default
    expect(resolveAnswerMode("1", 2)).toBe(2); // wrong type (string) → default
    expect(resolveAnswerMode(undefined, 0)).toBe(0); // missing → default
  });
});

describe("buildPerFileSectionPrompt — multi-file section instruction", () => {
  it("returns empty for 0 or 1 files and embeds the exact count for many files", () => {
    expect(buildPerFileSectionPrompt([])).toBe("");
    expect(buildPerFileSectionPrompt(["/x/a.ts"])).toBe("");
    const prompt = buildPerFileSectionPrompt(["/x/a.ts", "/x/b.ts", "/x/c.ts"]);
    expect(prompt).toContain("receiving 3 input files");
    expect(prompt).toContain("Produce exactly 3 sections");
    expect(prompt).toContain("## File: <absolute-file-path>");
  });
});

describe("readAndGroupFiles — FFD bin-packing over real temp files", () => {
  it("returns an empty result with no groups when given no file paths", () => {
    const { groups, autoBatched, skipped } = readAndGroupFiles([], 0);
    expect(groups).toEqual([]);
    expect(autoBatched).toBe(false);
    expect(skipped).toEqual([]);
  });

  it("packs everything into a single un-batched group when total fits the budget", () => {
    const f1 = makeFile("fit-a.txt", 200);
    const f2 = makeFile("fit-b.txt", 200);
    // 50 KB budget is far above two small blocks + their fence/tag overhead.
    const { groups, autoBatched, skipped } = readAndGroupFiles(
      [f1, f2],
      0,
      false,
      50 * 1024,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(2);
    expect(autoBatched).toBe(false);
    expect(skipped).toEqual([]);
  });

  it("skips a file whose raw size exceeds the total budget (can never fit any bin)", () => {
    // Budget is floored to 10 KB internally; a 12 KB file is strictly larger
    // than the effective total budget → skipped by the raw-size guard.
    const big = makeFile("oversized.txt", 12 * 1024);
    const small = makeFile("small.txt", 100);
    const { groups, skipped } = readAndGroupFiles(
      [big, small],
      0,
      false,
      1024, // requested 1 KB → floored to 10 KB total budget
    );
    expect(skipped).toContain(big);
    // The small file still fits and forms exactly one group.
    expect(groups).toHaveLength(1);
    expect(groups[0].map((fd) => fd.path)).toEqual([small]);
  });

  it("keeps a single un-batched group when the payload exactly equals the available budget (<= boundary)", () => {
    // The single-group fast-path uses `totalFileBytes <= availableForFiles`.
    // Set the budget (== availableForFiles, prompt=0) to EXACTLY the two blocks'
    // combined byte length: equality must still collapse to one group, not split.
    const a = makeFile("exact-a.txt", 12 * 1024);
    const b = makeFile("exact-b.txt", 12 * 1024);
    const exact = blockBytes(a) + blockBytes(b); // both ~12.3 KB, above the 10 KB floor
    const { groups, autoBatched, skipped } = readAndGroupFiles(
      [a, b],
      0,
      false,
      exact, // availableForFiles === totalFileBytes
    );
    expect(skipped).toEqual([]);
    expect(groups).toHaveLength(1); // exact fit → single group, not batched
    expect(autoBatched).toBe(false);
    expect(groups[0]).toHaveLength(2);
    // One byte less than the exact total forces a split (proves the boundary).
    const split = readAndGroupFiles([a, b], 0, false, exact - 1);
    expect(split.groups.length).toBeGreaterThan(1);
    expect(split.autoBatched).toBe(true);
  });

  it("splits into separate bins via FFD when two blocks cannot share the available space", () => {
    // readAndGroupFiles floors the effective budget at 10 KB
    // (Math.max(10*1024, budgetBytes)). Use ~12 KB files so each block is well
    // above that floor: one block fits the budget, two do not → FFD must open a
    // second bin. Sizing the budget from the REAL measured block keeps the
    // split deterministic regardless of fence/XML overhead.
    const a = makeFile("split-a.txt", 12 * 1024);
    const b = makeFile("split-b.txt", 12 * 1024);
    const oneBlock = blockBytes(a); // both files are the same size; ~12.3 KB > 10 KB floor
    // budget (== availableForFiles, prompt=0): >= one block, < two blocks.
    const budget = oneBlock + 50; // room for exactly one block, not two
    const { groups, autoBatched, skipped } = readAndGroupFiles(
      [a, b],
      0,
      false,
      budget,
    );
    expect(skipped).toEqual([]); // each block fits the budget alone
    expect(groups).toHaveLength(2); // forced to split into two bins
    expect(autoBatched).toBe(true);
    // No bin exceeds availableForFiles, and every file appears exactly once.
    for (const g of groups) {
      const used = g.reduce((s, fd) => s + fd.block.length, 0);
      expect(used).toBeLessThanOrEqual(budget);
    }
    expect(groups.flat().map((fd) => fd.path).sort()).toEqual([a, b].sort());
  });

  it("packs deterministically (largest-first) and conserves total bytes across runs", () => {
    // Distinct sizes so the largest-first sort has a stable, observable order.
    // `big` is ~12 KB so blockBytes(big)+50 stays above the 10 KB budget floor
    // and the budget controls packing (rather than the floor silently widening
    // the available space). One big block fills a bin alone → multi-bin → the
    // first-bin-gets-largest ordering is observable.
    const big = makeFile("det-big.txt", 12 * 1024);
    const mid = makeFile("det-mid.txt", 3 * 1024);
    const tiny = makeFile("det-tiny.txt", 1 * 1024);
    // Budget that fits exactly one big block alone (forces multi-bin so the
    // first-bin-gets-largest ordering is observable).
    const budget = blockBytes(big) + 50;
    const run = () =>
      readAndGroupFiles([tiny, mid, big], 0, false, budget); // input order unsorted

    const r1 = run();
    const r2 = run();

    // Determinism: identical grouping (by path) on repeated runs.
    const shape = (groups: FileData[][]) =>
      groups.map((g) => g.map((fd) => fd.path));
    expect(shape(r1.groups)).toEqual(shape(r2.groups));

    // FFD sorts largest-first: the biggest file lands in the first bin ahead of
    // the smaller files, regardless of input order.
    expect(r1.groups.length).toBeGreaterThan(0);
    expect(r1.groups[0][0].path).toBe(big);

    // No bytes lost or duplicated: every input file is packed exactly once.
    expect(r1.groups.flat().map((fd) => fd.path).sort()).toEqual(
      [big, mid, tiny].sort(),
    );
    // Byte total is positive and identical across runs.
    expect(totalBlockBytes(r1.groups)).toBe(totalBlockBytes(r2.groups));
    expect(totalBlockBytes(r1.groups)).toBeGreaterThan(0);
  });

  it("subtracts promptBytes from the budget so a large prompt forces more batching", () => {
    // ~12 KB files so a single block exceeds the 10 KB budget floor; the budget
    // (~25 KB, two blocks + slack) is well above the floor, so promptBytes is
    // subtracted from the real budget rather than from the floor.
    const a = makeFile("prompt-a.txt", 12 * 1024);
    const b = makeFile("prompt-b.txt", 12 * 1024);
    const oneBlock = blockBytes(a); // both same size
    // Budget that fits BOTH blocks together when prompt is ~0.
    const budget = oneBlock * 2 + 200;
    const noPrompt = readAndGroupFiles([a, b], 0, false, budget);
    expect(noPrompt.groups).toHaveLength(1); // both share one bin

    // Reserve enough of the same budget for the prompt that only one block now
    // fits the remaining space (availableForFiles = budget - promptBytes) → the
    // two blocks can no longer share a bin.
    const promptBytes = oneBlock + 150; // leaves room for < two blocks
    const bigPrompt = readAndGroupFiles([a, b], promptBytes, false, budget);
    expect(bigPrompt.groups.length).toBeGreaterThan(noPrompt.groups.length);
    expect(bigPrompt.autoBatched).toBe(true);
  });
});
