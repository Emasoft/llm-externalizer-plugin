/**
 * broker/registry.ts — the server-count safeguard (spec point 8,
 * TRDD-1OOAH3LD directive 8b492486: at most one main and one calibration
 * server per local engine).
 *
 * <config>/servers-<engine>.json lists every llm-ext server of the engine
 * (role, pid, pgid, port, argv, owner). It is read and written only inside a
 * short-held async mkdir lock (<config>/servers-<engine>.lock), and the entry
 * is written right after the spawn while the lock is still held, so two
 * processes can never both see a free slot.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isManagedServerArgv, ManagedServerError, pidState, processSnapshot, readCommandLine, stopProcessGroup, withAsyncLock } from "../local-llama-server.js";
import { hasLocalsMarker } from "../local-locals-server.js";
import { isBrokerProcess, type BrokerEngine } from "./protocol.js";

export type ServerRole = "main" | "cal";

/** The role's slot is held by a live server of a live owner. The broker WAITS on this during a version handover (the old broker drains, then frees the slot) instead of failing the jobs. */
export class SlotBusyError extends ManagedServerError {
  constructor(
    message: string,
    readonly holder: RegistryEntry,
  ) {
    super(message);
    this.name = "SlotBusyError";
  }
}

export interface RegistryEntry {
  role: ServerRole;
  pid: number;
  /** Process group: the server is spawned detached, so pgid === pid on POSIX; recorded so an orphan is killed as a group. */
  pgid: number;
  port: number;
  argv: string[];
  model: string;
  ctx: number;
  /** The process that owns the server (the broker for main); a dead owner makes a main an orphan. */
  ownerPid: number;
  startedAt: string;
}

export function registryPath(dir: string, engine: BrokerEngine): string {
  return join(dir, `servers-${engine}.json`);
}


/**
 * Does a raw `ps` command line carry `--log-file <marker>`? Matched on the
 * unsplit text (review m6): `ps` prints argv joined by spaces, so a config dir
 * containing a space (iCloud or Google Drive paths on macOS) split the marker
 * across tokens and the sweep silently found nothing. The marker must end the
 * line or be followed by a space, so `<marker>.1` or a longer name never match.
 */
export function hasLogFileMarker(command: string, marker: string): boolean {
  const needle = ` --log-file ${marker}`;
  for (let i = command.indexOf(needle); i >= 0; i = command.indexOf(needle, i + 1)) {
    const after = command[i + needle.length];
    if (after === undefined || after === " ") return true;
  }
  return false;
}

function registryLockPath(dir: string, engine: BrokerEngine): string {
  return join(dir, `servers-${engine}.lock`);
}
/**
 * The stable marker of a role's llm-ext server (spec point 8): llama-server's
 * --log-file, and for Locals the log its stdout goes to, also named in its
 * argv by `-X llm-ext-server=<marker>` (TRDD-ZGSGGHQG).
 */
export function roleLogFile(dir: string, role: ServerRole, engine: BrokerEngine): string {
  return join(dir, engine === "locals" ? `locals-server-${role}.log` : `llama-server-${role}.log`);
}

/** How logs and errors name an engine's server. */
export function serverLabel(engine: BrokerEngine): string {
  return engine === "locals" ? "Locals server" : "llama-server";
}

/**
 * The registry entries, validated: the file is plain JSON a crash or a hand
 * edit can corrupt, and a pgid of 0 or 1 reaching a kill would signal our own
 * group or every process the user owns (review M7). An entry that is not a
 * well-formed llama-server group leader record is dropped.
 */
export function readRegistry(dir: string, engine: BrokerEngine): RegistryEntry[] {
  try {
    const raw = JSON.parse(readFileSync(registryPath(dir, engine), "utf8")) as { entries?: unknown };
    if (!Array.isArray(raw.entries)) return [];
    return (raw.entries as Array<Partial<RegistryEntry>>).filter(
      (e): e is RegistryEntry =>
        (e.role === "main" || e.role === "cal") &&
        Number.isInteger(e.pid) &&
        (e.pid as number) > 1 &&
        e.pgid === e.pid &&
        Number.isInteger(e.ownerPid) &&
        Array.isArray(e.argv) &&
        e.argv.every((t) => typeof t === "string") &&
        isManagedServerArgv(e.argv),
    );
  } catch {
    return [];
  }
}

/** Temp-then-rename, 0600, so a crash never leaves a half-written registry another process would misread. */
function writeRegistry(dir: string, engine: BrokerEngine, entries: RegistryEntry[]): void {
  const target = registryPath(dir, engine);
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ entries }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, target);
}

