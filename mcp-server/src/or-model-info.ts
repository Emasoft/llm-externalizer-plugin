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
export function sortedPercentiles(
  obj: ModelEndpointPercentiles | undefined,
): Array<{ key: string; value: number; numeric: number }> {
  if (!obj || typeof obj !== "object") return [];
  const out: Array<{ key: string; value: number; numeric: number }> = [];
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value !== "number" || !isFinite(value)) continue;
    const match = /^p(\d+(?:\.\d+)?)$/.exec(key);
    if (!match) continue;
    out.push({ key, value, numeric: parseFloat(match[1]) });
  }
  out.sort((a, b) => a.numeric - b.numeric);
  return out;
}

/**
 * Human label for a percentile key — adds a qualitative annotation to
 * the median and extreme percentiles, leaves the mid ones bare.
 *
 * - p50 → "(median)"
 * - p0-p5 → "(best case)"  (mostly for throughput where low = worst)
 * - p95+ → "(worst 1-5%)" for latency / "(best 1-5%)" for throughput
 */
export function percentileAnnotation(numeric: number, higherIsBetter: boolean): string {
  if (numeric === 50) return "median";
  if (numeric >= 95) return higherIsBetter ? `best ${(100 - numeric).toFixed(numeric % 1 ? 1 : 0)}%` : `worst ${(100 - numeric).toFixed(numeric % 1 ? 1 : 0)}%`;
  if (numeric <= 5) return higherIsBetter ? `worst ${numeric.toFixed(numeric % 1 ? 1 : 0)}%` : `best ${numeric.toFixed(numeric % 1 ? 1 : 0)}%`;
  return "";
}

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

export type FetchModelInfoResult =
  | { ok: true; data: ModelInfoData }
  | { ok: false; error: string; status?: number };

/**
 * Validate that a model id is a well-formed OpenRouter identifier.
 * Accepts: lowercase/digits/hyphens/dots in vendor and model segments,
 * a single required `/` separator, and an optional `:suffix` for
 * variants (`:free`, `:thinking`, `:beta`). Rejects anything that
 * could be used for URL path traversal or injection, most importantly
 * `..`, embedded spaces, and other URL-reserved characters.
 */
export function isValidOpenRouterModelId(id: string): boolean {
  if (!id || typeof id !== "string") return false;
  if (id.length > 200) return false;
  // Reject path-traversal attempts and characters that could escape
  // the /v1/models/{id}/endpoints path segment.
  if (id.includes("..") || id.includes("//")) return false;
  // Well-formed: <vendor>/<model>[:<variant>]
  // vendor and model allow lowercase letters, digits, hyphens, dots,
  // underscores. Variant (after `:`) allows the same plus some
  // additional characters OpenRouter uses (e.g. `:free`, `:thinking`).
  return /^[a-z0-9][a-z0-9._-]*\/[a-zA-Z0-9._-]+(?::[a-zA-Z0-9._-]+)?$/.test(id);
}

/**
 * Default timeout for the OpenRouter /v1/models/{id}/endpoints request.
 * OpenRouter is usually sub-second; 15s is a generous ceiling.
 */
const MODEL_INFO_FETCH_TIMEOUT_MS = 15_000;

/**
 * Fetch model metadata from OpenRouter. Returns a tagged union so callers
 * can distinguish "data" from "error" without exceptions. Always uses an
 * AbortController timeout so callers never hang on provider outages.
 */
