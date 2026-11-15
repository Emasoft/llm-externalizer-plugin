/**
 * readAllFrom (TRDD-S3QEQBYV): real PassThrough streams, no stdin double.
 */

import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { readAllFrom } from "./read-all.js";

describe("readAllFrom", () => {
  it("returns the bytes of an ended stream", async () => {
    const s = new PassThrough();
    s.end(Buffer.from("hello stdin"));
    const out = await readAllFrom(s);
    expect(Buffer.isBuffer(out)).toBe(true);
    expect(out.equals(Buffer.from("hello stdin"))).toBe(true);
  });

  it("round-trips binary bytes unchanged", async () => {
    const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0xc3, 0x28, 0x00, 0x7f]);
    const s = new PassThrough();
    s.write(bytes.subarray(0, 3));
    s.end(bytes.subarray(3));
    const out = await readAllFrom(s);
    expect(out.equals(bytes)).toBe(true);
  });

  it("returns an empty Buffer for an empty ended stream", async () => {
    const s = new PassThrough();
    s.end();
    const out = await readAllFrom(s);
    expect(Buffer.isBuffer(out)).toBe(true);
    expect(out.length).toBe(0);
  });

  it("collects chunks written after reading has started", async () => {
    // WHY (TRDD-S3QEQBYV): a loop that keeps only the first chunk passes the pre-ended tests; reading must start before the writes land.
    const a = Buffer.from([0x68, 0x69, 0xff, 0xfe]);
    const b = Buffer.from([0xc3, 0x28, 0x6f, 0x6b]);
    const s = new PassThrough();
    const p = readAllFrom(s);
    p.catch(() => {}); // WHY: attach a handler at once so an early rejection is not reported as unhandled; the later await still sees it.
    s.write(a);
    await new Promise((r) => setImmediate(r));
    s.end(b);
    expect((await p).equals(Buffer.concat([a, b]))).toBe(true);
  });

  describe("Node premise behind the never-called check (readableDidRead)", () => {
    it("an ended stream holding bytes that nobody reads keeps readableDidRead false", async () => {
      // WHY (TRDD-S3QEQBYV): proves an untouched ended stream still reads as never-called after the event loop has turned.
      const s = new PassThrough();
      s.end(Buffer.from("ended never read"));
      await new Promise((r) => setImmediate(r));
      expect(s.readableDidRead).toBe(false);
    });

    it("an ended stream with bytes read through readAllFrom flips readableDidRead true", async () => {
      // WHY (TRDD-S3QEQBYV): the positive control in the exact form the conversions use; proves the never-called assertion can fail.
      const bytes = Buffer.from("read me ended");
      const s = new PassThrough();
      s.end(bytes);
      const out = await readAllFrom(s);
      expect(s.readableDidRead).toBe(true);
      expect(out.equals(bytes)).toBe(true);
    });

    it("a stream read through readAllFrom flips readableDidRead true and drains readableLength to 0", async () => {
      // WHY (TRDD-S3QEQBYV): Node premise control on an UNENDED stream, not the conversion protocol form (the protocol uses ENDED streams); proves the check flips once the reader starts, even before the stream ends.
      const s = new PassThrough();
      s.write(Buffer.from("read me"));
      const p = readAllFrom(s);
      p.catch(() => {}); // WHY: attach a handler at once so an early rejection is not reported as unhandled; the later await still sees it.
      try {
        await new Promise((r) => setImmediate(r));
        expect(s.readableDidRead).toBe(true);
        expect(s.readableLength).toBe(0);
      } finally {
        s.end();
      }
      await p;
    });
  });
});
