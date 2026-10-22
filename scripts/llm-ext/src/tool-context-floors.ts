/**
 * Per-tool context floors for the dynamic-profile $0 patch (TRDD-RZSML8AC).
 *
 * WHY a registry: `decideDynamicProfile` used to take `toolContextFloors` as
 * a caller-injected input (P4 hand-off, fix-queue item 28) — zero callers
 * ever passed it, so the drop-head loop below the floor never ran. The patch
 * now consults THIS registry directly instead of relying on the caller to
 * inject a value.
 *
 * Leaf module: imports nothing from default-profiles.ts (no cycles).
 *
 * DESIGN-TIME SOURCE (never invent numbers): the FREE_POOL_SEED selection
 * comment in config.ts ("Selection criteria (curated 2026-05-27): ... meet
 * the per-tool requirements floor (context >= 128K, max_output >= 8K, ...)")
 * is the design document for the $0/free-pool head context bar; the
 * model-qualification registry (model-qualification/registry.ts, derived
 * from TRDD-f45eeaa0 §3) pins each registered tool's own hard bar via
 * `requirements.minContextTokens` — DEFAULT_CRITERIA carries 128_000
 * (benchmark/discover.ts) and SECURITY_TRIAGE_CRITERIA 16_000
 * (benchmark/security-triage/select.ts). Every entry below cites one of
 * those two; a tool with no entry has no completion-bearing context need
 * beyond its registered requirement and gets no floor here.
 */
export const TOOL_CONTEXT_FLOORS: Readonly<Record<string, number>> = Object.freeze({
  // model-qualification/registry.ts security_scan -> SECURITY_TRIAGE_CRITERIA
  // (benchmark/security-triage/select.ts): minContextTokens: 16_000 —
  // "triage snippets are small and the verdict is ~200 bytes".
  security_scan: 16_000,
  // model-qualification/registry.ts mass_scout -> criteria({ requireReasoning:
  // false }) over DEFAULT_CRITERIA (benchmark/discover.ts):
  // minContextTokens: 128_000 — the FREE_POOL_SEED "context >= 128K" floor.
  mass_scout: 128_000,
  cluster_synonyms: 128_000,
  code_task: 128_000,
  scan_folder: 128_000,
  search_existing_implementations: 128_000,
  check_references: 128_000,
  check_imports: 128_000,
  check_against_specs: 128_000,
  compare_files: 128_000,
  chat: 128_000,
  summarize: 128_000,
  topics: 128_000,
  sem_deduplicate: 128_000,
  describe: 128_000,
});
