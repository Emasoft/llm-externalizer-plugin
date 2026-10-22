// C4-01 (TRDD-BUL4EEBP), plan §3 L4 / §9: the ONE runner of every classify decision.
// WHY exactly one path for all specs: a spec (L3) only declares input schema, thresholds, questions and projection; the runner holds no decision text, so a fix to
// profile handling, planning, spend cap, exit codes or the report lands in every command at once and no command can drift (plan §4 "single sources of truth").
import { loadDecisionsCatalog, type DecisionsModel } from "./l0/catalog.js";
import { DeadlineError, type Deadline } from "./l0/deadline.js";
import { ClassifierError } from "./l0/errors.js";
import { loadEndpointPromptLimit, malformedModelIdReason, resolveModel } from "./l0/model.js";
import { parseDecisionsText } from "./l0/response.js";
import { callDecisions, type GlobalFetch } from "./l0/transport.js";
import { recordDecisionsUsage } from "./l1/usage.js";
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
import { modelLimits, planRequests, type PlannedRequest } from "./l2/planner.js";
import { PolicyError, resolveThresholds } from "./l2/policy-kit.js";
import { resolveClassifierApiKey, selectClassifierProfile, type ClassifierProfileInput } from "./l2/profile.js";
import { createRedactor } from "./l2/redact.js";
import { prepareReportDir, writeReport } from "./l2/report.js";
import { warning, type Warning } from "./l2/warnings.js";
import { assembleFileInput, overlaySpecFields, readSpecFlag } from "./input-args.js";
import type { SelectionCheckOptions } from "./profile-checks.js";
import { INPUT_FLAGS, SHARED_FLAGS, type BooleanFlag, type BooleanInputFlag } from "./shared-flags.js";

/** llm-ext's 0/1 (cli/main.ts), quicksilver's 3 key/credits, 4 request rejected, 5 failed after retries (attention.ts), and Ctrl-C. */
export type ExitCode = 0 | 1 | 3 | 4 | 5 | typeof CTRL_C_EXIT_CODE;

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
  /** Plain-string warnings of the input reader (inputs.ts) and of content redaction. */
  inputWarnings?: string[];
}

/** The seams: settings, the one GlobalFetch (no network in tests), catalog cache options and the SIGINT source. */
export interface RunDeps {
  settings: ClassifierProfileInput["settings"];
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
  // WHY a fixed order and not the first failure: which request failed first is a race; the most actionable class wins: 3 (key/credits) > 4 (rejected) > 5 (failed after retries).
  const codes = m.failures.flatMap((f) => (f.error === undefined ? [] : [exitCodeForError(f.error)]));
  const worst = ([3, 4, 5] as const).find((c) => codes.includes(c));
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
    if (e instanceof PolicyError || e instanceof IdError || e instanceof InputError) return { exitCode: 1, cause: safe(e.message) };
    // WHY a fresh Error without `cause`: a bug's message, stack or cause chain may carry the key (an upstream error text), and whatever prints the exception prints all of them.
    const bug = new Error(safe(e instanceof Error ? e.message : String(e)));
    bug.name = e instanceof Error ? e.name : "Error";
    bug.stack = safe(e instanceof Error && e.stack ? e.stack : `${bug.name}: ${bug.message}`);
    throw bug;
  }
}

