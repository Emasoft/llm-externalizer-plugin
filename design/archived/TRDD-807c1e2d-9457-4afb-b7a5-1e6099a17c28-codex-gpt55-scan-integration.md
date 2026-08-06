---
trdd-id: 807c1e2d-9457-4afb-b7a5-1e6099a17c28
title: Codex/GPT-5.5 scan integration
column: cancelled
created: 2026-05-14T00:00:00+0200
updated: 2026-08-06T17:35:00+0200
current-owner: claude-llm-externalizer
task-type: feature
---

# TRDD-807c1e2d-9457-4afb-b7a5-1e6099a17c28 — Codex/GPT-5.5 scan integration

**TRDD ID:** `807c1e2d-9457-4afb-b7a5-1e6099a17c28`
**Filename:** `design/tasks/TRDD-807c1e2d-9457-4afb-b7a5-1e6099a17c28-codex-gpt55-scan-integration.md`
**Tracked in:** this repo (design/tasks/ is git-tracked)

**Status:** Open — MVP shipped, refinements ongoing.

**Origin:** User request (2026-05-14): integrate / rewrite the local
`review-loop-opus` plugin into llm-externalizer with these constraints:
- Externalize SCANS to OpenAI GPT-5.5 via the Codex CLI (a different
  externalization target than local models or OpenRouter)
- Fall back to Opus subagents when GPT-5.5 hits rate / token limits
- Add the "loop until all bugs are fixed" workflow as a first-class
  option
- Match llm-externalizer's existing usage patterns where possible
- BUT — preserve GPT-5.5 prompt calibration. The Codex prompts in
  `review-loop-opus` are tuned for the OpenAI model's response style
  and must NOT be reworded to match the OpenRouter ensemble prompts.

## Source plugin reviewed

Path: `~/Code/review-loop-opus` (local marketplace,
not on GitHub — installed via `claude plugin marketplace add <path>`).

Architecture summary:
- **Stop hook lifecycle** with two phases: `task` → `addressing`.
- **State file**: `.claude/review-loop.local.md` (YAML frontmatter +
  task description).
- **Runner selectable**: `codex` (external CLI, multi-agent) OR
  `opus-agents` (Claude's Agent tool, default in this fork).
- **Single consolidated review output**: `reviews/review-<id>.md`.
- **Four review angles**: Diff (uncommitted+recent), Holistic (whole
  project), Next.js (conditional), UX (conditional).
- **2-retry fail-open** if review file doesn't appear.

## Evaluation — what's sub-optimal vs llm-externalizer

| Aspect | review-loop-opus | llm-externalizer |
|--------|------------------|------------------|
| Trigger | Stop hook (agent exit) | On-demand (slash command + skill) |
| Scope | Whole-project review | Per-file or per-batch scan |
| Output | Single consolidated `.md` | Per-file or merged reports |
| Granularity | 4 fixed review angles | FFD bin-packing into LLM batches |
| Fix loop | Manual (Claude reads review, applies fixes) | Has parallel-fixer agents |
| Ensemble | No — single LLM | Optional — 3-model parallel review |
| Cross-project | No — project-local state | Works from anywhere |
| Migration | Designed for "review my recent changes" | Designed for "scan these specific files" |

Key insight: review-loop-opus is a **review-after-task** tool. llm-externalizer
is a **scan-on-demand** tool. The user wants the SCAN model with Codex/GPT-5.5
as a new backend, not the review-after-task model.

## Design — chosen path

**Approach: hybrid rewrite, not direct integration.**

1. Build a NEW slash command + skill that:
   - Matches llm-externalizer's command surface (`scan a folder`, file
     paths, optional gitignore + extension filters)
   - Uses Codex CLI as the LLM backend (executes `codex exec` instead
     of going through the MCP server)
   - Detects rate-limit / token-limit responses from Codex and
     transparently falls back to Opus subagents (replicating the
     review-loop-opus `--runner=opus-agents` semantics, but on a
     per-batch basis, not per-session)
   - Writes per-file reports under
     `$MAIN_ROOT/reports/llm-externalizer/codex-*.md` matching the
     existing scan_folder report format, so the existing parallel /
     serial fixer agents work unchanged on the output
   - Has an optional `--fix-loop` flag that runs:
     scan → dispatch parallel-fixer → re-scan → repeat until 0
     findings or N iterations

