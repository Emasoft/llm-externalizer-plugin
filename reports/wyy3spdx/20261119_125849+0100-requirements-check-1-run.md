# Requirements check 1 run (TRDD-WYY3SPDX, amendment 1 d71421d6)

Verdict: KEEP R1 by the pre-registered rules (all four hold). The old-wording baseline (V 43 of 200) is far from the pre-registered models, so the rules discriminate weakly here; the main agent decides whether that shift needs a ruling (see "Reading the verdict"). 800 of 800 calls ok, first attempt, 0 retries, 0 missing, 0 harness defects, 1 model id. The pre-registration makes neither the model id nor a baseline V range a validity condition (voids: more than 20 missing in a build, a model change during the run, an unresolved harness defect).

Builds (git archive, recipe 0qqvtucf/build.mjs): R0 = 7e0d3917 sha256 03a2e8bd63b523d62444da388d7061b0b154155781dbf210fb674c3902fef008 (re-checked before the run); R1 = 53e41288 sha256 74cc736f9982c4604be06c28ff498f8354cec1ae080466b08c20c5128e32dd55 (re-checked).
Scoped wording checks (amendment item 1), all PASS before any call: R0 requirements.ts module 272729-272838 holds the old sentence, no "labelQuestion("; R1 module 272732-272840 holds no old sentence, holds "labelQuestion("; R1 labelQuestion body (270516-270519) holds "is background for reading the text in". Bounds as expected.
Run: seed 31415926, order.json written before the first call, one call at a time, 2026-11-19T11:34:19Z to 11:58:01Z. Env of label1-run.mjs. No key printed or stored.
Model ids seen (ok calls): typesafe/jev-1.14-20261014 only. Warnings and degraded: 0. Scored sentence in decision.requirements[] equals the label+confidence>=0.6 rule: 0 disagreements. Output shape check on the first call of each form passed.

## Totals
| build | V (returned vague of 200) | P (returned property of 200) | ok calls | missing | retried ok |
|---|---|---|---|---|---|
| R0 | 43 | 200 | 400 | 0 | 0 |
| R1 | 44 | 200 | 400 | 0 | 0 |

## Rules
1. V(R1) <= V(R0) + max(3, ceil(V(R0)/2)): 44 <= 43 + 22 = 65: PASS
2. no vague item-form returned in >= 6 of 10 R1 runs while <= 2 of 10 R0 runs: none: PASS
3. P(R1) >= P(R0) - 5: 200 >= 195: PASS
4. P(R1) >= 160: 200: PASS

Verdict: KEEP R1 (all four rules hold)

## Returns per item and form (of 10; n = ok calls) and mean P(requirement)
| item | gold | form | R0 returned | R0 meanP | R1 returned | R1 meanP |
|---|---|---|---|---|---|---|
| p01 | requirement | one | 10/10 | 0.935 | 10/10 | 0.919 |
| p01 | requirement | emb | 10/10 | 0.964 | 10/10 | 0.931 |
| p02 | requirement | one | 10/10 | 0.963 | 10/10 | 0.968 |
| p02 | requirement | emb | 10/10 | 0.985 | 10/10 | 0.962 |
| p03 | requirement | one | 10/10 | 0.990 | 10/10 | 0.990 |
| p03 | requirement | emb | 10/10 | 0.980 | 10/10 | 0.979 |
| p04 | requirement | one | 10/10 | 0.968 | 10/10 | 0.968 |
| p04 | requirement | emb | 10/10 | 0.961 | 10/10 | 0.940 |
| p05 | requirement | one | 10/10 | 0.989 | 10/10 | 0.990 |
| p05 | requirement | emb | 10/10 | 0.987 | 10/10 | 0.981 |
| p06 | requirement | one | 10/10 | 0.913 | 10/10 | 0.879 |
| p06 | requirement | emb | 10/10 | 0.881 | 10/10 | 0.810 |
| p07 | requirement | one | 10/10 | 0.965 | 10/10 | 0.969 |
| p07 | requirement | emb | 10/10 | 0.974 | 10/10 | 0.953 |
| p08 | requirement | one | 10/10 | 0.970 | 10/10 | 0.967 |
| p08 | requirement | emb | 10/10 | 0.979 | 10/10 | 0.974 |
| p09 | requirement | one | 10/10 | 0.974 | 10/10 | 0.961 |
| p09 | requirement | emb | 10/10 | 0.938 | 10/10 | 0.916 |
| p10 | requirement | one | 10/10 | 0.955 | 10/10 | 0.941 |
| p10 | requirement | emb | 10/10 | 0.966 | 10/10 | 0.941 |
| v01 | not_requirement | one | 0/10 | 0.149 | 0/10 | 0.198 |
| v01 | not_requirement | emb | 0/10 | 0.347 | 0/10 | 0.434 |
| v02 | not_requirement | one | 1/10 | 0.646 | 1/10 | 0.666 |
| v02 | not_requirement | emb | 10/10 | 0.785 | 10/10 | 0.773 |
| v03 | not_requirement | one | 0/10 | 0.045 | 0/10 | 0.068 |
| v03 | not_requirement | emb | 0/10 | 0.276 | 0/10 | 0.294 |
| v04 | not_requirement | one | 0/10 | 0.421 | 0/10 | 0.457 |
| v04 | not_requirement | emb | 0/10 | 0.552 | 0/10 | 0.495 |
| v05 | not_requirement | one | 0/10 | 0.225 | 0/10 | 0.202 |
| v05 | not_requirement | emb | 0/10 | 0.368 | 0/10 | 0.375 |
| v06 | not_requirement | one | 0/10 | 0.404 | 0/10 | 0.379 |
| v06 | not_requirement | emb | 0/10 | 0.434 | 0/10 | 0.481 |
| v07 | not_requirement | one | 10/10 | 0.787 | 10/10 | 0.783 |
| v07 | not_requirement | emb | 10/10 | 0.905 | 10/10 | 0.852 |
| v08 | not_requirement | one | 0/10 | 0.174 | 0/10 | 0.194 |
| v08 | not_requirement | emb | 0/10 | 0.339 | 0/10 | 0.321 |
| v09 | not_requirement | one | 1/10 | 0.607 | 0/10 | 0.577 |
| v09 | not_requirement | emb | 9/10 | 0.766 | 8/10 | 0.746 |
| v10 | not_requirement | one | 0/10 | 0.379 | 0/10 | 0.449 |
| v10 | not_requirement | emb | 2/10 | 0.648 | 5/10 | 0.693 |

