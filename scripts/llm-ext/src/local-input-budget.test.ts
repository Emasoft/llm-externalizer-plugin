/**
 * local-input-budget.test.ts: P7 (TRDD-1OOAH3LD, TRDD-ZGSGGHQG), input sizing from the calibration record
 * (design/specs/local-calibration-design.md section 6). Pure checks of the formula and the task-kind table over REAL
 * records written with writeRecord into a temp config dir, then commands through the real entry against a REAL
 * node:http OpenAI-compatible loopback server that logs every request body. The profiles never reach a server process:
 * the unmanaged llamacpp-local one sends to the loopback server, and the managed one fails at sizing, before the broker.
 * No mocks; the only spy captures stderr text.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resetServiceHealthForTests } from "./provider/completion.js";
import { writeRecord, type CalibrationRecord } from "./calibration/record.js";
import { recordFixture } from "./calibration/test-record.js";
import { CAP_OFF, CAP_ON } from "./calibration/phase-a.js";
import { progressPath, queuePath } from "./calibration/state.js";
import { BREVITY_RULES, FILE_FORMAT_EXAMPLE } from "./scan-pipeline.js";
import { PROVISIONAL_LOCAL_CTX, type Profile, type ResolvedRoute } from "./config.js";
import {
  CALIBRATION_POLL_MS,
  CHARS_PER_TOKEN_SAFETY,
  localEngineOf,
  localInputBudget,
  localOutputCap,
  localThinkingFor,
  localThinkingSwitch,
  planLocalSizing,
  TASK_KIND_BY_TOOL,
  taskEntryOf,
  waitForCalibration,
  type LocalMember,
} from "./local-input-budget.js";
import { CommandStoppedError } from "./command-stop.js";
import { localsOutgoingModel } from "./local-locals-server.js";

const servers: Server[] = [];
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    s.close();
  }
  for (const c of cleanups.splice(0)) c();
  vi.restoreAllMocks();
  resetServiceHealthForTests();
});

function tempDir(prefix: string): string {
  const d = mkdtempSync(join("/tmp", prefix));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

/** An ok llama record for `model`, with the sizing fields of `over` (recordFixture's own window_tokens 4096 is small for these cases). */
function rec(model: string, over: Partial<CalibrationRecord> = {}): CalibrationRecord {
  return {
    ...recordFixture("llama", model),
    window_tokens: 16384,
    fill_tokens: { fact: 8192, aggregate: 4096, bug: 6144 },
    min_output_tokens: { fact: 256, aggregate: 256, bug: 256 },
    chars_per_token: 3.5,
    thinking_works: { off: true, on: true },
    ...over,
  };
}

/** Bytes of `tokens` at `cpt` characters per token, after the safety factor: the code's own expression. */
const bytesOf = (tokens: number, cpt: number) => Math.floor(tokens * (cpt * CHARS_PER_TOKEN_SAFETY));

const llama = (model: string, managed = false, ctx = 0): LocalMember => ({ model, engine: "llama", managed, ctx });

describe("TASK_KIND_BY_TOOL and localEngineOf (P7 decision 1)", () => {
  it("classifies every command the design names, by kind", () => {
    const kinds = (k: string) => Object.entries(TASK_KIND_BY_TOOL).filter(([, v]) => v.kind === k).map(([t]) => t).sort();
    expect(kinds("fact")).toEqual(["batch_check", "chat", "describe", "scan_folder"]);
    expect(kinds("aggregate")).toEqual(["cluster_synonyms", "sem_deduplicate", "session_summary", "summarize", "topics"]);
    expect(kinds("bug")).toEqual(["check_against_specs", "check_imports", "check_references", "code_task", "compare_files", "high_quality_scan", "review_plan", "rules_check", "search_existing_implementations", "security_scan"]);
  });
  it("a request of compare_files carries 4 per-file shares, check_against_specs 2, the rest 1; own keys only", () => {
    expect(taskEntryOf("compare_files")?.filesPerRequest).toBe(4);
    expect(taskEntryOf("check_against_specs")?.filesPerRequest).toBe(2);
    expect(taskEntryOf("chat")?.filesPerRequest).toBeUndefined();
    expect(taskEntryOf("constructor")).toBeUndefined();
  });
  it("maps only llamacpp-local and locals-local to an engine", () => {
    expect(localEngineOf("llamacpp-local")).toBe("llama");
    expect(localEngineOf("locals-local")).toBe("locals");
    for (const api of ["generic-local", "lmstudio-local", "ollama-local", "openrouter-remote"]) expect(localEngineOf(api)).toBeNull();
  });
  it("the chars_per_token safety factor is the measured worst ratio (round 3, M3)", () => {
    expect(CHARS_PER_TOKEN_SAFETY).toBe(0.88);
  });
});

