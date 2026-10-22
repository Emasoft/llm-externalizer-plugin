// Guardrail (TRDD groupA-A2, 90DM5YHO lineage): a raw NUL byte inside a
// TypeScript source file corrupts fastedit's tree-sitter parser (it cannot
// locate the enclosing symbol's true span past the byte), so the very bug
// this test blocks is also one that makes itself hard to fix with the
// project's own editing tools once it lands. Catch it before it lands.
//
// The correct in-source separator is the SIX-character escape sequence
// backslash-u-0-0-0-0, which JS/TS turns into the single code-point-0
// character at RUN time. This test file must never contain that escape
// literally (or it would trip its own scanner's intent), so the expected
// string is built from character codes instead.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// __dirname == <repo>/scripts/llm-ext/src
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const SKIP_DIRS = new Set(["node_modules", "dist"]);

/** Recursive file listing, skipping any path segment named node_modules/dist. */
function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      walk(p, out);
    } else if (st.isFile()) {
      out.push(p);
    }
  }
  return out;
}

/** Every file this guardrail is responsible for, per the spec's exact scope. */
function collectTargets(): string[] {
  const files: string[] = [];
  // This package's whole src/ tree (recursive).
  walk(__dirname, files);
  // The repo's top-level scripts/*.mjs and scripts/*.py — direct children only.
  const scriptsDir = join(REPO_ROOT, "scripts");
  for (const entry of readdirSync(scriptsDir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const p = join(scriptsDir, entry);
    const st = statSync(p);
    if (st.isFile() && (entry.endsWith(".mjs") || entry.endsWith(".py"))) {
      files.push(p);
    }
  }
  // scripts/hooks/*, scripts/path-shim/* (recursive), and bin/* (recursive).
  walk(join(scriptsDir, "hooks"), files);
  walk(join(scriptsDir, "path-shim"), files);
  walk(join(REPO_ROOT, "bin"), files);
  return files;
}

describe("no raw NUL bytes in source", () => {
  it("scans more than 100 files", () => {
    const files = collectTargets();
    expect(files.length).toBeGreaterThan(100);
  });

  it("includes src/benchmark/validated.ts in the scan", () => {
    const files = collectTargets();
    expect(files.some((f) => f.endsWith(join("benchmark", "validated.ts")))).toBe(true);
  });

  it("contains no raw NUL (0x00) byte in any scanned file", () => {
    const files = collectTargets();
    const offenders: string[] = [];
    for (const f of files) {
      const buf = readFileSync(f);
      if (buf.indexOf(0) !== -1) offenders.push(f);
    }
    expect(offenders, `files with a raw NUL byte: ${offenders.join(", ")}`).toEqual([]);
  });

  it("validated.ts separates the memo key with the six-char escape, not a raw NUL", () => {
    const validatedPath = join(__dirname, "benchmark", "validated.ts");
    const source = readFileSync(validatedPath, "utf-8");
    // Built from character codes so this test file itself stays escape-free.
    const escape = String.fromCharCode(92) + "u0000";
    expect(source.includes("getConfigDir()}" + escape)).toBe(true);
  });
});
