---
trdd-id: J6O3YJC0
title: File ids use backslashes on Windows while tests split on a slash
column: todo
status: tasked
created: 2026-11-18T16:54:14+0100
updated: 2026-11-20T00:28:29+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-18T16:54:14+0100
parent-trdd: 61EINA10
---

# File ids use backslashes on Windows while tests split on a slash

Child of TRDD-61EINA10 (parent link only, on purpose). Source: reports_dev/windows-ci-triage/20261118_143238+0100-report-v3.md (sections 2 and 6), Windows CI run 44305836777 (v14.7.2: 195 failed of 6574 tests in 42 of 353 files). Windows stays experimental (README.md:15, 16719d1d).
Groups: G5. Failures: 15. Marks of the report: a first error line is seen in the log; a cause marked with a question mark is unverified.
Cause lines of the report group table (verbatim):
- G5 (15 failures; log lines of run 44305836777: input-args 5910, 5935, 5956, 5979, 6049, 6078, 6126 (7); inputs walking 7104, 7129, 7152, 7173, 7194, 7215, 7236, 7257 (8); mark ✓ 4 rows; ? 11 rows): Every first error is a deep-equal list mismatch (checked row by row). 5910 received k\.gitignore, k\a.txt, expected .gitignore, a.txt ✓; 5935, 5979 same shape ✓. 7173 received "D:\\tmp\\llm-ext-inputs-6Kqv4d\\real.txt", expected "real.txt" ✓; the test splits ids on "/" only (inputs.test.ts:167 code ✓). The other 11 rows: same shape, lists truncated by vitest (?).
Failing tests (group, log line, file, test name, first error line; log order):
- G5 log 5910 src/classifiers/input-args.test.ts :: assembleFileInput over real files > a directory in a real git repo: tracked and untracked files, not the ignored one (E119); ids are paths; positionals fill the spec fields :: AssertionError: expected [ 'k\.gitignore', 'k\a.txt', …(1) ] to deeply equal [ '.gitignore', 'a.txt', 'sub/b.txt' ]
- G5 log 5935 src/classifiers/input-args.test.ts :: assembleFileInput over real files > outside git a walk skips build and dot directories (E120); a secret found while walking is listed as skipped :: AssertionError: expected [ 'k\keep.txt' ] to deeply equal [ 'keep.txt' ]
- G5 log 5956 src/classifiers/input-args.test.ts :: assembleFileInput over real files > --lines gives ids name:N; --ext, --limit and --max-bytes reach collectInputs :: AssertionError: expected [ …(2) ] to deeply equal [ …(2) ]
- G5 log 5979 src/classifiers/input-args.test.ts :: assembleFileInput over real files > a glob works; below Node 22 it is refused with `pass a directory instead` (E121) :: AssertionError: expected [ 'k\g1.txt', 'k\g2.txt' ] to deeply equal [ 'g1.txt', 'g2.txt' ]
- G5 log 6049 src/classifiers/input-args.test.ts :: rank --head and --all as spec flags (IN-03) > --head N sends only the first N bytes of a longer file and the whole shorter one :: AssertionError: expected [ [ …(2) ], [ …(2) ] ] to deeply equal [ [ …(2) ], [ …(2) ] ]
- G5 log 6078 src/classifiers/input-args.test.ts :: rank --head and --all as spec flags (IN-03) > parser: in `--head 1500 file.txt` the 1500 is the flag value, not an input path, and the file after it is still an input :: AssertionError: expected [ Array(1) ] to deeply equal [ Array(1) ]
- G5 log 6126 src/classifiers/input-args.test.ts :: label --labels / --labels-json and file inputs (IN-02) > classify label --labels a,b <files> runs end to end through runDecisionArgv: items from collectInputs, one text unit per file, rows keyed by path :: AssertionError: expected [ [ …(2) ], [ …(2) ] ] to deeply equal [ [ …(2) ], [ …(2) ] ]
- G5 log 7104 src/classifiers/l2/inputs.test.ts :: collectInputs walking > E119: inside a git repo it lists git ls-files -co --exclude-standard :: AssertionError: expected [ …(3) ] to deeply equal [ '.gitignore', 'kept.txt', 'x.js' ]
- G5 log 7129 src/classifiers/l2/inputs.test.ts :: collectInputs walking > E120: outside git it skips build and dependency dirs and dot-directories but keeps dot-files :: AssertionError: expected [ …(2) ] to deeply equal [ '.eslintrc', 'a.ts' ]
- G5 log 7152 src/classifiers/l2/inputs.test.ts :: collectInputs walking > a glob expands to its files on Node 22+ :: AssertionError: expected [ Array(1) ] to deeply equal [ 'a.txt' ]
- G5 log 7173 src/classifiers/l2/inputs.test.ts :: collectInputs walking > E122: a symlink is skipped and listed unless --follow-symlinks :: AssertionError: expected [ Array(1) ] to deeply equal [ 'real.txt' ]
- G5 log 7194 src/classifiers/l2/inputs.test.ts :: collectInputs walking > E122: when followed, the target is secret-checked and a directory loop terminates :: AssertionError: expected [ Array(1) ] to deeply equal [ 'a.txt' ]
- G5 log 7215 src/classifiers/l2/inputs.test.ts :: collectInputs walking > E124/E36: a secret found while walking is skipped and listed :: AssertionError: expected [ Array(1) ] to deeply equal [ 'a.txt' ]
- G5 log 7236 src/classifiers/l2/inputs.test.ts :: collectInputs walking > E123/E33: lock, minified, source-map, empty and binary files are skipped and listed :: AssertionError: expected [ Array(1) ] to deeply equal [ 'a.txt' ]
- G5 log 7257 src/classifiers/l2/inputs.test.ts :: collectInputs walking > E125: a walked file over --max-bytes is skipped and listed :: AssertionError: expected [ Array(1) ] to deeply equal [ 'small.txt' ]

## Approval log

- 2026-11-18T16:54:14+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-20T00:28:29+0100 — column → todo by main-agent@llm-externalizer-plugin.
