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

export interface ModelEndpointLatency {
  p50?: number;
  p75?: number;
  p90?: number;
  p99?: number;
}

export interface ModelEndpoint {
  name?: string;
  provider_name?: string;
  context_length?: number;
  max_completion_tokens?: number;
  max_prompt_tokens?: number | null;
  quantization?: string;
  pricing?: ModelEndpointPricing;
  supported_parameters?: string[];
  status?: number;
  uptime_last_30m?: number;
  uptime_last_5m?: number;
  uptime_last_1d?: number;
  latency_last_30m?: ModelEndpointLatency;
  throughput_last_30m?: ModelEndpointLatency;
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
 * Fetch model metadata from OpenRouter. Returns a tagged union so callers
 * can distinguish "data" from "error" without exceptions.
 */
export async function fetchOpenRouterModelInfo(
  modelId: string,
  baseUrl: string,
  authToken: string,
): Promise<FetchModelInfoResult> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/v1/models/${modelId}/endpoints`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
  } catch (err) {
    return {
      ok: false,
      error: `Network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
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

// ── Markdown formatter ──────────────────────────────────────────────

/**
 * Format model info as plain markdown. Used by or_model_info MCP tool
 * for programmatic / non-terminal consumers.
 */
export function formatModelInfoMarkdown(
  data: ModelInfoData,
  modelId: string,
): string {
  const lines: string[] = [];
  lines.push(`# ${data.name ?? data.id ?? modelId}`);
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
    lines.push(
      `**description**: ${desc.length > 400 ? desc.slice(0, 400) + "…" : desc}`,
    );
  }
  lines.push("");
  const endpoints = data.endpoints ?? [];
  lines.push(`## Endpoints (${endpoints.length})`);

  for (const ep of endpoints) {
    lines.push("");
    lines.push(`### ${ep.provider_name ?? ep.name ?? "unknown"}`);
    if (ep.context_length !== undefined)
      lines.push(`- **context_length**: ${ep.context_length.toLocaleString()} tokens`);
    if (ep.max_completion_tokens !== undefined && ep.max_completion_tokens !== null)
      lines.push(`- **max_completion_tokens**: ${ep.max_completion_tokens.toLocaleString()}`);
    if (ep.max_prompt_tokens !== null && ep.max_prompt_tokens !== undefined)
      lines.push(`- **max_prompt_tokens**: ${ep.max_prompt_tokens.toLocaleString()}`);
    if (ep.quantization) lines.push(`- **quantization**: ${ep.quantization}`);

    if (ep.pricing) {
      const p = ep.pricing;
      lines.push(
        `- **pricing**: prompt ${formatPricePerM(p.prompt)}, completion ${formatPricePerM(p.completion)}` +
          (p.input_cache_read ? `, cache-read ${formatPricePerM(p.input_cache_read)}` : ""),
      );
    }

    if (Array.isArray(ep.supported_parameters) && ep.supported_parameters.length > 0) {
      const sorted = [...ep.supported_parameters].sort();
      lines.push(`- **supported_parameters** (${sorted.length}): ${sorted.join(", ")}`);
    }

    if (ep.uptime_last_30m !== undefined) {
      const up30m = ep.uptime_last_30m?.toFixed(1);
      const up1d = ep.uptime_last_1d?.toFixed(1);
      lines.push(`- **uptime**: ${up30m}% (30m) · ${up1d}% (1d)`);
    }

    const r = (n: number | undefined): string =>
      n === undefined ? "?" : Math.round(n).toString();

    if (ep.latency_last_30m) {
      const l = ep.latency_last_30m;
      lines.push(
        `- **latency** (30m): p50 ${r(l.p50)}ms · p75 ${r(l.p75)}ms · p90 ${r(l.p90)}ms · p99 ${r(l.p99)}ms`,
      );
    }

    if (ep.throughput_last_30m) {
      const t = ep.throughput_last_30m;
      lines.push(
        `- **throughput** (30m): p50 ${r(t.p50)} tok/s · p75 ${r(t.p75)} tok/s · p90 ${r(t.p90)} tok/s · p99 ${r(t.p99)} tok/s`,
      );
    }
  }

