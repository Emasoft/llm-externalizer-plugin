---
trdd-id: FKAR9VPK
title: scouting profile and scout-accuracy benchmark for mass-scouting
column: complete
status: archived
created: 2026-10-01T18:16:37+0200
updated: 2026-10-01T20:19:56+0200
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-10-01T18:16:37+0200
---

# scouting profile and scout-accuracy benchmark for mass-scouting

# scouting profile and scout-accuracy benchmark for mass-scouting

USER directive 2026-10-01: update the mass-scouting benchmarks to be more accurate, and require a special profile called 'scouting' with only ultra-cheap models with high accuracy on small context sizes, as needed by mass scouting to survey thousands of files.

## Design (proposal v3 — 2 review rounds + MEASURE 6/6, all findings accepted)

1. BENCHMARK: llm-ext benchmark scout-accuracy. Candidates = paid catalog models under a scouting price ceiling (withinPriceCeiling machinery, cost-ascending; spend backstop), stop at 3 survivors. Fixture: synthetic skill-file frontmatter -> known-good extracted records, positional JSON-Schema method (NO fieldset repair) lifted from calibrate-payload-size.test.ts into a shared non-test module. Accuracy threshold + target size = settings-tunable (paid_benchmark_daily_cap_usd getter pattern, DEFAULT_SCOUT_ACCURACY_* consts). Zero survivors: exit prints best accuracy per candidate for retuning.
2. LEDGER: OWN file (NOT security-triage-results.json — MEASURE A2: every triage reader discards datasetHash; a shared file would poison free-rotation and serving gates). Key modelId::date::hash where hash covers fixture version + threshold + target size (review F-2).
3. PROFILE: scouting = STATIC, written only by scout-accuracy via addProfileToSettings (refuse-guards dynamic names already; statics untouchable by maintainer engines by design — MEASURE A1). model = cheapest accurate survivor; paid_models = survivors as chain; OpenRouter api/url/api_key; never ':free'.
4. REQUIRE GATE: at the verified shared chokepoint (enumerate all resolveCliModel callers FIRST — MEASURE A5: five sites incl. register/estimate). Gate the three LLM-driving sub-commands (scout/chain/propose-fieldset); register/estimate keep working without the profile. --model: hard-gated on the scout-accuracy PASSED set, with a documented forced opt-in flag for untested ids (review F-4); refusal states benchmark coverage. Scouting head passes the SAME PASSED-set check (review F-5). Free-profile refusal unchanged.
5. tool_models.mass_scout: stays written by the paid maintainer; mass-scout CLI no longer consults profile heads; EVERY reader surface stamped (review F-6).

Breaking change: existing mass-scout invocations refuse until scout-accuracy builds the profile. Migration = refuse-with-instruction, no auto-benchmark spend.

Out of scope: HBCCFOUF (high_quality_scan free-profile benchmark); changes to free/paid/local.

## Approval log

- 2026-10-01T18:16:37+0200 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-01T18:16:59+0200 — column → todo. USER directive received 2026-10-01; proposal v3 reviewed (2 rounds) + MEASURE 6/6; D7 queued behind this slice
- 2026-10-01T20:19:56+0200 — COMPLETE by main-agent@llm-externalizer-plugin. implemented 3b81290, all gates verified, adversarial round accepted with disposition.

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-10-01T18:36:55+0200

