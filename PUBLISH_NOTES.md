# Publishing llm-externalizer — what a future agent needs to know

`origin/main` carries the rewritten history, and v14.1.0, v14.1.1 and v14.1.2
were published from it. A release is a fast-forward of `origin/main`, never a
force push.

## publish.py is the only push path

`.githooks/pre-push` refuses every `git push` whose process ancestry does not
contain `scripts/publish.py` (it walks the parent processes; no lock file or
environment variable lets a push through). `git push --no-verify` skips every
pre-push hook, this one included: never use it. publish.py validates, bumps,
writes the CHANGELOG, rebuilds dist, commits, creates two annotated tags
(`vX.Y.Z` and the plugin resolver tag `<plugin-name>--vX.Y.Z`), then runs
`git push --follow-tags` and creates the GitHub release. If the push fails it
runs `git reset --hard HEAD~1`, which drops the release commit, and deletes
both local tags.

## Two local configs a fresh clone needs

```bash
git config --local push.default upstream      # the bare push in publish.py needs it
git config --local core.hooksPath .githooks   # the pre-push gate is local config
```

## The publish command

```bash
uv run scripts/publish.py --dry-run           # first: checks and the planned version, no release
uv run scripts/publish.py --set X.Y.Z         # then the real release
```

Both refuse a tree with uncommitted changes to tracked files (untracked files
are allowed). The dry run checks the required tools and the clean tree, runs
the full validation (npm ci, npm rebuild better-sqlite3, typecheck, lint,
build, test, ruff, shellcheck, the plugin.json parse, claude plugin validate,
the Python tests) and the CPV validation, works out the version and checks
that neither tag exists locally or on origin, then stops before the
CHANGELOG, the version bump, the commit, the tags and the push. It still
changes files: npm ci reinstalls node_modules, the build rewrites the tracked
`scripts/llm-ext/dist/` bundles, and each check writes its log to a gitignored
folder. When the rebuilt dist differs from the committed one,
the real run refuses the tree until dist is committed or restored. Use
`--set` with the version you mean; `--patch`, `--minor` and `--major` bump
that part; with none of them git-cliff picks the bump from the commit types,
and the run stops when it finds nothing to bump.

## The CHANGELOG is a git-cliff prepend

publish.py runs `git-cliff --unreleased --tag vX.Y.Z --prepend CHANGELOG.md`:
git-cliff removes the header (`[changelog].header` in `cliff.toml`, the first
three lines of the file), then writes the header, the new version section,
and the rest of the old file. A curated `### Highlights` block placed right
after the header therefore lands under the new version, after its generated
entries. Keep the first lines of the file identical to that header (the
comment at the git-cliff step in publish.py explains why).

## The test gate is load-sensitive

The TypeScript suite has wall-clock assertions (spawn budgets, regex
deadlines, timing comparisons), and publish.py tolerates no test failure. On
a loaded machine they fail in ways that read like logic bugs: run the gate on
an otherwise idle machine, and before treating a failure as real, re-run the
failing file on its own.
