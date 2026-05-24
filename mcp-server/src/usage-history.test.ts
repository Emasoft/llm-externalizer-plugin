/**
 * Unit tests for the global usage-history logger (usage-history.ts).
 *
 * Coverage maps to TRDD-44256ba2 §4, adapted to the live-amended design:
 *   - per-WEB-REQUEST granularity (one line per recordRequest, no summing),
 *   - a trailing OP-ID column shared by every request of one invocation.
 *
 * Every test points LLM_EXT_CONFIG_DIR at a throwaway tmp dir so the real
 * ~/.llm-externalizer/history.log is never touched.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync, chmodSync, realpathSync } from "node:fs";
import { join } from "node:path";

import {
  ctxStore,
  recordRequest,
  withUsageContext,
  summarizeParams,
  formatDuration,
  formatCost,
  localIsoTimestamp,
  formatHistoryLine,
  getHistoryPath,
  newOpId,
  type UsageContext,
} from "./usage-history";

let prevConfigDir: string | undefined;
let tmp: string;

beforeEach(() => {
  prevConfigDir = process.env.LLM_EXT_CONFIG_DIR;
  // mkdtemp under /tmp specifically: getConfigDir() only permits paths under
  // $HOME or /tmp (→ /private/tmp on macOS). os.tmpdir() resolves to
  // /var/folders/... on macOS, which the guard rejects — so use /tmp directly.
  tmp = mkdtempSync(join("/tmp", "llm-ext-history-"));
  process.env.LLM_EXT_CONFIG_DIR = tmp;
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
  else process.env.LLM_EXT_CONFIG_DIR = prevConfigDir;
  try {
    // Restore perms in case a test made the dir read-only, then clean up.
    chmodSync(tmp, 0o755);
  } catch {
    /* best effort */
  }
  rmSync(tmp, { recursive: true, force: true });
});

/** Read all non-empty history lines written so far. */
function readLines(): string[] {
  const p = getHistoryPath();
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8").split("\n").filter((l) => l.length > 0);
}

const SEVEN_FIELD_RE =
  /^(?<ts>\S+) - (?<project>.+?) - (?<tool>.+) - (?<status>SUCCESS|FAIL) - (?<dur>[\d.]+(?:ms|s)) - \$(?<cost>\d+\.\d{6}) - (?<op>op-[0-9a-f]{8})$/;

describe("localIsoTimestamp", () => {
  it("produces a sortable local ISO timestamp with a ±HHMM offset", () => {
    // fixed local instant; only assert the SHAPE (offset depends on the host TZ).
    const ts = localIsoTimestamp(new Date(2026, 4, 24, 9, 8, 7));
    expect(ts).toMatch(/^2026-05-24T09:08:07[+-]\d{4}$/);
  });
});

describe("formatDuration", () => {
  it("renders sub-second durations as <N>ms", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(42)).toBe("42ms");
    expect(formatDuration(999)).toBe("999ms");
  });
  it("renders >=1000ms durations as <N.N>s", () => {
    expect(formatDuration(1000)).toBe("1.0s");
    expect(formatDuration(1500)).toBe("1.5s");
    expect(formatDuration(12_340)).toBe("12.3s");
  });
  it("clamps negatives to 0ms", () => {
    expect(formatDuration(-5)).toBe("0ms");
  });
});

describe("formatCost", () => {
  it("formats USD cost with exactly 6 decimals", () => {
    expect(formatCost(0)).toBe("$0.000000");
    expect(formatCost(0.0015)).toBe("$0.001500");
    expect(formatCost(1.23456789)).toBe("$1.234568");
  });
  it("treats absent/negative/NaN cost as $0.000000", () => {
    expect(formatCost(-1)).toBe("$0.000000");
    expect(formatCost(Number.NaN)).toBe("$0.000000");
  });
});

describe("summarizeParams", () => {
  it("renders scalars inline as key=value pairs", () => {
    expect(summarizeParams({ a: 1, b: true, c: "hi" })).toBe("a=1, b=true, c=hi");
  });
  it("renders arrays compactly as [N], never dumping contents", () => {
    expect(summarizeParams({ input_files_paths: ["x", "y", "z"] })).toBe(
      "input_files_paths=[3]",
    );
  });
  it("truncates a long string value to ~80 chars and appends its length", () => {
    const long = "x".repeat(200);
    const out = summarizeParams({ instructions: long });
    expect(out.startsWith("instructions=")).toBe(true);
    // 13 (prefix) + 80 (kept) + "…(200)" — far shorter than the 200-char input.
    expect(out.length).toBeLessThan(120);
    expect(out).toContain("…(200)");
  });
  it("collapses newlines so a multi-line body cannot break the log line", () => {
    const out = summarizeParams({ code: "line1\nline2\nline3" });
    expect(out).not.toContain("\n");
    expect(out).toBe("code=line1 line2 line3");
  });
  it("redacts secrets embedded in a string value", () => {
    const out = summarizeParams({ env: "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz0123" });
    expect(out).not.toContain("sk-abcdefghijklmnopqrstuvwxyz0123");
    expect(out).toContain("REDACTED");
  });
  it("keeps nested object keys but compacts their values", () => {
    const out = summarizeParams({ opts: { temperature: 0.1, nested: { deep: 1 } } });
    expect(out).toContain("opts={");
    expect(out).toContain("temperature=0.1");
    // one level deep only — the deeper object is collapsed, not dumped.
    expect(out).toContain("nested={…}");
  });
  it("returns empty string for empty/absent args", () => {
    expect(summarizeParams({})).toBe("");
    expect(summarizeParams(undefined)).toBe("");
    expect(summarizeParams(null)).toBe("");
  });
});

