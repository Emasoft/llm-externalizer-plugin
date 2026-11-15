/**
 * governor/settings.ts — the governor settings of this process (design/specs/local-inference-governor-design.md D13):
 * env over the `local_governor` section of settings.yaml over the defaults, through resolveConfig. The file is read
 * again whenever its mtime, size or inode changes, so every caller (a broker on its 1 s tick and at each pump, a
 * waiter at each poll) sees an edit at its next call, without a watcher; an unchanged file costs one stat.
 */

import { readFileSync, statSync } from "node:fs";
import { parse as yamlParse } from "yaml";
import { getSettingsPath, localGovernorErrors } from "../config.js";
import { GovernorConfigError, resolveConfig, type GovernorConfig, type LocalGovernorSection } from "./controller.js";
import { coreCount } from "./metrics.js";

interface Parsed {
  section: LocalGovernorSection | null;
  error: GovernorConfigError | null;
}

let cached: (Parsed & { path: string; stamp: string }) | null = null;

/**
 * Not loadSettings: it reads a broken file as "no settings" with a warning, and the governor must fail fast instead
 * (a typo in a limit is never read as the default). The error is cached with the file stamp, so a broken file is
 * parsed once, and reported at every call until it changes.
 */
function parseSection(path: string): Parsed {
  try {
    const doc = yamlParse(readFileSync(path, "utf-8")) as unknown;
    const raw = doc !== null && typeof doc === "object" ? (doc as Record<string, unknown>).local_governor : undefined;
    const errors = localGovernorErrors(raw);
    if (errors.length > 0) return { section: null, error: new GovernorConfigError(`${path}: ${errors.join("; ")}`) };
    return { section: (raw ?? null) as LocalGovernorSection | null, error: null };
  } catch (err) {
    return { section: null, error: new GovernorConfigError(`cannot read the local_governor settings in ${path}: ${(err as Error).message}`, { cause: err }) };
  }
}

function sectionAt(path: string): LocalGovernorSection | null {
  let stamp: string;
  try {
    const st = statSync(path);
    // Review m3, a stated limit: on a filesystem with coarse mtimes (HFS+, FAT, some network mounts: 1 to 2 s), a rewrite
    // of the same size within one mtime tick keeps the stamp, so it is seen only at the next edit. APFS and ext4 stamp in
    // nanoseconds. Not hashed on every call: the unchanged file must cost one stat (the module comment).
    // mode is in the stamp because a chmod that fixes an EACCES (parseSection cached the error) does not change mtime,
    // size or inode, so without it the governor stays stuck on the cached error until the file is touched.
    stamp = `${st.mtimeMs}:${st.size}:${st.ino}:${st.mode}`;
  } catch (err) {
    // No settings.yaml is the defaults, as for every other setting; anything else (EACCES, ENOTDIR) is an error.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new GovernorConfigError(`cannot read ${path}: ${(err as Error).message}`, { cause: err });
  }
  if (cached?.path !== path || cached.stamp !== stamp) cached = { path, stamp, ...parseSection(path) };
  if (cached.error) throw cached.error;
  return cached.section;
}

/**
 * The governor settings in force now. Throws a GovernorConfigError on a malformed value (fail fast). No env parameter:
 * the settings path and the test-only ram_limit_pct minimum are read from process.env, so one passed here would be
 * half-applied (review nit).
 */
export function governorConfig(): GovernorConfig {
  const path = getSettingsPath();
  return resolveConfig(process.env, sectionAt(path), coreCount(), path);
}

/**
 * The free memory calibration keeps, in percent of RAM: what ram_limit_pct leaves. Unit 6 replaced the broker's own
 * floor variable with it, so calibration and the governor use one limit; the default is ram_limit_pct 80, 20 % free
 * (the old broker floor default was 10 %, ram_limit_pct 90, before the 2026-11-01 owner directive). One limit, not one
 * reading: on darwin both read the same figure, but off darwin calibration measures free memory with os.freemem (MemFree on
 * Linux, which excludes the page cache) while the governor reads MemTotal - MemAvailable, so there calibration sees less
 * free RAM than the governor.
 */
export function freeFloorPct(): number {
  return 100 - governorConfig().limits.ramLimitPct;
}
