/**
 * Cheap, script-only file classifier — pre-routes files into buckets so the
 * scout phase doesn't waste LLM calls on things a regex can decide.
 *
 * Pure function `classifyFile(path, head)` for unit-testability, plus a
 * registry-bound runner `preclassifyAll(reg)` that walks unclassified rows
 * and writes the result back.
 *
 * Buckets (kept coarse — scout decides what to do per bucket):
 *   • binary             — null bytes in head; never sent to LLM
 *   • rules_to_eval      — CLAUDE.md / AGENTS.md / .cursorrules / any path
 *                          containing a `/rules/` segment
 *   • has_frontmatter    — markdown with leading `---` block
 *   • documentation      — markdown without frontmatter
 *   • sourcecode         — recognised programming-language extension
 *   • config             — json / yaml / toml / ini
 *   • log_to_classify    — *.log / *.out
 *   • unknown            — fallthrough; scout sees these too
 */

import { basename, extname } from "node:path";
import type { ClassifierFields, Registry, RegistryRow } from "./registry";

/** Inspect this many bytes of the file head when classifying. */
export const HEAD_SAMPLE_BYTES = 8_192;

const BINARY_NULL_PROBE_BYTES = 8_192;

const RULES_BASENAMES = new Set([
  "CLAUDE.md",
  "AGENTS.md",
  ".cursorrules",
  ".cursor.rules",
  ".windsurfrules",
]);

interface ExtMeta {
  format: string;
  language?: string;
  bucketHint?: string;
}

const EXT_MAP: Record<string, ExtMeta> = {
  // Markdown family
  ".md": { format: "markdown", bucketHint: "documentation" },
  ".markdown": { format: "markdown", bucketHint: "documentation" },
  ".mdx": { format: "markdown", bucketHint: "documentation" },
  ".rst": { format: "rst", bucketHint: "documentation" },
  ".txt": { format: "text", bucketHint: "documentation" },

  // Configs
  ".json": { format: "json", bucketHint: "config" },
  ".jsonc": { format: "json", bucketHint: "config" },
  ".json5": { format: "json", bucketHint: "config" },
  ".yaml": { format: "yaml", bucketHint: "config" },
  ".yml": { format: "yaml", bucketHint: "config" },
  ".toml": { format: "toml", bucketHint: "config" },
  ".ini": { format: "ini", bucketHint: "config" },
  ".cfg": { format: "ini", bucketHint: "config" },
  ".conf": { format: "ini", bucketHint: "config" },
  ".env": { format: "ini", bucketHint: "config" },

  // Logs
  ".log": { format: "log", bucketHint: "log_to_classify" },
  ".out": { format: "log", bucketHint: "log_to_classify" },

  // TypeScript / JavaScript
  ".ts": { format: "sourcecode", language: "typescript", bucketHint: "sourcecode" },
  ".tsx": { format: "sourcecode", language: "typescript", bucketHint: "sourcecode" },
  ".js": { format: "sourcecode", language: "javascript", bucketHint: "sourcecode" },
  ".jsx": { format: "sourcecode", language: "javascript", bucketHint: "sourcecode" },
  ".mjs": { format: "sourcecode", language: "javascript", bucketHint: "sourcecode" },
  ".cjs": { format: "sourcecode", language: "javascript", bucketHint: "sourcecode" },

  // Python
  ".py": { format: "sourcecode", language: "python", bucketHint: "sourcecode" },
  ".pyi": { format: "sourcecode", language: "python", bucketHint: "sourcecode" },

  // Other languages
  ".go": { format: "sourcecode", language: "go", bucketHint: "sourcecode" },
  ".rs": { format: "sourcecode", language: "rust", bucketHint: "sourcecode" },
  ".c": { format: "sourcecode", language: "c", bucketHint: "sourcecode" },
  ".h": { format: "sourcecode", language: "c", bucketHint: "sourcecode" },
  ".cpp": { format: "sourcecode", language: "cpp", bucketHint: "sourcecode" },
  ".cc": { format: "sourcecode", language: "cpp", bucketHint: "sourcecode" },
  ".hpp": { format: "sourcecode", language: "cpp", bucketHint: "sourcecode" },
  ".java": { format: "sourcecode", language: "java", bucketHint: "sourcecode" },
  ".kt": { format: "sourcecode", language: "kotlin", bucketHint: "sourcecode" },
  ".rb": { format: "sourcecode", language: "ruby", bucketHint: "sourcecode" },
  ".php": { format: "sourcecode", language: "php", bucketHint: "sourcecode" },
  ".swift": { format: "sourcecode", language: "swift", bucketHint: "sourcecode" },
  ".sh": { format: "sourcecode", language: "bash", bucketHint: "sourcecode" },
  ".bash": { format: "sourcecode", language: "bash", bucketHint: "sourcecode" },
  ".zsh": { format: "sourcecode", language: "zsh", bucketHint: "sourcecode" },
  ".fish": { format: "sourcecode", language: "fish", bucketHint: "sourcecode" },
  ".sql": { format: "sourcecode", language: "sql", bucketHint: "sourcecode" },
  ".lua": { format: "sourcecode", language: "lua", bucketHint: "sourcecode" },
  ".dart": { format: "sourcecode", language: "dart", bucketHint: "sourcecode" },
  ".scala": { format: "sourcecode", language: "scala", bucketHint: "sourcecode" },
  ".cs": { format: "sourcecode", language: "csharp", bucketHint: "sourcecode" },
};

