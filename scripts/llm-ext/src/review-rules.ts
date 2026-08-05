/**
 * Layered per-path review rules (TRDD-3JQVBO7M — distilled from
 * OpenCodeReview's rule.json concept, adapted, never vendored).
 *
 * Resolution precedence, highest first:
 *   1. an explicit rules-file path passed by the caller (`--rules`),
 *   2. `<repo>/.llm-ext/rules.yaml` — the project's rules,
 *   3. `<configDir>/rules.yaml` (~/.llm-externalizer) — the user's, OPT-IN,
 *   4. none — the tools keep their built-in behavior unchanged.
 * A missing layer is silently skipped (not an error); the FIRST layer that
 * exists wins outright — layers never merge, because merging makes "which
 * rule fired?" unanswerable, and rules-check exists to answer exactly that.
 *
 * A rules file is YAML:
 *   rules:
 *     - path: "src/**\/*.ts"
 *       rule: "Strict-TS Node backend. FAIL-FAST: never report missing error handling."
 *     - path: "**\/*.py"
 *       rule: "..."
 * Entries are evaluated in DECLARATION ORDER; the first glob that matches the
 * file decides. Globs support **, *, ?, {a,b}, [abc], matched
 * case-insensitively (macOS/Windows filesystems are), against the path as
 * given AND its basename-relative tail — so "src/**\/*.ts" matches whether the
 * caller passed an absolute or repo-relative path.
 *
 * Rules AUGMENT the caller's instructions, never replace them — the estimator's
 * PROMPT_OVERHEAD_TOKENS constant absorbs the added rule text conservatively.
 * Pure core + thin fs shell, same discipline as everywhere else in this tree.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as yamlParse } from "yaml";

import { getConfigDir } from "./config.js";

export interface RuleEntry {
  path: string;
  rule: string;
}

export interface ResolvedRules {
  /** Which layer won: "explicit" | "project" | "user". */
  layer: string;
  /** Absolute path of the winning rules file (for rules-check output). */
  file: string;
  entries: RuleEntry[];
}

// ── Glob → RegExp (no new dependency) ──────────────────────────────────
// Supports the subset the rules format documents: **, *, ?, {a,b}, [abc].
// Deliberately small and fully unit-tested; exotic glob features are out of
// scope and a pattern using them simply won't match (fail-closed, visible in
// rules-check, never a crash).

