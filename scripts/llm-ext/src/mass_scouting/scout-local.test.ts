/**
 * mass_scouting/scout-local.test.ts — mass scouting on a local profile (P9, TRDD-1OOAH3LD, TRDD-ZGSGGHQG).
 *
 * Real loopback HTTP servers, a temp HOME, LLM_EXT_CONFIG_DIR and governor directory, real calibration records written
 * through writeRecord; no mocks and no injected fetch: the URL, header, lease and sizing rules are only proven through
 * the production adapter. The profile is an UNMANAGED llamacpp-local one (a user-started server), so no broker or
 * llama-server is spawned; the managed (broker) path is not exercised here.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeRecord, type CalibrationRecord } from "../calibration/record.js";
import { recordFixture } from "../calibration/test-record.js";
import { SCOUT_OUTPUT_CAP } from "../calibration/phase-c.js";
import { snapshot } from "../governor/client.js";
import { runMassScoutCli } from "./cli";
import { openRegistry } from "./registry";
import { compileFieldset, parseFieldset } from "./fieldset";
import { inputCapBytes, runScoutJob } from "./scout";
import { leasedFetch } from "./scout-local";

const MODEL = "m-local";
const SENTINEL_KEY = "sk-or-p9-sentinel-never-sent";

interface Seen {
  url: string;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
  leases: number;
}

interface Loopback {
  url: string;
  seen: Seen[];
  peak: () => number;
}

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  vi.unstubAllEnvs();
});

/** A chat-completions server that records every request, the governor leases held while it runs, and the peak number in flight. */
/**
 * `delayMs` holds each reply (default 60, long enough that parallel requests overlap); `models` makes GET /v1/models
 * list those ids, as a Locals server does.
 */
async function serve(reply: (body: Record<string, unknown>) => string, opts: { delayMs?: number; models?: string[] } = {}): Promise<Loopback> {
  const seen: Seen[] = [];
  let inFlight = 0;
  let peak = 0;
  const server: Server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/models" && opts.models) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: opts.models.map((id) => ({ id })) }));
      return;
    }
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString("utf-8")));
    req.on("end", () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      const body = JSON.parse(raw) as Record<string, unknown>;
      seen.push({ url: req.url ?? "", headers: req.headers, body, leases: snapshot().leases.length });
      // Held long enough that parallel requests overlap, so the peak can show a worker count over the cap.
      setTimeout(() => {
        inFlight--;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: reply(body) } }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
      }, opts.delayMs ?? 60);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, seen, peak: () => peak };
}

interface Env {
  cfg: string;
  work: string;
  db: string;
  fields: string;
  tree: string;
}

/** A temp config dir whose ACTIVE profile is a local llama.cpp profile pointing at `url`, plus a work dir and a fieldset. */
/**
 * `extra` adds profile yaml lines (second_model, third_model) and records of other models; `active` names another
 * active profile, `api` and `model` change the local profile (a Locals one).
 */
type SetupExtra = { yaml?: string[]; records?: Record<string, Partial<CalibrationRecord>>; active?: string; api?: string; model?: string };
function setup(url: string, record: Partial<CalibrationRecord> | null, extra: SetupExtra = {}): Env {
  const pmodel = extra.model ?? MODEL;
  const cfg = mkdtempSync(join("/tmp", "llm-ext-p9-cfg-"));
  const home = mkdtempSync(join("/tmp", "llm-ext-p9-home-"));
  const gov = mkdtempSync(join("/tmp", "llm-ext-p9-gov-"));
  const work = mkdtempSync(join("/tmp", "llm-ext-p9-work-"));
  cleanups.push(() => {
    for (const d of [cfg, home, gov, work]) rmSync(d, { recursive: true, force: true });
  });
  vi.stubEnv("LLM_EXT_CONFIG_DIR", cfg);
  vi.stubEnv("HOME", home);
  vi.stubEnv("LLM_EXT_INSTALL_RULE", "0");
  vi.stubEnv("LLM_EXT_GOVERNOR_DIR", gov);
  vi.stubEnv("LLM_EXT_GOVERNOR_CPU_LIMIT_PCT", "100");
  vi.stubEnv("LLM_EXT_GOVERNOR_RAM_LIMIT_PCT", "99");
  vi.stubEnv("LLM_EXT_GOVERNOR_MAX_INFERENCES", "8");
  vi.stubEnv("LLM_EXT_GOVERNOR_SETTLE_MS", "100");
  // Present on purpose: a local run must never read it, so it must never reach the server.
  vi.stubEnv("OPENROUTER_API_KEY", SENTINEL_KEY);
  writeFileSync(
    join(cfg, "settings.yaml"),
    [`active: ${extra.active ?? "lcl"}`, "profiles:", "  lcl:", "    mode: local", `    api: ${extra.api ?? "llamacpp-local"}`, `    url: ${url}`, `    model: ${pmodel}`, ...(extra.yaml ?? []), ""].join("\n"),
    "utf-8",
  );
  const engine = extra.api === "locals-local" ? "locals" : "llama";
  if (record !== null) writeRecord(cfg, { ...recordFixture(engine, pmodel), ...record } as CalibrationRecord);
  for (const [model, over] of Object.entries(extra.records ?? {})) writeRecord(cfg, { ...recordFixture(engine, model), ...over } as CalibrationRecord);
  const tree = join(work, "tree");
  mkdirSync(tree, { recursive: true });
  const fields = join(work, "fields.json");
  writeFileSync(
    fields,
    JSON.stringify({
      version: 1,
      fieldset_name: "p9-test",
      fields: [
        { name: "is_async", description: "true if file uses async / await", type: { kind: "bool" } },
        { name: "summary", description: "one-sentence summary", type: { kind: "string", max_length: 80 } },
      ],
    }),
    "utf-8",
  );
  return { cfg, work, db: join(work, "scout.db"), fields, tree };
}

