---
trdd-id: EME7S0D3
title: Classify command that rates the safety risk of each option of a prompt
column: design
status: tasked
created: 2026-11-05T02:21:42+0100
updated: 2026-11-05T04:43:00+0100
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: user
mandate: true
mandated-by: user
approved: true
approval-judge: user
approval-datetime: 2026-11-05T02:21:42+0100
---

# Classify command that rates the safety risk of each option of a prompt

## Request (owner, verbatim, 2026-11-05)

- "are the new jev commands ready? if yes, add another command to use jev to pick the best option between the claude ask prompts or permission prompts, evaluating the risks of each choice and the better response, including yes, no, numbered choices, and cancel/skip."
- Answers to the four scope questions put to the owner on 2026-11-05 (question, then the answer verbatim):
  - Which surfaces should it have? "Advisory first (Recommended)" (that option read: "Step 1: a command that prints each option's risk and the recommended answer; nothing is answered automatically. Hooks come after it has been measured on real prompts." The owner then rejected the hook part: see the next answer and the rulings below.)
  - When the hook answers a prompt by itself, what may it decide without you? "who told you to add an hook? you must make the llm-ext cli able to offer this kind of command and safety judgement for every program or mod who can decide to use it. it must be flexible and usable in multiple circumstances. this must be focused on security and safety, so it must provide to jev also info on the current level of sandboxing, if the project was committed so any damage would be reversible, if there are backups, if the files are in a temp dir like tmp or cache, if the command is executed with admin privileges, if the command was executed repeatedly in the past, if the execution is in a worktree, in a feature branch, etc. it must provide context for the security assessment of the choices, so jev will take all that into considerstion when rating the choices. how such command will be used and by what program is not a concern of llm-externalizer. the same is true for all jev commands."
  - How should the prompt picker fit into the existing classify commands? "New command"
  - When should work on it start? "After current work (Recommended)" (that option read: card it now; build it after the WHY-comment pass on the five testing cards and the skills docs, TRDD-Q2VTMG4P).
- "this command is a more delicate one. its a decision on the safety of a choice. it require a carefully crafted prompt for jev."

## What the command is

- A new llm-ext classify command, separate from classify decide (owner: "New command"). Its job, in the owner's words: "pick the best option ... evaluating the risks of each choice and the better response", with the rating "focused on security and safety". Reading of the rulings below, not an owner quote: llm-ext provides the advisory command only; it prints a rating and answers no prompt itself, and what a caller does with the rating is the caller's concern.
- Input: one prompt of either kind the owner named, a question prompt or a permission prompt, as a program shows it: the question text, its options (yes, no, numbered choices, cancel or skip), and the action under decision (the command, tool call or target paths), with any warning the prompt itself shows (worked example 1 below). The owner wants it "flexible and usable in multiple circumstances", "for every program or mod who can decide to use it"; which program calls it, and how, is out of scope.
- Safety context: the command provides it to Jev (owner: "it must provide to jev also info on ..."), so the rating takes it into account. The owner list: the current level of sandboxing; whether the project is committed, so any damage is reversible; whether backups exist; whether the files are in a temp or cache dir; whether the command runs with admin privileges; whether the command was executed repeatedly in the past; whether the execution is in a worktree or a feature branch; "etc.". How each fact is obtained, detected by llm-ext or passed by the caller, is an open design question. Design requirement from the review of 2026-11-05, not an owner quote: the facts describe where the action will run, not the llm-ext process; in worked example 1 the prompt comes from a subagent whose session works in a different project directory.
- Output (design proposal, not an owner requirement): a risk rating per option, the recommended option, and the context facts the rating rested on.
- Skill: the command is explained in the llm-ext skills together with the other Jev commands (TRDD-Q2VTMG4P). Source: the session goal "make sure the jev functionalities are correctly explained in skills"; the owner allows only "llm-ext commands and skills".

## Owner rulings that bind

