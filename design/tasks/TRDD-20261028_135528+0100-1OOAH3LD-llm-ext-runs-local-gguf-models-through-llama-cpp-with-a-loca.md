---
trdd-id: 1OOAH3LD
title: llm-ext runs local GGUF models through llama.cpp with a local_llama profile
column: todo
status: tasked
created: 2026-10-28T13:55:28+0100
updated: 2026-10-28T19:21:27+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-10-28T13:55:28+0100
implementation-commits: [f105c646]
---

# llm-ext runs local GGUF models through llama.cpp with a local_llama profile

## User directive (verbatim, 2026-10-28)

> you should add the ability of llm-ext to use llama.cpp to execute any local model compatible with llama.cpp. in particular i need you to add a local profile called local_llama:
> ```
> # The local_llama profile will run llama.cpp locally as inference engine, with any llama.cpp compatible model.
> # WARNING: You need a llama.cpp build with LFM3 support (merged in llama.cpp #31252; produced at llama.cpp 19cce69).
> # The first model added to the profile is `AtomicChat/LFM3-1.7B-Uncensored-GGUF:AD-Q6_K`.
> # The profile must automatically download it from huggingface or using the llama-cli command to download it,
> # cache it automatically, and run it, like this:
> llama-cli -hf AtomicChat/LFM3-1.7B-Uncensored-GGUF:AD-Q6 -p "The prompt content goes here."
> ```

## Open points before design
- The directive names the quant as `AD-Q6_K` in one line and `AD-Q6` in the command line; the real tag must be checked on Hugging Face.
- Related: TRDD-UT7UC025 (self-healing profiles; Nanbeige4.2 must run through Krill).

## Approval log

- 2026-10-28T13:55:28+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-28T14:40:32+0100 — column → todo by user. design approved through four design questions 2026-10-28

## User decisions 2026-10-28

