// Free-model rotation — the cross-call cooldown registry and the rotation
// executor. Everything here is hermetic: an injected clock, an injected RAM-only
// store, and a mocked callOne. No network, no LLM, no writes to the real
// ~/.llm-externalizer (the persistence tests point LLM_EXT_CONFIG_DIR at a tmp
// dir and exercise the REAL atomic writer).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { getSettingsPath } from "./config";
import * as modelEventsModule from "./model-events.js";
import {
  AllFreeModelsExhaustedError,
  applyUnavailable,
  approvedFreePoolFromSettings,
  callWithFreeRotation,
  classifyUnavailable,
  clearNoContentStrikes,
  combinedFreeModelEvidence,
  credentialSucceededOnOtherModel,
  isRunUnusable,
  isUnusable,
  looksLikeClassifier,
  markCredentialSucceeded,
  markRunUnusable,
  NO_CONTENT_STRIKE_TTL_MS,
  noContentDemotedModels,
  parseBenchEvidence,
  rankFreeModelsByBenchEvidence,
  recordNoContentStrike,
  resetCredentialSuccessForTests,
  resetRecentModelEventsCacheForTests,
  resetRunUnusableForTests,
  resetGeneric403ForTests,
  noteGeneric403Model,
  POOL_403_QUORUM,
  GONE_EVICT_STRIKES,
  GONE_EVICT_TTL_MS,
  goneEvictedModels,
  selectFreeEnsembleModels,
  clearCooldown,
  computeCooldownUntil,
  cooldownFilePath,
  earliestReset,
  emptyStore,
  getCooldownStore,
  isCooling,
  memoryRotationStore,
  nextUtcMidnight,
  orderByAvailability,
  pruneExpired,
  recordAvailable,
  recordUnavailable,
  resetCooldownCacheForTests,
  resetRotationJournalForTests,
  rotationJournalSince,
  runUnusableKind,
  unusableModelIds,
  withFreeRotation,
} from "./free-rotation";
import { paymentErrorCertainty } from "./benchmark/free-mode.js";

const T0 = Date.UTC(2026, 6, 14, 10, 0, 0); // 2026-07-14T10:00:00Z
const slot = (id: string) => ({ id, maxOutput: 1000 });


describe("applyUnavailable's knownKind never downgrades an EXISTING persisted verdict (review of da917e9, TRDD-W9XLU1HD)", () => {
  it("a persisted 'daily-quota' entry survives a later corroborated call carrying the SAME true kind (clobber regression test, kept green)", () => {
    // Mirrors session_summary/driver.ts's callChunkModel guard: once a model
    // is run-unusable, a SIBLING fan-out slot never calls it again -- it
    // synthesizes a ModelUnavailableError with an AMBIGUOUS detail ("model
    // already verified unavailable this run...") that carries no
    // daily-quota phrasing. The fix is that the CALLER now passes the REAL
    // kind (read from the registry via runUnusableKind), so there is no
    // "gone" to clobber with -- unlike the old `!prev && isRunUnusable(id)
    // ? "gone" : null` fallback, which always guessed "gone" regardless of
    // the model's true persisted kind.
    const withQuota = applyUnavailable(
      emptyStore(),
      "quota/model:free",
      "free-models-per-day limit reached",
      T0,
    );
    expect(withQuota.models["quota/model:free"]?.kind).toBe("daily-quota");
    markRunUnusable("quota/model:free", "daily-quota");
    const after = applyUnavailable(
      withQuota,
      "quota/model:free",
      "model already verified unavailable this run (shared verdict, no new HTTP call)",
      T0 + 1_000,
      runUnusableKind("quota/model:free"),
    );
    expect(after.models["quota/model:free"]?.kind).toBe("daily-quota");
  });

  it("an expired transient (429) entry + a corroborated 403 persists 'gone' (red on da917e9)", () => {
    // Pre-fix: applyUnavailable's fallback was gated on `!prev`, so once ANY
    // entry existed for this model (even an expired transient one) a later
    // corroborated-but-textually-ambiguous 403 was silently dropped -- the
    // model stayed un-evicted despite being proven gone.
    const transient = applyUnavailable(emptyStore(), "x:free", "429 rate limit", T0);
    expect(transient.models["x:free"]?.kind).toBe("transient");
    expect(transient.models["x:free"]?.until).toBeLessThan(T0 + 60_000); // well expired by T0+999_999
    markRunUnusable("x:free", "gone");
    const raw403 = 'API error 403 (openrouter): {"error":{"message":"Forbidden"}}';
    const after = applyUnavailable(transient, "x:free", raw403, T0 + 999_999, runUnusableKind("x:free"));
    expect(after.models["x:free"]?.kind).toBe("gone");
  });

  it("an expired 'gone' entry + a corroborated 403 renews the cooldown instead of being silently dropped (red on da917e9)", () => {
    // Pre-fix: `!prev` was false the instant ANY entry existed for this
    // model, expired or not -- so a dead model's hourly "gone" reprobe
    // window, once past, could never be renewed by a later corroborated
    // (but textually ambiguous) failure; the model looked healthy again.
    const gone = applyUnavailable(emptyStore(), "y:free", "API error 404: not found", T0);
    expect(gone.models["y:free"]?.kind).toBe("gone");
    const expiredAt = gone.models["y:free"]!.until + 1_000; // past the 1h reprobe window
    markRunUnusable("y:free", "gone");
    const raw403 = 'API error 403 (openrouter): {"error":{"message":"Forbidden"}}';
    const after = applyUnavailable(gone, "y:free", raw403, expiredAt, runUnusableKind("y:free"));
    expect(after.models["y:free"]?.kind).toBe("gone");
    expect(after.models["y:free"]?.until).toBeGreaterThan(expiredAt);
  });
});

describe("applyUnavailable persists a corroborated 'gone' verdict via its knownKind param (TRDD-W9XLU1HD AC3)", () => {
  // completion.ts calls markRunUnusable(modelId, kind) SYNCHRONOUSLY, BEFORE
  // it throws, once classifyUnavailable's credentialProvenGoodElsewhere gate
  // (TRDD-90DM5YHO item 1) corroborates a bare 403 as "gone" -- but the raw
  // error text it throws carries no model-specific phrasing, so a caller
  // that only re-classifies the raw text (as applyUnavailable did before
  // this fix) never persists the verdict. recordUnavailable reads the
  // already-computed verdict off the registry (runUnusableKind) and passes
  // it in; these tests simulate that by passing it directly.
  it("a corroborated-gone model is written to the store with kind 'gone' and stays evicted", () => {
    markRunUnusable("dead/model:free", "gone");
    const raw403 = 'API error 403 (openrouter): {"error":{"message":"Forbidden"}}';
    const s = applyUnavailable(emptyStore(), "dead/model:free", raw403, T0, runUnusableKind("dead/model:free"));
    expect(s.models["dead/model:free"]?.kind).toBe("gone");
    // "Persisted" means it reads back as cooling from a FRESH store built
    // only from this entry -- the registry itself is in-process-only and
    // would be empty again in the next process; the persisted `kind: "gone"`
    // entry is what has to carry the fact forward on its own.
    expect(isCooling(s, "dead/model:free", T0 + 1_000)).toBe(true);
  });

  it("a bare 403 with NO corroboration (no knownKind passed) is NOT persisted", () => {
    const raw403 = 'API error 403 (openrouter): {"error":{"message":"Forbidden"}}';
    const s = applyUnavailable(emptyStore(), "maybe-key-problem:free", raw403, T0);
    expect(s.models["maybe-key-problem:free"]).toBeUndefined();
  });

  it("a 401 is never persisted as model-death, corroborated or not", () => {
    markRunUnusable("unrelated/other:free", "gone"); // some OTHER model proven gone this run
    const s = applyUnavailable(emptyStore(), "keyed/model:free", "API error 401 (openrouter): unauthorized", T0);
    expect(s.models["keyed/model:free"]).toBeUndefined();
  });

  it("ordinary (non-corroborated) 404/410 classification is unchanged", () => {
    const s404 = applyUnavailable(emptyStore(), "a:free", "API error 404: not found", T0);
    expect(s404.models["a:free"]?.kind).toBe("gone");
    const s410 = applyUnavailable(emptyStore(), "b:free", "API error 410: gone", T0);
    expect(s410.models["b:free"]?.kind).toBe("gone");
  });
});

describe("markRunUnusable/runUnusableKind — the registry carries the verdict kind, not a bare boolean (review of da917e9)", () => {
  it("runUnusableKind reflects the exact kind passed to markRunUnusable, and is undefined for an unmarked id", () => {
    expect(runUnusableKind("never-marked:free")).toBeUndefined();
    markRunUnusable("quota-kind:free", "daily-quota");
    expect(runUnusableKind("quota-kind:free")).toBe("daily-quota");
    expect(isRunUnusable("quota-kind:free")).toBe(true);
  });
});

// The run-unusable registry is process-wide module state — vitest isolates
// per FILE, not per test, so every test in this file that marks a model must
// start with a clean registry, and no test may reuse an id another test
// used (P2 amendment, 2026-09-16; extended for the kind-carrying registry,
// TRDD-W9XLU1HD review).
beforeEach(() => {
  resetRunUnusableForTests();
  resetGeneric403ForTests();
});
afterEach(() => {
  resetRunUnusableForTests();
  resetGeneric403ForTests();
});

