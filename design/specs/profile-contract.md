# llm-ext profile contract (TRDD-SZ7TO9FW)

Status: draft 1 (2026-11-14), normative once the owner answers section 11. Increments 1-3 of TRDD-SZ7TO9FW are implemented: the read-only verdict module (`src/profiles/verdicts.ts`), the pure resolution chain (`src/profiles/resolve-chain.ts`) with validated.ts on the `qualityPass` rule, and the production verdict reader with the automatic legacy backfill (`src/profiles/production-verdicts.ts`, implementation note 4). No request path calls the chain yet; the remaining wiring is W2-W6 (section 10, step 1). Code facts are cited from three read-only reports (paths relative to `scripts/llm-ext/src/`): the settings inventory (`reports_dev/sonnet-worker/20261114_214620+0100-sz7to9fw-settings-inventory.md`, "INV"), the verify-facts report (`reports_dev/sonnet-worker/20261114_220739+0100-sz7to9fw-verify-facts.md`, "VF") and the owner-directive mining (`reports_dev/sonnet-worker/20261114_215510+0100-sz7to9fw-owner-directives.md`, "DIR", entries `#N`). `[V]` = the report read the code; `[I]` = inferred, verify before building on it.

Owner directives implemented (verbatim on the card, 2026-11-14):
- D1: stable vs internal settings; a pinning/customizing procedure that "will not fail if the internal settings changes"; local fallback "implicit in every profile, even those fixed written by the user or by other tools".
- D2: "the priority of llm-externalizer is reliability and availability. So every profile must ensure a fallback. if its not defined in the profile, llm-ext will use the default ones. [...] all must pass the benchmarks. if not, the profile will fallback to models (remote or local) that pass the benchmarks. if a profile belong to the free template/category, then if there is no remote model that is free and that passes the benhmark, then it will fallback to local models that passes the benchmarks. and so on."
- D3: "each profile must list the exact list of commands it is compatible with. [...] the llm-ext must exit with error. this is one of the very few cases of something that has no fallback."
- Context relayed by perch (card note 2026-11-14T22:00): benchmark-driven updates are the point; they must only be kept apart from user/tool-owned keys.

## 1. Principles

1. Reliability and availability come first. A command finishes on some model that passes for its kind, unless one of the three hard errors of section 8 applies.
2. Almost everything is managed by llm-ext: which models serve a command, their order, pools, connection details of the built-in profiles, verdicts, cooldowns, calibration. None of it is a public interface.
3. Very few keys are configurable by users and tools (section 2). They mean the same thing in every release and llm-ext never rewrites them because of a benchmark, a maintenance pass or a migration.
4. A user key states intent ("prefer this model", "this profile serves these commands"), never a guarantee that a given model is used. Whether a model is used depends only on its verdict (section 4).
5. A profile never borrows another profile's keys. Fallback tiers are internal pools keyed by category, not other profiles (#64 "autonomous and self contained").

## 2. The STABLE contract