CARD-REVIEW dispositioned 2026-10-01, zero rejected — 5 fidelity lines added to the design (these are agent-authored defaults riding the USER directive, not directive-mandated content): (1) forced opt-in flag = per-invocation --allow-untested-model; a model passed through it still must clear the schema-compliance gate (the benchmark's own requireSchema check), and its use is stamped in the command output; (2) spend backstop = the EXISTING paid_benchmark_daily_cap_usd gate applies as-is — scout-accuracy is a paid benchmark and mints NO second cap key; (3) the resolveCliModel caller enumeration MUST be re-verified at brief time (tree may have drifted since MEASURE A5) — it is a brief step, not an assumption; (4) threshold-in-hash semantics pinned: retuning threshold (or fixture version or target size) changes the datasetHash, so the next scout-accuracy run re-probes every candidate — prior verdicts are intentionally invalidated by retune; (5) the zero-survivor diagnostic prints best accuracy per candidate so the user can retune knowing the re-probe cost. NEXT: write the worker brief from the card, review it, dispatch.
CURE-ROUND REVIEW (post-fcd32de) dispositioned 2026-10-01, zero rejected: (1) heading DEVIATION RECORDED — this STATE block sits at FILE END (trddgrep --create appends; moving it above the title needs an edit this card does not need), missing the ⏵ glyph and trailing date; the brief-writer MUST read the WHOLE card, not stop at the Design section; (2) verification-narrative correction accepted: the pre-commit check was ONE alternation grep (line count 2), not per-phrase proof — content presence rests on trddgrep write validation + the 5-insertion diff bound + the transcript; the D7-era standard is the D6b terminal pattern (head+tail read of the exact appended line), never an alternation grep; (3) all five cures verified drift-free against the card review. Card is a sound brief source. NEXT: write the worker brief from the card, review it, dispatch.
DISPOSITION-ROUND REVIEW (post-69c2df8) dispositioned 2026-10-01, zero rejected, THREE residuals adopted into the brief-writing round's own course of work (no tenth card round): (1) FIX-FORWARD SCHEDULED — the STATE heading gains the ⏵ glyph + trailing date at the next content-touching append (lint was run: the dateless heading is NOT validator-visible today, so recording suffices until then); (2) the verification-pattern correction is ACCEPTED AS STATED — this round's pre-commit check was a tail-region slice, NOT the head+tail pattern it adopted; the honest wording stands corrected on this card, and the brief-writing round MUST actually run head+tail (this round did: head 400 + tail 200 on the card before this append); (3) attribution correction: 'five cures verified drift-free' was the PRIOR round's zero-tool-call verification against the transcript, not this round's independent re-derivation — recorded as such. Also adopted: the brief itself carries a top-pointer requirement — when the D7-era tooling allows placing text at card top, add 'STATE block at file end — read it first'. NEXT: write the worker brief from the card, review it, dispatch.
REVIEW CHAIN TERMINATED 2026-10-01 (residuals-round reviewer verdict, accepted): the card is a sound brief source; no further card rounds; next adversarial attention = the worker brief. OPERATIVE RULES for the brief-writer (ignore process archaeology beyond these): (1) re-verify the resolveCliModel caller enumeration at brief time; (2) verify appends by head+tail read of the exact appended line; (3) the brief carries design facts, not review-chain retelling. NEXT ACTION: write the worker brief from the Design section, review it, dispatch the worker.
DISPATCHED 2026-10-01: brief finalized at docs_dev/20261001-fkar9vpk-brief.md (8 review amendments A1-A8 ALL ACCEPTED and folded in — per-model size clamp via bytesCapFromPct with skip-not-fail for too-small contexts; new resolveScoutModel gated resolver, resolveCliModel untouched; complete D5 decision tree; --allow-untested-model = structural schema probe, per-invocation grant, inconclusive ledger row, disclosed cost; full-suite two-leg gate restored; fixture record floor 40; passedModelIds filters current hash; replace prints previous model). Worker dispatched in background. On its report: coordinator verifies all gates independently (tsc/eslint/NUL/both legs/red-proofs/dist), then adversarial review round on brief+result, then disposition and commit. NEXT: await worker notification.
COORDINATOR VERIFIED + ADVERSARIAL ROUND ACCEPTED 2026-10-01: all gates independently re-run (tsc 0, eslint 0, both legs 3069 passed/5 skipped/0 failed, NUL clean on touched files, dist confined to benchmark.js+llm-ext.js). Gate wiring verified at exactly 3 resolveScoutModel sites (:1005/:1344/:1702), resolveCliModel only :797/:905 + :602 free_only delegation, FREE_FORBIDDEN_TOOLS untouched, OWN ledger file confirmed. Review verdict ACCEPT-WITH-FINDINGS — disposition: F1 verdict-aging CONFIRMED REAL but design-level (approved design = retune-invalidation; date is bookkeeping) -> spun to follow-up TRDD; F2 non-resolver model paths REFUTED by code (runScoutJob has exactly 2 live call sites, cli.ts:1050+cli.ts:1801, both behind resolveScoutModel; MCP tools route through the gated handlers); F3 gate-probe spend uncapped ACCEPTED as known ceiling (one disclosed fixture-sized call per invocation); F4 profile round-trip PARTIALLY COVERED (the D2 test writes via the real addProfileToSettings path and asserts the exact keys the gate reads); F5 dispatch fitness REFUTED (scout.ts:259 clamps to the model's own pricing.context_window, over-cap files skipped with reason); F6 breaking-change note goes in the commit message; F7/F8 known ceilings already documented in the ledger header. NEXT: commit the slice, then move card to complete.

## Acceptance checklist

- [x] D1-D6 implemented and gate-verified (tsc 0, eslint 0, both legs 3069/5/0, NUL clean, dist confined, red-proofs a/b/c); D5 gate at exactly 3 resolveScoutModel sites
- [x] Adversarial review ACCEPT-WITH-FINDINGS, all findings dispositioned (F1 -> TRDD-IQ6EHUUW)
