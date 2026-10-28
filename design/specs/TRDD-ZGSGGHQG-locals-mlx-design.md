# TRDD-ZGSGGHQG design: mac-only locals-mlx profile on the Locals server

Status: written 2026-10-28 after two adversarial review rounds, WAITING FOR USER APPROVAL. No code before approval.
Evidence: reports/locals-mlx/20261028_191159+0100-facts.md, 20261028_192216+0100-concurrency.md, 20261028_192745+0100-memory-docs.md, 20261028_194040+0100-design-measure.md, 20261028_194347+0100-round2-measure.md.

## Rationale
Add a mac-only locals-mlx profile that runs MLX models only through the Locals server, sends many requests at once to that one server and port, and makes requests wait on low memory instead of failing (user rulings on the card, verbatim).

## Order
L1 (preset, profile, gates) first; L3 (parallel requests, memory floor, liveness wait) second, independent of TRDD-1OOAH3LD 2a; L2 (managed start and stop) last, only after the user approves 2a revision 4 (it reuses the 2a seam: deps.ensureLocalServer in resolveConnection, ManagedServerError final-stop, failed start remembered per port for the command). Until L2 lands the user starts Locals by hand; a closed port is a connection failure and llm-ext falls back by default.

## L1 preset, profile, gates
- Preset locals-local in API_PRESETS: protocol openai_api, defaultUrl http://127.0.0.1:9090, defaultAuthEnv "", defaultTimeout 1800 (superseded for in-flight requests by the L3 liveness wait), isLocal true, defaultContextWindow 0.
- Profile locals-mlx written once to settings.yaml (as increment 5 of TRDD-1OOAH3LD writes local_llama): mode local, api locals-local, url http://127.0.0.1:9090, model LiquidAI/LFM3-1.7B-MLX-4bit, request_options {default: {thinking: false, max_output_tokens: 4096}} (measured: thinking false already sends chat_template_kwargs.enable_thinking false; max_output_tokens is required; 4096 is Locals' own cap), max_parallel set from the slots value.
- Gate: a locals-local profile is refused at validation and at use unless process.platform is darwin and process.arch is arm64 ("locals-mlx needs macOS on Apple silicon"). First darwin check in the source.
- MLX gate: refuses a model ending in .gguf or starting with mlx/ (the stock mlx engine has no memory guard). Stated honestly: a guard against known-bad inputs; Locals enforces the MLX format.
- Model check: GET /stats model must equal the profile model (measured: /stats.model is the full HF id; Locals itself compares the same way).

## L3 parallel requests (only local profiles with max_parallel > 1)
1. New local-profile key max_parallel (integer >= 1, default 1: no other local profile changes). getRateLimitConfig (index.ts:1117) returns maxInFlight max_parallel and an rps that does not throttle starts for that profile (measured: rps 1 also caps start rate).
2. The default single-attempt chat loop (index.ts:4748, max_retries 1) dispatches through the rate-limited pool when maxInFlight > 1 (measured: raising maxInFlight alone does not parallelise it). Invariants kept and tested: report order equals input order, per-file report names unchanged, progress lines whole (not interleaved mid-line).
3. max_parallel is capped at the server slots. For a server llm-ext started, slots is known. For a reused server started by the user, slots is read from Locals' own options file under ~/.locals/ when present, else max_parallel 1, and server-status says which.
4. Memory floor (darwin only, stated): before each new request, memory_pressure free percentage >= memory_floor_percent (profile key, provisional default 10, marked for calibration). On a miss the request waits in llm-ext's queue; one shared poller per process re-checks every second and prints one progress line every 30 s. Never an error. The /stats held-count gate is dropped (it starved llm-ext's own batching); Locals' own memory holding is relied on.
5. Liveness wait instead of a total timeout for locals-local: connect timeout as today; once connected, the request has no whole-request deadline. The shared poller reads /health and /stats every few seconds while requests are in flight. A request fails only when /health stops answering for 30 s (server dead) or when /stats shows nothing held and no progress counter (tokens_out, passes) moves for 10 minutes (server hung). A request held for memory or slots therefore never fails and is never re-sent (measured: Locals cancels a queued request when its client disconnects, so no double execution arises from a client abort). A closed port still fails at once with ECONNREFUSED.
6. Failure classification: a liveness failure throws an error carrying the endpoint kind explicitly (measured: a local timeout code travels only in failureOf(err).networkCode and does not match the dead-URL message regex at index.ts:3247), so walkProfileChainOnce marks the Locals URL dead for that walk and falls back by default; --stop_on_errors (own TRDD) makes it fail.

## L2 managed start and stop (after 2a approval)
1. Probe before any start: Locals on the port with the same model is reused; Locals with a different model, or a non-Locals listener, is refused before anything runs (measured: locals start would otherwise SIGTERM an idle Locals background server to switch models).
2. Start method: user decision. A = locals start --model M --port P --slots N (the user's earlier ruling; it rewrites ~/.locals/config.json defaults, measured). B (recommended) = spawn python -m locals.server --port P --model M --slots N detached from the Locals tool venv (measured: leaves config.json and Locals pid files untouched); the interpreter is resolved from the locals wrapper's shebang, a missing path is a clear error.
3. Recorded at start in locals-<port>.json: pid, model, port, slots. Stop requires the pid alive and its command line naming locals.server and --port P, so a Locals server the user restarted by hand is never stopped.
4. server-status and server-stop (2a) cover Locals ports listed in llm-ext's own state files.

## Tests (real, no mocks; Locals tests run the server module directly on a random free port, never 8321 or 9090, never locals start, killed in finally)
- L1 pure: platform gate, MLX gate, profile parsing.
- L3: speed-up ratio T(max_parallel 2) / T(max_parallel 1) < 0.75 on the same private server (--slots 2) in the same run; 6 requests at --slots 2 all complete with no error; memory floor forced high then lowered: waits then drains with no error (docstring: proves the waiting mechanism, not detection of real low memory); --slots 1 with a short liveness window and two long requests: both complete, no error; max_parallel 1 keeps the sequential order; output order and report names unchanged at max_parallel 2; fixtures are recorded real /stats and memory_pressure output, dated.
- L2: start, reuse, both refusals, stop of our own server, a hand-restarted server not stopped.

## Disclosed
- ~/.locals/config.json was changed from port 8321 to 9090 by an earlier measurement that ran locals serve --port 9090 (inferred from logs, round-2 measure). Restoring it to 8321 needs the user's go-ahead (file outside the project).

## Pending user decisions
1. L2 start method: A (locals start) or B (server module directly, recommended).
2. Idle Locals server: killed after 2 hours without requests like local_llama, or kept running until server-stop.
3. Locals tests on non-mac CI: skipped with a printed reason?
4. Reuse a user-started Locals server serving the same model.
5. Restore ~/.locals/config.json port to 8321.
