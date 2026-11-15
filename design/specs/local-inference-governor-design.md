# Local inference governor: machine-wide limits on RAM and CPU use

Status: design, not implemented. Paths are relative to `scripts/llm-ext/`. Card: TRDD-ZTO9K8EK.

USER goal (verbatim): "implementing a self regulating safeguard that will enforce limits to both ram and cpu core percentage of use, ensuring that even if a hundred different llm-ext cli proceses are executed at the same time, the amount of concurrent local inferences actually running will be modulated in realtime so they will never cause the sytem to surpass those limits."

Rationale in one sentence: every local inference and every local model load that llm-ext starts first takes a lease from one per-user chokepoint, which grants leases only while system RAM and CPU readings, and the deterministic thread and RAM budgets of llm-ext's own servers, stay inside the limits.

What "never" means here, precisely. The claim is about what llm-ext adds. The thread budget and the load projection are deterministic bounds on llm-ext's own share. The system readings add back-off against heat from other programs. A running inference is never paused, so a reading can cross a limit because another program rose after the grant.

## 1. Verified facts this design rests on

Read in the code at the cited lines on branch release/13.6.1.

1. The broker is per config dir. `brokerStatePath(dir)` joins `broker-local.json` under `dir` (`src/broker/protocol.ts:72`), `runBrokerMain` passes `getConfigDir()` (`src/broker/server.ts:1077`), and `getConfigDir` is `LLM_EXT_CONFIG_DIR` or `~/.llm-externalizer` (`src/config.ts:844-845`). The spawn pins that env var on the child (`src/broker/client.ts:229`). The registry is per dir too (`src/broker/registry.ts:46`). So 100 config dirs give 100 brokers, each allowed one main and one cal server per engine. The "one local model at a time" rule holds per dir, never per machine.
2. Exactly two sites start a model server, and both go through `claimAndSpawn` (`src/broker/registry.ts:148`): `swapTo` (`src/broker/server.ts:483`, spawn at `:537`) and `startCalServer` (`src/calibration/runner.ts:202`, spawn at `:218`). The second is also reached through `ctx.restart` (`runner.ts:525`) from Phase B (`phase-b.ts:195,467,479`) and Phase C (`phase-c.ts:216,277`). `startBroker` (`broker/client.ts:224`) starts no model.
3. Inference senders:
   - Broker: `connection.ts:145-146` then `completion.ts:514` then `broker/server.ts:673` (`postJson`).
   - Direct, bypassing the broker: routed groups (`connection.ts:153`), primary unmanaged profiles (`connection.ts:204`), both ending at `fetchWithRetry429` (`completion.ts:522`, attempt at `provider/http.ts:336`). LM Studio native: `chatCompletionNative` (`completion.ts:552,797`, sends at `lmstudio.ts:220`). `localBroker` returns null for all of these (`index.ts:1844`). These are the paths to user-started ollama, LM Studio, vLLM and similar servers.
   - Calibration, direct to its own cal server: `phase-a.ts:292` and `classifyPositional` in Phase C (`phase-c.ts:298`).
   - Others: `benchmark/local-bench.ts:156` and the scouting `rawFetch` (`mass_scouting/cli.ts:529`) when the target is a local server.
4. `isLocalUrl` and the `isLocal` flag are not "this machine". The pattern matches private LAN ranges and `.local` names (`config.ts:964-982`), and `backend.type "local"` includes remote b.ai (`connection.ts:166` comment). A gate needs its own loopback test.
5. Sizing today. `-np` is `target.slots ?? (ctx > 0 ? 2 : 1)` and `-c` is ctx times slots; no `-t` is passed (`local-llama-server.ts:101-116`). The broker's target carries no slots (`broker/server.ts:529`), so the calibrated `main.slots` (`calibration/record.ts:138`) is not used by the main server. Locals gets `--slots 4` (`local-locals-server.ts:38,116`).
6. Memory checks today. The floor is `LLM_EXT_BROKER_MEMORY_FLOOR`, default 10 percent free (`broker/scheduler.ts:36,49,63`). The broker gates only Locals, only beyond the first in-flight job (`broker/server.ts:248,811`). Calibration checks at each step (`calibration/memory-wait.ts:35,99`, `phase-b.ts:384`, `phase-c.ts:189-192`). No memory check exists before any main server load, and none on llama-server dispatch or the direct path. Nothing reads CPU except a logged `load_avg`. (Unit 6 removed that floor variable: the free-memory floor is `100 - ram_limit_pct`.)
7. Readings, measured on a 14-core 64 GB Apple Silicon machine with Node 26: `os.freemem()` 1.0 percent while `memory_pressure` said 83 percent free, so `os.freemem` is unusable on macOS. `sysctl kern.memorystatus_level` also said 83, one reading. `memory_pressure` 9 ms, `os.cpus()` 0.03 ms, `ps -o lstart=` 19 ms. Utilisation over 500 ms was 81.7 percent at load average 99.
8. llama-server exposes `-t`, `-tb`, `--poll` (default 50), `-ngl` (default auto); `-t` defaults to -1 (`llama-server --help`, build 11960). Locals' argparse has no thread option; it has `--cache-gb`, whose default is the GPU memory left after the weights and 4 GB (`locals/server.py:2235-2257`).
9. `--queue_timeout` is not a failure deadline. It rotates the job's model in, and waiting past it is never an error (`broker/client.ts` comment above `:75`, `cli/timeout-flags.ts`). `--command_timeout` stops the command, exit 124 (`cli/main.ts` `armCommandTimeout`).

## 2. Decisions

Each point: the choice, the rejected alternative, why.

### D1. The chokepoint is a per-uid state directory, not a daemon

Choice: `/tmp/llm-ext-governor-<uid>/` holding `state-1.json` and a `lock/` mkdir lock. The path comes from `os.userInfo().uid` and never from an env var. `LLM_EXT_GOVERNOR_DIR` overrides it and only tests set it. Created mode 0700. On use, `lstat` must show a directory owned by this uid, not a symlink; otherwise the request fails with a clear error, because a world-writable parent allows squatting. A reboot clears it, which is correct: no lease survives a reboot. A reboot clearing it also means the name is new to a fresh machine: `test-tmpdir-guard.ts` flags a new `/tmp` entry matching `/llm[-_]?ext/i`, so a test that misses the override is caught, and an entry that existed before the run is ignored.

Rejected: a detached governor daemon on a loopback port. It needs its own spawn lock, version handover and crash restart (`broker/client.ts:168` is that much code for the broker), and it would be one more process that must stay alive for local inference to run at all. Rejected: `homedir()` or `os.tmpdir()`: they follow `HOME` and `TMPDIR`, which tests and workers change, so processes would silently split into separate governors. Rejected: `os.userInfo().homedir`: it fails on a uid with no passwd entry and may sit on a slow volume. Rejected: `node:sqlite`: experimental while `engines` allows Node 20.

Windows: uid is -1, so the name uses the user name under `os.tmpdir()`. The owner check and start-time identity do not apply there; pid alone identifies a holder. Windows stays unverified, like the rest of the broker.

