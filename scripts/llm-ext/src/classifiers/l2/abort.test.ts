import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { DeadlineError, type Deadline } from "../l0/deadline.js";
import { CTRL_C_EXIT_CODE, installCtrlC, runCancellable } from "./abort.js";

describe("installCtrlC", () => {
  it("aborts the signal on SIGINT", () => {
    const src = new EventEmitter();
    const c = installCtrlC(src);
    expect(c.signal.aborted).toBe(false);
    src.emit("SIGINT");
    expect(c.signal.aborted).toBe(true);
    expect(c.signal.reason).toBeInstanceOf(DeadlineError);
  });
  it("removes its listener on dispose, so the next Ctrl-C keeps the default behaviour", () => {
    const src = new EventEmitter();
    const c = installCtrlC(src);
    expect(src.listenerCount("SIGINT")).toBe(1);
    c.dispose();
    expect(src.listenerCount("SIGINT")).toBe(0);
    src.emit("SIGINT");
    expect(c.signal.aborted).toBe(false);
  });
  it("removes its listener after the first SIGINT, so a second Ctrl-C is not swallowed", () => {
    const src = new EventEmitter();
    installCtrlC(src);
    src.emit("SIGINT");
    expect(src.listenerCount("SIGINT")).toBe(0);
  });
  it("exits with the shell convention 130", () => {
    expect(CTRL_C_EXIT_CODE).toBe(130);
  });
});

const sleepFor = (ms: number) => (_i: number, _n: number, d: Deadline) => d.sleep(ms);

describe("runCancellable", () => {
  it("without abort every item is done, in index order, within the concurrency bound", async () => {
    let live = 0;
    let peak = 0;
    const r = await runCancellable([1, 2, 3, 4, 5, 6], {
      concurrency: 2,
      timeoutMs: 5000,
      signal: new AbortController().signal,
      worker: async (n, _i, d) => {
        live++;
        peak = Math.max(peak, live);
        await d.sleep(10);
        live--;
        return n * 10;
      },
    });
    expect(r.aborted).toBe(false);
    expect(r.outcomes).toEqual([10, 20, 30, 40, 50, 60].map((value) => ({ status: "done", value })));
    expect(peak).toBe(2);
  });

  it("E53: Ctrl-C during the fan-out aborts every in-flight request at once and keeps the finished ones", async () => {
    const src = new EventEmitter();
    const ctl = installCtrlC(src);
    const ms = [10, 10, 5000, 10, 5000, 5000];
    const recorded: number[] = [];
    const t0 = Date.now();
    setTimeout(() => src.emit("SIGINT"), 150);
    const r = await runCancellable(ms, {
      concurrency: 3,
      timeoutMs: 20_000,
      signal: ctl.signal,
      worker: async (m, i, d) => {
        await d.sleep(m);
        return i;
      },
      // WHY: usage of a finished request is recorded here, the moment it finishes, never by the result of the whole fan-out.
      onDone: (i) => recorded.push(i),
    });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.aborted).toBe(true);
    expect(r.outcomes.map((o) => o.status)).toEqual(["done", "done", "aborted", "done", "aborted", "aborted"]);
    expect(recorded.sort()).toEqual([0, 1, 3]);
    ctl.dispose();
  });

  it("items not yet started when Ctrl-C comes are skipped, not started", async () => {
    const ctl = new AbortController();
    const started: number[] = [];
    setTimeout(() => ctl.abort(), 50);
    const r = await runCancellable([0, 1, 2], {
      concurrency: 1,
      timeoutMs: 20_000,
      signal: ctl.signal,
      worker: async (_n, i, d) => {
        started.push(i);
        await d.sleep(5000);
      },
    });
    expect(started).toEqual([0]);
    expect(r.outcomes.map((o) => o.status)).toEqual(["aborted", "skipped", "skipped"]);
  });

  it("an already-aborted signal starts nothing", async () => {
    const ctl = new AbortController();
    ctl.abort();
    let calls = 0;
    const r = await runCancellable([1, 2], {
      concurrency: 2,
      timeoutMs: 1000,
      signal: ctl.signal,
      worker: async () => {
        calls++;
      },
    });
    expect(calls).toBe(0);
    expect(r.outcomes.map((o) => o.status)).toEqual(["skipped", "skipped"]);
    expect(r.aborted).toBe(true);
  });

  it("a request that finishes after Ctrl-C was pressed but before it noticed is still done and recorded", async () => {
    const ctl = new AbortController();
    const recorded: number[] = [];
    setTimeout(() => ctl.abort(), 20);
    const r = await runCancellable([0], {
      concurrency: 1,
      timeoutMs: 20_000,
      signal: ctl.signal,
      // WHY ignores the deadline: models a reply that was already on the wire and billed when Ctrl-C came.
      worker: async () => {
        await new Promise((res) => setTimeout(res, 80));
        return "billed";
      },
      onDone: (i) => recorded.push(i),
    });
    expect(r.outcomes).toEqual([{ status: "done", value: "billed" }]);
    expect(recorded).toEqual([0]);
  });

  it("a worker failure that is not an abort is reported as failed with its error and the others continue", async () => {
    const boom = new Error("boom");
    const r = await runCancellable([0, 1, 2], {
      concurrency: 1,
      timeoutMs: 5000,
      signal: new AbortController().signal,
      worker: async (_n, i) => {
        if (i === 1) throw boom;
        return i;
      },
    });
    expect(r.outcomes).toEqual([{ status: "done", value: 0 }, { status: "failed", error: boom }, { status: "done", value: 2 }]);
  });

  it("the per-request deadline still applies: a request past timeoutMs fails with a timeout, not an abort", async () => {
    const r = await runCancellable([0], {
      concurrency: 1,
      timeoutMs: 30,
      signal: new AbortController().signal,
      worker: sleepFor(5000),
    });
    const o = r.outcomes[0];
    expect(o.status).toBe("failed");
    expect(o.status === "failed" && o.error).toBeInstanceOf(DeadlineError);
    expect(o.status === "failed" && (o.error as DeadlineError).reason).toBe("timeout");
    expect(r.aborted).toBe(false);
  });

  it("refuses a concurrency that is not a positive integer", async () => {
    const base = { timeoutMs: 1000, signal: new AbortController().signal, worker: async () => 1 };
    await expect(runCancellable([1], { ...base, concurrency: 0 })).rejects.toThrow(RangeError);
    await expect(runCancellable([1], { ...base, concurrency: 1.5 })).rejects.toThrow(RangeError);
  });
});
