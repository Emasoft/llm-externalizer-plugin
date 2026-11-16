// C4-01 (TRDD-BUL4EEBP), plan §3 L4 / §9: the ONE runner of every classify decision.
// WHY exactly one path for all specs: a spec (L3) only declares input schema, thresholds, questions and projection; the runner holds no decision text, so a fix to
// profile handling, planning, spend cap, exit codes or the report lands in every command at once and no command can drift (plan §4 "single sources of truth").
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadDecisionsCatalog, type DecisionsModel } from "./l0/catalog.js";
import { DeadlineError, type Deadline } from "./l0/deadline.js";
import { ClassifierError, type ErrorClass } from "./l0/errors.js";
import { loadEndpointPromptLimit, malformedModelIdReason, resolveModel } from "./l0/model.js";
import { parseDecisionsText } from "./l0/response.js";
import { callDecisions, type GlobalFetch } from "./l0/transport.js";
import { recordDecisionsUsage } from "./l1/usage.js";
import { selectionCatalogErrors } from "./profile-checks.js";
import { isModelNotWorking, noteAliasTarget, noteModelPrice, removedModelCeiling, systemOneFallbackCandidates, type RemovedModelCeiling } from "./system-one-fallback.js";
import { assertChunkDefaults } from "./catalog/index.js";
import type { DecisionSpec, ProjectCtx, SpecFlag, Thresholds } from "./catalog/spec.js";
import { installCtrlC, CTRL_C_EXIT_CODE, type SignalSource } from "./l2/abort.js";
import { exitCodeForError, exitCodeForRun } from "./l2/attention.js";
import { BUDGET_EXIT_CODE, BudgetTracker, checkEstimate } from "./l2/cost-cap.js";
import { buildEnvelope, renderEnvelope, type EnvelopeReply, type ResultEnvelope } from "./l2/envelope.js";
import { BilledClassifierError, asClassifierError, emptyMerged, runPlan, type ExecReply, type MergedReply } from "./l2/fan-out.js";
import { IdError } from "./l2/ids.js";
import { InputError } from "./l2/input-error.js";
import type { CollectOptions } from "./l2/inputs.js";
import { assertChunkChars } from "./l2/chunker.js";
import { ENVELOPE_TOKENS, modelLimits, planRequests, type PlannedRequest } from "./l2/planner.js";
import { LOCAL_DECISION_API, LOCAL_DECISION_CONTEXT_TOKENS, localsPlatformSupported } from "../config.js";
import { PolicyError, resolveThresholds } from "./l2/policy-kit.js";
import { resolveClassifierApiKey, resolveClassifierProfile, selectClassifierProfile, type ClassifierProfileInput, type ResolvedClassifierProfile } from "./l2/profile.js";
import { createRedactor } from "./l2/redact.js";
import { composeText, type RenderOptions } from "./l2/render-text.js";
import { prepareReportDir, writeReport } from "./l2/report.js";
import { warning, type Warning } from "./l2/warnings.js";
import { assembleFileInput, overlaySpecFields, readFileSources, readSpecFlag } from "./input-args.js";
import type { SelectionCheckOptions } from "./profile-checks.js";
import { INPUT_FLAGS, SHARED_FLAGS, type BooleanFlag, type BooleanInputFlag } from "./shared-flags.js";
import { commandStopExitCode, commandStopSignal, type StopExitCode } from "../command-stop.js";
import { throwIfStopped } from "../provider/http.js";
import { buildEstimate, renderEstimateJson, renderEstimateText } from "./estimate-output.js";
import { buildReceipt, lifetimeOrReason, renderReceipt, type Receipt } from "./receipt.js";
import { ctxStore, withUsageContext } from "../usage-history.js";

import { answerWithLocalDecider, localFallbackConfig, localOnlySettings } from "./l2/local-fallback.js";
import type { LocalDeciderDeps } from "./l2/local-decider.js";

/** llm-ext's 0/1 (cli/main.ts), quicksilver's 3 key/credits, 4 request rejected, 5 failed after retries (attention.ts), Ctrl-C, and 124 when --command_timeout stopped the run. */
export type ExitCode = 0 | 1 | 3 | 4 | 5 | typeof CTRL_C_EXIT_CODE | StopExitCode;

/** Everything one run needs besides the spec. `input` is the already-parsed object; reading it from --input or stdin is runDecisionArgv. */
export interface RunRequest {
  input: unknown;
  /** Threshold flags as typed, by name without the dashes; range-checked against the spec. */
  thresholdFlags?: Record<string, string | number>;
  profileFlag?: string;
  /** The command as typed, for refusal texts. Default `classify <spec id>`. */
  command?: string;
  /** --max-budget in USD (D2): the only spend cap; absent means no cap. */
  maxBudgetUsd?: number;
  chunkChars?: number;
  /** `--default <label>`: the default label of every choice question over text; wins over the spec's chunkDefaults for all its keys (plan §5 "--default, else the last label"). */
  defaultLabel?: string;
  /** Internal, per question key (users cannot know the keys); applied after defaultLabel. */
  defaultLabels?: Record<string, string>;
  /** -o: directory for the JSON report (same text as stdout, D10). */
  outputDir?: string;
  strictExit?: boolean;
  /** `--json` (IN-07, Q4): print the JSON envelope instead of the spec text form. The -o report is always the JSON envelope. */
  json?: boolean;
  /** `--estimate` (C4-08): plan the requests, send none, and print the estimated input tokens and cost (estimate-output.ts). WHY in SHARED_FLAGS (TRDD-58CFBQHN): it is parsed from that list like --json, and the same entry is the help row of the 15 decision commands, so the help and the parser read one declaration. */
  estimate?: boolean;
  /** The spec flags declared `render: true` (filter --no-collapse, --save), by field; handed to the spec renderText, never to its input schema. */
  renderOptions?: RenderOptions;
  /** Plain-string warnings of the input reader (inputs.ts) and of content redaction. */
  inputWarnings?: string[];
}

/** The seams: settings, the one GlobalFetch (no network in tests), catalog cache options and the SIGINT source. */
export interface RunDeps {
  settings: ClassifierProfileInput["settings"];
  /** The raw `local_fallback` section of settings.yaml, for the local decider escalation; absent = its defaults. WHY a peer field and not Settings: settings here is narrowed to the three profile keys (ClassifierProfileInput), and the local tier is not a profile setting. */
  localFallback?: unknown;
  /** The decider's own seams (process scan, clock, platform, install check), so the escalation is testable without
   * reaching the real machine. WHY required in practice: without it a test that fails its remote call would
   * probe and adopt the real `mlx-decision` singleton. Production leaves it out and local-decider.ts supplies the real ones. */
  localFallbackDeps?: Partial<LocalDeciderDeps>;
  fetch: GlobalFetch;
  catalogOptions?: SelectionCheckOptions;
  sigint?: SignalSource;
  /** One diagnostic line (no newline), default process.stderr. WHY a seam: the LLM_EXT_DEBUG stack is the runner's only direct stderr output, and a caller or test must be able to capture it without patching process.stderr. */
  stderr?: (line: string) => void;
}

