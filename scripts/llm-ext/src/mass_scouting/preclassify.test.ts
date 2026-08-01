/**
 * Unit tests for the mass-scouting preclassifier.
 *
 * Covers:
 *   • classifyFile (pure) — every bucket: binary, rules_to_eval,
 *     has_frontmatter, documentation, sourcecode (multiple langs), config,
 *     log_to_classify, unknown
 *   • detect_yaml_frontmatter — only triggers on markdown, requires both
 *     opening AND closing `---` lines
 *   • RULES_BASENAMES + path-based rules detection (`/rules/` segment)
 *   • Binary detection — null byte anywhere in the first 8 KB
 *   • preclassifyAll — full registry walk: reads cached bodies, writes back
 *     bucket / format / language fields, respects the reclassify flag,
 *     reports missing-body rows, returns accurate counts
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { classifyFile, preclassifyAll, HEAD_SAMPLE_BYTES } from "./preclassify";
import { openRegistry, Registry } from "./registry";

// ── classifyFile ───────────────────────────────────────────────────────

describe("classifyFile — buckets", () => {
  it("flags null-byte content as binary", () => {
    /** Cheap shield against accidentally feeding a PNG/JPG to the LLM. */
    const head = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    expect(classifyFile("/tmp/icon.png", head)).toEqual({
      classifier_bucket: "binary",
      has_yaml_frontmatter: 0,
      detected_language: null,
      detected_format: "binary",
    });
  });

  it("flags CLAUDE.md as rules_to_eval (skip-LLM bucket)", () => {
    /** Per-file basename rule keeps governance docs out of the scout. */
    expect(
      classifyFile("/work/CLAUDE.md", Buffer.from("# rules\n")),
    ).toEqual({
      classifier_bucket: "rules_to_eval",
      has_yaml_frontmatter: 0,
      detected_language: null,
      detected_format: "markdown",
    });
  });

  it("flags AGENTS.md the same way", () => {
    /** Same logic, different basename. */
    expect(classifyFile("/x/AGENTS.md", Buffer.from("hi")).classifier_bucket).toBe(
      "rules_to_eval",
    );
  });

  it("flags any file under a /rules/ folder", () => {
    /** Path-based rule catches per-project rule libraries. */
    expect(
      classifyFile("/proj/rules/style.md", Buffer.from("# style\n"))
        .classifier_bucket,
    ).toBe("rules_to_eval");
  });

  it("flags markdown with leading `---` frontmatter as has_frontmatter", () => {
    /** Frontmatter files often carry the description we'd otherwise generate. */
    const head = Buffer.from(
      "---\nname: thing\ndescription: a test\n---\n\n# body\n",
    );
    expect(classifyFile("/x/skill.md", head)).toEqual({
      classifier_bucket: "has_frontmatter",
      has_yaml_frontmatter: 1,
      detected_language: null,
      detected_format: "markdown",
    });
  });

  it("does NOT detect frontmatter without a closing `---`", () => {
    /** Bare opening line is not a frontmatter block. */
    const head = Buffer.from("---\nname: thing\n# body without close\n");
    expect(classifyFile("/x/note.md", head).classifier_bucket).toBe(
      "documentation",
    );
  });

  it("does NOT detect frontmatter on non-markdown extensions", () => {
    /** A `.ts` file starting with `---` is not frontmatter. */
    const head = Buffer.from("---\nfoo: bar\n---\nconst x = 1;\n");
    expect(classifyFile("/x/foo.ts", head).has_yaml_frontmatter).toBe(0);
  });

  it("flags markdown without frontmatter as documentation", () => {
    /** Plain `.md` without YAML — readme-style docs. */
    expect(
      classifyFile("/x/readme.md", Buffer.from("# Readme\nHello.\n")),
    ).toEqual({
      classifier_bucket: "documentation",
      has_yaml_frontmatter: 0,
      detected_language: null,
      detected_format: "markdown",
    });
  });

  it("classifies TypeScript files with language hint", () => {
    /** Source code goes into a single bucket; language is the secondary index. */
    const out = classifyFile(
      "/x/main.ts",
      Buffer.from("export const x = 1;\n"),
    );
    expect(out.classifier_bucket).toBe("sourcecode");
    expect(out.detected_language).toBe("typescript");
    expect(out.detected_format).toBe("sourcecode");
  });

  it("classifies JS / Python / Rust / Go variants", () => {
    /** Spread coverage across major languages. */
    const cases: [string, string][] = [
      ["/x/script.js", "javascript"],
      ["/x/util.mjs", "javascript"],
      ["/x/main.py", "python"],
      ["/x/lib.rs", "rust"],
      ["/x/main.go", "go"],
      ["/x/sample.cpp", "cpp"],
      ["/x/run.sh", "bash"],
    ];
    for (const [path, lang] of cases) {
      const out = classifyFile(path, Buffer.from("noop"));
      expect(out.classifier_bucket).toBe("sourcecode");
      expect(out.detected_language).toBe(lang);
    }
  });

  it("classifies JSON / YAML / TOML as config", () => {
    /** Config files share a bucket — the scout can treat them similarly. */
    expect(classifyFile("/x/c.json", Buffer.from("{}")).classifier_bucket).toBe(
      "config",
    );
    expect(classifyFile("/x/c.yaml", Buffer.from("a: 1")).classifier_bucket).toBe(
      "config",
    );
    expect(classifyFile("/x/c.toml", Buffer.from("a=1")).classifier_bucket).toBe(
      "config",
    );
    expect(classifyFile("/x/.env", Buffer.from("X=1")).classifier_bucket).toBe(
      "config",
    );
  });

  it("classifies *.log as log_to_classify", () => {
    /** Logs get their own bucket so a severity-classifier scout can target them. */
    expect(
      classifyFile("/var/log/app.log", Buffer.from("INFO start\n"))
        .classifier_bucket,
    ).toBe("log_to_classify");
  });

  it("falls through to unknown for unrecognised extensions", () => {
    /** Anything we can't classify is left for the LLM to inspect. */
    expect(
      classifyFile("/x/file.xyzzy", Buffer.from("hello")).classifier_bucket,
    ).toBe("unknown");
  });

  it("strips a UTF-8 BOM before frontmatter detection", () => {
    /** GitHub-saved markdown often has a BOM — must not break detection. */
    const bomBytes = Buffer.from([0xef, 0xbb, 0xbf]);
    const head = Buffer.concat([
      bomBytes,
      Buffer.from("---\nname: x\n---\n\n# body\n"),
    ]);
    expect(classifyFile("/x/skill.md", head).has_yaml_frontmatter).toBe(1);
  });
});

