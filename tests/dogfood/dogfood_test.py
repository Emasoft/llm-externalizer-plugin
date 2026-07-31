#!/usr/bin/env python3
"""Permanent dogfood harness for the llm-externalizer plugin.

Exercises every public surface of the plugin against the REAL CLIs and the
REAL on-disk skill/command files. Nothing here is mocked: each phase actually
invokes a binary (`node bin/llm-ext ...` or `node bin/llm-ext-benchmark ...`)
or reads a real file, then parses the real output.

COST-SAFETY CONTRACT (read before touching this file)
-----------------------------------------------------
The default run costs **$0** on OpenRouter. Every phase that runs by default is
one of:
  * a local build / structural file audit (no network at all),
  * `discover`              -> profile + auth + balance probe, makes NO LLM call,
  * `<verb> --help`         -> prints the parameter schema, no network call,
  * benchmark `--dry-run`   -> prints the roster only, makes NO LLM call,
  * a public model-catalog read (`or_model_info_json`, `discover_new_models`)
    -> fetches the OpenRouter *catalog* (no API key, no token spend).

The ONLY phase that issues a billable request is the opt-in free-pool smoke,
which is SKIPPED unless `DOGFOOD_LIVE=1` is set; even then it asserts the
answering model id ends in `:free` (so the spend is still $0). This harness
NEVER sets DOGFOOD_LIVE itself.

Usage
-----
    uv run tests/dogfood/dogfood_test.py                  # default, $0
    DOGFOOD_LIVE=1 uv run tests/dogfood/dogfood_test.py   # + free-pool smoke

Exit code is non-zero if any check FAILs (WARN/SKIP do not fail the run).
A full markdown report is written under
    <main-repo-root>/reports/dogfood/<YYYYMMDD_HHMMSS±HHMM>-dogfood.md
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

# --------------------------------------------------------------------------- #
# Paths
# --------------------------------------------------------------------------- #

# This file lives at <project-root>/tests/dogfood/dogfood_test.py, so the plugin
# project root is two levels up. That directory holds bin/, skills/, commands/.
PROJECT_ROOT = Path(__file__).resolve().parents[2]
BIN_DIR = PROJECT_ROOT / "bin"
LLM_EXT = BIN_DIR / "llm-ext"
LLM_EXT_BENCH = BIN_DIR / "llm-ext-benchmark"
MCP_SERVER_DIR = PROJECT_ROOT / "mcp-server"
# `bin/llm-ext` spawns dist/index.js; `bin/llm-ext-benchmark` spawns
# dist/benchmark.js (verified by reading both wrapper scripts). These are the
# two compiled artifacts the build gate must produce.
MCP_SERVER_ENTRY = MCP_SERVER_DIR / "dist" / "index.js"
BENCH_BUNDLE = MCP_SERVER_DIR / "dist" / "benchmark.js"
SKILLS_DIR = PROJECT_ROOT / "skills"
COMMANDS_DIR = PROJECT_ROOT / "commands"
FIXTURE = Path(__file__).resolve().parent / "sample-fixture.txt"

# A model id that exists in the public OpenRouter catalog and is stable enough
# to look up. The lookup is a catalog read (no LLM call, no key, $0).
KNOWN_MODEL_ID = "openai/gpt-4o-mini"

# Generous per-call ceiling: catalog fetches + the MCP server spawn can be slow
# on a cold start, but no default-mode call issues an LLM request.
RUN_TIMEOUT = 210  # seconds
BUILD_TIMEOUT = 420  # seconds


def main_repo_root() -> Path:
    """Resolve the main repo root (worktree-safe).

    `git worktree list` always lists the primary working tree first, even when
    called from a linked worktree, so reports land in one place regardless of
    where the harness runs. Falls back to PROJECT_ROOT if git is unavailable.
    """
    try:
        out = subprocess.run(
            ["git", "worktree", "list"],
            cwd=str(PROJECT_ROOT),
            capture_output=True,
            text=True,
            timeout=15,
        )
        if out.returncode == 0 and out.stdout.strip():
            first = out.stdout.splitlines()[0].split()[0]
            return Path(first)
    except (OSError, subprocess.SubprocessError):
        pass
    return PROJECT_ROOT


# --------------------------------------------------------------------------- #
# Result model
# --------------------------------------------------------------------------- #

PASS = "PASS"
FAIL = "FAIL"
WARN = "WARN"
SKIP = "SKIP"


@dataclass
class Check:
    """One row of the result table / one finding in the report."""

    surface: str  # e.g. "build", "cli", "benchmark", "command", "skill"
    name: str  # the specific verb / file / phase
    status: str  # PASS | FAIL | WARN | SKIP
    description: str  # one-line human description of what was checked
    detail: str = ""  # longer evidence (symptom, stderr, file:line) for the report


@dataclass
class Harness:
    checks: list[Check] = field(default_factory=list)

    def add(
        self, surface: str, name: str, status: str, description: str, detail: str = ""
    ) -> Check:
        c = Check(surface, name, status, description, detail)
        self.checks.append(c)
        return c

    @property
    def failed(self) -> bool:
        return any(c.status == FAIL for c in self.checks)


# --------------------------------------------------------------------------- #
# Subprocess helper
# --------------------------------------------------------------------------- #


@dataclass
class RunResult:
    code: int
    out: str
    err: str
    timed_out: bool = False

    @property
    def combined(self) -> str:
        return f"{self.out}\n{self.err}"


def run(args: list[str], cwd: Path | None = None, timeout: int = RUN_TIMEOUT) -> RunResult:
    """Run a command, capturing stdout/stderr. Never raises on non-zero exit.

    Robustness note (load-bearing): `bin/llm-ext` and `bin/llm-ext-benchmark`
    each spawn a GRANDCHILD node process (the MCP server / benchmark CLI). A
    plain `subprocess.run(timeout=...)` only signals the DIRECT child on
    timeout, so a surviving grandchild can keep the inherited stdout pipe open
    and make `communicate()` block far past the intended deadline (observed: a
    child alive 14+ minutes under a 210s timeout). We therefore start each
    command in its own session (`start_new_session=True`, making it a process-
    group leader) and, on timeout, kill the ENTIRE group with `os.killpg` so
    every grandchild dies and the pipes close. This guarantees the per-call
    deadline is actually honored.
    """
    try:
        proc = subprocess.Popen(
            args,
            cwd=str(cwd) if cwd else None,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True,
        )
    except OSError as e:
        return RunResult(127, "", str(e))

    try:
        out, err = proc.communicate(timeout=timeout)
        return RunResult(proc.returncode if proc.returncode is not None else 0, out or "", err or "")
    except subprocess.TimeoutExpired:
        _kill_group(proc)
        # Drain whatever is buffered now that the whole group is dead.
        try:
            out, err = proc.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            out, err = "", ""
        return RunResult(124, out or "", err or "", timed_out=True)


def _kill_group(proc: "subprocess.Popen[str]") -> None:
    """SIGTERM then SIGKILL the child's whole process group (POSIX)."""
    import signal
    import time

    try:
        pgid = os.getpgid(proc.pid)
    except (ProcessLookupError, OSError):
        return
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(pgid, sig)
        except (ProcessLookupError, OSError):
            return
        if proc.poll() is not None:
            return
        time.sleep(1.5)


