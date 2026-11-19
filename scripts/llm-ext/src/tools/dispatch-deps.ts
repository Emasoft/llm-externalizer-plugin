/**
 * The values index.ts hands to the tool handlers that were moved out of dispatchCallToolInner's switch (TRDD-TYSKX72I),
 * and the interfaces their signatures use. A handler module must not import index.ts (a cycle), so everything such a
 * handler read from index.ts module state or from dispatchCallToolInner's locals is declared here and passed in:
 * `CaseCall` is what the dispatch computed for this one call, `CaseDeps` is index.ts's own module-level functions and
 * state. The interfaces below were declared in index.ts and now live here; index.ts imports them back.
 */

import type { chatCompletionJSON, JSONCompletionResult } from "../provider/completion.js";
import type { BackendConfig, ChatMessage, CompletionDeps, ModelInfo, ReasoningEffortSetting, StreamingResult } from "../provider/types.js";
import type { ProgressFn } from "../rate-limiter.js";
import type { HighQualityRequest, ResolvedProfile, Settings } from "../config.js";
import type { RegexRedactOpts } from "../scan-pipeline.js";
import type { FileUsage } from "../usage-totals.js";
import type { RetryClock } from "../provider/http.js";

/**
 * What every tool returns. The `content` envelope is OUR OWN shape — a local
 * interface, never an SDK type — so it survives the MCP removal untouched.
 * Keeping it means 40 return sites stay as they are; the CLI flattens it to
 * stdout + an exit code in exactly ONE place instead.
 */
export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  [k: string]: unknown;
}

export interface RateLimitConfig {
  rps: number;       // max new requests per second
  maxInFlight: number; // max concurrent requests (safety cap)
}

/** The verdict classifyError gives a per-file failure. */
export interface ErrorClassification {
  unrecoverable: boolean;
  serviceLevel: boolean;
  reason: string;
  /** Final for this file (never retried) yet still a FAILED outcome: the
   *  per-file loops must feed it to the "3 of the last 3 completions failed"
   *  window, which only the retried-then-exhausted path used to do. Set for a
   *  closed retry window (RetryDeadlineError). */
  countsAsFailure?: boolean;
}

export interface FileProcessResult {
  filePath: string;
  success: boolean;
  reportPath?: string;
  backupPath?: string;
  error?: string;
  noChange?: boolean;
  usage?: FileUsage;
}

export interface RobustPerFileOpts {
  task: string;
  maxRetries: number;
  redact?: boolean;
  regexRedact?: RegexRedactOpts | null;
  onProgress?: ProgressFn;
  ensemble: boolean;
  budgetBytes: number;
  language?: string;
  toolName: string;
  batchId?: string;
  modelOverride?: string;
  outputDir?: string;
  lineNumbers?: boolean; // prefix every file line with its number (line_numbers flag, TRDD-MI0UJQF1)
}

export interface RobustPerFileResult {
  results: FileProcessResult[];
  succeeded: FileProcessResult[];
  failed: FileProcessResult[];
  skipped: FileProcessResult[];
  aborted: boolean;
  abortReason: string;
}

export interface FolderResolveResult {
  files: string[];
  error?: string;
}

export interface ProcessOptions {
  language?: string;
  maxTokens?: number;
  batchId?: string; // if set, uses batch-style report filenames
  fileIndex?: number; // disambiguates files with same basename in a batch
  redact?: boolean; // redact secrets before sending to LLM
  regexRedact?: RegexRedactOpts | null; // user-defined regex redaction
  onProgress?: ProgressFn; // MCP progress notifications to keep client alive
  ensemble?: boolean; // run on multiple models and combine results (default true)
  maxBytes?: number; // max file size in bytes (default: DEFAULT_MAX_PAYLOAD_BYTES)
  modelOverride?: string; // skip ensemble, use this specific model (e.g. free mode)
  outputDir?: string; // custom output directory for reports
  hqRequest?: HighQualityRequest; // high_quality_scan provider/reasoning/cache (TRDD-DBUSM55E)
  lineNumbers?: boolean; // prefix every line of each input file with its number (line_numbers flag, TRDD-MI0UJQF1)
}

export interface OpenRouterModelInfo {
  id: string;
  name: string;
  context_length?: number;
  pricing?: { prompt: string; completion: string };
  top_provider?: { max_completion_tokens?: number; context_length?: number };
}

