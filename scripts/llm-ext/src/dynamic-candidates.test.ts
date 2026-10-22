// Real filesystem tests for the dynamic-profile candidate queue (design §2.4).
// No mocks — a real tmp config dir, real file reads/writes.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "./test-tmp-root.js";
import { join } from "node:path";

import { readCandidates, enqueueCandidates, clearCandidates, candidateQueuePath } from "./dynamic-candidates.js";
import { getSettingsPath, loadSettings, resolveGroups, type ResolvedRoute } from "./config.js";

import { getCatalog, readCachedModelPrice, catalogFetchRecentlyFailed } from "./catalog-cache.js";

// Row 17 (TRDD-OE27RD7I): wrap every catalog-cache entry point in a spy that
// still calls through, so the pruning test below can assert the queue read
// path never consults the model catalog (it must stay pure on routesFor / ":free").
vi.mock("./catalog-cache.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./catalog-cache.js")>();
  return {
    ...actual,
    getCatalog: vi.fn(actual.getCatalog),
    readCachedModelPrice: vi.fn(actual.readCachedModelPrice),
    catalogFetchRecentlyFailed: vi.fn(actual.catalogFetchRecentlyFailed),
  };
});

/** No known routes at all — the "caller looked, nothing routed" lookup every
 *  test below passes explicitly now that readCandidates requires one
 *  (3c/3e: no more hidden internal loadSettings()/null opt-out; D6a changed
 *  the shape from a Map to the routesFor function). */
const NO_ROUTES = (): (modelId: string) => ResolvedRoute[] => (): ResolvedRoute[] => [];

