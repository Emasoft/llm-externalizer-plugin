// P6c-b (TRDD-90DM5YHO): a doc/config guard that only proves a token MENTION
// cannot fail when the CLAIM around it goes false (memory:
// a-doc-guard-that-asserts-a-mention-cannot-see-a-stale-claim) — every
// assertion below imports the constant from non-test src, or extracts the
// literal straight out of the source file's own text, and compares that
// value against README.md / docs/setup-and-configuration.md. Nothing here
// is retyped by hand, so a future rename of the constant or the literal
// automatically reddens this file instead of silently going stale.
//
// Scope note (spec /tmp/llm-ext-plan/p6c-b-spec.md): the retired-name
// ABSENCE assertions started out covering README/docs/skills/commands/rules
// only, because P6c-a was concurrently removing the retired names from src.
// P6c-a2a added the src-side half (the last `describe` below) after the merge.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { GENERATED_MARKER } from "./benchmark/pick.js";
import { DEFAULT_PAID_DAILY_CAP_USD } from "./config.js";
import { FREE_TOOL_UNFIT_BASE } from "./dynamic-maintainer.js";
import { FREE_FORBIDDEN_TOOLS } from "./default-profiles.js";
import { CATALOG_TTL_ENV } from "./catalog-cache.js";
import { DISABLE_RECONCILE_ENV } from "./model-reconcile.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");

const README = readFileSync(join(REPO_ROOT, "README.md"), "utf-8");
const CONFIG_GUIDE = readFileSync(
  join(REPO_ROOT, "docs", "setup-and-configuration.md"),
  "utf-8",
);
const DOCS = README + "\n" + CONFIG_GUIDE;

// Non-test src files this file sweeps for prose mentioning selector/notice
// text, so the corpus-wide absence checks are not silently vacuous.
const PROSE_DIRS = [
  join(REPO_ROOT, "README.md"),
  join(REPO_ROOT, "docs"),
  join(REPO_ROOT, "skills"),
  join(REPO_ROOT, "commands"),
  join(REPO_ROOT, "rules"),
];

function walk(path: string, out: string[]): void {
  const st = statSync(path);
  if (st.isDirectory()) {
    for (const entry of readdirSync(path)) walk(join(path, entry), out);
  } else if (path.endsWith(".md")) {
    out.push(path);
  }
}

function proseCorpus(): { path: string; text: string }[] {
  const files: string[] = [];
  for (const p of PROSE_DIRS) walk(p, files);
  expect(files.length).toBeGreaterThan(0); // guard against a vacuous sweep (a rename/move leaving nothing to check)
  return files.map((path) => ({ path, text: readFileSync(path, "utf-8") }));
}

/** Extract the literal string one hop away from `after` in `source`'s text,
 *  so the test derives the value from the actual source bytes rather than
 *  retyping it. Throws (failing loudly) when the anchor moves. */
function extractLiteral(source: string, after: string, pattern: RegExp): string {
  const idx = source.indexOf(after);
  if (idx === -1) throw new Error(`anchor not found: ${after}`);
  const tail = source.slice(idx);
  const m = tail.match(pattern);
  if (!m) throw new Error(`literal not found after anchor: ${after}`);
  return m[0];
}

