/**
 * mass-scout CLI dispatcher — invoked by `bin/llm-externalizer mass-scout
 * <subcommand>`. Each sub-command is a thin wrapper that wires CLI flags
 * to a `mass_scouting/*.ts` module and prints the result (or writes a
 * report file and prints its path).
 *
 * Sub-commands:
 *   register       — walk a folder (or take explicit paths) and register
 *                    every file into the SQLite registry.
 *   preclassify    — run the cheap script-only file classifier.
 *   estimate       — compute cost / token / time / cap-skipped numbers
 *                    for a given fieldset against the registered files.
 *                    Honors --budget-usd as a hard gate.
 *   scout          — actually call OpenRouter on every eligible file
 *                    with the compiled JSON Schema. Writes a markdown
 *                    report under reports/mass_scouting/.
 *   search         — per-job search (FTS5 + structured + regex bypass).
 *   search-xjob    — cross-job federated search.
 *   get            — pretty-print a single file's row by short_id.
 *   export         — dump every result row of a job to JSONL or CSV.
 *
 * Returns a `CliResult` rather than calling `process.exit` directly so
 * the function is unit-testable. The host shim in `src/cli.ts` plumbs
 * the result through to stdout/stderr and sets the exit code.
 */

import { execSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { compileFieldset, parseFieldset, type ScoutFieldset } from "./fieldset";
import { parseShorthand } from "./shorthand";
import {
  KNOWN_PRICING,
  bytesCapFromPct,
  checkBudget,
  estimateJobCost,
  fetchProviderContext,
  type ModelPricing,
} from "./cost-estimate";
import { openRegistry, type Registry } from "./registry";
import { preclassifyAll } from "./preclassify";
import { runScoutJob, type FetchImpl } from "./scout";
import {
  massScoutSearch,
  massScoutSearchXjob,
  type SearchFilter,
  type SearchResponse,
  type XjobSearchResponse,
} from "./search";
import { renderMarkdownReport, summariseJob } from "./reports";
import { runSecurityScan } from "../security_scan/security_scan_main";
import { DEFAULT_MODEL } from "../security_scan/types";
import {
  loadSettings,
  resolveProfile,
  resolveModelForTool,
  assertFreeOnlyModel,
  getActiveFreeOnly,
} from "../config";
import type { OpenRouterModel } from "../benchmark/discover";
import {
  rotationJournalMark,
  rotationJournalSince,
  withFreeRotation,
} from "../free-rotation";
import { assertModelValidated } from "../benchmark/validated.js";
import { resolveProjectMainRoot } from "../project-root";

// ── Public types ───────────────────────────────────────────────────────

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CliRunOptions {
  /** Override the real fetch (tests inject a mock). */
  fetchImpl?: FetchImpl;
  /** Override the resolved API key (tests inject a stub). */
  apiKey?: string;
  /** Override the main-repo root for report paths (tests use tmpdir). */
  mainRoot?: string;
  /**
   * Optional progress callback. When supplied (typically by the MCP
   * dispatcher when the client passed a progressToken), long-running
   * sub-commands like `scout` and `chain` invoke it periodically with
   * `(progress, total, message?)` so the MCP client receives
   * notifications/progress events that keep the connection alive.
   */
  onProgress?: (progress: number, total: number, message?: string) => void;
  /**
   * Override the OpenRouter model-catalog fetcher (tests inject a stub so the
   * `assess_model` dispatch stays offline). Default hits the public catalog.
   */
  modelCatalogFetch?: () => Promise<OpenRouterModel[]>;
}

// ── Defaults ───────────────────────────────────────────────────────────

/** Directory names we never descend into when walking a --root. */
const DEFAULT_SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".venv",
  "dist",
  "build",
  ".idea",
  ".vscode",
  "tmp",
  "vendor",
  ".next",
  ".cache",
  "__pycache__",
  "target",
  ".turbo",
  "out",
]);

// ── Helpers ────────────────────────────────────────────────────────────

/** Parse `--key value` and `--key=value` from argv. Repeated keys win-last. */
function parseFlags(args: string[]): { flags: Record<string, string>; positional: string[] } {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq !== -1) {
      flags[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const key = a.slice(2);
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = "true";
    }
  }
  return { flags, positional };
}

/**
 * The model a mass_scout CLI command should use. free_only (TRDD-97ef8b63)
 * overrides EVERY customized choice: under a free_only active profile the free
 * pool's top model wins over `--model` and DEFAULT_MODEL, so mass_scout actually
 * RUNS on a free model instead of throwing at the cost-safety guard. Non-free
 * profiles keep the exact prior behaviour (`--model` else DEFAULT_MODEL).
 */
function resolveCliModel(flags: Record<string, string>): string {
  if (getActiveFreeOnly()) {
    try {
      const s = loadSettings();
      const active = s?.profiles[s.active];
      if (s && active) {
        const r = resolveProfile(s.active, active);
        if (r.model) return r.model; // free_models[0] (validated ':free')
      }
    } catch {
      /* settings unreadable — fall through; the guard still blocks paid spend */
    }
  }
  return flags["model"] ?? DEFAULT_MODEL;
}

function requireFlag(
  flags: Record<string, string>,
  name: string,
  hint = "",
): string | { error: string } {
  const v = flags[name];
  if (v === undefined || v === "" || v === "true") {
    return { error: `--${name} is required${hint ? ` (${hint})` : ""}` };
  }
  return v;
}

function err(text: string): CliResult {
  return { stdout: "", stderr: `Error: ${text}\n`, exitCode: 1 };
}

function ok(stdout: string): CliResult {
  return { stdout: stdout.endsWith("\n") ? stdout : `${stdout}\n`, stderr: "", exitCode: 0 };
}

/**
 * Resolve the main repo root used to anchor `reports/mass_scouting/` writes.
 *
 * Resolution order, designed so a packaged MCP server never writes reports
 * into its own install cache:
 *   1. `CLAUDE_PROJECT_DIR` — Claude Code 2.1.139+ sets this in the
 *      MCP-stdio environment (officially documented in that release). It
 *      is the only signal that points at the user's project rather than
 *      the plugin install.
 *   2. `git worktree list` — the enclosing repo, UNLESS that path is inside
 *      a plugin install cache (`/.claude/plugins/`), which means we are the
 *      packaged server with no project context.
 *   3. `process.cwd()` — last resort for a direct CLI run outside a repo.
 *
 * The previous "walk up three dirs from this source file" fallback is gone:
 * for an installed plugin it resolved straight into the plugin cache, which
 * is exactly the bug this ordering fixes.
 */
function defaultMainRoot(): string {
  // Single source of truth — see project-root.ts (CLAUDE_PROJECT_DIR verbatim →
  // cwd; no git).
  return resolveProjectMainRoot();
}

/**
 * Resolve the directory a report / export file is written to. An explicit
 * `--output-dir` wins verbatim (a relative value resolves against cwd);
 * otherwise the file lands under `<main-repo-root>/reports/mass_scouting/`.
 * Callers running as an MCP server should pass `--output-dir` so the report
 * lands inside the project the agent is actually working on.
 */
function resolveReportDir(
  outputDirFlag: string | undefined,
  opts: CliRunOptions,
): string {
  if (outputDirFlag && outputDirFlag !== "true") {
    return isAbsolute(outputDirFlag)
      ? outputDirFlag
      : resolve(process.cwd(), outputDirFlag);
  }
  const mainRoot = opts.mainRoot ?? defaultMainRoot();
  return join(mainRoot, "reports", "mass_scouting");
}

/**
 * Run `git diff --name-only --diff-filter=ACMR <ref>...HEAD` rooted at
 * `root`. Returns the absolute paths of files that have been added,
 * copied, modified, or renamed (D-deletions intentionally excluded —
 * deleted files have no body to scout). Returns `null` when not inside a
 * git repo, when git is not on PATH, or when `ref` doesn't resolve.
 */
function listGitChangedFiles(root: string, ref: string): string[] | null {
  // Validate ref shape — protect against shell-injection-style refs.
  // Allow: alphanumerics, `_`, `-`, `.`, `/`, `~`, `^`, `@{}`. Reject everything else.
  if (!/^[A-Za-z0-9_./~^@{}-]+$/.test(ref) || ref.length > 200) {
    return null;
  }
  try {
    const out = execSync(
      `git diff --name-only --diff-filter=ACMR -z ${JSON.stringify(ref)}...HEAD`,
      { cwd: root, encoding: "buffer", stdio: ["ignore", "pipe", "ignore"] },
    );
    const rel = out
      .toString("utf-8")
      .split("\0")
      .filter((s) => s.length > 0);
    return rel.map((p) => resolve(root, p));
  } catch {
    return null;
  }
}

/**
 * Run `git ls-files --cached --others --exclude-standard` rooted at `root`.
 * Returns absolute paths or `null` when not inside a git repo (or git not
 * on PATH). The flags include tracked AND untracked-but-not-ignored files,
 * which is the correct "what's not gitignored" semantic.
 */
