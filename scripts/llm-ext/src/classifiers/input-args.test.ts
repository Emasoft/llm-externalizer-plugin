// IN-01 (design note EVORI1LK): file inputs of filter, rank and find through runDecisionArgv/assembleFileInput. Real temp directories and real `git init` repos under /tmp (sanitizeInputPath allows only cwd, HOME and /tmp); the only double is the GlobalFetch seam.
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Profile } from "../config.js";
import { classifyArgv } from "../cli/launcher.js";
import { spec as checkSpec } from "./catalog/check.js";
import { spec as filterSpec } from "./catalog/filter.js";
import { spec as findSpec } from "./catalog/find.js";
import { spec as labelSpec } from "./catalog/label.js";
import { spec as rankSpec } from "./catalog/rank.js";
import type { AnySpec } from "./catalog/spec.js";
import { assembleFileInput } from "./input-args.js";
import { INPUT_FLAGS } from "./shared-flags.js";
import { replayFixture, type RecordedReply } from "./l0/test-fetch.js";
import type { GlobalFetch } from "./l0/transport.js";
import { runDecisionArgv, type ArgvDeps } from "./run-decision.js";
import { classifyTools } from "../tools/definitions.js";

import { spec as verifySpec } from "./catalog/verify.js";

const KEY = "sk-or-v1-IN01SECRETKEYVALUE0123456789abcdef";
const fx = (dir: string, n: string): RecordedReply => JSON.parse(readFileSync(new URL(`./__fixtures__/${dir}/${n}.json`, import.meta.url), "utf8")) as RecordedReply;

let tmp: string;
let prevKey: string | undefined;
let prevCfg: string | undefined;
beforeEach(() => {
  tmp = mkdtempSync(join("/tmp", "llm-ext-in01-"));
  prevKey = process.env.IN01_TEST_KEY;
  prevCfg = process.env.LLM_EXT_CONFIG_DIR;
  process.env.IN01_TEST_KEY = KEY;
  process.env.LLM_EXT_CONFIG_DIR = tmp;
});
afterEach(() => {
  if (prevKey === undefined) delete process.env.IN01_TEST_KEY; else process.env.IN01_TEST_KEY = prevKey;
  if (prevCfg === undefined) delete process.env.LLM_EXT_CONFIG_DIR; else process.env.LLM_EXT_CONFIG_DIR = prevCfg;
  rmSync(tmp, { recursive: true, force: true });
});

