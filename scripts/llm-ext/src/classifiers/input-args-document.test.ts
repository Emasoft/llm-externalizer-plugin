// IN-06 (TRDD-17FAR6HF): `classify test-output FILE|-` takes its log from a file or stdin, and `classify findings` reads the files its JSON names into `sources`. Real files under /tmp (sanitizeInputPath allows only cwd, HOME and /tmp); no network is reached by any test here.
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readAllFrom } from "../cli/read-all.js";
import { spec as findingsSpec } from "./catalog/findings.js";
import { spec as reviewSpec } from "./catalog/review.js";
import { spec as testOutputSpec } from "./catalog/test-output.js";
import { classifyCliUsage, type AnySpec } from "./catalog/spec.js";
import { assembleFileInput, readFileSources as readFileSourcesIn } from "./input-args.js";
import { runDecisionArgv, type ArgvDeps } from "./run-decision.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join("/tmp", "llm-ext-in06-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  // WHY last and from a copy: the cleanup above must run even when this fails, and a failure must not leak streams into the next test.
  for (const s of unreadStreams.splice(0)) expect(s.readableDidRead).toBe(false);
});

const put = (rel: string, content: string | Buffer): string => {
  const p = join(tmp, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  return p;
};
// WHY real streams (TRDD-S3QEQBYV, sites A5, A7 and A8): stdin is read by the production reader readAllFrom over a real PassThrough, so no stdin double is left in this file.
// Data sites: stdinBytes builds a fresh ENDED stream inside the closure on every call, because an ended stream can be read once; nothing is asserted on it.
// Never-called sites: unreadStdin makes one ENDED stream holding a byte per call (never shared, never at describe scope) and registers it; afterEach asserts readableDidRead === false after the test body, so a read that leaves the outcome unchanged also fails. The registry is module-level, so this relies on tests running one at a time (no it.concurrent).
// Measured with a stderr marker in each old double (positive control: one run() call and one direct assembleFileInput call on `-` with the throwing double both printed the marker): no test here reads stdin through the old noStdin, and each of the six old data doubles was called exactly once (two through run(), four through direct assembleFileInput calls). Calls through run() go through the catch returns at run-decision.ts:531, :543 and :550, which turn a read error into exit 1; direct assembleFileInput calls get the reader without that catch.
const stdinBytes = (data: string | Buffer) => async (): Promise<Buffer> => { const s = new PassThrough(); s.end(data); return readAllFrom(s); };
const unreadStreams: PassThrough[] = [];
const unreadStdin = (): (() => Promise<Buffer>) => { const s = new PassThrough(); s.end("x"); unreadStreams.push(s); return () => readAllFrom(s); };
const toSpec = testOutputSpec as AnySpec;
// WHY a wrapper: a findings JSON may name files only inside the directories the caller passes (round 2, major 1); these tests keep their files under tmp.
const readFileSources = (s: AnySpec, i: unknown) => readFileSourcesIn(s, i, [tmp]);

function run(spec: AnySpec, argv: string[], stdin: () => Promise<Buffer> = unreadStdin()) {
  const out: string[] = [];
  const err: string[] = [];
  const deps: ArgvDeps = {
    settings: { active: "c", active_classifier: undefined, profiles: {} },
    fetch: async () => { throw new Error("network must not be reached"); },
    catalogOptions: { path: join(tmp, "catalog.json") },
    sigint: new EventEmitter(),
    readFile: (p) => readFileSync(p, "utf8"),
    readStdin: stdin,
    stdout: (t) => out.push(t),
    stderr: (l) => err.push(l),
  };
  return runDecisionArgv(spec, argv, deps).then((code) => ({ code, out, err }));
}


// IN-05 (TRDD-G168KDE1): `classify review --claims FILE` (or `-` for stdin) fills `claims`, one claim per non-empty line. The spec copy captures the parsed input in `prepare` (which runs after the flag overlay and the schema check) and the run then ends at the missing classifier profile, so no request is built or sent.
describe("review --claims", () => {
  const DIFF = "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n";
  const jsonInput = (over: Record<string, unknown> = {}): string => JSON.stringify({ diff: DIFF, request: "change a to 2", evidence: ["ci log: 12 passed"], ...over });
  const capture = (): { spec: AnySpec; seen: { claims: unknown }[] } => {
    const seen: { claims: unknown }[] = [];
    return { seen, spec: { ...reviewSpec, prepare: async (i: { claims: unknown }) => { seen.push({ claims: i.claims }); return i; } } as unknown as AnySpec };
  };

  it("a claims file fills claims[]: one claim per non-empty line, trimmed, blank and CRLF lines skipped", async () => {
    const c = capture();
    const r = await run(c.spec, ["--input", put("in.json", jsonInput()), "--claims", put("claims.txt", "  tests pass \r\n\r\n\nno API change\n")]);
    expect(r.err.join("\n")).not.toMatch(/invalid input|claims/);
    expect(c.seen).toEqual([{ claims: [{ text: "tests pass" }, { text: "no API change" }] }]);
  });
  it("`-` reads the claims from stdin", async () => {
    const c = capture();
    await run(c.spec, ["--input", put("in.json", jsonInput()), "--claims", "-"], stdinBytes("claim from stdin\n"));
    expect(c.seen).toEqual([{ claims: [{ text: "claim from stdin" }] }]);
  });
  it("E70: without --claims the claims stay empty and the review half runs alone", async () => {
    const c = capture();
    await run(c.spec, ["--input", put("in.json", jsonInput({ evidence: undefined }))]);
    expect(c.seen).toEqual([{ claims: [] }]);
  });
  it("claims without evidence are refused by the input schema, so the flag really reached claims[]", async () => {
    const c = capture();
    const r = await run(c.spec, ["--input", put("in.json", jsonInput({ evidence: undefined })), "--claims", put("claims.txt", "a claim\n")]);
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toMatch(/claims need at least one evidence text/);
    expect(c.seen).toEqual([]);
  });
  it("a file with only blank lines is refused: the flag was given to switch the gate half on", async () => {
    const c = capture();
    const r = await run(c.spec, ["--input", put("in.json", jsonInput()), "--claims", put("claims.txt", "  \n \t\n")]);
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toMatch(/--claims|claim|empty/);
    expect(c.seen).toEqual([]);
  });
  it("a JSON input that already holds claims refuses --claims", async () => {
    const c = capture();
    const r = await run(c.spec, ["--input", put("in.json", jsonInput({ claims: [{ text: "x" }] })), "--claims", put("claims.txt", "a claim\n")]);
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toMatch(/--claims sets claims, which the JSON input already holds/);
  });
  it("`--claims -` with the JSON input also on stdin is refused: stdin can be read once", async () => {
    const c = capture();
    let reads = 0;
    const r = await run(c.spec, ["--claims", "-"], async () => { reads++; return stdinBytes(jsonInput())(); });
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toMatch(/stdin can be read once/);
    expect(reads).toBe(1);
    expect(c.seen).toEqual([]);
  });
  it("a claims file that does not exist is refused with one line, exit 1", async () => {
    const c = capture();
    const r = await run(c.spec, ["--input", put("in.json", jsonInput()), "--claims", join(tmp, "missing.txt")]);
    expect(r.code).toBe(1);
    expect(r.err).toHaveLength(1);
  });
});
describe("test-output takes its log from one file or stdin", () => {
  it("a named file is written whole into `log`, stdin is not read", async () => {
    const f = put("run.log", "ok 1\nFAIL 2\n");
    const r = await assembleFileInput(toSpec, [f], {}, unreadStdin());
    expect(r.input).toEqual({ log: "ok 1\nFAIL 2\n" });
  });

  it("`-` reads stdin once and writes it into `log`", async () => {
    const r = await assembleFileInput(toSpec, ["-"], {}, stdinBytes("from stdin\nFAIL\n"));
    expect(r.input).toEqual({ log: "from stdin\nFAIL\n" });
  });

  it("a missing file, a directory, a secret, a binary and an empty file are refused; binary and empty stdin too", async () => {
    const cases: [string, RegExp][] = [
      [join(tmp, "nope.log"), /no such file/],
      [put("creds2/id_rsa", "k"), /looks like a secret/],
      [put("creds/.env", "A=1\n"), /looks like a secret/],
      [put("b.bin", Buffer.from([0x61, 0x00, 0x62])), /is binary/],
      [put("e.log", ""), /empty input/],
    ];
    for (const [f, re] of cases) await expect(assembleFileInput(toSpec, [f], {}, unreadStdin())).rejects.toThrow(re);
    await expect(assembleFileInput(toSpec, [tmp], {}, unreadStdin())).rejects.toThrow(/is a directory/);
    await expect(assembleFileInput(toSpec, ["-"], {}, stdinBytes(Buffer.from([0x61, 0x00])))).rejects.toThrow(/stdin is binary/);
    await expect(assembleFileInput(toSpec, ["-"], {}, stdinBytes("  \n"))).rejects.toThrow(/stdin: empty input/);
  });

  it("the item options and a wrong number of words are refused; --max-bytes applies", async () => {
    const f = put("run.log", "FAIL here\n");
    await expect(assembleFileInput(toSpec, [f], { lines: true, items: "x.jsonl" }, unreadStdin())).rejects.toThrow(/--lines, --items not supported \(only --max-bytes applies\)/);
    await expect(assembleFileInput(toSpec, [], {}, unreadStdin())).rejects.toThrow(/^usage: llm-ext classify test-output <file, - for stdin>/);
    await expect(assembleFileInput(toSpec, [f, f], {}, unreadStdin())).rejects.toThrow(/^usage: /);
    // Review of 3e281b35, finding 11: a named file over --max-bytes is tailed at whole lines (the tail itself is tested in review-fixes.test.ts); here the one line is over the cap, so it is refused; stdin over the cap is refused too.
    await expect(assembleFileInput(toSpec, [f], { maxBytes: 2 }, unreadStdin())).rejects.toThrow(/the last line alone is over 2 bytes/);
    await expect(assembleFileInput(toSpec, ["-"], { maxBytes: 2 }, stdinBytes("FAIL here\n"))).rejects.toThrow(/over 2 bytes/);
    expect(classifyCliUsage(toSpec)).toBe("llm-ext classify test-output <file, - for stdin> [--max-bytes N]");
  });

  it("runDecisionArgv exits 1 with a one-line refusal for a directory and reaches no network", async () => {
    const r = await run(toSpec, [tmp]);
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toMatch(/llm-ext: .* is a directory/);
    expect(r.out).toEqual([]);
  });
});

describe("findings reads the files its JSON names into `sources`", () => {
  const fx = (files: string[]) => ({ task: "review", findings: files.map((file, k) => ({ file, line: k + 1, text: `problem ${k}` })) });
  const fs = findingsSpec as AnySpec;

  it("each distinct file is read whole once, in first-seen order", async () => {
    const a = put("a.ts", "one\ntwo\n");
    const b = put("b.ts", "three\n");
    const r = await readFileSources(fs, fx([b, a, b]));
    expect((r.input as { sources: unknown }).sources).toEqual([{ file: b, text: "three\n" }, { file: a, text: "one\ntwo\n" }]);
  });

  it("a JSON that already carries `sources` is left exactly as given and no file is read", async () => {
    const given = { ...fx([join(tmp, "never-read.ts")]), sources: [{ file: join(tmp, "never-read.ts"), text: "x" }] };
    expect((await readFileSources(fs, given)).input).toBe(given);
  });

  it("a spec without fileSources, and a malformed list, pass through for the schema to judge", async () => {
    const plain = { log: "x" };
    expect((await readFileSources(toSpec, plain)).input).toBe(plain);
    const odd = { task: "t", findings: "not a list" };
    expect((await readFileSources(fs, odd)).input).toBe(odd);
  });

  it("a named binary, secret or missing file refuses the whole run", async () => {
    await expect(readFileSources(fs, fx([join(tmp, "nope.ts")]))).rejects.toThrow(/no such file/);
    await expect(readFileSources(fs, fx([put("k/.env", "A=1\n")]))).rejects.toThrow(/looks like a secret/);
    await expect(readFileSources(fs, fx([put("b.bin", Buffer.from([0x61, 0x00]))]))).rejects.toThrow(/is binary/);
    await expect(readFileSources(fs, fx([put("e.ts", "")]))).rejects.toThrow(/empty input/);
    await expect(readFileSources(fs, fx([tmp]))).rejects.toThrow(/is a directory/);
  });

  it("runDecisionArgv --input with a missing file exits 1 naming it, before any network", async () => {
    const input = put("in.json", JSON.stringify(fx([join(tmp, "nope.ts")])));
    const r = await run(fs, ["--input", input]);
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toMatch(/no such file: .*nope\.ts/);
  });
});
