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
export declare const GROUP_HEADER_RE: RegExp;
export declare const GROUP_FOOTER_RE: RegExp;
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
export declare function parseFileGroups(paths: string[]): FileGroup[];
/**
 * Check if file groups contain named groups (id !== "").
 * If true, the tool should process each group independently.
 */
export declare function hasNamedGroups(groups: FileGroup[]): boolean;
export declare const AUTO_GROUP_DEFAULT_MAX_BYTES: number;
/**
 * Auto-group files for answer_mode=1 when no ---GROUP:id--- markers are
 * supplied. Returns FileGroup[] where each group holds at most
 * maxGroupBytes of source and has a stable, human-readable id derived
 * from the primary clustering key (parentDirName-ext).
 */
export declare function autoGroupByHeuristic(paths: string[], maxGroupBytes?: number): FileGroup[];
/**
 * Parse an LLM response that contains per-file `## File: <path>` section
 * markers into a map of expected path → section body. Matching priority:
 *   1. exact path match
 *   2. unique basename match (LLM returned bare filename and exactly one
 *      expected path shares that basename)
 *   3. path-boundary suffix match (LLM dropped a directory prefix)
 *
 * Paths are trimmed so trailing whitespace or stray CR characters do not
 * break the lookup.
 */
export declare function splitPerFileSections(content: string, expectedPaths: string[]): Map<string, string>;