function listGitTrackedFiles(root: string): string[] | null {
  try {
    const out = execSync(
      "git ls-files --cached --others --exclude-standard -z",
      { cwd: root, encoding: "buffer", stdio: ["ignore", "pipe", "ignore"] },
    );
    // -z output is NUL-separated (no shell-quoting issues).
    const rel = out
      .toString("utf-8")
      .split("\0")
      .filter((s) => s.length > 0);
    return rel.map((p) => resolve(root, p));
  } catch {
    return null;
  }
}

/** Mirror of the dir-skip predicate used inside walkFiles. */
function walkFilesShouldSkip(absPath: string, extraSkip?: Set<string>): boolean {
  const skip = new Set([...DEFAULT_SKIP_DIRS, ...(extraSkip ?? [])]);
  const segments = absPath.split(/[/\\]/);
  for (const seg of segments) {
    if (skip.has(seg)) return true;
  }
  return false;
}

/** Recursively list every file under `root`, skipping default dirs + caller's. */
function walkFiles(
  root: string,
  extensionFilter?: Set<string>,
  extraSkipDirs?: Set<string>,
): string[] {
  const skip = new Set([...DEFAULT_SKIP_DIRS, ...(extraSkipDirs ?? [])]);
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(dir, e);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (skip.has(e)) continue;
        stack.push(full);
      } else if (st.isFile()) {
        if (extensionFilter && !extensionFilter.has(extname(full).toLowerCase())) continue;
        out.push(full);
      }
    }
  }
  out.sort();
  return out;
}

/**
 * Resolve a `bundled:<name>` shorthand to a path under the plugin-shipped
 * `fieldsets/` directory next to the cli.js bundle. Returns null when the
 * arg is not a bundled shorthand, or an error string when the named
 * fieldset doesn't exist (so the caller can give a clean error message).
 */
function resolveBundledFieldset(
  arg: string,
): { path: string } | { error: string } | null {
  if (!arg.startsWith("bundled:")) return null;
  const name = arg.slice("bundled:".length).trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    return {
      error: `invalid bundled fieldset name ${JSON.stringify(name)}; allowed: [a-zA-Z0-9_-]`,
    };
  }
  // dist/cli.js → ../fieldsets/<name>.json
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "..", "fieldsets", `${name}.json`),
    resolve(here, "fieldsets", `${name}.json`),
    resolve(here, "..", "..", "fieldsets", `${name}.json`),
  ];
  for (const p of candidates) {
    try {
      readFileSync(p, "utf-8");
      return { path: p };
    } catch {
      // try next candidate
    }
  }
  return {
    error: `bundled fieldset ${JSON.stringify(name)} not found; tried: ${candidates.join(", ")}`,
  };
}