describe("approvedFreePoolFromSettings — a paid profile's OWN free_models win over the seed", () => {
  // Regression fence: resolveProfile only fills freeModels for a free_only
  // profile, so this helper used to read an empty list for a PAID profile that
  // pins free_models and fall back to FREE_POOL_SEED — silently dropping the
  // operator's curated pool. The free-by-default default made that the common
  // case (every remote profile is forced free), so a paid profile's configured
  // pool MUST be honoured.
  let prev: string | undefined;
  let dir: string;
  beforeEach(() => {
    prev = process.env.LLM_EXT_CONFIG_DIR;
    dir = mkdtempSync(join("/tmp", "llm-ext-afps-"));
    process.env.LLM_EXT_CONFIG_DIR = dir;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
    else process.env.LLM_EXT_CONFIG_DIR = prev;
  });

  it("returns the configured :free models of a PAID (non-free_only) profile, not the seed", () => {
    writeFileSync(
      getSettingsPath(),
      [
        "active: p",
        "profiles:",
        "  p:",
        "    mode: remote-ensemble",
        "    api: openrouter-remote",
        "    model: vendor/paid-a", // paid config models — must be ignored under free
        "    second_model: vendor/paid-b",
        "    free_models:",
        "      - curated/one:free",
        "      - curated/two:free",
        "      - curated/three:free",
      ].join("\n"),
      "utf-8",
    );
    const pool = approvedFreePoolFromSettings();
    expect(pool).toEqual(["curated/one:free", "curated/two:free", "curated/three:free"]);
    // Not the bundled seed, and no paid config model leaked in.
    expect(pool).not.toContain("vendor/paid-a");
  });

  it("resolves to [] when the profile pins no free_models -- never falls back to the seed (Rule 5, never dark)", () => {
    writeFileSync(
      getSettingsPath(),
      [
        "active: p",
        "profiles:",
        "  p:",
        "    mode: remote",
        "    api: openrouter-remote",
        "    model: vendor/paid-a",
      ].join("\n"),
      "utf-8",
    );
    const pool = approvedFreePoolFromSettings();
    expect(pool).toEqual([]);
  });
});

