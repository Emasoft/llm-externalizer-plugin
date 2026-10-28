# TRDD-1OOAH3LD increment 2a plan: managed llama-server supervisor

Status: after two adversarial review rounds (2026-10-28); waiting for three user rulings (idle behaviour, test skip without llama-server, test behaviour offline).
Evidence: reports/llama-cpp-profile/20261028_152005+0100-increment-2-facts.md, 20261028_152147+0100-sleep-idle-measure.md, 20261028_152615+0100-increment-2-measure.md, 20261028_152921+0100-increment-2a-measure.md.

## Rationale
For a local profile that explicitly opts in, llm-ext starts llama-server itself when a command first calls the model, recognises its own server, never touches another process, and gives the user server-status and server-stop.

## Design
- Opt-in key `server: managed` on local profiles (PROFILE_TYPE_FIELDS.local, same five touch points as request_options). Valid only with api llamacpp-local and url http://127.0.0.1:<explicit port>; win32 is refused with a clear error. Profiles without it are unchanged.
- Target computed at call time from activeResolved through providerDeps (index.ts ~1765): model `org/repo:quant` (kind hf) or an absolute .gguf path with no whitespace that exists (kind file).
- New module scripts/llm-ext/src/local-llama-server.ts. Config-dir files: state llama-server-<port>.json {pid, model, port, ctx, startedAt} written temp-then-rename, mode 0600; log llama-server-<port>.log (previous kept as .log.1 on each spawn); lock dir llama-server-<port>.lock.
- New ASYNC mkdir lock (mkdir to take, rmdir in finally, same stale rule as mkdir-lock.ts). Inside the lock: re-read state; identity = kill(pid,0) (EPERM = not ours) plus `ps -ww -o command= -p <pid>` tokenised (argv0 basename llama-server, exact token after -hf/-m equals model, exact token after --port equals port). Our server with same model and ctx: no spawn. Different model or ctx: refusal telling the user to run `llm-ext models server-stop`. No valid state: TCP-connect probe; a listener = hard failure naming the port (and the stale state file if present). Port closed: spawn `llama-server (-hf <model> | -m <path>) --alias <model> --host 127.0.0.1 --port <port> [-c <ctx> when > 0] --jinja <IDLE FLAGS>` detached, env process.env, stdio to the log, ENOENT error says llama-server is not on PATH, unref, state written with the child pid before the lock is released.
- Readiness outside the lock, every 0.5 s: pid dead = failure with log hints; TCP refused with pid alive = downloading or starting (the port stays closed for the whole download, measured); 503 = loading; 200 = GET /v1/models data[0].id must equal the model, else hard failure naming both values. Stall limit: failure when neither the log nor the model cache folder (llama.cpp order LLAMA_CACHE, HF_HUB_CACHE, HUGGINGFACE_HUB_CACHE, HF_HOME/hub, XDG_CACHE_HOME/huggingface/hub, ~/.cache/huggingface/hub; partial file blobs/<sha>.downloadInProgress, measured) has grown for 120 s. The wait is not bounded by the request timeout.
- Hints: unknown model architecture or load error: on darwin with brew `brew upgrade --fetch-HEAD llama.cpp`, else upgrade llama.cpp; couldn't bind: port conflict; else last 20 log lines.
- In-process: one in-flight promise per port, rejection not cached; after success each call re-checks kill(pid,0) and a dead pid re-runs the full path (a server stopped from another shell is restarted by the next request). One supervisor failure must surface as one clear error and never be swallowed by the free_models fallback loop.
- Hook: provider/connection.ts resolveConnection calls optional deps.ensureLocalServer() in the primary openai_api branch before detectEndpointFlavor (:184). Measured: no other path sends requests to the active profile URL.
- Commands (core tools, no LLM request): `llm-ext models server-status` (llama_server_status: every llama-server-*.json, port, model, pid, ours and alive, /health code, RSS, last log line) and `llm-ext models server-stop [--port N]` (llama_server_stop: identity check, SIGTERM, 10 s, SIGKILL, remove state; never by port; reports stale state). Touch points: cli/launcher.ts FIXED_GROUPS.models, tools/definitions.ts catalog and profile-type row, index.ts dispatch, RECONCILE_SKIP_TOOLS, CLI_TOOLS_WITHOUT_RESOLVED_PROFILE, index.test.ts expected list, README counts and names, docs/agent-usage-reference.md, docs/tool-use-cases.md, skills/llm-externalizer-cli-reference/SKILL.md.
- Stated consequences: a context_window or model change refuses until server-stop (increment 4 must own the calibrated restart); with no context_window LFM3 uses 262144 tokens, about 4.8 GB awake; servers started under another LLM_EXT_CONFIG_DIR are foreign; an auto-bench in another process can start the server.
- Tests (real, no mocks): pure tests for validation, argv tokenising (--port 818 is not 8181), state round-trip, identity against a live `sleep` process; integration with real llama-server and ggml-org/tiny-llamas:Q4_0 (19 MB) in a persistent /tmp LLAMA_CACHE (lasts until reboot), random free port, checks only /health and /v1/models (n_ctx_train 128, no chat template): cold start, reuse in one and two processes, forced concurrent start, foreign refusal, mismatch refusal, status, stop, restart after kill.

## Split out
- 2b: Hugging Face size API (tree API `size` or x-linked-size header) and the free-space check.
- 2c: API key via --api-key-file (not --api-key, visible in ps) plus authenticating every probe (/props, /v1/models, outage probe) and --no-webui; measured: a key makes /props, /v1/models and chat return 401, /health stays public.
- Separate docs commit: spec line "CLI and MCP" becomes "CLI" (no MCP server exists in this source).

## Pending user rulings
1. Idle: --sleep-idle-seconds 1800 (measured 2.5 GB to 169 MB, 0.53 s wake) or a full stop through a watcher process.
2. Integration test when llama-server is not on PATH: skip with printed reason, or not.
3. Integration test offline on first run: fail (recommended) or skip.
