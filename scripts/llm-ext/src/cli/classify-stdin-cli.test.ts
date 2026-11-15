// TRDD-XM2OSVC0: NEEDS BUILD (`npm run build`). Spawns the compiled CLI (dist/llm-ext.js) and pipes stdin into `classify filter --estimate`, the only path through main.ts readAllStdin and process.stdin that no other spawned-CLI test takes (they pass --input or file positionals).
// Hermeticity: HOME and LLM_EXT_CONFIG_DIR are a fresh temp dir per run (removed in finally), LLM_EXT_INSTALL_RULE=0. The decisions catalog cache is seeded from the recorded P-02 fixture so selection needs no catalog fetch. COUPLING: the cache is WRITTEN by the src loadDecisionsCatalog (this test's own import) and READ by the built dist; if the two disagree on the cache format or path, the child refetches and the fetched-equality assertion below fails.
// Fetch observation: a --import preload replaces globalThis.fetch with a recorder that logs every call to fetch-calls.log and throws for anything but the recorded endpoints GET. The CLI may swallow that throw (the first run without the replay exited 0), so the throw is NOT the guard: the assertion on the logged calls is. ONLY globalThis.fetch is observed; requests made through node:http, node:https or an undici dispatcher are not seen.
// TTY refusal: the terminal-stdin case ("stdin is a terminal", exit 1) runs the built CLI on a pseudo-terminal made by script(1) (ptyCommand: BSD syntax on darwin, util-linux syntax on linux). It is skipped where script(1) is absent (Windows has none). Verified on macOS only; the util-linux branch was not run (no Linux host or container available when written).
import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { loadDecisionsCatalog } from "../classifiers/l0/catalog.js";
import { replayFixture, type RecordedReply } from "../classifiers/l0/test-fetch.js";
import { CLI_SCRIPT } from "../test-helpers.js";

const execFileAsync = promisify(execFile);
// No api_key variable is set anywhere: --estimate must not need one (run-decision.ts skips key resolution for a dry run).
const SETTINGS = ["active_classifier: cl", "profiles:", "  cl:", "    profile-type: classifier", "    api: openrouter-remote", "    api_key: $XM2_NO_SUCH_KEY", "    model: typesafe/jev-1.13", ""].join("\n");
const FETCH_RECORDER = `import { appendFileSync, readFileSync } from "node:fs";\nglobalThis.fetch = (input) => { const url = String(input instanceof Request ? input.url : input); appendFileSync(process.env.XM2_FETCH_LOG, url + "\\n"); if (/\\/api\\/v1\\/models\\/.+\\/endpoints$/.test(url)) return Promise.resolve(new Response(readFileSync(process.env.XM2_ENDPOINTS_BODY, "utf8"), { status: 200, headers: { "content-type": "application/json" } })); throw new Error("xm2osvc0: network is forbidden in this test"); };\n`;

interface Run { stdout: string; stderr: string; exitCode: number | null; signal: string | null; fetched: string }
/** What a failed exit assertion prints: the exit code, or the signal / timeout that ended the child, plus the child's stderr. */
const how = (r: Run): string => `exit=${r.exitCode} signal=${r.signal} stderr(last 600 chars)=${r.stderr.slice(-600)}`;