describe("bench-evidence ranking (task #189) — the ledgers finally steer selection", () => {
  it("qualityPass (ultracode F0): the persisted golden-dataset verdict decides alone — class-rejected ':free' rows can pass or scored-fail", () => {
    // EXACTLY the row shape every scored benchmark run writes since F0:
    // `qualified:false` + the class-rejection reason (allowFree:false rejects
    // the whole ':free' pool by design) PLUS the golden-dataset verdict. The
    // old fold read only qualified/disqualifyReason, so both of these rows
    // carried NO verdict and the ranking was inert for the very pool it ranks.
    const REQ = "below code-task requirements (cost/context/structured-output/reasoning)";
    const evidence = parseBenchEvidence([
      {
        "v/aced:free::2026-08-05::x": { qualified: false, disqualifyReason: REQ, qualityPass: true },
        "v/flopped:free::2026-08-05::x": {
          qualified: false,
          disqualifyReason: REQ,
          qualityPass: false,
        },
      },
    ]);
    expect(evidence.get("v/aced:free")).toBe("pass");
    expect(evidence.get("v/flopped:free")).toBe("fail");
  });

  it("qualityPass: pass wins across tools in BOTH orderings (fail-then-pass AND pass-then-fail)", () => {
    const row = (qualityPass: boolean) => ({ qualified: false, qualityPass });
    // pass recorded FIRST, scored-fail later — the fail must not overwrite it
    const passFirst = parseBenchEvidence([
      { "v/m:free::d::x": row(true) },
      { "v/m:free::d::y": row(false) },
    ]);
    expect(passFirst.get("v/m:free")).toBe("pass");
    // scored-fail recorded FIRST, pass later — the unconditional pass-override
    // branch (the direction the original test never exercised, ultracode F14)
    const failFirst = parseBenchEvidence([
      { "v/m:free::d::x": row(false) },
      { "v/m:free::d::y": row(true) },
    ]);
    expect(failFirst.get("v/m:free")).toBe("pass");
  });

  it("legacy rows (no qualityPass): skip/availability/REQUIREMENTS rows carry NO verdict; qualified:true still counts as pass", () => {
    const evidence = parseBenchEvidence([
      {
        // A requirements rejection is a CLASS verdict, not task quality — on
        // 2026-08-05 ALL 17 ledgered free models carried one (the premium
        // criteria set allowFree:false), so counting it demoted the whole
        // pool uniformly, i.e. ranked nothing.
        "v/a:free::2026-08-05::x": {
          qualified: false,
          disqualifyReason: "below code-task requirements (cost/context/structured-output/reasoning)",
        },
        "v/b:free::2026-08-05::x": { qualified: true },
        "v/c:free::2026-08-05::x": {
          qualified: false,
          disqualifyReason: "free_only active — non-':free' model not benchmarked",
        },
        "v/d:free::2026-08-05::x": {
          qualified: false,
          disqualifyReason: "not found in the OpenRouter catalog",
        },
      },
    ]);
    expect(evidence.has("v/a:free")).toBe(false); // class rejection ≠ task verdict
    expect(evidence.get("v/b:free")).toBe("pass");
    expect(evidence.has("v/c:free")).toBe(false);
    expect(evidence.has("v/d:free")).toBe(false);
  });

  it("rankFreeModelsByBenchEvidence: pass < unknown < fail, operator order stable within tiers", () => {
    const evidence = new Map<string, "pass" | "fail">([
      ["v/failing:free", "fail"],
      ["v/passing:free", "pass"],
    ]);
    expect(
      rankFreeModelsByBenchEvidence(
        ["v/failing:free", "v/unknown1:free", "v/passing:free", "v/unknown2:free"],
        evidence,
      ),
    ).toEqual(["v/passing:free", "v/unknown1:free", "v/unknown2:free", "v/failing:free"]);
  });

  it("REGRESSION (2026-08-05 unfit-trio incident): scored-fail models and a content-safety classifier lose the ensemble", () => {
    // The classifier sinks on NAME alone, with no ledger row at all — that is
    // the immediate improvement on the incident machine, where no scored rows
    // exist yet. Scored fails (here given to laguna/north-mini, as the next $0
    // free-pool sweep will produce for real) sink the rest.
    const evidence = new Map<string, "pass" | "fail">([
      ["poolside/laguna-xs-2.1:free", "fail"],
      ["cohere/north-mini-code:free", "fail"],
    ]);
    const selected = selectFreeEnsembleModels(
      [
        "poolside/laguna-xs-2.1:free",
        "cohere/north-mini-code:free",
        "nvidia/nemotron-3.5-content-safety:free", // no ledger row — name clamps it
        "v/decent-a:free",
        "v/decent-b:free",
        "v/decent-c:free",
      ],
      new Map(),
      new Set(),
      evidence,
    );
    expect(selected).toEqual(["v/decent-a:free", "v/decent-b:free", "v/decent-c:free"]);
    // With NO evidence at all (today's machine state), the classifier alone
    // sinks and the 4th pool member takes its ensemble slot.
    expect(
      selectFreeEnsembleModels(
        [
          "poolside/laguna-xs-2.1:free",
          "cohere/north-mini-code:free",
          "nvidia/nemotron-3.5-content-safety:free",
          "nvidia/nemotron-3-ultra-550b-a55b:free",
        ],
        new Map(),
      ),
    ).toEqual([
      "poolside/laguna-xs-2.1:free",
      "cohere/north-mini-code:free",
      "nvidia/nemotron-3-ultra-550b-a55b:free",
    ]);
  });

  it("default (no evidence) keeps the pre-#189 behavior — operator order, top 3", () => {
    expect(
      selectFreeEnsembleModels(["v/a:free", "v/b:free", "v/c:free", "v/d:free"], new Map()),
    ).toEqual(["v/a:free", "v/b:free", "v/c:free"]);
  });

  it("no-content strikes (task #189c): 3 strikes demote, one content success heals — self-managing in both directions", () => {
    // The strike store lives under getConfigDir() — redirect it to a temp dir
    // for this test only (the suite-level redirect belongs to a different
    // describe block; without our own we would write the REAL user store).
    const prev = process.env.LLM_EXT_CONFIG_DIR;
    process.env.LLM_EXT_CONFIG_DIR = mkdtempSync(join("/tmp", "llm-ext-strikes-"));
    try {
      const id = "v/reasoning-burner:free";
      expect(noContentDemotedModels().has(id)).toBe(false);
      recordNoContentStrike(id);
      recordNoContentStrike(id);
      expect(noContentDemotedModels().has(id)).toBe(false); // below threshold
      recordNoContentStrike(id);
      expect(noContentDemotedModels().has(id)).toBe(true); // 3 = demoted
      // Demotion feeds the combined evidence as a fail-tier verdict.
      expect(combinedFreeModelEvidence().get(id)).toBe("fail");
      // One content-bearing success heals it completely.
      clearNoContentStrikes(id);
      expect(noContentDemotedModels().has(id)).toBe(false);
      expect(combinedFreeModelEvidence().has(id)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
      else process.env.LLM_EXT_CONFIG_DIR = prev;
    }
  });

  it("no-content strikes EXPIRE after the TTL — the heal path a never-called model needs (ultracode F1)", () => {
    const prev = process.env.LLM_EXT_CONFIG_DIR;
    process.env.LLM_EXT_CONFIG_DIR = mkdtempSync(join("/tmp", "llm-ext-strikes-ttl-"));
    try {
      const id = "v/demoted-yesterday:free";
      const t0 = Date.now();
      recordNoContentStrike(id, t0);
      recordNoContentStrike(id, t0);
      recordNoContentStrike(id, t0);
      expect(noContentDemotedModels(t0).has(id)).toBe(true);
      // One TTL later the demotion heals by TIME alone. This path is
      // load-bearing, not belt-and-braces: a demoted model drops out of the
      // top-3 ensemble, and with a healthy top-3 it is never CALLED again —
      // so the success-heals path could never fire and the demotion was
      // permanent, contradicting the store's own self-healing contract.
      const later = t0 + NO_CONTENT_STRIKE_TTL_MS + 1;
      expect(noContentDemotedModels(later).has(id)).toBe(false);
      // A NEW strike after the gap restarts the count at 1 — the threshold
      // means "3 under CURRENT conditions", not "3 ever".
      recordNoContentStrike(id, later);
      expect(noContentDemotedModels(later).has(id)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
      else process.env.LLM_EXT_CONFIG_DIR = prev;
    }
  });
});

describe("classifyUnavailable — decides WHETHER to rotate and for HOW LONG", () => {
  it("classifies a spent DAILY free quota as daily-quota, not a transient 429", () => {
    // OpenRouter phrases the daily cap as a 429 too. Treating it as transient
    // would send us back into the same wall every 30s until midnight UTC.
    expect(classifyUnavailable("Rate limit exceeded: free-models-per-day")).toBe("daily-quota");
    expect(classifyUnavailable("429: you have exceeded your daily quota")).toBe("daily-quota");
    expect(classifyUnavailable("Daily limit reached for this model")).toBe("daily-quota");
  });

  it("classifies bare 'quota'/'limit exceeded' phrasings as TRANSIENT — a minute-scale limit must not sideline a model until UTC midnight", () => {
    // These verdicts are PERSISTED to free-cooldowns.json now; a daily-quota
    // misread would demote a healthy model in every process for up to 24h.
    expect(classifyUnavailable("RESOURCE_EXHAUSTED: quota exceeded, retry in 60s")).toBe("transient");
    expect(classifyUnavailable("output token limit exceeded for this request")).toBe("transient");
    expect(classifyUnavailable("you have exceeded your requests-per-minute allowance")).toBe("transient");
  });

  it("classifies a plain 429 / overload as transient", () => {
    expect(classifyUnavailable("HTTP 429: too many requests")).toBe("transient");
    expect(classifyUnavailable("503 overloaded")).toBe("transient");
    expect(classifyUnavailable("Provider temporarily unavailable")).toBe("transient");
  });

  it("classifies an unroutable model (no endpoints / 404) as gone", () => {
    expect(classifyUnavailable("No endpoints found for model")).toBe("gone");
    expect(classifyUnavailable("404 not found")).toBe("gone");
  });

  it("classifies a 403 access refusal as gone — rotate past it, never fail the call", () => {
    // The string is the PRODUCTION-COMPOSED one, not a convenient hand-written
    // sample: provider/completion.ts:479 throws
    // `API error ${res.status} (${backend.type}): ${sanitizeProviderError(text)}`,
    // and the provider text is verbatim from a live probe on 2026-08-29
    // (TRDD-V32LB992). This distinction is the test's whole value — the
    // provider's own message contains NO "403", so a test written against the
    // message alone would have passed while production still failed. Before
    // this branch existed classifyUnavailable returned null here, and the one
    // call the user asked for failed hard instead of rotating.
    expect(
      classifyUnavailable(
        "API error 403 (openrouter-remote): thinkingmachines/inkling:free is only " +
          "available on agentic harnesses. Try plugging it into a coding agent or " +
          "productivity app listed on https://openrouter.ai/apps",
      ),
    ).toBe("gone");
  });

  it("does NOT classify 401/400 as gone, even composed in the same format", () => {
    // Guards the removal of the `includes("forbidden")` clause: rotating on a
    // credential or request-shape error would burn the whole pool while hiding
    // the one error the user must see.
    expect(
      classifyUnavailable("API error 401 (openrouter-remote): No auth credentials found"),
    ).toBeNull();
    expect(
      classifyUnavailable("API error 400 (openrouter-remote): messages[0].role is invalid"),
    ).toBeNull();
  });

  it("still classifies a composed 429 as transient, not gone", () => {
    // The gone branch runs first; make sure adding a status-number match to it
    // did not capture the 429 path that must keep its short backoff.
    expect(
      classifyUnavailable("API error 429 (openrouter-remote): Provider returned error"),
    ).toBe("transient");
  });

  it("does NOT read a token count containing 403 as a 403 — it stays transient", () => {
    // The gone branch runs BEFORE the transient one, so a bare includes("403")
    // would sideline this model for an hour instead of retrying it in 30s.
    expect(classifyUnavailable("limit exceeded (1403 tokens)")).toBe("transient");
  });

  it("does NOT read a token count containing 410 as a bare 410 — it stays transient (w4 send-path cleanup)", () => {
    // Same class of bug as the 1403-tokens case above, but for STATUS_CODE_RE's
    // 410 branch: a bare \b410\b (the pre-fix regex) matches the digits alone,
    // wherever they appear — including inside a token count that happens to
    // equal 410, with no "api error"/"http" prefix in sight.
    expect(classifyUnavailable("context limit exceeded (410 tokens over)")).toBe("transient");
  });

  it("classifies a real API error 404 (no endpoints) as gone (w4 send-path cleanup)", () => {
    expect(classifyUnavailable("API error 404 (openrouter): no endpoints")).toBe("gone");
  });

  it("classifies a bare HTTP 410 as gone (w4 send-path cleanup)", () => {
    expect(classifyUnavailable("HTTP 410")).toBe("gone");
  });

  it("does NOT read a token count containing 404 as a 404 — it stays transient (w4 send-path cleanup)", () => {
    // STATUS_CODE_RE's 404 branch: a bare includes("404") (the pre-fix check)
    // matches "1404" mid-message with no status-code prefix anywhere nearby.
    expect(classifyUnavailable("limit exceeded (1404 tokens)")).toBe("transient");
  });

  it("returns null for a REAL defect — a 400, a bad key, a schema error", () => {
    // The load-bearing negative: rotating on a real bug would burn the entire
    // approved pool while hiding the one error the user needs to see.
    expect(classifyUnavailable("invalid api key")).toBeNull();
    expect(classifyUnavailable("400 bad request: messages[0].role is invalid")).toBeNull();
    expect(classifyUnavailable("")).toBeNull();
  });

  it("returns null for the circuit breaker's GLOBAL verdict — rotating cannot outrun a provider-wide abort", () => {
    // Mutation-verified against the 2026-08-04 livelock: the breaker's abort
    // text contains the word "overloaded", so without the signature guard the
    // transient branch matched it, every pool member got a 30s cooldown in
    // turn, and rotation cycled instant-aborts forever with zero requests
    // going out. The exact production string, verbatim shape:
    const breakerAbort =
      "SERVER ISSUE DETECTED: 246 consecutive failures. Last success was 432s ago. " +
      "Tried waiting 60s, 120s, 350s. The issue appears to be server-side " +
      "(offline, overloaded, or connection broken). Please retry later.";
    expect(classifyUnavailable(breakerAbort)).toBeNull();
    // A REAL per-model overload (no breaker signature) must still rotate.
    expect(classifyUnavailable("503 overloaded")).toBe("transient");
  });
});

describe("cooldown maths", () => {
  it("nextUtcMidnight is the next 00:00 UTC — when free daily quotas reset", () => {
    expect(nextUtcMidnight(T0)).toBe(Date.UTC(2026, 6, 15, 0, 0, 0));
    // One minute before midnight still rolls to the NEXT day's midnight.
    expect(nextUtcMidnight(Date.UTC(2026, 6, 14, 23, 59, 0))).toBe(Date.UTC(2026, 6, 15, 0, 0, 0));
  });

  it("a daily-quota cooldown lasts until UTC midnight, whatever the strike count", () => {
    expect(computeCooldownUntil("daily-quota", 1, T0)).toBe(Date.UTC(2026, 6, 15, 0, 0, 0));
    expect(computeCooldownUntil("daily-quota", 9, T0)).toBe(Date.UTC(2026, 6, 15, 0, 0, 0));
  });

  it("a transient cooldown backs off exponentially and caps at 5 minutes", () => {
    expect(computeCooldownUntil("transient", 1, T0)).toBe(T0 + 30_000);
    expect(computeCooldownUntil("transient", 2, T0)).toBe(T0 + 60_000);
    expect(computeCooldownUntil("transient", 3, T0)).toBe(T0 + 120_000);
    expect(computeCooldownUntil("transient", 8, T0)).toBe(T0 + 300_000); // capped
  });

  it("applyUnavailable ignores a non-availability error — a real bug never cools a healthy model", () => {
    const s = applyUnavailable(emptyStore(), "a:free", "invalid api key", T0);
    expect(s.models["a:free"]).toBeUndefined();
  });

  it("transient strikes accumulate only while the previous cooldown is still in force", () => {
    let s = applyUnavailable(emptyStore(), "a:free", "429", T0);
    expect(s.models["a:free"].strikes).toBe(1);
    s = applyUnavailable(s, "a:free", "429", T0 + 1_000); // still cooling → escalate
    expect(s.models["a:free"].strikes).toBe(2);
    // A model that has been healthy since its last 429 starts the ladder over.
    s = applyUnavailable(s, "a:free", "429", T0 + 999_999);
    expect(s.models["a:free"].strikes).toBe(1);
  });

  it("round C0b item 3 (B7): an explicit `until` raises a transient cooldown to the provider's retryAt, then the result is capped at 24 h (max-then-min)", () => {
    const retryAt = T0 + 600_000;
    const s = applyUnavailable(emptyStore(), "a:free", "429 rate limit", T0, undefined, retryAt);
    // Raised above the 30 s ladder to the provider's own horizon.
    expect(s.models["a:free"]?.until).toBe(retryAt);
    expect(s.models["a:free"]?.kind).toBe("transient");
    // A malicious retryAt beyond 24 h cannot bury the model for days.
    const far = applyUnavailable(emptyStore(), "b:free", "429 rate limit", T0, undefined, T0 + 400 * 86_400_000);
    expect(far.models["b:free"]?.until).toBe(T0 + 86_400_000);
    // A retryAt earlier than the computed ladder leaves the ladder untouched.
    const near = applyUnavailable(emptyStore(), "c:free", "429 rate limit", T0, undefined, T0 + 1_000);
    expect(near.models["c:free"]?.until).toBe(T0 + 30_000);
  });

  it("round C0b item 3 (B7): an explicit `until` never extends a non-transient verdict (gone/daily-quota)", () => {
    const gone = applyUnavailable(emptyStore(), "d:free", "No endpoints found for model", T0, undefined, T0 + 600_000);
    expect(gone.models["d:free"]?.until).toBe(T0 + 3_600_000);
    const quota = applyUnavailable(emptyStore(), "e:free", "free-models-per-day limit reached", T0, undefined, T0 + 600_000);
    expect(quota.models["e:free"]?.until).toBe(nextUtcMidnight(T0));
  });

  it("round C0b item 3 (B7): recordUnavailable threads the provider's retryAt into the stored cooldown", () => {
    const retryAt = T0 + 600_000;
    recordUnavailable("threaded:free", "429 rate limit", T0, retryAt);
    const onDisk = JSON.parse(readFileSync(cooldownFilePath(), "utf-8")) as {
      models: Record<string, { until: number; kind: string }>;
    };
    expect(onDisk.models["threaded:free"]?.until).toBe(retryAt);
    expect(onDisk.models["threaded:free"]?.kind).toBe("transient");
  });
 
  it("a success clears the cooldown immediately — recovery is not rate-limited", () => {
    const s = applyUnavailable(emptyStore(), "a:free", "429", T0);
    expect(isCooling(s, "a:free", T0)).toBe(true);
    expect(isCooling(clearCooldown(s, "a:free"), "a:free", T0)).toBe(false);
  });

  it("pruneExpired drops entries whose cooldown has elapsed", () => {
    const s = applyUnavailable(emptyStore(), "a:free", "429", T0);
    expect(Object.keys(pruneExpired(s, T0 + 10_000).models)).toEqual(["a:free"]);
    expect(Object.keys(pruneExpired(s, T0 + 60_000).models)).toEqual([]);
  });

  it("earliestReset reports the soonest moment any of the ids frees up", () => {
    let s = applyUnavailable(emptyStore(), "a:free", "free-models-per-day", T0); // midnight
    s = applyUnavailable(s, "b:free", "429", T0); // +30s
    expect(earliestReset(s, ["a:free", "b:free"], T0)).toBe(T0 + 30_000);
    // An id with no cooldown at all is available NOW.
    expect(earliestReset(s, ["a:free", "c:free"], T0)).toBe(T0);
  });
});

describe("orderByAvailability — cooling models are DEFERRED, never dropped", () => {
  it("puts fresh models first and sorts the cooling ones by soonest expiry", () => {
    let s = applyUnavailable(emptyStore(), "a:free", "free-models-per-day", T0); // longest
    s = applyUnavailable(s, "b:free", "429", T0); // shortest
    const { fresh, deferred } = orderByAvailability(
      [slot("a:free"), slot("b:free"), slot("c:free")],
      s,
      T0,
    );
    expect(fresh.map((f) => f.id)).toEqual(["c:free"]);
    // Deferred — but still present. A wrong cooldown may reorder attempts; it
    // must never remove a model from the rotation entirely.
    expect(deferred.map((f) => f.id)).toEqual(["b:free", "a:free"]);
  });
});

describe("callWithFreeRotation — rotate until one answers or the pool is truly spent", () => {
  it("returns the primary's result and never touches a fallback when it succeeds", async () => {
    const called: string[] = [];
    const r = await callWithFreeRotation(
      slot("p:free"),
      [slot("f1:free")],
      async (m) => {
        called.push(m);
        return `ok:${m}`;
      },
      { now: () => T0, store: memoryRotationStore() },
    );
    expect(r).toBe("ok:p:free");
    expect(called).toEqual(["p:free"]);
  });

  it("rotates through EVERY approved free model, then throws AllFreeModelsExhausted", async () => {
    const called: string[] = [];
    const store = memoryRotationStore();
    await expect(
      callWithFreeRotation(
        slot("p:free"),
        [slot("f1:free"), slot("f2:free")],
        async (m) => {
          called.push(m);
          throw new Error("429 rate limit");
        },
        { now: () => T0, store },
      ),
    ).rejects.toBeInstanceOf(AllFreeModelsExhaustedError);
    // "Exhausted" means every model was ACTUALLY tried — not "the registry
    // believed they were all busy".
    expect(called).toEqual(["p:free", "f1:free", "f2:free"]);
    expect(isCooling(store.get(T0), "f2:free", T0)).toBe(true);
  });

  it("re-throws a NON-availability error instead of burning the pool on a real bug", async () => {
    const called: string[] = [];
    await expect(
      callWithFreeRotation(
        slot("p:free"),
        [slot("f1:free")],
        async (m) => {
          called.push(m);
          throw new Error("400 bad request: messages[0].role is invalid");
        },
        { now: () => T0, store: memoryRotationStore() },
      ),
    ).rejects.toThrow(/400 bad request/);
    expect(called).toEqual(["p:free"]); // never rotated
  });

  it("SKIPS a primary already known to be daily-capped — the whole point of the registry", async () => {
    // This is the 50-file-scan bug: without a registry every file re-tried the
    // spent primary and paid a 429 for the privilege.
    const store = memoryRotationStore(
      applyUnavailable(emptyStore(), "p:free", "free-models-per-day", T0),
    );
    const called: string[] = [];
    const r = await callWithFreeRotation(
      slot("p:free"),
      [slot("f1:free")],
      async (m) => {
        called.push(m);
        return `ok:${m}`;
      },
      { now: () => T0 + 1_000, store },
    );
    expect(r).toBe("ok:f1:free");
    expect(called).toEqual(["f1:free"]); // the spent primary was never called
  });

  it("PROBES a cooling model anyway once the pool is exhausted — a bad guess must not brick the tool", async () => {
    // Invariant 2: a cooldown is a heuristic derived from an error string. If it
    // is wrong, the tool must degrade to "one wasted 429", never to "refuses to run".
    const store = memoryRotationStore(
      applyUnavailable(emptyStore(), "p:free", "429", T0),
    );
    const called: string[] = [];
    const r = await callWithFreeRotation(
      slot("p:free"),
      [slot("f1:free")],
      async (m) => {
        called.push(m);
        if (m === "f1:free") throw new Error("429 rate limit");
        return `ok:${m}`; // the "cooling" primary is actually fine
      },
      { now: () => T0 + 1_000, store },
    );
    expect(r).toBe("ok:p:free");
    expect(called).toEqual(["f1:free", "p:free"]); // deferred, then probed
  });

  it("rotates on a failure reported as a VALUE (the ensemble slot's shape)", async () => {
    const r = await callWithFreeRotation<{ ok: boolean; detail: string }>(
      slot("p:free"),
      [slot("f1:free")],
      async (m) =>
        m === "p:free"
          ? { ok: false, detail: "429 too many requests" }
          : { ok: true, detail: "" },
      {
        now: () => T0,
        store: memoryRotationStore(),
        resultFailureDetail: (r) => (r.ok ? null : r.detail),
      },
    );
    expect(r.ok).toBe(true);
  });

  it("a SHARED cursor stops two concurrent slots claiming the same fallback", async () => {
    let next = 0;
    const claim = () => next++;
    const store = memoryRotationStore();
    const callOne = async (m: string) => {
      if (m.startsWith("p")) throw new Error("429");
      return `ok:${m}`;
    };
    const [a, b] = await Promise.all([
      callWithFreeRotation(slot("p0:free"), [slot("f1:free"), slot("f2:free")], callOne, { now: () => T0, store }, claim),
      callWithFreeRotation(slot("p1:free"), [slot("f1:free"), slot("f2:free")], callOne, { now: () => T0, store }, claim),
    ]);
    expect(new Set([a, b])).toEqual(new Set(["ok:f1:free", "ok:f2:free"]));
  });

  it("an empty approved pool fails immediately — it never silently falls back to a paid model", async () => {
    await expect(
      callWithFreeRotation(
        slot("p:free"),
        [],
        async () => {
          throw new Error("free-models-per-day");
        },
        { now: () => T0, store: memoryRotationStore() },
      ),
    ).rejects.toBeInstanceOf(AllFreeModelsExhaustedError);
  });

  // D1 (USER 2026-09-18: "if the payment required or credits exhausted error
  // is certain, it should of course skip to the next provider"). The free pool
  // IS the free profile's chain, so a payment error advances to its next entry
  // instead of ending the walk -- and, not being an availability verdict, it
  // writes no cooldown.
  it("a certain payment error (HTTP 402) advances to the next free model and writes no cooldown", async () => {
    const called: string[] = [];
    const store = memoryRotationStore();
    const r = await callWithFreeRotation(
      slot("p:free"),
      [slot("f1:free")],
      async (m) => {
        called.push(m);
        if (m === "p:free") throw new Error("API error 402 (openrouter): Insufficient credits");
        return `ok:${m}`;
      },
      { now: () => T0, store },
    );
    expect(r).toBe("ok:f1:free");
    expect(called).toEqual(["p:free", "f1:free"]);
    expect(isCooling(store.get(T0), "p:free", T0)).toBe(false);
  });

  it("an uncertain payment-like error also advances (the completion layer already spent its one same-model retry)", async () => {
    const called: string[] = [];
    const r = await callWithFreeRotation(
      slot("p:free"),
      [slot("f1:free")],
      async (m) => {
        called.push(m);
        if (m === "p:free") throw new Error("API error 400 (openrouter): your payment method was declined");
        return `ok:${m}`;
      },
      { now: () => T0, store: memoryRotationStore() },
    );
    expect(r).toBe("ok:f1:free");
    expect(called).toEqual(["p:free", "f1:free"]);
  });

  it("a pool where EVERY model 402s tries each exactly once, then exhausts carrying the 402", async () => {
    const called: string[] = [];
    const err = await callWithFreeRotation(
      slot("p:free"),
      [slot("f1:free"), slot("f2:free")],
      async (m) => {
        called.push(m);
        throw new Error("API error 402 (openrouter): Insufficient credits");
      },
      { now: () => T0, store: memoryRotationStore() },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AllFreeModelsExhaustedError);
    expect(called).toEqual(["p:free", "f1:free", "f2:free"]);
    // classifyError (index.ts) reads this text for its credit verdict.
    expect((err as Error).message).toContain("API error 402");
  });
});

describe("paymentErrorCertainty — the ONE payment predicate (D1)", () => {
  it.each([
    // certain: a real 402 status, read where our own send paths put it
    ["API error 402 (openrouter): Insufficient credits", "certain"],
    ["HTTP 402: {\"error\":{}}", "certain"],
    // certain: an explicit statement, whatever the status
    ["API error 400 (local): insufficient credits on this account", "certain"],
    ["API error 403 (openrouter): Payment Required", "certain"],
    ["API error 500 (openrouter): credits exhausted", "certain"],
    ["credit exhausted for this key", "certain"],
    // uncertain: mentions a 402 / credit / payment, but is not certain
    ["API error 400 (openrouter): your payment method was declined", "uncertain"],
    ["API error 403 (openrouter): key credit limit reached", "uncertain"],
    ["API error 400 (openrouter): upstream returned 402", "uncertain"],
    ["upstream returned 402", "uncertain"],
    ["API error 400 (openrouter): request id req-402-abc", "uncertain"],
    // null: a transient status keeps its own retry/breaker path, even if the body mentions money
    [
      "API error 429 (openrouter): Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day",
      null,
    ],
    ["API error 503 (openrouter): payment service temporarily unavailable", null],
    // null: no payment wording at all
    ["API error 400 (openrouter): limit exceeded (1402 tokens)", null],
    ["API error 400 (openrouter): malformed request, try again", null],
    ["fetch failed", null],
    ["the vendor discredited this model", null],
    ["", null],
  ] as const)("%j -> %s", (detail, expected) => {
    expect(paymentErrorCertainty(detail)).toBe(expected);
  });

  // D5 pinning-test row (TRDD-90DM5YHO, 8641198-review F-1 residual, v3):
  // a DUAL-SIGNAL error — credit wording AND a rate-limit status in ONE
  // message — pins the predicate's ACTUAL ordering: a CERTAIN money phrase
  // ("insufficient credit" / "credits exhausted") beats ANY status, so a
  // 5xx carrying one is still "certain" (its current first block); only a
  // 429 with NO certain phrase falls through to null (its second check).
  // This is exactly the shape a future refactor that classified from the
  // minted template instead of the raw text would flip: the template quotes
  // the credit phrase, the raw status says "retryable", and every current
  // decision point (walk site, breaker/retry gate, free-rotation throw arm)
  // must keep reading the raw text.
  it("dual-signal: ordering pin — certain-phrase beats status; 429 without a certain phrase stays null", () => {
    // 429 + money wording that is NOT certain-phrased → null (status arm).
    expect(
      paymentErrorCertainty(
        "API error 429 (openrouter): Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day",
      ),
    ).toBeNull();
    // 5xx + a CERTAIN phrase → "certain" (the certain block runs FIRST —
    // pinned verbatim: changing this ordering is a D1 semantics change).
    expect(
      paymentErrorCertainty(
        "API error 503 (openrouter): your account has insufficient credits, try again shortly",
      ),
    ).toBe("certain");
    // The mirror pin: the SAME "add 10 credits" wording WITHOUT a 429/5xx
    // status is "uncertain" (generic credit mention) — proving the first
    // line turned on the 429 status, not on the phrase being unread.
    expect(
      paymentErrorCertainty("add 10 credits to unlock 1000 free model requests per day"),
    ).toBe("uncertain");
  });
});

describe("withFreeRotation — the FetchImpl decorator (security_scan / mass_scout)", () => {
  const POOL = ["a:free", "b:free", "c:free"];
  const req = (model: string) => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
  });
  const res = (status: number, body: string) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    json: async () => JSON.parse(body) as unknown,
  });
  const hooks = (store = memoryRotationStore()) => ({
    pool: () => [...POOL],
    freeActive: () => true,
    now: () => T0,
    store,
    onRotate: () => {},
  });

  beforeEach(() => resetRotationJournalForTests());

  it("passes through untouched when free mode is OFF — a paid call is never rerouted", async () => {
    const seen: string[] = [];
    const inner = async (_u: string, init: { body: string }) => {
      seen.push(JSON.parse(init.body).model);
      return res(429, "rate limit");
    };
    const wrapped = withFreeRotation(inner, { ...hooks(), freeActive: () => false });
    const r = await wrapped("u", req("paid/model"));
    expect(r.status).toBe(429);
    expect(seen).toEqual(["paid/model"]); // never rotated
  });

  it("passes through a body with NO model — the catalog/pricing GETs must not be rewritten", async () => {
    let bodySeen = "";
    const inner = async (_u: string, init: { body: string }) => {
      bodySeen = init.body;
      return res(200, "{}");
    };
    const wrapped = withFreeRotation(inner, hooks());
    await wrapped("u", { method: "POST", headers: {}, body: JSON.stringify({ q: 1 }) });
    expect(JSON.parse(bodySeen)).toEqual({ q: 1 });
  });

  it("FAILS CLOSED on a PAID model under free mode with an EMPTY pool — never bills a model the user signalled they don't want spent", async () => {
    const seen: string[] = [];
    const inner = async (_u: string, init: { body: string }) => {
      seen.push(JSON.parse(init.body).model as string);
      return res(200, JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    };
    const wrapped = withFreeRotation(inner, { ...hooks(), pool: () => [] });
    const r = await wrapped("u", req("paid/model"));
    expect(seen).toEqual([]); // the paid model was NEVER sent
    expect(r.ok).toBe(false);
    expect(await r.text()).toContain("refusing to send a paid model");
  });

  it("serves a PAID model pinned under FREE mode from the free pool — freeActive() covers every request in the job, not just one", async () => {
    // Under a free-mode profile, every scout/judge request still carries the
    // paid model baked into its body (the job-start chokepoint does not
    // re-run per request). Passing those through would 402 each one and
    // fail-safe the rest of the job — so they must be rewritten to the pool.
    const seen: string[] = [];
    const inner = async (_u: string, init: { body: string }) => {
      seen.push(JSON.parse(init.body).model as string);
      return res(200, JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    };
    const wrapped = withFreeRotation(inner, hooks());
    const r = await wrapped("u", req("paid/model"));
    expect(r.ok).toBe(true);
    expect(seen).toEqual(["a:free"]); // never sent the paid model under free mode
  });

  it("rewrites the body's model and re-sends when the requested free model is rate-limited", async () => {
    const seen: string[] = [];
    const inner = async (_u: string, init: { body: string }) => {
      const m = JSON.parse(init.body).model as string;
      seen.push(m);
      return m === "a:free"
        ? res(429, JSON.stringify({ error: { message: "free-models-per-day" } }))
        : res(200, JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    };
    const wrapped = withFreeRotation(inner, hooks());
    const r = await wrapped("u", req("a:free"));
    expect(r.ok).toBe(true);
    expect(seen).toEqual(["a:free", "b:free"]);
    // The caller's own retry ladder and circuit breaker never even see the 429.
    expect(rotationJournalSince(0)).toEqual(["a:free", "b:free"]);
  });

  it("does NOT rotate on a real defect (400) and hands the body back intact", async () => {
    const seen: string[] = [];
    const inner = async (_u: string, init: { body: string }) => {
      seen.push(JSON.parse(init.body).model as string);
      return res(400, JSON.stringify({ error: { message: "invalid schema" } }));
    };
    const wrapped = withFreeRotation(inner, hooks());
    const r = await wrapped("u", req("a:free"));
    expect(r.status).toBe(400);
    expect(seen).toEqual(["a:free"]); // never rotated
    // The decorator consumed the body to classify it — the caller must still read it.
    expect(await r.text()).toContain("invalid schema");
  });

  it("returns the LAST real failure when the whole pool is spent, body intact, so the caller's fail-safe runs", async () => {
    const seen: string[] = [];
    const inner = async (_u: string, init: { body: string }) => {
      seen.push(JSON.parse(init.body).model as string);
      return res(429, JSON.stringify({ error: { message: "rate limit" } }));
    };
    const wrapped = withFreeRotation(inner, hooks());
    const r = await wrapped("u", req("a:free"));
    expect(seen).toEqual(["a:free", "b:free", "c:free"]); // every approved model tried
    expect(r.status).toBe(429);
    expect(await r.text()).toContain("rate limit"); // judge.ts can still build its error
  });

  it("skips a model already known to be daily-capped, so a 100-file scan pays the 429 ONCE", async () => {
    const store = memoryRotationStore(
      applyUnavailable(emptyStore(), "a:free", "free-models-per-day", T0),
    );
    const seen: string[] = [];
    const inner = async (_u: string, init: { body: string }) => {
      seen.push(JSON.parse(init.body).model as string);
      return res(200, "{}");
    };
    const wrapped = withFreeRotation(inner, hooks(store));
    await wrapped("u", req("a:free"));
    expect(seen).toEqual(["b:free"]); // the spent model was never contacted again
  });

  // ── PAID mode: a credit-exhaustion (402) NEVER borrows the free pool ──
  // TRDD-OE27RD7I addendum 4 (USER, no exceptions): "no switching to free
  // models ... must exist anymore". The paid→free reroute this describe block
  // used to test was deleted from withFreeRotation itself (see the PAID-mode
  // branch's own comment) — these tests now pin the honest pass-through: the
  // 402 reaches the caller unchanged, and no free model is ever contacted.
  const paidHooks = (over: Partial<Parameters<typeof withFreeRotation>[1]> = {}) => ({
    pool: () => [...POOL],
    freeActive: () => false, // PAID profile
    now: () => T0,
    store: memoryRotationStore(),
    onRotate: () => {},
    ...over,
  });

  it("a paid call that does NOT 402 passes through untouched (no reroute, no spend surprise)", async () => {
    const seen: string[] = [];
    const inner = async (_u: string, init: { body: string }) => {
      seen.push(JSON.parse(init.body).model as string);
      return res(200, JSON.stringify({ ok: 1 }));
    };
    const wrapped = withFreeRotation(inner, paidHooks());
    const r = await wrapped("u", req("paid/model"));
    expect(r.ok).toBe(true);
    expect(seen).toEqual(["paid/model"]); // the paid model was used, never rerouted
  });

  it("a paid 402 (credit exhausted) is returned AS-IS — no free model is ever contacted", async () => {
    const seen: string[] = [];
    const stderrLines: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderrLines.push(String(chunk));
      return true;
    });
    try {
      const inner = async (_u: string, init: { body: string }) => {
        const m = JSON.parse(init.body).model as string;
        seen.push(m);
        if (m === "paid/model") return res(402, JSON.stringify({ error: { message: "insufficient credits" } }));
        return res(200, JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
      };
      const wrapped = withFreeRotation(inner, paidHooks());
      const r = await wrapped("u", req("paid/model"));
      expect(r.status).toBe(402); // the original 402 reaches the caller, not a 200
      expect(await r.text()).toContain("insufficient credits");
      expect(seen).toEqual(["paid/model"]); // the free pool was NEVER contacted
      expect(stderrLines.join("\n")).not.toMatch(/switching/i); // no "switching" line
    } finally {
      spy.mockRestore();
    }
  });

  it("a paid 402 with a free pool configured STILL never rotates — the pool is irrelevant to a paid profile", async () => {
    const seen: string[] = [];
    const inner = async (_u: string, init: { body: string }) => {
      const m = JSON.parse(init.body).model as string;
      seen.push(m);
      if (m === "paid/model") return res(402, "insufficient credits");
      // If the decorator ever rotated, it would land here — assert it never does.
      return res(200, "{}");
    };
    const wrapped = withFreeRotation(inner, paidHooks());
    const r = await wrapped("u", req("paid/model"));
    expect(r.status).toBe(402);
    expect(seen).toEqual(["paid/model"]); // no "a:free"/"b:free" ever requested
  });

  it("a paid 402 with NO free pool surfaces the ORIGINAL 402 (actionable), not a downstream error", async () => {
    const inner = async (_u: string, init: { body: string }) => {
      const m = JSON.parse(init.body).model as string;
      return m === "paid/model" ? res(402, "insufficient credits") : res(200, "{}");
    };
    const wrapped = withFreeRotation(inner, paidHooks({ pool: () => [] }));
    const r = await wrapped("u", req("paid/model"));
    expect(r.status).toBe(402);
    expect(await r.text()).toContain("insufficient credits");
  });

  it("a paid 402 where the free pool ALSO exhausts surfaces the original 402, not the free 429", async () => {
    const inner = async (_u: string, init: { body: string }) => {
      const m = JSON.parse(init.body).model as string;
      return m === "paid/model"
        ? res(402, "insufficient credits")
        : res(429, "free-models-per-day"); // every free model capped too
    };
    const wrapped = withFreeRotation(inner, paidHooks());
    const r = await wrapped("u", req("paid/model"));
    expect(r.status).toBe(402); // the credit issue is the actionable one
    expect(await r.text()).toContain("insufficient credits");
  });
});

