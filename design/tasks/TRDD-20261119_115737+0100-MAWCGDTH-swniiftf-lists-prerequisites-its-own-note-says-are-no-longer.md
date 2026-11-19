---
trdd-id: MAWCGDTH
title: SWNIIFTF lists prerequisites its own note says are no longer needed
column: blocked
status: tasked
created: 2026-11-19T11:57:37+0100
updated: 2026-11-19T12:57:16+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: infra
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-19T11:57:37+0100
blocked-by: [1OOAH3LD, ZGSGGHQG]
pre-block-column: todo
blocker-probe: 'grep -rqE ''^column: (complete|completed|published|live|superseded)$'' design/tasks design/archived --include=''*-1OOAH3LD-*'' && grep -rqE ''^column: (complete|completed|published|live|superseded)$'' design/tasks design/archived --include=''*-ZGSGGHQG-*'''
blocker-holds-if: exit-nonzero
---

# SWNIIFTF lists prerequisites its own note says are no longer needed

Archived TRDD-SWNIIFTF (column complete) keeps npt [1OOAH3LD, ZGSGGHQG], while its own note of 2026-11-14 says the broker cards "are no longer needed for this box" (box (c) was proven on the real governor queue in 164fa021). trddgrep validate therefore reports ERROR ORDER-NPT-VIOLATED on it. The terminal-freeze rule lets a complete card change only updated and superseded-by, so the stale npt cannot simply be cleared. Decide an allowed repair for a stale npt on a terminal card (a trddgrep fix rule, or a USER ruling), apply it to SWNIIFTF, and re-run validate.

## Approval log

- 2026-11-19T11:57:37+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-19T12:19:41+0100 — column → blocked by main-agent@llm-externalizer-plugin. blocked by 1OOAH3LD and ZGSGGHQG; see Notes 2026-11-19

## Notes

2026-11-19T12:17:22+0100 main agent ruling (delegated by USER 2026-11-18, "solve all issues yourself. i need results."; not an owner answer): the 3-pillars session (owner of trddgrep) answered on 2026-11-19: no trddgrep fix rule and no validate exemption keyed on a prose note; decide per NPT card. If 1OOAH3LD and ZGSGGHQG had no work of their own they would move to superseded (cancelled is not in TERMINAL_DONE and would keep the error); if they carry live work, the error stays until they close, and 3-pillars opens its own card for a structured way for a terminal card to retire an npt entry. The read-only audit reports/card-audit/20261119_121220+0100-local-model-cards.md finds that both cards carry live work (calibration of the models that lack a record, the per-command matrix, and smaller items), so neither may be superseded. Decision: leave the ORDER-NPT-VIOLATED error on SWNIIFTF until 1OOAH3LD and ZGSGGHQG are terminal or the 3-pillars mechanism lands; this card is blocked by the two NPT cards.
2026-11-19T12:33:07+0100 main agent: the 3-pillars session opened TRDD-3ADY4QB5 in its own repository (committed 11599ee, column todo): a structured way for a terminal card to retire an npt entry. This card unblocks when 1OOAH3LD and ZGSGGHQG are both terminal, or when 3ADY4QB5 ships and is applied to SWNIIFTF; the blocker probe tracks only the first way, because blocked-by cannot name a card in another repository.
2026-11-19T12:37:49+0100 cheap-worker (fix2 review), corrected by the main agent at 2026-11-19T12:47:26+0100 before commit: blocker-probe runs with the working directory set to the root of the checkout that holds design/. Measured 2026-11-19: run there, it exits 1 while either NPT card is open; on a private fixture with both cards complete it exits 0, with one card todo it exits 1; from a directory without design/ grep exits 2. No automatic consumer exists: the trdd doctor states in its own message that it never executes a probe (ai-maestro lib/trdd-doctor.ts, the BLOCKED-WITHOUT-PROBE rule), and no Python script of the installed janitor (3.9.8) reads blocker-probe or blocker-holds-if (grep, 2026-11-19). The probe is an agent-runnable recipe; blocked-by is what trddgrep validate judges. Its exit code fails closed: run from the wrong directory it gives exit 2, read as held, never a release. Decision: keep this form, which matches TN8OUZ50 and BYHR8EGG.
2026-11-19T12:56:47+0100 main agent: the --include globs of blocker-probe are now quoted, because zsh aborts an unmatched glob ("no matches found", exit 1) before grep runs, which would read as held forever. Measured 2026-11-19 with the quoted form: from the checkout root it exits 1 under sh, bash and zsh while both NPT cards are open; on a private fixture with both cards complete it exits 0 under sh and zsh, and with one card todo it exits 1.
