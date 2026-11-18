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
  walkDir,
  sanitizeInputPath,
  redactSecrets,
  type FileData,
} from "./scan-pipeline.js";
import { mkdirSync, realpathSync } from "node:fs";

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

describe("walkDir --preview reason channel (TRDD-SCLGL8T4) — every exclusion class reports WHY", () => {
  it("manual walk reports binary/extension/excluded-dir/hidden-dir with reasons, from the SAME walk that selects", () => {
    const dir = join(root, "preview-fixture");
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    // NOT in WALK_DEFAULT_EXCLUDE (unlike .cache/.git), so it exercises the
    // hidden-dir branch rather than the excluded-dir branch.
    mkdirSync(join(dir, ".myhidden"), { recursive: true });
    writeFileSync(join(dir, "keep.ts"), "export const x = 1;\n");
    writeFileSync(join(dir, "skip.png"), "not really a png\n");
    writeFileSync(join(dir, "skip.md"), "# doc\n");
    writeFileSync(join(dir, "node_modules", "dep.ts"), "export {};\n");

    const excluded: Array<{ path: string; reason: string }> = [];
    const files = walkDir(dir, {
      extensions: [".ts"],
      useGitignore: false, // force the manual branch — deterministic in a tmp dir
      onExcluded: (path, reason) => excluded.push({ path, reason }),
    });

    expect(files).toEqual([join(dir, "keep.ts")]);
    const byPath = new Map(excluded.map((e) => [e.path, e.reason]));
    expect(byPath.get(join(dir, "skip.png"))).toBe("binary extension");
    expect(byPath.get(join(dir, "skip.md"))).toBe("extension filter");
    expect(byPath.get(join(dir, "node_modules"))).toBe("excluded dir");
    expect(byPath.get(join(dir, ".myhidden"))).toBe("hidden dir");
    // The dep inside the excluded dir was never even visited — the dir-level
    // reason covers it, and reporting it per-file would require entering the
    // excluded tree (which the real selection rightly never does).
    expect(byPath.has(join(dir, "node_modules", "dep.ts"))).toBe(false);
  });

  it("omitting onExcluded changes nothing — the callback is observation-only", () => {
    const dir = join(root, "preview-fixture-2");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a.ts"), "export {};\n");
    writeFileSync(join(dir, "b.png"), "x\n");
    expect(walkDir(dir, { extensions: [".ts"], useGitignore: false })).toEqual([
      join(dir, "a.ts"),
    ]);
  });
});

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


