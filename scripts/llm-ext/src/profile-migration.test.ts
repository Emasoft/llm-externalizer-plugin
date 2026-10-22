/**
 * P6c-a item 3 (addendum K) — the ONE-TIME pre-14.0.0 settings.yaml migration.
 *
 * What is actually at stake here: the migration DELETES and OVERWRITES sections
 * of the user's own configuration file. Every test below is about proving it
 * touches a section only when that section is provably one llm-ext wrote, and
 * that it cannot run twice.
 *
 * Real files, real YAML, real config dir (a fresh mkdtemp per test). Nothing is
 * stubbed: the migration's only IO is the settings file and the state sidecar,
 * and stubbing either would test the stub.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "./test-tmp-root.js";
import { parse as parseYaml } from "yaml";

import {
  migrateProfileSections,
  migrateSettingsTo141,
  SHIPPED_PLACEHOLDER_SHAPES,
  RETIRED_PROFILE_NAMES,
  GENERATED_MARKER,
} from "./benchmark/pick.js";
import {
  getProfileMigrationStamp,
  stampProfileMigrationDone,
  dynamicProfilesStatePath,
  isMigrationStepApplied,
  markMigrationStepApplied,
} from "./default-profiles-state.js";
import {
  loadSettings,
  validateSettings,
  getSettingsPath,
  reservedDynamicProfileNameError,
  PLACEHOLDER_MODEL_ID,
  ensureSettingsExist,
} from "./config.js";

import { afterEach, beforeEach, describe, it, expect } from "vitest";

let cfgDir: string;
let prevCfgDir: string | undefined;
let prevBaiKey: string | undefined;
let notices: string[];

beforeEach(() => {
  prevCfgDir = process.env.LLM_EXT_CONFIG_DIR;
  // D5: the bai-reserved-seed step seeds the free section whenever
  // BAI_API_KEY resolves; an ambient key (this project's login shells export
  // one) would flip these fixtures' assertions by env leg. Each seed test
  // that needs the key sets it explicitly.
  prevBaiKey = process.env.BAI_API_KEY;
  delete process.env.BAI_API_KEY;
  cfgDir = mkdtempSync(join(tmpdir(), "lx-migr-"));
  process.env.LLM_EXT_CONFIG_DIR = cfgDir;
  notices = [];
});

afterEach(() => {
  if (prevCfgDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
  else process.env.LLM_EXT_CONFIG_DIR = prevCfgDir;
  if (prevBaiKey === undefined) delete process.env.BAI_API_KEY;
  else process.env.BAI_API_KEY = prevBaiKey;
  rmSync(cfgDir, { recursive: true, force: true });
});

function write(yaml: string): void {
  writeFileSync(getSettingsPath(), yaml, "utf-8");
}

function run(): ReturnType<typeof migrateProfileSections> {
  return migrateProfileSections(getSettingsPath(), {
    notify: (m) => notices.push(m),
    readStamp: getProfileMigrationStamp,
    writeStamp: stampProfileMigrationDone,
  });
}

function profiles(): Record<string, Record<string, unknown>> {
  const doc = parseYaml(readFileSync(getSettingsPath(), "utf-8")) as {
    profiles: Record<string, Record<string, unknown>>;
  };
  return doc.profiles;
}

/** The marker is a KEY comment, which `parse` throws away — read the raw text. */
function markerOn(name: string): boolean {
  const raw = readFileSync(getSettingsPath(), "utf-8");
  const lines = raw.split("\n");
  const keyAt = lines.findIndex((l) => l.trimEnd() === `  ${name}:`);
  if (keyAt <= 0) return false;
  return lines[keyAt - 1].includes(GENERATED_MARKER);
}

const P = PLACEHOLDER_MODEL_ID;

/** The 2026-08-13-onward shipped `free` placeholder, as YAML. */
const SHIPPED_FREE = [
  "  free:",
  "    mode: remote",
  "    api: openrouter-remote",
  "    free_only: true",
  "    free_models: []",
  `    model: ${P}`,
  "    api_key: $OPENROUTER_API_KEY",
].join("\n");

const SHIPPED_PAID = [
  "  paid:",
  "    mode: remote",
  "    api: openrouter-remote",
  `    model: ${P}`,
  "    api_key: $OPENROUTER_API_KEY",
].join("\n");

const SHIPPED_PAID_ENSEMBLE = [
  "  paid-ensemble:",
  "    mode: remote-ensemble",
  "    api: openrouter-remote",
  `    model: ${P}`,
  `    second_model: ${P}`,
  `    third_model: ${P}`,
  "    api_key: $OPENROUTER_API_KEY",
].join("\n");

const MY_OWN = [
  "  my-own:",
  "    mode: local",
  "    api: generic-local",
  "    model: model-a",
  "    url: http://127.0.0.1:1",
].join("\n");

// ── The shipped-shape table ────────────────────────────────────────────────

