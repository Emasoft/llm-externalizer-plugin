---
trdd-id: 6HGJFPDR
title: Latent ordering floor — a classifier-named model becomes selectable when the free pool is short
column: complete
created: 2026-08-29T15:21:08+0200
updated: 2026-08-29T23:33:00+0200
current-owner: llm-externalizer-session
task-type: bugfix
min-approval-requirement: none
relevant-rules: []
---

# TRDD-6HGJFPDR — the classifier ordering floor

Carried out of [[TRDD-V32LB992]] as its one surviving unbuilt box, so that a
real mechanism with no live trigger stops riding on a card whose own defect is
fixed and closed. It is filed at `backburner` deliberately: **deferred, not
stalled** — there is nothing to drain here until the trigger condition exists.

## The mechanism

`rankFreeModelsByBenchEvidence` **orders** the pool; it does not **exclude**
from it. `looksLikeClassifier` is a name-substring clamp that pushes a
classifier-named id to the bottom of the ranking. Ordering runs out: once the
list is short enough that selection reaches the bottom, "last" and "selected"
are the same position.

## What was measured (in V32LB992, not re-measured here)

- At pool size 3, a classifier-named id **IS** selected (§3e.5).
- The LIVE pool is 18, and `nvidia/nemotron-3.5-content-safety:free` ranks
  dead last of 18 and is **NOT** selected (§3e.6, via the production entry
  point `approvedFreePoolFromSettings()`).

So this is **latent, not an active defect**. Do not build against it as though
the pool were short, and do not "fix" it by shrinking or reordering the live
pool.

## Why it is worth a card at all

The safety property today rests on exactly one thing: a substring heuristic
over a model NAME. V32LB992 §3e.7 measured that **zero** of the 18 pool
members carry a scored ledger verdict, so the evidence fold assigns every
member the same unknown tier and contributes nothing to the ordering. Name
matching is therefore not a tiebreak on top of evidence — it is the whole
mechanism. A vendor that ships a safety classifier without "content-safety" in
its id defeats it silently.

## Trigger — what would make this active

Any of:
- the approved free pool durably drops to ~3 or fewer members (403/429
  attrition, a narrowed catalog, or an operator-curated short pool), **or**
- a classifier-shaped model enters the pool under a name the heuristic does
  not match.

**The trigger must FIRE, not be remembered** (peer review, 2026-08-29). Both
conditions above are things a human would have to notice, and by the time
either is observably true the thing they were meant to prevent has already
happened. That is the same failure shape as the guard itself:
`looksLikeClassifier` is not inaccurate today — it clamps exactly what it was
aimed at — but it **cannot fail loudly**. Rename the model, or add a
classifier whose id lacks the substring, and the clamp silently stops
applying: nothing throws, no test reddens, and the first symptom is a
classifier quietly participating in a code-review ensemble. A guard whose
failure is indistinguishable from correct operation is not a guard.

So the cheap half of this card is not the exclusion — it is converting "we
will notice" into "we will be told", which is a few lines and buys most of the
safety: an assertion that the clamped set is non-empty and that the specific
known classifier id is still matched by the predicate, so a vendor rename
reddens a test instead of silently widening the ensemble. Do that FIRST and
independently of the exclusion; it is what makes the latent floor safe to
leave latent.

## Shape of the fix, NOT ratified

An exclusion rather than a demotion — a classifier must not be *selectable* as
a general-purpose generator regardless of pool length. Ranking is the wrong
layer for a correctness property, because ranking always runs out.

Note the ordering constraint any fix inherits: an exclusion that can empty the
pool is worse than the bug. `applyFreePoolToSettings` already refuses an empty
`free_models`, and `approvedFreePoolFromSettings` is deliberately lenient on
availability — both exist so degraded conditions fail toward "still has a
pool", never toward "no rotation".

## Acceptance

- [x] **FIRST, and independently shippable — make the existing guard fail
      loudly.** A test asserts the clamped set is non-empty and that the known
      classifier id is still matched by `looksLikeClassifier`, so a vendor
      rename reddens CI instead of silently widening the ensemble. This is the
      few-line half that converts the trigger above from something a human must
      remember into something that fires on its own.
- [x] A regression test pins the floor with the REAL selector (no mocking of
      the unit under test): with a pool of three-or-fewer members, one of them
      classifier-named, the classifier is not selected.
- [x] The exclusion cannot empty the pool — a test covers "every member is
      classifier-named" and asserts the degraded-but-non-empty outcome the
      codebase already guarantees elsewhere.
- [x] Build + suite green: tsc --noEmit clean, 84 pass across free-rotation.test.ts + cli-args.test.ts.

## Notes and lessons learned

## Status log

| Date | Status change | Note |
|---|---|---|
| 2026-08-29T23:33:00+0200 | backburner → complete | Built after all, and the card's own framing is why it was safe to: it said "deferred, not stalled — nothing to drain until the trigger exists", but the two triggers it named (pool attrition to ~3; a classifier under an unmatched name) are both things **a human would have to notice**, and by then the harm has happened. That is the same failure shape as the guard itself, which the card says in as many words. So rather than wait for a trigger that cannot fire on its own, the floor is now structural: `selectFreeEnsembleModels` EXCLUDES classifier-named ids instead of merely ranking them last, with a fallback to the ranked list when EVERY member is classifier-named — degraded beats dark, per this module's standing never-empty invariant. On the live 18-member pool this is a no-op (classifiers already rank below the top 3), which is pinned by its own test. **The pre-fix failure was MEASURED, not asserted:** stashing only `free-rotation.ts` and re-running gave exactly `1 failed \| 56 passed`, the failure being `does NOT select a classifier from a short pool`. Tested through the EXPORTED ranker rather than the private `looksLikeClassifier`, so the tests pin the guarantee and not the implementation. |
