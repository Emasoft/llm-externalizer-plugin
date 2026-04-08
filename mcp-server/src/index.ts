#!/usr/bin/env node
/**
 * LLM Externalizer — MCP Server for LLMs via OpenAI-compatible APIs
 *
 * Supports both local models (LM Studio, Ollama, vLLM) and remote models
 * via OpenRouter. The active model can be switched at runtime with the
 * change_model tool using fuzzy name matching.
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  renameSync,
  copyFileSync,
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
import { extname, join, basename, dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

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

// ── Write operation queue ─────────────────────────────────────────────
// Serializes ALL write tool calls (fix_code, batch_fix, merge_files,
// split_file, revert_file) so only one runs at a time. Even if a swarm
// of agents call the MCP with hundreds of commands simultaneously, write
// operations are queued and executed sequentially. Within a single
// batch_fix, parallel LLM calls are still allowed since they operate on
// different file sets.
// Read-only tools (chat, code_task, batch_check, etc.) bypass the queue.

let writeQueueTail: Promise<void> = Promise.resolve();
let writeQueueDepth = 0;

function withWriteQueue<T>(
  fn: () => Promise<T>,
  onProgress?: ProgressFn,
): Promise<T> {
  const position = ++writeQueueDepth;
  const previous = writeQueueTail;
  let release: () => void;
  writeQueueTail = new Promise<void>((r) => {
    release = r;
  });

  // Send keepalive progress while waiting in queue to prevent MCP client timeout.
  // The MCP client may timeout after 60s of inactivity — progress notifications reset that timer.
  let queueTimer: ReturnType<typeof setInterval> | undefined;
  if (onProgress && position > 1) {
    try {
      onProgress(
        0,
        100,
        `Queued — waiting for ${position - 1} write operation(s) to finish…`,
      );
    } catch {
      /* progress is best-effort */
    }
    queueTimer = setInterval(() => {
      try {
        onProgress(
          0,
          100,
          `Still queued — waiting for write operations ahead in queue…`,
        );
      } catch {
        /* progress is best-effort */
      }
    }, 10_000);
  }

  return previous.then(async () => {
    if (queueTimer) clearInterval(queueTimer);
    writeQueueDepth = Math.max(0, writeQueueDepth - 1);
    try {
      return await fn();
    } finally {
      release!();
    }
  });
}

// ── Per-file locking (defense-in-depth) ──────────────────────────────
// C3: Use Map<path, Promise> for proper async serialization instead of
// a racy Set. Each file gets its own chain — concurrent acquires on the
// same file wait; different files proceed in parallel.
const activeFileLocks = new Map<string, Promise<void>>();

function acquireFileLock(filePath: string): boolean {
  const resolved = resolve(filePath);
  if (activeFileLocks.has(resolved)) return false;
  activeFileLocks.set(resolved, Promise.resolve());
  return true;
}

function releaseFileLock(filePath: string): void {
  activeFileLocks.delete(resolve(filePath));
}

// ── Git branch monitoring ────────────────────────────────────────────
// Detects when a user switches git branches mid-operation, which would
// cause us to write LLM-modified output into the wrong branch.

/** Get the current git branch for the repo containing `filePath`. Returns null if not in a git repo. */
function getGitBranch(filePath: string): string | null {
  const dir =
    existsSync(filePath) && statSync(filePath).isDirectory()
      ? filePath
      : dirname(filePath);
  const result = spawnSync("git", ["branch", "--show-current"], {
    cwd: dir,
    encoding: "utf-8",
    timeout: 5000,
  });
  if (result.status !== 0 || result.error) return null;
  const branch = result.stdout.trim();
  // Empty string means detached HEAD — still valid, return special marker
  return branch || "(detached HEAD)";
}

/** Throws if the git branch changed since `expectedBranch` was captured. No-op if not in a git repo. */
function assertBranchUnchanged(
  filePath: string,
  expectedBranch: string | null,
): void {
  if (expectedBranch === null) return; // Not in a git repo at start — skip check
  const current = getGitBranch(filePath);
  if (current === null) return; // Repo was removed? Skip — not our problem
  if (current !== expectedBranch) {
    throw new Error(
      `Git branch changed during operation: was "${expectedBranch}", now "${current}". ` +
        `Aborting to prevent writing to the wrong branch. Re-run the operation on the correct branch.`,
    );
  }
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
  return `${fence}${lang} ${filePath}\n${content}\n${fence}`;
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

// ── Path traversal prevention ────────────────────────────────────────

/** Ensure a path doesn't escape the base directory via .. traversal. */
function sanitizeOutputPath(baseDir: string, relativePath: string): string {
  const full = relativePath.startsWith("/")
    ? relativePath
    : join(baseDir, relativePath);
  const normalized = resolve(full);
  const normalizedBase = resolve(baseDir);
  if (
    !normalized.startsWith(normalizedBase + "/") &&
    normalized !== normalizedBase
  ) {
    throw new Error(
      `Path traversal blocked: "${relativePath}" escapes output directory "${baseDir}"`,
    );
  }
  return normalized;
}

// ── BOM and line ending preservation ─────────────────────────────────
// LLMs strip BOMs and normalise CRLF → LF. Write tools must detect the
// original conventions and restore them after LLM processing.

const UTF8_BOM = "\uFEFF";

/** Detect whether content starts with a UTF-8 BOM. */
function hasBOM(content: string): boolean {
  return content.startsWith(UTF8_BOM);
}

/** Detect the dominant line ending style in content. Returns '\r\n' or '\n'. */
function detectLineEnding(content: string): "\r\n" | "\n" {
  const crlfCount = (content.match(/\r\n/g) ?? []).length;
  const lfOnly = (content.match(/(?<!\r)\n/g) ?? []).length;
  return crlfCount > lfOnly ? "\r\n" : "\n";
}

/**
 * Restore original BOM and line endings to LLM output.
 * Call this on the LLM's output before writing it back to disk.
 */
function restoreFileConventions(
  content: string,
  originalHadBOM: boolean,
  originalLineEnding: "\r\n" | "\n",
): string {
  let result = content;
  // Restore CRLF if the original used it (LLM output is always LF)
  if (originalLineEnding === "\r\n") {
    // Normalise to LF first (in case LLM output has mixed endings), then convert to CRLF
    result = result.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
  }
  // Restore BOM if the original had one
  if (originalHadBOM && !result.startsWith(UTF8_BOM)) {
    result = UTF8_BOM + result;
  }
  return result;
}

/**
 * Comprehensive structural integrity check for LLM-modified code.
 * Compares the fixed code against the original to detect ANY anomaly.
 * Philosophy: better a false positive (reverting a valid fix) than letting
 * corruption through. Returns null if OK, error string if ANY anomaly detected.
 */
function verifyStructuralIntegrity(
  originalContent: string,
  fixedContent: string,
): string | null {
  const originalLines = originalContent.split("\n");
  const fixedLines = fixedContent.split("\n");
  const origLineCount = originalLines.length;
  const fixedLineCount = fixedLines.length;

  // 1. Empty output — always reject
  if (fixedContent.trim().length === 0) {
    return "Output is empty";
  }

  // 2. Suspiciously small output — catches both severe truncation and garbage responses
  //    like "ok", "done", or a few chars where a full file was expected.
  if (originalContent.length > 50 && fixedContent.length < 20) {
    return `Output is only ${fixedContent.length} chars (original: ${originalContent.length}) — likely not a valid file`;
  }

  // 3. Size ratio — output should not be < 30% of original
  const sizeRatio = fixedContent.length / originalContent.length;
  if (originalContent.length > 100 && sizeRatio < 0.3) {
    return `Output is only ${(sizeRatio * 100).toFixed(0)}% of original size (${fixedContent.length} vs ${originalContent.length} chars)`;
  }

  // 4. Line collapse detection — the main corruption pattern from the bug report.
  //    Legitimate edits change lines AND chars proportionally.
  //    Newline stripping: lines vanish but chars stay. charRatio/lineRatio explodes.
  //    Threshold lowered from 10 to 3 to catch small-file corruption.
  if (origLineCount >= 3) {
    const lineRatio = fixedLineCount / origLineCount;
    const charRatio = fixedContent.length / originalContent.length;
    // If lines dropped by more than 30%, check if chars also dropped proportionally
    if (lineRatio < 0.7 && lineRatio > 0) {
      const inflation = charRatio / lineRatio;
      // Threshold 2.0 — aggressive, prefers false positives over missed corruption
      if (inflation > 2.0) {
        return `Line count dropped ${origLineCount}→${fixedLineCount} (${(lineRatio * 100).toFixed(0)}%) but chars only to ${(charRatio * 100).toFixed(0)}%. Inflation=${inflation.toFixed(1)}x — likely newline stripping`;
      }
    }
  }

  // 5. Maximum line length explosion — if any single line is absurdly long
  //    compared to the original's max, the LLM likely joined lines.
  // Use reduce instead of Math.max(...arr) to avoid stack overflow on large files
  const origMaxLineLen = Math.max(
    originalLines.reduce((m, l) => (l.length > m ? l.length : m), 0),
    1,
  );
  const fixedMaxLineLen = Math.max(
    fixedLines.reduce((m, l) => (l.length > m ? l.length : m), 0),
    1,
  );
  // If the longest line grew 5x+ AND exceeds 500 chars, flag it
  if (fixedMaxLineLen > origMaxLineLen * 5 && fixedMaxLineLen > 500) {
    return `Longest line exploded from ${origMaxLineLen} to ${fixedMaxLineLen} chars — likely line joining`;
  }

  // 6. Binary/garbage detection — check for null bytes
  const nullBytes = (fixedContent.match(/\0/g) ?? []).length;
  if (nullBytes > 0) {
    return `Output contains ${nullBytes} null byte(s) — binary corruption`;
  }

  // 7. Truncation detection — if the original ends with a closing delimiter but
  //    the fixed output ends mid-statement, the LLM likely truncated the response.
  //    Only check files large enough that truncation is a real risk (> 50 lines).
  // M4: Lowered threshold from >50 to >10 lines to catch small-file truncation
  if (origLineCount > 10 && fixedLineCount > 5) {
    const lastOrigLine = originalLines[origLineCount - 1].trim();
    const lastFixedLine = fixedLines[fixedLineCount - 1].trim();
    // Original ends with a proper file-ending pattern (closing brace, EOF marker, etc.)
    // but fixed output ends with an opening construct — clear truncation signal
    const endsWithClosing =
      /^[}\])]|^end\b|^fi\b|^done\b|^esac\b|^#endif/i.test(lastOrigLine);
    const endsWithOpening =
      /[{([]$|^(if|for|while|def|func|class|switch|case)\b/i.test(
        lastFixedLine,
      );
    if (endsWithClosing && endsWithOpening && sizeRatio < 0.8) {
      return `Likely truncation: original ends with "${lastOrigLine}" but output ends with "${lastFixedLine.substring(0, 60)}" (${(sizeRatio * 100).toFixed(0)}% of original size)`;
    }
  }

  return null; // All checks passed
}

// ── Secret scanning and redaction ────────────────────────────────────
// Two modes:
//   scan_secrets=true    → detect secrets, abort operation (fail-fast)
//   redact_secrets=true  → replace secrets with tracked placeholders, continue
//
// Write tools (fix_code, batch_fix, merge_files, split_file) use REVERSIBLE
// redaction — placeholders carry a numeric ID that maps back to the original
// secret. After the LLM processes the code, secrets are restored before
// writing the file back.
//
// Read-only tools use irreversible [REDACTED:LABEL] format since no
// restoration is needed and the label is more informative for analysis.

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

// ── Reversible redaction for write tools ─────────────────────────────
// Secrets are replaced with tracked placeholders that carry a numeric ID.
// After the LLM returns modified code, secrets are restored by ID lookup.
//
// Placeholder formats (random UUID-based, thread-safe):
//   Alphanumeric secret: REDACTED_<uuid16>_REDACTED
//   Numeric-only secret: 53246732<uuid16>53246732

interface TrackedRedaction {
  id: string;
  original: string;
  label: string;
  placeholder: string;
}

// C2: Use random IDs instead of sequential counter to avoid race conditions
// under parallel batch_fix. randomUUID is thread-safe in Node.js.
// L8: Random IDs also make placeholders unpredictable.

/**
 * Reversible redaction — replaces secrets with tracked placeholders.
 * Returns entries map for later restoration via restoreSecrets().
 * Used by write tools (fix_code, batch_fix, merge_files, split_file).
 */
function redactSecretsReversible(content: string): {
  redacted: string;
  entries: TrackedRedaction[];
  count: number;
} {
  let result = content;
  const entries: TrackedRedaction[] = [];
  for (const [pattern, label] of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, (match) => {
      const id = randomUUID().replace(/-/g, "").slice(0, 16);
      // Use numeric-only placeholder if the secret has no letters
      const hasLetters = /[a-zA-Z]/.test(match);
      const placeholder = hasLetters
        ? `REDACTED_${id}_REDACTED`
        : `53246732${id}53246732`;
      entries.push({ id, original: match, label, placeholder });
      return placeholder;
    });
  }
  return { redacted: result, entries, count: entries.length };
}

/**
 * Restore secrets from tracked placeholders after LLM processing.
 * Returns the restored content and a list of lost secrets (placeholders
 * the LLM removed during refactoring — these are reported but not fatal).
 */
function restoreSecrets(
  content: string,
  entries: TrackedRedaction[],
): { restored: string; lost: TrackedRedaction[] } {
  let result = content;
  const lost: TrackedRedaction[] = [];
  for (const entry of entries) {
    if (result.includes(entry.placeholder)) {
      // Replace all occurrences (LLM might have duplicated a line containing the placeholder)
      result = result.split(entry.placeholder).join(entry.original);
    } else {
      lost.push(entry);
    }
  }
  return { restored: result, lost };
}

