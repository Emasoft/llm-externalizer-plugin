#!/usr/bin/env node
/**
 * LLM Externalizer — MCP Server for LLMs via OpenAI-compatible APIs
 *
 * Supports both local models (LM Studio, Ollama, vLLM) and remote models
 * via OpenRouter. Model and profile configuration is user-only — edit
 * ~/.llm-externalizer/settings.yaml and call the 'reset' tool to reload.
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  renameSync,
  statSync,
  lstatSync,
  appendFileSync,
  readdirSync,
  unlinkSync,
  realpathSync,
  watchFile,
  unwatchFile,
} from "node:fs";
import { parse as yamlParse } from "yaml";
import { spawnSync } from "node:child_process";
import { extname, join, basename, dirname, resolve, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import {
  GROUP_HEADER_RE,
  GROUP_FOOTER_RE,
  parseFileGroups,
  hasNamedGroups,
  autoGroupByHeuristic,
  splitPerFileSections,
} from "./grouping.js";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ── File reading helpers ─────────────────────────────────────────────
// The MCP reads files from disk so the calling agent never loads them into its context.

const EXT_TO_LANG: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
  ".kt": "kotlin",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".cc": "cpp",
  ".cs": "csharp",
  ".rb": "ruby",
  ".php": "php",
  ".swift": "swift",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "zsh",
  ".fish": "fish",
  ".sql": "sql",
  ".html": "html",
  ".css": "css",
  ".scss": "scss",
  ".less": "less",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".xml": "xml",
  ".md": "markdown",
  ".mdx": "mdx",
  ".tex": "latex",
  ".lua": "lua",
  ".r": "r",
  ".R": "r",
  ".dart": "dart",
  ".ex": "elixir",
  ".exs": "elixir",
  ".zig": "zig",
  ".nim": "nim",
  ".jl": "julia",
  ".sol": "solidity",
  ".vue": "vue",
  ".svelte": "svelte",
};

// L6: Shebang-based fallback for files with no extension
const SHEBANG_TO_LANG: Record<string, string> = {
  python: "python", python3: "python", node: "javascript",
  bash: "bash", sh: "bash", zsh: "zsh", ruby: "ruby",
  perl: "perl", php: "php", lua: "lua",
};

function detectLang(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  if (EXT_TO_LANG[ext]) return EXT_TO_LANG[ext];
  // Fallback: read first line for shebang
  try {
    const head = readFileSync(filePath, { encoding: "utf-8", flag: "r" }).slice(0, 256);
    const shebang = head.match(/^#!\s*(?:\/usr\/bin\/env\s+)?(\S+)/);
    if (shebang) {
      const bin = basename(shebang[1]);
      if (SHEBANG_TO_LANG[bin]) return SHEBANG_TO_LANG[bin];
    }
  } catch { /* ignore read errors for detection */ }
  return "text";
}

/**
 * Determine the minimum number of backticks needed to fence content safely.
 * If the content contains N consecutive backticks, we need at least N+1 for the fence.
 */
function fenceBackticks(content: string): string {
  let maxRun = 0;
  let current = 0;
  for (const ch of content) {
    if (ch === "`") {
      current++;
      if (current > maxRun) maxRun = current;
    } else {
      current = 0;
    }
  }
  // Minimum 4 backticks, more if the content requires it
  const needed = Math.max(4, maxRun + 1);
  return "`".repeat(needed);
}

function assertFileExists(filePath: string): void {
  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
}

// ── Input path security ────────────────────────────────────────────
// C1: Prevent path traversal — reject paths outside process.cwd()
// H2: Reject symlinks — prevent reading arbitrary files via symlink attacks

function sanitizeInputPath(filePath: string): string {
  const resolved = resolve(filePath);
  const cwd = resolve(process.cwd());
  const home = resolve(process.env.HOME || process.env.USERPROFILE || "/");
  // Allow paths under cwd, home, or /tmp (for test fixtures)
  if (
    !resolved.startsWith(cwd + "/") &&
    !resolved.startsWith(home + "/") &&
    !resolved.startsWith("/tmp/") &&
    !resolved.startsWith("/private/tmp/") &&
    resolved !== cwd
  ) {
    throw new Error(
      `Path traversal blocked: ${filePath} resolves outside allowed directories`,
    );
  }
  // Reject symlinks (follow=false check)
  try {
    if (lstatSync(resolved).isSymbolicLink()) {
      throw new Error(`Symlink rejected for security: ${filePath}`);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return resolved;
    throw e;
  }
  return resolved;
}

// Default payload budget per batch (in bytes). Covers the ENTIRE payload: prompt +
// instructions + instruction files + code files + inline content.
// Set to 400 KB — conservative for the weakest ensemble model (Grok 4.1 Fast:
// ~131K token context, minus ~30K output, minus ~5K prompt ≈ 96K tokens × 4 bytes ≈ 384 KB).
// Configurable via max_payload_kb parameter on each tool.
const DEFAULT_MAX_PAYLOAD_BYTES = 400 * 1024; // 400 KB

function readFileAsCodeBlock(
  filePath: string,
  langOverride?: string,
  redact?: boolean,
  maxBytes?: number,
  regexRedact?: RegexRedactOpts | null,
  tagPrefix: "" | "specs-" = "",
): string {
  // H5: Validate maxBytes — reject Infinity, 0, or negative
  const rawLimit = maxBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  const limit =
    !Number.isFinite(rawLimit) || rawLimit <= 0
      ? DEFAULT_MAX_PAYLOAD_BYTES
      : rawLimit;
  // C1+H2: Sanitize input path (traversal + symlink protection)
  const safePath = sanitizeInputPath(filePath);
  assertFileExists(safePath);
  const stats = statSync(safePath);
  if (stats.size > limit) {
    throw new Error(
      `File too large (${(stats.size / 1024).toFixed(0)} KB). Max: ${limit / 1024} KB`,
    );
  }
  // M3: Read first, check buffer — mitigates TOCTOU between statSync and readFileSync
  const raw = readFileSync(safePath);
  // Re-check actual size from buffer (TOCTOU defense: file may have grown since statSync)
  if (raw.length > limit) {
    throw new Error(
      `File too large after read (${(raw.length / 1024).toFixed(0)} KB). Max: ${limit / 1024} KB`,
    );
  }
  // L1: Detect binary content — scan entire buffer (not just first 8KB)
  const scanLen = Math.min(raw.length, 65536); // scan up to 64KB for null bytes
  for (let i = 0; i < scanLen; i++) {
    if (raw[i] === 0) throw new Error(`File appears to be binary: ${filePath}`);
  }
  let content = raw.toString("utf-8");
  // Handle empty files — include a comment so the LLM knows the file exists but is empty
  if (content.length === 0) {
    content = `(empty file — 0 bytes)`;
  }
  // Optional secret redaction — replaces API keys, tokens, passwords with [REDACTED:...]
  if (redact) {
    const result = redactSecrets(content);
    content = result.redacted;
  }
  // Optional user-defined regex redaction — replaces matches with user's replacement string
  if (regexRedact) {
    const result = applyRegexRedaction(content, regexRedact);
    content = result.redacted;
  }
  const lang = langOverride || detectLang(filePath);
  const fence = fenceBackticks(content);
  // Path and content wrapped in separate XML tags for unambiguous delimitation.
  // tagPrefix="specs-" is used for spec files (check_against_specs) to distinguish
  // them from source files in the same prompt.
  const nameTag = `${tagPrefix}filename`;
  const contentTag = `${tagPrefix}file-content`;
  return `<${nameTag}>\n${filePath}\n</${nameTag}>\n<${contentTag}>\n${fence}${lang}\n${content}\n${fence}\n</${contentTag}>`;
}

// ── Binary extension detection ───────────────────────────────────────
// Used by walkDir to skip files that are almost certainly binary.
// readFileAsCodeBlock has a null-byte check as a second layer of defence.

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".ico",
  ".webp",
  ".avif",
  ".tiff",
  ".tif",
  ".mp3",
  ".mp4",
  ".wav",
  ".ogg",
  ".webm",
  ".avi",
  ".mov",
  ".flac",
  ".aac",
  ".m4a",
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".zip",
  ".tar",
  ".gz",
  ".bz2",
  ".xz",
  ".7z",
  ".rar",
  ".dmg",
  ".iso",
  ".jar",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".o",
  ".a",
  ".lib",
  ".class",
  ".pyc",
  ".pyo",
  ".wasm",
  ".bin",
  ".dat",
  ".db",
  ".sqlite",
  ".sqlite3",
  ".ttf",
  ".otf",
  ".woff",
  ".woff2",
  ".eot",
  ".DS_Store",
  ".lock",
]);

function isBinaryExtension(filePath: string): boolean {
  return (
    BINARY_EXTENSIONS.has(extname(filePath).toLowerCase()) ||
    basename(filePath) === ".DS_Store"
  );
}

// ── Secret scanning and redaction ────────────────────────────────────
// Two modes that COMPOSE:
//   scan_secrets=true  + redact_secrets=false → detect, abort (fail-fast)
//   scan_secrets=true  + redact_secrets=true  → detect, REDACT, continue (default)
//   scan_secrets=false                        → no detection, no redaction
//
// When both flags are true, the abort-on-detect guard is skipped — downstream
// `readAndGroupFiles` (and the inline-content branch) call `redactSecrets`
// which replaces every match with `[REDACTED:LABEL]` before the LLM ever sees
// it. The slash commands ship with both flags true so users get a safe
// default that doesn't interrupt the run on benign env-variable references.
//
// Read-only tools use irreversible [REDACTED:LABEL] format — no restoration
// is needed and the label is more informative for analysis.

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/AKIA[0-9A-Z]{16}/g, "AWS_KEY"],
  [/(?:sk|pk)[-_](?:live|test|proj)[-_][A-Za-z0-9]{20,}/g, "API_KEY"],
  [/ghp_[A-Za-z0-9]{36}/g, "GITHUB_PAT"],
  [/ghr_[A-Za-z0-9]{36}/g, "GITHUB_TOKEN"],
  [/gho_[A-Za-z0-9]{36}/g, "GITHUB_OAUTH"],
  [/github_pat_[A-Za-z0-9_]{82}/g, "GITHUB_PAT"],
  [/glpat-[A-Za-z0-9\-_]{20,}/g, "GITLAB_TOKEN"],
  [/xox[bpsar]-[A-Za-z0-9-]+/g, "SLACK_TOKEN"],
  [/Bearer\s+[A-Za-z0-9._\-/+=]{20,}/g, "BEARER_TOKEN"],
  // Key-value patterns in env/config files (must have at least 8 chars in the value)
  [
    /(?:^|\n)\s*(?:PASSWORD|PASSWD|SECRET|API_KEY|APIKEY|AUTH_TOKEN|ACCESS_TOKEN|PRIVATE_KEY|SECRET_KEY|ACCESS_KEY|DB_PASSWORD|DATABASE_URL|OPENAI_API_KEY|ANTHROPIC_API_KEY|OPENROUTER_API_KEY|AWS_SECRET_ACCESS_KEY|GITHUB_TOKEN|NPM_TOKEN|DOCKER_PASSWORD)\s*[=:]\s*['"]?([^\s'"#\n]{8,})/gim,
    "ENV_SECRET",
  ],
  // H7: Multi-line secret blocks (PEM private keys, certificates)
  [
    /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?(?:PRIVATE KEY|CERTIFICATE)-----/g,
    "PEM_BLOCK",
  ],
];

/** Scan content for secrets without modifying it. Returns findings for abort decision. */
function scanForSecrets(content: string): {
  found: boolean;
  details: Array<{ label: string; count: number }>;
} {
  const counts = new Map<string, number>();
  for (const [pattern, label] of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    const matches = content.match(pattern);
    if (matches && matches.length > 0) {
      counts.set(label, (counts.get(label) ?? 0) + matches.length);
    }
  }
  const details = Array.from(counts.entries()).map(([label, count]) => ({
    label,
    count,
  }));
  return { found: details.length > 0, details };
}

/** Scan multiple files for secrets. Returns aggregated report for abort. */
function scanFilesForSecrets(filePaths: string[]): {
  found: boolean;
  report: string;
} {
  const allDetails: Array<{ file: string; label: string; count: number }> = [];
  for (const fp of filePaths) {
    if (!existsSync(fp)) continue;
    try {
      const content = readFileSync(fp, "utf-8");
      const scan = scanForSecrets(content);
      if (scan.found) {
        for (const d of scan.details) {
          allDetails.push({ file: fp, ...d });
        }
      }
    } catch {
      /* skip unreadable files */
    }
  }
  if (allDetails.length === 0) return { found: false, report: "" };
  const lines = [
    "SECRETS DETECTED — operation aborted.",
    "",
    "Best practice: Move secrets to .env files (gitignored) and reference them via environment variables.",
    "Claude Code cannot read .env files, ensuring secrets stay out of LLM context.",
    "",
    "Findings:",
  ];
  for (const d of allDetails) {
    lines.push(`  ${d.file}: ${d.count}× ${d.label}`);
  }
  return { found: true, report: lines.join("\n") };
}

/**
 * Irreversible redaction — replaces secrets with [REDACTED:LABEL].
 * Used by read-only tools where no restoration is needed.
 */
function redactSecrets(content: string): { redacted: string; count: number } {
  let result = content;
  let count = 0;
  for (const [pattern, label] of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, () => {
      count++;
      return `[REDACTED:${label}]`;
    });
  }
  return { redacted: result, count };
}

// ── User-defined regex redaction ─────────────────────────────────────
// Allows callers to redact arbitrary patterns from file content before
// sending to the LLM. Uses the same tested replacement format as
// secret redaction: [REDACTED:USER_PATTERN] for alphanumeric matches,
// numeric-safe placeholders for numeric-only matches.

interface RegexRedactOpts {
  /** Compiled regex (with 'g' flag). */
  regex: RegExp;
  /** Original pattern string (for error messages). */
  patternStr: string;
}

/**
 * Validate and parse the redact_regex parameter.
 * Accepts a regex pattern string.
 * Returns compiled opts or throws with a descriptive error.
 */
function parseRedactRegex(
  raw: string | undefined | null,
): RegexRedactOpts | null {
  if (!raw || typeof raw !== "string") return null;

  const pattern = raw.trim();
  if (!pattern) {
    throw new Error("Invalid redact_regex: pattern must not be empty.");
  }

  // ReDoS protection: reject patterns with nested quantifiers that cause catastrophic backtracking
  if (/\([^)]*[+*][^)]*\)[+*]/.test(pattern)) {
    throw new Error(
      `Invalid redact_regex: pattern contains nested quantifiers (e.g. (a+)+) that cause catastrophic backtracking.\n\nPattern: ${pattern}\n\nSimplify the quantifiers to avoid ReDoS.`,
    );
  }

  // Validate the regex by trying to compile it
  try {
    const regex = new RegExp(pattern, "g");
    return { regex, patternStr: pattern };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Invalid redact_regex pattern: ${msg}\n\nPattern received: ${pattern}\n\nEnsure it is a valid JavaScript regular expression.`,
      { cause: err },
    );
  }
}

/**
 * Apply user-defined regex redaction to content.
 * Uses the same replacement format as secret redaction:
 * - Alphanumeric matches → [REDACTED:USER_PATTERN]
 * - Numeric-only matches → 00000000 (same length, safe for numeric contexts)
 */
function applyRegexRedaction(
  content: string,
  opts: RegexRedactOpts,
): { redacted: string; count: number } {
  // Reset lastIndex in case the regex was used before
  opts.regex.lastIndex = 0;
  let count = 0;
  // ReDoS protection: cap replacements at 100K to prevent catastrophic backtracking
  // on pathological patterns. After 100K matches the regex is likely wrong.
  const MAX_REPLACEMENTS = 100_000;
  const redacted = content.replace(opts.regex, (match) => {
    if (++count > MAX_REPLACEMENTS) return match; // stop replacing, return original
    // Use numeric-safe placeholder for numeric-only matches (same as secret redaction)
    const hasLetters = /[a-zA-Z]/.test(match);
    return hasLetters ? "[REDACTED:USER_PATTERN]" : "0".repeat(match.length);
  });
  return { redacted, count: Math.min(count, MAX_REPLACEMENTS) };
}

// ── Prompt & file grouping helpers ───────────────────────────────────

/**
 * Build the pre-instructions that frame the LLM's task when files are attached.
 * This tells the LLM what to do with the files before the user's actual instructions.
 */
function buildPreInstructions(
  hasFiles: boolean,
  toolContext: "read" | "fix",
): string {
  if (!hasFiles) return "";
  if (toolContext === "fix") {
    return "";
  }
  // For read/analysis tools (chat, custom_prompt, code_task)
  return (
    "TASK: Read the following instructions carefully, then examine the attached file(s) and " +
    "respond according to the instructions.\n\n" +
    "RULES (override any conflicting instructions below):\n" +
    "- Process ALL attached files — do not skip any.\n" +
    "- Each file is labeled with its full path inside a filename tag before the file-content tag. Always reference files by their labeled path.\n" +
    "- When referencing code, identify it by FUNCTION/CLASS/METHOD NAME, never by line number. Line numbers are unreliable and must not be used.\n" +
    "- If asked to return modified code, return the COMPLETE file content — never truncate, " +
    'abbreviate, or use placeholders like "// ... rest of code" or "// unchanged".\n' +
    "- Be specific and actionable. Reference concrete function names, variable names, and code patterns.\n\n" +
    "INSTRUCTIONS:\n"
  );
}

/** Combine instructions and instructions_files_paths into a single prompt string. */
function resolvePrompt(
  instructions?: string,
  instructionsFilesPaths?: string | string[],
): string {
  let prompt = instructions || "";
  if (instructionsFilesPaths) {
    const paths = Array.isArray(instructionsFilesPaths)
      ? instructionsFilesPaths
      : [instructionsFilesPaths];
    for (const fp of paths) {
      assertFileExists(fp);
      const content = readFileSync(fp, "utf-8");
      prompt = prompt ? `${prompt}\n\n${content}` : content;
    }
  }
  return prompt;
}

/** Rough token estimate: ~4 chars per token (good enough for batching decisions). */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Resolve max output tokens for the current model.
 * Uses the model's actual max_completion_tokens from OpenRouter metadata.
 * For reasoning models, this includes the thinking token budget, so it must
 * be the full value — we don't include thinking tokens in the saved output,
 * but they still count against this limit.
 * Falls back to context_length if max_completion_tokens is unavailable.
 */
function resolveDefaultMaxTokens(): number {
  if (currentBackend.type === "openrouter" && currentBackend.model) {
    const match = openRouterModelCache.find(
      (m) => m.id === currentBackend.model,
    );
    if (match?.top_provider?.max_completion_tokens)
      return match.top_provider.max_completion_tokens;
    if (match?.context_length) return match.context_length;
  }
  return FALLBACK_CONTEXT_LENGTH;
}

interface FileData {
  path: string;
  block: string;
  tokens: number;
}

/**
 * Read files from disk and group them into batches using First-Fit Decreasing
 * (FFD) bin packing. The budget covers the ENTIRE payload: prompt + instructions +
 * instruction files + code files + inline content.
 *
 * Since ensemble requires both models to process every batch, the budget must fit
 * within the WEAKER model's context window. Default: 400 KB (safe for Grok 4.1
 * Fast ~131K token context minus output and prompt overhead).
 *
 * @param budgetBytes Total payload budget in bytes. Overrides DEFAULT_MAX_PAYLOAD_BYTES.
 *                    Typically set from the tool's max_payload_kb parameter × 1024.
 */
function readAndGroupFiles(
  filePaths: string[],
  promptBytes: number,
  redact?: boolean,
  budgetBytes?: number,
  regexRedact?: RegexRedactOpts | null,
): { groups: FileData[][]; autoBatched: boolean; skipped: string[] } {
  // M1: Enforce minimum budget (10 KB) to avoid silent skip-all
  const totalBudget = Math.max(
    10 * 1024,
    budgetBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
  );
  // H1: promptBytes is now actual byte length (computed by caller via
  // Buffer.byteLength), not a token estimate. This prevents non-ASCII
  // (CJK, emoji) from causing budget underestimation.
  const availableForFiles = Math.max(0, totalBudget - promptBytes);

  const skipped: string[] = [];
  const fileData: FileData[] = [];

  for (const fp of filePaths) {
    try {
      const stats = statSync(fp);
      // Skip files larger than the total budget (can never fit in any batch)
      if (stats.size > totalBudget) {
        skipped.push(fp);
        continue;
      }
      const block = readFileAsCodeBlock(fp, undefined, redact, totalBudget, regexRedact);
      // Skip files whose fenced content exceeds available space after prompt
      if (block.length > availableForFiles) {
        skipped.push(fp);
        continue;
      }
      fileData.push({ path: fp, block, tokens: estimateTokens(block) });
    } catch {
      // Unreadable or binary — skip silently
      skipped.push(fp);
    }
  }

  if (fileData.length === 0) {
    return { groups: [], autoBatched: false, skipped };
  }

  const totalFileBytes = fileData.reduce((sum, fd) => sum + fd.block.length, 0);

  // If everything fits in one call, return a single group
  if (totalFileBytes <= availableForFiles) {
    return { groups: [fileData], autoBatched: false, skipped };
  }

  // ── First-Fit Decreasing (FFD) bin packing ──
  // Sort files largest-first so big files get placed first, then smaller files
  // fill remaining space. This minimizes the number of batches (API calls).
  const sorted = [...fileData].sort((a, b) => b.block.length - a.block.length);
  const bins: { items: FileData[]; used: number }[] = [];

  for (const fd of sorted) {
    // Find first bin with enough remaining space
    let placed = false;
    for (const bin of bins) {
      if (bin.used + fd.block.length <= availableForFiles) {
        bin.items.push(fd);
        bin.used += fd.block.length;
        placed = true;
        break;
      }
    }
    if (!placed) {
      // Open a new bin
      bins.push({ items: [fd], used: fd.block.length });
    }
  }

  const groups = bins.map((bin) => bin.items);
  return { groups, autoBatched: groups.length > 1, skipped };
}

/**
 * answer_mode controls how output .md files are organized:
 *   0 = one .md file per input file (separate LLM calls per file)
 *   1 = one .md file per LLM request, with structured per-file sections inside
 *   2 = one .md file for the entire operation (all batches merged)
 * For non-batch requests, mode 2 falls back to mode 1.
 */
type AnswerMode = 0 | 1 | 2;

function resolveAnswerMode(raw: unknown, defaultMode: AnswerMode): AnswerMode {
  if (raw === 0 || raw === 1 || raw === 2) return raw;
  return defaultMode;
}

/**
 * Build structured output instruction for answer_mode=1.
 * Tells the LLM to produce a separate labeled section for each input file.
 */
function buildPerFileSectionPrompt(filePaths: string[]): string {
  if (filePaths.length <= 1) return "";
  return (
    "\n\nOUTPUT FORMAT: You are receiving " +
    filePaths.length +
    " input files. " +
    "Produce a SEPARATE report section for each file, using this exact format:\n\n" +
    "## File: <absolute-file-path>\n\n<your analysis/report for this file>\n\n---\n\n" +
    "Produce exactly " +
    filePaths.length +
    " sections, one for each input file, in the order they appear. " +
    "Do NOT merge or combine sections. Each file must have its own complete, independent section.\n"
  );
}

// splitPerFileSections lives in ./grouping.ts — it is the inverse of
// buildPerFileSectionPrompt above and is imported at the top of this file.

// ── Directory walking helper ─────────────────────────────────────────

const WALK_DEFAULT_EXCLUDE = new Set([
  // Version control
  ".git",
  // Package managers / dependencies
  "node_modules",
  "bower_components",
  ".pnpm-store",
  // Python
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".eggs",
  "*.egg-info",
  // Build outputs
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".output",
  "target",
  // Caches / temp
  ".cache",
  ".turbo",
  "coverage",
  "tmp",
  "temp",
  ".temp",
  ".tmp",
  // IDE / editor
  ".idea",
  ".vscode",
  // Other
  ".gradle",
  ".cargo",
  ".nx",
  "vendor",
]);

/**
 * Run `git ls-files` across all git repos within a directory.
 * Handles: the main repo, git submodules (--recurse-submodules),
 * and independent nested git repos (separate .git directories).
 * Returns null if no git repos found at all.
 */
function gitLsFilesMultiRepo(dirPath: string, recursive: boolean): string[] | null {
  const allFiles = new Set<string>();

  // Find the git root for dirPath (if it's inside a git repo)
  const topLevelResult = spawnSync(
    "git", ["rev-parse", "--show-toplevel"],
    { cwd: dirPath, encoding: "utf-8", timeout: 5000 },
  );
  const isInGitRepo = topLevelResult.status === 0 && topLevelResult.stdout.trim();

  // Run git ls-files from dirPath (handles main repo + submodules)
  if (isInGitRepo) {
    // Step 1: tracked files + submodules (--recurse-submodules is incompatible with --others)
    const trackedResult = spawnSync(
      "git", ["ls-files", "--cached", "--recurse-submodules"],
      { cwd: dirPath, encoding: "utf-8", timeout: 30000 },
    );
    if (trackedResult.status === 0 && trackedResult.stdout) {
      for (const relPath of trackedResult.stdout.split("\n")) {
        if (!relPath.trim()) continue;
        allFiles.add(join(dirPath, relPath));
      }
    } else {
      // --recurse-submodules may fail on older git — retry without it
      const fallback = spawnSync(
        "git", ["ls-files", "--cached"],
        { cwd: dirPath, encoding: "utf-8", timeout: 15000 },
      );
      if (fallback.status === 0 && fallback.stdout) {
        for (const relPath of fallback.stdout.split("\n")) {
          if (!relPath.trim()) continue;
          allFiles.add(join(dirPath, relPath));
        }
      }
    }

    // Step 2: untracked files (not in submodules — --others doesn't support --recurse-submodules)
    const untrackedResult = spawnSync(
      "git", ["ls-files", "--others", "--exclude-standard"],
      { cwd: dirPath, encoding: "utf-8", timeout: 15000 },
    );
    if (untrackedResult.status === 0 && untrackedResult.stdout) {
      for (const relPath of untrackedResult.stdout.split("\n")) {
        if (!relPath.trim()) continue;
        allFiles.add(join(dirPath, relPath));
      }
    }
  }

  // Scan for independent nested git repos (directories with their own .git
  // that are NOT submodules of the parent repo). Each gets its own git ls-files.
  if (recursive) {
    const nestedGitRoots: string[] = [];
    function findNestedGitRoots(dir: string, depth: number) {
      if (depth > 10) return; // prevent deep recursion
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name === ".git" || entry.name === "node_modules") continue;
        if (entry.name.startsWith(".")) continue;
        const subDir = join(dir, entry.name);
        // Check if this subdirectory is an independent git repo
        const gitDir = join(subDir, ".git");
        let gitDirIsDir = false;
        try { gitDirIsDir = lstatSync(gitDir).isDirectory(); } catch { /* not present */ }
        if (gitDirIsDir) {
          // .git is a real directory → independent repo, not a submodule.
          // Submodules have .git as a FILE (containing a "gitdir:" pointer), so
          // they are correctly excluded by the lstatSync().isDirectory() check above.
          nestedGitRoots.push(subDir);
          continue; // don't recurse further into this repo's subdirs for more git roots
        }
        findNestedGitRoots(subDir, depth + 1);
      }
    }
    findNestedGitRoots(dirPath, 0);

    // Run git ls-files in each nested git repo
    for (const nestedRoot of nestedGitRoots) {
      const nestedResult = spawnSync(
        "git", ["ls-files", "--cached", "--others", "--exclude-standard"],
        { cwd: nestedRoot, encoding: "utf-8", timeout: 15000 },
      );
      if (nestedResult.status === 0 && nestedResult.stdout) {
        for (const relPath of nestedResult.stdout.split("\n")) {
          if (!relPath.trim()) continue;
          allFiles.add(join(nestedRoot, relPath));
        }
      }
    }
  }

  // Return null when target is not itself a git repo (triggers manual walk fallback).
  // Without this, a mixed-content directory with one or more nested independent git
  // repos would silently drop every non-git file: gitLsFilesMultiRepo would return
  // only the nested-repo files, and walkDir's git branch would return that partial
  // list. Deferring to manual walk ensures every file in the target tree is seen;
  // manual walk still skips .git/.svn/.hg dirs and respects exclude_dirs.
  if (!isInGitRepo) return null;
  return [...allFiles];
}

/**
 * Recursively walk a directory and return file paths matching criteria.
 * Skips hidden directories and common non-source directories by default.
 */
function walkDir(
  dirPath: string,
  options?: {
    extensions?: string[];
    maxFiles?: number;
    exclude?: string[];
    includeBinary?: boolean;
    useGitignore?: boolean;
    recursive?: boolean;       // default: true — recurse into subdirectories
    followSymlinks?: boolean;  // default: true — follow symlinks to files/dirs
  },
): string[] {
  const maxFiles = options?.maxFiles ?? 10000;
  const extensions = options?.extensions;
  const skipBinary = !options?.includeBinary;
  const recursive = options?.recursive !== false;       // default true
  const followSymlinks = options?.followSymlinks !== false; // default true

  // When useGitignore is true, use `git ls-files` which respects all .gitignore rules:
  // - Nested .gitignore files in subdirectories
  // - Global gitignore (~/.config/git/ignore)
  // - Git submodules (--recurse-submodules)
  // - Independent git repos nested inside dirPath (detected and scanned separately)
  if (options?.useGitignore) {
    const gitResults = gitLsFilesMultiRepo(dirPath, recursive);
    if (gitResults !== null) {
      const results: string[] = [];
      for (const fullPath of gitResults) {
        if (results.length >= maxFiles) break;
        if (skipBinary && isBinaryExtension(fullPath)) continue;
        if (extensions) {
          const ext = extname(fullPath).toLowerCase();
          if (!extensions.includes(ext)) continue;
        }
        results.push(fullPath);
      }
      return results;
    }
    // Fall through to manual walk if no git repos found in dirPath
    process.stderr.write(
      `[llm-externalizer] No git repo found in ${dirPath}, falling back to manual walk\n`,
    );
  }

  const results: string[] = [];
  const extraExclude = options?.exclude ?? [];
  const exclude = new Set([...WALK_DEFAULT_EXCLUDE, ...extraExclude]);
  // Track visited real paths to detect circular symlinks
  const visitedPaths = new Set<string>();

  function recurse(dir: string) {
    if (results.length >= maxFiles) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= maxFiles) return;
      const fullPath = join(dir, entry.name);

      // Resolve symlinks: follow them to their target (file or dir)
      // Track visited real paths to prevent infinite loops from circular symlinks
      if (entry.isSymbolicLink()) {
        if (!followSymlinks) continue;
        try {
          const realPath = realpathSync(fullPath);
          if (visitedPaths.has(realPath)) continue; // circular symlink — skip
          visitedPaths.add(realPath);
          const targetStat = statSync(realPath);
          if (targetStat.isDirectory() && recursive) {
            if (!entry.name.startsWith(".") && !exclude.has(entry.name)) {
              recurse(fullPath);
            }
          } else if (targetStat.isFile()) {
            if (skipBinary && isBinaryExtension(fullPath)) continue;
            if (extensions) {
              const ext = extname(entry.name).toLowerCase();
              if (!extensions.includes(ext)) continue;
            }
            results.push(fullPath);
          }
        } catch {
          continue; // broken symlink — skip
        }
        continue;
      }

      if (entry.isDirectory()) {
        if (!recursive) continue;
        // L7: Only skip well-known hidden dirs, not all dotfiles
        if (entry.name === ".git" || entry.name === ".svn" || entry.name === ".hg" || exclude.has(entry.name)) continue;
        // Skip other hidden dirs (covers .venv, .cache, etc.)
        if (entry.name.startsWith(".")) continue;
        // Track real path of directories to prevent cycles via symlinks pointing to ancestors
        try {
          const dirRealPath = realpathSync(fullPath);
          if (visitedPaths.has(dirRealPath)) continue;
          visitedPaths.add(dirRealPath);
        } catch { continue; }
        recurse(fullPath);
      } else if (entry.isFile()) {
        // Skip binary files by extension (readFileAsCodeBlock has null-byte check as second layer)
        if (skipBinary && isBinaryExtension(fullPath)) continue;
        if (extensions) {
          const ext = extname(entry.name).toLowerCase();
          if (!extensions.includes(ext)) continue;
        }
        results.push(fullPath);
      }
    }
  }

  recurse(dirPath);
  return results;
}

// ── Import resolution helper ─────────────────────────────────────────

/**
 * Extract local import paths from a source file using regex patterns.
 * Returns absolute paths to locally imported files that exist on disk.
 *
 * HEURISTIC: This is best-effort — regex cannot fully parse all import syntaxes.
 * It handles the most common patterns for TS/JS/Python. For Go and Rust,
 * module resolution is too different from file paths to be reliably regex-parsed,
 * so those languages are not supported and fall through to an empty result.
 * The LLM in check_references provides a more thorough analysis.
 */
function extractLocalImports(filePath: string, sourceCode: string): string[] {
  const dir = dirname(filePath);
  const lang = detectLang(filePath);
  const paths: string[] = [];
  const patterns: RegExp[] = [];

  if (lang === "typescript" || lang === "javascript") {
    // import/export ... from './path' or '../path'
    patterns.push(/(?:import|export)\s+.*?from\s+['"](\.[^'"]+)['"]/g);
    // require('./path')
    patterns.push(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g);
  } else if (lang === "python") {
    // from .module import ... (relative imports with dot prefix)
    patterns.push(/from\s+(\.[\w.]*)\s+import/g);
  }
  // Go and Rust use module/package systems that don't map directly to relative file paths.
  // Their import resolution requires understanding go.mod/Cargo.toml — skip for now.

  for (const pattern of patterns) {
    // Reset lastIndex since patterns have /g flag and may be reused
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(sourceCode)) !== null) {
      const importPath = match[1];
      let resolved: string;
      if (lang === "python" && importPath.startsWith(".")) {
        const dotCount = importPath.match(/^\.+/)?.[0].length ?? 1;
        const modulePart = importPath.slice(dotCount);
        const baseDir = dotCount === 1 ? dir : join(dir, ...Array(dotCount - 1).fill(".."));
        resolved = modulePart ? join(baseDir, ...modulePart.split(".")) : baseDir;
      } else {
        resolved = join(dir, importPath);
      }
      if (!extname(resolved)) {
        const tryExts = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py"];
        let found = false;
        for (const ext of tryExts) {
          if (existsSync(resolved + ext)) {
            resolved = resolved + ext;
            found = true;
            break;
          }
        }
        if (!found) {
          // TS/JS package entry points (index.*) and Python package init files
          // (__init__.py). A Python relative import like `from . import foo`
          // or `from .pkg import X` resolves to a package directory whose
          // dependencies live in __init__.py — without this lookup those
          // deps would be missed by check_references.
          const indexCandidates = [
            "index.ts", "index.tsx", "index.js", "index.jsx",
            "__init__.py",
          ];
          for (const leaf of indexCandidates) {
            const indexPath = join(resolved, leaf);
            if (existsSync(indexPath)) {
              resolved = indexPath;
              found = true;
              break;
            }
          }
        }
        if (!found) continue;
      } else if (!existsSync(resolved)) {
        continue;
      }
      paths.push(resolved);
    }
  }

  return [...new Set(paths)];
}

// ── Profile-based settings (~/.llm-externalizer/settings.yaml) ───────
// YAML settings file with named profiles, persists across reinstalls.
// Stores per-provider configuration (openrouter, lmstudio, ollama) with
// a single `active` field to switch between them.
// Env vars override settings when present (non-empty).

import {
  type Settings,
  type Profile,
  type ResolvedProfile,
  API_PRESETS,
  validateSettings,
  resolveProfile,
  ensureSettingsExist,
  getSettingsPath,
  getConfigDir,
  generateDefaultSettings,
} from "./config.js";
import {
  fetchOpenRouterModelInfo,
  formatModelInfoMarkdown,
  formatModelInfoTable,
  formatModelInfoJson,
} from "./or-model-info.js";

// Settings path (cross-platform, see config.ts)
const SETTINGS_FILE = getSettingsPath();

// Whether settings are valid (configured by user). If false, all tools except
// discover return an error asking the user to configure settings.yaml.
let settingsValid = false;
let settingsError = "";

// ── Profile-based startup ────────────────────────────────────────────
// Load settings.yaml, validate active profile, resolve to concrete values.
// ensureSettingsExist() generates default settings.yaml on first run.

let activeSettings: Settings = (() => {
  try {
    return ensureSettingsExist();
  } catch (err) {
    settingsError = `Failed to load settings: ${err instanceof Error ? err.message : String(err)}\n\nSettings file: ${SETTINGS_FILE}`;
    process.stderr.write(`[llm-externalizer] ⚠ ${settingsError}\n`);
    return generateDefaultSettings();
  }
})();

let activeResolved: ResolvedProfile | null = (() => {
  const validation = validateSettings(activeSettings);
  if (!validation.valid) {
    settingsError = `${validation.errors.join("; ")}\n\nSettings file: ${SETTINGS_FILE}`;
    process.stderr.write(`[llm-externalizer] ⚠ ${settingsError}\n`);
    return null;
  }
  settingsValid = true;
  const profile = activeSettings.profiles[activeSettings.active];
  const resolved = resolveProfile(activeSettings.active, profile);
  // Log auth status on startup so users can verify env vars are picked up
  if (resolved.authToken) {
    process.stderr.write(
      `[llm-externalizer] Auth: token resolved (${resolved.authToken.length} chars)\n`,
    );
  } else {
    const preset = API_PRESETS[profile.api];
    const envRef = preset?.isLocal
      ? profile.api_token || preset.defaultAuthEnv
      : profile.api_key || preset?.defaultAuthEnv;
    if (envRef?.startsWith("$")) {
      process.stderr.write(
        `[llm-externalizer] ⚠ Auth: ${envRef} is NOT set in the environment\n`,
      );
    }
  }
  return resolved;
})();

const DEFAULT_OPENROUTER_RPS = 5; // conservative default if balance can't be determined
const DEFAULT_MAX_IN_FLIGHT_REMOTE = 200; // safety cap on total concurrent requests

// When the caller doesn't specify max_tokens, we request the model's full context
// window as the output budget. The API clamps this to the model's actual max output.
// This ensures the LLM is never artificially truncated — truncation causes more harm
const DEFAULT_TEMPERATURE = 0.1;

// Appended to ALL system prompts to prevent verbose output that wastes tokens and causes truncation.
const BREVITY_RULES =
  "\nOUTPUT RULES:\n" +
  "- Be SUCCINCT. Use bullet points, not paragraphs.\n" +
  "- Skip preamble, filler, and restating the task.\n" +
  "- Only report findings, not things that are correct.\n" +
  "- For code reviews: skip files/areas with no issues — only mention what needs attention.\n" +
  "- Maximum 3 sentences per finding. Lead with the problem, not the context.";

// Example of the file wrapping format, prepended to all system prompts that receive files.
// Shows the LLM exactly what to expect so it can parse multi-file batches reliably.
const FILE_FORMAT_EXAMPLE =
  "\nINPUT FORMAT: Each attached file is wrapped as follows (placeholders use {BRACES}, actual tags use angle brackets):\n" +
  "<filename>\n" +
  "{ABSOLUTE_PATH_HERE}\n" +
  "</filename>\n" +
  "<file-content>\n" +
  "````{LANGUAGE}\n" +
  "{FILE_CONTENTS_HERE}\n" +
  "````\n" +
  "</file-content>\n" +
  "Reference files by the path inside the filename tag. Multiple files may appear in sequence.\n";
const CONNECT_TIMEOUT_MS = 5000;
// Per-LLM-request timeout. Reasoning models (Qwen, etc.) need extended time for thinking.
// The MCP tool-call timeout is inactivity-based, kept alive by heartbeat — no hard cap needed.
// Default: profile timeout (300s). Extended dynamically when reasoning tokens are flowing.
let SOFT_TIMEOUT_MS = (activeResolved?.timeout ?? 300) * 1000;
let FALLBACK_CONTEXT_LENGTH = activeResolved?.contextWindow || 100000;
const MODEL_CACHE_TTL_MS = 3600_000; // 1 hour TTL for OpenRouter model list cache

// ── Reasoning effort cache ──────────────────────────────────────────
// OpenRouter's chat/completions accepts a `reasoning: { effort, exclude }`
// field. Not every model supports it, and some only support certain effort
// levels. We try xhigh first, fall back to high, then drop reasoning
// entirely. Results are cached per model ID so we only probe once per
// session. `exclude: true` suppresses the reasoning trace from the response
// — we get the benefit of deeper thinking without paying to stream the chain.
// Values stored: "xhigh" (unprobed or confirmed xhigh), "high" (downgraded),
// "none" (reasoning rejected or unsupported).
const MODEL_REASONING_CACHE = new Map<string, "xhigh" | "high" | "none">();

// OpenRouter's `ChatRequestReasoning` schema (chat/completions) has
// ONLY two properties: `effort` and `summary`. There is no `exclude`,
// `enabled`, or `max_tokens` on this endpoint — those belong to the
// Responses API's ReasoningConfig. See docs/openrouter/chat-completions-api.md
// for the raw OpenAPI spec. Earlier code sent `exclude: true`, which
// OpenRouter silently dropped. The reasoning trace comes back in
// `message.reasoning` / `message.reasoning_details`, which we ignore;
// we only read `message.content`.
function reasoningLadderForModel(
  modelId: string,
): Array<Record<string, unknown> | null> {
  if (!modelId) return [null];
  const cached = MODEL_REASONING_CACHE.get(modelId);
  if (cached === "none") return [null];
  if (cached === "high") return [{ effort: "high" }, null];
  return [{ effort: "xhigh" }, { effort: "high" }, null];
}

// ── Per-model request body overrides ────────────────────────────────
// Some models need sampling parameters that differ from our defaults.
// This registry keeps the model-specific knobs out of the main code
// paths — every entry is optional and unset fields fall back to the
// caller's defaults.
//
// IMPORTANT — what OpenRouter can and can't forward:
//   There is NO generic pass-through for vendor-specific parameters in
//   either /chat/completions or /responses. Both `provider` objects
//   have fixed schemas. OpenRouter only forwards known vendor fields
//   (safe_prompt for Mistral, raw_mode for Hyperbolic, etc.) that are
//   explicitly mapped in its routing layer. Sending unknown top-level
//   fields like vLLM's `chat_template_kwargs` results in them being
//   silently dropped. See docs/openrouter/chat-completions-api.md and
//   docs/openrouter/responses-api.md for the raw OpenAPI specs.
//
//   For models that need thinking enabled, the only supported path is
//   `reasoning.effort` — OpenRouter's internal routing translates this
//   into whatever provider-specific flag the backend expects, based on
//   the model's `supports_reasoning` metadata. Our ladder sends this
//   automatically.
interface ModelRequestOverrides {
  temperature?: number;
  top_p?: number;
}

const MODEL_REQUEST_OVERRIDES: Record<string, ModelRequestOverrides> = {
  // NVIDIA Nemotron 3 Super 120B (free tier). NVIDIA's documented
  // sampling recommendation: temperature=1.0, top_p=0.95. The earlier
  // empty-response failures were caused by our ensemble default of
  // temperature=0.1, which is far below what this model tolerates —
  // the sampling floor collapsed the output distribution to empty on
  // large inputs. OpenRouter reports supports_reasoning=true for this
  // model, so the reasoning.effort field from the ladder is still
  // sent and translated to the vLLM enable_thinking flag internally.
  "nvidia/nemotron-3-super-120b-a12b:free": {
    temperature: 1.0,
    top_p: 0.95,
  },
};

function applyModelOverrides(
  body: Record<string, unknown>,
  modelId: string | undefined,
): Record<string, unknown> {
  if (!modelId) return body;
  const override = MODEL_REQUEST_OVERRIDES[modelId];
  if (!override) return body;
  const out = { ...body };
  if (override.temperature !== undefined) out.temperature = override.temperature;
  if (override.top_p !== undefined) out.top_p = override.top_p;
  return out;
}

// ── Dynamic per-model supported_parameters filter ────────────────────
// OpenRouter's /v1/models endpoint reports each model's
// `supported_parameters` — a concrete list of which request-body fields
// the upstream provider accepts. For example, Nemotron 3 Super :free
// supports reasoning/temperature/top_p but NOT frequency_penalty,
// presence_penalty, top_k, min_p, stop, or repetition_penalty.
//
// We cache this per model and filter the outgoing request body so that
// unsupported fields are silently dropped. This is forward-compatible:
// any new model is handled automatically without hardcoding overrides.
// OpenRouter control fields (stream, plugins, messages, model, etc.)
// are NOT in supported_parameters and must never be filtered — we only
// touch the subset in FILTERABLE_REQUEST_FIELDS below.
const MODEL_SUPPORTED_PARAMS = new Map<string, Set<string>>();
let modelSupportedParamsCacheTime = 0;
const MODEL_SUPPORTED_PARAMS_TTL_MS = 3600_000; // 1 hour

// The subset of request-body keys we compare against supported_parameters.
// OpenRouter routing/control fields (stream, model, messages, plugins,
// metadata, provider, debug, etc.) are NOT listed here — they are always
// forwarded regardless of the model.
const FILTERABLE_REQUEST_FIELDS = new Set([
  "temperature",
  "top_p",
  "top_k",
  "min_p",
  "top_a",
  "frequency_penalty",
  "presence_penalty",
  "repetition_penalty",
  "reasoning",
  "include_reasoning",
  "response_format",
  "structured_outputs",
  "seed",
  "stop",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "logit_bias",
  "logprobs",
  "top_logprobs",
]);

async function getModelSupportedParams(
  modelId: string,
): Promise<Set<string> | null> {
  if (!modelId || currentBackend.type !== "openrouter") return null;
  const now = Date.now();
  if (now - modelSupportedParamsCacheTime > MODEL_SUPPORTED_PARAMS_TTL_MS) {
    MODEL_SUPPORTED_PARAMS.clear();
    modelSupportedParamsCacheTime = now;
  }
  const cached = MODEL_SUPPORTED_PARAMS.get(modelId);
  if (cached !== undefined) return cached;

  try {
    // Query the per-model endpoint with the EXACT model id.
    // /v1/models/{id}/endpoints returns { data: { endpoints: [...] } }
    // where each endpoint carries its own supported_parameters list.
    // We take the UNION across endpoints — if any provider for this
    // model accepts a field, sending it is safe (the provider that
    // doesn't accept will either ignore it or return a 400, which the
    // reasoning ladder and retry loop already handle).
    const res = await fetchWithTimeout(
      `${currentBackend.baseUrl}/v1/models/${modelId}/endpoints`,
      { headers: apiHeaders() },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as {
      data?: {
        endpoints?: Array<{ supported_parameters?: string[] }>;
      };
    };
    const endpoints = body.data?.endpoints;
    if (!Array.isArray(endpoints) || endpoints.length === 0) return null;
    const merged = new Set<string>();
    for (const ep of endpoints) {
      if (Array.isArray(ep.supported_parameters)) {
        for (const p of ep.supported_parameters) merged.add(p);
      }
    }
    if (merged.size === 0) return null;
    MODEL_SUPPORTED_PARAMS.set(modelId, merged);
    process.stderr.write(
      `[llm-externalizer] Model ${modelId} supports: ${Array.from(merged).sort().join(", ")}\n`,
    );
    return merged;
  } catch {
    // Non-fatal — unknown support, proceed without filtering
    return null;
  }
}

function filterBodyForSupportedParams(
  body: Record<string, unknown>,
  supported: Set<string> | null,
): Record<string, unknown> {
  if (!supported) return body;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (FILTERABLE_REQUEST_FIELDS.has(key) && !supported.has(key)) {
      // Known filterable field, not supported by this model — drop it
      continue;
    }
    out[key] = value;
  }
  return out;
}

function recordReasoningRejection(
  modelId: string,
  failedReasoning: Record<string, unknown> | null,
): void {
  if (!modelId || !failedReasoning) return;
  const effort = (failedReasoning as { effort?: string }).effort;
  if (effort === "xhigh") MODEL_REASONING_CACHE.set(modelId, "high");
  else if (effort === "high") MODEL_REASONING_CACHE.set(modelId, "none");
}

function isReasoningRejectionError(status: number, bodyText: string): boolean {
  if (status !== 400 && status !== 422) return false;
  return /reason|effort|xhigh|thinking/i.test(bodyText);
}

// ── Backend configuration ────────────────────────────────────────────
// Tracks which backend (local or OpenRouter) is currently active.
// Built from the resolved profile. Mutable — profile switching updates this.

interface BackendConfig {
  type: "local" | "openrouter";
  baseUrl: string;
  apiKey: string;
  model: string;
  // LM Studio native API support — auto-detected on first request
  isLMStudio?: boolean;
  lmStudioDetected?: boolean; // true once detection has run (even if negative)
}

/** Build a BackendConfig from the active resolved profile */
function makeBackendFromProfile(
  resolved: ResolvedProfile,
  modelOverride?: string,
): BackendConfig {
  const isRemote = resolved.protocol === "openrouter_api";
  return {
    type: isRemote ? "openrouter" : "local",
    baseUrl: resolved.url,
    apiKey: resolved.authToken,
    model: modelOverride || resolved.model,
    // LM Studio: undefined means "not yet probed", true/false means "probe complete"
    isLMStudio: resolved.protocol === "lmstudio_api" ? undefined : false,
    lmStudioDetected: resolved.protocol === "lmstudio_api" ? undefined : true,
  };
}

let currentBackend: BackendConfig = activeResolved
  ? makeBackendFromProfile(activeResolved)
  : { type: "local", baseUrl: "http://localhost:1234", apiKey: "", model: "" };

// ── Settings file watcher — auto-reload on manual edits ─────────────
// Polls settings.yaml every 5s. On change: validate → reload in memory.
// Invalid changes are logged but ignored (old settings remain active).

// Late-bound hook — assigned after the MCP server is created (see notifyToolsChanged)
let _onSettingsReloaded: (() => void) | null = null;

/** Reload settings from disk. Returns true if settings changed and were applied. */
function reloadSettingsFromDisk(): boolean {
  let raw: string;
  try {
    raw = readFileSync(SETTINGS_FILE, "utf-8");
  } catch {
    // File temporarily missing (mid-save) — skip this cycle
    return false;
  }

  let parsed: { active?: string; profiles?: Record<string, Profile> };
  try {
    parsed = yamlParse(raw);
  } catch {
    process.stderr.write(
      `[llm-externalizer] ⚠ settings.yaml has invalid YAML — ignoring change\n`,
    );
    return false;
  }

  if (!parsed || typeof parsed !== "object" || !parsed.profiles) {
    return false;
  }

  const newSettings: Settings = {
    active: parsed.active || "",
    profiles: parsed.profiles || {},
  };

  // Validate before applying
  if (newSettings.active) {
    const validation = validateSettings(newSettings);
    if (!validation.valid) {
      process.stderr.write(
        `[llm-externalizer] ⚠ settings.yaml change rejected: ${validation.errors.join("; ")}\n`,
      );
      return false;
    }
  }

  // Apply the new settings in memory
  activeSettings = newSettings;
  if (newSettings.active && newSettings.profiles[newSettings.active]) {
    const profile = newSettings.profiles[newSettings.active];
    activeResolved = resolveProfile(newSettings.active, profile);
    currentBackend = makeBackendFromProfile(activeResolved);
    settingsValid = true;
    settingsError = "";
    cachedRateLimitConfig = null; rateLimitCacheTime = 0;
    openRouterCacheTime = 0;
  } else {
    settingsValid = false;
    settingsError = "No active profile configured";
    activeResolved = null;
  }
  SOFT_TIMEOUT_MS = (activeResolved?.timeout ?? 300) * 1000;
  FALLBACK_CONTEXT_LENGTH = activeResolved?.contextWindow || 100000;
  // Notify MCP client that tool descriptions may have changed (backend switch)
  _onSettingsReloaded?.();
  return true;
}

// Track mtime so we only reload when the file actually changed on disk
let _settingsLastMtimeMs = (() => {
  try {
    return statSync(SETTINGS_FILE).mtimeMs;
  } catch {
    return 0;
  }
})();

// Poll every 5s — fs.watchFile uses stat polling (reliable across all platforms/NFS)
watchFile(SETTINGS_FILE, { interval: 5000 }, (curr, _prev) => {
  if (curr.mtimeMs === _settingsLastMtimeMs) return; // no change
  _settingsLastMtimeMs = curr.mtimeMs;

  process.stderr.write(
    `[llm-externalizer] settings.yaml changed on disk — reloading…\n`,
  );
  if (reloadSettingsFromDisk()) {
    const label = activeResolved
      ? `${activeSettings.active} (${currentBackend.type}, ${currentBackend.model})`
      : "(no active profile)";
    process.stderr.write(`[llm-externalizer] Settings reloaded: ${label}\n`);
  }
});

// Clean up watcher on process exit to avoid dangling handles
process.on("exit", () => {
  unwatchFile(SETTINGS_FILE);
});

// ── OpenRouter model list cache ──────────────────────────────────────

interface OpenRouterModelInfo {
  id: string;
  name: string;
  context_length?: number;
  pricing?: { prompt: string; completion: string };
  top_provider?: { max_completion_tokens?: number; context_length?: number };
}

let openRouterModelCache: OpenRouterModelInfo[] = [];
let openRouterCacheTime = 0; // epoch ms when cache was last populated

async function fetchOpenRouterModels(): Promise<OpenRouterModelInfo[]> {
  const now = Date.now();
  // Return cached if still fresh
  if (
    openRouterModelCache.length > 0 &&
    now - openRouterCacheTime < MODEL_CACHE_TTL_MS
  ) {
    return openRouterModelCache;
  }

  if (!activeResolved) throw new Error("No active profile");
  const res = await fetchWithTimeout(`${activeResolved.url}/v1/models`, {
    headers: { Authorization: `Bearer ${activeResolved.authToken}` },
  });
  if (!res.ok) throw new Error(`OpenRouter /models returned ${res.status}`);
  const data = (await res.json()) as { data?: unknown };
  if (!Array.isArray(data.data)) {
    throw new Error(
      "OpenRouter /models returned unexpected shape (data is not an array)",
    );
  }
  openRouterModelCache = data.data as OpenRouterModelInfo[];
  openRouterCacheTime = now;
  return openRouterModelCache;
}

// ── OpenRouter rate-limit detection ──────────────────────────────────
// RPS (requests per second) != concurrency. RPS controls how many NEW requests
// can be started each second. Multiple requests run in-flight simultaneously.
// OpenRouter formula: $1 balance ≈ 1 RPS, capped at 500.
//
// Detection priority:
//   1. Profile explicit max_rps override
//   2. /api/v1/key → rate_limit.requests (if > 0)
//   3. /api/v1/key → derive from limit_remaining (available balance)
//   4. /api/v1/credits → derive from total_credits - total_usage (needs mgmt key)
//   5. Conservative default (DEFAULT_OPENROUTER_RPS)

interface RateLimitConfig {
  rps: number;       // max new requests per second
  maxInFlight: number; // max concurrent requests (safety cap)
}

let cachedRateLimitConfig: RateLimitConfig | null = null;
let rateLimitCacheTime = 0;

/** Derive RPS from dollar balance: $1 = 1 RPS, min 1, max 500 */
function balanceToRps(balance: number): number {
  if (!isFinite(balance) || balance <= 0) return DEFAULT_OPENROUTER_RPS;
  return Math.min(500, Math.max(1, Math.floor(balance)));
}

/** Parse interval string like "10s", "1m", "60s" into milliseconds. Defaults to 1000ms. */
function parseIntervalMs(interval?: string): number {
  if (!interval) return 1000;
  const match = interval.match(/^(\d+)(s|m|ms)?$/i);
  if (!match) return 1000;
  const n = parseInt(match[1], 10);
  const unit = (match[2] || "s").toLowerCase();
  if (unit === "ms") return n;
  if (unit === "m") return n * 60_000;
  return n * 1000; // seconds
}

async function getRateLimitConfig(): Promise<RateLimitConfig> {
  // Local mode: sequential, no rate limiting needed
  if (!activeResolved || activeResolved.mode === "local") {
    return { rps: 1, maxInFlight: 1 };
  }

  const maxInFlight = DEFAULT_MAX_IN_FLIGHT_REMOTE;

  // Return cached value if fresh
  const now = Date.now();
  if (cachedRateLimitConfig && now - rateLimitCacheTime < MODEL_CACHE_TTL_MS) {
    return cachedRateLimitConfig;
  }

  let detectedRps = DEFAULT_OPENROUTER_RPS;

  if (activeResolved.protocol === "openrouter_api") {
    try {
      // Step 1: Query /api/v1/key for rate_limit and balance info
      const keyRes = await fetchWithTimeout(`${activeResolved.url}/v1/key`, {
        headers: { Authorization: `Bearer ${activeResolved.authToken}` },
      });
      if (keyRes.ok) {
        const body = (await keyRes.json()) as {
          data: {
            rate_limit?: { requests?: number; interval?: string; note?: string };
            is_free_tier?: boolean;
            limit?: number | null;
            usage?: number;
            limit_remaining?: number | null;
          };
        };

        const rl = body.data?.rate_limit;
        if (rl?.requests && rl.requests > 0) {
          // API returned explicit rate limit — use it
          const intervalMs = parseIntervalMs(rl.interval);
          // Normalize to per-second: e.g. 20 requests per 10s = 2 RPS
          detectedRps = Math.max(1, Math.floor(rl.requests / (intervalMs / 1000)));
          process.stderr.write(
            `[llm-externalizer] Rate limit: ${rl.requests} req/${rl.interval || "1s"} → ${detectedRps} RPS\n`,
          );
        } else if (body.data?.is_free_tier) {
          // Free tier: very limited
          detectedRps = 2;
          process.stderr.write("[llm-externalizer] Free tier detected → 2 RPS\n");
        } else if (
          body.data?.limit_remaining !== null &&
          body.data?.limit_remaining !== undefined &&
          body.data.limit_remaining > 0
        ) {
          // Derive from remaining balance: $1 ≈ 1 RPS
          detectedRps = balanceToRps(body.data.limit_remaining);
          process.stderr.write(
            `[llm-externalizer] Balance: $${body.data.limit_remaining.toFixed(2)} → ${detectedRps} RPS\n`,
          );
        } else if (body.data?.limit === null) {
          // Unlimited key — try /api/v1/credits for actual balance
          detectedRps = await queryCreditsForRps();
        }
      }
    } catch {
      // Non-fatal — fall through to default
    }
  }

  cachedRateLimitConfig = { rps: detectedRps, maxInFlight };
  rateLimitCacheTime = now;
  return cachedRateLimitConfig;
}

/** Fallback: query /api/v1/credits (requires management key). Returns RPS or default. */
async function queryCreditsForRps(): Promise<number> {
  if (!activeResolved) return DEFAULT_OPENROUTER_RPS;
  try {
    const res = await fetchWithTimeout(`${activeResolved.url}/v1/credits`, {
      headers: { Authorization: `Bearer ${activeResolved.authToken}` },
    });
    if (res.ok) {
      const body = (await res.json()) as {
        data: { total_credits?: number; total_usage?: number };
      };
      const credits = body.data?.total_credits ?? 0;
      const usage = body.data?.total_usage ?? 0;
      const balance = credits - usage;
      if (balance > 0) {
        const rps = balanceToRps(balance);
        process.stderr.write(
          `[llm-externalizer] Credits: $${balance.toFixed(2)} → ${rps} RPS\n`,
        );
        return rps;
      }
    }
    // 403 = not a management key, or other error — fall through
  } catch {
    // Non-fatal
  }
  return DEFAULT_OPENROUTER_RPS;
}


// ── Fuzzy model matching ─────────────────────────────────────────────
// Scores a query against model IDs so "gpt 4o" resolves to "openai/gpt-4o".

// ── Session-level token accounting ───────────────────────────────────
// Tracks cumulative tokens offloaded across all calls in this session.

const session = {
  calls: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalCost: 0, // Cumulative cost in USD from OpenRouter usage.cost
};

// ── OpenRouter balance + credit-exhaustion state ────────────────────
// Session-level flag that flips to true the first time we hit a 402
// "Payment required" error. All subsequent calls automatically route
// through FREE_MODEL_ID instead of the paid ensemble. The flag is only
// cleared on process restart — no point probing a dead wallet repeatedly.
let creditExhausted = false;

// Minimum balance required to attempt an ensemble call without falling
// back to free mode. An ensemble pass runs 3 models on one prompt; the
// cheapest of our three (Gemini 2.5 Flash at $0.15 in / $0.60 out) can
// still easily cost a couple of cents per file on larger inputs. $0.05
// is a floor that guarantees at least one small ensemble call can clear
// without a mid-flight 402.
const MIN_BALANCE_FOR_PAID_USD = 0.05;

// Balance query cache: fresh for 60s so we don't hammer /v1/credits
// every time a tool is invoked. Still queried on demand when the cache
// is stale. `null` means "not yet queried this session".
let cachedBalanceUsd: number | null = null;
let balanceCacheTime = 0;
const BALANCE_CACHE_TTL_MS = 60_000;

/**
 * Returns the remaining OpenRouter balance in USD, or `Infinity` if the
 * key is unlimited (no cap), or `NaN` if the query fails / we can't tell.
 * Callers should treat NaN as "unknown — proceed as if paid".
 */
async function getOpenRouterBalance(): Promise<number> {
  if (!activeResolved || activeResolved.protocol !== "openrouter_api") {
    return NaN;
  }
  const now = Date.now();
  if (cachedBalanceUsd !== null && now - balanceCacheTime < BALANCE_CACHE_TTL_MS) {
    return cachedBalanceUsd;
  }
  try {
    // /v1/key is the cheapest probe — returns limit_remaining for capped keys.
    const keyRes = await fetchWithTimeout(`${activeResolved.url}/v1/key`, {
      headers: { Authorization: `Bearer ${activeResolved.authToken}` },
    });
    if (keyRes.ok) {
      const body = (await keyRes.json()) as {
        data: {
          limit?: number | null;
          usage?: number;
          limit_remaining?: number | null;
        };
      };
      if (
        body.data?.limit_remaining !== null &&
        body.data?.limit_remaining !== undefined
      ) {
        cachedBalanceUsd = body.data.limit_remaining;
        balanceCacheTime = now;
        return cachedBalanceUsd;
      }
      if (body.data?.limit === null) {
        // Unlimited key — no cap. Treat as infinite for the purpose of
        // pre-flight checks; we'll still react to 402 mid-flight.
        cachedBalanceUsd = Infinity;
        balanceCacheTime = now;
        return Infinity;
      }
    }
    // Fall back to /v1/credits (requires management-level key).
    const credRes = await fetchWithTimeout(`${activeResolved.url}/v1/credits`, {
      headers: { Authorization: `Bearer ${activeResolved.authToken}` },
    });
    if (credRes.ok) {
      const body = (await credRes.json()) as {
        data: { total_credits?: number; total_usage?: number };
      };
      const credits = body.data?.total_credits ?? 0;
      const usage = body.data?.total_usage ?? 0;
      cachedBalanceUsd = credits - usage;
      balanceCacheTime = now;
      return cachedBalanceUsd;
    }
  } catch {
    // Non-fatal — unknown balance, proceed normally.
  }
  return NaN;
}

/**
 * Decide which model (if any) to force for a given tool invocation.
 *
 * - If the caller explicitly set `free: true`, always return FREE_MODEL_ID.
 * - If the backend is not OpenRouter, return undefined (no override).
 * - If the credit-exhausted session flag is set, return FREE_MODEL_ID.
 * - If the balance query succeeds and the remaining balance is below
 *   MIN_BALANCE_FOR_PAID_USD, return FREE_MODEL_ID and log the fallback.
 * - Otherwise return undefined (proceed with the normal ensemble / profile).
 */
async function resolveModelOverride(
  freeRequested: boolean,
): Promise<string | undefined> {
  if (freeRequested) return FREE_MODEL_ID;
  if (currentBackend.type !== "openrouter") return undefined;
  if (creditExhausted) {
    process.stderr.write(
      "[llm-externalizer] Credit exhausted this session — routing through free model\n",
    );
    return FREE_MODEL_ID;
  }
  const balance = await getOpenRouterBalance();
  if (!isFinite(balance)) return undefined; // unknown → proceed normally
  if (balance < MIN_BALANCE_FOR_PAID_USD) {
    process.stderr.write(
      `[llm-externalizer] Low balance ($${balance.toFixed(4)} < $${MIN_BALANCE_FOR_PAID_USD}) — auto-falling back to free model\n`,
    );
    creditExhausted = true; // lock the session so we don't re-probe
    return FREE_MODEL_ID;
  }
  return undefined;
}

/** Invalidate the cached balance so the next check hits the API fresh. */
function invalidateBalanceCache(): void {
  cachedBalanceUsd = null;
  balanceCacheTime = 0;
}

// ── Active request tracking ─────────────────────────────────────────
// Tracks in-flight LLM requests so `reset` can wait for them to drain.
let _activeRequests = 0;
let _activeRequestsDrained: (() => void) | null = null;

/** Call before starting an LLM request */
function trackRequestStart(): void {
  _activeRequests++;
}

/** Call after an LLM request completes (success or error) */
function trackRequestEnd(): void {
  _activeRequests = Math.max(0, _activeRequests - 1);
  if (_activeRequests === 0 && _activeRequestsDrained) {
    _activeRequestsDrained();
    _activeRequestsDrained = null;
  }
}

/** Returns a promise that resolves when all active requests have completed */
function waitForRequestsDrained(timeoutMs: number = 120_000): Promise<void> {
  if (_activeRequests === 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      // Timeout — resolve anyway to avoid hanging forever
      _activeRequestsDrained = null;
      resolve();
    }, timeoutMs);
    _activeRequestsDrained = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

// ── Session logging ─────────────────────────────────────────────────
// Each session gets a unique hash. Logs are JSONL files in llm_externalizer/logs/.
// Each entry records per-request tokens/cost and cumulative session totals.

const SESSION_ID = randomUUID().slice(0, 8);
const SESSION_START = new Date();

// Session logs live in ~/.llm-externalizer/logs/ so they persist across reinstalls/npx
const LOG_DIR = join(getConfigDir(), "logs");
const LOG_FILE = join(
  LOG_DIR,
  `session-${SESSION_ID}-${SESSION_START.toISOString().slice(0, 10)}.jsonl`,
);

interface LogEntry {
  timestamp: string;
  tool: string;
  model: string;
  status: "success" | "error" | "truncated";
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost: number; // Per-request cost in USD from OpenRouter (0 if not available)
  cumulative_tokens: number;
  cumulative_cost: number;
  file_path?: string;
  error?: string;
}

function writeLogEntry(entry: LogEntry): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
  } catch {
    // Logging must never crash the MCP — silently ignore write failures
    process.stderr.write(`[llm-externalizer] Failed to write log entry\n`);
  }
}

// ── Live stats file for statusline consumption ──────────────────────
// Written atomically on every request so the statusline script can poll it.
const STATS_FILE = "/tmp/claude/llm-externalizer-stats.json";

function writeStatsFile(): void {
  try {
    mkdirSync("/tmp/claude", { recursive: true, mode: 0o700 });
    const stats = {
      session_id: SESSION_ID,
      session_start: SESSION_START.toISOString(),
      updated: new Date().toISOString(),
      calls: session.calls,
      total_tokens: session.promptTokens + session.completionTokens,
      prompt_tokens: session.promptTokens,
      completion_tokens: session.completionTokens,
      total_cost: session.totalCost,
      model: currentBackend.model ?? "",
      backend: currentBackend.type,
    };
    // Atomic write: temp file + rename to prevent partial reads
    const tmpStats = STATS_FILE + ".tmp";
    writeFileSync(tmpStats, JSON.stringify(stats), { encoding: "utf-8", mode: 0o600 });
    renameSync(tmpStats, STATS_FILE);
  } catch {
    // Stats file must never crash the MCP
  }
}

/**
 * Log a completed request (success, error, or truncated).
 * Call AFTER recordUsage() so cumulative totals are up-to-date.
 */
function logRequest(opts: {
  tool: string;
  model: string;
  status: "success" | "error" | "truncated";
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens?: number;
    cost?: number;
  };
  filePath?: string;
  error?: string;
}): void {
  const promptTok = opts.usage?.prompt_tokens ?? 0;
  const completionTok = opts.usage?.completion_tokens ?? 0;
  const totalTok = opts.usage?.total_tokens ?? promptTok + completionTok;
  const cost = opts.usage?.cost ?? 0;

  writeLogEntry({
    timestamp: new Date().toISOString(),
    tool: opts.tool,
    model: opts.model,
    status: opts.status,
    prompt_tokens: promptTok,
    completion_tokens: completionTok,
    total_tokens: totalTok,
    cost,
    cumulative_tokens: session.promptTokens + session.completionTokens,
    cumulative_cost: session.totalCost,
    file_path: opts.filePath,
    error: opts.error,
  });
}

function recordUsage(usage?: {
  prompt_tokens: number;
  completion_tokens: number;
  cost?: number;
}) {
  session.calls++;
  if (usage) {
    session.promptTokens += usage.prompt_tokens;
    session.completionTokens += usage.completion_tokens;
    // OpenRouter returns cost in USD in the usage object
    if (typeof usage.cost === "number") {
      session.totalCost += usage.cost;
    }
  }
  // Update the live stats file for the statusline to read
  writeStatsFile();
}

function apiHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (currentBackend.apiKey)
    h["Authorization"] = `Bearer ${currentBackend.apiKey}`;
  // OpenRouter requires HTTP-Referer and X-Title headers for ranking/attribution
  if (currentBackend.type === "openrouter") {
    if (activeResolved?.httpReferer)
      h["HTTP-Referer"] = activeResolved.httpReferer;
    if (activeResolved?.appName) h["X-Title"] = activeResolved.appName;
  }
  return h;
}

// ── Connection setup (universal) ─────────────────────────────────────

interface ConnectionSetup {
  url: string; // Full endpoint URL
  headers: Record<string, string>; // Auth + content-type headers
  model: string; // Resolved model ID
  isNative: boolean; // true = LM Studio native /api/v1/chat
  timeout: number; // SOFT_TIMEOUT_MS
}

/**
 * Universal connection resolver — single source of truth for endpoint URL,
 * auth headers, model, and API format. Called once per LLM request; the
 * result is passed down to the actual HTTP call.
 *
 * For lmstudio provider: always uses native API, fails hard on auth/connection errors.
 * For openrouter/ollama: uses OpenAI-compat /v1/chat/completions.
 */
async function resolveConnection(options?: {
  model?: string;
}): Promise<ConnectionSetup> {
  const model = options?.model || currentBackend.model;
  const headers = apiHeaders();
  const timeout = SOFT_TIMEOUT_MS;

  // Detect LM Studio native API (only for local backends)
  if (currentBackend.type === "local" && (await detectLMStudio())) {
    return {
      url: `${currentBackend.baseUrl}/api/v1/chat`,
      headers,
      model,
      isNative: true,
      timeout,
    };
  }

  return {
    url: `${currentBackend.baseUrl}/v1/chat/completions`,
    headers,
    model,
    isNative: false,
    timeout,
  };
}

/**
 * Fetch with single 429 retry. Parses Retry-After header (seconds or HTTP-date)
 * and waits before retrying, capped so total elapsed stays within the timeout.
 */
/**
 * Fetch with exponential backoff retry for transient errors.
 *
 * Retries on:
 *   429 (rate limited) — respects Retry-After header as minimum delay
 *   500, 502, 503, 504 — transient server errors
 *
 * Backoff strategy:
 *   - Base delay: 1s, doubles each attempt (1s → 2s → 4s → 8s → 16s)
 *   - Jitter: ±25% randomization to prevent thundering herd across processes
 *   - Retry-After floor: if server says "wait 10s", delay is max(backoff, 10s)
 *   - Max 5 retries (6 total attempts), capped by remaining time budget
 *   - Gives up immediately if remaining time < 2s (not enough for a useful retry)
 */
const RETRY_MAX_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 1000;
const RETRY_MAX_DELAY_MS = 30_000;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

async function fetchWithRetry429(
  url: string,
  fetchOpts: RequestInit,
  timeout: number,
  startTime: number,
): Promise<Response> {
  let lastRes: Response | undefined;

  for (let attempt = 0; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
    const elapsed = Date.now() - startTime;
    const remaining = timeout - elapsed;

    // Not enough time for a meaningful retry
    if (attempt > 0 && remaining < 2000) {
      break;
    }

    try {
      lastRes = await fetchWithTimeout(url, fetchOpts, Math.max(remaining, 1000));
    } catch (err) {
      // Network errors (ECONNRESET, ETIMEDOUT, etc.) are retryable
      if (attempt >= RETRY_MAX_ATTEMPTS) throw err;

      const backoff = computeBackoffMs(attempt, 0);
      const waitRemaining = timeout - (Date.now() - startTime);
      if (backoff > waitRemaining) throw err;

      process.stderr.write(
        `[llm-externalizer] Network error (attempt ${attempt + 1}/${RETRY_MAX_ATTEMPTS + 1}), ` +
        `retrying in ${(backoff / 1000).toFixed(1)}s: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      await new Promise((r) => setTimeout(r, backoff));
      continue;
    }

    // Success or non-retryable status — return immediately
    if (!RETRYABLE_STATUS.has(lastRes.status)) {
      return lastRes;
    }

    // Last attempt — return whatever we got
    if (attempt >= RETRY_MAX_ATTEMPTS) {
      break;
    }

    // Parse Retry-After header (seconds or HTTP-date) as minimum delay floor
    let retryAfterMs = 0;
    if (lastRes.status === 429) {
      const retryAfter = lastRes.headers.get("retry-after");
      if (retryAfter) {
        const parsed = Number(retryAfter);
        if (Number.isFinite(parsed)) {
          retryAfterMs = parsed * 1000;
        } else {
          const dateMs = Date.parse(retryAfter);
          if (!isNaN(dateMs)) {
            retryAfterMs = Math.max(0, dateMs - Date.now());
          }
        }
      }
    }

    const backoff = computeBackoffMs(attempt, retryAfterMs);
    const waitRemaining = timeout - (Date.now() - startTime);

    // Not enough time to wait + retry
    if (backoff > waitRemaining) {
      break;
    }

    process.stderr.write(
      `[llm-externalizer] HTTP ${lastRes.status} (attempt ${attempt + 1}/${RETRY_MAX_ATTEMPTS + 1}), ` +
      `retrying in ${(backoff / 1000).toFixed(1)}s\n`,
    );

    // Consume the error response body to free the connection
    await lastRes.text().catch(() => {});
    await new Promise((r) => setTimeout(r, backoff));
  }

  // All retries exhausted — return the last response so the caller gets the error
  if (lastRes) return lastRes;
  throw new Error("API request failed — all retries exhausted with no response");
}

/** Exponential backoff with jitter. retryAfterMs is a floor from the server. */
function computeBackoffMs(attempt: number, retryAfterMs: number): number {
  // Exponential: 1s, 2s, 4s, 8s, 16s
  const exponential = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
  // Use the larger of exponential backoff or server-requested delay
  const base = Math.max(exponential, retryAfterMs);
  // Cap at max delay
  const capped = Math.min(base, RETRY_MAX_DELAY_MS);
  // Add ±25% jitter to prevent thundering herd across concurrent processes
  const jitter = capped * (0.75 + Math.random() * 0.5);
  return Math.round(jitter);
}

// ── OpenAI-compatible API helpers ────────────────────────────────────

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface StreamingResult {
  content: string;
  model: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cost?: number;
  };
  finishReason: string;
  truncated: boolean;
}

interface ModelInfo {
  id: string;
  context_length?: number;
  max_model_len?: number;
  owned_by?: string;
  [key: string]: unknown;
}

/**
 * Fetch with a connect timeout so Claude doesn't hang when the host is offline.
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number = CONNECT_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read from a stream with a per-chunk timeout.
 * Prevents hanging forever if the LLM stalls mid-generation.
 */
// ── LM Studio native API (/api/v1/chat) ──────────────────────────────
// LM Studio is the only local backend with MCP support, reasoning control,
// model load events, and prompt processing events via its native API.
// We auto-detect LM Studio by probing /api/v1/models on first request.

/**
 * Probe whether the local backend is LM Studio by hitting its native endpoint.
 * Caches the result on the backend config so we only probe once.
 */
async function detectLMStudio(): Promise<boolean> {
  if (currentBackend.type !== "local") return false;
  if (currentBackend.lmStudioDetected !== undefined)
    return currentBackend.isLMStudio ?? false;

  const isLMStudioProvider = activeResolved?.protocol === "lmstudio_api";

  try {
    const res = await fetchWithTimeout(
      `${currentBackend.baseUrl}/api/v1/models`,
      { headers: apiHeaders() },
    );
    // LM Studio's native /api/v1/models returns a JSON array of model objects
    if (res.ok) {
      currentBackend.isLMStudio = true;
      currentBackend.lmStudioDetected = true;
      process.stderr.write(
        "[llm-externalizer] Detected LM Studio native API\n",
      );
      return true;
    }
    // Auth failure on the native endpoint — if provider is explicitly lmstudio, fail hard
    if (res.status === 401 && isLMStudioProvider) {
      if (currentBackend.apiKey) {
        // Token was provided but LM Studio rejected it
        throw new Error(
          "LM Studio rejected the API token (401 Unauthorized).\n" +
            "The token was resolved from the environment but is not valid for this LM Studio instance.\n" +
            "Check: LM Studio > Developer > Security — regenerate the API key and update $LM_API_TOKEN.",
        );
      } else {
        // No token at all
        throw new Error(
          "LM Studio requires authentication but no API token was found.\n" +
            "Set the LM_API_TOKEN environment variable, or add api_token to the active profile in settings.yaml.\n" +
            "In LM Studio: Developer > Security > copy the API key.",
        );
      }
    }
  } catch (err) {
    // Re-throw auth errors — those are not "not LM Studio", they are config errors
    if (
      err instanceof Error &&
      err.message.includes("LM Studio requires authentication")
    )
      throw err;
    // If provider is explicitly lmstudio, don't silently fall back to OpenAI-compat
    if (isLMStudioProvider) {
      throw new Error(
        `LM Studio native API probe failed at ${currentBackend.baseUrl}/api/v1/models: ${err instanceof Error ? err.message : String(err)}\n` +
          "Ensure LM Studio is running and a model is loaded. The lmstudio provider requires the native API endpoint.",
        { cause: err },
      );
    }
    // Not LM Studio or endpoint not available — fall through (only for non-lmstudio providers)
  }
  currentBackend.isLMStudio = false;
  currentBackend.lmStudioDetected = true;
  return false;
}

/**
 * LM Studio native response shape from /api/v1/chat.
 */
interface LMStudioOutputEntry {
  type: "message" | "reasoning" | "tool_call" | "invalid_tool_call";
  content?: string;
  tool?: string;
  arguments?: Record<string, unknown>;
  output?: string;
  provider_info?: Record<string, unknown>;
}

interface LMStudioChatResponse {
  model_instance_id: string;
  output: LMStudioOutputEntry[];
  stats?: {
    input_tokens?: number;
    total_output_tokens?: number;
    reasoning_output_tokens?: number;
    tokens_per_second?: number;
    time_to_first_token_seconds?: number;
  };
  response_id?: string;
}

/**
 * Chat completion using LM Studio's native /api/v1/chat endpoint (non-streaming).
 * Provides MCP integration, reasoning control, and avoids streaming timeout issues
 * with reasoning models that have high time-to-first-token.
 */
async function chatCompletionNative(
  conn: ConnectionSetup,
  messages: ChatMessage[],
  options: {
    temperature?: number;
    maxTokens?: number;
    reasoning?: "off" | "low" | "medium" | "high" | "on";
    integrations?: Array<Record<string, unknown>>;
    onProgress?: ProgressFn;
  } = {},
): Promise<StreamingResult> {
  // Convert ChatMessage[] to LM Studio input format:
  // system_prompt is extracted from system messages, input is the user message(s)
  const systemMessages = messages.filter((m) => m.role === "system");
  const nonSystemMessages = messages.filter((m) => m.role !== "system");

  // Build multi-turn input as array of content parts
  const inputParts: Array<{ type: string; content: string }> = [];
  for (const msg of nonSystemMessages) {
    inputParts.push({
      type: msg.role === "user" ? "text" : msg.role,
      content: msg.content,
    });
  }

  const body: Record<string, unknown> = {
    model: conn.model,
    // If single user message, pass as string; otherwise pass as array
    input:
      nonSystemMessages.length === 1
        ? nonSystemMessages[0].content
        : inputParts,
    temperature: options.temperature ?? DEFAULT_TEMPERATURE,
    stream: false,
    store: false, // We don't need stateful chat
  };

  // Never send max_output_tokens — LM Studio defaults to model maximum.
  // Reasoning models use the budget for both thinking AND response, so setting
  // a limit often causes truncated or empty responses.

  if (systemMessages.length > 0) {
    body.system_prompt = systemMessages.map((m) => m.content).join("\n\n");
  }

  // Only send reasoning if explicitly set — not all models support it.
  // Models that don't will return error "does not support reasoning configuration".
  if (options.reasoning) {
    body.reasoning = options.reasoning;
  }

  if (options.integrations && options.integrations.length > 0) {
    body.integrations = options.integrations;
  }

  // Send initial progress
  if (options.onProgress) {
    options.onProgress(5, 100, "Sending request to LM Studio…");
  }

  // Periodic progress while waiting for response
  const startTime = Date.now();
  let progressTimer: ReturnType<typeof setInterval> | undefined;
  if (options.onProgress) {
    const pg = options.onProgress;
    progressTimer = setInterval(() => {
      const pct = Math.min(
        90,
        Math.round(((Date.now() - startTime) / conn.timeout) * 100),
      );
      pg(pct, 100, "Waiting for LM Studio response…");
    }, 10_000);
  }

  try {
    let res = await fetchWithTimeout(
      conn.url,
      { method: "POST", headers: conn.headers, body: JSON.stringify(body) },
      conn.timeout,
    );

    // If the reasoning parameter is rejected, retry without it
    if (!res.ok && body.reasoning) {
      const errText = await res.text().catch(() => "");
      if (errText.includes("does not support reasoning")) {
        process.stderr.write(
          "[llm-externalizer] Model does not support reasoning parameter, retrying without it\n",
        );
        delete body.reasoning;
        res = await fetchWithTimeout(
          conn.url,
          { method: "POST", headers: conn.headers, body: JSON.stringify(body) },
          conn.timeout,
        );
      } else {
        throw new Error(`LM Studio API error ${res.status}: ${errText}`);
      }
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`LM Studio API error ${res.status}: ${text}`);
    }

    const data = (await res.json()) as LMStudioChatResponse;

    // Extract message content from output array
    const messageContent = data.output
      .filter((o) => o.type === "message" && o.content)
      .map((o) => o.content!)
      .join("");

    // Map LM Studio stats to our StreamingResult usage format
    const usage = data.stats
      ? {
          prompt_tokens: data.stats.input_tokens ?? 0,
          completion_tokens: data.stats.total_output_tokens ?? 0,
          total_tokens:
            (data.stats.input_tokens ?? 0) +
            (data.stats.total_output_tokens ?? 0),
        }
      : undefined;

    return {
      content: messageContent,
      model: data.model_instance_id || conn.model,
      usage,
      finishReason: "stop",
      truncated: false,
    };
  } finally {
    if (progressTimer) clearInterval(progressTimer);
  }
}

// ── MCP progress notifications ───────────────────────────────────────
// Sending progress notifications keeps the client connection alive during
// long-running LLM calls, preventing the default 60s MCP request timeout.
// The progressToken comes from request.params._meta?.progressToken.

type ProgressFn = (progress: number, total: number, message?: string) => void;

function makeProgressFn(
  progressToken: string | number | undefined,
): ProgressFn | undefined {
  if (progressToken === undefined) return undefined;
  return (progress: number, total: number, message?: string) => {
    // Fire-and-forget — progress notifications must never block or throw
    server
      .notification({
        method: "notifications/progress" as const,
        params: {
          progressToken,
          progress,
          total,
          ...(message ? { message } : {}),
        },
      })
      .catch(() => {});
  };
}

// ── Non-streaming text completion ────────────────────────────────────
// All LLM requests use this. stream=false, single JSON response.
// Batch-level heartbeat in rateLimitedParallel keeps MCP connection alive.

async function chatCompletionSimple(
  messages: ChatMessage[],
  options: {
    temperature?: number;
    maxTokens?: number;
    model?: string;
    onProgress?: ProgressFn;
  } = {},
): Promise<StreamingResult> {
  const conn = await resolveConnection(options);

  // LM Studio native API — delegate to native handler (different request format)
  if (conn.isNative) {
    return chatCompletionNative(conn, messages, options);
  }

  const baseBody: Record<string, unknown> = {
    messages,
    temperature: options.temperature ?? DEFAULT_TEMPERATURE,
    max_tokens: options.maxTokens ?? resolveDefaultMaxTokens(),
    stream: false,
  };
  if (conn.model) baseBody.model = conn.model;

  // Reasoning ladder: OpenRouter backend tries xhigh → high → none.
  // Other backends (ollama/vllm/llamacpp OpenAI-compat) get [null] — no reasoning field.
  const reasoningLadder =
    currentBackend.type === "openrouter"
      ? reasoningLadderForModel(conn.model || "")
      : [null];

  // Dynamically look up which request-body fields this model accepts.
  // The result is a Set<string> or null (unknown — don't filter). Queried
  // from /v1/models/{id}/endpoints and cached per model for 1 hour. This
  // is forward-compatible: any new model's unsupported fields are dropped
  // automatically instead of causing 400 errors.
  const supportedParams = await getModelSupportedParams(conn.model || "");

  const startTime = Date.now();

  // Heartbeat: send progress every 30s while waiting for the response.
  // Prevents MCP inactivity timeout on long-running requests (reasoning models).
  const heartbeat = options.onProgress
    ? setInterval(() => {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        options.onProgress!(50, 100, `Processing… ${elapsed}s elapsed`);
      }, HEARTBEAT_INTERVAL_MS)
    : null;

  try {
    let lastError: Error | null = null;

    for (const reasoning of reasoningLadder) {
      let body: Record<string, unknown> = { ...baseBody };
      if (reasoning) body.reasoning = reasoning;
      // Apply per-model overrides before filtering so the filter has
      // the full picture of what we intend to send.
      body = applyModelOverrides(body, conn.model);
      // Filter to only fields this model supports. Does nothing for
      // non-OpenRouter backends and for models with unknown metadata.
      body = filterBodyForSupportedParams(body, supportedParams);

      const res = await fetchWithRetry429(
        conn.url,
        {
          method: "POST",
          headers: conn.headers,
          body: JSON.stringify(body),
        },
        conn.timeout,
        startTime,
      );

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        if (reasoning && isReasoningRejectionError(res.status, text)) {
          const effort = (reasoning as { effort?: string }).effort;
          process.stderr.write(
            `[llm-externalizer] Model ${conn.model} rejected reasoning.effort=${effort} — downgrading\n`,
          );
          recordReasoningRejection(conn.model || "", reasoning);
          lastError = new Error(
            `API error ${res.status} (${currentBackend.type}): ${text}`,
          );
          continue;
        }
        throw new Error(
          `API error ${res.status} (${currentBackend.type}): ${text}`,
        );
      }

      const data = (await res.json()) as {
        choices?: Array<{
          message?: { content?: string };
          finish_reason?: string;
        }>;
        model?: string;
        usage?: {
          prompt_tokens: number;
          completion_tokens: number;
          total_tokens: number;
          cost?: number;
        };
      };

      const content = data.choices?.[0]?.message?.content ?? "";
      const model = data.model ?? options.model ?? "unknown";
      const finishReason = data.choices?.[0]?.finish_reason ?? "";
      const usage = data.usage;

      return { content, model, usage, finishReason, truncated: false };
    }

    throw lastError ?? new Error("Reasoning ladder exhausted with no response");
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}

// ── Non-streaming JSON completion ────────────────────────────────────
// Used when we need structured output (e.g. check_imports path extraction).
// Non-streaming allows response_format + response-healing plugin.

interface JSONCompletionResult {
  parsed: Record<string, unknown>;
  model: string;
  usage?: StreamingResult["usage"];
  finishReason: string;
}

// JSON schema for check_imports — extracts file paths from source code
const EXTRACT_PATHS_SCHEMA = {
  name: "extract_paths_response",
  strict: true,
  schema: {
    type: "object",
    properties: {
      paths: {
        type: "array",
        items: { type: "string" },
        description:
          "All file paths, imports, and module references found in the source.",
      },
    },
    required: ["paths"],
    additionalProperties: false,
  },
} as const;

/**
 * Non-streaming chat completion with JSON structured output.
 * Uses response_format + response-healing plugin (OpenRouter only).
 * Falls back to plain text for local backends.
 */
async function chatCompletionJSON(
  messages: ChatMessage[],
  options: {
    temperature?: number;
    maxTokens?: number;
    model?: string;
    jsonSchema?: {
      name: string;
      strict: boolean;
      schema: Record<string, unknown>;
    };
    onProgress?: ProgressFn;
  } = {},
): Promise<JSONCompletionResult> {
  const conn = await resolveConnection(options);

  // Route through LM Studio native API (no json_schema support,
  // but the prompt-based JSON extraction works well with local models).
  if (conn.isNative) {
    const nativeResult = await chatCompletionNative(conn, messages, options);
    const rawContent = nativeResult.content;
    if (!rawContent.trim()) {
      throw new Error(
        "LLM returned empty response (expected JSON). Model may not support structured output.",
      );
    }
    let parsed: Record<string, unknown>;
    try {
      // Strip markdown fences if present
      const cleaned = rawContent
        .replace(/^```(?:json)?\s*\n?/i, "")
        .replace(/\n?```\s*$/i, "")
        .trim();
      parsed = JSON.parse(cleaned);
    } catch {
      throw new Error(
        `LLM returned non-JSON response: ${rawContent.substring(0, 200)}`,
      );
    }
    return {
      parsed,
      model: nativeResult.model,
      usage: nativeResult.usage,
      finishReason: nativeResult.finishReason,
    };
  }

  const baseBody: Record<string, unknown> = {
    messages,
    temperature: options.temperature ?? DEFAULT_TEMPERATURE,
    max_tokens: options.maxTokens ?? resolveDefaultMaxTokens(),
    stream: false, // Non-streaming for structured output
  };

  if (conn.model) baseBody.model = conn.model;

  // Structured output: json_schema + response-healing (OpenRouter only)
  if (options.jsonSchema && currentBackend.type === "openrouter") {
    baseBody.response_format = {
      type: "json_schema",
      json_schema: options.jsonSchema,
    };
    // Response-healing plugin auto-fixes malformed JSON from weaker models
    baseBody.plugins = [{ id: "response-healing" }];
  }

  // Reasoning ladder (OpenRouter only): xhigh → high → none.
  // Reasoning is enforced for structured-output calls too. The ladder
  // sends only schema-valid fields (effort + summary). Providers that
  // reject reasoning + json_schema return 400 and the ladder downgrades
  // automatically.
  const reasoningLadder =
    currentBackend.type === "openrouter"
      ? reasoningLadderForModel(conn.model || "")
      : [null];

  // Dynamic per-model parameter filter — drops request-body fields the
  // model doesn't list in its supported_parameters. Cached per model.
  const supportedParams = await getModelSupportedParams(conn.model || "");

  // Periodic progress keepalive while waiting for non-streaming response
  const jsonStartTime = Date.now();
  let progressTimer: ReturnType<typeof setInterval> | undefined;
  if (options.onProgress) {
    const pg = options.onProgress;
    pg(5, 100, "Sending request to LLM…");
    progressTimer = setInterval(() => {
      const pct = Math.min(
        90,
        Math.round(((Date.now() - jsonStartTime) / conn.timeout) * 100),
      );
      pg(pct, 100, "Waiting for LLM response…");
    }, 10_000);
  }

  try {
    let lastLadderError: Error | null = null;
    let rawContent = "";
    let model = "";
    let usage: StreamingResult["usage"] | undefined;
    let finishReason = "";
    let gotResponse = false;

    for (const reasoning of reasoningLadder) {
      let body: Record<string, unknown> = { ...baseBody };
      if (reasoning) body.reasoning = reasoning;
      // Apply per-model overrides last so they win over baseBody defaults.
      body = applyModelOverrides(body, conn.model);
      // Filter to only fields this model supports (Nemotron drops
      // frequency_penalty etc., other models may drop reasoning).
      body = filterBodyForSupportedParams(body, supportedParams);

      const res = await fetchWithRetry429(
        conn.url,
        {
          method: "POST",
          headers: conn.headers,
          body: JSON.stringify(body),
        },
        conn.timeout,
        jsonStartTime,
      );

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        if (reasoning && isReasoningRejectionError(res.status, text)) {
          const effort = (reasoning as { effort?: string }).effort;
          process.stderr.write(
            `[llm-externalizer] Model ${conn.model} rejected reasoning.effort=${effort} (JSON mode) — downgrading\n`,
          );
          recordReasoningRejection(conn.model || "", reasoning);
          lastLadderError = new Error(
            `API error ${res.status} (${currentBackend.type}): ${text}`,
          );
          continue;
        }
        throw new Error(
          `API error ${res.status} (${currentBackend.type}): ${text}`,
        );
      }

      const data = (await res.json()) as {
        choices?: Array<{
          message?: { content?: string };
          finish_reason?: string;
        }>;
        model?: string;
        usage?: StreamingResult["usage"];
      };

      rawContent = data.choices?.[0]?.message?.content ?? "";
      model = data.model ?? conn.model ?? "";
      usage = data.usage;
      finishReason = data.choices?.[0]?.finish_reason ?? "";
      gotResponse = true;
      break;
    }

    if (!gotResponse) {
      throw lastLadderError ?? new Error("Reasoning ladder exhausted with no response");
    }

    // Parse the JSON response — guard against empty/whitespace-only content
    if (!rawContent.trim()) {
      throw new Error(
        "LLM returned empty response (expected JSON). Model may not support structured output.",
      );
    }
    let parsed: Record<string, unknown>;
    try {
      // Strip markdown fences if present (matches chatCompletionNative branch above).
      // Even with response_format: json_schema some providers/models wrap JSON in
      // ```json ... ``` fences, which makes JSON.parse throw.
      const cleaned = rawContent
        .replace(/^```(?:json)?\s*\n?/i, "")
        .replace(/\n?```\s*$/i, "")
        .trim();
      parsed = JSON.parse(cleaned) as Record<string, unknown>;
    } catch (e) {
      // LLM may wrap JSON in code fences, include trailing text, or produce malformed JSON
      throw new Error(
        `LLM returned malformed JSON: ${e instanceof Error ? e.message : String(e)}. Raw (first 200 chars): ${rawContent.slice(0, 200)}`,
        { cause: e },
      );
    }

    return { parsed, model, usage, finishReason };
  } finally {
    if (progressTimer) clearInterval(progressTimer);
  }
}

async function listModelsRaw(): Promise<ModelInfo[]> {
  const res = await fetchWithTimeout(`${currentBackend.baseUrl}/v1/models`, {
    headers: apiHeaders(),
  });
  if (!res.ok) throw new Error(`Failed to list models: ${res.status}`);
  const data = (await res.json()) as { data: ModelInfo[] };
  return data.data;
}

function getContextLength(model: ModelInfo): number {
  // LM Studio uses context_length, vLLM uses max_model_len, fall back to env/100k
  return model.context_length ?? model.max_model_len ?? FALLBACK_CONTEXT_LENGTH;
}

/**
 * Record usage, log the request, and return a minimal footer.
 * Token/cost details are NOT sent to the caller — they go to the
 * session log file and the live stats file for the statusline instead.
 */
function formatFooter(
  resp: StreamingResult,
  toolName: string,
  filePath?: string,
): string {
  recordUsage(resp.usage);

  // Log the request to the session log file
  logRequest({
    tool: toolName,
    model: resp.model,
    status: resp.truncated ? "truncated" : "success",
    usage: resp.usage,
    filePath,
  });

  // Body already carries a specific label for non-success finish reasons
  // (TRUNCATED / EMPTY RESPONSE / BLOCKED / UPSTREAM ERROR / INCOMPLETE) —
  // don't append a generic "partial result due to timeout" footer that
  // contradicts the actual cause. Only fall back to the generic footer
  // when the body is missing a label (e.g., older code paths or a real
  // network timeout surfaced directly by fetch).
  if (resp.truncated) {
    const hasLabel = /\*\*(TRUNCATED|EMPTY RESPONSE|BLOCKED|UPSTREAM ERROR|INCOMPLETE)\*\*/i.test(
      resp.content,
    );
    if (!hasLabel) {
      return "\n\n---\n⚠ Request did not complete cleanly (partial result or timeout).";
    }
  }
  return "";
}

// ── Response file output ────────────────────────────────────────────
// LLM responses are saved to timestamped .md files in reports_dev/llm_externalizer/
// so the caller's context is never flooded with the response text.
// The output dir defaults to process.cwd()/reports_dev/llm_externalizer but can be
// overridden with LLM_OUTPUT_DIR env var or per-tool output_dir parameter.

const OUTPUT_DIR =
  process.env.LLM_OUTPUT_DIR || join(process.cwd(), "reports_dev", "llm_externalizer");

// Canonical report-filename timestamp per the agent-reports-location rule:
//   %Y%m%d_%H%M%S%z — local time, GMT offset appended as compact ±HHMM (no colon).
// Example: 20260421_183012+0200. Never UTC, never ±HH:MM.
function canonicalTimestamp(date: Date = new Date()): string {
  const pad = (n: number): string => String(Math.abs(n)).padStart(2, "0");
  const Y = date.getFullYear();
  const M = pad(date.getMonth() + 1);
  const D = pad(date.getDate());
  const h = pad(date.getHours());
  const m = pad(date.getMinutes());
  const s = pad(date.getSeconds());
  // getTimezoneOffset returns minutes WEST of UTC (Rome summer = -120), so
  // the GMT offset is its negation. East-of-UTC offsets are positive.
  const offMinutes = -date.getTimezoneOffset();
  const sign = offMinutes >= 0 ? "+" : "-";
  const offH = pad(Math.floor(Math.abs(offMinutes) / 60));
  const offM = pad(Math.abs(offMinutes) % 60);
  return `${Y}${M}${D}_${h}${m}${s}${sign}${offH}${offM}`;
}

function saveResponse(
  toolName: string,
  responseText: string,
  meta: { model: string; task?: string; inputFile?: string; groupId?: string },
  overrideFilename?: string,
  outputDir?: string,
): string {
  const dir = outputDir || OUTPUT_DIR;
  mkdirSync(dir, { recursive: true });

  const now = new Date();
  const ts = canonicalTimestamp(now);
  const shortId = randomUUID().slice(0, 6);
  // Slug format: <tool>[-group-<id>][-<src>]-<shortId> — everything after the ts is
  // joined by hyphens so the filename matches the rule's <ts±tz>-<slug>.<ext> shape.
  const srcPart = meta.inputFile ? `-${sanitizeFilename(meta.inputFile).replace(/\.md$/, "")}` : "";
  const groupPart = meta.groupId ? `-group-${meta.groupId.replace(/[^a-zA-Z0-9_-]/g, "_")}` : "";
  const filename = overrideFilename || `${ts}-${toolName}${groupPart}${srcPart}-${shortId}.md`;
  const filepath = join(dir, filename);

  const lines: string[] = [
    "# LLM Externalizer Response",
    "",
    `- **Tool**: \`${toolName}\``,
    `- **Model**: \`${meta.model}\``,
    `- **Timestamp**: ${now.toISOString()}`,
  ];
  if (meta.groupId) lines.push(`- **Group**: \`${meta.groupId}\``);
  if (meta.inputFile) lines.push(`- **Input file**: \`${meta.inputFile}\``);
  if (meta.task) lines.push(`- **Task**: ${meta.task}`);
  lines.push("", "---", "", responseText);

  // Atomic write: write to temp file, then rename — prevents partial/corrupt files on crash
  const tmpPath = filepath + ".tmp";
  try {
    writeFileSync(tmpPath, lines.join("\n"), "utf-8");
    renameSync(tmpPath, filepath);
  } catch (err) {
    // Clean up orphaned temp file on failure (disk full, permissions, etc.)
    try {
      unlinkSync(tmpPath);
    } catch {
      /* temp file may not exist */
    }
    throw new Error(
      `Failed to save response to ${filepath}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  return filepath;
}

// ── Error classification ────────────────────────────────────────────
// Distinguishes unrecoverable errors (abort batch) from recoverable ones (retry).

function classifyError(error: unknown): {
  unrecoverable: boolean;
  serviceLevel: boolean;
  reason: string;
} {
  const msg = error instanceof Error ? error.message : String(error);
  // Service-level errors — abort the entire batch (retrying won't help)
  // Use specific "API error NNN" pattern to avoid false positives from file paths containing digits
  if (/API error 401\b/.test(msg))
    return {
      unrecoverable: true,
      serviceLevel: true,
      reason: "Authentication failed (invalid API key)",
    };
  if (/API error 402\b/.test(msg)) {
    // Credit exhausted. Flag the session so all subsequent calls go
    // through the free model automatically. This specific call is also
    // retried at the chatCompletionWithRetry layer with FREE_MODEL_ID,
    // so we report it as recoverable here — the caller does not need
    // to abort the batch. The 402 is still surfaced to stderr by the
    // caller, and the free-mode fallback is logged separately.
    creditExhausted = true;
    invalidateBalanceCache();
    return {
      unrecoverable: false,
      serviceLevel: false,
      reason: "Payment required (credit exhausted on OpenRouter) — switching to free model",
    };
  }
  if (/API error 403\b/.test(msg))
    return {
      unrecoverable: true,
      serviceLevel: true,
      reason: "Access forbidden",
    };
  // File-level errors — unrecoverable for this file, but should NOT abort the batch
  if (msg.includes("File not found") || msg.includes("ENOENT"))
    return { unrecoverable: true, serviceLevel: false, reason: msg };
  if (msg.includes("Git branch changed"))
    return { unrecoverable: true, serviceLevel: true, reason: msg };
  if (msg.includes("currently being processed"))
    return { unrecoverable: false, serviceLevel: false, reason: msg };
  // 429 rate limit — signal AIMD to halve RPS
  if (/API error 429\b/.test(msg) || /rate.?limit/i.test(msg)) {
    if (adaptiveRateLimiter) adaptiveRateLimiter.onRateLimit();
    return { unrecoverable: false, serviceLevel: false, reason: msg };
  }
  // Everything else is recoverable (timeouts, 5xx, malformed responses)
  return { unrecoverable: false, serviceLevel: false, reason: msg };
}

// ── Adaptive rate limiter (AIMD) ─────────────────────────────────────
// Token-bucket rate limiter with Additive Increase / Multiplicative Decrease:
//   - On 429 (rate limit hit): halve RPS immediately
//   - On success streak (10 consecutive): increase RPS by 1 (up to initial max)
// This is a module-level singleton so ALL tool calls share the same state.
// The rate limiter is auto-created on first use with the detected RPS.

class AdaptiveRateLimiter {
  private tokens: number;
  private lastRefill: number;
  private currentRps: number;
  private initialRps: number;
  private readonly minRps: number = 1;
  private refillPerMs: number;
  private consecutiveSuccesses: number = 0;

  constructor(rps: number) {
    this.initialRps = Math.max(1, rps);
    this.currentRps = this.initialRps;
    this.tokens = this.currentRps;
    this.refillPerMs = this.currentRps / 1000;
    this.lastRefill = Date.now();
  }

  get rps(): number {
    return this.currentRps;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed > 0) {
      this.tokens = Math.min(this.currentRps, this.tokens + elapsed * this.refillPerMs);
      this.lastRefill = now;
    }
  }

  private updateRate(newRps: number): void {
    this.currentRps = Math.max(this.minRps, Math.min(this.initialRps, newRps));
    this.refillPerMs = this.currentRps / 1000;
    // Don't reset tokens — let existing tokens drain naturally
  }

  /** Wait until a token is available, then consume it. */
  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    const waitMs = Math.ceil((1 - this.tokens) / this.refillPerMs);
    await new Promise((r) => setTimeout(r, Math.max(1, waitMs)));
    this.refill();
    this.tokens = Math.max(0, this.tokens - 1);
  }

  /** Call after a successful request — additive increase */
  onSuccess(): void {
    this.consecutiveSuccesses++;
    if (this.consecutiveSuccesses >= 10 && this.currentRps < this.initialRps) {
      this.updateRate(this.currentRps + 1);
      this.consecutiveSuccesses = 0;
      process.stderr.write(`[llm-externalizer] AIMD: RPS increased to ${this.currentRps}\n`);
    }
  }

  /** Call after a 429 rate-limit error — multiplicative decrease */
  onRateLimit(): void {
    this.consecutiveSuccesses = 0;
    const newRps = Math.floor(this.currentRps / 2);
    if (newRps !== this.currentRps) {
      this.updateRate(newRps);
      process.stderr.write(`[llm-externalizer] AIMD: 429 detected, RPS halved to ${this.currentRps}\n`);
    }
  }

  /** Reset to initial RPS (e.g., after profile switch) */
  reset(newInitialRps?: number): void {
    if (newInitialRps !== undefined) {
      this.initialRps = Math.max(1, newInitialRps);
    }
    this.currentRps = this.initialRps;
    this.refillPerMs = this.currentRps / 1000;
    this.tokens = this.currentRps;
    this.consecutiveSuccesses = 0;
    this.lastRefill = Date.now();
  }
}

// Module-level singleton — shared across all tool calls
let adaptiveRateLimiter: AdaptiveRateLimiter | null = null;

function getAdaptiveRateLimiter(rps: number): AdaptiveRateLimiter {
  if (!adaptiveRateLimiter || adaptiveRateLimiter.rps !== rps) {
    adaptiveRateLimiter = new AdaptiveRateLimiter(rps);
  }
  return adaptiveRateLimiter;
}

// ── Rate-limited parallel executor ───────────────────────────────────
// Dispatches tasks respecting two independent limits:
//   1. RPS (rate): max N new tasks started per second (adaptive token bucket)
//   2. maxInFlight: max N tasks running simultaneously (safety cap)
// Workers grab the next task, wait for a rate-limit token, then execute.
// Results are returned in original order.
//
// No wall-clock deadline: Claude Code's MCP timeout is an INACTIVITY timeout
// (no progress for 1800s), not a hard deadline. As long as progress notifications
// keep flowing, the tool call can run indefinitely. A heartbeat timer sends
// progress every 30s to keep the connection alive even during slow LLM calls.

const DEFAULT_MAX_IN_FLIGHT = 200;
const HEARTBEAT_INTERVAL_MS = 30_000; // 30s — well under 1800s inactivity timeout

async function rateLimitedParallel<T>(
  tasks: (() => Promise<T>)[],
  rps: number,
  maxInFlight: number = DEFAULT_MAX_IN_FLIGHT,
  onProgress?: ProgressFn,
): Promise<T[]> {
  if (tasks.length === 0) return [];
  const results: T[] = new Array(tasks.length);
  const limiter = getAdaptiveRateLimiter(rps);
  let nextIndex = 0;
  let completedCount = 0;

  // Heartbeat: send progress notifications every 30s to prevent inactivity timeout
  const heartbeat = onProgress
    ? setInterval(() => {
        onProgress(completedCount, tasks.length, `Processing: ${completedCount}/${tasks.length} done (${limiter.rps} RPS)`);
      }, HEARTBEAT_INTERVAL_MS)
    : null;

  try {
    async function worker() {
      while (true) {
        const i = nextIndex;
        if (i >= tasks.length) return;
        nextIndex++;
        await limiter.acquire();
        results[i] = await tasks[i]();
        completedCount++;
        // Notify on each completion too (supplements heartbeat)
        if (onProgress) {
          onProgress(completedCount, tasks.length, `Done: ${completedCount}/${tasks.length}`);
        }
      }
    }

    const workerCount = Math.min(Math.max(1, maxInFlight), tasks.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
  return results;
}


// ── Batch helpers ───────────────────────────────────────────────────

interface FileProcessResult {
  filePath: string;
  success: boolean;
  reportPath?: string;
  backupPath?: string;
  error?: string;
  noChange?: boolean;
}

function sanitizeFilename(filePath: string): string {
  const base = basename(filePath);
  if (!base || base === "/") return "unknown";
  return base.replace(/[^a-zA-Z0-9._-]/g, "_");
}

// ── Robust per-file processing ─────────────────────────────────────
// Shared function that processes each file independently with:
// - Rate-limited parallel execution (via rateLimitedParallel)
// - Per-file retry with exponential backoff
// - Circuit breaker (abort after 3 consecutive failures)
// - Progress reporting
// Used by all content tools when answer_mode=0 and max_retries > 1.

interface RobustPerFileOpts {
  task: string;
  maxRetries: number;
  redact?: boolean;
  regexRedact?: RegexRedactOpts | null;
  onProgress?: ProgressFn;
  ensemble: boolean;
  budgetBytes: number;
  language?: string;
  toolName: string;
  batchId?: string;
  modelOverride?: string;
  outputDir?: string;
}

interface RobustPerFileResult {
  results: FileProcessResult[];
  succeeded: FileProcessResult[];
  failed: FileProcessResult[];
  skipped: FileProcessResult[];
  aborted: boolean;
  abortReason: string;
}

async function robustPerFileProcess(
  files: string[],
  opts: RobustPerFileOpts,
): Promise<RobustPerFileResult> {
  const batchId = opts.batchId || randomUUID();
  const rlConfig = await getRateLimitConfig();
  const recentOutcomes: boolean[] = [];
  let aborted = false;
  let abortReason = "";
  let totalAttempts = 0;
  const maxTotalAttempts = files.length * 2;
  const maxRetries = Math.max(1, opts.maxRetries);

  const tasks = files.map((filePath, idx) => async () => {
    if (aborted) {
      return { filePath, success: false, error: "Batch aborted" } as FileProcessResult;
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (++totalAttempts > maxTotalAttempts) {
        aborted = true;
        abortReason = `Global retry budget exhausted (${maxTotalAttempts} total attempts)`;
      }
      if (aborted) {
        return { filePath, success: false, error: "Batch aborted" } as FileProcessResult;
      }
      try {
        const result = await processFileCheck(filePath, opts.task, {
          language: opts.language,
          maxTokens: resolveDefaultMaxTokens(),
          batchId,
          fileIndex: idx,
          redact: opts.redact,
          regexRedact: opts.regexRedact,
          onProgress: opts.onProgress,
          ensemble: opts.ensemble,
          maxBytes: opts.budgetBytes,
          modelOverride: opts.modelOverride,
          outputDir: opts.outputDir,
        });
        recentOutcomes.push(result.success);
        if (result.success && adaptiveRateLimiter) adaptiveRateLimiter.onSuccess();
        if (opts.onProgress) {
          const completed = recentOutcomes.length;
          opts.onProgress(completed, files.length, `${opts.toolName}: ${completed}/${files.length} files done`);
        }
        return result;
      } catch (err) {
        const classified = classifyError(err);
        if (classified.unrecoverable) {
          if (classified.serviceLevel) {
            aborted = true;
            abortReason = `Unrecoverable service error on ${filePath}: ${classified.reason}`;
          }
          return { filePath, success: false, error: classified.reason } as FileProcessResult;
        }
        if (attempt < maxRetries) {
          const delayMs = Math.pow(3, attempt - 1) * 1000;
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
        recentOutcomes.push(false);
        if (recentOutcomes.length >= 3 && recentOutcomes.slice(-3).every((v) => !v)) {
          aborted = true;
          abortReason = `3 of the last 3 completions failed. Last error: ${classified.reason}`;
        }
        return { filePath, success: false, error: `Failed after ${maxRetries} retries: ${classified.reason}` } as FileProcessResult;
      }
    }
    return { filePath, success: false, error: "Unexpected retry loop exit" } as FileProcessResult;
  });

  const results = await rateLimitedParallel(tasks, rlConfig.rps, rlConfig.maxInFlight, opts.onProgress);
  const succeeded = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success && r.error !== "Batch aborted");
  const skipped = results.filter((r) => r.error === "Batch aborted");

  return { results, succeeded, failed, skipped, aborted, abortReason };
}

/** Normalize input_files_paths: accept string|string[]|undefined, return string[] with no undefined/null/empty entries. */
function normalizePaths(raw: string | string[] | undefined | null): string[] {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.filter((p): p is string => typeof p === "string" && p.length > 0);
}

// ── Folder path resolution ─────────────────────────────────────────
// Shared logic for resolving folder_path to file paths. Used by tools
// that accept folder_path as an alternative to input_files_paths.

interface FolderResolveResult {
  files: string[];
  error?: string;
}

function resolveFolderPath(
  folderPath: string,
  opts?: {
    extensions?: string[];
    excludeDirs?: string[];
    useGitignore?: boolean;
    recursive?: boolean;
    followSymlinks?: boolean;
    maxFiles?: number;
  },
): FolderResolveResult {
  // Path traversal protection — reject symlinks and normalize traversal sequences
  try {
    folderPath = sanitizeInputPath(folderPath);
  } catch (err) {
    return { files: [], error: `Invalid folder_path: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!existsSync(folderPath)) {
    return { files: [], error: `folder_path not found: ${folderPath}` };
  }
  if (!statSync(folderPath).isDirectory()) {
    return { files: [], error: `Not a directory: ${folderPath}` };
  }
  const files = walkDir(folderPath, {
    extensions: opts?.extensions,
    maxFiles: opts?.maxFiles ?? 2500,
    exclude: opts?.excludeDirs,
    useGitignore: opts?.useGitignore !== false,     // default true
    recursive: opts?.recursive !== false,            // default true
    followSymlinks: opts?.followSymlinks !== false,   // default true
  });
  if (files.length === 0) {
    const extInfo = opts?.extensions ? ` with extensions ${opts.extensions.join(", ")}` : "";
    return { files: [], error: `No matching files found in ${folderPath}${extInfo}` };
  }
  return { files };
}

// fileIndex disambiguates files with the same basename processed in the same second
function batchReportFilename(
  toolName: string,
  _batchId: string,
  filePath: string,
  _fileIndex: number,
): string {
  const ts = canonicalTimestamp();
  const shortId = randomUUID().slice(0, 6);
  const srcName = sanitizeFilename(filePath).replace(/\.md$/, "");
  // Canonical filename: <ts±tz>-<slug>.<ext>
  return `${ts}-${toolName}-${srcName}-${shortId}.md`;
}

// ── Global service health tracker ────────────────────────────────────
// Tracks consecutive failures across ALL requests to detect systemic issues
// (offline servers, broken connections, traffic overload). When the failure
// rate exceeds the threshold, pauses with exponential backoff before retrying.
// If all backoff attempts fail, aborts with a clear server-side error message.

const SERVICE_HEALTH = {
  consecutiveFailures: 0,
  lastSuccessAt: Date.now(),
  // Threshold: 5 consecutive failures across any requests → likely systemic
  failureThreshold: 5,
  // Backoff delays in ms: 60s, 120s, 350s, then give up
  backoffDelays: [60_000, 120_000, 350_000],
  backoffAttempt: 0,
  // If true, service is in backoff/cooldown mode
  inCooldown: false,
};

function recordServiceSuccess(): void {
  SERVICE_HEALTH.consecutiveFailures = 0;
  SERVICE_HEALTH.lastSuccessAt = Date.now();
  SERVICE_HEALTH.backoffAttempt = 0;
  SERVICE_HEALTH.inCooldown = false;
}

function recordServiceFailure(): void {
  SERVICE_HEALTH.consecutiveFailures++;
}

/** Returns true if we should abort (server-side issue confirmed). */
async function checkServiceHealthOrWait(): Promise<string | null> {
  if (SERVICE_HEALTH.consecutiveFailures < SERVICE_HEALTH.failureThreshold) {
    return null; // Not enough failures to trigger cooldown
  }

  const { backoffDelays, backoffAttempt } = SERVICE_HEALTH;
  if (backoffAttempt >= backoffDelays.length) {
    // Exhausted all backoff attempts — abort
    return (
      `SERVER ISSUE DETECTED: ${SERVICE_HEALTH.consecutiveFailures} consecutive failures. ` +
      `Last success was ${Math.round((Date.now() - SERVICE_HEALTH.lastSuccessAt) / 1000)}s ago. ` +
      `Tried waiting ${backoffDelays.map((d) => `${d / 1000}s`).join(", ")}. ` +
      `The issue appears to be server-side (offline, overloaded, or connection broken). ` +
      `Please retry later.`
    );
  }

  // Pause with backoff
  const delay = backoffDelays[backoffAttempt];
  SERVICE_HEALTH.inCooldown = true;
  process.stderr.write(
    `[llm-externalizer] ${SERVICE_HEALTH.consecutiveFailures} consecutive failures detected — ` +
    `waiting ${delay / 1000}s before retrying (backoff ${backoffAttempt + 1}/${backoffDelays.length})\n`,
  );
  await new Promise((r) => setTimeout(r, delay));
  SERVICE_HEALTH.backoffAttempt++;
  SERVICE_HEALTH.inCooldown = false;
  return null;
}

// ── Retry-on-truncation wrapper ──────────────────────────────────────
// Retries LLM calls when the response is truncated (finishReason !== "stop")
// or when a timeout caused partial output. Up to 3 retries for generic
// failures; up to 15 retries for silent empty responses on OpenRouter
// (the documented "no content generated" case — cold-start / scaling).
// Integrates with SERVICE_HEALTH to detect systemic server issues.
const MAX_TRUNCATION_RETRIES = 3;
const MAX_EMPTY_RESPONSE_RETRIES = 15;
// Fixed wait between empty-response retries. Empty responses aren't a
// rate-limit signal — they're documented cold-start / scaling behavior,
// so exponential backoff would be the wrong primitive (it would make us
// wait longer the more the provider needs a warm request). A small,
// constant delay just gives the provider a moment to finish whatever
// scaling it was doing before we try again.
const EMPTY_RESPONSE_RETRY_DELAY_MS = 2000;

async function chatCompletionWithRetry(
  messages: ChatMessage[],
  options: {
    temperature?: number;
    maxTokens?: number;
    model?: string;
    onProgress?: ProgressFn;
  },
): Promise<StreamingResult> {
  // Check global service health before attempting
  const healthAbort = await checkServiceHealthOrWait();
  if (healthAbort) {
    return {
      content: healthAbort,
      model: options.model || currentBackend.model,
      finishReason: "error",
      truncated: true,
    };
  }

  // Separate counters for generic failures and empty-response failures.
  // Empty responses get a much higher budget (with exponential backoff)
  // because OpenRouter's docs say this is the expected cold-start behavior
  // and a retry is the documented workaround.
  let genericAttempts = 0;
  let emptyAttempts = 0;

  while (true) {
    let resp: StreamingResult;
    try {
      // Non-streaming: single JSON response, no SSE parsing.
      // Batch-level heartbeat in rateLimitedParallel keeps MCP alive.
      resp = await chatCompletionSimple(messages, options);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);

      // 402 Payment Required — credit exhausted mid-flight. Flag the session
      // and immediately retry this call with the free model, no cooldown.
      // This is the promised "never fail, switch to free" behavior.
      if (
        /API error 402\b/.test(errMsg) &&
        currentBackend.type === "openrouter" &&
        options.model !== FREE_MODEL_ID
      ) {
        creditExhausted = true;
        invalidateBalanceCache();
        process.stderr.write(
          `[llm-externalizer] Credit exhausted (402) — retrying call with free model (${FREE_MODEL_ID})\n`,
        );
        try {
          return await chatCompletionSimple(messages, {
            ...options,
            model: FREE_MODEL_ID,
          });
        } catch (freeErr) {
          const freeMsg =
            freeErr instanceof Error ? freeErr.message : String(freeErr);
          process.stderr.write(
            `[llm-externalizer] Free-mode fallback also failed: ${freeMsg}\n`,
          );
          throw err;
        }
      }

      // Network/connection error — count as generic failure
      recordServiceFailure();
      genericAttempts++;
      if (genericAttempts <= MAX_TRUNCATION_RETRIES) {
        process.stderr.write(
          `[llm-externalizer] Request error: ${errMsg} — retrying (${genericAttempts}/${MAX_TRUNCATION_RETRIES})\n`,
        );
        const abort = await checkServiceHealthOrWait();
        if (abort) {
          return {
            content: abort,
            model: options.model || currentBackend.model,
            finishReason: "error",
            truncated: true,
          };
        }
        continue;
      }
      throw err; // Exhausted retries
    }

    // "stop" with non-empty content means normal completion — return immediately.
    // Note: some providers return finishReason="stop" with empty content for
    // problematic prompts. We treat that as an empty response (retryable).
    if (resp.finishReason === "stop" && !resp.truncated && resp.content.trim().length > 0) {
      recordServiceSuccess();
      return resp;
    }

    // "length" — output hit max_tokens limit, real truncation. Don't retry.
    if (resp.finishReason === "length") {
      recordServiceSuccess();
      resp.truncated = true;
      resp.content +=
        "\n\n---\n**TRUNCATED**: Response hit the output-token limit (finish_reason=length). The analysis above is cut off mid-generation.";
      process.stderr.write(
        `[llm-externalizer] finish_reason=length — output token limit hit\n`,
      );
      return resp;
    }

    // "content_filter" — provider blocked the response. Deterministic, don't retry.
    if (resp.finishReason === "content_filter") {
      recordServiceSuccess();
      resp.truncated = true;
      resp.content +=
        "\n\n---\n**BLOCKED**: The provider's content filter blocked this response (finish_reason=content_filter). No retry — the block is deterministic for this prompt.";
      process.stderr.write(
        `[llm-externalizer] finish_reason=content_filter — content filter blocked response\n`,
      );
      return resp;
    }

    // Everything else: empty content, finishReason="" (malformed/glitch),
    // finishReason="error", or unknown values.
    recordServiceFailure();
    const isEmpty = resp.content.trim().length === 0;
    const reasonLabel = resp.finishReason || "empty";

    // Pick the right retry budget based on failure type.
    //
    // Empty responses on OpenRouter are the documented "no content generated"
    // case (cold-start, scaling) — the recommended workaround is to retry.
    // We use MAX_EMPTY_RESPONSE_RETRIES (15) with exponential backoff so the
    // provider has time to warm up between attempts. Non-empty failures
    // (finishReason=error, unknown values) keep the stricter MAX_TRUNCATION_RETRIES
    // budget since they're less likely to be transient.
    const useEmptyBudget = isEmpty && currentBackend.type === "openrouter";
    if (useEmptyBudget) {
      emptyAttempts++;
    } else {
      genericAttempts++;
    }
    const limit = useEmptyBudget ? MAX_EMPTY_RESPONSE_RETRIES : MAX_TRUNCATION_RETRIES;
    const currentAttempt = useEmptyBudget ? emptyAttempts : genericAttempts;

    // Empty-response escalation: downgrade the reasoning cache so the next
    // attempt runs with less (or no) reasoning. xhigh -> high -> none.
    if (useEmptyBudget && options.model && currentAttempt <= limit) {
      const current = MODEL_REASONING_CACHE.get(options.model);
      if (current === undefined || current === "xhigh") {
        MODEL_REASONING_CACHE.set(options.model, "high");
        process.stderr.write(
          `[llm-externalizer] Empty response on ${options.model} — downgrading reasoning cache to high\n`,
        );
      } else if (current === "high") {
        MODEL_REASONING_CACHE.set(options.model, "none");
        process.stderr.write(
          `[llm-externalizer] Empty response on ${options.model} — disabling reasoning\n`,
        );
      }
    }

    if (currentAttempt <= limit) {
      process.stderr.write(
        `[llm-externalizer] ${useEmptyBudget ? "Empty" : "Invalid"} response (finish_reason=${reasonLabel}) — retrying (${currentAttempt}/${limit})\n`,
      );
      // Check systemic failure threshold (may block/abort)
      const abort = await checkServiceHealthOrWait();
      if (abort) {
        return {
          content: abort,
          model: resp.model,
          finishReason: "error",
          truncated: true,
        };
      }
      // Fixed short wait between empty-response retries. Empty responses
      // are cold-start / scaling signals, not rate-limit signals, so a
      // constant interval is the right shape (see EMPTY_RESPONSE_RETRY_DELAY_MS
      // comment above). Non-empty retries go through the service-health
      // cooldown and don't need an extra delay here.
      if (useEmptyBudget) {
        process.stderr.write(
          `[llm-externalizer] Waiting ${Math.round(EMPTY_RESPONSE_RETRY_DELAY_MS / 1000)}s before retry ${currentAttempt + 1}\n`,
        );
        await new Promise((r) => setTimeout(r, EMPTY_RESPONSE_RETRY_DELAY_MS));
      }
      continue;
    }

    // Exhausted retries — label by cause so the report makes sense.
    if (isEmpty && (resp.finishReason === "" || resp.finishReason === "stop")) {
      resp.content = `**EMPTY RESPONSE**: The provider returned no content after ${limit} retries (finish_reason=${reasonLabel}). This usually means a transient provider glitch or the model failed on this specific prompt. No partial output available.`;
    } else if (resp.finishReason === "error") {
      resp.content += `\n\n---\n**UPSTREAM ERROR**: The provider reported an error (finish_reason=error) after ${limit} retries. The partial output above may be incomplete.`;
    } else {
      resp.content += `\n\n---\n**INCOMPLETE**: Response did not finish cleanly after ${limit} retries (finish_reason=${reasonLabel}). The output above may be incomplete.`;
    }
    resp.truncated = true;
    process.stderr.write(
      `[llm-externalizer] Exhausted ${limit} retries (finish_reason=${reasonLabel}, empty=${isEmpty}) — returning with label\n`,
    );
    return resp;
  }
}

// ── Ensemble streaming helper ────────────────────────────────────────
// Runs the same prompt on multiple models in parallel, combines results.
// When ensemble=false or backend is local, falls through to single-model call.

async function ensembleStreaming(
  messages: ChatMessage[],
  options: {
    temperature?: number;
    maxTokens?: number;
    onProgress?: ProgressFn;
    modelOverride?: string; // skip ensemble, use this specific model
  },
  ensemble: boolean,
  fileLineCount?: number,
): Promise<StreamingResult> {
  // Model override: skip ensemble entirely, use the specified model
  if (options.modelOverride) {
    return chatCompletionWithRetry(messages, { ...options, model: options.modelOverride });
  }
  // Single-model path: ensemble off, not remote-ensemble, or no models configured
  const ensembleModels = getEnsembleModels();
  if (
    !ensemble ||
    currentBackend.type !== "openrouter" ||
    ensembleModels.length === 0
  ) {
    return chatCompletionWithRetry(messages, options);
  }

  // Filter models by file size limit
  const models = ensembleModels.filter(
    (m) => !fileLineCount || fileLineCount <= m.maxInputLines,
  );
  if (models.length === 0) {
    // File too large for all ensemble models — fall back to current model
    return chatCompletionWithRetry(messages, options);
  }

  // Single qualifying model — no need to combine
  if (models.length === 1) {
    return chatCompletionWithRetry(messages, {
      ...options,
      model: models[0].id,
      maxTokens: Math.min(
        options.maxTokens ?? models[0].maxOutput,
        models[0].maxOutput,
      ),
    });
  }

  // Run all qualifying models in parallel — wait for ALL to finish.
  // The MCP timeout is configured by the user on the Claude Code side.
  const results = await Promise.all(
    models.map(async (m) => {
      try {
        const resp = await chatCompletionWithRetry(messages, {
          ...options,
          model: m.id,
          maxTokens: Math.min(options.maxTokens ?? m.maxOutput, m.maxOutput),
        });
        return {
          model: m.id,
          content: resp.content,
          usage: resp.usage,
          truncated: resp.truncated,
          error: false,
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return {
          model: m.id,
          content: `ERROR: ${errMsg}`,
          usage: undefined,
          truncated: false,
          error: true,
        };
      }
    }),
  );

  // Separate successful from failed model responses
  const succeeded = results.filter((r) => !r.error);
  const failed = results.filter((r) => r.error);

  // ALL models failed — propagate error
  if (succeeded.length === 0) {
    const errorSummary = failed.map((r) => `${r.model}: ${r.content}`).join("; ");
    throw new Error(`All ensemble models failed: ${errorSummary}`);
  }

  // Some models failed — log warning, continue with successful ones
  if (failed.length > 0) {
    for (const f of failed) {
      process.stderr.write(
        `[llm-externalizer] Ensemble model unavailable: ${f.model} — ${f.content}. Continuing with ${succeeded.length} model(s).\n`,
      );
    }
  }

  // Combine only successful model outputs
  const parts = succeeded.map((r) => `## Model: ${r.model}\n\n${r.content}`);
  if (failed.length > 0) {
    parts.push(`## Unavailable models\n\n${failed.map((r) => `- **${r.model}**: ${r.content}`).join("\n")}`);
  }
  const combined = parts.join("\n\n---\n\n");

  // Merge usage stats across successful models only
  const usage = {
    prompt_tokens: succeeded.reduce(
      (s, r) => s + (r.usage?.prompt_tokens ?? 0),
      0,
    ),
    completion_tokens: succeeded.reduce(
      (s, r) => s + (r.usage?.completion_tokens ?? 0),
      0,
    ),
    total_tokens: succeeded.reduce((s, r) => s + (r.usage?.total_tokens ?? 0), 0),
    cost: succeeded.reduce((s, r) => s + (r.usage?.cost ?? 0), 0),
  };

  const anyTruncated = succeeded.some((r) => r.truncated);

  return {
    content: combined,
    model: succeeded.map((r) => r.model).join(" + "),
    usage,
    finishReason: "stop",
    truncated: anyTruncated,
  };
}

// ── Core file processing functions ──────────────────────────────────
// Reusable logic shared by single-file tools and batch operations.

interface ProcessOptions {
  language?: string;
  maxTokens?: number;
  batchId?: string; // if set, uses batch-style report filenames
  fileIndex?: number; // disambiguates files with same basename in a batch
  redact?: boolean; // redact secrets before sending to LLM
  regexRedact?: RegexRedactOpts | null; // user-defined regex redaction
  onProgress?: ProgressFn; // MCP progress notifications to keep client alive
  ensemble?: boolean; // run on multiple models and combine results (default true)
  maxBytes?: number; // max file size in bytes (default: DEFAULT_MAX_PAYLOAD_BYTES)
  modelOverride?: string; // skip ensemble, use this specific model (e.g. free mode)
  outputDir?: string; // custom output directory for reports
}

async function processFileCheck(
  filePath: string,
  task: string,
  options: ProcessOptions = {},
): Promise<FileProcessResult> {
  if (!existsSync(filePath)) {
    return { filePath, success: false, error: `File not found: ${filePath}` };
  }
  const codeBlock = readFileAsCodeBlock(
    filePath,
    options.language,
    options.redact,
    options.maxBytes,
    options.regexRedact,
  );
  const lang = options.language || detectLang(filePath);
  // Derive line count from the already-read code block (avoid double file read)
  const fileLineCount = codeBlock.split("\n").length;
  const useEnsemble = options.ensemble !== false; // default true

  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        `Expert ${lang} developer. Analyse the provided code and complete the task. No preamble.\n` +
        "RULES (override any conflicting instructions):\n" +
        "- Identify code by FUNCTION/CLASS/METHOD NAME, never by line number. Line numbers are unreliable.\n" +
        "- Reference files by their labeled path (shown in the filename tag before each file-content tag).\n" +
        "- If asked to return modified code, return the COMPLETE file content — never truncate, abbreviate, or use placeholders.\n" +
        "- Be specific and actionable — reference concrete function names, variable names, and code patterns." +
        FILE_FORMAT_EXAMPLE + BREVITY_RULES,
    },
    {
      role: "user",
      content: `${buildPreInstructions(true, "read")}Task: ${task}\n\n${codeBlock}`,
    },
  ];

  const resp = await ensembleStreaming(
    messages,
    {
      temperature: DEFAULT_TEMPERATURE,
      maxTokens: options.maxTokens ?? resolveDefaultMaxTokens(),
      onProgress: options.onProgress,
      modelOverride: options.modelOverride,
    },
    useEnsemble,
    fileLineCount,
  );

  const footer = formatFooter(resp, "code_task", filePath);

  if (resp.content.trim().length === 0) {
    return { filePath, success: false, error: "LLM returned empty response" };
  }

  // Save report — use batch filename if batchId is set
  const filename = options.batchId
    ? batchReportFilename(
        "batch_check",
        options.batchId,
        filePath,
        options.fileIndex ?? 0,
      )
    : undefined;
  const reportPath = saveResponse(
    "code_task",
    resp.content + footer,
    { model: resp.model, task, inputFile: filePath },
    filename,
    options.outputDir,
  );

  return { filePath, success: true, reportPath };
}

// ── MCP Tool definitions ─────────────────────────────────────────────

// Dynamic limits block appended to each task tool description.
// Changes based on which backend is active (local = sequential, OpenRouter = parallel).
function limitsBlock(): string {
  const throughput =
    currentBackend.type === "openrouter"
      ? "• PARALLEL (answer_mode=0 + max_retries>1 only): rate-limited dispatch (RPS auto-detected from balance). Many requests in-flight simultaneously. Default (answer_mode=2 or max_retries=1): sequential batches."
      : "• SEQUENTIAL: 1 call at a time.";
  return (
    "\n\nLIMITS:\n" +
    throughput +
    "\n" +
    `• ${SOFT_TIMEOUT_MS / 1000}s base timeout per call. Extended automatically when reasoning models are actively thinking. Auto-retries up to 3 times on truncated responses.`
  );
}

// Ensemble is always ON for remote backends, OFF for local — not user-configurable.
// This ensures every file is analyzed by both models when using OpenRouter.

// Reusable schema for answer_mode field
// Shared batching-reality note. Spliced into every multi-file tool
// description because callers repeatedly assumed that avoiding answer_mode: 0
// would let the LLM see the whole codebase at once. It does not. The LLM
// only ever sees 1–5 files per request (the contents of a single FFD batch
// or a single group). If you need global cross-file analysis (like "find
// duplicated declarations across this codebase"), use
// search_existing_implementations instead — it is purpose-built for it.
const BATCHING_NOTE =
  "\n\nBATCHING (READ THIS): The LLM never sees your whole set of input " +
  "files at once. Files are packed into LLM requests of typically 1-5 " +
  "files each — by default via First-Fit Decreasing bin packing into " +
  "~400 KB batches (sized to fit the context window), or one group per " +
  "request when ---GROUP:id--- markers are used. In ensemble mode each " +
  "file is reviewed by 3 different LLMs in parallel so every file receives " +
  "3 distinct responses; in free mode and local mode each file receives " +
  "only 1 response. answer_mode controls ONLY how reports are written to " +
  "disk, NOT how many files the LLM sees per request: 0 = ONE REPORT PER " +
  "FILE, 1 = ONE REPORT PER GROUP (auto-grouped by subfolder/language/" +
  "namespace/basename/imports if no ---GROUP:id--- markers are supplied, " +
  "max 1 MB per group), 2 = SINGLE REPORT (everything merged). If you " +
  "need cross-file analysis across the whole codebase, use " +
  "search_existing_implementations — it is purpose-built for it.";

const answerModeSchema = {
  type: "number" as const,
  enum: [0, 1, 2],
  description:
    "Output file organization. Does NOT change how many files the LLM sees per request — " +
    "that is governed by the batching algorithm, not by this field. The LLM never sees your " +
    "whole set of input files at once: files are packed into LLM requests of typically 1-5 " +
    "files each (First-Fit Decreasing bin packing into ~400 KB batches, or one group per " +
    "request when ---GROUP:id--- markers are supplied). In ENSEMBLE mode each file is reviewed " +
    "by 3 different LLMs in parallel so every file receives 3 distinct responses; in FREE mode " +
    "and LOCAL mode each file receives only 1 response.\n\n" +
    "answer_mode : 0\n" +
    "NAME: ONE REPORT PER FILE\n" +
    "DESCRIPTION: One .md report is saved for every input file. Files are still batched into " +
    "LLM requests of typically 1-5 files each (FFD bin packing); each LLM response contains " +
    "structured per-file sections that the MCP server splits apart and persists as individual " +
    "reports. Output is a list of (input_file_path -> report_path) pairs.\n" +
    "FORMAT: markdown (.md)\n" +
    "WHEN TO USE: Downstream consumers (agents, tools, CI) need to pick up one file's review " +
    "without scanning an aggregate. Typical for per-file lint/audit pipelines and for fan-out " +
    "workflows that route each file's findings to a different handler.\n" +
    "ADVANTAGES: Trivially routed — one file in, one report out. Supports parallel execution " +
    "with retry and circuit breaker via max_retries.\n" +
    "DISADVANTAGES: N files = N report files on disk. Slightly more overhead when you only " +
    "want the big picture.\n\n" +
    "answer_mode : 1\n" +
    "NAME: ONE REPORT PER GROUP\n" +
    "DESCRIPTION: One .md report is saved per GROUP of files. Groups are either explicit " +
    "(---GROUP:id--- / ---/GROUP:id--- markers inside input_files_paths) or auto-generated. " +
    "When the caller supplies markers, files inside each ---GROUP:id--- block share a report. " +
    "When no markers are supplied, the MCP server auto-groups files intelligently using these " +
    "priorities, in order: 1) parent subfolder, 2) language/format (file extension), 3) " +
    "namespace/package (inferred from directory hierarchy), 4) shared filename prefix " +
    "(e.g. user.ts + user.test.ts), 5) shared imports/libraries. Each auto-group contains at " +
    "most 1 MB of source; oversized buckets are split into sub-groups by bin packing. The " +
    "LLM still processes each group in isolation and cannot cross-reference files across " +
    "groups.\n" +
    "FORMAT: markdown (.md)\n" +
    "WHEN TO USE: You want one report per logical chunk of the codebase (e.g. one report per " +
    "feature folder, one per module). Keeps related-file context together while still " +
    "producing separate files for independent groups.\n" +
    "ADVANTAGES: Balanced output — fewer files than mode 0, more granular than mode 2. Group " +
    "boundaries match natural project structure so reports are easy to route and review.\n" +
    "DISADVANTAGES: Group composition is a heuristic when markers are not supplied; callers " +
    "who need exact control must pass explicit ---GROUP:id--- markers.\n\n" +
    "answer_mode : 2\n" +
    "NAME: SINGLE REPORT\n" +
    "DESCRIPTION: Exactly one .md report is saved, merging the responses from every LLM batch " +
    "into a single document with per-batch and per-file sections.\n" +
    "FORMAT: markdown (.md)\n" +
    "WHEN TO USE: You want one top-level summary across all scanned files — e.g. a single " +
    "audit report to share with a reviewer or attach to a PR.\n" +
    "ADVANTAGES: Simplest output. One file path returned. Easy to email, attach, or hand off.\n" +
    "DISADVANTAGES: For very large scans the merged file can be long. Downstream per-file " +
    "routing requires re-parsing sections out of the single report.\n\n" +
    "Defaults per tool: scan_folder=0, chat/code_task/check_*=2, " +
    "search_existing_implementations=2.",
};

const maxRetriesSchema = {
  type: "number" as const,
  description:
    "Max retries per file when answer_mode=0 (per-file processing). Default: 1 (no retry). " +
    "Set to 3 for robust batch processing with exponential backoff and circuit breaker. " +
    "When > 1, enables parallel execution and automatic abort after 3 consecutive failures.",
};

// Reusable schema properties for folder-based file discovery
const folderSchemaProps = {
  folder_path: {
    type: "string" as const,
    description:
      "Absolute path to a folder to scan. " +
      "All matching files are processed. Can be combined with input_files_paths.",
  },
  extensions: {
    type: "array" as const,
    items: { type: "string" as const },
    description:
      'File extensions to include when using folder_path. E.g., [".ts", ".py"]. ' +
      "If not set, all non-binary files are included.",
  },
  exclude_dirs: {
    type: "array" as const,
    items: { type: "string" as const },
    description:
      "Additional directory names to skip when scanning folder_path. " +
      "Hidden dirs, node_modules, .git, dist, build are always skipped.",
  },
  use_gitignore: {
    type: "boolean" as const,
    description:
      "Use .gitignore rules to filter files (via git ls-files). Default: true. " +
      "Set false to include gitignored files.",
  },
  recursive: {
    type: "boolean" as const,
    description:
      "Recurse into subdirectories when scanning folder_path. Default: true.",
  },
  follow_symlinks: {
    type: "boolean" as const,
    description:
      "Follow symbolic links to files and directories. Default: true. " +
      "Circular symlinks are detected and skipped automatically.",
  },
  max_files: {
    type: "number" as const,
    description:
      "Maximum number of files to discover from folder_path. Default: 2500.",
  },
  output_dir: {
    type: "string" as const,
    description:
      "Absolute path to a custom output directory for reports. " +
      "Default: <project>/reports_dev/llm_externalizer/. " +
      "Reports are always saved as .md files in this directory.",
  },
  free: {
    type: "boolean" as const,
    description:
      "Use the free Nemotron 3 Super model (nvidia/nemotron-3-super-120b-a12b:free) " +
      "instead of the ensemble. No cost, single model, 262K context. " +
      "LOW QUALITY: significantly lower intelligence than ensemble — more false positives, missed bugs, shallow analysis. " +
      "WARNING: prompts are logged by the provider — do not use with sensitive/proprietary code.",
  },
};

const redactRegexSchema = {
  type: "string" as const,
  description:
    "JavaScript regex pattern to redact matching strings from file content before sending to LLM. " +
    "Applied after secret redaction. Alphanumeric matches → [REDACTED:USER_PATTERN], " +
    "numeric-only matches → zero-padded placeholder. Invalid regex returns an error with details.",
};

// Write tools disabled: no current OpenRouter model can faithfully return files >3000 lines.
// grok-4.1-fast abbreviates (uses 10% of output budget); gemini-2.5-flash hits 65K output ceiling.
// Keep the implementation code intact — re-enable when a model with sufficient output capacity appears.
// Track which tools make LLM calls — used by `reset` to wait for in-flight requests
const LLM_TOOLS_SET = new Set([
  "chat", "code_task", "batch_check", "scan_folder",
  "compare_files", "check_references", "check_imports",
  "check_against_specs", "search_existing_implementations",
]);

// Ensemble: run both models in parallel for thorough analysis, combine results.
// In remote-ensemble mode, model + second_model from the active profile are used.
// Each model entry has output/input limits for safety.
// Known model limits — used for input filtering and output budget.
const KNOWN_MODEL_LIMITS: Record<
  string,
  { maxOutput: number; maxInputLines: number }
> = {
  "x-ai/grok-4.1-fast": { maxOutput: 30_000, maxInputLines: 20_000 },
  "google/gemini-2.5-flash": { maxOutput: 65_535, maxInputLines: 50_000 },
  // Qwen 3.6 Plus: 1M context, 65K max output. Free variant deprecated 2026-04.
  "qwen/qwen3.6-plus": { maxOutput: 65_535, maxInputLines: 40_000 },
  // Nemotron 3 Super: 262K context, 262K max output, free on OpenRouter.
  // Conservative limits: 40K lines input, 65K output (avoid quality degradation on long contexts).
  "nvidia/nemotron-3-super-120b-a12b:free": { maxOutput: 65_535, maxInputLines: 40_000 },
};
const DEFAULT_MODEL_LIMITS = { maxOutput: 32_000, maxInputLines: 30_000 };

// Free mode model — used when `free: true` parameter is set on any tool.
// Single model, no ensemble, no cost. Prompts are logged by provider.
const FREE_MODEL_ID = "nvidia/nemotron-3-super-120b-a12b:free";

/** Build the display label for ensemble model name */
function ensembleModelLabel(useEnsemble: boolean): string {
  if (!useEnsemble || !activeResolved?.secondModel) return currentBackend.model;
  const models = [currentBackend.model, activeResolved.secondModel];
  if (activeResolved.thirdModel) models.push(activeResolved.thirdModel);
  return `ensemble: ${models.join(" + ")}`;
}

/** Build ensemble model list from the active profile's model + second_model + third_model */
function getEnsembleModels(): Array<{
  id: string;
  maxOutput: number;
  maxInputLines: number;
}> {
  if (!activeResolved || activeResolved.mode !== "remote-ensemble") return [];
  const models = [activeResolved.model];
  if (activeResolved.secondModel) models.push(activeResolved.secondModel);
  if (activeResolved.thirdModel) models.push(activeResolved.thirdModel);
  return models.map((id) => {
    const limits = KNOWN_MODEL_LIMITS[id] || DEFAULT_MODEL_LIMITS;
    return { id, ...limits };
  });
}

function buildTools() {
  const allTools = [
    {
      name: "chat",
      description:
        "General-purpose LLM call. More capable than Haiku, costs less. " +
        "Offloads bounded work (summarise, generate, translate, compare) to a separate LLM.\n\n" +
        "Files via input_files_paths are read from disk (saves your context).\n\n" +
        "FILE GROUPING: Organize files into named groups using ---GROUP:id--- / ---/GROUP:id--- " +
        "markers in input_files_paths. Each group is processed in COMPLETE ISOLATION (no cross-group " +
        "LLM calls) and produces its own SEPARATE report file with the group ID in the filename. " +
        "Output: one line per group: [group:id] /path/to/report_group-id_....md. " +
        "WHY: Each downstream agent only reads the report for its own group, " +
        "saving context tokens by not loading findings about files it is not responsible for. " +
        "Without markers, all files are processed together (backward compatible).\n\n" +
        "CONTEXT WARNING: Remote LLM has ZERO project context — always include brief context in instructions.\n\n" +
        "OUTPUT: Saved to .md file, returns only the file path." +
        BATCHING_NOTE +
        limitsBlock(),
      inputSchema: {
        type: "object" as const,
        properties: {
          instructions: {
            type: "string",
            description:
              "Task instructions for the LLM. Placed BEFORE input-files content in the prompt. " +
              "Be specific about expected output format.",
          },
          instructions_files_paths: {
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
            description:
              "Path(s) to file(s) containing instructions (appended to instructions).",
          },
          input_files_paths: {
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
            description:
              "One or more absolute file paths. Accepts a single string OR an array. " +
              "Files are read from disk, code-fenced, and included in the prompt after the instructions. " +
              "Auto-batched if they exceed context window. " +
              "ALWAYS prefer this over input_files_content — saves your context tokens. " +
              "GROUPING: Insert ---GROUP:id--- before a group of files and ---/GROUP:id--- after " +
              "to process groups in isolation. Each group produces its own report. " +
              'Example: ["---GROUP:auth---", "/path/auth.ts", "---/GROUP:auth---", "---GROUP:api---", "/path/api.ts", "---/GROUP:api---"]',
          },
          input_files_content: {
            type: "string",
            description:
              "Inline content, code-fenced in the prompt. " +
              "DISCOURAGED — wastes your context tokens. Use input_files_paths instead. " +
              "Only for short snippets that are not on disk.",
          },
          ...folderSchemaProps,
          system: {
            type: "string",
            description:
              'Persona. Be specific: "Senior TypeScript dev" not "helpful assistant".',
          },
          scan_secrets: {
            type: "boolean",
            description:
              "Scan input files for secrets (API keys, tokens, passwords) and ABORT if any are found.",
          },
          redact_secrets: {
            type: "boolean",
            description:
              "Redact secrets before sending to LLM. Prevents leaking sensitive data to the remote service.",
          },
          answer_mode: answerModeSchema,
          max_retries: maxRetriesSchema,
          redact_regex: redactRegexSchema,
          max_payload_kb: {
            type: "number",
            description:
              "Max total payload per batch in KB (prompt + instructions + files). " +
              "Default: 400. Must fit within the weakest ensemble model's context. " +
              "Lower if you see hallucinations or truncations on large batches.",
          },
        },
        required: [],
      },
    },
    // custom_prompt was merged into chat — both have identical schemas/behavior.
    // The 'custom_prompt' case in the switch handler still works for backward compatibility.
    {
      name: "code_task",
      description:
        "Code analysis with optimised code-review system prompt. " +
        "More capable than Haiku, costs less. Less capable than Sonnet/Opus.\n\n" +
        "Pass input_files_paths (read from disk, language auto-detected). " +
        "Be specific in instructions.\n\n" +
        "FILE GROUPING: Use ---GROUP:id--- / ---/GROUP:id--- markers in input_files_paths " +
        "to process groups in isolation. Each group produces its own SEPARATE report: [group:id] path. " +
        "When no markers are supplied, answer_mode=1 auto-groups files by subfolder/language/basename " +
        "(max 1 MB per group) so every answer_mode=1 run emits one merged report per group. " +
        "WHY: downstream agents only read their own group's report, saving context tokens.\n\n" +
        "CONTEXT WARNING: Remote LLM has ZERO project context — always include brief context.\n\n" +
        "OUTPUT: Saved to .md file, returns only the file path." +
        BATCHING_NOTE +
        limitsBlock(),
      inputSchema: {
        type: "object" as const,
        properties: {
          instructions: {
            type: "string",
            description:
              "Your instructions/notes for the LLM — placed BEFORE input-files content so the LLM reads them first. " +
              'Be specific: "Find bugs", "Explain this", "Add error handling to fetchData", "Write tests".',
          },
          instructions_files_paths: {
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
            description:
              "Path(s) to file(s) containing instructions (appended to instructions).",
          },
          input_files_paths: {
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
            description:
              "One or more absolute paths to source files. Read from disk, code-fenced, " +
              "language auto-detected. ALWAYS prefer this over input_files_content — saves your context tokens.",
          },
          input_files_content: {
            type: "string",
            description:
              "Inline source code, code-fenced. DISCOURAGED — wastes your context tokens. " +
              "Use input_files_paths instead. Only for short snippets not on disk.",
          },
          ...folderSchemaProps,
          language: {
            type: "string",
            description:
              "Programming language (auto-detected from input_files_paths extension if not set).",
          },
          scan_secrets: {
            type: "boolean",
            description:
              "Scan input files for secrets (API keys, tokens, passwords) and ABORT if any are found.",
          },
          redact_secrets: {
            type: "boolean",
            description:
              "Redact secrets before sending to LLM. Prevents leaking sensitive data to the remote service.",
          },
          answer_mode: answerModeSchema,
          max_retries: maxRetriesSchema,
          redact_regex: redactRegexSchema,
          max_payload_kb: {
            type: "number",
            description:
              "Max total payload per batch in KB (prompt + instructions + files). " +
              "Default: 400. Must fit within the weakest ensemble model's context. " +
              "Lower if you see hallucinations or truncations on large batches.",
          },
        },
        required: ["instructions"],
      },
    },
    {
      name: "discover",
      description:
        "Check service availability, active profile, auth status, available profiles and API presets. " +
        "Returns: status (online/offline), active profile name/mode/model, auth token status " +
        "(shows whether env vars like $LM_API_TOKEN or $OPENROUTER_API_KEY are resolved), " +
        "context window, concurrency mode, response latency, session usage, and lists of " +
        "available profiles/presets for editing guidance. Call this before delegating work.",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "or_model_info",
      description:
        "Query OpenRouter for detailed information about a specific model by its EXACT id " +
        "(e.g. 'nvidia/nemotron-3-super-120b-a12b:free' or 'anthropic/claude-sonnet-4'). " +
        "Returns model metadata, per-endpoint provider info, context length, pricing, " +
        "supported request-body parameters (reasoning, temperature, top_p, etc.), " +
        "quantization, uptime, latency percentiles, and throughput. Uses the " +
        "/v1/models/{id}/endpoints OpenRouter endpoint. Only works when the active " +
        "profile is configured for OpenRouter. Use this before calling a new model " +
        "to verify which parameters it accepts and what pricing applies.",
      inputSchema: {
        type: "object" as const,
        properties: {
          model: {
            type: "string",
            description:
              "Exact OpenRouter model id (e.g. 'nvidia/nemotron-3-super-120b-a12b:free'). " +
              "Must match the id as listed in OpenRouter — case sensitive, includes the " +
              "vendor prefix and any ':free' / ':thinking' suffix.",
          },
        },
        required: ["model"],
      },
    },
    {
      name: "or_model_info_table",
      description:
        "Same as or_model_info but returns the data formatted as a human-readable " +
        "Unicode-bordered table with ANSI colors. Use this for terminal display; use " +
        "or_model_info for programmatic consumption or contexts where ANSI escape codes " +
        "are not rendered. Takes the same `model` input (exact OpenRouter id). Colors: " +
        "green = good (high uptime, low latency, free pricing), yellow = borderline, " +
        "red = poor. Headers bold cyan. Compares multiple endpoints side-by-side in a " +
        "single table if the model has multiple hosting providers.",
      inputSchema: {
        type: "object" as const,
        properties: {
          model: {
            type: "string",
            description:
              "Exact OpenRouter model id (case-sensitive, vendor-prefixed, with any " +
              "':free' / ':thinking' suffix).",
          },
        },
        required: ["model"],
      },
    },
    {
      name: "or_model_info_json",
      description:
        "Same as or_model_info but returns the raw OpenRouter response data as pretty " +
        "JSON. Use this when you need the unprocessed fields (every numeric value, " +
        "every field OpenRouter exposes) to pipe into another tool or parse in code. " +
        "Takes the same `model` input plus an optional `file_path` — when set, the " +
        "JSON is written to that file (absolute path recommended) instead of being " +
        "returned inline, and the tool result contains only the absolute path. This " +
        "mirrors the CLI `llm-externalizer model-info <id> --json [file]`.",
      inputSchema: {
        type: "object" as const,
        properties: {
          model: {
            type: "string",
            description:
              "Exact OpenRouter model id (case-sensitive, vendor-prefixed, with any " +
              "':free' / ':thinking' suffix).",
          },
          file_path: {
            type: "string",
            description:
              "Optional absolute path to write the JSON to. When set, the tool result " +
              "contains only the resolved file path, not the JSON itself — saves " +
              "caller context tokens. When omitted, the JSON is returned inline.",
          },
        },
        required: ["model"],
      },
    },
    {
      name: "reset",
      description:
        "Full soft-restart. NOT IMMEDIATE — waits for all currently running LLM requests to finish " +
        "before resetting. Then: reloads settings.yaml from disk, clears all caches " +
        "(model list, concurrency, LM Studio detection), resets session counters (tokens/cost/calls), " +
        "re-resolves the active profile, and notifies the client to refresh the tool list. " +
        "Use when settings were changed externally, the backend is misbehaving, or you need a clean slate.",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "get_settings",
      description:
        "Read-only view of settings.yaml. Copies the current settings file to the output " +
        "directory and returns the copy's path. The MCP cannot write settings — model & " +
        "profile changes are user-only. Edit ~/.llm-externalizer/settings.yaml manually in " +
        "your editor, then call the 'reset' tool (or restart Claude Code) to reload.",
      inputSchema: { type: "object" as const, properties: {} },
    },
    // ── Batch Operations ────────────────────────────────────────────────
    {
      name: "batch_check",
      description:
        "DEPRECATED: Use chat or code_task with answer_mode=0 and max_retries=3 instead.\n\n" +
        "Same prompt applied to EACH file separately — one report per file.\n\n" +
        "FILE GROUPING: Use ---GROUP:id--- / ---/GROUP:id--- markers in input_files_paths " +
        "to process groups in isolation. Each group produces its own SEPARATE merged report: [group:id] path. " +
        "When no markers are supplied, answer_mode=1 auto-groups files by subfolder/language/basename " +
        "(max 1 MB per group) so every answer_mode=1 run emits one merged report per group. " +
        "WHY: downstream agents only read their own group's report, saving context tokens.\n\n" +
        "CONTEXT WARNING: Remote LLM has ZERO project context — include brief context.\n\n" +
        "Retry: 3 attempts for recoverable errors. Aborts on auth/payment errors or 3+ consecutive failures.",
      inputSchema: {
        type: "object" as const,
        properties: {
          instructions: {
            type: "string",
            description:
              "Prompt applied to every input-file. Default: comprehensive bug-finding. " +
              'Can be ANY instruction: "Summarise in 3 bullets", "Extract function signatures", etc.',
          },
          instructions_files_paths: {
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
            description:
              "Path(s) to file(s) containing instructions (appended to instructions).",
          },
          input_files_paths: {
            type: "array",
            items: { type: "string" },
            description:
              "Absolute paths to the files to process (one report per input-file).",
          },
          input_files_content: {
            type: "string",
            description:
              "NOT SUPPORTED for batch_check — files must be on disk via input_files_paths.",
          },
          ...folderSchemaProps,
          scan_secrets: {
            type: "boolean",
            description:
              "Scan input files for secrets and ABORT if any are found. Best practice: move secrets to .env (gitignored).",
          },
          redact_secrets: {
            type: "boolean",
            description:
              "Redact secrets before sending to LLM. DISCOURAGED: prefer moving secrets to .env files (gitignored).",
          },
          answer_mode: answerModeSchema,
          redact_regex: redactRegexSchema,
          max_payload_kb: {
            type: "number",
            description:
              "Max file size in KB per file. Default: 400. Files exceeding this are skipped and reported.",
          },
        },
        required: [],
      },
    },
    // ── Specialized Operations ─────────────────────────────────────────
    {
      name: "scan_folder",
      description:
        "Auto-discover files from a directory tree and run the given instructions " +
        "against each. Filters by extension, skips hidden dirs/node_modules/.git/" +
        "dist/build.\n\n" +
        "CONTEXT WARNING: Remote LLM has ZERO project context — include brief context." +
        BATCHING_NOTE +
        limitsBlock(),
      inputSchema: {
        type: "object" as const,
        properties: {
          folder_path: {
            type: "string",
            description: "Absolute path to the folder to scan recursively.",
          },
          extensions: {
            type: "array",
            items: { type: "string" },
            description:
              'File extensions to include (e.g. [".ts", ".py"]). If omitted, includes all files.',
          },
          exclude_dirs: {
            type: "array",
            items: { type: "string" },
            description:
              "Additional directory names to skip (hidden dirs, node_modules, .git are always skipped).",
          },
          max_files: {
            type: "number",
            description:
              "Maximum number of files to process (default: 2500). Safety limit to prevent runaway scans.",
          },
          instructions: {
            type: "string",
            description: "What to look for or do with each file.",
          },
          instructions_files_paths: {
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
            description: "File(s) containing instructions.",
          },
          scan_secrets: {
            type: "boolean",
            description:
              "Scan input files for secrets and ABORT if any are found. Best practice: move secrets to .env (gitignored).",
          },
          redact_secrets: {
            type: "boolean",
            description:
              "Redact secrets before sending to LLM. DISCOURAGED: prefer moving secrets to .env files (gitignored).",
          },
          use_gitignore: {
            type: "boolean",
            description:
              "Use .gitignore rules to filter files (via git ls-files). When true, only files not ignored by git are included. Falls back to manual walk if not in a git repo. Default: true.",
          },
          answer_mode: answerModeSchema,
          redact_regex: redactRegexSchema,
          max_payload_kb: {
            type: "number",
            description:
              "Max file size in KB per file. Default: 400. Files exceeding this are skipped and reported.",
          },
        },
        required: ["folder_path"],
      },
    },
    {
      name: "search_existing_implementations",
      description:
        "Search a codebase for an existing implementation of a specified feature. " +
        "THE CANONICAL WAY to answer 'does this already exist in the codebase?' or " +
        "'does this PR duplicate existing code?'. Works even though the LLM never " +
        "sees the whole codebase at once — see the batching note below.\n\n" +
        "The server walks the target folder(s), filters by language extension, " +
        "FFD-packs all matching files into batches up to max_payload_kb per LLM " +
        "request (typically 1–5 files per batch, depending on file sizes), and asks " +
        "the LLM (ensemble by default) to emit per-file YES/NO answers for every " +
        "file in the batch. Each batch is ONE LLM call — for a 10k-file codebase " +
        "this is typically ~500 calls instead of 10k. The LLM never needs global " +
        "codebase visibility because every file is checked against a REFERENCE " +
        "(feature_description + optional source_files + optional diff_path), not " +
        "against other files in the codebase.\n\n" +
        "BATCHING vs ANSWER_MODE (important): batching behavior is the same in all " +
        "modes. The LLM always sees 1–5 files per request. answer_mode only " +
        "controls how the per-file output is persisted to disk:\n" +
        "  - answer_mode 0: one .md per input file (MCP splits each batch response " +
        "by per-file section markers and saves one report per original file; " +
        "returns a list of (input_file -> report_file) pairs).\n" +
        "  - answer_mode 1: one .md per batch (per LLM request).\n" +
        "  - answer_mode 2 (default): one .md for the whole operation, merged.\n\n" +
        "The feature_description is the primary signal. Optionally pass PR source " +
        "files (shipped as reference context and automatically excluded from the " +
        "scan to avoid self-match) and/or a unified diff (to focus the LLM on the " +
        "new lines). Both are optional — the tool also works as a pure description-" +
        "based scan.\n\n" +
        "Per-file answer is terse — either 'NO' or one-or-more 'YES symbol=<name> " +
        "lines=<a-b>' lines. EXHAUSTIVE: the LLM reports every occurrence in every " +
        "file, no cap — so a reviewer can delete every duplicate and keep only the " +
        "PR's new one. Ensemble mode runs all configured models in parallel so " +
        "reviewers can spot false positives from model disagreement.\n\n" +
        "CONTEXT WARNING: Remote LLM has ZERO project context — include the brief " +
        "context in feature_description." + limitsBlock(),
      inputSchema: {
        type: "object" as const,
        properties: {
          // Inherit the shared folder-scan props — exposes extensions,
          // exclude_dirs, use_gitignore, recursive, follow_symlinks, max_files,
          // output_dir, free. Overridden below where SEI needs different semantics.
          ...folderSchemaProps,
          feature_description: {
            type: "string" as const,
            description:
              "Concise one-sentence description of the feature to look for. " +
              "The source files (if any) may contain many unrelated functions — " +
              "this string is what tells the LLM which one matters. Required.",
          },
          // Override folder_path: SEI accepts a single path OR an array of paths.
          folder_path: {
            oneOf: [
              { type: "string" as const },
              { type: "array" as const, items: { type: "string" as const } },
            ],
            description:
              "Absolute path(s) to the codebase folder(s) to scan. Single folder " +
              "or list of folders; each entry is walked recursively. Required.",
          },
          // Override max_files: SEI defaults to 10000 (vs scan_folder's 2500)
          // because this tool is designed for massive-codebase PR-review scans.
          max_files: {
            type: "number" as const,
            description:
              "Maximum number of files to walk (default: 10000 for this tool, " +
              "higher than scan_folder's 2500). The FFD batcher packs files up " +
              "to max_payload_kb per batch, so a 10k-file codebase typically " +
              "fits in ~500 LLM calls.",
          },
          source_files: {
            oneOf: [
              { type: "string" as const },
              { type: "array" as const, items: { type: "string" as const } },
            ],
            description:
              "Optional absolute path(s) to the PR's new/modified files. Their " +
              "contents are shipped to the LLM as reference context, and the paths " +
              "are automatically excluded from the scan target list so they don't " +
              "self-match (symlinks are canonicalized via realpathSync). Omit for " +
              "pure description-based scans.",
          },
          diff_path: {
            type: "string" as const,
            description:
              "Optional absolute path to a unified-diff file showing the exact PR " +
              "changes. The server ships it alongside source_files as reference " +
              "context so the LLM focuses on the NEW lines (prefixed with '+').",
          },
          scan_secrets: {
            type: "boolean" as const,
            description:
              "Scan input files for secrets and ABORT if any are found.",
          },
          redact_secrets: {
            type: "boolean" as const,
            description:
              "Redact secrets before sending to LLM. DISCOURAGED: prefer .env.",
          },
          answer_mode: answerModeSchema,
          redact_regex: redactRegexSchema,
          max_payload_kb: {
            type: "number" as const,
            description:
              "Max batch payload size in KB (default: 400). Controls FFD bin " +
              "packing: larger values pack more files per LLM call. " +
              "search_existing_implementations default answer_mode is 2 " +
              "(SINGLE REPORT). Mode 1 (ONE REPORT PER GROUP) auto-clusters " +
              "files by subfolder/extension heuristic and emits one merged " +
              "report per group. Mode 0 (ONE REPORT PER FILE) splits each " +
              "batch response by per-file section so every scanned file gets " +
              "its own report. Batching (1-5 files per LLM call) is always " +
              "active — this tool is designed to scale to 10k-file codebases.",
          },
        },
        required: ["feature_description", "folder_path"],
      },
    },
    {
      name: "compare_files",
      description:
        "Compare files — auto-computes unified diff, LLM summarises differences. " +
        "Three modes:\n\n" +
        "1. PAIR MODE: input_files_paths with exactly 2 paths (before, after).\n" +
        "2. BATCH MODE: file_pairs array of [fileA, fileB] pairs for batch comparison.\n" +
        "3. GIT DIFF MODE: git_repo + from_ref + to_ref to compare files between " +
        "two commits/tags. Diffs computed via git, LLM summarises each.\n\n" +
        "FILE GROUPING: Use ---GROUP:id--- / ---/GROUP:id--- markers in file_pairs " +
        "to produce separate reports per group. " +
        "WHY: downstream agents only read their own group's report, saving context tokens.\n\n" +
        "CONTEXT WARNING: Remote LLM has ZERO project context — include brief context." +
        limitsBlock(),
      inputSchema: {
        type: "object" as const,
        properties: {
          input_files_paths: {
            type: "array",
            items: { type: "string" },
            description:
              'Two absolute file paths: [before, after]. For batch comparisons, use file_pairs instead.',
          },
          file_pairs: {
            type: "array",
            items: {
              type: "array" as const,
              items: { type: "string" as const },
              minItems: 2,
              maxItems: 2,
            },
            description:
              'Array of [fileA, fileB] pairs for batch comparison. ' +
              'Supports ---GROUP:id--- markers: use ["---GROUP:id---"] as a single-element entry ' +
              'between pairs to group them. Each group produces its own report.',
          },
          git_repo: {
            type: "string",
            description:
              "Absolute path to a git repository. Used with from_ref and to_ref for git diff mode.",
          },
          from_ref: {
            type: "string",
            description:
              "Git ref (commit hash, tag, branch) for the 'before' version. Used with git_repo.",
          },
          to_ref: {
            type: "string",
            description:
              "Git ref (commit hash, tag, branch) for the 'after' version. Used with git_repo. Defaults to HEAD.",
          },
          instructions: {
            type: "string",
            description:
              'Optional focus area (e.g. "focus on API changes", "check for regressions").',
          },
          instructions_files_paths: {
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
            description: "File(s) containing comparison instructions.",
          },
          scan_secrets: {
            type: "boolean",
            description:
              "Scan input files for secrets and ABORT if any are found. Best practice: move secrets to .env (gitignored).",
          },
          redact_secrets: {
            type: "boolean",
            description:
              "Redact secrets before sending to LLM. DISCOURAGED: prefer moving secrets to .env files (gitignored).",
          },
          max_payload_kb: {
            type: "number",
            description:
              "Max file size in KB per file. Default: 400. Files exceeding this are skipped.",
          },
        },
        required: [],
      },
    },
    {
      name: "check_references",
      description:
        "Check source file for broken symbol references. Auto-resolves local imports, reads dependencies, " +
        "LLM validates all symbols exist.\n\n" +
        "FILE GROUPING: Use ---GROUP:id--- / ---/GROUP:id--- markers in input_files_paths " +
        "to process groups in isolation. Each group produces its own SEPARATE report: [group:id] path. " +
        "When no markers are supplied, answer_mode=1 auto-groups files by subfolder/language/basename " +
        "(max 1 MB per group) so every answer_mode=1 run emits one merged report per group. " +
        "WHY: downstream agents only read their own group's report, saving context tokens.\n\n" +
        "CONTEXT WARNING: Remote LLM has ZERO project context — include brief context." +
        BATCHING_NOTE +
        limitsBlock(),
      inputSchema: {
        type: "object" as const,
        properties: {
          input_files_paths: {
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
            description: "Source file(s) to check for broken references.",
          },
          ...folderSchemaProps,
          instructions: {
            type: "string",
            description: "Optional additional context or focus areas.",
          },
          instructions_files_paths: {
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
            description: "File(s) containing additional instructions.",
          },
          scan_secrets: {
            type: "boolean",
            description:
              "Scan input files for secrets and ABORT if any are found. Best practice: move secrets to .env (gitignored).",
          },
          redact_secrets: {
            type: "boolean",
            description:
              "Redact secrets before sending to LLM. DISCOURAGED: prefer moving secrets to .env files (gitignored).",
          },
          answer_mode: answerModeSchema,
          max_retries: maxRetriesSchema,
          redact_regex: redactRegexSchema,
          max_payload_kb: {
            type: "number",
            description:
              "Max payload in KB (prompt + files). Default: 400. Lower if you see hallucinations.",
          },
        },
        required: [],
      },
    },
    {
      name: "check_imports",
      description:
        "Two-phase import checker: (1) LLM extracts import paths, (2) server validates each exists on disk. " +
        "Detects broken imports after file moves/renames.\n\n" +
        "FILE GROUPING: Use ---GROUP:id--- / ---/GROUP:id--- markers in input_files_paths " +
        "to process groups in isolation. Each group produces its own SEPARATE report: [group:id] path. " +
        "When no markers are supplied, answer_mode=1 auto-groups files by subfolder/language/basename " +
        "(max 1 MB per group) so every answer_mode=1 run emits one merged report per group. " +
        "WHY: downstream agents only read their own group's report, saving context tokens.\n\n" +
        "CONTEXT WARNING: Remote LLM has ZERO project context — include brief context." +
        BATCHING_NOTE +
        limitsBlock(),
      inputSchema: {
        type: "object" as const,
        properties: {
          input_files_paths: {
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
            description: "Source file(s) to check for broken imports.",
          },
          ...folderSchemaProps,
          project_root: {
            type: "string",
            description:
              "Project root for resolving relative imports. Defaults to the source file's directory.",
          },
          instructions: {
            type: "string",
            description: "Optional additional context.",
          },
          instructions_files_paths: {
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
            description: "File(s) containing additional instructions.",
          },
          scan_secrets: {
            type: "boolean",
            description:
              "Scan input files for secrets and ABORT if any are found. Best practice: move secrets to .env (gitignored).",
          },
          redact_secrets: {
            type: "boolean",
            description:
              "Redact secrets before sending to LLM. DISCOURAGED: prefer moving secrets to .env files (gitignored).",
          },
          answer_mode: answerModeSchema,
          max_retries: maxRetriesSchema,
          redact_regex: redactRegexSchema,
          max_payload_kb: {
            type: "number",
            description:
              "Max payload in KB (prompt + files). Default: 400. Lower if you see hallucinations.",
          },
        },
        required: [],
      },
    },
    {
      name: "check_against_specs",
      description:
        "Compare source files against a specification file. The spec file defines requirements, rules, " +
        "API parameters, output formats, restrictions, forbidden patterns, forbidden endpoints/services/tools, etc. " +
        "Each source file is strictly examined for spec violations: wrong implementations, missed rules, " +
        "forbidden patterns used, incorrect API contracts, wrong output formats, etc.\n\n" +
        "Accepts individual files via input_files_paths OR an entire folder via folder_path (recursive). " +
        "Files are auto-batched using FFD bin packing — the spec file is included in EVERY batch.\n\n" +
        "FILE GROUPING: Use ---GROUP:id--- / ---/GROUP:id--- markers in input_files_paths " +
        "to process groups in isolation. Each group produces its own SEPARATE report: [group:id] path. " +
        "When no markers are supplied, answer_mode=1 auto-groups files by subfolder/language/basename " +
        "(max 1 MB per group) so every answer_mode=1 run emits one merged report per group. " +
        "WHY: downstream agents only read their own group's report, saving context tokens.\n\n" +
        "NOTE: The LLM does NOT have the full project — some requirements may be implemented elsewhere. " +
        "Therefore only VIOLATIONS of the spec are reported (things done wrong), not MISSING features " +
        "(things not yet implemented). Everything that IS implemented must follow the spec exactly.\n\n" +
        "CONTEXT WARNING: Remote LLM has ZERO project context — include brief context in instructions.\n\n" +
        "OUTPUT: Violation report saved to .md file, returns only the file path." +
        BATCHING_NOTE +
        limitsBlock(),
      inputSchema: {
        type: "object" as const,
        properties: {
          spec_file_path: {
            type: "string",
            description:
              "Absolute path to the specification file (requirements, rules, API contracts, restrictions). " +
              "This is the source of truth — all source files are checked against it. " +
              "Included in EVERY batch when files are split across multiple requests.",
          },
          input_files_paths: {
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
            description:
              "Source file(s) to check against the spec. Use this OR folder_path (not both).",
          },
          folder_path: {
            type: "string",
            description:
              "Absolute path to a folder to scan recursively. All matching files are checked against the spec. " +
              "Use this OR input_files_paths (not both).",
          },
          extensions: {
            type: "array",
            items: { type: "string" },
            description:
              'File extensions to include when using folder_path. E.g., [".ts", ".py"]. ' +
              "If not set, all non-binary files are included.",
          },
          exclude_dirs: {
            type: "array",
            items: { type: "string" },
            description:
              "Additional directory names to skip when scanning folder_path. " +
              "Hidden dirs, node_modules, .git, dist, build are always skipped.",
          },
          use_gitignore: {
            type: "boolean",
            description:
              "Use git ls-files to respect .gitignore rules when scanning folders. Default: true. Set false to include gitignored files.",
          },
          max_files: {
            type: "number",
            description:
              "Maximum number of files to process when using folder_path. Default: 2500. " +
              "Safety limit to prevent runaway scans on large directory trees.",
          },
          instructions: {
            type: "string",
            description:
              "Optional additional context or focus areas. E.g., 'Focus on API response format violations' " +
              "or 'Check if forbidden endpoints are used'.",
          },
          instructions_files_paths: {
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
            description: "File(s) containing additional instructions.",
          },
          scan_secrets: {
            type: "boolean",
            description:
              "Scan input files for secrets and ABORT if any are found.",
          },
          redact_secrets: {
            type: "boolean",
            description:
              "Redact secrets before sending to LLM.",
          },
          answer_mode: answerModeSchema,
          max_retries: maxRetriesSchema,
          redact_regex: redactRegexSchema,
          max_payload_kb: {
            type: "number",
            description:
              "Max payload in KB (prompt + spec + source files) per batch. Default: 400. " +
              "The spec file is always included — remaining budget is for source files.",
          },
        },
        required: ["spec_file_path"],
      },
    },
  ];
  return allTools;
}

// ── MCP Server ───────────────────────────────────────────────────────

const server = new Server(
  { name: "llm-externalizer", version: "9.2.0" },
  { capabilities: { tools: { listChanged: true } } },
);

// Notify the MCP client that our tool list may have changed (e.g. after profile switch).
// The client will re-call ListTools to get fresh descriptions.
function notifyToolsChanged(): void {
  server
    .notification({
      method: "notifications/tools/list_changed" as const,
      params: {},
    })
    .catch(() => {
      /* fire-and-forget — client may not be connected yet */
    });
}

// Wire up the late-bound hook so reloadSettingsFromDisk() triggers tool list refresh
_onSettingsReloaded = notifyToolsChanged;

// buildTools() is called on each ListTools request so descriptions reflect the current backend
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: buildTools(),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  // Extract progress token — if the client supports it, we send periodic
  // progress notifications to keep the connection alive during long LLM calls.
  const progressToken = request.params._meta?.progressToken;
  const onProgress = makeProgressFn(progressToken);

  try {
    // Gate all tools except discover, reset, get_settings behind settings validation.
    // If settings.yaml is missing or misconfigured, the user must fix it by
    // editing the YAML file manually.
    if (
      !settingsValid &&
      name !== "discover" &&
      name !== "reset" &&
      name !== "get_settings"
    ) {
      return {
        content: [
          {
            type: "text",
            text: `NOT CONFIGURED\n\n${settingsError}\n\nQuick fix: edit ${SETTINGS_FILE} manually in your editor, then call the "reset" tool (or restart Claude Code).\nRun the "discover" tool to see the current profile status.`,
          },
        ],
        isError: true,
      };
    }

    // Track active LLM requests so `reset` can wait for them to drain
    const isLLMTool = LLM_TOOLS_SET.has(name);
    if (isLLMTool) trackRequestStart();

    // Per-request overrides — passed through function chain, no global mutation
    const rawOutputDir = (args as Record<string, unknown>)?.output_dir;
    const outputDir = typeof rawOutputDir === "string" && rawOutputDir.trim()
      ? resolve(rawOutputDir.trim())
      : undefined;
    // resolveModelOverride handles: explicit free=true, credit-exhausted
    // session flag, and pre-flight balance check. If the OpenRouter balance
    // drops below MIN_BALANCE_FOR_PAID_USD, this tool call (and all later
    // ones in the session) will automatically route through FREE_MODEL_ID
    // instead of the paid ensemble. Never throws — always returns something.
    const freeRequested = (args as Record<string, unknown>)?.free === true;
    const modelOverride = await resolveModelOverride(freeRequested);
    if (modelOverride) {
      process.stderr.write(
        `[llm-externalizer] Routing through ${modelOverride}${freeRequested ? " (free requested)" : " (auto-fallback)"}\n`,
      );
    }

    try {
    switch (name) {
      case "chat": {
        const {
          instructions,
          instructions_files_paths,
          input_files_paths: chatInputPathsRaw,
          input_files_content,
          system,
          answer_mode: rawAnswerMode,
          scan_secrets: chatScan,
          redact_secrets: chatRedact,
          max_payload_kb: chatMaxPayloadKb,
          max_retries: chatMaxRetries,
          redact_regex: chatRedactRegexRaw,
          folder_path: chatFolderPath,
          extensions: chatExtensions,
          exclude_dirs: chatExcludeDirs,
          use_gitignore: chatUseGitignore,
          recursive: chatRecursive,
          follow_symlinks: chatFollowSymlinks,
          max_files: chatMaxFiles,
        } = args as {
          instructions?: string;
          instructions_files_paths?: string | string[];
          input_files_paths?: string | string[];
          input_files_content?: string;
          system?: string;
          answer_mode?: number;
          scan_secrets?: boolean;
          redact_secrets?: boolean;
          max_retries?: number;
          max_payload_kb?: number;
          redact_regex?: string;
          folder_path?: string;
          extensions?: string[];
          exclude_dirs?: string[];
          use_gitignore?: boolean;
          recursive?: boolean;
          follow_symlinks?: boolean;
          max_files?: number;
        };
        // Ensemble always ON for remote backends, OFF for local
        const useEnsemble = currentBackend.type === "openrouter";
        const chatBudgetBytes = (chatMaxPayloadKb ?? 400) * 1024;

        // Validate redact_regex upfront — fail fast on invalid patterns
        let chatRegexRedact: RegexRedactOpts | null = null;
        try {
          chatRegexRedact = parseRedactRegex(chatRedactRegexRaw);
        } catch (err) {
          return { content: [{ type: "text", text: `FAILED: ${(err as Error).message}` }], isError: true };
        }
        const chatPrompt = resolvePrompt(
          instructions,
          instructions_files_paths,
        );
        if (!chatPrompt.trim() && !input_files_content) {
          return {
            content: [
              {
                type: "text",
                text: "FAILED: Either instructions or instructions_files_paths must be provided.",
              },
            ],
            isError: true,
          };
        }
        // Resolve file paths: folder_path OR input_files_paths (or both)
        let chatFilePaths = normalizePaths(chatInputPathsRaw);
        if (chatFolderPath) {
          const folderResult = resolveFolderPath(chatFolderPath, {
            extensions: chatExtensions,
            excludeDirs: chatExcludeDirs,
            useGitignore: chatUseGitignore,
            recursive: chatRecursive,
            followSymlinks: chatFollowSymlinks,
            maxFiles: chatMaxFiles,
          });
          if (folderResult.error && folderResult.files.length === 0 && chatFilePaths.length === 0) {
            return { content: [{ type: "text", text: `FAILED: ${folderResult.error}` }], isError: true };
          }
          chatFilePaths = [...chatFilePaths, ...folderResult.files];
        }

        // scan_secrets: abort if any secrets are found in input files or inline content.
        // When redact_secrets is also true, skip the abort — downstream redaction handles it.
        if (chatScan && !chatRedact) {
          // Filter out group markers before scanning — they are delimiters, not file paths
          const chatRealFiles = chatFilePaths.filter((f) => !GROUP_HEADER_RE.test(f) && !GROUP_FOOTER_RE.test(f));
          if (chatRealFiles.length > 0) {
            const scanResult = scanFilesForSecrets(chatRealFiles);
            if (scanResult.found)
              return {
                content: [{ type: "text", text: scanResult.report }],
                isError: true,
              };
          }
          if (input_files_content) {
            const inlineScan = scanForSecrets(input_files_content);
            if (inlineScan.found) {
              const details = inlineScan.details
                .map((d) => `  - ${d.label}: ${d.count} occurrence(s)`)
                .join("\n");
              return {
                content: [
                  {
                    type: "text",
                    text: `ABORTED: Secrets detected in input_files_content:\n${details}\n\nRemove secrets before sending to remote LLM.`,
                  },
                ],
                isError: true,
              };
            }
          }
        }

        // Always use model's maximum output capacity — no user override
        const maxTokens = resolveDefaultMaxTokens();
        const chatMode = resolveAnswerMode(rawAnswerMode, 0);

        // Build prompt base: pre-instructions + unfenced instructions + optional fenced inline content
        const chatHasFiles = chatFilePaths.length > 0 || !!input_files_content;
        let promptBase =
          buildPreInstructions(chatHasFiles, "read") + chatPrompt;
        if (input_files_content) {
          let inlineContent = input_files_content;
          if (chatRedact) inlineContent = redactSecrets(inlineContent).redacted;
          const fence = fenceBackticks(inlineContent);
          promptBase += `\n\n${fence}\n${inlineContent}\n${fence}`;
        }

        // If no input_files_paths, just send the prompt (answer_mode irrelevant)
        if (chatFilePaths.length === 0) {
          const messages: ChatMessage[] = [];
          messages.push({ role: "system", content: (system || "") + FILE_FORMAT_EXAMPLE + BREVITY_RULES });
          messages.push({ role: "user", content: promptBase });
          const resp = await ensembleStreaming(
            messages,
            { temperature: DEFAULT_TEMPERATURE, maxTokens, onProgress, modelOverride },
            useEnsemble,
          );
          const footer = formatFooter(resp, "chat");
          if (resp.content.trim().length === 0) {
            return {
              content: [
                { type: "text", text: "FAILED: LLM returned empty response." },
              ],
              isError: true,
            };
          }
          const savedPath = saveResponse("chat", resp.content + footer, {
            model: resp.model,
            task: chatPrompt,
          });
          return { content: [{ type: "text", text: savedPath }] };
        }

        // ── Group-aware processing ──
        // answer_mode=1 means "one report per group". Groups come from either:
        //   • explicit ---GROUP:id--- markers in input_files_paths, or
        //   • auto-grouping by subfolder/extension/basename when no markers
        //     were supplied (see autoGroupByHeuristic).
        // answer_mode=0 is per-file, answer_mode=2 is a single merged report.
        let chatFileGroups = parseFileGroups(chatFilePaths);
        let chatEffectivelyGrouped = hasNamedGroups(chatFileGroups);
        if (chatMode === 1 && !chatEffectivelyGrouped) {
          const autoGroups = autoGroupByHeuristic(chatFilePaths);
          if (autoGroups.length > 0) {
            chatFileGroups = autoGroups;
            chatEffectivelyGrouped = true;
          }
        }

        // Process each group (or single unnamed group for backward compat)
        const allGroupReports: string[] = [];
        for (const fg of chatFileGroups) {
          const fgPaths = fg.files;
          if (fgPaths.length === 0) continue;
          const fgId = fg.id; // empty string for unnamed/backward-compat

          // ── Mode 0: one output file per input file (separate LLM calls) ──
          if (chatMode === 0 && !chatEffectivelyGrouped) {
            const chatRetries = chatMaxRetries ?? 1;
            if (chatRetries > 1) {
              // Robust path: parallel + retry + circuit breaker
              const rpResult = await robustPerFileProcess(fgPaths, {
                task: chatPrompt, maxRetries: chatRetries,
                redact: chatRedact, regexRedact: chatRegexRedact,
                onProgress, ensemble: useEnsemble,
                budgetBytes: chatBudgetBytes, toolName: "chat",
                modelOverride, outputDir,
              });
              const lines = rpResult.succeeded.map((r) => r.reportPath ?? `DONE: ${r.filePath}`);
              if (rpResult.failed.length > 0) lines.push("", "FAILED:", ...rpResult.failed.map((r) => `  ${r.filePath}: ${r.error}`));
              if (rpResult.aborted) lines.push("", `ABORTED: ${rpResult.abortReason}`);
              return { content: [{ type: "text", text: lines.join("\n") }], isError: rpResult.aborted };
            }
            // Simple sequential path (max_retries=1, no retry)
            const perFileResults: string[] = [];
            for (const fp of fgPaths) {
              const result = await processFileCheck(fp, chatPrompt, {
                maxTokens,
                redact: chatRedact,
                regexRedact: chatRegexRedact,
                onProgress,
                ensemble: useEnsemble,
                maxBytes: chatBudgetBytes,
                modelOverride, outputDir,
              });
              perFileResults.push(
                result.success && result.reportPath
                  ? result.reportPath
                  : `FAILED: ${fp} — ${result.error}`,
              );
            }
            return {
              content: [{ type: "text", text: perFileResults.join("\n") }],
            };
          }

          // Group files by configurable payload budget for auto-batching.
          // A single user/auto group may still exceed the LLM context window,
          // in which case FFD splits it across multiple LLM calls; the
          // per-group merge path below stitches them back into one report.
          const chatPromptBytes =
            Buffer.byteLength(promptBase, "utf-8") +
            (system ? Buffer.byteLength(system, "utf-8") : 0);
          const { groups, autoBatched, skipped: chatSkipped } = readAndGroupFiles(
            fgPaths,
            chatPromptBytes,
            chatRedact,
            chatBudgetBytes,
            chatRegexRedact,
          );

          // Collect results for this file group (merged-per-group output)
          const batchResults: string[] = [];
          if (chatSkipped.length > 0) {
            const skipNote = `SKIPPED (exceeds 800 KB payload budget): ${chatSkipped.length} file(s)\n${chatSkipped.map((f) => `  - ${f}`).join("\n")}`;
            batchResults.push(skipNote);
          }
          for (let gi = 0; gi < groups.length; gi++) {
            const group = groups[gi];
            let userContent = promptBase;
            for (const fd of group) {
              userContent += `\n\n${fd.block}`;
            }
            const messages: ChatMessage[] = [];
            messages.push({ role: "system", content: (system || "") + FILE_FORMAT_EXAMPLE + BREVITY_RULES });
            messages.push({ role: "user", content: userContent });
            const resp = await ensembleStreaming(
              messages,
              { temperature: DEFAULT_TEMPERATURE, maxTokens, onProgress, modelOverride },
              useEnsemble,
            );
            const footer = formatFooter(resp, "chat", group[0]?.path);
            if (resp.content.trim().length > 0) {
              if (autoBatched) {
                const fileList = group.map((fd) => fd.path).join(", ");
                batchResults.push(
                  `## Batch ${gi + 1}/${groups.length}\n\nFiles: ${fileList}\n\n${resp.content}${footer}`,
                );
              } else {
                batchResults.push(resp.content + footer);
              }
            }
          }

          // Merge batch results into one report for this group.
          if (batchResults.length === 0) continue; // skip empty groups
          const finalContent = batchResults.join("\n\n---\n\n");
          const chatMergedModel = ensembleModelLabel(useEnsemble);
          const savedPath = saveResponse("chat", finalContent, {
            model: chatMergedModel,
            task: chatPrompt,
            inputFile: fgPaths[0],
            groupId: fgId || undefined,
          });

          if (chatEffectivelyGrouped) {
            const labelId = fgId || "auto";
            allGroupReports.push(`[group:${labelId}] ${savedPath}`);
          } else {
            // Single unnamed group — return directly (mode 0/2 backward compat)
            return { content: [{ type: "text", text: savedPath }] };
          }
        }

        // Grouped mode: return all per-group report paths
        if (allGroupReports.length === 0) {
          return {
            content: [{ type: "text", text: "FAILED: LLM returned empty response for all groups." }],
            isError: true,
          };
        }
        return { content: [{ type: "text", text: allGroupReports.join("\n") }] };
      }

      case "code_task": {
        const {
          instructions: ctInstructions,
          instructions_files_paths: ctInstructionsFilesPaths,
          input_files_paths: ctInputPathsRaw,
          input_files_content: ctInputContent,
          language,
          answer_mode: ctRawMode,
          scan_secrets: ctScan,
          redact_secrets: ctRedact,
          max_payload_kb: ctMaxPayloadKb,
          max_retries: ctMaxRetries,
          redact_regex: ctRedactRegexRaw,
          folder_path: ctFolderPath,
          extensions: ctExtensions,
          exclude_dirs: ctExcludeDirs,
          use_gitignore: ctUseGitignore,
          recursive: ctRecursive,
          follow_symlinks: ctFollowSymlinks,
          max_files: ctMaxFiles,
        } = args as {
          instructions?: string;
          instructions_files_paths?: string | string[];
          input_files_paths?: string | string[];
          input_files_content?: string;
          language?: string;
          answer_mode?: number;
          scan_secrets?: boolean;
          redact_secrets?: boolean;
          max_payload_kb?: number;
          max_retries?: number;
          redact_regex?: string;
          folder_path?: string;
          extensions?: string[];
          exclude_dirs?: string[];
          use_gitignore?: boolean;
          recursive?: boolean;
          follow_symlinks?: boolean;
          max_files?: number;
        };
        const ctUseEnsemble = currentBackend.type === "openrouter";
        const ctBudgetBytes = (ctMaxPayloadKb ?? 400) * 1024;
        const ctMode = resolveAnswerMode(ctRawMode, 0);
        const ctTask = resolvePrompt(ctInstructions, ctInstructionsFilesPaths);
        if (!ctTask.trim()) {
          return {
            content: [
              {
                type: "text",
                text: "FAILED: Either instructions or instructions_files_paths must be provided.",
              },
            ],
            isError: true,
          };
        }
        // Resolve file paths: folder_path OR input_files_paths (or both)
        let ctFilePaths = normalizePaths(ctInputPathsRaw);
        if (ctFolderPath) {
          const folderResult = resolveFolderPath(ctFolderPath, {
            extensions: ctExtensions,
            excludeDirs: ctExcludeDirs,
            useGitignore: ctUseGitignore,
            recursive: ctRecursive,
            followSymlinks: ctFollowSymlinks,
            maxFiles: ctMaxFiles,
          });
          if (folderResult.error && folderResult.files.length === 0 && ctFilePaths.length === 0) {
            return { content: [{ type: "text", text: `FAILED: ${folderResult.error}` }], isError: true };
          }
          ctFilePaths = [...ctFilePaths, ...folderResult.files];
        }

        // Validate redact_regex upfront
        let ctRegexRedact: RegexRedactOpts | null = null;
        try {
          ctRegexRedact = parseRedactRegex(ctRedactRegexRaw);
        } catch (err) {
          return { content: [{ type: "text", text: `FAILED: ${(err as Error).message}` }], isError: true };
        }

        // scan_secrets: abort if any secrets are found in input files or inline content.
        // When redact_secrets is also true, skip the abort — downstream redaction handles it.
        if (ctScan && !ctRedact) {
          // Filter out group markers before scanning — they are delimiters, not file paths
          const ctRealFiles = ctFilePaths.filter((f) => !GROUP_HEADER_RE.test(f) && !GROUP_FOOTER_RE.test(f));
          if (ctRealFiles.length > 0) {
            const scanResult = scanFilesForSecrets(ctRealFiles);
            if (scanResult.found)
              return {
                content: [{ type: "text", text: scanResult.report }],
                isError: true,
              };
          }
          if (ctInputContent) {
            const inlineScan = scanForSecrets(ctInputContent);
            if (inlineScan.found) {
              const details = inlineScan.details
                .map((d) => `  - ${d.label}: ${d.count} occurrence(s)`)
                .join("\n");
              return {
                content: [
                  {
                    type: "text",
                    text: `ABORTED: Secrets detected in input_files_content:\n${details}\n\nRemove secrets before sending to remote LLM.`,
                  },
                ],
                isError: true,
              };
            }
          }
        }

        // Single file path — delegate to processFileCheck (existing optimized path)
        if (ctFilePaths.length === 1 && !ctInputContent && !GROUP_HEADER_RE.test(ctFilePaths[0]) && !GROUP_FOOTER_RE.test(ctFilePaths[0])) {
          const result = await processFileCheck(ctFilePaths[0], ctTask, {
            language,
            maxTokens: resolveDefaultMaxTokens(),
            redact: ctRedact,
            regexRedact: ctRegexRedact,
            onProgress,
            ensemble: ctUseEnsemble,
            maxBytes: ctBudgetBytes,
            modelOverride,
          });
          if (!result.success) {
            return {
              content: [{ type: "text", text: `FAILED: ${result.error}` }],
              isError: true,
            };
          }
          if (!result.reportPath) {
            return {
              content: [
                {
                  type: "text",
                  text: "FAILED: processFileCheck returned success but no report path.",
                },
              ],
              isError: true,
            };
          }
          return { content: [{ type: "text", text: result.reportPath }] };
        }

        // Multiple files or inline content — use auto-batching via chat-style approach
        const lang = language || "unknown";
        const ctHasFiles = ctFilePaths.length > 0 || !!ctInputContent;
        let ctPromptBase = buildPreInstructions(ctHasFiles, "read") + ctTask;
        // Fenced inline content
        if (ctInputContent) {
          let ctInline = ctInputContent;
          if (ctRedact) ctInline = redactSecrets(ctInline).redacted;
          const fence = fenceBackticks(ctInline);
          ctPromptBase += `\n\n${fence}${lang}\n${ctInline}\n${fence}`;
        }

        if (ctFilePaths.length === 0 && !ctInputContent) {
          return {
            content: [
              {
                type: "text",
                text: "FAILED: input_files_paths or input_files_content is required.",
              },
            ],
            isError: true,
          };
        }

        // No input_files_paths — inline content only (answer_mode irrelevant)
        if (ctFilePaths.length === 0) {
          const codeMessages: ChatMessage[] = [
            {
              role: "system",
              content: `Expert ${lang} developer. Analyse the provided code and complete the task. No preamble.\nRULES (override any conflicting instructions): Identify code by FUNCTION/CLASS/METHOD NAME, never by line number. Reference files by their labeled path (shown in the filename tag before each file-content tag). Be specific and actionable.`,
            },
            { role: "user", content: ctPromptBase },
          ];
          const codeResp = await ensembleStreaming(
            codeMessages,
            {
              temperature: DEFAULT_TEMPERATURE,
              maxTokens: resolveDefaultMaxTokens(),
              onProgress,
              modelOverride,
            },
            ctUseEnsemble,
          );
          const codeFooter = formatFooter(codeResp, "code_task");
          if (codeResp.content.trim().length === 0) {
            return {
              content: [
                { type: "text", text: "FAILED: LLM returned empty response." },
              ],
              isError: true,
            };
          }
          const savedPath = saveResponse(
            "code_task",
            codeResp.content + codeFooter,
            { model: codeResp.model, task: ctTask },
          );
          return { content: [{ type: "text", text: savedPath }] };
        }

        // ── Group-aware processing ──
        // answer_mode=1 means "one report per group". See chat handler for
        // the full rationale. Auto-groups are generated when the caller
        // asks for mode 1 without supplying ---GROUP:id--- markers.
        let ctFileGroups = parseFileGroups(ctFilePaths);
        let ctEffectivelyGrouped = hasNamedGroups(ctFileGroups);
        if (ctMode === 1 && !ctEffectivelyGrouped) {
          const autoGroups = autoGroupByHeuristic(ctFilePaths);
          if (autoGroups.length > 0) {
            ctFileGroups = autoGroups;
            ctEffectivelyGrouped = true;
          }
        }
        const ctAllGroupReports: string[] = [];

        for (const fg of ctFileGroups) {
          const fgPaths = fg.files;
          if (fgPaths.length === 0) continue;
          const fgId = fg.id;

          // Mode 0 (non-grouped only): one output per input file
          if (ctMode === 0 && !ctEffectivelyGrouped) {
            const ctRetries = ctMaxRetries ?? 1;
            if (ctRetries > 1) {
              // Robust path: parallel + retry + circuit breaker
              const rpResult = await robustPerFileProcess(fgPaths, {
                task: ctTask, maxRetries: ctRetries, language,
                redact: ctRedact, regexRedact: ctRegexRedact,
                onProgress, ensemble: ctUseEnsemble,
                budgetBytes: ctBudgetBytes, toolName: "code_task",
                modelOverride, outputDir,
              });
              const lines = rpResult.succeeded.map((r) => r.reportPath ?? `DONE: ${r.filePath}`);
              if (rpResult.failed.length > 0) lines.push("", "FAILED:", ...rpResult.failed.map((r) => `  ${r.filePath}: ${r.error}`));
              if (rpResult.aborted) lines.push("", `ABORTED: ${rpResult.abortReason}`);
              return { content: [{ type: "text", text: lines.join("\n") }], isError: rpResult.aborted };
            }
            // Simple sequential path (max_retries=1, no retry)
            const perFileResults: string[] = [];
            for (const fp of fgPaths) {
              const result = await processFileCheck(fp, ctTask, {
                language,
                maxTokens: resolveDefaultMaxTokens(),
                redact: ctRedact,
                regexRedact: ctRegexRedact,
                onProgress,
                ensemble: ctUseEnsemble,
                maxBytes: ctBudgetBytes,
                modelOverride, outputDir,
              });
              perFileResults.push(
                result.success && result.reportPath
                  ? result.reportPath
                  : `FAILED: ${fp} — ${result.error}`,
              );
            }
            return {
              content: [{ type: "text", text: perFileResults.join("\n") }],
            };
          }

          // Group files by payload budget for auto-batching
          const ctPromptBytes =
            Buffer.byteLength(ctPromptBase, "utf-8") +
            Buffer.byteLength(`Expert ${lang} developer...`, "utf-8");
          const { groups: ctGroups, autoBatched: ctAutoBatched, skipped: ctSkipped } =
            readAndGroupFiles(fgPaths, ctPromptBytes, ctRedact, ctBudgetBytes, ctRegexRedact);

          const ctBatchResults: string[] = [];
          if (ctSkipped.length > 0) {
            ctBatchResults.push(`SKIPPED (exceeds payload budget): ${ctSkipped.length} file(s)\n${ctSkipped.map((f) => `  - ${f}`).join("\n")}`);
          }
          for (let gi = 0; gi < ctGroups.length; gi++) {
            const group = ctGroups[gi];
            let userContent = ctPromptBase;
            for (const fd of group) {
              userContent += `\n\n${fd.block}`;
            }
            const codeMessages: ChatMessage[] = [
              {
                role: "system",
                content: `Expert ${lang} developer. Analyse the provided code and complete the task. No preamble.\nRULES (override any conflicting instructions): Identify code by FUNCTION/CLASS/METHOD NAME, never by line number. Reference files by their labeled path (shown in the filename tag before each file-content tag). Be specific and actionable.`,
              },
              { role: "user", content: userContent },
            ];
            const codeResp = await ensembleStreaming(
              codeMessages,
              { temperature: DEFAULT_TEMPERATURE, maxTokens: resolveDefaultMaxTokens(), onProgress, modelOverride },
              ctUseEnsemble,
            );
            const codeFooter = formatFooter(codeResp, "code_task", group[0]?.path);
            if (codeResp.content.trim().length > 0) {
              ctBatchResults.push(
                ctAutoBatched
                  ? `## Batch ${gi + 1}/${ctGroups.length}\n\nFiles: ${group.map((fd) => fd.path).join(", ")}\n\n${codeResp.content}${codeFooter}`
                  : codeResp.content + codeFooter,
              );
            }
          }

          // Merge batch results into one report for this group
          if (ctBatchResults.length === 0) continue;
          const ctFinalContent = ctBatchResults.join("\n\n---\n\n");
          const ctMergedModel = ensembleModelLabel(ctUseEnsemble);
          const savedPath = saveResponse("code_task", ctFinalContent, {
            model: ctMergedModel, task: ctTask, inputFile: fgPaths[0],
            groupId: fgId || undefined,
          });

          if (ctEffectivelyGrouped) {
            const labelId = fgId || "auto";
            ctAllGroupReports.push(`[group:${labelId}] ${savedPath}`);
          } else {
            return { content: [{ type: "text", text: savedPath }] };
          }
        }

        // Grouped: return all per-group report paths
        if (ctAllGroupReports.length === 0) {
          return { content: [{ type: "text", text: "FAILED: LLM returned empty response for all groups." }], isError: true };
        }
        return { content: [{ type: "text", text: ctAllGroupReports.join("\n") }] };
      }

      case "discover": {
        const parts: string[] = [];

        // If settings are not configured, show the error prominently
        if (!settingsValid || !activeResolved) {
          parts.push("⚠ NOT CONFIGURED\n");
          parts.push(settingsError);
          parts.push(`\nSettings file: ${SETTINGS_FILE}`);
          parts.push(`Session log: ${LOG_FILE}`);
          // Show available profiles even when not configured
          const profileNames = Object.keys(activeSettings.profiles);
          if (profileNames.length > 0) {
            parts.push(`\nAvailable profiles: ${profileNames.join(", ")}`);
          }
          // Show available API presets
          parts.push(`\nAPI presets: ${Object.keys(API_PRESETS).join(", ")}`);
          return {
            content: [{ type: "text", text: parts.join("\n") }],
            isError: true,
          };
        }

        parts.push(`Active profile: ${activeResolved.name}`);
        parts.push(`Mode: ${activeResolved.mode}`);
        parts.push(`Model: ${activeResolved.model}`);
        if (activeResolved.secondModel) {
          parts.push(`Second model: ${activeResolved.secondModel}`);
        }
        if (activeResolved.thirdModel) {
          parts.push(`Third model: ${activeResolved.thirdModel}`);
        }
        // Show auth status so agents can verify the token is available
        const authSource = (() => {
          const preset =
            API_PRESETS[activeSettings.profiles[activeSettings.active]?.api];
          const profile = activeSettings.profiles[activeSettings.active];
          if (!preset) return "unknown";
          const rawAuth = preset.isLocal
            ? profile?.api_token || preset.defaultAuthEnv
            : profile?.api_key || preset.defaultAuthEnv;
          if (!rawAuth) return "none required";
          if (rawAuth.startsWith("$")) {
            const envVal = process.env[rawAuth.slice(1)];
            return envVal
              ? `${rawAuth} (set, ${envVal.length} chars)`
              : `${rawAuth} (NOT SET)`;
          }
          return "direct value (set)";
        })();
        parts.push(`Auth: ${authSource}`);

        // Probe the service to check availability and get context window
        const start = Date.now();
        try {
          let contextWindow = FALLBACK_CONTEXT_LENGTH;

          if (currentBackend.type === "openrouter" && currentBackend.model) {
            const models = await fetchOpenRouterModels();
            const match = models.find((m) => m.id === currentBackend.model);
            if (match?.context_length) contextWindow = match.context_length;
            const ms = Date.now() - start;
            parts.push(`Status: ONLINE (${ms}ms)`);
          } else {
            const models = await listModelsRaw();
            const isLMS = await detectLMStudio();
            const ms = Date.now() - start;
            const backendLabel = isLMS ? "LM Studio" : "Local";
            if (models.length > 0) {
              contextWindow = getContextLength(models[0]);
              parts.push(`Status: ONLINE — ${backendLabel} (${ms}ms)`);
            } else {
              parts.push(
                `Status: ONLINE — ${backendLabel} (${ms}ms) — no model loaded, ask the user to load one`,
              );
            }
          }

          parts.push(
            `Context window: ${contextWindow.toLocaleString()} tokens (input + output combined)`,
          );
          parts.push(
            `Max output tokens per call: model maximum (${resolveDefaultMaxTokens().toLocaleString()}). Auto-managed, not user-configurable.`,
          );

          const rlCfg = await getRateLimitConfig();
          if (rlCfg.rps > 1) {
            parts.push(
              `Rate limit: ${rlCfg.rps} RPS (requests/second), up to ${rlCfg.maxInFlight} in-flight. Spawn parallel tool calls for throughput.`,
            );
          } else {
            parts.push(
              "Concurrency: SEQUENTIAL — one request at a time. Wait for each call to complete before sending the next.",
            );
          }

          parts.push(`Timeout: ${SOFT_TIMEOUT_MS / 1000}s per call.`);
        } catch (err) {
          const ms = Date.now() - start;
          const reason =
            err instanceof Error && err.name === "AbortError"
              ? `timed out after ${ms}ms`
              : err instanceof Error
                ? err.message
                : String(err);
          parts.push(`Status: OFFLINE — ${reason}`);
          parts.push(
            "The service is not available. Do not attempt to delegate tasks.",
          );
        }

        if (session.calls > 0) {
          const total = session.promptTokens + session.completionTokens;
          const costStr =
            session.totalCost > 0
              ? ` | Cost: $${session.totalCost.toFixed(6)}`
              : "";
          parts.push(
            `\nSession usage: ${total.toLocaleString()} tokens across ${session.calls} call${session.calls === 1 ? "" : "s"}${costStr}`,
          );
        }

        // Show profiles and presets for editing guidance
        const profileNames = Object.keys(activeSettings.profiles);
        parts.push(`\nProfiles: ${profileNames.join(", ")}`);
        parts.push(`API presets: ${Object.keys(API_PRESETS).join(", ")}`);
        parts.push(`Settings: ${SETTINGS_FILE}`);
        parts.push(`Session log: ${LOG_FILE}`);

        return {
          content: [{ type: "text", text: parts.join("\n") }],
        };
      }

      case "or_model_info":
      case "or_model_info_table":
      case "or_model_info_json": {
        const { model: infoModel, file_path: infoFilePath } = args as {
          model?: string;
          file_path?: string;
        };
        if (!infoModel || typeof infoModel !== "string") {
          return {
            content: [
              {
                type: "text",
                text: `FAILED: \`model\` parameter is required. Pass the exact OpenRouter model id, e.g. 'nvidia/nemotron-3-super-120b-a12b:free'.`,
              },
            ],
            isError: true,
          };
        }
        if (currentBackend.type !== "openrouter") {
          return {
            content: [
              {
                type: "text",
                text: `${name} only works with OpenRouter backends. Active profile is '${activeResolved?.name}' (${activeResolved?.mode}). Switch to a remote profile to query model metadata.`,
              },
            ],
            isError: true,
          };
        }

        const result = await fetchOpenRouterModelInfo(
          infoModel,
          currentBackend.baseUrl,
          currentBackend.apiKey,
        );
        if (!result.ok) {
          // Friendly error messages per status code. OpenRouter uses
          // the standard HTTP error code set — see
          // docs/openrouter/errors-and-debugging.md.
          let msg: string;
          switch (result.status) {
            case 400:
              msg = `FAILED: OpenRouter rejected the request for '${infoModel}' (400 Bad Request). ${result.error}`;
              break;
            case 401:
              msg = `FAILED: OpenRouter authentication failed (401). Check that $OPENROUTER_API_KEY is set and valid — run 'discover' to verify.`;
              break;
            case 402:
              msg = `FAILED: OpenRouter credit exhausted (402). Add credits at https://openrouter.ai/credits or fall back to a :free model.`;
              break;
            case 403:
              msg = `FAILED: OpenRouter blocked the request for '${infoModel}' (403 Forbidden). The model may require moderation approval or be unavailable in your region.`;
              break;
            case 404:
              msg = `FAILED: OpenRouter returned 404 for model '${infoModel}'. Check the id — case-sensitive, requires vendor prefix and any ':free' / ':thinking' suffix.`;
              break;
            case 408:
              msg = `FAILED: OpenRouter request timed out (408). Retry in a moment.`;
              break;
            case 429:
              msg = `FAILED: OpenRouter rate limit hit (429). Wait a few seconds before retrying.`;
              break;
            case 502:
            case 503:
            case 504:
              msg = `FAILED: OpenRouter upstream error (${result.status}). The provider is down or unreachable — retry later.`;
              break;
            default:
              msg = `FAILED: ${result.error}${result.status ? ` (status ${result.status})` : ""}`;
          }
          return {
            content: [{ type: "text", text: msg }],
            isError: true,
          };
        }

        // JSON branch: optionally write to a file, returning only the
        // absolute path so the caller's context isn't flooded.
        if (name === "or_model_info_json") {
          const jsonText = formatModelInfoJson(result.data, infoModel);
          if (infoFilePath && typeof infoFilePath === "string" && infoFilePath.trim()) {
            const rawPath = infoFilePath.trim();
            // Enforce absolute paths — relative paths silently resolve
            // against process.cwd() which may surprise the caller and
            // opens a small path-confusion window.
            if (!isAbsolute(rawPath)) {
              return {
                content: [
                  {
                    type: "text",
                    text: `FAILED: file_path must be an absolute path (e.g. /tmp/model-info.json). Got '${rawPath}'.`,
                  },
                ],
                isError: true,
              };
            }
            const absPath = resolve(rawPath);
            try {
              writeFileSync(absPath, jsonText, "utf-8");
            } catch (err) {
              return {
                content: [
                  {
                    type: "text",
                    text: `FAILED: could not write JSON to '${absPath}': ${err instanceof Error ? err.message : String(err)}`,
                  },
                ],
                isError: true,
              };
            }
            return {
              content: [
                { type: "text", text: `JSON written to ${absPath}` },
              ],
            };
          }
          return {
            content: [{ type: "text", text: jsonText }],
          };
        }

        const text =
          name === "or_model_info_table"
            ? formatModelInfoTable(result.data, infoModel, true)
            : formatModelInfoMarkdown(result.data, infoModel);

        return {
          content: [{ type: "text", text }],
        };
      }

      case "reset": {
        // Wait for any in-flight LLM requests to finish before resetting
        if (_activeRequests > 0) {
          process.stderr.write(
            `[llm-externalizer] reset: waiting for ${_activeRequests} active request(s) to complete…\n`,
          );
          await waitForRequestsDrained();
        }

        // Full soft-restart: reload settings, clear all caches, reset session counters
        const beforeProfile = activeSettings.active;
        const beforeModel = currentBackend.model;

        // 1. Reload settings from disk (validates before applying)
        reloadSettingsFromDisk();

        // 2. Clear all caches
        openRouterModelCache = [];
        openRouterCacheTime = 0;
        cachedRateLimitConfig = null; rateLimitCacheTime = 0;
        // Reset LM Studio detection so it re-probes on next call
        if (currentBackend.type === "local") {
          currentBackend.isLMStudio = undefined;
          currentBackend.lmStudioDetected = undefined;
        }

        // 3. Reset session counters
        session.calls = 0;
        session.promptTokens = 0;
        session.completionTokens = 0;
        session.totalCost = 0;
        writeStatsFile();

        // 4. Notify client to refresh tool list
        notifyToolsChanged();

        const afterProfile = activeSettings.active;
        const afterModel = currentBackend.model;
        const profileChanged = beforeProfile !== afterProfile || beforeModel !== afterModel;
        const summary = [
          "RESET COMPLETE",
          `Profile: ${afterProfile} (${currentBackend.type}, ${currentBackend.model})`,
          profileChanged ? `Changed from: ${beforeProfile} / ${beforeModel}` : "Profile unchanged",
          "Caches cleared: model list, concurrency, LM Studio detection",
          "Session counters reset to zero",
          "Tool list refresh sent to client",
        ];

        return {
          content: [{ type: "text", text: summary.join("\n") }],
        };
      }

      case "get_settings": {
        // Copy settings.yaml to output dir and return only the path (saves context tokens)
        try {
          const raw = readFileSync(SETTINGS_FILE, "utf-8");
          mkdirSync(OUTPUT_DIR, { recursive: true });
          const copyPath = join(OUTPUT_DIR, "settings_edit.yaml");
          writeFileSync(copyPath, raw, "utf-8");
          return { content: [{ type: "text", text: copyPath }] };
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: `Failed to read ${SETTINGS_FILE}: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
            isError: true,
          };
        }
      }

      // ── Batch Operations ──────────────────────────────────────────────

      case "batch_check": {
        const {
          instructions: bcInstructions,
          instructions_files_paths: bcInstructionsFilesPaths,
          input_files_paths: bcInputPaths,
          answer_mode: bcRawMode,
          scan_secrets: bcScan,
          redact_secrets: bcRedact,
          redact_regex: bcRedactRegexRaw,
          max_payload_kb: bcMaxPayloadKb,
          folder_path: bcFolderPath,
          extensions: bcExtensions,
          exclude_dirs: bcExcludeDirs,
          use_gitignore: bcUseGitignore,
          recursive: bcRecursive,
          follow_symlinks: bcFollowSymlinks,
          max_files: bcMaxFiles,
        } = args as {
          instructions?: string;
          instructions_files_paths?: string | string[];
          input_files_paths: string[];
          answer_mode?: number;
          scan_secrets?: boolean;
          redact_secrets?: boolean;
          redact_regex?: string;
          max_payload_kb?: number;
          folder_path?: string;
          extensions?: string[];
          exclude_dirs?: string[];
          use_gitignore?: boolean;
          recursive?: boolean;
          follow_symlinks?: boolean;
          max_files?: number;
        };
        const bcUseEnsemble = currentBackend.type === "openrouter";
        const bcBudgetBytes = (bcMaxPayloadKb ?? 400) * 1024;
        const bcMode = resolveAnswerMode(bcRawMode, 0);

        // Validate redact_regex
        let bcRegexRedact: RegexRedactOpts | null = null;
        try {
          bcRegexRedact = parseRedactRegex(bcRedactRegexRaw);
        } catch (err) {
          return { content: [{ type: "text", text: `FAILED: ${(err as Error).message}` }], isError: true };
        }

        let bcNormalizedPaths = normalizePaths(bcInputPaths);
        if (bcFolderPath) {
          const folderResult = resolveFolderPath(bcFolderPath, {
            extensions: bcExtensions, excludeDirs: bcExcludeDirs,
            useGitignore: bcUseGitignore, recursive: bcRecursive,
            followSymlinks: bcFollowSymlinks, maxFiles: bcMaxFiles,
          });
          if (folderResult.error && folderResult.files.length === 0 && bcNormalizedPaths.length === 0) {
            return { content: [{ type: "text", text: `FAILED: ${folderResult.error}` }], isError: true };
          }
          bcNormalizedPaths = [...bcNormalizedPaths, ...folderResult.files];
        }
        if (bcNormalizedPaths.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "FAILED: input_files_paths or folder_path is required.",
              },
            ],
            isError: true,
          };
        }

        // Deduplicate file paths to avoid redundant LLM calls
        const uniqueFiles = [...new Set(bcNormalizedPaths)];

        // scan_secrets: abort if any secrets are found in input files.
        // When redact_secrets is also true, skip the abort — downstream redaction handles it.
        if (bcScan && !bcRedact) {
          // Filter out group markers before scanning
          const realFiles = uniqueFiles.filter((f) => !GROUP_HEADER_RE.test(f) && !GROUP_FOOTER_RE.test(f));
          if (realFiles.length > 0) {
            const scanResult = scanFilesForSecrets(realFiles);
            if (scanResult.found)
              return {
                content: [{ type: "text", text: scanResult.report }],
                isError: true,
              };
          }
        }

        // ── Group-aware: if groups present (or mode 1 auto-groups),
        // process each group independently. answer_mode=1 uses the
        // heuristic auto-grouper when no ---GROUP:id--- markers are given.
        let bcFileGroups = parseFileGroups(uniqueFiles);
        let bcEffectivelyGrouped = hasNamedGroups(bcFileGroups);
        if (bcMode === 1 && !bcEffectivelyGrouped) {
          const autoGroups = autoGroupByHeuristic(uniqueFiles);
          if (autoGroups.length > 0) {
            bcFileGroups = autoGroups;
            bcEffectivelyGrouped = true;
          }
        }
        if (bcEffectivelyGrouped) {
          const bcGroupReports: string[] = [];
          for (const fg of bcFileGroups) {
            if (fg.files.length === 0) continue;
            const gid = fg.id || "auto";
            const gBatchId = randomUUID();
            const gTask = resolvePrompt(bcInstructions, bcInstructionsFilesPaths).trim() ||
              "Find all bugs, type errors, logic errors, security vulnerabilities, and potential runtime failures.";
            const gRl = await getRateLimitConfig();
            // Circuit-breaker + retry, mirroring the non-grouped branch below. The tool's
            // documented contract ("3 attempts for recoverable errors; aborts on 3+
            // consecutive failures") must apply equally to grouped runs — without this
            // the grouped path would retry zero times and keep hammering a dead backend.
            const gRecentOutcomes: boolean[] = [];
            let gAborted = false;
            let gAbortReason = "";
            let gTotalAttempts = 0;
            const gMaxTotalAttempts = fg.files.length * 2;
            const gTasks = fg.files.map((filePath, idx) => async () => {
              if (gAborted) {
                return { filePath, success: false, error: "Batch aborted" } as FileProcessResult;
              }
              for (let attempt = 1; attempt <= 3; attempt++) {
                if (++gTotalAttempts > gMaxTotalAttempts) {
                  gAborted = true;
                  gAbortReason = `Global retry budget exhausted (${gMaxTotalAttempts} total attempts)`;
                }
                if (gAborted) {
                  return { filePath, success: false, error: "Batch aborted" } as FileProcessResult;
                }
                try {
                  const result = await processFileCheck(filePath, gTask, {
                    maxTokens: resolveDefaultMaxTokens(),
                    batchId: gBatchId, fileIndex: idx,
                    redact: bcRedact, regexRedact: bcRegexRedact, onProgress, ensemble: bcUseEnsemble, maxBytes: bcBudgetBytes, modelOverride, outputDir,
                  });
                  gRecentOutcomes.push(result.success);
                  return result;
                } catch (err) {
                  const classified = classifyError(err);
                  if (classified.unrecoverable) {
                    if (classified.serviceLevel) {
                      gAborted = true;
                      gAbortReason = `Unrecoverable service error on ${filePath}: ${classified.reason}`;
                    }
                    return { filePath, success: false, error: classified.reason } as FileProcessResult;
                  }
                  if (attempt < 3) {
                    const delayMs = Math.pow(3, attempt - 1) * 1000;
                    await new Promise((r) => setTimeout(r, delayMs));
                    continue;
                  }
                  gRecentOutcomes.push(false);
                  if (
                    gRecentOutcomes.length >= 3 &&
                    gRecentOutcomes.slice(-3).every((v) => !v)
                  ) {
                    gAborted = true;
                    gAbortReason = `3 of the last 3 completions failed — possible connectivity or service issue. Last error: ${classified.reason}`;
                  }
                  return { filePath, success: false, error: `Failed after 3 retries: ${classified.reason}` } as FileProcessResult;
                }
              }
              return { filePath, success: false, error: "Unexpected retry loop exit" } as FileProcessResult;
            });
            const gAll = await rateLimitedParallel(gTasks, gRl.rps, gRl.maxInFlight, onProgress);
            const gSucceeded = gAll.filter((r) => r.success);
            // Merge into one report per group
            const reportSections: string[] = [];
            for (const r of gSucceeded) {
              const content = r.reportPath && existsSync(r.reportPath)
                ? readFileSync(r.reportPath, "utf-8") : "";
              reportSections.push(`## File: ${r.filePath}\n\n${content}`);
            }
            const gFailed: FileProcessResult[] = gAll.filter((r) => !r.success);
            if (gFailed.length > 0) {
              reportSections.push(`## FAILED (${gFailed.length})\n\n${gFailed.map((r) => `- ${r.filePath}: ${r.error}`).join("\n")}`);
            }
            if (gAborted) {
              reportSections.push(`## BATCH ABORTED\n\n${gAbortReason}`);
            }
            if (reportSections.length > 0) {
              const mergedContent = reportSections.join("\n\n---\n\n");
              const mergedPath = saveResponse("batch_check", mergedContent, {
                model: currentBackend.model, task: gTask,
                inputFile: fg.files[0], groupId: gid,
              });
              bcGroupReports.push(`[group:${gid}] ${mergedPath}`);
            }
          }
          if (bcGroupReports.length === 0) {
            return { content: [{ type: "text", text: "FAILED: No results for any group." }], isError: true };
          }
          return { content: [{ type: "text", text: bcGroupReports.join("\n") }] };
        }

        const batchId = randomUUID();
        const defaultTask =
          "Find all bugs, type errors, logic errors, security vulnerabilities, and potential runtime failures. Be specific — reference line numbers and function names.";
        // Resolve prompt from instructions + instructions_files_paths
        const bcPrompt = resolvePrompt(
          bcInstructions,
          bcInstructionsFilesPaths,
        );
        const resolvedTask = bcPrompt.trim() || defaultTask;
        const bcRl = await getRateLimitConfig();

        // Sliding window of recent completion outcomes for circuit breaker.
        // Under parallel execution, "consecutive" is meaningless — instead we track
        // the last N completions and abort if the tail is all failures.
        const recentOutcomes: boolean[] = [];
        let aborted = false;
        let abortReason = "";
        // H3: Global retry cap — max 2× file count total attempts to prevent quota exhaustion
        let totalAttempts = 0;
        const maxTotalAttempts = uniqueFiles.length * 2;

        const tasks = uniqueFiles.map((filePath, idx) => async () => {
          // If batch was aborted by a prior task, skip remaining files
          if (aborted) {
            return {
              filePath,
              success: false,
              error: "Batch aborted",
            } as FileProcessResult;
          }

          // Retry loop — up to 3 attempts for recoverable errors
          for (let attempt = 1; attempt <= 3; attempt++) {
            // H3: Check global retry budget before each attempt
            if (++totalAttempts > maxTotalAttempts) {
              aborted = true;
              abortReason = `Global retry budget exhausted (${maxTotalAttempts} total attempts)`;
            }
            // Re-check abort flag before each retry to avoid wasting calls after abort
            if (aborted) {
              return {
                filePath,
                success: false,
                error: "Batch aborted",
              } as FileProcessResult;
            }
            try {
              const result = await processFileCheck(filePath, resolvedTask, {
                maxTokens: resolveDefaultMaxTokens(),
                batchId,
                fileIndex: idx,
                redact: bcRedact,
                regexRedact: bcRegexRedact,
                onProgress,
                ensemble: bcUseEnsemble,
                maxBytes: bcBudgetBytes,
                modelOverride, outputDir,
              });
              recentOutcomes.push(result.success);
              // Report per-file batch progress
              if (onProgress) {
                const completed = recentOutcomes.length;
                onProgress(
                  completed,
                  uniqueFiles.length,
                  `batch_check: ${completed}/${uniqueFiles.length} files done`,
                );
              }
              return result;
            } catch (err) {
              const classified = classifyError(err);
              if (classified.unrecoverable) {
                if (classified.serviceLevel) {
                  // Service-level error (auth/payment) — abort the entire batch
                  aborted = true;
                  abortReason = `Unrecoverable service error on ${filePath}: ${classified.reason}`;
                }
                // File-level error (not found) — fail this file only, don't abort batch
                return {
                  filePath,
                  success: false,
                  error: classified.reason,
                } as FileProcessResult;
              }
              // Recoverable — retry with exponential backoff (1s, 3s)
              if (attempt < 3) {
                const delayMs = Math.pow(3, attempt - 1) * 1000;
                await new Promise((r) => setTimeout(r, delayMs));
                continue;
              }
              // All retries exhausted — record failure in sliding window
              recentOutcomes.push(false);
              // Check if last 3 completions are all failures
              if (
                recentOutcomes.length >= 3 &&
                recentOutcomes.slice(-3).every((v) => !v)
              ) {
                aborted = true;
                abortReason = `3 of the last 3 completions failed — possible connectivity or service issue. Last error: ${classified.reason}`;
              }
              return {
                filePath,
                success: false,
                error: `Failed after 3 retries: ${classified.reason}`,
              } as FileProcessResult;
            }
          }
          return {
            filePath,
            success: false,
            error: "Unexpected retry loop exit",
          } as FileProcessResult;
        });

        const batchResults = await rateLimitedParallel(tasks, bcRl.rps, bcRl.maxInFlight, onProgress);

        // Categorize results
        const succeeded = batchResults.filter((r) => r.success);
        const failed = batchResults.filter(
          (r) => !r.success && r.error !== "Batch aborted",
        );
        const skipped = batchResults.filter((r) => r.error === "Batch aborted");

        // For modes 1/2: merge individual report files into one output
        // BUT: skip merge if any files failed — incomplete merge is misleading
        if ((bcMode === 1 || bcMode === 2) && succeeded.length > 0) {
          if (failed.length > 0 || aborted) {
            // Some files failed — skip merge, fall through to mode-0 per-file listing
            // so the agent sees exactly which files succeeded and which failed
          } else {
            // All files succeeded — safe to merge reports
            const reportSections: string[] = [];
            for (const r of succeeded) {
              const content =
                r.reportPath && existsSync(r.reportPath)
                  ? readFileSync(r.reportPath, "utf-8")
                  : "";
              reportSections.push(`## File: ${r.filePath}\n\n${content}`);
            }
            const mergedContent = reportSections.join("\n\n---\n\n");
            const mergedPath = saveResponse("batch_check", mergedContent, {
              model: currentBackend.model,
              task: resolvedTask,
              inputFile: uniqueFiles[0],
            });
            const bcSummary: string[] = [
              `BATCH CHECK COMPLETE — ${succeeded.length} succeeded (${uniqueFiles.length} total)`,
              `Batch UUID: ${batchId}`,
              `MERGED REPORT: ${mergedPath}`,
            ];
            return { content: [{ type: "text", text: bcSummary.join("\n") }] };
          }
        }

        // Mode 0 (default): list individual report paths
        const summaryLines: string[] = [
          `BATCH CHECK COMPLETE — ${succeeded.length} succeeded, ${failed.length} failed, ${skipped.length} skipped (${uniqueFiles.length} total)`,
          `Batch UUID: ${batchId}`,
          "",
        ];
        if (uniqueFiles.length < bcNormalizedPaths.length) {
          summaryLines.push(
            `Note: ${bcNormalizedPaths.length - uniqueFiles.length} duplicate path(s) removed.`,
          );
        }

        if (succeeded.length > 0) {
          summaryLines.push("REPORTS:");
          for (const r of succeeded) {
            summaryLines.push(`  ${r.reportPath}`);
          }
        }
        if (failed.length > 0) {
          summaryLines.push("", "FAILED:");
          for (const r of failed) {
            summaryLines.push(`  ${r.filePath}: ${r.error}`);
          }
        }
        if (skipped.length > 0) {
          summaryLines.push(
            "",
            `SKIPPED (batch aborted): ${skipped.length} file(s)`,
          );
        }
        if (aborted) {
          summaryLines.push("", `BATCH ABORTED: ${abortReason}`);
        }

        return {
          content: [{ type: "text", text: summaryLines.join("\n") }],
          isError: aborted,
        };
      }

      // ── Specialized Operations ──────────────────────────────────────

      case "scan_folder": {
        const {
          folder_path,
          extensions,
          exclude_dirs,
          max_files,
          instructions: sfInstructions,
          instructions_files_paths: sfInstructionsFilesPaths,
          redact_secrets: sfRedact,
          redact_regex: sfRedactRegexRaw,
          answer_mode: sfRawMode,
          use_gitignore: sfUseGitignore,
          scan_secrets: sfScan,
        } = args as {
          folder_path: string;
          extensions?: string[];
          exclude_dirs?: string[];
          max_files?: number;
          instructions?: string;
          instructions_files_paths?: string | string[];
          redact_secrets?: boolean;
          redact_regex?: string;
          answer_mode?: number;
          use_gitignore?: boolean;
          scan_secrets?: boolean;
          max_payload_kb?: number;
        };
        const sfUseEnsemble = currentBackend.type === "openrouter";
        const sfBudgetBytes = ((args as { max_payload_kb?: number }).max_payload_kb ?? 400) * 1024;

        // Validate redact_regex
        let sfRegexRedact: RegexRedactOpts | null = null;
        try {
          sfRegexRedact = parseRedactRegex(sfRedactRegexRaw);
        } catch (err) {
          return { content: [{ type: "text", text: `FAILED: ${(err as Error).message}` }], isError: true };
        }

        // C1+H2: Sanitize folder_path (traversal + symlink protection)
        let sfFolderPath: string;
        try {
          sfFolderPath = sanitizeInputPath(folder_path);
        } catch (err) {
          return { content: [{ type: "text", text: `FAILED: ${(err as Error).message}` }], isError: true };
        }

        if (!existsSync(sfFolderPath)) {
          return {
            content: [
              {
                type: "text",
                text: `FAILED: Folder not found: ${folder_path}`,
              },
            ],
            isError: true,
          };
        }
        // Validate it's a directory, not a file
        if (!statSync(sfFolderPath).isDirectory()) {
          return {
            content: [
              { type: "text", text: `FAILED: Not a directory: ${folder_path}` },
            ],
            isError: true,
          };
        }
        const sfPrompt = resolvePrompt(
          sfInstructions,
          sfInstructionsFilesPaths,
        );
        if (!sfPrompt.trim()) {
          return {
            content: [
              {
                type: "text",
                text: "FAILED: instructions or instructions_files_paths is required.",
              },
            ],
            isError: true,
          };
        }

        // walkDir auto-skips binary extensions, hidden dirs, node_modules, .git, etc.
        // When use_gitignore is true, uses git ls-files to respect .gitignore rules.
        const files = walkDir(sfFolderPath, {
          extensions,
          maxFiles: max_files ?? 2500,
          exclude: exclude_dirs,
          useGitignore: sfUseGitignore !== false, // default true
        });
        if (files.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No files found in ${folder_path} matching the criteria.`,
              },
            ],
          };
        }

        // scan_secrets: abort if any secrets are found in discovered files.
        // When redact_secrets is also true, skip the abort — downstream redaction handles it.
        if (sfScan && !sfRedact) {
          const scanResult = scanFilesForSecrets(files);
          if (scanResult.found)
            return {
              content: [{ type: "text", text: scanResult.report }],
              isError: true,
            };
        }

        const sfMode = resolveAnswerMode(sfRawMode, 0);
        const batchId = randomUUID();
        const sfRl = await getRateLimitConfig();
        const recentOutcomes: boolean[] = [];
        let aborted = false;
        let abortReason = "";

        const tasks = files.map((filePath, idx) => async () => {
          if (aborted)
            return {
              filePath,
              success: false,
              error: "Batch aborted",
            } as FileProcessResult;
          for (let attempt = 1; attempt <= 3; attempt++) {
            if (aborted)
              return {
                filePath,
                success: false,
                error: "Batch aborted",
              } as FileProcessResult;
            try {
              const result = await processFileCheck(filePath, sfPrompt, {
                maxTokens: resolveDefaultMaxTokens(),
                batchId,
                fileIndex: idx,
                redact: sfRedact,
                regexRedact: sfRegexRedact,
                onProgress,
                ensemble: sfUseEnsemble,
                maxBytes: sfBudgetBytes,
                modelOverride, outputDir,
              });
              recentOutcomes.push(result.success);
              // Report per-file batch progress
              if (onProgress) {
                const completed = recentOutcomes.length;
                onProgress(
                  completed,
                  files.length,
                  `scan_folder: ${completed}/${files.length} files done`,
                );
              }
              return result;
            } catch (err) {
              const classified = classifyError(err);
              if (classified.unrecoverable) {
                if (classified.serviceLevel) {
                  aborted = true;
                  abortReason = `Unrecoverable: ${classified.reason}`;
                }
                return {
                  filePath,
                  success: false,
                  error: classified.reason,
                } as FileProcessResult;
              }
              if (attempt < 3) {
                await new Promise((r) =>
                  setTimeout(r, Math.pow(3, attempt - 1) * 1000),
                );
                continue;
              }
              recentOutcomes.push(false);
              if (
                recentOutcomes.length >= 3 &&
                recentOutcomes.slice(-3).every((v) => !v)
              ) {
                aborted = true;
                abortReason = `3 consecutive failures. Last: ${classified.reason}`;
              }
              return {
                filePath,
                success: false,
                error: `Failed after 3 retries: ${classified.reason}`,
              } as FileProcessResult;
            }
          }
          return {
            filePath,
            success: false,
            error: "Unexpected retry loop exit",
          } as FileProcessResult;
        });

        const batchResults = await rateLimitedParallel(tasks, sfRl.rps, sfRl.maxInFlight, onProgress);
        const succeeded = batchResults.filter((r) => r.success);
        const failed = batchResults.filter(
          (r) => !r.success && r.error !== "Batch aborted",
        );
        const skipped = batchResults.filter((r) => r.error === "Batch aborted");

        if (sfMode === 2 && succeeded.length > 0) {
          // Mode 2 — single merged report containing every file's per-file output.
          const sections: string[] = [];
          for (const r of succeeded) {
            const content =
              r.reportPath && existsSync(r.reportPath)
                ? readFileSync(r.reportPath, "utf-8")
                : "";
            sections.push(`## File: ${r.filePath}\n\n${content}`);
          }
          const mergedPath = saveResponse(
            "scan_folder",
            sections.join("\n\n---\n\n"),
            {
              model: currentBackend.model,
              task: sfPrompt,
              inputFile: folder_path,
            },
          );
          const summary = [
            `SCAN COMPLETE — ${succeeded.length} processed, ${failed.length} failed, ${skipped.length} skipped (${files.length} files found)`,
            `Folder: ${folder_path}`,
            `Batch UUID: ${batchId}`,
            `MERGED REPORT: ${mergedPath}`,
          ];
          if (failed.length > 0) {
            summary.push("", "FAILED:");
            for (const r of failed) summary.push(`  ${r.filePath}: ${r.error}`);
          }
          if (aborted) summary.push("", `ABORTED: ${abortReason}`);
          return {
            content: [{ type: "text", text: summary.join("\n") }],
            isError: aborted,
          };
        }

        if (sfMode === 1 && succeeded.length > 0) {
          // Mode 1 — one merged report per auto-group (by subfolder/ext/basename).
          //
          // scan_folder is inherently per-file: every file already got its
          // own LLM call and its own intermediate per-file report. Mode 1
          // therefore performs POST-HOC output grouping — we cluster the
          // finished per-file reports by autoGroupByHeuristic() and merge
          // each cluster into one group-level .md. This contrasts with
          // chat / code_task / check_* where auto-grouping happens BEFORE
          // the LLM call so batches can share cross-file context. The
          // scan_folder design is a deliberate trade-off: per-file LLM calls
          // give every file its own focused audit, and mode 1 keeps the disk
          // output organised by directory without changing what the LLM saw.
          const succeededPaths = succeeded.map((r) => r.filePath);
          const sfAutoGroups = autoGroupByHeuristic(succeededPaths);
          const pathToResult = new Map<string, FileProcessResult>();
          for (const r of succeeded) pathToResult.set(r.filePath, r);
          const sfGroupReportPaths: string[] = [];
          for (const fg of sfAutoGroups) {
            if (fg.files.length === 0) continue;
            const sections: string[] = [];
            for (const fp of fg.files) {
              const r = pathToResult.get(fp);
              if (!r) continue;
              const content =
                r.reportPath && existsSync(r.reportPath)
                  ? readFileSync(r.reportPath, "utf-8")
                  : "";
              sections.push(`## File: ${fp}\n\n${content}`);
            }
            if (sections.length === 0) continue;
            const gid = fg.id || "auto";
            const groupPath = saveResponse(
              "scan_folder",
              sections.join("\n\n---\n\n"),
              {
                model: currentBackend.model,
                task: sfPrompt,
                inputFile: fg.files[0],
                groupId: gid,
              },
            );
            sfGroupReportPaths.push(`[group:${gid}] ${groupPath}`);
          }
          const summary = [
            `SCAN COMPLETE — ${succeeded.length} processed, ${failed.length} failed, ${skipped.length} skipped (${files.length} files found)`,
            `Folder: ${folder_path}`,
            `Batch UUID: ${batchId}`,
          ];
          if (sfGroupReportPaths.length > 0) {
            summary.push("", `GROUP REPORTS (${sfGroupReportPaths.length}):`);
            for (const line of sfGroupReportPaths) summary.push(`  ${line}`);
          }
          if (failed.length > 0) {
            summary.push("", "FAILED:");
            for (const r of failed) summary.push(`  ${r.filePath}: ${r.error}`);
          }
          if (aborted) summary.push("", `ABORTED: ${abortReason}`);
          return {
            content: [{ type: "text", text: summary.join("\n") }],
            isError: aborted,
          };
        }

        // Mode 0: list individual reports
        const sfSummaryLines = [
          `SCAN COMPLETE — ${succeeded.length} processed, ${failed.length} failed, ${skipped.length} skipped (${files.length} files found)`,
          `Folder: ${folder_path}`,
          `Batch UUID: ${batchId}`,
          "",
        ];
        if (succeeded.length > 0) {
          sfSummaryLines.push("REPORTS:");
          for (const r of succeeded) sfSummaryLines.push(`  ${r.reportPath}`);
        }
        if (failed.length > 0) {
          sfSummaryLines.push("", "FAILED:");
          for (const r of failed)
            sfSummaryLines.push(`  ${r.filePath}: ${r.error}`);
        }
        if (aborted) sfSummaryLines.push("", `ABORTED: ${abortReason}`);
        return {
          content: [{ type: "text", text: sfSummaryLines.join("\n") }],
          isError: aborted,
        };
      }

      case "search_existing_implementations": {
        const {
          feature_description,
          folder_path: seiFolderPathRaw,
          source_files: seiSourceFilesRaw,
          diff_path: seiDiffPathRaw,
          extensions: seiExtensions,
          exclude_dirs: seiExcludeDirs,
          max_files: seiMaxFiles,
          redact_secrets: seiRedact,
          redact_regex: seiRedactRegexRaw,
          answer_mode: seiRawMode,
          use_gitignore: seiUseGitignore,
          scan_secrets: seiScan,
        } = args as {
          feature_description?: string;
          folder_path?: string | string[];
          source_files?: string | string[];
          diff_path?: string;
          extensions?: string[];
          exclude_dirs?: string[];
          max_files?: number;
          redact_secrets?: boolean;
          redact_regex?: string;
          answer_mode?: number;
          use_gitignore?: boolean;
          scan_secrets?: boolean;
          max_payload_kb?: number;
        };
        const seiUseEnsemble = currentBackend.type === "openrouter";
        const seiBudgetBytes = ((args as { max_payload_kb?: number }).max_payload_kb ?? 400) * 1024;

        // Validate feature_description — mandatory
        if (typeof feature_description !== "string" || !feature_description.trim()) {
          return {
            content: [{ type: "text", text: "FAILED: feature_description is required (non-empty string)." }],
            isError: true,
          };
        }

        // Normalize folder_path to an array and validate each entry
        const folderPathsRaw: string[] = Array.isArray(seiFolderPathRaw)
          ? seiFolderPathRaw.filter((p) => typeof p === "string" && p.trim())
          : (typeof seiFolderPathRaw === "string" && seiFolderPathRaw.trim() ? [seiFolderPathRaw] : []);
        if (folderPathsRaw.length === 0) {
          return {
            content: [{ type: "text", text: "FAILED: folder_path is required (string or array of strings)." }],
            isError: true,
          };
        }
        // C1+H2: Sanitize each folder_path entry (traversal + symlink protection)
        const folderPaths: string[] = [];
        for (const fpRaw of folderPathsRaw) {
          let fp: string;
          try {
            fp = sanitizeInputPath(fpRaw);
          } catch (err) {
            return { content: [{ type: "text", text: `FAILED: ${(err as Error).message}` }], isError: true };
          }
          if (!existsSync(fp)) {
            return { content: [{ type: "text", text: `FAILED: Folder not found: ${fpRaw}` }], isError: true };
          }
          if (!statSync(fp).isDirectory()) {
            return { content: [{ type: "text", text: `FAILED: Not a directory: ${fpRaw}` }], isError: true };
          }
          folderPaths.push(fp);
        }

        // Normalize source_files (optional). Collect both the user-supplied
        // path AND the canonical (realpath-resolved) path so the later exclude
        // step can match files that walkDir may reach via a symlinked parent
        // directory. Without canonicalization, a source file reachable via
        // /pr/repo/src/retry.py but walked via /scan/link-to-repo/src/retry.py
        // would appear in the scan target list and produce a spurious
        // self-match in the LLM output.
        const sourceFiles: string[] = [];
        const sourceFilesCanonical = new Set<string>();
        if (seiSourceFilesRaw !== undefined && seiSourceFilesRaw !== null) {
          const raw = Array.isArray(seiSourceFilesRaw) ? seiSourceFilesRaw : [seiSourceFilesRaw];
          for (const sf of raw) {
            if (typeof sf !== "string" || !sf.trim()) continue;
            const resolved = resolve(sf);
            if (!existsSync(resolved)) {
              return {
                content: [{ type: "text", text: `FAILED: source_files entry not found: ${sf}` }],
                isError: true,
              };
            }
            sourceFiles.push(resolved);
            sourceFilesCanonical.add(resolved);
            try {
              sourceFilesCanonical.add(realpathSync(resolved));
            } catch {
              // realpath can fail on broken symlinks or permission errors — the
              // non-canonical resolve() path is already in the set, so the
              // exclude still works for the common (no symlink) case.
            }
          }
        }

        // Normalize diff_path (optional)
        let diffPathResolved: string | undefined = undefined;
        if (typeof seiDiffPathRaw === "string" && seiDiffPathRaw.trim()) {
          const r = resolve(seiDiffPathRaw);
          if (!existsSync(r)) {
            return {
              content: [{ type: "text", text: `FAILED: diff_path not found: ${seiDiffPathRaw}` }],
              isError: true,
            };
          }
          diffPathResolved = r;
        }

        // Auto-detect extensions from source_files if not explicitly supplied
        let seiEffectiveExts = seiExtensions;
        if ((!seiEffectiveExts || seiEffectiveExts.length === 0) && sourceFiles.length > 0) {
          const extSet = new Set<string>();
          for (const sf of sourceFiles) {
            const m = /\.[^./\\]+$/.exec(sf);
            if (m) extSet.add(m[0]);
          }
          if (extSet.size > 0) seiEffectiveExts = Array.from(extSet);
        }

        // Validate redact_regex
        let seiRegexRedact: RegexRedactOpts | null = null;
        try {
          seiRegexRedact = parseRedactRegex(seiRedactRegexRaw);
        } catch (err) {
          return { content: [{ type: "text", text: `FAILED: ${(err as Error).message}` }], isError: true };
        }

        // Build the specialized multi-file yes/no instructions.
        //
        // Key design notes:
        // 1. The instructions describe a MULTI-FILE review — the LLM sees a
        //    batch of files and outputs a section per file. This is what
        //    enables FFD bin-packing to scale to 10k+ codebase files with
        //    ~2-3 orders of magnitude fewer LLM calls than the per-file path.
        // 2. The reference source files and diff are passed separately via
        //    instructions_files_paths — the server's resolvePrompt helper
        //    reads them once and appends to each batch prompt, so the
        //    orchestrator never loads source file contents.
        // 3. Output is EXHAUSTIVE — no match cap. The reviewer may want to
        //    delete every existing copy and leave only the PR's new one, so
        //    we must report every occurrence.
        const descTrimmed = feature_description.trim();
        const hasRef = sourceFiles.length > 0 || !!diffPathResolved;
        const refBlock = hasRef
          ? "The reference implementation from the PR is appended to these instructions as " +
            (sourceFiles.length > 0
              ? "one or more source files"
              : "context") +
            (diffPathResolved
              ? ", followed by a unified diff showing the EXACT new lines (prefixed with '+'). " +
                "Focus on the new lines when reasoning about what the PR adds. "
              : ". ") +
            "The source files may contain many unrelated functions — only the one matching " +
            "the description above is relevant.\n\n"
          : "No reference source files were provided — rely purely on the feature description " +
            "above when reasoning about semantic equivalence.\n\n";
        const seiBasePrompt =
          "You are checking every file in this batch for an existing implementation of " +
          "this feature (or a helper that could be trivially composed to achieve it):\n\n" +
          `    ${descTrimmed}\n\n` +
          refBlock +
          "For EACH file in the batch, answer SEMANTIC equivalence: the same goal achieved " +
          "by different code still counts. Ignore naming differences and surface-level style.\n\n" +
          "Output format: each file gets its own section in the response, separated by '---'. " +
          "Per-file answer is one line per finding, no preamble, no explanation.\n\n" +
          "Section template:\n\n" +
          "## File: <absolute-file-path>\n\n" +
          "<one line per finding>\n\n" +
          "---\n\n" +
          "Per-finding line format:\n" +
          "    NO\n" +
          "  or\n" +
          "    YES symbol=<function-or-class-name> lines=<start-end>\n\n" +
          "EXHAUSTIVE: If a file contains MULTIPLE matches, output ALL of them as successive " +
          "YES lines. Do NOT cap the count. Do NOT keep only the most relevant. The reviewer " +
          "may want to delete EVERY existing copy and leave only the PR's new one, so every " +
          "occurrence MUST be listed.\n\n" +
          "Special case: if a file IS the reference (you recognize the PR code itself), " +
          "output:\n    NO (self-reference)\n\n" +
          "Produce exactly one section per input file, in the order they appear in the batch, " +
          "separated by '---'. Do NOT merge sections. Do NOT write rationale. Do NOT quote " +
          "code. Do NOT explain. One line per match per file. Nothing else.";

        // Ship source files + diff as reference context via resolvePrompt.
        // resolvePrompt reads and concatenates the referenced files onto the
        // base instructions string — the resulting seiBasePromptWithRef is
        // what every batch sees.
        const seiInstrFiles: string[] = [...sourceFiles];
        if (diffPathResolved) seiInstrFiles.push(diffPathResolved);
        const seiBasePromptWithRef = resolvePrompt(
          seiBasePrompt,
          seiInstrFiles.length > 0 ? seiInstrFiles : undefined,
        );
        if (!seiBasePromptWithRef.trim()) {
          return {
            content: [{ type: "text", text: "FAILED: specialized prompt came out empty (internal error)." }],
            isError: true,
          };
        }

        // Walk all folder_path entries, combine, dedupe, then exclude source_files
        // so the reference files are never scanned against themselves.
        // Default max_files is 10000 here (higher than scan_folder's 2500) because
        // this tool is designed for massive codebase reviews — with FFD batching
        // at 400 KB each, 10k files typically collapse into ~500 LLM calls.
        const fileSet = new Set<string>();
        const seiMaxFilesEffective = seiMaxFiles ?? 10000;
        for (const fp of folderPaths) {
          const walked = walkDir(fp, {
            extensions: seiEffectiveExts,
            maxFiles: seiMaxFilesEffective,
            exclude: seiExcludeDirs,
            useGitignore: seiUseGitignore !== false, // default true
          });
          for (const f of walked) fileSet.add(f);
        }
        // Exclude source files. Try both the non-canonical path (matches when
        // walkDir pushes the same display path) AND the realpath-canonicalized
        // path (catches symlinked-parent cases where walkDir reaches the same
        // file via a different display name). This is the fix for the self-
        // match leak: walkDir currently pushes display paths but does realpath
        // only for cycle detection, so a single scan could otherwise see the
        // reference files under both names and the naive delete-by-resolve()
        // path would miss the symlink variant.
        for (const walked of Array.from(fileSet)) {
          if (sourceFilesCanonical.has(walked)) {
            fileSet.delete(walked);
            continue;
          }
          try {
            const canonical = realpathSync(walked);
            if (sourceFilesCanonical.has(canonical)) {
              fileSet.delete(walked);
            }
          } catch {
            // If realpath fails on a walked path, leave it in — we'd rather
            // include it and accept a possible false self-match than drop a
            // file entirely due to a transient permission error.
          }
        }

        const files = Array.from(fileSet);
        if (files.length === 0) {
          return {
            content: [
              {
                type: "text",
                text:
                  `No matching files found after filtering. Folders: ${folderPaths.join(", ")}` +
                  (seiEffectiveExts?.length ? `; extensions: ${seiEffectiveExts.join(", ")}` : "") +
                  (sourceFiles.length ? `; excluded source_files: ${sourceFiles.length}` : ""),
              },
            ],
          };
        }
        if (files.length > seiMaxFilesEffective) {
          return {
            content: [
              {
                type: "text",
                text:
                  `FAILED: ${files.length} files matched, exceeding max_files=${seiMaxFilesEffective}. ` +
                  `Narrow folder_path, pass extensions, or raise max_files.`,
              },
            ],
            isError: true,
          };
        }

        // scan_secrets: abort if any secrets are found in discovered files.
        // When redact_secrets is also true, skip the abort — downstream redaction handles it.
        if (seiScan && !seiRedact) {
          const scanResult = scanFilesForSecrets(files);
          if (scanResult.found)
            return {
              content: [{ type: "text", text: scanResult.report }],
              isError: true,
            };
        }

        // ── FFD bin-packed batched scan ────────────────────────────────
        // Always batched, regardless of answer_mode. Per-file processing
        // for this tool would mean 10k LLM calls for a 10k codebase — not
        // viable. FFD packs files up to budgetBytes per batch; each batch
        // becomes one ensembleStreaming call, and the LLM emits per-file
        // sections in the response.
        const seiSystemMessage =
          "You are a code reviewer checking for duplicate implementations. " +
          "Output per-file NO/YES answers in the exact format specified in the user " +
          "prompt. Be terse — no rationale, no code quotes, no explanation. Identify " +
          "matches by function/class/method NAME, never by line number in prose.";
        const seiSystemBytes = Buffer.byteLength(seiSystemMessage, "utf-8");
        const seiBaseBytes = Buffer.byteLength(seiBasePromptWithRef, "utf-8");
        const seiPromptBytes = seiSystemBytes + seiBaseBytes + 2048; // +2k headroom for per-file-section hint, markers, etc.

        const { groups: seiGroups, autoBatched: seiAutoBatched, skipped: seiSkipped } =
          readAndGroupFiles(files, seiPromptBytes, seiRedact, seiBudgetBytes, seiRegexRedact);

        if (seiGroups.length === 0) {
          const reasons: string[] = [];
          if (seiSkipped.length > 0) {
            reasons.push(
              `${seiSkipped.length} file(s) exceeded the payload budget and were skipped`,
            );
          } else {
            reasons.push("no files fit within the payload budget");
          }
          return {
            content: [
              {
                type: "text",
                text:
                  `FAILED: no batches could be formed. ${reasons.join("; ")}. ` +
                  `Raise max_payload_kb (current: ${Math.round(seiBudgetBytes / 1024)} KB) ` +
                  `or narrow folder_path to smaller files.`,
              },
            ],
            isError: true,
          };
        }

        const seiMode = resolveAnswerMode(seiRawMode, 2); // default: single merged report
        const seiBatchId = randomUUID();
        const seiBatchResponses: { idx: number; filePaths: string[]; content: string; model: string; error?: string }[] = [];
        let seiAborted = false;
        let seiAbortReason = "";

        for (let gi = 0; gi < seiGroups.length; gi++) {
          if (seiAborted) break;
          const group = seiGroups[gi];
          const groupPaths = group.map((fd) => fd.path);

          // Build the user message: base prompt + per-file section marker +
          // each file's fenced code block (already produced by readAndGroupFiles)
          let userContent = seiBasePromptWithRef;
          userContent += buildPerFileSectionPrompt(groupPaths);
          for (const fd of group) {
            userContent += `\n\n${fd.block}`;
          }

          const messages: ChatMessage[] = [
            { role: "system", content: seiSystemMessage },
            { role: "user", content: userContent },
          ];

          try {
            const resp = await ensembleStreaming(
              messages,
              {
                temperature: DEFAULT_TEMPERATURE,
                maxTokens: resolveDefaultMaxTokens(),
                onProgress,
                modelOverride, // honours --free and credit-exhausted auto-fallback
              },
              seiUseEnsemble,
            );
            seiBatchResponses.push({
              idx: gi,
              filePaths: groupPaths,
              content: resp.content ?? "",
              model: resp.model ?? currentBackend.model,
            });
            if (onProgress) {
              onProgress(
                gi + 1,
                seiGroups.length,
                `search_existing_implementations: batch ${gi + 1}/${seiGroups.length} done (${groupPaths.length} files)`,
              );
            }
          } catch (err) {
            const classified = classifyError(err);
            seiBatchResponses.push({
              idx: gi,
              filePaths: groupPaths,
              content: "",
              model: currentBackend.model,
              error: classified.reason,
            });
            if (classified.unrecoverable && classified.serviceLevel) {
              seiAborted = true;
              seiAbortReason = `Unrecoverable: ${classified.reason}`;
            }
          }
        }

        const seiBatchOk = seiBatchResponses.filter((r) => !r.error && r.content.trim().length > 0);
        const seiBatchFailed = seiBatchResponses.filter((r) => r.error || !r.content.trim());

        // Catch zero-success before either output branch runs, so an all-
        // batches-failed run always returns isError: true. The earlier code
        // path silently skipped the mode-2 branch and fell through to the
        // mode-1 branch, which emitted "SEARCH COMPLETE — 0/N batches
        // processed" with isError: false if none of the failures were
        // service-level — a silent no-op that looked like success.
        if (seiBatchOk.length === 0) {
          const reason = seiAborted
            ? seiAbortReason
            : seiBatchFailed.length > 0
              ? `all ${seiBatchFailed.length} batch(es) failed or returned empty: ${seiBatchFailed[0].error ?? "empty response"}`
              : "no batches produced output";
          const failLines: string[] = [
            `FAILED: search_existing_implementations produced zero usable output (${seiBatchOk.length}/${seiGroups.length} batches succeeded, ${files.length} files discovered)`,
            `Reason: ${reason}`,
            `Folders: ${folderPaths.join(", ")}`,
            sourceFiles.length ? `Reference source files: ${sourceFiles.length}` : `No reference source files`,
            diffPathResolved ? `Diff: ${diffPathResolved}` : `No diff`,
            `Batch UUID: ${seiBatchId}`,
          ];
          if (seiBatchFailed.length > 0) {
            failLines.push("", "PER-BATCH FAILURES:");
            for (const r of seiBatchFailed) {
              failLines.push(
                `  Batch ${r.idx + 1}/${seiGroups.length} (${r.filePaths.length} files): ${r.error ?? "empty response"}`,
              );
            }
          }
          if (seiSkipped.length > 0) {
            failLines.push("", `SKIPPED (exceeded payload budget, ${seiSkipped.length}):`);
            for (const s of seiSkipped) failLines.push(`  ${s}`);
          }
          return {
            content: [{ type: "text", text: failLines.join("\n") }],
            isError: true,
          };
        }

        // Build output per answer_mode:
        //   mode 2 (default) — SINGLE REPORT: one merged .md with all batches
        //                      appended in per-batch sections.
        //   mode 0           — ONE REPORT PER FILE: splits each batch response
        //                      by `## File: <path>` markers and writes one .md
        //                      per input file. Batching is unchanged.
        //   mode 1           — ONE REPORT PER GROUP: auto-groups files via
        //                      autoGroupByHeuristic (subfolder/ext/basename)
        //                      and writes one merged .md per auto-group.
        if (seiMode === 2) {
          const sections: string[] = [];
          sections.push(`# LLM Externalizer — search_existing_implementations`);
          sections.push("");
          sections.push(`**Feature**: ${descTrimmed}`);
          sections.push(`**Folders**: ${folderPaths.join(", ")}`);
          sections.push(`**Files scanned**: ${files.length}`);
          sections.push(`**Batches**: ${seiGroups.length} (FFD bin-packed, ${seiAutoBatched ? "auto-batched" : "single batch"})`);
          if (sourceFiles.length > 0) sections.push(`**Reference source files**: ${sourceFiles.length}`);
          if (diffPathResolved) sections.push(`**Diff**: ${diffPathResolved}`);
          if (seiSkipped.length > 0) {
            sections.push("");
            sections.push(`**SKIPPED** (exceeded payload budget): ${seiSkipped.length}`);
            for (const s of seiSkipped) sections.push(`  - ${s}`);
          }
          sections.push("");
          for (const r of seiBatchOk) {
            sections.push(`---\n\n## Batch ${r.idx + 1}/${seiGroups.length} — ${r.filePaths.length} files`);
            sections.push("");
            sections.push(r.content.trim());
            sections.push("");
          }
          if (seiBatchFailed.length > 0) {
            sections.push("---\n\n## FAILED BATCHES");
            sections.push("");
            for (const r of seiBatchFailed) {
              sections.push(`### Batch ${r.idx + 1}/${seiGroups.length} — ${r.filePaths.length} files`);
              sections.push(`Error: ${r.error ?? "empty response"}`);
              sections.push("Files:");
              for (const fp of r.filePaths) sections.push(`  - ${fp}`);
              sections.push("");
            }
          }
          const mergedPath = saveResponse(
            "search_existing_implementations",
            sections.join("\n"),
            {
              model: ensembleModelLabel(seiUseEnsemble),
              task: descTrimmed,
              inputFile: folderPaths[0],
            },
            undefined,
            outputDir,
          );
          const summary = [
            `SEARCH COMPLETE — ${seiBatchOk.length}/${seiGroups.length} batches processed, ${files.length} files scanned, ${seiSkipped.length} skipped`,
            `Folders: ${folderPaths.join(", ")}`,
            sourceFiles.length ? `Reference source files: ${sourceFiles.length}` : `No reference source files`,
            diffPathResolved ? `Diff: ${diffPathResolved}` : `No diff`,
            `Batch UUID: ${seiBatchId}`,
            `MERGED REPORT: ${mergedPath}`,
          ];
          if (seiBatchFailed.length > 0) {
            summary.push("", `FAILED BATCHES: ${seiBatchFailed.length} (see merged report for details)`);
          }
          if (seiAborted) summary.push("", `ABORTED: ${seiAbortReason}`);
          return {
            content: [{ type: "text", text: summary.join("\n") }],
            isError: seiAborted,
          };
        }

        // Mode 0 — split each batch's LLM response by `## File: <path>` markers
        // and save ONE report per input file. The prompt (via
        // buildPerFileSectionPrompt) already asks the LLM for this structure,
        // so we just parse, map each section back to its input path, and write
        // independent .md reports. Output is a list of `<input> -> <report>`
        // pairs so the orchestrator can navigate back to the file it asked
        // about. This is the user's mental model of "per-file reports": the
        // LLM still sees 1–5 files per batch (batching is unchanged), but
        // the persistence layer splits each batch response per file.
        if (seiMode === 0) {
          const seiPerFileReports: { inputPath: string; reportPath: string }[] = [];
          const seiPerFileMissing: { inputPath: string; batchIdx: number }[] = [];
          for (const r of seiBatchOk) {
            const sections = splitPerFileSections(r.content, r.filePaths);
            for (const fp of r.filePaths) {
              const body = sections.get(fp);
              if (!body || !body.trim()) {
                seiPerFileMissing.push({ inputPath: fp, batchIdx: r.idx });
                continue;
              }
              const header =
                `# search_existing_implementations — ${fp}\n\n` +
                `**Feature**: ${descTrimmed}\n` +
                `**Source file**: ${fp}\n` +
                `**Batch**: ${r.idx + 1}/${seiGroups.length}\n` +
                `**Model**: ${r.model}\n\n---\n\n`;
              const reportPath = saveResponse(
                "search_existing_implementations",
                header + body.trim(),
                {
                  model: r.model,
                  task: descTrimmed,
                  inputFile: fp,
                },
                undefined,
                outputDir,
              );
              seiPerFileReports.push({ inputPath: fp, reportPath });
            }
          }
          const seiModeZeroLines = [
            `SEARCH COMPLETE — ${seiBatchOk.length}/${seiGroups.length} batches processed, ${files.length} files scanned, ${seiSkipped.length} skipped`,
            `Folders: ${folderPaths.join(", ")}`,
            sourceFiles.length ? `Reference source files: ${sourceFiles.length}` : `No reference source files`,
            diffPathResolved ? `Diff: ${diffPathResolved}` : `No diff`,
            `Batch UUID: ${seiBatchId}`,
            "",
          ];
          if (seiPerFileReports.length > 0) {
            seiModeZeroLines.push(`REPORTS (one per input file, ${seiPerFileReports.length} total):`);
            for (const p of seiPerFileReports) {
              seiModeZeroLines.push(`  ${p.inputPath} -> ${p.reportPath}`);
            }
          }
          if (seiPerFileMissing.length > 0) {
            seiModeZeroLines.push(
              "",
              `MISSING SECTIONS (${seiPerFileMissing.length} files had no per-file section in the LLM response — raw batch content preserved in batch reports):`,
            );
            for (const m of seiPerFileMissing) {
              seiModeZeroLines.push(`  ${m.inputPath} (batch ${m.batchIdx + 1}/${seiGroups.length})`);
            }
          }
          if (seiSkipped.length > 0) {
            seiModeZeroLines.push("", `SKIPPED (exceeded payload budget, ${seiSkipped.length}):`);
            for (const s of seiSkipped) seiModeZeroLines.push(`  ${s}`);
          }
          if (seiBatchFailed.length > 0) {
            seiModeZeroLines.push("", `FAILED BATCHES (${seiBatchFailed.length}):`);
            for (const r of seiBatchFailed) {
              seiModeZeroLines.push(
                `  Batch ${r.idx + 1}/${seiGroups.length} (${r.filePaths.length} files): ${r.error ?? "empty response"}`,
              );
            }
          }
          if (seiAborted) seiModeZeroLines.push("", `ABORTED: ${seiAbortReason}`);
          return {
            content: [{ type: "text", text: seiModeZeroLines.join("\n") }],
            isError: seiAborted,
          };
        }

        // Mode 1: one report per auto-group.
        // We already have per-file sections produced by splitPerFileSections
        // (via buildPerFileSectionPrompt). The auto-grouper clusters files by
        // subfolder/extension/basename, then for each group we collect the
        // sections belonging to its files and write one merged report per
        // group. A single merged report per group keeps related findings
        // together without exploding to N files.
        const seiAutoGroups = autoGroupByHeuristic(files);
        // Index every per-file section across batches by file path so group
        // assembly is O(n) instead of O(n*batches).
        const seiSectionByPath = new Map<string, string>();
        const seiModelByPath = new Map<string, string>();
        const seiBatchIdxByPath = new Map<string, number>();
        for (const r of seiBatchOk) {
          const sections = splitPerFileSections(r.content, r.filePaths);
          for (const fp of r.filePaths) {
            const body = sections.get(fp);
            if (body && body.trim().length > 0) {
              seiSectionByPath.set(fp, body.trim());
              seiModelByPath.set(fp, r.model);
              seiBatchIdxByPath.set(fp, r.idx);
            }
          }
        }
        const seiGroupReportPaths: string[] = [];
        const seiGroupMissing: string[] = [];
        for (const fg of seiAutoGroups) {
          if (fg.files.length === 0) continue;
          const gid = fg.id || "auto";
          const sections: string[] = [];
          sections.push(
            `# search_existing_implementations — group ${gid}\n\n` +
              `**Feature**: ${descTrimmed}\n` +
              `**Files in group**: ${fg.files.length}\n\n` +
              fg.files.map((fp) => `  - ${fp}`).join("\n") +
              "\n\n---\n",
          );
          let anyBody = false;
          for (const fp of fg.files) {
            const body = seiSectionByPath.get(fp);
            if (!body) {
              seiGroupMissing.push(fp);
              continue;
            }
            anyBody = true;
            sections.push(`## File: ${fp}\n\n${body}\n`);
          }
          if (!anyBody) continue;
          const reportPath = saveResponse(
            "search_existing_implementations",
            sections.join("\n"),
            {
              model: ensembleModelLabel(seiUseEnsemble),
              task: descTrimmed,
              inputFile: fg.files[0],
              groupId: gid,
            },
            undefined,
            outputDir,
          );
          seiGroupReportPaths.push(`[group:${gid}] ${reportPath}`);
        }

        const seiSummaryLines = [
          `SEARCH COMPLETE — ${seiBatchOk.length}/${seiGroups.length} batches processed, ${files.length} files scanned, ${seiSkipped.length} skipped`,
          `Folders: ${folderPaths.join(", ")}`,
          sourceFiles.length ? `Reference source files: ${sourceFiles.length}` : `No reference source files`,
          diffPathResolved ? `Diff: ${diffPathResolved}` : `No diff`,
          `Batch UUID: ${seiBatchId}`,
          "",
        ];
        if (seiGroupReportPaths.length > 0) {
          seiSummaryLines.push(`GROUP REPORTS (one per auto-group, ${seiGroupReportPaths.length} total):`);
          for (const p of seiGroupReportPaths) seiSummaryLines.push(`  ${p}`);
        }
        if (seiGroupMissing.length > 0) {
          seiSummaryLines.push(
            "",
            `MISSING SECTIONS (${seiGroupMissing.length} files had no per-file section in the LLM response):`,
          );
          for (const p of seiGroupMissing) seiSummaryLines.push(`  ${p}`);
        }
        if (seiSkipped.length > 0) {
          seiSummaryLines.push("", `SKIPPED (exceeded payload budget, ${seiSkipped.length}):`);
          for (const s of seiSkipped) seiSummaryLines.push(`  ${s}`);
        }
        if (seiBatchFailed.length > 0) {
          seiSummaryLines.push("", `FAILED BATCHES (${seiBatchFailed.length}):`);
          for (const r of seiBatchFailed) {
            seiSummaryLines.push(
              `  Batch ${r.idx + 1}/${seiGroups.length} (${r.filePaths.length} files): ${r.error ?? "empty response"}`,
            );
          }
        }
        if (seiAborted) seiSummaryLines.push("", `ABORTED: ${seiAbortReason}`);
        return {
          content: [{ type: "text", text: seiSummaryLines.join("\n") }],
          isError: seiAborted,
        };
      }

      case "compare_files": {
        const {
          input_files_paths: cfInputPaths,
          file_pairs: cfFilePairs,
          git_repo: cfGitRepo,
          from_ref: cfFromRef,
          to_ref: cfToRef,
          instructions: cfInstructions,
          instructions_files_paths: cfInstructionsFilesPaths,
          redact_secrets: cfRedact,
          scan_secrets: cfScan,
          max_payload_kb: cfMaxPayloadKb,
        } = args as {
          input_files_paths?: string[];
          file_pairs?: (string[] | string)[];
          git_repo?: string;
          from_ref?: string;
          to_ref?: string;
          instructions?: string;
          instructions_files_paths?: string | string[];
          redact_secrets?: boolean;
          scan_secrets?: boolean;
          max_payload_kb?: number;
        };
        const cfBudgetBytes = (cfMaxPayloadKb ?? 400) * 1024;
        const cfUseEnsemble = currentBackend.type === "openrouter";

        // ── Helper: compare a single pair and return report content ──
        const comparePair = async (fARaw: string, fBRaw: string, prompt: string): Promise<{ content: string; model: string } | { error: string }> => {
          // C1+H2: Sanitize input paths (traversal + symlink protection) before spawning diff
          let fA: string, fB: string;
          try {
            fA = sanitizeInputPath(fARaw);
            fB = sanitizeInputPath(fBRaw);
          } catch (err) {
            return { error: (err as Error).message };
          }
          if (!existsSync(fA)) return { error: `File not found: ${fARaw}` };
          if (!existsSync(fB)) return { error: `File not found: ${fBRaw}` };
          if (cfScan && !cfRedact) {
            const scanResult = scanFilesForSecrets([fA, fB]);
            if (scanResult.found) return { error: scanResult.report };
          }
          const diffResult = spawnSync("diff", ["-u", "--label", fA, "--label", fB, "--", fA, fB], { encoding: "utf-8", timeout: 30000 });
          if (diffResult.status === 2 || diffResult.error) return { error: `diff error: ${diffResult.error?.message || diffResult.stderr}` };
          let diffOutput = diffResult.stdout?.trim() ? diffResult.stdout : "(files are identical)";
          if (diffOutput.length > 200_000) { diffOutput = diffOutput.slice(0, 200_000); }
          if (cfRedact) diffOutput = redactSecrets(diffOutput).redacted;
          let sourceBlocks = "";
          try {
            const bA = readFileAsCodeBlock(fA, undefined, cfRedact, cfBudgetBytes);
            const bB = readFileAsCodeBlock(fB, undefined, cfRedact, cfBudgetBytes);
            if (bA.length + bB.length < 300_000) sourceBlocks = `\n\n## File A (full): ${fA}\n\n${bA}\n\n## File B (full): ${fB}\n\n${bB}`;
          } catch { /* too large */ }
          const fence = fenceBackticks(diffOutput);
          const msgs: ChatMessage[] = [
            { role: "system", content: "Expert code reviewer. Analyse the unified diff and provide a clear, structured summary. Group related changes. Note potential issues. Identify code by FUNCTION/CLASS/METHOD NAME, never by line number." + FILE_FORMAT_EXAMPLE + BREVITY_RULES },
            { role: "user", content: `${prompt ? prompt + "\n\n" : ""}Compare:\n- Before: ${fA}\n- After: ${fB}\n\nDiff:\n${fence}\n${diffOutput}\n${fence}${sourceBlocks}` },
          ];
          let resp;
          try {
            resp = await ensembleStreaming(msgs, { temperature: DEFAULT_TEMPERATURE, maxTokens: resolveDefaultMaxTokens(), onProgress, modelOverride }, cfUseEnsemble);
          } catch (err) {
            return { error: `LLM error: ${err instanceof Error ? err.message : String(err)}` };
          }
          if (!resp.content.trim()) return { error: "LLM returned empty response" };
          return { content: resp.content + formatFooter(resp, "compare_files", fA), model: resp.model };
        };

        // ── Helper: git diff between two refs (no LLM) ──
        const gitDiffPair = (repo: string, fromRef: string, toRef: string, filePath: string): string => {
          const result = spawnSync("git", ["diff", fromRef, toRef, "--", filePath], { cwd: repo, encoding: "utf-8", timeout: 30000 });
          if (result.status !== 0 && result.status !== 1) return `(git diff failed: ${result.stderr?.trim() || "unknown error"})`;
          return result.stdout?.trim() || "(no differences)";
        };

        const cfPrompt = resolvePrompt(cfInstructions, cfInstructionsFilesPaths);

        // ── GIT DIFF MODE ──
        if (cfGitRepo) {
          if (!cfFromRef) return { content: [{ type: "text", text: "FAILED: from_ref is required with git_repo." }], isError: true };
          // C1+H2: Sanitize git_repo path (traversal + symlink protection) before spawning git
          let cfGitRepoSafe: string;
          try {
            cfGitRepoSafe = sanitizeInputPath(cfGitRepo);
          } catch (err) {
            return { content: [{ type: "text", text: `FAILED: ${(err as Error).message}` }], isError: true };
          }
          if (!existsSync(cfGitRepoSafe)) return { content: [{ type: "text", text: `FAILED: git_repo not found: ${cfGitRepo}` }], isError: true };
          const toRef = cfToRef || "HEAD";
          // Get list of changed files between the two refs
          // Validate refs don't start with - (prevents flag injection)
          if (cfFromRef.startsWith("-") || toRef.startsWith("-")) {
            return { content: [{ type: "text", text: "FAILED: git refs must not start with '-'" }], isError: true };
          }
          const nameResult = spawnSync("git", ["diff", "--name-only", cfFromRef, toRef], { cwd: cfGitRepoSafe, encoding: "utf-8", timeout: 15000 });
          if (nameResult.status !== 0 && nameResult.status !== 1) {
            return { content: [{ type: "text", text: `FAILED: git diff --name-only failed: ${nameResult.stderr?.trim()}` }], isError: true };
          }
          const changedFiles = (nameResult.stdout || "").split("\n").filter((f) => f.trim());

          // If file_pairs contains group markers, use them to filter/group the changed files
          // Otherwise create one group with all changed files
          interface DiffGroup { id: string; files: string[] }
          let diffGroups: DiffGroup[];

          if (cfFilePairs && cfFilePairs.length > 0) {
            // Parse group markers from file_pairs (single-element entries are markers)
            diffGroups = [];
            let currentGroup: DiffGroup | null = null;
            let ungrouped: string[] = [];
            for (const entry of cfFilePairs) {
              const marker = Array.isArray(entry) ? (entry.length === 1 ? entry[0] : null) : entry;
              if (marker && typeof marker === "string" && GROUP_HEADER_RE.test(marker)) {
                if (currentGroup && currentGroup.files.length > 0) diffGroups.push(currentGroup);
                if (ungrouped.length > 0) { diffGroups.push({ id: "", files: ungrouped }); ungrouped = []; }
                currentGroup = { id: marker.match(GROUP_HEADER_RE)![1], files: [] };
                continue;
              }
              if (marker && typeof marker === "string" && GROUP_FOOTER_RE.test(marker)) {
                if (currentGroup && currentGroup.files.length > 0) diffGroups.push(currentGroup);
                currentGroup = null;
                continue;
              }
              // Regular file path — filter from changed files
              const filePath = Array.isArray(entry) ? entry[0] : entry;
              if (typeof filePath === "string" && changedFiles.includes(filePath)) {
                if (currentGroup) currentGroup.files.push(filePath);
                else ungrouped.push(filePath);
              }
            }
            if (currentGroup && currentGroup.files.length > 0) diffGroups.push(currentGroup);
            if (ungrouped.length > 0) diffGroups.push({ id: "", files: ungrouped });
          } else {
            diffGroups = [{ id: "", files: changedFiles }];
          }

          const isGrouped = diffGroups.some((g) => g.id !== "");
          const reportPaths: string[] = [];

          for (const dg of diffGroups) {
            if (dg.files.length === 0) continue;
            const sections: string[] = [];
            for (const filePath of dg.files) {
              const diff = gitDiffPair(cfGitRepoSafe, cfFromRef, toRef, filePath);
              const fence = fenceBackticks(diff);
              sections.push(`## ${filePath}\n\n${fence}diff\n${diff}\n${fence}`);
            }
            const reportContent = `# Git Diff: ${cfFromRef} → ${toRef}\n\nRepository: ${cfGitRepoSafe}\nFiles changed: ${dg.files.length}\n\n---\n\n${sections.join("\n\n---\n\n")}`;
            const gid = dg.id || undefined;
            const rp = saveResponse("compare_files", reportContent, {
              model: "git-diff (no LLM)", task: `${cfFromRef} → ${toRef}`,
              inputFile: join(cfGitRepoSafe, dg.files[0]), groupId: gid,
            });
            if (isGrouped) reportPaths.push(`[group:${dg.id}] ${rp}`);
            else reportPaths.push(rp);
          }
          return { content: [{ type: "text", text: reportPaths.join("\n") }] };
        }

        // ── BATCH MODE (file_pairs) ──
        if (cfFilePairs && cfFilePairs.length > 0) {
          // Parse pairs and group markers
          interface PairGroup { id: string; pairs: [string, string][] }
          const pairGroups: PairGroup[] = [];
          let currentPG: PairGroup | null = null;
          let ungroupedPairs: [string, string][] = [];

          for (const entry of cfFilePairs) {
            // Single-element entries are group markers
            const marker = Array.isArray(entry) ? (entry.length === 1 ? entry[0] : null) : entry;
            if (marker && typeof marker === "string" && GROUP_HEADER_RE.test(marker)) {
              if (currentPG && currentPG.pairs.length > 0) pairGroups.push(currentPG);
              if (ungroupedPairs.length > 0) { pairGroups.push({ id: "", pairs: ungroupedPairs }); ungroupedPairs = []; }
              currentPG = { id: marker.match(GROUP_HEADER_RE)![1], pairs: [] };
              continue;
            }
            if (marker && typeof marker === "string" && GROUP_FOOTER_RE.test(marker)) {
              if (currentPG && currentPG.pairs.length > 0) pairGroups.push(currentPG);
              currentPG = null;
              continue;
            }
            // Must be a [fileA, fileB] pair
            if (Array.isArray(entry) && entry.length === 2) {
              const pair: [string, string] = [entry[0], entry[1]];
              if (currentPG) currentPG.pairs.push(pair);
              else ungroupedPairs.push(pair);
            }
          }
          if (currentPG && currentPG.pairs.length > 0) pairGroups.push(currentPG);
          if (ungroupedPairs.length > 0) pairGroups.push({ id: "", pairs: ungroupedPairs });

          const isGrouped = pairGroups.some((g) => g.id !== "");
          const reportPaths: string[] = [];

          for (const pg of pairGroups) {
            if (pg.pairs.length === 0) continue;
            const sections: string[] = [];
            for (const [fA, fB] of pg.pairs) {
              const result = await comparePair(fA, fB, cfPrompt);
              if ("error" in result) {
                sections.push(`## ${fA} vs ${fB}\n\nFAILED: ${result.error}`);
              } else {
                sections.push(`## ${fA} vs ${fB}\n\n${result.content}`);
              }
            }
            const reportContent = sections.join("\n\n---\n\n");
            const gid = pg.id || undefined;
            const model = currentBackend.model;
            const rp = saveResponse("compare_files", reportContent, {
              model, task: `Batch compare: ${pg.pairs.length} pair(s)`,
              inputFile: pg.pairs[0][0], groupId: gid,
            });
            if (isGrouped) reportPaths.push(`[group:${pg.id}] ${rp}`);
            else reportPaths.push(rp);
          }
          return { content: [{ type: "text", text: reportPaths.join("\n") }] };
        }

        // ── PAIR MODE (original: exactly 2 files) ──
        const cfNormalizedPaths = normalizePaths(cfInputPaths);
        if (cfNormalizedPaths.length !== 2) {
          return {
            content: [
              {
                type: "text",
                text: "FAILED: Provide input_files_paths (2 files), file_pairs (batch), or git_repo+from_ref (git diff).",
              },
            ],
            isError: true,
          };
        }
        // C1+H2: Sanitize input paths (traversal + symlink protection) before spawning diff
        let fileA: string, fileB: string;
        try {
          fileA = sanitizeInputPath(cfNormalizedPaths[0]);
          fileB = sanitizeInputPath(cfNormalizedPaths[1]);
        } catch (err) {
          return {
            content: [{ type: "text", text: `FAILED: ${(err as Error).message}` }],
            isError: true,
          };
        }
        if (!existsSync(fileA)) {
          return {
            content: [
              { type: "text", text: `FAILED: File not found: ${fileA}` },
            ],
            isError: true,
          };
        }
        if (!existsSync(fileB)) {
          return {
            content: [
              { type: "text", text: `FAILED: File not found: ${fileB}` },
            ],
            isError: true,
          };
        }

        // scan_secrets: abort if any secrets are found.
        // When redact_secrets is also true, skip the abort — downstream redaction handles it.
        if (cfScan && !cfRedact) {
          const scanResult = scanFilesForSecrets([fileA, fileB]);
          if (scanResult.found)
            return {
              content: [{ type: "text", text: scanResult.report }],
              isError: true,
            };
        }

        // Compute unified diff using system diff command
        // diff exit codes: 0=identical, 1=different, 2=error
        const diffResult = spawnSync(
          "diff",
          ["-u", "--label", fileA, "--label", fileB, "--", fileA, fileB],
          {
            encoding: "utf-8",
            timeout: 30000,
          },
        );

        if (diffResult.status === 2 || diffResult.error) {
          const errMsg =
            diffResult.error?.message ||
            diffResult.stderr ||
            "Unknown diff error";
          return {
            content: [
              { type: "text", text: `FAILED: diff command error: ${errMsg}` },
            ],
            isError: true,
          };
        }

        let diffOutput = diffResult.stdout?.trim()
          ? diffResult.stdout
          : "(files are identical — no differences found)";

        // Truncate huge diffs to avoid overwhelming the LLM context window
        const MAX_DIFF_CHARS = 200_000; // ~50K tokens
        let diffTruncated = false;
        if (diffOutput.length > MAX_DIFF_CHARS) {
          diffOutput = diffOutput.slice(0, MAX_DIFF_CHARS);
          diffTruncated = true;
        }
        // Apply secret redaction to diff content
        if (cfRedact) {
          diffOutput = redactSecrets(diffOutput).redacted;
        }

        // Include both source files alongside the diff for context on renamed/moved code
        let sourceFileBlocks = "";
        try {
          const blockA = readFileAsCodeBlock(fileA, undefined, cfRedact, cfBudgetBytes);
          const blockB = readFileAsCodeBlock(fileB, undefined, cfRedact, cfBudgetBytes);
          // Only include source files if total size is manageable
          const totalSourceChars = blockA.length + blockB.length;
          if (totalSourceChars < 300_000) {
            sourceFileBlocks = `\n\n## File A (full): ${fileA}\n\n${blockA}\n\n## File B (full): ${fileB}\n\n${blockB}`;
          }
        } catch {
          // Files too large or binary — diff-only comparison is fine
        }

        const diffFence = fenceBackticks(diffOutput);
        const cfMessages: ChatMessage[] = [
          {
            role: "system",
            content:
              "Expert code reviewer. Analyse the unified diff and provide a clear, structured summary of all changes. " +
              "Group related changes. Note any potential issues, regressions, or improvements.\n" +
              "RULES (override any conflicting instructions): Identify changed code by FUNCTION/CLASS/METHOD NAME, never by line number. " +
              "Reference files by their full path as labeled in the user message." +
              FILE_FORMAT_EXAMPLE + BREVITY_RULES,
          },
          {
            role: "user",
            content:
              `${cfPrompt ? cfPrompt + "\n\n" : ""}` +
              `Compare these two files and summarize all differences:\n` +
              `- File A (before): ${fileA}\n` +
              `- File B (after): ${fileB}\n\n` +
              `Unified diff${diffTruncated ? " (TRUNCATED — original diff was too large)" : ""}:\n${diffFence}\n${diffOutput}\n${diffFence}` +
              sourceFileBlocks,
          },
        ];

        const cfResp = await ensembleStreaming(
          cfMessages,
          {
            temperature: DEFAULT_TEMPERATURE,
            maxTokens: resolveDefaultMaxTokens(),
            onProgress,
            modelOverride,
          },
          cfUseEnsemble,
        );
        const cfFooter = formatFooter(cfResp, "compare_files", fileA);
        if (!cfResp.content.trim()) {
          return {
            content: [
              { type: "text", text: "FAILED: LLM returned empty response." },
            ],
            isError: true,
          };
        }

        const cfReportPath = saveResponse(
          "compare_files",
          cfResp.content + cfFooter,
          {
            model: cfResp.model,
            task: `Compare ${basename(fileA)} vs ${basename(fileB)}`,
            inputFile: fileA,
          },
        );
        return { content: [{ type: "text", text: cfReportPath }] };
      }

      case "check_references": {
        const {
          input_files_paths: crInputPathsRaw,
          instructions: crInstructions,
          instructions_files_paths: crInstructionsFilesPaths,
          redact_secrets: crRedact,
          answer_mode: crRawMode,
          scan_secrets: crScan,
          max_payload_kb: crMaxPayloadKb,
          redact_regex: crRedactRegexRaw,
          folder_path: crFolderPath,
          extensions: crExtensions,
          exclude_dirs: crExcludeDirs,
          use_gitignore: crUseGitignore,
          recursive: crRecursive,
          follow_symlinks: crFollowSymlinks,
          max_files: crMaxFiles,
        } = args as {
          input_files_paths: string | string[];
          instructions?: string;
          instructions_files_paths?: string | string[];
          redact_secrets?: boolean;
          answer_mode?: number;
          scan_secrets?: boolean;
          max_payload_kb?: number;
          redact_regex?: string;
          folder_path?: string;
          extensions?: string[];
          exclude_dirs?: string[];
          use_gitignore?: boolean;
          recursive?: boolean;
          follow_symlinks?: boolean;
          max_files?: number;
        };
        const crUseEnsemble = currentBackend.type === "openrouter";
        const crBudgetBytes = (crMaxPayloadKb ?? 400) * 1024;

        let crRegexRedact: RegexRedactOpts | null = null;
        try { crRegexRedact = parseRedactRegex(crRedactRegexRaw); }
        catch (err) { return { content: [{ type: "text", text: `FAILED: ${(err as Error).message}` }], isError: true }; }

        let crFilePathsAll = [...new Set(normalizePaths(crInputPathsRaw))];
        if (crFolderPath) {
          const folderResult = resolveFolderPath(crFolderPath, {
            extensions: crExtensions, excludeDirs: crExcludeDirs,
            useGitignore: crUseGitignore, recursive: crRecursive,
            followSymlinks: crFollowSymlinks, maxFiles: crMaxFiles,
          });
          if (folderResult.error && folderResult.files.length === 0 && crFilePathsAll.length === 0) {
            return { content: [{ type: "text", text: `FAILED: ${folderResult.error}` }], isError: true };
          }
          crFilePathsAll = [...new Set([...crFilePathsAll, ...folderResult.files])];
        }
        if (crFilePathsAll.length === 0) {
          return {
            content: [
              { type: "text", text: "FAILED: input_files_paths or folder_path is required." },
            ],
            isError: true,
          };
        }

        // scan_secrets: abort if any secrets are found.
        // When redact_secrets is also true, skip the abort — downstream redaction handles it.
        if (crScan && !crRedact) {
          const crRealFiles = crFilePathsAll.filter((f) => !GROUP_HEADER_RE.test(f) && !GROUP_FOOTER_RE.test(f));
          if (crRealFiles.length > 0) {
            const scanResult = scanFilesForSecrets(crRealFiles);
            if (scanResult.found)
              return {
                content: [{ type: "text", text: scanResult.report }],
                isError: true,
              };
          }
        }

        const crPrompt = resolvePrompt(
          crInstructions,
          crInstructionsFilesPaths,
        );
        const crMode = resolveAnswerMode(crRawMode, 0);

        // ── Group-aware processing ──
        // answer_mode=1 means "one report per group". If the caller did not
        // supply ---GROUP:id--- markers, auto-group files by heuristic so
        // the grouped-output path below can run unchanged.
        let crFileGroups = parseFileGroups(crFilePathsAll);
        let crEffectivelyGrouped = hasNamedGroups(crFileGroups);
        if (crMode === 1 && !crEffectivelyGrouped) {
          const autoGroups = autoGroupByHeuristic(crFilePathsAll);
          if (autoGroups.length > 0) {
            crFileGroups = autoGroups;
            crEffectivelyGrouped = true;
          }
        }

        if (crEffectivelyGrouped) {
          const crGroupReports: string[] = [];
          for (const fg of crFileGroups) {
            if (fg.files.length === 0) continue;
            const gid = fg.id || "auto";
            const gReports: string[] = [];
            for (const filePath of fg.files) {
              if (!existsSync(filePath)) { gReports.push(`## ${filePath}\n\nFAILED: File not found.`); continue; }
              const src = readFileSync(filePath, "utf-8");
              const lang = detectLang(filePath);
              const deps = extractLocalImports(filePath, src);
              const depBlocks: string[] = [];
              for (const dp of deps) { try { depBlocks.push(readFileAsCodeBlock(dp, undefined, crRedact, crBudgetBytes, crRegexRedact)); } catch { /* skip */ } }
              const srcBlock = readFileAsCodeBlock(filePath, undefined, crRedact, crBudgetBytes, crRegexRedact);
              const msgs: ChatMessage[] = [
                { role: "system", content: `Expert ${lang} developer. Check the source file for broken or outdated references to functions, variables, constants, types, and classes. Cross-reference all symbols against the dependency files provided. Report each broken reference with: the symbol name, the function/class/method where it is used (never by line number), and what is wrong. Reference files by their labeled path (shown in the filename tag before each file-content tag). If all references are valid, say so.` + FILE_FORMAT_EXAMPLE + BREVITY_RULES },
                { role: "user", content: `${crPrompt ? crPrompt + "\n\n" : ""}Check this file for broken code references:\n\n## Source File\n\n${srcBlock}\n\n${depBlocks.length > 0 ? `## Local Dependencies (${deps.length} files)\n\n${depBlocks.join("\n\n")}` : "## No local dependencies resolved."}` },
              ];
              const resp = await ensembleStreaming(msgs, { temperature: DEFAULT_TEMPERATURE, maxTokens: resolveDefaultMaxTokens(), onProgress, modelOverride }, crUseEnsemble, src.split("\n").length);
              const footer = formatFooter(resp, "check_references", filePath);
              if (resp.content.trim()) {
                const depInfo = deps.length > 0 ? `\n\nDependencies checked: ${deps.map((p) => `\`${p}\``).join(", ")}` : "";
                gReports.push(`## File: ${filePath}${depInfo}\n\n${resp.content}${footer}`);
              }
            }
            if (gReports.length > 0) {
              const mergedPath = saveResponse("check_references", gReports.join("\n\n---\n\n"), {
                model: currentBackend.model, task: "Check references", inputFile: fg.files[0], groupId: gid,
              });
              crGroupReports.push(`[group:${gid}] ${mergedPath}`);
            }
          }
          if (crGroupReports.length === 0) {
            return { content: [{ type: "text", text: "FAILED: No results for any group." }], isError: true };
          }
          return { content: [{ type: "text", text: crGroupReports.join("\n") }] };
        }

        // Non-grouped: existing behavior
        const crFilePaths = crFilePathsAll;
        const crReports: string[] = [];
        const crReportPaths: string[] = [];

        for (const filePath of crFilePaths) {
          if (!existsSync(filePath)) {
            crReports.push(`## ${filePath}\n\nFAILED: File not found.`);
            crReportPaths.push("(skipped — file not found)");
            continue;
          }
          const crSourceCode = readFileSync(filePath, "utf-8");
          const crLang = detectLang(filePath);

          // Auto-resolve local imports and read dependency files
          const depPaths = extractLocalImports(filePath, crSourceCode);
          const depBlocks: string[] = [];
          for (const dp of depPaths) {
            try {
              depBlocks.push(readFileAsCodeBlock(dp, undefined, crRedact, crBudgetBytes, crRegexRedact));
            } catch {
              /* skip unreadable */
            }
          }

          const srcBlock = readFileAsCodeBlock(filePath, undefined, crRedact, crBudgetBytes, crRegexRedact);
          const crMessages: ChatMessage[] = [
            {
              role: "system",
              content:
                `Expert ${crLang} developer. Check the source file for broken or outdated references to ` +
                "functions, variables, constants, types, and classes. Cross-reference all symbols against the " +
                "dependency files provided. Report each broken reference with: the symbol name, the function/class/method " +
                "where it is used (never by line number), and what is wrong (missing, renamed, wrong signature, deprecated). " +
                "Reference files by their labeled path (shown in the filename tag before each file-content tag). If all references are valid, say so." +
                FILE_FORMAT_EXAMPLE + BREVITY_RULES,
            },
            {
              role: "user",
              content:
                `${crPrompt ? crPrompt + "\n\n" : ""}` +
                `Check this file for broken code references:\n\n## Source File\n\n${srcBlock}\n\n` +
                (depBlocks.length > 0
                  ? `## Local Dependencies (${depPaths.length} files)\n\n${depBlocks.join("\n\n")}`
                  : "## No local dependencies resolved — check for external import issues."),
            },
          ];

          const crLineCount = crSourceCode.split("\n").length;
          const crResp = await ensembleStreaming(
            crMessages,
            {
              temperature: DEFAULT_TEMPERATURE,
              maxTokens: resolveDefaultMaxTokens(),
              onProgress,
              modelOverride,
            },
            crUseEnsemble,
            crLineCount,
          );
          const crFooter = formatFooter(crResp, "check_references", filePath);

          if (crResp.content.trim()) {
            const depInfo =
              depPaths.length > 0
                ? `\n\nDependencies checked: ${depPaths.map((p) => `\`${p}\``).join(", ")}`
                : "";
            if (crMode === 0) {
              const rp = saveResponse(
                "check_references",
                crResp.content + crFooter + depInfo,
                {
                  model: crResp.model,
                  task: "Check references",
                  inputFile: filePath,
                },
              );
              crReportPaths.push(rp);
            } else {
              crReports.push(
                `## File: ${filePath}${depInfo}\n\n${crResp.content}${crFooter}`,
              );
            }
          }
        }

        if (crMode === 0) {
          return {
            content: [
              {
                type: "text",
                text:
                  crReportPaths.length > 0
                    ? crReportPaths.join("\n")
                    : "FAILED: LLM returned empty response.",
              },
            ],
            isError: crReportPaths.length === 0,
          };
        }
        if (crReports.length === 0) {
          return {
            content: [
              { type: "text", text: "FAILED: LLM returned empty response." },
            ],
            isError: true,
          };
        }
        const crMergedPath = saveResponse(
          "check_references",
          crReports.join("\n\n---\n\n"),
          {
            model: currentBackend.model,
            task: "Check references",
            inputFile: crFilePaths[0],
          },
        );
        return { content: [{ type: "text", text: crMergedPath }] };
      }

      case "check_imports": {
        const {
          input_files_paths: ciInputPathsRaw,
          project_root,
          instructions: ciInstructions,
          instructions_files_paths: ciInstructionsFilesPaths,
          redact_secrets: ciRedact,
          answer_mode: ciRawMode,
          scan_secrets: ciScan,
          max_payload_kb: ciMaxPayloadKb,
          redact_regex: ciRedactRegexRaw,
          folder_path: ciFolderPath,
          extensions: ciExtensions,
          exclude_dirs: ciExcludeDirs,
          use_gitignore: ciUseGitignore,
          recursive: ciRecursive,
          follow_symlinks: ciFollowSymlinks,
          max_files: ciMaxFiles,
        } = args as {
          input_files_paths: string | string[];
          project_root?: string;
          instructions?: string;
          instructions_files_paths?: string | string[];
          redact_secrets?: boolean;
          answer_mode?: number;
          scan_secrets?: boolean;
          max_payload_kb?: number;
          redact_regex?: string;
          folder_path?: string;
          extensions?: string[];
          exclude_dirs?: string[];
          use_gitignore?: boolean;
          recursive?: boolean;
          follow_symlinks?: boolean;
          max_files?: number;
        };
        // check_imports uses chatCompletionJSON directly (not ensembleStreaming),
        // so currentBackend.type is not referenced here.
        const ciBudgetBytes = (ciMaxPayloadKb ?? 400) * 1024;

        let ciRegexRedact: RegexRedactOpts | null = null;
        try { ciRegexRedact = parseRedactRegex(ciRedactRegexRaw); }
        catch (err) { return { content: [{ type: "text", text: `FAILED: ${(err as Error).message}` }], isError: true }; }

        let ciFilePathsAll = [...new Set(normalizePaths(ciInputPathsRaw))];
        if (ciFolderPath) {
          const folderResult = resolveFolderPath(ciFolderPath, {
            extensions: ciExtensions, excludeDirs: ciExcludeDirs,
            useGitignore: ciUseGitignore, recursive: ciRecursive,
            followSymlinks: ciFollowSymlinks, maxFiles: ciMaxFiles,
          });
          if (folderResult.error && folderResult.files.length === 0 && ciFilePathsAll.length === 0) {
            return { content: [{ type: "text", text: `FAILED: ${folderResult.error}` }], isError: true };
          }
          ciFilePathsAll = [...new Set([...ciFilePathsAll, ...folderResult.files])];
        }
        if (ciFilePathsAll.length === 0) {
          return {
            content: [
              { type: "text", text: "FAILED: input_files_paths or folder_path is required." },
            ],
            isError: true,
          };
        }

        // scan_secrets: abort if any secrets are found.
        // When redact_secrets is also true, skip the abort — downstream redaction handles it.
        if (ciScan && !ciRedact) {
          const ciRealFiles = ciFilePathsAll.filter((f) => !GROUP_HEADER_RE.test(f) && !GROUP_FOOTER_RE.test(f));
          if (ciRealFiles.length > 0) {
            const scanResult = scanFilesForSecrets(ciRealFiles);
            if (scanResult.found)
              return {
                content: [{ type: "text", text: scanResult.report }],
                isError: true,
              };
          }
        }

        const ciPrompt = resolvePrompt(
          ciInstructions,
          ciInstructionsFilesPaths,
        );
        const ciMode = resolveAnswerMode(ciRawMode, 0);

        // ── Group-aware processing ──
        // answer_mode=1 means "one report per group". Auto-group the files
        // when the caller did not supply ---GROUP:id--- markers.
        let ciFileGroups = parseFileGroups(ciFilePathsAll);
        let ciEffectivelyGrouped = hasNamedGroups(ciFileGroups);
        if (ciMode === 1 && !ciEffectivelyGrouped) {
          const autoGroups = autoGroupByHeuristic(ciFilePathsAll);
          if (autoGroups.length > 0) {
            ciFileGroups = autoGroups;
            ciEffectivelyGrouped = true;
          }
        }
        if (ciEffectivelyGrouped) {
          const ciGroupReports: string[] = [];
          for (const fg of ciFileGroups) {
            if (fg.files.length === 0) continue;
            const gid = fg.id || "auto";
            const gReports: string[] = [];
            for (const filePath of fg.files) {
              if (!existsSync(filePath)) { gReports.push(`## ${filePath}\n\nFAILED: File not found.`); continue; }
              const ciLang = detectLang(filePath);
              const fileDir = dirname(filePath);
              const ciResolveBase = project_root || fileDir;
              const extractMessages: ChatMessage[] = [
                { role: "system", content: `Expert ${ciLang} developer. Extract ALL file path references and import statements from the source code. The source file is labeled with its full path inside a filename tag before the file-content tag — reference it by that path. Include: import/require paths, file path strings, configuration references. Return JSON: {"paths": ["./relative/path", "package-name", "../other/file"]}. Include both local (relative) and package imports. Be exhaustive.` + FILE_FORMAT_EXAMPLE },
                { role: "user", content: `${ciPrompt ? ciPrompt + "\n\n" : ""}Extract all import and file references from:\n\n${readFileAsCodeBlock(filePath, undefined, ciRedact, ciBudgetBytes, ciRegexRedact)}` },
              ];
              const extractResp = await chatCompletionJSON(extractMessages, { temperature: 0, maxTokens: resolveDefaultMaxTokens(), jsonSchema: EXTRACT_PATHS_SCHEMA, onProgress });
              recordUsage(extractResp.usage);
              logRequest({ tool: "check_imports", model: extractResp.model, status: "success", usage: extractResp.usage, filePath });
              const rawPaths = extractResp.parsed.paths;
              const extractedPaths: string[] = Array.isArray(rawPaths) ? rawPaths.filter((p): p is string => typeof p === "string") : [];
              const validPaths: string[] = []; const brokenPaths: string[] = []; const packageImports: string[] = [];
              for (const importPath of extractedPaths) {
                if (!importPath.startsWith(".") && !importPath.startsWith("/")) { packageImports.push(importPath); continue; }
                const resolveDir = importPath.startsWith(".") ? fileDir : ciResolveBase;
                const resolvedBase = importPath.startsWith("/") ? resolve(importPath) : join(resolveDir, importPath);
                if (!resolvedBase.startsWith(ciResolveBase) && !resolvedBase.startsWith(fileDir)) { packageImports.push(importPath); continue; }
                let found = existsSync(resolvedBase) && statSync(resolvedBase).isFile();
                if (!found && !extname(resolvedBase)) {
                  for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".json"]) { if (existsSync(resolvedBase + ext)) { found = true; break; } }
                  if (!found) { for (const ext of [".ts", ".tsx", ".js", ".jsx"]) { if (existsSync(join(resolvedBase, `index${ext}`))) { found = true; break; } } }
                }
                (found ? validPaths : brokenPaths).push(importPath);
              }
              const lines = [`# Import Check: ${filePath}`, "", `**Total**: ${extractedPaths.length}, **Valid**: ${validPaths.length}, **BROKEN**: ${brokenPaths.length}, **Packages**: ${packageImports.length}`, ""];
              if (brokenPaths.length > 0) lines.push("## BROKEN IMPORTS", "", ...brokenPaths.map((p) => `- \`${p}\``), "");
              if (validPaths.length > 0) lines.push("## Valid", "", ...validPaths.map((p) => `- \`${p}\``), "");
              gReports.push(lines.join("\n"));
            }
            if (gReports.length > 0) {
              const mergedPath = saveResponse("check_imports", gReports.join("\n\n---\n\n"), {
                model: currentBackend.model, task: "Check imports", inputFile: fg.files[0], groupId: gid,
              });
              ciGroupReports.push(`[group:${gid}] ${mergedPath}`);
            }
          }
          if (ciGroupReports.length === 0) {
            return { content: [{ type: "text", text: "No reports generated." }], isError: true };
          }
          return { content: [{ type: "text", text: ciGroupReports.join("\n") }] };
        }

        // Non-grouped: existing behavior
        const ciFilePaths = ciFilePathsAll;
        const ciReports: string[] = [];
        const ciReportPaths: string[] = [];

        for (const filePath of ciFilePaths) {
          if (!existsSync(filePath)) {
            ciReports.push(`## ${filePath}\n\nFAILED: File not found.`);
            ciReportPaths.push("(skipped — file not found)");
            continue;
          }
          const ciLang = detectLang(filePath);
          const fileDir = dirname(filePath);
          // Use project_root for resolving imports if provided, fall back to file's directory
          const ciResolveBase = project_root || fileDir;

          // Phase 1: Ask LLM to extract all file/import references
          const extractMessages: ChatMessage[] = [
            {
              role: "system",
              content:
                `Expert ${ciLang} developer. Extract ALL file path references and import statements from the source code. ` +
                "The source file is labeled with its full path inside a filename tag before the file-content tag — reference it by that path. " +
                "Include: import/require paths, file path strings, configuration references. " +
                'Return JSON: {"paths": ["./relative/path", "package-name", "../other/file"]}. ' +
                "Include both local (relative) and package imports. Be exhaustive." +
                FILE_FORMAT_EXAMPLE,
            },
            {
              role: "user",
              content:
                `${ciPrompt ? ciPrompt + "\n\n" : ""}Extract all import and file references from:\n\n` +
                readFileAsCodeBlock(filePath, undefined, ciRedact, ciBudgetBytes, ciRegexRedact),
            },
          ];

          const extractResp = await chatCompletionJSON(extractMessages, {
            temperature: 0,
            maxTokens: resolveDefaultMaxTokens(),
            jsonSchema: EXTRACT_PATHS_SCHEMA,
            onProgress,
          });
          recordUsage(extractResp.usage);
          logRequest({
            tool: "check_imports",
            model: extractResp.model,
            status: "success",
            usage: extractResp.usage,
            filePath,
          });

          const rawPaths = extractResp.parsed.paths;
          const extractedPaths: string[] = Array.isArray(rawPaths)
            ? rawPaths.filter((p): p is string => typeof p === "string")
            : [];

          // Phase 2: Validate each path on disk
          const validPaths: string[] = [];
          const brokenPaths: string[] = [];
          const packageImports: string[] = [];

          for (const importPath of extractedPaths) {
            // Skip package/module imports (not relative paths)
            if (!importPath.startsWith(".") && !importPath.startsWith("/")) {
              packageImports.push(importPath);
              continue;
            }
            // Dot-relative imports (./foo, ../bar) resolve against the file's own directory,
            // NOT project_root. Only absolute paths use ciResolveBase.
            const resolveDir = importPath.startsWith(".")
              ? fileDir
              : ciResolveBase;
            const resolvedBase = importPath.startsWith("/")
              ? resolve(importPath)
              : join(resolveDir, importPath);
            // Reject paths resolving outside allowed project directories to prevent filesystem oracle attacks.
            if (!resolvedBase.startsWith(ciResolveBase) && !resolvedBase.startsWith(fileDir)) {
              packageImports.push(importPath);
              continue;
            }
            let found = false;

            if (existsSync(resolvedBase) && statSync(resolvedBase).isFile()) {
              found = true;
            }
            if (!found && !extname(resolvedBase)) {
              for (const ext of [
                ".ts",
                ".tsx",
                ".js",
                ".jsx",
                ".mjs",
                ".cjs",
                ".py",
                ".go",
                ".rs",
                ".json",
              ]) {
                if (existsSync(resolvedBase + ext)) {
                  found = true;
                  break;
                }
              }
              if (!found) {
                for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
                  if (existsSync(join(resolvedBase, `index${ext}`))) {
                    found = true;
                    break;
                  }
                }
              }
            }

            if (found) {
              validPaths.push(importPath);
            } else {
              brokenPaths.push(importPath);
            }
          }

          // Build report
          const ciReportLines: string[] = [
            `# Import Check: ${filePath}`,
            "",
            `**Total references extracted**: ${extractedPaths.length}`,
            `**Local valid**: ${validPaths.length}`,
            `**Local BROKEN**: ${brokenPaths.length}`,
            `**Package imports** (not checked): ${packageImports.length}`,
            "",
          ];
          if (brokenPaths.length > 0) {
            ciReportLines.push(
              "## BROKEN IMPORTS",
              "",
              ...brokenPaths.map((p) => `- \`${p}\``),
              "",
            );
          }
          if (validPaths.length > 0) {
            ciReportLines.push(
              "## Valid Imports",
              "",
              ...validPaths.map((p) => `- \`${p}\``),
              "",
            );
          }
          if (packageImports.length > 0) {
            ciReportLines.push(
              "## Package Imports (not checked)",
              "",
              ...packageImports.map((p) => `- \`${p}\``),
              "",
            );
          }

          const ciReportText = ciReportLines.join("\n");
          if (ciMode === 0) {
            const rp = saveResponse("check_imports", ciReportText, {
              model: extractResp.model,
              task: "Check imports",
              inputFile: filePath,
            });
            ciReportPaths.push(rp);
          } else {
            ciReports.push(ciReportText);
          }
        }

        if (ciMode === 0) {
          return {
            content: [
              {
                type: "text",
                text:
                  ciReportPaths.length > 0
                    ? ciReportPaths.join("\n")
                    : "No reports generated.",
              },
            ],
          };
        }
        if (ciReports.length === 0) {
          return {
            content: [{ type: "text", text: "No reports generated." }],
            isError: true,
          };
        }
        const ciMergedPath = saveResponse(
          "check_imports",
          ciReports.join("\n\n---\n\n"),
          {
            model: currentBackend.model,
            task: "Check imports",
            inputFile: ciFilePaths[0],
          },
        );
        return { content: [{ type: "text", text: ciMergedPath }] };
      }

      case "check_against_specs": {
        const {
          spec_file_path: csSpecPath,
          input_files_paths: csInputPathsRaw,
          folder_path: csFolderPath,
          extensions: csExtensions,
          exclude_dirs: csExcludeDirs,
          use_gitignore: csUseGitignore,
          instructions: csInstructions,
          instructions_files_paths: csInstructionsFilesPaths,
          scan_secrets: csScan,
          redact_secrets: csRedact,
          answer_mode: csRawMode,
          max_payload_kb: csMaxPayloadKb,
          redact_regex: csRedactRegexRaw,
        } = args as {
          spec_file_path: string;
          input_files_paths?: string | string[];
          redact_regex?: string;
          folder_path?: string;
          extensions?: string[];
          exclude_dirs?: string[];
          use_gitignore?: boolean;
          instructions?: string;
          instructions_files_paths?: string | string[];
          scan_secrets?: boolean;
          redact_secrets?: boolean;
          answer_mode?: number;
          max_payload_kb?: number;
        };
        const csUseEnsemble = currentBackend.type === "openrouter";
        const csBudgetBytes = (csMaxPayloadKb ?? 400) * 1024;
        const csMode = resolveAnswerMode(csRawMode, 0);

        // Validate redact_regex upfront
        let csRegexRedact: RegexRedactOpts | null = null;
        try {
          csRegexRedact = parseRedactRegex(csRedactRegexRaw);
        } catch (err) {
          return { content: [{ type: "text", text: `FAILED: ${(err as Error).message}` }], isError: true };
        }

        // Validate required params
        if (!csSpecPath) {
          return {
            content: [{ type: "text", text: "FAILED: spec_file_path is required." }],
            isError: true,
          };
        }

        // Reject if both folder_path and input_files_paths are provided
        const csNormalized = normalizePaths(csInputPathsRaw);

        // Resolve source files from input_files_paths AND/OR folder_path (can combine both)
        let csFilePaths: string[] = [...csNormalized];
        if (csFolderPath) {
          const csFolderResult = resolveFolderPath(csFolderPath, {
            extensions: csExtensions,
            excludeDirs: csExcludeDirs,
            useGitignore: csUseGitignore,
            maxFiles: (args as { max_files?: number }).max_files,
          });
          if (csFolderResult.error && csFolderResult.files.length === 0 && csFilePaths.length === 0) {
            return { content: [{ type: "text", text: `FAILED: ${csFolderResult.error}` }], isError: true };
          }
          csFilePaths = [...csFilePaths, ...csFolderResult.files];
        }
        if (csFilePaths.length === 0) {
          return {
            content: [{ type: "text", text: "FAILED: Provide input_files_paths or folder_path." }],
            isError: true,
          };
        }

        // Read the spec file
        let csSpecBlock: string;
        try {
          csSpecBlock = readFileAsCodeBlock(csSpecPath, undefined, csRedact, csBudgetBytes, null, "specs-");
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text", text: `FAILED: Cannot read spec file: ${errMsg}` }],
            isError: true,
          };
        }

        // scan_secrets: abort if any secrets are found (filter out group markers).
        // When redact_secrets is also true, skip the abort — downstream redaction handles it.
        if (csScan && !csRedact) {
          const csRealFiles = csFilePaths.filter((f) => !GROUP_HEADER_RE.test(f) && !GROUP_FOOTER_RE.test(f));
          const scanResult = scanFilesForSecrets([csSpecPath, ...csRealFiles]);
          if (scanResult.found)
            return {
              content: [{ type: "text", text: scanResult.report }],
              isError: true,
            };
        }

        // Resolve additional instructions
        const csExtraInstructions = resolvePrompt(csInstructions, csInstructionsFilesPaths);

        // Build the system prompt for spec compliance checking
        const csSystemPrompt =
          "You are a strict specification compliance auditor. You will receive a SPECIFICATION FILE " +
          "and one or more SOURCE FILES. Your job is to find every violation of the specification " +
          "in the source files.\n\n" +
          "RULES:\n" +
          "1. The specification is the ABSOLUTE source of truth. Every rule, restriction, format, " +
          "API contract, forbidden pattern, and requirement in the spec MUST be followed exactly.\n" +
          "2. Report ONLY VIOLATIONS — things implemented WRONGLY or FORBIDDEN patterns used. " +
          "Do NOT report MISSING features — some requirements may be implemented in other files " +
          "that are not included here.\n" +
          "3. For each violation, report:\n" +
          "   - **File**: which source file\n" +
          "   - **Location**: function/class/method name (NEVER line numbers)\n" +
          "   - **Spec rule violated**: quote the exact spec text\n" +
          "   - **What the code does**: describe the actual behavior\n" +
          "   - **Severity**: CRITICAL (security/data loss), HIGH (wrong behavior), " +
          "MEDIUM (non-compliance), LOW (style/convention)\n" +
          "4. If a source file has NO violations, explicitly state: 'CLEAN — no spec violations found.'\n" +
          "5. At the end, provide a SUMMARY with total violation counts by severity.\n" +
          "6. Be specific and actionable — reference concrete function names, variable names, and code patterns.\n" +
          "\nSPEC FORMAT: The specification file is wrapped in <specs-filename> and <specs-file-content> tags (distinct from source file tags).\n" +
          FILE_FORMAT_EXAMPLE + BREVITY_RULES;

        // Compute prompt bytes for budget
        const csSpecBytes = Buffer.byteLength(csSpecBlock, "utf-8");
        const csSystemBytes = Buffer.byteLength(csSystemPrompt, "utf-8");
        const csExtraBytes = Buffer.byteLength(csExtraInstructions, "utf-8");
        const csPromptBytes = csSpecBytes + csSystemBytes + csExtraBytes;

        // ── Group-aware processing (only for input_files_paths, not folder_path) ──
        // answer_mode=1 means "one report per group". Auto-group the input
        // files when the caller did not supply ---GROUP:id--- markers.
        // folder_path input already normalizes to a single unnamed group, so
        // auto-grouping works on csFilePaths regardless of the source.
        let csFileGroups = csFolderPath
          ? [{ id: "", files: csFilePaths }]
          : parseFileGroups(csFilePaths);
        let csEffectivelyGrouped = hasNamedGroups(csFileGroups);
        if (csMode === 1 && !csEffectivelyGrouped) {
          const autoGroups = autoGroupByHeuristic(csFilePaths);
          if (autoGroups.length > 0) {
            csFileGroups = autoGroups;
            csEffectivelyGrouped = true;
          }
        }
        const csAllGroupReports: string[] = [];

        for (const fg of csFileGroups) {
          const fgPaths = fg.files;
          if (fgPaths.length === 0) continue;
          const fgId = fg.id;

          // Mode 0 (non-grouped only): one output report per input file
          if (csMode === 0 && !csEffectivelyGrouped) {
            const csPerFileResults: string[] = [];
            for (const fp of fgPaths) {
              if (!existsSync(fp)) {
                csPerFileResults.push(`FAILED: ${fp} — File not found`);
                continue;
              }
              let fpBlock: string;
              try {
                fpBlock = readFileAsCodeBlock(fp, undefined, csRedact, csBudgetBytes, csRegexRedact);
              } catch (err) {
                csPerFileResults.push(`FAILED: ${fp} — ${err instanceof Error ? err.message : String(err)}`);
                continue;
              }
              let fpUserContent = "## SPECIFICATION (source of truth)\n\n" + csSpecBlock + "\n\n";
              if (csExtraInstructions) {
                fpUserContent += "## ADDITIONAL INSTRUCTIONS\n\n" + csExtraInstructions + "\n\n";
              }
              fpUserContent += "## SOURCE FILES TO CHECK\n\n" + fpBlock;
              const fpMessages: ChatMessage[] = [
                { role: "system", content: csSystemPrompt },
                { role: "user", content: fpUserContent },
              ];
              const fpResp = await ensembleStreaming(
                fpMessages,
                { maxTokens: resolveDefaultMaxTokens(), onProgress, modelOverride },
                csUseEnsemble,
              );
              if (fpResp.content.trim().length === 0) {
                csPerFileResults.push(`FAILED: ${fp} — LLM returned empty response`);
                continue;
              }
              const fpFooter = formatFooter(fpResp, "check_against_specs", fp);
              const fpReportPath = saveResponse("check_against_specs", fpResp.content + fpFooter, {
                model: ensembleModelLabel(csUseEnsemble),
                task: `Spec compliance: ${basename(csSpecPath)} vs ${basename(fp)}`,
                inputFile: fp,
              }, undefined, outputDir);
              csPerFileResults.push(fpReportPath);
            }
            return { content: [{ type: "text", text: csPerFileResults.join("\n") }] };
          }

          // Group source files using FFD bin packing
          const { groups: csGroups, autoBatched: csAutoBatched, skipped: csSkipped } =
            readAndGroupFiles(fgPaths, csPromptBytes, csRedact, csBudgetBytes, csRegexRedact);

          const csBatchResults: string[] = [];
          if (csSkipped.length > 0) {
            csBatchResults.push(
              `SKIPPED (exceeds ${csBudgetBytes / 1024} KB payload budget): ${csSkipped.length} file(s)\n` +
              csSkipped.map((f) => `  - ${f}`).join("\n"),
            );
          }

          for (let gi = 0; gi < csGroups.length; gi++) {
            const group = csGroups[gi];
            let userContent =
              "## SPECIFICATION (source of truth)\n\n" + csSpecBlock + "\n\n";
            if (csExtraInstructions) {
              userContent += "## ADDITIONAL INSTRUCTIONS\n\n" + csExtraInstructions + "\n\n";
            }
            userContent += "## SOURCE FILES TO CHECK\n\n";
            for (const fd of group) {
              userContent += `\n\n${fd.block}`;
            }

            const csMessages: ChatMessage[] = [
              { role: "system", content: csSystemPrompt },
              { role: "user", content: userContent },
            ];

            const csResp = await ensembleStreaming(
              csMessages,
              { maxTokens: resolveDefaultMaxTokens(), onProgress, modelOverride },
              csUseEnsemble,
            );
            const csFooter = formatFooter(csResp, "check_against_specs", group[0]?.path);
            if (csResp.content.trim().length > 0) {
              if (csAutoBatched) {
                const fileList = group.map((fd) => fd.path).join(", ");
                csBatchResults.push(
                  `## Batch ${gi + 1}/${csGroups.length}\n\nFiles: ${fileList}\n\n${csResp.content}${csFooter}`,
                );
              } else {
                csBatchResults.push(csResp.content + csFooter);
              }
            }
          }

          if (csBatchResults.length === 0) continue;
          const csFinalContent = csBatchResults.join("\n\n---\n\n");
          const csMergedModel = ensembleModelLabel(csUseEnsemble);
          const csReportPath = saveResponse("check_against_specs", csFinalContent, {
            model: csMergedModel,
            task: `Spec compliance: ${basename(csSpecPath)} vs ${fgPaths.length} file(s)`,
            inputFile: fgPaths[0],
            groupId: fgId || undefined,
          });

          if (csEffectivelyGrouped) {
            const labelId = fgId || "auto";
            csAllGroupReports.push(`[group:${labelId}] ${csReportPath}`);
          } else {
            return { content: [{ type: "text", text: csReportPath }] };
          }
        }

        // Grouped: return per-group reports
        if (csEffectivelyGrouped) {
          if (csAllGroupReports.length === 0) {
            return { content: [{ type: "text", text: "FAILED: No results for any group." }], isError: true };
          }
          return { content: [{ type: "text", text: csAllGroupReports.join("\n") }] };
        }
        return { content: [{ type: "text", text: "FAILED: LLM returned empty response." }], isError: true };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
    } finally {
      // Release active request tracker so `reset` can proceed when all LLM calls finish
      if (isLLMTool) trackRequestEnd();
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    // Log errors to the session log file
    logRequest({
      tool: name,
      model: currentBackend.model ?? "",
      status: "error",
      error: errMsg,
    });
    return {
      content: [{ type: "text", text: `Error: ${errMsg}` }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Write initial stats file at startup so statusline can show MCP icons immediately
  writeStatsFile();
  const backendLabel =
    currentBackend.type === "openrouter"
      ? `OpenRouter (${currentBackend.model})`
      : `Local (${currentBackend.baseUrl}${currentBackend.model ? `, ${currentBackend.model}` : ""})`;
  process.stderr.write(
    `LLM Externalizer server running — backend: ${backendLabel}\n`,
  );
  process.stderr.write(`Settings: ${SETTINGS_FILE}\n`);
  process.stderr.write(`Session log: ${LOG_FILE}\n`);
}

main().catch((error) => {
  process.stderr.write(`Fatal error: ${error}\n`);
  process.exit(1);
});
