// TRDD-SZ7TO9FW increment 1: the unified verdict module reads the six existing stores. Real files in a throwaway
// llm-ext-* directory under /tmp (calibration records are written by the production writeRecord), never the user's config dir.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BrokerEngine } from "../broker/protocol.js";
import { FIXTURE_VERSION, HARNESS_VERSION, PRODUCTION_HARNESS_ID, writeRecord, type CalibrationRecord, type PerKind } from "../calibration/record.js";
import { tmpdir } from "../test-tmp-root.js";
import { COMMAND_KINDS, fileSources, isCommandKind, verdict, type CurrentHashes, type VerdictResult } from "./verdicts.js";

const NOW = Date.parse("2026-11-14T12:00:00Z");
const HASHES: CurrentHashes = { scout: "hs", hqScanQuality: "hh", textTool: (k) => `ht-${k}` };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "llm-ext-verdicts-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const put = (file: string, body: unknown): void => writeFileSync(join(dir, file), JSON.stringify(body));
const ask = (model: string, kind: string, hashes: CurrentHashes = HASHES): VerdictResult => verdict(fileSources(dir, hashes, NOW), model, kind);
const kw = (ok: boolean, pass: boolean, date: string, schemaCompliant?: boolean): object => ({ date, ok, pass, schemaCompliant });
const score = (date: string, pass: boolean, inconclusive = false): object => ({ date, score: { pass, inconclusive, accuracy: 1 } });

function record(model: string, engine: BrokerEngine, fill: PerKind | null): CalibrationRecord {
  const base = {
    schema: 2 as const,
    harness: PRODUCTION_HARNESS_ID,
    harness_version: HARNESS_VERSION,
    fixture_version: FIXTURE_VERSION,
    engine,
    model,
    fingerprint: { blobs: [], ram_bytes: 1 },
    engine_version: "t",
    engine_version_checked: "2026-11-14T00:00:00.000Z",
    calibrated_at: "2026-11-14T10:00:00.000Z",
    duration_s: 1,
  };
  if (fill === null) return { ...base, status: "calibration-failed", failed_step: "phase-a", message: "boom" };
  return {
    ...base,
    status: "ok",
    failed_step: null,
    window_tokens: 8192,
    free_ram_bytes: 1,
    chars_per_token: 3,
    capabilities: { thinking: false, n_ctx_train: 8192 },
    thinking_works: { off: true, on: false },
    min_output_tokens: { fact: 1, aggregate: 1, bug: 1 },
    fill_tokens: fill,
    grid: [],
    structured_output: { off: true, on: true, array40: true },
    main: { slots: 1, slot_ctx: 4096 },
    scouting_candidates: [],
    speed: { prefill_tps: 1, decode_tps: 1, aggregate_tps: 1, load_avg: 0 },
    load_estimate: { weight_bytes: 1, kv_bytes_per_token: 1 },
  };
}

describe("S1 keyword sweep", () => {
  it("the latest ledger row decides, pass or fail, with its date", () => {
    put("general-keyword-results.json", { "m::2026-11-01": kw(true, true, "2026-11-01T00:00:00Z"), "m::2026-11-10": kw(true, false, "2026-11-10T00:00:00Z"), "p::2026-11-10": kw(true, true, "2026-11-10T00:00:00Z") });
    expect(ask("m", "chat")).toEqual({ verdict: "fail", store: "S1", at: "2026-11-10T00:00:00Z" });
    expect(ask("p", "chat")).toEqual({ verdict: "pass", store: "S1", at: "2026-11-10T00:00:00Z" });
  });
  it("schemaCompliant false is not a pass", () => {
    put("general-keyword-results.json", { "m::d": kw(true, true, "2026-11-10T00:00:00Z", false) });
    expect(ask("m", "chat").verdict).toBe("fail");
  });
  it("the ledger beats the snapshot for a model it mentions; the snapshot speaks only for an unseen model, with no date", () => {
    put("general-keyword-results.json", { "m::d": kw(true, false, "2026-11-10T00:00:00Z") });
    put("benchmark-results.json", { results: [{ modelId: "m", ok: true, pass: true }, { modelId: "snap", ok: true, pass: true }] });
    expect(ask("m", "chat").verdict).toBe("fail");
    expect(ask("snap", "chat")).toEqual({ verdict: "pass", store: "S1", at: null });
  });
});