describe("redactSecrets — ENV_SECRET and PEM_BLOCK are linear-time (TRDD-G49XPDNI)", () => {
  it("hostile newline+whitespace blob (100 KB) redacts in under 1000 ms", () => {
    /** the old `\s*` spanned newlines and was quadratic: 100 KB took ~2.4 s, 500 KB > 120 s. */
    const blob = "\n    ".repeat(20_000);
    const started = performance.now();
    const out = redactSecrets(blob);
    const elapsed = performance.now() - started;
    expect(out.count).toBe(0);
    expect(elapsed).toBeLessThan(1000);
  });

  it("still redacts a real indented ENV_SECRET assignment", () => {
    /** the line-local `[ \t]*` rewrite keeps catching KEY=value lines. */
    const r = redactSecrets("    API_KEY = 'abcd1234efgh5678'\n");
    expect(r.count).toBe(1);
    expect(r.redacted).not.toContain("abcd1234efgh5678");
  });

  it("redacts an ENV_SECRET whose value is on the line after the separator (YAML shape)", () => {
    /** the line-local rewrite first lost `API_KEY:` newline `  value`; the optional single newline recovers it. */
    const r = redactSecrets("API_KEY:\n  abcd1234efgh5678\n");
    expect(r.count).toBe(1);
    expect(r.redacted).not.toContain("abcd1234efgh5678");
  });

  it("redacts an ENV_SECRET with a blank line between the separator and the value, and one with the separator on the next line", () => {
    /** the old `\s*` covered both shapes; the bounded-newline form must still redact them (fail closed). */
    for (const text of ["API_KEY:\n\n  abcd1234efgh5678\n", "API_KEY\n= abcd1234efgh5678\n", "\n\x0bPASSWORD=abcd1234efgh5678\n"]) {
      const r = redactSecrets(text);
      expect(r.count).toBeGreaterThanOrEqual(1);
      expect(r.redacted).not.toContain("abcd1234efgh5678");
    }
  });

  it("redacts a terminated PEM block with a 20000-char body whole, through its END line", () => {
    /** a body longer than the 16384-char window must not leave its tail or the END line visible. */
    const b64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let body = "";
    for (let i = 0; i < 20_000; i++) body += b64[i % 64] + (i % 64 === 63 ? "\n" : "");
    const pem = "-----BEGIN " + "PRIVATE KEY-----\n" + body + "\n-----END " + "PRIVATE KEY-----";
    const r = redactSecrets("before\n" + pem + "\nafter");
    expect(r.redacted).toBe("before\n[REDACTED:PEM_BLOCK]\nafter");
    expect(r.count).toBe(1);
  });

  it("redacts an ENV_SECRET with up to 3 newlines before the separator or after it", () => {
    /** the old `\s*` covered these; the bounded `{0,3}` newline groups on both sides of the separator must too (fail closed). */
    for (const text of ["API_KEY\n\n= abcd1234efgh5678\n", "API_KEY\n\n\n= abcd1234efgh5678\n", "API_KEY:\n\n\n  abcd1234efgh5678\n", "API_KEY\n\n\n=\n\n\n  abcd1234efgh5678\n"]) {
      const r = redactSecrets(text);
      expect(r.count).toBeGreaterThanOrEqual(1);
      expect(r.redacted).not.toContain("abcd1234efgh5678");
    }
  });

  it("redacts an ENV_SECRET whose separator or value is after a bare CR line break (old Mac file)", () => {
    /** the old `\s*` matched a lone `\r`; `\r?\n` alone did not, which leaked these values to the model. */
    for (const text of ["API_KEY\r= abcd1234efgh5678\r", "API_KEY=\r  abcd1234efgh5678\r", "API_KEY:\r\r  abcd1234efgh5678\r"]) {
      const r = redactSecrets(text);
      expect(r.count).toBeGreaterThanOrEqual(1);
      expect(r.redacted).not.toContain("abcd1234efgh5678");
    }
  });

  it("DOCUMENTED LIMIT: ENV_SECRET values separated from the key by 4+ newlines (before or after the separator) are NOT redacted", () => {
    /** pins the bounded-newline trade-off (the old unbounded `\s*` matched these but backtracked > 120 s on 500 KB); widening must update this test on purpose. */
    for (const text of ["API_KEY:\n\n\n\n\n  abcd1234efgh5678\n", "API_KEY\n\n\n\n\n= abcd1234efgh5678\n"]) {
      expect(redactSecrets(text).redacted).toContain("abcd1234efgh5678");
    }
  });

  it("hostile PEM (20000 unterminated BEGIN headers) redacts in under 1000 ms, header gone", () => {
    /** the old lazy [\s\S]*? re-scanned to end of input per header (quadratic). */
    const hostile = "-----BEGIN " + "PRIVATE KEY" + "-----";
    const input = hostile.repeat(20_000);
    const started = performance.now();
    const out = redactSecrets(input);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(1000);
    expect(out.redacted).not.toContain("BEGIN PRIVATE KEY");
  });

  it("redacts a terminated PEM block whole", () => {
    /** a normal-size block is still one BEGIN..END match. */
    const pem = "-----BEGIN RSA " + "PRIVATE KEY-----\n" + "MIIEowIBAAKCAQEAx7Qz".repeat(160) + "\n-----END RSA " + "PRIVATE KEY-----";
    const r = redactSecrets("before\n" + pem + "\nafter");
    expect(r.redacted).toBe("before\n[REDACTED:PEM_BLOCK]\nafter");
  });
});

describe("sanitizeInputPath — rejection names the allowed roots (TRDD-1FJAUVBU)", () => {
  it("lists cwd, home and /tmp and says how to proceed", () => {
    // WHY a private HOME: with HOME=/ (some CI images) /etc/hosts is inside the home root and is
    // allowed, so the test would fail for the wrong reason (same class as commit 2fcbb1df).
    const fakeHome = mkdtempSync(join(realpathSync("/tmp"), "llm-ext-home-"));
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    let message = "";
    try {
      sanitizeInputPath("/etc/hosts");
    } catch (e) {
      message = (e as Error).message;
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(fakeHome, { recursive: true, force: true });
    }
    // The refusal must come from the traversal check, not be absent because cwd is an ancestor of /etc.
    expect(message).toContain("Path traversal blocked");
    expect(message).toContain(realpathSync(process.cwd()));
    expect(message).toContain(fakeHome);
    expect(message).toContain(realpathSync("/tmp"));
    expect(message).toMatch(/parent directory/);
    expect(message).toMatch(/copy/);
  });
});
