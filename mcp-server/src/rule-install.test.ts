// Unit tests for the usage-rule installer (Task: install the rule into
// ~/.claude/rules via the MCP server subprocess). Offline + sandboxed: source
// + destination are tmp dirs under /tmp (an allowed write root), env saved/restored.

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
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
  const d = mkdtempSync(join("/tmp", prefix));
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
    // A root-level path that is under neither $HOME nor /tmp.
    const res = installUsageRule({
      sourcePath,
      rulesDir: "/llm-ext-forbidden-root-xyz/rules",
    });
    expect(res.status).toBe("error");
    expect(res.detail).toMatch(/refusing to write/);
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