def llm_ext(extra: list[str], timeout: int = RUN_TIMEOUT) -> RunResult:
    """Invoke `node bin/llm-ext <extra...>` from the project root."""
    return run(["node", str(LLM_EXT), *extra], cwd=PROJECT_ROOT, timeout=timeout)


def llm_ext_bench(extra: list[str], timeout: int = RUN_TIMEOUT) -> RunResult:
    """Invoke `node bin/llm-ext-benchmark <extra...>` from the project root."""
    return run(["node", str(LLM_EXT_BENCH), *extra], cwd=PROJECT_ROOT, timeout=timeout)


def _evidence(res: RunResult, limit: int = 1500) -> str:
    return (
        f"exit={res.code}{' (TIMED OUT)' if res.timed_out else ''}\n"
        f"stdout:\n{res.out.strip()[:limit]}\n"
        f"stderr:\n{res.err.strip()[:limit]}"
    )


# --------------------------------------------------------------------------- #
# Phase 1 — build gate
# --------------------------------------------------------------------------- #


def phase_build(h: Harness) -> bool:
    """Compile the MCP server so the CLIs can spawn dist/index.js + dist/benchmark.js.

    `bin/llm-ext` spawns `mcp-server/dist/index.js`; `bin/llm-ext-benchmark`
    spawns `mcp-server/dist/benchmark.js` (both verified by reading the wrapper
    scripts). Without a build every CLI phase fails for the same root cause, so
    this gate runs first and stops the CLI phases (but not the static file
    audits) on failure. `npm run build` = `tsc --noEmit && esbuild` per
    mcp-server/package.json.
    """
    res = run(["npm", "run", "build"], cwd=MCP_SERVER_DIR, timeout=BUILD_TIMEOUT)
    if res.code != 0:
        h.add(
            "build",
            "npm run build",
            FAIL,
            "compile mcp-server (tsc --noEmit && esbuild)",
            _evidence(res, 2500),
        )
        return False
    missing = [str(p) for p in (MCP_SERVER_ENTRY, BENCH_BUNDLE) if not p.exists()]
    if missing:
        h.add(
            "build",
            "npm run build",
            FAIL,
            "compile mcp-server (tsc --noEmit && esbuild)",
            "build exited 0 but expected artifact(s) missing:\n" + "\n".join(missing),
        )
        return False
    h.add(
        "build",
        "npm run build",
        PASS,
        "compile mcp-server -> dist/index.js + dist/benchmark.js",
    )
    return True


# --------------------------------------------------------------------------- #
# Phase 2 — enumerate the verb catalog dynamically from `llm-ext --help`
# --------------------------------------------------------------------------- #


