// TRDD-GBC4A4CF: the stop notice names only what happened; it is shared by --command_timeout and --stop_on_errors.
import { describe, expect, it } from "vitest";
import { stopNoticeLine } from "./stop-notice.js";

const REASON = "--command_timeout: the command ran longer than 2 s and was stopped";
const TAIL = "finished results, if any, are kept";

describe("stopNoticeLine", () => {
  it("omits the job clause when there were no broker jobs", () => {
    expect(stopNoticeLine(REASON, 0, [])).toBe(`llm-ext: ${REASON}; ${TAIL}`);
  });

  it("names the cancelled jobs", () => {
    expect(stopNoticeLine(REASON, 3, [])).toBe(`llm-ext: ${REASON}; 3 unfinished local job(s) cancelled; ${TAIL}`);
  });

  it("names the jobs that could not be cancelled even when none was cancelled", () => {
    expect(stopNoticeLine(REASON, 0, ["j1", "j2"])).toBe(
      `llm-ext: ${REASON}; 2 job(s) could not be cancelled (left to the broker's abandon rule): j1, j2; ${TAIL}`,
    );
  });

  it("names both the cancelled and the not-cancelled jobs", () => {
    expect(stopNoticeLine(REASON, 1, ["j9"])).toBe(
      `llm-ext: ${REASON}; 1 unfinished local job(s) cancelled; 1 job(s) could not be cancelled (left to the broker's abandon rule): j9; ${TAIL}`,
    );
  });
});
