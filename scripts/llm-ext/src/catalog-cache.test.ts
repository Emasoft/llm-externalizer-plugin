// catalog-cache.ts -- real filesystem I/O against a per-test isolated cache
// file. No mocks of the code under test.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCatalog, parseCatalogTtlMs, DEFAULT_CATALOG_TTL_MS, NEGATIVE_TTL_MS } from "./catalog-cache.js";

let dir: string;
let cachePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "llmext-catcache-"));
  cachePath = join(dir, "catalog-cache.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("parseCatalogTtlMs", () => {
  it("unset/blank -> default; 0 is a valid 'always fetch' value; junk/negative -> default", () => {
    expect(parseCatalogTtlMs(undefined)).toBe(DEFAULT_CATALOG_TTL_MS);
    expect(parseCatalogTtlMs("")).toBe(DEFAULT_CATALOG_TTL_MS);
    expect(parseCatalogTtlMs("0")).toBe(0);
    expect(parseCatalogTtlMs("1234")).toBe(1234);
    expect(parseCatalogTtlMs("nonsense")).toBe(DEFAULT_CATALOG_TTL_MS);
    expect(parseCatalogTtlMs("-1")).toBe(DEFAULT_CATALOG_TTL_MS);
  });
});

describe("getCatalog", () => {
  it("a fresh cache within the TTL is served without calling the fetcher", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return [{ id: "a" }];
    };
    const models1 = await getCatalog(fetcher, 1_000, { ttlMs: 10_000, path: cachePath });
    expect(models1).toEqual([{ id: "a" }]);
    expect(calls).toBe(1);

    const models2 = await getCatalog(fetcher, 5_000, { ttlMs: 10_000, path: cachePath });
    expect(models2).toEqual([{ id: "a" }]);
    expect(calls).toBe(1); // second call within TTL never hit the fetcher
  });

  it("an expired cache re-fetches", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return [{ id: `v${calls}` }];
    };
    await getCatalog(fetcher, 1_000, { ttlMs: 1_000, path: cachePath });
    const models = await getCatalog(fetcher, 3_000, { ttlMs: 1_000, path: cachePath });
    expect(calls).toBe(2);
    expect(models).toEqual([{ id: "v2" }]);
  });

  it("ttlMs=0 means always fetch, even immediately after a successful fetch", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return [{ id: `v${calls}` }];
    };
    await getCatalog(fetcher, 1_000, { ttlMs: 0, path: cachePath });
    await getCatalog(fetcher, 1_001, { ttlMs: 0, path: cachePath });
    expect(calls).toBe(2);
  });

  it("a failed fetch serves the stale cache and is negative-cached: two calls within 60s make one fetch attempt", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls++;
      if (calls === 1) return [{ id: "good" }];
      throw new Error("provider down");
    };
    // Prime a good cache, then let it expire.
    await getCatalog(fetcher, 1_000, { ttlMs: 500, path: cachePath });
    const afterFailure = await getCatalog(fetcher, 2_000, { ttlMs: 500, path: cachePath });
    expect(calls).toBe(2); // the one real failing attempt
    expect(afterFailure).toEqual([{ id: "good" }]); // stale cache served on failure

    // A second call within NEGATIVE_TTL_MS of the failure must NOT re-attempt.
    const stillNegativeCached = await getCatalog(fetcher, 2_000 + NEGATIVE_TTL_MS - 1, {
      ttlMs: 500,
      path: cachePath,
    });
    expect(calls).toBe(2); // no new fetch attempt
    expect(stillNegativeCached).toEqual([{ id: "good" }]);
  });

  it("a failed fetch with no prior cache serves [] and negative-caches", async () => {
    const fetcher = async () => {
      throw new Error("network unreachable");
    };
    const models = await getCatalog(fetcher, 1_000, { ttlMs: 500, path: cachePath });
    expect(models).toEqual([]);
    expect(existsSync(cachePath)).toBe(true);
    const raw = JSON.parse(readFileSync(cachePath, "utf-8"));
    expect(raw.failedAtMs).toBe(1_000);
  });

  it("past the negative-cache window, a fetch is retried", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls++;
      if (calls === 1) throw new Error("down");
      return [{ id: "recovered" }];
    };
    await getCatalog(fetcher, 1_000, { ttlMs: 500, path: cachePath });
    const models = await getCatalog(fetcher, 1_000 + NEGATIVE_TTL_MS, { ttlMs: 500, path: cachePath });
    expect(calls).toBe(2);
    expect(models).toEqual([{ id: "recovered" }]);
  });

  it("a corrupt cache file is treated as absent (fail-open)", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(cachePath, "{not json", "utf-8");
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return [{ id: "fresh" }];
    };
    const models = await getCatalog(fetcher, 1_000, { ttlMs: 500, path: cachePath });
    expect(calls).toBe(1);
    expect(models).toEqual([{ id: "fresh" }]);
  });
});
