---
trdd-id: GNVIIMJP
title: Retro-card — argv-guard the statusline installers against side-effect probing
column: complete
created: 2026-08-18T20:00:41+0200
updated: 2026-08-18T20:00:41+0200
current-owner: llm-externalizer-claude
task-type: security
approval-tier: 0
release-via: publish
implementation-commits: [fce10d9]
---

# Retro-card: installer argv guards

Retroactive card (hub governance requirement, Phase-2 dispatch
2026-08-18): the fix landed before its card; this TRDD restores the
blame → commit → TRDD → finding chain.

## Audit finding cited

`reports/plugin-self-audit/DELEGATION.md` — CONFIRMED finding
"installer scripts are unsafe to probe": `scripts/statusline/install.sh`
and `scripts/install_statusline.py` had ZERO argv parsing; ANY
invocation — including `--help` or `--bogus` probes — ran the full
install and patched `~/.claude/settings.json` as a side effect.
(Also captured as LOCAL memory
`reference_installer_scripts_unsafe_to_probe`, 2026-08-18.)

## What shipped (fce10d9)

Both installers now refuse any argument before any side effect:
`--help`/`-h` prints usage and exits 0; any other argument errors with
exit 2. Bare invocation (the only form the slash command and
`check-statusline.py --fix` use) is unchanged.

## Verification performed

`bash -n` + `py_compile` clean; all four probe paths
(sh/py × `--help`/`--bogus`) left `~/.claude/settings.json` with an
unchanged SHA-256; exit codes 0/2 as specified.

## Notes and lessons learned

## Approval log

- 2026-08-18T20:00:41+0200 — COMPLETE (retro). Fix verified and
  committed as fce10d9; shipping in v13.5.6.
