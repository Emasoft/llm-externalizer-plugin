// Integration regression test for the launcher → server boot handoff.
//
// The bug (Claude Code error -32001): the MCP server is launched as
// `node mcp-server/launcher.mjs`, which hands off to the bundled server via
// `await import(dist/index.js)`. index.ts boots main() ONLY when it is the
// process entry point — it compares realpath(process.argv[1]) against its own
// module path (a cost-safety guard, TRDD-e82f2c49, so test-imports never boot
// the server + hit a backend). Under the launcher's dynamic import, argv[1] is
// launcher.mjs, so the guard was false, main() never ran, and the server
// answered nothing → -32001. The launcher now sets argv[1] to the index path
// before importing.
//
// EVERY existing test imports index.ts DIRECTLY, so none exercised the launcher
// handoff — 1543 tests passed while the shipped server did not boot. This test
// closes that gap by spawning the REAL launcher (real dist) and completing a
// real MCP initialize handshake — nothing mocked.

import { describe, it, expect } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const LAUNCHER = resolve(SRC_DIR, "..", "launcher.mjs");
const DIST_INDEX = resolve(SRC_DIR, "..", "dist", "index.js");

// The launcher imports the built bundle; if the suite runs without a prior
// `npm run build`, fail loudly rather than silently skipping the regression.
const distReady = existsSync(DIST_INDEX);

describe("launcher → server boot handoff (regression: -32001)", () => {
  it("the real launcher boots main() and answers an MCP initialize", async () => {
    expect(distReady, `dist/index.js missing at ${DIST_INDEX} — run \`npm run build\` first`).toBe(true);

    const child: ChildProcess = spawn(process.execPath, [LAUNCHER], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        // Deterministic auth without touching the keychain or the network.
        // initialize is answered locally — no backend call — so a dummy key
        // is sufficient to let the server's auth resolution succeed.
        OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? "sk-or-v1-test-dummy-key-for-launcher-boot-regression",
      },
    });

    try {
      const response = await new Promise<Record<string, unknown>>((resolvePromise, rejectPromise) => {
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
          rejectPromise(
            new Error(
              `no initialize response within 30s — the server did not boot (the -32001 regression).\n` +
                `stderr so far:\n${stderr}`,
            ),
          );
        }, 30_000);

        child.stdout!.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
          // MCP stdio transport writes newline-delimited JSON-RPC to stdout.
          for (const line of stdout.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("{")) continue;
            try {
              const msg = JSON.parse(trimmed) as Record<string, unknown>;
              if (msg.id === 1 && msg.result) {
                clearTimeout(timer);
                resolvePromise(msg);
                return;
              }
            } catch {
              // partial line — wait for more data
            }
          }
        });
        child.stderr!.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.on("error", (err) => {
          clearTimeout(timer);
          rejectPromise(err);
        });
        child.on("exit", (code) => {
          clearTimeout(timer);
          rejectPromise(new Error(`launcher exited (code ${code}) before answering initialize.\nstderr:\n${stderr}`));
        });

        const initialize = {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: { roots: {}, sampling: {} },
            clientInfo: { name: "launcher-boot-regression", version: "1" },
          },
        };
        child.stdin!.write(JSON.stringify(initialize) + "\n");
      });

      const result = response.result as Record<string, unknown>;
      const serverInfo = result.serverInfo as Record<string, unknown>;
      expect(serverInfo.name).toBe("llm-externalizer");
    } finally {
      // No orphan process: the snapshot after this test must match before.
      child.kill("SIGKILL");
    }
  });
});
