// TRDD-GBC4A4CF: stoppableSleep is the one wait every long backoff uses; a command stop must end it at once.
// Real module and real stop state; only the clock is faked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

async function freshModule(): Promise<typeof import("./command-stop.js")> {
  vi.resetModules(); // the stop flag is module state: each test gets its own
  return import("./command-stop.js");
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("stoppableSleep", () => {
  it("waits the full time when no stop arrives", async () => {
    const { stoppableSleep } = await freshModule();
    let done = false;
    void stoppableSleep(60_000).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
  });

  it("ends at once when the command is stopped mid-wait, and leaves no timer behind", async () => {
    const { stoppableSleep, stopCommand, commandStopReason } = await freshModule();
    let done = false;
    void stoppableSleep(350_000).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(done).toBe(false);
    stopCommand("--command_timeout 3 s");
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(true);
    expect(commandStopReason()).toBe("--command_timeout 3 s");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("wakes every concurrent sleeper", async () => {
    const { stoppableSleep, stopCommand } = await freshModule();
    const woke: number[] = [];
    for (const n of [1, 2, 3]) void stoppableSleep(120_000).then(() => woke.push(n));
    stopCommand("stop");
    await vi.advanceTimersByTimeAsync(0);
    expect(woke.sort()).toEqual([1, 2, 3]);
  });

  it("returns at once when the command is already stopped", async () => {
    const { stoppableSleep, stopCommand } = await freshModule();
    stopCommand("stop");
    let done = false;
    void stoppableSleep(60_000).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("stoppableSleep in a real child process", () => {
  it("holds the process open until the wait resolves, so the marker prints", async () => {
    vi.useRealTimers(); // a child needs the real clock; the fake clock above drives only this file in-process timers
    const marker = "STOPPABLE-SLEEP-DONE";
    const workDir = mkdtempSync(join(tmpdir(), "stoppable-sleep-"));
    try {
      const bundle = join(workDir, "sleep-child.mjs");
      await build({
        stdin: {
          contents: `import { stoppableSleep } from "./command-stop.ts";\nawait stoppableSleep(200);\nconsole.log("${marker}");`,
          resolveDir: dirname(fileURLToPath(import.meta.url)),
          sourcefile: "sleep-child.ts",
          loader: "ts",
        },
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node22",
        outfile: bundle,
        logLevel: "error",
      });
      const child = spawn(process.execPath, [bundle], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const code = await new Promise<number | null>((resolve) => child.on("close", (exitCode) => resolve(exitCode)));
      expect(code, stderr).toBe(0);
      expect(stdout).toContain(marker);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});