describe("formatHistoryLine", () => {
  it("emits exactly 7 dash-separated fields with tool(params)", () => {
    const line = formatHistoryLine({
      timestamp: "2026-05-24T09:08:07+0200",
      project: "/work/proj",
      tool: "chat",
      params: "a=1",
      ok: true,
      durationMs: 1500,
      costUsd: 0.0015,
      opId: "op-deadbeef",
    });
    expect(line).toBe(
      "2026-05-24T09:08:07+0200 - /work/proj - chat(a=1) - SUCCESS - 1.5s - $0.001500 - op-deadbeef",
    );
  });
  it("renders tool() with empty parens when params is blank", () => {
    const line = formatHistoryLine({
      timestamp: "2026-05-24T09:08:07+0200",
      project: "/p",
      tool: "discover",
      params: "",
      ok: true,
      durationMs: 5,
      costUsd: 0,
      opId: "op-00000000",
    });
    expect(line).toContain(" - discover() - SUCCESS - 5ms - $0.000000 - op-00000000");
  });
});

describe("recordRequest — SUCCESS line shape", () => {
  it("writes exactly one well-formed 7-field SUCCESS line inside a context", () => {
    withUsageContext({ tool: "chat", params: "a=1", project: "/work/proj" }, () => {
      recordRequest({ ok: true, durationMs: 1500, costUsd: 0.0015 });
    });
    const lines = readLines();
    expect(lines).toHaveLength(1);
    const m = SEVEN_FIELD_RE.exec(lines[0]!);
    expect(m).not.toBeNull();
    expect(m!.groups!.project).toBe("/work/proj");
    expect(m!.groups!.tool).toBe("chat(a=1)");
    expect(m!.groups!.status).toBe("SUCCESS");
    expect(m!.groups!.dur).toBe("1.5s");
    expect(m!.groups!.cost).toBe("0.001500");
    expect(m!.groups!.op).toMatch(/^op-[0-9a-f]{8}$/);
  });
});

describe("recordRequest — FAIL line", () => {
  it("writes a FAIL line when the request did not succeed (line still written)", () => {
    withUsageContext({ tool: "code_task", params: "x=1", project: "/p" }, () => {
      recordRequest({ ok: false, durationMs: 250, costUsd: 0 });
    });
    const lines = readLines();
    expect(lines).toHaveLength(1);
    const m = SEVEN_FIELD_RE.exec(lines[0]!);
    expect(m).not.toBeNull();
    expect(m!.groups!.status).toBe("FAIL");
    expect(m!.groups!.dur).toBe("250ms");
    expect(m!.groups!.cost).toBe("0.000000");
  });
});

describe("recordRequest — per-request granularity (no summing)", () => {
  it("two requests in one context write TWO lines, each with its OWN cost", () => {
    withUsageContext({ tool: "scan_folder", params: "n=2", project: "/p" }, () => {
      recordRequest({ ok: true, durationMs: 100, costUsd: 0.001 });
      recordRequest({ ok: true, durationMs: 200, costUsd: 0.0005 });
    });
    const lines = readLines();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("$0.001000");
    expect(lines[1]).toContain("$0.000500");
    // NOT summed into $0.001500 on a single line.
    expect(lines.some((l) => l.includes("$0.001500"))).toBe(false);
  });

  it("a billed call writes $0.000000 when the request reports no cost", () => {
    withUsageContext({ tool: "chat", params: "", project: "/p" }, () => {
      recordRequest({ ok: true, durationMs: 10, costUsd: 0 });
    });
    expect(readLines()[0]).toContain("$0.000000");
  });
});

