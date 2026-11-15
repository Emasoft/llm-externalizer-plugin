// Unit tests for the usage-rule installer (Task: install the rule into
// ~/.claude/rules via the MCP server subprocess). Offline + sandboxed: source
// + destination are tmp dirs under /tmp (an allowed write root), env saved/restored.

import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  installUsageRule,
  resolveBundledRulePath,
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

// The suite-wide hermetic setup sets LLM_EXT_INSTALL_RULE=0; this file tests installation itself, so it
// clears the opt-out (afterEach restores the saved value). Every call passes an explicit rulesDir.
beforeEach(() => {
  delete process.env.LLM_EXT_INSTALL_RULE;
});
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

describe("installUsageRule version marker", () => {
  const withVersion = (v: string, body: string): string =>
    `<!-- llm-ext-rule-version: ${v} -->\n# Use LLM Externalizer\n\n${body}\n`;

  function installThenRun(installed: string, bundled: string) {
    const rulesDir = mkTmp("llm-ext-rule-dst-");
    const dest = join(rulesDir, RULE_FILENAME);
    writeFileSync(dest, installed, "utf-8");
    const res = installUsageRule({ sourcePath: mkSource(bundled), rulesDir });
    return { res, dest };
  }

  it("keeps an installed rule with a HIGHER version and says so", () => {
    const installed = withVersion("3", "newer text");
    const { res, dest } = installThenRun(installed, withVersion("2", "older text"));
    expect(res.status).toBe("unchanged");
    expect(res.detail).toMatch(/newer/);
    expect(readFileSync(dest, "utf-8")).toBe(installed);
  });

  it("replaces an installed rule with a LOWER version", () => {
    const bundled = withVersion("3", "newer text");
    const { res, dest } = installThenRun(withVersion("2", "older text"), bundled);
    expect(res.status).toBe("updated");
    expect(readFileSync(dest, "utf-8")).toBe(bundled);
  });

  it("replaces an installed rule that has no marker", () => {
    const bundled = withVersion("1", "marked text");
    const { res, dest } = installThenRun(SRC_V1, bundled);
    expect(res.status).toBe("updated");
    expect(readFileSync(dest, "utf-8")).toBe(bundled);
  });

  it("treats a malformed marker as no marker and replaces it", () => {
    const bundled = withVersion("1", "marked text");
    const { res, dest } = installThenRun(withVersion("abc", "broken marker"), bundled);
    expect(res.status).toBe("updated");
    expect(readFileSync(dest, "utf-8")).toBe(bundled);
  });
});

// The body (everything after the marker line) of each released rule version. WHY a pin: the installer keeps an installed
// rule whose marker is HIGHER than the bundled one, so an edit of the text with no bump never reaches a machine that already
// has this version. Editing the rule means: bump the marker in rules/use-llm-externalizer.md AND add the new version here.
const PINNED_RULE_BODY_SHA256: Record<number, string> = {
  1: "a1e2f9f33c72622eaddf1de9302f87376d0fcb494eaf419b6b960a6b977872c6",
  2: "1c4b0fd2022168ee164707704e097ee9ff756ae5b7de9b02fde522355bedbaff",
  3: "1dfffaf1be478a51c11fa37942ea4100189aca6d4be3339f9db48caca0176095",
  // TRDD-PNU8XECB: v4 states the shipped reports/ (final) vs reports_dev/ (intermediate) defaults.
  4: "4eea69f1019bece203b1d940e5eb7372e0e3c3cdd6e8308b1e1aff8c02735fd8",
};

describe("the bundled rule text is pinned to its version marker", () => {
  it("the body of rules/use-llm-externalizer.md hashes to the value pinned for its marker version", () => {
    // The checkout's own rule, not an installed plugin's copy a CLAUDE_PLUGIN_ROOT in the environment would name.
    const savedRoot = process.env.CLAUDE_PLUGIN_ROOT;
    delete process.env.CLAUDE_PLUGIN_ROOT;
    const path = resolveBundledRulePath();
    if (savedRoot !== undefined) process.env.CLAUDE_PLUGIN_ROOT = savedRoot;
    expect(path, "the bundled rule must exist next to the plugin").not.toBeNull();
    const text = readFileSync(path as string, "utf-8");
    const newline = text.indexOf("\n");
    const marker = /^<!-- llm-ext-rule-version: (\d+) -->$/.exec(text.slice(0, newline));
    expect(marker, "the first line of the rule must be the version marker").not.toBeNull();
    const version = Number((marker as RegExpExecArray)[1]);
    const actual = createHash("sha256").update(text.slice(newline + 1)).digest("hex");
    expect(
      PINNED_RULE_BODY_SHA256[version],
      `no hash is pinned for rule version ${version}: add "${version}: "${actual}"" to PINNED_RULE_BODY_SHA256`,
    ).toBeDefined();
    expect(
      actual,
      `rules/use-llm-externalizer.md changed but its marker is still version ${version}: bump <!-- llm-ext-rule-version: N --> in the rule (an unbumped edit never replaces an installed copy of the same or a newer version) and pin the new hash in PINNED_RULE_BODY_SHA256`,
    ).toBe(PINNED_RULE_BODY_SHA256[version]);
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