### D2. Short non-blocking lock, atomic reads

Choice: every mutation is a sync critical section of a few ms: `mkdir lock/`, read, mutate, write temp, rename, `rmdir`. It never spans an await. A busy lock is not waited on: `tryAcquire` returns false and the caller retries on its next poll, so a broker's event loop never blocks. Readers need no lock, because rename makes `state-1.json` a consistent snapshot. A lock dir older than 5 s is taken over; holders never refresh it, because they never hold it that long.

Rejected: `withAsyncLock` (`local-llama-server.ts:229`): it retries every 20-50 ms for up to 60 s, so 100 waiters would spin on it. Rejected: `withMkdirLock` (`mkdir-lock.ts`): it proceeds unlocked after 5 s, which voids the guarantee.

Risk accepted: a holder descheduled past 5 s can lose one update after a takeover. The state self-heals on the next reap, and the worst case is one extra grant.

A corrupt `state-1.json` is replaced by an empty state and logged. An unusable directory is an error naming the path; there is no silent pass-through. `enabled: false` is the only way out (D13).

### D3. What a lease is, and crash safety

State (schema 1, kept in the file name `state-1.json`, so a future incompatible schema coexists during an upgrade):

    metrics: { at, cpuSample: { at, busyMs, totalMs }, cpuPct, freePct }
    window: { w, changedAt }
    waiters: [ { id, kind, weight, holder, since, queueTimeoutMs, limits } ]
    leases:  [ { id, kind, weight, threads, serverPid, bytes, holder, at, expiresAt } ]
    servers: [ { pid, start, ownerPid, ownerStart, threads, bytes, lastUsedAt, wantUnload } ]

`holder` is `{ pid, start }`. `kind` is `inference` or `load`.

Reaping happens in every critical section: `kill(pid, 0)` on each holder reclaims a dead one at once. Start time catches a reused pid: the sampling waiter (D7) runs one `ps -o pid=,lstart= -p <list>` with `LC_ALL=C` at most every 30 s, outside the lock (Linux reads `/proc/<pid>/stat` field 22), and passes the verdict into its next critical section. `expiresAt` is the job's execution timeout plus 60 s, a backstop against a leak in a live holder.

Rejected: live argv identity (`broker/registry.ts:123`). It works for a server, but a command process has no distinctive argv, and it costs one `ps` per entry. Second-granular `lstart` is enough: a pid reused within the same second is not a practical case, and the fixed locale makes the strings comparable.

### D4. What is measured, and what "cpu core percentage" means

CPU: the percentage of all logical cores busy, system-wide, from two `os.cpus()` samples at least 500 ms apart. `os.loadavg` is never used: it counts runnable threads over minutes, and was 99 while utilisation was 82 percent. The earlier sample is stored in `metrics.cpuSample`, so the next process to sample computes the delta at once, with no timer of its own, as long as the stored sample is 0.5 to 10 s old. Otherwise it stores a sample and waits about 500 ms. The value is smoothed once: `cpuPct = 0.5 * old + 0.5 * new`.

`cpu_limit_pct` has two effects, one setting:

- a ceiling on total system utilisation: new grants stop at or above it, even when the heat comes from other programs;
- a deterministic budget: the threads of llm-ext servers with an inference running sum to at most `floor(cores * cpu_limit_pct / 100)`, at least 1.

Rejected: a separate setting for each; two numbers meaning nearly the same invite a contradictory configuration. Rejected: the reading "a share of cores for llm-ext alone" as the only effect: it would ignore other programs. The budget covers that reading anyway. Performance and efficiency cores count equally; `os.cpus()` does not tell them apart.

RAM (round 3 of unit 4, coordinator decision 2026-10-31, replacing the first choice below): used = (`Anonymous pages` + `Pages wired down` + `Pages occupied by compressor`) x page size from one `vm_stat` call (page size from its first line), divided by `hw.memsize` (`os.totalmem()`); `governor/ram.ts`. A missing field or unparsable output is an error, never a default. It replaces `memory_pressure` everywhere the governor reads RAM: `metrics.ts readMemory` (the sampler and the load watchdog) and `memoryFreePercent` (`local-locals-server.ts`), which calibration's `freeMemory` and Phase B read on darwin, so calibration and the governor still share one figure. Measured (reports_dev/governor/20261031_144619+0100-ram-reading-measure.md, 64 GiB machine): a 6 GiB anonymous, incompressible allocation moved `memory_pressure`'s free percentage and `kern.memorystatus_level` by 1 point, because they count reclaimable memory as free; the vm_stat figure rose 5.0 GiB, tracking within 1 to 2 s, and fell back after exit; a 4 GiB read into retained buffers showed +3.0 GiB within one sample; page cache was not counted. Cost: vm_stat 7.6 ms, memory_pressure 7.9 ms (mean of 10). Model loads (reports_dev/governor/20261031_145637+0100-model-load-ram-measure.md, LFM3-1.7B): llama.cpp with mmap and with `-lm none` both appear as wired pages, +1.6 to 2.1 GiB for 1.48 GiB of weights, within 3 to 5 s of start, until exit; file-backed pages rose 1.2 to 1.6 GiB, the GGUF's page cache, reclaimable, and not counted (counting it would count the weights twice). An MLX (Locals) server is wired while loading or generating (+1.2 to 1.6 GiB) but its wired pages drop to 0 while idle, so the governor books each registered Locals server by its projection (D11). Linux: MemTotal - MemAvailable from `/proc/meminfo`. Windows: `os.totalmem() - os.freemem()`, unchanged. Both unverified on a real machine. Calibration's `freeMemory` on Linux still reads `os.freemem()` (its file is outside unit 4), so the two figures differ there until it is aligned.