describe("localOutputCap and localInputBudget (spec 6)", () => {
  it("output cap: the nominal cap of the thinking mode, or min_output_tokens when larger; the user max_output_tokens wins", () => {
    expect(localOutputCap(rec("m"), "fact")).toBe(CAP_OFF);
    expect(localOutputCap(rec("m"), "bug")).toBe(CAP_ON);
    expect(localOutputCap(rec("m", { thinking_works: { off: true, on: false } }), "bug")).toBe(CAP_OFF);
    expect(localOutputCap(rec("m", { min_output_tokens: { fact: 3072, aggregate: 256, bug: 256 } }), "fact")).toBe(3072);
    expect(localOutputCap(rec("m", { min_output_tokens: { fact: 3072, aggregate: 256, bug: 256 } }), "fact", 1000)).toBe(1000);
  });
  it("budget = min(fill, window - cap - 512), window = min(the route's context, the record's window_tokens)", () => {
    expect(localInputBudget(rec("m"), "fact", 2048, 0)).toBe(8192);
    expect(localInputBudget(rec("m", { window_tokens: 9000 }), "fact", 2048, 0)).toBe(9000 - 2048 - 512);
    expect(localInputBudget(rec("m"), "fact", 2048, 6000)).toBe(6000 - 2048 - 512);
    // A context above the calibration window never raises it.
    expect(localInputBudget(rec("m"), "fact", 2048, 100000)).toBe(8192);
  });
  it("a budget below 1024 tokens fails naming the context, the output cap and the smallest context that works", () => {
    expect(() => localInputBudget(rec("m"), "fact", 2048, 3583)).toThrow(/below 1024.*context 3583.*output cap 2048, prompt.*smallest context that works is 3584 tokens/);
    expect(localInputBudget(rec("m"), "fact", 2048, 3584)).toBe(1024);
  });
  it("when the user's max_output_tokens causes the failure, the message names it (review m5)", () => {
    expect(() => localInputBudget(rec("m"), "fact", 7000, 8192, true)).toThrow(/output cap 7000 \(request_options max_output_tokens\)/);
  });
  it("an unfit kind (fill 0) fails naming the model, the kind and the record's reason", () => {
    const r = rec("m-unfit", { fill_tokens: { fact: 8192, aggregate: 4096, bug: 0 }, unfit_reasons: { bug: "window 4096 too small for thinking on output" } });
    expect(() => localInputBudget(r, "bug", 8192, 0)).toThrow(/m-unfit' is unfit for bug tasks \(calibration: window 4096 too small/);
  });
});

describe("planLocalSizing (P7 decisions 2-4, round 3)", () => {
  it("an ok record sizes the command: tokens x chars_per_token x the safety factor, and the window bound alone", () => {
    const dir = tempDir("llm-ext-p7-plan-");
    writeRecord(dir, rec("m-one"));
    expect(planLocalSizing({ dir, tool: "chat", members: [llama("m-one")] })).toEqual({
      state: "calibrated", kind: "fact", inputTokens: 8192, budgetBytes: bytesOf(8192, 3.5), windowBudgetBytes: bytesOf(16384 - CAP_OFF - 512, 3.5), maxTokens: CAP_OFF, models: ["m-one"], notes: [],
    });
    const bug = planLocalSizing({ dir, tool: "check_imports", members: [llama("m-one")] });
    expect(bug).toMatchObject({ kind: "bug", inputTokens: 6144, maxTokens: CAP_ON });
  });
  it("every member is sized together: the largest output cap, the smallest budget, the smallest chars_per_token", () => {
    const dir = tempDir("llm-ext-p7-plan-");
    writeRecord(dir, rec("m-one"));
    writeRecord(dir, rec("m-two", { fill_tokens: { fact: 4096, aggregate: 4096, bug: 4096 }, chars_per_token: 3, min_output_tokens: { fact: 2560, aggregate: 256, bug: 256 } }));
    const s = planLocalSizing({ dir, tool: "chat", members: [llama("m-one"), llama("m-two"), llama("m-held")] });
    // m-held is unmanaged with no record: left out silently (it keeps the profile defaults).
    expect(s).toEqual({ state: "calibrated", kind: "fact", inputTokens: 4096, budgetBytes: bytesOf(4096, 3), windowBudgetBytes: bytesOf(16384 - 2560 - 512, 3), maxTokens: 2560, models: ["m-one", "m-two"], notes: [] });
  });
  it("a managed member's context is its route's (the broker slot): the window is min(that, window_tokens) (round 3, M1)", () => {
    const dir = tempDir("llm-ext-p7-plan-");
    writeRecord(dir, rec("m-one"));
    expect(planLocalSizing({ dir, tool: "chat", members: [llama("m-one", true, 8192)] })).toMatchObject({ inputTokens: 8192 - CAP_OFF - 512, windowBudgetBytes: bytesOf(8192 - CAP_OFF - 512, 3.5) });
  });
  it("every managed member with no record is waited for, the head and the others alike (round 3, M2)", () => {
    const dir = tempDir("llm-ext-p7-plan-");
    expect(planLocalSizing({ dir, tool: "chat", members: [llama("m-x", true)] })).toEqual({ state: "await", models: [{ engine: "llama", model: "m-x" }], head: "m-x" });
    writeRecord(dir, rec("m-one"));
    expect(planLocalSizing({ dir, tool: "chat", members: [llama("m-one", true), llama("m-fb", true), llama("m-un")] })).toEqual({ state: "await", models: [{ engine: "llama", model: "m-fb" }], head: "m-one" });
  });
  it("a member whose record is failed is left out with one line naming it; a failed head keeps the default for the broker to fail", () => {
    const dir = tempDir("llm-ext-p7-plan-");
    writeRecord(dir, rec("m-one"));
    writeRecord(dir, recordFixture("llama", "m-failed", { step: "B", message: "boom" }));
    const s = planLocalSizing({ dir, tool: "chat", members: [llama("m-one", true), llama("m-failed", true)] });
    expect(s).toMatchObject({ state: "calibrated", models: ["m-one"], notes: [expect.stringMatching(/m-failed is left out of the input sizing: .*boom/)] });
    expect(planLocalSizing({ dir, tool: "chat", members: [llama("m-failed", true)] })).toEqual({ state: "default", note: null });
  });
  it("no ok record on an unmanaged head: the default stays and one line says so", () => {
    const dir = tempDir("llm-ext-p7-plan-");
    expect(planLocalSizing({ dir, tool: "chat", members: [llama("m-x")] })).toEqual({ state: "default", note: expect.stringMatching(/m-x \(llama\) has no ok calibration record: input keeps the 400 KB default/) });
  });
  it("nothing changes for another engine, an unclassified command, or a tool named like an Object member", () => {
    const dir = tempDir("llm-ext-p7-plan-");
    writeRecord(dir, rec("m-one"));
    expect(planLocalSizing({ dir, tool: "chat", members: [{ model: "m-one", engine: null, managed: false, ctx: 0 }] })).toBeNull();
    expect(planLocalSizing({ dir, tool: "mass_scout", members: [llama("m-one")] })).toBeNull();
    expect(planLocalSizing({ dir, tool: "constructor", members: [llama("m-one")] })).toBeNull();
  });
  it("the user's request_options max_output_tokens is the cap and is subtracted from the budget", () => {
    const dir = tempDir("llm-ext-p7-plan-");
    writeRecord(dir, rec("m-one", { window_tokens: 10000 }));
    expect(planLocalSizing({ dir, tool: "chat", members: [llama("m-one")], userMaxOutput: 4000 })).toMatchObject({ maxTokens: 4000, inputTokens: 10000 - 4000 - 512 });
  });
});

describe("waitForCalibration (round 2 gap 1, round 3 item 1)", () => {
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  /** A wait over `models`; `onPoll(n)` runs before the n-th sleep (the runner's stand-in). */
  function wait(dir: string, models: string[], onPoll: (n: number) => void, over: Partial<Parameters<typeof waitForCalibration>[0]> = {}) {
    const lines: string[] = [];
    let starts = 0;
    let polls = 0;
    const done = waitForCalibration({
      dir, models: models.map((model) => ({ engine: "llama" as const, model })), head: models[0] ?? "", pollMs: 10, restartMs: 60_000, progressMs: 300_000,
      write: (l) => lines.push(l), stopReason: () => null,
      start: async () => { starts += 1; },
      sleep: async (ms) => { polls += 1; onPoll(polls); await sleep(ms); },
      ...over,
    });
    return { done, lines, starts: () => starts, polls: () => polls };
  }
  it("starts the calibration once, says it takes hours and names calibration-status, and returns when the record turns ok", async () => {
    const dir = tempDir("llm-ext-p7-wait-");
    const w = wait(dir, ["m-w"], (n) => n === 3 && writeRecord(dir, rec("m-w")));
    await w.done;
    expect(w.starts()).toBe(1);
    expect(w.polls()).toBe(3);
    expect(w.lines).toEqual([expect.stringMatching(/waiting for the calibration of m-w \(llama\) before sizing this command; a calibration takes hours.*llm-ext models calibration-status shows its progress/)]);
    expect(CALIBRATION_POLL_MS).toBe(5000);
  }, 10_000); // a missing exit condition would poll forever: fail in 10 s, not at the suite timeout
  it("waits for every model, not only the first", async () => {
    const dir = tempDir("llm-ext-p7-wait-");
    const w = wait(dir, ["m-a", "m-b"], (n) => {
      if (n === 2) writeRecord(dir, rec("m-a"));
      if (n === 5) writeRecord(dir, rec("m-b"));
    });
    await w.done;
    expect(w.polls()).toBe(5);
    expect(w.lines[0]).toMatch(/m-a \(llama\), m-b \(llama\)/);
  }, 10_000);
  it("starts the calibration again every restartMs, so a dead runner is restarted", async () => {
    const dir = tempDir("llm-ext-p7-wait-");
    const w = wait(dir, ["m-r"], (n) => n === 12 && writeRecord(dir, rec("m-r")), { restartMs: 30 });
    await w.done;
    expect(w.starts()).toBeGreaterThanOrEqual(2);
  }, 10_000);
  it("prints a progress line every progressMs with the finished phases of the progress file", async () => {
    const dir = tempDir("llm-ext-p7-wait-");
    const p = progressPath(dir, "llama", "m-p");
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ phases: { A: "passed" }, trials: [{ step: "A/known-answer" }, { step: "B/fact/2048" }] }));
    const w = wait(dir, ["m-p"], (n) => n === 12 && writeRecord(dir, rec("m-p")), { progressMs: 30 });
    await w.done;
    expect(w.lines.length).toBeGreaterThanOrEqual(2);
    expect(w.lines[1]).toMatch(/still waiting for calibration after 0 min: m-p: phases done: A passed; 2 trials/);
  }, 10_000);
  it("a start that fails (a busy state lock, a failed enqueue) fails the wait with its reason", async () => {
    const dir = tempDir("llm-ext-p7-wait-");
    const w = wait(dir, ["m-busy"], () => undefined, { start: async () => { throw new Error("could not queue 'm-busy' for calibration: the calibration state lock stayed busy for 5 s"); } });
    await expect(w.done).rejects.toThrow(/state lock stayed busy/);
    expect(w.polls()).toBe(0);
  }, 10_000);
  it("the head's failed record ends the wait with the record's message; a failed other member ends it without failing", async () => {
    const dir = tempDir("llm-ext-p7-wait-");
    const w = wait(dir, ["m-f"], (n) => n === 2 && writeRecord(dir, recordFixture("llama", "m-f", { step: "phase-a/context", message: "the model's context is 128 tokens" })));
    await expect(w.done).rejects.toThrow(/model 'm-f' calibration-failed at phase-a\/context: the model's context is 128 tokens/);
    const dir2 = tempDir("llm-ext-p7-wait-");
    writeRecord(dir2, rec("m-head"));
    const w2 = wait(dir2, ["m-head", "m-g"], (n) => n === 2 && writeRecord(dir2, recordFixture("llama", "m-g", { step: "B", message: "boom" })), { head: "m-head" });
    await w2.done;
    expect(w2.polls()).toBe(2);
  }, 10_000);
  it("a command stop (--command_timeout) ends the wait with CommandStoppedError", async () => {
    const dir = tempDir("llm-ext-p7-wait-");
    let polls = 0;
    const w = wait(dir, ["m-s"], (n) => (polls = n), { stopReason: () => (polls >= 2 ? "command timed out after 1 s" : null) });
    await expect(w.done).rejects.toBeInstanceOf(CommandStoppedError);
  }, 10_000);
});