describe("SHIPPED_PLACEHOLDER_SHAPES — pinned from git history of config.ts", () => {
  // These six entries are what authorizes a DELETE or an OVERWRITE of a user's
  // section. If the generator ever ships a seventh shape and this table is not
  // extended, that shape stops being recognised as ours — the safe direction
  // (it is kept, not destroyed) — but the user is left with a stub nothing
  // fills. Pinning the exact objects makes a generator change red here.
  // `local` (TRDD-C9SXX7HO, 14.1.0) is the one entry NOT from a pre-14.0.0
  // settings.yaml — it is the third dynamic profile's own shipped shape.
  it("holds exactly the names a pre-14.0.0 settings.yaml could carry, plus 14.1.0's `local`", () => {
    expect(Object.keys(SHIPPED_PLACEHOLDER_SHAPES).sort()).toEqual(
      ["free", "free-ensemble", "local", "paid", "paid-ensemble", "paid-mass-scout"].sort(),
    );
  });

  it("carries BOTH shipped `free` shapes — the mode changed between the 3-name and 5-name eras", () => {
    // e916f2a/4d4c24b/effdad0 shipped `free` as remote-ensemble; ec34030
    // onward as remote. A table with only the newer one would back up and
    // regenerate an older machine's own untouched placeholder, with a scary
    // notice, for no reason.
    expect(SHIPPED_PLACEHOLDER_SHAPES.free).toEqual([
      {
        mode: "remote",
        api: "openrouter-remote",
        free_only: true,
        free_models: [],
        model: P,
        api_key: "$OPENROUTER_API_KEY",
      },
      {
        mode: "remote-ensemble",
        api: "openrouter-remote",
        free_only: true,
        free_models: [],
        model: P,
        api_key: "$OPENROUTER_API_KEY",
      },
    ]);
  });

  it("pins the three retired names' shapes", () => {
    expect(RETIRED_PROFILE_NAMES.slice().sort()).toEqual(
      ["free-ensemble", "paid-ensemble", "paid-mass-scout"].sort(),
    );
    expect(SHIPPED_PLACEHOLDER_SHAPES["paid-ensemble"]).toEqual([
      {
        mode: "remote-ensemble",
        api: "openrouter-remote",
        model: P,
        second_model: P,
        third_model: P,
        api_key: "$OPENROUTER_API_KEY",
      },
    ]);
    expect(SHIPPED_PLACEHOLDER_SHAPES["paid-mass-scout"]).toEqual([
      { mode: "remote", api: "openrouter-remote", model: P, api_key: "$OPENROUTER_API_KEY" },
    ]);
  });
});

// ── Retired names ──────────────────────────────────────────────────────────

describe("migrateProfileSections — retired names", () => {
  it("DELETES a retired section whose parsed data is exactly a shipped placeholder", () => {
    write(["profiles:", SHIPPED_FREE, SHIPPED_PAID_ENSEMBLE, MY_OWN, ""].join("\n"));
    const r = run();
    expect(r.removed).toEqual(["paid-ensemble"]);
    expect(profiles()).not.toHaveProperty("paid-ensemble");
    // Untouched neighbours, by name.
    expect(profiles()).toHaveProperty("free");
    expect(profiles()["my-own"]).toEqual({
      mode: "local",
      api: "generic-local",
      model: "model-a",
      url: "http://127.0.0.1:1",
    });
  });

  it("KEEPS a retired section the user edited, as an ordinary static profile, with ONE notice", () => {
    const edited = SHIPPED_PAID_ENSEMBLE.replace(`    model: ${P}`, "    model: vendor/real-model");
    write(["profiles:", SHIPPED_FREE, edited, ""].join("\n"));
    const r = run();
    expect(r.removed).toEqual([]);
    expect(r.kept).toEqual(["paid-ensemble"]);
    expect(profiles()["paid-ensemble"]).toMatchObject({ model: "vendor/real-model" });
    expect(notices.filter((n) => n.includes("paid-ensemble"))).toHaveLength(1);
  });
});

// ── Unmarked dynamic names (the fix-queue 25 collision) ────────────────────

describe("migrateProfileSections — an UNMARKED free/paid section", () => {
  it("ADOPTS a shipped placeholder: stamps the marker, changes nothing else, says nothing", () => {
    // This is P6a's very first run, which wrote these sections without a
    // marker (the yaml library stores a brand-new key as a raw string, which
    // cannot carry a comment). Nothing was lost, so nothing is announced.
    write(["profiles:", SHIPPED_FREE, SHIPPED_PAID, ""].join("\n"));
    const before = profiles();
    const r = run();
    expect(r.adopted.sort()).toEqual(["free", "paid"]);
    expect(r.regenerated).toEqual([]);
    expect(profiles()).toEqual(before);
    expect(markerOn("free")).toBe(true);
    expect(markerOn("paid")).toBe(true);
    expect(notices).toEqual([]);
    expect(existsSync(join(cfgDir, "backups"))).toBe(false);
  });

  it("BACKS UP and REGENERATES a hand-authored one, with ONE notice naming the backup", () => {
    const handAuthored = [
      "  free:",
      "    mode: remote",
      "    api: openrouter-remote",
      "    model: vendor/my-favourite",
      "    api_key: $OPENROUTER_API_KEY",
    ].join("\n");
    const original = ["profiles:", handAuthored, MY_OWN, ""].join("\n");
    write(original);

    const r = run();
    expect(r.regenerated).toEqual(["free"]);
    // Regenerated to the unpopulated shape, marked.
    expect(profiles().free).toEqual({
      mode: "remote",
      api: "openrouter-remote",
      free_only: true,
      free_models: [],
      model: P,
      api_key: "$OPENROUTER_API_KEY",
      "profile-type": "free",
    });
    expect(markerOn("free")).toBe(true);
    // The user's other profile survives untouched.
    expect(profiles()["my-own"]).toMatchObject({ model: "model-a" });

    // Exactly one notice, and it names a backup that exists and holds the
    // ORIGINAL bytes — "we replaced your section" is only acceptable if the
    // old one is recoverable.
    expect(notices).toHaveLength(1);
    const backups = readdirSync(join(cfgDir, "backups"));
    expect(backups).toHaveLength(1);
    expect(notices[0]).toContain(join(cfgDir, "backups", backups[0]));
    expect(readFileSync(join(cfgDir, "backups", backups[0]), "utf-8")).toBe(original);
  });

  it("does NOT touch a MARKED section at all", () => {
    write(["profiles:", ` # ${GENERATED_MARKER}`, SHIPPED_FREE, ""].join("\n"));
    const r = run();
    expect(r).toMatchObject({ adopted: [], regenerated: [], removed: [], kept: [] });
    expect(notices).toEqual([]);
  });
});

