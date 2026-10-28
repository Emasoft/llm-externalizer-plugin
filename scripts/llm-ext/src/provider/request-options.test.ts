// TRDD-1OOAH3LD increment 1: the pure request-options helpers and the profile-key validation. No I/O, no server.

import { describe, it, expect } from "vitest";
import { parse as yamlParse } from "yaml";

import { resolveProfile, validateProfile, type Profile, type RequestOptionsConfig } from "../config.js";
import {
  OUTPUT_LIMIT_PREFIX,
  OutputLimitError,
  applyRequestOptions,
  effectiveMaxTokens,
  resolveRequestOptions,
  withStopInstruction,
} from "./request-options.js";
import type { ChatMessage } from "./types.js";

const CFG: RequestOptionsConfig = {
  default: { thinking: "off", max_output_tokens: 512, temperature: 0.1, top_k: 50, repeat_penalty: 1.1 },
  chat: { thinking: true, max_output_tokens: 2048 },
};

describe("resolveRequestOptions", () => {
  it("null config -> null", () => {
    expect(resolveRequestOptions(null, "chat")).toBeNull();
  });

  it("tool block wins field by field over default; untouched fields come from default", () => {
    expect(resolveRequestOptions(CFG, "chat")).toEqual({
      maxOutputTokens: 2048,
      thinking: true,
      temperature: 0.1,
      topK: 50,
      repeatPenalty: 1.1,
    });
  });

  it("an unknown tool and an undefined tool both get the default block; \"off\" normalizes to false", () => {
    const expected = { maxOutputTokens: 512, thinking: false, temperature: 0.1, topK: 50, repeatPenalty: 1.1 };
    expect(resolveRequestOptions(CFG, "batch_check")).toEqual(expected);
    expect(resolveRequestOptions(CFG, undefined)).toEqual(expected);
  });

  it("no max_output_tokens anywhere -> throws (fail fast)", () => {
    expect(() => resolveRequestOptions({ default: { temperature: 0.2 } }, "chat")).toThrow(/max_output_tokens/);
  });
});

describe("applyRequestOptions / effectiveMaxTokens", () => {
  const body = { messages: [], temperature: 0.7, max_tokens: 9999, stream: false };

  it("the cap is a ceiling: min(caller, profile) and the profile cap when the caller set none", () => {
    const ro = { maxOutputTokens: 100 };
    expect(effectiveMaxTokens(ro, 5000)).toBe(100);
    expect(effectiveMaxTokens(ro, 40)).toBe(40);
    expect(effectiveMaxTokens(ro, undefined)).toBe(100);
  });

  it("sets sampling fields and chat_template_kwargs only when present, and never mutates the input", () => {
    const out = applyRequestOptions(body, { maxOutputTokens: 100, thinking: false, temperature: 0.1, topK: 50, repeatPenalty: 1.1 }, undefined);
    expect(out).toEqual({
      messages: [],
      temperature: 0.1,
      max_tokens: 100,
      stream: false,
      top_k: 50,
      repeat_penalty: 1.1,
      chat_template_kwargs: { enable_thinking: false },
    });
    expect(body.max_tokens).toBe(9999);
    const bare = applyRequestOptions(body, { maxOutputTokens: 100 }, undefined);
    expect(bare).toEqual({ messages: [], temperature: 0.7, max_tokens: 100, stream: false });
  });

  it("thinking true sends enable_thinking true", () => {
    expect(applyRequestOptions(body, { maxOutputTokens: 100, thinking: true }, undefined).chat_template_kwargs).toEqual({ enable_thinking: true });
  });
});

describe("withStopInstruction", () => {
  it("appends to the first system message of a copy; never adds a second system message", () => {
    const input: ChatMessage[] = [
      { role: "system", content: "SYS" },
      { role: "user", content: "u" },
    ];
    const out = withStopInstruction(input, 64);
    expect(out).toHaveLength(2);
    expect(out[0]!.content).toMatch(/^SYS\n\n.*fit in 64 tokens/);
    expect(input[0]!.content).toBe("SYS");
  });

  it("prepends one system message when none exists", () => {
    const out = withStopInstruction([{ role: "user", content: "u" }], 64);
    expect(out.map((m) => m.role)).toEqual(["system", "user"]);
  });

  it("O4: appends to a system message that is not first and adds no second one", () => {
    const out = withStopInstruction(
      [
        { role: "user", content: "u" },
        { role: "system", content: "SYS" },
      ],
      64,
    );
    expect(out.map((m) => m.role)).toEqual(["user", "system"]);
    expect(out[1]!.content).toMatch(/^SYS\n\n.*fit in 64 tokens/);
  });
});