/** What dispatchCallToolInner computed for the one call: read-only inside the handler, exactly as the inline body read them. */
export interface CaseCall {
  args: Record<string, unknown> | undefined;
  backend: BackendConfig;
  onProgress: ProgressFn | undefined;
  modelOverride: string | undefined;
  outputDir: string | undefined;
  name: string;
}

/** index.ts's module-level functions and state that the moved handlers call. activeResolved and activeSettings are
 *  getters: index.ts reassigns them when settings reload, and the inline body read the live binding at each use. */
export interface CaseDeps {
  readonly activeResolved: ResolvedProfile | null;
  readonly activeSettings: Settings;
  readonly settingsValid: boolean;
  readonly settingsError: string;
  readonly FALLBACK_CONTEXT_LENGTH: number;
  readonly SOFT_TIMEOUT_MS: number;
  SETTINGS_FILE: string;
  LOG_FILE: string;
  session: { calls: number; promptTokens: number; completionTokens: number; totalCost: number };
  getProfileSelectionSource: () => "flag" | "default";
  isFreeModeActive: () => boolean;
  activeFreePool: () => string[];
  fetchOpenRouterModels: () => Promise<OpenRouterModelInfo[]>;
  listModelsRaw: () => Promise<ModelInfo[]>;
  getContextLength: (model: ModelInfo) => number;
  DEFAULT_TEMPERATURE: number;
  providerDeps: CompletionDeps;
  ensembleAllowed: (backend: Pick<BackendConfig, "type">, resolved: ResolvedProfile | null) => boolean;
  normalizePaths: (raw: string | string[] | undefined | null) => string[];
  resolveFolderPath: (
    folderPath: string,
    opts?: {
      extensions?: string[];
      excludeDirs?: string[];
      useGitignore?: boolean;
      recursive?: boolean;
      followSymlinks?: boolean;
      maxFiles?: number;
      /** --preview reason channel — forwarded to walkDir (TRDD-SCLGL8T4). */
      onExcluded?: (path: string, reason: string) => void;
    },
  ) => FolderResolveResult;
  resolveDefaultMaxTokens: () => number;
  ensembleStreaming: (
    messages: ChatMessage[],
    callerOptions: {
      temperature?: number;
      maxTokens?: number;
      onProgress?: ProgressFn;
      modelOverride?: string;
      provider?: Record<string, unknown>;
      cache?: boolean;
      reasoning?: ReasoningEffortSetting;
    },
    ensemble: boolean,
    fileLineCount?: number,
    retryClock?: RetryClock,
  ) => Promise<StreamingResult>;
  formatFooter: (resp: StreamingResult, toolName: string, filePath?: string) => string;
  saveResponse: (
    toolName: string,
    responseText: string,
    meta: { model: string; task?: string; inputFile?: string; groupId?: string },
    overrideFilename?: string,
    outputDir?: string,
  ) => string;
  robustPerFileProcess: (files: string[], opts: RobustPerFileOpts) => Promise<RobustPerFileResult>;
  processFileCheck: (filePath: string, task: string, options?: ProcessOptions) => Promise<FileProcessResult>;
  ensembleModelLabel: (useEnsemble: boolean) => string;
  getRateLimitConfig: () => Promise<RateLimitConfig>;
  classifyError: (error: unknown) => ErrorClassification;
  recordFailedOutcome: (recentOutcomes: boolean[]) => boolean;
  capDependencyBlocks: (filePath: string, srcBlock: string, depBlocks: readonly string[], budgetBytes: number) => string[];
  brokerSlotCtx: (contextWindow: number) => number;
  makeProviderDeps: (profile: ResolvedProfile | null, backend: BackendConfig, o?: { noHold?: boolean }) => CompletionDeps;
  makeBackendFromProfile: (resolved: ResolvedProfile, modelOverride?: string) => BackendConfig;
  startCalibration: (models: ReadonlyArray<{ engine: "llama" | "locals"; model: string }>) => Promise<void>;
  chatCompletionJSONWithFreeRotation: (messages: ChatMessage[], options: Parameters<typeof chatCompletionJSON>[1]) => Promise<JSONCompletionResult>;
  recordUsage: (usage?: { prompt_tokens: number; completion_tokens: number; cost?: number }) => void;
  logRequest: (opts: {
    tool: string;
    model: string;
    status: "success" | "error" | "truncated";
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens?: number; cost?: number };
    filePath?: string;
    error?: string;
  }) => void;
}