Q: how should llm-ext run the model (llama-cli per prompt reloads the 1.6 GB model each time; llm-ext sends prompts in parallel)? USER answer verbatim: "llama-server (Recommended)"
Q: after llm-ext starts llama-server, what happens when the command finishes? USER answer verbatim: "Keep it running (Recommended)" - llm-ext records the server process id and adds a command to stop it.
Q: installed llama.cpp 0.5.0 (build 11146) and Homebrew stable 0.7.0 both predate LFM3 support (PR 31252, commit 19cce69, merged 2026-10-27); only v0.8.0 (2026-10-28) has it. How to get a build? USER answer verbatim: "Brew HEAD build (Recommended)"
Model tag: use AD-Q6_K (exact file LFM3-1.7B-Uncensored-AD-Q6_K.gguf, 1587969920 bytes); the directive's AD-Q6 spelling is untested. Facts report: reports/llama-cpp-profile/20261028_135624+0100-facts.md
USER directive verbatim (2026-10-28): "notice that the model LFM3-1.7B is reported as having a context memory of 256k tokens. so make sure to split the input files accordingly (if i remember the benchmarks reported errors above 35-40% of the context, so test it well)"
Consequence: the design must (a) verify the 256k claim from the model config, (b) start llama-server with an explicit context size, and (c) measure answer quality at increasing context fill (for example 10, 20, 30, 35, 40, 50 percent of the window) and set the input-split size from the measured safe fill, not from the nominal 256k.
Smoke test 2026-10-28: Homebrew HEAD build b11960-8642541b2 (22 commits after LFM3 merge 19cce69) loaded AtomicChat/LFM3-1.7B-Uncensored-GGUF:AD-Q6_K via llama-cli -hf and answered at about 107 tokens/s; the model emits a thinking block before the answer, which llm-ext must strip.
USER directive verbatim (2026-10-28): "notice that you can enable thinking for the model, and set the effort to various levels, each one increasing the model output and the context usage. so for complex tasks like finding bugs, you may want to limit the prompt to 30% but use effort=high, or effort=max, for example."
Consequence: the context budget per request is prompt + thinking + answer; the design maps each llm-ext command to a thinking effort level and measures, per effort level, the largest prompt fill (percent of the window) that still answers correctly, so heavier commands such as bug-finding get a smaller prompt share and a higher effort. Note: the llama.cpp LFM3.jinja template (b11960) exposes enable_thinking and preserve_thinking but no effort parameter; how effort is set must be verified from the model card or the GGUF embedded template.
USER directive verbatim (2026-10-28): "looks like the reasoning effort is simply determined by the amount of tokens and output tokens available. so we can just disable it for simple tasks, like text esiting, and enabling for bug search. always keeping the context usage under 30-40%"
Consequence: no effort-level table; each llm-ext command gets thinking off (simple tasks such as text editing) or on (bug search), and the thinking room is whatever token budget remains; prompt plus thinking plus answer stays under 30-40 percent of the context window (exact value from the context-fill benchmark).
Liquid AI docs pasted by the user (docs.liquid.ai LFM3-1.7B page): 1.73B params, 256K context input+output, 24 layers (13 short conv, 5 sliding-window attention, 6 global attention); general generation temperature 0.1, top_k 50, repetition_penalty 1.1; math and science temperature 1.0, top_p 0.95, top_k 20, repetition_penalty 1.0; reasoning on by default, enable_thinking False for direct answers; the page says it is NOT recommended for agentic coding or complex multi-step reasoning due to its size, so bug-search quality must be measured, not assumed.
USER directive verbatim (2026-10-28): "Make the testing completely automated, so that when a new local model is added to the local_llama profile the tests will run automatically and find the right calibration values for context percentage, max input tokens, max output tokens, reasoning on or off, structured output, etc."
Consequence: the context-fill benchmark becomes an automatic per-model calibration. When llm-ext finds a model in local_llama with no calibration record, it runs the calibration itself (no user command needed) and stores, per model, the safe context percentage, max input tokens, max output tokens, thinking on or off per task kind, and whether structured output (JSON schema) works; llm-ext then sizes requests from that record. Overlaps TRDD-UT7UC025 (self-healing: benchmark new models): one calibration framework, not two.
- Q: may llm-ext use a model while it is being calibrated (2-4 hours)? USER answer verbatim: "No, wait"
- Q: how do calibration and user requests share the model server? USER answer verbatim: "Calibrate when idle (Recommended)"
- Q: should a llama.cpp upgrade trigger a new calibration? USER answer verbatim: "Quick check only (Recommended)"
- Q: what happens to an unused server holding about 4.8 GB at full context? USER answer verbatim: "Smaller context + idle stop"
Approved design (after two adversarial review rounds): design/specs/TRDD-1OOAH3LD-local-llama-design.md
- USER directive verbatim (2026-10-28): "remember that auto-calibration must be automatically triggered only when a new or updated model is added/edited in the config.yaml local_llama profile. and in general for all profiles it goes the same rule: new models require calibration once."
- Consequence: the calibration trigger is a model added or changed in a profile of settings.yaml (the user wrote config.yaml; llm-ext reads settings.yaml), detected by comparing each profile's models with the calibration records; each model is calibrated once, never on every run, and the rule applies to every profile, not only local_llama (scope shared with TRDD-UT7UC025).
- USER directive verbatim (2026-10-28): "no, a benchmark test is something long and complex needed to calibrate the model parameters for each command type, and must be done only when the model is added or updated. instead llama.cpp or any other inference engine update will not trigger the benchmarks of the commands, but just a quick check to verify that the model still run without errors with that inference engine."
- Consequence: the full per-command calibration benchmark runs only when a model is added or updated in a profile; an update of llama.cpp or any other inference engine runs only a quick smoke check (the model loads and answers without errors on the new engine build) and never a recalibration; a failed smoke check is reported as an error, it does not start a benchmark.
Q: local_llama: what should happen when the llama-server sits idle for 30 minutes? USER answer verbatim: "Built-in sleep (Recommended)" - --sleep-idle-seconds 1800 (2.5 GB to 169 MB, 0.5 s wake; the process keeps the port).
Q: local_llama: the integration test runs a real llama-server with a 19 MB model; on a machine without llama-server, or with no network on its first run? USER answer verbatim: "Always fail" - a missing llama-server or no network both fail the test run (no skip).
Q: increment 2a review-born decisions, which do you approve? USER answer verbatim: "Opt-in key, Refuse on change, Auto-restart, Ship before the key, " plus the note "the key must be configured symbolically by you, equal for all local services."
Consequence: increment 2a is approved as planned in design/specs/TRDD-1OOAH3LD-increment-2a-plan.md. For increment 2c the API key is one symbolic key that llm-ext configures itself, the same for every local service (exact form to be designed in 2c; Locals 0.2.1 has no API key support, measured).
USER directive verbatim (2026-10-28, revising the 2a rulings): "- sleep, but with a timeout (max 2 hours inactive, beyond that is killed)"
USER directive verbatim (2026-10-28): "- llama.co server exists even on windows and linux, using the cuda gpus of the mechines. so it must run on evrry machine. install it and configure it if it is missing."
USER directive verbatim (2026-10-28): "- always fail, but with the optional argument --no_stop_on_fail , if used it will continue using the alternative modules of the profile if defined as fallbacks"
Consequence: the 2a plan needs a revision before code: (a) idle = --sleep-idle-seconds plus a kill after 2 hours without requests, which needs a watcher process because no llm-ext process lives that long; (b) the win32 refusal is withdrawn, the managed server must work on macOS, Linux and Windows (CUDA), with a cross-platform identity check, and llm-ext installs and configures llama.cpp when it is missing (its own increment); (c) a failure stops the command by default, and the optional flag --no_stop_on_fail lets it continue on the profile fallback models (reading: an llm-ext command flag used when the managed server cannot start, to be confirmed with the user). The four review-born decisions approved earlier (opt-in key, refuse on change, auto-restart, ship before the key) stand.

