---
trdd-id: OK1NN5RN
title: A repeated array flag keeps only its last value, so llm code silently reviews one file
column: published
status: archived
created: 2026-11-14T01:21:53+0100
updated: 2026-11-18T08:12:11+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-14T01:21:53+0100
implementation-commits: [dd6f5302, ff8b730c]
release-via: publish
---

# A repeated array flag keeps only its last value, so llm code silently reviews one file

2026-11-14T01:21+0100 Measured on the installed llm-ext 14.2.0 (free profile), shortly before the stamp: llm-ext llm code with --input_files_paths given seven times reviewed only the last file (one report, for install-decider-agent.sh), exit 0, no warning. The same flag given twice with --preview exits 1 with "preview: no input_files_paths or folder_path given". A JSON array value ('["a","b"]') previews both files, exit 0.

Cause, read in source at HEAD: scripts/llm-ext/src/cli/main.ts line 347 assigns out[key] = coerce(flag, raw, prop) on every occurrence, so a later occurrence overwrites an earlier one. The coerce doc comment at main.ts line 224 says arrays accept "the flag repeated", which the parse loop does not implement. Reproduced on the HEAD build (node scripts/llm-ext/dist/llm-ext.js, dist committed in dd283255): the flag twice with --preview exits 0 and lists only the last file, which the overwrite explains. The 14.2.0 "no input" preview message is inferred to be the separate dry-run bug fixed after 14.2.0 by TRDD-UVU9S4RV (a lone string value was counted as zero files; HEAD main.ts wraps it in an array before the preview resolver), not a second layer of this defect. Whether repeats were ever accumulated by an older parser is not checked.

Impact: a silent loss of inputs. A user or agent who repeats the flag gets a partial run that looks complete.

Acceptance:
- [x] a repeated array or oneOf flag accumulates every value, or the CLI refuses a repeat with an error naming the flag; the doc comment matches the chosen behaviour
- [x] a test runs the built CLI with --input_files_paths twice and asserts both files are used (or the refusal)
- [x] the doc comment, the CLI reference docs and the fix agree on whether repeats accumulate or are refused (the docs advertise repeats, so refusing is a behaviour change to state in the release note)

## Approval log

- 2026-11-14T01:21:53+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-14T03:07:00+0100 — column → ai_review. code committed dd6f5302 ff8b730c; post-commit review pending
- 2026-11-14T03:08:55+0100 — column → complete. ai_review: post-commit review of dd6f5302 and ff8b730c done; findings recorded in Notes; no code change required
- 2026-11-18T08:12:10+0100 — column → publish by main-agent@llm-externalizer-plugin. shipped: implementation lines present in the v14.7.0 tree (content check 2026-11-18; the SHAs are pre-squash, so not tag ancestors)
- 2026-11-18T08:12:11+0100 — PUBLISHED by main-agent@llm-externalizer-plugin. shipped: implementation lines present in the v14.7.0 tree (content check 2026-11-18; the SHAs are pre-squash, so not tag ancestors).

## Notes

2026-11-14T03:06+0100 dd6f5302 adds src/cli/estimate-positional-cli.test.ts to the explicit vitest include list (a gap since 510b8edd: npm test never ran the file). Not run in its own state: its 5 tests passed 5/5 on a HEAD build under a scratch config and 9/9 under the repo config only together with the fix.
2026-11-14T03:06+0100 ff8b730c: a repeated array/oneOf flag is concatenated one level, in order, duplicates kept (same as one JSON array). An earlier draft de-duplicated with a Set; dropped because duplicates carry meaning (GROUP markers via parseFileGroups, compare-files needs exactly two paths, mass-scout-build-fieldset duplicate-field error, instruction-file order; code readings, only the GROUP merged list is pinned by a test). Evidence reports_dev/ok1nn5rn/20261114_022700+0100-dedup-measure.md (gitignored).
2026-11-14T03:06+0100 Verified: build, tsc, eslint exit 0; test file 9/9 under the repo config on the final bytes; against a HEAD build the 4 new tests fail and the 5 older pass; dist byte-identical to a fresh build (sha256 2976abcd). Full npm test exit 0, 0 failures, on the state before the last corrections (equivalent inline, one dropped preview-count assertion, comments, doc wording).
2026-11-14T03:06+0100 User-visible effects for the release note (code readings): a file given twice is reviewed twice (paid duplicate) on code_task, chat, check_against_specs (batch_check, check_references, check_imports de-duplicate themselves); a repeated identical --field on mass-scout-build-fieldset now fails with duplicate field name; positional values precede flag values.
2026-11-14T03:06+0100 Owed at publish: replace 'releases that include TRDD-OK1NN5RN' in commands/llm-externalizer-search-existing-implementations.md with the release number; put the effects above in the release note.
2026-11-14T03:06+0100 Box 3: the doc comment, skills/llm-externalizer-{scan,free-scan}/references/usage-patterns.md:27 (a repeated flag is accepted) and the command doc agree that repeats accumulate; the cli-reference skill is silent on repeats, no conflict, no sentence owed.
2026-11-14T03:06+0100 Correction: reports_dev/ok1nn5rn/20261114_022829+0100-measure-revised.md says the parent held no written proposal; the proposal was in the parent response that spawned that checker, which a fork cannot see.
2026-11-14T03:06+0100 Scratch worktree /tmp/ok1nn5rn-head (a verification worker's, at ba056f25) is still registered: git_safety_guard gates worktree removal; not bypassed, left for the user.
2026-11-14T03:08+0100 Correction to the Verified note: for the committed GROUP test the failure against a HEAD build is inferred, not measured; control B ran its earlier version, which had an included: 6 assertion dropped later. The failures of the three repeat tests against HEAD are measured.
2026-11-14T03:08+0100 ff8b730c says the --file_pairs marker gap is tracked on its own card; that became true only when TRDD-41X8FKPI was minted after the commit (8f7c5b12).
2026-11-14T03:08+0100 ubs on ff8b730c: Critical 0; the 2 warnings are pre-existing and outside the changed lines 345-367: main.ts:201 then-without-catch and main.ts:842 type narrowing (blame 3e281b35, 2026-10-31). dd6f5302 was not scanned (its ubs pre-commit scan timed out at 180 s by itself); it is a 2-line config change.
2026-11-14T03:08+0100 target-release is not chosen (left unset).
2026-11-14T03:08+0100 README.md:569 also marks --source-files as repeated, consistent with accumulation (box 3).
2026-11-14T03:08+0100 Scratch worktree: the user can drop it with git -C <repo-root> worktree remove --force /tmp/ok1nn5rn-head ; no prune, about 30 other worktrees are prunable.