export async function fetchOpenRouterModelInfo(
  modelId: string,
  baseUrl: string,
  authToken: string,
  timeoutMs: number = MODEL_INFO_FETCH_TIMEOUT_MS,
): Promise<FetchModelInfoResult> {
  // Validate the model id BEFORE constructing the URL — prevents path
  // traversal (`../`) and unexpected URL injections.
  if (!isValidOpenRouterModelId(modelId)) {
    return {
      ok: false,
      error: `Invalid model id '${modelId}'. Expected '<vendor>/<model>[:variant]' (e.g. 'nvidia/nemotron-3-super-120b-a12b:free').`,
    };
  }

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/v1/models/${modelId}/endpoints`, {
      headers: { Authorization: `Bearer ${authToken}` },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutHandle);
    const msg = err instanceof Error ? err.message : String(err);
    // AbortError has name === "AbortError" — surface as a timeout so
    // the user understands it wasn't a transient connection failure.
    if (err instanceof Error && err.name === "AbortError") {
      return {
        ok: false,
        error: `OpenRouter request timed out after ${timeoutMs / 1000}s`,
      };
    }
    return { ok: false, error: `Network error: ${msg}` };
  }
  clearTimeout(timeoutHandle);

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { ok: false, error: body.slice(0, 300), status: res.status };
  }
  try {
    const payload = (await res.json()) as { data?: ModelInfoData };
    if (!payload.data || !Array.isArray(payload.data.endpoints)) {
      return { ok: false, error: "OpenRouter returned no endpoints for this model" };
    }
    return { ok: true, data: payload.data };
  } catch (err) {
    return {
      ok: false,
      error: `Failed to parse response: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ── Shared pricing formatter ────────────────────────────────────────

/** Convert OpenRouter per-token pricing string to per-million display. */
export function formatPricePerM(s?: string): string {
  if (!s) return "n/a";
  const n = Number(s);
  if (!isFinite(n)) return s;
  if (n === 0) return "free";
  return `$${(n * 1_000_000).toFixed(4)}/M`;
}

// ── Markdown table formatter ────────────────────────────────────────

/** Escape a cell value for markdown tables (pipe must be backslash-escaped). */
function mdCell(s: string): string {
  return s.replace(/\|/g, "\\|");
}

/**
 * Format model info as a pipe-delimited markdown table. One table per
 * endpoint. Renders with borders in any markdown viewer. Used by the
 * CLI `--markdown` flag and the `or_model_info` MCP tool.
 */
export function formatModelInfoMarkdown(
  data: ModelInfoData,
  modelId: string,
): string {
  const lines: string[] = [];
  lines.push(`# ${data.name ?? data.id ?? modelId}`);
  lines.push("");
  lines.push(`**id**: \`${data.id ?? modelId}\``);
  if (data.architecture) {
    const arch = data.architecture;
    const mods = [
      arch.input_modalities?.length ? `in: ${arch.input_modalities.join("/")}` : null,
      arch.output_modalities?.length ? `out: ${arch.output_modalities.join("/")}` : null,
      arch.tokenizer ? `tokenizer: ${arch.tokenizer}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    if (mods) lines.push(`**architecture**: ${mods}`);
  }
  if (data.description) {
    const desc = data.description.replace(/\s+/g, " ").trim();
    lines.push("");
    lines.push(desc.length > 400 ? desc.slice(0, 400) + "…" : desc);
  }
  lines.push("");

  const endpoints = data.endpoints ?? [];
  if (endpoints.length === 0) {
    lines.push("_No endpoints reported for this model._");
    return lines.join("\n");
  }

  const round = (n: number): string => Math.round(n).toString();

  for (const ep of endpoints) {
    const provider = ep.provider_name ?? ep.name ?? "unknown";
    lines.push(`## ${mdCell(provider)}`);
    lines.push("");

    // Build the table rows
    const rows: Array<[string, string]> = [];

    if (ep.name && ep.name !== provider) rows.push(["Endpoint name", ep.name]);
    if (ep.tag && ep.tag !== provider.toLowerCase()) rows.push(["Tag", ep.tag]);
    if (ep.status !== undefined) {
      rows.push(["Status", ep.status === 0 ? "operational" : `status code ${ep.status}`]);
    }
    if (ep.context_length !== undefined)
      rows.push(["Context length", `${ep.context_length.toLocaleString()} tokens`]);
    if (ep.max_completion_tokens !== undefined && ep.max_completion_tokens !== null)
      rows.push(["Max completion", `${ep.max_completion_tokens.toLocaleString()} tokens`]);
    if (ep.max_prompt_tokens !== undefined && ep.max_prompt_tokens !== null)
      rows.push(["Max prompt", `${ep.max_prompt_tokens.toLocaleString()} tokens`]);
    if (ep.quantization) rows.push(["Quantization", ep.quantization]);

    const params = new Set(ep.supported_parameters ?? []);
    rows.push([
      "Reasoning",
      params.has("reasoning") || params.has("include_reasoning") ? "yes" : "no",
    ]);
    rows.push(["Tool calling", params.has("tools") ? "yes" : "no"]);
    rows.push([
      "Structured output",
      params.has("structured_outputs") || params.has("response_format") ? "yes" : "no",
    ]);
    if (ep.supports_implicit_caching !== undefined) {
      rows.push(["Implicit caching", ep.supports_implicit_caching ? "yes" : "no"]);
    }

    if (ep.pricing) {
      const p = ep.pricing;
      rows.push(["Prompt price", formatPricePerM(p.prompt)]);
      rows.push(["Completion price", formatPricePerM(p.completion)]);
      if (p.input_cache_read) rows.push(["Cache-read price", formatPricePerM(p.input_cache_read)]);
      if (p.image) rows.push(["Image price", formatPricePerM(p.image)]);
      if (p.request) rows.push(["Request price", formatPricePerM(p.request)]);
      if (p.discount !== undefined && p.discount !== 0) {
        rows.push(["Discount", `${(p.discount * 100).toFixed(0)}% off`]);
      }
    }

    if (typeof ep.uptime_last_5m === "number")
      rows.push(["Uptime (5m)", `${ep.uptime_last_5m.toFixed(1)}%`]);
    if (typeof ep.uptime_last_30m === "number")
      rows.push(["Uptime (30m)", `${ep.uptime_last_30m.toFixed(1)}%`]);
    if (typeof ep.uptime_last_1d === "number")
      rows.push(["Uptime (1d)", `${ep.uptime_last_1d.toFixed(1)}%`]);

    for (const { key, value, numeric } of sortedPercentiles(ep.latency_last_30m)) {
      const annot = percentileAnnotation(numeric, false);
      const label = annot ? `Latency ${key} (${annot})` : `Latency ${key}`;
      rows.push([label, `${round(value)} ms`]);
    }
    for (const { key, value, numeric } of sortedPercentiles(ep.throughput_last_30m)) {
      const annot = percentileAnnotation(numeric, true);
      const label = annot ? `Throughput ${key} (${annot})` : `Throughput ${key}`;
      rows.push([label, `${round(value)} tok/s`]);
    }

    // Emit the markdown table
    lines.push("| Field | Value |");
    lines.push("|---|---|");
    for (const [label, value] of rows) {
      lines.push(`| ${mdCell(label)} | ${mdCell(value)} |`);
    }

    // Supported parameters as a bulleted list after the table
    // (multi-value cells don't render cleanly in markdown tables)
    if (Array.isArray(ep.supported_parameters) && ep.supported_parameters.length > 0) {
      const sorted = [...ep.supported_parameters].sort();
      lines.push("");
      lines.push(`**Supported parameters (${sorted.length}):**`);
      lines.push("");
      for (const p of sorted) lines.push(`- ✓ \`${p}\``);
    }

    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

// ── JSON formatter ──────────────────────────────────────────────────

/**
 * Pretty-print the raw OpenRouter model data as JSON. Used by the CLI
 * `--json` flag when the caller wants to pipe the full metadata into
 * another tool (jq, scripts, etc.) without losing any fields.
 */
export function formatModelInfoJson(
  data: ModelInfoData,
  _modelId: string,
): string {
  return JSON.stringify(data, null, 2);
}

// ── ANSI colors + box drawing ───────────────────────────────────────

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  bcyan: "\x1b[96m",
  bwhite: "\x1b[97m",
  bgreen: "\x1b[92m",
  byellow: "\x1b[93m",
  bred: "\x1b[91m",
} as const;

function paint(code: string, text: string, enabled: boolean): string {
  if (!enabled) return text;
  return `${code}${text}${ANSI.reset}`;
}

/** Visible length (strips ANSI escape sequences). */
// eslint-disable-next-line no-control-regex
const ANSI_STRIP_RE = /\u001b\[[0-9;]*m/g;
function visibleLength(s: string): number {
  return s.replace(ANSI_STRIP_RE, "").length;
}

function padRight(s: string, width: number): string {
  const vlen = visibleLength(s);
  if (vlen >= width) return s;
  return s + " ".repeat(width - vlen);
}

// ── Value classifiers ──────────────────────────────────────────────

function classifyUptime(pct: number | undefined): keyof typeof ANSI {
  if (pct === undefined) return "dim";
  if (pct >= 99) return "bgreen";
  if (pct >= 95) return "green";
  if (pct >= 90) return "yellow";
  return "bred";
}

function classifyLatencyMs(ms: number | undefined): keyof typeof ANSI {
  if (ms === undefined) return "dim";
  if (ms < 2000) return "bgreen";
  if (ms < 10000) return "green";
  if (ms < 30000) return "yellow";
  return "bred";
}

function classifyThroughput(tps: number | undefined): keyof typeof ANSI {
  if (tps === undefined) return "dim";
  if (tps >= 50) return "bgreen";
  if (tps >= 20) return "green";
  if (tps >= 10) return "yellow";
  return "bred";
}

function classifyPriceIsFree(s?: string): keyof typeof ANSI {
  if (!s) return "dim";
  const n = Number(s);
  if (isFinite(n) && n === 0) return "bgreen";
  return "byellow";
}

// ── Table formatter ────────────────────────────────────────────────

/**
 * Format model info as a Unicode-bordered table with ANSI colors.
 * Used by or_model_info_table MCP tool and the CLI model-info command.
 *
 * When the model has multiple endpoints, the output is one table per
 * endpoint stacked vertically — easier to read than a wide comparison
 * table when there are many metrics.
 */
export function formatModelInfoTable(
  data: ModelInfoData,
  modelId: string,
  colors: boolean = true,
): string {
  const out: string[] = [];
  const endpoints = data.endpoints ?? [];

  // ── Header box ─────────────────────────────────────────────────
  const title = data.name ?? data.id ?? modelId;
  const id = data.id ?? modelId;
  const titlePainted = paint(ANSI.bold + ANSI.bcyan, title, colors);
  const idPainted = paint(ANSI.dim, id, colors);

  // Pre-compute the architecture mods line so it can contribute to
  // the box width calculation — otherwise wide modality lists overflow
  // the right border.
  let modsLine: string | null = null;
  if (data.architecture) {
    const arch = data.architecture;
    const mods = [
      arch.input_modalities?.length ? `in: ${arch.input_modalities.join("/")}` : null,
      arch.output_modalities?.length ? `out: ${arch.output_modalities.join("/")}` : null,
      arch.tokenizer ? `tokenizer: ${arch.tokenizer}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    if (mods) modsLine = mods;
  }

  const innerTitleLen = visibleLength(titlePainted);
  const innerIdLen = visibleLength(idPainted) + "id: ".length;
  const innerModsLen = modsLine ? modsLine.length : 0;
  const boxInner = Math.max(innerTitleLen, innerIdLen, innerModsLen, 40);
  const topBorder = `┏${"━".repeat(boxInner + 2)}┓`;
  const bottomBorder = `┗${"━".repeat(boxInner + 2)}┛`;
  out.push(paint(ANSI.bcyan, topBorder, colors));
  out.push(
    paint(ANSI.bcyan, "┃ ", colors) +
      padRight(titlePainted, boxInner) +
      paint(ANSI.bcyan, " ┃", colors),
  );
  out.push(
    paint(ANSI.bcyan, "┃ ", colors) +
      padRight("id: " + idPainted, boxInner) +
      paint(ANSI.bcyan, " ┃", colors),
  );
  if (modsLine) {
    out.push(
      paint(ANSI.bcyan, "┃ ", colors) +
        padRight(paint(ANSI.dim, modsLine, colors), boxInner) +
        paint(ANSI.bcyan, " ┃", colors),
    );
  }
  out.push(paint(ANSI.bcyan, bottomBorder, colors));
  out.push("");

  // ── One table per endpoint ─────────────────────────────────────
  if (endpoints.length === 0) {
    out.push(paint(ANSI.yellow, "No endpoints reported for this model.", colors));
    return out.join("\n");
  }

  for (const ep of endpoints) {
    out.push(renderEndpointTable(ep, colors));
    out.push("");
  }

  // ── Legend ────────────────────────────────────────────────────
  out.push(paint(ANSI.dim, "─".repeat(72), colors));
  out.push(
    paint(ANSI.bold + ANSI.cyan, "Percentiles", colors) +
      paint(
        ANSI.dim,
        ": p50 = median (half of requests are faster) · p75 = 75th (1 in 4 slower) · p90 = 90th (1 in 10 slower) · p99 = worst 1%",
        colors,
      ),
  );
  out.push(
    paint(ANSI.bold + ANSI.cyan, "Colors    ", colors) +
      paint(ANSI.dim, ": ", colors) +
      paint(ANSI.bgreen, "excellent", colors) +
      paint(ANSI.dim, " · ", colors) +
      paint(ANSI.green, "good", colors) +
      paint(ANSI.dim, " · ", colors) +
      paint(ANSI.yellow, "borderline", colors) +
      paint(ANSI.dim, " · ", colors) +
      paint(ANSI.bred, "poor", colors),
  );
  out.push(
    paint(ANSI.bold + ANSI.cyan, "Pricing   ", colors) +
      paint(ANSI.dim, ": shown per 1,000,000 tokens (M). ", colors) +
      paint(ANSI.bgreen, "free", colors) +
      paint(ANSI.dim, " = $0, ", colors) +
      paint(ANSI.byellow, "$X.XXXX/M", colors) +
      paint(ANSI.dim, " = paid", colors),
  );

  return out.join("\n").trimEnd();
}

function renderEndpointTable(ep: ModelEndpoint, colors: boolean): string {
  const provider = ep.provider_name ?? ep.name ?? "unknown";
  // Each row is [label, value]. The value can be a single string or an
  // array of strings — arrays are rendered as a multi-line cell with the
  // label only on the first line and continuation rows for the rest.
  // Used for supported_parameters so related values are listed as a
  // column inside the table rather than packed side-by-side on one line.
  type Row = [string, string | string[]];
  const rows: Row[] = [];

  // Full endpoint backing name (often includes versioned model id)
  if (ep.name && ep.name !== provider) {
    rows.push(["Endpoint name", paint(ANSI.dim, ep.name, colors)]);
  }
  if (ep.tag && ep.tag !== provider.toLowerCase()) {
    rows.push(["Tag", paint(ANSI.dim, ep.tag, colors)]);
  }
  if (ep.status !== undefined) {
    const statusColor = ep.status === 0 ? ANSI.bgreen : ANSI.bred;
    const statusText = ep.status === 0 ? "operational" : `status code ${ep.status}`;
    rows.push(["Status", paint(statusColor, statusText, colors)]);
  }

  if (ep.context_length !== undefined) {
    rows.push([
      "Context length",
      paint(ANSI.bwhite, ep.context_length.toLocaleString(), colors) + " tokens",
    ]);
  }
  if (ep.max_completion_tokens !== undefined && ep.max_completion_tokens !== null) {
    rows.push([
      "Max completion",
      paint(ANSI.bwhite, ep.max_completion_tokens.toLocaleString(), colors) + " tokens",
    ]);
  }
  if (ep.max_prompt_tokens !== undefined && ep.max_prompt_tokens !== null) {
    rows.push([
      "Max prompt",
      paint(ANSI.bwhite, ep.max_prompt_tokens.toLocaleString(), colors) + " tokens",
    ]);
  }
  if (ep.quantization) {
    rows.push(["Quantization", paint(ANSI.dim, ep.quantization, colors)]);
  }

  // ── Capability flags ─────────────────────────────────────────
  // Derived from supported_parameters. These answer the "what can I
  // configure on this model?" question at a glance without reading the
  // full checkmark grid below.
  const params = new Set(ep.supported_parameters ?? []);
  const yes = () => paint(ANSI.bgreen, "yes", colors);
  const no = () => paint(ANSI.dim, "no", colors);
  rows.push([
    "Reasoning",
    params.has("reasoning") || params.has("include_reasoning") ? yes() : no(),
  ]);
  rows.push(["Tool calling", params.has("tools") ? yes() : no()]);
  rows.push([
    "Structured output",
    params.has("structured_outputs") || params.has("response_format") ? yes() : no(),
  ]);
  if (ep.supports_implicit_caching !== undefined) {
    rows.push([
      "Implicit caching",
      ep.supports_implicit_caching ? yes() : no(),
    ]);
  }

  if (ep.pricing) {
    const p = ep.pricing;
    rows.push([
      "Prompt price",
      paint(ANSI[classifyPriceIsFree(p.prompt)], formatPricePerM(p.prompt), colors),
    ]);
    rows.push([
      "Completion price",
      paint(ANSI[classifyPriceIsFree(p.completion)], formatPricePerM(p.completion), colors),
    ]);
    if (p.input_cache_read) {
      rows.push([
        "Cache-read price",
        paint(ANSI[classifyPriceIsFree(p.input_cache_read)], formatPricePerM(p.input_cache_read), colors),
      ]);
    }
    if (p.image) {
      rows.push([
        "Image price",
        paint(ANSI[classifyPriceIsFree(p.image)], formatPricePerM(p.image), colors),
      ]);
    }
    if (p.request) {
      rows.push([
        "Request price",
        paint(ANSI[classifyPriceIsFree(p.request)], formatPricePerM(p.request), colors),
      ]);
    }
    if (p.discount !== undefined && p.discount !== 0) {
      const discountPct = (p.discount * 100).toFixed(0);
      rows.push([
        "Discount",
        paint(ANSI.bgreen, `${discountPct}% off`, colors),
      ]);
    }
  }

  // Uptime — three time windows, each on its own row.
  // OpenRouter sometimes returns null for newly added or idle endpoints;
  // explicit null check is required (typeof null === "object").
  if (typeof ep.uptime_last_5m === "number") {
    rows.push([
      "Uptime (5m)",
      paint(ANSI[classifyUptime(ep.uptime_last_5m)], `${ep.uptime_last_5m.toFixed(1)}%`, colors),
    ]);
  }
  if (typeof ep.uptime_last_30m === "number") {
    rows.push([
      "Uptime (30m)",
      paint(ANSI[classifyUptime(ep.uptime_last_30m)], `${ep.uptime_last_30m.toFixed(1)}%`, colors),
    ]);
  }
  if (typeof ep.uptime_last_1d === "number") {
    rows.push([
      "Uptime (1d)",
      paint(ANSI[classifyUptime(ep.uptime_last_1d)], `${ep.uptime_last_1d.toFixed(1)}%`, colors),
    ]);
  }

  const round = (n: number): string => Math.round(n).toString();

  // Latency — one row per percentile (dynamically discovered).
  // Lower is better → p99 = worst 1%.
  for (const { key, value, numeric } of sortedPercentiles(ep.latency_last_30m)) {
    const annot = percentileAnnotation(numeric, /* higherIsBetter */ false);
    const label = annot ? `Latency ${key} (${annot})` : `Latency ${key}`;
    rows.push([label, paint(ANSI[classifyLatencyMs(value)], `${round(value)} ms`, colors)]);
  }

  // Throughput — one row per percentile (dynamically discovered).
  // Higher is better → p99 = best 1%.
  for (const { key, value, numeric } of sortedPercentiles(ep.throughput_last_30m)) {
    const annot = percentileAnnotation(numeric, /* higherIsBetter */ true);
    const label = annot ? `Throughput ${key} (${annot})` : `Throughput ${key}`;
    rows.push([label, paint(ANSI[classifyThroughput(value)], `${round(value)} tok/s`, colors)]);
  }

  // Supported parameters — one value per line inside a multi-line cell.
  // Listing values side-by-side is confusing; a column of checkmarks is
  // much easier to scan.
  if (Array.isArray(ep.supported_parameters) && ep.supported_parameters.length > 0) {
    const sorted = [...ep.supported_parameters].sort();
    const painted = sorted.map(
      (p) => paint(ANSI.green, "✓ ", colors) + paint(ANSI.bwhite, p, colors),
    );
    rows.push([
      `Supported params (${sorted.length})`,
      painted,
    ]);
  }

  // ── Column widths (account for multi-line cells) ─────────────
  const labelW = Math.max(...rows.map((r) => r[0].length), "Endpoint".length);
  const valueW = Math.max(
    ...rows.flatMap((r) => {
      const v = r[1];
      return Array.isArray(v) ? v.map(visibleLength) : [visibleLength(v)];
    }),
    provider.length,
  );

  // Bright border color — cyan was previously rendered dim, which is
  // nearly invisible on many terminals. Use bright cyan throughout.
  const BORDER = ANSI.bcyan;

  const top = `┌${"─".repeat(labelW + 2)}┬${"─".repeat(valueW + 2)}┐`;
  const sep = `├${"─".repeat(labelW + 2)}┼${"─".repeat(valueW + 2)}┤`;
  const bot = `└${"─".repeat(labelW + 2)}┴${"─".repeat(valueW + 2)}┘`;

  const lines: string[] = [];
  lines.push(paint(BORDER, top, colors));
  lines.push(
    paint(BORDER, "│ ", colors) +
      padRight(paint(ANSI.bold + ANSI.cyan, "Endpoint", colors), labelW) +
      paint(BORDER, " │ ", colors) +
      padRight(paint(ANSI.bold + ANSI.bwhite, provider, colors), valueW) +
      paint(BORDER, " │", colors),
  );
  lines.push(paint(BORDER, sep, colors));

  // Render each logical row, followed by a separator. Multi-line cells
  // (arrays) render as a group with NO internal separator — the label
  // only appears on the first line — and a single `├─┼─┤` row after the
  // whole group. This keeps supported_parameters visually grouped.
  for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
    const [label, value] = rows[rowIdx];
    const values = Array.isArray(value) ? value : [value];
    // First line: label + first value
    lines.push(
      paint(BORDER, "│ ", colors) +
        padRight(paint(ANSI.cyan, label, colors), labelW) +
        paint(BORDER, " │ ", colors) +
        padRight(values[0] ?? "", valueW) +
        paint(BORDER, " │", colors),
    );
    // Continuation lines (multi-line cell): empty label column, next value
    for (let i = 1; i < values.length; i++) {
      lines.push(
        paint(BORDER, "│ ", colors) +
          padRight("", labelW) +
          paint(BORDER, " │ ", colors) +
          padRight(values[i], valueW) +
          paint(BORDER, " │", colors),
      );
    }
    // Separator between logical rows (not after the last one — the
    // bottom border serves as closer).
    if (rowIdx < rows.length - 1) {
      lines.push(paint(BORDER, sep, colors));
    }
  }
  lines.push(paint(BORDER, bot, colors));

  return lines.join("\n");
}