describe("S2 triage ledger and the difficulty hierarchy", () => {
  it("security_scan: the latest conclusive triage row decides; an inconclusive latest row is untested", () => {
    put("security-triage-results.json", { "a::2026-11-01::h": score("2026-11-01", true), "b::2026-11-01::h": score("2026-11-01", true), "b::2026-11-09::h": score("2026-11-09", false), "c::2026-11-09::h": score("2026-11-09", false, true) });
    expect(ask("a", "security_scan")).toEqual({ verdict: "pass", store: "S2", at: "2026-11-01" });
    expect(ask("b", "security_scan")).toEqual({ verdict: "fail", store: "S2", at: "2026-11-09" });
    expect(ask("c", "security_scan")).toEqual({ verdict: "untested", store: null, at: null });
  });
  it("a harder pass covers an easier kind: a triage pass validates chat when the keyword sweep has no row", () => {
    put("security-triage-results.json", { "a::d::h": score("2026-11-01", true) });
    expect(ask("a", "chat")).toEqual({ verdict: "pass", store: "S2", at: "2026-11-01" });
  });
  it("a keyword pass never covers a ranked kind (validated.ts skips ledgers below the tool rank)", () => {
    put("general-keyword-results.json", { "m::d": kw(true, true, "2026-11-10T00:00:00Z") });
    expect(ask("m", "security_scan").verdict).toBe("untested");
  });
  it("a fail counts only at the kind's own rank: a triage fail does not fail chat when the keyword sweep passed", () => {
    put("general-keyword-results.json", { "m::d": kw(true, true, "2026-11-10T00:00:00Z") });
    put("security-triage-results.json", { "m::d::h": score("2026-11-09", false) });
    expect(ask("m", "chat").verdict).toBe("pass");
  });
  const det = (date: string, qualityPass: boolean | undefined, failureReasons: string[] = []): object => ({ date, failureReasons, qualityPass });
  const DETERMINISTIC: ReadonlyArray<[string, string]> = [
    ["code_task", "code-task-results.json"],
    ["check_against_specs", "check-specs-results.json"],
    ["scan_folder", "scan-folder-results.json"],
    ["search_existing_implementations", "search-existing-results.json"],
  ];
  it("each deterministic ledger: qualityPass true is a pass, false is a fail, with the row date", () => {
    for (const [kind, file] of DETERMINISTIC) {
      put(file, { "a::2026-11-01::h": det("2026-11-01", true), "b::2026-11-09::h": det("2026-11-09", false) });
      expect(ask("a", kind)).toEqual({ verdict: "pass", store: "S2", at: "2026-11-01" });
      expect(ask("b", kind)).toEqual({ verdict: "fail", store: "S2", at: "2026-11-09" });
    }
  });
  it("failureReasons is ignored: empty with qualityPass false is a FAIL (the live code-task row), non-empty with qualityPass true is a pass", () => {
    for (const [kind, file] of DETERMINISTIC) {
      put(file, { "a::d::h": det("2026-11-09", false, []), "b::d::h": det("2026-11-09", true, ["case-1: timeout"]) });
      expect(ask("a", kind).verdict).toBe("fail");
      expect(ask("b", kind).verdict).toBe("pass");
    }
  });
  it("a row without a boolean qualityPass (legacy, not backfilled) is untested", () => {
    for (const [kind, file] of DETERMINISTIC) {
      put(file, { "a::d::h": det("2026-11-09", undefined, []) });
      expect(ask("a", kind).verdict).toBe("untested");
    }
  });
  it("the latest deterministic row decides", () => {
    put("code-task-results.json", { "a::2026-11-01::h": det("2026-11-01", true), "a::2026-11-09::h": det("2026-11-09", false) });
    expect(ask("a", "code_task")).toEqual({ verdict: "fail", store: "S2", at: "2026-11-09" });
  });
  it("keyword and triage passes do not cover a rank 2 to 5 kind", () => {
    put("general-keyword-results.json", { "m::d": kw(true, true, "2026-11-10T00:00:00Z") });
    put("security-triage-results.json", { "m::d::h": score("2026-11-09", true) });
    for (const [kind] of DETERMINISTIC) expect(ask("m", kind).verdict).toBe("untested");
  });
  it("a harder deterministic pass covers an easier kind; a harder fail does not fail an easier one", () => {
    put("scan-folder-results.json", { "c::d::h": det("2026-11-08", false) });
    put("code-task-results.json", { "a::d::h": det("2026-11-09", true), "b::d::h": det("2026-11-09", false), "c::d::h": det("2026-11-09", true) });
    expect(ask("a", "scan_folder")).toEqual({ verdict: "pass", store: "S2", at: "2026-11-09" });
    expect(ask("a", "chat").verdict).toBe("pass");
    expect(ask("b", "scan_folder").verdict).toBe("untested");
    expect(ask("c", "scan_folder").verdict).toBe("pass"); // own fail, but a harder pass covers it
  });
});

