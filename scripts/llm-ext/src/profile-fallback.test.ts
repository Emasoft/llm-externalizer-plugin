/**
 * profile-fallback.test.ts — phase 14.1-C1 (TRDD-OE27RD7I addenda 2/3/4).
 *
 * profileChain is exercised directly, with a fake ResolvedProfile and a fake
 * "request log" driver — no HTTP, no completion layer wiring (that seam does
 * not exist yet, see profile-fallback.ts's own module doc: wiring it into
 * chatCompletionWithRetry's caller is phase 14.1-C2). These tests prove the
 * iterator's own contract: it walks ONLY the profile's own chain, in order,
 * skips a dead endpoint without a request, and throws ProfileExhaustedError
 * with the exact USER-specified sentence once every entry has failed.
 */
import { describe, it, expect, vi } from "vitest";
import { HIGH_QUALITY_MODEL_DEFAULTS, type ResolvedProfile, type ResolvedRoute } from "./config.js";
import {
  profileChain,
  ProfileExhaustedError,
  dynamicProfileRetryLaterMessage,
  type ChainFailure,
} from "./profile-fallback.js";

/** Minimal ResolvedProfile fixture — every field this module doesn't read
 *  gets an inert placeholder value. */
function fakeProfile(overrides: Partial<ResolvedProfile> = {}): ResolvedProfile {
  return {
    name: "test-profile",
    profileType: "paid",
    mode: "remote",
    protocol: "openrouter_api",
    url: "https://openrouter.ai/api/v1",
    model: "model-1",
    authToken: "key",
    secondModel: "",
    thirdModel: "",
    freeOnly: false,
    freeModels: [],
    toolModels: {},
    timeout: 30_000,
    contextWindow: 128_000,
    requestOptions: null,
    appName: "llm-ext",
    httpReferer: "https://example.invalid",
    highQualityModel: HIGH_QUALITY_MODEL_DEFAULTS,
    isLocal: false,
    isFreeProvider: false,
    routes: [],
    routesFor: (): ResolvedRoute[] => [],
    routeForModel: (): null => null,
    ...overrides,
  };
}

/** Drives a profileChain generator against a fixed table of per-model
 *  outcomes ("ok" | "model-failure" | "endpoint-failure"), logging every
 *  request actually attempted (a skipped entry — dead endpoint — is never
 *  logged). Returns the first successful model id, or throws whatever the
 *  generator throws (ProfileExhaustedError on exhaustion). */
function drive(
  profile: ResolvedProfile,
  outcomes: Record<string, "ok" | "model-failure" | "endpoint-failure">,
  tool?: string,
): { result: string | null; requested: string[] } {
  const gen = profileChain(profile, tool);
  const requested: string[] = [];
  try {
    let next = gen.next();
    while (!next.done) {
      const entry = next.value;
      requested.push(entry.modelId);
      const outcome = outcomes[entry.modelId] ?? "model-failure";
      if (outcome === "ok") {
        return { result: entry.modelId, requested };
      }
      const failure: ChainFailure = { kind: outcome === "endpoint-failure" ? "endpoint" : "model" };
      next = gen.next(failure); // throws ProfileExhaustedError once exhausted
    }
  } catch (err) {
    if (!(err instanceof ProfileExhaustedError)) throw err; // a real bug in the test — don't swallow it
  }
  return { result: null, requested };
}