def parse_top_help_tools(top_help: str) -> list[str]:
    """Extract command names from the 'Commands:' section of `llm-ext --help`.

    Ground truth (verified against the real CLI): the CLI prints a 'Commands:'
    header, then each command indented by two spaces — the first token of the
    line is the command name, followed by its description (which may itself
    contain words, so only the first token is the name). Collection stops at the
    first blank line after the header.

    The header used to be 'Tools:' when this was an MCP server. Nothing errored
    when it changed: the scan simply matched no header, returned [], and every
    downstream command check degraded to SKIP while still reporting a green
    run. A parser that yields nothing must never look like a clean pass, which
    is why the caller now treats an empty catalog as a failure.
    """
    verbs: list[str] = []
    in_tools = False
    for line in top_help.splitlines():
        if line.strip() == "Commands:":
            in_tools = True
            continue
        if in_tools:
            if not line.strip():
                break
            if not line.startswith("  "):
                break
            token = line.strip().split()[0]
            if token:
                verbs.append(token)
    return verbs


def phase_top_help(h: Harness) -> list[str]:
    """Run top-level --help, record PASS/FAIL, return the parsed command list."""
    res = llm_ext(["--help"])
    if res.code != 0 or "Commands:" not in res.out:
        h.add(
            "cli",
            "--help",
            FAIL,
            "top-level `llm-ext --help` lists the command catalog",
            _evidence(res),
        )
        return []
    verbs = parse_top_help_tools(res.out)
    if not verbs:
        h.add(
            "cli",
            "--help",
            FAIL,
            "top-level `llm-ext --help` lists the command catalog",
            "'Commands:' section present but no commands parsed",
        )
        return []
    h.add(
        "cli",
        "--help",
        PASS,
        f"top-level --help lists {len(verbs)} commands",
        "commands: " + ", ".join(verbs),
    )
    return verbs


# --------------------------------------------------------------------------- #
# Phase 3 — per-verb --help
# --------------------------------------------------------------------------- #


def phase_per_verb_help(h: Harness, verbs: list[str]) -> None:
    """Every command must print a help block.

    Ground truth (re-verified against the real CLI): `llm-ext <cmd> --help`
    prints a `llm-ext <cmd>` header, the description, then either a
    'Parameters:' block or the literal 'Takes no parameters.'.

    This previously looked for a `<cmd>:` header and 'No parameters.', which is
    what the MCP-era CLI printed. Both spellings changed with the rewrite, so
    all 40 checks failed at once — the useful signal being that a whole phase
    failing identically means the assertion moved, not the subject.
    """
    for verb in verbs:
        # `--help` is generated from the in-process catalog and exits without
        # any network call, so it should be near-instant. A short timeout makes
        # a stuck help call fail fast instead of stalling the whole suite.
        res = llm_ext([verb, "--help"], timeout=30)
        header_ok = f"llm-ext {verb}" in res.out
        schema_ok = ("Parameters:" in res.out) or ("Takes no parameters." in res.out)
        if res.code == 0 and header_ok and schema_ok:
            h.add("cli-help", verb, PASS, f"`llm-ext {verb} --help` prints its schema")
        else:
            h.add(
                "cli-help",
                verb,
                FAIL,
                f"`llm-ext {verb} --help` prints its schema",
                _evidence(res, 1000),
            )


# --------------------------------------------------------------------------- #
# Phase 4 — discover health (balance probe, no LLM call)
# --------------------------------------------------------------------------- #


def phase_discover(h: Harness) -> None:
    res = llm_ext(["discover"])
    # The real `discover` output reliably contains an "Active profile:" line
    # plus a "Status:" and "Auth:" line. Match those stable markers (case-
    # insensitive) rather than a bare "Profile:" which the CLI never prints.
    low = res.out.lower()
    health_ok = ("active profile:" in low) and ("status:" in low or "auth:" in low)
    if res.code == 0 and health_ok:
        h.add(
            "cli",
            "discover",
            PASS,
            "`discover` resolves profile + auth + balance probe (no LLM call)",
            res.out.strip()[:1500],
        )
    elif res.code == 0:
        h.add(
            "cli",
            "discover",
            WARN,
            "`discover` resolves profile + auth + balance probe (no LLM call)",
            "exited 0 but output did not contain a recognizable profile/header:\n"
            + res.out.strip()[:1500],
        )
    else:
        # An auth/balance/network failure is environmental, not a harness bug.
        combined = res.combined.lower()
        env_signal = any(
            s in combined
            for s in ("no api key", "no token", "auth", "unauthor", "401", "balance", "network", "fetch")
        )
        h.add(
            "cli",
            "discover",
            WARN if env_signal else FAIL,
            "`discover` resolves profile + auth + balance probe (no LLM call)",
            _evidence(res),
        )


# --------------------------------------------------------------------------- #
# Phase 5 — benchmark --help + THREE dry-run variants — $0
# --------------------------------------------------------------------------- #