describe("S3 text tools", () => {
  const row = (date: string, qualityPass: boolean | undefined): object => ({ date, qualityPass });
  it("the latest row under the current hash decides, by the stored qualityPass", () => {
    put("text-tools-results.json", { "summarize::m::2026-11-01::ht-summarize": row("2026-11-01", true), "summarize::m::2026-11-09::ht-summarize": row("2026-11-09", false), "topics::m::2026-11-09::ht-topics": row("2026-11-09", true) });
    expect(ask("m", "summarize")).toEqual({ verdict: "fail", store: "S3", at: "2026-11-09" });
    expect(ask("m", "topics").verdict).toBe("pass");
  });
  it("a stale hash, an unknown current hash or a row without qualityPass is untested", () => {
    put("text-tools-results.json", { "summarize::m::2026-11-09::old": row("2026-11-09", true), "describe::m::2026-11-09::ht-describe": row("2026-11-09", undefined), "topics::m::2026-11-09::ht-topics": row("2026-11-09", true) });
    expect(ask("m", "summarize").verdict).toBe("untested");
    expect(ask("m", "describe").verdict).toBe("untested");
    expect(ask("m", "topics", { ...HASHES, textTool: () => undefined }).verdict).toBe("untested");
  });
});

describe("S4 scout accuracy", () => {
  it("pass and fail come from the latest conclusive row under the current hash", () => {
    put("scout-accuracy-results.json", { "a::2026-11-10::hs": score("2026-11-10", true), "b::2026-11-09::hs": score("2026-11-09", false) });
    expect(ask("a", "mass_scout")).toEqual({ verdict: "pass", store: "S4", at: "2026-11-10" });
    expect(ask("b", "mass_scout_chain")).toEqual({ verdict: "fail", store: "S4", at: "2026-11-09" });
  });
  it("a stale hash, an inconclusive row or a row older than 30 days is untested", () => {
    put("scout-accuracy-results.json", { "a::2026-11-10::old": score("2026-11-10", true), "b::2026-11-10::hs": score("2026-11-10", true, true), "c::2026-10-01::hs": score("2026-10-01", true) });
    for (const m of ["a", "b", "c"]) expect(ask(m, "mass_scout").verdict).toBe("untested");
  });
});

describe("S5 free fitness", () => {
  it("a ':free' id is judged by the hq-scan ledger under the current hash", () => {
    put("hq-scan-quality-results.json", { "x/y:free::2026-11-10::hh": score("2026-11-10", true), "z/w:free::2026-11-10::old": score("2026-11-10", true) });
    expect(ask("x/y:free", "high_quality_scan")).toEqual({ verdict: "pass", store: "S5", at: "2026-11-10" });
    expect(ask("z/w:free", "high_quality_scan").verdict).toBe("untested");
  });
  it("a paid id stays untested even with a row (spec Q12 is open)", () => {
    put("hq-scan-quality-results.json", { "paid/model::2026-11-10::hh": score("2026-11-10", true) });
    expect(ask("paid/model", "high_quality_scan").verdict).toBe("untested");
  });
});

describe("S6 local calibration", () => {
  const save = (rec: CalibrationRecord): void => writeRecord(dir, rec);
  it("ok with fill_tokens above 0 for the task kind is a pass; 0 is a fail", () => {
    save(record("loc", "llama", { fact: 5000, aggregate: 0, bug: 5000 }));
    expect(ask("loc", "chat")).toEqual({ verdict: "pass", store: "S6", at: "2026-11-14T10:00:00.000Z" });
    expect(ask("loc", "summarize").verdict).toBe("fail");
  });
  it("a failed record is a fail; a record under the other engine is found too", () => {
    save(record("bad", "locals", null));
    save(record("loc2", "locals", { fact: 1, aggregate: 1, bug: 1 }));
    expect(ask("bad", "chat")).toEqual({ verdict: "fail", store: "S6", at: "2026-11-14T10:00:00.000Z" });
    expect(ask("loc2", "chat").verdict).toBe("pass");
  });
  it("a kind with no task kind (mass_scout) is untested for a local model", () => {
    save(record("loc", "llama", { fact: 1, aggregate: 1, bug: 1 }));
    expect(ask("loc", "mass_scout")).toEqual({ verdict: "untested", store: "S6", at: "2026-11-14T10:00:00.000Z" });
  });
  it("the record beats a remote ledger row for the same id", () => {
    save(record("loc", "llama", { fact: 0, aggregate: 1, bug: 1 }));
    put("general-keyword-results.json", { "loc::d": kw(true, true, "2026-11-10T00:00:00Z") });
    expect(ask("loc", "chat").verdict).toBe("fail");
  });
});

describe("no row, bad files, unknown kinds", () => {
  it("an empty dir, a corrupt ledger and a ledger that is not an object read as untested", () => {
    expect(ask("m", "chat")).toEqual({ verdict: "untested", store: null, at: null });
    writeFileSync(join(dir, "general-keyword-results.json"), "{not json");
    put("security-triage-results.json", [1, 2]);
    expect(ask("m", "chat").verdict).toBe("untested");
    expect(ask("m", "security_scan").verdict).toBe("untested");
  });
  it("every command kind is routed (none throws) and an unknown kind throws", () => {
    for (const kind of COMMAND_KINDS) expect(ask("m", kind).verdict).toBe("untested");
    expect(isCommandKind("classify_verify")).toBe(false);
    expect(() => ask("m", "classify_verify")).toThrow("unknown command kind");
  });
});
