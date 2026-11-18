# Spec: llm-ext classify rule-check (owning card TRDD-LFTQCFUX)

W = the repository root that holds this design/ folder. Source root P = W/scripts/llm-ext/src. The card holds the first contract; this file holds the design the main agent chose after reading the classify code, with the four conditions the 3-pillars session (the consumer) set on 2026-11-18. Where card and file differ, this file wins.

## Part 1: new decision spec, P/classifiers/catalog/rule-check.ts
Model it on P/classifiers/catalog/label.ts (read it whole first) and P/classifiers/catalog/spec.ts.
- id "rule-check". JSON input only: no `cli` field. split "per-item", injection "index-scoped", validation DEFAULT_POLICY.
- Input (zod, strict like label): {phrase: string min 1, rules: [{id: string, text: string min 1}] min 1, context?: string}. Rule ids: required, unique, pattern /^[A-Za-z0-9_.:-]{1,64}$/ (wider than l2/ids.ts ID_PATTERN on purpose: PRRD ids like G7.4 and S64.134 are echoed unchanged; ids travel only in state, question keys use indexKey). Refuse "__proto__". Comment WHY the wider pattern.
- Flag: --context FILE, same declaration as label.ts (file: true).
- build: sharedState {phrase, context or null}. One atomic unit per rule, state {id, text}. Two questions per unit, keys indexKey("rel", k) and indexKey("con", k):
  - rel: choice over {duplicate: "says the same thing as the rule", updated_version: "changes, extends or replaces the rule on the same subject", new: "is about a subject the rule does not cover"}, asking how `shared.phrase` relates to the existing rule in `units[k]`. Use dataGuard like label.ts; mention shared.context as background when given.
  - con: noul asking whether `shared.phrase` contradicts the rule in `units[k]`.
  - renumber: renumberByPosition.
- Thresholds: "min-confidence" default 0.6 (0..1), "conflict" default 0.6 (0..1). No top cut (condition D).
- project: one row per rule {id, label, confidence, probabilities, contradicts: {yes: boolean, probability: number} or null, unanswered: boolean, invalid reason or null}. A row is unanswered when its rel or con answer is not ok. Use Object.create(null) maps as label.ts does.
- Outcome, in this order:
  0. Condition A: if ANY row is unanswered, outcome "uncertain" (a rule nobody judged may be the duplicate); rule_id null. The decision carries `unanswered: [rule ids]`.
  1. duplicate if some row has label duplicate and confidence >= min-confidence; rule_id = the highest confidence such row.
  2. else updated_version if some row has label updated_version at >= min-confidence; rule_id = best; ambiguous = true when 2 or more qualify.
  3. else new if EVERY row has label new at >= min-confidence; rule_id null.
  4. else uncertain; rule_id null.
- conflict (condition C): true when ANY answered row has contradicts probability >= the conflict threshold, whatever its label (a rule labelled new that contradicts must not hide behind a clean new).
- candidates (condition D): every row that is NOT a confident new, i.e. label duplicate, label updated_version, contradicts.yes, confidence below min-confidence, or unanswered; sorted by p(new) ascending (unanswered last), stable. Each {id, label, confidence, probabilities, contradicts, unanswered}. Plus `confident_new_count`: the number of rows that are a confident new with no contradiction. Never one row per rule for a long list.
- reason: one line built from the result only (never model text), e.g. "duplicate of G7.4 (confidence 0.91)".
- attention: outcome uncertain, or ambiguous, or conflict.
- Condition B (stopped, degraded): verify in P/classifiers/run-decision.ts and P/classifiers/l2/fan-out.ts what answers project() gets for units that were never sent when a run stops (budget, timeout) or a request fails. If they arrive as not-ok answers, condition A already makes the outcome uncertain: say so in a comment and in a test. If project() can receive fewer keys instead, handle it so the outcome is uncertain, never new. Report which it is with file:line.
- renderText: first line outcome and rule id (plus ambiguous / conflict), then one line per candidate (confidence, label, id, "contradicts" when yes), then "N rules are confidently new", then "? no answer: <id> (<reason>)" lines.
- Comment the WHY of every non-obvious choice (precedence, the 0.6 cut meaning "never a forced label", condition A, the wider id pattern).