Assumption (round 4 #12c, not verified): `vm_stat` prints the `Anonymous pages` line on every macOS llm-ext supports. No minimum macOS is stated anywhere (README; `package.json` names only `engines.node >= 20.3.0`), and the reading was verified only on the development machine (macOS 27.2). If a supported release lacks the line, the reader fails fast naming it (`vm_stat printed no 'Anonymous pages' line`): every governed load and inference then fails with that error, never a silent wrong figure.
First choice, superseded by the paragraph above: used percent is `100 - free`, from the existing readers, `memoryFreePercent` on darwin (`memory_pressure`) and `freeMemory`'s `os.freemem` elsewhere (`calibration/memory.ts`). Rejected then: parsing `vm_stat`, as a second definition of "free" beside calibration's; the measurement showed the old one does not see allocations, and calibration now reads the same vm_stat figure. `ram_limit_pct` replaces the floor: the broker floor variable and `memoryFloorPct` were removed in unit 6, and calibration's floor becomes `100 - ram_limit_pct`, so one value governs both. The default 90 equals today's floor of 10. The default was later lowered to 80 for both RAM and CPU by owner ruling (TRDD-ZTO9K8EK). Until then the floor is still read by calibration (`phase-b.ts`, `phase-c.ts`, `memory-wait.ts`, `record.ts memoryVerdictStale`).

Metal: GPU work does not show in `os.cpus()`. With a model fully on the GPU the CPU figure understates the machine's real load, and this design does not limit GPU use, which the USER goal does not name. Unified memory means Metal allocations do show in the RAM reading, so RAM is the binding limit on Apple Silicon. `max_inferences` (D5) also bounds GPU work indirectly.

### D5. Admission per inference, with a self-regulating window

Choice: one lease per inference, taken by the process that posts to the model server, at the moment of the post. `-np` is fixed at server start, so per-server limits cannot react.

Rejected: the client acquiring before submitting to the broker. It would hold a lease while queued behind model rotation.

The controller is a pure function in the style of `broker/scheduler.ts`: state, reading and clock in, new state and verdicts out. `w` is the machine-wide number of inferences allowed, from 1 to `max_inferences`. `high = limit`, `low = limit - 10` for CPU and `limit - 5` for RAM.

    over  = cpuPct >= cpuHigh or ramUsed >= ramHigh
    under = not over, and no decrease in the last 30 s, or cpuPct <  cpuLow and ramUsed <  ramLow

- `over`, at most once per settle interval (2 s): `w = max(1, floor(w / 2))`. No new lease.
- `under`, and running equals `w`, and `w` did not change in the last settle interval: `w = w + 1`.
- between the marks: `w` holds; a released lease may be replaced.
- a grant needs `running + weight <= min(w, its own max_inferences)`, or, for a weight above that, no inference running at all (D9), and in both cases not `over`, metrics no older than 2 s, and the thread budget (D10).
- `w` returns to 1 after 60 s with no lease.

This is additive increase, multiplicative decrease. The band is the hysteresis after a decrease, and only then: required always, it kept `w` at 1 for good on the machine the default was chosen for, at 81.7 percent CPU with a limit of 85. The settle interval covers the lag between a grant and the reading that shows it. Replacing a finished inference needs no ramp, so short requests keep their throughput. The rise from 1 to 8 takes about 14 s.

Rejected: pacing every grant by the settle interval: it caps short requests at one every 2 s. Rejected: an equal per-process share: it cannot react to the machine.

`max_inferences` defaults to 8: Locals' measured throughput was 69, 242, 357, 399 tok/s at 1, 4, 8, 16 requests (`local-locals-server.ts:33-37`), so 8 is near the knee.

### D6. Already over the limit because of other programs

CPU over the ceiling, nothing of llm-ext running: the head waiter gets one lease once it has waited `min(30 s, its --queue_timeout)`. So a machine that stays hot runs llm-ext one inference at a time, and a short spike is ridden out. This floor runs under the thread budget, so llm-ext's own share stays bounded.

RAM over the ceiling: zero grants and zero loads, with no floor. Swap and compressor exhaustion has panicked the kernel of a development machine. CPU overload slows a machine; RAM exhaustion takes it down.

Rejected: zero grants on CPU as well: 81.7 percent was measured on a busy development machine, and an 85 limit with a test suite running would stop all local work for as long as the suite runs. Rejected: one always allowed on CPU (the precedent at `broker/server.ts:808-811`): it removes the back-off the USER asked for. That precedent ends: see D11 for the Locals cache problem it worked around.

Waiting is never an error. It ends in one of three ways:

- CPU: bounded by the floor above, so by `--queue_timeout` when that is shorter than 30 s.
- RAM: bounded only by `--command_timeout`. `--queue_timeout` does not end a RAM wait, because the only thing it could do there is force a load past the limit. This is a deliberate narrowing of "bounded by --queue_timeout": see open question 2.
- The client prints one stderr line at once and at most every 60 s, like `printHeld` (`broker/client.ts`), naming the figure that blocks it.

A model that can never fit (projection above `totalmem * ram_limit_pct / 100` with nothing else running) is a model error at once, like calibration's too-big verdict, so the fallback walker moves on.

### D7. Fairness, herd and polling cost

One waiter per requester process and per kind, whatever its queue depth: a broker with 1,000 queued jobs and a CLI with one each hold one place. Order is first come, first served; a requester that was granted goes to the tail if it still has work. So 100 requesters take turns, and inside one broker the existing round-robin by command (`broker/scheduler.ts`) divides that turn.

Only the head may grant itself, and only the head samples. Nobody else can act on a good reading, so a release wakes nobody. Polling:

| who | interval |
|---|---|
| rank up to free capacity, at most 4 | 200 ms, plus up to 50 ms of jitter |
| everyone else | 1 to 2 s, with jitter; reads the file, no lock |
| a holder with no waiter of its own | nothing |
| no waiters, no servers | nothing at all: no reading, no file touched |

So 100 waiters cost about 85 file reads per second and at most 5 lock passes per second, and one `memory_pressure` per second, on one process. A head that dies is reaped by the next rank, which then becomes head. Rejected: every waiter sampling: 100 `memory_pressure` spawns a second is the failure mode behind the 30 s `execText` timeout (`local-llama-server.ts:167`). Rejected: a wake-up signal or socket: cross-process state for a saving of at most 250 ms.

### D8. Broker integration

In `pump` (`broker/server.ts:807`), inside the slot loop and before `sched.take`: `gov.tryAcquire` first. A job is taken only after a lease exists, so a denial loses no FIFO order. A lease taken for a `take` that yields nothing (`scheduler.ts` returns undefined on an empty queue) is released in the same pump iteration. `dispatch` carries the lease; `.finally` at `:720` releases it. `shutdown` releases everything and withdraws its waiter. `job.timeoutMs` counts from dispatch (`:696`), so governor waiting never eats it. The poll reply stays `queued`, so the client's `onQueued` already keeps the wait out of the retry clock.

A 200 ms timer runs only while the broker is a low-rank waiter; it triggers `pump`. The reading is taken in the background, like `refreshMemory` (`server.ts`).

Rotation under denial needs two changes. `wantRotation` rule 3 fires after `minRunMs` whatever the reason nothing was served (`scheduler.ts:265`), and `pump` swaps once `running.size === 0` (`server.ts:802`). A denial lasting 180 s would make the broker stop one model and load another, a RAM and CPU spike, while serving nothing.

- Denied time does not count as run time: the scheduler gets `noteDenied(ms)`, which moves `runStartedAt` forward.
- A swap must hold a load grant before `swapTo` stops anything. A swap that cannot load keeps the current server.

Rejected: dropping rotation while denied: a job with a near deadline on another model must still win the next grant.

A denied load keeps the current server serving (unit 4, after the unit 2 review found that a pending swap that could not load served nothing). With nothing in flight the broker asks for the load lease; denied, it keeps its place in the load queue and dispatches the current queue. With requests in flight it does not drain for the swap unless a lockless read (`loadVerdict`, `decide` on the file with this broker as the next load waiter) says the load would be granted now, or there is no reading yet: a load denied on RAM, CPU, another load running, or a load waiter ahead keeps the server busy. The drain holds neither a lease nor a queue place, so one broker's drain blocks no other directory's load. The broker log names the reason of a load denial once per change (`attemptLease` returns it; `tryAcquire` keeps returning a lease or null).

### D9. Direct path and calibration

Direct path: gated only when the URL names this machine, by `isLoopbackUrl` next to `isLocalUrl`: the host as the URL parser normalizes it (so `2130706433`, `127.1`, `0` and `[0:0:0:0:0:0:0:1]` count) is `localhost` or `*.localhost`, `127.0.0.0/8`, `::1`, an IPv4-mapped form of those, `0.0.0.0` or `::`, or this machine's own host name or interface address, which still spends this machine's memory. Another LAN server's memory is not ours. Sites: `sendChat` (`completion.ts:522`), `chatCompletionNative` around `lmstudio.ts:220`, `local-bench.ts:156`, `rawFetch` (`mass_scouting/cli.ts:529`). A lease covers one request, not a send with its retries: `sendChat` takes it per attempt inside `fetchWithRetry429` (its `gate`), and LM Studio's reasoning retry takes its own, so no backoff holds a slot and no lease outlives the request its expiry was sized for. It is released when the caller's read of the body ends (end, error or cancel), on a failed send at once, and at the lease expiry as a backstop; the response itself is returned at the headers. Remote traffic never touches the governor.

`acquire` polls with a timer that is cleared on return, so no handle stays open (`launcher-boot.test.ts`). It checks `throwIfStopped()` (`provider/http.ts:591`) and the abort signal on every poll, so `--command_timeout` ends a wait. The time waited is added to `scope.brokerQueuedMs` (`completion.ts:1426-1429`) and to `startTime`, or the wait would use up `conn.timeout`. `chatCompletionJSON` passes no scope, so unit 3 must give it one or shift the clock another way.

It never signals, stops or reads a user-started server or its process. It reads system metrics and gates llm-ext's own requests. Such a server's threads are unknown, so its lease carries `threads: 0`; only the CPU reading and `max_inferences` bound it.

Calibration: `makeSender` takes the lease before `t0` (`phase-a.ts:273-292`), so waiting does not pollute `wall_ms`. A Phase C throughput round takes one lease of weight `n` (`phase-c.ts:226`), or a smaller `w` would be measured as a slower model; per round, not per step, because each round first calls `waitForTurn`, and a lease held across that wait would block the broker work it waits for. A weight above `min(w, max_inferences)`, as `n` above `max_inferences` or a window that calibration's own load has shrunk, is admitted only at the head of its queue with no inference running (`controller.ts`, `decide`), which is also what stops it from waiting forever; once it runs, `running` exceeds the window, so nothing else is admitted beside it and there is never more than one such lease. The broker's work keeps priority through `waitForTurn` as today.

### D10. The thread budget

llama-server gets `-t T -tb T`, with `T = max(1, floor(budget / 2))` unless `server_threads` is set (round 2 of unit 5, coordinator decision: first `ceil(budget / 2)`, which on an odd budget let only one server run inferences at a time, budget 11 and `T` 6 at 85 % of 14 cores; now `T` 5, and two servers fit every budget of 2 or more). `T` is written in the argv, so a server's CPU use is known. Measured in unit 5 (reports_dev/governor/20261031_210144+0100-thread-measure.md, 14 cores): all slots share the `T` threads; with the model on the CPU (`-ngl 0`) a server busy with 1, 2 or 4 requests used 3.96 to 4.01 cores at `-t 4` and 1.98 to 2.01 at `-t 2`, with exactly `T` threads busy, and `n_threads` in its log equals `T`. Without `-t` llama.cpp takes the 10 performance cores. With the model on Metal (the default) the `T` threads stay idle: 0.12 to 0.33 cores at any slot count, so there the budget is an upper bound far above real use. `server_threads` is `local_governor.server_threads` in `settings.yaml`, with `LLM_EXT_GOVERNOR_SERVER_THREADS` over it (unit 6, `resolveConfig`): 0 means the rule, 1 up to this process's thread budget overrides it, anything else fails: the broker and a calibration run check it once at start (a typo ends the command, never a calibration crash and its failed records) and again at each spawn. Above the budget a server could never be admitted, since `decide` has no alone escape for threads. `cpu_limit_pct: 100` with no `server_threads` gives `T = 0`: no `-t`, leases that count 0, the CPU limit disabled as D13 says. Calibration requests are leased with their cal server's `T` and pid, so a cal server counts like a broker one.

The budget counts only servers with an inference running, by `threads` on the lease of the first inference on that server. An idle server counts 0. Rejected: reserving threads at load: a loaded idle server stays up for 2 hours (`idleServerMs`) and would block other config dirs that long. Rejected: giving each new server what remains: `-t` is fixed at start, so an early server would keep a large share for its whole life.

Locals has no thread option, so it is attributed a fixed `threads: 2`, capped at the budget (at a budget of 1 it would otherwise be denied for good), 0 at `cpu_limit_pct: 100`. Before unit 5 its leases carried 0. Measured in unit 5: at most 1.34 cores busy (4 requests on SmolLM-135M, one Python thread driving the GPU; 0.23 to 0.34 on Qwen3.5-4B), rounded up, so 2 stays. Beyond that the utilisation ceiling is the backstop. Calibration servers get the same `T`. `-t` is not part of a record's identity; a record measured under another `T` (every record measured before unit 5 ran under llama.cpp's default) differs only in speed, and no new calibration is triggered (open question 4).