export function globToRegExp(glob: string): RegExp {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` matches zero or more whole segments; bare `**` matches any depth.
        if (glob[i + 2] === "/") {
          re += "(?:[^/]+/)*";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      re += "[^/]";
      i += 1;
    } else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end === -1) {
        re += "\\{";
        i += 1;
      } else {
        // Alternates get the SAME wildcard translation as the main walk:
        // `**` → any depth, `*` → within-segment, `?` → one non-slash char.
        // The NUL placeholder (legal in no filename, hence in no glob) keeps `**` from being eaten by the `*` pass, and
        // translating `?` matters doubly — untranslated it was a live regex
        // QUANTIFIER ("optional previous char"), silently changing the
        // pattern's meaning (ultracode F11, 2026-08-05).
        const alts = glob
          .slice(i + 1, end)
          .split(",")
          .map((a) =>
            a
              .replace(/[.+^$()|[\]\\]/g, "\\$&")
              .replace(/\*\*/g, "\u0000")
              .replace(/\*/g, "[^/]*")
              .replace(/\?/g, "[^/]")
              .split("\u0000").join(".*"),
          );
        re += `(?:${alts.join("|")})`;
        i = end + 1;
      }
    } else if (c === "[") {
      const end = glob.indexOf("]", i);
      if (end === -1) {
        re += "\\[";
        i += 1;
      } else {
        re += glob.slice(i, end + 1);
        i = end + 1;
      }
    } else {
      re += c.replace(/[.+^$()|\\]/g, "\\$&");
      i += 1;
    }
  }
  // NEVER throw (ultracode F9, 2026-08-05): `[...]` class content is compiled
  // verbatim, so a regex-invalid class like `[b-a]` used to throw HERE — at
  // MATCH time, inside composeRuleInstructions during dispatch — taking the
  // tools down from a non-explicit project/user rules layer, the exact thing
  // the module contract forbids. Fail closed instead: an uncompilable pattern
  // matches nothing, which rules-check makes visible.
  try {
    return new RegExp(`^${re}$`, "i");
  } catch {
    return /^(?!)$/; // never matches anything
  }
}

/**
 * Does `pattern` match `filePath`? Matched against the path as given AND
 * against every suffix of its segments — so a repo-relative pattern like
 * `src/**` matches an absolute `/home/u/repo/src/x.ts` without the caller
 * having to know the repo root.
 */
export function ruleGlobMatches(pattern: string, filePath: string): boolean {
  const re = globToRegExp(pattern);
  const norm = filePath.replace(/\\/g, "/");
  if (re.test(norm)) return true;
  const segments = norm.split("/").filter((s) => s.length > 0);
  for (let start = 1; start < segments.length; start++) {
    if (re.test(segments.slice(start).join("/"))) return true;
  }
  return false;
}

/** First entry whose glob matches, in declaration order — or null. */
export function matchRuleForFile(
  filePath: string,
  entries: readonly RuleEntry[],
): RuleEntry | null {
  for (const e of entries) {
    if (ruleGlobMatches(e.path, filePath)) return e;
  }
  return null;
}

// ── Layer resolution (thin fs shell) ───────────────────────────────────

function readRulesFile(file: string): RuleEntry[] | null {
  try {
    if (!existsSync(file)) return null;
    const parsed = yamlParse(readFileSync(file, "utf-8")) as {
      rules?: unknown;
    } | null;
    if (!parsed || !Array.isArray(parsed.rules)) return null;
    const entries = parsed.rules.filter(
      (r): r is RuleEntry =>
        !!r &&
        typeof (r as RuleEntry).path === "string" &&
        typeof (r as RuleEntry).rule === "string",
    );
    return entries.length > 0 ? entries : null;
  } catch {
    // A malformed rules file must not take the tools down; rules-check is the
    // place to debug it, and "no rules" is the safe degradation.
    return null;
  }
}

export function resolveRulesLayers(opts?: {
  explicitPath?: string;
  projectRoot?: string;
  configDir?: string;
}): ResolvedRules | null {
  if (opts?.explicitPath) {
    const entries = readRulesFile(opts.explicitPath);
    if (entries) return { layer: "explicit", file: opts.explicitPath, entries };
    // An EXPLICITLY named file that doesn't parse is the one case worth being
    // loud about — the caller asked for exactly this file.
    throw new Error(
      `rules file not usable: ${opts.explicitPath} (missing, unreadable, or has no valid 'rules:' entries)`,
    );
  }
  const projectFile = join(opts?.projectRoot ?? process.cwd(), ".llm-ext", "rules.yaml");
  const projectEntries = readRulesFile(projectFile);
  if (projectEntries) return { layer: "project", file: projectFile, entries: projectEntries };
  const userFile = join(opts?.configDir ?? getConfigDir(), "rules.yaml");
  const userEntries = readRulesFile(userFile);
  if (userEntries) return { layer: "user", file: userFile, entries: userEntries };
  return null;
}

// ── Composition into instructions ──────────────────────────────────────

/**
 * Augment the caller's instructions with the rules matching the given files.
 * Files are grouped by the entry that matched them; unmatched files add
 * nothing. The base instructions ALWAYS survive verbatim at the top.
 */
export function composeRuleInstructions(
  baseInstructions: string,
  files: readonly string[],
  resolved: ResolvedRules | null,
): string {
  if (!resolved) return baseInstructions;
  const matchedEntries: RuleEntry[] = [];
  for (const f of files) {
    const m = matchRuleForFile(f, resolved.entries);
    if (m && !matchedEntries.includes(m)) matchedEntries.push(m);
  }
  if (matchedEntries.length === 0) return baseInstructions;
  const sections = matchedEntries.map(
    (e) => `For files matching \`${e.path}\`: ${e.rule}`,
  );
  return (
    `${baseInstructions}\n\n` +
    `PROJECT REVIEW RULES (${resolved.layer} layer — augment, never replace, the instructions above):\n` +
    sections.join("\n")
  );
}
