---
trdd-id: PQW0XDS1
title: Remove the CPV integrity bypass and move the pin when upstream ships a wheel-scoped manifest
column: backburner
status: tasked
created: 2026-10-21T04:46:00+0200
updated: 2026-10-21T06:16:47+0200
current-owner: main-agent@llm-externalizer
created-by: main-agent@llm-externalizer
task-type: infra
min-approval-requirement: none
assignee: main-agent@llm-externalizer
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer
approval-datetime: 2026-10-21T04:46:00+0200
---

# Remove the CPV integrity bypass and move the pin when upstream ships a wheel-scoped manifest

THE DEBT (2026-10-21). Two disables are in force, both landing with the 14.1.0 release: (1) PLUGIN_SKIP_GITHUB_INTEGRITY=1 is set on the two local CPV invocations in scripts/publish.py (the text run and the --json run), via run()'s optional keyword-only env; (2) BOTH gates — scripts/publish.py's local gate and the two uvx invocations in .github/workflows/release.yml — are PINNED to the COMMIT SHA d5d6149735c4f0055bb3b83a56b28036079682ad (CPV v5.22.0's release commit), NOT to the tag v5.22.0. WHY A SHA AND NOT A TAG: a tag is MOVABLE, and the check this debt disables — CPV's GitHub-anchored integrity self-check, which compares the INSTALLED tree against the manifest published for the tag being installed — is exactly what would detect a moved tag. Pinning the SHA fixes the transport's provenance by the ref itself, so the moved-tag exposure the disabled check would have covered is closed by the pin rather than by the check. RESIDUAL EXPOSURE that remains: the local uv cache could be tampered with. The SHA must be updated by hand whenever the pin moves. THE SHA IS NOT A NICETY — IT IS THE ONLY REASON THE PIN IS SOUND: THE TAG DOES NOT NAME ONE FIXED TREE. Observed upstream (verified with gh api and git ls-remote, 2026-10-21): the v5.22.0 tag is an annotated tag (object c960a97b81e49c5cb4c0a5ef86b3e440b7729539) that CURRENTLY resolves to d5d6149735c4f0055bb3b83a56b28036079682ad, while a different commit 77b3762f0691a4d97d6f31226366a992f5dab439 carries the same 'chore(release): v5.22.0' message and the same author date, the two being 1950 commits and 300 files apart — so two distinct commits answer to the same release name, and the tag's target is not a stable identifier for one tree. This card asserts that OBSERVATION and the conclusion that follows from it; it does not assert a witnessed history of the tag being moved. A tag pin therefore cannot be relied on to mean one tree, which is what a release gate needs; the commit SHA is what makes the pin unambiguous. The same conclusion is measured under the transport the pipeline actually uses: under uvx the SHA-pinned install records commit_id AND requested_revision both equal to the pinned SHA, while this machine's uv cache holds SEVEN entries whose requested_revision is the TAG 'v5.22.0' and whose commit_id is 77b3762f0691a4d97d6f31226366a992f5dab439, plus one tag entry that resolved to d5d61497 — i.e. the TAG resolved to BOTH commits at different times, while the SHA resolved to exactly one. (Measured 2026-10-21, fresh uv cache: the SHA-pinned install's direct_url.json reads commit_id = requested_revision = the pinned SHA; a fresh-cache uvx install of the TAG read commit_id d5d61497 with requested_revision 'v5.22.0'.) (Verified with gh api and reproduced by a fresh install whose dist-info direct_url.json records both requested_revision and commit_id equal to the pinned SHA — so the transport resolves the SHA as that commit, not as a branch tip.)
WHY THE BYPASS IS THERE. The uvx --from git+... transport can never satisfy CPV's whole-repo integrity manifest: the manifest lists 1123 repo-root entries that a wheel cannot contain (pyproject declares packages = ['scripts'] and force-includes only .markdownlint.json and .markdownlintignore), and the install's site-packages neighbours are counted as injected files. No tag of any vintage passes the uvx transport. Without the bypass the validator sys.exit(2)s BEFORE its first phase, producing NO findings and NO --json output, so the gate cannot produce a verdict at all. The check verifies CPV's OWN validator tree against CPV's OWN manifest — no call site ever passes this plugin's root, so no check of OUR bytes is skipped; none existed.
THE ONE REMOVAL TRIGGER. Upstream ships a transport-correct, WHEEL-SCOPED integrity manifest — upstream Emasoft/claude-plugins-validation#243, fix proposed in #256. That is the only trigger. (Upstream #237's fix is in NO released tag as of 2026-10-21, so the pin delays it but does not forgo it.)
THE ORDER OF OPERATIONS — remove the bypass FIRST, then move the pin. 'Move the pin' means UPDATE THE COMMIT SHA to the new release commit (the pin stays a SHA — a tag is movable). Moving the pin first would make the gate abort again with no verdict: the new ref would still be a whole-repo manifest, the integrity check would still exit(2) before its first phase, and the release would have no gate at all. The bypass removal is what makes the new ref usable; the pin move is what lets the new validator's fixes reach the gate.
RELATED. The debt was introduced by TRDD-FCWL7PXZ (the 14.1.0 release card, which carries the decision, the measurements and the provenance, INCLUDING the command lines that reproduce the measured mismatch totals — that card is the place to look for them, so they are not duplicated here); the upstream research report — gitignored and private — is reports/cpv-upstream/20261021_033740+0200-cpv-upstream-integrity-and-pin-target.md, and it records the command line to re-run each measurement.

## Approval log

- 2026-10-21T04:46:00+0200 — MANDATE issued by main-agent@llm-externalizer (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
