/**
 * OpenRouter model info fetcher + formatters.
 *
 * Shared between the MCP tools (or_model_info, or_model_info_table) in
 * index.ts and the CLI `llm-externalizer model-info` command in cli.ts.
 *
 * Queries /v1/models/{exact_id}/endpoints — the per-model endpoint that
 * returns architecture + one block per hosting provider with context
 * length, pricing, supported_parameters, quantization, uptime, latency
 * percentiles, and throughput percentiles.
 */
export interface ModelEndpointPricing {
    prompt?: string;
    completion?: string;
    image?: string;
    request?: string;
    input_cache_read?: string;
    discount?: number;
}
/**
 * Percentile container. OpenRouter uses keys like `p50`, `p75`, `p90`, `p99`
 * today but may add fractional (`p99.9`) or other keys in the future. Modeled
 * as an open record so we discover and render whatever the API returns.
 */
export type ModelEndpointPercentiles = Record<string, number | undefined>;
/**
 * Extract numeric percentile entries from a record, sorted by numeric value.
 * Filters out non-percentile keys and non-number values. Handles both
 * integer (p50) and fractional (p99.9) percentiles.
 */
export declare function sortedPercentiles(obj: ModelEndpointPercentiles | undefined): Array<{
    key: string;
    value: number;
    numeric: number;
}>;
/**
 * Human label for a percentile key — adds a qualitative annotation to
 * the median and extreme percentiles, leaves the mid ones bare.
 *
 * - p50 → "(median)"
 * - p0-p5 → "(best case)"  (mostly for throughput where low = worst)
 * - p95+ → "(worst 1-5%)" for latency / "(best 1-5%)" for throughput
 */
export declare function percentileAnnotation(numeric: number, higherIsBetter: boolean): string;
export interface ModelEndpoint {
    name?: string;
    provider_name?: string;
    tag?: string;
    context_length?: number;
    max_completion_tokens?: number;
    max_prompt_tokens?: number | null;
    quantization?: string;
    pricing?: ModelEndpointPricing;
    supported_parameters?: string[];
    status?: number;
    uptime_last_30m?: number | null;
    uptime_last_5m?: number | null;
    uptime_last_1d?: number | null;
    latency_last_30m?: ModelEndpointPercentiles;
    throughput_last_30m?: ModelEndpointPercentiles;
    supports_implicit_caching?: boolean;
}
export interface ModelInfoArchitecture {
    tokenizer?: string;
    modality?: string;
    input_modalities?: string[];
    output_modalities?: string[];
}
export interface ModelInfoData {
    id?: string;
    name?: string;
    description?: string;
    architecture?: ModelInfoArchitecture;
    endpoints?: ModelEndpoint[];
}
export type FetchModelInfoResult = {
    ok: true;
    data: ModelInfoData;
} | {
    ok: false;
    error: string;
    status?: number;
};
/**
 * Validate that a model id is a well-formed OpenRouter identifier.
 * Accepts: lowercase/digits/hyphens/dots in vendor and model segments,
 * a single required `/` separator, and an optional `:suffix` for
 * variants (`:free`, `:thinking`, `:beta`). Rejects anything that
 * could be used for URL path traversal or injection, most importantly
 * `..`, embedded spaces, and other URL-reserved characters.
 */
export declare function isValidOpenRouterModelId(id: string): boolean;
/**
 * Fetch model metadata from OpenRouter. Returns a tagged union so callers
 * can distinguish "data" from "error" without exceptions. Always uses an
 * AbortController timeout so callers never hang on provider outages.
 */
export declare function fetchOpenRouterModelInfo(modelId: string, baseUrl: string, authToken: string, timeoutMs?: number): Promise<FetchModelInfoResult>;
/** Convert OpenRouter per-token pricing string to per-million display. */
export declare function formatPricePerM(s?: string): string;
export type QualityLevel = "excellent" | "good" | "borderline" | "poor" | "neutral" | "free" | "yes" | "no";
export declare function qualityEmoji(level: QualityLevel): string;
/**
 * Format model info as a pipe-delimited markdown table. One table per
 * endpoint. Renders with borders in any markdown viewer. Used by the
 * CLI `--markdown` flag and the `or_model_info` MCP tool.
 */
export declare function formatModelInfoMarkdown(data: ModelInfoData, modelId: string): string;
/**
 * Pretty-print the raw OpenRouter model data as JSON. Used by the CLI
 * `--json` flag when the caller wants to pipe the full metadata into
 * another tool (jq, scripts, etc.) without losing any fields.
 */
export declare function formatModelInfoJson(data: ModelInfoData, _modelId: string): string;
/**
 * Format model info as a Unicode-bordered table with ANSI colors.
 * Used by or_model_info_table MCP tool and the CLI model-info command.
 *
 * When the model has multiple endpoints, the output is one table per
 * endpoint stacked vertically — easier to read than a wide comparison
 * table when there are many metrics.
 */
export declare function formatModelInfoTable(data: ModelInfoData, modelId: string, colors?: boolean): string;
