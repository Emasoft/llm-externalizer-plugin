/**
 * broker/protocol.ts — what the broker process and its clients share
 * (spec points 1, 2 and 4): the state file, the token header and the job
 * reply shape. No server code, so a command process imports only this and
 * broker/client.ts.
 */

import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readCommandLine } from "../local-llama-server.js";

/** The one engine this increment brokers; Locals follows in its own increment. */
export type BrokerEngine = "llama";

/** The random per-broker token every request must carry (spec 2): a loopback port is reachable by any local process, the token keeps other processes from submitting or cancelling jobs. */
export const TOKEN_HEADER = "x-llm-ext-broker-token";
/** Which command a job belongs to: the unit of round-robin (spec 3). */
export const COMMAND_HEADER = "x-llm-ext-command";
/** The server context the job needs (a different -c is a different server). */
export const CTX_HEADER = "x-llm-ext-ctx";
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

export function brokerStatePath(dir: string, engine: BrokerEngine): string {
  return join(dir, `broker-${engine}.json`);
}
export function brokerLogPath(dir: string, engine: BrokerEngine): string {
  return join(dir, `broker-${engine}.log`);
}
export function brokerSpawnLockPath(dir: string, engine: BrokerEngine): string {
  return join(dir, `broker-${engine}.lock`);
}

export function readBrokerState(dir: string, engine: BrokerEngine): BrokerState | null {
  try {
    const s = JSON.parse(readFileSync(brokerStatePath(dir, engine), "utf8")) as Partial<BrokerState>;
    if (typeof s.pid !== "number" || typeof s.port !== "number" || typeof s.token !== "string" || typeof s.version !== "string") return null;
    return { pid: s.pid, port: s.port, token: s.token, version: s.version, startedAt: String(s.startedAt ?? "") };
  } catch {
    return null;
  }
}

/** Temp-then-rename, mode 0600 (the file holds the token). */
export function writeBrokerState(dir: string, engine: BrokerEngine, state: BrokerState): void {
  const target = brokerStatePath(dir, engine);
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, target);
}

/** Remove the state file only while it still names `pid`: after a version handover it names the NEW broker, which the old one must not erase. */
export function removeBrokerStateIfOwn(dir: string, engine: BrokerEngine, pid: number): void {
  if (readBrokerState(dir, engine)?.pid === pid) rmSync(brokerStatePath(dir, engine), { force: true });
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
