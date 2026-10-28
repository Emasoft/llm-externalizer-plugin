# local_llama design (TRDD-1OOAH3LD)

Status: approved by the user 2026-10-28 through four design questions, after two adversarial review rounds.
Facts: reports/llama-cpp-profile/ (facts, thinking-effort, design-facts-2) and the MEASURE results recorded on the card.

## Rationale

llm-ext runs any llama.cpp model through a local_llama profile that downloads, caches, starts and calibrates the model on its own, and sizes every request (input, thinking, output) from that model's measured calibration.

## User decisions (2026-10-28, verbatim answers)

- Engine: "llama-server (Recommended)". Server lifetime: "Keep it running (Recommended)", later refined below. llama.cpp: "Brew HEAD build (Recommended)" (installed: 0.8.0-dev build 11960, commit 8642541b2).
- Thinking: on or off per command (off for simple tasks such as text editing, on for bug search); prompt + thinking + answer stay under 30-40% of the window.
- New local models are calibrated automatically (context %, max input tokens, max output tokens, thinking on/off, structured output).
- During calibration: "No, wait" (commands on that model refuse with a calibrating, N minutes left message).
- Sharing the server: "Calibrate when idle (Recommended)" (calibration pauses when a user request arrives on the same server).
- After a llama.cpp (or any inference engine) upgrade: "Quick check only (Recommended)", clarified by the user: only a quick smoke check that the model still loads and answers without errors on the new engine; never a recalibration. The full calibration benchmark runs only when a model is added or updated in a profile, for every profile.
- Idle server: "Smaller context + idle stop" (context capped at calibrated usable share times parallel slots; the server stops after 30 minutes without requests).

## Increments (each gets its own proposal, review and commit)

1. Request options and safe replies.
   - New optional profile key request_options: a default block plus one block per tool. Fields: thinking (on/off), max_output_tokens, input_fill_pct, structured_output, temperature, top_k, repeat_penalty. Registered in PROFILE_TYPE_FIELDS.local and validated.
   - Applies only to a profile that sets the key; existing llama.cpp users see no change. LFM3 sampling values (0.1 / 50 / 1.1) are profile data, not code.
   - Thinking off sends chat_template_kwargs.enable_thinking false; thinking on sends no budget cap, the room is what remains under max_output_tokens.
   - max_tokens is always explicit. Each task kind has a fixed output cap sized to its job plus a stop instruction in the prompt. A reply cut off by the length limit is an error on this path, empty or partial.
   - Precedence: values the user writes in the profile win over calibrated values, which win over built-in defaults.
2. Server supervisor.
   - Lazy start on the first model call (CLI and MCP). Launch: llama-server -hf <model> --alias <model> --host 127.0.0.1 --port <port> -c <calibrated share x parallel slots> --jinja, detached (bench-spawn pattern), log in the config dir.
   - Identity: pid file plus a command-line check of that pid; a model change restarts our server; an unknown process on the port is a hard failure, never touched.
   - Start lock covers only the launch; every process then waits on /health with a download-aware limit.
   - Cache folder resolved through the same variables llama.cpp uses (LLAMA_CACHE, HF_HUB_CACHE, HUGGINGFACE_HUB_CACHE, HF_HOME/hub, XDG_CACHE_HOME/huggingface/hub, ~/.cache/huggingface/hub); the file size is read from the Hugging Face API and the download refused when that volume lacks space.
   - A model load failure such as unknown model architecture prints the exact upgrade command.
   - Idle stop after 30 minutes without requests. Commands: llm-ext models server-status (memory, calibration progress) and server-stop.
3. Input sizing: the input budget is context window x input share minus output cap minus prompt overhead, tokens counted through /tokenize. Precedence: explicit per-call max_payload_kb, then profile/calibrated share, then the 400 KB default.
4. Automatic calibration.
   - Triggered only when a profile gains a new or updated model (settings.yaml), once per model, for every profile; runs as a detached background job with a per-model lock (no fixed time limit, pid liveness), a progress record so it resumes after a crash or sleep, and pauses while a user request is in flight.
   - First step reads /props (chat_template_caps) and skips dimensions the model lacks (thinking, structured output), recording them as unsupported.
   - Safe fill: fixed grid 10/20/30/35/40 percent, at least 5 repeats per step, planted item at several positions; highest step passing at least 80 percent, hard-capped at 40 percent.
   - Tasks scored without another model: a planted fact (exact string in the answer) and a planted bug in real code (answer must name the exact line or the changed identifier).
   - Thinking on/off chosen per task kind by score; output caps checked by the rate of clean finishes; structured output tested with response_format json_schema.
   - Record: one file per model under the config dir, keyed by model file, written atomically; a corrupt record counts as missing and is logged. Estimated 2 to 4 hours per model at about 700 prompt tokens per second.
   - The same calibration step serves TRDD-UT7UC025 (self-healing).
5. The local_llama profile: added once with the user's comment header word for word (settings writes keep YAML comments); deleting it is respected. Model AtomicChat/LFM3-1.7B-Uncensored-GGUF:AD-Q6_K, port 8181. Docs and CHANGELOG.
6. Tests: automated tests use a tiny real GGUF (a few MB) so the publish gate never downloads 1.6 GB; LFM3 is used for its calibration run and a manual acceptance check.

## Measured facts the design rests on

- llama-server b11960 loads LFM3; -c 262144 uses about 4.8 GB RSS at load (unified KV pool over 4 slots); two concurrent 79,580-token prompts answered correctly with thinking off in 114 s and 264 s.
- Thinking is enable_thinking on/off only (no effort levels); per-request reasoning_budget_tokens works; the model often runs to any max_tokens limit.
- The model cache here is the Hugging Face hub layout under HF_HOME on the external SSD.
- llm-ext today ignores reasoning_content, sets max_tokens to the whole window for non-OpenRouter backends, and sizes file input by a 400 KB byte budget.
