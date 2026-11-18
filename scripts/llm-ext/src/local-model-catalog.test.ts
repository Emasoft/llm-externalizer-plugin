// WHY: the local model catalog has no runtime consumer yet (TRDD-R7NKAJ5B), so this test is what keeps it in step with the
// built-in local profiles (config.ts builtinLocalProfiles) and with the models table in the CLI reference docs.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { SERVED_MODEL } from "./classifiers/l2/local-decider.js";
import { builtinLocalProfiles } from "./config.js";
import { LOCAL_MODEL_CATALOG } from "./local-model-catalog.js";

const DOCS_PATH = fileURLToPath(new URL("../../../skills/llm-externalizer-cli-reference/references/models-and-settings.md", import.meta.url));

const RUNTIME_OF_API: Record<string, string> = { "llamacpp-local": "llama.cpp", "locals-local": "mlx-locals" };

describe("local model catalog", () => {
  it("has an entry for every model of every built-in local profile, runnable by that profile engine", () => {
    for (const { name, profile } of builtinLocalProfiles()) {
      const fields = profile as unknown as Record<string, string>;
      const runtime = RUNTIME_OF_API[fields.api];
      if (runtime === undefined) throw new Error(`profile ${name} has api ${fields.api}, which the catalog test does not know`);
      for (const field of ["model", "second_model", "third_model"]) {
        const id = fields[field];
        const entry = LOCAL_MODEL_CATALOG.find((candidate) => candidate.id === id);
        expect(entry, `${name}.${field} = ${id}`).toBeDefined();
        expect(entry?.role, `${name}.${field} role`).toBe("chat");
        expect(entry?.unsupportedReason, `${name}.${field} unsupportedReason`).toBeUndefined();
        expect(entry?.runtime, `${name}.${field} runtime`).toBe(runtime);
      }
    }
  });

  it("lists the served decider model as a decider on the mlx-decision runtime", () => {
    const entry = LOCAL_MODEL_CATALOG.find((candidate) => candidate.role === "decider" && candidate.id === SERVED_MODEL);
    expect(entry, `a decider entry with id ${SERVED_MODEL}`).toBeDefined();
    expect(entry?.role).toBe("decider");
    expect(entry?.runtime).toBe("mlx-decision");
  });

  it("has unique ids", () => {
    const ids = LOCAL_MODEL_CATALOG.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("carries sizeBytes exactly when it names a repo, and a projector size exactly when it names an mmproj", () => {
    for (const entry of LOCAL_MODEL_CATALOG) {
      expect(entry.sizeBytes !== undefined, `${entry.id} sizeBytes vs repo`).toBe(entry.repo !== undefined);
      expect(entry.sizeBytes?.mmproj !== undefined, `${entry.id} sizeBytes.mmproj vs mmproj`).toBe(entry.mmproj !== undefined);
    }
  });

  it("appears, every id, in the models table of the CLI reference docs", () => {
    expect(existsSync(DOCS_PATH), `docs file missing: ${DOCS_PATH}`).toBe(true);
    const docs = readFileSync(DOCS_PATH, "utf8");
    // A row must START with the id cell: a bare substring test would pass "elephant-1" on the "baselabs/elephant-1" row.
    // The same row must carry the catalog refusals and size cells, so a hand-edited docs figure cannot drift from the catalog.
    const lines = docs.split("\n");
    for (const entry of LOCAL_MODEL_CATALOG) {
      expect(
        lines.some((line) => line.startsWith(`| \`${entry.id}\` |`)),
        `docs table has no row starting with | \`${entry.id}\` |`,
      ).toBe(true);
      const row = lines.find((line) => line.startsWith(`| \`${entry.id}\` |`)) ?? "";
      const size = entry.sizeBytes
        ? entry.sizeBytes.mmproj !== undefined
          ? `${entry.sizeBytes.weights} + ${entry.sizeBytes.mmproj}`
          : `${entry.sizeBytes.weights}`
        : "not known (served by mlx-decision)";
      expect(row, `docs row of ${entry.id}: size cell`).toContain(`| ${size} |`);
      expect(row, `docs row of ${entry.id}: refusals cell`).toContain(`| ${entry.abliterated ? "yes" : "no"} |`);
    }
  });
});