def _benchmark_dry_run_safe(res: RunResult) -> bool:
    """A dry-run is safe iff it exits before any API call AND shows no billing.

    Ground truth (verified against the real CLI): every dry-run path ends with
    `[benchmark] --dry-run: roster only, exiting before any API call.`. We treat
    the absence of that "exiting before any API call" marker, OR the presence of
    usage/cost tokens, as a cost-safety regression worth a WARN.
    """
    blob = res.combined.lower()
    no_call_marker = (
        "exiting before any api call" in blob  # the real dry-run end marker
        or "no api calls made" in blob  # the --help phrasing, defensive
        or "no llm call" in blob  # defensive: alternate phrasing
    )
    billed_tokens = any(
        t in blob for t in ("total_cost", "prompt_tokens", "completion_tokens", "usage:")
    )
    return no_call_marker and not billed_tokens


def phase_benchmark(h: Harness) -> None:
    # 5a. benchmark --help. Ground truth: the CLI prints a "Usage:" block and a
    # "Flags:" section (NOT "Options:") and documents --dry-run.
    res = llm_ext_bench(["--help"])
    if res.code == 0 and ("Flags:" in res.out or "Usage:" in res.out) and "--dry-run" in res.out:
        h.add("benchmark", "--help", PASS, "`llm-ext-benchmark --help` prints its flags")
    else:
        h.add(
            "benchmark",
            "--help",
            FAIL,
            "`llm-ext-benchmark --help` prints its flags",
            _evidence(res, 1000),
        )

    # 5b/5c. The two dry-run variants the benchmark CLI supports (TRDD §4).
    # Both must print their roster and exit before any API call — i.e. $0.
    # (The CLI has no --profile flag; do not invent a third variant.)
    variants = [
        ("benchmark --dry-run", ["--dry-run"]),
        ("benchmark --bench-free-pool --dry-run", ["--bench-free-pool", "--dry-run"]),
    ]
    for label, flags in variants:
        res = llm_ext_bench(flags)
        safe = _benchmark_dry_run_safe(res)
        if res.code == 0 and safe:
            h.add("benchmark", label, PASS, f"`{label}` prints roster, no LLM call ($0)", res.out.strip()[:1200])
        elif res.code == 0 and not safe:
            h.add(
                "benchmark",
                label,
                WARN,
                f"`{label}` prints roster, no LLM call ($0)",
                "dry-run exited 0 but the 'no LLM call' marker was absent or "
                "usage/cost tokens were present (possible cost-safety regression):\n"
                + res.out.strip()[:1200],
            )
        else:
            h.add(
                "benchmark",
                label,
                FAIL,
                f"`{label}` prints roster, no LLM call ($0)",
                _evidence(res, 1200),
            )


# --------------------------------------------------------------------------- #
# Phase 6 — read-only $0 tools
# --------------------------------------------------------------------------- #


def phase_readonly_tools(h: Harness) -> None:
    # get_settings — pure local read; returns a snapshot file path.
    res = llm_ext(["get_settings"])
    if res.code == 0 and ("Settings copied" in res.out or ".yaml" in res.out):
        h.add("cli", "get_settings", PASS, "`get_settings` writes a settings snapshot (local read)", res.out.strip()[:1000])
    else:
        h.add("cli", "get_settings", FAIL, "`get_settings` writes a settings snapshot (local read)", _evidence(res, 1000))

    # or_model_info_json — public catalog read for one model id (no key, $0).
    res = llm_ext(["or_model_info_json", "--model", KNOWN_MODEL_ID])
    if res.code == 0 and res.out.strip():
        try:
            obj = json.loads(res.out.strip())
            valid = isinstance(obj, dict) and obj.get("id") == KNOWN_MODEL_ID
        except json.JSONDecodeError:
            valid = False
        if valid:
            h.add(
                "cli",
                "or_model_info_json",
                PASS,
                f"`or_model_info_json --model {KNOWN_MODEL_ID}` returns catalog JSON ($0)",
                res.out.strip()[:600],
            )
        else:
            h.add(
                "cli",
                "or_model_info_json",
                WARN,
                f"`or_model_info_json --model {KNOWN_MODEL_ID}` returns catalog JSON ($0)",
                "exited 0 but output was not the expected model JSON:\n" + res.out.strip()[:600],
            )
    else:
        env_signal = _looks_environmental(res)
        h.add(
            "cli",
            "or_model_info_json",
            WARN if env_signal else FAIL,
            f"`or_model_info_json --model {KNOWN_MODEL_ID}` returns catalog JSON ($0)",
            _evidence(res, 800),
        )

    # discover_new_models — diffs the live catalog vs snapshot (catalog fetch, $0).
    res = llm_ext(["discover_new_models"])
    if res.code == 0 and ("DISCOVER NEW MODELS" in res.out or "catalog" in res.out.lower()):
        h.add(
            "cli",
            "discover_new_models",
            PASS,
            "`discover_new_models` diffs live catalog vs snapshot ($0, no LLM)",
            res.out.strip()[:800],
        )
    elif res.code == 0:
        h.add(
            "cli",
            "discover_new_models",
            WARN,
            "`discover_new_models` diffs live catalog vs snapshot ($0, no LLM)",
            "exited 0 but output was unrecognizable:\n" + res.out.strip()[:800],
        )
    else:
        env_signal = _looks_environmental(res)
        h.add(
            "cli",
            "discover_new_models",
            WARN if env_signal else FAIL,
            "`discover_new_models` diffs live catalog vs snapshot ($0, no LLM)",
            _evidence(res, 800),
        )


