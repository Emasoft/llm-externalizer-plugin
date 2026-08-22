/**
 * Transcript + checkpoint path resolution for the `session-summary` CLI
 * command — TRDD-T4MZ8YQR P5.
 *
 * Deliberately its OWN module, outside `session_summary/` (P1-P4's driver,
 * chunker, model-select, transcript reader) — it is CLI-surface plumbing
 * (finding files on disk), not part of the pure map-reduce pipeline those
 * modules implement, and the phases behind them are frozen.
 *
 * Claude Code stores one JSONL transcript per session at
 *   ~/.claude/projects/<project-slug>/<session-uuid>.jsonl
 * where `<project-slug>` is the project's absolute path with every
 * non-alphanumeric character replaced by `-` (verified empirically against
 * this project's own `~/.claude/projects/` entry — no other separator is
 * ever produced, so no other character needs escaping).
 */

import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

import { resolveProjectMainRoot } from "./project-root.js";

/** `<project-slug>` per Claude Code's own transcript-directory convention. */
export function projectSlug(absProjectRoot: string): string {
  return absProjectRoot.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * Claude Code >= 2.1.234: a host that gives each session its own config
 * directory can set CLAUDE_CODE_PROJECT_DIR_NAME to pick the per-project
 * transcript directory name directly, instead of it always being derived
 * from the project path via projectSlug(). Honor it verbatim when present.
 */
function resolveSessionDirName(projectRoot: string): string {
  const override = process.env.CLAUDE_CODE_PROJECT_DIR_NAME;
  return override && override.length > 0 ? override : projectSlug(projectRoot);
}

/** Same CLAUDE_CONFIG_DIR convention as rule-install.ts's resolveClaudeRulesDir(). */
function defaultClaudeProjectsDir(): string {
  const cfg = process.env.CLAUDE_CONFIG_DIR;
  const base = cfg && cfg.length > 0 ? resolve(cfg) : join(homedir(), ".claude");
  return join(base, "projects");
}

/**
 * Last parseable JSONL `timestamp` field in a transcript, read from the
 * tail of the file only (transcripts can be huge — never load the whole
 * file into memory just to find the last line). Claude Code 2.1.239 fixed
 * `/resume` showing a session as "recently changed" when only its file was
 * touched or merely reopened; we apply the same fix here by ranking on the
 * transcript's own last recorded event time instead of filesystem mtime,
 * which a touch/reopen can bump without the session actually advancing.
 */
function lastTimestampMs(path: string, tailBytes = 65536): number | null {
  const size = statSync(path).size;
  if (size === 0) return null;
  const readLen = Math.min(size, tailBytes);
  const fd = openSync(path, "r");
  let text: string;
  try {
    const buf = Buffer.alloc(readLen);
    readSync(fd, buf, 0, readLen, size - readLen);
    text = buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
  const lines = text.split("\n");
  // Drop the first line: when we didn't read from byte 0 it's a partial line.
  if (readLen < size) lines.shift();
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line) as { timestamp?: string };
      if (obj.timestamp) {
        const ms = Date.parse(obj.timestamp);
        if (!Number.isNaN(ms)) return ms;
      }
    } catch {
      // Not JSON (or a truncated line) — keep scanning earlier lines.
    }
  }
  return null;
}

export interface ResolveTranscriptOptions {
  /** Explicit `--transcript` path. Wins over everything else when given. */
  transcriptPath?: string;
  /** Explicit `--session-id`; resolved within the current project's transcript dir. */
  sessionId?: string;
  /** Override for tests; defaults to resolveProjectMainRoot(). */
  projectRoot?: string;
  /** Override for tests; defaults to ~/.claude/projects. */
  claudeProjectsDir?: string;
}

/**
 * Resolve the transcript to summarize: an explicit path, an explicit
 * session-id, or — the documented default — the most recently modified
 * `.jsonl` transcript for the current project. Fails fast with an
 * actionable message rather than silently summarizing the wrong session.
 */
export function resolveTranscriptPath(options: ResolveTranscriptOptions = {}): string {
  if (options.transcriptPath) {
    const p = resolve(options.transcriptPath);
    if (!existsSync(p)) {
      throw new Error(`session-summary: --transcript path does not exist: ${p}`);
    }
    return p;
  }

  const projectRoot = resolve(options.projectRoot ?? resolveProjectMainRoot());
  const claudeProjectsDir = options.claudeProjectsDir ?? defaultClaudeProjectsDir();
  const dirName = resolveSessionDirName(projectRoot);
  const sessionDir = join(claudeProjectsDir, dirName);

  if (options.sessionId) {
    const p = join(sessionDir, `${options.sessionId}.jsonl`);
    if (!existsSync(p)) {
      throw new Error(
        `session-summary: no transcript for --session-id '${options.sessionId}' at ${p}. ` +
          `Pass --transcript with an explicit path instead.`,
      );
    }
    return p;
  }

  if (!existsSync(sessionDir)) {
    throw new Error(
      `session-summary: no transcript directory for this project at ${sessionDir} ` +
        `(resolved project root: ${projectRoot}). Pass --transcript or --session-id explicitly.`,
    );
  }

  const jsonlFiles = readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"));
  if (jsonlFiles.length === 0) {
    throw new Error(
      `session-summary: no .jsonl transcripts found under ${sessionDir}. ` +
        `Pass --transcript or --session-id explicitly.`,
    );
  }

  let latestPath = "";
  let latestScore = -Infinity;
  for (const f of jsonlFiles) {
    const p = join(sessionDir, f);
    // Rank by the transcript's own last event timestamp, falling back to
    // mtime only when the file has no parseable timestamp — see
    // lastTimestampMs()'s comment for why mtime alone is unreliable.
    const score = lastTimestampMs(p) ?? statSync(p).mtimeMs;
    if (score > latestScore) {
      latestScore = score;
      latestPath = p;
    }
  }
  return latestPath;
}

/**
 * Deterministic default checkpoint location for a given (resolved, absolute)
 * transcript path — so re-running the same command against the same
 * transcript naturally finds and resumes its own checkpoint without the
 * caller having to track a path by hand. Keyed on the transcript path only
 * (not its contents), matching driver.ts's own identity check: a mismatched
 * checkpoint is rejected there, not silently reused.
 */
export function defaultCheckpointPath(transcriptAbsPath: string, configDir: string): string {
  const hash = createHash("sha256").update(transcriptAbsPath).digest("hex").slice(0, 16);
  return join(configDir, "session-summary-checkpoints", `${hash}.json`);
}