describe("OutputLimitError", () => {
  it("short prefixed message ending with the fix hint; counts in the message", () => {
    const e = new OutputLimitError({ tool: "chat", model: "m", maxTokens: 10, callerCap: false, completionTokens: 10, partial: "a".repeat(1000) });
    expect(e.message.startsWith(OUTPUT_LIMIT_PREFIX)).toBe(true);
    expect(e.message.endsWith("or set thinking off.")).toBe(true);
    expect(e.message).toContain("request_options.chat.max_output_tokens");
    expect(e.message).toContain("10 completion tokens, 1000 chars");
    expect(e.message.length).toBeLessThan(400);
    expect(e.partialChars).toBe(1000);
  });

  it("O2: a tool that is not a valid block key names request_options.default", () => {
    const e = new OutputLimitError({ tool: "batch_check", model: "m", maxTokens: 10, callerCap: false, completionTokens: 10, partial: "x" });
    expect(e.message).toContain("request_options.default.max_output_tokens");
    expect(e.message).not.toContain("request_options.batch_check");
  });

  it("O2: a cap that came from the caller's own smaller max_tokens says so", () => {
    const e = new OutputLimitError({ tool: "chat", model: "m", maxTokens: 10, callerCap: true, completionTokens: 10, partial: "x" });
    expect(e.message).toContain("changes nothing");
    expect(e.message).not.toContain("Raise request_options");
  });
});

const local = (extra: Record<string, unknown> = {}): Profile =>
  ({ "profile-type": "local", mode: "local", api: "llamacpp-local", url: "http://127.0.0.1:8181", model: "m", ...extra }) as unknown as Profile;
const errs = (extra: Record<string, unknown>, name = "ll"): string => validateProfile(name, local(extra)).errors.join("\n");

describe("request_options validation", () => {
  it("accepts a full block, including thinking true/false/\"on\"/\"off\"", () => {
    for (const thinking of [true, false, "on", "off"]) {
      expect(errs({ request_options: { default: { max_output_tokens: 512, thinking }, chat: { top_k: 40 } } })).toBe("");
    }
  });

  it("YAML 1.2 loads an unquoted off as the string \"off\" and that value validates", () => {
    const doc = yamlParse("request_options:\n  default:\n    thinking: off\n    max_output_tokens: 256\n") as Record<string, unknown>;
    expect((doc.request_options as { default: { thinking: unknown } }).default.thinking).toBe("off");
    expect(errs(doc)).toBe("");
  });

  it("refuses an unknown tool, an unknown field, a bad thinking value and a missing default.max_output_tokens", () => {
    expect(errs({ request_options: { default: { max_output_tokens: 1 }, securty_scan: { top_k: 1 } } })).toMatch(/unknown tool 'securty_scan'/);
    expect(errs({ request_options: { default: { max_output_tokens: 1, input_fill_pct: 30 } } })).toMatch(/unknown field 'input_fill_pct'/);
    expect(errs({ request_options: { default: { max_output_tokens: 1, structured_output: true } } })).toMatch(/unknown field 'structured_output'/);
    expect(errs({ request_options: { default: { max_output_tokens: 1, thinking: "maybe" } } })).toMatch(/thinking must be/);
    expect(errs({ request_options: { chat: { max_output_tokens: 1 } } })).toMatch(/default\.max_output_tokens is required/);
    expect(errs({ request_options: { default: { temperature: 0.1 } } })).toMatch(/default\.max_output_tokens is required/);
  });

  it("refuses out-of-range values and a non-map", () => {
    expect(errs({ request_options: { default: { max_output_tokens: 0 } } })).toMatch(/max_output_tokens must be an integer/);
    expect(errs({ request_options: { default: { max_output_tokens: 5, temperature: 3 } } })).toMatch(/temperature/);
    expect(errs({ request_options: { default: { max_output_tokens: 5, top_k: -1 } } })).toMatch(/top_k/);
    expect(errs({ request_options: { default: { max_output_tokens: 5, repeat_penalty: 0 } } })).toMatch(/repeat_penalty/);
    expect(errs({ request_options: "x" })).toMatch(/request_options must be a map/);
  });

  it("refuses max_output_tokens >= context_window", () => {
    expect(errs({ context_window: 4096, request_options: { default: { max_output_tokens: 4096 } } })).toMatch(/smaller than context_window/);
    expect(errs({ context_window: 4096, request_options: { default: { max_output_tokens: 4095 } } })).toBe("");
  });

  it("is refused on a paid profile (local only)", () => {
    const paid = { "profile-type": "paid", mode: "remote", api: "openrouter-remote", model: "vendor/m", api_key: "k", request_options: { default: { max_output_tokens: 5 } } } as unknown as Profile;
    expect(validateProfile("p", paid).errors.join("\n")).toMatch(/request_options belongs to type local, not 'paid'/);
  });

  it("O1: refused on an LM Studio native profile (api lmstudio-local)", () => {
    expect(errs({ api: "lmstudio-local", url: "http://127.0.0.1:1234", request_options: CFG })).toMatch(/not supported on api 'lmstudio-local'/);
  });

  it("O6: an explicit null or empty request_options is an error, an absent key is fine", () => {
    expect(errs({ request_options: null })).toMatch(/request_options is empty; remove the key or add a default block/);
    expect(errs({ request_options: {} })).toMatch(/request_options is empty/);
    expect(errs({})).toBe("");
  });
});

describe("resolveProfile", () => {
  it("carries request_options through, and null when absent or malformed", () => {
    expect(resolveProfile("ll", local({ request_options: CFG })).requestOptions).toEqual(CFG);
    expect(resolveProfile("ll", local()).requestOptions).toBeNull();
    expect(resolveProfile("ll", local({ request_options: "x" })).requestOptions).toBeNull();
  });
});