describe("dynamic-candidates", () => {
  let cfg = "";
  let prevCfgDir: string | undefined;

  beforeEach(() => {
    cfg = mkdtempSync(join(tmpdir(), "dynamic-candidates-"));
    prevCfgDir = process.env.LLM_EXT_CONFIG_DIR;
    process.env.LLM_EXT_CONFIG_DIR = cfg;
  });

  afterEach(() => {
    if (prevCfgDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
    else process.env.LLM_EXT_CONFIG_DIR = prevCfgDir;
    rmSync(cfg, { recursive: true, force: true });
  });

  it("readCandidates on a missing file returns an empty queue", () => {
    expect(readCandidates(NO_ROUTES())).toEqual({ version: 1, free: [], paid: [], local: [] });
  });

  it("enqueueCandidates appends and dedupes by id — a re-enqueued id keeps its original queuedAt", () => {
    enqueueCandidates("free", ["v/alpha:free"], 1000);
    const after = enqueueCandidates("free", ["v/alpha:free", "v/beta:free"], 2000);
    expect(after.free).toEqual([
      { id: "v/alpha:free", queuedAt: 1000 },
      { id: "v/beta:free", queuedAt: 2000 },
    ]);
    // paid queue is untouched by a free enqueue.
    expect(after.paid).toEqual([]);
  });

  it("clearCandidates removes only the given ids — everything else in the queue survives", () => {
    enqueueCandidates("paid", ["v/a", "v/b", "v/c"], 1000);
    const after = clearCandidates("paid", ["v/b"]);
    expect(after.paid.map((e) => e.id)).toEqual(["v/a", "v/c"]);
  });

  it("a corrupt queue file is treated as empty (fail-open), not a throw", () => {
    writeFileSync(candidateQueuePath(), "{ not json", "utf-8");
    expect(readCandidates(NO_ROUTES())).toEqual({ version: 1, free: [], paid: [], local: [] });
  });

  it("a wrongly-shaped queue file (missing free/paid arrays) is treated as empty", () => {
    writeFileSync(candidateQueuePath(), JSON.stringify({ version: 1 }), "utf-8");
    expect(readCandidates(NO_ROUTES())).toEqual({ version: 1, free: [], paid: [], local: [] });
  });

  it("writes are atomic (tmp + rename) — no .tmp file survives a successful enqueue", () => {
    enqueueCandidates("free", ["v/x:free"]);
    const leftovers = readdirSync(cfg).filter((f) => f.includes(".tmp."));
    expect(leftovers).toEqual([]);
  });

  // Fix-queue row 95e: `local` is always empty by design (no catalog
  // benchmark ever defers a local id), but a queue file that somehow carries
  // a non-empty `local` array used to be silently dropped — a writer bug
  // that started queuing local candidates would have gone unnoticed forever.
  it("a queue file carrying a non-empty 'local' array is dropped LOUDLY (stderr) and returns local: []", () => {
    const path = candidateQueuePath();
    writeFileSync(
      path,
      JSON.stringify({ version: 1, free: [], paid: [], local: [{ id: "stray/local-id", queuedAt: 1 }] }),
      "utf-8",
    );
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const after = readCandidates(NO_ROUTES());
    // Read the recorded calls before restoring — mockRestore() also clears
    // .mock.calls, so the assertion below would always see nothing otherwise.
    const logged = errSpy.mock.calls.map((c) => String(c[0])).join("");
    errSpy.mockRestore();

    expect(logged).toContain(path);
    // Row 96(2): "1 entries" was a plural-agreement bug — a single stray
    // entry must read "1 entry".
    expect(logged).toContain("local never queues candidates; ignoring 1 entry");
    expect(after.local).toEqual([]);
  });

  // Row 96(2): readCandidates used to log ONLY a non-empty ARRAY; a `local`
  // that is present but not an array at all (e.g. a stray string written by
  // a future bad migration) slipped through silently. Assert the widened
  // condition (`q.local !== undefined && (!Array.isArray(q.local) || ...)`)
  // catches this shape too.
  it("a queue file carrying a non-array, non-undefined 'local' is dropped LOUDLY (stderr) and returns local: []", () => {
    const path = candidateQueuePath();
    writeFileSync(
      path,
      JSON.stringify({ version: 1, free: [], paid: [], local: "not-an-array" }),
      "utf-8",
    );
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const after = readCandidates(NO_ROUTES());
    const logged = errSpy.mock.calls.map((c) => String(c[0])).join("");
    errSpy.mockRestore();

    expect(logged).toContain(path);
    expect(logged).toContain("local never queues candidates; ignoring a non-array value");
    expect(after.local).toEqual([]);
  });

  // TRDD-38QAM06E queue hygiene: fix-queue row 82's root cause (fixed separately
  // in default-profiles.ts) used to enqueue EVERY b.ai catalog id, not just the
  // one with a recorded `providers[]` route — a machine that hit that bug before
  // the fix landed still carries the stray ids on disk (46/68 in the P6d run).
  // readCandidates is the migration: it prunes a 'free' queue entry that is
  // neither ':free'-suffixed nor bound to a free-provider route on the CURRENT
  // 'free' profile, on every read, so no separate repair script is needed.
  it("readCandidates prunes stray unrouted 'free' candidate ids and logs the count once", () => {
    // A 'free' profile with NO providers route recorded for any of the three
    // stray ids — exactly the poisoned-queue shape fix-queue 82 produced.
    writeFileSync(
      getSettingsPath(),
      [
        "profiles:",
        "  free:",
        "    mode: remote",
        "    api: openrouter-remote",
        "    api_key: $OPENROUTER_API_KEY",
        "    free_only: true",
        "    free_models: []",
        "",
      ].join("\n"),
      "utf-8",
    );
    enqueueCandidates(
      "free",
      ["baimodel/stray-one", "baimodel/stray-two", "baimodel/stray-three", "v/alpha:free"],
      1000,
    );
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const after = readCandidates(NO_ROUTES());
    // mockRestore() resets .mock.calls too (it's mockReset + restore-impl) —
    // read the recorded calls BEFORE restoring, or the assertion below always
    // sees an empty array regardless of what actually happened.
    const logged = errSpy.mock.calls.map((c) => String(c[0])).join("");
    errSpy.mockRestore();

    expect(after.free.map((e) => e.id)).toEqual(["v/alpha:free"]);
    expect(logged).toContain("dropped 3 stray unrouted 'free' candidate id(s)");
  });

  it("readCandidates keeps a 'free' candidate id bound to the current profile's free-provider route", () => {
    writeFileSync(
      getSettingsPath(),
      [
        "profiles:",
        "  free:",
        "    mode: remote-ensemble",
        "    api: openrouter-remote",
        "    api_key: $OPENROUTER_API_KEY",
        "    free_only: true",
        "    free_models: [glm-5.3-flash]",
        "    providers:",
        "      - api: chat-b-ai-remote",
        "        api_key: $BAI_API_KEY",
        "        models: [glm-5.3-flash]",
        "",
      ].join("\n"),
      "utf-8",
    );
    enqueueCandidates("free", ["glm-5.3-flash", "baimodel/stray"], 1000);
    // readCandidates no longer derives this itself (3c/3e) — resolve it from
    // the same settings.yaml this test just wrote, exactly like a real caller
    // (dynamic-maintainer.ts, benchmark/index.ts) would.
    const freeProfile = loadSettings()!.profiles.free!;
    const after = readCandidates(resolveGroups(freeProfile).routesFor);
    expect(after.free.map((e) => e.id)).toEqual(["glm-5.3-flash"]);
  });

  it("readCandidates never prunes the 'paid' queue (no route/':free' expectation applies there)", () => {
    writeFileSync(
      getSettingsPath(),
      ["profiles:", "  free:", "    mode: remote", "    api: openrouter-remote", "    free_models: []", ""].join(
        "\n",
      ),
      "utf-8",
    );
    enqueueCandidates("paid", ["openai/gpt-4o-mini", "anthropic/claude-haiku"], 1000);
    const after = readCandidates(NO_ROUTES());
    expect(after.paid.map((e) => e.id)).toEqual(["openai/gpt-4o-mini", "anthropic/claude-haiku"]);
  });

  // 3c/3e (review of 51a100c + 93cc031): readCandidates no longer takes its
  // own loadSettings() fallback for an omitted argument — the caller decides
  // what "no route information" means, explicitly, every time. An id with no
  // ':free' suffix and no route in the map it's handed is pruned, full stop;
  // there is no longer a silent "couldn't tell, so I let it through" path
  // inside this function for a caller to accidentally fall into.
  it("readCandidates prunes an unrouted 'free' id against an explicit empty Map — no hidden fallback", () => {
    enqueueCandidates("free", ["baimodel/unknown-route"], 1000);
    const after = readCandidates(NO_ROUTES());
    expect(after.free.map((e) => e.id)).toEqual([]);
  });

  // p14.1-c2c (TRDD-38QAM06E follow-up, review of 51a100c item 3c): the caller
  // now supplies routesFor directly instead of readCandidates() re-deriving
  // it from loadSettings() under a swallowed try/catch. Prove the parameter
  // actually takes effect — no settings.yaml on disk at all, so a pass would
  // be impossible if this path still silently fell back to "no route info".
  it("readCandidates prunes against an EXPLICIT routesFor with no settings.yaml on disk", () => {
    const fakeRoute: ResolvedRoute = {
      name: "chat-b-ai-remote",
      api: "chat-b-ai-remote",
      protocol: "openai_api",
      url: "https://api.b.ai",
      authToken: "",
      keyRef: "none",
      isLocal: false,
      isFreeProvider: true,
      models: ["glm-5.3-flash"],
    };
    const routesFor = (id: string): ResolvedRoute[] => (id === "glm-5.3-flash" ? [fakeRoute] : []);
    enqueueCandidates("free", ["glm-5.3-flash", "baimodel/stray"], 1000);
    const after = readCandidates(routesFor);
    expect(after.free.map((e) => e.id)).toEqual(["glm-5.3-flash"]);
  });

  // Row 17 (TRDD-OE27RD7I): pruning is pure on routesFor and the ":free" suffix.
  // The catalog-cache module is spied (see vi.mock above); a pass that prunes
  // at least one id must not have touched it. Non-vacuous: the stray id is
  // really dropped, and the ":free" and routed ids really survive.
  it("readCandidates pruning never consults the model catalog", () => {
    const freeRoute: ResolvedRoute = {
      name: "chat-b-ai-remote",
      api: "chat-b-ai-remote",
      protocol: "openai_api",
      url: "https://api.b.ai",
      authToken: "",
      keyRef: "none",
      isLocal: false,
      isFreeProvider: true,
      models: ["glm-5.3-flash"],
    };
    const routesFor = (id: string): ResolvedRoute[] => (id === "glm-5.3-flash" ? [freeRoute] : []);
    enqueueCandidates("free", ["baimodel/stray", "v/alpha:free", "glm-5.3-flash"], 1000);
    // Module-independent guard: no network fetch of any kind (whatever module would do it) during pruning.
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let after: ReturnType<typeof readCandidates>;
    try {
      after = readCandidates(routesFor);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
      fetchSpy.mockRestore();
    }
    expect(after.free.map((e) => e.id)).toEqual(["v/alpha:free", "glm-5.3-flash"]);
    expect(getCatalog).not.toHaveBeenCalled();
    expect(readCachedModelPrice).not.toHaveBeenCalled();
    expect(catalogFetchRecentlyFailed).not.toHaveBeenCalled();
  });

  // The SUPPLIED map governs, never the disk — a discriminating test (unlike
  // the "route-served id is never catalog-checked" test in
  // populate-default-profile.test.ts, which stays green even without this
  // parameter working at all, see report 20260917_190140 lines 77-82): this
  // writes settings.yaml WITH a real free-provider route for glm-5.3-flash,
  // then hands readCandidates a map that EXCLUDES it. If readCandidates were
  // still silently re-deriving from settings.yaml (the bug this parameter
  // exists to prevent), glm-5.3-flash would survive; it must not.
  it("readCandidates prunes an id the supplied map excludes, even though settings.yaml routes it", () => {
    writeFileSync(
      getSettingsPath(),
      [
        "profiles:",
        "  free:",
        "    mode: remote-ensemble",
        "    api: openrouter-remote",
        "    api_key: $OPENROUTER_API_KEY",
        "    free_only: true",
        "    free_models: [glm-5.3-flash]",
        "    providers:",
        "      - api: chat-b-ai-remote",
        "        api_key: $BAI_API_KEY",
        "        models: [glm-5.3-flash]",
        "",
      ].join("\n"),
      "utf-8",
    );
    enqueueCandidates("free", ["glm-5.3-flash", "baimodel/stray"], 1000);
    const after = readCandidates(NO_ROUTES());
    expect(after.free.map((e) => e.id)).toEqual([]);
  });
});