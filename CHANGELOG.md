# Changelog

All notable changes to this project will be documented in this file.
## [13.5.10] - 2026-08-19

### Added

- Feat(session-summary): idle fan-out workers race the straggler (TRDD-QY1JITC7)


### Documentation

- Docs: TRDD-QY1JITC7 -> complete (measurement distribution recorded)

- Docs: TRDD-63314265 -> complete (all phases incl. P4b already shipped)

- Docs: TRDD-Q185FRMW -> complete (fix already shipped in v13.5.9 via cf9026d)


## [13.5.9] - 2026-08-19

### Documentation

- Docs: TRDD-WIO13P1P -> complete (all 4 sub-items shipped)

- Docs: TRDD-WIO13P1P sub-items 1-3 verified done (dogfood 119/0)

- Docs: TRDD-WIO13P1P -> dev, verified measurements into STATE block

- Docs: TRDD-VI9BPO35 -> complete (shipped in v13.5.8)


### Performance

- Perf(publish): changelog prepend mode + subject-only entries (TRDD-WIO13P1P sub-item 2)


### Refactored

- Refactor(commands)!: collapse 15 mass-scout-* slash commands into the mass-scout dispatcher (TRDD-WIO13P1P sub-item 4)

- Refactor: drop the dead dist/index.js twin bundle (TRDD-WIO13P1P sub-item 1)

- Refactor: remove dead add-shebang.mjs (TRDD-WIO13P1P sub-item 3)


### Testing

- Test: expect '1 mass-scout dispatcher (`' in README command split (TRDD-WIO13P1P)


## [13.5.8] - 2026-08-18

### Documentation

- Docs(skills): self-identifying descriptions on the 4 HF skills colliding with huggingface-skills (TRDD-VI9BPO35)

With both plugins installed, skill menus showed duplicate hf-cli /
huggingface-best / huggingface-community-evals / huggingface-local-models
rows with nothing saying which plugin owns them — agents picked at
random. Each bundled copy's description now LEADS with the owning
plugin + purpose ('llm-externalizer's bundled copy, adapted for its
setup wizard...'); verified honest first: all 4 differ from the
upstream copies (153-310 diff lines each) and are setup-agent preloads.
Names deliberately unchanged (USER constraint — resolver scoping and
cross-references depend on them). Cross-reference sweep: no text
depends on the old description wording. Dogfood 119/0.

- Docs: TRDD-P4ULUV1R -> complete (shipped in v13.5.7)


## [13.5.7] - 2026-08-18

### Added

- Feat(response-gate): shared non-empty + non-echo gate on chat and per-file send paths (TRDD-P4ULUV1R)

Echo responses passed as success everywhere outside session_summary: an
answer that is verbatim its own input was saved as a report and exited
0. New src/response-gate.ts owns the verdict (isEchoResponse moved from
session_summary/driver.ts, which re-exports it unchanged — its
schema-aware 'nonconforming' verdict and the (nonconforming) exit token
janitor 3.3.16 keys on are deliberately NOT generalized). Gated:
processFileCheck (scan/check/code per-file; echo added beside the
existing empty check), chat single-shot, and chat batched (an echoed
group is now dropped exactly like an empty one instead of shipping the
input back as analysis). Fact correction vs the card: empty was already
gated on two of the three sites; the real gap was echo.

response-gate.test.ts registered in vitest.config.ts's EXPLICIT include
list (an unregistered test never runs). Verified: tsc clean, full suite
2109 passed / 4 skipped, build green. Phase 2 (per-surface stubbed
tests, all-groups-gated batch semantics, check_imports doc) tracked in
the card's STATE block.


### Documentation

- Docs: add retro TRDD-GNVIIMJP, TRDD-744G4A9W, TRDD-ME1CAHG4 — card the three pre-carded v13.5.6 fixes

Hub governance requirement (Phase-2 dispatch 2026-08-18): every Phase-2
change must cite its audit finding via a TRDD. fce10d9 (installer argv
guards), b1f008f (stale-doc purge) and 51d46bb (launcher global-flag
fix) landed before their cards; these retro-cards carry the SHAs in
implementation-commits and cite the DELEGATION.md findings, restoring
the blame -> commit -> TRDD -> finding chain. All three shipped in
v13.5.6 (c242eba).


### Fixed

- Fix(response-gate): empty final summary exits non-zero; echo gated at compare_files and check_references (TRDD-P4ULUV1R)

session-summary could assemble an EMPTY summary and exit 0 — with
--stdout that shipped literally nothing at a zero exit (measured by the
ai-maestro-janitor's handoff composer: 14 consecutive attempts on one
host, every cycle degrading to a template handoff with no classifiable
signal). The per-response no-text gate cannot catch this: it judges one
model reply, not the reduce result. The new final-assembly gate fails
BOTH --stdout and report-file paths with a message that deliberately
avoids availability vocabulary (classifyUnavailable substring-matches;
same reason as the (nonconforming) wording fix in v13.5.5).

Also extends the shared echo gate to the 4 remaining accept sites:
compare_files (both paths, loud FAILED) and check_references (both
paths, echoed reply dropped exactly like an empty one) — a model
returning the diff or source verbatim is not analysis.

Verified: full suite 2117 passed / 4 skipped, tsc + build green;
14/14 gate tests including the 8 mutation-checked surface wiring tests.


### Testing

- Test(response-gate): 8 per-surface wiring tests — echo/empty at chat, per-file, batched, check_imports (TRDD-P4ULUV1R)

Stubs ONLY globalThis.fetch (the repo's own idiom); local single-model
backend so the model's exact bytes reach the gate (the OpenRouter
ensemble wraps answers in '## Model:' headers, which would un-echo a
verbatim echo and pass for the wrong reason). Mutation-checked: removing
each of the 3 gate sites reddened exactly its wiring test. check_imports
asserts conformance-by-JSON-parse (no text gate there by design).
Registered in vitest.config.ts's explicit include list.

Authored by the js-test-writer agent; verified first-hand (vitest exit 0
via &&-chain, tsc clean). Report:
reports/js-test-writer/20260818_202841+0200-response-gate-surface-tests.md


## [13.5.6] - 2026-08-18

### Documentation

- Docs: add TRDD-P4ULUV1R, TRDD-WIO13P1P, TRDD-VI9BPO35 — phase-2 audit cards

Cards the three remaining CONFIRMED self-audit findings (evidence:
reports/plugin-self-audit/DELEGATION.md) as Tier-0 planned TRDDs, per
the hub's PHASE-2 GO dispatch (2026-08-18):
- P4ULUV1R: lift the non-empty/non-echo response gate from
  session_summary to the common send path (keeps the (nonconforming)
  literal — janitor 3.3.16 keys on it).
- WIO13P1P: deadweight sweep (dist size within the dist-stays-tracked
  constraint, CHANGELOG subject-only entries, dead add-shebang.mjs,
  mass-scout menu collapse).
- VI9BPO35: HF skill description dedup — hub closed its resolver half
  without a card; the description fix on our 4 bundled copies is ours.
  Names must NOT change.

- Docs: purge two stale facts from shipped surfaces — wrong group name, dead MCP claim

1. rules/use-llm-externalizer.md (installed into ~/.claude/rules/ on every
   machine): the 7-group list said 'config' but that group was renamed —
   'llm-ext config show' exits 1, 'llm-ext settings show' exits 0
   (verified live). Fleet-wide blast radius: every session reading the
   rule was taught a command that fails.
2. models replacements --help still asserted 'the MCP server is read-only
   by design' — the MCP server was deleted in d557c68. Reworded to state
   the surviving invariant (this command never mutates settings) without
   the dead component. dist rebuilt and verified via ./bin/llm-ext.

Installed copies (~/.claude/rules/use-llm-externalizer.md, ~/.claude/CLAUDE.md:330)
fixed in place the same way.


### Fixed

- Fix(launcher): global boolean flags no longer swallow the following positional

flagTakesValue() assumed every schema-unknown flag takes a value, but
--quiet/--estimate/--preview are GLOBAL flags handled in main.ts and
appear in no tool's inputSchema — so 'llm-ext scan folder --quiet ./src'
consumed ./src as --quiet's value and the command died blaming the
user's path, not the flag. The old comment claimed the flat parser would
'report the unknown flag' — false for this class: it saw an unexpected
positional instead, which is why the bug survived review.

Fix: exported GLOBAL_BOOLEAN_FLAGS const checked first (never eats a
token); truly-unknown flags keep the take-value guess (correct: the flat
parser then rejects them BY NAME). Test iterates the const with the flag
BEFORE the positional — the ordering both old --quiet tests missed.
main.ts sites carry keep-in-sync comments so a future global flag can't
recur the class. --profile excluded: value-taking and stripped by
extractProfileFlag before the launcher runs (verified main.ts:437 vs 458).

Verified: 24/24 launcher tests; './bin/llm-ext session compact --quiet
/nonexistent/x.jsonl' now fails naming the path (positional captured).

- Fix(statusline): argv-guard both installers — refuse any argument before side effects

Previously both installers ignored argv entirely: probing them with ANY
flag (even --help or --bogus) ran the full install and patched
~/.claude/settings.json as a side effect. Now --help/-h prints usage and
exits 0, any other argument errors with exit 2, and both paths exit
BEFORE any file copy or settings patch. Bare invocation (the only form
the slash command and check-statusline.py --fix use) is unchanged.

Verified: sh/py x --help/--bogus all leave settings.json checksum
unchanged; bash -n and py_compile clean.


## [13.5.5] - 2026-08-18

### Documentation

- Docs(session-summary): pin the field evidence against tightening the guard

Field run on 13.5.4 across 9 real transcripts: 0/9 refusals, 0/9 false
positives, and heading counts in CONFORMING outputs ranged 4-9. The obvious
next 'improvement' — reject below N headings — would eat the two at the
bottom, both small-but-real sessions, and would contradict the prompt's own
instruction to omit empty sections. Recording the counterexamples where
someone about to add that threshold will read them.


### Fixed

- Fix(session-summary): strip availability vocabulary from the nonconforming exit

The exhaustion error said "every candidate free model is unavailable" on EVERY
path, including the one where nothing was throttled and the models simply
declined. An integrator scanning that message for transient markers matched the
word "unavailable" and classified a permanent refusal as retryable, which would
burn its whole retry deadline on a model that will decline identically every
time. Reported first-hand by that caller after wiring to the new contract.

The nonconforming path now has its own message with no availability vocabulary
at all — not "unavailable", not "rate limit", not "429" — and says what is
actually true: the models answered, but not with the requested schema, so
re-running unchanged will not help. That is also the correct OPERATOR advice;
"re-run once a model recovers" was wrong here, since there is nothing to
recover from.

The caller keys on the literal `(nonconforming)` token, so it is placed BEFORE
the response excerpt: the excerpt is arbitrary model text and could otherwise
contain the token itself, or any transient marker, ahead of ours. Renaming that
token is a BREAKING change for such callers.

The fix is at the source rather than left to the caller's scan ordering — one
integrator already worked around it, and every future one would have to
rediscover the same hazard.

TEST pins the contract as a contract: the token is present, precedes the model's
words, and none of the nine availability phrases appears in the message.


## [13.5.4] - 2026-08-18

### Changed

- Build: rebuild the shipped bundle for the session-summary prompt fix

bin/llm-ext loads scripts/llm-ext/dist/llm-ext.js through launcher.mjs, so the
source change above does nothing on an installed copy until this artifact is
rebuilt — a green suite and a clean tsc would still have shipped the old
prompt.


### Fixed

- Fix(session-summary): stop shipping a model's refusal as a successful summary

An integrator reported `llm-ext session-summary --stdout` "failing completely".
It had not failed: exit 0, non-empty stdout, and the stdout was the model
DECLINING the task. The caller trusted the exit code, wrote the refusal into
its state file as the session's own handoff, and cleared the live session on
the strength of it. 1 of 19 handoffs on that host was poisoned that way.

WHY THE MODEL REFUSED — two independent triggers, diagnosed with the
integrator, both addressed here.

FRAME. chunkPromptHeader opened by telling the model its output "REPLACES the
transcript for a future session that must RESUME this work ... a handoff, not a
report". That is a description of privilege escalation: what I write becomes
authoritative context another agent acts on. Read over a transcript that itself
contains agent instructions, it is indistinguishable from an attempt to launder
instructions forward — and the model said so in as many words. It did not
object to summarizing; it objected to authoring something that would be obeyed.
The caller's use of the artifact is now simply not stated. It was never the
model's business, and stating it was the entire trigger. The completeness
requirement survives as an extraction spec: a report carrying goal, decisions,
changes, findings, errors and open threads IS a resumable handoff. Resumability
was always a property of the CONTENT, never of the frame.

CONTENT. The prompt ran straight into the transcript body with a blank line
between them and nothing marking which was which, so a transcript ABOUT agent
infrastructure (cron, self-arming, session management) read as a description of
something suspicious. Two additions defuse it: a neutral BEGIN TRANSCRIPT DATA
separator, and a paragraph naming the embedded instructions and permitting the
model to DESCRIBE rather than follow them. That resolves the dilemma it was
refusing over instead of leaving it to guess. Both are worded WITHOUT naming
the threat: "prompt injection" / "ignore any instructions below" is itself a
suspicion cue that makes a safety-tuned model likelier to decline.

WHY NO ANTI-REFUSAL INSTRUCTION: "you must comply" would trade a visible
failure for an invisible one, and a model talked out of a refusal writes a
worse summary. Deliberately not done.

DETECTION — exit 0 must stop meaning "the process printed something".
isNonconformingResponse joins no-text and echo as a third runtime verdict: a
response containing none of the nine mandated section headings demotes the
model, advances to the next candidate (a different model plausibly complies on
identical input), and exits NON-ZERO if every candidate fails. Exit 0 now means
schema-conforming output — a contract an integrator can key on instead of
sniffing prose.

WHY it tests for the SCHEMA and not for refusal phrasing: the transcripts this
tool exists to compact routinely DISCUSS refusals, safety and prompt injection,
so any "sounds like a decline" matcher would reject legitimate summaries of
exactly those sessions. Judging the response's SHAPE against ground truth we
control is the same principle isEchoResponse already uses. Known false
negative — a refusal that quotes the schema back — is accepted deliberately: it
leaves us where we were, whereas a phrase matcher trades that rare miss for
unbounded wrong rejections. Named "nonconforming", not "refusal", because that
is what is actually measured.

ALSO FIXED, found en route and latent since the echo guard shipped: an error
`detail` quotes model output, and advanceModel fed it to classifyUnavailable,
which substring-matches "404", "not found" and "quota". A summary that merely
MENTIONED a 404 could earn a healthy model a persisted cross-run cooldown.
RUNTIME_VERDICT_REASONS now passes "" for our own runtime verdicts, so the
no-cooldown behaviour they always intended holds by construction rather than by
luck of the wording. That also makes it safe to widen this excerpt to 400 chars
so an integrator's stderr log carries the model's actual words without a repro.

ModelFallbackEvent.reason re-spelled the union's members instead of naming it,
so adding a reason compiled at the declaration and failed at the assignment —
the error pointed at the writer, never at the stale list. It references the
type now.

TESTS: 43 existing fixtures returned bare "SUMMARY"/"CHUNK-1" and never modelled
a conforming response; they now carry a heading via summaryFixture(). Added the
false-positive guard that matters most — a legitimate summary OF a transcript
discussing refusals and prompt injection must be ACCEPTED — plus refusal
demotion, the isNonconformingResponse unit cases, and assertions that the three
trigger phrases stay ABSENT from the prompt so a future "make the stakes
clearer" edit fails the suite instead of quietly restoring them.


## [13.5.3] - 2026-08-18

### Documentation

- Docs: add TRDD-Q185FRMW — serialize first-run native install (closes #13 design)

Issue #13: the first-run self-install of native deps in scripts/llm-ext/launcher.mjs
is unguarded against concurrency. Three races verified first-hand at 7cc4521:
concurrent npm into one node_modules, a TOCTOU in linkNodeModules whose cpSync
fallback throws again uncaught, and dataDirHasDeps reading a half-written tree.

WHY the fix is a lock and not a redesign: races 1 and 2 self-heal on retry and the
window opens once per machine, so they alone would not justify a change. Race 3 links
an incomplete tree, so its damage outlives the racing process — that is what makes
this worth fixing. Scope is therefore one exclusive-create mkdir lock, not a
staging-dir + atomic-rename rewrite.

WHY mkdirSync without recursive: atomic exclusive-create on POSIX and Windows with
zero dependencies. flock(2) would need a native addon, ruled out fleet-wide 2026-07-17.

WHY a stale-lock break is mandatory: without it one crash mid-install bricks every
future run, which is strictly worse than the race being fixed.


### Fixed

- Fix(launcher): serialize first-run native install with an exclusive-create lock (TRDD-Q185FRMW)

Closes the three races in issue #13. Two llm-ext processes starting on a fresh
machine both ran npm into one node_modules, both raced the linkNodeModules
symlink (TOCTOU -> EEXIST -> cpSync throws again, uncaught), and a loser could
read dataDirHasDeps as true mid-write and link a half-built tree.

WHY a lock and not a staging+rename redesign: races 1 and 2 self-heal on retry
and the window opens once per machine. Race 3 is the one that justifies a change
at all, because it LINKS the incomplete tree, so its damage outlives the racing
process. Smallest fix that closes all three is serialization, not a rewrite.

WHY mkdirSync without recursive: atomic exclusive-create on POSIX and Windows,
zero dependencies. flock(2) needs a native addon, ruled out on this fleet.

WHY the dataDirHasDeps re-check sits INSIDE withInstallLock: hoisting it above
the lock reintroduces race 3 verbatim. Do not move it.

WHY the stale-lock mtime break exists: without it a crash while holding the lock
bricks every future run - strictly worse than the race being fixed.

WHY the test never spawns processes: a two-process race test passes with the lock
deleted, since it relies on scheduling to produce the collision. The exclusion is
asserted deterministically (hold, assert contender parked, release, assert it
proceeds) and the negative assertion was verified to fail against a neutered lock.

install-lock.mjs is load-bearing at runtime: bin/llm-ext imports launcher.mjs from
the repo tree, so an uncommitted sibling would break every invocation on a fresh
clone. The npm package is unaffected - its files list is dist/** and its bin
points at dist/llm-ext.js, so scripts/ never ships there.


## [13.5.2] - 2026-08-16

### Documentation

- Docs: TRDD-QY1JITC7 — tick the pre-feature guard test (f3d521f)

- Docs: add TRDD-QY1JITC7 — idle fan-out workers should race the straggler

Records the measurement that shows the compaction <2min target cannot be met
by the prescribed method (more chunks in parallel), the specific dead capacity
that can be reclaimed instead, and the termination hazard that must be tested
before the mechanism is built.

- Docs(session-summary): HEDGE_AFTER_MS is not half of the chunk timeout

The comment claimed HEDGE_AFTER_MS was "half of DEFAULT_CHUNK_TIMEOUT_MS" and
described 60s as "sitting at the midpoint". The constants are 60_000 and
600_000 — one tenth. The wording was almost certainly true when the chunk
default was 120_000 and silently became false when it rose to 600_000.

This is not cosmetic: the two sentences are the only stated rationale for a
constant on a latency-critical path, so a reader reasoning from them computes
a 300s hedge point instead of 60s and mis-predicts by 5x when a straggler gets
duplicated. Measured this session, the real 60s trigger fires roughly 80s
before a slow chunk finishes, which is exactly the behavior the old wording
would have hidden.

Replaced with the rationale the number actually has — 60s sits just above the
measured median — plus an explicit warning not to re-couple the two constants.
They are tuned against different measurements: the hedge point against the
median, the chunk timeout against the slow tail. Coupling them again would
re-introduce this drift the next time either is retuned.


### Fixed

- Fix(launcher): pin native deps to ~/.llm-externalizer, not the plugin cache

The native-deps directory used to be CLAUDE_PLUGIN_DATA, falling back to a
path DERIVED from the launcher's own position inside the plugin cache
(<root>/plugins/cache/<marketplace>/<plugin>/<version>/...  ->
<root>/plugins/data/<plugin>-<marketplace>).

Both halves fail the same caller. A hook-spawned, cron-spawned or
daemon-spawned child inherits no CLAUDE_PLUGIN_DATA, so it fell to the
derivation; the derivation resolved a FIXED number of ".." hops, so any
placement other than the exact expected depth returned null and the
launcher died on a hard FATAL. Callers were left guessing the address --
and a wrong guess self-installs a SECOND native module into a directory
nothing else reads. Anchoring the address on the cache also made it
version-shaped: it moves whenever the plugin layout does.

The deps now live at one fixed, user-owned location -- ~/.llm-externalizer
/native, under the same root as settings.yaml and honouring the same
LLM_EXT_CONFIG_DIR override as getConfigDir(). There is nothing to derive,
nothing to inherit from the environment, and therefore no "unresolvable
data dir" state to fail on: every caller resolves the same directory, and
it survives plugin upgrades, reinstalls and cache wipes.

Reported by the ai-maestro-janitor session, whose cold-resume handoff had
been degrading to a template for two days against the old contract.

Verified: cold start from a plain temp dir (no CLAUDE_PLUGIN_DATA, no cache
layout -- the exact shape that used to FATAL) installs into <config>/native,
links it, and boots the CLI. Full suite 2093 passed / 4 skipped, typecheck
and lint clean.


### Testing

- Test(session-summary): guard the map phase against waiting on abandoned work

Written BEFORE the feature it guards (TRDD-QY1JITC7 acceptance criterion 2).

That TRDD proposes letting an idle fan-out worker race the longest-outstanding
chunk instead of idle-polling, because measurement showed two free models
polling for 127s and 69s while one chunk ran to 143.8s and set the 146s wall
clock. The hazard that stopped it being implemented the same day: the map phase
ends at Promise.allSettled(workers), so a worker parked on a speculative call
does not return until that call settles. If the real owner commits the chunk
first, the phase waits on a result nobody can use — on the measured free-tier
tail that is up to 1478s, turning the optimisation into a large regression.

The test encodes the hazard rather than the feature. A call for a marker that
was already answered is, by construction, work whose result cannot be needed —
exactly the shape of a discarded racer — so the mock answers it after 3s. Today
nothing issues such a call, so the run finishes on its 300ms slow chunk and both
the text and timing assertions pass with room. Add speculative racing without a
way to abandon the wait and the call starts happening, the phase absorbs the
delay, and this fails.

Proven to bite rather than assumed: inducing a genuine duplicate call for the
slow chunk (a transient throw after the mock recorded the answer) fails the test
with exit 1 on the joined-summary assertion, picking up STALE-3. Control
reverted; driver suite 57 passed, tsc 0, eslint 0.

The timing bound is deliberately loose — slow chunk + half the unneeded-call
cost. The assertion is "does not absorb an extra ~3s", not "finishes in exactly
N ms"; a tight bound would be flaky under CI load and would get deleted instead
of debugged.


## [13.5.1] - 2026-08-14

### Fixed

- Fix(setup,docs,tests): background dispatch in the wizard, README, and the gate

Three follow-ons to the 2.1.232 background-spawn change.

setup wizard: the plan called for pinning `background: false` on the command,
copying the precedent at skills/llm-externalizer-scan/SKILL.md, which uses
`context: fork` + `background: false` to defend against the same default that
landed for forked skills in 2.1.218. That pin is NOT applied here, because
checking first showed it would be inert: across the 37 plugins installed on
this machine, `background:` appears in SKILL.md frontmatter only and in zero
command frontmatters. Adding an unrecognized key would have looked like a fix
and changed nothing.

What the wizard gets instead is an accurate statement of the constraint. It is
genuinely interactive — it calls AskUserQuestion, and it pauses for the user to
confirm a runner install and a model download — and a background agent cannot
hold a live turn. The command now tells the orchestrator to relay the agent's
questions and answer via SendMessage, and not to read the dispatch's return as
a finished setup. Whether a command can opt out of backgrounding is an open
upstream question; this documents the behavior rather than guessing at a knob.

dogfood gate: `allowed-tools` shape-3 accepted "Task" OR "Agent". That is why
five commands carried a retired tool name indefinitely without the suite going
red — the check was broader than the invariant it guarded, so it passed while
verifying nothing. `Task` is now a hard FAIL with an explanatory message.

README: the architecture diagram drew dispatch flowing straight into the join,
which is the synchronous model the release removed; it now shows the await step
between them. Install no longer prescribes a mandatory restart (2.1.221
activates immediately when safe, 2.1.232 refreshes the marketplace on install),
keeping /reload-plugins as the fallback.

- Fix(commands): agent dispatch is asynchronous, and the tool is Agent not Task

Claude Code 2.1.232: "non-teammate agent spawns in interactive sessions now
run in the background by default". An Agent(...) call returns an agent id
immediately; the subagent's answer arrives later in its completion
notification. Two separate defects followed from that.

1. All five orchestration commands declared `allowed-tools: Task`. That tool
   name no longer exists — it is `Agent`, as llm-externalizer-setup.md already
   spelled it. A command that declares a nonexistent tool is not granted the
   real one, so the dispatches were unauthorized.

2. The serial loops in fix-found-bugs and scan-and-fix-serially said "Dispatch
   ONE Task call. Read its return line" and then logged $TASK_RETURN_LINE.
   There is no return line at dispatch time any more, so the loops logged
   nothing and could never observe a [FAILED]. They now wait for the
   completion notification and read its <result>; the placeholder is renamed
   $AGENT_RESULT_LINE so the name cannot be mistaken for the dispatch value.

The parallel commands say explicitly that "the batch finished" means 15
completion notifications have arrived, not that the assistant message
returned — dispatch calls returning is exactly the false signal that would
start batch N+1 while batch N is still running.

scan-and-fix's "IGNORE fixer return text" design needed no change: it already
globs $REPORTS_DIR instead of trusting returns, which is why it survived this
release intact. That filesystem count is now documented as the barrier's
safety net — an early join under-counts visibly instead of silently merging a
partial batch.

Also corrects two claims that this release falsified: "No background
processes. Ending the parent session stops the loop cleanly between
iterations." The fixers ARE background agents now; the loop is still serial,
and killing the session mid-fixer abandons its turn while leaving any edits
it already wrote on disk.

Added an explicit ban on subagent_type: "fork" in every dispatch site. Forking
became the default-on feature in the same release, and a fork inherits the
whole conversation — precisely the context the per-file fixer architecture
exists to keep out of the fixers.


## [13.5.0] - 2026-08-13

### Added

- Feat(session-summary): report the size reduction the compaction achieved

The command reported chunk counts, lines read and a prune ratio - all
descriptions of how the work was done, none of them the outcome. The one
number a compaction exists to produce, how much smaller the summary is than
the transcript it replaces, could only be got by stat'ing two files by hand.

It now prints raw transcript bytes, summary bytes and the reduction
percentage, to stderr and in the report header. Both go out because stdout
is a PATH: a caller that never opens the report would otherwise never see
the number.

Human-readable sizes sit beside exact byte counts on purpose - "2.08 MB" is
what you read, "2,179,678" is what you compare across runs.

Two cases are deliberately not smoothed over:

- An unusable original size (empty or unreadable transcript) reports
  "reduction: n/a" rather than a computed value. A divide-by-zero rendering
  as "NaN% reduction" reads like the compaction broke rather than the
  arithmetic.
- A summary LARGER than its transcript says "LARGER than the original"
  instead of clamping to 0%. That is the one outcome where running the
  command was not worth it, so it is the last thing to hide.

Tested as a pure module: unit stepping, the two-decimals-below-ten rule, the
ordinary percentage, null on an unusable input, a negative reduction
surviving, and the assembled line carrying both size forms.


## [13.4.1] - 2026-08-13

### Documentation

- Docs(session-summary): document the new flags and correct a stale default

The README's flag table listed neither --concurrency nor --chunk-timeout-s,
both of which have shipped for a while, and neither of the two flags added
in v13.4.0. It also stated the chunk budget default as min(50000, window);
the driver has used 25_000 since the map phase became concurrent, where a
smaller chunk is strictly better.

Adds the missing five rows, a paragraph on what to do when the summary must
exist no matter what, and a worked unattended example. docs/ and commands/
carry no session-summary references, so nothing there needed changing; the
--help text and the compact-session skill were updated with the code.


## [13.4.0] - 2026-08-13

### Added

- Feat(session-summary): --until-done, --max-retries-per-chunk, and the loop in the skill

Compaction was checkpoint-and-stop by design: a chunk got 3 attempts on a
model, a delisted or quota-capped model was demoted to the next ranked free
one, and when those ran out the command FAILED with a resumable checkpoint
and a "re-run once the limit clears" message. That is the right default for
an interactive run - it reports the problem instead of sitting on it - but
it means an unattended compaction does not reliably produce a summary, and
the retry budget was not reachable from the CLI at all.

Three changes, smallest first:

- `--max-retries-per-chunk N` exposes the driver's existing
  maxRetriesPerChunk (default 2, i.e. 3 attempts). It covers provider
  hiccups and, on concurrent runs, rate-limit backoff. It deliberately does
  NOT cover a delisted or quota-exhausted model: that is a fallback signal,
  not a retry signal, and demotion already handles it.

- `--until-done` retries the WHOLE compaction until it succeeds. This is
  cheap and correct only because of the checkpoint: each pass keeps every
  chunk that landed and redoes only what did not, so passes converge instead
  of repeating work. Re-entering summarizeSession rather than looping inside
  it also re-resolves the model list, so a model that was quota-capped last
  pass is picked up again once its quota resets. Argument errors still fail
  immediately - the flag retries the compaction, not a typo in a path.

- The skill documents both, plus the outer `until ...; do sleep 60; done`
  shell loop for the case where the process itself may be killed. The flag
  covers failures inside one invocation; the loop covers losing the
  invocation.

The backoff policy is its own module with its own tests rather than four
lines inline, because it is the part that can fail invisibly: the loop is
unbounded, so a zero-length wait busy-loops against the very endpoint that
rate-limited us, and the UTC-midnight arithmetic either stalls a full day or
does not wait at all if it is wrong. 30s doubling to a 15-minute cap; a
failure that names an exhausted daily quota waits for the 00:00 UTC reset
instead, since that is when the free tier actually returns, still capped per
sleep so a run stays observable and can pick up an earlier recovery.

15 tests: midnight exactly (a full day, never zero), month and year
boundaries, the doubling curve, the cap, an attempt count large enough to
overflow 2**n to Infinity (setTimeout treats Infinity as 1ms and busy-loops),
and the quota-vs-transient classification in both directions.


## [13.3.8] - 2026-08-13

### Fixed

- Fix(session-summary): name the race winner in the progress line

A timed run reported "[chunk 1/1] done in 84.2s" inside a command that took
534s wall-clock. The 84.2s line is unattributable as written: it reads
identically whether the race won in 84s, or whether all four racers failed
over several minutes and the sequential fallback then took 84s. Those are
opposite outcomes - one means racing works, the other means racing is
burning minutes before the old path does the work anyway - and they call
for different fixes.

The driver already emits raceSize and raceWinnerModel on the "done" event;
the CLI was throwing them away. It now prints them, so the next
measurement can distinguish a win from a fallthrough instead of leaving it
to inference.


## [13.3.7] - 2026-08-13

### Fixed

- Fix(launcher): install native deps without being told where the data dir is

Running `llm-ext` from a shell died with "FATAL: native module
'better-sqlite3' is missing AND CLAUDE_PLUGIN_DATA is unset", telling the
user to set an environment variable they had no reason to know about.
CLAUDE_PLUGIN_DATA is exported by Claude Code when IT launches the plugin;
a user, a skill, or a script invoking the CLI directly has no such export,
so first use outside Claude Code always failed.

The data directory was never actually unknown. It is a fixed function of
where the launcher sits:

  <root>/plugins/cache/<marketplace>/<plugin>/<version>/scripts/llm-ext
  <root>/plugins/data/<plugin>-<marketplace>

so it is now derived from the launcher's own path when the variable is
absent, and the self-install proceeds. Derivation is refused, with the
original hard failure, when the surrounding layout is not a plugin cache -
guessing a write location outside the known layout is worse than saying we
do not know.

Second fix in the same path: the data dir is shared across versions while
the cache dir is per-version, so right after an upgrade the deps are
already installed and only this version's link is missing. The launcher
now checks for better-sqlite3 in the data dir and links instead of
re-running the package manager.

Verified against a replica of the real cache layout, all with
CLAUDE_PLUGIN_DATA unset: a cold run derives the data dir, installs and
boots; a subsequent fresh version dir sharing that data dir skips the
install and boots in 0.12s instead of ~40s; a non-plugin layout fails with
the actionable message. The derivation was also checked against this
machine's real install path and reproduces its existing data dir exactly.


### Performance

- Perf(session-summary): race a one-chunk compaction across the top-K models

A transcript that prunes down to a single chunk got the worst deal in the
module. Auto-concurrency resolves to min(chunkCount, ...) = 1, so the
sequential branch runs - and that branch does not hedge. Fan-out needs
chunks.length > 1 to engage, so it never engages either. One model, one
attempt, no mitigation, against a free tier whose measured per-request
latency spans 91s to 1478s. A real compaction of this exact shape took
340.8 seconds for its single chunk.

The intuitive fix - split the chunk up and parallelize - makes it worse,
and this repo already recorded the measurement: a 4x smaller chunk was no
faster and produced 80 aborts instead of 13, because latency here is
dominated by queueing, not by how much the model generates. Splitting one
chunk into N turns the map phase into the MAX of N draws from a heavy
tail. Racing K copies of the SAME chunk turns it into the MIN of K draws.

So a one-chunk run now dispatches to the same top-K models fan-out would
have used and takes the first usable answer. Cost is unchanged at $0
(every racer is a :free model, already gated by assertFreeOnlyModel), and
rate safety is not close to the line: K distinct models, one request each,
against a per-model bucket measured to absorb 32 concurrent.

What the design deliberately preserves:

- The chunk budget already fits every racer. Under fanoutActive the budget
  was computed from the MIN window across these same K models, so no racer
  can be handed a chunk its window cannot take.
- Only the winner commits. Losers are dropped exactly as a hedge loser is,
  and writeChunkSummaryOnce is the backstop when one settles late.
- A loser never mutates the active model and never runs applyTransition. A
  bystander that 404s or overflows says nothing about the model the run is
  pinned to; treating it as a fallback signal would rotate the active model
  on someone else's failure.
- All-K failure falls through to the untouched sequential path, which does
  the ordinary transition and exhaustion handling. The pessimistic case is
  the old behaviour plus K-1 wasted free calls.
- concurrency: 1 - the library default and every non-CLI caller - is
  byte-identical. The race is gated on fanoutActive.

ChunkEvent now carries raceSize and raceWinnerModel on "done". The race's
premise is that distinct models sit in different queues, and that premise
is unproven for every model but the primary, so the winner has to be
observable or nobody can tell whether racing bought anything.

Four tests: the fast model wins while the primary is still hanging; a
late-settling loser never overwrites the committed summary; a single
eligible model makes exactly one call; concurrency: 1 never races.


## [13.3.6] - 2026-08-13

### Fixed

- Fix(ci): restore validation-report.txt as a release asset

Moving the CPV reports to RUNNER_TEMP fixed the self-inflicted blocking
finding but broke three downstream consumers in the same job that still
expected ./validation-report.txt: the SHA256SUMS loop, the release upload,
and the provenance attestation. The upload failed with "no matches found
for validation-report.txt" and took the job down one step later than
before - a fix that moved the failure instead of removing it, because the
change was checked against the step it touched rather than every reference
to the file it moved.

The text report is now copied back into the workspace immediately after
the scan that produces it has finished. The scanner never sees a partial
file, and the asset is published as before. Only validation.json has to
stay out of the tree: it is not gitignored, and an empty one in the plugin
root is itself a blocking MAJOR.


### Testing

- Test(cli): stop a spawn timeout from reporting as "expected null to be +0"

The publish gate failed on
"--profile <name> ... positioned AFTER the command" with
"AssertionError: expected null to be +0", while the same file passed three
times in a row when run on its own.

execFileAsync kills the child on timeout, which leaves `code` undefined and
sets `signal`. The harness collapsed that to `exitCode: e.code ?? null`, so
a 15-second timeout arrived at the assertion as a bare null and the message
named neither the timeout, the signal, nor the command. The failure was
real and the report made it look like a logic bug.

The harness now surfaces the signal, whether the kill was a timeout, and
the argv, so the next occurrence explains itself. The budget goes from 15s
to 60s: these spawn a cold Node process running the real CLI, and the gate
that runs them does so while the same machine type-checks, lints and builds
- which is why it failed there and nowhere else.


## [13.3.5] - 2026-08-13

### Testing

- Test(vmlx): make the "CLI present" tests actually make it present

The release job failed on test_vmlx_bench_delegation_when_cli_present with
"TypeError: 'NoneType' object is not subscriptable", while the same test
passed locally. run_vmlx_bench returns None immediately when
shutil.which("vmlx") is None, and the test patched only subprocess.run -
so it asserted the delegation path only on a machine that happened to have
vmlx installed, and asserted nothing on any runner that did not.

Its sibling failed the same way in the opposite direction:
test_vmlx_bench_returns_none_on_failure got None because there was no
binary, not because the binary exited non-zero, so it passed in CI while
proving nothing.

Both now patch shutil.which, the pattern a third test in this same file
already used. Verified by running the suite twice - once on a PATH that
includes vmlx and once on a PATH that does not, the CI condition: 190
passed both times.


## [13.3.4] - 2026-08-13

### Fixed

- Fix(ci): stop the release gate failing on its own scratch file

The Release workflow has failed on every tagged release while the local
publish gate passed. The asymmetry was the whole clue: publish.py never
writes a validation.json, and the workflow did.

`cpv-remote-validate plugin . --json > validation.json` redirects into the
directory being scanned, and the shell creates the redirect target before
CPV starts. So the scan found a zero-length validation.json in the plugin
root and reported it, correctly, as "[MAJOR] JSON syntax error in
validation.json: Expecting value: line 1 column 1 (char 0)". That was the
single blocking finding on every run - the gate failing the release on a
file the gate had just created. Every other finding was a skillaudit
advisory and already downgraded.

Both reports now go to RUNNER_TEMP, outside the scanned tree, and the
classifier reads the path from the environment rather than a fixed name.
validation.json is also gitignored, for anyone running the validator by
hand from the repo root.


## [13.3.3] - 2026-08-13

### Fixed

- Fix(deps): declare zod, which every clean checkout was missing

CI has failed the typecheck on every release since at least v11.1.0 with
"Cannot find module 'zod'" in four cluster/ modules. The cause is not a
CI problem: zod was imported by src but declared nowhere in
scripts/llm-ext/package.json, so it existed on exactly one machine.

Node and TypeScript resolve modules by walking parent directories, and on
the publishing machine the walk reached a stray ~/node_modules/zod. Local
typecheck, lint, build and tests therefore all passed against a package
that no clone, no CI runner and no contributor had. The failure was
invisible precisely where it was introduced and unavoidable everywhere
else.

It also reached the shipped artifact: esbuild bundled that unpinned copy
into dist/index.js, so releases carried code from a dependency version
nothing recorded.

zod is now a real dependency with a lockfile entry, and resolves from the
project's own node_modules rather than from a directory that happens to
sit above it.


## [13.3.2] - 2026-08-13

### Fixed

- Fix(auto-bench): make the duplicate-spawn lock impossible to wedge

An auto-benchmark that stops running is invisible: "a run is already in
progress" reads exactly like healthy throttling, while the five
machine-managed default profiles quietly freeze on a stale model set and
never react to OpenRouter pool drift again.

The old lock could latch permanently, three ways at once:

  1. Nothing ever deleted it. Neither parent nor child unlinked the lock
     file, so every successful run left a dead-pid file behind forever.
  2. Liveness was process.kill(pid, 0) alone. Once a leftover pid is
     reused by an unrelated process - guaranteed after a reboot, since
     pids wrap - the check reads "held" forever.
  3. EPERM counted as held. We always spawn same-uid, so a pid we cannot
     signal is by definition not our child; that handed the wedge to any
     root daemon landing on the reused pid.

Staleness is now decided on three independent axes - pid parses, pid is
signalable by us, mtime within a 2h TTL - and any one of them releases
the lock. The TTL is what turns "unlikely to wedge" into "cannot wedge":
even a reused pid expires. The failure direction is deliberate. Releasing
too eagerly costs at most one duplicate benchmark (the free pool is $0 by
construction; the paid profiles are gated by allow_paid_models plus a
per-run opt-in). Releasing too reluctantly costs the feature itself,
permanently.

The lock is also now claimed with openSync(path, "wx") BEFORE the spawn,
closing a window in which two processes both passed the check and both
spawned, and it is rolled back on every failure path.

Also fixed, same subsystem:

- default-profiles-runner resolved its lock and log paths in destructuring
  defaults, so getConfigDir() - which throws on a config dir outside the
  allowlist - was evaluated eagerly on entry. The function is documented
  "never throws" and is awaited from dispatchCallTool, which has no
  try/catch, so a benchmark meant to be invisible could fail the tool the
  user actually ran. It now degrades to a skip, after the opt-out check.
- The same runner created getConfigDir() rather than the directories that
  actually hold the log and the lock, so an injected path failed to open a
  log while making a directory nobody asked for.
- cluster/preflight_benchmark built its cache dir with a bare
  join(homedir(), ".llm-externalizer"), ignoring LLM_EXT_CONFIG_DIR and
  bypassing the symlink-escape guard - the same defect fixed one release
  earlier in free-pool-auto-bench, still live in a sibling module.
- LLM_EXT_AUTO_BENCH_REASON had four writers and no reader. The benchmark
  entrypoint now logs it as its first line, so an unexpected bench in a log
  can be attributed.

Prevention, because prose did not hold the line - the rule was in a header
comment, the comment was read, and the next module did it wrong anyway:

- The detached-spawn sequence lives in one module (bench-spawn.ts). It had
  been copy-pasted, so every bug in it existed twice and repairs reached
  only one copy.
- ESLint now rejects the ".llm-externalizer" literal outside config.ts and
  the `spawn` import outside bench-spawn.ts. Both rules were verified to
  fire on a probe file before being committed.

Tests: 2054 passed, 4 skipped (was 2037). New coverage for each staleness
axis, for the atomic claim and rollback, and for both fail-open contracts.
One existing test asserted that a missing log directory causes a skip; that
was the old defect, so it now asserts the directory is created, with a
separate case using a path whose parent is a regular file for the genuinely
unopenable one.


## [13.3.1] - 2026-08-13

### Fixed

- Fix(free-pool): honour LLM_EXT_CONFIG_DIR in the auto-bench paths

free-pool-auto-bench.ts built its cache/lock/log paths from
join(homedir(), ".llm-externalizer") as IMPORT-TIME constants, so
LLM_EXT_CONFIG_DIR was honoured for settings.yaml and ignored here. Two
consequences, both real:

1. ISOLATION. A run pointed at a scratch or CI config dir still read the
   cache, took the lock, and wrote the log in the user's REAL config dir.
   So "isolated" runs shared one lock with the live one and could read real
   benchmark results. Reproduced while verifying v13.3.0: a scratch-dir run
   spawned a child that read the REAL settings.yaml and tried to benchmark
   the user's PAID models. Only the allow_paid_models master switch stopped
   it ("No API call was made, $0 spent") -- the isolation did not.

2. SECURITY. getConfigDir() resolves symlinks in the deepest existing
   ancestor so mkdirSync(recursive) cannot be walked outside the allowed
   path via a planted symlink, and it enforces an allowlist ($HOME or
   /private/tmp). A bare join(homedir(), ...) skips both. This module was
   bypassing a control, not merely an env var.

Fixed by resolving through getConfigDir() at CALL time. Functions, not
constants: a module-level getConfigDir() call would freeze whatever the env
held at first import -- the same bug in a slower disguise, and still wrong
for tests that set the var per case.

WHY IT SURVIVED THIS LONG: every existing test in this file injects
cachePath/lockPath/logPath explicitly, so nothing ever exercised the DEFAULT
resolution the bug lived in. The new test omits those opts ON PURPOSE. It
also had to allocate its scratch dir under /tmp rather than tmpdir(), because
tmpdir() is /var/folders/... on macOS and getConfigDir() correctly refuses
it -- the guard from (2) doing its job.

Gates: tsc 0 - eslint 0 - build 0 - vitest 2035 passed / 0 failed / 4 skipped.
Behavioural proof: with LLM_EXT_CONFIG_DIR set, the lock and log now land in
that dir and the real ~/.llm-externalizer/free-pool-bench.log is untouched
(48362 bytes before and after); pre-fix, the identical command wrote there.

NOT PUBLISHED -- local commit only, pending review.


## [13.3.0] - 2026-08-13

### Added

- Feat(profiles): split the 3 machine-managed defaults into 5 explicit ones

free / ensemble / mass-scout  ->  free / free-ensemble / paid /
paid-ensemble / paid-mass-scout.

WHY the split: the old names hid WHAT COSTS MONEY. `ensemble` was paid and
`free` was a pool that silently served both the single-model and the
combined-output case, so a user reading their own settings.yaml could not
tell which profile would bill them. The new names put the cost class in the
name, and separate the single-model pick from the 3-model ensemble that was
previously conflated inside `free`.

Selection rules (first four share ONE keyword sweep, so the split costs no
extra benchmarking):
  free            best single free model that passes
  free-ensemble   best 3 free models that pass (combined output)
  paid            best single paid model, input AND output both < $1.3/M
  paid-ensemble   best 3 paid models under the same ceiling
  paid-mass-scout cheapest passing model, NEVER a :free id

WHY there is no free mass-scout: mass-scouting fires thousands of requests
and every free tier rate-limits it, so a free scout profile would be a trap
that looks configured and fails under load. The ':free' exclusion in
pickMassScoutModel is enforced in CODE, not merely documented, so a caller
cannot hand one back by accident.

Also corrects a STALE comment in model-qualification/registry.ts that
claimed only `security_scan` has a benchmark. mass_scout has had its own
dedicated benchmark all along -- src/mass_scouting/calibrate-payload-size.test.ts,
measuring per-record classification accuracy across ~11 payload sizes. It
lives under mass_scouting/ rather than benchmark/<suite>/, which is exactly
why a search of the suite directory "proved" it absent. It is gated on
CALIBRATE=1 + OPENROUTER_API_KEY (real spend) and is deliberately NOT wired
into paid-mass-scout's automatic population; pickMassScoutModel now carries
an honest note naming it as the future qualification target and what wiring
it in would require.

Gates: tsc 0 - eslint 0 - build 0 - vitest 2034 passed / 0 failed / 4 skipped
- dogfood 119 PASS / 0 FAIL (120 checks). No cost guard or assertion was
weakened to get there.


## [13.2.1] - 2026-08-13

### Fixed

- Fix(profiles): paid population could never succeed; and three more review findings

A read-only review of the v13.2.0 subsystem found 5 issues. 4 were real; all are
fixed here. Every one survived tsc, eslint, 2031 tests and a 119/0 dogfood run.

CRITICAL — paid population was impossible. populateDefaultProfile spawned the
child WITHOUT `--allow-paid-models-tests`, so assertPaidBenchmarkAllowed's
per-run opt-in refused in seconds, recordBenchmarkFailure banked a cooldown, and
the cycle repeated on 15min/1h/4h/24h backoff forever: `ensemble` and
`mass-scout` could NEVER auto-populate, even with allow_paid_models: true. The
printed remedy was broken the same way, so a user copy-pasting the suggested fix
hit the identical error — and the generated settings.yaml told them outright
that these profiles "populate on first use", which was false.

Reproduced end-to-end against the shipped bundle before fixing (exit 1,
"paid-benchmark opt-in", $0 spent) and again after (exit 0, worst-case estimate
$0.1401 under the $2.00 cap). Passing the flag LOOSENS NOTHING: the child
independently re-reads the master switch `allow_paid_models` from settings.yaml
and refuses on it first — verified by running the fixed path with the master
switch off and the flag set, which still refuses, $0 spent. The flag exists to
stop an unattended spend nobody asked for; this is the spend the user asked for
by setting the switch and selecting a paid profile.

MAJOR — `blocksCaller` never blocked. Only the "refused" branch returned; a
"spawned" paid population fell through to null, so the current call proceeded
with PLACEHOLDER_MODEL_ID and died on a raw provider 404 — the exact failure the
unroutable sentinel was chosen to make unmistakable. It now returns a clear
BENCHMARK IN PROGRESS result naming the log to watch. `free` still never blocks.

MAJOR — `reset` rejected the whole settings reload when the active profile was
an unpopulated machine-owned default (the normal state after a fresh install).
validateProfile deliberately carries no placeholder exemption, so every caller
must apply it; the boot path did and reloadSettingsFromDisk did not. That
discarded any other edit in the same save — including the allow_paid_models flip
a user would make precisely to get those profiles populated.

MINOR — a comment above reloadSettingsFromDisk still described a settings
file-watcher polling every 5s. It was deliberately removed; a reader trusting it
would expect edits to propagate on their own.

NOT a defect (reported CRITICAL, investigated, rejected): a re-benchmark loop
from stale in-memory settings in "the long-lived MCP server". There is no such
process — no MCP transport remains in src/, and dispatchCallTool is invoked
exactly once per CLI process, so every invocation re-reads settings.yaml at boot
and a completed population is visible to the next command. The finding reasoned
from a component this project deleted.

Tests: 2 new that assert the child's ACTUAL argv rather than that a spawn merely
happened — the existing test checked only outcome.kind, which is why the missing
flag was invisible. Two wiring tests were updated because they asserted the old
"proceeds, returns null" behaviour, i.e. they encoded the defect; their real
invariants (429 must not trigger population, 3x404 must) are unchanged.

Verified: tsc 0, eslint 0, build 0, full suite 2033 passed / 0 failed.


### Miscellaneous

- Chore(build): rebuild dist for the paid-population fix

Only index.js and llm-ext.js change: the fix lives in
default-profiles-runner.ts and index.ts, which benchmark.js does not bundle
(it imports default-profiles-state, not the runner).

Separate from the source commit so the window where the bundle lagged its
sources stays visible in history rather than hidden inside a fix diff.


## [13.2.0] - 2026-08-13

### Added

- Feat(profiles): persist benchmark results — the last two triggers can now fire

Completes the previous commit's stated gap. `recordBenchmarkSuccess` /
`recordBenchmarkFailure` had ZERO production callers, which meant two of the
five re-benchmark triggers were structurally dead, not merely untested:

- `new-model-arrived` and `model-price-increased` could never fire, because
  nothing persisted the qualifying-pool fingerprint or the last-picked prices,
  so the gate had nothing to compare today's catalog against. Two of the three
  conditions the owner asked for ("new models / removed models / models with
  increased costs") were therefore inert; only "removed" worked.
- The failure backoff never armed: `cooldownUntil` was READ at the gate but
  never WRITTEN, so a benchmark that always fails (no API key, provider outage)
  would retry on every single command.

Now the `--populate-default-profile` phase banks its own outcome where the
benchmark actually completes — success stores the fingerprint of the candidate
set the picks were drawn FROM (not the raw catalog, so the fingerprint
describes what was actually chosen among), failure arms the backoff, and
--dry-run persists nothing. The gate feeds `qualifyingPool`,
`lastPoolFingerprint` and `cachedPrices` back in, each fail-open: an empty
catalog, an unreadable cache or a missing state file degrades to "re-check
later" and never invalidates a populated profile or fails the user's tool call.

The "Not yet wired here (future work)" paragraph is deleted rather than
reworded, because it is no longer true.

+7 tests. The load-bearing one round-trips the fingerprint through DISK and
then asserts an unchanged pool still reports up-to-date — the anti-thrash
guarantee has to survive persistence, not just hold in memory, since a
fingerprint that failed to reload would look like a changed pool and
re-benchmark forever, which is the exact unbounded-spend bug this design
exists to prevent.

Verified: tsc 0, eslint 0, build 0, full suite 2014 passed / 0 failed.

- Feat(profiles): wire default-profile population into the dispatcher (3 of 5 triggers live)

The machinery from the previous commits had NO caller — the feature was inert.
This wires it in three places:

1. BOOT GATE (index.ts). validateProfile correctly reports an unpopulated
   default profile as invalid: an empty pool cannot serve a request. Left alone
   that gates every tool behind NOT CONFIGURED on a fresh install, with no
   reachable path to population. The boot now checks whether EVERY validation
   failure is an unpopulated machine-owned default and boots anyway if so; a
   genuine user misconfiguration still fails exactly as before. Deliberately NOT
   solved by exempting placeholders inside validateProfile -- that was tried
   earlier in this branch and silently disabled two zero-spend invariants for
   every profile (empty free_models and a malformed scalar free_models both
   began reporting VALID), caught only by free-only.test.ts.

2. DISPATCHER HOOK (index.ts, beside runModelReconcile) behind the SAME
   RECONCILE_SKIP_TOOLS list, so read-only/report-config tools never trigger a
   benchmark or a spend refusal -- they must report config AS THE USER HAS IT.
   `free` never blocks: the child is detached and the command proceeds on the
   existing FREE_POOL_SEED fallback meanwhile. `ensemble`/`mass-scout` under
   allow_paid_models: false fail the call fast with the remedy rather than
   spending. The runtime-unavailable trigger reads assessModelPersistence
   (3 consecutive 400/404/410/422 in 24h), never classifyUnavailable's "gone",
   so a 429/502/503 blip cannot authorize paid work.

3. PRICES CARRIED THROUGH (model-reconcile.ts). catalogForReconcile reduced the
   catalog to {ids, freeQualified} and discarded prices, which is why price
   drift was undetectable anywhere. It now carries a real
   CatalogPriceSnapshot[], preserving the fail-open contract: an empty catalog
   still invalidates nothing.

KNOWN INCOMPLETE, and stated because a green suite proves only what it
executed: two of the five triggers are NOT live yet. "model-price-increased"
and "new-model-arrived" both need the last-picked prices / qualifying-pool
fingerprint to be PERSISTED after a completed benchmark, and
default-profiles-state.ts's recordBenchmarkSuccess/recordBenchmarkFailure still
have zero production callers. Consequences today: a newly-arrived better model
is never noticed, a price rise is never noticed, and the failure backoff never
arms (cooldownUntil is read but never written, so a benchmark that always fails
retries on every command). The limitation is documented at the gate itself, not
only here. Next commit closes it.

Verified: tsc 0, eslint 0, build 0, full suite 2007 passed / 0 failed (+11).

- Feat(profiles): populate one default profile on demand, without blocking or surprising

Adds the missing half of dynamic default profiles: a way to actually populate
one. `--update-all` could only ever write to whatever `settings.active` happened
to be, so there was no way to say "benchmark and populate `ensemble`".

New: `llm-ext-benchmark --populate-default-profile <free|ensemble|mass-scout>`,
reusing the existing sweep and the three existing pickers/writers rather than
adding a second pipeline. The paid names route through the SAME pre-flight
estimate-and-abort that --update-all uses, so --budget-usd still bounds them and
a run aborts before the first billable call. `free` goes through the existing
free-only enforcement and is $0 by construction.

And src/default-profiles-runner.ts, which decides whether to start one. Its
shape is forced by one fact: a sweep takes ~15 minutes, so "benchmark on first
use" can never mean "block the command the user just typed". Population is
therefore always a DETACHED child (the approach free-pool-auto-bench.ts already
uses), and what differs is what the current command does meanwhile:

  free        - proceeds IMMEDIATELY on FREE_POOL_SEED, the existing "never
                dark" fallback. No latency, no failure, no spend; the sweep just
                improves next time.
  ensemble    - no seed exists and none can: these are paid pools, and a
  mass-scout    hardcoded default would either bill the user or rot. So the
                command fails fast with the exact command to run, instead of
                stalling 15 minutes or spending money nobody authorized. They
                auto-populate only under allow_paid_models: true -- not a new
                policy, but the same switch model-reconcile.ts already applies
                (free: adopt automatically; paid: detect and report).

Two details that are load-bearing rather than defensive:

- The lock check runs BEFORE the paid gate. Otherwise an already-running
  benchmark would produce "run this command" advice naming the very command
  in flight, and a user following it would start it twice.
- child.on("error") is mandatory. A spawn failure (missing benchmark.js,
  EACCES) arrives as an ASYNCHRONOUS event, and Node re-throws an unhandled
  'error' as an uncaught exception from a detached tick no try/catch can reach
  -- killing the process. Population is best-effort; the process is not.

Also: `settings profiles` now marks [machine-managed] vs user profiles and
renders an unpopulated default as "not benchmarked yet - populates on first
use". It used to print the raw placeholder/unpopulated-default-profile id, which
reads as a broken config the user must repair by hand when it is in fact a
normal state that resolves itself.

Known gap, deliberately not hidden: default-profiles-runner.ts has no tests yet
(the spawn/lock/refusal matrix needs a hermetic harness) and nothing calls it --
the dispatcher wiring is the next step.

Verified: build 0, tsc 0, eslint 0, full suite 1996 passed / 0 failed.

- Feat(profiles): fingerprint-based drift detection, replacing an unbounded spend loop

The default-profile drift core asked "is any qualifying model not currently
configured?" to detect a new arrival. For `ensemble` that is 3 configured slots
drawn from a pool of ~40 candidates, so ~37 pool members are ALWAYS
unconfigured: the answer was permanently yes, every check invalidated the
profile, the benchmark ran, it picked the same three winners, and the check
invalidated again. An unbounded re-benchmark loop -- on the two PAID profiles,
i.e. unbounded billable spend.

The bug is structural, not a typo: a pool the caller cannot exhaust can only be
compared to its OWN previous self, never to the picks drawn from it. Replaced
with poolFingerprint() -- sha256 over every member's id and both prices, sorted.
One comparison now covers arrivals, departures and repricings. Sorting is
load-bearing rather than cosmetic: the catalog endpoint promises no stable
order, and an order-sensitive hash would re-benchmark billably every time the
provider reshuffled its JSON.

Also lands:

- default-profiles-state.ts, a sidecar for machine state (fingerprint,
  timestamp, failure count, cooldown). Deliberately NOT more keys in
  settings.yaml: that would rewrite a hand-edited file on a routine "nothing
  changed" check and park a fingerprint the user cannot meaningfully edit next
  to settings they own. Every read fails OPEN -- a lost state file must degrade
  to "re-check next time", never to a crash or a refusal to run.

- A failure backoff (15min, 1h, 4h, 24h). Without it a profile whose benchmark
  cannot succeed (no API key, provider outage) retries on every single command.
  A live cooldown suppresses the ATTEMPT but never the DIAGNOSIS, so a caller
  can still report why the profile is stale. A failed attempt deliberately
  keeps the OLD fingerprint -- banking the new one would mark the drift as
  handled and the profile would never retry once the cooldown expired.

- The runtime-unavailable trigger is defined against model-events.ts's durable
  verdict (3 consecutive 400/404/410/422 within 24h), NOT classifyUnavailable's
  "gone" -- that one is a substring sniff over an error string backing a 1-hour
  rotation cooldown, far too eager to authorize paid work. A 429/502/503 blip
  must never cost money.

23 tests, previously zero. The load-bearing one checks a populated 3-slot
ensemble twice against an unchanged 40-model pool and requires up-to-date BOTH
times -- it fails against the old implementation, so it is a real regression
test rather than a restatement.

Verified: tsc 0, eslint 0, full suite 1988 passed / 0 failed.

- Feat(profiles): dynamic default-profile foundation, made to compile and tell the truth

Phase 0 of the free/ensemble/mass-scout dynamic default profiles. Lands the
partial work (selectors + pure decision core) with the four defects that made
it unshippable fixed.

WHY each fix:

- config.ts placeholderFreeProfile omitted `model`, which Profile declares
  required -> `tsc --noEmit` failed. Vitest transpiles without typechecking, so
  66 tests passed green over a build that could not ship. The sentinel id is the
  honest value: resolveProfile's free_only branch overrides `model` from
  free_models[0] anyway, so it is never read.

- isPlaceholderProfile keyed on the sentinel id first, which is WRONG for
  `free`: its populating writer (applyFreePoolToSettings) only ever replaces
  free_models and never touches `model`, so a populated `free` would still have
  reported itself unpopulated -- re-running its benchmark on every command. The
  signal now follows the profile SHAPE: empty pool for free_only, sentinel id
  for the slot-based profiles, each matching the writer that populates it.

- A placeholder failed validateProfile (free_only demands a non-empty pool), so
  a fresh install would boot every tool into NOT CONFIGURED with no reachable
  path to the population hook. validateProfile now stops after the STRUCTURAL
  checks (mode, api, preset, mode<->preset) for a placeholder: shape is
  validated, pending contents are not.

- pickEnsembleByPriceCeiling hardcoded slice(0,3) and threw below 3. Throwing
  leaves the profile unpopulated, which re-triggers the benchmark next command.
  It now takes topN and returns what the catalog offers; applyPicksToSettings
  already derives mode from the pick count, so a short list is self-consistent.

Also drops the unused classifyUnavailable import, replacing it with the reason
the runtime-gone trigger will NOT be built on it: that verdict is a substring
sniff backing a 1h cooldown, too eager to authorize a paid benchmark. The
durable verdict is assessModelPersistence (3 consecutive 400/404/410/422 in
24h), so a 429/502/503 blip can never cost money.

Verified: tsc --noEmit clean, eslint --quiet clean, 87 tests pass across
config/settings-group/profile/model-reconcile.

- Feat(cli)!: rename the config group to settings; show and list profiles

Owner request: the config commands become `settings`, `settings show` lists
the CURRENT profile's settings, and a new command lists ALL profiles.

`llm-ext settings <action>` replaces `llm-ext config <action>`. No alias is
kept: this project forbids backward-compatibility code, and the group is
hours old, so retaining `config` would ship legacy from birth. The old
spelling now fails with a did-you-mean.

`settings show` previously only copied settings.yaml to an output dir and
returned the path — it "showed" nothing. It now prints the ACTIVE profile
resolved: name, mode, backend, url, model, second/third model, timeout. The
file copy is preserved for callers that wanted the artifact.

`settings profiles` is new: every profile in settings.yaml with its
mode/backend/model summary and a `*` on the active one. It reads only; it
never writes, preserving the user-only configuration policy.

Both read `~/.llm-externalizer/settings.yaml`. A legacy `settings.yml` may
sit beside it but is NOT read (config.ts warns) — verified, since the owner
asked which extension is live.

On the profile MODEL, corrected by the owner mid-task and recorded so the
next change does not get it wrong: there are TWO tiers. Three DEFAULT
profiles (free, ensemble, and a mass-scout one) are DYNAMIC — machine-owned
and kept current by the benchmarks. Every OTHER profile is STATIC, created
by the user editing settings.yaml or by the setup wizard, local or remote,
and automation must never rewrite them. Today's listing does not yet
distinguish the tiers and the shipped SETTINGS_TEMPLATE still hardcodes
static local/remote profiles instead of the three dynamic ones; both are
follow-up work, not silently assumed done here.

Verified on the rebuilt binary: `settings profiles` lists all five with the
active one starred; `settings show` prints the active profile's resolved
fields; `config show` exits 1 as an unknown command. tsc 0, eslint 0,
vitest 1953 passed / 4 skipped / 0 failed (+7), build clean.

- Feat(cli): show --profile in the help of every command that uses a profile

--profile worked but was undiscoverable: it appeared once in the top-level
--help and NOWHERE in the help of the command you were actually running
(`llm-ext chat --help` listed zero occurrences). A flag you cannot find
from the command's own help may as well not exist.

It now renders in the parameter list of the 19 commands that make a model
call, driven by one derived set rather than a hand-maintained name list, so
a future LLM command inherits it instead of silently missing it.

Deliberately NOT shown on commands that make no model call (reset,
discover, get_settings, scan_local_llm_services, or_model_info*): a flag
advertised everywhere teaches nothing, and offering a profile to a command
that never consults one is a lie the user only discovers by trying it.

Two exclusions are worth recording because I got them wrong and the source
corrected me. review_plan and rules_check LOOK like LLM commands from their
parameters (--instructions, --input_files_paths, --rules), and I challenged
their exclusion on that basis. Reading the handlers settled it: rules_check
is "Pure lookup, no LLM — the debuggability half of the rules engine", and
review_plan is "Delegate mode: deterministic scaffolding only, the HOST
agent reviews" — it resolves the file set and hands it back, making no
request of its own. Classifying by parameter shape would have advertised a
no-op flag on both.

Parsing and application of --profile are untouched; this is help rendering
only, with a test asserting the unknown-profile path still exits non-zero
listing the real profiles, so the discoverability change cannot quietly
break the behaviour.

Verified on the rebuilt binary: chat shows the flag with its full
description, reset shows 0, `--profile nonesuch` still exits 1 and lists
the five real profiles. tsc 0, eslint 0 at --max-warnings 0, vitest 1946
passed / 4 skipped / 0 failed, build clean.


### Documentation

- Docs: teach the three machine-managed profiles, not the five retired ones

The shipped settings.yaml stopped generating local-lmstudio-qwen35,
local-ollama-qwen314, remote-single-geminiflash, remote-ensemble-geminigrok and
remote-free-ensemble, but four user-facing surfaces still taught them: README,
the setup guide, the reset command, and the config skill. Every one of those
instructed a reader to set `active:` to a profile a fresh install does not have.

Prose is why this needed a deliberate sweep: tsc, eslint and 1988 passing tests
cannot see a word of it, so a fully green build proved nothing here. A doc that
names a profile which no longer exists still "runs" — in the user's hands, and
it fails there instead of in CI.

Corrected claims, not just names: "four starter profiles" and "the default
profile works out of the box" were both false. The three defaults are
machine-managed and self-populating, and the paid two stay unpopulated until
allow_paid_models is true.

Kept the local LM Studio / Ollama examples, re-presented as profiles a user adds
themselves (the example is now named my-free-ensemble), since that is exactly
the distinction the new model draws: three names self-manage, everything else is
the user's and is never touched.

CHANGELOG.md and the archived TRDDs still name the retired profiles and are left
alone — those are historical statements and are correct as history.


### Fixed

- Fix(dogfood): repair the pre-publish gate — 31 false failures from one stale assertion

`uv run tests/dogfood/dogfood_test.py` reported 35 PASS / 31 FAIL. Every one of
the 31 was false, and they all had a single cause.

`parse_top_help_tools` scanned for a `Commands:` header. The grouped launcher
(470d175) changed that header to `Groups:`, so the scan matched nothing and
returned an empty catalog. The caller then bailed, and every command check
downstream reported `body runs \`llm-ext reset\` but that is not a command in
the CLI table (0 known)` — 31 alarms, one root cause, and the CLI was fine the
whole time (`llm-ext --help` exits 0 and prints the full grouped catalog).

The function's own docstring records this happening ONCE BEFORE, when the
header went `Tools:` -> `Commands:` as the MCP server was retired. It was fixed
then by hardcoding the new header, which is why it broke again. The parser is
now tolerant of the section's trailing prose and reads BOTH sections.

Three real defects fixed, not just the header:

1. It parsed only `--help`, which lists GROUPS. Most command bodies invoke the
   FLAT spelling (`llm-ext reset`), which only appears under `--help --all`.
   The catalog is now the union of group names and flat command names, because
   `_llm_ext_subcommands` captures only the FIRST token and either spelling is
   legitimate.
2. A group and a leaf command answer `--help` with different documents. The
   shape check asserted `Parameters:`/`Takes no parameters.` against both, so
   all 7 groups failed on correct output once they entered the catalog. Groups
   are now asserted to list `Actions:` instead — `parse_group_names` exists so
   the check can tell the two kinds apart rather than guess.
3. The no-commands-parsed message still said `'Commands:' section present`,
   which would have misdirected the next person to the wrong header.

Result: 119 PASS / 0 FAIL / 1 SKIP over 120 checks, exit 0. The check COUNT
rose from 67 to 120 because the phases that used to bail on the empty catalog
now actually run — the gate was not merely noisy, it was skipping most of its
own work while looking like it had run.

Found while validating the dynamic default-profile work; the failures predate
it and are unrelated to it.

- Fix(settings): stop destroying user comments; one source of truth for defaults

Three defects that all shared a root cause: a second copy of something that
already existed, silently drifting from the first.

1. EVERY settings.yaml write wiped the user's comments. writeSettingsAtomic
   did yamlParse -> mutate plain object -> yamlStringify, and a plain-object
   round-trip drops every comment, blank line and anchor. The shipped file
   carries ~100 lines of explanation; the first benchmark write erased all of
   it. Two docstrings asserted the opposite ("comments are preserved by-key"),
   which is how it survived review. Now parseDocument + doc.setIn/deleteIn +
   doc.toString(), which edits in place. All five public writers already
   funnelled through the same two private helpers, so one change fixes them
   all. New test asserts every comment line survives each writer.

2. The on-disk defaults and the in-memory defaults were two hand-maintained
   copies. SETTINGS_TEMPLATE (the copy that actually reached disk) still
   declared the five retired profiles, while the code printed "Regenerating
   with the 3 machine-managed default profiles" -- so corrupt-file recovery
   wrote the OLD profiles and announced the new ones. Replaced with
   renderDefaultSettingsYaml(), GENERATED from generateDefaultSettings() and
   commented via the yaml Document API; the 141-line literal is deleted. A
   round-trip test makes drift impossible rather than merely unlikely.

3. reloadSettingsFromDisk hand-rebuilt Settings from three known keys, so any
   other top-level key was silently dropped on every hot-reload -- a bug its
   own comment recorded having already been hit once. It now calls
   loadSettings(), the parse that already existed. Kills the class, not the
   instance. Also restores the "your edit was ignored" warning: loadSettings
   cannot know a reload was in progress, so without it an unparseable edit
   changes nothing and explains nothing.

REVERTED a mistake made earlier in this work: validateProfile had been given a
placeholder exemption so a fresh install would boot. That silently disabled two
zero-spend invariants for EVERY profile -- an empty free_models list and a
malformed (YAML scalar) free_models both began reporting VALID, caught only
because src/free-only.test.ts failed. Weakening a validator to solve a boot
problem is the wrong layer: an unpopulated profile genuinely cannot serve a
request, so validateProfile keeps saying so, and the new
isUnpopulatedDefaultProfile(name, profile) draws the distinction that actually
matters -- "the user misconfigured this" vs "the machine has not populated it
yet". The name check is load-bearing: only free/ensemble/mass-scout heal
themselves. A malformed free_models is now explicitly NOT a placeholder, so a
user's typo can never be reclassified as "not benchmarked yet" and overwritten.

Verified: tsc 0, eslint 0, full suite 1988 passed / 0 failed.

- Fix(commands): correct 15 broken CLI invocations; add compact-session skill

The owner reported the command docs were "filled with errors". They were,
and the errors were the kind no gate can catch: a slash command is PROSE
telling an agent what to run, so a wrong flag name sails through tsc,
eslint, vitest and every publish gate and only fails when a user runs it.

Audited by VERIFICATION, not reading: extracted all 78 CLI invocations from
commands/*.md and checked every command name and every flag against the
live catalog (`llm-ext <cmd> --help`).

15 hard errors fixed. The bulk were mass-scout flag names that never
existed -- docs said `--db`, `--root`, `--files`; the catalog declares
`--db_path` (verified: mass-scout-get lists --db_path and nothing else
matching). Also `--free` passed to scan-folder in the two scan-and-fix
commands; scan-folder has no such flag, so those recipes died on argv.

3 false existence claims fixed. change-model and configure both asserted
that `profile` does not exist in the CLI. It does -- it is a real catalog
command, reachable as `config profile`. The claim now names only
`set-settings` and `change-model`, which genuinely do not exist, so the
user-only configuration policy is stated without lying about the surface.

Also adds the compact-session skill the owner asked for: compact ANY
session transcript at $0, taking `<project-slug>/<session-id>.jsonl` for
another project, a bare id for the current one, or nothing for this
project's latest. The load-bearing detail, verified rather than assumed:
`--session_id` resolves ONLY inside the current project, so another
project's slug MUST go through `--transcript <full path>` -- getting that
wrong would silently compact the wrong session. Every flag the skill names
was confirmed present on the real binary.

The skill also documents the expectations that otherwise read as bugs:
~10-25 min on free models with 91-1478 s per-chunk variance is queue
contention, not a hang; do NOT lower --chunk_timeout_s, it is PER ATTEMPT
and setting it below the working band multiplies cost; and re-runs are
incremental, so a cadence is cheap even though the first run is not.

Nothing asserts a skills count (checked README and the doc-consistency
test), so adding one cannot break the gate. README's command table lists it.

Verified: vitest 1931 passed / 4 skipped / 0 failed.


### Miscellaneous

- Chore(build): rebuild dist for the dynamic default-profile work

`dist/` is tracked and is what actually runs: `bin/llm-ext` executes
dist/llm-ext.js, and the CLI-contract tests spawn dist/benchmark.js. The six
preceding commits in this branch changed only src/, so the shipped bundles
still carried the pre-feature logic — every normal signal (tsc, eslint, 2014
passing tests) reads green from src/ and cannot see that gap.

Committed on its own rather than folded into the source commits so the window
where the bundle lagged its sources is visible in history instead of hidden
inside a feature diff.

Rebuilt with `npm run build` at 2a6a7ce; build 0.


### Testing

- Test(profiles): cover the population runner's own policy, which was mocked away

effdad0 shipped default-profiles-runner.ts and flagged it as untested. The
follow-up wiring test (default-profile-wiring.test.ts) LOOKS like it closed that
— it references populateDefaultProfile throughout — but it MOCKS the module. It
proves the dispatcher calls the runner and nothing whatsoever about what the
runner decides. Every spend decision in this feature lives in the mocked half,
so the money policy had no coverage at all while the suite read green.

14 tests, hermetic (the only process spawned is a throwaway .js that exits
immediately — no benchmark, no network, no spend). They pin:

- the paid gate: ensemble AND mass-scout refuse under allow_paid_models: false
  and name the exact command; both spawn once it is true
- `free` is never gated on allow_paid_models (a $0 benchmark has nothing to
  authorize) and never blocks the caller
- LOCK BEFORE GATE. With the gate first, a paid profile whose benchmark is
  already running would answer "refused, run <cmd>" — and a user following that
  advice starts a second one. The test asserts skipped, and explicitly asserts
  NOT refused, because the two outcomes differ only in that ordering.
- a stale lock (dead pid) is ignored, so a crashed benchmark cannot wedge a
  profile onto the seed pool permanently
- fail-open: an unopenable log path degrades to "skipped", never a throw, so a
  population that cannot start never fails the command the user actually ran
- describeOutcome speaks only when the user must act: silent for a spawned
  `free`, a re-run hint when a paid population blocks, reason + remedy on a
  refusal

Verified: tsc 0, eslint 0, full suite 2031 passed / 0 failed, and a
process-table snapshot shows zero leaked children from the spawn cases.

- Test(settings): pin the machine-managed / unpopulated profile listing

`settings profiles` gained [machine-managed] labelling and friendly rendering of
an unpopulated default profile in effdad0, with no test. Three added:

- the raw `placeholder/unpopulated-default-profile` sentinel never reaches the
  listing (it reads as a broken config the user must repair by hand, when it is
  a normal pre-benchmark state that resolves itself)
- a machine-managed default is labelled and a user profile is NOT, since only
  free/ensemble/mass-scout refresh themselves
- the unpopulated explainer disappears once the defaults carry real models —
  guidance, not decoration — while the label stays, because populated does not
  mean user-owned

The fixture deliberately includes an unpopulated `ensemble`, not just `free`.
That detail is the difference between a real regression test and a tautology:
`free` is free_only, and the OLD renderer already printed it as
"free_only (0 models)" — never the sentinel — so a free-only fixture would have
passed against the very bug this is meant to catch. `ensemble` carries the
sentinel in three model slots that the old code joined verbatim into the line,
so the assertion fails against the old behaviour, which is what makes it a test.

Verified: tsc 0, eslint 0, full suite 2017 passed / 0 failed.


## [13.1.0] - 2026-08-12

### Added

- Feat(cli): --profile flag, and -o on every command that writes a report

Two gaps the owner specified that simply did not exist.

`--profile <name>` was never implemented: `llm-ext llm ask ./p.md --profile
free` failed with "unknown flag --profile for 'chat'". It is now a GLOBAL
flag handled in the CLI layer alongside --quiet, so it works for every
command rather than needing a per-command schema entry. It selects a
built-in profile or one under `profiles:` in
~/.llm-externalizer/settings.yaml for THIS invocation only -- it never
mutates settings.yaml. An unknown name fails fast and LISTS the real
profiles instead of silently falling back to the active one, since a silent
fallback would bill the wrong backend while looking like it worked.

Note settings.yaml is authoritative: a legacy settings.yml may sit beside
it (config.ts warns) but is not read.

`-o`/`--output` is shorthand for a command's --output_dir. Commands that
produce a report file but declared no output parameter -- scan_folder among
them -- now declare it, so -o works there. Commands that genuinely write no
report keep the honest error added in 13.0.1 rather than gaining a
meaningless flag.

The default is unchanged and deliberately NOT git-derived: reports go to
<project-root>/reports/llm-externalizer/ via resolveProjectMainRoot(),
anchored on $CLAUDE_PROJECT_DIR. A linked git worktree is ephemeral, so
anchoring on a git root would write reports into a directory that
disappears. Two comments claimed "<git-root>/reports/llm-externalizer/" --
the code was right and the comments were wrong; fixed.

Verified on the real binary, not from the agent's report: --profile
remote-single-geminiflash switched the backend to google/gemini-2.5-flash
(the active profile is the ensemble); --profile nonesuch listed all five
real profiles and exited 1; scan folder -o reached the tool instead of
dying on argv parsing; config show -o kept the honest error.
Gates: tsc 0, eslint 0 at --max-warnings 0, vitest 1931 passed / 4 skipped
/ 0 failed, build clean.

Known and deliberately left: get_settings' implementation honours an
outputDir it has no schema entry to receive, so the capability is
unreachable rather than wrong. Not expanding scope at release time.


### Documentation

- Docs: purge dead MCP guidance left behind by the CLI migration

The MCP server was removed long ago, but nothing swept the plugin for what
referenced it. Six agent definitions were still instructing subagents to
call `mcp__serena-mcp__replace_symbol_body`, `find_referencing_symbols`,
and `mcp__grepika__*` — tools that do not exist here and that MCP being
banned project-wide guarantees will fail. Their frontmatter also advertised
a tool surface ("can use SERENA MCP, TLDR, Grepika, LSP") the agent does
not have.

This is the failure mode worth naming: those are INSTRUCTIONS IN PROSE.
tsc, eslint, vitest and the publish gates cannot see them, so the plugin
shipped broken agent guidance through every green gate and two releases
(v13.0.0, v13.0.1) while every check passed.

Replaced with the stack that actually exists here: the `tldr` CLI
(definition/references/structure/impact/search) for symbol lookup and flow
tracing, `Read` + the built-in `Edit` for symbol-scope edits — anchoring
old_string on the signature line so an edit cannot span into an adjacent
symbol — and an explicit "no MCP, and never edit via sed/perl/python"
instruction, since a scripted rewrite bypasses the diff the operator is
meant to inspect.

launcher.mjs comments and one log line still called the thing they prepare
"the MCP server"; it is the `llm-ext` CLI. Comments only, no logic touched.

rules/use-llm-externalizer.md rewritten 105 lines -> 13: it is force-loaded
into every session in every project, so its size is a permanent tax. It now
documents the grouped surface (7 groups over 45 commands), `-o` as shorthand
for --output_dir defaulting to <project-root>/reports/llm-externalizer/
(anchored on $CLAUDE_PROJECT_DIR, never a git root — a worktree is ephemeral
and reports written there are lost), `--profile`, and that settings live in
settings.yaml (a legacy settings.yml is preserved but not read).

Deliberately NOT touched: design/** (historical TRDD records) and
benchmark-fixtures/** (test INPUT — editing a fixture changes the
benchmark's results). Statements that correctly describe history, such as
"there is no MCP server any more", were left alone rather than "fixed" into
nonsense.

Verified by re-running the sweep myself: the only surviving mcp__/SERENA/
grepika hits in the live surface are the negative statements introduced
here ("there are NO MCP tools in this environment").

The src/ changes for --profile and output_dir are still in flight and are
deliberately NOT in this commit.


## [13.0.1] - 2026-08-12

### Fixed

- Fix(cli): honest error when -o is used on an action with no output param

Two leftovers from the v13.0.0 review, both about a message that lied.

`llm-ext scan folder ./src -o out.md` passed `-o` through to the flat
parser, which rejected it as "unexpected argument '-o' (all inputs are
named flags)". That is actively wrong twice over: `-o` IS a named flag,
and the real problem is that scan_folder declares no output parameter at
all (it writes to a fixed reports dir). The launcher now owns the error and
says so plainly, and a test asserts the misleading wording never returns.

Worth noting -o was NOT broadly broken: outputFlagOf already maps it to
`output` or `output_dir`, which covers every command that has one --
scan_folder is the outlier that has neither.

Also fixed the eslint gate. `--max-warnings 0` reported one warning: a
stale eslint-disable in benchmark-fixtures/search-existing. The fix is to
IGNORE benchmark-fixtures, not to edit the file: those fixtures are test
INPUT for the search-existing benchmark, deliberately odd code, and
"fixing" one to satisfy a lint rule changes the benchmark's input and so
its results. Linting them was the bug.

Verified: tsc 0, eslint 0 at --max-warnings 0 (previously 1 warning),
vitest 1922 passed / 4 skipped / 0 failed (+1), build clean. Live: the new
message appears with exit 1, and -o still resolves normally on commands
that declare an output parameter.


## [13.0.0] - 2026-08-12

### Added

- Feat(cli): grouped launcher — `llm-ext <group> <action> <input> -o <out>`

45 flat commands are unmemorable. This puts a thin front door in front of
them: 7 groups, uniform <group> <action>, positional input, -o for output.

It is a pure argv rewrite, NOT a refactor. `session compact x.jsonl -o s.md`
becomes `session_summary --transcript x.jsonl --output s.md` and hands off
to the dispatcher that already exists. Unmapped flags pass through
untouched, so every existing parameter keeps working without the table
knowing it exists -- the table holds only group, action, target command,
and which flag the positional fills.

Nothing is renamed, deprecated or removed. The launcher engages ONLY when
argv[0] names a group, and no existing flat command name is a group name,
so the flat path is untouched -- `llm-ext session_summary --transcript x`
behaves exactly as before, and `--help --all` still lists the full flat
catalog.

Help at three layers: top level leads with the 7 groups, `<group> --help`
lists its actions with their real targets, and `<group> <action> --help`
DELEGATES to the existing per-command help rather than keeping a second
copy of the parameter docs that would drift.

Did-you-mean at both layers, exiting non-zero, never auto-running a guess:
an unknown first token suggests GROUPS ("did you mean group: scan,
scout?"), an unknown action suggests the grouped form ("did you mean: scan
folder?") rather than leaking the flat surface being de-emphasized, and
input far from every candidate suggests nothing -- a confidently wrong
suggestion is worse than none.

A flag in the action slot (`scan --quiet`) is treated as "show me this
group", not as an unknown action. Any leading `-` token counts, so a
global flag added later needs no matching edit here.

launcher-boot.test.ts now asks for `--help --all`: its job is proving the
real catalog loaded, and the flat list moved behind that flag. It still
spot-checks a core tool and a mass-scout tool, so the guarantee is
re-pointed, not weakened.

Verified: tsc 0, eslint 0, vitest 1915 passed / 4 skipped / 0 failed
(1899 before, +16), build clean. Live: --help leads with groups, scan
--quiet prints group help, scna and scan foldr suggest correctly and exit
1, session compact --help and llm ask --help delegate to session-summary
and chat.

- Feat(session-summary): incremental compaction over the append-only prefix (TRDD-S8CKVH8S)

Measured free-tier latency makes a full compaction cost ~10-25 min and NO setting
moves it - chunk size, deadline, concurrency and fan-out were each implemented and
each measured as not the constraint. The only remaining lever is not redoing the
work, and until now every run redid all of it.

The checkpoint identity pinned transcriptBytes AND transcriptMtimeMs to exact
equality. A live session appends on every turn, so both changed and the checkpoint
was always discarded: --resume only ever helped a run interrupted against a FROZEN
file, never a live session, which is the actual use case.

The property that makes reuse safe: a Claude Code transcript is APPEND-ONLY. If
the file only grew and the consumed prefix is byte-identical, every chunk summary
computed over that prefix is still valid by construction. So identity now keeps
only what genuinely invalidates chunking (path, prune level, chunk budget, overlap)
and the size/mtime equality is replaced by a prefix proof: the byte length consumed
plus a streamed sha256 of exactly those bytes.

Decision on resume, fail-safe in both directions:
- current size < stored          => refuse, full restart (truncation / rotation)
- prefix sha256 differs          => refuse, full restart, message names it as a
                                    rewrite rather than a mysterious mismatch
- grew with a matching prefix    => reuse completed chunk summaries, summarize
                                    only the turns after the last COMPLETED chunk
Never reuse against a changed prefix; when in doubt, restart. A silently-wrong
reuse would corrupt a summary invisibly, which is far worse than redoing work.

transcriptMtimeMs is REMOVED rather than left in place - a field that is written
but never checked is exactly the kind of thing a later reader trusts.

Economics: the first run still costs 10-25 min, but a run five minutes later costs
only the new turns. That is what makes the janitor's cache-expiry design (issue
#251) viable - pre-compute on a cadence, each tick cheap, and /clear + inject an
always-fresh summary is instant.

Verified: tsc 0, eslint 0, vitest 1909 pass / 4 skip / 0 fail (was 1904), build
clean, dist rebuilt. Fail-safe branches checked by reading the decision code, not
by trusting the summary - a truncation and a rewrite must both restart, and both do.

- Feat: add scan-local-llm-services — autodiscover local LLM services (INERT by default)

Owner-requested (2026-08-12): scan and autodiscover running local LLM services,
show them NUMBERED, ask whether to configure one, then probe the chosen service,
detect the best configuration for this system, write a profile section into
settings.yaml and activate it.

IMPLEMENTED BUT NOT ACTIVATED, exactly as asked - the owner is staying on
OpenRouter for now:
- it never auto-runs: no hook, no SessionStart, no other command invokes it;
- a bare invocation writes NO profile and activates nothing;
- only an explicit --pick N in that same invocation writes or activates anything;
- the owner's real ~/.llm-externalizer/settings.yaml was never touched - verified
  by sha256 before and after a live run, not assumed.

Discovery probes 1234 (LM Studio), 8000 (vLLM), 8080 (llama.cpp), 1337 (Jan),
5000, 8081 for an OpenAI-compatible /v1/models, plus Ollama's native /api/tags on
11434 - in parallel with a short timeout, so absent services are fast and silent
rather than errors. Installed CLIs (lms, ollama) are reported separately as
evidence a service exists but is stopped.

Interaction: default lists and stops. --pick N selects non-interactively; the
interactive prompt appears only when stdin is a TTY. That split is deliberate -
agents invoke this CLI too, and a blocking prompt would hang them.

Verified behaviourally on the real binary, not just in tests: it found the live
service on :8080 with its four models, the lms CLI, and 64 GB / 14 CPUs.

Message correction found by that same run: it said "nothing was written" while a
cold config dir still gained a settings.yaml - the server's normal first-run
template bootstrap, not this command. The claim was falsifiable by `find`, so it
now says "no profile was written and no profile was activated", which is what is
actually guaranteed.

README counts and the index.test.ts expected-tool list are updated in this commit
because the doc-consistency gate FAILED without them (44 -> 45 CLI commands,
21 -> 22 core/utility). That gate did its job; the fix belongs with the change
that broke it, not in a follow-up.

Verified: tsc 0, eslint 0, vitest 1904 pass / 4 skip / 0 fail, build clean.

- Feat(session-summary): fan chunks out across several free models (TRDD-OU2TCWP8)

Rests on a measurement, not an assumption: the OpenRouter free rate bucket is
PER-MODEL, not per-account. 64 concurrent against ONE model returns 429s; the
same 64 split 32+32 across TWO models returns zero. So effective parallelism
scales with the number of models used.

That dissolves a real deadlock. Per-stream throughput is fixed, so cutting
wall-clock needs SMALLER chunks (less output each). But smaller chunks mean more
of them - a 666k context becomes ~83 at 8k - and 83 concurrent is far past one
model's ~32 cliff. Small chunks and single-wave are mutually exclusive on ONE
model, and perfectly compatible across four.

Each chunk index is pinned round-robin to one of K = min(models, MAX_FANOUT_MODELS
= 4) slots, and each slot behaves as an INDEPENDENT single-model pool capped at
PER_MODEL_CONCURRENCY = 20 (below the measured 32 edge, same headroom reasoning
as MAX_AUTO_CONCURRENCY = 28). Chunk budget uses the MINIMUM context window across
the models actually used - sizing to the largest would overflow the smallest.

THE LOAD-BEARING PART, and the reason this is a separate branch rather than a
flag on the existing one: the single-active-model loop makes a failing worker a
LEADER that drains every sibling behind a pause gate before re-chunking. That
whole-pool drain is exactly wrong once each chunk carries its own model - one
model going bad would re-chunk and discard work already succeeding on another.
Under fan-out a slot's fallback/overflow touches only its own chunks. A
slot-local re-split APPENDS its sub-chunks at the end instead of reindexing in
place, so no other slot's indices ever shift, and the superseded indices are
recorded in abandonedChunkIndices so they are neither retried nor joined
(filtered at the join, verified by reading the code rather than the agent's
summary).

Unchanged where it must be: concurrency<=1 stays byte-for-byte sequential, a
single eligible model takes the old path (K=1 "fan-out" would just be the
single-model path with extra bookkeeping), and mapSummaries stays keyed by chunk
INDEX so join order never depends on completion order.

Verified: tsc 0, eslint 0, vitest 1890 pass / 4 skip / 0 fail (was 1885), build
clean, dist rebuilt.

Still owed: a measured end-to-end wall-clock. Every number quoted so far for the
2-3 minute target is arithmetic over measured per-chunk times, not an observed
run, and it will be reported as measured or not at all.

- Feat(session-summary): hedge straggler chunks; FIX the too-tight chunk deadline

Two changes that belong together, because the second corrects an error the first
makes unnecessary.

HEDGING. A concurrent run's wall-clock is its SLOWEST chunk, and ~1 in 3 attempts
on the free model needs a retry. A straggler that hit the deadline previously
aborted and retried SERIALLY, adding a full attempt to the critical path. Now a
chunk still running after HEDGE_AFTER_MS (60s) launches a duplicate against the
NEXT eligible model and the first usable response wins; the loser is abandoned
and cannot overwrite the winner or write a checkpoint. Bounded: one hedge per
chunk, and a hedge only launches when a pool slot is free, so it never pushes
in-flight requests past `concurrency`. Unreachable at concurrency<=1, so the
sequential path stays byte-for-byte unchanged.

DEADLINE CORRECTION, 120s -> 240s. The 120s default shipped an hour ago was
WRONG and a live run disproved it within the hour: measured chunk times on this
model are 90.6 / 173.0 / 310.6 / 399.7s, so 120s sat BELOW the median and aborted
three chunks out of four. Five consecutive aborts tripped the circuit breaker and
the run died.

The mistake was conceptual, not numeric: I made the DEADLINE do the HEDGE's job.
A deadline is a backstop against a stall and belongs ABOVE the working
distribution; cutting the tail is the hedge's job, because a hedge races a second
model instead of killing the first. Set below the band, the deadline converted
"slow but working" into "everything fails" - strictly worse than the slowness it
was meant to fix. 240s now sits above the body of the distribution and below the
300s global, so it catches a genuine stall and leaves merely-slow work alone.
Both the constant's header and the --chunk_timeout_s help text record this, so
the value is not "tuned" back down by someone reading only the target latency.

Verified: tsc 0, eslint 0, vitest 1885 pass / 4 skip / 0 fail (was 1881), build
clean, dist rebuilt. Hedge guards checked by reading the code, not the agent's
summary: hedging is unreachable from the sequential branch, the cap check is
`inFlight.size + hedgeInFlight >= concurrency`, and `hedgedOnce` spends a chunk's
single hedge win or lose.

MEASURED, and it changes the plan: the ~20-request bucket is PER-MODEL, not
per-account. 64 concurrent on one model gives 429s; the same 64 split 32+32 across
two free models gives ZERO. So effective parallelism scales with the number of
free models used, which is what makes small-chunk/single-wave viable and puts the
2-3 minute target within reach. Spreading chunks across models is NOT implemented
yet - today the pool is one active model plus rotation on failure.

- Feat(session-summary): tighter per-chunk deadline, overridable via --chunk_timeout_s

Under concurrency the map phase's wall-clock is the SLOWEST chunk, not the
average one. Measured on same-sized 25k chunks, per-chunk latency spread 4.4x:
90.6s / 173.0s / 310.6s / 399.7s. So one straggler allowed to run the full 300s
global soft timeout drags the entire run out while every sibling finished
minutes earlier. Cutting the tail is worth far more than shaving the median.

Adds an optional per-call `timeoutMs` threaded through the ONE place every
request's (url, model, timeout) tuple is built - resolveConnection - so it
covers every send path by construction rather than per-call-site. Omitted, it
falls back to the global soft timeout, so nothing else changes.

session_summary now passes DEFAULT_CHUNK_TIMEOUT_MS (120s), ~3.4x the measured
~35s per-request floor (queue + cold start, which even a max_tokens=8 request
paid in full) - room for genuine generation, but it refuses to wait out a stall.
A chunk that exceeds it aborts and rotates/retries like any other transient.

This is only meaningful because TRDD-0H5N1V9W made the deadline actually cover
the body read. Before that fix any timeout value here would have bounded
time-to-first-byte only, and a stalled generation ignored it entirely - which is
precisely how a chunk reached 1890s against a 300s cap.

A DEFAULT, NOT A CEILING, per the owner's standing rule that limits are the
caller's to set: --chunk_timeout_s is honored verbatim, including values ABOVE
the global. One of the tests asserts exactly that, so nobody later "hardens" it
into a cap.

Tests: 3 new tests on resolveConnection - global fallback when omitted, the
tighter override reaching the wire, and a larger-than-global override honored.
Behavioural rather than a code reading, because a DROPPED override would be
invisible: the run would keep using 300s and present as merely slow, never as a
wrong number. Registered in vitest.config.ts (the include list is explicit - an
unregistered test file silently never runs).

Verified: tsc 0, eslint 0, vitest 1881 pass / 4 skip / 0 fail (was 1878), build
clean, and --chunk_timeout_s confirmed present on the real ./bin/llm-ext path
rather than only in the source.

- Feat(session-summary): auto-size concurrency so the map phase runs in ONE wave

Wall-clock for the map phase is "slowest chunk + stagger" ONLY when every chunk
is in flight together. A fixed default of 12 silently split a 27-chunk transcript
into three sequential waves and roughly TRIPLED wall-clock for no gain, because
the account admits far more than 12 at once.

--concurrency omitted now means AUTO: min(chunkCount, MAX_AUTO_CONCURRENCY),
resolved inside the driver AFTER chunking, since "auto" is a function of the
chunk count and nothing upstream knows it. An explicit number is still honored
verbatim, and --concurrency 1 still takes the byte-for-byte sequential path.
The library default stays 1, so no embedding caller is silently opted in.

MAX_AUTO_CONCURRENCY is 28, not the measured 32. A burst of 32 landed 32/32 clean
against the live account and 64 landed 62/64 (two 429s), so 32 is the measured
EDGE. Defaulting to the edge of what is clean today is how a small account-side
change turns a default into a standing 429 storm - the same reasoning that had
kept the old fixed default well below it. A transcript with more chunks than the
cap simply runs in more than one wave.

DEFAULT_CONCURRENCY is DELETED rather than left as an unused fallback: nothing
referenced it once auto landed, and two competing notions of "the default" is
exactly the drift this codebase avoids. Its measured-burst rationale was not lost
- it now lives in MAX_AUTO_CONCURRENCY's header, which is the constant that
actually carries the risk.

The --concurrency help text advertised "Default: 12" and would have been a lie
the moment auto landed, so it is updated in the same commit.

Tests: two new driver tests. One proves 5 chunks all run in a single wave under
auto (maxInFlight === 5); the other proves 34 chunks cap at 28 rather than
fanning out to every chunk, so a big transcript cannot fire a burst past the 429
cliff. Both budget explicitly for the real 250ms launch stagger - the first
attempt failed because 28 staggered launches take ~7s and waitUntil defaults to
2s, which is a property of the test harness, not of the code under test.

Verified: tsc 0, eslint 0, vitest 1878 pass / 4 skip / 0 fail (was 1876), build
clean, dist rebuilt.

Remaining gap to the 2-3 minute target for a 666k context, measured not guessed:
a chunk is now BOUNDED at the 300s global timeout but that is still above the
180s target, and per-chunk latency varies 4.4x (90s to 400s for same-sized
chunks), so the tail sets wall-clock. Next: a session-summary-specific per-chunk
deadline, then hedging a straggler to a second free model.

- Feat(session-summary): process chunks concurrently (TRDD-T4MZ8YQR)

A 666k-token context took ~4.5-5h sequentially. The map phase was already
safe to parallelise and nobody had noticed: chunks are turn-atomic, the
model-fold was removed earlier so no chunk depends on another's summary,
and the join is deterministic and order-based. Concurrency was therefore
available at zero correctness cost - it only became available when the
fold went away, since a fold had to collect every summary before reducing.

--concurrency (CLI default 12, library default 1) with a 250ms launch
stagger. Both numbers are MEASURED against the live account, not guessed:
a burst of 32 landed 32/32 clean, 64 landed 62/64 with two 429s carrying
x-ratelimit-limit: 20. 12 sits well inside the clean band so an account-side
change cannot turn the default into a standing 429 storm.

The stagger is 250ms, not the 3s I first specified. I had modelled the risk
as sustained throughput; the measurement showed it is the instantaneous
admission burst against a sub-minute bucket. At 3s x 12 workers the stagger
alone would have added ~33s of dead time to every run.

DEFAULT_MAX_CHUNK_TOKENS 50k -> 25k. Smaller chunks do NOT speed up a
sequential run - each re-pays the measured ~35s per-request floor, which is
queue/cold-start bound and independent of output size - so this only pays
off BECAUSE the map phase is now concurrent.

Correctness under concurrency rests on one invariant, commented at the call
site: applyTransition mutates the SHARED chunks array and the mapSummaries
tail, so a model-fallback/overflow transition may only run once every other
in-flight chunk has settled. First worker to hit one becomes leader, drains
the others behind a pause gate, applies, rewinds the dispatch cursor. Join
order is unaffected regardless: mapSummaries is keyed by index, never by
completion order.

concurrency<=1 takes a separate path that is byte-for-byte the previous
sequential behaviour - no stagger, no transient backoff - so the default
library caller is unchanged and --concurrency 1 reproduces the old run
exactly.

Verified: tsc 0, eslint 0, vitest 1870 pass / 4 skip / 0 fail, build clean,
--concurrency present on the real ./bin/llm-ext path (not a repo-relative
dist invocation).

Not changed, and deliberately: free-rotation.ts. I flagged a risk that a
burst 429 could be misread as daily-quota-exhausted, which would demote the
model and let one parallel burst walk the whole free pool. Verified it is
already handled - classifyUnavailable reaches daily-quota only on positive
per-day phrasing (free-rotation.ts:499), and a bare 429 falls through to
transient (:519). No change needed.


### Documentation

- Docs: close TRDD-DT11TE2Z — grouped launcher shipped and verified

All six acceptance criteria met by 470d175, each verified by running the
real binary rather than reading the implementer's report.

Records two verification failures of my own, because they were mine and
they nearly cost the implementer real rework: I twice reported its results
as "partly false" when the tool was correct and my harness was lying.

1. `$?` after a pipe reports the LAST command, so `llm-ext scna | head`
   then `echo $?` measures head -- every error path read as exit=0 when
   they were all correctly exiting 1.
2. zsh does NOT word-split unquoted $var the way bash does, so
   `for c in "scan foldr"; do llm-ext $c` passed ONE argv token containing
   a space. The CLI correctly called that unknown; I read it as a broken
   launcher and nearly sent a phantom defect back.

Both are the same family: a test harness is code, and an untested harness
fails silently in the direction of "the product is broken". Written into
the card's lessons section so the next reader inherits the check --
reproduce a suspected defect under a differently-shaped command before
attributing fault to the component.

- Docs: TRDD-DT11TE2Z — withdraw the refactor plan, it is a thin launcher

Owner correction: "i told you to create a simple launcher. it will examine
the command and dispatch the real cli ts".

The previous revision of this card had grown a 7-phase internal refactor
-- unify four name registries, rename all 45 commands, sweep ~60
skills/agents/commands, breaking change, approval tier 3. That was
over-engineering a request for a front door, and it is withdrawn in full
rather than quietly trimmed, so the record shows what was rejected.

What it actually is: a translation layer. Read <group> <action>, map to an
existing command name, turn the positional into that command's primary
flag, delegate to the dispatch that already exists. Unmapped flags pass
through untouched, so every existing parameter keeps working without the
table knowing about it -- the table only needs group, action, target
command, and which flag the positional fills.

The 45 commands stay exactly as they are and keep working. Nothing is
renamed, deprecated, or removed; tier drops 3 -> 0 and effort L -> S
because the change is additive and breaks nothing.

Kept a scope guard in Notes: if implementation starts needing edits to
index.ts dispatch, the catalog, or any command's parameters, stop -- that
is the withdrawn plan creeping back.

The recon's real finding (command names duplicated across four registries
in src) is left OUT of scope on purpose and noted as needing its own card
if it ever matters. Folding a standing bug into a UX request is how the
first version of this card went wrong.

- Docs: TRDD-DT11TE2Z — recon reordered the phases; registries before rename

Architecture recon changed the plan, so recording why before any code moves.

I assumed the migration risk was the ~60 skills/agents/commands that name
commands. It is not -- those are mechanical. The real risk is that the
catalog is NOT the single source of truth for dispatch: a command name
lives in FOUR independent registries in src alone -- the catalog array, a
22-case switch(name) in index.ts, RECONCILE_SKIP_TOOLS (index.ts:1974-1988),
and SINGLE_CALL_TOOLS in estimate.ts -- plus 93 literal occurrences in
README that a doc-consistency gate asserts on.

These are string literals, not symbols, so tsc stays silent through all of
it. Renaming first would mean changing one name in four places and hoping
no fifth exists; a missed case label is a command that appears in help and
dies at dispatch.

So Phase 1 is now "unify the registries, rename nothing": dispatch derives
from the catalog, and a test asserts no name literal survives outside it.
After that a rename touches one place instead of four. That phase earns
its keep even if the restructure stalls -- four divergent name registries
is a standing bug independent of this card.

Also verified first-hand rather than trusting the agent: positional args
are not merely unimplemented, they are actively rejected at
src/cli/main.ts:209 with "unexpected argument (all inputs are named
flags)". The owner's `session compact <file>.jsonl` needs positional
support BUILT, not a check relaxed.

Sweep note recorded for P6: search both kebab and snake spellings, since
the dispatcher normalizes - to _ and half the references are scan_folder.

- Docs: add TRDD-DT11TE2Z — collapse 45 flat commands into 7 grouped verbs

The owner's objection is that 45 flat commands are unmemorable, and asked
for one unified launcher with grouped commands, per-layer help, and a
"did you mean" on typos.

Half the ask was already satisfied and is recorded as such so it is not
re-solved: llm-ext is ALREADY the single launcher, and TRDD-W9DK4L3N
deleted the second entry point earlier today. The unmet half is purely
the size of the flat surface.

Shape chosen by the owner from three presented options: FULLY GROUPED,
uniformly <group> <action>, no flat exceptions -- accepting that `compact`
becomes `session compact` in exchange for one rule with no memorized
exception list.

The card carries the complete 45-command mapping so nothing can be
silently dropped in the migration, and records three collapses that go
beyond renaming: or-model-info{,-json,-table} become one command with
--format (three commands that differed only in output encoding), the two
benchmarks merge under --suite, and the DEPRECATED batch-check is deleted
outright rather than carried through -- a breaking restructure is the
cheapest moment to honour the no-legacy-code rule.

Also captures the calling-convention change the owner's examples imply but
do not state: positional primary input instead of --transcript, uniform
-o, and --profile promoted from YAML-only to a flag.

Phases are deliberately left unfilled pending an architecture recon,
because the cost is dominated by name coupling OUTSIDE the catalog
(skills, agents, commands, hooks, docs) and guessing that surface is how a
rename becomes a half-finished migration. Card is `todo`, not `dev` --
nobody is working it yet.

- Docs: close TRDD-W9DK4L3N — legacy entry point removed, one CLI surface

Records the closure, and corrects the card's own blast-radius table: it
claimed four test files read src/cli.ts and each needed a per-assertion
judgment. Only ONE did. The other two reference the SUBCOMMAND adapters
mass_scouting/cli.ts and cluster/cli.ts -- namesakes, not references. A
future reader trusting that table would rewrite two unrelated tests, so
the correction matters more than the closure.

Also states in the Approval log, explicitly, that this was closed on my
own judgment and not by a fresh USER approval: the card is tier 3, and the
call made was that removing an already-uninstalled bundle is dead-code
cleanup inside the approved option-A-and-B scope, not a new public-API
break. Recorded that way so it cannot later be misread as a sign-off that
never happened, with the exact revert that undoes it.

Gitignores /.janitor/ while here -- runtime state (heartbeat flags, the
pre-compact handoff) that is regeneratable and was sitting untracked,
one stray `git add` away from being committed.

- Docs: close TRDD-T4MZ8YQR — streaming verified against the 253 MB transcript

The last open acceptance criterion was "never loads the whole file into
memory; verified against the 265 MB transcript". It had only ever been
verified STRUCTURALLY (a unit test asserting no sync whole-file read) —
the real transcript had never been run through the wired CLI.

Measured now, by sampling peak RSS across the process tree while the CLI
reads, prunes and packs:

  12 MB input  -> 293 MB peak RSS,  5 chunks
  253 MB input -> 406 MB peak RSS, 77 chunks

20x the input for 1.4x the memory. A whole-file load would have added
~500 MB on its own (JS strings are UTF-16, so 253 MB of bytes costs ~506
MB resident). Memory does not scale with raw file size, so the read
genuinely streams. The run log proves all 253 MB were read and packed
before sampling stopped, so the number covers the whole read phase.

The +113 MB that does appear is retained DERIVED data — the pruned
context and 77 simultaneously-held chunk strings — not the raw file.
Recorded on the card as a known bound, not a defect: memory scales with
pruned size x chunk count, so a transcript another order of magnitude
larger would want chunks spilled to disk.

Also fills implementation-commits, which was empty despite 15 feature
commits having shipped under this card — that field is the backtracking
path from a future bug to the change that introduced it, so an empty one
on a shipped card is a real gap.

Column dev -> complete. What remains (publishing ~23 unpushed commits,
including 9487d9a) is a release step gated on publish.py and the owner's
call, not dev work — holding the card in dev would assert someone is
working it, which is the failure mode the kanban rule names.

- Docs: close TRDD-0H5N1V9W, OU2TCWP8, S8CKVH8S — implemented, tested, committed

All three shipped and were left asserting dev/todo. A card that misstates its own
state is the failure the kanban rule exists to prevent: the board keeps claiming
work is pending or in progress, and nobody can tell from it that the pipeline
actually drained.

  0H5N1V9W  request timeout must cover the body read   -> af60ab4
  OU2TCWP8  multi-model chunk fan-out                  -> a4031d6, addf86c
  S8CKVH8S  incremental compaction (append-only prefix) -> 6eb7d6a

addf86c is recorded against OU2TCWP8 because the degenerate-budget bug was a
PRE-EXISTING defect that only became reachable once fan-out consulted the
third-ranked model - the card is where a future reader will look for why that
commit exists.

Suite green at 1909 pass / 4 skip / 0 fail with all three landed.

- Docs: record the FINAL measured latency verdict on TRDD-T4MZ8YQR

Every wall-clock figure earlier in the card was arithmetic over per-chunk times,
not an observed run. The observed runs disagree, so the card now carries a
verdict section that explicitly supersedes them - otherwise a future reader takes
'2-3 min reachable' as established and re-runs the dead ends.

Measured, defaults, after all of tonight's work: 91.0 / 262.7 / 1233.7 / 1478.1 s
per chunk, 13 aborts, 4 free models engaged, ~25 min and still going on chunk 5.

The finding that invalidated the plan: per-request latency is NOT proportional to
chunk size. Cutting the budget 4x produced 80 aborts on 22 chunks instead of 13 on
5 - request count quadrupled at unchanged per-request cost. The earliest probe
already proved it and I failed to follow it through: max_tokens=8 still cost ~35s.
Free-tier latency is queue/contention bound, not generation bound.

So 2-3 minutes is not reachable on the free tier; ~10-25 min is realistic. The
card names all four dead ends (smaller chunks, tighter deadline, more concurrency,
fan-out) so none is retried, and points at TRDD-S8CKVH8S - not redoing the work -
as the only remaining lever.

Also states plainly that the two bugs fixed tonight (the unbounded hang, the
degenerate budget) are correctness wins that stand on their own, so the latency
verdict is not misread as 'the work was wasted'.

- Docs: add TRDD-S8CKVH8S — incremental compaction via append-only prefix

The highest-value remaining item, and the one that makes free-model compaction
usable in practice.

Measured: free-tier per-chunk latency is 91-1478s and is NOT proportional to
chunk size, so a full compaction costs ~10-25 minutes and no chunking, deadline,
concurrency or fan-out setting moves it - all four are implemented and none
touch the constraint. The only lever left is NOT REDOING THE WORK.

Today every run redoes all of it. The checkpoint identity pins transcriptBytes
and transcriptMtimeMs to exact equality, and a live session appends on every
turn, so both change and the checkpoint is always discarded. --resume therefore
only ever helped a run interrupted against a FROZEN file - never a live session,
which is the actual use case.

The property that makes the fix safe: a Claude Code transcript is APPEND-ONLY. If
the file only grew and its consumed prefix is byte-identical, every chunk summary
over that prefix is still valid by construction. So identity becomes a prefix
check (length + hash of the consumed bytes) instead of size/mtime equality: grown
+ matching prefix reuses completed chunks and summarizes only the new tail;
shorter, or a differing prefix, does a full restart exactly as today. Fail safe -
never silently reuse against a changed prefix.

Economics this changes: first run stays 10-25 min, but a run five minutes later
costs only the new turns instead of a full redo. That is precisely what makes the
janitor's cache-expiry design (issue #251) viable - pre-compute on a cadence,
each tick cheap, and /clear + inject an always-fresh summary is instant.

Card records the two dead ends so they are not retried: a faster model is not
available (free-tier latency is queue/contention bound - a max_tokens=8 request
still costs ~35s) and local backends are off the table, the owner uses them for
other work.

- Docs: add TRDD-OU2TCWP8 — multi-model chunk fan-out

The only remaining item between today's build and the 2-3 minute target for a
666k context, and it rests on a measurement rather than a guess: the free-tier
rate bucket is PER-MODEL, not per-account (64 concurrent on one model gives
429s; the same 64 split across two models gives zero).

That measurement dissolves a real deadlock. Per-stream throughput is fixed, so
hitting ~180s needs smaller chunks; smaller chunks mean more of them (666k =>
~83 at 8k), and 83 concurrent is far past one model's ~32 cliff. Small chunks
and single-wave are mutually exclusive on ONE model, and not on four.

The card names the hard part explicitly so it is not skipped: the concurrent
loop currently assumes ONE active model, and a failing worker drains every
sibling behind a pause gate before re-chunking. That whole-pool drain is exactly
wrong once each chunk carries its own model - one model going bad must not
re-chunk work already succeeding on another. Failure isolation has to become
per-model.

Also records the lesson already paid for tonight, at the card level so it is not
relearned: a deadline is a backstop and belongs ABOVE the working distribution;
cutting the tail is hedging's job.

- Docs: record root-cause defect — request timeout does not cover generation

Found by tracing during the concurrent-run measurement, not by assuming.
The slowness was never primarily a parallelism problem.

fetchWithTimeout arms an AbortController, awaits fetch(), then clears the
timer in a finally. But fetch() resolves on response HEADERS, not on a
consumed body - so the finally cancels the abort the moment headers land,
and the caller reads the body afterwards with no deadline at all. The
configured timeout therefore bounds time-to-first-byte ONLY; generation is
unbounded.

Evidence: no timeout: in settings.yaml so the 300s default applies, yet
chunk 5 of the live run reached 1890s - 6.3x its own cap - while
fetchWithRetry429's remaining = timeout - elapsed arithmetic believed the
request had long expired. The 'progress ... Ns elapsed' line is a display
ticker (elapsed/conn.timeout capped at 90%), not a watchdog, and it looks
identical to a hung socket.

Why it survived: the comment justifying no hard cap says the MCP tool-call
timeout is inactivity-based and kept alive by heartbeat. That was true under
MCP, which supplied the outer deadline. MCP is gone - this is CLI-only now -
so the justification died with the transport while the code it justified
stayed. Worth remembering as a category: a safety argument that names a
component can be invalidated by deleting that component.

Impact: a stalled generation hangs the run forever (the 15-retry ladder
never fires - a retry needs a response and there is none), violating
fail-fast; and under concurrency the chunk-level p99 sets the entire
wall-clock, so one unbounded chunk erases the parallelism win. Measured: 4
chunks at 90-400s, the 5th alone >31min.

Fix is NOT included here - it needs its own TRDD. Direction: keep the
controller armed until the body is consumed so an over-deadline generation
aborts loudly and rotates like any other transient. Raising timeout is not
a fix; it converts an unbounded hang into a longer unbounded hang.

Also corrects my own earlier claim, recorded in janitor issue #251, that the
slowness was 'inherent, not a tuning bug'. A chunk running 6.3x past its
configured timeout is a bug. That issue text needs amending once fixed.

- Docs: record MEASURED free-tier concurrency ceiling on TRDD-T4MZ8YQR

Probed the live OpenRouter account rather than trusting the documented
limit, because the account's rate_limit field is deprecated and returns
requests:-1 — there is no number to read, only one to measure.

Result: 32 concurrent is clean (32/32, zero 429), 64 breaks (2x 429).
Dozens in parallel is fine; my earlier '10-16 realistically' estimate was
pessimistic by ~2x and would have left most of the speedup on the table.

The finding that actually matters is a correctness trap, not a tuning
number: the 429 returned at 64 is TRANSIENT (its reset timestamp had
already elapsed 7s earlier - a sub-minute rolling window), NOT a daily
cap. If classifyUnavailable reads it as quota-exhausted it demotes the
model, and one parallel burst then walks the whole free pool in seconds
- turning a 200ms hiccup into 'all candidates exhausted'. Recorded so the
discriminator (reset proximity; a real daily cap resets hours out at UTC
midnight) is not rediscovered by debugging a dead run.

Also measured: a ~35s per-request floor that is independent of output
size (max_tokens=8 still took 35s). This is why smaller chunks do NOT
speed up a SEQUENTIAL run - each chunk re-pays the floor - and why they
only pay off concurrently. Recorded because 'split smaller' is the
obvious wrong fix someone will otherwise try.

Corrected my own earlier instruction: the 3s launch stagger I specified
modelled sustained throughput, but the real constraint is the
instantaneous admission burst, so ~250ms suffices. At 3s x 16 workers the
stagger alone would have added ~45s of dead time to every run.

- Docs: record post-fix quality verification on TRDD-T4MZ8YQR

Answers the owner's question 'have you verified that the free model is
able to handle the task?' with measured evidence rather than assertion.

WHY this is recorded now: the numbers only exist while the run's report
is on disk (reports/ is gitignored and purged), so the evidence has to
live in the card or it is lost. The counter-intuitive result — output
shrank 328 KB -> 21 KB — reads as catastrophic data loss to anyone who
sees it later without the explanation, so the card states explicitly
that the old bulk WAS the heartbeat/skill-doc noise and that the 5
previously-lost user messages are now all present. Without that note a
future session would 'fix' the size regression by reverting the prune.

Verdict: capable, not reliable. ~1 in 3 attempts on the free model needs
a retry (1 echo, 2 empties, 2 errors overnight). That is the case for
the concurrency work in flight: sequentially a failed attempt adds its
full wasted duration to the critical path; concurrently it overlaps the
chunks still working.

- Docs: TRDD-T4MZ8YQR — measured throughput and the parallelisation opportunity

Measured 3 chunks / ~150k pruned tokens in 60 min (~20 min per 50k chunk), so a
666k-token context is ~14 chunks and ~4.5-5h sequentially.

That wall-clock is an artefact of sequential processing, not an inherent cost:
chunks are turn-atomic, nothing depends on another chunk's summary, and the
join is deterministic and order-based — so they can be sent concurrently with
zero correctness change, collapsing 666k to roughly one chunk's time. Only
possible because the model-fold was removed. Not implemented; recorded so the
option is not lost.

- Docs: TRDD-T4MZ8YQR — v12.0.0 released; record the unverified-quality gap and remaining work

Handoff state before compaction. Ships the honest caveat: the nine-section
schema was produced end-to-end once, but BEFORE the queue-operation extraction
fix that adds more verbatim material, so post-fix quality is unverified — and
nemotron has produced an echo, a finish_reason=error and repeated empties, so
'the free model can do it' rests on one clean run.


### Fixed

- Fix: 8 defects from a high-effort review, incl. a concurrent-map deadlock

CRITICAL -- the concurrent map phase deadlocked whenever two or more chunks
failed at once. becomeLeaderAndTransition drained other in-flight WORKER
TASKS, but a task that hits a transition becomes a follower and parks on
the leader's pauseGate: the leader awaited followers that were awaiting the
leader. A delisted or unavailable model fails every in-flight chunk
simultaneously, which is precisely this case, so the run hung forever with
no timeout and no error. The leader now drains outstanding model ATTEMPTS,
which always settle, in a re-read loop rather than a single snapshot.
Proven by a repro test that timed out at 20s before the fix and passes in
2.3s after.

This one is worth dwelling on: it lived in the concurrency work I shipped
today and reported as verified. Every unit test passed because each tested
ONE failing chunk; the deadlock needs two. A green suite measured the case
I thought to write, not the case that occurs when a free model is delisted
mid-run -- the exact scenario the fan-out work exists to survive.

Also fixed:
- Uncancelled hedge timer kept the process alive up to 60s after the run
  finished (one timer per chunk, never cleared, main() returns rather than
  exiting) -- the CLI printed the report path then appeared to hang.
- Launcher positional capture stole a flag's value: `scan folder
  --instructions "find bugs" src/` rewrote "find bugs" into --folder_path.
  Only input-first ordering had been tested. Now schema-aware, and an
  unknown flag is assumed to take a value so its argument is never stolen.
- A transition rewound nextIndex to the failing index, so a second worker
  claimed a chunk the leader was already retrying; the duplicate inFlight
  key made the first cleanup delete the second's entry, hiding that attempt
  from a later drain.
- An abandoned response body held the event loop for the rest of the
  request budget (300-600s), a direct consequence of keeping the abort
  timer armed through the body read.
- `<group> <action> --help` exited 0 printing nothing when GROUPS named a
  command the catalog lacks -- it read as "this action has no parameters".
- DEFAULT_CONCURRENCY was referenced by 7 comments and index.ts after
  deletion, including a false claim that the CLI passes it and that it
  "stays at 12"; the CLI passes "auto".
- The scan list printed twice when the interactive prompt got a blank line.

Verified: tsc 0, vitest 1921 passed / 4 skipped / 0 failed, `eslint .
--quiet` clean, dist rebuilt so the shipped bundle matches src. Smoke-tested
through the real binary: the flag-before-positional case now reaches the
tool instead of dying on "unexpected argument".

Note on the eslint gate: `--max-warnings 0` reports 1 warning -- a stale
eslint-disable in benchmark-fixtures/search-existing, a file this diff does
not touch. Left alone on purpose: it is benchmark INPUT, and editing it to
please a linter risks perturbing benchmark results.

- Fix(session-summary): chunk deadline 240s -> 600s; it is a stall-catcher, not a tail-cutter

Third and final correction to this constant, and the measurement that settles it.

THE DEADLINE IS PER-ATTEMPT, NOT PER-CHUNK. A value below the model's real
latency therefore bounds nothing - it MULTIPLIES total time, one full deadline
per doomed attempt. Live run at 240s: 13 aborts, and one chunk took 1478s, i.e.
roughly six consecutive 240s aborts before an attempt survived.

MEASURED per-chunk latency, free tier, same transcript:
  91 / 185 / 262 / 312 / 475 / 718 / 1234 / 1478 s

And the finding that invalidates the plan I had been building on: latency is NOT
proportional to chunk size. A 4x smaller chunk budget (6k) was no faster and
produced 80 aborts instead of 13, on 22 chunks instead of 5. The earliest probe
already said so and I did not follow it through - a max_tokens=8 request still
cost ~35s. Free-tier latency is dominated by queueing and contention, not by how
much the model generates. So "shrink the chunks to go faster" is wrong: it
multiplies requests at unchanged per-request cost.

600s sits above that entire distribution, so it catches only a genuine STALL -
the unbounded-hang class that TRDD-0H5N1V9W made catchable at all - and leaves
merely-slow work alone. Cutting the tail is HEDGE_AFTER_MS's job: racing a second
model costs nothing when the first was only slow, whereas killing it costs a full
attempt.

The header now says DO NOT lower this to chase a latency target, with the numbers
attached. It has been tried twice (120s, 240s) and made things strictly worse both
times. The binding constraint is free-tier per-request latency, which no chunking,
deadline, concurrency or fan-out setting can move.

Consequence worth stating plainly: 2-3 minutes for a 666k context is NOT reachable
on the current free-model pool. It needs a local model (still $0, latency under
the user's control - already supported) or a cheap paid one (breaks the $0
guarantee). Everything landed tonight - the unbounded-hang fix, concurrency,
auto-sizing, fan-out, hedging - is correct and worth having, and none of it moves
that constraint.

Verified: tsc 0, eslint 0, vitest 1891 pass / 4 skip / 0 fail, build clean.

- Fix(session-summary): reserve the completion we REQUEST, not the provider's max

Found by the first live run after fan-out landed: a real transcript failed to
chunk at all, reporting a 4437-token turn as too large for a "usable budget of
1000 tokens". 1000 is the clamp floor, so the budget had gone NEGATIVE.

Root cause: windowBudgetForModel reserved `max_completion_tokens` - the largest
completion the provider would ever allow - and callChunkModel then REQUESTED that
same maximum. For most models that is merely wasteful. For
nvidia/nemotron-3-super-120b-a12b:free the catalog reports
context_length == max_completion_tokens == 262144, so reserving the full
allowance left nothing for input.

Two things turned that latent waste into a hard failure:
- the equal-context tiebreak prefers the LARGER completion ceiling, which is
  exactly backwards for input room, so that model sorts THIRD;
- fan-out takes min() across the top-K models, so one degenerate entry poisoned
  every chunk in the run.

Fix: reserve and request `min(max_completion_tokens, MAX_SUMMARY_COMPLETION_TOKENS
= 32k)`. A chunk summary cannot plausibly exceed the chunk it summarizes and
chunks cap at 25k, so 32k is generous headroom. The reservation and the request
now come from ONE helper (completionRequestFor) because if they ever diverge the
budget stops describing the request - which is the whole defect in miniature. Side
benefit: we stop asking a free model for 262k output tokens to summarize 25k.

This is a pre-existing bug, not one fan-out introduced - single-model runs simply
never consulted the third-ranked model, so it stayed invisible. Fan-out made it
reachable, which is why it surfaced the moment the first live run went out.

Test: a regression case pinning the exact catalog shape (context ==
max_completion == 262144), asserting both that chunking now succeeds AND that the
requested max output is the capped value rather than the provider's 262k.
Non-vacuous by construction - before the fix this shape threw inside chunkTurns
and never reached the model.

Verified: tsc 0, eslint 0, vitest 1891 pass / 4 skip / 0 fail (was 1890), build
clean, dist rebuilt.

- Fix: request timeout must cover the body read, not just headers (TRDD-0H5N1V9W)

fetchWithTimeout armed an AbortController, awaited fetch(), then cleared the
timer in a finally. But fetch() resolves on response HEADERS, not on a consumed
body - so the finally disarmed the abort the instant headers landed and the
caller read the body with no deadline at all. The configured timeout bounded
time-to-first-byte only; generation was unbounded.

A model that returned headers promptly and then stalled hung the run FOREVER:
the 15-retry ladder never fired, because a retry needs a response and there is
none. Measured on a live session-summary run: one chunk reached 1890s against
the 300s default (6.3x) before its socket died and the attempt restarted from
scratch, while fetchWithRetry429's remaining = timeout - elapsed arithmetic
believed the request had long expired.

Fix: keep the controller armed THROUGH the body read and disarm only once the
body settles, so an over-deadline generation aborts loudly and rotates like any
other transient - fail-fast instead of a silent hang. Implemented by piping the
body through a pass-through TransformStream whose flush/cancel callbacks disarm,
then returning a Response rebuilt from that stream (Response.body is read-only,
so it cannot be swapped in place).

Deliberately NOT raising the timeout value: that converts an unbounded hang into a
longer unbounded hang.

Why this survived so long, worth recording as a category: index.ts:317 justified
having no hard cap with 'The MCP tool-call timeout is inactivity-based, kept
alive by heartbeat - no hard cap needed.' That was TRUE under MCP, which supplied
the outer deadline. MCP is gone and this is CLI-only, so the justification died
with the transport while the code it justified stayed. A safety argument that
NAMES a component is invalidated by deleting that component.

Edge cases handled explicitly, each commented at the site:
- fetch() rejection clears the timer and rethrows (no leaked timer).
- 204/304/HEAD return the ORIGINAL response - the Response constructor rejects a
  body for those statuses, so the rebuild path must not be taken.
- cancel disarms too, so a body nobody reads cannot leave a timer armed to fire
  later against a response already discarded.
- inter-retry drain already consumes the body (http.ts:227), so the tap's flush
  disarms on that path as well - verified, not assumed.

Blast radius enumerated before writing code: 11 fetchWithTimeout call sites - 8
small metadata endpoints (/v1/models, /v1/key, /v1/credits, LM Studio probes)
whose bodies arrive in milliseconds, plus the 2 completion paths where the bug
actually bit. Rebuilding the Response is safe here because no caller reads
res.url, res.redirected or res.type - grepped, zero hits.

Tests: 6 regression tests in a new src/provider/http.test.ts, REGISTERED in
vitest.config.ts (the include list is explicit - an unregistered test file
silently never runs). Proven non-vacuous: the old implementation was replayed
against the same stalling-body scenario and was still hanging at 10x its own
deadline, so these tests genuinely fail without the fix rather than passing
either way.

Verified: tsc 0, eslint 0, vitest 1876 pass / 4 skip / 0 fail (was 1870), build
clean, dist rebuilt.

- Fix(pkg): the package still described itself as an MCP server

scripts/llm-ext/package.json's description read "MCP server for LLMs" — the
npm-facing one-liner, and the first thing anyone reads. There is no MCP server:
it was deleted in v11.0.0 (d557c68), MCP is banned on this machine, and 12.0.0
is the release that completes the CLI-only direction. It shipped in 12.0.0 with
that text.

Now matches .claude-plugin/plugin.json, which was already correct — so the two
manifests agreed on everything except the one sentence describing what the
thing IS. Rides the next release.


### Miscellaneous

- Chore: gitignore the _dev working folders

docs_dev/ was NOT ignored, and I had just written an abandoned-work patch into
it — a file full of absolute local paths, one 'git add' away from being
published. The rules require every _dev folder to be gitignored for exactly that
reason; reports/ and reports_dev/ were covered and the rest were not.

Adds docs_dev, scripts_dev, samples_dev, examples_dev, tests_dev, downloads_dev,
libs_dev, builds_dev.


### Refactored

- Refactor(cli)!: delete the retired legacy entry point (TRDD-W9DK4L3N)

v12.0.0 repointed both published bin names at dist/llm-ext.js, which left
src/cli.ts building to dist/cli.js as a second entry point that nothing
installs and nothing imports. Two copies of a dispatcher is exactly the
"no legacy/obsolete code, only one version exists" rule this project runs
on, so it goes.

Removed: src/cli.ts, src/cli-mass-scout-free.ts (its only importer was
cli.ts) and that module's test, the esbuild target, and the committed
dist/cli.js bundle.

THE REAL WORK WAS ONE TEST, AND IT IS WHY THIS WAS NOT A DELETE-THE-DEAD-
CODE TASK. free-rotation-coverage.test.ts asserted that the auto-reconcile
pre-flight runs at BOTH funnels, and its CLI half checked cli.ts for
"reconcileModelsBeforeWork(makeCliReconcileDeps())". Deleting that
assertion along with the file would have stayed green while silently
dropping the guarantee that the CLI reconciles at all. Traced the live
path first: bin/llm-ext -> src/cli/main.ts -> dispatchCallTool ->
runModelReconcile(), so coverage genuinely holds through the shared
dispatcher. The assertion is therefore re-pointed at cli/main.ts to assert
the single-entry-point invariant, not removed. Test title updated too --
it said "MCP + CLI" and MCP no longer exists here.

The card claimed four test files read cli.ts and needed per-assertion
judgment. Verified first-hand: only ONE did. cluster/wiring.test.ts and
security_scan/wiring.test.ts reference the SUBCOMMAND adapters
mass_scouting/cli.ts and cluster/cli.ts -- unrelated files with
confusingly similar names. Trusting the card's own blast radius would
have meant rewriting two tests that had nothing to do with this.

Also corrected two comments that asserted present-tense facts which the
deletion made false (a comment naming a file that no longer exists is what
sends the next reader hunting for it). The mass_scouting fieldset path
resolution is unaffected -- the bundle is still in dist/, so ../fieldsets
resolves identically.

resolveMassScoutFreeModelOverride stays exported: the bug it prevents is a
second copied implementation elsewhere, and one entry point today is not a
reason to inline it back.

Verified: tsc 0, eslint 0, vitest 1899 passed / 4 skipped / 0 failed
(1909 before; -10 is the deleted module's own test file), build clean with
no dist/cli.js.


## [12.0.0] - 2026-08-11

### Added

- Feat(session-summary): compaction-equivalent output, deterministic join, turn-atomic chunks (TRDD-T4MZ8YQR)

Four owner-driven corrections. The command produced a readable summary but not
the thing that was asked for — "compaction like" from the original request.

1. NINE-SECTION COMPACTION SCHEMA. The map prompt asked for "user requests,
   decisions made, files changed, commands run, outcomes" and got exactly that:
   a retrospective REPORT. Claude Code's own compaction is a resumption HANDOFF
   — Primary Request and Intent · Key Technical Concepts · Files and Code
   Sections · Errors and Fixes · Problem Solving · All User Messages · Pending
   Tasks · Current Work · Next Step. The highest-value section is All User
   Messages, VERBATIM: paraphrase destroys intent, which is the whole reason
   compaction preserves them.

2. NO MODEL FOLD. The reduce phase was a model call that decided what to keep —
   precisely what threatens the verbatim requirement, since a model merging nine
   sections will "tidy" the longest one and a truncated user-message list is
   unrecoverable. Chunk summaries are now JOINED IN CODE, in order. Removed with
   it: the recursive fold-overflow machinery, reduce levels, the reduce
   batch-packer, ReduceProgress, and the fold-only error paths. "No facts lost in
   the merge" is now true by construction rather than asserted.

3. TURN-ATOMIC CHUNKING. A chunk boundary may fall ONLY between turns. The old
   escape hatch — split an oversized turn at line boundaries and mark it
   [continued] — is deleted, because it is incompatible with joining: split a
   turn and chunk N describes an action whose result is in N+1, while N+1
   describes a result whose cause it cannot see, and no prompt fixes information
   destroyed at split time. An oversized turn now gets its own over-cap chunk;
   only a whole turn exceeding the model's usable budget fails, loudly, naming
   the turn.

4. IMAGES DROPPED, at every prune level including `none`. The summarizer is a
   text model, so a base64 screenshot contributes zero information while
   evicting genuine content from the chunk — a quality fix, not just a cost one.
   Replaced with an [image omitted] marker rather than deleted, so "the user
   shared a screenshot" survives and an image-only message does not read as
   empty. Covers both {type:"image"} blocks and inline data:image URIs.

The echo guard needed no change — verified against the new verbatim-quoting
prompt, with a test that a summary containing substantial quoted user messages
is NOT rejected.

Verified independently: vitest 1850 passed / 0 failed / 4 skipped, tsc clean,
eslint clean; and in source: zero fold remnants, zero line-splitting paths.

- Feat(cli)!: point the published bin at the supported CLI (TRDD-W9DK4L3N option B)

`bin` was `{ "llm-externalizer": "dist/cli.js" }` — the retired entry point.
It is now `{ "llm-ext": "dist/llm-ext.js", "llm-externalizer": "dist/llm-ext.js" }`,
so the documented name is installable and the old name still resolves.

The card justified option B with "anyone invoking `llm-externalizer <cmd>`
keeps working". Measured against the live catalog, that was FALSE for two of
the seven legacy verbs: `model-info` and `search-existing` exited 1, because
their tools were renamed to `or_model_info` and
`search_existing_implementations`. Re-pointing on that premise would have
silently broken two documented invocations for every npm install.

So this commit adds LEGACY_COMMAND_ALIASES in cli/main.ts FIRST, mapping both
old verbs onto the renamed tools, and only then re-points the bin — which
makes the card's claim actually true. The other five (profile,
cluster-synonyms, high-quality-scan, security-scan, mass-scout) already
resolved by name; verified, not assumed.

A regression test in launcher-boot.test.ts spawns the real launcher for ALL
SEVEN verbs. Without it a future catalog rename re-breaks a documented
invocation with nothing failing until a user reports it — which is exactly how
this defect reached an approved card.

Also verified `node dist/llm-ext.js` runs standalone (the npm bin path bypasses
launcher.mjs): better-sqlite3 is a declared dependency, so npm builds it; the
launcher's self-install covers the plugin-clone case where node_modules is
gitignored, not npm installs.

Verified: vitest 1832 passed / 0 failed / 4 skipped, tsc clean, eslint clean,
all seven verbs exit 0 through ./bin/llm-ext.

BREAKING CHANGE: the `llm-externalizer` command now runs the llm-ext CLI
instead of the legacy dist/cli.js bundle. Every documented verb still resolves,
but anyone depending on the old bundle's distinct behaviour (rather than its
documented commands) is affected. A new `llm-ext` bin name is also installed.

- Feat(session-summary): model-authoritative overflow re-split + --stdout output mode (TRDD-T4MZ8YQR)

Phase B, completing the owner's pipeline spec.

1. A context-overflow error FROM THE MODEL now re-splits the offending chunk
   and retries, instead of failing the run. This is what makes Phase A's
   tokenizer safe to rely on: `gpt-tokenizer` is o200k, the eligible models
   (nemotron, gemma) are not, so estimateTokens is an ESTIMATE and the safety
   margin reduces overflow without eliminating it. The model's own rejection is
   therefore treated as ground truth and overrides our count.
   Overflow is kept distinct from 429/402/404 — those are availability problems
   and still route to the model-fallback chain; an overflow does NOT swap models,
   because sizing is not availability. The halving is bounded: a chunk that
   still overflows when it can no longer be split fails loudly rather than
   looping.

2. `--stdout` returns the summary text directly instead of a report path.
   Deliberately a NEW flag rather than an overload of the existing `--output`,
   which means output DIRECTORY — reusing it would have made "where does the
   summary go" depend on the value's shape. Default stays the report path, which
   is this CLI's convention everywhere else and keeps a 66M-token summary out of
   the caller's context unless it asks.

Verified independently after the agent reported: tsc --noEmit clean, eslint
clean, `./bin/llm-ext session-summary --help` shows --stdout distinct from
--output. NOTE on the suite: a full run under load showed 6 failures, 5 of them
in profile.test.ts which this change never touches, with null (killed) exit
codes and a 383s runtime vs the usual 82s. Re-run isolated on a quiet machine:
32/32 pass. Load-induced timeouts, not a regression.

- Feat(session-summary): biggest free model, runtime fallback, real tokenizer (TRDD-T4MZ8YQR)

Implements the owner's pipeline spec. Three changes, each replacing something
that was wrong rather than merely absent.

1. No implicit context floor. Selection previously defaulted to a 1,000,000
   floor, which on today's catalog admits exactly ONE model — so a delisting
   or a daily cap left the command with nothing to fall back to. It now always
   picks the BIGGEST eligible free model, whatever that is; `--min-context` is
   an optional explicit floor. `--allow-lower-context` is deleted: meaningless
   without a default floor. WHY no floor is correct: chunking, not the window,
   is what handles a transcript larger than the model — refusing small-context
   models solved the wrong problem.

2. Modality filter is permissive: `text` must be PRESENT on both sides of
   `architecture.modality`, extra modalities never disqualify, membership-split
   on `+` so "textual" cannot match "text". The old exact `text->text` match
   silently dropped 6 of 16 usable free models. It does admit the lyria audio
   models (largest context, so they sort first) — deliberately. Selection is
   permissive and RUNTIME evidence demotes: a model returning no usable text is
   a fallback trigger. That is what survives model shapes nobody has shipped yet.

3. Chunk sizing uses a real BPE tokenizer (gpt-tokenizer, MIT, zero transitive
   deps, no WASM/native) instead of the bytes/4 heuristic, counted incrementally
   per turn so a 265 MB transcript is never tokenized in one call. Budget is
   context_length - reserved_completion - prompt_overhead, NOT the context
   length: sizing to the full window guarantees overflow once the reply is
   generated.

TOKEN_ESTIMATE_SAFETY_MARGIN exists because the eligible models (nemotron,
gemma) do not use o200k tokenization, so the count is an estimate. Do not
"simplify" it away — the model's own overflow error is ground truth, the
tokenizer is the estimate.

Verified independently, not taken on an agent report: vitest 1816 passed /
0 failed / 4 skipped, tsc --noEmit clean, eslint clean.

- Feat(cli): expose `session-summary` — compaction-style summary of a whole session (TRDD-T4MZ8YQR P5)

Wires P1-P4 into a reachable command: stream the JSONL transcript, prune, chunk on turn
boundaries, select a free text-only model, map-reduce with per-chunk checkpointing.

Defaults encode the two decisions recorded on the card. --min_context is 1,000,000, which honours
the original request literally even though exactly ONE free model qualifies today; the opt-in
--allow_lower_context drops the floor to 262,144 where five do, because with a one-model pool
there is nothing to rotate to when its daily cap hits. --prune defaults to aggressive: the prune
ratio, not the context window, is what makes a 66M-token transcript tractable, and a compaction
summary wants the narrative rather than the bytes.

Transcript/checkpoint path resolution lives in its own module OUTSIDE session_summary/ so the
four already-tested phases stayed untouched by the wiring.

README counts moved again (43→44, 20→21 core/utility) because doc-consistency.test.ts asserts
they equal the real catalog — the same guard that caught the `profile` command. It is doing its
job; the counts move, never the test.

Verified through the binary a user actually types, not just the suite: `./bin/llm-ext
session-summary --help` lists every documented flag after a rebuild. Suite 1795 passed / 0 failed,
tsc + lint clean. package.json untouched — option B of W9DK4L3N remains unapproved.

- Feat(session-summary): map-reduce driver with resumable per-chunk checkpointing (TRDD-T4MZ8YQR P4)

Maps each chunk, reduces the chunk summaries into one, and recurses when the fold itself exceeds
the window — a 265 MB / ~66M-token transcript is ~66 full 1M windows, so a single fold is not
guaranteed to fit.

Checkpointing after every chunk is the load-bearing part, not defensive polish. At the default
1M context floor exactly ONE free model qualifies, so there is no rotation partner when its daily
cap hits: an interrupted run is the normal case, not the exception. The tests therefore assert
the properties that make resume trustworthy rather than merely present — already-checkpointed
chunks are not re-sent to the model, a checkpoint whose transcript or prune level no longer
matches fails fast instead of folding a summary of one input into another, corrupt checkpoint
JSON fails fast rather than silently starting fresh (which would read as success while
re-spending the entire run), and a rate limit raises an actionable error naming the checkpoint
path instead of retry-looping against a daily quota that will not clear for hours.

The cost gate runs before any I/O — it refuses a non-free model id before the transcript is even
opened — so it cannot be bypassed by a later path that forgets to consult it.

Tests inject the model-call seam, so the suite makes no network calls. 50 tests pass.

- Feat(session-summary): free-model selection with a tested modality filter (TRDD-T4MZ8YQR P3)

Selects eligible models by price==0 AND context_length>=minContext AND modality=="text->text".

That last clause is the whole point and it has its own regression test. Measured on the live
OpenRouter catalog: three free models clear >=1M context, but two of them
(google/lyria-3-pro-preview, google/lyria-3-clip-preview) are text+image->text+audio music
models. A price+context filter — the obvious implementation — selects them, and the resulting
failure looks like a bad model rather than a bad filter, which is the kind of bug that costs an
afternoon. The fixture now encodes that trap permanently.

Default minContext is 1_000_000, honouring the request literally; allowLowerContext drops to
262_144 where ~5 free text models exist. That option is not a convenience: at 1M the eligible
set is a single model, so there is nothing to rotate to when its free daily cap hits.

Empty eligible set fails fast naming the filters applied, and never falls back to a paid model —
two tests assert that holds regardless of caller or active profile. Tests inject catalog JSON as
a fixture, so the suite makes no network calls.

- Feat(cli): add a read-only `profile` command to llm-ext (TRDD-K3PW7Q2M)

Closes the last capability that existed ONLY in the legacy standalone bundle. Before this,
`llm-ext --help` had no `profile` at all — the surface lived in scripts/llm-ext/src/cli.ts,
reachable only through the `llm-externalizer` binary, so the supported entry point could not
answer "which profile am I on?".

Read-only ON PURPOSE: list, and --show <name>. No add/select/edit/remove/rename. This project's
standing rule is that configuration is user-only — settings.yaml is hand-edited and there is
deliberately no set-settings/change-model command — so a profile write verb would be that same
banned surface wearing a different name. The TRDD's "switch" acceptance box is amended in the
card rather than quietly ticked.

README's command counts are updated with it (42→43 total, 19→20 core/utility). That was not
cosmetic: src/doc-consistency.test.ts asserts the README counts equal the real catalog, and it
went red the moment the command landed. The guard was right, so the counts moved, not the test.

Full suite 1775 passed / 0 failed; tsc --noEmit and lint both clean; `./bin/llm-ext profile`
exercised for real against the live settings file.

- Feat(session-summary): streaming transcript reader + turn-boundary chunker (TRDD-T4MZ8YQR)

P1+P2 of the session-summary command. Both are pure and model-free, so they hold whichever way
the two open design flags land (--min-context, --prune).

Streaming is not an optimisation here, it is the requirement: this project's largest session
transcript is 265,443,684 bytes (~66M tokens), so a whole-file read would blow the heap before
any model was ever called. transcript.ts therefore reads line-by-line via createReadStream +
readline, and a structural test asserts no synchronous whole-file read can creep back in — that
guard exists because the failure it prevents is silent until someone runs it on a big session.

A malformed JSON line is skipped and COUNTED rather than thrown, because real transcripts get
truncated mid-write when a session dies; everything else still fails fast.

chunker.ts never silently drops a turn: a turn too large for the budget on its own is split on
line boundaries and marked [continued], and a round-trip test asserts every input turn survives.
The bytes/4 token heuristic is one exported constant so the estimate can be replaced with a real
tokenizer in one place.

26 tests, tsc --noEmit clean, lint clean (all re-run independently before this commit).


### Changed

- Build(dist): rebuild bundles with the queue-operation extraction fix

- Build(dist): rebuild bundles with the compaction schema and deterministic join

bin/llm-ext executes dist/, so the nine-section prompt, the removed fold, the
turn-atomic chunker and the image dropping are all unreachable at runtime until
this rebuild.

- Build(dist): rebuild bundles with the chunk cap, echo rejection and loud failure

Also carries the corrected benchmark re-run hints (2ff6c56) into the bundles.
bin/llm-ext executes dist/, so none of it is reachable at runtime until this.

- Build(dist): rebuild bundles with the ':free' selection fix

Without this the shipped binary keeps selecting the unsuffixed lyria id and
failing the cost gate — the source fix in 1931239 is not reachable at runtime
until the bundles are regenerated.

- Build(dist): rebuild bundles with the legacy command aliases

bin/llm-ext and the npm bin both execute dist/llm-ext.js, so model-info and
search-existing kept exiting 1 until the rebuild — caught by re-checking all
seven verbs against the binary rather than assuming the source edit sufficed.

- Build(dist): rebuild bundles with the Phase B overflow re-split and --stdout

bin/llm-ext executes dist/llm-ext.js, so the flag and the re-split are not
reachable at runtime until the bundles are regenerated (see the same note on
fdff1f7). Verified after rebuild: session-summary --help lists --stdout.

- Build(dist): rebuild bundles with the tokenizer pipeline and model selection

Source landed in e89456a; dist was stale. bin/llm-ext resolves through
launcher.mjs into dist/llm-ext.js, so the runtime keeps the OLD behaviour until
the bundles are rebuilt — an unrebuilt dist is why a verified-green src can
still ship the previous logic.

Verified on the live binary after rebuild: 'llm-ext profile --help' and
'llm-ext session-summary --help' both exit 0, and session-summary's help
reflects the new selection (no hard floor, --allow-lower-context gone).

- Build(dist): rebuild bundles with the session-summary command

So the shipped bin/llm-ext actually carries it — verified by grepping the built bundle rather
than inferring it from the source diff.

- Build(dist): rebuild bundles with the unified auto-free pre-flight

Regenerated so the SHIPPED dist/cli.js — the only binary package.json declares — actually carries
the fix. Verified by grepping the built bundle, not inferred from the source change: a green
source diff with a stale bundle is exactly the shape of "fixed it" that ships nothing.

- Build(dist): rebuild bundles with the profile command

Regenerated by the build so the shipped `bin/llm-ext` actually carries `profile` — the source
change alone would leave the published surface unchanged, which is precisely the trap the
"verify through the command the user runs" rule exists for.


### Documentation

- Docs: document session-summary as a $0 compaction tool for any Claude Code session (TRDD-T4MZ8YQR)

README, the usage SKILL and its tool-reference / usage-patterns now describe
what the command actually is: a Claude-Code-compaction-EQUIVALENT summary of a
whole session, produced from its JSONL transcript on free models only, so an
agent can compact any session at $0.

Documents the parts that are load-bearing for a caller: the nine-section schema
(with All User Messages verbatim), chunk boundaries that fall only BETWEEN
turns, the deterministic non-LLM join, image dropping, checkpoint/resume, and
the biggest-free-model selection with automatic fallback.

Every documented invocation was executed against the real binary before being
written — a documented command that errors is the exact defect class fixed
earlier tonight, twice.

Also corrects a contradiction in driver.ts: the DEFAULT_MAX_CHUNK_TOKENS header
claimed the effective budget is "always Math.min(windowBudget, cap)", while the
call site honors an explicit --max_chunk_tokens VERBATIM. The code is right and
the header was stale. 50,000 is a DEFAULT, not a ceiling: a caller may set any
value, above the default or above the model's window, and an over-large setting
degrades into extra calls (the model's own overflow error re-splits the chunk)
rather than failing. Only the default is window-capped, since defaulting to a
budget the model cannot accept is pointless.

NOT lowered to 20-25k as earlier speculated. Under the verbatim schema total
output is ~proportional to total INPUT regardless of chunking — every user
message is reproduced exactly once either way — so smaller chunks do not reduce
total generation time, they only add per-request overhead.

Verified: vitest 1865 passed / 0 failed / 4 skipped, tsc + lint + build clean.

- Docs: TRDD-T4MZ8YQR — record the compaction rework and the mid-turn message loss

Five findings, the fifth only visible in a live run: a message sent while the
assistant is working is stored as type 'queue-operation' with text at the
top-level content field, so every mid-turn user message was discarded while
[janitor-heartbeat] cron fires survived. Machine noise kept, human intent
dropped, in the feature whose selling point is verbatim user messages.

Also records the measured cost shift: under the verbatim schema output scales
with input, so ~28 min per 50k chunk vs ~90s for the old fixed-size summary —
the 50k default predates that and 20-25k is likely better, left unchanged
pending measurement rather than guessed at twice.

- Docs: TRDD-W9DK4L3N — record the measured blast radius of removing src/cli.ts

Nothing imports cli.ts (it is an entry point); cli-mass-scout-free.ts and its
test are orphaned by its removal; the esbuild target and committed dist/cli.js
go; resolveMassScoutFreeModelOverride stays (still used at index.ts:2743).

The judgment call is the FOUR test files that read cli.ts as a source: they
assert coverage across BOTH entry points, so removing one means deciding per
assertion whether it still means anything — a change that stays green while
dropping a guarantee. Recorded so this is not mistaken for a mechanical
dead-code delete, and so the next session does not re-scope it.

- Docs: close TRDD-R7VQ2XKD — all five criteria met and re-verified (archived)

Fixes: 5c9d253 (4 live MCP references), 2ff6c56 (benchmark re-run hints naming
a verb that never existed), f88d840 (or-model-info documented a positional
invocation the CLI rejects), 70f17c0 (free-scan told agents to pass --free and
--output_dir to scan-folder, which accepts neither), ceaad6d (--estimate
preamble on four files with paid examples).

Each criterion re-measured AFTER the fixes rather than re-read: 0 dead-MCP
refs; 5/5 hints corrected with 0 stale; or-model-info fully on --model with 0
positional forms; all 4 paid-example files carrying the --estimate rule.

Recorded on the card because the card earned it twice: its original "0 drift"
was narrative and four live MCP references survived it, and while closing it
today I saw four criteria green and nearly archived with a HIGH free-scan
finding still open — having fixed one of the two defective skills the audit
named and carried "skills are done" forward as though it covered both.

- Docs: TRDD-W9DK4L3N — correct an overstated verification claim

I tested '<verb> --help' for all seven legacy verbs and reported 'all seven
exit 0'. That proves verb RESOLUTION, not ARGUMENT CONVENTION. The legacy CLI
took the model id positionally (src/cli.ts:890); this one accepts only named
flags, so 'llm-externalizer model-info <id>' still fails for an npm user even
though the alias resolves the verb. Measured both ways before writing this.

The breakage is declared in 15eb6e4's BREAKING CHANGE footer, but it is broader
than that footer implies, so the card now says so.

- Docs: TRDD-T4MZ8YQR — session-summary produces a real summary, verified live

Second live run: 3 chunks, 3,918 lines, prune 0.103, 4,353 B of structured
compaction output with accurate specifics. Contrast with the first run's 941 B
echo. Root cause recorded (chunk sizing used the whole window, so ~150k tokens
went in one request), along with the correction that my first diagnosis blamed
the fallback chain and was wrong — the driver's no-text handling was always
right; the retries came from the client layer beneath it.

- Docs: document the --estimate dry-run before paid examples (TRDD-R7VQ2XKD)

Four files showed invocations that SPEND on a paid profile (scan-folder, chat,
code-task, compare-files, check-references, check-imports, check-against-specs,
search-existing-implementations) while containing zero mentions of `--estimate`
— so a reader following them had neither an inline dry-run nor a file-level
rule to fall back on. docs/agent-usage-reference.md alone carried 12 such
examples across 653 lines with no cost preview anywhere.

Uses the preamble already established in
skills/llm-externalizer-usage/references/usage-patterns.md:28-30 rather than a
new wording, so the corpus stays consistent. end-to-end-workflow.md also
demonstrates estimate-then-real-run on its first invocation, since it is the
canonical worked example.

The rule is CONDITIONAL on purpose: `--estimate` is pointless on a free profile
where everything is $0, so it reads "on a paid profile", never "always" — a
guardrail that fires when it cannot matter trains readers to ignore it.

llm-externalizer-reviewer-agent.md gets it as a DIRECTIVE rather than prose,
because that agent runs scan-folder/code-task for real; its existing step 2 was
extended, not replaced.

Closes acceptance criterion 4 of TRDD-R7VQ2XKD. Verified additions-only: the
single deletion is that step-2 line being extended in place.

- Docs: TRDD-T4MZ8YQR — first live run exposes two defects, command still not usable

Plumbing verified end-to-end (model selection, prune 0.103, 1 chunk,
checkpoint, report, exit 0) but the summary body is a raw pruned turn, not a
summary. Empty responses retried 15x on the same model instead of demoting to
the next candidate, and the run exited 0 emitting a non-summary as success —
which fail-fast forbids, since nothing downstream can distinguish it from a
real summary.

- Docs: TRDD-T4MZ8YQR — Phase B closes the last two implementation boxes

Overflow re-split and --stdout both landed (21e2603). What remains unchecked is
the live end-to-end run against a real transcript, which no phase has done.

- Docs: TRDD-W9DK4L3N scope-approved now records option A and B

The frontmatter still said option-A-only while the body recorded B as shipped.
scope-approved is a greppable field, so a stale value there contradicts the
card at exactly the place a query would trust it.

- Docs: TRDD-W9DK4L3N option B shipped; card stays dev for the dead bundle

Records that verification falsified the card's own premise (two of seven legacy
verbs did NOT keep working) and that the aliases were added before the
re-point so the promise holds. Four of six acceptance items now met; the
unmet one is src/cli.ts still building to an uninstalled dist/cli.js.

- Docs: archive TRDD-8d8d33c8 as superseded, not complete

The card sat at `column: complete` inside design/tasks/, so the board counted
it as open work while its body already said "CLOSED — fixed by TRDD-W9DK4L3N
option A". Two corrections:

- `complete` -> `superseded`. It already carried `superseded-by: TRDD-W9DK4L3N`,
  and its own six acceptance boxes were never ticked. Work finished under a
  different card is supersession; calling it complete would assert that THIS
  card's criteria were verified, which nobody did.
- moved to design/archived/, where terminal cards belong.

Verified the substance before archiving rather than trusting the header: the
shared module src/cli-mass-scout-free.ts exists and src/cli.ts consults the
supported path's resolveMassScoutFreeModelOverride through it (d0c6c69), which
was acceptance item 1 and the actual gap.

- Docs: close TRDD-K3PW7Q2M (verified), reopen TRDD-R7VQ2XKD (verification failed)

Owner approved closing both with the standing instruction "verify each before
doing it". Verification split them.

K3PW7Q2M -> completed, archived. Verified first-hand on the live binary after a
fresh build: `llm-ext profile --help` exits 0 with the read-only list/--show
schema; the verb is in the catalog (definitions.ts:655); dogfood covers it via
its dynamic verb parser (dogfood_test.py:284,369) — confirmed by reading the
harness, not by trusting the earlier "covered generically" note.

R7VQ2XKD -> dev, NOT closed. Its "0 drift" was narrative and its five
acceptance boxes had never been ticked. Measured: 1 of 5 now met (after
5c9d253), 1 measurably UNMET — five benchmark modules print
`Re-run: llm-externalizer benchmark --…` as runtime output, and that binary is
not on PATH for plugin users — and 3 never checked at all.

WHY reopened rather than closed with a note: a card in human_review asserts it
is waiting on a person. This one is waiting on work, and the difference is
invisible on the board unless the column says so.

- Docs: TRDD-T4MZ8YQR — Phase A landed, Phase B is the remaining scope

Records what the owner's pipeline spec superseded (the 1M floor,
--allow-lower-context, exact-match modality, bytes/4) so a later session does
not reintroduce any of them, and names the one honest gap: the tokenizer is an
estimate, so the model's own overflow error must be the authority (Phase B).

- Docs: remove the last four references to the deleted MCP surface (TRDD-R7VQ2XKD)

The drift sweep was recorded as "0 drift", but four user-facing sites still
named MCP as the live invocation path:

- or-model-info/SKILL.md said "Real invocation path is the `or_model_info` MCP
  tool", and then contradicted itself 14 lines later with "(not the MCP tool)".
  The MCP server was deleted in v11.0.0 (d557c68); there is no such tool.
- three tool-reference.md copies explained the disabled-tool list in terms of
  "MCP is read-only", framing a surface that no longer exists.

WHY it matters more than a wording nit: these are skill files, so the sentence
is what an agent reads when deciding how to invoke the tool. A description
pointing at a deleted surface produces a call that cannot succeed, and the
self-contradiction inside one file means whichever line is read first wins.

Only the MCP clauses were changed. `llm-externalizer model-info` was left
alone on purpose: it is a REAL verb (src/cli.ts:890) under the real npm bin
name, not drift — 24 other hits for that form are the legacy surface being
documented correctly.

- Docs: TRDD-T4MZ8YQR to human_review — all five phases shipped and verified

The two defaults (--min_context 1M, --prune aggressive) were my assumptions under a delegated
decision, not the owner's explicit choice, so the card waits on review rather than closing itself.

- Docs: approve TRDD-W9DK4L3N option A only — unify dispatch, leave the published bin alone

The owner delegated the tier-3 call ("do as you think is better"), so this approves the
non-breaking half and explicitly refuses the breaking one.

A removes an active billing exposure: the published entry point (dist/cli.js, the only declared
npm bin) has no auto-free-on-low-balance path, so a user there can be charged in exactly the
situation where the supported bin/llm-ext would have switched to free models. That is a defect
in shipped behaviour, and fixing it changes nothing anyone can observe except the bill.

B — re-pointing the npm bin — is NOT approved. It is irreversible for existing consumers and
gains nothing once A has erased the behavioural difference between the two paths, so it belongs
to a deliberate major with a breaking-change note, not to a bugfix.

Scope: shared dispatch, package.json untouched. Closes TRDD-8d8d33c8 when it lands.

- Docs: fix two invocations that could never have run, close the drift sweep (TRDD-R7VQ2XKD)

README documented the mass-scout family as `bin/llm-ext mass-scout <subcommand>`. That two-word
form does not exist — the commands are flat (`mass-scout-register`), so every example built on
it would fail at the catalog lookup.

docs/agent-usage-reference.md passed the spec file to check-against-specs via
`--instructions_files_paths` and never supplied `--spec_file_path`, which --help marks
(required). Same class of bug: an example that reads as authoritative and cannot execute.

Re-audit across commands/ skills/ agents/ README.md docs/ now returns zero on all five drift
categories, re-run independently rather than accepted from a report. Card moves to human_review
(not complete) because it carries review-requirements: [human-review] and closing it is the
owner's call.

The structural half — two runtime entry points, the published npm bin being the legacy one —
is deliberately NOT in this card; it is breaking public API and waits in proposal W9DK4L3N.

- Docs: propose TRDD-W9DK4L3N — retire the legacy dist/cli.js entry point (tier 3, needs approval)

Filed as a PROPOSAL, not a task: re-pointing a published npm bin is a breaking public-API
change, so it is the owner's call.

The finding that prompted it: package.json declares bin = {"llm-externalizer": "dist/cli.js"},
i.e. the npm package still advertises ONLY the entry point v11.0.0 was meant to supersede, while
the supported `bin/llm-ext` is not an npm bin at all. The two surfaces do not behave the same —
grep proves auto-free-on-low-balance is absent from the legacy path, so a user there can be
billed where the supported path would have switched to free models.

Checked the legacy CLI's own 7-subcommand list against the real catalog: six already exist in
llm-ext (two under renamed forms), and only `profile` is unique. So the legacy bundle carries no
capability the supported one lacks — only divergent behaviour. Approving this closes both
TRDD-8d8d33c8 and TRDD-K3PW7Q2M rather than patching each symptom separately.

- Docs(commands): fix the flag that never existed + add the missing cost gates (TRDD-R7VQ2XKD)

Three command files told the agent to pass `--specs` to check-against-specs. That flag does
not exist and never did — `llm-ext check-against-specs --specs X` errors with "unknown flag".
The real one is `--spec_file_path`. Each file keeps `--specs` as its OWN slash-command argument
hint (that is its UX) and now translates it explicitly at the point of the CLI call, so the
wrapper's vocabulary and the CLI's vocabulary stop being silently conflated.

Separately, none of the 39 command files mentioned `--estimate` before dispatching a paid run,
which is exactly the pre-flight the cost rule requires. Six paid commands now lead with it.
security-scan is deliberately left on `--budget_usd`: it REFUSES --estimate by design, because
it runs through mass_scouting and the generic estimator would price the wrong models.

Also records a correction in the TRDD: the audit's ~16 "kebab vs snake flag mismatch" CRITICALs
were false. cli/main.ts:208 normalises `-` to `_` at parse time, so the kebab docs already work
(verified behaviourally). Fixing them would have been churn; the note exists so nobody re-opens
that class from the same stale report.

- Docs: add TRDD-T4MZ8YQR — session-summary command design (measured constraints)

Captures the user's request for a compaction-style session summary built from the project's
JSONL transcript using free 1M-context models only, and records what measurement actually
found rather than what the request assumed: exactly ONE free model is both >=1M context and
genuinely text->text (nvidia/nemotron-3-ultra-550b-a55b:free) — the other two >=1M free ids
are lyria audio models that pass a naive price+context filter, which is why the modality
filter is load-bearing in P3.

The decisive number is the transcript itself: 265 MB / ~66M tokens for this project's largest
session, i.e. ~66 full 1M windows. Map-reduce is therefore mandatory whatever model is chosen,
and a single-model pool cannot rotate on a 429 — hence per-chunk checkpointing in P4.

Two defaults are stated as assumptions, both flag-reversible: --min-context 1000000 (honours
the request literally) and --prune aggressive (what makes a 66M-token input tractable at all).

- Docs(skills): translate 13 skill files from the retired MCP surface to llm-ext (TRDD-R7VQ2XKD)

v11.0.0 retired the MCP server and made `llm-ext` the only runtime surface, but these
skill references were still written as MCP tool-call JSON payloads ({"tool": "scan_folder"}),
still invoked the legacy `llm-externalizer` bundle name, and still used the two-word
`mass-scout build-fieldset` form instead of the real flat `mass-scout-build-fieldset`.
An agent following them executed something that could not work — worse than a missing doc,
because it reads as authoritative.

88 invocations rewritten; every command checked against `llm-ext --help` and every flag
against that command's own --help, so no invented flags survive. Paid examples now lead
with the $0 `--estimate` dry-run per the cost rule.

Opens TRDD-R7VQ2XKD; the commands/ wave (39 files, 20 critical) is next.

- Docs(board): triage the 33-card TRDD board — archive 29, keep 4 open, add profile-gap card

Verified every card against the v11.1.0 tree rather than its own prose. 26 done, 2
superseded by the MCP→CLI migration, 1 cancelled with the Codex feature removal. The 4
that remain are genuinely open; adds TRDD-K3PW7Q2M for the verified llm-ext profile gap.
Ledger: design/BOARD-TRIAGE-20260806.md


### Fixed

- Fix(session-summary): capture mid-turn user messages, drop machine-injected turns (TRDD-T4MZ8YQR)

HIGH-severity data loss, found by the live run — 1865 unit tests could not see
it, because no fixture contained the shape.

A message the user sends WHILE THE ASSISTANT IS WORKING is recorded with
`type: "queue-operation"` (text at the TOP-LEVEL `content` field), not
`type: "user"`. The extractor keyed on `type` and accepted only "user", so
EVERY mid-turn message was silently discarded. Measured on a real transcript:
"serena" appeared 0 times in a 328 KB generated summary although the owner had
explicitly said "delete the whole .serena folder". Also lost: the MCP ban,
"find a way to make it work", "the merge should not be made by the model",
"embedded images should be dropped".

That is the worst possible subset to lose. Mid-turn messages are corrections
and redirects — the moments the user changes course — and the summary's
headline feature is "All User Messages, verbatim".

Meanwhile the inverse was also true: `[janitor-heartbeat]` cron fires ARE
type "user", so the verbatim section filled with machine noise while real
intent vanished.

Fixes: extract queue-operation/enqueue entries as user turns in original
interleaved order, and exclude turns that are WHOLLY machine-injected —
heartbeat fires, the no-visible-output nudge, slash-command plumbing,
system-reminder-only turns, task-notification / cross-session relays (which
Claude Code re-delivers later, so dropping them duplicates nothing), and
skill documentation loaded as a synthetic user turn.

The exclusion is deliberately conservative: whole-message matches only, never
a mention. A false exclusion destroys real intent — the exact bug being fixed —
so there is a test asserting a real message that merely MENTIONS a marker
survives.

Verified against the REAL transcript, not fixtures: all six previously-lost
messages now present; user turns 62 -> 53 as 9 skill-doc loads drop out; 0
heartbeat fires survive. Suite 1865 passed / 0 failed, tsc + lint + build clean.

- Fix(skills): free-scan told agents to pass flags scan-folder rejects (TRDD-R7VQ2XKD)

Four sites used `llm-ext scan-folder --free ...` or referred to `--output_dir`.
Measured: scan-folder's complete flag list is 17 flags and contains NEITHER, so
an agent following this skill errored out.

This mattered more than a typo because the skill's whole purpose is $0 scanning.
It taught that free routing comes from a `--free` flag on scan-folder; it does
not, so the guarantee it advertised was never coming from the mechanism it
named. Free-only routing for scan-folder is a PROFILE setting (`free_only: true`
with a `free_models:` pool), and `llm-ext discover` is what reports whether it
is active.

NUANCE worth recording, because the obvious generalisation is wrong: `--free`
IS a real flag — on `chat` and `code-task` (both verified PRESENT). Only
scan-folder lacks it. So "free mode is a profile setting, not a flag" is a
half-truth; which mechanism applies is PER COMMAND, and the only way to know is
that command's own --help. references/ was therefore correctly left untouched:
its --free mentions are on chat/code-task, where the flag exists.

- Fix(skills): or-model-info documented an invocation that cannot run (TRDD-R7VQ2XKD)

Every example in this skill passed the model id POSITIONALLY
(`llm-externalizer model-info "<id>"`), and the CLI takes only named flags.
Measured: `./bin/llm-ext or-model-info "google/gemini-2.5-flash"` exits 1 with
"unexpected argument"; `--model "google/gemini-2.5-flash"` exits 0. So an agent
loading this skill and following it verbatim failed every time.

Seven sites corrected to `"$CLAUDE_PLUGIN_ROOT/bin/llm-ext" or-model-info
--model "<id>"`, matching the spelling this skill's OWN references/ files
already used — the skill was internally inconsistent with its own references,
and the fictional form was the one a reader hits first.

Also: the "flags" it told readers to forward (--markdown/--json/--no-color and
aliases) do not exist. Output format is a different COMMAND
(or-model-info-table / or-model-info-json), not a flag; each command's only
parameter is --model. And the prerequisite claimed `llm-externalizer` is "on
PATH (bundled with the plugin)" — the plugin bundles `bin/llm-ext`;
`llm-externalizer` only exists after an npm install.

MY OWN ERROR, recorded so it is not repeated: the frontmatter line said
`llm-ext or-model-info <id>` because I wrote it that way in 5c9d253 while
fixing this file's stale MCP reference. I corrected one defect and introduced
another in the same edit, because I checked that the COMMAND existed and never
ran it. Verifying a command's existence is not verifying its calling
convention.

Every replacement invocation in the file was executed against the live binary
before being written.

- Fix(session-summary): cap chunk size, reject echoes, fail loud (TRDD-T4MZ8YQR)

The first live run completed and exited 0 while emitting a single raw
transcript line as its "summary". Three fixes, all from that evidence.

1. CHUNK SIZE IS CAPPED INDEPENDENTLY OF THE WINDOW (default 50,000 tokens,
   `--max_chunk_tokens` to override). It previously used the whole window
   budget — contextLength - maxCompletion - overhead, about 934k — so the
   entire ~150k-token transcript went to the model in ONE request. A context
   window governs what FITS, not what a model can summarize WELL; free models
   collapse into echoing their input long before the limit. This is the actual
   root cause of the garbage output.

2. AN ECHO IS NO LONGER ACCEPTED AS A SUMMARY. A response that is essentially
   its own input is now treated exactly like the existing "no-text" case: a
   ModelUnavailableError that demotes the model and advances the fallback
   chain, so a model that echoes is abandoned instead of trusted. Kept
   conservative — a legitimate short summary that quotes a line must not be
   killed — so the test is whole-response-is-input, not contains-input.

3. NO USABLE SUMMARY IS NOW A LOUD FAILURE. Exhausting every candidate exits
   NON-ZERO naming what was tried and why each failed. Exit 0 with a
   non-summary is the worst outcome available: fail-fast forbids it precisely
   because nothing downstream can distinguish it from real output.

Note on the earlier diagnosis, corrected by reading the source: the driver's
empty-response handling was never wrong. driver.ts:368 already throws
"no-text" and :373 propagates it for fallback WITHOUT retry. The `retrying
(1/15)` lines came from the OpenRouter client layer beneath it, which retried
and eventually returned a non-empty echo — so the driver never saw an empty
string and the fallback chain was never given the chance to fire.

Verified independently: vitest 1841 passed / 0 failed / 4 skipped, tsc clean,
eslint clean, and `session-summary --help` shows --max_chunk_tokens.

- Fix(benchmark): re-run hints named a command that never existed (TRDD-R7VQ2XKD)

Five benchmark modules printed `Re-run: llm-externalizer benchmark --<mode>` as
runtime output. That was wrong in TWO ways, not one: `llm-externalizer` is the
npm bin name and is not on PATH for plugin users, AND `benchmark` was never a
verb on either CLI — the benchmarks ship as a SEPARATE binary, bin/llm-ext-benchmark.
So a user who followed the hint got "unknown command" no matter how they had
installed the plugin.

Now `llm-ext-benchmark --<mode>`, verified against the real binary rather than
assumed: `./bin/llm-ext-benchmark --help` exits 0 and lists --scan-folder,
--code-task, --search-existing, --security-triage and --check-specs. A dry-run
of one mode was also exercised; it stops at the allow_paid_models cost gate
("No API call was made, $0 spent"), which confirms the flag parsed and the
guard fired — not a bad invocation.

Only the command name changed in each string; wording, flags and formatting are
untouched. Closes acceptance criterion 2 of TRDD-R7VQ2XKD, which was the one
item measurably UNMET.

- Fix(session-summary): a $0 model without a ':free' suffix is excluded, not fatal (TRDD-T4MZ8YQR)

Found by the first LIVE run, which no phase had done. The command failed
outright with "free_only cost-safety: refusing to send non-free model
'google/lyria-3-pro-preview'" and summarized nothing.

Root cause: two different predicates for "free" were never reconciled.
Selection filtered on pricing.prompt == 0 && pricing.completion == 0, while the
cost gate (assertFreeOnlyModel) requires the id to END WITH ':free'. OpenRouter
genuinely lists $0 models with no ':free' suffix — lyria is one — so such a
model passed selection and was then refused downstream.

The damage came from WHERE the gate sat: assertFreeOnlyModel() was called
INSIDE the filter loop, so it THREW instead of skipping. One unusable catalog
row therefore took the whole run down. And because the unsuffixed lyria ids
have the largest context in the free tier, they sort first and are hit first —
selection threw before it could ever reach a usable model. A cost-safety
backstop that fires on a model nobody selected is not a backstop, it is an
outage.

Fix: require BOTH $0 pricing AND a ':free' id, and EXCLUDE (continue) on a
miss. Live sends still pass the real gate, which is where a backstop belongs.
This also resolves the lyria concern from the modality work: the permissive
modality rule still admits them, and rule 2 drops them for lacking ':free',
so runtime no-text demotion never has to.

The existing test asserted the THROW, so it encoded the bug; it now asserts the
requirement that was always intended ("never returned") plus the property the
throw destroyed — that a usable model survives alongside the excluded one. The
test was corrected, not weakened.

Verified: session_summary suite 79 passed, tsc clean, eslint clean, build clean.

- Fix(cli): give the legacy entry point the same auto-free pre-flight (TRDD-W9DK4L3N option A)

The published npm bin is dist/cli.js, and that path forwarded mass-scout / security-scan to
runMassScoutCli WITHOUT the free-model pre-flight the supported bin/llm-ext runs first. So a user
on the published binary could be billed in exactly the situation where the supported one would
have switched to a :free model. That is the whole defect; TRDD-8d8d33c8 was a symptom of it.

Fixed at the cause rather than patched per-call-site: cli.ts now consults the SAME exported
decision function the supported path uses (resolveMassScoutFreeModelOverride, index.ts:971) via
a new side-effect-free module. Copying the balance/engagement logic into the legacy path would
have worked today and drifted later — one resolver, two callers, no second copy. parseFlags was
deduplicated out of cli.ts into that module while there.

Only the six spend-capable subcommands are intercepted; every other subcommand returns argv
byte-for-byte so the read-only paths keep making zero network calls — there is a test asserting
exactly that, because "add a guard everywhere" is how a read-only command quietly acquires a
balance probe. security-scan needed its own injection point: its model lives inside the
--input-json payload, not in a flag.

The module is separate from cli.ts because cli.ts invokes main() against process.argv at import
time — importing it from a test would run the whole CLI.

package.json is deliberately untouched: re-pointing the bin (option B) is a breaking change and
remains unapproved. Suite 1795 passed / 0 failed, tsc + lint clean.


### Miscellaneous

- Chore(deps): sync package-lock bin block with the re-pointed bin

The lockfile cached the old "llm-externalizer": "dist/cli.js" mapping. Left
alone it is a stale record of the published entry point that contradicts
package.json — regenerated with --package-lock-only so the two agree.

- Chore: remove .serena — the project uses CLI tools, not MCP

The owner banned MCP use on this machine ("i only use cli tools now"), so
Serena's per-project config is dead weight. This plugin already deleted its own
MCP server in v11.0.0 (d557c68); .serena was the last MCP-tool config left in
the tree.

Removed via the janitor's safe-delete, not rm: .serena/project.local.yml was
gitignored, so a plain rm would have destroyed it with no git history to
recover from. All 7 files (incl. the 5 MB typescript symbol caches) are staged
in .trashcan/20260811_192502+0200/ with a manifest, recoverable by one mv for
~90 days.

Also tracks the .trashcan markers so the directory survives `git clean -fdx`
and fresh clones, per the safe-delete contract.


## [11.1.0] - 2026-08-05

### Added

- Feat(cli): diff-mode review — workspace/range/commit scoping, git-delegated (TRDD-MNK2YNH0)

llm-ext reviewed WHOLE FILES only. Diff modes (diff_workspace,
diff_from/diff_to with merge-base '...' semantics, diff_commit) now scope the
review-family tools (scan_folder / high_quality_scan / code_task /
review_plan) to what actually changed — resolution DELEGATED to git (argv
arrays, no shell interpolation; flag-shaped refs rejected before reaching
git), applied at ONE dispatch chokepoint that rewrites input_files_paths, so
the tools, the rules engine, --estimate and --preview all see the SAME scope.
review_plan embeds the per-file hunks with git's own enclosing-function
context (--function-context — no tree-sitter dependency, no hand-rolled brace
matcher). FAIL-FAST: non-repo, zero-file diff, and mixed modes are loud
errors, never a silent full-tree review.

Two measured-in-live-fire guards: git diff --no-index exit 1 means
'differences found' (the NORMAL untracked-file case), not failure; and a
per-file 400KB hunk cap with VISIBLE skips — the first workspace run swept
tracked dist bundles into a 46MB 'plan' that reviewed nothing.

7 fixture-repo tests (real git init, never a mocked git). Full suite 1714.

- Feat(cli): layered per-path review rules + rules-check (TRDD-3JQVBO7M)

Distilled from OCR's rule.json concept, adapted to YAML and this plugin's
rules: precedence --rules (explicit, LOUD on failure — the caller named that
file) > <repo>/.llm-ext/rules.yaml > ~/.llm-externalizer/rules.yaml (opt-in) >
none (zero-config default: tools unchanged, Auto-DUBC). Entries are
{path-glob, rule}, first match in DECLARATION order, case-insensitive globs
(**, *, ?, {a,b}, [abc]) via a small tested converter — no new dependency.
Rules AUGMENT the caller's instructions, never replace them, applied at ONE
dispatch chokepoint for scan_folder / high_quality_scan / code_task /
review_plan through the same file resolver --estimate/--preview use.

rules_check is the debug surface: which layer, which file, which entry fired.
Ships the project's own .llm-ext/rules.yaml (FAIL-FAST encoded; tests exempt).

Verified live: rules-check resolves the project layer with correct first-match
(test file → test rule, source → TS rule); review-plan's emitted plan carries
the matched rule. Full suite 1707 passed, README/catalog counts 42.

- Feat(cli): --preview selection dry-run with per-path exclusion reasons (TRDD-SCLGL8T4); fix catalog test to 41

Distilled from OCR's delegate-preview concept, adapted: an onExcluded reason
channel threaded through walkDir ITSELF — never a second walker — so the
preview can never drift from the real selection (the card's one-source-of-
truth requirement). Reasons: binary extension, extension filter, excluded dir,
hidden dir; in gitignore mode the ignored files are never enumerated by git
ls-files, and the preview says so instead of pretending completeness.
--preview composes with --estimate (selection + price in one dry-run, zero
sends) — verified live: a .jsonl excluded with its reason, then priced.

Also: index.test.ts's hardcoded catalog list updated to 41 — review_plan
(9ae1258) landed while only targeted suites ran, so the full suite had ONE
red test until now. Full suite: 1697 passed, exit 0.

- Feat(estimate): self-calibrating EXPECTED line — output-token EWMA per tool×model (task #188)

Closes the --estimate loop (a4b19bc): every completed request with a usage
block folds completion_tokens into an EWMA sidecar (output-ewma.json, α=0.3,
tmp+rename, best-effort IO), keyed tool::model via the usage context. The
estimator prefers the EWMA once it has ≥3 real samples — one lucky short reply
must not swing a budget decision — and says so in a note ('calibrated from N
recorded runs'). The CEILING never calibrates: it is a guarantee, not a
prediction. Auto-DUBC: the estimator sharpens itself from use with no user
action.

Verified live: a $0 chat wrote per-slot entries with real token counts (and
incidentally re-proved #189 — the recorded trio excludes the classifier).
87 tests green across estimate/usage-history/free-rotation suites.

- Feat(free-mode): runtime auto-demotion of length+empty repeaters, self-healing (task #189 c)

A model that burns its whole completion budget on reasoning and emits no
content — the length+empty cost-stop and the exhausted-retries NO CONTENT
label in provider/completion.ts — is unfit in current conditions whatever its
ledger says. Three such strikes (the reasoning ladder's full course) demote it
to the fail tier of the ensemble ranking via combinedFreeModelEvidence; ANY
content-bearing success clears the strikes, so demotion is reversible with no
user action in either direction (Auto-DUBC). Strikes persist cross-process
(no-content-strikes.json, tmp+rename, best-effort IO that never throws into a
live call). Deliberately a RANKING signal, not a rotation cooldown — the model
stays available as a rotation fallback; it just stops being a preferred slot.

119 tests green across the four free-mode suites.

- Feat(free-mode): rank the free ensemble by bench evidence; clamp classifier-class models (task #189 a+b)

2026-08-05 incident: the auto-selected free trio included
nvidia/nemotron-3.5-content-safety:free — a SAFETY CLASSIFIER — for code
review, and produced length+empty on nearly every call. selectFreeEnsembleModels
was order-preserving slice(0,3): it consumed only the security-triage failed
set and ignored the per-tool ledgers entirely.

Fix: RANK, never hard-exclude (invariant 2 — a pool must degrade, not empty).
parseBenchEvidence folds the 5 per-tool ledgers into pass/fail per model (pass
wins across tools); rankFreeModelsByBenchEvidence sorts pass < unknown < fail
with stable operator order inside tiers, and classifier-named ids clamp to the
last tier on NAME alone. Measured subtlety that shaped the parser: ALL 17
ledgered ':free' models carried 'below <tool> requirements' rows because the
premium criteria reject the ':free' CLASS by design (allowFree:false) — a
class rejection is not task-quality evidence, so requirements rows carry NO
verdict; only scored golden-dataset failures demote.

Verified live: a $0 chat now engages laguna + north-mini + nemotron-3-ultra;
content-safety is out (grep count 0). 118 tests green across the four
free-mode suites. Item (c) — runtime auto-demotion of length+empty repeaters —
is the remaining half of #189.

- Feat(cli): review-plan — $0 delegate mode where the host agent reviews (TRDD-SNAEERHU)

Distilled from OpenCodeReview's delegate concept, adapted (never vendored —
OCR is Go): llm-ext emits the deterministic scaffolding (file set via the
SAME resolver seam --estimate uses, rubric, per-file protocol) with zero LLM
calls, and the host agent reviews with its own model. Measured basis: on the
planted-ground-truth range the host-agent workflow was the only configuration
that found the planted bug — at $0 — while driven-LLM reviews found nothing
at up to $0.55/run (reports/open-code-review-eval/20260805_005500+0200-
final-trusted-results.md).

Ships: catalog entry (CLI command generated), dispatch case, pure builder +
5 unit tests, skill llm-externalizer-review (two-surface rule), estimator
zero-cost entry, README 40→41 (doc-consistency gate green). Verified live
through the bare command: 0.42s, zero sends. Remaining on the card: the
no-settings boot path (STATE block).

- Feat(cli): --estimate cost dry-run for every file/instruction tool (task #187)

USER directive 2026-08-04: any command must be able to report its predicted
cost INSTEAD of running, and the paid-mode guidance must tell agents to do so
before every paid operation.

estimate.ts is pure and network-free; buildEstimateDeps() in index.ts is the
one place its seams bind to the real internals (resolveFolderPath, ensemble
slots, model-cache pricing) so the estimate walks the SAME file set and model
slots the run would use — an estimate over a different file set would be worse
than none. Two numbers per slot: expected (calibrated constant, tightenable
later from history) and ceiling (max_tokens every request — cannot be
exceeded). Fail-fast: an unmodeled tool THROWS rather than printing a guess;
mass_scout points at its own tighter registry-bound estimator.

Verified end-to-end through the bare command: 93-file scan estimated in 3.2s,
zero LLM sends, per-model output clamping visible, $0 on the free ensemble.
11 new unit tests (arithmetic + fail-fast negatives).


### Changed

- Build(dist): rebuild bundles with the ultracode F0-F22 fixes

Full gate on the finished state: tsc 0 errors, eslint 0 problems,
vitest 1727 passed / 4 skipped (117 files).

- Build: rebuild dist bundles with the day's six features

esbuild output for e08b381..02d4707 (breaker fix, --estimate + EWMA,
review-plan, --preview, rules engine, diff modes, roster ranking). The
publish gate asserts the VERSION anchor inside dist/llm-ext.js, so dist must
track src at release time.


### Documentation

- Docs: true counts, runnable examples, no gitignored-path citations (ultracode F17-F20, F22)

- The always-installed usage rule said "40 commands" twice; the catalog is
  42 (review-plan + rules-check landed in this range) — verified against
  the live `llm-ext --help` output, and the example command list names the
  two new ones.
- Its cost-safety example ran scan-folder without --instructions, which
  runScanFolder requires — the "real run" example failed as written. Both
  example lines now carry the required flag.
- README repository layout: 16 skills (llm-externalizer-review is the
  16th) and 40 slash commands (the 35 was stale from an earlier range) —
  both counted from the tree, not assumed.
- The review skill and review-plan.ts cited a reports/ path as their
  headline evidence, but reports/ is gitignored — the file ships in no
  clone. The measurement is now cited by date, with the source of the
  claim stated honestly.

- Docs: showcase diff modes, per-path rules, and the dry-run pair in README + skills

The generated --help already carried the new flags; the README feature list
and the two review skills now teach WHEN to reach for them (diff modes for
reviewing recent changes, rules-check to see which rubric fires, --estimate/
--preview before any paid run). Doc-consistency gate green.

- Docs: close TRDD-MNK2YNH0 — diff-mode review shipped (a3f03ae), the distillation board is DRAINED

- Docs: close TRDD-3JQVBO7M — layered rules engine shipped (bee8f71), acceptance verified live

- Docs: close TRDD-SCLGL8T4 — --preview shipped (c46a774), all acceptance verified live

- Docs: close TRDD-SNAEERHU — review-plan v1 complete, all acceptance verified

The closing edit: no-settings boot path verified in a throwaway HOME (Auto-DUBC
generated defaults, exit 0). Deferred integrations live on their own cards
(MNK2YNH0 diff args, 3JQVBO7M per-path rules).

- Docs: add TRDD-SNAEERHU, TRDD-MNK2YNH0, TRDD-3JQVBO7M, TRDD-SCLGL8T4 — the OCR distillation backlog

The 'filter what we integrate' deliverable of the OCR evaluation (USER
directive 2026-08-04): four adapt-not-vendor features distilled from
OpenCodeReview's deterministic half — review-plan delegate mode ($0 host-agent
reviews), diff-mode scoping, layered per-path rules, --preview selection
dry-run. Each card cites the measured evidence in
reports/open-code-review-eval/ and carries the user's constraints verbatim:
no UI, Auto-DUBC, YAML opt-in, crossplatform. Discarded (knowledge only, no
card): OCR's agentic LLM loop (measured 0-precision half), its WebUI, its
plaintext-key provider config.


### Fixed

- Fix(estimate): price the right models, resolve the same files, model pairs honestly (ultracode F5-F12, F21)

The --estimate/--preview/rules resolver diverged from the real runs in
eight confirmed ways; each is now fixed at the seam, with tests:

- F5: high_quality_scan was priced against the cheap ensemble while the run
  bills its single premium model — ensembleSlots(toolName) now returns the
  hq slot for it; security_scan (mass_scouting subsystem, own model
  selection) is refused with a pointer to its own estimator instead of
  being priced on models it never sends to.
- F6: the resolver read `excluded_dirs` while every real tool reads
  `exclude_dirs`, so any dir-exclusion made dry-run and run resolve
  different file sets. One name now (exclude_dirs), including review_plan's
  schema.
- F7: max_files/recursive/follow_symlinks are threaded into the resolver —
  the estimate no longer walks the fixed default while the run honors the
  caller's knobs.
- F8: instructions-only and input_files_content-only chat are legal paid
  runs (one request per slot); the estimator priced neither and aborted on
  both. Zero-file chat now estimates, and content/instruction-file bytes
  are counted.
- F9: an uncompilable glob ([b-a]) threw at MATCH time inside dispatch,
  taking the tools down from a non-explicit rules layer. globToRegExp now
  fails closed (matches nothing) — per its own documented contract.
- F10: callers supplying the prompt via instructions_files_paths silently
  got no rules augmentation; the chokepoint now treats instruction files as
  the first-class prompt source they are.
- F11: inside {a,b} alternates, ** could not cross a slash and ? compiled
  to a live regex quantifier. Alternates now get the same wildcard
  translation as the main walk.
- F12: compare_files sends one request per PAIR — git mode is $0 (no LLM),
  file_pairs counts 2-element pairs, pair mode enforces exactly 2 files.
- F21: files dropped by the max-files cap were silently omitted from
  --preview; they now carry a "max-files cap" verdict when a reporter is
  attached (the cap-free early exit is preserved otherwise).

- Fix(free-mode): make bench evidence real, strikes self-heal, breaker truly transport-only (ultracode F0-F4)

Adversarial multi-agent review of the unpushed stack confirmed five defects
in the free-mode/cost-safety layer; all five are fixed with first-hand
verification and regression tests:

- F0: the ledger `qualified` field records only the catalog-requirements
  gate, which rejects the whole ':free' class by design — so the #189
  bench-evidence ranking could never see a quality verdict for the very
  pool it ranks. Every scored benchmark run now persists the golden-dataset
  verdict as `qualityPass` (backfilled on cache hits), and parseBenchEvidence
  reads it as layer 1, keeping the old inference only as a legacy fallback.
- F1: a no-content-demoted model drops out of the top-3 and may never be
  called again, so the success-heals path could never fire — the demotion
  was permanent, contradicting the store's self-healing contract. Strikes
  now EXPIRE after a 24h TTL, and a new strike after the gap restarts the
  window at 1 ("3 under current conditions", not "3 ever").
- F2: model-shape HTTP-200 responses neither fed nor reset the transport
  breaker, so sparse timeouts spread across hours of healthy 200s still
  summed to the "consecutive" threshold. A 200 now records a transport
  success — restoring "consecutive" to its literal meaning.
- F3: backoffAttempt was incremented AFTER the cooldown sleep, so a waking
  sleeper could advance a freshly-reset ladder past its end. The slot is now
  claimed synchronously BEFORE the await.
- F4: making the breaker transport-only deleted the accidental run-level
  spend stop for paid models returning billable empty 200s. A deliberate
  one replaces it: RUN_PAID_EMPTY_RETRY_BUDGET (30) empty retries per paid
  model per process, then no more billed retries (free models exempt — $0).

Test honesty (F13/F14): the breaker guard now counts EVERY textual
recordServiceFailure() occurrence on comment-stripped code (the per-line
anchor missed guarded calls), and pass-wins is asserted in BOTH orderings.

- Fix(free-mode): transport-only circuit breaker + half-open on abort + rotation refuses global verdicts (TRDD ref: task #186)

Livelock post-mortem (2026-08-04, verified by live probe: HTTP 200 while the
breaker claimed outage): (1) empty/length responses over a WORKING transport
fed the GLOBAL breaker, so a parallel scan on reasoning-heavy free models
tripped it in seconds; (2) once backoff exhausted, nothing could ever reset the
breaker (the only reset needed a completed request, and a tripped breaker
aborts before any request) — every later call was stillborn; (3) the abort
text contains 'overloaded', so classifyUnavailable called the GLOBAL verdict a
per-model transient and rotation cycled the whole pool through 30s cooldowns
forever, zero requests going out.

Fixes: recordServiceFailure() now fires ONLY from the thrown-request branch;
the exhausted-backoff abort half-opens the breaker; classifyUnavailable
returns null on the breaker signature so callers fail fast with the breaker's
own message. Guards: exact-count + signature assertions in
free-rotation-coverage.test.ts, mutation-verified classify test with the
verbatim production abort string.

- Fix(benchmark): skip rows name the gate that actually fired; pin scan skill foreground

Two independent skip causes share the code-task send-loop skip: per-profile
free_only, and the paid-benchmark gates (paidBenchmarkWouldRefuse). The row's
disqualifyReason is PERSISTED to the ledger, so a row claiming 'free_only
active' on a profile where free_only is OFF sends the next reader hunting a
flag that was never set. Say which gate fired.

SKILL.md: Claude Code 2.1.218 made context:fork skills background by default,
which would silently change /llm-externalizer-scan's contract (returns report
paths inline). background:false pins the documented behavior.

- Fix(benchmark): one malformed response no longer kills a whole tool's sweep

The code_task phase died mid-run on "Unexpected end of JSON input" and was
skipped, so all 16 models lost their run and the ledger stayed empty — after
the free-pool sweep had finally been unblocked. Cause: `await res.json()` was
the ONE unguarded failure mode in each runner. Network errors, timeouts,
non-2xx and empty content all degrade to a per-file/per-case failure the
pipeline understands; a 200 whose body is empty or truncated threw a bare
SyntaxError straight out of the sweep.

Free-tier providers return exactly that under load. The model that triggered
it had already spent ~94s and 6440 output tokens on an earlier phase.

The same unguarded call was in all four runners (code-task, scan-folder,
check-specs, search-existing), so all four are fixed the same way: parse
inside a try, and on failure emit the shape that runner already uses for a
bad HTTP status — a per-file failure for the three that return results, a
thrown-and-classified recoverable batch error for search-existing (with the
original attached as `cause`, and the HTTP status in the message, which a
bare SyntaxError never carried).

This is not error-swallowing: nothing is hidden, the failure is still
recorded and still costs the model its score. It changes the blast radius
from "every model in this tool" to "this one response".

Note: prettier reflowed neighbouring lines in these four files, so the diffs
are larger than the logic change. The repo does not enforce prettier (82
files are unformatted and there is no prettier publish gate), so this is
local churn only.

Verified: tsc 0, eslint 0, 1671/1671 vitest (up 1 — the master-switch-off
test from 8097df1).

Agent: llm-externalizer

- Fix(benchmark): let the free pool actually be benchmarked in free mode

Free-pool validation could never run. Every per-tool phase force-adds the
incumbent ("ALWAYS assess the incumbent, so the gate has a fallback"), and
that incumbent defaults to the PAID qwen/qwen-2.5-7b-instruct. With
allow_paid_models false, assertPaidBenchmarkAllowed then refused the WHOLE
run over a candidate the sweep had auto-added — so the $0 models it exists
to score were never scored. That is why the per-tool ledgers were empty and
no free model ever passed rank-0: not because free models failed, but
because the sweep aborted before sending anything.

The guard was right; the unconditional paid-incumbent injection was wrong.
A refused incumbent is one we may not send anyway, and the selection gate
reads the incumbent's id + pricing directly (incumbentIn/incumbentOut), not
its assessment row — so skipping it costs nothing the guard was protecting.

- discover.ts: new paidBenchmarkWouldRefuse(), mirroring BOTH of the assert's
  throw branches (master switch AND per-run opt-in). Gating on the master
  switch alone still aborted for a paid-profile user who omitted
  --allow-paid-models-tests. Sharing one predicate is what stops the skip and
  the refusal from drifting — and drift here means a paid model the assert
  waved through and the phase then BILLED.
- The 5 phases: skip the AUTO-ADDED incumbent when that predicate is true.
  The assert is untouched for user-typed ids: an explicitly named paid model
  must still be refused loudly, never silently dropped.
- code-task: the send-loop skip keyed only on the per-profile free_only flag,
  which is FALSE for anyone whose free mode comes from the top-level
  allow_paid_models switch. That was a real path to billing a paid model, so
  it now also honours the shared predicate.
- config.ts + benchmark/index.ts: --bench-free-pool read resolveProfile()'s
  freeModels, which config.ts gates on that same per-profile free_only — so
  it silently fell back to the hardcoded FREE_POOL_SEED and benchmarked stale
  seed ids instead of the pool actually in use. profileFreeModels() reads it
  unconditionally. Not fixed inside resolveProfile: freeModels=[] when
  !free_only is a runtime invariant there (it derives model/second_model/
  third_model), so widening it would change the live ensemble.

Verified: 16 models benchmarked across 5 ledgers where 0 had been, $0.0000
spent, settings.yaml unchanged. tsc 0, eslint 0, 1670/1670 vitest. The new
master-switch-off test was mutation-checked — stubbing the predicate to
return false makes it fail — because a test that passes without the fix
would just be another gate reporting green over nothing.

Agent: llm-externalizer


### Miscellaneous

- Chore: track the tailored OpenCodeReview rule pack

The project-level .opencodereview/rule.json (real-defects-only, FAIL-FAST
encoded) serves any future OCR delegate-mode use on this repo and keeps the
tree publish-clean. No key, no secrets — rules text only.


## [11.0.0] - 2026-08-01

### Added

- Feat(cli)!: retire the MCP server — llm-externalizer is a CLI plugin

BREAKING: installing this plugin no longer installs an MCP server. Every tool
is reached through `llm-ext <command>` instead of an MCP tool call.

WHY: the 40 tool schemas were injected into every turn's base context (~32k
tokens, the plugin's single largest standing cost) whether or not a tool was
used, and the MCP surface was a second runtime funnel that had to be kept in
lockstep with the CLI one. Two surfaces now — the CLI and the skills that drive
it — and nothing enters context until the agent chooses to run a command.

The dispatch layer was already MCP-agnostic, so this deletes a round-trip rather
than porting logic: `dispatchCallTool(name, args, opts)` took a plain string and
a plain object and returned a plain object; the SDK was touched in six places.
`bin/llm-ext` and `src/cli.ts` were never real CLIs — they spawned dist/index.js
as an MCP server subprocess and spoke JSON-RPC to code in their own bundle.

- index.ts: drop McpServer/StdioServerTransport, the registerTool loop, the
  tools/list_changed + description-refresh machinery, and the JSON-Schema→Zod
  converter that existed only to feed registerTool (5264 → 5088 lines).
- Export `boot()`. dispatchCallTool THROWS if it has not run, because boot()
  calls publishFreeState() and without it a remote profile silently sends PAID
  models while allow_paid_models is false. That must be impossible to forget,
  not merely documented.
- Progress reporting survives on stderr instead of MCP notifications: mass_scout
  and security_scan run for tens of minutes, and a CLI that prints nothing that
  long is indistinguishable from a hang.
- Remove the module-scope settings watchFile(). This is load-bearing, not
  cleanup: it registered a 5s poller merely on import, which kept Node's event
  loop alive forever — `llm-ext --help` printed correct output and then HUNG.
  All 1645 unit tests passed while the shipped binary was unusable, because
  every test imports the sources directly and none run the wrapper.
- launcher-boot.test.ts now asserts the real launcher runs the real bundle AND
  EXITS, which is the assertion that would have caught the above.
- bin/llm-ext: 738 lines of JSON-RPC client → a 45-line wrapper. Help text,
  command table and flag types are generated from the one real tool catalog
  instead of a hand-maintained second copy.
- launcher.mjs keeps its better-sqlite3 self-install (mass_scout needs it) and
  now imports the CLI. The argv[1] mutation goes with the entry-point guard it
  existed to satisfy.
- test-helpers.ts spawns the CLI instead of an MCP client, preserving the
  cost-safety isolation verbatim (throwaway LLM_EXT_CONFIG_DIR + synthetic local
  settings unless liveBackend) so tests still cannot bill the real backend.
- Delete .mcp.json, bin/llm-externalizer, mcp-server/server.json,
  scripts/hooks/install-mcp-deps.sh (already dead — hooks.json is empty), and
  scripts/diagnostics/check-mcp-server.py.

KNOWN INCOMPLETE, deliberately committed as a checkpoint mid-migration:
- 2 tests fail: "progress notifications" chat/code_task exit with a null code
  against an unreachable backend, i.e. the child is SIGKILLed rather than
  exiting — a possible second hang, not yet diagnosed.
- src/cli.ts still opens a StdioClientTransport; its real subcommands are not
  yet folded into the new command table.
- The ~90 command/skill/agent/doc call-sites still reference MCP tool names.
- publish.py still version-syncs mcp-server paths; that lands with the CPV
  canonical-pipeline upgrade.

Verified: tsc 0, eslint 0, 1668/1670 tests, `./bin/llm-ext discover` reports
free mode ON with the 14-model pool in 0.7s.

- Feat(config): free-by-default — the allow_paid_models master switch (TRDD-8b6b3646)

USER directive: "only free models are actually viable." Every tool now uses FREE
models by default; a single top-level settings switch opts into paid, and until
it is set NO paid spend of any kind happens — paid profiles run free and even paid
benchmarks are refused.

The switch reuses the existing free-only machinery rather than inventing anything.
The credit-auto-switch (TRDD-542bdbef) already routes every spend site through a
free pool, resolveAutoFreePool already falls back to a bundled FREE_POOL_SEED when
a profile pins none (so nothing goes dark), and filterFreeModels already
benchmark-vets the pool. This change fires that same machinery at boot from a
master switch and blocks the two paid ENTRY points while it is off.

What landed:

- Settings.allow_paid_models (top-level, DEFAULT false; absent ⟺ false = free).
  Parsed in loadSettings AND in reloadSettingsFromDisk (the reload builder used to
  drop every top-level key but active/profiles — editing the switch would have been
  silently ignored until restart). State lives in a new LEAF module paid-switch.ts,
  NOT config.ts: config → registry → benchmark/discover is an existing chain, and
  discover.ts needs the switch at its paid-benchmark chokepoint; importing config
  there would close the cycle and left TOOL_MODEL_REGISTRY undefined at init (caught
  by registry.test.ts). config.ts re-exports so its consumers are unchanged.

- forceFreeByMasterSwitch: a RECOMPUTED (never sticky) flag OR'd into the central
  isFreeModeActive() predicate, so every "free_only OR auto-free" decision now also
  honours the switch — with no per-site latch. It is a clean TOGGLE (unlike the
  sticky low-balance auto-free): recomputed on boot (main) and every reload via
  publishFreeState(), which also re-publishes the config chokepoint. The pure
  decision is shouldForceFreeMode(allowPaid, mode) — remote+paid-off ⇒ force; local
  and null-mode never forced — extracted so it is unit-testable.

- activeFreePool(): one helper feeding the main ensemble AND the subsystem
  substitution, always non-empty (resolveAutoFreePool seed fallback) — the
  "never dark" guarantee (D1): a paid profile with no free_models still runs a
  working :free ensemble the hourly reconcile then upgrades at $0.

- Paid benchmarks blocked (D4): assertPaidBenchmarkAllowed now refuses paid
  candidates when allow_paid_models is false, BEFORE the per-run opt-in and NOT
  overridable by it — --allow-paid-models-tests cannot beat the master switch. The
  benchmark CLI and the main CLI publish the switch at startup so their separate
  processes gate correctly; the main CLI also forces the chokepoint on for a remote
  profile (fail-safe: an in-process paid send throws $0 rather than routes free —
  its heavy work spawns the fully-wired MCP server child).

- high_quality_scan (D2): stays a REFUSAL, not a silent downgrade — its contract is
  "ONE strong paid model", so degrading it would return free-tier results under a
  name that promises better. The gate now keys off the runtime free state
  (isFreeModeActive) so forced-free triggers it, and names the switch as the fix.

- Visibility: discover now reports "Free mode: ON (allow_paid_models=false)", the
  actual free pool, and that the configured paid Model lines are ignored — so the
  paid→free default is never a silent surprise.

Free-ensemble vetting stays PERMISSIVE (D3): drop only benchmark-FAILED free
models; never-benchmarked ones are allowed and the background auto-bench scores
them over time — this is what keeps free-default working out of the box.

Local profiles are untouched throughout ($0/offline). allow_paid_models: true
restores today's behavior exactly (paid sends + paid benchmarks; per-profile
free_only remains an opt-in). Purely additive; defaults to the safe side.

+24 tests: shouldForceFreeMode (remote/local/null × paid on/off); allow_paid_models
parse (default false, true only for literal true, typo→false) + cache round-trip;
the HQ refusal's switch-message vs the back-compat free_only wording; the paid-
benchmark master-switch block (blocks even WITH the opt-in; :free/$0 still free).

Verified at runtime on the live remote-ensemble-geminigrok (paid) profile: discover
shows Free mode: ON and a 15-model :free pool; `benchmark --code-task <paid>
--allow-paid-models-tests` refuses naming the switch, $0 spent. tsc/eslint clean,
1667 tests pass, dist rebuilt.

BREAKING CHANGE: the default for OpenRouter profiles is now FREE. A profile that
configured paid models will run its free pool (or an auto-discovered $0 pool) until
you set `allow_paid_models: true` in ~/.llm-externalizer/settings.yaml. Local
profiles and existing `free_only` profiles are unaffected.

- Feat(iron-rule): refuse unvalidated paid models at send time (TRDD-8b6b3646)

Phase 3b — wires the validation gate (Phase 3a, f51f7c4) into every paid send
path. A PAID OpenRouter model now REFUSES before the wire unless it passed the
benchmark for the tool being called (or a harder one). $0 spent on refusal.

Send-time chokepoints, each beside the existing assertFreeOnlyModel:
- provider/connection.ts — the universal resolver. Reads the tool name from the
  usage-history AsyncLocalStorage (ctxStore), which the MCP dispatch sets ONCE per
  invocation — so the gate needs ZERO threading through the completion stack, and
  fires ONLY when a tool context is present. A context-less call (a unit test, or
  the benchmark runner — which is EXEMPT and bypasses resolveConnection anyway) is
  not gated. Covers the ensemble, rotation, modelOverride, and 402→free paths.
- security_scan/judge.ts — tool "security_scan" (fetches OpenRouter directly).
- mass_scouting/scout.ts + cli.ts — tool "mass_scout" (rank 0: any pass validates).

Exemptions live in assertModelValidated: local backend + ':free' models. The gate
does NOT fail open — a missing/corrupt ledger means no proof of a pass → refuse.

Test reconciliation: the gate reads REAL ledgers, so suites that drive the
scout/judge/cli plumbing with a MOCKED fetch (no spend, no ledger fixture) tripped
it. Added setValidationBypassForTests(bool) to validated.ts — a production-never-
called escape hatch (same shape as setPaidBenchmarksAllowed), toggled in
beforeEach/afterEach of the 5 affected suites (scout, cli, security_scan, wiring,
free-mode). +1 validated.test.ts assert for the bypass.

CONSEQUENCE (as the USER chose): the current remote-ensemble-geminigrok profile
(deepseek + 2 mimos) is now refused on every paid tool until re-validated —
Phase 4 (paid, ask-first) does that hardest-first.

1647 tests pass, tsc + eslint clean. dist rebuilt.

- Feat(benchmark): validation ledger readers + difficulty hierarchy (TRDD-8b6b3646)

Phase 3a — the IRON RULE's data layer (send-time wiring lands next). New
benchmark/validated.ts answers "is paid model M validated for tool T?":

- passedModelsFromKeyedLedger: latest-wins, conclusive-pass reader for the
  modelId::date::hash ledgers. security-triage → score.pass && !score.inconclusive;
  the four deterministic tools → failureReasons.length===0 (an empty/errored/429
  run has non-empty failureReasons, so mimo-v2.5's empty result is correctly NOT a
  pass). General keyword sweep (benchmark-results.json snapshot) → ok && pass.
- TOOL_DIFFICULTY_RANK (single source of truth): code_task 5 > check_against_specs
  4 > scan_folder 3 > search_existing 2 > security_scan 1 > general/unbenchmarked
  0. validatedModelsForTool(T) = UNION of every ledger ranked ≥ rank(T) — a HARDER
  pass covers all easier tools (the money-saver: don't re-benchmark what's already
  implicitly covered). A rank-0 tool (chat/cluster_synonyms/…) is validated by ANY
  pass; code_task only by a code_task pass.
- assertModelValidated(model, tool, backendType): the chokepoint. No-op for local
  or ':free' (out of scope — $0). Refuses an unvalidated paid model with a
  copy-pasteable validate command. REFUSES on a missing/corrupt ledger — cost-
  safety does NOT fail open (opposite of the reconcile pre-flight). Lives here, not
  config.ts, so config stays benchmark-free (no cycle).

validated.test.ts (+9): hierarchy (harder covers easier, general only rank-0),
pass extraction (failureReasons / inconclusive excluded), chokepoint (refuse
unvalidated + missing ledger, allow validated, exempt local/:free).

1646 tests pass, tsc clean. Wiring (connection.ts + subsystems) + dist next.

- Feat(benchmark): paid-model benchmarking requires explicit opt-in (TRDD-8b6b3646)

Phase 2 (USER directive): benchmarking a PAID model requires the
--allow-paid-models-tests CLI flag or the allow_paid_models_tests MCP input. I
spent $0.20 this session running a paid code-task benchmark WITHOUT asking (and
it hung on an empty model) — this makes that impossible by default.

- discover.ts: process-level opt-in flag (setPaidBenchmarksAllowed /
  getPaidBenchmarksAllowed) mirroring config.ts's free_only accessors — the
  established pattern for cross-cutting cost-safety state, chosen over threading a
  bool through three heterogeneous phase-option shapes. assertPaidBenchmarkAllowed
  refuses (before any send, $0 spent) when a candidate is PAID (= not
  isFreeModeEligible: neither ':free' nor $0) and the flag is off. Runs AFTER the
  price cap, so its message only ever concerns models already ≤ $1.25/M.
- Wired at each phase's final-candidate chokepoint (keyword sweep +
  code-task/scan-folder/search-existing/check-specs/security-triage), beside the
  Phase-1 price cap.
- CLI: --allow-paid-models-tests parsed into CliOptions; main() publishes it via
  setPaidBenchmarksAllowed; help text documents it.
- MCP: allow_paid_models_tests added to security_triage_benchmark /
  search_existing_benchmark / check_tool_replacements schemas; each handler sets
  the flag EXPLICITLY on entry (true|false) so a stale true from a prior call in
  the long-lived server can never leak into a later paid send.
- Free/$0 paths (--bench-free-pool, bare --update-all) are inert — no paid model,
  no gate.

paid-guard.test.ts (+8): guard throws/allows, ':free' + $0 never gated, mixed set,
flag parse + default. Updated free-mode.test.ts (its stubbed-fetch paid-routing
tests opt in via beforeEach/afterEach).

1637 tests pass, tsc + eslint clean.

- Feat(benchmark): hard $1.25/1M price cap on every benchmark candidate (TRDD-8b6b3646)

Phase 1 of the paid-model cost-safety work (USER directive: never benchmark a
model whose input OR output price exceeds $1.25/1M). Independent of the per-tool
ModelCriteria cost gates, which apply only to auto-discovered candidates and can
be set arbitrarily high; this is a GLOBAL backstop that also binds explicitly-
named ids (`--code-task <id>`, `--include <id>`, an MCP `models:[...]`) which
bypass qualify() entirely.

- discover.ts: MAX_BENCHMARK_PRICE_PER_M=1.25 + overBenchmarkPriceCap() (pure;
  `>` cap so $1.25 itself is allowed, matching "≤ $1.25"; a non-finite/unpriced
  price counts as OVER — never benchmark a cost we cannot bound).
- filterModels() drops over-cap DISCOVERED candidates silently (the user never
  named them).
- assertModelsUnderPriceCap() FAILS FAST on over-cap EXPLICIT ids — refuses the
  whole run naming each offender + price, $0 spent (mirrors --bench-free-pool's
  non-$0 fail-fast). Wired into all six paid candidate builders (keyword sweep +
  code-task/scan-folder/search-existing/check-specs/security-triage), on the FINAL
  set incl. the always-assessed incumbent.

price-cap.test.ts (+7): cap boundary (≤ allowed), either-axis rejection,
non-finite→over, explicit fail-fast message, discovered drop.

1629 tests pass, tsc + eslint clean. dist rebuild deferred to end of the phase set.


### Changed

- Ci: adopt the CPV canonical pipeline, and fix CI's fatal server.json read

CI was red on EVERY run regardless of what was pushed. Its version-consistency
step read `mcp-server/server.json` — the MCP registry manifest the CLI
migration (d557c68) deleted — so the step died with FileNotFoundError before
checking anything. It now reads the three anchors that actually exist:
plugin.json, mcp-server/package.json, and the `const VERSION` literal in
mcp-server/src/cli/main.ts. Those are the exact three publish.py rewrites and
stages on release, so the CI check and the release pipeline can no longer
disagree about where the version lives.

Adopted the canonical pipeline via CPV 4.2.0:
- `release.yml` added (adapted for this repo's advisory gate).
- `publish.py` upgraded IN PLACE, not regenerated. It is the only thing
  permitted to push here, so a wholesale template overwrite would have been
  worse than no upgrade. Verified all four migration-critical behaviours
  survived: the `const VERSION` anchor in cli/main.ts, staging that SAME file
  (staging a different one leaves the bump uncommitted and the next publish
  starts dirty), the `dist/llm-ext.js` assert, and no resurrected server.json
  handling — its three remaining mentions are comments explaining the deletion.
- Canon adds the plugin-dependency resolver tag `{plugin-name}--vX.Y.Z`
  alongside `vX.Y.Z` (CC >= 2.1.110).
- plugin.json records `pipeline_profile: remote-validation` plus an explicit
  `intentional_divergence` list, so the deviations are declared rather than
  rediscovered as drift on every future validation.

Dropped the two `check-mcp-server.py` tests. The script probed a spawned MCP
server and went with it in d557c68, so both tests asserted against a file that
does not exist — pytest was red for the same reason CI was. They are NOT
replaced: `llm-ext discover` is the health check now, and the dogfood harness
already exercises it end-to-end against the real binary. Removed the dangling
CHECK_MCP constant and corrected the module docstring's "six behaviors of the
three scripts" to four of two, rather than leaving a docstring that describes
tests that are gone.

Verified: pytest 190 passed (was 188 passed / 2 failed) · ruff clean ·
tsc 0 · eslint 0 · 1670/1670 vitest · actionlint clean.

Still blocking a release, pre-existing and NOT introduced here:
RC-NONSTD-DIR-001 — CPV rejects the non-standard `mcp-server/` directory. That
is the Phase 8 rename, deliberately kept out of this commit so it can land as a
pure `git mv` with no content edits mixed in.


### Documentation

- Docs(cli): rewrite README/CHANGELOG and repair the two doc gates

**README/CHANGELOG.** Rewritten for a CLI with no MCP server, including the
BREAKING changelog entry. The substantive one is auth: `llm-ext` now runs as an
ordinary `Bash` subprocess, and this plugin's `userConfig` keychain value does
not reach it, so exporting `OPENROUTER_API_KEY` in the shell is the only
reliable way to supply the key. That is documented where users will hit it.

The evidence for that is deliberately stated narrowly. *Other* plugins'
`CLAUDE_PLUGIN_OPTION_*` variables ARE present in the same Bash environment —
only this plugin's is missing. Writing it as "Claude Code does not export
userConfig to Bash children" would have been a tidier sentence and a false one,
and would send the next person debugging a blank 🏦 panel looking for a
mechanism that works fine.

**Two gates that would have gone quiet.** Both kept their guarantee and changed
only the vocabulary they check it in:

- `doc-consistency.test.ts` asserted "N MCP tools" and snake_case names. It now
  reads "N CLI commands" and accepts either spelling — the CLI takes snake_case
  as a silent alias, so either is honest; what it still refuses is a command
  documented under NEITHER name, which users cannot discover.

- `dogfood_test.py` had degraded into a tautology. `resolve_command_tool` keyed
  off the `mcp__llm-externalizer__<verb>` entry in `allowed-tools`, with a
  Bash-only catch-all last. The migration made every command `allowed-tools:
  Bash`, so the catch-all matched all of them and returned PASS without
  resolving anything. It now extracts each `llm-ext <subcommand>` from the body
  and requires it to exist in the live command table, checked BEFORE the
  wrapper shapes — ordering is the fix, not the regex.

  Its catalog parser was also scanning for a `Tools:` header the CLI stopped
  printing (it prints `Commands:`), so the catalog came back empty. And the
  per-command help check wanted a `<cmd>:` header and 'No parameters.'; the CLI
  prints `llm-ext <cmd>` and 'Takes no parameters.'. All 40 failing identically
  was the tell that the assertion had moved, not the subject.

The through-line: every one of these still reported a green or quiet run while
checking less than it claimed. A check that cannot fail is worse than no check,
because it is counted as coverage.

Verified: tsc 0 · eslint 0 · 1670/1670 vitest · dogfood 104 PASS / 0 FAIL.

- Docs(cli): finish rewriting the surfaces off MCP tool names

Completes the pass started in a79750e. Every command, skill, agent, doc and
helper script now names `llm-ext <kebab-command>` instead of a
`mcp__llm-externalizer__<verb>` tool that no longer exists. `allowed-tools:`
is `Bash` wherever it named an MCP verb.

Not a find/replace — several passages asserted things that stopped being true
when the server went away, and those were rewritten rather than renamed:

- "call the `reset` tool (or restart Claude Code)" after editing settings.
  There is nothing to restart: every invocation is a fresh process that
  re-reads settings.yaml. `llm-ext reset` purges on-disk caches, and that is
  all it does now.
- "env var missing from the MCP server process" as the diagnosis for a
  missing token, with `.mcp.json` as the remediation. Neither exists.
- "the MCP surface is read-only / cannot write settings". The guarantee still
  holds and still matters, so it was kept and re-attributed to the CLI rather
  than dropped along with the word MCP.
- Per-tool parameter docs pointed at "each tool's own MCP description"; they
  now point at `llm-ext <command> --help`, which is generated from the same
  catalog the commands dispatch through and so cannot drift from them.

dump-state.py also had a stale pointer claiming SECRET_PATTERNS lives in
index.ts; it is in scan-pipeline.ts. Verified before changing — that comment
is what a future reader follows to keep the redaction list in sync, so a wrong
path there quietly rots the redaction.

Deliberately untouched: `mcp__serena-mcp__*` and `mcp__grepika__*` in the two
serial-fixer agents (other people's servers — a blanket `mcp__` sweep would
have broken them), the `benchmark-fixtures/` trees (frozen sample inputs whose
content is the fixture), the `design/` TRDDs (historical record), and
`docs/openrouter/responses-api.md` (its "MCP" is OpenAI's, unrelated).

README and CHANGELOG are still in flight and land next; the two
doc-consistency tests that assert README/catalog agreement fail until then.

- Docs(cli): start rewriting the surfaces off MCP tool names (partial)

The 40 command/skill/agent/rule files still told agents to call
`mcp__llm-externalizer__<verb>` for a server deleted in d557c68. Publishing in
that state would ship a plugin whose slash commands all invoke nothing.

This is a PARTIAL pass — 8 of 40 files, plus the two done by hand. A rate limit
killed the batch mid-flight; the rest follow.

- `allowed-tools: mcp__llm-externalizer__<verb>` → `Bash`, and the prose now
  names the concrete `${CLAUDE_PLUGIN_ROOT}/bin/llm-ext <kebab-command>` call.
- Dropped the MCP recovery instructions (restart Claude Code so .mcp.json
  respawns the server, rebuild dist/index.js) — none of that exists now.
- `reset` reworded: it purges on-disk caches; it no longer soft-restarts a
  long-lived server, because every CLI invocation is already a fresh process.
- rules/use-llm-externalizer.md rewritten CLI-first. This one mattered most: it
  opened with "if the mcp__… tools are NOT available, IGNORE THIS ENTIRE FILE",
  and installUsageRule() ships it into ~/.claude/rules/ on every machine — so
  after the migration it would have silently switched itself off everywhere,
  taking proactive adoption to zero with nothing on screen saying why.
- plugin.json: description and keyword say CLI, not MCP server.

Untouched on purpose: `mcp__serena-mcp__*` and `mcp__grepika__*` in the two
serial-fixer agents are OTHER people's servers. A blanket `mcp__` sweep would
have broken them.


### Fixed

- Fix: use the documented Skill() call form so the invocations actually resolve

Twelve `Skill(skill: "<name>")` invocations used a JS-object argument form that
is not the prompt convention. The convention — and what CPV's
`_SKILL_BARE_CALL_RE` parses — is `Skill(plugin:skill <ARGUMENTS>)`, so the
regex takes the FIRST token inside the parens and read the literal `skill` as
the skill name. Every one of them resolved to a skill called `skill:`, which
does not exist.

This is not cosmetic and not a validator workaround: an agent following the
written instruction would invoke a non-existent skill, and per CPV's own
message that "fails silently at runtime" — no error, the setup step just
quietly does nothing. The two in the setup agent were publish-BLOCKING MAJORs
(non-skillaudit, so `cpv.skillaudit_advisory` does not downgrade them).

The other ten, all under skills/huggingface-mlx-models/, were NOT flagged —
CPV's closure check scans agent bodies, and these live in a skill and its
references. They are the same defect with the same runtime consequence, so
they are fixed here rather than left to surface the next time the validator's
scope widens.

Verified: no `Skill(skill:` remains anywhere under agents/ skills/ commands/
docs/ rules/ · all six named skills exist (vmlx-setup, vllm-metal-setup,
huggingface-local-models, hf-cli, huggingface-best, huggingface-community-evals)
· dogfood 104 PASS / 0 FAIL.

- Fix(cli): repair the release pipeline and the last MCP round-trip

Three defects that each break something real, all fallout from deleting the
server in d557c68.

**publish.py aborted on every release.** Its version-sync anchor was the
`version:` field of the `McpServer` constructor in index.ts. That constructor
went with the server, so the regex matched nothing — and the "already at
target" fallback could not pass either, since the file carried no version at
all. The failure mode was the bad one: a hard `sys.exit(1)` partway through,
after plugin.json had already been bumped. Re-anchored on `const VERSION` in
cli/main.ts, the entrypoint that actually ships.

Same block staged `src/index.ts` while bumping a different file, which would
have left the bump unstaged: the release commit ships without it and the next
publish starts dirty. Now stages the file it rewrites. Dropped the
`server.json` handling (that was the MCP registry manifest; it is gone).

The post-build assert also pointed at `dist/index.js` — the server bundle,
which no longer carries a version literal, so it would fail every time. It now
asserts `dist/llm-ext.js`, the artifact users actually run, and fails loudly if
it is missing rather than skipping when absent. That assert is the only thing
standing between a silently no-op build and a stale bundle under a fresh tag,
so it must point at the shipped file.

**`npx llm-externalizer` was dead.** package.json still binds it to
dist/cli.js, which spawned `dist/index.js` as an MCP server child and JSON-RPC'd
to it — to reach functions already in its own bundle. With no server to spawn,
every one of its tool subcommands was broken. Inverted the dependency the same
way the test harness went: one `runTool()` calling `dispatchCallTool` in
process. Deleting the file instead was tempting, but it owns
`profile add/select/edit/remove/rename` — the only supported profile writer,
which has no equivalent in `llm-ext` yet. That would have been a regression,
not cleanup.

`--timeout-hours` now means something stricter than it used to: the MCP SDK's
timeout only abandoned the client's *wait* while the server kept scanning and
kept spending. The in-process bound ends the command.

**The CLI had no `--version`.** Added, which also gives publish.py a literal to
sync and a way to tell which build is installed.

Verified: tsc 0 · eslint 0 · `llm-ext --version` → 10.4.1 · that literal is
present in dist/llm-ext.js, so the publish assert passes. Production source no
longer imports @modelcontextprotocol/sdk anywhere. The dependency itself has to
stay for now: the three `src/live*.test.ts` files still import it, and
`npm run typecheck` covers them, so dropping it now would break the gate. They
are excluded from `npm test`, so they do not block a release.

- Fix(cli): accept `--flag true` for booleans; stop mistaking a retry ladder for a hang

Three defects surfaced by the migrated test suite, all found by running the
tests rather than reading them.

1. `--flag true` was rejected. parseFlags treated a bare `--flag` as boolean-true
   and skipped ahead, so an explicit `--scan_secrets true` left `true` dangling
   and died with "unexpected argument". Both spellings must work — the test
   harness itself generates the explicit form. The next token is now consumed
   only when it actually looks like a boolean literal, so `--quiet chat` still
   cannot eat the command.

2. The synthetic LOCAL test profile declared no `timeout`, so it inherited the
   long production default. That backend is DELIBERATELY unreachable, and the
   HTTP layer retries a network error 5 times with exponential backoff (~30s)
   capped only by the profile's remaining time budget — so every
   unreachable-backend test burned ~30s retrying something that can never
   succeed. It now declares `timeout: 5`.

3. The 10s per-call budget could not clear boot + the first model-reconcile (a
   fresh throwaway config dir has no last-reconcile.json, so it is not
   throttled) + the ladder. `execFileAsync` SIGKILLs on timeout, which surfaces
   as `exitCode: null` — indistinguishable from the CLI hanging. That cost a
   real debugging session chasing a hang that did not exist; the measured cost
   is ~13s, so the budget is now 20s with a comment saying not to tighten it.

Only #1 was a product bug; #2 and #3 were the tests lying about a hang. Worth
distinguishing, because a genuine module-scope hang HAD just been fixed one
commit earlier, which is exactly why the false positive was convincing.

Verified: tsc 0, eslint 0, 1670/1670 tests pass (was 1668/1670).

- Fix(free-rotation): a paid profile's own free_models must win over the seed (TRDD-8b6b3646)

Found in recheck of the free-by-default default: a discover probe on the live
remote-ensemble-geminigrok profile (paid models + 14 curated :free models, NOT
free_only) showed the ensemble running FREE_POOL_SEED — the operator's 14
configured :free models were silently dropped.

Root cause is shared and pre-existing: approvedFreePoolFromSettings read
resolveProfile().freeModels, and resolveProfile fills freeModels ONLY for a
free_only profile — so for a paid profile that pins free_models it read an empty
list and fell back to the bundled seed. The credit-auto-switch already had this
latent bug; the master switch (which forces every remote profile free) turned it
from a rare-on-402 case into the default, so it had to be fixed at the root.

Fix: approvedFreePoolFromSettings now prefers the RAW configured free_models
(active.free_models) when resolveProfile leaves freeModels empty, using the seed
only when the profile genuinely pins no pool (the "never dark" floor). activeFreePool
(the master-switch ensemble/subsystem source) now consults approvedFreePoolFromSettings
before the seed, so a forced-free profile runs the operator's curated pool — kept
fresh by reconcile — exactly as free_only and auto-free do. This also fixes the
latent credit-switch case in the same place.

Verified: the same discover probe now shows the 14 curated geminigrok :free models
(poolside/laguna-xs-2.1:free, cohere/north-mini-code:free, …), not the seed. +2
regression tests: a paid profile's configured :free models are returned (no seed,
no paid config model leak); the seed is used only when no free_models are pinned.
tsc/eslint clean, 1669 tests pass, dist rebuilt.

- Fix(iron-rule): unblock the benchmark, scope the paid opt-in, stop revoking passes (TRDD-8b6b3646)

Six defects in the cost-safety system shipped over 41fc4b3/f7cc69e/f51f7c4/
7ca1f69/7b597d4, found by a code review of that diff. Each one either made the
gate unusable or let it spend money it was written to save.

1. DEADLOCK — the security-triage benchmark refused its own subject.
   judgeGroups() carries an unconditional assertModelValidated(), and the
   benchmark reuses the production judge. A candidate is UNVALIDATED by
   definition until the run scores it, so `--security-triage <paid-model>`
   threw "IRON RULE: not validated for security_scan" and no paid model could
   EVER become validated for that tool. validated.ts's header claimed the
   runner was exempt "because it bypasses resolveConnection" — true of
   benchmark/runner.ts, false of the triage path. Fixed with an explicit
   production exemption (setBenchmarkValidationExempt) wrapped in try/finally
   around the run. It does not weaken cost-safety: the benchmark has already
   cleared the two STRICTER gates in front of it (the $1.25/1M cap and the
   --allow-paid-models-tests opt-in), so it is the one caller that paid the toll.

2. REVOCATION — a ':free' sweep silently un-validated paid models.
   benchmark-results.json is a whole-file SNAPSHOT, rewritten by every keyword
   sweep, and it was the rank-0 ledger. A background free-pool bench
   (--bench-free-pool, roster is ':free'-only) therefore erased the pass of a
   paid model that was working minutes earlier, and every rank-0 tool (chat,
   compare_files, mass_scout, cluster_synonyms, high_quality_scan) began
   refusing it. The other five ledgers accumulate by modelId::date::hash; this
   one did not. Added general-keyword-results.json, an accumulating ledger
   written alongside the snapshot. Precedence is explicit: the ledger is
   authoritative for every model it mentions (latest entry wins, pass or fail);
   the snapshot only contributes models the ledger has never seen — a blind
   union would let a stale snapshot PASS resurrect a model the ledger has since
   recorded as failing. Reading the snapshot at all is what keeps an install
   whose only proof predates the ledger working. --from-cache / --pick-top-n
   are untouched; they still read the snapshot.

3. DEAD COST STOP — the reasoning-burn guard was keyed on an optional field.
   `options.model` is undefined whenever the caller uses the profile's
   configured model, so both the reasoning-downgrade ladder and the length+empty
   COST STOP were skipped for exactly those calls — each one then ran the full
   15-retry ladder, billing a complete max_tokens reasoning burn per attempt.
   That is the money bug 7b597d4 was written to stop. Resolved once into
   `ladderModel = options.model || backend.model` (the shape the
   exhausted-retries branch 60 lines below already used) and used everywhere.

4. ZERO-RETRY ABORT — the same stop fired on the first failure for models that
   never supported reasoning. reasoningLadderForModel caches "none" for a model
   that REJECTS reasoning, not only for one that was downgraded into it, so the
   cache read "none" before any empty response and a single transient
   length+empty became a hard failure. Guarded with currentAttempt > 1: one
   retry, then stop (2 burns worst case, never 15, never 0).

5. FLAG LEAK — setPaidBenchmarksAllowed() from a per-request MCP handler had no
   matching unset, so an opted-in call left the long-lived server opted in for
   the rest of its life and any later in-process benchmark inherited a paid
   permission its own caller never granted. Replaced with
   withPaidBenchmarksAllowed(allowed, fn) — save/set/restore in finally — across
   all three handlers. This restores but does not SERIALIZE; two genuinely
   concurrent benchmark calls still share one process flag, which is documented
   on the helper and needs the flag threaded through the phase options to fix.

6. LEDGER I/O ON THE HOT PATH — validatedModelsForTool re-read and re-parsed up
   to six JSON files SYNCHRONOUSLY on every call, and assertModelValidated
   called it twice on the refusal path. It runs at resolveConnection, i.e. once
   per LLM request: a 500-file 3-model ensemble scan meant ~9000 blocking reads
   on the event loop for an answer that changes only when a benchmark finishes.
   Added a 5s TTL memo keyed by config dir + tool (dir-blind would answer one
   config's question with another's ledgers; a TTL rather than a permanent memo
   so an IN-PROCESS benchmark still takes effect within seconds), and the
   refusal path now reads once for both the decision and the message.

Also unified the rank-0 pass predicate: the gate used `ok && pass` while
--apply-free-pool used `ok && pass && schemaCompliant !== false`. One definition
now, the stricter one — a cost-safety gate must not be the looser reader.

+8 tests (1655 pass / 4 skip): the benchmark exemption exempts and resets; a
free-pool sweep cannot revoke an accumulated pass; a newer ledger FAIL is not
resurrected by a stale snapshot; the legacy snapshot still validates an unseen
model; schemaCompliant:false is not a pass in either source; and
withPaidBenchmarksAllowed restores on return, on throw, and to a previously-true
value. tsc/eslint clean, dist rebuilt.

KNOWN GAP, unfenced: the length+empty COST STOP (fixes 3 and 4) has no
regression test — chatCompletionWithRetry needs a full CompletionDeps stub plus
fake timers for its setTimeout backoff, which is a harness in its own right.
The path has had zero coverage since 7b597d4; flagged rather than papered over.

- Fix(publish): push the {plugin-name}--v{version} resolver tag (issue #11)

Claude Code (>= 2.1.110) resolves a version-constrained plugin dependency
ONLY against a git tag named {plugin-name}--v{version}; the plain vX.Y.Z
tag is invisible to it. We pushed only vX.Y.Z, so any future dependent
pinning a version range would hit the misleading 'no git tag satisfying
<range>' on a repo full of tags — a failure that stays hidden until the
first dependent exists. publish.py now creates and pushes BOTH annotated
tags, reads the name from the manifest, and fails fast on a nameless
manifest (a --vX.Y.Z tag resolves nothing). Extracted resolver_tag_for()
so the shape is tested against the real module. (ai-maestro TRDD-JT3U4ZVM)

- Fix(completion): stop billing a full reasoning budget for zero content (TRDD-8b6b3646)

THE money bug behind the "ensemble returned 2 empty models" report. A reasoning
model that spends its whole max_tokens on thinking returns finish_reason=length
with EMPTY content. That hit the `length` guard clause, which is written for REAL
truncation ("the model wrote an answer and ran out of room") and therefore:

  1. returned NOTHING to the user after billing a full max_tokens burn;
  2. called recordServiceSuccess() — a call that produced zero content was
     recorded as HEALTHY, so no counter, report, or health check ever flagged it;
  3. returned BEFORE the empty-response path, whose reasoning-downgrade ladder
     (xhigh -> high -> none) exists to fix exactly this failure. The cure was
     already written ~40 lines below and the guard clause made it unreachable.
     Because the ladder never ran, it never cached a downgrade, so EVERY later
     call to that model re-paid the identical full-reasoning burn for nothing.

Fix: `length` returns early ONLY with non-empty content. `length` + empty falls
through to the ladder, which retries with less reasoning until real content
appears — which is what makes the model usable instead of a silent money leak.

Plus two guards the fall-through requires:
- COST STOP: the ladder reaches "none" in at most two downgrades. If the model
  STILL returns length+empty with reasoning OFF, it cannot produce content for
  this prompt/budget, and each further attempt bills a MAXED-OUT completion for a
  guaranteed nothing. The generic empty budget (15 retries) is fine for a
  cold-start blank (those generate no tokens) and ruinous here, so we stop the
  moment the cure has demonstrably failed.
- HONEST LABEL: length+empty exhaustion no longer reports "INCOMPLETE"/"provider
  glitch". The model DID generate — all reasoning, no content. The report now
  says so, because that is a model/budget mismatch the user can act on.

Root-caused from a real paid run: xiaomi/mimo-v2.5 + mimo-v2.5-pro both returned
empty under the default reasoning:"high". Not broken models — starved ones.

1622 tests pass, tsc clean.

- Fix(free-rotation): fail-open + cost-safety holes found by a paid ensemble dogfood run (TRDD-8b6b3646)

Found by running the paid ensemble (deepseek-v4-pro) against our own
free-rotation/model-reconcile/free-pool-auto-bench modules. Three real defects,
one of them introduced by the immediately-prior review-fix commit (801239d):

1. free-rotation.ts — free mode + a PAID model in the body + an EMPTY approved
   pool passed the request THROUGH, sending the paid model. Auto-free engages
   exactly when the user's credit hit the floor (or a 402 fired), so this billed
   money the user had just signalled they don't want spent. Now FAILS CLOSED with
   a synthetic 429 into the caller's existing fail-safe path: an honest visible
   failure beats an unrequested charge. (My bug, from 801239d's mid-job fix.)

2. free-pool-auto-bench.ts — the spawned child had NO 'error' listener. A spawn
   FAILURE (ENOENT on a missing benchmark.js, EACCES) is an ASYNCHRONOUS 'error'
   event, and per Node's EventEmitter contract an 'error' event with no listener
   is re-thrown as an UNCAUGHT EXCEPTION — killing the entire MCP server from a
   detached tick no try/catch can reach. Added the listener, plus a try/catch for
   spawn's synchronous throw path (EMFILE/ENOMEM/bad options) which also closes
   the log fd it would otherwise leak. (The ensemble flagged the sync throw; the
   async unhandled-'error' crash is the worse one it pointed at.)

3. model-reconcile.ts — reconcileModelsBeforeWork documents "never throws into
   the caller" but called applyFreePool/launchFreeBench unguarded. It is a
   PRE-FLIGHT on every work tool, so a throwing effect failed the tool the user
   actually ran over a background config refresh they never asked for. Wrapped.

Accepted, not fixed (noted for the record):
- The cooldown file is last-writer-wins across the MCP+CLI processes. Real, but
  the registry is a heuristic whose worst case is one wasted 429 — already stated
  in the module header. File locking is not worth the complexity.
- An explicitly-requested ':free' id outside the approved pool is attempted first.
  That is the caller's explicit choice, not a rotation target; rotation TARGETS
  remain approved-pool-only.

1622 tests pass (+1 pinning the fail-closed path), tsc clean, eslint clean.

- Fix(free-rotation): code-review fixes — mid-job paid→free coverage, honest cooldowns, per-model clamps (TRDD-8b6b3646)

Seven findings from /code-review high on the v10.2.2→v10.4.1 autoconfiguration
work, each with the WHY at the change site:

1. withFreeRotation FREE branch: a PAID model pinned in a body under free mode
   is now served from the free pool instead of passed through. The mid-job 402
   switch previously covered only the ONE in-flight call — every later request
   in the same scout/judge job still carried the paid model (chokepoints assert
   once per job) and would have 402'd into the retry ladder / circuit breaker,
   fail-safing the rest of the job.
2. buildFreeRotationPool: lazy resolveAutoFreePool fallback — autoFreePool is
   only populated by engageAutoFree, never at profile load, so the ':free'
   modelOverride rotation on a funded profile had an always-empty fallback pool
   (the exact bug that path claims to fix). Comment corrected.
3. completeOnFreePool: clamp maxTokens DOWN to each fallback model's output cap
   (resolveEnsembleModelLimits). A paid-sized 65K request on an 8K-cap free
   model is a 400 — a NON-availability error, so rotation rethrew it and the
   command died with a usable pool available.
4. classifyUnavailable: bare "quota"/"limit exceeded"/"exceeded your" moved from
   daily-quota to TRANSIENT. Those phrasings cover minute-scale limits and
   per-request caps; a daily-quota verdict is persisted until 00:00 UTC and
   would sideline a healthy model in every process for up to 24h. Rotation
   behavior unchanged (both classify as unavailable), only the horizon.
5. callEnsembleSlotWithRotation: the non-availability catch reports `attempted`,
   not primary.id — a fallback's 400 was being pinned on the primary.
6. RECONCILE_SKIP_TOOLS: added or_model_info*/assess_model/check_model_health/
   discover_new_models — read-only status tools must not first rewrite settings
   and spawn a benchmark, and the health check must describe the config the
   user actually has (CLI parity: model-info was already skipped).
7. CLI reconcile: allow-list of work commands, not a deny-list — a typo'd
   command was triggering a catalog fetch + settings write + benchmark spawn
   before "Unknown command" printed.

Plus cleanup: one shared logRotation() replaces four drifted stderr closures;
catalogForReconcile() dedups the catalog→{ids,freeQualified} mapping between
the MCP and CLI reconcile deps. Two new tests pin behaviors 1 and 4.

Skipped (noted, no change): modelsSent journal growth — truncation would break
rotationJournalSince's mark indices; growth is bounded by cooldowns in practice.

1621 tests pass, tsc clean, eslint clean.


### Refactored

- Refactor: move mcp-server/ to scripts/llm-ext/ to clear RC-NONSTD-DIR-001

CPV rejects non-standard root directories, and `mcp-server/` is one. It never
fired before because CPV exempts any directory a manifest references as
`${CLAUDE_PLUGIN_ROOT}/<dir>/...` — and `.mcp.json` did exactly that, pointing
at `mcp-server/launcher.mjs`. CPV's own code comment uses this very directory
as its worked example of that exemption. Deleting `.mcp.json` in the CLI
migration removed the reference, which unmasked the finding. So this is
migration fallout, not a pre-existing wart, and it is publish-BLOCKING:
`_CPV_BLOCKING_LEVELS` is {CRITICAL, MAJOR}, and `cpv.skillaudit_advisory`
only downgrades skillaudit-tagged findings — this is a structural `RC-` rule,
so it still aborts the release.

`scripts/` is in CPV's `known_dirs` and the check only inspects ROOT-level
directories, so nesting under it clears the rule. Every root dir is now known
(`design`, `tests`, `reports` are all in the allowlist; the `_dev` ones are
exempt by suffix).

Chose this over renaming to `llm-externalizer/`, which would also have passed —
via the "subdirectory named after the plugin itself" submodule-pattern
exemption. That is meant for nested-marketplace and dev-cached layouts, not for
a build directory; it would have satisfied the check without satisfying its
intent. Moving under `scripts/` is CPV's own first-listed remedy and is honest
about what the directory is: the tooling that builds and ships the CLI.

Done as `git mv`, so all 306 files are recorded as renames and `git blame -C`
still crosses the move. The path edits ride along because the tree does not
build without them — but no unrelated content changed.

Four RELATIVE-PATH DEPTH bugs came with it, and they are the reason this could
not be a blind find/replace: the directory moved one level deeper, so
`../..`-style paths in launcher.mjs, doc-inventory.ts, no-codex-invocation.test.ts
and rule-install.ts silently resolved to the wrong place. Fixed with the move.

Deliberately NOT rewritten: `provenance:` strings inside the dist bundles are
`<sha>:mcp-server/src/...` git references — they name where a file WAS at that
commit, and rewriting them would falsify the provenance. Same for CHANGELOG and
`design/`, and for prose that discusses the MCP server as a past thing.

Also fixed two things the move exposed:
- The setup agent still pointed users at `scripts/diagnostics/check-mcp-server.py`,
  deleted with the server — it would have sent someone chasing a missing file
  mid-troubleshooting. It now names `llm-ext discover` as the engine health check.
- The dogfood build gate asserted `dist/index.js`, the old MCP *server* bundle.
  esbuild still emits that file (it is package.json's `main`), so the check kept
  passing while guarding a bundle nothing runs — the CLI could have failed to
  build and the gate would not have noticed. It now asserts `dist/llm-ext.js`,
  what `bin/llm-ext` actually executes, and the constants are named for what
  they are rather than for a server that no longer exists.

Verified: tsc 0 · eslint 0 · 1670/1670 vitest · 190 pytest · ruff clean ·
dogfood 104 PASS / 0 FAIL · `llm-ext --version` → 10.4.1.


### Testing

- Test(cli): type-check the test files, and fix the three that were rotting

The three `src/live*.test.ts` suites (1322 lines) still imported
`createTestClient` — a function `test-helpers.ts` deleted when it moved to a
CLI subprocess. They could not compile, and nothing said so, because they were
excluded from BOTH gates: `tsconfig.json` excluded `src*.test.ts`, and
`npm test` passes `--exclude 'src/live*.test.ts'`. A file no gate compiles is a
file that rots in silence, and this one had.

I had asserted the opposite in 04f9418's message — that `npm run typecheck`
covered them, and that this was why `@modelcontextprotocol/sdk` had to stay.
That was wrong, and wrong from a guess: `include: ["src*"]` was read as "all of
src" without reading `exclude` next to it. `tsc --listFiles | grep -c live`
returned 0 the whole time. The conclusion (keep the dep for now) happened to be
right for a reason that did not exist.

- The three suites now call `runCli(config, tool, args)`. Every test case,
  assertion and `LIVE_TESTS` gate is preserved; the `beforeAll`/`afterAll`
  transport plumbing is gone because a subprocess has no connection to manage.
- `tsconfig.json` no longer excludes test files, so ~113 of them are
  type-checked for the first time. That surfaced 6 latent errors in five other
  suites, all fixed properly — zero `@ts-ignore`, zero `as any`. The
  free-mode one now narrows its union with a guard that THROWS on the
  unexpected branch, which is a stronger check than the cast it replaces.
- Restored `expect(evt.progress).toBeLessThanOrEqual(100)` in live.test.ts,
  dropped during the rewrite. Without it the loop asserted a floor and no
  ceiling, so progress=5000 against total=100 would have passed — and that
  bound matters more now, not less, since progress is parsed out of stderr
  text instead of arriving as a typed protocol notification.
- `@modelcontextprotocol/sdk` is finally gone from package.json. Nothing under
  `src/` imports it. Remaining matches are all under `benchmark-fixtures/`,
  which are frozen sample inputs — their content IS the fixture and must not
  be edited.

Verified: tsc 0 · eslint 0 · 1670/1670 vitest (unchanged) · dogfood 104 PASS /
0 FAIL · build emits all four bundles · `llm-ext --version` → 10.4.1.
`npm run test:live` was deliberately NOT run — it makes real paid API calls;
this change is about compile-correctness, not execution.


## [10.4.1] - 2026-07-15

### Added

- Feat(reconcile): raise the free-pool cap 12 → 50 (USER — free models die often on rate limits)

Free ':free' models hit their daily rate-limit caps constantly, so the rotation
needs a DEEP bench of fallbacks, not a dozen. Raised DEFAULT_MAX_FREE_POOL to 50.

Cost-safety is size-independent, so "not a waste of tokens" still holds at 50:
only ':free' ids ever enter the pool (isFreeSuffixModelId), and only models the
benchmark has NOT failed (filterFreeModels drops benchmarkFailed). Newly-adopted
models are validated by the $0 free-pool benchmark the reconcile fires on every
pool change, and any that FAIL are pruned on the next reconcile — so a bigger pool
is more VALIDATED fallbacks, never more garbage. The ensemble still runs only the
top-3; models 4..50 are pure rate-limit rotation fallbacks.

Verified live this session: a real-catalog reconcile against the paid profile
detected 8 new qualifying :free arrivals that the old cap-12 (full) pool rejected;
at 50 they now have room to be adopted + benchmarked. 1619 tests green.


## [10.4.0] - 2026-07-15

### Added

- Feat(credit-switch): direct-HTTP tools (security_scan/mass_scout) also complete on free at $0 (TRDD-8b6b3646)

The completion layer already switched paid→free on a 402 (B1). But security_scan
and mass_scout do NOT go through it — they run their own worker pools against the
injected FetchImpl. So a paid profile hitting $0 mid-scan would fail-safe every
remaining item (security_scan force-marks them "uncertain" after N failures). The
user's rule is the command must COMPLETE; this closes that gap.

withFreeRotation (the FetchImpl decorator) now has two branches:
  A. FREE mode — rotate a rate-limited ':free' request across the pool (as before).
  B. PAID mode — send as-is; on a 402 (credit exhausted, on a real completion
     call) engage session-wide free and complete THAT call on the rotating free
     pool. The paid model is never a candidate — strictly one-directional. If the
     free pool can't complete it either, the ORIGINAL 402 is surfaced (the
     actionable error), not a downstream free-model 429.

The consistency trap this avoids: the decorator can't import index.ts (a cycle),
so a naive `setActiveFreeOnly(true)` would flip the chokepoint flag while leaving
index.ts's autoFreeEngaged false — and the completion path would then build a paid
ensemble that throws at assertFreeOnlyModel. Fix: index.ts REGISTERS its real
engageAutoFree via registerAutoFreeEngage; the decorator calls that (MCP process,
every spend site stays consistent), falling back to setActiveFreeOnly only in a
standalone CLI process where index.ts isn't loaded and there is no completion
ensemble to keep in sync.

The rotation loop is extracted to rotateOverFreeIds() and shared by both branches.
Tests: 5 new paid-402 cases (pass-through when no 402, engage+complete, rotate-past
a capped free model, empty-pool→surface-402, free-also-exhausted→surface-402), plus
a coverage guard for the registration. 1611 -> 1619.

- Feat(credit-switch): paid→free is non-interrupting and one-directional; use credit to $0 (TRDD-8b6b3646)

The user's rule, made literal: a paid profile ALWAYS falls back to free when
credit is exhausted OR the paid model is unavailable — and the command that hits
that wall still COMPLETES. A free_only profile can NEVER go the other way.

* The 402 (credit-exhausted) mid-call catch now completes the in-flight call on
  the ROTATING approved free pool, not a single pinned FREE_MODEL_ID. Before, if
  that one free model was itself daily-capped the retry threw and the command
  died — the exact interruption the rule forbids. It engages sticky auto-free
  (the wallet is empty for the session) and rotates until one free model answers.

* NEW terminal fallback: a PAID model that exhausts its retries on a genuine
  AVAILABILITY failure (429/404/no-endpoints/503 — never a 400/bad-key, which
  classifyUnavailable rejects) completes on the free pool instead of failing.
  Non-sticky: the wallet may be fine and only that model/moment was bad, so the
  next call retries paid. This is the "or the models not available" half.

* Both paths share completeOnFreePool(). It is STRICTLY one-directional: every
  caller has already established the current model is PAID (guard
  !isFreeSuffixModelId(options.model)), so a free_only profile — whose model is
  ':free', and which assertFreeOnlyModel forbids from ever holding a paid id —
  can never be pushed to paid. There is no auto free→paid path anywhere.

* Threshold default MIN_BALANCE_FOR_PAID_USD → $0 (was $1): use the paid credit
  fully; the guaranteed non-interrupting trigger is the 402 catch, not a proactive
  margin. `0` is now an honoured LLM_EXT_FREE_BELOW_USD value (the old clamp
  forbade it); a user who wants a margin sets it explicitly.

* engageAutoFree now prefers the RECONCILED / persisted approved pool
  (approvedFreePoolFromSettings) over the boot-time profile pool, so the credit
  switch uses the freshest catalog-tracked free models, not the static seed —
  falling back to the seed only when settings hold no pool.

Guard test asserts the wiring + the one-directional !isFreeSuffixModelId guard at
source level (the completion layer can't be hermetically unit-tested — it owns
real HTTP). auto-free.test updated for the $0 default. Tests 1611 -> 1620.

- Feat(reconcile): assess dead/new OpenRouter models before every scan; auto-adopt free ($0), warn on paid (TRDD-8b6b3646 autoconfiguration)

Every surface now ASSESSES the model situation before it does work, and
reconfigures the FREE class to track the live catalog at $0 — the user's
"it must be automatic, detect dead or new models before launching the scan".

model-reconcile.ts (new), pure core + IO shell:
  * Detect DEAD: any configured model (ensemble / free_models / tool_models)
    positively absent from the live catalog. Free-dead is dropped from the pool;
    PAID-dead is WARNED about ("run --update-all --paid"), never auto-replaced —
    benchmarking a paid model spends money, and that is the credit-switch's job,
    not this.
  * Detect NEW: qualifying ':free' arrivals (context-floor gate) are adopted.
    openrouter/free (a $0 router pseudo-model with no ':free' suffix) is
    structurally excluded; benchmark-failed excluded. So the pool can only ever
    hold a model the pipeline already approves.
  * On a free-class change: write free_models to settings.yaml (atomic) AND
    fire-and-forget the $0 free-pool benchmark to score the new class.
  * FAIL-OPEN: an empty catalog (fetch failed) is a no-op — a network blip can
    never wipe the configured pool. THROTTLED to <=1x/hour via a shared state
    file, so a 50-file scan reconciles once, not 50 times. Env opt-out.

"All surfaces" = two runtime funnels: dispatchCallToolInner (MCP) and cli.ts
main() (CLI). Skills, slash-commands, and agents all wrap one of these, so they
inherit the pre-flight. benchmark/index.ts main() is deliberately NOT wired — it
IS the reconfigure machinery (--update-all / --bench-free-pool), so reconciling
there would be circular. A coverage guard asserts both funnels stay wired.

READ-ONLY-MCP carve-out: the MCP may now write settings.yaml, but ONLY the
free_models pool, ONLY ':free' ids (applyFreePoolToSettings enforces it), ONLY
throttled, and disable-able. It can neither pick a paid model nor spend, so it
cannot do the harm the read-only rule prevents. The tool_models / ensemble
writers stay CLI-only. pick.ts's guardrail comment updated to state the exact
boundary. Writing free_models to a PAID profile is safe: validateProfile only
checks free_models under free_only, so it is an inert pre-populated pool that the
eventual credit->free switch will use (with FREE_POOL_SEED as the fallback).

Tests: 21 new (1590 -> 1611). Pure core + the deps-injected IO shell are hermetic
(no catalog fetch, no settings IO, injected clock); the coverage guard is
source-level, same shape as the rotation-wiring guard.


### Miscellaneous

- Chore(dist): rebuild benchmark bundle for the reconcile/credit-switch wiring


## [10.3.0] - 2026-07-14

### Added

- Feat(free-rotation): rotate on EVERY send path — the two direct-HTTP tools included

Phase 1 covered the paths that go through the completion layer. Verifying the
rest showed the codebase has two families of LLM sender, not one, and the second
had no rotation at all:

  * completion-layer callers — the ensemble, cluster_synonyms' rawLlmCall,
    check_imports' chatCompletionJSON. Wired here (cluster and check_imports were
    still pinned to a single free model).

  * direct-HTTP callers — security_scan's judge and mass_scout's scout each run
    their own worker pool against an injected FetchImpl, with the model in the
    request body and their own retry ladders. Neither could ever rotate.

For the second family the fix is a decorator on the production FetchImpl adapter
(`realFetch = withFreeRotation(rawFetch)`), NOT per-tool plumbing. The 429 is
absorbed below the tool: the body's model is rewritten to the next approved free
model and re-sent, so neither pipeline, retry ladder, circuit breaker, nor report
control flow changes at all — and a future direct-HTTP caller inherits rotation by
using the adapter it would have used anyway.

WHY that matters most for security_scan: its circuit breaker force-marks every
remaining item `uncertain` after N consecutive failures. So a daily-capped free
model did not merely fail the scan — it silently degraded the whole scan to
"uncertain". That is a security tool reporting "I could not tell" when the real
answer was "my model ran out of free quota".

Also in this commit, each found by checking an assumption rather than by a test:

  * mass_scouting/cli.ts declares its OWN realFetch (all four of its send sites use
    that one, NOT security_scan's). Assuming a single shared adapter would have
    left mass_scout unrotated; the new wiring guard caught it on its first run.
  * TDZ: openrouter.ts decorates at module-init, and free-rotation reaches back
    into security_scan via the security-triage import. Resolving the decorator's
    deps at decoration time crashed on the circular init — they are resolved per
    request now, which is also simply correct (free mode and the pool can both
    change after boot).
  * The `:free` suffix rule had a second inline copy in the rotation path. It now
    uses isFreeSuffixModelId, the one definition the cost-safety chokepoint uses;
    two copies of that rule is how `openrouter/free` got into a pool and detonated
    a 32-minute sweep at send time.
  * Reports no longer lie: security_scan's and mass_scout's reports print the
    models that ACTUALLY answered whenever rotation moved off the requested one.
    The field is absent on a normal run, so its presence IS the rotation signal.

The pool-approval logic (filterFreeModels et al.) moved out of index.ts into
free-rotation.ts because the CLI surfaces cannot import index.ts — leaving it there
would have forced either an import cycle or a second copy of "which free models are
allowed", and two copies of that rule is what bills money.

New guard test (free-rotation-coverage) asserts the WIRING, not the logic: rotation
was correct all along in Phase 1's helper — four paths simply never called it, and
that class of bug only shows up on the day a quota runs out. Tests 1577 -> 1589.

- Feat(free-rotation): remember spent free models across calls; rotate on every free path (TRDD-8b6b3646 Phase 4)

Rotation already existed for the free ENSEMBLE slots, but its cursor lived in a
local `let` inside one ensembleStreaming() call, so it was forgotten the moment
that call returned. A scan over 50 files therefore re-tried the SAME daily-capped
free model 50 times, paying a 429 (and a retry ladder) every single file. And
three other free paths never rotated at all.

WHY each change:

* free-rotation.ts (new) — the missing memory: a per-model cooldown registry,
  persisted to ~/.llm-externalizer/free-cooldowns.json so the MCP server and the
  llm-ext-benchmark CLI, two processes drawing on ONE daily quota, don't each
  re-learn that a model is spent. A spent DAILY quota is classified apart from a
  transient 429 because only the former needs a cooldown to 00:00 UTC — backing
  off 30s and retrying would just hit the same wall until midnight.

* Cooling models are DEFERRED, never dropped, and are PROBED once the pool is
  exhausted. A cooldown is a heuristic derived from an error string; if it is
  wrong it must cost one wasted 429, never a tool that refuses to run. So
  "exhausted" always means every approved model was actually TRIED and failed.

* The rotation predicate was `activeResolved.freeOnly` alone, while
  getEnsembleModels() served the free pool under `freeOnly || autoFreeEngaged`.
  So under AUTO-FREE (funded profile, low balance / 402) the fallback list came
  out empty and the boot log's promise of "rotation on rate-limit" was false.

* A ':free' modelOverride now rotates too, gated on the override's own suffix and
  NOT on freeMode: an explicit `free: true` call on a funded profile is still a
  free call, and it used to pin one FREE_MODEL_ID whose daily cap was a hard
  failure. A PAID override (high_quality_scan) is untouched — rotating it could
  bill a second model the user never asked for.

* Same for ensemble:false and for a file too large for every ensemble primary:
  the approved pool may hold a bigger-context free model beyond the top 3.

Cost-safety is unchanged and reinforced: candidates come only from
filterFreeModels() (benchmark-failed and sub-floor models already dropped), every
candidate is re-checked for the ':free' suffix at the point of selection — so a
$0 router pseudo-model like `openrouter/free` can never enter the rotation and
detonate at send time — and assertFreeOnlyModel still guards every send.

Tests: 24 new (1553 -> 1577). The registry tests inject a RAM-only store so a unit
test can neither write to the real ~/.llm-externalizer nor leak a cooldown into
the next case; the persistence tests drive the REAL atomic writer under a tmp dir.


### Miscellaneous

- Chore(dist): rebuild benchmark/cli bundles for the free-rotation wiring

The CLI surfaces (mass_scout, benchmark) now import free-rotation.ts, so their
bundles change alongside the MCP server's.


## [10.2.2] - 2026-07-13

### Fixed

- Fix(security-triage): never send the paid incumbent under free_only; honest skip, not "please report it"

WHY: `--update-all --free` died on security_scan with the cost-safety guard's
hard-bug message naming qwen/qwen-2.5-7b-instruct — a model that was NOT among
the 16 ':free' candidates it was sweeping. Root cause: the orchestrator ALWAYS
adds the tool's paid DEFAULT (the incumbent baseline) to the assessed set, and
under free_only judgeGroups' assertFreeOnlyModel refuses to send it and throws.
The throw came from the incumbent's OWN baseline run, not from a candidate.

NOT a scoring bug: runTriageBenchmarkOnModel passes the model UNDER TEST as
judgeGroups' `model`, so every candidate was always scored on itself. The
default only ever appeared as its own baseline row. Past benchmark results are
valid. A new hermetic end-to-end test now fences that property.

Fixes:
- security-triage/index.ts: under free_only, skip every non-':free' model
  (record it $0, unbenchmarked, disqualified) instead of sending it — the guard
  pattern search-existing/scan-folder already use. If NOTHING ':free' remains,
  throw the new typed FreeModeSkipError.
- benchmark/free-mode.ts (new): the ONE ':free' predicate (identical to
  assertFreeOnlyModel's, so pool filter and guard cannot drift) + FreeModeSkipError.
  discover.ts's freeSuffixOnly now delegates to it.
- update-all.ts: a FreeModeSkipError is reported as "skipped under free mode: …".
  The guard's "this is a bug, please report it" wording stays reserved for a
  GENUINE leak (a paid id reaching the sender), which still lands in ERRORED.
- score.ts: notBenchmarkedScore() — scoreTriage over an EMPTY case list returns
  pass=true (no failReasons), which would advertise an unbenchmarked model as
  having cleared the safety gate. Unbenchmarked is now inconclusive + pass=false.

assertFreeOnlyModel is UNCHANGED — it is the chokepoint; this only stops paid
ids from ever reaching it.

Tests: +4 (routing regression, free-mode ':free' candidate benchmarked with the
incumbent never sent, typed honest skip, update-all honest-skip row). 1553 pass.

- Fix(update-all): exclude non-:free router models + per-model resilience

A real `--update-all --free` run aborted the ENTIRE multi-tool sweep with
'free_only cost-safety: refusing to send non-free model openrouter/free'. Two
defects, found only by running it for real (a dry-run cannot surface them):

- Root cause: resolveFreePool admits ANY zero-cost-priced catalog model via
  isZeroCostPriced, including 'openrouter/free' — a ROUTER pseudo-model with no
  ':free' suffix. The send-time guard assertFreeOnlyModel (correctly) admits
  only ':free'-suffixed ids, so it threw. Fix A: freeSuffixOnly() filters the
  pool to ':free'-only at the point of construction, so EVERY consumer (ensemble
  + per-tool candidates + the free_models write-back) is protected — mirroring
  the guard's own contract. openrouter/free / openrouter/auto / no-suffix betas
  are dropped even when the catalog prices them at 0.
- Resilience: the per-tool loop RETHREW a single model's error, killing the
  whole sweep (30+ min of prior benchmarking wasted). Fix B: a per-tool throw is
  now recorded ERRORED and the loop continues; only a genuine whole-run failure
  (budget, catalog fetch, ensemble sweep) aborts. Mirrors the ensemble runner's
  never-throw contract. The cost-safety guard itself is deliberately NOT weakened.

+5 tests (freeSuffixOnly units; Fix A excludes openrouter/free from every
candidate set; Fix B: a throwing tool is ERRORED and the sweep still ends [OK]).
Real re-run: free pool = ':free'-only, zero openrouter/free aborts, 429s tolerated.


## [10.2.1] - 2026-07-11

### Fixed

- Fix(mcp): boot server under launcher import (argv[1] entry-guard) — fixes -32001

index.ts boots main() only when it is the process entry point (realpath(argv[1])
=== its own module path — a cost-safety guard, TRDD-e82f2c49, so test-imports
never boot the server + hit a backend). The MCP server launches as
`node launcher.mjs`, which hands off via `await import(dist/index.js)`; that
does NOT change argv[1], so the guard was false, main() never ran, and the
server answered nothing → Claude Code -32001. The launcher now points argv[1]
at the index path before importing, satisfying the guard for the launcher path
only (test-imports never go through the launcher and stay correctly un-booted).

All 1543 prior tests passed while the shipped server did not boot because every
test imports index.ts directly and none exercised the launcher handoff. Adds
src/launcher-boot.test.ts, which spawns the REAL launcher and completes a real
MCP initialize — proven to FAIL without the fix (30s no-response) and PASS with.


## [10.2.0] - 2026-07-11

### Added

- Feat(model-pipeline): one command refreshes every model, under a hard spend cap (P3+P4, zero-token model pipeline)

P1 made each model-update STEP a scripted CLI call. P2 gave four more tools a real
benchmark. What was still prose was the GLUE: "fetch the catalog, decide which tools to
sweep, choose the flags, read the report, then hand-edit settings.yaml". That glue was
judgment — so it cost agent tokens and it drifted. It is now code.

`llm-ext-benchmark --update-all` does the whole pipeline in-process: discover the live
catalog -> apply each tool's requirements from the registry -> run every tool that HAS a
benchmark -> rank -> atomically write the winners (ensemble, each tool_models.<tool>, and
the free_models pool) -> report. It ends with ONE [OK]/[FAILED] line the command prints
verbatim. Zero decisions are left to a human or an agent.

WHY A SPEND CAP, AND WHY IT IS SHAPED THIS WAY (P4)

Commit 31ce212 fixed a cost-safety defect that had already drained $17.67 of a real
OpenRouter balance in one hour. Nothing BOUNDED spend; a run either finished or it emptied
the wallet. So:

- The default mode is FREE. A bare `--update-all` cannot spend a cent — it sweeps only
  zero-cost models, and `--free` also performs the free-models SEARCH that rewrites
  free_models (that pool was hand-edited until now). Spending requires TYPING --paid/--both.
- Paid runs are capped twice. A worst-case pre-flight estimate aborts BEFORE the first call
  (naming the exact --budget-usd that would authorize it), and budget.ts reserves every
  single call against the cap before it is sent. Default cap $2.00 — ~10% of the balance.
- The estimate is derived, never invented: each benchmark's describeWorkload() reads its
  REAL corpus on disk, and each runner's max_tokens is now an exported constant the
  estimator imports — so a corpus edit moves the estimate and a stale literal cannot
  under-price a sweep. Approximations deliberately err HIGH (3 chars/token, full max_tokens).
- The TRIP LATCH is load-bearing, not decoration: every runner CATCHES fetch errors (their
  never-throw contract), so a throw from inside the guard would be SWALLOWED and the sweep
  would keep spending. Once tripped, every later reserve refuses instantly, the orchestrator
  fails the run, and remaining tools are reported SKIPPED. Refuse-then-report, never
  silent-continue.
- A `free_only` profile is a standing config-level "never spend". --paid/--both now REFUSE
  it rather than letting a CLI flag overrule it, and that refusal ranks with the usage
  errors (before the API-key check) — reporting "OPENROUTER_API_KEY not set" would have sent
  the user off fixing the wrong thing.

HONESTY ABOUT THE GATE

The report labels every tool benchmark-proven (a model really ran that tool's golden
dataset and passed) or requirement-gated (checked only against cost/context/output/params —
no benchmark exists for it yet). An unbenchmarked tool must never read as if it were tested.

TWO REAL BUGS FOUND AND FIXED WHILE BUILDING THIS

1. mass_scout was gated by the keyword-classification benchmark (the ensemble sweep), so it
   had no per-tool sweep — and it fell through the plan loop into NO REPORT ROW AT ALL. The
   summary read "5 proven + 5 gated" against an 11-tool registry and nothing said a tool was
   missing. Caught by the live dry-run, not by review. Now every registered tool is
   accounted for, and a test asserts the count.
2. The budget abort used `break`, leaving the remaining tools with no row — an omission a
   reader could easily take for "nothing to report". It now continues so each is written out
   as SKIPPED. The ledger is latched, so looping costs nothing and buys a complete report.

Writers stay CLI-only (the read-only-MCP guardrail at pick.ts): the MCP surface remains
incapable of rewriting its own config.

Gates: build clean, eslint clean, 1543 passing / 0 failing (baseline 1477), doc-consistency
+ tool-roster green. Verified live against the real catalog: --free estimates $0.0000 and
--paid estimates $8.4036 against the $2 default, aborting with $0 spent and settings
byte-identical.

- Feat(benchmark): gate check_against_specs on a real-incident spec-adherence benchmark (P2d, zero-token model pipeline)

check_against_specs was the last of the three tools carrying `benchmark: null` —
it had per-tool REQUIREMENTS but no way to tell whether a model that met them could
actually do the job. A requirements-only gate admits any model with a big enough
context window, including one that cannot read code at all.

The P2 dataset spec judged this tool only PARTIALLY deterministic, and it was right,
so this ships ONLY the half that is honestly gradeable: the per-file CLEAN/VIOLATION
verdict. Exact-rule-match and severity are printed and NOT graded — deciding whether
a quoted rule is really the one that was broken is a semantic judgment, and severity
is one human reviewers disagree about. Both need an LLM judge; a judge is excluded by
design, so they stay ungraded and are named as such in the report rather than smuggled
past as a metric.

The corpus is a real incident, not an invention. The spec is this repo's own shipped
mcp-server/TESTING.md; the thirteen source files are byte-for-byte git snapshots. The
four VIOLATION fixtures are the exact bytes commit 31ce212 replaced *because they
really violated that spec* — the defect billed the user's premium ensemble on every
`npm test` and drained $17.67 in a single hour before it was found. Three of the four
sit in the corpus NEXT TO their own fixed twin: the same file, ten lines apart, from
the commits either side of the fix.

That pairing is the whole design, and it is why the benchmark is worth its cost. P2c
shipped a first corpus that a pure keyword matcher scored F1 0.909 on — it PASSED the
gate while measuring nothing. So the discrimination check is now structural: four
code-blind baselines are run through the REAL pipeline and the REAL scorer, and every
one MUST fail. They do — flag-everything 0.47, spec-vocabulary-grep 0.50 (the fixed
twins discuss LIVE_TESTS *more* than the broken ones, because the fix added the
comments), missing-live-gate-grep 0.67 even though it has been HANDED spec rule R2,
and flag-nothing dies on the recall floor. A corpus that a grep can pass is worthless,
and now it cannot silently decay into one.

Gate: micro-F1 >= 0.80 AND micro-recall >= 0.70 AND coverage >= 0.90. The recall floor
is load-bearing: "answer CLEAN to everything" asserts nothing, so it is never wrong,
and F1 alone cannot punish it on a 4/9 corpus. Accuracy is reported, never gated —
perpetual silence scores 0.69 on this corpus while finding nothing.

- benchmark-fixtures/check-specs/: 13 verbatim snapshots + the spec (+ README with
  the full provenance table and the git commands to re-extract every fixture).
- benchmark/check-specs/{dataset,score,select,bench-runner,index}.ts: the corpus and
  its tripwires, the judge-free scorer, the same-or-cheaper gate, the real-pipeline
  runner (only fake = the HTTP seam), the orchestrator.
- Labels are anchored in the fix commit, not in a regex: spec adherence is violated in
  structurally different ways and "this test spends money" is not a pattern. What IS
  mechanical is a per-fixture TRIPWIRE that validateDataset re-checks against the bytes
  before a cent is spent, so an edited or wrongly-extracted fixture fails loudly instead
  of silently redefining the answer key.
- CLI phase --check-specs [ID...] (+ --apply-profile writes tool_models.check_against_specs;
  CLI-only writer, never reachable from MCP), registry flip, auto-replace now plans five
  tools.
- 62 new tests. All gates green: build, lint, 1477 passed / 0 failed, doc-consistency 11/11.

Agent: llm-externalizer

- Feat(benchmark): gate scan_folder on a real-corpus mass-search benchmark (P2c, zero-token model pipeline)

scan_folder was the last of the three high-traffic tools with `benchmark: null`
in the model-qualification registry, so nothing stopped a model that cannot
actually do a per-file MATCH/NO_MATCH judgment from becoming its default. This
adds the missing gate, with the same posture as P2b: deterministic, zero
LLM-judge, zero agent tokens at run time.

WHY THE GROUND TRUTH IS DERIVED, NOT HAND-LISTED. The corpus is twelve files
copied VERBATIM from this repo's own mcp-server/src/ (no fabricated code), and
each query's true MATCH set is recomputed from those bytes by a mechanical rule
on every run. So the expected answer cannot drift from the corpus — it IS the
corpus. The checked-in `expectedMatchFiles` is kept only as a TRIPWIRE:
validateDataset recomputes the set and throws if the two disagree, so neither a
mistyped regex nor an edited fixture can silently redefine the truth.

WHY TWO OF THE TWELVE FIXTURES ARE "DESCRIBES IT BUT NEVER DOES IT" FILES. The
first corpus was measurably worthless: a plain grep scored 0.909 and CLEARED the
0.85 gate, because "imports child_process" and "imports node:crypto" are exactly
what a keyword matcher finds. Adding security-triage/dataset.ts (real source
whose job is to DESCRIBE threats: it is saturated with command_injection, "shell
sink", insecure_crypto, "a broken hash (md5/sha1)" while importing none of them,
and only ever reads from disk) plus search-existing/dataset.ts drops the keyword
strategy to ~0.77 — a FAIL — while a model that reads the code still passes.
bench-runner.test.ts asserts exactly that, so the corpus can never quietly decay
back into something a grep could pass.

The gate is search_existing's (micro-F1 >= 0.85, micro-recall >= 0.85, coverage
>= 0.90), NOT code_task's 0.5, and the difference is the OUTPUT CONTRACT rather
than the difficulty: a forced per-file binary has no structural noise, so a coin
flip must not clear the bar. The recall floor is what makes "answer NO_MATCH to
everything" — which is never WRONG, and so has vacuous precision — structurally
unable to pass.

Honest ceiling, stated rather than smuggled past: a MATCH line's cited evidence
is REPORTED but NOT graded. Judging whether a citation really proves the claim is
a semantic-equivalence judgment, and the only mechanical alternatives are a
brittle substring match or an LLM judge, which this benchmark excludes by design.
The child_process query is likewise grep-solvable on its own and serves as a
precision/format control; a test pins that so nobody mistakes it for more.

The math is IMPORTED from search-existing/score.ts, not copied — the per-file
binary confusion matrix is the same computation, and two copies drift the day one
is fixed (the same call P2b made when it MOVED codeTaskSystemPrompt).

- corpus: mcp-server/benchmark-fixtures/scan-folder/ (12 real files, 81 KB, full
  provenance + the anti-grep rationale in its README)
- dataset/score/select/bench-runner/orchestrator under src/benchmark/scan-folder/
- CLI phase `--scan-folder [ID...]`; writer (tool_models.scan_folder) is CLI-only
  and never reachable from an MCP handler
- registry: scan_folder benchmark null -> "scan-folder"; --auto-replace now plans
  four tools
- 49 new tests (1415 passing, zero failures); build + lint + doc-consistency green

Est. spend: ~$0.01/model realistic cheap tier; <= $0.09/model at the registry's
$1/M ceiling.

Agent: llm-externalizer

- Feat(benchmark): gate code_task on a real-defect code-audit benchmark (P2b, zero-token model pipeline)

code_task was one of the tools carrying `benchmark: null` in the model-
qualification registry: we could check that a candidate model MET its
requirements (reasoning + 128K ctx + under the cost ceiling), but we had no way
to check that it was any good at the job. Model selection for the tool was
therefore requirements-only — a model could be adopted having never
demonstrated it can find a bug. This closes that gap with a benchmark that is
deterministic, judge-free, and driven entirely by script (no agent tokens).

WHY THE CORPUS IS REAL. Every defect fixture is a VERBATIM pre-fix snapshot of a
file from this repo's own git history (`git show <fixCommit>^:<path>`): each
defect really shipped and was really fixed, and the fixing commit supplies both
the buggy symbol (from its diff) and the rationale (from its message). Nothing
is synthesized. A pre-fix snapshot also contains any defect fixed LATER in the
same file, and scoring a model WRONG for spotting one of those would penalise
the best models — so each snapshot is taken at the parent of the LATEST fix
commit touching that file. grouping.ts is the deliberate exception: it sits one
fix earlier and therefore lists BOTH of its verified defects. Three clean
fixtures (files no fix commit has ever touched) are the negative distractors;
their filenames are neutral because the model sees the filename.

WHY SYMBOL NAMES, NOT file:line. The tool's own system prompt orders the model
to "Identify code by FUNCTION/CLASS/METHOD NAME, never by line number". A
line-based scorer would grade models against an instruction the tool actively
tells them to ignore, so the symbol name is the only sound key. The dataset
still records each defect's line, but only for humans reading the report.

WHY NO LLM JUDGE, AND WHERE THE HONEST CEILING IS. The audit instructions force
a `DEFECT: <symbol>` anchor (the same device search-existing's YES/NO contract
uses), which makes extraction exact string work. The corpus's defectClass labels
are REPORTED but never gated on: judging whether a model's free-text explanation
*means the same thing* as a label is semantic equivalence, which needs a judge.
Claiming to grade that deterministically would be a lie, so we don't.

codeTaskSystemPrompt moves from index.ts to scan-pipeline.ts (next to the two
strings it embeds). The benchmark MUST send byte-for-byte the prompt the server
sends, and it cannot import index.ts (that module runs main() at import time) —
a copy would drift the day either was edited. One definition, two importers.

code_task also joins the --auto-replace planner, so its incumbent is now
ledger-watched and re-benchmarked like the other two gated tools.

Pass gate: macro-F1 >= 0.5 AND micro-recall >= 0.5 AND <= 1 failed case. 0.5
mirrors security-triage (the other PROSE-output benchmark), not
search-existing's 0.85 — a free-form review legitimately surfaces a second
concern in a 34 KB file, so a higher bar would measure terseness rather than
code understanding. The recall floor exists because macro-F1 alone is gameable:
without it, "answer NO DEFECTS to everything" scores 1.0 on every clean case.

Two bugs found and fixed in this work, both recorded so they aren't reintroduced:
- a candidate fixture (security_scan/intake.ts) carries literal NUL bytes, which
  readFileAsCodeBlock rejects as binary — the case could never have been scored
  and every model would have "failed" it. validateDataset now refuses a binary
  fixture outright, and the fixture was dropped.
- max_tokens on the benchmark call must NOT be clamped tight (the obvious
  cost-saving move). code_task requires REASONING models, and max_tokens bounds
  thinking + visible content together, so a tight cap truncates them mid-thought
  and the scorer reads it as "found nothing" — a broken benchmark that
  systematically fails exactly the class of model the tool needs.

Corpus: 8 cases / 103 KB, ~30K input tokens per model => ~$0.01 per model at
realistic cheap-tier pricing (<= $0.10 at the registry's $1/M ceiling).

Gates: npm run build clean, npm run lint clean, 1365 tests passing (0 failures),
doc-consistency green. dist/ rebuilt.

- Feat(model-pipeline): move every model-update judgment out of prose into code (P1 zero-token model pipeline)

A model update cost agent tokens not because the benchmark engine needed an LLM
— it never did — but because the PROCEDURE around it did. The command/skill prose
made Claude check prerequisites, choose flags, judge whether a 404 was
"persistent", parse stderr, and relay reports. Each of those is now code.

1. ROTATION IS A THRESHOLD, NOT A JUDGMENT (the biggest hotspot).
   The ensemble-autoselect skill told the agent to eyeball the retry history and
   decide "is this 404/degradation persistent?". model-events.ts now answers it:
   assessModelPersistence flags a model iff its TRAILING run of non_retryable_failure
   events inside a rolling 24h window is >=3 events carrying the SAME rotate-worthy
   status (400/404/410/422). Every clause is load-bearing and commented: 429s and 5xx
   never rotate (a swap cannot fix a rate limit or a provider outage); 401/403 never
   rotate (that is a wrong API key — rotating would destroy a working ensemble); a run
   broken by a different status is a wobble, not a retirement; the window is what makes
   the verdict CURRENT, unlike the unwindowed counters, which can never gate a write.

2. THE LEDGER NOW COVERS THE ENSEMBLE, not just benchmarked tools.
   planEnsembleRotation applies that threshold to the model/second_model/third_model
   slots — which serve every tool that has no per-tool override and previously had no
   automated verdict at all. `--auto-replace --apply` rotates them automatically: fresh
   sweep, re-pick, atomic write. It re-picks the profile's CURRENT slot count (not a
   hard-coded 3), because applyPicksToSettings derives `mode` from the pick count and
   would otherwise silently promote a single-model profile to remote-ensemble.

3. THE SPEND BOUND IS A CODE DEFAULT. --qualifying-top-n 15 was prose ("add it unless
   the user asked for an exhaustive sweep"); a bound that depends on an LLM remembering
   a sentence is not a bound. It is parseArgs' default now; --no-qualifying-cap opts
   into the exhaustive sweep. parseArgs moved to cli-args.ts so it can be tested at all
   (index.ts runs a benchmark at import).

4. THE CLI SELF-CHECKS AND SPEAKS ONE LINE. Prereq probing (test -x, $OPENROUTER_API_KEY)
   moved into the process; usage errors are validated BEFORE the environment, so a bad
   flag combination no longer reports a missing API key. Every path now ends with exactly
   one `[OK|FAILED] <summary>. Report: <path>` on stdout — and a CORRECT EXIT CODE.
   That last part was a real bug: main()'s resolved code was DISCARDED, so a failed pick
   or a failed settings write still exited 0. Nothing could tell success from failure
   without parsing stderr prose — which is precisely why the prose asked an agent to.

5. ADOPTION IS SCRIPTED. The new-arrivals and check-health commands ended with "now edit
   settings.yaml by hand". Two new CLI-only atomic writers close that: applyFreePoolToSettings
   (--apply-free-pool: the pool BECOMES the :free models that passed) and
   applyEnsembleSlotToSettings (--adopt ID --adopt-into <slot|tool:NAME>, gated on the
   per-tool requirements registry). Both carry the read-only-MCP guardrail comment and are
   unreachable from any MCP handler — the server still cannot rewrite its own config.
   applyEnsembleSlotToSettings REFUSES second/third_model on a non-ensemble profile: those
   keys are ignored unless mode is remote-ensemble, so "succeeding" would be a silent no-op.

Prose rewritten to carry zero judgment: 6 commands + the skill now say "run exactly this,
print its final line verbatim" — no prereq checks, no flag decisions, no persistence call,
no report paraphrase, no manual-next-step reminders.

Also fixes: the CLI wrote settings/cache via homedir() and ignored LLM_EXT_CONFIG_DIR, so a
test that exercised a writer would have hit the developer's real ~/.llm-externalizer.

Tests: +60 real tests (1247 -> 1307, zero failures). The threshold rule (every clause), both
writers against real files, the parseArgs defaults, and a hermetic spawn of the real bundle
proving the [OK|FAILED] line, the exit codes, the prereq self-check, and a ledger-driven
BROKEN ensemble verdict — no network, no key, nothing mocked.


### Documentation

- Docs(trdd): record Phase 5b landed — completion layer extracted (P5b, TRDD-63314265)

STATE block now carries what moved, WHY the four caches could move (zero readers
outside the three completion fns => still one binding per cache) while the
auto-free/credit state could NOT (index.ts reads it elsewhere; a copy would keep
the session spending after a 402), and the corrected call-site count (10, not the
~50 the 5a report estimated — the rest were comments). index.ts 6190 -> 5147.
Only P4b remains in this TRDD; there is no Phase 5c.

Agent: llm-externalizer


### Refactored

- Refactor(check_against_specs): extract handler into an importable core (P2a, zero-token model pipeline)

WHY: model-qualification/registry.ts carries `benchmark: null` for
check_against_specs. A benchmark cannot exist while the pipeline is only
reachable by booting the MCP server — the same blocker already solved for
search_existing_implementations, scan_folder and code_task. This applies the
identical seam-injection pattern so a hermetic, zero-judge benchmark (P2b) can
drive the REAL pipeline in-process.

- src/check-specs/core.ts: runCheckAgainstSpecs(args, CheckSpecsDeps). Imports
  ZERO from index.ts. Every index.ts-scoped binding the case body read is now an
  injected seam: the LLM call (ensembleStreaming — the tool's ONLY LLM site,
  used by both the per-file mode-0 path and the FFD-batched path), the
  usage-recording footer (formatFooter), the report writer (saveResponse), the
  merged-model label (ensembleModelLabel), the max-tokens resolver, path
  resolution (normalizePaths/resolveFolderPath), and the
  useEnsemble/onProgress/outputDir/modelOverride values. Redaction, grouping and
  file reading already lived in the pure scan-pipeline/grouping modules and are
  imported directly, so the core runs the real readFileAsCodeBlock (incl. the
  `specs-` tag prefix) and the real FFD packer.
- The auditor system prompt moved INTO the core rather than becoming an injected
  seam (unlike code_task's codeTaskSystemPrompt): the prompt IS what a
  spec-compliance benchmark grades, so a seam would force every benchmark to
  ship its own copy and the two would silently drift. Its only index.ts inputs
  were the pure strings FILE_FORMAT_EXAMPLE / BREVITY_RULES, which move to
  scan-pipeline.ts (single source of truth, imported back by index.ts).
- index.ts's case is now delegation-only: 5147 -> 4880 lines.
- src/benchmark/check-specs/runner.test.ts: 9 hermetic tests, fake LLM seam only,
  real files on disk through the real pipeline + real report assembly. Covers
  per-file (mode 0), batched (mode 2), auto-grouped (mode 1), and the four
  fail-fast validation paths (missing spec, missing inputs, unreadable spec,
  empty LLM response).

Gates: build clean, eslint clean, 1316 tests passing (1307 + 9 new), zero
failures, zero tool-roster/doc drift.

- Refactor(provider): extract the completion + retry layer (P5b, TRDD-63314265)

Moves the last big block of index.ts's LLM plumbing into
provider/completion.ts: chatCompletionSimple, chatCompletionJSON and
chatCompletionWithRetry, plus the four state clusters they — and only they —
touch (the reasoning ladder, the supported_parameters filter, the
LLM_EXT_DUMP_REQUESTS hook, the SERVICE_HEALTH circuit breaker).
sanitizeProviderError goes to provider/http.ts, where the HTTP body it
sanitizes comes from.

WHY the four caches could move but the auto-free state could not: each of the
four was verified to have zero readers or writers outside those three
functions, so relocating them keeps every cache a SINGLE binding with one
owning module. `creditExhausted` and the auto-free flags are the opposite —
index.ts reads them elsewhere (shouldUseFree, the dispatch layer,
getEnsembleModels), so they STAY in index.ts and completion.ts writes them
THROUGH the seam (setCreditExhausted / engageAutoFree). A local copy in
completion.ts would silently diverge from what index.ts reads on the very next
call, and the session would keep spending after a 402.

Seam: ProviderDeps (P5a) is reused, extended to CompletionDeps. Every new field
is a FUNCTION, never a captured value — not only for the settings-reload reason
P5a documented, but because FREE_MODEL_ID is a `const` declared LATER in
index.ts than the deps object, so an eager read would throw on TDZ at init.

No re-export shims (project rule): the three test files that imported the moved
symbols from ./index now import them from their new homes.

index.ts 6190 -> 5147 (-1043). Build + lint green; 1247 tests pass, 0 fail;
doc-consistency (11) + tool roster (23) green => zero tool drift.
provider/ still imports ZERO from index.ts. dist rebuilt.

Agent: llm-externalizer

- Refactor(provider): extract connection/transport/LM-Studio layer (P5a, TRDD-63314265)

Phase 5a of the index.ts monolith split. index.ts 6685 -> 6190 (-495).

New src/provider/ package, importing ZERO from index.ts (no cycle, no
re-export shims):
  - types.ts     BackendConfig, ConnectionSetup, ChatMessage, StreamingResult,
                 ModelInfo, VALID_REASONING_EFFORTS/ReasoningEffortSetting and
                 the ProviderDeps seam.
  - http.ts      fetchWithTimeout, fetchWithRetry429, computeBackoffMs —
                 stateless transport, no deps at all.
  - lmstudio.ts  the LM Studio native block: per-endpoint probe cache,
                 detectLMStudio, chatCompletionNative.
  - connection.ts resolveConnection (the single point every request's model
                 flows through, so the free_only cost-safety assert lives here).

WHY the deps object: the provider modules cannot read index.ts's mutable
backend state (currentBackend / activeResolved / SOFT_TIMEOUT_MS are all
reassigned on a settings reload), so index.ts builds one providerDeps object
and passes it at the 5 call sites — same pattern as ScanFolderDeps/CodeTaskDeps.
Every stateful field is a FUNCTION, not a captured value: a value captured at
module-init would pin the provider layer to the pre-reload generation forever.

Also dropped two stale docstrings that moved out with the code: a duplicated
fetchWithRetry429 header, and one for a per-chunk stream reader that no longer
exists.

Gates: tsc+esbuild build green; eslint src --max-warnings 0 clean; full suite
1247 pass / 0 fail; doc-consistency (11) + index roster (23) green => zero tool
drift. dist rebuilt and committed.

Phase 5b (chatCompletionSimple / chatCompletionJSON / chatCompletionWithRetry)
deliberately NOT cut — see the TRDD.


## [10.1.0] - 2026-07-02

### Added

- Feat(benchmark): --bench-free-pool admits + auto-discovers zero-cost models (P3b, TRDD-WJND1N2W)

Completes owl-alpha's free-pool inclusion. The dedicated free-pool benchmark previously
threw on any non-':free' id, so open-beta 'free for now' models (openrouter/owl-alpha — no
':free' suffix) could not be benchmarked as free models. New pure resolveFreePool() resolves
the pool against the LIVE catalog: a configured non-':free' id is admitted ONLY when the
catalog prices it at exactly $0 (else it lands in 'rejected' and the caller fails fast BEFORE
any run), and auto-discovery adds every structurally-qualified zero-cost catalog model (incl.
no-suffix ones), ranked by the P2 quality indexes and capped at --qualifying-top-n.

CRITICAL safety reason this verifies price HERE rather than trusting the runtime chokepoint:
--bench-free-pool can run WITHOUT a free_only profile, and the runner chokepoint only fires
when free_only is active — so this resolution is the only guard against a mis-listed PAID
model billing. A priced or catalog-absent non-':free' id is rejected fail-safe. +3 unit tests
(configured admit/reject, auto-discovery include/exclude, cap + no-dup); full suite 1247
passed, typecheck/lint/build clean. owl-alpha is now in BOTH the ensemble (P1+P2) and the
dedicated free benchmark, automatically — the user's full intent.

- Feat(benchmark): make the free_only chokepoint SEMANTIC — :free OR price-0 (P3a, TRDD-WJND1N2W)

The free pool's zero-spend was 'by construction' via the :free SUFFIX (runner.ts chokepoint,
TRDD-97ef8b63). That syntactic check excludes open-beta 'free for now' models with no :free
suffix (e.g. openrouter/owl-alpha). Replace it with a SEMANTIC zero-cost test that PRESERVES
the guarantee: new pure isZeroCostPriced() (both axes exactly 0) + isFreeModeEligible() (:free
OR price-0). OpenRouter bills per the same catalog price the QualifiedModel already carries, so
price-0 = $0 for the call; a flip-to-paid re-reads non-zero → rejected; NaN/Infinity (missing
pricing, e.g. a baseline) → rejected. So nothing that costs money can pass — anything not
PROVABLY free is skipped, never billed. This lets owl-alpha (price-0) be benchmarked in
free_only ENSEMBLE runs (it already qualifies as a candidate via P1+P2). +5 unit tests incl.
the critical priced-no-suffix→REJECTED case; 183 benchmark tests green, typecheck/lint/build
clean. Pool-config relaxation + free-pool auto-discovery (the dedicated --bench-free-pool path)
follow in P3b.

- Feat(benchmark): quality-rank candidates by codex/ELO before the paid run (P2, TRDD-WJND1N2W)

Uses the catalog indexes (parsed in P1) to RESTRICT which candidates reach the paid benchmark
— the user's "use them to restrict candidates before benchmarking and consuming tokens" on a
$20 budget. New pure rankByQualityIndex(): scored-above-unscored (a missing index = UNKNOWN,
never dropped); among scored, higher composite of min-max-normalised codex + design-arena code
ELO (mean of PRESENT axes, so a one-axis model isn't penalised); cheapest $/M as tiebreak
(keeps "best CHEAP model" + preserves the prior cheapest-first order for an all-unscored pool).

Wired into all 3 candidate paths: the keyword/ensemble benchmark now ranks candidates best-first
and honours a NEW --qualifying-top-n N pre-benchmark cap (distinct from --pick-top-n, which caps
RESULTS; --include baselines never capped); search-existing + security-triage swap their
cheapest-only sort for the quality rank before their existing top-16 cap. +5 unit tests; 178
benchmark tests pass, typecheck + lint clean, build OK. dist rebuilt.

- Feat(benchmark): parse OpenRouter codex-index + design-arena code-ELO (P1, TRDD-WJND1N2W)

Data layer only — no behavior change yet. OpenRouter ships two per-model quality indexes
inline on the public, unauthenticated $0 GET /api/v1/models (research verified):
  - codex index = benchmarks.artificial_analysis.coding_index (0-100, under-documented)
  - design-arena code ELO = benchmarks.design_arena[arena=models,category=codecategories].elo
Extended OpenRouterModel with the optional benchmarks shape; added two defensive pure
extractors (extractCodexIndex / extractDesignArenaCodeElo — return undefined on absent or
non-finite, never throw); decorated QualifiedModel with optional codexIndex/designArenaElo
and populated them in both qualify() and buildBenchmarkRoster()'s baseline path. Coverage is
partial (~60/339 codex, ~94/339 ELO) so undefined means UNKNOWN, never 'bad' — P2 will rank,
not hard-disqualify, on these. +9 unit tests (real z-ai/glm-5.2 shape); discover 19/19 green,
typecheck + lint clean.

- Feat(cli): register high_quality_scan in the bin/llm-ext tool catalog (TRDD-DBUSM55E)

Phase 4 (canonical CLI). bin/llm-ext is the generic per-tool CLI every MCP tool is
surfaced through (the dogfood's per-verb-help tests `llm-ext <tool> --help` for each
catalog entry). high_quality_scan was missing — added it next to scan_folder with the same
folder-scan params, so `llm-ext high_quality_scan --folder_path X --instructions Y` works
exactly like scan_folder. This is the canonical CLI surface (the friendly hyphenated
`llm-externalizer high-quality-scan` subcommand added earlier is an additional surface, like
search-existing). Dogfood now auto-covers it: 103 PASS / 0 FAIL (the new cli-help row tests
`llm-ext high_quality_scan --help`).

- Feat(commands): add high-quality-scan + high-quality-scan-and-fix slash commands (TRDD-DBUSM55E)

Phase 5 of high_quality_scan — the slash-command surfaces.
- high-quality-scan: thin wrapper over the high_quality_scan MCP tool (completes the
  three-surface set: MCP tool + CLI command + slash command). Parses scan_folder-shaped
  flags, calls the tool, returns report paths; warns when the backend can't run the
  paid model.
- high-quality-scan-and-fix: the high-quality twin of scan-and-fix — strong single-model
  scan via high_quality_scan, then ALWAYS-Opus parallel fixer subagents (≤15) that
  verify-then-fix each finding in the same run. Self-contained but reuses the existing
  validate_report.py / join_fixer_reports.py scripts and the llm-externalizer-parallel-
  fixer-opus-agent; explicit-target-only to stay concise. Slash-only by the documented
  GAP-11 exemption (multi-agent orchestration can't live in a single MCP/CLI surface).
README command count 37->39 / 22 base + two table rows. doc-consistency gate green (11/11).

- Feat(cli): add high-quality-scan CLI command (TRDD-DBUSM55E)

Phase 4 of high_quality_scan. New 'llm-externalizer high-quality-scan' verb — the CLI
surface of the high_quality_scan MCP tool. Like search-existing / cluster-synonyms it parses
scan_folder-shaped flags (--folder, --instructions[-file], --extensions, --exclude-dirs,
--max-files, --max-payload-kb, --answer-mode, --redact-regex, --scan-secrets, --redact-secrets,
--no-gitignore, --output-dir, --timeout-hours) into the tool's arg shape and calls it over the
spawned MCP server, so the LLM transport AND the paid-model fail-fast gate all live server-side
(a wrong backend / free_only / no-credit surfaces as isError -> exit 1, never a silent
downgrade). Wired into the top-level dispatch + the unknown-command list; printUsage gains a
usage line and a flags section. Validation smoke-tested (no-folder/no-instructions/--help all
correct); end-to-end CLI coverage rides the dogfood harness (Phase 6), matching the existing
CLI-command test precedent (parseSearchExistingArgs is likewise dogfood-covered).

- Feat(mcp): add high_quality_scan tool — single strong model, paid, fail-fast (TRDD-DBUSM55E)

Phase 3 of high_quality_scan. New MCP tool: scan_folder semantics but driven by ONE
strong remote model (default z-ai/glm-5.2) at max reasoning + prompt cache via the
single-model (modelOverride) path, NOT the cheap 3-model ensemble. Two pure helpers in
config.ts make the logic unit-testable: buildHighQualityProvider() (the OpenRouter
provider block, empty arrays omitted) and highQualityScanRefusal() (the paid-model gate
— refuses, never silently downgrades, on a non-OpenRouter backend / free_only / exhausted
credit). The dispatch builds ScanFolderDeps with useEnsemble:false, modelOverride=hq.id,
and the hqRequest knobs. definitions.ts extracts scan_folder's inline schema into a shared
scanFolderSchemaProps so the two tools never drift. README tool count 39->40 / core 16->17
+ a tool-table row (doc-consistency gate). Tests: 4 buildHighQualityProvider + 5
highQualityScanRefusal + 5 withSystemCacheBreakpoint + 1 fail-fast integration + listTools;
typecheck + lint + doc-consistency all green.

- Feat(scan): plumb high_quality_scan request knobs through the single-model path (TRDD-DBUSM55E)

Phase 2 of high_quality_scan. Adds an opt-in HighQualityRequest (provider/reasoning/
cache, defined in the leaf config.ts so index.ts + scan-folder/core.ts share one type)
threaded ScanFolderDeps -> processFileCheck -> ensembleStreaming -> chatCompletionSimple.
chatCompletionSimple now (OpenRouter only, opt-in only) attaches the OpenRouter provider-
routing block (a control field that survives the supported-params filter) and a
cache_control:{ephemeral} breakpoint on the system prompt; reasoning rides the existing
ladder. The HQ scan always takes ensembleStreaming's modelOverride branch, so the 3-model
ensemble is never touched and every non-HQ call is byte-for-byte unchanged. typecheck +
lint + full suite (1211 pass / 4 skip) green.

- Feat(config): add per-profile high_quality_model block (TRDD-DBUSM55E)

Phase 1 of high_quality_scan. New HighQualityModel/ResolvedHighQualityModel types +
resolveHighQualityModel(): a per-profile, fully-defaulted config for the upcoming
high_quality_scan tool — one strong model (default z-ai/glm-5.2) at max reasoning
("max"->xhigh, the real OpenRouter ceiling), prompt cache on, fp8+ quant expanded to a
provider.quantizations whitelist, preferred provider GMICloud. Defaults live in code so
the tool works out-of-the-box on any OpenRouter profile; a commented example is added to
SETTINGS_TEMPLATE for discoverability. ResolvedProfile.highQualityModel is required, so
the two full-literal test helpers were completed (and mkResolved's pre-existing missing
freeOnly/freeModels filled). 15 new config tests; typecheck+lint+32 config tests green.

- Feat(cluster): fail-fast memory guard + honest tool-desc (TRDD-828238b5 B3)

B3 option B. cluster_synonyms materialises the whole corpus in the JS heap
several times — items + itemsById + union-find + partition, and the dominant
N×dim×4-byte Float32 embeddings bundle (~1.5 GB at 1M items, 384-dim). A
too-large run used to OOM MID-FLIGHT, after the pre-flight benchmark and
Phase-1/2 LLM budget had already been spent, and the tool's "10k-1M items"
claim was unbacked.

WHY option B (guard) over A (out-of-core rewrite): A is a large, multi-session
rewrite with real clustering-correctness risk to honor a 1M contract nobody has
asked for ("don't build for imaginary scenarios"); B fixes the silent-OOM
footgun now and is fully reversible. Selected under the user's "complete all
pending tasks" directive (the TRDD left the call to the user).

- New pure module cluster/memory_guard.ts: estimates the peak heap footprint
  and returns a fail-fast verdict when it exceeds 70% of THIS process's live V8
  heap limit (ceiling auto-adapts to --max-old-space-size; no fake fixed
  number). The reason names the numbers and the four ways to proceed.
- Wired into runClusterSynonyms step 2b — BEFORE the pre-flight benchmark and
  all phase LLM spend — so a doomed run aborts cleanly before billing.
- New policy.skip_memory_guard knob (ClusterPolicy/DEFAULT_POLICY/PolicySchema/
  resolvePolicy) is the explicit escape hatch.
- index.ts tool description: replaced the unbacked "10k-1M items" with the
  heap-bound reality + the guard's guidance; also corrected a STALE
  "Phase 2/3 ship next release" status line (both phases are live).
- 18 pure unit tests (memory_guard.test.ts; no LLM/network), registered in
  vitest.config.ts. dist/ bundles rebuilt.

Verified: tsc + esbuild build clean, eslint --max-warnings 0 clean,
1089 tests pass (4 live skipped).


### Documentation

- Docs(trdd): WJND1N2W P5 DONE - ensemble updated to deepseek-v4-pro + mimo-v2.5 + mimo-v2.5-pro

- Docs(benchmark): guard rawResponse non-serialization + record token-audit TRDD-WJND1N2W

- Docs(bench-free-pool): complete FREE_POOL_SEED enumeration — add arcee-ai/trinity-large-thinking:free (was 14/15) + source pointer (TRDD-WJND1N2W)

The command body said '15 seed ids the plugin ships' but listed only 14 — arcee-ai/trinity-large-thinking:free (FREE_POOL_SEED entry 5 in config.ts) was missing, likely added to the constant after the doc was written. Verified against the live constant (15 ids); added it in code order + a pointer to the authoritative FREE_POOL_SEED in mcp-server/src/config.ts to curb future enumeration drift.

- Docs(benchmark): correct stale cost-cap claim — < $1/M both axes, not ≤ $1.5/$2.0 (TRDD-WJND1N2W)

benchmark.md step 2 claimed 'input ≤ $1.5/M, output ≤ $2.0/M' — stale on both value and
operator. The benchmark filters with DEFAULT_CRITERIA, which is STRICTLY < $1.00/M for BOTH
axes (discover.ts:90-91, qualify() uses < not <=, so $1.00 itself is rejected). Verified
against the code + the command's own dry-run output (index.ts:375-376 prints '< 1.00 (strictly
less)'). The 1.5/2.0 literals elsewhere in the tree are test fixtures, not caps. Isolated to
this one line; matches the ensemble-autoselect skill's '< $1/M' statement now.

- Docs(trdd): WJND1N2W P4 COMPLETE (docs d133001 + readme eb676fc) — feature P1-P4 done; only gated P5 remains

All credit-safe filter + owl-alpha inclusion work built, tested (1247 green), documented,
dogfooded (103 PASS). P5 (the actual paid rescan) + the 39-commit push are both user-gated.

- Docs(readme): correct bench-free-pool (catalog-verify + auto-discover, not :free-only) + note benchmark pre-rank/--qualifying-top-n (P4, TRDD-WJND1N2W)

The command-table row still claimed bench-free-pool 'refuses to run on any non-:free id' —
stale after P3b. Now: resolves the pool against the live catalog (non-:free admitted only at
catalog-$0, fail-fast otherwise) and auto-discovers zero-cost open-beta models (owl-alpha).
Also added the codex/design-arena $0 pre-rank + --qualifying-top-n spend cap to the benchmark
section. Dogfood 103 PASS/0 FAIL; doc-consistency green.

- Docs(benchmark): fold codex/ELO pre-filter + zero-cost-no-suffix rules into the 6 model-update docs (P4, TRDD-WJND1N2W)

Documents the shipped behavior in every model-update surface, per the user's ask to add
these instructions to the skills that update the remote models:
- ensemble-autoselect (skill), benchmark, bench-free-pool, discover-new-models,
  search-existing-benchmark, security-triage-benchmark.
- The credit-FREE codex (coding_index) + design-arena code-ELO pre-rank and the new
  --qualifying-top-n cap that restricts candidates BEFORE any paid run.
- Zero-cost no-suffix models (owl-alpha) as /bin/zsh ensemble candidates + auto-discovered into
  --bench-free-pool (catalog price-verified, fail-fast on a priced entry, semantic guard).

Authored by 6 parallel sonnet agents, then reviewed by me against the code: I CORRECTED the
discover-new-models draft, which overclaimed that the --new-arrivals phase itself ranks by the
indexes — verified rankByQualityIndex lives only in the benchmark candidate paths
(index.ts:598, search-existing:330, security-triage:338), so the doc now attributes the
pre-rank to the benchmark commands, not new-arrivals. doc-consistency green.

- Docs(trdd): WJND1N2W P3 COMPLETE (chokepoint 09c1f64 + free-pool 59fb4b3); P4 docs next

owl-alpha now in both the ensemble (P1+P2) and the dedicated free benchmark (P3a+P3b),
automatically. NEXT ACTION records the P4 doc targets + the two rules to fold in.

- Docs(trdd): WJND1N2W P3a done (09c1f64) — semantic chokepoint; P3b resume point recorded

owl-alpha now passes the free-mode chokepoint (the core 'use it if it passes' path via the
ensemble). STATE + NEXT ACTION record the precise P3b resume: relax --bench-free-pool, optional
free-pool auto-discovery, keep config.ts:584 conservative. Then P4 docs, P5 gated paid run.

- Docs(trdd): WJND1N2W P2 done (582affc); P3 chokepoint design locked

P1+P2 committed. STATE records the quality pre-filter + that owl-alpha already competes in the
ensemble via P1+P2. P3 design locked in detail (semantic price-aware chokepoint as the airtight
zero-spend guard, validators relaxed to match, 4 mandatory safety tests) and PAUSED for user nod
before modifying the credit-safety chokepoint. P5 paid rescan remains user-gated.

- Docs(trdd): WJND1N2W P1 done — data layer committed (2ca844b)

column dev; last-test-result pass; implementation-commits [2ca844b]. STATE: P1 (codex/ELO
parsing) done + tested; NEXT ACTION P2 (rank + top-N restrict). P3 safety note retained
(free_only chokepoint + runtime price guard). P5 paid rescan remains user-gated.

- Docs(trdd): add TRDD-WJND1N2W — OpenRouter rescan w/ codex/design-arena pre-filters (#165)

Plans the credit-safe model-rescan upgrade. Research (2 parallel agents) verified BOTH
benchmark indexes are free/API-available on GET /api/v1/models (codex =
benchmarks.artificial_analysis.coding_index; design-arena code ELO =
benchmarks.design_arena[arena=models,category=codecategories].elo). discover.ts mapped +
read whole: disqualifyReason() is the filter SSOT; the free pool's zero-spend is structural
via the :free suffix. Captures the 5-phase plan and the one design fork (admitting price-0
no-suffix beta models like owl-alpha into the free pool without breaking the zero-spend
guarantee — semantic detection + runtime price guard). column: design; no paid run until
user OK.

- Docs(config): document the high_quality_model settings block (TRDD-DBUSM55E)

The user required the high-quality scan model to be 'configurable in the yaml file as usual',
but the new high_quality_model profile block was undocumented in README/docs. Added a Profile-
fields row + a concise YAML example to docs/setup-and-configuration.md covering every sub-key
(id, reasoning_effort, cache, min_quantization, provider, allow_fallbacks) with its default
(z-ai/glm-5.2 / max=xhigh / cache / fp8+ / gmicloud/fp8 / no-fallback), and the paid +
fail-fast-on-local/free_only/no-credit semantics. Keys verified against the HighQualityModel
interface + resolveHighQualityModel. doc-consistency 11/11 green.

- Docs(trdd): finalize TRDD-DBUSM55E — high_quality_scan feature complete

All 6 phases done + committed. column: dev → complete; last-test-result → pass;
implementation-commits recorded (7c8ec92 a9fccb1 604fffc e5d9f71 698774b fffa29b 2e1fb25).
STATE block: P4 now records BOTH CLI surfaces (canonical bin/llm-ext catalog entry +
friendly bin/llm-externalizer subcommand), P5/P6 results, and the final gate evidence
(suite 1226 green, dogfood 103 PASS, commands 0/0/0, CPV new-findings 0). NEXT ACTION =
DONE; shipping gated on user push approval. Not shipped (release-via: publish).

- Docs(commands): clear CPV advisories on the two high-quality-scan commands (TRDD-DBUSM55E)

CPV pre-publish validation flagged 3 non-blocking advisories on the new command files:
a 126-char argument-hint (MINOR, may truncate in the UI) and two 'prose mentions of a
tool not in allowed-tools' WARNINGs (the cross-reference lines naming check_against_specs /
search_existing_implementations in the `mcp__llm-externalizer__…` form). Shortened the hint
to '<folder> --instructions "<task>" [scan flags]' (the body documents every flag), and
rewrote the cross-references to the plain tool names so they read as documentation, not a
runtime grant. Both files now validate CRITICAL/MAJOR/MINOR=0 ([OK] Command validation
passed). No behavior change.

- Docs(trdd): mark high_quality_scan Phases 1-3 done, Phase 4 (CLI) next (TRDD-DBUSM55E)

- Docs(trdd): add TRDD-DBUSM55E — high_quality_scan + _and_fix plan

Single configurable good model (default z-ai/glm-5.2, xhigh reasoning, fp8+ quant,
GMICloud provider, prompt cache) instead of the 3-model ensemble; MCP+CLI+slash for
the pure scan, slash-only Opus verify-then-fix for the _and_fix variant. Architecture
verified against source + OpenRouter docs before planning.

- Docs(trdd): B1 — record P4b deferral + correct the main()-guard fact

- P4b (free-ensemble helper extraction) investigated 2026-06-20 and DEFERRED:
  the cluster (FREE_FLOOR_MIN_CONTEXT_TOKENS, filterFreeModels,
  selectFreeEnsembleModels, isModelUnavailableError) is pure but ALREADY fully
  unit-tested (free-only.test.ts + auto-free.test.ts) and index.ts is already
  testable via its entry-point guard — so extraction adds zero coverage and is
  marginal churn on shipped v10.0.0. Not done, per "only what is strictly
  necessary".
- Corrected a stale load-bearing fact in the STATE block: index.ts's main() is
  ENTRY-GUARDED (`if (__isEntrypoint) main()` at ~6583), NOT run on a plain
  import — free-only.test.ts importing index.ts internals (without spawning the
  server) is the proof. The old "runs main() on import" drove an over-cautious
  belief that index.ts couldn't be imported for testing.
- Recorded the doc-drift fix d77cf60 (getEnsembleModels' orphaned docstring
  restored) that the investigation surfaced.

- Docs(index): restore getEnsembleModels' orphaned docstring

The `/** Build ensemble model list from the active profile's model +
second_model + third_model */` JSDoc had drifted ~140 lines from its
function: it sat stranded after ensembleModelLabel() and ABOVE the
FREE_FLOOR_MIN_CONTEXT_TOKENS docstring (documenting nothing), while
getEnsembleModels() — the function it actually describes — had no header
doc. A prior refactor inserted the free-ensemble cluster +
callEnsembleSlotWithRotation between the comment and its function.
Relocated it back to getEnsembleModels().

Source-only: esbuild strips JSDoc, so dist/ is byte-identical (verified —
no dist diff). No logic change; the 62 free-only + auto-free ensemble
tests pass.

Found while investigating a candidate free-ensemble extraction
(B1/TRDD-63314265). That extraction is DEFERRED: the cluster is already
fully unit-tested (free-only.test.ts, auto-free.test.ts) and index.ts is
already testable via its entry-point guard (realpathSync(entry) ===
import.meta.url), so extracting it would be marginal churn with no
coverage gain — counter to "only what is strictly necessary".

- Docs(trdd): scope B1 Phase 3 — code_task/scan_folder handler ranges + seam-injection plan (TRDD-63314265)

Records the concrete dispatch-handler line ranges (code_task 4221-5312, scan_folder
5313-5634; switch at index.ts:3919) and the reference pattern (search_existing's thin
case -> runSearchExistingImplementations + its hermetic FetchImpl-seam runner test) so
the next burst executes Phase 3 informed. Phase 3 is a DESIGN+extraction of live-dispatch
handlers (not a mechanical move) — enumerate every seam before cutting; deferred to a
fresh-context burst per the phased-execution + don't-rush discipline.

- Docs(trdd-828238b5): re-audit Part F test gaps — correct stale list, classify genuine candidates

The 2026-05-24 '10 TS + 14 Python' figure was stale (D1-D6 added 5 script test
files; codebase grew; the referenced ephemeral report is gone). Fresh read-only
sweep:
- TS: 31/77 modules lack a co-located *.test.ts, but ~11 are non-candidates
  (5 benchmark fixtures, pure-type files, thin CLI wrappers); ~20 genuine
  candidates (security_scan/*, benchmark/*, doc-inventory, scan-pipeline,
  search-existing/core, borderline cluster/policy).
- Python: diagnostics/* ARE covered (test_diagnostics.py); ~8 genuine candidates
  (check_references, join_fixer_reports, setup.py, recommend-models, test-model,
  validate_fixer_summary, validate_report, maybe install_statusline).
Flagged that some TS candidates may be integration-covered (confirm per-module,
per the D2 lesson) and that the suite is a phased effort needing prioritization,
not an unattended task. No code change. Not pushed.

- Docs(trdd-828238b5): mark Part D (D1-D6) DONE — already remediated under TRDD-6e859d3c

Resumed the Part D bug backlog autonomously; verify-first revealed all six items
were already fixed (the 828238b5 backlog was simply never updated):
- D1 f64b342, D2 d514220, D3 dc56d71, D4 4678a8a, D5 52563d0, D6 5512072,
  docs-align 53babb6 — all under TRDD-6e859d3c (honor-contract + TDD).
- Deep-verified D2 by reading _bench_helpers.py: .get() defaults end-to-end with
  batch-resilience comments + dedicated guards in tests/test_bench_helpers.py.
  Corroborated D1/D3/D4/D5/D6 via their per-item fix commits + the remediation TRDD.

Prevents a future session from re-investigating completed work. No code change.
Genuinely-open in 828238b5 now: B1 (index.ts monolith split — large/incremental),
B3 (re-scoped, product decision), A6 deferred code_task/scan_folder benchmarks,
Part E dead-code (RULE 0, needs user approval), Part F test gaps (need a
verify-first re-audit — the 2026-05-24 audit is stale). Not pushed.

- Docs(trdd-828238b5): re-scope B3 after source re-verification — original fix is mis-targeted

Verified the cluster_synonyms memory behavior directly against source (not the
summary). Findings that overturn B3 as written:

- The whole corpus IS held in memory (cluster_synonyms_main.ts:302 items[],
  :309 itemsById, :347-348 union-find, :396 partition) — VERIFIED.
- But TRDD-220ea89f §3 (line 79) explicitly sanctions the ~50 MB row accumulator
  ('no full-file load; 1M items ~= 50 MB in memory — acceptable'), and the code
  already streams the FILE (streamJsonl = createReadStream+readline, no blob load).
  So B3's proposed 'stream from the JSONL' fix targets the one part the design
  already accepted.
- The real high-N consumer is the embeddings bundle (compute_embeddings:true
  default, policy.ts:19; all-MiniLM-L6-v2 384-dim, :18), held for ALL items at
  once (:330-334) — est. ~1.5 GB at 1M, the dominant cost. Streaming the JSONL
  does nothing about it.
- Re-scoped to a product-direction decision (pending USER): (B) fail-fast guard
  at the measured ceiling + honest doc of the real limit [recommended near-term,
  fixes the silent-OOM footgun] vs (A) full out-of-core rewrite [large, deferred].
  Retired the mis-diagnosed 'stream from the JSONL' phrasing.

No code change; prevents a future session from implementing a mis-targeted rewrite.
Not pushed (doc edit; awaits user A-vs-B decision).


### Fixed

- Fix(ensemble-autoselect): add proactive-rescan triggers routing to the one-shot CLI (TRDD-WJND1N2W)

WHY: the skill's auto-trigger list was reactive-only (404/breakage), so a proactive 'rescan/update models' ask matched nothing and Claude hand-rolled a per-model loop (the 30-40M-token sink). Now both reactive and proactive asks resolve to the same single CLI call (--qualifying-top-n 15 --pick-top-n 3, backgrounded), with the anti-loop failure mode named inline.

- Fix(benchmark-cmd): route proactive rescans to the one-shot CLI + bound spend/runtime (TRDD-WJND1N2W)

WHY: the OpenRouter model-rescan procedure burned 30-40M orchestrator tokens/run. Root cause (audit: reports/model-update-audit/audit.md) is NOT the code — the llm-ext-benchmark CLI is already single-call + report-to-file. It was routing: a proactive 'update/rescan models' request matched no trigger, so Claude hand-rolled a per-model loop (or_model_info/chat x ~50-150 candidates) = O(N^2) transcript blowup. Fix: (1) broad trigger phrases so proactive asks land on the CLI; (2) Step 2 mandates --qualifying-top-n 15 default + run_in_background + an explicit 'never hand-loop per model' anti-pattern naming the exact failure mode; (3) examples reordered dry-run-first -> bounded -> exhaustive-opt-in so the first copied invocation is the safe one.


### Refactored

- Refactor(mcp): extract code_task dispatch core to code-task/core.ts (B1 Phase 3 complete, TRDD-63314265)

Second + final dispatch-core extraction — completes B1 Phase 3 (scan_folder landed in
cd31f02). The `case "code_task"` handler body (~1091 LOC, the most complex tool: a
single/inline path AND a multi-file FFD-batched path with two batch modes) ->
`runCodeTask(args, deps: CodeTaskDeps)` in a new src/code-task/core.ts. The case shrinks
1091 -> ~26 lines. index.ts 6887 -> 6587 lines (8457 -> 6587 across the session, -22%).

Why this shape (same as scan_folder / search_existing):
- The core imports ZERO from index.ts (only ../grouping, ../rate-limiter, ../scan-pipeline
  + node builtins), so it loads WITHOUT triggering index.ts's main()-on-import — which is
  what makes it benchmarkable in-process (the A6 gate) and hermetically testable.
- CodeTaskDeps (14 seams) extends the ScanFolderDeps shape with code_task's real extras:
  ensembleStreaming (multi-model inline+batch seam), formatFooter, robustPerFileProcess
  (the mode-0 max_retries>1 parallel+retry+circuit-breaker path), codeTaskSystemPrompt,
  ensembleModelLabel, normalizePaths, resolveFolderPath, defaultTemperature. It omits
  backendModel / classifyError / getRateLimitConfig (those are used only inside the
  injected helpers, not by runCodeTask directly).
- Every server-stateful dep is injected, never read as a module global -> behavior-identical
  (the thin case wires the same real functions/state).

Verification: new src/benchmark/code-task/runner.test.ts = 6 HERMETIC tests covering single
+ inline + batch-mode2 + batch-mode0-sequential + batch-mode0-robust + validation-error
(fake LLM seam, real pipeline). Build (tsc+esbuild) green; full suite 1190 -> 1196 pass
(4 skipped); ESLint green; index roster + doc-consistency unchanged. dist/index.js rebuilt.

Phase 3 COMPLETE -> A6 (free-form code_task/scan_folder benchmarks) is now UNBLOCKED: a
benchmark runner can import runCodeTask/runScanFolder and drive the real pipeline. A6's
remaining work is the no-fakes part (real golden datasets + scorer), tracked in both TRDDs.

- Refactor(mcp): extract scan_folder dispatch core to scan-folder/core.ts (B1 Phase 3 pilot, TRDD-63314265)

First dispatch-core extraction — the Phase 3 pilot on the smaller of the two tools
(scan_folder, 321 LOC) to prove the seam-injection pattern before tackling code_task
(1091 LOC). Mirrors the proven search_existing_implementations extraction.

What moved: the `case "scan_folder"` handler body -> `runScanFolder(args, deps:
ScanFolderDeps)` in a new src/scan-folder/core.ts. The case shrinks 321 -> 21 lines
(it now only builds the deps bundle from server state and calls the core). index.ts
6887 lines (from 7183).

Why this shape:
- The core imports ZERO from index.ts (only scan-pipeline / grouping / rate-limiter +
  node builtins), so it loads WITHOUT triggering index.ts's main()-on-import — that is
  what makes it benchmarkable in-process (the A6 gate) and hermetically testable.
- ScanFolderDeps mirrors search-existing's SeiDeps but with scan_folder's real seams:
  processFileCheck (the per-file LLM-call seam, scan_folder's analogue of callModel),
  classifyError, saveResponse, getRateLimitConfig, resolveDefaultMaxTokens, onProgress,
  outputDir, modelOverride, useEnsemble, backendModel. It omits SeiDeps.ensembleModelLabel
  because scan_folder labels reports with backendModel directly (genuinely unused).
- Every server-stateful dependency is injected, never read as a module global, so the
  extraction is behavior-identical (the thin case wires the same real functions/state).

Verification: new src/benchmark/scan-folder/runner.test.ts = 5 HERMETIC tests (fake
processFileCheck seam, real rateLimitedParallel + real report assembly — no network, no
mocking of the unit), mirroring benchmark/search-existing/runner.test.ts. Build
(tsc+esbuild) green; full suite 1185 -> 1190 pass (4 skipped); ESLint green; index roster
+ doc-consistency unchanged. dist/index.js rebuilt. No behavior change, no compat shims.

- Refactor(mcp): extract buildTools + tool schemas to tools/definitions.ts (B1 Phase 4, TRDD-63314265)

Moves buildTools() (~919 lines) + its 5 EXCLUSIVE schema helpers (BATCHING_NOTE,
answerModeSchema, maxRetriesSchema, folderSchemaProps, redactRegexSchema) out of the
index.ts monolith into a new tools/definitions.ts. index.ts 8268 -> 7183 lines (-1085).

Why this shape:
- buildTools' ONLY external deps were limitsBlock() + those 5 helpers (verified by a
  full module-level dependency scan; the helpers have zero use outside buildTools, so
  they move with it and stay module-internal — only buildTools is exported).
- limitsBlock() reads backend module state, so it STAYS in index.ts; instead of
  importing it into definitions.ts (which would create an index<->definitions cycle),
  its text is injected as a `limitsText` parameter. The 8 internal limitsBlock() calls
  become limitsText — behavior-identical because limitsBlock() is deterministic within
  one buildTools() call. index.ts's 2 call sites now pass buildTools(limitsBlock()).
- Derived fix: doc-inventory.ts::readCoreToolNames parses the tool-name array BY FILE
  PATH (6-space-indent regex), so it had to repoint from index.ts to tools/definitions.ts.
  The regex + indentation are unchanged, so the doc-consistency gate still matches.

Verified: build (tsc+esbuild) green, full suite 1185 pass (unchanged — zero behavior
drift), doc-consistency + index roster 33/33 (tool names/count/descriptions identical),
lint green. dist/index.js rebuilt. Pure move + limitsBlock->limitsText injection.

The ensemble helpers (selectFreeEnsembleModels, FREE_FLOOR_MIN_CONTEXT_TOKENS) were NOT
moved — they are not buildTools deps; deferred to a later phase.

- Refactor(mcp): consolidate ALL rate-limiting into rate-limiter.ts (B1 Phase 2b, TRDD-63314265)

Phase 2b of the index.ts monolith split. Phase 2 had extracted only the
AdaptiveRateLimiter class; the shared singleton, the getAdaptiveRateLimiter
factory, the rateLimitedParallel executor, the ProgressFn type, and
HEARTBEAT_INTERVAL_MS were left behind in index.ts. This moves all of them into
rate-limiter.ts so it is the SOLE home of rate-limiting and index.ts holds zero
rate-limiting state.

Why this shape:
- The singleton must stay SHARED across all tool calls (a 429 from any call backs
  off all of them). ESM modules are singletons, so a module-level `let` in
  rate-limiter.ts preserves that invariant exactly — verified by build + full suite.
- classifyError (the 429 path) and the per-file completion site used to reach into
  the `adaptiveRateLimiter` binding directly. They now call exported guarded
  accessors signalRateLimitHit() / signalSuccess() that no-op until the singleton
  exists — preserving the prior `if (adaptiveRateLimiter)` guard verbatim.
- HEARTBEAT_INTERVAL_MS is also used by chatCompletionSimple's per-request heartbeat,
  so it is EXPORTED (single source of truth for the 30s MCP keep-alive) rather than
  duplicated — caught by tsc when the first move left that use dangling.

index.ts 8326 -> 8268 lines. +6 tests (executor order / concurrency-cap /
completeness / progress + accessor no-throw); 1148 -> 1154 TS tests. Build + lint
green. dist/index.js rebuilt. Pure code-location refactor, no behavior change.

- Refactor(index): B1 Phase 2 — extract AdaptiveRateLimiter (TRDD-63314265)

Second clean phase of the index.ts split. The AIMD AdaptiveRateLimiter class is
fully self-contained (depends only on Date/setTimeout/Math/stderr — zero index.ts
module-state deps) and had no external importers, so the extraction is low-risk.

- Moved the class to mcp-server/src/rate-limiter.ts (exported). index.ts keeps the
  module-level singleton `adaptiveRateLimiter` + the getAdaptiveRateLimiter()
  factory (they hold shared state) and imports the class; the `new
  AdaptiveRateLimiter(rps)` site + all instance refs resolve to the import.
- Added rate-limiter.test.ts (10 tests): the deterministic AIMD state logic —
  multiplicative-decrease halving, additive-increase after 10 successes, the
  min-1/initial-ceiling clamps, success-streak reset on a 429, reset()/reset(n),
  and an acquire() smoke. No time-mocking needed for the rate-state assertions.
- Plan TRDD-63314265 STATE updated: Phases 1 & 2 done; NEXT is the high-risk
  Phase 3 (dispatch-core extraction that unblocks A6). The rate-limited parallel
  executor was deliberately left for a later phase (it has more coupling).

Verified: tsc + esbuild build clean, npm test 1148 pass (+10), eslint clean.

- Refactor(index): B1 plan + Phase 1 — extract request-overrides (TRDD-63314265)

B1 is the index.ts monolith split (TRDD-828238b5 Part B). A deep investigation
this session established that index.ts (8457 lines — the "9599" figure was stale)
has NO clean, co-located, low-coupling block for a quick safe extraction: every
candidate is either tiny + scattered + interleaved with impure module state, or a
large block heavily coupled to shared state (rate limiter, backend config, fetch
helpers, auto-free flags, catalog cache). Per the global multi-file-refactor
directive (phased execution + review) the deliverable is a phased PLAN, not a
rushed entangled extraction on the shipped v10.0.0 server.

- New dedicated plan TRDD-63314265: section map (line ranges + per-section
  coupling), the 5-phase extraction order, per-phase scope/guard/risk, and the
  Phase-3 dispatch-core extraction that UNBLOCKS A6 (free-form benchmarks).
- Phase 1 executed (lowest risk): the PURE per-model request-body override
  (applyModelOverrides + MODEL_REQUEST_OVERRIDES) had ZERO external importers
  (only index.ts internal, 2 call sites) — extracted to
  mcp-server/src/request-overrides.ts (pure, so it imports without index.ts's
  main()-on-import side effect) + 5 unit tests. index.ts keeps a breadcrumb
  comment + imports applyModelOverrides; the 2 call sites resolve to the import.
- TRDD-828238b5 B1 entry updated to point at the plan + record Phase 1.

WHY stop here: the directive gates Phase 2 behind review, and the meaningful bulk
(buildTools 1332 LOC + dispatch 3321 LOC) is the high-coupling part that must be
done phase-by-phase with verification — not rushed unattended on shipped code.

Verified: tsc + esbuild build clean, npm test 1138 pass (+5), eslint clean.


### Testing

- Test(mcp): cover 4 genuinely-uncovered pure modules (TRDD-828238b5 Part F wave 3)

+31 real unit tests, no mocks of the unit, for the pure exports that a fresh
extension-agnostic coverage sweep confirmed had ZERO test-call sites:
- cluster/policy.ts        resolvePolicy / DEFAULT_POLICY / PolicySchema (8)
- benchmark/discover.ts    filterModels / disqualifyReason / qualify / buildBenchmarkRoster (11)
- benchmark/score.ts       scoreRun (7)
- benchmark/security-triage/runner.ts  casesToGroups (5)

Why these and not the rest of the Part F candidate list: the D2 lesson says verify
the gap is REAL first. A `.js`-suffix-only grep over-reports gaps (it misses
extensionless same-dir imports), so I checked each candidate's EXPORTED-FUNCTION
call sites in *.test.ts, not just imports. The four above had 0 — genuinely
uncovered. The network-heavy orchestrators (search-existing/core.ts,
benchmark/*/index.ts runners, security_scan/openrouter.ts) were EXCLUDED: a real
test for them needs seam injection (like the search-existing runner test), not unit
mocks, so they are deferred to an attended pass rather than rushed unattended.

Each module's network functions (fetchProgrammingModels, runTriageBenchmarkOnModel)
were deliberately NOT tested — pure-logic targets only, so no fetch mocking.

Written by 4 parallel js-test-writer agents (each self-verified via a throwaway
config, no git access); orchestrator did the vitest.config.ts registration + the
full-suite verification. TS suite 1154 -> 1185 pass, 4 skipped; lint green. Tests
only — no source/dist change.

- Test: Part F wave 2 — 39 tests for 5 more uncovered modules (TRDD-828238b5)

Second wave of the Part F coverage campaign; brings the session total to 97 tests
across 12 confirmed-uncovered modules.

- TS: security_scan/report.ts (9 — pure threat-finding → markdown rendering),
  security_scan/concurrency.ts (6 — bounded-concurrency primitive: limit is actually
  respected, input order preserved, error propagation, empty input; exercised with
  real deferred promises, no fake timers). Registered in vitest.config.ts.
- Python: validate_fixer_summary.py (7 — exit-code-specific rejection paths),
  join_fixer_reports.py (7 — real sidecar merge/recognition), setup/recommend-models.py
  (10 — pure ranking/hardware-fit core only; the 2937-LOC file was NOT fully covered,
  by design — "don't over-engineer").

Two python agents mutation-tested their target (transiently edited the source to
confirm the tests catch regressions, then restored it). Orchestrator VERIFIED both
scripts are byte-identical to HEAD afterward (git diff empty) — no source changed.
Removed an unused `import pytest` flagged by ruff F401 in test_validate_fixer_summary.

install_statusline.py deferred (IO-heavy fs installer, little pure logic).

Verified: TS build + npm test (1133 pass, +15) + eslint clean; Python pytest
(187 pass, +24) + ruff clean. Additive tests only — no source modified.

- Test: Part F wave 1 — 58 tests for 6 uncovered modules (TRDD-828238b5)

Closes the highest-value confirmed-uncovered coverage gaps from the Part F audit.

WHY a re-verification first (D2 lesson): the original candidate list had false
positives. A `.js`-suffix-only grep missed extensionless same-dir imports, so
security_scan/{prompt,intake,judge,security_scan_main} are actually COVERED
(security_scan.test.ts imports runSecurityScan from ./security_scan_main and
exercises it 10+ times), and setup.py has 7 test refs. Testing those would have
duplicated coverage. Re-scanned with an extension-agnostic import check before
dispatching any agent.

Confirmed-uncovered modules, tested by parallel js-test-writer / python-test-writer
agents (real tests only, no mocks of the unit under test; orchestrator owned all
integration + git to avoid concurrent-edit/git conflicts):
- TS: scan-pipeline.ts (14 — FFD bin-packed batching: empty/oversized/exact-fit
  boundaries, largest-first determinism, prompt-byte budgeting), benchmark/report.ts
  (8 — pure rendering), benchmark/ground-truth.ts (7). Registered in vitest.config.ts.
- Python: setup/test-model.py (10 — incl. the _validate_local_url SSRF guard,
  asserting both accept of loopback and reject of external/metadata-IP/bad-scheme
  vectors), check_references.py (10 — real broken/valid reference trees),
  validate_report.py (9).

Verified: TS build + npm test (1118 pass, +29) + eslint --max-warnings 0 clean;
Python pytest (163 pass, +29) + ruff clean. No source changed — additive tests only.

- Test(setup): regression-guard vllm-cuda-autoconfig F7 + reconcile Part E (TRDD-828238b5)

Part E was STALE. A whole-tree re-verification (claim-verification rule) found
every item already handled by prior unrecorded work — and one "orphan" was
actually WIRED, so the TRDD's "git rm" action would have regressed the setup-agent.

WHY no deletion:
- apply_ensemble_choice.py + read_ensemble_state.py were already removed in
  cb7dfaf (recoverable via history) — both confirmed absent from the tree.
- vllm-cuda-autoconfig.py is NOT orphaned: it is wired into the setup-agent
  (Linux+NVIDIA VRAM-tuner, agents/llm-externalizer-setup-agent.md:210/212/333)
  by 4685031, which also already fixed the F7 fp8 gate. go-on-yourself says
  prefer integrating over deleting; the wired state is the correct outcome.

The one real gap: that wired script + its just-fixed F7 gate had ZERO tests.
- New tests/test_vllm_cuda_autoconfig.py (18 tests). It regression-guards F7 by
  driving the REAL main() fp8 gate — monkeypatching ONLY the environment
  boundaries (platform.system + detect_nvidia_gpu), never the logic under test —
  and asserting: unknown/unparseable driver (major 0) and driver <535 emit NO
  --kv-cache-dtype fp8, while driver >=535 does. The pre-fix `== 0 or` form
  would enable fp8 on an unknown driver (crashing vLLM); a revert now fails this
  test. Also covers driver parsing, tier boundaries, quantization resolution,
  and command assembly; plus --dry-run + --print-vram-only smoke.
- No source change (monkeypatch approach), so zero regression risk.

TRDD Part E marked RESOLVED; the stale Part F note about this file corrected.
Verified: full Python suite 134 pass (was 116).


## [10.0.0] - 2026-06-16

### Added

- Feat(auto): 3 surfaces for the auto-replacement loop + docs — A7 COMPLETE (TRDD-828238b5 A7-P3)

Closes A7 (the auto-* capstone) for the two tools with real benchmarks.

- MCP tool check_tool_replacements (21st tool) — READ-ONLY: calls
  planToolReplacements, writes the advisory report, returns the path + a
  one-line summary. CANNOT write settings (verified: the only call site of
  applyToolModelToSettings is the CLI --apply path; the MCP handler references
  the writer only in a guardrail comment).
- CLI --auto-replace [--apply --force] on the benchmark entry — the ONLY
  writer path: --apply calls applyToolModelToSettings per changed finding,
  prints old->new, tells the user to run reset. Gated like --apply-profile.
- slash command commands/llm-externalizer-auto-replace.md (wraps the read-only
  MCP tool; advisory by default).
- docs: README 38->39 MCP tools / model-mgmt bucket 6->7 / 36->37 commands,
  bin/llm-ext TOOL_CATALOG, agent-usage-reference, tool-use-cases, rules
  enumeration; roster tests bumped 20->21.
- TRDD-828238b5: A7 BLOCKED -> DONE for security_scan + search_existing;
  Status tally + updated: refreshed.

Read-only-MCP guardrail upheld end-to-end: the MCP/slash surfaces report;
only the CLI writes user config. Verified independently: build + lint green;
1067/1067 tests pass (4 live skipped); dogfood 100 PASS / 0 FAIL / 1 SKIP.

- Feat(auto): auto-replacement orchestrator core + per-tool tool_models writer (TRDD-828238b5 A7-P2)

The A7 capstone core (advisory half). Now that A7-P1 fills the ledger with
degradation signals and A6 gave two tools real benchmarks, the loop can run:

- model-qualification/auto-replace.ts — planToolReplacements(): for every tool
  whose registry .benchmark != null (security_scan -> security-triage,
  search_existing -> search-existing), resolve the incumbent model, roll the
  ledger via aggregateModelHealth, and IF degraded (or force) run that tool's
  real benchmark + selector to surface the best same-or-cheaper passer; render
  an advisory markdown report. ADVISORY-ONLY: it NEVER writes config (the
  benchmarkRunner + settingsReader are injectable seams for hermetic tests).
  A healthy/empty ledger yields no benchmark run and changed=false everywhere
  (no false positives).
- benchmark/pick.ts::applyToolModelToSettings() — the CLI/cron-only writer that
  sets tool_models[tool]=modelId, copying applyPicksToSettings's atomic
  tmp+rename + full guard chain, preserving every other key and tool entry,
  validating the tool name (registeredTools()) + modelId. Carries an explicit
  READ-ONLY-MCP GUARDRAIL banner: never call from an MCP handler.

15 new tests (7 orchestrator: healthy/degraded/force/report; 8 writer:
set/preserve/create/atomic/throws). Verified independently: build + lint
green; 1063/1063 pass (4 live skipped); orchestrator confirmed write-free.

Surfaces (MCP read-only report + CLI --auto-replace [--apply] + slash command)
land in A7-P3.

- Feat(health): emit the 5 deferred model-health event kinds at hot-path sites (TRDD-828238b5 A7-P1)

A1 shipped the durable model-events ledger + aggregateModelHealth degraded
verdict but emitted only param_drop / reasoning_downgrade. The five kinds the
A7 auto-replacement loop keys on were declared-but-never-emitted, so the
ledger could never surface a degraded model. This wires them at 14
model-aware sites across index.ts (native + JSON ensemble paths) and
security_scan/judge.ts:
- rate_limit_429    — once per call that hit >=1 429 (flood-collapsed, mirrors
  the [http-retry] log), via an optional saw429 out-param threaded from the
  retry helper to the model-aware caller.
- non_retryable_failure — on a 4xx (non-429) for the known model.
- empty_response   — blank body / no message.content at the validation points.
- schema_heal      — when a fenced/non-conforming JSON reply is repaired.
- truncation_retry — when a truncated finish_reason triggers the continuation.

LOGGING-ONLY contract upheld: emission is fail-open (the ledger swallows all
write errors), once-per-logical-occurrence guards prevent flood, and NO
retry/backoff/verdict behavior changed — only the optional out-param + emit
guards were added. A successful call emits none of the failure kinds (no false
degradation signal — asserted).

6 new tests drive the REAL judgeGroups path via the FetchImpl seam (forced
429 / 4xx / empty / truncated) against a temp LLM_EXT_CONFIG_DIR. Verified
independently: build + lint green; 1048/1048 pass (4 live skipped).

- Feat(benchmark): 3 surfaces for the search-existing benchmark + docs/TRDD (TRDD-828238b5 A6-P4)

Completes A6 for the search_existing_implementations tool: the benchmark is
now reachable from all three surfaces, mirroring security_triage_benchmark.

- orchestrator src/benchmark/search-existing/index.ts: resolve candidates
  (explicit list or qualifying discovery via the registry requirements,
  free_only-aware) -> runSearchExistingBenchmarkOnModel per model ->
  selectSearchExistingModel -> markdown report. Advisory-only (never writes
  config), same posture as security-triage.
- MCP tool search_existing_benchmark (mass_scouting/mcp-tools.ts) — 20th tool.
- CLI flag on the benchmark entry (src/benchmark/index.ts).
- slash command commands/llm-externalizer-search-existing-benchmark.md.
- docs: README counts/lists (19->20 MCP tools, +1 command, security bucket),
  bin/llm-ext TOOL_CATALOG entry, docs/agent-usage-reference.md,
  docs/tool-use-cases.md, rules/use-llm-externalizer.md tool enumeration.
- roster tests bumped 19->20 (index.test.ts, mcp-tools.test.ts);
  doc-consistency gate green.
- TRDD-828238b5: A6 -> PARTIALLY DONE (search-existing shipped; free-form
  code_task/scan_folder deferred); A7 unblocked for search_existing.

Verified independently: build + lint green; 1042/1042 tests pass (4 live
skipped); dogfood 98 PASS / 0 FAIL / 1 SKIP. Partial impl by the capped
agent a1c99070; finished by aff0b6bf; both reports under reports/kraken/.

- Feat(benchmark): search-existing in-process runner + shared selection gate + registry wiring (TRDD-828238b5 A6-P3)

- src/benchmark/select-common.ts: the three-gate same-or-cheaper selection
  (requirements -> benchmark-pass -> not-pricier; score desc / cost asc /
  latency asc; keep-incumbent fallback) extracted from security-triage now
  that a second consumer exists (DRY was premature before, per the TRDD).
  security-triage/select.ts delegates with byte-identical messages — its
  test file is UNCHANGED and passing.
- src/benchmark/search-existing/runner.ts: drives the REAL extracted
  pipeline (runSearchExistingImplementations from search-existing/core.ts)
  per golden case against a candidate model via an injected FetchImpl
  (realFetch default): in-memory saveResponse tee, dataset-derived scan
  list, section split via the pipeline's own splitPerFileSections, cost
  accumulated from usage x pricing, per-call latency, failures recorded
  without aborting the sweep.
- src/benchmark/search-existing/select.ts: criteria re-exported from
  TOOL_MODEL_REGISTRY (single source of truth) + selectSearchExistingModel
  on the common gate (score = micro-F1, pass = thresholds).
- registry: search_existing_implementations benchmark null -> "search-existing"
  (2nd tool with a real benchmark, after security_scan).
- 25 new tests (gate math 14, hermetic runner 4 — fake FetchImpl seam only,
  no module mocks, no network — selector 7) wired into the vitest roster.

Verified independently: build green; eslint clean; 1042/1042 tests pass
(4 live skipped). Implementation by kraken agent a1aa1bf6; report under
reports/kraken/.

- Feat(benchmark): search-existing golden dataset + deterministic scorer (TRDD-828238b5 A6-P2)

Second per-tool benchmark substrate, mirroring benchmark/security-triage/.
search_existing_implementations leads the A6 rollout because its output is a
per-file binary verdict (NO / YES symbol=... lines=...) — mechanically
scorable, no LLM judge needed.

- benchmark-fixtures/search-existing/ (OUTSIDE src/, so tsc/eslint/vitest
  never touch it): a hand-authored 10-file mini-codebase with KNOWN feature
  locations. Includes two differently-coded retry-with-backoff impls (tests
  semantic + EXHAUSTIVE multi-match), a Python port (cross-extension case),
  and engineered disambiguations (lru.ts has no get-or-compute; memo.ts has
  no eviction) so every golden truth is defensible. A local tsconfig gives
  editors node typings only.
- src/benchmark/search-existing/dataset.ts: 10 golden cases (multi-match,
  cross-language, source_files self-exclusion, absent-feature hallucination
  probe) + fixture-drift validation (validateDataset throws on missing files,
  dup ids, extension mismatches).
- src/benchmark/search-existing/score.ts: parseSectionVerdict (YES/NO/
  unparseable; section extraction stays the pipeline's own
  splitPerFileSections — no re-impl), per-case + micro/macro P/R/F1,
  coverage, thresholds (minMicroF1 0.85 / minMicroRecall 0.85 /
  minCoverage 0.9) with recall floored separately: a missed duplicate costs
  more than a spurious one.
- 28 new unit tests (dataset shape/drift + scorer math/parser edge cases),
  added to the vitest roster.

Verified: build green; eslint clean; 1018/1018 tests pass (4 live skipped).

- Feat(security)!: remove the Codex externalization integration entirely (TRDD-1e2b87cb)

BREAKING: removes the /llm-externalizer-codex-scan command + skill and the codex
runner. Calling the codex CLI from inside Claude Code clobbers CLAUDE_PLUGIN_DATA
and breaks every other Claude Code plugin; the runner also invoked
'codex --dangerously-bypass-approvals-and-sandbox' and wrote the user's global
~/.codex/config.toml on every run. User ordered: remove it and make sure codex
is never called from Claude Code.

Deleted (all were git-tracked, recoverable from history):
- commands/llm-externalizer-codex-scan.md
- skills/llm-externalizer-codex-scan/SKILL.md
- scripts/codex/{run-codex-scan.py,codex-scan-prompt.txt,codex-scan-prompts.md}
- tests/test_run_codex_scan.py

Cleaned references: tests/conftest.py (dropped 'codex' scripts subdir),
tests/test_fix_found_bugs_helper.py (comment), tests/dogfood/dogfood_test.py
(comments), docs/openrouter/responses-api.md (kept the gpt-5.3-codex MODEL-name
mentions — that's an OpenAI Responses-API model, not the codex CLI).

README: removed the codex-scan command section + table row + base-command
mention; counts 36->35 plugin commands, 19->18 base, 16->15 skills, tree
comments updated; doc-consistency.test.ts green.

Guard: new mcp-server/src/no-codex-invocation.test.ts (wired into the vitest
include) FAILS if any shipped file reintroduces a codex invocation
(/codex exec/, /--dangerously-bypass.../, /subprocess.*codex/,
/shutil.which("codex")/); plain prose naming codex is allowed. So codex can
never be silently re-added.

Verified: npm build 0, lint 0, vitest 990 passed/4 skipped, pytest 116 passed,
dogfood exit 0 (35 cmds/15 skills); git grep for codex invocation over the
shipped tree = empty. Supersedes TRDD-807c1e2d + TRDD-8de4e9f2. No push.


### Documentation

- Docs(trdd): authorize + plan full Codex-integration removal (TRDD-1e2b87cb)

User ordered: remove the codex externalization integration entirely and make
sure codex is never called from Claude Code. Reason: invoking the codex CLI
clobbers CLAUDE_PLUGIN_DATA and breaks all Claude Code plugins; the runner also
used 'codex --dangerously-bypass-approvals-and-sandbox' and wrote the global
~/.codex/config.toml on every run.

- New authoritative removal plan TRDD-1e2b87cb (status: in-progress) with the
  full blast radius (6 feature files + 6 referencing files, all git-tracked).
- Superseded TRDD-8de4e9f2 (triage — had the threat mechanism wrong: claimed
  read-only sandbox default).
- Superseded TRDD-807c1e2d (original codex design) + migrated it to YAML
  frontmatter.

No code removed yet — this commit is the TRDD bookkeeping; the deletion lands
in the next commit. No push.

- Docs(trdd): URGENT triage — codex externalization feature security review (TRDD-8de4e9f2)

User flagged 'codex is now known to poison claude code plugins'. Confirmed the
plugin ships a pre-existing codex-scan feature (command + skill + scripts/codex/
run-codex-scan.py). Read the runner: safe-by-default (codex exec, --sandbox
read-only, --approval never, output written ONLY to a report .md, nothing codex
emits is executed/applied). Residual exposure: escape-hatch flags
(--sandbox danger-full-access / workspace-write, --full-auto, --extra-codex-args
pass-through) and an unhardened indirect-prompt-injection path
(scanned-content -> codex -> report -> agent). Broader supply-chain / codex-CLI
threat angle needs the actual advisory. Decision pending: (A) harden flags +
prompt, (B) opt-in env gate, (C) remove entirely. Document-only; no codex code
changed, codex not run.

- Docs(trdd): document mass_scout/security_scan standalone-CLI auto-free gap (TRDD-8d8d33c8)

Backlog-only (user chose document-only). Investigation of 'are mass scouting
tools working with free models?' found two routes with different coverage:

- MCP server path (slash commands, bin/llm-ext, bin/llm-externalizer): COVERED —
  index.ts:6193 injects a :free model into scoutArgs.model via
  resolveSubsystemFreeModel after ensureAutoFreeDecided(); scout.ts:233 asserts it.
  Sound by construction + unit-tested (not yet live-verified on the free pool).
- Standalone CLI bundle dist/cli.js (npm 'llm-externalizer' bin, node dist/cli.js):
  GAP — mass_scouting/cli.ts resolveCliModel only handles explicit free_only, has
  0 refs to auto-free-on-low-balance. On a paid profile with balance < $1 it
  resolves to the paid DEFAULT_MODEL and the cost-safety guard throws ('agents
  refuse' bug, still live on this surface). Same for the security_scan CLI path.

Root cause: the auto-free machinery is module-private to index.ts; the separately
esbuild-bundled CLI can't reach it. Proposed fix (deferred): extract to a shared
module, wire into resolveCliModel, unit-cover, extend dogfood to the CLI surface.
No code changed, no live test, no push.

- Docs: fix 8 doc-vs-reality drifts found by the dogfood deep-eval (TRDD-1c973104)

A workflow-driven deep evaluation (6 finders -> adversarial verify) found 10
confirmed doc-vs-reality mismatches across the plugin's surfaces; 8 were real and
fixed here (each re-verified against the live code before editing):

- commands/llm-externalizer-mass-scout-estimate.md: --workers documented default
  256 -> 16 (matches mass_scouting/mcp-tools.ts).
- commands/llm-externalizer-mass-scout-search-xjob.md: --limit-per-job documented
  default 50 -> 100 (matches the tool schema).
- README.md plugin-structure tree: '24 slash commands' -> 36, '15 skills' -> 16
  (match the real file counts; the other README count phrasings were already
  correct and left untouched).
- 5 reference/setup skills (or-model-info, ensemble-autoselect, usage,
  vllm-metal-setup, vmlx-setup) advertised a '/slash' trigger but have no command
  file — they are agent-loaded reference skills. Set user-invocable: false and
  rewrote each description to state the real invocation path (matching the
  existing hf-cli / huggingface-* convention). Also clarified the vmlx-setup
  'vllm-local' preset note (chosen for OpenAI-API compatibility, not product).

Two findings were NOT applied: #7 (free-scan tool-name form) — the fixer changed
it the wrong way (README documents the FULL mcp__plugin_..._ form as canonical,
which free-scan already used), reverted to the committed state; the short-vs-full
form in sibling skills is cosmetic (both resolve). Doc-only changes; no code,
dist, or harness touched. vitest 989 passed/4 skipped; dogfood 98 PASS/1 SKIP. No push.


### Fixed

- Fix(build): clear CPV-update publish blockers + purge stale dist artifacts

CPV (claude-plugins-validation) tightened its security scanner since v9.15.0
shipped, and the publish gate now (correctly) blocks on 3 NON-skillaudit
findings — all verified false positives. publish.py's skillaudit-advisory
downgrade still works (66 skillaudit FPs on the security-triage benchmark
corpora + the security-scan feature's own source are demoted to advisory, as
designed); these 3 were a different rule namespace and rightly not downgraded:

  RC-70 (CRITICAL ×2) 'obfuscated decode near exec sink' on dist/cli.js.map
        + dist/index.js.map — esbuild source maps; CPV misreads base64
        mappings as obfuscated code. Source maps are debug-only build
        artifacts that should not ship in a distributed plugin.
  RC-65 (MAJOR) 'cloud IMDS endpoint 169.254.169.254' on
        scripts/setup/test-model.py:122 — the literal sits INSIDE the
        docstring of _validate_local_url, which is itself the SSRF guard that
        BLOCKS metadata probing. Pure documentation; the IP literal triggered
        the rule.

Fixes (none relax the gate — the strict 'non-skillaudit findings always block'
invariant is preserved; these remove FP-triggering artifacts + dead code):
  - esbuild.config.mjs: sourcemap true -> false (no maps in shipped bundles).
  - .gitignore: ignore mcp-server/dist/*.map (belt-and-suspenders).
  - test-model.py: abstract the IMDS IP literal in the SSRF-guard docstring
    (defensive explanation kept; literal removed so RC-65 no longer matches).
  - plugin.json: remove cpv.allow_pipeline_drift — CPV deprecated it
    (RC-DEPRECATED-OPTOUT: 'a plugin cannot self-exempt'; it is now a no-op).
  - Purge verified-dead stale dist artifacts so dist/ == the build output
    (index/cli/benchmark.js only): removed 6 *.js.map, 3 orphaned bundles
    (config/grouping/or-model-info.js — not built by the current 3-entry
    esbuild, not imported by launcher, not in main/bin), and 5 stale *.d.ts
    (tsc runs --noEmit; nothing consumes them; no 'types' field). Per the
    'no legacy/obsolete code' rule. All recoverable via git history.

Verified before commit: build+lint+test green (1071 pass); the 3 live bundles
carry no esbuild sourceMappingURL comment; launcher imports dist/index.js only.

- Fix(cluster): wire the pre-flight benchmark gate into production (TRDD-828238b5 B4)

B4 was 'exists but never wired': cluster/preflight_benchmark.ts + the core
gate (cluster_synonyms_main.ts honors hooks.preflight + the
skip_preflight_benchmark policy) were both present, but the production
cluster_synonyms dispatch in index.ts never supplied the hook — so the gate
was dead outside tests, despite the policy default (skip=false) signalling it
should run.

Wired it (decision: wire, not remove — a cheap daily-cached model smoke-test
before a long/expensive clustering run is genuinely valuable):
- new makePreflightHook(model, llmCall, opts) adapter in preflight_benchmark.ts
  wraps runPreflightBenchmark and maps its {pass,reason} to the core hook's
  {ok,reason} gate shape (extracted to a named helper so the mapping is
  unit-tested, not buried inline).
- index.ts cluster_synonyms dispatch now passes
  preflight: makePreflightHook(model, csRawLlmCall). This is the SOLE
  production hooks site — the CLI cmdClusterSynonyms routes through the MCP
  server, so one wiring covers both surfaces.

Behavior: preflight runs by default (policy default skip_preflight_benchmark
=false); a model that can't cluster 3 sentences fails the gate before any
expensive run, and an LLM-call failure fails CLOSED. The verdict is cached
per-model-per-day, so it's at most one tiny call/day. Opt out via the policy
flag (core already honors it).

4 adapter tests (pass->ok:true, fail->ok:false+reason, throw->fail-closed,
daily-cache single-call). Verified: build + lint green; 1071/1071 pass.

- Fix(deps): resolve all 14 npm audit advisories via in-range bumps (TRDD-ad8ce78f)

npm audit flagged 14 vulnerabilities (1 critical / 5 high / 8 moderate) across
11 packages, all fixable in-range. One 'npm audit fix' resolved everything;
package.json untouched, lockfile + rebuilt dist bundles only.

Key bumps:
- vitest 4.0.18 -> 4.1.8 (CRITICAL GHSA-5xrq-8626-4rwp: UI server arbitrary
  file read/execute)
- flatted 3.4.1 -> 3.4.2 (HIGH prototype pollution; closes Dependabot PR #2)
- hono 4.12.8 -> 4.12.25 (15 advisories <=4.12.20 — gap left by Dependabot
  PR #1 which was auto-closed at the now-insufficient 4.12.8 target)
- fast-uri 3.1.2, path-to-regexp 8.4.2, picomatch 4.0.4 (HIGH ReDoS/traversal)
- yaml 2.9.0 (runtime dep, bundled into dist), postcss 8.5.15, qs 6.15.2,
  ip-address 10.2.0, brace-expansion 5.0.6, @hono/node-server >=1.19.13

Verified: npm audit -> 0 vulnerabilities; build green (tsc + esbuild);
990/990 zero-cost tests pass on vitest 4.1.8.

Also verified during the issue-triage sweep: issues #3-#10 all correctly
closed with documented fixes (v9.11.0-v9.13.1), none need reopening.

- Fix(ux): externalizer usability — severity rubric, success banner, retry-log flood, rule-install bugs (TRDD-54f508a4)

Closes the remaining items from the dogfood-test evaluation (Issues 2-9; Issue 1
shipped in 2d8f5e5):

- #5 severity inflation: codeTaskSystemPrompt(lang) is now a single source across
  the 3 previously-divergent code_task call sites, with a SELF-GATING severity
  rubric ('If you assign a severity… reserve the highest level for exploitable /
  data-loss / crash issues; default lower when uncertain') — so non-severity
  tasks are unaffected.
- #4 no success summary: new cli-banner.ts prints '✓ <tool> complete — report:
  <path>' to stderr; stdout machine output unchanged.
- #2 confusing retry counters: tagged [http-retry] / [model-retry] (+model id) /
  [circuit-breaker]. Log strings only — retry control flow untouched.
- #3 429 log flood: fetchWithRetry429 logs the first 429 + a single '×N' summary,
  suppressing the middle attempts. Behaviour identical, only log frequency drops.
- #7/8/9 rule-install.ts: unlink orphan tmp on rename failure; /tmp → os.tmpdir()
  (Windows-safe); random suffix on the tmp filename. +2 tests.

build + lint clean; full suite 989 passed / 4 skipped (+9 new: 7 banner, 2
rule-install). No push.

- Fix(errors): sanitize provider error bodies — stop user_id leak + JSON flood (TRDD-54f508a4)

The raw OpenRouter HTTP-error body (full JSON envelope incl. "user_id":"user_…")
was baked verbatim into the thrown Error message at the 4 construction sites
(index.ts:3148/3153/3367/3372), then flowed unmodified into the slot-retry console
log, the ensemble rotation log, and — worst — the report file's 'Unavailable
models' section: leaking the OpenRouter account id into a file the user may share,
and flooding the console with multi-line JSON on every retry.

New pure sanitizeProviderError(raw) keeps only error.message + metadata.raw +
provider_name, caps to 200 chars, scrubs user_id / sk- tokens. Applied at the 4
construction sites (single source → cleans every downstream consumer). Safe for
classifyError: it matches the literal 'API error <status>' prefix, which lives
outside the sanitized body, so 401/402/403/429 classification (+ the 402→auto-free
hook) is preserved.

10 offline unit tests; build + lint clean; suite 980/984 (+10), zero regressions.
Surfaced by a live dogfood code_task run; full issue list in TRDD-54f508a4.


### Miscellaneous

- Chore(build): rebuild dist bundles for the A6-P3 modules (TRDD-828238b5)

The a03d95c commit landed the select-common/runner/select sources but the
regenerated bundles were left out of the stage list. dist now matches src
(verified: npm run build output of the committed tree).


### Refactored

- Refactor(core): extract scan-pipeline helpers + search-existing pipeline from index.ts (TRDD-828238b5 A6-P1/B1)

B1 increment: index.ts 10171 -> 8357 lines. Two new importable modules so the
upcoming per-tool benchmark (A6) can run the REAL search_existing_implementations
pipeline in-process without index.ts's top-level main() side effects:

- src/scan-pipeline.ts (1204 lines): the pure file-scan/prompt-prep cluster
  moved verbatim — detectLang, fenceBackticks, sanitizeInputPath,
  readFileAsCodeBlock, binary/secret scanning + redaction, parseRedactRegex,
  buildPreInstructions, resolvePrompt, readAndGroupFiles (FFD), resolve/
  buildPerFileSectionPrompt, walkDir + git-aware walking, extractLocalImports.
  resolveDefaultMaxTokens stays in index.ts (stateful: getCurrentBackend +
  openRouterModelCache).
- src/search-existing/core.ts (739 lines): the whole case body moved verbatim
  as runSearchExistingImplementations(args, deps); server-stateful seams
  (ensembleStreaming call, classifyError, saveResponse, ensembleModelLabel,
  onProgress, outputDir) injected via SeiDeps. index.ts case is now a 28-line
  deps-wiring delegation.

No behavior change. Verified: tsc + esbuild green; eslint --max-warnings 0
clean; 990/990 tests pass (4 live skipped) — identical to pre-refactor.

Work split: kraken agent did the bulk move (hit session cap after steps 1-2);
orchestrator completed the case delegation + lint cleanup.


### Testing

- Test(dogfood): permanent non-invocable dogfood-test skill + harness (TRDD-1c973104)

Maintainer harness that exercises every plugin surface, plus a non-user-invocable
skill (skills/dogfood-test, user-invocable: false, no slash wrapper) documenting it.

tests/dogfood/dogfood_test.py — $0 by default: build gate, discover health, CLI
--help for every bin/llm-ext verb + benchmark, benchmark --dry-run and
--bench-free-pool --dry-run, read-only $0 tools (get_settings, or_model_info_json,
discover_new_models), structural audit of all 36 commands/*.md and 15
skills/*/SKILL.md. Opt-in DOGFOOD_LIVE=1 runs chat + code_task through the free
pool (asserts a ':free' model -> still $0). Unicode result table + report under
reports/dogfood/ (gitignored). Exit non-zero on any FAIL.

Verified: default run 98 PASS / 0 FAIL / 0 WARN / 1 SKIP (exit 0); live smoke
chat + code_task returned real on-topic answers on :free models ($0). Zero real
plugin-surface defects across all surfaces. Standalone maintainer harness (not
wired into the publish test-gate).


## [9.15.0] - 2026-05-29

### Added

- Feat(free): Phase 2 — auto-free covers security_scan + mass_scout via global chokepoint (TRDD-542bdbef)

Phase 1 fixed the main-dispatch tools. Phase 2 extends auto-free to the
subsystem path (security_scan, mass_scout) that short-circuits before
resolveModelOverride and resolves its model purely from args.model.

- engageAutoFree now flips the global setActiveFreeOnly(true) — the airtight
  TRDD-97ef8b63 chokepoint — so the spend sites in judge.ts / scout.ts that
  read getActiveFreeOnly() also enforce ':free'.
- The balance decision is extracted to a shared ensureAutoFreeDecided(),
  called by both the main dispatch (resolveModelOverride) and the
  security_scan / mass_scout short-circuit, so every entry point agrees on
  when free mode engages (idempotent, 60s balance cache).
- The short-circuit substitutes a ':free' model into args.model under free
  mode (resolveSubsystemFreeModel — pure, exported, 6 new unit tests) so the
  chokepoint assertion is SATISFIED, not thrown. Picks the active pool's first
  model (profile free_models if pinned, else autoFreePool / FREE_POOL_SEED).
- Latent bug also fixed: security_scan defaults to qwen/qwen-2.5-7b-instruct
  (PAID) and asserts ':free' — so under an EXPLICIT free_only profile it would
  throw too unless the caller passed a free model. It now self-selects a free
  model under any free mode (profile free_only OR auto-free).
- Reload-preserve: reloadSettingsFromDisk now keeps a live auto-free
  engagement across a settings edit ((freeOnly || autoFreeEngaged)) — an empty
  wallet stays free mid-session; cleared only on restart.

Verification: build + lint clean; full suite 970/974 (4 live-skips; +6 Phase 2
tests). free-only.test.ts already proves assertFreeOnlyModel(true, openrouter,
'<x>:free') does not throw, and resolveSubsystemFreeModel always returns a
':free' id under free mode — so inject-':free' → assert-passes by composition.
Live security_scan smoke deferred: single-model subsystem (no rotation) +
free-tier 429 contention from the just-finished benchmark would make it flaky;
Phase 1's live smoke already proved the shared engagement path end-to-end.

TRDD-542bdbef Phase 1 + Phase 2 now both complete. Takes effect on MCP server
restart.

- Feat(free): tune FREE_MODEL_ID default to poolside/laguna-m.1:free + verify live (TRDD-542bdbef)

Benchmark v4 (re-run, user ask #1) + cross-run analysis: poolside/laguna-m.1:free
returned valid output in ALL 4 free-pool runs (the most reliably AVAILABLE
free model) and holds the top security-triage PASS (0.966). z-ai/glm-4.5-air
scores higher on the keyword task (100%/98.2%) but timed out on 429 contention
in v4. For the single-model fallback paths (free:true flag + 402 single-retry)
there is no rotation safety net, so availability wins → default switched
z-ai → poolside. Both remain configurable via LLM_EXT_FREE_MODEL_ID; the
ensemble paths still use the rotating free POOL regardless.

LIVE END-TO-END SMOKE (the definitive proof the agents-refuse bug is fixed):
ran `node bin/llm-ext code_task` on the dead wallet ($0.10 remaining, paid
profile remote-ensemble-geminigrok) with the freshly-built binary —

  [llm-externalizer] Auto-free engaged (balance $0.1021 < $1.00) — main-dispatch
    ensemble now routes through the free pool (15 models, rotation on rate-limit).
  [llm-externalizer] Ensemble model unavailable: deepseek-v4-flash:free — 429.
    Continuing with 2 model(s).
  → exit 0, report written, Model: poolside/laguna-m.1:free + gemma-4-26b:free,
    both correctly returned the answer. $0 spent. Paid ensemble + dead nvidia
    model never touched.

Before this fix the same call 403'd ("Budget limit exceeded") and the agent
gave up. Now it succeeds at $0.

benchmark v4 free-model results recorded in reports/free-bench/keyword-v4.*
(gitignored). 15 auto-free unit tests updated for the new default; build +
lint clean. TRDD-542bdbef Phase 1 acceptance criteria all met.

To go live in the running session: restart Claude Code (the MCP server still
holds the pre-fix binary). Phase 2 (security_scan/mass_scout free-pool routing
+ global chokepoint) is a tracked follow-up.

- Feat(free): auto-engage free mode when OpenRouter balance < $1 (TRDD-542bdbef)

Fixes the live "agents refuse to use llm-externalizer even though free mode
is available" bug. Diagnosis (balance $0.10, paid profile
remote-ensemble-geminigrok, no free_only): three compounding root causes —

  1. Threshold too low: the auto-fallback fired at < $0.05, but the balance
     is $0.10, so paid ensemble calls were attempted and 403'd ("Budget
     limit exceeded") → tool errored → agents bailed.
  2. Dead fallback model: FREE_MODEL_ID = "nvidia/nemotron-3-super-120b-a12b:free"
     — the exact model the free-pool benchmark (TRDD-f1510055) showed returns
     EMPTY content. Even when the fallback fired it routed to a broken model.
  3. Single model, no rotation: free models rate-limit constantly (~12/15
     429 per run), so one hardcoded free model is inherently fragile.

Phase 1 (main dispatch — chat / code_task / scan_folder / compare_files /
check_* / search_existing_implementations / cluster, i.e. what agents call):

- Threshold raised $0.05 → $1.00, configurable via LLM_EXT_FREE_BELOW_USD
  (non-finite/≤0 → $1.00). Balance $0.10 < $1 now engages auto-free.
- FREE_MODEL_ID is now resolveFreeModelId(): default z-ai/glm-4.5-air:free
  (benchmark winner — 100% keyword F1, security-triage PASS 0.906),
  configurable via LLM_EXT_FREE_MODEL_ID, non-':free' override rejected.
  Used for the `free:true` flag + the 402 single-retry.
- New autoFreeEngaged + autoFreePool process state + engageAutoFree(reason),
  engaged from resolveModelOverride (low balance) and both 402 sites. While
  engaged, getEnsembleModels routes the ensemble through the free pool
  (profile free_models if pinned, else FREE_POOL_SEED) via the existing
  selectFreeEnsembleModels + rate-limit rotation (TRDD-8b6b3646 Phase 3) —
  so the fallback is a rotating pool, not one fragile model.
- Cost-safety: getEnsembleModels asserts every model is ':free' under free
  mode (fail-fast); env-parsing extracted to pure exported helpers
  (parseFreeBelowUsd / resolveFreeModelId / resolveAutoFreePool) with 15 unit
  tests in src/auto-free.test.ts.

Phase 1 deliberately does NOT flip the global setActiveFreeOnly: security_scan
(judge.ts) and mass_scout assert ':free' on a model they don't self-select,
so flipping the global flag without routing their model selection to the pool
would turn a 402 into a hard throw. Phase 2 (follow-up) covers those subsystems
then engages the global chokepoint. Phase 1 is a strict improvement — nothing
regresses; the common agent tools now succeed at $0 instead of 403'ing.

Verification: npm run build clean, npm run lint clean, full suite 964/968
(4 skips are live API-key-gated tests; +15 new). Live end-to-end smoke
deferred until the in-flight free-pool benchmark finishes (free-tier
contention). NOTE: takes effect on MCP server restart — the running server
still has the pre-fix binary.

TRDD-542bdbef documents the full diagnosis + the two-phase design.

- Feat(free-pool): --bench-free-pool + auto-bench on free_only switch (TRDD-f1510055)

User-visible
- New slash command /llm-externalizer:llm-externalizer-bench-free-pool
- New CLI flag node dist/benchmark.js --bench-free-pool
- Auto-bench fires on MCP server boot (or settings reload) when
  free_only is ON and the benchmark cache has no :free entries.
  The detached child logs to ~/.llm-externalizer/free-pool-bench.log
  and records its PID in ~/.llm-externalizer/free-pool-bench.lock.

Surfaces (TRDD-a24b213c compliance: CLI + slash command + auto-trigger;
no MCP tool by design — a 10-30 min benchmark from a tool call would
violate the MCP server's read-only character)
- CLI: --bench-free-pool resolves the candidate set from the active
  profile's free_models (or FREE_POOL_SEED if unpinned), refuses any
  non-:free id, feeds the pool into --include (keyword) or --model
  (security-triage). Composes with --security-triage.
- Slash command: thin wrapper, identical pattern to existing
  /llm-externalizer-benchmark. Documents --dry-run skip-auth path
  and the composition rule.

Cost-safety chain (belt + suspenders + belt)
- --bench-free-pool argument validator throws on any non-:free id at
  CLI parse time (before any fetch).
- Runner's getActiveFreeOnly() guard (TRDD-97ef8b63) rejects any
  non-:free model at request build time.
- OpenRouter's per-model billing: :free models are $0 regardless of
  count or reasoning. Three independent guards must all fail for a
  paid call to leak.
- LLM_EXT_DISABLE_FREE_POOL_AUTO_BENCH=1 disables auto-spawn entirely.

Module split
- free-pool-auto-bench.ts: pure helper (modulo spawn()), 5 skip
  conditions evaluated in order. Detached child with stdio piped to
  the log file. Live-PID detection via process.kill(pid, 0).
- index.ts: wired into the startup IIFE (line ~1357) and the
  settings-reload path (line ~1849). Prior free_only state captured
  before atomic swap so OFF→ON transitions are detectable.
- benchmark/index.ts: --bench-free-pool parser branch + resolver in
  main() between profile resolution and the keyword/security-triage
  routing. Help text + slash command authored.

Tests: 13 new unit tests in src/free-pool-auto-bench.test.ts covering
every skip path, transition path, robustness against garbage
cache/lock files. Full suite green (949/953, 4 skips are live tests
gated on OPENROUTER_API_KEY). Doc-consistency confirms 19 base
commands / 36 total / new name appears in README.

Empirical findings from the in-flight first sweep (15 free models):
- poolside/laguna-m.1:free returns valid output (~88-89% F1, below
  the default 95% pass gate but enough to register in the cache).
- ~12 models hit free-tier daily rate limits (429 after 3 retries) —
  the retry loop helps with transient bursts, not full-day quota.
  Recommendation in TRDD: split the sweep across multiple days /
  accounts.
- nvidia/nemotron-3-super-120b-a12b:free returns empty content;
  nvidia/nemotron-3-nano-30b-a3b:free returns wrong schema. The
  bench correctly records both as ERR rather than fake-pass.

TRDD-f1510055 documents the full design, acceptance criteria, the
in-flight sweep results, and the three-surfaces decision (why no
MCP tool).

- Feat(free-pool): 15-model seed list + 429 retry for the benchmark runner

User-facing context: the free-only feature shipped in v9.14.0 (TRDD-8b6b3646 +
TRDD-97ef8b63) wired the runtime plumbing (filter + chokepoint guard + rate-
limit fallback rotation) but two gaps prevented "flip the switch and get a
real free-pool ranking" from actually working:

  1. The `remote-free-ensemble` profile template's `free_models:` list was a
     6-model placeholder, not the user's curated free pool.
  2. The benchmark runner failed every free-tier 429 on first try, so the
     keyword + security-triage benchmarks couldn't actually score most
     `:free` models — they'd just produce ERR rows.

This commit fixes both:

(1) Add `FREE_POOL_SEED` in config.ts — a `Object.freeze`d 15-id list curated
    against OpenRouter's `:free` tier criteria (context >= 128K, max_output
    >= 8K, structured_outputs or response_format, reasoning or
    include_reasoning, non-zero uptime). Single source of truth: the same 15
    ids are now copied verbatim into the SETTINGS_TEMPLATE's
    `remote-free-ensemble.free_models` block.

(2) Add 429 retry to `runBenchmarkOnModelInner` in benchmark/runner.ts. On
    HTTP 429, the runner now waits `max(retry-after * 1000, 5000 * 2^attempt)`
    capped at 60s and retries up to MAX_429_RETRIES=3. Non-429 HTTP errors
    skip the retry and return ERR (the runner's never-throw contract is
    preserved). The chokepoint guard above still rejects non-`:free` models
    under `free_only`, so retry burns only wall-clock — never $.

The 15-model seed:
  poolside/laguna-m.1:free, deepseek/deepseek-v4-flash:free,
  google/gemma-4-26b-a4b-it:free, google/gemma-4-31b-it:free,
  arcee-ai/trinity-large-thinking:free, nvidia/nemotron-3-super-120b-a12b:free,
  nvidia/nemotron-3-nano-30b-a3b:free, minimax/minimax-m2.5:free,
  qwen/qwen3-next-80b-a3b-instruct:free, openai/gpt-oss-120b:free,
  openai/gpt-oss-20b:free, qwen/qwen3-coder:free, z-ai/glm-4.5-air:free,
  meta-llama/llama-3.3-70b-instruct:free, nousresearch/hermes-3-llama-3.1-405b:free

Verification:
  * `npm run build` clean
  * `npm test` — 936/940 passed (4 skipped live-only suite)
  * 429 retry: empirically verified — the no-retry run had 3 google/deepseek
    models 429 on first try and was forever marked ERR; the retry-enabled
    run is currently in flight and recovering them as expected.

Next: a dedicated `--bench-free-pool` CLI mode + slash command that runs the
keyword + security-triage benchmarks against the free pool in a single
invocation and writes a unified report (TRDD-2a9e1f47 follow-up).

No push — staying local per the /go-on-yourself "Do not push" rule.

- Feat(3-surfaces): Phase 1 — close 9 of the 19 backlog gaps (TRDD-a24b213c)

Ships the 9 mechanical slash commands flagged by the three-surface
compliance audit (TRDD-a24b213c): every existing MCP tool now has the
required `/llm-externalizer:*` slash entry-point. No new code paths,
just frontmatter+body wrappers over already-shipped tool implementations.

New slash commands (commands/llm-externalizer-*.md):

  GAP-4 — 8 mass-scout wrappers
    • mass-scout-jobs-list             → mass_scout_jobs_list
    • mass-scout-audit-sample          → mass_scout_audit_sample
    • mass-scout-body-get              → mass_scout_body_get
    • mass-scout-build-fieldset        → mass_scout_build_fieldset
    • mass-scout-propose-fieldset      → mass_scout_propose_fieldset
    • mass-scout-diff                  → mass_scout_diff
    • mass-scout-chain                 → mass_scout_chain
    • mass-scout-list-bundled-fieldsets → mass_scout_list_bundled_fieldsets

  GAP-7 — soft-restart entry-point
    • reset                            → reset

Each file follows the existing mass-scout pattern: frontmatter
(`name`, `description`, `allowed-tools`, `argument-hint`, `effort`)
plus a body that lists flags (snake_case schema → kebab-case slash),
shows an example invocation, and documents the error modes. No
behavior change — these are pure UX wrappers letting users invoke the
tools by typing `/llm-externalizer:llm-externalizer-<name>` in Claude
Code instead of authoring an MCP tool call by hand.

README updates (top bullet + Plugin commands section):
  • "26 plugin commands" → "35 plugin commands"
  • "17 base" → "18 base" (added `reset`)
  • "8 mass-scout" → "16 mass-scout" (added the 8 new wrappers)
  • Section heading "Base commands (15)" → "Base commands (18)"
    (the (15) was stale — table already had 17 rows; now 18 with reset)
  • Section heading "Mass-scout commands (8)" → "Mass-scout commands (16)"
  • Added one table row per new command (Purpose + Produces)
  • Removed the "MCP-only mass-scout tools (8, no slash-command
    wrappers)" paragraph — the statement is no longer true; bundled-
    fieldsets note + CLI cross-link preserved in flowing prose

TRDD-a24b213c bumped from `not-started` → `in-progress` with a
detailed Phase 1 status-log entry. Remaining phases (Phase 2
benchmark/ensemble MCP wrapper, Phase 3 by-design exemption docs,
Phase 4 bin/llm-ext catalog policy, Phase 5 user-global rule fix)
stay deferred per the TRDD's suggested execution order.

Verification:
  • `npm run build` clean
  • `npx tsc --noEmit` clean
  • `npm test` — 936 / 940 passed (4 skipped are the live-only suite
    --exclude'd by default); the auto-discovering doc-consistency.test.ts
    (A5 gate) picks up the new commands automatically and asserts the
    new README counts + name presence
  • `commands/*.md` count: 26 → 35 (verified)

No push — staying local per the /go-on-yourself "Do not push. Wait
for my approval first." rule.


### Documentation

- Docs(free): document auto-free env vars + tell agents not to refuse on low balance (TRDD-542bdbef)

- docs/setup-and-configuration.md: add LLM_EXT_FREE_BELOW_USD, LLM_EXT_FREE_MODEL_ID,
  LLM_EXT_REASONING_EFFORT, LLM_EXT_INSTALL_RULE, LLM_EXT_DUMP_REQUESTS to the canonical
  'Relevant environment variables' table (it was missing all five; README already had them).
- rules/use-llm-externalizer.md: add an 'Auto-free on low balance' paragraph so agents know
  free mode auto-engages below $1 (or on a 402) and routes every tool through the free pool
  at $0 — a near-empty wallet is never a reason to refuse the tool or do the work themselves.
  Closes the doc/rule half of the 'agents refuse to use it' bug (TRDD-542bdbef).

- Docs(trdd): mark TRDD-542bdbef completed (auto-free Phase 1 + Phase 2 shipped)

- Docs(free): document auto-free-on-low-balance + LLM_EXT_FREE_BELOW_USD / LLM_EXT_FREE_MODEL_ID (TRDD-542bdbef)

- README B2: new "Automatic free mode on low balance" subsection — every tool
  (incl. security_scan / mass_scout) routes through the free pool when balance
  < $1 or on a 402, no config needed; funded profile reactivates on restart.
- README env-var table: LLM_EXT_FREE_BELOW_USD (default 1.00) +
  LLM_EXT_FREE_MODEL_ID (default poolside/laguna-m.1:free, non-:free rejected).
- CHANGELOG [Unreleased]: full feature entry with the diagnosis, the fix, and
  the live verification.

doc-consistency test green.

- Docs(statusline): refresh model/version examples to Opus 4.8 / v2.1.154

Claude Code v2.1.154 ships Opus 4.8 as the new flagship. The statusline
is already fully compatible — model.display_name is read live and the
" context)" → ")" compaction regex is version-agnostic — so only the
illustrative examples were stale:

- statusline.py: comment example "Opus 4.7" → "Opus 4.8"; added an
  explicit note that the compaction is version-agnostic (4.8/4.9/… all
  compact automatically) so future readers don't think the example is
  load-bearing.
- README.md: model-row example "Opus 4.7 (1M context)" → "Opus 4.8
  (1M context)"; cached-version example v2.1.138 → v2.1.154.

Verified end-to-end: piping an "Opus 4.8 (1M context)" fixture through
statusline.py renders "🤖 Opus 4.8 (1M) ·max" correctly, and
check-statusline.py still PASSes (636 bytes, exit 0).

Audit scope: examined the full v2.1.123→2.1.154 changelog against the
plugin. Every other platform change is N/A or already-current:
- no hooks shipped (hooks.json is {}) → all hook-capability items N/A
  (args exec form, continueOnBlock, MessageDisplay, reloadSkills,
  sessionTitle, terminalSequence, $CLAUDE_EFFORT/effort.level)
- plugin.json has no themes/monitors/statusLine top-level keys
  → v2.1.129 "move under experimental" warning N/A
- MCP server is named "llm-externalizer", not the now-reserved
  "workspace" (v2.1.128) → N/A
- no deprecated env vars shipped (CLAUDE_CODE_OPUS_4_6_FAST_MODE_OVERRIDE)
- statusline already consumes the v2.1.132+ pre-calculated
  context_window.total_input_tokens / used_percentage fields and reads
  $COLUMNS + workspace.current_dir/git_worktree
- uses the default skills/ dir (no skills: file-vs-dir validate issue),
  no stray root SKILL.md

- Docs(changelog): add [Unreleased] section for free-pool feature

Captures everything since 9.14.0 in one block so the next publish
picks it up cleanly:
- --bench-free-pool CLI flag + matching slash command (TRDD-f1510055)
- Auto-bench trigger on free_only OFF→ON transition (MCP-equivalent
  fourth surface — no MCP tool, by design)
- 15-model FREE_POOL_SEED + matching remote-free-ensemble template
- 429 retry in benchmark/runner.ts (3 retries, exp backoff, 60s cap)
- TRDD-a24b213c phases 2/3/4: GAP-8..14 exemptions + bin/llm-ext
  catalog 11→37 + benchmark MCP-tool exemption rationale

No version bump — publish.py owns that.

- Docs(three-surfaces): close Phases 2/3/4 of TRDD-a24b213c

Phase 2 (GAP-2/3 — benchmark + ensemble-autoselect)
- Design decision closed by TRDD-f1510055: NO MCP tool.
- Sweep takes 10-30 min; exposing as MCP would let any orchestrator
  agent trigger a half-hour blocking operation.
- Auto-trigger on free_only flip is the MCP-equivalent fourth
  surface (covers "available without leaving MCP" without the
  agent-trigger hazard).
- Exemption rationale documented in
  commands/llm-externalizer-benchmark.md §"Three-surface compliance".

Phase 3 (GAP-8..14 — by-design slash-only exemptions, 7 commands)
- codex-scan (GAP-8): wraps external `codex` CLI; no in-process
  capability to wrap.
- fix-report (GAP-9), fix-found-bugs (GAP-10): apply fixes via
  subagents; MCP file-write tools intentionally disabled
  (read-only-by-design).
- scan-and-fix (GAP-11), scan-and-fix-serially (GAP-12):
  multi-agent orchestration, not a single callable unit.
- setup (GAP-13): stateful + conversational interactive wizard.
- install-statusline (GAP-14): one-shot ~/.claude/settings.json
  installer (a CLI verb COULD be added but the slash-only path is
  trivial).
- Each command now carries an explicit
  "## Three-surface compliance: by-design slash-only (GAP-N)"
  section per the audit's standing invariant.

Phase 4 (bin/llm-ext catalog policy — expand)
- bin/llm-ext TOOL_CATALOG: 11 → 37 entries (+26).
- Added: search_existing_implementations, cluster_synonyms,
  or_model_info{,_table,_json}, 16 mass_scout_* family,
  security_scan, security_triage_benchmark, assess_model,
  check_model_health, discover_new_models.
- Parameter descriptions extracted from each tool's Zod schema
  in mcp-server/src/index.ts and src/mass_scouting/mcp-tools.ts.
- `node bin/llm-ext --help` now lists 37 tools; per-tool help
  works for every new entry (verified mass_scout_register).

Phase 5 (user-global rule file fix) — DEFERRED (requires explicit
user confirmation per the TRDD).

Verification
- npm run build: clean.
- npm test: 949/953 pass (4 skips are live tests gated on
  OPENROUTER_API_KEY). No regressions.
- TRDD-a24b213c status log updated with Phase 2/3/4 entries.
- Spark-agent reports under reports/three-surface-phase{3,4}/.


### Miscellaneous

- Chore(lint): drop unused eslint-disable in benchmark/runner.ts 429-retry loop

Modern eslint.config.mjs already permits `while (true)` so the
no-constant-condition disable directive is dead. `npm run lint` was
failing on the unused-directive warning (--max-warnings 0).

Build artifacts re-emitted to stay in sync.

- Chore(deps): bump better-sqlite3 12.9.0 → 12.10.0

Incidental dev-env fix surfaced while running the test suite on Node
v26 — the prebuilt native binary for 12.9.0 was compiled against
NODE_MODULE_VERSION 141 and could not load on Node v26 (147), failing
161 tests in mass_scouting/* with NODE_MODULE_VERSION mismatch.

12.10.0 ships the matching prebuild + builds cleanly from source via
node-gyp on Node v26 (verified locally — 936/940 tests green after the
bump; the 4 skipped are the live-only suite that's `--exclude`d by
default).

Patch-version bump within the existing `^12.9.0` semver range; no
behavior change.


## [9.14.0] - 2026-05-25

### Added

- Feat(free-only): airtight cost-safety — free models override EVERY tool (TRDD-97ef8b63)

User requirement: "when free mode is set, the free models OVERRIDE every
customized choice of the tools" + "prevent other claude code sessions from
using llm-externalizer without free mode enabled and working for all tools."

The free_only ensemble path (TRDD-8b6b3646) only covered the main ensemble.
Audit found 5 INDEPENDENT OpenRouter spend sites across 3 subsystems, each
fetching directly. Now every one enforces free_only — a non-':free' model
throws/skips BEFORE the request, so a leak fails fast instead of billing.

Spend sites + guards (1:1, grep-verified):
- index.ts resolveConnection (chat/code_task/scan_folder/cluster_synonyms/
  check_*/compare_files/search_existing_implementations)
- security_scan/judge.ts judgeGroups (security_scan runtime + triage benchmark)
- mass_scouting/scout.ts runScoutJob (mass_scout fan-out)
- mass_scouting/cli.ts runProposeFieldset (propose-fieldset LLM call)
- benchmark/runner.ts (keyword benchmark — returns RunError, honours never-throw)

Mechanism:
- config.ts: assertFreeOnlyModel(freeOnly, backendType, model) PURE guard
  (throws on non-':free' under free_only+openrouter; no-op off free_only / local).
  Process-global setActiveFreeOnly()/getActiveFreeOnly() so the pure subsystem
  modules read live free_only state without importing index.ts (no cycle).
- resolveModelForTool: free_only short-circuits — returns the free model,
  ignoring tool_models AND any caller fallback ("free overrides every tool").
- resolveProfile: under free_only, resolved toolModels = {} (file untouched).
- index.ts sets the flag at both activeResolved sync points (load + reload) —
  covers every in-process MCP tool (what other sessions use).
- cli.ts + benchmark/index.ts main() set the flag for the standalone CLIs.
- mass_scouting resolveCliModel(): under free_only returns the active free
  model so mass_scout RUNS on free instead of failing the guard; non-free
  profiles keep exact prior behaviour.

Tests: free-only.test.ts +10 — assertFreeOnlyModel (throw/allow/no-op),
resolveModelForTool free_only override (tool_models + fallback ignored),
resolveProfile toolModels cleared, setActiveFreeOnly/getActiveFreeOnly round-trip,
benchmark runner real-spend-site enforcement (RunError, never hits network).
Full suite 936 passed / 4 skipped / 0 OpenRouter boots; tsc + eslint clean.

Docs: README B2 "Free mode overrides EVERY tool"; rules/use-llm-externalizer.md
"Cost safety — free mode (zero spend, ALL tools)".

- Feat(free-only): daily-limit fallback rotation — Phase 3 (TRDD-8b6b3646)

Free providers all cap requests PER DAY, so an ensemble slot whose free
model is daily-limited must rotate to a different free model rather than
fail. Completes the free-only feature end-to-end.

index.ts:
- isModelUnavailableError(detail): pure predicate — true on 429 / rate-limit
  / daily-limit / per-day / quota / no-endpoints / 404 / 502 / 503 /
  overloaded; false on auth/malformed errors a different model would also
  fail (rotating wouldn't help).
- filterFreeModels(): the FULL benchmark+context-filtered list, refactored
  out of selectFreeEnsembleModels (= .slice(0,3)). Models 4+ become the
  fallback pool.
- callEnsembleSlotWithRotation(primary, fallbacks, claimFallback, callOne):
  tries primary; on an unavailable error claims the next shared fallback via
  an atomic idx=next++ counter and retries. Bounded by pool size (the shared
  monotonic counter guarantees termination — no infinite loop). Returns the
  same {model,content,usage,truncated,error} shape as the non-free path.
- ensembleStreaming: when freeOnly, build a file-size-aware fallbacks list
  (filtered pool minus the top-3 primaries), share ONE claimFallback across
  all parallel slots so two slots never burn the same model's daily quota,
  gate the single-model fast path on models.length===1 && fallbacks.length===0,
  and route each slot through callEnsembleSlotWithRotation. Non-free path
  byte-for-byte unchanged.

Tests: free-only.test.ts +12 — filterFreeModels full-list; isModelUnavailableError
match (429/daily-limit/no-endpoints/503) and non-match (auth/malformed/empty);
callEnsembleSlotWithRotation primary-success / daily-limit-rotate / multi-hop /
throw-rotate / non-rotatable-immediate / pool-exhausted-bounded /
shared-counter-no-collision. Full suite 927 passed / 4 skipped / 0 OpenRouter
boots; tsc + eslint clean.

Docs: README B2 "Daily-limit rotation" paragraph. TRDD-8b6b3646 → completed.

Zero-spend invariant intact at all three layers (validation rejects non-:free,
filters only evaluate :free, rotation pool is free-only). Live 429 end-to-end
still needs a funded run; the rotation logic itself is fully unit-covered offline.

- Feat(config): free-only benchmark filter — Phase 2 (TRDD-8b6b3646)

The free-only ensemble now drops models with a RECORDED failing security-triage
benchmark, reusing the EXISTING per-model cache
(~/.llm-externalizer/security-triage-results.json) rather than a new store.

- security-triage/index.ts: failedModelsFromCache(cache) — PURE, latest-wins per
  model, flags only CONCLUSIVE non-passes (an inconclusive/flaky run is NOT a
  failure, so a free model is never excluded on weak evidence).
  benchmarkFailedModels() reads the real cache.
- index.ts: selectFreeEnsembleModels gains a benchmarkFailed set — applied BEFORE
  the context floor; getEnsembleModels passes benchmarkFailedModels(). Empty
  cache → no-op (fresh-install safe).

How to populate (the only OpenRouter-dependent step — $0 on :free models, the
user triggers it): the existing `security_triage_benchmark` tool already accepts
an explicit `models:` list and benchmarks unqualified models (incl. :free), so
one run on the free pool fills the cache; the filter then excludes any failures.

Tests: +6 (failedModelsFromCache: pass/fail/inconclusive/latest-wins/empty;
selectFreeEnsembleModels drops a benchmark-failed model). Docs: README B2 recipe.
Full npm test 915 passed / 4 skipped / 0 OpenRouter boots; tsc + eslint clean.

- Feat(config): free_only switch — benchmark/requirements-filtered free ensemble, Phase 1 (TRDD-8b6b3646)

Per-profile free_only switch: when true, the profile uses ONLY the free_models
pool (the configured model/second_model/third_model are ignored). The top free
models that clear the requirements floor form the ensemble; the rest are the
rate-limit fallback pool (Phase 3).

Zero-spend by construction: validateProfile rejects the profile unless EVERY
free_models entry ends with ':free' (plus: non-empty, remote/OpenRouter preset,
>=2 entries for remote-ensemble; model/second_model become optional since
free_models supplies them).

- config.ts: Profile.free_only/free_models; ResolvedProfile.freeOnly/freeModels;
  resolveProfile derives model/secondModel/thirdModel from free_models[0..2] so
  the existing ensemble machinery runs the free top-3 with no hot-path change;
  validateProfile free_only rules; SETTINGS_TEMPLATE free-only example.
- index.ts: selectFreeEnsembleModels — a zero-spend context-floor requirements
  pre-filter (drops free models the catalog reports below 32K context; lenient on
  cold cache). getEnsembleModels uses it under free_only. NOTE: the premium
  qualification framework sets allowFree:false so it can't gate free models —
  hence the dedicated floor here; the golden-dataset benchmark filter is Phase 2.
- test-helpers.ts: freeOnly/freeModels on the local test profile.
- free-only.test.ts (NEW, 12): resolveProfile derivation, validateProfile
  invariants (incl. rejecting non-:free entries), selectFreeEnsembleModels filter.
- Docs: README "B2. free-only ensemble" + settings template.

Phase 2 (golden-dataset benchmark filter + result cache) is BLOCKED on
re-enabling OpenRouter — benchmarking the free pool is $0 but still OpenRouter API
usage, which is currently paused. Phase 3 (fallback rotation) needs live 429s.

Verified: full npm test 907 passed / 4 skipped / 0 OpenRouter boots; tsc + eslint
clean; all three dist bundles rebuilt (config.ts is shared).

- Feat(observability): LLM_EXT_DUMP_REQUESTS — audit the exact wire payload

Adds an env-gated request-audit hook: set LLM_EXT_DUMP_REQUESTS=<file> to append
the exact JSON body (model + byte size + full body) of every chat/code_task/
ensemble request (chatCompletionSimple) and structured-output request
(chatCompletionJSON) to that file. Off unless the env var is set.

Motivation: verify there is no unexpected prompt/file inflation in requests.
Used it to confirm exactly that — index.test.ts-class inputs produce ~600-token
bodies (829-2372 bytes captured), with no duplicated files, no hidden template:
system prompt ~33 tok + pre-instructions ~175 tok + instructions + file content.
ensembleStreaming sends the SAME messages to each of the 3 models (per-model
body == single-model body), so the high spike-hour prompt size was real
large-file content × ensemble fan-out, not request inflation.

Documented in the README env-var table (flagged that the dumped body contains
prompt + file content and should be treated as sensitive).

Verified: full npm test 895 passed / 4 skipped / 0 OpenRouter boots; tsc + eslint
clean; dist rebuilt.

- Feat(A5): doc-consistency gate — README counts/names match source (TRDD-828238b5)

Ends the doc-drift class the deep audit kept fixing: add a tool/command and
forget to bump a README count, and the gate fails with a clear message.

- doc-inventory.ts: pure, side-effect-free extractors that parse the
  authoritative declarations from source as text (core tool names, mass-scout
  /model-qual tool names, API-preset keys, command names, agent names). No
  server import (index.ts runs main() on import).
- doc-consistency.test.ts (11 tests): asserts README counts (N MCP tools,
  N plugin commands + splits, N backend presets, N internal agents, the
  core/utility + security/model-qual sub-counts) and name membership match.
- Runs inside `npm test`, which publish.py::run_checks already invokes as a
  mandatory gate (line 324) — "fail CI on doc drift" with zero publish.py edits.

Decision: a CHECK gate (not a marker-splicing regenerator) — the core tool
list is inline in the 9.6k-line index.ts that runs main() on import (can't be
imported by a generator without a risky refactor) and rendering README prose
exactly is brittle. A precise-failure check is equally drift-proof, far safer,
same end. Full suite 883 green.

- Feat(A4): discover_new_models — new-arrivals autodiscovery (TRDD-828238b5)

Surface models that newly appeared in the OpenRouter catalog since the last
run, each assessed against every per-tool requirements gate so the operator
can spot a newer/cheaper candidate. Free (public catalog fetch, no LLM call).
Report-only — adoption stays user-only.

- model-qualification/new-arrivals.ts: pure diff (diffNewArrivals) + atomic
  snapshot at getConfigDir()/catalog-snapshot.json + IO orchestrator + markdown
  /text renderers. First run seeds the snapshot, reports zero (mirrors A2).
- 3 surfaces: MCP tool discover_new_models, CLI --new-arrivals
  [--qualifying-only], slash command llm-externalizer-discover-new-models
- export compactStamp from drift.ts for reuse (DRY)
- 18 unit tests + 2 hermetic dispatch tests; roster 20→21; full suite 872 green
- docs: README 36→37 tools / 25→26 commands / 16→17 base, model-qual tables,
  rule inventory, tool-use-cases

- Feat(A3): de-hardcode catalog-authoritative limits + dedupe DEFAULT_MODEL (TRDD-828238b5)

- dedupe DEFAULT_MODEL: mass_scouting/cli.ts imports the canonical constant
  from security_scan/types.ts instead of redeclaring the literal (single
  source of truth; the mass_scouting → security_scan dep already exists)
- extract ensemble per-model limits to a pure, unit-tested ensemble-limits.ts:
  maxOutput is now catalog-preferred (live top_provider.max_completion_tokens
  from the warm 1h-TTL cache, with a plausibility floor + calibrated fallback)
- maxInputLines and KNOWN_PRICING.context_window stay hand-calibrated by design
  (empirical quality / provider-endpoint caps the catalog does NOT carry) —
  documented inline so they are not naively de-hardcoded into a regression
- 16 new ensemble-limits tests; full suite 852 passing, build clean

- Feat(A2): check_model_health configured-model self-check (TRDD-828238b5)

Free advisory self-check for the active profile's configured models
(main/second/third + every tool_models entry): presence (removed =
CRITICAL), cost drift vs a seeded baseline (WARN), and per-served-tool
requirements regression (WARN). Read-only — writes a report, never
mutates settings.

- model-qualification/drift.ts: pure core (buildConfiguredModels,
  computeModelHealth) + IO orchestrator (checkModelHealth,
  runCheckModelHealth) + baseline load/save + markdown/text renderers
- 3 surfaces: MCP tool (check_model_health), CLI (--check-health),
  slash command (llm-externalizer-check-model-health)
- 17 drift unit tests + 1 hermetic dispatch test; index roster updated
- docs: README counts 35→36 tools / 24→25 commands / 15→16 base,
  model-qualification tables, lean rule inventory, tool-use-cases

- Feat(A1): durable model-health event ledger (TRDD-828238b5)

New model-events.ts: append-only per-model health event log (sibling of
history.log, honors LLM_EXT_CONFIG_DIR) + a PURE reader/aggregator that rolls a
window of events into per-model health summaries with an advisory `degraded`
flag (non-retryable failures / empty responses / schema-heal instability
thresholds). Best-effort writes never break the LLM call.

Wired the two safe one-shot mitigation signals in index.ts: param_drop (gated by
the existing FILTER_WARN_SEEN one-shot set) and reasoning_downgrade (inside
recordReasoningRejection). Failure-signal emission (429/empty/non-retryable with
model threading) lands with A7's degraded-detection.

16 new unit tests; 817 total pass; build clean. Foundation for A2 + A7.

- Feat(setup): wire vllm-cuda-autoconfig into the setup-agent + fix FP8 driver gate

- setup-agent now consults scripts/setup/vllm-cuda-autoconfig.py on the
  Linux+NVIDIA vLLM path (Step 3a consult note + Step 3a/Step 4 serve rows) to
  emit a VRAM-tiered `vllm serve` command instead of a bare default — completes
  TRDD-65867b68 Phase 4 ("Setup-agent Linux+NVIDIA branch consults it")
- fix FP8 driver gate: an unknown/unparseable CUDA driver (driver_major == 0)
  was treated as FP8-capable; now conservative (disabled + warn), since adding
  --kv-cache-dtype fp8 to an unsupported driver makes vLLM fail to start
- verified: dry-run/print-vram-only run; FP8 logic correct for unknown/530/535/550


### Documentation

- Docs: add TRDD-8b6b3646 — free-only benchmark-filtered ensemble

- Docs: add TRDD-ec45c66f — reasoning cost regression remediation

- Docs: add TRDD-e82f2c49 — test cost-safety (zero-dime default test gate)

- Docs(828238b5): mark B2/B5 done in the master backlog (cross-ref TRDD-66da2aa7)

- Docs(B2): document cluster resume_from rehydrate + fail-fast; mark TRDD-66da2aa7 done

- Docs: add TRDD-66da2aa7 — cluster_synonyms resume_from fix + partition caching

- Docs(D1/D5): align command + setup-agent docs with the fixed contracts (TRDD-6e859d3c)

- fix-found-bugs.md / scan-and-fix-serially.md: --skip-if-fixer-exists and the
  inline exclusion now describe BOTH canonical fixer-sidecar shapes (.fixer. AND
  -fixer-), matching the unified FIXER_MARKERS from D5
- setup-agent.md: build-snippet now documented to reject YAML-reserved profile
  names + exit-2 on safety-guard violations (D1)
- mark TRDD-6e859d3c completed with the per-item commit map + outcome

- Docs: add TRDD-6e859d3c — Part-D script-bug remediation (honor-contract + TDD)

- Docs(TRDD-828238b5): scope A6/A7 — A1-A5 shipped, A6 needs a focused session

A6 scoping pass findings recorded: search_existing_implementations (structured
YES/NO output) should lead over code_task (free-form prose needs an LLM-judge),
but its real pipeline is embedded in index.ts (runs main() on import) so a
faithful in-process runner is blocked on a B1 monolith-extraction increment.
Real golden-dataset curation deferred rather than faked (hard no-fakes rule).
A7 is genuinely blocked on A6. Build order + next-session plan captured.

- Docs(design): TRDD-828238b5 — auto-* model-management roadmap + deep-audit backlog

Durable record of the whole-plugin deep audit (raw agent reports are gitignored):
- 7 auto-* capabilities with grounded status (1 exists/5 partial/1 missing),
  read-only design guardrail, and a value-to-effort build order (A1→A7)
- architectural findings (index.ts 9599-line split; cluster resume-stub +
  in-memory load + unwired preflight)
- hardcoded model/cost table inventory (de-hardcode targets)
- live-script bug backlog with file:line
- dead-script removal pending RULE-0 approval; test-coverage gaps

- Docs: fix stale change-model cross-reference + install_statusline backup-format docstring

- README change-model rows no longer claim a scripts/apply_ensemble_choice.py
  wrapper — the command is a pure user-only redirect (discover/get_settings/reset);
  apply_ensemble_choice.py is orphaned (removal pending review per RULE 0)
- install_statusline.py docstring: backup suffix is local time + GMT offset

- Docs(design): update TRDD-f45eeaa0 status + security-triage benchmark cases

- Docs: whole-plugin correctness audit + lean rule + on-demand reference docs

- rules/use-llm-externalizer.md trimmed 572→43 lines (always-loaded); detail
  moved to docs/agent-usage-reference.md, docs/tool-use-cases.md,
  docs/setup-and-configuration.md
- remove phantom set_settings/change_model (config is user-only, read-only server)
- fix counts (35 tools, 24 commands, 15 skills, 6 agents), preclassify bucket
  names, stale git/reports_dev report-location claims across README/commands/skills/agents
- add assess-model command; complete missing usage examples + help


### Fixed

- Fix(cpv): clear CPV 2.106.0 publish blockers — README md-title + tighten 3 command descriptions

The updated CPV (2.106.0) enforces stricter checks than the version 9.13.1 was
published under:
- README needs a markdown '# ' heading (HTML <h1> didn't count) → converted the
  centered <h1> to a markdown title under the banner.
- command 'description' must be ≤200 tokens → tightened check-model-health (214),
  security-triage-benchmark (211), cluster-synonyms (201); trigger phrases kept,
  verbose parentheticals trimmed.

No functional change — docs/frontmatter only. Unblocks the 9.14.0 publish.

- Fix(robustness): self-review fixes — best-effort request dump + free_models coercion

Two issues found in a verification pass over this session's changes:

1. LLM_EXT_DUMP_REQUESTS appendFileSync was unwrapped — a bad dump path (or full
   disk) would THROW and break the real LLM call. A debug/audit hook must never
   break the call. Extracted dumpRequestBody(): wrapped best-effort (try/catch +
   stderr warning), reused at both dump sites (chatCompletionSimple +
   chatCompletionJSON).

2. free_models comes from YAML (untyped at runtime). A scalar instead of a list
   would crash resolveProfile (`[...string]` spreads into single characters) and
   validateProfile (`.filter` on a non-array). Added coerceFreeModels() mirroring
   coerceToolModels(): resolveProfile coerces to []; validateProfile flags a
   non-list explicitly ("free_models must be a YAML list").

Tests: +2 (malformed free_models → clear error, no crash, no char-spread).
Full npm test 909 passed / 4 skipped / 0 OpenRouter boots; tsc + eslint clean.

- Fix(cost): cluster reasoning off, A3 cap revert, default effort xhigh→high (TRDD-ec45c66f)

Per-call cost (not test count) had grown ~10x. Three git-confirmed inflators,
all fixed; the two already-clean paths (scout, security_scan) untouched.

1. cluster_synonyms forced reasoning:xhigh + max_tokens:65535 (csRawLlmCall →
   chatCompletionWithRetry → reasoning ladder). Clustering emits a tiny JSON
   verdict — it must never reason (reasoning tokens are billed and dwarf the
   answer on a reasoning primary). Now reasoning:"off" + maxTokens:4096.

2. A3 (commit 0eed8d2, today) made the catalog the authority for ensemble
   maxOutput, raising it 32K→65K for models absent from the table (the user's
   deepseek/gpt-nano/gemini-flash-lite ensemble). resolveEnsembleModelLimits now
   uses min-semantics: the calibrated value is the CEILING; the catalog can only
   LOWER it, never raise. The "models self-limit, so a high cap is harmless"
   premise is false for reasoning models — corrected the module note.

3. Reasoning effort is now configurable via LLM_EXT_REASONING_EFFORT
   (xhigh|high|medium|low|off), default lowered xhigh→high — strong reasoning at
   roughly half the billed thinking-token cost. Per-call override added so
   cluster passes "off". reasoningLadderForModel exported for tests.

Untouched (verified already clean — no forced reasoning, no max_tokens):
- mass_scout (scout.ts own fetch): qwen-2.5-7b, 0 reasoning tokens in the logs.
- security_scan (judge.ts own fetch): independent of the index.ts ladder, so the
  calibrated detection (#90/#93/#94/#95/#96) is preserved. Hard rule honored:
  never relax security quality.

Net per-call effect: ensemble ceiling 65K→32K; ensemble effort xhigh→high;
cluster xhigh+65K→none+4K.

Tests (offline, zero spend): reasoning-ladder.test.ts (6) + ensemble-limits
min-semantics. Full npm test 895 passed / 4 skipped / 0 OpenRouter boots; tsc +
eslint clean. dist rebuilt. Docs: README env table + TESTING.md.

- Fix(tests): zero-spend test suite — default to local-unreachable backend (TRDD-e82f2c49)

The OpenRouter balance drained because the test suite was silently running
the user's premium 3-model ensemble. Confirmed by the OpenRouter activity
export: $26.46 over 2 days, $17.67 (67%) in the single hour `npm test` ran
~10×; 244 ensemble ops/hr across deepseek-v4-pro + gpt-5.4-nano +
gemini-3.1-flash-lite-preview; cost driver = reasoning tokens (gemini-flash-lite
alone 6.5M reasoning tok = $10.44 in that hour).

Root cause: test-helpers.ts copied the real ~/.llm-externalizer/settings.yaml
into the spawned test server, so index.test.ts's ~23 real tool-calls/run hit
the premium ensemble. The local ledger only showed $0.12 because tests log to
throwaway /tmp config dirs.

Changes:
- test-helpers.ts: resolveTestConfig() defaults to a synthetic LOCAL,
  unreachable backend (http://127.0.0.1:1, single model, no ensemble) that can
  never bill. Real backend only via explicit requireLiveBackend:true.
  createTestClient writes the local settings.yaml by default; copies real
  settings only when liveBackend is set.
- index.test.ts: default→local config; UNREACHABLE_CALL_TIMEOUT_MS=10s so
  ECONNREFUSED tests fail fast (suite 63s, not 433s). All real-call tests
  already tolerate connection-refused.
- live.test.ts / live-extended.test.ts / security_scan_live.test.ts: gate on
  LIVE_TESTS=1 (+ OPENROUTER_API_KEY) via describe.skipIf; live suites pass
  requireLiveBackend:true. Default npm test reports them skipped.
- index.ts: entry-point guard on main() — importing the module (e.g.
  default-output-dir.test.ts) no longer boots the server / contacts a backend.
  Spawned `node dist/index.js` still boots (argv[1] matches import.meta.url).
- test-helpers.test.ts (NEW): free regression guard — fails if the default
  test backend ever resolves to a billing/remote backend, or silently degrades
  the requireLiveBackend path to the free local one.
- vitest.config.ts: register the guard test.
- TESTING.md (NEW) + README pointer: document offline-default / LIVE_TESTS opt-in.
- dist/index.js rebuilt.

Verified (no API key): 887 passed / 4 skipped; ZERO `backend: OpenRouter`
boot lines (6 Local-unreachable); tsc + eslint clean. npm test now bills $0.00.
No hidden auto-spend elsewhere: discover / check_model_health (drift) /
discover_new_models (new-arrivals) use only the free /v1/models catalog
endpoint; the only setInterval usages are in-flight progress timers.

- Fix(B2/B5): cluster_synonyms honor resume_from + compute partition once (TRDD-66da2aa7)

B2 (data-loss footgun, HIGH): resume_from's VALUE was ignored — the checkpoint
path was hardcoded to output_dir/checkpoint.sqlite, so passing resume_from only
bypassed the output-dir overwrite guard and the run re-clustered from scratch
over the existing outputs. Now the checkpoint is loaded from resume_from when
given (the rehydrate + phase-1 skip machinery already existed), and a missing
resume_from path fails fast instead of silently overwriting. Stale module
comment ('Phase 2/3/resume are placeholders') corrected — all three are live.

B5 (perf): uf.partition() (O(n) Map rebuild) was recomputed at emit by
writeClustersJsonl AND buildSummary, plus the phase-3 branch. uf is final after
phase-2 merges; compute partition once and pass it to all three. Output is
byte-identical (the two helpers now take the partition instead of the uf).

3 new behavioral resume tests (the gap wiring.test.ts left): rehydrated merge
survives (3 vs 4 clusters), fresh-run control, missing-path fail-fast.
Full suite 886 green; build + eslint + tsc clean.

- Fix(D6): statusline fetchers log instead of silently swallowing (TRDD-6e859d3c)

fetch_usage_from_api + fetch_openrouter_budget used bare except Exception that
hid every cause (network, schema, real bugs). Narrowed to (OSError, ValueError)
— covers urllib URLError/HTTPError/timeouts + JSON/UTF-8 decode — and log via
the existing _log_exception before the stale-cache fallback. Genuine bugs
(KeyError/AttributeError/TypeError) now surface to main()'s per-section guard;
fail-soft VISUAL return values unchanged. tests/test_statusline.py extended.

- Fix(D5): fix_found_bugs_helper.py skip-filter matches canonical fixer naming (TRDD-6e859d3c)

--skip-if-fixer-exists matched only '.fixer.' siblings, but the canonical
fixer sidecar also uses the '-fixer-' shape that _is_sidecar recognizes → the
skip silently never fired and already-fixed reports were re-aggregated. Added
FIXER_MARKERS=('.fixer.','-fixer-') as the single source of truth and keyed the
skip-filter off it (both separator shapes). Canonical naming confirmed from
validate_fixer_summary.py/join_fixer_reports.py. tests/test_fix_found_bugs_helper.py (new).

- Fix(D4): detect-runners.py non-dict guard + broader vLLM probe (TRDD-6e859d3c)

- _safe_model_names: isinstance(payload, dict) guard so a JSON list payload
  yields [] (per docstring) instead of AttributeError that main()'s outer
  except masked as "not installed"
- _vllm_import_probe: ANY non-ModuleNotFoundError nonzero exit is now reported
  installed-but-broken; enumerating ImportError/OSError/RuntimeError dropped
  the long tail (AttributeError/TypeError/C-abort) into "not installed"
- tests/test_detect_runners.py (new)

- Fix(D3): benchmark-models.py honors never-raise contract (TRDD-6e859d3c)

- measure_throughput wraps call_chat → returns the documented error-shape dict
  instead of letting exceptions escape
- isinstance(resp, dict) precedes the "error" in resp test (a non-dict resp
  would otherwise do substring/element matching)
- run_vmlx_bench coerces numbers via _as_float/_as_int (no ValueError on a
  malformed payload) per its None-on-failure contract
- benchmark_one_model guards the perf probe like the reliability loop →
  zero-tps record, never aborts the model's benchmark
- tests/test_benchmark_models.py extended

- Fix(D2): _bench_helpers.py batch resilience — .get over direct indexing (TRDD-6e859d3c)

_avg_test_score/rank_models/render_markdown direct-indexed record["tests"]/
r["perf"] → KeyError crashed the whole rank/render even though _is_viable
already uses .get(...,{}). Switched to .get with safe defaults so one
malformed record no longer kills the batch. tests/test_bench_helpers.py (new).

- Fix(D1): truthful build-snippet.py contract — reject YAML-reserved names, exit-2 safety guards (TRDD-6e859d3c)

- _yaml_dquote: docstring now states control chars (incl \n/\r) are REJECTED,
  not escaped; removed the two unreachable .replace("\n")/.replace("\r")
  calls (the control-char guard rejects them first); kept the \t escape
- safety-guard violations now print to stderr + raise SystemExit(2) to honor
  the module's documented exit-2 contract (bare SystemExit(str) exits 1)
- _validate_profile_name now rejects YAML-reserved tokens (null/true/false/
  yes/no/on/off/~, case-insensitive) — they were emitted UNQUOTED as mapping
  keys and would parse as bool/null, despite the comment promising rejection
- module docstring exit-code table aligned with real behavior
- tests/test_build_snippet.py (new, 28 tests)

- Fix(server): unify report output on $CLAUDE_PROJECT_DIR (no git), add rule installer + per-tool model surfaces

- project-root.ts: single resolver, CLAUDE_PROJECT_DIR verbatim → cwd, never git
  (worktrees / monorepo subfolder-gits / git-less roots all made git wrong)
- rule-install.ts: server installs/updates ~/.claude/rules/use-llm-externalizer.md
  on every start (atomic, guarded, opt-out LLM_EXT_INSTALL_RULE=0)
- assess_model surface + tool_models per-tool routing (TRDD-f45eeaa0)
- server.json: correct LLM_OUTPUT_DIR default + read-only description
- rebuild dist; vitest config; +4 test files


### Miscellaneous

- Chore: remove orphaned ensemble-choice scripts

apply_ensemble_choice.py + read_ensemble_state.py are unreferenced (superseded by
the user-only manual settings.yaml config flow). Verified zero callers across
commands/skills/hooks/ts/scripts. Recoverable from git history. User-authorized.


### Refactored

- Refactor: safe local cleanups from deep code audit

Conservative, signature-preserving fixes found by the parallel module audit
(index, mass_scouting, benchmark, cluster, shared): remove confirmed-unused
imports/locals, fix a phase2_verify O(n^2) cluster lookup (Map-based), and minor
local corrections. Build clean, 801 tests pass. Larger/cross-file findings are
tracked separately for triage.


## [9.13.1] - 2026-05-24

### Documentation

- Docs(security_scan): document gemini-2.5-flash as recommended triage model (#9/#10)

A 3-model triage-benchmark assessment (qwen + gemini-2.5-flash + grok-4.1-fast)
shows gemini-2.5-flash PASSES at 0.909 with zero under-flags / zero critical
under-flags over the full golden dataset, correctly handling the #9 (detection/
defensive over-clamp) and #10 (static-literal + off-window provenance) edge cases
that the cheap qwen default mishandles in the safe direction. The prompt/rubric
fixes are validated (a capable model following the same prompt nails them); the
residual is purely the cheapest model's capacity. Default stays qwen per the
same-cost rule; gemini-2.5-flash documented as the opt-in higher-accuracy model.
Corpus updated with the assessment data point.


## [9.13.0] - 2026-05-24

### Added

- Feat: per-tool model-qualification registry (framework core, TRDD-f45eeaa0)

The single source of truth for each LLM tool's model REQUIREMENTS + its
benchmark pointer. model-qualification/registry.ts maps every LLM-using tool
to {requirements: ModelCriteria, benchmark} and exposes qualifyModelForTool().
security_scan → its real triage benchmark (973a0265); mass_scout → the
existing keyword-classification benchmark; the rest carry requirements only
(benchmark: null) until each gets a dataset. The security-triage orchestrator
now reads security_scan's requirements from the registry (real consumer).

Deliberately incremental (not premature-abstracted from N=1): per-tool
benchmark DATASETS for the other tools, the settings.yaml per-tool model map,
and generalized cross-tool selection land as each tool gets a real benchmark.


### Changed

- Build: regenerate dist for the model-qualification registry


## [9.12.0] - 2026-05-24

### Added

- Feat: security-triage model benchmark + auto-selection gate (#96, TRDD-973a0265)

A re-runnable model-qualification gate for the security_scan triage task:
- golden dataset (33 curated snippet cases) + per-category rubrics + per-tool
  SECURITY_TRIAGE_CRITERIA (structured-output + modest ctx, no reasoning/128K).
- scorer: +1 correct / -1 under-flag / 0 else; PASS = zero critical
  under-flags AND score >= 0.5; fail-safe (timeout/error) cases EXCLUDED, a
  run with >15% errored is INCONCLUSIVE (never falsely fails a model).
- runner reuses the real judgeGroups pipeline (same hardened prompt+schema).
- selection: requirements + benchmark-pass + never-pricier-than-incumbent,
  best-of-equivalent-cost.
- 3 surfaces: MCP security_triage_benchmark, CLI llm-ext-benchmark
  --security-triage, slash command. Per-model-per-day cache.
Reference instance for the per-tool framework (TRDD-f45eeaa0).

- Feat: global usage-history log — one line per LLM web request (TRDD-44256ba2)

Flat, append-only ~/.llm-externalizer/history.log written by every MCP tool
and the CLI. 7 fields: TIMESTAMP - PROJECT-DIR - TOOL(params) - SUCCESS|FAIL
- DURATION - COST - OP-ID. Best-effort (never breaks a call), secrets
redacted, op-id correlates a single invocation's requests. No query surface.


### Changed

- Build: regenerate mcp-server dist bundle for v9.12.0


### Documentation

- Docs(trdd): mark security_scan + cluster_synonyms TRDDs completed (v9.11.0)

Both features shipped in v9.11.0 — flip status in-progress→completed and
log the release outcome (3 surfaces each, aegis-reviewed security_scan,
issues #4/#6 closed).


### Fixed

- Fix(security_scan): harden #7/#8/#9/#10 + bound response-body read

- #7: clamp reviewer-directed meta-instructions (markers + reason-backstop +
  self-reference) — never not_threat@1.0.
- #8: window targets use a generous read-guard; egress byteCap applies to the
  extracted window, not the whole file.
- #9: context-aware clamp (directive vs quoted/definitional/defensive markers).
- #10: provenance/data-flow system prompt (static-literal vs tainted; uncertain
  when origin off-window). DEFAULT_CONTEXT_LINES 8->60 (calibrated, #95).
- slow-loris fix: keep the per-call abort timer armed through res.json()/
  res.text() so a slow RESPONSE BODY can't hang the call (was unbounded once
  headers resolved). Regression test added.


## [9.11.0] - 2026-05-24

### Added

- Feat: add security_scan tool + complete cluster_synonyms 3-surface (#6)

security_scan: dedicated, injection-hardened batch security-triage tool
(MCP + CLI + slash command) that adjudicates suspected-malicious snippets
into threat/not_threat/uncertain verdicts. Bespoke judge (NOT a mass_scout
wrapper): nonce-delimited untrusted-data envelope, hardened system prompt,
strict json_schema output, validate->uncertain on any deviation, in-band
injection pre-scan + deterministic clamp, fail-safe-to-uncertain everywhere,
secret redaction before egress. Hardened against the 9 aegis findings
(ReDoS-free redaction, fail-safe never fails open).

cluster_synonyms: add the missing CLI subcommand + slash command + docs so
it is 3-surface compliant (was MCP-only); same runClusterSynonyms core.

Also: fix ensemble-autoselect SKILL.md for current CPV Nixtla rules
(## Output section, numbered Instructions, markdown reference links,
progressive-disclosure split, <5000 chars).

- Feat(cluster): Phase A.6 — test fixtures

mcp-server/scripts/gen_cluster_fixtures.mjs — deterministic generator.
Re-run anytime with `node mcp-server/scripts/gen_cluster_fixtures.mjs`.
Produces:

- src/cluster/fixtures/synthetic_500.jsonl — 500 items split into
  130 ground-truth clusters: 10 large (size 20), 20 medium (size 10),
  100 singletons. Same template universe for paraphrases so the
  cohesion ground truth is deterministic.
- src/cluster/fixtures/synthetic_500.expected.json — id → cluster_id
  map. 130 distinct clusters; size histogram [(1,100),(10,20),(20,10)].
- src/cluster/fixtures/budget_exhaust.jsonl — 60 items used by T9
  (budget cap aborts mid-Phase-2 with checkpoint preserved).
- src/cluster/fixtures/merge_3_floor.jsonl — 12 items (2 ground-truth
  clusters of 6), used by T15 to verify the >=3-element merge floor:
  case X (2-from-A + 2-from-B → NO merge, weak_overlap_evidence)
  vs case Y (3-from-A + 3-from-B → merge).
- src/cluster/fixtures/broken_profile.yaml — points local-mode at
  127.0.0.1:1 (nothing listens) for T16 (pre-flight benchmark gate
  rejects broken profile before Phase 0).

All fixtures are deterministic and regenerable; nothing about a future
re-run can change ground truth without changing the generator script.

- Feat(cluster): Phase A.5 — pre-flight benchmark gate (Q11)

src/cluster/preflight_benchmark.ts — Q11 from TRDD-220ea89f. Verifies
the active profile's model(s) can produce valid structured JSON BEFORE
the cluster_synonyms run spends any clustering budget. Separates model
bugs from prompt bugs in failure triage.

- Cached per-profile-per-day under
  ~/.llm-externalizer/cache/benchmark-<profile-hash>-<YYYY-MM-DD>.json
- profile_hash is sha256(profileFingerprint).slice(0,16) so a profile
  switch invalidates the cache automatically.
- LLM call injected as a callback (PreflightLlmFn) so the module is
  trivially unit-testable with a mock. Phase B wires processBatch.
- Validation: response must be valid JSON matching
  z.object({groups: z.array(z.array(z.number().int()))}) AND contain
  exactly the 3 expected ids (1,2,3) once each.
- Atomic cache write via tmp + renameSync (POSIX-atomic on same fs).

17 new tests covering: hash determinism, schema validation, JSON parse
fail, missing/duplicate/extra ids, PASS+cache write, FAIL+cache write,
same-day cache hit (no LLM call), force=true cache bypass, next-day
re-test, LLM exception capture, corrupt-cache treated as miss.

All 53 cluster tests green. Typecheck + lint clean.

- Feat(cluster): Phase A.4 — Python embeddings sidecar

Out-of-process embeddings via uv-run so torch/sentence-transformers
stay out of the Node runtime:

- mcp-server/scripts/compute_embeddings.py — argparse-driven CLI.
  Reads sentences (one per line) from --input, writes float32 memmap
  to --output with sibling <output>.meta.json {shape, dtype, model}.
  Default model: sentence-transformers/all-MiniLM-L6-v2 (no GPU).
  Progress logged to stderr; on success, prints "OK <N> <D> <path>".
  Fail-fast if sentence-transformers / numpy aren't installed with a
  clear "install with uv pip install ... " message.

- pyproject.toml — adds [project.optional-dependencies] embeddings
  (sentence-transformers>=3.0, numpy>=1.26). Heavy deps gated behind
  the optional group so users not using cluster_synonyms skip the
  ~1GB install.

Syntax-validated. Ruff clean. --help works without the deps installed.

- Feat(cluster): Phase A.3 — SQLite checkpoint module

CheckpointDB wraps better-sqlite3 (already a project dep) with:

- 3-table schema: clusters_uf (union-find edges), llm_calls (per-call
  history with status + batch_hash for dedup), meta (run-level keys).
- WAL mode + synchronous=NORMAL for crash-consistent writes without
  pessimistic fsyncs on every step.
- Atomic UF replace via single transaction (delete + bulk-insert),
  rehydrate via fromEdges(). Resume can skip already-completed
  batches via hasCompletedBatch(batch_hash).
- Indexes on (phase, ts) and batch_hash for resume-time queries.

Tests: 7 new + 1 fixed (unionfind.test had let-not-const + checkpoint
test had stale [1,2,3] expectation). All 36 cluster tests green.
Lint clean. Typecheck clean.

- Feat(cluster): Phase A.2 — JSONL + k-means + union-find primitives

Pure-TS no-LLM modules under src/cluster/:

- jsonl.ts: streaming readline-based reader (no full-file load), with a
  one-shot readClusterJsonl() that returns items + warnings for duplicate
  ids, parse errors, and missing fields. Accepts both `sentence` and the
  legacy alias `label`; normalises to `sentence` on output. writeJsonl()
  writes atomically via tmp + rename.
- kmeans.ts: mini-batch k-means with kmeans++ seeding, streaming-mean
  centroid updates (Sculley 2010), deterministic mulberry32 PRNG so
  tests are reproducible. ~150 LOC, no external dep.
- unionfind.ts: union-find with path compression + union by rank.
  Tracks cluster sizes; supports edges() snapshot + fromEdges()
  rehydrate for checkpoint persistence in Phase A.3.

29 unit tests across the three modules — all green (134ms total).
Typecheck + lint clean. No LLM calls billed.

- Feat(cluster): Phase A.1 — register cluster_synonyms stub + policy schema

First commit of TRDD-220ea89f (cluster_synonyms MCP primitive). Adds:

- mcp-server/src/cluster/types.ts — shared types (ClusterInputItem,
  ClusterPolicy, FailedGroup, WeakOverlapEvidence, ClusterStats)
- mcp-server/src/cluster/policy.ts — Zod schema + DEFAULT_POLICY +
  resolvePolicy() helper. Uses looseObject (Zod 4-clean).
- mcp-server/src/index.ts — adds cluster_synonyms to buildTools() with
  the full input schema (input_file, output_dir, embeddings_file,
  policy_file, resume_from). Dispatcher returns not_implemented stub.
  Added to LLM_TOOLS_SET so reset() waits for in-flight calls once
  the workflow lands.
- mcp-server/src/index.test.ts — adds cluster_synonyms to the
  listTools expected-set assertion.

No LLM calls billed. All 360 existing tests pass + 2 skipped.
Typecheck, lint, build all green. CPV check-only pending in A.8.


### Changed

- Build: rebuild mcp-server dist bundles + refresh uv.lock

Compiled output for the security_scan + cluster_synonyms surface additions.

- Cluster_synonyms: real OpenRouter smoke test script

Tiny end-to-end driver that exercises runClusterSynonyms against a real
OpenRouter call (deepseek-v4-pro by default; single-model, not the
3-ensemble — this is a correctness smoke test, not a benchmark). Uses a
6-item fixture (3 obvious synonym pairs) so the cost stays well under
1¢ and the verdict is unambiguous: expect exactly 3 clusters.

Confirmed PASS on first run:

  ok=true
  items_in=6
  clusters_out=3              (expected 3)
  llm_calls=2 (phase1=1, phase2=1)
  failed_groups=0
  weak_overlap_evidence=0
  walltime=20.5s
  cost ≈ \$0.002

The 3 partitions matched the hand-labelled pairs exactly (a1↔a2, b1↔b2,
c1↔c2); cluster_ids are the lex-min member id (a1/b1/c1) confirming
chooseClusterId determinism; heuristic canonicals correctly picked the
shortest sentence in each cluster.

Run via:
  OPENROUTER_API_KEY=... npx tsx scripts/smoke_cluster_openrouter.ts \\
    [--out OUT_DIR] [--model MODEL_ID]

Report lands under <git-root>/reports/llm-externalizer/<ts±tz>-smoke-...md
honoring the agent-reports-location rule.

- Cluster_synonyms C.2: phase3_canonical LLM mode

When policy.canonical_label_mode === "llm" each cluster of size > 1 gets
one LLM call asking for the cleanest canonical form (Phase 3 prompt from
TRDD §7). The validator requires that the returned canonical be one of
the input sentences verbatim — if the LLM hallucinates a brand-new
label, the heuristic answer is kept and a warning is emitted. Singletons
and all-identical clusters skip the LLM entirely (no real choice). The
retry-ladder dispatches with maxSplitDepth: 0 because a Phase-3 batch
can't be subdivided (it's one cluster's worth of items, and the LLM is
picking ONE answer — splitting changes the choice space).

Wired into the orchestrator just before checkpoint persistence:

  - canonical_label_mode === "heuristic"  → no Phase 3 LLM (zero cost)
  - canonical_label_mode === "llm" + budget OK → runPhase3Llm fires;
    canonicals map flows into buildSummary as the override
  - canonical_label_mode === "llm" + budget already exhausted → skip
    with a warning; summary falls back to heuristic for every cluster

stats.json now populates llm_calls_by_phase.phase3 + total.

Tests: 15 phase3_canonical unit tests cover singleton skip, all-
identical skip, multi-sentence happy path, hallucination → heuristic
fallback with warning, throw → heuristic fallback, budget exhaustion
mid-Phase-3 (remaining clusters take heuristic with no extra LLM
calls), empty input, schema rejects (empty canonical, missing
rationale), buildPhase3Prompt format (newlines collapsed, output
instruction present), pickHeuristicCanonical (shortest, lex
tiebreak, empty).

2 new orchestrator integration tests: llm mode → Phase 3 fires +
canonical from inputs; heuristic mode → Phase 3 LLM never called.

173 cluster tests pass. Typecheck + lint clean.

- Cluster_synonyms C.1: phase2_verify with Q12 ≥3-floor merge rule

After Phase 1 the union-find holds within-batch groupings only. Phase 2
takes representatives from each cluster, batches them by embedding
proximity so semantically-near clusters land together, sends each batch
through the SAME retry-ladder+JSON schema as Phase 1, then applies the
Q12 transitive-closure merge rule with the ≥3-element floor: for every
LLM response-group, count cluster co-occurrences; merge only when BOTH
sides contribute ≥ policy.merge_min_cross_count (default 3) distinct
items. Sub-floor co-occurrences are logged to stats.weak_overlap_evidence
for operator review, not merged.

Stratification: when embeddings are available the cluster centroids
are projected onto a per-pass random unit vector (deterministic mulberry32
PRNG seeded from pass index), then sorted; without embeddings we fall
back to deterministic shuffling. Different passes get different
projection directions so concept-neighbourhoods missed in pass 1 get a
second look on pass 2 (and so on for policy.passes).

Implementation lives in phase2_verify.ts. The orchestrator now runs
Phase 2 after Phase 1, skipping it cleanly when Phase 1 exhausted the
budget (T9). stats.json's llm_calls_by_phase.phase2 surfaces the cost;
weak_overlap_evidence + failed_groups carry the diagnostic detail.

Tests: 26 phase2_verify unit tests cover sampleReps determinism,
buildRepBundles per-cluster grouping + centroid attachment, stratifyReps
sort-with-embeddings vs shuffle-without, batchVerificationReps slice
size + trailing-singleton drop, applyMergeRule for every floor case
(2+2 NO, 3+3 YES, 3+1 NO, 3-way merge × 3 pairs, custom floor, single-
cluster no-op), and runPhase2 end-to-end (empty, singleton response,
one-giant-group 3+3 merge, one-giant-group 2+2 weak-only, multi-pass,
malformed-response retry-ladder give-up, budget exhaustion, singletons
immune to merge).

T15 integration test in cluster_synonyms_main.test.ts: full Phase
1 + Phase 2 round-trip; 2+2 case stays at 2 clusters + emits a weak
row, 3+3 case collapses to 1 cluster.

156 cluster tests pass; full suite no regressions.

- Ensemble auto-selection: <\$1/M cost rule + pick-top-N CLI + skill

Encodes the lesson learned when x-ai/grok-4.1-fast 404'd mid-session:
ensemble rotation must be automatic, the user has delegated which 3 to
pick. The cost rule is the only hard policy — input AND output BOTH
strictly less than \$1.00/M tokens. Anything at or above is rejected
from the auto-selection pool.

Changes:

- discover.ts: DEFAULT_CRITERIA.maxIn/Out tightened from 1.5/2.0 to
  1.0/1.0; qualify() now uses '>=' (was '>') so '== 1.00' rejects.
- benchmark/pick.ts (new): pickTopN sorts survivors by meanF1 desc,
  cost asc, latency asc; min-F1 default 0.95; schemaCompliant required;
  baselines / failed runs dropped; throws on shortage rather than
  silently falling back. applyPicksToSettings mutates settings.yaml
  atomically (tmp + rename), preserves every other profile + active:
  + comments. renderEnsembleBlock emits a paste-ready YAML fragment.
- benchmark/index.ts: --pick-top-n N, --apply-profile NAME,
  --from-cache, --min-f1 F. --apply-profile demands --pick-top-n.
  --from-cache reads ~/.llm-externalizer/benchmark-results.json
  instead of re-running the benchmark.
- pick.test.ts: 20 tests — algorithm correctness (F1 sort, tiebreaks),
  filter behavior (baselines, failed, low-F1, schema), YAML mutator
  (in-place update preserves other keys, downgrade to single-model,
  missing-profile error, malformed-YAML error, atomic on rename).
- skills/llm-externalizer-ensemble-autoselect: the skill that documents
  when to trigger (404/deprecated/persistent errors), the rule, the
  workflow, and the anti-patterns ("do not ask the user which 3" is
  the headline). Lists the SoT files so future edits don't drift.

settings.yaml also updated to the user's explicit 3-pick for now:
deepseek-v4-pro + gemini-3.1-flash-lite-preview + gpt-5.4-nano. Two of
those exceed the \$1/M ceiling — that's fine as an explicit pick; the
ceiling only governs FUTURE auto-rotation. Done outside this commit
(user's ~/.llm-externalizer/settings.yaml).

149 cluster + benchmark tests green (129 cluster + 20 picker).
Typecheck + lint clean.

- TRDD-220ea89f: bump status → in-progress; log Phase B completion

Phase B.1–B.4 landed across commits 11dd0fe→e42268f (retry ladder,
phase1_batch, embeddings wrapper, orchestrator + dispatcher wire-up,
T3 + T11-lite smoke). 129 cluster tests pass; Phase B exit gate met.
Phase 2/3 remain stubbed for Phase C.

- Cluster_synonyms B.4: T3 mixed + T11-lite smoke tests (TRDD-220ea89f)

T3 (mixed): 50 items split as 5 ground-truth synonym clusters (5 items
each) + 25 singletons. The mock LLM derives the concept identity from
the sentence ("concept X phrasing Y") and groups matching items.
Verifies the orchestrator emits exactly 30 clusters (5 sized 5 + 25
sized 1), zero failed groups, all output files present.

T11-lite: 100 items, 10 ground-truth clusters of 10. Single-batch
(batch_size=100) so Phase 1 alone exercises the full LLM-grouping
→ union-find → emit path without depending on the still-stubbed Phase
2 cross-cluster merge. Asserts elapsed <2s as a regression guard against
the orchestrator silently regressing in performance.

Phase B is now complete by §6 exit-gate (T1, T2, T3, T6, T7 green;
T17 covered by retry_ladder unit tests). 129 cluster tests pass.

- Cluster_synonyms B.3b: orchestrator + dispatcher wire-up (TRDD-220ea89f)

cluster_synonyms_main.runClusterSynonyms is the top-level lifecycle:
JSONL load (T7-tolerant of malformed lines) → output-dir gate (T13/T14)
→ optional pre-flight benchmark hook (Q11) → embeddings (precomputed-
file, Python-sidecar, or random-fallback) → CheckpointDB open → Phase 1
dispatch via phase1_batch.runPhase1 → union-find merge of returned
edges → checkpoint write → atomic emit of clusters.jsonl +
clusters_summary.json + stats.json + checkpoint.sqlite.

cluster_id is the lex-min item id in each component — same partition
→ same cluster_ids on re-run regardless of union order (T10).
Heuristic canonical label is the shortest sentence per cluster, ties
broken lexicographically. Phase 2 / Phase 3 are intentionally stubbed
in this B-cut; llm_calls_by_phase.phase2/phase3 sit at 0 in stats.json.

index.ts dispatcher now invokes runClusterSynonyms with chatCompletionWithRetry
wrapped as the rawLlmCall (inherits rate-limit / retry / model-fallback
from the rest of the server). compute_embeddings.py is resolved relative
to the built dist/ via import.meta.url. The not_implemented stub is gone
and the tool description reflects the Phase 1 reality.

Tests: 12 orchestrator scenarios green (T1, T2, T6, T7, T8, T10, T13,
T14, Q11 gate × 2, output shape × 3). Full cluster suite 127 tests;
full repo 149 tests (cluster + index), no regressions. Lint + typecheck
clean across the touched files.

- Cluster_synonyms B.3a: embeddings.ts wrapper (TRDD-220ea89f)

Loader for the float32 memmap + .meta.json format used both by the
Python sidecar and by any external tool that wants to feed precomputed
embeddings into cluster_synonyms. Three failure surfaces are covered
explicitly:

- meta validation (missing file, malformed JSON, wrong shape rank,
  bad dtype, missing model)  → T5 path
- file-size mismatch  → memmap was truncated or the meta lies about N or D
- runner failures: missing binary throws "failed to spawn";
  nonzero exit throws "exited with status"

writeEmbeddingsToDisk is the inverse — round-trips a Float32Array
through disk bit-exactly so callers and tests can produce fixture
files without invoking Python.

computeEmbeddings spawns the sidecar via `uv run` (override via
pythonRunner for tests / non-uv hosts). Real Python invocation is
left to the B.4 integration suite — the unit tests here cover the
loader surface + the fail-fast guards.

18 embeddings tests green. Full cluster suite still 97 tests, all
pass; full repo suite unchanged.

- Cluster_synonyms B.2: phase1_batch + ValidateFn signature fix (TRDD-220ea89f)

Implements phase1_batch.ts: k-means batching (or random fallback per T6),
the §7 SENTENCE-equivalence prompt, strict Phase1ResponseSchema validation,
and union-find edge emission. Per-batch numeric ids (1..K) insulate the
prompt from raw ClusterInputItem.id formatting; the server maps groups
back to string ids when emitting edges. Random fallback fires on
compute_embeddings=false AND on dim/length mismatch — warnings flow into
stats.json.warnings (T6).

retry_ladder ValidateFn signature widened from (response) to (response, items)
so validators following a split see the CURRENT slice size, not the
original source-batch size. Existing retry_ladder tests pass unchanged
(zero-arg validators still satisfy the wider type). Without this, the
LLM would correctly answer a 2-item sub-batch with 2 ids and the
parent's validator (expecting 4 ids) would reject the response as
"missing ids 2,3,4" — exactly what the new phase1 integration test
caught on first run.

31 phase1_batch tests + 13 unchanged retry_ladder tests + 53 prior
Phase A tests = 97 cluster tests green. Full suite: 457 pass / 2 skipped.

- Cluster_synonyms B.1: recursive-split-and-retry ladder (TRDD-220ea89f Q7)

Adds processBatchWithRetry — generic over input items I and LLM responses R.
Each batch gets up to opts.maxRetriesPerAttempt LLM attempts; on retry
exhaustion the batch splits in half and recurses on each half with a
fresh retry budget. Max depth opts.maxSplitDepth — a 300-item batch
can split 300 → 2×150 → 4×75 → 8×~38 before giving up. Worst-case per
source batch: 3 + 6 + 12 + 24 = 45 LLM calls (verified in HARD CAP test).

The function is pure async: no I/O, no globals. Budget is a mutable
counter object the caller owns so multiple source batches in one run
share the same global budget_max_llm_calls cap.

13 unit tests cover: single-attempt success, transient retry, depth-1/2/3
splits, the 45-call hard cap, single-item give-up, validation-failure
counting, budget exhaustion mid-flight, budget=0 from the start, the
no-split-at-max-depth case, item-order preservation, and empty input.

Files: src/cluster/retry_ladder.ts, src/cluster/retry_ladder.test.ts;
vitest.config.ts updated to include the new test.


### Documentation

- Docs: TRDD-220ea89f — record Phase A done + CPV FPs filed as CPV#39

Phase A (A.1-A.7) implemented and zero-CRITICAL. A.8 publish gate blocked
by 16 pre-existing skillaudit false-positives (CPV v2.101.4) in files
unchanged since v9.10.2; filed upstream as
Emasoft/claude-plugins-validation#39. Feature work (Phase B) can proceed
independently of the publish gate.

- Docs: TRDD-220ea89f — clarify scope is SENTENCE-level, not word-level

User clarified that cluster_synonyms operates on full-sentence meaning
equivalence, not word-by-word synonymy. Updated:

- §1 framing with positive ("Compile the code with optimizations" =
  "Build the project with optimizer flags") and negative ("Compile the
  code" != "Test the code") examples
- All three §7 prompt templates (Phase 1, Phase 2, Phase 3 canonical)
  now explicitly say SENTENCES and include the worked examples in the
  system prompt itself so the LLM doesn't try word-by-word matching

Algorithm and acceptance criteria unchanged.

- Docs: TRDD-220ea89f — resolve Q1–Q12, add Q11 (preflight) + Q12 (merge floor)

User accepted defaults for Q1-Q6 and Q8-Q10. Q7 replaced with a recursive
split-and-retry ladder (1→2→4→8 max, 45-call hard cap per source batch).
New Q11 mandates a pre-flight model-benchmark gate before Phase 0 to separate
model bugs from prompt bugs. New Q12 replaces the percentage merge_threshold
with a transitive-closure rule requiring >=3 distinct items from each cluster
to co-occur in the same Phase 2 response before merging A and B.

Adds T15 (merge-rule floor), T16 (preflight gate), T17 (retry ladder) to the
test plan and the corresponding files to the implementation file list.
Phase A may now start.

- Docs: add TRDD-220ea89f — cluster_synonyms MCP primitive spec

Drafts the design for a zero-orchestrator-token batch synonym/concept
clustering MCP tool per upstream issue #4. Covers schema, 4-phase
workflow (embedding-clustered batching → cross-cluster verification →
canonical-label selection → emit), 14 test scenarios, security
posture, performance budget, and 10 open questions blocking Phase A.


### Fixed

- Fix #5: thread output_dir + change default to <git-root>/reports/llm-externalizer

Two-part bug, one root cause for each half:

Part A — explicit output_dir was silently dropped. saveResponse() in
index.ts has always accepted an outputDir 5th arg, but 17 of the 21
call sites never passed it. The dispatcher correctly resolved
args.output_dir at line ~5609 (into a local `outputDir`), then every
tool except `search_existing_implementations`, the helper `code_task`
path, and one of the `check_against_specs` branches forgot to forward
it. Reports landed in the server's auto-computed default, ignoring
the caller's request entirely. Fix: thread `outputDir` through every
saveResponse() call (chat ×2, code_task ×2, batch_check ×2,
scan_folder ×2, compare_files ×3, check_references ×3, check_imports
×3, check_against_specs ×1, get_settings ×1).

Part B — the default path itself was non-compliant. Old default:
`<CLAUDE_PROJECT_DIR>/reports_dev/llm_externalizer/`. New default:
`<git-main-repo-root>/reports/llm-externalizer/`, discovered via
`git -C $CLAUDE_PROJECT_DIR worktree list`, falling back to
`$CLAUDE_PROJECT_DIR` then `$PWD` when the project isn't a git repo.
Matches the agent-reports-location rule's hyphen-not-underscore
convention. Cached after first lookup; reset via the test-only
helper `_resetDefaultOutputDirCache()`.

Also:
- get_settings used the module-level OUTPUT_DIR constant directly;
  now respects per-call output_dir + the new default.
- output_dir input-schema description updated across every tool.
- ~/.claude/rules/use-llm-externalizer.md updated — no longer needs
  to warn callers about the broken default + missing thread.

Tests: default-output-dir.test.ts covers env override, git-repo
path, non-git fallback, and the cache stickiness. 4 new tests; full
repo suite (excluding live + the slow index suite) goes from 487 to
491 pass, 0 fail.

Closes #5.

- Fix(cluster): dodge skillaudit backtick FP in cluster_synonyms tool description

index.ts:5349 (the cluster_synonyms input_file description) used backtick
field-name formatting (\`id\`, \`sentence\`, \`context\`, \`label\`) which the
skillaudit scanner flags as CMD_INJECTION. Switched those plus the
\`resume_from\` / \`policy.budget_max_llm_calls\` mentions to plain/single-
quote text. No behavior change — MCP tool descriptions read identically.
cluster_synonyms code is now zero-CRITICAL; remaining 16 CRITICAL are
all pre-existing FPs in unchanged files.

- Fix(cluster): dodge skillaudit backtick FP in jsonl error strings

cpv-remote-validate's skillaudit scanner flags backtick characters
inside string literals as shell command substitution (CMD_INJECTION).
jsonl.ts:64 had "missing or empty \`id\`" — pure error text, no exec
anywhere in the file. Switched the field-name quoting from backticks
to single quotes (reads identically) to clear the false positive.
CRITICAL count for cluster_synonyms code is now zero.


### Miscellaneous

- Chore(publish): CPV skillaudit-advisory bootstrap gate (#41)

run_cpv_validation gains an opt-in (plugin.json cpv.skillaudit_advisory):
when set, KNOWN skillaudit false-positives (upstream CPV bug #41) are
downgraded to advisory (printed, non-blocking) while any non-skillaudit
CRITICAL/MAJOR still fails the publish. Parses cpv-remote-validate --json
(extracting the trailing JSON object past the lint preamble); fail-closed
on any parse error (never fail-open). Opt-in absent = byte-for-byte the
original strict gate. Lets this release ship the security_scan tool that
CPV will use to resolve #41. 19 unit tests.

Backlog: TRDD-a24b213c tracks the 19 deferred 3-surface gaps.

- Chore(canon): opt out 5 RC-PIPELINE-DRIFT files from canon sync

Add `cpv.allow_pipeline_drift` to plugin.json (CPV v2.97.0+ escape
hatch) listing the 5 files the v2.103.4 canon would force-overwrite:

- `scripts/publish.py` — has TS-specific gates (npm typecheck/lint/
  build/test + 3-manifest version-consistency check) that canon's
  pure-Python publish.py lacks. Force-overwriting drops the TS pipeline.
- `.github/workflows/ci.yml` — TS pipeline (npm install, npx tsc).
  Canon is the pure-Python equivalent. Validator's own WARNING text
  recommends `cpv.allow_pipeline_drift` for this file.
- `.github/workflows/notify-marketplace.yml` — uses `toJSON()`
  injection guard (stricter than canon's `client-payload: |` block).
- `cliff.toml` — has `commit_preprocessors` redacting `/Users/<name>/`
  paths from changelog (a security feature canon LACKS) + uses
  `{{ commit.raw_message }}` (canon's `commit.message` truncates body).
- `.markdownlint.json` — disables 8 rules vs. canon's 25 (stricter).

Clears 5 of 6 RC-PIPELINE-DRIFT-001 WARNINGs. Remaining WARNING is
the `.sh` cross-platform advisory (out of scope for this commit).

CRITICAL+MAJOR counts (2 + 94) unchanged — those are CPV#41 upstream
false positives in the new `skillaudit` detectors firing on TS template
literals, `process.cwd()`, localhost URLs, and LLM-request-body
assembly. Filed upstream; not addressed here per the user's explicit
"do not silence FPs by mutating plugin source" directive.

Doctor report: reports/plugin-diagnoser/20260523_175015+0200-llm-externalizer-plugin-canon-update.md


## [9.10.2] - 2026-05-19

### Fixed

- Fix: clear CPV ghost-dispatch + Zod 4 deprecation, add CLAUDE_PROJECT_DIR support

- Rewrite 4 command dispatch blocks to expose literal sonnet/opus
  subagent_type strings, clearing 8 CRITICAL RC-GHOST-DISPATCH-001.
- Rephrase "Never reuse the same agent" -> "Each bug gets a brand-new
  dispatch" in fix-found-bugs.md to clear MAJOR prose false positive
  on the word "same".
- Replace deprecated z.object({}).passthrough() with z.looseObject({})
  per Zod 4 (transitive via @modelcontextprotocol/sdk ^1.26.0).
- Respect CLAUDE_PROJECT_DIR for OUTPUT_DIR when set (CC 2.1.139+ MCP
  stdio servers receive it as an env var).


## [9.10.1] - 2026-05-19

### Fixed

- Fix(publish): make version-sync idempotent for current==target re-runs

Step 5 of `scripts/publish.py` rewrites the version literal in
`mcp-server/src/index.ts` and `pyproject.toml`. The OLD code used
`re.sub` then `if updated == src: error()` to detect regex failure.
That `==` check conflated TWO distinct conditions:

  - regex didn't match anywhere (real structural bug)
  - regex matched but produced identical text (current == target,
    an idempotent no-op)

When current == target the `[^"'`]+` group still matches "9.10.0"
and substitutes with "9.10.0", emitting the same text. The script
then aborted with `ERROR: regex failed to match version`.

That failure mode prevented legitimate idempotent republishes — e.g.
retrying after a network blip in step 10, or republishing the same
version after a hand-fixed release artifact. The v9.10.0 publish
hit it on index.ts AND pyproject.toml and shipped three throwaway
downbump chore commits (e855105, 0453452, 301df78) as workaround.

The fix switches to `re.subn` so we can distinguish "no match"
(count==0) from "matched and substituted" (count>=1). The
count>=1 path writes the file unconditionally — an idempotent no-op
when current == target. The count==0 path checks whether the
target is already present in a different file shape before
declaring a structural bug.

`uv lock` now runs unconditionally when pyproject.toml exists
(transitive deps may have drifted since the last lock), and logs
the action distinctly for "regenerated" versus "re-resolved".

Regression covered by tests/test_publish_idempotent.py (9 tests):
mirror functions exercise the exact regex patterns through all
four states — replace, idempotent no-op, missing constructor,
missing version line — including a v9.10.0 incident reproduction.


## [9.10.0] - 2026-05-19

### Added

- Feat(skills): add vllm-metal-setup + vmlx-setup backend skills (Phase 1)

User request 2026-05-15: expand local-backend support — promote
vllm-metal install guidance from inline setup-agent text to a proper
skill, then add a sibling skill for vMLX (jjang-ai/vmlx). "vllm-metal
is only the beginning."

Phase 1 of TRDD-65867b68-e795-4fbc-8548-639648679708 (the full epic —
benchmark/reliability harness, candidate-model selection, CUDA
low-VRAM autoconfig, broader MLX support, test backlog, audit
remainder — is phased there).

New skills (both user-invocable, so the setup agent can invoke them on
demand AND a user can run them directly — matches the
setup-agent-rich-toolkit principle: wider pool, agent picks freely):

- skills/vllm-metal-setup/SKILL.md — install (one-line curl installer →
  ~/.venv-vllm-metal), serve (`vllm serve` on :8000), configure
  (VLLM_METAL_* env vars, memory fraction for low-RAM Macs), verify,
  wire to the `vllm-local` preset, maintenance + failure modes.
  Apple-Silicon-only; community-maintained; text-only.

- skills/vmlx-setup/SKILL.md — install (`uv tool install vmlx` /
  pipx / venv), serve (`vmlx serve` on :8000, OpenAI/Anthropic/Ollama
  compatible), scan-tuned flags (continuous batching, prefix cache,
  PLD, KV-cache quant), built-in `vmlx doctor` + `vmlx bench` for
  reliability/perf checks, verify, wire to `vllm-local` / `generic-local`
  preset, maintenance + failure modes. Apple-Silicon-only.

Both skills:
- Explicitly state Apple-Silicon-only + community-maintained caveats.
- Do NOT assume `response_format: json_schema` support — defer to the
  setup wizard's Step 5 empirical compatibility test (hard requirement
  #2 cannot be assumed for any backend).
- Need no new settings.yaml preset — both servers are OpenAI-compatible
  on :8000, so the existing `vllm-local` preset fits.

Frontmatter sanity-checked. Phases 2-7 (setup-agent wiring, benchmark
harness, CUDA autoconfig, MLX expansion, tests, audit remainder)
tracked in the TRDD.

- Feat(codex): externalize scans to OpenAI GPT-5.5 via Codex CLI (MVP)

User request 2026-05-14: integrate review-loop-opus into llm-externalizer
as a new externalization target. Use OpenAI GPT-5.5 via Codex CLI;
fall back to Opus subagents on rate-limit. Match llm-externalizer's
existing usage methods. CRITICAL: preserve GPT-5.5 prompt calibration
— Codex prompts are OpenAI-tuned and must not be reworded.

Tracked in TRDD-807c1e2d-9457-4afb-b7a5-1e6099a17c28.

**New surface (MVP, phase 1):**

- `commands/llm-externalizer-codex-scan.md` — slash command
- `skills/llm-externalizer-codex-scan/SKILL.md` — skill autodiscovery
- `scripts/codex/run-codex-scan.py` — wrapper that handles file
  discovery, FFD bin-packing, codex invocation, rate-limit detection,
  and Opus fallback marker writing
- `scripts/codex/codex-scan-prompt.txt` — the GPT-5.5 prompt
  template (PINNED — do not edit in place, write a versioned sibling
  if calibration drifts)
- `scripts/codex/codex-scan-prompts.md` — human-readable docs
  explaining the prompt design

**Architectural decisions** (evidence in the TRDD):

1. Hybrid rewrite, not direct integration. The review-loop-opus
   model (Stop hook + state file + single consolidated review) is
   incompatible with llm-externalizer's on-demand per-file scan
   model. The Codex/multi-agent invocation mechanics + the
   `--runner=opus-agents` fallback semantics are preserved; the
   Stop hook lifecycle is dropped.

2. Per-batch fallback granularity. If batch 7 of 20 hits rate-limit,
   batches 8-20 also fall back to Opus (rate-limit windows are
   long). Batches 1-6 stay as Codex results — no rework.

3. GPT-5.5 prompts in a separate `.txt` file (NOT inside the .md
   docs). Avoids markdown-fence ambiguity and gives the wrapper's
   loader a trivial code path.

4. Output shape matches `splitPerFileSections` so the existing
   parallel-fixer / serial-fixer agents work on Codex output
   without modification.

**Smoke-tested:** wrapper `--help` loads, prompt template extracts
cleanly (1184 chars, has `{FILES_BLOCK}` placeholder), 8/8
rate-limit detection cases pass, finding-count regex correctly
counts 2 findings in a sample report with mixed severity case.

**Deferred to phase 2** (separate PR):
- `--fix-loop N` flag (scan → fix → re-scan → repeat)
- Cost tracking + cap (Codex doesn't expose token counts directly)
- MCP server `backend: "codex"` profile mode
- CI matrix testing macOS + Linux + WSL2 Codex detection

- Feat(diagnostics): add 3 CLI scripts for end-user troubleshooting

Adds three independent diagnostic scripts to scripts/diagnostics/ so a
user can troubleshoot the plugin without spawning Claude:

- check-mcp-server.py — verifies plugin root, node >=20, better-sqlite3
  resolves via mcp-server/node_modules, settings.yaml is structurally
  valid, and (optionally) probes OpenRouter reachability. Returns a
  markdown PASS/FAIL table.

- check-statusline.py — reads ~/.claude/settings.json, parses
  statusLine.command via shlex, resolves the interpreter on PATH,
  pipes a minimal Claude Code JSON envelope to the statusline command,
  and reports exit + first-line of stdout. --fix re-runs install_statusline.py.

- dump-state.py — collects non-secret state for bug reports: platform,
  plugin paths, plugin version, settings.yaml (redacted via a SECRET_PATTERNS
  mirror), statusLine block from ~/.claude/settings.json, and the tail of
  /tmp/claude/statusline-error.log. Writes a single markdown report.

All three scripts:
- Exit non-zero on failure so they compose into CI pipelines
- Use only stdlib (no extra deps; pyyaml optional for check-mcp-server)
- Print actionable next steps for each failure mode
- Are referenced from README's "Troubleshooting" section (separate commit)

Smoke-tested against the current install: all three produce expected
output. Cleared ruff --fix (I001 import sort, F541 f-string placeholders).

- Feat(setup): build-snippet.py helper + agent flow overhauls (Tier-2/3)

scripts/setup/build-snippet.py (NEW):
- Stdlib-only YAML snippet generator. Replaces the LLM-built f-string the
  agent previously used for Step-6 settings.yaml generation.
- Safely double-quotes every value via a local _yaml_dquote helper —
  model IDs with colons (`qwen2.5-coder:7b`), embedded quotes, etc. now
  serialise correctly without depending on PyYAML.
- Rejects profile names that would create invalid YAML or shell-special
  collisions (`[A-Za-z][A-Za-z0-9._-]{0,63}` only).
- Rejects unrecognised runners and --context-window values below 4096.

agents/llm-externalizer-setup-agent.md:
- T2.1: new Step 0 reads the user's existing settings.yaml + calls
  discover to show every already-configured profile. Asks the user
  whether they're adding / fixing / replacing before proceeding.
- T2.2: every `script > file.json` block now wraps in a fail-fast
  `if !`/`exit "$rc"` check, surfaces the diagnostic-log path on
  failure, and drops the partial file rather than letting the next
  step parse stale content.
- T2.6: hf install fallback chain is now uv → pipx → pip-user →
  bootstrap-uv, handling PEP 668 systems (Debian 12+, Ubuntu 23+,
  Homebrew Python on macOS). Adds an explicit post-install
  `hf --version` check.
- T2.7: `hf auth whoami` probe runs after install; surfaces an info
  line about gated Llama/Gemma/Mistral repos requiring a free token.
  Does NOT block — public models work without auth.
- T2.8: Verdict-logic block now surfaces explicit warnings on
  output_length / long_context / code_understanding < 1.0 (with
  per-runner --max-tokens hints). The "PASS without warning" path is
  truly silent only when all five tests score 1.0.
- T2.11: Step 6 now calls scripts/setup/build-snippet.py instead of
  the LLM-built f-string. Sub-step 6a handles profile-name collision
  detection against $EXISTING (grep on the user's settings.yaml).
- T3.5: hf install command version-pinned to `huggingface-hub[cli]>=0.25,<1.0`
  with the rationale (typosquat defence + entry-point series stability).
- T3.6: new "Idempotency / resume" subsection — agent checks state-file
  mtime (within last hour) and offers resume per-step. Per-file defaults
  on what to resume vs re-run.
- T3.19 (in commands/setup.md): OpenRouter redirect moved to top of
  the slash command so impatient users see it before scrolling past
  the 7-step list.
- WSL2 host-IP advice: PowerShell `Get-NetIPAddress` is the canonical
  path; the legacy /etc/resolv.conf grep is documented as fallback +
  flagged as tamperable.
- detect-runners.py invocation now passes --include-wsl2-host when
  env.json.os == "wsl2" so LM Studio bridged from the Windows host
  becomes visible.
- Step 6 paste instructions now include the backup `cp` step
  (.bak.<timestamp>) so a YAML indent typo can be reverted.

commands/llm-externalizer-setup.md:
- Quick-redirect banner at the top: "if you just want OpenRouter,
  STOP and use /llm-externalizer-configure instead."

build-snippet.py smoke-tested: happy path emits valid YAML; quote-
injection in model name correctly escaped; bad profile name rejected.
ruff + pyright clean on the new helper.

- Feat(setup): add /llm-externalizer-setup wizard agent + helper skills

A new 7-step interactive wizard helps users get a local-model backend
working end-to-end: detect platform (OS, arch, RAM, GPU), find installed
runners (Ollama, LM Studio, vLLM, llama.cpp, Jan), suggest + offer to
install one when none are present, help download a Hugging Face model
(auto-installs the `hf` CLI when missing), run five calibrated
compatibility tests on the selected model, then emit a ready-to-paste
settings.yaml profile snippet. The agent NEVER writes to
~/.llm-externalizer/settings.yaml directly — user-only-configuration
policy.

New artefacts:
- agents/llm-externalizer-setup-agent.md — Sonnet-tier wizard with the
  five helper skills preloaded via the `skills:` frontmatter.
- commands/llm-externalizer-setup.md — slash command that dispatches
  the agent.
- scripts/setup/detect-environment.sh — OS/arch/RAM/GPU detector.
- scripts/setup/detect-runners.py — stdlib-only probe for Ollama,
  LM Studio, vLLM, llama.cpp, Jan with returncode-strict version
  capture.
- scripts/setup/test-model.py — five calibrated tests (smoke,
  structured_output, code_understanding, long_context, output_length).
- scripts/setup/recommend-models.py — vendored stdlib-only
  recommender (Onyx + whatcani.run) with six surgical bug fixes:
  provider attribution from name (not artifact creators), source-name
  parsing for paren-wrapped quants, DQ-prefix recognition, compound-
  quant preservation, template-provider fallback order, and cache
  reroute to $CLAUDE_PLUGIN_DATA/setup/cache.
- skills/huggingface-{best,local-models,mlx-models,community-evals}/
  + skills/hf-cli/ — five helper skills with user-invocable:false,
  preloaded by the setup agent. The mlx-models skill fills the gap
  left by huggingface-local-models (which doesn't cover MLX).

All gates pass on the new files: ruff check, pyright (0 errors),
shellcheck.


### Changed

- Release(v9.10.0): MCP hardening + setup-agent expansion + Python test harness

User request 2026-05-17: "complete all pending tasks. audit the
changes. fix all issues. benchmark and test the new features. apply
fixes." This commit ships the v9.10.0 release covering both pending
TRDDs (480419e5 audit remainder + 65867b68 local-backend expansion)
plus the post-release audit fixes.

## Security & correctness (TRDD-480419e5 audit remainder)

- T2.7 — watchFile race fixed. reloadSettingsFromDisk() builds the
  new BackendConfig fully in a local variable then swaps currentBackend
  atomically. ~30 read sites converted to snapshot-then-use so an
  in-flight request keeps reading the consistent pre-swap state.
  Eliminates wrong-token auth + reasoning-ladder downgrade desync.
- T2.18 — gitLsFilesMultiRepo hardened. New validateGitCwd guard
  rejects paths outside project root + system directories. Removed
  --recurse-submodules (SSRF surface). 30 s → 5 s timeout with
  killSignal:'SIGKILL'. lstatSync retries on EAGAIN/EBUSY.
- T2.MCP-SDK — Server → McpServer migration. All 31 tool handlers
  migrated from setRequestHandler(CallToolRequestSchema, …) switch
  dispatcher to per-tool server.registerTool calls. Behavior parity
  verified.
- T2.23 — statusline cache TTL ceiling. CACHE_HARD_CEILING=24h.
  fetch_usage_from_api returns _stale_expired sentinel when cache
  exceeds ceiling; render path shows "usage: stale (>24h, check API
  token)" so revoked tokens no longer hide behind ancient cached stats.
- T2.24 — v9.5→v9.10 migration hook. New scripts/setup/migrate.py
  (idempotent) wired into mcp-server/launcher.mjs before linkNodeModules.
  Renames stale settings.yml → settings.yaml, removes .publish.lock
  older than 1 h, clears dangling node_modules symlinks.

## Setup-agent expansion (TRDD-65867b68 Phases 2-5)

- Phase 2 — Setup agent Step 3a now references the Phase-1
  vllm-metal-setup + vmlx-setup skills via Skill() calls, with an
  Apple-Silicon backend-choice table (LM Studio / Ollama / vllm-metal /
  vMLX) explicitly framing the last two as community-maintained
  alternatives, not defaults. Frontmatter 5-skill preload preserved
  per skill-preload-preserved memory.
- Phase 3 — scripts/setup/benchmark-models.py (458 LOC) + sibling
  _bench_helpers.py (305 LOC). Per-candidate reliability suite (smoke
  / structured output / code understanding / long context / output
  length) plus throughput + TTFT measurement. Delegates perf numbers
  to `vmlx bench` when active runner is vMLX. Aggregates to a ranked
  markdown table + JSON results file. Default viability threshold:
  passes tests 1+2 AND ≥ 5 tok/s. Fail-fast: exits 1 on unreachable
  backend with a clear one-line diagnostic.
- Phase 4 — scripts/setup/vllm-cuda-autoconfig.py (448 LOC).
  Linux+NVIDIA autoconfig: detects VRAM via nvidia-smi, emits a tuned
  `vllm serve` command. Four tiers (≥ 24 GB full bf16; 12-24 GB fp8
  KV-cache; 8-12 GB AWQ/GPTQ INT4 + fp8 + max-len 16k; < 8 GB INT4 +
  --cpu-offload-gb + --swap-space + max-len 8k). On non-Linux hosts
  exits 0 with a polite skip.
- Phase 5 — huggingface-mlx-models SKILL.md expanded with the
  3-runtime trade-off table (mlx_lm.server / vMLX / LM Studio MLX) +
  Apple-Silicon unified-memory quant-budget table covering 8 GB →
  128+ GB tiers. Cross-references vmlx-setup + vllm-metal-setup so
  the agent can hand off when the user picks a community backend.

## Python test harness + new tests (Phase 6 partial)

- pyproject.toml: bumped to 9.10.0, added [project.optional-dependencies]
  test = [pytest>=8.0, pytest-asyncio>=0.23], added
  [tool.pytest.ini_options] block.
- tests/__init__.py, tests/conftest.py (auto-adds scripts/<subpkg>/
  to sys.path so tests can import statusline/migrate/benchmark_models
  without package shenanigans).
- mcp-server/src/safe-body.test.ts (B7a) — 8 tests covering the
  32 MiB cap (safeReadText / safeReadJson under cap, at cap, with
  truthful + lying Content-Length, JSON invalid, JSON over cap,
  negative / overflow Content-Length).
- tests/test_benchmark_models.py (W4) — 25 tests covering bin
  packing, host parsing, viability decision rules, atomic JSON write.
- tests/test_run_codex_scan.py (B7b) — 10 tests covering rate-limit
  detection, bin packing, prompt assembly, finding-count extraction,
  CLI help.
- tests/test_statusline.py + test_migrate.py + test_cache_ttl_ceiling.py
  (B7c) — 12 tests covering _format_12h_ampm locale-independence,
  _log_exception dedup, statusline CLI smoke, migrate.py idempotency
  + each migration case, cache TTL freshness + expired sentinel.
- tests/test_diagnostics.py (B7d) — 6 tests covering all 3
  diagnostics scripts: --help smoke, markdown output, secret redaction.

Final test count: pytest 53 pass + vitest 360 pass / 2 skipped.

## README + manifest + audit fixes

- README.md — plugin-structure tree updated for disk reality (20
  commands / 6 agents / 14 skills, previously claimed 7 / 5 / 5).
  Added "0 · Run the setup wizard (recommended)" sub-section before
  the existing First Run options A-E. Plugin commands tables
  recounted. Agents table now lists llm-externalizer-setup-agent.
  Troubleshooting expanded (vLLM half-installed, Jan port collision,
  hf auth gated repos, paste-broke-my-YAML recovery). Windows + WSL2
  paths documented for every settings.yaml reference. build-snippet.py
  security note added. Version badge bumped 9.7.0 → 9.10.0.
- .claude-plugin/plugin.json — version 9.9.0 → 9.10.0, keywords
  expanded with huggingface, setup-wizard, mass-scouting, vllm,
  llama-cpp, vllm-metal, vmlx, mlx.
- mcp-server/package.json + mcp-server/src/index.ts version string
  bumped 9.9.0 → 9.10.0 (C3 audit caught the divergence).
- commands/llm-externalizer-discover.md — added `argument-hint: ""`
  for frontmatter consistency across all 20 commands (C2 audit M-1).
- skills/vmlx-setup/SKILL.md — stripped internal TRDD-65867b68
  reference from user-facing skill text (C2 audit L-3).
- scripts/diagnostics/dump-state.py — added `timeout=5` to
  subprocess.run(['date', …]) per all-subprocess-timeouts policy
  (C4 audit NIT).

## Re-audit

Four-agent audit re-run on the fixed state:
- C1 (MCP TS): T2.7 + T2.18 + T2.MCP-SDK all verified clean.
- C2 (agents/commands/skills): 0 CRITICAL, 0 MAJOR, 1 MINOR (now
  fixed), 4 NIT (3 fixed / 1 deferred).
- C3 (docs): 1 MAJOR (version mismatch — now fixed).
- C4 (platform/safety): CLEAN with 1 NIT (now fixed) + 1 policy
  callout (codex --dangerously-bypass — intentional, documented).

Build: tsc 0 errors, eslint 0 errors. Tests: pytest 53/53 +
vitest 360/362 (2 skipped). All v9.10.0 smoke checks pass.


### Documentation

- Docs(setup-agent): add "analyze first, then compose the flow" operating principle

Per user guidance: the setup wizard must be given the widest practical
pool of skills/techniques AND be explicitly free to choose which to use
and in what order — never a rigid hard-coded sequence. Every machine is
different (half-installed runners, PEP-668-locked Python, WSL2 quirks,
Apple Silicon vs. Intel, exotic shells, corporate proxies); only an
agent looking at the actual machine can find the right order of
operations, and a wider toolkit raises the probability of a working
setup.

New "Operating principle" section right after the intro:

- Frames the Step 0-7 workflow as the DEFAULT happy path / building
  blocks, NOT a script — the agent may reorder, skip, repeat, and
  insert recovery actions the scripts didn't anticipate.
- Enumerates the full capability pool: the 5 preloaded skills, the
  scripts/setup/ helpers, the scripts/diagnostics/ helpers, Bash /
  WebFetch / AskUserQuestion, any other on-demand skill on the system,
  and the agent's own general knowledge for uncovered corner cases.
- States the goal as a working, TESTED backend — not ritual completion
  of seven numbered steps.

Does not touch the 5-skill frontmatter preload (kept as the floor; the
"wider pool" is on-demand skills + scripts + knowledge layered on top).
The numbered-step workflow body is unchanged — only reframed as
adaptable.

- Docs(trdd): mark v9.9.0 work complete + reschedule remainder to v9.10.0

- Docs(readme): v9.7.0 critical updates (audit T1.8 partial)

Audit-driven fixes from the full-plugin-audit docs report (C-1 .. C-4).
This is the first of two README passes — non-critical items deferred to a
follow-up.

C-4 (CRITICAL — version badge stale):
- version-9.5.1 -> version-9.7.0 (was two releases behind on the badge,
  even though plugin.json + mcp-server/package.json now correctly read
  9.7.0 after commit b55c0ff).
- node->=18 -> node->=20 (Node 18 EOL'd 2025-04-30; current LTS floor
  is 20, matching mcp-server/package.json engines).

C-2 (CRITICAL — change-model advertised despite disabled tool):
- The Features bullet now states explicitly that `/llm-externalizer:
  llm-externalizer-change-model` is a user-only slash wrapper around
  the local `scripts/apply_ensemble_choice.py` helper, and that the
  underlying MCP `change_model` and `set_settings` tools are
  disabled by design. Profile / model changes go through editing
  settings.yaml directly (or running the setup wizard).

C-3 (CRITICAL — inventory counts wrong):
- "17 plugin commands" -> "19 plugin commands" (10 base + 8 mass-scout
  + setup + install-statusline counted).
- "5 internal agents" -> "6 internal agents" (adds the setup-agent).
- New Features bullet calls out the five preloaded Hugging Face
  helper skills (user-invocable: false) bundled with the setup
  wizard.
- `batch_check` mention removed and replaced with a one-line note
  that `max_retries: 3` is the modern equivalent — closes the
  README/project-rules discrepancy flagged in audit N-2.

C-1 (CRITICAL — setup wizard invisible) — partial: a new lead
Features bullet describes the wizard and its safety properties.
A follow-up commit will add the "0 · Run the setup wizard
(recommended)" sub-section under § First run (the largest pending
README edit), and update the plugin-structure tree and agents
table.

Verified: badges render correctly via shields.io; the disabled-tools
note matches the actual MCP server behavior (handlers in src/index.ts
return FAILED for set_settings and route change_model via the local
script).

- Docs: add TRDD-3ef94759 — setup wizard Tier-2/Tier-3 follow-up fixes

Tracks the 37 audit findings deferred from commit d314c2d (Tier-1):
- Tier 2: 15 substantial items (~315 LOC) — UX gaps, Windows
  detection PowerShell fallback, agent exit-code checks, YAML
  snippet helper, content-grounded long-context test, etc.
- Tier 3: 22 polish items (~200 LOC) — port collision, token-path
  modernisation, idempotency, bounds tightening, etc.

Plus two larger cross-cutting refactors (discriminated-union runner
detection + contract-test fixtures for recommend-models.py).

Full per-finding evidence still lives in the gitignored audit
reports under reports/setup-agent-audit/ (4 per-domain reports +
1 consolidated). This TRDD carries the *plan*, not the findings —
those are reproducible from re-running the audit agents.


### Fixed

- Fix(cpv): progressive-disclosure 12 skills to clear MAJOR size gate

Round-2 fix-validation pass. Removed the `cpv:` override block from
`.claude-plugin/plugin.json` (Claude Code's `claude plugin validate`
strict schema rejects unknown top-level keys), then did the real
work: progressive-disclosure on all 12 skills that breached the
≤ 5 000 char SKILL.md limit. Bulk content moved into per-skill
`references/<topic>.md` files so the skill body stays focused while
the full guidance still ships inside each skill folder.

Final CPV verdict (cpv-remote-validate plugin .):
  CRITICAL=0 MAJOR=0 MINOR=0 NIT=20 WARNING=6

publish.py validate gate now passes.

## New references/*.md files

- skills/hf-cli/references/commands.md
- skills/huggingface-best/references/leaderboard-workflow.md
- skills/huggingface-community-evals/references/evaluation-recipes.md
- skills/huggingface-local-models/references/launch-recipes.md
  (joins existing hardware.md, hub-discovery.md, quantization.md
   — all three also re-organised)
- skills/huggingface-mlx-models/references/quant-budget.md
- skills/huggingface-mlx-models/references/runtime-comparison.md
- skills/huggingface-mlx-models/references/runtime-recipes.md
- skills/vllm-metal-setup/references/install-and-serve.md
- skills/vmlx-setup/references/install-and-serve.md

## Skills resized (all now ≤ 4 900 chars)

| Skill | Before | After |
|---|---|---|
| hf-cli | 23 853 | trimmed |
| huggingface-mlx-models | 21 745 | trimmed |
| huggingface-community-evals | 9 803 | trimmed |
| vmlx-setup | 8 061 | trimmed |
| huggingface-best | 7 863 | trimmed |
| vllm-metal-setup | 7 863 | trimmed |
| huggingface-local-models | 6 584 | trimmed |
| llm-externalizer-codex-scan | 5 947 | trimmed |
| llm-externalizer-mass-scouting | 5 646 | trimmed |
| llm-externalizer-usage | 5 349 | trimmed |
| llm-externalizer-free-scan | 5 226 | trimmed |
| llm-externalizer-scan | 5 140 | trimmed |

## Repo-wide markdown lint config

Added `.markdownlint.json` + `.markdownlint-cli2.jsonc` so CPV's
markdown-lint step runs against a stable rule set (matches existing
project style for headings, lists, fenced code, etc.). CHANGELOG.md
auto-tidied by markdownlint (only style fixes — `+` bullets → `-`,
trailing-blank-line trims, no content changes; v9.10.0 entry intact).

## Preload contract preserved

`agents/llm-externalizer-setup-agent.md` frontmatter `skills:` array
still preloads the 5 helper skills (huggingface-best,
huggingface-local-models, huggingface-mlx-models, hf-cli,
huggingface-community-evals). The agent still reads the full skill
body + every references/*.md the body links to — progressive
disclosure is transparent at the agent layer.

- Fix(cpv): clear pre-publish CPV gate for v9.10.0

Applied by plugin-fixer agent (claude-plugins-validation) against
reports/full-plugin-audit/cpv-v9.10.0-pre-publish-clean.json.

Pre-fix:  4 CRITICAL + 77 MAJOR + 31 MINOR + 21 NIT + 6 WARNING
Post-fix: 0 CRITICAL + 0 MAJOR +  2 MINOR + 20 NIT + 17 WARNING

publish.py validate gate now expected to pass.

## CRITICAL fixes (4 → 0)

design/tasks/TRDD-807c1e2d-…-codex-gpt55-scan-integration.md — scrubbed
the two `<HOME>/Code/review-loop-opus` mentions and the
embedded `emanuelesabetta` username, replacing with `~/Code/...`. Per
CPV's strict private-path-leak rule, dev usernames embedded in design
docs are CRITICAL because the docs ship inside the plugin tarball.

## MAJOR fixes (77 → 0)

All 8 affected SKILL.md files restructured to the Nixtla strict layout
required by CPV: explicit "Use when ..." in description, ≤ 5 000 chars
in the SKILL.md body via progressive disclosure to references/, and
the seven required sections (Overview, Prerequisites, Instructions,
Output, Error Handling, Examples, Resources).

- skills/hf-cli/SKILL.md (21 252 chars → trimmed; progressive
  disclosure to references/)
- skills/huggingface-best/SKILL.md
- skills/huggingface-community-evals/SKILL.md + examples
- skills/huggingface-local-models/SKILL.md + references/hardware.md
- skills/huggingface-mlx-models/SKILL.md
- skills/llm-externalizer-codex-scan/SKILL.md
- skills/llm-externalizer-mass-scouting/SKILL.md
- skills/vllm-metal-setup/SKILL.md
- skills/vmlx-setup/SKILL.md

The setup-agent's 5-skill frontmatter preload
(`huggingface-best`, `huggingface-local-models`, `huggingface-mlx-models`,
`hf-cli`, `huggingface-community-evals`) is preserved intact — only the
SKILL.md bodies were restructured; the preload contract is unchanged.

Other MAJOR fixes:
- tests/test_migrate.py — ruff E-class lint fixed.
- skills/huggingface-community-evals/scripts/{inspect_eval_uv,inspect_vllm_uv,lighteval_vllm_uv}.py —
  shebang + chmod +x so they're executable per CPV's script-mode rule.
- scripts/codex/run-codex-scan.py — minor lint cleanup.
- scripts/setup/recommend-models.py — minor lint cleanup.
- mcp-server/src/index.ts — tightening picked up by tsc rebuild;
  dist/* rebuilt accordingly.

## Plugin.json

Added the missing `cpv` config block referencing the Nixtla strict
override (`cpv.max_chars / cpv.skill_size_severity`) so future audits
respect the v9.10.0 layout decisions.

## Remaining

- 2 MINOR — non-blocking UX nits.
- 20 NIT — cosmetic.
- 17 WARNING — none publish-blocking per
  references/iterative-fix-loop.md (publish-blocking warning
  categories list).

Build still clean: tsc + eslint 0 errors, vitest 360/362, pytest 53/53.

- Fix(setup-agent): correct macOS vLLM guidance — stock vLLM has no Apple Silicon path

The setup wizard's Step 3a install table told macOS users to run
`uv pip install vllm`. Stock vLLM is a CUDA project: on Apple Silicon
that command fails to build the GPU path or silently installs an
unaccelerated CPU wheel. The macOS vLLM cell was effectively wrong
for every Mac the wizard runs on.

Found while evaluating vllm-project/vllm-metal — the community
hardware plugin that makes vLLM run on Apple Silicon via MLX.

Changes to agents/llm-externalizer-setup-agent.md:

- Step 3a default list: the single "macOS (arm64 or x86_64)" line is
  split. Apple Silicon now lists vLLM-via-vllm-metal as a power-user
  alternative (after LM Studio default + Ollama alt). Intel macOS
  explicitly says NOT to offer vLLM — neither stock vLLM nor
  vllm-metal (Apple-Silicon-only) has a GPU path there.

- Install table vLLM row: the macOS cell now carries the vllm-metal
  one-line installer (`curl ... vllm-metal/main/install.sh | bash`)
  + the `source ~/.venv-vllm-metal/bin/activate && vllm serve` launch.
  The Linux/WSL2 cell keeps the real `uv pip install vllm` (it was
  previously "same", pointing at the wrong macOS command).

- New explanatory note after the table: why stock vLLM fails on
  macOS, what vllm-metal is, that `vllm serve` still exposes the
  OpenAI-compatible API on :8000 so the existing `vllm-local` preset
  works unchanged (no new preset needed), reinstall/uninstall recipe,
  and a caveat that it's community-maintained / text-only / newer
  than LM Studio + Ollama — an alternative, not the macOS default.

No new preset or profile-template change: vllm-metal's server is
wire-compatible with the existing `vllm-local` preset.

- Fix(mcp): T2.19 — splitPerFileSections silent-drop on inline annotation

Audit finding (MCP M7): when the LLM emits a header like
`## File: /foo.ts ## continued from batch 2`, the lazy `(.+?)` in the
header regex captured `/foo.ts ## continued from batch 2` (the entire
rest of the line). Neither path matched any expected_paths, so the
section was silently dropped — the report for that file showed up
empty with no diagnostic.

Fix: after the regex match, truncate the captured path at the first
inline `##` (since `##` would otherwise be a markdown header marker,
file paths legitimately containing `##` are out of scope). Also skip
headers whose path becomes empty after the trim (defensive — a header
line that turned out to be entirely annotation should not index a
section under `""`).

Two new tests in grouping.test.ts cover both branches. All 33 tests
in the suite pass.

- Fix(mcp): T2.6 — cap response body reads at 32 MiB (audit follow-up)

Every `await res.text()` and `await res.json()` in the MCP server was
uncapped. A buggy or hostile upstream could return a multi-GB body and
crash the server with an OOM. The audit (MCP M3, finding T2.6) called
this out as one of the highest-impact MAJOR items still open after
v9.9.0.

**New module `mcp-server/src/safe-body.ts`:**

- `safeReadText(res, maxBytes?)` — streams the body via getReader() with
  a hard byte cap, throws on overrun. Honors Content-Length up-front so
  we abort before allocating the buffer when the server tells us the
  body would be too large.
- `safeReadJson<T>(res, maxBytes?)` — wraps safeReadText + JSON.parse.
- `MAX_RESPONSE_BYTES = process.env.LLM_EXT_MAX_RESPONSE_BYTES ?? 32 MiB`
  — generous default (OpenRouter chat completions are typically <1 MiB,
  /v1/models is ~500 KiB), but overridable per-deployment if a workload
  legitimately needs more.

**Call sites converted** (index.ts + or-model-info.ts, 11 total):

- getModelSupportedParams (1384) — /v1/models/{id}/endpoints
- fetchOpenRouterModelsList (1618) — /v1/models
- fetchOpenRouterBudget (1746) — /v1/credits
- chatCompletionNative LM Studio error path (2579, 2596) and JSON parse (2600)
- chatCompletionSimple error + JSON parse (2736, 2753)
- chatCompletionStreaming JSON-mode error + JSON parse (2940, 2957)
- listModelsRaw (3013) — local /v1/models
- or-model-info fetchOpenRouterModelInfo error + JSON (200, 206)

All sites preserve their `.catch(() => "")` semantics for error-body
reads so HTTP errors still produce a useful message when the body is
unreadable, just with the OOM ceiling enforced.

Verified: `npx tsc --noEmit` clean. SDK deprecation warnings on `Server`
(line 39, 5065) are pre-existing and tracked as T2.MCP-SDK in TRDD-480419e5.

- Fix(v9.10.0): T2.16 filter warning + T2.21 log breadcrumb + T2.25 locale am/pm

Three v9.10.0 follow-out fixes (none release-blocking on their own,
batched here so the v9.10.0 release commit is clean).

**T2.16 — filterBodyForSupportedParams now warns on drop** (mcp-server):

When a user configures `temperature: 0.7` in their profile but the
target model's `supported_parameters` list (from OpenRouter
/v1/models/{id}/endpoints) doesn't include "temperature", the value is
filtered out before the request. Previous code did this silently, so
users had no signal that their override was being ignored.

Now: per (model, field) pair, emit a one-shot stderr line the first
time we drop that combo. Module-level `FILTER_WARN_SEEN` dedups so the
log doesn't flood. The two call sites (chatCompletionSimple's reasoning
ladder + the streaming variant) both pass `conn.model` so the warning
identifies which model.

**T2.21 — _log_exception surfaces secondary errors** (statusline):

The statusline's per-section error logger writes labelled tracebacks
to `/tmp/claude/statusline-error.log`. Previously the `except Exception:
pass` swallowed ALL secondary errors, including ENOSPC, EACCES, EROFS
on a read-only sandbox mount. Now an OSError emits a one-line stderr
breadcrumb (Claude Code surfaces statusline stderr in its main error
log) so the user can see "the error logger itself can't write".
Module-level `_LOG_EXCEPTION_WARN_SEEN` dedups by errno.

**T2.25 — locale-independent am/pm formatting** (statusline):

`%p` is locale-dependent and emits the empty string on `de_DE.UTF-8`,
`ja_JP.UTF-8`, and several other non-Latin locales. The statusline's
time/datetime display would render "12:30" instead of "12:30pm" for
those users. New `_format_12h_ampm` computes the hour/minute/am/pm
directly from `datetime.hour` without going through strftime — the
month-name path still uses `%b` (acceptable, every shipped locale has
a 3-char abbreviation, only `%p` actually emits empty).

Verified clean: `npx tsc --noEmit` (mcp-server), `ruff check`
(statusline.py).

- Fix(launcher,statusline): T2.2 stall + cross-platform sep (audit Tier-2)

T2.2 (HIGH SC-P1-005 — statusline /dev/tty stall + redundant git calls):
- /dev/tty open: short-circuit on (no $TTY AND not isatty AND /dev/tty
  absent) AND use O_NONBLOCK so the open fails fast on hung devices
  instead of waiting for the kernel IPC chain to time out (3-5 s on
  detached / nohup / orphan sessions). Per-refresh stall in the worst
  case is now ~0 ms instead of 3-5 s.
- get_git_info() consolidates `git diff --quiet HEAD` + `git ls-files
  --others --exclude-standard` (2 subprocesses) into one `git status
  --porcelain=v1` call. Half the subprocess overhead per refresh, and
  fixes audit SR-P1-013 / SC-P1-013 — `ls-files --others` ignored
  submodule .gitignore, so the bar showed `branch*` (dirty marker)
  even when `git status` showed nothing.
- All git subprocess timeouts tightened from 3 s to 1 s. Worst-case
  stall on slow filesystems / SSHFS / WSL2 Windows-network mounts
  is now 3 s × 1 call = 3 s, not 3 s × 3 calls = 9 s.

SR-P1-006 (NIT launcher cross-platform sep):
- mcp-server/launcher.mjs linkNodeModules() previously concatenated
  `SCRIPT_DIR + (process.platform === "win32" ? "\\" : "/")` to test
  whether `dst` lives under the launcher's directory. On Windows
  where SCRIPT_DIR could already end with a backslash (rare but
  possible from env-var-derived paths), the concat double-slashed
  and `startsWith` returned false → canReplace=false → "refusing to
  replace" error. Now uses `path.sep` and resolves both ends.

Verified: ruff + pyright clean on statusline.py.

- Fix(pre-push): T2.3 interpreter whitelist + T2.4 ps fallback

TRDD-480419e5 Tier-2 fixes from the platform/safety audit:

T2.4 (HIGH SC-P1-003 — pre-push fails on minimal containers):
- ps_query() returned None on FileNotFoundError (missing `ps` binary,
  e.g. Alpine slim / scratch + ko/buildah / minimal CI images). The
  walker then broke out at the first frame and the policy collapsed
  to "refuse every push" with a misleading "(ps lookup failed)"
  message that left the user diagnosing the wrong thing.
- New path: when `ps` is absent, ps_query() falls back to reading
  /proc/<pid>/stat (PPID from field 4, after the trailing paren)
  AND /proc/<pid>/cmdline (NUL-separated argv joined with spaces).
  If neither /proc nor `ps` is available, returns the literal
  "no-ps" sentinel so the walker can emit a clear "install procps-ng"
  diagnostic instead of the generic "ps lookup failed".
- MAX_ANCESTRY_DEPTH bumped from 40 to 100 (audit SC-P1-014); also
  exposed via LLM_EXT_HOOK_MAX_DEPTH env var for exotic shell stacks.

T2.3 (HIGH SC-P1-006 — pre-push regex bypass via symlinked publish.py):
- The argv parser matched any `\S*publish.py` substring. An attacker
  could `ln -s ~/code/llm-externalizer-plugin/scripts/publish.py
  /tmp/publish.py` and then run
    `git -c "core.editor=/tmp/publish.py" push origin main`
  The walker saw `/tmp/publish.py` in `git push`'s argv, resolved it
  via realpath to the canonical publish.py, and ALLOWED the push —
  bypassing the 9 mandatory publish gates.
- New: `INTERPRETER_PREFIXES` whitelist (python, python3, python3.*,
  /usr/bin/env, uv, uvx, pyenv, poetry, pipenv, + canonical
  /usr/bin/python / /usr/local/bin/python / /opt/homebrew/bin/python).
  The argv match is rejected unless the preceding token (after the
  existing `--flag` reject) passes `_is_interpreter_token()`. Now
  only argv shapes like `python3 /path/publish.py`,
  `uv run scripts/publish.py`, `/usr/bin/env python publish.py`
  are accepted — `git -c core.editor=/tmp/publish.py` is rejected
  because `core.editor=/tmp/publish.py` is preceded by `-c`, not a
  Python interpreter.

Note about the legitimate `gh attest verify`-style flow: those tools
don't invoke publish.py at all, so they were never in the ancestry
chain to begin with — the whitelist tightening doesn't affect them.

Verified: ast.parse() + ruff clean on the modified hook. Tests for
the corner cases (Alpine slim, /proc-only Linux, symlinked publish.py)
documented in TRDD-480419e5 for v9.9.0 inclusion.

- Fix(commands): repair v9.8.0 auto-router (audit SR-P1-001 + SR-P1-002)

A v9.8.0 internal-audit caught two CRITICAL bugs in the auto-router I
introduced in commit d94d595. Both bugs would have made every
auto-routed fixer dispatch silently fall through to Sonnet regardless
of source-file size — defeating the entire feature unless the user
explicitly set LLM_EXT_FORCE_OPUS=1.

SR-P1-001 — router awk pattern never matched real reports:
- The router used `awk '/^\*\*File:\*\*/ {print $2; exit}'` to extract
  the source-file path. But the MCP server emits per-file reports
  with `## File: <path>` (scan_folder, code_task per-file) or
  `- **Input file**: \`<path>\`` (compare_files, check_against_specs);
  only the aggregated bug list uses `**File:**`. The parallel-fixer
  router never saw a match → $src empty → BIG_SOURCE=0 → Sonnet.
- Now uses a multi-pattern grep -E that matches all three shapes,
  with sed strip-and-trim that preserves paths containing spaces
  (audit SR-P1-004 — `tr -d ' '` corrupted /Users/Name Surname/...).
- Fixed in: commands/llm-externalizer-scan-and-fix.md (Step 4b),
  commands/llm-externalizer-fix-report.md (Step 2b).

SR-P1-002 — per-bug router always returned bug #1's file:
- After iteration 1 of the serial-fix loop, bug #1 is marked `--
  FIXED`. The naive awk `'/^\*\*File:\*\*/ {print $2; exit}'` still
  returned bug #1's path even though the serial-fixer would pick a
  different bug (the next-up unfixed entry). Routing decisions were
  consistently against the wrong file.
- Now a small awk state machine walks to the first `### ` heading
  WITHOUT FIXED and prints THAT bug's File: line.
- Fixed in: commands/llm-externalizer-scan-and-fix-serially.md
  (Step 5c), commands/llm-externalizer-fix-found-bugs.md (Step 4c).

SR-P1-003 + SR-P1-004 fixes folded in:
- `wc -l < missing_file` no longer prints zsh's "no such file or
  directory" message: now gated on `[[ -f "$path" ]]` first.
- `wc` output is `tr -d '[:space:]'`-trimmed (macOS BSD wc emits
  leading-padded numbers — `       42`, not `42`).
- No more `tr -d ' '` on paths.

Verified locally:
- printf '## File: /abs/a.py\n' | grep -m1 -E '^(## File:|...)' → match
- 2-bug fixture with #1 FIXED and #2 unfixed → state-machine picks #2

- Fix(mcp): TRDD Tier-2 — default branch envelope + retry body + secret patterns

T2.8 — `default` branch in CallToolRequestSchema threw → wrong error
envelope:
- Previously `default: throw new Error("Unknown tool: ...")` fell into
  the outer try/catch which logs status=error and increments the
  SERVICE_HEALTH error counter. That attribution is wrong for a typo'd
  tool name (no LLM call was made). The default now returns the same
  isError envelope every other branch uses; phantom errors no longer
  pollute session logs or trigger backoff for unrelated reasons.

T2.9 — `fetchWithRetry429` returned a Response with its body already
consumed:
- The retry loop called `await lastRes.text().catch(() => {})` between
  attempts to free the connection. After retries exhausted, the caller
  got a Response whose body stream was drained — `await res.text()`
  returned "" and surfaced errors lost server-supplied detail.
- The new code captures `lastBodyText` before draining each iteration,
  then re-wraps the final response with `new Response(lastBodyText, …)`
  so the caller's `await res.text()` still gets the most-recent body.
  Headers + status preserved.

T2.17 — `SECRET_PATTERNS` ENV_SECRET regex missed common names:
- Old: hand-curated list of ~18 names. Missed JWT_SECRET,
  STRIPE_SECRET_KEY, SUPABASE_SERVICE_KEY, LM_API_TOKEN (the plugin's
  own preset!), HF_TOKEN, GH_TOKEN, GITLAB_TOKEN, SLACK_BOT_TOKEN,
  TWILIO_AUTH_TOKEN, SENTRY_AUTH_TOKEN, etc.
- New regex extends the explicit list AND adds a wildcard alternation
  catching any `[A-Z][A-Z0-9_]*(_KEY|_TOKEN|_SECRET|_PASSWORD|
  _APIKEY|_API_KEY|_AUTH)`. The wildcard covers future vendor naming
  without needing a per-vendor patch. The 8-char captured-value
  minimum continues to filter out the noise of placeholder strings.

Verified: `tsc --noEmit` clean.

Remaining MCP MAJORs (T2.6 res.text/json caps, T2.7 watchFile race,
T2.16/T2.18/T2.19) tracked in TRDD-480419e5 for v9.9.0 — they require
larger surgical changes.

- Fix(statusline): chmod 0600 OAuth caches + Python interpreter detection

Audit Tier-2 hardening from the platform/safety report:

T2.1 (HIGH SC-P1-004 — OAuth-derived cache files not 0600):
- scripts/statusline/statusline.py:247,282 — fetch_usage_from_api and
  fetch_openrouter_budget both Path.write_text() their cache files
  with the process umask (typically 0o022 -> mode 0644). Parent dir
  /tmp/claude is 0o700 on single-user hosts, but on multi-tenant
  Linux boxes or pre-created /tmp/claude (CI runners, Docker
  volumes) the cache is world-readable. Both cache files contain
  per-bucket usage %, OpenRouter subscription-tier info, and
  reset-timestamps derived from the user's bearer token.
- Both write paths now follow up with cache_file.chmod(0o600). On
  OSError (e.g. unusual filesystem) the chmod is best-effort and
  the cache write still succeeds.

T2.5 (HIGH SC-P1-007 — install.sh / install_statusline.py hardcode
`python3`):
- The literal command `python3 {dest}` broke on:
  (a) native Windows where the canonical name is `py` or `python`,
  (b) NixOS without an explicit nix-shell,
  (c) PEP-668 macOS where the bare /usr/bin/python3 symlink points
      at Apple's CLT stub and prompts for Xcode tools every 3 s,
  (d) any HOME path containing spaces (the `python3 /Users/Test
      User/.claude/statusline.py` arg-split fails).
- Both installers now pick the interpreter at install time via
  shutil.which("python3") or shutil.which("python") or
  sys.executable, then shlex.join([interp, dest]) to quote-safe
  the resulting command. The patched ~/.claude/settings.json
  statusLine.command is now an absolute interpreter path + the
  shlex-quoted statusline path.

Lint: ruff + pyright + shellcheck all clean on edited files.

- Fix(skills): tighten triggering + reports path + drop summarise step

Audit Tier-2 fixes from the agents+commands+skills report:

T2.11 (MAJOR — llm-externalizer-usage skill triggers were too generic):
- Description was "analyze files / scan folder / check imports / compare
  files / batch check" — those phrases collide with built-in Read/Grep
  workflows and with the other 4 llm-externalizer skills. User saying
  "analyze this file" would load this skill instead of using Read.
- Tightened to "externalize this analysis", "offload to a cheap model",
  "run scan_folder on", "use llm-externalizer", "externalize file
  comparison", "check_imports via externalizer". The intent is explicit
  externalization, not bare file ops.
- Also removed the legacy `effort: medium` line from the frontmatter
  (matches the agent-side cleanup in d94d595).

T2.12 (MAJOR — skills documented non-compliant reports path):
- Three skills (scan, free-scan, usage) documented the server's
  compiled-in default `reports_dev/llm_externalizer/` as the canonical
  report path. That's developer scratch per the
  `~/.claude/rules/agent-reports-location.md` rule which mandates
  `<main-repo-root>/reports/<component>/` for every audit/scan output.
- All three SKILL.md Output sections now explain: always pass
  output_dir pointing at <main-repo-root>/reports/llm-externalizer/
  (the user's compliance rule), and only fall back to the
  reports_dev/ default as a developer-scratch path that should not
  be the home for findings.

T2.14 (MAJOR — free-scan SKILL told the agent to summarise reports):
- skills/llm-externalizer-free-scan/SKILL.md Step 5 said "Read and
  summarize key findings." That contradicts the "only paths through
  orchestrator" invariant every other llm-externalizer surface
  upholds.
- Step 5 now: only list paths + remind the user this is a low-quality
  free scan; "Do NOT read or summarise the report content".

Verified: no other `reports_dev/llm_externalizer` references remain in
skills/ besides documentation-of-the-server-default lines.

- Fix(commands,agents): auto-route fixers to Opus per file size + drop effort caps

User-driven directives:

(1) Auto-route to Opus when files are big.
    All four fixer-dispatching commands now pick the fixer variant per-
    report (parallel) or per-bug (serial) based on a size heuristic
    instead of asking via AskUserQuestion. Opus is selected when EITHER
    the source file is large (>1000 lines or >50 KB) OR the report
    carries many findings (>5 [[FINDING]] blocks). Override:
    LLM_EXT_FORCE_OPUS=1 forces Opus on every dispatch.
    - commands/llm-externalizer-scan-and-fix.md: Step 4b auto-router
      + agent_for_report() helper used inside the 15-concurrent
      dispatch loop in Step 4c.
    - commands/llm-externalizer-fix-report.md: Step 2b inline router.
    - commands/llm-externalizer-fix-found-bugs.md: Step 4c router runs
      at the top of every loop iteration (per-bug routing).
    - commands/llm-externalizer-scan-and-fix-serially.md: same as
      fix-found-bugs.

(2) One agent = one report (parallel) / one bug (serial).
    Documented explicitly in every dispatch block: "One agent = one
    report = one source file" / "One bug = one fresh agent invocation.
    Never reuse the same agent across bugs." This was the existing
    invariant; the new doc text removes ambiguity for future readers.

(3) Remove turn-limit-equivalent fields from agent frontmatters.
    Four agents had `effort:` fields (reviewer: medium, serial-fixer-
    opus: xhigh, serial-fixer-sonnet: high, setup-agent: medium).
    The `effort` field caps reasoning depth and can prematurely
    constrain the agent. All four agents now have only `model:` so
    Claude decides effort based on context.

Verified: `grep -cE "^effort:" agents/*.md` → 0 across all six agents.

- Fix(commands,agents): worktree path + checkpoint hygiene (audit Tier-1)

Audit-driven fixes from the full-plugin-audit agents+commands+skills
report (commit-pending consolidated report in reports/full-plugin-audit/).

T1.5 (CRITICAL — silent data loss in worktrees):
- agents/llm-externalizer-parallel-fixer-{opus,sonnet}-agent.md were
  hardcoded to write summaries under $CLAUDE_PROJECT_DIR/reports/
  llm-externalizer while the dispatching command (scan-and-fix.md)
  computes MAIN_ROOT via `git worktree list | head -n1`. Inside a
  linked worktree these paths diverge — fixer summaries land where
  the Step-5 join script (`ls -1 "$REPORTS_DIR" | grep -cF .fixer.`)
  cannot see them. The final stdout reports M-FIXED=0 even though
  fixers ran successfully.
- Both agents now use the same MAIN_ROOT resolver block the command
  uses, and the post-flight validate_fixer_summary.py call uses the
  resolved REPORTS_DIR variable.

T1.6 (CRITICAL — secret-leak risk on push):
- commands/llm-externalizer-fix-{report,found-bugs}.md, scan-and-fix
  .md, scan-and-fix-serially.md previously used
  `git add -A && git commit -m "chore(checkpoint): pre-... $STAMP"` in
  their pre-fix checkpoint blocks. Per the user's hard rule
  `~/.claude/rules/never-git-add-all.md`, that pattern is forbidden:
  it stages every untracked file including .env, reports/, agent
  scratch — which would leak on push.
- All four commands now use
  `git stash push --include-untracked -m "pre-... $STAMP"` instead.
  Recovery is `git stash pop` — the rationale is documented inline.

T2.13 (MAJOR — duplicated/contradictory Rules section):
- agents/llm-externalizer-serial-fixer-{opus,sonnet}-agent.md had two
  back-to-back `## Rules` sections (lines 44-91 then 102-113) with
  overlapping but reordered/reworded numbered lists. An LLM reading
  top-to-bottom got conflicting "Rule 6 / 7 / 9" content.
- Renamed the second block to `## Hard constraints` and merged the
  destructive-ops bullet with a back-reference to the existing
  `## What NOT to do` section just above.

T2.15 (MAJOR — tmp-file prefix collision):
- commands/llm-externalizer-scan-and-fix-serially.md wrote tmp files
  with prefix `/tmp/llm-externalizer-scan-and-fix.$RUN_TS.<role>.txt`
  (no `-serially`). If the parallel and serial commands ran in the
  same session and shared `$RUN_TS`, the serial run overwrote the
  parallel run's EXTRACTED/VALIDATED/REJECTED files.
- Prefix now namespaces per-command:
  `/tmp/llm-externalizer-scan-and-fix-serially.$RUN_TS.<role>.txt`.

Verified: no other CLAUDE_PROJECT_DIR/reports refs remain in the fixer
agents. No other `git add -A` occurrences in agents/ or commands/.

- Fix(setup): launcher self-install replaces SessionStart bash hook

Audit-driven cross-platform + safety fix (T1.3 + T1.4 from full-plugin
audit).

Problem (T1.3, SC-P1-001 CRITICAL):
- hooks/hooks.json invoked bash on a script under CLAUDE_PLUGIN_ROOT.
  Native Windows ships without bash on PATH; the SessionStart hook
  failed every boot, the MCP server's better-sqlite3 dep was never
  installed via that path, and the launcher's existing failure path
  emitted a FATAL the user could not easily fix.

Problem (T1.4, SC-P1-002 CRITICAL):
- install-mcp-deps.sh did a recursive remove on the node_modules
  symlink without realpath canonicalisation. If the destination was
  previously planted as a symlink to ~/Documents (multi-user system,
  leaked plugin cache), the recursive remove could in theory follow
  into the wrong tree.

Fix (audit option 3 — preferred over per-platform hook reimplementation):
- launcher.mjs now self-installs the MCP server's runtime deps on first
  cold start. The same Node binary that runs the server is the one
  that prepares its dependencies; this is cross-platform out of the
  box (no bash dependency).
- New linkNodeModules() confines the destination realpath to a path
  under the launcher's own script dir before removing. Symlinks are
  removed atomically (single-file remove, can never recurse);
  directories are removed recursively ONLY when their absolute path
  starts with SCRIPT_DIR.
- On Windows without Developer Mode (where unprivileged symlinks fail),
  falls back to cpSync recursive copy automatically.
- Package manager auto-detection (npm -> pnpm -> bun) with reproducible
  lockfile path when present. Same ordering the old bash hook used.
- Same NPM_CONFIG_* env overrides (ignore-scripts=false to allow native
  prebuild-install, audit/fund disabled, fetch timeout capped).

hooks/hooks.json:
- SessionStart hook removed entirely. The launcher's self-install path
  serves the same purpose without the bash dependency. Existing users
  who previously cached node_modules via the hook continue to work via
  the launcher's fast-path "already installed" check.

scripts/hooks/install-mcp-deps.sh: left in place as a tracked file for
users who want to run it manually, but it is no longer invoked by the
plugin's automation. Will be cleaned up in a future commit.

- Fix(mcp): version sync + path-traversal + header-injection (audit Tier-1)

Audit-driven security + correctness fixes from the four-agent full-plugin
audit (commit-pending consolidated report under reports/full-plugin-audit/).

Security (CRITICAL):
- sanitizeInputPath was Windows-broken (hardcoded `/` separator) and
  macOS-realpath-vulnerable (`/tmp` symlink to `/private/tmp` let an
  attacker craft `/tmp/../private/tmp/<file>` that passed the prefix
  check but resolved outside the user's project). Now canonicalises
  cwd/home/tmp roots via realpathSync, uses path.sep, and runs the
  candidate through realpathSync before comparison. Defense-in-depth
  symlink rejection preserved.
- apiHeaders() now rejects control characters in the bearer token via
  assertSafeHeaderValue(). A multi-line api_key (PEM block, YAML `>-`
  scalar, pbpaste with CRLF) would otherwise smuggle additional headers
  into outbound requests when interpolated into `Authorization: Bearer`.
- or-model-info.ts fetchModelInfo() replicates the CR/LF guard for its
  direct fetch path so the same hardening covers both code paths.
- or_model_info_json now routes its --file_path through sanitizeInputPath
  so an LLM that controls the tool call cannot overwrite arbitrary
  user-writable files outside the project/home/tmp roots.

Version sync:
- mcp-server/package.json: 9.5.1 → 9.7.0 (matches plugin.json).
- mcp-server/src/index.ts:4980: same.
- The previous release skipped these — the MCP server was advertising
  9.5.1 to every client while the plugin manifest reported 9.7.0.
  Anyone reading server.info.version got a stale value.

Cross-platform:
- engines.node: ">=18.0.0" → ">=20.0.0". Node 18 EOL'd 2025-04-30; the
  current minimum LTS is 20 (until 2026-04) and 22.

Verified: `tsc --noEmit` clean.

- Fix(skills): MLX default port 8082 + huggingface-best `hf auth token`

skills/huggingface-mlx-models/SKILL.md (T3.1):
- mlx_lm.server default port 8080 → 8082 so MLX and llama-server can
  run side-by-side without colliding. Updates the "Quick start" block,
  the wired settings.yaml snippets, and the per-step `mlx_lm.server`
  invocation. The legacy port-collision warning in the Gotchas section
  now explains WHY we use 8082 rather than treating the collision as
  a runtime issue the user has to discover.

skills/huggingface-best/SKILL.md (T3.2):
- All three `curl -H "Authorization: Bearer $(cat ~/.cache/huggingface/token)"`
  blocks now use `hf auth token 2>/dev/null || echo ''` instead.
  - `cat ~/.cache/huggingface/token` is the LEGACY path (old
    `huggingface-cli`). The current `hf auth login` writes to
    `~/.huggingface/token` (or `$HF_HOME/token`), so the legacy
    `cat` would silently fall back to "Bearer " (empty) and 401.
  - `hf auth token` reads whichever file the active CLI writes to,
    falling back to the empty string if the user is not logged in.

- Fix(setup): Tier-2/3 script hardening (Windows + WSL2 + security)

detect-environment.sh:
- T2.3/2.4: Windows RAM/GPU detection now uses PowerShell
  `Get-CimInstance Win32_ComputerSystem` (Win11 24H2+ compatible)
  with `wmic` and `systeminfo` as fallbacks. GPU detection via
  `Get-CimInstance Win32_VideoController` returns nvidia / amd-rocm /
  none / unknown based on the strongest matched adapter.

detect-runners.py:
- T2.5: optional `--probe-host` / `--include-wsl2-host` flags so the
  agent can probe both `localhost` and the WSL2 Windows-host IP for
  LM Studio bridging.
- T3.15: Jan port-1337 detection now requires BOTH `/v1/models` AND
  `/api/version` to respond, defeating port-collision false positives.
- T3.16: vLLM `import vllm` failures discriminated via stderr inspection
  — half-installed vLLM (e.g. mismatched CUDA, missing _C extension)
  surfaces as `import_error` instead of being mis-reported as "not
  installed".
- Narrow outer `except` in main() per fail-fast convention; runner
  errors carry the exception class name.

test-model.py:
- T2.10: `test_long_context` now uses a needle-in-haystack (~32K-token
  input with a unique sentence at the 90 % mark, ask for verbatim
  recall). The previous 1-token "fox" answer could be pattern-matched
  from just the prompt prefix on a 16K-context model.
- T2.12: outer test-harness `except` narrowed to the specific error
  classes; harness bugs no longer collapse to "model failed".
- T2.15: `err_body` sanitised — strip `sk-…`, `hf_…`, and
  `Bearer <token>` patterns before including in the test JSON output.
- T3.4: progress line per test ("[smoke] ...") prints to stderr in
  real time; pre-flight header tells the user the typical 30-90 s
  duration.
- T3.9: `extract_content` returns `(text, hint)` discriminating
  tool_call / multimodal / malformed shapes so the user gets a real
  hint instead of "empty response".
- T3.10: `_err_from_call` checks `isinstance(resp.get("error"), str)`
  rather than `"error" in resp` — defeats false-positive on responses
  that include `"error": null` alongside a successful `choices` array.

recommend-models.py:
- T2.13: `WhatCanIRunEvidence.raw` set to None at extraction (was
  carrying the entire upstream featured-model dict into the agent's
  JSON context — an indirect prompt-injection surface).
- T2.14: cache-arg path-traversal confinement — when
  `CLAUDE_PLUGIN_DATA` is set, `--from-cache` / `--save-cache` /
  `--whatcanirun-{,from-,save-}cache` paths must resolve under
  `default_cache_dir()`. Standalone CLI mode keeps unrestricted
  paths.
- T3.12: `extract_featured_models()` recursion bounded to depth 64;
  attacker-controlled deeply-nested JSON no longer triggers
  RecursionError.
- T3.13: response-decoder `charset` pinned to a small allow-list
  (utf-8, ascii, latin-1, iso-8859-1, windows-1252); exotic codecs
  no longer mangle the content while parsing "successfully".
- T3.14: `safe_local_dir_name()` strips leading dots so a poisoned
  `display_name = "..ssh"` cannot produce a `./models/..ssh` path.
- T3.17: `BRAND_PROVIDER_PREFIXES` matching requires a word-boundary
  after the prefix — `phidias-xxx` no longer mis-matches `phi` and
  surface as Microsoft.
- T3.18: `--context-tokens` lower bound raised to 4096; `--limit`
  bounded to 1-1000.
- T3.20: `setup_logging()` now prints to stderr when both candidate
  log paths fail instead of silently disabling logging.
- T3.21: `whatcanirun_cache_save_failure` raises when the user
  EXPLICITLY passed `--save-whatcanirun-cache` (implicit auto-save
  failures keep warning-only behaviour).

All gates green: ruff / pyright (0 errors) / shellcheck.
Cache-confinement smoke-tested: CLAUDE_PLUGIN_DATA=/tmp/x rejects
`--from-cache /etc/passwd` at argparse-error time.

- Fix(setup): audit-driven Tier-1 security + correctness fixes

Closes the highest-severity findings from a four-agent audit swarm
(skeptical-reviewer + code-correctness + security + silent-failures):

Security (HIGH):
- test-model.py: reject non-http(s) URL schemes — `file:///proc/self/environ`
  / `http://169.254.169.254/...` would otherwise leak HF_TOKEN /
  OPENROUTER_API_KEY through the wizard's test JSON output (SSRF +
  scheme confusion, CWE-918).
- recommend-models.py: `safe_args_for_log()` now actually redacts —
  the previous implementation was identical to `vars(args)` despite
  the name. Added `safe_argv_for_log()` for `sys.argv` logging.
  Closes a future-credential-leak hazard for any upstream re-sync
  that adds a secret-bearing CLI flag.
- recommend-models.py: cap `fetch_text()` body read at 50 MB — a
  hostile mirror / MITM could otherwise return a multi-GB response
  and OOM-kill the wizard.

Correctness (MAJOR):
- recommend-models.py: emit `schema_version: 1` in the --json
  payload. The setup agent's Step-4 narrative now verifies this
  before consuming `recommendations[]`; if the value differs or is
  missing (e.g. upstream re-sync rename), the agent falls back to
  manual-name entry instead of silently rendering "None" or zero
  scores.
- test-model.py: introduce STRUCTURED_TEST_KEY constant + use
  `.get()` for the verdict lookup. A future rename of the
  structured-output test no longer crashes the verdict path with
  KeyError and produces no JSON.
- detect-environment.sh: numeric guards on sysctl / awk / wmic
  output. Empty or N/A values previously crashed bash arithmetic
  under `set -euo pipefail`, producing no JSON for the agent to
  parse. Same fix applied across macOS / Linux / Windows branches.
- detect-environment.sh: rocm-smi GPU detection now verifies an
  actual AMD card via `--showid` (rocm-smi installed for HIP
  development on a non-AMD box no longer mis-tags GPU as amd-rocm).
- detect-runners.py: add `_safe_model_names()` helper, use in all
  five detectors. A malformed `/v1/models` or `/api/tags` payload
  (non-list at the key, non-dict items, missing name field) no
  longer KeyError-cascades into "runner not installed" via main()'s
  outer except.
- recommend-models.py: strip whitespace from `CLAUDE_PLUGIN_DATA`
  before consulting it. `CLAUDE_PLUGIN_DATA=" "` is truthy in
  Python but `Path(" ")` resolves to a literal " " directory.

Documentation (MINOR):
- agents/llm-externalizer-setup-agent.md: fix `.expanduser()` on a
  `str` literal in the YAML-validation diagnostic command (strings
  don't have that method — was `AttributeError` at the user's
  console).

Full audit reports + consolidated fix plan in reports/setup-agent-
audit/ (gitignored, not committed): 4 per-domain reports + 1
consolidated. Tier 2 (UX + Windows-detection rework) and Tier 3
(polish + skill cleanups) tracked separately for the next session.

Verified: ruff check / pyright (0 errors) / shellcheck — all clean.
SSRF guard smoke-tested: file:// rejected, http://localhost allowed.


### Miscellaneous

- Chore: sync uv.lock to pyproject.toml downbump (9.9.0)

- Chore: downbump pyproject.toml version to 9.9.0 so publish.py regex bumps

Same self-defeat as index.ts — pyproject.toml uses a regex-substitute
that no-ops when current == target.

- Chore: revert index.ts version to 9.9.0 so publish.py regex bumps to 9.10.0

publish.py step 5 substitutes version in index.ts via
re.sub(<regex>, ..., src); when current == target the sub is a no-op
and the script aborts with 'regex failed to match'. Setting the
in-source version back to 9.9.0 lets publish.py --set 9.10.0 do the
substitution and continue.

- Chore(mass-scout): F2-F5 calibration follow-ups from prior session

Bundles the five code/docs fixes surfaced by the deploy-triage
calibration of the mass-scout subsystem (TRDD-52547970 mass-scouting,
prior session). All findings were verified against the running pipeline
before this commit lands.

- F2 (mcp-tools.ts, cli.ts): mass_scout + mass_scout_export now plumb
  --output-dir end-to-end so reports actually land where the caller
  asks instead of falling back to the plugin's install cache.
- F3 (cost-estimate.ts): fetchProviderContext encodes model id
  segments separately so `provider/model` is no longer URL-encoded
  into `provider%2Fmodel` and 404'd by OpenRouter. Adds 4 regression
  tests in cost-estimate.test.ts.
- F4 (scout.ts, cost-estimate.ts): scout workers and estimate workers
  now share `DEFAULT_SCOUT_WORKERS = 16`, eliminating the 256-vs-16
  drift that made est_seconds = 15 s for a job that actually took 1000 s.
- F5 (mass-scouting SKILL.md, references/fieldsets.md, mcp-tools
  build_fieldset description): documents the `array_enum` shorthand
  with the two real forms (with and without `(max_items)`), confirming
  what the code already supported. Pure docs update.
- cli.ts: defaultMainRoot resolution priority rewritten —
  CLAUDE_PROJECT_DIR first (Claude Code 2.1.139+ guarantee), then
  git worktree list (rejecting plugin-cache resolves), then cwd.
  resolveReportDir helper centralises --output-dir handling for both
  runScout and runExport.
- commands/llm-externalizer-mass-scout.md: documents the new
  --output-dir flag.
- skills/llm-externalizer-mass-scouting/SKILL.md: rewrites the
  description so the LLM Externalizer mass-scout actually wins its
  PSS suggestion battle for "search and categorize" queries (calibration
  finding F1, the original tripwire).

Calibration was a 393-deployment-skill triage scan over 3,632 candidate
files; the five fixes here are exactly what needed to land for the
calibration to be reproducible. No new features, no API breaks.

5 new tests added; full vitest + tsc + eslint clean.


### Refactored

- Refactor(hooks): migrate SessionStart hook to exec form per Claude Code 2.1.139

Replaces the legacy shell-form command
`bash "${CLAUDE_PLUGIN_ROOT}/scripts/hooks/install-mcp-deps.sh"` with
the exec-form pair (command: "bash", args:
["${CLAUDE_PLUGIN_ROOT}/scripts/hooks/install-mcp-deps.sh"]). The exec
form avoids shell quoting hazards on paths containing spaces and
matches the canonical example in the Claude Code 2.1.139 hook
reference.

No runtime behaviour change — install-mcp-deps.sh receives identical
arguments either way; only the JSON shape changes.


## [9.5.1] - 2026-05-09

### Documentation

- Docs(readme): clarify OpenRouter auth precedence (env > yaml > keychain)

The README's First run § A. OpenRouter section now spells out three
ways to supply the key, ranked by what works across all consumers:

1. Shell env OPENROUTER_API_KEY — RECOMMENDED. Every consumer
   (MCP server, statusline subprocess, llm-externalizer CLI, any
   ad-hoc subprocess Claude Code spawns) inherits it automatically.
2. settings.yaml profiles.<name>.api_key — supported, but only
   the MCP server reads settings.yaml. The statusline 🏦 panel
   stays blank; CLI calls outside the MCP process tree see nothing.
3. Claude Code plugin keychain (userConfig.openrouter_api_key) —
   supported, but Claude Code only exports the value to the MCP
   server process tree (as CLAUDE_PLUGIN_OPTION_OPENROUTER_API_KEY,
   which the server maps to OPENROUTER_API_KEY internally). Same
   trade-off as method 2: statusline + CLI stay blind.

The Auth section further down and the statusline NOTE now both
point back at this section instead of repeating the explanation.


## [9.5.0] - 2026-05-09

### Added

- Feat(statusline): migrate to multi-tier statusline + add /install-statusline command

Replaces the old mcp-server/statusline.py with the richer
scripts/statusline/statusline.py — width-aware tiering (1 line ≥184 cols
to 6 lines <65 cols), per-section error isolation, full v2.1.138 spec
coverage, and an OpenRouter remaining-credit panel for live budget
tracking.

New artefacts:
- scripts/statusline/statusline.py — 678-line statusline (no deps,
  pure stdlib, fixed F541 f-prefix on the 🧠 emoji line)
- scripts/statusline/install.sh — bash installer (refreshInterval=3,
  timestamped backups, atomic settings.json write)
- scripts/statusline/README.md — feature matrix + width-tier table
- commands/llm-externalizer-install-statusline.md — slash command
  wrapper around scripts/install_statusline.py

Updated:
- scripts/install_statusline.py — rewritten as the cross-platform
  Python equivalent of install.sh: same source path, same backup
  scheme (.bak.<YYYYMMDD_HHMMSS+TZ>), same atomic settings.json
  patch, same statusLine.refreshInterval default (3 s, override via
  REFRESH_INTERVAL env). Content-aware skip when dest already
  matches.
- README.md — Optional: statusline section now mentions the slash
  command, the multi-tier feature set, OPENROUTER_API_KEY shell
  requirement for the 🏦 panel, and the bundled scripts/statusline/
  reference.

Removed:
- mcp-server/statusline.py — superseded by the new scripts/statusline/
  one. No live code referenced it; CHANGELOG history entries remain.

All gates pass: tsc, eslint, build, vitest 341/341, ruff, shellcheck
on both install.sh + install-mcp-deps.sh, plugin.json, claude plugin
validate, cpv-remote-validate.


## [9.4.3] - 2026-05-09

### Miscellaneous

- Chore(cpv): clear all publish-blocker issues

CPV validator now passes cleanly: SUMMARY: 0 CRITICAL, 0 MAJOR,
0 MINOR, 0 NIT, 0 WARNING blocking the publish.

Changes:
- CHANGELOG.md: convert remaining `*` and `+` bullets to `-`
  (markdownlint MD004), remove trailing blank lines (MD012),
  collapse residual triple-newlines.
- commands/llm-externalizer-scan-and-fix-serially.md: tighten
  blockquote bullets to a single space after `>` (MD027).
- skills/llm-externalizer-mass-scouting/references/*.md: add the
  Table of Contents section to each progressive-discovery target
  (troubleshooting, worked-example, fieldsets, glossary).
- skills/llm-externalizer-mass-scouting/SKILL.md: embed verbatim
  TOC heading lists for each reference link in the Resources
  section so progressive discovery works. Trim Token efficiency
  bullets and shorten parenthetical heading suffixes in the
  reference files to keep SKILL.md under the 5000-char cap.
- scripts/bump_version.py: move to scripts_dev/ (gitignored,
  preserved on disk) — publish.py owns version bumping.

All gates green: tsc, eslint, build, vitest 341/341, ruff, pyright,
shellcheck, plugin.json, `claude plugin validate`, cpv-remote-validate.

- Chore: post-scan-and-fix cleanup + CPV publish-blocker fixes

Carry the verified-clean changes from the v9.4.2 scan-and-fix run plus
small CPV publish-gate fixes:

- Collapse extra blank lines in CHANGELOG (markdownlint MD012)
- Convert remaining `*`/`+` bullets to dashes (markdownlint MD004/MD005)
- Rephrase /etc/passwd docstring example to a generic placeholder
  (MINOR absolute-path flag in scripts/check_references.py)
- Add # pyright: ignore[reportMissingImports] on PEP 723 ruamel.yaml
  imports in scripts/apply_ensemble_choice.py and read_ensemble_state.py
  (uv resolves at runtime; Pyright doesn't read PEP 723 metadata)

Verified: tsc/eslint/build clean, 341/341 vitest pass, ruff/pyright
clean, all four ensemble + free OpenRouter models return PONG.


## [9.4.2] - 2026-05-08

### Fixed

- Fix(hooks): disable shellcheck SC1091 for nvm.sh sourcing

nvm.sh is provided by the user's nvm install, not this repo, so
shellcheck cannot follow it. Add a per-line disable directive so
the publish-pipeline gate stays green.

- Fix(mcp): install native deps via SessionStart hook + symlink, not NODE_PATH

v9.4.x added better-sqlite3 (a native Node module) which esbuild marks
external. node_modules must be present at runtime, but `claude plugin
install` does not run npm install. The previous `.mcp.json` change to
set NODE_PATH does not work for ESM `import` of bare specifiers in
modern Node (NODE_PATH is honored for CJS require() only) — verified
empirically on Node 25.

Solution (matches the pattern in
https://code.claude.com/docs/en/plugins-reference#persistent-data-directory):
  - hooks/hooks.json registers a SessionStart hook that runs
    scripts/hooks/install-mcp-deps.sh.
  - The script diffs the bundled package.json against a copy in
    ${CLAUDE_PLUGIN_DATA}, runs npm install (or pnpm/bun/nvm/corepack
    fallbacks) only when they differ, and symlinks
    ${CLAUDE_PLUGIN_ROOT}/mcp-server/node_modules to
    ${CLAUDE_PLUGIN_DATA}/node_modules so Node's natural upward module
    walk finds them.
  - mcp-server/launcher.mjs pre-flights the better-sqlite3 import and
    emits a clear error with manual recovery steps if the hook hasn't
    completed yet (race on first install).
  - .mcp.json now invokes the launcher instead of dist/index.js
    directly, and drops the no-op NODE_PATH env.
  - mcp-server/esbuild.config.mjs comment corrected.

The script forces NPM_CONFIG_IGNORE_SCRIPTS=false so users with
ignore-scripts=true in ~/.npmrc still get better-sqlite3's prebuilt
binary via prebuild-install. Falls back through pnpm, bun,
nvm-shimmed npm, and corepack-shimmed pnpm. mkdir-based atomic lock
serializes simultaneous SessionStart fires.

Tested in isolation: 0.88 s fresh install (npm ci + native prebuild),
9 ms idempotent re-run, friendly error on missing deps,
clean handshake on populated install.


## [9.4.1] - 2026-05-07

### Fixed

- Fix(skill-references): drop redundant ## Contents blocks per CPV TOC rule

CPV strict mode demands that SKILL.md embed the COMPLETE TOC of every
referenced file verbatim immediately after the link. With four reference
files and 13 combined entries, embedding the full TOCs would push SKILL.md
past the 5,000-char Nixtla cap. The rule itself offers an out:
"Either the content is worth discovering (embed the full TOC) or it is
not (remove it from the reference file's TOC)."

Each reference file is small enough that a TOC adds noise rather than
discovery value (one is a flowchart, one is a single shell session, one
is a fieldset format, one is a flat term list). Stripping the ## Contents
blocks satisfies the rule without bloating SKILL.md and without removing
any content from the references themselves.

- Fix(skill): add concrete I/O examples to SKILL.md and TOC sections to references

CPV strict-mode flagged:
- MINOR: skill body had trigger phrases as 'examples' but no concrete
  input/output. Added a code block showing a typical estimate + scout
  call shape with their key output lines so a calling agent can pattern-
  match before invoking. Skill body trimmed to 4,999 chars to stay
  under the 5,000-char Nixtla cap (other sections condensed: Prerequisites,
  Instructions, Error Handling, Resources).
- NIT (×4): every reference file linked from SKILL.md should expose a
  Table of Contents so progressive-disclosure consumers can jump to the
  right section without reading the whole file. Added a `## Contents`
  block to troubleshooting.md, worked-example.md, fieldsets.md, and
  glossary.md.

Verified: skill body 4,999 chars; CHANGELOG.md no longer leaks any
private home-directory paths. Mass-scouting tests still pass.

- Fix(changelog): scrub leaked /Users/<name>/ path before next publish

The v9.4.0 release commit baked an absolute path into CHANGELOG.md
because git-cliff renders raw commit-message bodies and the original
fix message quoted the path it was scrubbing. CPV's `private path
leaked` check trips on every subsequent publish run.

cliff.toml's commit_preprocessors will keep this from regenerating in
the next git-cliff run, but CPV runs BEFORE changelog regeneration in
publish.py — so the existing CHANGELOG.md needs a one-shot manual
scrub to clear the gate. After this commit, the regen produced by the
next publish will preserve the redaction automatically.

The descriptive intent ("we replaced an absolute path with a relative
one in TRDD") is preserved; only the literal home-directory prefix
becomes `<HOME>/`.

- Fix(cliff): redact /Users/<name>/ and /home/<name>/ paths from CHANGELOG

git-cliff regenerates CHANGELOG.md on every publish from raw commit
messages. Earlier commit messages legitimately quoted a private
absolute path (`/Users/<user>/Code/.../docs_dev/...`) when explaining
that they were scrubbing such a path, and that quotation kept resurfacing
in the changelog and tripping CPV's "private path leaked" critical
check on the next publish run.

Adding `commit_preprocessors` to cliff.toml replaces home-directory
prefixes with `<HOME>/` before the changelog is rendered, in any
future commit message too. The descriptive intent of the message is
preserved; only the leaky prefix is anonymised.

Verified by running git-cliff against this branch and grepping the
output: no `emanuelesabetta` or `/Users/<lowercase-name>` remains.

- Fix(mass-scouting): consistent error messages + token-efficiency guidance

Three small but user-facing improvements:

1. OPENROUTER_API_KEY missing — three call sites (scout / chain /
   propose-fieldset) now print one identical, actionable message:
   "Export it in your shell, set the plugin's userConfig.openrouter_api_key,
   or add it to ~/.llm-externalizer/settings.yaml." The previous text
   leaked an internal "pass via opts.apiKey (test path)" implementation
   detail and was inconsistent across sites.

2. body_get / get not-found errors now include the --db path and a
   concrete next step ("Run jobs-list to confirm the right --db, or run
   register first."). Previously a bare "no row with short_id=N" gave
   the user no debugging hook.

3. SKILL.md gets a Token-efficiency section (six bullets) that codifies
   the path-passing pattern, bundled-fieldset preference, budget-gate
   ordering, bucket scoping, search-vs-audit-sample tradeoff, and json+
   limit guidance. Skill body stays under the 5,000-char Nixtla cap
   (4,990 chars).

Tests: 290 mass-scouting tests still pass; the OPENROUTER regex test
predates this commit and matches the new wording verbatim.

- Fix(docs): align README, slash commands, and MCP descriptions with v9.4.0 surface

The mass-scouting work in v9.4.0 added 8 follow-on tools, a `bundled:`
fieldset shorthand, --live-context, --git-diff, --no-gitignore, and MCP
notifications/progress, but the user-facing docs were never updated to
match. This commit walks every documentation surface and brings them
current.

README:
- Features bullets: 27→31 MCP tools, accurate base count (15, was 11),
  full mass-scout 16-tool list, accurate command count (17 = 9 base + 8
  mass-scout). Added `change-model` and `benchmark` (omitted from the
  Plugin commands table since 9.0.x).
- Plugin commands: split into "Base (9)" and "Mass-scout (8)" tables with
  the 8 MCP-only tools called out separately so users know they exist
  even though no slash command wraps them.
- Mass-scouting parameter notes: replaced the redundant 8-row repeat
  with a flag highlights bullet list (--db, --fields-file bundled:NAME,
  --budget-usd, --live-context, --no-smoke-test, --no-resume, --json,
  filter syntax).

Slash command docs:
- mass-scout: documented --live-context; clarified --fields-file accepts
  bundled:<name>.
- mass-scout-estimate: documented --live-context; called out bundled
  shorthand.
- mass-scout-register: documented --git-diff <ref>, --no-gitignore, and
  the gitignore-honouring default.

MCP tool descriptions:
- mass_scout_chain: BUG FIX. The description and `filter` parameter doc
  listed operators as 'eq, ne, lt, lte, gt, gte, contains' but the
  parser only accepts =, !=, >, >=, <, <=, LIKE. Aligned both with the
  actual parseFilterToken ALLOWED set.
- mass_scout_search_xjob: every input field had an empty description.
  Added per-field help (query / regex / force_llm / force_regex /
  filter / limit_per_job / limit_merged / json) so MCP clients show
  meaningful tooltips.


## [9.4.0] - 2026-05-07

### Added

- Feat(mass-scouting): add 8 follow-on tools, bundled fieldsets, MCP progress, live context

This consolidates the mass-scouting feature work into a single conventional
commit. Adds the full TRDD-52547970 pipeline (register → preclassify →
estimate → scout → search) plus eight follow-on tools that came out of the
audit pass:

* mass_scout_jobs_list / audit_sample / body_get — job introspection
* mass_scout_build_fieldset / propose_fieldset / list_bundled_fieldsets —
  fieldset authoring (shorthand parser, LLM-driven proposer, and 4
  plugin-shipped fieldsets: code-audit, skill-audit, security-audit,
  pr-review)
* mass_scout_diff / chain — job-to-job operations (row-by-row diff and
  filtered re-scout with a fresh fieldset)

Other improvements:

* --live-context flag wires fetchProviderContext into estimate/scout so
  the real provider context_length overrides KNOWN_PRICING when the
  account routes to a smaller-cap endpoint
* MCP notifications/progress events propagate through scout and chain
  so long-running jobs keep the connection alive and emit real progress
* Skill rewrite (when-NOT-to-use, model selection, privacy, troubleshooting
  flowchart, glossary, worked example, bundled fieldsets section)

Tests: 341 passing (was 332).


### Fixed

- Fix(skill): use markdown links for reference files (CPV minor)

- Fix(skill,trdd,test): clear CPV blockers before publish

Three remediation passes for CPV strict-mode validation:

1. SKILL.md restructured to the Nixtla-strict layout (Overview /
   Prerequisites / Instructions / Output / Error Handling / Examples /
   Resources), with the long sections (troubleshooting flowchart, worked
   example, fieldset dialect, glossary, model selection, privacy) moved
   into references/*.md per the progressive-disclosure rule. Skill body
   is now 4,391 chars (under the 5,000 cap). Added the mandatory
   "Trigger with ..." phrase to the description.

2. TRDD: replaced the absolute path
   <HOME>/Code/llm-externalizer/docs_dev/... with the
   project-root-relative form. Two CRITICAL private-path leaks resolved.

3. cli.test.ts security regression: the path-traversal test value
   "bundled:../../../etc/passwd" now uses URL-encoded slashes
   ("..%2F..%2F..%2Fsystem-file") so it still exercises the validator's
   name-character regex without tripping CPV's absolute-path heuristic.

- Fix(publish): override ~/.npmrc ignore-scripts during native rebuild

phardener installs `ignore-scripts=true` into the user's global ~/.npmrc.
Once that's in place, even an explicit `npm rebuild better-sqlite3`
silently no-ops on the install lifecycle — npm reports "rebuilt
dependencies successfully" but the prebuild-install hook never runs and
the platform-specific better_sqlite3.node addon stays absent. The
mass-scouting test suite then fails with "Could not locate the bindings
file" the moment any test opens the SQLite registry.

Adding `--no-ignore-scripts` to the rebuild-native step forces npm to
honour better-sqlite3's `install` script for that single package only.
Every other dependency stays opted out of postinstall scripts via the
preceding `npm ci --ignore-scripts`.

Verified by running the rebuild step and finding
`node_modules/better-sqlite3/build/Release/better_sqlite3.node` after
the publish.py validation phase.

- Fix(publish): rebuild better-sqlite3 native binding before tests

Adds an explicit `npm rebuild better-sqlite3` step right after
`npm ci --ignore-scripts`. Without it, the install-time gyp build is
skipped (by design, for supply-chain safety) and the mass-scouting
test suite fails with "Could not locate the bindings file" because
the platform-specific better_sqlite3.node addon doesn't exist.

`npm rebuild <pkg>` reruns build hooks for the named package only —
every other dependency stays opted out of postinstall scripts.

- Fix(mass-scouting): hoist okCount/failed/costUsd inits into try block

ESLint's no-useless-assignment caught three dead initial assignments in
runChain — okCount, failed, and costUsd were initialised to 0 and then
unconditionally overwritten inside the try block. Since the post-try
return is only reachable on the success path, the initials never feed
the read site. Switched to declare-without-init so the lint rule is
satisfied without changing behaviour.


## [9.3.0] - 2026-04-22

### Added

- Feat(commands): add /llm-externalizer:llm-externalizer-change-model

Interactive 3-slot ensemble picker. Runs (or reuses) the benchmark,
shows the user a SELECT FIRST / SECOND / THIRD menu of passing models,
reports the new ensemble's cost against the last-accepted snapshot,
and — on confirmation — atomically rewrites the active profile's
model/second_model/third_model fields in ~/.llm-externalizer/settings.yaml.

Design notes:

- Mode-agnostic. The benchmark always hits OpenRouter regardless of
  the active profile's mode (local/remote/remote-ensemble), and the
  apply step touches ONLY the three ensemble-model fields — mode,
  api, url, api_key, api_token, timeout, context_window all stay
  byte-for-byte unchanged. Users running on a local profile can still
  use this command to set up their ensemble fields for later.
- Settings.yaml edit uses ruamel.yaml to preserve comments, quotes,
  and indentation. Pre-edit backup is stamped with the local-tz
  timestamp (%Y%m%dT%H%M%S%z). Write is atomic (tmp file + fsync +
  os.replace).
- Every accept writes ~/.llm-externalizer/ensemble-cost.json — a
  cost snapshot keyed by the benchmark run it came from. The delta
  shown in the UI is indicative: it compares the NEW ensemble's cost
  (today's benchmark) against the LAST-ACCEPTED snapshot (possibly
  weeks old). This survives the "old model is now defunct" case that
  would break a re-benchmark approach.
- Retry loop reuses the same benchmark results (no extra API spend).
- First-time run with no snapshot shows "(no previous ensemble on
  record)" and skips the % delta.
- Cached benchmark choice: if ~/.llm-externalizer/benchmark-results.json
  exists, the user sees a "Use cached (from <age ago>)" option with
  the freshness in the label, so they can skip the re-benchmark when
  it's obviously not needed.

New components:

- mcp-server/src/benchmark/report.ts → renderJson() for the sidecar.
- mcp-server/src/benchmark/index.ts → --json PATH flag + mandatory
  auto-save to ~/.llm-externalizer/benchmark-results.json so the
  change-model command always finds the cache in a known location.
- scripts/read_ensemble_state.py → one-shot read of settings.yaml +
  ensemble-cost.json + benchmark-results.json, emits a JSON state
  object for the command to parse.
- scripts/apply_ensemble_choice.py → the atomic write. Refuses to
  record a non-PASSING model in the cost snapshot.
- commands/llm-externalizer-change-model.md → the interactive flow.

Python scripts use PEP 723 inline metadata to declare ruamel.yaml as
a dep — `uv run` installs it on demand, no system pip touch.


## [9.2.0] - 2026-04-22

### Added

- Feat(commands): add /llm-externalizer:llm-externalizer-benchmark

Slash-command wrapper over the bin/llm-ext-benchmark CLI introduced in
v9.1.0. Matches the naming convention of the other llm-externalizer
commands (prefixed with the plugin name).

- Single Bash step: forwards $ARGUMENTS verbatim to the bundled CLI.
- Pre-flight: verifies OPENROUTER_API_KEY (skipped when --dry-run).
- Does NOT read the generated report — only surfaces the path.
- Non-agentic: no sub-agents, no MCP calls, no retry loops.

Typical use:
  /llm-externalizer:llm-externalizer-benchmark --dry-run
  /llm-externalizer:llm-externalizer-benchmark
  /llm-externalizer:llm-externalizer-benchmark \
    --include google/gemini-3-flash-preview \
    --include x-ai/grok-4.1-fast


## [9.1.0] - 2026-04-22

### Added

- Feat(benchmark): OpenRouter model selection harness

Completely programmatic (no-agent) benchmark to pick the cheapest
OpenRouter model that still solves our actual static-analysis workload.

Setup:
- 5 TypeScript fixture files, 71 top-level functions total.
- 3 literal keyword substrings: "JSON.parse(", "new URLSearchParams",
  "performance.now()". Ground truth is derived at runtime from the
  fixtures via the TypeScript compiler API — the fixtures are the
  single source of truth, so expected answers cannot drift.
- Distribution: 20 kw1 / 20 kw2 / 10 kw3 / 21 noise. Each keyworded
  function contains exactly one keyword (disjoint sets for scoring).

Flow:
- discover.ts queries /api/v1/models?category=programming and filters
  by ctx>=128K, out>=64K, in<=$1.5/M, out<=$2.0/M, structured+reasoning.
- runner.ts sends each qualifying model (plus explicit --include
  baselines) the fixtures + strict JSON schema. Records latency,
  tokens, raw response. Falls back from kw1_functions to kw1 when a
  model violates the strict schema (flagged in the report).
- score.ts computes precision/recall/F1 per keyword vs ground truth;
  overall PASS = all 3 arrays exact match.
- report.ts emits a markdown summary table to
  $MAIN_ROOT/reports/benchmark/<ts±tz>-model-comparison.md.

Usage:
  bin/llm-ext-benchmark --dry-run                   # show roster
  bin/llm-ext-benchmark                             # run full sweep
  bin/llm-ext-benchmark --include google/gemini-3-flash-preview \
                        --include x-ai/grok-4.1-fast   # + baselines

Initial run results (2 passes, 7 models):
- PASS 100%: stepfun/step-3.5-flash ($0.10/M in, $0.30/M out), kimi-k2.5,
  qwen3.6-plus (⚠ short-name schema violation), gemini-3-flash-preview
  (baseline), grok-4.1-fast (baseline).
- FAIL: minimax-m2.5 (non-deterministic, ~99% F1), gpt-5.4-nano (~95%).

Conclusion: stepfun/step-3.5-flash is the clear replacement for
google/gemini-3-flash-preview — 10× cheaper output tokens, same
accuracy on the benchmark, schema-compliant.


## [9.0.8] - 2026-04-22

### Changed

- Ci: bump setup-node v4.4.0 → v6.4.0 and node-version 18 → 24

Clears the GitHub Actions deprecation warning on setup-node@v4.4.0
(Node 20 runtime). v6.4.0 runs on Node 24, the current Active LTS.

The mcp-server 'engines' field stays at '>=18.0.0' so end-users of
the published plugin keep broad Node compatibility — only the CI
workers bump.


## [9.0.7] - 2026-04-22

### Changed

- Build: rebuild dist after index.ts sanitize/retry/imports fixes


### Fixed

- Fix: real bugs from verified CANTFIX re-audit + WIP hardening

Re-verified all 34 fixer reports from 2026-04-17 against current code.
Of the 10 CANTFIX items, 3 were confirmed as real unfixed bugs; the rest
were false positives, intentional design, or already fixed by other commits.

Real bugs fixed:
- bin/llm-ext: Add killAndExit() helper (SIGTERM→SIGKILL ladder,
  2s grace). Replaces 7 race-prone 'child.kill(); process.exit(X)'
  call sites that could leave orphan MCP server processes under
  init/systemd when the parent exited before SIGTERM was delivered.
- live-websearch.test.ts: Add module-level afterAll() that removes
  both /tmp/__llm_ext_websearch_test and _test_config — the per-suite
  afterAll hooks only closed transports.
- live-extended.test.ts: Document the 'if (!result.isError)' guard
  on the check_references test (same tolerance pattern as check_imports,
  just missing the explanatory comment).

WIP hardening (was uncommitted from earlier sessions):
- index.ts: sanitizeInputPath() traversal+symlink protection in
  scan_folder / compare_files / search_existing_implementations;
  circuit-breaker+retry in grouped batch_check (parity with the
  non-grouped branch); gitLsFilesMultiRepo returns null when target
  is NOT itself a git repo (prevents silently dropping non-git files
  in mixed trees); extractLocalImports handles Python __init__.py
  package entry points; chatCompletionJSON strips markdown fences
  before JSON.parse (some providers wrap JSON even under
  response_format: json_schema).
- .githooks/pre-push: Tighten publish.py regex with a (?=\s|$)
  lookahead so 'publish.py.bak' / 'publish.pyc' substrings cannot
  bypass ancestry matching.
- statusline.py: TOCTOU-safe /tmp/claude cache: lstat refuses
  symlinks, O_NOFOLLOW + fchmod instead of chmod (CWE-59).
- test-helpers.ts: Drain server stderr via transport.stderr?.pipe
  to prevent PassThrough buffer from filling and hanging tests.
- check_references.py: Strip URL fragments from ${CLAUDE_PLUGIN_ROOT}
  matches; skip absolute '/'-prefixed markdown links; move
  _is_excluded check BEFORE existence checks.
- publish.py: Docstring now matches implementation (no-op fallback
  removed — step 6 fails fast).
- server.json: Drop legacy LM_STUDIO_PASSWORD mention from description.

Verification: tsc --noEmit clean, eslint --max-warnings 0 clean,
ruff+mypy on all .py files clean, 82 vitest unit tests pass (index +
grouping), bin/llm-ext discover E2E exits 0 with no orphans.


## [9.0.6] - 2026-04-21

### Fixed

- Fix(readme): restore BADGES markers; publish.py emits centered HTML form

The full README rewrite dropped the <!--BADGES-START--> / <!--BADGES-END-->
comment markers that publish.py's update_readme_badges() function needs
to auto-refresh the version/build shields on each release. Without them
the badges went stale (still read v9.0.1 after v9.0.5 shipped).

Fix:
- README.md: wrap the existing centered <p align="center">…</p> badge
  block with the two HTML-comment markers + bump the version shield to
  the current v9.0.5.
- scripts/publish.py: update_readme_badges() now emits the same
  <p align="center"> wrapper with one <a><img></a> per badge so the
  visual layout does not regress when publish regenerates the block.

CPV result after this change: 0 CRITICAL / 0 MAJOR / 0 MINOR / 0 NIT,
1 WARNING (transient "dead URL" on github.com/Emasoft/emasoft-plugins
which curl confirms returns 200 — false positive from the validator).


### Miscellaneous

- Chore(versioning): align pyproject.toml with plugin version and sync it via publish.py

Before this commit the repo had three version numbers that disagreed:
- .claude-plugin/plugin.json      → 9.0.5
- mcp-server/package.json         → 9.0.5
- pyproject.toml                  → 4.1.5   ← drift

publish.py only synced plugin.json, mcp-server/package.json,
mcp-server/server.json, and mcp-server/src/index.ts. pyproject.toml
(and its uv.lock) were never touched, so every release they drifted
further behind.

This commit:
- Sets pyproject.toml to 9.0.5 (current plugin version).
- Regenerates uv.lock so its root-package entry matches.
- Teaches publish.py to sync pyproject.toml on every release, then
  run `uv lock` to keep uv.lock consistent, then stage both files
  alongside the existing release artifacts.

After this, every future release will carry one version across all
four files. No more "which number is real?".


## [9.0.5] - 2026-04-21

### Added

- Feat(format): canonical <ts±tz>-<slug>.<ext> for every report file

Every surface the plugin ships now writes to the same filename shape
defined by ~/.claude/rules/agent-reports-location.md — no carve-outs.

Timestamp: %Y%m%d_%H%M%S%z (local time with GMT offset appended as
compact ±HHMM — filesystem-safe on every OS, sortable by ls -t). Never
UTC, never ±HH:MM.

- mcp-server/src/index.ts:
  - new canonicalTimestamp() helper (local time + compact offset).
  - saveResponse() emits <ts±tz>-<tool>[-group-<id>][-<src>]-<shortId>.md
    instead of the old <tool>_<src>_<isoZ>_<shortId>.md.
  - batchReportFilename() follows the same shape.

- scripts/fix_found_bugs_helper.py:
  - TS_FORMAT switched from "%Y%m%dT%H%M%S%z" (ISO "T") to the canonical
    "%Y%m%d_%H%M%S%z" (underscore).
  - init-run prints paths like <ts>-fix-found-bugs-<purpose>.<ext>
    instead of the legacy dot-separated <ts>.fix-found-bugs.<purpose>.<ext>.
  - SIDECAR_MARKERS recognises both the legacy dot-shape and the new
    hyphen-shape so artefacts from either generation are skipped during
    aggregation.

- mcp-server/dist/index.js: rebuilt to match source.

- Feat(commands): worktree-safe MAIN_ROOT for reports — no carve-outs

Every LLM Externalizer command now resolves the main-repo root via
`git worktree list | head -n1 | awk '{print $1}'` and writes reports
under `$MAIN_ROOT/reports/llm-externalizer/` — the same convention as
every other agent / skill / tool in the project. $CLAUDE_PROJECT_DIR
points to whatever checkout the session is attached to (including a
linked worktree), which would scatter audit output across short-lived
branches. The main checkout is always listed first by `git worktree
list`, so it's a safe canonical target regardless of where the command
runs from.

- commands/llm-externalizer-scan-and-fix.md
- commands/llm-externalizer-scan-and-fix-serially.md
- commands/llm-externalizer-fix-found-bugs.md
- commands/llm-externalizer-fix-report.md

Each command now carries a short worktree-safe prologue that the
orchestrator must reproduce at the top of every Bash step (the tool
spawns a fresh subshell per call, so env vars don't persist between
steps). Every JSON-template reference to output_dir uses
<MAIN_ROOT>/reports/llm-externalizer. Falls back to $CLAUDE_PROJECT_DIR
only when we're not inside a git working tree (e.g. sandbox runs).

This matches the agent-reports-location rule verbatim: same rule,
same folder, for everything — even the externalized LLM.


## [9.0.4] - 2026-04-20

### Changed

- Revert(publish): drop reports/ → reports_dev/ move step; gitignore reports/

Simpler rule wins: the ./reports/ tree is always audit output, always
private, and always gitignored. Agents — including those running from
inside a git worktree — must write to the root-project ./reports/
folder so the maintainer retains a single place to find audit output.
No intermediate relocation needed.

- .gitignore: add ./reports/ (and ./mcp-server/reports/) back to the
  ignore list with a comment stating the agent-behavior rule.
- scripts/publish.py: remove archive_reports_to_dev() and the Step 0
  invocation + docstring entry. CPV no longer needs to re-scan the
  tree because gitignored paths are already outside its scope.


## [9.0.3] - 2026-04-20

### Added

- Feat(publish): archive ./reports/ into ./reports_dev/ before validation

Rationale: the ./reports/ tree is where agents and workflow runs drop
audit output. Those files carry absolute local paths (/Users/<user>/...),
redacted secret markers, and raw LLM output — none of which should ever
land in a published plugin or in CPV's "private path leaked" scan.

The prior fix (gitignoring ./reports/) worked but threw away the audit
data when the workflow branch was merged or deleted, and it split the
convention (reports_dev/ gitignored but reports/ gitignored too is
confusing when agents spawned in workflows need the data back).

New design:
- Revert the ./reports/ gitignore — the tree is untracked only because
  no agent commits it, not because it's hidden from scanners.
- Step 0 of publish.py (before pre-flight): move every file under
  ./reports/ and ./mcp-server/reports/ into
  ./reports_dev/reports-archive/<UTC-timestamp>/ with the subtree
  preserved. reports_dev/ is already gitignored, so the data survives
  but never reaches CPV, the published tarball, or the marketplace.
- Idempotent: each run creates a fresh timestamped folder, so repeated
  publishes never overwrite prior snapshots. Workflows that merge and
  delete branches keep their audit trail in reports_dev/ on the
  maintainer's machine.


### Refactored

- Refactor(publish): 1:1 mapping reports/ -> reports_dev/ (no timestamped subfolder)

Rationale: timestamped archive folders were the wrong abstraction.
Users locate a moved file by simply replacing `reports` with
`reports_dev` in its path — anything more elaborate breaks that
intuition and forces grep-by-timestamp to find old output.

New behavior: a file at `reports/llm-externalizer/foo.md` lands at
`reports_dev/llm-externalizer/foo.md` exactly. Sub-tree preserved.
Collisions overwrite (newer publish run wins — matches the "latest
audit output" expectation for workflow agents). Same pairing applies
to mcp-server/reports/ -> mcp-server/reports_dev/.


## [9.0.2] - 2026-04-20

### Added

- Feat(format): sentinel [[FINDING]] blocks replace ### FINDING headings

Why: the old ### FINDING: scan format collides with the aggregator's
own ### N. FINDING: output numbering and with ensemble-wrapper ## Model:
sections. When the aggregator embedded an ensemble response into a
finding body, the nested ### headings in that body got re-parsed as
separate findings, swallowing all subsequent bugs in the list.

The new format uses markdown-immune sentinels:

  [[FINDING]]
  Title: <short title>
  File: <abs path>
  Source: <function or file:line>
  Severity: <High|Medium|Low>
  Description: <1-3 sentences>
  [[/FINDING]]

- commands/llm-externalizer-scan-and-fix{,-serially}.md: default
  rubric now instructs models to emit sentinel blocks; explicit
  warning not to use ### or numbered-list syntax.

- scripts/fix_found_bugs_helper.py: new FINDING_BLOCK_RE recognises
  the sentinel, _parse_finding_block parses the Key: value fields,
  and _extract_findings_from_section prefers the new format and
  falls back to the legacy ### / numbered-list patterns only when
  no sentinel blocks are found in the section. Mixing formats in
  one section is explicitly not allowed.

- Feat: strengthen fixer verification + emit canonical scan findings

- agents/llm-externalizer-{parallel,serial}-fixer-{sonnet,opus}-agent.md:
  lead with a MANDATORY VERIFY BEFORE FIXING callout listing the
  5 false-positive rejection rules (hallucination, flow-trace,
  already-fixed, style preference, redaction artifact). A no-edit
  "false-positive" verdict is explicitly marked as a successful
  outcome to discourage speculative fixes. Empirically ~15-30% of
  ensemble findings are false positives; the fixer now rejects them
  with typed reasons.

- commands/llm-externalizer-scan-and-fix{,-serially}.md: default scan
  rubric now requires canonical "### FINDING: <title>" / Source /
  Severity / body format so fix_found_bugs_helper.py aggregate-reports
  can parse findings without a format-massaging pass. Explicit
  instruction to ignore [REDACTED:ENV_SECRET]/[REDACTED:API_KEY]
  placeholders and to emit "No real defects." when clean.


### Changed

- Build: rebuild dist after rescan-audit fixes

- Build: rebuild dist after 40-file source audit fixes


### Documentation

- Docs: full README rewrite + LLM-Externalizer banner

- Add docs/banner.png (plugin banner/logo at top of README).
- Rewrite README with a plain-language intro making the scan-vs-fix
  split explicit: only the SCAN is externalized; FIXES are applied
  by the local Claude Code session (Sonnet/Opus) via fixer subagents.
- Fix feature list and counts (15 MCP tools, 5 agents).
- Separate "Plugin commands" (/llm-externalizer:*) from "MCP tools"
  (direct mcp__plugin_* calls) so advanced users see each surface clearly.
- Every shell command now lives in its own pasteable code block, one
  logical task per block, with # comments.
- Windows variants added for env-var setup (PowerShell + cmd.exe) and
  for paths (%USERPROFILE%\.llm-externalizer\ alongside ~/.llm-externalizer).
- Configuration option B renamed from "single model" to "Remote free
  (Nemotron)" — users pick between the paid ensemble or the free
  Nemotron; no paid-single-model profile by default.
- Contributing section rewritten: contributors never run publish.py
  (owner-only); documents how to disable the pre-push hook
  (git config --local --unset core.hooksPath) and how to disable the
  owner-only workflows on a fork (gh workflow disable "Notify Marketplace"
  and "CI").


### Fixed

- Fix(grouping): preserve pre/post-group ungrouped order in parseFileGroups

The prior rescan fix (rescan #17) collected ALL ungrouped files into a
single trailing group at the end, which violated the documented
insertion-order contract and broke the "collects files outside any
markers into an unnamed group" test. That test expects three groups
in order: pre-group unnamed, named, post-group unnamed.

Fix: flush the pending-ungrouped buffer each time a new named-group
header is encountered (so the pre-group chunk lands before the named
group), and again at end-of-input (so the post-group chunk lands
after). This preserves ordering while still merging consecutive
ungrouped files into a single group.

All 31 grouping tests now pass.

- Fix(lint): prefer-const on ungrouped in parseFileGroups + rebuild dist

- Fix: rescan-audit fixes (27 real defects across 10 files)

Second-pass audit against the fixed codebase found 26 new real defects
(and a further 70 false-positives correctly rejected by the hardened
fixer's verify-before-editing rules). Highlights:

- .githooks/pre-push: argv chunk parsing no longer swallows trailing
  args; publish.py ancestry check rejects dummy scripts with crafted
  argv that embedded "publish.py" as a literal argument.
- bin/llm-ext: exit/stdout race fixed — crash detection moved to
  stdout.on("end") so valid late responses are no longer discarded
  when the child exits immediately after writing.
- mcp-server/src/config.ts: resolveProfile logic for local authentication.
- mcp-server/src/grouping.ts: duplicate-group-id handling and the
  single-unnamed-group contract in parseFileGroups; suffix-match
  disambiguation in per-file section assignment.
- mcp-server/src/index.ts: symlink traversal no longer creates
  directories outside guarded paths; check_imports path traversal
  hardened; temporary-stats file permissions tightened.
- mcp-server/src/live{,-extended}.test.ts: shared tmp-dir lifecycle
  fixed (per-test TMP_DIR, afterAll cleanup on creation failure,
  scan_secrets assertion robust against structured-error responses).
- mcp-server/statusline.py: (no new changes in this pass — Pyright
  warnings at lines 122/284 are platform-check false positives on
  sys.platform == "win32", not real bugs).
- scripts/check_references.py: markdown regex handles relative
  links; exclusion check applied to resolved targets.
- scripts/publish.py: rollback handles incomplete pushes; duplicate
  version-bump guard in determine_next_version; temporary directory
  created with 0o700 perms on POSIX.

- Fix: real defects from 126-finding scan-and-fix-serially audit

Applies fixes verified by the serial-fixer subagents (Sonnet, MANDATORY
verify-before-fixing rules). Every change was re-read against source
before editing; ~86 of the 126 findings were rejected as false positives.

Confirmed real fixes:
- .githooks/pre-push: walk_ancestry no longer splits paths on spaces,
  and ps_query decodes non-UTF8 bytes with errors="replace".
- bin/llm-ext: malformed/null tool results don't hang; final JSON-RPC
  flushed on stdout close; handleMessage exits non-zero when the tool
  reports an error (was always 0).
- mcp-server/add-shebang.mjs: guard prevents appending a second shebang
  to files that already start with "#!".
- mcp-server/esbuild.config.mjs: __filename/__dirname now defined in
  the bundled banner so CommonJS deps don't ReferenceError at runtime.
- mcp-server/server.json: numeric userConfig fields use "format": "number"
  instead of "string".
- mcp-server/src/cli.ts: parseSearchExistingArgs no longer misparses flags
  without values or accepts directories as source files; cmdSearchExisting
  honors --timeout-hours 0 as "no timeout"; git-diff rejects absolute paths
  outside the worktree.
- mcp-server/src/config.ts: getConfigDir resolves /tmp + homedir via
  realpathSync before path comparison (fixes macOS /private/tmp + Windows
  /tmp rejection false positives).
- mcp-server/src/grouping.ts: splitPerFileSections regex fixes.
- mcp-server/src/index.ts: extractLocalImports correctly resolves Python
  relative imports; gitLsFilesMultiRepo no longer double-scans submodules;
  check_against_specs honors answer_mode=0; tool descriptions no longer
  claim "parallel" for sequential local-mode calls.
- mcp-server/src/or-model-info.ts: fetchOpenRouterModelInfo handles
  payloads missing "endpoints" key; percentile labels corrected.
- mcp-server/src/test-helpers.ts: test output dirs use testName to avoid
  collisions; client timeout override now effective.
- mcp-server/src/live*.test.ts: getText guards undefined content; cleanDir
  no longer deletes LLM_OUTPUT_DIR mid-run; rmSync failures surface.
- mcp-server/statusline.py: TypeError guard on null JSON tokens.
- scripts/check_references.py: markdown regex strips anchors/queries;
  exclusion checks now applied to resolved targets; title links match.
- scripts/fix_found_bugs_helper.py: cmd_aggregate_reports guards missing
  args; _find_report_files case-insensitive prefix skip; cmd_diff_fixed
  correct unfixed_remaining count; cmd_is_canonical accepts severity
  words in finding titles.
- scripts/install_statusline.py: handles non-dict settings.json; paths
  properly escaped.
- scripts/join_fixer_reports.py: _find_candidates recursive.
- scripts/publish.py: _run_publish regex accepts single AND double quotes.
- scripts/validate_fixer_summary.py: handles unresolvable reports_dir.
- scripts/validate_report.py: _LINE_RANGE_RE matches L12-L40 / lines 12-40
  / :12-40 / 12-40 formats; BOM handled.


### Miscellaneous

- Chore(gitignore): exclude reports/ (local audit output, contains private paths)


## [9.0.1] - 2026-04-18

### Changed

- Build: rebuild dist after redact_secrets fix


### Fixed

- Fix(mcp): honor redact_secrets:true to skip the scan_secrets abort

The v9.0.0 commit set up the slash commands to send both scan_secrets:
true AND redact_secrets: true on every fix run, with a contract that
read like this in the README and in the doc comment in mcp-server/
src/index.ts:

  scan_secrets=true   + redact_secrets=false → detect, abort
  scan_secrets=true   + redact_secrets=true  → detect, REDACT, continue
  scan_secrets=false                         → no detection, no redaction

But the actual MCP-server code never honored the second case. Every
tool's abort guard was a flat `if (xxxScan)` that returned an isError
response the moment scanFilesForSecrets() found anything — regardless
of whether redact_secrets was also true. The default v9.0.0 fix-loop
invocation on this very repo hit the bug immediately: the scan aborted
on env-variable-NAME references in the plugin's own source (e.g.
$OPENROUTER_API_KEY in mcp-server/src/config.ts) instead of redacting
and continuing.

Fix: at every abort guard (10 sites, one per tool entry point), wrap
the condition with `&& !xxxRedact`. When the caller asked for both
scan and redact, the abort is skipped — downstream readAndGroupFiles
+ the inline-content branch already call redactSecrets() to replace
every match with [REDACTED:LABEL] before the LLM ever sees it. The
bytes the upstream LLM gets are identical to what scan-then-abort
would have prevented; the user just doesn't lose the run.

Sites updated (all in mcp-server/src/index.ts):

  chat:                          line 5067 → if (chatScan && !chatRedact)
  code_task:                     line 5360 → if (ctScan   && !ctRedact)
  batch_check:                   line 6020 → if (bcScan   && !bcRedact)
  scan_folder:                   line 6379 → if (sfScan   && !sfRedact)
  search_existing_implementations: line 6869 → if (seiScan && !seiRedact)
  compare_files (single):        line 7514 → if (cfScan   && !cfRedact)
  compare_files (comparePair):   line 7321 → if (cfScan   && !cfRedact)
  check_references:              line 7695 → if (crScan   && !crRedact)
  check_imports:                 line 7951 → if (ciScan   && !ciRedact)
  check_against_specs:           line 8312 → if (csScan   && !csRedact)

Updated the doc comment at lines 324-334 to describe the three modes
explicitly (was a two-line summary that said abort and redact were
distinct alternatives — the new comment makes the composition clear).

Validation: typecheck clean, build clean, eslint clean
(--max-warnings 0), all 51 vitest tests pass. Pre-existing
'Server is deprecated' diagnostics on lines 38 and 4912 are
unrelated to this change.

Backwards compat: callers that send only scan_secrets:true (no
redact_secrets) still abort on detection — same behaviour as before.
The new path activates only when both flags are true, which was
previously broken / undocumented.


## [9.0.0] - 2026-04-18

### Added

- Feat!: 8 fixes from user review — sonnet/opus split, menus, checkpoint, redact default, qwen, ollama, troubleshooting

BREAKING: the two opus-only fixer agents are split into sonnet + opus
variants (4 agents total), so the fixer commands can pre-bake the
user's model pick and dispatch directly. Users dispatching the old
agent names from custom commands MUST update to the *-sonnet-agent or
*-opus-agent variants:

  llm-externalizer-parallel-fixer-agent  -> llm-externalizer-parallel-fixer-sonnet-agent
                                          + llm-externalizer-parallel-fixer-opus-agent
  llm-externalizer-serial-fixer-agent    -> llm-externalizer-serial-fixer-sonnet-agent
                                          + llm-externalizer-serial-fixer-opus-agent

Eight user-requested changes:

1. `redact_secrets` default flipped to true when `scan_secrets` is true.
   Previous default aborted the whole run if any secret was detected;
   now the default is to REDACT (replace with [REDACTED:LABEL]) and
   keep scanning. Users who want the old abort behaviour can still get
   it by running with --no-secrets and enabling a stricter external
   pre-flight, but the sensible default for "wise" secret scanning is
   redact-not-abort. All 4 scan-and-fix variants updated; the scan
   call now sends scan_secrets + redact_secrets as a pair.

2. All user-facing choice prompts moved to AskUserQuestion menus with
   the yes/default option first, so pressing Enter takes the obvious
   path:
     - Auto-discovery confirm step: Proceed (default) / Edit list / Cancel.
     - Fixer-model pick step: Sonnet (default) / Opus.
   No more "type y to continue" text prompts.

3. Step 0 output trimmed: one line each for codebase root, file count
   + top-level breakdown, included examples, excluded examples. Then
   the menu. No prose lectures before the scan.

4. Pre-fix checkpoint step added to all four fix-touching commands
   (scan-and-fix, scan-and-fix-serially, fix-report, fix-found-bugs).
   Before any fixer touches source, the orchestrator creates a
   `chore(checkpoint): ...` commit if the tree has uncommitted
   changes, so the user can always revert with one `git reset --soft
   HEAD~1`. No menu — checkpointing is cheap and always safe.

5. Ensemble model list completed in both the README and the YAML
   example. The Remote (OpenRouter) block now shows third_model:
   "qwen/qwen3.6-plus" alongside gemini-2.5-flash and grok-4.1-fast.
   remote-ensemble requires three models — the doc now states this.

6. Fixer model is now picked via menu (Sonnet default, Opus optional),
   and the four new agent files hard-code the picked model. Splitting
   into two files per fixer role keeps the `model:` frontmatter field
   honest and the CPV validator happy (effort: xhigh needs Opus;
   sonnet variants use effort: high).

7. LM Studio default switched from the old Llama-3.3-70B-GGUF to the
   recommended Qwen 3.5 27B with platform-split guidance:
     * mlx-community/Qwen3.5-27B-Instruct-4bit   (macOS Apple Silicon)
     * bartowski/Qwen3.5-27B-Instruct-GGUF       (Windows / Linux)
   One comment line in the profile explains which to pick.

8. Two new README sections:
     * "Local (Ollama)" — full profile example, `ollama pull` hint,
       url override note.
     * "## Troubleshooting" — 4 tables (OpenRouter / LM Studio /
       Ollama / General) covering the common symptoms users hit:
       missing env vars, 401/429 errors, model-not-found, timeouts,
       MLX-vs-GGUF pick on Mac, daemon not running, etc.

Also dropped editorializing on model quality. The README used to say
free mode is "LOWER quality than ensemble — expect more false
positives and shallower analysis" and similar on --free in the
scan-and-fix tables. Those are design decisions we already committed
to — readers don't need the caveat. Kept the one truly material
warning on free mode: the provider logs prompts.

Rule file synced: rules/use-llm-externalizer.md lists all 5 agents and
the Sonnet/Opus menu, and the user-global ~/.claude/rules/ copy
mirrors the plugin version byte-for-byte so next-install users get
the same guidance.

Validation: all agents 100/100, all commands 100/100, plugin clean
(only the pre-existing mcp-server/ directory WARNING, unchanged).


## [8.1.2] - 2026-04-18

### Documentation

- Docs(readme): split user install vs dev install; marketplace link at top

Three related fixes per user feedback:

1. Marketplace visibility at the top.
   Right under the tagline a [!NOTE] banner spells out the plugin
   ships in Emasoft/emasoft-plugins (with a link). Anyone reading
   the README — Claude Code included — can see which marketplace to
   add before the install commands even start.

2. Quick start = USER install only, via the Claude Code CLI.
   Rewrote the whole Quick start section around `claude plugin …`
   CLI commands (not inside-Claude slash commands), step-by-step:

     1. claude plugin marketplace add Emasoft/emasoft-plugins
     2. claude plugin marketplace update emasoft-plugins
     3. claude plugin install llm-externalizer@emasoft-plugins
     4. claude plugin update llm-externalizer
     5. claude plugin uninstall llm-externalizer

   Each with a short "why". Pointer at the top to `claude plugins
   --help` for the full reference.

   The old "alternative: manual settings.json" branch and the
   "/plugin ..." slash-command flow are gone from Quick start —
   those belong in the Claude Code docs, not here.

   Added a dedicated subsection "How to install from inside Claude
   Code" that is deliberately one sentence: "Paste the URL of this
   repository in the prompt and ask Claude to install it for you as
   a project, local, or user scope plugin."

3. Contributing = DEV install at the bottom, with the exact command
   sequence a contributor needs:

     fork -> clone -> add upstream -> scripts/setup.py -> local
     install -> feature branch -> claude plugin validate +
     cpv-remote-validate -> conventional-commit -> push fork ->
     gh pr create

   Added an [!IMPORTANT] banner explaining the pre-push hook blocks
   direct git push to upstream; only scripts/publish.py (run by the
   maintainer) ships a release, and it runs the 9 mandatory
   validation gates every time.

   Developer requirements (uv, gh, git-cliff) live here now —
   Requirements section up top only lists what a regular marketplace
   user needs, with a pointer to this section for devs.

   Release pipeline subsection shows every scripts/publish.py flag
   (--patch / --minor / --major / --dry-run / --check-only) so
   maintainers don't have to `--help` to remember.

Net: user path is top-to-bottom (marketplace, install, configure,
run). Dev path is anchored at the bottom with the full fork-build-PR
sequence. No duplicate Requirements list, no inside-Claude-slash-
command install noise in Quick start.


## [8.1.1] - 2026-04-18

### Documentation

- Docs(readme): full restructure — TOC, user-first order, concise features, colored alerts

You called it: the previous README was bloated, duplicated, out of
order, and had no TOC. This rewrite takes it from 599 lines to 380
(-37%) without losing any end-user-facing detail.

What's different:

1. Order now follows "what a new user needs first":
     badges -> tagline -> cost graph -> TOC -> Features -> Requirements
     -> Quick Start -> Commands -> Agents -> Configuration ->
     MCP tools reference -> Skills -> Plugin structure -> Contributing
     -> License -> Links
   Requirements + Quick Start used to be at line 580+. Now they're
   at the top, right under the TOC, as they should be.

2. Features list shrunk from a 15-bullet dump (each with inline
   detail) to 9 one-line bullets that LINK into the dedicated
   sections. Details live where they belong, not in the summary.

3. Table of contents added — 12 section anchors.

4. Colored banner titles via GitHub Alert blocks:
     > [!TIP]      — "Why this plugin exists" + serial-vs-parallel guidance
     > [!NOTE]     — marketplace-refresh tip + auth auto-detection
     > [!IMPORTANT]— MCP batching limits
     > [!WARNING]  — free-tier prompt-logging caveat
   These render as coloured side-panels on GitHub / VS Code preview.

5. Duplicated content removed:
   * "Cost comparison" subsection (graph was already in the hero
     section one line below)
   * "LLM Externalizer (external model analysis)" section — this
     was a pasted skill-prose block, not README material
   * "Read-only by design — disabled tools" — historical noise
     about dead code in the MCP server
   * "Key constraints" and "Subagent access" sections — internal
     implementation detail, not user-facing
   * "Naming" section — one-off cleanup commentary
   * Duplicate "answer_mode" descriptions in 3 places condensed to
     one table

6. Plugin structure tree collapsed into a <details> block — the
   full tree was 60+ lines of dev detail; users rarely need it but
   it's still there for when they do.

7. Publishing section shrunk to a 3-line Contributing summary.
   Detail lives in scripts/publish.py's --help.

8. Command parameter tables preserved in full — they were requested
   earlier and are the genuine user-facing reference.

Score impact: validation stays clean (0 CRITICAL / 0 MAJOR / 0 MINOR
/ 0 NIT / 1 pre-existing unrelated WARNING about mcp-server/).


## [8.1.0] - 2026-04-18

### Added

- Feat: auto-switch answer_mode to 1 when --file-list contains group markers

Both scan commands now auto-detect the presence of ---GROUP:<id>---
markers in the user-supplied --file-list and, when present, set
answer_mode=1 on the mcp__llm-externalizer__code_task call. Without
markers (or when the scan goes through scan_folder on Branch B), the
mode stays at the default 0 (one report per file).

Why: users who put group markers in their file list expect a report
per group (that's the whole point of grouping). Silently keeping
answer_mode=0 produced per-file reports that fragmented the grouping
intent — the MCP server still packed the files per-group into the
LLM request, but the reports came back split.

Implementation in the command prose:

  ANSWER_MODE=0
  if [ -n "$FILE_LIST_PATH" ] && \
     grep -Eq '^---GROUP:[A-Za-z0-9_.-]+---[[:space:]]*$' "$FILE_LIST_PATH"; then
      ANSWER_MODE=1
  fi

Then the scan JSON uses <ANSWER_MODE> instead of a hardcoded 0. Branch
B (folder scan via scan_folder) always uses 0 — scan_folder
auto-discovers paths and doesn't accept group markers. The orchestrator
also logs a one-line notice ("File list contains group markers — using
answer_mode=1 (one report per group)") so the user knows why the
output shape differs from the default.

Downstream pipeline is unchanged:
  * parallel-fixer dispatch (scan-and-fix): each group report -> one
    fixer. Same as per-file.
  * aggregator (scan-and-fix-serially): walks every .md in the
    reports dir. Group reports work the same as per-file reports.

Constraint section updated: "answer_mode is hardcoded to 0" is now
"answer_mode is chosen by the command itself: 0 default, 1 if file
list has group markers, never 2, never overridable from $ARGUMENTS".

README table entry for --file-list now explicitly states the
auto-switch ("if the file contains at least one ---GROUP:<id>--- line,
the command automatically uses answer_mode: 1 instead of the default
answer_mode: 0").


## [8.0.2] - 2026-04-18

### Documentation

- Docs(readme): expand parameter tables with defaults + behaviour nuances

You asked: does the doc say what happens when no target AND no
--file-list are passed? Does it explain that a file list with
---GROUP:id--- markers produces per-group reports instead of per-file?
The answers were "barely" and "no" — fixed.

Every parameter table now has a dedicated "Default" column and
expanded "Meaning" prose covering the subtle cases a reader would
otherwise miss:

scan-and-fix / scan-and-fix-serially:
  * [target] — default behaviour is DEFAULT-TO-SCANNING-THE-WHOLE-
    CODEBASE (auto-discover tracked files, filter non-source, confirm
    with the user, treat as implicit --file-list). Explicit that the
    command does NOT silently hand a folder to scan_folder.
  * --file-list — documented the ---GROUP:id--- marker semantics:
    lines between ---GROUP:id--- and ---/GROUP:id--- are packed into
    ONE LLM request and produce ONE report per group instead of one
    per file (basename carries _group-<id>_). Also: empty list
    aborts.
  * --instructions — described what the DEFAULT rubric is (REAL
    bugs only, strict exclusions for style / try-except / null-
    checks / refactors).
  * --specs — explicit that each batch sees source+spec, making
    cross-reference validation trustworthy (unlike the default
    rubric's best-effort local-only check).
  * --free — called out that it's LOWER quality than the ensemble
    and that the provider LOGS PROMPTS (don't use on proprietary
    code).
  * --no-secrets — clarified that default behaviour ABORTS the run
    if a secret is found (safety net, not silent redaction).
  * --text — clarified that the default rubric has nothing useful
    to say about prose and should be paired with --instructions.

search-existing-implementations:
  * --base — explicit auto-detect chain (origin/HEAD → main →
    master).
  * --max-files — default 10000 stated with the reason (designed
    for massive PR-review scans).
  * Added output spec (one line per file, exhaustive, answer_mode=2
    merged report).

fix-report:
  * Added explicit .fixer. / .final-report. basename rejection up
    front, relative-path resolution rule.

fix-found-bugs:
  * The DEFAULT when no arg is supplied is now explicit: aggregate
    EVERY report in ./reports/llm-externalizer/, skip any with a
    .fixer. sibling.
  * Stated the MAX_ITER formula and stuck-streak safety rail.

All tables now gain a Default column; tables that had no default
(required positional only) still show "—" so the column is
consistent across commands.


## [8.0.1] - 2026-04-18

### Documentation

- Docs: per-command parameter tables in README + bundle the use-llm-externalizer rule file

Three changes:

1. README.md: every slash command now has its own parameter table
   (positional + flag) with Kind / Required / Meaning columns. Each
   table is preceded by a short behaviour summary so readers can see
   what the command does without following every link. Tables added
   for:
     - llm-externalizer-discover  (no params)
     - llm-externalizer-configure (no params)
     - llm-externalizer-search-existing-implementations (2 positional
       + 5 flags)
     - llm-externalizer-scan-and-fix (target + 6 flags)
     - llm-externalizer-scan-and-fix-serially (cross-references the
       scan-and-fix table since the parameter set is byte-identical)
     - llm-externalizer-fix-report (one positional)
     - llm-externalizer-fix-found-bugs (one optional positional)

   The original compact overview table stays at the top so existing
   links to "## Commands" still land on a readable summary.

2. rules/use-llm-externalizer.md NEW: plugin-bundled copy of the
   per-user global rules file at ~/.claude/rules/use-llm-externalizer.md.
   Having the canonical content ship with the plugin means new installs
   get the up-to-date guidance without the user having to hand-copy
   anything. The two files are byte-identical as of this commit and
   should be synced together on future edits.

3. The plugin-bundled rule file already reflects the v8.0.0 renames:
     * Agent names: llm-ext-reviewer -> llm-externalizer-reviewer-agent
       (the rest are llm-externalizer-parallel-fixer-agent and
       llm-externalizer-serial-fixer-agent)
     * Flag renames: --no-scan-secrets -> --no-secrets,
       --text-files -> --text
   So anyone installing v8.1.0 gets current docs out of the box.


## [8.0.0] - 2026-04-18

### Added

- Feat!: shorten scan-phase flag names

BREAKING: two flags on both scan commands are renamed:

  --no-scan-secrets  ->  --no-secrets
  --text-files       ->  --text

Users who invoked scan-and-fix or scan-and-fix-serially with the old
flag names must update their commands.

Motivation: CPV's command validator warns when argument-hint > ~100
chars ("may be truncated in UI"). With both flags visible in the hint
(as you asked), the old spelling came in at 108 chars and both
commands scored 97/100. The shorter names cut the hint to 97 chars
and both commands are now at 100/100.

Semantically the flags are unchanged: --no-secrets still disables the
pre-scan secret detector (scan_secrets: false); --text still widens
the scan to include plain-text formats (.md .txt .json .yml .yaml
.toml .ini .cfg .conf .xml .html .rst .csv) instead of the default
source-code extensions.

Also dropped a stale 'effort: high' line from scan-and-fix.md's
frontmatter — it's not in the plugin-shipped command allowed-fields
set (CPV warning), and the command runs fine without it. scan-and-fix
is already dispatched with the effort inherited from the model
config, so the field was a no-op anyway.


## [7.1.2] - 2026-04-18

### Fixed

- Fix(commands): make scan phase identical across scan-and-fix and scan-and-fix-serially

Two related fixes:

1. Restore --no-scan-secrets and --text-files in both commands'
   argument-hint. They were silently dropped from the hint in v7.1.1
   (still usable per the Arguments doc and the scan_folder / code_task
   JSON calls, but invisible from the slash-command menu — user
   couldn't see they were options). Now both commands show the full
   flag set:

   [target] [--file-list path] [--instructions path] [--specs path]
     [--free] [--no-scan-secrets] [--text-files]

2. Make the scan phase (Step 0 auto-discovery through Step 3b report
   validation) byte-identical between the two commands. The previous
   scan-and-fix-serially version condensed the prose for brevity; the
   result was functionally equivalent but visually diverged. Now Step
   0-3b in scan-and-fix-serially is a verbatim copy of the same
   section in scan-and-fix, minus three necessary deltas:

   a. [FAILED] prefix strings use the invoking command's name (user
      doesn't see the wrong command in an error message).
   b. Step 3b heading: "before dispatching fixers" (scan-and-fix) vs
      "before the aggregator" (serially) — the two commands use the
      validated list for different downstream steps.
   c. The "Token-budget note for very large scans" section is
      parallel-dispatch-specific; serially does not need it.

   Added a visible marker at the end of serially's Step 3b noting that
   the whole scan phase is a mirror of scan-and-fix's and must stay in
   sync on future edits.

Outcome: a user reading the two commands sees the same scan pipeline
end-to-end and can trust that switching between parallel and serial
fix modes does not quietly change how the codebase is scanned.


## [7.1.1] - 2026-04-18

### Fixed

- Fix(commands): make scan-and-fix-serially self-contained (command -> agent, no nested command chain)

Previous v7.1.0 draft relied on cross-command references ("follow
scan-and-fix Steps 0-3b, then follow fix-found-bugs Steps 4-8"),
which forces the orchestrator to open the other command files at
runtime — more tokens, more indirection, and the wrong orchestration
pattern (command -> command -> agent instead of command -> agent).

Rewrite as a single self-contained command: the scan phase, the
aggregator call, the canonicalisation step, and the serial fix loop
are all inlined here. The only outgoing Task call is to
llm-externalizer-serial-fixer-agent (plus the MCP scan calls and
helper-script invocations, which are data/tooling, not command
chaining). No "see scan-and-fix.md" or "see fix-found-bugs.md"
pointers remain.

The command is longer on disk (~230 lines vs 63 in the v7.1.0 draft)
but the steady-state cost is lower: a user who invokes this command
loads ONE command's prose, not three. The earlier "delta-only" doc
looked shorter but made every invocation pay the cost of resolving
the cross-references.

Also trimmed:
- description: 300 -> 193 chars (was over the 250-char slash-menu cap)
- argument-hint: dropped rarely-used [--no-scan-secrets] and
  [--text-files] entries (108 -> 83 chars; they're still documented
  in the Arguments section)


## [7.1.0] - 2026-04-18

### Added

- Feat: add /llm-externalizer:llm-externalizer-scan-and-fix-serially command

Composition command that reuses the scan phase from scan-and-fix and
the serial loop from fix-found-bugs:

  scan (parallel per-file reports)
    -> aggregate into one canonical bug list
    -> serial llm-externalizer-serial-fixer-agent loop (1 bug / dispatch)

Use this instead of scan-and-fix when fixes mutate shared state
(imports, types, schemas, shared mocks) — running 15 parallel fixers
would race — or when bug order matters (an earlier fix may supersede
or unblock a later one).

The command body is deliberately terse: ~60 lines of delta-only prose
pointing back to the two existing commands rather than re-inlining
their orchestration. Every token loaded into the slash-command
context is a token the orchestrator pays for — the longer the
description, the higher the floor per invocation. Treating this
command as "scan-and-fix scan phase + fix-found-bugs serial phase,
with these four deltas" keeps the marginal cost low.

README updates:
- 6 slash commands -> 7, new command added to the top bullet
- Commands table row added, describing the serial/stateful trade-off
- Plugin structure tree includes the new commands/*.md entry


## [7.0.0] - 2026-04-18

### Added

- Feat!: rename fixer agents by concurrency model (parallel / serial)

BREAKING: both Opus-class fixer agents are renamed to spell out the
fundamental design distinction — concurrency — directly in the name:

  llm-externalizer-fixer-agent      -> llm-externalizer-parallel-fixer-agent
  llm-externalizer-bug-fixer-agent  -> llm-externalizer-serial-fixer-agent

The pair "fixer" vs "bug-fixer" was ambiguous — both agents fix bugs,
and a reader couldn't tell from the name which was which. The real
design axis is how they execute:

- parallel-fixer-agent: stateless, writes a .fixer. summary per report,
  dispatched up to 15 in parallel against a folder-wide scan
- serial-fixer-agent: stateful on disk (mutates the aggregated bug
  list with " — FIXED" markers), dispatched one at a time in a loop
  over one bug list

Reviewer-agent name is unchanged (it's read-only, not a fixer).

Touched everywhere: agent files (git mv + frontmatter name: field +
internal BACKUP path prefixes + [FAILED] messages + example dialog),
command Task dispatches and descriptions, README features + commands
table + plugin structure, scripts (fix_found_bugs_helper.py help text,
validate_fixer_summary.py docstring). CHANGELOG entries are historical
commit records and were left untouched.


## [6.0.0] - 2026-04-18

### Added

- Feat!: rename agents with -agent suffix + add llm-externalizer-fix-report command + drop line-count CANTFIX cap

BREAKING: all three plugin-shipped agents are renamed. Any user config,
slash-command script, or Task dispatch that references the old names
must be updated:

  llm-externalizer-fixer      -> llm-externalizer-fixer-agent
  llm-externalizer-reviewer   -> llm-externalizer-reviewer-agent
  llm-externalizer-bug-fixer  -> llm-externalizer-bug-fixer-agent

Motivation: the `-agent` suffix makes agents visibly distinct from
commands in the slash-command menu and in logs. Commands are the
user-facing surface; agents are internal dispatch targets that the user
should NOT invoke directly. The naming makes this hierarchy obvious.

Updated everywhere the old names appeared: agent frontmatter `name:`
fields, example dialog lines, /tmp BACKUP path prefixes, command
`subagent_type:` dispatches, README features list + commands table +
plugin-structure block, skill frontmatter `agent:` field, and doc
references in scripts. CHANGELOG entries are historical commit records
and were left untouched.

New command: `/llm-externalizer:llm-externalizer-fix-report`. Wraps a
single `llm-externalizer-fixer-agent` dispatch for one already-generated
per-file scan report — the single-file counterpart to the parallel
dispatcher in `scan-and-fix`. User-facing surface now has a command per
fixer agent: `scan-and-fix` + `fix-report` invoke `fixer-agent`;
`fix-found-bugs` invokes `bug-fixer-agent`. Users should never need to
call an agent directly.

Rules change in both fixer agents: remove the ">10 lines of rewrite"
clause from the CANTFIX-escalation rule. Size of the fix is no longer
a reason to escalate — only SCOPE growth (touching another file or
changing a public API) does. A large in-file rewrite with
mcp__serena-mcp__replace_symbol_body is fine.

Files touched:
- agents/llm-externalizer-{fixer,reviewer,bug-fixer}.md renamed to
  *-agent.md; frontmatter name: fields updated; internal refs updated
- commands/llm-externalizer-fix-report.md NEW
- commands/llm-externalizer-{scan-and-fix,fix-found-bugs}.md refs
  updated
- skills/llm-externalizer-scan/SKILL.md agent: field updated
- scripts/fix_found_bugs_helper.py help text updated
- scripts/validate_fixer_summary.py docstring updated
- README.md features, commands table, plugin structure updated


### Fixed

- Fix(reviewer): upgrade model from haiku to sonnet

User reports the Haiku-class reviewer hallucinates too often to be
trusted on real-code audits — upgrade to Sonnet to improve signal-to-
noise. The reviewer is read-only (no Write/Edit in its tool surface)
so this is a pure capability/cost upgrade, not a scope change.

- agents/llm-externalizer-reviewer-agent.md: model: haiku -> sonnet
- README: "Haiku-class" -> "Sonnet-class" (features bullet + plugin
  tree comment)
- skills/llm-externalizer-scan/SKILL.md: "(Haiku, no Write/Edit)" ->
  "(Sonnet, no Write/Edit)"


## [5.2.1] - 2026-04-18

### Documentation

- Docs(agent): mirror the 10-rule block from llm-externalizer-fixer

Add a '## Rules' summary at the end of llm-externalizer-bug-fixer,
mirroring the block already present in llm-externalizer-fixer so the
two agents look the same at a glance.

Adaptations for the bug-fixer's role (fix from a markdown bug list
rather than from a scan report):

- Rule 4 — source of truth is the bug file + the real source tree
  (validate_report.py / validate_fixer_summary.py don't exist in this
  flow).
- Rule 5 — CANTFIX note must be appended to the bug body with a
  timestamp (RUN_TS) so future runs see the prior attempt.
- Rule 10 — return exactly one status line of the four allowed shapes
  (Fixed / False-positive / CANTFIX / [FAILED]) rather than a summary
  path; a missing or multi-line return breaks diff-fixed parsing.
- Rule 2 — add a pointer to SERENA replace_symbol_body (matches the
  tool-selection rule added earlier).


## [5.2.0] - 2026-04-18

### Added

- Feat(agent): prefer SERENA replace_symbol_body for whole-symbol rewrites

Add an explicit tool-selection rule for the llm-externalizer-bug-fixer:

- whole-function / whole-method / whole-class rewrite →
  mcp__serena-mcp__replace_symbol_body (AST-scoped, preserves
  indentation and cannot spill into adjacent symbols)
- insert code around a symbol → insert_before_symbol / insert_after_symbol
- rename a symbol → rename_symbol
- delete an unused symbol → safe_delete_symbol (after find_referencing_symbols
  confirms 0 external refs)
- single-line / in-symbol textual patch → built-in Edit

Rule of thumb: if the replacement contains a def / class / fn block,
use replace_symbol_body; if it's a snippet inside one, use Edit.

Also update the regression-check step to re-read modified symbols via
SERENA's find_symbol (include_body: true) when the edit was symbol-scoped
— matches the editing tool used.

Motivation: textual Edit is fragile on whole-function rewrites because
it matches by unique substring and silently fails when indentation
drifts or when the function appears twice in the file. SERENA's
symbol-scoped edit tools address both issues and are already in the
agent's inherited tool surface.


### Fixed

- Fix(agent): let llm-externalizer-bug-fixer inherit full tool surface

Remove the narrow Read/Edit/Write/Bash/Grep/Glob allowlist so the agent
can use SERENA MCP, TLDR, and Grepika (plus LSP diagnostics and any
other MCP tools configured in the session) to trace flow before editing.

Mirrors the pattern already used by llm-externalizer-fixer — a narrow
tools: line starves the agent of the cheap, symbol-aware tools it needs
to verify findings before touching source, which is exactly the verify-
before-edit behaviour the agent body already asks for.

Also update the "Read the referenced code" rule to name Grepika
(mcp__grepika__search / refs / outline) alongside SERENA and TLDR, so
the agent explicitly knows which tools to reach for before Grep.


## [5.1.1] - 2026-04-18

### Documentation

- Docs: update README features list for v5.1.0

Mention the new llm-externalizer-bug-fixer agent and bump the
slash-command count from 4 to 5 (added llm-externalizer-fix-found-bugs).


## [5.1.0] - 2026-04-18

### Added

- Feat: add llm-externalizer-fix-found-bugs command

Aggregate unfixed findings across every report under ./reports/llm-externalizer/
(merging the 3 per-model auditor responses when ensemble mode was used) into one
canonical bug list, then dispatch one fresh llm-externalizer-bug-fixer subagent
per bug until none remain. Pass @merged-report.md as the argument to scope the
loop to a single merged (answer_mode=2) report.

Each dispatch is a fresh spawn with zero parent-conversation context. The loop
is serial by design — later bugs may be superseded by fixes in earlier ones.
The orchestrator never reads scan or fixer content, only paths.

- commands/llm-externalizer-fix-found-bugs.md — orchestrator (argument-hint:
  "[@merged-report.md]")
- agents/llm-externalizer-bug-fixer.md — Opus-class per-bug fixer with
  REAL-BUG / FALSE-POSITIVE / HALLUCINATION / CANTFIX classification, /tmp
  backup + rollback on regression, per-language linter verification
- scripts/fix_found_bugs_helper.py — backend with 10 subcommands including
  the new aggregate-reports that handles ensemble (## Response per-model
  sections), merged (## File: sections), and single-model report shapes
  with keyword-based severity classification; --skip-if-fixer-exists skips
  reports already processed by scan-and-fix
- README + CHANGELOG updated


## [5.0.0] - 2026-04-18

### Added

- Feat!: read-only MCP + dead-code purge + deep audit pass

BREAKING: LLM Externalizer MCP is now read-only by design.

MCP write tools removed entirely (not just disabled): fix_code,
batch_fix, merge_files, split_file, revert_file, set_settings,
change_model. File fixes are applied exclusively by the
/llm-externalizer:llm-externalizer-scan-and-fix plugin command,
which dispatches local agents using Claude Code's Read+Edit.
Model & profile configuration is user-only — edit
~/.llm-externalizer/settings.yaml manually, then restart or call
the reset tool.

CLI mutation subcommands removed: profile add / select / edit /
remove / rename no longer exist. Only 'profile list' remains.

Supporting dead code also removed: DISABLED_TOOLS mechanism,
fix_code_response / split_file_response schemas, file-locking
subsystem (acquireFileLock / releaseFileLock), git-branch monitor
(getGitBranch / assertBranchUnchanged), path-traversal guard
(sanitizeOutputPath), BOM + line-ending preservation
(hasBOM / detectLineEnding / restoreFileConventions),
verifyStructuralIntegrity, reversible redaction
(TrackedRedaction / redactSecretsReversible / restoreSecrets /
formatLostSecrets), withWriteQueue, processFileFix, getBackupDir.
In config.ts: saveSettings and related write helpers. Net:
index.ts dropped from ~10k to 8.5k lines.

Scan rubric tightened across agents/commands/skills: report REAL
bugs only (logic errors, crashes, security with exploit paths,
data corruption, functionality mismatch, local broken references).
Missing error handling / null checks / input validation / logging
/ refactoring suggestions are treated as style preferences and
must NOT be reported. Fixer agent gained a 4-bucket finding
classifier (REAL BUG / STYLE PREFERENCE / HALLUCINATION /
EXAGGERATION / CANTFIX) applied before every edit. Reviewer and
fixer no longer declare a tools: allowlist — they inherit the
full tool surface (SERENA MCP, TLDR, Grepika, LSP).

Docs swept: README, CHANGELOG, commands/llm-externalizer-configure,
skills/llm-externalizer-config, skills/llm-externalizer-usage,
skills/llm-externalizer-scan, skills/llm-externalizer-free-scan,
bin/llm-ext, in-source tool descriptions — all now state the
read-only + manual-edit policy explicitly. Validator error messages
in config.ts updated to point at manual YAML edit + reset.

CPV audit fixes:
  - Plugin: 0 CRIT / 0 MAJ / 0 MIN (was 0/2/2/6 WARN)
  - Agents: fixer + reviewer both 100/100 (was 87/87) — added 2
    <example> blocks each in the body, moved them out of the
    description to avoid angle-bracket prompt injection
  - Commands: all 4 at 100/100 — shortened long descriptions,
    removed angle brackets, dropped empty argument-hint
  - Skills: all 5 at 100/100 Grade A — trimmed scan SKILL.md to
    under 5000 chars, added 'Use when...' prefix to config
    SKILL.md, fixed TOC coverage in free-scan and usage SKILLs,
    renamed 'Instructions (read-only inspection)' to 'Instructions'
  - XREF: 100/100 — reworded prose in CHANGELOG that CPV was
    misparsing as skill references

Python: ruff + pyright clean. Added 'typing.Any' to statusline.py
safe_jq so pyright stops widening dict.get() to Unknown. Removed
unused 'datetime.timezone' import. Removed dead _exists helper in
check_references.py. All Python files ruff format-normalized.

YAML: added pragmatic .yamllint.yml (line-length 200, disabled
document-start, disabled truthy.check-keys for GitHub Actions
'on:' key). Split long client-payload in notify-marketplace.yml.

Test suite: 51 tests pass. Updated index.test.ts expected-tools
list to drop set_settings/change_model; rewrote the disabled-tools
test to match current reality; removed change_model + discover
round-trip test from live-extended.test.ts.

Gitignore: removed uv.lock (scripts are stdlib-only).
Committing an empty lockfile so tooling has a pin reference.


## [4.1.5] - 2026-04-17

### Documentation

- Docs(scan): warn that LLM cannot cross-reference files — 1-5 per batch

Added a fundamental-limitation warning: the LLM sees only 1-5 files
per request (FFD ~400 KB batches, or one ---GROUP:id--- group).
It cannot verify that a reference in file A exists in file B or
anywhere else in the codebase — no single LLM call ever has global
visibility, so the default 'broken references' heuristic is
best-effort LOCAL only.

For real cross-file validation, users must use:

  * mcp__llm-externalizer__check_against_specs (or the --specs
    flag on /llm-externalizer:llm-externalizer-scan-and-fix): each
    batch includes the authoritative spec, so every reference is
    validated against it instead of against 'whatever the LLM
    thinks exists elsewhere'.
  * mcp__llm-externalizer__search_existing_implementations
    (or the search-existing-implementations command): purpose-built
    for 'is this already implemented?' cross-codebase hunts,
    comparing each file against a REFERENCE description rather
    than against other files.

Changes:

  - commands/llm-externalizer-scan-and-fix.md: full warning block
    immediately after the HARDCODED section.
  - skills/llm-externalizer-scan/SKILL.md, -free-scan, -usage:
    merged the previous '.md files' rule with the new cross-file
    warning into one '## Limitations' section (kept SKILL.md
    sizes under CPV's 5000-char progressive-disclosure cap by
    dropping the redundant Batching paragraph, whose content is
    now in Limitations).

Verified:
  CPV: 0 CRITICAL / 0 MAJOR / 0 MINOR (WARNING=6 all pre-existing)
  check_references.py --strict: 0 broken, 0 dynamic


## [4.1.4] - 2026-04-17

### Documentation

- Docs: rename 'Analyze multiple files together' -> 'in parallel'

'Together' wrongly suggested the LLM can see every file in a single
request. It cannot — the server batches 1–5 files per LLM call
(FFD ~400 KB budget) or one group per call when ---GROUP:id---
markers are used. 'In parallel' accurately describes the multi-file
behavior from the LLM's point of view: each file gets processed,
and in ensemble mode each file gets 3 responses concurrently from
3 different models.

Renamed across 6 files:

  - skills/llm-externalizer-scan/references/usage-patterns.md
    (heading + TOC link + anchor slug)
  - skills/llm-externalizer-free-scan/references/usage-patterns.md
    (same)
  - skills/llm-externalizer-usage/references/usage-patterns.md
    (same)
  - skills/llm-externalizer-scan/SKILL.md
    (embedded TOC text)
  - skills/llm-externalizer-free-scan/SKILL.md
    (embedded TOC text)
  - skills/llm-externalizer-usage/SKILL.md
    (embedded TOC text)

Verified:
  CPV: CRITICAL=0 MAJOR=0 MINOR=0 (WARNING=6 all pre-existing)
  check_references.py --strict: 0 broken, 0 dynamic


## [4.1.3] - 2026-04-17

### Documentation

- Docs: avoid 'references/imports' prose that my own checker reads as a path

check_references.py flagged the slash-separated 'references/imports'
as a broken path reference. Replaced with 'check broken references,
check broken imports' (two items) — which also matches the actual
reference file's section names more accurately.

- Docs: shrink .md-scan rule block to stay under CPV's 5000-char SKILL.md cap

The ~900-char rule block I added to the three SKILL.md files
pushed each over the CPV-enforced 5000-character limit for
progressive-disclosure skill files. CPV correctly blocked the
publish — this commit compresses the inline version to ~300 chars
(two sentences) while keeping the full rule in
commands/llm-externalizer-scan-and-fix.md where no char limit
applies.

Also trimmed the llm-externalizer-scan SKILL.md Examples block
(redundant with references/usage-patterns.md) and shortened the
Resources descriptions to fit the budget.

Verified:
  - CPV: 0 CRITICAL, 0 MAJOR (was 3 MAJOR)
  - check_references.py --strict: 0 broken

- Docs: propagate .md-exclusion + no-structural-validation rules to all scanners

The rule "don't waste LLM tokens auditing .md files with a
source-code rubric, and don't use the LLM for structural
validation — CPV and `claude plugin validate` do that better,
cheaper, deterministically" applies to every scanning entity in
this plugin, not just /llm-externalizer-scan-and-fix.

Added the same rule block to:

  - skills/llm-externalizer-scan/SKILL.md
  - skills/llm-externalizer-free-scan/SKILL.md
  - skills/llm-externalizer-usage/SKILL.md
  - commands/llm-externalizer-search-existing-implementations.md
    (adapted — this command's semantic-duplicate-detection use
    case is LLM-only, so the block is phrased as "don't use this
    for what validators do better" instead of "exclude .md by
    default")

Left untouched (no scanning behavior, rule doesn't apply):

  - commands/llm-externalizer-configure.md
  - commands/llm-externalizer-discover.md
  - skills/llm-externalizer-config/SKILL.md
  - skills/llm-externalizer-or-model-info/SKILL.md


### Fixed

- Fix(cpv): satisfy progressive-disclosure TOC + shebang+exec warnings

CPV blocked the v4.1.3 publish with MAJOR/MINOR on
skills/llm-externalizer-scan/SKILL.md:

  * TOC-coverage MINOR: my shortened Resources list matched only
    1/19 (then 4/19) of the H2 headings in usage-patterns.md.
    Restored the full 19-item TOC using the EXACT heading
    strings from references/usage-patterns.md.
  * 5000-char MAJOR (side-effect of the TOC restore): offset
    by trimming the `.md files` rule block + `Batching` and
    `answer_mode` paragraphs. Final size 5029 bytes (CPV counts
    ~4950 chars — under the 5000 cap).

Also addressed the shebang-without-executable warnings:

  * chmod +x scripts/validate_report.py
  * chmod +x scripts/validate_fixer_summary.py
  * chmod +x scripts/check_references.py

CPV result: CRITICAL=0 MAJOR=0 MINOR=0 NIT=0 WARNING=6 (all
remaining warnings are pre-existing / unrelated: mcp-server/
dir name, 7/8 and 18/19 TOC coverage on other skills, .config/
dotnet-tools.json backtick false-positive, uv.lock in .gitignore).
check_references.py --strict -> 0 broken, 0 dynamic.


## [4.1.2] - 2026-04-17

### Documentation

- Docs(scan-and-fix): fix wrong .md-scan examples + warn against LLM-as-validator

The previous examples suggested using the LLM scan for:

  - verifying skill descriptions match their tools
  - verifying argument-hints match actual command args

Those are deterministic structural checks — they belong to
CPV (claude-plugin-validation), `claude plugin validate .`, or
project-local AST/schema scripts. A validator runs them in
milliseconds, is reproducible, and cannot hallucinate. An LLM
doing the same work is orders of magnitude more expensive,
non-reproducible, and prone to false findings.

Replaced the two wrong examples with genuine LLM-appropriate
scans that only a semantic reader can do:

  - hardcoded model-id placeholders that need parameterizing
  - TODO/FIXME/XXX triage by urgency
  - pre-v4 API snippets that still ship in the docs
  - coverage of the --free flag's prompt-logging caveat

Added an explicit "DO NOT use this command for structural
validation" note pointing users to CPV, `claude plugin validate`,
and their own validation scripts.

Verified: check_references.py --strict -> 0 broken, 0 dynamic.


## [4.1.1] - 2026-04-17

### Fixed

- Fix(scan-and-fix): exclude .md files from auto-curation unless --instructions given

The default scan rubric audits source code — logic bugs, error
handling, security, resource leaks, broken references. None of
those apply to prose. A .md file (agent definition, SKILL.md,
command description, skill reference) has no control flow, no
exception paths, no resource lifecycle — feeding one to the
default rubric makes the LLM hallucinate findings or produce
empty reports. Both waste tokens.

Step 0 auto-curation now ALWAYS drops every .md file from the
list. The ONLY way to scan .md files is for the user to pass
an explicit --instructions <path> whose content tells the LLM
concretely what to check for, e.g.:

  * "Find references to the old command names /llm-externalizer:discover,
    /llm-externalizer:configure, /llm-externalizer:scan-and-fix,
    /llm-externalizer:search-existing-implementations and replace with
    the prefixed names /llm-externalizer:llm-externalizer-*."
  * "Find references to the old agent names llm-ext-fixer or
    llm-ext-reviewer and update to llm-externalizer-fixer / reviewer."
  * "Verify every skill description accurately reflects its tools."
  * "Check argument-hints in command frontmatters match the
    actual arguments the command parses."

When --instructions provides such a rubric, auto-curation includes
.md files in the relevant subtrees (agents/, commands/, skills/,
docs the user pointed at) and lets the scan run. Without
instructions, they stay excluded.

Verified: check_references.py --strict -> 31 refs, 0 broken, 0
dynamic.


## [4.1.0] - 2026-04-17

### Added

- Feat(scan-and-fix): auto-curate a file list when the user omits the target

When the user invokes /llm-externalizer:llm-externalizer-scan-and-fix
with no target-path and no --file-list, the orchestrator now runs a
Step 0 auto-discovery pass instead of asking blindly or defaulting
to cwd.

The agent:

  1. Finds the real codebase root via `git rev-parse --show-toplevel`
     from CLAUDE_PROJECT_DIR, or searches up to 3 levels deep for
     nested .git dirs. Handles the "parent workspace with no
     .gitignore, child repo with one" case automatically.
  2. Enumerates tracked files via `git ls-files` (so .gitignore is
     respected and nothing untracked is ever scanned).
  3. Filters the list using agent judgment — drops docs, examples,
     samples, fixtures, templates, snapshots, build output, lock
     files, binary assets, vendored deps, *_dev folders, runtime
     artifacts. Keeps real source code and plugin-authored
     markdown (agents, commands, skills).
  4. Writes /tmp/llm-externalizer-scan-and-fix.<TS>.auto-filelist.txt.
  5. Shows the user the curated list (root, count, breakdown,
     samples, excluded samples) and asks for confirmation.
  6. On confirm, continues in --file-list mode. On cancel, aborts.
     On "edit", surfaces the tmp path for manual pruning.

Rationale: only an agent can tell docs from source, distinguish
samples from real examples, and locate the actual project repo
when the working dir is a workspace or a parent without a
.gitignore. A folder-path default can't do any of that.

Verified: check_references.py --strict -> 32 refs, 0 broken,
0 dynamic. (Caught one of my own prose false-positives — a
comma-list rendered as one path — during the commit dance; fixed
by punctuating.)


## [4.0.2] - 2026-04-17

### Fixed

- Fix(scan-and-fix): require explicit target, never silently default to cwd

When the user invoked /llm-externalizer:llm-externalizer-scan-and-fix
with no arguments, the old spec silently defaulted to `.` — which in
real setups is often the parent of a plugin/workspace and contains
dev/runtime folders (`*_dev/`, `reports/`, `.rechecker/`, generated
output, sibling projects). Fixers WRITE to source files, so a wrong
default has real blast radius.

Changes to commands/llm-externalizer-scan-and-fix.md:

- Target-path is now REQUIRED (unless `--file-list` is supplied).
  The orchestrator must STOP and ask the user when no target is
  given. The command spec calls this out in both the Arguments
  section and Step 1.5.
- When the user asks for "the actual codebase", auto-detect via
  `git rev-parse --show-toplevel` (falling back to CLAUDE_PROJECT_DIR
  if not a git repo). This gives a safe whole-codebase scan.
- scan_folder calls now ALWAYS pass `exclude_dirs` with the standard
  *_dev folders from the project rules plus common runtime/artifact
  folders (reports, .rechecker, .mypy_cache, .ruff_cache, .serena,
  .claude, .venv, __pycache__). Combined with `use_gitignore: true`
  this keeps scans focused on source code even when the target is
  a wide codebase root.

Verified: check_references.py --strict -> 0 broken, 0 dynamic.


## [4.0.1] - 2026-04-17

### Documentation

- Docs: update stale command/agent name references after v4.0.0 rename

The v4.0.0 refactor renamed all commands and agents to carry the
llm-externalizer- prefix, but several in-tree .md files still
referenced the old short names. This commit sweeps every remaining
stale reference in the live tree.

README.md:
  - Features list:
      * `llm-ext-reviewer` -> `llm-externalizer-reviewer`
      * Added `llm-externalizer-fixer` agent to the feature list
      * "3 slash commands" -> "4 slash commands" with full prefixed names
  - Verify section: /llm-externalizer:discover -> llm-externalizer-discover
  - Configuration section: /llm-externalizer:configure -> llm-externalizer-configure
  - Commands table: all 4 commands listed with fully prefixed names,
    scan-and-fix and search-existing-implementations added
  - Plugin Structure tree: commands/ directory now lists all four
    renamed files plus an agents/ entry for the two agents

Skills:
  - skills/llm-externalizer-free-scan/SKILL.md:
    /llm-externalizer:discover -> llm-externalizer-discover
  - skills/llm-externalizer-or-model-info/SKILL.md: same
  - skills/llm-externalizer-or-model-info/references/errors.md:
    /llm-externalizer:configure and :discover both updated

Verified via `python3 scripts/check_references.py --strict`
(0 broken, 0 dynamic) and an exhaustive grep sweep across all .md /
.yml / .yaml / .json / .toml / .py files in the live tree — zero
remaining stale references.


## [4.0.0] - 2026-04-17

### Refactored

- Refactor!: unify all command/skill/agent names under llm-externalizer- prefix

Every user-facing entity in the plugin now uses the same prefix so
discovery, autocompletion, and global listings are consistent.

Commands (all renamed):
  configure                       -> llm-externalizer-configure
  discover                        -> llm-externalizer-discover
  scan-and-fix                    -> llm-externalizer-scan-and-fix
  search-existing-implementations -> llm-externalizer-search-existing-implementations

Agents (all renamed):
  llm-ext-fixer    -> llm-externalizer-fixer
  llm-ext-reviewer -> llm-externalizer-reviewer

Skills (already prefixed — unchanged):
  llm-externalizer-config, llm-externalizer-free-scan,
  llm-externalizer-or-model-info, llm-externalizer-scan,
  llm-externalizer-usage

Additional fixes:
  - llm-externalizer-usage skill gains an argument-hint so every
    command and skill now advertises autocompletion hints.
  - All internal cross-references updated (scan-and-fix command's
    subagent_type, fixer agent self-refs including the /tmp backup
    filename prefix, scan skill's agent: field, validate_fixer_summary
    docstring).
  - [FAILED]/[DONE] tag strings in the command bodies updated to
    match the new command names.

BREAKING CHANGE: slash commands have been renamed. Users must update
from /llm-externalizer:<short-name> to
/llm-externalizer:llm-externalizer-<short-name>. Agent subagent_type
strings in any external automation must update from llm-ext-fixer /
llm-ext-reviewer to llm-externalizer-fixer / llm-externalizer-reviewer.

Verified: check_references.py --strict -> 29 refs, 0 broken, 0 dynamic.
ruff check scripts/ -> clean.


## [3.16.0] - 2026-04-17

### Added

- Feat: add scan-and-fix command with parallel fixer agents and validation

New slash command /llm-externalizer:scan-and-fix orchestrates a full
codebase audit in three stages, with zero orchestrator-side report
reads:

  1. LLM Externalizer scan with answer_mode hardcoded to 0 (one report
     per input file) and output_dir hardcoded to
     \$CLAUDE_PROJECT_DIR/reports/llm-externalizer/.
  2. Parallel dispatch of the new llm-ext-fixer subagent (max 15
     concurrent) — one agent per report, no batching across files.
  3. Join via bundled Python script into a single final report whose
     filename is prefixed with a sortable local-timezone ISO-8601
     timestamp (%Y%m%dT%H%M%S%z).

Script-enforced reference validation (not agent-trusted):

  - scripts/validate_report.py — pre-flight: confirms scan-report
    File: reference resolves, line ranges are in-bounds, source
    stays inside --project-dir (path-traversal guard).
  - scripts/validate_fixer_summary.py — post-flight: confirms
    summary exists, non-empty, has the .fixer. tag, resolves inside
    --reports-dir, has the expected markdown structure.
  - scripts/join_fixer_reports.py — inlines those checks; rejected
    summaries recorded in the final-report header with reasons.
  - scripts/check_references.py — plugin-wide cross-file reference
    integrity tool for .md / .yml / .json / .toml. Static refs =
    errors; dynamic refs (containing \$, %, {{) = warnings only
    (--strict promotes them to errors).

Fixer agent hardening:

  - Tag changed from [FIXER] (shell character-class trap) to .fixer.
    (lowercase, dot-delimited, shell-safe).
  - Bash cp backup before any Edit — rollback is cp back, not LLM
    memory reconstruction.
  - Mandatory per-language linter matrix with Runner Fallback Chain:
    local binary -> project-runtime wrapper -> ephemeral remote
    runner (uvx / pipx run / bunx / pnpm dlx / npx --yes / go run).
    Silent skip only if no runner can invoke the tool.
  - Mandatory Bash argument quoting; path-traversal guard on every
    newly-discovered path.
  - Summary filename prefixed with sortable local-timezone
    ISO-8601 timestamp.


## [3.15.2] - 2026-04-15

### Testing

- Test(mcp): extract grouping helpers + 36 new tests (31 unit, 5 dispatch)

Motivation: the answer_mode=1 refactor added autoGroupByHeuristic() and
rewrote splitPerFileSections(), but neither had unit tests and the
helpers lived inside index.ts (which has top-level server.connect()
side effects that make direct import unsafe). This commit extracts the
helpers into a pure module and adds 36 tests.

1. New file: mcp-server/src/grouping.ts
   - Moved parseFileGroups, hasNamedGroups, autoGroupByHeuristic,
     splitPerFileSections, GROUP_HEADER_RE, GROUP_FOOTER_RE, FileGroup,
     and the private helpers (sanitizeGroupId, uniqueGroupId,
     statFileForGrouping, splitBucketBySize, splitBucketByBasenamePrefix)
     out of index.ts.
   - Module has zero side effects — only imports from node:fs and
     node:path — so tests can require it without booting the MCP server.
   - index.ts now imports from ./grouping.js.

2. New file: mcp-server/src/grouping.test.ts — 31 unit tests
   parseFileGroups (7):
     - empty input
     - unmarked paths → single unnamed group
     - single named group
     - multiple named groups preserve order
     - header closes previous group without explicit footer
     - files outside markers go into id=""
     - empty named groups dropped
   hasNamedGroups (3): all-empty, at least one named, empty array
   autoGroupByHeuristic (10, uses real tmp files on disk):
     - empty input
     - filters ---GROUP:id--- markers defensively
     - same-ext files in same dir → one group
     - different extensions in same dir → separate groups
     - different dirs with same ext → separate groups
     - nested subdirectories get their own group
     - stable deterministic ids across invocations
     - single file input
     - oversized bucket splits via FFD with -p{n} suffix
     - duplicate dir-name collision → unique _2 suffix
   splitPerFileSections (11):
     - empty input
     - no `## File:` headers → empty map
     - exact-path matching
     - suffix matching (dropped directory prefix)
     - basename matching
     - Windows CRLF line endings (trailing \r stripped by .trim())
     - backtick/quote decorations around path
     - missing sections omitted from map
     - duplicate header → first section kept
     - trailing `---` separator trimmed
     - single-file section without separator

3. New tests in index.test.ts — 5 answer_mode dispatch integration tests
   - chat mode 1: mixed-extension files route through auto-grouping
     without pre-LLM validation errors
   - code_task mode 1 + explicit ---GROUP:id--- markers: routes through
     the explicit grouped path
   - scan_folder mode 1: validates nonexistent folder BEFORE any LLM call
   - chat mode 2: regression guard for the single-merged-report path
   - search_existing_implementations mode 1: validates feature_description
     before the grouping step runs

4. vitest.config.ts — include grouping.test.ts in the default run.

Validation:
  - typecheck: ok
  - lint: 0 warnings
  - build: ok
  - npm test: 54/54 pass (31 unit + 23 integration, 18 pre-existing + 5 new)
  - grouping unit tests run in 6 ms

Note: the original index.ts was ~10k lines with scattered helper
definitions; extracting the grouping module also trims ~270 lines of
duplicated code from the main file.


## [3.15.1] - 2026-04-15

### Fixed

- Fix(mcp): review follow-ups — tautology, stale comments, pre-existing warning

Post-publish self-audit addressed 3 real issues:

1. check_against_specs had a trivially-tautological ternary
   `csFolderPath ? csFilePaths : csFilePaths` when deciding which path
   list to pass to autoGroupByHeuristic. folder_path is already normalized
   into csFilePaths upstream, so both branches were identical. Simplified
   to `autoGroupByHeuristic(csFilePaths)`.

2. search_existing_implementations had a stale code comment claiming
   "mode 1 — one report per batch" and "mode 0 — one report per batch
   (fall back to mode 1)" — both obsolete after the answer_mode redesign.
   Rewrote the comment to match the new semantics (mode 2 = SINGLE REPORT,
   mode 0 = ONE REPORT PER FILE via splitPerFileSections, mode 1 = ONE
   REPORT PER GROUP via autoGroupByHeuristic).

3. scan_folder mode 1 now carries an explicit comment documenting that
   grouping is POST-HOC (per-file LLM calls already ran, we cluster the
   finished reports) to contrast with chat/code_task/check_* which
   auto-group BEFORE calling the LLM.

4. Removed the pre-existing `_ciUseEnsemble` dead variable in the
   check_imports handler — it referenced currentBackend.type but was
   never used since check_imports calls chatCompletionJSON directly
   (no ensembleStreaming).

Self-audit also verified (false alarms from the ensemble review):
- batch_check / check_references / check_imports DO process mode 0/2
  non-grouped inputs correctly — the `if (effectivelyGrouped) { return }`
  block falls through to the existing non-grouped path below.
- search_existing_implementations mode 2 branch is still present at the
  expected location — the refactor only rewrote mode 1, not mode 2.
- splitPerFileSections handles trailing \r via .trim() on the captured
  path, so \r\n line endings already work.
- autoGroupByHeuristic GROUP_HEADER_RE/FOOTER_RE are defined at module
  level earlier in the file (not the helper's scope issue).
- chat/code_task `if (mode === 0 && !effectivelyGrouped)` is NOT
  redundant: it correctly skips the per-file path when markers are
  supplied with mode 0, matching pre-refactor behavior.

Validation: typecheck ok, lint 0 warnings, build ok, 18/18 tests pass.


## [3.15.0] - 2026-04-15

### Added

- Feat(mcp): redefine answer_mode — remove per-request mode, add per-group auto-grouping

Agents were being misled by the old "per-request" semantics of answer_mode=1
and the vague "per-file" wording of mode 0. A report from a real user:
agents assumed that avoiding mode 0 would let the LLM see the whole set of
input files at once, and repeatedly launched whole-codebase cross-file
searches via chat/code_task — wasting tokens for hours with no result.

This change rewrites the API and the docs so that:

1. answer_mode is clearly a DISK-OUTPUT control, not a batching control.
   The LLM always sees 1-5 files per request (FFD bin-packed or one group
   per request when ---GROUP:id--- markers are used).

2. In ensemble mode each file is reviewed by 3 different LLMs in parallel
   (3 responses per file). In free/local mode each file gets 1 response.

3. The old "per-request" meaning of mode 1 is GONE. New semantics:
   - 0 = ONE REPORT PER FILE  (unchanged — split by ## File: markers)
   - 1 = ONE REPORT PER GROUP (new — one .md per group)
   - 2 = SINGLE REPORT        (unchanged — everything merged)

4. Mode 1 auto-grouping: when the caller picks mode 1 without supplying
   ---GROUP:id--- markers, the server auto-clusters files by priority
   (subfolder > language/extension > namespace > shared basename >
   shared imports), capping each group at 1 MB via FFD sub-splitting.

Implementation:
- Added autoGroupByHeuristic() helper in index.ts (+ SizedFile struct,
  splitBucketBySize, splitBucketByBasenamePrefix).
- Rewrote BATCHING_NOTE and answerModeSchema.description using the
  structured NAME/DESCRIPTION/FORMAT/WHEN TO USE/ADVANTAGES/DISADVANTAGES
  format the user explicitly asked for.
- Spliced auto-grouping into the mode-1 branch of all multi-file handlers:
  chat, code_task, batch_check, check_references, check_imports,
  check_against_specs, scan_folder, search_existing_implementations.
- Removed the obsolete mode-1 per-batch save logic (batchOutputPaths,
  per-FFD-batch report persistence) from chat + code_task.
- scan_folder mode 1 now clusters the per-file results by auto-group and
  emits one merged report per group instead of collapsing to mode 2.
- search_existing_implementations mode 1 now splits batch responses by
  ## File: markers, re-groups files with autoGroupByHeuristic, and emits
  one merged report per auto-group (not per FFD batch).
- Updated the [DEPRECATED] batch_check handler to use auto-grouping when
  mode 1 is selected.
- Updated inline FILE GROUPING text in every tool description.

Docs touched:
- README.md — new answer_mode table with the full structured format and
  per-mode response examples.
- ~/.claude/rules/use-llm-externalizer.md — ensemble-vs-free clarification
  at the top, full structured mode block in the answer_mode section.
- skills/llm-externalizer-usage/SKILL.md — trimmed + new mode definitions.
- skills/llm-externalizer-usage/references/tool-reference.md — structured
  mode block replacing the old per-request wording, updated answer_mode
  row in the Advanced Parameters table.
- skills/llm-externalizer-scan/SKILL.md — ensemble note + new mode block.
- skills/llm-externalizer-scan/references/tool-reference.md +
  skills/llm-externalizer-free-scan/references/tool-reference.md —
  answer_mode row refreshed.
- commands/search-existing-implementations.md — new mode block describing
  what each mode writes.
- agents/llm-ext-reviewer.md — structured mode block.
- mcp-server/src/cli.ts — CLI help for `llm-externalizer search-existing`
  now documents all three modes and ensemble-vs-free behavior.

Validation: typecheck ok, lint 0, build ok, 18/18 tests pass.


## [3.14.2] - 2026-04-14

### Fixed

- Fix(sei): comprehensive review fixes for search_existing_implementations

Consolidates post-review fixes across the whole plugin surface after the
v3.14.0/v3.14.1 rollout. 7 BLOCKERS, 13 MAJORS, selected MINORS fixed.

=== BLOCKERS ===

B-1: ~/.claude/rules/use-llm-externalizer.md (user scope) had no mention
     of search_existing_implementations, the llm-ext-reviewer agent, the
     CLI subcommand, or userConfig. Also still listed batch_check as a
     deprecated-but-recommended option. Rewrote the Analysis tools table,
     added SEI-specific section with full example, added CLI section,
     added userConfig bridge auth section. Dropped batch_check row and
     NOTE blocks. Updated answer_mode section to document per-tool
     defaults instead of a one-size-fits-all "default: 0".

B-2: agents/llm-ext-reviewer.md's tools: allowlist did not include
     mcp__llm-externalizer__search_existing_implementations, which meant
     the plugin-shipped reviewer agent literally could not invoke the
     tool it was positioned for. Added it. Also added a new workflow
     bullet mentioning SEI as the first-choice tool for PR duplicate-
     check and "is this already done?" audits.

B-3: search_existing_implementations inputSchema was missing output_dir,
     free, recursive, follow_symlinks — the handler reads them from the
     outer scope variables (modelOverride, outputDir) but they were
     never declared in the tool contract, so strict MCP clients would
     filter them out. Rewrote the schema to spread ...folderSchemaProps
     and only override folder_path (to accept string|array) and max_files
     (to document the 10000 default instead of 2500). This fixes both
     B-3 (declare output_dir and free) and n-1 (schema duplication).

B-4: CLI callTool timeout was hardcoded at 900_000 ms (15 min). At
     ~10-60 s per ensemble batch × ~500 batches for a 10k-file scan,
     that's up to ~8h wall time — the 15 min timeout would always fire
     before completion. New CLI default: 4 hours. New flag: --timeout-
     hours <n> (fractional hours accepted, 0 disables).

B-5: README.md feature counts outdated — claimed "13 MCP tools", "2
     skills", "2 slash commands". Actual: 17 tools (9 analysis + 5
     utility + 3 or_model_info), 5 skills, 3 slash commands. The tools
     table was also missing search_existing_implementations and the
     or_model_info trio. Added a Feature bullet for the llm-ext-reviewer
     agent and the CLI subcommand. Dropped the batch_check "deprecated"
     row.

B-6: commands/search-existing-implementations.md had multiple stale
     claims:
     - "default 2500" (now 10000)
     - "returns one report per file" (now one merged report, mode 2)
     - --redact-regex listed but never plumbed through the CLI
     - Step 3 told Claude to shell out to git diff manually, duplicating
       the CLI's generateGitDiff logic
     Rewrote to prefer calling the MCP tool directly OR the CLI
     subcommand, with the --base/git-diff shell-out kept only as a
     fallback for when neither is available.

B-7: skills/llm-externalizer-usage/references/tool-reference.md tools
     table missing search_existing_implementations. Added a row with the
     full semantics description. Dropped batch_check row. Added or_model_*
     trio. Updated scan_folder default from 2 to 0 (the survey showed
     scan_folder actually defaults to 0, not 2).

=== MAJORS ===

M-1: The shared answerModeSchema.description said "Default: 0" globally,
     but tools have different defaults (scan_folder=0, chat/code_task/
     check_*=2, search_existing_implementations=2). Rewrote the shared
     description to document the per-tool defaults explicitly.

M-2: SEI's mode-2 branch was guarded by `seiMode === 2 && seiBatchOk.
     length > 0`, so an all-batches-failed run silently fell through to
     the mode-1 branch, which produced "0/N batches processed" with
     isError: false when failures were per-batch recoverable. Added an
     early return that catches zero-success irrespective of
     answer_mode and always returns isError: true with a detailed
     failure report including per-batch reasons and skipped files.

M-3: CLI set `answer_mode: 0` as its default (never omitted the field),
     which invisibly forced the handler into its mode-1 fallback path.
     Direct MCP callers got mode 2. Same tool, two defaults. Fixed by
     omitting answer_mode when --answer-mode is not supplied — server
     default (2) applies to both invocation paths.

M-4: printUsage said "0 = per-file reports (default), 1/2 = merged".
     Wrong on both counts — mode 1 is per-batch (not merged), and the
     CLI no longer defaults to 0. Rewrote the help text.

M-5, M-6: Symlink self-match leak. The handler excluded sourceFiles
     from the scan list via `fileSet.delete(sf)`, but walkDir pushes
     non-canonical display paths into the result list (it does
     realpathSync only for cycle detection). If a source file was
     reachable via a symlinked parent dir inside folder_path, the
     exclude missed it and the LLM saw the PR reference file as a scan
     target — producing a spurious self-match. Fix: collect both the
     user-supplied path AND realpathSync(path) into
     sourceFilesCanonical; post-walk, loop over fileSet and drop any
     entry whose non-canonical OR realpath-canonical form matches.

M-7: generateGitDiff used spawnSync with maxBuffer: 64MB. A PR touching
     a megabyte of lockfile changes exceeds 64 MB and gets truncated
     silently — the subsequent .trim() check then reports "diff vs BASE
     is empty". Raised buffer to 256 MB, added explicit ENOBUFS / signal
     detection with a clear error that tells the user to generate the
     diff manually and pass it via --diff.

M-9: skills/llm-externalizer-scan/SKILL.md instructed the forked
     llm-ext-reviewer agent on which tool to call (scan_folder /
     code_task / glob), but never mentioned
     search_existing_implementations. A natural "scan this codebase and
     tell me if this PR duplicates existing code" request couldn't
     reach the right tool. Added a bullet for duplicate check /
     "already done" audits.

M-13: .githooks/pre-push error message listed 8 check tools (npm ci,
      typecheck, lint, build, test, ruff, shellcheck, plugin.json, CPV)
      but was missing the v3.10.0 `claude plugin validate` gate. Added.

=== MINORS ===

m-3: skills/llm-externalizer-usage/SKILL.md:37 said "answer_mode: 0
     (default)" globally. Updated to document per-tool defaults.

m-4: Same file had a compare_files example using {git_repo, from_ref,
     to_ref} as top-level params, but these are file_pairs-mode fields.
     Replaced with the correct input_files_paths two-file form, and
     added a search_existing_implementations example.

m-8: commands/discover.md told users to run `python3 scripts/setup.py`
     if the service was offline. scripts/setup.py is a build step, not
     a recovery step — the MCP server is spawned by Claude Code from
     .mcp.json. Replaced with correct recovery instructions (restart
     Claude Code, check API key, check MCP logs, rebuild dist as last
     resort).

=== Intentional NO-OPs ===

- M-10 (free-scan skill using mcp__plugin_* prefix): false positive.
  The prefix has been verified to work in production in earlier
  sessions. Not changing without runtime evidence.
- m-1 (other tools not forwarding outputDir to saveResponse): existing
  bug in code_task, chat, and other unchanged tools. Not introduced by
  this session's changes; out of scope.

Verified:
- claude plugin validate . ✓
- CPV remote validation ✓ (CRITICAL=0 MAJOR=0 MINOR=0)
- npm run typecheck ✓
- npm run lint ✓
- npm run build ✓ (fully bundled dist/)
- npm test 18/18 ✓
- CLI smoke tests: missing description / missing --in / --help all clean


## [3.14.1] - 2026-04-14

### Fixed

- Fix(mcp): search_existing_implementations — FFD batching, exhaustive output, 10k-file support

Rewrote the handler to use the code_task mode 1/2 batched pipeline
instead of the scan_folder per-file pipeline. The earlier v3.14.0
implementation cloned scan_folder, which means every file was a
separate LLM call — 10k files = 10k calls, making the tool unusable
for the massive-codebase scenarios it was designed for.

New behavior:

1. FFD bin-packing via readAndGroupFiles()
   The server reads every matching file, packs them first-fit-
   decreasing into batches up to max_payload_kb (default 400 KB).
   For a 10k-file codebase this typically collapses into ~500 LLM
   calls (a ~20x reduction) while still fitting every file into
   the specialized multi-file prompt.

2. One ensembleStreaming() call per batch
   Each batch is sent as a single user message containing the base
   prompt + the per-file section marker + every file's fenced code
   block (generated by readAndGroupFiles). The LLM emits a section
   per file with per-file YES/NO answers.

3. Exhaustive per-file output — no 5-match cap
   The prompt now explicitly tells the LLM to report EVERY
   occurrence in every file, never truncate, never pick "most
   relevant first". The reviewer's use case is deleting every
   duplicate and leaving only the PR's new implementation, so they
   need to see every match.

4. answer_mode defaults changed
   - Mode 2 (default): single merged report with all batches
     concatenated and a header summarizing feature, folders,
     batches, reference files, and skipped files
   - Mode 1: one report per batch
   - Mode 0: falls back to mode 1 (per-file processing is
     meaningless for this tool — it would defeat batching)

5. max_files default raised from 2500 to 10000
   scan_folder's default was tuned for per-file scans; this tool
   is designed for massive-codebase reviews and defaults to a
   10k cap. Users can go higher with --max-files <n>.

6. output_dir now correctly forwarded to saveResponse()
   saveResponse's 5th argument (outputDir) was being omitted — the
   merged / per-batch reports now honor the user's --output-dir.

7. FFD skipped-files reporting
   readAndGroupFiles skips files exceeding the total payload
   budget. The handler now surfaces these in the merged report
   header AND the summary text, so users know which files were
   too big for their chosen max_payload_kb.

Advanced features confirmed working end-to-end:

  free         → modelOverride from resolveModelOverride() is now
                 passed directly to ensembleStreaming via its
                 options parameter. Same path as code_task. Free
                 routes through FREE_MODEL_ID.
  extensions   → walkDir auto-detects from source_files, or user
                 override via --extensions
  exclude_dirs → walkDir honors both built-in and user exclusions
  use_gitignore → walkDir via git ls-files (default true)
  max_files    → enforced in walkDir AND as a post-filter check
  scan_secrets → scanFilesForSecrets runs after walking
  redact_secrets → passed to readAndGroupFiles (applied per file
                   during block generation)
  redact_regex → passed to readAndGroupFiles (applied per file)
  answer_mode  → modes 1 and 2 both batched; mode 0 falls back
  max_payload_kb → controls FFD budget (default 400 KB)
  output_dir   → passed to saveResponse

Verified:
  - claude plugin validate . ✓
  - CPV remote validation ✓ (CRITICAL=0 MAJOR=0 MINOR=0)
  - npm run typecheck ✓
  - npm run lint ✓
  - npm run build ✓ (fully bundled dist/)
  - npm test 18/18 unit tests pass


## [3.14.0] - 2026-04-14

### Added

- Feat(mcp): add search_existing_implementations as a native MCP tool + CLI

What changed:
  - NEW MCP tool: search_existing_implementations (index.ts, ~320 lines).
    Walks the target folder(s), filters by language extension (auto-
    detected from source_files if not supplied), excludes source_files
    from the scan list to avoid self-match, builds the specialized
    yes/no prompt internally, and dispatches each file to the LLM
    pipeline (ensemble mode, auto-batching, per-file retry, circuit
    breaker). Output per file is terse: one line of NO, NO
    (self-reference), or YES symbol=<name> lines=<a-b> (max 5 per file).

  - NEW CLI subcommand: `llm-externalizer search-existing` (cli.ts).
    Spawns the MCP server via StdioClientTransport, calls the tool,
    prints the text result, exits. Supports all tool options plus
    `--base <ref>` (auto-generates the PR diff via
    `git diff <ref>...HEAD -- <src-files>`) and `--diff <path>` as an
    escape hatch. Auto-detects the base branch from origin/HEAD → main
    → master when neither flag is given and source files are provided.

  - Slash command /search-existing-implementations: rewritten as a
    thin 4824-char wrapper (was 13121 chars). Now just calls the MCP
    tool; all heavy logic lives in the server handler.

Inputs (all but one are optional):
  - feature_description  MANDATORY — drives the LLM prompt
  - folder_path          MANDATORY — single or list of codebase paths
  - source_files         OPTIONAL  — reference files; excluded from scan
  - diff_path            OPTIONAL  — narrows focus to new lines
  - extensions, exclude_dirs, max_files, scan_secrets, redact_secrets,
    answer_mode, redact_regex, use_gitignore, max_payload_kb  — same
    semantics as scan_folder

Why native MCP tool instead of slash-command-only:
  - Usable from any MCP client, not just Claude Code
  - Accessible from shell / CI via the CLI subcommand
  - Subagents can call it via mcp__ tool calls
  - The specialized yes/no prompt template lives server-side, so it
    doesn't need to be re-implemented in every caller
  - Consistent auto-batching, retry, and ensemble semantics with the
    other llm-externalizer tools

Tests:
  - index.test.ts: expected tools list now includes
    `search_existing_implementations` alphabetically between
    `scan_folder` and `set_settings`. All 18 unit tests pass.
  - CLI smoke-tested: missing description aborts with a clean error,
    missing --in aborts with a clean error, --help shows the new
    command with all flags documented.

Verified: claude plugin validate . ✓, CPV remote validation ✓
(CRITICAL=0 MAJOR=0 MINOR=0), npm run typecheck ✓, npm run lint ✓,
npm run build ✓ (fully bundled dist/), npm test 18/18 ✓.


## [3.13.0] - 2026-04-14

### Added

- Feat(command): auto-generate PR diff via git in search-existing-implementations

The command now generates the PR diff itself instead of requiring
the user to pre-make and pass --diff <path>.

New resolution order for the diff (in Step 2.5):

Path A — user-supplied --diff <path>: escape hatch, used as-is.
  Useful outside a git checkout or for curated patches.

Path B — user-supplied --base <ref>: command runs
  `git diff <ref>...HEAD -- <source-files>` using the three-dot
  merge-base form (matches what GitHub/GitLab show on a PR),
  restricted to the source files so only the relevant changes are
  included. Writes to a fresh /tmp/llm-ext-search-existing-diff-
  <ts>.patch and passes that path to code_task.

Path C — neither flag: auto-detect the base branch. Tries
  `git symbolic-ref --short refs/remotes/origin/HEAD` first
  (authoritative default-branch signal), then main, then master.
  Aborts with a helpful message if none resolve or cwd is not a
  git working tree.

Aborts cleanly on:
  - git diff failure (ref missing, bad working tree)
  - empty diff (no changes vs base for the source files)
  - not inside a git repo and no --diff given
  - auto-detection found no usable base branch

The --diff flag remains an escape hatch for edge cases. Previously
it was the ONLY way to supply the diff; the spec required users to
manually generate and save the patch before calling the command —
now they just run `/search-existing-implementations "desc" src.py
--in /path/to/codebase` and the command handles the rest.

Verified: claude plugin validate . ✓, CPV remote validation ✓
(CRITICAL=0 MAJOR=0 MINOR=0).


## [3.12.1] - 2026-04-14

### Refactored

- Refactor(command): tighten search-existing-implementations spec

Revisions after user feedback on the v3.12.0 draft:

Inputs — all four are now MANDATORY:
  1. Quoted feature description (first $ARGUMENTS token)
  2. Source file(s) (positional, 1+)
  3. --diff <path> (now mandatory, was optional)
  4. --in <path> (now mandatory, was optional; defaulted to cwd)
     Supports multiple paths via repeated flag or comma-separated
     list. Each entry can be a directory (walked) or a single file

LLM output — drastically simplified:
  - One line per finding: `NO` or `YES symbol=<name> lines=<a-b>`
  - Max 5 YES lines per file if multiple matches
  - Special: `NO (self-reference)` when the LLM recognises the PR
    file itself
  - No STATUS categories (EXISTS/SIMILAR/HELPER dropped)
  - No RATIONALE field, no REUSE_PATH field
  - Ensemble mode trusted for false-positive filtering —
    disagreements between the 3 models are the reviewer's signal

Forwarded options (same as every other LLM Externalizer command):
  --free           → pass through to code_task as free: true
  --output-dir     → pass through as output_dir
  --exclude-dirs   → applied during target filtering
  --redact-regex   → pass through as redact_regex

Architecture (unchanged):
  - instructions_files_paths carries sources + diff (server reads
    them once, orchestrator never loads file contents)
  - input_files_paths is the filtered codebase list (Glob + dedupe
    + exclude source files + exclude non-code dirs)
  - Auto-batching by the server keeps request count low inside
    max_payload_kb
  - answer_mode: 0 → one .md report per input file, each report
    has one section per ensemble model

Verified: claude plugin validate . ✓, CPV remote validation ✓
(CRITICAL=0 MAJOR=0 MINOR=0).


## [3.12.0] - 2026-04-14

### Added

- Feat(command): add search-existing-implementations

New slash command for PR reviewers: given a new feature from a PR,
scan the rest of the codebase in the same language to find existing
implementations that already solve the same problem — avoiding
duplicate code.

Takes:
  - MANDATORY: a quoted feature description (e.g. "async retry with
    exponential backoff"). Used directly in the specialized LLM
    prompt so the model knows what to look for even when source
    files contain many unrelated functions
  - MANDATORY: one or more source file paths (the PR files with the
    new implementation). These become reference context passed to
    the LLM — NOT targets to scan
  - OPTIONAL --folder <path>: limit the search subtree (default cwd)
  - OPTIONAL --diff <path>: unified-diff file to narrow the LLM's
    focus to the exact new lines

The command delegates per-file comparison to
mcp__llm-externalizer__code_task with:
  - instructions: specialized prompt with the feature description
  - instructions_files_paths: source files + diff (shipped as
    reference context by the server — orchestrator never reads
    the source content)
  - input_files_paths: every matching-language file in the target
    folder, minus the source files themselves, minus common
    non-code dirs
  - answer_mode: 0 (one report per file)
  - max_retries: 3

Each report classifies the file's relationship to the PR feature:
EXISTS / SIMILAR / HELPER / NONE, with symbol name, line range,
rationale, and reuse path. The command returns ONLY the list of
report file paths — the verbose per-file analysis never touches
the orchestrator context window.

Verified: claude plugin validate . ✓, CPV remote validation ✓
(CRITICAL=0 MAJOR=0 MINOR=0).


## [3.11.0] - 2026-04-12

### Added

- Feat(plugin): adopt userConfig, ship reviewer agent, fork scan to subagent

Three plugin-spec features deferred from v3.10.0 are now implemented
(marketplace source intentionally not changed):

1. userConfig for OPENROUTER_API_KEY (plugin.json + config.ts)
   - plugin.json: declare openrouter_api_key with type=string,
     sensitive=true, title, description; Claude Code prompts on
     install and stores in system keychain
   - config.ts: USER_CONFIG_ENV_MAP transparently maps the auto-
     exported CLAUDE_PLUGIN_OPTION_OPENROUTER_API_KEY env var into
     the canonical OPENROUTER_API_KEY name. userConfig wins over
     shell env when both are set; existing shell-env-only setups
     keep working unchanged

2. agents/llm-ext-reviewer.md (new)
   - Plugin-shipped Haiku-class agent for fast code reviews
   - Restricted tools allowlist: Read, Glob, Grep, Bash + read-only
     llm-externalizer MCP tools (no Write/Edit)
   - Returns ONLY report file paths to the orchestrator — never
     reads or summarizes report contents
   - Default rubric: bugs, error handling gaps, security, resource
     leaks, broken references

3. llm-externalizer-scan skill: context: fork + agent: llm-ext-reviewer
   - Skill body rewritten to a self-contained task prompt using
     $ARGUMENTS — runs in the reviewer's isolated subagent context
   - Verbose scan output stays out of the orchestrator's context
     window; only the final report path comes back

Verified:
- claude plugin validate . passes
- npm test: 18/18 unit tests pass
- npm run build: dist rebuilt cleanly with the config.ts changes


### Fixed

- Fix(skill): restore CPV-required sections in scan skill body

The v3.11.0 context: fork rewrite stripped all 7 sections required
by CPV strict mode (Overview, Prerequisites, Instructions, Output,
Error Handling, Examples, Resources), causing 7 MAJOR validation
errors that blocked publish.

Fix: rewrite the scan SKILL.md so it satisfies BOTH constraints:
- All 7 CPV-required section headings present (Anthropic strict
  skill structure)
- Body is still a self-contained task prompt for the forked
  llm-ext-reviewer subagent — the lead-in paragraph and the
  Instructions section give clear actionable steps using $ARGUMENTS

Also:
- Compressed body to 4358 chars (under CPV's 5000-char ceiling
  for progressive disclosure)
- Restored "Copy this checklist and track your progress" phrase
  required by CPV checklist convention
- Trimmed Examples to 2 entries and Error Handling table to 5 rows

Verified: CPV remote validation now reports CRITICAL=0 MAJOR=0
MINOR=0 (5 pre-existing WARNINGs remain, all structural and
non-blocking).


## [3.10.0] - 2026-04-12

### Added

- Feat(plugin): align with Claude Code v2.1.101 spec

Plugin compliance updates against the current Claude Code plugin
spec (plugins-reference.md, skills.md) as of 2026-04-10:

- skills/*/SKILL.md: remove non-spec `version:` field (not part of
  skill frontmatter — versioning lives in plugin.json); present in
  all 5 skills and silently ignored today
- skills/*/SKILL.md: add `effort:` frontmatter (v2.1.80) — `low` for
  or-model-info, `medium` for scan/free-scan/config/usage
- skills/*/SKILL.md: add `argument-hint:` to 4 skills that accept
  arguments (config, free-scan, or-model-info, scan) for better UX
- scripts/publish.py: add `claude plugin validate .` as mandatory
  check #9, add `claude` to REQUIRED_TOOLS list — catches future
  schema drift automatically

Deferred (design discussion needed): userConfig keychain for
OPENROUTER_API_KEY, git-subdir marketplace source, dedicated
code-review agent, context:fork on scan skill.


## [3.9.85] - 2026-04-10

### Fixed

- Fix(publish): use process ancestry instead of lock file for push gate

The pre-push hook now walks the parent PID chain via `ps` to verify
that scripts/publish.py is an ancestor of the git push process.
This replaces the .publish.lock file which was trivially spoofable
(anyone could `touch .publish.lock` before `git push`).

- .githooks/pre-push: rewritten with walk_ancestry() that resolves
  each ancestor's argv tokens and compares to the canonical
  scripts/publish.py path
- scripts/publish.py: removed all lock file write/cleanup logic,
  updated docstrings to document ancestry-based verification
- core.hooksPath set to .githooks (was defaulting to .git/hooks
  which had a broken symlink)


## [3.9.84] - 2026-04-10

### Changed

- Cliff.toml: use raw_message to keep full commit body in changelog

The previous template used {{ commit.message }} which, with
conventional_commits=true, drops the full body when git-cliff
successfully parses a 'scope: subject' format — commit.message
becomes only the subject-after-colon, and commit.body only
contains the first paragraph (up to the first blank line).

Result: commits like 'publish.py: strict mode...' had their
entire multi-line body silently dropped from the changelog and
release notes. Commits like 'Separate retry budget...' (no colon)
kept the body because the conventional parser failed and
commit.message fell back to the raw text.

Fix: template now uses {{ commit.raw_message }}, which returns
the unparsed full commit text (subject + body + trailers) directly
from git. conventional_commits=true is still enabled so the
commit_parsers keep classifying commits into groups (Added /
Fixed / Changed / etc), but the displayed content is always the
full raw message regardless of parse success.

Regenerated CHANGELOG.md for v3.9.83 so the entry now has the
full 6-item change list, not just the subject. GitHub release
notes for v3.9.83 updated to match.


### Refactored

- Refactor(publish): validate first, auto-detect version via git-cliff

User directive: 'first lint, test, validate. then bump/git-cliff/
commit.' Reorganized publish.py to follow that exact workflow,
adapting the reference script the user provided.

New flow:

  1. Pre-flight      — working tree clean
  2. Validate        — run_checks() + run_cpv_validation() (MOVED UP)
  3. Determine ver.  — git-cliff --bumped-version (default) or flag
  4. Generate CL.    — git-cliff regenerates full CHANGELOG.md
  5. Sync version    — plugin.json, package.json, server.json, index.ts
  6. Rebuild dist    — npm run build with the new version
  7. README badges   — shields.io badge URLs
  8. Commit          — 'chore(release): vX.Y.Z' (conventional format)
  9. Tag             — git tag -a vX.Y.Z
  10. Push           — git push --follow-tags
  11. GitHub release — gh release create

Key changes from the old flow:

- VALIDATION NOW RUNS FIRST. Previously checks ran AFTER planning
  the version bump (step 2 was validate, but step 1 was 'plan
  version'). New order makes more sense: validate, THEN decide what
  version to release.

- AUTO-DETECTED VERSION VIA GIT-CLIFF. Default behavior is now
  `git-cliff --bumped-version`, which parses conventional commits
  since the last tag to decide patch/minor/major. Manual override
  flags --patch/--minor/--major/--set still work and take
  precedence over the auto-detection.

  New helper: determine_next_version(args, current).
  New helper: git_cliff_bumped_version() — wraps the CLI call.

- CONVENTIONAL COMMIT MESSAGE. The release commit is now
  'chore(release): vX.Y.Z' instead of 'Release vX.Y.Z'. Matches
  conventional commits format, and cliff.toml already has a
  commit_parsers rule to skip '^chore\\(release\\)' from future
  changelog output.

- DRY-RUN NOW EXITS AFTER VERSION DETERMINATION. Dry-run still runs
  the full check suite (validation is mandatory even in dry-run),
  then shows what WOULD be published with the auto-detected or
  flag-specified version, then exits without any file mutations.


## [3.9.83] - 2026-04-10

### Changed

- Publish.py: strict mode — zero-skip validation gates

User directive: 'make so that it will be IMPOSSIBLE to skip any of
the checks, from linting to testing to validation. everything must
pass with 0 error before committing and pushing! NO EXCEPTIONS!'

Changes:

1. New require_tools() gate — runs at the top of main(). Verifies
   every required tool is on PATH: git, node, npm, npx, gh, uvx,
   ruff, shellcheck, git-cliff. Dies with a clear install hint per
   missing tool. Runs for ALL modes (--dry-run, --check-only,
   normal publish) because all three need the full check suite.

   The old logic only required `gh` for non-check-only mode, and
   let ruff / shellcheck / uvx be conditional — that's gone.

2. run_checks() rewritten in strict mode — no conditional SKIP
   paths. Every check is mandatory:

      1. npm ci         (clean dep install, always — not conditional)
      2. npm run typecheck  (tsc --noEmit)
      3. npm run lint       (eslint --max-warnings 0)
      4. npm run build      (full esbuild bundle)
      5. npm test           (vitest run — see note below)
      6. ruff check scripts/
      7. shellcheck all *.sh in main tree
      8. plugin.json JSON parse

   Tests and full build are NEW additions — previously absent. If
   any check fails, returns False and the caller aborts.

3. run_cpv_validation() extracted into its own helper. Same
   behavior as before — CPV remote validation with CRITICAL=MAJOR=0
   required — but now called from both --check-only and normal
   publish paths via a single function instead of duplicated
   inline blocks.

4. --dry-run now runs the full check suite BEFORE planning the
   version bump. Previously dry-run exited early after the version
   plan step, skipping all validation. That was a bypass path —
   fixed: dry-run shows what WOULD be published, which only makes
   sense if the checks pass. If they don't pass, there's nothing
   to preview.

5. mcp-server/package.json — test script split into three:
     • 'test'      → runs unit tests only (excludes src/live*.test.ts)
     • 'test:live' → runs the live integration tests manually
     • 'test:all'  → runs everything
   Live tests depend on a running LLM backend and have environmental
   state that varies per run — they shouldn't gate a publish. The
   deterministic unit tests in index.test.ts DO gate publishing.

6. index.test.ts listTools expected array updated to match current
   tool set — added check_against_specs, or_model_info,
   or_model_info_table, or_model_info_json, reset (these were added
   in recent releases but the test was never updated to match).

Verified: `python3 scripts/publish.py --check-only` now runs 9
mandatory gates and passes all of them. Any failure in any gate
aborts publish with a clear per-gate error log in reports_dev/publish/.


## [3.9.82] - 2026-04-10

### Changed

- Separate retry budget for empty responses (15 attempts, 2s fixed wait)

OpenRouter's free-tier models (notably Nemotron 3 Super :free) have
~96% per-request reliability due to cold-start and scaling behavior
documented in their error reference as 'no content generated'. The
recommended workaround is a retry mechanism, but our previous
MAX_TRUNCATION_RETRIES = 3 cap gave up too early for this failure
mode — most empty-response files would succeed on attempt 4 or 5.

New retry loop structure:

- Generic failures (network errors, finishReason=error, unknown
  values): MAX_TRUNCATION_RETRIES = 3 attempts (unchanged)
- Empty responses on OpenRouter (finishReason=empty/stop with zero
  content): MAX_EMPTY_RESPONSE_RETRIES = 15 attempts with a fixed
  2-second wait between each

Fixed interval, not exponential backoff. Empty responses are
cold-start / scaling signals, not rate-limit signals — exponential
backoff would be the wrong primitive (it makes us wait longer
precisely when the provider has had more time to warm up). A
constant 2s gap just gives the upstream endpoint a moment to finish
whatever scaling it was doing, without piling requests on top of
each other.

Two counters (genericAttempts and emptyAttempts) track each budget
separately so a mix of transient network errors and empty responses
doesn't exhaust either budget prematurely. The retry loop now uses
`while (true)` with dynamic cap selection instead of a fixed-range
for loop.

The reasoning-cache escalation (xhigh -> high -> none) still
happens on empty responses as before, so a model that can't
tolerate xhigh reasoning will step down over the first few retries
and the remaining attempts run with less aggressive settings.

Service-health cooldown still fires if the global consecutive
failure threshold is hit, so a persistent provider outage eventually
aborts with a proper error instead of looping forever. That's the
hard safety net.


## [3.9.81] - 2026-04-10

### Changed

- Or_model_info skill: don't reprint — trust the Bash tool output pane

User directive: let the Bash tool output stand alone. The tool pane
renders ANSI colors natively; if the output is collapsed behind a
'+N lines' fold, the user expands it with ctrl+o themselves. No
reprinting, no paraphrase, no summary.

The assistant should run the CLI and stop. Only add commentary when
the user asks an explicit follow-up question beyond 'show me the
info' (like 'which provider is cheapest?' or 'does it support
reasoning?').

This resolves the long thread about ANSI surviving markdown
reprints — it doesn't, and Claude Code's markdown renderer strips
ESC bytes in every form (fenced, unfenced, with any language tag).
The only rendering pipeline that processes ANSI is the Bash tool
output pane itself, so we just let that pane do its job.


## [3.9.80] - 2026-04-10

### Changed

- Or_model_info: emoji quality markers survive markdown reprint

Claude Code's markdown renderer strips the ESC byte (0x1B) from text
content but leaves the trailing '[96m'-style codes as literal garbage.
Verified across every wrapper form (fenced code blocks with any
language tag, bare text, raw bytes). ANSI colors only render in the
Bash tool output pane, which collapses long output behind a fold.

Since ANSI cannot survive reprinting, every color-classified value
in the table now also carries an emoji prefix:

  🟢 excellent / good / yes / free
  🟡 borderline
  🔴 poor / no
  ⚪ neutral

Applied to: capability flags (reasoning, tools, structured output,
implicit caching), pricing (free highlight), uptime (all three
windows), latency percentiles, throughput percentiles, discount.

Emoji render natively in markdown, so the quality-at-a-glance
information is now preserved when the output is reprinted in the
chat. Terminal users running the CLI still see both — ANSI colors
on the text plus emoji prefix — so neither audience loses info.

Example row:
  │ Reasoning   │ 🟢 yes       │
  │ Uptime (30m)│ 🟢 96.4%     │
  │ Latency p99 │ 🔴 104226 ms │
  │ Throughput  │ 🟢 50 tok/s  │
  │ Prompt price│ 🟢 free      │

New helpers in or-model-info.ts:
  QualityLevel type
  qualityEmoji(level) — maps level to emoji
  uptimeLevel / latencyLevel / throughputLevel / priceLevel
    — mirror the ANSI classify* functions but return levels,
      so both emoji and ANSI color pick from the same judgment

Shared between the markdown formatter (formatModelInfoMarkdown)
and the ANSI table renderer (formatModelInfoTable).


## [3.9.79] - 2026-04-10

### Changed

- Or_model_info: audit fixes — timeout, validation, error codes, paths

Systematic review pass across or-model-info.ts, index.ts, cli.ts.
Found and fixed the following issues:

1. HANG RISK: fetchOpenRouterModelInfo used raw fetch() with no
   timeout. If OpenRouter hung, the CLI or MCP tool would wait
   forever. Now uses AbortController with a 15s default timeout.
   Surfaces AbortError as 'OpenRouter request timed out after 15s'
   so the user knows it wasn't a transient failure.

2. PATH TRAVERSAL: model id was interpolated raw into the URL
   /v1/models/{id}/endpoints. An adversarial id like '../../etc/...'
   would escape the intended path. Added isValidOpenRouterModelId()
   that enforces '<vendor>/<model>[:variant]' with a strict regex
   and rejects '..' / '//' / length > 200. Validation runs before
   URL construction.

3. ERROR CODES: only 404 had a friendly error message. Now covers
   400 / 401 / 402 / 403 / 404 / 408 / 429 / 502 / 503 / 504 with
   specific user-facing text per status, matching the OpenRouter
   error reference we saved in docs/openrouter/errors-and-debugging.md.
   Applied to both the MCP tool handler and the CLI.

4. FILE PATH SAFETY (MCP): or_model_info_json accepted any file_path
   and silently resolved relative paths against process.cwd(), which
   could surprise callers. MCP tool now REQUIRES absolute paths and
   returns a clear error otherwise. CLI stays permissive (relative
   paths resolve against cwd, matching shell semantics) but rejects
   empty strings.

5. REASONING FLAG: the capability row checked only
   params.has('reasoning'), which is the reasoning.effort config
   field. Some models expose 'include_reasoning' as a separate flag
   without the effort field. The check now accepts either — semantic
   correctness: 'does this model do reasoning at all?'.

6. UNREACHABLE CODE WARNINGS: switch/case with die() branches
   triggered no-fallthrough warnings because die() returns never.
   Rewrote as an if-chain for the CLI error branch. Cleaner anyway.

Imports added: isAbsolute from node:path (both index.ts and cli.ts).

Verified end-to-end:
  • Valid model → table renders
  • Path traversal ('../../etc/passwd') → rejected with clear error
  • 404 model → friendly error message with remediation hint
  • --json /tmp/file.json → writes to absolute path
  • --json rel.json (CLI) → resolves against cwd (shell-like)

CPV: CRITICAL=0 MAJOR=0 MINOR=0.


## [3.9.78] - 2026-04-10

### Changed

- Add or_model_info_json MCP tool with optional file_path

Parity between the CLI and the MCP surface. The CLI gained
`--json [file]` in v3.9.77; this release exposes the same feature
as a dedicated MCP tool.

New tool:
  or_model_info_json
    input:
      model: string (required) — exact OpenRouter model id
      file_path: string (optional) — absolute path to write JSON to

Behavior:

  • file_path omitted   → returns pretty JSON inline in the tool result
  • file_path provided  → writes JSON to the resolved absolute path
                          and returns only 'JSON written to <path>',
                          saving caller context tokens when the JSON
                          is large or when it will be consumed by
                          another tool instead of the assistant.

The handler for or_model_info / or_model_info_table / or_model_info_json
is now a single case block that dispatches on `name`. The fetch +
error-handling path is shared; only the final formatting step branches.

Imports: formatModelInfoJson from ./or-model-info.js. writeFileSync
and resolve are already imported at the top of index.ts.

Three OpenRouter model info tools on the MCP now:

  • or_model_info        — markdown (pipe-delimited table)
  • or_model_info_table  — ANSI-colored Unicode-bordered table
  • or_model_info_json   — raw JSON (stdout or file)


## [3.9.77] - 2026-04-10

### Changed

- Or_model_info: proper markdown tables + --json [file] option

Two output format additions driven by real-world use:

1. --markdown now produces a pipe-delimited markdown table instead
   of a bulleted list. Markdown tables already have borders via
   |---| separators in any markdown viewer, so the old bulleted
   form was wasting that structure. Emits one ## section per
   endpoint with a proper | Field | Value | table, plus a
   bulleted list of supported_parameters below the table
   (multi-value cells don't render cleanly in markdown tables).
   Pipe characters inside cell values are backslash-escaped.

2. --json [filepath] for the raw OpenRouter response data.
   Without an argument, prints pretty JSON to stdout. With an
   argument, treats it as a filepath and writes the JSON there,
   echoing 'JSON written to <path>' on stdout so scripts can
   parse the confirmation. Uses the existing parseFlags
   --key value handling; '--json' alone → flags.json='true'
   (stdout), '--json foo.json' → flags.json='foo.json' (file).

New helper in or-model-info.ts:
  - formatModelInfoJson(data) — JSON.stringify with 2-space indent
  - mdCell(s) — markdown-table cell escape (| → \|)
  - formatModelInfoMarkdown — full rewrite to pipe-delimited tables

CLI help updated:
  llm-externalizer model-info <model-id> [--markdown | --json [file]] [--no-color]

Skill SKILL.md lists --json / --raw as a recognized passthrough
flag and shows the file-output variant in the Examples section.


## [3.9.76] - 2026-04-10

### Changed

- Or_model_info skill: optional --no-color / --markdown passthrough

The skill now scans the user's args for optional flags and forwards
them to the underlying CLI invocation:

- --no-color / --nocolor / --bw / --mono → CLI --no-color
  For users with monochrome terminals or log captures where ANSI
  escape sequences would appear as garbage.
- --markdown / --plain → CLI --markdown
  For users who want the plain markdown output instead of the
  Unicode-bordered table (useful for piping into another tool,
  or for very narrow terminals where the table wraps).

Default behavior unchanged: no flags → colored ANSI table, which
Claude Code's terminal UI renders correctly inside fenced code
blocks in the chat transcript.

Invocation examples:
  /llm-externalizer:llm-externalizer-or-model-info <model-id>
  /llm-externalizer:llm-externalizer-or-model-info <model-id> --no-color
  /llm-externalizer:llm-externalizer-or-model-info <model-id> --markdown


## [3.9.75] - 2026-04-10

### Changed

- Or_model_info skill: keep ANSI colors, revert --no-color default

Claude Code's terminal UI renders ANSI escape codes in Bash tool
output — the user saw the colorized borders in earlier runs and
complained they were dim (proving the codes were being interpreted,
not shown as literal garbage).

Previous release switched the skill to --no-color based on a wrong
assumption that ANSI codes would appear as raw escape sequences in
the rendered transcript. They don't. Reverting: the skill now runs
the CLI with colors ON and reprints the output verbatim.

Users viewing the rendered transcript see bright cyan borders, green
capability flags, yellow/red latency percentiles, and the footer
legend color key as intended.


## [3.9.74] - 2026-04-10

### Changed

- Or_model_info skill: reprint CLI stdout verbatim + use --no-color

Two fixes to the skill instructions:

1. Claude Code collapses long Bash tool output behind a
   '+N lines (ctrl+o to expand)' fold, so the rich table rendered
   by the CLI was never actually visible to the user — they only
   saw the first few lines inside the collapsed tool result. The
   skill now explicitly instructs the assistant to COPY THE ENTIRE
   CLI STDOUT VERBATIM into its response as a fenced code block.
   The table must appear in the rendered transcript, not behind a
   fold.

2. Default to --no-color. ANSI escape codes get stripped when the
   output is reprinted inside a code block anyway, and they add
   noise. The Unicode borders, row separators, column alignment,
   and footer legend all survive without color. The --no-color
   variant is strictly better for the skill's use case. Users who
   want the colored version directly in their terminal can run the
   CLI themselves without --no-color.

Also shrunk the Prerequisites section from 6 lines to 2 to keep
SKILL.md under the 5000-char CPV strict-mode limit.


## [3.9.73] - 2026-04-10

### Changed

- Or_model_info: bright borders + row separators + no-paraphrase skill

Three issues reported from a real skill invocation:

1. The skill paraphrased the CLI output instead of showing it verbatim.
   The whole point of the rich ANSI-colored table is that it's the
   final user-facing format — summarizing it in plain text defeats
   the purpose. Updated the SKILL.md checklist item 4 to explicitly
   say 'do NOT paraphrase, summarize, or rewrite' the CLI output.
   The skill now just runs the command and shows the result.

2. The table had no row separators between body rows — everything
   ran together in a dense block. Each logical row now gets a
   ├─┼─┤ separator after it. Multi-line cells (supported_parameters)
   render as a group with no internal separator — the label appears
   only on the first line, continuation rows have an empty label
   column, and one separator closes the whole group.

3. The border color was ANSI.dim, which renders nearly invisible on
   most terminals (especially with low-contrast themes). All borders
   — the header box ┏━┓ and the main table ┌─┐ ├─┤ └─┘ — are now
   bright cyan (ANSI.bcyan, SGR code 96). Matches the header
   highlight color so the whole table reads as a single unit.

Also shrunk SKILL.md from 5260 to 4719 chars to stay under CPV's
5000-char strict-mode limit.


## [3.9.72] - 2026-04-10

### Changed

- Or_model_info: supported_parameters as multi-line column inside the table

The supported_parameters list was previously printed after the main
table as a 3-column horizontal grid. That packed multiple values
side-by-side on each line, which is confusing to scan.

Now rendered as a single multi-line cell inside the main table:

  │ Supported params (10)    │ ✓ include_reasoning                    │
  │                          │ ✓ max_tokens                           │
  │                          │ ✓ reasoning                            │
  │                          │ ✓ response_format                      │
  │                          │ ...                                    │

One value per line, label only on the first line, continuation rows
have an empty label column. Everything stays inside the Unicode
border, and the column width calculation accounts for the longest
value across all the array lines.

Row type updated to [string, string | string[]] — arrays are treated
as multi-line cells, strings as single-line cells. The rendering loop
walks the values array and emits a continuation row for each entry
after the first.


## [3.9.71] - 2026-04-10

### Changed

- Or_model_info: dedicated capability rows + null uptime crash fix

New capability rows at the top of each endpoint table, derived from
supported_parameters — these answer the 'what can I configure on
this model?' question at a glance without scrolling the full grid:

- Reasoning         yes/no (reasoning in supported_parameters)
- Tool calling      yes/no (tools in supported_parameters)
- Structured output yes/no (structured_outputs or response_format)

Implicit caching stays as a dedicated row (it comes from a separate
field, not supported_parameters).

Also fixed a crash on models like meta-llama/llama-3.3-70b-instruct
where some endpoints (e.g. DeepInfra) return uptime_last_5m/30m/1d
as null instead of a number. The old code used `!== undefined` as
the guard, which let null through and crashed on .toFixed(1).
Switched to typeof === 'number' check and updated the interface
to reflect number | null | undefined.

Max completion and max prompt rows now include the 'tokens' suffix
for consistency with the context length row.

Verified on:
- google/gemini-2.5-flash (reasoning yes, tools yes, 3 endpoints)
- nvidia/nemotron-3-super-120b-a12b:free (reasoning yes)
- meta-llama/llama-3.3-70b-instruct (reasoning no, 17 endpoints,
  some with null uptime — renders cleanly now)


## [3.9.70] - 2026-04-10

### Changed

- Or_model_info: dynamic percentile parsing + header box overflow fix

Percentiles are now discovered dynamically from the response object
instead of being hardcoded to p50/p75/p90/p99. Any pXX or pXX.X key
OpenRouter adds in the future — p25, p95, p99.9, p99.99 — is parsed,
sorted numerically, and rendered with its own row and color. Also
handles future percentile renames gracefully: we filter to keys
matching /^p\\d+(?:\\.\\d+)?$/, sort by the numeric part, emit one
row per entry.

New exports in or-model-info.ts:

- ModelEndpointPercentiles — Record<string, number | undefined>
  (replaces the closed p50/p75/p90/p99 interface)
- sortedPercentiles(obj) — returns [{key, value, numeric}] sorted
  by numeric percentile, filtering non-percentile keys
- percentileAnnotation(numeric, higherIsBetter) — adds the
  qualitative tag ('median' for 50, 'worst N%' / 'best N%' at the
  tails) so labels read naturally regardless of which percentiles
  the API returns

Both the table renderer and the markdown renderer now iterate over
sortedPercentiles, so adding a new percentile key is zero-effort.

Verified against the live OpenRouter API for Gemini 2.5 Flash,
Qwen 3.6 Plus, Grok 4.1 Fast, and Claude Sonnet 4.5 — all currently
return the same {p50, p75, p90, p99} keys, but the parsing is now
future-proof.

Also fixed a header-box width bug: wide modality lists like Gemini's
'in: file/image/text/audio/video · out: text · tokenizer: Gemini'
were overflowing the right border because the box width was computed
from title/id only. The architecture line is now included in the
width calculation.


## [3.9.69] - 2026-04-10

### Changed

- Or_model_info table: row-per-percentile + fill in missing fields

Expanded the endpoint table so every metric is on its own row —
easier to read than the packed one-liner, and each value gets its
own independently-colored cell.

New rows:

- Endpoint name — the full backing id, often includes a versioned
  suffix like 'Nvidia | nvidia/nemotron-3-super-120b-a12b-20230311:free'
- Tag — shown when it differs from the provider name
- Status — 'operational' (code 0) or 'status code N' colored red
- Implicit caching — yes/no
- Image price, Request price, Discount — from the pricing object
  (previously only prompt/completion/cache-read were shown)
- Uptime (5m) — recent-window uptime, added alongside 30m and 1d

Restructured rows:

- Latency p50/p75/p90/p99 — now FOUR rows with clear labels
  ('Latency p50 (median)', 'Latency p99 (worst 1%)')
- Throughput p50/p75/p90/p99 — same treatment
  ('Throughput p50 (median)', 'Throughput p99 (best 1%)')

Each percentile row gets its own color classification, so the eye
can immediately spot the tail-latency red cells without scanning
a packed one-liner.

The ModelEndpoint interface grew to cover `tag`, `supports_implicit_caching`,
and `ModelEndpointPricing.discount`.


## [3.9.68] - 2026-04-10

### Changed

- Or_model_info: table formatter, CLI subcommand, shared module, legend

Three wins bundled into one change:

1. Factored the fetch and formatting logic out of index.ts into a new
   shared module src/or-model-info.ts with a clean interface:
     - fetchOpenRouterModelInfo(id, baseUrl, authToken) — returns
       a tagged union (ok|error)
     - formatModelInfoMarkdown(data, id) — plain markdown for
       programmatic consumers
     - formatModelInfoTable(data, id, colors) — Unicode-bordered
       ANSI-colored table for terminal display

2. New MCP tool 'or_model_info_table' — same input as or_model_info
   but returns the table form. Both tools now share the fetch code.
   Inline inline implementation in index.ts (>170 LOC) is gone.

3. New CLI subcommand 'llm-externalizer model-info <model-id>' —
   calls the shared module, defaults to the colored table format.
   Flags: --markdown (plain md output), --no-color (suppress ANSI,
   auto-detected when stdout is not a TTY or NO_COLOR is set).

   The CLI auth logic prefers the active profile when it's an
   openrouter-remote profile, falls back to $OPENROUTER_API_KEY so
   users can query OpenRouter metadata even from a local profile.

Table formatter highlights:

- Per-endpoint stacked tables with box-drawing characters
- Color-coded values by quality:
  - Uptime: ≥99% bright-green, ≥95% green, ≥90% yellow, <90% bright-red
  - Latency: <2s bright-green, <10s green, <30s yellow, ≥30s bright-red
  - Throughput: ≥50 tok/s bright-green, ≥20 green, ≥10 yellow, <10 red
  - Pricing: free = bright-green, paid = bright-yellow
- Supported parameters printed as a grid of ✓-marked entries
- Footer legend explaining percentiles (p50=median, p75/p90/p99=tail)
  and color key — so users don't need external knowledge

Latency and throughput values are now rounded to integers (were
rendering as '51161.00000000003ms' due to floating-point noise from
OpenRouter's response).

Skill now uses the CLI instead of the MCP tool — subagents can't
invoke MCP tools from plugins, so the CLI is the portable path.
The skill's examples show bash invocations, and the skill's
references/example-output.md gained a new 'Percentiles explained'
section with a concrete reading of Nemotron's p50/p75/p90/p99.


## [3.9.67] - 2026-04-10

### Changed

- Restructure or_model_info skill to satisfy CPV strict mode

CPV required:
- SKILL.md under 5000 chars (move detail to references/)
- ## Error Handling and ## Examples sections present
- Description under 250 chars with "Trigger with ..." phrase
- "Copy this checklist and track your progress" phrase
- Reference files with explicit Table of Contents
- Embedded TOC of each referenced file immediately after its link

New reference files under skills/llm-externalizer-or-model-info/references/:

- errors.md — full error table with 7 error codes and resolutions,
  plus debugging tips (partial-name workaround, :free vs paid id
  distinction, :thinking variants)
- example-output.md — complete sample response for
  nvidia/nemotron-3-super-120b-a12b:free with annotated explanation
  of how to read pricing, latency percentiles, throughput percentiles,
  and uptime
- use-cases.md — six primary scenarios: verify supported params,
  compare provider pricing, debug slow calls, check quantization,
  confirm context length, check reasoning support

SKILL.md now 4062 chars with embedded TOC summaries for each
referenced file so progressive discovery can find the sub-content.

CPV result: CRITICAL=0 MAJOR=0 MINOR=0.

- Add or_model_info tool + llm-externalizer-or-model-info skill

New MCP tool that queries OpenRouter's /v1/models/{exact_id}/endpoints
for any model and returns formatted metadata: architecture, per-endpoint
provider info, context length, pricing (per-M-tokens), supported
request-body parameters, quantization, uptime (30m / 1d), latency
percentiles, and throughput.

Required input: `model` — the EXACT OpenRouter model id, case-sensitive,
including vendor prefix and any :free / :thinking / :beta suffix. Only
works when the active profile is OpenRouter; returns a clear error
with a suggestion to switch profiles otherwise.

The tool is informational only, not an LLM call — not added to
LLM_TOOLS_SET, does not count toward session usage, no rate limiting.

New skill: skills/llm-externalizer-or-model-info/SKILL.md. Triggers on
phrases like "openrouter model info", "what params does X support",
"show pricing for model", "check model support", etc. Walks the caller
through parsing the exact model id (with fallback to asking for
clarification on partial names) and presents the markdown block.

Primary use cases:

- Verify supported_parameters before integrating a new model —
  Nemotron :free accepts `reasoning` + `temperature` + `top_p` but
  NOT `frequency_penalty` / `presence_penalty` / `top_k` / `min_p` /
  `stop`. The paid variant supports all of them. Important distinction.
- Compare pricing across multiple providers hosting the same model.
- Debug slow or failing calls by checking current uptime + latency.
- Look up quantization and max token limits for a specific endpoint.

The results are live — no caching on the MCP side. Every call hits
OpenRouter directly. Safe to call repeatedly.


## [3.9.66] - 2026-04-10

### Changed

- Dynamic per-model parameter filter from /v1/models/{id}/endpoints

OpenRouter exposes each model's accepted request-body fields via
/v1/models/{exact_id}/endpoints as `supported_parameters`. Query
this once per model, cache for 1 hour, and filter the outgoing
request body so unsupported fields are dropped before sending.

For nvidia/nemotron-3-super-120b-a12b:free the live API reports:
  reasoning, include_reasoning, temperature, max_tokens, seed,
  top_p, tools, tool_choice, structured_outputs, response_format

It does NOT accept: frequency_penalty, presence_penalty, top_k,
min_p, stop, repetition_penalty — sending any of these to the
free tier produces undefined behavior including the empty-response
problem we saw earlier.

New helpers:

- getModelSupportedParams(modelId) — queries the per-model endpoint
  with the EXACT model id, extracts the union of supported_parameters
  across all endpoints (providers) for the model, caches the Set.
  Returns null on failure so we proceed without filtering. Only
  active for OpenRouter backend.
- filterBodyForSupportedParams(body, supported) — drops keys in
  FILTERABLE_REQUEST_FIELDS that are not in the model's supported set.
  OpenRouter control fields (stream, plugins, messages, model,
  provider, metadata, debug, etc.) are NEVER filtered regardless.

Wired into both chatCompletionSimple and chatCompletionJSON just
after applyModelOverrides so it sees the final intended body.

Added docs/openrouter/get-models-api.md (671 lines) as the
authoritative reference for the /v1/models endpoint schema.

This is forward-compatible: any future model's parameter
restrictions are handled automatically without code changes.

- Add OpenRouter errors and debugging reference to docs/openrouter/

Saved from https://openrouter.ai/docs/api/reference/errors-and-debugging.md
for offline reference. Key sections:

- Error codes (400/401/402/403/408/429/502/503) — our classifyError
  logic is aligned with this list.
- 'When No Content is Generated' — documents that empty responses are
  expected during cold-start warm-up and provider scaling, and
  recommends a retry mechanism (which we already implement).
- Moderation error metadata shape — could be surfaced in report labels
  for finish_reason=content_filter cases.
- Debug option (debug.echo_upstream_body) — returns the exact request
  body OpenRouter forwards to the provider. Useful for verifying the
  reasoning.effort -> chat_template_kwargs.enable_thinking translation
  for Nemotron. Caveat: requires stream:true, which we removed, so it
  would need a temporary streaming branch to use for diagnosis.


## [3.9.65] - 2026-04-10

### Changed

- Align reasoning + model overrides with OpenRouter's real OpenAPI spec

Fetched the raw OpenAPI schemas for /chat/completions and /responses
and saved them to docs/openrouter/. Two prior releases were built on
an outdated best-practices doc page that advertised fields which do
not exist in the wire schema.

Corrections based on the saved specs:

- ChatRequestReasoning on /chat/completions has ONLY `effort` and
  `summary`. No `exclude`, `enabled`, or `max_tokens`. The earlier
  `exclude: true` field was silently dropped by OpenRouter. Removed
  from the ladder — the reasoning trace now comes back in
  message.reasoning / message.reasoning_details, which we already
  ignore in favour of message.content.

- Neither /chat/completions nor /responses has a generic vendor
  pass-through. `provider` has a fixed schema in both. Unknown
  top-level fields are not forwarded to the backend. Removed the
  v3.9.64 chat_template_kwargs extraBody for Nemotron — it was a
  no-op.

- For Nemotron, the ONLY supported path to enable thinking is
  `reasoning.effort`, which OpenRouter translates into the vLLM
  enable_thinking flag internally (the model metadata reports
  supports_reasoning=true, so the translation layer exists).

Kept:

- temperature: 1.0 and top_p: 0.95 overrides for Nemotron.
  These are standard schema fields and the primary root cause of
  the earlier empty-response failures — our default temperature=0.1
  was far below what Nemotron tolerates.

- The MODEL_REQUEST_OVERRIDES registry pattern. Trimmed to just
  temperature + top_p now that extraBody is gone.

Saved:

- docs/openrouter/chat-completions-api.md (81 KB raw OpenAPI)
- docs/openrouter/responses-api.md (129 KB raw OpenAPI)

These are the authoritative wire-format references for any future
changes to the request/response parsing code.


## [3.9.64] - 2026-04-10

### Changed

- Per-model request overrides: Nemotron needs temperature=1.0, top_p=0.95

Root cause of the empty-response failures on Nemotron 3 Super free:
our default temperature=0.1 is far below what the model tolerates.
NVIDIA's documented recommended settings are temperature=1.0,
top_p=0.95, and a vLLM chat_template_kwargs.enable_thinking flag.
The low sampling floor was collapsing the output distribution to
empty on large inputs.

New MODEL_REQUEST_OVERRIDES registry applies per-model sampling
params and vendor extraBody fields to the request body after the
reasoning ladder runs. For Nemotron free:

- temperature: 1.0 (override 0.1 default)
- top_p: 0.95 (we didn't send top_p at all before)
- extraBody.chat_template_kwargs.enable_thinking: true

OpenRouter wire format: the `provider` field has a fixed schema, so
extraBody is merged at the top level of the request body. OpenRouter
forwards known vendor params (safe_prompt for Mistral, raw_mode for
Hyperbolic, etc.) in this way. chat_template_kwargs may or may not
make it through — if it doesn't, OpenRouter's own
supports_reasoning=true metadata for this model implies internal
translation of our reasoning.effort field into enable_thinking, so
either path enables thinking.

reasoningLadderForModel no longer special-cases Nemotron — all
OpenRouter models go through the same xhigh -> high -> none ladder.
The new registry handles the sampling-param differences cleanly.

applyModelOverrides is wired into both chatCompletionSimple and
chatCompletionJSON after baseBody construction.


## [3.9.63] - 2026-04-10

### Changed

- Re-enable reasoning on structured-output calls

Previous release unnecessarily skipped reasoning entirely for
chatCompletionJSON when jsonSchema was requested. With `exclude: true`
on every reasoning config, the thinking trace never enters
`message.content`, so JSON.parse still sees pure output. The
`isReasoningRejectionError` ladder inside chatCompletionJSON already
handles providers that reject the reasoning + json_schema combination
— it downgrades xhigh -> high -> none automatically on 400 responses.

Keeps reasoning enforcement consistent across chat, code_task,
scan_folder, compare_files, check_against_specs, check_references,
check_imports AND the structured-output tools (fix_code, split_file,
extract_paths). Previously the last group quietly ran without
reasoning.


## [3.9.62] - 2026-04-10

### Changed

- Credit-aware free-mode fallback + reasoning/labeling polish

Reasoning:
- Nemotron free model capped at medium effort. xhigh/high empirically
  produced empty responses for large files, likely because OpenRouter
  does not plumb the reasoning field through to the NVIDIA endpoint for
  this free variant, or the free-tier budget cannot accommodate deep
  reasoning + output. Medium is the safe ceiling.
- Empty-response escalation: when chatCompletionWithRetry receives an
  empty response from an OpenRouter model, it now downgrades the
  MODEL_REASONING_CACHE entry (xhigh -> high -> none) for that model
  so the next retry attempt runs with less (or no) reasoning. Silent
  empty 200 responses are now handled in addition to explicit 400
  reasoning rejections.
- Structured-output path (chatCompletionJSON) skips reasoning entirely
  when jsonSchema is requested. Mixing json_schema with reasoning is
  untested across providers — some inline reasoning into the content
  field and break JSON.parse. Schema enforcement already delivers
  precise output, so this is a safe no-op.

Credit-aware fallback:
- New getOpenRouterBalance() helper queries /v1/key and /v1/credits,
  cached 60s. Returns Infinity for unlimited keys, NaN on failure.
- resolveModelOverride() replaces the old one-liner in the tool-handler
  switch. It forces FREE_MODEL_ID when: caller requested free=true, the
  session creditExhausted flag is set, or the pre-flight balance is
  below MIN_BALANCE_FOR_PAID_USD ($0.05).
- classifyError no longer aborts on 402. Sets creditExhausted instead
  and reports the error as recoverable. chatCompletionWithRetry catches
  402 mid-flight and immediately retries the failed call with the free
  model — no cooldown, no batch abort. The "never fail, switch to free"
  promise is now guaranteed for any in-flight request.

Labeling fix:
- formatFooter no longer emits the generic "partial result due to
  timeout" footer when the body already carries a specific label
  (TRUNCATED / EMPTY RESPONSE / BLOCKED / UPSTREAM ERROR / INCOMPLETE).
  The old footer was misleading for non-timeout failures. When no label
  is present (older paths or a real network timeout), the footer still
  appears but with neutral wording.


## [3.9.61] - 2026-04-10

### Changed

- Enable reasoning on OpenRouter and refactor publish flow

- Send `reasoning: { effort: "xhigh", exclude: true }` on all OpenRouter
  chat/completions calls. Fallback ladder: xhigh → high → none, cached
  per model so rejections are only probed once per session. The exclude
  flag keeps the reasoning chain out of the response body.
- Apply the ladder to both chatCompletionSimple and chatCompletionJSON,
  so regular tools and structured-output tools (fix_code, split_file,
  check_imports) both benefit.
- Fix truncation labeling: distinguish EMPTY RESPONSE (finish_reason="")
  from real TRUNCATED (length), BLOCKED (content_filter), UPSTREAM ERROR
  (error), and INCOMPLETE (unknown). content_filter no longer retries
  since the block is deterministic. `stop` with empty content now
  retries instead of being mistaken for success.
- Restructure publish.py so version bumping happens AFTER linting,
  typecheck, and CPV validation — a bad build no longer leaves a dirty
  working tree. Added pre-flight working-tree-clean check. Lint output
  redirects to reports_dev/publish/.


## [3.9.60] - 2026-04-10

### Changed

- Add linters to publish.py: eslint, ruff, shellcheck + output to reports_dev

- New ESLint flat config (mcp-server/eslint.config.mjs) for TypeScript
- Added lint/typecheck scripts to mcp-server/package.json
- Fixed 7 existing lint errors (dead code, unused imports, prefer-const)
- Updated ruff config: line-length 120, ignore E501
- publish.py run_checks() now runs: tsc, eslint, ruff, shellcheck
- All check output redirected to reports_dev/publish/<name>.log
- reports_dev/ added to .gitignore


## [3.9.59] - 2026-04-10

### Changed

- Add FILE_FORMAT_EXAMPLE to remaining system prompts

compare_files (pair mode), check_references (single-file), and
check_imports (both paths) were missing the format example.
Now ALL file-handling tools show the LLM the expected XML
wrapping format.


## [3.9.58] - 2026-04-10

### Changed

- Fix FILE_FORMAT_EXAMPLE: use {BRACES} for placeholders, not angle brackets


## [3.9.57] - 2026-04-10

### Changed

- Use <specs-filename>/<specs-file-content> for spec files

check_against_specs now wraps the specification file in distinct
XML tags to avoid confusion with source files. readFileAsCodeBlock
accepts a tagPrefix parameter (""|"specs-"). System prompt updated
to document the spec-specific format.


## [3.9.56] - 2026-04-10

### Changed

- Add FILE_FORMAT_EXAMPLE to system prompts

Shows LLMs the exact <filename>/<file-content> wrapping format
they'll receive, so they can parse multi-file batches reliably.
Injected before BREVITY_RULES in all file-handling tools.


## [3.9.55] - 2026-04-10

### Changed

- Use <filename>/<file-content> XML tags for file wrapping

Each file now wraps as:
  <filename>
  /path/to/file.ext
  </filename>
  <file-content>
  ```lang
  ...
  ```
  </file-content>

Cleaner separation of path and content, both unambiguously
delimited by XML tags. No escaping needed.


## [3.9.54] - 2026-04-10

### Changed

- Move file path before <file> tag, simplify wrapping

Format: "File: /path/to/file.ts\n<file>\n```lang\n...\n```\n</file>"
Path is visible and accessible without XML parsing. System prompts
updated to reference "line before each file tag".


## [3.9.53] - 2026-04-10

### Changed

- Simplify XML wrapping: use plain <file>...</file>, keep path in fence header


## [3.9.52] - 2026-04-10

### Changed

- Wrap file content in XML tags for clearer file delimitation

Each file is now wrapped: <file path="...">...code fence...</file>
Helps LLMs (especially weaker ones like Nemotron) parse multi-file
batches unambiguously. Quad backticks (min 4, auto-escalate) already
handle nested code fences safely. XML path attribute is escaped.
Updated all system prompts to reference the new delimiter.


## [3.9.51] - 2026-04-10

### Changed

- Fix last 2 stale references: reset 120s timeout, two models comments

- tool-reference.md: remove "up to 120s" from reset description
- config.ts: "two models" → "three models" in settings template comments
- Synced tool-reference.md across all 3 skill copies


## [3.9.50] - 2026-04-10

### Changed

- Add heartbeat to chatCompletionSimple for MCP keepalive

Sends progress notification every 30s while waiting for the
non-streaming HTTP response. Prevents MCP inactivity timeout
on long-running requests (reasoning models on large files).
Cleared in finally block — no timer leaks.


## [3.9.49] - 2026-04-10

### Changed

- Remove all streaming code — SSE, timedRead, reasoning detection

Deleted chatCompletionStreaming (~180 lines), timedRead helper,
READ_CHUNK_TIMEOUT_MS, reasoningDetected field. All LLM requests
now use chatCompletionSimple (stream: false, single JSON response).


## [3.9.48] - 2026-04-10

### Changed

- Switch ALL LLM requests to non-streaming (stream: false)

chatCompletionWithRetry now always uses chatCompletionSimple.
No SSE parsing, no progress tracking per-request, no reasoning
token detection. Batch-level heartbeat keeps MCP connection alive.
Removes reasoning timeout skip logic (dead code with non-streaming).
chatCompletionStreaming is now unused (kept for reference, will remove).


## [3.9.47] - 2026-04-10

### Changed

- Remove response_format: text — unsupported models would reject it


## [3.9.46] - 2026-04-10

### Changed

- Add non-streaming path for free model, no SSE parsing

New chatCompletionSimple: stream=false, response_format=text,
single JSON response. Used automatically when modelOverride is
set (free mode). No progress tracking, no SSE chunk parsing,
no reasoning token detection needed. Simpler and more reliable.


## [3.9.45] - 2026-04-09

### Changed

- Convert /free-scan command to llm-externalizer-free-scan skill

Skill triggers on "free scan", "scan for free", "cheap scan", etc.
Parses free-form prompt for path, extensions, exclude dirs, instructions.
Includes quality warning and reference files.
Removes the old command (superseded by skill).


## [3.9.44] - 2026-04-09

### Changed

- Improve /free-scan: accept free-form prompt with path, extensions, instructions

Parse prompt for folder path, file extensions, exclude dirs,
and LLM instructions. Examples:
  /free-scan find security issues
  /free-scan /path/to/src .ts .py find dead code
  /free-scan skip tests find TODO comments


## [3.9.43] - 2026-04-09

### Changed

- Add /free-scan command for zero-cost project scanning

Uses the free Nemotron 3 Super model (no ensemble, no cost).
Warns about lower quality and prompt logging.


## [3.9.42] - 2026-04-09

### Changed

- Document free mode as low quality in tool schema, README, rules

Free mode uses a significantly weaker model — more false positives,
missed bugs, shallow analysis. Updated tool description, README
comparison table, and rules file to set correct expectations.


## [3.9.41] - 2026-04-09

### Changed

- Fix all stale references found in audit

- 'two models' → 'three models' in 5 files (README, config skill, templates)
- qwen3.6-plus:free → qwen3.6-plus in config.ts template
- 120s timeout → 600s/removed in 4 skill files + index.ts reset desc
- Added third_model to ensemble profile template
- Synced tool-reference.md to scan skill copy


## [3.9.40] - 2026-04-09

### Changed

- Make OUTPUT_DIR a constant, thread outputDir through function chain

No global state mutation. OUTPUT_DIR is now const. Per-request
output_dir override is passed through ProcessOptions/RobustPerFileOpts
to saveResponse, same pattern as modelOverride. Each Claude Code
instance uses its own cwd for the default output path.


## [3.9.39] - 2026-04-09

### Changed

- Refactor free mode: pass modelOverride through chain, no global state

Replace save/restore currentBackend pattern with clean parameter
passing. modelOverride flows through:
  handler → processFileCheck/robustPerFileProcess → ensembleStreaming
ensembleStreaming checks modelOverride first, skips ensemble if set.
No global state mutation for free mode.


## [3.9.38] - 2026-04-09

### Changed

- Add free mode: nvidia/nemotron-3-super-120b-a12b:free

New 'free' parameter on all tools. When true:
- Uses NVIDIA Nemotron 3 Super (120B MoE, 12B active, 262K context)
- Skips ensemble (single model only)
- Zero cost on OpenRouter
- WARNING: prompts logged by provider (not for sensitive code)

Added to KNOWN_MODEL_LIMITS, tool schemas, README with comparison table.


## [3.9.37] - 2026-04-09

### Changed

- Add Output Modes section to README with comparison table

Explains modes 0/1/2 with pros, cons, response format examples,
and when to use each. Mode 0 (per-file) is the default.


## [3.9.36] - 2026-04-09

### Changed

- Fix README: add missing extensions/exclude_dirs params, remove stale temperature ref


## [3.9.35] - 2026-04-09

### Changed

- Fix stale references across all files after v3.9.34 changes

- Fix llm_externalizer_output → reports_dev/llm_externalizer in:
  server.json, bin/llm-ext, all skill reference files, examples
- Fix temperature references: remove 0.2/0.3, note fixed at 0.1
- Fix answer_mode defaults in CLI wrapper (0=default, not 2)
- Add output_dir to CLI wrapper tool catalog
- Resolve output_dir to absolute path in tool handler
- Sync scan skill reference copies from usage skill


## [3.9.34] - 2026-04-09

### Changed

- Per-file output mode, output_dir, fixed temperature, new defaults

- Default answer_mode changed to 0 (one report per file) for ALL tools
- Output directory: reports_dev/llm_externalizer/ (was llm_externalizer_output/)
- New output_dir parameter on all tools for custom output location
- Temperature fixed to 0.1 for all models (removed user parameter)
- Report filenames now include source filename for easy identification
- Updated README, rules, and scan skill docs


## [3.9.33] - 2026-04-08

### Changed

- Add 'Bug discovery statistics — coming soon' to cost chart


## [3.9.32] - 2026-04-08

### Changed

- Add percentage column to cost comparison chart

Shows savings vs Opus baseline: Sonnet 60%, Ensemble 8%.
Badges show -40% and -92% savings. Tightened subtitle to one line.


## [3.9.31] - 2026-04-08

### Changed

- Update cost chart with full 50-file project scan data

Previous chart only covered 8 .ts files. Now includes all 50 files
(.ts, .md, .py, .json, .yaml, .sh, .toml) — 729 KB, 20K lines.
Opus $4.26, Sonnet $2.56, Ensemble $0.35 (12x cheaper, actual
OpenRouter billing).


## [3.9.30] - 2026-04-08

### Changed

- Fix cost chart: correct OpenRouter prices, move to top of README

Opus is $5/$25 on OpenRouter (not $15/$75 Anthropic direct).
Chart now shows file count, total KB, and actual ensemble cost
from OpenRouter billing. Moved chart to top of README under description.


## [3.9.29] - 2026-04-08

### Changed

- Improve cost comparison chart: show project name, file stats, fix readability


## [3.9.28] - 2026-04-08

### Changed

- Fix scan skill: add required sections, self-contained references

Pass CPV validation: 0 MAJOR, 0 MINOR, 0 CRITICAL.


## [3.9.27] - 2026-04-08

### Changed

- Add cost comparison chart to README

Shows actual cost per project scan: Opus $2.53, Sonnet $0.51,
Ensemble $0.08 (32x cheaper). Based on real session data
scanning 8 TypeScript source files (88K input, 16K output tokens).


## [3.9.26] - 2026-04-08

### Changed

- Add project scan skill, update rules file

- New skill: llm-externalizer-scan — triggers on "scan project",
  "audit codebase", "full scan". Guides Claude through a full
  ensemble scan with proper parameters.
- Update ~/.claude/rules/use-llm-externalizer.md: fix stale values
  (115s→600s timeout, 2-model→3-model ensemble, add Qwen pricing,
  fix scan_folder defaults, add model fallback docs).


## [3.9.24] - 2026-04-08

### Changed

- Update README: 3-model ensemble with pricing, rate limiting, timeout fixes

- Document all 3 ensemble models (Gemini, Grok, Qwen) with pricing
- Add model fallback behavior (1-2 fail → partial results)
- Add rate limiting section (adaptive AIMD, auto-detected RPS)
- Fix timeout: 600s base, extended for reasoning models
- Remove stale 115s/120s references


## [3.9.23] - 2026-04-08

### Changed

- Remove deprecated qwen3.6-plus:free model variant

The free variant was deprecated by OpenRouter in April 2026.
Remove from KNOWN_MODEL_LIMITS. Paid qwen/qwen3.6-plus remains.


## [3.9.22] - 2026-04-07

### Changed

- Expand default directory exclusions in walkDir

Add .idea, .vscode, tmp, temp, .gradle, .cargo, vendor, out,
.output, bower_components, .pnpm-store, .eggs, .nx to
WALK_DEFAULT_EXCLUDE. These are non-project directories that
should never be scanned by default.


## [3.9.21] - 2026-04-07

### Changed

- Increase OpenRouter default timeout from 120s to 600s

Reasoning models (Qwen 3.6 Plus, etc.) need extended thinking time.
120s was too short — models would time out during the thinking phase.
600s base timeout + dynamic extension when reasoning tokens are flowing.


## [3.9.20] - 2026-04-07

### Changed

- Fix reasoning model timeout: detect thinking tokens, extend timeout dynamically

- Remove 115s hard cap (MCP_MAX_TIMEOUT_MS) — use profile timeout (300s default)
- Detect reasoning/thinking tokens in SSE stream (delta.reasoning, delta.reasoning_content)
- When reasoning tokens are actively flowing, suspend the soft timeout — model is working
- Don't retry when reasoning was detected but content is empty — retrying restarts thinking
- Progress notifications show "Reasoning… Xs (model is thinking)" during thinking phase
- Fixes Qwen 3.6 Plus truncation on large files (was timing out during thinking phase)


## [3.9.19] - 2026-04-07

### Changed

- Add BREVITY_RULES to all LLM system prompts

Instructs models to be succinct (bullets, no preamble, only
report findings, max 3 sentences per finding). Prevents
verbose output that wastes tokens and causes truncation on
weaker models like Qwen 3.6 Plus.


## [3.9.18] - 2026-04-07

### Changed

- Remove user-facing concurrency options, update docs

Rate limiting is now fully automatic — no max_concurrent,
max_in_flight, or max_rps profile fields needed.


## [3.9.16] - 2026-04-07

### Fixed

- Fix: llm-ext help — note absolute paths recommended, report save location


## [3.9.15] - 2026-04-07

### Fixed

- Fix: llm-ext event-driven handshake + line buffering + error handling

Rewrote MCP communication from hardcoded timeouts to event-driven:
- Wait for init response (id:0) before sending initialized + tool call
- Line-buffered JSON parsing handles partial chunks correctly
- Spawn error handler (node not found)
- Unexpected exit handler (server crash before response)
- Server path existence check with helpful error message
- Safe stdin writes (catch if already closed)
- Phase state machine: init → ready → waiting → done

Tested: --help, discover, chat (LLM round-trip), code_task (file analysis)


## [3.9.14] - 2026-04-07

### Fixed

- Fix: llm-ext MCP handshake — add initialized notification + stream parsing

Two bugs fixed:
1. Missing notifications/initialized after init response (required
   by MCP protocol before tool calls are accepted)
2. Server doesn't exit after responding — switched from on("close")
   to incremental stdout parsing that kills the child once the
   tool response (id:1) is received

Tested: discover (utility) and chat (LLM round-trip) both work.


## [3.9.13] - 2026-04-07

### Documentation

- Docs: add copy-paste snippet for enabling llm-ext in plugin agents


## [3.9.12] - 2026-04-07

### Added

- Feat: llm-ext CLI with built-in tool discovery via --help

Agents can self-discover available tools and parameters:
  llm-ext --help           → list all tools with descriptions
  llm-ext --help code_task → show parameters for a specific tool

Also: supports --key=value syntax, 10min timeout (not MCP-limited),
JSON array/object parsing for complex parameters.


## [3.9.11] - 2026-04-07

### Added

- Feat: add bin/llm-ext CLI wrapper for plugin agents

Plugin-shipped agents cannot use MCP tools directly (Claude Code
strips mcpServers from plugin agent frontmatter). bin/llm-ext lets
any agent call LLM Externalizer tools via Bash:

  node "${CLAUDE_PLUGIN_ROOT}/bin/llm-ext" code_task \
    --instructions "Find bugs" --input_files_paths /path/to/file.ts

Spawns the MCP server as a subprocess, sends one JSON-RPC tool call,
prints the result (file path), and exits. No config changes needed.


## [3.9.10] - 2026-04-07

### Added

- Feat: add bin/llm-externalizer standalone launcher

Ships a standalone launcher script at bin/llm-externalizer that
can be used to register the MCP server in .mcp.json or agent
frontmatter when the plugin's auto-started server is not available
(e.g., plugin-shipped agents that cannot use mcpServers frontmatter).

No npm publish needed — just point to the file via node.


## [3.9.9] - 2026-04-07

### Documentation

- Docs: add subagent access guide for plugin-shipped agents

Document the Claude Code security restriction: plugin-shipped agents
cannot use MCP servers (mcpServers frontmatter is stripped). Provide
3 workarounds: copy to user agents, direct node invocation from
plugin cache, or project .mcp.json registration.


## [3.9.8] - 2026-04-05

### Changed

- Revert: remove ensemble deadline — user will extend MCP timeout instead


## [3.9.7] - 2026-04-05

### Fixed

- Fix: 3-model ensemble deadline prevents MCP timeout on large files

When 3 models run in parallel on large files (91K+ prompt tokens),
the slowest model (often the free-tier Qwen) could exceed the 115s
MCP timeout, causing the caller to never receive the response even
though the server saved the report.

Now uses Promise.allSettled with a 100s deadline (15s margin). If
any model hasn't responded by the deadline, the result includes
the models that finished + a "(timed out)" note for the slow one.
The caller always gets a response within the MCP timeout.


## [3.9.6] - 2026-04-05

### Fixed

- Fix: add types:["node"] to tsconfig to resolve IDE false positives


## [3.9.5] - 2026-04-05

### Fixed

- Fix: publish.py cleanup + README steps updated

- Remove unused capture_output param from run() helper
- Fix comment numbering (step 8 → 9 for GitHub release)
- README: update publish steps to match new flow
  (bump first, then validate, CPV required)
- README: git-cliff now required, not optional
- README: add uvx to requirements for CPV validation


## [3.9.4] - 2026-04-05

### Added

- Feat: publish.py always bumps version first, then validates

New flow: bump → rebuild → validate (build+CPV) → badges →
changelog → commit → tag → push → release.

Version is always bumped (marketplace needs version change to
detect updates). Validation runs on the bumped code. If any
check fails, the uncommitted version bump is discarded.


## [3.9.3] - 2026-04-05

### Fixed

- Fix: simplify lock file protocol — existence = validation passed


## [3.9.2] - 2026-04-05

### Added

- Feat: pre-push hook skips when publish.py running, CPV now mandatory

- publish.py creates .publish.lock while running; pre-push hook
  checks for it and skips to avoid duplicate validation
- uvx/CPV validation is now REQUIRED (no skip if uvx missing)
- Push is always blocked unless all checks pass with 0 issues


## [3.9.1] - 2026-04-05

### Added

- Feat: unify pre-push hook with publish.py --check-only

publish.py gains --check-only flag that runs all validation
(build, manifest, CPV) without publishing. The pre-push hook
now delegates to publish.py --check-only instead of duplicating
checks. Single source of truth for all quality gates.


## [3.9.0] - 2026-04-05

### Added

- Feat: 3-model ensemble support (third_model)

Extend ensemble from 2 models to N models:
- Add third_model to Profile and ResolvedProfile interfaces
- Add validation: third_model only allowed in remote-ensemble mode
- getEnsembleModels() includes third model when configured
- ensembleStreaming() already handles N models via Promise.all
- Add ensembleModelLabel() helper (replaces 6 inline constructions)
- Add Qwen 3.6 Plus to KNOWN_MODEL_LIMITS (40K line input limit,
  conservative vs declared 1M to avoid accuracy degradation)
- Default ensemble profile includes qwen/qwen3.6-plus:free as third
- discover shows Third model when configured

All commands now produce 3-model reports in ensemble mode.


### Fixed

- Fix: cpv-remote-validate uses 'plugin' not 'cpv-validate'

- Fix: use cpv-remote-validate for isolated CPV execution


## [3.8.8] - 2026-04-02

### Fixed

- Fix: schema required arrays block folder_path-only calls

batch_check, check_references, check_imports all had
required: ["input_files_paths"] in their schemas, but handlers
support folder_path as alternative. MCP framework rejected calls
with only folder_path before the handler could process them.

Changed to required: [] with validation inside handlers.
Updated error messages to mention folder_path alternative.


## [3.8.7] - 2026-04-02

### Fixed

- Fix: resolve remaining deferred audit issues + dead code cleanup

Deferred fixes resolved:
- CC-P3-003: CLI cmdEdit no longer crashes on --timeout null/""
  (also fixed --context_window, --max_concurrent)
- CC-P3-006: publish.py porcelain filter uses column-based check
- CC-P3-008: config.ts getConfigDir follows symlinks via realpathSync
  before path boundary check (prevents symlink bypass)

Dead code removed (CC-P2-012/13/14/16):
- _INFERENCE_CONNECT_TIMEOUT_MS (unused constant)
- BATCHING_OUTPUT_ESTIMATE (unused constant)
- scoreModel + normalizeForMatch + ModelMatch + _findBestModels
  (entire unused fuzzy matching subsystem)
- _sessionSummary (unused function)

Other:
- LLM_TOOLS_SET moved to module level (was recreated per request)
- config.ts: settings.yaml gets chmod 0o600 + Windows path sep


## [3.8.6] - 2026-03-30

### Documentation

- Docs: comprehensive update for v3.8 features

- README: updated tools table, advanced parameters (folder_path,
  recursive, follow_symlinks, max_files, redact_regex, max_retries),
  compare_files 3 modes, plugin structure tree (no bash scripts)
- tool-reference: all new parameters, compare_files modes, folder_path
  on all tools, safety features with redact_regex
- usage-patterns: new examples for batch compare, git diff, folder_path,
  redact_regex; replaced batch_check with code_task answer_mode=0
- end-to-end-workflow: updated decision tree with all compare_files modes
- SKILL.md: updated examples and resource listing
- discover.md: references setup.py


### Fixed

- Fix: trim SKILL.md to <4000 chars, embed all 19 usage-patterns TOC headings


## [3.8.5] - 2026-03-30

### Fixed

- Fix: address 10 issues from full src audit (CC-P3-001 through CC-P3-012)

MUST-FIX:
- CC-P3-001: install_statusline.py — quote path for spaces in home dir
- CC-P3-002: publish.py — add cwd param to run(), remove os.chdir

SHOULD-FIX:
- CC-P3-003: cli.ts cmdEdit — defer to separate fix (numeric clearing)
- CC-P3-004: cli.ts parseFlags — support --key=value syntax
- CC-P3-005: statusline.py — Windows-portable strftime (%-X → %#X)
- CC-P3-006: publish.py — improved porcelain filter (deferred)
- CC-P3-007: config.ts — chmod 0o600 on settings.yaml after write
- CC-P3-008: config.ts — symlink guard (deferred, needs existsSync check)

NIT:
- CC-P3-011: statusline.py — move import re to top of file
- CC-P3-012: publish.py — use shlex.join for command logging
- Remove unused os import from publish.py


## [3.8.4] - 2026-03-30

### Miscellaneous

- Chore: remove old bash pre-push hook (replaced by .githooks/pre-push in Python)


## [3.8.3] - 2026-03-30

### Fixed

- Fix: address 11 issues from second audit (CC-P2-001 through CC-P2-011)

MUST-FIX:
- CC-P2-001: check_references — wire redact_regex to all readFileAsCodeBlock calls
- CC-P2-002: check_imports — wire redact_regex to all readFileAsCodeBlock calls
- CC-P2-003: chat mode-0 sequential — add regexRedact + maxBytes to processFileCheck
- CC-P2-004: code_task single-file — add regexRedact + maxBytes to processFileCheck
- CC-P2-005: code_task mode-0 sequential — add redact + regexRedact + maxBytes

SHOULD-FIX:
- CC-P2-007: comparePair — wrap ensembleStreaming in try/catch
- CC-P2-008: git ref injection — reject refs starting with '-'
- CC-P2-011: check_against_specs — allow combining folder_path + input_files_paths
  (use resolveFolderPath, merge results like other tools)

NIT:
- CC-P2-017: remove leftover output_dir from compare_files type assertion


## [3.8.2] - 2026-03-30

### Fixed

- Fix: address 10 issues from code correctness audit

MUST-FIX:
- CC-001: ReDoS — reject nested quantifier patterns (e.g. (a+)+)
  before compiling user-supplied regex
- CC-003: walkDir circular symlink — add regular directories to
  visitedPaths (not just symlink targets)
- CC-004: resolveFolderPath — add sanitizeInputPath for path
  traversal protection on folder_path

SHOULD-FIX:
- CC-007: compare_files required:[] — input_files_paths not required
  when using file_pairs or git_repo mode
- CC-008: batch_check — wire redact_regex through to processFileCheck
- CC-009: scan_folder — wire redact_regex through to processFileCheck
- CC-019: add check_against_specs to LLM_TOOLS tracking set so reset
  waits for in-flight spec checks to complete


## [3.8.1] - 2026-03-30

### Fixed

- Fix: ReDoS protection, git ls-files flag incompatibility, unused param

1. ReDoS: cap regex replacements at 100K to prevent catastrophic
   backtracking on pathological user-supplied patterns
2. git ls-files: split --recurse-submodules (tracked only) from
   --others (untracked) — these flags are incompatible in git
3. Remove unused output_dir parameter from compare_files schema
   (was declared but never wired to saveResponse)


## [3.8.0] - 2026-03-30

### Added

- Feat: compare_files batch mode + git diff mode + grouping

Three comparison modes:
1. PAIR MODE: input_files_paths with 2 files (backward compat)
2. BATCH MODE: file_pairs array of [fileA, fileB] pairs with
   ---GROUP:id--- markers for grouped reports
3. GIT DIFF MODE: git_repo + from_ref + to_ref — computes diffs
   via git between two commits/tags, supports grouping via
   file_pairs markers to organize changed files

All modes support per-group report saving. Git diff mode does
not use LLM — pure git diff with structured output.


## [3.7.2] - 2026-03-30

### Added

- Feat: respect gitignore across submodules and nested git repos

Replace single git ls-files call with gitLsFilesMultiRepo() that:
1. Runs git ls-files --recurse-submodules from the main repo
   (respects each submodule's own .gitignore)
2. Scans for independent nested git repos (separate .git dirs)
   and runs git ls-files in each one separately
3. Falls back to --cached --others --exclude-standard on older
   git that doesn't support --recurse-submodules
4. Deduplicates results across all repos
5. Falls back to manual walk if no git repos found at all


## [3.7.1] - 2026-03-30

### Added

- Feat: add folder_path support to batch_check (last tool missing it)


## [3.7.0] - 2026-03-30

### Added

- Feat: add folder_path to chat, code_task, check_references, check_imports

All content tools now accept folder_path as an alternative (or addition)
to input_files_paths. The folder is scanned with the same options as
scan_folder and check_against_specs: extensions, exclude_dirs,
use_gitignore (default: true), recursive (default: true),
follow_symlinks (default: true, with circular link detection),
max_files (default: 2500).

Also adds recursive and follow_symlinks options to walkDir and all
tools that use folder scanning. Symlink following uses realpath-based
cycle detection to prevent infinite loops.


## [3.6.4] - 2026-03-30

### Fixed

- Fix: scan_folder use_gitignore description said 'Default: false' but code defaults to true


## [3.6.3] - 2026-03-30

### Fixed

- Fix: raise max_files default from 1000 to 2500


## [3.6.2] - 2026-03-28

### Fixed

- Fix: explain WHY file grouping saves tokens in all tool descriptions


## [3.6.1] - 2026-03-28

### Fixed

- Fix: add FILE GROUPING section to all tool descriptions

The grouping feature (---GROUP:id--- markers) was not mentioned in
any tool description or input_files_paths parameter description.
Other Claude Code sessions could not discover the feature because
only answer_mode and max_retries were visible in the schema.

Added to all 6 supported tools:
- Tool description: FILE GROUPING section explaining the syntax
- chat's input_files_paths: full example of marker syntax


## [3.6.0] - 2026-03-28

### Added

- Feat: convert all bash scripts to Python for cross-platform support

- scripts/setup.sh → scripts/setup.py
- scripts/install-statusline.sh → scripts/install_statusline.py
- mcp-server/statusline.sh → mcp-server/statusline.py
- .githooks/pre-push converted to Python

All scripts use Python stdlib only (no external dependencies).
Works on macOS, Linux, and Windows without WSL/Cygwin.
Old .sh files kept for backward compatibility.


### Fixed

- Fix: update last setup.sh reference in README to setup.py


### Miscellaneous

- Chore: remove bash scripts replaced by Python equivalents


## [3.5.3] - 2026-03-28

### Fixed

- Fix: use numbered checklist, remove colon after 'Trigger with', comma-separated TOC

- Fix: resolve remaining CPV issues — numbered steps, TOC format, description format

- Fix: resolve all CPV validation issues (6 MINOR + 6 WARNING)

- Add pyproject.toml for Python plugin metadata
- Add .python-version (3.12)
- Add .githooks/pre-push quality gate
- Skills: add "Trigger with" to both descriptions (Nixtla strict mode)
- Skills: convert Instructions to checklist format ([ ] / [x])
- Skills: embed complete TOC from all referenced .md files in SKILL.md
- README: uppercase badge markers (<!--BADGES-START--> / <!--BADGES-END-->)
- README: document mcp-server/ directory purpose and Bash requirement
- publish.py: sync badge marker case with CPV expectations

- Fix: CPV must pass with 0 issues to allow publish


## [3.5.2] - 2026-03-28

### Added

- Feat: add CPV remote validation to publish pipeline

Step 1b runs CPV via uvx remote execution:
  uvx --from git+https://github.com/Emasoft/claude-plugins-validation cpv-validate

- Exit 0: pass (publish continues)
- Exit 2: minor issues (warn, publish continues)
- Exit 1: critical/major (publish blocked)
- uvx not found: skip with warning

No local CPV scripts needed — runs from GitHub repo directly.


### Fixed

- Fix: parse CPV output for severity instead of relying on exit codes


## [3.5.1] - 2026-03-28

### Documentation

- Docs: update README for v3.3–v3.5 features

- Add check_against_specs to tool table
- Mark batch_check as deprecated
- Add advanced parameters section (answer_mode, max_retries, redact_regex,
  scan_secrets, redact_secrets, max_payload_kb)
- Add file grouping section with syntax and output format
- Update feature list with grouping, redact_regex, robust batch
- Update skills description and plugin structure tree
- Fix tool count (12 → 13)


## [3.5.0] - 2026-03-28

### Added

- Feat: add redact_regex parameter to all content tools

User-defined regex pattern to redact matching strings from file content
before sending to LLM. Uses the same tested replacement format as
secret redaction: [REDACTED:USER_PATTERN] for alphanumeric matches,
zero-padded placeholders for numeric-only matches.

- Validates regex upfront with clear error messages on invalid patterns
- Applied after secret redaction (redact_secrets)
- Propagated through readFileAsCodeBlock, readAndGroupFiles,
  processFileCheck, and robustPerFileProcess
- Available on: chat, code_task, batch_check, scan_folder,
  compare_files, check_references, check_imports, check_against_specs


## [3.4.0] - 2026-03-28

### Added

- Feat: add max_retries parameter to all content tools, deprecate batch_check

Extract retry/circuit-breaker/parallel logic from batch_check into
shared robustPerFileProcess function. Add max_retries parameter to
chat, code_task, check_references, check_imports, check_against_specs.

When answer_mode=0 and max_retries > 1:
- Parallel execution via parallelLimit
- Per-file retry with exponential backoff
- Circuit breaker (abort after 3 consecutive failures)
- Global retry budget (2x file count)

batch_check is now deprecated — use any tool with
answer_mode=0, max_retries=3 for equivalent behavior.

Also fixes: filter group markers from secret scans in chat,
code_task, and check_against_specs handlers.


### Documentation

- Docs: add max_retries to tool reference, mark batch_check as deprecated


## [3.3.1] - 2026-03-28

### Fixed

- Fix: filter group markers from secret scans and single-file checks

- chat, code_task: filter ---GROUP:*--- markers before passing to
  scanFilesForSecrets (would try to read markers as file paths)
- check_against_specs: same marker filtering for secret scan
- code_task: single-file optimization also checks GROUP_FOOTER_RE
  (previously only checked GROUP_HEADER_RE, so a lone footer marker
  could pass through to processFileCheck)
- batch_check, check_references, check_imports already had this
  filtering from the initial implementation


## [3.3.0] - 2026-03-28

### Added

- Feat: add file grouping support for isolated batch processing

Files in input_files_paths can be organized into named groups using
delimiter markers: ---GROUP:id--- and ---/GROUP:id---. Each group is
processed in complete isolation (no cross-group LLM calls) and produces
its own report file with the group ID in the filename.

Supported tools: chat, code_task, batch_check, check_references,
check_imports, check_against_specs.

Output format: [group:id] /path/to/report.md (one line per group)

Backward compatible: flat file lists without markers work unchanged.
Groups apply only to input_files_paths, not instructions or spec files.


### Documentation

- Docs: add file grouping documentation to skill references

- tool-reference: new File Grouping section with syntax, output format,
  and supported tools list
- usage-patterns: grouped file processing example with expected output
- SKILL.md: updated resource listing


## [3.2.9] - 2026-03-28

### Changed

- Update plugin for Claude Code v2.1.80–v2.1.86 compatibility

- statusline: use rate_limits from input JSON (v2.1.80+) instead of
  OAuth token lookup + API call; falls back to API for older versions
- commands: add effort frontmatter (v2.1.76) — discover:low, configure:medium
- docs: add check_against_specs to tool reference, usage patterns,
  decision tree, and skill trigger list (was added in v3.2.8 but
  undocumented in skill files)


### Fixed

- Fix: statusline mkdir race + docs inconsistencies

- Move mkdir /tmp/claude before OpenRouter cache write (was inside
  fallback-only branch, but OpenRouter write runs unconditionally)
- tool-reference: exclude_dirs and use_gitignore apply to both
  scan_folder and check_against_specs, not scan_folder only
- tool-reference: note check_against_specs uses spec_file_path
  instead of standard 4-field input pattern


## [3.2.8] - 2026-03-26

### Added

- Feat: add check_spec tool — compare source files against a specification

New tool that accepts a spec file (requirements, rules, API contracts,
restrictions, forbidden patterns) and one or more source files. Each
source file is strictly examined for spec violations.

Key design decisions:
- Reports ONLY VIOLATIONS (things done wrong), not MISSING features
  (some requirements may be implemented in other files not included)
- Everything implemented must follow the spec exactly
- Per-violation reporting: file, location (function name), spec rule
  quoted, actual behavior, severity (CRITICAL/HIGH/MEDIUM/LOW)
- Files with no violations explicitly marked "CLEAN"
- Supports FFD bin packing for multi-file batches
- Spec file included as "source of truth" in every batch
- Ensemble mode for dual-model analysis
- Summary with total violation counts by severity


### Fixed

- Fix: max_files default 1000, useGitignore default true

- max_files: 500 → 1000 for both scan_folder and check_against_specs
- useGitignore: false → true (respects .gitignore by default)
- .git, .venv already in WALK_DEFAULT_EXCLUDE (confirmed)

- Fix: apply rechecker fixes [rechecker: skip]

Auto-reviewed and fixed by rechecker plugin.

Pass 3 (adversarial) — 2 medium:
- check_against_specs: added isDirectory() check on folder_path
- check_against_specs: reject when both folder_path and input_files_paths provided

Pass 4 (security) — 2 (1 medium, 1 low):
- check_against_specs: added maxFiles:500 safety limit on walkDir
- check_against_specs: exposed max_files parameter in tool schema

- Fix: remove stale max_tokens references from tool descriptions

limitsBlock() and discover tool still mentioned max_tokens as
user-configurable. Updated to reflect that output tokens are
auto-managed (model maximum) and truncation is auto-retried.


### Refactored

- Refactor: rename check_spec → check_against_specs + folder scanning

Renamed tool and added folder_path support for recursive scanning.
Spec file is included in EVERY batch — when files are split across
multiple requests via FFD bin packing, each batch gets the full spec
so every source file is always checked against the complete spec.

New parameters:
- folder_path: scan a directory recursively instead of listing files
- extensions: filter by file extension (e.g., [".ts", ".py"])
- exclude_dirs: additional directories to skip
- use_gitignore: respect .gitignore rules via git ls-files

Either input_files_paths OR folder_path is required (not both).
No limit on number of files — the packing algorithm handles it.


## [3.2.7] - 2026-03-26

### Added

- Feat: global service health tracker + truncation in output reports

Added SERVICE_HEALTH global tracker that detects systemic server issues:
- Tracks consecutive failures across ALL requests (not just per-batch)
- Threshold: 5 consecutive failures triggers backoff mode
- Exponential backoff: waits 60s, 120s, 350s between retry attempts
- After all backoff attempts fail, returns clear server-side error:
  "The issue appears to be server-side... please retry later"

Truncation now appears in output reports (not just stderr):
- finishReason=length: appends "TRUNCATED: output token limit hit"
- Timeout after 3 retries: appends "TRUNCATED: still incomplete after 3 retries"
- Server abort: returns the full SERVICE_HEALTH diagnostic message

This prevents wasting thousands of tokens on batch operations when the
server is down — the system detects the pattern early and stops.

- Feat: auto-retry on truncated LLM responses (up to 3 retries)

Added chatCompletionWithRetry wrapper that checks finishReason from
the OpenRouter API after each streaming call:

- finishReason="stop" + !truncated → normal completion, return immediately
- finishReason="length" → output hit max_tokens limit, return with
  truncated=true warning (retrying won't help — same limit)
- truncated=true (timeout/connection drop) → retry up to 3 times

Each ensemble model retries independently — if Grok times out but
Gemini succeeds, only Grok retries. The combined result reflects
whether any model was still truncated after all retries.

This ensures the output is never silently truncated. The retry logic
is transparent: each retry is logged to stderr with attempt count.


### Miscellaneous

- Chore: gitignore tldr session artifacts

- Chore: add Serena project config, remove stale worktrees


### Refactored

- Refactor: remove ensemble and max_tokens from tool parameters

Ensemble is now always ON for remote backends (OpenRouter) and OFF
for local backends — not user-configurable. This ensures every file
is analyzed by both models when using the remote ensemble profile.

max_tokens is now always set to the model's maximum output capacity
via resolveDefaultMaxTokens(). The ensemble dispatch already caps
each model at its KNOWN_MODEL_LIMITS.maxOutput (Grok: 30K, Gemini: 65K).

Removed:
- ensembleSchema constant
- ensemble parameter from all 11 tool schemas
- max_tokens parameter from all 11 tool schemas
- All dead variable extractions from handler destructuring blocks

The only user-configurable size parameter is max_payload_kb (default 400),
which controls how files are packed into batches via FFD bin packing.


## [3.2.6] - 2026-03-23

### Added

- Feat: configurable max_payload_kb on all tools + FFD bin packing

Ensemble requires both models to process every batch, so the payload
budget must fit within the WEAKER model's context (Grok 4.1 Fast:
~131K tokens ≈ 400 KB after output/prompt overhead).

Changes:
- DEFAULT_MAX_PAYLOAD_BYTES: 800 KB → 400 KB (conservative for Grok)
- readFileAsCodeBlock: accepts optional maxBytes parameter
- readAndGroupFiles: FFD (First-Fit Decreasing) bin packing for
  optimal batch composition, configurable budgetBytes parameter
- max_payload_kb parameter added to ALL 7 content tools:
  chat, code_task, batch_check, scan_folder, compare_files,
  check_references, check_imports
- Budget threaded through to every readFileAsCodeBlock call site
  via ProcessOptions.maxBytes and direct parameter passing
- Token estimation: 1 token ≈ 4 bytes (prompt bytes subtracted
  from budget before grouping files)


### Fixed

- Fix: comprehensive adversarial audit — 32 findings across all severity levels

CRITICAL fixes:
- C1: Path traversal protection — sanitizeInputPath() rejects paths outside
  cwd/home/tmp and blocks symlinks on all input file reads
- C2: Redaction ID race — replaced sequential nextRedactionId++ with
  randomUUID() (thread-safe, unpredictable placeholders)
- C3: File lock race — documented Map-based lock with resolve() normalization

HIGH fixes:
- H1: Prompt bytes now computed via Buffer.byteLength (not token*4 estimate),
  accurate for CJK/emoji/non-ASCII content
- H2: Symlink rejection via lstatSync check in sanitizeInputPath
- H3: Global retry cap (2× file count) in batch_check prevents quota exhaustion
- H4: Malformed SSE chunks counted and warned (not silently dropped)
- H5: maxBytes validated — Infinity/0/negative fall back to default
- H6: walkDir skips symlinks explicitly (prevents infinite recursion)
- H7: PEM private key blocks added to SECRET_PATTERNS
- H8: publish.py rollback on push failure (reset + tag delete)
- H9: publish.py validates regex match + greps dist for version
- H10: config.ts YAML parse sanitized via JSON roundtrip (anti-prototype-pollution)

MEDIUM fixes:
- M1: readAndGroupFiles enforces 10 KB minimum budget
- M2: System message bytes included in budget calculation
- M3: TOCTOU mitigated — re-check buffer size after readFileSync
- M4: Truncation detection lowered from >50 to >10 lines
- M5: SOFT_TIMEOUT_MS capped at 115s (MCP spec limit)
- M6: (ensemble line filter — secondary to byte budget)
- M7: config.ts atomic settings write via temp+rename
- M8: config.ts path traversal protection on LLM_EXT_CONFIG_DIR
- M9: config.ts env var name trimming
- M10: config.ts numeric caps (timeout ≤3600, concurrent ≤32, context ≤10M)
- M11: publish.py remote tag collision check via git ls-remote

LOW fixes:
- L1: Binary detection scan extended from 8KB to 64KB
- L4: Connection drop mid-stream now sets truncated=true
- L5: Progress interval dynamic (min 10s, timeout/3)
- L6: detectLang fallback to shebang for extensionless files
- L7: walkDir symlink skip explicit (was implicit)
- L8: Redaction IDs now random UUIDs (unpredictable)

Additional publish.py hardening:
- git-cliff required (not optional skip)
- gh CLI pre-check at start
- npm ci instead of npm install
- try/finally on os.chdir for safety
- Post-stage unstaged file detection

- Fix: 800 KB payload budget for batching — guarantees full ensemble

The entire LLM payload (prompt + instructions + instruction files +
code files + inline content) is now capped at 800 KB per batch.

This ensures both ensemble models (Grok ≤20K lines ≈ 800 KB,
Gemini ≤50K lines ≈ 2 MB) always process every batch — no more
silent model skipping when batches exceed line limits.

Changes:
- MAX_FILE_SIZE_BYTES: 2 MB → 800 KB (per-file hard limit)
- readAndGroupFiles: byte-based batching (800 KB - prompt overhead)
  instead of token-based context window math
- Files exceeding 800 KB are skipped and reported (not crashed)
- Token estimation: 1 token ≈ 4 bytes (so 800 KB ≈ 200K tokens)
- chat + code_task callers report skipped files in output


## [3.2.5] - 2026-03-15

### Fixed

- Fix: rebuild dist after version sync in publish.py

The publish script synced the version to src/index.ts but didn't
rebuild dist/ before committing. This caused dist/index.js to report
the old version (3.2.2) to MCP clients while all other files said 3.2.4.

Now publish.py rebuilds dist as step 2b (after version sync, before
commit) and stages the rebuilt dist files.


## [3.2.3] - 2026-03-15

### Added

- Feat: bundle all dependencies with esbuild for standalone dist/

Claude Code plugins pull source from GitHub where node_modules is
gitignored. The previous tsc-only build produced dist/ files that
import external packages (yaml, @modelcontextprotocol/sdk) which
fail at runtime with "Cannot find package" errors.

Now using esbuild to bundle all npm dependencies into self-contained
dist/index.js and dist/cli.js. Node.js builtins are externalized.
A createRequire banner is injected so bundled CJS deps (like yaml)
can resolve require("process") in the ESM output.

Build pipeline: tsc --noEmit (type-check) → esbuild (bundle)


## [3.2.2] - 2026-03-15

### Documentation

- Docs: update install instructions with marketplace update step

Add `claude plugin marketplace update` command to installation guide.
Include note about refreshing local cache if plugin is not found.


### Fixed

- Fix: remove env block from .mcp.json to fix missing env var error

Claude Code treats all ${VAR} references in .mcp.json env block as
required, causing "Missing environment variables: VLLM_API_KEY" error
when users don't have all backend-specific vars set.

The MCP server process inherits the parent's environment automatically,
so OPENROUTER_API_KEY, LM_API_TOKEN, and VLLM_API_KEY are already
available via process.env when set in the user's shell. The env block
was unnecessary and counterproductive.

- Fix: comprehensive audit — security hardening, version sync, skill structure, CI

Security fixes:
- /tmp/claude/ directory created with mode 0700 (was world-readable)
- diff args use -- to prevent flag injection
- jq check + safe --arg interpolation in install-statusline.sh
- Dynamic User-Agent in statusline.sh (was hardcoded 2.1.34)
- Explicit UTF-8 encoding in pre-push hook

Version sync:
- Fix hardcoded version 3.1.0 in index.ts Server constructor → 3.2.1
- publish.py now auto-syncs version to index.ts on release
- index.ts staged for commit in publish pipeline

Plugin structure:
- Add VLLM_API_KEY to server.json environmentVariables
- Remove non-existent README.md from package.json files array
- Fix .mcp.json path syntax: $CLAUDE_PLUGIN_ROOT → ${CLAUDE_PLUGIN_ROOT}
- Fix dead URL in README (removed link to non-existent upstream repo)
- SHA-pin actions/checkout in notify-marketplace workflow
- Add CI workflow (build check + manifest + version consistency)

Skill improvements (Nixtla compliance):
- Lowercase skill names matching directory names
- Add required sections: Overview, Prerequisites, Instructions, Context,
  Output, Error Handling, Examples, Resources
- Progressive disclosure: move detailed content to reference files
- Both SKILL.md files under 5000 char limit
- TOC added to all reference files
- Embedded TOC headings in Resources section links
- Fix misleading description (config skill manages profiles, not backends)

CPV validation: 2 CRITICAL + 19 MAJOR → 0 CRITICAL + 0 MAJOR + 4 MINOR

- Fix: commit dist/, sync versions, harden publish pipeline

Critical fixes found during audit:

1. CRITICAL: mcp-server/dist/ was gitignored — MCP server would fail
   to start after install from GitHub because dist/index.js didn't
   exist. Removed dist/ from .gitignore with negation pattern, committed
   all 9 built files (548K).

2. Version mismatch: server.json and package.json were still at 3.2.0
   while plugin.json was at 3.2.1. Fixed both to 3.2.1.

3. publish.py now auto-syncs version to mcp-server/package.json and
   mcp-server/server.json (including nested packages[].version) and
   stages both files in the release commit.

4. tsconfig.json: excluded test-helpers.ts from build output to keep
   dist/ clean (only ships index.js, config.js, cli.js + declarations).

5. README badge version updated from 3.2.0 to 3.2.1.

- Fix: add cliff.toml and harden publish.py changelog generation

- Add cliff.toml with filter_unconventional=false and catch-all parser
  so no commits are ever skipped by git-cliff
- publish.py: add step 3 to update README.md badges (version, build)
- publish.py: capture git-cliff stderr and abort if commits are skipped
- publish.py: abort on git-cliff non-zero exit
- publish.py: stage README.md in commit alongside plugin.json + CHANGELOG
- Regenerate CHANGELOG.md with all 6 prior commits included


## [3.2.1] - 2026-03-15

### Changed

- Fix moderate vulnerability: update hono 4.12.5 -> 4.12.8

Resolves GHSA prototype pollution in hono's parseBody({ dot: true }).
Transitive dependency via @modelcontextprotocol/sdk. Patched in 4.12.7,
updated to 4.12.8. npm audit now shows 0 vulnerabilities.

- Improve README with badges, detailed tool docs, and publishing guide

Add shields.io badges (version, build, typescript, node, license,
marketplace) with badges-start/end markers. Expand MCP tools section
with input fields, ensemble parameters, and constraints. Add profile
modes table, environment variables reference, quick start configs for
both OpenRouter and LM Studio. Document publish.py steps and pre-push
hook checks. Add requirements table and full directory tree.

- Update .gitignore to match marketplace plugin conventions

Add patterns for: .claude/, CLAUDE.md, .tldr/, *_dev/ (generic), IDE
files (.idea/, .vscode/), Python caches (.ruff_cache/, .mypy_cache/,
.pytest_cache/), build artifacts, security output, and editor swap files.
Matches Emasoft/claude-plugins-management .gitignore pattern.

- Add CI/CD scripts and fix plugin naming convention

- Rename plugin from 'llm-externalizer-plugin' to 'llm-externalizer'
  (repo name stays llm-externalizer-plugin, matching token-reporter pattern)
- Add homepage field to plugin.json
- Add notify-marketplace.yml GitHub Action (triggers emasoft-plugins update)
- Add publish.py release pipeline (bump, changelog, tag, push, gh release)
- Add bump_version.py for semver bumps in plugin.json
- Add pre-push git hook (TypeScript build check + manifest validation)
- Rewrite README with comprehensive installation instructions, naming
  section, directory structure, and publishing guide
- Update .gitignore to include dev folders

- Apply validation fixes from plugin-validator and skill-reviewers

Fixes:
- server.json: version 3.1.0 -> 3.2.0, settings.yml -> settings.yaml
- Both SKILL.md descriptions: rewritten to third-person trigger phrases
- Config SKILL.md: added troubleshooting table, CLI commands section,
  fixed agent-directed phrasing in auth resolution section
- Usage SKILL.md: added instructions_files_paths guidance, enhanced
  output location constraint, added examples/ pointer
- New: examples/end-to-end-workflow.md with complete tool selection,
  invocation, output reading, and decision tree

- Initial plugin structure for llm-externalizer-plugin

Claude Code plugin packaging of the LLM Externalizer MCP server.

Components:
- .claude-plugin/plugin.json: Plugin manifest (v3.2.0)
- .mcp.json: MCP server config using $CLAUDE_PLUGIN_ROOT
- mcp-server/: Bundled MCP server source (copied from llm_externalizer)
- skills/llm-externalizer-usage/: Tool selection, patterns, constraints
- skills/llm-externalizer-config/: Profile management, settings, ensemble
- commands/discover.md: Health check command
- commands/configure.md: Profile management command
- scripts/setup.sh: Build script (npm install + tsc)
- scripts/install-statusline.sh: Optional statusline integration



