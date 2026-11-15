/**
 * TRDD-4HRFC42S: under vitest, config.ts must refuse to resolve the config dir to the REAL
 * ~/.llm-externalizer (the 2026-11-11 settings.yaml loss). The helper is called directly with
 * an env object, so the real directory is only compared, never read or written.
 */
import { userInfo } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertNotRealConfigDirUnderTest } from "./config.js";

const realDir = join(userInfo().homedir, ".llm-externalizer");

describe("assertNotRealConfigDirUnderTest (TRDD-4HRFC42S)", () => {
  it("throws, naming the dir, when VITEST is set and the dir is the real ~/.llm-externalizer", () => {
    expect(() => assertNotRealConfigDirUnderTest(realDir, { VITEST: "true" })).toThrow(
      new RegExp(`${realDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*LLM_EXT_CONFIG_DIR`),
    );
  });

  it("does not throw for a /tmp dir when VITEST is set", () => {
    expect(() => assertNotRealConfigDirUnderTest("/tmp/cfgiso-guard-test", { VITEST: "true" })).not.toThrow();
  });

  it("does not throw for the real dir when VITEST is absent", () => {
    expect(() => assertNotRealConfigDirUnderTest(realDir, {})).not.toThrow();
  });
});