// ── It runs once, and only once ────────────────────────────────────────────

describe("migrateProfileSections — the migratedAt stamp", () => {
  it("stamps on a clean pass and is a pure no-op afterwards", () => {
    write(["profiles:", SHIPPED_FREE, SHIPPED_PAID_ENSEMBLE, ""].join("\n"));
    expect(getProfileMigrationStamp()).toBeUndefined();

    const first = run();
    expect(first.alreadyDone).toBe(false);
    expect(first.removed).toEqual(["paid-ensemble"]);
    const stamp = getProfileMigrationStamp();
    expect(typeof stamp).toBe("number");

    // Re-introduce a retired section by hand. A second run must NOT delete it.
    write(["profiles:", SHIPPED_FREE, SHIPPED_PAID_ENSEMBLE, ""].join("\n"));
    const second = run();
    expect(second.alreadyDone).toBe(true);
    expect(second.removed).toEqual([]);
    expect(profiles()).toHaveProperty("paid-ensemble");
    expect(getProfileMigrationStamp()).toBe(stamp);
  });

  it("NEVER regenerates a hand-authored free: twice — the second one is refused by validateSettings instead", () => {
    // The loop this prevents: back up + regenerate on every dispatch means the
    // user's edit is discarded each time they make it, with a new backup file
    // each time, and no way to win. After the one-time migration the answer is
    // a refusal that names the collision.
    const handAuthored = [
      "  free:",
      "    mode: remote",
      "    api: openrouter-remote",
      "    model: vendor/my-favourite",
      "    api_key: $OPENROUTER_API_KEY",
    ].join("\n");
    write(["profiles:", handAuthored, ""].join("\n"));
    run();
    expect(readdirSync(join(cfgDir, "backups"))).toHaveLength(1);

    // The user writes it again.
    notices = [];
    write(["profiles:", handAuthored, ""].join("\n"));
    const second = run();
    expect(second.alreadyDone).toBe(true);
    expect(second.regenerated).toEqual([]);
    expect(notices).toEqual([]);
    expect(readdirSync(join(cfgDir, "backups"))).toHaveLength(1);
    // Their section is still there, exactly as written…
    expect(profiles().free).toMatchObject({ model: "vendor/my-favourite" });
    // …and the configuration is REFUSED, naming the reserved names and the fix.
    const settings = loadSettings();
    expect(settings?.unmarkedDynamicProfiles).toEqual(["free"]);
    const v = validateSettings(settings!);
    expect(v.valid).toBe(false);
    expect(v.errors).toEqual([reservedDynamicProfileNameError(["free"])]);
    // D0 (TRDD-AL8GIZYA): reservedDynamicProfileNameError's wording now names
    // the "keep the marker, add a user-owned subsection" option too (design
    // section 3.2 rule 5) — "another name" is the phrase that survives from
    // the rename-your-profile remedy.
    expect(v.errors[0]).toContain("another name");
  });

  it("a MARKED section never trips the reserved-name refusal", () => {
    write(["profiles:", SHIPPED_FREE, SHIPPED_PAID, ""].join("\n"));
    run();
    stampProfileMigrationDone(Date.now());
    const settings = loadSettings();
    expect(settings?.unmarkedDynamicProfiles).toEqual([]);
    expect(validateSettings(settings!).errors).not.toContain(
      reservedDynamicProfileNameError(["free"]),
    );
  });

  it("does not stamp when the settings file does not exist yet", () => {
    const r = run();
    expect(r.alreadyDone).toBe(true);
    expect(getProfileMigrationStamp()).toBeUndefined();
  });
});

// ── S5 (fix-queue review): a migration failure must not re-notify forever ──

