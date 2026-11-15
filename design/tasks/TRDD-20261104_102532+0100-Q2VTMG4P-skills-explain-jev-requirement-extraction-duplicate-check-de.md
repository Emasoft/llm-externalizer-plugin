---
trdd-id: Q2VTMG4P
title: Skills explain Jev requirement extraction, duplicate check, dedup and update detection
column: dev
status: tasked
created: 2026-11-04T10:25:32+0100
updated: 2026-11-14T17:14:53+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: docs
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-04T10:25:32+0100
implementation-commits: [49dfb148, bd670870, 23f40c1e, a7d71a9d, 5abf973a, 95f33824, b18f0d81, 7adfcc67]
---

# Skills explain Jev requirement extraction, duplicate check, dedup and update detection

## USER directive verbatim (2026-11-04, /goal)

"complete the TRDDs. make sure the jev functionalities are correctly explained in skills. for example jev should be able to pick explicit rules or requirements among multiple phrases and propositions in a prompt. it should also consider the context from previous messages to decide what is the actual requirement. it should also be able to compare one phrase to a list of requirements and determine if the requirement already exists even with different wording, to avoid duplicates. it should also let deduplicate any list of rules or requirements even if the rules are slightly different in wording. finally it should assess the similarity of a phrase or rule/requirement to existing rules/requirements from a file (i.e. prrd.m, trdds files, et.) to determine if the new rule is an updated version of one of the existing rules.
EXAMPLE:
#AUTOMATIC DETECTION AND EXTRACTION OF REQUIREMENT STATEMENTS OR UPDATES FROM THE USER PROMPT VIA A COMBINATION OF JEV AND OF A FREE LLM MODEL

STEP 1: EXTRACT REQUIREMENTS FROM PROMPT:
example of phrase with rules/requirements extracted by the llm or jev model from the prompt:  
  
- original prompt: "the colors are horrible. let's improve it a little. the loading screen background should be blue. change it and rebuild. then open the web site in chrome for me to see.". CONTEXT (previous prompts): "We implemented the loading screen, but we need to improve the style. Let me see how is it now."

- jev extracted extracted phrase: "the loading screen background should be blue":
  
STEP 2: CHECK IF THE RULE ALREADY EXISTS IN THE PRRD.MD. POSSIBLE OUTCOMES OF CHECKING WITH JEV:
1. example of duplicate: "make the background color of the loading dialog of a shade of blue"
2. example of a previous version: "the background of the load panel must not be transparent."
3. no results from jev found.

STEP 3 : CHANGES MADE TO PRRD.MD (llm reformulation, adding, update, merge, etc.):
 - case 1: no change, nothing written  
 - case 2: "the background of the load panel must not be transparent and it should be of color blue".  (previous version found by jev, the llm rewrite it to merge with the previous version)
 - case 3 (no preexisting version or duplicate found): "the loading screen background should be blue" (no reformulation)

Note that the form of the preexisting rule is always the one preserved when possible.
Be sure to write this down in the TRDD."

## Capabilities the skills must explain (from the directive)

- [x] C1 extract: pick the explicit rules or requirements among the phrases and propositions of a prompt (Jev or the free LLM, per STEP 1)
- [x] C2 context: use the previous messages to decide what the actual requirement is
- [x] C3 duplicate check: compare one phrase with a list of requirements and say whether it already exists in other words
- [x] C4 dedup: deduplicate a list of rules or requirements that differ only in wording
- [x] C5 update detection: compare a phrase with the rules in a file (PRRD.md, TRDD files) and say whether it is an updated version of one of them
- [x] the three-step pipeline above (Jev extract, Jev check against PRRD.md, free LLM writes: case 1 nothing, case 2 merge keeping the preexisting form, case 3 add as is) is written into the skills with this example
- [x] each capability maps to a real llm-ext command (or a gap card exists) and the skill text was verified by running it

## Next action