describe("profileChain — static profile (addendum 3)", () => {
  it("three listed models: 1 -> 402, 2 -> 404, 3 -> 200: result from 3, exactly one attempt on 1 and 2, none outside the profile", () => {
    const profile = fakeProfile({ model: "m1", secondModel: "m2", thirdModel: "m3" });
    const { result, requested } = drive(profile, {
      m1: "model-failure", // 402
      m2: "model-failure", // 404
      m3: "ok",
    });
    expect(result).toBe("m3");
    expect(requested).toEqual(["m1", "m2", "m3"]);
    // "none outside the profile" — every requested id is one of the three listed.
    expect(requested.every((id) => ["m1", "m2", "m3"].includes(id))).toBe(true);
  });

  it("all three fail: throws ProfileExhaustedError with the exact static sentence, no request outside the profile", () => {
    const profile = fakeProfile({ model: "m1", secondModel: "m2", thirdModel: "m3" });
    const gen = profileChain(profile);
    const requested: string[] = [];
    let next = gen.next();
    let thrown: unknown;
    try {
      while (!next.done) {
        requested.push(next.value.modelId);
        next = gen.next({ kind: "model" });
      }
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ProfileExhaustedError);
    const err = thrown as ProfileExhaustedError;
    expect(err.message).toBe(
      "the models in the selected profile are all failing; retry later or change the profile",
    );
    expect(err.kind).toBe("static");
    expect(err.profileName).toBe("test-profile");
    expect(requested).toEqual(["m1", "m2", "m3"]);
  });

  it("two models on one local base URL: ECONNREFUSED on the first skips the second without a request", () => {
    const route = {
      name: "local-preset",
      api: "local-preset",
      protocol: "openai_api" as const,
      url: "http://127.0.0.1:1234",
      authToken: "",
      keyRef: "none",
      isLocal: true,
      isFreeProvider: false,
      models: ["m1", "m2"],
    };
    const profile = fakeProfile({
      model: "m1",
      secondModel: "m2",
      thirdModel: "",
      url: "http://127.0.0.1:1234",
      routesFor: (id: string): ResolvedRoute[] => (id === "m1" || id === "m2" ? [route] : []),
    });
    const { result, requested } = drive(profile, {
      m1: "endpoint-failure", // ECONNREFUSED — marks http://127.0.0.1:1234 dead
      m2: "ok", // never actually requested — same dead base URL
    });
    expect(result).toBeNull(); // exhausted: m2 was skipped, not tried
    expect(requested).toEqual(["m1"]); // m2 never appears in the request log
  });

  it("a static free_only profile walks its own manually-listed free pool, nothing else", () => {
    const profile = fakeProfile({
      freeOnly: true,
      freeModels: ["free-a:free", "free-b:free"],
      model: "free-a:free", // resolveProfile sets model = freeModels[0] for a static free_only profile
      secondModel: "",
      thirdModel: "",
    });
    const { result, requested } = drive(profile, {
      "free-a:free": "model-failure",
      "free-b:free": "ok",
    });
    expect(result).toBe("free-b:free");
    expect(requested).toEqual(["free-a:free", "free-b:free"]);
  });
});

