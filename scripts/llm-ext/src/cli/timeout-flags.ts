/**
 * cli/timeout-flags.ts — the two global timeout flags (USER rulings
 * 2026-10-28, TRDD-1OOAH3LD broker):
 *
 *   --queue_timeout / --queue-timeout <s>      the longest a queued local job
 *     waits before the broker forces its model onto the server; never an error.
 *   --command_timeout / --command-timeout / --timeout <s>
 *     limits the WHOLE command; on expiry it stops and exits non-zero.
 *   --network_give_up / --network-give-up <s>   (TRDD-PN0N4290)
 *     how long consecutive network-level failures of the remote service are retried before the
 *     command gives up on it; armed only when a local fallback target is ready. Default 30.
 *
 * Stripped from argv centrally, before the command word is looked at, like
 * --profile: as a per-tool schema field some command would miss it, and the
 * grouped launcher's unknown-flag guess would eat the value. Both `--x=N` and
 * `--x N`; the value is whole seconds.
 */

export const QUEUE_TIMEOUT_FLAGS: readonly string[] = ["--queue_timeout", "--queue-timeout"];
export const COMMAND_TIMEOUT_FLAGS: readonly string[] = ["--command_timeout", "--command-timeout", "--timeout"];

/** --stop_on_errors (TRDD-SWNIIFTF): the one place its spellings are listed; launcher.ts (GLOBAL_BOOLEAN_FLAGS) and the help read this. */
export const STOP_ON_ERRORS_FLAGS: readonly string[] = ["--stop_on_errors", "--stop-on-errors"];

/** --network_give_up <s> (TRDD-PN0N4290): how long consecutive network-level failures of the remote service are retried before the command gives up on it, when a local fallback target is ready. Overrides settings.yaml network_give_up_seconds (default 30). */
export const NETWORK_GIVE_UP_FLAGS: readonly string[] = ["--network_give_up", "--network-give-up"];

/** The largest value a Node timer accepts, in whole seconds: floor((2^31 - 1) / 1000). */
export const MAX_TIMEOUT_S = 2_147_483;

export interface TimeoutFlags {
  argv: string[];
  queueTimeoutS?: number;
  /** --network_give_up, whole seconds. */
  networkGiveUpS?: number;
  commandTimeoutS?: number;
  /** --stop_on_errors was given. */
  stopOnErrors?: true;
}

function seconds(flag: string, raw: string | undefined): number {
  if (raw === undefined || !/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new Error(`${flag} expects a whole number of seconds (1 or more), got ${raw === undefined ? "nothing" : `'${raw}'`}`);
  }
  // Review m2: Node turns a timer delay above 2^31-1 ms (or Infinity) into 1 ms,
  // so a huge --command_timeout would fire at once. Refused, never clamped.
  if (Number(raw) > MAX_TIMEOUT_S) throw new Error(`${flag} is at most ${MAX_TIMEOUT_S} seconds (about 24.8 days), got '${raw}'`);
  return Number(raw);
}

/** Strip every timeout flag from argv; throws on a missing or non-numeric value (fail fast, never a silent default). */
export function extractTimeoutFlags(argv: readonly string[]): TimeoutFlags {
  const out: string[] = [];
  const res: TimeoutFlags = { argv: out };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    // --stop_on_errors takes no value (TRDD-SWNIIFTF); `=value` is not a form of it, so that token falls through as an unknown flag.
    if (STOP_ON_ERRORS_FLAGS.includes(token)) {
      res.stopOnErrors = true;
      continue;
    }
    const eq = token.indexOf("=");
    const name = eq > 0 ? token.slice(0, eq) : token;
    const isQueue = QUEUE_TIMEOUT_FLAGS.includes(name);
    const isCommand = COMMAND_TIMEOUT_FLAGS.includes(name);
    const isGiveUp = NETWORK_GIVE_UP_FLAGS.includes(name);
    if (!isQueue && !isCommand && !isGiveUp) {
      out.push(token);
      continue;
    }
    const value = seconds(name, eq > 0 ? token.slice(eq + 1) : argv[++i]);
    if (isQueue) res.queueTimeoutS = value;
    else if (isGiveUp) res.networkGiveUpS = value;
    else res.commandTimeoutS = value;
  }
  return res;
}
