/**
 * broker/protocol.ts — what the broker process and its clients share
 * (spec points 1, 2 and 4): the state file, the token header and the job
 * reply shape. No server code, so a command process imports only this and
 * broker/client.ts.
 */

import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readCommandLine } from "../local-llama-server.js";

/**
 * The local inference engines the broker serves (TRDD-ZGSGGHQG adds Locals).
 * Each engine keeps its own server registry (servers-<engine>.json: one main
 * and one calibration server per engine), but ONE broker process serves both
 * engines, so only one local model is loaded at a time across them (see
 * runBroker's single `server`).
 */
export type BrokerEngine = "llama" | "locals";
export const BROKER_ENGINES: readonly BrokerEngine[] = ["llama", "locals"];

/** The random per-broker token every request must carry (spec 2): a loopback port is reachable by any local process, the token keeps other processes from submitting or cancelling jobs. */
export const TOKEN_HEADER = "x-llm-ext-broker-token";
/** Which command a job belongs to: the unit of round-robin (spec 3). */
export const COMMAND_HEADER = "x-llm-ext-command";
/** The server context the job needs (a different -c is a different server). */
export const CTX_HEADER = "x-llm-ext-ctx";
/** The engine whose server runs the job (TRDD-ZGSGGHQG): a job of each engine is queued under its own key. */
export const ENGINE_HEADER = "x-llm-ext-engine";
/** Execution timeout, counted by the broker from dispatch (spec 4). */
export const TIMEOUT_HEADER = "x-llm-ext-timeout-ms";
/** The job's own queue timeout in ms (--queue_timeout); absent = the broker's default T. */
export const QUEUE_TIMEOUT_HEADER = "x-llm-ext-queue-timeout-ms";
/** On a 204 poll reply: the job's state and, once dispatched, its dispatch time (ms epoch, broker clock). */
export const STATE_HEADER = "x-llm-ext-job-state";
export const DISPATCHED_HEADER = "x-llm-ext-dispatched-at";
/** argv[2] that turns an llm-ext process into a broker (cli/main.ts, before anything else loads). */
export const BROKER_ARGV = "__broker";

export interface BrokerState {
  pid: number;
  port: number;
  token: string;
  version: string;
  startedAt: string;
}

/** A finished job, as GET /v1/jobs/<id> returns it. */
export interface JobReply {
  state: "done" | "failed" | "cancelled";
  status?: number;
  body?: string;
  contentType?: string;
  error?: string;
  submittedAt: number;
  dispatchedAt?: number;
  finishedAt?: number;
}

/**
 * The broker's state, log and spawn lock. One broker for every local engine
 * (TRDD-ZGSGGHQG): two per-engine brokers could each hold a model, and the
 * user's rule is one local model at a time across engines.
 */
export function brokerStatePath(dir: string): string {
  return join(dir, "broker-local.json");
}
export function brokerLogPath(dir: string): string {
  return join(dir, "broker-local.log");
}
export function brokerSpawnLockPath(dir: string): string {
  return join(dir, "broker-local.lock");
}

export function readBrokerState(dir: string): BrokerState | null {
  try {
    const s = JSON.parse(readFileSync(brokerStatePath(dir), "utf8")) as Partial<BrokerState>;
    if (typeof s.pid !== "number" || typeof s.port !== "number" || typeof s.token !== "string" || typeof s.version !== "string") return null;
    return { pid: s.pid, port: s.port, token: s.token, version: s.version, startedAt: String(s.startedAt ?? "") };
  } catch {
    return null;
  }
}

/** Temp-then-rename, mode 0600 (the file holds the token). */
export function writeBrokerState(dir: string, state: BrokerState): void {
  const target = brokerStatePath(dir);
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, target);
}

/** Remove the state file only while it still names `pid`: after a version handover it names the NEW broker, which the old one must not erase. */
export function removeBrokerStateIfOwn(dir: string, pid: number): void {
  if (readBrokerState(dir)?.pid === pid) rmSync(brokerStatePath(dir), { force: true });
}


/**
 * Is `pid` a broker process (its live argv carries BROKER_ARGV)? Review M9: a
 * bare kill(pid, 0) cannot tell a dead broker whose pid was reused from a live
 * one, so a reused owner pid made an orphaned main look owned (every job waited
 * for ever) and a reused state-file pid looked like a running broker.
 */
export async function isBrokerProcess(pid: number): Promise<boolean> {
  const argv = await readCommandLine(pid);
  return argv !== null && argv.includes(BROKER_ARGV);
}
