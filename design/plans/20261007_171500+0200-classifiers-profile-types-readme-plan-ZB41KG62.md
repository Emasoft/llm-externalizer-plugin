# Plan v3 — classifier (system-one) and browser commands for llm-ext (TRDD-ZB41KG62)

This file is the authoritative copy of the plan approved on 2026-10-07; edit it here only. Built on three deep studies (jev-mcp; jev-browser + claude-jev + jev-review + Moreno.Jev + awesome-jev; OpenRouter contract + llm-ext benchmark skeleton + existing helpers), all 2026-10-07.

## 1. Decisions and go-aheads needing you

| # | Decision | Default if you approve | Alternative |
|---|---|---|---|
| D1 | Two source fallbacks vs your "no fallbacks" rule | Keep, always reported: `classify decide --hook` defers (empty stdout, exit 0, stderr notice); `browse run` search fields fall back to a keyword query (`degraded`, warning, `fallback` field) | Fail closed: hook emits `permissionDecision:"deny"` with the error; browse types nothing, action error |
| D2 | Classifier spending — RULED 2026-10-07: "do not put limits on spending on jev. only if opt-in with --max-budget=99.9 . in general the classifier is paid. there is no" (message cut off; I read it as "there is no free tier, so no paid switch"; you confirmed: "exactly") | Classifiers are paid by design: no `allow_paid` field, no paid gate, no default cap on any classify or browse command. A spend cap exists only when the caller passes `--max-budget=<usd>` (e.g. `--max-budget=99.9`): the estimate is checked before the first call and the run stops when the running cost would pass it. Every run still prints its cost | — |
| D3 | Jev to speed up model comparisons/benchmarks (applying your cost ruling) | Jev queue ordering DROPPED: `benchmark/pick.ts:165` already orders by mean F1 then latency, a free script. Built: `benchmark classify-eval` with `--if-changed`, rerun when the free drift watcher sees the `jev-latest` alias, price or presence change (§11) | Keep a Jev queue-ordering experiment |
| D4 | Community tools (you said "you decide"), after the cost study | ADD `classify test-output` (Moreno review_test_output: grep finds the failure, Jev says regression vs flaky vs environment), `classify findings` and the presets `invariant-check`, `criterion-vs-tests`. DROP `classify hypotheses` (the hypotheses are already in Claude's context, nothing to save), `classify quality` (overlaps `review`, no evidence its 19 scores mean anything), presets `claim-vs-evidence` (= `verify`), `extraction-vs-source` (= `audit`), `diagnose-failures` (narrow; `test-output`/`ask` cover it); claude-jev `pick`, Moreno triage/review_code/review_diff/check_hypothesis as before | Add back any dropped one |
| D27 | Your cost ruling applied to the jev-mcp tools ("all functionalities must be reproduced") | Every jev-mcp function is kept, but duplicates become options instead of commands: `gate` → `classify review --claims`, the hook example → `classify decide --hook`, claude-jev `relevance` → `classify rank --head 1500 --keep-at 0.5`, `classify models` → a Jev filter on the existing OpenRouter model-info command (`estimate.ts:167`). No command is kept that is not cheaper than the alternative (cost table: `reports/jev-classifiers/` cost study, to be saved there at minting) | Keep separate `gate`, `hook`, `relevance`, `models` commands |
| D28 | Which quicksilver to port. VERIFIED: a locally installed quicksilver 0.3.0 (about 1,480 lines) is not the GitHub repo (v0.2.0, 590 lines); chunking, size caps, symlinks, failover and `errors.log` exist only in 0.3.0, whose comments cite "User decision". The repo is MIT; the 0.3.0 additions carry no licence file | Port 0.3.0's behaviour. If you wrote the 0.3.0 changes, its text may be reused; otherwise 0.3.0 behaviour is re-implemented in our own words from the behaviour spec, and only repo text is copied, with the full MIT notice in NOTICE | Port the repo's 0.2.0 only |
| D29 | One relevance decision for `classify rank` (jev-mcp rerank asks one noul per candidate; quicksilver rank asks one 5-level score per item) | One spec, quicksilver's 5-level score rubric (it has a benchmark), printed as relevance = score/4; jev-mcp rerank's JSON input, 100k budget and per-file best-chunk merge are kept | jev-mcp's noul per candidate |
| D30 | `browse page` | Not built: jev-browser has no page tool (VERIFIED, inventory line 64; `max_steps` is 1–100), so there is nothing to reproduce; `browse page` was an invention of an earlier plan draft | Add a page-fetch command anyway |
| D31 | quicksilver parts not ported | `setup` (saves the API key to a file; your rule: key from the environment only), providers other than OpenRouter and the failover chain (your OpenRouter-only rule), `--fast` packing of independent items into one state (its own bench: 76% vs 100% accuracy; shared-state JSON items are still packed, §5), a separate `status` command (lifetime Jev usage and "Claude tokens not read" go into llm-ext's existing usage history and stats). Ported: every command, input rule, chunk rule, output format, and the per-run receipt | Port any of these |
| D5 | Untrusted text placement (prompt-injection) | Untrusted content (file text, page text, candidate/item text, diffs) always goes in `state`, referenced by index. Short caller parameters (query, purpose, aspect, proposition, field description, policy) stay in instructions as in jev-mcp. Changes jev-mcp prompts for `label` items and `rerank` candidates. Exception: `extract` candidate values stay in criteria (the options are the values) | Reproduce jev-mcp prompts byte-for-byte |
| D6 | Answer tolerances | Scaled with option count (answers are rounded to 2 decimals): choice sum `min(0.05, max(0.01, 0.005·N))`, tie 0.001; final numbers fixed from probe fixtures | jev-mcp fixed 0.01 / 1e-9 (wrongly rejects ≥3-option answers) |
| D7 | Retries | Never retry network errors or timeouts (a resent request may be billed twice). Honour `retry-after-ms` / `Retry-After` up to the run deadline, no 5 s cap | Cookbook: retry transport failures too |
| D8 | Missing `usage.cost` | Compute from tokens × catalog price, mark `cost_estimated: true` | Cookbook: reject the response |
| D9 | Which models a classifier profile may name | Any catalog model whose output modality includes `decisions` (14 live today, two $0) | TypeSafe models only |
| D10 | `-o <dir>` for classify | Saves the same JSON as stdout as a `.json` report (not the `.md` saveResponse format) | Markdown report |
| D11 | Browse Ctrl-C | Added (not in jev-browser): abort run, close browser, remove temp record dir, emit `status:error, aborted: cancelled-by-caller` | Leave as source |
| D12 | Spend go-aheads | My reading of your D2 ruling, which spoke about the product: it also covers my development-time Jev spending, so it needs no go-ahead and has no cap (say if you want the go-aheads back): P-01, the per-spec reply captures in the SP cards, the `classify-eval` runs of EV-08 and live smoke RL-12 run when their card is reached, each printing what it cost. Only the README benchmarks RD-06 and RD-19 keep your D25 go-ahead and $2 cap, because they spend on chat models, not Jev | — |
| D13 | Release gates | 14.1.0 history rewrite + force-push and the 14.2.0 publish stay yours. Nothing classifier-related is coded before 14.1.0 ships | — |
| D14 | Caller-supplied item ids (jev-mcp has three strategies: rename with `_1`, verbatim with `_2` fallback, slug-reject) | One rule: ids matching `[A-Za-z0-9_-]{1,64}` and unique are accepted; anything else is refused naming the id. Question keys are always built from the item's index (`label_i0`), never from the caller id, so the API's key rules cannot break a valid id; caller ids travel in `state` and are mapped back in `project` | Reproduce the silent renaming |
| D15 | Your extra "Label-family presets" | Means `classify check --preset <name>`; after the cost study two presets remain, `invariant-check` (preserved/violated/insufficient) and `criterion-vs-tests` (covered/partial/missing); no second preset system | A separate `label --preset` with built-in class lists |
| D16 | Benchmark modularization | The workload-kit refactor of the 6 existing workloads is in scope and lands before `classify-eval`, which is built on it | Build `classify-eval` standalone, refactor later |
| D17 | Reusing text from the distilled projects | Question texts and skill rules are copied only from sources whose licence allows it, with a NOTICE entry; text from an unlicensed source is rewritten in our own words | — |
| D18 | jev-browser surfaces with no CLI meaning | The MCP stdio server and MCP-over-HTTP server (`--http`, `/mcp`, `/health`) are not ported (your "no MCP servers" ruling); the library export / injected `Page` is not ported (llm-ext is a CLI). The internal decisions (action choice, goal-achieved, stuck, dropdown, no-op recovery, bot wall) are reproduced inside `browse run`; any one of them can be asked ad hoc with `classify ask` | Also expose them as separate `browse goal/stuck/choose-action` commands |
| D19 | Fresh install under your five-type ruling (VERIFIED today: free, paid, local with placeholder models, `config.ts:1553`; `scouting` only from `benchmark scout-accuracy`; the comments naming only free/paid at `config.ts:436, :1350` are stale) | All five built-ins are written, being the templates: `free`, `paid`, `local`, `scouting` as placeholders, `or-jev` with `~typesafe/jev-latest`. Mass scouting with the placeholder refuses with "run `llm-ext benchmark scout-accuracy`" (PT-04). The two duplicated scouting constants stay (import-cycle comment, `scout-accuracy.ts:137`) | Write `scouting` only when its benchmark runs (then its template does not exist until then) |
| D20 | Field name `profile-type` (your wording) in a schema whose other keys are all snake_case (VERIFIED, profile study) | Keep `profile-type` exactly as you wrote it; every other new key snake_case | Rename to `profile_type` for consistency |
| D32 | Writing the type into your existing profiles (breaks the code's current policy that custom profiles are never rewritten, `config.ts:2528-2530`) | Migration PT-02 infers each profile's type with today's rules (D19 text, §8) and writes `profile-type` into every profile, built-in and custom, after a backup in `<config>/backups/`, comment-preserving; it prints each profile's inferred type so you can correct any | Never write: infer the type at every load forever (two ways to know a type) |
| D33 | Strictness of per-type fields (today custom profiles silently ignore unknown keys, `config.ts:2662`) | A field belonging to another type, or unknown to every type, fails at load naming it; PT-02 lists such fields in your files before the strict check ships, so nothing breaks without warning | Keep ignoring unknown keys on custom profiles |
| D34 | Mass scouting accepts only the `scouting` type (your ruling) | Today, with a free-only profile active (the default `free`), mass scouting runs on the free model pool (`mass_scouting/cli.ts:549-561`); after PT-05 it always uses a `scouting`-type profile, whose model may not be a `:free` id (`scout-accuracy.ts:143-150`), so mass scouting on free models ends. `scout` actions that call no model are unaffected | Allow a free model in a scouting profile |
| D36 | Spend switches under types (today a custom remote profile without `free_only` is forced free while `allow_paid_models` is false, `config.ts:3785-3790`) | `allow_paid_models` keeps gating billed calls for the `paid` and `scouting` types; the `classifier` type has no paid gate (D2); `free` and `local` never bill. A profile PT-02 types as `paid` therefore bills nothing until you turn `allow_paid_models` on (E81h) | Drop `allow_paid_models` and let the `paid` type always bill |
| D37 | The deduced command × type table (§8), per your "deduce yourself" | Rows not from your examples, each vetoable: `scan quality` and `scan security` paid only (their code refuses free mode); `check *` local/free/paid (INFERRED, verified in PT-03 step 1); `session compact` free/paid, local INFERRED (verified in PT-03 step 1, set to ❌ if its selector cannot use a local model); `browse run` uses two profiles (classifier for decisions, local/free/paid for typing); commands with no model call accept any type | Change any row |
| D35 | Your own extras that the cost ruling overrode | `classify relevance` → `classify rank --head` option; label-family presets 5 → 2 (`invariant-check`, `criterion-vs-tests`); "use jev to speed up benchmarks every time a model is updated/added/removed/repriced/failed" → nothing remains for the other models: only Jev's own re-evaluation on alias change (`classify-eval --if-changed`), because `benchmark/pick.ts:165` already orders the queue for free. Confirm or restore each | Restore any of the three |
| D24 | Alias vs pinned build: OpenRouter's own `openrouter-decisions` skill says never to use an alias (aliases shift probabilities) | Keep your ruling: `or-jev` uses `~typesafe/jev-latest`; every result records the served build, and the drift watcher (DW) reports when the alias moves | Ship `or-jev` pinned to `typesafe/jev-1.13` |
| D25 | README benchmark spend — ANSWERED 2026-10-07: "yes, but with costs measurements added too for the commands using each of the 4 default profiles." | RD-06 (Claude-reading vs llm-ext, quicksilver-style) plus RD-19 (cost of every model-calling command on each compatible default profile). "The 4 default profiles" = `free`, `paid`, `local`, `scouting` (resolved by your five-type ruling; the classifier column comes with RD-17 in 14.2.0). Paid spend: one $2 total across RD-06 and RD-19, tracked in one spend ledger, which is the hard stop on actual spend; a pilot is measured first, then every paid cell is estimated (`--estimate` where the command has it; otherwise the command's own first paid run is its pilot, counts toward the cap, and its remaining runs are estimated from it); if the total exceeds what is left of the cap I stop and ask before spending | Measure `or-jev` instead of `scouting` (deferred to RD-17, since `or-jev` arrives in 14.2.0) |
| D26 | README length | README becomes a scannable overview in quicksilver's style; reference detail moves to linked `docs/*.md` pages, nothing deleted | Keep all reference text in the README and only add charts and examples |
| D23 | jev-browser deletes a password/cookie handoff file after reading it | Keep: the file is a one-shot secret handoff and leaving it on disk is the bigger risk; the deletion is documented in `--help` and the browse skill | Leave the file and print a warning |
| D21 | Your "tests are real, no mocks" rule | Unit tests replay **real** replies captured by P-01 through the `GlobalFetch` seam wherever P-01 can produce them; each SP card also captures one live reply from its own `build` (D12) as its golden fixture. Transport faults that cannot be produced on demand (HTML body, >1 MB body, `Retry-After` variants, redirect, connection reset: E01–E05, E08, E09) use synthetic `Response` objects, each test named `synthetic: …`. Real calls run in a new `src/live-classify.test.ts`, which `npm test` already excludes (`package.json:14`) and RL-03 adds by name to the `test:live` script (`package.json:15` lists files, not a glob), plus RL-12. Reason: a full live suite would bill every run | Every classifier test calls the live API |
| D22 | Card count: recounted from the catalogue at minting (§17 pass 1); today 179 classifier and profile-type cards (174 rows, WK-03…WK-08 counted as six) plus 20 RD cards, not v2's 314 | v2's extra ~130 cards repeated the same mechanics per command (§14 #32), which you rejected as duplication. Each card is still minted as a full TRDD with goal, files, reuse, numbered steps and an Acceptance checklist (template and four worked examples in §16); minting runs one group at a time and each batch is reviewed against the template before it is committed (§17) | Split cards further (for example one card per edge row) to reach 300+ |

## 2. Context and your rulings (verbatim)

- "complete all TRDDs then publish and install"
- "after that you must implement a new feature: classifiers, aka system-one models inference. In the specific: using the model jev via openrouter. ## Projects to distill into llm-ext cli commands (all functionalities must be reproduced by llm-ext): https://github.com/jkudish/jev-mcp https://github.com/jkudish/jev-browser ## documentation, skills and other projects potentially integrable in llm-ext (you decide): [OpenRouter decisions API, typesafe-sdk, jev-router, jev-tutorial, jev guide, MorenoLand/Moreno.Jev, buchmark/claude-jev, Pleo2/awesome-jev-agent-skills, NiazMorshed2007/jev-review, OpenRouterTeam/typescript-sdk, OpenRouterTeam/skills, OpenRouterTeam/typescript-agent] Study all and enter plan mode to start. then fan out subagents and use tldr-code skill, quicksilver skill, jgrep skill to save tokens."
- "no mcp servers are allowed! every command of the mcp servers must be converted in cli commands of llm-ext"
- "note that the jev-mcp supports many providers. you only need to support openrouter."
- "the playwright dependency must be optional. in the sense that if the user machine has no playwright installed and working, then the commands using the browser will not be enabled, and will return a error saying to install playwright before using them."
- "the various classification commands must be implemented as llm-ext cli commands and skills."
- Answers 2026-10-07: release order "Finish 14.1.0 first"; skills "Two skills plus references"; extras "classify findings, classify relevance, Label-family presets, use jev in to speedup models comparisons and benchmarks ratings every time a model is updated/added/removed/repriced/failed."
- "check the plan for errors, inconsistencies and missing things and potential issues. improve the plan. make it much more detailed and make it produce hundreds of TRDDs, with actionable steps and checklists"
- "the --profile flag can still be used, but classifier profiles are incompatible with normal profiles, so the two must be distinct in the config xaml and classifiers (system-one) commands must only accept if the field "profile-type" is equal to "classifier". and in the same way the normal (system-two) models must not accept classifiers profiles types."
- "by default exists only one classifier profile, the one using openrouter jev-latest model. note that classifier type profiles can add specific configurations that only make sense for system-one models. see the typesafe-sdk and the openrouter decision api for examples. decide yourself on the rest. i leave it to you this delicate plan."
- "so the default profiles are now 4: free, paid, scouting, or-jev" then "sorry i forgot local.. they are 5 then.. add local"
- 2026-10-07 (classifier spending): "do not put limits on spending on jev. only if opt-in with --max-budget=99.9 . in general the classifier is paid. there is no" (cut off), then, to the reading "there is no free tier, so no paid switch": "exactly"
- 2026-10-07 (README table layout): "i would make the table like this: SUPPORTED PROFILE TYPES |command name|       command description     | free | paid | classifier | scouting | local | -------------------------------------------------------------------------------------------- |code-review | report errors in source files |  ❌  |  ❌  |     ❌     |    ❌    |  ❌   | etc."
- 2026-10-07: "of couse when not supported is ❌  and when supported is ✅"
- 2026-10-07: "you can deduce yourself the other commands accepted profiles."
- 2026-10-07 (README compatibility table): "and in the readme you need to add a table that will divide the commands in those 5 categories, with some commands compatible with 2 or more categories. for example mass scouting command is not compatible with paid, local, classifier or free, but only with scouting profile type. instead the plain code review is a command that is compatible with local, free and paid, but not with scouting and classifier. classifier-code-review instead is a command only compatible with the classifier type profiles. etc."
- 2026-10-07 (profile types): "for example the various mass scouting/mass sesrch/mass classification/etc. commands are only compatible with the scouting profiles (in fact i would say that the profiles types are 5: local type, free type, paid type, scouting type and classifier type. the user can create its own custom version of them and using their specific syntaxes/special fields unique to each of the 4 types. so if the user creates a ts-jev profile it must use the or-jev profile as template for the classifier profile type. if he creates a custom scouting profile he must use as template the scouting profile for the scouting profile type. and so on for all 5. this also simplify things, since the 5 default profiles are also the templates for the 5 types of profiles."
- 2026-10-07, answering D25: "yes, but with costs measurements added too for the commands using each of the 4 default profiles." then "(of course, only if a profile is compatible with the command)"
- 2026-10-07: "i also like very much the way quicksilver presents the commands in the readme, with graphs, benchmarks and cli commands examples. improve the llm-externalizer plugin readme to use the same style in describing all commands (not only the classifiers)."
- Rejection of plan v3 as revised through review round 2 (2026-10-07): "implement all the commands that makes sense and are cheaper than the alternative way. Add also this project's commands (this is easy, since it is already in cli form): https://github.com/UditAkhourii/quicksilver"
- Rejection of plan v2: "the plan is lacking a sound design. many classifier commands replicate code parts that could be modularized into few helper functions shared among the various commands. common classifier behaviours must be separated by the exact prompt detaile of each command, chunk splitting for big files can be handled by a centralized function taking the parameters and limits of the classifier model and serving all commands. the architecture could be built on layers of functionalities from the most common and basic to the upper layer with unique code for the specific command. benchmaqrks can be modulariźed too. single source of truths mustbe estabilished. also you must study the jev-mcp more along with the other projects i linked, because you missed many important things. also there are many errors and flaws in the TRDD and in the plan. improve the plan much further, read the projects sources to get all the special cases, edge cases and exceptions. and for missing edge cases, add them yourself. also documentation is also to plan accurately, including the skills in some projects about jev."

Facts that shape the design: Jev is called with `POST /api/alpha/decisions` or `/api/v1/systemone` (identical schemas), body `{model, state, questions}` + optional `provider`, `session_id`, `user`, `trace`; answers are typed (noul/choice/score) with probabilities; no generation; `usage {input_tokens, output_tokens, cost?}` required; 32,000-token context for state + questions; $0.042/M input, output free; run-to-run noise exists even on one snapshot; `~typesafe/jev-latest` aliases `typesafe/jev-1.13`, whose dated build (`-20260917`) is what responses report.

## 2b. What each linked source contributes

Study reports: `reports/jev-classifiers/` (dated 2026-10-07).

| Source | Taken | Owner cards | Not taken, and why |
|---|---|---|---|
| jkudish/jev-mcp | all 12 tools (gate as `review --claims`, D27), thresholds, policies, hook example as `decide --hook`, edge cases | SP-01…SP-11, C4-05 | MCP server (your ruling); its multi-provider code (OpenRouter only); 3 id strategies, inline budgets (D14, planner) |
| jkudish/jev-browser | the whole `browse run` loop, extraction, credentials, recording, statuses | BR-*, SP-20, SP-21 | MCP stdio/HTTP server and library export (D18) |
| OpenRouter decisions API reference | wire schema, 12 error codes, 402 variants, retry set | L0-*, L1-* | — |
| typesafe-sdk page | `/api/v1/systemone` endpoint, bare model ids | L0-09, PF-07 | the SDK itself (plain HTTP is enough; its `models.list()` does not work against OpenRouter) |
| jev guide (community hub) | primitives, the 32k context rule, "no explanations" limit | DOC-01 | — |
| jev-tutorial | "all independent questions about one state in one request" (planner packing rule), confidence guidance | L2-01, DOC-01 | — |
| jev-classification cookbook | worker-pool concurrency pattern (8 workers, halve on 429), measured accuracy by confidence band | L2-04, DOC-05, EV-02…EV-04 | — |
| jev-router | nothing built. INFERRED, not tested: `typesafe/jev-router` is a chat model that a free or paid profile could name, but its price is `-1` (variable), which llm-ext's price checks may reject; not documented unless checked | — | a `plugins: [jev-router]` option (no user request) |
| OpenRouterTeam/typescript-sdk | wire types as the cross-check for L1, `?output_modalities=decisions` discovery, attribution headers | L0-07, L0-11, L1-01 | the SDK dependency |
| OpenRouterTeam/skills (`openrouter-decisions`) | the 7-step method, the limits table (literal reading, no counting or math, uncalibrated score), the "probe with real inputs" rule; its `lib.ts` strictness as validation baseline | DOC-01, L1-06, EV-* | analytics skills (unrelated); its text is rewritten because no licence is declared (D17). Its "never use an alias" rule conflicts with your `jev-latest` ruling: kept your ruling, the served build is recorded on every result and the drift watcher reports changes |
| OpenRouterTeam/typescript-agent | nothing (zero Jev references, verified by search) | — | tool loop and MCP package are out of scope |
| buchmark/claude-jev | findings, relevance (as `rank --head`), `ask --source`, two-limit token budget, secret deny list, char-class estimate | SP-14, SP-07, C4-04, L2-06, L1-07 | `pick` (covered by decide), hypotheses (D4) |
| MorenoLand/Moreno.Jev | `review_test_output` | SP-17 | triage, review_code, review_diff, check_hypothesis (D4) |
| Pleo2/awesome-jev-agent-skills | two label-family checks (`invariant-check`, `criterion-vs-tests`), skill-copy drift pattern | SP-13, DOC-02 | three checks that duplicate verify, audit, test-output (D4, D15) |
| NiazMorshed2007/jev-review | nothing built: its 19-metric loop overlaps `review` and has no evidence its scores mean anything (D4) | — | the whole quality loop |
| UditAkhourii/quicksilver (you added it; installed 0.3.0 differs from the repo's 0.2.0, D28) | filter, classify, rank, find, ask merged into the classify commands; the chunker and merge rules (§5); the input rules: git-aware walk, secret list, lock/minified/map skips, symlinks off by default, binary detection, 100 MB cap, `--max-bytes`, `--limit`, `--items`, `--lines`, `--ext`; output formats and the receipt | §5, L2-06, L2-19, SP-03, SP-04, SP-05, SP-07, C4-04, C4-12 | setup, other providers and failover, `--fast` packing, separate status (D31); its "86% fewer tokens" claim is not reused (bench ran 0.2.0, quicksilver tokens were estimated, no dollar baseline) |

## 3. Architecture (layers; a layer imports only lower layers)

All paths under `scripts/llm-ext/src/`. Classify and browse share L0–L2. Playwright is imported only in `browser/`.

| Layer | Modules | Responsibility | Must NOT | Reuses |
|---|---|---|---|---|
| **L0 wire** | `classifiers/l0/transport.ts`, `l0/catalog.ts`, `l0/errors.ts`, `l0/deadline.ts` | One HTTP call site; decisions catalog; error taxonomy; deadline + abort composition (in L0 because the transport uses it) | Know any question, threshold or command | `computeBackoffMs`, `sanitizeProviderError` (+ strip `openrouter_metadata`), `safeReadText`, `getCatalog({path})`, `withMkdirLock` |
| **L1 primitives** | `l1/questions.ts`, `l1/validate.ts`, `l1/estimate.ts`, `l1/model-id.ts`, `l1/usage.ts` | Build and check requests; validate answers under a `ValidationPolicy`; token/byte estimate; model ids and snapshots; usage + cost record | Decide policy or thresholds | `recordRequest`, `withUsageContext` |
| **L2 mechanics** | `l2/planner.ts`, `l2/fan-out.ts`, `l2/inputs.ts`, `l2/ids.ts`, `l2/evidence.ts`, `l2/policy-kit.ts`, `l2/cost-cap.ts`, `l2/envelope.ts`, `l2/attention.ts`, `l2/warnings.ts`, `l2/redact.ts`, `l2/report.ts`, `l2/profile.ts`, `l2/abort.ts` | Everything two or more decisions share: split/merge, concurrency, file reading, ids, thresholds math, Ctrl-C handling, spend cap, result envelope, strict-exit, degraded records, redaction, report lines, classifier-profile resolution | Hold any decision's text or default | `sanitizeInputPath`, `scanForSecrets`/`redactSecrets`, `rateLimitedParallel`/`AdaptiveRateLimiter`, `defaultOutputDir` |
| **L3 catalog** | `classifiers/catalog/<decision>.ts` (one per decision, browse step/dropdown included), `catalog/index.ts` (registry) | The only home of: input schema, limits, question texts, criteria, default thresholds, state shape, pure policy, attention predicate, split class, injection placement, validation policy choice | Do I/O | — |
| **L4 entry** | `classifiers/run-decision.ts` (one generic runner), `classifiers/commands/{hook,ask,models,ping}.ts` (bespoke adapters), `browser/*` (browse), wiring in `tools/definitions.ts`, `index.ts`, `cli/launcher.ts`, `cli/main.ts` | Parse flags, resolve profile, call L2/L3, emit | Re-implement anything below | `Deps` seam pattern of `text-tools/core.ts` |

Key signatures (TypeScript):

```ts
// L0
type GlobalFetch = (url: string, init: RequestInit) => Promise<Response>;
interface DecisionsCall { endpoint: "decisions" | "systemone"; model: string; state: unknown; questions: Record<string, Question>;
  provider?: ProviderPreferences; sessionId?: string; user?: string; trace?: TraceConfig; }
interface RawDecisionsReply { model: string; answers: Record<string, unknown>; usage: { input_tokens: number; output_tokens: number; cost?: number }; id?: string; provider?: string; }
function callDecisions(call: DecisionsCall, opts: { key: string; deadline: Deadline; maxAttempts: number; fetchImpl: GlobalFetch }): Promise<RawDecisionsReply>;
interface DecisionsModel { id: string; canonicalSlug: string; aliasTarget?: string; contextTokens: number | null; promptUsdPerM: number | null; outputModalities: string[]; systemOne: boolean; }
function loadDecisionsCatalog(deps): Promise<DecisionsModel[]>;              // ?output_modalities=decisions, cached
function resolveModel(id: string, catalog: DecisionsModel[]): DecisionsModel; // alias → target for limits/price
// L1
type Question = { type: "noul"; instructions: Text; criteria?: { true: Text; false: Text } } | { type: "choice"; instructions: Text; criteria: Record<string, Text | null> } | { type: "score"; instructions: Text; criteria: Text[] };
interface ValidationPolicy { sum: "fixed" | "scaled"; tie: number; score: "expected-value" | "integer-index"; confidence: "reject" | "coerce-null"; probabilities: "required" | "optional"; legend: "ignore" | "require"; }
function validateAnswer(q: Question, a: unknown, p: ValidationPolicy): Valid<Answer> | Invalid;
function estimateTokens(v: unknown): number;                                 // char-class, rounds up
// L2
interface ModelLimits { contextTokens: number; envelopeTokens: 64; maxRequests: number; concurrency: number; maxQuestionsPerRequest?: number; }
function planRequests<U>(job: SplitJob<U>, limits: ModelLimits): Plan<U> | Refusal;
function runPlan<U>(plan: Plan<U>, exec: (r: PlannedRequest) => Promise<RawDecisionsReply>): Promise<MergedReply>;
function readForJev(path: string, mode: { kind: "whole" } | { kind: "head"; bytes: number } | { kind: "lines"; from: number; to: number } | { kind: "window"; line: number; radius: number }): Promise<Snippet>;
// L3
interface DecisionSpec<I, R> { id: string; input: ZodType<I>; thresholds: Record<string, ThresholdSpec>;
  split: SplitClass; injection: "index-scoped" | "params-in-instructions"; validation: ValidationPolicy;
  build(i: I, t: Thresholds): Built; project(answers: Answers, i: I, t: Thresholds, ctx: ProjectCtx): R; attention(r: R): boolean; }
// L4
function runDecision<I, R>(spec: DecisionSpec<I, R>, argv: string[], deps: RunDeps): Promise<ExitCode>;
```

## 4. Single sources of truth

| Fact | Owner (only file) | Read by |
|---|---|---|
| Question text, criteria, state shape, default thresholds + ranges, policy, attention predicate, split class, injection placement, validation-policy choice | `catalog/<decision>.ts` | `run-decision.ts`, browse loop, classify-eval, docs check, definitions check |
| Model limits (context, price, alias target, System One flag) | decisions catalog via `l0/catalog.ts` | planner, estimate, cost cap, profile validation, models command |
| Profile `context_tokens` | only an override when the catalog reports 0/unknown | planner |
| Validation tolerances | `l1/validate.ts` policy presets | every caller |
| Error classes and messages | `l0/errors.ts` | all |
| Retry/backoff rules | `l0/transport.ts` | all |
| Classifier profile schema | `config.ts` `validateClassifierProfile` | load, CLI routing, docs |
| Opt-in spend cap (`--max-budget`) | `l2/cost-cap.ts` | runner, hook, browse |
| Secret-path deny list | `l2/inputs.ts` (quicksilver 0.3.0 `SECRET_RE`, qs I:27, merged with the claude-jev list) | all file readers |
| Input walk rules (git-aware listing, skips, caps) | `l2/inputs.ts` (quicksilver 0.3.0 rules, qs I:640-783) | all classify commands with file inputs |
| Chunker and chunk-merge rules | `l2/planner.ts` (§5) | every caller |
| Profile types and each type's fields | `config.ts` field table (PT-01) | validation, templates, `settings new`, docs |
| Which profile types each command accepts | `acceptedProfileTypes` in `tools/definitions.ts` (PT-03) | runtime check, `--help`, README table (RD-20), RD-19 compatibility from 14.2.0 on |
| Content secret redaction | one of the two existing `redactSecrets` (`scan-pipeline.ts:487`, `security_scan/intake.ts:91`): L2-07 runs both over one shared fixture set, adopts the one that catches more, and files a follow-up card for any pattern only the other catches. No third copy | `l2/inputs.ts` |
| Usage/cost record | `l1/usage.ts` | all |
| Jev usage rules for humans | `skills/_shared/jev-protocol.md` | both skills (drift-checked copies) |
| Command flags/defaults text | catalog spec; `definitions.ts` entries checked against it by test | help, README check |

## 5. Central request planner (`l2/planner.ts`)

- **Input** `SplitJob`: `sharedState` (sent with every request), `units[]` (each: its own state part + its questions), `unsplittable` questions (must be in one request with all units they reference), `renumber(units, offset)` (rewrites `claims[i]`-style references per chunk), `merge` rule.
- **Limits** from the resolved catalog model: `contextTokens = min(context_length, endpoint max_prompt_tokens)`; 0/null → profile `context_tokens` required, else refuse. If probe P-01 shows a second limit (state + longest question, claude-jev's 32k-of-64k model) it is added to `ModelLimits`, nothing else changes.
- **Unit kinds:** `atomic` (a claim, item, record: never split) and `text` (a file, log or document body). A `text` unit larger than `--chunk-chars` (default 60,000, range 1,000–90,000, kept under the model limit) is cut by the planner with quicksilver 0.3.0's rule (D28): the end is pulled back to just after the last newline if that newline is at least 500 chars past the chunk start, else the cut falls mid-line; the next chunk starts 500 chars before the end, snapped forward to the next line start, so overlap is at most 500 chars; each chunk records its 1-based line range. Nothing is truncated.
- **Chunk merge (one rule set for every caller):** yes/no answers take the highest `noul`; score answers the highest `score`; choice answers the highest `confidence`, where a chunk whose top label is the default label (`--default`, else the last label) does not vote, and an item with no voting chunk gets the default label at its best confidence. Ties go to the earliest chunk; a null confidence counts as lowest. The result carries `chunks` and `best_lines`. Because any chunk can make an item pass, docs tell users to ask positive questions.
- **JSON states:** an object or array larger than one chunk is split into groups of whole top-level entries; a single entry larger than one chunk is refused naming the key.
- **Rules:** JSON-mode `atomic` units that share a state (label items against one catalog, verify claims against one evidence, audit records against one source) are packed greedily in input order, as jev-mcp does, because re-sending the shared state per item would multiply the cost; independent file-mode `text` items (each with its own content) go one item or chunk per request, as quicksilver does by default (D31: no packing of independent items); each request = shared state + units + questions ≤ limit − 64; an `atomic` unit that alone does not fit → refuse naming the unit (never truncate); more than `maxRequests` → refuse with the count; questions ≤ `maxQuestionsPerRequest` when set.
- **Truncation** is a spec decision, never the planner's: audit, whole-diff review (`--claims` included) and extract truncate-and-flag in `build` (per jev-mcp), and the incomplete-context policy demotes `auto` to `review`; every file, directory, glob or stdin input uses `text` chunks instead and never truncates.
- **Execution** `runPlan`: `rateLimitedParallel` with `concurrency`; one shared pause on 429/in-flight 402 (`AdaptiveRateLimiter`); answers merged by key; usage summed; every distinct snapshot kept (more than one → warning).
- **Partial failure:** a request that fails → its units become `invalid_response` (per-item specs) or the whole result fails (whole-result specs), as the spec's split class says.

| Caller | Unit | Shared state | Merge | Unsplittable |
|---|---|---|---|---|
| verify | claim (2–3 q) | evidence | concat, renumber `claims[i]` | — |
| filter | item or chunk (`text` from files/lines/stdin, or a JSON proposition) | context | highest noul per item | — |
| label | item or chunk | catalog, purpose, context | default-label no-vote rule; id-set join check (exa rule) | — |
| find | candidate (JSON) or line-chunk of ≤ `--chunk` lines (files) | query | file mode: score = p(where) × p(exists) per line, dedupe by `file:line`, top N | `where`/`best`, `exists` per request |
| rank | item or chunk | query (in instructions) | highest score per item, global sort; `--head N` sends only the first N bytes | — |
| screen | — | text | — | all (refuse over limit) |
| compare | aspect | passages | concat | `overall` |
| decide | — | all | — | all (≤19 q) |
| extract | field | document | concat | — |
| audit | record | source | concat, renumber `records[i]` | — |
| review (whole, `--claims` optional) | claim (with `--claims`) | diff, request, evidence | review compose + claims | review half |
| review (per-file) | file chunk | request, tests | highest risk per file, then per-file compose, renumber `files[i]` | — |
| findings | finding (4 q) | task, intent, source windows of that finding | sort keep/keep_low/drop | — |
| test-output | log chunk around grep-found failures | — | highest regression probability | — |
| check (presets) | — | preset state | — | all |
| ask | state chunk | — | every question sent with every chunk; per-question chunk merge | user-declared |
| browse step | — | page state | — | all (maxRequests 1; overflow → trim rule of BR-07) |
| browse dropdown | — | dropdown state | — | all |
| classify-eval | dataset item | — | per item | per spec |

## 6. Validation policy (`l1/validate.ts`)

| Field | Values | Default |
|---|---|---|
| `sum` | `fixed` 0.01 / `scaled` min(0.05, max(0.01, 0.005·nonzero)) (+1e-9) | scaled for all |
| `tie` | 1e-9 / 0.001 | 0.001 |
| `score` | `expected-value` (float in [0,N−1], within tol of Σi·pᵢ; tol = 0.02 + 0.005·N(N−1)/2) / `integer-index` | expected-value |
| `confidence` | `reject` (present but malformed → invalid) / `coerce-null` | reject for verify relation (jev-mcp), coerce-null elsewhere |
| `probabilities` | `required` / `optional` | required for choice (fail closed), optional for score |
| `legend` | `ignore` / `require` | ignore |

Answer-set rule: a missing answer → that question invalid; an extra answer key → ignored and logged; an explicit wrong `type` → invalid; absent `type` → accepted. Probe P-01 and spike P-04 fix the final tolerances from real fixtures; a fixture that the chosen policy rejects fails the build.

## 7. Transport and errors (`l0/transport.ts`, `l0/errors.ts`)

- Seam: `GlobalFetch` returning a real `Response` (headers needed); never the header-less `FetchImpl`, never `realFetch` (free-rotation wrapped).
- Request: `redirect: "error"`; headers `Authorization: Bearer`, `Content-Type`, `HTTP-Referer: https://github.com/Emasoft/llm-externalizer-plugin`, `X-OpenRouter-Title: llm-externalizer`; refuse if the serialized body contains the resolved key (exact string only).
- Deadline: one per call (`timeout_ms`, default 60,000) across attempts, combined with the caller's abort signal; browse passes its run deadline.
- Retry (`max_attempts` default 3, clamp 1..6): 408, 409, 429, 500–599 (incl. 524, 529); 402 only with `limit_source: openrouter_in_flight_budget`. Wait = max(`computeBackoffMs`, `retry-after-ms` or `Retry-After` seconds/HTTP-date), cut at the deadline. Body drained before waiting. Never retried: network errors, timeouts, 400, 401, 403, 404, 413, other 402.
- Body: `safeReadText(res, 1_000_000)`.
- Errors carry: `status`, class (`auth`, `payment`, `in-flight-budget`, `key-limit`, `rate-limited`, `unavailable`, `context-overflow`, `bad-request`, `not-found`, `too-large`, `network`, `timeout`, `bad-response`), `limit_source`, `reason`, `provider_code`; message via `sanitizeProviderError` with `user_id`, `sk-…` and `openrouter_metadata` stripped. Status always kept (jev-agent-tools loses it; do not copy). `max_tokens_exceeded` → `context-overflow` with the exact OpenRouter body captured by P-01.
- Response: 200 with unparseable JSON, non-object `answers`, missing/blank/non-string `model`, or bad `usage` → `bad-response`. Usage and cost are recorded from the raw reply **before** answer validation (so invalid but billed replies are counted).
- Snapshot: the reply `model` is the served build; recorded on every result.

## 8. Profiles

Your rulings: five profile types, `local`, `free`, `paid`, `scouting`, `classifier`; the five built-in profiles are the templates of their types; a custom profile is a copy of its type's template with that type's own fields; every command accepts only compatible types. Facts below come from the profile-code study (2026-10-07), paths under `scripts/llm-ext/src/`.

**Today (VERIFIED):** no profile has a type. The code infers it from the name (`DYNAMIC_PROFILE_NAMES` free/paid/local, `config.ts:1023`; `scouting` by literal name, `mass_scouting/cli.ts:533`), from `free_only` and from `mode`. Fresh install writes free, paid, local with placeholder models (`renderDefaultSettingsYaml`, `config.ts:1553`). `scouting` is written only by `benchmark scout-accuracy`, with no marker, lock or backup (`benchmark/pick.ts:603-618`). `--profile` accepts any profile for any command (`cli/main.ts:584-603`). Under a free-only active profile, mass scouting runs on the free pool and never reads `scouting` (`mass_scouting/cli.ts:549-561, 605-606`). Migrations touch only built-in sections and back the file up first (`benchmark/pick.ts:942-975`).

**Type field.** `profile-type: local | free | paid | scouting | classifier` (D20 keeps your spelling). When a profile has no `profile-type`, it is inferred once with today's rules: the names `free`, `paid`, `local`, `scouting` give that type; else `free_only: true` → free; else `mode: local` → local; else paid. Migration PT-02 then writes the inferred value into every existing profile (D32), so after it runs the field is always explicit and inference code is deleted. Any other value fails at load.

**Templates and fields per type** (the built-in profile of each type is its template; one field table, owned by `config.ts`, drives validation, the templates and `settings new`):

| Type | Template | Fields of this type only | Shared fields |
|---|---|---|---|
| local | `local` | `api_token`, `detected_providers` (generated) | `mode: local`, `api` (a `-local` preset), `url`, `model`, `free_models` (fallback chain), `timeout`, `context_window`, `tool_models`, `providers` |
| free | `free` | `free_only: true` | `mode: remote`, `api`, `api_key`, `model`, `free_models` (`:free` ids), `timeout`, `context_window`, `tool_models`, `providers`, `high_quality_model` |
| paid | `paid` | `selection.price_ceiling_usd_per_million`, `ensemble` | `mode: remote`/`remote-ensemble`, `api`, `api_key`, `model`, `paid_models` (no `:free` ids), `timeout`, `context_window`, `tool_models`, `providers`, `high_quality_model` |
| scouting | `scouting` | scout-accuracy pass record (written by the benchmark) | `mode: remote`, `api`, `api_key`, `model` (no `:free` ids, refused by `buildScoutingProfile`) |
| classifier | `or-jev` | `endpoint`, `max_requests_per_call`, `concurrency`, `timeout_ms`, `max_attempts`, `context_tokens`, `provider`, `session_id`, `user`, `trace` | `api: openrouter-remote`, `api_key`, `model` |

A field of another type fails at load naming the field and the type it belongs to (D33). The `paid_models` list written into `scouting` today is never read (`profile-fallback.ts:179-185`); PT-04 stops writing it.

**Five built-in profiles, written on a fresh install** (D19): `free`, `paid`, `local` (placeholders, self-populating as today), `scouting` (placeholder; mass scouting refuses with "run `llm-ext benchmark scout-accuracy`" until the benchmark fills it, PT-04) and `or-jev` (`~typesafe/jev-latest`, `active_classifier: or-jev`). All five carry the generated marker. Existing installs get `scouting`'s marker and `or-jev` through migrations (PT-04, PF-04), with backups.

**Custom profiles.** `llm-ext settings new <name> --type <type>` copies that type's template into `settings.yaml` under the new name (PT-08); a hand-written profile is validated against its type's fields the same way.

**Which types each command accepts** (deduced per your ruling "you can deduce yourself the other commands accepted profiles"; your three examples are fixed rows; every other row cites the code it was read from and is yours to veto). Stored once as `acceptedProfileTypes` on each command in `tools/definitions.ts`; the runtime check, `--help` and the README table (RD-20) all read it (PT-03):

| Command | local | free | paid | scouting | classifier | Evidence |
|---|---|---|---|---|---|---|
| `llm *` (ask, summarize, topics, sem-deduplicate, describe, …) | ✓ | ✓ | ✓ | — | — | profile chain, `profile-fallback.ts:173` |
| `scan` file/folder review (your "plain code review") | ✓ | ✓ | ✓ | — | — | your ruling |
| `scan impl` (search-existing) | ✓ | ✓ | ✓ | — | — | `index.ts:5822-5836` (INFERRED) |
| `scan quality` | — | — | ✓ | — | — | refuses free mode and non-OpenRouter, `config.ts:2934-2960` |
| `scan security` | — | — | ✓ | — | — | refused in free mode, `default-profiles.ts:327-331`; OpenRouter model, `mass_scouting/cli.ts:2086-2110` |
| `check *` | ✓ | ✓ | ✓ | — | — | profile chain, `cli/launcher.ts:46-68` (INFERRED, verified in PT-03 step 1) |
| `scout run`, `chain`, `propose-fieldset`, `estimate`, `register`, `preclassify` | — | — | — | ✓ | — | your ruling (mass scouting) |
| other `scout` actions (local SQLite) | no model call: any type | | | | | `default-profiles.ts:318-320` |
| `session compact` | ✓? | ✓ | ✓ | — | — | own catalog selector `selectModels`, `index.ts` ~5105 (free/paid INFERRED; the local cell is a guess, verified in PT-03 step 1 and set to — if the selector cannot use a local model) |
| `models *` | no model call, or picks its own candidates: any type | | | | | `default-profiles.ts:321-325` |
| `benchmark *` | targets named per subcommand (`--populate-default-profile` free/paid/local, `scout-accuracy` → scouting, `classify-eval` → classifier) | | | | | `benchmark/cli-args.ts:419-427` |
| `settings *` | any type | | | | | must run with no resolvable profile, `config.ts:1183-1188` |
| `classify *` (incl. `review`, your "classifier code review") | — | — | — | — | ✓ | your ruling |
| `browse run` | typing profile ✓ | ✓ | ✓ | — | decisions profile ✓ | two profiles: `--profile` (classifier) and `--typing-profile` (local/free/paid) |
| `browse doctor` | no model call: any type | | | | | — |

- Selection: `--profile` and the active profile are checked against the command's `acceptedProfileTypes`; a mismatch fails naming the command, the profile, its type and the accepted types (E80, E81). Defaults: `classify` uses `active_classifier:`; mass scouting uses `scouting`; text commands use `active:` (which must be local, free or paid). Fallback walkers stay inside one type.
- Classifier schema: `profile-type`, `api: openrouter-remote`, `api_key` (`$VAR`), `model`, `endpoint` (`decisions` default | `systemone`), `max_requests_per_call` (8), `concurrency` (8), `timeout_ms` (60000), `max_attempts` (3), `context_tokens` (**override only when the catalog reports none**), `provider` (**strict OpenRouter ProviderPreferences keys**), `session_id`/`user` (≤256), `trace` (**known keys plus custom keys allowed**). Unknown keys fail.
- **When checked**: the schema is checked at load (offline). Checks that need the catalog run when a profile is selected for a run (the catalog is loaded then anyway) and in `settings validate`; loading settings never touches the network.
- **Decisions guard**: a free, paid or scouting profile whose model appears in the **cached** decisions catalog (read at any age, never refreshed by this guard; the freshness rule below applies to classifier selection only) fails when selected (replaces the `typesafe/jev-*` regex, which missed 13 of 14 models). The guard never fetches the catalog for these profiles and skips local profiles, so scan, llm and scout runs gain no network dependency; with no cache the guard is skipped and the provider's own error surfaces.
- **`endpoint: systemone`** allowed only for models whose catalog entry declares System One or `typesafe/*`.
- **Model**: must exist in the decisions catalog (alias resolved through `alias_target`); a missing model fails when selected, naming the model and the model-info command's Jev filter (C4-06).
- **Catalog freshness**: the cached decisions catalog is used within its TTL; an expired cache plus a failed refresh is an error, not a silent use of stale data.
- **Spend** (D2): classifier calls are paid by design and never gated or capped by default; `--max-budget=<usd>` is the only cap, opt-in per run. `allow_paid_models` keeps governing chat profiles only; its docs say it does not apply to classifiers.

## 9. Commands (L3 specs; per-decision data lives in the catalog files)

Columns: unique data (source), `--strict-exit` attention, injection (D5). Every jev-mcp tool and every quicksilver command is covered, merged where they make the same decision (D27, D29): `jev_noul` + qs `filter` → `classify filter`; `jev_classify` + qs `classify` → `classify label`; `jev_rerank` + qs `rank` + claude-jev relevance → `classify rank`; `jev_find` + qs `find` → `classify find`; `jev_gate` → `classify review --claims`; hook example → `classify decide --hook`; qs `ask` + claude-jev `jev_ask` → `classify ask`. Input modes shared by every command (§5, L2-06): JSON (`--input file.json` or stdin) or quicksilver's files/directories/globs/`-`/`--items`/`--lines`. Line ranges are `server.ts` ranges marked VERIFIED in the jev-mcp inventory report; `qs I:n` means line n of quicksilver 0.3.0's `qs.mjs`, the version D28 ports; report paths cited in this plan live outside the repo (a local `reports/` folder beside it) and are local evidence only. Each command passed the cost test (cost study, D27).

| Command | Unique data (study source) | Attention | Injection |
|---|---|---|---|
| `classify verify` | relation/subject/source questions, `none` sentinel, subject_at 0.5, auto 0.8 (jev-mcp server.ts:170-310) | review, contradicted, unknown | index-scoped |
| `classify screen` | injection/substance/relevance nouls, block 0.75, review 0.25, skip 0.3 (315-391) | action ≠ pass | purpose in instructions |
| `classify filter` | `p_i<i>` noul (D14 index keys), auto 0.85, `p+auto≤1` rule (jev-mcp 396-499); qs filter: `--threshold` 0.5, `--band` 0.15 borderline section, matched/borderline lists, `--lines` repeat-collapsing with `--no-collapse`, `--save` (qs I:923-980). One band set in the spec: `matched` = p ≥ threshold; `borderline` = |p − threshold| < band; `auto` = p ≥ auto, where auto ≥ threshold + band is enforced; `matched` drives the text list, `auto` the JSON field | invalid, any `auto:false`, any borderline | question/proposition in instructions |
| `classify find` | best/exists, 0.7/0.35 (jev-mcp 504-570); file mode: `where` choice over line keys + `none`, `exists` noul, `--chunk` ≤ 250 lines, `--min-score` 0.05, `--top` 5, line pieces `N.k` (qs I:1075-1120) | exists ≠ answered, invalid, no lines | query in instructions |
| `classify label` | item/class catalog, auto 0.85, margin 0.5, 8000 budget, null-proto (jev-mcp 576-743); qs: `--labels "a:hint,b"` / `--labels-json`, 2–255 labels, `--default`, `--min-confidence` 0.6, `--only`, `--verbose`, runner-up shown for low confidence (qs I:991-1043). One band set: `accepted` = confidence ≥ min-confidence; `auto` = confidence ≥ auto and margin met, where auto ≥ min-confidence is enforced; `accepted` drives the text listing, `auto` the JSON field | review, invalid, low confidence, caller `manual_review` | items moved to state |
| `classify decide` (+ `--hook`) | recommendation/checks, hatches, escalate flag (jev-mcp 749-898); `--hook`: Claude Code PreToolUse adapter (examples/hook-gate.mjs), D1 | escaped, escalate, invalid, warnings | descriptions in criteria |
| `classify rank` | qs 5-level relevance rubric, relevance = score/4, `--top` 10 / `--all` (qs I:1046-1070); jev-mcp 100k budget and per-file best chunk (903-1008); `--head N --keep-at P` (claude-jev relevance) | invalid | candidates moved to state |
| `classify compare` | overall/aspect relations (1013-1102) | review, invalid | aspect in instructions |
| `classify extract` | regex worker, none_of_them, status order (1111-1286); Jev called only for fields with 2+ regex matches (cost study) | not_found, review, invalid_pattern, invalid | candidate values in criteria (exception) |
| `classify audit` | 4 checks + absence, max-gated, wrong_at 0.7 (1294-1461) | action ≠ pass | index-scoped |
| `classify review` (+ `--claims`) | 4 scores + safe_to_apply, composite, reason codes (1473-1880); `--claims` adds jev-mcp gate's claim checks and reason codes (1882-2126); routes to review, never authorises (scores uncalibrated) | action ≠ auto | index-scoped |
| `classify ask` | raw `{state, questions}` file or `-`, or `"<question>" --state @f|text|-` with `--choice "a,b"` / `--score "x|y|z"` / `--default`, or `--source path:from-to` (qs I:1146-1192, claude-jev jev_ask) | any invalid | user-owned |
| `classify check --preset` | invariant-check, criterion-vs-tests (awesome-jev, D15) | label ≠ positive per preset | index-scoped |
| `classify findings` | real/reachable/already_handled/severity(4), 0.5/0.7/0.4 (claude-jev review.ts) | any keep | index-scoped |
| `classify test-output` | grep-found failing blocks first; failure_class, likely_code_regression, severity, evidence_sufficient (Moreno jev_mcp.py:213-247) | regression ≥ 0.5 or insufficient | index-scoped |
| `classify ping` | free `GET /api/v1/key` + one noul (or `--no-call`) | failure | n/a |
| existing model-info command + Jev filter | decisions catalog rows (`?output_modalities=decisions`), no Jev call (D27) | missing/unusable model | n/a |
| `browse run` (incl. `--max-steps 0`, D30), `browse doctor` | §10 | status ≠ done/goal_achieved | page text in state |

Every classify command prints quicksilver's receipt as its last line (stderr under `--json`): items scanned, skipped files, time, Jev tokens and cost, model, and "~N Claude tokens not read" (qs I:881-894); lifetime totals go into llm-ext's usage history (L1-10, D31). Exit codes follow llm-ext's existing conventions; the qs mapping (3 key/credits, 4 request rejected, 5 failed after retries) is kept where llm-ext has no code of its own (C4-01 reads `cli/main.ts` first).

## 10. Browse

- Uses L0 transport, L1 validation (scaled policy: a step choice has up to 244 options), L2 deadline/cost-cap/warnings/redact/envelope, catalog specs `browse-step` and `browse-dropdown`.
- `browser/` only: Playwright loader (`createRequire(<data-dir prefix>)`, `LLM_EXT_PLAYWRIGHT_DIR` override), `browse doctor --install` (pinned version, `withInstallLock`), session, extraction, observables, executors, payload, console capture, bot detection, credentials (POSIX only), host guard (`--allow-host`, `--allow-private`), recording.
- Typing: the normal `--typing-profile` (default `active:`) through the existing chat chain; 256 tokens, reasoning off.
- Cost: Jev + typing cost summed and printed; no default cap (D2); with `--max-budget=<usd>` the run ends with status `budget` when the next step would pass it.
- Statuses: the source's `done`, `goal_achieved`, `stuck`, `max_steps`, `timeout`, `blocked`, `error` (with `aborted` reason), plus our `budget`. Every status closes the browser in `finally`. Result object keeps the jev-browser shape (inventory §5.4) inside the llm-ext envelope.
- Per-step fan-out (spec `browse-step`): action choice over pruned elements, goal-achieved noul, stuck noul; second-stage dropdown choice; repeat-no-op recovery picks the next-best action from the previous distribution (no extra call); settle/DOM-stability wait between steps.
- Output: final page in `text|markdown|html|aria` with `--max-chars`; final JPEG screenshot (suppressed after any credential use); `--record` WebM video; `--headed` for debugging only.
- Credentials (ported whole, with every refusal): password filled by code from `--password-file`/`--password-env` (the variable name must start with `LLM_EXT_PASSWORD_`, renamed from jev-browser's `JEV_PASSWORD_*` per your `LLM_EXT_` prefix rule; same for `--cookie-env` → `LLM_EXT_COOKIE_*`) checked against `--password-origin`; seed cookies from `--cookie-file`/`--cookie-env` (mutually exclusive); handoff files consumed and deleted; refused together with recording, with debug env (`PWDEBUG`, `DEBUG`, `DEBUG_FILE`), and screenshot suppressed after use.
- Missing Playwright: `browse run` exits non-zero with "Playwright is not installed — run `llm-ext browse doctor --install`"; `browse doctor` always works. No `peerDependencies`, no `npx playwright install` instructions.
- Search-field keyword fallback (D1), `JUNK_NAMES` kept verbatim and documented as Wikipedia-tuned (study 2), Ctrl-C cleanup (D11).

## 11. Benchmarks (modular)

| Piece | What | Owner cards |
|---|---|---|
| workload-kit (D16) | Extract the md5-identical helpers duplicated across the 6 workloads (key → dataset/fingerprint → catalog → pool → gates → ledger → cached per-model loop → `selectSameOrCheaper` → report) into `benchmark/workload-kit.ts`; characterization tests first, then one migration per workload | WK-01…WK-09 |
| budget decisions branch | `BM/budget.ts` `chargeRequest`/`chargeResponse` learn the decisions shape (input tokens only, output free, `usage.cost` or estimate) | EV-07 |
| `classify-eval` | Labelled datasets per decision spec; runs the real spec through `runDecision` deps; metrics: accuracy, Brier score, abstain/review rate, cost per item, per snapshot; suggests thresholds (never writes them) | EV-01…EV-09 |
| snapshot-drift watcher (free) | On each decisions-catalog refresh, diff `canonical_slug`, `alias_target`, price, presence; append new `ModelEventKind`s; `benchmark classify-eval --if-changed` reruns only when an event is newer than the last run (no spend without your go-ahead, D12) | DW-01…DW-03 |

Jev queue ordering is not built (D3): `benchmark/pick.ts:165` already orders the queue with a free script.

## 12. Edge-case matrix

Src: S = taken from a studied source, A = added by this plan. Every row becomes a named test in its card.

| # | Case | Expected | Src | Card |
|---|---|---|---|---|
| E01 | 200 with HTML body (proxy page) | `bad-response`, sanitized excerpt | A | L0-05 |
| E02 | Body larger than 1 MB | `bad-response` (too large) | A | L0-02 |
| E03 | `Retry-After` HTTP-date in the past | wait = backoff only | A | L0-03 |
| E04 | `Retry-After` beyond the deadline | fail now as `rate-limited`, wait reported | A | L0-03 |
| E05 | `retry-after-ms` and `Retry-After` both present | ms value wins | S cookbook | L0-03 |
| E06 | 402 in-flight budget vs 402 credits/key limit | first retried; second not, `remedy_hint` shown | S API docs | L0-01 |
| E07 | 429 from provider (no `X-RateLimit-*`) vs platform | both retried; class carries `provider_code` | S API docs | L0-01 |
| E08 | 3xx redirect | error (`redirect: "error"`) | A | L0-02 |
| E09 | Connection reset after send | not retried (D7); message says the call may be billed | A | L0-03 |
| E10 | Ctrl-C during a retry wait | stops at once, no further attempt | A | L0-04 |
| E11 | Reply `model` differs from the requested alias | snapshot recorded, no error | S API docs | L0-05 |
| E12 | `usage.cost` missing | estimated, `cost_estimated: true` (D8) | S cookbook | L1-09 |
| E13 | `usage` missing | `bad-response`; nothing recorded as free | S schema | L0-05 |
| E14 | API key text inside state or questions | refused before send | A | L0-02 |
| E15 | Error body echoes `user_id` / `openrouter_metadata` | stripped from message and logs | S API docs | L0-06 |
| E16 | Catalog unreachable, cache expired | error naming the catalog URL | A | L0-07 |
| E17 | Alias model with empty `/endpoints` | limits/price read from `alias_target` | S study 3 | L0-08 |
| E18 | Catalog `context_length: 0` | profile `context_tokens` required, else refuse | S catalog | L2-03 |
| E19 | Profile model later removed from catalog | selection error naming the model and the model-info Jev filter | A | PF-02 |
| E20 | 3-option choice summing 1.01 / 0.97 | accepted / rejected (scaled tol 0.015) | S jev-agent-tools | L1-04 |
| E21 | 60-option choice summing 0.95 | accepted (tol capped at 0.05) | S jev-agent-tools 60-option bug | L1-04 |
| E22 | Top two probabilities within 0.001 | `tie: true`; policies demote to review | S jev-mcp | L1-04 |
| E23 | NaN, negative or >1 probability | invalid | A | L1-04 |
| E24 | Answer names an unknown choice key | invalid | S jev-mcp | L1-04 |
| E25 | Score value outside [0, N−1] or far from Σi·pᵢ | invalid | S jev-mcp | L1-05 |
| E26 | Noul with null probability | invalid | S schema | L1-03 |
| E27 | One answer missing in a multi-question reply | only that item invalid | S jev-mcp | L1-06 |
| E28 | Question-key collision after chunk merge | impossible by construction; asserted | A | L2-02 |
| E29 | CJK / emoji state | char-class estimate counts 1 token per non-ASCII char, rounded up | S claude-jev | L1-07 |
| E30 | Question or criteria key with characters the API rejects | refused at build (pattern from P-01) | A | L1-01 |
| E31 | Choice with fewer than 2 options | refused at build | A | L1-01 |
| E32 | Empty instructions | refused at build | A | L1-01 |
| E33 | Binary file (NUL byte in the first 8 KB) | named single input (`--state @f`, `--items`, spec file, stdin): refused; found while walking: skipped and listed | S quicksilver | L2-06 |
| E34 | `rank --head N`: file longer than N bytes | only the head is sent (the one place a head window applies; size caps are E125) | S claude-jev | SP-07 |
| E35 | Path traversal / symlink leaving the allowed roots | `sanitizeInputPath` refusal | S llm-ext | L2-06 |
| E36 | `.env`, `id_rsa`, `*.pem`, credentials paths | named single input: refused (E124); found while walking: skipped and listed | S quicksilver, claude-jev | L2-06 |
| E37 | Secret inside file content | redacted before send; warning with count | S claude-jev | L2-07 |
| E38 | CRLF and BOM files | line windows correct, BOM stripped | A | L2-06 |
| E39 | Invalid UTF-8 | U+FFFD replacement + warning | A | L2-06 |
| E40 | Empty file | named single input: refused ("empty input"); found while walking: skipped and listed (E123) | A | L2-06 |
| E41 | Directory given to a flag that takes one file (`--state @f`, `--items`, `--labels-json @f`, spec file) | refused | A | L2-06 |
| E42 | One `atomic` unit alone exceeds the limit | refused naming the unit, never truncated | S claude-jev | L2-01 |
| E43 | Plan needs more than `max_requests_per_call` | refused with the needed count | S claude-jev | L2-01 |
| E44 | Unsplittable question plus units exceed one request | refused | S jev-mcp | L2-02 |
| E45 | Per-chunk `claims[i]` references | renumbered and mapped back to global ids | S jev-mcp | L2-02 |
| E46 | One chunk fails, others succeed | per-item `invalid_response` or whole failure by split class | S jev-mcp | L2-05 |
| E47 | Alias moves to a new build mid-run | warning; every snapshot recorded | A | L2-04 |
| E48 | 429 burst across concurrent chunks | one shared pause | S llm-ext limiter | L2-04 |
| E49 | `--max-budget` given and the estimate exceeds it | refused before any call; without `--max-budget` no check runs (D2) | A | L2-11 |
| E50 | Duplicate caller ids | refused (D14) | S jev-mcp | L2-08 |
| E51 | Caller id with invalid characters | refused (D14) | S jev-mcp | L2-08 |
| E52 | `-o` directory not writable | error before any API call | A | L2-16 |
| E53 | Ctrl-C during fan-out | all aborted; usage of finished requests recorded | A | L2-18 |
| E54 | Cyclic / deep / Map / class-instance values in logs | redacted without crash | S jev-browser `redactDeep` gaps | L2-15 |
| E55 | verify: claim with no supporting evidence | `unknown`, not `contradicted` | S jev-mcp | SP-01 |
| E56 | verify: `none` source sentinel | handled as no source | S jev-mcp | SP-01 |
| E57 | filter: thresholds breaking `p + auto ≤ 1` | thresholds refused | S jev-mcp | SP-03 |
| E58 | label: ids `__proto__`, `constructor` | null-prototype maps, no pollution | S jev-mcp | SP-05 |
| E59 | label: class catalog over 8000-char budget | refused | S jev-mcp | SP-05 |
| E60 | label: id set differs after merge | internal error, never a partial silent result | S exa rule | SP-05 |
| E61 | decide: escape hatch chosen | `escaped`, attention | S jev-mcp | SP-06 |
| E62 | decide: more than 19 questions | refused | S jev-mcp | SP-06 |
| E63 | rank: candidates over 100k chars | planner splits; file chunks merged by best chunk | S jev-mcp | SP-07 |
| E64 | extract: catastrophic regex, `"a".repeat(40000)+" end"` with `(a+)+$` | worker timeout → `invalid_pattern` | S jev-mcp (corrected input) | SP-22 |
| E65 | extract: regex finds no candidates | `not_found`, no API call | S jev-mcp | SP-09 |
| E66 | extract: more candidates than the cap | capped, flagged, `auto` demoted | S jev-mcp | SP-09 |
| E67 | audit: source truncated | incomplete context, `auto` → review | S jev-mcp | SP-10 |
| E68 | review: empty diff | refused | A | SP-11 |
| E69 | review: binary hunks | skipped with warning | A | SP-11 |
| E70 | `review --claims` with no claims | review half only | S jev-mcp | SP-11 |
| E71 | findings: file/line no longer exists | empty window; keep_low | A | SP-14 |
| E72 | `rank --head`: candidate shorter than the head size | whole file sent | S claude-jev | SP-07 |
| E74 | test-output: log over the limit | the whole log is chunked (§5), failing blocks found by grep are ordered first, nothing truncated; merge = highest regression probability | A | SP-17 |
| E77 | `decide --hook`: malformed stdin JSON | D1 behaviour, reported on stderr | S jev-mcp hook example | C4-05 |
| E78 | `decide --hook`: tool not covered by the policy | no call, empty stdout | A | C4-05 |
| E79 | `decide --hook`: own deadline vs Claude Code hook timeout | own deadline shorter, defers per D1 | A | C4-05 |
| E80 | classifier or scouting profile given to `scan` | refused naming command, profile, type and accepted types | S your ruling | PT-03 |
| E81 | local/free/paid/scouting profile given to `classify` | refused, same message | S your ruling | PT-03 |
| E81b | free profile active and `scout run` called | uses the `scouting` profile; if it is the placeholder, refuses with "run `llm-ext benchmark scout-accuracy`" | S your ruling | PT-05 |
| E81c | profile without `profile-type` (existing install) | inferred once, written by PT-02 with a backup, reported | A | PT-02 |
| E81d | `profile-type` value outside the five | load error | A | PT-01 |
| E81e | field of another type in a profile (e.g. `free_only` in a paid profile) | load error naming the field and its type | A | PT-06 |
| E81f | `settings new x --type scouting` | copies the `scouting` template under `x` | A | PT-08 |
| E81g | profile added after migration without `profile-type` | load error naming the field and `llm-ext settings new <name> --type <type>` | A | PT-01 |
| E81h | custom profile without `free_only`, `allow_paid_models: false`, typed `paid` by PT-02 | no call is billed (D36) | A | PT-02 |
| E81i | `active:` names a scouting or classifier profile | load error naming `active:` and the allowed types (local, free, paid) | A | PT-03 |
| E82 | `active_classifier` names a missing profile | error | A | PF-03 |
| E83 | user already has a profile named `or-jev` | migration leaves it, warns | A | PF-04 |
| E84 | unknown key in a classifier profile | load error | A | PF-01 |
| E85 | `$VAR` key not set | error naming the variable | S llm-ext | PF-11 |
| E86 | `--max-budget` given and a running cost passes it mid-run | remaining requests are not sent; finished results kept; the classify result envelope carries `stopped: "budget"` (browse: status `budget`) and the command exits non-zero | A | L2-11, L2-12 |
| E87 | `--max-budget` given and the model's price is unknown | refused before any call (the estimate cannot be checked) | A | L2-11 |
| E88 | Playwright missing | `browse run/page` exit with install message | S your ruling | BR-03 |
| E89 | Playwright present, browsers missing: `browse doctor` | reports the missing browsers and the install command | A | BR-02 |
| E89b | Playwright present, browsers missing: `browse run` | fails naming `browse doctor --install` | A | BR-03 |
| E90 | private/localhost target, or redirect into one | refused without `--allow-private` | A | BR-05 |
| E91 | page with no actionable elements | `stuck` | S jev-browser | BR-16 |
| E92 | same action repeated N times | `stuck` | S jev-browser | BR-16 |
| E93 | Cloudflare bot wall / challenge page | `blocked` | S jev-browser | BR-13 |
| E94 | password typed | never logged; masked in recordings | S jev-browser | BR-19 |
| E95 | dropdown with more options than one request holds | dropdown spec trims per BR-07 rule, flagged | S jev-browser | SP-21 |
| E96 | typing model fails on a search field | keyword fallback, `degraded` (D1) | S jev-browser | BR-11 |
| E97 | browser crashes mid-run | `error`; resources closed | A | BR-04 |
| E98 | credentials file readable by others | refused | S jev-browser | BR-14 |
| E99 | credentials on Windows | refused with message | S jev-browser | BR-14 |
| E100 | Ctrl-C during browse | D11 cleanup | A | BR-04 |
| E101 | snapshot changes during `classify-eval` | results split per snapshot | A | EV-06 |
| E102 | spec text changed since a ledger entry | cache entry invalid (spec hash in key) | A | EV-06 |
| E103 | decisions call in benchmark budget | input tokens charged only | S API pricing | EV-07 |
| E104 | same alias change seen twice | one event (idempotent) | A | DW-02 |
| E105 | credentials or recording with `PWDEBUG`/`DEBUG`/`DEBUG_FILE` set | refused | S jev-browser | BR-24 |
| E106 | password origin differs from the page origin | refused | S jev-browser | BR-14 |
| E107 | `--cookie-file` and `--cookie-env` together | refused | S jev-browser | BR-23 |
| E108 | `select` on an element with no options | action error, step recorded | S jev-browser | BR-09 |
| E109 | Jev picks an unknown action id | invalid answer, never executed | S jev-browser | BR-08 |
| E110 | numeric flag given a non-number (source yields NaN) | refused at parse | A (source bug not copied) | BR-08 |
| E111 | action had no visible effect | next-best action from the prior distribution | S jev-browser | BR-25 |
| E112 | fresh HOME install | `free`, `paid`, `local`, `scouting` (placeholders) and `or-jev` written, each with its `profile-type` and marker; `active: free`, `active_classifier: or-jev` (D19) | A | RL-06 |
| E113 | built-in name with the wrong type (e.g. `scouting` with `profile-type: classifier`) | load error: a built-in name has a fixed type | A | PT-01 |
| E114 | one file larger than `--chunk-chars` | split per §5, every chunk judged, merged by the §5 rule, `best_lines` reported | S quicksilver | L2-19 |
| E115 | no newline within 500 chars before the cut | cut falls mid-line, next chunk overlaps by ≤ 500 chars | S quicksilver | L2-19 |
| E116 | one JSON state entry larger than one chunk | refused naming the key | S quicksilver | L2-19 |
| E117 | `label`: every chunk's top label is the default | item gets the default label at its best confidence | S quicksilver | L2-19 |
| E118 | two chunks tie on the merge value | earliest chunk wins | S quicksilver | L2-19 |
| E119 | directory inside a git repo | `git ls-files -co --exclude-standard` listing; an empty listing sends nothing | S quicksilver | L2-06 |
| E120 | directory outside git | walk skips build/dependency dirs and dot-directories, keeps dot-files | S quicksilver | L2-06 |
| E121 | glob on Node < 22 | refused with "pass a directory instead" | S quicksilver | L2-06 |
| E122 | symlink in the input | skipped and listed unless `--follow-symlinks`; when followed, the target is secret-checked and loops are caught | S quicksilver | L2-06 |
| E123 | lock, minified, source-map or empty file | skipped and listed in the receipt (qs skips them silently; we list them, fail-loud) | S quicksilver (changed) | L2-06 |
| E124 | named secret file (`--items`, `--state @f`, spec file) | refused, exit 1; a secret found while walking is skipped and listed | S quicksilver | L2-06 |
| E125 | file over the 100 MB hard cap or `--max-bytes` | skipped and listed; stdin or a named file over it refused | S quicksilver | L2-06 |
| E126 | more items than `--limit` (5000) | refused before any request | S quicksilver | L2-06 |
| E127 | `--items` line starting `{` that is not valid JSON | refused naming the line | S quicksilver | L2-06 |
| E128 | `filter`: p between threshold and threshold + band | listed in both matched and borderline, as qs does; receipt counts p ≥ threshold | S quicksilver | SP-03 |
| E129 | `find` file mode: a line longer than one chunk | cut into pieces `N.2`, `N.3`, mapped back to line N | S quicksilver | SP-04 |
| E130 | `ask`: both `--choice` and `--score` given | refused (qs silently prefers `--score`; fail-loud instead) | S quicksilver (changed) | C4-04 |
| E131 | `--default` without `--choice` | refused | S quicksilver | C4-04 |
| E132 | input under ~1,000 tokens | runs, and the receipt notes Claude could read it directly for less (cost study break-even) | S cost study | C4-12 |

## 13. Documentation plan

| Artifact | Content | Card |
|---|---|---|
| `skills/_shared/jev-protocol.md` | The one human-readable Jev rulebook: the 38 merged rules from study 2 (jev-mcp 13 policy rules + 7 classification-hygiene items, plus jev-browser, claude-jev, awesome-jev, jev-review rules), each with source and llm-ext command | DOC-01 |
| protocol copies + drift test | Copied into each skill's `references/`; a test fails if a copy differs (awesome-jev `sync_skills.py` pattern) | DOC-02 |
| skill `llm-externalizer-classify` | `SKILL.md`: when to use a classifier vs a chat model, decision map (question → command), cost, profiles, strict-exit in scripts | DOC-03 |
| classify references | `commands.md` (flags table checked against the catalog), `thresholds-and-policies.md`, `errors-and-costs.md`, `hook-gate.md`, `presets.md` | DOC-04…DOC-08 |
| skill `llm-externalizer-browse` | `SKILL.md` + `references/` (install/doctor, safety: hosts, credentials, recording; statuses; costs) | DOC-09 |
| README, settings docs | classify + browse sections; `profile-type`, `active_classifier`, the five defaults, classifiers are paid with an opt-in `--max-budget`, `allow_paid_models` applies to chat profiles only | DOC-10 |
| CHANGELOG 14.2.0 | user-facing entries | DOC-11 |
| global rule text | proposed new text for the user's global llm-ext usage rule (classify group, five profiles); the user applies it | DOC-12 |
| docs-vs-code checks | README/skill flag tables and defaults compared with catalog + `definitions.ts` | DOC-13 |
| skill validation | CPV validation of both skills | DOC-14 |
| NOTICE | attribution for reused text (D17) | DOC-15 |
| existing `llm-externalizer-usage` skill + top-level help | add the `classify` and `browse` groups, the five profile names and `profile-type` to the usage skill and its references, and to the `llm-ext --help` group list | DOC-16 |

## 13b. README redesign for every command (RD epic)

Model: quicksilver's README (177 lines): banner SVG, shields badges, a one-paragraph pitch, install one-liners, "The benchmark" with a chart SVG rendered by a script (`bench/chart.mjs`) from a committed results file, "Where it shines, and where it doesn't", "What Claude can do with it" with CLI examples, Safety, FAQ, License. Today's llm-ext README is 1671 lines of reference prose with no charts.

Rules for the redesign:
- Every number in a chart or table comes from a committed results file produced by a real run, with its date, models and cost; none is typed by hand. Charts are rendered by one script from those files, so rerunning the benchmark redraws the README.
- Every command in `tools/definitions.ts` (the single source for CLI commands) and every slash command and skill gets: one line on what it does, when to use it and when not to, and one to three examples whose output was captured from a real run on a fixture repo (sanitized: no home paths, keys or usernames).
- A test fails when the README names a command, flag or default that the CLI does not have, or misses one it does (extends DOC-13 to the whole README).
- SVGs read correctly in GitHub's light and dark themes (embedded `prefers-color-scheme` styles), checked with screenshots in both.
- Long reference material (auth precedence, every mass-scouting parameter, profile schema) moves to `docs/*.md` pages linked from the README (D26), so the README stays a scannable overview.

| id | title | npt | done when |
|---|---|---|---|
| RD-01 | Style study of quicksilver README + chart script | — | reads quicksilver's `LICENSE` itself; creates `NOTICE` with the quicksilver entry; every outline item cites the quicksilver README line it mirrors |
| RD-02 | Inventory generator | — | script lists, as JSON: every CLI group and command (from `cli/launcher.ts`'s group registry and `tools/definitions.ts`, including `benchmark`), slash commands, skills, agents, hooks and the statusline; plus, per CLI command, `acceptedTypes` over the five profile types and whether it supports `--estimate`, read from today's code (each entry cites the file:line it was read from), plus a list of every place today's code disagrees with your profile-type ruling (first known: mass scouting runs on the free pool under a free profile, `mass_scouting/cli.ts` `resolveScoutModel`), handed to the profile-type cards as input |
| RD-03 | README outline + docs/ split | RD-01, RD-02 | outline approved by you before rewrite; every heading and fact of the current README mapped to its new home (nothing dropped) |
| RD-04 | Banner SVG + badges | RD-03 | light/dark screenshots |
| RD-05 | Results collection from existing benchmark ledgers | RD-02 | free: free-pool bench, security-triage bench, scout-accuracy ledger exported to `assets/data/*.json`, sanitized; each file stamped with date, models, profile |
| RD-06 | Context-savings benchmark (D25 go-ahead) | RD-05 | tasks with deterministic truth only (files relevant to X, planted bugs in a fixture repo, functions that do Y); `truth/*.json` committed; baseline = headless `claude -p` with a fixed model, tokens from its usage output; llm-ext path on a fixed profile; exact-match scoring; one pilot task measured first and the $2 cap restated from it |
| RD-07 | Chart renderer `scripts/llm-ext/scripts/readme-charts.mjs` | RD-05 | renders every chart from `assets/data/`; deterministic output; test compares rerender with committed SVG |
| RD-08 | Example capture script | RD-02 | `--profile` flag, retries; runs each README example on a fixture repo; outputs sanitized and stamped (date, model, profile) as illustrative snapshots; any failed example is reported and nothing partial is committed |
| RD-09 | Group sections, first half of RD-02's group list | RD-03, RD-08 | what/when/not-when, examples, cost line |
| RD-10 | Group sections, second half of RD-02's group list (incl. `benchmark`) | RD-03, RD-08 | same; a group RD-02 lists that neither card covers fails RD-15 |
| RD-11 | Slash commands, skills, agents, hooks, statusline section | RD-03 | same style, grouped by job |
| RD-12 | "Where it shines, and where it doesn't" + benchmark section | RD-06, RD-07 | every claim cites a chart data file |
| RD-13 | Safety, FAQ, install sections | RD-03 | install commands copy-paste-run on a fresh HOME (RL-06 harness) |
| RD-14 | `docs/*.md` reference pages | RD-03 | every heading and fact in RD-03's map found at its new location (map-checked, not byte-checked, since text is restyled) |
| RD-15 | README-vs-CLI test over the whole README (the only such test) | RD-09, RD-10, RD-11 | fails on an unknown or missing command, flag or default; never compares example output text |
| RD-16 | Light/dark screenshot check of all SVGs | RD-04, RD-07 | screenshots in `reports/screenshots/` |
| RD-17 | Classifier and browse README sections in the same style (sole owner of those README sections) | RD-15, RD-19, C4-03, BR-03 | added when 14.2.0's commands exist; charts from classify-eval and from RD-19's matrix extended with an `or-jev` column for the classify commands (same JSON schema, each cell tagged `basis: per-run (RD-19 fixture)` or `basis: per-item (EV-08 dataset)`; the `or-jev` column is drawn as its own chart because the bases differ), filled from EV-08's measured cost per item, no new runs |
| RD-19 | Per-command cost matrix on the 4 default profiles (D25) | RD-02, RD-08 | scope: CLI commands that send a model request (others show "no model call"); each runs on a fixed fixture input under each default profile it is compatible with (`free`, `paid`, `local`, `scouting`), and only those; compatibility is read from RD-02's per-command field, incompatible cells are never run and show "n/a"; a pair today's code allows but your profile-type ruling disallows (RD-02's disagreement list) is skipped as "not measured (disallowed by the profile-type ruling)"; per run: USD cost from the usage records, input/output tokens, wall time, model actually used, outcome (success, command failure, or rate-limited, kept apart); 3 runs per cell with RD-08's retry policy; median reported only when all 3 runs used the same model, else each run listed; a paid cell is any cell whose resolved model has a non-zero catalog price, in any column (the `scouting` model and a profile's fallback models included); paid cells: pilot, then the D25 estimate, stop and ask if over the cap, hard stop on the spend ledger marks remaining cells "not measured (cap)"; `local` needs you to start the local model server (asked at run time), else the column is "not measured (no local server)"; `scouting` is used only if it already exists, never created by this card (its benchmark spends credits), else "profile absent"; results in `assets/data/cost-matrix.json` with date and models; RD-07 renders a chart and RD-09/RD-10 print a cost line per command from it; missing cells never block RD-18 |
| RD-20 | README command × profile-type compatibility table (ships in 14.2.0, with the profile-type cards) | RD-02, PT-03 (the `acceptedProfileTypes` field, §8) | layout exactly as you sketched it: heading `SUPPORTED PROFILE TYPES`, columns `command name`, `command description` (one line, from the command's own help text), `free`, `paid`, `classifier`, `scouting`, `local` in that order, ✅ when the type is supported and ❌ when it is not (your ruling); one row per CLI command (real command names from RD-02); generated from each command's `acceptedProfileTypes` in `tools/definitions.ts`, the same field the runtime check enforces, never typed by hand; a test fails if the README table differs from the generated one; required rows from your examples: mass-scouting commands ✓ only under `scouting`; the plain code-review command ✓ under `local`, `free`, `paid`; `classify review` (noted "classifier code review") ✓ only under `classifier` |
| RD-18 | 14.1.x docs release | RD-12, RD-13, RD-14, RD-15, RD-16, RD-19 | version bump, typecheck/lint/tests, CPV, publish on your word (D13), install, `llm-ext --version` |

Order: RD-01…RD-16, RD-19 and RD-18 run right after 14.1.0 ships, independent of the classifier and profile-type cards; RD-17 and RD-20 join the 14.2.0 release.

## 14. Errors found in plan v2 (all fixed here)

| # | Error | Fix |
|---|---|---|
| 1 | B-069 ReDoS test input could not trigger backtracking | E64 corrected input |
| 2 | G-001 (untrusted text never in instructions) contradicted cards putting caller text in instructions | D5 split rule |
| 3 | B-115 cited a line range that does not exist | dropped; every range in §9 re-checked against the VERIFIED ranges of the jev-mcp inventory (one more wrong range, review, fixed to 1473-1880) |
| 3b | Browse statuses invented (`blocked_by_bot`), `timeout` missing; formats, screenshot, video, cookies, debug-env refusals, no-op recovery not planned | §10, BR-23…BR-26, E105…E111 |
| 4 | Usage recorded only after validation (under-counted billed calls) | §7: record before validation |
| 5 | No OpenRouter attribution headers | §7 headers |
| 6 | One fixed-tolerance validator (breaks 60+ option browse choices) | `ValidationPolicy` §6 |
| 7 | Jev detected by `typesafe/jev-*` regex | catalog `output_modalities` guard |
| 8 | Limits read from alias `/endpoints` (empty) | resolve `alias_target` |
| 9 | `Retry-After` capped at 5 s; `retry-after-ms` ignored | §7 |
| 10 | Header-less `FetchImpl` seam | `GlobalFetch` returning `Response` |
| 11 | A-032 profile-consumer sweep too narrow | PF-05 sweeps every consumer |
| 12 | `-o` via `saveResponse` (markdown, not exported) | own JSON writer (D10) |
| 13 | $0 decisions models ignored | D9 |
| 14 | `endpoint: systemone` allowed for any model | PF-07 |
| 15 | 32,000 hard-coded as the only limit | catalog-derived limits |
| 16 | Unscaled sum tolerance | D6 |
| 17 | New limiter instead of `AdaptiveRateLimiter` | L2-04 |
| 18 | E-009 missing the budget decisions branch | EV-07 |
| 19 | E-002 asked a question the catalog answers (`canonical_slug`, `alias_target`) | DW-02 |
| 20 | New model events without extending the closed `ModelEventKind` union | DW-01 |
| 21 | "npx playwright install chromium" and `peerDependencies` | loader + `browse doctor --install` |
| 22 | "hook answers allow or deny" / "a crashed hook blocks every call" | exit 2 blocks, other non-zero does not; deny = `permissionDecision:"deny"` |
| 23 | "reorder only, never exclude" presented as a study finding | stated as a design choice (JB) |
| 24 | ZB41KG62 required classifier tools in the free-forbidden list, clashing with `allow_paid` | §15 |
| 25 | Card count claimed 315, real 314 | counts taken by grep only |
| 26 | Community tools dropped with no recorded decision | D4 |
| 27 | Would have copied jev-agent-tools' status loss and jev-browser's `rate_limited` → `InvalidJevAnswer` rethrow | §7 "status always kept" |
| 28 | `redactDeep` gaps (depth, keys, instances) inherited | L2-15 |
| 29 | No Ctrl-C handling | D11, L2-18 |
| 30 | Three id strategies, six inline budget checks, thresholds in three places (copied from jev-mcp) | D14, planner, catalog SSOT |
| 31 | No unsplittable/renumber concept: per-chunk `claims[i]` broke | §5 |
| 32 | Per-command cards duplicated shared mechanics (~130 cards) | layer-first catalogue §16 |
| 33 | v3 draft: "five profiles present" on fresh install, but `scouting` is only written by its benchmark | D19, PF-12, E112, RL-06 |
| 34 | v3 draft: `JEV_PASSWORD_*` env names break the `LLM_EXT_` prefix rule | §10 renamed |
| 35 | v3 draft: cards had a one-cell "done when" and no steps | §16 card template + four worked examples; §17 per-group minting with a template check |
| 36 | v3: a large single file was refused instead of split (no central chunker for text) | §5 `text` units, L2-19, E114–E116 |
| 37 | v3: `test:live` assumed to pick up new files (it lists files by name) | D21, RL-03 |
| 38 | v3: RL-01 had no prerequisites, so the release could start before the work | RL-01 npt |
| 39 | v3: question keys built from caller ids (API key rules unknown) | D14, SP-05 example |
| 40 | v3: skills named `llm-ext-*`, against the repo's `llm-externalizer-*` names; existing usage skill not updated | renamed; DOC-16 |
| 41 | v3: no record of what each linked source contributed | §2b |
| 42 | v3: decisions guard would fetch the catalog for every normal-profile run | §8 cached-only guard |
| 43 | v3: DOC-02 fallback location was in the tool-governed spec corpus; missing prerequisites | `docs-src/`; npt DOC-03, DOC-09 |
| 46 | v3: two profile kinds (normal/classifier) against your five-type ruling; mass scouting ran under free profiles; packing removed for shared-state items; two threshold systems per command; input-rule conflicts; `browse page` invented | §8 rebuilt (types, templates, field table, accepted-types table), PT-01…PT-08, D19, D32–D35, §5 packing rule, one band set in filter/label, E33–E41 rewritten, D30 |
| 45 | v3: kept commands without checking they beat the alternative; missed quicksilver; built a second chunker | cost study → D3, D4, D15, D27, D29, D30; quicksilver → D28, D31, §5 chunker, L2-06 rules, E114–E132, C4-12; removed SP-12, SP-15, SP-16, SP-18, SP-19, JB-01…JB-04 |
| 44 | round 2: per-spec replies promised by P-01 before the specs exist; L2-19 had no dependents; RL-01 list incomplete; caller-id keys left in §9; jev-router claim untested; alias decision buried; JB-01 spend ungated | SP cards capture their own reply; SP-07/SP-11 npt L2-19; RL-01 computed from the graph; index keys; §2b marked INFERRED; D24; D12 |

## 15. TRDD-ZB41KG62 corrections

- Remove `status: tasked` residue; `column:` alone.
- `mandate: true` with `mandated-by: none` → `mandated-by: user` (your 2026-10-07 instruction) or remove `mandate:`.
- Add the STATE block (this plan's §1 decisions once approved, next action, superseded items).
- Add `relevant-rules:` (PRRD rules on profiles, free-only, fail-fast — numbers looked up with `prrdgrep` at minting).
- Add every ruling of §2 verbatim (it holds only the first three).
- `npt:` = the 14.1.0 release card; `eht:` = DOC-12, RL-13.
- KV2WCFCS conflict: replace "every classifier tool must be in `free-forbidden-tools.test.ts`" with: a `CLASSIFIER_TOOLS` category derived from the catalog registry, exempt from the free-only rule with the reason "classifiers are paid by design (D2)", plus an assertion that every tool that can send a decisions request is in that list (PF-10). Cross-note added to TRDD-KV2WCFCS (TR-03).

## 16. Card catalogue (layer-first)

Definition of done for every card: tests added to the explicit vitest include list in `scripts/llm-ext/vitest.config.ts` (temp dirs named `llm-ext-…`), `npm run typecheck`, `npm run lint` and `npx eslint . --quiet` clean (run in `scripts/llm-ext/`; the last one also covers `scripts/*.mjs` and config files, which `npm run lint` skips), `npm test` green, no test doubles beyond the `GlobalFetch` seam replaying captured P-01/P-02 replies (D21), one commit with `TRDD-<id8>` in the subject, WHY comments at every non-obvious rule.

**Card template.** Every row below is minted as a TRDD whose body has these sections, filled from the row, the plan sections it cites and its edge rows. The four worked examples show the level of detail every card gets at minting.

```
## Goal            one sentence, the row title made concrete
## Plan refs       § numbers, D numbers, E rows, study report + line ranges
## Files           every file created or changed (paths relative to the plugin repo root)
## Reuse           existing helpers with file:line; "none" when none applies
## Steps           numbered, each one a verifiable action
## Acceptance      checkbox list: one box per E row, per "done when" clause, plus the definition of done
## Out of scope    what a neighbouring card owns
```

**Example 1 — L0-03 Retry loop**
- Goal: one retry loop for every decisions call, following §7 and D7.
- Files: `scripts/llm-ext/src/classifiers/l0/transport.ts`, `…/l0/transport.test.ts`, `scripts/llm-ext/vitest.config.ts`.
- Reuse: `computeBackoffMs` (`src/provider/http.ts:255`), `safeReadText` (`src/safe-body.ts:20`), the L0-04 deadline.
- Steps: 1) read `computeBackoffMs` and its callers; call it, never copy it. 2) `parseRetryAfter(headers, now)`: `retry-after-ms` integer wins; else `Retry-After` as integer seconds or HTTP-date; garbage or past gives 0. 3) `isRetryable(status, errorBody)` as one table: 408, 409, 429, 500–599, and 402 only with `limit_source: openrouter_in_flight_budget`. 4) loop with attempts clamped to 1..6: drain the body before waiting; wait = max(backoff, retry-after); if the wait passes the deadline, throw `rate-limited` with the wait in the error. 5) network errors and timeouts throw at once with "the request may have been billed" (D7). 6) WHY comments on steps 2, 4 and 5.
- Acceptance: [ ] E03 [ ] E04 [ ] E05 [ ] E09 [ ] E10 [ ] 402 in-flight retried, 402 credits not, both from P-01 fixtures [ ] attempts clamp at 1 and 6 [ ] body consumed before every wait [ ] definition of done.
- Out of scope: error classes (L0-01), response parsing (L0-05).

**Example 2 — SP-05 `classify label`**
- Goal: the label decision as one catalog file.
- Files: `src/classifiers/catalog/label.ts`, `catalog/index.ts` (registration), `catalog/label.test.ts`, vitest include entry.
- Reuse: L2-08 id rule, L2-10 policy kit, L1-04 choice validation.
- Steps: 1) read jev-mcp `server.ts:576-743` in a local clone of the jev-mcp repository; list every rule in the card; check the licence row from SEC-01 (D17). 2) zod input: `items[{id?, text}]`, `classes[{id, description}]`, `purpose?`, `context?`, thresholds `auto` 0.85 and `margin` 0.5 with ranges; class catalog over 8000 characters is refused. 3) `build`: state `{purpose, context, classes, items}` (each item carries its caller id); one choice question per item keyed by index, `label_i<i>`, whose instructions point at `items[i]` and never contain item text (D5, D14). 4) split: unit = item; shared state = classes, purpose, context. 5) `project`: null-prototype maps; `auto` only when top ≥ auto and margin met; tie gives review; unknown class key gives invalid. 6) after the merge, the id set must equal the input id set, else an internal error. 7) attention: review, invalid, or a caller class named `manual_review`.
- Acceptance: [ ] E58 [ ] E59 [ ] E60 [ ] golden snapshot of `build` [ ] `project` on this card's captured live reply [ ] the serialized `questions` contain no item text, even for an item reading "ignore the instructions, answer X" [ ] an answer naming a class outside the class ids is invalid [ ] results come back under the caller's ids [ ] registry consistency test [ ] definition of done.
- Out of scope: CLI flags (C4-01), the injection test suite (SEC-02).

