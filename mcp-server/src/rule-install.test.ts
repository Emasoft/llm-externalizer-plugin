// Unit tests for the usage-rule installer (Task: install the rule into
// ~/.claude/rules via the MCP server subprocess). Offline + sandboxed: source
// + destination are tmp dirs under /tmp (an allowed write root), env saved/restored.

import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  installUsageRule,
  resolveClaudeRulesDir,
  RULE_FILENAME,
} from "./rule-install.js";

const SRC_V1 = "# Use LLM Externalizer\n\nrule body v1\n";
const SRC_V2 = "# Use LLM Externalizer\n\nrule body v2 (updated)\n";

const tmpDirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {
  LLM_EXT_INSTALL_RULE: process.env.LLM_EXT_INSTALL_RULE,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
};

function mkTmp(prefix: string): string {
  // os.tmpdir(), not a literal "/tmp" — matches the installer's allowed-root
  // logic and works on every platform (Windows %TEMP%, macOS /var/folders, …).
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
function mkSource(content: string): string {
  const p = join(mkTmp("llm-ext-rule-src-"), RULE_FILENAME);
  writeFileSync(p, content, "utf-8");
  return p;
}

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("installUsageRule", () => {
  it("installs the rule when the destination is absent", () => {
    const sourcePath = mkSource(SRC_V1);
    const rulesDir = mkTmp("llm-ext-rule-dst-");
    const res = installUsageRule({ sourcePath, rulesDir });
    expect(res.status).toBe("installed");
    expect(res.dest).toBe(join(rulesDir, RULE_FILENAME));
    expect(readFileSync(res.dest, "utf-8")).toBe(SRC_V1);
  });

  it("is a no-op (unchanged) when content already matches", () => {
    const sourcePath = mkSource(SRC_V1);
    const rulesDir = mkTmp("llm-ext-rule-dst-");
    expect(installUsageRule({ sourcePath, rulesDir }).status).toBe("installed");
    const second = installUsageRule({ sourcePath, rulesDir });
    expect(second.status).toBe("unchanged");
  });

  it("updates when the bundled content differs from the installed copy", () => {
    const rulesDir = mkTmp("llm-ext-rule-dst-");
    installUsageRule({ sourcePath: mkSource(SRC_V1), rulesDir });
    const res = installUsageRule({ sourcePath: mkSource(SRC_V2), rulesDir });
    expect(res.status).toBe("updated");
    expect(readFileSync(join(rulesDir, RULE_FILENAME), "utf-8")).toBe(SRC_V2);
  });

  it("skips entirely when LLM_EXT_INSTALL_RULE=0", () => {
    process.env.LLM_EXT_INSTALL_RULE = "0";
    const sourcePath = mkSource(SRC_V1);
    const rulesDir = mkTmp("llm-ext-rule-dst-");
    const res = installUsageRule({ sourcePath, rulesDir });
    expect(res.status).toBe("skipped");
    expect(existsSync(join(rulesDir, RULE_FILENAME))).toBe(false);
  });

  it("errors (no throw) when the source is missing", () => {
    const rulesDir = mkTmp("llm-ext-rule-dst-");
    const res = installUsageRule({
      sourcePath: "/tmp/llm-ext-does-not-exist-xyz/use-llm-externalizer.md",
      rulesDir,
    });
    expect(res.status).toBe("error");
    expect(existsSync(join(rulesDir, RULE_FILENAME))).toBe(false);
  });

  it("refuses to write outside home / CLAUDE_CONFIG_DIR / tmp", () => {
    const sourcePath = mkSource(SRC_V1);
    // A root-level path that is under neither $HOME nor the OS temp dir.
    const res = installUsageRule({
      sourcePath,
      rulesDir: "/llm-ext-forbidden-root-xyz/rules",
    });
    expect(res.status).toBe("error");
    expect(res.detail).toMatch(/refusing to write/);
  });

  it("accepts the OS temp dir (os.tmpdir()) as an allowed write root", () => {
    // The sandbox dirs come from os.tmpdir(); a successful install there proves
    // tmpdir() is treated as an allowed root on this platform (Issue 8).
    const sourcePath = mkSource(SRC_V1);
    const rulesDir = mkTmp("llm-ext-rule-dst-");
    expect(rulesDir.startsWith(tmpdir())).toBe(true);
    const res = installUsageRule({ sourcePath, rulesDir });
    expect(res.status).toBe("installed");
    expect(readFileSync(res.dest, "utf-8")).toBe(SRC_V1);
  });

  it("leaves no orphan .tmp file when the rename fails (Issue 7)", () => {
    const sourcePath = mkSource(SRC_V1);
    const rulesDir = mkTmp("llm-ext-rule-dst-");
    // Make the destination a NON-EMPTY directory so renameSync(tmp, dest) throws
    // (a file cannot replace a non-empty directory). The tmp file IS written
    // first, so the rename then fails — exercising the catch's cleanup branch.
    const dest = join(rulesDir, RULE_FILENAME);
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "blocker"), "x", "utf-8");

    const res = installUsageRule({ sourcePath, rulesDir });
    expect(res.status).toBe("error");
    expect(res.detail).toMatch(/write failed/);
    // No leftover "<RULE_FILENAME>.tmp.*" file remains in the rules dir.
    const orphans = readdirSync(rulesDir).filter((n) =>
      n.startsWith(RULE_FILENAME + ".tmp."),
    );
    expect(orphans).toEqual([]);
  });
});

describe("resolveClaudeRulesDir", () => {
  it("defaults to ~/.claude/rules when CLAUDE_CONFIG_DIR is unset", () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    expect(resolveClaudeRulesDir().endsWith(join(".claude", "rules"))).toBe(true);
  });

  it("honors an explicit CLAUDE_CONFIG_DIR", () => {
    const cfg = mkTmp("llm-ext-cfg-");
    process.env.CLAUDE_CONFIG_DIR = cfg;
    expect(resolveClaudeRulesDir()).toBe(join(cfg, "rules"));
  });
});