/** The part of a POST body the tests read; chat_template_kwargs is the thinking switch (TRDD-1OOAH3LD gap C1-7). */
interface Body {
  max_tokens?: number;
  messages: Array<{ content: string }>;
  chat_template_kwargs?: { enable_thinking?: boolean };
}
/** A loopback chat-completions server that keeps every POST body; 404 for anything else (the endpoint-flavor probe). */
async function serve(bodies: Array<Body>, reply = "the files define constants a and b.", finish = "stop"): Promise<string> {
  const server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end("{}");
      return;
    }
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      const parsed = JSON.parse(body) as Body & { model?: unknown };
      bodies.push(parsed);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "x",
          object: "chat.completion",
          model: String(parsed.model),
          choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: finish }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (typeof addr !== "object" || addr === null) throw new Error("server address unavailable");
  return `http://127.0.0.1:${addr.port}`;
}

interface EntryOpts {
  extra?: Record<string, unknown>;
  tool?: "chat" | "scan_folder" | "check_references" | "compare_files";
  /** Sizes of a.ts and b.ts in bytes (a one-line constant each), unless `files` gives the contents. */
  sizes?: [number, number];
  files?: Record<string, string>;
  /** Only these files are named in input_files_paths (default: every file). */
  inputs?: string[];
  /** Extra profile YAML lines (4-space indented). */
  yaml?: string[];
  /** The profile model is an absolute .gguf path in the config dir, served by `server: managed`. */
  managed?: boolean;
  /** Run the --estimate path (buildEstimateDeps().ensembleSlots) instead of the command; nothing is sent. */
  estimate?: boolean;
  /** Runs after boot, right before the command (to set up state the boot would otherwise touch). */
  beforeDispatch?: (cfgDir: string) => void;
}