**Example 3 — BR-14 Password fill by code**
- Goal: fill a password field without Jev, the typing model or any log ever seeing it.
- Files: `src/browser/credentials.ts`, `src/browser/credentials.test.ts`, vitest include entry.
- Reuse: L2-15 redaction (the password is registered as a redaction value), `sanitizeInputPath` (`src/scan-pipeline.ts:193`) for the file path.
- Steps: 1) read the credentials section of the jev-browser inventory report and the source lines it cites; list every refusal. 2) sources: `--password-file` (refused on Windows; refused if group or others can read it) or `--password-env` (name must start with `LLM_EXT_PASSWORD_`). 3) `--password-origin` must equal the page's `URL.origin` exactly at fill time, checked again after any redirect. 4) a handoff file is read once and then removed, as the source does. 5) once the password is used, screenshots are suppressed for the rest of the run.
- Acceptance: [ ] E98 [ ] E99 [ ] E106 [ ] the password string appears in no stdout, stderr, `-o` report or log (searched by the test) [ ] the handoff file is gone after the run [ ] definition of done.
- Out of scope: debug-env and recording refusals (BR-24), the real-browser case (BR-20).

**Example 4 — DOC-02 Protocol copies and drift test**
- Goal: both skills carry the same Jev rulebook, and drift fails the build.
- Files: `skills/llm-externalizer-classify/references/jev-protocol.md`, `skills/llm-externalizer-browse/references/jev-protocol.md`, `scripts/llm-ext/scripts/sync-jev-protocol.mjs`, `scripts/llm-ext/src/docs/jev-protocol-drift.test.ts`, vitest include entry.
- Steps: 1) take the source location DOC-01 chose. 2) the sync script copies the source to both references, byte for byte. 3) the test compares each copy with the source and names the stale copy and the sync command.
- Acceptance: [ ] a changed copy fails the test [ ] the sync script restores it [ ] CPV clean on both skills [ ] definition of done.
- Out of scope: the rulebook text (DOC-01).

