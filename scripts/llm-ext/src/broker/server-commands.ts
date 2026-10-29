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
 * one only when work arrives. The broker process itself is left alone.
 */

import { pidState } from "../local-llama-server.js";
import { BROKER_ENGINES, isBrokerProcess, isRunnerOf, readBrokerState, type BrokerEngine } from "./protocol.js";
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
        const how = await stopOwnServer(dir, engine, e, (m) => lines.push(m));
        lines.push(`stopped ${e.role} ${serverLabel(engine)} pid ${e.pid} (port ${e.port}, model '${e.model}'): ${how}`);
      } catch (err) {
        failed = true;
        lines.push(`could not stop ${e.role} ${serverLabel(engine)} pid ${e.pid}: ${(err as Error).message}`);
      }
    }
  }
  if (lines.length === 0) lines.push("no matching llm-ext server is registered; nothing was stopped");
  return { text: lines.join("\n"), isError: failed };
}