// Benchmark CLI flag defaults (P1 zero-token model pipeline).
//
// The `--qualifying-top-n 15` cap used to be PROSE: the slash command told the agent
// "if $ARGUMENTS has no --qualifying-top-n, add --qualifying-top-n 15". A spend and
// runtime bound that depends on an LLM remembering a sentence is not a bound. It is a
// code default now, and this is the test that keeps it one.

import { describe, it, expect } from "vitest";

import { parseArgs, DEFAULT_QUALIFYING_TOP_N, type CliOptions } from "./cli-args.js";

/** parseArgs skips argv[0]/argv[1] (node, script) exactly like process.argv. */
function parse(...args: string[]): CliOptions {
  return parseArgs(["node", "benchmark.js", ...args]);
}

describe("parseArgs — the spend/runtime bounds are CODE defaults", () => {
  it("caps the paid sweep at 15 candidates with NO flags at all", () => {
    expect(parse().qualifyingTopN).toBe(15);
    expect(DEFAULT_QUALIFYING_TOP_N).toBe(15);
  });

  it("lets an explicit --qualifying-top-n override the default", () => {
    expect(parse("--qualifying-top-n", "5").qualifyingTopN).toBe(5);
  });

  it("only removes the cap when the exhaustive sweep is asked for EXPLICITLY", () => {
    expect(parse("--no-qualifying-cap").qualifyingTopN).toBeNull();
  });

  it("rejects a non-positive cap instead of silently ignoring it", () => {
    expect(() => parse("--qualifying-top-n", "0")).toThrow(/positive integer/);
    expect(() => parse("--qualifying-top-n", "-3")).toThrow(/positive integer/);
  });

  it("keeps the other defaults intact", () => {
    const o = parse();
    expect(o.dryRun).toBe(false);
    expect(o.pickTopN).toBeNull();
    expect(o.minMeanF1).toBe(0.95);
    expect(o.applyFreePool).toBeNull();
    expect(o.adoptModel).toBeNull();
    expect(o.apply).toBe(false);
  });
});

describe("parseArgs — the P1 writer flags", () => {
  it("parses --apply-free-pool P", () => {
    expect(parse("--bench-free-pool", "--apply-free-pool", "freeprof").applyFreePool).toBe("freeprof");
  });

  it("parses the adoption triple", () => {
    const o = parse("--adopt", "v/new", "--adopt-into", "second_model", "--adopt-profile", "ens");
    expect(o.adoptModel).toBe("v/new");
    expect(o.adoptInto).toBe("second_model");
    expect(o.adoptProfile).toBe("ens");
  });

  it("refuses a value-taking flag with no value (a trailing flag must not be swallowed)", () => {
    expect(() => parse("--adopt", "--dry-run")).toThrow(/--adopt requires a value/);
    expect(() => parse("--apply-free-pool")).toThrow(/--apply-free-pool requires a value/);
  });

  it("rejects an unknown flag rather than ignoring it", () => {
    expect(() => parse("--totally-made-up")).toThrow(/unknown flag/);
  });
});