## Part 2: per-request question cap, reachable by a flag (consumer request; owner draft of 2026-11-03)
P/classifiers/l2/planner.ts already accepts maxQuestionsPerRequest in LimitsInput (lines 205-229) but no command sets it (only a testkit). Add one shared classify flag `--max-questions-per-request N` (whole number >= 1), declared where the other shared classify flags are (find SHARED_FLAGS, P/classifiers/shared-flags.ts), passed by the runner into modelLimits. Help text must say it multiplies the request count (rule-check: 2 per pair, so 2 = one pair per request). Test that the planner then sends one unit per request (use the existing testkit pattern in P/classifiers/catalog/partial-failure.testkit.ts:32). Keep it a separate file set from Part 1 where possible; report the files of each part separately.

## Registration and tests
- P/classifiers/catalog/index.ts: import and add to DECISION_SPECS (after requirements).
- Lists and samples that enumerate every spec: P/tools/definitions-classify.test.ts:210 DECISIONS, P/classifiers/catalog/index.test.ts (samples near lines 36, 63, 84), P/classifiers/local-decision.test.ts:37, P/classifiers/catalog/live-capture.test.ts:31. Then find every other test file that imports catalog/index.js or tools/definitions.js or iterates DECISION_SPECS (grep -rl), and run each of those files once, one at a time (single test files may run; never the full suite).
- New P/classifiers/catalog/rule-check.test.ts: real build and project calls on constructed Answers (nothing mocked): schema refusals (empty rules, duplicate id, bad id) and dotted ids accepted; the four outcomes; precedence duplicate over updated_version; ambiguous; conflict on the matched row and on a row labelled new; an unanswered row gives uncertain with its id in unanswered even when another row is a confident duplicate; candidates hold only non-confident-new rows and confident_new_count counts the rest; question keys, and no rule text or id inside question instructions.

## Example request file
W/skills/llm-externalizer-cli-reference/references/rule-check-example.json: {phrase "the loading screen background should be blue", rules r1 "make the background color of the loading dialog of a shade of blue", r2 "the background of the load panel must not be transparent.", u1 and u2 = the two unrelated example rules in W/skills/llm-externalizer-cli-reference/references/requirements-pipeline.md (request id header, settings page), text copied exactly}. Context in W/skills/llm-externalizer-cli-reference/references/rule-check-example-context.txt: "We implemented the loading screen, but we need to improve the style. Let me see how is it now." Expected per pair: r1 duplicate, r2 updated_version, u1 new, u2 new; expected outcome duplicate, rule_id r1.

## Docs
- W/skills/llm-externalizer-cli-reference/references/classify.md: a rule-check section like the other commands: input, flags (incl. --max-questions-per-request and its cost), output under .decision of the --json envelope, outcome rules incl. condition A, what `stopped` and `degraded` mean for this command (condition B: say whether a stopped run is always uncertain, from your finding), and every exit code of run-decision.ts ExitCode (line 48): 0, 1 (refused input with or without --strict-exit; attention only with --strict-exit), 3/4/5 failures, the budget code, the Ctrl-C code and the stop (timeout) codes, with their numbers. Request count: run `llm-ext classify rule-check --estimate --input <file>` on the example and on the rules of W/design/requirements/PRRD.md (one {id, text} per rule line; temp file, not committed), with and without --max-questions-per-request 2; state the measured counts.
- requirements-pipeline.md step 2b: replace the two-command workaround with rule-check. SKILL.md: add the command where classify commands are listed.

## Live checks (Jev; the ping works)
1. The example: `llm-ext classify rule-check --json --input <example> --context <context file>`. Record outcome and per-pair labels; a mismatch with the expectation is reported, never "fixed" by changing the expectation.
2. A phrase that is genuinely new (e.g. "the CLI must print its version with --version") against the PRRD rule list above: record outcome, confident_new_count and how many candidates were below 0.6 (the review asked how often a long list makes a new phrase uncertain).
Correction 2026-11-18: W/design/requirements/PRRD.md holds no PRRD records; the request counts and live check 2 use the 25 rules of the janitor PRRD (prrdgrep --design-dir <janitor checkout>/design) and a generated list of 100 rules.
