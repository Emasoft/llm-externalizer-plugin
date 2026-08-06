---
trdd-id: 8de4e9f2-2cb9-44f4-bc80-95dcb5d758ad
title: URGENT — Codex externalization feature security review re reported Codex-poisons-Claude-Code-plugins threat
column: superseded
created: 2026-05-31T21:49:14+0200
updated: 2026-08-06T17:35:00+0200
superseded-by: [TRDD-1e2b87cb]
---

> **SUPERSEDED by TRDD-1e2b87cb** (remove-codex-integration). This triage had the
> threat mechanism WRONG — it claimed the default codex sandbox was read-only, but
> the runner actually invokes `codex --dangerously-bypass-approvals-and-sandbox`,
> and the real reported harm is codex clobbering `CLAUDE_PLUGIN_DATA` (breaking all
> CC plugins) plus writing `~/.codex/config.toml`. The user ordered outright
> removal; see TRDD-1e2b87cb for the authoritative plan.

# TRDD-8de4e9f2 — Codex externalization security review (poisoning threat)

**Filename:** `design/tasks/TRDD-20260531_214914+0200-8de4e9f2-codex-poisoning-threat.md`
**Tracked in:** `Emasoft/llm-externalizer-plugin` (this repo)

## User report (verbatim, 2026-05-31)

> "did you implemented the option to externalize to codex by any chance?
> because it is now known to poison claude code plugins"

URGENT triage requested. This TRDD records what the plugin actually ships and a
verified read of its security posture, so a fix/removal decision can be made.

## Q1: Does the plugin ship a Codex externalization feature? — YES (pre-existing)

NOT authored in the current session. Inventory (verified on disk):

- `commands/llm-externalizer-codex-scan.md` — slash command `/llm-externalizer-codex-scan`.
- `skills/llm-externalizer-codex-scan/SKILL.md` — the skill.
- `scripts/codex/run-codex-scan.py` — the runner (the actual integration).
- `scripts/codex/codex-scan-prompt.txt`, `codex-scan-prompts.md` — prompt bodies.
- `tests/test_run_codex_scan.py` — tests.
- `design/tasks/TRDD-807c1e2d-…-codex-gpt55-scan-integration.md` — original design TRDD.
- Referenced in README.md, CHANGELOG.md, `tests/dogfood/dogfood_test.py`,
  `docs/openrouter/responses-api.md`.

It is **one of the 36 slash commands / part of the 9-command three-surface work**
(TRDD-a24b213c called it "GAP-8: wraps external `codex` CLI").

## Q2: What does it actually do? (verified by reading the runner)

`scripts/codex/run-codex-scan.py` invokes the **codex CLI** as a subprocess:

- `build_codex_command` (line 109): builds `codex exec <flags> <prompt>` —
  non-interactive.
- **Defaults (parse_args, line 426):**
  - `--sandbox read-only` (choices also allow `workspace-write`,
    `danger-full-access`) — **read-only is the default.**
  - `--approval never`
  - `--model gpt-5-codex`
  - `--timeout 1800`
- `run_codex` (line 196): `subprocess.Popen`, streams stdout/stderr via reader
  threads, captures stdout into a report string.
- `main` (line 616-622): redacts, then **writes the captured codex output to a
  timestamped report .md and nothing else.** Inline comment line 616-617:
  *"The report is the ONLY artifact; nothing codex emits is executed or applied
  to the repo."*
- The slash command (`commands/llm-externalizer-codex-scan.md`) is `allowed-tools:
  Bash(*/scripts/codex/run-codex-scan.py *)` + `Read`, runs it via
  `uv run "$CLAUDE_PLUGIN_ROOT/scripts/codex/run-codex-scan.py" --paths …`, and
  instructs the agent NOT to read the whole report into context unless asked.

### Posture assessment — defensively reasonable BY DEFAULT
- Default run is **read-only sandboxed** → codex cannot write/mutate the repo.
- Codex output is **passive** (report file only) → not executed, not applied,
  not auto-fed back to an agent that acts on it.
- The command tells the agent not to slurp the report into context by default,
  reducing indirect-prompt-injection-into-Claude surface.

## Q3: Residual exposure surfaces (the real review targets)