def _looks_environmental(res: RunResult) -> bool:
    blob = res.combined.lower()
    return res.timed_out or any(
        s in blob for s in ("network", "fetch", "timeout", "enotfound", "econn", "rate limit", "429", "socket")
    )


# --------------------------------------------------------------------------- #
# Frontmatter parsing (stdlib only — no PyYAML dependency)
# --------------------------------------------------------------------------- #


def parse_frontmatter(text: str) -> dict[str, object] | None:
    """Parse a leading `--- ... ---` YAML-ish frontmatter block.

    Handles the shapes the plugin's commands/skills actually use (no PyYAML
    dependency, so `uv run` stays zero-install):
      * flat scalars        `key: value`              -> str
      * inline scalars with quotes / colons stripped to the value
      * block sequences     `key:` then `  - item` …  -> list[str]

    Block sequences are essential: every command's `allowed-tools` is written
    as a YAML block list, so a scalar-only parser would wrongly see the key as
    empty. Returns None if the file does not open with a terminated `---` fence.
    """
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return None
    fm: dict[str, object] = {}
    current_list_key: str | None = None
    for line in lines[1:]:
        if line.strip() == "---":
            return fm
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        # A `  - item` continuation line belongs to the most recent `key:`
        # whose value was empty (i.e. a block-sequence header).
        if current_list_key is not None and line.lstrip().startswith("- "):
            item = line.lstrip()[2:].strip().strip("'\"")
            lst = fm.get(current_list_key)
            if isinstance(lst, list):
                lst.append(item)
            continue
        if ":" not in line:
            continue
        key, _, value = line.partition(":")
        key = key.strip()
        value = value.strip()
        if value == "":
            # Empty value -> a block-sequence header; start collecting items.
            fm[key] = []
            current_list_key = key
        else:
            fm[key] = value.strip("'\"")
            current_list_key = None
    # No closing fence found -> not valid frontmatter.
    return None


# --------------------------------------------------------------------------- #
# Phase 7 — slash-command structural audit
# --------------------------------------------------------------------------- #


# Matches `llm-ext <subcommand>` anywhere in a command body, including the
# `${CLAUDE_PLUGIN_ROOT}/bin/llm-ext scan-folder` form the commands actually
# use. Requiring the subcommand to start with a letter is what keeps
# `llm-ext --help` and `llm-ext --version` from being read as subcommands.
LLM_EXT_INVOCATION = re.compile(r"llm-ext\s+([a-z][a-z0-9_-]*)")


def _llm_ext_subcommands(body: str) -> list[str]:
    """Every distinct `llm-ext <subcommand>` named in a command body, kebab-normalized.

    The CLI accepts snake_case as a silent alias, so a body may legitimately
    say `scan_folder`; the catalog only ever lists the kebab spelling, so
    normalize before comparing or the alias reads as an unknown command.
    """
    seen: list[str] = []
    for m in LLM_EXT_INVOCATION.finditer(body):
        name = m.group(1).replace("_", "-")
        if name not in seen:
            seen.append(name)
    return seen


def _allowed_tools_list(fm: dict[str, object]) -> list[str]:
    """Normalize the `allowed-tools` frontmatter value to a list of tool names."""
    val = fm.get("allowed-tools")
    if isinstance(val, list):
        return [str(x) for x in val]
    if isinstance(val, str) and val:
        # Inline form, e.g. `allowed-tools: Bash, Read` (rare here, tolerated).
        return [t.strip() for t in val.split(",") if t.strip()]
    return []


