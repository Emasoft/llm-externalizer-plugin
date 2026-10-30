/**
 * broker/server-commands.ts — `llm-ext models server-status` and `llm-ext
 * models server-stop` (spec local-calibration-design.md section 8; the
 * SlotBusyError text already tells users to run server-stop).
 *
 * Only servers recorded in <config>/servers-<engine>.json are ever listed or
 * stopped, and the stop goes through stopOwnServer: it re-checks that the live
 * argv still equals the recorded one and that the group leader is a
 * llama-server or an llm-ext Locals server, so a server the user started
 * themselves (e.g. Locals on port 8321) is never touched.
 *
 * A main server stopped here is NOT restarted at once: the owning broker
 * notices the dead pid on its next tick, forgets the server and starts a new
 * one only when work arrives (server-stop says so when work is queued). The
 * broker process itself is left alone. A cal server under a live calibration
 * runner is stopped by SIGTERM to that runner, so the stop never counts as a
 * calibration crash (a runner still alive after 60 s is named instead), and
 * held requests for the model mean the broker starts calibration again.
 */

import { pidState } from "../local-llama-server.js";
import { BROKER_ENGINES, isBrokerProcess, isRunnerOf, readBrokerState, TOKEN_HEADER, type BrokerEngine } from "./protocol.js";
import { readRegistry, serverLabel, stopOwnServer, type RegistryEntry, type ServerRole } from "./registry.js";

export interface ServerStopOptions {
  engine?: BrokerEngine;
  role?: ServerRole | "all";
}

async function ownerText(dir: string, e: RegistryEntry): Promise<string> {
  const alive = pidState(e.ownerPid) !== "dead";
  const kind = e.role === "main" ? ((await isBrokerProcess(e.ownerPid)) ? "broker" : "not a broker") : (await isRunnerOf(dir, e.ownerPid)) ? "calibration runner" : "not a calibration runner";
  return `owner pid ${e.ownerPid} (${alive ? "alive" : "dead"}, ${kind})`;
}

/** One line per registered server of every engine, plus the broker process. */
export async function serverStatusText(dir: string): Promise<string> {
  const lines: string[] = [];
  const broker = readBrokerState(dir);
  if (broker && (await isBrokerProcess(broker.pid))) lines.push(`broker: pid ${broker.pid} (port ${broker.port}, version ${broker.version}, since ${broker.startedAt})`);
  else lines.push("broker: not running");
  let count = 0;
  for (const engine of BROKER_ENGINES) {
    for (const e of readRegistry(dir, engine)) {
      count++;
      lines.push(
        `${engine} ${e.role}: model '${e.model}', port ${e.port}, pid ${e.pid} (${pidState(e.pid) === "dead" ? "not alive" : "alive"}), ctx ${e.ctx}, ${await ownerText(dir, e)}, started ${e.startedAt}`,
      );
    }
  }
  if (count === 0) lines.push("no llm-ext server is registered");
  return lines.join("\n");
}

/** How long server-stop waits for a calibration runner to stop its own cal server after SIGTERM. */
const RUNNER_STOP_WAIT_MS = 60_000;

/**
 * The broker's queued and held requests for one model, from its /v1/health; null when no broker of this dir is alive.
 * `queued` counts running jobs too (review of 4856f009): a job running on the server just stopped is requeued a moment
 * later, so a check made right after the stop would miss it. A broker that does not answer is an error: the caller
 * says so instead of guessing there is no work.
 */
async function brokerCounts(dir: string, engine: BrokerEngine, model: string): Promise<{ queued: number; held: number } | null> {
  const st = readBrokerState(dir);
  if (!st || pidState(st.pid) === "dead") return null;
  const res = await fetch(`http://127.0.0.1:${st.port}/v1/health`, { headers: { [TOKEN_HEADER]: st.token }, signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`the broker's /v1/health answered HTTP ${res.status}`);
  const h = (await res.json()) as { models?: Array<{ engine?: string; model?: string; queued?: number; running?: number; held?: number }> };
  const rows = (h.models ?? []).filter((m) => m.engine === engine && m.model === model);
  return { queued: rows.reduce((n, m) => n + (m.queued ?? 0) + (m.running ?? 0), 0), held: rows.reduce((n, m) => n + (m.held ?? 0), 0) };
}

/** Stop the selected registered servers (default: all engines, all roles); one line per server stopped, or per failure. */
export async function serverStopText(dir: string, opts: ServerStopOptions): Promise<{ text: string; isError: boolean }> {
  const engines = opts.engine ? [opts.engine] : BROKER_ENGINES;
  const role = opts.role ?? "all";
  const lines: string[] = [];
  let failed = false;
  for (const engine of engines) {
    for (const e of readRegistry(dir, engine)) {
      if (role !== "all" && e.role !== role) continue;
      try {
        // A cal server is stopped through its runner (review of 2a3ac697): killed under a live runner, the server's
        // death would count as a calibration crash (three fail the model). On SIGTERM the runner stops the server
        // itself, records nothing more and exits, so the model keeps its finished trials and stays queued. The wait is
        // on the RUNNER's exit (review of 2411e6dc, finding D): only a runner that is gone can no longer count a crash,
        // so one still alive after RUNNER_STOP_WAIT_MS is named, never reported as stopped.
        if (e.role === "cal" && (await isRunnerOf(dir, e.ownerPid))) {
          process.kill(e.ownerPid, "SIGTERM");
          for (const end = Date.now() + RUNNER_STOP_WAIT_MS; pidState(e.ownerPid) !== "dead" && Date.now() < end; ) await new Promise((r) => setTimeout(r, 200));
          if (pidState(e.ownerPid) === "dead") lines.push(`stopped the calibration runner pid ${e.ownerPid} first, so this stop is not counted as a calibration crash; '${e.model}' stays in the calibration queue and resumes from its finished trials when a runner starts again`);
          else lines.push(`the calibration runner pid ${e.ownerPid} did not stop within ${RUNNER_STOP_WAIT_MS / 1000} s of SIGTERM; its cal server is stopped directly, and the runner may count this stop as a calibration crash`);
        }
        const how = await stopOwnServer(dir, engine, e, (m) => lines.push(m));
        lines.push(`stopped ${e.role} ${serverLabel(engine)} pid ${e.pid} (port ${e.port}, model '${e.model}'): ${how}`);
        try {
          const counts = await brokerCounts(dir, engine, e.model);
          if (e.role === "main" && counts !== null && counts.queued > 0) lines.push(`the broker still has ${counts.queued} queued or running request(s) for '${e.model}': it will start the server again to serve them`);
          // Review of 2411e6dc, finding E: held requests make the broker re-ensure a runner every RUNNER_RECHECK_MS (60 s).
          if (e.role === "cal" && counts !== null && counts.held > 0) lines.push(`the broker holds ${counts.held} request(s) for '${e.model}' until it is calibrated: it will start calibration again within about a minute`);
        } catch (err) {
          lines.push(`could not ask the broker about queued work for '${e.model}': ${(err as Error).message}`);
        }
      } catch (err) {
        failed = true;
        lines.push(`could not stop ${e.role} ${serverLabel(engine)} pid ${e.pid}: ${(err as Error).message}`);
      }
    }
  }
  if (lines.length === 0) lines.push("no matching llm-ext server is registered; nothing was stopped");
  return { text: lines.join("\n"), isError: failed };
}