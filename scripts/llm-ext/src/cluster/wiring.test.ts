/**
 * Wire-up tests — verify `cluster_synonyms` is reachable through BOTH new
 * surfaces (the third, the MCP tool, already shipped), all calling the SAME
 * `runClusterSynonyms` core (src/cluster/cluster_synonyms_main.ts):
 *
 *   • the CLI subcommand adapter (src/cluster/cli.ts → runClusterSynonymsCli),
 *     which parses the rich `--input-json` payload and forwards a validated
 *     ClusterSynonymsInvocation to runClusterSynonyms with injectable hooks
 *     (the mock rawLlmCall stands in for the server's chatCompletionWithRetry),
 *     and
 *   • the top-level `llm-externalizer cluster-synonyms` verb, which reuses the
 *     same parseClusterSynonymsInput parser to build the tool arguments.
 *
 * These exercise the JSON-encoded argv plumbing (cluster_synonyms input is a
 * nested object, mirroring the security_scan `--input-json` convention) and
 * the deterministic rawLlmCall injection. No network call is made — the live
 * smoke for cluster_synonyms lives in cluster_synonyms_main.test.ts and the
 * Python-sidecar embeddings tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runClusterSynonymsCli,
  parseClusterSynonymsInput,
} from "./cli";
import * as core from "./cluster_synonyms_main";
import type { Phase1RawLlmCall } from "./phase1_batch";

let tmp = "";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cs-wire-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function writeJsonl(rows: unknown[]): string {
  const path = join(tmp, "in.jsonl");
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return path;
}

function items(n: number): { id: string; sentence: string }[] {
  return Array.from({ length: n }, (_, i) => ({ id: `item-${i}`, sentence: `sentence ${i}` }));
}

/** LLM mock: every item is a singleton group (no merges, deterministic). */
function singletonLlm(): Phase1RawLlmCall {
  return async (prompt) => {
    const ids = (prompt.match(/^\d+\. id=\d+/gm) ?? []).length;
    return JSON.stringify({ groups: Array.from({ length: ids }, (_, i) => [i + 1]) });
  };
}

describe("cluster wiring — input parser", () => {
  it("parses --input-json into a validated invocation", () => {
    /** the rich nested object rides --input-json, mirroring security_scan. */
    const policyPath = join(tmp, "policy.json");
    const input = JSON.stringify({
      input_file: "/abs/in.jsonl",
      output_dir: "/abs/out",
      embeddings_file: "/abs/emb.f32",
      policy_file: policyPath,
      resume_from: "/abs/checkpoint.sqlite",
    });
    const parsed = parseClusterSynonymsInput(["--input-json", input]);
    expect("error" in parsed).toBe(false);
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.input_file).toBe("/abs/in.jsonl");
    expect(parsed.output_dir).toBe("/abs/out");
    expect(parsed.embeddings_file).toBe("/abs/emb.f32");
    expect(parsed.policy_file).toBe(policyPath);
    expect(parsed.resume_from).toBe("/abs/checkpoint.sqlite");
  });

  it("--output-dir flag overrides output_dir embedded in the JSON", () => {
    /** an explicit flag wins (belt-and-braces with the MCP dispatch). */
    const input = JSON.stringify({
      input_file: "/abs/in.jsonl",
      output_dir: "/should/be/overridden",
    });
    const parsed = parseClusterSynonymsInput([
      "--input-json",
      input,
      "--output-dir",
      "/winning/out",
    ]);
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.output_dir).toBe("/winning/out");
  });

  it("rejects missing --input-json with a usage error", () => {
    /** the CLI adapter requires the JSON-encoded input. */
    const parsed = parseClusterSynonymsInput([]);
    expect("error" in parsed).toBe(true);
    if ("error" in parsed) expect(parsed.error).toMatch(/input-json/);
  });

  it("rejects malformed --input-json", () => {
    /** invalid JSON is a clean usage error, not a crash. */
    const parsed = parseClusterSynonymsInput(["--input-json", "{not json"]);
    expect("error" in parsed).toBe(true);
    if ("error" in parsed) expect(parsed.error).toMatch(/not valid JSON/);
  });

  it("rejects input missing required input_file / output_dir", () => {
    /** the two mandatory fields are validated before reaching the core. */
    const parsed = parseClusterSynonymsInput([
      "--input-json",
      JSON.stringify({ input_file: "/abs/in.jsonl" }),
    ]);
    expect("error" in parsed).toBe(true);
    if ("error" in parsed) expect(parsed.error).toMatch(/output_dir/);
  });
});

