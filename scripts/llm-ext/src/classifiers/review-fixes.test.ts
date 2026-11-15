// Review of the classifier commits 3e281b35, 727b9f32, 4acc83bb (findings 2, 6, 10, 11, 12): real files under /tmp, a real local node:http server that counts requests, no mocks.
import { EventEmitter } from "node:events";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spec as findingsSpec } from "./catalog/findings.js";
import { spec as testOutputSpec } from "./catalog/test-output.js";
import type { AnySpec } from "./catalog/spec.js";
import { assembleFileInput, readFileSources } from "./input-args.js";
import { InputError } from "./l2/input-error.js";
import { buildReceipt, lifetimeOrReason, renderReceipt } from "./receipt.js";
import { runDecisionArgv, type ArgvDeps } from "./run-decision.js";
import { readAllFrom } from "../cli/read-all.js";
import { formatHistoryLine, getHistoryPath, getLifetimeSidecarPath, readHistory } from "../usage-history.js";

let tmp: string;
let server: Server;
let base: string;
let hits: string[];
beforeAll(async () => {
  server = createServer((req, res) => { hits.push(`${req.method} ${req.url}`); res.writeHead(404); res.end("{}"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  tmp = mkdtempSync(join("/tmp", "llm-ext-rvw-"));
  hits = [];
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const put = (rel: string, content: string | Buffer): string => {
  const p = join(tmp, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  return p;
};
// WHY (TRDD-S3QEQBYV): stdin is a real ended stream holding one byte, read through the production reader readAllFrom, one stream per call because an ended stream is read once; neverRead asserts it stayed unread after the outcome assertions.
// Measured: no test here reads stdin. The runFindings calls go through run-decision.ts:546-552, which turns a read error into exit 1, while the assembleFileInput calls get the reader directly; the outcome assertions pin each result (the direct assembleFileInput /etc/hosts case pins only the InputError class; the runFindings /etc/hosts cases also pin the message), so the guard adds detection of a read that leaves the outcome unchanged (an eager or unawaited read), mutation-checked for runFindings only.
const unreadStdin = (): { stdin: PassThrough; read: () => Promise<Buffer> } => {
  const stdin = new PassThrough();
  stdin.end("x");
  return { stdin, read: () => readAllFrom(stdin) };
};
const neverRead = (stdin: PassThrough): void => { expect(stdin.readableDidRead).toBe(false); };
const findings = findingsSpec as AnySpec;
const testOutput = testOutputSpec as AnySpec;

async function runFindings(jsonPath: string) {
  const out: string[] = [];
  const err: string[] = [];
  const { stdin, read } = unreadStdin();
  const deps: ArgvDeps = {
    settings: { active: "c", active_classifier: undefined, profiles: {} },
    // The only way out of the process: a real GET/POST to the local server, which counts it.
    fetch: (url, init) => fetch(url.replace("https://openrouter.ai", base), init),
    catalogOptions: { path: join(tmp, "catalog.json") },
    sigint: new EventEmitter(),
    readFile: (p) => readFileSync(p, "utf8"),
    readStdin: read,
    stdout: (t) => out.push(t),
    stderr: (l) => err.push(l),
  };
  const code = await runDecisionArgv(findings, ["--input", jsonPath], deps);
  return { code, out: out.join("\n"), err: err.join("\n"), errLines: err, stdin };
}
const findingsJson = (file: string): string => put("in.json", JSON.stringify({ findings: [{ file }] }));

describe("major 1: the files a findings JSON names stay inside the current directory and the JSON directory", () => {
  it.each([
    ["an absolute path outside every allowed directory", () => "/etc/hosts", "outside the directories a findings file may name"],
    ["a ../ path that climbs out of every allowed directory", () => `${"../".repeat(30)}etc/hosts`, "outside the directories a findings file may name"],
    ["a symlink beside the JSON that points outside", () => { const l = join(tmp, "link-out"); symlinkSync("/etc/hosts", l); return l; }, "outside the directories a findings file may name"],
    ["a symlink beside the JSON that points inside", () => { const target = put("real.txt", "x = 1\n"); const l = join(tmp, "link-in"); symlinkSync(target, l); return l; }, "Symlink rejected"],
  ])("%s is refused with a clear message and nothing is sent", async (_name, makePath, message) => {
    const r = await runFindings(findingsJson(makePath()));
    expect(r.code).toBe(1);
    expect(r.err).toContain(message);
    expect(r.out).toBe("");
    expect(hits).toEqual([]);
    neverRead(r.stdin);
  });
  it("a file under a fake HOME, outside the cwd and the JSON directory, is refused and names the allowed directories", async () => {
    const home = mkdtempSync(join("/tmp", "llm-ext-rvw-home-"));
    const prevHome = process.env.HOME;
    try {
      process.env.HOME = home;
      mkdirSync(join(home, ".config/gh"), { recursive: true });
      const secretish = join(home, ".config/gh/hosts.yml");
      writeFileSync(secretish, "github.com:\n  user: someone\n");
      const r = await runFindings(findingsJson(secretish));
      expect(r.code).toBe(1);
      expect(r.err).toContain("outside the directories a findings file may name");
      expect(r.err).toContain(realpathSync(tmp));
      expect(r.err).toContain(realpathSync(process.cwd()));
      expect(hits).toEqual([]);
      neverRead(r.stdin);
    } finally {
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
  it("every file read is listed once on stderr, in first-seen order", async () => {
    const a = put("a.ts", "export const a = 1;\n");
    const b = put("b.ts", "export const b = 2;\n");
    const j = put("in.json", JSON.stringify({ findings: [{ file: a }, { file: b }, { file: a }] }));
    const r = await runFindings(j);
    const idx = r.errLines.map((l, i) => (l.startsWith("read ") ? i : -1)).filter((i) => i >= 0);
    expect(idx.map((i) => r.errLines[i])).toEqual([`read ${a} (20 bytes) to send`, `read ${b} (20 bytes) to send`]);
    neverRead(r.stdin);
  });
  it("a path with an escape sequence and a control byte is printed without them", async () => {
    const odd = put("c\u001b[31mol\u0007or.ts", "export const c = 3;\n");
    const r = await runFindings(put("in.json", JSON.stringify({ findings: [{ file: odd }] })));
    const line = r.errLines.find((l) => l.startsWith("read "))!;
    expect(line).toBeDefined();
    // eslint-disable-next-line no-control-regex
    expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(line).toBe(`read ${join(tmp, "color.ts")} (20 bytes) to send`);
    neverRead(r.stdin);
  });
});

describe("finding 10: the files a findings JSON names have a total cap", () => {
  it("refuses when the texts together are over the cap", async () => {
    const a = put("a.txt", "12345678\n");
    const b = put("b.txt", "12345678\n");
    const input = { findings: [{ file: a }, { file: b }] };
    await expect(readFileSources(findings, input, [tmp], { totalCapBytes: 12 })).rejects.toThrow(/total over 12 bytes \(stopped at .*b\.txt\)/);
    await expect(readFileSources(findings, input, [tmp], { totalCapBytes: 18 })).resolves.toBeDefined();
  });
});

describe("finding 11: test-output keeps the tail of an over-size log", () => {
  const log = Array.from({ length: 200 }, (_, i) => `line ${String(i).padStart(3, "0")}`).join("\n") + "\n";
  it("keeps whole last lines within --max-bytes and says how many bytes were dropped", async () => {
    const p = put("big.log", log);
    const notes: string[] = [];
    const { stdin, read } = unreadStdin();
    const got = await assembleFileInput(testOutput, [p], { maxBytes: 100 }, read, (l) => notes.push(l));
    const text = (got.input as { log: string }).log;
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(100);
    expect(text.trimEnd().endsWith("line 199")).toBe(true);
    expect(text.startsWith("line ")).toBe(true);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/over 100 bytes; kept the last \d+ bytes and dropped \d+ bytes from the start/);
    const kept = Number(/kept the last (\d+)/.exec(notes[0]!)![1]);
    const dropped = Number(/dropped (\d+)/.exec(notes[0]!)![1]);
    expect(kept + dropped).toBe(Buffer.byteLength(log));
    expect(got.warnings).toContain(notes[0]);
    neverRead(stdin);
  });
  it("a log within the cap is read whole with no note", async () => {
    const p = put("small.log", "a\nb\n");
    const notes: string[] = [];
    const { stdin, read } = unreadStdin();
    const got = await assembleFileInput(testOutput, [p], { maxBytes: 100 }, read, (l) => notes.push(l));
    expect((got.input as { log: string }).log).toBe("a\nb\n");
    expect(notes).toEqual([]);
    neverRead(stdin);
  });
  it("an over-size secret file or a path outside the allowed roots is still refused, not tailed", async () => {
    const env = unreadStdin();
    const outside = unreadStdin();
    await expect(assembleFileInput(testOutput, [put(".env", log)], { maxBytes: 100 }, env.read)).rejects.toThrow(/secret/);
    await expect(assembleFileInput(testOutput, ["/etc/hosts"], { maxBytes: 10 }, outside.read)).rejects.toThrow(InputError);
    neverRead(env.stdin);
    neverRead(outside.stdin);
  });
  it("without --max-bytes a log over the hard cap is refused with a hint, never silently cut", async () => {
    const p = put("huge.log", "x\n");
    truncateSync(p, 101 * 1024 * 1024);
    expect(statSync(p).size).toBeGreaterThan(100 * 1024 * 1024);
    const { stdin, read } = unreadStdin();
    await expect(assembleFileInput(testOutput, [p], {}, read)).rejects.toThrow(/is over 100 MB; pass --max-bytes N to keep the last N bytes/);
    neverRead(stdin);
  });
  it("a window that starts exactly on a line start keeps the whole window", async () => {
    const { stdin, read } = unreadStdin();
    const got = await assembleFileInput(testOutput, [put("edge.log", "aaaa\nbbbb\ncccc\n")], { maxBytes: 10 }, read);
    expect((got.input as { log: string }).log).toBe("bbbb\ncccc\n");
    expect(got.warnings.join("\n")).toMatch(/dropped 5 bytes/);
    neverRead(stdin);
  });
  it("a window that starts inside a line drops that partial line", async () => {
    const { stdin, read } = unreadStdin();
    const got = await assembleFileInput(testOutput, [put("mid.log", "aaaa\nbbbb\ncccc\n")], { maxBytes: 8 }, read);
    expect((got.input as { log: string }).log).toBe("cccc\n");
    expect(got.warnings.join("\n")).toMatch(/dropped 10 bytes/);
    neverRead(stdin);
  });
  it("a last line alone over the cap is refused, with or without a newline in the window", async () => {
    const one = unreadStdin();
    const nonl = unreadStdin();
    await expect(assembleFileInput(testOutput, [put("one.log", `${"x".repeat(50)}\n`)], { maxBytes: 10 }, one.read)).rejects.toThrow(/the last line alone is over 10 bytes/);
    await expect(assembleFileInput(testOutput, [put("nonl.log", "x".repeat(50))], { maxBytes: 10 }, nonl.read)).rejects.toThrow(/the last line alone is over 10 bytes/);
    neverRead(one.stdin);
    neverRead(nonl.stdin);
  });
});

describe("finding 6: the receipt never throws or prints NaN for a cost it does not have", () => {
  const base = { elapsedMs: 1000, states: ["x".repeat(8000)], shown: "", usage: { input_tokens: 5 }, snapshots: ["m"], inputWarnings: [] };
  it("prints `cost unknown` for an absent or non-finite cost", () => {
    for (const usd of [undefined as unknown as number, Number.NaN]) {
      const line = renderReceipt(buildReceipt({ ...base, cost: { usd, cost_estimated: false } }), null);
      expect(line).toContain("cost unknown");
      expect(line).not.toContain("NaN");
    }
  });
  it("leaves out the not-read clause when nothing was spared", () => {
    const line = renderReceipt(buildReceipt({ ...base, shown: "x".repeat(8000), cost: { usd: 0.0001, cost_estimated: false } }), null);
    expect(line).not.toContain("not read");
    expect(line).toContain("$0.0001");
  });
});

describe("major 2: the lifetime totals are a running sum over the whole history", () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.LLM_EXT_CONFIG_DIR;
    process.env.LLM_EXT_CONFIG_DIR = tmp;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.LLM_EXT_CONFIG_DIR; else process.env.LLM_EXT_CONFIG_DIR = prev;
  });
  const line = (n: number): string => formatHistoryLine({ timestamp: "2026-10-31T09:08:07+0100", project: "/p", tool: "classify", params: "", ok: true, durationMs: 5, costUsd: 0.5, opId: `op-${String(n).padStart(8, "0")}`, endpoint: "decisions", inputTokens: 10 });
  const totals = () => {
    const t = lifetimeOrReason();
    if (typeof t === "string") throw new Error(t);
    return t;
  };
  const sidecar = (): { offset: number; lines: number } => JSON.parse(readFileSync(getLifetimeSidecarPath(), "utf8")) as { offset: number; lines: number };

  it("equals a full count on a history bigger than the 1 MiB read chunk, and the sidecar offset is the file size", () => {
    const total = Math.ceil((3 * 1024 * 1024) / (line(0).length + 1));
    writeFileSync(getHistoryPath(), "");
    for (let n = 0; n < total; n += 5000) appendFileSync(getHistoryPath(), Array.from({ length: Math.min(5000, total - n) }, (_, k) => line(n + k)).join("\n") + "\n");
    const size = statSync(getHistoryPath()).size;
    expect(size).toBeGreaterThan(2 * 1024 * 1024);
    const t = totals();
    expect(t.requests).toBe(total);
    expect(t.runs).toBe(total);
    expect(t.inputTokens).toBe(total * 10);
    expect(t.costUsd).toBeCloseTo(total * 0.5, 3);
    expect(sidecar().offset).toBe(size);
  });
  it("a second call reads only the appended bytes", () => {
    writeFileSync(getHistoryPath(), [line(1), line(2), line(3)].join("\n") + "\n");
    expect(totals().requests).toBe(3);
    const consumed = sidecar().offset;
    // Damage the consumed second line without changing the size or the first bytes: a re-read from 0 would hit it and give a reason string; an incremental read never looks at it again.
    writeFileSync(getHistoryPath(), [line(1), "x".repeat(line(2).length), line(3)].join("\n") + "\n");
    appendFileSync(getHistoryPath(), line(4) + "\n");
    expect(totals().requests).toBe(4);
    expect(sidecar().offset).toBe(consumed + line(4).length + 1);
    expect(sidecar().offset).toBe(statSync(getHistoryPath()).size);
  });
  it("a history shorter than the stored offset is recounted from 0", () => {
    writeFileSync(getHistoryPath(), [line(1), line(2), line(3)].join("\n") + "\n");
    expect(totals().requests).toBe(3);
// The same first line, so only the size tells this file from the one the sidecar counted.
    writeFileSync(getHistoryPath(), line(1) + "\n");
    expect(totals().requests).toBe(1);
  });
  it("a replaced history of the same or larger size is recounted from 0", () => {
    writeFileSync(getHistoryPath(), [line(1), line(2)].join("\n") + "\n");
    expect(totals().requests).toBe(2);
    writeFileSync(getHistoryPath(), [line(7), line(8), line(9)].join("\n") + "\n");
    expect(totals().requests).toBe(3);
  });
  const lineAt = (n: number, timestamp: string): string => line(n).replace("2026-10-31T09:08:07+0100", timestamp);
  const recent = (): Record<string, number> => (JSON.parse(readFileSync(getLifetimeSidecarPath(), "utf8")) as { recent: Record<string, number> }).recent;
  it("run ids last seen over 24 hours before the newest entry are pruned, and the runs count keeps them", () => {
    writeFileSync(getHistoryPath(), [lineAt(1, "2026-10-01T09:00:00+0100"), lineAt(2, "2026-10-31T09:00:00+0100"), lineAt(3, "2026-10-31T09:05:00+0100")].join("\n") + "\n");
    const t = totals();
    expect(t.runs).toBe(3);
    expect(Object.keys(recent()).sort()).toEqual(["op-00000002", "op-00000003"]);
  });
  it("a run whose lines straddle two reads is counted once", () => {
    writeFileSync(getHistoryPath(), [lineAt(5, "2026-10-31T09:00:00+0100")].join("\n") + "\n");
    expect(totals().runs).toBe(1);
    appendFileSync(getHistoryPath(), [lineAt(5, "2026-10-31T09:00:30+0100"), lineAt(6, "2026-10-31T09:01:00+0100")].join("\n") + "\n");
    const t = totals();
    expect(t.requests).toBe(3);
    expect(t.runs).toBe(2);
  });
  it("a trailing line without its newline is counted only after it is completed", () => {
    const third = line(3);
    writeFileSync(getHistoryPath(), [line(1), line(2)].join("\n") + "\n" + third.slice(0, 30));
    expect(totals().requests).toBe(2);
    expect(sidecar().offset).toBe((line(1).length + 1) + (line(2).length + 1));
    appendFileSync(getHistoryPath(), third.slice(30) + "\n");
    expect(totals().requests).toBe(3);
  });
  it("a line that does not parse gives the same reason readHistory gave and is not skipped", () => {
    writeFileSync(getHistoryPath(), [line(1), "garbage", line(3)].join("\n") + "\n");
    const t = lifetimeOrReason();
    expect(typeof t).toBe("string");
    expect(t as string).toMatch(/^history\.log line 2: not a history line/);
    expect(() => readHistory()).toThrow(/^history\.log line 2: not a history line/);
  });
});
