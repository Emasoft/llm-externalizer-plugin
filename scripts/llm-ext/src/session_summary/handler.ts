/**
 * session_summary tool handler: the body of index.ts's `case "session_summary"` in dispatchCallToolInner, moved here
 * unchanged (TRDD-TYSKX72I). WHY: the ubs taint scan ran out of work budget on index.ts, whose size it multiplies;
 * moving the biggest case bodies out keeps the scan finishing with the compare_files spawnSync sinks still scanned.
 * What the body read from dispatchCallToolInner locals and from index.ts module state arrives in `call` and `deps`
 * (a module must not import index.ts); the values that can change while a command runs (activeResolved,
 * activeSettings) are read live through `deps`, as the inline body read the module bindings.
 */

import { brokerClientVersion, defaultBrokerEntry } from "../broker/client.js";
import { ensureCalibrator } from "../calibration/runner.js";
import { stoppableSleep, commandStopReason } from "../command-stop.js";
import { getConfigDir } from "../config.js";
import { waitForCalibration } from "../local-input-budget.js";
import { chatCompletionWithRetry } from "../provider/completion.js";
import { DEFAULT_CHUNK_TIMEOUT_MS, type CallModelFn, type ChunkEvent, summarizeSession } from "../session_summary/driver.js";
import { resolveSessionSummaryChain } from "../session_summary/local-model.js";
import { selectModels } from "../session_summary/model-select.js";
import { formatSizeReport } from "../session_summary/size-report.js";
import { untilDoneBackoffMs, looksQuotaCapped } from "../session_summary/until-done.js";
import { resolveTranscriptPath, defaultCheckpointPath } from "../session-summary-resolve.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { CaseCall, CaseDeps, ToolResult } from "../tools/dispatch-deps.js";