describe("persistent registry — survives across processes (the CLI and the MCP server share one quota)", () => {
  let dir: string;
  let prev: string | undefined;

  beforeEach(() => {
    prev = process.env.LLM_EXT_CONFIG_DIR;
    // mkdtemp under /tmp specifically: getConfigDir()'s traversal guard only
    // permits paths under $HOME or /tmp, and os.tmpdir() resolves to
    // /var/folders/... on macOS — which it rejects.
    dir = mkdtempSync(join("/tmp", "llm-ext-cooldown-"));
    process.env.LLM_EXT_CONFIG_DIR = dir;
    resetCooldownCacheForTests();
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
    else process.env.LLM_EXT_CONFIG_DIR = prev;
    resetCooldownCacheForTests();
  });

  it("writes a cooldown to disk and reads it back in a fresh process", () => {
    recordUnavailable("a:free", "free-models-per-day", T0);
    expect(existsSync(cooldownFilePath())).toBe(true);
    const onDisk = JSON.parse(readFileSync(cooldownFilePath(), "utf-8"));
    expect(onDisk.models["a:free"].kind).toBe("daily-quota");

    // Simulate a second process: drop the in-memory copy, re-read from disk.
    resetCooldownCacheForTests();
    expect(isCooling(getCooldownStore(T0 + 1_000), "a:free", T0 + 1_000)).toBe(true);
  });

  it("a success clears the on-disk cooldown", () => {
    recordUnavailable("a:free", "429", T0);
    recordAvailable("a:free", T0 + 1_000);
    resetCooldownCacheForTests();
    expect(isCooling(getCooldownStore(T0 + 2_000), "a:free", T0 + 2_000)).toBe(false);
  });

  it("a corrupt registry file degrades to an empty one — it never fails a live call", () => {
    writeFileSync(cooldownFilePath(), "{ not json", "utf-8");
    resetCooldownCacheForTests();
    expect(getCooldownStore(T0).models).toEqual({});
    // And it is still writable afterwards.
    expect(() => recordUnavailable("a:free", "429", T0)).not.toThrow();
  });

  it("does NOT rewrite an in-force daily-quota cooldown when a later error on the same model is ambiguous (S1, review of 527d5e8: recordUnavailable used to pass runUnusableKind(modelId) as knownKind UNCONDITIONALLY, so ANY later ambiguous error on an already-marked model — a timeout, a 5xx, a synthetic 'already verified unavailable this run' message — re-ran applyUnavailable and rewrote the store even though the existing verdict was still in force)", () => {
    recordUnavailable("quota/steady:free", "free-models-per-day limit reached", T0);
    const before = JSON.parse(readFileSync(cooldownFilePath(), "utf-8"));
    expect(before.models["quota/steady:free"].kind).toBe("daily-quota");
    const beforeMtimeMs = statSync(cooldownFilePath()).mtimeMs;

    // A synthetic ambiguous error (mirrors driver.ts's "model already
    // verified unavailable this run" message for a sibling fan-out slot) —
    // classifyUnavailable(detail) alone returns null for it, so pre-fix the
    // unconditional runUnusableKind(modelId) fallback re-applied
    // applyUnavailable and rewrote the entry's `detail` field (and, for a
    // TRANSIENT kind, would also have moved `until` and bumped `strikes` —
    // see computeCooldownUntil: strikes only affect the TRANSIENT backoff
    // ladder, not the daily-quota/gone horizons, so this particular rewrite
    // wouldn't have moved `until`, but it still meant an unconditional,
    // needless disk write plus a `detail` field that no longer matches what
    // actually put the model on cooldown).
    recordUnavailable(
      "quota/steady:free",
      "model already verified unavailable this run (shared verdict, no new HTTP call)",
      T0 + 2_000,
    );

    const after = JSON.parse(readFileSync(cooldownFilePath(), "utf-8"));
    expect(after).toEqual(before);
    expect(statSync(cooldownFilePath()).mtimeMs).toBe(beforeMtimeMs);
  });
});