  return lines.join("\n");
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
  const innerTitleLen = visibleLength(titlePainted);
  const innerIdLen = visibleLength(idPainted) + 5; // "id: " prefix + 1 space
  const boxInner = Math.max(innerTitleLen, innerIdLen, 40);
  const topBorder = `┏${"━".repeat(boxInner + 2)}┓`;
  const bottomBorder = `┗${"━".repeat(boxInner + 2)}┛`;
  out.push(paint(ANSI.cyan, topBorder, colors));
  out.push(
    paint(ANSI.cyan, "┃ ", colors) +
      padRight(titlePainted, boxInner) +
      paint(ANSI.cyan, " ┃", colors),
  );
  out.push(
    paint(ANSI.cyan, "┃ ", colors) +
      padRight("id: " + idPainted, boxInner) +
      paint(ANSI.cyan, " ┃", colors),
  );
  if (data.architecture) {
    const arch = data.architecture;
    const mods = [
      arch.input_modalities?.length ? `in: ${arch.input_modalities.join("/")}` : null,
      arch.output_modalities?.length ? `out: ${arch.output_modalities.join("/")}` : null,
      arch.tokenizer ? `tokenizer: ${arch.tokenizer}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    if (mods) {
      out.push(
        paint(ANSI.cyan, "┃ ", colors) +
          padRight(paint(ANSI.dim, mods, colors), boxInner) +
          paint(ANSI.cyan, " ┃", colors),
      );
    }
  }
  out.push(paint(ANSI.cyan, bottomBorder, colors));
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
  type Row = [string, string]; // [label, value (may contain ANSI)]
  const rows: Row[] = [];

  if (ep.context_length !== undefined) {
    rows.push([
      "Context length",
      paint(ANSI.bwhite, ep.context_length.toLocaleString(), colors) + " tokens",
    ]);
  }
  if (ep.max_completion_tokens !== undefined && ep.max_completion_tokens !== null) {
    rows.push([
      "Max completion",
      paint(ANSI.bwhite, ep.max_completion_tokens.toLocaleString(), colors),
    ]);
  }
  if (ep.max_prompt_tokens !== undefined && ep.max_prompt_tokens !== null) {
    rows.push([
      "Max prompt",
      paint(ANSI.bwhite, ep.max_prompt_tokens.toLocaleString(), colors),
    ]);
  }
  if (ep.quantization) {
    rows.push(["Quantization", paint(ANSI.dim, ep.quantization, colors)]);
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
  }

  if (ep.uptime_last_30m !== undefined) {
    const col = ANSI[classifyUptime(ep.uptime_last_30m)];
    rows.push(["Uptime (30m)", paint(col, `${ep.uptime_last_30m.toFixed(1)}%`, colors)]);
  }
  if (ep.uptime_last_1d !== undefined) {
    const col = ANSI[classifyUptime(ep.uptime_last_1d)];
    rows.push(["Uptime (1d)", paint(col, `${ep.uptime_last_1d.toFixed(1)}%`, colors)]);
  }

  const round = (n: number | undefined): string =>
    n === undefined ? "?" : Math.round(n).toString();

  if (ep.latency_last_30m) {
    const l = ep.latency_last_30m;
    const latencyLine = [
      paint(ANSI[classifyLatencyMs(l.p50)], `p50 ${round(l.p50)}ms`, colors),
      paint(ANSI[classifyLatencyMs(l.p75)], `p75 ${round(l.p75)}ms`, colors),
      paint(ANSI[classifyLatencyMs(l.p90)], `p90 ${round(l.p90)}ms`, colors),
      paint(ANSI[classifyLatencyMs(l.p99)], `p99 ${round(l.p99)}ms`, colors),
    ].join(" · ");
    rows.push(["Latency (30m)", latencyLine]);
  }

  if (ep.throughput_last_30m) {
    const t = ep.throughput_last_30m;
    const tpLine = [
      paint(ANSI[classifyThroughput(t.p50)], `p50 ${round(t.p50)} tok/s`, colors),
      paint(ANSI[classifyThroughput(t.p75)], `p75 ${round(t.p75)} tok/s`, colors),
      paint(ANSI[classifyThroughput(t.p90)], `p90 ${round(t.p90)} tok/s`, colors),
      paint(ANSI[classifyThroughput(t.p99)], `p99 ${round(t.p99)} tok/s`, colors),
    ].join(" · ");
    rows.push(["Throughput (30m)", tpLine]);
  }

  // ── Column widths ─────────────────────────────────────────────
  const labelW = Math.max(...rows.map((r) => r[0].length), "Endpoint".length);
  const valueW = Math.max(...rows.map((r) => visibleLength(r[1])), provider.length);

  const top = `┌${"─".repeat(labelW + 2)}┬${"─".repeat(valueW + 2)}┐`;
  const sep = `├${"─".repeat(labelW + 2)}┼${"─".repeat(valueW + 2)}┤`;
  const bot = `└${"─".repeat(labelW + 2)}┴${"─".repeat(valueW + 2)}┘`;

  const lines: string[] = [];
  lines.push(paint(ANSI.dim, top, colors));
  lines.push(
    paint(ANSI.dim, "│ ", colors) +
      padRight(paint(ANSI.bold + ANSI.cyan, "Endpoint", colors), labelW) +
      paint(ANSI.dim, " │ ", colors) +
      padRight(paint(ANSI.bold + ANSI.bwhite, provider, colors), valueW) +
      paint(ANSI.dim, " │", colors),
  );
  lines.push(paint(ANSI.dim, sep, colors));
  for (const [label, value] of rows) {
    lines.push(
      paint(ANSI.dim, "│ ", colors) +
        padRight(paint(ANSI.cyan, label, colors), labelW) +
        paint(ANSI.dim, " │ ", colors) +
        padRight(value, valueW) +
        paint(ANSI.dim, " │", colors),
    );
  }
  lines.push(paint(ANSI.dim, bot, colors));

  // ── Supported parameters (after the table, as a grid) ─────────
  if (Array.isArray(ep.supported_parameters) && ep.supported_parameters.length > 0) {
    const sorted = [...ep.supported_parameters].sort();
    lines.push("");
    lines.push(
      paint(ANSI.bold + ANSI.cyan, `Supported parameters (${sorted.length}):`, colors),
    );
    const colWidth =
      sorted.reduce((m, s) => Math.max(m, s.length), 0) + 4; // ✓ + space + name + spacing
    const cols = Math.max(1, Math.floor(80 / colWidth));
    for (let i = 0; i < sorted.length; i += cols) {
      const row = sorted
        .slice(i, i + cols)
        .map((p) =>
          padRight(paint(ANSI.green, "✓ ", colors) + paint(ANSI.bwhite, p, colors), colWidth),
        )
        .join("");
      lines.push("  " + row);
    }
  }

  return lines.join("\n");
}