function sameArgv(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

/** An entry counts only when its pid is alive AND its live argv still matches the recorded one (a reused pid is not our server). */
async function entryLive(e: Pick<RegistryEntry, "pid" | "argv">): Promise<boolean> {
  if (pidState(e.pid) !== "alive") return false;
  const live = await readCommandLine(e.pid);
  // darwin `ps` splits on whitespace: compare token lists built the same way (paths with whitespace are refused by parseManagedModel).
  return live !== null && sameArgv(live, e.argv.join(" ").split(/\s+/));
}

export interface ClaimOptions {
  dir: string;
  engine: BrokerEngine;
  role: ServerRole;
  ownerPid: number;
  /** Starts the server; called with the lock held. */
  spawn: () => Promise<Omit<RegistryEntry, "role" | "ownerPid" | "startedAt">>;
  log?: (msg: string) => void;
}

/**
 * Claim the role's slot and start its server, all under the registry lock.
 * Before the spawn: dead or reused-pid entries are dropped; a main whose owner
 * is dead (orphan, e.g. a SIGKILLed broker) is stopped by its pgid; an
 * unrecorded process carrying this role's --log-file marker is stopped too.
 * A live entry of the same role owned by a live process refuses the spawn
 * (directive 8b492486), naming server-stop.
 */
export async function claimAndSpawn(o: ClaimOptions): Promise<RegistryEntry> {
  mkdirSync(o.dir, { recursive: true });
  return withAsyncLock(registryLockPath(o.dir, o.engine), async () => {
    const kept = await sweepUnlocked(o.dir, o.engine, o.role, o.log);
    const label = serverLabel(o.engine);
    const holder = kept.find((e) => e.role === o.role);
    if (holder) {
      writeRegistry(o.dir, o.engine, kept);
      throw new SlotBusyError(
        `llm-ext already runs its ${o.role} ${label} (pid ${holder.pid}, port ${holder.port}, model '${holder.model}', owner pid ${holder.ownerPid}); ` +
          `at most one main and one calibration server run per engine. Stop it with 'llm-ext models server-stop'.`,
        holder,
      );
    }
    const started = await o.spawn();
    const entry: RegistryEntry = { ...started, role: o.role, ownerPid: o.ownerPid, startedAt: new Date().toISOString() };
    writeRegistry(o.dir, o.engine, [...kept, entry]);
    return entry;
  });
}

/**
 * The sweep of claimAndSpawn on its own, under the engine's registry lock:
 * stop orphaned mains (owner broker gone) and unrecorded marked servers of
 * `engine`, and return the live entries kept. TRDD-ZGSGGHQG: the broker runs
 * it on the OTHER engine before every start, so a main orphaned by a
 * SIGKILLed broker can never run beside the new one (one local model at a
 * time across engines; claimAndSpawn only sweeps its own engine).
 */
export async function sweepEngine(dir: string, engine: BrokerEngine, role: ServerRole, log?: (msg: string) => void): Promise<RegistryEntry[]> {
  mkdirSync(dir, { recursive: true });
  return withAsyncLock(registryLockPath(dir, engine), async () => {
    const kept = await sweepUnlocked(dir, engine, role, log);
    writeRegistry(dir, engine, kept);
    return kept;
  });
}

/** The sweep itself; the caller holds the engine's registry lock. */
async function sweepUnlocked(dir: string, engine: BrokerEngine, role: ServerRole, log?: (msg: string) => void): Promise<RegistryEntry[]> {
  const kept: RegistryEntry[] = [];
  for (const e of readRegistry(dir, engine)) {
    if (!(await entryLive(e))) continue;
    // Review M9: the owner must still BE a broker (argv carries __broker), not just a live pid: a reused pid made the orphan look owned.
    if (e.role === "main" && !(await isBrokerProcess(e.ownerPid))) {
      const how = await stopProcessGroup(e.pgid);
      log?.(`stopped orphaned main ${serverLabel(engine)} pid ${e.pid} (pgid ${e.pgid}, owner ${e.ownerPid} gone): ${how}`);
      continue;
    }
    kept.push(e);
  }
  const marker = roleLogFile(dir, role, engine);
  const label = serverLabel(engine);
  for (const row of await processSnapshot()) {
    const marked = engine === "locals" ? hasLocalsMarker(row.command, marker) : hasLogFileMarker(row.command, marker);
    if (!marked || kept.some((e) => e.pid === row.pid)) continue;
    // Review M7: the marker alone is not identity. `grep -- --log-file <marker>`
    // or an agent's diagnostic carries it too, and may share a foreign group
    // (a terminal job, a Claude Code session). Only an llm-ext server that leads
    // its own group is ours to stop (stopProcessGroup re-asserts this).
    if (row.pid !== row.pgid || row.pgid <= 1 || !isManagedServerArgv(row.argv)) continue;
    const how = await stopProcessGroup(row.pgid);
    log?.(`stopped unrecorded ${role} ${label} pid ${row.pid} (pgid ${row.pgid}, found by its marker): ${how}`);
  }
  return kept;
}
/** Drop the entry of `pid` (after its group was stopped, or it exited). */
export async function releaseEntry(dir: string, engine: BrokerEngine, pid: number): Promise<void> {
  await withAsyncLock(registryLockPath(dir, engine), async () => {
    writeRegistry(dir, engine, readRegistry(dir, engine).filter((e) => e.pid !== pid));
  });
}


/**
 * The broker stopping its OWN recorded server (review M8). A server that died
 * while idle can sit in the broker's memory for hours; by then its pid (and,
 * on macOS, a shell job's equal pgid) may belong to someone else. So: a dead
 * pid only releases the entry; a live pid is stopped only while its argv
 * still equals the recorded argv; anything else is released, never signalled.
 */
export async function stopOwnServer(
  dir: string,
  engine: BrokerEngine,
  e: Pick<RegistryEntry, "pid" | "pgid" | "argv">,
  log: (msg: string) => void,
): Promise<string> {
  let how: string;
  if (pidState(e.pid) === "dead") how = "already exited";
  else if (await entryLive(e)) how = await stopProcessGroup(e.pgid);
  else {
    how = "pid now runs another program; nothing was signalled";
    log(`server pid ${e.pid} no longer matches its recorded argv: released without a signal`);
  }
  await releaseEntry(dir, engine, e.pid);
  return how;
}
