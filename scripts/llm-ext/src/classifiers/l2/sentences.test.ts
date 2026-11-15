// TRDD-S5KOOT2S Phase 2: the sentence splitter, pure (no network, no files).
import { describe, expect, it } from "vitest";
import { splitSentences } from "./sentences.js";

const texts = (s: string): string[] => splitSentences(s).map((x) => x.text);

describe("splitSentences", () => {
  it("splits the lowercase prose line Intl.Segmenter returns as one segment, and keeps e.g. inside its sentence", () => {
    // WHY this exact line: it is the failure case that ruled out Intl.Segmenter (TRDD-S5KOOT2S), where the whole line came back as ONE segment.
    const got = splitSentences("the colors are horrible. the loading screen background should be blue. e.g. use #00f!");
    expect(got.map((x) => x.text)).toEqual(["the colors are horrible.", "the loading screen background should be blue.", "e.g. use #00f!"]);
    expect(got.map((x) => x.id)).toEqual(["s1", "s2", "s3"]);
    expect(got.every((x) => x.kind === "text")).toBe(true);
  });

  it("starts a segment at every list marker and at a blank line, and joins soft-wrapped lines", () => {
    expect(texts("intro line\ncontinues here.\n\n- first item. with two sentences\n* second\n1. third\n2) fourth")).toEqual([
      "intro line continues here.", "first item.", "with two sentences", "second", "third", "fourth",
    ]);
  });

  it("does not split after an abbreviation, a single-letter initial, or inside backticks and quotes", () => {
    // "who." is a real sentence end; "j." (initial), "dr." and "etc." are not.
    expect(texts("ask j. smith about dr. who. etc. next")).toEqual(["ask j. smith about dr. who.", "etc. next"]);
    expect(texts("use `a. b` and \"x. y\" ok. then stop")).toEqual(["use `a. b` and \"x. y\" ok.", "then stop"]);
    expect(texts("say “one. two” now. done")).toEqual(["say “one. two” now.", "done"]);
  });

  it("treats a run of terminators and a glued closing bracket as one boundary", () => {
    expect(texts("really?! (yes.) ok... fine")).toEqual(["really?!", "(yes.)", "ok...", "fine"]);
  });

  it("makes a fenced code block one code segment and numbers it with the text around it", () => {
    const got = splitSentences("make it blue. here is the css:\n```css\n.a { color: blue; }\n. not a sentence.\n```\nthen rebuild.");
    expect(got.map((x) => [x.id, x.kind])).toEqual([["s1", "text"], ["s2", "text"], ["s3", "code"], ["s4", "text"]]);
    expect(got[2]!.text).toBe("```css\n.a { color: blue; }\n. not a sentence.\n```");
  });

  it("keeps an unterminated fence as code, and returns nothing for a blank text", () => {
    expect(splitSentences("a.\n```\nopen")).toMatchObject([{ kind: "text" }, { kind: "code", text: "```\nopen" }]);
    expect(splitSentences("  \n\n")).toEqual([]);
  });

  it("reads CRLF line endings like LF", () => {
    expect(texts("one.\r\n\r\n- two\r\n- three.")).toEqual(["one.", "two", "three."]);
  });
});