def resolve_command_tool(fm: dict[str, object], body: str, catalog: set[str]) -> tuple[str, str]:
    """Resolve what real tool a command dispatches.

    The plugin's commands are thin wrappers and come in four legitimate shapes
    (verified against the actual commands/*.md):

    1. CLI wrapper — the body runs `llm-ext <subcommand>`. Every subcommand it
       names must exist in the live command table. This is the real check, and
       it is checked FIRST for a reason (see below).
    2. Benchmark wrapper — the body runs `llm-ext-benchmark`; dispatch is by
       flag, so there is no subcommand to resolve (by design, GAP-2).
    3. Orchestration wrapper — `allowed-tools` includes `Task`/`Agent`; the
       command dispatches a subagent rather than a command (GAP-8..14).
    4. Installer / external-CLI wrapper — `Bash`-only and legitimately never
       calls `llm-ext` (the statusline installer).

    Ordering is load-bearing. This used to key off the
    `mcp__llm-externalizer__<verb>` entry in `allowed-tools`, with a Bash-only
    catch-all last. The migration made every command `allowed-tools: Bash`, so
    that catch-all matched all of them and the function returned PASS without
    ever resolving anything — the gate reported green while checking nothing.
    Resolving the body's invocations first is what keeps it a real check;
    shape 4 only applies once we know there is no invocation to verify.

    Returns (status, detail). status is PASS or FAIL.
    """
    tools = _allowed_tools_list(fm)

    # Shape 1 — every `llm-ext <subcommand>` in the body must be a real command.
    invoked = _llm_ext_subcommands(body)
    if invoked:
        unknown = [c for c in invoked if c not in catalog]
        if unknown:
            return (
                FAIL,
                f"body runs `llm-ext {'`, `llm-ext '.join(unknown)}` but "
                f"{'that is not a' if len(unknown) == 1 else 'those are not'} "
                f"command{'' if len(unknown) == 1 else 's'} in the CLI table "
                f"({len(catalog)} known).",
            )
        return PASS, f"runs `llm-ext {invoked[0]}` (in catalog)"

    # Shape 2 — benchmark wrapper (flag-dispatched, no subcommand).
    if "llm-ext-benchmark" in body:
        return PASS, "benchmark CLI wrapper (flag-dispatched)"

    # Shape 3 — orchestration wrapper (Task/Agent subagent dispatch).
    if "Task" in tools or "Agent" in tools:
        return PASS, "orchestration wrapper (Task/Agent dispatch; by-design slash-only)"

    # Shape 4 — installer / external-CLI wrapper with no llm-ext call to check.
    if "Bash" in tools:
        return PASS, "Bash wrapper (external CLI / installer; invokes no llm-ext command)"

    return (
        FAIL,
        "command names no llm-ext invocation and no Bash/Task wrapper shape — "
        "cannot confirm it dispatches anything real.",
    )


def phase_command_audit(h: Harness, verbs: list[str], catalog_available: bool = True) -> None:
    """Audit every commands/*.md.

    Frontmatter (description + allowed-tools) is always validated — it does not
    depend on the build. Tool resolution against the catalog only happens when
    ``catalog_available`` is True; if the build failed the catalog is empty for
    an unrelated reason, so resolution is reported SKIP (deferred) rather than a
    misleading cascade of FAILs.

    Note on the `name` field: Claude Code derives a command's invocation name
    from its filename, so `name` in frontmatter is OPTIONAL. We validate the
    fields that are actually required (`description`, `allowed-tools`) and only
    NIT on a present-but-mismatched `name`.
    """
    catalog = set(verbs)
    files = sorted(COMMANDS_DIR.glob("*.md"))
    if not files:
        h.add("command", "(none)", FAIL, "commands/*.md present", f"no .md files under {COMMANDS_DIR}")
        return
    for f in files:
        text = f.read_text(encoding="utf-8")
        fm = parse_frontmatter(text)
        rel = f"commands/{f.name}"
        if fm is None:
            h.add("command", f.name, FAIL, "frontmatter + wrapped tool resolves", f"{rel}: missing/unterminated frontmatter")
            continue
        if not fm.get("description"):
            h.add("command", f.name, FAIL, "frontmatter + wrapped tool resolves", f"{rel}: frontmatter missing required key: description")
            continue
        if not _allowed_tools_list(fm):
            h.add("command", f.name, FAIL, "frontmatter + wrapped tool resolves", f"{rel}: frontmatter missing/empty required key: allowed-tools")
            continue
        # `name` is optional; if present it should match the file stem.
        if isinstance(fm.get("name"), str) and fm["name"] != f.stem:
            h.add(
                "command",
                f.name,
                WARN,
                "frontmatter + wrapped tool resolves",
                f"{rel}: frontmatter name '{fm['name']}' != file stem '{f.stem}'",
            )
            continue

        if not catalog_available:
            h.add(
                "command",
                f.name,
                SKIP,
                "frontmatter ok; tool resolution deferred (build failed)",
                f"{rel}: frontmatter valid; catalog unavailable so resolution is deferred.",
            )
            continue

        body = text.split("---", 2)[-1]
        status, detail = resolve_command_tool(fm, body, catalog)
        if status == PASS:
            h.add("command", f.name, PASS, f"frontmatter ok; {detail}")
        else:
            h.add("command", f.name, FAIL, "frontmatter + wrapped tool resolves", f"{rel}: {detail}")


# --------------------------------------------------------------------------- #
# Phase 8 — skill structural audit
# --------------------------------------------------------------------------- #


