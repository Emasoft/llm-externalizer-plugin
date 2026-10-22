/**
 * P6c-a2b — the P6c-a review's S1 finding + fix-queue 57, through the REAL
 * boot and reload paths (not a re-derivation of the logic in the test).
 *
 * S1: `shouldBootDespiteInvalidActiveProfile`'s unpopulated-placeholder
 * exemption answers a PER-PROFILE question ("is the active profile merely
 * unbenchmarked?") and discards the WHOLE validateSettings error list on
 * `true`. Before this fix, that let a SETTINGS-level refusal -- a
 * hand-authored section under a RESERVED dynamic name ('free'/'paid'),
 * config.ts's reservedDynamicProfileNameError -- be silently swallowed
 * whenever the OTHER dynamic profile happened to still be an unbenchmarked
 * placeholder, which is the single most likely state on a fresh install.
 *
 * 57: `applyNewSettings` used to set `settingsValid` from whether the active
 * profile object merely EXISTED, never from validateSettings' actual
 * verdict -- so a reload of a document the validator had genuinely rejected
 * could still report itself CONFIGURED.
 *
 * Both are now one shared decision (index.ts's evaluateSettingsValidity),
 * used by boot, reloadSettingsFromDisk, overrideActiveProfile and
 * applyNewSettings alike -- these tests drive that decision through the
 * REAL boot IIFE (a fresh module import per index.test.ts's/
 * default-profile-wiring.test.ts's established `vi.resetModules()` +
 * dynamic `import("./index.js")` pattern) and the REAL reload path (via
 * `__reloadSettingsFromDiskForTests`, the same "private by design" test
 * accessor convention as `__getBootStateForTests`).
 *
 * Hermetic: no network, no spawn. Every profile here is either an
 * unroutable placeholder id or an unreachable `vendor/…` id nothing in this
 * file ever sends a request to.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { GENERATED_MARKER, PLACEHOLDER_MODEL_ID, reservedDynamicProfileNameError } from "./config.js";
import { stampProfileMigrationDone } from "./default-profiles-state.js";

let cfgDir: string | undefined;
let prevCfgDir: string | undefined;

beforeEach(() => {
  prevCfgDir = process.env.LLM_EXT_CONFIG_DIR;
  // Boot resolves an OpenRouter model-info cache eagerly for some code
  // paths; unstubbed, the first real fetch attempt eats several seconds
  // waiting on a real network round trip nothing here needs (same stub
  // default-profile-wiring.test.ts uses for the identical reason).
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
});

afterEach(() => {
  if (prevCfgDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
  else process.env.LLM_EXT_CONFIG_DIR = prevCfgDir;
  if (cfgDir) rmSync(cfgDir, { recursive: true, force: true });
  cfgDir = undefined;
  vi.unstubAllGlobals();
});

/** Same construction as default-profile-wiring.test.ts's loadFreshIndex:
 *  config.ts's getConfigDir() only allows paths under $HOME or
 *  /private/tmp, so mkdtempSync under "/tmp" (which resolves to
 *  /private/tmp on macOS), never os.tmpdir() -- and vi.resetModules() is
 *  load-bearing: without it, `import("./index.js")` returns the SAME
 *  cached module every test (ESM module caching), so a "fresh" boot after
 *  the first test silently reuses the FIRST test's activeSettings instead
 *  of re-running the boot IIFE against the new config dir.
 *
 *  Pre-stamps the one-time profile migration as already done. S1's bug is
 *  specifically about the state AFTER migration has already run once and
 *  stamped itself: on a genuinely fresh (unstamped) boot, migrateProfileSections
 *  would silently "fix" (back up + regenerate + mark) an unmarked hand-authored
 *  section BEFORE evaluateSettingsValidity ever sees it, which is exactly what
 *  migration is FOR -- and would make it impossible for this file's unmarked
 *  fixtures to stay unmarked long enough to exercise the boot-time refusal at
 *  all. Pre-stamping mirrors the real-world window (migration ran once, long
 *  ago; the user hand-edited a reserved-name section afterwards) without
 *  duplicating migrateProfileSections' own tests (profile-migration.test.ts). */