// TRDD-6HGJFPDR — the classifier ORDERING FLOOR.
//
// `rankFreeModelsByBenchEvidence` orders; it does not exclude. Ordering runs out:
// once the pool is short enough that selection reaches the bottom, "last" and
// "selected" are the same position, and a safety classifier — which cannot
// generate a code review at all — becomes an ensemble member. Measured at pool
// size 3 in TRDD-V32LB992 §3e.5.
//
// The safety property rested entirely on a substring heuristic over a model NAME
// (V32LB992 §3e.7 measured ZERO pool members carrying a scored ledger verdict, so
// the evidence fold contributes nothing to the ordering). A vendor shipping a
// classifier under an unmatched name defeats it silently — so the first test here
// makes the heuristic's coverage FIRE in CI instead of being remembered.
describe("classifier ordering floor (TRDD-6HGJFPDR)", () => {
  const CLASSIFIER = "nvidia/nemotron-3.5-content-safety:free";
  const noCatalog = new Map();

  it("still recognises the known classifier id — a vendor rename reddens CI", () => {
    // Asserted through the EXPORTED ranker, not the private looksLikeClassifier:
    // the observable property is "clamped to last", and testing the private
    // helper would pin the implementation rather than the guarantee.
    const ranked = rankFreeModelsByBenchEvidence(
      ["a-generator:free", CLASSIFIER, "b-generator:free"],
      new Map(),
    );
    expect(ranked[ranked.length - 1]).toBe(CLASSIFIER);
  });

  it("does NOT select a classifier from a short pool — where ordering runs out", () => {
    const pool = ["a-generator:free", CLASSIFIER, "b-generator:free"];
    const chosen = selectFreeEnsembleModels(pool, noCatalog);
    expect(chosen).not.toContain(CLASSIFIER);
    expect(chosen).toEqual(["a-generator:free", "b-generator:free"]);
  });

  it("never returns an EMPTY ensemble, even when every member is a classifier", () => {
    // Degraded beats dark: an unconditional exclusion would take the tool offline.
    const allClassifiers = [CLASSIFIER, "meta/llama-guard-4:free", "x/foo-safety:free"];
    const chosen = selectFreeEnsembleModels(allClassifiers, noCatalog);
    expect(chosen.length).toBeGreaterThan(0);
    expect(chosen).toEqual(allClassifiers);
  });

  it("leaves a LONG pool's selection unchanged — the floor only bites when short", () => {
    // The live pool is 18 and the classifier already ranks below the top 3, so
    // this pins that the exclusion introduced no behaviour change there.
    const long = [
      "g1:free", "g2:free", "g3:free", "g4:free", "g5:free", CLASSIFIER,
    ];
    expect(selectFreeEnsembleModels(long, noCatalog)).toEqual([
      "g1:free", "g2:free", "g3:free",
    ]);
  });
});

