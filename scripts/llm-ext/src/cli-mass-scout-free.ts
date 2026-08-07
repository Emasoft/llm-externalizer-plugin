/**
 * mass-scout / security-scan free-mode pre-flight for the legacy
 * `dist/cli.js` entry point (TRDD-W9DK4L3N).
 *
 * The legacy CLI (`src/cli.ts`) forwards `mass-scout` and `security-scan`
 * straight to `runMassScoutCli` — the exact function the supported `llm-ext`
 * catalog dispatch (`dispatchCallToolInner` in index.ts) also calls, so the
 * LLM dispatch itself was never duplicated. What WAS missing on the legacy
 * path is the pre-flight step index.ts runs first:
 * `resolveMassScoutFreeModelOverride` decides whether auto-free (low
 * balance / a prior 402) should substitute a ':free' model. `injectMassScoutFreeModel`
 * below consults the SAME exported function before the legacy CLI ever
 * forwards to `runMassScoutCli`, closing the gap without a second copy of
 * the balance/engagement logic.
 *
 * Isolated in its own side-effect-free module (rather than living inline in
 * `cli.ts`) so it is unit-testable without loading `cli.ts` itself — that
 * file's top-level code invokes `main()` against `process.argv` on import,
 * which would make importing it from a test run the whole CLI.
 */

import { resolveMassScoutFreeModelOverride } from "./index.js";

/** Resolves the ':free' model to substitute for `requestedModel`, or
 *  `undefined` to leave it untouched. Defaults to the real
 *  `resolveMassScoutFreeModelOverride`; tests inject a stub instead of
 *  mocking `./index.js`. */
export type FreeModelResolver = (
  requestedModel: string,
) => Promise<string | undefined>;

/** Parse `--key value` / `--key=value` pairs from argv into a Record. Bare
 *  `--flag` (no value, or the next token is itself a flag) becomes "true". */
export function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx !== -1) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else {
        const key = arg.slice(2);
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = "true";
        }
      }
    }
  }
  return flags;
}

/** Only these `mass-scout` sub-commands accept a model / spend money;
 *  everything else (list/get/export/etc.) is read-only-ish and must stay a
 *  zero-network-call path, exactly as it was before this file existed. */
export const MASS_SCOUT_MODEL_AWARE_SUBS: ReadonlySet<string> = new Set([
  "register",
  "estimate",
  "scout",
  "propose-fieldset",
  "chain",
  "security-scan",
]);

/** Replace (or append) a `--flag value` / `--flag=value` pair in a raw argv
 *  array, returning a NEW array — everything else the user passed is left
 *  byte-for-byte untouched. */
export function setFlagValue(
  argv: string[],
  flagName: string,
  value: string,
): string[] {
  const out = [...argv];
  const eqPrefix = `--${flagName}=`;
  for (let i = 0; i < out.length; i++) {
    if (out[i] === `--${flagName}`) {
      if (i + 1 < out.length && !out[i + 1].startsWith("--")) {
        out[i + 1] = value;
      } else {
        out.splice(i + 1, 0, value);
      }
      return out;
    }
    if (out[i].startsWith(eqPrefix)) {
      out[i] = `${eqPrefix}${value}`;
      return out;
    }
  }
  return [...out, `--${flagName}`, value];
}

/**
 * Given the raw argv for `mass-scout <sub> ...` (`sub === "security-scan"`
 * included), consult `resolveOverride` and, if it wants to substitute a free
 * model, inject it — as `--model <id>` for the flag-shaped sub-commands, or
 * into the `--input-json` payload's `model` key for `security-scan` (whose
 * model lives inside the JSON blob, not a flag). Returns argv UNCHANGED for
 * every other sub-command, or when free mode is not engaged — so this never
 * introduces a network call on the read-only sub-commands, and never
 * changes output for a funded profile.
 */
export async function injectMassScoutFreeModel(
  argv: string[],
  resolveOverride: FreeModelResolver = resolveMassScoutFreeModelOverride,
): Promise<string[]> {
  const sub = argv[0];
  if (!MASS_SCOUT_MODEL_AWARE_SUBS.has(sub ?? "")) return argv;
  const rest = argv.slice(1);

  if (sub === "security-scan") {
    const flags = parseFlags(rest);
    const rawInputJson = flags["input-json"];
    if (!rawInputJson || rawInputJson === "true") return argv; // let the real
    // handler's own requireFlag() report the missing-flag error.
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawInputJson);
    } catch {
      return argv; // malformed JSON — let runSecurityScanCli's own parser report it
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return argv;
    }
    const obj = parsed as Record<string, unknown>;
    const currentModel = typeof obj.model === "string" ? obj.model : "";
    const override = await resolveOverride(currentModel);
    if (override === undefined) return argv;
    obj.model = override;
    return [sub, ...setFlagValue(rest, "input-json", JSON.stringify(obj))];
  }

  const flags = parseFlags(rest);
  const currentModel =
    flags["model"] && flags["model"] !== "true" ? flags["model"] : "";
  const override = await resolveOverride(currentModel);
  if (override === undefined) return argv;
  return [sub, ...setFlagValue(rest, "model", override)];
}
