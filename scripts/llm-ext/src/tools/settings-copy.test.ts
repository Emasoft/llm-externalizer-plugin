// TRDD-BYHR8EGG: writeSettingsCopy keeps a differing settings_edit.yaml under a stamped name and rewrites an identical one. Real files in a real temp dir under /tmp; no doubles.
import { describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeSettingsCopy } from "./settings-copy.js";

const STAMPED = /^settings_edit\.\d{8}_\d{6}[+-]\d{4}\.yaml$/;

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync("/tmp/settings-copy-test-");
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("writeSettingsCopy", () => {
  it("writes the first copy with no stamped file", () => {
    withTempDir((dir) => {
      const result = writeSettingsCopy(dir, "a: 1\n");
      expect(result.keptPath).toBeUndefined();
      expect(readFileSync(join(dir, "settings_edit.yaml"), "utf-8")).toBe("a: 1\n");
      expect(readdirSync(dir)).toEqual(["settings_edit.yaml"]);
    });
  });

  it("keeps a differing copy under a stamped name and writes the new one", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, "settings_edit.yaml"), "edited: by-user\n", "utf-8");
      const result = writeSettingsCopy(dir, "a: 1\n");
      expect(result.copyPath).toBe(join(dir, "settings_edit.yaml"));
      expect(result.keptPath).toBeDefined();
      const keptName = readdirSync(dir).filter((n) => n !== "settings_edit.yaml");
      expect(keptName).toHaveLength(1);
      expect(keptName[0]).toMatch(STAMPED);
      expect(result.keptPath).toBe(join(dir, keptName[0]!));
      expect(readFileSync(result.keptPath!, "utf-8")).toBe("edited: by-user\n");
      expect(readFileSync(result.copyPath, "utf-8")).toBe("a: 1\n");
    });
  });

  it("rewrites an identical copy in place with no stamped file", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, "settings_edit.yaml"), "a: 1\n", "utf-8");
      const result = writeSettingsCopy(dir, "a: 1\n");
      expect(result.keptPath).toBeUndefined();
      expect(readdirSync(dir)).toEqual(["settings_edit.yaml"]);
      expect(readFileSync(result.copyPath, "utf-8")).toBe("a: 1\n");
    });
  });

  // Windows ignores POSIX directory mode bits, so the read-only directory cannot make rename fail there (TRDD-61EINA10 tracks Windows test gaps).
  it.skipIf(process.platform === "win32")("throws on a rename failure (read-only directory) and leaves the edited copy untouched", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, "settings_edit.yaml"), "edited: by-user\n", "utf-8");
      chmodSync(dir, 0o555); // real filesystem condition: rename needs write permission on the directory
      try {
        expect(() => writeSettingsCopy(dir, "a: 1\n")).toThrow(/EACCES|EPERM/);
      } finally {
        chmodSync(dir, 0o755);
      }
      expect(readdirSync(dir)).toEqual(["settings_edit.yaml"]);
      expect(readFileSync(join(dir, "settings_edit.yaml"), "utf-8")).toBe("edited: by-user\n");
    });
  });

  it("throws and leaves the edited copy untouched when the stamped name is already taken", () => {
    withTempDir((dir) => {
      const now = new Date(2026, 10, 18, 12, 0, 0);
      writeFileSync(join(dir, "settings_edit.yaml"), "edited: by-user\n", "utf-8");
      writeSettingsCopy(dir, "a: 1\n", now); // keeps "edited" under the stamp for `now`
      writeFileSync(join(dir, "settings_edit.yaml"), "edited: again\n", "utf-8");
      expect(() => writeSettingsCopy(dir, "a: 1\n", now)).toThrow(/already exists/);
      expect(readFileSync(join(dir, "settings_edit.yaml"), "utf-8")).toBe("edited: again\n");
      expect(existsSync(join(dir, "settings_edit.yaml"))).toBe(true);
    });
  });
});
