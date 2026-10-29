// P6b step 3: Phase A scorers (spec 4.2), checked with degenerate answerers
// (spec section 9, coordinator decision 16): each must FAIL the scorer it
// targets; a reply cut at max_tokens is inconclusive, never a fail.
import { describe, expect, it } from "vitest";
import type { TrialRecord } from "./state.js";
import {
  checkArray40,
  checkSmall,
  hasReasoning,
  jsonOutcome,
  KNOWN_ANSWER,
  KNOWN_QUESTION,
  knownAnswerOutcome,
  normalise,
  parseReply,
  probeDocuments,
  proseOf,
  stripThinking,
  thinkingOffOutcome,
  shortOffCompletions,
  thinkingOffMode,
  thinkingOnOutcome,
  LEAKY_LIMIT,
  trialTimeoutMs,
  type Reply,
} from "./phase-a.js";

/** A 200 reply with this content (and optional reasoning field / finish reason). */
const reply = (content: string, o: Partial<Reply> = {}): Reply => ({
  status: 200,
  content,
  reasoning: "",
  finishReason: "stop",
  promptTokens: 30,
  completionTokens: 5,
  timedOut: false,
  wallMs: 100,
  ...o,
});
const known = (r: Reply): string => knownAnswerOutcome(r, KNOWN_ANSWER, KNOWN_QUESTION);
const items = (n: number, f: (i: number) => unknown = (i) => ({ id: i + 1, label: (i + 1) % 2 === 0 ? "even" : "odd" })): string =>
  JSON.stringify({ items: Array.from({ length: n }, (_, i) => f(i)) });

describe("Phase A scorers: real answers pass", () => {
  it("the known answer as a whole word, restated or bare, after thinking is stripped", () => {
    for (const c of ["42", "The answer is 42.", "6 × 7 = 42", "<think>6 times 7 is 42</think>42", "**42**"]) expect(known(reply(c)), c).toBe("pass");
    expect(known(reply("42", { reasoning: "six sevens are forty-two" }))).toBe("pass");
  });
  it("thinking off with a plain answer, thinking on with a reasoning field or a think block", () => {
    expect(thinkingOffOutcome(reply("42"))).toBe("pass");
    expect(thinkingOnOutcome(reply("42", { reasoning: "6*7" }))).toBe("pass");
    expect(thinkingOnOutcome(reply("<think>6*7</think>42"))).toBe("pass");
  });
  it("json_schema: the small object and exactly 40 items", () => {
    expect(jsonOutcome(reply('{"city":"Paris","population":2100000}'), checkSmall)).toBe("pass");
    expect(jsonOutcome(reply(items(40)), checkArray40)).toBe("pass");
    // A think block before the JSON is stripped first.
    expect(jsonOutcome(reply(`<think>plan</think>${items(40)}`), checkArray40)).toBe("pass");
  });
});

describe("Phase A scorers: degenerate answerers fail", () => {
  it("known answer: empty, the echoed question, a number containing the answer, every number, a refusal, a wrong number", () => {
    const degenerate = ["", KNOWN_QUESTION, "142", "4 2", "420", Array.from({ length: 100 }, (_, i) => i + 1).join(" "), "I don't know.", "43", "forty two"];
    for (const c of degenerate) expect(known(reply(c)), JSON.stringify(c)).toBe("fail");
  });
  it("known answer given only inside a think block fails", () => {
    expect(known(reply("<think>it is 42</think>I am not sure."))).toBe("fail");
    expect(known(reply("<think>it is 42"))).toBe("fail");
  });
  it("an HTTP error fails", () => {
    expect(known(reply("", { status: 500, error: "boom" }))).toBe("fail");
    expect(thinkingOffOutcome(reply("", { status: 500 }))).toBe("fail");
  });
  it("thinking off: a reasoning field, a think block, a reply that is only a think block, an orphan close tag, an empty reply", () => {
    for (const r of [reply("42", { reasoning: "let me think" }), reply("<think>x</think>42"), reply("<think>only thinking</think>"), reply("x</think>42"), reply("   ")]) {
      expect(thinkingOffOutcome(r), JSON.stringify(r.content)).toBe("fail");
    }
  });
  it("thinking on: no reasoning at all fails", () => {
    expect(thinkingOnOutcome(reply("42"))).toBe("fail");
  });
  it("json: {}, wrong keys, an extra key, a non-integer, 39 and 41 items, a wrong item type, a bad label, JSON only inside a think block, prose", () => {
    for (const c of ["{}", '{"name":"Paris","population":1}', '{"city":"Paris","population":1,"x":1}', '{"city":"Paris","population":1.5}', '{"city":"","population":1}', "Paris has 2 million people."]) {
      expect(jsonOutcome(reply(c), checkSmall), c).toBe("fail");
    }
    for (const c of [items(39), items(41), items(40, (i) => ({ id: String(i), label: "odd" })), items(40, () => ({ id: 1, label: "maybe" })), items(40, (i) => i), `<think>${items(40)}</think>`, "[]"]) {
      expect(jsonOutcome(reply(c), checkArray40), c.slice(0, 40)).toBe("fail");
    }
  });
});