describe("migrateProfileSections — S5: no `profiles:` map is nothing to migrate", () => {
  it("no `profiles:` key at all: stamps and says nothing, then is a pure no-op", () => {
    // ensureSettingsExist() tolerates this exact shape (config.ts's
    // loadSettings maps it to `profiles: {}` and never regenerates the
    // file) -- red on HEAD, where loadSettingsRoot's "missing 'profiles'
    // map" throw landed in the catch and printed "could not migrate…" here,
    // every single run, because nothing was ever written that would let a
    // stamp end the loop.
    write(["active: something", ""].join("\n"));
    expect(getProfileMigrationStamp()).toBeUndefined();

    const first = run();
    expect(first.alreadyDone).toBe(false);
    expect(notices).toEqual([]);
    expect(typeof getProfileMigrationStamp()).toBe("number");

    notices = [];
    const second = run();
    expect(second.alreadyDone).toBe(true);
    expect(notices).toEqual([]);
  });

  it("`profiles: null` is the same shape as a missing key", () => {
    write(["active: something", "profiles: null", ""].join("\n"));
    expect(getProfileMigrationStamp()).toBeUndefined();

    const r = run();
    expect(r.alreadyDone).toBe(false);
    expect(notices).toEqual([]);
    expect(typeof getProfileMigrationStamp()).toBe("number");
  });

  it("`profiles: {}` (the key IS present, just empty) is NOT this shape -- it takes the normal path and stamps too", () => {
    // Distinguishing these two is the point of the fix: `!root.profiles`
    // would ALSO be true for `{}` if the guard were sloppy (`{}` is
    // truthy in JS, so it is not actually true here, but this pins the
    // boundary so a future refactor cannot blur it).
    write(["profiles: {}", ""].join("\n"));
    const r = run();
    expect(r.alreadyDone).toBe(false);
    expect(notices).toEqual([]);
    expect(typeof getProfileMigrationStamp()).toBe("number");
  });

  it("an EMPTY settings.yaml never reaches this function unguarded — S-2 (coordinator correction): ensureSettingsExist() treats it as corrupt/unparseable and regenerates it BEFORE migrateProfileSections ever runs (the real boot order, index.ts's boot IIFE), so the pre-parse guard above never needs to special-case it", () => {
    // yamlParse("") is undefined, so `doc.toJS()` (this function's own
    // pre-parse guard, above) would be `null` here -- NOT the `{profiles:
    // undefined}`-shaped object the guard's `hasNoProfilesMap` check expects,
    // so an empty file called DIRECTLY into migrateProfileSections (as `run()`
    // does everywhere else in this file) still falls through to
    // loadSettingsRoot's throw. That is not a bug to guard against here: in
    // the real boot order (index.ts:365) ensureSettingsExist() ALWAYS runs
    // first, and config.ts's loadSettings() returns null for this exact shape
    // (JSON.parse(JSON.stringify(undefined)) throws), which ensureSettingsExist
    // treats as "corrupt" -- it backs the (empty) file up and writes a fresh
    // default settings.yaml, with both dynamic profiles already present and
    // marked, before migrateProfileSections ever sees the file. So the
    // forever-loop this describe block is about is impossible for this shape
    // too, by construction of the real call order -- proven end-to-end here,
    // not by extending the guard for a state the function is never handed.
    write("");
    ensureSettingsExist();
    expect(getProfileMigrationStamp()).toBeUndefined();

    const r = run();
    expect(r.alreadyDone).toBe(false);
    expect(notices).toEqual([]);
    expect(typeof getProfileMigrationStamp()).toBe("number");
  });
});

describe("migrateProfileSections — S5: a migration stamp that cannot be persisted", () => {
  // A directory AT the stamp's own path blocks exactly the one write this
  // suite cares about (stampProfileMigrationDone's final renameSync), without
  // touching settings.yaml's own write lock at all -- unlike chmod'ing the
  // whole config dir read-only, which was tried and rejected: PASS 1 of
  // migrateProfileSections takes settings.write.lock UNCONDITIONALLY (even
  // when nothing turns out to need writing), and its acquire loop
  // (benchmark/pick.ts's acquireSettingsWriteLock) has a genuine, pre-existing,
  // OUT-OF-SCOPE bug on that path: when mkdir fails and the immediate
  // statSync/readLockHolder ALSO fails (ENOENT, because mkdir never created
  // the dir -- exactly what an unwritable parent produces), the catch does
  // `continue` with NO deadline check, so it spins forever rather than ever
  // reaching the "give up after SETTINGS_WRITE_LOCK_WAIT_MS" branch below it.
  // Confirmed by a bounded (`timeout 15`) reproduction outside this suite
  // that never returned; flagged in this task's report rather than fixed
  // here (S1/S5/57 only). This test's construction never enters that lock at
  // all, so it cannot trip it.
  it("prints the persist-failure notice once per call, every time — S-3 (coordinator correction): no process latch, because migrateProfileSections has exactly one production caller (index.ts's boot IIFE) and so never runs twice in one real process", () => {
    write(["profiles: {}", ""].join("\n"));
    mkdirSync(dynamicProfilesStatePath());

    for (let commandNumber = 1; commandNumber <= 3; commandNumber++) {
      // Each iteration stands in for a SEPARATE process (a real one calls
      // this function once): nothing about this failure can ever persist, so
      // readStamp() never sees migratedAt and migrateProfileSections
      // genuinely reruns from scratch every time -- the real-world condition
      // S5 has to bound to one notice PER CALL. No reset needed between
      // iterations: there is no per-process latch left to reset (S-3 deleted
      // it — the function itself has no state that would make a second call
      // in this loop behave any differently from the first).
      notices = [];
      const r = run();
      expect(r.alreadyDone).toBe(false);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain(dynamicProfilesStatePath());
      // B-1 (BLOCKER correction): the caller cannot know WHY the write was
      // dropped from this notice alone before this fix ("directory not
      // writable" was a guess, and the test's own real failure is EISDIR from
      // a directory AT the stamp path, not a permission error) -- the notice
      // now quotes the real cause via stampProfileMigrationDone's returned
      // Error, and says plainly what actually happens next: a hand-authored
      // section keeps getting backed up and regenerated, not refused.
      expect(notices[0]).toContain("silently dropped");
      expect(notices[0]).toContain("backed up and regenerated on the next command instead of being refused");
      expect(getProfileMigrationStamp()).toBeUndefined();
    }
  });

  // "The reserved-name refusal still fires" (B-2) is proven by the EXISTING
  // test above, "NEVER regenerates a hand-authored free: twice — the second
  // one is refused by validateSettings instead": that refusal is a pure
  // function of the raw settings.yaml TEXT (config.ts's
  // unmarkedDynamicProfileNames), never of whether the stamp persisted, so
  // it holds regardless of this describe block's failure mode. It is not
  // re-proven here under a blocked stamp path because doing so honestly
  // requires an UNMARKED reserved section, and regenerating one is a
  // settings.yaml WRITE (through the unaffected settings.write.lock) that
  // itself emits a backup notice on its first run -- combined with this
  // block's own notice that would be two notices in the same command,
  // contradicting "exactly one" rather than confirming it.
});

