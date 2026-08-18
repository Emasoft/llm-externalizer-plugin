/**
 * Per-SURFACE proof that the shared response gate (TRDD-P4ULUV1R,
 * ./response-gate.ts) is actually WIRED at the acceptance sites — not that the
 * gate itself computes the right verdict. The verdict logic is unit-tested in
 * ./response-gate.test.ts and is deliberately NOT re-tested here.
 *
 * Sites covered (index.ts):
 *   • processFileCheck            :2699  — the per-file path (code_task /
 *                                          batch_check / scan_folder consumers)
 *   • chat single-shot            :3349
 *   • chat batched group          :3470  — a gated group is DROPPED
 *   • check_imports (structured)  :5734/:5810 — no text gate; conformance comes
 *                                          from chatCompletionJSON's JSON parse
 *
 * THE ONLY STUB IS `globalThis.fetch` — the network boundary, the repo's own
 * idiom (provider/http.test.ts:16, default-profile-wiring.test.ts:155). Every
 * layer between dispatchCallTool and the wire (ensembleStreaming, the retry
 * loop, the gate, saveResponse) is the REAL code.
 *
 * Backend: a `mode: local` / `generic-local` profile pointed at an unreachable
 * URL — the local branch is single-model, so the model's exact bytes reach the
 * gate (the 3-model OpenRouter ensemble concatenates "## Model:" headers, which
 * would make a verbatim echo un-echo-like by construction).
 *
 * HONEST LIMIT — the `empty` verdict is UNREACHABLE at the three
 * ensembleStreaming-fed sites through this seam: chatCompletionWithRetry
 * exhausts its retry budget and REPLACES the empty body with a labelled one
 * (provider/completion.ts:1258-1262) before the gate is reached. The three
 * empty-response tests below therefore assert the invariant that holds either
 * way — an empty model reply is NEVER accepted as an empty report body — and
 * accept both branches explicitly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** getConfigDir() refuses a config dir outside $HOME or /tmp (config.ts:363).
 *  On Windows os.tmpdir() lives under the home dir, so both branches pass. */
const TMP_BASE = process.platform === "win32" ? tmpdir() : "/tmp";

const LOCAL_SETTINGS_YAML = [
  "active: local-a",
  "profiles:",
  "  local-a:",
  "    mode: local",
  "    api: generic-local",
  "    model: model-a",
  "    url: http://127.0.0.1:1",
  "    timeout: 5",
  "",
].join("\n");

let cfgDir: string;
let workDir: string;
let outDir: string;
const savedEnv: Record<string, string | undefined> = {};

function setEnv(key: string, value: string) {
  savedEnv[key] = process.env[key];
  process.env[key] = value;
}

beforeEach(() => {
  cfgDir = mkdtempSync(join(TMP_BASE, "llmext-gate-cfg-"));
  workDir = mkdtempSync(join(TMP_BASE, "llmext-gate-work-"));
  outDir = join(workDir, "out");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(cfgDir, "settings.yaml"), LOCAL_SETTINGS_YAML);
  setEnv("LLM_EXT_CONFIG_DIR", cfgDir);
  // Reports land in the temp dir, never in the developer's project reports/.
  // (code_task's single-file branch does not forward its own output_dir to
  // processFileCheck — index.ts:350 in code-task/core.ts — so the env var is
  // the only lever that covers every surface here.)
  setEnv("LLM_OUTPUT_DIR", outDir);
  // Booting a profile can fire a detached free-pool benchmark spawn; opt out.
  setEnv("LLM_EXT_DISABLE_FREE_POOL_AUTO_BENCH", "1");
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(cfgDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Builds the assistant reply from the user content the surface actually sent,
 *  so an "echo" is a byte-for-byte echo of THIS surface's own payload — no
 *  test-side guess about how the prompt is assembled. */
type Reply = (userContent: string) => string;

/** The ONE stub: the network. Returns a normal non-streaming OpenAI-compatible
 *  completion whose content is `reply(<user content of this request>)`. */
function stubCompletion(reply: Reply): string[] {
  const sentUserContent: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      // LM Studio native-API probe (provider/lmstudio.ts:62). 404 ⇒ this local
      // backend is a plain OpenAI-compatible server, the path under test.
      if (String(url).includes("/api/v1/models")) {
        return new Response("not found", { status: 404 });
      }
      let userContent = "";
      try {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          messages?: { role: string; content: string }[];
        };
        userContent = (body.messages ?? [])
          .filter((m) => m.role === "user")
          .map((m) => m.content)
          .join("\n\n");
      } catch {
        /* not a chat request — leave empty */
      }
      sentUserContent.push(userContent);
      return new Response(
        JSON.stringify({
          id: "test-completion",
          model: "model-a",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: reply(userContent) },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }),
  );
  return sentUserContent;
}

/** index.ts reads settings once at module load, so every test re-imports it
 *  against its own temp config dir. dispatchCallTool refuses to run before
 *  boot() (index.ts:2983). */
async function loadIndex() {
  vi.resetModules();
  const mod = await import("./index.js");
  await mod.boot();
  return mod;
}

function textOf(result: { content: { text: string }[] }): string {
  return result.content.map((c) => c.text).join("\n");
}

/** A small, real source file with a resolvable-looking import — long enough
 *  that an echo of the payload clears the gate's 40-char floor many times over. */
function fixtureFile(): string {
  const p = join(workDir, "sample.ts");
  writeFileSync(
    p,
    [
      "import { helper } from './helper.js';",
      "import { readFileSync } from 'node:fs';",
      "",
      "export function loadTotals(path: string): number {",
      "  const raw = readFileSync(path, 'utf-8');",
      "  return raw.split('\\n').reduce((sum, line) => sum + helper(line), 0);",
      "}",
      "",
    ].join("\n"),
  );
  return p;
}