Audit which llm-ext commands (classify extract, compare, check, findings, llm sem-deduplicate, ...) and which skills cover C1 to C5; record the map and the gaps here.

## Approval log

- 2026-11-04T10:25:32+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-04T10:25:32+0100 — mandate: USER /goal of 2026-11-04, directive quoted verbatim below; card minted by main-agent@llm-externalizer-plugin to record it.
- 2026-11-04T10:27:09+0100 — column → dev by main-agent@llm-externalizer-plugin. audit of C1 to C5 started

## Scope

Out of scope here: the directive's 'complete the TRDDs' covers the whole board and is worked through the board, not this card. Missing command behaviour found for C1 to C5 (likely C2 context input, C5 update-vs-duplicate verdict) goes to separate feature cards; this card stays the skills card.

## STATE

2026-11-04: NEXT ACTION read the audit report under reports_dev/jev-capability-audit/ (read-only map of C1 to C5 to llm-ext commands and skills), then fix skill text where a command already does the job and mint a feature card per missing behaviour. Verbatim block byte-checked against the source text (4 trailing-space lines kept).
2026-11-04 audit map (read-only, help and source read, no live Jev run). C1 extract: no command; classify extract is a regex-candidate picker; workaround classify filter or label over one sentence per line; gap card TRDD-S5KOOT2S. C2 context: only a context string inside --input JSON of filter and label, no flag; gap card TRDD-WYY3SPDX. C3 duplicate check: classify find (json mode only through --input; the CLI path forces files mode, find.ts:126) or filter with a same-meaning question; no duplicate verdict. C4 dedup: llm sem-deduplicate (free/local/paid LLM, not Jev), llm cluster for large sets. C5 update detection: no command returns duplicate / updated version / new; gap card TRDD-LFTQCFUX. Pipeline: no skill shows it; step 3 is llm ask on a free profile, which writes a report and never edits PRRD.md. Skill text defects: classify.md:3 claims --estimate works for classify (CLI says not available yet); classify.md:23,401-427 document classify ping, which the installed binary rejects; session-and-llm.md:250 and tools/definitions.ts:1686 name cluster_synonyms (real: llm cluster); request JSON shapes are documented nowhere. NEXT: fix those skill defects, then write a requirements-pipeline reference with today's workarounds and the user's example, marking the steps that wait on S5KOOT2S, WYY3SPDX and LFTQCFUX.
2026-11-04 review of 38ee3682: C3 json mode of classify find is unverified by a run; every workaround recipe (C1 filter or label per sentence, C3 find, C5 label with duplicate / updated_version / new) is run once on the user's loading-screen example before its skill text ships; classify ping is unexplained, see the new ping card, so its docs stay until that is resolved; cluster_synonyms lives in code (tools/definitions.ts help plus a dist rebuild), and that file carries other sessions' uncommitted edits, so coordinate before changing it; a chain command for the 3-step pipeline is out of scope unless the owner asks. The gap cards are not npt or eht of this card: this card documents today's workarounds, and each gap card updates the reference when it ships.
2026-11-04: skill docs committed as 49dfb148 (classify.md classify requirements section with the known limitation and request JSON shapes, new references/requirements-pipeline.md, SKILL.md row and reference line, session-and-llm.md llm cluster). Every documented command ran once live (logs reports_dev/req-extract/20261104_125533+0100-phase3-docs.md and 20261104_130533+0100-doc-fixes.md). Caveats written into the doc: C4 runs on an LLM, not Jev; C5 from a file (extracting candidate rules from PRRD.md or TRDD files, more than 250 candidates) is a gap, card TRDD-PN7F00RF (TRDD-LFTQCFUX is the separate gap of a single duplicate / updated version / new verdict); the 1b and 2b reading rules are the doc’s own, not measured; step-3 cases 1 and 3 need no LLM call. Docs were verified on the dist rebuilt over another session’s uncommitted changes; re-check on a clean build before publish. Follow-up: requirements-pipeline.md line 80 says "the main agent", session jargon, to reword; four other reference files still say booleans take true/false, unverified outside classify.
2026-11-04T13:22:52+0100 the ticked C5 box covers comparing a phrase with an existing rule (doc step 2b); extracting candidate rules from a file (PRRD.md, TRDD files) is open on TRDD-PN7F00RF, shown in the doc as a gap.
2026-11-04T13:32:46+0100 classify requirements is in no tag yet (git tag --contains d362b340 empty, measured 2026-11-04) and the installed llm-ext 14.2.0 lacks it; do not move this card to complete while TRDD-S5KOOT2S is not complete.
2026-11-04T13:22:52+0100 SKILL.md's routing row (line 124) carries no release note because SKILL.md holds another session's uncommitted hunks; classify.md and requirements-pipeline.md carry the note.
2026-11-04T13:32:46+0100 NEXT ACTION: add the release note to the SKILL.md routing row (line 124) once SKILL.md no longer holds another session uncommitted hunks.
2026-11-04T17:45+0100 resumed after a session clear. Committed a7d71a9d: step 2 of requirements-pipeline.md says the top 3 of ranked go to 2b even when find answers absent, step 3 merges with the candidate labelled updated_version at confidence 0.6 or more (two or more: ask the user), --json on classify find and label needs a release that includes it, and the 2a reading is narrowed to these runs. Measured today: llm-ext 14.2.0 exits 1 with unknown option --json for classify find (also label and filter); a fresh build of commit 9e036052 (worktree with only dist modified; HEAD bad76674 changes nothing under scripts or skills) accepts --json and runs --estimate for filter, label and find (exit 0, nothing sent), but their --help does not list --estimate. Chain on that build: find on r2, u1, u2 absent, exists 0.14, r2 first at 0.97; label on r2 updated_version 0.89. Step 1a rerun on that build: requirements exactly s3; s2 instruction 0.13, a near tie (requirement 0.32, instruction 0.35) kept out only by the 0.6 gate. R1 review finding closed: grep of classify.md before line 416 for requirement or rule finds only lines 5 and 23, no filter recipe for requirements. The main-agent wording and the true/false boolean notes: grep finds none (a grep miss, not proof). Left as is, by decision: classify.md line 3 documents --json for every classify command with no 14.2.0 note, because skills ship with their own binary. Still blocked: the SKILL.md release-note row, because SKILL.md holds another session uncommitted hunks (git status 2026-11-04 17:35).
2026-11-04T17:42+0100 correction to the line dated 2026-11-04T17:45+0100 above (review of commit 4954dff6): that line was written at about 17:37, not 17:45. In the step 1a rerun s2 was kept out by its label (argmax instruction 0.35 against requirement 0.32), not by the 0.6 gate; the gate would also have excluded it at confidence 0.13; the label of s2 flips between runs (requirement in round 3), and only then does the gate decide. The SKILL.md git status was read at about 17:33. implementation-commits rebuilt from git log --grep=Q2VTMG4P -- skills/.
2026-11-04T22:15+0100 classify.md now marks ping as absent from 14.2.0, matching requirements (b18f0d81).
2026-11-13T22:25+0100 the 13:32:46 NEXT ACTION is done: commit 7adfcc67 adds '(needs a release that includes it)' to the classify requirements routing row of SKILL.md (line 124); SKILL.md no longer held another session's hunks (working tree clean). The card stays in dev: it cannot move to complete while TRDD-S5KOOT2S is not complete (13:32:46 line). Remaining owed items are the gap cards S5KOOT2S, WYY3SPDX, LFTQCFUX, PN7F00RF and a re-check of the docs on a clean build before publish.
- 2026-11-14: gap G1 (context input for classify) is covered by two cards. TRDD-WYY3SPDX covers classify label --context, shipped in 3d089c03. TRDD-7ZA3EE6Z covers classify filter and the decision on find and compare. G1 is closed only when both are.
