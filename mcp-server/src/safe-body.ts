/**
 * Bounded response body readers.
 *
 * `await res.text()` and `await res.json()` are uncapped: a buggy or
 * malicious upstream could return gigabytes of body and crash the
 * MCP server with an OOM (v9.10.0 audit T2.6). The safe* helpers below
 * stream the body via getReader() with a hard byte cap and throw a
 * clear error when exceeded. Default cap (32 MiB) is generous —
 * OpenRouter chat completions are typically <1 MiB, and /v1/models
 * returns ~500 KiB today.
 *
 * Exported as a small standalone module so index.ts and or-model-info.ts
 * share a single source of truth for the cap.
 */

export const MAX_RESPONSE_BYTES = Number(
  process.env.LLM_EXT_MAX_RESPONSE_BYTES ?? 32 * 1024 * 1024,
);

export async function safeReadText(
  res: Response,
  maxBytes: number = MAX_RESPONSE_BYTES,
): Promise<string> {
  // Honor Content-Length when present — bail out before allocating the
  // body buffer if the server tells us up-front it would exceed the cap.
  const cl = res.headers.get("content-length");
  if (cl !== null) {
    const n = Number(cl);
    if (Number.isFinite(n) && n > maxBytes) {
      throw new Error(
        `Response body Content-Length (${n} bytes) exceeds the ${maxBytes}-byte cap; refusing to load into memory. Override with LLM_EXT_MAX_RESPONSE_BYTES if your workload genuinely needs more.`,
      );
    }
  }
  if (!res.body) {
    // No streaming body (e.g. HEAD response, or stub Response with text()
    // backed by an in-memory buffer). Fall back to text() and check
    // the length post-hoc.
    const t = await res.text();
    if (t.length > maxBytes) {
      throw new Error(
        `Response body (${t.length} bytes after read) exceeds the ${maxBytes}-byte cap. Override with LLM_EXT_MAX_RESPONSE_BYTES.`,
      );
    }
    return t;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        /* best-effort */
      }
      throw new Error(
        `Response body exceeded ${maxBytes}-byte cap (saw ${total} bytes so far). Override with LLM_EXT_MAX_RESPONSE_BYTES if intentional.`,
      );
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}

export async function safeReadJson<T = unknown>(
  res: Response,
  maxBytes: number = MAX_RESPONSE_BYTES,
): Promise<T> {
  const text = await safeReadText(res, maxBytes);
  return JSON.parse(text) as T;
}