- No hook and no caller-specific adapter in llm-ext: "how such command will be used and by what program is not a concern of llm-externalizer. the same is true for all jev commands."
- Owner, verbatim, 2026-11-05 (sent while the card was being written): "i did not asked for any hook. you must only create llm-ext commands and skills."
- The owner called the command delicate and asked for a carefully crafted Jev prompt: "this command is a more delicate one. its a decision on the safety of a choice. it require a carefully crafted prompt for jev."
- Open consequence, NOT acted on: the planned caller-specific adapter cards TRDD-ZBMRKOI3 (C4-05 classify decide --hook, a Claude Code PreToolUse adapter) and TRDD-TIJ6EYK3 (DOC-07 hook-gate.md) may be out of scope under these rulings. Owner question.

## Jev prompt-design constraints (USER memory page jev-and-system-one-agents and its linked pages; atom id per bullet, "inferred" marks a step beyond the source)

- Inferred from ATOM-EVTV-EJ99 (an exact-text condition needs no model, grep is better): a fact code can establish (git state, branch, worktree, a path under a temp or cache dir, admin privileges, sandbox settings) is computed and stated as a fact, not asked of Jev.
- ATOM-A5UX-NNQR and ATOM-QSZR-DLP8: one state with many independent questions (an answer that depends on another is a second request, combined in code), and the state holds only what the decision needs, because accuracy falls as unrelated content grows. ATOM-958D-HQX9: one narrow condition per question, asked as "is this statement true of ...", never as "does it violate ...". ATOM-B4TB-H2S3: neighbouring context leaks into a judgement, and a condition that may not apply is asked as a precondition first.
- ATOM-4TDT-GWB9, measured on locating the line of a rule: a choice question always picks an option, so a yes or no comes first and the choice only on yes. Inferred from it for this command: the abstain outcomes (ask the person, facts missing) must be explicit options. ATOM-02E6-C6LE: a three-way choice separates "does not address" from "contradicts", which a yes or no cannot, but it was weaker on a fault by absence (for example a required item missing from the stated facts), and lesson [12] of the main page records that the three-way question failed to separate altered lines when a long line was judged against a long source (2026-10-10 shadow run).
- ATOM-8XYW-EYU0 and lesson ATOM-G4YA-I6SY: scores move between identical runs (median 0.03, at most 0.09 per clause, measured 2026-10-06), so no threshold is set before a labelled prompt set, repeats and a margin exist. ATOM-2Y93-6E5V: verdicts combine in code with three-valued logic.
- Not from the memory pages: the prompt text, its options and the action are untrusted input that can carry planted instructions; redaction and injection handling as for the other classify commands (classifiers plan, D5).
- None of these atoms was measured on rating the options of a prompt: they come from checking files and lines against rules or a source, so the labelled prompt set must test each transfer before it is relied on.

## Open design questions

- Which context facts llm-ext detects itself and which the caller passes in; how "executed repeatedly in the past" is measured (which history source); how the facts are tied to the place the action runs rather than to the llm-ext process.
- What "level of sandboxing" means and how it is detected.
- The output shape and exit codes; the labelled prompt set for calibration and how it is built.

## Ordering

Design starts after the current work: the WHY-comment pass on TRDD-BUL4EEBP, TRDD-XHHH0N1E, TRDD-LMSYDGVB, TRDD-DCI7C2Y7, TRDD-AQ82IO1T, and TRDD-Q2VTMG4P. Related: TRDD-ZB41KG62 (the classify command group), TRDD-ZBMRKOI3.

## Approval log

- 2026-11-05T02:21:42+0100 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Worked examples

