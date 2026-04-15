/**
 * File grouping helpers for LLM Externalizer.
 *
 * This module contains pure helpers used by the multi-file tool handlers:
 *   • parseFileGroups       — split an input_files_paths array by
 *                             ---GROUP:id--- markers
 *   • hasNamedGroups        — detect whether any named groups exist
 *   • autoGroupByHeuristic  — cluster files into groups of ≤ 1 MB each
 *                             (used when answer_mode=1 is selected without
 *                             explicit markers)
 *   • splitPerFileSections  — parse an LLM response that contains
 *                             `## File: <path>` section markers back into
 *                             per-file strings
 *
 * The module is deliberately kept free of side effects so the server entry
 * point (index.ts) and the unit tests can both import from it without
 * accidentally starting the MCP server. Every exported symbol is pure
 * or depends only on the local filesystem via `statSync`.
 */

import { statSync } from "node:fs";
import { basename, dirname, extname } from "node:path";

// ── File group markers ──────────────────────────────────────────────
// Callers can organize files into named groups using delimiter strings
// in the input_files_paths array. Each group is processed in isolation
// (no cross-group LLM calls) and produces its own report file.
//
// Syntax:
//   "---GROUP:<id>---"   → starts group <id>
//   "---/GROUP:<id>---"  → ends group <id> (optional: next header or
//                          end-of-array also closes)
//
// Files outside any group markers are collected into a single unnamed
// group. If no markers are present, the entire array is one unnamed
// group (backward compat).

export const GROUP_HEADER_RE = /^---GROUP:(.+)---$/;
export const GROUP_FOOTER_RE = /^---\/GROUP:(.+)---$/;

export interface FileGroup {
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
export function parseFileGroups(paths: string[]): FileGroup[] {
  const hasMarkers = paths.some(
    (p) => GROUP_HEADER_RE.test(p) || GROUP_FOOTER_RE.test(p),
  );
  if (!hasMarkers) {
    return paths.length > 0 ? [{ id: "", files: paths }] : [];
  }

  const groups: FileGroup[] = [];
  let ungrouped: string[] = [];
  let currentGroup: FileGroup | null = null;

  for (const entry of paths) {
    const headerMatch = entry.match(GROUP_HEADER_RE);
    if (headerMatch) {
      if (currentGroup && currentGroup.files.length > 0) {
        groups.push(currentGroup);
      }
      if (ungrouped.length > 0) {
        groups.push({ id: "", files: ungrouped });
        ungrouped = [];
      }
      currentGroup = { id: headerMatch[1], files: [] };
      continue;
    }

    const footerMatch = entry.match(GROUP_FOOTER_RE);
    if (footerMatch) {
      if (currentGroup && currentGroup.files.length > 0) {
        groups.push(currentGroup);
      }
      currentGroup = null;
      continue;
    }

    if (currentGroup) {
      currentGroup.files.push(entry);
    } else {
      ungrouped.push(entry);
    }
  }

  if (currentGroup && currentGroup.files.length > 0) {
    groups.push(currentGroup);
  }
  if (ungrouped.length > 0) {
    groups.push({ id: "", files: ungrouped });
  }

  return groups;
}

/**
 * Check if file groups contain named groups (id !== "").
 * If true, the tool should process each group independently.
 */
export function hasNamedGroups(groups: FileGroup[]): boolean {
  return groups.some((g) => g.id !== "");
}

// ── Intelligent auto-grouping for answer_mode=1 ──────────────────────
// When the caller asks for "one report per group" (answer_mode=1) but
// does NOT supply ---GROUP:id--- markers, autoGroupByHeuristic clusters
// files into logical groups based on these priorities, in order:
//   1) parent subfolder (files under the same immediate directory)
//   2) language/format (file extension)
//   3) namespace/package (inferred from directory hierarchy — collapses
//      to the parent directory for most codebases)
//   4) shared basename prefix (e.g. user.ts + user.test.ts) — used when
//      a (dir, ext) bucket is larger than maxGroupBytes and needs refining
//   5) shared imports/libraries (heuristic — not implemented in v1;
//      directory locality already serves as a strong proxy)
//
// Each group holds at most maxGroupBytes (default: 1 MB) of source.
// Larger buckets are split into sub-groups via size-aware bin packing
// so no single group drops off the LLM context horizon.

export const AUTO_GROUP_DEFAULT_MAX_BYTES = 1024 * 1024; // 1 MB per group

function sanitizeGroupId(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]/g, "_");
  return cleaned.length > 0 ? cleaned.slice(0, 60) : "auto";
}

