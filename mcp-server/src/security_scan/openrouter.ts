/**
 * Production `FetchImpl` adapter. Kept in its own file so judge.ts (the pure,
 * testable loop) does not pull a hard `globalThis.fetch` dependency — tests
 * import only judge.ts and inject a mock, while the orchestrator imports
 * `realFetch` here. The `OPENROUTER_URL` constant lives in judge.ts (it is the
 * judge's endpoint); re-exported here for callers that only import this file.
 */
import { OPENROUTER_URL, type FetchImpl } from "./judge";
import { withFreeRotation } from "../free-rotation.js";

export { OPENROUTER_URL };

/** Raw adapter — wraps `globalThis.fetch` to the injected shape. */
const rawFetch: FetchImpl = async (url, init) => {
  const res = await fetch(url, init);
  return {
    ok: res.ok,
    status: res.status,
    json: () => res.json() as Promise<unknown>,
    text: () => res.text(),
  };
};

/**
 * The production adapter, with free-model rotation baked in.
 *
 * This is the chokepoint for every tool that talks to OpenRouter WITHOUT going
 * through the completion layer: security_scan's judge and all four of
 * mass_scout's CLI send sites import exactly this binding. Wrapping it here — as
 * opposed to threading a rotation option through both pipelines — means neither
 * tool's worker pool, retry ladder, circuit breaker, nor report control flow
 * changes at all, and any future direct-HTTP caller inherits rotation by using
 * the adapter it would have used anyway.
 *
 * Tests are unaffected: they inject their own `fetchImpl` and never touch this.
 * Under a paid profile the wrapper is a straight pass-through.
 */
export const realFetch: FetchImpl = withFreeRotation(rawFetch);