export async function handleSessionSummary(call: CaseCall, deps: Pick<CaseDeps, "DEFAULT_TEMPERATURE" | "activeResolved" | "activeSettings" | "brokerSlotCtx" | "makeBackendFromProfile" | "makeProviderDeps" | "providerDeps" | "saveResponse" | "startCalibration">): Promise<ToolResult> {
  const { args, onProgress } = call;
  const { DEFAULT_TEMPERATURE, brokerSlotCtx, makeBackendFromProfile, makeProviderDeps, providerDeps, saveResponse, startCalibration } = deps;
  const {
    transcript: ssTranscript,
    session_id: ssSessionId,
    prune: ssPruneRaw,
    min_context: ssMinContext,
    resume: ssResume,
    checkpoint: ssCheckpointRaw,
    output: ssOutputRaw,
    stdout: ssStdoutRaw,
    max_chunk_tokens: ssMaxChunkTokens,
    concurrency: ssConcurrencyRaw,
    chunk_timeout_s: ssChunkTimeoutSecRaw,
    max_retries_per_chunk: ssMaxRetriesRaw,
    until_done: ssUntilDoneRaw,
  } = args as {
    transcript?: string;
    session_id?: string;
    prune?: string;
    min_context?: number;
    resume?: boolean;
    checkpoint?: string;
    output?: string;
    stdout?: boolean;
    max_chunk_tokens?: number;
    concurrency?: number;
    chunk_timeout_s?: number;
    max_retries_per_chunk?: number;
    until_done?: boolean;
  };

  // Per-chunk deadline. An explicit value is honored verbatim (including a
  // very large one — the caller, not this code, decides how long they are
  // willing to wait); omitted, it defaults to a value well under the
  // global soft timeout because a concurrent run's wall-clock is its
  // SLOWEST chunk.
  const ssPerChunkTimeoutMs =
    typeof ssChunkTimeoutSecRaw === "number" && ssChunkTimeoutSecRaw > 0
      ? Math.round(ssChunkTimeoutSecRaw * 1000)
      : DEFAULT_CHUNK_TIMEOUT_MS;

  const VALID_PRUNE_LEVELS = new Set(["aggressive", "moderate", "none"]);
  const prune = ssPruneRaw ?? "aggressive";
  if (!VALID_PRUNE_LEVELS.has(prune)) {
    return {
      content: [
        {
          type: "text",
          text: `FAILED: --prune must be one of aggressive, moderate, none (got '${prune}')`,
        },
      ],
      isError: true,
    };
  }

  let transcriptPath: string;
  try {
    transcriptPath = resolveTranscriptPath({
      transcriptPath: ssTranscript,
      sessionId: ssSessionId,
    });
  } catch (err) {
    return {
      content: [{ type: "text", text: `FAILED: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }

  // Cost-safety + eligibility: catalog-only, $0. selectModels() itself
  // routes every candidate id through assertFreeOnlyModel — this call
  // can never hand back a paid model (see model-select.ts's own header).
  // Biggest-context-first, no implicit floor: "the biggest free model
  // with the biggest context memory" available today. The whole
  // ordered list (minus whatever lacks a usable completion ceiling)
  // is handed to the driver as a fallback chain — see driver.ts.
  // TRDD-TYHKAKCB: the selection (remote free models first, the first fit managed local model last, local-only
  // under a local profile) lives in session_summary/local-model.ts; index.ts only injects what lives here.
  let eligible;
  let ssLocal;
  try {
    ({ models: eligible, local: ssLocal } = await resolveSessionSummaryChain({
      active: deps.activeResolved, profiles: deps.activeSettings.profiles, minContext: ssMinContext, dir: getConfigDir(), slotCtx: brokerSlotCtx,
      selectRemote: (minContext) => selectModels({ minContext }),
      depsFor: (p) => makeProviderDeps(p, makeBackendFromProfile(p)),
      startCalibrationRunner: () => ensureCalibrator({ dir: getConfigDir(), version: brokerClientVersion(), entry: defaultBrokerEntry() }),
      waitForCalibration: (models, head) => waitForCalibration({ dir: getConfigDir(), models, head, start: () => startCalibration(models), sleep: stoppableSleep, stopReason: commandStopReason, write: (l) => process.stderr.write(l) }),
    }));
  } catch (err) {
    return {
      content: [{ type: "text", text: `FAILED: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
  const model = eligible[0];
  const fallbackModels = eligible.slice(1);

  const checkpointPath = ssCheckpointRaw
    ? resolve(ssCheckpointRaw)
    : defaultCheckpointPath(transcriptPath, getConfigDir());

  if (ssResume === true && !existsSync(checkpointPath)) {
    return {
      content: [
        {
          type: "text",
          text:
            `FAILED: --resume was given but no checkpoint exists at ${checkpointPath} for ` +
            `this transcript. Re-run without --resume to start a fresh run (it will create one).`,
        },
      ],
      isError: true,
    };
  }

  // The injected model-call seam driver.ts requires (see its own header):
  // pure core + thin IO shell. This is the only place session-summary
  // touches the network — driver.ts and its tests never do.
  const callModel: CallModelFn = async (prompt, modelId, maxOutputTokens, signal) => {
    const resp = await chatCompletionWithRetry(
      [{ role: "user", content: prompt }],
      {
        model: modelId,
        maxTokens: maxOutputTokens,
        temperature: DEFAULT_TEMPERATURE,
        onProgress,
        // A per-chunk deadline TIGHTER than the global soft timeout.
        // Under concurrency the map phase's wall-clock is the SLOWEST
        // chunk, so one straggler allowed to run the full global 300s
        // drags the entire run out even though every sibling finished
        // minutes earlier. Measured spread on same-sized chunks was 4.4x
        // (90s to 400s), so the tail — not the median — is the cost.
        // Exceeding this aborts the chunk, which then rotates/retries
        // like any other transient rather than hanging (TRDD-0H5N1V9W
        // made the deadline actually cover generation; before that fix
        // this value would have bounded only time-to-first-byte).
        // Round C item 5 (TRDD-YG72CYY7): ssPerChunkTimeoutMs is a
        // WHOLE-CHUNK wall-clock budget (driver.ts races the entire
        // chunk call against it), so the retry window must end with it —
        // without deadlineAt each chunk gets a private default 300s
        // retry window and can run 5 minutes past its own timeout.
        deadlineAt: Date.now() + ssPerChunkTimeoutMs,
        timeoutMs: ssPerChunkTimeoutMs,
        // Issue 19 / TRDD-3SNQAGIC: the driver cancels a losing racer through this signal once its
        // chunk is committed, so the request, its deadline timer and its retry backoff stop at once
        // instead of keeping the process alive to the 600 s chunk deadline.
        signal,
      },
      // TRDD-TYHKAKCB: the local model goes through its own profile deps (its broker, which holds the governor lease).
      ssLocal !== null && ssLocal.modelId === modelId ? ssLocal.deps : providerDeps,
    );
    if (resp.finishReason === "error") {
      throw new Error(`model call to '${modelId}' failed (finishReason=error): ${resp.content || "no detail"}`);
    }
    // An empty/whitespace-only completion is deliberately NOT thrown
    // here as a generic error — it is returned as-is so driver.ts's
    // own "no-text" runtime evidence check (its permissive modality
    // selection needs this backstop) can classify it as a
    // fallback-eligible model failure and demote the model, instead
    // of it being misread as a retryable schema bug.
    return resp.content;
  };

  // Concurrency: an explicit --concurrency (including 1, to force the
  // original sequential behavior) is honored verbatim; omitted, the
  // CLI opts every real invocation into "auto" — see driver.ts's own
  // header for why the LIBRARY default stays 1.
  // Omitted => "auto": the driver sizes the pool to the chunk count
  // (min(chunks, MAX_AUTO_CONCURRENCY)) so the map phase stays SINGLE-WAVE.
  // A fixed 12 forced e.g. 27 chunks into three waves and roughly tripled
  // wall-clock for nothing — the account admits far more than 12 at once.
  const concurrency: number | "auto" =
    typeof ssConcurrencyRaw === "number" ? ssConcurrencyRaw : "auto";

  // Per-chunk progress lines labeled by chunk index, so N chunks in
  // flight at once still read clearly instead of interleaving
  // anonymous "Processing… Ns elapsed" lines (each chunk is its own
  // named line; a "done" line always carries the SAME chunk index and
  // its own elapsed time, however many other chunks completed first).
  const onChunkEvent = (event: ChunkEvent) => {
    const label = `[chunk ${event.chunkIndex + 1}/${event.totalChunks}]`;
    if (event.phase === "start") {
      process.stderr.write(`${label} started\n`);
    } else {
      const secs = ((event.elapsedMs ?? 0) / 1000).toFixed(1);
      // Say WHICH racer won when the single-chunk race decided this
      // chunk. Without it a "done in 84.2s" line is unattributable: it
      // reads identically whether the race won in 84s or whether every
      // racer failed after minutes and the sequential fallback then
      // took 84s. Those are opposite outcomes and the fix for each is
      // different, so the line must distinguish them.
      const race =
        event.raceWinnerModel !== undefined
          ? ` (race of ${event.raceSize ?? "?"} won by ${event.raceWinnerModel})`
          : "";
      process.stderr.write(`${label} done in ${secs}s${race}\n`);
    }
  };

  // --until-done: keep going until the summary exists.
  //
  // The driver is deliberately checkpoint-and-stop: a chunk gets
  // maxRetriesPerChunk attempts on a model, a dead/quota-capped model is
  // demoted to the next ranked free one, and when those run out the run
  // THROWS with a resumable checkpoint. That is the right default — a
  // command that reports a problem beats one that silently sits on it.
  //
  // It is the wrong default for an unattended compaction that must
  // eventually produce a summary. Retrying is cheap and correct here
  // BECAUSE of the checkpoint: each pass re-reads the checkpoint, keeps
  // every chunk that landed, and only redoes what did not. Re-entering
  // summarizeSession (rather than looping inside it) also re-resolves the
  // model list, so a model that was quota-capped last pass is picked up
  // again once its quota resets.
  const untilDone = ssUntilDoneRaw === true;

  let result;
  for (let attempt = 1; ; attempt++) {
    try {
      result = await summarizeSession({
        transcriptPath,
        checkpointPath,
        modelId: model.id,
        modelMaxContext: model.contextLength,
        modelMaxCompletionTokens: model.maxCompletionTokens,
        // TRDD-TYHKAKCB: a local-only chain (remote selection failed, or a local profile) starts on the local model.
        modelLocal: model.local,
        fallbackModels,
        callModel,
        pruneLevel: prune as "aggressive" | "moderate" | "none",
        maxChunkTokens: typeof ssMaxChunkTokens === "number" ? ssMaxChunkTokens : undefined,
        maxRetriesPerChunk:
          typeof ssMaxRetriesRaw === "number" && ssMaxRetriesRaw >= 0
            ? Math.floor(ssMaxRetriesRaw)
            : undefined,
        concurrency,
        onChunkEvent,
      });
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // WHY: --until-done retries every failure, so without this a command stopped by --command_timeout would keep
      // retrying (and sleeping) a request that can no longer start; a stopped command fails once, with the stop reason.
      if (!untilDone || commandStopReason() !== null) {
        return {
          content: [{ type: "text", text: `FAILED: ${msg}` }],
          isError: true,
        };
      }
      const backoffMs = untilDoneBackoffMs(attempt, looksQuotaCapped(msg));
      process.stderr.write(
        `[llm-externalizer] session-summary attempt ${attempt} failed: ${msg}\n` +
          `[llm-externalizer] --until-done: retrying in ${Math.round(backoffMs / 1000)}s ` +
          `(resumes from the checkpoint; completed chunks are not recomputed)\n`,
      );
      // WHY stoppableSleep: this backoff can be minutes; a stop must end it at once (the next pass fails with the stop reason).
      await stoppableSleep(backoffMs);
    }
  }

  // The outcome, not the inputs. Chunk counts, lines read and the prune
  // ratio all describe how the work was done; this is the one number the
  // command exists to produce, and until now a reader had to stat two
  // files by hand to get it. Printed to stderr as well as embedded in the
  // report, because the command's stdout is a PATH — a caller who never
  // opens the report would otherwise never see it.
  const summaryBytes = Buffer.byteLength(result.summary, "utf8");
  const sizeLine = formatSizeReport(
    result.transcriptStats.bytesIn,
    summaryBytes,
    result.transcriptStats.bytesOut,
  );
  process.stderr.write(`[llm-externalizer] ${sizeLine}\n`);

  const fallbackLines = result.fallbackEvents.map(
    (e) => `  ${e.atUnit}: '${e.fromModel}' -> '${e.toModel}' (${e.reason}: ${e.detail})`,
  );
  const header =
    `Model: ${result.modelId} (context ${eligible.find((m) => m.id === result.modelId)?.contextLength.toLocaleString() ?? "?"})\n` +
    (result.fallbackEvents.length > 0
      ? `Model fallbacks (started on '${model.id}'):\n${fallbackLines.join("\n")}\n`
      : "") +
    `Transcript: ${transcriptPath}\n` +
    `Chunks: ${result.totalChunks}\n` +
    `Lines read: ${result.transcriptStats.linesRead}, prune ratio: ` +
    `${result.transcriptStats.pruneRatio.toFixed(3)} (level: ${prune})\n` +
    `${sizeLine}\n` +
    (result.resumedFromCheckpoint
      ? `Resumed from checkpoint: ${result.checkpointPath}\n`
      : `Checkpoint: ${result.checkpointPath}\n`);

  // Final-assembly gate (TRDD-P4ULUV1R; reported by the janitor's
  // handoff composer 2026-08-18): a run whose ASSEMBLED summary is
  // empty must not exit 0 — with --stdout that shipped literally
  // nothing at a zero exit, 14 consecutive times on one host, and the
  // caller had no honest way to classify it. The per-response no-text
  // gate upstream cannot cover this: it judges one model reply, not
  // the reduce result. Wording deliberately avoids availability
  // vocabulary (quota/404/etc.) — classifyUnavailable substring-
  // matches, and this verdict must never sideline a model (same
  // reason as the (nonconforming) path, v13.5.5).
  if (result.summary.trim().length === 0) {
    return {
      content: [
        {
          type: "text",
          text:
            "FAILED: session-summary assembled an empty summary " +
            `(${result.totalChunks} chunk(s) mapped; transcript ${transcriptPath}). ` +
            "Retry is reasonable; the checkpoint is preserved.",
        },
      ],
      isError: true,
    };
  }

  // --stdout (opt-in, caller-selected): return the summary TEXT
  // directly instead of writing a report file and returning its path.
  // Deliberately skips saveResponse entirely in this mode — "stdout
  // carries ONLY the summary text" (definitions.ts) means no header,
  // no file, no path line; a caller that wants both the direct text
  // AND a persisted report should omit --stdout and read the file.
  if (ssStdoutRaw === true) {
    return { content: [{ type: "text", text: result.summary }] };
  }

  const ssOutputDir =
    typeof ssOutputRaw === "string" && ssOutputRaw.trim() ? resolve(ssOutputRaw.trim()) : undefined;
  const savedPath = saveResponse(
    "session_summary",
    `${header}\n---\n\n${result.summary}`,
    { model: result.modelId, task: `session-summary of ${transcriptPath}` },
    undefined,
    ssOutputDir,
  );
  return { content: [{ type: "text", text: savedPath }] };
}
