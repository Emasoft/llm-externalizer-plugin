/**
 * or_model_info_json tool handler: the body of index.ts's `case "or_model_info_json"` in dispatchCallToolInner, moved here
 * unchanged (TRDD-TYSKX72I). WHY: the ubs taint scan ran out of work budget on index.ts, whose size it multiplies;
 * moving the biggest case bodies out keeps the scan finishing with the compare_files spawnSync sinks still scanned.
 * What the body read from dispatchCallToolInner locals and from index.ts module state arrives in `call` and `deps`
 * (a module must not import index.ts); the values that can change while a command runs (activeResolved,
 * activeSettings) are read live through `deps`, as the inline body read the module bindings.
 */

import { fetchOpenRouterModelInfo, formatModelInfoJson, formatModelInfoTable, formatModelInfoMarkdown } from "../or-model-info.js";
import { sanitizeInputPath } from "../scan-pipeline.js";
import { writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { CaseCall, CaseDeps, ToolResult } from "./dispatch-deps.js";

export async function handleOrModelInfoJson(call: CaseCall, deps: Pick<CaseDeps, "activeResolved">): Promise<ToolResult> {
  const { args, backend, name } = call;
  const { model: infoModel, file_path: infoFilePath } = args as {
    model?: string;
    file_path?: string;
  };
  if (!infoModel || typeof infoModel !== "string") {
    return {
      content: [
        {
          type: "text",
          text: `FAILED: \`model\` parameter is required. Pass the exact OpenRouter model id, e.g. 'nvidia/nemotron-3-super-120b-a12b:free'.`,
        },
      ],
      isError: true,
    };
  }
  if (backend.type !== "openrouter") {
    return {
      content: [
        {
          type: "text",
          text: `${name} only works with OpenRouter backends. Active profile is '${deps.activeResolved?.name}' (${deps.activeResolved?.mode}). Switch to a remote profile to query model metadata.`,
        },
      ],
      isError: true,
    };
  }

  const result = await fetchOpenRouterModelInfo(
    infoModel,
    backend.baseUrl,
    backend.apiKey,
  );
  if (!result.ok) {
    // Friendly error messages per status code. OpenRouter uses
    // the standard HTTP error code set — see
    // docs/openrouter/errors-and-debugging.md.
    let msg: string;
    switch (result.status) {
      case 400:
        msg = `FAILED: OpenRouter rejected the request for '${infoModel}' (400 Bad Request). ${result.error}`;
        break;
      case 401:
        msg = `FAILED: OpenRouter authentication failed (401). Check that $OPENROUTER_API_KEY is set and valid — run 'discover' to verify.`;
        break;
      case 402:
        msg = `FAILED: OpenRouter credit exhausted (402). Add credits at https://openrouter.ai/credits or fall back to a :free model.`;
        break;
      case 403:
        msg = `FAILED: OpenRouter blocked the request for '${infoModel}' (403 Forbidden). The model may require moderation approval or be unavailable in your region.`;
        break;
      case 404:
        msg = `FAILED: OpenRouter returned 404 for model '${infoModel}'. Check the id — case-sensitive, requires vendor prefix and any ':free' / ':thinking' suffix.`;
        break;
      case 408:
        msg = `FAILED: OpenRouter request timed out (408). Retry in a moment.`;
        break;
      case 429:
        msg = `FAILED: OpenRouter rate limit hit (429). Wait a few seconds before retrying.`;
        break;
      case 502:
      case 503:
      case 504:
        msg = `FAILED: OpenRouter upstream error (${result.status}). The provider is down or unreachable — retry later.`;
        break;
      default:
        msg = `FAILED: ${result.error}${result.status ? ` (status ${result.status})` : ""}`;
    }
    return {
      content: [{ type: "text", text: msg }],
      isError: true,
    };
  }

  // JSON branch: optionally write to a file, returning only the
  // absolute path so the caller's context isn't flooded.
  if (name === "or_model_info_json") {
    const jsonText = formatModelInfoJson(result.data, infoModel);
    if (infoFilePath && typeof infoFilePath === "string" && infoFilePath.trim()) {
      const rawPath = infoFilePath.trim();
      // Enforce absolute paths — relative paths silently resolve
      // against process.cwd() which may surprise the caller and
      // opens a small path-confusion window.
      if (!isAbsolute(rawPath)) {
        return {
          content: [
            {
              type: "text",
              text: `FAILED: file_path must be an absolute path (e.g. /tmp/model-info.json). Got '${rawPath}'.`,
            },
          ],
          isError: true,
        };
      }
      let absPath: string;
      try {
        // Run the path through the same traversal guard as every other
        // file-writing surface in this server. Without this an LLM that
        // controls the tool call could overwrite arbitrary user-writable
        // files outside the project / home / tmp roots.
        absPath = sanitizeInputPath(rawPath);
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `FAILED: refusing to write JSON to ${rawPath}: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
      try {
        writeFileSync(absPath, jsonText, "utf-8");
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `FAILED: could not write JSON to '${absPath}': ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          { type: "text", text: `JSON written to ${absPath}` },
        ],
      };
    }
    return {
      content: [{ type: "text", text: jsonText }],
    };
  }

  const text =
    name === "or_model_info_table"
      ? formatModelInfoTable(result.data, infoModel, true)
      : formatModelInfoMarkdown(result.data, infoModel);

  return {
    content: [{ type: "text", text }],
  };
}