describe("looksLikeClassifier — export (P2, addendum M)", () => {
  it("is true for a content-safety guard id, false for an ordinary generator id", () => {
    expect(looksLikeClassifier("nvidia/nemotron-3.5-content-safety:free")).toBe(true);
    expect(looksLikeClassifier("nvidia/nemotron-3-super-120b-a12b:free")).toBe(false);
  });
});

describe("classifyUnavailable's 403 gate — model-specific vs auth/key ambiguous (P2 amendment, 2026-09-16)", () => {
  it("classifies a bare/generic 403 (no model-specific phrasing) as null — an auth/key problem, not a per-model verdict", () => {
    expect(
      classifyUnavailable("API error 403 (openrouter): No auth credentials found"),
    ).toBeNull();
    expect(classifyUnavailable("API error 403 (openrouter): Forbidden")).toBeNull();
  });

  it("still classifies a 403 naming the model ('only available' / 'unavailable for free') as gone", () => {
    expect(
      classifyUnavailable("API error 403 (openrouter): x/y:free is only available on agentic harnesses"),
    ).toBe("gone");
    expect(
      classifyUnavailable("API error 403 (openrouter): x/y:free is unavailable for free tier use"),
    ).toBe("gone");
  });

  it("classifies a bare 410 as gone — unlike 403, 'Gone' is unambiguous and needs no phrasing gate", () => {
    // Review finding (2026-09-16): completion.ts's deterministic4xx gate
    // already skips same-model retry on a 410, but before this classify
    // branch existed a 410 was NEVER marked run-unusable (classify returned
    // null), so it was retried forever on the NEXT overall attempt with no
    // memory it was ever dead.
    expect(classifyUnavailable("API error 410 (openrouter): model retired")).toBe("gone");
  });
});

