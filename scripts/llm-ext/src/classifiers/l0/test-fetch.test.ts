import { describe, expect, it } from "vitest";
import { replayFetch, replayFixture, syntheticResponse } from "./test-fetch.js";

describe("GlobalFetch test helper", () => {
  it("replays a recorded fixture as a Response with headers", async () => {
    const res = replayFixture({
      status: 429,
      headers: { "retry-after-ms": "1500", "content-type": "application/json" },
      body: "{\"error\":{\"code\":429}}",
    });
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after-ms")).toBe("1500");
    expect(await res.json()).toEqual({ error: { code: 429 } });
  });

  it("an already-aborted signal rejects the call and leaves the queued reply for the next call", async () => {
    const r = replayFetch([{ status: 200, headers: {}, body: "ok" }]);
    const ac = new AbortController();
    ac.abort();
    await expect(r.fetch("https://x/1", { signal: ac.signal })).rejects.toThrow("This operation was aborted");
    expect(await (await r.fetch("https://x/2", {})).text()).toBe("ok");
    expect(r.calls.map((c) => c.url)).toEqual(["https://x/1", "https://x/2"]);
  });

  it("synthetic: builds a Response for an HTML body with a Retry-After header", async () => {
    const res = syntheticResponse(503, "<html>down</html>", { "Retry-After": "7" });
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("7");
    expect(await res.text()).toBe("<html>down</html>");
  });

  it("serves replies in order, records calls and fails when exhausted", async () => {
    const r = replayFetch([syntheticResponse(500, "a"), { status: 200, headers: {}, body: "b" }]);
    expect((await r.fetch("https://x/1", { method: "POST" })).status).toBe(500);
    expect(await (await r.fetch("https://x/2", {})).text()).toBe("b");
    expect(r.calls.map((c) => c.url)).toEqual(["https://x/1", "https://x/2"]);
    await expect(r.fetch("https://x/3", {})).rejects.toThrow(/no reply left/);
  });
});