// ── Helpers ────────────────────────────────────────────────────────────

/** Detects YAML frontmatter: leading `---\n…\n---` block, *only* in markdown. */
function detectYamlFrontmatter(head: Buffer, format: string): 0 | 1 {
  if (format !== "markdown") return 0;
  // Convert to UTF-8 string. If it starts with a BOM, strip it.
  let s = head.toString("utf-8", 0, Math.min(head.length, HEAD_SAMPLE_BYTES));
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  if (!s.startsWith("---\n") && !s.startsWith("---\r\n")) return 0;
  // Look for the closing `---` on its own line within the first 200 lines.
  const lines = s.split(/\r?\n/);
  for (let i = 1; i < Math.min(lines.length, 200); i++) {
    if (lines[i] === "---") return 1;
  }
  return 0;
}

/** Null bytes in the first 8 KB → binary-ish. Cheap, conservative. */
function isBinary(head: Buffer): boolean {
  const probe = head.subarray(0, Math.min(head.length, BINARY_NULL_PROBE_BYTES));
  for (const b of probe) {
    if (b === 0) return true;
  }
  return false;
}

function isRulesFile(path: string): boolean {
  const bn = basename(path);
  if (RULES_BASENAMES.has(bn)) return true;
  // Path contains a `/rules/` (or `\rules\`) segment
  return /[/\\]rules[/\\]/.test(path);
}

// ── Public: pure classifier ────────────────────────────────────────────

/**
 * Classify one file from its path and a head sample. Pure: no I/O, no Registry
 * coupling — easy to unit-test and reuse in the scout phase for a re-check.
 */
export function classifyFile(path: string, head: Buffer): ClassifierFields {
  if (isBinary(head)) {
    return {
      classifier_bucket: "binary",
      has_yaml_frontmatter: 0,
      detected_language: null,
      detected_format: "binary",
    };
  }

  if (isRulesFile(path)) {
    // Rules files often ARE markdown; we still mark frontmatter for downstream.
    const fm = detectYamlFrontmatter(head, "markdown");
    return {
      classifier_bucket: "rules_to_eval",
      has_yaml_frontmatter: fm,
      detected_language: null,
      detected_format: "markdown",
    };
  }

  // Dotfile basenames don't have an extname per Node's convention. Match the
  // common config dotfiles by basename so they don't fall through to "unknown".
  const bn = basename(path).toLowerCase();
  let meta: ExtMeta | undefined;
  if (bn === ".env" || bn.startsWith(".env.")) {
    meta = { format: "ini", bucketHint: "config" };
  } else {
    const ext = extname(path).toLowerCase();
    meta = EXT_MAP[ext];
  }
  if (!meta) {
    return {
      classifier_bucket: "unknown",
      has_yaml_frontmatter: 0,
      detected_language: null,
      detected_format: null,
    };
  }

  const fm = detectYamlFrontmatter(head, meta.format);
  let bucket = meta.bucketHint ?? "unknown";
  if (meta.format === "markdown" && fm === 1) {
    bucket = "has_frontmatter";
  }
  return {
    classifier_bucket: bucket,
    has_yaml_frontmatter: fm,
    detected_language: meta.language ?? null,
    detected_format: meta.format,
  };
}

// ── Public: registry-bound runner ──────────────────────────────────────

export interface PreclassifyOptions {
  /** When true, re-classify rows whose bucket is already non-default. Default: false. */
  reclassify?: boolean;
  /** Cap the number of rows processed (useful for incremental runs). */
  limit?: number;
}

export interface PreclassifyResult {
  total: number;
  classified: number;
  skipped_already: number;
  by_bucket: Record<string, number>;
  no_body: number;
}

/**
 * Walk the registry and update each file's classifier fields. Reads the body
 * from the cache only — never re-opens the file from disk (Q2 directive).
 * Files without a cached body are reported in `no_body` and left alone.
 */
export function preclassifyAll(
  reg: Registry,
  opts: PreclassifyOptions = {},
): PreclassifyResult {
  const rows = reg.listEligible({ limit: opts.limit });
  const out: PreclassifyResult = {
    total: rows.length,
    classified: 0,
    skipped_already: 0,
    by_bucket: {},
    no_body: 0,
  };
  for (const row of rows) {
    if (!opts.reclassify && row.classifier_bucket !== "unknown") {
      out.skipped_already++;
      continue;
    }
    const body = reg.readBody(row.fingerprint);
    if (!body) {
      out.no_body++;
      continue;
    }
    const head = body.subarray(0, Math.min(body.length, HEAD_SAMPLE_BYTES));
    const fields = classifyFile(row.file_path, head);
    reg.updateClassification(row.fingerprint, fields);
    out.classified++;
    out.by_bucket[fields.classifier_bucket] =
      (out.by_bucket[fields.classifier_bucket] ?? 0) + 1;
  }
  return out;
}

export type { RegistryRow };
