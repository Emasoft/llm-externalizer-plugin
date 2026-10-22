---
trdd-id: FDI9NYAS
title: D3b and D3c profile provenance and eligibility gates for auto picked models
column: complete
created: 2026-09-23T11:19:27+0200
updated: 2026-10-04T12:35:03+0200
current-owner: agent
created-by: user
task-type: feature
min-approval-requirement: none
assignee: agent
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-09-23T11:19:27+0200
implementation-commits: [59ba935, da3a18b, 6d9fffe]
status: archived
---

# D3b and D3c profile provenance and eligibility gates for auto picked models

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-24
D3b COMMITTED 59ba935: ResolvedProfile.manualModels (static profiles = chainModelIds, dynamic = empty), ProviderDeps.isManualModel, the benchmark gate at provider/connection.ts skips manual models only; free_only cost-safety stays independent of provenance; second_model and third_model allowed in every mode on static profiles; reconcile never rewrites a static profile (a missing isStatic guard fixed). Full suite 2954 passed, 5 skipped, 0 failed on three env legs after a fresh build.
D3c-1 COMMITTED da3a18b: a recorded benchmark pass is required before an auto-picked free model is served on the reconcile write path and the live rotation and ensemble send paths (manual ids exempt); send-time price check for auto-picked paid models (input and output each at or under the ceiling), failing closed when the cached price is missing; a price refusal is a deterministic skip to the next chain entry (no same-model retry, no circuit-breaker count — the first version retried three times and tripped a 60 s breaker sleep, caught by the full-suite measure). Full suite 2967 passed, 5 skipped, 0 failed on three env legs after a fresh build.
Correction to the D3b line above: 4 of its 6 new tests fail by a failed assertion on the code before D3b (9409c9c, the base the D3b red proof ran against; the commit in between, 6a6301f, changes only task cards); the other 2 fail only because the new field is missing there (import-level, not behavioural evidence).
D3c-1b COMMITTED 6d9fffe: an unpopulated dynamic free profile serves only catalog ids with a recorded benchmark pass (plus the b.ai reserved slot, still exempt); every catalog id is still queued for its first benchmark; an empty pool is never served, the gate refuses with the retry-later reason (empty-pool-refreshable). Coordinator re-run with the temp folder under /private/tmp: typecheck and lint clean; the 10 core test files 572/572 on three env setups, fresh temp folder each (the two setups without API keys ran before dist/ was rebuilt, so their CLI-launching tests ran the old build); after rebuilding dist/ from 6d9fffe's source (build not committed), npm test: 189 test files passed, 4 skipped; 2971 tests passed, 5 skipped, 0 failed; exit 0, at load average 200 to 267 (one shared config folder for the whole run).
Corrections to the 6d9fffe commit message (history not rewritten): its subject says "benchmark-passed models" but the b.ai slot stays exempt; its full-suite line (2969 passed, 2 timeouts) ran against a dist/ built before D3c-1b, and its "load average 236" was sampled near that run, not during it; its "13 test files that spawn the built CLI" missed tests that launch the CLI through test-helpers.ts (CLI_SCRIPT, runCli); its "80 tests fail on the previous commit too" came from a git-archive copy of da3a18b that launches the stale committed dist/ (last committed 2026-09-17), so that count is approximate and the pre-existing claim rests on the mechanism (config.ts's guard and the tests' os.tmpdir() use are unchanged by 6d9fffe). A dispatch-reload failure seen on that copy most likely has the same cause (CLI_SCRIPT points at dist/) and is no evidence against D3c-1. The full-suite run in the D3c-1b line supersedes these.
OPEN USER DECISION (asked 2026-09-24, unanswered): the b.ai reserved slot (baiModels[0], picked by code, not typed by the user) stays exempt from the benchmark requirement until D5; the configuration guide documents it as temporary. Gating it now would leave b.ai-only machines with no free model.
NEXT: none for D3c-2 — COMMITTED 96a03d7: certain-402 rows record no ledger verdict (paymentErrorCertainty moved to the benchmark/free-mode.ts leaf, four consumers updated; a validated->free-rotation import would close the cycle free-rotation->security-triage->validated); the paid populate arm keeps previously-written paid_models ids that hit a certain 402 at their previous relative order, model/second/third stay benchmark picks; retry-later wording states the actual backoff (15 min-24 h) or the scheduled retry time instead of "will be finished soon" (DS6OM3KX worker default); C4d landed: _activeFreeOnly starts UNSET and getActiveFreeOnly() returns true when unset (fail CLOSED before the first publisher), resetActiveFreeOnlyForTests added, the one pre-existing fail-open-reliant test (security-triage free-mode) now publishes the flag like a real caller. Gates: tsc 0, eslint 0, NUL 0 on 13 files, red on HEAD x3, full suite 2973 passed / 5 skipped / 0 failed on three env legs; coordinator re-ran tsc/lint/NUL + the three touched test files (214/214). Report: reports/llm-ext-release-1410/20260926_052223+0200-d3c2-impl.md. NEXT: card complete — FDI9NYAS scope D3b+D3c+C4d all landed (D3b 59ba935, D3c-1 da3a18b, D3c-1b 6d9fffe, D3c-2 96a03d7); the open b.ai-exemption USER decision from 2026-09-24 rides with D5 (TRDD-90DM5YHO).