function loadFieldsetFromArg(path: string): ScoutFieldset | { error: string } {
  // Honor the `bundled:<name>` shorthand so callers can avoid hand-writing
  // a fieldset for common scout shapes (code-audit / skill-audit / etc.).
  const bundled = resolveBundledFieldset(path);
  if (bundled !== null) {
    if ("error" in bundled) return { error: bundled.error };
    path = bundled.path;
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (e) {
    return { error: `cannot read --fields-file: ${(e as Error).message}` };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    return { error: `--fields-file is not valid JSON: ${(e as Error).message}` };
  }
  try {
    return parseFieldset(json);
  } catch (e) {
    return { error: `fieldset validation failed: ${(e as Error).message}` };
  }
}

/**
 * Build a `ModelPricing` from CLI flags. Falls back to KNOWN_PRICING entry
 * for the active model. Returns an error string when neither is available.
 */
function resolvePricing(
  model: string,
  flags: Record<string, string>,
): ModelPricing | { error: string } {
  const known = KNOWN_PRICING[model];
  const inP = flags["input-price-per-m"];
  const outP = flags["output-price-per-m"];
  const ctx = flags["context-window"];
  if (inP || outP || ctx) {
    if (!inP || !outP || !ctx) {
      return {
        error:
          "--input-price-per-m, --output-price-per-m, and --context-window must all be supplied together",
      };
    }
    const ip = Number(inP);
    const op = Number(outP);
    const cw = Number(ctx);
    if (!Number.isFinite(ip) || !Number.isFinite(op) || !Number.isFinite(cw)) {
      return { error: "pricing flags must be finite numbers" };
    }
    return {
      input_per_m_usd: ip,
      output_per_m_usd: op,
      context_window: cw,
    };
  }
  if (!known) {
    return {
      error: `no pricing for model ${JSON.stringify(model)}. Pass --input-price-per-m, --output-price-per-m, --context-window.`,
    };
  }
  return known;
}

/** Parse a structured-filter token: `$.path:OP:value`. Returns one filter. */
function parseFilterToken(token: string): SearchFilter | { error: string } {
  // Path may contain ':' (e.g. "$.foo:bar") so split on the FIRST two ':'
  // that delimit path:op:value. Path runs up to first ':OP:' where OP is
  // one of the allowed operators.
  const ALLOWED = new Set([">=", "<=", "!=", "=", ">", "<", "LIKE"]);
  // Try each operator from longest to shortest so '>=' matches before '>'.
  const ops = [">=", "<=", "!=", "LIKE", "=", ">", "<"] as const;
  for (const op of ops) {
    // Look for `:OP:` boundary inside the token.
    const sep = `:${op}:`;
    const idx = token.indexOf(sep);
    if (idx === -1) continue;
    const path = token.slice(0, idx);
    const valueStr = token.slice(idx + sep.length);
    if (!ALLOWED.has(op)) continue;
    // Parse value: try number, true/false/null, else string.
    let value: SearchFilter["value"];
    if (valueStr === "true") value = true;
    else if (valueStr === "false") value = false;
    else if (valueStr === "null") value = null;
    else if (/^-?\d+(\.\d+)?$/.test(valueStr)) value = Number(valueStr);
    else value = valueStr;
    return { path, op: op as SearchFilter["op"], value };
  }
  return {
    error: `--filter ${JSON.stringify(token)} must look like '$.path:OP:value' where OP is one of =, !=, >, >=, <, <=, LIKE`,
  };
}

// ── Real-fetch adapter ─────────────────────────────────────────────────

const rawFetch: FetchImpl = async (url, init) => {
  const res = await fetch(url, init);
  return {
    ok: res.ok,
    status: res.status,
    json: () => res.json() as Promise<unknown>,
    text: () => res.text(),
  };
};

/**
 * The production adapter, with free-model rotation baked in — mass_scout is the
 * heaviest free-tier consumer in the tool (one call per file, thousands of files),
 * so it is the likeliest thing in the codebase to meet a free model's DAILY cap
 * mid-job. Without rotation that cap simply ends the job: every remaining file
 * exhausts its retry budget against the same spent model.
 *
 * Wrapping the adapter — rather than threading a model choice through scout.ts's
 * worker pool — leaves the pipeline, the retries, and the resume/checkpoint logic
 * untouched, and covers all four of this file's send sites at once.
 * Under a paid profile the wrapper is a straight pass-through; tests inject their
 * own fetchImpl and never see it.
 */
const realFetch: FetchImpl = withFreeRotation(rawFetch);

/**
 * fetchProviderContext expects a slimmer fetcher signature than scout's
 * FetchImpl (no body, no signal). This adapter wraps a FetchImpl so it
 * satisfies the GET-only call the cost-estimate helper makes — the body
 * field is filled with an empty string and signal is omitted, matching
 * a real GET request.
 */
function adaptFetchForContext(
  impl: FetchImpl,
): (
  url: string,
  init: { method: string; headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }> {
  return (url, init) =>
    impl(url, {
      method: init.method,
      headers: init.headers,
      body: "",
    });
}

// ── Sub-commands ───────────────────────────────────────────────────────

/**
 * register — walk --root (or take --files) and write each file into the
 * registry as a single transaction. Prints counters.
 */
function runRegister(args: string[]): CliResult {
  const { flags } = parseFlags(args);
  const dbPath = requireFlag(flags, "db");
  if (typeof dbPath === "object") return err(dbPath.error);

  const root = flags["root"];
  const filesArg = flags["files"];
  const gitDiff = flags["git-diff"];
  if (!root && !filesArg) {
    return err("either --root <folder> or --files <a,b,c> is required");
  }
  if (root && filesArg) {
    return err("--root and --files are mutually exclusive");
  }
  if (gitDiff && !root) {
    return err("--git-diff requires --root <folder> (the repo root)");
  }

  let paths: string[];
  if (filesArg) {
    paths = filesArg.split(",").map((p) => p.trim()).filter(Boolean);
  } else {
    const extFilter = flags["extensions"]
      ? new Set(
          flags["extensions"]
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
            .map((s) => (s.startsWith(".") ? s : `.${s}`))
            .map((s) => s.toLowerCase()),
        )
      : undefined;
    const extraSkip = flags["exclude-dirs"]
      ? new Set(flags["exclude-dirs"].split(",").map((s) => s.trim()).filter(Boolean))
      : undefined;
    // TRDD §15 Q5: when inside a git repo, default to honouring .gitignore
    // (use `git ls-files` for the truth, then apply extension/skip-dir
    // filters on top). `--no-gitignore` disables it. `--files` always
    // bypasses the walk entirely.
    const useGitignore = flags["no-gitignore"] !== "true";
    let walked = walkFiles(root!, extFilter, extraSkip);
    // --git-diff REF: replace the walk with files changed since REF.
    // Used for incremental scouting (PR review, CI pre-flight).
    if (gitDiff) {
      const changed = listGitChangedFiles(root!, gitDiff);
      if (changed === null) {
        return err(
          `--git-diff ${JSON.stringify(gitDiff)} failed: not a git repo, or git not on PATH, or ref not found`,
        );
      }
      const changedSet = new Set(changed);
      walked = walked.filter((p) => changedSet.has(p));
      // If the walk filter killed everything, fall back to the unfiltered
      // changed list (with extension + skip-dir filters re-applied).
      if (walked.length === 0 && changed.length > 0) {
        walked = changed.filter(
          (p) =>
            (extFilter === undefined ||
              extFilter.has(extname(p).toLowerCase())) &&
            !walkFilesShouldSkip(p, extraSkip),
        );
      }
    }
    if (useGitignore) {
      const tracked = listGitTrackedFiles(root!);
      if (tracked !== null) {
        const trackedSet = new Set(tracked);
        const dropped = walked.length;
        walked = walked.filter((p) => trackedSet.has(p));
        // If the filter killed everything but git ls-files returned files,
        // it means walked-paths and tracked-paths are using inconsistent
        // canonicalisation; fall back to the unfiltered walk so the user
        // doesn't get silent zero-matches. (Belt + braces.)
        if (walked.length === 0 && tracked.length > 0 && dropped > 0) {
          walked = tracked.filter(
            (p) =>
              (extFilter === undefined ||
                extFilter.has(extname(p).toLowerCase())) &&
              !walkFilesShouldSkip(p, extraSkip),
          );
        }
      }
    }
    paths = walked;
  }
  if (paths.length === 0) {
    return ok("registered=0  no files matched");
  }

  // Resolve per-file size cap from optional --model.
  const model = resolveCliModel(flags);
  const pricing = resolvePricing(model, flags);
  if ("error" in pricing) return err(pricing.error);
  const registerCap = bytesCapFromPct(
    pricing.context_window,
    Number(flags["max-context-pct-register"] ?? 0.5),
  );

  const reg = openRegistry({ path: dbPath });
  let registered = 0;
  let already = 0;
  let skippedTooBig = 0;
  let skippedRead = 0;
  for (const p of paths) {
    let body: Buffer;
    try {
      body = readFileSync(p);
    } catch {
      skippedRead++;
      continue;
    }
    if (body.length > registerCap) {
      reg.recordSkipped({
        file_path: p,
        reason: `body_bytes ${body.length} > register cap ${registerCap}`,
        phase: "register",
        size_bytes: body.length,
      });
      skippedTooBig++;
      continue;
    }
    const out = reg.registerFile({
      file_path: isAbsolute(p) ? p : resolve(p),
      source_root: root ?? dirname(p),
      body,
      registered_via: filesArg ? "explicit" : "folder",
    });
    if (out.already_registered) already++;
    else registered++;
  }
  reg.close();

  return ok(
    [
      `db=${dbPath}`,
      `registered=${registered}`,
      `already_registered=${already}`,
      `skipped_too_big=${skippedTooBig}`,
      `skipped_read_error=${skippedRead}`,
      `total_paths=${paths.length}`,
    ].join("  "),
  );
}

/**
 * preclassify — run the script-only classifier across every unclassified
 * registered file. Prints by-bucket counters.
 */
function runPreclassify(args: string[]): CliResult {
  const { flags } = parseFlags(args);
  const dbPath = requireFlag(flags, "db");
  if (typeof dbPath === "object") return err(dbPath.error);
  const reg = openRegistry({ path: dbPath });
  const result = preclassifyAll(reg, {
    reclassify: flags["reclassify"] === "true",
    limit: flags["limit"] ? Number(flags["limit"]) : undefined,
  });
  reg.close();
  const buckets = Object.entries(result.by_bucket)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k}=${n}`)
    .join(", ");
  return ok(
    [
      `total=${result.total}`,
      `classified=${result.classified}`,
      `skipped_already=${result.skipped_already}`,
      `no_body=${result.no_body}`,
      buckets ? `by_bucket: ${buckets}` : "by_bucket: (none)",
    ].join("\n"),
  );
}

/**
 * estimate — compute cost / time / eligibility for a fieldset against the
 * registered files. With --budget-usd, refuses ("would exceed budget").
 *
 * `--live-context` queries OpenRouter for the actual provider's
 * `context_length` (the smallest endpoint cap) and overrides
 * `pricing.context_window`. The architectural ceiling baked into
 * KNOWN_PRICING is the model's MAX, not the provider's cap — providers
 * commonly route to endpoints with a smaller cap (32K vs 128K). When the
 * flag is set we'll fail-fast if the live cap can't be fetched, rather
 * than silently use a too-large value.
 */
async function runEstimate(
  args: string[],
  opts: CliRunOptions = {},
): Promise<CliResult> {
  const { flags } = parseFlags(args);
  const dbPath = requireFlag(flags, "db");
  if (typeof dbPath === "object") return err(dbPath.error);
  const fieldsFile = requireFlag(flags, "fields-file");
  if (typeof fieldsFile === "object") return err(fieldsFile.error);

  const fs = loadFieldsetFromArg(fieldsFile);
  if ("error" in fs) return err(fs.error);

  const model = resolveCliModel(flags);
  const pricing = resolvePricing(model, flags);
  if ("error" in pricing) return err(pricing.error);

  // Live context-window override — opt-in. Only fires when --live-context
  // is set AND we have an API key; otherwise we trust pricing.context_window.
  if (flags["live-context"] === "true") {
    const apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return err(
        "--live-context requires OPENROUTER_API_KEY (export it or pass via opts.apiKey).",
      );
    }
    const live = await fetchProviderContext(
      model,
      apiKey,
      adaptFetchForContext(opts.fetchImpl ?? realFetch),
    );
    if (live === null) {
      return err(
        `--live-context: could not fetch context_length for model ${JSON.stringify(model)} from OpenRouter.`,
      );
    }
    pricing.context_window = live;
  }

  const compiled = compileFieldset(fs);
  const promptBytes = Buffer.byteLength(compiled.systemPrompt, "utf-8");
  const schemaBytes = Buffer.byteLength(JSON.stringify(compiled.jsonSchema), "utf-8");
  const expectedOutputBytes = Number(flags["expected-output-bytes"] ?? 200);

  const reg = openRegistry({ path: dbPath });
  const est = estimateJobCost(reg, {
    pricing,
    prompt_overhead_bytes: promptBytes,
    schema_overhead_bytes: schemaBytes,
    expected_output_bytes: expectedOutputBytes,
    bucket: flags["bucket"],
    worker_count: flags["workers"] ? Number(flags["workers"]) : undefined,
    per_call_seconds: flags["per-call-seconds"] ? Number(flags["per-call-seconds"]) : undefined,
    max_context_pct_scout: flags["max-context-pct-scout"]
      ? Number(flags["max-context-pct-scout"])
      : undefined,
    max_context_pct_register: flags["max-context-pct-register"]
      ? Number(flags["max-context-pct-register"])
      : undefined,
  });
  reg.close();

  const budgetStr = flags["budget-usd"];
  const budget = budgetStr ? Number(budgetStr) : null;
  const gate = checkBudget(est.est_cost_usd, budget);

  const lines = [
    `model=${model}  context_window=${pricing.context_window}`,
    `files_eligible=${est.files_eligible}`,
    `files_skipped_too_big=${est.files_skipped_too_big}`,
    `files_over_register_cap=${est.files_over_register_cap}`,
    `total_input_tokens=${est.total_input_tokens}`,
    `total_output_tokens=${est.total_output_tokens}`,
    `est_cost_usd=$${est.est_cost_usd.toFixed(6)}`,
    `est_seconds=${est.est_seconds}`,
    `budget_usd=${budget == null ? "(none)" : `$${budget.toFixed(4)}`}`,
    `budget_allowed=${gate.allowed}`,
  ];
  if (!gate.allowed && gate.reason) lines.push(`reason=${gate.reason}`);
  if (est.by_bucket.length > 0) {
    lines.push("by_bucket:");
    for (const b of est.by_bucket) {
      lines.push(
        `  ${b.bucket}  files=${b.files}  in=${b.input_tokens}  out=${b.output_tokens}  cost=$${b.cost_usd.toFixed(6)}`,
      );
    }
  }
  return ok(lines.join("\n"));
}

/**
 * scout — fan out OpenRouter calls. On success, generates a markdown
 * report under <main-root>/reports/mass_scouting/ and prints the path.
 */
async function runScout(
  args: string[],
  opts: CliRunOptions,
): Promise<CliResult> {
  const { flags } = parseFlags(args);
  const dbPath = requireFlag(flags, "db");
  if (typeof dbPath === "object") return err(dbPath.error);
  const fieldsFile = requireFlag(flags, "fields-file");
  if (typeof fieldsFile === "object") return err(fieldsFile.error);
  const jobId = requireFlag(flags, "job-id");
  if (typeof jobId === "object") return err(jobId.error);
  const sourceRoot = requireFlag(flags, "source-root");
  if (typeof sourceRoot === "object") return err(sourceRoot.error);

  const fs = loadFieldsetFromArg(fieldsFile);
  if ("error" in fs) return err(fs.error);

  const model = resolveCliModel(flags);
  const pricing = resolvePricing(model, flags);
  if ("error" in pricing) return err(pricing.error);

  const apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return err(
      "OPENROUTER_API_KEY missing. Export it in your shell, set the plugin's userConfig.openrouter_api_key, or add it to ~/.llm-externalizer/settings.yaml.",
    );
  }
  const fetchImpl = opts.fetchImpl ?? realFetch;
  // Mark the rotation send-log before any request, so the report can tell which
  // free models actually answered if the adapter rotated during this job.
  const rotationMark = rotationJournalMark();

  // Live context-window override — opt-in; same semantics as estimate.
  // Wired here too so a one-shot `scout` (without a preceding `estimate`)
  // also gets the real provider cap when the caller asks for it.
  if (flags["live-context"] === "true") {
    const live = await fetchProviderContext(
      model,
      apiKey,
      adaptFetchForContext(fetchImpl),
    );
    if (live === null) {
      return err(
        `--live-context: could not fetch context_length for model ${JSON.stringify(model)} from OpenRouter.`,
      );
    }
    pricing.context_window = live;
  }

  const reg = openRegistry({ path: dbPath });
  let result;
  try {
    result = await runScoutJob(
      reg,
      {
        jobId,
        fieldset: fs,
        pricing,
        model,
        apiKey,
        workers: flags["workers"] ? Number(flags["workers"]) : undefined,
        maxRetries: flags["max-retries"] ? Number(flags["max-retries"]) : undefined,
        bucket: flags["bucket"],
        smokeTest: flags["no-smoke-test"] !== "true",
        resume: flags["no-resume"] !== "true",
        sourceRoot,
        maxContextPctScout: flags["max-context-pct-scout"]
          ? Number(flags["max-context-pct-scout"])
          : undefined,
        budgetUsd: flags["budget-usd"] ? Number(flags["budget-usd"]) : undefined,
        consecutiveFailureLimit: flags["consecutive-failure-limit"]
          ? Number(flags["consecutive-failure-limit"])
          : undefined,
        perCallTimeoutMs: flags["per-call-timeout-ms"]
          ? Number(flags["per-call-timeout-ms"])
          : undefined,
        // Forward MCP progress callback when supplied. scout.ts already
        // calls this per-file; the dispatcher in mcp-tools.ts passes a
        // wrapper that fires `notifications/progress` to the MCP client.
        onProgress: opts.onProgress
          ? (done, total) =>
              opts.onProgress?.(
                done,
                total,
                `scout: ${done}/${total} files`,
              )
          : undefined,
      },
      fetchImpl,
    );
  } catch (e) {
    reg.close();
    return err(`scout failed: ${(e as Error).message}`);
  }

  // Render markdown report and write to canonical path. Under free mode the
  // fetch adapter may have rotated off `model` mid-job (a per-file job is the
  // likeliest thing here to meet a free model's daily cap), so the report names
  // every model that actually answered rather than only the one we asked for.
  const summary = summariseJob(reg, jobId);
  const rotated = rotationJournalSince(rotationMark);
  if (rotated.length > 1 || (rotated.length === 1 && rotated[0] !== summary.model)) {
    summary.models_used = rotated;
  }
  const md = renderMarkdownReport(summary);
  reg.close();

  const reportDir = resolveReportDir(flags["output-dir"], opts);
  mkdirSync(reportDir, { recursive: true });
  const stamp = isoTimestampLocal();
  const reportPath = join(reportDir, `${stamp}-scout-${slugify(jobId)}.md`);
  writeFileSync(reportPath, md, "utf-8");

  return ok(
    [
      `job_id=${jobId}`,
      `files_total=${result.filesTotal}`,
      `files_ok=${result.filesOk}`,
      `files_failed=${result.filesFailed}`,
      `files_skipped_too_big=${result.filesSkippedTooBig}`,
      `retries=${result.retries}`,
      `cost_usd=$${result.costUsd.toFixed(6)}`,
      result.circuitTripped ? `circuit_tripped=true` : `circuit_tripped=false`,
      `report=${reportPath}`,
    ].join("\n"),
  );
}

/**
 * search — per-job search. Prints hits as JSON when --json is passed,
 * otherwise a human-readable table.
 */
function runSearch(args: string[]): CliResult {
  const { flags } = parseFlags(args);
  const dbPath = requireFlag(flags, "db");
  if (typeof dbPath === "object") return err(dbPath.error);
  const jobId = requireFlag(flags, "job-id");
  if (typeof jobId === "object") return err(jobId.error);

  // Filters: --filter '$.path:OP:value' (repeatable via comma-OR-list).
  // Parse comma-separated filters or a single value.
  const filters: SearchFilter[] = [];
  const filterRaw = flags["filter"];
  if (filterRaw) {
    for (const tok of filterRaw.split(",,").map((s) => s.trim())) {
      if (!tok) continue;
      const f = parseFilterToken(tok);
      if ("error" in f) return err(f.error);
      filters.push(f);
    }
  }

  const reg = openRegistry({ path: dbPath });
  let res: SearchResponse;
  try {
    res = massScoutSearch(reg, {
      jobId,
      query: flags["query"],
      regex: flags["regex"],
      forceLlm: flags["force-llm"] === "true",
      forceRegex: flags["force-regex"] === "true",
      filters,
      limit: flags["limit"] ? Number(flags["limit"]) : undefined,
      offset: flags["offset"] ? Number(flags["offset"]) : undefined,
    });
  } catch (e) {
    reg.close();
    return err((e as Error).message);
  }
  reg.close();

  if (flags["json"] === "true") {
    return ok(JSON.stringify(res, null, 2));
  }
  return ok(formatSearchTable(res));
}

/** search-xjob — same as search but federates across multiple jobs. */
function runSearchXjob(args: string[]): CliResult {
  const { flags } = parseFlags(args);
  const dbPath = requireFlag(flags, "db");
  if (typeof dbPath === "object") return err(dbPath.error);
  const jobIdsRaw = requireFlag(flags, "job-ids");
  if (typeof jobIdsRaw === "object") return err(jobIdsRaw.error);
  const jobIds = jobIdsRaw.split(",").map((s) => s.trim()).filter(Boolean);
  if (jobIds.length === 0) return err("--job-ids must list at least one job");

  const filters: SearchFilter[] = [];
  const filterRaw = flags["filter"];
  if (filterRaw) {
    for (const tok of filterRaw.split(",,").map((s) => s.trim())) {
      if (!tok) continue;
      const f = parseFilterToken(tok);
      if ("error" in f) return err(f.error);
      filters.push(f);
    }
  }

  const reg = openRegistry({ path: dbPath });
  let res: XjobSearchResponse;
  try {
    res = massScoutSearchXjob(reg, {
      jobIds,
      query: flags["query"],
      regex: flags["regex"],
      forceLlm: flags["force-llm"] === "true",
      forceRegex: flags["force-regex"] === "true",
      filters,
      limitPerJob: flags["limit-per-job"] ? Number(flags["limit-per-job"]) : undefined,
      limitMerged: flags["limit-merged"] ? Number(flags["limit-merged"]) : undefined,
    });
  } catch (e) {
    reg.close();
    return err((e as Error).message);
  }
  reg.close();

  if (flags["json"] === "true") {
    return ok(JSON.stringify(res, null, 2));
  }
  const lines = [
    `mode=${res.mode}  jobs=${res.jobIds.join(",")}  total_examined=${res.total_examined}`,
    `hits=${res.hits.length}`,
    "",
    ...res.hits.slice(0, 50).map(
      (h) =>
        `[${h.job_id}] ${h.short_id} ${h.file_path}` +
        (h.snippet ? ` :: ${h.snippet}` : ""),
    ),
  ];
  return ok(lines.join("\n"));
}

/** get — print one row by short_id. */
function runGet(args: string[]): CliResult {
  const { flags } = parseFlags(args);
  const dbPath = requireFlag(flags, "db");
  if (typeof dbPath === "object") return err(dbPath.error);
  const shortIdStr = requireFlag(flags, "short-id");
  if (typeof shortIdStr === "object") return err(shortIdStr.error);
  const shortId = Number(shortIdStr);
  if (!Number.isInteger(shortId) || shortId <= 0) {
    return err("--short-id must be a positive integer");
  }
  const reg = openRegistry({ path: dbPath });
  const row = reg.getByShortId(shortId);
  if (!row) {
    reg.close();
    return err(
      `no row with short_id=${shortId} in ${JSON.stringify(dbPath)}. ` +
        `Run jobs-list to confirm the right --db, or run register first.`,
    );
  }
  let out: Record<string, unknown> = { ...row };
  if (flags["job-id"]) {
    const r = reg.getResult(flags["job-id"], row.fingerprint);
    if (r) out = { ...out, result: r };
  }
  reg.close();
  return ok(JSON.stringify(out, null, 2));
}

/**
 * build-fieldset — assemble a fieldset JSON from --field shorthand
 * tokens. Writes to stdout (or --out FILE). The shorthand parser
 * (parseShorthand) lives in `shorthand.ts` and accepts forms like
 * `is_async:bool=true if the file uses async/await`,
 * `category:enum(sport,music,code)=topic`, `complexity:int(1-10)=...`.
 */
function runBuildFieldset(args: string[]): CliResult {
  const { flags, positional: _positional } = parseFlags(args);
  void _positional;
  const name = requireFlag(flags, "name");
  if (typeof name === "object") return err(name.error);
  // Collect all --field tokens. parseFlags only keeps the LAST value
  // for repeated keys, so we walk argv ourselves to gather them all.
  const fieldTokens: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--field") {
      const v = args[i + 1];
      if (v !== undefined && !v.startsWith("--")) {
        fieldTokens.push(v);
        i++;
      }
    } else if (args[i]!.startsWith("--field=")) {
      fieldTokens.push(args[i]!.slice("--field=".length));
    }
  }
  if (fieldTokens.length === 0) {
    return err(
      "at least one --field 'NAME:TYPE=DESC' is required (e.g. --field 'is_async:bool=true if async/await')",
    );
  }
  const fields: unknown[] = [];
  for (const tok of fieldTokens) {
    try {
      fields.push(parseShorthand(tok));
    } catch (e) {
      return err(
        `--field ${JSON.stringify(tok)} parse error: ${(e as Error).message}`,
      );
    }
  }
  const fieldset = {
    version: 1,
    fieldset_name: name,
    fields,
  };
  // Validate by round-tripping through parseFieldset (catches bad descriptions, etc.).
  try {
    parseFieldset(fieldset);
  } catch (e) {
    return err(`fieldset validation failed: ${(e as Error).message}`);
  }
  const json = JSON.stringify(fieldset, null, 2);
  const outPath = flags["out"];
  if (outPath) {
    writeFileSync(outPath, json + "\n", "utf-8");
    return ok(`fieldset_name=${name}\nfields=${fields.length}\npath=${outPath}`);
  }
  return ok(json);
}

/**
 * propose-fieldset — ask the LLM to build a fieldset JSON from a
 * natural-language goal + optional sample files. Returns the JSON to
 * stdout (or --out FILE). Tests inject `fetchImpl`.
 */
async function runProposeFieldset(
  args: string[],
  opts: CliRunOptions,
): Promise<CliResult> {
  const { flags } = parseFlags(args);
  const goal = requireFlag(flags, "goal");
  if (typeof goal === "object") return err(goal.error);
  const apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return err(
      "OPENROUTER_API_KEY missing. Export it in your shell, set the plugin's userConfig.openrouter_api_key, or add it to ~/.llm-externalizer/settings.yaml.",
    );
  }
  const fetchImpl = opts.fetchImpl ?? realFetch;
  const model = resolveCliModel(flags);
  // Airtight free_only cost-safety (TRDD-97ef8b63). propose-fieldset makes its own
  // OpenRouter call; under free_only a non-':free' model throws BEFORE the request.
  assertFreeOnlyModel(getActiveFreeOnly(), "openrouter", model);
  // IRON RULE (TRDD-8b6b3646): a PAID propose-fieldset model must be validated
  // (mass_scout is rank 0 — any pass validates), else refuse. Exempt for ':free'.
  assertModelValidated(model, "mass_scout", "openrouter");
  const apiUrl = "https://openrouter.ai/api/v1/chat/completions";

  // Read sample files (if any) so the LLM can see actual content.
  const samples: { path: string; body: string }[] = [];
  const samplesArg = flags["samples"];
  if (samplesArg) {
    for (const p of samplesArg
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      try {
        const body = readFileSync(p, "utf-8");
        // Cap each sample at 2KB so the prompt stays small.
        samples.push({ path: p, body: body.slice(0, 2_000) });
      } catch {
        // Best-effort — silently skip unreadable.
      }
    }
  }

  const sysPrompt = [
    "You design JSON fieldsets for the mass-scouting tool.",
    "A fieldset describes structured metadata to extract from a single file.",
    "Allowed field type kinds: bool, string, enum(values), array_string, array_enum(values), int(min/max), number(min/max), array_object(item_fields).",
    "Field names match /^[a-z][a-z0-9_]*$/. Descriptions are 5..500 chars.",
    "Return ONLY a JSON object matching the response schema — no commentary.",
  ].join(" ");

  const userPrompt = [
    `GOAL: ${goal}`,
    "",
    samples.length > 0 ? "SAMPLE FILES (excerpts):" : "",
    ...samples.map((s) => `--- ${s.path} ---\n${s.body}\n`),
    "",
    "Return a JSON fieldset that, when applied to every file in the corpus,",
    "would let the user achieve the GOAL by querying the resulting registry.",
    "Prefer 3..7 fields. Use enum where the answer is one of a small set.",
  ].join("\n");

  const responseSchema = {
    name: "fieldset_proposal",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["fieldset_name", "fields"],
      properties: {
        fieldset_name: { type: "string" },
        notes: { type: "string" },
        fields: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: true,
            required: ["name", "description", "type"],
            properties: {
              name: { type: "string" },
              description: { type: "string" },
              type: {
                type: "object",
                additionalProperties: true,
                required: ["kind"],
                properties: { kind: { type: "string" } },
              },
            },
          },
        },
      },
    },
  };

  let res: { ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> };
  try {
    res = await fetchImpl(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: sysPrompt },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_schema", json_schema: responseSchema },
        temperature: 0.2,
      }),
    });
  } catch (e) {
    return err(`propose-fieldset network error: ${(e as Error).message}`);
  }
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    return err(`propose-fieldset HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  const payload = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    return err("propose-fieldset: response had no message.content");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    return err(`propose-fieldset: JSON.parse failed: ${(e as Error).message}`);
  }
  // Wrap with version + validate.
  const candidate = {
    version: 1,
    fieldset_name: (parsed as { fieldset_name?: string }).fieldset_name ?? "proposed",
    notes: (parsed as { notes?: string }).notes,
    fields: (parsed as { fields?: unknown[] }).fields ?? [],
  };
  try {
    parseFieldset(candidate);
  } catch (e) {
    return err(
      `propose-fieldset: model returned an invalid fieldset (${(e as Error).message}). Raw:\n${content.slice(0, 400)}`,
    );
  }
  const json = JSON.stringify(candidate, null, 2);
  const outPath = flags["out"];
  if (outPath) {
    writeFileSync(outPath, json + "\n", "utf-8");
    return ok(
      `fieldset_name=${candidate.fieldset_name}\nfields=${candidate.fields.length}\npath=${outPath}`,
    );
  }
  return ok(json);
}