const put = (rel: string, content: string | Buffer): string => {
  const p = join(tmp, "work", rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  return p;
};
const work = (): string => join(tmp, "work");
const git = (...args: string[]): void => { execFileSync("git", args, { cwd: work(), stdio: "ignore" }); };
const noStdin = async (): Promise<Buffer> => { throw new Error("stdin must not be read"); };

// The real P-01 noul reply re-labeled to the keys of the request, as run-decision.test.ts does.
function noulReply(questions: Record<string, unknown>): Response {
  const rec = fx("p01", "dec-noul");
  const body = JSON.parse(rec.body) as { answers: Record<string, { noul: number }> };
  const real = body.answers.is_bug!;
  body.answers = Object.fromEntries(Object.keys(questions).map((k) => [k, { ...real }]));
  return replayFixture({ ...rec, body: JSON.stringify(body) });
}
function serve(): { fetch: GlobalFetch; questions: Record<string, unknown>[] } {
  const questions: Record<string, unknown>[] = [];
  const fetch: GlobalFetch = async (url, init) => {
    if (url.includes("output_modalities=decisions")) return replayFixture(fx("p02", "models-decisions"));
    if (url.endsWith("/endpoints")) return replayFixture(fx("p02", "target-endpoints"));
    const q = (JSON.parse(String(init.body)) as { questions: Record<string, unknown> }).questions;
    questions.push(q);
    return noulReply(q);
  };
  return { fetch, questions };
}
function run(spec: AnySpec, argv: string[], fetch: GlobalFetch = async () => { throw new Error("network must not be reached"); }, stdin: () => Promise<Buffer> = noStdin) {
  const out: string[] = [];
  const err: string[] = [];
  const deps: ArgvDeps = {
    settings: { active: "c", active_classifier: "c", profiles: { c: { "profile-type": "classifier", api: "openrouter-remote", model: "typesafe/jev-1.13", api_key: "$IN01_TEST_KEY", max_attempts: 1, timeout_ms: 5000, concurrency: 2 } as unknown as Profile } },
    fetch,
    catalogOptions: { path: join(tmp, "catalog.json") },
    sigint: new EventEmitter(),
    readFile: (p) => readFileSync(p, "utf8"),
    readStdin: stdin,
    stdout: (t) => out.push(t),
    stderr: (l) => err.push(l),
  };
  return runDecisionArgv(spec, argv, deps).then((code) => ({ code, out, err }));
}
const baseNames = (items: { id: string }[]): string[] => items.map((i) => i.id.slice(work().length + 1)).sort();

describe("assembleFileInput over real files", () => {
  it("a directory in a real git repo: tracked and untracked files, not the ignored one (E119); ids are paths; positionals fill the spec fields", async () => {
    put(".gitignore", "ignored.txt\n");
    put("a.txt", "alpha\n");
    put("sub/b.txt", "beta\n");
    put("ignored.txt", "never sent\n");
    git("init", "-q");
    git("add", "a.txt");
    const r = await assembleFileInput(filterSpec as AnySpec, ["Does it fail?", work()], {}, noStdin);
    const input = r.input as { question: string; items: { id: string; text: string }[] };
    expect(input.question).toBe("Does it fail?");
    expect(baseNames(input.items)).toEqual([".gitignore", "a.txt", "sub/b.txt"]);
    expect(input.items.find((i) => i.id.endsWith("a.txt"))!.text).toBe("alpha\n");
  });

  it("outside git a walk skips build and dot directories (E120); a secret found while walking is listed as skipped", async () => {
    put("keep.txt", "keep\n");
    put("node_modules/x.txt", "dep\n");
    put(".hidden/y.txt", "hid\n");
    put(".env", "TOKEN=1\n");
    const r = await assembleFileInput(filterSpec as AnySpec, ["q", work()], {}, noStdin);
    expect(baseNames((r.input as { items: { id: string }[] }).items)).toEqual(["keep.txt"]);
    expect(r.warnings).toContain(`skipped ${join(work(), ".env")}: secret-like, never sent`);
  });

  it("--lines gives ids name:N; --ext, --limit and --max-bytes reach collectInputs", async () => {
    const log = put("app.log", "one\n\nthree\n");
    put("b.md", "md\n");
    const lines = await assembleFileInput(filterSpec as AnySpec, ["q", log], { lines: true }, noStdin);
    expect((lines.input as { items: { id: string }[] }).items.map((i) => i.id)).toEqual([`${log}:1`, `${log}:3`]);
    const ext = await assembleFileInput(filterSpec as AnySpec, ["q", work()], { ext: "md" }, noStdin);
    expect(baseNames((ext.input as { items: { id: string }[] }).items)).toEqual(["b.md"]);
    await expect(assembleFileInput(filterSpec as AnySpec, ["q", work()], { limit: 1 }, noStdin)).rejects.toThrow(/more than 1 items/);
    const big = await assembleFileInput(filterSpec as AnySpec, ["q", work()], { maxBytes: 2 }, noStdin).catch((e: Error) => e);
    expect(big).toBeInstanceOf(Error);
    expect((big as Error).message).toMatch(/^nothing to filter: 2 inputs skipped \(.*over 2 bytes/);
  });

  it("stdin is read only for `-` and `--items -`: one item `stdin`; a JSONL items file follows E127", async () => {
    const r = await assembleFileInput(filterSpec as AnySpec, ["q", "-"], {}, async () => Buffer.from("from stdin\n"));
    expect((r.input as { items: unknown[] }).items).toEqual([{ id: "stdin", text: "from stdin\n" }]);
    const jl = put("items.jsonl", '{"id":"x","text":"first"}\nplain line\n');
    const items = await assembleFileInput(filterSpec as AnySpec, ["q"], { items: jl }, noStdin);
    expect((items.input as { items: unknown[] }).items).toEqual([{ id: "x", text: "first" }, { id: "2", text: "plain line" }]);
    const viaStdin = await assembleFileInput(filterSpec as AnySpec, ["q"], { items: "-" }, async () => Buffer.from('{"id":"s","text":"t"}\n'));
    expect((viaStdin.input as { items: unknown[] }).items).toEqual([{ id: "s", text: "t" }]);
    const bad = put("bad.jsonl", '{"id": \n');
    await expect(assembleFileInput(filterSpec as AnySpec, ["q"], { items: bad }, noStdin)).rejects.toThrow(/--items line 1 is not valid JSON/);
  });

  it("a glob works; below Node 22 it is refused with `pass a directory instead` (E121)", async () => {
    put("g1.txt", "one\n");
    put("g2.txt", "two\n");
    put("g3.md", "three\n");
    const r = await assembleFileInput(filterSpec as AnySpec, ["q", join(work(), "*.txt")], {}, noStdin);
    expect(baseNames((r.input as { items: { id: string }[] }).items)).toEqual(["g1.txt", "g2.txt"]);
    await expect(assembleFileInput(filterSpec as AnySpec, ["q", join(work(), "*.txt")], { nodeMajor: 20 }, noStdin)).rejects.toThrow(/pass a directory instead/);
  });

  it("a named secret, binary, empty file or directory given to --items is refused (E33, E36, E40, E41, E124)", async () => {
    const secret = put("creds/.env", "A=1\n");
    const bin = put("b.bin", Buffer.from([0x61, 0x00, 0x62]));
    const empty = put("e.txt", "");
    for (const [f, re] of [[secret, /looks like a secret/], [bin, /is binary/], [empty, /empty input/], [work(), /is a directory/]] as const) {
      await expect(assembleFileInput(filterSpec as AnySpec, ["q"], { items: f }, noStdin)).rejects.toThrow(re);
    }
  });

  it("rank and find run in files mode (candidates / items); find refuses --lines", async () => {
    const f = put("r.txt", "text\n");
    const rank = await assembleFileInput(rankSpec as AnySpec, ["query", f], {}, noStdin);
    expect(rank.input).toMatchObject({ query: "query", mode: "files", candidates: [{ id: f, text: "text\n" }] });
    const find = await assembleFileInput(findSpec as AnySpec, ["query", f], {}, noStdin);
    expect(find.input).toMatchObject({ query: "query", mode: "files", items: [{ id: f }] });
    await expect(assembleFileInput(findSpec as AnySpec, ["query", f], { lines: true }, noStdin)).rejects.toThrow(/--lines is not supported/);
  });

  it("no inputs at all: qs wording; a missing leading positional: usage", async () => {
    await expect(assembleFileInput(filterSpec as AnySpec, ["q"], {}, noStdin)).rejects.toThrow("nothing to filter: pass files, directories, globs, --items FILE, or - for stdin");
    await expect(assembleFileInput(filterSpec as AnySpec, [], { lines: true }, noStdin)).rejects.toThrow(/^usage: llm-ext classify filter "<question>"/);
  });
});

describe("runDecisionArgv file mode", () => {
  it("filter over a directory runs end to end: one text unit per file, the runner's own exit code", async () => {
    put("a.txt", "alpha\n");
    put("b.txt", "beta\n");
    const s = serve();
    const { code, out, err } = await run(filterSpec as AnySpec, ["Does it fail?", work(), "--profile", "c"], s.fetch);
    expect(err).toEqual([]);
    expect(code).toBe(0);
    expect(s.questions).toHaveLength(2);
    expect((JSON.parse(out[0]!) as { decision: { rows: unknown[] } }).decision.rows).toHaveLength(2);
  });

  it("rank over files runs end to end in files mode and still parses --top", async () => {
    put("a.txt", "alpha\n");
    const s = serve();
    const { code, err } = await run(rankSpec as AnySpec, ["query", work(), "--top", "3", "--profile", "c"], s.fetch);
    expect(err.filter((l) => !l.startsWith("llm-ext: "))).toEqual([]);
    expect(code === 0 || code === 1 || code === 4).toBe(true);
    expect(err.join("\n")).not.toMatch(/invalid input|nothing to|unknown option/);
  });

  it("skipped files are printed as warnings in the envelope", async () => {
    put("a.txt", "alpha\n");
    put(".env", "T=1\n");
    const s = serve();
    const { out } = await run(filterSpec as AnySpec, ["q", work(), "--profile", "c"], s.fetch);
    const env = JSON.parse(out[0]!) as { warnings: { message: string }[] };
    expect(env.warnings.some((w) => /^skipped .*\.env: secret-like, never sent$/.test(w.message))).toBe(true);
  });

  it("--input together with any file-mode token exits 1", async () => {
    const f = put("in.json", "{}");
    for (const extra of [["q"], ["--lines"], ["--items", f]]) {
      const { code, err } = await run(filterSpec as AnySpec, ["--input", f, ...extra]);
      expect(code).toBe(1);
      expect(err[0]).toMatch(/--input cannot be combined/);
    }
  });

  it("a spec without `cli` refuses file inputs: exit 1, no network", async () => {
    const f = put("a.txt", "x\n");
    for (const argv of [["q", f], ["--items", f], ["--lines"]]) {
      const { code, err } = await run(verifySpec as AnySpec, argv);
      expect(code).toBe(1);
      expect(err[0]).toBe("llm-ext: classify verify does not take file inputs yet; pass --input <file.json> or JSON on stdin");
    }
  });

  it("find --lines exits 1", async () => {
    const f = put("a.txt", "x\n");
    const { code, err } = await run(findSpec as AnySpec, ["q", f, "--lines"]);
    expect(code).toBe(1);
    expect(err[0]).toMatch(/--lines is not supported/);
  });

  it("invalid numeric values exit 1 naming the flag", async () => {
    const f = put("a.txt", "x\n");
    const bad = await run(filterSpec as AnySpec, ["q", f, "--limit", "abc"]);
    expect(bad.code).toBe(1);
    expect(bad.err[0]).toMatch(/--limit needs a number/);
    const zero = await run(filterSpec as AnySpec, ["q", f, "--limit", "0"]);
    expect(zero.code).toBe(1);
    expect(zero.err[0]).toMatch(/--limit must be a positive integer/);
    const cap = await run(filterSpec as AnySpec, ["q", f, "--max-bytes", "999999999999"]);
    expect(cap.code).toBe(1);
    expect(cap.err[0]).toMatch(/--max-bytes must be an integer/);
  });

  it("a token after --items is its value, never a positional; a single-dash typo is refused (unlike qs), a path starting with - is given after `--`", async () => {
    const jl = put("items.jsonl", '{"id":"i","text":"t"}\n');
    const s = serve();
    const a = await run(filterSpec as AnySpec, ["q", "--items", jl, "--profile", "c"], s.fetch);
    expect(a.err).toEqual([]);
    expect(s.questions).toHaveLength(1);
    const typo = await run(filterSpec as AnySpec, ["q", "-threshold", "0.8", work()]);
    expect(typo.code).toBe(1);
    expect(typo.err[0]).toBe("llm-ext: unknown option -threshold (did you mean --threshold?)");
    const other = await run(filterSpec as AnySpec, ["q", "-x.txt"]);
    expect(other.err[0]).toBe("llm-ext: unknown option -x.txt");
    // `--` ends the options: -x.txt is then a path (which does not exist here, proving it reached the reader).
    const ddash = await run(filterSpec as AnySpec, ["--", "q", "-x.txt"]);
    expect(ddash.err[0]).toMatch(/no such file or directory: -x\.txt/);
    const f = put("--weird.txt", "w\n");
    const rest = await assembleFileInput(filterSpec as AnySpec, ["q", f], {}, noStdin);
    expect((rest.input as { items: unknown[] }).items).toHaveLength(1);
  });

  it("plain JSON mode (--input, stdin) is unchanged", async () => {
    const f = put("in.json", JSON.stringify({ question: "q", items: [{ text: "t" }] }));
    const s = serve();
    const viaFile = await run(filterSpec as AnySpec, ["--input", f, "--profile", "c"], s.fetch);
    expect(viaFile.code).toBe(0);
    const viaStdin = await run(filterSpec as AnySpec, ["--profile", "c"], s.fetch, async () => Buffer.from(JSON.stringify({ question: "q", items: [{ text: "t" }] })));
    expect(viaStdin.code).toBe(0);
  });
});


describe("file options reach collectInputs end to end", () => {
  it("--ext ts judges only the .ts files", async () => {
    put("a.ts", "export const a = 1;\n");
    put("b.ts", "export const b = 2;\n");
    put("c.md", "# doc\n");
    const s = serve();
    const { code, err } = await run(filterSpec as AnySpec, ["q", work(), "--ext", "ts", "--profile", "c"], s.fetch);
    expect(err).toEqual([]);
    expect(code).toBe(0);
    expect(s.questions).toHaveLength(2);
  });

  it("--limit stops a run over the limit; --max-bytes skips the big file and lists it", async () => {
    put("a.txt", "one\n");
    put("b.txt", "two\n");
    const over = await run(filterSpec as AnySpec, ["q", work(), "--limit", "1"]);
    expect(over.code).toBe(1);
    expect(over.err[0]).toMatch(/more than 1 items \(--limit 1\)/);
    put("big.txt", "x".repeat(50));
    const s = serve();
    const { code, out } = await run(filterSpec as AnySpec, ["q", work(), "--max-bytes", "5", "--profile", "c"], s.fetch);
    expect(code).toBe(0);
    expect(s.questions).toHaveLength(2);
    const env = JSON.parse(out[0]!) as { warnings: { message: string }[] };
    expect(env.warnings.some((w) => /^skipped .*big\.txt: over 5 bytes$/.test(w.message))).toBe(true);
  });

  it("--follow-symlinks reads a real symlink to a file outside the walked directory; without it the link is listed as skipped", async () => {
    const target = join(tmp, "outside", "t.txt");
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "target text\n");
    put("keep.txt", "keep\n");
    symlinkSync(target, join(work(), "link.txt"));
    const plain = serve();
    const a = await run(filterSpec as AnySpec, ["q", work(), "--profile", "c"], plain.fetch);
    expect(plain.questions).toHaveLength(1);
    expect((JSON.parse(a.out[0]!) as { warnings: { message: string }[] }).warnings.some((w) => /link\.txt: symlink, never followed$/.test(w.message))).toBe(true);
    const followed = serve();
    const b = await run(filterSpec as AnySpec, ["q", work(), "--follow-symlinks", "--profile", "c"], followed.fetch);
    expect(b.err).toEqual([]);
    expect(followed.questions).toHaveLength(2);
  });

  it("`-` together with `--items -` is refused: stdin can be read once", async () => {
    const { code, err } = await run(filterSpec as AnySpec, ["q", "-", "--items", "-"], undefined, async () => Buffer.from("x\n"));
    expect(code).toBe(1);
    expect(err[0]).toMatch(/both read stdin, which can be read once/);
  });

  it("an unreadable file is a one-line refusal, not a stack (a plain system error from the reader)", async () => {
    if (process.getuid?.() === 0) return; // root reads a mode-000 file, so the error cannot be produced
    const f = put("locked.txt", "secret-free text\n");
    chmodSync(f, 0);
    try {
      const { code, err } = await run(filterSpec as AnySpec, ["q", work()]);
      expect(code).toBe(1);
      expect(err[0]).toMatch(/^llm-ext: cannot read the inputs: EACCES/);
    } finally {
      chmodSync(f, 0o644);
    }
  });
});

describe("classifyArgv with the input flags", () => {
  it("--lines and --follow-symlinks take no value; the value flags are renamed only as flag names, never in values", () => {
    expect(classifyArgv(["q", "--lines", "a_b.log", "--follow_symlinks", "dir"])).toEqual(["q", "--lines", "a_b.log", "--follow-symlinks", "dir"]);
    expect(classifyArgv(["--max_bytes", "10", "--items", "x_y.jsonl", "--ext=ts_x"])).toEqual(["--max-bytes", "10", "--items", "x_y.jsonl", "--ext=ts_x"]);
  });
});


// IN-02 (TRDD-LMSYDGVB): label takes its classes from --labels / --labels-json and its items from the shared file inputs.
// The reply is the real P-01 choice reply re-keyed to the request: `pick` decides label and top probability per request (one chunk or item per request in files mode).
type Pick = (state: string) => { label: string; top: number };
function serveLabel(pick: Pick = () => ({ label: "bug", top: 0.9 })): { fetch: GlobalFetch; bodies: { state: { shared: { classes: { id: string; description: string | null }[] } }; questions: Record<string, { criteria: Record<string, unknown> }> }[] } {
  const bodies: ReturnType<typeof serveLabel>["bodies"] = [];
  const fetch: GlobalFetch = async (url, init) => {
    if (url.includes("output_modalities=decisions")) return replayFixture(fx("p02", "models-decisions"));
    if (url.endsWith("/endpoints")) return replayFixture(fx("p02", "target-endpoints"));
    const body = JSON.parse(String(init.body)) as (typeof bodies)[number];
    bodies.push(body);
    const { label, top } = pick(JSON.stringify(body.state));
    const rec = fx("p01", "dec-choice2");
    const answers = Object.fromEntries(Object.entries(body.questions).map(([k, q]) => {
      const ids = Object.keys(q.criteria);
      const rest = (1 - top) / (ids.length - 1);
      return [k, { type: "choice", choice: label, probabilities: Object.fromEntries(ids.map((id) => [id, id === label ? top : rest])), confidence: top - rest }];
    }));
    return replayFixture({ ...rec, body: JSON.stringify({ model: "typesafe/jev-1.13-20260917", answers, usage: { input_tokens: 100, output_tokens: 10, cost: 0.00001 } }) });
  };
  return { fetch, bodies };
}
const classesSent = (s: ReturnType<typeof serveLabel>): { id: string; description: string | null }[] => s.bodies[0]!.state.shared.classes;
const rowsOf = (out: string[]): { id: string; label: string | null; confidence: number | null }[] => (JSON.parse(out[0]!) as { decision: { rows: { id: string; label: string | null; confidence: number | null }[] } }).decision.rows;

// IN-03 (TRDD-DCI7C2Y7): rank --all and --head are flags declared on its spec; the request content is read from the GlobalFetch seam.
// The reply is the real P-01 score5 reply re-keyed to the request (relevance 3.73 / 4 = 0.9325 for every candidate).
function serveRank(): { fetch: GlobalFetch; units: unknown[] } {
  const units: unknown[] = [];
  const fetch: GlobalFetch = async (url, init) => {
    if (url.includes("output_modalities=decisions")) return replayFixture(fx("p02", "models-decisions"));
    if (url.endsWith("/endpoints")) return replayFixture(fx("p02", "target-endpoints"));
    const body = JSON.parse(String(init.body)) as { state: { units: unknown[] }; questions: Record<string, unknown> };
    units.push(...body.state.units);
    const rec = fx("p01", "dec-score5");
    const parsed = JSON.parse(rec.body) as { answers: Record<string, unknown> };
    const real = parsed.answers.urgency;
    parsed.answers = Object.fromEntries(Object.keys(body.questions).map((k) => [k, real]));
    return replayFixture({ ...rec, body: JSON.stringify(parsed) });
  };
  return { fetch, units };
}
const rankDecision = (out: string[]): { rows: { id: string; headCut: boolean }[]; total: number } => (JSON.parse(out[0]!) as { decision: { rows: { id: string; headCut: boolean }[]; total: number } }).decision;

describe("rank --head and --all as spec flags (IN-03)", () => {
  it("--head N sends only the first N bytes of a longer file and the whole shorter one", async () => {
    const long = put("long.txt", "x".repeat(5000));
    const short = put("short.txt", "short text");
    const s = serveRank();
    const { code, out, err } = await run(rankSpec as AnySpec, ["q", long, short, "--head", "100", "--profile", "c"], s.fetch);
    expect(err).toEqual([]);
    expect(code).toBe(0);
    expect(s.units.map((u) => (u as string).length).sort((a, b) => a - b)).toEqual([10, 100]);
    expect(s.units).toContain("short text");
    expect(rankDecision(out).rows.map((r) => [r.id, r.headCut])).toEqual([[long, true], [short, false]]);
  });

  it("--head cuts by BYTES, not characters: 101 bytes of two-byte characters is backed off to 100 bytes (50 characters)", async () => {
    const f = put("multi.txt", "é".repeat(100));
    const s = serveRank();
    const { err } = await run(rankSpec as AnySpec, ["q", f, "--head", "101", "--profile", "c"], s.fetch);
    expect(err).toEqual([]);
    expect(s.units).toHaveLength(1);
    expect(Buffer.byteLength(s.units[0] as string)).toBe(100);
    expect([...(s.units[0] as string)]).toHaveLength(50);
  });

  it("--all lists every candidate: 12 candidates with the default top of 10 give 10 rows without --all and 12 with it", async () => {
    // JSON mode: 12 file-mode candidates would be 12 requests, over the profile request limit of 8; packed candidates stay in one.
    const input = put("twelve.json", JSON.stringify({ query: "q", candidates: Array.from({ length: 12 }, (_, n) => ({ id: `f${n}`, text: `text ${n}` })) }));
    const cut = await run(rankSpec as AnySpec, ["--input", input, "--profile", "c"], serveRank().fetch);
    expect(cut.err).toEqual([]);
    expect(rankDecision(cut.out)).toMatchObject({ total: 12 });
    expect(rankDecision(cut.out).rows).toHaveLength(10);
    const all = await run(rankSpec as AnySpec, ["--all", "--input", input, "--profile", "c"], serveRank().fetch);
    expect(all.err).toEqual([]);
    expect(rankDecision(all.out).rows).toHaveLength(12);
  });

  it("--all in files mode: 5 files with --top 3 give 3 rows without --all and 5 with it", async () => {
    const files = Array.from({ length: 5 }, (_, n) => put(`g${n}.txt`, `text ${n}`));
    const cut = await run(rankSpec as AnySpec, ["q", ...files, "--top", "3", "--profile", "c"], serveRank().fetch);
    expect(cut.err).toEqual([]);
    expect(rankDecision(cut.out)).toMatchObject({ total: 5 });
    expect(rankDecision(cut.out).rows).toHaveLength(3);
    const all = await run(rankSpec as AnySpec, ["q", ...files, "--top", "3", "--all", "--profile", "c"], serveRank().fetch);
    expect(all.err).toEqual([]);
    expect(rankDecision(all.out).rows).toHaveLength(5);
  });
  it("parser: in `--head 1500 file.txt` the 1500 is the flag value, not an input path, and the file after it is still an input", async () => {
    const f = put("a.txt", "y".repeat(3000));
    const s = serveRank();
    const { code, err } = await run(rankSpec as AnySpec, ["q", "--head", "1500", f, "--profile", "c"], s.fetch);
    expect(err).toEqual([]);
    expect(code).toBe(0);
    expect(s.units).toHaveLength(1);
    expect(s.units[0]).toHaveLength(1500);
    // `--all` takes no value: the token after it stays a positional input.
    const all = await run(rankSpec as AnySpec, ["q", "--all", f, "--profile", "c"], serveRank().fetch);
    expect(all.err).toEqual([]);
    expect(rankDecision(all.out).rows.map((r) => r.id)).toEqual([f]);
  });

  it("--head 1500 --keep-at 0.5 (D27 form): head reaches the request (1500 bytes sent), keep-at reaches the result (0.95 drops the 0.9325 candidate, 0.5 keeps it)", async () => {
    const f = put("a.txt", "y".repeat(3000));
    const s = serveRank();
    const kept = await run(rankSpec as AnySpec, ["q", f, "--head", "1500", "--keep-at", "0.5", "--profile", "c"], s.fetch);
    expect(kept.err).toEqual([]);
    expect(kept.code).toBe(0);
    expect(s.units[0]).toHaveLength(1500);
    expect(rankDecision(kept.out).rows).toHaveLength(1);
    const dropped = await run(rankSpec as AnySpec, ["q", f, "--head", "1500", "--keep-at", "0.95", "--profile", "c"], serveRank().fetch);
    expect(rankDecision(dropped.out)).toMatchObject({ total: 1, rows: [] });
  });

  it("both flags also work with JSON input as an overlay; a JSON input that already holds the field is refused", async () => {
    const json = put("in.json", JSON.stringify({ query: "q", candidates: [{ id: "a", text: "abcdefghij" }, { id: "b", text: "klmnopqrst" }] }));
    const s = serveRank();
    const ok = await run(rankSpec as AnySpec, ["--head", "4", "--all", "--top", "1", "--input", json, "--profile", "c"], s.fetch);
    expect(ok.err).toEqual([]);
    expect(s.units).toHaveLength(2);
    expect(s.units).toEqual(expect.arrayContaining([{ id: "a", text: "abcd" }, { id: "b", text: "klmn" }]));
    expect(rankDecision(ok.out).rows).toHaveLength(2);
    const holdsHead = put("h.json", JSON.stringify({ query: "q", candidates: [{ text: "x" }], head: 3 }));
    const h = await run(rankSpec as AnySpec, ["--head", "4", "--input", holdsHead]);
    expect([h.code, h.err[0]]).toEqual([1, "llm-ext: --head sets head, which the JSON input already holds; give it in one place"]);
    const holdsAll = put("al.json", JSON.stringify({ query: "q", candidates: [{ text: "x" }], all: false }));
    const a = await run(rankSpec as AnySpec, ["--all", "--input", holdsAll]);
    expect([a.code, a.err[0]]).toEqual([1, "llm-ext: --all sets all, which the JSON input already holds; give it in one place"]);
  });

  it("--head 0, -1, 1.5 and abc are refused naming --head, nothing is sent; --all takes no value", async () => {
    const f = put("a.txt", "alpha");
    for (const bad of ["0", "-1", "1.5", "abc"]) {
      const r = await run(rankSpec as AnySpec, ["q", f, "--head", bad, "--profile", "c"]);
      expect(r.code, bad).toBe(1);
      expect(r.err[0], bad).toMatch(/^llm-ext: --head /);
    }
    const v = await run(rankSpec as AnySpec, ["q", f, "--all=yes", "--profile", "c"]);
    expect([v.code, v.err[0]]).toEqual([1, "llm-ext: --all takes no value"]);
  });

  it("the tool schema advertises rank's flags with their types (head number, all boolean) and filter has neither", () => {
    const props = (id: string): Record<string, { type: string }> => (classifyTools().find((t) => t.name === `classify_${id}`)!.inputSchema.properties as Record<string, { type: string }>);
    expect([props("rank").head?.type, props("rank").all?.type]).toEqual(["number", "boolean"]);
    expect([props("filter").head, props("filter").all]).toEqual([undefined, undefined]);
  });

  it("--head belongs to rank only: filter answers unknown option", async () => {
    const r = await run(filterSpec as AnySpec, ["q", put("a.txt", "alpha"), "--head", "5"]);
    expect([r.code, r.err[0]]).toEqual([1, "llm-ext: unknown option --head for classify filter"]);
  });

  it("rank --keep-at still parses as a threshold in files mode: 0.9 keeps the 0.9325 candidate, 0.95 drops it (owed from IN-01)", async () => {
    const f = put("a.txt", "alpha");
    const kept = await run(rankSpec as AnySpec, ["q", f, "--keep-at", "0.9", "--profile", "c"], serveRank().fetch);
    expect(kept.err).toEqual([]);
    expect(rankDecision(kept.out)).toMatchObject({ total: 1, rows: [{ id: f }] });
    const dropped = await run(rankSpec as AnySpec, ["q", f, "--keep-at", "0.95", "--profile", "c"], serveRank().fetch);
    expect(dropped.err).toEqual([]);
    expect(rankDecision(dropped.out)).toMatchObject({ total: 1, rows: [] });
  });

  it("find --chunk and --min-score still parse as thresholds in files mode: --chunk 1 splits a 3-line file into 3 questions (its value is not taken as an input path)", async () => {
    const g = put("three.txt", "one\ntwo\nthree\n");
    const whole = serve();
    await run(findSpec as AnySpec, ["what", g, "--min-score", "0.2", "--profile", "c"], whole.fetch);
    const split = serve();
    const r = await run(findSpec as AnySpec, ["what", g, "--chunk", "1", "--min-score", "0.2", "--profile", "c"], split.fetch);
    expect(r.err.join("\n")).not.toMatch(/unknown option|needs a number|invalid input/);
    // --chunk 1 turns the 3-line file into 3 chunk questions; the default chunk keeps it one (a request may carry several questions, so count questions, not requests).
    const asked = (x: ReturnType<typeof serve>): number => x.questions.reduce((n, q) => n + Object.keys(q).length, 0);
    expect(asked(split)).toBeGreaterThan(asked(whole));
  });

  // IN-04 added scope (coordinator): --top is a find threshold, and --preset-style value flags must not turn its value into an input path.
  it("find --top 2 still parses as a threshold in files mode: the 2 is not an input path and the run succeeds", async () => {
    const r = await run(findSpec as AnySpec, ["what", put("three.txt", "one\ntwo\nthree\n"), "--top", "2", "--profile", "c"], serve().fetch);
    expect([r.code, r.err]).toEqual([0, []]);
  });
});

describe("label --labels / --labels-json and file inputs (IN-02)", () => {
  it("classify label --labels a,b <files> runs end to end through runDecisionArgv: items from collectInputs, one text unit per file, rows keyed by path", async () => {
    const a = put("a.txt", "alpha\n");
    const b = put("b.txt", "beta\n");
    const s = serveLabel();
    const { code, out, err } = await run(labelSpec as AnySpec, ["--labels", "bug,other", a, b, "--profile", "c"], s.fetch);
    expect(err).toEqual([]);
    expect(code).toBe(0);
    expect(s.bodies).toHaveLength(2);
    expect(rowsOf(out).map((r) => [r.id, r.label])).toEqual([[a, "bug"], [b, "bug"]]);
  });

  it("--labels \"a:hint,b\": text after the first colon is the hint (further colons stay in it), blank entries are dropped, a label without a hint has a null description", async () => {
    const f = put("a.txt", "alpha\n");
    const s = serveLabel();
    const { err } = await run(labelSpec as AnySpec, ["--labels", " bug : Something: broken ,, feature ,other:", f, "--profile", "c"], s.fetch);
    expect(err).toEqual([]);
    expect(classesSent(s)).toEqual([{ id: "bug", description: "Something: broken" }, { id: "feature", description: null }, { id: "other", description: "" }]);
  });

  it("--labels-json takes a JSON object (value = description, null allowed) and an @file with the same content", async () => {
    const f = put("a.txt", "alpha\n");
    const json = '{"bug":"Something broken","other":null}';
    const want = [{ id: "bug", description: "Something broken" }, { id: "other", description: null }];
    const inline = serveLabel();
    expect((await run(labelSpec as AnySpec, ["--labels-json", json, f, "--profile", "c"], inline.fetch)).err).toEqual([]);
    expect(classesSent(inline)).toEqual(want);
    const lf = put("labels.json", json);
    const viaFile = serveLabel();
    expect((await run(labelSpec as AnySpec, ["--labels-json", `@${lf}`, f, "--profile", "c"], viaFile.fetch)).err).toEqual([]);
    expect(classesSent(viaFile)).toEqual(want);
  });

  it("--labels-json @file follows the named-file rules: a directory (E41), a secret (E36), an empty file (E40) and a missing file are refused, nothing is sent", async () => {
    const f = put("a.txt", "alpha\n");
    const secret = put("creds/.env", '{"a":null,"b":null}');
    const empty = put("empty.json", "");
    for (const [target, re] of [[work(), /is a directory/], [secret, /looks like a secret/], [empty, /empty input/], [join(work(), "none.json"), /no such file/]] as const) {
      const s = serveLabel();
      const r = await run(labelSpec as AnySpec, ["--labels-json", `@${target}`, f, "--profile", "c"], s.fetch);
      expect(r.code).toBe(1);
      expect(r.err[0]).toMatch(re);
      expect(s.bodies).toHaveLength(0);
    }
  });

  it("a --labels-json that is not an object of string/null descriptions, or not JSON, exits 1 naming the flag", async () => {
    const f = put("a.txt", "alpha\n");
    for (const bad of ["[1,2]", "null", "\"x\"", '{"a":1,"b":null}', "{nope"]) {
      const r = await run(labelSpec as AnySpec, ["--labels-json", bad, f]);
      expect(r.code, bad).toBe(1);
      expect(r.err[0], bad).toMatch(/^llm-ext: --labels-json /);
    }
  });

  it("--labels together with --labels-json, a repeated flag, and neither flag are all refused before any request", async () => {
    const f = put("a.txt", "alpha\n");
    const both = await run(labelSpec as AnySpec, ["--labels", "a,b", "--labels-json", '{"a":null,"b":null}', f]);
    expect(both.code).toBe(1);
    expect(both.err[0]).toMatch(/--labels-json and --labels both set classes|--labels and --labels-json both set classes/);
    const twice = await run(labelSpec as AnySpec, ["--labels", "a,b", "--labels", "c,d", f]);
    expect(twice.code).toBe(1);
    expect(twice.err[0]).toMatch(/--labels both set classes|--labels is given twice/);
    const none = await run(labelSpec as AnySpec, [f]);
    expect(none.code).toBe(1);
    expect(none.err.join("\n")).toMatch(/classes/);
  });

  it("1 label and 256 labels are refused by the schema (2 to 255), nothing is sent; 2 labels run", async () => {
    const f = put("a.txt", "alpha\n");
    // two-character ids keep the 256 labels under the 8000-character catalog budget, so the refusal is the count and not the size.
    const many = Array.from({ length: 256 }, (_, k) => k.toString(36).padStart(2, "0")).join(",");
    for (const [labels, re] of [["only", /classes: .*(>=2|at least 2)/], [many, /classes: .*(<=255|at most 255)/]] as const) {
      const s = serveLabel();
      const r = await run(labelSpec as AnySpec, ["--labels", labels, f, "--profile", "c"], s.fetch);
      expect(r.code, labels.slice(0, 10)).not.toBe(0);
      expect(r.err.join("\n")).toMatch(re);
      expect(s.bodies).toHaveLength(0);
    }
    const ok = await run(labelSpec as AnySpec, ["--labels", "a,b", f, "--profile", "c"], serveLabel().fetch);
    expect(ok.err).toEqual([]);
  });

  it("--default naming a class that is not a label is refused before any request; a real label is accepted", async () => {
    const f = put("a.txt", "alpha\n");
    const s = serveLabel();
    const bad = await run(labelSpec as AnySpec, ["--labels", "bug,other", "--default", "zzz", f, "--profile", "c"], s.fetch);
    expect(bad.code).not.toBe(0);
    expect(bad.err.join("\n")).toMatch(/--default "zzz" is not a label/);
    expect(s.bodies).toHaveLength(0);
    const good = await run(labelSpec as AnySpec, ["--labels", "bug,other", "--default", "bug", f, "--profile", "c"], serveLabel().fetch);
    expect(good.err).toEqual([]);
  });

  it("--labels with an empty label id (\":hint,b\") is refused naming --labels, exit 1, nothing is sent", async () => {
    const f = put("a.txt", "alpha\n");
    const s = serveLabel();
    const r = await run(labelSpec as AnySpec, ["--labels", ":hint,b", f, "--profile", "c"], s.fetch);
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toMatch(/--labels.*empty label/);
    expect(s.bodies).toHaveLength(0);
  });

  it("a label with a space (\"bug report,feature\") is accepted (class ids are free text) and is sent as typed", async () => {
    const f = put("a.txt", "alpha\n");
    const s = serveLabel(() => ({ label: "bug report", top: 0.9 }));
    const r = await run(labelSpec as AnySpec, ["--labels", "bug report,feature", f, "--profile", "c"], s.fetch);
    expect(r.err).toEqual([]);
    expect(classesSent(s).map((c) => c.id)).toEqual(["bug report", "feature"]);
    expect(rowsOf(r.out)).toMatchObject([{ id: f, label: "bug report" }]);
  });

  it("a chunked file takes the default-label no-vote rule (E117): chunks that say the default label do not outvote the one chunk with the finding", async () => {
    const filler = Array.from({ length: 40 }, (_, k) => `line ${k} of ordinary text without anything special in it`).join("\n");
    const f = put("big.txt", `${filler}\nNEEDLE finding here\n${filler}\n`);
    // `other` (the last label, so the default) is the confident answer of every chunk without the needle; without the rule 0.95 would beat the bug chunk at 0.7.
    const s = serveLabel((state) => (state.includes("NEEDLE") ? { label: "bug", top: 0.85 } : { label: "other", top: 0.975 }));
    const { code, out, err } = await run(labelSpec as AnySpec, ["--labels", "bug,other", f, "--chunk-chars", "1000", "--profile", "c"], s.fetch);
    expect(err).toEqual([]);
    expect(code).toBe(0);
    expect(s.bodies.length).toBeGreaterThan(2);
    expect(rowsOf(out)).toMatchObject([{ id: f, label: "bug" }]);
  });

  it("the flags also work with JSON input: they fill `classes`, and a JSON input that already holds `classes` is refused", async () => {
    const withoutClasses = put("in.json", JSON.stringify({ items: [{ id: "t1", text: "x" }] }));
    const s = serveLabel();
    const ok = await run(labelSpec as AnySpec, ["--labels", "bug,other", "--input", withoutClasses, "--profile", "c"], s.fetch);
    expect(ok.err).toEqual([]);
    expect(classesSent(s).map((c) => c.id)).toEqual(["bug", "other"]);
    const withClasses = put("in2.json", JSON.stringify({ items: [{ id: "t1", text: "x" }], classes: [{ id: "a" }, { id: "b" }] }));
    const both = await run(labelSpec as AnySpec, ["--labels", "bug,other", "--input", withClasses]);
    expect(both.code).toBe(1);
    expect(both.err[0]).toBe("llm-ext: --labels sets classes, which the JSON input already holds; give it in one place");
  });
});

// IN-04 (TRDD-AQ82IO1T): check has no `cli`, so --preset works with --input JSON only. The reply is the real P-01 choice reply re-keyed to the request; `bodies` records what reached the fetch seam.
function serveCheck(): { fetch: GlobalFetch; bodies: { state: { shared: { preset: string } }; questions: Record<string, { criteria: Record<string, unknown> }> }[] } {
  const bodies: ReturnType<typeof serveCheck>["bodies"] = [];
  const fetch: GlobalFetch = async (url, init) => {
    if (url.includes("output_modalities=decisions")) return replayFixture(fx("p02", "models-decisions"));
    if (url.endsWith("/endpoints")) return replayFixture(fx("p02", "target-endpoints"));
    const body = JSON.parse(String(init.body)) as (typeof bodies)[number];
    bodies.push(body);
    const answers = Object.fromEntries(Object.entries(body.questions).map(([k, q]) => {
      const ids = Object.keys(q.criteria);
      return [k, { type: "choice", choice: ids[0], probabilities: Object.fromEntries(ids.map((id, n) => [id, n === 0 ? 0.9 : 0.1 / (ids.length - 1)])), confidence: 0.8 }];
    }));
    return replayFixture({ ...fx("p01", "dec-choice2"), body: JSON.stringify({ model: "typesafe/jev-1.13-20260917", answers, usage: { input_tokens: 100, output_tokens: 10, cost: 0.00001 } }) });
  };
  return { fetch, bodies };
}
const INVARIANT_JSON = { invariants: [{ text: "Only owned documents are returned." }], before: "where ownerId", after: "where {}" };
const CRITERION_JSON = { criteria: [{ text: "Flag off keeps behavior." }], tests: [{ scenario: "flag on", assertion: "new path" }] };

describe("check --preset as an overlay flag (IN-04)", () => {
  it("--preset invariant-check and --preset criterion-vs-tests select their branch: the request carries that preset state and that preset's labels", async () => {
    const inv = serveCheck();
    const a = await run(checkSpec as AnySpec, ["--preset", "invariant-check", "--input", put("f.json", JSON.stringify(INVARIANT_JSON)), "--profile", "c"], inv.fetch);
    expect([a.code, a.err]).toEqual([0, []]);
    expect(inv.bodies).toHaveLength(1);
    expect(inv.bodies[0]!.state.shared.preset).toBe("invariant-check");
    expect(Object.keys(Object.values(inv.bodies[0]!.questions)[0]!.criteria)).toEqual(["preserved", "violated", "insufficient"]);
    const cri = serveCheck();
    const b = await run(checkSpec as AnySpec, ["--preset", "criterion-vs-tests", "--input", put("g.json", JSON.stringify(CRITERION_JSON)), "--profile", "c"], cri.fetch);
    expect([b.code, b.err]).toEqual([0, []]);
    expect(cri.bodies[0]!.state.shared.preset).toBe("criterion-vs-tests");
    expect(Object.keys(Object.values(cri.bodies[0]!.questions)[0]!.criteria)).toEqual(["covered", "partial", "missing", "insufficient"]);
  });

  it("JSON that already holds `preset` plus --preset is refused with the overlay message, nothing is sent", async () => {
    const r = await run(checkSpec as AnySpec, ["--preset", "invariant-check", "--input", put("h.json", JSON.stringify({ preset: "invariant-check", ...INVARIANT_JSON }))]);
    expect([r.code, r.err[0]]).toEqual([1, "llm-ext: --preset sets preset, which the JSON input already holds; give it in one place"]);
  });

  it("no --preset and no `preset` in the JSON: the schema refusal names the field", async () => {
    const r = await run(checkSpec as AnySpec, ["--input", put("n.json", JSON.stringify(INVARIANT_JSON)), "--profile", "c"]);
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toBe("llm-ext: invalid input: preset: Invalid discriminator value. Expected 'invariant-check' | 'criterion-vs-tests'"); // the union schema's own refusal; no flag-level check fires
  });

  it("an unknown value (--preset nope) is refused by the union schema, naming preset, nothing is sent", async () => {
    const r = await run(checkSpec as AnySpec, ["--preset", "nope", "--input", put("u.json", JSON.stringify(INVARIANT_JSON)), "--profile", "c"]);
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toBe("llm-ext: invalid input: preset: Invalid discriminator value. Expected 'invariant-check' | 'criterion-vs-tests'"); // the union schema's own refusal; no flag-level check fires
  });

  it("--preset belongs to check only: filter answers unknown option", async () => {
    const r = await run(filterSpec as AnySpec, ["q", put("a.txt", "alpha"), "--preset", "invariant-check"]);
    expect([r.code, r.err[0]]).toEqual([1, "llm-ext: unknown option --preset for classify filter"]);
  });

  it("--preset followed by another flag is refused as needing a value, not swallowed", async () => {
    const r = await run(checkSpec as AnySpec, ["--preset", "--profile", "c", "--input", put("v.json", JSON.stringify(INVARIANT_JSON))]);
    expect([r.code, r.err[0]]).toEqual([1, "llm-ext: --preset needs a value"]);
  });

  it("the tool schema advertises preset as a string for check and no other spec has it", () => {
    const props = (id: string): Record<string, { type: string }> => (classifyTools().find((t) => t.name === `classify_${id}`)!.inputSchema.properties as Record<string, { type: string }>);
    expect(props("check").preset?.type).toBe("string");
    expect(props("rank").preset).toBeUndefined();
  });
  it("check stays JSON-only: a file argument is refused as before, and its tool schema has preset but none of the input flags", async () => {
    const r = await run(checkSpec as AnySpec, ["--preset", "invariant-check", put("a.txt", "alpha")]);
    expect([r.code, r.err[0]]).toEqual([1, "llm-ext: classify check does not take file inputs yet; pass --input <file.json> or JSON on stdin"]);
    const schema = classifyTools().find((t) => t.name === "classify_check")!.inputSchema.properties as Record<string, unknown>;
    expect(Object.keys(schema)).toContain("preset");
    for (const f of INPUT_FLAGS) expect(Object.keys(schema), f.property).not.toContain(f.property);
  });

  it("the two presets produce different requests: different shared state fields and different question wording", async () => {
    const inv = serveCheck();
    const cri = serveCheck();
    await run(checkSpec as AnySpec, ["--preset", "invariant-check", "--input", put("f.json", JSON.stringify(INVARIANT_JSON)), "--profile", "c"], inv.fetch);
    await run(checkSpec as AnySpec, ["--preset", "criterion-vs-tests", "--input", put("g.json", JSON.stringify(CRITERION_JSON)), "--profile", "c"], cri.fetch);
    expect(Object.keys(inv.bodies[0]!.state.shared).sort()).not.toEqual(Object.keys(cri.bodies[0]!.state.shared).sort());
    expect(JSON.stringify(inv.bodies[0]!.questions)).not.toEqual(JSON.stringify(cri.bodies[0]!.questions));
  });
});
