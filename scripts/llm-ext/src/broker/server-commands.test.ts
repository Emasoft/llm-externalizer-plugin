/**
 * server-commands.test.ts — `models server-status` / `server-stop`, real and unmocked.
 * The fake servers are real child processes started as their own process group with
 * argv[0] "llama-server" (so they pass the registry's kill-safety identity check) and
 * recorded in a real servers-<engine>.json in a throwaway config dir. Every process
 * started is killed in afterEach.
 */

import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tmpdir } from "../test-tmp-root.js";
import { pidState } from "../local-llama-server.js";
import { TOKEN_HEADER, writeBrokerState } from "./protocol.js";
import { readRegistry, registryPath, type RegistryEntry, type ServerRole } from "./registry.js";
import { serverStatusText, serverStopText } from "./server-commands.js";

const FAKE_ARGV = ["llama-server", "-e", "setInterval(()=>{},1e9)"];

let dir = "";
let started: number[] = [];

/** A real process leading its own group, named llama-server in its argv. */
function startFake(): number {
  const child = spawn(process.execPath, FAKE_ARGV.slice(1), { argv0: FAKE_ARGV[0], detached: true, stdio: "ignore" });
  child.unref();
  started.push(child.pid as number);
  return child.pid as number;
}

function entryFor(pid: number, role: ServerRole, port: number): RegistryEntry {
  return { role, pid, pgid: pid, port, argv: FAKE_ARGV, model: `model-${role}`, ctx: 4096, ownerPid: process.pid, startedAt: new Date().toISOString() };
}

function register(entries: RegistryEntry[]): void {
  writeFileSync(registryPath(dir, "llama"), `${JSON.stringify({ entries }, null, 2)}\n`);
}

async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 50));
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "llm-ext-server-cmds-"));
  mkdirSync(dir, { recursive: true });
  started = [];
});

afterEach(() => {
  for (const pid of started) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("server-status and server-stop", () => {
  it("status says so when nothing is registered", async () => {
    const text = await serverStatusText(dir);
    expect(text).toContain("no llm-ext server is registered");
    expect(text).toContain("broker: not running");
  });

  it("status lists a registered server with its pid, port, model and liveness", async () => {
    const pid = startFake();
    await waitFor(() => pidState(pid) === "alive");
    register([entryFor(pid, "cal", 45678)]);
    const text = await serverStatusText(dir);
    expect(text).toContain(`llama cal: model 'model-cal', port 45678, pid ${pid} (alive)`);
    expect(text).toContain("ctx 4096");
    expect(text).toContain(`owner pid ${process.pid}`);
  });

  it("stop kills a registered server and removes its entry", async () => {
    const pid = startFake();
    await waitFor(() => pidState(pid) === "alive");
    register([entryFor(pid, "main", 45679)]);
    const r = await serverStopText(dir, {});
    expect(r.isError).toBe(false);
    expect(r.text).toContain(`stopped main llama-server pid ${pid}`);
    await waitFor(() => pidState(pid) === "dead");
    expect(pidState(pid)).toBe("dead");
    expect(readRegistry(dir, "llama")).toEqual([]);
  });

  it("stop leaves a live process that is not in the registry alone", async () => {
    const mine = startFake();
    const foreign = startFake();
    await waitFor(() => pidState(mine) === "alive" && pidState(foreign) === "alive");
    register([entryFor(mine, "main", 45680)]);
    await serverStopText(dir, {});
    await waitFor(() => pidState(mine) === "dead");
    expect(pidState(mine)).toBe("dead");
    expect(pidState(foreign)).toBe("alive");
  });

  it("--role cal stops only cal entries", async () => {
    const main = startFake();
    const cal = startFake();
    await waitFor(() => pidState(main) === "alive" && pidState(cal) === "alive");
    register([entryFor(main, "main", 45681), entryFor(cal, "cal", 45682)]);
    const r = await serverStopText(dir, { role: "cal" });
    expect(r.text).toContain(`stopped cal llama-server pid ${cal}`);
    await waitFor(() => pidState(cal) === "dead");
    expect(pidState(cal)).toBe("dead");
    expect(pidState(main)).toBe("alive");
    expect(readRegistry(dir, "llama").map((e) => e.role)).toEqual(["main"]);
  });

  it("--engine locals leaves llama entries alone", async () => {
    const pid = startFake();
    await waitFor(() => pidState(pid) === "alive");
    register([entryFor(pid, "main", 45683)]);
    const r = await serverStopText(dir, { engine: "locals" });
    expect(r.text).toContain("nothing was stopped");
    expect(pidState(pid)).toBe("alive");
    expect(readRegistry(dir, "llama")).toHaveLength(1);
  });

  /**
   * Review of 2a3ac697 (b): a real HTTP server on 127.0.0.1 answers /v1/health as this dir's broker would, with the
   * token check, so serverStopText reads the queued count over the network exactly as it does in production.
   */
  async function fakeBrokerHealth(models: Array<{ engine: string; model: string; queued: number; running: number; held: number }>): Promise<Server> {
    const token = "t".repeat(32);
    const srv = createServer((req, res) => {
      const ok = req.url === "/v1/health" && req.headers[TOKEN_HEADER] === token;
      res.writeHead(ok ? 200 : 403, { "content-type": "application/json" });
      res.end(JSON.stringify(ok ? { pid: process.pid, version: "t", draining: false, queued: 0, running: 0, held: 0, models } : { error: "no" }));
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    writeBrokerState(dir, { pid: process.pid, port: (srv.address() as AddressInfo).port, token, version: "t", startedAt: new Date().toISOString() });
    return srv;
  }

  it("stopping a main server with work queued for its model says the broker will start it again; no queued work, no line", async () => {
    const pid = startFake();
    const other = startFake();
    await waitFor(() => pidState(pid) === "alive" && pidState(other) === "alive");
    register([entryFor(pid, "main", 45684), { ...entryFor(other, "main", 45685), model: "model-idle" }]);
    const srv = await fakeBrokerHealth([{ engine: "llama", model: "model-main", queued: 3, running: 1, held: 0 }]);
    try {
      const r = await serverStopText(dir, {});
      expect(r.isError).toBe(false);
      const lines = r.text.split("\n");
      expect(lines.filter((l) => l.includes("will start the server again"))).toEqual(["the broker still has 3 queued request(s) for 'model-main': it will start the server again to serve them"]);
      expect(r.text).toContain(`stopped main llama-server pid ${other}`);
    } finally {
      await new Promise((r) => srv.close(() => r(undefined)));
    }
  });
});