export interface RunOutcome<R> {
  exitCode: ExitCode;
  /** Absent when the run ended without a result: a refusal, a fatal failure, or a whole-result spec with a request lost. */
  envelope?: ResultEnvelope<R>;
  /** renderEnvelope of `envelope`, key-redacted: print it to stdout. */
  text?: string;
  /** The spec text form (key-redacted, notes added), absent when the spec has no renderText. runDecisionArgv prints it unless --json. WHY a separate field: `text` stays the JSON that -o saves (D10). */
  display?: string;
  /** C4-12: the numbers of the receipt; absent for a dry run and a refusal. runDecisionArgv prints it as the last line (stderr under --json). */
  receipt?: Receipt;
  reportPath?: string;
  /** One line saying why the exit code is not 0; print it to stderr. */
  cause?: string;
}

// WHY an own class: it marks a failure the user can fix (exit code attached); anything else thrown is a bug and must surface as one, never as a tidy exit code.
class Refusal extends Error {
  constructor(message: string, readonly code: ExitCode = 1) {
    super(message);
  }
}
// WHY a wrapper: the L2 validators throw plain Errors (they are libraries, not CLI code), which are refusals only when the user's input caused them.
function refusing<T>(code: ExitCode, f: () => T): T {
  try {
    return f();
  } catch (e) {
    throw e instanceof Refusal ? e : new Refusal((e as Error).message, code);
  }
}

async function refusingAsync<T>(code: ExitCode, f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    throw e instanceof Refusal ? e : new Refusal((e as Error).message, code);
  }
}

// WHY one function for every path out: the code is decided from the failures the fan-out recorded, so a partial result and a failed one cannot disagree.
function failureCode(m: MergedReply): ExitCode | undefined {
  if (m.aborted) return CTRL_C_EXIT_CODE;
  if (m.stopped === "budget") return BUDGET_EXIT_CODE as ExitCode;
  // Review of 4856f009, finding 4: a stopped run exits with the code of the stop that ended it (124 for --command_timeout, 6 for --stop_on_errors) like every other stopped command, with the answers it has. The envelope value "timeout" is the schema name for any stop.
  if (m.stopped === "timeout") return commandStopExitCode();
  // WHY a fixed order and not the first failure: which request failed first is a race; the most actionable class wins: 3 (key/credits) > 4 (rejected) > 5 (failed after retries).
  const codes = m.failures.flatMap((f) => (f.error === undefined ? [] : [exitCodeForError(f.error)]));
  const worst = ([3, 4, 5] as const).find((c) => codes.includes(c));
  // WHY 5: a failure without an error object (the fatal request itself, and the fatal, aborted, stopped and budget kinds that runPlan in l2/fan-out.ts records) has no class to map, and a run with any failure must not reach exitCodeForRun, which returns 0 or 1.
  return worst ?? (m.failures.length > 0 ? 5 : undefined);
}


// WHY by text: the input readers return plain strings (inputs.ts lines 72, 94, 299). A wording change there must never lose a result, so an unknown string is kept as a generic warning.
function inputWarning(text: string): Warning {
  if (text.includes("invalid UTF-8")) return warning("invalid_utf8", text);
  if (text.includes("redacted before send")) return warning("secret_redacted", text);
  return warning("input_warning", text);
}


// WHY its own Ctrl-C scope and a { signal } only argument (XZZ2NSWY): the abort must reach the worker that prepare starts, and a prepare stopped by it ends the run 130, not as an internal error; the spec never receives how the worker is made.
async function prepareInput<I>(prepare: NonNullable<DecisionSpec<I, unknown>["prepare"]>, input: I, t: Thresholds, sigint: SignalSource | undefined): Promise<I> {
  const ctrlC = installCtrlC(sigint);
  try {
    return await prepare(input, t, { signal: ctrlC.signal });
  } catch (e) {
    if (ctrlC.signal.aborted) throw new Refusal("interrupted by Ctrl-C", CTRL_C_EXIT_CODE);
    throw e;
  } finally {
    ctrlC.dispose();
  }
}

export async function runDecision<I, R>(spec: DecisionSpec<I, R>, req: RunRequest, deps: RunDeps): Promise<RunOutcome<R>> {
  const redactor = createRedactor();
  const safe = (s: string): string => redactor.redact(s) as string;
  try {
    return await run(spec, req, deps, redactor, safe);
  } catch (e) {
    if (e instanceof Refusal) return { exitCode: e.code, cause: safe(e.message) };
    // WHY exit 1: PolicyError, IdError and InputError each mark a refused flag value, id or input (CLI exit 1, their class docs); any other throw is a bug and is rethrown below.
    if (e instanceof PolicyError || e instanceof IdError || e instanceof InputError) return { exitCode: 1, cause: safe(e.message) };
    // WHY a fresh Error without `cause`: a bug's message, stack or cause chain may carry the key (an upstream error text), and whatever prints the exception prints all of them.
    const bug = new Error(safe(e instanceof Error ? e.message : String(e)));
    bug.name = e instanceof Error ? e.name : "Error";
    bug.stack = safe(e instanceof Error && e.stack ? e.stack : `${bug.name}: ${bug.message}`);
    throw bug;
  }
}

