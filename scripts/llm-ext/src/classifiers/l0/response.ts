import { safeReadText } from "../../safe-body.js";
import { badResponseError } from "./errors.js";

export interface ReplyUsage {
  input_tokens: number;
  output_tokens: number;
  cost?: number;
}

/** A decisions reply that passed the shape checks (plan §3). `model` is the served build (snapshot). */
export interface RawDecisionsReply {
  model: string;
  answers: Record<string, unknown>;
  usage: ReplyUsage;
  id?: string;
  provider?: string;
}

const MAX_BODY_BYTES = 1_000_000; // plan §7 Body

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/**
 * Parse a 200 decisions reply body from a Response. `record` receives the usage as soon as it is known to be valid and BEFORE
 * model and answers are checked: an invalid but billed reply must still be counted (plan §7). A missing or
 * malformed `usage` is never recorded, so nothing is counted as free (E13).
 */
export async function parseDecisionsReply(
  res: Response,
  record: (usage: ReplyUsage, model: unknown) => void,
): Promise<RawDecisionsReply> {
  let text: string;
  try {
    text = await safeReadText(res, MAX_BODY_BYTES);
  } catch (e) {
    throw badResponseError(e instanceof Error ? e.message : String(e));
  }
  return parseDecisionsText(text, record);
}

/**
 * The same checks on the body text. WHY separate: the transport already holds the text, so the caller's parser runs inside callDecisions
 * (CallOptions.parseReply) and the body is parsed once, with no clone of the Response.
 */
export function parseDecisionsText(text: string, record: (usage: ReplyUsage, model: unknown) => void): RawDecisionsReply {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // E01: a proxy page or truncated body; the sanitized excerpt shows what arrived.
    throw badResponseError(`200 reply is not JSON: ${text}`);
  }
  if (!isObject(raw)) throw badResponseError(`200 reply is not a JSON object: ${text}`);
  const u = raw.usage;
  if (!isObject(u) || !isCount(u.input_tokens) || !isCount(u.output_tokens) || (u.cost !== undefined && !isCount(u.cost))) {
    throw badResponseError(`reply has missing or invalid usage: ${text}`);
  }
  const usage: ReplyUsage = { input_tokens: u.input_tokens, output_tokens: u.output_tokens };
  if (u.cost !== undefined) usage.cost = u.cost as number;
  record(usage, raw.model);
  if (typeof raw.model !== "string" || raw.model.trim() === "") throw badResponseError(`reply has missing or blank model: ${text}`);
  if (!isObject(raw.answers)) throw badResponseError(`reply answers is not an object: ${text}`);
  const reply: RawDecisionsReply = { model: raw.model, answers: raw.answers, usage };
  if (typeof raw.id === "string") reply.id = raw.id;
  if (typeof raw.provider === "string") reply.provider = raw.provider;
  return reply;
}