describe("a 401 is never an availability verdict (TRDD-8GE0OJ5R)", () => {
  // The REAL OpenRouter 401 body, recorded in the decisions fixture.
  const fixture = JSON.parse(
    readFileSync(join(__dirname, "classifiers/__fixtures__/p01/dec-err401.json"), "utf-8"),
  ) as { body: string };
  const detail = `API error 401 (openrouter): ${JSON.parse(fixture.body).error.message}`;

  it("classifyUnavailable returns null for the real 401 'User not found.' body", () => {
    expect(detail).toBe("API error 401 (openrouter): User not found.");
    expect(classifyUnavailable(detail)).toBeNull();
    expect(classifyUnavailable(detail, { credentialProvenGoodElsewhere: true })).toBeNull();
  });

  it("callWithFreeRotation rethrows a 401: no cooldown recorded, no rotation to the next model", async () => {
    const called: string[] = [];
    const store = memoryRotationStore();
    await expect(
      callWithFreeRotation(
        slot("p:free"),
        [slot("f1:free"), slot("f2:free")],
        async (m) => {
          called.push(m);
          throw new Error(detail);
        },
        { now: () => T0, store },
      ),
    ).rejects.toThrow(detail);
    expect(called).toEqual(["p:free"]);
    expect(isCooling(store.get(T0), "p:free", T0)).toBe(false);
    expect(isRunUnusable("p:free")).toBe(false);
  });
});

describe("classifyUnavailable's credential discriminator — generic 403 (TRDD-90DM5YHO item 1)", () => {
  it("a generic 403 with credentialProvenGoodElsewhere unset (or false) stays null — unchanged default", () => {
    expect(
      classifyUnavailable("API error 403 (openrouter): No auth credentials found"),
    ).toBeNull();
    expect(
      classifyUnavailable("API error 403 (openrouter): No auth credentials found", {
        credentialProvenGoodElsewhere: false,
      }),
    ).toBeNull();
  });

  it("a generic 403 becomes gone when the caller has proven the credential good on another model", () => {
    expect(
      classifyUnavailable("API error 403 (openrouter): No auth credentials found", {
        credentialProvenGoodElsewhere: true,
      }),
    ).toBe("gone");
  });

  it("credentialProvenGoodElsewhere does not affect a MODEL-specific 403 (already gone) or a non-403 error", () => {
    expect(
      classifyUnavailable(
        "API error 403 (openrouter): x/y:free is only available on agentic harnesses",
        { credentialProvenGoodElsewhere: false },
      ),
    ).toBe("gone");
    expect(
      classifyUnavailable("HTTP 429: too many requests", { credentialProvenGoodElsewhere: true }),
    ).toBe("transient");
  });
});

describe("markCredentialSucceeded / credentialSucceededOnOtherModel (TRDD-90DM5YHO item 1)", () => {
  afterEach(() => {
    resetCredentialSuccessForTests();
  });

  it("no success recorded yet — false for any model", () => {
    expect(credentialSucceededOnOtherModel("openrouter", "https://a", "sk-a", "model/a")).toBe(
      false,
    );
  });

  it("a success on model B does NOT count for model B itself, only for OTHER models", () => {
    markCredentialSucceeded("openrouter", "https://a", "sk-a", "model/b");
    expect(credentialSucceededOnOtherModel("openrouter", "https://a", "sk-a", "model/b")).toBe(
      false,
    );
    expect(credentialSucceededOnOtherModel("openrouter", "https://a", "sk-a", "model/a")).toBe(
      true,
    );
  });

  it("a different credential (key, type, OR baseUrl) does not leak across fingerprints", () => {
    markCredentialSucceeded("openrouter", "https://a", "sk-a", "model/b");
    expect(
      credentialSucceededOnOtherModel("openrouter", "https://a", "sk-different-key", "model/a"),
    ).toBe(false);
    expect(credentialSucceededOnOtherModel("local", "https://a", "sk-a", "model/a")).toBe(false);
    expect(credentialSucceededOnOtherModel("openrouter", "https://b", "sk-a", "model/a")).toBe(
      false,
    );
  });

  it("an empty apiKey is never marked or matched — no falsy-key collision across keyless backends", () => {
    markCredentialSucceeded("local", "http://127.0.0.1:1234", "", "model/b");
    expect(credentialSucceededOnOtherModel("local", "http://127.0.0.1:1234", "", "model/a")).toBe(
      false,
    );
  });
});

describe("runUnusable — this-run-only registry (P2, design §3.1 point 3 / §5)", () => {
  it("markRunUnusable + isRunUnusable round-trip; unmarked ids stay false", () => {
    expect(isRunUnusable("some/model:free")).toBe(false);
    markRunUnusable("some/model:free", "gone");
    expect(isRunUnusable("some/model:free")).toBe(true);
    expect(isRunUnusable("other/model:free")).toBe(false);
  });

  it("a FOLLOWING test starts with an empty set — the afterEach reset actually resets module state", () => {
    // This test relies on the PRECEDING test having marked "some/model:free"
    // and NOT calling resetRunUnusableForTests itself — the top-of-file
    // afterEach is what must have cleared it. If module state leaked across
    // tests (the failure mode this pins), this would see `true`.
    expect(isRunUnusable("some/model:free")).toBe(false);
  });

  it("recordUnavailable marks a 'gone'/'daily-quota' verdict run-unusable, but NOT a transient one", () => {
    const dir = mkdtempSync(join("/tmp", "llm-ext-rununusable-"));
    const prev = process.env.LLM_EXT_CONFIG_DIR;
    process.env.LLM_EXT_CONFIG_DIR = dir;
    try {
      resetCooldownCacheForTests();
      recordUnavailable("dead/model:free", "No endpoints found for model", T0);
      expect(isRunUnusable("dead/model:free")).toBe(true);
      recordUnavailable("flaky/model:free", "HTTP 429: too many requests", T0);
      expect(isRunUnusable("flaky/model:free")).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
      else process.env.LLM_EXT_CONFIG_DIR = prev;
      resetCooldownCacheForTests();
    }
  });
});

describe("callWithFreeRotation — a model-specific 403 marks the model run-unusable and rotates to the next (P2 amendment test h)", () => {
  it("marks the failing model and returns the next candidate's result", async () => {
    const dir = mkdtempSync(join("/tmp", "llm-ext-rotate-h-"));
    const prev = process.env.LLM_EXT_CONFIG_DIR;
    process.env.LLM_EXT_CONFIG_DIR = dir;
    try {
      resetCooldownCacheForTests();
      const calls: string[] = [];
      const result = await callWithFreeRotation<string>(
        slot("dead/model:free"),
        [slot("healthy/model:free")],
        async (model) => {
          calls.push(model);
          if (model === "dead/model:free") {
            throw new Error(
              "API error 403 (openrouter): dead/model:free is only available on agentic harnesses",
            );
          }
          return "ok from healthy model";
        },
        { now: () => T0 },
      );
      expect(result).toBe("ok from healthy model");
      expect(calls).toEqual(["dead/model:free", "healthy/model:free"]);
      expect(isRunUnusable("dead/model:free")).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
      else process.env.LLM_EXT_CONFIG_DIR = prev;
      resetCooldownCacheForTests();
    }
  });
});