describe("profileChain — dynamic profile (free/paid)", () => {
  // D6a (TRDD-90DM5YHO): a model served by two groups expands to TWO chain
  // entries, model-major, in group order; each entry carries its own route.
  it("two groups serving one id produce two chain entries in group order, each with its route", () => {
    const baiRoute: ResolvedRoute = {
      name: "bai",
      api: "chat-b-ai-remote",
      protocol: "openai_api",
      url: "https://api.b.ai",
      authToken: "key-one",
      keyRef: "$BAI_API_KEY",
      isLocal: false,
      isFreeProvider: true,
      models: ["glm-5.3-flash"],
    };
    const bai2Route: ResolvedRoute = {
      ...baiRoute,
      name: "bai-2",
      authToken: "key-two",
      keyRef: "$BAI_API_KEY_2",
    };
    const profile = fakeProfile({
      dynamic: true,
      model: "glm-5.3-flash",
      freeModels: ["glm-5.3-flash"],
      routesFor: (id: string): ResolvedRoute[] =>
        id === "glm-5.3-flash" ? [baiRoute, bai2Route] : [],
    });
    const gen = profileChain(profile);
    const seen: { modelId: string; baseUrl: string; routeName?: string }[] = [];
    let next = gen.next();
    try {
      while (!next.done) {
        seen.push({ modelId: next.value.modelId, baseUrl: next.value.baseUrl, routeName: next.value.route?.name });
        // undefined feedback: "no failure reported" advances WITHIN the same
        // id (only a { kind: "model" } failure skips the id's remaining
        // groups). Reporting "model" here would collapse the walk to one
        // entry — testing the skip, not the expansion.
        next = gen.next(undefined);
      }
    } catch {
      /* ProfileExhaustedError — expected, the walk throws once every entry failed */
    }
    expect(seen.map((s) => `${s.modelId}@${s.routeName}`)).toEqual(["glm-5.3-flash@bai", "glm-5.3-flash@bai-2"]);
  });

  // D6a: a "model" failure skips the id's REMAINING groups (a 404 on one key
  // would repeat on a second key of the same provider) and advances to the
  // next id. (The per-credit group-dead marking is D4.)
  it("a model failure on the first group skips the same id's second group", () => {
    const baiRoute: ResolvedRoute = {
      name: "bai",
      api: "chat-b-ai-remote",
      protocol: "openai_api",
      url: "https://api.b.ai",
      authToken: "key-one",
      keyRef: "$BAI_API_KEY",
      isLocal: false,
      isFreeProvider: true,
      models: ["glm-5.3-flash"],
    };
    const bai2Route: ResolvedRoute = { ...baiRoute, name: "bai-2", url: "https://api2.b.ai" };
    const profile = fakeProfile({
      dynamic: true,
      // The pool source: a dynamic profile reads freeModels ONLY under
      // freeOnly (or mode local) — without it the walk reads paidModels and
      // never sees either id below.
      freeOnly: true,
      model: "glm-5.3-flash",
      freeModels: ["glm-5.3-flash", "backup:free"],
      routesFor: (id: string): ResolvedRoute[] =>
        id === "glm-5.3-flash" ? [baiRoute, bai2Route] : [],
    });
    const gen = profileChain(profile);
    const seen: string[] = [];
    let next = gen.next();
    try {
      while (!next.done) {
        seen.push(`${next.value.modelId}@${next.value.route?.name ?? "?"}`);
        next = gen.next({ kind: "model" });
      }
    } catch {
      /* ProfileExhaustedError — expected */
    }
    // glm-5.3-flash@bai-2 is ABSENT — the model failure on bai skipped it.
    expect(seen).toEqual(["glm-5.3-flash@bai", "backup:free@?"]);
  });

  it("all benchmarked models fail: throws ProfileExhaustedError kind dynamic with the retry-later sentence (D2)", () => {
    const profile = fakeProfile({
      dynamic: true,
      freeOnly: true,
      model: "free-1:free",
      freeModels: ["free-1:free", "free-2:free", "free-3:free"],
    });
    const gen = profileChain(profile);
    const requested: string[] = [];
    let next = gen.next();
    let thrown: unknown;
    try {
      while (!next.done) {
        requested.push(next.value.modelId);
        next = gen.next({ kind: "model" });
      }
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ProfileExhaustedError);
    const err = thrown as ProfileExhaustedError;
    expect(err.kind).toBe("dynamic");
    // D2: no command waits for an update any more, so the old "waiting for
    // the update" sentence is gone; the dynamic kind carries the one
    // retry-later message, naming the profile.
    expect(err.message).toBe(dynamicProfileRetryLaterMessage("test-profile"));
    // D3c-2 (TRDD-DS6OM3KX): "soon" is gone — the update marker waits out the
    // failure backoff (15 min to 24 h), so the text states the deferral
    // instead of promising a finish time it cannot know. "test-profile" is
    // not a dynamic name, so no cooldown lookup happens and the generic
    // backoff-window sentence is emitted.
    expect(err.message).toBe(
      "no model of the 'test-profile' profile is working right now; the profile update is underway in the background and may take a while — failed benchmark attempts back off for 15 minutes to 24 hours — retry later",
    );
    expect(err.message).not.toContain("soon");
    expect(requested).toEqual(["free-1:free", "free-2:free", "free-3:free"]);
  });

  it("a dynamic paid profile walks head then the written paidModels pool, in the written (rating) order", () => {
    const profile = fakeProfile({
      dynamic: true,
      freeOnly: false,
      model: "paid-1",
      paidModels: ["paid-1", "paid-2", "paid-3"],
    });
    const { result, requested } = drive(profile, {
      "paid-1": "model-failure",
      "paid-2": "ok",
    });
    expect(result).toBe("paid-2");
    expect(requested).toEqual(["paid-1", "paid-2"]);
  });
});

