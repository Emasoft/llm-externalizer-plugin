import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Guard test for TRDD-1e2b87cb: the codex integration was removed because
// invoking the `codex` CLI from inside Claude Code clobbers CLAUDE_PLUGIN_DATA
// and breaks every other plugin. This test FAILS if any shipped file ever
// reintroduces a codex *invocation* (not mere prose mentioning codex), so the
// integration can never come back silently.

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, "..", "..");

// Shipped surfaces that could shell out to codex. Mirrors the verification
// scope in the TRDD: commands/ scripts/ skills/ mcp-server/src bin hooks .mcp.json.
const SHIPPED_DIRS = ["commands", "scripts", "skills", join("mcp-server", "src"), "bin", "hooks"];
const SHIPPED_FILES = [".mcp.json"];

// Directories never walked (build output, caches, deps).
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "__pycache__", ".mypy_cache"]);

// This guard test legitimately contains the patterns as string literals.
const SELF = __filename;

// Patterns that constitute an actual codex INVOCATION. Plain prose that merely
// names codex (e.g. "never use codex") is intentionally NOT matched.
const INVOCATION_PATTERNS: RegExp[] = [
  /codex\s+exec/,
  /--dangerously-bypass-approvals-and-sandbox/,
  /subprocess[^\n]*codex/,
  /shutil\.which\(\s*["']codex["']\s*\)/,
];

function walk(path: string, out: string[]): void {
  if (!existsSync(path)) return;
  const st = statSync(path);
  if (st.isFile()) {
    out.push(path);
    return;
  }
  for (const entry of readdirSync(path)) {
    if (SKIP_DIRS.has(entry)) continue;
    walk(join(path, entry), out);
  }
}

function collectShippedFiles(): string[] {
  const files: string[] = [];
  for (const dir of SHIPPED_DIRS) walk(join(REPO_ROOT, dir), files);
  for (const file of SHIPPED_FILES) walk(join(REPO_ROOT, file), files);
  return files.filter((f) => f !== SELF);
}

describe("no-codex-invocation: shipped tree must never invoke the codex CLI", () => {
  it("contains no codex invocation pattern in any shipped file", () => {
    const offenders: string[] = [];
    for (const file of collectShippedFiles()) {
      const text = readFileSync(file, "utf-8");
      for (const re of INVOCATION_PATTERNS) {
        if (re.test(text)) {
          offenders.push(`${file} matched ${re}`);
        }
      }
    }
    expect(
      offenders,
      `Codex invocation reintroduced (TRDD-1e2b87cb forbids this):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
