/**
 * TRDD-PN84WC1L — a scan whose files fail at the provider (scripted 503 / 429) must report
 * `FAILED (n of m):` with each file and return isError, so the CLI exits 1.
 *
 * Real path end to end: dispatchCallTool("scan_folder") -> runScanFolder -> the real
 * processFileCheck -> ensembleStreaming -> chatCompletionWithRetry -> a REAL local node:http
 * server. No injected per-file seam, no stubbed fetch. The one non-real part is the clock:
 * the retry backoffs (about 30 s per file, hardcoded in provider/http.ts) are not configurable,
 * so only setTimeout is faked and pumped fast by a real interval. Date and I/O stay real.
 * TRDD-RPLLP8CF — the token and cost totals tests (scan_folder and batch_check) reuse the same scripted server.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const TMP_BASE = "/tmp";
let server: Server | undefined;
let pump: ReturnType<typeof setInterval> | undefined;
let cfgDir: string;
let homeDir: string;
let outDir: string;
let srcDir: string;
const savedEnv: Record<string, string | undefined> = {};

function setEnv(key: string, value: string) {
  savedEnv[key] = process.env[key];
  process.env[key] = value;
}

beforeEach(() => {
  cfgDir = mkdtempSync(join(TMP_BASE, "llmext-scanfail-cfg-"));
  homeDir = mkdtempSync(join(TMP_BASE, "llmext-scanfail-home-"));
  outDir = mkdtempSync(join(TMP_BASE, "llmext-scanfail-out-"));
  mkdirSync(outDir, { recursive: true });
  // The scan root must sit under an allowed root (cwd); /tmp is rejected by sanitizeInputPath.
  srcDir = mkdtempSync(join(process.cwd(), "scan-fail-src-"));
  setEnv("HOME", homeDir);
  setEnv("LLM_EXT_CONFIG_DIR", cfgDir);
  setEnv("LLM_EXT_OUTPUT_DIR", outDir);
  setEnv("LLM_EXT_INSTALL_RULE", "0");
  setEnv("LLM_EXT_DISABLE_AUTO_RECONCILE", "1");
});

afterEach(() => {
  if (pump) clearInterval(pump);
  pump = undefined;
  vi.useRealTimers();
  server?.closeAllConnections();
  server?.close();
  server = undefined;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const d of [cfgDir, homeDir, outDir, srcDir]) rmSync(d, { recursive: true, force: true });
});

/** Answers by the file name found in the request: ok -> 200, e503 -> 503, e429 -> 429. */
async function startScriptedServer(): Promise<string> {
  server = createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end("{}");
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf-8");
      if (body.includes("e503")) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Service Unavailable", code: 503 } }));
      } else if (body.includes("emid")) {
        // Mid-stream provider error: partial text, then a chunk whose finish_reason is "error".
        // A non-streaming request gets the same outcome as one JSON body.
        const partial = "Partial review: the first function looks fine but";
        if ((JSON.parse(body) as { stream?: boolean }).stream === true) {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.write(`data: ${JSON.stringify({ id: "c2", model: "model-a", choices: [{ index: 0, delta: { role: "assistant", content: partial }, finish_reason: null }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ id: "c2", model: "model-a", choices: [{ index: 0, delta: {}, finish_reason: "error" }] })}\n\n`);
          res.end("data: [DONE]\n\n");
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: "c2", model: "model-a", choices: [{ index: 0, message: { role: "assistant", content: partial }, finish_reason: "error" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
        }
      } else if (body.includes("e429")) {
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Rate limit exceeded", code: 429 } }));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "c1",
            model: "model-a",
            choices: [{ index: 0, message: { role: "assistant", content: "Reviewed: no defects found in this file." }, finish_reason: "stop" }],
            // A priced reply (file name carries "priced") adds a cost; a zcost0 reply imitates a free OpenRouter reply, which
            // carries usage.cost 0 (measured 2026-11-04 on nvidia/nemotron-3.5-lightning:free); the others send none, like a local server.
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20, ...(body.includes("priced") ? { cost: 0.0123 } : body.includes("zcost0") ? { cost: 0 } : {}) },
          }),
        );
      }
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const addr = server!.address();
  if (typeof addr !== "object" || addr === null) throw new Error("server address unavailable");
  return `http://127.0.0.1:${addr.port}`;
}