`--poll` stays at its default: spinning stays inside `T` threads, so the budget holds either way. Measured in unit 5: `--poll 0` changed nothing, idle about 0 cores either way, the same cores while generating, throughput within 5 %. The broker's ready line (`slotSizing`) prints the `-t` passed beside llama.cpp's own `n_threads = N` from the server log (its only thread line).

### D11. Model load

Choice: a server may start only with a `load` lease, at both spawn sites, in `claimAndSpawn`'s caller, before any stop or spawn. One load at a time per machine: a load's RAM appears in the reading only gradually, so two concurrent loads would each see the other's room.

Projection: `weights + kvBytes(layers, slots * ctx) + WINDOW_HEADROOM_BYTES`, the formula Phase C uses (`phase-c.ts:192`). It fits when `ramUsedBytes + projection - outgoingServerBytes <= totalmem * ram_limit_pct / 100`, and also the CPU check. The main server has no local path to read from before it starts, so the runner writes `load_estimate: { weight_bytes, kv_bytes_per_token }` into the calibration record; the rate is a linear upper bound, the safe side.

A model with no local weights yet (first `-hf` download) or a record with no `load_estimate` has no projection. It is admitted alone, under a load watchdog. Rejected: refusing it: a model could then never be downloaded. Rejected: asking the hub for the size: a network call in the admission path.

The load watchdog runs for every load: while loading, the owner reads RAM every second, and at `ramUsed >= ramHigh` it stops its own server (`stopOwnServer`), and the model waits, admitted only alone from then on with a lower bound raised to what the breach saw (round 4, below). So a wrong projection costs an aborted load, not a limit breach that goes on growing.

Locals: `--cache-gb` is passed, `min(4, room)`. Its default is everything the GPU has left, so on a large machine Locals' own prompt cache could fill RAM up to the limit by itself, which is what forced the "one always allowed" exception. With it bounded, the cache belongs to the projection.