// ── D6a (TRDD-90DM5YHO): the `local-detected-providers` migration step ─────
// The generated probe routes on a marked `local` section moved keys
// (`providers` → `detected_providers`); the user's own groups now own
// `providers` on local. One-time, stamped, lossless key move.
describe("migrateSettingsTo141 — local-detected-providers (D6a)", () => {
  const MARKED_LOCAL_WITH_PROVIDERS = [
    "profiles:",
    `  # ${GENERATED_MARKER}`,
    "  local:",
    "    mode: local",
    "    api: llamacpp-local",
    `    model: ${P}`,
    "    free_models: []",
    "    providers:",
    "      - name: llamacpp-local",
    "        api: llamacpp-local",
    "        url: http://localhost:8080",
    "        models: [qwen3-coder-30b]",
    "",
  ].join("\n");

  it("renames providers to detected_providers on a marked local section, lossless", () => {
    write(MARKED_LOCAL_WITH_PROVIDERS);
    const res = migrateSettingsTo141(getSettingsPath(), {
      notify: (m) => notices.push(m),
      isApplied: isMigrationStepApplied,
      markApplied: markMigrationStepApplied,
    });
    expect(res.applied).toContain("local-detected-providers");
    const p = profiles().local as Record<string, unknown>;
    expect(p.providers).toBeUndefined();
    const detected = p.detected_providers as Record<string, unknown>[];
    expect(detected).toHaveLength(1);
    expect(detected[0].name).toBe("llamacpp-local");
    expect(detected[0].url).toBe("http://localhost:8080");
    expect(detected[0].models).toEqual(["qwen3-coder-30b"]);
    // The rename is a MOVE, not a copy: the old key is gone.
    expect(readFileSync(getSettingsPath(), "utf-8")).not.toMatch(/^ {4}providers:/m);
  });

  it("records the step without touching anything when there is no legacy key", () => {
    write(["profiles:", `  # ${GENERATED_MARKER}`, "  local:", "    mode: local", "    api: llamacpp-local", `    model: ${P}`, "    detected_providers: []", ""].join("\n"));
    const res = migrateSettingsTo141(getSettingsPath(), {
      notify: (m) => notices.push(m),
      isApplied: isMigrationStepApplied,
      markApplied: markMigrationStepApplied,
    });
    expect(res.applied).toContain("local-detected-providers");
    expect(isMigrationStepApplied("local-detected-providers")).toBe(true);
  });

  it("does not re-run once stamped", () => {
    write(MARKED_LOCAL_WITH_PROVIDERS);
    migrateSettingsTo141(getSettingsPath(), {
      notify: (m) => notices.push(m),
      isApplied: isMigrationStepApplied,
      markApplied: markMigrationStepApplied,
    });
    notices = [];
    const res = migrateSettingsTo141(getSettingsPath(), {
      notify: (m) => notices.push(m),
      isApplied: isMigrationStepApplied,
      markApplied: markMigrationStepApplied,
    });
    expect(res.applied).toEqual([]);
    expect(notices).toEqual([]);
  });

  // D6a-review F1 (TRDD-90DM5YHO): BOTH keys present — the legacy generated
  // `providers` plus a hand-added `detected_providers`. The rename would
  // overwrite the user's own content, so the migration must REFUSE: leave
  // both keys untouched, notify. D4-review F3: the step is NOT stamped — a
  // user who later hand-resolves the collision must get the rename re-run.
  it("refuses and notifies when BOTH providers and detected_providers exist; no key is touched, the step is NOT stamped", () => {
    write([
      "profiles:",
      `  # ${GENERATED_MARKER}`,
      "  local:",
      "    mode: local",
      "    api: llamacpp-local",
      `    model: ${P}`,
      "    free_models: []",
      "    providers:",
      "      - name: legacy-probe",
      "        api: llamacpp-local",
      "        url: http://localhost:8080",
      "        models: [legacy-model]",
      "    detected_providers:",
      "      - name: my-hand-added",
      "        api: lmstudio-local",
      "        url: http://localhost:1234",
      "        models: [hand-model]",
      "",
    ].join("\n"));
    const res = migrateSettingsTo141(getSettingsPath(), {
      notify: (m) => notices.push(m),
      isApplied: isMigrationStepApplied,
      markApplied: markMigrationStepApplied,
    });
    expect(res.applied).not.toContain("local-detected-providers");
    expect(isMigrationStepApplied("local-detected-providers")).toBe(false);
    // A notice names the collision.
    expect(notices.some((m) => m.includes("BOTH 'providers' and 'detected_providers'"))).toBe(true);
    // NOTHING moved: the user's hand-added group survives byte-for-byte, and
    // the legacy key stays for E-D1 to name.
    const p = profiles().local as Record<string, unknown>;
    const legacy = p.providers as Record<string, unknown>[];
    const mine = p.detected_providers as Record<string, unknown>[];
    expect(legacy).toHaveLength(1);
    expect(legacy[0].name).toBe("legacy-probe");
    expect(mine).toHaveLength(1);
    expect(mine[0].name).toBe("my-hand-added");

    // D4-review F3: because the refuse branch does not stamp, resolving the
    // collision by hand (delete the legacy key) lets the NEXT run rename and
    // stamp normally — the migration is not lost behind a permanent stamp.
    write([
      "profiles:",
      `  # ${GENERATED_MARKER}`,
      "  local:",
      "    mode: local",
      "    api: llamacpp-local",
      `    model: ${P}`,
      "    free_models: []",
      "    detected_providers:",
      "      - name: my-hand-added",
      "        api: lmstudio-local",
      "        url: http://localhost:1234",
      "        models: [hand-model]",
      "",
    ].join("\n"));
    notices = [];
    const after = migrateSettingsTo141(getSettingsPath(), {
      notify: (m) => notices.push(m),
      isApplied: isMigrationStepApplied,
      markApplied: markMigrationStepApplied,
    });
    expect(after.applied).toContain("local-detected-providers");
    expect(isMigrationStepApplied("local-detected-providers")).toBe(true);
  });
});

