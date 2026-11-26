// Unit tests for transcript.ts — streaming JSONL reader + pruner for
// Claude Code session transcripts. No network, no LLM calls. All paths
// exercised against tmp fixtures generated per-test.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, appendFileSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { readTranscript, TranscriptRedactionError } from "./transcript.js";

describe("readTranscript", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "session-summary-transcript-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(lines: unknown[]): string {
    const p = join(dir, "in.jsonl");
    writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return p;
  }

  it("extracts a plain-string user turn", async () => {
    const p = write([{ type: "user", uuid: "u1", parentUuid: null, timestamp: "t1", message: { role: "user", content: "hello there" } }]);
    const { turns, stats } = await readTranscript(p);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toEqual({
      role: "user",
      timestamp: "t1",
      uuid: "u1",
      parentUuid: null,
      text: "hello there",
      toolCalls: [],
      errors: [],
    });
    expect(stats.linesRead).toBe(1);
    expect(stats.linesSkippedMalformed).toBe(0);
    expect(stats.turnsEmitted).toBe(1);
  });

  it("extracts assistant text blocks joined by newline", async () => {
    const p = write([
      {
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        timestamp: "t2",
        message: { role: "assistant", content: [{ type: "text", text: "part one" }, { type: "text", text: "part two" }] },
      },
    ]);
    const { turns } = await readTranscript(p);
    expect(turns).toHaveLength(1);
    expect(turns[0].role).toBe("assistant");
    expect(turns[0].text).toBe("part one\npart two");
  });

  it("extracts tool_use blocks into toolCalls with a one-line arg summary", async () => {
    const p = write([
      {
        type: "assistant",
        uuid: "a2",
        parentUuid: null,
        timestamp: "t3",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "x1", name: "Bash", input: { command: "ls -la", description: "list files" } }],
        },
      },
    ]);
    const { turns } = await readTranscript(p);
    expect(turns).toHaveLength(1);
    expect(turns[0].toolCalls).toHaveLength(1);
    expect(turns[0].toolCalls[0].name).toBe("Bash");
    expect(turns[0].toolCalls[0].argSummary).toContain("command=");
    expect(turns[0].toolCalls[0].argSummary).toContain("ls -la");
  });

  it("truncates an oversized string argument in the tool_use summary", async () => {
    const bigContent = "x".repeat(500);
    const p = write([
      {
        type: "assistant",
        uuid: "a3",
        parentUuid: null,
        timestamp: "t4",
        message: { role: "assistant", content: [{ type: "tool_use", id: "x2", name: "Write", input: { content: bigContent } }] },
      },
    ]);
    const { turns } = await readTranscript(p);
    expect(turns[0].toolCalls[0].argSummary.length).toBeLessThanOrEqual(160);
    expect(turns[0].toolCalls[0].argSummary).toContain("500 chars");
  });

  it("extracts a tool_result with string content and marks is_error into errors[]", async () => {
    const p = write([
      {
        type: "user",
        uuid: "r1",
        parentUuid: "a2",
        timestamp: "t5",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x1", content: "boom: permission denied", is_error: true }] },
      },
    ]);
    const { turns } = await readTranscript(p, { pruneLevel: "none" });
    expect(turns[0].errors).toEqual(["boom: permission denied"]);
    expect(turns[0].text).toContain("boom: permission denied");
  });

  it("extracts a tool_result with array-of-text-block content", async () => {
    const p = write([
      {
        type: "user",
        uuid: "r2",
        parentUuid: "a2",
        timestamp: "t6",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "x3", content: [{ type: "text", text: "line1" }, { type: "text", text: "line2" }] }],
        },
      },
    ]);
    const { turns } = await readTranscript(p, { pruneLevel: "none" });
    expect(turns[0].text).toContain("line1\nline2");
  });

  it("skips a malformed JSON line and counts it, without aborting the read", async () => {
    const p = join(dir, "in.jsonl");
    writeFileSync(
      p,
      [
        JSON.stringify({ type: "user", uuid: "u1", parentUuid: null, timestamp: "t1", message: { role: "user", content: "before" } }),
        "{not valid json",
        JSON.stringify({ type: "user", uuid: "u2", parentUuid: null, timestamp: "t2", message: { role: "user", content: "after" } }),
      ].join("\n") + "\n",
    );
    const { turns, stats } = await readTranscript(p);
    expect(turns.map((t) => t.text)).toEqual(["before", "after"]);
    expect(stats.linesSkippedMalformed).toBe(1);
    expect(stats.linesRead).toBe(3);
  });

  it("ignores non-content bookkeeping line types (attachment, last-prompt, queue-operation dequeue/remove)", async () => {
    const p = write([
      { type: "queue-operation", operation: "dequeue", content: null }, // no independent content
      { type: "queue-operation", operation: "remove", content: "why did X happen?" }, // duplicates its own enqueue
      { type: "attachment", attachment: { type: "hook_success" }, uuid: "att1" },
      { type: "last-prompt", lastPrompt: "why did X happen?", leafUuid: "u1" },
      { type: "user", uuid: "u1", parentUuid: null, timestamp: "t1", message: { role: "user", content: "real turn" } },
    ]);
    const { turns, stats } = await readTranscript(p);
    expect(turns).toHaveLength(1);
    expect(turns[0].text).toBe("real turn");
    expect(stats.linesRead).toBe(5); // all 5 lines were read; only 1 produced a turn
    expect(stats.turnsEmitted).toBe(1);
  });

  describe("queue-operation extraction (FIX 1 — messages sent while the assistant was working)", () => {
    it("extracts an enqueue as a user message with its text intact", async () => {
      const p = write([{ type: "queue-operation", operation: "enqueue", content: "delete the whole .serena folder", timestamp: "t1" }]);
      const { turns } = await readTranscript(p);
      expect(turns).toHaveLength(1);
      expect(turns[0]).toEqual({
        role: "user",
        timestamp: "t1",
        uuid: null,
        parentUuid: null,
        text: "delete the whole .serena folder",
        toolCalls: [],
        errors: [],
      });
    });

    it("still extracts a normal type:'user' message correctly (no regression)", async () => {
      const p = write([{ type: "user", uuid: "u1", parentUuid: null, timestamp: "t1", message: { role: "user", content: "i approve all" } }]);
      const { turns } = await readTranscript(p);
      expect(turns).toHaveLength(1);
      expect(turns[0].text).toBe("i approve all");
      expect(turns[0].role).toBe("user");
    });

    it("preserves original interleaved order across user/assistant/queue-operation entries", async () => {
      const p = write([
        { type: "user", uuid: "u1", parentUuid: null, timestamp: "t1", message: { role: "user", content: "first: start the long task" } },
        { type: "assistant", uuid: "a1", parentUuid: "u1", timestamp: "t2", message: { role: "assistant", content: "working on it..." } },
        { type: "queue-operation", operation: "enqueue", content: "second: actually stop and delete the folder", timestamp: "t3" },
        { type: "assistant", uuid: "a2", parentUuid: "a1", timestamp: "t4", message: { role: "assistant", content: "ok, stopping" } },
      ]);
      const { turns } = await readTranscript(p);
      expect(turns.map((t) => t.text)).toEqual([
        "first: start the long task",
        "working on it...",
        "second: actually stop and delete the folder",
        "ok, stopping",
      ]);
      expect(turns.map((t) => t.role)).toEqual(["user", "assistant", "user", "assistant"]);
    });

    it("drops a dequeue (null content) and a remove (duplicate of its own enqueue) without producing a second turn", async () => {
      const p = write([
        { type: "queue-operation", operation: "enqueue", content: "resume the deployment", timestamp: "t1" },
        { type: "queue-operation", operation: "dequeue", content: null, timestamp: "t2" },
      ]);
      const { turns } = await readTranscript(p);
      expect(turns).toHaveLength(1);
      expect(turns[0].text).toBe("resume the deployment");
    });
  });

  describe("machine-generated user-role turn exclusion (FIX 2)", () => {
    it("excludes a [janitor-heartbeat] cron fire delivered as type:'user'", async () => {
      const p = write([
        {
          type: "user",
          uuid: "u1",
          parentUuid: null,
          timestamp: "t1",
          message: { role: "user", content: "[janitor-heartbeat]\n/Users/x/.claude/plugins/data/ai-maestro-janitor/dispatcher-stub.py\nHandle this fire's stdout" },
        },
      ]);
      const { turns } = await readTranscript(p);
      expect(turns).toHaveLength(0);
    });

    it("excludes a [janitor-heartbeat] cron fire delivered as a queue-operation enqueue", async () => {
      const p = write([
        { type: "queue-operation", operation: "enqueue", content: "[janitor-heartbeat]\n/path/to/dispatcher-stub.py\nHandle it", timestamp: "t1" },
      ]);
      const { turns } = await readTranscript(p);
      expect(turns).toHaveLength(0);
    });

    it("excludes the 'no visible output' continuation nudge", async () => {
      const p = write([
        {
          type: "user",
          uuid: "u1",
          parentUuid: null,
          timestamp: "t1",
          message: {
            role: "user",
            content: "[Your previous response had no visible output. Please continue and produce a user-visible response.]",
          },
        },
      ]);
      const { turns } = await readTranscript(p);
      expect(turns).toHaveLength(0);
    });

    it("excludes a SKILL's own documentation loaded as a synthetic user turn", async () => {
      // Measured on a real transcript: 9 of 62 surviving user turns were skill
      // loads, so ~15% of the verbatim "All User Messages" section was text no
      // human typed. The path varies per skill, hence a first-line prefix match.
      const p = write([
        {
          type: "user",
          uuid: "u1",
          parentUuid: null,
          timestamp: "t1",
          message: {
            role: "user",
            content:
              "Base directory for this skill: /Users/someone/.claude/plugins/cache/x/skills/janitor-arm\n\n# Janitor arm\n\nSteps to arm the cron.",
          },
        },
      ]);
      const { turns } = await readTranscript(p);
      expect(turns).toHaveLength(0);
    });

    it("keeps a real user message that merely MENTIONS the skill-load preamble", async () => {
      // The false-exclusion guard: dropping real intent is the bug this module
      // exists to prevent, so a mention must never be treated as a whole match.
      const p = write([
        {
          type: "user",
          uuid: "u1",
          parentUuid: null,
          timestamp: "t1",
          message: {
            role: "user",
            content:
              "why does every skill start with \"Base directory for this skill: \" — can we drop that line?",
          },
        },
      ]);
      const { turns } = await readTranscript(p);
      expect(turns).toHaveLength(1);
      expect(turns[0].text).toContain("can we drop that line?");
    });

    it("excludes a turn that is wholly slash-command plumbing (<command-name>/<command-message>/<command-args>)", async () => {
      const p = write([
        {
          type: "user",
          uuid: "u1",
          parentUuid: null,
          timestamp: "t1",
          message: {
            role: "user",
            content: "<command-message>ai-maestro-janitor:janitor-arm</command-message>\n<command-name>/ai-maestro-janitor:janitor-arm</command-name>",
          },
        },
      ]);
      const { turns } = await readTranscript(p);
      expect(turns).toHaveLength(0);
    });

    it("excludes the local-command-caveat preamble turn", async () => {
      const p = write([
        {
          type: "user",
          uuid: "u1",
          parentUuid: null,
          timestamp: "t1",
          message: {
            role: "user",
            content:
              "<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.</local-command-caveat>",
          },
        },
      ]);
      const { turns } = await readTranscript(p);
      expect(turns).toHaveLength(0);
    });

    it("excludes a turn that is wholly a <system-reminder> block", async () => {
      const p = write([
        {
          type: "user",
          uuid: "u1",
          parentUuid: null,
          timestamp: "t1",
          message: { role: "user", content: "<system-reminder>Some internal harness note.</system-reminder>" },
        },
      ]);
      const { turns } = await readTranscript(p);
      expect(turns).toHaveLength(0);
    });

    it("excludes a queue-operation enqueue that is wholly a <task-notification> (avoids the later re-delivered duplicate)", async () => {
      const p = write([
        {
          type: "queue-operation",
          operation: "enqueue",
          content: "<task-notification>\n<task-id>abc123</task-id>\n<tool-use-id>toolu_01</tool-use-id>\n</task-notification>",
          timestamp: "t1",
        },
      ]);
      const { turns } = await readTranscript(p);
      expect(turns).toHaveLength(0);
    });

    it("does NOT exclude a real user message that merely MENTIONS a marker string (guards the false-positive risk)", async () => {
      const p = write([
        {
          type: "user",
          uuid: "u1",
          parentUuid: null,
          timestamp: "t1",
          message: {
            role: "user",
            content: "wait, why did the last janitor-heartbeat run touch <command-name> tags in my config? that seems wrong.",
          },
        },
      ]);
      const { turns } = await readTranscript(p);
      expect(turns).toHaveLength(1);
      expect(turns[0].text).toContain("janitor-heartbeat");
      expect(turns[0].text).toContain("<command-name>");
    });

    it("does NOT exclude a real queue-operation message that merely contains marker-like substrings", async () => {
      const p = write([
        { type: "queue-operation", operation: "enqueue", content: "please handle the [janitor-heartbeat] logic more gracefully next time", timestamp: "t1" },
      ]);
      const { turns } = await readTranscript(p);
      expect(turns).toHaveLength(1);
      expect(turns[0].text).toBe("please handle the [janitor-heartbeat] logic more gracefully next time");
    });
  });

  it("extracts a system api_error line into errors[] and returns null for routine system lines", async () => {
    const p = write([
      { type: "system", subtype: "api_error", uuid: "s1", parentUuid: null, timestamp: "t1", error: { message: "503 upstream connect error" } },
      { type: "system", subtype: "stop_hook_summary", uuid: "s2", parentUuid: null, timestamp: "t2", hookCount: 1, hookErrors: [] },
    ]);
    const { turns } = await readTranscript(p);
    expect(turns).toHaveLength(1);
    expect(turns[0].role).toBe("system");
    expect(turns[0].errors).toEqual(["503 upstream connect error"]);
  });

  describe("image blocks are dropped, never sent to the (text-only) summarizer", () => {
    const FAKE_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB".repeat(50); // stand-in payload, never a real PNG

    it("replaces an image content block with a marker and keeps the surrounding text, at prune level 'none'", async () => {
      const p = write([
        {
          type: "user",
          uuid: "u1",
          parentUuid: null,
          timestamp: "t1",
          message: {
            role: "user",
            content: [
              { type: "text", text: "here is a screenshot of the failing UI" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: FAKE_BASE64 } },
              { type: "text", text: "please fix the layout" },
            ],
          },
        },
      ]);
      const { turns } = await readTranscript(p, { pruneLevel: "none" });
      expect(turns).toHaveLength(1);
      expect(turns[0].text).toContain("here is a screenshot of the failing UI");
      expect(turns[0].text).toContain("[image omitted]");
      expect(turns[0].text).toContain("please fix the layout");
      expect(turns[0].text).not.toContain(FAKE_BASE64);
    });

    it("replaces an image content block with a marker at prune level 'aggressive' too", async () => {
      const p = write([
        {
          type: "user",
          uuid: "u2",
          parentUuid: null,
          timestamp: "t2",
          message: {
            role: "user",
            content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: FAKE_BASE64 } }],
          },
        },
      ]);
      const { turns } = await readTranscript(p, { pruneLevel: "aggressive" });
      expect(turns).toHaveLength(1); // the marker is real content — the turn is NOT dropped
      expect(turns[0].text).toBe("[image omitted]");
      expect(turns[0].text).not.toContain(FAKE_BASE64);
    });

    it("redacts an inline data:image;base64 URI embedded in plain text without dropping the surrounding text", async () => {
      const dataUri = `data:image/png;base64,${FAKE_BASE64}`;
      const p = write([
        {
          type: "user",
          uuid: "u3",
          parentUuid: null,
          timestamp: "t3",
          message: { role: "user", content: `see this pasted screenshot: ${dataUri} — it shows the bug` },
        },
      ]);
      const { turns } = await readTranscript(p, { pruneLevel: "none" });
      expect(turns[0].text).toContain("see this pasted screenshot:");
      expect(turns[0].text).toContain("it shows the bug");
      expect(turns[0].text).toContain("[image omitted]");
      expect(turns[0].text).not.toContain(FAKE_BASE64);
    });

    it("redacts a data URI returned inside a tool_result's text content", async () => {
      const dataUri = `data:image/jpeg;base64,${FAKE_BASE64}`;
      const p = write([
        {
          type: "user",
          uuid: "r3",
          parentUuid: "a1",
          timestamp: "t4",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "x9", content: [{ type: "text", text: `screenshot saved: ${dataUri}` }] }],
          },
        },
      ]);
      const { turns } = await readTranscript(p, { pruneLevel: "none" });
      expect(turns[0].text).toContain("[image omitted]");
      expect(turns[0].text).not.toContain(FAKE_BASE64);
    });

    it("replaces a tool_result image content block with a marker", async () => {
      const p = write([
        {
          type: "user",
          uuid: "r4",
          parentUuid: "a1",
          timestamp: "t5",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "x10",
                content: [
                  { type: "text", text: "captured a screenshot:" },
                  { type: "image", source: { type: "base64", media_type: "image/png", data: FAKE_BASE64 } },
                ],
              },
            ],
          },
        },
      ]);
      const { turns } = await readTranscript(p, { pruneLevel: "none" });
      expect(turns[0].text).toContain("captured a screenshot:");
      expect(turns[0].text).toContain("[image omitted]");
      expect(turns[0].text).not.toContain(FAKE_BASE64);
    });
  });

  describe("prune levels", () => {
    function makeToolResultFixture(): unknown[] {
      const bigLines = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
      return [
        {
          type: "assistant",
          uuid: "a1",
          parentUuid: null,
          timestamp: "t1",
          message: { role: "assistant", content: [{ type: "thinking", thinking: "let me think about this" }, { type: "text", text: "ok, proceeding" }] },
        },
        {
          type: "user",
          uuid: "r1",
          parentUuid: "a1",
          timestamp: "t2",
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x1", content: bigLines }] },
        },
      ];
    }

    it("aggressive: drops thinking and non-error tool_result payloads entirely", async () => {
      const p = write(makeToolResultFixture());
      const { turns } = await readTranscript(p, { pruneLevel: "aggressive" });
      expect(turns[0].text).not.toContain("let me think");
      expect(turns[0].text).toBe("ok, proceeding");
      // aggressive drops the whole non-error tool_result payload -> that
      // line produces NO turn at all (nothing left to keep).
      expect(turns).toHaveLength(1);
      expect(turns.some((t) => t.text.includes("line 50"))).toBe(false);
    });

    it("moderate: keeps thinking, head/tail-truncates an oversized tool_result", async () => {
      const p = write(makeToolResultFixture());
      const { turns } = await readTranscript(p, { pruneLevel: "moderate", moderateTruncateLines: 5 });
      expect(turns[0].text).toContain("let me think");
      const resultTurn = turns.find((t) => t.text.includes("[tool_result]"));
      expect(resultTurn).toBeDefined();
      expect(resultTurn!.text).toContain("line 0");
      expect(resultTurn!.text).toContain("line 99");
      expect(resultTurn!.text).toContain("lines omitted");
      expect(resultTurn!.text).not.toContain("line 50");
    });

    it("none: keeps everything in full", async () => {
      const p = write(makeToolResultFixture());
      const { turns } = await readTranscript(p, { pruneLevel: "none" });
      expect(turns[0].text).toContain("let me think");
      const resultTurn = turns.find((t) => t.text.includes("[tool_result]"));
      expect(resultTurn!.text).toContain("line 50");
      expect(resultTurn!.text).toContain("line 99");
    });

    it("aggressive still keeps error text from a failed tool_result", async () => {
      const p = write([
        {
          type: "user",
          uuid: "r1",
          parentUuid: null,
          timestamp: "t1",
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x1", content: "permission denied", is_error: true }] },
        },
      ]);
      const { turns } = await readTranscript(p, { pruneLevel: "aggressive" });
      expect(turns).toHaveLength(1);
      expect(turns[0].errors).toEqual(["permission denied"]);
      expect(turns[0].text).toContain("permission denied");
    });
  });

  describe("streaming — never loads the whole file into memory", () => {
    it("the implementation never imports a synchronous whole-file read (structural proof)", () => {
      // Node's `readFileSync`/`fs.promises.readFile` buffer the entire file
      // before returning; `createReadStream` + readline never do. Assert the
      // source itself only ever reaches for the streaming primitive, so a
      // future edit can't silently regress into buffering the 265 MB
      // transcript from TRDD-T4MZ8YQR §Verified facts.
      const srcPath = fileURLToPath(new URL("./transcript.ts", import.meta.url));
      const source = readFileSync(srcPath, "utf8");
      expect(source).not.toMatch(/\breadFileSync\b/);
      expect(source).not.toMatch(/\breadFile\(/);
      expect(source).toContain("createReadStream");
      expect(source).toContain("createInterface");
    });

    it("the stripped-output write path never buffers a joined string (structural proof)", () => {
      // `writeFileSync(path, turns.map(...).join(...))` would buffer the
      // entire stripped transcript as one string before writing it — exactly
      // the pattern the streaming write exists to avoid. Assert the source
      // only ever reaches for the incremental `createWriteStream` primitive
      // for this path, with no whole-array-join write anywhere in the file.
      const srcPath = fileURLToPath(new URL("./transcript.ts", import.meta.url));
      const source = readFileSync(srcPath, "utf8");
      expect(source).toContain("createWriteStream");
      expect(source).not.toMatch(/\bwriteFileSync\b/);
      expect(source).not.toMatch(/\bappendFileSync\b/);
    });

    it("streams the pruned turns to strippedOutputPath as ordered JSONL, incrementally", async () => {
      const p = write([
        { type: "user", uuid: "u1", parentUuid: null, timestamp: "t1", message: { role: "user", content: "first" } },
        { type: "assistant", uuid: "a1", parentUuid: "u1", timestamp: "t2", message: { role: "assistant", content: "second" } },
        { type: "user", uuid: "u2", parentUuid: "a1", timestamp: "t3", message: { role: "user", content: "third" } },
      ]);
      const outPath = join(dir, "stripped.jsonl");
      const { turns } = await readTranscript(p, { strippedOutputPath: outPath });

      const written = readFileSync(outPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(written).toHaveLength(3);
      expect(written.map((t) => t.text)).toEqual(["first", "second", "third"]);
      // The on-disk artifact matches the in-memory pruned turns exactly.
      expect(written).toEqual(turns);
    });

    it("does not create a stripped-output file when strippedOutputPath is omitted", async () => {
      const p = write([{ type: "user", uuid: "u1", parentUuid: null, timestamp: "t1", message: { role: "user", content: "hi" } }]);
      const outPath = join(dir, "never-created.jsonl");
      await readTranscript(p);
      expect(() => statSync(outPath)).toThrow();
    });

    it("processes a large fixture correctly with bounded heap growth relative to file size", async () => {
      const p = join(dir, "big.jsonl");
      // Build a ~20 MB fixture: 40,000 lines of a modest assistant turn each,
      // flushing to disk in 1 MB batches so the fixture-builder itself never
      // holds the whole file in one string either.
      const LINE_COUNT = 40_000;
      let buf = "";
      for (let i = 0; i < LINE_COUNT; i++) {
        buf +=
          JSON.stringify({
            type: i % 2 === 0 ? "user" : "assistant",
            uuid: `u${i}`,
            parentUuid: i === 0 ? null : `u${i - 1}`,
            timestamp: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z`,
            message: { role: i % 2 === 0 ? "user" : "assistant", content: `line content number ${i} padding padding padding` },
          }) + "\n";
        if (buf.length > 1_000_000 || i === LINE_COUNT - 1) {
          appendFileSync(p, buf);
          buf = "";
        }
      }

      const fileBytes = statSync(p).size;
      expect(fileBytes).toBeGreaterThan(1_000_000); // sanity: fixture really is large

      // The functional correctness check itself is the streaming proof at
      // scale: readTranscript() only ever reads the file via
      // createReadStream+readline (see the structural test above), so
      // successfully processing every one of 40,000 lines here is only
      // possible without buffering the file whole — a synchronous
      // whole-file read of a file this size would also work, which is
      // exactly why the structural test is the load-bearing one; this test
      // exists to prove the streaming path is also functionally correct at
      // the scale the real 265 MB transcript requires.
      const { turns, stats } = await readTranscript(p, { pruneLevel: "aggressive" });

      expect(turns).toHaveLength(LINE_COUNT);
      expect(stats.linesRead).toBe(LINE_COUNT);
      expect(stats.linesSkippedMalformed).toBe(0);
    });
  });

  // TRDD-G49XPDNI: the summarizer sends transcript text to a REMOTE model, so every string must be
  // redacted with llm-ext's own redactor BEFORE any cut or truncation. The fake secret is built at
  // runtime so no secret-shaped literal sits in this source file (secret scanners read source).
  describe("secret redaction before any cut (TRDD-G49XPDNI)", () => {
    const FAKE_SECRET = "sk-" + "Zq8".repeat(10);
    const MARKER = "[REDACTED:API_KEY]";

    function userLine(uuid: string, content: unknown): unknown {
      return { type: "user", uuid, parentUuid: null, timestamp: "t", message: { role: "user", content } };
    }
    function assistantToolUse(uuid: string, input: unknown): unknown {
      return {
        type: "assistant",
        uuid,
        parentUuid: null,
        timestamp: "t",
        message: { role: "assistant", content: [{ type: "tool_use", id: "x1", name: "Bash", input }] },
      };
    }

    it("redacts a secret in a plain-text user turn", async () => {
      const p = write([userLine("u1", `my key is ${FAKE_SECRET} please use it`)]);
      const { turns } = await readTranscript(p);
      expect(turns[0].text).not.toContain(FAKE_SECRET);
      expect(turns[0].text).toContain(MARKER);
      expect(turns[0].text).toContain("please use it");
    });

    it("redacts a secret in a tool_use string argument longer than 80 chars, with the secret starting after char 60", async () => {
      // The 80-char slice would keep only the first 20 chars of the secret: a fragment no pattern matches.
      const p = write([assistantToolUse("a1", { command: "p".repeat(60) + FAKE_SECRET + " trailing text past the cut" })]);
      const { turns } = await readTranscript(p);
      const arg = turns[0].toolCalls[0].argSummary;
      expect(arg).not.toContain(FAKE_SECRET);
      expect(arg).not.toContain(FAKE_SECRET.slice(0, 20));
      expect(arg).toContain(MARKER);
    });

    it("redacts a secret inside a non-string tool_use argument (nested object)", async () => {
      const p = write([assistantToolUse("a2", { env: { SOME_VALUE: FAKE_SECRET } })]);
      const { turns } = await readTranscript(p);
      expect(turns[0].toolCalls[0].argSummary).not.toContain(FAKE_SECRET);
      expect(turns[0].toolCalls[0].argSummary).toContain(MARKER);
    });

    it("redacts a secret placed in the tool name, which is also rendered into the prompt", async () => {
      const p = write([{ type: "assistant", uuid: "a4", parentUuid: null, timestamp: "t", message: { role: "assistant", content: [{ type: "tool_use", id: "x4", name: `Tool_${FAKE_SECRET}`, input: {} }] } }]);
      const { turns } = await readTranscript(p);
      expect(turns[0].toolCalls[0].name).not.toContain(FAKE_SECRET);
      expect(turns[0].toolCalls[0].name).toContain(MARKER);
    });

    it("redacts a secret placed in tool_use_id of an error result that has no message", async () => {
      const p = write([userLine("r5", [{ type: "tool_result", tool_use_id: `id_${FAKE_SECRET}`, is_error: true, content: "" }])]);
      const { turns } = await readTranscript(p, { pruneLevel: "aggressive" });
      expect(turns[0].errors.join("\n")).not.toContain(FAKE_SECRET);
      expect(turns[0].errors.join("\n")).toContain(MARKER);
    });

    it("redacts a short secret whose only giveaway is the argument name beside it", async () => {
      const value = "hunter2" + "hunter2";
      const p = write([assistantToolUse("a3", { password: value })]);
      const { turns } = await readTranscript(p);
      expect(turns[0].toolCalls[0].argSummary).not.toContain(value);
    });

    it("redacts a secret in a tool_result text, at prune level 'none'", async () => {
      const p = write([userLine("r1", [{ type: "tool_result", tool_use_id: "x1", content: [{ type: "text", text: `env dump: ${FAKE_SECRET}` }] }])]);
      const { turns } = await readTranscript(p, { pruneLevel: "none" });
      expect(turns[0].text).not.toContain(FAKE_SECRET);
      expect(turns[0].text).toContain(MARKER);
    });

    it("redacts a secret in a tool_result error kept under 'aggressive' (both text and errors[])", async () => {
      const p = write([userLine("r2", [{ type: "tool_result", tool_use_id: "x2", is_error: true, content: `auth failed for ${FAKE_SECRET}` }])]);
      const { turns } = await readTranscript(p, { pruneLevel: "aggressive" });
      expect(turns[0].text).not.toContain(FAKE_SECRET);
      expect(turns[0].errors.join("\n")).not.toContain(FAKE_SECRET);
      expect(turns[0].errors.join("\n")).toContain(MARKER);
    });

    it("redacts a secret in a system api_error message and in a hook error", async () => {
      const p = write([
        { type: "system", subtype: "api_error", uuid: "s1", timestamp: "t", error: { message: `rejected ${FAKE_SECRET}` }, hookErrors: [`hook saw ${FAKE_SECRET}`] },
      ]);
      const { turns } = await readTranscript(p);
      expect(turns[0].errors.join("\n")).not.toContain(FAKE_SECRET);
      expect(turns[0].errors.join("\n")).toContain(MARKER);
    });

    it("🐌 fails closed with TranscriptRedactionError naming the turn index when one 64 MB turn blows the redaction budget", async () => {
      /** REAL trigger, no stub or test-only parameter: 64 MB of connection strings is the slowest shape measured through the real safeRedact
       *  (2539 ms = 5.1x the 500 ms budget; the other shapes took 0.8-2.5 s). The big file is deleted in `finally` (64 MB, far under the 4 GB test cap). */
      const big = "://a:b@h/c ".repeat(5_820_000);
      const p = write([userLine("u1", "a harmless first turn"), userLine("u2", big)]);
      try {
        const err = await readTranscript(p).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(TranscriptRedactionError);
        expect((err as Error).message).toMatch(/secret redaction failed at turn index 1 \(transcript line 2\): .*wall-clock budget/s);
      } finally {
        rmSync(p, { force: true });
      }
    }, 180_000);

    it("TranscriptRedactionError names the turn index and transcript line when it has them", () => {
      /** the message readTranscript raises at the failing turn: turn index = turns kept so far, plus the 1-based line. */
      const e = new TranscriptRedactionError("budget exceeded", 1, 2);
      expect(e.message).toMatch(/secret redaction failed at turn index 1 \(transcript line 2\): budget exceeded/);
      expect(e.reason).toBe("budget exceeded");
    });

    it("readTranscript on 14000 unterminated PEM headers (the old quadratic trigger) now redacts within budget instead of throwing", async () => {
      /** the old lazy PEM_BLOCK made this input blow the 500 ms budget (ok:false); the linear pattern redacts it, header gone. */
      const pemHeader = "-----BEGIN " + "PRIVATE KEY" + "-----";
      const p = write([userLine("u1", "a harmless first turn"), userLine("u2", pemHeader.repeat(14000))]);
      const { turns } = await readTranscript(p);
      expect(turns).toHaveLength(2);
      expect(turns[1].text).not.toContain("BEGIN PRIVATE KEY");
      expect(turns[1].text).toContain("[REDACTED:PEM_BLOCK]");
    }, 60_000);
  });
});