/** share 2048 at 2 slots passes 0.95; the larger share fails it, so scoutingFor must pick the first. */
const CANDIDATES = [
  { share_tokens: 2048, slots: 2, slot_ctx: 3072, accuracy: 0.97, records_per_s: 5, permutation_seed: 1 },
  { share_tokens: 4096, slots: 4, slot_ctx: 5120, accuracy: 0.5, records_per_s: 9, permutation_seed: 2 },
];

async function registerFiles(env: Env, n: number, big = false): Promise<void> {
  for (let i = 0; i < n; i++) writeFileSync(join(env.tree, `f${i}.ts`), `export const v${i} = ${i};\n`, "utf-8");
  // Over the calibrated share (2048 tokens x 4 chars per token), under any remote register cap.
  if (big) writeFileSync(join(env.tree, "big.ts"), `// ${"x".repeat(10_000)}\n`, "utf-8");
  // Under the share cap but over 40 % of the slot context (the remote percentage rule): proves the share is the cap.
  if (big) writeFileSync(join(env.tree, "mid.ts"), `// ${"y".repeat(5_200)}\n`, "utf-8");
  const r = await runMassScoutCli(["register", "--db", env.db, "--root", env.tree]);
  expect(r.exitCode, r.stderr).toBe(0);
}

function scoutArgs(env: Env, jobId: string, extra: string[] = []): string[] {
  return ["scout", "--db", env.db, "--fields-file", env.fields, "--job-id", jobId, "--source-root", env.tree, "--no-smoke-test", ...extra];
}

const OK_REPLY = (): string => JSON.stringify({ is_async: false, summary: "x" });