async function loadFreshIndex(settingsYaml: string) {
  cfgDir = mkdtempSync(join("/tmp", "llm-ext-boot-reload-validity-"));
  writeFileSync(join(cfgDir, "settings.yaml"), settingsYaml, "utf-8");
  process.env.LLM_EXT_CONFIG_DIR = cfgDir;
  stampProfileMigrationDone(Date.now());
  vi.resetModules();
  return import("./index.js");
}

function writeSettings(settingsYaml: string): void {
  if (!cfgDir) throw new Error("writeSettings: no active config dir (call loadFreshIndex first)");
  writeFileSync(join(cfgDir, "settings.yaml"), settingsYaml, "utf-8");
}

const P = PLACEHOLDER_MODEL_ID;

// A comment on the line right before the FIRST key of `profiles:` attaches
// to the MAP, not the key (config.ts's profileSectionMarkerState's
// documented index-0 fallback) -- one leading space, matching the exact
// construction profile-migration.test.ts's "does NOT touch a MARKED
// section at all" test already proves round-trips correctly.
const MARKED_FREE_UNPOPULATED = [
  ` # ${GENERATED_MARKER}`,
  "  free:",
  "    mode: remote",
  "    api: openrouter-remote",
  "    free_only: true",
  "    free_models: []",
  `    model: ${P}`,
  "    api_key: $OPENROUTER_API_KEY",
  "    profile-type: free",
].join("\n");

// A comment before any LATER key attaches to that key directly.
const MARKED_PAID_UNPOPULATED = [
  `  # ${GENERATED_MARKER}`,
  "  paid:",
  "    mode: remote",
  "    api: openrouter-remote",
  `    model: ${P}`,
  "    api_key: $OPENROUTER_API_KEY",
  "    profile-type: paid",
].join("\n");

const UNMARKED_PAID_HAND_AUTHORED = [
  "  paid:",
  "    mode: remote",
  "    api: openrouter-remote",
  "    model: vendor/my-favourite-paid-model",
  "    api_key: $OPENROUTER_API_KEY",
].join("\n");

const MARKED_PAID_HAND_AUTHORED = [
  `  # ${GENERATED_MARKER}`,
  "  paid:",
  "    mode: remote",
  "    api: openrouter-remote",
  "    model: vendor/my-favourite-paid-model",
  "    api_key: $OPENROUTER_API_KEY",
  "    profile-type: paid",
].join("\n");

/** Fresh-install shape: both dynamic profiles marked and unpopulated,
 *  `active:` omitted (defaults to 'free'). The state the boot exemption
 *  exists for -- must stay CONFIGURED before and after this fix. */
const FRESH_INSTALL_YAML = [
  "allow_paid_models: false",
  "profiles:",
  MARKED_FREE_UNPOPULATED,
  MARKED_PAID_UNPOPULATED,
  "",
].join("\n");

/** S1's exact collision: `free` is still a harmless unbenchmarked
 *  placeholder, but `paid` is a hand-authored section under a RESERVED
 *  dynamic name, unmarked -- validateSettings must refuse the whole
 *  document, and the `free` placeholder exemption must not be able to
 *  discard that refusal just because `free` (not `paid`) is the one that
 *  is merely unpopulated. */
const UNMARKED_PAID_YAML = [
  "allow_paid_models: false",
  "profiles:",
  MARKED_FREE_UNPOPULATED,
  UNMARKED_PAID_HAND_AUTHORED,
  "",
].join("\n");

/** B-4 negative control: byte-identical `paid` content, but MARKED -- no
 *  reserved-name collision, so this must boot/reload CONFIGURED. */
const MARKED_PAID_YAML = [
  "allow_paid_models: false",
  "profiles:",
  MARKED_FREE_UNPOPULATED,
  MARKED_PAID_HAND_AUTHORED,
  "",
].join("\n");

