// P6 step 2 (TRDD-1OOAH3LD, TRDD-ZGSGGHQG; design/specs/local-calibration-design.md sections 3 and 7):
// the calibration record (schema, atomic 0600 write, readers), the fingerprint, the per-model lock,
// the shared state files and trigger 2. Real files in a throwaway dir, real child processes; no mocks.
// The runner, trigger 1 and the CLI commands run against a real llama-server in broker/broker.test.ts.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tmpdir } from "../test-tmp-root.js";
import type { Profile } from "../config.js";
import { CALIBRATE_ARGV, calibratorStatePath } from "../broker/protocol.js";
import { recordFixture } from "./record-fixture.js";
import { FIXTURE_VERSION, HARNESS_VERSION, readRecord, readRecordStatus, recordPath, recordSchemaErrors, writeRecord, type GridEntry, type GridSkip } from "./record.js";
import { blobSha256, fingerprintOf, ggufShards, snapshotWeightFiles, staleness } from "./fingerprint.js";
import { acquireModelLock, dequeueUnlocked, enqueueUnlocked, loadProgress, modelLockPath, readQueue, readSeenModels, releaseModelLock, saveProgress, withStateLock } from "./state.js";
import { checkModelChanges, managedProfileModels, markProfileUsed } from "./triggers.js";
import { engineOf, profileUnfitLines, queueManual, unfitExplanations } from "./commands.js";
import { harnessFromEnv, PRODUCTION_HARNESS } from "./runner.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "llm-ext-cal-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const managed = (model: string, extra: Record<string, unknown> = {}): Profile =>
  ({ "profile-type": "local", mode: "local", api: "llamacpp-local", url: "http://127.0.0.1:8181", server: "managed", model, ...extra }) as unknown as Profile;

describe("calibration record (spec section 7)", () => {
  it("a complete ok record and a calibration-failed record pass the schema; each broken field is named", () => {
    expect(recordSchemaErrors(recordFixture("llama", "a/b:Q4"))).toEqual([]);
    expect(recordSchemaErrors(recordFixture("locals", "a/b", { step: "A/load", message: "x" }))).toEqual([]);
    const broken = { ...recordFixture("llama", "a/b:Q4"), fill_tokens: { fact: 1 }, fingerprint: { blobs: ["not-a-hash"], ram_bytes: 1 } };
    expect(recordSchemaErrors(broken)).toEqual(expect.arrayContaining(["fill_tokens", "fingerprint {blobs: sha256[], ram_bytes}"]));
    expect(recordSchemaErrors({ status: "ok" })).not.toEqual([]);
  });

  it("writeRecord is atomic and 0600, and refuses an invalid record without writing", () => {
    writeRecord(dir, recordFixture("llama", "a/b:Q4"));
    const p = recordPath(dir, "llama", "a/b:Q4");
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(readRecord(dir, "llama", "a/b:Q4")?.status).toBe("ok");
    expect(() => writeRecord(dir, { ...recordFixture("llama", "x/y:Q4"), main: { slots: 0, slot_ctx: 0 } })).toThrow(/invalid calibration record.*main/);
    expect(existsSync(recordPath(dir, "llama", "x/y:Q4"))).toBe(false);
  });

  it("a corrupt, invalid or foreign record counts as missing, and is logged once", () => {
    const p = recordPath(dir, "llama", "a/b:Q4");
    mkdirSync(join(p, ".."), { recursive: true });
    const log: string[] = [];
    writeFileSync(p, "{not json");
    expect(readRecordStatus(dir, "llama", "a/b:Q4", (m) => log.push(m))).toEqual({ state: "missing" });
    expect(readRecordStatus(dir, "llama", "a/b:Q4", (m) => log.push(m))).toEqual({ state: "missing" });
    expect(log).toHaveLength(1);
    writeFileSync(p, JSON.stringify(recordFixture("llama", "other/model:Q4")));
    expect(readRecord(dir, "llama", "a/b:Q4")).toBeNull();
    writeFileSync(p, JSON.stringify({ status: "ok" }));
    expect(readRecordStatus(dir, "llama", "a/b:Q4")).toEqual({ state: "missing" });
  });

  it("a failed record gives the broker a message naming the step, the reason and the fix", () => {
    writeRecord(dir, recordFixture("llama", "a/b:Q4", { step: "A/thinking-off", message: "thinking cannot be turned off" }));
    const s = readRecordStatus(dir, "llama", "a/b:Q4");
    expect(s.state).toBe("failed");
    expect((s as { message: string }).message).toMatch(/calibration-failed at A\/thinking-off: thinking cannot be turned off.*models calibrate --model a\/b:Q4 --force/);
  });
});