// F-4 (TRDD-OE27RD7I D4): a stamped step never re-inspects, so a marked local
// section reduced to ONLY the legacy `providers` key must warn once per process.
describe("migrateSettingsTo141 — legacy providers-only local section warns (D4 F-4)", () => {
  const localSection = (body: string[]): string =>
    ["profiles:", `  # ${GENERATED_MARKER}`, "  local:", "    mode: local", "    api: llamacpp-local", `    model: ${P}`, ...body, ""].join("\n");


  // PF-04: this describe is about the local section; a file that already went through `or-jev-section-added` keeps its notices to the steps under test.
  beforeEach(() => {
    markMigrationStepApplied("or-jev-section-added");
  });

  it("warns once when the step is already stamped and the marked local section keeps only `providers`", () => {
    write(localSection(["    detected_providers: []"]));
    run141(); // stamps the step on a normal section
    expect(notices).toEqual([expect.stringContaining("profile-type-written")]);
    write(localSection(["    providers:", "      - name: mine", "        api: llamacpp-local", "        url: http://localhost:8080", "        models: [m]"]));
    run141();
    const warns = notices.filter((m) => m.includes("'providers'") && m.includes("'detected_providers'"));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain(getSettingsPath());
    run141();
    expect(notices.filter((m) => m.includes("'providers'"))).toHaveLength(1); // once per process
  });

  it("does not warn for a normal local section (detected_providers only, or both keys absent)", () => {
    write(localSection(["    detected_providers: []"]));
    run141();
    run141();
    write(localSection([]));
    run141();
    // The untyped file is re-stamped on each rewrite (runs 1 and 3); no D4 F-4 warning may appear.
    expect(notices.filter((m) => !m.includes("profile-type-written"))).toEqual([]);
    const stamps = notices.filter((m) => m.includes("profile-type-written"));
    expect(stamps).toHaveLength(2);
    expect(stamps.every((m) => m.includes("profiles.local"))).toBe(true);
  });
});
// ── D5 (TRDD-90DM5YHO): the b.ai re-plumb migration steps ──────────────────
// The generated b.ai binding on `free` became the user's own group + a
// reserved ensemble slot; `ensemble_pins` and any other unknown key in a
// marked dynamic section is removed once, loudly. Real files, real YAML.

const MARKED_FREE_WITH_GENERATED_BAI = [
  "profiles:",
  `  # ${GENERATED_MARKER}`,
  "  free:",
  "    mode: remote-ensemble",
  "    api: openrouter-remote",
  "    api_key: $OPENROUTER_API_KEY",
  "    free_only: true",
  "    free_models: [glm-5.3-flash, vendor/one:free]",
  "    model: glm-5.3-flash",
  "    second_model: vendor/one:free",
  "    tool_models:",
  "      chat: glm-5.3-flash",
  "    providers:",
  "      - api: chat-b-ai-remote",
  "        api_key: $BAI_API_KEY",
  "        models: [glm-5.3-flash]",
  "",
].join("\n");

function run141(): ReturnType<typeof migrateSettingsTo141> {
  return migrateSettingsTo141(getSettingsPath(), {
    notify: (m) => notices.push(m),
    isApplied: isMigrationStepApplied,
    markApplied: markMigrationStepApplied,
  });
}

