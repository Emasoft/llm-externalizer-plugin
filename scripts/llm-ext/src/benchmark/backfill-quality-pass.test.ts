import { describe, it, expect } from "vitest";
import { backfillLegacyQualityPass, type BackfillableRow } from "./backfill-quality-pass.js";

interface Score {
  macroF1: number;
}
/** Annotate every fixture: a bare literal infers WITHOUT `qualityPass`, so the
 *  assertions that read it back would not type-check (vitest still ran them). */
type Rows<S> = Record<string, BackfillableRow<S>>;
const passes = (s: Score): boolean => s.macroF1 >= 0.5;

describe("backfillLegacyQualityPass", () => {
  it("judges a legacy row from the score it already carries, with no model call", () => {
    const cache: Rows<Score> = {
      "m/a:free::2026-05-24::HASH": { datasetHash: "HASH", score: { macroF1: 0.9 } },
      "m/b:free::2026-08-02::HASH": { datasetHash: "HASH", score: { macroF1: 0.0 } },
    };
    expect(backfillLegacyQualityPass(cache, "HASH", passes)).toBe(2);
    expect(cache["m/a:free::2026-05-24::HASH"].qualityPass).toBe(true);
    expect(cache["m/b:free::2026-08-02::HASH"].qualityPass).toBe(false);
  });

  it("never overwrites a verdict written at benchmark time", () => {
    const cache: Rows<Score> = {
      k: { datasetHash: "HASH", score: { macroF1: 0.0 }, qualityPass: true },
    };
    expect(backfillLegacyQualityPass(cache, "HASH", passes)).toBe(0);
    expect(cache.k.qualityPass).toBe(true);
  });

  it("leaves a row from a different dataset unjudged — a score is only valid against its own dataset", () => {
    const cache: Rows<Score> = { k: { datasetHash: "OLD", score: { macroF1: 0.9 } } };
    expect(backfillLegacyQualityPass(cache, "NEW", passes)).toBe(0);
    expect(cache.k.qualityPass).toBeUndefined();
  });

  it("skips a row with no score rather than inventing a verdict", () => {
    const cache: Record<string, { datasetHash?: string; score?: Score; qualityPass?: boolean }> = {
      k: { datasetHash: "HASH" },
    };
    expect(backfillLegacyQualityPass(cache, "HASH", passes)).toBe(0);
    expect(cache.k.qualityPass).toBeUndefined();
  });

  it("a malformed score does not abort the run — that row is skipped, later rows still upgrade", () => {
    const boom = (s: Score): boolean => {
      if ((s as unknown as { bad?: boolean }).bad) throw new Error("malformed");
      return s.macroF1 >= 0.5;
    };
    const cache: Rows<Score> = {
      bad: { datasetHash: "H", score: { bad: true } as unknown as Score },
      good: { datasetHash: "H", score: { macroF1: 0.8 } },
    };
    expect(backfillLegacyQualityPass(cache, "H", boom)).toBe(1);
    expect(cache.bad.qualityPass).toBeUndefined();
    expect(cache.good.qualityPass).toBe(true);
  });

  it("an abstaining predicate leaves the row unjudged, never records a false", () => {
    // security-triage's shape: an `inconclusive` run judged nothing, and
    // writing `false` would demote a model the benchmark never scored.
    interface Triage { pass: boolean; inconclusive?: boolean }
    const verdict = (s: Triage): boolean | undefined => (s.inconclusive ? undefined : s.pass);
    const cache: Rows<Triage> = {
      incon: { datasetHash: "H", score: { pass: false, inconclusive: true } as Triage },
      real: { datasetHash: "H", score: { pass: false } as Triage },
    };
    expect(backfillLegacyQualityPass(cache, "H", verdict)).toBe(1);
    expect(cache.incon.qualityPass).toBeUndefined();
    expect(cache.real.qualityPass).toBe(false);
  });

  it("is idempotent — a second pass upgrades nothing", () => {
    const cache: Rows<Score> = { k: { datasetHash: "H", score: { macroF1: 0.9 } } };
    expect(backfillLegacyQualityPass(cache, "H", passes)).toBe(1);
    expect(backfillLegacyQualityPass(cache, "H", passes)).toBe(0);
  });
});