describe("cluster wiring — CLI adapter dispatches to runClusterSynonyms core", () => {
  it("runClusterSynonymsCli parses --input-json and calls runClusterSynonyms", async () => {
    /** the CLI path forwards a validated invocation to the SAME core. */
    const inputPath = writeJsonl(items(4));
    const outDir = join(tmp, "out");
    const policyPath = join(tmp, "policy.json");
    writeFileSync(policyPath, JSON.stringify({ compute_embeddings: false, batch_size: 5 }));
    const input = JSON.stringify({
      input_file: inputPath,
      output_dir: outDir,
      policy_file: policyPath,
    });

    const spy = vi.spyOn(core, "runClusterSynonyms");
    const res = await runClusterSynonymsCli(["--input-json", input], {
      rawLlmCall: singletonLlm(),
      profileName: "test-profile",
    });

    expect(res.exitCode).toBe(0);
    // The core was invoked exactly once with the parsed invocation.
    expect(spy).toHaveBeenCalledTimes(1);
    const callArg = spy.mock.calls[0]![0];
    expect(callArg.input_file).toBe(inputPath);
    expect(callArg.output_dir).toBe(outDir);
    // The counter line + the four output paths are reported on stdout.
    expect(res.stdout).toMatch(/items_in:\s+4/);
    expect(res.stdout).toMatch(/clusters_out:\s+4/);
    expect(res.stdout).toContain(outDir);
    // Real output files were produced by the core (proves end-to-end wiring).
    expect(existsSync(join(outDir, "clusters.jsonl"))).toBe(true);
    expect(existsSync(join(outDir, "clusters_summary.json"))).toBe(true);
    expect(existsSync(join(outDir, "stats.json"))).toBe(true);
  });

  it("--output-dir flag wins over the JSON output_dir end-to-end", async () => {
    /** the override reaches the core, so files land in the flag's dir. */
    const inputPath = writeJsonl(items(2));
    const winningDir = join(tmp, "winning");
    const policyPath = join(tmp, "policy.json");
    writeFileSync(policyPath, JSON.stringify({ compute_embeddings: false, batch_size: 5 }));
    const input = JSON.stringify({
      input_file: inputPath,
      output_dir: join(tmp, "ignored"),
      policy_file: policyPath,
    });

    const res = await runClusterSynonymsCli(
      ["--input-json", input, "--output-dir", winningDir],
      { rawLlmCall: singletonLlm(), profileName: "test-profile" },
    );
    expect(res.exitCode).toBe(0);
    expect(existsSync(join(winningDir, "clusters.jsonl"))).toBe(true);
    expect(existsSync(join(tmp, "ignored", "clusters.jsonl"))).toBe(false);
    // The summary records the two input items.
    const summary = JSON.parse(readFileSync(join(winningDir, "clusters_summary.json"), "utf-8"));
    expect(summary.items_in).toBe(2);
  });

  it("missing --input-json returns exitCode 1 with a usage error", async () => {
    /** no JSON ⇒ clean non-zero exit, no core invocation. */
    const spy = vi.spyOn(core, "runClusterSynonyms");
    const res = await runClusterSynonymsCli([], { rawLlmCall: singletonLlm() });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toMatch(/input-json/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("malformed --input-json returns exitCode 1, never crashes", async () => {
    /** invalid JSON is a usage error, not a thrown exception. */
    const res = await runClusterSynonymsCli(["--input-json", "{bad"], {
      rawLlmCall: singletonLlm(),
    });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toMatch(/not valid JSON/);
  });

  it("a core failure (missing input file) surfaces as exitCode 1, not a throw", async () => {
    /** the adapter converts a failed ClusterSynonymsResult into a clean error. */
    const input = JSON.stringify({
      input_file: join(tmp, "does-not-exist.jsonl"),
      output_dir: join(tmp, "out"),
    });
    const res = await runClusterSynonymsCli(["--input-json", input], {
      rawLlmCall: singletonLlm(),
      profileName: "test-profile",
    });
    expect(res.exitCode).toBe(1);
    expect(res.stderr.length).toBeGreaterThan(0);
  });
});
