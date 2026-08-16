// The launcher's native-deps location.
//
// This is the address every caller — interactive session, skill, cron job,
// detached daemon — must agree on. It used to be derived from the launcher's
// own position inside the plugin CACHE, which made it invisible to headless
// callers: they had to guess, and a wrong guess installs a second native
// module into a directory nothing else reads. These tests pin the address to
// the user-owned config root so that class of bug cannot come back.

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The launcher chain is plain ESM .mjs (it runs before the bundle exists).
import { configDir, nativeDepsDir } from "../data-dir.mjs";

describe("configDir", () => {
  it("defaults to ~/.llm-externalizer", () => {
    expect(configDir({} as NodeJS.ProcessEnv)).toBe(join(homedir(), ".llm-externalizer"));
  });

  it("honours LLM_EXT_CONFIG_DIR, matching getConfigDir() in src/config.ts", () => {
    const env = { LLM_EXT_CONFIG_DIR: "/tmp/llm-ext-cfg" } as NodeJS.ProcessEnv;
    expect(configDir(env)).toBe(resolve("/tmp/llm-ext-cfg"));
  });

  it("treats a whitespace-only override as unset", () => {
    // `LLM_EXT_CONFIG_DIR=" "` is truthy in a shell test; installing into a
    // directory literally named " " would be silent and unfindable.
    const env = { LLM_EXT_CONFIG_DIR: "   " } as NodeJS.ProcessEnv;
    expect(configDir(env)).toBe(join(homedir(), ".llm-externalizer"));
  });

  it("returns an absolute path for a relative override", () => {
    const env = { LLM_EXT_CONFIG_DIR: "relative/cfg" } as NodeJS.ProcessEnv;
    expect(configDir(env)).toBe(resolve("relative/cfg"));
  });
});

describe("nativeDepsDir", () => {
  it("is a subdirectory of the config root, never the root itself", () => {
    // node_modules and a copied package.json are machine-generated build
    // output; they must not land beside the user's hand-edited settings.yaml.
    const env = { LLM_EXT_CONFIG_DIR: "/tmp/llm-ext-cfg" } as NodeJS.ProcessEnv;
    expect(nativeDepsDir(env)).toBe(join(resolve("/tmp/llm-ext-cfg"), "native"));
  });

  it("defaults under ~/.llm-externalizer", () => {
    expect(nativeDepsDir({} as NodeJS.ProcessEnv)).toBe(
      join(homedir(), ".llm-externalizer", "native"),
    );
  });

  it("does not depend on CLAUDE_PLUGIN_DATA or on the plugin cache path", () => {
    // The whole point: a hook- or daemon-spawned child has neither of these,
    // and must still resolve the same directory as an interactive session.
    const withPluginEnv = {
      CLAUDE_PLUGIN_DATA: "/somewhere/plugins/data/llm-externalizer-emasoft-plugins",
    } as NodeJS.ProcessEnv;
    expect(nativeDepsDir(withPluginEnv)).toBe(nativeDepsDir({} as NodeJS.ProcessEnv));
  });
});