/**
 * list-bundled-fieldsets — print the set of plugin-shipped fieldsets
 * that callers can pass as `--fields-file bundled:<name>`. With `--json`
 * dumps a structured list including each fieldset's name and its
 * fields[].name array, so the model/skill can pick the right one before
 * running estimate or scout.
 */
function runListBundledFieldsets(args: string[]): CliResult {
  const { flags } = parseFlags(args);
  const here = dirname(fileURLToPath(import.meta.url));
  // Same candidate list as resolveBundledFieldset — keep them in sync.
  const candidates = [
    resolve(here, "..", "fieldsets"),
    resolve(here, "fieldsets"),
    resolve(here, "..", "..", "fieldsets"),
  ];
  let dir: string | null = null;
  for (const c of candidates) {
    try {
      readdirSync(c);
      dir = c;
      break;
    } catch {
      // try next
    }
  }
  if (!dir) {
    return err(
      `bundled fieldsets directory not found; tried: ${candidates.join(", ")}`,
    );
  }
  const entries = readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
  const sets: { name: string; path: string; fields: string[] }[] = [];
  for (const e of entries) {
    const full = resolve(dir, e);
    const name = e.replace(/\.json$/, "");
    let fields: string[] = [];
    try {
      const parsed = JSON.parse(readFileSync(full, "utf-8")) as {
        fields?: { name: string }[];
      };
      fields = (parsed.fields ?? []).map((f) => f.name);
    } catch {
      // Leave fields empty if the file can't be parsed — the user
      // will see this as a degraded entry, which is the right hint.
    }
    sets.push({ name, path: full, fields });
  }
  if (flags["json"] === "true") {
    return ok(JSON.stringify(sets, null, 2));
  }
  if (sets.length === 0) {
    return ok("(no bundled fieldsets installed)");
  }
  const lines: string[] = [`Bundled fieldsets (dir=${dir}):`];
  for (const s of sets) {
    lines.push(
      `  bundled:${s.name}  fields=[${s.fields.join(", ")}]`,
    );
  }
  return ok(lines.join("\n"));
}

