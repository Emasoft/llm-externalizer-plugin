---
trdd-id: 4W3Q2B4S
title: llamaModelOnDisk misses a model in a snapshot subdirectory and trusts a cached file the online listing would not pick
column: complete
status: archived
created: 2026-11-18T06:08:16+0100
updated: 2026-11-18T07:16:00+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-18T06:08:16+0100
implementation-commits: [9f9e8c9a, e1f1fb47]
---

# llamaModelOnDisk misses a model in a snapshot subdirectory and trusts a cached file the online listing would not pick

Derived from TRDD-GNKO7WZS (archived), whose Notes list these two gaps as not closed by commit 8e093733.

1. Snapshot subdirectory. llamaModelOnDisk reads only the top level of the Hugging Face snapshot folder (readdirSync of the snapshot), so a repo that keeps its GGUF files in a subdirectory looks absent: a false "not ready", and the network give-up path treats a cached model as missing.
2. Online listing first match. llama.cpp (find_best_model at 8642541b2) picks the first file of the online repo listing that matches the quant. If the cache holds a different matching file than that first match, llama-server downloads the other one, so llm-ext reports ready for a model that still needs a download: a false "ready".

Fix: for 1, walk the snapshot recursively with the same file rules; for 2, decide which file llama.cpp would pick without a network call (or record that it cannot be decided offline) and test both cases in network-give-up.test.ts.

## Acceptance

- [x] A repo:quant whose GGUF sits in a snapshot subdirectory counts as on disk (test).
- [x] The second case is fixed with a test, or the card records why it cannot be decided offline.

## Approval log

- 2026-11-18T06:08:16+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-18T07:16:00+0100 — COMPLETE by main-agent@llm-externalizer-plugin. Both acceptance boxes ticked: subfolder walk in 9f9e8c9a, unreadable-folder rule in e1f1fb47, item 2 recorded as not decidable offline; the card went from todo straight to complete because the work was done and checked by the main agent in one session without the dev, testing and review columns.

## Notes

2026-11-18, item 1, commit 9f9e8c9a: llamaModelOnDisk walks the snapshot with a hand walk (snapshotRelativePaths in network-give-up.ts) that enters only real directories. readdirSync with the recursive option was rejected because Node follows directory symlinks with it. A directory symlink is listed and not entered, as llama.cpp get_cached_files does (hf-cache.cpp:428). Tests cover a subfolder, two levels deep, mmproj only, shards in one subfolder, a missing shard, shards in different subfolders, a blob symlink, and a directory symlink loop with and without a model.
2026-11-18, unreadable subfolder, commit e1f1fb47: 9f9e8c9a skipped a nested folder that could not be listed, so a readable GGUF beside it read as ready. Read in the llama.cpp 8642541b2 sources, not run: with the network down, common_models_handler_init (arg.cpp:404) calls common_download_get_hf_plan, which falls through to hf_cache::get_cached_files (download.cpp:795-801), which walks the snapshot with recursive_directory_iterator without skip_permission_denied (hf-cache.cpp:428); server_run (server.cpp:735; the catch applies for -hf with resolve_model, the default, line 739) catches the error at lines 741-748, logs failed to fetch model metadata and returns 1. So e1f1fb47 makes the whole model not ready and writes one stderr line naming the folder. Accepted cost: with the network up, llama-server lists the files online and never walks the cache, so this is a false not-ready in a partial outage, the safe side.
Not tested: ENOENT and EPERM on a nested folder, the rethrow of other error codes, and an error on the snapshot itself. They need a race or a mocked fs, and the project rule forbids mocks. The chmod cases are skipped on Windows and as root, the symlink cases on Windows. The Windows path with / separators was never run.
Item 2, decided: not decidable offline. llama.cpp find_best_model (download.cpp:740-776) takes the first file of the online listing that matches the quant. The listing comes from the Hugging Face tree API (hf-cache.cpp:302; llama.cpp does not sort it), so it exists only online (download.cpp:796). Two repos sampled with curl came back sorted by path; that order is observed, not documented. Bounded: when the network is down, get_repo_files returns an empty list and llama-server uses get_cached_files (download.cpp:798-800), the same file set the llm-ext walk lists; only a partial outage with Hugging Face reachable is exposed. Ids of the form org/repo/file.gguf already get --hf-file and an exact path check, so they are not exposed. TRDD-VFIWQ6A6 (backburner) tracks passing --offline on the fallback spawn.
The unreadable-folder stderr line can repeat, by reading the code: up to 2 lines per failed dispatch. TRDD-2WHKN3GZ (backburner) tracks it.
2026-11-18, corrections of the Notes above, by the main agent: (a) The line starting Not tested, and the message of commit e1f1fb47, give a wrong reason: the owner rule allows a test double when nothing else can produce a case. These paths need a faked fs, which was not written, so they stay untested. (b) The item 1 line omits one test: a GGUF behind a directory symlink is not on disk. (c) In the item 2 line, the network-down behaviour (get_repo_files returns an empty list, then get_cached_files, download.cpp:798-800) was read by a worker in copies of the 8642541b2 sources, not run. (d) In the unreadable subfolder line, the main agent confirmed by grep in the server.cpp copy that server_run starts at line 735 and calls common_models_handler_init at line 741; the rest of that chain was read by a worker, not run.
