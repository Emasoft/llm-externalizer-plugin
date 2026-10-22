import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { catalogCachePath } from "../../catalog-cache.js";
import { DECISIONS_CATALOG_URL, loadDecisionsCatalog } from "./catalog.js";
import { replayFetch, syntheticResponse, type RecordedReply } from "./test-fetch.js";

// Passthrough fs that only counts reads of a named file; the real code runs unchanged.
const fsReads = vi.hoisted(() => ({ file: "", count: 0 }));
vi.mock("node:fs", async (orig) => {
  const real = await orig<typeof import("node:fs")>();
  return { ...real, readFileSync: ((p: unknown, ...rest: unknown[]) => { if (p === fsReads.file) fsReads.count++; return (real.readFileSync as (...a: unknown[]) => unknown)(p, ...rest); }) as typeof real.readFileSync };
});

const fx = (n: string): RecordedReply => JSON.parse(readFileSync(new URL(`../__fixtures__/p02/${n}.json`, import.meta.url), "utf-8"));
const root = mkdtempSync("/tmp/llm-ext-l0-catalog-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
const NOW = 1_800_000_000_000;
const fresh = () => { const d = mkdtempSync(join(root, "c-")); return { path: join(d, "decisions.json"), d }; };

describe("loadDecisionsCatalog", () => {
  it("maps the recorded catalog and requests the decisions-only URL", async () => {
    const { path } = fresh();
    const r = replayFetch([fx("models-decisions")]);
    const models = await loadDecisionsCatalog({ fetch: r.fetch, now: NOW, path });
    expect(r.calls.map((c) => c.url)).toEqual([DECISIONS_CATALOG_URL]);
    expect(DECISIONS_CATALOG_URL).toContain("output_modalities=decisions");
    expect(models).toHaveLength(16);
    const alias = models.find((m) => m.id === "~typesafe/jev-latest")!;
    expect(alias.aliasTarget).toBe("typesafe/jev-1.13");
    const target = models.find((m) => m.id === "typesafe/jev-1.13")!;
    expect(target).toMatchObject({ canonicalSlug: "typesafe/jev-1.13-20260917", contextTokens: 64000, outputModalities: ["decisions"], systemOne: true });
    expect(target.aliasTarget).toBeUndefined();
    expect(target.promptUsdPerM).toBeCloseTo(0.042, 9);
    expect(models.find((m) => m.id === "inception/mercury-decide:free")!.promptUsdPerM).toBe(0);
    expect(models.find((m) => m.id === "respan/span-01")!.contextTokens).toBeNull();
    expect(models.find((m) => m.id === "perplexity/pplx-decider-v1.1-27b")!.systemOne).toBe(false);
  });

  it("uses its own cache file, not the shared catalog cache", async () => {
    const { path } = fresh();
    await loadDecisionsCatalog({ fetch: replayFetch([fx("models-decisions")]).fetch, now: NOW, path });
    expect(existsSync(path)).toBe(true);
    expect(path).not.toBe(catalogCachePath());
  });

  it("the default cache path differs from the shared catalog cache path", async () => {
    const { defaultDecisionsCachePath } = await import("./catalog.js");
    expect(defaultDecisionsCachePath()).not.toBe(catalogCachePath());
  });

  it("serves a fresh cache without any request, and refetches once the TTL has passed", async () => {
    const { path } = fresh();
    await loadDecisionsCatalog({ fetch: replayFetch([fx("models-decisions")]).fetch, now: NOW, path, ttlMs: 1000 });
    const none = replayFetch([]);
    expect(await loadDecisionsCatalog({ fetch: none.fetch, now: NOW + 999, path, ttlMs: 1000 })).toHaveLength(16);
    expect(none.calls).toHaveLength(0);
    const again = replayFetch([fx("models-decisions")]);
    await loadDecisionsCatalog({ fetch: again.fetch, now: NOW + 1000, path, ttlMs: 1000 });
    expect(again.calls).toHaveLength(1);
  });

  it("E16: expired cache plus a failed refresh throws an error naming the catalog URL", async () => {
    const { path } = fresh();
    await loadDecisionsCatalog({ fetch: replayFetch([fx("models-decisions")]).fetch, now: NOW, path, ttlMs: 1000 });
    const bad = replayFetch([syntheticResponse(503, "<html>down</html>")]);
    const err = await loadDecisionsCatalog({ fetch: bad.fetch, now: NOW + 5000, path, ttlMs: 1000 }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(DECISIONS_CATALOG_URL);
    expect((err as Error).message).toContain("503");
  });

  it("E16: with no cache at all a failed fetch also throws, naming the URL", async () => {
    const { path } = fresh();
    const net: typeof fetch = async () => { throw new Error("ECONNREFUSED"); };
    await expect(loadDecisionsCatalog({ fetch: net as never, now: NOW, path })).rejects.toThrow(DECISIONS_CATALOG_URL);
  });

  it("E16: inside the 60 s failure window the stale cache is not served silently", async () => {
    const { path } = fresh();
    await loadDecisionsCatalog({ fetch: replayFetch([fx("models-decisions")]).fetch, now: NOW, path, ttlMs: 1000 });
    const first = replayFetch([syntheticResponse(503, "down")]);
    await expect(loadDecisionsCatalog({ fetch: first.fetch, now: NOW + 5000, path, ttlMs: 1000 })).rejects.toThrow(DECISIONS_CATALOG_URL);
    const second = replayFetch([]);
    await expect(loadDecisionsCatalog({ fetch: second.fetch, now: NOW + 15_000, path, ttlMs: 1000 })).rejects.toThrow(DECISIONS_CATALOG_URL);
    expect(second.calls).toHaveLength(0);
  });

  it("rejects a 200 reply whose body is not a catalog", async () => {
    const { path } = fresh();
    const r = replayFetch([syntheticResponse(200, "{\"nope\":1}")]);
    await expect(loadDecisionsCatalog({ fetch: r.fetch, now: NOW, path })).rejects.toThrow(DECISIONS_CATALOG_URL);
  });

  it("takes the lock: a stale lock directory is cleared and released after the load", async () => {
    const { path, d } = fresh();
    const lock = `${path}.lock`;
    mkdirSync(lock);
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    await loadDecisionsCatalog({ fetch: replayFetch([fx("models-decisions")]).fetch, now: NOW, path });
    expect(existsSync(lock)).toBe(false);
    expect(existsSync(d)).toBe(true);
    writeFileSync(join(d, "keep"), "");
  });
});

describe("loadDecisionsCatalog cache reads", () => {
  it("a load served from a fresh cache reads the cache file exactly once", async () => {
    const { path } = fresh();
    await loadDecisionsCatalog({ fetch: replayFetch([fx("models-decisions")]).fetch, now: NOW, path, ttlMs: 1000 });
    fsReads.file = path;
    fsReads.count = 0;
    expect(await loadDecisionsCatalog({ fetch: replayFetch([]).fetch, now: NOW + 1, path, ttlMs: 1000 })).toHaveLength(16);
    fsReads.file = "";
    expect(fsReads.count).toBe(1);
  });
});
