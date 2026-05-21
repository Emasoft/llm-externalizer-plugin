// Unit tests for preflight_benchmark.ts. All paths exercised with a mock
// LLM call function — no real network. Cache writes happen in a tmp dir.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  cachePathFor,
  profileHash,
  runPreflightBenchmark,
  validatePreflightResponse,
} from "./preflight_benchmark.js";

describe("preflight_benchmark", () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "cluster-preflight-"));
  });
  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  describe("profileHash", () => {
    it("is deterministic for the same fingerprint", () => {
      expect(profileHash("a")).toBe(profileHash("a"));
    });
    it("differs across distinct fingerprints", () => {
      expect(profileHash("a")).not.toBe(profileHash("b"));
    });
    it("returns 16-char hex", () => {
      expect(profileHash("anything")).toMatch(/^[0-9a-f]{16}$/);
    });
  });

  describe("validatePreflightResponse", () => {
    it("passes on a correct response", () => {
      const r = validatePreflightResponse(JSON.stringify({ groups: [[1, 2], [3]] }));
      expect(r.pass).toBe(true);
    });

    it("fails on non-JSON output", () => {
      const r = validatePreflightResponse("not even close");
      expect(r.pass).toBe(false);
      if (!r.pass) expect(r.reason).toMatch(/not valid JSON/);
    });

    it("fails when groups is missing", () => {
      const r = validatePreflightResponse(JSON.stringify({}));
      expect(r.pass).toBe(false);
    });

    it("fails on a wrong shape (groups not array of arrays of numbers)", () => {
      const r = validatePreflightResponse(JSON.stringify({ groups: [[1, "two"]] }));
      expect(r.pass).toBe(false);
    });

    it("fails when an id is duplicated across groups", () => {
      const r = validatePreflightResponse(JSON.stringify({ groups: [[1, 2], [2, 3]] }));
      expect(r.pass).toBe(false);
      if (!r.pass) expect(r.reason).toMatch(/exactly once/);
    });

    it("fails when an id is missing", () => {
      const r = validatePreflightResponse(JSON.stringify({ groups: [[1, 2]] }));
      expect(r.pass).toBe(false);
    });

    it("fails when an extra id appears", () => {
      const r = validatePreflightResponse(JSON.stringify({ groups: [[1, 2], [3], [4]] }));
      expect(r.pass).toBe(false);
    });
  });

  describe("runPreflightBenchmark", () => {
    it("PASS path: writes a fresh cache entry and returns cached=false", async () => {
      const llmCall = async (): Promise<string> =>
        JSON.stringify({ groups: [[1, 2], [3]] });
      const r = await runPreflightBenchmark("prof-A", llmCall, {
        cacheDir,
        today: "2026-05-22",
      });
      expect(r.pass).toBe(true);
      if (r.pass) {
        expect(r.cached).toBe(false);
        expect(existsSync(r.cache_path)).toBe(true);
      }
    });

    it("FAIL path: caches a failure with reason + raw_response", async () => {
      const llmCall = async (): Promise<string> => "totally not json";
      const r = await runPreflightBenchmark("prof-B", llmCall, {
        cacheDir,
        today: "2026-05-22",
      });
      expect(r.pass).toBe(false);
      if (!r.pass) {
        expect(r.cached).toBe(false);
        expect(r.reason).toMatch(/not valid JSON/);
      }
      // Read the cache record back and verify.
      const ph = profileHash("prof-B");
      const cp = cachePathFor(ph, "2026-05-22", cacheDir);
      const rec = JSON.parse(readFileSync(cp, "utf8"));
      expect(rec.pass).toBe(false);
      expect(rec.raw_response).toBe("totally not json");
    });

    it("second same-day call hits the cache (no llmCall invoked)", async () => {
      const seen: string[] = [];
      const llmPass = async (p: string): Promise<string> => {
        seen.push(p);
        return JSON.stringify({ groups: [[1, 2], [3]] });
      };
      await runPreflightBenchmark("prof-C", llmPass, { cacheDir, today: "2026-05-22" });
      expect(seen).toHaveLength(1);

      const r2 = await runPreflightBenchmark("prof-C", llmPass, { cacheDir, today: "2026-05-22" });
      expect(seen).toHaveLength(1); // NO new LLM call
      expect(r2.pass).toBe(true);
      if (r2.pass) expect(r2.cached).toBe(true);
    });

    it("opts.force bypasses the cache", async () => {
      let calls = 0;
      const llmPass = async (): Promise<string> => {
        calls++;
        return JSON.stringify({ groups: [[1, 2], [3]] });
      };
      await runPreflightBenchmark("prof-D", llmPass, { cacheDir, today: "2026-05-22" });
      await runPreflightBenchmark("prof-D", llmPass, {
        cacheDir,
        today: "2026-05-22",
        force: true,
      });
      expect(calls).toBe(2);
    });

    it("different date invalidates cache (next-day re-test)", async () => {
      let calls = 0;
      const llmPass = async (): Promise<string> => {
        calls++;
        return JSON.stringify({ groups: [[1, 2], [3]] });
      };
      await runPreflightBenchmark("prof-E", llmPass, { cacheDir, today: "2026-05-22" });
      await runPreflightBenchmark("prof-E", llmPass, { cacheDir, today: "2026-05-23" });
      expect(calls).toBe(2);
    });

    it("LLM-call exception is captured as FAIL with reason", async () => {
      const llmThrow = async (): Promise<string> => {
        throw new Error("connection refused");
      };
      const r = await runPreflightBenchmark("prof-F", llmThrow, {
        cacheDir,
        today: "2026-05-22",
      });
      expect(r.pass).toBe(false);
      if (!r.pass) expect(r.reason).toMatch(/connection refused/);
    });

    it("corrupt cache file is treated as cache miss", async () => {
      const ph = profileHash("prof-G");
      const cp = cachePathFor(ph, "2026-05-22", cacheDir);
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(cp, "{not valid json", "utf8");
      let calls = 0;
      const llmPass = async (): Promise<string> => {
        calls++;
        return JSON.stringify({ groups: [[1, 2], [3]] });
      };
      const r = await runPreflightBenchmark("prof-G", llmPass, {
        cacheDir,
        today: "2026-05-22",
      });
      expect(calls).toBe(1);
      expect(r.pass).toBe(true);
    });
  });
});
