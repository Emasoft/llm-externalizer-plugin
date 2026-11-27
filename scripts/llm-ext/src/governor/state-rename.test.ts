// TRDD-2VZ3JGDH: renameReplacing retries a Windows sharing violation on the governor state file.
// WHY an injected rename: an EPERM from a rename over an open file happens only on Windows and cannot be produced on
// macOS or Linux, so these tests pass a rename that fails the way Windows does; the real renameSync path runs in
// governor.test.ts on every platform.
import { describe, expect, it } from "vitest";
import { RENAME_RETRY_MS, renameReplacing } from "./state.js";

/** A rename that throws `code` on its first `times` calls, then succeeds. */
function failing(code: string, times: number): { rename: (from: string, to: string) => void; calls: () => number } {
  let n = 0;
  return {
    rename: () => {
      n++;
      if (n <= times) throw Object.assign(new Error(`${code}: simulated rename failure`), { code });
    },
    calls: () => n,
  };
}

describe("renameReplacing (TRDD-2VZ3JGDH)", () => {
  it("on win32 retries EPERM until the rename succeeds", () => {
    const r = failing("EPERM", 2);
    renameReplacing("a.tmp", "a", r.rename, "win32");
    expect(r.calls()).toBe(3);
  });

  it("on darwin throws EPERM on the first call", () => {
    const r = failing("EPERM", 1);
    expect(() => renameReplacing("a.tmp", "a", r.rename, "darwin")).toThrow(/EPERM/);
    expect(r.calls()).toBe(1);
  });

  it("on win32 throws an error that is not a sharing violation, such as ENOENT, on the first call", () => {
    const r = failing("ENOENT", 1);
    expect(() => renameReplacing("a.tmp", "a", r.rename, "win32")).toThrow(/ENOENT/);
    expect(r.calls()).toBe(1);
  });

  it("on win32 gives up on an EPERM that never clears after about RENAME_RETRY_MS", () => {
    const r = failing("EPERM", Number.MAX_SAFE_INTEGER);
    const t0 = Date.now();
    expect(() => renameReplacing("a.tmp", "a", r.rename, "win32")).toThrow(/EPERM/);
    const took = Date.now() - t0;
    expect(r.calls()).toBeGreaterThan(1);
    // The loop stops once the next wait (at most 50 ms) would pass the deadline, so it gives up after 450 ms or more.
    expect(took).toBeGreaterThanOrEqual(RENAME_RETRY_MS - 60);
    expect(took).toBeLessThan(RENAME_RETRY_MS * 4);
  });
});
