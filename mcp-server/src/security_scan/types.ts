/**
 * Type system + hand-written validators for the `security_scan` tool.
 *
 * There is no Zod in this codebase (mass_scouting validates fieldsets with a
 * recursive-descent parser); we follow the same convention. `validateInput`
 * is a pure, fail-fast shape-checker: it returns a normalized `SecurityScanInput`
 * or a list of human-readable problems. A *shape* error is the ONLY thing that
 * makes the whole tool exit non-zero (TRDD §3 item 7) — every downstream
 * failure (no key, API error, malformed model response) is fail-safe to an
 * `uncertain` verdict, never a hard error.
 */

// ── Verdict vocabulary ───────────────────────────────────────────────────

/**
 * The three legal verdicts. `uncertain` is the fail-safe sink: any deviation,
 * any error, any ambiguity ends here. There is intentionally no fourth state.
 */
export type Verdict = "threat" | "not_threat" | "uncertain";

export const VERDICTS: readonly Verdict[] = [
  "threat",
  "not_threat",
  "uncertain",
] as const;

export function isVerdict(v: unknown): v is Verdict {
  return v === "threat" || v === "not_threat" || v === "uncertain";
}

// ── Input target shapes ──────────────────────────────────────────────────

/**
 * One unit of work the caller wants adjudicated. Exactly ONE of the three
 * payload forms must be present (validated in `validateTarget`):
 *   • `snippet`                       — inline code string, judged verbatim.
 *   • `file_path` (+ `line`?, `context_lines`?) — a window of a file on disk.
 *   • `path_glob`                     — expands to N files, each judged whole.
 *
 * `id` and `category` are always required so every emitted result row can be
 * traced back to the caller's finding and the rubric that governed it.
 */
export interface SecurityScanTarget {
  /** Caller-chosen stable identifier for this finding (e.g. "registry#468"). */
  id: string;
  /** Caller-chosen category key; selects the rubric in `category_rubrics`. */
  category: string;
  /** Optional language hint surfaced to the model (e.g. "typescript"). */
  language?: string;

  // ── exactly one of the three payloads ──
  /** Inline code to judge verbatim. */
  snippet?: string;
  /** Absolute path to a file on disk. */
  file_path?: string;
  /** 1-based line number to center the extraction window on. */
  line?: number;
  /** Number of context lines above AND below `line` (default 8). */
  context_lines?: number;
  /** Glob (relative to `folder_root` or cwd) expanding to files to judge. */
  path_glob?: string;
}

/**
 * Default ± window when `line` is given without `context_lines`.
 * Calibrated empirically (reports/security-scan-calibration/, 2026-05-24):
 * verdict accuracy vs window is NON-MONOTONIC — cl=8 → 5.6% good, cl=20 → 0%
 * (a dangerous partial-context "valley" with confident under-flags), cl=40 →
 * 81%, cl=60/80/whole → 92% (cl=60 is the smallest fully-stable window). The
 * cheap model rarely abstains (`uncertain`) when provenance is off-window — it
 * GUESSES — so the mitigation is a window large enough to contain the data
 * flow, NOT relying on abstention. 60 captures the enclosing function/scope for
 * most code. Callers may LOWER it for surface-only checks (controls were
 * window-insensitive) and MUST NOT use a partial value like 20.
 */
export const DEFAULT_CONTEXT_LINES = 60;

// ── Tool input ───────────────────────────────────────────────────────────

export interface SecurityScanInput {
  /** The work items. Required, non-empty. */
  targets: SecurityScanTarget[];
  /** Per-category adjudication rubric, placed into the SYSTEM prompt. */
  category_rubrics?: Record<string, string>;
  /** Verdict assigned on ANY error/deviation. Defaults to "uncertain". */
  default_verdict_on_error?: Verdict;
  /** Whole-job hard pre-flight gate (all-or-nothing). Null = no gate. */
  budget_usd?: number | null;
  /** OpenRouter model id. Defaults to the cheap qwen model. */
  model?: string;
  /** Git ref for incremental glob expansion (only changed files). */
  git_diff_ref?: string;
  /** Root for resolving relative `path_glob` / `git_diff_ref`. Defaults cwd. */
  folder_root?: string;
  /** Report/export output directory. Defaults to <main-root>/reports/security_scan/. */
  output_dir?: string;
  /** Concurrent judge calls. Defaults to 8. */
  workers?: number;
  /** Per-call retries on validation failure. Defaults to 1 (= 2 attempts). */
  max_retries?: number;
  /** Per-call timeout (ms). Defaults to 90_000. */
  per_call_timeout_ms?: number;
  /** Consecutive-failure circuit-breaker trip count. Defaults to 5 (0 = off). */
  consecutive_failure_limit?: number;
}

