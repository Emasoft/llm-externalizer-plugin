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

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

import { resolveProjectMainRoot } from "./project-root.js";

/** `<project-slug>` per Claude Code's own transcript-directory convention. */
export function projectSlug(absProjectRoot: string): string {
  return absProjectRoot.replace(/[^a-zA-Z0-9]/g, "-");
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
  const claudeProjectsDir = options.claudeProjectsDir ?? join(homedir(), ".claude", "projects");
  const slug = projectSlug(projectRoot);
  const sessionDir = join(claudeProjectsDir, slug);

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
  let latestMtimeMs = -Infinity;
  for (const f of jsonlFiles) {
    const p = join(sessionDir, f);
    const mtimeMs = statSync(p).mtimeMs;
    if (mtimeMs > latestMtimeMs) {
      latestMtimeMs = mtimeMs;
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
