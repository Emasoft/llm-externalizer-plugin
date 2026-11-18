---
trdd-id: SZ7TO9FW
title: Stable profile contract, user-owned keys separated from benchmark-managed internals, local fallback implicit in every profile
column: design
status: tasked
created: 2026-11-14T21:37:07+0100
updated: 2026-11-18T16:41:50+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-14T21:37:07+0100
eht: [0RRMPPAH, JC8KUOAL, ZKRYD13O, SZ4MQ6AC, STB8SUAQ, VCJBZYKR, 8NE9M8L6, LL1ULAHY, FSJW5KO8]
---

# Stable profile contract, user-owned keys separated from benchmark-managed internals, local fallback implicit in every profile

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-11-18

NEXT ACTION: child 1 (0RRMPPAH), wire resolveChain into the request paths. Shipped so far: verdicts.ts, resolve-chain.ts, route-for-tier.ts, production-verdicts.ts in c4dc6bd5 (14.3.0); no request path calls the chain yet. Children 3 to 7 change behaviour.

2026-11-14 USER (verbatim): "some projects like perch are lamenting that using llm-externalizer is difficult because it is a moving target and the settings yaml and the profiles are changing without logic, making their code failing every time a benchmark update the profiles. You should estabilish guidelines that define what is to use, what is fixed and constant and what is not fixed and should be considered as internal setting of llm-externalizer. also pinning the various profiles or customize them should be defined clearly as a procedure that can be used by all and that will not fail if the internal settings changes. Also the new fallbacks to local models, something we added recently, should be implicit in every profile, even those fixed written by the user or by other tools. the info on the configuration that will not change with the benchmarks must be defined and the tools or the user must know how to use only them and not count on the others config settings that can change at any time. make clear that almost all is managed automatically by the llm-ext internally, and very few options are configurable by the user or by the tools in ways that do not depend on changes/benchmarks. give the profiles a rigorous structure separating what changes and what doesn't. what can be configured by the users or other tools/agents and what is not to be used because is a moving target handled internally by llm-ext."

## Approval log

- 2026-11-14T21:37:07+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
2026-11-14 USER (verbatim, second directive on this card): "the priority of llm-externalizer is reliability and availability. So every profile must ensure a fallback. if its not defined in the profile, llm-ext will use the default ones. Every profile must ensure that the models are able to work with the commands, so all must pass the benchmarks. if not, the profile will fallback to models (remote or local) that pass the benchmarks. if a profile belong to the free template/category, then if there is no remote model that is free and that passes the benhmark, then it will fallback to local models that passes the benchmarks. and so on."
Design consequences to carry: (1) reliability and availability are the top priority; (2) every profile has a fallback chain, its own if defined, else the default chain; (3) a model is usable by a profile only if it passed the benchmark for the command kind; a pinned model that has not passed is skipped to benchmark-passing models, remote or local; (4) the category decides the chain order: free = passing free remote models, then passing local models; paid and the others 'and so on' (to design: paid = passing paid, then passing free?, then passing local).
2026-11-14 USER (verbatim, third directive on this card): "also remember that each profile must list the exact list of commands it is compatible with. if the user uses llm-ext with a command that is not supported by the profile specified in `--profile <profile name>` list of compatible commands, then the llm-ext must exit with error. this is one of the very few cases of something that has no fallback." Design consequence: every profile carries an explicit compatible-commands list; a command outside it, with that --profile, exits with an error and no fallback (today: per-action accepted profile TYPES via profileSelectionRefusal, profile-accept.ts:55-61, to be replaced or extended by the per-profile list).
2026-11-14T22:00:17+0100 Acceptance-case sourcing: the perch session reports no concrete breakage (history.log: 30 perch-cwd entries, all SUCCESS; perch code, CI and hooks never call llm-ext) and relays the owner's words to it, verbatim: "settings are supposed to be updated with the benchmarks findings. that is why the benchmarks are run in the first place. since mods and providers changes continuously, llm-externalizer monitors them and adjust the configuration accordingly to avoid the commands being broken by the changes." So the contract keeps benchmark-driven updates (they are the point) and only separates them from user/tool-owned keys. history.log records no FAILED lines at all (TRDD-3SNQAGIC trace: grep -c ' - FAILED - ' = 0 over the whole file), so it cannot supply failure cases; acceptance cases come from the directives themselves (a pinned model retired by its provider; a hand-written profile whose models stop passing; a benchmark rewrite during a consumer's run; a command outside the profile's list).
2026-11-14T22:15:10+0100 Spec draft committed 65d77720 (design/specs/profile-contract.md, 13 open questions). USER answer (AskUserQuestion, verbatim choice): paid chain = 'Paid, then free, then local (Recommended)' (Q1: pinned passing, then paid passing, then free remote passing, then local passing). The other three questions came back unanswered; AGENT decisions under the owner's no-blockers instruction, taking the recommendation: Q2 one-way rule ADOPTED (never local to remote, never free to paid unless the profile lists that tier); Q3 a pinned profile may use the passing pool of its OWN category only, then local; Q9 session summary order remote free first, local last. Q4-Q8 and Q10-Q13 also take the spec's recommendations unless the owner objects.

## Acceptance

- [ ] consumer-guidelines.md questions 1 and 5 rewritten in final form after this redesign (moved from TRDD-PEZ08FM4)

## Notes

2026-11-18T16:38:34+0100 absorbed 8HDAFJ3N: its acceptance (a retired pin is replaced by a passing model; a working pin is never replaced) is spec acceptance A1/A2.
2026-11-18T16:38:40+0100 main agent ruling (delegated by USER 2026-11-18, "solve all issues yourself. i need results."; not an owner answer): Q1 = paid, then free, then local (USER answer). Q2-Q13 take the spec recommendations in design/specs/profile-contract.md section 11, including Q9 remote free first with local last (secrets are now redacted, G49XPDNI published) and Q13 hold bounded by --command_timeout. Q12: until a paid high-quality ledger exists a paid id is `untested` for high_quality_scan (spec text). The USER may overrule any of them.
2026-11-18T16:41:50+0100 correction (main agent): Q9 is withdrawn from the ruling above and stays a USER question: Q9 (session summary order) stays a USER question, the same as TYHKAKCB D1: the owner text "Always use the locale inferencer" (#111) points to local first, and the USER permission of 2026-11-18 to send sessions to free models named the janitor secrets-shield, which the product does not use (it uses safeRedact, G49XPDNI line 46); the shipped order (remote free first, local last) stays until the USER answers.
