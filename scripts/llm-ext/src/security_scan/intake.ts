/**
 * Intake — turn the caller's heterogeneous `targets[]` into a flat list of
 * judge-ready snippet records, then de-duplicate them.
 *
 * Responsibilities (TRDD §5 `intake.ts`):
 *   • snippet passthrough            — judged verbatim.
 *   • file_path (+line±context)      — extract the exact window from disk.
 *   • path_glob                      — expand to files, honoring .gitignore
 *                                      and an optional git_diff_ref; each file
 *                                      is judged whole.
 *   • secret redaction               — every snippet is redacted BEFORE egress
 *                                      (defense §3.8) so real secrets never
 *                                      reach the model.
 *   • content+category dedup (sha1)  — byte-identical (content,category) pairs
 *                                      are judged once; the verdict fans back
 *                                      out to every originating id via the
 *                                      re-expand map.
 *
 * Everything here is script-only — no LLM, no network. The git/walk helpers
 * are re-implemented locally (≤ what we need) so this module does NOT import
 * the mass_scouting CLI (TRDD §2 "don't wrap").
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import {
  DEFAULT_CONTEXT_LINES,
  GIT_REF_RE,
  MAX_FILE_READ_BYTES,
  MAX_SNIPPET_BYTES,
  type SecurityScanTarget,
} from "./types";

// ── Secret redaction (defense §3.8) ──────────────────────────────────────
// Patterns mirror src/index.ts's SECRET_PATTERNS verbatim. Re-implemented
// here (not imported) to keep this module self-contained — index.ts is the
// whole MCP server and importing it would pull the entire server graph.

// SECURITY (F1, F3 — aegis 2026-05-23): every pattern here runs on
// attacker-controlled bytes before egress, so each one MUST be authored
// backtracking-free — bounded quantifiers, anchored line-starts via [ \t]*
// (never `\s*`, which includes `\n` and re-anchors at every newline → O(n²)
// ReDoS). Do NOT reintroduce `\s*` spanning newlines in any egress pattern.
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/AKIA[0-9A-Z]{16}/g, "AWS_KEY"],
  [/(?:sk|pk)[-_](?:live|test|proj)[-_][A-Za-z0-9]{20,}/g, "API_KEY"],
  // F3: classic OpenAI-style `sk-…` key with no infix (the sk-proj/sk-live
  // shapes are caught by the rule above; this catches plain `sk-<base62>`).
  // Single bounded class after the literal prefix → no backtracking.
  [/sk-[A-Za-z0-9]{20,}/g, "API_KEY"],
  // F3: Google API key — fixed 35-char tail, single bounded class.
  [/AIza[0-9A-Za-z\-_]{35}/g, "GOOGLE_API_KEY"],
  [/ghp_[A-Za-z0-9]{36}/g, "GITHUB_PAT"],
  [/ghr_[A-Za-z0-9]{36}/g, "GITHUB_TOKEN"],
  [/gho_[A-Za-z0-9]{36}/g, "GITHUB_OAUTH"],
  [/github_pat_[A-Za-z0-9_]{82}/g, "GITHUB_PAT"],
  [/glpat-[A-Za-z0-9\-_]{20,}/g, "GITLAB_TOKEN"],
  [/xox[bpsar]-[A-Za-z0-9-]+/g, "SLACK_TOKEN"],
  [/Bearer\s+[A-Za-z0-9._\-/+=]{20,}/g, "BEARER_TOKEN"],
  // F3: raw JWT (header.payload.signature). Each segment is its own bounded
  // class separated by a literal dot — disjoint classes, no backtracking.
  [/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "JWT"],
  // F3: connection string with inline credentials (scheme://user:pass@host).
  // The `[^:@/\s]+` runs are disjoint from their `:`/`@` delimiters → linear.
  [/:\/\/[^:@/\s]+:[^@/\s]+@/g, "CONN_STRING"],
  // F1: ENV_SECRET — line-anchored via `[ \t]*` (intra-line horizontal
  // whitespace only). NEVER `\s*` here: `\s` includes `\n`, which re-anchors at
  // every newline and backtracks O(n²) over a hostile newline+whitespace blob.
  [
    /(?:^|\n)[ \t]*(?:(?:PASSWORD|PASSWD|SECRET|API_KEY|APIKEY|AUTH|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|PRIVATE_KEY|SECRET_KEY|ACCESS_KEY|DB_PASSWORD|DATABASE_URL|OPENAI_API_KEY|ANTHROPIC_API_KEY|OPENROUTER_API_KEY|AWS_SECRET_ACCESS_KEY|AWS_ACCESS_KEY_ID|AWS_SESSION_TOKEN|GITHUB_TOKEN|GH_TOKEN|GITLAB_TOKEN|BITBUCKET_TOKEN|NPM_TOKEN|DOCKER_PASSWORD|HF_TOKEN|HUGGINGFACE_TOKEN|LM_API_TOKEN|VLLM_API_KEY|JWT_SECRET|JWT_PRIVATE_KEY|STRIPE_SECRET_KEY|STRIPE_API_KEY|SUPABASE_SERVICE_KEY|SUPABASE_ANON_KEY|FIREBASE_TOKEN|SLACK_BOT_TOKEN|SLACK_TOKEN|DISCORD_TOKEN|TELEGRAM_BOT_TOKEN|TWILIO_AUTH_TOKEN|SENDGRID_API_KEY|MAILGUN_API_KEY|SENTRY_AUTH_TOKEN|PRIVATE)|[A-Z][A-Z0-9_]*(?:_KEY|_TOKEN|_SECRET|_PASSWORD|_APIKEY|_API_KEY|_AUTH))[ \t]*[=:][ \t]*['"]?([^\s'"#\n]{8,})/gim,
    "ENV_SECRET",
  ],
  // F3: case-insensitive catch for lowercase / mixed-case secret assignments
  // (e.g. `password = "..."`, `token: ...`, `"apikey":"..."`). Matches the
  // keyword + its `:`/`=` separator + value. `[ \t]*` keeps it line-local so
  // the quantifiers cannot cross newlines → linear.
  [
    /(?:password|passwd|pwd|token|secret|apikey)["']?[ \t]*[:=][ \t]*['"]?([^\s'"#\n]{4,})/gi,
    "SECRET_ASSIGNMENT",
  ],
  [
    /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?(?:PRIVATE KEY|CERTIFICATE)-----/g,
    "PEM_BLOCK",
  ],
];

/** Irreversible secret redaction — replaces every match with [REDACTED:LABEL]. */
export function redactSecrets(content: string): {
  redacted: string;
  count: number;
} {
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

/**
 * Wall-clock-guarded redaction (F1 — aegis 2026-05-23). Egress safety demands
 * that a record is shipped to the model ONLY if it was fully redacted. JS regex
 * is synchronous and cannot be pre-empted mid-match, so we cannot abort a stuck
 * pattern — but we CAN refuse to ship anything that took pathologically long
 * (a sign of a future ReDoS regression) or that threw. In both cases the record
 * is SKIPPED, never shipped un-redacted.
 *
 * `ok:false` ⇒ the caller MUST drop the record and record a skip. `redacted` is
 * still returned (best-effort) but must not be egressed when `ok` is false.
 */
export const REDACTION_BUDGET_MS = 500;

export function safeRedact(
  content: string,
  budgetMs: number = REDACTION_BUDGET_MS,
): { redacted: string; count: number; ok: boolean; reason?: string } {
  const started = Date.now();
  let out: { redacted: string; count: number };
  try {
    out = redactSecrets(content);
  } catch (e) {
    // A pattern threw (e.g. engine limit) — fail closed: never ship the raw text.
    return {
      redacted: "",
      count: 0,
      ok: false,
      reason: `redaction error: ${(e as Error).message}`,
    };
  }
  const elapsed = Date.now() - started;
  if (elapsed > budgetMs) {
    // Took too long — treat as a redaction failure and refuse egress. We cannot
    // trust that a stalled pass redacted everything, so skip rather than leak.
    return {
      redacted: out.redacted,
      count: out.count,
      ok: false,
      reason: `redaction exceeded ${budgetMs}ms wall-clock budget (took ${elapsed}ms) — record skipped to avoid shipping un-redacted content`,
    };
  }
  return { redacted: out.redacted, count: out.count, ok: true };
}

// ── Snippet record ───────────────────────────────────────────────────────

/** One unit of code to judge, after expansion + redaction (pre-dedup). */
export interface SnippetRecord {
  /** Originating caller id. */
  id: string;
  category: string;
  language?: string;
  /** The (already-redacted) code to judge. */
  content: string;
  /** Source file when known (file_path / glob shapes). */
  file_path?: string;
  /** Center line for file+line shape. */
  line?: number;
}

/** A skipped target with a human-readable reason (recorded, never crashes). */
export interface SkippedRecord {
  id: string;
  category: string;
  file_path?: string;
  reason: string;
}

/** A dedup group: one representative content judged once, fanned to members. */
export interface DedupGroup {
  /** sha1(content + " " + category) — the group key. */
  key: string;
  category: string;
  language?: string;
  content: string;
  /** Representative source file (first member's), for display. */
  file_path?: string;
  line?: number;
  /** Every member record that shares this (content,category). */
  members: SnippetRecord[];
}

export interface IntakeResult {
  groups: DedupGroup[];
  skipped: SkippedRecord[];
  /** Total snippet records before dedup (sum of group.members lengths). */
  recordsTotal: number;
}

// ── git + walk helpers (local, self-contained) ───────────────────────────

const DEFAULT_SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".venv",
  "dist",
  "build",
  ".idea",
  ".vscode",
  "tmp",
  "vendor",
  ".next",
  ".cache",
  "__pycache__",
  "target",
  ".turbo",
  "out",
]);