## Progress

2026-10-28 increment 1 (request_options) implemented by a worker, UNCOMMITTED in the working tree. Report reports/llama-cpp-profile/20261028_145937+0100-increment-1-impl.md. npm test 5067 passed, tsc and eslint clean. CHANGELOG hunk removed because git-cliff generates the changelog at publish. NEXT: adversarial REVIEW of the uncommitted diff, then commit by file name, then increment 2 (server supervisor).
2026-10-28 increment 1 code review: 1 blocker. A real llama-server is detected through GET /props and routed to the native /api/v1/chat path, which returns before request_options apply, so a real server never received them (tests passed only because their fake server answered 404 on /props). A fix worker is forcing the OpenAI-compatible path when options apply, plus 7 smaller fixes, and verifying against a real llama-server. Review: reports/llama-cpp-profile/20261028_150558+0100-increment-1-review.md. Durable backup of the uncommitted work: reports/llama-cpp-profile/20261028_150122+0100-increment-1-wip.patch. Commit subject must carry the changelog line (cliff.toml renders only the first line).
2026-10-28 increment 1 COMMITTED as f105c646 after the B1 fix and 7 smaller fixes (report reports/llama-cpp-profile/20261028_151529+0100-increment-1-fixes.md); verified on a live llama-server b11960 with LFM3. npm test 5077 passed, tsc and eslint clean. NEXT: increment 2 (server supervisor) per design/specs/TRDD-1OOAH3LD-local-llama-design.md.
2026-10-28 increment 2a (server supervisor) planned after two review rounds; plan design/specs/TRDD-1OOAH3LD-increment-2a-plan.md; waiting for three user rulings (idle sleep or stop, test skip without llama-server, offline test). API key split to 2c, disk check to 2b.
2026-10-28 the increment 2a plan is NOT approved yet: it waits for the three user rulings and for the review-born decisions in its "Not yet approved" list; until then the increment 2 section of the approved design stays in force.