function uniqueGroupId(raw: string, counts: Map<string, number>): string {
  const n = counts.get(raw) ?? 0;
  counts.set(raw, n + 1);
  return n === 0 ? raw : `${raw}_${n + 1}`;
}

interface SizedFile {
  path: string;
  parent: string;
  ext: string;
  base: string;
  stem: string;
  size: number;
}

function statFileForGrouping(p: string): SizedFile {
  const parent = dirname(p);
  const extWithDot = extname(p);
  const ext = extWithDot ? extWithDot.slice(1).toLowerCase() : "noext";
  const base = basename(p);
  const stem = base.slice(0, base.length - extWithDot.length);
  let size = 0;
  try {
    const st = statSync(p);
    if (st.isFile()) size = st.size;
  } catch {
    size = 0;
  }
  return { path: p, parent, ext, base, stem, size };
}

/**
 * Split a bucket into sub-buckets whose total size never exceeds
 * maxBytes, using First-Fit Decreasing bin packing. Files larger than
 * maxBytes by themselves are still emitted as single-file groups so
 * nothing gets lost.
 */
function splitBucketBySize(
  bucket: SizedFile[],
  maxBytes: number,
): SizedFile[][] {
  const sorted = [...bucket].sort((a, b) => b.size - a.size);
  const parts: SizedFile[][] = [];
  const partTotals: number[] = [];
  for (const fi of sorted) {
    let placed = false;
    for (let i = 0; i < parts.length; i++) {
      if (partTotals[i] + fi.size <= maxBytes) {
        parts[i].push(fi);
        partTotals[i] += fi.size;
        placed = true;
        break;
      }
    }
    if (!placed) {
      parts.push([fi]);
      partTotals.push(fi.size);
    }
  }
  return parts;
}

/**
 * Try to refine an oversized bucket by splitting on shared basename
 * prefix (3-character stem prefix). Falls back to size-based FFD if
 * the prefix split does not produce multiple sub-buckets.
 */
function splitBucketByBasenamePrefix(
  bucket: SizedFile[],
  maxBytes: number,
): SizedFile[][] {
  if (bucket.length < 2) return [bucket];
  const byPrefix = new Map<string, SizedFile[]>();
  for (const fi of bucket) {
    const prefix = fi.stem.slice(0, 3).toLowerCase() || "zz";
    const arr = byPrefix.get(prefix) ?? [];
    arr.push(fi);
    byPrefix.set(prefix, arr);
  }
  // If every file ended up in one prefix bucket, prefix refinement added
  // no value — defer to size-based splitting.
  if (byPrefix.size <= 1) return splitBucketBySize(bucket, maxBytes);
  const out: SizedFile[][] = [];
  for (const arr of byPrefix.values()) {
    const total = arr.reduce((s, f) => s + f.size, 0);
    if (total <= maxBytes) out.push(arr);
    else out.push(...splitBucketBySize(arr, maxBytes));
  }
  return out;
}

/**
 * Auto-group files for answer_mode=1 when no ---GROUP:id--- markers are
 * supplied. Returns FileGroup[] where each group holds at most
 * maxGroupBytes of source and has a stable, human-readable id derived
 * from the primary clustering key (parentDirName-ext).
 */