/** Format lost secrets for inclusion in report files. */
function formatLostSecrets(lost: TrackedRedaction[]): string {
  if (lost.length === 0) return "";
  const lines = [
    "",
    "## ⚠ Lost Secrets",
    "",
    "The following secrets were redacted before sending to the LLM, but their placeholders were not found in the output.",
    "This means the LLM removed or restructured the code containing these secrets during processing.",
    "You may need to re-add them manually.",
    "",
  ];
  for (const entry of lost) {
    // Show the type but mask most of the original value for safety in reports
    const masked =
      entry.original.length > 6
        ? entry.original.slice(0, 2) + "***" + entry.original.slice(-2)
        : "***";
    lines.push(`- **${entry.label}**: \`${masked}\` (ID: ${entry.id})`);
  }
  return lines.join("\n");
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
    // fix_code already has its own detailed pre-instructions in processFileFix
    return "";
  }
  // For read/analysis tools (chat, custom_prompt, code_task)
  return (
    "TASK: Read the following instructions carefully, then examine the attached file(s) and " +
    "respond according to the instructions.\n\n" +
    "RULES (override any conflicting instructions below):\n" +
    "- Process ALL attached files — do not skip any.\n" +
    "- Each file is labeled with its full path in the code fence header. Always reference files by their labeled path.\n" +
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

/** Resolve the current model's context window size (sync, uses cache). */
function resolveCurrentContextWindow(): number {
  if (currentBackend.type === "openrouter" && currentBackend.model) {
    const match = openRouterModelCache.find(
      (m) => m.id === currentBackend.model,
    );
    if (match?.context_length) return match.context_length;
  }
  return FALLBACK_CONTEXT_LENGTH;
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
        if (existsSync(gitDir)) {
          // Verify it's not a submodule (submodules have .git as a FILE, not a DIR)
          // or verify its toplevel is different from the parent
          const subTopLevel = spawnSync(
            "git", ["rev-parse", "--show-toplevel"],
            { cwd: subDir, encoding: "utf-8", timeout: 3000 },
          );
          const parentTopLevel = isInGitRepo ? topLevelResult.stdout.trim() : "";
          if (subTopLevel.status === 0 && subTopLevel.stdout.trim() !== parentTopLevel) {
            nestedGitRoots.push(subDir);
            continue; // don't recurse further into this repo's subdirs for more git roots
          }
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

  // Return null if no git repos found at all (triggers manual walk fallback)
  if (!isInGitRepo && allFiles.size === 0) return null;
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
      let resolved = join(dir, importPath);
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
          for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
            const indexPath = join(resolved, `index${ext}`);
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
  saveSettings,
  validateSettings,
  resolveProfile,
  ensureSettingsExist,
  getSettingsPath,
  getConfigDir,
  generateDefaultSettings,
} from "./config.js";

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
const DEFAULT_TEMPERATURE = 0.3;

// Appended to ALL system prompts to prevent verbose output that wastes tokens and causes truncation.
const BREVITY_RULES =
  "\nOUTPUT RULES:\n" +
  "- Be SUCCINCT. Use bullet points, not paragraphs.\n" +
  "- Skip preamble, filler, and restating the task.\n" +
  "- Only report findings, not things that are correct.\n" +
  "- For code reviews: skip files/areas with no issues — only mention what needs attention.\n" +
  "- Maximum 3 sentences per finding. Lead with the problem, not the context.";
const CONNECT_TIMEOUT_MS = 5000;
// Per-LLM-request timeout. Reasoning models (Qwen, etc.) need extended time for thinking.
// The MCP tool-call timeout is inactivity-based, kept alive by heartbeat — no hard cap needed.
// Default: profile timeout (300s). Extended dynamically when reasoning tokens are flowing.
let SOFT_TIMEOUT_MS = (activeResolved?.timeout ?? 300) * 1000;
const READ_CHUNK_TIMEOUT_MS = 30_000; // max wait for a single SSE chunk (stall detection)
let FALLBACK_CONTEXT_LENGTH = activeResolved?.contextWindow || 100000;
const MODEL_CACHE_TTL_MS = 3600_000; // 1 hour TTL for OpenRouter model list cache

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
    writeFileSync(tmpStats, JSON.stringify(stats), "utf-8");
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
  /** True if reasoning/thinking tokens were detected during streaming. */
  reasoningDetected?: boolean;
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
async function timedRead(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<{ done: boolean; value?: Uint8Array } | "timeout"> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    return await Promise.race([reader.read(), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

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

/**
 * Streaming chat completion with soft timeout.
 *
 * Uses SSE streaming (`stream: true`) so tokens arrive incrementally.
 * If we approach the MCP 60s request timeout (soft limit at 55s, configurable via LM_TIMEOUT), we
 * return whatever content we have so far with `truncated: true`.
 * This means large code reviews return partial results instead of nothing.
 */
async function chatCompletionStreaming(
  messages: ChatMessage[],
  options: {
    temperature?: number;
    maxTokens?: number;
    model?: string;
    onProgress?: ProgressFn;
  } = {},
): Promise<StreamingResult> {
  const conn = await resolveConnection(options);

  // Route through LM Studio native API when detected
  if (conn.isNative) {
    return chatCompletionNative(conn, messages, options);
  }

  const body: Record<string, unknown> = {
    messages,
    temperature: options.temperature ?? DEFAULT_TEMPERATURE,
    max_tokens: options.maxTokens ?? resolveDefaultMaxTokens(),
    stream: true,
    // Request usage stats in the final SSE chunk (OpenAI-compatible, supported by OpenRouter)
    stream_options: { include_usage: true },
  };
  if (conn.model) body.model = conn.model;

  const startTime = Date.now();
  const fetchOpts = {
    method: "POST",
    headers: conn.headers,
    body: JSON.stringify(body),
  };

  const res = await fetchWithRetry429(
    conn.url,
    fetchOpts,
    conn.timeout,
    startTime,
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `API error ${res.status} (${currentBackend.type}): ${text}`,
    );
  }

  if (!res.body) {
    throw new Error(
      "Response body is null — streaming not supported by endpoint",
    );
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let content = "";
  let model = "";
  let usage: StreamingResult["usage"];
  let finishReason = "";
  let truncated = false;
  let malformedChunks = 0;
  let buffer = "";
  let reasoningActive = false; // true if we've seen reasoning/thinking tokens
  let lastActivityAt = startTime; // last time ANY token (reasoning or content) was received
  // L5: Dynamic progress interval — at least 2 updates before timeout
  const progressInterval = Math.min(10_000, Math.floor(conn.timeout / 3));
  let lastProgressAt = startTime;
  const onProgress = options.onProgress;

  try {
    while (true) {
      // Check soft timeout before each read.
      // If reasoning tokens are actively flowing, suspend the timeout — the model is working,
      // not stalled. Only enforce timeout when there's been no activity for READ_CHUNK_TIMEOUT_MS.
      const elapsed = Date.now() - startTime;
      const sinceLastActivity = Date.now() - lastActivityAt;
      const isActivelyReasoning = reasoningActive && sinceLastActivity < READ_CHUNK_TIMEOUT_MS;
      if (elapsed > conn.timeout && !isActivelyReasoning) {
        truncated = true;
        process.stderr.write(
          `[llm-externalizer] Soft timeout at ${elapsed}ms, returning ${content.length} chars of partial content\n`,
        );
        break;
      }

      // Send periodic progress notification to prevent MCP client timeout
      if (onProgress && Date.now() - lastProgressAt >= progressInterval) {
        const pct = isActivelyReasoning
          ? 50 // reasoning in progress — don't show misleading % based on wall clock
          : Math.min(90, Math.round((elapsed / conn.timeout) * 100));
        const msg = isActivelyReasoning
          ? `Reasoning… ${Math.round(elapsed / 1000)}s (model is thinking)`
          : `Streaming… ${content.length} chars received`;
        onProgress(pct, 100, msg);
        lastProgressAt = Date.now();
      }

      // Read with per-chunk timeout (handles stalled generation).
      // During reasoning, use the full chunk timeout — don't cap by remaining wall-clock.
      const remaining = conn.timeout - elapsed;
      const chunkTimeout = isActivelyReasoning
        ? READ_CHUNK_TIMEOUT_MS
        : Math.min(READ_CHUNK_TIMEOUT_MS, Math.max(1000, remaining));
      const result = await timedRead(reader, chunkTimeout);

      if (result === "timeout") {
        truncated = true;
        process.stderr.write(
          `[llm-externalizer] Chunk read timeout, returning ${content.length} chars of partial content\n`,
        );
        break;
      }

      if (result.done) break;

      buffer += decoder.decode(result.value, { stream: true });

      // Parse SSE lines
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // Keep incomplete line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) continue;
        // SSE spec: space after colon is optional — handle both "data: X" and "data:X"
        const payload = trimmed.startsWith("data: ")
          ? trimmed.slice(6)
          : trimmed.slice(5);
        if (payload === "[DONE]") continue;

        try {
          const json = JSON.parse(payload);
          if (json.model) model = json.model;

          const delta = json.choices?.[0]?.delta;
          // Track reasoning/thinking tokens — the model is working, not stalled.
          // These are NOT included in the output but their presence extends the timeout.
          const reasoning = delta?.reasoning || delta?.reasoning_content || "";
          if (reasoning) {
            reasoningActive = true;
            lastActivityAt = Date.now();
          }
          // Only include the model's final answer (delta.content).
          const text = delta?.content || "";
          if (text) {
            content += text;
            lastActivityAt = Date.now();
          }

          const reason = json.choices?.[0]?.finish_reason;
          if (reason) finishReason = reason;

          // Some endpoints include usage in the final streaming chunk
          if (json.usage) usage = json.usage;
        } catch {
          // H4: Count malformed chunks — too many signals data corruption
          malformedChunks++;
        }
      }
    }
  } catch {
    // L4: Connection drop mid-stream — mark as truncated if we have partial content
    if (content.length > 0) truncated = true;
  } finally {
    // Cancel pending reads to free the TCP connection, then release the lock.
    // Fire-and-forget cancel() — awaiting it can hang on some runtimes.
    reader.cancel().catch(() => {});
    reader.releaseLock();
  }

  // H4: If >5% of chunks were malformed, flag potential data integrity issue
  if (malformedChunks > 0 && content.length > 0) {
    process.stderr.write(
      `[llm-externalizer] WARNING: ${malformedChunks} malformed SSE chunk(s) skipped\n`,
    );
  }

  return { content, model, usage, finishReason, truncated, reasoningDetected: reasoningActive };
}

// ── Non-streaming JSON completion ────────────────────────────────────
// Used for fix_code/batch_fix where we need structured output.
// Non-streaming allows response_format + response-healing plugin.

interface JSONCompletionResult {
  parsed: Record<string, unknown>;
  model: string;
  usage?: StreamingResult["usage"];
  finishReason: string;
}

// JSON schema for fix_code structured output — code and summary as separate fields
const FIX_CODE_SCHEMA = {
  name: "fix_code_response",
  strict: true,
  schema: {
    type: "object",
    properties: {
      code: {
        type: "string",
        description:
          "The COMPLETE fixed source file, every line from first to last. No truncation, no placeholders.",
      },
      summary: {
        type: "string",
        description:
          "Concise but exhaustive list of every change made. One line per fix.",
      },
    },
    required: ["code", "summary"],
    additionalProperties: false,
  },
} as const;

// JSON schema for split_file structured output — array of {path, content} file entries
const SPLIT_FILE_SCHEMA = {
  name: "split_file_response",
  strict: true,
  schema: {
    type: "object",
    properties: {
      files: {
        type: "array",
        items: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Relative file path for this module.",
            },
            content: { type: "string", description: "Complete file content." },
          },
          required: ["path", "content"],
          additionalProperties: false,
        },
        description:
          "Array of files to create. First entry should be the updated original.",
      },
      summary: {
        type: "string",
        description: "Brief description of how the file was split.",
      },
    },
    required: ["files", "summary"],
    additionalProperties: false,
  },
} as const;

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

  const body: Record<string, unknown> = {
    messages,
    temperature: options.temperature ?? DEFAULT_TEMPERATURE,
    max_tokens: options.maxTokens ?? resolveDefaultMaxTokens(),
    stream: false, // Non-streaming for structured output
  };

  if (conn.model) body.model = conn.model;

  // Structured output: json_schema + response-healing (OpenRouter only)
  if (options.jsonSchema && currentBackend.type === "openrouter") {
    body.response_format = {
      type: "json_schema",
      json_schema: options.jsonSchema,
    };
    // Response-healing plugin auto-fixes malformed JSON from weaker models
    body.plugins = [{ id: "response-healing" }];
  }

  const fetchOpts = {
    method: "POST",
    headers: conn.headers,
    body: JSON.stringify(body),
  };

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
    const res = await fetchWithRetry429(
      conn.url,
      fetchOpts,
      conn.timeout,
      jsonStartTime,
    );

    if (!res.ok) {
      const text = await res.text().catch(() => "");
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

    const rawContent = data.choices?.[0]?.message?.content ?? "";
    const model = data.model ?? conn.model ?? "";
    const usage = data.usage;
    const finishReason = data.choices?.[0]?.finish_reason ?? "";

    // Parse the JSON response — guard against empty/whitespace-only content
    if (!rawContent.trim()) {
      throw new Error(
        "LLM returned empty response (expected JSON). Model may not support structured output.",
      );
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawContent) as Record<string, unknown>;
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

  // Only show truncation warning to the caller — everything else goes to logs/statusline
  if (resp.truncated)
    return "\n\n---\n⚠ TRUNCATED (partial result due to timeout)";
  return "";
}

// ── Response file output ────────────────────────────────────────────
// LLM responses are saved to timestamped .md files in llm_externalizer_output/
// so the caller's context is never flooded with the response text.
// The output dir defaults to process.cwd() but can be overridden with LLM_OUTPUT_DIR.

const OUTPUT_DIR =
  process.env.LLM_OUTPUT_DIR || join(process.cwd(), "llm_externalizer_output");

function saveResponse(
  toolName: string,
  responseText: string,
  meta: { model: string; task?: string; inputFile?: string; groupId?: string },
  overrideFilename?: string,
): string {
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const now = new Date();
  // Include milliseconds to avoid collisions on parallel calls
  const ts = now.toISOString().replace(/[:.]/g, "-").slice(0, 23);
  // Add short UUID suffix to prevent timestamp collisions on parallel calls
  const shortId = randomUUID().slice(0, 6);
  // Include group ID in filename when processing grouped files
  const groupSuffix = meta.groupId ? `_group-${meta.groupId.replace(/[^a-zA-Z0-9_-]/g, "_")}` : "";
  const filename = overrideFilename || `${toolName}${groupSuffix}_${ts}_${shortId}.md`;
  const filepath = join(OUTPUT_DIR, filename);

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
  if (/API error 402\b/.test(msg))
    return {
      unrecoverable: true,
      serviceLevel: true,
      reason: "Payment required (credit exhausted on OpenRouter)",
    };
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

// ── File grouping support ──────────────────────────────────────────
// Callers can organize files into named groups using delimiter strings
// in the input_files_paths array. Each group is processed in isolation
// (no cross-group LLM calls) and produces its own report file.
//
// Syntax:
//   "---GROUP:<id>---"   → starts group <id>
//   "---/GROUP:<id>---"  → ends group <id> (optional: next header or end-of-array also closes)
//
// Files outside any group markers are collected into a single unnamed group.
// If no markers are present, the entire array is one unnamed group (backward compat).

const GROUP_HEADER_RE = /^---GROUP:(.+)---$/;
const GROUP_FOOTER_RE = /^---\/GROUP:(.+)---$/;

interface FileGroup {
  /** Group identifier. Empty string for ungrouped files (backward compat). */
  id: string;
  /** Absolute file paths in this group. */
  files: string[];
}

/**
 * Parse group markers from a normalized file path array.
 * Returns an array of FileGroup objects. If no markers are present,
 * returns a single group with id="" containing all files (backward compat).
 */
function parseFileGroups(paths: string[]): FileGroup[] {
  // Quick check: any markers at all?
  const hasMarkers = paths.some(
    (p) => GROUP_HEADER_RE.test(p) || GROUP_FOOTER_RE.test(p),
  );
  if (!hasMarkers) {
    // No markers — backward compatible: one unnamed group with all files
    return paths.length > 0 ? [{ id: "", files: paths }] : [];
  }

  const groups: FileGroup[] = [];
  // Collect ungrouped files (before first header, between footer and next header)
  let ungrouped: string[] = [];
  let currentGroup: FileGroup | null = null;

  for (const entry of paths) {
    const headerMatch = entry.match(GROUP_HEADER_RE);
    if (headerMatch) {
      // Close any open group
      if (currentGroup && currentGroup.files.length > 0) {
        groups.push(currentGroup);
      }
      // Flush ungrouped files
      if (ungrouped.length > 0) {
        groups.push({ id: "", files: ungrouped });
        ungrouped = [];
      }
      currentGroup = { id: headerMatch[1], files: [] };
      continue;
    }

    const footerMatch = entry.match(GROUP_FOOTER_RE);
    if (footerMatch) {
      // Close matching group
      if (currentGroup && currentGroup.files.length > 0) {
        groups.push(currentGroup);
      }
      currentGroup = null;
      continue;
    }

    // Regular file path
    if (currentGroup) {
      currentGroup.files.push(entry);
    } else {
      ungrouped.push(entry);
    }
  }

  // Close any remaining open group
  if (currentGroup && currentGroup.files.length > 0) {
    groups.push(currentGroup);
  }
  // Flush remaining ungrouped files
  if (ungrouped.length > 0) {
    groups.push({ id: "", files: ungrouped });
  }

  return groups;
}

/**
 * Check if file groups contain named groups (id !== "").
 * If true, the tool should process each group independently.
 */
function hasNamedGroups(groups: FileGroup[]): boolean {
  return groups.some((g) => g.id !== "");
}

// fileIndex disambiguates files with the same basename processed in the same millisecond
function batchReportFilename(
  toolName: string,
  batchId: string,
  filePath: string,
  fileIndex: number,
): string {
  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, "-").slice(0, 23);
  const shortUuid = batchId.slice(0, 8);
  return `${toolName}_${shortUuid}_${fileIndex}_${sanitizeFilename(filePath)}_${ts}.md`;
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
// or when a timeout caused partial output. Up to 3 retries.
// Integrates with SERVICE_HEALTH to detect systemic server issues.
const MAX_TRUNCATION_RETRIES = 3;

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

  for (let attempt = 0; attempt <= MAX_TRUNCATION_RETRIES; attempt++) {
    let resp: StreamingResult;
    try {
      resp = await chatCompletionStreaming(messages, options);
    } catch (err) {
      // Network/connection error — count as failure
      recordServiceFailure();
      const errMsg = err instanceof Error ? err.message : String(err);
      if (attempt < MAX_TRUNCATION_RETRIES) {
        process.stderr.write(
          `[llm-externalizer] Request error: ${errMsg} — retrying (${attempt + 1}/${MAX_TRUNCATION_RETRIES})\n`,
        );
        // Check if this triggered the systemic failure threshold
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

    // "stop" means normal completion — record success, return immediately
    if (resp.finishReason === "stop" && !resp.truncated) {
      recordServiceSuccess();
      return resp;
    }

    // "length" means output hit max_tokens limit — not a server issue, don't retry.
    // Append truncation notice to the content so it appears in the output report.
    if (resp.finishReason === "length") {
      recordServiceSuccess(); // The server worked fine, just hit the limit
      resp.truncated = true;
      resp.content += "\n\n---\n**TRUNCATED**: Response hit output token limit (finishReason=length). The analysis above may be incomplete.";
      process.stderr.write(
        `[llm-externalizer] finishReason=length on attempt ${attempt + 1} — output token limit hit\n`,
      );
      return resp;
    }

    // If reasoning tokens were detected but content is empty, the model was still thinking
    // when the timeout hit. Retrying starts from scratch — pointless. Return what we have.
    if (resp.reasoningDetected && resp.content.trim().length === 0) {
      process.stderr.write(
        `[llm-externalizer] Reasoning model timed out after ${Math.round(SOFT_TIMEOUT_MS / 1000)}s of thinking with no content output — skipping retries\n`,
      );
      resp.content = `⚠ Reasoning model timed out — spent ${Math.round(SOFT_TIMEOUT_MS / 1000)}s thinking but produced no content. The task may be too complex for this model's speed at this input size.`;
      resp.truncated = true;
      return resp;
    }

    // Truncated by timeout or connection drop — count as failure, retry
    recordServiceFailure();

    if (attempt < MAX_TRUNCATION_RETRIES) {
      process.stderr.write(
        `[llm-externalizer] Truncated (finishReason=${resp.finishReason}, truncated=${resp.truncated}) — retrying (${attempt + 1}/${MAX_TRUNCATION_RETRIES})\n`,
      );
      // Check systemic failure threshold
      const abort = await checkServiceHealthOrWait();
      if (abort) {
        return {
          content: abort,
          model: resp.model,
          finishReason: "error",
          truncated: true,
        };
      }
      continue;
    }

    // Exhausted retries — append notice to content for the output report
    resp.content += `\n\n---\n**TRUNCATED**: Still incomplete after ${MAX_TRUNCATION_RETRIES} retries (finishReason=${resp.finishReason}). The analysis above may be incomplete.`;
    process.stderr.write(
      `[llm-externalizer] Still truncated after ${MAX_TRUNCATION_RETRIES} retries — returning partial result\n`,
    );
    return resp;
  }

  throw new Error("Unreachable: retry loop exited without returning");
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
  },
  ensemble: boolean,
  fileLineCount?: number,
): Promise<StreamingResult> {
  // Single-model path: ensemble off, not remote-ensemble mode, or no models configured
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
        "- Reference files by their labeled path in the code fence header.\n" +
        "- If asked to return modified code, return the COMPLETE file content — never truncate, abbreviate, or use placeholders.\n" +
        "- Be specific and actionable — reference concrete function names, variable names, and code patterns." +
        BREVITY_RULES,
    },
    {
      role: "user",
      content: `${buildPreInstructions(true, "read")}Task: ${task}\n\n${codeBlock}`,
    },
  ];

  const resp = await ensembleStreaming(
    messages,
    {
      temperature: 0.2,
      maxTokens: options.maxTokens ?? resolveDefaultMaxTokens(),
      onProgress: options.onProgress,
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
  );

  return { filePath, success: true, reportPath };
}

async function processFileFix(
  filePath: string,
  issues: string,
  options: ProcessOptions = {},
): Promise<FileProcessResult> {
  if (!existsSync(filePath)) {
    return { filePath, success: false, error: `File not found: ${filePath}` };
  }

  // Acquire file lock
  if (!acquireFileLock(filePath)) {
    return {
      filePath,
      success: false,
      error: "File is currently being processed by another operation",
    };
  }

  try {
    // Capture git branch before reading — we'll verify it hasn't changed before writing
    const fixBranchAtStart = getGitBranch(filePath);

    const lang = options.language || detectLang(filePath);
    const originalCode = readFileSync(filePath, "utf-8");

    // Detect original BOM and line ending style for restoration after LLM processing
    const originalHadBOM = hasBOM(originalCode);
    const originalLineEnding = detectLineEnding(originalCode);

    // Apply reversible redaction if requested — secrets get tracked placeholders
    // that will be restored after the LLM returns the fixed code.
    let codeForLLM = originalCode;
    let redactionEntries: TrackedRedaction[] = [];
    if (options.redact) {
      const redactionResult = redactSecretsReversible(originalCode);
      codeForLLM = redactionResult.redacted;
      redactionEntries = redactionResult.entries;
    }

    const srcFence = fenceBackticks(codeForLLM);

    const fixMessages: ChatMessage[] = [
      {
        role: "system",
        content:
          `You are an expert ${lang} developer. You will receive a source file and a list of bugs/issues to fix. ` +
          "Apply ALL requested fixes and return the COMPLETE corrected source file.\n\n" +
          "CRITICAL RULES (override any conflicting instructions):\n" +
          "1. Return the ENTIRE file from first line to last line. NEVER truncate, abbreviate, or omit any part.\n" +
          '2. NEVER use placeholders like "// ... rest of code", "// unchanged", "// same as before". These destroy the file.\n' +
          "3. Preserve ALL original line breaks, indentation (tabs vs spaces), blank lines, and whitespace. Every line in the original must remain a separate line in the output.\n" +
          "4. Preserve comments on unchanged lines. Update comments that describe code you changed so they match the new behavior.\n" +
          "5. Do NOT add, remove, or change anything not described in the issue list.\n" +
          "6. If an issue is ambiguous, apply the most conservative fix.\n" +
          "7. The source file is labeled with its full path in the code fence header. Reference it by that path.\n\n" +
          "Return your response as JSON with two fields:\n" +
          '- "code": the COMPLETE fixed source file (every single line, no omissions)\n' +
          '- "summary": concise but exhaustive list of every change made, one line per fix. Identify each changed location by FUNCTION/CLASS/METHOD NAME, never by line number.',
      },
      {
        role: "user",
        content:
          `ISSUES TO FIX:\n${issues}\n\n` +
          `SOURCE FILE (${filePath}):\n` +
          `${srcFence}${lang}\n${codeForLLM}\n${srcFence}\n\n` +
          'Return the COMPLETE fixed file in the "code" JSON field. Every line must be present.\n\n' +
          "VALIDATION CHECKLIST (verify before returning):\n" +
          '- [ ] The "code" field contains the ENTIRE file — first line to last line\n' +
          "- [ ] Every line break (\\n) from the original is preserved in the output\n" +
          "- [ ] No lines were joined or concatenated — each original line remains a separate line\n" +
          "- [ ] Indentation (tabs/spaces) is identical to the original for unchanged lines\n" +
          '- [ ] No placeholders like "// rest of code" or "// unchanged" were used\n' +
          "- [ ] Only the lines described in ISSUES TO FIX were modified",
      },
    ];

    const resolvedMaxTokens = options.maxTokens ?? resolveDefaultMaxTokens();

    // Use structured output (non-streaming) — JSON schema enforced by the API,
    // response-healing plugin auto-fixes malformed JSON from weaker models.
    let fixedCode: string;
    let summary: string;
    let usageInfo: StreamingResult["usage"];

    try {
      const jsonResp = await chatCompletionJSON(fixMessages, {
        temperature: 0.1,
        maxTokens: resolvedMaxTokens,
        jsonSchema: FIX_CODE_SCHEMA,
        onProgress: options.onProgress,
      });

      fixedCode = String(jsonResp.parsed.code ?? "");
      summary = String(jsonResp.parsed.summary ?? "");
      usageInfo = jsonResp.usage;

      // Record usage for session stats and log the request
      recordUsage(usageInfo);
      logRequest({
        tool: options.batchId ? "batch_fix" : "fix_code",
        model: jsonResp.model,
        status: "success",
        usage: usageInfo,
        filePath,
      });
    } catch (jsonErr) {
      // JSON parsing failed — report the error, do NOT fall back to fence extraction
      // because a parse failure likely means truncated or garbled output.
      const errMsg =
        jsonErr instanceof Error ? jsonErr.message : String(jsonErr);
      logRequest({
        tool: options.batchId ? "batch_fix" : "fix_code",
        model: currentBackend.model ?? "",
        status: "error",
        filePath,
        error: errMsg,
      });
      return {
        filePath,
        success: false,
        error: `Structured output failed: ${errMsg}`,
      };
    }

    // Restore secrets from tracked placeholders before any validation
    let lostSecrets: TrackedRedaction[] = [];
    if (redactionEntries.length > 0) {
      const restored = restoreSecrets(fixedCode, redactionEntries);
      fixedCode = restored.restored;
      lostSecrets = restored.lost;
    }

    // Preserve the original file's trailing newline convention
    const originalEndsWithNewline = originalCode.endsWith("\n");
    if (originalEndsWithNewline && !fixedCode.endsWith("\n")) {
      fixedCode += "\n";
    } else if (!originalEndsWithNewline && fixedCode.endsWith("\n")) {
      fixedCode = fixedCode.replace(/\n+$/, "");
    }

    // Restore original BOM and line endings (LLM normalises to LF and strips BOM)
    fixedCode = restoreFileConventions(
      fixedCode,
      originalHadBOM,
      originalLineEnding,
    );

    // No changes detected — compare after trailing newline normalization
    if (fixedCode === originalCode) {
      const noChangeReport = `The LLM returned the file unchanged.\n\n## Issues Requested\n\n${issues}\n\n## Summary\n\n${summary}`;
      const rp = saveResponse(
        "fix_code_NO_CHANGE",
        noChangeReport,
        {
          model: currentBackend.model,
          task: "Fix code (NO CHANGES)",
          inputFile: filePath,
        },
        options.batchId
          ? batchReportFilename(
              "batch_fix_NO_CHANGE",
              options.batchId,
              filePath,
              options.fileIndex ?? 0,
            )
          : undefined,
      );
      return { filePath, success: true, reportPath: rp, noChange: true };
    }

    // PRE-WRITE STRUCTURAL INTEGRITY CHECK — reject before writing if corruption is obvious
    const preWriteError = verifyStructuralIntegrity(originalCode, fixedCode);
    if (preWriteError) {
      const failReport = `PRE-WRITE INTEGRITY FAILURE: ${preWriteError}\n\nFix NOT applied — file unchanged.\n\n## Summary\n\n${summary}`;
      const rp = saveResponse(
        "fix_code_INTEGRITY_FAIL",
        failReport,
        {
          model: currentBackend.model,
          task: "Fix code (INTEGRITY FAIL)",
          inputFile: filePath,
        },
        options.batchId
          ? batchReportFilename(
              "batch_fix_INTEGRITY_FAIL",
              options.batchId,
              filePath,
              options.fileIndex ?? 0,
            )
          : undefined,
      );
      return {
        filePath,
        success: false,
        reportPath: rp,
        error: `Integrity check failed: ${preWriteError}`,
      };
    }

    // Verify git branch hasn't changed since we started (prevents writing to wrong branch)
    const currentBranch = getGitBranch(filePath);
    if (
      fixBranchAtStart !== null &&
      currentBranch !== null &&
      currentBranch !== fixBranchAtStart
    ) {
      return {
        filePath,
        success: false,
        error: `Git branch changed during operation: was "${fixBranchAtStart}", now "${currentBranch}". Aborting to prevent writing to the wrong branch.`,
      };
    }

    // ── WRITE PHASE: backup → write → verify → auto-revert on ANY failure ──
    const backupPath = filePath + ".externbak";
    // CRITICAL: never overwrite an existing backup — it may be the only copy of
    // the true original. If .externbak already exists, the user must explicitly
    // revert or delete it before re-running. This prevents cascading data loss
    // when batch_fix is called multiple times on the same file.
    if (!existsSync(backupPath)) {
      copyFileSync(filePath, backupPath);
    }

    try {
      // Clean up orphaned temp file from a previous crash, if any
      const tmpPath = filePath + ".externtmp";
      if (existsSync(tmpPath)) {
        try {
          unlinkSync(tmpPath);
        } catch {
          /* best effort */
        }
      }
      writeFileSync(tmpPath, fixedCode, "utf-8");
      renameSync(tmpPath, filePath);

      // POST-WRITE VERIFICATION: re-read file and verify byte-for-byte match
      const writtenContent = readFileSync(filePath, "utf-8");
      if (writtenContent !== fixedCode) {
        throw new Error(
          "Post-write verification failed: written file does not match intended content",
        );
      }

      // POST-WRITE STRUCTURAL CHECK: verify again against original
      const postWriteError = verifyStructuralIntegrity(
        originalCode,
        writtenContent,
      );
      if (postWriteError) {
        throw new Error(`Post-write integrity check failed: ${postWriteError}`);
      }
    } catch (writeErr) {
      // ANY failure after backup was created → auto-revert immediately
      try {
        if (existsSync(backupPath)) {
          renameSync(backupPath, filePath);
        }
      } catch {
        /* revert best-effort — if this fails, backup still exists on disk */
      }
      const errMsg =
        writeErr instanceof Error ? writeErr.message : String(writeErr);
      const failReport = `AUTO-REVERTED: ${errMsg}\n\nFile restored from backup. Original file is intact.\n\n## Summary\n\n${summary}`;
      const rp = saveResponse(
        "fix_code_AUTO_REVERTED",
        failReport,
        {
          model: currentBackend.model,
          task: "Fix code (AUTO-REVERTED)",
          inputFile: filePath,
        },
        options.batchId
          ? batchReportFilename(
              "batch_fix_AUTO_REVERTED",
              options.batchId,
              filePath,
              options.fileIndex ?? 0,
            )
          : undefined,
      );
      return {
        filePath,
        success: false,
        reportPath: rp,
        error: `Auto-reverted: ${errMsg}`,
      };
    }

    // All checks passed — file is safely written and verified
    const codeFence = fenceBackticks(fixedCode);
    const lostSecretsSection = formatLostSecrets(lostSecrets);
    const reportContent = `File \`${filePath}\` has been overwritten with the corrected version.\n\n## Summary\n\n${summary}\n\n## Issues Fixed\n\n${issues}\n\n## Fixed Source Code\n\n${codeFence}${lang}\n${fixedCode}\n${codeFence}${lostSecretsSection}`;
    const reportPath = saveResponse(
      "fix_code",
      reportContent,
      {
        model: currentBackend.model,
        task: "Fix code issues",
        inputFile: filePath,
      },
      options.batchId
        ? batchReportFilename(
            "batch_fix",
            options.batchId,
            filePath,
            options.fileIndex ?? 0,
          )
        : undefined,
    );

    return { filePath, success: true, reportPath, backupPath };
  } finally {
    releaseFileLock(filePath);
  }
}

// ── MCP Tool definitions ─────────────────────────────────────────────

// Dynamic limits block appended to each task tool description.
// Changes based on which backend is active (local = sequential, OpenRouter = parallel).
function limitsBlock(): string {
  const throughput =
    currentBackend.type === "openrouter"
      ? "• PARALLEL: rate-limited dispatch (RPS auto-detected from balance). Many requests in-flight simultaneously."
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
const answerModeSchema = {
  type: "number" as const,
  enum: [0, 1, 2],
  description:
    "Controls output file organization. " +
    "0 = one .md file per input file (separate LLM calls, with parallel execution + retry when max_retries > 1). " +
    "1 = one .md file per LLM request, with structured per-file sections inside. " +
    "2 = one .md file for the entire operation (all batches merged). " +
    "Default depends on tool: 2 for chat/code_task, 0 for batch_check.",
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
  "check_against_specs",
]);

const DISABLED_TOOLS = new Set([
  "fix_code",
  "batch_fix",
  "merge_files",
  "split_file",
  "revert_file",
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
};
const DEFAULT_MODEL_LIMITS = { maxOutput: 32_000, maxInputLines: 30_000 };

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
        "Files via input_files_paths are read from disk (saves your context). " +
        "Auto-batches if total exceeds context window.\n\n" +
        "FILE GROUPING: Organize files into named groups using ---GROUP:id--- / ---/GROUP:id--- " +
        "markers in input_files_paths. Each group is processed in COMPLETE ISOLATION (no cross-group " +
        "LLM calls) and produces its own SEPARATE report file with the group ID in the filename. " +
        "Output: one line per group: [group:id] /path/to/report_group-id_....md. " +
        "WHY: Each downstream agent only reads the report for its own group, " +
        "saving context tokens by not loading findings about files it is not responsible for. " +
        "Without markers, all files are processed together (backward compatible).\n\n" +
        "CONTEXT WARNING: Remote LLM has ZERO project context — always include brief context in instructions.\n\n" +
        "OUTPUT: Saved to .md file, returns only the file path." +
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
          temperature: {
            type: "number",
            description:
              "0.1 for factual/code, 0.3 for analysis (default), 0.7 for creative. Stay under 0.5 for code.",
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
        "Code analysis with optimised code-review system prompt (temperature=0.2). " +
        "More capable than Haiku, costs less. Less capable than Sonnet/Opus.\n\n" +
        "Pass input_files_paths (read from disk, language auto-detected). " +
        "Be specific in instructions.\n\n" +
        "FILE GROUPING: Use ---GROUP:id--- / ---/GROUP:id--- markers in input_files_paths " +
        "to process groups in isolation. Each group produces its own SEPARATE report: [group:id] path. " +
        "WHY: downstream agents only read their own group's report, saving context tokens.\n\n" +
        "CONTEXT WARNING: Remote LLM has ZERO project context — always include brief context.\n\n" +
        "OUTPUT: Saved to .md file, returns only the file path." +
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
      name: "fix_code",
      description:
        "Fix bugs in source file(s). Sends file + your bug descriptions to LLM, " +
        "writes corrected code back. Creates .externbak backup — NEVER delete these until you verify the fix is correct. " +
        "Use revert_file to restore if needed.\n\n" +
        "IMPORTANT: YOU must diagnose the bugs — the LLM applies fixes mechanically. " +
        "Provide detailed, actionable issues: function names, what is wrong, what correct behavior is. " +
        "Do NOT use line numbers — reference function/variable names instead.\n\n" +
        "WARNING: OVERWRITES the file. Commit to git first.\n\n" +
        "CONTEXT WARNING: Remote LLM has ZERO project context — include brief context.\n\n" +
        "OUTPUT: Fixed file written to disk. Report saved to .md, returns only the path." +
        limitsBlock(),
      inputSchema: {
        type: "object" as const,
        properties: {
          instructions: {
            type: "string",
            description:
              "Detailed, actionable list of bugs/issues to fix. For each issue include: " +
              "the function/class name, a quote or description of the broken code, what is wrong, " +
              "and what the correct behavior should be. Do NOT reference line numbers.",
          },
          instructions_files_paths: {
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
            description:
              "Path(s) to file(s) containing fix instructions (appended to instructions).",
          },
          input_files_paths: {
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
            description:
              "Absolute path(s) to the source file(s) to fix. Files are read from disk, " +
              "sent to the LLM, and overwritten with corrected versions. COMMIT FILES FIRST. " +
              "Multiple files are processed sequentially.",
          },
          input_files_content: {
            type: "string",
            description:
              "NOT SUPPORTED for fix_code — files must be on disk (input_files_paths) " +
              "so they can be overwritten.",
          },
          language: {
            type: "string",
            description:
              "Programming language (auto-detected from file extension if not set).",
          },
          scan_secrets: {
            type: "boolean",
            description:
              "Scan input files for secrets (API keys, tokens, passwords) and ABORT if any are found. Use this to enforce clean code before processing. Best practice: move secrets to .env (gitignored) instead of relying on redaction.",
          },
          redact_secrets: {
            type: "boolean",
            description:
              'Redact secrets with reversible tracked placeholders before sending to LLM. Secrets are automatically restored when writing the fixed file back. Any secrets the LLM removed during refactoring are reported as "lost" in the report. DISCOURAGED: prefer moving secrets to .env files (gitignored) and referencing them via environment variables — this is safer than relying on redaction.',
          },
          answer_mode: answerModeSchema,
        },
        required: ["input_files_paths"],
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
      name: "reset",
      description:
        "Full soft-restart. NOT IMMEDIATE — waits for all currently running LLM requests to finish " +
        "before resetting (up to 120s timeout). Then: reloads settings.yaml from disk, clears all caches " +
        "(model list, concurrency, LM Studio detection), resets session counters (tokens/cost/calls), " +
        "re-resolves the active profile, and notifies the client to refresh the tool list. " +
        "Use when settings were changed externally, the backend is misbehaving, or you need a clean slate.",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "get_settings",
      description:
        "Copies settings.yaml to the output directory and returns the file path. " +
        "Edit the copied file with your editor tools, then call set_settings with the path. " +
        "Saves context tokens by not returning YAML inline.",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "set_settings",
      description:
        "Apply a modified settings file. Reads YAML from the given file path, validates all profiles, " +
        "creates a timestamped backup of the old settings.yaml, then writes the new one. " +
        "Invalid settings are rejected — the old file is never overwritten on error. " +
        "Workflow: get_settings → edit the returned file → set_settings with the file path.",
      inputSchema: {
        type: "object" as const,
        properties: {
          file_path: {
            type: "string",
            description:
              "Path to the YAML file to apply as the new settings. " +
              "Typically the file returned by get_settings after editing.",
          },
        },
        required: ["file_path"],
      },
    },
    {
      name: "change_model",
      description:
        "Quick model switch — updates the model in the active profile. " +
        "For full profile management, use get_settings/set_settings.",
      inputSchema: {
        type: "object" as const,
        properties: {
          model: {
            type: "string",
            description: "Model name or ID to set in the active profile.",
          },
        },
        required: ["model"],
      },
    },
    {
      name: "revert_file",
      description:
        "Revert a file that was modified by fix_code back to its original version. " +
        "When fix_code edits a file, it creates a `.externbak` backup next to the original. " +
        "This tool restores that backup, undoing the fix_code changes.\n\n" +
        "Use this when:\n" +
        "• The fixed file fails to compile or lint\n" +
        "• The fixes introduced new bugs\n" +
        "• The output was corrupted or truncated\n" +
        "• You want to try a different approach",
      inputSchema: {
        type: "object" as const,
        properties: {
          input_files_paths: {
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
            description:
              "Absolute path(s) to the file(s) to revert (the same paths you passed to fix_code).",
          },
        },
        required: ["input_files_paths"],
      },
    },
    // ── Batch Operations ────────────────────────────────────────────────
    {
      name: "batch_check",
      description:
        "DEPRECATED: Use chat or code_task with answer_mode=0 and max_retries=3 instead.\n\n" +
        "Same prompt applied to EACH file separately — one report per file.\n\n" +
        "FILE GROUPING: Use ---GROUP:id--- / ---/GROUP:id--- markers in input_files_paths " +
        "to process groups in isolation. Each group produces its own SEPARATE merged report: [group:id] path. " +
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
    {
      name: "batch_fix",
      description:
        "Fix bugs in multiple files (parallel on OpenRouter). Same instructions applied per-file. " +
        "Creates .externbak backup for each modified file. A recovery manifest JSON is written to the output directory BEFORE processing starts.\n\n" +
        "CRITICAL: NEVER delete .externbak files until you have verified ALL fixed files are correct. " +
        "Use revert_file to restore any file that was corrupted or incorrectly fixed.\n\n" +
        "If this tool times out, check the recovery manifest in the output directory (batch_fix_manifest_*.json) " +
        "to see which files were modified and revert any that need recovery.\n\n" +
        "YOU must diagnose bugs — the LLM applies fixes mechanically.\n\n" +
        "CONTEXT WARNING: Remote LLM has ZERO project context — include brief context.\n\n" +
        "Retry: 3 attempts for recoverable errors. Aborts on auth/payment errors or 3+ consecutive failures.",
      inputSchema: {
        type: "object" as const,
        properties: {
          instructions: {
            type: "string",
            description:
              "Issues to fix. Applied to each input-file — the LLM determines which issues are relevant per file.",
          },
          instructions_files_paths: {
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
            description:
              "Path(s) to file(s) containing fix instructions (appended to instructions).",
          },
          input_files_paths: {
            type: "array",
            items: { type: "string" },
            description: "Absolute paths to the source files to fix.",
          },
          input_files_content: {
            type: "string",
            description:
              "NOT SUPPORTED for batch_fix — files must be on disk via input_files_paths.",
          },
          scan_secrets: {
            type: "boolean",
            description:
              "Scan input files for secrets and ABORT if any are found. Best practice: move secrets to .env (gitignored).",
          },
          redact_secrets: {
            type: "boolean",
            description:
              "Redact secrets with reversible tracked placeholders. Secrets are restored when writing fixed files back. Lost secrets are reported. DISCOURAGED: prefer .env files.",
          },
          answer_mode: answerModeSchema,
        },
        required: ["input_files_paths"],
      },
    },
    // ── Specialized Operations ─────────────────────────────────────────
    {
      name: "scan_folder",
      description:
        "Like batch_check but auto-discovers files from a directory tree. " +
        "Filters by extension, skips hidden dirs/node_modules/.git/dist/build.\n\n" +
        "CONTEXT WARNING: Remote LLM has ZERO project context — include brief context." +
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
      name: "merge_files",
      description:
        "Merge multiple source files into one. LLM deduplicates imports and resolves conflicts. " +
        "WRITES to output_path (.externbak backup if exists).\n\n" +
        "CONTEXT WARNING: Remote LLM has ZERO project context — include brief context." +
        limitsBlock(),
      inputSchema: {
        type: "object" as const,
        properties: {
          instructions: {
            type: "string",
            description:
              "How to merge the files. Specify merge strategy, naming, conflict resolution.",
          },
          instructions_files_paths: {
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
            description: "File(s) containing merge instructions.",
          },
          input_files_paths: {
            type: "array",
            items: { type: "string" },
            description:
              "Absolute paths to the source files to merge (minimum 2).",
          },
          output_path: {
            type: "string",
            description: "Absolute path where the merged file will be written.",
          },
          scan_secrets: {
            type: "boolean",
            description:
              "Scan input files for secrets and ABORT if any are found. Best practice: move secrets to .env (gitignored).",
          },
          redact_secrets: {
            type: "boolean",
            description:
              "Redact secrets with reversible tracked placeholders. Secrets are restored when writing the output file. Lost secrets are reported. DISCOURAGED: prefer .env files.",
          },
        },
        required: ["input_files_paths", "output_path"],
      },
    },
    {
      name: "split_file",
      description:
        "Split a large file into multiple modules. First returned file is the updated entry point. " +
        "WRITES to output_dir (.externbak backups for existing files).\n\n" +
        "CONTEXT WARNING: Remote LLM has ZERO project context — include brief context." +
        limitsBlock(),
      inputSchema: {
        type: "object" as const,
        properties: {
          instructions: {
            type: "string",
            description:
              "How to split the file. Specify module boundaries, naming, what goes where.",
          },
          instructions_files_paths: {
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
            description: "File(s) containing split instructions.",
          },
          input_files_paths: {
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
            description:
              "Absolute path to the source file to split (only the first path is used).",
          },
          output_dir: {
            type: "string",
            description:
              "Absolute path to the directory for new modules. Defaults to the source file's directory.",
          },
          scan_secrets: {
            type: "boolean",
            description:
              "Scan input files for secrets and ABORT if any are found. Best practice: move secrets to .env (gitignored).",
          },
          redact_secrets: {
            type: "boolean",
            description:
              "Redact secrets with reversible tracked placeholders. Secrets are restored in each output file. Lost secrets are reported. DISCOURAGED: prefer .env files.",
          },
        },
        required: ["input_files_paths"],
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
        "WHY: downstream agents only read their own group's report, saving context tokens.\n\n" +
        "CONTEXT WARNING: Remote LLM has ZERO project context — include brief context." +
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
        "WHY: downstream agents only read their own group's report, saving context tokens.\n\n" +
        "CONTEXT WARNING: Remote LLM has ZERO project context — include brief context." +
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
        "WHY: downstream agents only read their own group's report, saving context tokens.\n\n" +
        "NOTE: The LLM does NOT have the full project — some requirements may be implemented elsewhere. " +
        "Therefore only VIOLATIONS of the spec are reported (things done wrong), not MISSING features " +
        "(things not yet implemented). Everything that IS implemented must follow the spec exactly.\n\n" +
        "CONTEXT WARNING: Remote LLM has ZERO project context — include brief context in instructions.\n\n" +
        "OUTPUT: Violation report saved to .md file, returns only the file path." +
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
  return allTools.filter((t) => !DISABLED_TOOLS.has(t.name));
}

// ── MCP Server ───────────────────────────────────────────────────────

const server = new Server(
  { name: "llm-externalizer", version: "3.9.26" },
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
    // Reject calls to disabled write tools with a clear explanation
    if (DISABLED_TOOLS.has(name)) {
      return {
        content: [
          {
            type: "text",
            text: `DISABLED: "${name}" is currently disabled. No OpenRouter model can faithfully return files >3000 lines — they abbreviate or truncate. Use code_task for analysis and apply fixes manually with Read+Edit.`,
          },
        ],
        isError: true,
      };
    }

    // Gate all tools except discover, get_settings, set_settings behind settings validation.
    // If settings.yaml is missing or misconfigured, the user must fix it first.
    if (
      !settingsValid &&
      name !== "discover" &&
      name !== "reset" &&
      name !== "get_settings" &&
      name !== "set_settings"
    ) {
      return {
        content: [
          {
            type: "text",
            text: `NOT CONFIGURED\n\n${settingsError}\n\nQuick fix: npx llm-externalizer profile select <name>\nOr run the "discover" tool to see available profiles and status.\nSettings file: ${SETTINGS_FILE}`,
          },
        ],
        isError: true,
      };
    }

    // Track active LLM requests so `reset` can wait for them to drain
    const isLLMTool = LLM_TOOLS_SET.has(name);
    if (isLLMTool) trackRequestStart();

    try {
    switch (name) {
      case "chat": {
        const {
          instructions,
          instructions_files_paths,
          input_files_paths: chatInputPathsRaw,
          input_files_content,
          system,
          temperature,
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
          temperature?: number;
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

        // scan_secrets: abort if any secrets are found in input files or inline content
        if (chatScan) {
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
        const chatMode = resolveAnswerMode(rawAnswerMode, 2);

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
          messages.push({ role: "system", content: (system || "") + BREVITY_RULES });
          messages.push({ role: "user", content: promptBase });
          const resp = await ensembleStreaming(
            messages,
            { temperature, maxTokens, onProgress },
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
        // If input_files_paths contains group markers (---GROUP:id---),
        // process each group in isolation and produce one report per group.
        const chatFileGroups = parseFileGroups(chatFilePaths);
        const chatIsGrouped = hasNamedGroups(chatFileGroups);

        // Process each group (or single unnamed group for backward compat)
        const allGroupReports: string[] = [];
        for (const fg of chatFileGroups) {
          const fgPaths = fg.files;
          if (fgPaths.length === 0) continue;
          const fgId = fg.id; // empty string for unnamed/backward-compat

          // ── Mode 0: one output file per input file (separate LLM calls) ──
          if (chatMode === 0 && !chatIsGrouped) {
            const chatRetries = chatMaxRetries ?? 1;
            if (chatRetries > 1) {
              // Robust path: parallel + retry + circuit breaker
              const rpResult = await robustPerFileProcess(fgPaths, {
                task: chatPrompt, maxRetries: chatRetries,
                redact: chatRedact, regexRedact: chatRegexRedact,
                onProgress, ensemble: useEnsemble,
                budgetBytes: chatBudgetBytes, toolName: "chat",
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

          // Group files by configurable payload budget for auto-batching
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

          // Collect results for this file group (merged mode)
          const batchResults: string[] = [];
          const batchOutputPaths: string[] = [];
          if (chatSkipped.length > 0) {
            const skipNote = `SKIPPED (exceeds 800 KB payload budget): ${chatSkipped.length} file(s)\n${chatSkipped.map((f) => `  - ${f}`).join("\n")}`;
            batchResults.push(skipNote);
          }
          for (let gi = 0; gi < groups.length; gi++) {
            const group = groups[gi];
            let userContent = promptBase;
            if (chatMode === 1 && !chatIsGrouped) {
              const groupPaths = group.map((fd) => fd.path);
              userContent += buildPerFileSectionPrompt(groupPaths);
            }
            for (const fd of group) {
              userContent += `\n\n${fd.block}`;
            }
            const messages: ChatMessage[] = [];
            messages.push({ role: "system", content: (system || "") + BREVITY_RULES });
            messages.push({ role: "user", content: userContent });
            const resp = await ensembleStreaming(
              messages,
              { temperature, maxTokens, onProgress },
              useEnsemble,
            );
            const footer = formatFooter(resp, "chat", group[0]?.path);
            if (resp.content.trim().length > 0) {
              if (chatMode === 1 && !chatIsGrouped) {
                const batchPath = saveResponse("chat", resp.content + footer, {
                  model: resp.model,
                  task: chatPrompt,
                  inputFile: group[0]?.path,
                });
                batchOutputPaths.push(batchPath);
              } else {
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
          }

          // Mode 1 (non-grouped only): return per-batch output paths
          if (chatMode === 1 && !chatIsGrouped) {
            if (batchOutputPaths.length === 0) {
              return {
                content: [{ type: "text", text: "FAILED: LLM returned empty response for all batches." }],
                isError: true,
              };
            }
            return { content: [{ type: "text", text: batchOutputPaths.join("\n") }] };
          }

          // Mode 2 (or grouped): merge batch results into one report for this file group
          if (batchResults.length === 0) continue; // skip empty groups
          const finalContent = batchResults.join("\n\n---\n\n");
          const chatMergedModel =
            ensembleModelLabel(useEnsemble);
          const savedPath = saveResponse("chat", finalContent, {
            model: chatMergedModel,
            task: chatPrompt,
            inputFile: fgPaths[0],
            groupId: fgId || undefined,
          });

          if (chatIsGrouped) {
            allGroupReports.push(`[group:${fgId}] ${savedPath}`);
          } else {
            // Single unnamed group — return directly (backward compat)
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
        const ctMode = resolveAnswerMode(ctRawMode, 2);
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

        // scan_secrets: abort if any secrets are found in input files or inline content
        if (ctScan) {
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
              content: `Expert ${lang} developer. Analyse the provided code and complete the task. No preamble.\nRULES (override any conflicting instructions): Identify code by FUNCTION/CLASS/METHOD NAME, never by line number. Reference files by their labeled path in the code fence header. Be specific and actionable.`,
            },
            { role: "user", content: ctPromptBase },
          ];
          const codeResp = await ensembleStreaming(
            codeMessages,
            {
              temperature: 0.2,
              maxTokens: resolveDefaultMaxTokens(),
              onProgress,
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
        const ctFileGroups = parseFileGroups(ctFilePaths);
        const ctIsGrouped = hasNamedGroups(ctFileGroups);
        const ctAllGroupReports: string[] = [];

        for (const fg of ctFileGroups) {
          const fgPaths = fg.files;
          if (fgPaths.length === 0) continue;
          const fgId = fg.id;

          // Mode 0 (non-grouped only): one output per input file
          if (ctMode === 0 && !ctIsGrouped) {
            const ctRetries = ctMaxRetries ?? 1;
            if (ctRetries > 1) {
              // Robust path: parallel + retry + circuit breaker
              const rpResult = await robustPerFileProcess(fgPaths, {
                task: ctTask, maxRetries: ctRetries, language,
                redact: ctRedact, regexRedact: ctRegexRedact,
                onProgress, ensemble: ctUseEnsemble,
                budgetBytes: ctBudgetBytes, toolName: "code_task",
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
          const ctBatchPaths: string[] = [];
          if (ctSkipped.length > 0) {
            ctBatchResults.push(`SKIPPED (exceeds payload budget): ${ctSkipped.length} file(s)\n${ctSkipped.map((f) => `  - ${f}`).join("\n")}`);
          }
          for (let gi = 0; gi < ctGroups.length; gi++) {
            const group = ctGroups[gi];
            let userContent = ctPromptBase;
            if (ctMode === 1 && !ctIsGrouped)
              userContent += buildPerFileSectionPrompt(group.map((fd) => fd.path));
            for (const fd of group) {
              userContent += `\n\n${fd.block}`;
            }
            const codeMessages: ChatMessage[] = [
              {
                role: "system",
                content: `Expert ${lang} developer. Analyse the provided code and complete the task. No preamble.\nRULES (override any conflicting instructions): Identify code by FUNCTION/CLASS/METHOD NAME, never by line number. Reference files by their labeled path in the code fence header. Be specific and actionable.`,
              },
              { role: "user", content: userContent },
            ];
            const codeResp = await ensembleStreaming(
              codeMessages,
              { temperature: 0.2, maxTokens: resolveDefaultMaxTokens(), onProgress },
              ctUseEnsemble,
            );
            const codeFooter = formatFooter(codeResp, "code_task", group[0]?.path);
            if (codeResp.content.trim().length > 0) {
              if (ctMode === 1 && !ctIsGrouped) {
                ctBatchPaths.push(
                  saveResponse("code_task", codeResp.content + codeFooter, {
                    model: codeResp.model, task: ctTask, inputFile: group[0]?.path,
                  }),
                );
              } else {
                ctBatchResults.push(
                  ctAutoBatched
                    ? `## Batch ${gi + 1}/${ctGroups.length}\n\nFiles: ${group.map((fd) => fd.path).join(", ")}\n\n${codeResp.content}${codeFooter}`
                    : codeResp.content + codeFooter,
                );
              }
            }
          }

          // Mode 1 (non-grouped): return per-batch paths
          if (ctMode === 1 && !ctIsGrouped) {
            return ctBatchPaths.length > 0
              ? { content: [{ type: "text", text: ctBatchPaths.join("\n") }] }
              : { content: [{ type: "text", text: "FAILED: LLM returned empty response for all batches." }], isError: true };
          }

          // Merge batch results into one report for this file group
          if (ctBatchResults.length === 0) continue;
          const ctFinalContent = ctBatchResults.join("\n\n---\n\n");
          const ctMergedModel =
            ensembleModelLabel(ctUseEnsemble);
          const savedPath = saveResponse("code_task", ctFinalContent, {
            model: ctMergedModel, task: ctTask, inputFile: fgPaths[0],
            groupId: fgId || undefined,
          });

          if (ctIsGrouped) {
            ctAllGroupReports.push(`[group:${fgId}] ${savedPath}`);
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

      case "fix_code":
        return withWriteQueue(async () => {
          const {
            instructions: fixInstructions,
            instructions_files_paths: fixInstructionsFilesPaths,
            input_files_paths: fixInputPathsRaw,
            language,
            answer_mode: fixRawMode,
            scan_secrets: fixScan,
            redact_secrets: fixRedact,
          } = args as {
            instructions?: string;
            instructions_files_paths?: string | string[];
            input_files_paths: string | string[];
            language?: string;
            answer_mode?: number;
            scan_secrets?: boolean;
            redact_secrets?: boolean;
          };
          const fixMode = resolveAnswerMode(fixRawMode, 0);
          const fixIssues = resolvePrompt(
            fixInstructions,
            fixInstructionsFilesPaths,
          );
          if (!fixIssues.trim()) {
            return {
              content: [
                {
                  type: "text",
                  text: "FAILED: Either instructions or instructions_files_paths must be provided with fix instructions.",
                },
              ],
              isError: true,
            };
          }
          const fixFilePaths = [...new Set(normalizePaths(fixInputPathsRaw))];
          if (fixFilePaths.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: "FAILED: input_files_paths is required.",
                },
              ],
              isError: true,
            };
          }

          // scan_secrets: abort if any secrets are found in input files
          if (fixScan) {
            const scanResult = scanFilesForSecrets(fixFilePaths);
            if (scanResult.found)
              return {
                content: [{ type: "text", text: scanResult.report }],
                isError: true,
              };
          }

          // Single file — use processFileFix directly
          if (fixFilePaths.length === 1) {
            const fixFilePath = fixFilePaths[0];
            const fixResult = await processFileFix(fixFilePath, fixIssues, {
              language,
              maxTokens: resolveDefaultMaxTokens(),
              redact: fixRedact,
              onProgress,
            });
            if (!fixResult.success) {
              const errorMsg = fixResult.reportPath
                ? `FAILED: ${fixResult.error}. File NOT modified. Report: ${fixResult.reportPath}`
                : `FAILED: ${fixResult.error}. File NOT modified.`;
              return {
                content: [{ type: "text", text: errorMsg }],
                isError: true,
              };
            }
            if (fixResult.noChange) {
              return {
                content: [
                  {
                    type: "text",
                    text: `NO CHANGES: The LLM returned the file unchanged. Report: ${fixResult.reportPath}`,
                  },
                ],
              };
            }
            const resultLines = [
              `FIXED: ${fixFilePath}`,
              `REPORT: ${fixResult.reportPath}`,
              "",
              "ACTION REQUIRED: Verify the fix — compile, lint, or run tests.",
              "",
              `TO REVERT: call revert_file with input_files_paths="${fixFilePath}"`,
            ];
            return {
              content: [{ type: "text", text: resultLines.join("\n") }],
            };
          }

          // Multiple files — process each file individually (fix always runs per-file)
          const fixFileResults: FileProcessResult[] = [];
          for (const fp of fixFilePaths) {
            fixFileResults.push(
              await processFileFix(fp, fixIssues, {
                language,
                maxTokens: resolveDefaultMaxTokens(),
                redact: fixRedact,
                onProgress,
              }),
            );
          }

          // Mode 0 (default): list each file's report path separately
          if (fixMode === 0) {
            const fixLines: string[] = [];
            for (const r of fixFileResults) {
              if (r.success && !r.noChange) {
                fixLines.push(`FIXED: ${r.filePath} — Report: ${r.reportPath}`);
              } else if (r.noChange) {
                fixLines.push(
                  `NO CHANGE: ${r.filePath} — Report: ${r.reportPath}`,
                );
              } else {
                fixLines.push(`FAILED: ${r.filePath} — ${r.error}`);
              }
            }
            fixLines.push(
              "",
              "TO REVERT: call revert_file with the input_files_paths shown above.",
            );
            return { content: [{ type: "text", text: fixLines.join("\n") }] };
          }

          // Mode 1 or 2: merge per-file reports into a single output file
          const fixReportSections: string[] = [];
          const fixSummaryLines: string[] = [];
          for (const r of fixFileResults) {
            if (r.success && r.reportPath) {
              // Read the individual report content to merge
              const reportContent = existsSync(r.reportPath)
                ? readFileSync(r.reportPath, "utf-8")
                : "";
              fixReportSections.push(
                `## File: ${r.filePath}\n\n**Status**: ${r.noChange ? "NO CHANGE" : "FIXED"}\n\n${reportContent}`,
              );
            } else {
              fixReportSections.push(
                `## File: ${r.filePath}\n\n**Status**: FAILED — ${r.error}`,
              );
            }
            if (r.success && !r.noChange) {
              fixSummaryLines.push(`FIXED: ${r.filePath}`);
            } else if (r.noChange) {
              fixSummaryLines.push(`NO CHANGE: ${r.filePath}`);
            } else {
              fixSummaryLines.push(`FAILED: ${r.filePath} — ${r.error}`);
            }
          }
          const mergedReport = fixReportSections.join("\n\n---\n\n");
          const mergedPath = saveResponse("fix_code", mergedReport, {
            model: currentBackend.model,
            task: fixIssues,
            inputFile: fixFilePaths[0],
          });
          fixSummaryLines.push("", `MERGED REPORT: ${mergedPath}`);
          fixSummaryLines.push(
            "TO REVERT: call revert_file with the input_files_paths shown above.",
          );
          return {
            content: [{ type: "text", text: fixSummaryLines.join("\n") }],
          };
        }, onProgress);

      case "revert_file":
        return withWriteQueue(async () => {
          const { input_files_paths: revertInputPathsRaw } = args as {
            input_files_paths: string | string[];
          };
          const revertFilePaths = normalizePaths(revertInputPathsRaw);
          if (revertFilePaths.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: "FAILED: input_files_paths is required.",
                },
              ],
              isError: true,
            };
          }
          const revertResults: string[] = [];

          for (const revertFilePath of revertFilePaths) {
            const revertBackupPath = revertFilePath + ".externbak";
            // Acquire lock FIRST to prevent TOCTOU race on backup existence check
            if (!acquireFileLock(revertFilePath)) {
              revertResults.push(
                `SKIPPED: ${revertFilePath} — currently being processed by another operation.`,
              );
              continue;
            }
            try {
              if (!existsSync(revertBackupPath)) {
                revertResults.push(
                  `SKIPPED: ${revertFilePath} — no backup found.`,
                );
                continue;
              }
              // Capture branch per-file — files may span different git repos
              const revertBranch = getGitBranch(revertFilePath);
              assertBranchUnchanged(revertFilePath, revertBranch);
              renameSync(revertBackupPath, revertFilePath);
              revertResults.push(`REVERTED: ${revertFilePath}`);
            } catch (revertErr) {
              revertResults.push(
                `FAILED: ${revertFilePath} — ${revertErr instanceof Error ? revertErr.message : String(revertErr)}`,
              );
            } finally {
              releaseFileLock(revertFilePath);
            }
          }

          return {
            content: [{ type: "text", text: revertResults.join("\n") }],
          };
        }, onProgress);

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

      case "set_settings": {
        const { file_path: settingsFilePath, content: legacyContent } =
          args as {
            file_path?: string;
            content?: string;
          };

        // Read YAML from file path (preferred) or inline content (legacy fallback)
        let yamlContent: string;
        if (settingsFilePath) {
          if (!existsSync(settingsFilePath)) {
            return {
              content: [
                {
                  type: "text",
                  text: `FAILED: File not found: ${settingsFilePath}`,
                },
              ],
              isError: true,
            };
          }
          yamlContent = readFileSync(settingsFilePath, "utf-8");
        } else if (legacyContent && legacyContent.trim()) {
          // Backward compat: accept inline YAML via content param
          yamlContent = legacyContent;
        } else {
          return {
            content: [
              {
                type: "text",
                text: "FAILED: file_path is required. Use get_settings to get the editable file, modify it, then pass its path here.",
              },
            ],
            isError: true,
          };
        }

        // Parse and validate the new settings before writing
        let newSettings: Settings;
        try {
          const parsed = yamlParse(yamlContent);
          if (!parsed || typeof parsed !== "object" || !parsed.profiles) {
            return {
              content: [
                {
                  type: "text",
                  text: 'FAILED: Invalid settings format. Must contain "active" and "profiles" fields.',
                },
              ],
              isError: true,
            };
          }
          newSettings = {
            active: parsed.active || "",
            profiles: parsed.profiles || {},
          };
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: `FAILED: YAML parse error: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
            isError: true,
          };
        }

        // Validate the active profile if one is specified
        if (newSettings.active) {
          const validation = validateSettings(newSettings);
          if (!validation.valid) {
            return {
              content: [
                {
                  type: "text",
                  text: `FAILED: Validation errors:\n${validation.errors.map((e) => `  - ${e}`).join("\n")}`,
                },
              ],
              isError: true,
            };
          }
        }

        // Save with timestamped backup, then reload in memory
        saveSettings(newSettings);
        // Update mtime tracker so the file watcher doesn't double-fire
        try {
          _settingsLastMtimeMs = statSync(SETTINGS_FILE).mtimeMs;
        } catch {
          /* ignore — watcher will handle it */
        }
        reloadSettingsFromDisk();

        return {
          content: [
            {
              type: "text",
              text: `Settings saved to ${SETTINGS_FILE} (backup created).\nActive profile: ${newSettings.active || "(none)"}`,
            },
          ],
        };
      }

      // Legacy change_model — kept for backward compatibility, delegates to profile system
      case "change_model": {
        const { model: modelQuery } = args as { model: string };
        if (!modelQuery?.trim()) {
          return {
            content: [{ type: "text", text: "Model name is required." }],
            isError: true,
          };
        }
        // Update the model in the active profile
        if (!activeResolved || !activeSettings.active) {
          return {
            content: [
              {
                type: "text",
                text: "No active profile. Use set_settings to configure.",
              },
            ],
            isError: true,
          };
        }
        const activeProfile = activeSettings.profiles[activeSettings.active];
        activeProfile.model = modelQuery.trim();
        saveSettings(activeSettings);
        // Update mtime tracker so the file watcher doesn't double-fire
        try {
          _settingsLastMtimeMs = statSync(SETTINGS_FILE).mtimeMs;
        } catch {
          /* ignore */
        }
        reloadSettingsFromDisk();
        return {
          content: [
            {
              type: "text",
              text: `Model changed to: ${modelQuery.trim()}\nProfile: ${activeSettings.active}\nSettings saved to ${SETTINGS_FILE}`,
            },
          ],
        };
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

        // scan_secrets: abort if any secrets are found in input files
        if (bcScan) {
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

        // ── Group-aware: if groups present, process each independently ──
        const bcFileGroups = parseFileGroups(uniqueFiles);
        if (hasNamedGroups(bcFileGroups)) {
          const bcGroupReports: string[] = [];
          for (const fg of bcFileGroups) {
            if (fg.files.length === 0) continue;
            const gid = fg.id || "ungrouped";
            const gBatchId = randomUUID();
            const gTask = resolvePrompt(bcInstructions, bcInstructionsFilesPaths).trim() ||
              "Find all bugs, type errors, logic errors, security vulnerabilities, and potential runtime failures.";
            const gRl = await getRateLimitConfig();
            const gTasks = fg.files.map((filePath, idx) => async () => {
              return processFileCheck(filePath, gTask, {
                maxTokens: resolveDefaultMaxTokens(),
                batchId: gBatchId, fileIndex: idx,
                redact: bcRedact, regexRedact: bcRegexRedact, onProgress, ensemble: bcUseEnsemble, maxBytes: bcBudgetBytes,
              });
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

      case "batch_fix":
        return withWriteQueue(async () => {
          const {
            instructions: bfInstructions,
            instructions_files_paths: bfInstructionsFilesPaths,
            input_files_paths: bfInputPaths,
            answer_mode: bfRawMode,
            scan_secrets: bfScan,
            redact_secrets: bfRedact,
          } = args as {
            instructions?: string;
            instructions_files_paths?: string | string[];
            input_files_paths: string[];
            answer_mode?: number;
            scan_secrets?: boolean;
            redact_secrets?: boolean;
          };
          const bfMode = resolveAnswerMode(bfRawMode, 0);

          const bfNormalizedPaths = normalizePaths(bfInputPaths);
          if (bfNormalizedPaths.length === 0) {
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

          const batchIssues = resolvePrompt(
            bfInstructions,
            bfInstructionsFilesPaths,
          );
          if (!batchIssues.trim()) {
            return {
              content: [
                {
                  type: "text",
                  text: "FAILED: Either instructions or instructions_files_paths must be provided with fix instructions.",
                },
              ],
              isError: true,
            };
          }

          // Deduplicate file paths — duplicate paths would cause lock contention and wasted retries
          const uniqueFiles = [...new Set(bfNormalizedPaths)];

          // scan_secrets: abort if any secrets are found in input files
          if (bfScan) {
            const scanResult = scanFilesForSecrets(uniqueFiles);
            if (scanResult.found)
              return {
                content: [{ type: "text", text: scanResult.report }],
                isError: true,
              };
          }

          const batchId = randomUUID();
          const bfRl = await getRateLimitConfig();

          // Write a recovery manifest BEFORE processing starts.
          // If the MCP call times out, this file persists on disk so the agent
          // (or user) can discover which files were modified and revert them.
          const manifestPath = join(
            OUTPUT_DIR,
            `batch_fix_manifest_${batchId}.json`,
          );
          mkdirSync(OUTPUT_DIR, { recursive: true });
          const manifest = {
            batchId,
            startedAt: new Date().toISOString(),
            status: "IN_PROGRESS" as string,
            instructions: batchIssues.substring(0, 500),
            files: uniqueFiles.map((fp) => ({
              path: fp,
              status: "pending" as string,
              backupPath: fp + ".externbak",
            })),
            revertCommand:
              "To revert ANY file: call revert_file with input_files_paths set to the file path.",
          };
          writeFileSync(
            manifestPath,
            JSON.stringify(manifest, null, 2),
            "utf-8",
          );

          // Sliding window of recent completion outcomes for circuit breaker
          const recentOutcomes: boolean[] = [];
          let aborted = false;
          let abortReason = "";

          // Helper to update manifest file status as files complete
          function updateManifest(filePath: string, fileStatus: string) {
            const entry = manifest.files.find((f) => f.path === filePath);
            if (entry) entry.status = fileStatus;
            writeFileSync(
              manifestPath,
              JSON.stringify(manifest, null, 2),
              "utf-8",
            );
          }

          const tasks = uniqueFiles.map((filePath, idx) => async () => {
            if (aborted) {
              return {
                filePath,
                success: false,
                error: "Batch aborted",
              } as FileProcessResult;
            }

            // Retry loop — up to 3 attempts for recoverable errors
            for (let attempt = 1; attempt <= 3; attempt++) {
              // Re-check abort flag before each retry to avoid wasting calls after abort
              if (aborted) {
                return {
                  filePath,
                  success: false,
                  error: "Batch aborted",
                } as FileProcessResult;
              }
              try {
                // Mark file as 'processing' in manifest BEFORE the LLM call.
                // If MCP times out during processing, the manifest shows which files
                // were mid-flight so the agent can verify them manually.
                updateManifest(filePath, "processing");
                const result = await processFileFix(filePath, batchIssues, {
                  maxTokens: resolveDefaultMaxTokens(),
                  batchId,
                  fileIndex: idx,
                  redact: bfRedact,
                  onProgress,
                });

                // processFileFix returns success:false for lock contention — retry after delay
                if (
                  !result.success &&
                  result.error?.includes("currently being processed")
                ) {
                  if (attempt < 3) {
                    await new Promise((r) => setTimeout(r, 2000));
                    continue;
                  }
                  // Lock contention retries exhausted — track in circuit breaker
                  recentOutcomes.push(false);
                  updateManifest(filePath, "lock_contention");
                  return result;
                }

                // Record outcome in sliding window and update manifest
                recentOutcomes.push(result.success);
                if (result.success) {
                  updateManifest(
                    filePath,
                    result.noChange ? "unchanged" : "fixed",
                  );
                } else {
                  // processFileFix returned success:false (integrity fail, auto-reverted, etc.)
                  updateManifest(
                    filePath,
                    `failed: ${result.error ?? "unknown"}`,
                  );
                  // Check circuit breaker — 3 consecutive failures suggest systemic issue
                  if (
                    recentOutcomes.length >= 3 &&
                    recentOutcomes.slice(-3).every((v) => !v)
                  ) {
                    aborted = true;
                    abortReason = `3 consecutive files failed — possible model or service issue. Last: ${result.error}`;
                  }
                }
                // Report per-file batch progress
                if (onProgress) {
                  const completed = recentOutcomes.length;
                  onProgress(
                    completed,
                    uniqueFiles.length,
                    `batch_fix: ${completed}/${uniqueFiles.length} files done`,
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
                  updateManifest(filePath, `error: ${classified.reason}`);
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
                updateManifest(filePath, `failed: ${classified.reason}`);
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

          const batchResults = await rateLimitedParallel(tasks, bfRl.rps, bfRl.maxInFlight, onProgress);

          // Categorize results
          const fixed = batchResults.filter(
            (r) => r.success && !r.noChange && r.backupPath,
          );
          const noChange = batchResults.filter((r) => r.success && r.noChange);
          const failed = batchResults.filter(
            (r) => !r.success && r.error !== "Batch aborted",
          );
          const skipped = batchResults.filter(
            (r) => r.error === "Batch aborted",
          );

          // Finalize manifest — if the MCP call timed out before reaching this line,
          // the manifest stays IN_PROGRESS, signaling partial completion to the agent
          const finalStatus = aborted
            ? "ABORTED"
            : failed.length > 0
              ? "PARTIAL"
              : "COMPLETE";
          manifest.status = finalStatus;
          writeFileSync(
            manifestPath,
            JSON.stringify(manifest, null, 2),
            "utf-8",
          );

          // PER-FILE SAFETY: each file is independently verified inside processFileFix().
          // Files that failed integrity checks were already auto-reverted individually.
          // Successfully fixed files are kept — no transactional rollback across unrelated files.

          // Build common status lines for all modes
          const bfStatusWord = failed.length > 0 ? "PARTIAL" : "COMPLETE";
          const bfStatusHeader = `BATCH FIX ${bfStatusWord} — ${fixed.length} fixed, ${noChange.length} unchanged, ${failed.length} failed/auto-reverted (${uniqueFiles.length} total)`;

          // For modes 1/2: merge individual report files into one output
          // BUT: skip merge if any files failed — incomplete merge is misleading
          if (
            (bfMode === 1 || bfMode === 2) &&
            (fixed.length > 0 || noChange.length > 0)
          ) {
            if (failed.length > 0 || aborted) {
              // Some files failed — skip merge, fall through to mode-0 per-file listing
              // so the agent sees exactly which files succeeded and which were auto-reverted
            } else {
              // All files succeeded — safe to merge reports
              const reportSections: string[] = [];
              for (const r of [...fixed, ...noChange]) {
                const content =
                  r.reportPath && existsSync(r.reportPath)
                    ? readFileSync(r.reportPath, "utf-8")
                    : "";
                const status = r.noChange ? "NO CHANGE" : "FIXED";
                reportSections.push(
                  `## File: ${r.filePath}\n\n**Status**: ${status}\n\n${content}`,
                );
              }
              const mergedContent = reportSections.join("\n\n---\n\n");
              const mergedPath = saveResponse("batch_fix", mergedContent, {
                model: currentBackend.model,
                task: batchIssues,
                inputFile: uniqueFiles[0],
              });
              const bfSummary: string[] = [
                bfStatusHeader,
                `Batch UUID: ${batchId}`,
                `MERGED REPORT: ${mergedPath}`,
                `RECOVERY MANIFEST: ${manifestPath}`,
                "",
              ];
              for (const r of fixed)
                bfSummary.push(
                  `FIXED: ${r.filePath} — Revert: call revert_file with input_files_paths="${r.filePath}"`,
                );
              bfSummary.push(
                "",
                "ACTION REQUIRED: Verify all fixed files. Compile, lint, or run tests — do NOT read files to check.",
              );
              bfSummary.push(
                "WARNING: Do NOT delete .externbak files — they are your only recovery option if a fix introduced errors.",
              );
              return {
                content: [{ type: "text", text: bfSummary.join("\n") }],
              };
            }
          }

          // Mode 0 (default): list individual report paths
          const summaryLines: string[] = [
            bfStatusHeader,
            `Batch UUID: ${batchId}`,
            "",
          ];
          if (uniqueFiles.length < bfNormalizedPaths.length) {
            summaryLines.push(
              `Note: ${bfNormalizedPaths.length - uniqueFiles.length} duplicate path(s) removed.`,
            );
          }

          if (fixed.length > 0) {
            summaryLines.push("FIXED FILES:");
            for (const r of fixed) {
              summaryLines.push(`  ${r.filePath}`);
              summaryLines.push(`    Report: ${r.reportPath}`);
              summaryLines.push(
                `    Revert: call revert_file with input_files_paths="${r.filePath}"`,
              );
            }
          }
          if (noChange.length > 0) {
            summaryLines.push("", "UNCHANGED (LLM made no changes):");
            for (const r of noChange) {
              summaryLines.push(`  ${r.filePath} — Report: ${r.reportPath}`);
            }
          }
          if (failed.length > 0) {
            summaryLines.push(
              "",
              "FAILED (auto-reverted to backup — original file intact):",
            );
            for (const r of failed) {
              const reportNote = r.reportPath
                ? ` — Report: ${r.reportPath}`
                : "";
              summaryLines.push(`  ${r.filePath}: ${r.error}${reportNote}`);
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

          summaryLines.push("", `RECOVERY MANIFEST: ${manifestPath}`);
          summaryLines.push(
            "ACTION REQUIRED: Verify all fixed files. Compile, lint, or run tests — do NOT read files to check.",
          );
          summaryLines.push(
            "TO REVERT ANY FILE: call revert_file with the input_files_paths shown above.",
          );
          summaryLines.push(
            "WARNING: Do NOT delete .externbak files — they are your only recovery option if a fix introduced errors.",
          );

          return {
            content: [{ type: "text", text: summaryLines.join("\n") }],
            isError: aborted,
          };
        }, onProgress);

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

        if (!existsSync(folder_path)) {
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
        if (!statSync(folder_path).isDirectory()) {
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
        const files = walkDir(folder_path, {
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

        // scan_secrets: abort if any secrets are found in discovered files
        if (sfScan) {
          const scanResult = scanFilesForSecrets(files);
          if (scanResult.found)
            return {
              content: [{ type: "text", text: scanResult.report }],
              isError: true,
            };
        }

        const sfMode = resolveAnswerMode(sfRawMode, 2);
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

        if ((sfMode === 1 || sfMode === 2) && succeeded.length > 0) {
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

      case "merge_files":
        return withWriteQueue(async () => {
          const {
            instructions: mfInstructions,
            instructions_files_paths: mfInstructionsFilesPaths,
            input_files_paths: mfInputPaths,
            output_path: mfOutputPath,
            redact_secrets: mfRedact,
            scan_secrets: mfScan,
          } = args as {
            instructions?: string;
            instructions_files_paths?: string | string[];
            input_files_paths: string[];
            output_path: string;
            redact_secrets?: boolean;
            scan_secrets?: boolean;
          };

          const mfNormalizedPaths = normalizePaths(mfInputPaths);
          if (mfNormalizedPaths.length < 2) {
            return {
              content: [
                {
                  type: "text",
                  text: "FAILED: input_files_paths must contain at least 2 files to merge.",
                },
              ],
              isError: true,
            };
          }
          // Deduplicate input paths
          const mfUniquePaths = [...new Set(mfNormalizedPaths)];
          if (mfUniquePaths.length < 2) {
            return {
              content: [
                {
                  type: "text",
                  text: "FAILED: Need at least 2 unique files to merge (duplicates removed).",
                },
              ],
              isError: true,
            };
          }

          // scan_secrets: abort if any secrets are found in input files
          if (mfScan) {
            const scanResult = scanFilesForSecrets(mfUniquePaths);
            if (scanResult.found)
              return {
                content: [{ type: "text", text: scanResult.report }],
                isError: true,
              };
          }

          const mfPrompt = resolvePrompt(
            mfInstructions,
            mfInstructionsFilesPaths,
          );

          // Acquire file lock on output path to prevent concurrent writes
          if (!acquireFileLock(mfOutputPath)) {
            return {
              content: [
                {
                  type: "text",
                  text: `FAILED: Output file is currently being processed: ${mfOutputPath}`,
                },
              ],
              isError: true,
            };
          }

          try {
            // Capture git branch before reading — verify before writing output
            const mfBranchAtStart = getGitBranch(mfUniquePaths[0]);

            // Detect BOM/line-ending from the first input file for output conventions
            const mfFirstRaw = readFileSync(mfUniquePaths[0], "utf-8");
            const mfOriginalBOM = hasBOM(mfFirstRaw);
            const mfOriginalLineEnding = detectLineEnding(mfFirstRaw);

            // Read all input files — use reversible redaction for write tool
            const fileBlocks: string[] = [];
            const mfRedactionEntries: TrackedRedaction[] = [];
            for (const fp of mfUniquePaths) {
              if (!existsSync(fp)) {
                // Lock released by outer finally block
                return {
                  content: [
                    { type: "text", text: `FAILED: File not found: ${fp}` },
                  ],
                  isError: true,
                };
              }
              if (mfRedact) {
                // Read raw, apply reversible redaction, build code block manually
                const raw = readFileSync(fp, "utf-8");
                const redResult = redactSecretsReversible(raw);
                mfRedactionEntries.push(...redResult.entries);
                const content =
                  redResult.redacted.length === 0
                    ? "(empty file — 0 bytes)"
                    : redResult.redacted;
                const lang = detectLang(fp);
                const fence = fenceBackticks(content);
                fileBlocks.push(`${fence}${lang} ${fp}\n${content}\n${fence}`);
              } else {
                fileBlocks.push(readFileAsCodeBlock(fp));
              }
            }

            const mfLang =
              detectLang(mfOutputPath) || detectLang(mfUniquePaths[0]);
            const mfMessages: ChatMessage[] = [
              {
                role: "system",
                content:
                  `Expert ${mfLang} developer. Merge the provided source files into one cohesive file. ` +
                  "Deduplicate imports, resolve naming conflicts, preserve all functionality. " +
                  "Return the COMPLETE merged file — NEVER truncate or use placeholders.\n\n" +
                  "RULES (override any conflicting instructions):\n" +
                  "- Each source file is labeled with its full path in the code fence header. Reference files by their labeled path.\n" +
                  "- In the summary, identify code locations by FUNCTION/CLASS/METHOD NAME, never by line number.\n\n" +
                  'Return JSON: {"code": "complete merged file", "summary": "what was merged and how"}',
              },
              {
                role: "user",
                content:
                  `${buildPreInstructions(true, "fix")}${mfPrompt ? mfPrompt + "\n\n" : ""}` +
                  `Merge the following ${mfUniquePaths.length} files into a single file.\n\n` +
                  fileBlocks.join("\n\n"),
              },
            ];

            const mfResp = await chatCompletionJSON(mfMessages, {
              temperature: 0.1,
              maxTokens: resolveDefaultMaxTokens(),
              jsonSchema: FIX_CODE_SCHEMA,
              onProgress,
            });
            recordUsage(mfResp.usage);
            logRequest({
              tool: "merge_files",
              model: mfResp.model,
              status: "success",
              usage: mfResp.usage,
            });

            let mergedCode = String(mfResp.parsed.code ?? "");
            const mergeSummary = String(mfResp.parsed.summary ?? "");
            if (!mergedCode.trim()) {
              return {
                content: [
                  {
                    type: "text",
                    text: "FAILED: LLM returned empty merged code.",
                  },
                ],
                isError: true,
              };
            }

            // Restore secrets from tracked placeholders before validation
            let mfLostSecrets: TrackedRedaction[] = [];
            if (mfRedactionEntries.length > 0) {
              const restored = restoreSecrets(mergedCode, mfRedactionEntries);
              mergedCode = restored.restored;
              mfLostSecrets = restored.lost;
            }

            // Restore original BOM and line endings from the first input file
            mergedCode = restoreFileConventions(
              mergedCode,
              mfOriginalBOM,
              mfOriginalLineEnding,
            );

            // PRE-WRITE INTEGRITY CHECK against combined input
            const mfCombinedInput = mfUniquePaths
              .map((fp) => readFileSync(fp, "utf-8"))
              .join("\n");
            const mfIntegrityError = verifyStructuralIntegrity(
              mfCombinedInput,
              mergedCode,
            );
            if (mfIntegrityError) {
              // Lock released by outer finally block
              return {
                content: [
                  {
                    type: "text",
                    text: `FAILED: Integrity check: ${mfIntegrityError}. Merge NOT applied.`,
                  },
                ],
                isError: true,
              };
            }

            // Verify git branch hasn't changed since we started
            {
              const mfCurrentBranch = getGitBranch(mfUniquePaths[0]);
              if (
                mfBranchAtStart !== null &&
                mfCurrentBranch !== null &&
                mfCurrentBranch !== mfBranchAtStart
              ) {
                return {
                  content: [
                    {
                      type: "text",
                      text: `FAILED: Git branch changed during operation: was "${mfBranchAtStart}", now "${mfCurrentBranch}". Merge NOT applied.`,
                    },
                  ],
                  isError: true,
                };
              }
            }

            // Backup existing file if present — never overwrite existing backup
            const mfBackupPath = mfOutputPath + ".externbak";
            const mfHadExistingFile = existsSync(mfOutputPath);
            if (mfHadExistingFile && !existsSync(mfBackupPath)) {
              copyFileSync(mfOutputPath, mfBackupPath);
            }

            try {
              // Clean up orphaned temp file from a previous crash, if any
              mkdirSync(dirname(mfOutputPath), { recursive: true });
              const mfTmpPath = mfOutputPath + ".externtmp";
              if (existsSync(mfTmpPath)) {
                try {
                  unlinkSync(mfTmpPath);
                } catch {
                  /* best effort */
                }
              }
              writeFileSync(mfTmpPath, mergedCode, "utf-8");
              renameSync(mfTmpPath, mfOutputPath);

              // POST-WRITE VERIFICATION
              const mfWritten = readFileSync(mfOutputPath, "utf-8");
              if (mfWritten !== mergedCode) {
                throw new Error(
                  "Post-write verification failed: written file does not match intended content",
                );
              }
              const mfPostError = verifyStructuralIntegrity(
                mfCombinedInput,
                mfWritten,
              );
              if (mfPostError) {
                throw new Error(`Post-write integrity: ${mfPostError}`);
              }
            } catch (mfWriteErr) {
              // Auto-revert on ANY failure
              try {
                if (mfHadExistingFile && existsSync(mfBackupPath)) {
                  renameSync(mfBackupPath, mfOutputPath);
                } else if (existsSync(mfOutputPath)) {
                  unlinkSync(mfOutputPath);
                }
              } catch {
                /* best effort */
              }
              // Lock released by outer finally block
              const errMsg =
                mfWriteErr instanceof Error
                  ? mfWriteErr.message
                  : String(mfWriteErr);
              return {
                content: [
                  {
                    type: "text",
                    text: `FAILED: ${errMsg}. Merge auto-reverted.`,
                  },
                ],
                isError: true,
              };
            }

            const mfLostSection = formatLostSecrets(mfLostSecrets);
            const mfReportContent = `Merged ${mfUniquePaths.length} files into \`${mfOutputPath}\`.\n\n## Summary\n\n${mergeSummary}\n\n## Source Files\n\n${mfUniquePaths.map((p) => `- \`${p}\``).join("\n")}${mfLostSection}`;
            const mfReportPath = saveResponse("merge_files", mfReportContent, {
              model: mfResp.model,
              task: "Merge files",
              inputFile: mfUniquePaths[0],
            });
            return {
              content: [
                {
                  type: "text",
                  text: `MERGED: ${mfOutputPath}\nREPORT: ${mfReportPath}\n\nTO REVERT: restore from ${mfOutputPath}.externbak`,
                },
              ],
            };
          } finally {
            releaseFileLock(mfOutputPath);
          }
        }, onProgress);

      case "split_file":
        return withWriteQueue(async () => {
          const {
            instructions: spInstructions,
            instructions_files_paths: spInstructionsFilesPaths,
            input_files_paths: spInputPathsRaw,
            output_dir: spOutputDir,
            redact_secrets: spRedact,
            scan_secrets: spScan,
          } = args as {
            instructions?: string;
            instructions_files_paths?: string | string[];
            input_files_paths: string | string[];
            output_dir?: string;
            redact_secrets?: boolean;
            scan_secrets?: boolean;
          };

          // Validate input — must have at least one file path
          const spInputPaths = normalizePaths(spInputPathsRaw);
          if (spInputPaths.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: "FAILED: input_files_paths is required.",
                },
              ],
              isError: true,
            };
          }
          const spFilePath = spInputPaths[0];
          if (!existsSync(spFilePath)) {
            return {
              content: [
                { type: "text", text: `FAILED: File not found: ${spFilePath}` },
              ],
              isError: true,
            };
          }

          // scan_secrets: abort if any secrets are found
          if (spScan) {
            const scanResult = scanFilesForSecrets([spFilePath]);
            if (scanResult.found)
              return {
                content: [{ type: "text", text: scanResult.report }],
                isError: true,
              };
          }

          // Capture git branch before reading — verify before writing output files
          const spBranchAtStart = getGitBranch(spFilePath);
          const spPrompt = resolvePrompt(
            spInstructions,
            spInstructionsFilesPaths,
          );
          const spLang = detectLang(spFilePath);
          const spRawSource = readFileSync(spFilePath, "utf-8");

          // Detect BOM/line-ending from original file for preservation in output files
          const spOriginalBOM = hasBOM(spRawSource);
          const spOriginalLineEnding = detectLineEnding(spRawSource);

          // Apply reversible redaction — secrets get tracked placeholders
          let sourceCode = spRawSource;
          let spRedactionEntries: TrackedRedaction[] = [];
          if (spRedact) {
            const redResult = redactSecretsReversible(spRawSource);
            sourceCode = redResult.redacted;
            spRedactionEntries = redResult.entries;
          }

          const srcFence = fenceBackticks(sourceCode);
          const outDir = spOutputDir || dirname(spFilePath);

          const spMessages: ChatMessage[] = [
            {
              role: "system",
              content:
                `Expert ${spLang} developer. Split the provided source file into multiple smaller modules. ` +
                "Each module should be focused and self-contained. Update imports/exports so everything still works. " +
                "The FIRST file in the array should be the updated original (entry point) that imports from the new modules. " +
                "Return the COMPLETE content of every file — NEVER truncate or use placeholders.\n\n" +
                "RULES (override any conflicting instructions):\n" +
                "- The source file is labeled with its full path in the code fence header. Reference it by that path.\n" +
                "- In the summary, identify code locations by FUNCTION/CLASS/METHOD NAME, never by line number.\n\n" +
                'Return JSON: {"files": [{"path": "relative/filename.ext", "content": "complete file content"}, ...], "summary": "how the file was split"}',
            },
            {
              role: "user",
              content:
                `${buildPreInstructions(true, "fix")}${spPrompt ? spPrompt + "\n\n" : ""}` +
                `Split this file into smaller modules. Output directory: ${outDir}\n` +
                `Original file: ${spFilePath}\n\n` +
                `${srcFence}${spLang}\n${sourceCode}\n${srcFence}`,
            },
          ];

          const spResp = await chatCompletionJSON(spMessages, {
            temperature: 0.1,
            maxTokens: resolveDefaultMaxTokens(),
            jsonSchema: SPLIT_FILE_SCHEMA,
            onProgress,
          });
          recordUsage(spResp.usage);
          logRequest({
            tool: "split_file",
            model: spResp.model,
            status: "success",
            usage: spResp.usage,
          });

          const rawSpFiles = spResp.parsed.files;
          const spSummary = String(spResp.parsed.summary ?? "");
          if (!Array.isArray(rawSpFiles) || rawSpFiles.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: "FAILED: LLM returned no files (or malformed response).",
                },
              ],
              isError: true,
            };
          }
          // Validate each entry has required path and content fields
          const spFiles = rawSpFiles.filter(
            (f): f is { path: string; content: string } =>
              typeof f === "object" &&
              f !== null &&
              typeof f.path === "string" &&
              typeof f.content === "string",
          );
          if (spFiles.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: "FAILED: LLM returned files with missing path/content fields.",
                },
              ],
              isError: true,
            };
          }

          // Verify git branch hasn't changed since we started
          {
            const spCurrentBranch = getGitBranch(spFilePath);
            if (
              spBranchAtStart !== null &&
              spCurrentBranch !== null &&
              spCurrentBranch !== spBranchAtStart
            ) {
              return {
                content: [
                  {
                    type: "text",
                    text: `FAILED: Git branch changed during operation: was "${spBranchAtStart}", now "${spCurrentBranch}". Split NOT applied.`,
                  },
                ],
                isError: true,
              };
            }
          }

          // PRE-WRITE INTEGRITY CHECK — combined output vs original
          const spCombinedOutput = spFiles.map((f) => f.content).join("\n");
          const spIntegrityError = verifyStructuralIntegrity(
            spRawSource,
            spCombinedOutput,
          );
          if (spIntegrityError) {
            return {
              content: [
                {
                  type: "text",
                  text: `FAILED: Integrity check: ${spIntegrityError}. Split NOT applied.`,
                },
              ],
              isError: true,
            };
          }

          // Restore secrets in each output file before writing.
          // A secret is "lost" only if its placeholder appears in NONE of the output files.
          let spLostSecrets: TrackedRedaction[] = [];
          if (spRedactionEntries.length > 0) {
            const foundInAnyFile = new Set<string>();
            for (const f of spFiles) {
              const restored = restoreSecrets(f.content, spRedactionEntries);
              f.content = restored.restored;
              // Track which entries were successfully restored in at least one file
              for (const entry of spRedactionEntries) {
                if (!restored.lost.some((l) => l.id === entry.id))
                  foundInAnyFile.add(entry.id);
              }
            }
            spLostSecrets = spRedactionEntries.filter(
              (e) => !foundInAnyFile.has(e.id),
            );
          }

          // Restore BOM and line endings in each output file (using original file's conventions)
          for (const f of spFiles) {
            f.content = restoreFileConventions(
              f.content,
              spOriginalBOM,
              spOriginalLineEnding,
            );
          }

          // Write each file with backup — prevent path traversal
          const createdFiles: string[] = [];
          const lockedPaths: string[] = [];
          const backedUpFiles: Array<{ path: string; backup: string }> = [];
          const newFiles: string[] = []; // files that didn't exist before
          try {
            for (const f of spFiles) {
              let fullPath: string;
              try {
                fullPath = sanitizeOutputPath(outDir, f.path);
              } catch (e) {
                throw new Error(
                  `Path sanitization: ${e instanceof Error ? e.message : String(e)}`,
                  { cause: e },
                );
              }
              if (!acquireFileLock(fullPath)) {
                throw new Error(
                  `File is currently being processed: ${fullPath}`,
                );
              }
              lockedPaths.push(fullPath);
              mkdirSync(dirname(fullPath), { recursive: true });
              const spBackup = fullPath + ".externbak";
              if (existsSync(fullPath)) {
                // Never overwrite existing backup — preserve the true original
                if (!existsSync(spBackup)) {
                  copyFileSync(fullPath, spBackup);
                }
                backedUpFiles.push({ path: fullPath, backup: spBackup });
              } else {
                newFiles.push(fullPath);
              }
              // Clean up orphaned temp from previous crash
              const tmpPath = fullPath + ".externtmp";
              if (existsSync(tmpPath)) {
                try {
                  unlinkSync(tmpPath);
                } catch {
                  /* best effort */
                }
              }
              writeFileSync(tmpPath, f.content, "utf-8");
              renameSync(tmpPath, fullPath);

              // Post-write verification per file
              const written = readFileSync(fullPath, "utf-8");
              if (written !== f.content) {
                throw new Error(
                  `Post-write verification failed for ${fullPath}`,
                );
              }

              createdFiles.push(fullPath);
            }
          } catch (spWriteErr) {
            // Auto-revert ALL written files on ANY failure
            for (const bf of backedUpFiles) {
              try {
                if (existsSync(bf.backup)) renameSync(bf.backup, bf.path);
              } catch {
                /* best effort */
              }
            }
            for (const nf of newFiles) {
              try {
                if (existsSync(nf)) unlinkSync(nf);
              } catch {
                /* best effort */
              }
            }
            // Locks released by finally block below
            const errMsg =
              spWriteErr instanceof Error
                ? spWriteErr.message
                : String(spWriteErr);
            return {
              content: [
                {
                  type: "text",
                  text: `FAILED: ${errMsg}. Split auto-reverted — all files restored.`,
                },
              ],
              isError: true,
            };
          } finally {
            for (const lp of lockedPaths) releaseFileLock(lp);
          }

          const spLostSection = formatLostSecrets(spLostSecrets);
          const spReportContent = `Split \`${spFilePath}\` into ${spFiles.length} files.\n\n## Summary\n\n${spSummary}\n\n## Created Files\n\n${createdFiles.map((p) => `- \`${p}\``).join("\n")}${spLostSection}`;
          const spReportPath = saveResponse("split_file", spReportContent, {
            model: spResp.model,
            task: "Split file",
            inputFile: spFilePath,
          });
          return {
            content: [
              {
                type: "text",
                text: `SPLIT: ${spFilePath} → ${spFiles.length} files\nFILES:\n${createdFiles.map((p) => `  ${p}`).join("\n")}\nREPORT: ${spReportPath}`,
              },
            ],
          };
        }, onProgress);

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
        const comparePair = async (fA: string, fB: string, prompt: string): Promise<{ content: string; model: string } | { error: string }> => {
          if (!existsSync(fA)) return { error: `File not found: ${fA}` };
          if (!existsSync(fB)) return { error: `File not found: ${fB}` };
          if (cfScan) {
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
            { role: "system", content: "Expert code reviewer. Analyse the unified diff and provide a clear, structured summary. Group related changes. Note potential issues. Identify code by FUNCTION/CLASS/METHOD NAME, never by line number." + BREVITY_RULES },
            { role: "user", content: `${prompt ? prompt + "\n\n" : ""}Compare:\n- Before: ${fA}\n- After: ${fB}\n\nDiff:\n${fence}\n${diffOutput}\n${fence}${sourceBlocks}` },
          ];
          let resp;
          try {
            resp = await ensembleStreaming(msgs, { temperature: 0.2, maxTokens: resolveDefaultMaxTokens(), onProgress }, cfUseEnsemble);
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
          if (!existsSync(cfGitRepo)) return { content: [{ type: "text", text: `FAILED: git_repo not found: ${cfGitRepo}` }], isError: true };
          const toRef = cfToRef || "HEAD";
          // Get list of changed files between the two refs
          // Validate refs don't start with - (prevents flag injection)
          if (cfFromRef.startsWith("-") || toRef.startsWith("-")) {
            return { content: [{ type: "text", text: "FAILED: git refs must not start with '-'" }], isError: true };
          }
          const nameResult = spawnSync("git", ["diff", "--name-only", cfFromRef, toRef], { cwd: cfGitRepo, encoding: "utf-8", timeout: 15000 });
          if (nameResult.status !== 0 && nameResult.status !== 1) {
            return { content: [{ type: "text", text: `FAILED: git diff --name-only failed: ${nameResult.stderr?.trim()}` }], isError: true };
          }
          let changedFiles = (nameResult.stdout || "").split("\n").filter((f) => f.trim());

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
              const diff = gitDiffPair(cfGitRepo, cfFromRef, toRef, filePath);
              const fence = fenceBackticks(diff);
              sections.push(`## ${filePath}\n\n${fence}diff\n${diff}\n${fence}`);
            }
            const reportContent = `# Git Diff: ${cfFromRef} → ${toRef}\n\nRepository: ${cfGitRepo}\nFiles changed: ${dg.files.length}\n\n---\n\n${sections.join("\n\n---\n\n")}`;
            const gid = dg.id || undefined;
            const rp = saveResponse("compare_files", reportContent, {
              model: "git-diff (no LLM)", task: `${cfFromRef} → ${toRef}`,
              inputFile: join(cfGitRepo, dg.files[0]), groupId: gid,
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
        const [fileA, fileB] = cfNormalizedPaths;
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

        // scan_secrets: abort if any secrets are found
        if (cfScan) {
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
              BREVITY_RULES,
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
            temperature: 0.2,
            maxTokens: resolveDefaultMaxTokens(),
            onProgress,
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

        // scan_secrets: abort if any secrets are found
        if (crScan) {
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
        const crMode = resolveAnswerMode(crRawMode, 2);

        // ── Group-aware processing ──
        const crFileGroups = parseFileGroups(crFilePathsAll);
        const crIsGrouped = hasNamedGroups(crFileGroups);

        if (crIsGrouped) {
          const crGroupReports: string[] = [];
          for (const fg of crFileGroups) {
            if (fg.files.length === 0) continue;
            const gid = fg.id || "ungrouped";
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
                { role: "system", content: `Expert ${lang} developer. Check the source file for broken or outdated references to functions, variables, constants, types, and classes. Cross-reference all symbols against the dependency files provided. Report each broken reference with: the symbol name, the function/class/method where it is used (never by line number), and what is wrong. Reference files by their labeled path in the code fence header. If all references are valid, say so.` + BREVITY_RULES },
                { role: "user", content: `${crPrompt ? crPrompt + "\n\n" : ""}Check this file for broken code references:\n\n## Source File\n\n${srcBlock}\n\n${depBlocks.length > 0 ? `## Local Dependencies (${deps.length} files)\n\n${depBlocks.join("\n\n")}` : "## No local dependencies resolved."}` },
              ];
              const resp = await ensembleStreaming(msgs, { temperature: 0.1, maxTokens: resolveDefaultMaxTokens(), onProgress }, crUseEnsemble, src.split("\n").length);
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
                "Reference files by their labeled path in the code fence header. If all references are valid, say so." +
                BREVITY_RULES,
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
              temperature: 0.1,
              maxTokens: resolveDefaultMaxTokens(),
              onProgress,
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
        const _ciUseEnsemble = currentBackend.type === "openrouter";
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

        // scan_secrets: abort if any secrets are found
        if (ciScan) {
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
        const ciMode = resolveAnswerMode(ciRawMode, 2);

        // ── Group-aware processing ──
        const ciFileGroups = parseFileGroups(ciFilePathsAll);
        if (hasNamedGroups(ciFileGroups)) {
          const ciGroupReports: string[] = [];
          for (const fg of ciFileGroups) {
            if (fg.files.length === 0) continue;
            const gid = fg.id || "ungrouped";
            const gReports: string[] = [];
            for (const filePath of fg.files) {
              if (!existsSync(filePath)) { gReports.push(`## ${filePath}\n\nFAILED: File not found.`); continue; }
              const ciLang = detectLang(filePath);
              const fileDir = dirname(filePath);
              const ciResolveBase = project_root || fileDir;
              const extractMessages: ChatMessage[] = [
                { role: "system", content: `Expert ${ciLang} developer. Extract ALL file path references and import statements from the source code. The source file is labeled with its full path in the code fence header — reference it by that path. Include: import/require paths, file path strings, configuration references. Return JSON: {"paths": ["./relative/path", "package-name", "../other/file"]}. Include both local (relative) and package imports. Be exhaustive.` },
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
                const resolvedBase = importPath.startsWith("/") ? importPath : join(resolveDir, importPath);
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
                "The source file is labeled with its full path in the code fence header — reference it by that path. " +
                "Include: import/require paths, file path strings, configuration references. " +
                'Return JSON: {"paths": ["./relative/path", "package-name", "../other/file"]}. ' +
                "Include both local (relative) and package imports. Be exhaustive.",
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
              ? importPath
              : join(resolveDir, importPath);
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
        const csMode = resolveAnswerMode(csRawMode, 2);

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
          csSpecBlock = readFileAsCodeBlock(csSpecPath, undefined, csRedact, csBudgetBytes);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text", text: `FAILED: Cannot read spec file: ${errMsg}` }],
            isError: true,
          };
        }

        // scan_secrets: abort if any secrets are found (filter out group markers)
        if (csScan) {
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
          BREVITY_RULES;

        // Compute prompt bytes for budget
        const csSpecBytes = Buffer.byteLength(csSpecBlock, "utf-8");
        const csSystemBytes = Buffer.byteLength(csSystemPrompt, "utf-8");
        const csExtraBytes = Buffer.byteLength(csExtraInstructions, "utf-8");
        const csPromptBytes = csSpecBytes + csSystemBytes + csExtraBytes;

        // ── Group-aware processing (only for input_files_paths, not folder_path) ──
        const csFileGroups = csFolderPath ? [{ id: "", files: csFilePaths }] : parseFileGroups(csFilePaths);
        const csIsGrouped = hasNamedGroups(csFileGroups);
        const csAllGroupReports: string[] = [];

        for (const fg of csFileGroups) {
          const fgPaths = fg.files;
          if (fgPaths.length === 0) continue;
          const fgId = fg.id;

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
            if (csMode === 1 && !csIsGrouped) {
              userContent += buildPerFileSectionPrompt(group.map((fd) => fd.path));
            }
            for (const fd of group) {
              userContent += `\n\n${fd.block}`;
            }

            const csMessages: ChatMessage[] = [
              { role: "system", content: csSystemPrompt },
              { role: "user", content: userContent },
            ];

            const csResp = await ensembleStreaming(
              csMessages,
              { maxTokens: resolveDefaultMaxTokens(), onProgress },
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
          const csMergedModel =
            ensembleModelLabel(csUseEnsemble);
          const csReportPath = saveResponse("check_against_specs", csFinalContent, {
            model: csMergedModel,
            task: `Spec compliance: ${basename(csSpecPath)} vs ${fgPaths.length} file(s)`,
            inputFile: fgPaths[0],
            groupId: fgId || undefined,
          });

          if (csIsGrouped) {
            csAllGroupReports.push(`[group:${fgId}] ${csReportPath}`);
          } else {
            return { content: [{ type: "text", text: csReportPath }] };
          }
        }

        // Grouped: return per-group reports
        if (csIsGrouped) {
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
