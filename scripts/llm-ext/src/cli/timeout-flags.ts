/**
 * cli/timeout-flags.ts — the two global timeout flags (USER rulings
 * 2026-10-28, TRDD-1OOAH3LD broker):
 *
 *   --queue_timeout / --queue-timeout <s>      the longest a queued local job
 *     waits before the broker forces its model onto the server; never an error.
 *   --command_timeout / --command-timeout / --timeout <s>
 *     limits the WHOLE command; on expiry it stops and exits non-zero.
 *
 * Stripped from argv centrally, before the command word is looked at, like
 * --profile: as a per-tool schema field some command would miss it, and the
 * grouped launcher's unknown-flag guess would eat the value. Both `--x=N` and
 * `--x N`; the value is whole seconds.
 */

export const QUEUE_TIMEOUT_FLAGS: readonly string[] = ["--queue_timeout", "--queue-timeout"];
export const COMMAND_TIMEOUT_FLAGS: readonly string[] = ["--command_timeout", "--command-timeout", "--timeout"];

export interface TimeoutFlags {
  argv: string[];
  queueTimeoutS?: number;
  commandTimeoutS?: number;
}

function seconds(flag: string, raw: string | undefined): number {
  if (raw === undefined || !/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new Error(`${flag} expects a whole number of seconds (1 or more), got ${raw === undefined ? "nothing" : `'${raw}'`}`);
  }
  return Number(raw);
}

/** Strip every timeout flag from argv; throws on a missing or non-numeric value (fail fast, never a silent default). */
export function extractTimeoutFlags(argv: readonly string[]): TimeoutFlags {
  const out: string[] = [];
  const res: TimeoutFlags = { argv: out };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const eq = token.indexOf("=");
    const name = eq > 0 ? token.slice(0, eq) : token;
    const isQueue = QUEUE_TIMEOUT_FLAGS.includes(name);
    const isCommand = COMMAND_TIMEOUT_FLAGS.includes(name);
    if (!isQueue && !isCommand) {
      out.push(token);
      continue;
    }
    const value = seconds(name, eq > 0 ? token.slice(eq + 1) : argv[++i]);
    if (isQueue) res.queueTimeoutS = value;
    else res.commandTimeoutS = value;
  }
  return res;
}