describe("fingerprint: blob sha256 of the weights (spec section 3, review N7)", () => {
  it("a Hugging Face snapshot symlink gives its blob name; a plain file is hashed; a README-only revision change keeps it", async () => {
    const content = Buffer.from("weights v1");
    const sha = createHash("sha256").update(content).digest("hex");
    const repo = join(dir, "hub", "models--org--m");
    mkdirSync(join(repo, "blobs"), { recursive: true });
    // A blob whose NAME differs from its content's hash proves the name is used, not the content.
    const named = "a".repeat(64);
    writeFileSync(join(repo, "blobs", named), content);
    for (const rev of ["rev1", "rev2"]) {
      mkdirSync(join(repo, "snapshots", rev), { recursive: true });
      symlinkSync(join("..", "..", "blobs", named), join(repo, "snapshots", rev, "model.safetensors"));
      writeFileSync(join(repo, "snapshots", rev, "README.md"), rev);
    }
    mkdirSync(join(repo, "refs"));
    writeFileSync(join(repo, "refs", "main"), "rev1");
    const env = { HF_HUB_CACHE: join(dir, "hub") };
    const f1 = await fingerprintOf(snapshotWeightFiles("org/m", env));
    writeFileSync(join(repo, "refs", "main"), "rev2");
    const f2 = await fingerprintOf(snapshotWeightFiles("org/m", env));
    expect(f1.blobs).toEqual([named]);
    expect(f2).toEqual(f1);
    const plain = join(dir, "plain.gguf");
    writeFileSync(plain, content);
    expect(await blobSha256(plain)).toBe(sha);
    expect(() => snapshotWeightFiles("org/missing", env)).toThrow(/no cached snapshot/);
  });
});