describe("S1 + 57 — evaluateSettingsValidity through the real boot + reload paths", () => {
  it("boot: a fresh install (marked, unpopulated free+paid) is CONFIGURED via the placeholder exemption", async () => {
    const mod = await loadFreshIndex(FRESH_INSTALL_YAML);
    expect(mod.__getBootStateForTests()).toEqual({ settingsValid: true, activeResolved: true });
  });

  it("boot: an unmarked hand-authored paid: is NOT CONFIGURED even though free is a harmless placeholder (S1, red on HEAD)", async () => {
    const mod = await loadFreshIndex(UNMARKED_PAID_YAML);
    expect(mod.__getBootStateForTests()).toEqual({ settingsValid: false, activeResolved: false });
  });

  it("boot: the SAME paid: content, marked, boots CONFIGURED (B-4 positive control)", async () => {
    const mod = await loadFreshIndex(MARKED_PAID_YAML);
    expect(mod.__getBootStateForTests()).toEqual({ settingsValid: true, activeResolved: true });
  });

  it("reload: the reserved-name refusal survives the placeholder exemption, and does not latch", async () => {
    const mod = await loadFreshIndex(FRESH_INSTALL_YAML);
    expect(mod.__getBootStateForTests()).toEqual({ settingsValid: true, activeResolved: true });

    // 1. Reloading the identical fresh-install shape is a no-op that stays
    //    CONFIGURED -- the baseline the fix must not regress.
    writeSettings(FRESH_INSTALL_YAML);
    expect(mod.__reloadSettingsFromDiskForTests()).toEqual({ ok: true, error: "" });
    expect(mod.__getBootStateForTests()).toEqual({ settingsValid: true, activeResolved: true });

    // 2. S1's collision, through reload: red on HEAD -- HEAD's reload had
    //    its OWN inline copy of the exemption (index.ts:629 per the review),
    //    with the identical gap as boot's. A REJECTED reload never calls
    //    applyNewSettings (reloadSettingsFromDisk's own documented contract:
    //    "ignoring change, keeping the previous settings"), so the module
    //    keeps running on the LAST ACCEPTED document -- the assertion here is
    //    on the returned verdict, not on boot state flipping to NOT
    //    CONFIGURED (it correctly does not).
    writeSettings(UNMARKED_PAID_YAML);
    const rejected = mod.__reloadSettingsFromDiskForTests();
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toBe(reservedDynamicProfileNameError(["paid"]));
    expect(mod.__getBootStateForTests()).toEqual({ settingsValid: true, activeResolved: true });

    // 2b. B-4 positive control via reload too: the POSITIVE CONFIGURED
    //     signal, not merely "the refusal string is absent".
    writeSettings(MARKED_PAID_YAML);
    expect(mod.__reloadSettingsFromDiskForTests()).toEqual({ ok: true, error: "" });
    expect(mod.__getBootStateForTests()).toEqual({ settingsValid: true, activeResolved: true });

    // 4. No latch: reject again, then recover again -- evaluateSettingsValidity
    //    is a pure per-call function of the document, not a one-way gate.
    writeSettings(UNMARKED_PAID_YAML);
    expect(mod.__reloadSettingsFromDiskForTests().ok).toBe(false);
    writeSettings(FRESH_INSTALL_YAML);
    expect(mod.__reloadSettingsFromDiskForTests()).toEqual({ ok: true, error: "" });
    expect(mod.__getBootStateForTests()).toEqual({ settingsValid: true, activeResolved: true });
  });

  it("reload: a PARSEABLE document that fails validation for an UNRELATED reason (a genuinely missing field, not S1's refusal) still rejects with THAT message (57, no regression)", async () => {
    // `my-custom` is an ordinary STATIC profile -- not one of DYNAMIC_PROFILE_NAMES,
    // so shouldBootDespiteInvalidActiveProfile can never exempt it (its very
    // first check, isDynamicProfileName, returns false for this name) -- this is
    // a two-sided check: the ordinary, non-S1 validateSettings rejection path
    // must still work exactly as it did before evaluateSettingsValidity replaced
    // the inline duplicate at each call site.
    //
    // (paid_benchmark_daily_cap_usd was tried first, per the original spec's
    // wording ("a cap error") -- it does not reach validateSettings at all:
    // config.ts's loadSettings() never copies that field out of the parsed
    // YAML into the Settings object it returns, so appendCapErrors' check is
    // unreachable through the real load path. That is a separate, real,
    // out-of-scope defect (loadSettings silently drops a documented Settings
    // field), flagged in this task's report rather than fixed here.)
    const validCustom = [
      "active: my-custom",
      "profiles:",
      "  my-custom:",
      "    mode: local",
      "    api: generic-local",
      "    model: model-a",
      "    url: http://127.0.0.1:1",
      "    profile-type: local",
      "",
    ].join("\n");
    const mod = await loadFreshIndex(validCustom);
    expect(mod.__getBootStateForTests()).toEqual({ settingsValid: true, activeResolved: true });

    const missingModel = validCustom.replace("    model: model-a\n", "");
    writeSettings(missingModel);
    const rejected = mod.__reloadSettingsFromDiskForTests();
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toContain("missing required field: model");
    // A rejected reload keeps the LAST ACCEPTED document running (see the
    // identical note in the reserved-name test above) -- still CONFIGURED
    // on the profile it booted with, not flipped to NOT CONFIGURED.
    expect(mod.__getBootStateForTests()).toEqual({ settingsValid: true, activeResolved: true });

    // Recovers once the document is valid again -- same no-latch property.
    writeSettings(validCustom);
    expect(mod.__reloadSettingsFromDiskForTests()).toEqual({ ok: true, error: "" });
  });
});