/**
 * diff — compare results of two jobs. For each file present in either
 * job, classify as `only_in_a`, `only_in_b`, or `changed` (with a
 * `changed_keys` array listing which result_json keys differ between
 * the two jobs). Useful when re-running with a refined fieldset to see
 * what changed.
 */
function runDiff(args: string[]): CliResult {
  const { flags } = parseFlags(args);
  const dbPath = requireFlag(flags, "db");
  if (typeof dbPath === "object") return err(dbPath.error);
  const fromJob = requireFlag(flags, "from");
  if (typeof fromJob === "object") return err(fromJob.error);
  const toJob = requireFlag(flags, "to");
  if (typeof toJob === "object") return err(toJob.error);
  if (fromJob === toJob) {
    return err("--from and --to must be different jobs");
  }
  const reg = openRegistry({ path: dbPath });
  const a = reg.listResultsByJob(fromJob);
  const b = reg.listResultsByJob(toJob);
  const aMap = new Map(a.map((r) => [r.file_fingerprint, r]));
  const bMap = new Map(b.map((r) => [r.file_fingerprint, r]));
  const onlyInA: { short_id: number; file_path: string }[] = [];
  const onlyInB: { short_id: number; file_path: string }[] = [];
  const changed: {
    short_id: number;
    file_path: string;
    changed_keys: string[];
  }[] = [];
  // a → b classification
  for (const [fp, ra] of aMap) {
    const rb = bMap.get(fp);
    const file = reg.getByFingerprint(fp);
    const path = file?.file_path ?? "(unknown)";
    if (!rb) {
      onlyInA.push({ short_id: ra.short_id, file_path: path });
      continue;
    }
    // Both — diff result_json keys.
    let pa: Record<string, unknown> = {};
    let pb: Record<string, unknown> = {};
    try {
      pa = JSON.parse(ra.result_json) as Record<string, unknown>;
    } catch {
      // already-empty
    }
    try {
      pb = JSON.parse(rb.result_json) as Record<string, unknown>;
    } catch {
      // already-empty
    }
    const keys = new Set([...Object.keys(pa), ...Object.keys(pb)]);
    const changedKeys: string[] = [];
    for (const k of keys) {
      if (JSON.stringify(pa[k]) !== JSON.stringify(pb[k])) changedKeys.push(k);
    }
    if (changedKeys.length > 0) {
      changed.push({ short_id: ra.short_id, file_path: path, changed_keys: changedKeys });
    }
  }
  // b → a complement
  for (const [fp, rb] of bMap) {
    if (aMap.has(fp)) continue;
    const file = reg.getByFingerprint(fp);
    onlyInB.push({
      short_id: rb.short_id,
      file_path: file?.file_path ?? "(unknown)",
    });
  }
  reg.close();
  const summary = {
    from: fromJob,
    to: toJob,
    only_in_a: onlyInA,
    only_in_b: onlyInB,
    changed,
    counts: {
      only_in_a: onlyInA.length,
      only_in_b: onlyInB.length,
      changed: changed.length,
      identical: aMap.size - changed.length - onlyInA.length,
    },
  };
  if (flags["json"] === "true") {
    return ok(JSON.stringify(summary, null, 2));
  }
  const lines = [
    `from=${fromJob}  to=${toJob}`,
    `only_in_a=${summary.counts.only_in_a}  only_in_b=${summary.counts.only_in_b}  changed=${summary.counts.changed}  identical=${summary.counts.identical}`,
  ];
  if (changed.length > 0) {
    lines.push("", "Changed files (first 50):");
    for (const c of changed.slice(0, 50)) {
      lines.push(
        `  ${c.short_id}  ${c.file_path}  keys=${c.changed_keys.join(",")}`,
      );
    }
  }
  return ok(lines.join("\n"));
}