describe("recordRequest — OP-ID correlation", () => {
  it("two requests within ONE context share the same opId", () => {
    withUsageContext({ tool: "chat", params: "", project: "/p" }, () => {
      recordRequest({ ok: true, durationMs: 1, costUsd: 0 });
      recordRequest({ ok: true, durationMs: 2, costUsd: 0 });
    });
    const lines = readLines();
    const op0 = SEVEN_FIELD_RE.exec(lines[0]!)!.groups!.op;
    const op1 = SEVEN_FIELD_RE.exec(lines[1]!)!.groups!.op;
    expect(op0).toBe(op1);
  });

  it("a separate context gets a DIFFERENT opId", () => {
    withUsageContext({ tool: "chat", params: "", project: "/p" }, () => {
      recordRequest({ ok: true, durationMs: 1, costUsd: 0 });
    });
    withUsageContext({ tool: "chat", params: "", project: "/p" }, () => {
      recordRequest({ ok: true, durationMs: 1, costUsd: 0 });
    });
    const lines = readLines();
    const op0 = SEVEN_FIELD_RE.exec(lines[0]!)!.groups!.op;
    const op1 = SEVEN_FIELD_RE.exec(lines[1]!)!.groups!.op;
    expect(op0).not.toBe(op1);
  });
});

describe("recordRequest — concurrency (AsyncLocalStorage isolation)", () => {
  it("two overlapping contexts attribute each request to the right tool + opId", async () => {
    // Interleave two async invocations; AsyncLocalStorage must keep each
    // recordRequest bound to its own enclosing ctxStore.run.
    const runA = async (): Promise<string> => {
      return await new Promise<string>((res) => {
        ctxStore.run(makeCtx("toolA", "op-aaaaaaaa"), () => {
          setTimeout(() => {
            recordRequest({ ok: true, durationMs: 1, costUsd: 0.0001 });
            res("A");
          }, 5);
        });
      });
    };
    const runB = async (): Promise<string> => {
      return await new Promise<string>((res) => {
        ctxStore.run(makeCtx("toolB", "op-bbbbbbbb"), () => {
          setTimeout(() => {
            recordRequest({ ok: true, durationMs: 1, costUsd: 0.0002 });
            res("B");
          }, 2);
        });
      });
    };
    await Promise.all([runA(), runB()]);

    const lines = readLines();
    expect(lines).toHaveLength(2);
    const byTool = Object.fromEntries(
      lines.map((l) => {
        const m = SEVEN_FIELD_RE.exec(l)!;
        return [m.groups!.tool, m] as const;
      }),
    );
    // toolA's line carries its own cost AND its own opId — never B's.
    expect(byTool["toolA()"]!.groups!.cost).toBe("0.000100");
    expect(byTool["toolA()"]!.groups!.op).toBe("op-aaaaaaaa");
    expect(byTool["toolB()"]!.groups!.cost).toBe("0.000200");
    expect(byTool["toolB()"]!.groups!.op).toBe("op-bbbbbbbb");
  });
});

describe("recordRequest — no active context (direct call)", () => {
  it("still writes a well-formed line with a fresh opId and (direct) tool", () => {
    recordRequest({ ok: true, durationMs: 7, costUsd: 0 });
    const lines = readLines();
    expect(lines).toHaveLength(1);
    const m = SEVEN_FIELD_RE.exec(lines[0]!);
    expect(m).not.toBeNull();
    // tool defaults to "(direct)"; empty params render as empty parens.
    expect(m!.groups!.tool).toBe("(direct)()");
    expect(m!.groups!.op).toMatch(/^op-[0-9a-f]{8}$/);
  });
});

describe("config dir handling", () => {
  it("creates the config dir if missing before appending", () => {
    // Point at a not-yet-existing subdir of the tmp dir.
    const nested = join(tmp, "sub", "dir");
    process.env.LLM_EXT_CONFIG_DIR = nested;
    expect(existsSync(nested)).toBe(false);
    withUsageContext({ tool: "chat", params: "", project: "/p" }, () => {
      recordRequest({ ok: true, durationMs: 1, costUsd: 0 });
    });
    expect(existsSync(join(nested, "history.log"))).toBe(true);
  });

  it("honors LLM_EXT_CONFIG_DIR for the history path", () => {
    // getConfigDir() canonicalizes via realpathSync (e.g. /tmp → /private/tmp on
    // macOS), so compare against the realpath-resolved expectation.
    expect(getHistoryPath()).toBe(join(realpathSync(tmp), "history.log"));
  });
});

describe("write-failure is swallowed", () => {
  it("does not throw and does not affect the caller when the dir is unwritable", () => {
    // Make the config dir read-only so appendFileSync inside fails.
    chmodSync(tmp, 0o500);
    let caller = "ok";
    expect(() => {
      withUsageContext({ tool: "chat", params: "", project: "/p" }, () => {
        recordRequest({ ok: true, durationMs: 1, costUsd: 0 });
        caller = "still ran";
      });
    }).not.toThrow();
    // The caller body ran to completion despite the logging failure.
    expect(caller).toBe("still ran");
  });
});

describe("newOpId", () => {
  it("produces a unique op-<8hex> id each call", () => {
    const a = newOpId();
    const b = newOpId();
    expect(a).toMatch(/^op-[0-9a-f]{8}$/);
    expect(b).toMatch(/^op-[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
  });
});

/** Build a complete UsageContext for the concurrency test. */
function makeCtx(tool: string, opId: string): UsageContext {
  return { tool, params: "", project: "/p", opId };
}