describe("review fixes of ea8e3869: fingerprint, versions, queue pruning", () => {
  it("M4: the snapshot lookup uses the Locals resolver, so XDG_CACHE_HOME is honoured", () => {
    const repo = join(dir, "xdg", "huggingface", "hub", "models--org--m");
    mkdirSync(join(repo, "snapshots", "r1"), { recursive: true });
    mkdirSync(join(repo, "refs"));
    writeFileSync(join(repo, "refs", "main"), "r1");
    writeFileSync(join(repo, "snapshots", "r1", "w.safetensors"), "x");
    expect(snapshotWeightFiles("org/m", { XDG_CACHE_HOME: join(dir, "xdg") })).toEqual([join(repo, "snapshots", "r1", "w.safetensors")]);
  });

  it("M7: a plain GGUF is hashed once and its digest reused until the file changes; every shard of a split GGUF counts", async () => {
    const f = join(dir, "m.gguf");
    writeFileSync(f, "v1");
    const sha1 = await blobSha256(f, dir);
    const cache = JSON.parse(readFileSync(join(dir, "calibration", "digests.json"), "utf8")) as Record<string, { sha256: string }>;
    expect(Object.values(cache).map((c) => c.sha256)).toEqual([sha1]);
    // A cached digest is what is returned: planting a fake one proves the file was not read again.
    const real = Object.keys(cache)[0];
    writeFileSync(join(dir, "calibration", "digests.json"), JSON.stringify({ [real]: { ...cache[real], sha256: "f".repeat(64) } }));
    expect(await blobSha256(f, dir)).toBe("f".repeat(64));
    // A changed file (size and mtime) is hashed again.
    writeFileSync(f, "version 2");
    expect(await blobSha256(f, dir)).toBe(createHash("sha256").update("version 2").digest("hex"));
    expect(ggufShards("/m/x-00001-of-00003.gguf")).toEqual(["/m/x-00001-of-00003.gguf", "/m/x-00002-of-00003.gguf", "/m/x-00003-of-00003.gguf"]);
    expect(ggufShards("/m/x.gguf")).toEqual(["/m/x.gguf"]);
  });

  it("M5: a record of another harness or fixture version is missing for the broker and stale for the runner", () => {
    const old = { ...recordFixture("llama", "a/b:Q4"), harness_version: HARNESS_VERSION + 1 };
    writeRecord(dir, old);
    expect(readRecordStatus(dir, "llama", "a/b:Q4")).toEqual({ state: "missing" });
    const id = { fingerprint: old.fingerprint, engineVersion: old.engine_version_checked };
    expect(staleness(old, id)).toBe("weights");
    expect(staleness({ ...old, harness_version: HARNESS_VERSION, fixture_version: FIXTURE_VERSION + 1 }, id)).toBe("weights");
    expect(staleness({ ...old, harness_version: HARNESS_VERSION }, id)).toBeNull();
  });

  it("M6: the boot check drops a queued model no managed profile names any more, but keeps a manual item", () => {
    const profiles: Record<string, Profile> = { p: managed("org/a:Q4", { second_model: "org/b:Q4" }) };
    checkModelChanges(dir, profiles);
    withStateLock(dir, 1000, () => {
      enqueueUnlocked(dir, { engine: "llama", model: "org/b:Q4", reason: "model-change" });
      enqueueUnlocked(dir, { engine: "llama", model: "org/gone:Q4", reason: "first-use" });
      enqueueUnlocked(dir, { engine: "llama", model: "org/manual:Q4", reason: "manual" });
      return true;
    });
    delete profiles.p.second_model;
    checkModelChanges(dir, profiles);
    expect(readQueue(dir).map((q) => q.model)).toEqual(["org/manual:Q4"]);
  });
});
describe("main-agent decisions of 2026-10-29: harness id (D4), schema 2 (D6), leaky thinking off (D5), unfit profiles (D1)", () => {
  const custom = `custom:${"a".repeat(64)}`;
  it("D4: a record of a custom harness is valid but counts as missing for the broker; the production one is usable", () => {
    writeRecord(dir, { ...recordFixture("llama", "c/d:Q4"), harness: custom });
    expect(readRecord(dir, "llama", "c/d:Q4")?.harness).toBe(custom);
    expect(readRecordStatus(dir, "llama", "c/d:Q4").state).toBe("missing");
    writeRecord(dir, recordFixture("llama", "c/d:Q4"));
    expect(readRecordStatus(dir, "llama", "c/d:Q4").state).toBe("ok");
  });
  it("D4: the runner sees a record of another harness as stale (by id, never by the harness contents)", () => {
    const rec = recordFixture("llama", "c/d:Q4");
    const id = { fingerprint: rec.fingerprint, engineVersion: rec.engine_version_checked };
    expect(staleness(rec, id)).toBeNull();
    expect(staleness(rec, id, custom)).toBe("weights");
    expect(staleness({ ...rec, harness: custom }, id, custom)).toBeNull();
    expect(staleness({ ...rec, harness: custom }, id)).toBe("weights");
  });
  it("D4: LLM_EXT_CALIBRATION_HARNESS gives custom:<sha256 of its JSON>; unset is production; malformed is an error", () => {
    const raw = "{\"windowCap\":8192}";
    expect(harnessFromEnv({}).id).toBe("production");
    const h = harnessFromEnv({ LLM_EXT_CALIBRATION_HARNESS: raw });
    expect(h.id).toBe(`custom:${createHash("sha256").update(raw).digest("hex")}`);
    expect(h.windowCap).toBe(8192);
    expect(harnessFromEnv({ LLM_EXT_CALIBRATION_HARNESS: "{\"id\":\"production\"}" }).id).toMatch(/^custom:/);
    expect(() => harnessFromEnv({ LLM_EXT_CALIBRATION_HARNESS: "{" })).toThrow(/not JSON/);
    expect(() => harnessFromEnv({ LLM_EXT_CALIBRATION_HARNESS: "{\"trials\":0}" })).toThrow(/invalid/);
  });
  it("D6: schema 2 is required (a schema-1 record counts as missing); D5: thinking_works.off may be \"leaky\", nothing else", () => {
    expect(recordSchemaErrors({ ...recordFixture("llama", "a/b"), schema: 1 })).toContain("schema must be 2");
    expect(recordSchemaErrors({ ...recordFixture("llama", "a/b"), harness: "custom:xyz" })).toContain("harness (production or custom:<sha256>)");
    expect(recordSchemaErrors({ ...recordFixture("llama", "a/b"), thinking_works: { off: "leaky", on: true } })).toEqual([]);
    expect(recordSchemaErrors({ ...recordFixture("llama", "a/b"), thinking_works: { off: "maybe", on: true } })).toContain("thinking_works");
    mkdirSync(join(dir, "calibration", "llama"), { recursive: true });
    writeFileSync(recordPath(dir, "llama", "old/m"), JSON.stringify({ ...recordFixture("llama", "old/m"), schema: 1 }));
    expect(readRecordStatus(dir, "llama", "old/m").state).toBe("missing");
  });
  it("D1: a profile is unfit for a kind when no model with a verdict is fit for it; provisional while models still calibrate", () => {
    const fill = (fact: number, aggregate: number, bug: number) => ({ fact, aggregate, bug });
    expect(profileUnfitLines("p", [{ status: "ok", fill: fill(2048, 0, 0) }, { status: "failed" }])).toEqual(["no model of profile p is fit for aggregate", "no model of profile p is fit for bug"]);
    expect(profileUnfitLines("p", [{ status: "ok", fill: fill(2048, 0, 0) }, { status: "ok", fill: fill(0, 0, 4096) }])).toEqual(["no model of profile p is fit for aggregate"]);
    expect(profileUnfitLines("p", [{ status: "ok", fill: fill(0, 0, 4096) }, { status: "missing" }, { status: "missing" }])).toEqual([
      "no model of profile p is fit for fact so far; 2 still calibrating",
      "no model of profile p is fit for aggregate so far; 2 still calibrating",
    ]);
    expect(profileUnfitLines("p", [{ status: "missing" }])).toEqual([]);
    expect(profileUnfitLines("p", [{ status: "failed" }])).toEqual(["fact", "aggregate", "bug"].map((k) => `no model of profile p is fit for ${k}`));
  });
  it("an unfit kind is window-limited (no step fit the hard W) or quality-limited; \"cut at N tokens\" only when every fail was a cut", () => {
    const g = (kind: "fact" | "aggregate" | "bug", trials: number, passed: number, cutFails: number, cutCap: number | null): GridEntry => ({ kind, counter: kind === "bug" ? "bug" : "main", tokens: 2048, trials, passed, inconclusive: cutFails, cuts: 2 * cutFails, cut_fails: cutFails, cut_cap: cutCap });
    const skip = (kind: "fact" | "aggregate" | "bug", tokens: number): GridSkip => ({ kind, tokens, skipped: "window", W: 10303 });
    expect(unfitExplanations({ fact: 2048, aggregate: 0, bug: 0 }, [g("aggregate", 3, 0, 3, 2048), g("bug", 3, 0, 1, 8192)])).toEqual([
      "unfit for aggregate: quality-limited (cut at 2048 tokens)",
      "unfit for bug: quality-limited",
    ]);
    expect(unfitExplanations({ fact: 4096, aggregate: 4096, bug: 4096 }, [g("aggregate", 3, 0, 3, 2048)])).toEqual([]);
    expect(unfitExplanations({ fact: 4096, aggregate: 4096, bug: 0 }, [skip("bug", 4096), skip("bug", 2048)], { bug: "window 10303 too small for thinking on output" })).toEqual([
      "unfit for bug: window-limited (window 10303 too small for thinking on output)",
    ]);
    // A skipped top step and a failed lower step: the steps that ran decide, so it is quality-limited.
    expect(unfitExplanations({ fact: 4096, aggregate: 4096, bug: 0 }, [skip("bug", 4096), g("bug", 3, 0, 0, null)])).toEqual(["unfit for bug: quality-limited"]);
    expect(recordSchemaErrors({ ...recordFixture("llama", "a/b"), grid: [skip("bug", 4096), g("fact", 5, 5, 0, null)] })).toEqual([]);
    expect(recordSchemaErrors({ ...recordFixture("llama", "a/b"), grid: [{ kind: "bug", tokens: 4096, skipped: "window" }] })).toContain("grid");
  });
  it("PRODUCTION_HARNESS is pinned to HARNESS_VERSION: an edit to the harness without a version bump fails here (D4)", () => {
    // A new harness needs HARNESS_VERSION + 1 and a new entry here: records are compared by id and version only.
    // 2: Phase C candidates (mainSlots, scoutShares, scoutSlots) joined the harness.
    const PINNED: Record<number, string> = {
      1: "f8d99b34b756039733fe9622a06c551b13481270d0807c74c45902d44869e2d0",
      2: "7b381abe948cae14e6dd12998f4161909536ee4d4254db249bd936b6affcb257",
      // 3: the Phase C method and the Phase B resume rule changed with the same harness JSON (the hash repeats on purpose).
      3: "7b381abe948cae14e6dd12998f4161909536ee4d4254db249bd936b6affcb257",
    };
    expect(createHash("sha256").update(JSON.stringify(PRODUCTION_HARNESS)).digest("hex")).toBe(PINNED[HARNESS_VERSION]);
  });
});

