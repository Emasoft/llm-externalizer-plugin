# Codex / GPT-5.5 scan prompt — DOCUMENTATION

The actual prompt text lives in `codex-scan-prompt.txt` (sibling file).
This `.md` file is human-readable documentation about WHY the prompt
is shaped the way it is.

The prompt is calibrated for **OpenAI GPT-5.5 invoked via the Codex CLI**.

**DO NOT REWORD** the prompt to match the OpenRouter ensemble style.
GPT-5.5 via Codex responds better to:
- Terse, structured instructions (no flowery prose)
- Explicit output schemas (one section per file, severity enum)
- Single-task focus per invocation (don't chain "review THIS and ALSO THAT")
- Severity tags drawn from a fixed enum (`critical | high | medium | low`)

The prompt also reflects that **Codex sessions are stateful**: each
invocation is one chat turn with one assistant response. We are NOT
using a multi-turn conversation. We give the full context (file
contents + instructions) in a single user-turn message.

## Per-file scan prompt — design notes

The `{FILES_BLOCK}` placeholder in `codex-scan-prompt.txt` is replaced
by the wrapper script with one `## File: <path>` section per file in
the batch, each containing the file's source code in a fenced block.

The response shape (`## File: <path>` per input file) is parseable
by the same `splitPerFileSections` helper that the MCP server's
ensemble path uses, so the existing fixer agents consume the output
without modification.

### Why the `[start-file]` / `[end-file]` markers?

The prompt uses `[start-file]` / `[end-file]` brackets (not nested
markdown fences) to delimit per-file section TEMPLATES in the prompt
text itself, so a markdown-rendering Codex client doesn't accidentally
interpret the inner fences as code blocks. The LLM still emits
`## File: <path>` literally in its response — only the prompt-text
delimiters differ.

## Prompt: fix-loop iteration (phase 2 — not yet shipped)

Per the user's "loop until all bugs fixed" requirement, the fix-loop
re-uses the per-file scan prompt for each iteration. The wrapper:
1. Runs the per-file scan prompt
2. Parses the output via `splitPerFileSections` (the existing helper)
3. For each file with findings, dispatches the parallel-fixer agent
4. Re-runs the scan on the same files
5. Stops when 0 findings OR MAX_ITERATIONS reached OR no progress
   (same files have the same findings two iterations in a row →
   stuck, terminate)

The fix-loop prompt is identical to the per-file scan prompt — the
Codex/GPT-5.5 LLM doesn't see "iteration N of M", it just re-scans
the current state. Conversation state lives in the wrapper.

## Notes on calibration drift

If a future GPT version (GPT-6, etc.) starts responding differently
to these prompts:
- Do NOT rewrite the prompts to "fix" the output. Rewrite the
  PARSER instead (in `run-codex-scan.py`).
- The point of pinning the prompts is they were validated against
  GPT-5.5 specifically; changing them couples the system to a
  specific output shape that may regress on future versions.
- New OpenAI versions get their own prompt file
  (`codex-scan-prompts-v6.md`, etc.) — never edit this one in place.
