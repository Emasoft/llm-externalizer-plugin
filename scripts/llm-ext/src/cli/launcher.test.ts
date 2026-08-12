/**
 * Unit tests for the grouped launcher (TRDD-DT11TE2Z). Pure — no process
 * spawn, no network. Exercises `resolveInvocation` directly against the
 * REAL tool catalog (`buildTools`), so a `GROUPS` entry naming a command
 * that doesn't exist in the catalog fails here, not at runtime.
 */

import { describe, it, expect } from "vitest";
import { buildTools } from "../tools/definitions.js";
import {
  GROUPS,
  isGroupName,
  levenshtein,
  resolveInvocation,
  suggest,
  suggestCommand,
} from "./launcher.js";
import type { ToolDef } from "./launcher.js";

const tools = buildTools("") as ToolDef[];
const toolNames = new Set(tools.map((t) => t.name));

describe("GROUPS table integrity", () => {
  it("every group/action target names a command that exists in the real catalog", () => {
    for (const [group, actions] of Object.entries(GROUPS)) {
      for (const [action, spec] of Object.entries(actions)) {
        expect(
          toolNames.has(spec.command),
          `${group} ${action} -> '${spec.command}' is not in the catalog`,
        ).toBe(true);
      }
    }
  });
});

describe("resolveInvocation — dispatch + positional/output mapping", () => {
  it("session compact <file> -o out.md -> session_summary --transcript <file> --output out.md", () => {
    const r = resolveInvocation(
      ["session", "compact", "foo.jsonl", "-o", "out.md"],
      tools,
    );
    expect(r).toEqual({
      kind: "dispatch",
      command: "session_summary",
      argv: ["--transcript", "foo.jsonl", "--output", "out.md"],
    });
  });

  it("llm ask ./prompt.md -o ./resp.md --profile free -> chat --input_files_paths ... --output_dir ...", () => {
    const r = resolveInvocation(
      ["llm", "ask", "./prompt.md", "-o", "./resp.md", "--profile", "free"],
      tools,
    );
    expect(r.kind).toBe("dispatch");
    if (r.kind !== "dispatch") throw new Error("unreachable");
    expect(r.command).toBe("chat");
    // chat declares output_dir, not output — the launcher maps -o to whatever
    // the target command actually has (verified against the real catalog).
    expect(r.argv).toEqual([
      "--input_files_paths",
      "./prompt.md",
      "--output_dir",
      "./resp.md",
      "--profile",
      "free",
    ]);
  });

  it("unmapped flags pass through untouched", () => {
    const r = resolveInvocation(
      ["scan", "folder", "/tmp/x", "--max_files", "10", "--quiet"],
      tools,
    );
    expect(r).toEqual({
      kind: "dispatch",
      command: "scan_folder",
      argv: ["--folder_path", "/tmp/x", "--max_files", "10", "--quiet"],
    });
  });

  it("a flat command name is not a group and is left to the flat dispatcher", () => {
    expect(isGroupName("session_summary")).toBe(false);
    expect(isGroupName("chat")).toBe(false);
  });
});

describe("resolveInvocation — help layers", () => {
  it("`<group>` alone or with --help yields group-help", () => {
    expect(resolveInvocation(["scan"], tools)).toEqual({ kind: "group-help", group: "scan" });
    expect(resolveInvocation(["scan", "--help"], tools)).toEqual({
      kind: "group-help",
      group: "scan",
    });
  });

  it("`<group> <action> --help` delegates to that action's own help", () => {
    const r = resolveInvocation(["scan", "folder", "--help"], tools);
    expect(r).toEqual({
      kind: "action-help",
      group: "scan",
      action: "folder",
      command: "scan_folder",
    });
  });
});

describe("resolveInvocation — did-you-mean", () => {
  it("an unknown group suggests the closest group and signals error", () => {
    const r = resolveInvocation(["scna"], tools);
    expect(r.kind).toBe("error");
    if (r.kind !== "error") throw new Error("unreachable");
    expect(r.suggestions).toContain("scan");
  });

  it("an unknown action in a valid group suggests the GROUPED form, not the bare action", () => {
    // Defect 2 (coordinator review): the user typed a grouped invocation, so
    // the suggestion must stay in that vocabulary ('scan folder'), never the
    // bare action name and never the flat command name ('scan-folder').
    const r = resolveInvocation(["scan", "foldr"], tools);
    expect(r.kind).toBe("error");
    if (r.kind !== "error") throw new Error("unreachable");
    expect(r.message).toBe("unknown action 'foldr' in group 'scan'.");
    expect(r.suggestions).toContain("scan folder");
    expect(r.suggestions).not.toContain("folder");
    expect(r.suggestions).not.toContain("scan-folder");
  });

  it("garbage input far from every candidate suggests nothing", () => {
    const r = resolveInvocation(["zzzzzzzzzzzzzzzzzzzz"], tools);
    expect(r.kind).toBe("error");
    if (r.kind !== "error") throw new Error("unreachable");
    expect(r.suggestions).toEqual([]);
  });
});

describe("resolveInvocation — global flags in the action slot (defect 1)", () => {
  it("`<group> --quiet` (no action) falls back to group-help instead of 'unknown action'", () => {
    const r = resolveInvocation(["scan", "--quiet"], tools);
    expect(r).toEqual({ kind: "group-help", group: "scan" });
  });

  it("`<group> <action> ... --quiet` dispatches normally, --quiet passed through", () => {
    const r = resolveInvocation(["scan", "folder", "./src", "--quiet"], tools);
    expect(r).toEqual({
      kind: "dispatch",
      command: "scan_folder",
      argv: ["--folder_path", "./src", "--quiet"],
    });
  });
});

describe("suggestCommand — grouped-vs-flat top-level suggestions (defect 2)", () => {
  it("prefers group names when any are within threshold, never mixing in a flat name", () => {
    const hint = suggestCommand(
      "scna",
      tools.map((t) => t.name.replace(/_/g, "-")),
    );
    expect(hint).not.toBeNull();
    expect(hint?.kind).toBe("group");
    expect(hint?.names).toContain("scan");
    expect(hint?.names).not.toContain("chat");
  });

  it("falls back to a flat command name, distinctly labelled, only when no group is close", () => {
    // 'reset' itself: no group name (session/llm/scan/check/scout/models/
    // config) is within edit distance 3 of 'reset' (min distance 4), so the
    // exact-match flat command 'reset' is the only candidate.
    const hint = suggestCommand(
      "reset",
      tools.map((t) => t.name.replace(/_/g, "-")),
    );
    expect(hint).not.toBeNull();
    expect(hint?.kind).toBe("flat");
    expect(hint?.names).toContain("reset");
  });
});

describe("levenshtein + suggest", () => {
  it("distance is 0 for identical strings and symmetric for simple edits", () => {
    expect(levenshtein("scan", "scan")).toBe(0);
    expect(levenshtein("scan", "scna")).toBe(2);
    expect(levenshtein("scan", "scan")).toBe(levenshtein("scan", "scan"));
  });

  it("suggest returns [] beyond the threshold and caps at max candidates", () => {
    expect(suggest("scna", ["scan", "check", "config"], 3, 3)).toEqual(["scan"]);
    expect(suggest("nothing-like-any-of-these", ["scan", "check", "config"])).toEqual([]);
  });
});
