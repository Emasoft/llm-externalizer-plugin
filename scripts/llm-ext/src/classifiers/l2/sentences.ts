// TRDD-S5KOOT2S Phase 2: the sentence splitter of `classify requirements`. A TypeScript port of scripts_dev/req-extract/split.mjs, the splitter every measurement of that card used, so what ships is what was measured.
// WHY a custom splitter and not Intl.Segmenter: ICU starts a sentence only before an uppercase letter, and the user writes lowercase ("the colors are horrible. the loading screen background should be blue." came back as ONE segment).
// Rules: a blank line or a list marker starts a segment; soft-wrapped lines join; inside a segment a sentence ends after [.!?]+ plus whitespace whatever the case of the next letter, except after a listed abbreviation or a single-letter initial, or inside backticks or quotes; a fenced code block is one `code` segment.

export interface Sentence {
  /** s1, s2, ... over ALL segments in order, code segments included, so an id names the same place whether or not the segment is scored. */
  id: string;
  text: string;
  kind: "text" | "code";
}

// Compared lowercase, without the final dot.
const ABBREV = new Set(["e.g", "i.e", "etc", "vs", "cf", "approx", "mr", "mrs", "ms", "dr", "prof", "st", "no"]);
const LIST_MARKER = /^\s*(?:[-*•]|\d+[.)])\s+/;
const FENCE = /^\s*```/;
const TERMINATOR = /[.!?]/;

function splitSegmentText(seg: string): string[] {
  const out: string[] = [];
  let start = 0;
  let inTick = false;
  let inDq = false;
  let inCurly = false;
  for (let i = 0; i < seg.length; i++) {
    const c = seg.charAt(i);
    if (c === "`") inTick = !inTick;
    else if (c === '"' && !inTick) inDq = !inDq;
    else if (c === "“" && !inTick) inCurly = true;
    else if (c === "”" && !inTick) inCurly = false;
    if (inTick || inDq || inCurly) continue;
    if (c !== "." && c !== "!" && c !== "?") continue;
    // The whole run of terminators ("?!", "...") is one boundary.
    let j = i;
    while (j + 1 < seg.length && TERMINATOR.test(seg.charAt(j + 1))) j++;
    // An optional closing bracket glued to the terminator stays with the sentence.
    let k = j;
    if (k + 1 < seg.length && /[)\]]/.test(seg.charAt(k + 1))) k++;
    const atEnd = k + 1 >= seg.length;
    const nextIsSpace = !atEnd && /\s/.test(seg.charAt(k + 1));
    if (atEnd || nextIsSpace) {
      const lastTok = (seg.slice(start, i).split(/\s+/).pop() ?? "").replace(/^[("'“‘[]+/, "");
      const isAbbrev = seg.slice(i, j + 1) === "." && (ABBREV.has(lastTok.toLowerCase()) || /^[A-Za-z]$/.test(lastTok));
      if (!isAbbrev && !atEnd) {
        out.push(seg.slice(start, k + 1));
        start = k + 1;
      }
    }
    i = k;
  }
  out.push(seg.slice(start));
  return out.map((s) => s.replace(/\s+/g, " ").trim()).filter((s) => s.length > 0);
}

export function splitSentences(text: string): Sentence[] {
  const segs: { text: string; kind: "text" | "code" }[] = [];
  let cur: string | null = null;
  let fence: string[] | null = null;
  const flush = (): void => {
    if (cur !== null && cur.length > 0) segs.push({ text: cur, kind: "text" });
    cur = null;
  };
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (fence !== null) {
      fence.push(line);
      if (FENCE.test(line)) {
        segs.push({ text: fence.join("\n"), kind: "code" });
        fence = null;
      }
      continue;
    }
    if (FENCE.test(line)) {
      flush();
      fence = [line];
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    if (LIST_MARKER.test(line)) {
      flush();
      cur = line.replace(LIST_MARKER, "");
      continue;
    }
    cur = cur === null ? line.trim() : `${cur} ${line.trim()}`;
  }
  // An unterminated fence is kept as code: the rest of the prompt is code, never scored as prose.
  if (fence !== null) segs.push({ text: (fence as string[]).join("\n"), kind: "code" });
  flush();
  const result: Sentence[] = [];
  let n = 0;
  for (const s of segs) {
    if (s.kind === "code") {
      result.push({ id: `s${++n}`, text: s.text, kind: "code" });
      continue;
    }
    for (const t of splitSegmentText(s.text)) result.push({ id: `s${++n}`, text: t, kind: "text" });
  }
  return result;
}
