/**
 * Production `FetchImpl` adapter. Kept in its own file so judge.ts (the pure,
 * testable loop) does not pull a hard `globalThis.fetch` dependency — tests
 * import only judge.ts and inject a mock, while the orchestrator imports
 * `realFetch` here. The `OPENROUTER_URL` constant lives in judge.ts (it is the
 * judge's endpoint); re-exported here for callers that only import this file.
 */
import { OPENROUTER_URL, type FetchImpl } from "./judge";

export { OPENROUTER_URL };

/** Real fetch adapter — wraps `globalThis.fetch` to the injected shape. */
export const realFetch: FetchImpl = async (url, init) => {
  const res = await fetch(url, init);
  return {
    ok: res.ok,
    status: res.status,
    json: () => res.json() as Promise<unknown>,
    text: () => res.text(),
  };
};
