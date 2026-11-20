/**
 * discover tool handler: the body of index.ts's `case "discover"` in dispatchCallToolInner, moved here
 * unchanged (TRDD-TYSKX72I). WHY: the ubs taint scan ran out of work budget on index.ts, whose size it multiplies;
 * moving the biggest case bodies out keeps the scan finishing with the compare_files spawnSync sinks still scanned.
 * What the body read from dispatchCallToolInner locals and from index.ts module state arrives in `call` and `deps`
 * (a module must not import index.ts); the values that can change while a command runs (activeResolved,
 * activeSettings) are read live through `deps`, as the inline body read the module bindings.
 */

import { API_PRESETS, isDynamicProfileName, PLACEHOLDER_MODEL_ID, getAllowPaidModels, resolveGroups, type ResolvedRoute, effectiveProfileName } from "../config.js";
import { getDynamicProfileRecord } from "../default-profiles-state.js";
import { readCandidates } from "../dynamic-candidates.js";
import { detectLMStudio } from "../provider/lmstudio.js";
import type { CaseCall, CaseDeps, ToolResult } from "./dispatch-deps.js";

export async function handleDiscover(call: CaseCall, deps: Pick<CaseDeps, "FALLBACK_CONTEXT_LENGTH" | "LOG_FILE" | "SETTINGS_FILE" | "SOFT_TIMEOUT_MS" | "activeFreePool" | "activeResolved" | "activeSettings" | "fetchOpenRouterModels" | "getContextLength" | "getProfileSelectionSource" | "getRateLimitConfig" | "isFreeModeActive" | "listModelsRaw" | "providerDeps" | "resolveDefaultMaxTokens" | "session" | "settingsError" | "settingsLoadFailed" | "settingsValid">): Promise<ToolResult> {
  const { backend } = call;
  const { LOG_FILE, SETTINGS_FILE, activeFreePool, fetchOpenRouterModels, getContextLength, getProfileSelectionSource, getRateLimitConfig, isFreeModeActive, listModelsRaw, providerDeps, resolveDefaultMaxTokens, session } = deps;
  const parts: string[] = [];

  // If settings are not configured, show the error prominently
  if (!deps.settingsValid || !deps.activeResolved) {
    parts.push("⚠ NOT CONFIGURED\n");
    parts.push(deps.settingsError);
    parts.push(`\nSettings file: ${SETTINGS_FILE}`);
    parts.push(`Session log: ${LOG_FILE}`);
    // Show available profiles even when not configured -- but not after a failed settings load: activeSettings is then the generated default
    // document, and listing its profile names would present them as the user's (WHY, TRDD-LFWV2DKG). A file that loaded but failed validation is listed.
    const profileNames = Object.keys(deps.activeSettings.profiles);
    if (!deps.settingsLoadFailed && profileNames.length > 0) {
      parts.push(`\nAvailable profiles: ${profileNames.join(", ")}`);
    }
    // Show available API presets
    parts.push(`\nAPI presets: ${Object.keys(API_PRESETS).join(", ")}`);
    return {
      content: [{ type: "text", text: parts.join("\n") }],
      isError: true,
    };
  }

  // WHY (TRDD-G6XT3AY9): `active:` is a live selector again -- the
  // deprecation notice this used to print here is gone; the source
  // label below already says whether the flag, the `active:` key, or
  // the built-in default decided.
  parts.push(
    `Effective profile: ${deps.activeResolved.name} (source: ${
      getProfileSelectionSource() === "flag"
        ? "--profile"
        : deps.activeSettings.active !== undefined
          ? "active:"
          : "built-in default"
    })`,
  );
  // Addendum K: dynamic-profile maintainer state is labelled "as of
  // <time>" because `discover` is itself in RECONCILE_SKIP_TOOLS — this
  // read-only status command never triggers a fresh maintain pass (a
  // status query must not rewrite settings first), so the timestamp may
  // be stale and the label says so honestly rather than implying "live".
  if (isDynamicProfileName(deps.activeResolved.name)) {
    const dynRecord = getDynamicProfileRecord(deps.activeResolved.name);
    // P6b-fix S5: renders lastMaintainedAt — the MAINTAINER's own clock,
    // which is what "maintained as of" claims. It used to render
    // lastBenchmarkAt, a different event entirely, and because
    // recordBenchmarkFailure preserves `lastBenchmarkAt: 0` on a profile
    // that never succeeded, a record created by a first FAILED attempt
    // printed "maintained as of 1970-01-01T00:00:00.000Z" instead of
    // "not yet maintained". Falsy (absent or 0) is the honest
    // never-maintained case.
    const maintainedAt = dynRecord?.lastMaintainedAt;
    parts.push(
      maintainedAt
        ? `Dynamic profile '${deps.activeResolved.name}' maintained as of ${new Date(maintainedAt).toISOString()}`
        : `Dynamic profile '${deps.activeResolved.name}' not yet maintained`,
    );
  }
  parts.push(`Mode: ${deps.activeResolved.mode}`);
  // fix-queue 89: PLACEHOLDER_MODEL_ID is an internal sentinel for
  // "profile never populated" (config.ts) -- this `settings status`
  // "Model:" line printed it verbatim for an unpopulated dynamic
  // section (the "Dynamic profile '<x>' not yet maintained" line
  // above already says so, but this SEPARATE line still leaked the
  // raw sentinel string right under it). Same population-state
  // wording writeBootBanner uses, so the two surfaces agree.
  parts.push(
    `Model: ${
      deps.activeResolved.model === PLACEHOLDER_MODEL_ID
        ? `${deps.activeResolved.name}: not benchmarked yet`
        : deps.activeResolved.model
    }`,
  );
  if (deps.activeResolved.secondModel) {
    parts.push(`Second model: ${deps.activeResolved.secondModel}`);
  }
  if (deps.activeResolved.thirdModel) {
    parts.push(`Third model: ${deps.activeResolved.thirdModel}`);
  }
  // Free-mode reporting. Under forced-free (allow_paid_models=false),
  // profile free_only, the Model/second/third lines
  // above are the CONFIGURED values but are NOT what runs — the ensemble
  // draws from the free pool. Say so explicitly, and show the actual pool,
  // so the user is never misled into thinking a paid model is being billed.
  if (isFreeModeActive()) {
    const pool = activeFreePool();
    // The auto-free ("low balance / 402") arm is gone (addendum 4): with paid allowed
    // forceFreeByMasterSwitch is false, so free mode can only come from free_only.
    const reason = !getAllowPaidModels()
      ? "allow_paid_models=false — set it true to use paid models"
      : "profile free_only";
    const shown = pool.slice(0, 6).join(", ");
    // OE27RD7I row 18 + review: "benchmark-vetted" is a population-state claim, and the
    // only record/queue that state comes from is the built-in dynamic `free` profile's.
    // Any other active profile (a static free_only list, hand-listed, exempt from
    // benchmarks by design) must not borrow that unrelated record's verdict.
    let poolVetting = "as listed in the profile, not benchmarked by design";
    if (deps.activeResolved.name === "free") {
      const freeProfile = deps.activeSettings.profiles.free;
      const freeQueued = readCandidates(
        freeProfile ? resolveGroups(freeProfile).routesFor : (): ResolvedRoute[] => [],
      ).free.length;
      // A queued COUNT, not "pending": it stays true when maintenance is backed off or disabled.
      poolVetting =
        (getDynamicProfileRecord("free")?.lastBenchmarkAt ?? 0) <= 0
          ? "not yet benchmarked"
          : freeQueued > 0
            ? `${freeQueued} candidate${freeQueued === 1 ? "" : "s"} awaiting benchmark`
            : "benchmark-vetted";
    }
    parts.push(`Free mode: ON (${reason})`);
    parts.push(
      `Free pool (${pool.length}, ${poolVetting}, rotates on rate-limit): ` +
        `${shown}${pool.length > 6 ? ", …" : ""}`,
    );
    if (!getAllowPaidModels()) {
      parts.push(
        `↑ The configured Model line(s) are ignored while paid is off; the ensemble runs the free pool above.`,
      );
    }
  }
  // Show auth status so agents can verify the token is available
  const authSource = (() => {
    const authProfileName = effectiveProfileName(deps.activeSettings);
    const preset =
      API_PRESETS[deps.activeSettings.profiles[authProfileName]?.api];
    const profile = deps.activeSettings.profiles[authProfileName];
    if (!preset) return "unknown";
    const rawAuth = preset.isLocal
      ? profile?.api_token || preset.defaultAuthEnv
      : profile?.api_key || preset.defaultAuthEnv;
    if (!rawAuth) return "none required";
    if (rawAuth.startsWith("$")) {
      const envVal = process.env[rawAuth.slice(1)];
      // The token length is not printed: it is information about a secret (TRDD-TN8OUZ50).
      return envVal ? `${rawAuth} (set)` : `${rawAuth} (NOT SET)`;
    }
    return "direct value (set)";
  })();
  parts.push(`Auth: ${authSource}`);

  // Probe the service to check availability and get context window
  const start = Date.now();
  try {
    let contextWindow = deps.FALLBACK_CONTEXT_LENGTH;

    if (backend.type === "openrouter" && backend.model) {
      const models = await fetchOpenRouterModels();
      const match = models.find((m) => m.id === backend.model);
      if (match?.context_length) contextWindow = match.context_length;
      const ms = Date.now() - start;
      parts.push(`Status: ONLINE (${ms}ms)`);
    } else {
      const models = await listModelsRaw();
      const isLMS = await detectLMStudio(providerDeps);
      const ms = Date.now() - start;
      const backendLabel = isLMS ? "LM Studio" : "Local";
      if (models.length > 0) {
        contextWindow = getContextLength(models[0]);
        parts.push(`Status: ONLINE — ${backendLabel} (${ms}ms)`);
      } else {
        parts.push(
          `Status: ONLINE — ${backendLabel} (${ms}ms) — no model loaded, ask the user to load one`,
        );
      }
    }

    parts.push(
      `Context window: ${contextWindow.toLocaleString()} tokens (input + output combined)`,
    );
    parts.push(
      `Max output tokens per call: model maximum (${resolveDefaultMaxTokens().toLocaleString()}). Auto-managed, not user-configurable.`,
    );

    const rlCfg = await getRateLimitConfig();
    if (rlCfg.rps > 1) {
      parts.push(
        `Rate limit: ${rlCfg.rps} RPS (requests/second), up to ${rlCfg.maxInFlight} in-flight. Spawn parallel tool calls for throughput.`,
      );
    } else {
      parts.push(
        "Concurrency: SEQUENTIAL — one request at a time. Wait for each call to complete before sending the next.",
      );
    }

    parts.push(`Timeout: ${deps.SOFT_TIMEOUT_MS / 1000}s per call.`);
  } catch (err) {
    const ms = Date.now() - start;
    const reason =
      err instanceof Error && err.name === "AbortError"
        ? `timed out after ${ms}ms`
        : err instanceof Error
          ? err.message
          : String(err);
    parts.push(`Status: OFFLINE — ${reason}`);
    parts.push(
      "The service is not available. Do not attempt to delegate tasks.",
    );
  }

  if (session.calls > 0) {
    const total = session.promptTokens + session.completionTokens;
    const costStr =
      session.totalCost > 0
        ? ` | Cost: $${session.totalCost.toFixed(6)}`
        : "";
    parts.push(
      `\nSession usage: ${total.toLocaleString()} tokens across ${session.calls} call${session.calls === 1 ? "" : "s"}${costStr}`,
    );
  }

  // Show profiles and presets for editing guidance
  const profileNames = Object.keys(deps.activeSettings.profiles);
  parts.push(`\nProfiles: ${profileNames.join(", ")}`);
  parts.push(`API presets: ${Object.keys(API_PRESETS).join(", ")}`);
  parts.push(`Settings: ${SETTINGS_FILE}`);
  parts.push(`Session log: ${LOG_FILE}`);

  return {
    content: [{ type: "text", text: parts.join("\n") }],
  };
}
