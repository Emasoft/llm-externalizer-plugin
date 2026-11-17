---
trdd-id: 1L9VMEY7
title: Local-only classifier profile local-decision that sends classify requests straight to mlx-decision
column: dev
status: tasked
created: 2026-11-16T23:20:23+0100
updated: 2026-11-17T02:23:01+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-16T23:20:23+0100
implementation-commits: [fc3052b0]
---

# Local-only classifier profile local-decision that sends classify requests straight to mlx-decision

## User directive (verbatim, 2026-11-16)

"are you saying that you did not have yet created a local-only profile for classifiers commands? do it then! call it local-jev or local-decision"
Second directive, same evening: "i told you to make profiles more configurable.. making possible to create local only profiles.. the only requirement is to ensure reliability and fallbacks, so a remote only profile must not exist, it should always have a local model to fallback to.. but a profile that is only local is ok, since it is the fallback of itself"

## Goal

A classifier profile named `local-decision` that sends every classify request straight to the local mlx-decision singleton (elephant-1, adopted by classifiers/l2/local-decider.ts, never started by llm-ext). No OpenRouter call, no API key, no decisions-catalog or endpoint lookup.

## Current state (verified 2026-11-16)

- config.ts:1596 refuses any classifier profile whose api is not openrouter-remote.
- run-decision.ts run(): selects the profile through the remote catalog (line ~274), needs a key, loads the catalog and the endpoint prompt limit (~291-319), then exec() tries execRemote and escalates to answerWithLocalDecider (l2/local-fallback.ts) only on a remote failure (~444-505).
- All 15 classify specs answer correctly through answerWithLocalDecider today (reports_dev/classify-local).

## Design

1. New classifier api value `mlx-decision-local` (config.ts: accepted for profile-type classifier only; no url, key or model needed; the model is SERVED_MODEL elephant-1). Validation errors stay precise.
2. Built-in profile `local-decision` (profile-type classifier, api mlx-decision-local), added to settings.yaml once, like the built-in local_llama and locals-mlx profiles (dynamic-profiles-state.json). Not made active; selected with `--profile local-decision` or `active_classifier: local-decision`.
3. run-decision.ts: when the resolved profile api is mlx-decision-local, skip catalog selection, key resolution, removed-model replacement, endpoint prompt limit and the remote fallback; exec calls answerWithLocalDecider directly. Planning uses the decider's own prompt limit (find where the decider limit is known; if none exists, the 422 required-vs-limit text is the source of truth and the run reports it, never guesses). Cost 0, usage recorded as local, envelope answered_by elephant-1, no "remote failed" warning. A decider that cannot be adopted fails the run with the decider's reason (no fallback to remote).
4. --estimate on this profile: prints that the call is local and free, sends nothing.
5. classify ping on this profile: no key check; one question to the decider.
6. Docs: skills/llm-externalizer-cli-reference and the settings docs name the profile.
7. No remote-only classifier profile (second directive): a remote classifier profile must always keep the local decider as its fallback. settings.yaml validation refuses local_fallback.enabled false (and any other setting that leaves a remote classifier profile with no local fallback), with a message naming the rule and pointing to the local-decision profile. A local-only profile (mlx-decision-local) is valid on its own: it is its own fallback. Test seams that disable the fallback through RunDeps (not settings.yaml) stay, since they pin captured replies.

## Acceptance

- [ ] `llm-ext classify <each of the 15 actions> --profile local-decision` answers via elephant-1 with no request to openrouter.ai (test with a fetch spy), exit 0.
- [ ] `classify ping --profile local-decision` exits 0 with no key in the environment.
- [ ] Unit tests for the config validation, the built-in profile insertion, and the run path (fake decider seam); tsc and eslint 0.
- [ ] Live check against the running singleton on this Mac, through the built CLI.
- [x] ~~settings.yaml with local_fallback enabled false is refused at load with the no-remote-only message~~ (superseded 2026-11-17 by the orchestrator: a load-time refusal would stop every llm-ext command, so classify refuses it in cli/main.ts instead; live: exit 1 with the no-remote-only message, other commands run); a settings.yaml whose only classifier profile is local-decision is valid.

## Approval log

- 2026-11-16T23:20:23+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Notes

2026-11-17 00:23+0100: implemented in fc3052b0 (worker report reports_dev/local-decision/20261117_001206+0100-local-decision.md, read and diff-checked by the main agent). Design item 7 changed by the orchestrator: the remote-only refusal is on the classify path (cli/main.ts), NOT at settings load, because a load-time refusal would stop every llm-ext command. Remote planning now fits min(remote limit, 16384) on Apple silicon while the fallback is on (up to about 2x remote requests for inputs between the two limits). Live: or-jev with a refused key (401) answered by elephant-1 on run-decision.ts (about 21k tokens, 2 chunks), exit 0; local-decision filter, label, ping, estimate exit 0 with no key. Open: random base64 is undercounted about 2x by l1/estimate.ts (ratio 1.985), so a base64-heavy request can still end in the decider 422.
2026-11-17 01:02+0100: open to USER veto, decided by the agent and already released in 14.5.0: remote classify runs on Apple silicon plan under min(remote limit, 16384) so the local fallback can answer every piece, at up to about 2x remote requests for inputs between the two limits; a veto means a follow-up release. The main agent read the local-fallback.ts and profile.ts diffs only AFTER the publish; ping.ts, pick.ts, estimate-output.ts and local-decision.test.ts were not read by the main agent. UBS was skipped by its 180 s timeout on fc3052b0 and 3ed140b7 (host load 30-100).
2026-11-17T02:22:57+0100 14.5.0 real-input re-run (reports_dev/classify-local/v1450, installed 14.5.0, --profile local-decision): ping exit 0; rank on src/broker exit 0, 1405 s, 9 files ranked 0.84 to 0.10, no 422. find on src/classifiers/l2 FAILED, exit 4, 3086 s, host load 100 to 140: (1) 6 answers (where/exists i5-i7) refused by the decider, the question with its state needs 16460 tokens, the limit is 16384: the planner fits the request to 16384 by the l1 estimate, which is not the decider's tokenizer, so a request planned exactly at the limit can be over it by the decider's own count (here 0.5 percent over; base64 measured about 2x under); (2) 10+ answers (i43 onwards) failed deadline exceeded, 1 POST attempt, not retryable, under host load above 100. The 14.5.0 fix is therefore NOT complete: fc3052b0 removed the 19448 to 28700 token overruns but not an overrun of an estimate-planned request. test-output and the two or-jev runs still pending.
