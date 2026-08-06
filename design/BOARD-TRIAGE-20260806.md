# Board triage — 2026-08-06

Who: session triage (llm-externalizer-plugin).
Method: verified every card against the v11.1.0 tree rather than its own prose; evidence in
`reports/trdd-triage/` which is gitignored.
Totals: 26 complete / 2 superseded / 1 cancelled / 4 open + 1 new card.

## Ledger

| id8 | old state | new column | reason |
|---|---|---|---|
| 220ea89f | status: completed | complete | cluster_synonyms MCP primitive shipped |
| 5bd98017 | status: completed | complete | security_scan MCP tool shipped |
| 44256ba2 | status: in-progress | complete | global usage history log shipped |
| 973a0265 | status: completed | complete | security-triage model benchmark shipped |
| 6e859d3c | status: completed | complete | Part-D script-bug remediation shipped |
| 66da2aa7 | status: completed | complete | cluster_synonyms resume/perf fix shipped |
| e82f2c49 | status: completed | complete | test cost-safety gate shipped |
| ec45c66f | status: completed | complete | reasoning cost regression fix shipped |
| 8b6b3646 | status: completed | complete | free-only benchmarked ensemble shipped |
| 97ef8b63 | status: completed | complete | free_only airtight enforcement shipped |
| f1510055 | status: in-progress | complete | free-pool auto-benchmark surface shipped |
| 542bdbef | status: completed | complete | auto-free-on-low-balance shipped |
| 54f508a4 | status: completed | complete | externalizer usability fixes shipped |
| 1c973104 | status: completed | complete | dogfood-test skill shipped |
| 1e2b87cb | status: completed | complete | Codex integration removed |
| ad8ce78f | column: complete | complete | dependency security sweep — already complete, timestamp refresh only |
| DBUSM55E | column: complete | complete | high_quality_scan tool — already complete, timestamp refresh only |
| WJND1N2W | column: dev | complete | OpenRouter rescan filters shipped |
| 3JQVBO7M | column: complete | complete | layered rules engine — already complete, timestamp refresh only |
| MNK2YNH0 | column: complete | complete | diff-mode review — already complete, timestamp refresh only |
| SCLGL8T4 | column: complete | complete | --preview dry-run selection — already complete, timestamp refresh only |
| SNAEERHU | column: complete | complete | review-plan delegate mode — already complete, timestamp refresh only |
| 3ef94759 | no frontmatter | complete | setup wizard Tier 2/3 fixes shipped in v9.7.0 |
| 480419e5 | no frontmatter | complete | full-plugin audit Tier 2/3 follow-up shipped |
| 52547970 | no frontmatter | complete | mass-scouting tool shipped |
| 65867b68 | no frontmatter | complete | local-backend expansion shipped |
| a24b213c | status: in-progress | superseded | superseded by the MCP→CLI migration (d557c68) |
| 8de4e9f2 | status: superseded | superseded | superseded by TRDD-1e2b87cb (Codex integration removed) |
| 807c1e2d | no frontmatter | cancelled | Codex/GPT-5.5 scan integration cancelled — whole Codex feature removed by TRDD-1e2b87cb |
| 63314265 | column: dispatch | todo (stays open) | index.ts split plan — target file path updated for v11.0.0 CLI migration |
| 8d8d33c8 | status: not-started | todo (stays open) | verified 2026-08-06 still open — cli.js still misses auto-free path |
| f45eeaa0 | status: in-progress | backburner (stays open) | framework shipped; residue is the A6 benchmark-dataset tail |
| 828238b5 | status: in-progress | backburner (stays open) | A1-A7 + Parts B-E landed; residue is A6 tail + deferred test coverage |
| K3PW7Q2M | new | todo (new card) | verified gap: `llm-ext` CLI catalog has no `profile` command |