describe("migrateSettingsTo141 — bai-binding-to-reserved-slot (D5)", () => {
  it("converts the generated b.ai binding into the user group bai, strips the id from every generated key, and adds the reserved slot; both D5 steps are recorded", () => {
    // The binding's own credential must resolve for the migrated section to
    // validate (E-P Remote-auth on the user group) — and so must the BASE
    // credential: the bai group covers only glm-5.3-flash, the chain head is
    // vendor/one:free, so servedEntirelyByProviderRoutes does NOT exempt the
    // profile's $OPENROUTER_API_KEY and a key-less env leg (both keys unset)
    // would fail validateSettings for a reason unrelated to the migration.
    process.env.BAI_API_KEY = "test-bai-key-not-a-real-one";
    process.env.OPENROUTER_API_KEY = "test-openrouter-key-not-a-real-one";
    write(MARKED_FREE_WITH_GENERATED_BAI);

    const res = run141();
    expect(res.applied).toContain("bai-binding-to-reserved-slot");
    expect(res.applied).toContain("bai-reserved-seed");
    expect(isMigrationStepApplied("bai-binding-to-reserved-slot")).toBe(true);
    expect(isMigrationStepApplied("bai-reserved-seed")).toBe(true);

    const free = profiles().free as Record<string, unknown>;
    // The binding became the named user group.
    const providers = free.providers as Record<string, unknown>[];
    expect(providers).toHaveLength(1);
    expect(providers[0].name).toBe("bai");
    expect(providers[0].api).toBe("chat-b-ai-remote");
    expect(providers[0].api_key).toBe("$BAI_API_KEY");
    expect(providers[0].models).toEqual(["glm-5.3-flash"]);
    // The id is OUT of every generated key it sat in.
    expect(free.free_models).toEqual(["vendor/one:free"]);
    expect(free.model).toBeUndefined();
    // second_model named vendor/one:free (never the b.ai id) — untouched.
    expect(free.second_model).toBe("vendor/one:free");
    expect(free.tool_models).toBeUndefined();
    // The reserved slot is IN (user-owned key, one-time write).
    const ensemble = free.ensemble as { reserved: Record<string, unknown>[] };
    expect(ensemble.reserved).toEqual([{ provider: "bai", model: "glm-5.3-flash" }]);
    // The result is a document llm-ext still accepts.
    expect(validateSettings(loadSettings() as never).valid).toBe(true);
  });

  it("records the step untouched when providers is NOT the generated b.ai binding (a user edit is not ours to move)", () => {
    write([
      "profiles:",
      `  # ${GENERATED_MARKER}`,
      "  free:",
      "    mode: remote",
      "    api: openrouter-remote",
      "    api_key: $OPENROUTER_API_KEY",
      "    free_only: true",
      "    free_models: [vendor/one:free]",
      `    model: ${P}`,
      "    providers:",
      "      - name: mine",
      "        api: chat-b-ai-remote",
      "        api_key: literal-not-the-env-ref",
      "        models: [glm-5.3-flash, other/model]",
      "",
    ].join("\n"));

    const res = run141();
    expect(res.applied).toContain("bai-binding-to-reserved-slot");
    const free = profiles().free as Record<string, unknown>;
    // Nothing moved.
    const providers = free.providers as Record<string, unknown>[];
    expect(providers).toHaveLength(1);
    expect(providers[0].name).toBe("mine");
    expect(free.free_models).toEqual(["vendor/one:free"]);
    expect(free.ensemble).toBeUndefined();
  });

  it("does not re-run once stamped", () => {
    write(MARKED_FREE_WITH_GENERATED_BAI);
    run141();
    notices = [];
    const res = run141();
    expect(res.applied).toEqual([]);
    expect(notices).toEqual([]);
  });
});

describe("migrateSettingsTo141 — bai-reserved-seed (D5, design section 3.2 rule 6)", () => {
  const MARKED_FREE_NO_BAI = [
    "profiles:",
    `  # ${GENERATED_MARKER}`,
    "  free:",
    "    mode: remote",
    "    api: openrouter-remote",
    "    api_key: $OPENROUTER_API_KEY",
    "    free_only: true",
    "    free_models: [vendor/one:free]",
    `    model: ${P}`,
    "",
  ].join("\n");

  it("with BAI_API_KEY set: adds the bai group and the reserved slot, and records the step", () => {
    // Same base-credential need as the convert test above: the seeded section
    // keeps model: <placeholder> on $OPENROUTER_API_KEY, which the bai group
    // does not cover, so validation under a key-less env leg needs the var set.
    process.env.BAI_API_KEY = "test-bai-key-not-a-real-one";
    process.env.OPENROUTER_API_KEY = "test-openrouter-key-not-a-real-one";
    write(MARKED_FREE_NO_BAI);

    const res = run141();
    expect(res.applied).toContain("bai-reserved-seed");
    const free = profiles().free as Record<string, unknown>;
    const providers = free.providers as Record<string, unknown>[];
    expect(providers).toHaveLength(1);
    expect(providers[0]).toEqual({
      name: "bai",
      api: "chat-b-ai-remote",
      api_key: "$BAI_API_KEY",
      models: ["glm-5.3-flash"],
    });
    const ensemble = free.ensemble as { reserved: Record<string, unknown>[] };
    expect(ensemble.reserved).toEqual([{ provider: "bai", model: "glm-5.3-flash" }]);
    expect(validateSettings(loadSettings() as never).valid).toBe(true);
  });

  it("with NO BAI_API_KEY: records the step and writes nothing (the slot appears on the first boot after the key is exported, on an UNSTAMPED machine)", () => {
    write(MARKED_FREE_NO_BAI);

    const res = run141();
    expect(res.applied).toContain("bai-reserved-seed");
    const free = profiles().free as Record<string, unknown>;
    expect(free.providers).toBeUndefined();
    expect(free.ensemble).toBeUndefined();
    expect(isMigrationStepApplied("bai-reserved-seed")).toBe(true);
  });

  it("never re-seeds after the stamp: deleting the slot, the group, or the whole section does not bring it back", () => {
    process.env.BAI_API_KEY = "test-bai-key-not-a-real-one";
    write(MARKED_FREE_NO_BAI);
    run141();

    // The user deletes the slot and the group.
    write(MARKED_FREE_NO_BAI);
    notices = [];
    const res = run141();
    expect(res.applied).not.toContain("bai-reserved-seed");
    expect(res.applied).toEqual(["profile-type-written"]);
    // An untyped file rewritten mid-test is re-stamped, PT-02 lockout fix.
    expect(notices).toHaveLength(1);
    expect(notices.every((n) => n.includes("'profile-type-written' migration wrote profile-type"))).toBe(true);
    expect(notices.some((n) => /bai|reserved/i.test(n))).toBe(false);
    const free = profiles().free as Record<string, unknown>;
    expect(free.providers).toBeUndefined();
    expect(free.ensemble).toBeUndefined();
  });

  it("a slot already naming glm-5.3-flash records the step and writes nothing", () => {
    process.env.BAI_API_KEY = "test-bai-key-not-a-real-one";
    write([
      "profiles:",
      `  # ${GENERATED_MARKER}`,
      "  free:",
      "    mode: remote",
      "    api: openrouter-remote",
      "    api_key: $OPENROUTER_API_KEY",
      "    free_only: true",
      "    free_models: [vendor/one:free]",
      `    model: ${P}`,
      "    ensemble:",
      "      reserved:",
      "        - provider: bai",
      "          model: glm-5.3-flash",
      "",
    ].join("\n"));

    const res = run141();
    expect(res.applied).toContain("bai-reserved-seed");
    const free = profiles().free as Record<string, unknown>;
    expect(free.providers).toBeUndefined(); // no group added — the slot was already there
  });

  it("no room for a slot (2 reserved already): records with a nothing-to-do pass, no write", () => {
    process.env.BAI_API_KEY = "test-bai-key-not-a-real-one";
    write([
      "profiles:",
      `  # ${GENERATED_MARKER}`,
      "  free:",
      "    mode: remote",
      "    api: openrouter-remote",
      "    api_key: $OPENROUTER_API_KEY",
      "    free_only: true",
      "    free_models: [vendor/one:free]",
      `    model: ${P}`,
      "    ensemble:",
      "      reserved:",
      "        - model: a/one:free",
      "        - model: a/two:free",
      "",
    ].join("\n"));

    const res = run141();
    expect(res.applied).toContain("bai-reserved-seed");
    const free = profiles().free as Record<string, unknown>;
    expect(free.providers).toBeUndefined();
  });
});

