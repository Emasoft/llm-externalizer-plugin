// Plan §3 L2-16, D10, E52: the `-o` JSON report. The text is what renderEnvelope returns, so stdout and the file are the same JSON.
import { accessSync, constants, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { defaultOutputDir } from "../../project-root.js";

// Same shape as index.ts canonicalTimestamp (not exported there; importing index.ts would boot the CLI): %Y%m%d_%H%M%S%z, local time.
function timestamp(d: Date): string {
  const p = (n: number): string => String(Math.abs(n)).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${off >= 0 ? "+" : "-"}${p(Math.floor(Math.abs(off) / 60))}${p(Math.abs(off) % 60)}`;
}

/** E52: resolve and create the report directory, and prove it is writable. Call it BEFORE the first API request so a bad `-o` costs nothing. */
export function prepareReportDir(outputDir: string | undefined): string {
  const dir = outputDir || defaultOutputDir();
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
  } catch (e) {
    throw new Error(`cannot write report directory ${dir}: ${(e as Error).message}`, { cause: e });
  }
  return dir;
}

/** WHY temp + rename: a reader (or a crash) never sees a half-written file; the temp file is removed if the rename fails. */
export function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, text, "utf-8");
  try {
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Writes `text` to `<dir>/<timestamp>-<decision>-<id>.json` and returns the path. */
export function writeReport(dir: string, decision: string, text: string): string {
  // WHY: `decision` becomes part of the file name; "a/b" or ".." would write outside `dir`. Same rule as spec ids (catalog/index.ts:14, regex not exported).
  if (!/^[a-z][a-z0-9-]*$/.test(decision)) throw new Error(`report decision must be lowercase kebab-case, got "${decision}"`);
  const id = randomUUID().slice(0, 6); // WHY: two reports in one second must not overwrite each other
  const path = join(dir, `${timestamp(new Date())}-${decision}-${id}.json`);
  writeAtomic(path, text);
  return path;
}
