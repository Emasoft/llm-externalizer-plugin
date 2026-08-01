// ── Doc-inventory extraction (A5, TRDD-828238b5) ───────────────────────
//
// Single source of truth for the COUNTS and NAME LISTS that the docs restate
// by hand (and that drifted on every tool addition during the deep audit).
// These pure functions parse the authoritative declarations straight from the
// source tree so the doc-consistency test (doc-consistency.test.ts) can assert
// the README/rule docs match the code. No server import (index.ts runs main()
// on import) — everything is read as text + regex.

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root = two levels up from this module (mcp-server/src → repo root). */
export function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/**
 * Core/utility MCP tool names — declared inline in buildTools()'s `allTools`
 * array (extracted to tools/definitions.ts in B1 Phase 4, TRDD-63314265),
 * each as a 6-space-indented `name: "x",`. The 6-space anchor excludes the
 * 2-space-indented JSON-schema `name:` fields elsewhere in the file.
 */
export function readCoreToolNames(root: string = repoRoot()): string[] {
  const src = readFileSync(
    join(root, "mcp-server", "src", "tools", "definitions.ts"),
    "utf-8",
  );
  return matchAll(src, /^ {6}name: "([a-z0-9_]+)",$/gm);
}

/**
 * Mass-scout + model-qualification MCP tool names — declared in MASS_SCOUT_TOOLS
 * in mass_scouting/mcp-tools.ts, each as a 4-space-indented `name: "x",`.
 */
export function readMassScoutToolNames(root: string = repoRoot()): string[] {
  const src = readFileSync(
    join(root, "mcp-server", "src", "mass_scouting", "mcp-tools.ts"),
    "utf-8",
  );
  return matchAll(src, /^ {4}name: "([a-z0-9_]+)",$/gm);
}

/** Every MCP tool the server exposes (core + mass-scout/model-qual). */
export function readAllToolNames(root: string = repoRoot()): string[] {
  return [...readCoreToolNames(root), ...readMassScoutToolNames(root)];
}

/** API-preset keys — declared in API_PRESETS in config.ts. */
export function readApiPresetNames(root: string = repoRoot()): string[] {
  const src = readFileSync(join(root, "mcp-server", "src", "config.ts"), "utf-8");
  const start = src.indexOf("export const API_PRESETS");
  if (start === -1) throw new Error("API_PRESETS not found in config.ts");
  // Keys are 2-space-indented quoted strings until the next top-level `};`.
  const end = src.indexOf("\n};", start);
  const block = src.slice(start, end === -1 ? undefined : end);
  return matchAll(block, /^ {2}"([a-z0-9-]+)": \{$/gm);
}

/** Slash-command names — the frontmatter `name:` of each commands/*.md. */
export function readCommandNames(root: string = repoRoot()): string[] {
  const dir = join(root, "commands");
  const names: string[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    const src = readFileSync(join(dir, f), "utf-8");
    const fm = frontmatter(src);
    const m = fm.match(/^name:\s*(\S+)\s*$/m);
    if (!m) throw new Error(`commands/${f} has no frontmatter name:`);
    names.push(m[1]!);
  }
  return names.sort();
}

/** Agent names — one agents/*.md per agent. */
export function readAgentNames(root: string = repoRoot()): string[] {
  const dir = join(root, "agents");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""))
    .sort();
}

// ── helpers ────────────────────────────────────────────────────────────

function matchAll(text: string, re: RegExp): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(re)) out.push(m[1]!);
  return out;
}

/** Return the YAML frontmatter block (between the first two `---` lines), or "". */
function frontmatter(src: string): string {
  if (!src.startsWith("---")) return "";
  const end = src.indexOf("\n---", 3);
  return end === -1 ? "" : src.slice(3, end);
}