Giving RAM back: when the head load waiter is denied on RAM, or RAM is `over` for 30 s, the least recently used server with no lease gets `wantUnload`, one per settle interval. Its owner stops it on the next tick (`stopServer`, own processes only). A server stopped this way waits 60 s before it may load again, so reload and unload cannot flap. Rejected: every idle server unloading at once: 100 brokers would empty the machine for one load.

As built in unit 4:

- The lease covers the load and nothing else: taken before `swapTo` stops the outgoing server, released the moment the new one is ready (`waitReady`), before the record's identity check, which hashes files and loads nothing. A cal server (`startCalServer`, so Phase A, Phase B and every Phase C `restart`) takes the same grant through `acquire`, held from before the spawn to ready.
- Projection for a main server, two bounds (round 2): the upper bound `weight_bytes + kv_bytes_per_token * tokens + WINDOW_HEADROOM_BYTES` (+ Locals' 4 GB cache bound), where `tokens` is `ctx * MAIN_SLOTS` (llama) or `ctx * LOCALS_MAIN_SLOTS` (Locals), and `n_ctx_train` in place of `ctx` when the job's context is 0; the lower bound `weight_bytes + WINDOW_HEADROOM_BYTES`. Phase C writes `load_weight_bytes` and `load_kv_bytes_per_token = kvBytes(layers, 1)` (a sliding-window layer counted as full attention) into `C/summary`; `okRecordFrom` maps them to `load_estimate`. Round 4 #8: `load_estimate` is required on an ok record (the schema refuses one without it, so it is read as missing), and `HARNESS_VERSION` is 6, so every version-5 record (14.2.0) is calibrated again once; the main server never reads figures from the weight files. `PRODUCTION_HARNESS_ID` is the literal "production", not derived from the version, so the bump leaves the harness id and its check unchanged. `governor/estimate.ts` (the hub-cache snapshot files whose blob is in a fingerprint, or the plain path; GGUF metadata or MLX `config.json`, as Phase C reads them) serves only the cal server before any record exists; only a missing file (ENOENT) is "unknown", any other read error is thrown (round 4 #10). A breach raises only the lower bound (below).
- Cal servers carry a projection too (round 2): the same bounds for the cal server's own `ctx * slots`, from the files on disk (the fingerprint of an earlier record names them for an `org/repo:quant` model, which names no file before llama.cpp picks one). On a first download nothing is on disk, so the size is unknown.
- Never fits (round 2): judged on the lower bound only, in `pump` before the lease is asked for (and in `startCalServer`); the jobs fail with `failModel` and a message naming the MiB needed, the MiB the limit allows and the machine's RAM. A cal server that never fits throws, counted as a crash of that model.
- Admitted alone (round 2): a load whose upper bound is over the limit, or unknown (0), is not a model error: it waits like any load and is granted only when no other load lease and no inference lease exist and no registered server of another owner is loaded, with its lower bound fitting the reading, under the watchdog. Denial `alone`, printed as "the model may not fit beside anything else, so it loads only when nothing else runs or is loaded". A known load of size 0 does not exist: a test or caller that takes a load lease without bytes is such an alone load.
- RAM a load must fit (round 3): `reading + booked + load - outgoing <= totalmem * ram_limit_pct / 100`, where `booked` is the sum of every registered server's `bookedBytes` (a Locals server's projection, main or cal: an idle MLX server's wired pages drop to 0, so the reading misses it; an active one is counted twice, wired and booked: conservative by design) and `outgoing` the `residentBytes` of the server the swap stops first (round 4: never more than it really holds, so subtracting it is right for both engines). llama servers are not booked. Inference leases judge RAM on the reading alone: their KV is allocated at load.
- A head load denied by its own projection yields to a load waiter behind it (D13), so one large model does not block smaller ones, but only for `LLM_EXT_GOVERNOR_LOAD_YIELD_MS` (default 2 minutes) from when it began waiting (round 2): after that it holds the head, so a stream of small loads cannot starve it.
- Watchdog breach (round 4 #1): the owner stops its own server and the model's jobs stay queued. The growth the watchdog saw is the whole machine's, so it cannot be attributed to the load: a breach teaches only a lower bound, `max(lower bound, observed growth + WINDOW_HEADROOM_BYTES)` (`learnedLowerBound`), never the upper one, and marks the model `alone` (an explicit flag on the request, `AcquireRequest`, `GrantRequest` and `loadVerdict`; never encoded as bytes 0, which means "unknown size"). The broker counts breaches per model in a row (`afterBreach`); the third fails the jobs (`failModel`) with a message naming the growth and `ram_limit_pct`, so retries are bounded without one spurious breach turning into a false never-fits. A load that reaches ready clears what breaches taught. A breach in calibration is never a crash count: `calibrateOne` saves a memory wait for the model under `LOAD_WAIT_STEP` ("load"), `need` the learned lower bound, so `memoryWaitPrecheck` loads nothing on later passes until that much is free above the floor; the next cal load carries it and runs alone, and a wait over `MEMORY_WAIT_MAX_MS` of checks ends in a memory-limited record, as a phase's memory wait does (a forced run keeps an ok record). The watchdog reads RAM once a second during a load, one more vm_stat a second machine-wide at most, since one load runs at a time. A breach seen before ready is the breach path even if the server answered ready first (round 2): the watch ends right after ready, and a breach it saw by then means the server is already being stopped. Three failed readings in a row stop the load with the reading error (round 2, fail fast): the broker fails the model's jobs with it, calibration counts a crash.
- `wantUnload`: marked inside the critical section of the head's attempt (a load denied on RAM or `alone`, or `ramOverSince` 30 s old), never on the requester's own server, never on a cal server (round 4), at most one per settle interval, and only when the books would come under the limit once every idle server gave its RAM back, least recently used first (round 2): unloading that cannot make room only costs a reload. With RAM over for 30 s and no load denied, the need is 0 bytes: an idle server is unloaded only if giving the idle ones back brings the books under the limit (round 4 #7). A flag expires after one settle interval, so an owner that never acted cannot block the next choice, and an inference granted on a flagged server withdraws its flag (round 2). Owners poll it on their 1 s tick with a lockless read and stop only an idle server. The 60 s no-reload pause is `RELOAD_AFTER_UNLOAD_MS`, `LLM_EXT_GOVERNOR_RELOAD_AFTER_UNLOAD_MS` for tests: it rate-limits unload and reload flapping, it does not exclude it. State gains `lastUnloadAt` and `ramOverSince`, both required (round 4 #9: the governor never shipped without them): an older development state file is read as corrupt and replaced by an empty state.
- `--cache-gb` (round 2, read in the installed Locals, `locals/service.py`: `cache_bytes = int(cache_gb * (1 << 30)) if cache_gb else None`): the value is GiB, so 3.7 bounds the prompt cache at 3.7 GiB, and 0 is falsy, so it means no bound at all, Locals' default of all the GPU memory left after the weights and 4 GB. llm-ext passes `min(4, room)` in tenths, never under 0.1: with less room the load waits (the broker keeps the jobs queued and retries on its tick; calibration pauses the model). The broker's main server and every cal server follow the same rule. Round 4 #3: the room is the reading plus every booked server minus what the outgoing server gives back for sure, and the rest of the load is the lower bound when the load is alone (marked, unknown or over the limit); the broker judges it before it stops the outgoing server, so a load that cannot start never leaves the broker with nothing loaded.
- Two RAM figures per server (round 4 #2, `loadFigures`, `ServerEntry.bookedBytes` and `residentBytes`): booked is what the books add for it, a Locals server's projection (its lower bound when alone), 0 for llama; resident is what stopping it gives back for sure, a Locals server's booking or a llama server's weight bytes (measured wired rise: weights + 0.2 to 0.4 GiB), 0 when unknown. A swap's outgoing share (`pump`) and an unload's freed share (`pickUnload`) use resident, so neither ever exceeds what the server really holds.
- Registration (round 4 #4, #5, #10): a cal server is registered (role `cal`, engine-aware) from its spawn to its stop, so an idle Locals cal server between steps is booked. Every stop forgets its server in a `finally` (the broker's `stopServer`, its failed-start path, and the cal server's stop), so a stop that throws leaves no phantom entry. The broker registers a main server before it releases the load grant and before `server` names it, and a registration failure is not caught: the failed-start path stops the server and fails the jobs.
- `loadVerdict` (round 4 #11) keeps this broker's own load waiter at its real place in the queue (and its `since`, which bounds its yield); only a broker with no place yet gets a synthetic waiter at the tail.
- Verified in round 4 (#12): llama-server gets `-c ctx * slots` and `-np slots` (`buildServerArgv`), the total KV split across the slots, so `tokens = ctx * MAIN_SLOTS` in `loadPlan` is the total the server allocates; with ctx 0 the server gets one slot at the model's own context. `toTail` only moves a waiter and keeps its `since`, so the yield bound (round 2 #10) holds across yields; a waiter withdrawn by `govSettle` and queued again starts a new `since`.
- Round 5: a Locals server, main or cal, is booked again at ready by `readyBooking` = max(the projection it was granted on, weights + KV for its tokens + the `--cache-gb` it was given + headroom, the growth the watchdog saw by ready), its figures read again from the weight files when there were none before the load; none at all is an error (the server is stopped), never a booking of 0. A Locals lower bound includes the smallest prompt cache (`LOCALS_CACHE_MIN_GB`), so a grant on it leaves room for that cache; a swap that still finds no cache room waits one settle interval (`swapHeld`, as the reload pause does) while the loaded server serves its queue. After the third breach in a row the jobs fail but the learned bound and the alone mark stay; only the count restarts. In calibration, no cache room is a wait under its own key (`load-cache`), never a learned bound. The swap's failed-start path stops a spawned server and then forgets it in the governor; the llm-ext registry entry is released by `stopOwnServer` only after a stop that worked or a pid proven not ours. `parseState` checks every server entry's fields. A governor that cannot answer `loadVerdict`, or malformed governor settings, is logged and fails the jobs, never a silent drain.
- The Locals memory gate (`memoryAllows`) is removed; every Locals request takes an inference lease like any other.

Downloads are not separable from loads in either engine. llama-server with `-hf` or `--hf-repo` downloads and then loads in the same process, with no download-only mode (`--offline` is the reverse); Locals downloads through `snapshot_download` at start, also in one process. So a first download holds the load lease, and every other load on the machine waits for it. In practice the broker never meets it: it loads only models with a complete calibration record, whose fingerprint required the weights on disk. The first download happens in the calibration runner's first cal server. A two-phase start (spawn without the lease, stop at the first loader log line, restart under the lease with `--offline`, or `HF_HUB_OFFLINE=1` for Locals) would separate them; it is not built.

### D12. No SIGSTOP hard brake

Choice: running inferences are never paused. The brakes are: no new grants, halving `w`, stopping idle own servers, and aborting a load.

Rejected: SIGSTOP and SIGCONT on own servers.

- It frees no RAM, so it cannot serve the limit that matters most.
- CPU is already bounded by the thread budget.
- `AbortSignal.timeout(job.timeoutMs)` and `--command_timeout` keep running during a pause, so a paused server looks hung and its job fails with "did not answer": a limit-keeping measure would turn into model errors. The fix would be to move every clock.
- A broker that dies with its server stopped leaves a frozen process holding all its memory, reachable only through the 10 s SIGKILL path.
- GPU work already submitted continues regardless.

A long generation therefore holds its lease to the end, bounded by its own timeout. Accepted.

### D13. Settings, status, disabling

`settings.yaml`, top level, registered in `Settings` (`config.ts:344`), `loadSettings` (`:1059`) and `validateSettings` (`:3494`):

    local_governor:
      enabled: true
      ram_limit_pct: 80     # integer 50-99
      cpu_limit_pct: 80     # integer 10-100
      max_inferences: 8     # integer 1-256
      server_threads: 0     # 0 = half the thread budget; else 1 up to the thread budget

A value out of range or an unknown key under `local_governor` fails validation.

Env overrides, each validated like `timingsFromEnv` and failing fast: `LLM_EXT_GOVERNOR_ENABLED`, `LLM_EXT_GOVERNOR_RAM_LIMIT_PCT`, `LLM_EXT_GOVERNOR_CPU_LIMIT_PCT`, `LLM_EXT_GOVERNOR_MAX_INFERENCES`, `LLM_EXT_GOVERNOR_SERVER_THREADS`. For tests, `LLM_EXT_GOVERNOR_DIR`, `LLM_EXT_GOVERNOR_SETTLE_MS`, `LLM_EXT_GOVERNOR_CPU_FLOOR_WAIT_MS`, `LLM_EXT_GOVERNOR_LOAD_YIELD_MS`, and `LLM_EXT_GOVERNOR_TEST_RAM_LIMIT_MIN` (an integer 1 to 50, default 50: the minimum of `ram_limit_pct` in the resolver and in the settings check, so the ram-limit and stop burn tests can put a limit a few points under the ambient reading of any machine). These are test-only, env alone, never settings and never documented as settings. The removed `LLM_EXT_BROKER_MEMORY_FLOOR`, when set, is a `GovernorConfigError` naming `ram_limit_pct` (fail fast, never silently ignored).

Different config dirs can hold different limits, yet the limits are machine-wide. Choice: every waiter carries its own limits, and a limit binds only its own request. The head is judged by its own limits. A head denied by RAM, CPU, `max_inferences` or the thread budget while another waiter of its kind is not bound by that limit moves to the tail and leaves `w` alone. Why: under "the strictest among live waiters applies", one waiter with `ram_limit_pct` 50 at 60 percent used denied every head, nothing ran, and RAM could not fall, so one process deadlocked all of them. Rejected: one fixed settings file: it would ignore the config dir a user pointed llm-ext at, and tests would need a second override. A long-lived broker re-reads `settings.yaml` when its mtime changes, on the 1 s tick.

Disabling: `enabled: false` or `cpu_limit_pct: 100` for CPU alone. A disabled process takes no leases and does not count toward the limits; that is the user's own choice, and the docs say it opts that config dir out. At `cpu_limit_pct: 100` the servers it starts get no `-t` and lease `threads: 0`, unless `server_threads` is set (D10).

Status: `llm-ext models server-status` (`broker/server-commands.ts:37`) adds, from a lockless read: the governor state (on or off), `w` of `max_inferences`, leases running, waiters, RAM and CPU against their limits with the age of the reading, the thread budget in use, and the reason for the last denial. `calibration-status` names a governor wait the same way as a memory wait.

### D14. The limit on what is promised

Stated in the docs, not hidden: the limits bound what llm-ext starts; they do not stop other programs. A running inference runs to its end. A user-started server's threads, its own loaded model and its GPU use are outside the budget. A process with `enabled: false` is invisible. An LLM server started on another port by hand is not governed unless llm-ext sends to it.

Just-in-time loads on the direct path are a gap. LM Studio and Ollama load a model on the first request that names it, so a direct send under an inference lease can add several GB with no load grant. It is measurable: LM Studio's `/api/v0/models` gives each model's `state` (`loaded` or `not-loaded`), and Ollama's `/api/ps` lists the loaded ones. Not built in unit 4: the lease sites (`directAttemptGate` from `sendChat` in `provider/completion.ts`, `takeDirectLease` in `provider/lmstudio.ts`) do not pass the model id or the server flavor to `governor/direct.ts`, and those files belong to unit 3. Even built, a grant could only serialize such loads: the governor never stops a user-started server (D9, D12), so it could not abort one whose RAM was wrong.

Open after unit 4 (rounds 2 and 3), stated so nobody takes them as covered:

- Just-in-time loads by LM Studio and Ollama, above: no load grant, no projection.
- A first download holds the load lease (D11, downloads are not separable from loads), so every other load on the machine waits for it; the lease's leak backstop is `LOAD_LEASE_MS`, 1 hour, after which a download still running loses its grant and a second load may start beside it. Its size is unknown until it ends, so it loads alone.
- `ramOverSince` is kept per state by the limit of whichever waiter last read it: under mixed `ram_limit_pct` values across config dirs (D13) it restarts whenever a laxer waiter sees RAM under its own limit, so the 30 s unload rule may not fire for the stricter one.
- Linux cgroup memory limits (a container, a systemd slice) are not read: `/proc/meminfo` describes the host, so inside a cgroup smaller than the host the limit is judged against the wrong total. Linux and Windows readings are unverified (D4).
- Cal servers are booked like main ones since round 4 (role `cal`), but never asked to unload: the runner does not poll `wantUnload`, it stops its own server when the model is done.
- An alone load waits until no inference runs: on a machine kept busy by inferences it may wait long; nothing gives it priority over inference grants.
- Calibration keeps `100 - ram_limit_pct` free for its own budgets since unit 6 (`governor/settings.ts` `freeFloorPct`), the broker floor variable removed. A shell whose env sets another `ram_limit_pct` than the broker judges a too-big record under its own limit until a broker-started runner measures the model again.
- Growth after ready is unwatched (round 4): the watchdog ends at ready, so a server whose KV or prompt cache grows while it serves is judged only by later grants. A Locals server started with context 0 gets no `--max-context`, so its KV is bounded only by the model's own context.
- An older llm-ext broker still running during an upgrade (a version without the governor) takes no leases and books nothing: until it exits, its loads and inferences are ungoverned.
- Direct leases (D9) carry no `serverPid`: the inference on a user-started server is counted, but no server entry exists for it, so it is never chosen to unload and never booked.
- Direct leases to a user-started server carry `threads: 0` (unit 5): llama-server's `/props` and `/slots` report no thread count, so its threads cannot be read; the utilisation ceiling and `max_inferences` are the backstop. Calibration requests are counted since round 2 of unit 5: they lease with their cal server's `T` and pid (D10).
- The thread budget binds CPU use only with layers on the CPU. With full Metal offload the `T` threads were idle in unit 5 (0.12 to 0.33 cores), so there the budget limits concurrency between servers more than CPU use.
- A unit-4 broker (a governor without `-t`) still running during an upgrade leases `threads: 0`, and its llama-server runs llama.cpp's default thread count (10 on the development machine) uncounted until it exits.
- `server_threads` is checked against the thread budget once at the start of a broker or a calibration run and at each spawn. From the env it cannot change inside a running process; since unit 6 `settings.yaml` is read again when it changes, and a value made invalid while a calibration runs (a lowered `cpu_limit_pct`) throws a `GovernorConfigError`, which `runner.ts` rethrows to end the run like the check at its start, never on the crash path that writes failed records after `MAX_CRASHES`.
- Machine-wide means per uid: the state directory is `/tmp/llm-ext-governor-<uid>`, so two users on one machine each see only their own leases and servers.
- A `settings.yaml` edit is seen when the file's mtime, size or inode changes (`governor/settings.ts`). On a filesystem with coarse mtimes (HFS+, FAT, some network mounts: 1 to 2 s), a rewrite of the same size within one mtime tick keeps the stamp and is seen only at the next edit. APFS and ext4 stamp finer than that.
- Discrete-GPU VRAM is not in the reading: on a machine with a discrete GPU (Linux, Windows) a model offloaded to VRAM is invisible to the RAM limit, and VRAM has no limit of its own.
- The default `ram_limit_pct` 90 against a machine that idles at 78 to 85 % under the round 3 reading (anonymous + wired + compressed, measured on the 64 GiB development machine) leaves 5 to 12 % for every load; unit 6 keeps the default 90 (coordinator decision): it is the user safety ceiling, a lower default would block most loads on that machine, and 90 still leaves about 6 GiB on 64 GiB; the docs say how to read the figure (`server-status`) and how to raise the limit.
## 3. Tests

Real processes, no mocks. Pure controller tests use tiny values with a clock parameter, like `broker/scheduler.ts`'s.

`src/test-hermetic-config.ts` must set `LLM_EXT_GOVERNOR_DIR` beside the config dir (line 37), or every vitest worker would join the user's live governor and each other's. The directory name must not match the leak marker `/llm[-_]?ext/i`.

| test | setup | asserts |
|---|---|---|
| burn-direct | one real loopback HTTP server process that records its concurrency to a file and holds each request 1 s; N real `llm-ext` CLI processes, each with its own config dir, all sharing one governor dir; 2 x cores CPU burner processes; `cpu_limit_pct` 50; after the burners are killed by pid, the governor's own CPU reading (`snapshot().cpuPct`) and the waiter count sampled every 200 ms with timestamps until every CLI ends | always: server-observed concurrency is 1 while the sampler shows over-limit, never above `max_inferences` after the kill, every CLI exits 0. Release branch, only when the reading stayed under `cpu_limit_pct` - 10 with 2 or more CLIs waiting for one settle interval plus one head poll delay: concurrency rises above 1 after that moment. D6 branch, only when every reading stayed over `cpu_limit_pct` + 10: concurrency stays 1. Otherwise inconclusive: only the always checks. The branch is printed every run; machine load decides which branch runs, never whether the test passes |
| burn-broker | the two tiny GGUF models and harness of `broker.test.ts`; 8 config dirs, so 8 brokers | the snapshot counter (200 ms, as at `broker.test.ts:337`) sees every server's `-t`; the sum over servers with a request running stays within budget; at most one load at a time |
| ram-limit | `ram_limit_pct` set a few points below the current reading (through the test-only `LLM_EXT_GOVERNOR_TEST_RAM_LIMIT_MIN`, so any machine qualifies), then raised in `settings.yaml` | no spawn, no inference while below; the waiter prints its RAM line, `server-status` shows it with its own limits, it exits 0 after the raise; the projection path refuses a too-big model at once |
| crash | SIGKILL a CLI holding a lease; a state entry naming a live pid with a wrong start time | lease reclaimed within 2 s; next waiter proceeds |
| no-touch | a stand-in server started by the test on a loopback port, not by llm-ext | its pid is unchanged and receives no signal; its children unchanged |
| fairness | 20 requesters with long queues | grants per requester differ by at most 1 after each round |
| stop | `--command_timeout 3` during a RAM wait (limit set as in ram-limit) | exit 124 after a RAM wait line, no waiter left in state |
| disabled (D2, D13) | the governor dir a regular file with `enabled: false`; a server registered while enabled; a CLI queued below a live head when its `settings.yaml` flips to `enabled: false`; a running broker whose `settings.yaml` turns malformed, then valid | a CLI send, a load acquire, `bookedBytesNow` and `unloadWanted` work and the file is untouched, while enabled the same dir is a `GovernorDirError`; the server entry is removed on unregister after the flip; the disabled CLI sends before the head is granted and leaves the queue; `server-status` prints the off line; the broker fails its jobs with the `GovernorConfigError` text, then runs them |

Never start a Locals server without the `-X` marker, never touch port 8321.

Hygiene: `ps -eo pid,ppid,etime,command` to a file under `reports_dev/` before and after; every spawned pid recorded, killed by pid in `finally`; the after-snapshot must show none of them. All pids are test-owned: no pattern kill.

Stability under load (TRDD-CBOTP0DY). That card's failures came from fixed waits and short margins at load averages of 66 to 146. So:

- assertions are invariants read from recorded data (a maximum, a sum), not timings;
- every wait polls a condition against a generous deadline, 180 s per test;
- no assertion depends on another test's load;
- the burn tests load the machine on purpose, so they run alone in a third sequential step of `npm test`, after the parallel run, like `broker.test.ts`.

N is 16 in the default gate and 100 in `test:live`.

## 4. Implementation units

Order matters: each leaves the tree working. Run in `scripts/llm-ext`. Check for every unit: `npx tsc --noEmit`, `npx eslint . --quiet`, then the named vitest file.

**Unit 1. Governor core.** New `src/governor/metrics.ts` (readings), `state.ts` (dir, ownership check, lock, reap), `controller.ts` (pure), `client.ts` (`tryAcquire`, `acquire`, `release`, `withdraw`, `snapshot`). `src/test-hermetic-config.ts`. Nothing calls it yet, limits come from env and defaults. Check: `src/governor/governor.test.ts`. Accept: controller tables; crash and pid-reuse reclaim; 20 real child processes through `acquire` never exceed `max_inferences` and take turns; `memoryFreePercent` agrees with the used figure; the Linux reading is checked or stated unverified.

**Unit 2. Broker dispatch.** `src/broker/server.ts` (`pump`, `dispatch`, `shutdown`, status in `/v1/health`), `src/broker/scheduler.ts` (`noteDenied`). The Locals memory gate is removed in unit 4, not here. Check: `src/broker/broker.test.ts` and the new `src/broker/broker-governor.test.ts`. Accept: 8 dirs, real tiny GGUF, machine-wide running count within `w`; a denial of 3 x `minRunMs` causes no swap; a near-deadline model wins the next grant; `shutdown` leaves no lease.

**Unit 3. Direct path and calibration senders.** `src/config.ts` (`isLoopbackUrl`), `src/provider/completion.ts`, `src/provider/lmstudio.ts`, `src/benchmark/local-bench.ts`, `src/mass_scouting/cli.ts`, `src/calibration/phase-a.ts`, `src/calibration/phase-c.ts`. Check: `src/governor/governor-direct.test.ts`, `src/provider/retry-clock.test.ts`, `src/calibration/calibration.test.ts`. Accept: a waited request does not use up `conn.timeout`, in `chatCompletionSimple` and `chatCompletionJSON`; a LAN URL and a remote URL never touch the governor dir; `--command_timeout` ends a wait with exit 124; no handle remains (`launcher-boot.test.ts`); no-touch test.

**Unit 4. Model load and RAM.** `src/broker/server.ts` (`swapTo`, watchdog, `wantUnload`, removal of `memoryAllows`), `src/calibration/runner.ts` (`startCalServer`), `src/calibration/record.ts` and `phase-c.ts` (`load_estimate`), `src/local-locals-server.ts` (`--cache-gb`), `src/governor/*`. Check: `src/governor/governor-load.test.ts`, `src/broker/broker.test.ts`. Accept: ram-limit test; two dirs never load at once; a too-big model fails at once as a model error; a load with a wrong projection is stopped by the watchdog; `wantUnload` picks only the least recently used idle server and cannot flap.

**Unit 5. Thread budget.** `src/local-llama-server.ts` (`ManagedTarget.threads`, argv), `src/broker/server.ts`, `src/calibration/runner.ts`, `src/governor/controller.ts`. Check: `src/governor/governor-threads.test.ts`, `src/broker/server-commands.test.ts`. Accept: burn-broker; `n_threads` in the server log equals `T`; a report records real CPU use per slot count, what default `-t` was, the effect of `--poll 0`, and Locals' real thread use, and `threads: 2` is corrected from it.

**Unit 6. Settings, status, docs, full gate.** `src/config.ts`, `src/broker/scheduler.ts` and every reader of `memoryFloorPct` (remove the floor; sweep code, tests, docs and specs for `LLM_EXT_BROKER_MEMORY_FLOOR`), `src/broker/server-commands.ts`, `src/cli/main.ts` help, `package.json` third test step, README and docs. Check: `src/governor/governor-burn.test.ts`, `src/config.test.ts`, `src/doc-consistency.test.ts`, then the full `npm test`. Accept: the whole test table above; every waiter carries its own limits and a limit binds only its own request (D13); `enabled: false` restores direct sends; `server-status` shows the figures; a change to `settings.yaml` reaches a running broker within 2 s.

## 5. Open questions for the USER

1. Default limits. RAM 90 equals today's floor. CPU 85 was chosen because a busy 14-core development machine measured 81.7 percent; a lower default would make llm-ext run one inference at a time for as long as test suites run.
2. RAM waits are bounded only by `--command_timeout`, a narrowing of "bounded by --queue_timeout". The alternative is a forced load past the limit, which risks swap exhaustion.
3. The CPU floor of D6 lets one inference run while the machine is over the limit from other programs. Under the budget that inference is llm-ext's bounded share, but the reading stays above the limit.
4. Whether `T` belongs in a calibration record's identity.
