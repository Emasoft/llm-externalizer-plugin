// Proves the legacy `dist/cli.js` mass-scout / security-scan path CONSULTS
// the auto-free decision (TRDD-W9DK4L3N). `injectMassScoutFreeModel` is the
// exact function `src/cli.ts` calls before forwarding to `runMassScoutCli`;
// a fake `resolveOverride` stands in for `resolveMassScoutFreeModelOverride`
// (the same function `index.ts`'s dispatchCallToolInner calls for the
// supported `llm-ext` surface) so this test exercises the LEGACY call site's
// wiring without needing a real OpenRouter balance probe.

import { describe, it, expect, vi } from "vitest";
import {
  injectMassScoutFreeModel,
  setFlagValue,
  parseFlags,
  MASS_SCOUT_MODEL_AWARE_SUBS,
} from "./cli-mass-scout-free";

describe("injectMassScoutFreeModel — legacy CLI consults the shared auto-free decision", () => {
  it("calls the resolver with the caller's current --model and injects the free model returned", async () => {
    const resolveOverride = vi.fn(async (requestedModel: string) => {
      expect(requestedModel).toBe(""); // no --model passed
      return "poolside/laguna-m.1:free";
    });
    const argv = ["scout", "--db", "/tmp/db.sqlite"];
    const out = await injectMassScoutFreeModel(argv, resolveOverride);
    expect(resolveOverride).toHaveBeenCalledTimes(1);
    expect(out).toEqual([
      "scout",
      "--db",
      "/tmp/db.sqlite",
      "--model",
      "poolside/laguna-m.1:free",
    ]);
  });

  it("overrides an explicit paid --model when the resolver engages free mode (cost-safety)", async () => {
    const resolveOverride = vi.fn(async (requestedModel: string) => {
      expect(requestedModel).toBe("deepseek/deepseek-v4-pro");
      return "poolside/laguna-m.1:free";
    });
    const argv = ["scout", "--model", "deepseek/deepseek-v4-pro"];
    const out = await injectMassScoutFreeModel(argv, resolveOverride);
    expect(out).toEqual(["scout", "--model", "poolside/laguna-m.1:free"]);
  });

  it("leaves argv byte-for-byte untouched when the resolver reports free mode is off", async () => {
    const resolveOverride = vi.fn(async () => undefined);
    const argv = ["scout", "--db", "/tmp/db.sqlite"];
    const out = await injectMassScoutFreeModel(argv, resolveOverride);
    expect(resolveOverride).toHaveBeenCalledTimes(1);
    expect(out).toEqual(argv);
  });

  it("never consults the resolver (zero network calls) for a non-model sub-command", async () => {
    const resolveOverride = vi.fn(async () => "poolside/laguna-m.1:free");
    for (const sub of ["list-bundled-fieldsets", "get", "export", "jobs-list"]) {
      expect(MASS_SCOUT_MODEL_AWARE_SUBS.has(sub)).toBe(false);
      const argv = [sub, "--db", "/tmp/db.sqlite"];
      const out = await injectMassScoutFreeModel(argv, resolveOverride);
      expect(out).toEqual(argv);
    }
    expect(resolveOverride).not.toHaveBeenCalled();
  });

  it("security-scan: injects the free model into the --input-json payload's model key", async () => {
    const resolveOverride = vi.fn(async (requestedModel: string) => {
      expect(requestedModel).toBe(""); // input-json carried no model
      return "poolside/laguna-m.1:free";
    });
    const inputJson = JSON.stringify({ targets: ["/repo/a.ts"] });
    const argv = ["security-scan", "--input-json", inputJson];
    const out = await injectMassScoutFreeModel(argv, resolveOverride);
    const flags = parseFlags(out.slice(1));
    expect(JSON.parse(flags["input-json"])).toEqual({
      targets: ["/repo/a.ts"],
      model: "poolside/laguna-m.1:free",
    });
  });

  it("security-scan: an already-:free requested model is reported to the resolver, which may leave it untouched", async () => {
    const resolveOverride = vi.fn(async (requestedModel: string) => {
      expect(requestedModel).toBe("z-ai/glm-4.5-air:free");
      return undefined; // resolver's own "already free" rule
    });
    const inputJson = JSON.stringify({
      targets: ["/repo/a.ts"],
      model: "z-ai/glm-4.5-air:free",
    });
    const argv = ["security-scan", "--input-json", inputJson];
    const out = await injectMassScoutFreeModel(argv, resolveOverride);
    expect(out).toEqual(argv);
  });

  it("security-scan: a missing --input-json is left for runSecurityScanCli's own error, resolver not consulted", async () => {
    const resolveOverride = vi.fn(async () => "poolside/laguna-m.1:free");
    const argv = ["security-scan"];
    const out = await injectMassScoutFreeModel(argv, resolveOverride);
    expect(out).toEqual(argv);
    expect(resolveOverride).not.toHaveBeenCalled();
  });
});

describe("setFlagValue — pure argv mutation used by the injector", () => {
  it("appends the flag when absent", () => {
    expect(setFlagValue(["--db", "x"], "model", "m")).toEqual([
      "--db",
      "x",
      "--model",
      "m",
    ]);
  });

  it("replaces an existing `--flag value` pair", () => {
    expect(setFlagValue(["--model", "old", "--db", "x"], "model", "new")).toEqual(
      ["--model", "new", "--db", "x"],
    );
  });

  it("replaces an existing `--flag=value` pair", () => {
    expect(setFlagValue(["--model=old", "--db", "x"], "model", "new")).toEqual([
      "--model=new",
      "--db",
      "x",
    ]);
  });
});