/**
 * Boot a fresh index.ts over a temp config dir holding a llamacpp-local profile at the loopback server (unmanaged unless
 * `managed`), with `record` (when given) written for its model, then run one command: chat in one merged answer
 * (answer_mode 2), so the payload budget decides how many requests are sent; scan_folder per file, so a file over the
 * budget is refused without a request (scan_folder reads max_payload_kb in its own core module); check_references and
 * compare_files over the files named.
 */
async function throughEntry(record: CalibrationRecord | null, o: EntryOpts = {}) {
  const tool = o.tool ?? "chat";
  const bodies: Array<Body> = [];
  const url = await serve(bodies);
  const cfgDir = tempDir("llm-ext-p7-cfg-");
  const homeDir = tempDir("llm-ext-p7-home-");
  const files = tempDir("llm-ext-p7-files-");
  const out = tempDir("llm-ext-p7-out-");
  cleanups.push(() => vi.unstubAllEnvs());
  const model = o.managed === true ? join(cfgDir, "m.gguf") : "m-one";
  if (o.managed === true) writeFileSync(model, "not a real model: sizing fails before the broker would start it");
  writeFileSync(
    join(cfgDir, "settings.yaml"),
    [
      "active: lc", "profiles:", "  lc:", "    mode: local", "    api: llamacpp-local", `    url: ${url}`, `    model: ${model}`,
      ...(o.managed === true ? ["    server: managed"] : []), ...(o.yaml ?? []), "",
    ].join("\n"),
    "utf-8",
  );
  if (record !== null) writeRecord(cfgDir, { ...record, model });
  const contents = o.files ?? Object.fromEntries(["a.ts", "b.ts"].map((n, i) => [n, `export const v${i} = "${"x".repeat(o.sizes?.[i] ?? 9000)}";\n`]));
  for (const [n, c] of Object.entries(contents)) writeFileSync(join(files, n), c, "utf-8");
  const paths = (o.inputs ?? Object.keys(contents)).map((n) => join(files, n));
  vi.stubEnv("LLM_EXT_CONFIG_DIR", cfgDir);
  vi.stubEnv("HOME", homeDir);
  vi.stubEnv("LLM_EXT_INSTALL_RULE", "0");
  vi.stubEnv("LLM_EXT_DISABLE_AUTO_RECONCILE", "1");
  vi.stubEnv("LLM_EXT_DISABLE_DEFAULT_PROFILE_POPULATION", "1");
  vi.resetModules();
  const idx = await import("./index.js");
  await idx.boot();
  const stderr: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array, ...rest: unknown[]) => {
    stderr.push(String(chunk));
    return write(chunk as string, ...(rest as []));
  });
  const args = tool === "chat"
    ? { instructions: INSTR, input_files_paths: paths, answer_mode: 2, output_dir: out, ...o.extra }
    : tool === "scan_folder"
      ? { instructions: INSTR, folder_path: files, output_dir: out, ...o.extra }
      : { input_files_paths: paths, output_dir: out, ...o.extra };
  o.beforeDispatch?.(cfgDir);
  if (o.estimate === true) {
    const slots = idx.buildEstimateDeps().ensembleSlots(tool);
    return { bodies, text: JSON.stringify(slots), isError: false, stderr: stderr.join(""), cfgDir };
  }
  const result = await idx.dispatchCallTool(tool, args);
  return { bodies, text: result.content.map((c) => c.text ?? "").join("\n"), isError: result.isError === true, stderr: stderr.join(""), cfgDir };
}

const INSTR = "describe the constants";
/** What index.ts reserves for the prompt before injecting a per-file budget (promptReserveBytes). */
const reserveOf = (instructions = "") => Buffer.byteLength(FILE_FORMAT_EXAMPLE + BREVITY_RULES + instructions, "utf-8");

/** Bytes of a request's user payload (the part the budget covers, with the prompt). */
const userBytes = (b: { messages: Array<{ content: string }> }) => Buffer.byteLength(b.messages[b.messages.length - 1]?.content ?? "", "utf-8");