describe("row 75 — the placeholder exemption is gated on settingsLevelErrors, not just the reserved-name case", () => {
  // Fresh install (both dynamic profiles marked, unpopulated), same shape as
  // FRESH_INSTALL_YAML above, PLUS an invalid paid_benchmark_daily_cap_usd.
  // Before row 75, evaluateSettingsValidity's exemption only checked
  // unmarkedDynamicProfiles, so this booted CONFIGURED and the cap error was
  // silently discarded (row 75's own premise, and fix-queue 74's finding
  // that appendCapErrors is now reachable through the real load path).
  const FRESH_INSTALL_INVALID_CAP_YAML = [
    "allow_paid_models: false",
    "paid_benchmark_daily_cap_usd: -1",
    "profiles:",
    MARKED_FREE_UNPOPULATED,
    MARKED_PAID_UNPOPULATED,
    "",
  ].join("\n");

  it("(i) placeholder active profile + an invalid cap is NOT exempt -- red on HEAD", async () => {
    const mod = await loadFreshIndex(FRESH_INSTALL_INVALID_CAP_YAML);
    expect(mod.__getBootStateForTests()).toEqual({ settingsValid: false, activeResolved: false });
  });

  it("(i) reload: the same invalid-cap document is rejected with the cap message, and does not latch", async () => {
    const mod = await loadFreshIndex(FRESH_INSTALL_YAML);
    expect(mod.__getBootStateForTests()).toEqual({ settingsValid: true, activeResolved: true });

    writeSettings(FRESH_INSTALL_INVALID_CAP_YAML);
    const rejected = mod.__reloadSettingsFromDiskForTests();
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toContain("paid_benchmark_daily_cap_usd must be a finite number >= 0");
    // A rejected reload keeps the LAST ACCEPTED document running.
    expect(mod.__getBootStateForTests()).toEqual({ settingsValid: true, activeResolved: true });

    writeSettings(FRESH_INSTALL_YAML);
    expect(mod.__reloadSettingsFromDiskForTests()).toEqual({ ok: true, error: "" });
    expect(mod.__getBootStateForTests()).toEqual({ settingsValid: true, activeResolved: true });
  });

  it("(ii) placeholder active profile + a valid cap stays exempt -- unchanged behaviour, pinned", async () => {
    const FRESH_INSTALL_VALID_CAP_YAML = [
      "allow_paid_models: false",
      "paid_benchmark_daily_cap_usd: 0.25",
      "profiles:",
      MARKED_FREE_UNPOPULATED,
      MARKED_PAID_UNPOPULATED,
      "",
    ].join("\n");
    const mod = await loadFreshIndex(FRESH_INSTALL_VALID_CAP_YAML);
    expect(mod.__getBootStateForTests()).toEqual({ settingsValid: true, activeResolved: true });
  });

  it("(iii) placeholder active profile + an unmarked reserved-name section is still refused -- unchanged behaviour, pinned", async () => {
    const mod = await loadFreshIndex(UNMARKED_PAID_YAML);
    expect(mod.__getBootStateForTests()).toEqual({ settingsValid: false, activeResolved: false });
  });
});