describe("Phase A scorers: cut replies are inconclusive, never a fail", () => {
  it("a reply cut at max_tokens or by the timeout, for every scorer", () => {
    const cuts = [reply("The answer is", { finishReason: "length" }), reply("", { status: 0, timedOut: true, finishReason: null })];
    for (const r of cuts) {
      expect(known(r)).toBe("inconclusive");
      expect(thinkingOffOutcome(r)).toBe("inconclusive");
      expect(thinkingOnOutcome(r)).toBe("inconclusive");
      expect(jsonOutcome(r, checkSmall)).toBe("inconclusive");
    }
  });
  it("HTTP 400 on a json_schema request is 'unsupported' (the engine refuses the schema), not a fail of the model", () => {
    expect(jsonOutcome(reply("", { status: 400, error: "Failed to initialize samplers" }), checkSmall)).toBe("unsupported");
  });
});

describe("D5: leaky thinking off (main-agent decision 2026-10-29; review of a72827f9)", () => {
  it("leaky when the median short thinking-off answer exceeds 256 tokens; one brief answer does not hide a leak; false when thinking cannot be turned off", () => {
    expect(LEAKY_LIMIT).toBe(256);
    expect(thinkingOffMode(true, [12, 30, 6])).toBe(true);
    expect(thinkingOffMode(true, [200, 256, 312])).toBe(true);
    expect(thinkingOffMode(true, [200, 257, 312])).toBe("leaky");
    // The LFM3 shape: a brief known answer, ~700-token fact answers.
    expect(thinkingOffMode(true, [12, 700, 690, 720])).toBe("leaky");
    expect(thinkingOffMode(true, [])).toBe(true);
    expect(thinkingOffMode(false, [12])).toBe(false);
  });
  it("reads the known answer, both thinking-off trials and Phase B short thinking-off answers; never long answers, thinking-on or failed requests", () => {
    const t = (step: string, data: Record<string, unknown>): TrialRecord => ({ step, seed: 0, outcome: "pass", at: "t", data: { status: 200, ...data } as TrialRecord["data"] });
    const trials = [
      t("A/known-answer", { completion_tokens: 5 }),
      t("A/thinking-off", { completion_tokens: 7 }),
      t("A/thinking-off", { completion_tokens: 9 }),
      t("A/thinking-on", { completion_tokens: 3000 }),
      t("B/fact/4096", { completion_tokens: 700, short: true, thinking: "off" }),
      t("B/aggregate/4096", { completion_tokens: 2048, short: true, thinking: "off", cut: true }),
      t("B/aggregate/4096", { completion_tokens: 900, short: false, thinking: "off" }),
      t("B/bug/4096", { completion_tokens: 4000, short: false, thinking: "on" }),
      t("B/fact/4096", { completion_tokens: 0, short: true, thinking: "off", status: 0 }),
    ];
    expect(shortOffCompletions(trials)).toEqual([5, 7, 9, 700, 2048]);
  });
});

describe("Phase A helpers", () => {
  it("normalise: case, spaces and hyphens", () => {
    expect(normalise("  Forty-Two\n\tIS  the–ANSWER ")).toBe("forty two is the answer");
  });
  it("stripThinking and hasReasoning", () => {
    expect(stripThinking("<think>a</think> b <think>c</think> d")).toBe("b  d");
    expect(stripThinking("prompt-opened</think>answer")).toBe("answer");
    expect(hasReasoning(reply("x", { reasoning: " " }))).toBe(false);
  });
  it("parseReply reads llama-server and other reasoning fields, usage and timings; a non-200 keeps the server text", () => {
    const body = JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "42", reasoning_content: "r" } }], usage: { prompt_tokens: 9, completion_tokens: 2 }, timings: { prompt_per_second: 1000, predicted_per_second: 50 } });
    expect(parseReply(200, body, 10)).toMatchObject({ content: "42", reasoning: "r", promptTokens: 9, completionTokens: 2, promptPerSecond: 1000, predictedPerSecond: 50 });
    expect(parseReply(200, JSON.stringify({ choices: [{ message: { content: "x", reasoning: "y" } }] }), 1).reasoning).toBe("y");
    expect(parseReply(400, "Failed to initialize samplers", 1)).toMatchObject({ status: 400, error: "Failed to initialize samplers" });
    expect(parseReply(200, "not json", 1).status).toBe(502);
  });
  it("fixtures are deterministic: the same seed rebuilds the same text", () => {
    expect(proseOf(7, 500)).toBe(proseOf(7, 500));
    expect(proseOf(7, 500)).not.toBe(proseOf(8, 500));
    expect(probeDocuments()).toEqual(probeDocuments());
    expect(probeDocuments().every((d) => d.length >= 1500 && d.length <= 2000)).toBe(true);
  });
  it("the trial timeout is 3 x (prefill + cap / decode), at least 120 s", () => {
    expect(trialTimeoutMs(8000, 8192, 1000, 20)).toBe(Math.ceil(3 * (8 + 409.6) * 1000));
    expect(trialTimeoutMs(10, 10, 10_000, 1000)).toBe(120_000);
  });
});
