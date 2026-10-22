// Ensemble coverage of the health ledger (P1 zero-token model pipeline).
//
// Before P1 the ledger only informed tools that own a per-tool selector benchmark
// (security_scan, search_existing_implementations). The ENSEMBLE slots — which serve
// every other tool — had no automated verdict at all: the skill asked the AGENT to
// read the retry history and decide whether a 404 was "persistent". planEnsembleRotation
// closes that gap with the code threshold.
//
// The ledger here is a REAL file read by the REAL readModelEvents (eventsPath is the
// module's own injectable IO seam, not a mock of the thing under test). Only the
// settings resolver is faked — it is the seam that would otherwise read the developer's
// own ~/.llm-externalizer.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { planEnsembleRotation, renderEnsembleRotationSection } from "./auto-replace.js";
import type { EnsembleReader } from "./auto-replace.js";

const NOW = new Date("2026-07-11T12:00:00+0200");

/** A ledger line in the exact on-disk format appendModelEvent writes. */
function line(model: string, hoursAgo: number, kind: string, detail: string): string {
  const at = new Date(NOW.getTime() - hoursAgo * 3_600_000);
  const ts = at.toISOString().replace(/\.\d{3}Z$/, "") + "+0000";
  return `${ts} - ${model} - ${kind} - ${detail}`;
}

const reader = (): EnsembleReader => ({
  profileName: "ens",
  slots: [
    { slot: "model", modelId: "v/first" },
    { slot: "second_model", modelId: "v/second" },
    { slot: "third_model", modelId: "v/third" },
  ],
});

describe("planEnsembleRotation", () => {
  let dir = "";
  let ledger = "";

  beforeEach(() => {
    dir = mkdtempSync(join("/tmp", "ensrot-"));
    ledger = join(dir, "model-events.log");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reports every slot healthy on an EMPTY ledger — a quiet model never rotates", () => {
    writeFileSync(ledger, "");
    const plan = planEnsembleRotation({
      eventsPath: ledger,
      settingsReader: reader,
      persistence: { now: NOW },
    });
    expect(plan.profileName).toBe("ens");
    expect(plan.slots).toHaveLength(3);
    expect(plan.rotationNeeded).toBe(false);
    expect(plan.brokenSlots).toEqual([]);
    expect(plan.slots[0].verdict.reason).toMatch(/no model-scoped failure/);
  });

  it("flags ONLY the slot whose model crossed the threshold", () => {
    writeFileSync(
      ledger,
      [
        line("v/second", 5, "non_retryable_failure", "HTTP 404"),
        line("v/second", 3, "non_retryable_failure", "HTTP 404"),
        line("v/second", 1, "non_retryable_failure", "HTTP 404"),
        // Noise that must NOT rotate anything: rate limits and a healed old break.
        line("v/first", 2, "rate_limit_429", "429 during call"),
        line("v/third", 40, "non_retryable_failure", "HTTP 404"),
        line("v/third", 39, "non_retryable_failure", "HTTP 404"),
        line("v/third", 38, "non_retryable_failure", "HTTP 404"),
        "",
      ].join("\n"),
    );
    const plan = planEnsembleRotation({
      eventsPath: ledger,
      settingsReader: reader,
      persistence: { now: NOW },
    });
    expect(plan.rotationNeeded).toBe(true);
    expect(plan.brokenSlots.map((s) => s.slot)).toEqual(["second_model"]);
    expect(plan.brokenSlots[0].modelId).toBe("v/second");
    expect(plan.brokenSlots[0].verdict.httpStatus).toBe(404);
    // The 429-only slot and the aged-out slot stay healthy.
    expect(plan.slots.find((s) => s.slot === "model")?.verdict.persistentlyBroken).toBe(false);
    expect(plan.slots.find((s) => s.slot === "third_model")?.verdict.persistentlyBroken).toBe(false);
  });

  it("does not rotate on a 5xx burst against a live ensemble model", () => {
    writeFileSync(
      ledger,
      [
        line("v/first", 3, "non_retryable_failure", "HTTP 503"),
        line("v/first", 2, "non_retryable_failure", "HTTP 503"),
        line("v/first", 1, "non_retryable_failure", "HTTP 503"),
        "",
      ].join("\n"),
    );
    const plan = planEnsembleRotation({
      eventsPath: ledger,
      settingsReader: reader,
      persistence: { now: NOW },
    });
    expect(plan.rotationNeeded).toBe(false);
  });

  it("tolerates a missing ledger file (a fresh install has no events yet)", () => {
    const plan = planEnsembleRotation({
      eventsPath: join(dir, "nope.log"),
      settingsReader: reader,
      persistence: { now: NOW },
    });
    expect(plan.rotationNeeded).toBe(false);
    expect(plan.slots).toHaveLength(3);
  });

  it("handles a profile with no configured slot at all", () => {
    writeFileSync(ledger, "");
    const plan = planEnsembleRotation({
      eventsPath: ledger,
      settingsReader: () => ({ profileName: "(unconfigured)", slots: [] }),
      persistence: { now: NOW },
    });
    expect(plan.slots).toEqual([]);
    expect(plan.rotationNeeded).toBe(false);
    expect(renderEnsembleRotationSection(plan)).toContain("No ensemble slot is configured");
  });

  it("renders a report section that states the verdict without any paraphrase needed", () => {
    writeFileSync(
      ledger,
      [
        line("v/first", 5, "non_retryable_failure", "HTTP 410"),
        line("v/first", 3, "non_retryable_failure", "HTTP 410"),
        line("v/first", 1, "non_retryable_failure", "HTTP 410"),
        "",
      ].join("\n"),
    );
    const plan = planEnsembleRotation({
      eventsPath: ledger,
      settingsReader: reader,
      persistence: { now: NOW },
    });
    const md = renderEnsembleRotationSection(plan);
    expect(md).toContain("1 of 3 slot(s) are PERSISTENTLY BROKEN");
    expect(md).toContain("**model:** `v/first` — BROKEN");
    expect(md).toContain("3 consecutive HTTP 410 failures");
    expect(md).toContain("**second_model:** `v/second` — healthy");
  });
});