async function run<I, R>(spec: DecisionSpec<I, R>, req: RunRequest, deps: RunDeps, redactor: ReturnType<typeof createRedactor>, safe: (s: string) => string): Promise<RunOutcome<R>> {
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

  // WHY a closure over the run's state: the empty plan (E65) and the planned run end the same way (project, envelope, report, exit code); two copies could drift.
  const conclude = (merged: MergedReply): RunOutcome<R> => {
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
    const envelope = buildEnvelope({ decision, replies: merged.replies, warnings: [...warnings, ...merged.warnings], degraded: [], stopped: merged.stopped });
    const text = safe(renderEnvelope(envelope));
    const reportPath = reportDir === undefined ? undefined : writeReport(reportDir, spec.id, text);
    const exitCode = failureCode(merged) ?? exitCodeForRun({ attention: spec.attention(decision), strictExit: req.strictExit ?? false });
    return { exitCode, envelope, text, ...(reportPath === undefined ? {} : { reportPath }), ...(exitCode !== 0 && firstFailure !== undefined ? { cause: safe(firstFailure.message) } : {}) };
  };
  // WHY before the empty path: the same flags must be refused or accepted whatever the input built (they need only spec, input and built).
  const specDefaults = spec.chunkDefaults?.(input) ?? {};
  if (req.defaultLabel !== undefined && Object.keys(specDefaults).length === 0) throw new Refusal(`--default does not apply: ${command} has no choice question over text`);
  const userDefault = req.defaultLabel === undefined ? {} : Object.fromEntries(Object.keys(specDefaults).map((k) => [k, req.defaultLabel!]));
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
  if (noQuestions) return conclude(emptyMerged());

  // Profile: --profile or active_classifier; the key is read from its variable NAME now and lives only in this scope.
  // WHY 5: a throw here is the catalog being unreachable with an expired cache (E16), a failure to reach the service, not a bad input.
  // WHY one memoised load per run: selection and the model lookup below both need the catalog, and each load reads the cache file from disk.
  let catalogLoad: Promise<DecisionsModel[]> | undefined;
  const loadCatalog = (): Promise<DecisionsModel[]> => (catalogLoad ??= loadDecisionsCatalog({ fetch: deps.fetch, ...deps.catalogOptions }));
  // WHY the loader is a separate argument, not an option: a public `loadCatalog` option would let any caller replace the cache/TTL/E16 handling silently.
  const selected = await refusingAsync(5, () => selectClassifierProfile({ settings: deps.settings, profileFlag: req.profileFlag, command }, deps.fetch, deps.catalogOptions, loadCatalog));
  if (!selected.ok) throw new Refusal(selected.error);
  const { profile } = selected;
  const key = refusing(3, () => resolveClassifierApiKey(profile));
  redactor.register(key);

  const catalog = await refusingAsync(5, loadCatalog);
  const resolved = refusing(1, () => resolveModel(profile.model, catalog));
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
  if ("ok" in limits) throw new Refusal(limits.message);
  const plan = planRequests(built, { ...limits, ...(req.chunkChars === undefined ? {} : { chunkChars: req.chunkChars }) });
  // WHY returned, not thrown, by the planner: a refusal is an answer about the input; nothing was sent.
  if (!plan.ok) throw new Refusal(plan.message);
  refusing(1, () => checkEstimate({ maxBudgetUsd: req.maxBudgetUsd, estimatedInputTokens: plan.requests.reduce((n, r) => n + r.tokens, 0), model: resolved }));

  let debugStackPrinted = false;
  // exec = transport + reply parse + usage record. WHY parseReply: the transport owns the body text, so it is parsed once, by parseDecisionsText, whose callback records the usage before the answers are checked (plan §7).
  const exec = async (request: PlannedRequest, deadline: Deadline): Promise<ExecReply> => {
    const started = Date.now();
    let billed: EnvelopeReply | undefined;
    try {
      const raw = await callDecisions(
        { endpoint: profile.endpoint, model: profile.model, state: request.state, questions: request.questions, provider: profile.provider, sessionId: profile.sessionId, user: profile.user, trace: profile.trace },
        {
          key,
          deadline,
          maxAttempts: profile.maxAttempts,
          fetchImpl: deps.fetch,
          parseReply: (text) => parseDecisionsText(text, (usage, model) => {
            const cost = recordDecisionsUsage({ usage, model: profile.model, catalog, durationMs: Date.now() - started, endpoint: profile.endpoint });
            billed = { model: typeof model === "string" && model.trim() !== "" ? model : profile.model, usage, cost };
          }),
        },
      );
      return { answers: raw.answers, model: raw.model, usage: raw.usage, cost: billed!.cost };
    } catch (e) {
      // WHY ANY error after billing, not only a ClassifierError: a reply billed and then lost to a TypeError is in the usage history, so the printed cost must include it (fan-out adds `billed` to the replies).
      // WHY the stack under LLM_EXT_DEBUG=1|true: wrapping a programming error into a request failure must not hide where it came from; printed for the FIRST unclassified error of the run only, redacted like every other output. WHY deps.stderr: it is the runner's one direct stderr write, so it goes through the optional writer (default process.stderr) and a test captures it without patching a global.
      if (!debugStackPrinted && ["1", "true"].includes(process.env.LLM_EXT_DEBUG ?? "") && !(e instanceof ClassifierError) && !(e instanceof DeadlineError)) {
        debugStackPrinted = true;
        const stack = safe(e instanceof Error && e.stack ? e.stack : String(e));
        if (deps.stderr === undefined) process.stderr.write(`${stack}\n`);
        else deps.stderr(stack);
      }
      throw billed !== undefined ? new BilledClassifierError(asClassifierError(e), billed) : e;
    }
  };

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
  const number = (flag: string, v: string): number | undefined => (v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : (fail(`${flag} needs a number, got ${JSON.stringify(v)}`), undefined));
  const isKnownFlag = (f: string): boolean => SHARED_FLAGS.some((x) => x.flag === f) || INPUT_FLAGS.some((x) => x.flag === f) || (spec.flags ?? []).some((x) => x.flag === f) || (f.startsWith("--") && Object.hasOwn(spec.thresholds, f.slice(2)));
  for (let k = 0; k < argv.length; k++) {
    const raw = argv[k]!;
    // WHY `--` ends the options and a lone `-` is stdin, as quicksilver parseArgs (qs.mjs:64-77).
    if (raw === "--") { positionals.push(...argv.slice(k + 1)); break; }
    if (raw === "-" || !raw.startsWith("-")) { positionals.push(raw); continue; }
    // WHY this deliberately deviates from qs.mjs:64-77 (which takes any single-dash token as a file name): a mistyped `-top 3` would become an input path and, with a real file named so, a paid question. A path that really starts with "-" is given after `--`.
    if (!raw.startsWith("--") && raw !== "-o") {
      const twin = `-${raw.split("=")[0]}`;
      return fail(`unknown option ${raw}${isKnownFlag(twin) ? ` (did you mean ${twin}?)` : ""}`);
    }
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
      if (flag === "--max-budget") req.maxBudgetUsd = n;
      else req.chunkChars = n;
    }
  }
  // IN-02: field -> {flag, value}. WHY two flags of one field are refused: --labels and --labels-json both fill `classes`, and giving both leaves it unclear which one ran.
  const specFields = new Map<string, { flag: string; value: unknown }>();
  try {
    for (const [f, rawValue] of specRaw) {
      const prev = specFields.get(f.field);
      if (prev !== undefined) return fail(`${prev.flag} and ${f.flag} both set ${f.field}; give one`);
      // WHY true directly and parse not called: a boolean flag carries no text to parse (rank --all); its declaration is the value.
      specFields.set(f.field, { flag: f.flag, value: f.type === "boolean" ? true : await readSpecFlag(f, rawValue) });
    }
  } catch (e) {
    // WHY not only InputError: readForJev can throw a plain system error (EACCES); one line, not a stack.
    return fail(e instanceof InputError ? e.message : `cannot read a flag value: ${(e as Error).message}`);
  }
  if (positionals.length > 0 || Object.keys(collectOptions).length > 0) {
    // WHY refused, not preferred: two input sources would leave it unclear which one ran.
    if (inputFile !== undefined) return fail("--input cannot be combined with files, --items or the other file options; pass one or the other");
    try {
      const assembled = await assembleFileInput(spec, positionals, collectOptions, deps.readStdin);
      req.input = assembled.input;
      req.inputWarnings = assembled.warnings;
    } catch (e) {
      // WHY not only InputError: the reader's file and directory reads throw plain system errors (EACCES, ...); a raw stack for an unreadable input is a worse answer than one line.
      return fail(e instanceof InputError ? e.message : `cannot read the inputs: ${(e as Error).message}`);
    }
  } else {
    try {
      const text = inputFile === undefined ? (await deps.readStdin()).toString("utf8") : deps.readFile(inputFile);
      req.input = JSON.parse(text);
    } catch (e) {
      return fail(`cannot read the JSON input${inputFile === undefined ? " from stdin" : ` ${inputFile}`}: ${(e as Error).message}`);
    }
  }
  try {
    req.input = overlaySpecFields(req.input, specFields);
  } catch (e) {
    // WHY rethrow: overlaySpecFields refuses with InputError only; anything else is a programming error and must surface as a bug, not print as a user refusal.
    if (!(e instanceof InputError)) throw e;
    return fail(e.message);
  }
  const out = await runDecision(spec, req, deps);
  if (out.text !== undefined) deps.stdout(out.text);
  if (out.reportPath !== undefined) deps.stderr(`report: ${out.reportPath}`);
  if (out.cause !== undefined) deps.stderr(`llm-ext: ${out.cause}`);
  return out.exitCode;
}