describe("scan_folder with provider failures, real send path (TRDD-PN84WC1L)", () => {
  it("lists the 503 and 429 files under FAILED (n of m) and returns isError", async () => {
    const url = await startScriptedServer();
    writeFileSync(
      join(cfgDir, "settings.yaml"),
      ["active: local-a", "profiles:", "  local-a:", "    mode: local", "    api: generic-local", "    model: model-a", `    url: ${url}`, "    timeout: 600", ""].join("\n"),
    );
    for (const n of ["ok1.ts", "ok2.ts", "e503.ts", "e429.ts"]) {
      writeFileSync(join(srcDir, n), `export const ${n.replace(".ts", "")}_marker = 1; // ${n}\n`);
    }

    vi.resetModules();
    const mod = await import("./index.js");
    await mod.boot();

    // WHY: backoffs are hardcoded (about 30 s per file); fake only setTimeout and advance it
    // 100x faster than real time with a real interval, so the test takes seconds.
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    pump = setInterval(() => void vi.advanceTimersByTimeAsync(500), 5);

    const result = await mod.dispatchCallTool("scan_folder", {
      folder_path: srcDir,
      instructions: "Review each file for defects.",
      extensions: [".ts"],
      use_gitignore: false,
      scan_secrets: false,
      answer_mode: 0,
      output_dir: outDir,
    });
    const text = result.content.map((c) => c.text).join("\n");

    expect(result.isError).toBe(true);
    expect(text).toMatch(/FAILED \(\d+ of 4\):/);
    // Two files succeeded: the summary carries their report paths, so the CLI must print it on stdout.
    expect(result.partial).toBe(true);
    expect(text).toContain("e503.ts");
    expect(text).toContain("e429.ts");
  }, 120_000);
});

describe("scan_folder with a mid-stream provider error, real send path (TRDD-PN84WC1L part C)", () => {
  it("does not save the partial text of a finish_reason=error reply as a good report", async () => {
    const url = await startScriptedServer();
    writeFileSync(
      join(cfgDir, "settings.yaml"),
      ["active: local-a", "profiles:", "  local-a:", "    mode: local", "    api: generic-local", "    model: model-a", `    url: ${url}`, "    timeout: 600", ""].join("\n"),
    );
    for (const n of ["ok1.ts", "emid.ts"]) {
      writeFileSync(join(srcDir, n), `export const ${n.replace(".ts", "")}_marker = 1; // ${n}\n`);
    }

    vi.resetModules();
    const mod = await import("./index.js");
    await mod.boot();
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    pump = setInterval(() => void vi.advanceTimersByTimeAsync(500), 5);

    const result = await mod.dispatchCallTool("scan_folder", {
      folder_path: srcDir,
      instructions: "Review each file for defects.",
      extensions: [".ts"],
      use_gitignore: false,
      scan_secrets: false,
      answer_mode: 0,
      output_dir: outDir,
    });
    const text = result.content.map((c) => c.text).join("\n");

    expect(text).toMatch(/FAILED \(1 of 2\):/);
    expect(text).toContain("emid.ts");
    expect(result.isError).toBe(true);
    expect(result.partial).toBe(true);
    const reports = readdirSync(outDir, { recursive: true }).map(String).filter((f) => f.endsWith(".md"));
    for (const f of reports) expect(readFileSync(join(outDir, f), "utf-8")).not.toContain("Partial review");
  }, 120_000);
});