describe("unusableModelIds / isUnusable — the §5 union, and its lazy read (P2 amendment items 1 and 3)", () => {
  let dir: string;
  let prevCfg: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join("/tmp", "llm-ext-unusable-"));
    prevCfg = process.env.LLM_EXT_CONFIG_DIR;
    process.env.LLM_EXT_CONFIG_DIR = dir;
    resetRecentModelEventsCacheForTests();
  });
  afterEach(() => {
    if (prevCfg === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
    else process.env.LLM_EXT_CONFIG_DIR = prevCfg;
    resetRecentModelEventsCacheForTests();
    vi.restoreAllMocks();
  });

  it("unions benchmarkFailedModels(), the durable runtime verdict (3 trailing 404s in the ledger), and runUnusable", () => {
    // Benchmark-failed source: a recorded FAILING security-triage verdict.
    writeFileSync(
      join(dir, "security-triage-results.json"),
      JSON.stringify({
        "bench/failed:free::2026-07-16::hashB": {
          date: "2026-07-16",
          score: { pass: false, inconclusive: false },
        },
      }),
      "utf-8",
    );
    // Durable-verdict source: 3 trailing rotate-worthy (404) failures, recent.
    const now = new Date();
    for (let i = 0; i < 3; i++) {
      modelEventsModule.appendModelEvent(
        "durable/dead:free",
        "non_retryable_failure",
        "HTTP 404: no endpoints",
      );
    }
    // Run-scoped source.
    markRunUnusable("run-marked/model:free", "gone");

    const ids = unusableModelIds(now.getTime());
    expect(ids.has("bench/failed:free")).toBe(true);
    expect(ids.has("durable/dead:free")).toBe(true);
    expect(ids.has("run-marked/model:free")).toBe(true);
    expect(ids.has("healthy/model:free")).toBe(false);
    expect(isUnusable("bench/failed:free", now.getTime())).toBe(true);
    expect(isUnusable("healthy/model:free", now.getTime())).toBe(false);
  });

  it("reads model-events.log at most once across two unusableModelIds() calls in the same process (lazy cache)", () => {
    modelEventsModule.appendModelEvent("some/model:free", "non_retryable_failure", "HTTP 404: x");
    const spy = vi.spyOn(modelEventsModule, "readModelEvents");
    const now = Date.now();
    unusableModelIds(now);
    unusableModelIds(now + 1000);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

// ── TRDD-W9XLU1HD AC3: persisted eviction strikes ───────────────────────

describe("AC3 persisted eviction — gone strikes accumulate across restarts and gate reconcile re-adoption", () => {
  let dir: string;
  let prev: string | undefined;

  beforeEach(() => {
    prev = process.env.LLM_EXT_CONFIG_DIR;
    dir = mkdtempSync(join("/tmp", "llm-ext-gone-evict-"));
    process.env.LLM_EXT_CONFIG_DIR = dir;
    resetCooldownCacheForTests();
    resetRunUnusableForTests();
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
    else process.env.LLM_EXT_CONFIG_DIR = prev;
    resetCooldownCacheForTests();
    resetRunUnusableForTests();
  });

  const GONE_DETAIL = "API error 404: not found";

  it("three 'gone' verdicts in SEPARATE simulated processes evict the model from reconcile re-adoption", () => {
    // Simulate three distinct runs (process restarts) each classifying the
    // model gone: the strike count must survive the in-memory cache being
    // dropped between them.
    for (let run = 0; run < GONE_EVICT_STRIKES; run++) {
      recordUnavailable("dead/thrice:free", GONE_DETAIL, T0 + run * 60_000);
      resetCooldownCacheForTests(); // process restart
    }
    expect(goneEvictedModels(T0 + 10 * 60_000).has("dead/thrice:free")).toBe(true);
  });

  it("one or two 'gone' verdicts do NOT evict (below the N=3 bar)", () => {
    recordUnavailable("dead/once:free", GONE_DETAIL, T0);
    recordUnavailable("dead/twice:free", GONE_DETAIL, T0);
    recordUnavailable("dead/twice:free", GONE_DETAIL, T0 + 60_000); // 2nd run
    resetCooldownCacheForTests();
    const evicted = goneEvictedModels(T0 + 120_000);
    expect(evicted.has("dead/once:free")).toBe(false);
    expect(evicted.has("dead/twice:free")).toBe(false);
  });

  it("a daily-quota verdict never earns an eviction strike", () => {
    recordUnavailable("quota/healthy:free", "free-models-per-day limit reached", T0);
    resetCooldownCacheForTests();
    expect(goneEvictedModels(T0 + 60_000).has("quota/healthy:free")).toBe(false);
  });

  it("a successful call (recordAvailable) heals the eviction — strikes cleared and persisted", () => {
    for (let run = 0; run < GONE_EVICT_STRIKES; run++) {
      recordUnavailable("healed/model:free", GONE_DETAIL, T0 + run * 60_000);
    }
    expect(goneEvictedModels(T0 + 10 * 60_000).has("healed/model:free")).toBe(true);
    // A real successful answer arrives (the strongest counter-evidence).
    recordAvailable("healed/model:free", T0 + 11 * 60_000);
    resetCooldownCacheForTests(); // prove the heal was PERSISTED, not just in-memory
    expect(goneEvictedModels(T0 + 12 * 60_000).has("healed/model:free")).toBe(false);
  });

  it("strikes expire after GONE_EVICT_TTL_MS — the model may be re-probed/re-adopted", () => {
    for (let run = 0; run < GONE_EVICT_STRIKES; run++) {
      recordUnavailable("aged/model:free", GONE_DETAIL, T0 + run * 60_000);
    }
    const lastAt = T0 + (GONE_EVICT_STRIKES - 1) * 60_000;
    expect(goneEvictedModels(lastAt + GONE_EVICT_TTL_MS - 1).has("aged/model:free")).toBe(true);
    expect(goneEvictedModels(lastAt + GONE_EVICT_TTL_MS).has("aged/model:free")).toBe(false);
  });

  it("a fresh 'gone' verdict after the TTL restarts the count at 1 (windowed, not lifetime)", () => {
    for (let run = 0; run < GONE_EVICT_STRIKES; run++) {
      recordUnavailable("windowed/model:free", GONE_DETAIL, T0 + run * 60_000);
    }
    const lastAt = T0 + (GONE_EVICT_STRIKES - 1) * 60_000;
    // One more verdict AFTER the TTL: must restart at 1, not reach 4.
    recordUnavailable("windowed/model:free", GONE_DETAIL, lastAt + GONE_EVICT_TTL_MS + 1);
    resetCooldownCacheForTests();
    expect(goneEvictedModels(lastAt + GONE_EVICT_TTL_MS + 2).has("windowed/model:free")).toBe(false);
  });
});

// ── TRDD-W9XLU1HD coordinator mitigation: the distinct generic-403 quorum ──

describe("generic-403 pool quorum — 2+ distinct models refusing with bare 403s makes the 403 rotate-worthy", () => {
  it("POOL_403_QUORUM is 2 (the coordinator decision; changing it is deliberate)", () => {
    expect(POOL_403_QUORUM).toBe(2);
  });

  it("a single generic 403 stays non-evicting (null, not 'gone')", () => {
    noteGeneric403Model("pool/solo:free");
    expect(
      classifyUnavailable('API error 403 (openrouter): {"error":{"message":"Forbidden"}}'),
    ).toBeNull();
  });

  it("after 2 distinct models have bare-403'd this run, classifyUnavailable returns 'gone'", () => {
    noteGeneric403Model("pool/a:free");
    noteGeneric403Model("pool/b:free");
    expect(
      classifyUnavailable('API error 403 (openrouter): {"error":{"message":"Forbidden"}}'),
    ).toBe("gone");
  });

  it("a MODEL-SPECIFIC 403 bypasses the quorum gate entirely (it always classified gone)", () => {
    noteGeneric403Model("pool/a:free");
    noteGeneric403Model("pool/b:free");
    expect(
      classifyUnavailable("API error 403 (openrouter): m:free is only available on agentic harnesses"),
    ).toBe("gone");
  });

  it("the same model 403-ing twice does NOT arm the quorum — distinctness is the point", () => {
    noteGeneric403Model("pool/one:free");
    noteGeneric403Model("pool/one:free");
    expect(
      classifyUnavailable('API error 403 (openrouter): {"error":{"message":"Forbidden"}}'),
    ).toBeNull();
  });
});

describe("round C item 4 (TRDD-YG72CYY7): single-model paths never return the breaker verdict as model content", () => {
  it("__ensureNotServiceAbortForTests: a serviceAbort verdict throws with its content; a normal result passes through", async () => {
    const dir = mkdtempSync(join("/tmp", "llm-ext-c4-"));
    writeFileSync(
      join(dir, "settings.yaml"),
      [
        "active: bare",
        "allow_paid_models: true",
        "profiles:",
        "  bare:",
        "    mode: remote",
        "    api: openrouter-remote",
        "    model: vendor/whatever",
        "    api_key: \"sk-test-fake-openrouter-key\"",
        "",
      ].join("\n"),
      "utf-8",
    );
    const prev = process.env.LLM_EXT_CONFIG_DIR;
    process.env.LLM_EXT_CONFIG_DIR = dir;
    try {
      vi.resetModules();
      const idx = (await import("./index.js")) as {
        __ensureNotServiceAbortForTests?: (r: unknown) => unknown;
      };
      // The fix exports the single-model abort guard under the file's
      // __...ForTests convention; at HEAD it does not exist (failing-first).
      expect(typeof idx.__ensureNotServiceAbortForTests).toBe("function");
      const ensure = idx.__ensureNotServiceAbortForTests!;
      const abort = {
        content: "SERVER ISSUE DETECTED: 5 consecutive failures. Please retry later.",
        model: "m",
        finishReason: "error",
        truncated: true,
        serviceAbort: true,
      };
      expect(() => ensure(abort)).toThrow(/SERVER ISSUE DETECTED/);
      const ok = { content: "real answer", model: "m", finishReason: "stop", truncated: false };
      expect(ensure(ok)).toBe(ok);
    } finally {
      if (prev === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
      else process.env.LLM_EXT_CONFIG_DIR = prev;
    }
  }, 30_000);

  it("wiring: all four single-model return sites funnel through ensureNotServiceAbort (source-level guard, free-rotation-coverage pattern)", () => {
    const src = readFileSync(join(__dirname, "index.ts"), "utf-8");
    const code = src
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n");
    // One implementation, three call sites: the single-qualifying-model
    // shortcut, walkProfileChainOnce's return, and callSingleWithFreeRotation's
    // return (its rotation hands a breaker verdict straight back —
    // classifyUnavailable returns null on "server issue detected").
    // Exclude the __ensureNotServiceAbortForTests hook (its body is also
    // "return ensureNotServiceAbort(resp);") — count only production sites.
    // Exclude the __ensureNotServiceAbortForTests hook (its one-line body
    // is also "return ensureNotServiceAbort(...)") — count only production
    // sites, which wrap a multi-line call, not the hook's (resp) pass-through.
    const sites = code
      .split("\n")
      .filter((l) => l.includes("return ensureNotServiceAbort(") && !l.includes("resp);"));
    // Round C review H1: the pinned paid modelOverride branch is the fourth site (it missed the wrap and the count of 3 blessed that).
    expect(sites.length).toBe(4);
    // No bare `return await chatCompletionWithRetry(` may remain: it would hand the breaker verdict up as model content.
    expect(code.split("\n").filter((l) => l.includes("return await chatCompletionWithRetry(")).length).toBe(0);
  });
});