// D4 (TRDD-90DM5YHO, design section 6): a "credit" failure marks the
// url+keyRef CREDENTIAL dead for the walk and continues with the SAME id's
// next group — the my-mix walk: one id served by two accounts of one
// provider; the first key 402s, the second key serves it. Also: every OTHER
// id behind the dead key is skipped without a request.
describe("profileChain — D4 credit failures", () => {
  const mkRoute = (name: string, keyRef: string): ResolvedRoute => ({
    name,
    api: "openrouter-remote",
    protocol: "openrouter_api",
    url: "https://openrouter.ai/api/v1",
    authToken: `key-${name}`,
    keyRef,
    isLocal: false,
    isFreeProvider: false,
    models: ["paid-1", "paid-2"],
  });
  const accountA = mkRoute("acct-a", "$KEY_A");
  const accountB = mkRoute("acct-b", "$KEY_B");

  it("a credit failure skips the dead KEY's other ids but retries the SAME id on its next group (my-mix walk)", () => {
    const profile = fakeProfile({
      dynamic: true,
      model: "paid-1",
      paidModels: ["paid-1", "paid-2"],
      routesFor: (id: string): ResolvedRoute[] =>
        id === "paid-1" || id === "paid-2" ? [accountA, accountB] : [],
    });
    const gen = profileChain(profile);
    const seen: string[] = [];
    const creditFail = (modelId: string) => ({
      kind: "credit" as const,
      error: new Error(
        `Provider acct-a report insufficient credits for using the ${modelId} model with this key.`,
      ),
    });
    let next = gen.next();
    try {
      while (!next.done) {
        const { modelId, route } = next.value;
        seen.push(`${modelId}@${route?.name ?? "primary"}`);
        // The FIRST group (acct-a) 402s on every id; the second (acct-b) then
        // serves the SAME id. Expected walk: paid-1@acct-a (402) →
        // paid-1@acct-b (credit: the SAME id's next group survives) →
        // paid-2@acct-a SKIPPED without a request (key dead) → paid-2@acct-b.
        next = gen.next(route?.name === "acct-a" ? creditFail(modelId) : undefined);
      }
    } catch {
      /* ProfileExhaustedError — the walk throws once every entry is tried */
    }
    // The walk throws after every entry is tried; seen must show the skip.
    expect(seen).toEqual([
      "paid-1@acct-a",
      "paid-1@acct-b",
      "paid-2@acct-b",
    ]);
  });

  it("a credit failure's cause carries the USER credit message with the group and model", () => {
    const profile = fakeProfile({
      dynamic: true,
      model: "paid-1",
      paidModels: ["paid-1"],
      routesFor: (id: string): ResolvedRoute[] => (id === "paid-1" ? [accountA] : []),
    });
    const gen = profileChain(profile);
    let cause: unknown;
    try {
      gen.next();
      gen.next({
        kind: "credit",
        error: new Error(
          "Provider acct-a report insufficient credits for using the paid-1 model with this key.",
        ),
      });
    } catch (err) {
      cause = (err as { causes?: readonly unknown[] }).causes?.[0];
    }
    // EXACTLY the USER template, no "(raw: …)" suffix (D4 review F4) — assert
    // the Error's message, since String(err) prefixes "Error: ".
    expect(cause).toBeInstanceOf(Error);
    expect((cause as Error).message).toBe(
      "Provider acct-a report insufficient credits for using the paid-1 model with this key.",
    );
  });

  it("a walk that skipped entries for a dead credential prints ONE aggregate stderr line naming the count and credential (D4 review F1)", () => {
    const profile = fakeProfile({
      dynamic: true,
      model: "paid-1",
      paidModels: ["paid-1", "paid-2"],
      routesFor: (id: string): ResolvedRoute[] =>
        id === "paid-1" || id === "paid-2" ? [accountA, accountB] : [],
    });
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stderrLines: string[] = [];
    try {
      const gen = profileChain(profile);
      let next = gen.next();
      try {
        while (!next.done) {
          const { route } = next.value;
          next = gen.next(
            route?.name === "acct-a"
              ? {
                  kind: "credit" as const,
                  error: new Error(
                    "Provider acct-a report insufficient credits for using the paid-1 model with this key.",
                  ),
                }
              : undefined,
          );
        }
      } catch {
        /* ProfileExhaustedError */
      }
    } finally {
      // mockRestore clears the recorded calls, so copy them out first.
      stderrLines.push(...errSpy.mock.calls.map((c) => String(c[0])));
      errSpy.mockRestore();
    }
    const lines = stderrLines.filter((s) => s.includes("credit-dead"));
    expect(lines).toHaveLength(1);
    // Count: paid-2@acct-a skipped once (paid-1@acct-a FAILED, not skipped).
    expect(lines[0]).toContain("Skipped 1 chain entry");
    expect(lines[0]).toContain("https://openrouter.ai/api/v1::$KEY_A");
    // Secret-free: the route's authToken value must not appear.
    expect(lines[0]).not.toContain("key-acct-a");
  });
});