## Approval log

- 2026-09-23T11:19:27+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-04T12:35:03+0200 — COMPLETE by main-agent@llm-externalizer-plugin. D3b 59ba935 + D3c-1 da3a18b + D3c-1b 6d9fffe + D3c-2 96a03d7 + C4d all landed, full suites green on three env legs per card STATE; b.ai-exemption USER decision resolved (USER continue 2026-09-27, recorded on 90DM5YHO D5).

## Scope

Slice D3b (release plan item 3): static profiles = manual + provenance. manualModels and isManualModel wired at connection.ts around line 76. No reconcile rewrite of static profiles. Static free_only keeps the listed order unfiltered and unranked. second_model and third_model honored in every mode. Spec: 20260918_182438+0200-profile-yaml-design.md section 6 D3b, section 2.1, section 2.4.
Slice D3c (release plan item 4): dynamic eligibility. filterFreeModels needs a recorded pass; no provisional catalog pool is ever served, INCLUDING the background detector childs maintainer pass (after the D2 slice it is the only writer - coordinate with TRDD-OE27RD7I, which owns that maintainer). Send-time price check for auto-picked paid models, cold cache fails closed. Context-less senders. D2 item 9: a certain 402 must not record a fail verdict, see the D2 report section Item 9 for the proposal. Revisit the retry-later wording (will finish soon versus the real 10 to 40 minute benchmark duration, and the 15 minute to 24 hour backoff deferral) - see TRDD-DS6OM3KX Coordinator and worker defaults section for the exact fix required.
C4d (plan item 10, folded into this slice): free_only chokepoint fails closed before settings load; run the full suite on a quiet tree to prove it.
Order: after D0, before D6a (design section 6). See TRDD-DS6OM3KX for the USER decisions and accepted schema this slice implements.

## Moved fix-queue rows (D3c-2 adversarial review 2026-09-26 — rows relocated to TRDD-90DM5YHO)

F1+F5 (MAJOR+NIT, review of 96a03d7): MOVED to TRDD-90DM5YHO (D4's scope card - the fix files are benchmark/validated.ts and benchmark/index.ts, NOT this card's neighborhood; the review of the move accepted the routing correction F-A). With the row moved, the STATE block's 'card complete' claim is true again (F-B resolved).

## Acceptance

- [x] D3b static provenance: manualModels/isManualModel wired, reconcile never rewrites static profiles (59ba935; full suite 2954/5/0 three legs)
- [x] D3c-1 benchmark-pass gate + send-time price check, failing closed (da3a18b; 2967/5/0 three legs)
- [x] D3c-1b unpopulated free profile serves only benchmark-passed catalog ids (6d9fffe; 2971/5/0 three legs)
- [x] D3c-2 certain-402 no-verdict + retry-later wording + C4d fail-closed activeFreeOnly (96a03d7; 2973/5/0 three legs)
