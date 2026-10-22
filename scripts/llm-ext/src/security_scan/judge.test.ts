/**
 * Row 101 fix-queue: judgeGroups' cost-safety gate now takes `freeOnly` as an
 * explicit REQUIRED parameter (JudgeOptions.freeOnly) instead of reading the
 * module-global getActiveFreeOnly() itself — mirrors 4d160a8's treatment of
 * benchmark/runner.ts. These two tests prove the gate reads ONLY opts.freeOnly,
 * never a stale/leaked global from an unrelated caller in the same process.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setValidationBypassForTests } from "../benchmark/validated.js";
import { getActiveFreeOnly, setActiveFreeOnly, setActiveRouting } from "../config";
import { judgeGroups, type FetchImpl, type JudgeOptions } from "./judge";
import type { DedupGroup } from "./intake";
import type { ModelPricing } from "../mass_scouting/cost-estimate";

const TEST_PRICING: ModelPricing = {
  input_per_m_usd: 0.04,
  output_per_m_usd: 0.1,
  context_window: 32_000,
};

function oneGroup(): DedupGroup[] {
  return [
    {
      key: "g1",
      category: "c",
      content: "console.log('hi')",
      members: [{ id: "x", category: "c", snippet: "console.log('hi')" }] as never,
    },
  ];
}

/** A deterministic FetchImpl that always returns a not_threat verdict. */
function mockFetch(): { fetch: FetchImpl; calls: number } {
  let calls = 0;
  const out = {
    fetch: (async () => {
      calls++;
      const payload = {
        choices: [
          {
            message: {
              content: JSON.stringify({
                verdict: "not_threat",
                confidence: 0.95,
                reason: "benign",
                injection_observed: false,
              }),
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 30 },
      };
      return {
        ok: true,
        status: 200,
        json: async () => payload,
        text: async () => JSON.stringify(payload),
      };
    }) as FetchImpl,
    get calls() {
      return calls;
    },
  };
  return out;
}

function baseOpts(freeOnly: boolean): JudgeOptions {
  return {
    model: "qwen/qwen-2.5-7b-instruct", // paid, non-':free'
    apiKey: "test-key",
    pricing: TEST_PRICING,
    freeOnly,
    workers: 1,
    maxRetries: 1,
    perCallTimeoutMs: 5_000,
    consecutiveFailureLimit: 5,
    defaultVerdictOnError: "uncertain",
    rubrics: {},
  };
}

// judge.ts appends a usage-history line per LLM web request. Redirect the
// history config dir to a throwaway /tmp dir so these unit tests never write
// to the developer's real ~/.llm-externalizer/.
let histPrevCfg: string | undefined;
let histTmp: string;
beforeEach(() => {
  setValidationBypassForTests(true); // plumbing tests with a MOCKED fetch
  histPrevCfg = process.env.LLM_EXT_CONFIG_DIR;
  histTmp = mkdtempSync(join("/tmp", "judge-hist-"));
  process.env.LLM_EXT_CONFIG_DIR = histTmp;
});
afterEach(() => {
  setValidationBypassForTests(false);
  if (histPrevCfg === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
  else process.env.LLM_EXT_CONFIG_DIR = histPrevCfg;
  rmSync(histTmp, { recursive: true, force: true });
});

describe("judgeGroups — freeOnly cost-safety gate reads opts.freeOnly, never the global (row 101 fix-queue)", () => {
  it("a stale global true does not gate a paid call that received freeOnly:false", async () => {
    // Deliberately leave the global TRUE (as a previous free job in the same
    // process would) and pass freeOnly: false explicitly.
    setActiveFreeOnly(true);
    // getActiveBillableForModel defaults to false with no routing configured,
    // which would make the gate a no-op regardless of freeOnly — force
    // billable true so this test actually exercises the gate.
    setActiveRouting((): never[] => [], true);
    const m = mockFetch();
    try {
      const result = await judgeGroups(oneGroup(), baseOpts(false), m.fetch);
      expect(result.groupsOk).toBe(1);
      expect(result.groupsFailSafe).toBe(0);
      expect(m.calls).toBe(1);
    } finally {
      setActiveFreeOnly(false); // never leak into other tests
      setActiveRouting((): never[] => [], false);
    }
  });

  it("a stale global false does not let a free-only call through", async () => {
    // Reverse: the global says paid is fine, but THIS call asked for
    // freeOnly: true against a non-':free' model — the gate must still
    // refuse before any request.
    const orig = getActiveFreeOnly();
    setActiveFreeOnly(false);
    setActiveRouting((): never[] => [], true);
    const m = mockFetch();
    try {
      await expect(
        judgeGroups(oneGroup(), baseOpts(true), m.fetch),
      ).rejects.toThrow(/free_only cost-safety/);
      expect(m.calls).toBe(0); // refused before any fetch
    } finally {
      setActiveFreeOnly(orig);
      setActiveRouting((): never[] => [], false);
    }
  });
});