export function autoGroupByHeuristic(
  paths: string[],
  maxGroupBytes: number = AUTO_GROUP_DEFAULT_MAX_BYTES,
): FileGroup[] {
  // Filter out group markers defensively — callers may pass the raw
  // input_files_paths array.
  const filtered = paths.filter(
    (p) =>
      typeof p === "string" &&
      !GROUP_HEADER_RE.test(p) &&
      !GROUP_FOOTER_RE.test(p),
  );
  if (filtered.length === 0) return [];

  // Priority 1 + 2: group by (parent directory, extension).
  const primaryBuckets = new Map<string, SizedFile[]>();
  for (const p of filtered) {
    const fi = statFileForGrouping(p);
    const key = `${fi.parent}||${fi.ext}`;
    const bucket = primaryBuckets.get(key) ?? [];
    bucket.push(fi);
    primaryBuckets.set(key, bucket);
  }

  const out: FileGroup[] = [];
  const idCounts = new Map<string, number>();

  for (const [, bucket] of primaryBuckets) {
    const sample = bucket[0];
    const lastDir = sample.parent.split("/").filter(Boolean).pop() || "root";
    const rawIdBase = `${lastDir}-${sample.ext}`;

    const totalSize = bucket.reduce((s, f) => s + f.size, 0);

    if (totalSize <= maxGroupBytes) {
      const id = uniqueGroupId(sanitizeGroupId(rawIdBase), idCounts);
      out.push({ id, files: bucket.map((f) => f.path) });
      continue;
    }

    // Too big — split on basename prefix first (priority 4), then fall
    // back to size-aware bin packing.
    const parts = splitBucketByBasenamePrefix(bucket, maxGroupBytes);
    if (parts.length === 1) {
      const fallback = splitBucketBySize(parts[0], maxGroupBytes);
      for (let i = 0; i < fallback.length; i++) {
        const id = uniqueGroupId(
          sanitizeGroupId(`${rawIdBase}-p${i + 1}`),
          idCounts,
        );
        out.push({ id, files: fallback[i].map((f) => f.path) });
      }
      continue;
    }
    for (let i = 0; i < parts.length; i++) {
      const suffix = parts.length > 1 ? `-p${i + 1}` : "";
      const id = uniqueGroupId(
        sanitizeGroupId(`${rawIdBase}${suffix}`),
        idCounts,
      );
      out.push({ id, files: parts[i].map((f) => f.path) });
    }
  }

  return out;
}

// ── Per-file section splitter ─────────────────────────────────────────
// When buildPerFileSectionPrompt() asks the LLM to emit one `## File: <path>`
// section per file, splitPerFileSections parses the resulting response
// into a Map of absolute path → section body so the MCP server can save
// one report per file.

/**
 * Parse an LLM response that contains per-file `## File: <path>` section
 * markers into a map of expected path → section body. Matching priority:
 *   1. exact path match
 *   2. suffix match (LLM dropped directory prefix)
 *   3. unique basename match (LLM returned bare filename)
 *
 * Paths are trimmed so trailing whitespace or stray CR characters do not
 * break the lookup.
 */
export function splitPerFileSections(
  content: string,
  expectedPaths: string[],
): Map<string, string> {
  const result = new Map<string, string>();
  if (!content || !expectedPaths || expectedPaths.length === 0) return result;

  // Match lines that look like `## File: <path>` (tolerant of backticks
  // or quotes around the path). Case sensitive because filesystem paths
  // are case sensitive on Linux.
  const headerRe = /^\s*#{1,6}\s*File:\s*[`"']?(.+?)[`"']?\s*$/gm;
  const headers: { pathRaw: string; start: number; bodyStart: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(content)) !== null) {
    headers.push({
      pathRaw: m[1].trim(),
      start: m.index,
      bodyStart: m.index + m[0].length,
    });
  }
  if (headers.length === 0) return result;

  const byExact = new Map<string, string>();
  const byBasename = new Map<string, string[]>();
  for (const fp of expectedPaths) {
    byExact.set(fp, fp);
    const base = fp.split("/").pop() || fp;
    const bucket = byBasename.get(base) ?? [];
    bucket.push(fp);
    byBasename.set(base, bucket);
  }

  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    const bodyEnd = i + 1 < headers.length ? headers[i + 1].start : content.length;
    // Drop a trailing `---` separator if present — it's the per-file
    // section divider, not part of the report body.
    let body = content.slice(h.bodyStart, bodyEnd);
    body = body.replace(/\n\s*---\s*$/m, "").trim();

    let matched: string | undefined;
    if (byExact.has(h.pathRaw)) {
      matched = h.pathRaw;
    } else {
      for (const fp of expectedPaths) {
        if (h.pathRaw.endsWith(fp) || fp.endsWith(h.pathRaw)) {
          matched = fp;
          break;
        }
      }
      if (!matched) {
        const base = h.pathRaw.split("/").pop() || h.pathRaw;
        const bucket = byBasename.get(base);
        if (bucket && bucket.length === 1) {
          matched = bucket[0];
        }
      }
    }

    if (matched && !result.has(matched)) {
      result.set(matched, body);
    }
  }

  return result;
}