### P — probes and fixtures

| id | title | npt | done when |
|---|---|---|---|
| P-01 | Paid probe of the decisions API (no go-ahead needed, D12) | — | fixtures for noul; choice 2/3/10/60 options; score 3/5/10; both endpoints; errors 400/401/404/413 and `max_tokens_exceeded`; allowed question-key characters and length; headers; context-limit shape; its cost printed and recorded on the card |
| P-02 | Free catalog snapshot | — | fixtures of `?output_modalities=decisions`, alias model, alias + target `/endpoints`, `GET /api/v1/key` |
| P-03 | Fixture sanitizing and storage | P-01, P-02 | fixtures under `src/classifiers/__fixtures__/`; no key, no `user_id`; a test scans them for secrets |
| P-04 | Tolerance spike | P-03 | every P-01 answer passes the chosen policy; final numbers written into §6 and the STATE block |

### L0 — wire

| id | title | npt | done when |
|---|---|---|---|
| L0-01 | Error taxonomy and status mapping | P-03 | every class of §7 from fixtures; 402 variants; 429 `provider_code` (E06, E07) |
| L0-02 | `callDecisions` request building | L0-01, L0-10 | headers, `redirect:error`, key-in-body refusal, 1 MB body cap (E02, E08, E14) |
| L0-03 | Retry loop | L0-02, L0-04 | retry set; `retry-after-ms`/`Retry-After` seconds/date/garbage; deadline cut; drain; no retry on network/timeout (E03–E05, E09) |
| L0-04 | Deadline and abort composition | — | one deadline across attempts; abort stops waits (E10) |
| L0-05 | Response parsing | L0-01 | bad-response rules; snapshot recorded (E01, E11, E13) |
| L0-06 | Strip `openrouter_metadata`/`user_id` in `sanitizeProviderError` | — | existing callers' tests still pass (E15) |
| L0-07 | Decisions catalog loader | P-03 | separate cache path via `getCatalog({path})`, TTL, lock, expired + failed refresh = error (E16) |
| L0-08 | `resolveModel` | L0-07 | alias → target; dated build; unknown → error (E17) |
| L0-09 | Endpoint URL selection | L0-02 | `decisions` / `systemone` |
| L0-10 | `GlobalFetch` seam and Response-shaped test helper | — | helper used by all classifier tests |
| L0-11 | Attribution header constant | — | reuse the existing one if llm-ext has it, else one constant in `provider/http.ts` |