// ── Per-item result ──────────────────────────────────────────────────────

/** The raw object we require the model to emit (validated against the schema). */
export interface VerdictPayload {
  verdict: Verdict;
  confidence: number;
  reason: string;
  injection_observed: boolean;
}

/** One adjudicated finding, after fan-out from dedup. */
export interface SecurityScanItemResult {
  id: string;
  category: string;
  file_path?: string;
  line?: number;
  verdict: Verdict;
  /** 0..1 model confidence (clamped). */
  confidence: number;
  reason: string;
  /** True if the model reported the snippet tried to address/manipulate it. */
  injection_observed: boolean;
  /** Pre-scan script markers (e.g. "ignore-previous", "system-tag"). */
  injection_markers: string[];
  /** Model id that produced the verdict. */
  model: string;
  /** Dedup-group key (sha1 of content+category); shared by fanned-out ids. */
  dedup_group: string;
  /**
   * F9 (aegis 2026-05-23): true when this verdict came from a fail-safe path
   * (no key / API error / timeout / circuit trip / off-schema reply / skipped
   * during intake) rather than a real model judgement. Lets consumers tell a
   * genuine model `confidence:0` apart from a never-judged item — `confidence`
   * alone is overloaded (both are 0).
   */
  fail_safe: boolean;
}

// ── Summary ──────────────────────────────────────────────────────────────

export interface SecurityScanSummary {
  counts_by_verdict: Record<Verdict, number>;
  counts_by_category: Record<string, number>;
  items_total: number;
  items_deduped: number;
  items_skipped_too_big: number;
  budget_usd_spent: number;
  items_skipped_over_budget: number;
}

/** The whole report object serialized to <stamp>-security-scan-<job>.json. */
export interface SecurityScanReport {
  job_id: string;
  model: string;
  generated_at: string;
  summary: SecurityScanSummary;
  items: SecurityScanItemResult[];
}

// ── Validation ───────────────────────────────────────────────────────────

export interface ValidationOk {
  ok: true;
  value: Required<
    Pick<
      SecurityScanInput,
      | "targets"
      | "category_rubrics"
      | "default_verdict_on_error"
      | "model"
      | "workers"
      | "max_retries"
      | "per_call_timeout_ms"
      | "consecutive_failure_limit"
    >
  > &
    Pick<
      SecurityScanInput,
      "budget_usd" | "git_diff_ref" | "folder_root" | "output_dir"
    >;
}

export interface ValidationErr {
  ok: false;
  errors: string[];
}

export type ValidationResult = ValidationOk | ValidationErr;

/** Hard caps on caller-controlled string sizes — anti-DoS + anti-injection. */
export const MAX_RUBRIC_LENGTH = 2000;
export const MAX_SNIPPET_BYTES = 200_000;
export const MAX_TARGETS = 5000;

/**
 * DoS read-guard for `file_path`+`line` WINDOW targets. The egress `byteCap`
 * (the scout context cap, ~50KB) applies to the EXTRACTED WINDOW, not the whole
 * file — so a window target into a large source file (e.g. a 400KB index.ts at
 * line 3346, exactly CPV's use case) must NOT be skipped just because the file
 * exceeds the egress cap. We still guard against reading a pathologically huge
 * file into a JS string (the real DoS aegis-F5 warned about) with this generous
 * ceiling, which comfortably covers every realistic source/bundle file while
 * refusing multi-GB inputs. Whole-file and glob targets keep the egress cap
 * (there the file IS the content sent to the model).
 */
export const MAX_FILE_READ_BYTES = 16_777_216; // 16 MiB

/**
 * Default OpenRouter model — the single source of truth for the cheap default
 * shared by `security_scan` and `mass_scouting`. `mass_scouting/cli.ts` imports
 * this constant rather than redeclaring it (de-duped in A3, TRDD-828238b5).
 */
export const DEFAULT_MODEL = "qwen/qwen-2.5-7b-instruct";

/** git-ref shape guard — mirrors cli.ts:225 (anti shell-injection). */
export const GIT_REF_RE = /^[A-Za-z0-9_./~^@{}-]+$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validate ONE target. Returns the normalized target or a list of errors.
 * Enforces exactly-one-payload and field types. Index is used only for clear
 * error messages.
 */