describe("local input sizing through the entry (P7)", () => {
  // fill 4096 tokens x 4 chars per token x 0.88: 14417 bytes; the two 9000-byte files cannot share one request.
  const sized = () => rec("m-one", { fill_tokens: { fact: 4096, aggregate: 4096, bug: 4096 }, chars_per_token: 4, window_tokens: 8192, thinking_works: { off: true, on: false } });
  const budget = bytesOf(4096, 4);
  const windowBudget = bytesOf(8192 - CAP_OFF - 512, 4);

  it("an ok record splits the input by its budget and sends max_tokens = the output cap", async () => {
    const r = await throughEntry(sized());
    expect(r.isError, r.text).toBe(false);
    expect(r.bodies.length, r.text).toBe(2);
    for (const b of r.bodies) {
      expect(b.max_tokens).toBe(CAP_OFF);
      expect(userBytes(b)).toBeLessThanOrEqual(budget);
    }
  }, 60_000);

  it("an explicit max_payload_kb above the budget but within the window is used as asked, with one stderr line", async () => {
    const r = await throughEntry(sized(), { extra: { max_payload_kb: 16 } });
    expect(r.isError, r.text).toBe(false);
    expect(r.stderr).toMatch(new RegExp(`max_payload_kb 16 is above the calibrated input budget of m-one \\(${budget - reserveOf(INSTR)} bytes per file, 4096 tokens for fact tasks\\); using it as asked`));
  }, 60_000);

  it("an explicit max_payload_kb above the window is capped at the window bound, with one stderr line (round 3, M7)", async () => {
    const r = await throughEntry(sized(), { extra: { max_payload_kb: 100 } });
    expect(r.isError, r.text).toBe(false);
    expect(r.stderr).toMatch(new RegExp(`max_payload_kb 100 is above the window of m-one \\(${windowBudget - reserveOf(INSTR)} bytes per file after the ${CAP_OFF}-token output cap and the prompt\\); capped there`));
    for (const b of r.bodies) expect(userBytes(b)).toBeLessThanOrEqual(windowBudget);
  }, 60_000);

  it("no record on an unmanaged llama.cpp route keeps the 400 KB default and the profile max_tokens, and says so once", async () => {
    const r = await throughEntry(null);
    expect(r.isError, r.text).toBe(false);
    expect(r.bodies.length).toBe(1);
    expect(r.bodies[0]?.max_tokens).not.toBe(CAP_OFF);
    expect(r.stderr.match(/m-one \(llama\) has no ok calibration record: input keeps the 400 KB default/g)?.length).toBe(1);
  }, 60_000);

  it("a context too small for the output cap fails the command before anything is sent", async () => {
    const r = await throughEntry(rec("m-one", { window_tokens: 3000 }));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/below 1024 for fact tasks.*smallest context that works is 3584 tokens/);
    expect(r.bodies).toEqual([]);
  }, 60_000);

  it("a managed profile with no context_window is sized by the broker's slot context (round 3, M1), and the user's max_output_tokens is named (m5)", async () => {
    // PROVISIONAL_LOCAL_CTX (8192) - 7000 - 512 = 680 < 1024; the record's own window (16384) would leave 8872.
    expect(PROVISIONAL_LOCAL_CTX).toBe(8192);
    const r = await throughEntry(rec("m-one"), { managed: true, yaml: ["    request_options:", "      default:", "        max_output_tokens: 7000"] });
    expect(r.isError, r.text).toBe(true);
    expect(r.text).toMatch(/input budget 680 tokens is below 1024 for fact tasks \(context 8192, calibration window 16384, output cap 7000 \(request_options max_output_tokens\)/);
    expect(r.bodies).toEqual([]);
  }, 60_000);

  it("a managed model whose calibration cannot be queued (the state lock stays busy) fails the command with the reason, never a silent wait (round 3, item 1)", async () => {
    // calibration/state.ts withStateLock: the lock is the directory state.lock beside queue.json (not exported there).
    const r = await throughEntry(null, { managed: true, beforeDispatch: (cfgDir) => mkdirSync(join(dirname(queuePath(cfgDir)), "state.lock"), { recursive: true }) });
    expect(r.isError, r.text).toBe(true);
    expect(r.text).toMatch(/could not queue .*m\.gguf.* for calibration: the calibration state lock stayed busy for 5 s/);
    expect(r.stderr).not.toMatch(/waiting for the calibration/);
    expect(r.bodies).toEqual([]);
  }, 60_000);

  it("--estimate on a managed profile with no record never waits or queues: one line says it is provisional (round 3, M5)", async () => {
    const r = await throughEntry(null, { managed: true, estimate: true });
    expect(r.stderr).toMatch(/this estimate is provisional: .*m\.gguf not calibrated yet, so its output cap is the profile default until calibration/);
    expect(r.stderr).not.toMatch(/waiting for the calibration/);
    expect(existsSync(queuePath(r.cfgDir))).toBe(false);
    expect(r.bodies).toEqual([]);
  }, 60_000);

  // scan_folder reads max_payload_kb in scan-folder/core.ts: this pair proves the injection reaches a core module.
  // Two tests, not one: throughEntry spies on stderr, and a second spy in one test would wrap the first.
  it("scan_folder refuses a file over the calibrated budget (20000 bytes) and sends the one that fits", async () => {
    const calibrated = await throughEntry(sized(), { tool: "scan_folder", sizes: [20000, 1000] });
    expect(calibrated.bodies.length, calibrated.text).toBe(1);
    expect(calibrated.bodies[0]?.max_tokens).toBe(CAP_OFF);
    expect(calibrated.text).toMatch(/File too large/);
  }, 60_000);

  it("scan_folder without a record sends both files (the 400 KB default)", async () => {
    const uncalibrated = await throughEntry(null, { tool: "scan_folder", sizes: [20000, 1000] });
    expect(uncalibrated.bodies.length, uncalibrated.text).toBe(2);
  }, 60_000);

  it("check_references keeps source + dependencies within the budget and names what it left out (round 3, M4)", async () => {
    const dep = (n: string) => `export const ${n} = "${"y".repeat(8000)}";\n`;
    const r = await throughEntry(sized(), {
      tool: "check_references",
      files: { "a.ts": `import { b } from "./b";\nimport { c } from "./c";\nexport const a = b + c;\n`, "b.ts": dep("b"), "c.ts": dep("c") },
      inputs: ["a.ts"],
    });
    expect(r.isError, r.text).toBe(false);
    expect(r.stderr).toMatch(/check_references .*a\.ts: 1 of 2 dependency files left out, over the calibrated input budget/);
    expect(r.bodies.length, r.text).toBe(1);
    for (const b of r.bodies) expect(userBytes(b)).toBeLessThanOrEqual(budget);
  }, 60_000);

  it("compare_files keeps diff + both files within the budget: 4 per-file shares, the diff 2 of them (round 3, M4)", async () => {
    const lines = (p: string) => Array.from({ length: 100 }, (_, i) => `${p}-line-${i} ${"z".repeat(70)}`).join("\n") + "\n";
    const r = await throughEntry(sized(), { tool: "compare_files", files: { "a.ts": lines("a"), "b.ts": lines("b") } });
    expect(r.isError, r.text).toBe(false);
    expect(r.bodies.length, r.text).toBe(1);
    for (const b of r.bodies) expect(userBytes(b)).toBeLessThanOrEqual(budget);
  }, 60_000);

  // Gap 3: 2048 tokens x 2 chars per token x 0.88 = 3604 bytes, below readAndGroupFiles' 10 KB clamp.
  const small = () => rec("m-one", { fill_tokens: { fact: 2048, aggregate: 2048, bug: 2048 }, chars_per_token: 2, window_tokens: 8192 });

  it("a calibrated budget below 10 KB is not raised by the 10 KB clamp: two 1500-byte files go in two requests", async () => {
    const r = await throughEntry(small(), { sizes: [1500, 1500] });
    expect(r.isError, r.text).toBe(false);
    expect(r.bodies.length, r.text).toBe(2);
  }, 60_000);

  it("an explicit max_payload_kb below 10 KB keeps the clamp: the same two files go in one request", async () => {
    const r = await throughEntry(small(), { extra: { max_payload_kb: 4 }, sizes: [1500, 1500] });
    expect(r.isError, r.text).toBe(false);
    expect(r.bodies.length, r.text).toBe(1);
  }, 60_000);

  it("a file the calibrated budget skips is named with its size against the budget (round 3, M6)", async () => {
    const r = await throughEntry(small(), { sizes: [5000, 1500] });
    expect(r.isError, r.text).toBe(false);
    expect(r.stderr).toMatch(/skipped \S*a\.ts: 50\d\d bytes, over the \d+ bytes the calibrated input budget leaves for files \(\d+ bytes with the prompt\)/);
    expect(r.bodies.length, r.text).toBe(1);
  }, 60_000);

  it("when the calibrated budget leaves no file to send, the command fails before any request (round 3, M6)", async () => {
    const r = await throughEntry(small(), { sizes: [5000, 5000] });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/no file fits the calibrated input budget/);
    expect(r.bodies).toEqual([]);
  }, 60_000);
});

