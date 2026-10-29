/**
 * phase-b-real.test.ts — the calibration runner on a real model, opt-in (RUN_REAL_LOCAL_MODELS=1; spec section 9,
 * D7: main-agent decision 2026-10-29). The tiny CI GGUFs cannot run Phase B: llama-server caps their slot at
 * their trained context of 128 tokens. This runs the LFM3 GGUF of the built-in local_llama profile (it must be
 * in the Hugging Face cache of HF_HOME) with a reduced harness, through the real CLI bundled from the current
 * source (dist/ may be stale), as detached processes in a temp HOME and config dir:
 *  - the runner is SIGKILLed during Phase B; the next runner's orphan sweep stops its cal server, and the
 *    resume keeps every finished trial;
 *  - a reply cut at max_tokens is rerun on a new document and then scored as a FAIL (D1): LFM3 does not finish
 *    an aggregate answer within the 2048-token thinking-off cap at 4096 prompt tokens;
 *  - Phases A, B and C pass (a cap cut never fails the model) and the runner writes a schema-2 ok record whose
 *    harness is "custom:<sha256 of the harness JSON>", which the production read path counts as missing (D4).
 * Every process it starts is stopped in afterAll, and a process snapshot confirms it.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readCalibratorState } from "../broker/protocol.js";
import { readRegistry } from "../broker/registry.js";
import { pidState, processSnapshot, stopProcessGroup } from "../local-llama-server.js";
import { calibratorLogPath } from "./runner.js";
import { readRecord, readRecordStatus, recordSchemaErrors } from "./record.js";
import { loadProgress, type Progress } from "./state.js";

const MODEL = "AtomicChat/LFM3-1.7B-Uncensored-GGUF:AD-Q6_K";
// windowCap 12352 = 4096 + 8192 + 64: the bug kind (thinking on) runs both steps at its full output cap.
const HARNESS = JSON.stringify({ windowCap: 12352, steps: [2048, 4096], mainSlots: [1, 2], scoutShares: [2048], scoutSlots: [4] });
const PKG = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REAL = process.env.RUN_REAL_LOCAL_MODELS === "1";

describe.skipIf(!REAL)("calibration on the LFM3 GGUF, reduced harness (opt-in, RUN_REAL_LOCAL_MODELS=1)", () => {
  let home = "";
  let bundleDir = "";
  let cfg = "";
  const env = (): NodeJS.ProcessEnv => {
    const e: NodeJS.ProcessEnv = { ...process.env, HOME: home, LLM_EXT_CONFIG_DIR: cfg, LLM_EXT_INSTALL_RULE: "0", LLM_EXT_CALIBRATION_HARNESS: HARNESS };
    // The model is read from HF_HOME's hub cache; llama.cpp's own cache variables would point elsewhere.
    delete e.LLAMA_CACHE;
    delete e.HF_HUB_CACHE;
    return e;
  };
  /** `llm-ext models calibrate`: queues the model and starts a detached runner, then returns (bounded at 120 s). */
  const calibrate = async (): Promise<string> =>
    new Promise((resolve, reject) => {
      const c = spawn(process.execPath, [join(bundleDir, "llm-ext.mjs"), "models", "calibrate", "--model", MODEL], { env: env(), stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      c.stdout.on("data", (d: Buffer) => (out += d.toString()));
      c.stderr.on("data", (d: Buffer) => (out += d.toString()));
      const t = setTimeout(() => c.kill("SIGKILL"), 120_000);
      c.on("exit", (code) => {
        clearTimeout(t);
        if (code === 0) resolve(out);
        else reject(new Error(`models calibrate exited ${String(code)}: ${out}`));
      });
    });
  const progress = (): Progress => loadProgress(cfg, "llama", MODEL, null);
  const log = (): string => (existsSync(calibratorLogPath(cfg)) ? readFileSync(calibratorLogPath(cfg), "utf8") : "");
  /** Poll `cond` every 2 s, at most `ms`; fails the test with the runner log when it never holds. */
  const until = async (what: string, ms: number, cond: () => boolean): Promise<void> => {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}; runner log:\n${log().slice(-3000)}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  };

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "llm-ext-phase-b-real-"));
    cfg = join(home, "cfg");
    bundleDir = mkdtempSync(join(PKG, "node_modules", ".cache-llm-ext-phase-b-real-"));
    await build({
      absWorkingDir: PKG,
      bundle: true,
      platform: "node",
      target: "node18",
      format: "esm",
      external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`), "better-sqlite3"],
      // The CLI bundles CommonJS code (typescript) that reads require, __filename and __dirname.
      banner: {
        js: [
          `import { createRequire as __cjsCreateRequire } from "node:module";`,
          `import { fileURLToPath as __cjsFileURLToPath } from "node:url";`,
          `import { dirname as __cjsDirname } from "node:path";`,
          "const require = __cjsCreateRequire(import.meta.url);",
          "const __filename = __cjsFileURLToPath(import.meta.url);",
          "const __dirname = __cjsDirname(__filename);",
          "",
        ].join("\n"),
      },
      entryPoints: [join(PKG, "src", "cli", "main.ts")],
      outfile: join(bundleDir, "llm-ext.mjs"),
      logLevel: "error",
    });
  }, 300_000);

  afterAll(async () => {
    // Stop whatever this test started: the runner, then every server in this config dir's registries.
    const st = cfg ? readCalibratorState(cfg) : null;
    if (st && pidState(st.pid) === "alive") process.kill(st.pid, "SIGKILL");
    for (const engine of ["llama", "locals"] as const) for (const e of cfg ? readRegistry(cfg, engine) : []) if (pidState(e.pid) === "alive") await stopProcessGroup(e.pgid);
    const left = (await processSnapshot()).filter((p) => p.command.includes(cfg) || p.command.includes(bundleDir));
    if (bundleDir) rmSync(bundleDir, { recursive: true, force: true });
    if (home) rmSync(home, { recursive: true, force: true });
    expect(left.map((p) => p.command)).toEqual([]);
  }, 120_000);

  it(
    "a SIGKILL mid Phase B is swept and resumed; a cap cut is rerun, then a fail; A, B and C pass and write an ok custom-harness record",
    async () => {
      expect(await calibrate()).toMatch(/calibration runner started/);
      await until("the first Phase B trial", 20 * 60_000, () => progress().trials.some((t) => t.step.startsWith("B/fact/")));
      const a = progress().trials.find((t) => t.step === "A/summary")?.data;
      expect([true, false, "leaky"]).toContain(a?.thinking_off_mode);
      const killed = readCalibratorState(cfg);
      expect(killed).not.toBeNull();
      const before = progress().trials.filter((t) => t.step.startsWith("B/"));
      process.kill(killed!.pid, "SIGKILL");
      await until("the runner to die", 30_000, () => pidState(killed!.pid) !== "alive");
      const orphan = readRegistry(cfg, "llama").find((e) => e.role === "cal");
      expect(orphan?.ownerPid).toBe(killed!.pid);

      await calibrate();
      await until("the orphan sweep", 120_000, () => log().includes(`owner ${killed!.pid} is not a live calibration runner`));
      expect(pidState(orphan!.pid)).not.toBe("alive");
      await until("the second runner to exit", 130 * 60_000, () => (log().match(/calibration runner exiting/g) ?? []).length >= 1 && readCalibratorState(cfg) === null);

      const after = progress();
      // Resume: every trial finished before the SIGKILL is still there, unchanged.
      for (const t of before) expect(after.trials).toContainEqual(t);
      // D1: a cut reply was rerun on a new document (inconclusive, cut) and a second cut was scored as a fail.
      const cuts = after.trials.filter((t) => t.data?.cut === true);
      expect(cuts.some((t) => t.outcome === "inconclusive")).toBe(true);
      expect(cuts.some((t) => t.outcome === "fail")).toBe(true);
      // A cap cut never fails the model: all three phases passed, and the runner wrote an ok record.
      expect(after.phases).toEqual({ A: "passed", B: "passed", C: "passed" });
      expect(log()).not.toMatch(/phase [ABC] failed/);
      const rec = readRecord(cfg, "llama", MODEL);
      expect(rec).not.toBeNull();
      expect(recordSchemaErrors(rec)).toEqual([]);
      expect(rec).toMatchObject({ schema: 2, status: "ok", harness: `custom:${createHash("sha256").update(HARNESS).digest("hex")}` });
      expect(rec?.main?.slots).toBeOneOf([1, 2]);
      // D4: a reduced-harness record never makes the model usable: the production read path sees it as missing.
      expect(readRecordStatus(cfg, "llama", MODEL).state).toBe("missing");
    },
    150 * 60_000,
  );
});