The only part of `settings.yaml` a user or a tool may write or read. llm-ext never rewrites these keys. Exceptions, all once and with a backup under `<config>/backups/`: a missing file is created from the template; an unparseable file is moved to `settings.yaml.corrupt-<ts>` and regenerated (#36, config.ts:2434-2449 [V]); a NEW built-in section is added when absent (or-jev, local_llama, locals-mlx; pick.ts:2235, 2337 [V]).

### 2.1 Top level

| key | meaning | today |
|---|---|---|
| `active` | default profile when `--profile` is absent; absent means `free` | same (config.ts:1711 [V]) |
| `active_classifier` | default profile for `classify` | same |
| `allow_paid_models` | master switch for any spend; `false` keeps every tier non-billing | same (config.ts:4818 [V]) |
| `paid_benchmark_daily_cap_usd` | daily cap for any benchmark spend, including background tests of pins (4.4) | same, default 0.5 |
| `scout_price_ceiling_usd_per_million`, `scout_accuracy_target_bytes`, `scout_accuracy_threshold` | scouting pool limits and pass bar | same |
| `local_governor` | machine-wide RAM/CPU governor of local inference | same |
| `local_fallback` | the classify local decider (mlx-decision singleton) | same; classify-only |
| `profiles` | map of profile name to profile | same |

Any other top-level key: load error naming the key (today silently ignored, INV A1 [V]).

### 2.2 Per profile

| key | meaning | maps from today |
|---|---|---|
| name (map key) | the id passed to `--profile`. Reserved: `free paid local scouting or-jev` (config.ts:1269 [V]); built-in: `local_llama locals-mlx` | same |
| `profile-type` | the category: `free`, `paid`, `local`, `scouting`, `classifier`. Decides the default chain (4.5) and the commands allowed | same key (config.ts:1362 [V]). When absent it is inferred IN MEMORY by the rule of config.ts:1452 [V]; never stamped into the file (5.2) |
| `commands` | NEW. The exact list of commands this profile serves (D3), written as CLI paths (`llm ask`, `scan folder`, `classify verify`). Must be a subset of what the category accepts (tools/definitions.ts:345-368 [V]); a wider entry is a load error. Absent = every command the category accepts, derived in memory | replaces per-type checking in profileSelectionRefusal (profile-accept.ts:55-61 [V]) |
| pins: `model`, `second_model`, `third_model`, `tool_models`, `free_models` (with `free_only`) | the user's preferred models, in order; `tool_models.<tool>` heads one command. Allowed only on non-reserved profiles. Used only while they pass (4.2) | same key names as today's static profiles, so existing hand-written profiles stay valid (Q6) |
| `fallback` | NEW, optional. The profile's own tier order, as a list of tier names `pinned`, `paid`, `free`, `local`. Absent = the category default (4.5). Listing a tier that leaves the machine or costs more is the only way to allow that move (section 5). `local` is always appended if missing (Q4) | none |
| connection: `mode`, `api`, `url`, `api_key`, `api_token`, `providers`, `timeout`, `context_window`, `app_name`, `http_referer` | how to reach the pinned models. On a reserved profile they are optional user overrides, preserved | same; on reserved profiles today `api_key` is rewritten and `url` deleted by populate (benchmark/index.ts:1845, 2090 [V]), and `timeout`/`context_window`/`app_name`/`http_referer` are deleted once by `dynamic-unknown-keys` (pick.ts:2058 [V]). Both stop |
| options: `selection` (paid only), `high_quality_model`, `ensemble.reserved`, `request_options`, `server` (local) | tuning, as today | same user-owned set (config.ts:1328, 1348 [V]) |
| classifier fields: `endpoint`, `max_requests_per_call`, `concurrency`, `timeout_ms`, `max_attempts`, `context_tokens`, `provider`, `session_id`, `user`, `trace` | classifier tuning | same (config.ts:1554-1571 [V]) |

Any other key: load error with the fix text (profileTypeFieldIssues, config.ts:1495 [V]); never silently deleted.

## 3. The INTERNAL part (moving target)

Everything a benchmark, a catalog check, a probe or a release produces. It moves OUT of `settings.yaml`. Consumers must never read it, parse it or depend on its shape; `llm-ext settings show` may print it, labelled internal.

| internal data | today in settings.yaml | moves to |
|---|---|---|
| reserved profiles `free paid local`: `model second_model third_model free_models paid_models tool_models mode api url api_key api_token free_only detected_providers` | generated keys, marker line (config.ts:1303, 1662 [V]) | `dynamic-profiles-state.json`, a new `pools.<profile>` record next to the existing `modelIds`/`poolFingerprint` (default-profiles-state.ts:216-300 [V]) |
| `scouting`: generated `mode api url api_key model` | written by scout-accuracy.ts:200 [V] | same file, `pools.scouting` |
| built-in local profiles `local_llama`, `locals-mlx`: model ids | copied once from code (config.ts:2133-2160 [V]); a release never updates them | same file, `pools.<name>`, refreshed per release; the yaml section keeps only stable keys (Q11) |
| verdicts | six stores (4.1) | unchanged files; read only through the unified verdict function (4.1). No new store |
| cooldowns, strikes, catalogs, candidates, calibration records, spend | own files (INV C [V]) | unchanged |

The marker line `# <-- do not touch, generated by llm-ext -->` disappears with the generated keys.

## 4. Resolution: one chain for every command

### 4.1 One verdict per (model, command kind)

`verdict(model, kind)` returns `pass`, `fail` or `untested`. It is the only benchmark gate for population, serving, rotation and ensembles; today population and serving disagree (the free pool is filled from the keyword ledger, benchmark/index.ts:1821, but served only on a security-triage pass, index.ts:3123; VF 0.3 [V]). Kind = the tool id of the command. The six existing stores map as follows (implemented in `src/profiles/verdicts.ts`, increment 1; the refinements are in the implementation notes at the end of section 4):

| store | files | gives the verdict for |
|---|---|---|
| S1 keyword sweep | `general-keyword-results.json` (+ `benchmark-results.json` snapshot for unseen ids) | rank-0 kinds only: `chat`, `cluster_synonyms`, `check_imports`, `check_references`, `compare_files`, `batch_check`, `session_summary`. It never covers a ranked kind (validated.ts:262-270 [V]; note 2). The ledger beats the snapshot (validated.ts:124 [V]) |
| S2 per-tool ledgers | `security-triage` (`score.pass`, `score.inconclusive`), `search-existing`, `scan-folder`, `check-specs`, `code-task` `-results.json` | `security_scan` and the four deterministic kinds, via TOOL_DIFFICULTY_RANK (validated.ts:214, 262 [V]): a pass at a higher rank covers lower ranks. The four deterministic ledgers are judged by `qualityPass`, not by `failureReasons` (notes 4-5) |
| S3 text tools | `text-tools-results.json` | `summarize topics sem_deduplicate describe`: the row's stored `qualityPass` under the current hash (note 7); not read by any gate today (VF 1a [V]) |
| S4 scout accuracy | `scout-accuracy-results.json`, keyed by threshold+bytes hash | `mass_scout*` (mass_scouting/cli.ts:623-740 [V]); rows older than 30 days do not count (note 8) |
| S5 free fitness | `hq-scan-quality-results.json` (`mass-scout-throughput-results.json` is the `mass_scout` fitness ledger and is not read: note 9) | `high_quality_scan` on a `:free` id; a paid id is untested (Q12) (FITNESS_GATED_TOOLS [V]) |
| S6 local calibration | `calibration/<engine>/<slug>.json` | every kind that has a task kind (`TASK_KIND_BY_TOOL`) on a managed local model, found under either engine: `ok` with `fill_tokens[task kind] > 0` = pass; `ok` with 0, or `failed` = fail; `missing` = untested. A model with a record is judged by S6 alone (record.ts:285-308, local-input-budget.ts:60-82 [V]; note 10) |

States: `pass` = latest conclusive row passes; `fail` = latest conclusive row fails (a fail older than 7 days is returned as `fail` with its timestamp and the caller re-probes, REPROBE_AFTER_MS [V]); `untested` = no row, an inconclusive row, or a row of a stale hash. The dataset hash is compared for S3, S4 and S5 only; the S1 and S2 readers discard it (notes 6-9). Classify kinds have no benchmark ("quality not benchmarked", run-decision.ts:307 [V]) and keep their own chain (section 6).

### 4.2 The chain

Computed once at command start and frozen for the run (a benchmark that rewrites state mid-run affects the next run only):

1. **Commands check.** The command is in the profile's `commands` (2.2). If not: hard error 8.1, no fallback, nothing sent.
2. **Pinned tier.** The profile's pins in their order (`tool_models.<tool>` first), keeping only `pass` for this kind. Applies to reserved slots too (supersedes #62, section 7).
3. **Category pool.** llm-ext's internal pool of the profile's category (3), `pass` only, ranked by benchmark rating (#56).
4. **Next tiers.** The profile's `fallback`, else the category default (4.5), each a `pass`-only internal pool.
5. **Local tier, last.** Calibrated, `pass` local models that are ready now: record `ok`, engine on PATH, model on disk; never download or calibrate inside the chain (WSPV40Y5 constraints, INV D6). In a fallback position `untested` and an unfit kind mean skip, never wait and never throw (today an unfit kind throws, local-input-budget.ts:151-158 [V]).

Within the run, each failed model moves to the next entry (existing per-walk dead-endpoint/credential sets, index.ts:2013 [V]). Not enough memory is never a failure; the request waits in the governor queue (card 1OOAH3LD, ~line 87). `--stop_on_errors` makes the first model error fatal (same card).

### 4.3 Untested pins

An untested pin is skipped for this run and queued for a background test of this kind, at most one per (model, kind) and not on every run (#55, #59). It joins the chain on its first `pass`. A `fail` keeps it out until a re-probe passes. The user sees one stderr notice per run: `pinned model <id> is not yet tested for <command>; using <served id>; a background test is queued`.

### 4.4 Spend of background tests

A test of a billable model runs only when `allow_paid_models: true` and the test fits `paid_benchmark_daily_cap_usd` (benchmark/daily-spend.ts [V]). Otherwise the notice says why: `background test of <id> needs allow_paid_models: true` or `paid benchmark daily cap reached, test retried tomorrow`.

### 4.5 Default chains by category

| category | default chain |
|---|---|
| free | pinned (free only) -> free pool -> local (D2, owner rule) |
| paid | NAMED OWNER CHOICE Q1. A (recommended): pinned -> paid pool (price ceiling, `selection`) -> free pool -> local. B: pinned -> paid pool -> local. C: pinned -> paid pool -> error |
| local | pinned -> local pool -> error (one-way rule, section 5) |
| scouting | pinned head (S4) -> S4-passing scouting pool -> local scouting (resolveLocalScouting, scout-local.ts:120 [V]) |
| classifier | own chain (section 6) |

Q1 history: #15-#16 (2026-07) let paid fall back to free; #51 and #57/#58 (2026-09) forbade any model outside the profile, "no exceptions"; #74 (2026-10-27) "must never remain blocked"; D2 "and so on". A follows D2 literally and only moves to cheaper tiers. B suits users who chose paid for data handling, since free providers often have weaker data terms [I]. C is #57 as written, overridden by D2.

### Implementation notes (increments 1-3)

What `src/profiles/verdicts.ts` does, where it refines 4.1 (read from the code; reports_dev/sonnet-worker/*-sz7to9fw-inc1-verdicts.md has the file and line evidence):

1. Kind set: the 23 model-calling tool ids (a compile-time exhaustive record in the module). Classify kinds are not in it; `verdict` throws on an unknown kind rather than guess. Result: `{verdict, store, at}`, with `store` and `at` null when no row exists.
2. S1 rank rule: a keyword-sweep pass covers only rank-0 kinds. It never covers a ranked kind, because `validatedModelsForTool` skips every ledger ranked below the tool (validated.ts:262-270). A ranked kind whose own ledger has no row is `untested`; it never falls through to S1. The accumulating ledger is authoritative for a model it mentions (latest row, pass or fail); the whole-file snapshot speaks only for an unseen id.
3. S1 snapshot rows carry no date, so `at` is null for them. A snapshot non-pass row of an unseen id gives `fail` (validated.ts only adds snapshot passes).
4. S2 deterministic ledgers (code-task, check-specs, scan-folder, search-existing): pass is `qualityPass === true`, fail is `qualityPass === false`, whatever `failureReasons` holds (coordinator decision, owner rule "models must pass the benchmarks"). `failureReasons` lists only the cases that failed to run; a live code-task row has it empty and `qualityPass` false, which is a FAIL. A legacy row without a boolean `qualityPass` gives no verdict. Increment 2 moved validated.ts `passedDeterministic` to the same rule and fold. Increment 3 makes the zero-call backfill automatic: before the first read of these ledgers by the send gate (`validatedModelsForTool`) or by `productionVerdictReader`, `ensureLedgersBackfilled` (benchmark/backfill-ledgers.ts) runs `backfillAllLedgers` once per process per config dir. Every legacy row of the current dataset hash gets its `qualityPass` from its own stored score; a row of an older hash still gives no verdict. A ledger file is rewritten (atomically) only when a row was upgraded, and a tool whose backfill fails is named once on stderr.
5. Hierarchy: ledgers ranked 0 (keyword) to 5 (code-task). A kind of rank r is covered by a pass in any ledger of rank >= r; a fail counts only from the kind's own rank (failing a harder benchmark says nothing about an easier one); any covering pass beats a fail, like the union of passed-sets in validated.ts.
6. Hashes: the S1 and S2 readers key on the model id and ignore the dataset hash, so `verdict` does too. S3, S4 and S5 compare the row hash with the current hash, which is injected (`CurrentHashes`); a hash that cannot be computed reads as `untested`.
7. S3: row key `tool::model::date::hash`; the verdict is the row's stored `qualityPass` under the current hash. A run where every call errored is indistinguishable from a quality fail.
8. S4: rows older than 30 days are dropped before the latest row is chosen (scout-accuracy-ledger.ts SCOUT_ACCURACY_MAX_AGE_DAYS). The reader has no fail set, so fail is derived: the latest conclusive non-pass under the current hash.
9. S5: only `hq-scan-quality-results.json` is read, per model, for a `:free` id. `mass-scout-throughput-results.json` belongs to the `mass_scout` fitness tool, which no kind consumes since PT-05, so it is not read. A paid id is `untested` for `high_quality_scan` (Q12).
10. S6: the module looks for a record under both engines (`llama`, `locals`). A model with an `ok` or `failed` record under either is a managed local model and S6 alone speaks for it, ledgers not consulted: the record is route-specific and an unfit local kind must never be served from another route's row (the spec was silent on this conflict; agent choice). `ok` with `fill_tokens[task kind] > 0` is pass, `ok` with 0 or `failed` is fail. `fill_tokens` is keyed by task kind (`TASK_KIND_BY_TOOL`), so a kind with no task kind (`mass_scout*`) is `untested` for a local model.
11. A stale fail (older than 7 days) is returned as `fail` with its timestamp; the caller decides on a re-probe.
12. Duplicates: increment 2 deleted the copies of `isGeneralKeywordPass` and the latest-row-per-model fold; verdicts.ts imports them from validated.ts (`isGeneralKeywordPass`, `latestRowsByModel`, `hasQualityVerdict`). Still duplicated: the triage pass predicate (validated.ts `passedSecurityTriage` and verdicts.ts `judgeScoreRow`). verdicts.ts keeps its own `latestRow` for S3-S5, whose keys do not start with the model id.

## 5. One-way safety rule (NAMED OWNER CHOICE Q2, recommended)

A chain never moves to a tier that leaves the machine (local -> remote) or costs more (free -> paid) unless the profile lists that tier in its own `fallback`. Allowed without listing: paid -> free, paid -> local, free -> local, remote -> local.

Why: consumer-guidelines.md section 9 promises "For code that must not leave it, use a local profile". A local profile that silently falls back to OpenRouter breaks that promise without a signal. A free profile that silently bills breaks `allow_paid_models` intent the same way. Reliability is still served: every category ends in the local tier, which needs neither network nor money.

## 6. Commands that bypass the chain today

| command | today | under the contract |
|---|---|---|
| `session compact` (session_summary) | own selector over the public catalog, biggest-context `:free`, no benchmark, local refused (session_summary/model-select.ts [V]) | joins: its selector becomes the free pool for kind `session_summary`, with the context-size filter kept as a hard requirement; local tier last (#111 LFM3 1.7B); order remote vs local is Q9 |
| `classify *` + `classify ping` | classifier profile -> System One models under the ceiling -> local decider (run-decision.ts:380-506 [V]) | stays special: no classify benchmark exists (classify-eval has no runner, VF 1a [V]). The commands check (4.2 step 1) applies; the existing chain is its default chain |
| `scout run/chain/...` | head of a scouting profile, S4 pass required, no chain; `--profile local_llama` refused before scout-local runs (PT-03, VF 2a [I]) | joins: 4.5 scouting row. A local profile that lists scout commands in `commands` reaches resolveLocalScouting |
| ensembles (remote-ensemble, reserved slots) | static members used as written; reserved slots "regardless of the benchmarks" (index.ts:4361 [V], #62) | joins: each member must `pass`; a failing or untested member is replaced from the category pool (#51 replace-on-failure). Fan-out callers not enumerated (VF "Not verified") |
| `scan security` | paid only, own runner, single model `--model` > `tool_models.security_scan` > DEFAULT_MODEL (mass_scouting/cli.ts:2268 [V]) | joins: pinned -> paid pool at rank 1 -> local tier (no local verdict exists for this kind today, so in practice empty). Free stays hard-forbidden (FREE_FORBIDDEN_TOOLS [V]) |
| `scan quality` | paid only, single `high_quality_model`, exempt from the IRON RULE as "manual" (index.ts:6939-6975 [V]) | `high_quality_model.id` becomes a pin gated by `verdict(id, high_quality_scan)`; which store gives that verdict for a paid id is Q12 |

## 7. Supersessions to record

1. D2 overrides #62 item 3.3: reserved slots are no longer "used regardless of the benchmarks"; they must pass like any pin.
2. D2 overrides #57: hand-written profiles get the same fallback and repair as built-in ones. Repair writes only internal state, never the profile's keys, which settles DIR C.2 (repair vs frozen user profile).
3. The 2026-09-17 ruling "in no case models outside the selected profile" (#57/#58) is narrowed twice: to remote models by D1 (WSPV40Y5 line 125), and further by D2 "(remote or local)" to "no remote model outside the profile's category" (Q3).
4. WSPV40Y5 Q5 (static remote profiles never fall back) is reversed (WSPV40Y5 line 125); its 2026-11-14T20:12 agent decision is void.
5. TRDD-FDI9NYAS D3b (hand-listed models exempt from the benchmark gates, config.ts:4343-4345, connection.ts:64-65 [V]) is reversed.
6. PN0N4290 (give-up window) and WSPV40Y5 (local fallback helper) are re-derived from this spec: the give-up window decides when a tier is exhausted; the local tier of 4.2 step 5 is WSPV40Y5's helper.

## 8. The only hard errors

1. **Command outside the profile's list.** Exit 1 before boot, nothing sent, no fallback (D3): `profile '<p>' does not serve '<command>'. It serves: <list>. Pass --profile <other>, or add '<command>' to profiles.<p>.commands.`
2. **Chain empty after repair.** When no tier has a passing model, the command waits for one foreground repair (#56: blocking only when nothing works), then exits 1: `no model passes for '<command>' in profile '<p>': pinned <n untested, m failing>; <category> pool empty; local tier: <reason>. Fix: <first applicable of: run 'llm-ext models calibrate --model <id>'; set allow_paid_models: true; retry after the background update (running)>`. The message always names at least one fix.
3. **No calibrated local model.** Outside a local-category profile the local tier is simply empty: never a wait, and error 8.2 only if every other tier is empty too, naming `llm-ext models calibrate`. In a local-category profile whose only models are uncalibrated: Q3 (recommended: hold as today, L68 "No, wait", bounded by `--command_timeout` which exits 124, with the progress line every 5 min, local-input-budget.ts:248 [V]).

`--stop_on_errors` (exit 6) is a caller's choice, not a contract error.

## 9. Pinning and customizing procedure (users and tools)

Extends skills/llm-externalizer-create-profile/SKILL.md ("THE ONE RULE": create your own profile, never edit another's or `active:`).

1. Choose a new name, not reserved or built-in. Tools prefix it with their own name (`perch-scan`). Never modify an existing profile; never write `active:`.
2. Write only section 2.2 keys: `profile-type`, `commands`, the pins, optional `fallback`, connection and options.
3. Do not copy model ids out of `free`, `paid`, `local`, `scouting` or the built-in local profiles: they are internal (3). Pin from the user's own choice or from `llm-ext models info`.
4. Validate with `llm-ext settings profile <name>` (read-only); a wrong key is a load error with fix text.
5. Always pass `--profile <name>`.
6. Expect substitution: a pin that does not pass is replaced by a passing model and a notice is printed (4.3). The command still succeeds. The profile's text is never changed.
7. To change a pin, edit only your own profile. llm-ext explicit write commands (`llm-ext-benchmark --apply-profile`, `--adopt-into`, `--apply-free-pool`, `settings scan-local --pick`) keep working on a user-named profile, refuse an existing name unless `--replace` is passed (addProfileToSettings replaces today, pick.ts:664 [V]), and never run automatically.

This keeps working whatever the benchmark does, because nothing it writes is read from the profile's text and nothing in the profile's text is rewritten.

## 10. Migration and increments

Each step is one bounded change, verified and committed before the next.

1. **Unified verdict function** over S1-S6 (generalizes validated.ts). Population and serving read it; ends the keyword/security-triage mismatch. Written so far: increment 1, the read-only module `src/profiles/verdicts.ts`; increment 2, the pure resolution chain `src/profiles/resolve-chain.ts`, validated.ts `passedDeterministic` on the `qualityPass` rule of 4.1 and the S1/S2 fold shared with validated.ts; increment 3, `src/profiles/production-verdicts.ts` (`productionVerdictReader`: the file readers and the three current hashes, computed once and frozen) and the automatic zero-call legacy backfill (implementation note 4). No request path calls the chain yet. Remaining, one commit each (TRDD-SZ7TO9FW increment 2 report, plan W2-W6): W2 pool sources (paid and free pools, ready local models); W3 route and provider deps per tier; W4 build `profileChain` from `resolveChain` and send each entry with its tier deps, with the 4.3 notice for untested pins; W5 retire `buildFreeRotationPool` as a separate candidate source for single sends; W6 drop the `isManualModel` exemption for pins (a behaviour change, reviewed on its own).
2. **Stop rewriting user files:** retire the per-boot `profile-type-written` stamp (pick.ts:2166-2214 [V]) and keep inference in memory; drop the strict-load error that forces it (config.ts:1620 [V]).
3. **Compatible-commands list:** the `commands` key, in-memory default, check before boot (replaces profile-accept.ts:55-61).
4. **Resolution chain** (4.2-4.4) with the frozen per-run snapshot, the untested-pin background test, and the local tier. PN0N4290 and WSPV40Y5 re-scoped into this step.
5. **One-way rule and `fallback` key** (section 5).
6. **Bypass commands join** (section 6), one command per commit.
7. **Explicit writers refuse existing names** without `--replace`; create-profile skill updated (section 9).
8. **Sweep every reader of the generated keys** (required, not yet done): skills (create-profile, config, cli-reference, ensemble-autoselect), commands/*.md, statusline, `settings` verbs, `scripts/llm_ext_profile.py`, README "Configuration", configuration-guide.md:215-304, profile-templates.md, consumer-guidelines.md sections 1 and 5, benchmark/cli-args.ts help, the template comment at config.ts:2282-2295.
9. **Last: move generated lists to internal state** (3). A one-time migration strips generated keys from reserved sections, with a backup; user-owned keys are kept byte-for-byte.

Acceptance cases (from the directives only):
- A1, pinned model retired upstream: its calls fail or its verdict turns `fail`; the command succeeds on the next passing model with one notice; `settings.yaml` is byte-identical afterwards.
- A2, hand-written profile whose models stop passing: same as A1 for every pin; the category pool then the local tier serve.
- A3, benchmark rewrite during a run: the run uses its start snapshot and succeeds; the next run uses the new state; `settings.yaml` unchanged.
- A4, command outside the profile's list: exit 1, error 8.1 text, zero model calls, no fallback.
- A5, no calibrated local model and every remote tier down: error 8.2 naming `llm-ext models calibrate`; no wait in a non-local profile.

## 11. Open owner questions

1. Q1 Paid chain order: A, B or C (4.5)? Recommend A.
2. Q2 One-way safety rule (section 5)? Recommend adopting it.
3. Q3 May a hand-written profile fall back to remote models of its own category's pool (supersession 7.3)? Recommend yes, same category only.
4. Q4 May a profile remove the implicit local tier? Recommend no; `--stop_on_errors` per run is the only switch (D1 "implicit in every profile").
5. Q5 `commands` entries: CLI paths (`scan folder`) or tool ids (`scan_folder`)? Recommend CLI paths, absent = derived from the category.
6. Q6 Keep today's pin key names (`model`, `second_model`, `third_model`, `tool_models`, `free_models`) on user profiles instead of a new `pins:` subsection? Recommend keep: renaming needs a migration that rewrites user files.
7. Q7 Background tests of billable pins only with `allow_paid_models: true` and within the daily cap (4.4)? Recommend yes.
8. Q8 Reserved ensemble slots gated by the verdict (supersession 7.1)? Recommend yes, background-tested like pins.
9. Q9 Session summary order: free remote then local, or local first (#111 "Always use the locale inferencer")? Recommend remote free first for the 2-minute target (#43-#44), local last.
10. Q10 Keep #36 (unparseable file regenerated, with backup) as the only full rewrite? Recommend keep.
11. Q11 Built-in local profiles' model ids internal and refreshed per release, yaml keeping only `server`, `request_options`, `url`? Recommend yes.
12. Q12 Which store gives `verdict(id, high_quality_scan)` for a paid `high_quality_model`? Recommend S2 rank 5 (the code-task `qualityPass` row) until a paid hq ledger exists [I: not verified that paid rows exist]. Increment 1 does not implement it: a paid id is `untested` for `high_quality_scan` until the owner answers.
13. Q13 A local-category profile with only uncalibrated models: hold (L68) or error (8.3)? Recommend hold, bounded by `--command_timeout`.

## Not verified

- The six-store enumeration (4.1) was checked against the code in increment 1 (`src/profiles/verdicts.ts`, notes at the end of section 4); the list of readers in 10.8 was not checked by a full sweep.
- getEnsembleModels fan-out callers, security_scan DEFAULT_MODEL, and whether `--update-all` throws for check-imports/compare-files/check-references (VF "Not verified").
- PT-03 refusal of `--profile local_llama` for scout commands is inferred (VF 2a).
- Directive #89 text is cited from card 1OOAH3LD, not from DIR (whose extract of #89 shows a slash command).