/**
 * chain — scout a NEW fieldset against a filtered subset of an existing
 * job's results. Use case: "scout A told me which files use auth; now
 * scout B looks at those auth files for more detail". Implementation:
 * pick rows from source-job matching --filter, look up their
 * RegistryRows, run the scout pipeline against just those files with the
 * new fieldset under new-job-id.
 */
async function runChain(
  args: string[],
  opts: CliRunOptions,
): Promise<CliResult> {
  const { flags } = parseFlags(args);
  const dbPath = requireFlag(flags, "db");
  if (typeof dbPath === "object") return err(dbPath.error);
  const sourceJob = requireFlag(flags, "source-job");
  if (typeof sourceJob === "object") return err(sourceJob.error);
  const newJob = requireFlag(flags, "new-job-id");
  if (typeof newJob === "object") return err(newJob.error);
  const fieldsFile = requireFlag(flags, "new-fields-file");
  if (typeof fieldsFile === "object") return err(fieldsFile.error);
  const filterRaw = flags["filter"];
  if (!filterRaw) {
    return err(
      "--filter '$.x:OP:value' is required (or use mass_scout directly to scout everything)",
    );
  }
  const f = parseFilterToken(filterRaw);
  if ("error" in f) return err(f.error);

  const fs = loadFieldsetFromArg(fieldsFile);
  if ("error" in fs) return err(fs.error);

  const model = resolveCliModel(flags);
  const pricing = resolvePricing(model, flags);
  if ("error" in pricing) return err(pricing.error);

  const apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return err(
      "OPENROUTER_API_KEY missing. Export it in your shell, set the plugin's userConfig.openrouter_api_key, or add it to ~/.llm-externalizer/settings.yaml.",
    );
  }
  const fetchImpl = opts.fetchImpl ?? realFetch;

  const reg = openRegistry({ path: dbPath });
  // 1. Find source rows matching the filter.
  let sourceRows;
  try {
    sourceRows = reg.searchByJsonExtract(
      sourceJob,
      f.path,
      f.op,
      f.value,
      { limit: 1_000_000 },
    );
  } catch (e) {
    reg.close();
    return err(`chain filter failed: ${(e as Error).message}`);
  }
  if (sourceRows.length === 0) {
    reg.close();
    return ok(
      `source_job=${sourceJob}  matched=0  (filter matched nothing — nothing to chain)`,
    );
  }
  const fingerprints = new Set(sourceRows.map((r) => r.file_fingerprint));
  reg.close();

  // 2. Re-open and run runScoutJob restricted to those fingerprints.
  // The simplest way: temporarily mark all OTHER rows with a synthetic
  // bucket so scout's bucket filter excludes them. But that mutates the
  // registry. Cleaner: implement a new helper or just monkey-patch
  // listEligible. For minimum invasiveness, we reuse scoutOneFile via a
  // small loop here — same flow scout uses, but constrained to our list.
  // Each result lives under new-job-id.
  const reg2 = openRegistry({ path: dbPath });
  const compiled = compileFieldset(fs);
  // Resolve workers ONCE so the value persisted in the `jobs` table
  // matches the value runScoutJob actually fans out with — otherwise the
  // registry's job-history metadata diverges from reality (e.g. the run
  // really used 8 workers but the row says 1).
  const workers = flags["workers"] ? Number(flags["workers"]) : 4;
  if (!reg2.getJob(newJob)) {
    reg2.createJob({
      job_id: newJob,
      fieldset_name: fs.fieldset_name,
      fieldset_json: JSON.stringify(fs),
      json_schema: JSON.stringify(compiled.jsonSchema),
      model,
      workers,
      source_root: `chain:${sourceJob}`,
      bucket_filter: null,
      notes: `chained from ${sourceJob} via filter ${filterRaw}`,
    });
  }
  // We mark each matching fingerprint with a sentinel bucket label
  // ("chain:<newJob>"), run scout with that bucket filter, then restore
  // every row's original bucket in a `finally`. This reuses runScoutJob
  // verbatim — file-size cap, retry, circuit-breaker, resume — instead
  // of re-implementing the per-file loop here. setClassifierBucketOnly
  // touches only the bucket column so we don't have to round-trip
  // `has_yaml_frontmatter`'s SQLite-side `number | null` through
  // `updateClassification`'s `0 | 1 | undefined` parameter type.
  const eligible = reg2
    .listEligible({})
    .filter((r) => fingerprints.has(r.fingerprint));
  const SENTINEL = `chain:${newJob}`;
  const originals = new Map<string, string>();
  for (const r of eligible) {
    originals.set(r.fingerprint, r.classifier_bucket);
    reg2.setClassifierBucketOnly(r.fingerprint, SENTINEL);
  }
  // `okCount`, `failed`, `costUsd` are only read on the success path of
  // the try block. If runScoutJob throws, the finally rethrows and the
  // closing `return ok(...)` never runs — so initial values are dead and
  // ESLint's `no-useless-assignment` rule trips. We therefore declare-
  // and-assign in one statement inside the try.
  let okCount: number;
  let failed: number;
  let costUsd: number;
  try {
    const res = await runScoutJob(
      reg2,
      {
        jobId: newJob,
        fieldset: fs,
        pricing,
        model,
        apiKey,
        workers,
        maxRetries: flags["max-retries"] ? Number(flags["max-retries"]) : 1,
        bucket: SENTINEL,
        smokeTest: false,
        resume: true,
        sourceRoot: `chain:${sourceJob}`,
        onProgress: opts.onProgress
          ? (done, total) =>
              opts.onProgress?.(
                done,
                total,
                `chain: ${done}/${total} files`,
              )
          : undefined,
      },
      fetchImpl,
    );
    okCount = res.filesOk;
    failed = res.filesFailed;
    costUsd = res.costUsd;
  } finally {
    // Restore original buckets — even if runScoutJob threw, we don't
    // want stale "chain:<jobId>" labels lingering in the registry.
    for (const [fp, bucket] of originals) {
      reg2.setClassifierBucketOnly(fp, bucket);
    }
    reg2.close();
  }
  return ok(
    [
      `source_job=${sourceJob}`,
      `new_job=${newJob}`,
      `matched=${eligible.length}`,
      `files_ok=${okCount}`,
      `files_failed=${failed}`,
      `cost_usd=$${costUsd.toFixed(6)}`,
    ].join("\n"),
  );
}

