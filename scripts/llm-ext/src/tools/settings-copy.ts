/**
 * `settings show` copy writer (TRDD-BYHR8EGG). WHY: the copy is made "for manual editing", yet it was rewritten with
 * writeFileSync on every `settings show`, so a copy the user was editing (or a different config dir shown into the
 * same output dir) was silently replaced and the edits lost. A copy whose bytes differ from what is about to be written
 * is therefore renamed to settings_edit.<YYYYMMDD_HHMMSS±HHMM>.yaml first; an identical copy is rewritten in place.
 * A rename failure, or a stamped name that is already taken (same-second collision), throws: no fallback, because the
 * alternative is overwriting the very bytes this function exists to keep.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatLocalTimestamp } from "../config.js";

export interface SettingsCopyResult {
  copyPath: string;
  /** Set only when a differing earlier copy was renamed out of the way. */
  keptPath?: string;
}

export function writeSettingsCopy(targetDir: string, raw: string, now: Date = new Date()): SettingsCopyResult {
  const copyPath = join(targetDir, "settings_edit.yaml");
  let keptPath: string | undefined;
  if (existsSync(copyPath) && !readFileSync(copyPath).equals(Buffer.from(raw, "utf-8"))) {
    keptPath = join(targetDir, `settings_edit.${formatLocalTimestamp(now)}.yaml`);
    if (existsSync(keptPath)) {
      throw new Error(`cannot keep the existing copy: ${keptPath} already exists`);
    }
    renameSync(copyPath, keptPath);
  }
  writeFileSync(copyPath, raw, "utf-8");
  return keptPath === undefined ? { copyPath } : { copyPath, keptPath };
}