async function run<I, R>(spec: DecisionSpec<I, R>, req: RunRequest, deps: RunDeps, redactor: ReturnType<typeof createRedactor>, safe: (s: string) => string): Promise<RunOutcome<R>> {
  // C4-12: the receipt time starts with the run, before any input check or request.
  const startedAt = Date.now();
  const command = req.command ?? `classify ${spec.id}`;
  const parsed = spec.input.safeParse(req.input);
  if (!parsed.success) throw new Refusal(`invalid input: ${parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  const parsedInput = parsed.data;
  // WHY before any request: a conversion that threw after runPlan would lose a paid run's result.
  const warnings: Warning[] = (req.inputWarnings ?? []).map(inputWarning);
  const t = resolveThresholds(spec.thresholds, req.thresholdFlags ?? {});
  if (req.chunkChars !== undefined) refusing(1, () => assertChunkChars(req.chunkChars!));
  const budget = req.maxBudgetUsd === undefined ? undefined : refusing(1, () => new BudgetTracker(req.maxBudgetUsd));
  // WHY before the first request (E52): a bad -o must cost nothing. WHY before prepare (XZZ2NSWY): a refused invocation must not start a worker either.
  const reportDir = req.outputDir === undefined ? undefined : refusing(1, () => prepareReportDir(req.outputDir));
  // WHY here: prepare may start a worker (extract's regexes), so it runs once, after every cheap refusal above; its result is the input of build, chunkDefaults and project alike (extract's `matches` must reach all of them).
  // Profile and key checks stay after build: a build that asks nothing (noCall, E65) needs no profile, and whether it asks nothing is known only from the prepared input.
  const input = spec.prepare === undefined ? parsedInput : await prepareInput(spec.prepare.bind(spec), parsedInput, t, deps.sigint);
  // WHY built once and handed to the check: the check used to call spec.build itself, so every run built twice (extract's cut and candidate work doubled).
  const built = spec.build(input, t);
  assertChunkDefaults(spec, input, t, built);

  // WHY declared before conclude: set when the run is answered by a model other than the profile's (a fallback or a replacement for a removed model), which adds answered_by to the envelope.
  let usedOtherModel = false;
  // WHY a closure over the run's state: the empty plan (E65) and the planned run end the same way (project, envelope, report, exit code); two copies could drift.
  const conclude = (merged: MergedReply): RunOutcome<R> => {
    // WHY a refusal with the transport's own message and remedy: a fatal failure is run-wide and reported once, and its error maps straight to an exit code (FatalFailure in l2/fan-out.ts).
    if (merged.fatal !== null) {
      const f = merged.fatal;
      throw new Refusal(`${f.message}${f.remedy_hint ? ` ${f.remedy_hint}` : ""}`, exitCodeForError(f.error));
    }
    const firstFailure = merged.failures[0];
    if (merged.status === "failed") {
      // WHY no projection: a whole-result spec cannot project from a part of its answers.
      throw new Refusal(firstFailure?.message ?? "the run failed", failureCode(merged));
    }

    const ctx: ProjectCtx = { truncated: built.truncated ?? false, chunks: merged.chunks };
    const decision = spec.project(merged.answers, input, t, ctx);
    // IN-07: the text form is built from the decision before the envelope, because writing its files (filter --save) can fail and that failure must be a warning IN the envelope.
    const rendered = spec.renderText?.(decision, req.renderOptions ?? {});
    const saved: string[] = [];
    let saveFailed = false;
    for (const f of rendered?.files ?? []) {
      try {
        writeFileSync(f.path, safe(f.content));
        saved.push(f.path);
      } catch (e) {
        // WHY a warning and exit 1, not a throw: the run is paid for and its answers must still be printed; but a lost file must never pass as a clean exit 0.
        saveFailed = true;
        warnings.push(warning("save_failed", `cannot save ${f.path}: ${(e as Error).message}`));
      }
    }
    // WHY degraded is always empty: the ZB41KG62 plan's decision D1 names two source fallbacks (the decide --hook defer and browse's keyword query), and neither is built; a model fallback is reported as answered_by.
    const envelope = buildEnvelope({ decision, replies: merged.replies, warnings: [...warnings, ...merged.warnings], degraded: [], stopped: merged.stopped, ...(usedOtherModel ? { answeredBy: merged.answeredBy } : {}) });
    const text = safe(renderEnvelope(envelope));
    const reportPath = reportDir === undefined ? undefined : writeReport(reportDir, spec.id, text);
    // WHY failureCode first: a recorded failure must not be hidden behind exitCodeForRun, which only returns 0 or 1 from attention and --strict-exit.
    const baseCode = failureCode(merged) ?? exitCodeForRun({ attention: spec.attention(decision), strictExit: req.strictExit ?? false });
    const exitCode: ExitCode = baseCode === 0 && saveFailed ? 1 : baseCode;
    const display = rendered === undefined ? undefined : safe(composeText(envelope, rendered, saved));
    // WHY the printed text and not the JSON: what the user is spared reading is what was printed to stdout (qs footer saves = input tokens - tokens of outText); --json prints `text`.
    const receipt = buildReceipt({ elapsedMs: Date.now() - startedAt, states: built.units.map((u) => u.state), shared: built.sharedState, unsplittable: Object.keys(built.unsplittable).length, shown: req.json === true ? text : (display ?? text), usage: envelope.usage, cost: envelope.cost, snapshots: envelope.snapshots, inputWarnings: req.inputWarnings ?? [] });
    return { exitCode, envelope, text, receipt, ...(display === undefined ? {} : { display }), ...(reportPath === undefined ? {} : { reportPath }), ...(exitCode !== 0 && firstFailure !== undefined ? { cause: safe(firstFailure.message) } : {}) };
  };
  // C4-08: the dry run ends here instead of in conclude: no decision, no envelope, no -o report, exit 0. Its JSON (--json) is `text`, the text form is `display`, which runDecisionArgv already picks between.
  const estimateOutcome = (e: ReturnType<typeof buildEstimate>): RunOutcome<R> => ({ exitCode: 0, text: safe(renderEstimateJson(e)), display: safe(renderEstimateText(e)) });
  // WHY before the empty path: the same flags must be refused or accepted whatever the input built (they need only spec, input and built).
  const specDefaults = spec.chunkDefaults?.(input) ?? {};
  if (req.defaultLabel !== undefined && Object.keys(specDefaults).length === 0) throw new Refusal(`--default does not apply: ${command} has no choice question over text`);
  const userDefault = req.defaultLabel === undefined ? {} : Object.fromEntries(Object.keys(specDefaults).map((k) => [k, req.defaultLabel!]));
  // WHY this order: --default beats the spec's chunkDefaults for all their keys, and the internal per-key defaultLabels apply last (RunRequest JSDoc on defaultLabel and defaultLabels).
  const defaultLabels: Record<string, string> = { ...specDefaults, ...userDefault, ...req.defaultLabels };
  // WHY here: runPlan refuses a label that is not the question's only as a plain Error, which would surface as a bug instead of a refusal.
  for (const [k, label] of Object.entries(defaultLabels)) {
    const q = built.units.map((u) => u.questions[k]).find((x) => x !== undefined);
    if (q?.type === "choice" && !Object.hasOwn(q.criteria, label)) throw new Refusal(`--default ${JSON.stringify(label)} is not a label of ${k}: ${Object.keys(q.criteria).join(", ")}`);
  }

  const noQuestions = Object.keys(built.unsplittable).length === 0 && built.units.every((u) => Object.keys(u.questions).length === 0);
  // WHY a Refusal with a neutral text: a zero-question build without Built.noCall is refused (the planner would throw it as a bug), but the user's input may have caused it, so the text must not blame the spec.
  if (noQuestions && built.noCall !== true) throw new Refusal(`${command}: nothing to ask for this input (no question was built)`);
  // E65 DECISION: a declared noCall build sends nothing, so it needs no profile, key or model: selecting a profile would itself fetch the catalog, and an answer that needs no model must not fail for want of one.
  // WHY the estimate here too: a noCall input needs no profile (E65), so a dry run of it is 0 requests and 0 USD, not a decision.
  if (noQuestions) return req.estimate === true ? estimateOutcome(buildEstimate(command, [], null)) : conclude(emptyMerged());

  /**
   * TRDD-1L9VMEY7 (USER 2026-11-16: "do it then! call it local-jev or local-decision"): the run of a local-only profile
   * (LOCAL_DECISION_API). Every request goes straight to the adopted mlx-decision singleton through answerWithLocalDecider,
   * the same call the remote path escalates to, so serialization, the governor lease, the retries and the usage record are
   * the ones the fallback already has. WHY a path of its own and not exec with a remote that always fails: the remote path
   * needs a key, the catalog and the endpoint limit, and its local escalation says "no remote System One model answered",
   * which would be false here.
   */
  const runLocalOnly = async (local: ResolvedClassifierProfile): Promise<RunOutcome<R>> => {
    // WHY context_tokens, else LOCAL_DECISION_CONTEXT_TOKENS: the decider reports its window nowhere but in its 422 reply, so the
    // one named constant measured from that reply (config.ts) is the source when the profile does not set its own value; the
    // remote path plans under the same constant while the fallback is on, so the two can never disagree.
    const contextTokens = local.limits.context_tokens ?? LOCAL_DECISION_CONTEXT_TOKENS;
    const limits = { contextTokens, envelopeTokens: ENVELOPE_TOKENS, maxRequests: local.limits.max_requests_per_call, concurrency: local.limits.concurrency };
    const plan = planRequests(built, { ...limits, ...(req.chunkChars === undefined ? {} : { chunkChars: req.chunkChars }) });
    if (!plan.ok) throw new Refusal(plan.message);
    // WHY no checkEstimate: every local request costs 0, so --max-budget can never be exceeded by this run.
    if (req.estimate === true) return estimateOutcome(buildEstimate(command, plan.requests.map((r) => r.tokens), { id: local.model, promptUsdPerM: 0 }, true));
    // WHY set: the envelope names the model that answered (answered_by elephant-1), as it does for every local answer.
    usedOtherModel = true;
    const ctrlCLocal = installCtrlC(deps.sigint);
    const execLocal = async (request: PlannedRequest): Promise<ExecReply> => {
      const answered = await answerWithLocalDecider({
        settings: localOnlySettings(deps.localFallback),
        fetchImpl: deps.fetch,
        signal: AbortSignal.any([ctrlCLocal.signal, commandStopSignal()]),
        call: { state: request.state, questions: request.questions, trace: local.trace, sessionId: local.sessionId, user: local.user },
        decider: deps.localFallbackDeps,
      });
      if (answered.ok) return answered.reply;
      // WHY throwIfStopped first: a command stop during the wait must end the run as the stop, as on the remote path.
      throwIfStopped();
      // WHY the decider's reason is the failure (fail fast, no remote fallback): a local-only profile has nothing else to ask.
      // A 422 keeps its class (bad-request, exit 4) and the decider text verbatim; anything else is the decider not answering (unavailable, exit 5).
      const cause = answered.disabled ? undefined : answered.error;
      throw new ClassifierError({ class: cause?.class ?? "unavailable", message: answered.reason, retryable: false, ...(cause?.status === undefined ? {} : { status: cause.status }) });
    };
    let mergedLocal: MergedReply;
    try {
      mergedLocal = await runPlan(plan, { concurrency: limits.concurrency, timeoutMs: local.timeoutMs, signal: ctrlCLocal.signal, budget, split: spec.split, policy: spec.validation, defaultLabels, exec: execLocal });
    } finally {
      ctrlCLocal.dispose();
    }
    return conclude(mergedLocal);
  };
  // Profile: --profile or active_classifier; the key is read from its variable NAME now and lives only in this scope.
  // WHY 5: a throw here is the catalog being unreachable with an expired cache (E16), a failure to reach the service, not a bad input.
  // WHY one memoised load per run: selection and the model lookup below both need the catalog, and each load reads the cache file from disk.
  let catalogLoad: Promise<DecisionsModel[]> | undefined;
  const loadCatalog = (): Promise<DecisionsModel[]> => (catalogLoad ??= loadDecisionsCatalog({ fetch: deps.fetch, ...deps.catalogOptions }));
  // WHY the loader is a separate argument, not an option: a public `loadCatalog` option would let any caller replace the cache/TTL/E16 handling silently.
  // WHY a Refusal text kept: when the profile model is absent from the catalog (removed), the run does not end here; it continues with a System One replacement (TRDD-28BAL5ER, USER: "not available anymore").
  const selection = await refusingAsync(5, () => selectClassifierProfile({ settings: deps.settings, profileFlag: req.profileFlag, command }, deps.fetch, deps.catalogOptions, loadCatalog));
  let profile: ResolvedClassifierProfile;
  let removedRule: RemovedModelCeiling | undefined;
  const say = (line: string): void => { if (deps.stderr === undefined) process.stderr.write(`${line}\n`); else deps.stderr(line); };
  if (selection.ok) profile = selection.profile;
  else {
    const plain = resolveClassifierProfile({ settings: deps.settings, profileFlag: req.profileFlag, command });
    if (!plain.ok) throw new Refusal(selection.error);
    removedRule = removedModelCeiling(plain.profile.model, await refusingAsync(5, loadCatalog));
    if (removedRule === undefined) throw new Refusal(selection.error);
    profile = plain.profile;
  }
  // TRDD-1L9VMEY7: a local-only profile ends the run on its own path: no key, no catalog, no endpoint limit, no System One fallback.
  if (profile.api === LOCAL_DECISION_API) return runLocalOnly(profile);
  // Review of 727b9f32, finding 7: a dry run sends nothing and prices from the catalog, so it needs no key; requiring one made `--estimate` fail where the user only wants the cost. An empty key is never used: the estimate returns before the first request, and the redactor has nothing to register.
  // WHY 3: resolveClassifierApiKey throws a plain Error when the key variable is unset, and exit 3 is the key/credits code (ExitCode JSDoc).
  const key = req.estimate === true ? "" : refusing(3, () => resolveClassifierApiKey(profile)); // ubs:ignore unsafe_secret_compare: the only comparison is the boolean req.estimate; key is assigned, not compared
  if (key !== "") redactor.register(key);

  const catalog = await refusingAsync(5, loadCatalog);
  const eligible = async (list: DecisionsModel[]): Promise<DecisionsModel[]> => {
    const found: DecisionsModel[] = [];
    for (const m of list) {
      // WHY the same selection check as the profile model (profile-checks.ts): endpoint 'systemone' needs the candidate to declare it; a refused candidate is skipped, never tried.
      if ((await selectionCatalogErrors({ name: profile.name, type: "classifier", model: m.id, endpoint: profile.endpoint, fetch: deps.fetch, ...deps.catalogOptions }, loadCatalog)).length === 0) found.push(m);
    }
    return found;
  };
  let primaryId = profile.model;
  if (removedRule !== undefined) {
    // WHY the same filters as a fallback: the replacement must pass the endpoint check too, and it is the cheapest model at or below the ceiling.
    const replacement = (await eligible(systemOneFallbackCandidates(new Set([profile.model]), removedRule.ceiling, catalog)))[0];
    if (replacement === undefined) throw new Refusal((selection as { ok: false; error: string }).error);
    primaryId = replacement.id;
    usedOtherModel = true;
    const text = `${profile.model} is not in the decisions catalog (it may have been removed); using System One model ${primaryId} instead, with a price ceiling of ${removedRule.ceiling} USD per million tokens taken from ${removedRule.rule}; quality not benchmarked against ${profile.model}`;
    warnings.push(warning("profile_model_removed", text));
    say(`llm-ext: ${safe(text)}`);
  }
  const resolved = refusing(1, () => resolveModel(primaryId, catalog));
  // WHY the endpoint's own limit (P-02): the catalog says 64000 but the endpoint accepts about 32k, and a request over it is a non-retried 400. Cached next to the catalog; on a miss a 3 s lookup, and if it fails the catalog's length is used and the envelope says so (plan §5 "Limits" names min(context_length, max_prompt_tokens) and is silent on a failed lookup).
  const promptLimit = await loadEndpointPromptLimit({ modelId: resolved.effective.id, fetch: deps.fetch, catalogPath: deps.catalogOptions?.path, now: deps.catalogOptions?.now, ttlMs: deps.catalogOptions?.ttlMs });
  // WHY the reason: a malformed catalog id is not a failed lookup, and saying "could not be read" would send the user looking at the network.
  if (promptLimit === undefined) {
    const malformed = malformedModelIdReason(resolved.effective.id);
    warnings.push(warning("endpoint_limit_unknown", malformed === undefined
      ? `the endpoint prompt limit of ${resolved.effective.id} could not be read; planned with the catalog context length, the API may still refuse a request over its own limit`
      : `the model id ${JSON.stringify(resolved.effective.id)} from the catalog is malformed (${malformed}), so its endpoint prompt limit was not looked up; planned with the catalog context length, the API may still refuse a request over its own limit`));
  }
  const limits = refusing(1, () => modelLimits({ resolved, endpointPromptLimit: promptLimit, profile: profile.limits }));
  // WHY "ok" in: modelLimits returns ModelLimits or a LimitsRefusal ({ ok: false, message }); only the refusal has an ok key.
  if ("ok" in limits) throw new Refusal(limits.message);
  // TRDD-1L9VMEY7 (USER: "ensure reliability and fallbacks"): while the local decider fallback is on, every request is planned to
  // fit the decider too, min(remote limit, LOCAL_DECISION_CONTEXT_TOKENS), so any request the remote side fails can be answered
  // locally. Before this, chunks were cut for the remote limit only, and the decider refused them with its 422 over-limit text
  // (live 2026-11-16: 17141 to 28700 tokens against its 16384). Cost: an input that fitted a remote request between the two limits
  // now takes up to about twice as many remote requests; an input under the decider limit is planned exactly as before.
  // WHY not when the fallback is off: only the RunDeps test seam can turn it off now (cli/main.ts refuses a remote-only classify
  // run), and those tests pin captured replies planned for the remote limit.
  // WHY the platform gate too: mlx-decision is an MLX server (macOS on Apple silicon only, localsPlatformSupported), so elsewhere the
  // fallback can never answer, and splitting remote requests for it would only add remote requests.
  const fitsLocal = refusing(1, () => localFallbackConfig(deps.localFallback).enabled) && localsPlatformSupported();
  const planLimits = fitsLocal ? { ...limits, contextTokens: Math.min(limits.contextTokens, LOCAL_DECISION_CONTEXT_TOKENS) } : limits;
  const plan = planRequests(built, { ...planLimits, ...(req.chunkChars === undefined ? {} : { chunkChars: req.chunkChars }) });
  // WHY returned, not thrown, by the planner: a refusal is an answer about the input; nothing was sent.
  if (!plan.ok) throw new Refusal(plan.message);
  refusing(1, () => checkEstimate({ maxBudgetUsd: req.maxBudgetUsd, estimatedInputTokens: plan.requests.reduce((n, r) => n + r.tokens, 0), model: resolved }));
  // WHY after checkEstimate: --max-budget refuses a dry run whose estimate is over the cap exactly as it refuses the run. A dry run needs no key (see `key` above).
  if (req.estimate === true) return estimateOutcome(buildEstimate(command, plan.requests.map((r) => r.tokens), { id: resolved.effective.id, promptUsdPerM: resolved.effective.promptUsdPerM }));

  let debugStackPrinted = false;
  // TRDD-28BAL5ER, USER directive "the code must be ready to discover them and use them if jev is not working": candidates are found once per run, from the catalog already loaded, and only if the profile model fails.
  if (removedRule === undefined) noteAliasTarget(resolved);
  const ownIds = new Set([profile.model, primaryId, resolved.requested.id, resolved.requested.canonicalSlug, resolved.effective.id, resolved.effective.canonicalSlug]);
  const ceiling = removedRule === undefined ? resolved.effective.promptUsdPerM : removedRule.ceiling;
  let candidates: Promise<DecisionsModel[]> | undefined;
  const findCandidates = (): Promise<DecisionsModel[]> => (candidates ??= eligible(systemOneFallbackCandidates(ownIds, ceiling, catalog)));
  // WHY counted: one 503 must not retire the model for the whole run (review of TRDD-28BAL5ER); a model is retired after 2 failures, or at once on not-found (it is gone).
  const strikes = new Map<string, number>();
  const retired = new Set<string>();
  const strike = (id: string, e: ClassifierError): void => {
    const n = (strikes.get(id) ?? 0) + 1;
    strikes.set(id, n);
    if (n >= 2 || e.class === "not-found") retired.add(id);
  };
  const announced = new Set<string>();
  let noCeilingSaid = false;
  let priceNoted = false;
  // WHY exec = transport + reply parse + usage record. WHY parseReply: the transport owns the body text, so it is parsed once, by parseDecisionsText, whose callback records the usage before the answers are checked (plan §7).
  const callModel = async (model: string, request: PlannedRequest, deadline: Deadline): Promise<ExecReply> => {
    const started = Date.now();
    let billed: EnvelopeReply | undefined;
    try {
      const raw = await callDecisions(
        { endpoint: profile.endpoint, model, state: request.state, questions: request.questions, provider: profile.provider, sessionId: profile.sessionId, user: profile.user, trace: profile.trace },
        {
          key,
          deadline,
          maxAttempts: profile.maxAttempts,
          fetchImpl: deps.fetch,
          parseReply: (text) => parseDecisionsText(text, (usage, replyModel) => {
            const cost = recordDecisionsUsage({ usage, model, catalog, durationMs: Date.now() - started, endpoint: profile.endpoint });
            // WHY the requested model as fallback: record runs before the reply model is checked (l0/response.ts:62-63), so a billed reply with a missing or blank model is refused later but must still be counted under a model.
            billed = { model: typeof replyModel === "string" && replyModel.trim() !== "" ? replyModel : model, usage, cost };
          }),
        },
      );
      // WHY billed! is safe: parseDecisionsText (l0/response.ts) calls the record callback before it returns a reply, so billed is set whenever raw exists.
      return { answers: raw.answers, model: raw.model, usage: raw.usage, cost: billed!.cost };
    } catch (e) {
      // WHY ANY error after billing, not only a ClassifierError: a reply billed and then lost to a TypeError is in the usage history, so the printed cost must include it (fan-out adds `billed` to the replies).
      // WHY the stack under LLM_EXT_DEBUG=1|true: wrapping a programming error into a request failure must not hide where it came from; printed for the FIRST unclassified error of the run only, redacted like every other output. WHY say: it is the runner's one direct stderr write, so it goes through the optional writer (default process.stderr) and a test captures it without patching a global.
      // WHY DeadlineError is excluded like ClassifierError: it is the request's deadline running out (asClassifierError gives it class timeout) or an abort ending it (runCancellable records the request as aborted), not a programming error, so it has no stack worth printing.
      if (!debugStackPrinted && ["1", "true"].includes(process.env.LLM_EXT_DEBUG ?? "") && !(e instanceof ClassifierError) && !(e instanceof DeadlineError)) {
        debugStackPrinted = true;
        say(safe(e instanceof Error && e.stack ? e.stack : String(e)));
      }
      throw billed !== undefined ? new BilledClassifierError(asClassifierError(e), billed) : e;
    }
  };
  const execRemote = async (request: PlannedRequest, deadline: Deadline): Promise<ExecReply> => {
    let primaryError: ClassifierError | undefined;
    // WHY a second attempt only for 'unavailable': a 5xx may heal at once; a not-found never does and a timeout has spent the request's time.
    for (let attempt = 0; attempt < 2 && !retired.has(primaryId); attempt++) {
      try {
        const reply = await callModel(primaryId, request, deadline);
        if (!priceNoted && removedRule === undefined) { priceNoted = true; noteModelPrice(profile.model, resolved.effective.promptUsdPerM); }
        return reply;
      } catch (e) {
        // WHY the caller's abort never falls back: Ctrl-C must end the run, not start another paid call.
        if (!isModelNotWorking(e) || deadline.reason === "aborted") throw e;
        primaryError = e as ClassifierError;
        strike(primaryId, primaryError);
        if (primaryError.class !== "unavailable") break;
      }
    }
    // WHY the request's own deadline is shared (not a fresh one per candidate): the total time of a request must not exceed the user's timeout_ms; when the profile model spent it, no fallback is tried and the original error stands.
    if (primaryError !== undefined && deadline.reason !== undefined) throw primaryError;
    if (ceiling === null) {
      if (!noCeilingSaid) { noCeilingSaid = true; say(`llm-ext: no System One fallback tried: the catalog has no prompt price for ${primaryId}, so there is no price ceiling`); }
    } else {
      for (const m of await findCandidates()) {
        if (retired.has(m.id)) continue;
        if (deadline.reason !== undefined) break;
        try {
          const reply = await callModel(m.id, request, deadline);
          usedOtherModel = true;
          if (!announced.has(m.id)) {
            announced.add(m.id);
            const text = `${primaryId} is not working${primaryError === undefined ? "" : ` (${primaryError.message})`}; answered by System One fallback ${m.id} (prompt price at or below ${ceiling} USD per million tokens; quality not benchmarked against ${profile.model})`;
            warnings.push(warning("fallback_model", text));
            say(`llm-ext: ${safe(text)}`);
          }
          return reply;
        } catch (e) {
          // WHY a billed error is final: the candidate answered and was charged, so its cost must reach the envelope.
          if (e instanceof BilledClassifierError || deadline.reason === "aborted" || !(e instanceof ClassifierError)) throw e;
          if (isModelNotWorking(e)) strike(m.id, e);
        }
      }
    }
    // WHY the original error: with no usable fallback the run reports exactly what it reported before this card (TRDD-28BAL5ER acceptance). With no primaryError the model was retired by an earlier request; call it again to get the true error.
    if (primaryError !== undefined) throw primaryError;
    return callModel(primaryId, request, deadline);
  };

  /**
   * The local escalation (mlx-decision increment 2): when every remote System One model has failed, ask the
   * loopback decider before failing the request. WHY here and not in fan-out: this is the ONE place that knows a
   * request has no remote answer left; fan-out owns concurrency, retries and budgeting, not model selection.
   *
   * WHY the escalation is SERIALIZED (inside answerWithLocalDecider, not here): a planned run fans its requests
   * out concurrently, and the USER rule for this server is "just wait until the previous tool completed the
   * request to the server" (2026-11-10).
   *
   * WHY the local reply is not a plain success: the run must still say where the answer came from (usedOtherModel
   * adds answered_by, and the warning carries the sentence), because a local model's judgement is not the one the
   * user paid for.
   */
  const exec = async (request: PlannedRequest, deadline: Deadline): Promise<ExecReply> => {
    try {
      return await execRemote(request, deadline);
    } catch (e) {
      // WHY a billed error is final: the remote model answered and was charged, so a second answer from another
      // model would answer a question already answered, and its cost must reach the envelope as it is.
      if (e instanceof BilledClassifierError || !(e instanceof ClassifierError)) throw e;
      // WHY here, before the aborted gate (TRDD-O93LFMF3): the per-request deadline composes only Ctrl-C (l2/abort.ts:64), so the gate below never
      // sees a command stop. The command stop was never part of the local tier's signal either, so a stop during a lease wait was reported as the
      // remote failure and, with the governor off, the decider was still probed and called after the stop. Now a stop ends the local tier like the
      // remote path: no escalation after it, an in-flight local POST is aborted (behaviour change: its answer is lost), and a local answer that
      // arrived before the stop is kept (throwIfStopped is called on the failure paths only, never on the success path).
      throwIfStopped();
      // WHY the run's abort ends it: Ctrl-C (or --command_timeout) must not start a model load, which can take
      // minutes and would outlive the command.
      if (deadline.reason === "aborted" || ctrlC.signal.aborted) throw e;
      // WHY not every failure escalates: bad-request, context-overflow and too-large describe THIS REQUEST
      // (malformed, over any window, over any size cap), so the decider would refuse the
      // same request for the same reason. Everything else means the remote side could not answer at all.
      if (NO_LOCAL_RESCUE.has(e.class)) throw e;
      const local = await answerWithLocalDecider({
        settings: { ...(deps.localFallback === undefined ? {} : { local_fallback: deps.localFallback }) },
        fetchImpl: deps.fetch,
        signal: AbortSignal.any([ctrlC.signal, commandStopSignal()]),
        // WHY the decider gets its own budget instead of the remainder the remote attempts left: the fallback
        // exists for the request whose remote attempts SPENT the budget (a timeout is the common case), so reusing
        // the remainder would disable it exactly there. The budget and the retries are local_fallback settings
        // (requestTimeoutMs, attemptTimeoutMs, maxAttempts), read inside answerWithLocalDecider.
        call: { state: request.state, questions: request.questions, provider: profile.provider, sessionId: profile.sessionId, user: profile.user, trace: profile.trace },
        decider: deps.localFallbackDeps,
      });
      // WHY a disabled fallback is silent: "off" is the configuration the caller chose, so saying it per failed
      // request is noise; every other refusal (unreachable, not installed, still loading, wrong model) is said.
      if (!local.ok && local.disabled) {
        throwIfStopped();
        throw e;
      }
      if (!local.ok) {
        // WHY the remote error still stands: the run reports what actually went wrong on the remote side, and
        // this line says what was tried instead of it. One warning, never a second failure record.
        throwIfStopped();
        say(`llm-ext: ${safe(`the local decider fallback did not answer either: ${local.reason}`)}`);
        throw e;
      }
      usedOtherModel = true;
      if (!localSaid) {
        localSaid = true;
        // WHY the remote error is appended (TRDD-XJE5DDK2): local.notice is built from the local reply alone and cannot know why the remote
        // call failed. A 402 "Insufficient credits" was hidden this way on 2026-11-14 and voided a live check: a paid model was silently
        // replaced by a different local one with exit 0. e.message is already redacted. WHY the class is text and not a field: Warning
        // (l2/warnings.ts) has only code, message and count, and a new envelope field is out of scope for this fix.
        // WHY safe() here: e.message is built from sanitizeProviderError (l0/errors.ts:87), and the whole line also goes through the run redactor, so the warning and stderr never carry unredacted text.
        const notice = safe(`${local.notice}; the remote model failed: ${e.message} (class ${e.class})`);
        warnings.push(warning("local_decider", notice));
        say(`llm-ext: ${notice}`);
      }
      return local.reply;
    }
  };

  /**
   * The classes a local decider must not be asked to rescue. WHY these three: they describe THIS request
   * (malformed, over any model's window, over any model's size cap), so the decider, whose window is smaller,
   * would refuse the same request for the same reason after a model load. Every other class says the remote SIDE
   * could not answer, which is exactly what the decider exists to cover.
   */
  const NO_LOCAL_RESCUE = new Set<ErrorClass>(["bad-request", "context-overflow", "too-large"]);
  // WHY a bare flag and not warnings.length: only the FIRST local answer is announced; a run that escalates
  // several requests must not repeat the same sentence per request (fan-out already reports which model answered
  // which item through answered_by).
  let localSaid = false;
  const ctrlC = installCtrlC(deps.sigint);
  let merged: MergedReply;
  try {
    merged = await runPlan(plan, {
      concurrency: limits.concurrency,
      timeoutMs: profile.timeoutMs,
      signal: ctrlC.signal,
      budget,
      split: spec.split,
      policy: spec.validation,
      defaultLabels,
      exec,
    });
  } finally {
    ctrlC.dispose();
  }

  return conclude(merged);
}

/** The CLI side: argv + input source + output, around runDecision. C4-02/C4-03 call it with a spec from getSpec(). */
export interface ArgvDeps extends RunDeps {
  readFile(path: string): string;
  // WHY a Buffer: collectInputs sniffs for NUL bytes and warns on invalid UTF-8 (E39), which a decoded string has already lost; the JSON path decodes it itself.
  readStdin(): Promise<Buffer>;
  stdout(text: string): void;
  stderr(line: string): void;
}


const VALUE_FLAGS = new Set<string>([...SHARED_FLAGS, ...INPUT_FLAGS].filter((f) => f.type !== "boolean").map((f) => f.flag));

// WHY the INPUT_FLAGS are parsed for every spec: a spec without `cli` must answer "does not take file inputs yet" (input-args.ts), not "unknown option"; only the tool schema is limited to specs with `cli`.
/**
 * Parses `--input file.json` (else JSON on stdin), the shared flags and the spec's own threshold flags, runs, prints, returns the exit code.
 * WHY threshold flags are read from spec.thresholds: the spec is the only place that knows them (plan §4), so a new threshold needs no runner change.
 * IN-01: non-flag words and the INPUT_FLAGS select FILE MODE instead (input-args.ts); the two modes are exclusive, as the plan's "JSON or files" says.
 */
export async function runDecisionArgv<I, R>(spec: DecisionSpec<I, R>, argv: string[], deps: ArgvDeps): Promise<ExitCode> {
  const fail = (m: string): ExitCode => { deps.stderr(`llm-ext: ${m}`); return 1; };
  const req: RunRequest = { input: undefined, thresholdFlags: {} };
  let inputFile: string | undefined;
  const positionals: string[] = [];
  const collectOptions: CollectOptions = {};
  // IN-02: the spec-declared flags as given; parsed after the loop so a refusal does not depend on token order.
  const specRaw = new Map<SpecFlag, string>();
  // IN-05: stdin can be read once; `--claims -` and a JSON input from stdin (or `-` among the files) would otherwise get the same bytes or an empty second read, and the user would not know which input ran.
  let stdinTaken = false;
  const readStdinOnce = async (): Promise<Buffer> => {
    if (stdinTaken) throw new InputError("stdin can be read once: a flag value and the input both read it; give one of them as a file");
    stdinTaken = true;
    return deps.readStdin();
  };
  // WHY the trim check first: Number("") and Number("  ") are 0 and finite, so an empty or blank flag value would pass as the number 0 instead of being refused.
  const number = (flag: string, v: string): number | undefined => (v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : (fail(`${flag} needs a number, got ${JSON.stringify(v)}`), undefined));
  const isKnownFlag = (f: string): boolean => SHARED_FLAGS.some((x) => x.flag === f) || INPUT_FLAGS.some((x) => x.flag === f) || (spec.flags ?? []).some((x) => x.flag === f) || (f.startsWith("--") && Object.hasOwn(spec.thresholds, f.slice(2)));
  for (let k = 0; k < argv.length; k++) {
    const raw = argv[k]!;
    // WHY `--` ends the options and a lone `-` is stdin, as quicksilver parseArgs (qs.mjs:64-77).
    if (raw === "--") { positionals.push(...argv.slice(k + 1)); break; }
    if (raw === "-" || !raw.startsWith("-")) { positionals.push(raw); continue; }
    // WHY this deliberately deviates from qs.mjs:64-77 (which takes any single-dash token as a file name): a mistyped `-top 3` would become an input path and, with a real file named so, a paid question. A path that really starts with "-" is given after `--`.
    // WHY -o is exempt: it is the only short flag SHARED_FLAGS declares (the report directory), so a short flag added there must be exempted here too; every other single-dash token reaching this line is refused.
    if (!raw.startsWith("--") && raw !== "-o") {
      const twin = `-${raw.split("=")[0]}`;
      return fail(`unknown option ${raw}${isKnownFlag(twin) ? ` (did you mean ${twin}?)` : ""}`);
    }
    // C4-08: --estimate is parsed below with the other SHARED_FLAGS booleans (its entry names `estimate`). WHY no separate branch here (TRDD-58CFBQHN): a second parse path for a flag whose help row comes from SHARED_FLAGS could drift from it.
    // WHY the flag names the request field it sets: any boolean flag added to SHARED_FLAGS must declare its field, never fall into strict exit.
    const boolFlag = SHARED_FLAGS.find((f): f is BooleanFlag => f.type === "boolean" && f.flag === raw);
    if (boolFlag) { req[boolFlag.sets] = true; continue; }
    const inputBool = INPUT_FLAGS.find((f): f is BooleanInputFlag => f.type === "boolean" && f.flag === raw);
    if (inputBool) { collectOptions[inputBool.option] = true; continue; }
    const eq = raw.startsWith("--") ? raw.indexOf("=") : -1;
    const flag = eq === -1 ? raw : raw.slice(0, eq);
    const isThreshold = flag.startsWith("--") && Object.hasOwn(spec.thresholds, flag.slice(2));
    // WHY the spec flags are looked up in the spec and not in a shared list: only the spec that declares one takes it (label --labels); every other spec answers "unknown option".
    const specFlag = spec.flags?.find((f) => f.flag === flag);
    if (!VALUE_FLAGS.has(flag) && !isThreshold && specFlag === undefined) return fail(`unknown option ${raw} for classify ${spec.id}`);
    // IN-03: a boolean spec flag (rank --all) takes no value, so the next token stays a positional; `--all=x` is refused rather than read as true.
    if (specFlag?.type === "boolean") {
      if (eq !== -1) return fail(`${flag} takes no value`);
      if (specRaw.has(specFlag)) return fail(`${flag} is given twice`);
      specRaw.set(specFlag, "");
      continue;
    }
    // WHY: "--profile --max-budget 5" must not take "--max-budget" as the profile name.
    const value = eq === -1 ? (argv[k + 1]?.startsWith("--") ? undefined : argv[++k]) : raw.slice(eq + 1);
    if (value === undefined || value === "") return fail(`${flag} needs a value`);
    const inputFlag = INPUT_FLAGS.find((f) => f.flag === flag);
    if (isThreshold) req.thresholdFlags![flag.slice(2)] = value;
    else if (specFlag) {
      // WHY refused: a repeated flag would silently keep one of the two values.
      if (specRaw.has(specFlag)) return fail(`${flag} is given twice`);
      specRaw.set(specFlag, value);
    }
    else if (flag === "--input") inputFile = value;
    else if (flag === "--profile") req.profileFlag = value;
    else if (flag === "-o") req.outputDir = value;
    else if (flag === "--default") req.defaultLabel = value;
    else if (inputFlag?.type === "string") collectOptions[inputFlag.option] = value;
    else if (inputFlag?.type === "number") {
      const n = number(flag, value);
      if (n === undefined) return 1;
      collectOptions[inputFlag.option] = n;
    } else {
      const n = number(flag, value);
      if (n === undefined) return 1;
      // WHY else is --chunk-chars: the branches above handle every other value flag (VALUE_FLAGS), so only --max-budget and --chunk-chars reach here.
      if (flag === "--max-budget") req.maxBudgetUsd = n;
      else req.chunkChars = n;
    }
  }
  // IN-02: field -> {flag, value}. WHY two flags of one field are refused: --labels and --labels-json both fill `classes`, and giving both leaves it unclear which one ran.
  const specFields = new Map<string, { flag: string; value: unknown }>();
  // IN-07: the render flags are output options; they are kept apart so the overlay never writes them into the (strict) input.
  const renderFields = new Map<string, { flag: string; value: unknown }>();
  try {
    for (const [f, rawValue] of specRaw) {
      const target = f.render === true ? renderFields : specFields;
      const prev = target.get(f.field);
      if (prev !== undefined) return fail(`${prev.flag} and ${f.flag} both set ${f.field}; give one`);
      // WHY true directly and parse not called: a boolean flag carries no text to parse (rank --all); its declaration is the value.
      target.set(f.field, { flag: f.flag, value: f.type === "boolean" ? true : await readSpecFlag(f, rawValue, readStdinOnce) });
    }
  } catch (e) {
    // WHY not only InputError: readForJev can throw a plain system error (EACCES); one line, not a stack.
    return fail(e instanceof InputError ? e.message : `cannot read a flag value: ${(e as Error).message}`);
  }
  if (renderFields.size > 0) req.renderOptions = Object.fromEntries([...renderFields].map(([field, { value }]) => [field, value]));
  if (positionals.length > 0 || Object.keys(collectOptions).length > 0) {
    // WHY refused, not preferred: two input sources would leave it unclear which one ran.
    if (inputFile !== undefined) return fail("--input cannot be combined with files, --items or the other file options; pass one or the other");
    try {
      const assembled = await assembleFileInput(spec, positionals, collectOptions, readStdinOnce, deps.stderr);
      req.input = assembled.input;
      req.inputWarnings = assembled.warnings;
    } catch (e) {
      // WHY not only InputError: the reader's file and directory reads throw plain system errors (EACCES, ...); a raw stack for an unreadable input is a worse answer than one line.
      return fail(e instanceof InputError ? e.message : `cannot read the inputs: ${(e as Error).message}`);
    }
  } else {
    try {
      const text = inputFile === undefined ? (await readStdinOnce()).toString("utf8") : deps.readFile(inputFile);
      req.input = JSON.parse(text);
    } catch (e) {
      return fail(`cannot read the JSON input${inputFile === undefined ? " from stdin" : ` ${inputFile}`}: ${(e as Error).message}`);
    }
    // IN-06: the files the JSON names (findings[].file) are read after the parse and before the schema check. WHY its own try: a missing or unusable file must not be reported as "cannot read the JSON input".
    try {
      // WHY these directories only (review round 2, major 1): the JSON is data; its paths may name files under the current directory or beside the --input file, nothing else (stdin JSON: the current directory only).
      const withSources = await readFileSources(spec, req.input, inputFile === undefined ? [process.cwd()] : [process.cwd(), dirname(resolve(inputFile))], { note: deps.stderr });
      req.input = withSources.input;
      if (withSources.warnings.length > 0) req.inputWarnings = withSources.warnings;
    } catch (e) {
      return fail(e instanceof InputError ? e.message : `cannot read the inputs: ${(e as Error).message}`);
    }
  }
  try {
    req.input = overlaySpecFields(req.input, specFields);
  } catch (e) {
    // WHY rethrow: overlaySpecFields refuses with InputError only; anything else is a programming error and must surface as a bug, not print as a user refusal.
    if (!(e instanceof InputError)) throw e;
    return fail(e.message);
  }
  // C4-12 WHY a context here: the classify CLI has no dispatch chokepoint that installs one, and without it every request of the run is written under its own op-id, so the lifetime "runs" total would count requests. An MCP call already runs inside one (index.ts), which is kept.
  const out = ctxStore.getStore() === undefined ? await withUsageContext({ tool: `cli:classify-${spec.id}`, params: "" }, () => runDecision(spec, req, deps)) : await runDecision(spec, req, deps);
  // IN-07 (Q4): the spec text form unless --json; a spec without renderText, and --json, print the envelope. The exit code never depends on this choice.
  const shown = req.json === true ? out.text : (out.display ?? out.text);
  if (shown !== undefined) deps.stdout(shown);
  if (out.reportPath !== undefined) deps.stderr(`report: ${out.reportPath}`);
  if (out.cause !== undefined) deps.stderr(`llm-ext: ${out.cause}`);
  // C4-12: the receipt is the last output of the command. WHY stderr under --json: stdout must stay one parseable JSON document (qs emit(), qs.mjs:898).
  if (out.receipt !== undefined) {
    const lines = renderReceipt(out.receipt, lifetimeOrReason()).split("\n");
    if (req.json === true) for (const l of lines) deps.stderr(l);
    else deps.stdout(lines.join("\n"));
  }
  return out.exitCode;
}
