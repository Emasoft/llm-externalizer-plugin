import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadDecisionsCatalog } from "../l0/catalog.js";
import { resolveModel } from "../l0/model.js";
import { replayFetch, type RecordedReply } from "../l0/test-fetch.js";
import { isServedBuildOf, parseSnapshot } from "./model-id.js";

const fixture = (dir: string, n: string): RecordedReply => JSON.parse(readFileSync(new URL(`../__fixtures__/${dir}/${n}.json`, import.meta.url), "utf-8"));
// The served build exactly as a real 200 reply reports it in its model field (plan §7 Snapshot).
const servedBuild = (): string => (JSON.parse(fixture("p01", "dec-noul").body) as { model: string }).model;
const load = () => loadDecisionsCatalog({ fetch: replayFetch([fixture("p02", "models-decisions")]).fetch, now: 1_800_000_000_000, path: join(mkdtempSync("/tmp/llm-ext-l1-model-id-"), "decisions.json") });

describe("parseSnapshot", () => {
  it("a real reply served build splits into its base model and its dated stamp", () => {
    expect(parseSnapshot(servedBuild())).toEqual({ family: "typesafe/jev-1.13", date: "20260917" });
  });

  it("a pinned id with no stamp is its own family with no date", () => {
    expect(parseSnapshot("typesafe/jev-1.13")).toEqual({ family: "typesafe/jev-1.13", date: null });
  });
});

describe("isServedBuildOf", () => {
  it("a real reply served for the alias belongs to the alias target", async () => {
    expect(isServedBuildOf(servedBuild(), resolveModel("~typesafe/jev-latest", await load()))).toBe(true);
  });

  it("a newer dated build of the same target still belongs (E47: a move is a warning, not a refusal)", async () => {
    expect(isServedBuildOf("typesafe/jev-1.13-20261101", resolveModel("~typesafe/jev-latest", await load()))).toBe(true);
  });

  it("a build of another model does not belong, and is not an error (E11)", async () => {
    expect(isServedBuildOf("typesafe/jev-1.14-20261101", resolveModel("~typesafe/jev-latest", await load()))).toBe(false);
  });
});
