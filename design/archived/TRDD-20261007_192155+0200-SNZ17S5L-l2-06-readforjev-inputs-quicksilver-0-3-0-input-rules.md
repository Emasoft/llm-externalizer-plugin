---
trdd-id: SNZ17S5L
title: L2-06 readForJev inputs (quicksilver 0.3.0 input rules)
column: complete
status: archived
created: 2026-10-07T19:21:55+0200
updated: 2026-10-09T22:36:05+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T19:21:55+0200
implementation-commits: [440fbaec]
---

# L2-06 readForJev inputs (quicksilver 0.3.0 input rules)

## Goal
`readForJev` and the input rules: JSON and file modes, git-aware walk, globs, stdin, `--items`, `--lines`, `--ext`, deny list, symlinks, skips, caps and encoding.

## Approval log

- 2026-10-07T19:21:55+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-09T22:17:08+0200 — column → todo by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan
- 2026-10-09T22:17:08+0200 — column → dev by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan
- 2026-10-09T22:36:05+0200 — COMPLETE by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan.

## Plan refs

§3 (`readForJev` signature), §4 (secret-path deny list; input walk rules), §2b (UditAkhourii/quicksilver, buchmark/claude-jev), D28, D31; E33, E35, E36, E38, E39, E40, E41, E119, E120, E121, E122, E123, E124, E125, E126, E127. Study report: `reports/jev-classifiers/`.

## Depends on

none

## Files

- `scripts/llm-ext/src/classifiers/l2/inputs.ts`
- `scripts/llm-ext/src/classifiers/l2/inputs.test.ts`
- `scripts/llm-ext/vitest.config.ts`

## Reuse

`sanitizeInputPath` (`src/scan-pipeline.ts:193`); quicksilver 0.3.0 `SECRET_RE` (qs I:27) merged with the claude-jev list; quicksilver 0.3.0 walk rules (qs I:640-783).

## Steps

1. Implement `readForJev(path, mode)` with the four modes of §3: whole, head, lines, window.
2. Secret-path deny list: quicksilver `SECRET_RE` merged with the claude-jev list, owned only by this file (§4).
3. Walk: inside a git repo list with `git ls-files -co --exclude-standard`; outside git skip build and dependency directories and dot-directories, keep dot-files (E119, E120).
4. Glob input: refuse on Node below 22 with "pass a directory instead" (E121).
5. Symlinks are skipped and listed unless `--follow-symlinks`; when followed, check the target against the deny list and catch loops (E122).
6. Skip and list lock, minified, source-map and empty files in the receipt (E123).
7. Named secret file: refused with exit 1; found while walking: skipped and listed (E124, E36).
8. Binary file (NUL byte in the first 8 KB): refused when named, skipped and listed when walked (E33).
9. Size limits: 100 MB hard cap and `--max-bytes` (E125); `--limit` of 5000 items refused before any request (E126).
10. `--items` input: a line starting `{` that is not valid JSON is refused naming the line (E127).
11. A directory given to a flag that takes one file is refused (E41).
12. Encoding: CRLF and BOM handled so line windows are correct and the BOM stripped (E38); invalid UTF-8 replaced with U+FFFD plus a warning (E39); empty file as in E40.
13. Path traversal or symlink leaving the allowed roots: `sanitizeInputPath` refusal (E35).

## Acceptance

- [x] JSON mode and file mode
- [x] git-aware walk, globs, stdin, `--items`, `--lines`, `--ext`
- [x] deny list, symlinks, binary, lock, minified and empty skips
- [x] 100 MB cap, `--max-bytes`, `--limit`, encoding
- [x] E33: Binary file (NUL byte in the first 8 KB) → named single input (`--state @f`, `--items`, spec file, stdin): refused; found while walking: skipped and listed
- [x] E35: Path traversal / symlink leaving the allowed roots → `sanitizeInputPath` refusal
- [x] E36: `.env`, `id_rsa`, `*.pem`, credentials paths → named single input: refused (E124); found while walking: skipped and listed
- [x] E38: CRLF and BOM files → line windows correct, BOM stripped
- [x] E39: Invalid UTF-8 → U+FFFD replacement + warning
- [x] E40: Empty file → named single input: refused ("empty input"); found while walking: skipped and listed (E123)
- [x] E41: Directory given to a flag that takes one file (`--state @f`, `--items`, `--labels-json @f`, spec file) → refused
- [x] E119: directory inside a git repo → `git ls-files -co --exclude-standard` listing; an empty listing sends nothing
- [x] E120: directory outside git → walk skips build/dependency dirs and dot-directories, keeps dot-files
- [x] E121: glob on Node < 22 → refused with "pass a directory instead"
- [x] E122: symlink in the input → skipped and listed unless `--follow-symlinks`; when followed, the target is secret-checked and loops are caught
- [x] E123: lock, minified, source-map or empty file → skipped and listed in the receipt (qs skips them silently; we list them, fail-loud)
- [x] E124: named secret file (`--items`, `--state @f`, spec file) → refused, exit 1; a secret found while walking is skipped and listed
- [x] E125: file over the 100 MB hard cap or `--max-bytes` → skipped and listed; stdin or a named file over it refused
- [x] E126: more items than `--limit` (5000) → refused before any request
- [x] E127: `--items` line starting `{` that is not valid JSON → refused naming the line
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules
IN PROGRESS 2026-10-09: implemented, NOT committed (src/classifiers/l2/inputs.ts + test, 31 tests). Review docs_dev/20261009-L2-06-review.md: 17 of 21 boxes; HIGH F1 glob specs bypass sanitizeInputPath (E35); MEDIUM F2 claude-jev deny names not merged, F3 a failed git ls-files silently falls back to a walk that ignores .gitignore; LOW F4-F10. Fix worker dispatched.
RESULT 2026-10-09: committed 440fbaec — src/classifiers/l2/inputs.ts + test, 41 tests; review docs_dev/20261009-L2-06-review.md, fixes docs_dev/20261009-L2-06-fixes-report.md. F1-F7 and F9 fixed (9 of 10 new tests shown failing first); F2 deny list merged from claude-jev (MIT, commit 06fe407, NOTICE entry). Left as is: F8 (the node-version test seam is the only way to test E121 on a current Node), F10 (the incremental stdin cap belongs to the command card that reads stdin). The FIFO test (F6) cannot fail without the fix, the read blocks the worker; the F9 git-listing test is a regression guard only. Box 1 'JSON mode' is read as the --items object input; the card does not define it further. Whole package after the wave: tsc 0, eslint . --quiet 0, npm test 206 files passed / 4 skipped, 3311 tests passed / 5 skipped / 0 failed, build 0 (docs_dev/20261009-classifiers-wave3-integration.md).

## Out of scope

Content secret redaction (L2-07), `rank --head` windows (SP-07), text chunking (L2-19).