// ── HEAD_SAMPLE_BYTES sanity ───────────────────────────────────────────

describe("HEAD_SAMPLE_BYTES", () => {
  it("is large enough for typical frontmatter blocks", () => {
    /** 4 KB is the documented sample budget. */
    expect(HEAD_SAMPLE_BYTES).toBeGreaterThanOrEqual(4_096);
  });
});

// ── preclassifyAll ─────────────────────────────────────────────────────

describe("preclassifyAll", () => {
  let reg: Registry;

  beforeEach(() => {
    reg = openRegistry({ path: ":memory:" });
  });

  afterEach(() => {
    reg.close();
  });

  it("classifies every unclassified row and writes back to the registry", () => {
    /** End-to-end sanity: feed three files, check buckets are persisted. */
    reg.registerFile({
      file_path: "/x/main.ts",
      source_root: "/x",
      body: Buffer.from("export const x = 1;\n"),
      registered_via: "folder",
    });
    reg.registerFile({
      file_path: "/x/readme.md",
      source_root: "/x",
      body: Buffer.from("# readme\n"),
      registered_via: "folder",
    });
    reg.registerFile({
      file_path: "/x/CLAUDE.md",
      source_root: "/x",
      body: Buffer.from("rules\n"),
      registered_via: "folder",
    });

    const out = preclassifyAll(reg);
    expect(out.total).toBe(3);
    expect(out.classified).toBe(3);
    expect(out.by_bucket).toEqual({
      sourcecode: 1,
      documentation: 1,
      rules_to_eval: 1,
    });

    const ts = reg.getByPath("/x/main.ts")!;
    expect(ts.classifier_bucket).toBe("sourcecode");
    expect(ts.detected_language).toBe("typescript");
  });

  it("skips already-classified rows by default", () => {
    /** Repeat preclassify is idempotent and cheap. */
    reg.registerFile({
      file_path: "/x/main.ts",
      source_root: "/x",
      body: Buffer.from("x"),
      registered_via: "folder",
    });
    preclassifyAll(reg);
    const second = preclassifyAll(reg);
    expect(second.skipped_already).toBe(1);
    expect(second.classified).toBe(0);
  });

  it("re-classifies when reclassify:true is passed", () => {
    /** Lets the user replay after fixing a custom classifier rule. */
    reg.registerFile({
      file_path: "/x/main.ts",
      source_root: "/x",
      body: Buffer.from("x"),
      registered_via: "folder",
    });
    preclassifyAll(reg);
    const second = preclassifyAll(reg, { reclassify: true });
    expect(second.classified).toBe(1);
    expect(second.skipped_already).toBe(0);
  });

  it("counts rows whose body cache was evicted as no_body and leaves them alone", () => {
    /** Body eviction happens in long-lived registries; preclassify must survive. */
    const out = reg.registerFile({
      file_path: "/x/x",
      source_root: "/x",
      body: Buffer.from("x"),
      registered_via: "folder",
    });
    reg.deleteBody(out.fingerprint);
    const result = preclassifyAll(reg);
    expect(result.no_body).toBe(1);
    expect(result.classified).toBe(0);
    // Bucket should remain at the default "unknown".
    expect(reg.getByFingerprint(out.fingerprint)!.classifier_bucket).toBe(
      "unknown",
    );
  });
});