describe("doc-contract: facts documented in README/configuration-guide must quote exported src constants", () => {
  it("GENERATED_MARKER appears verbatim", () => {
    expect(DOCS).toContain(GENERATED_MARKER);
  });

  it("DEFAULT_PAID_DAILY_CAP_USD formats as 0.50, and the settings key is named", () => {
    expect(DEFAULT_PAID_DAILY_CAP_USD).toBe(0.5);
    const formatted = DEFAULT_PAID_DAILY_CAP_USD.toFixed(2);
    expect(formatted).toBe("0.50");
    expect(DOCS).toContain("`0.50`");
    expect(DOCS).toContain("paid_benchmark_daily_cap_usd");
  });

  it("LLM_EXT_CATALOG_TTL_MS / LLM_EXT_DISABLE_AUTO_RECONCILE env names are documented", () => {
    expect(CATALOG_TTL_ENV).toBe("LLM_EXT_CATALOG_TTL_MS");
    expect(DISABLE_RECONCILE_ENV).toBe("LLM_EXT_DISABLE_AUTO_RECONCILE");
    expect(DOCS).toContain(CATALOG_TTL_ENV);
    expect(DOCS).toContain(DISABLE_RECONCILE_ENV);
  });

  it("LLM_EXT_SETTINGS_LOCK_WAIT_MS (test-only knob) is documented, extracted from pick.ts's own text", () => {
    const pickSrc = readFileSync(join(__dirname, "benchmark", "pick.ts"), "utf-8");
    const envName = extractLiteral(pickSrc, "process.env.", /^process\.env\.([A-Z_]+)/)
      .replace("process.env.", "");
    expect(envName).toBe("LLM_EXT_SETTINGS_LOCK_WAIT_MS");
    expect(DOCS).toContain(envName);
  });

  it("FREE_TOOL_UNFIT_BASE and the hard-forbidden FREE_FORBIDDEN_TOOLS names are documented", () => {
    expect(FREE_TOOL_UNFIT_BASE("mass_scout")).toBe(
      "no free model is fit for mass_scout; use --profile paid",
    );
    // assert the CLAIM (the fixed half of the sentence), not a full string
    // that would also match a coincidentally-similar sentence elsewhere.
    expect(README).toContain("no free model is fit for <tool>; use --profile paid");
    // TRDD-HBCCFOUF: mass_scout / high_quality_scan are fitness-gated now
    // (isFreeForbiddenTool consults freeFitnessUnlocked), not always-refused —
    // the pin counts only the tools the refusal ALWAYS applies to.
    // PT-05 (D34): the mass-scout tools left the list (they take a scouting-type profile); security_scan remains.
    expect(FREE_FORBIDDEN_TOOLS.length).toBe(1);
    for (const tool of FREE_FORBIDDEN_TOOLS) {
      expect(README).toContain(tool);
    }
  });

  it("the 'Effective profile:' label is documented, every static fragment of config.ts's own template checked", () => {
    const configSrc = readFileSync(join(__dirname, "config.ts"), "utf-8");
    const template = extractLiteral(
      configSrc,
      "`Effective profile:",
      /^`Effective profile: [^`]*`/,
    ).replace(/^`|`$/g, "");
    // Split on ${...} interpolations so the assertion is tied to the STATIC
    // wording only (review finding: a prior version of this test extracted
    // `label` but never used it in the assertion below — decorative, not
    // load-bearing. Splitting on every interpolation and requiring EACH
    // non-trivial static fragment in DOCS makes a change to the template's
    // wording (not just its interpolated values) actually fail this test).
    const staticFragments = template
      .split(/\$\{[^}]*\}/)
      .map((s) => s.trim())
      .filter((s) => s.length > 3); // drop bare punctuation left between interpolations
    expect(staticFragments.length).toBeGreaterThan(1); // guard: the split must actually find >=2 fragments
    for (const fragment of staticFragments) {
      expect(DOCS.includes(fragment), `missing static fragment: "${fragment}"`).toBe(true);
    }
  });

  // WHY (TRDD-G6XT3AY9): the "active: notice texts" test used to live here --
  // deleted along with the standalone deprecation-notice module and
  // formatActiveProfileSummary's old deprecation note: `active:` is a live
  // selector again, so there is no deprecation claim left to keep in sync
  // with the docs. Phase 14.1-A-docs adds the new-rule doc assertion once
  // the docs describe it.
  it("retired names are ABSENT from README/docs/skills/commands/rules (CHANGELOG and design/archived excluded)", () => {
    const corpus = proseCorpus();
    for (const { path, text } of corpus) {
      for (const name of RETIRED_NAMES) {
        expect(text.includes(name), `${name} still present in ${path}`).toBe(false);
      }
    }
  });
});

/** The names P6b/P6c retired. Shared by the docs sweep above and the src sweep
 *  below so the two halves cannot drift apart. */
const RETIRED_NAMES = [
  "LLM_EXT_RECONCILE_INTERVAL_MS",
  "LLM_EXT_DISABLE_FREE_POOL_AUTO_BENCH",
  "free-ensemble",
  "paid-ensemble",
  "paid-mass-scout",
  // Retired by P6b-fix S-4: the read-modify-write primitive that caused the
  // lost update. Replaced by the compare-and-set writer; a re-introduction
  // would restore the defect.
  "putDynamicProfileRecord",
] as const;

/** This file lives at the src root, so __dirname IS the tree to sweep. */
const SRC_ROOT = __dirname;

/**
 * The ONE non-test src file allowed to name the retired PROFILE names in live
 * code: pick.ts's migration table (SHIPPED_PLACEHOLDER_SHAPES /
 * RETIRED_PROFILE_NAMES) must spell them out to recognise and delete a legacy
 * section on upgrade. Asserted non-vacuous below — if the migration is ever
 * dropped, this exemption reddens instead of silently widening the sweep.
 */
const MIGRATION_TABLE = join(SRC_ROOT, "benchmark", "pick.ts");
const RETIRED_PROFILE_NAMES = ["free-ensemble", "paid-ensemble", "paid-mass-scout"] as const;

/** Every non-test `.ts` under src/. benchmark-fixtures/ is not under src/ at all
 *  (it sits beside it, deliberately outside the toolchain) so nothing needs
 *  excluding — but the guard below fails loudly if that ever changes. */
function srcFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      expect(entry, "benchmark-fixtures must stay OUTSIDE src/").not.toBe("benchmark-fixtures");
      srcFiles(p, out);
    } else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Drop whole-line comments before the absence sweep, so the assertion means what
 * it claims: NO LIVE CODE names a retired symbol.
 *
 * A deliberately historical comment must stay legal — `model-reconcile.ts` and
 * `default-profiles-state.ts` both explain what was retired and why, and a test
 * that forbade saying so would delete the only record of the decision. Only FULL
 * -line comments are dropped, never a trailing one, so a retired name smuggled
 * onto the end of a real statement still reddens.
 */
function codeLines(text: string): string[] {
  return text.split("\n").filter((line) => {
    const t = line.trim();
    return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("*/"));
  });
}

describe("doc-contract (src side): retired names survive only where a migration must still recognise them", () => {
  it("finds a non-trivial set of non-test src files — the sweep must not be vacuous", () => {
    expect(srcFiles(SRC_ROOT).length).toBeGreaterThan(50);
  });

  it("no LIVE CODE in non-test src names a retired symbol, except pick.ts's migration table", () => {
    for (const path of srcFiles(SRC_ROOT)) {
      const lines = codeLines(readFileSync(path, "utf-8"));
      for (const name of RETIRED_NAMES) {
        const exempt =
          path === MIGRATION_TABLE &&
          (RETIRED_PROFILE_NAMES as readonly string[]).includes(name);
        if (exempt) continue;
        const hits = lines.filter((l) => l.includes(name));
        expect(hits, `${name} is live code in ${path}:\n${hits.join("\n")}`).toEqual([]);
      }
    }
  });

  it("pick.ts's migration table really does still name all three retired profiles — the exemption is not a blank cheque", () => {
    const lines = codeLines(readFileSync(MIGRATION_TABLE, "utf-8"));
    for (const name of RETIRED_PROFILE_NAMES) {
      expect(
        lines.some((l) => l.includes(name)),
        `${name} is gone from the migration table — drop it from the exemption too`,
      ).toBe(true);
    }
  });
});