/** Child argv of the command under test; shared by the piped and the pseudo-terminal runs. */
const CLASSIFY_ARGV = ["classify", "filter", "--estimate"];
const shellQuote = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`;
/** WHY two syntaxes: BSD/macOS script takes `script -q <file> <command> [args]`, util-linux takes `script -qec "<command line>" <file>`; on both the typescript file is /dev/null and the child gets a pseudo-terminal as stdin, stdout and stderr.
 *  WHY the sh wrapper: macOS script(1) calls tcgetattr on its OWN stdin and refuses a socket ("Operation not supported on socket" - observed on macOS only, not known for util-linux), and a socket is what execFile gives a child; a /dev/null stdin is accepted, and the child still sees a terminal because script allocates the pty for it. */
function ptyCommand(): { cmd: string; args: string[] } {
  const childArgv = ["node", CLI_SCRIPT, ...CLASSIFY_ARGV];
  const scriptArgv = process.platform === "darwin" ? ["script", "-q", "/dev/null", ...childArgv] : ["script", "-qec", childArgv.map(shellQuote).join(" "), "/dev/null"];
  return { cmd: "sh", args: ["-c", 'exec "$@" </dev/null', "sh", ...scriptArgv] };
}
/** WHY util-linux is required on linux: the linux branch uses `script -qec`, and BusyBox script has no -e (and a different -c), so the test would fail for the wrong reason; `script --version` names util-linux. WHY stdout and stderr are searched together: some util-linux builds print --version to stderr. macOS script is the BSD one and is used as is. Windows has none and other systems are unverified: skipped. */
function isUtilLinuxScript(): boolean {
  const v = spawnSync("script", ["--version"], { encoding: "utf8" });
  return /util-linux/.test((v.stdout ?? "") + (v.stderr ?? ""));
}
const CAN_RUN_IN_PTY = process.platform === "darwin" ? spawnSync("sh", ["-c", "command -v script"]).status === 0 : process.platform === "linux" && isUtilLinuxScript();

/** stdin: the text piped to the child, or null to run the child on a pseudo-terminal (its stdout and stderr are then one stream, returned in stdout). */
async function runWithStdin(stdin: string | null): Promise<Run> {
  const dir = mkdtempSync("/tmp/__llm_ext_xm2_");
  try {
    const fetchLog = join(dir, "fetch-calls.log");
    writeFileSync(join(dir, "settings.yaml"), SETTINGS);
    writeFileSync(join(dir, "preload.mjs"), FETCH_RECORDER);
    // WHY the recorded endpoints reply: profile selection checks the model endpoints (a read-only GET, no key); the replay keeps it off the network.
    writeFileSync(join(dir, "endpoints.json"), (JSON.parse(readFileSync(new URL("../classifiers/__fixtures__/p02/target-endpoints.json", import.meta.url), "utf8")) as { body: string }).body);
    const rec = JSON.parse(readFileSync(new URL("../classifiers/__fixtures__/p02/models-decisions.json", import.meta.url), "utf8")) as RecordedReply;
    await loadDecisionsCatalog({ fetch: async () => replayFixture(rec), path: join(dir, "decisions-catalog-cache.json") });
    // WHY a file URL: a bare Windows path (C:\...) is read by --import as a URL scheme and refused.
    const env: Record<string, string | undefined> = { ...process.env, HOME: dir, LLM_EXT_CONFIG_DIR: dir, LLM_EXT_INSTALL_RULE: "0", NODE_OPTIONS: `--import=${pathToFileURL(join(dir, "preload.mjs")).href}`, XM2_FETCH_LOG: fetchLog, XM2_ENDPOINTS_BODY: join(dir, "endpoints.json") };
    // WHY: no provider key of the parent may reach the child; --estimate must succeed without one.
    for (const name of Object.keys(env)) if (/API_KEY|PLUGIN_OPTION|XM2_NO_SUCH_KEY/i.test(name)) delete env[name];
    // WHY: util-linux `script -c` runs its command line through $SHELL; a login shell of the parent (zsh, fish, ...) could change the quoting. Linux only, pty run only; macOS script execs the command directly.
    if (stdin === null && process.platform === "linux") env.SHELL = "/bin/sh";
    const { cmd, args } = stdin === null ? ptyCommand() : { cmd: "node", args: [CLI_SCRIPT, ...CLASSIFY_ARGV] };
    const pending = execFileAsync(cmd, args, { cwd: dir, env, timeout: 30_000 });
    // WHY end() right after spawn: the child reads stdin to EOF (readAllFrom); a pipe that is never closed would hang until the timeout. On the pseudo-terminal run it is script's own stdin that is closed: the child's stdin is the terminal and is never written to.
    // WHY the EPIPE handler: a child that stops reading early (a broken reader) closes the pipe while the large body is still being written; the unhandled EPIPE would then surface as a vitest error beside the real failure. Only EPIPE is ignored; the exit-code assertion reports the broken reader.
    pending.child.stdin?.on("error", (e: NodeJS.ErrnoException) => { if (e.code !== "EPIPE") throw e; });
    pending.child.stdin?.end(stdin ?? undefined);
    const fetched = (): string => (existsSync(fetchLog) ? readFileSync(fetchLog, "utf8") : "");
    try {
      const o = await pending;
      return { stdout: o.stdout, stderr: o.stderr, exitCode: 0, signal: null, fetched: fetched() };
    } catch (e) {
      // WHY signal: a timeout kill (SIGTERM) or a crash has code null; without it the assertion would only say "expected null to be 0".
      const x = e as { stdout?: string; stderr?: string; code?: number | null; signal?: string | null };
      return { stdout: x.stdout ?? "", stderr: x.stderr ?? "", exitCode: x.code ?? null, signal: x.signal ?? null, fetched: fetched() };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const tokensOf = (r: Run): number => Number(/estimated input tokens: (\d+)/.exec(r.stdout)?.[1] ?? Number.NaN);

describe("classify filter --estimate with stdin piped (built CLI)", () => {
  it("truncated JSON on stdin: exit 1 and 'cannot read the JSON input from stdin', nothing on stdout", async () => {
    const r = await runWithStdin("{");
    expect(r.exitCode, how(r)).toBe(1);
    expect(r.stderr).toContain("cannot read the JSON input from stdin");
    expect(r.stdout).toBe("");
    expect(r.fetched).toBe("");
  });
  it("valid filter JSON on stdin: exit 0 and the estimate text, no fetch call except the endpoints GET, no key", async () => {
    const r = await runWithStdin(JSON.stringify({ question: "Does it fail?", items: [{ text: "boom" }] }));
    expect(r.exitCode, how(r)).toBe(0);
    expect(r.stdout).toContain("classify filter --estimate: nothing was sent");
    expect(r.stdout).toContain("model: typesafe/jev-1.13");
    expect(r.stdout).toMatch(/requests: [1-9]/);
    expect(r.stdout).toMatch(/estimated input tokens: [1-9]/);
    // The one allowed request is the read-only endpoints GET of profile selection, answered by the recorded reply; no decisions POST, no key lookup. Equality (not "contains") also pins profile selection to exactly ONE request: a second endpoints or catalog fetch fails here.
    expect(r.fetched.trim().split("\n")).toEqual(["https://openrouter.ai/api/v1/models/typesafe/jev-1.13/endpoints"]);
  });
  // WHY over 128 KiB with a 3-byte "aé" pattern: a pipe delivers 64 KiB chunks, so a reader that keeps only the first chunk sees a truncated document (invalid JSON, exit 1), and a chunk edge that falls inside a multibyte character would corrupt the text if chunks were decoded one by one instead of concatenated as bytes.
  it("valid filter JSON over 128 KiB with multibyte text on stdin: exit 0 and an estimate of the whole document", async () => {
    const text = "aé".repeat(50_000);
    const body = JSON.stringify({ question: "Does it fail?", items: [{ text }] });
    expect(Buffer.byteLength(body)).toBeGreaterThan(128 * 1024);
    const r = await runWithStdin(body);
    expect(r.exitCode, how(r)).toBe(0);
    expect(r.stdout).toContain("classify filter --estimate: nothing was sent");
    // Measured on the shipped bundle: 68219 tokens for this input (150000 chars; the small case gives 138); the bound is about half the measured number, far above what the first 64 KiB chunk alone could give.
    expect(tokensOf(r)).toBeGreaterThan(30_000);
    expect(r.fetched.trim().split("\n")).toEqual(["https://openrouter.ai/api/v1/models/typesafe/jev-1.13/endpoints"]);
  });

  // Measured 2026-11-14 on the built CLI: "" then EOF gives exit 1, empty stdout, no fetch and the same "cannot read the JSON input from stdin" refusal as a truncated document (the engine's own "Unexpected end of JSON input" tail is not pinned). Empty input is therefore refused, not treated as an empty request.
  it("empty stdin (immediate EOF): exit 1 and 'cannot read the JSON input from stdin', nothing on stdout, no fetch", async () => {
    const r = await runWithStdin("");
    expect(r.exitCode, how(r)).toBe(1);
    expect(r.stderr).toContain("cannot read the JSON input from stdin");
    expect(r.stdout).toBe("");
    expect(r.fetched).toBe("");
  });
  // WHY stdout is searched for the message: on a pseudo-terminal the child's stderr and stdout are one stream, which script(1) hands back on its stdout. WHY no stdout-empty assertion: the terminal echoes script's own EOF (^D) there.
  it.skipIf(!CAN_RUN_IN_PTY)("stdin is a terminal (pseudo-terminal via script(1); skipped without script(1) or on Windows): exit 1 and 'stdin is a terminal', no fetch", async () => {
    const r = await runWithStdin(null);
    expect(r.exitCode, how(r)).toBe(1);
    expect(r.stdout, how(r)).toContain("stdin is a terminal");
    // WHY: the CLI-owned clause of the refusal; it does not depend on the JS engine. exit 1 alone does not discriminate: a broken TTY check falls through to the empty-input refusal (also exit 1), and a script(1) start failure is exit 1 too; the message assertions are the guard.
    expect(r.stdout, how(r)).toContain("no --input given and stdin is a terminal");
    // SECONDARY check, tied to V8's JSON error wording ("Unexpected end of JSON input"): it only catches the fall-through if that wording holds, so it is not the guard. WHY not the bare prefix "cannot read the JSON input": the real TTY refusal is worded "cannot read the JSON input from stdin: no --input given and stdin is a terminal ...".
    expect(r.stdout, how(r)).not.toContain("from stdin: Unexpected");
    expect(r.fetched).toBe("");
  });
});