describe("migrateSettingsTo141 — dynamic-unknown-keys (D5, the last key-table slice)", () => {
  it("removes ensemble_pins and a hand-added timeout from marked dynamic sections, with one notice naming each key", () => {
    write([
      "profiles:",
      `  # ${GENERATED_MARKER}`,
      "  free:",
      "    mode: remote",
      "    api: openrouter-remote",
      "    api_key: $OPENROUTER_API_KEY",
      "    free_only: true",
      "    free_models: [vendor/one:free]",
      `    model: ${P}`,
      "    ensemble_pins:",
      '      "0": vendor/one:free',
      "    timeout: 42",
      `  # ${GENERATED_MARKER}`,
      "  paid:",
      "    mode: remote",
      "    api: openrouter-remote",
      "    api_key: $OPENROUTER_API_KEY",
      `    model: ${P}`,
      "    legacy_stray: oops",
      "",
    ].join("\n"));

    const res = run141();
    expect(res.applied).toContain("dynamic-unknown-keys");
    expect(notices.some((m) => m.includes("profiles.free.ensemble_pins"))).toBe(true);
    expect(notices.some((m) => m.includes("profiles.free.timeout"))).toBe(true);
    expect(notices.some((m) => m.includes("profiles.paid.legacy_stray"))).toBe(true);
    const free = profiles().free as Record<string, unknown>;
    const paid = profiles().paid as Record<string, unknown>;
    expect(free.ensemble_pins).toBeUndefined();
    expect(free.timeout).toBeUndefined();
    expect(paid.legacy_stray).toBeUndefined();
    // Known keys survive.
    expect(free.free_models).toEqual(["vendor/one:free"]);
    expect(paid.model).toBe(P);
  });

  it("never touches a STATIC profile's unknown keys (static profiles are never rewritten)", () => {
    write([
      "profiles:",
      `  # ${GENERATED_MARKER}`,
      "  free:",
      "    mode: remote",
      "    api: openrouter-remote",
      "    api_key: $OPENROUTER_API_KEY",
      "    free_only: true",
      "    free_models: [vendor/one:free]",
      `    model: ${P}`,
      "  mine:",
      "    mode: remote",
      "    api: openrouter-remote",
      "    api_key: $OPENROUTER_API_KEY",
      "    model: vendor/mine",
      "    ensemble_pins:",
      '      "0": vendor/mine',
      "",
    ].join("\n"));

    const res = run141();
    expect(res.applied).toContain("dynamic-unknown-keys");
    const mine = profiles().mine as Record<string, unknown>;
    expect(mine.ensemble_pins).toBeDefined(); // untouched
    expect(notices.filter((m) => m.includes("profiles.mine"))).toEqual([expect.stringContaining("profile-type-written")]);
  });

  it("keeps keys D5 turned user-owned (ensemble, providers on free) — only keys outside the FINAL tables go", () => {
    process.env.BAI_API_KEY = "test-bai-key-not-a-real-one";
    write([
      "profiles:",
      `  # ${GENERATED_MARKER}`,
      "  free:",
      "    mode: remote",
      "    api: openrouter-remote",
      "    api_key: $OPENROUTER_API_KEY",
      "    free_only: true",
      "    free_models: [vendor/one:free]",
      `    model: ${P}`,
      "    ensemble:",
      "      reserved:",
      "        - model: vendor/one:free",
      "    ensemble_pins:",
      '      "0": vendor/one:free',
      "",
    ].join("\n"));

    const res = run141();
    expect(res.applied).toContain("dynamic-unknown-keys");
    const free = profiles().free as Record<string, unknown>;
    expect(free.ensemble).toBeDefined(); // user-owned — kept
    expect(free.ensemble_pins).toBeUndefined(); // removed
  });
});