### L1 — primitives

| id | title | npt | done when |
|---|---|---|---|
| L1-01 | Question types and builders | P-03 | key pattern, ≥2 choice options, non-empty instructions, score ≥1 criterion (E30–E32) |
| L1-02 | Request shape checks | L1-01 | question count and serialized size checks with clear refusals |
| L1-03 | `ValidationPolicy` presets + noul validation | P-04 | E26 |
| L1-04 | Choice validation | L1-03 | scaled sum, tie, unknown keys, NaN/range (E20–E24) |
| L1-05 | Score validation | L1-03 | expected-value and integer-index (E25) |
| L1-06 | Answer-set validation | L1-04, L1-05 | missing/extra/type rules (E27) |
| L1-07 | `estimateTokens` | — | char-class, ceil, non-ASCII (E29) |
| L1-08 | Model-id helpers | L0-08 | snapshot parse, alias compare |
| L1-09 | Usage and cost record | L0-05 | recorded before validation; estimate + flag (E12) |
| L1-10 | Usage-history endpoint field | L1-09 | stats/readers show decisions calls; old entries still read |

### L2 — shared mechanics

| id | title | npt | done when |
|---|---|---|---|
| L2-01 | Planner core | L1-02, L1-07 | greedy packing, envelope, refusals (E42, E43) |
| L2-02 | Planner unsplittable + renumber | L2-01 | E28, E44, E45 |
| L2-03 | Planner limits from catalog/profile | L2-01, L0-08 | E18 |
| L2-04 | `runPlan` fan-out and merge | L2-02, L0-03 | `rateLimitedParallel` + `AdaptiveRateLimiter`; usage sum; snapshots (E47, E48) |
| L2-05 | Partial-failure semantics | L2-04 | per split class (E46) |
| L2-06 | `readForJev` inputs (quicksilver 0.3.0 input rules) | — | JSON and file modes; git-aware walk, globs, stdin, `--items`, `--lines`, `--ext`, deny list, symlinks, binary/lock/minified/empty skips, 100 MB cap, `--max-bytes`, `--limit`, encoding (E33–E36, E38–E41, E119–E127) |
| L2-07 | Content secret redaction | L2-06 | E37 |
| L2-08 | Id rule (D14) | — | E50, E51 |
| L2-09 | Evidence/state builder | L2-06 | indexed sources, truncation flags |
| L2-10 | Policy kit and threshold flags | — | bands, margin, max-gated, range checks |
| L2-11 | Opt-in spend cap `--max-budget=<usd>` (D2) | L0-08, L1-07 | no check without the flag; E49, E86, E87; step 1 checks that no existing llm-ext command already uses a `--max-budget` flag with another meaning |
| L2-12 | Result envelope (`schema: 1`) | L1-09 | decision, snapshots, usage, cost, warnings, degraded, `stopped` (`"budget"` when `--max-budget` ended the run, E86) |
| L2-13 | Attention and `--strict-exit` codes | L2-12 | follows existing llm-ext exit conventions (read `cli/main.ts`) |
| L2-14 | Warnings and degraded records | L2-12 | one format for classify and browse |
| L2-15 | Redaction for logs/reports | — | E54 |
| L2-16 | `-o` JSON writer | L2-12 | atomic, `defaultOutputDir`, timestamped name (E52) |
| L2-17 | Classifier profile resolution | PF-01, PT-03 | `active_classifier`, type check through PT-03 (no paid gate, D2) |
| L2-18 | Ctrl-C handling | L0-04 | E53 |
| L2-19 | Planner `text` units: quicksilver chunker and chunk-merge rules (§5) | L2-01, L2-06 | `--chunk-chars`, ≤ 500-char line-snapped overlap, JSON-state grouping, noul/score/choice merges with the default-label rule, `chunks`/`best_lines` (E114–E118) |

