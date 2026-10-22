import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseDecisionsReply, parseDecisionsText, type ReplyUsage } from "./response.js";
import { replayFixture, syntheticResponse, type RecordedReply } from "./test-fetch.js";
import { ClassifierError } from "./errors.js";

const fixture = (n: string): RecordedReply =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../__fixtures__/p01/${n}.json`, import.meta.url)), "utf8"));
const rec = () => {
  const seen: ReplyUsage[] = [];
  return { seen, record: (u: ReplyUsage) => void seen.push(u) };
};
const synth = (body: unknown) => syntheticResponse(200, typeof body === "string" ? body : JSON.stringify(body));
const good = { model: "m-1", answers: { a: {} }, usage: { input_tokens: 5, output_tokens: 2, cost: 0.1 } };
async function fail(res: Response) {
  const r = rec();
  const e = await parseDecisionsReply(res, r.record).then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(ClassifierError);
  return { e: e as ClassifierError, seen: r.seen };
}

describe("parseDecisionsReply on real P-01 replies", () => {
  it("parses every success reply, records usage once and keeps the served model", async () => {
    for (const n of ["dec-noul", "sys-noul", "dec-choice3", "sys-choice3", "dec-score5", "sys-score5"]) {
      const f = fixture(n);
      const body = JSON.parse(f.body);
      const r = rec();
      const reply = await parseDecisionsReply(replayFixture(f), r.record);
      expect(reply.model).toBe(body.model);
      expect(reply.answers).toEqual(body.answers);
      expect(reply.usage).toEqual(body.usage);
      expect(reply.provider).toBe(body.provider);
      expect(r.seen).toEqual([body.usage]);
    }
  });
  it("E11: the served model is returned as is, whatever alias was requested", async () => {
    const reply = await parseDecisionsReply(replayFixture(fixture("dec-choice3")), () => {});
    expect(reply.model).toMatch(/jev-1\.13-20260917/);
  });
});

describe("parseDecisionsReply on synthetic replies (D21)", () => {
  it("synthetic: E01 HTML body -> bad-response with a sanitized excerpt, nothing recorded", async () => {
    const { e, seen } = await fail(synth("<html><body>Bad gateway user_id: user_SECRET123 sk-abcdefgh12345678</body></html>"));
    expect([e.class, e.retryable]).toEqual(["bad-response", false]);
    expect(e.message).toContain("<html>");
    expect(e.message).not.toContain("user_SECRET123");
    expect(e.message).not.toContain("sk-abcdefgh12345678");
    expect(e.message.length).toBeLessThan(400);
    expect(seen).toEqual([]);
  });
  it("synthetic: JSON that is not an object -> bad-response", async () => {
    for (const b of ["[1]", "null", "7", '"x"']) expect((await fail(synth(b))).e.class).toBe("bad-response");
  });
  it("synthetic: E13 usage missing or bad -> bad-response, nothing recorded as free", async () => {
    const { usage: _u, ...noUsage } = good;
    const cases = [
      noUsage,
      { ...good, usage: null },
      { ...good, usage: [] },
      { ...good, usage: { output_tokens: 2 } },
      { ...good, usage: { input_tokens: "5", output_tokens: 2 } },
      { ...good, usage: { input_tokens: 5, output_tokens: -1 } },
      { ...good, usage: { input_tokens: 5, output_tokens: 2, cost: "0.1" } },
    ];
    for (const c of cases) {
      const { e, seen } = await fail(synth(c));
      expect(e.class).toBe("bad-response");
      expect(e.message).toMatch(/usage/);
      expect(seen).toEqual([]);
    }
  });
  it("synthetic: usage without cost is valid and cost stays absent", async () => {
    const reply = await parseDecisionsReply(synth({ ...good, usage: { input_tokens: 5, output_tokens: 2 } }), () => {});
    expect(reply.usage).toEqual({ input_tokens: 5, output_tokens: 2 });
  });
  it("synthetic: missing, blank or non-string model -> bad-response, but the billed usage is recorded first", async () => {
    const { model: _m, ...noModel } = good;
    for (const c of [noModel, { ...good, model: "" }, { ...good, model: "   " }, { ...good, model: 7 }]) {
      const { e, seen } = await fail(synth(c));
      expect(e.class).toBe("bad-response");
      expect(e.message).toMatch(/model/);
      expect(seen).toEqual([good.usage]);
    }
  });
  it("synthetic: non-object answers -> bad-response, but the billed usage is recorded first", async () => {
    for (const a of [undefined, null, [], "x", 3]) {
      const { e, seen } = await fail(synth({ ...good, answers: a }));
      expect(e.class).toBe("bad-response");
      expect(e.message).toMatch(/answers/);
      expect(seen).toEqual([good.usage]);
    }
  });
  it("synthetic: a body over 1 MB -> bad-response", async () => {
    const { e, seen } = await fail(synth(JSON.stringify({ ...good, pad: "x".repeat(1_000_001) })));
    expect(e.class).toBe("bad-response");
    expect(seen).toEqual([]);
  });
  it("synthetic: id and provider are carried when strings", async () => {
    const reply = await parseDecisionsReply(synth({ ...good, id: "gen-1", provider: "P" }), () => {});
    expect([reply.id, reply.provider]).toEqual(["gen-1", "P"]);
  });
});

describe("parseDecisionsText (the body parsed once, inside the transport)", () => {
  it("returns the same reply as parseDecisionsReply and records the usage first", () => {
    const seen: ReplyUsage[] = [];
    const reply = parseDecisionsText(JSON.stringify(good), (u) => void seen.push(u));
    expect(reply).toMatchObject({ model: "m-1", answers: { a: {} } });
    expect(seen).toEqual([{ input_tokens: 5, output_tokens: 2, cost: 0.1 }]);
  });
  it("a billed but invalid reply is recorded and then refused as bad-response", () => {
    const seen: ReplyUsage[] = [];
    expect(() => parseDecisionsText(JSON.stringify({ ...good, answers: null }), (u) => void seen.push(u))).toThrow(ClassifierError);
    expect(seen).toHaveLength(1);
  });
  it("unusable usage is not recorded", () => {
    const seen: ReplyUsage[] = [];
    expect(() => parseDecisionsText(JSON.stringify({ ...good, usage: {} }), (u) => void seen.push(u))).toThrow(/usage/);
    expect(seen).toHaveLength(0);
  });
});
