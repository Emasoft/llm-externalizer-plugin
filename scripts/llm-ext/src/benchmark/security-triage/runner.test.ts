// Hermetic tests for the security-triage benchmark runner's PURE transform
// `casesToGroups` (TRDD-973a0265 §3.3). NO network, NO module mocking — the unit
// is a synchronous cases→groups map. We construct realistic in-memory
// SecurityTriageCase objects (matching the dataset.ts type) and assert the REAL
// DedupGroup output (shape from security_scan/intake.ts). The networked
// `runTriageBenchmarkOnModel` is intentionally NOT exercised here (it drives the
// real judge over fetchImpl — out of scope for a pure-transform test).

import { describe, it, expect } from "vitest";

import { casesToGroups } from "./runner.js";
import type { SecurityTriageCase } from "./dataset.js";
import type { DedupGroup } from "../../security_scan/intake.js";

/**
 * Build a realistic golden case. Defaults mirror a curated dataset row so each
 * test starts from a complete, plausible SecurityTriageCase and overrides only
 * the fields it cares about. `expected`/`acceptable`/`critical` are required by
 * the type but are NOT read by casesToGroups — included for realism only.
 */
function makeCase(over: Partial<SecurityTriageCase> & Pick<SecurityTriageCase, "id">): SecurityTriageCase {
  return {
    category: "path_traversal",
    language: "python",
    snippet: "open(os.path.join(BASE, request.args['name']))",
    expected: "threat",
    acceptable: ["threat"],
    critical: false,
    rationale: "user-controlled path component flows into a file open",
    source: "unit-test-fixture",
    ...over,
  };
}

describe("casesToGroups — pure cases→DedupGroup transform", () => {
  it("returns an empty array for empty input", () => {
    expect(casesToGroups([])).toEqual([]);
  });

  it("maps a single case to exactly one group with the case id as key and snippet as content", () => {
    const c = makeCase({
      id: "pt-001",
      category: "path_traversal",
      language: "go",
      snippet: 'os.Open(filepath.Join(root, r.URL.Query().Get("p")))',
    });

    const groups = casesToGroups([c]);

    expect(groups).toHaveLength(1);
    const g = groups[0];
    // The case id IS the group key (loader guarantees unique ids → unambiguous
    // verdict mapping), and category/language/content are copied verbatim from
    // the case (content := snippet).
    expect(g.key).toBe("pt-001");
    expect(g.category).toBe("path_traversal");
    expect(g.language).toBe("go");
    expect(g.content).toBe('os.Open(filepath.Join(root, r.URL.Query().Get("p")))');
    // One group → exactly one self-member mirroring id/category/language/content.
    expect(g.members).toHaveLength(1);
    const m = g.members[0];
    expect(m.id).toBe("pt-001");
    expect(m.category).toBe("path_traversal");
    expect(m.language).toBe("go");
    expect(m.content).toBe('os.Open(filepath.Join(root, r.URL.Query().Get("p")))');
  });

  it("maps N distinct cases to N groups, preserving 1:1 order and key→content mapping", () => {
    const cases: SecurityTriageCase[] = [
      makeCase({ id: "a", category: "ssrf", language: "python", snippet: "requests.get(user_url)" }),
      makeCase({ id: "b", category: "sql_injection", language: "javascript", snippet: 'db.query("SELECT * FROM t WHERE x=" + req.body.x)' }),
      makeCase({ id: "c", category: "insecure_crypto", language: "ruby", snippet: "Digest::MD5.hexdigest(password)" }),
    ];

    const groups = casesToGroups(cases);

    // One group per case, in the same order as the input.
    expect(groups).toHaveLength(3);
    expect(groups.map((g) => g.key)).toEqual(["a", "b", "c"]);
    expect(groups.map((g) => g.category)).toEqual(["ssrf", "sql_injection", "insecure_crypto"]);
    expect(groups.map((g) => g.language)).toEqual(["python", "javascript", "ruby"]);
    expect(groups.map((g) => g.content)).toEqual([
      "requests.get(user_url)",
      'db.query("SELECT * FROM t WHERE x=" + req.body.x)',
      "Digest::MD5.hexdigest(password)",
    ]);
    // Each group carries exactly one member whose id echoes the group key.
    for (const g of groups) {
      expect(g.members).toHaveLength(1);
      expect(g.members[0].id).toBe(g.key);
      expect(g.members[0].content).toBe(g.content);
      expect(g.members[0].category).toBe(g.category);
    }
  });

  it("produces a DedupGroup shaped exactly as a SecurityTriageCase implies — no extra fields, file_path/line left undefined", () => {
    const c = makeCase({
      id: "shape-1",
      category: "command_injection",
      language: "bash",
      snippet: 'eval "$user_input"',
    });

    const [g] = casesToGroups([c]);

    // casesToGroups sets ONLY key/category/language/content/members — it never
    // derives file_path or line (those are file/glob-shape concepts in intake;
    // a benchmark snippet has no on-disk origin), so they stay undefined.
    expect(g.file_path).toBeUndefined();
    expect(g.line).toBeUndefined();
    // The group's own keys are exactly the five the transform writes.
    expect(Object.keys(g).sort()).toEqual(["category", "content", "key", "language", "members"]);
    // The single member is shaped from the same case fields, also without
    // file_path/line, and carries no leaked SecurityTriageCase-only fields
    // (expected/acceptable/critical/rationale/source).
    const m = g.members[0];
    expect(m.file_path).toBeUndefined();
    expect(m.line).toBeUndefined();
    expect(Object.keys(m).sort()).toEqual(["category", "content", "id", "language"]);
    // Assert against the constructed reference DedupGroup so the FULL real shape
    // (not just spot fields) must match.
    const expectedGroup: DedupGroup = {
      key: "shape-1",
      category: "command_injection",
      language: "bash",
      content: 'eval "$user_input"',
      members: [
        {
          id: "shape-1",
          category: "command_injection",
          language: "bash",
          content: 'eval "$user_input"',
        },
      ],
    };
    expect(g).toEqual(expectedGroup);
  });

  it("copies a missing language as undefined (not coerced) onto both group and member", () => {
    // A case with no `language` is valid (dataset.ts: language?: string). The
    // transform must propagate the absence faithfully rather than inventing a
    // default — the judge later places language only when known.
    const c = makeCase({ id: "no-lang", category: "open_redirect", snippet: 'res.redirect(req.query.next)' });
    delete (c as { language?: string }).language;

    const [g] = casesToGroups([c]);

    expect("language" in g).toBe(true); // the key exists (object literal sets it)
    expect(g.language).toBeUndefined();
    expect(g.members[0].language).toBeUndefined();
    // Everything else still maps correctly.
    expect(g.key).toBe("no-lang");
    expect(g.category).toBe("open_redirect");
    expect(g.content).toBe("res.redirect(req.query.next)");
  });
});
