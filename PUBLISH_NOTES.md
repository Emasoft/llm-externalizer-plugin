# Publishing this branch — what a future agent needs to know

## This branch is not publishable as it stands, BY DESIGN

The code is complete, tested and gated. What is missing is a **USER action**,
not code.

Getting `release/13.6.1` onto `origin/main` requires the **force-push of the
redacted history** that `TRDD-DRRUTC2M` (column: `dev`) reserves for the USER.
Until that push happens, this branch exists locally and the marketplace still
serves **13.6.0 from `origin/main`** — the PRE-rewrite line.

> A future agent reading "the gate passes" MUST NOT read "ready to publish".
> The gate proves the tree is internally consistent; it does not prove the tree
> is on the remote.

## Why `origin/main` is not the base

`origin/main` (3f6a1843, 2026-08-26) is the PRE-rewrite line:

- its CHANGELOG still carries 2 occurrences of the owner's login;
- its tree predates the 14.1.0 feature release by 781 changed files;
- its statusline caches under `/tmp/claude`; this branch's (before the
  independence fix) cached under `~/.llm-externalizer/statusline/` and read
  `$LLM_EXT_CONFIG_DIR`.

Publishing from `origin/main` would ship the 13.6.0 tree under a NEW tag. The
marketplace would then serve it as the newest release and 14.1.0 would become
invisible — a six-week rewind, published as current.

## The publish command, once the USER has force-pushed

```bash
git config --local push.default upstream      # a bare push needs it
git config --local core.hooksPath .githooks   # the pre-push gate is LOCAL config
uv run scripts/publish.py --set 14.1.0
```

`--set 14.1.0`, not `13.6.1`: this branch carries the whole 14.1.0 feature
release. The USER's 2026-09-18 decision was "fix all issues, verify and
publish / bump" for 14.1.0, and the CHANGELOG's curated highlights are
titled "Curated notes for 14.1.0". Shipping that as a patch would hide the
feature release from every consumer.

## Two known follow-ups, neither part of this release

1. **The CLI's guard asymmetry.** The CLI writes `/tmp/claude` with
   `mkdirSync(..., { mode: 0o700 })` and **no** lstat, **no** O_NOFOLLOW,
   **no** uid check. The statusline writes the same path with all three. On a
   shared host, a second local user who creates `/tmp/claude` first owns it:
   the CLI writes its stats into it, and the statusline then refuses it — the
   🔌 row goes empty, with no error. The fix is on the CLI side. (This
   asymmetry is pre-existing in the 13.6.0 lineage, which writes `/tmp/claude`
   from both sides, one guarded and one not.)

2. **The stray tag.** `v13.6.0-pubtip` still points at `3f6a1843`, a commit
   outside this history. The redaction card's step 5 pushes the 87 tags as a
   set.

## The gate is load-fragile — "the gate passed" is not reproducible here

The full TS suite carries wall-clock assertions (a 15s spawn budget, a 100ms
per-field regex deadline, comparisons like "expected 542 to be less than 400").
On a loaded machine they fail in ways that read like logic bugs. Measured on
2026-10-20:

- the **pristine base** commit 94eeb3dc fails **36 tests across 12 files**;
- this branch fails **19 across 9**;
- each failing file passes in isolation in both trees;
- the same assertion reproduces under artificial CPU load with none of the
  change present.

Do not tag a release on the assumption that a green gate is reproducible.