/** The invariant an empty model reply must satisfy at every text surface,
 *  whichever layer catches it: either the surface FAILS with the gate's own
 *  message, or it saved a report whose body is NOT empty (today: the retry
 *  layer's "**EMPTY RESPONSE**" label, provider/completion.ts:1258). */
function expectNoEmptyBodyAccepted(result: {
  isError?: boolean;
  content: { text: string }[];
}) {
  const text = textOf(result);
  if (result.isError) {
    expect(text).toContain("LLM returned empty response");
    return;
  }
  const reportPath = text.trim();
  expect(reportPath).toMatch(/\.md$/);
  const body = readFileSync(reportPath, "utf-8");
  expect(body.trim().length).toBeGreaterThan(0);
  expect(body).toContain("EMPTY RESPONSE");
}

describe("response gate — chat single-shot (index.ts:3349)", () => {
  it("fails the call when the model echoes the prompt back verbatim instead of answering", async () => {
    const sent = stubCompletion((userContent) => userContent);
    const mod = await loadIndex();

    const result = await mod.dispatchCallTool("chat", {
      instructions:
        "Explain, in your own words, why eval() on user input is dangerous in JavaScript.",
      output_dir: outDir,
    });

    expect(sent.length).toBeGreaterThan(0); // the LLM call really happened
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("LLM echoed its input back instead of answering");
    expect(textOf(result)).not.toMatch(/\.md$/); // nothing was saved as an answer
  });

  it("never accepts an empty model reply as an empty report body", async () => {
    const sent = stubCompletion(() => "");
    const mod = await loadIndex();

    const result = await mod.dispatchCallTool("chat", {
      instructions:
        "Explain, in your own words, why eval() on user input is dangerous in JavaScript.",
      output_dir: outDir,
    });

    expect(sent.length).toBeGreaterThan(0);
    expectNoEmptyBodyAccepted(result);
  });
});

describe("response gate — per-file processFileCheck (index.ts:2699, via code_task)", () => {
  it("fails the file when the model echoes the per-file payload back verbatim", async () => {
    const sent = stubCompletion((userContent) => userContent);
    const mod = await loadIndex();

    const result = await mod.dispatchCallTool("code_task", {
      instructions: "List every bug you can find in this file.",
      input_files_paths: [fixtureFile()],
      output_dir: outDir,
    });

    expect(sent.length).toBeGreaterThan(0);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("LLM echoed its input back instead of answering");
    expect(textOf(result)).not.toMatch(/\.md$/);
  });

  it("never accepts an empty model reply as an empty per-file report", async () => {
    const sent = stubCompletion(() => "");
    const mod = await loadIndex();

    const result = await mod.dispatchCallTool("code_task", {
      instructions: "List every bug you can find in this file.",
      input_files_paths: [fixtureFile()],
      output_dir: outDir,
    });

    expect(sent.length).toBeGreaterThan(0);
    expectNoEmptyBodyAccepted(result);
  });
});

describe("response gate — chat batched group (index.ts:3470)", () => {
  it("drops the batched group when the model echoes the group payload back verbatim", async () => {
    const sent = stubCompletion((userContent) => userContent);
    const mod = await loadIndex();

    const result = await mod.dispatchCallTool("chat", {
      instructions: "Review these files and report anything suspicious.",
      input_files_paths: [fixtureFile()],
      answer_mode: 2, // one merged report → the batched loop, not the per-file one
      output_dir: outDir,
    });

    expect(sent.length).toBeGreaterThan(0);
    expect(result.isError).toBe(true);
    // The group was never pushed to batchResults, so no report was written and
    // the "no groups produced anything" exit is the only thing left.
    expect(textOf(result)).toContain("for all groups");
    expect(textOf(result)).not.toMatch(/\.md$/);
  });

  it("never accepts an empty model reply as an empty batched-group report", async () => {
    const sent = stubCompletion(() => "");
    const mod = await loadIndex();

    const result = await mod.dispatchCallTool("chat", {
      instructions: "Review these files and report anything suspicious.",
      input_files_paths: [fixtureFile()],
      answer_mode: 2,
      output_dir: outDir,
    });

    expect(sent.length).toBeGreaterThan(0);
    expectNoEmptyBodyAccepted(result);
  });
});

describe("check_imports — structured-output path (index.ts:5810, chatCompletionJSON)", () => {
  it("fails structure validation when the model echoes the (non-JSON) payload back verbatim", async () => {
    const sent = stubCompletion((userContent) => userContent);
    const mod = await loadIndex();

    const result = await mod.dispatchCallTool("check_imports", {
      input_files_paths: [fixtureFile()],
      output_dir: outDir,
    });

    expect(sent.length).toBeGreaterThan(0);
    expect(result.isError).toBe(true);
    // No text gate here — the JSON.parse of the mandated {"paths":[...]} schema
    // is what rejects the echo, which is the conformance this surface relies on.
    expect(textOf(result)).toContain("malformed JSON");
    expect(textOf(result)).not.toMatch(/\.md$/);
  });

  it("fails structure validation when the model returns an empty reply", async () => {
    const sent = stubCompletion(() => "");
    const mod = await loadIndex();

    const result = await mod.dispatchCallTool("check_imports", {
      input_files_paths: [fixtureFile()],
      output_dir: outDir,
    });

    expect(sent.length).toBeGreaterThan(0);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("empty response");
    expect(textOf(result)).not.toMatch(/\.md$/);
  });
});
