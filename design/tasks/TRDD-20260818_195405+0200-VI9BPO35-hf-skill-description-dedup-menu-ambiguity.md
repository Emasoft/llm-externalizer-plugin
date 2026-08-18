---
trdd-id: VI9BPO35
title: Disambiguate the 4 HF skill descriptions colliding with huggingface-skills plugin
column: planned
created: 2026-08-18T19:54:05+0200
updated: 2026-08-18T19:54:05+0200
current-owner: llm-externalizer-claude
task-type: docs
approval-tier: 0
---

# HF skill description dedup (menu ambiguity)

## WHY

This plugin bundles `hf-cli`, `huggingface-best`,
`huggingface-community-evals`, `huggingface-local-models` under names
identical to the standalone `huggingface-skills` plugin's copies. When
both plugins are installed, skill menus and the Skill tool listing show
duplicate rows whose descriptions do not say which plugin owns them or
why the bundled copy exists — agents pick one at random. Hub Phase-1
closed its half after the resolver measurement (directory-scoped
resolution works); the remaining fix — self-describing descriptions on
OUR copies — is this repo's card (hub dispatch 2026-08-18).

## Constraint (USER-set, from the audit)

**Do NOT rename the 4 colliding skills.** Names are load-bearing
(cross-references, muscle memory, the resolver's scoping). Fix the
DESCRIPTIONS only.

## Scope

- Each of the 4 bundled skills' frontmatter `description:` gains a
  leading disambiguator naming this plugin and its specialization (e.g.
  tuned for llm-externalizer local-model setup), so a menu row is
  self-identifying next to the huggingface-skills twin.
- Verify the bundled copies actually DIFFER from upstream before
  claiming a specialization; where a copy is identical, say "bundled
  for offline availability" instead — no invented differences.
- Sweep cross-references (`grep -rn` over rules/skills/commands/README)
  to confirm no text depends on the old description wording.

## Acceptance

- [ ] All 4 descriptions self-identify plugin + purpose in the first
      clause; names unchanged.
- [ ] CPV validate clean on the plugin after the edit.

## Notes and lessons learned

## Approval log