/** Starts the scripted server, points settings.yaml at it, writes one file per name into srcDir and boots a fresh module. */
async function bootWithFiles(names: string[]) {
  const url = await startScriptedServer();
  writeFileSync(
    join(cfgDir, "settings.yaml"),
    ["active: local-a", "profiles:", "  local-a:", "    mode: local", "    api: generic-local", "    model: model-a", `    url: ${url}`, "    timeout: 600", ""].join("\n"),
  );
  for (const n of names) writeFileSync(join(srcDir, n), `export const ${n.replace(".ts", "")}_marker = 1; // ${n}\n`);
  vi.resetModules();
  const mod = await import("./index.js");
  await mod.boot();
  return mod;
}

async function runTotals(names: string[]): Promise<string> {
  const mod = await bootWithFiles(names);
  const result = await mod.dispatchCallTool("scan_folder", {
    folder_path: srcDir,
    instructions: "Review each file for defects.",
    extensions: [".ts"],
    use_gitignore: false,
    scan_secrets: false,
    answer_mode: 0,
    output_dir: outDir,
  });
  return result.content.map((c) => c.text).join("\n");
}

describe("scan_folder token and cost totals, real send path (TRDD-RPLLP8CF)", () => {
  it("sums the usage blocks of every file and prints the summed cost when every reply carried one", async () => {
    const text = await runTotals(["priced1.ts", "priced2.ts"]);
    expect(text).toMatch(/SCAN COMPLETE — 2 processed, 0 failed, 0 skipped \(2 files found\) — Usage: 20 tokens in, 20 tokens out, cost \$0\.0246/);
  }, 60_000);

  it("prints the cost as unknown, never $0, when the provider sent no cost", async () => {
    const text = await runTotals(["plain1.ts", "plain2.ts"]);
    expect(text).toMatch(/SCAN COMPLETE — 2 processed.* — Usage: 20 tokens in, 20 tokens out, cost unknown/);
    expect(text).not.toContain("$0");
  }, 60_000);

  it("prints a reported cost of 0 as $0.0000, not unknown", async () => {
    // WHY: a free OpenRouter reply carries usage.cost 0; 0 is a reported cost, so it must print $0.0000 and never fall into the "unknown" branch.
    const text = await runTotals(["zcost0a.ts", "zcost0b.ts"]);
    expect(text).toMatch(/SCAN COMPLETE — 2 processed, 0 failed, 0 skipped \(2 files found\) — Usage: 20 tokens in, 20 tokens out, cost \$0\.0000(?!\d)/);
  }, 60_000);

  it("counts the tokens of a file whose finish_reason=error reply was rejected, so the totals cover every file that reported usage", async () => {
    // WHY: the rejected reply was billed too; before, only successful files were summed (10 in, 10 out here instead of 20, 20).
    const text = await runTotals(["plain1.ts", "emid.ts"]);
    expect(text).toMatch(/SCAN COMPLETE — 1 processed, 1 failed.* — Usage: 20 tokens in, 20 tokens out, cost unknown/);
  }, 120_000);
});

describe("batch_check token and cost totals, real send path (TRDD-RPLLP8CF)", () => {
  it("prints the summed usage and cost on the mode-0 summary line", async () => {
    const mod = await bootWithFiles(["priced1.ts", "priced2.ts"]);
    const result = await mod.dispatchCallTool("batch_check", {
      input_files_paths: [join(srcDir, "priced1.ts"), join(srcDir, "priced2.ts")],
      instructions: "Review each file for defects.",
      answer_mode: 0,
      scan_secrets: false,
      output_dir: outDir,
    });
    const text = result.content.map((c) => c.text).join("\n");
    expect(result.isError).toBeFalsy();
    // WHY: the full mode-0 prefix (succeeded, failed, skipped, total) pins the mode-0 summary; the merged-report form
    // ("N succeeded (M total)") would not match, so the test fails if that branch runs instead.
    expect(text).toMatch(/BATCH CHECK COMPLETE — 2 succeeded, 0 failed, 0 skipped \(2 total\) — Usage: 20 tokens in, 20 tokens out, cost \$0\.0246/);
  }, 60_000);
});