describe("mass scouting on a local profile (P9)", () => {
  it("sends to the profile's own server with no OpenRouter key, sized and bounded by the calibration record, under a lease, at cost 0", async () => {
    const srv = await serve(OK_REPLY);
    const env = setup(srv.url, { scouting_candidates: CANDIDATES, structured_output: { off: true, on: true, array40: true } });
    await registerFiles(env, 6, true);
    const r = await runMassScoutCli(scoutArgs(env, "job-a", ["--workers", "8"]), { mainRoot: env.work });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toContain("files_ok=7");
    // The big file is over the calibrated input share, so it is skipped, never sent.
    expect(r.stdout).toContain("files_skipped_too_big=1");
    expect(r.stdout).toContain("cost_usd=$0.000000");
    expect(srv.seen).toHaveLength(7);
    for (const s of srv.seen) {
      expect(s.url).toBe("/v1/chat/completions");
      expect(s.body.model).toBe(MODEL);
      // slot_ctx - share_tokens of the chosen candidate (3072 - 2048).
      // Round 2, fix 1: the reply cap Phase C reserved (SCOUT_OUTPUT_CAP), never slot_ctx - share_tokens (1024 here),
      // which also holds the slot overhead and the round-up.
      expect(s.body.max_tokens).toBe(SCOUT_OUTPUT_CAP);
      // Round 2, fix 2: the thinking setting Phase C measured the scouting accuracy under.
      expect(s.body.chat_template_kwargs).toEqual({ enable_thinking: false });
      expect(s.body.response_format).toMatchObject({ type: "json_schema" });
      expect(JSON.stringify(s.headers)).not.toContain(SENTINEL_KEY);
      expect(s.headers.authorization).toBeUndefined();
      // Governor D9: the request reached the server while its lease was held.
      expect(s.leases).toBeGreaterThanOrEqual(1);
    }
    // --workers 8 is capped by the candidate's 2 slots.
    // The governor admits leases through an adaptive window, so the peak bounds the workers but need not reach them;
    // the job row records the worker count the run used.
    expect(srv.peak()).toBeLessThanOrEqual(2);
    const reg = openRegistry({ path: env.db });
    try {
      expect(reg.getJob("job-a")?.workers).toBe(2);
    } finally {
      reg.close();
    }
  });

  it("sends no response_format when the record says json_schema does not work, and parses the JSON out of the reply text", async () => {
    const srv = await serve(() => `<think>thinking</think>\n\`\`\`json\n${OK_REPLY()}\n\`\`\``);
    const env = setup(srv.url, { scouting_candidates: CANDIDATES, structured_output: { off: true, on: true, array40: false } });
    await registerFiles(env, 3);
    const r = await runMassScoutCli(scoutArgs(env, "job-b"), { mainRoot: env.work });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toContain("files_ok=3");
    expect(r.stdout).toContain("files_failed=0");
    expect(srv.seen).toHaveLength(3);
    for (const s of srv.seen) {
      expect(s.body).not.toHaveProperty("response_format");
      const system = (s.body.messages as Array<{ role: string; content: string }>)[0]!;
      expect(system.content).toContain("It must match this JSON Schema");
    }
  });

  it("refuses a model with no calibration record, naming the calibrate command, and sends nothing", async () => {
    const srv = await serve(OK_REPLY);
    const env = setup(srv.url, null);
    await registerFiles(env, 2);
    const r = await runMassScoutCli(scoutArgs(env, "job-c"), { mainRoot: env.work });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(`model '${MODEL}' (llama) is not calibrated; run llm-ext models calibrate --model ${MODEL}`);
    expect(srv.seen).toHaveLength(0);
  });

  it("refuses a model whose scouting accuracy is under the threshold, naming both, and sends nothing", async () => {
    const srv = await serve(OK_REPLY);
    const low = CANDIDATES.map((c) => ({ ...c, accuracy: c.share_tokens === 2048 ? 0.8 : 0.5 }));
    const env = setup(srv.url, { scouting_candidates: low });
    await registerFiles(env, 2);
    const r = await runMassScoutCli(scoutArgs(env, "job-d"), { mainRoot: env.work });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(`model '${MODEL}' is unfit for mass scouting: its best measured scouting accuracy is 0.8 and the threshold (scout_accuracy_threshold) is 0.95`);
    expect(srv.seen).toHaveLength(0);
  });

  it("refuses a model with no measurable scouting candidate by its recorded reason, never as an accuracy failure", async () => {
    const srv = await serve(OK_REPLY);
    const env = setup(srv.url, { scouting_candidates: [], scouting_unfit_reason: "over total RAM" });
    await registerFiles(env, 1);
    const r = await runMassScoutCli(scoutArgs(env, "job-e"), { mainRoot: env.work });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("no scouting candidate could be measured (over total RAM)");
    expect(r.stderr).not.toContain("accuracy is");
    expect(srv.seen).toHaveLength(0);
  });

  it("estimate prices a local run at 0 from the record, with token counts and the calibrated cap, needing no pricing flags", async () => {
    const srv = await serve(OK_REPLY);
    const env = setup(srv.url, { scouting_candidates: CANDIDATES });
    await registerFiles(env, 4, true);
    const r = await runMassScoutCli(["estimate", "--db", env.db, "--fields-file", env.fields]);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toContain(`model=${MODEL}  context_window=3072`);
    expect(r.stdout).toContain(`local profile=lcl engine=llama share_tokens=2048 slots=2 max_tokens=${SCOUT_OUTPUT_CAP} structured_output=false`);
    expect(r.stdout).toContain("files_eligible=5");
    expect(r.stdout).toContain("files_skipped_too_big=1");
    expect(r.stdout).toMatch(/total_input_tokens=[1-9]\d*/);
    expect(r.stdout).toContain("est_cost_usd=$0.000000");
    expect(srv.seen).toHaveLength(0);
  });

  it("propose-fieldset on a local profile goes to the profile's server, bounded, and parses a text reply", async () => {
    const proposal = { fieldset_name: "proposed-local", fields: [{ name: "summary", description: "one-sentence summary", type: { kind: "string" } }] };
    const srv = await serve(() => `\`\`\`json\n${JSON.stringify(proposal)}\n\`\`\``);
    setup(srv.url, { scouting_candidates: CANDIDATES });
    const r = await runMassScoutCli(["propose-fieldset", "--goal", "summarise every file"]);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toContain('"fieldset_name": "proposed-local"');
    expect(srv.seen).toHaveLength(1);
    const s = srv.seen[0]!;
    expect(s.url).toBe("/v1/chat/completions");
    // Round 2, fixes 1 and 2: the reply cap and the thinking setting Phase C measured scouting under.
    expect(s.body.max_tokens).toBe(SCOUT_OUTPUT_CAP);
    expect(s.body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(s.body).not.toHaveProperty("response_format");
    expect(JSON.stringify(s.headers)).not.toContain(SENTINEL_KEY);
    expect(s.leases).toBeGreaterThanOrEqual(1);
  });

  /** Round 2, fix 3 (spec section 6, F3): the profile's models in order; m-local has no record, m-two is unfit, m-three is fit. */
  const CHAIN = {
    yaml: ["    second_model: m-two", "    third_model: m-three"],
    records: {
      "m-two": { scouting_candidates: CANDIDATES.map((c) => ({ ...c, accuracy: 0.8 })) },
      "m-three": { scouting_candidates: CANDIDATES },
    },
  };

  it("without --model, scouts with the first fit model of the profile and names each skipped model with why on stderr", async () => {
    const srv = await serve(OK_REPLY);
    const env = setup(srv.url, null, CHAIN);
    await registerFiles(env, 2);
    const lines: string[] = [];
    // Observation only: the real write still runs (no mockImplementation).
    const spy = vi.spyOn(process.stderr, "write");
    let r;
    try {
      r = await runMassScoutCli(scoutArgs(env, "job-chain"), { mainRoot: env.work });
    } finally {
      for (const call of spy.mock.calls) lines.push(String(call[0]));
      spy.mockRestore();
    }
    expect(r.exitCode, r.stderr).toBe(0);
    expect(srv.seen.map((s) => s.body.model)).toEqual(["m-three", "m-three"]);
    const skips = lines.filter((l) => l.includes("mass scouting skips a model of profile 'lcl'"));
    expect(skips).toHaveLength(2);
    expect(skips[0]).toContain(`model '${MODEL}' (llama) is not calibrated`);
    expect(skips[1]).toContain("model 'm-two' is unfit for mass scouting: its best measured scouting accuracy is 0.8");
  });

  it("without --model, refuses when no model of the profile is fit, naming every model with its reason", async () => {
    const srv = await serve(OK_REPLY);
    const env = setup(srv.url, null, { ...CHAIN, records: { ...CHAIN.records, "m-three": { scouting_candidates: [], scouting_unfit_reason: "over total RAM" } } });
    await registerFiles(env, 1);
    const r = await runMassScoutCli(scoutArgs(env, "job-none"), { mainRoot: env.work });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("no model of profile 'lcl' is fit for mass scouting: ");
    expect(r.stderr).toContain(`model '${MODEL}' (llama) is not calibrated`);
    expect(r.stderr).toContain("model 'm-two' is unfit for mass scouting: its best measured scouting accuracy is 0.8");
    expect(r.stderr).toContain("model 'm-three' is unfit for mass scouting: no scouting candidate could be measured (over total RAM)");
    expect(srv.seen).toHaveLength(0);
  });

  it("with --model, refuses that model alone when it cannot scout, never falling back to a fit one", async () => {
    const srv = await serve(OK_REPLY);
    const env = setup(srv.url, null, CHAIN);
    await registerFiles(env, 1);
    const r = await runMassScoutCli(scoutArgs(env, "job-explicit", ["--model", "m-two"]), { mainRoot: env.work });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("model 'm-two' is unfit for mass scouting: its best measured scouting accuracy is 0.8");
    expect(r.stderr).not.toContain("m-three");
    expect(srv.seen).toHaveLength(0);
  });

  // ── Round 3 ──────────────────────────────────────────────────────────

  it("--profile naming a local llama.cpp profile scouts on that profile even when another profile is active", async () => {
    const srv = await serve(OK_REPLY);
    const env = setup(srv.url, { scouting_candidates: CANDIDATES }, { active: "elsewhere" });
    await registerFiles(env, 2);
    const r = await runMassScoutCli(scoutArgs(env, "job-profile", ["--profile", "lcl"]), { mainRoot: env.work });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toContain("files_ok=2");
    expect(srv.seen.map((s) => s.body.model)).toEqual([MODEL, MODEL]);
  });

  it("--workers that is not a positive integer is a usage error on the local path, never the slot count", async () => {
    const srv = await serve(OK_REPLY);
    const env = setup(srv.url, { scouting_candidates: CANDIDATES });
    await registerFiles(env, 1);
    for (const bad of ["abc", "0", "2.5", "-1"]) {
      const r = await runMassScoutCli(scoutArgs(env, `job-w-${bad}`, [`--workers=${bad}`]), { mainRoot: env.work });
      expect(r.exitCode, bad).toBe(1);
      expect(r.stderr).toContain(`--workers must be a positive integer, got '${bad}'`);
    }
    expect(srv.seen).toHaveLength(0);
  });

  it("noClientTimeout (a managed plan) lets a call outlive the per-call client timer; without it the same call times out", async () => {
    const srv = await serve(OK_REPLY, { delayMs: 400 });
    const env = setup(srv.url, { scouting_candidates: CANDIDATES });
    await registerFiles(env, 1);
    const fieldset = parseFieldset(JSON.parse(readFileSync(env.fields, "utf-8")) as unknown);
    const run = async (jobId: string, noClientTimeout: boolean): Promise<{ filesOk: number; filesFailed: number }> => {
      const reg = openRegistry({ path: env.db });
      try {
        return await runScoutJob(
          reg,
          {
            jobId,
            fieldset,
            pricing: { input_per_m_usd: 0, output_per_m_usd: 0, context_window: 3072 },
            model: MODEL,
            apiKey: "",
            freeOnly: false,
            apiUrl: `${srv.url}/v1/chat/completions`,
            sourceRoot: env.tree,
            smokeTest: false,
            maxRetries: 0,
            perCallTimeoutMs: 100,
            noClientTimeout,
          },
          leasedFetch,
        );
      } finally {
        reg.close();
      }
    };
    expect(await run("job-no-timer", true)).toMatchObject({ filesOk: 1, filesFailed: 0 });
    // The control: the same slow call with the client timer is aborted, so the assertion above can fail.
    expect(await run("job-timer", false)).toMatchObject({ filesOk: 0, filesFailed: 1 });
  });

  it("a file exactly at the input cap is sent, one byte over is skipped, and its retry still fits the calibrated share", async () => {
    // The first reply of each file is not JSON (repair would complete a bare "{}"), so the file is retried with the
    // longest kind of message.
    const srv = await serve((body) => {
      const user = (body.messages as Array<{ role: string; content: string }>)[1]!.content;
      return user.includes("PREVIOUS RESPONSE FAILED VALIDATION") ? OK_REPLY() : "not json";
    });
    const env = setup(srv.url, { scouting_candidates: CANDIDATES, structured_output: { off: true, on: true, array40: true } });
    const compiled = compileFieldset(parseFieldset(JSON.parse(readFileSync(env.fields, "utf-8")) as unknown));
    const budget = { tokens: 2048, charsPerToken: 4 };
    const cap = inputCapBytes(compiled, budget, true, "a.ts");
    expect(inputCapBytes(compiled, budget, true, "b.ts")).toBe(cap);
    writeFileSync(join(env.tree, "a.ts"), "a".repeat(cap), "utf-8");
    writeFileSync(join(env.tree, "b.ts"), "b".repeat(cap + 1), "utf-8");
    const reg = await runMassScoutCli(["register", "--db", env.db, "--root", env.tree]);
    expect(reg.exitCode, reg.stderr).toBe(0);
    const r = await runMassScoutCli(scoutArgs(env, "job-cap"), { mainRoot: env.work });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toContain("files_ok=1");
    expect(r.stdout).toContain("files_skipped_too_big=1");
    expect(r.stdout).toContain("retries=1");
    expect(srv.seen).toHaveLength(2);
    const retry = srv.seen[1]!;
    const msgs = retry.body.messages as Array<{ role: string; content: string }>;
    expect(msgs[1]!.content).toContain("PREVIOUS RESPONSE FAILED VALIDATION");
    const inputBytes = msgs.reduce((n, m) => n + Buffer.byteLength(m.content, "utf-8"), 0);
    expect(inputBytes).toBeLessThanOrEqual(budget.tokens * budget.charsPerToken);
  });

  it("an unmanaged Locals profile sends the base id the server lists, as Phase C and the broker do for a thinking-off body", async () => {
    const srv = await serve(OK_REPLY, { models: ["locals/m", "locals/m-thinking"] });
    const env = setup(srv.url, { scouting_candidates: CANDIDATES }, { api: "locals-local", model: "locals/m-thinking" });
    await registerFiles(env, 2);
    const r = await runMassScoutCli(scoutArgs(env, "job-locals"), { mainRoot: env.work });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(srv.seen.map((s) => s.body.model)).toEqual(["locals/m", "locals/m"]);
  });
});