- Example 1 (owner, 2026-11-05, "here is an example command that jev should be able to decide on"): a Bash permission prompt raised by a subagent, titled "Build mirror-form trees, mutants and cap twins", with the options 1. Yes and 2. No, Esc to cancel and Tab to amend, and this warning shown by the prompt itself: Dangerous rm operation on possibly-empty variable path: $W/$n in rm -rf $W/$n (rewrite it as "${W:?}"/"${n:?}" or use a literal path).
- The command, shortened, with the machine path and the project name removed: W=<project>/worker-tmp/<id>; a shell function M that runs node on probe/mutate.mjs with its arguments; for n over ten literal directory names: rm -rf $W/$n; /bin/cp -R $W/fixg $W/$n; then rm -rf $W/basecap; /bin/cp -R $W/base $W/basecap; then M calls that pass one TypeScript file in nine of the ten copies (fixm-nomirror stays a plain copy of fixg), plus two regular-expression fragments, to mutate.mjs (presumably a search and replace; the script is not shown), and a loop that counts the changed lines with diff. The verbatim prompt is kept outside git (gitignored reports_dev/prompt-safety/20261105_0235+0100-example-1-verbatim.md).
- Facts code can establish here, which the command must state to Jev: W is assigned a literal, non-empty path at the start of the same command and n runs over a literal list, so neither is empty when rm runs; every rm target lies under a folder named worker-tmp and is then re-created by copying fixg (basecap: from base), if that source exists: whatever the target held before is deleted; the command also runs node on probe/mutate.mjs, a script the prompt does not show. Not shown by the prompt, so they must come from the context: whether earlier runs of this same command produced the deleted folders (the owner's "executed repeatedly in the past"); whether fixg and base exist (the steps are joined by ;, so rm runs first and nothing checks that the copy succeeds); what mutate.mjs does; whether that folder is inside a git repository, committed or backed up; the privileges and sandbox of the session that runs it.
- The assistant's reading in this session (Claude, 2026-11-05), to be confirmed by the owner when the labelled set is built, not an owner statement: 1. Yes is low risk only if earlier runs of this command produced the deleted folders, fixg and base exist, and mutate.mjs edits only files inside the copies; 2. No and Esc are safe but block this step, and the subagent may carry on another way; if Tab is used to amend the command to "${W:?}"/"${n:?}", that removes only the empty-variable risk, which is absent here, and leaves the others.
- Example 2 (owner, 2026-11-05, "another example of a choice to make for jev:"): a Bash permission prompt raised by a subagent, titled "Run shell command", with the options 1. Yes and 2. No, Esc to cancel, Tab to amend, the hint ctrl+x ctrl+k twice to stop background agents, and this warning shown by the prompt itself: Dangerous rm operation not ruled out — the shell may read this command differently than it was parsed.
- The command, 52 lines, shortened, with the file name removed: S=$(cat <a file in /tmp>); fastedit create $S/bench.mjs --content '<51 lines of a JavaScript regular-expression benchmark>' && sysctl -n vm.loadavg && bun $S/bench.mjs cur grownb 32,64,96,128,256 && node $S/bench.mjs cur grownb 32,64,96,128,256. The JavaScript is passed inline as one single-quoted argument, and it holds single quotes, double quotes and backticks of its own (the first single quote inside it sits in a character class on the command's fifth line). The verbatim prompt is kept outside git (gitignored reports_dev/prompt-safety/20261105_0256+0100-example-2-full-verbatim.md).
- Facts code can establish here, which the command must state to Jev: the command runs no rm (the letters occur only inside other words, such as performance), so the warning concerns how the shell parses it, not a deletion; a shell parser rejects the command as shown: bash -n and zsh -n both stop with a syntax error near ) on its seventh line (checked 2026-11-05 on the text as displayed), because a single quote cannot appear inside a single-quoted argument, so the first one in the JavaScript ends the argument early; inferred from that check, not observed in a run: if the shell receives exactly this text, nothing runs and the step fails. If the command is amended so that it parses, it reads the target directory S from a file the prompt does not show (an empty S would put the file at /bench.mjs), writes the file, then times the benchmark under bun and under node on inputs of about 256 KB at most. Not shown by the prompt, so they must come from the context: whether the text shown is the text the shell receives (if not, the parse check must run on that text); what the /tmp file holds; the host load, since the benchmark adds CPU work; the privileges and sandbox of the session that runs it.
- The assistant's reading in this session (Claude, 2026-11-05), to be confirmed by the owner when the labelled set is built, not an owner statement: recommended: 2. No, or Tab to amend the command so that it parses (for example by escaping the inner single quotes, or by passing the file content through a file or standard input instead of an inline quoted argument). If the shell receives exactly the displayed text, 1. Yes does no harm but fails, so the step is lost rather than done; the prompt does not show whether it does, so the rating of 1. Yes stays open until that context fact is known. 2. No and Esc are safe and block this step; ctrl+x ctrl+k pressed twice stops the background agents (per the prompt's own hint), which affects more than this step. Unlike example 1, the warning names rm although the command runs none, so the rating must rest on the parsed command and the context facts, not on the warning text. An earlier assistant reading (2026-11-05) said the shell would run fragments of the JavaScript and rated 1. Yes high risk; the parse check above does not support that for the displayed text.