2. PRESERVE GPT-5.5 prompt calibration:
   - The prompts SENT TO Codex/GPT-5.5 are written for OpenAI's
     response style (terse, structured, code-block-heavy) — NOT
     reused from the OpenRouter ensemble prompts.
   - For Opus fallback, ALSO use the OpenAI-calibrated prompts (Opus
     is robust enough to handle them; the goal is fallback continuity).

3. Reuse review-loop-opus's:
   - Codex install + multi_agent config check
   - Bash sniffing for `codex` binary on PATH
   - The `--dangerously-bypass-approvals-and-sandbox` invocation
   - Logging conventions to `.claude/llm-externalizer-codex.log`

4. Drop review-loop-opus's:
   - Stop hook → on-demand command instead
   - Two-phase lifecycle → single command execution
   - State file → no persistent state required
   - Single consolidated review → per-file reports instead
   - 4 fixed review angles → per-file batched scan with a single
     unified prompt

## Components delivered (MVP — phase 1)

| File | Purpose |
|------|---------|
| `commands/llm-externalizer-codex-scan.md` | Slash command surface |
| `skills/llm-externalizer-codex-scan/SKILL.md` | Skill autodiscovery |
| `scripts/codex/run-codex-scan.py` | Wrapper around `codex exec` with rate-limit detection + Opus fallback |
| `scripts/codex/codex-scan-prompts.md` | The GPT-5.5-calibrated prompt templates (preserved as-is for OpenAI tuning) |

## Components deferred (phase 2 — separate PR)

- `--fix-loop` flag that chains scan → fix → re-scan
- Cost tracking + cap (Codex doesn't expose token counts directly;
  need to parse from the streamed output)
- Integration with the MCP server so `scan_folder` can ALSO accept a
  `backend: "codex"` option (more invasive — phase 2)
- CI matrix that tests Codex install detection on macOS + Linux + WSL2

## Open design questions

1. **Per-file vs per-batch?** llm-externalizer's `scan_folder` does
   FFD bin packing into 400 KB batches. Codex is ONE LLM call with a
   prompt — does it natively handle multi-file context, or do we need
   to batch ourselves and run multiple `codex exec` invocations?
   - Decision: batch ourselves. Pass each batch as a separate
     `codex exec` invocation. Output one report per batch (matching
     llm-externalizer's existing per-file/per-batch report model).
   - Rationale: Codex sessions are stateful and a single session
     can hit context-window limits on a large codebase. Per-batch
     keeps each invocation bounded.

2. **Rate-limit detection mechanism?** Codex returns a non-zero exit
   on rate-limit with a specific stderr pattern. We need to detect
   this WITHOUT being fragile to Codex CLI updates.
   - Decision: parse stderr for known patterns: "rate limit", "quota
     exceeded", "429", "token limit reached". Fall back to Opus on
     match.

3. **What's the Opus fallback granularity?** Per-batch (retry the
   one batch on Opus) or per-session (give up on Codex entirely,
   re-run everything on Opus)?
   - Decision: per-batch. If batch 7 of 20 hits rate-limit, batches
     8-20 also fall back to Opus (since the rate-limit window is
     usually long enough that retrying Codex is futile). Batches
     1-6 stay as Codex results — no rework.

## Acceptance criteria for the MVP

- `codex` not on PATH → command fails with installation instructions
- `codex` present but `multi_agent` not in config → command sets it up
  (matching review-loop-opus's behaviour)
- Per-batch reports land at `$MAIN_ROOT/reports/llm-externalizer/codex-*.md`
- Rate-limit response → Opus fallback for remaining batches, NOT
  abort the whole scan
- Reports are consumable by the existing parallel-fixer agents
  without modification
- README documents the new command alongside the existing scan tools

## Acceptance criteria for phase 2

- `--fix-loop N` flag chains scan + fix + scan up to N times
- Loop terminates on: 0 findings, MAX_ITERATIONS hit, or user
  interrupt
- Each loop iteration produces a separate report directory so the
  user can audit the trajectory
- Cost tracking emits a summary table at end of loop

## Notes

- The user's marketplace plugin is local-only (`~/Code/review-loop-opus`),
  no GitHub repo. Do not assume it's installable from a public marketplace.
- Per the cross-project rule, we do not modify review-loop-opus
  directly — we read its files for reference only.