describe("per-model lock (spec section 3)", () => {
  it("is taken over from a dead or non-runner holder, refused while a live __calibrate holds it, and released only by its owner", async () => {
    const lock = modelLockPath(dir, "llama", "a/b:Q4");
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "pid"), "999999");
    expect(await acquireModelLock(dir, "llama", "a/b:Q4")).toBe(true);
    expect(readFileSync(join(lock, "pid"), "utf8")).toBe(String(process.pid));
    releaseModelLock(dir, "llama", "a/b:Q4");
    expect(existsSync(lock)).toBe(false);
    const runner = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", "--", CALIBRATE_ARGV], { stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 300));
      mkdirSync(lock, { recursive: true });
      writeFileSync(join(lock, "pid"), String(runner.pid));
      // Review m1: a live __calibrate that is not THIS dir's runner (another config dir's) is no holder.
      expect(await acquireModelLock(dir, "llama", "a/b:Q4")).toBe(true);
      releaseModelLock(dir, "llama", "a/b:Q4");
      mkdirSync(lock, { recursive: true });
      writeFileSync(join(lock, "pid"), String(runner.pid));
      writeFileSync(calibratorStatePath(dir), JSON.stringify({ pid: runner.pid, version: "t", startedAt: new Date().toISOString() }));
      expect(await acquireModelLock(dir, "llama", "a/b:Q4")).toBe(false);
      releaseModelLock(dir, "llama", "a/b:Q4"); // not ours: left alone
      expect(readFileSync(join(lock, "pid"), "utf8")).toBe(String(runner.pid));
      // A lock being created (no pid file yet, fresh) is left alone.
      rmSync(join(lock, "pid"));
      expect(await acquireModelLock(dir, "llama", "a/b:Q4")).toBe(false);
    } finally {
      runner.kill("SIGKILL");
    }
  });
});

