import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Atomically write `json` to `<dir>/<fileName>` with the same guards the statusline puts on that directory
 * (scripts/statusline/statusline.py ensure_cache_dir, CWE-59): refuse a symlinked directory, open it with no-follow,
 * refuse one owned by another uid, and open the temp file with no-follow. Throws on any refusal; the caller decides
 * whether that is silent (the CLI stats file must never break a command, TRDD-B07E5M93).
 *
 * WHY: on a shared host another local user who creates /tmp/claude first (or plants a symlink there) would otherwise
 * receive our stats, and the statusline would then refuse the directory so the CLI row goes empty with no error.
 * The check order matters: lstat BEFORE mkdir (mkdir -p follows a symlink silently), then the no-follow open closes
 * the swap window between the check and the use.
 */
export function writeStatsJsonGuarded(dir: string, fileName: string, json: string): void {
  if (process.platform === "win32") {
    // The statusline applies no guards on Windows either (per-user temp dir, no uid model).
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, fileName + ".tmp");
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, json);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, join(dir, fileName));
    return;
  }

  let lst: ReturnType<typeof lstatSync> | null = null;
  try {
    lst = lstatSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (lst?.isSymbolicLink()) {
    throw new Error(`Stats directory ${dir} is a symlink; refusing to follow.`);
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const dirFd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const uid = process.getuid!();
    const owner = fstatSync(dirFd).uid;
    if (owner !== uid) {
      throw new Error(`Stats directory ${dir} is owned by uid ${owner}, not the current user (uid ${uid}); refusing an untrusted directory.`);
    }
    fchmodSync(dirFd, 0o700);
  } finally {
    closeSync(dirFd);
  }

  // Temp file + rename so a reader never sees a partial file; O_NOFOLLOW so a planted symlink at the temp name
  // cannot divert the write. rename() replaces a symlink at the final name instead of following it.
  const tmp = join(dir, fileName + ".tmp");
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, json);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, join(dir, fileName));
}
