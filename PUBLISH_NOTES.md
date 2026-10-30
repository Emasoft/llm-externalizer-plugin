# Publishing llm-externalizer — what a future agent needs to know

`origin/main` carries the rewritten history, and v14.1.0, v14.1.1 and v14.1.2
were published from it. A release is a fast-forward of `origin/main`, never a
force push.

## publish.py is the only push path

`.githooks/pre-push` refuses every `git push` whose process ancestry does not
contain `scripts/publish.py` (it walks the parent processes; there is no lock
file or environment variable to set, and no bypass). publish.py validates,
bumps, writes the CHANGELOG, commits, tags, then runs `git push --follow-tags`;
if the push fails it rolls back the release commit and both tags.

## Two local configs a fresh clone needs

```bash
git config --local push.default upstream      # the bare push in publish.py needs it
git config --local core.hooksPath .githooks   # the pre-push gate is local config
```

## The publish command

```bash
uv run scripts/publish.py --dry-run           # first: checks, version, tags, no changes
uv run scripts/publish.py --set X.Y.Z         # then the real release
```

Both need a clean working tree. The dry run runs the full validation (npm ci,
typecheck, lint, build, test, the Python tests and the plugin validator) and
stops before any change. Use
`--set` with the version you mean; without it git-cliff picks the bump from
the commit types.

## The CHANGELOG is a git-cliff prepend

publish.py runs `git-cliff --unreleased --tag vX.Y.Z --prepend CHANGELOG.md`:
git-cliff removes the header (`[changelog].header` in `cliff.toml`, the first
three lines of the file), then writes the header, the new version section,
and the rest of the old file. A curated `### Highlights` block placed right
after the header therefore lands under the new version, after its generated
entries. Keep the first lines of the file identical to that header (the
comment at the git-cliff step in publish.py requires it).

## The test gate is load-sensitive

The TypeScript suite has wall-clock assertions (spawn budgets, regex
deadlines, timing comparisons), and publish.py tolerates no test failure. On
a loaded machine they fail in ways that read like logic bugs: run the gate on
an otherwise idle machine, and before treating a failure as real, re-run the
failing file on its own.