Even with safe defaults, the runner EXPOSES escape hatches and there is a
broader threat-intel angle the code alone can't answer:

1. **`--sandbox danger-full-access` / `workspace-write`** are selectable. If a
   caller (or a chained agent, or a future skill edit) passes these, codex can
   write the repo / escape the sandbox. Should the plugin even offer
   `danger-full-access`? Likely remove that choice entirely.
2. **`--full-auto`** runs codex without approval prompts. Combined with a
   non-read-only sandbox this is autonomous write. Audit whether anything in the
   plugin ever passes it.
3. **`--extra-codex-args` pass-through** forwards arbitrary flags to `codex exec`
   verbatim — an unbounded escalation channel (could re-enable network, raise
   sandbox, etc.). Needs an allowlist or removal.
4. **Indirect prompt injection via scanned content → codex → report → Claude.**
   Scanned files are untrusted; codex summarizes them into a report; if an agent
   later reads that report, attacker-controlled text in a scanned file can carry
   instructions. Mitigated today (read-only + "don't read report by default")
   but NOT eliminated. Same class the security_scan hardening (issues #7/#9)
   addressed for the ensemble path — codex-scan never got that treatment.
5. **Supply-chain / codex-CLI-itself threat (the user's actual concern).** "Codex
   is now known to poison Claude Code plugins" is a CURRENT external threat
   report I cannot verify from this repo. Possible meanings to run down:
   - The `codex` binary or its npm/distribution chain is compromised.
   - Codex `exec` has a known sandbox-escape / approval-bypass CVE.
   - Codex writes to `~/.codex` / global config / MCP registration that affects
     Claude Code's plugin trust.
   - A poisoned codex output pattern that specifically targets CC plugin loaders.
   ACTION: fetch the actual advisory/source before deciding (the user has it).

## Decision needed (not taken — this is document-only triage)

Options, in increasing severity:
- **(A) Harden:** drop `danger-full-access` from choices, allowlist/remove
  `--extra-codex-args`, force read-only + approval=never, never auto-read the
  report, add an explicit "untrusted scanned content" framing to the codex
  prompt (mirror security_scan #7/#9). Keep the feature.
- **(B) Gate behind opt-in env:** disable codex-scan unless an explicit
  `LLM_EXT_ENABLE_CODEX=1` is set, so it can't fire by default.
- **(C) Remove entirely:** delete the command + skill + runner + prompts + tests
  + README/CHANGELOG references + dogfood rows; supersede TRDD-807c1e2d. The
  nuclear option if the threat is the codex CLI/supply-chain itself rather than
  this wrapper's flags.

Recommendation pending the actual advisory (item 5). If the threat is the codex
CLI/distribution itself → (C). If it's misuse of escape-hatch flags → (A)+(B).

## Files in scope for any fix/removal

```
commands/llm-externalizer-codex-scan.md
skills/llm-externalizer-codex-scan/SKILL.md   (+ references/ if any)
scripts/codex/run-codex-scan.py
scripts/codex/codex-scan-prompt.txt
scripts/codex/codex-scan-prompts.md
tests/test_run_codex_scan.py
tests/dogfood/dogfood_test.py                 (codex rows)
README.md / CHANGELOG.md                       (codex references)
design/tasks/TRDD-807c1e2d-…-codex-gpt55-scan-integration.md  (supersede if removed)
mcp-server/package.json / bin                  (verify no codex bin wiring — none found)
```

## What I did NOT do

- Did NOT change, disable, or remove any codex code (document-only, per the
  pattern; awaiting the user's advisory + decision on A/B/C).
- Did NOT fetch the external "codex poisons CC plugins" advisory yet — the user
  has the context; will retrieve on request.
- Did NOT run codex.

## Status log

- 2026-05-31 21:49 — URGENT triage TRDD authored. Confirmed the codex-scan
  feature exists (pre-session), read the runner: safe-by-default (read-only
  sandbox, output-only-to-report, nothing executed) but with escape-hatch flags
  (danger-full-access / full-auto / extra-codex-args) and an unhardened
  indirect-injection path. Awaiting the actual threat advisory to choose
  Harden (A) / Opt-in-gate (B) / Remove (C).