### PT — profile types (your five-type ruling; ships in 14.2.0, before PF)

| id | title | npt | done when |
|---|---|---|---|
| PT-01 | `profile-type` field and the per-type field table | — | five-value enum; one field table in `config.ts` drives validation and templates; a new `BUILTIN_PROFILE_NAMES` list (five names, each with a fixed type) beside the unchanged `DYNAMIC_PROFILE_NAMES` (free, paid, local): markers, fixed types and closed keys key on the built-in list, self-population (`dynamic-maintainer.ts:844`, `--populate-default-profile`, `config.ts:1353`) keeps keying on the dynamic list; spend rules of D36; E81d, E81g, E113; `DYNAMIC_GENERATED_KEYS`, `SHIPPED_PLACEHOLDER_SHAPES` (`benchmark/pick.ts:1245-1315`) and `unpopulatedLocalProfile` = `buildLocalProfileSection([])` (`config.ts:1462-1467`) updated together; stale "only two built-ins" docblocks (`config.ts:990, :1350, :1570`) fixed |
| PT-02 | Migration: infer and write `profile-type` into every profile (D32) | PT-01 | backup in `<config>/backups/`, comment-preserving, recorded in `migrationsApplied`; prints each profile's inferred type and every field that PT-06 will reject (E81c, E81h) |
| PT-03 | `acceptedProfileTypes` on every command + runtime check | PT-01, PT-02 | step 1 verifies the INFERRED rows of §8 (`check *`, `session compact` local) in the code and updates D37; the table encoded once in `tools/definitions.ts`; `--profile` and the active profile checked before any model call (E80, E81, E81i); `--help` shows the accepted types; walkers stay inside one type |
| PT-04 | `scouting` as the fifth built-in template | PT-01, PT-02 | written on fresh install as a placeholder with marker; existing unmarked `scouting` sections get the marker by migration (with backup); `benchmark scout-accuracy` writes through the locked, marked, backed-up writer and stops writing the unused `paid_models`; mass scouting on the placeholder refuses with the benchmark hint, not "no PASS" (`mass_scouting/cli.ts:662, :681`) |
| PT-05 | Mass scouting accepts only the `scouting` type (D34) | PT-03, PT-04 | `activeProfileFreeOnly` delegation removed (`mass_scouting/cli.ts:549-561, 605-606`); `run`, `chain`, `propose-fieldset`, `estimate`, `register`, `preclassify` resolve their model from the `scouting`-type profile (`--profile` may name another scouting-type profile); free-mode refusals for these actions (`default-profiles.ts:327-349`) replaced by the type check (E81b) |
| PT-06 | Strict per-type fields (D33) | PT-02 | a foreign or unknown field fails at load naming it and its type (E81e) |
| PT-07 | Fresh-install YAML shows the five types | PT-04, PF-03 | the trailing example comment (`config.ts:1626-1651`) shows one example per type, copied from the templates |
| PT-08 | `llm-ext settings new <name> --type <type>` | PT-01 | copies the type's template under the new name through the locked writer; refuses an existing name (E81f) |

