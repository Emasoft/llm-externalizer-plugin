import type { Readable } from "node:stream";

/**
 * Reads a stream to its end and returns the bytes. The stream must be a byte stream (no encoding set, not object mode), because Buffer.concat throws on string or object chunks.
 * WHY it exists (TRDD-S3QEQBYV): tests pass a real stream here instead of a stdin double; production passes process.stdin (main.ts readAllStdin, which keeps the TTY refusal).
 */
export async function readAllFrom(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  // WHY the raw Buffer (IN-01): the file reader sniffs NUL bytes and reports invalid UTF-8, which a decoded string has already lost; the JSON path decodes it.
  return Buffer.concat(chunks);
}