def phase_skill_audit(h: Harness) -> None:
    skill_files = sorted(SKILLS_DIR.glob("*/SKILL.md"))
    if not skill_files:
        h.add("skill", "(none)", FAIL, "skills/*/SKILL.md present", f"no SKILL.md under {SKILLS_DIR}")
        return
    for f in skill_files:
        dirname = f.parent.name
        rel = f"skills/{dirname}/SKILL.md"
        text = f.read_text(encoding="utf-8")
        fm = parse_frontmatter(text)
        if fm is None:
            h.add("skill", dirname, FAIL, "SKILL.md frontmatter valid", f"{rel}: missing/unterminated frontmatter")
            continue
        missing = [k for k in ("name", "description") if not fm.get(k)]
        if missing:
            h.add(
                "skill",
                dirname,
                FAIL,
                "SKILL.md frontmatter valid",
                f"{rel}: frontmatter missing required key(s): {', '.join(missing)}",
            )
            continue
        if fm.get("name") != dirname:
            h.add(
                "skill",
                dirname,
                WARN,
                "SKILL.md frontmatter valid",
                f"{rel}: frontmatter name '{fm.get('name')}' != directory '{dirname}'",
            )
            continue
        # If user-invocable is present, it must be a YAML boolean scalar.
        ui = fm.get("user-invocable")
        if ui is not None and (not isinstance(ui, str) or ui.lower() not in ("true", "false")):
            h.add(
                "skill",
                dirname,
                WARN,
                "SKILL.md frontmatter valid",
                f"{rel}: user-invocable '{ui}' is not a boolean (true/false)",
            )
            continue
        h.add("skill", dirname, PASS, "SKILL.md frontmatter valid (name + description)")


# --------------------------------------------------------------------------- #
# Phase 9 — opt-in DOGFOOD_LIVE free-pool smoke (SKIPPED by default; $0 even live)
# --------------------------------------------------------------------------- #


def _model_id_from_output(text: str) -> str | None:
    """Best-effort extraction of the answering model id from CLI output."""
    try:
        obj = json.loads(text.strip())
        if isinstance(obj, dict):
            for key in ("model", "model_id", "answeredBy", "id"):
                if isinstance(obj.get(key), str):
                    return obj[key]
    except (json.JSONDecodeError, ValueError):
        pass
    for line in text.splitlines():
        s = line.strip()
        if ":free" in s:
            for tok in s.replace(",", " ").replace('"', " ").split():
                if "/" in tok and ":free" in tok:
                    return tok
    return None


def _live_smoke_one(h: Harness, name: str, args: list[str], desc: str) -> None:
    # snail emoji marks the slow, opt-in live rows.
    label = f"🐌 {name}"
    res = llm_ext(args, timeout=RUN_TIMEOUT)
    model = _model_id_from_output(res.out)
    if res.code == 0 and model and model.endswith(":free"):
        h.add("live", label, PASS, desc, f"answered by free model: {model}")
    elif res.code == 0 and model and not model.endswith(":free"):
        h.add(
            "live",
            label,
            FAIL,
            desc,
            f"COST RISK: answering model '{model}' is NOT a ':free' model.",
        )
    else:
        h.add(
            "live",
            label,
            WARN,
            desc,
            "could not confirm a :free model (free tier is heavily rate-limited):\n" + _evidence(res, 800),
        )


def phase_live_smoke(h: Harness) -> None:
    if os.environ.get("DOGFOOD_LIVE") != "1":
        h.add(
            "live",
            "🐌 free-pool-smoke",
            SKIP,
            "chat+code_task on free pool (opt-in; set DOGFOOD_LIVE=1)",
            "Skipped by default. Set DOGFOOD_LIVE=1 to run; even then the answering "
            "model must end in ':free' so spend stays $0.",
        )
        return
    _live_smoke_one(
        h,
        "chat",
        ["chat", "--instructions", "Reply with exactly the word: ok"],
        "free-pool chat answered by a :free model ($0)",
    )
    _live_smoke_one(
        h,
        "code_task",
        ["code_task", "--instructions", "Name the single function in this file.", "--input_files_paths", str(FIXTURE)],
        "free-pool code_task answered by a :free model ($0)",
    )


# --------------------------------------------------------------------------- #
# Result table (Unicode-bordered: heavy header, light rows, 6-char status col)
# --------------------------------------------------------------------------- #

STATUS_CELL = {PASS: "PASS  ", FAIL: "FAIL  ", WARN: "WARN  ", SKIP: "SKIP  "}


def _vis_len(s: str) -> int:
    """Display width that counts an emoji + its trailing space as 2 cells.

    The snail emoji renders ~2 columns wide in a monospace terminal. Counting
    it as 2 keeps the light-rule borders aligned with the header.
    """
    width = 0
    for ch in s:
        width += 2 if ord(ch) > 0x2300 else 1
    return width


def _pad(s: str, width: int) -> str:
    pad = width - _vis_len(s)
    return s + (" " * pad if pad > 0 else "")


def _clip(s: str, width: int) -> str:
    if _vis_len(s) <= width:
        return s
    # Trim conservatively on raw length then add ellipsis.
    return s[: max(0, width - 1)] + "…"