### PF — classifier profiles

| id | title | npt | done when |
|---|---|---|---|
| PF-01 | Classifier-type fields and defaults | PT-01 | the classifier row of §8's field table, defaults of §8 (E84) |
| PF-02 | Selection-time catalog checks | PF-01, L0-08 | decisions guard, model exists (E19) |
| PF-03 | Built-in `or-jev` template + `active_classifier` | PF-01, PT-04 | written on fresh install with marker (E112); E82 |
| PF-04 | Settings migration adding `or-jev` | PF-03 | comment-preserving, byte-diff test (E83) |
| PF-05 | Classifier rows of `acceptedProfileTypes` | PT-03, C4-02 | every `classify` command and `browse run`'s decisions profile accept only `classifier`; `browse run --typing-profile` accepts local/free/paid |
| PF-06 | `settings` commands for classifier profiles | PF-03 | list/show/validate/select |
| PF-07 | `endpoint: systemone` rule | PF-02 | — |
| PF-08 | `provider`/`trace`/`session_id`/`user` validation | PF-01 | strict provider keys; ≤256 chars |
| PF-09 | Classifiers have no paid gate (D2) | PF-02 | the classifier type rejects an `allow_paid` field as unknown; `allow_paid_models` is not consulted by any classify or browse path (test); its docs say it applies to chat profiles only |
| PF-10 | `CLASSIFIER_TOOLS` category in `free-forbidden-tools.test.ts` | SP-00 | §15 assertion |
| PF-11 | `$VAR` key resolution via `resolveApiKey` | PF-01 | E85; key never written |