describe("shared state: queue, state lock, progress", () => {
  it("the queue keeps order, never duplicates, upgrades to --force, and dequeues", () => {
    withStateLock(dir, 1000, () => {
      enqueueUnlocked(dir, { engine: "llama", model: "a", reason: "first-use" });
      enqueueUnlocked(dir, { engine: "locals", model: "b", reason: "manual" });
      enqueueUnlocked(dir, { engine: "llama", model: "a", reason: "manual", force: true });
    });
    expect(readQueue(dir).map((i) => [i.engine, i.model, i.force ?? false])).toEqual([["llama", "a", true], ["locals", "b", false]]);
    withStateLock(dir, 1000, () => dequeueUnlocked(dir, "llama", "a"));
    expect(readQueue(dir).map((i) => i.model)).toEqual(["b"]);
  });

  it("a busy state lock makes a short waiter give up (undefined), never block", () => {
    const inner = withStateLock(dir, 1000, () => withStateLock(dir, 100, () => "ran"));
    expect(inner).toBeUndefined();
    expect(withStateLock(dir, 100, () => "ran")).toBe("ran");
  });

  it("D4: a run of another harness id never resumes progress; a reader (harness null) keeps the stored id", () => {
    const fp = { blobs: ["b".repeat(64)], ram_bytes: 64 };
    const custom = `custom:${"a".repeat(64)}`;
    const p = loadProgress(dir, "llama", "h/m:Q4", fp, custom);
    expect(p.harness).toBe(custom);
    p.trials.push({ step: "B/window", seed: 0, outcome: "pass", at: "t", data: { window: 8192 } });
    saveProgress(dir, "llama", "h/m:Q4", p);
    expect(loadProgress(dir, "llama", "h/m:Q4", fp, custom).trials).toHaveLength(1);
    // A reader neither resets nor forgets the id, so a crash count it saves keeps the progress tied to its harness.
    const read = loadProgress(dir, "llama", "h/m:Q4", null);
    expect(read.trials).toHaveLength(1);
    expect(read.harness).toBe(custom);
    saveProgress(dir, "llama", "h/m:Q4", { ...read, crashes: 1 });
    expect(loadProgress(dir, "llama", "h/m:Q4", fp, custom).trials).toHaveLength(1);
    // The production run starts fresh and claims the file with its own id.
    const prod = loadProgress(dir, "llama", "h/m:Q4", fp, "production");
    expect(prod.trials).toEqual([]);
    expect(prod.harness).toBe("production");
    // A file written before the field existed cannot prove its harness: the runner starts fresh.
    const legacy = { ...p };
    delete (legacy as { harness?: string | null }).harness;
    saveProgress(dir, "llama", "old/m:Q4", legacy);
    expect(loadProgress(dir, "llama", "old/m:Q4", fp, "production").trials).toEqual([]);
    expect(loadProgress(dir, "llama", "old/m:Q4", null).trials).toHaveLength(1);
  });

  it("progress is kept while versions and fingerprint match, and dropped when the weights change", () => {
    const fp = { blobs: ["b".repeat(64)], ram_bytes: 64 };
    const p = loadProgress(dir, "llama", "a/b:Q4", fp);
    p.trials.push({ step: "A/known-answer", seed: 1, outcome: "pass", at: "t" });
    saveProgress(dir, "llama", "a/b:Q4", p);
    expect(loadProgress(dir, "llama", "a/b:Q4", fp).trials).toHaveLength(1);
    expect(loadProgress(dir, "llama", "a/b:Q4", null).trials).toHaveLength(1);
    expect(loadProgress(dir, "llama", "a/b:Q4", { ...fp, blobs: ["c".repeat(64)] }).trials).toHaveLength(0);
    expect(loadProgress(dir, "llama", "a/b:Q4", { ...fp, ram_bytes: 32 }).trials).toHaveLength(0);
  });
});

