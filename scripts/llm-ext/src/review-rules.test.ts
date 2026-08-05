/**
 * Unit tests for the layered per-path review rules (TRDD-3JQVBO7M).
 * Pure parts (glob, matching, composition) test without fs; layer resolution
 * tests against a tmpdir. Load-bearing negatives: an EXPLICIT rules path that
 * doesn't parse must THROW (the caller named that exact file), while a broken
 * project/user layer silently degrades to "no rules".
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  composeRuleInstructions,
  globToRegExp,
  matchRuleForFile,
  resolveRulesLayers,
  ruleGlobMatches,
} from "./review-rules.js";

describe("globToRegExp — the documented subset", () => {
  it("*, **, ?, {a,b}, [abc], case-insensitive", () => {
    expect(globToRegExp("*.ts").test("a.ts")).toBe(true);
    expect(globToRegExp("*.ts").test("dir/a.ts")).toBe(false); // * stops at /
    expect(globToRegExp("**/*.ts").test("deep/nested/a.ts")).toBe(true);
    expect(globToRegExp("**/*.ts").test("a.ts")).toBe(true); // **/ = zero or more segments
    expect(globToRegExp("a?.ts").test("ab.ts")).toBe(true);
    expect(globToRegExp("*.{ts,tsx}").test("x.tsx")).toBe(true);
    expect(globToRegExp("*.{ts,tsx}").test("x.js")).toBe(false);
    expect(globToRegExp("[ab].ts").test("b.ts")).toBe(true);
    expect(globToRegExp("SRC/*.TS").test("src/a.ts")).toBe(true); // case-insensitive
  });
});

describe("ruleGlobMatches — repo-relative patterns match absolute paths", () => {
  it("matches against every segment suffix, so callers need not know the root", () => {
    expect(ruleGlobMatches("src/**/*.ts", "/home/u/repo/src/deep/a.ts")).toBe(true);
    expect(ruleGlobMatches("src/**/*.ts", "/home/u/repo/other/a.ts")).toBe(false);
    expect(ruleGlobMatches("**/*.py", "C:\\repo\\pkg\\m.py")).toBe(true); // windows separators normalized
  });
});

describe("matchRuleForFile — first match in declaration order wins", () => {
  const entries = [
    { path: "**/*.test.ts", rule: "TEST RULE" },
    { path: "**/*.ts", rule: "TS RULE" },
  ];
  it("declaration order, not specificity, decides", () => {
    expect(matchRuleForFile("/r/a.test.ts", entries)?.rule).toBe("TEST RULE");
    expect(matchRuleForFile("/r/a.ts", entries)?.rule).toBe("TS RULE");
    expect(matchRuleForFile("/r/a.py", entries)).toBeNull();
  });
});

describe("resolveRulesLayers — precedence with silent skip, loud explicit", () => {
  it("project layer beats user layer; both are optional", () => {
    const tmp = mkdtempSync(join("/tmp", "llm-ext-rules-"));
    const repo = join(tmp, "repo");
    const cfg = join(tmp, "cfg");
    mkdirSync(join(repo, ".llm-ext"), { recursive: true });
    mkdirSync(cfg, { recursive: true });
    writeFileSync(
      join(repo, ".llm-ext", "rules.yaml"),
      'rules:\n  - path: "**/*.ts"\n    rule: "PROJECT"\n',
    );
    writeFileSync(
      join(cfg, "rules.yaml"),
      'rules:\n  - path: "**/*.ts"\n    rule: "USER"\n',
    );
    const r = resolveRulesLayers({ projectRoot: repo, configDir: cfg });
    expect(r?.layer).toBe("project");
    expect(r?.entries[0].rule).toBe("PROJECT");
    // Remove the project layer → the user layer wins.
    const r2 = resolveRulesLayers({ projectRoot: join(tmp, "elsewhere"), configDir: cfg });
    expect(r2?.layer).toBe("user");
    // No layer at all → null, tools unchanged (Auto-DUBC zero-config default).
    expect(
      resolveRulesLayers({ projectRoot: join(tmp, "nope"), configDir: join(tmp, "nope2") }),
    ).toBeNull();
  });

  it("an EXPLICIT rules path that is missing/unparseable THROWS — the caller named that file", () => {
    expect(() => resolveRulesLayers({ explicitPath: "/definitely/missing.yaml" })).toThrow(
      /not usable/,
    );
  });

  it("a malformed PROJECT layer degrades silently to the next layer, never crashes", () => {
    const tmp = mkdtempSync(join("/tmp", "llm-ext-rules-bad-"));
    mkdirSync(join(tmp, ".llm-ext"), { recursive: true });
    writeFileSync(join(tmp, ".llm-ext", "rules.yaml"), "rules: 'not-a-list'\n");
    expect(
      resolveRulesLayers({ projectRoot: tmp, configDir: join(tmp, "nocfg") }),
    ).toBeNull();
  });
});

describe("composeRuleInstructions — augments, never replaces", () => {
  const resolved = {
    layer: "project",
    file: "/r/.llm-ext/rules.yaml",
    entries: [
      { path: "**/*.ts", rule: "FAIL-FAST: never report missing error handling." },
      { path: "**/*.py", rule: "PEP8 exempt." },
    ],
  };
  it("base instructions survive verbatim; only rules matching the FILES are appended, once each", () => {
    const out = composeRuleInstructions("find real bugs", ["/r/a.ts", "/r/b.ts"], resolved);
    expect(out.startsWith("find real bugs")).toBe(true);
    expect(out).toContain("FAIL-FAST: never report missing error handling.");
    expect(out).not.toContain("PEP8"); // no .py file in the set
    expect(out.match(/FAIL-FAST/g)?.length).toBe(1); // grouped, not per file
  });
  it("no resolved rules, or no matching entries → instructions untouched", () => {
    expect(composeRuleInstructions("base", ["/r/a.ts"], null)).toBe("base");
    expect(composeRuleInstructions("base", ["/r/a.go"], resolved)).toBe("base");
  });
});
