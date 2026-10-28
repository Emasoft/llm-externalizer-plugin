/**
 * provider/request-options.ts — per-tool request options for a local llama.cpp
 * profile (TRDD-1OOAH3LD increment 1). Pure helpers: no I/O except the one-time
 * stderr notice, no imports from index.ts or config.ts values (type-only).
 *
 * Applies only to a profile that sets `request_options`; every other profile
 * gets `null` and its request body stays byte-for-byte what it was.
 */

import type { RequestOptionsConfig, RequestOptionBlock } from "../config.js";
import type { ChatMessage } from "./types.js";
import { registeredTools } from "../model-qualification/registry.js";

/** Message prefix of {@link OutputLimitError}; classifyError matches on it. */
export const OUTPUT_LIMIT_PREFIX = "OUTPUT LIMIT: ";

/** Options after merging `default` and the tool block (tool wins). */
export interface ResolvedRequestOptions {
  maxOutputTokens: number;
  /** undefined = the request does not mention thinking at all. */
  thinking?: boolean;
  temperature?: number;
  topK?: number;
  repeatPenalty?: number;
}

/**
 * A reply cut off by the length limit on a request_options profile. Thrown
 * after exactly one POST: a retry would burn the same budget and hit the same
 * limit, and an HTTP 200 reply is a working transport, so this is not breaker
 * food.
 */
export class OutputLimitError extends Error {
  readonly tool: string | undefined;
  readonly model: string;
  readonly maxTokens: number;
  readonly completionTokens: number | undefined;
  readonly partialChars: number;

  constructor(args: {
    tool: string | undefined;
    model: string;
    maxTokens: number;
    /** true when the effective cap is the CALLER's own smaller maxTokens, not the profile's max_output_tokens. */
    callerCap: boolean;
    completionTokens: number | undefined;
    partial: string;
  }) {
    // O2: only a registered tool name is a valid request_options block key (validateProfile
    // refuses others, e.g. batch_check), so any other tool is pointed at the default block.
    const key = args.tool !== undefined && registeredTools().includes(args.tool) ? args.tool : "default";
    const fix = args.callerCap
      ? `The cap came from the tool's own smaller max_tokens, so raising request_options.${key}.max_output_tokens changes nothing; set thinking off or simplify the task.`
      : `Raise request_options.${key}.max_output_tokens or set thinking off.`;
    super(
      `${OUTPUT_LIMIT_PREFIX}${args.tool ?? "unknown tool"} on ${args.model} hit max_tokens=${args.maxTokens} ` +
        `(${args.completionTokens ?? "unknown"} completion tokens, ${args.partial.length} chars of partial text). ${fix}`,
    );
    this.name = "OutputLimitError";
    this.tool = args.tool;
    this.model = args.model;
    this.maxTokens = args.maxTokens;
    this.completionTokens = args.completionTokens;
    this.partialChars = args.partial.length;
  }
}

/**
 * Merge `default` and the tool block (tool wins field by field). null config =
 * no request options. A tool name outside the config (or undefined) gets the
 * default block. Fails fast when no max_output_tokens resolves: max_tokens is
 * always explicit on this path and validateProfile already requires it.
 */
export function resolveRequestOptions(
  cfg: RequestOptionsConfig | null,
  tool: string | undefined,
): ResolvedRequestOptions | null {
  if (cfg === null) return null;
  const toolBlock: RequestOptionBlock | undefined =
    tool !== undefined && tool !== "default" ? cfg[tool] : undefined;
  const merged: RequestOptionBlock = { ...cfg.default, ...toolBlock };
  if (merged.max_output_tokens === undefined) {
    throw new Error("request_options: no max_output_tokens resolved (request_options.default.max_output_tokens is required)");
  }
  const out: ResolvedRequestOptions = { maxOutputTokens: merged.max_output_tokens };
  // YAML 1.2 loads unquoted on/off as strings; normalize to one boolean shape here.
  if (merged.thinking !== undefined) out.thinking = merged.thinking === true || merged.thinking === "on";
  if (merged.temperature !== undefined) out.temperature = merged.temperature;
  if (merged.top_k !== undefined) out.topK = merged.top_k;
  if (merged.repeat_penalty !== undefined) out.repeatPenalty = merged.repeat_penalty;
  return out;
}

/**
 * The max_tokens to send: a CEILING. The caller's own cap is never raised
 * (a tool that asks for a small reply keeps it), only lowered to the profile cap.
 */
export function effectiveMaxTokens(ro: ResolvedRequestOptions, callerMaxTokens: number | undefined): number {
  return callerMaxTokens === undefined ? ro.maxOutputTokens : Math.min(callerMaxTokens, ro.maxOutputTokens);
}

/** Copy of `body` with the request options applied. Never mutates the input. */
export function applyRequestOptions(
  body: Record<string, unknown>,
  ro: ResolvedRequestOptions,
  callerMaxTokens: number | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body, max_tokens: effectiveMaxTokens(ro, callerMaxTokens) };
  if (ro.temperature !== undefined) out.temperature = ro.temperature;
  if (ro.topK !== undefined) out.top_k = ro.topK;
  if (ro.repeatPenalty !== undefined) out.repeat_penalty = ro.repeatPenalty;
  // Only when explicitly set: a template without the switch must see no change.
  if (ro.thinking !== undefined) out.chat_template_kwargs = { enable_thinking: ro.thinking };
  return out;
}

/**
 * Tell the model to finish inside the cap. Returns a COPY: the sentence is
 * appended to the FIRST system message (a system message is prepended only when
 * none exists). WHY never a second system message: llama.cpp chat templates may
 * reject a system message that is not first.
 */
export function withStopInstruction(messages: readonly ChatMessage[], maxTokens: number): ChatMessage[] {
  const sentence = `Answer the task directly and concisely, then stop; the whole reply must fit in ${maxTokens} tokens.`;
  const copy = messages.map((m) => ({ ...m }));
  // O4: the FIRST system message wherever it sits, so a list never gets a second one.
  const at = copy.findIndex((m) => m.role === "system");
  if (at !== -1) {
    copy[at]!.content = `${copy[at]!.content}\n\n${sentence}`;
    return copy;
  }
  return [{ role: "system", content: sentence }, ...copy];
}

let noToolContextWarned = false;

/**
 * request_options exists but the call carries no tool name (no usage context):
 * the default block is used. Say so once per process, on stderr, so the missing
 * wiring is visible instead of silently ignoring per-tool blocks.
 */
export function warnNoToolContextOnce(): void {
  if (noToolContextWarned) return;
  noToolContextWarned = true;
  process.stderr.write(
    "[llm-externalizer] request_options: no tool context found for this call; using the default block\n",
  );
}

export function resetNoToolContextWarningForTests(): void {
  noToolContextWarned = false;
}
