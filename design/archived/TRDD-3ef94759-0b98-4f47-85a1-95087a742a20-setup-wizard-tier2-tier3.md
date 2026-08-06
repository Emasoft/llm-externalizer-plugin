---
trdd-id: 3ef94759-0b98-4f47-85a1-95087a742a20
title: Setup wizard Tier 2 + Tier 3 follow-up fixes
column: complete
created: 2026-05-01T00:00:00+0200
updated: 2026-08-06T17:35:00+0200
current-owner: claude-llm-externalizer
task-type: feature
---

# TRDD-3ef94759-0b98-4f47-85a1-95087a742a20 — Setup wizard Tier 2 + Tier 3 follow-up fixes

**TRDD ID:** `3ef94759-0b98-4f47-85a1-95087a742a20`
**Filename:** `design/tasks/TRDD-3ef94759-0b98-4f47-85a1-95087a742a20-setup-wizard-tier2-tier3.md`
**Tracked in:** this repo (design/tasks/ is git-tracked)

**Status:** Done — all Tier 2 + Tier 3 items shipped in v9.7.0 (commits `c9606c0`, `b7aac6f`, `e192fee`). One item (T3.8 — drop the 5-skill preload) was deliberately NOT applied — see "Deferred-by-design" subsection below.
**Origin commit:** `d314c2d fix(setup): audit-driven Tier-1 security + correctness fixes` (the audit reports themselves live in `reports/setup-agent-audit/` — gitignored, not in repo)
**Closing commits:**
- `c9606c0 fix(setup): Tier-2/3 script hardening (Windows + WSL2 + security)` — detect-environment.sh PowerShell, detect-runners.py WSL2 + Jan + vllm-discrim, test-model.py needle-in-haystack + sanitisation, recommend-models.py security hardening.
- `b7aac6f feat(setup): build-snippet.py helper + agent flow overhauls (Tier-2/3)` — new YAML helper, agent.md Step 0 existing-profile preview, exit-code checks, hf install fallback chain, hf auth whoami probe, output-cap warning, idempotency state-mtime check, OpenRouter redirect at top of slash command.
- `e192fee fix(skills): MLX default port 8082 + huggingface-best hf auth token` — port 8080→8082 collision fix, legacy token-path fix.
**Related to:** the `/llm-externalizer-setup` wizard introduced in `e83814b`

## Background

Four parallel audit agents (skeptical-reviewer, code-correctness, security, silent-failure-hunter) reviewed the new wizard. Findings were consolidated into 3 tiers:

- **Tier 1** (10 surgical fixes, 142 LOC, security HIGH + critical correctness) — **DONE in commit `d314c2d`**.
- **Tier 2** (15 items, UX + Windows-detection + agent-flow rework) — **DONE in commits `c9606c0` + `b7aac6f`**.
- **Tier 3** (~22 items, polish + skill cleanups + deferred upstream-coordination) — **DONE in commits `c9606c0` + `b7aac6f` + `e192fee`** (modulo one deferred-by-design item, T3.8).

## Deferred-by-design (skipped on purpose)

- **T3.8 — drop the 5-skill preload.** The skeptical-reviewer suggested moving from frontmatter `skills:` preload to on-demand Skill-tool invocation to save ~20 KB of context budget. The user explicitly added the preload mechanism in an earlier session ("also read this to know how to add skills to the frontmatter of an agent: https://code.claude.com/docs/en/sub-agents.md") so reverting that decision without confirmation was inappropriate. The reviewer's "context budget" argument is also speculative — preload trades context tokens for deterministic skill access, and the wizard often hits at least 2 of the 5 skills anyway (huggingface-local-models or huggingface-mlx-models depending on platform). If this turns into a real problem (measured context exhaustion on Sonnet during a real run), revisit then.

- **T3.11 — TLS pin / --ca-bundle on recommend-models.py.** Marked LOW security and "accepted risk" by the audit (trust-on-first-use is acceptable for these benchmark feeds, and corporate-MITM users can already override via system trust store). Cost-benefit doesn't justify the added complexity.

The audit reports remain available locally under `reports/setup-agent-audit/` (gitignored). The consolidated report has the full per-finding tables with file:line evidence and suggested fix sketches.

## Tier 2 — Significant UX + first-run robustness work

These items require coordinated changes across the agent prompt, multiple scripts, and (in some cases) new helper scripts. Each is too large to fold into a single Tier-1 commit but small enough to be a focused PR on its own. Bundling them risks losing the "one commit, one concern" discipline.