// ── P6b-fix3 B-1' / S-5': the DEFAULT readers, against a real settings.yaml ──
//
// Every case above injects `settingsReader`, so neither default reader was
// exercised at all — which is why `defaultEnsembleReader` could read the disk
// `active:` key while `--apply` wrote `--profile` for a whole release. These
// drive the REAL readers through a real settings.yaml in an isolated
// LLM_EXT_CONFIG_DIR; only the ledger path (a declared IO seam) is redirected.
describe("the default profile readers name the profile the caller asked for (P6b-fix3 B-1'/S-5')", () => {
  let cfgDir = "";
  let prevCfgDir: string | undefined;
  let ledger = "";

  /** `ens` runs three named slots; `free` runs one, and that one is the model
   *  the ledger below condemns. So "which profile did the reader read?" is
   *  answerable from the slot COUNT alone, with no string matching. */
  const SETTINGS_WITHOUT_ACTIVE = [
    "profiles:",
    "  ens:",
    "    mode: remote-ensemble",
    "    api: openrouter-remote",
    "    api_key: $OPENROUTER_API_KEY",
    "    model: ens/first",
    "    second_model: ens/second",
    "    third_model: ens/third",
    "    tool_models:",
    "      security_scan: ens/tool-head",
    "  free:",
    "    mode: remote",
    "    api: openrouter-remote",
    "    api_key: $OPENROUTER_API_KEY",
    "    model: free/only",
    "",
  ].join("\n");

  beforeEach(() => {
    prevCfgDir = process.env.LLM_EXT_CONFIG_DIR;
    cfgDir = mkdtempSync(join("/tmp", "llmext-ensrot-cfg-"));
    process.env.LLM_EXT_CONFIG_DIR = cfgDir;
    ledger = join(cfgDir, "model-events.log");
  });

  afterEach(() => {
    if (prevCfgDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
    else process.env.LLM_EXT_CONFIG_DIR = prevCfgDir;
    rmSync(cfgDir, { recursive: true, force: true });
  });

  it("S-5': with NO 'active:' key at all, profileName 'ens' still resolves ens's own slots", () => {
    // `active:` is optional (absent means the built-in default, TRDD-G6XT3AY9)
    // and this call passes an EXPLICIT profileName -- orthogonal to whatever
    // `active:` says either way. Both default readers used to take an absent
    // `active:` as "nothing is configured" and hand back an empty/DEFAULT_MODEL
    // answer while still labelling the report with the requested name.
    writeFileSync(join(cfgDir, "settings.yaml"), SETTINGS_WITHOUT_ACTIVE, "utf-8");
    const plan = planEnsembleRotation({
      eventsPath: ledger,
      profileName: "ens",
      persistence: { now: NOW },
    });
    expect(plan.profileName).toBe("ens");
    expect(plan.slots.map((s) => s.modelId)).toEqual(["ens/first", "ens/second", "ens/third"]);
    expect(plan.rotationNeeded).toBe(false);
  });

  it("B-1': a disk 'active: free' whose only model is persistently broken never rotates 'ens'", () => {
    // The blocker: the verdict AND the re-pick arity (topN = slots.length, which
    // applyPicksToSettings turns into the written profile's `mode`) came from
    // `profiles.free` while --apply wrote `profiles.ens`.
    writeFileSync(join(cfgDir, "settings.yaml"), `active: free\n${SETTINGS_WITHOUT_ACTIVE}`, "utf-8");
    writeFileSync(
      ledger,
      [
        line("free/only", 5, "non_retryable_failure", "HTTP 410"),
        line("free/only", 3, "non_retryable_failure", "HTTP 410"),
        line("free/only", 1, "non_retryable_failure", "HTTP 410"),
        "",
      ].join("\n"),
    );
    // Control: asked for `free`, the same ledger DOES warrant a rotation — so a
    // green `ens` case below cannot pass merely because the ledger was unread.
    const freePlan = planEnsembleRotation({
      eventsPath: ledger,
      profileName: "free",
      persistence: { now: NOW },
    });
    expect(freePlan.rotationNeeded).toBe(true);
    expect(freePlan.slots).toHaveLength(1);

    const ensPlan = planEnsembleRotation({
      eventsPath: ledger,
      profileName: "ens",
      persistence: { now: NOW },
    });
    expect(ensPlan.profileName).toBe("ens");
    expect(ensPlan.slots).toHaveLength(3);
    expect(ensPlan.rotationNeeded, "ens was rotated on free's slot health").toBe(false);
  });

  it("S-5': the TOOL half resolves the named profile's own incumbent, not DEFAULT_MODEL", async () => {
    // The same defect on `defaultSettingsReader`'s early return. `force: false`
    // with an empty ledger runs NO benchmark, so this is a pure read — the
    // injected runner is a tripwire that must never fire.
    writeFileSync(join(cfgDir, "settings.yaml"), SETTINGS_WITHOUT_ACTIVE, "utf-8");
    const { planToolReplacements } = await import("./auto-replace.js");
    const plan = await planToolReplacements({
      profileName: "ens",
      eventsPath: ledger,
      benchmarkRunner: () => {
        throw new Error("no benchmark may run on a healthy ledger without --force");
      },
    });
    const securityScan = plan.findings.find((f) => f.tool === "security_scan");
    expect(securityScan, "security_scan has a per-tool selector benchmark").toBeDefined();
    expect(securityScan?.incumbentModelId).toBe("ens/tool-head");
  });
});