/** Absolute paths of files matching a relative glob under `root`. */
function expandGlob(root: string, glob: string): string[] {
  const all = walkFiles(root);
  const re = globToRegExp(glob);
  return all.filter((abs) => {
    const rel = relativeUnix(root, abs);
    return re.test(rel);
  });
}

/** Recursively list every file under `root`, skipping default dirs. */
function walkFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(dir, e);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (DEFAULT_SKIP_DIRS.has(e)) continue;
        stack.push(full);
      } else if (st.isFile()) {
        out.push(full);
      }
    }
  }
  out.sort();
  return out;
}

/** Relative path from root → abs, always forward-slashed. */
function relativeUnix(root: string, abs: string): string {
  const r = resolve(root);
  const a = resolve(abs);
  let rel = a.startsWith(r) ? a.slice(r.length) : a;
  rel = rel.replace(/^[/\\]+/, "").replace(/\\/g, "/");
  return rel;
}

/**
 * Convert a shell-style glob to an anchored RegExp. Supports `**` (any depth,
 * including zero dirs), `*` (one segment), `?` (one char), and literal text.
 * Anchored to the full relative path. Anti-ReDoS: the produced pattern has no
 * nested quantifiers over overlapping classes.
 */
export function globToRegExp(glob: string): RegExp {
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**` → any chars including `/`. Consume a trailing `/` so
        // `a/**/b` also matches `a/b` (zero intermediate dirs).
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  re += "$";
  return new RegExp(re);
}

/** Files changed since `ref` (added/copied/modified/renamed), absolute. */
function gitChangedFiles(root: string, ref: string): string[] | null {
  if (!GIT_REF_RE.test(ref) || ref.length > 200) return null;
  try {
    const out = execSync(
      `git diff --name-only --diff-filter=ACMR -z ${JSON.stringify(ref)}...HEAD`,
      { cwd: root, encoding: "buffer", stdio: ["ignore", "pipe", "ignore"] },
    );
    return out
      .toString("utf-8")
      .split("\0")
      .filter((s) => s.length > 0)
      .map((p) => resolve(root, p));
  } catch {
    return null;
  }
}

/** Tracked + untracked-but-not-ignored files, absolute (the .gitignore set). */
function gitTrackedFiles(root: string): string[] | null {
  try {
    const out = execSync("git ls-files --cached --others --exclude-standard -z", {
      cwd: root,
      encoding: "buffer",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out
      .toString("utf-8")
      .split("\0")
      .filter((s) => s.length > 0)
      .map((p) => resolve(root, p));
  } catch {
    return null;
  }
}

// ── Window extraction ────────────────────────────────────────────────────

/**
 * Extract `line` ± `contextLines` from `content`. 1-based `line`; the window
 * clamps at file bounds. Returns null when `line` is out of range (caller
 * records a skip rather than crashing — TRDD §6 T2).
 */
export function extractWindow(
  content: string,
  line: number,
  contextLines: number,
): { window: string; startLine: number } | null {
  const lines = content.split("\n");
  if (line < 1 || line > lines.length) return null;
  const start = Math.max(1, line - contextLines);
  const end = Math.min(lines.length, line + contextLines);
  // slice() is 0-based, end-exclusive → [start-1, end).
  const window = lines.slice(start - 1, end).join("\n");
  return { window, startLine: start };
}

// ── Main intake ──────────────────────────────────────────────────────────

export interface IntakeOptions {
  /** Root for relative glob / git-diff resolution. Defaults to cwd. */
  folderRoot?: string;
  /** Only include glob files changed since this ref (intersection). */
  gitDiffRef?: string;
  /** When true (default), glob results are intersected with the .gitignore set. */
  honorGitignore?: boolean;
  /** Scout-time byte cap; files/snippets larger are skipped-too-big. */
  byteCap?: number;
}

/**
 * Normalize every target into redacted `SnippetRecord`s, record skips, then
 * group by (content,category) for dedup. Pure + synchronous.
 */
export function intake(
  targets: SecurityScanTarget[],
  opts: IntakeOptions = {},
): IntakeResult {
  const root = opts.folderRoot ? resolve(opts.folderRoot) : process.cwd();
  const honorGitignore = opts.honorGitignore !== false;
  const byteCap = opts.byteCap && opts.byteCap > 0 ? opts.byteCap : MAX_SNIPPET_BYTES;

  const records: SnippetRecord[] = [];
  const skipped: SkippedRecord[] = [];

  const tooBig = (id: string, category: string, fp: string | undefined, bytes: number): void => {
    skipped.push({
      id,
      category,
      file_path: fp,
      reason: `content ${bytes} bytes > cap ${byteCap}`,
    });
  };

  /**
   * F5 (aegis 2026-05-23): cheap on-disk size pre-check BEFORE readFileSync, so
   * an over-cap file is never loaded into a JS string at all (readFileSync of a
   * giant file is the DoS, not the send). Returns true when the file was skipped
   * (caller must `continue`); false when the file is within cap and safe to read.
   * The skip reason reuses the `content … bytes > cap` prefix so it counts in the
   * items_skipped_too_big accounting, keeping that number honest for big files.
   */
  const statTooBig = (
    id: string,
    category: string,
    abs: string,
    cap: number = byteCap,
  ): boolean => {
    let size: number;
    try {
      size = statSync(abs).size;
    } catch {
      // stat failed — let the readFileSync path surface the real read error.
      return false;
    }
    if (size > cap) {
      tooBig(id, category, abs, size);
      return true;
    }
    return false;
  };

  const pushRedacted = (rec: SnippetRecord): void => {
    const bytes = Buffer.byteLength(rec.content, "utf-8");
    if (bytes > byteCap) {
      tooBig(rec.id, rec.category, rec.file_path, bytes);
      return;
    }
    // F1 (aegis 2026-05-23): egress only AFTER a successful, bounded redaction.
    // If redaction throws or blows the wall-clock budget, SKIP the record — we
    // must never ship content we are not certain was fully redacted.
    const red = safeRedact(rec.content);
    if (!red.ok) {
      skipped.push({
        id: rec.id,
        category: rec.category,
        file_path: rec.file_path,
        reason: red.reason ?? "redaction failed — record skipped to avoid egress",
      });
      return;
    }
    rec.content = red.redacted;
    records.push(rec);
  };

  for (const t of targets) {
    if (typeof t.snippet === "string") {
      pushRedacted({
        id: t.id,
        category: t.category,
        language: t.language,
        content: t.snippet,
      });
      continue;
    }

    if (typeof t.file_path === "string") {
      const abs = isAbsolute(t.file_path)
        ? t.file_path
        : resolve(root, t.file_path);
      // F5 + window-cap fix: refuse over-cap files before reading them into
      // memory. For a WINDOW target (line set) the egress content is the
      // extracted ±context window, NOT the whole file — so the whole-file gate
      // must use the generous DoS read-guard, and the egress `byteCap` is then
      // applied to the window by pushRedacted. For a WHOLE-FILE target the file
      // itself is the egress content, so the egress cap applies up front.
      const fileGate = typeof t.line === "number" ? MAX_FILE_READ_BYTES : byteCap;
      if (statTooBig(t.id, t.category, abs, fileGate)) continue;
      let content: string;
      try {
        content = readFileSync(abs, "utf-8");
      } catch (e) {
        skipped.push({
          id: t.id,
          category: t.category,
          file_path: abs,
          reason: `read error: ${(e as Error).message}`,
        });
        continue;
      }
      if (typeof t.line === "number") {
        const ctx = t.context_lines ?? DEFAULT_CONTEXT_LINES;
        const win = extractWindow(content, t.line, ctx);
        if (!win) {
          skipped.push({
            id: t.id,
            category: t.category,
            file_path: abs,
            reason: `line ${t.line} out of range (file has ${content.split("\n").length} lines)`,
          });
          continue;
        }
        pushRedacted({
          id: t.id,
          category: t.category,
          language: t.language,
          content: win.window,
          file_path: abs,
          line: t.line,
        });
      } else {
        // Whole file.
        pushRedacted({
          id: t.id,
          category: t.category,
          language: t.language,
          content,
          file_path: abs,
        });
      }
      continue;
    }

    if (typeof t.path_glob === "string") {
      let matched = expandGlob(root, t.path_glob);
      if (opts.gitDiffRef) {
        const changed = gitChangedFiles(root, opts.gitDiffRef);
        if (changed !== null) {
          const changedSet = new Set(changed);
          matched = matched.filter((p) => changedSet.has(p));
        }
      }
      if (honorGitignore) {
        const tracked = gitTrackedFiles(root);
        if (tracked !== null && tracked.length > 0) {
          const trackedSet = new Set(tracked);
          const filtered = matched.filter((p) => trackedSet.has(p));
          // Belt-and-braces: if the intersection nukes everything but the glob
          // did match files, keep the glob result (the repo may be shallow /
          // git may be unavailable in a way that returned a stale set).
          if (filtered.length > 0) matched = filtered;
        }
      }
      if (matched.length === 0) {
        skipped.push({
          id: t.id,
          category: t.category,
          reason: `path_glob ${JSON.stringify(t.path_glob)} matched no files under ${root}`,
        });
        continue;
      }
      for (const abs of matched) {
        // F5: refuse over-cap files before reading them into memory. Each glob
        // member is checked independently so one huge file can't stall the walk.
        if (statTooBig(`${t.id}::${relativeUnix(root, abs)}`, t.category, abs)) {
          continue;
        }
        let content: string;
        try {
          content = readFileSync(abs, "utf-8");
        } catch (e) {
          skipped.push({
            id: t.id,
            category: t.category,
            file_path: abs,
            reason: `read error: ${(e as Error).message}`,
          });
          continue;
        }
        pushRedacted({
          // Glob fans into multiple files — make each id unique + traceable.
          id: `${t.id}::${relativeUnix(root, abs)}`,
          category: t.category,
          language: t.language,
          content,
          file_path: abs,
        });
      }
      continue;
    }

    // Should be unreachable — validateTarget guarantees one payload.
    skipped.push({
      id: t.id,
      category: t.category,
      reason: "target had no recognizable payload (snippet/file_path/path_glob)",
    });
  }

  // ── Dedup by (content, category) ──
  const byKey = new Map<string, DedupGroup>();
  for (const rec of records) {
    const key = dedupKey(rec.content, rec.category);
    let g = byKey.get(key);
    if (!g) {
      g = {
        key,
        category: rec.category,
        language: rec.language,
        content: rec.content,
        file_path: rec.file_path,
        line: rec.line,
        members: [],
      };
      byKey.set(key, g);
    }
    g.members.push(rec);
  }

  return {
    groups: Array.from(byKey.values()),
    skipped,
    recordsTotal: records.length,
  };
}

/** sha1(content + NUL + category) — the dedup-group identity. */
export function dedupKey(content: string, category: string): string {
  return createHash("sha1")
    .update(content, "utf-8")
    .update(" ")
    .update(category, "utf-8")
    .digest("hex");
}