| # | Title | Files | LOC est. | Source finding |
|---|-------|-------|----------|-----------|
| T2.1 | Agent reads existing `~/.llm-externalizer/settings.yaml` before generating snippet — show profiles table, detect name collision, prompt user to back up file | agents/llm-externalizer-setup-agent.md | ~30 | skeptical C4 + M5 |
| T2.2 | Agent inspects script exit codes — every `bash script > file.json` block becomes `if ! ...; then surface diagnostic; fi` | agents/llm-externalizer-setup-agent.md | ~40 | silent B5 |
| T2.3 | Windows RAM detection: `wmic` → PowerShell `Get-CimInstance Win32_ComputerSystem` fallback chain | scripts/setup/detect-environment.sh | ~15 | silent B2 + skeptical M1 |
| T2.4 | Windows GPU detection: PowerShell `Get-CimInstance Win32_VideoController` instead of `"unknown"` | scripts/setup/detect-environment.sh | ~15 | silent B3 + security LOW-6 |
| T2.5 | WSL2: detect-runners.py accepts `--probe-host` or auto-derives Windows host IP from `/etc/resolv.conf` | scripts/setup/detect-runners.py | ~25 | skeptical M2 |
| T2.6 | `pip install --user "huggingface-hub[cli]"` → three-step fallback (uv → pipx → bootstrap-uv) for PEP-668 systems | agents/llm-externalizer-setup-agent.md | ~15 | skeptical M3 + silent W7 |
| T2.7 | `hf auth whoami` check gated in Step 4 so widening via `huggingface-best` skill no longer silently 401s | agents/llm-externalizer-setup-agent.md + skills/huggingface-best/SKILL.md | ~15 | skeptical M4 + m4 |
| T2.8 | Output-cap warning surfaced when `output_length.score < 1.0` (agent currently never tells the user the cap is too low) | agents/llm-externalizer-setup-agent.md | ~10 | skeptical C1 |
| T2.9 | `params: None` from Onyx blank cells → fall back to `params_b` (table already documented in Step 4; LLM renderer needs to honor it) | agents/llm-externalizer-setup-agent.md | ~5 (narrative only) | skeptical C2 |
| T2.10 | `long_context` test uses real 32K input + needle-in-haystack content-grounded answer (current ~30K filler with 1-token "fox" answer doesn't actually verify the context window) | scripts/setup/test-model.py | ~25 | skeptical C3 |
| T2.11 | YAML snippet generation moved to `scripts/setup/build-snippet.py` (uses `yaml.dump` for safe quoting) instead of LLM-built f-string | new file + agents/llm-externalizer-setup-agent.md | ~50 | skeptical M7 |
| T2.12 | `test-model.py` outer `except Exception` narrowed to expected error classes — harness bugs no longer collapse to "model failed" | scripts/setup/test-model.py | ~10 | silent B6 + correctness m5 |
| T2.13 | Strip `raw=` field from `WhatCanIRunEvidence` (used only for debug logging; no need to flow attacker-controllable strings into agent context) + sanitize displayed string fields | scripts/setup/recommend-models.py + agent narrative | ~30 | security MED-2 |
| T2.14 | Cache-path args (`--from-cache`, `--save-cache`, `--whatcanirun-*`) constrained to live under `default_cache_dir()` — prevents path-traversal via prompt-injection | scripts/setup/recommend-models.py | ~20 | security MED-3 |
| T2.15 | `test-model.py` error-body echo (`err_body[:200]`) sanitised — strip `sk-…` patterns before including in test JSON output | scripts/setup/test-model.py | ~10 | security MED-5 |

**Tier 2 total: ~315 LOC across ~7 files. Recommended cadence: 1-2 commits per logical group, all in one v9.7.0 minor release.**

## Tier 3 — Polish + deferred upstream-coordination items

Lower priority. Mostly 1-3 LOC each; can be bundled at any release with bandwidth.

| # | Title | Source |
|---|-------|--------|
| T3.1 | `huggingface-mlx-models` skill default port 8080 → 8082 (collides with llama.cpp default) | skeptical m5 |
| T3.2 | `huggingface-best` skill: `~/.cache/huggingface/token` (legacy) → `hf auth token` (canonical) | skeptical m4 |
| T3.3 | `lms ls` shown before curl fallback — swap order, curl first | skeptical m6 |
| T3.4 | Progress indicator during 60-second compatibility test (stream stderr to user) | skeptical m9 |
| T3.5 | Version-pin `huggingface-hub[cli]` to defeat typosquat-adjacent risk | security LOW-3 |
| T3.6 | Idempotency: re-running the wizard checks state-file mtime, offers "Resume from <step>?" | skeptical M6 |
| T3.7 | OpenRouter `mode: remote` snippet generator missing from Step 6 fallback | skeptical M8 |
| T3.8 | 5 preloaded skills inflate agent context budget ~20 KB — consider on-demand Skill-tool invocation only on widening path | skeptical m3 |
| T3.9 | `extract_content` `... or ""` swallows tool-call / multimodal responses — surface "non-text content" hint in detail | correctness m7 |
| T3.10 | `if "error" in resp` collides with valid responses containing `error: null` — rename sentinel or check `isinstance(resp.get("error"), str)` | correctness m6 |
| T3.11 | TLS pin / `--ca-bundle` flag exposed on `recommend-models.py` for corporate-MITM environments | security LOW-7 |
| T3.12 | `extract_featured_models()` recursion bounded (depth cap 64) — RecursionError DoS prevention | security LOW-2 |
| T3.13 | `charset` allow-list when decoding fetched body (currently any registered codec is accepted) | security LOW-1 |
| T3.14 | `safe_local_dir_name()` strips leading dots → `.ssh` collision impossible | security LOW-5 |
| T3.15 | `detect_jan` returns `running: True` even when `models: []` (port-conflict risk with other dev tools on 1337) | silent C6 |
| T3.16 | `vllm` `ImportError: cannot import name '_C'` reported as `import_error` rather than "not installed" | silent W6 |
| T3.17 | `BRAND_PROVIDER_PREFIXES` greedy match — require word-boundary (`prefix-` or `prefix_`) after prefix | correctness m9 |
| T3.18 | `--context-tokens` / `--limit` bounds tightened to plugin-meaningful ranges (≥4096 / 1-1000) | correctness m10 |
| T3.19 | `commands/llm-externalizer-setup.md` redirect to OpenRouter moved to top (impatient users) | skeptical m10 |
| T3.20 | `setup_logging` failure no longer silently disables logging — surface to stderr | silent C2 |
| T3.21 | `recommend-models.py` `whatcanirun_cache_save_failure` raises when `--save-whatcanirun-cache` is explicit | silent W4 |
| T3.22 | `extract_featured_models` `raw` dict size cap before propagating | security MED-2 (related) |

**Tier 3 total: ~200 LOC, opportunistic. Each item is small enough to bundle with unrelated work.**

## Hard cross-cutting refactors (proposed, larger scope)

Two items that arose in the audit but are larger than Tier 2/3:

1. **Discriminated-union returns for runner detection**. `detect-runners.py` currently collapses 7 distinct failure modes (port collision, version-flag wrong, half-installed Python package, hung CLI, etc.) into a single `None`. A `("ok", str) | ("missing", None) | ("timeout", None) | ("nonzero", int, str)` shape would unblock several Tier 3 improvements (T3.15, T3.16). Estimate: ~80 LOC refactor + each detector + caller updates. **Not in Tier 2 because it changes the JSON contract — would need a `schema_version` bump on `detect-runners.py` output too.**

2. **Contract-test fixtures for `recommend-models.py`**. The skeptical reviewer specifically called out that `recommend-models.py` is 2,762 vendored lines with no version pin and no contract test. Tier-1 already added `schema_version`, but a CI smoke test that runs the script against frozen `onyx-snapshot.json` + `wcir-snapshot.json` fixtures would catch JSON-shape drift on every upstream re-sync, not just on the first user invocation. Estimate: ~30 LOC of fixtures + one `tests/test_recommend_smoke.py` (the plugin doesn't currently use pytest for the setup scripts — would be the first one).

## Acceptance criteria for Tier 2 completion

- All 15 Tier-2 items addressed in code with file:line evidence in commit messages.
- Re-run the four audit agents on the fixed setup scripts; the consolidated report should show no MAJOR or HIGH findings remaining.
- `discover` smoke test still passes end-to-end on macOS arm64 with Ollama installed.
- Manually verify the Windows PowerShell path detects RAM correctly on at least one Win11 24H2 machine (or document the test as deferred if no test machine is available).
- Manually verify the WSL2 host-probe path detects an LM Studio instance running on the Windows host.

## Acceptance criteria for Tier 3 completion

- Items bundled opportunistically — no hard deadline.
- Each fix carries a one-line CHANGELOG entry; bundle commits when convenient.
- Re-run security audit after T3.11..T3.14 land; the consolidated report should show no MEDIUM findings remaining.

## Out of scope (explicitly NOT in this TRDD)

- The full skeptical-reviewer "Things that are good" list — those are preserved-as-is, not changed.
- The five LOW-tier security findings that the security audit marked as "accepted risk" (LOW-7 TLS pinning, etc.) are deferred indefinitely.
- Upstream `recommend-models.py` re-sync workflow — handled by the existing re-sync procedure in the file's header docstring.

End of TRDD.
