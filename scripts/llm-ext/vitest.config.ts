import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration tests spawn child processes — give them time
    // Local reasoning models can be very slow (~8 tok/s + 30-60s thinking per call).
    // Batch tests with 3 files need ~6-10 min; single-file tests need ~2-3 min.
    testTimeout: 900_000,
    hookTimeout: 120_000,
    // Every temp dir a test file mkdtemps is removed in that file's afterAll —
    // the suite leaked 2,400+ orphan dirs into /tmp before this (see the file).
    // test-hermetic-config.ts runs SECOND so it benefits from the tracker's
    // mkdtempSync wrap (belt-and-suspenders cleanup) — it isolates
    // getConfigDir() away from the real ~/.llm-externalizer for any test file
    // that doesn't set its own LLM_EXT_CONFIG_DIR (measured 2026-09-16: the
    // real history.log and free-cooldowns.json were getting test writes).
    setupFiles: ['src/test-tmpdir-tracker.ts', 'src/test-hermetic-config.ts'],
    // ...and the run FAILS if any llm-ext-named temp entry is still left behind
    // at the end, whatever created it — the leak can never go unnoticed again.
    globalSetup: ['src/test-tmpdir-guard.ts'],
    // Only run integration + unit tests by default — live tests require LM Studio
    // Run live tests explicitly: npx vitest run src/live.test.ts
    include: [
      // Raw-NUL-byte guardrail (groupA-A2) — scans this package's src/ tree
      // plus the repo's top-level scripts/bin, so it must run.
      'src/no-raw-nul-bytes.test.ts',
      'src/index.test.ts',
      // PT-01 (TRDD-QRF04JVJ): profile-type enum, per-type field table, E81d/E81g/E113; pure, no I/O.
      'src/profile-type.test.ts',
      // PT-02 (TRDD-IQTF34TC): the migration writing profile-type into every profile; real files in a temp llm-ext-* config dir.
      'src/profile-type-migration.test.ts',
      // P6c-a2b (fix-queue review S1 + 57): boot/reload through
      // evaluateSettingsValidity, the shared verdict index.ts's four call
      // sites now route through.
      'src/boot-reload-validity.test.ts',
      'src/parallel-repair.test.ts',
      // P6c-b: doc/config guard — the README/configuration-guide facts about
      // profile selection, the free/paid dynamic profiles and the free-unfit
      // tool refusal must quote the exported constant, never a retyped
      // literal (memory: a-doc-guard-that-asserts-a-mention-cannot-see-a-
      // stale-claim). Also asserts retired names are absent from docs.
      'src/doc-contract.test.ts',
      // The four single-call text tools (TRDD-VFXS2ZYY/9XOHSYFV/SYEH38AV/
      // Q3ERXAAO) — hermetic core tests over the injected-deps seam.
      'src/text-tools/core.test.ts',
      // L0-10 (TRDD-0Z0L6IPP): GlobalFetch test helper shape proof.
      'src/classifiers/l0/test-fetch.test.ts',
      // L0-04 (TRDD-H2NRKMEY): one deadline across attempts, abortable waits.
      'src/classifiers/l0/deadline.test.ts',
      // 'profile' command (TRDD-K3PW7Q2M) — read-only list/show against the
      // real compiled CLI + a throwaway multi-profile settings.yaml.
      'src/profile.test.ts',
      // config -> settings group rename (settings-rename task) — settings
      // show/profiles, the removed config group, and the missing-file path.
      'src/settings-group.test.ts',
      // Launcher → server boot handoff — spawns the real launcher and completes
      // an MCP initialize; catches the -32001 regression that unit-level imports
      // (which never go through launcher.mjs) structurally cannot see.
      'src/launcher-boot.test.ts',
      // Grouped CLI launcher (TRDD-DT11TE2Z) — argv rewrite + did-you-mean.
      'src/cli/launcher.test.ts',
      // The launcher's native-deps location. One fixed user-owned address, so a
      // headless caller (hook, cron, daemon — no CLAUDE_PLUGIN_DATA) resolves
      // the same directory an interactive session does instead of guessing.
      'src/data-dir.test.ts',
      // The launcher's cross-process install lock — proves exclusion +
      // stale-lock recovery deterministically (fake timers, no spawning).
      'src/install-lock.test.ts',
      // --profile global flag + -o/--output_dir on newly-report-writing
      // commands (profile+output-flags task).
      'src/cli/profile-flag-and-output-dir.test.ts',
      // active: precedence -- --profile flag > active: > built-in default
      // (TRDD-G6XT3AY9; replaces active-profile-retirement.test.ts, deleted).
      'src/cli/active-precedence.test.ts',
      // --profile visibility in per-command --help (profile-visibility task).
      'src/cli/profile-help-visibility.test.ts',
      // PT-05 follow-up (TRDD-RPEKSYJL): --profile forwarding, active left alone, no active-pool gate/override for scouting-only commands; real bundled CLI entry.
      'src/cli/scouting-profile-forwarding.test.ts',
      'src/cli/grouped-help-shape.test.ts',
      // Cost-safety guard — default test backend must never bill (TRDD-e82f2c49).
      'src/test-helpers.test.ts',
      'src/grouping.test.ts',
      'src/safe-body.test.ts',
      // Per-tool model map (tool_models / resolveModelForTool) — TRDD-f45eeaa0.
      'src/config.test.ts',
      // Dynamic default-profile lifecycle (the two dynamic names, `free` and
      // `paid`) — pool fingerprinting, drift decision, and the state sidecar.
      // P6c-a retired the free-ensemble/paid-ensemble/paid-mass-scout trio; `paid`
      // absorbed the ensemble slots and the mass-scout head.
      'src/default-profiles.test.ts',
      // Pure builders for the THIRD dynamic profile, `local` (TRDD-C9SXX7HO,
      // D1) — no I/O, no probe; local_discovery/scan.ts owns the probe.
      'src/local-profile.test.ts',
      // P5: the built-in local profiles (local_llama, locals-mlx), added once.
      'src/local-profiles-builtin.test.ts',
      'src/calibration/calibration.test.ts',
      // P6b step 3: Phase A scorers with degenerate answerers; pure, no I/O.
      'src/calibration/phase-a.test.ts',
      'src/calibration/phase-b.test.ts',
      'src/calibration/calibration-real.test.ts',
      'src/calibration/phase-c.test.ts',
      // The population RUNNER's own policy — paid gate, lock-before-gate
      // ordering, fail-open, the dynamic 'paid' daily spend cap (P5).
      'src/default-profiles-runner.test.ts',
      // SG2 (USER 2026-09-18): the per-profile background-update singleton
      // -- one lock guards detector, populate/benchmark, local rescan and
      // the empty-pool foreground wait for a SINGLE dynamic profile, across
      // however many llm-ext commands run at once. The SG1 stress harness
      // (scripts_dev/sg1-background-spawn-harness/, gitignored) turned into
      // a real vitest test.
      'src/background-singleton.test.ts',
      // C2b (TRDD-OE27RD7I §2): the detached DETECTOR — fingerprint-only
      // change check, the per-profile spawn throttle, and the ordering/
      // atomicity proofs the review of the first cut demanded.
      'src/profile-detector.test.ts',
      // The dynamic-profile candidate queue (design §2.4, P5): enqueue/clear/
      // dedupe/fail-open-on-corrupt for the maintainer's benchmark-before-write gate.
      'src/dynamic-candidates.test.ts',
      // The ONE cross-process advisory lock every sidecar RMW takes (P6b-fix2
      // S-4), tested directly for the first time by P6b-fix3 N-11: real
      // contention with a second process, stale dir/file takeover, and the two
      // hang paths S-7' closed (permanent mkdir failure; hot spin).
      'src/mkdir-lock.test.ts',
      // Disk-cached, TTL'd, negative-cached OpenRouter catalog fetch
      // (design §2.2 + addendum D, P4). D5 deleted the b.ai twin
      // (bai-catalog.ts) with the b.ai prepend plumbing.
      'src/catalog-cache.test.ts',
      // The paid dynamic-profile daily spend cap (design §2.5, P5): fail-closed
      // on a corrupt ledger, UTC-day reset, pruning, cap-0 disables entirely.
      'src/benchmark/daily-spend.test.ts',
      // Phase 4 wiring: the boot gate + the dispatcher hook that actually
      // populate a default profile on first use (previously inert).
      'src/default-profile-wiring.test.ts',
      // renderDefaultSettingsYaml() round-trip + first-run/corrupt-recovery
      // regression tests for the removed SETTINGS_TEMPLATE hand-maintained copy.
      'src/config-default-settings.test.ts',
      // P6c-a: the one-time pre-14.0.0 migration (addendum K) — the shipped
      // placeholder-shape table, the retired-name deletions, the unmarked
      // free/paid adopt-vs-back-up-and-regenerate split, and the reserved-name
      // refusal that replaces it once the migration has run.
      'src/profile-migration.test.ts',
      // __routeHeadersForTests coverage (item 3/A2, 2026-09-16): the empty-
      // authToken branch and protocol-gated attribution headers were only ever
      // exercised through a mock, never the real routeHeaders().
      'src/route-headers.test.ts',
      // D2 split coverage (item D2/A4, 2026-09-16): the empty-response retry
      // ladder + run-level spend stop, against a real local HTTP server.
      'src/provider/completion.test.ts',
      // TRDD-1OOAH3LD increment 1: request_options helpers + profile-key validation (pure).
      'src/provider/request-options.test.ts',
      'src/provider/provider-state.test.ts',
      'src/provider/provider-state-render.test.ts',
      'src/provider/retry-clock.test.ts',
      'src/provider/failure-fields.test.ts',
      'src/provider/classify-failure.test.ts',
      'src/provider/first-failure-consumers.test.ts',
      'src/provider/issue16-burst.test.ts',
      'src/retry-clock-consumers.test.ts',
      // Single-profile fallback iterator (phase 14.1-C1, TRDD-OE27RD7I
      // addenda 2/3/4): walks ONLY the resolved profile's own model chain,
      // never a model outside it.
      'src/profile-fallback.test.ts',
      // high_quality_scan prompt-cache wire transform (TRDD-DBUSM55E).
      'src/high-quality-scan.test.ts',
      // Usage-rule installer (~/.claude/rules/use-llm-externalizer.md).
      'src/rule-install.test.ts',
      // Single-source project-root resolver (reports land inside the project).
      'src/project-root.test.ts',
      // scan_local_llm_services — local-service autodiscovery (parsing + the
      // discover→build→write chain against a tmp LLM_EXT_CONFIG_DIR).
      'src/local_discovery/scan.test.ts',
      // Global usage-history logger — one line per LLM web request.
      'src/usage-history.test.ts',
      // Durable model-health event ledger (TRDD-828238b5 A1).
      'src/model-events.test.ts',
      // Model-health emission at the hot-path sites (TRDD-828238b5 A7-P1).
      'src/model-events-emission.test.ts',
      // DW-01 (TRDD-RU53X0ZR): drift event kinds in the model-events ledger.
      'src/model-events-drift.test.ts',
      // Ensemble per-model limits — calibrated-ceiling maxOutput resolver (A3 + ec45c66f).
      'src/ensemble-limits.test.ts',
      // Reasoning-effort cost guard — default "high", per-call "off" opt-out (ec45c66f).
      'src/reasoning-ladder.test.ts',
      // Per-model request body overrides — extracted from index.ts (B1 Phase 1, TRDD-63314265).
      'src/request-overrides.test.ts',
      // Adaptive AIMD rate limiter — extracted from index.ts (B1 Phase 2, TRDD-63314265).
      'src/rate-limiter.test.ts',
      // Free-only switch — config core + context-floor filter (TRDD-8b6b3646).
      'src/free-only.test.ts',
      // Free-model ROTATION — the cross-call cooldown registry + the rotation
      // executor. Covers the daily-quota-vs-transient split, the "cooling models
      // are deferred, never dropped" invariant, and real on-disk persistence.
      'src/free-rotation.test.ts',
      // Rotation WIRING guard — asserts every LLM send path is rotation-aware.
      // The helper being correct is not the risk; a send site never CALLING it is
      // (that is exactly how four paths stayed pinned to one free model).
      'src/free-rotation-coverage.test.ts',
      // Auto model-reconcile PURE CORE — dead/new model detection, free-pool
      // recompute (free auto-adopt, paid warn-only), fail-open on a cold catalog,
      // and the throttle math. Hermetic; no catalog fetch, no settings IO.
      'src/model-reconcile.test.ts',
      // free-pool-auto-bench.ts retired (P6b item 6, TRDD-90DM5YHO): its job
      // (score the ':free' pool on an OFF→ON transition) is now the dynamic
      // maintainer's (dynamic-maintainer.test.ts covers it) — this include
      // entry is deliberately gone WITH the module, not left dangling.
      'src/dynamic-maintainer.test.ts',
      // The DISPATCH SITE's own reload decision (P6b-fix4 Q2) + the b.ai-only
      // boot (P6b-fix4 B1), driven through index.ts's real dispatchCallTool and
      // the real compiled CLI — the half a maintainer-level test cannot see,
      // because a rejected reload keeps the stale in-memory copy.
      'src/dispatch-reload.test.ts',
      // P14.1 (empty-pool-wait fix): the dispatch pre-flight's own
      // synchronous update-and-wait for a NEVER-yet-populated dynamic
      // profile pool -- dispatch-reload.test.ts's b.ai case is the
      // integration proof (a real CLI process), this file is the unit-level
      // proof (mocked maintainDynamicProfiles, call-count assertions).
      'src/empty-pool-wait.test.ts',
      'src/foreground-repair.test.ts',
      'src/inline-active-repair.test.ts',
      'src/outage-detection.test.ts',
      // FREE_FORBIDDEN_TOOLS vs the FREE-FORBIDDEN markers in the mass-scout
      // dispatch (P6b-fix2 B-2): the list claims "this handler sends LLM
      // completions on the profile's head", and this is what keeps the claim
      // and the handlers from drifting apart.
      'src/free-forbidden-tools.test.ts',
      // The shared duplicate-spawn lock. Tests the three staleness axes that make
      // a permanent wedge impossible — a latched lock silently freezes the
      // machine-managed dynamic profiles on a stale model set — plus the
      // release-on-exit hook and the takeover notice (P6c-a2a item 66).
      'src/bench-lock.test.ts',
      // The other half of that lock's lifecycle: the ONE detached-spawn seam.
      // Proves the parent hands the lock path down and that a REAL bundled
      // benchmark child gives the lock back on exit — the P6d dogfood defect,
      // where a child exited 0 and left its lock in the config dir.
      'src/bench-spawn.test.ts',
      // TRDD-1OOAH3LD broker (spec point 14, llama): pure scheduler/flag rules plus real
      // multi-process runs against llama-server with two tiny GGUF models.
      // `npm test` runs it in a SECOND vitest run, alone: its real llama-server load made
      // timing-sensitive files flaky when they ran alongside it (completion D1, pick-lock, regex-worker).
      'src/broker/broker.test.ts',
      'src/broker/server-commands.test.ts',
      // --until-done backoff policy. The loop it drives is unbounded, so a zero
      // wait busy-loops a rate-limited endpoint and a wrong UTC-midnight
      // calculation either stalls a day or never waits.
      'src/session_summary/until-done.test.ts',
      // The compaction size report — the one number the command exists to
      // produce. Guards against a fabricated percentage (a divide-by-zero
      // rendering as "NaN% reduction" reads like a broken compaction).
      'src/session_summary/size-report.test.ts',
      // Auto-free on low balance (<$1) — threshold/model/pool helpers (TRDD-542bdbef).
      'src/auto-free.test.ts',
      // Provider-error sanitizer — strips user_id + JSON noise from logs/reports (TRDD-54f508a4).
      'src/provider-error-sanitize.test.ts',
      // CLI success-banner helpers — pure path-pick + banner format (TRDD-54f508a4 Issue 4).
      'src/cli.banner.test.ts',
      'src/mass_scouting/fieldset.test.ts',
      'src/mass_scouting/shorthand.test.ts',
      'src/mass_scouting/registry.test.ts',
      'src/mass_scouting/preclassify.test.ts',
      'src/mass_scouting/cost-estimate.test.ts',
      'src/mass_scouting/scout.test.ts',
      'src/mass_scouting/reports.test.ts',
      'src/mass_scouting/search.test.ts',
      'src/mass_scouting/cli.test.ts',
      'src/mass_scouting/mcp-tools.test.ts',
      // TRDD-FKAR9VPK - scouting profile + scout-accuracy benchmark.
      // The scouting REQUIRE gate at the mass-scout chokepoint (D5): red-proofs
      // (a)/(b), the full A3 decision tree, and the register/estimate pin.
      'src/mass_scouting/scout-gate.test.ts',
      // The fixture + positional classifier module (D1). Pure, hermetic.
      'src/mass_scouting/scout-accuracy-fixture.test.ts',
      // The scout-accuracy ledger (D4): current-hash-only PASS, inconclusive
      // rows never authorize, stale-hash PASS never authorizes (A8/A9c).
      'src/mass_scouting/scout-accuracy-ledger.test.ts',
      // The scout-accuracy benchmark ACTION (D2), fixture-fed through the
      // injected catalog/fetch seams (A9a) - no live spend.
      'src/benchmark/scout-accuracy.test.ts',
      // security_scan — dedicated injection-hardened triage tool.
      'src/security_scan/security_scan.test.ts',
      'src/security_scan/wiring.test.ts',
      // judgeGroups' freeOnly cost-safety gate (row 101 fix-queue).
      'src/security_scan/judge.test.ts',
      // Report rendering + bounded-concurrency primitive (TRDD-828238b5 Part F wave 2).
      'src/security_scan/report.test.ts',
      'src/security_scan/concurrency.test.ts',
      // Live smoke (T10) — self-skips via describe.skipIf unless
      // OPENROUTER_API_KEY is set. Default `npm test` reports it skipped.
      'src/security_scan/security_scan_live.test.ts',
      // Live test — runs only when LIVE_TESTS=1 + OPENROUTER_API_KEY are set
      // (gated via describe.skipIf inside the file). Default `npm test`
      // reports it as skipped, runtime ~0ms.
      'src/mass_scouting/live.test.ts',
      // Calibration — runs only when CALIBRATE=1 + OPENROUTER_API_KEY are
      // set. Generates a markdown report under reports/mass_scouting_calibration/.
      'src/mass_scouting/calibrate-payload-size.test.ts',
      // cluster_synonyms primitives — pure-TS unit tests (no LLM, no network).
      'src/cluster/jsonl.test.ts',
      'src/cluster/kmeans.test.ts',
      'src/cluster/unionfind.test.ts',
      'src/cluster/checkpoint.test.ts',
      'src/cluster/preflight_benchmark.test.ts',
      'src/cluster/retry_ladder.test.ts',
      'src/cluster/phase1_batch.test.ts',
      'src/cluster/embeddings.test.ts',
      'src/cluster/cluster_synonyms_main.test.ts',
      // Pre-flight in-memory footprint guard (TRDD-828238b5 B3) — fail-fast
      // before any LLM spend when the corpus+embeddings would OOM. Pure math.
      'src/cluster/memory_guard.test.ts',
      // Cluster policy resolver (resolvePolicy / DEFAULT_POLICY / PolicySchema) —
      // pure config merge + zod validation (TRDD-828238b5 Part F wave 3).
      'src/cluster/policy.test.ts',
      // cluster_synonyms CLI surface — wiring test for the new third-surface
      // adapter (runClusterSynonymsCli). Mock rawLlmCall, no network.
      'src/cluster/wiring.test.ts',
      'src/benchmark/pick.test.ts',
      // Every settings.yaml writer must leave the user's comments intact — the
      // writers used to round-trip through a plain object and silently wipe
      // them. This include entry is load-bearing: the list is EXPLICIT, so an
      // unregistered test file runs only when named by hand and is invisible
      // to `npx vitest run` and to CI.
      'src/benchmark/pick-comment-preservation.test.ts',
      // D0 (TRDD-AL8GIZYA) — migrateSettingsTo141's price-ceiling-into-paid
      // step: moves exactly once, refuses the ambiguous case with E-D3.
      'src/benchmark/migrate-141.test.ts',
      // withSettingsWriteLock real-concurrency tests (TRDD P5 review finding
      // 5): two racing writers, a live holder, a dead-pid takeover, and the
      // wait-bound throw — each against real child processes, no mocks.
      'src/benchmark/pick-lock.test.ts',
      // Legacy-row qualityPass backfill — reclaims already-paid benchmark
      // scores that the evidence fold was discarding (86 rows, 81 of them
      // ':free', zero with a verdict as measured 2026-08-29). Pure function,
      // no model call.
      'src/benchmark/backfill-quality-pass.test.ts',
      // Zero-call standalone backfill (backfillAllLedgers) — same reclaim as
      // above, without a full benchmark run and its live model calls.
      'src/benchmark/backfill-ledgers.test.ts',
      // Per-tool model writer (applyToolModelToSettings) — CLI/cron-only,
      // read-only-MCP-guarded (TRDD-828238b5 A7-P2).
      'src/benchmark/apply-tool-model.test.ts',
      // --auto-replace / --apply CLI surface — hermetic spawn of dist/benchmark.js
      // on a healthy ledger (no network); the writer path (TRDD-828238b5 A7-P3).
      'src/benchmark/auto-replace-cli.test.ts',
      // ── P1 zero-token model pipeline ──────────────────────────────────────
      // The ROTATION threshold that replaced the agent's "is this 404 persistent?"
      // judgment: pure rule, synthetic events, injected clock.
      'src/model-events-persistence.test.ts',
      // Ensemble coverage of the ledger (planEnsembleRotation) — real ledger file.
      'src/model-qualification/ensemble-rotation.test.ts',
      // The flag defaults that used to be prose the agent had to apply by hand
      // (--qualifying-top-n 15) + the P1 writer flags.
      'src/benchmark/cli-args.test.ts',
      // The check_imports golden dataset's ORACLE tests (TRDD-f45eeaa0). The
      // derivation must exclude a `from "real bug"` that really occurs in a
      // trailing comment in its own corpus — an oracle that feels authoritative
      // and is wrong is the failure this file exists to prevent.
      'src/benchmark/check-imports/dataset.test.ts',
      'src/benchmark/check-imports/score.test.ts',
      'src/benchmark/check-imports/bench-runner.test.ts',
      'src/benchmark/compare-files/dataset.test.ts',
      'src/benchmark/compare-files/score.test.ts',
      'src/compare-files/prompt.test.ts',
      'src/benchmark/compare-files/bench-runner.test.ts',
      'src/benchmark/check-references/dataset.test.ts',
      'src/benchmark/check-references/bench-runner.test.ts',
      // The phase-1 prompt seam both the tool and its benchmark depend on.
      'src/check-imports/prompt.test.ts',
      // The two new CLI-only settings writers (free_models pool, new-arrival
      // adoption). Real files, real atomic tmp+rename.
      'src/benchmark/apply-free-pool.test.ts',
      'src/benchmark/apply-ensemble-slot.test.ts',
      // P6b-fix2 B-1: the generated `free`/`paid` sections have ONE writer —
      // every write command in the benchmark entry refuses them UP FRONT,
      // before it writes anything. Hermetic spawn of the real bundle.
      'src/benchmark/generated-profile-writes.test.ts',
      // The [OK|FAILED] final-line + exit-code contract — hermetic spawn of the
      // real bundle (no network, no key): prereq self-check, cache pick, writers.
      'src/benchmark/cli-contract.test.ts',
      // row99 fix-queue: main()'s settings/active-profile resolution fails
      // fast instead of silently running on defaults — hermetic spawn of a
      // FRESH esbuild bundle of the current source (not dist/benchmark.js).
      'src/benchmark/settings-resolution-failfast.test.ts',
      // security-triage model benchmark — golden dataset loader, scorer, and
      // the selection gate. Pure-TS unit tests (no LLM, no network).
      'src/benchmark/security-triage/dataset.test.ts',
      'src/benchmark/security-triage/score.test.ts',
      'src/benchmark/security-triage/select.test.ts',
      // staleFailedModelIds — design §5's 7-day re-probe, the only path that
      // ever lets a model out of the benchmark-failure set (P6b-fix N3).
      'src/benchmark/security-triage/stale-failed-ids.test.ts',
      // Real-model end-to-end smoke — self-skips unless OPENROUTER_API_KEY is set.
      'src/benchmark/security-triage/live.test.ts',
      // security-triage casesToGroups — pure cases→DedupGroup transform (Part F wave 3).
      'src/benchmark/security-triage/runner.test.ts',
      // security-triage model ROUTING + free_only — HERMETIC end-to-end of the real
      // orchestrator (fake catalog + judge FetchImpl only): the candidate under test is
      // the model actually sent, and free mode never sends the paid incumbent.
      'src/benchmark/security-triage/free-mode.test.ts',
      // security-triage P4 pre-flight workload description — derives callsPerModel /
      // promptCharsPerModel from the real golden dataset + the real judge prompt
      // builders. No network.
      'src/benchmark/security-triage/workload.test.ts',
      // Shared same-or-cheaper selection gate (TRDD-828238b5 A6) — generic
      // three-gate math reused by every per-tool selector. No LLM, no network.
      'src/benchmark/select-common.test.ts',
      // Benchmark report rendering + ground-truth handling (TRDD-828238b5 Part F).
      'src/benchmark/report.test.ts',
      'src/benchmark/ground-truth.test.ts',
      // C9 write-roots sweep (2026-09-18): report-path defaults for the six
      // sub-benchmarks (report-dir.ts) and benchmark/index.ts's buildReportPath.
      'src/benchmark/report-dir.test.ts',
      'src/benchmark/build-report-path.test.ts',
      // Model-discovery pure logic (filter/disqualify/qualify/roster) + run scorer
      // (scoreRun) — TRDD-828238b5 Part F wave 3. No network (fetchProgrammingModels excluded).
      'src/benchmark/discover.test.ts',
      'src/benchmark/price-cap.test.ts',
      'src/benchmark/paid-guard.test.ts',
      'src/benchmark/bench-free-pool-roster.test.ts',
      'src/benchmark/validated.test.ts',
      'src/benchmark/score.test.ts',
      // D7a: the runner's endpoint parameter + the sequential local-model benchmark
      // core (USER spec 3.2). Real 127.0.0.1 HTTP servers; no external network.
      'src/benchmark/local-bench.test.ts',
      // search-existing per-tool benchmark (TRDD-828238b5 A6) — fixture-backed
      // golden dataset + deterministic precision/recall scorer. No LLM, no network.
      'src/benchmark/search-existing/dataset.test.ts',
      'src/benchmark/search-existing/score.test.ts',
      // search-existing in-process runner — HERMETIC (fake FetchImpl seam only,
      // real pipeline + real scorer). No network, no module mocking.
      'src/benchmark/search-existing/runner.test.ts',
      // search-existing selection gate — criteria identity + winner/incumbent paths.
      'src/benchmark/search-existing/select.test.ts',
      // search-existing P4 pre-flight workload description — derives callsPerModel /
      // promptCharsPerModel from the real fixture corpus + the real FFD bin-packing
      // helper (readAndGroupFiles). No network.
      'src/benchmark/search-existing/workload.test.ts',
      // scan_folder in-process pipeline core — HERMETIC (fake processFileCheck
      // seam only, real rateLimitedParallel + real report assembly). No network,
      // no module mocking (B1 Phase 3, TRDD-63314265).
      'src/benchmark/scan-folder/runner.test.ts',
      // code_task in-process pipeline core — HERMETIC (fake processFileCheck +
      // ensembleStreaming seams only, real readAndGroupFiles + grouping + report
      // assembly). Covers single/inline/batch modes. No network, no module
      // mocking (B1 Phase 3, TRDD-63314265).
      'src/benchmark/code-task/runner.test.ts',
      // code_task CODE-AUDIT per-tool benchmark (P2b) — golden corpus of REAL
      // pre-fix snapshots from this repo's git history + a deterministic,
      // judge-free localization scorer + the same-or-cheaper selection gate.
      // bench-runner.test.ts is HERMETIC (fake FetchImpl seam only; real
      // pipeline, real prompt, real fixtures, real scorer). No LLM, no network.
      'src/benchmark/code-task/dataset.test.ts',
      'src/benchmark/code-task/score.test.ts',
      'src/benchmark/code-task/select.test.ts',
      'src/benchmark/code-task/bench-runner.test.ts',
      // code_task P4 pre-flight workload description — derives callsPerModel /
      // promptCharsPerModel from the real dataset + fixtures on disk. No network.
      'src/benchmark/code-task/workload.test.ts',
      // scan_folder MASS-SEARCH per-tool benchmark (P2c) — twelve files copied
      // VERBATIM from this repo's own src/, three queries whose true MATCH set is
      // DERIVED from the corpus bytes (never hand-listed), a deterministic
      // judge-free per-file MATCH/NO_MATCH scorer, and the same-or-cheaper gate.
      // bench-runner.test.ts is HERMETIC (fake FetchImpl seam only; real pipeline,
      // real prompt, real fixtures, real scorer). No LLM, no network.
      'src/benchmark/scan-folder/dataset.test.ts',
      'src/benchmark/scan-folder/score.test.ts',
      'src/benchmark/scan-folder/select.test.ts',
      'src/benchmark/scan-folder/bench-runner.test.ts',
      // check_against_specs in-process pipeline core — HERMETIC (fake
      // ensembleStreaming seam only, real readFileAsCodeBlock + readAndGroupFiles
      // + grouping + report assembly). Covers per-file / batched / grouped modes.
      // No network, no module mocking (P2a, zero-token model pipeline).
      'src/benchmark/check-specs/runner.test.ts',
      // check_against_specs SPEC-ADHERENCE per-tool benchmark (P2d) — this repo's own
      // shipped TESTING.md audited over thirteen VERBATIM git snapshots, four of them
      // the exact pre-fix bytes a real cost-safety commit replaced, each next to its
      // own fixed twin. Deterministic judge-free per-file CLEAN/VIOLATION scorer + the
      // same-or-cheaper gate. bench-runner.test.ts is HERMETIC (fake FetchImpl seam
      // only; real pipeline, real prompt, real fixtures, real scorer) and ASSERTS that
      // four code-blind baselines FAIL the gate — the corpus cannot decay into
      // something a grep could pass. No LLM, no network.
      'src/benchmark/check-specs/dataset.test.ts',
      'src/benchmark/check-specs/score.test.ts',
      'src/benchmark/check-specs/select.test.ts',
      'src/benchmark/check-specs/bench-runner.test.ts',
      // Text-tools (summarize/topics/sem_deduplicate/describe) per-tool benchmarks —
      // hand-curated concept-recall corpora (dataset.ts), a deterministic judge-free
      // scorer (score.ts), and bench-runner.test.ts driving the REAL text-tools/core.ts
      // pipeline functions through a fake FetchImpl seam only. No LLM, no network.
      'src/benchmark/text-tools/dataset.test.ts',
      'src/benchmark/text-tools/score.test.ts',
      'src/benchmark/text-tools/bench-runner.test.ts',
      // Pre-flight workload descriptions (P4) — each derives callsPerModel /
      // promptCharsPerModel from that benchmark's REAL corpus on disk, so a corpus edit
      // moves the spend estimate automatically and a stale literal can never quietly
      // under-price a sweep. No network, no LLM.
      'src/benchmark/scan-folder/workload.test.ts',
      'src/benchmark/check-specs/workload.test.ts',
      // WK-01 (TRDD-IYL8GCAR): characterization of the 6 benchmark workloads' orchestrators (cache, gates, selection, reports) before the workload-kit migration.
      'src/benchmark/workload-characterization.test.ts',
      // ── P3 + P4: --update-all + the HARD SPEND CAP ────────────────────────
      // The per-call spend chokepoint: reserve-BEFORE-send, book-actual-after, and the
      // trip latch that stops a sweep dead. The latch is load-bearing because every
      // runner CATCHES fetch errors (never-throw contract), so a throw alone would be
      // swallowed and the sweep would keep spending. Real ledger + real wrappers; only
      // the HTTP wire is a stub.
      'src/benchmark/budget.test.ts',
      // The one-command refresh: the requirement gate, the pre-flight estimate + abort,
      // the mid-sweep abort driven through the REAL ledger, and the benchmark-proven vs
      // requirement-gated distinction the report must never blur. The catalog and the
      // per-tool runners are seams; settings.yaml is a REAL file written by the REAL
      // atomic writers.
      'src/benchmark/update-all.test.ts',
      // --populate-default-profile NAME: unlike --update-all (which refreshes every
      // registered tool), populates exactly ONE named machine-managed dynamic
      // profile — 'free' | 'paid', the only two the flag accepts since P6c-a
      // retired the free-ensemble/paid-ensemble/paid-mass-scout trio (and `active:`
      // with it, so nothing writes settings.active any more). Injected catalog +
      // sweep seams (no network); the pre-flight budget abort and settings.yaml
      // writes are the REAL code.
      'src/benchmark/populate-default-profile.test.ts',
      // Per-tool model-qualification registry (TRDD-f45eeaa0 framework core).
      'src/model-qualification/registry.test.ts',
      // Cross-tool model assessment (requirements half of the per-tool gate).
      'src/model-qualification/assess.test.ts',
      // check_model_health drift detection (TRDD-828238b5 A2).
      'src/model-qualification/drift.test.ts',
      // Auto-replacement loop CORE — ledger-triggered per-tool benchmark planner
      // (TRDD-828238b5 A7-P2). Injected seams, no network.
      'src/model-qualification/auto-replace.test.ts',
      // New-model autodiscovery — catalog snapshot diff (TRDD-828238b5 A4).
      'src/model-qualification/new-arrivals.test.ts',
      // Doc-consistency gate — README counts/names match the source (A5).
      'src/doc-consistency.test.ts',
      // Codex-removal guard — shipped tree must never invoke the codex CLI (TRDD-1e2b87cb).
      'src/no-codex-invocation.test.ts',
      'src/default-output-dir.test.ts',
      // File-walking + FFD bin-packed batching engine (TRDD-828238b5 Part F).
      'src/scan-pipeline.test.ts',
      // --estimate dry-run estimator (task #187) — pure arithmetic + fail-fast negatives.
      'src/estimate.test.ts',
      // review_plan delegate-mode plan builder (TRDD-SNAEERHU).
      'src/review-plan.test.ts',
      // Layered per-path review rules (TRDD-3JQVBO7M).
      'src/review-rules.test.ts',
      // Diff-mode review scoping against a real fixture git repo (TRDD-MNK2YNH0).
      'src/diff-scope.test.ts',
      'src/cluster/phase2_verify.test.ts',
      'src/cluster/phase3_canonical.test.ts',
      // session-summary P1 reader/pruner + P2 turn-boundary chunker + P3 model
      // selection + P4 map-reduce driver (TRDD-T4MZ8YQR).
      'src/session_summary/transcript.test.ts',
      'src/session_summary/chunker.test.ts',
      'src/session_summary/model-select.test.ts',
      'src/session_summary/driver.test.ts',
      // Transcript-path resolution (P5, TRDD-T4MZ8YQR) — CLAUDE_CONFIG_DIR /
      // CLAUDE_CODE_PROJECT_DIR_NAME env overrides + timestamp-based recency
      // (Claude Code 2.1.234 / 2.1.239 alignment).
      'src/session-summary-resolve.test.ts',
      // Shared response gate (TRDD-P4ULUV1R) — the non-empty + non-echo verdict
      // every surface applies before accepting a model response.
      'src/response-gate.test.ts',
      // Per-SURFACE proof the same gate is WIRED at its four acceptance sites.
      'src/response-gate.surfaces.test.ts',
      // Request-deadline contract (TRDD-0H5N1V9W) — the timeout must cover the
      // BODY read, not just time-to-first-byte. Regression for a shipped bug
      // where a stalled generation hung the run forever (measured 1890s against
      // a 300s cap) because the abort timer was cleared when headers arrived.
      'src/provider/http.test.ts',
      // Per-call deadline override — resolveConnection is the single point every
      // request's timeout flows through, so a dropped override would be silent
      // (a slow run, not a wrong number).
      'src/provider/connection.test.ts',
      // D6b (90DM5YHO) — detector + resolveConnection flavor branch; the F-6
      // reservation pins ride in index.test.ts (already registered).
      'src/provider/endpoint-flavor.test.ts',
      // Global `llm-ext` PATH shim (TRDD-VV0INGRT) — the SessionStart installer
      // hook and the resolver wrapper it installs to ~/.local/bin/llm-ext.
      'src/path-shim.test.ts',
      // Guards test-hermetic-config.ts: during the suite getConfigDir() must
      // never resolve to the real ~/.llm-externalizer, and must resolve
      // under /tmp (TRDD-90DM5YHO).
      'src/config-dir-hermetic.test.ts',
      // TRDD w2-honest-402 — a static profile with no free models must not
      // claim a switch to free that never happened (classifyError Path 1,
      // withFreeRotation Path 2).
      'src/honest-402.test.ts',
      // fix-queue rows 102/27 (C5) — a raw 402 at the three chain-walk bypass
      // sites (ensemble slot, caller-pinned modelOverride, free-pool rotation)
      // on a DYNAMIC (`free`/`paid`) profile, plus chatCompletionWithProfile
      // Fallback's own dynamic-kind announce/maintain/retry-once sequence.
      'src/profile-chain-402.test.ts',
      // TRDD-HBCCFOUF free-fitness benchmarks — the two addendum-H gates that
      // let the dynamic `free` profile serve mass_scout / high_quality_scan:
      // the verdict ledger (latest-wins, current-hash, fail-closed unlock),
      // the sustained-throughput burst (16-worker concurrent fan-out, 429s
      // recorded) and the hq quality bar over the scan-folder corpus. All
      // HERMETIC (fake FetchImpl seam only; real scorer, real gate math).
      'src/benchmark/free-fitness-ledger.test.ts',
      'src/benchmark/mass-scout-throughput.test.ts',
      'src/benchmark/hq-scan-quality.test.ts',
      // L1-07 estimateTokens: pure char-class token estimate, no I/O.
      'src/classifiers/l1/estimate.test.ts',
      // L2-06 (TRDD-SNZ17S5L): readForJev + input walk rules; real temp dirs and real git, no doubles.
      'src/classifiers/l2/inputs.test.ts',
      // P-03 (TRDD-OP8ZMLOZ): committed P-01/P-02 fixtures must carry no account or request identity.
      'src/classifiers/__fixtures__/secrets.test.ts',
      // L0-01 (TRDD-NL788NGR): error taxonomy and status mapping over real P-01 replies plus synthetic statuses.
      'src/classifiers/l0/errors.test.ts',
      // L0-07 (TRDD-CASL940C): decisions catalog loader over the real P-02 catalog reply; cache, TTL, lock, E16.
      'src/classifiers/l0/catalog.test.ts',
      // L0-05 (TRDD-OSIGZK0O): 200-reply parsing over real P-01 replies plus synthetic faults; usage recorded before answer checks.
      'src/classifiers/l0/response.test.ts',
      // L0-08 (TRDD-MKEWC00E): resolveModel alias to target and endpoint prompt limit over the real P-02 replies.
      'src/classifiers/l0/model.test.ts',
      // L0-02 (TRDD-CWQOWEHO): callDecisions request building, key-in-body refusal, 1 MB cap, redirect error; real P-01 replies, real local server for the 3xx.
      'src/classifiers/l0/transport.test.ts',
      // PF-01 (TRDD-82LIQI5I): classifier profile schema, E84, and the D2 spend gate; pure, no I/O.
      'src/classifier-profile.test.ts',
      // L1-03 (TRDD-P7OR5OQP): ValidationPolicy presets, tolerances and noul validation over the real P-01 noul replies.
      'src/classifiers/l1/validate.test.ts',
      // L1-01 (TRDD-V6HL0ERI): question types and builders; refusals at build, wire shape against real P-01 replies.
      'src/classifiers/l1/questions.test.ts',
      // L1-09 (TRDD-UPZR8PAY): usage and cost record; the 78 real P-01 usage.cost figures, the E12 estimate from the P-02 catalog price, and history lines written before answer checks.
      'src/classifiers/l1/usage.test.ts',
      // L1-08 (TRDD-PANO8WS4): model-id helpers; served build parsed from a real P-01 reply, alias compare against the P-02 catalog.
      'src/classifiers/l1/model-id.test.ts',
      // L1-02 (TRDD-9TF7SI2I): question-count and serialized-size refusals; limits checked against the real P-01 413 reply.
      'src/classifiers/l1/request-shape.test.ts',
      // L1-05 (TRDD-NB7JXJGF): score validation, expected-value and integer-index, over the real P-01 score replies.
      'src/classifiers/l1/validate-score.test.ts',
      // L1-04 (TRDD-7W3JFF7V): choice validation; scaled sum, tie, unknown keys, range, over the real P-01 choice replies.
      'src/classifiers/l1/validate-choice.test.ts',
      // L1-06 (TRDD-OC18PZ4V): answer-set rule over a whole reply: missing, extra and wrong-type answers (E27).
      'src/classifiers/l1/validate-answers.test.ts',
      // SP-00 (TRDD-DAGBDXUB): DecisionSpec registry shape checks, every catalog file registered, classify tools in definitions.ts name a spec.
      'src/classifiers/catalog/index.test.ts',
      // L2-08 (TRDD-73QJ54HS): caller item-id rule D14 and index-keyed question keys; pure.
      'src/classifiers/l2/ids.test.ts',
      // L2-10 (TRDD-9BBMGTC3): threshold bands, margin, max-gated and range checks; pure.
      'src/classifiers/l2/policy-kit.test.ts',
      // L2-15 (TRDD-LHBW770C): redaction of cyclic, deep, Map and class-instance values; pure.
      'src/classifiers/l2/redact.test.ts',
      // L2-18 (TRDD-WVG0VPZB): Ctrl-C abort of a fan-out with real timers and real AbortSignal; usage of finished requests kept.
      'src/classifiers/l2/abort.test.ts',
      // L2-09 (TRDD-JDMY8LPJ): evidence state with indexed sources and truncation flags; pure, real readForJev on /tmp files.
      'src/classifiers/l2/evidence.test.ts',
      // L2-07 (TRDD-6NYXR3FE): content secret redaction before send (E37); both existing redactSecrets over one fixture set; pure.
      'src/classifiers/l2/content-redact.test.ts',
      // L2-12 (TRDD-B3R1SCSX): result envelope schema 1; usage and cost summed from real P-01 replies, snapshots, stopped budget.
      'src/classifiers/l2/envelope.test.ts',
      // L2-14 (TRDD-ET4XHRHK): one warning record and one degraded record (with fallback) shared by classify and browse; pure.
      'src/classifiers/l2/warnings.test.ts',
      // L2-13 (TRDD-9FE4Q3H3): exit codes: attention under --strict-exit, and error class to 3/4/5; pure, over real ClassifierError values.
      'src/classifiers/l2/attention.test.ts',
      // L2-16 (TRDD-FFWAXZRN): -o JSON report writer: default dir, timestamped name, atomic write, E52 unwritable dir; real /tmp directories.
      'src/classifiers/l2/report.test.ts',
      // L2-11 (TRDD-37X07EPM): opt-in --max-budget: no check without the flag; E49 estimate refusal, E87 unknown price, E86 mid-run stop; pure.
      'src/classifiers/l2/cost-cap.test.ts',
      // L2-01 (TRDD-YB1KEVKC): planner core: greedy packing, envelope, E42/E43 refusals on real question builders.
      'src/classifiers/l2/planner.test.ts',
      // L2-19 (TRDD-PXVVVPYV): quicksilver chunker (cut rule, 500-char overlap, JSON-state groups) and chunk merge (E114-E118); pure.
      'src/classifiers/l2/chunker.test.ts',
      // L2-04 (TRDD-M2X02VG9) + L2-05 (TRDD-QUJMEXA4): runPlan fan-out, merge, usage, snapshots, 429 burst, budget stop, partial failure; recorded P-01 replies through the GlobalFetch seam.
      'src/classifiers/l2/fan-out.test.ts',
      // SP-04 (TRDD-NGXUX45F): find spec: JSON best/exists, file-line mode where/exists, E129 line pieces, score p(where) x p(exists), min-score/top, injection placement, over real P-01 replies.
      'src/classifiers/catalog/find.test.ts',
      // SP-07 (TRDD-UQ8TYKC9): rank spec: 5-level score, relevance = score/4, top/all, head/keep-at, E34, E63, E72, injection placement, over real P-01 score replies.
      'src/classifiers/catalog/rank.test.ts',
      // SP-05 (TRDD-KKMJA9B5): label spec: build, project, E58-E60, E117 merge default, injection placement, over real P-01 choice replies.
      'src/classifiers/catalog/label.test.ts',
      // SP-06 (TRDD-N1FQ8A8K): decide spec: one unsplittable request, E61 escape hatch, E62 19-question limit, escalate flag, injection placement, partial failure; real P-01 choice replies.
      'src/classifiers/catalog/decide.test.ts',
      // SP-08 (TRDD-FPD1G0VB): compare spec: overall unsplittable in one request, aspect relations, auto/margin policy, injection placement, partial failure; real P-01 choice replies.
      'src/classifiers/catalog/compare.test.ts',
      // SP-09 (TRDD-B19TVE91): extract spec: Jev only for 2+ regex matches, E65 no candidates, E66 candidate cap, status order, none_of_them, cut document, candidates in criteria (D5 exception), partial failure; real P-01 choice reply.
      'src/classifiers/catalog/extract.test.ts',
      // PT-04 (TRDD-N2L9BN1Q): scouting as the fifth built-in template: fresh install, marker migration, writer, mass-scout refusal; real files under /tmp.
      'src/scouting-template.test.ts',
      // PT-06 (TRDD-W57VQ346): strict per-type fields fail the load naming field and type (E81e); pure.
      'src/profile-strict-fields.test.ts',
      // PF-03 (TRDD-W418LXJK): built-in or-jev classifier template on a fresh install and E82 (active_classifier names a missing profile); real files under /tmp.
      'src/or-jev-template.test.ts',
      // PF-04 (TRDD-4GZJL3NH, E83): migration step or-jev-section-added: template added once, hand-written or-jev marked and kept, restore and dedupe; real /tmp files.
      'src/or-jev-migration.test.ts',
      // L2-17 (TRDD-7BT0W914): classifier profile resolution: active_classifier or --profile, PT-03 type check, schema, defaults, no paid gate (D2), catalog checks on the selection path; real catalog, replay fetch.
      'src/classifiers/l2/profile.test.ts',
      // Review round on PT-06/PF-03: migration notice, tables vs generated sections, or-jev tuning, error duplicates, banner; real /tmp files.
      'src/profile-review-round.test.ts',
      // PF-02 (TRDD-FFPDWWGN): selection-time decisions-catalog checks (guard, model exists, E19, E16) over the real P-02 catalog; replay fetch, no network.
      'src/classifiers/profile-checks.test.ts',
      // PT-03 (TRDD-B9FWID59): acceptedProfileTypes table + the runtime check (E80, E81, E81i); pure over the real tool catalog.
      'src/profile-accept.test.ts',
      // SP-01 (TRDD-0G2IVEVU): verify decision spec: build, project, E55/E56, attention; real P-01 replies re-labeled.
      'src/classifiers/catalog/verify.test.ts',
      // SP-02 (TRDD-SILI0HS8): screen decision spec: thresholds 0.75/0.25/0.3, action order, fail-closed invalid answers, purpose in instructions.
      'src/classifiers/catalog/screen.test.ts',
      // SP-03 (TRDD-HJTLZ4T2): filter decision spec: band sets, E57 threshold rules, E128, --lines collapsing, --save rows; real P-01 noul replies.
      'src/classifiers/catalog/filter.test.ts',
      // C4-01 (TRDD-BUL4EEBP): the generic runner end to end over the filter spec: exit codes, cap, chunking, key never leaks; replayed real replies, no network.
      'src/classifiers/run-decision.test.ts',
      'src/classifiers/system-one-fallback.test.ts',
      // SP-14 (TRDD-OHLMZONY): findings decision spec: four questions per finding, keep/keep_low/drop policy, E71 empty window, index-scoped injection, partial failure; real P-01 noul and score replies.
      'src/classifiers/catalog/findings.test.ts',
      // SP-17 (TRDD-O5NUD6IT): test-output decision spec: grep-found failing blocks first, E74 chunked log, highest-regression merge, class/regression/severity/evidence policy, partial failure; real P-01 noul replies.
      'src/classifiers/catalog/test-output.test.ts',
      // SP-10 (TRDD-N2TDAXL4): audit decision spec: 4 checks plus absence max-gated at wrong_at, E67 truncated source, index-scoped injection, partial failure; real P-01 noul reply.
      'src/classifiers/catalog/audit.test.ts',
      // SP-11 (TRDD-QFPC4Z8P): review decision spec: whole and per-file, 4 risk scores + unsafe, composite, reason codes, --claims, E68-E70, index-scoped injection, partial failure; real P-01 replies.
      'src/classifiers/catalog/review.test.ts',
      // SP-13 (TRDD-0JLI6PGT): check decision spec: presets invariant-check and criterion-vs-tests, labels and attention per preset, ties, index-scoped injection, unanswered items; real P-01 choice reply.
      'src/classifiers/catalog/check.test.ts',
      // EV-01 (TRDD-ABPSC16L): classify-eval jsonl dataset loader and fingerprint.
      'src/benchmark/classify-eval/dataset.test.ts',
      // C4-02 (TRDD-V8Q20MLW): classify tool entries generated from the catalog; entries equal their spec, shared flags equal what runDecisionArgv parses.
      'src/tools/definitions-classify.test.ts',
      // C4-03 (TRDD-4Q1IVJOE): classify group of the launcher (in process, replayed replies) and the same through the built CLI (needs `npm run build`).
      'src/cli/classify-launch.test.ts',
      'src/cli/classify-launch-cli.test.ts',
      // SP-22 (TRDD-DTDGVXWV): regex worker thread for extract, E64 timeout, no leaked thread.
      'src/classifiers/l2/regex-worker.test.ts',
      // IN-01: file inputs (positionals, --items, --lines, ...) of filter/rank/find through collectInputs.
      'src/classifiers/input-args.test.ts',
    ],
  },
});
