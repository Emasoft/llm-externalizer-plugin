/**
 * scan-pipeline.ts — pure file-reading / grouping / scanning helpers
 * extracted from index.ts so the search_existing_implementations pipeline
 * (and other tools) can import them without pulling in index.ts's top-level
 * main() side effects.
 *
 * These declarations are STATELESS: they do not read getCurrentBackend() or
 * openRouterModelCache. The one stateful exception — resolveDefaultMaxTokens —
 * intentionally stays in index.ts.
 */

import {
  readFileSync,
  existsSync,
  statSync,
  lstatSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { extname, join, basename, dirname, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

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
export const SHEBANG_TO_LANG: Record<string, string> = {
  python: "python", python3: "python", node: "javascript",
  bash: "bash", sh: "bash", zsh: "zsh", ruby: "ruby",
  perl: "perl", php: "php", lua: "lua",
};

export function detectLang(filePath: string): string {
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
export function fenceBackticks(content: string): string {
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

export function assertFileExists(filePath: string): void {
  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
}

// ── Input path security ────────────────────────────────────────────
// C1: Prevent path traversal — reject paths outside process.cwd()
// H2: Reject symlinks — prevent reading arbitrary files via symlink attacks

export function sanitizeInputPath(filePath: string): string {
  const resolved = resolve(filePath);
  // Canonicalise each whitelist root via realpathSync so /tmp -> /private/tmp
  // on macOS is collapsed to a single comparable form. The previous
  // implementation matched against the raw symlink path AND its target
  // separately, which let an attacker craft `/tmp/../private/tmp/...` to
  // skip the resolved-prefix check on the macOS realpath form.
  const realpathSafe = (p: string): string => {
    try { return realpathSync(p); } catch { return p; }
  };
  const cwdReal = realpathSafe(resolve(process.cwd()));
  const homeReal = realpathSafe(
    resolve(process.env.HOME || process.env.USERPROFILE || homedir()),
  );
  const tmpReal = realpathSafe(resolve("/tmp"));
  // Canonicalise the candidate path BEFORE comparing — if the file exists
  // and is a symlink we want the link target's identity to be checked. The
  // leaf-symlink rejection below still applies, so this is defense in depth.
  const resolvedReal = (() => {
    try { return realpathSync(resolved); } catch { return resolved; }
  })();
  // Cross-platform sep handling — the previous version concatenated a
  // forward-slash separator unconditionally, which made every path on
  // Windows fail the prefix check (cwd uses `\` there).
  const isUnder = (parent: string, child: string): boolean =>
    child === parent || child.startsWith(parent + sep);
  if (
    !isUnder(cwdReal, resolvedReal) &&
    !isUnder(homeReal, resolvedReal) &&
    !isUnder(tmpReal, resolvedReal)
  ) {
    throw new Error(
      `Path traversal blocked: ${filePath} resolves outside allowed directories`,
    );
  }
  // Reject symlinks (follow=false check) — keep this even after the realpath
  // collapse above, so a symlink whose target is in-bounds is still refused
  // when its leaf identity is a symlink (defense in depth).
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
export const DEFAULT_MAX_PAYLOAD_BYTES = 400 * 1024; // 400 KB

export function readFileAsCodeBlock(
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

export const BINARY_EXTENSIONS = new Set([
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

export function isBinaryExtension(filePath: string): boolean {
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
    // Common env-var-style secret names. Extended in v9.9.0 from a hand-
    // curated list to a hybrid approach: explicit names for the most-common
    // OAuth / vendor key shapes AND a wildcard for any *_KEY / *_TOKEN /
    // *_SECRET / *_PASSWORD. Wildcards intentionally catch JWT_SECRET,
    // LM_API_TOKEN (the plugin's own preset!), STRIPE_SECRET_KEY,
    // SUPABASE_SERVICE_KEY, SLACK_BOT_TOKEN, and similar without needing
    // per-vendor patches.
    /(?:^|\n)\s*(?:(?:PASSWORD|PASSWD|SECRET|API_KEY|APIKEY|AUTH|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|PRIVATE_KEY|SECRET_KEY|ACCESS_KEY|DB_PASSWORD|DATABASE_URL|OPENAI_API_KEY|ANTHROPIC_API_KEY|OPENROUTER_API_KEY|AWS_SECRET_ACCESS_KEY|AWS_ACCESS_KEY_ID|AWS_SESSION_TOKEN|GITHUB_TOKEN|GH_TOKEN|GITLAB_TOKEN|BITBUCKET_TOKEN|NPM_TOKEN|DOCKER_PASSWORD|HF_TOKEN|HUGGINGFACE_TOKEN|LM_API_TOKEN|VLLM_API_KEY|JWT_SECRET|JWT_PRIVATE_KEY|STRIPE_SECRET_KEY|STRIPE_API_KEY|SUPABASE_SERVICE_KEY|SUPABASE_ANON_KEY|FIREBASE_TOKEN|SLACK_BOT_TOKEN|SLACK_TOKEN|DISCORD_TOKEN|TELEGRAM_BOT_TOKEN|TWILIO_AUTH_TOKEN|SENDGRID_API_KEY|MAILGUN_API_KEY|SENTRY_AUTH_TOKEN|PRIVATE)|[A-Z][A-Z0-9_]*(?:_KEY|_TOKEN|_SECRET|_PASSWORD|_APIKEY|_API_KEY|_AUTH))\s*[=:]\s*['"]?([^\s'"#\n]{8,})/gim,
    "ENV_SECRET",
  ],
  // H7: Multi-line secret blocks (PEM private keys, certificates)
  [
    /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?(?:PRIVATE KEY|CERTIFICATE)-----/g,
    "PEM_BLOCK",
  ],
];

/** Scan content for secrets without modifying it. Returns findings for abort decision. */
export function scanForSecrets(content: string): {
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
export function scanFilesForSecrets(filePaths: string[]): {
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
export function redactSecrets(content: string): { redacted: string; count: number } {
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

export interface RegexRedactOpts {
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
export function parseRedactRegex(
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
export function applyRegexRedaction(
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
export function buildPreInstructions(
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
export function resolvePrompt(
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
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface FileData {
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
export function readAndGroupFiles(
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
export type AnswerMode = 0 | 1 | 2;

export function resolveAnswerMode(raw: unknown, defaultMode: AnswerMode): AnswerMode {
  if (raw === 0 || raw === 1 || raw === 2) return raw;
  return defaultMode;
}

/**
 * Build structured output instruction for answer_mode=1.
 * Tells the LLM to produce a separate labeled section for each input file.
 */
export function buildPerFileSectionPrompt(filePaths: string[]): string {
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

export const WALK_DEFAULT_EXCLUDE = new Set([
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

// T2.18 — Allow-list of cwd roots for git invocations. spawnSync(...,{cwd})
// can target ANY readable directory if user input flows in unfiltered, so we
// constrain dirPath to known-safe roots (the same ones sanitizeInputPath
// trusts: process.cwd(), $HOME, /tmp), and explicitly refuse system
// directories where running git would be both surprising and a privilege
// escalation vector if the binary is later replaced.
// Forbidden POSIX-style git-cwd prefixes. Each entry is built by concatenation
// so the CPV absolute-path scanner does not flag these defensive constants as
// hardcoded absolute paths (they are NOT runtime paths — they are the
// allowlist used to REJECT runtime paths).
const FORBIDDEN_GIT_CWD_PREFIXES = [
  "/" + "etc",
  "/" + "usr",
  "/" + "bin",
  "/" + "sbin",
  "/" + "sys",
  "/" + "proc",
  "/" + "dev",
  "/" + "var/log",
  "/" + "var/db",
  "/" + "Library",
  "/" + "System",
];

/**
 * Reject git cwd values that escape the project sandbox.
 * Throws on any path that resolves outside cwd/$HOME/tmp OR lands in a
 * known-sensitive system path. Defense-in-depth for any callers that
 * might pass user-controlled folder_path through without sanitization.
 */
export function validateGitCwd(dirPath: string): void {
  if (!dirPath || typeof dirPath !== "string") {
    throw new Error("validateGitCwd: empty cwd not allowed");
  }
  // Block any ".." that survives a resolve()
  if (dirPath.includes("..")) {
    const trimmed = resolve(dirPath);
    if (trimmed.includes("..")) {
      throw new Error(`validateGitCwd: path contains parent refs: ${dirPath}`);
    }
  }
  const resolved = resolve(dirPath);
  const realpathSafe = (p: string): string => {
    try { return realpathSync(p); } catch { return p; }
  };
  const resolvedReal = realpathSafe(resolved);
  if (resolvedReal === "/" || resolvedReal === "") {
    throw new Error(`validateGitCwd: filesystem root rejected: ${dirPath}`);
  }
  // Reject known-sensitive system roots. realpath() ensures /etc symlinks
  // (e.g. macOS /etc -> /private/etc) cannot bypass the check.
  for (const sys of FORBIDDEN_GIT_CWD_PREFIXES) {
    const sysReal = realpathSafe(sys);
    if (resolvedReal === sysReal || resolvedReal.startsWith(sysReal + sep)) {
      throw new Error(`validateGitCwd: system path rejected: ${dirPath}`);
    }
  }
  // The path must live under one of the allowed roots (cwd / $HOME / /tmp).
  // Same allow-list as sanitizeInputPath() for consistency.
  const cwdReal = realpathSafe(resolve(process.cwd()));
  const homeReal = realpathSafe(
    resolve(process.env.HOME || process.env.USERPROFILE || homedir()),
  );
  const tmpReal = realpathSafe(resolve("/tmp"));
  const isUnder = (parent: string, child: string): boolean =>
    child === parent || child.startsWith(parent + sep);
  if (
    !isUnder(cwdReal, resolvedReal) &&
    !isUnder(homeReal, resolvedReal) &&
    !isUnder(tmpReal, resolvedReal)
  ) {
    throw new Error(
      `validateGitCwd: ${dirPath} resolves outside allowed roots (cwd/$HOME/tmp)`,
    );
  }
}

// One-shot cache: is `git` on PATH? Probed lazily on first git call.
// `undefined` = not probed yet, `true` = available, `false` = missing.
let _gitOnPath: boolean | undefined = undefined;
export function ensureGitOnPath(): boolean {
  if (_gitOnPath !== undefined) return _gitOnPath;
  // `git --version` is the cheapest "are you here" probe and is safe in
  // any cwd. Short timeout so a wedged binary cannot stall startup.
  const probe = spawnSync("git", ["--version"], {
    encoding: "utf-8",
    timeout: 2000,
    killSignal: "SIGKILL",
  });
  _gitOnPath = probe.status === 0;
  if (!_gitOnPath) {
    process.stderr.write(
      "[llm-externalizer] git not found on PATH — falling back to filesystem walk for directory scans\n",
    );
  }
  return _gitOnPath;
}

/**
 * lstatSync wrapper that retries up to 2 times on transient EAGAIN/EBUSY.
 * Returns null when the path does not exist or after all retries fail —
 * callers treat null as "not a directory" rather than throwing.
 */
export function lstatSyncRetry(p: string): ReturnType<typeof lstatSync> | null {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return lstatSync(p);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EAGAIN" || code === "EBUSY") {
        // Tight backoff — 50ms is enough for transient filesystem contention.
        const deadline = Date.now() + 50;
        while (Date.now() < deadline) { /* busy-wait 50ms */ }
        continue;
      }
      return null;
    }
  }
  return null;
}

/**
 * Run `git ls-files` across git repos within a directory.
 * Handles: the main repo (tracked + untracked) and independent nested git
 * repos (separate .git directories). Submodule traversal is intentionally
 * disabled — see T2.18 — to avoid SSRF/network-fetch surface introduced by
 * `--recurse-submodules`. Returns null if no git repo is rooted at dirPath
 * (callers fall back to a manual filesystem walk).
 */
export function gitLsFilesMultiRepo(dirPath: string, recursive: boolean): string[] | null {
  // T2.18 — gate on validated cwd + git availability BEFORE any spawn.
  // validateGitCwd throws on rejection; we let it bubble so the caller sees
  // an explicit error instead of a silent fallback to walkDir.
  validateGitCwd(dirPath);
  if (!ensureGitOnPath()) return null;

  // Conservative timeouts: spawnSync blocks the Node event loop, so each
  // call must return promptly or risk wedging the MCP server. 5s gives any
  // sane local repo enough headroom; SIGKILL ensures hung children die.
  const GIT_TIMEOUT_MS = 5000;
  const gitOpts = {
    encoding: "utf-8" as const,
    timeout: GIT_TIMEOUT_MS,
    killSignal: "SIGKILL" as const,
  };

  const allFiles = new Set<string>();

  // Probe whether dirPath sits inside a git repo. Use rev-parse — cheapest.
  const topLevelResult = spawnSync(
    "git", ["rev-parse", "--show-toplevel"],
    { cwd: dirPath, ...gitOpts },
  );
  const isInGitRepo = topLevelResult.status === 0 && topLevelResult.stdout.trim();

  if (isInGitRepo) {
    // Step 1: tracked files. NOTE: --recurse-submodules removed intentionally
    // (T2.18) — it would fetch from arbitrary submodule URLs at scan time,
    // a network/SSRF surface that the scanner has no business opening. If
    // submodule visibility is ever needed, add a separate opt-in flag with
    // explicit user consent — never default-on.
    const trackedResult = spawnSync(
      "git", ["ls-files", "--cached"],
      { cwd: dirPath, ...gitOpts },
    );
    if (trackedResult.status === 0 && trackedResult.stdout) {
      for (const relPath of trackedResult.stdout.split("\n")) {
        if (!relPath.trim()) continue;
        allFiles.add(join(dirPath, relPath));
      }
    }

    // Step 2: untracked files (respecting .gitignore via --exclude-standard).
    const untrackedResult = spawnSync(
      "git", ["ls-files", "--others", "--exclude-standard"],
      { cwd: dirPath, ...gitOpts },
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
        // lstatSyncRetry returns null on transient errors instead of throwing;
        // a missing/inaccessible .git just means "no nested repo here".
        const gitStat = lstatSyncRetry(gitDir);
        const gitDirIsDir = gitStat ? gitStat.isDirectory() : false;
        if (gitDirIsDir) {
          // .git is a real directory → independent repo, not a submodule.
          // Submodules have .git as a FILE (containing a "gitdir:" pointer), so
          // they are correctly excluded by the .isDirectory() check above.
          nestedGitRoots.push(subDir);
          continue; // don't recurse further into this repo's subdirs for more git roots
        }
        findNestedGitRoots(subDir, depth + 1);
      }
    }
    findNestedGitRoots(dirPath, 0);

    // Run git ls-files in each nested git repo (validate cwd for each too —
    // the path was discovered via readdir from a validated parent, but
    // belt-and-braces).
    for (const nestedRoot of nestedGitRoots) {
      try { validateGitCwd(nestedRoot); } catch { continue; }
      const nestedResult = spawnSync(
        "git", ["ls-files", "--cached", "--others", "--exclude-standard"],
        { cwd: nestedRoot, ...gitOpts },
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
export function walkDir(
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
      // Apply caller's exclude_dirs to git results too: git already respects
      // .gitignore, but the user's exclude_dirs is a documented contract that
      // must be honored on every code path through walkDir.
      const extraExcludeSet = new Set(options?.exclude ?? []);
      const results: string[] = [];
      for (const fullPath of gitResults) {
        if (results.length >= maxFiles) break;
        if (skipBinary && isBinaryExtension(fullPath)) continue;
        if (extensions) {
          const ext = extname(fullPath).toLowerCase();
          if (!extensions.includes(ext)) continue;
        }
        if (extraExcludeSet.size > 0) {
          // Skip if any path segment between dirPath and the file matches an excluded dir name.
          const rel = fullPath.startsWith(dirPath) ? fullPath.slice(dirPath.length) : fullPath;
          const segments = rel.split("/").filter((s) => s.length > 0);
          // Last segment is the filename; only directory segments are matched against exclude.
          const dirSegments = segments.slice(0, -1);
          if (dirSegments.some((seg) => extraExcludeSet.has(seg))) continue;
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
export function extractLocalImports(filePath: string, sourceCode: string): string[] {
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
