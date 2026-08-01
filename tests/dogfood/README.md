# Dogfood harness

`dogfood_test.py` is the llm-externalizer plugin's permanent self-test. It
exercises every public surface — every `bin/llm-ext` verb, the benchmark CLI,
the read-only catalog tools, and the structural integrity of every
`commands/*.md` and `skills/*/SKILL.md` — against the **real** binaries and
files. Nothing is mocked.

It backs the non-user-invocable `dogfood-test` skill
(`skills/dogfood-test/SKILL.md`).

## Cost-safety

- **Default run is `$0`.** No billable OpenRouter request is ever issued. The
  only network touched is the public model catalog (no API key) and the
  `discover` balance probe (no LLM call). Everything else is a local build, a
  `--help` print, a `--dry-run` roster, or a structural file read.
- **The live smoke is opt-in and still `$0`.** It runs only under
  `DOGFOOD_LIVE=1`, and even then asserts the answering model ends in `:free`
  (a non-`:free` answer FAILs the row as a cost risk).

## Invocation

Run from the plugin project root.

```bash
# Default — $0, offline / read-only (what CI and pre-publish run).
uv run tests/dogfood/dogfood_test.py
```

```bash
# Opt-in — also run the free-pool live smoke (chat + code_task on the fixture).
# Still $0: the smoke only passes if a :free model answers.
DOGFOOD_LIVE=1 uv run tests/dogfood/dogfood_test.py
```

- Exit code is **non-zero if any row is FAIL**. WARN and SKIP do not fail.
- A Unicode result table is printed to stdout (opt-in live rows are
  snail-marked 🐌).
- A full markdown report is written to
  `<main-repo-root>/reports/dogfood/<YYYYMMDD_HHMMSS±HHMM>-dogfood.md`
  (`reports/` is gitignored).

## Files

| File | Purpose |
|------|---------|
| `dogfood_test.py` | The harness — 9 phases, Unicode table, markdown report. |
| `sample-fixture.txt` | Tiny source file used only by the opt-in live smoke. |
| `README.md` | This file. |

## Phases

1. Build gate (`npm run build` in `scripts/llm-ext/`).
2. Top-level `llm-ext --help` — enumerates the verb catalog dynamically.
3. Per-verb `--help` for every enumerated verb.
4. `discover` — profile + auth + balance probe (no LLM call).
5. Benchmark `--help` + three dry-run variants (`--dry-run`,
   `--bench-free-pool --dry-run`, `--profile <active> --dry-run`).
6. Read-only `$0` tools (`get_settings`, `or_model_info_json`,
   `discover_new_models`).
7. Slash-command structural audit (`commands/*.md`).
8. Skill structural audit (`skills/*/SKILL.md`).
9. Opt-in `DOGFOOD_LIVE=1` free-pool smoke (skipped by default).