export function validateTarget(
  raw: unknown,
  index: number,
): { ok: true; value: SecurityScanTarget } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const at = `targets[${index}]`;
  if (!isPlainObject(raw)) {
    return { ok: false, errors: [`${at} must be an object`] };
  }
  const id = raw.id;
  const category = raw.category;
  if (typeof id !== "string" || id.length === 0) {
    errors.push(`${at}.id must be a non-empty string`);
  }
  if (typeof category !== "string" || category.length === 0) {
    errors.push(`${at}.category must be a non-empty string`);
  }
  if (raw.language !== undefined && typeof raw.language !== "string") {
    errors.push(`${at}.language must be a string when present`);
  }

  // Exactly-one-payload check.
  const hasSnippet = typeof raw.snippet === "string";
  const hasFile = typeof raw.file_path === "string";
  const hasGlob = typeof raw.path_glob === "string";
  const payloadCount =
    (hasSnippet ? 1 : 0) + (hasFile ? 1 : 0) + (hasGlob ? 1 : 0);
  if (payloadCount === 0) {
    errors.push(
      `${at} must have exactly one of snippet, file_path, or path_glob`,
    );
  } else if (payloadCount > 1) {
    errors.push(
      `${at} has ${payloadCount} payloads — exactly one of snippet, file_path, path_glob is allowed`,
    );
  }

  if (hasSnippet) {
    const bytes = Buffer.byteLength(raw.snippet as string, "utf-8");
    if (bytes > MAX_SNIPPET_BYTES) {
      errors.push(
        `${at}.snippet is ${bytes} bytes (> ${MAX_SNIPPET_BYTES} cap)`,
      );
    }
  }
  // line / context_lines only meaningful with file_path; validate types if present.
  if (raw.line !== undefined) {
    if (
      typeof raw.line !== "number" ||
      !Number.isInteger(raw.line) ||
      raw.line < 1
    ) {
      errors.push(`${at}.line must be a positive integer (1-based)`);
    }
    if (!hasFile) {
      errors.push(`${at}.line is only valid together with file_path`);
    }
  }
  if (raw.context_lines !== undefined) {
    if (
      typeof raw.context_lines !== "number" ||
      !Number.isInteger(raw.context_lines) ||
      raw.context_lines < 0
    ) {
      errors.push(`${at}.context_lines must be a non-negative integer`);
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  const value: SecurityScanTarget = {
    id: id as string,
    category: category as string,
  };
  if (typeof raw.language === "string") value.language = raw.language;
  if (hasSnippet) value.snippet = raw.snippet as string;
  if (hasFile) value.file_path = raw.file_path as string;
  if (hasGlob) value.path_glob = raw.path_glob as string;
  if (typeof raw.line === "number") value.line = raw.line;
  if (typeof raw.context_lines === "number")
    value.context_lines = raw.context_lines;
  return { ok: true, value };
}

/**
 * Validate the whole tool input. Fail-fast on shape problems — this is the
 * ONLY path that ever causes a non-zero exit. Returns a fully-defaulted
 * value on success so downstream code never re-derives defaults.
 */
export function validateInput(raw: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isPlainObject(raw)) {
    return { ok: false, errors: ["input must be a JSON object"] };
  }

  // targets
  if (!Array.isArray(raw.targets)) {
    return { ok: false, errors: ["targets must be a non-empty array"] };
  }
  if (raw.targets.length === 0) {
    return { ok: false, errors: ["targets must contain at least one item"] };
  }
  if (raw.targets.length > MAX_TARGETS) {
    return {
      ok: false,
      errors: [`targets has ${raw.targets.length} items (> ${MAX_TARGETS} cap)`],
    };
  }
  const targets: SecurityScanTarget[] = [];
  for (let i = 0; i < raw.targets.length; i++) {
    const t = validateTarget(raw.targets[i], i);
    if (t.ok) targets.push(t.value);
    else errors.push(...t.errors);
  }

  // category_rubrics
  const rubrics: Record<string, string> = {};
  if (raw.category_rubrics !== undefined) {
    if (!isPlainObject(raw.category_rubrics)) {
      errors.push("category_rubrics must be an object of {category: rubric}");
    } else {
      for (const [k, v] of Object.entries(raw.category_rubrics)) {
        if (typeof v !== "string") {
          errors.push(`category_rubrics[${k}] must be a string`);
          continue;
        }
        if (v.length > MAX_RUBRIC_LENGTH) {
          errors.push(
            `category_rubrics[${k}] is ${v.length} chars (> ${MAX_RUBRIC_LENGTH} cap)`,
          );
          continue;
        }
        rubrics[k] = v;
      }
    }
  }

  // default_verdict_on_error
  // F2 (aegis 2026-05-23): the fail-safe (§3.7) MUST never fail OPEN. The error
  // sink may be `uncertain` or `threat` but NEVER `not_threat` — otherwise a
  // caller (or an attacker who controls the invocation, or a copy-paste error)
  // could set not_threat and silently convert every API error / timeout /
  // circuit trip / no-key run into a clean bill of health with zero model
  // involvement. Reject it here; judge.ts + the no-key path also clamp it as
  // defense-in-depth so even a future validator regression can't fail open.
  let defaultVerdict: Verdict = "uncertain";
  if (raw.default_verdict_on_error !== undefined) {
    if (!isVerdict(raw.default_verdict_on_error)) {
      errors.push(
        `default_verdict_on_error must be one of ${VERDICTS.join(", ")}`,
      );
    } else if (raw.default_verdict_on_error === "not_threat") {
      errors.push(
        "default_verdict_on_error may not be not_threat (fail-safe must never fail open — use uncertain or threat)",
      );
    } else {
      defaultVerdict = raw.default_verdict_on_error;
    }
  }

  // budget_usd
  let budget: number | null = null;
  if (raw.budget_usd !== undefined && raw.budget_usd !== null) {
    if (typeof raw.budget_usd !== "number" || !Number.isFinite(raw.budget_usd)) {
      errors.push("budget_usd must be a finite number or null");
    } else if (raw.budget_usd < 0) {
      errors.push("budget_usd must be >= 0");
    } else {
      budget = raw.budget_usd;
    }
  }

  // model
  let model = DEFAULT_MODEL;
  if (raw.model !== undefined) {
    if (typeof raw.model !== "string" || raw.model.length === 0) {
      errors.push("model must be a non-empty string when present");
    } else {
      model = raw.model;
    }
  }

  // git_diff_ref
  let gitRef: string | undefined;
  if (raw.git_diff_ref !== undefined) {
    if (typeof raw.git_diff_ref !== "string") {
      errors.push("git_diff_ref must be a string");
    } else if (
      raw.git_diff_ref.length > 200 ||
      !GIT_REF_RE.test(raw.git_diff_ref)
    ) {
      errors.push(
        "git_diff_ref has an illegal shape (anti-injection: only [A-Za-z0-9_./~^@{}-], <=200 chars)",
      );
    } else {
      gitRef = raw.git_diff_ref;
    }
  }

  // folder_root / output_dir
  let folderRoot: string | undefined;
  if (raw.folder_root !== undefined) {
    if (typeof raw.folder_root !== "string" || raw.folder_root.length === 0) {
      errors.push("folder_root must be a non-empty string when present");
    } else {
      folderRoot = raw.folder_root;
    }
  }
  let outputDir: string | undefined;
  if (raw.output_dir !== undefined) {
    if (typeof raw.output_dir !== "string" || raw.output_dir.length === 0) {
      errors.push("output_dir must be a non-empty string when present");
    } else {
      outputDir = raw.output_dir;
    }
  }

  // numeric knobs
  const workers = numKnob(raw.workers, 8, 1, 256, "workers", errors);
  const maxRetries = numKnob(raw.max_retries, 1, 0, 10, "max_retries", errors);
  const perCallTimeout = numKnob(
    raw.per_call_timeout_ms,
    90_000,
    1000,
    600_000,
    "per_call_timeout_ms",
    errors,
  );
  const failureLimit = numKnob(
    raw.consecutive_failure_limit,
    5,
    0,
    1000,
    "consecutive_failure_limit",
    errors,
  );

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      targets,
      category_rubrics: rubrics,
      default_verdict_on_error: defaultVerdict,
      budget_usd: budget,
      model,
      git_diff_ref: gitRef,
      folder_root: folderRoot,
      output_dir: outputDir,
      workers,
      max_retries: maxRetries,
      per_call_timeout_ms: perCallTimeout,
      consecutive_failure_limit: failureLimit,
    },
  };
}

/** Validate an optional integer knob with bounds; push an error if bad. */
function numKnob(
  raw: unknown,
  dflt: number,
  min: number,
  max: number,
  name: string,
  errors: string[],
): number {
  if (raw === undefined) return dflt;
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    errors.push(`${name} must be an integer`);
    return dflt;
  }
  if (raw < min || raw > max) {
    errors.push(`${name} must be in [${min}, ${max}]`);
    return dflt;
  }
  return raw;
}