## Embedded form: labels of the opener (first) and closing (last) sentences
| build | position | label | count |
|---|---|---|---|
| R0 | opener | opinion | 200 |
| R0 | closing | instruction | 200 |
| R1 | opener | opinion | 200 |
| R1 | closing | instruction | 200 |

## Other
Models seen (ok calls): typesafe/jev-1.14-20261014
Warnings/degraded on ok calls: 0
Scored sentence returned by label/confidence rule vs present in decision.requirements[]: 0 disagreements
Failed attempts by status: {}
Missing calls: none

## Notes (not gated)
- Baseline is not model A/B/C of the pre-registration: in both builds v07 (one and emb), v02-emb and v09-emb are returned 8-10 of 10 and v02-one and v09-one 0-1 of 10; vague V is 43 (R0) and 44 (R1) of 200, far above the old picture (mean 0.053 per item-form). Rule (1) margin is therefore max(3, ceil(43/2)) = 22; the observed difference is +1.
- Largest per-item-form moves, R0 to R1: v10-emb 2/10 to 5/10 (rule 2 needs R1 >= 6 and R0 <= 2: not triggered), v09-emb 9/10 to 8/10. No other vague cell moves by more than 1.
- P is 200 of 200 in both builds; lowest mean P(requirement) is p06-emb (0.881 R0, 0.810 R1), still returned 10/10.
- Embedded opener and closing sentences: opener "opinion" 200/200 and closing "instruction" 200/200 in both builds (the scored sentence is not one of them).
- Split counts: embedded 3 and one-sentence 1 in every call (any other count would have stopped the run).
- Files: reports_dev/wyy3spdx/req1/ (calls.tsv, order.json, pre-run.md, run.log, logs/, analysis.md, ps-before.txt, ps-after-run.txt); scripts_dev/wyy3spdx/req1-check.mjs, req1-run.mjs, req1-analyze.mjs.

## Verification (independent of req1-analyze.mjs, awk over calls.tsv)
- Shape and first-call checks: req1/state.json holds {"firstModel":"typesafe/jev-1.14-20261014","shapeChecked":{"emb":true,"one":true}}; 800 rows status ok; split 3 on 400 embedded rows and 1 on 400 one-sentence rows.
- awk recount of returned (label requirement and confidence >= 0.6) vs the tsv returned column: 0 mismatches (same definition as the harness: it checks the tsv, not the raw JSON in logs/); returned vs presence in decision.requirements[] (taken from the output, so independent of the rule): 0 mismatches; invalid true on a scored sentence: 0. The V and P recount reads the same tsv: it checks the analyzer arithmetic, not the raw outputs.
- awk recount of V and P: R0 v 43, p 200; R1 v 44, p 200 (same as the analyzer).
- Script sha256 as run: req1-run.mjs af0b3884db6f797587d68ec5ef67a1f5064fe6578c68df3a46659432fd5c669b (two unused lines, a firstModel stub, deleted after order.json and pre-run.md were written and before the first call; node --check passed); req1-check.mjs 58703515a62411c17cc640df4bd9fda9c230c0bd1c392412ab963fe02e5b22c0; req1-analyze.mjs be962b3b960ce8bb9c347c686f2b90686e3486648ff5435e4c1e2ca84b72ae68; req1-build-R0.mjs 5692c86a6d09fb4bd438e79ea7a74c6442648c84854e6507f7710b13563ec11d; req1-build-R1.mjs 2f139660ea81de5f091940f485fc5f37129d893a3259aaf170f52d78151a9278.

## Reading the verdict
The old-wording baseline here (V 43 of 200, with v07 returned 10/10 in both forms and v02-emb 10/10) is far above every pre-registered model (A mean 0.053 per item-form); rule 1's margin of 22 is wide at that level, so rule 1 passing says little beyond "no large rise". The observed R0-to-R1 difference is +1 (43 to 44). Rule 2 carries more weight: v10-emb moved 2/10 to 5/10, one return short of the rule 2 trigger (R1 >= 6 and R0 <= 2 needs 6). All other vague cells moved by at most 1 (v09-emb 9 to 8, v09-one 1 to 0). The verdict is KEEP R1 by the pre-registered rules; it does not show that R1 is no worse on v10-emb.

## Deviations