describe("trigger 2: a model added or changed in a USED managed profile (spec section 3)", () => {
  it("the first boot only records; an unused profile never queues; a used profile queues each new id once", () => {
    const profiles: Record<string, Profile> = { p: managed("org/a:Q4"), mlx: managed("org/m", { api: "locals-local" }), remote: { mode: "remote", api: "openrouter-remote", model: "x/y" } as unknown as Profile };
    expect(managedProfileModels(profiles)).toEqual({ p: { engine: "llama", models: ["org/a:Q4"] }, mlx: { engine: "locals", models: ["org/m"] } });
    expect(checkModelChanges(dir, profiles)).toEqual([]);
    expect(readSeenModels(dir)).toEqual({ profiles: { p: ["org/a:Q4"], mlx: ["org/m"] }, used_profiles: [] });
    // A change in a profile nobody used: recorded, nothing queued (the add-once built-ins cost nothing until used).
    profiles.p = managed("org/a:Q4", { second_model: "org/b:Q4" });
    expect(checkModelChanges(dir, profiles)).toEqual([]);
    expect(readQueue(dir)).toEqual([]);
    markProfileUsed(dir, "p", profiles);
    profiles.p = managed("org/a:Q4", { second_model: "org/b:Q4", third_model: "org/c:Q8_0" });
    expect(checkModelChanges(dir, profiles)).toEqual([{ engine: "llama", model: "org/c:Q8_0" }]);
    expect(checkModelChanges(dir, profiles)).toEqual([]);
    expect(readQueue(dir).map((i) => [i.model, i.reason])).toEqual([["org/c:Q8_0", "model-change"]]);
  });

  it("models calibrate resolves the engine from the profiles, refuses an unknown model, and refuses a calibrated one without --force", () => {
    const profiles: Record<string, Profile> = { p: managed("org/a:Q4") };
    expect(engineOf(profiles, "org/zz:Q4")).toEqual({ error: expect.stringMatching(/no managed local profile .* names the model 'org\/zz:Q4'/) });
    expect(queueManual(dir, profiles, "org/a:Q4", false)).toEqual({ engine: "llama", text: expect.stringMatching(/queued 'org\/a:Q4' \(llama, profiles p\)/) });
    writeRecord(dir, recordFixture("llama", "org/a:Q4"));
    expect(queueManual(dir, profiles, "org/a:Q4", false)).toEqual({ error: expect.stringMatching(/already has a calibration record .*--force/) });
    expect("engine" in queueManual(dir, profiles, "org/a:Q4", true)).toBe(true);
    expect(readQueue(dir).find((i) => i.model === "org/a:Q4")?.force).toBe(true);
  });
});