/**
 * jobs-list — print every job in a DB. The output is human-readable by
 * default, JSON with `--json` for downstream consumption.
 */
function runJobsList(args: string[]): CliResult {
  const { flags } = parseFlags(args);
  const dbPath = requireFlag(flags, "db");
  if (typeof dbPath === "object") return err(dbPath.error);
  const reg = openRegistry({ path: dbPath });
  const jobs = reg.listJobs();
  reg.close();

  if (flags["json"] === "true") {
    return ok(JSON.stringify(jobs, null, 2));
  }
  if (jobs.length === 0) return ok("(no jobs in this db)");
  const lines = [
    `total=${jobs.length}`,
    "",
    "job_id  fieldset  model  files_ok/total  cost  started_at",
    "------  --------  -----  --------------  ----  ----------",
  ];
  for (const j of jobs) {
    const totals = `${j.files_ok ?? 0}/${j.files_total ?? 0}`;
    const cost = j.cost_usd != null ? `$${j.cost_usd.toFixed(6)}` : "—";
    lines.push(
      `${j.job_id}  ${j.fieldset_name}  ${j.model}  ${totals}  ${cost}  ${j.started_at}`,
    );
  }
  return ok(lines.join("\n"));
}

/**
 * audit-sample — pick N random results from a job and print them
 * alongside the cached file body so a human can spot-check whether the
 * model got it right. Critical for trust.
 */
function runAuditSample(args: string[]): CliResult {
  const { flags } = parseFlags(args);
  const dbPath = requireFlag(flags, "db");
  if (typeof dbPath === "object") return err(dbPath.error);
  const jobId = requireFlag(flags, "job-id");
  if (typeof jobId === "object") return err(jobId.error);
  const sampleN = flags["sample"] ? Number(flags["sample"]) : 5;
  if (!Number.isFinite(sampleN) || sampleN <= 0) {
    return err("--sample must be a positive integer (default 5)");
  }
  const bodyTruncate = flags["body-truncate"]
    ? Number(flags["body-truncate"])
    : 1_000;

  const reg = openRegistry({ path: dbPath });
  const rows = reg.sampleResultsByJob(jobId, sampleN);
  if (rows.length === 0) {
    reg.close();
    return ok(
      `job_id=${jobId}\nsample=${sampleN}\nrows=0  (no results found — has the scout run?)`,
    );
  }
  const out: { short_id: number; file_path: string; body_excerpt: string; result: unknown }[] = [];
  for (const r of rows) {
    const file = reg.getByFingerprint(r.file_fingerprint);
    const body = reg.readBody(r.file_fingerprint);
    const excerpt = body
      ? body.toString("utf-8").slice(0, bodyTruncate)
      : "(no body cached)";
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.result_json);
    } catch {
      parsed = r.result_json;
    }
    out.push({
      short_id: r.short_id,
      file_path: file?.file_path ?? "(unknown)",
      body_excerpt: excerpt,
      result: parsed,
    });
  }
  reg.close();
  if (flags["json"] === "true") {
    return ok(JSON.stringify({ job_id: jobId, samples: out }, null, 2));
  }
  const lines: string[] = [`job_id=${jobId}  sample=${rows.length}`, ""];
  for (const s of out) {
    lines.push(`### short_id=${s.short_id}  ${s.file_path}`);
    lines.push("--- BODY (excerpt) ---");
    lines.push(s.body_excerpt);
    lines.push("--- EXTRACTION ---");
    lines.push(JSON.stringify(s.result, null, 2));
    lines.push("");
  }
  return ok(lines.join("\n"));
}

/**
 * body-get — print the cached body for a file by short_id. The body
 * cache is the single source of truth (read once at register time);
 * exposing it as a tool means subagents can re-analyse without
 * re-touching disk.
 */
function runBodyGet(args: string[]): CliResult {
  const { flags } = parseFlags(args);
  const dbPath = requireFlag(flags, "db");
  if (typeof dbPath === "object") return err(dbPath.error);
  const shortIdStr = requireFlag(flags, "short-id");
  if (typeof shortIdStr === "object") return err(shortIdStr.error);
  const shortId = Number(shortIdStr);
  if (!Number.isInteger(shortId) || shortId <= 0) {
    return err("--short-id must be a positive integer");
  }
  const reg = openRegistry({ path: dbPath });
  const body = reg.readBodyByShortId(shortId);
  reg.close();
  if (!body) {
    return err(
      `no body cached for short_id=${shortId} in ${JSON.stringify(dbPath)}. ` +
        `The body cache is populated at register time — verify the short_id ` +
        `with mass_scout_get first.`,
    );
  }
  return ok(body.toString("utf-8"));
}

function runExport(args: string[], opts: CliRunOptions): CliResult {
  const { flags } = parseFlags(args);
  const dbPath = requireFlag(flags, "db");
  if (typeof dbPath === "object") return err(dbPath.error);
  const jobId = requireFlag(flags, "job-id");
  if (typeof jobId === "object") return err(jobId.error);
  const format = (flags["format"] ?? "jsonl").toLowerCase();
  if (format !== "jsonl" && format !== "csv") {
    return err("--format must be 'jsonl' or 'csv'");
  }

  const reg = openRegistry({ path: dbPath });
  const rows = reg.listResultsByJob(jobId);
  reg.close();

  const reportDir = resolveReportDir(flags["output-dir"], opts);
  mkdirSync(reportDir, { recursive: true });
  const stamp = isoTimestampLocal();
  const filename = `${stamp}-export-${slugify(jobId)}.${format}`;
  const path = join(reportDir, filename);

  // Truncate first so a re-run within the same wall-clock second (the
  // timestamp's resolution) does not appendFileSync duplicate rows onto
  // a stale export. Subsequent rows then use appendFileSync row-by-row
  // so we don't have to buffer the entire export in memory.
  writeFileSync(path, "", "utf-8");
  if (format === "jsonl") {
    for (const r of rows) {
      appendFileSync(path, JSON.stringify(r) + "\n", "utf-8");
    }
  } else {
    // CSV: header + comma-separated values. result_json is JSON.stringify'd
    // (already a string) and surrounded with quotes + double-escaped.
    const header = [
      "job_id",
      "file_fingerprint",
      "short_id",
      "result_json",
      "repaired",
      "attempts",
      "cost_usd",
      "enriched_at",
    ].join(",");
    appendFileSync(path, header + "\n", "utf-8");
    for (const r of rows) {
      const row = [
        csvEscape(r.job_id),
        csvEscape(r.file_fingerprint),
        String(r.short_id),
        csvEscape(r.result_json),
        String(r.repaired),
        String(r.attempts),
        r.cost_usd == null ? "" : String(r.cost_usd),
        csvEscape(r.enriched_at),
      ].join(",");
      appendFileSync(path, row + "\n", "utf-8");
    }
  }

  return ok(
    [`job_id=${jobId}`, `format=${format}`, `rows=${rows.length}`, `path=${path}`].join("\n"),
  );
}

// ── security-scan subcommand ─────────────────────────────────────────────

/**
 * Thin CLI adapter for the dedicated, injection-hardened `security_scan`
 * module. This is NOT the mass_scout pipeline — it parses the rich tool input
 * (which arrives JSON-encoded in `--input-json` because targets[] / rubrics
 * are nested objects that don't map to flat flags) and forwards it to
 * `runSecurityScan` together with the test-injection deps (fetchImpl / apiKey
 * / mainRoot / onProgress). All real work — intake, prompt, judge, report —
 * lives in src/security_scan/, fully under our control (TRDD §2).
 */
async function runSecurityScanCli(
  args: string[],
  opts: CliRunOptions,
): Promise<CliResult> {
  const { flags } = parseFlags(args);
  const inputJson = requireFlag(
    flags,
    "input-json",
    "JSON-encoded {targets, category_rubrics, ...}",
  );
  if (typeof inputJson === "object") return err(inputJson.error);

  let parsed: unknown;
  try {
    parsed = JSON.parse(inputJson);
  } catch (e) {
    return err(`--input-json is not valid JSON: ${(e as Error).message}`);
  }

  // An explicit --output-dir flag wins over output_dir embedded in the JSON
  // (the MCP dispatch passes output_dir both ways for belt-and-braces).
  if (
    flags["output-dir"] &&
    flags["output-dir"] !== "true" &&
    typeof parsed === "object" &&
    parsed !== null &&
    !Array.isArray(parsed)
  ) {
    (parsed as Record<string, unknown>).output_dir = flags["output-dir"];
  }

  // Per-tool model resolution (TRDD-f45eeaa0). When the caller did NOT pass an
  // explicit `model`, honor a settings.yaml `tool_models.security_scan` override
  // before the parser falls back to DEFAULT_MODEL. Resolution order:
  //   explicit input.model  >  tool_models.security_scan  >  DEFAULT_MODEL.
  // Best-effort: any settings problem (no file, bad preset, unset env) is
  // non-fatal — we skip the override and let DEFAULT_MODEL apply, so a scan
  // never fails just because settings could not be read. Only injects when the
  // `model` key is absent (a null/empty value is left for the parser to reject).
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    (parsed as Record<string, unknown>).model === undefined
  ) {
    try {
      const settings = loadSettings();
      const active = settings?.active
        ? settings.profiles[settings.active]
        : undefined;
      if (settings && active) {
        const resolved = resolveProfile(settings.active, active);
        const perTool = resolveModelForTool(resolved, "security_scan", "");
        if (perTool) (parsed as Record<string, unknown>).model = perTool;
      }
    } catch {
      // non-fatal — DEFAULT_MODEL applies downstream in parseSecurityScanInput.
    }
  }

  const result = await runSecurityScan(parsed, {
    fetchImpl: opts.fetchImpl,
    apiKey: opts.apiKey,
    mainRoot: opts.mainRoot,
    onProgress: opts.onProgress,
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  };
}