### SP — L3 catalog specs

Each SP card: spec file, one live reply captured from its own `build` (sanitized like P-03), golden tests (`build` output snapshot, `project` on that captured reply), its edge rows, its injection placement (D5), its attention predicate.

| id | title | npt | done when |
|---|---|---|---|
| SP-00 | `DecisionSpec` type, registry, consistency tests | L1-01, L1-03 | registry lists every spec; `definitions.ts` check |
| SP-01 | verify | SP-00, L2-09, L2-10 | E55, E56 |
| SP-02 | screen | SP-00, L2-10 | thresholds 0.75/0.25/0.3 |
| SP-03 | filter (jev-mcp noul + qs filter) | SP-00, L2-10, L2-19 | E57, E128; threshold/band output, `--lines` collapsing, `--save` |
| SP-04 | find (JSON candidates + qs file-line mode) | SP-00, L2-10, L2-19 | best/exists per request; E129; score = p(where) × p(exists), dedupe, `--top`, `--min-score` |
| SP-05 | label (jev-mcp classify + qs classify) | SP-00, L2-08, L2-10, L2-19 | E58–E60, E117; items in state (D5); `--labels`/`--labels-json`, 2–255 labels, `--default`, `--min-confidence`, `--only`, `--verbose` |
| SP-06 | decide | SP-00, L2-10 | E61, E62 |
| SP-07 | rank (jev-mcp rerank + qs rank + claude-jev relevance, D29) | SP-00, L2-06, L2-19 | E63, E72; 5-level rubric, relevance = score/4, `--top`/`--all`, `--head`/`--keep-at`; candidates in state (D5) |
| SP-08 | compare | SP-00, L2-10 | overall unsplittable |
| SP-09 | extract | SP-00, SP-22 | E65, E66 |
| SP-10 | audit | SP-00, L2-09 | E67 |
| SP-11 | review (+ `--claims`, absorbing jev-mcp gate) | SP-00, L2-06, L2-19 | E68–E70; whole and per-file; gate's claim checks and reason codes reproduced under `--claims` |
| SP-13 | check presets `invariant-check`, `criterion-vs-tests` (D15) | SP-00 | each preset's labels and attention |
| SP-14 | findings | SP-00, L2-06 | E71 |
| SP-17 | test-output | SP-00, L2-06, L2-19 | E74 |
| SP-20 | browse-step | SP-00 | scaled policy for large choices |
| SP-21 | browse-dropdown | SP-00 | E95 |
| SP-22 | Regex worker for extract | — | worker thread + timeout (E64) |

### C4 — L4 entry

