---
trdd-id: a24b213c-4061-4d4f-9405-3162d1914eea
title: Three-surface compliance backlog — close the remaining MCP/CLI/slash gaps
status: not-started
created: 2026-05-24T01:49:50+0200
updated: 2026-05-24T01:49:50+0200
---

# TRDD-a24b213c — Three-surface compliance backlog

**Filename:** `design/tasks/TRDD-20260524_014950+0200-a24b213c-three-surface-gap-backlog.md`
**Tracked in:** this repo (`llm-externalizer-plugin/design/tasks/` is git-tracked)

## 0. Origin

The plugin convention ([[three-surfaces-per-function]]): every capability must
ship as **MCP tool + CLI subcommand + Claude Code slash command**, all wired to
the same core. A full audit (reports/release-prep/20260524_001805+0200-three-surface-audit.md)
found **43 functions, 23 compliant, 20 gaps**.

`cluster_synonyms` (GAP-1, the only MCP-only outlier) is being completed in the
current release under [[TRDD-5bd98017]]'s sibling task (#87). `security_scan`
ships fully compliant. This TRDD tracks the **remaining 19 gaps** deferred out
of that release so they are not lost.

## 1. Deferred gaps + disposition

### A. Missing MCP tool — needs a design decision (2)
- **GAP-2 `benchmark`** — has CLI (`llm-ext-benchmark`) + slash
  (`llm-externalizer-benchmark`), no MCP tool. The command file says "No MCP
  tools" (deterministic, OpenRouter-direct). DECISION: add an MCP wrapper over
  `mcp-server/src/benchmark/index.ts`, OR formally document the exemption in the
  command + CLAUDE.md.
- **GAP-3 `ensemble-autoselect`** (model rotation) — CLI
  (`llm-ext-benchmark --pick-top-n --apply-profile`) + skill, no MCP tool. Same
  core as benchmark (`benchmark/pick.ts::pickTopN`, `discover.ts::qualify`). If
  GAP-2 gets an MCP tool, expose rotation as a mode of it. Also add a dedicated
  `/llm-externalizer-rotate-ensemble` slash command for discoverability.

### B. Missing slash command — mechanical (9)
Each wraps an EXISTING CLI verb; mirror the existing
`commands/llm-externalizer-mass-scout-*.md` files.
- **GAP-4 (×8)** `mass_scout_jobs_list`, `mass_scout_audit_sample`,
  `mass_scout_body_get`, `mass_scout_build_fieldset`,
  `mass_scout_propose_fieldset`, `mass_scout_diff`, `mass_scout_chain`,
  `mass_scout_list_bundled_fieldsets` → add 8
  `commands/llm-externalizer-mass-scout-*.md` files.
- **GAP-7** `reset` (MCP ✓ + CLI `llm-ext reset` ✓) → add
  `commands/llm-externalizer-reset.md` (sibling of `discover`).

### C. Slash-only orchestration / write / interactive — recommend EXEMPT, document (7)
These are inherently multi-agent orchestration, write-flows (write tools are
disabled in the MCP server by design), or interactive wizards — not a single
callable unit. Recommend a documented by-design exemption rather than forcing
a synthetic MCP/CLI surface:
- **GAP-8** `codex-scan` (wraps external Codex CLI — low value to shim)
- **GAP-9** `fix-report`, **GAP-10** `fix-found-bugs` (apply fixes via subagents;
  MCP write tools disabled by design)
- **GAP-11** `scan-and-fix`, **GAP-12** `scan-and-fix-serially` (multi-agent
  orchestration)
- **GAP-13** `setup` (interactive platform-detection wizard)
- **GAP-14** `install-statusline` (one-shot installer; a trivial
  `llm-externalizer install-statusline` CLI verb COULD be added if strict
  compliance is wanted — low priority)

### D. Documentation / consistency fixes (not surface gaps)
- **Stale CLAUDE.md rule** — `~/.claude/rules/use-llm-externalizer.md` still
  lists `set_settings` / `change_model` as live MCP tools; they were removed by
  design (config is user-only, edit settings.yaml manually). Remove/annotate.
  NOTE: this is a USER-GLOBAL file — change only with the user's confirmation.
- **`bin/llm-ext` catalog is incomplete** — it allow-lists only 11 tools and
  rejects the rest, so `search_existing_implementations`, `cluster_synonyms`,
  `or_model_info*`, and the `mass_scout_*` family are NOT reachable through
  `llm-ext` (they ARE via the `llm-externalizer` binary). If `llm-ext` is the
  canonical agent-facing CLI, expand its `TOOL_CATALOG`; otherwise document the
  two front-doors. (This is part of why the audit treats CLI presence via the
  `llm-externalizer` binary, not `llm-ext`.)

### E. By-design (NOT gaps, recorded for completeness)
- `change-model`/`set profile`: slash command guides a manual edit; MCP
  `set_settings`/`change_model` + CLI mutating-profile verbs are deliberately
  disabled (config is user-only). Compliant-by-exemption.
- `configure`, `free-scan`: composite commands over already-3-surface
  primitives — nothing new to expose.

## 2. Suggested execution order (when picked up)
1. GAP-4 + GAP-7 (9 mechanical slash commands) — swarmable, low-risk, each a
   thin wrapper of an existing CLI verb + a matching test.
2. GAP-2/GAP-3 (benchmark + ensemble MCP tool/mode) — one shared MCP tool over
   `benchmark/` with a `mode: benchmark|rotate` switch + a rotate slash command.
3. GAP-14 CLI verb (optional), then document the GAP-8..13 exemptions in each
   command file + CLAUDE.md.
4. Decide + apply the `bin/llm-ext` catalog policy.
5. Doc fix D (with user confirmation for the user-global rule file).

## 3. Acceptance criteria
- [ ] Every GAP-4/GAP-7 function has a slash command + a passing wiring test.
- [ ] benchmark + ensemble-autoselect reachable as an MCP tool (or exemption
      documented in-file + CLAUDE.md).
- [ ] GAP-8..14 each carry an explicit "by-design slash-only" note OR are
      completed.
- [ ] `bin/llm-ext` catalog policy decided + applied/documented.
- [ ] Stale `set_settings`/`change_model` doc fixed (with user confirmation).
- [ ] Re-run the 3-surface audit → 0 unexplained gaps.

## 4. Status log

| Date | Status change | Note |
|---|---|---|
| 2026-05-24T01:49:50+0200 | created → not-started | Captured the 19 deferred gaps from the 3-surface audit so they survive the current release (which completes only GAP-1 cluster_synonyms + ships security_scan compliant). Dispositions: 2 need MCP design (benchmark/ensemble), 9 mechanical slash commands, 7 recommend-exempt orchestration, plus 2 doc/consistency fixes. |