// ── Output helpers ─────────────────────────────────────────────────────

function csvEscape(s: string): string {
  if (s.includes('"') || s.includes(",") || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function isoTimestampLocal(): string {
  const now = new Date();
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
  const tzMin = -now.getTimezoneOffset();
  const tzSign = tzMin >= 0 ? "+" : "-";
  const tzAbs = Math.abs(tzMin);
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}` +
    `${tzSign}${pad(Math.floor(tzAbs / 60))}${pad(tzAbs % 60)}`
  );
}

function slugify(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80);
}

function formatSearchTable(res: SearchResponse): string {
  const lines = [
    `mode=${res.mode}  total_examined=${res.total_examined}  hits=${res.hits.length}` +
      (res.regex_pattern
        ? `  regex_pattern=${res.regex_pattern}  regex_reason=${res.regex_reason ?? ""}`
        : ""),
    "",
  ];
  for (const h of res.hits.slice(0, 100)) {
    let line = `${h.short_id}  ${h.file_path}`;
    if (h.snippet) line += `  :: ${h.snippet}`;
    if (h.regex_matches && h.regex_matches.length > 0) {
      const m = h.regex_matches[0]!;
      line += `  L${m.line}: "${m.match}"`;
      if (h.regex_matches.length > 1) line += ` (+${h.regex_matches.length - 1} more)`;
    }
    lines.push(line);
  }
  return lines.join("\n");
}

// ── Help text ──────────────────────────────────────────────────────────

const HELP_TEXT = `mass-scout — bulk LLM-driven structured-output file analysis.

Usage:
  llm-externalizer mass-scout <subcommand> [flags]

Subcommands:
  register       Walk a folder (or take --files) and store every file
                 in the SQLite registry.
                 Required: --db <path>
                 One of:   --root <folder>  |  --files <a,b,c>
                 Optional: --extensions .ts,.md  --exclude-dirs node_modules,vendor
                           --model <id>  --max-context-pct-register <0..1>

  preclassify    Cheap script-only file-type classifier.
                 Required: --db <path>
                 Optional: --reclassify  --limit <n>

  estimate       Per-fieldset cost / time estimate. Honors --budget-usd.
                 Required: --db <path>  --fields-file <path>
                 Optional: --model <id>  --bucket <name>  --workers <n>
                           --per-call-seconds <s>  --budget-usd <usd>
                           --expected-output-bytes <n>
                           --max-context-pct-scout <0..1>
                           --input-price-per-m <usd>  --output-price-per-m <usd>
                           --context-window <tokens>
                           --live-context   (query OpenRouter for the active
                                            provider's real context_length;
                                            requires OPENROUTER_API_KEY)

  scout          Run the LLM scout end-to-end. Writes a markdown report.
                 Required: --db <path>  --fields-file <path>  --job-id <id>
                           --source-root <path>
                 Optional: --model <id>  --workers <n>  --max-retries <n>
                           --bucket <name>  --no-smoke-test  --no-resume
                           --max-context-pct-scout <0..1>
                           --output-dir <path>   (report directory; default
                                            <main-repo-root>/reports/mass_scouting/)
                           --live-context   (see estimate)
                 Env:      OPENROUTER_API_KEY

  security-scan  Dedicated injection-hardened security triage. Adjudicates a
                 batch of suspected-malicious code snippets / file windows /
                 globs with a cheap LLM behind a nonce-delimited untrusted-data
                 envelope + strict json_schema + fail-safe-to-uncertain. NOT
                 the mass_scout pipeline. Writes JSON + markdown reports.
                 Required: --input-json '<{targets:[...], ...}>'
                 Optional: --output-dir <path>   (overrides JSON output_dir)
                 Env:      OPENROUTER_API_KEY (absent ⇒ all verdicts uncertain)

  search         Per-job search (FTS5 + structured + regex bypass).
                 Required: --db <path>  --job-id <id>
                 Optional: --query "..."  --regex "..."  --filter '$.x:=:val'
                           --force-llm  --force-regex
                           --limit <n>  --offset <n>  --json

  search-xjob    Cross-job federated search.
                 Required: --db <path>  --job-ids id1,id2,...
                 Optional: same as search, plus --limit-per-job  --limit-merged

  get            Print one row by short_id.
                 Required: --db <path>  --short-id <n>
                 Optional: --job-id <id>   (also prints the result row)

  export         Dump every row of a job to JSONL or CSV under reports/.
                 Required: --db <path>  --job-id <id>
                 Optional: --format jsonl|csv  (default: jsonl)
                           --output-dir <path>  (default
                                            <main-repo-root>/reports/mass_scouting/)

  jobs-list      List every scout job in the DB.
                 Required: --db <path>
                 Optional: --json

  audit-sample   Pick N random results, print body + extraction for human spot-check.
                 Required: --db <path>  --job-id <id>
                 Optional: --sample <n> (default 5)  --body-truncate <chars>
                           --json

  body-get       Print the cached file body by short_id.
                 Required: --db <path>  --short-id <n>

  build-fieldset Compose a fieldset JSON from --field shorthand tokens.
                 Required: --name <fieldset-name>  --field 'NAME:TYPE=DESC' ...
                 Optional: --out <path>   (default: stdout)

  propose-fieldset
                 Ask the LLM to propose a fieldset for a natural-language goal.
                 Required: --goal "<one-sentence intent>"
                 Optional: --samples <a,b,c>   (sample files for context)
                           --model <id>  --out <path>
                 Env:      OPENROUTER_API_KEY

  list-bundled-fieldsets
                 Print the plugin-shipped fieldsets that --fields-file
                 accepts as 'bundled:<name>'. Use --json for a structured
                 dump (each entry has name + field-name list).

  diff           Compare results of two jobs (only_in_a / only_in_b / changed).
                 Required: --db <path>  --from <jobA>  --to <jobB>
                 Optional: --json

  chain          Scout a NEW fieldset against the subset of an existing job's
                 results that matches a filter.
                 Required: --db <path>  --source-job <jobA>  --new-job-id <jobB>
                           --new-fields-file <path>  --filter '$.x:OP:value'
                 Optional: --model <id>  --workers <n>  --max-retries <n>
                 Env:      OPENROUTER_API_KEY

Notes:
  * --fields-file accepts EITHER an absolute path to a JSON file you
    wrote, OR a 'bundled:<name>' shorthand. Run 'list-bundled-fieldsets'
    to see what ships with the plugin (code-audit, skill-audit,
    security-audit, pr-review).
`;

// ── Entry point ────────────────────────────────────────────────────────

export async function runMassScoutCli(
  args: string[],
  opts: CliRunOptions = {},
): Promise<CliResult> {
  const sub = args[0];
  const rest = args.slice(1);
  if (sub === undefined || sub === "--help" || sub === "-h") {
    return ok(HELP_TEXT);
  }
  switch (sub) {
    case "register":
      return runRegister(rest);
    case "preclassify":
      return runPreclassify(rest);
    case "estimate":
      return runEstimate(rest, opts);
    case "scout":
      return runScout(rest, opts);
    case "security-scan":
      return runSecurityScanCli(rest, opts);
    case "search":
      return runSearch(rest);
    case "search-xjob":
      return runSearchXjob(rest);
    case "get":
      return runGet(rest);
    case "export":
      return runExport(rest, opts);
    case "jobs-list":
      return runJobsList(rest);
    case "audit-sample":
      return runAuditSample(rest);
    case "body-get":
      return runBodyGet(rest);
    case "build-fieldset":
      return runBuildFieldset(rest);
    case "propose-fieldset":
      return runProposeFieldset(rest, opts);
    case "list-bundled-fieldsets":
      return runListBundledFieldsets(rest);
    case "diff":
      return runDiff(rest);
    case "chain":
      return runChain(rest, opts);
    default:
      return err(
        `unknown sub-command ${JSON.stringify(sub)} — run 'llm-externalizer mass-scout --help'`,
      );
  }
}

// Re-export low-level helpers for tests.
export {
  parseFilterToken,
  parseFlags,
  resolvePricing,
  runSecurityScanCli,
  walkFiles,
  type Registry,
};