| id | title | npt | done when |
|---|---|---|---|
| C4-01 | `runDecision` generic runner | SP-00, L0-02, L2-04, L2-12, L2-13, L2-17 | input via `--input file.json` or stdin, plus spec-declared flags; one code path for all specs |
| C4-02 | `definitions.ts` classify entries | C4-01 | consistency test vs catalog |
| C4-03 | Launcher/main wiring and help | C4-02 | nested help; typo suggestion; verified via bare `llm-ext classify … --help` |
| C4-04 | `classify ask` | C4-01, L2-19 | raw spec file or `-`; `"<q>" --state @f|text|-` with `--choice`/`--score`/`--default`; `--source path:from-to`; E130, E131 |
| C4-05 | `classify decide --hook` (Claude Code PreToolUse adapter) | C4-01, SP-06 | E77–E79; D1 |
| C4-06 | Jev filter on the existing model-info CLI command | L0-07 | step 1 finds the real CLI command behind `or_model_info` (`estimate.ts:167`, INFERRED to be in the `models` group); decisions catalog rows and current snapshot per alias; no new command (D27) |
| C4-07 | `classify ping` | C4-01 | free key check + one noul; `--no-call` |
| C4-08 | `--estimate` for classify | C4-01, L2-11 | no call; tokens + cost ceiling |
| C4-09 | `-o` and `--strict-exit` wiring | C4-01, L2-16 | — |
| C4-10 | Bundle checks | C4-03 | classifiers in `dist/llm-ext.js`; no Playwright import in the main bundle |
| C4-11 | Help texts from catalog | C4-02 | defaults shown match spec |
| C4-12 | Receipt line and lifetime totals | C4-01, L1-10 | qs receipt format (items, skipped, time, Jev tokens and cost, model, "~N Claude tokens not read (estimated)", an estimate never used as chart data, only RD-06's measured numbers are; stderr under `--json`); E132 note; lifetime Jev totals in the existing usage history and stats |

### BR — browse

| id | title | npt | done when |
|---|---|---|---|
| BR-01 | Optional Playwright loader | — | `createRequire` from data dir; `LLM_EXT_PLAYWRIGHT_DIR` |
| BR-02 | `browse doctor` (+ `--install`) | BR-01 | pinned version, install lock (E89) |
| BR-03 | Command gating | BR-01 | E88 |
| BR-04 | Session lifecycle + Ctrl-C | BR-01, L2-18 | E97, E100 |
| BR-05 | Host guard | BR-04 | E90 |
| BR-06 | Page extraction + `JUNK_NAMES` | BR-04 | observables with stable ids |
| BR-07 | Step payload + trim rule | BR-06, SP-20 | fits one request; trim flagged |
| BR-08 | Step loop and statuses | BR-07, L0-03 | statuses of §10; deadline; cost cap |
| BR-09 | Executors | BR-08 | click, type, select, scroll, navigate, back, wait |
| BR-10 | Typing via a local, free or paid profile (`--typing-profile`) | BR-09, PF-05 | 256 tokens, reasoning off |
| BR-11 | Search keyword fallback (D1) | BR-10 | E96 |
| BR-12 | Console capture | BR-04 | errors surfaced in result |
| BR-13 | Bot detection | BR-06 | E93 |
| BR-14 | Password fill by code | BR-09 | file/env sources, origin check, handoff consumed + deleted (E98, E99, E106) |
| BR-15 | Video recording and temp cleanup | BR-04 | WebM; removed on every exit path |
| BR-16 | Stuck detection | BR-08 | E91, E92 |
| BR-18 | Browse envelope and `-o` | BR-08, L2-16 | — |
| BR-19 | Secret masking in browse | BR-09, L2-15 | E94 |
| BR-20 | Real-browser tests on a local fixture server | BR-08, BR-14 | headless, parallel, all resources closed; password origin mismatch (E106) and the origin re-check after a redirect run in a real browser |
| BR-21 | CI: install Playwright for browse tests | BR-20 | workflow pinned per `github.md` |
| BR-22 | Cross-platform paths (Windows/Linux) | BR-01 | — |
| BR-23 | Seed cookies | BR-04 | file/env, mutual exclusion (E107) |
| BR-24 | Credential refusals | BR-14, BR-23, BR-15 | debug env, recording, screenshot suppression (E105) |
| BR-25 | Settle wait + no-op recovery | BR-09 | E111 |
| BR-26 | Final page formats, `--max-chars`, screenshot | BR-06 | text/markdown/html/aria; truncation reported |

### WK — workload-kit (D16)

| id | title | npt | done when |
|---|---|---|---|
| WK-01 | Characterization tests of the 6 workloads | — | current outputs pinned |
| WK-02 | `benchmark/workload-kit.ts` | WK-01 | composable steps of §11 |
| WK-03…WK-08 | Migrate workload 1…6 (one card each) | WK-02 | WK-01 tests unchanged |
| WK-09 | Remove dead duplicates + sweep | WK-03, WK-04, WK-05, WK-06, WK-07, WK-08 | no duplicate helper left |

### EV — classify-eval

| id | title | npt | done when |
|---|---|---|---|
| EV-01 | Dataset format + fingerprint | WK-02 | jsonl per spec |
| EV-02 | Seed datasets: verify, filter, find, screen | EV-01 | no private data |
| EV-03 | Seed datasets: label, rank, compare, extract, audit | EV-01 | — |
| EV-04 | Seed datasets: review (with and without `--claims`), findings, test-output, check presets | EV-01 | — |
| EV-05 | Metrics | EV-01 | accuracy, Brier, review rate, cost/item |
| EV-06 | Runner + ledger | EV-05, C4-01 | E101, E102 |
| EV-07 | Budget decisions branch | — | E103 |
| EV-08 | `benchmark classify-eval` command + report | EV-06, EV-07 | — |
| EV-09 | Threshold suggestions | EV-08 | printed, never written |

### DW — drift watcher

| id | title | npt | done when |
|---|---|---|---|
| DW-01 | New `ModelEventKind` values | — | union extended; readers handle them |
| DW-02 | Catalog diff on refresh | DW-01, L0-07 | E104 |
| DW-03 | `benchmark classify-eval --if-changed` | DW-02, EV-08 | reruns only when a drift event is newer than the last run; otherwise prints "no change" at $0 |

### SEC — security

| id | title | npt | done when |
|---|---|---|---|
| SEC-01 | Licence audit of every distilled source (D17) | — | table of licences; reuse list |
| SEC-02 | Injection tests (D5) | SP-05, SP-07 | injected state text cannot change keys or labels |
| SEC-03 | Key handling tests | L0-02 | env only, never logged, refusal works |
| SEC-04 | ReDoS isolation review | SP-22 | — |
| SEC-05 | Deny list + redaction tests | L2-07 | — |
| SEC-06 | Browse SSRF tests | BR-05 | — |
| SEC-07 | No unreviewed corpus code copied | SEC-01 | every copied block reviewed and noted |

### DOC — documentation (§13)

| id | title | npt | done when |
|---|---|---|---|
| DOC-01 | `jev-protocol.md` | SEC-01 | step 1: CPV on a scratch copy decides the source location (`skills/_shared/` or `scripts/llm-ext/docs-src/`); 38 rules with sources |
| DOC-02 | Copies + drift test | DOC-01, DOC-03, DOC-09 | — |
| DOC-03 | `llm-externalizer-classify` SKILL.md | DOC-01, C4-03 | — |
| DOC-04 | `commands.md` | C4-11 | flags checked by DOC-13 |
| DOC-05 | `thresholds-and-policies.md` | SP-00 | — |
| DOC-06 | `errors-and-costs.md` | L0-01 | — |
| DOC-07 | `hook-gate.md` (`decide --hook`) | C4-05 | — |
| DOC-08 | `presets.md` and the "when to use which command, and when to just read" guide (cost study break-evens) | SP-13 | — |
| DOC-09 | `llm-externalizer-browse` skill + references | BR-08 | — |
| DOC-10 | Settings and profile docs (`docs/*.md`; README sections are RD-17's) | PF-06 | — |
| DOC-11 | CHANGELOG 14.2.0 | DOC-10, PT-05, PT-06 | lists the breaking changes: `profile-type` written into every profile (backup location, PT-02 report), strict per-type fields, mass scouting only under the `scouting` type (no more free-pool scouting) |
| DOC-12 | Proposed global rule text | DOC-10 | handed to you |
| DOC-13 | Extend RD-15's README-vs-CLI test to skill references and the classify/browse commands (no second test) | DOC-04, RD-15 | — |
| DOC-14 | CPV validation of both skills | DOC-03, DOC-09 | clean |
| DOC-15 | NOTICE: append the classifier sources' entries to RD-01's file | SEC-01, RD-01 | — |
| DOC-16 | `llm-externalizer-usage` skill and top-level help updated | C4-03, BR-03, PF-06 | the usage skill names both new groups; `llm-ext --help` lists them; CPV clean |

### RL — release 14.2.0

| id | title | npt | done when |
|---|---|---|---|
| RL-01 | Version bump | every other card of this plan done (checked against the execution-order list in ZB41KG62's STATE, §17 pass 2) | — |
| RL-02 | tsc + eslint + full vitest | RL-01 | — |
| RL-03 | Vitest include list and `test:live` script complete | RL-02 | every new test file listed; `src/live-classify.test.ts` added by name to `test:live` (`package.json:15`) |
| RL-04 | Dist build + size check | RL-02 | — |
| RL-05 | CPV plugin validation | RL-04 | — |
| RL-06 | Fresh-HOME install test | RL-04 | E112 |
| RL-07 | Existing-settings migration test | RL-04 | — |
| RL-08 | Cross-platform checks | RL-04 | — |
| RL-09 | CHANGELOG final | DOC-11 | — |
| RL-10 | Publish (your gate) | RL-05, RL-06, RL-07, RL-08, RL-09 | — |
| RL-11 | Install | RL-10 | — |
| RL-12 | Live smoke | RL-11 | one call per command; total cost printed and recorded |
| RL-13 | Close cards, update ZB41KG62 STATE | RL-12 | — |

### TR — TRDD housekeeping

| id | title | npt | done when |
|---|---|---|---|
| TR-01 | Fix TRDD-ZB41KG62 (§15) | — | `trddgrep lint` clean |
| TR-02 | Mint all cards (§17) | TR-01 | every id mapped to a TRDD id |
| TR-03 | Cross-note in TRDD-KV2WCFCS | TR-01 | — |
| TR-04 | Link the 14.1.0 release card as `npt` of ZB41KG62 | TR-01 | — |

## 17. Minting and execution order

Minting (after approval):
1. TR-01, TR-03, TR-04 via `trddgrep set/append/edit`.
2. Pass 1, one card group at a time (RD first, then P, L0, L1, L2, PT, PF, SP, C4, BR, WK, EV, DW, SEC, DOC, RL, TR): the WK-03…WK-08 row becomes six cards; each card body is written to the §16 template (goal, refs, files, reuse, numbered steps, `## Acceptance` with every E row, "done when" clause and the definition of done, out of scope); a worker drafts the group's bodies in `docs_dev/`, I check every body against the template and the plan, then `trddgrep new --title … --task-type …` mints them; record plan id → TRDD id map.
3. Pass 2: the plan's prerequisite graph is deep and shared (SP-00 alone precedes about 15 cards), but trddgrep rejects a card claimed as `npt` by two cards (GRAPH-TWO-PARENTS, seen 2026-10-07) and keeps derived cards depth-1. So each card's body gets a "Depends on" line listing its plan prerequisites by TRDD id (from the id map), and ZB41KG62's STATE gets one execution-order list of every card (topologically sorted from the plan's npt column) plus the list of cards startable before P-01. `npt` is set only where it stays legal (one claimant, depth 1), otherwise not at all. A pilot group (RD) is minted and `trddgrep validate` run before the other groups; `trddgrep lint` clean at the end.
4. Commit the cards by name (`docs: add classifier cards (TRDD-ZB41KG62)`).

Execution:
1. Finish 14.1.0 (slice M commit, row 19, the /tmp test failure, C9SXX7HO, YG72CYY7, issue-16 cards, WBZJRSQB steps 7–12, your history rewrite, publish, install).
2. RD-01…RD-16 and the 14.1.x docs release RD-18 (RD-06 on your D25 go-ahead).
3. P-02, SEC-01 (free), P-01 when you say go, then P-03, P-04.
3. PT-01…PT-08 (profile types; no Jev call, can start before P-01) → L0 → L1 → PF and L2 → SP-00 → C4-01 → the SP cards and SP-22 → rest of C4 → SEC-02…SEC-05.
4. WK → EV, DW.
5. BR (with SP-20, SP-21) → SEC-06.
6. DOC → RL (RL-10 and RL-12 wait for you).
One card at a time per worker, committed before the next; a worker never commits, the main session does.

## 18. Starting now, in parallel with 14.1.0 (re-entered plan mode, 2026-10-07)

This plan was approved earlier today; the authoritative copy is `design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md` in the repo (this file is the plan-mode working copy). Your ruling "Finish 14.1.0 first" still holds for code: the 14.1.0 release edits `scripts/llm-ext/src` strictly one change at a time, so no classifier, profile-type or README code starts before it ships. What CAN start now, because it touches no source file and spends nothing:

| Step | What | Writes | Cost |
|---|---|---|---|
| N1 | Apply to the repo copy, with fastedit, every change made in this plan-mode session and nothing else: append this §18; replace §17 step 3 (pass 2) and the RL-01 row; the spending ruling (the §2 quote, D2, D9, D12, D36, the §4 spend row, the classifier field table and schema line, the §8 Spend bullet, the model-info row, the §10 Cost bullet, E49, E86, E87, DOC-10's docs row, §15's KV2WCFCS reason, P-01, L2-11, L2-17, PF-09, the SP-card capture note, RL-12). Also correct TRDD-ZB41KG62's Corrections line, which still says classifier tools are "governed by allow_paid" (via trddgrep). Never copy this file over the repo copy: the repo copy carries the privacy cleanup of 90e47922 and 6e4b3788 that this working copy lacks); afterwards `grep -E "snappy-tickling|~/\.claude|your machine|use-llm-externalizer\.md|downloads_dev"` on the repo copy must print nothing; commit | `design/plans/` | $0 |
| N2 | TR-02: mint every card in `column: backburner` (not todo: cards in todo would show as ready next to the release in `trddgrep next`, against "Finish 14.1.0 first"; a card can be the npt of only one card, so an npt on WBZJRSQB cannot hold them back), group by group per the §16 template and §17 pass 1 (RD, P, L0, L1, L2, PT, PF, SP, C4, BR, WK with WK-03…WK-08 as six cards, EV, DW, SEC, DOC, RL, TR); a worker drafts each group's bodies, I check them against the template, `trddgrep new` mints them; one commit per group holding only that group's new cards | `design/tasks/` | $0 |
| N3 | Pass 2 as §17 now states it: "Depends on" lines in card bodies, one execution-order list and the startable-before-P-01 list in ZB41KG62's STATE, `npt` only where legal; the RD group is minted first as a pilot and validated before the rest; the first wave moves from backburner to todo only after 14.1.0 ships | `design/tasks/` | $0 |
| N4 | SEC-01 licence audit of every distilled source (D17), including quicksilver 0.2.0 (MIT) and the open 0.3.0 authorship question (D28); runs after the SEC group is minted, so its result lands on SEC-01 | report under `reports/`, result on SEC-01 | $0 |

Not now: P-02 (catalog snapshot) is captured when coding starts, because the catalog moves and an early snapshot would be stale; P-03 then strips from the `/api/v1/key` reply the key label, usage and limit figures and any key prefix, not only `user_id`, before anything enters `src/classifiers/__fixtures__/`.

Rules for these steps: one card-writing worker at a time across both tracks (release workers also write cards; trddgrep locks each card, so a clash costs a stale-edit refusal, not damage); commits stage cards by name and never mix classifier cards with release cards; every worker brief that may run the llm-ext CLI sets `HOME` and `LLM_EXT_CONFIG_DIR` to fresh `/tmp` dirs and `LLM_EXT_INSTALL_RULE=0`; no paid call (P-01 waits for your D12 go-ahead); nothing touches `scripts/llm-ext/src`; the 14.1.0 release keeps priority. About 200 backburner cards make the full board long; `trddgrep --column todo` shows the release board.

Then, after 14.1.0 ships: §17 execution steps 2 onward (RD epic, then P-02, P-01, PT, L0…).

14.1.0 items waiting on you (unchanged, listed so they are not lost): D7b (TRDD-C9SXX7HO) — may it spend b.ai credit (4 models per run, 8 requests per group per day, stop at the first payment error), and does I10 (b.ai-only machine gets a working free profile) ship in 14.1.0; TRDD-DS6OM3KX — line-numbered scan input, OE27RD7I rows 14 and 20.