def render_table(checks: list[Check]) -> str:
    headers = ("Surface", "Name", "Status", "Description")
    surf_w = max([len(headers[0])] + [_vis_len(c.surface) for c in checks])
    name_w = min(max([len(headers[1])] + [_vis_len(c.name) for c in checks]), 44)
    stat_w = 6
    desc_w = min(max([len(headers[3])] + [_vis_len(c.description) for c in checks]), 62)

    def row(c0: str, c1: str, c2: str, c3: str, v: str) -> str:
        return (
            v + _pad(c0, surf_w) + v + _pad(c1, name_w) + v + _pad(c2, stat_w) + v + _pad(c3, desc_w) + v
        )

    def hline(left: str, junc: str, right: str, ch: str) -> str:
        return left + ch * surf_w + junc + ch * name_w + junc + ch * stat_w + junc + ch * desc_w + right

    out: list[str] = []
    out.append(hline("┏", "┳", "┓", "━"))
    out.append(row(headers[0], headers[1], headers[2], headers[3], "┃"))
    out.append(hline("┡", "╇", "┩", "━"))
    for c in checks:
        out.append(
            row(
                _clip(c.surface, surf_w),
                _clip(c.name, name_w),
                STATUS_CELL.get(c.status, c.status.ljust(stat_w)),
                _clip(c.description, desc_w),
                "│",
            )
        )
    out.append(hline("└", "┴", "┘", "─"))
    return "\n".join(out)


def summary_counts(checks: list[Check]) -> dict[str, int]:
    counts = {PASS: 0, FAIL: 0, WARN: 0, SKIP: 0}
    for c in checks:
        counts[c.status] = counts.get(c.status, 0) + 1
    return counts


# --------------------------------------------------------------------------- #
# Markdown report
# --------------------------------------------------------------------------- #


def write_report(checks: list[Check], table: str, started: datetime, live: bool) -> Path:
    root = main_repo_root()
    report_dir = root / "reports" / "dogfood"
    report_dir.mkdir(parents=True, exist_ok=True)
    ts = started.astimezone().strftime("%Y%m%d_%H%M%S%z")
    report = report_dir / f"{ts}-dogfood.md"

    counts = summary_counts(checks)
    lines: list[str] = []
    lines.append("# llm-externalizer dogfood report")
    lines.append("")
    lines.append(f"Generated: {started.astimezone().isoformat()}")
    lines.append(f"Mode: {'LIVE (DOGFOOD_LIVE=1)' if live else 'default ($0, offline / read-only)'}")
    lines.append(f"Project root: `{PROJECT_ROOT}`")
    lines.append("")
    lines.append(
        f"Totals: {counts[PASS]} PASS · {counts[FAIL]} FAIL · {counts[WARN]} WARN · {counts[SKIP]} SKIP "
        f"({len(checks)} checks)"
    )
    lines.append("")
    lines.append("## Result table")
    lines.append("")
    lines.append("```")
    lines.append(table)
    lines.append("```")
    lines.append("")

    attn = [c for c in checks if c.status in (FAIL, WARN)]
    lines.append("## Findings (FAIL / WARN)")
    lines.append("")
    if not attn:
        lines.append("_None — all checks passed or were skipped._")
        lines.append("")
    else:
        for c in attn:
            lines.append(f"### [{c.status}] {c.surface} · {c.name}")
            lines.append("")
            lines.append(f"- Check: {c.description}")
            if c.detail:
                lines.append("- Evidence:")
                lines.append("")
                lines.append("```")
                lines.append(c.detail.rstrip())
                lines.append("```")
            lines.append("")

    lines.append("## All checks")
    lines.append("")
    for c in checks:
        lines.append(f"- [{c.status}] `{c.surface}` · `{c.name}` — {c.description}")
    lines.append("")

    report.write_text("\n".join(lines), encoding="utf-8")
    return report


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #


def main() -> int:
    started = datetime.now()
    live = os.environ.get("DOGFOOD_LIVE") == "1"
    h = Harness()

    # Sanity: the CLI entry points must exist before we do anything.
    for label, p in (("bin/llm-ext", LLM_EXT), ("bin/llm-ext-benchmark", LLM_EXT_BENCH)):
        if not p.exists():
            h.add("build", label, FAIL, f"{label} present", f"missing: {p}")

    if not LLM_EXT.exists():
        table = render_table(h.checks)
        print(table)
        report = write_report(h.checks, table, started, live)
        print(f"\nReport: {report}")
        return 1

    built = phase_build(h)
    if built:
        verbs = phase_top_help(h)
        if verbs:
            phase_per_verb_help(h, verbs)
        phase_discover(h)
        phase_benchmark(h)
        phase_readonly_tools(h)
        phase_command_audit(h, verbs)
    else:
        # Build failed: skip the CLI phases (same root cause), but still audit
        # the static command/skill files. Verb resolution is deferred (catalog
        # unavailable), not failed.
        h.add("cli", "(skipped)", SKIP, "CLI phases skipped because the build failed", "")
        phase_command_audit(h, [], catalog_available=False)

    # Skill audit and live smoke do not depend on the build.
    phase_skill_audit(h)
    phase_live_smoke(h)

    table = render_table(h.checks)
    print(table)
    counts = summary_counts(h.checks)
    print(
        f"\n{counts[PASS]} PASS · {counts[FAIL]} FAIL · {counts[WARN]} WARN · {counts[SKIP]} SKIP "
        f"({len(h.checks)} checks)"
    )
    report = write_report(h.checks, table, started, live)
    print(f"Report: {report}")
    return 1 if h.failed else 0


if __name__ == "__main__":
    sys.exit(main())
