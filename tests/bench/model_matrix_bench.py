#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["pyyaml"]
# ///
"""Model-matrix benchmark — does every command still work with the CURRENT models?

The dogfood harness proves every SURFACE exists ($0, mostly offline). This proves
the surfaces still PRODUCE CORRECT OUTPUT against the models configured today —
a different failure mode, and the one that rots silently as OpenRouter's free
roster churns underneath a pinned pool.

Two phases, both $0 (every model probed is `:free` or catalog-priced at $0):

  A. POOL HEALTH — probe every `free_models` member on a production-shaped
     payload (a real ~25k-token chunk, the `DEFAULT_MAX_CHUNK_TOKENS` size the
     compact map phase actually sends). Reports reachable / latency / whether
     the reply carries usable CONTENT rather than pure reasoning.

     Why a full-size chunk and not a "hello": a model can answer a toy prompt in
     2s and still emit ZERO content on a real chunk by spending its whole
     completion budget on reasoning. Measured 2026-08-26: `stealth/ox-alpha`
     returned 0 content chars at max_tokens=900 and needed 97.5s at 4000. A
     smoke test sized below the real workload cannot see that class of failure.

  B. COMMAND MATRIX — drive the REAL `llm-ext` CLI for each bounded command and
     assert the output file exists and is non-trivial. No mocking: the unit
     under test is the shipped binary talking to live models.

Exit non-zero if any row FAILs. Pool members that are merely unreachable are
WARN, not FAIL — a provider 429 is not a regression in this codebase. A command
that cannot produce output IS a FAIL.

  uv run tests/bench/model_matrix_bench.py            # both phases
  uv run tests/bench/model_matrix_bench.py --pool     # phase A only
  uv run tests/bench/model_matrix_bench.py --commands # phase B only
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import yaml

PROJECT_ROOT = Path(__file__).resolve().parents[2]
# Honour LLM_EXT_CONFIG_DIR exactly as config.ts::getConfigDir() does. Without
# this the bench would read the real settings while the CLI it spawns reads an
# overridden one — the two halves disagreeing about which pool is under test.
# It is also what lets Phase B run against a throwaway free_only profile
# instead of mutating the user's settings.yaml.
CONFIG_DIR = Path(os.environ.get("LLM_EXT_CONFIG_DIR") or (Path.home() / ".llm-externalizer"))
SETTINGS = CONFIG_DIR / "settings.yaml"
API = "https://openrouter.ai/api/v1/chat/completions"

PASS, FAIL, WARN, SKIP = "PASS", "FAIL", "WARN", "SKIP"

# A reply shorter than this on a full chunk is not a summary — it is a stub, a
# refusal, or a model that burned its budget reasoning. Measured floor: the
# worst genuine summary in the 2026-08-26 sweep was 1189 chars; the junk row
# (nemotron-3.5-content-safety) was 17.
MIN_USEFUL_CONTENT = 200


def repo_root() -> Path:
    """Main checkout, even when called from a linked worktree."""
    try:
        out = subprocess.run(["git", "worktree", "list", "--porcelain"],
                             capture_output=True, text=True, cwd=PROJECT_ROOT, timeout=30)
        for line in out.stdout.splitlines():
            if line.startswith("worktree "):
                return Path(line[len("worktree "):])
    except Exception as exc:
        # WHY print: the 30 s git timeout used to vanish into a bare pass (review m6); say which root is used.
        print(f"  ! git worktree lookup failed ({exc!r}); using PROJECT_ROOT {PROJECT_ROOT}", flush=True)
    return PROJECT_ROOT


class Rows:
    def __init__(self) -> None:
        self.rows: list[dict] = []

    def add(self, phase: str, name: str, status: str, detail: str, note: str = "") -> None:
        self.rows.append(dict(phase=phase, name=name, status=status,
                              detail=detail, note=note))
        mark = {PASS: "✓", FAIL: "✗", WARN: "!", SKIP: "-"}[status]
        print(f"  {mark} {name:52} {detail}", flush=True)

    @property
    def failed(self) -> int:
        return sum(1 for r in self.rows if r["status"] == FAIL)


def free_pool() -> list[str]:
    """Every model id under any `free_models:` list in settings.yaml."""
    def walk(o):
        if isinstance(o, dict):
            for k, v in o.items():
                if k == "free_models" and isinstance(v, list):
                    yield from v
                else:
                    yield from walk(v)
        elif isinstance(o, list):
            for i in o:
                yield from walk(i)
    if not SETTINGS.exists():
        return []
    return sorted(set(walk(yaml.safe_load(SETTINGS.read_text()))))


def build_chunk(target_chars: int = 100_000) -> str:
    """A real ~25k-token payload built from this repo's own TypeScript.

    100k chars of source measured 24_656 provider-reported prompt_tokens on
    2026-08-26 — i.e. the production chunk size. Do NOT swap in prose without
    re-measuring: prose tokenizes at ~4 chars/token, dense source nearer 4.05,
    and the point of this payload is that it matches what compact really sends.
    """
    src = PROJECT_ROOT / "scripts" / "llm-ext" / "src"
    buf: list[str] = []
    total = 0
    for f in sorted(src.rglob("*.ts")):
        if ".test." in f.name:
            continue
        t = f.read_text(errors="ignore")
        buf.append(t)
        total += len(t)
        if total >= target_chars:
            break
    return "".join(buf)[:target_chars]


def probe(model: str, prompt: str, key: str, max_tokens: int = 4000) -> dict:
    body = json.dumps({"model": model,
                       "messages": [{"role": "user", "content": prompt}],
                       "max_tokens": max_tokens}).encode()
    req = urllib.request.Request(API, data=body, headers={
        "Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            d = json.load(r)
    except urllib.error.HTTPError as e:
        return dict(sec=round(time.time() - t0, 1), err=f"HTTP{e.code}",
                    chars=0, reasoning=0, cost=0.0)
    except Exception as e:
        return dict(sec=round(time.time() - t0, 1),
                    err=f"{type(e).__name__}", chars=0, reasoning=0, cost=0.0)
    ch = (d.get("choices") or [{}])[0]
    msg = ch.get("message", {}) or {}
    u = d.get("usage") or {}
    return dict(sec=round(time.time() - t0, 1),
                err=str(d.get("error"))[:80] if d.get("error") else "",
                chars=len(msg.get("content") or ""),
                reasoning=len(msg.get("reasoning") or ""),
                cost=float(u.get("cost") or 0.0),
                finish=ch.get("finish_reason"),
                ptok=u.get("prompt_tokens"))


def phase_pool(rows: Rows, key: str) -> None:
    print("\nPhase A — pool health on a production-shaped chunk")
    pool = free_pool()
    if not pool:
        rows.add("pool", "(settings)", FAIL, "no free_models found",
                 f"looked in {SETTINGS}")
        return
    chunk = build_chunk()
    prompt = ("Summarize the following source material in at most 15 bullet "
              "points. Output only the bullets.\n\n<material>\n" + chunk +
              "\n</material>")
    healthy = 0
    for m in pool:
        r = probe(m, prompt, key)
        # A billed reply under free mode is a COST-SAFETY failure, not a perf note.
        if r["cost"] > 0:
            rows.add("pool", m, FAIL, f"BILLED ${r['cost']}",
                     "free-pool member returned a non-zero cost")
        elif r["err"]:
            rows.add("pool", m, WARN, f"unreachable ({r['err']})",
                     "provider-side; not a code regression")
        elif r["chars"] < MIN_USEFUL_CONTENT:
            rows.add("pool", m, WARN,
                     f"{r['sec']}s but only {r['chars']} content chars",
                     f"reasoning={r['reasoning']} finish={r.get('finish')}")
        else:
            healthy += 1
            rows.add("pool", m, PASS,
                     f"{r['sec']}s  {r['chars']} chars",
                     f"reasoning={r['reasoning']} ptok={r.get('ptok')}")
        time.sleep(5)  # do not self-inflict the 429s we are measuring
    status = PASS if healthy else FAIL
    rows.add("pool", "POOL USABLE", status, f"{healthy}/{len(pool)} usable",
             "a pool with zero usable members cannot serve any command")


# Bounded, single-payload commands. `scan`/`scout` are deliberately excluded:
# they fan out across a whole codebase, so they are a throughput test, not a
# per-model correctness test — and they route through the SAME send path these
# rows already cover.
COMMANDS = [
    ("llm summarize", ["llm", "summarize"], ["--max_chars", "400"]),
    ("llm topics", ["llm", "topics"], []),
    ("llm describe", ["llm", "describe"], []),
    ("llm sem-deduplicate", ["llm", "sem-deduplicate"], []),
    # `chat` takes --instructions, NOT --prompt. Every calling-convention
    # assumption in this table was wrong on first run (`-o` unsupported,
    # `--profile free` nonexistent, `--prompt` unknown); each was found only by
    # EXECUTING it. Verify against `--help` before adding a row here.
    ("llm ask", ["llm", "ask"],
     ["--instructions", "List the main topics in one line."]),
]


# Lines the CLI emits WHILE working. They are progress, not outcome, and must
# never decide a verdict — a transient "[http-retry] HTTP 429" is routinely
# printed by a command that then fails for an entirely unrelated reason.
_NOISE_PREFIXES = ("[http-retry]", "[llm-externalizer]", "[warn]", "[info]")


def classify_failure(stderr: str, stdout: str) -> tuple[str, str, str]:
    """Classify a non-zero exit by its TERMINAL reason, not by substring search.

    The previous version asked `"429" in err`, over stdout+stderr merged. That
    is a substring standing in for a condition, and it was measurably wrong:
    two rows whose real failure was `FAILED: summary is 925 chars, over the
    400-char limit` were reported as "rate-limited" and downgraded to WARN,
    so the bench printed 0 FAIL while two commands had genuinely failed their
    contract. Retry noise decided the verdict.

    Three outcomes, because they need different responses:
      WARN provider-exhausted — every free model refused us. Not a code
        regression, and failing fast is CORRECT (the alternative is billing).
      WARN over-budget — the command RAN and correctly refused to emit an
        oversized result. That is the documented contract ("never silent
        truncation"), i.e. a model-quality outcome, not a defect. Reported
        distinctly so it is never again mislabelled as a rate limit.
      FAIL — anything else: the command is broken.
    """
    lines = [ln.strip() for ln in (stderr + "\n" + stdout).splitlines() if ln.strip()]
    signal = [ln for ln in lines if not ln.startswith(_NOISE_PREFIXES)]
    terminal = signal[-1] if signal else (lines[-1] if lines else "")
    low = terminal.lower()
    if "over the" in low and "limit" in low:
        return WARN, "over budget (model quality)", terminal[:150]
    if ("rate limit" in low or "429" in low or "quota" in low
            or "no free model" in low or "free pool" in low):
        return WARN, "provider exhausted", terminal[:150]
    return FAIL, "failed", terminal[:150]


def free_only_profile() -> str | None:
    """Name of a profile that CANNOT bill, or None.

    Phase B drives real commands, so it must pin a profile whose `free_only` is
    true. It deliberately does NOT fall back to the active profile: on a machine
    whose active profile is a paid ensemble (the common case — the free pool is
    often attached to a paid profile purely as a 402 fallback), an unpinned run
    would quietly bill for a *benchmark*. Skipping is the safe answer; billing
    by default is not.
    """
    if not SETTINGS.exists():
        return None
    d = yaml.safe_load(SETTINGS.read_text()) or {}
    # sorted(): with several free_only profiles, dict order would make the
    # choice depend on YAML key order — the bench would silently test a
    # different pool run to run. Deterministic beats convenient here.
    for name in sorted((d.get("profiles") or {}).keys()):
        p = d["profiles"][name]
        if isinstance(p, dict) and p.get("free_only") is True:
            return name
    return None


def phase_commands(rows: Rows) -> None:
    print("\nPhase B — command matrix against the shipped CLI")
    binary = PROJECT_ROOT / "bin" / "llm-ext"
    if not binary.exists():
        rows.add("command", "(bin/llm-ext)", FAIL, "missing", str(binary))
        return
    profile = free_only_profile()
    if profile is None:
        rows.add("command", "(all)", SKIP, "no free_only profile — refusing to bill",
                 "add a profile with `free_only: true` (or materialize the "
                 "built-in `free`) and re-run; benchmarks must never bill")
        return
    # The fixture MUST live inside the project. `chat`/`code_task` enforce a
    # path-traversal guard ("resolves outside allowed directories"), so a
    # system-tmpdir fixture is rejected in 0.5s — which looks exactly like a
    # broken command until you read the error. reports_dev/ is gitignored.
    fixdir = PROJECT_ROOT / "reports_dev" / "bench-fixtures"
    fixdir.mkdir(parents=True, exist_ok=True)
    fixture = fixdir / "fixture.md"
    fixture.write_text(
        "# Release notes\n\n"
        "The parser now streams input instead of buffering whole files.\n"
        "Streaming reduces peak memory on large inputs.\n"
        "The cache key now includes the profile name.\n"
        "Including the profile prevents cross-profile cache collisions.\n"
        "Retries use exponential backoff with jitter.\n"
        "Backoff with jitter avoids thundering-herd retry storms.\n" * 3)
    # No `-o` here: the `llm` text tools deliberately have no output option and
    # fail fast if given one ("has no output option — it writes its report to
    # the project's reports directory"). The report path is recovered from
    # stdout instead, which is the documented contract.
    for label, verb, extra in COMMANDS:
        cmd = [str(binary), *verb, str(fixture), "--profile", profile, *extra]
        t0 = time.time()
        try:
            p = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
        except subprocess.TimeoutExpired:
            rows.add("command", label, FAIL, "timeout >900s", " ".join(verb))
            continue
        dt = round(time.time() - t0, 1)
        if p.returncode != 0:
            status, reason, last = classify_failure(p.stderr or "", p.stdout or "")
            rows.add("command", label, status, f"{reason} ({dt}s)", last)
            continue
        # The contract is "returns the report PATH on stdout" — so verify the
        # PATH RESOLVES and carries content. An exit code alone is a proxy:
        # these commands print a path and exit 0 even when the body is thin.
        path = next((ln.strip() for ln in reversed(p.stdout.splitlines())
                     if ln.strip().endswith(".md")), "")
        f = Path(path) if path else None
        if not f or not f.exists():
            rows.add("command", label, FAIL, f"no report file ({dt}s)",
                     f"stdout tail: {p.stdout.strip()[-120:]}")
            continue
        body = f.read_text().strip()
        if len(body) < 80:
            rows.add("command", label, FAIL, f"report too thin ({dt}s)",
                     f"{len(body)} chars at {f}")
        else:
            rows.add("command", label, PASS, f"{dt}s  {len(body)} chars", f.name)


def write_report(rows: Rows) -> Path:
    d = repo_root() / "reports" / "model-matrix-bench"
    d.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).astimezone().strftime("%Y%m%d_%H%M%S%z")
    out = d / f"{ts}-model-matrix.md"
    lines = [f"# Model matrix benchmark — {ts}", "",
             "| phase | target | status | detail | note |",
             "|---|---|---|---|---|"]
    for r in rows.rows:
        lines.append(f"| {r['phase']} | `{r['name']}` | {r['status']} | "
                     f"{r['detail']} | {r['note']} |")
    out.write_text("\n".join(lines) + "\n")
    return out


def main() -> int:
    # Phase selection is POSITIVE. The old form (`want_pool = "--commands" not
    # in argv`) made `--pool --commands` mean NEITHER: the bench ran nothing,
    # wrote an empty report and exited 0 printing "0 PASS 0 WARN 0 FAIL" —
    # indistinguishable from a clean gate. An unknown flag was equally silent.
    flags = {a for a in sys.argv[1:] if a.startswith("-")}
    unknown = flags - {"--pool", "--commands"}
    if unknown:
        print(f"unknown flag(s): {', '.join(sorted(unknown))} — "
              "expected --pool and/or --commands")
        return 2
    want_pool = "--pool" in flags or "--commands" not in flags
    want_cmds = "--commands" in flags or "--pool" not in flags
    rows = Rows()
    if want_pool:
        # Only phase A talks to OpenRouter directly; phase B drives the CLI,
        # which resolves its own credential. Refusing the whole run for a key
        # only one phase needs turned `--commands` into a false negative.
        key = os.environ.get("OPENROUTER_API_KEY")
        if not key:
            print("OPENROUTER_API_KEY unset — cannot probe live models.")
            return 2
        phase_pool(rows, key)
    if want_cmds:
        phase_commands(rows)
    report = write_report(rows)
    ok = sum(1 for r in rows.rows if r["status"] == PASS)
    warn = sum(1 for r in rows.rows if r["status"] == WARN)
    print(f"\n{ok} PASS  {warn} WARN  {rows.failed} FAIL")
    # State COVERAGE explicitly. "0 FAIL" reads as a clean bill of health even
    # when most rows produced no evidence the command works — a WARN is an
    # absence of evidence, not evidence of absence of a problem.
    cmd_rows = [r for r in rows.rows if r["phase"] == "command"]
    if cmd_rows:
        verified = sum(1 for r in cmd_rows if r["status"] == PASS)
        print(f"Command coverage: {verified}/{len(cmd_rows)} verified working "
              f"({len(cmd_rows) - verified} produced no such evidence)")
    print(f"Report: {report}")
    return 1 if rows.failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