/**
 * Real completion layer over makeProviderDeps local-fallback deps (noHold) against the loopback server, which answers `reply`: a llamacpp-local
 * profile whose head model m-clean proves thinking off and on, and a second model m-leaky whose off mode is leaky. One module registry for all
 * imports, so completion.ts reads the same ctxStore this helper writes. `requestOptions` is the profile request_options block, when given.
 */
async function localWalk(reply?: string, requestOptions?: Record<string, unknown>, finish?: string) {
  const bodies: Array<Body> = [];
  const url = await serve(bodies, reply, finish);
  const cfgDir = tempDir("llm-ext-thinking-walk-cfg-");
  const homeDir = tempDir("llm-ext-thinking-walk-home-");
  cleanups.push(() => vi.unstubAllEnvs());
  writeFileSync(join(cfgDir, "settings.yaml"), ["active: lc", "profiles:", "  lc:", "    mode: local", "    api: llamacpp-local", `    url: ${url}`, "    model: m-clean", ""].join("\n"), "utf-8");
  writeRecord(cfgDir, rec("m-clean", { thinking_works: { off: true, on: true } }));
  writeRecord(cfgDir, rec("m-leaky", { thinking_works: { off: "leaky", on: true } }));
  vi.stubEnv("LLM_EXT_CONFIG_DIR", cfgDir);
  vi.stubEnv("HOME", homeDir);
  vi.stubEnv("LLM_EXT_INSTALL_RULE", "0");
  vi.stubEnv("LLM_EXT_DISABLE_AUTO_RECONCILE", "1");
  vi.stubEnv("LLM_EXT_DISABLE_DEFAULT_PROFILE_POPULATION", "1");
  vi.resetModules();
  const { ctxStore } = await import("./usage-history.js");
  const { chatCompletionSimple, chatCompletionJSON, chatCompletionWithRetry } = await import("./provider/completion.js");
  const { resolveProfile } = await import("./config.js");
  const idx = await import("./index.js");
  await idx.boot();
  const profile = resolveProfile("lc", { mode: "local", api: "llamacpp-local", url, model: "m-clean", ...(requestOptions !== undefined ? { request_options: requestOptions } : {}) } as Profile);
  const backend = { type: "local" as const, billable: false, isLocal: true, baseUrl: url, apiKey: "", model: "m-clean", __version: 1 };
  const deps = idx.makeProviderDeps(profile, backend, { noHold: true });
  const inTool = <T>(tool: string, fn: () => T): T => ctxStore.run({ tool, params: "", project: "/tmp", opId: "op-00000000" }, fn);
  return {
    bodies,
    deps,
    retry: (tool: string, model: string) => inTool(tool, () => chatCompletionWithRetry([{ role: "user", content: "hi" }], { model, maxTokens: 64 }, deps)),
    send: (tool: string, model: string, over: Partial<typeof deps> = {}) => inTool(tool, () => chatCompletionSimple([{ role: "user", content: "hi" }], { model, maxTokens: 64 }, { ...deps, ...over })),
    sendJson: (tool: string, model: string) => inTool(tool, () => chatCompletionJSON([{ role: "user", content: "hi" }], { model, maxTokens: 64 }, deps)),
  };
}
// TRDD-1OOAH3LD gap C1-7 / TRDD-ZGSGGHQG gap Z-3: the thinking switch is decided per model from its own calibration record.
describe("per-model thinking switch on a calibrated local route", () => {
  const works = (off: boolean | "leaky", on: boolean) => rec("m-one", { thinking_works: { off, on } });

  it("bug sends enable_thinking true only when thinking on is proven, and never an explicit false", () => {
    expect(localThinkingSwitch(works(true, true), "bug")).toBe(true);
    expect(localThinkingSwitch(works(true, false), "bug")).toBeUndefined();
    expect(localThinkingSwitch(works(false, false), "bug")).toBeUndefined();
  });

  it("fact and aggregate send enable_thinking false only when thinking off is proven; leaky or unproven sends nothing", () => {
    for (const kind of ["fact", "aggregate"] as const) {
      expect(localThinkingSwitch(works(true, true), kind)).toBe(false);
      expect(localThinkingSwitch(works("leaky", true), kind)).toBeUndefined();
      expect(localThinkingSwitch(works(false, true), kind)).toBeUndefined();
    }
  });

  it("localThinkingFor answers undefined for a remote api, a tool outside the table, no tool, and a model with no ok record", () => {
    const dir = tempDir("llm-ext-thinking-for-");
    writeRecord(dir, works(true, true));
    expect(localThinkingFor(dir, "code_task", "m-one", "llamacpp-local")).toBe(true);
    expect(localThinkingFor(dir, "code_task", "m-one", "openrouter-remote")).toBeUndefined();
    expect(localThinkingFor(dir, "code_task", "m-one", undefined)).toBeUndefined();
    expect(localThinkingFor(dir, "not_a_tool", "m-one", "llamacpp-local")).toBeUndefined();
    expect(localThinkingFor(dir, undefined, "m-one", "llamacpp-local")).toBeUndefined();
    expect(localThinkingFor(dir, "code_task", "m-other", "llamacpp-local")).toBeUndefined();
    writeRecord(dir, recordFixture("llama", "m-failed", { step: "B", message: "boom" }));
    expect(localThinkingFor(dir, "code_task", "m-failed", "llamacpp-local")).toBeUndefined();
  });

  it("localThinkingFor decides per model: two models in one config dir with different records get different switches", () => {
    const dir = tempDir("llm-ext-thinking-per-model-");
    writeRecord(dir, rec("m-clean", { thinking_works: { off: true, on: true } }));
    writeRecord(dir, rec("m-leaky", { thinking_works: { off: "leaky", on: true } }));
    expect(localThinkingFor(dir, "chat", "m-clean", "llamacpp-local")).toBe(false);
    expect(localThinkingFor(dir, "chat", "m-leaky", "llamacpp-local")).toBeUndefined();
  });

  it("a Locals bug-kind request makes localsOutgoingModel pick the -thinking id, a fact-kind one the base id", () => {
    const dir = tempDir("llm-ext-thinking-locals-");
    writeRecord(dir, { ...rec("x-model", { thinking_works: { off: true, on: true } }), engine: "locals" });
    const ids = ["x-model", "x-model-thinking"];
    const bug = localThinkingFor(dir, "code_task", "x-model", "locals-local");
    const fact = localThinkingFor(dir, "chat", "x-model", "locals-local");
    expect(localsOutgoingModel(ids, { chat_template_kwargs: { enable_thinking: bug } })).toBe("x-model-thinking");
    expect(localsOutgoingModel(ids, { chat_template_kwargs: { enable_thinking: fact } })).toBe("x-model");
  });

  it("through the entry: a fact-kind command to a llama route whose record proves thinking off sends enable_thinking false", async () => {
    const r = await throughEntry(works(true, true));
    expect(r.isError, r.text).toBe(false);
    expect(r.bodies.length, r.text).toBe(1);
    expect(r.bodies[0]?.chat_template_kwargs).toEqual({ enable_thinking: false });
  }, 60_000);

  it("through the entry: a leaky thinking-off record sends no chat_template_kwargs", async () => {
    const r = await throughEntry(works("leaky", true));
    expect(r.isError, r.text).toBe(false);
    expect(r.bodies[0]).toBeDefined();
    expect(r.bodies[0]?.chat_template_kwargs).toBeUndefined();
  }, 60_000);

  it("through the entry: a bug-kind command whose record proves thinking on sends enable_thinking true", async () => {
    const r = await throughEntry(works(true, true), { tool: "compare_files", sizes: [800, 800] });
    expect(r.isError, r.text).toBe(false);
    expect(r.bodies.length, r.text).toBe(1);
    expect(r.bodies[0]?.chat_template_kwargs).toEqual({ enable_thinking: true });
  }, 60_000);

  it("through the entry: a bug-kind command whose record does not prove thinking on sends no chat_template_kwargs", async () => {
    const r = await throughEntry(works(true, false), { tool: "compare_files", sizes: [800, 800] });
    expect(r.isError, r.text).toBe(false);
    expect(r.bodies[0]).toBeDefined();
    expect(r.bodies[0]?.chat_template_kwargs).toBeUndefined();
  }, 60_000);

  it("through chatCompletionSimple with makeProviderDeps local-fallback deps (noHold): each model gets the switch from its OWN record, per tool kind", async () => {
    const w = await localWalk();
    await w.send("code_task", "m-clean");
    await w.send("chat", "m-clean");
    await w.send("code_task", "m-leaky");
    await w.send("chat", "m-leaky");
    expect(w.bodies.map((b) => b.chat_template_kwargs)).toEqual([{ enable_thinking: true }, { enable_thinking: false }, { enable_thinking: true }, undefined]);
  }, 60_000);

  it("a reply to a send that carried enable_thinking true loses its <think> block (USER 2026-10-28: strip the thinking block)", async () => {
    const w = await localWalk("<think>x</think>answer");
    expect((await w.send("code_task", "m-clean")).content).toBe("answer");
  }, 60_000);

  it("the same reply on a send that did not carry true comes back unchanged: thinking off proven, and a leaky off record", async () => {
    const w = await localWalk("<think>x</think>answer");
    expect((await w.send("chat", "m-clean")).content).toBe("<think>x</think>answer");
    expect((await w.send("chat", "m-leaky")).content).toBe("<think>x</think>answer");
  }, 60_000);

  it("a send whose thinking true comes from the profile request_options is stripped too (the body decides); thinking false from it is not", async () => {
    const on = await localWalk("<think>x</think>answer", { default: { max_output_tokens: 600, thinking: true } });
    expect((await on.send("chat", "m-clean")).content).toBe("answer");
    expect(on.bodies[0]?.chat_template_kwargs).toEqual({ enable_thinking: true });
    const off = await localWalk("<think>x</think>answer", { default: { max_output_tokens: 600, thinking: false } });
    expect((await off.send("code_task", "m-clean")).content).toBe("<think>x</think>answer");
    expect(off.bodies[0]?.chat_template_kwargs).toEqual({ enable_thinking: false });
  }, 60_000);

  it("the JSON path strips the block before the parse on a thinking-on send, and still fails on a send that did not carry true", async () => {
    const w = await localWalk("<think>x</think>{\"a\":1}");
    expect((await w.sendJson("code_task", "m-clean")).parsed).toEqual({ a: 1 });
    await expect(w.sendJson("chat", "m-clean")).rejects.toThrow(/malformed JSON/);
  }, 60_000);

  it("a thinking-on reply with no think tag is returned byte for byte (no trim, no cut)", async () => {
    const w = await localWalk("  plain answer\n");
    expect((await w.send("code_task", "m-clean")).content).toBe("  plain answer\n");
  }, 60_000);

  it("only a LEADING think block is removed, with the whitespace right after it (and before it); the answer after it is untouched", async () => {
    const w = await localWalk("<think>x</think>\n  answer");
    expect((await w.send("code_task", "m-clean")).content).toBe("answer");
    const lead = await localWalk("  <think>x</think>answer");
    expect((await lead.send("code_task", "m-clean")).content).toBe("answer");
  }, 60_000);

  it("a reply that quotes a think tag mid-text is returned byte for byte, even on a thinking-on send", async () => {
    const orphan = await localWalk("use </think> carefully");
    expect((await orphan.send("code_task", "m-clean")).content).toBe("use </think> carefully");
    const later = await localWalk("answer: <think>x</think> done");
    expect((await later.send("code_task", "m-clean")).content).toBe("answer: <think>x</think> done");
  }, 60_000);

  it("a reply cut inside the think block (unclosed <think>, finish_reason length) behaves exactly as an untouched send: same content, finish reason, JSON error and retry outcome", async () => {
    const cut = "<think>unclosed";
    const on = await localWalk(cut, undefined, "length");
    const off = await localWalk(cut, undefined, "length");
    // code_task sends enable_thinking true; chat on the same model sends false (not stripped): the control.
    const rOn = await on.send("code_task", "m-clean");
    const rOff = await off.send("chat", "m-clean");
    expect(on.bodies[0]?.chat_template_kwargs).toEqual({ enable_thinking: true });
    expect(off.bodies[0]?.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(rOn.content).toBe(cut);
    expect(rOn.content).toBe(rOff.content);
    expect(rOn.finishReason).toBe(rOff.finishReason);
    await expect(on.sendJson("code_task", "m-clean")).rejects.toThrow(/malformed JSON/);
    await expect(off.sendJson("chat", "m-clean")).rejects.toThrow(/malformed JSON/);
    // The retry loop (chatCompletionWithRetry, local route: MAX_TRUNCATION_RETRIES 3): same number of requests and same labelled reply.
    const retryOn = await localWalk(cut, undefined, "length");
    const retryOff = await localWalk(cut, undefined, "length");
    const a = await retryOn.retry("code_task", "m-clean");
    const b = await retryOff.retry("chat", "m-clean");
    expect(retryOn.bodies.length).toBe(retryOff.bodies.length);
    expect(a.content).toBe(b.content);
    expect(a.truncated).toBe(b.truncated);
  }, 120_000);

  it("a send with enable_thinking true on a route that is not llama.cpp or Locals is returned unchanged (remote sends are never touched)", async () => {
    const w = await localWalk("<think>x</think>answer", { default: { max_output_tokens: 600, thinking: true } });
    const head = w.deps.routeForModel("m-clean");
    expect(head).not.toBeNull();
    const route = { ...(head as ResolvedRoute), api: "openrouter-remote" };
    const r = await w.send("chat", "m-clean", { routeForModel: () => route });
    expect(w.bodies[0]?.chat_template_kwargs).toEqual({ enable_thinking: true });
    expect(r.content).toBe("<think>x</think>answer");
  }, 60_000);

  it("a routed (non-primary) group gets no switch and no strip: the body carries no chat_template_kwargs and the reply is unchanged", async () => {
    const w = await localWalk("<think>x</think>answer");
    const head = w.deps.routeForModel("m-clean");
    expect(head).not.toBeNull();
    const route = { ...(head as ResolvedRoute), name: "second", primary: false };
    const r = await w.send("code_task", "m-clean", { routeForModel: () => route });
    expect(w.bodies[0]?.chat_template_kwargs).toBeUndefined();
    expect(r.content).toBe("<think>x</think>answer");
  }, 60_000);
  it("through the entry: no calibration record sends no chat_template_kwargs", async () => {
    const r = await throughEntry(null);
    expect(r.isError, r.text).toBe(false);
    expect(r.bodies[0]).toBeDefined();
    expect(r.bodies[0]?.chat_template_kwargs).toBeUndefined();
  }, 60_000);

  it("through the entry: the user request_options thinking wins over the record", async () => {
    const r = await throughEntry(works(true, true), { yaml: ["    request_options:", "      default:", "        max_output_tokens: 600", "        thinking: on"] });
    expect(r.isError, r.text).toBe(false);
    expect(r.bodies[0]?.chat_template_kwargs).toEqual({ enable_thinking: true });
  }, 60_000);
});
