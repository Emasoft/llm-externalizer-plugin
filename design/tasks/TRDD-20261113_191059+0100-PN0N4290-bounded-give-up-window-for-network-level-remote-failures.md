---
trdd-id: PN0N4290
title: Bounded give-up window for network-level remote failures
column: design
status: tasked
created: 2026-11-13T19:10:59+0100
updated: 2026-11-13T19:20:23+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-13T19:10:59+0100
derived: true
parent-trdd: UT7UC025
---

# Bounded give-up window for network-level remote failures

## Origin

Increment 1b of TRDD-WSPV40Y5 (automatic fallback of general commands to a ready local profile). Split out of WSPV40Y5 in revision 3 after the final review; the text under the Moved headings is moved verbatim from WSPV40Y5 revision 2. In moved text, section numbers and Qn refer to WSPV40Y5, and 1a 1b 1c 1d are the four increments (1d = WSPV40Y5 itself, the fallback helper; it consumes 1a, 1b and 1c, so they land first). Markers: [V] = VERIFIED, file:line read in the card session; [I] = INFERRED, the implementer must read it before relying on it. All paths under scripts/llm-ext/src/. Parent: TRDD-UT7UC025. One commit.

## Scope (1b)

A bounded give-up window for network-level remote failures, and the strict probe it needs.
 1. The armed window: a NETWORK_GIVE_UP_MS window of consecutive network-code failures ends the http retry loop with the typed error. The knob rides on the RetryClock created at index.ts:3604-3609 so it applies to every model of the dispatch.
 2. ARMING CONDITION (this card): the window is armed ONLY when ALL THREE hold: (i) trigger (c) holds (TRDD-WSPV40Y5 1a classifier over the causes seen so far, evaluated after the first network-code failure of the dispatch [I]); (ii) the reachability probe fails, that is the STRICT probe returns no genuine provider answer; (iii) a local fallback target is ready now (the section-4 ready-now checks of TRDD-WSPV40Y5: engine binary present, model on disk, calibration record ok). Reason for (iii): without it, a command that has no ready local profile would give up on the remote after the short window and fail sooner than today, a regression for every user without a calibrated local model; with it, such a command keeps the existing retries. Unarmed commands keep the D5 behaviour (http.ts:806 comment).
 3. The duration is configurable; the default is PROVISIONAL, 6 s, pending the USER question Q10 in WSPV40Y5 section 8 (wait for the existing retries, up to about 5 minutes, or switch to local after about 6 s and stay local for the rest of that command).
 4. The STRICT probe as a function (moved text below), with its tests.
 2026-11-13 orchestrator: ready-now gate restored as the third arming condition (see above).
WAITING 2026-11-13: value and existence of the give-up window pending USER Q10; do not implement before the answer.

## Moved from WSPV40Y5 section 2: the STRICT probe

   STRICT probe (design [I]): providerReachable (index.ts:2258-2265 [V]) treats ANY status below 500 as up and fetch follows redirects, so a captive portal answering 200 or 302 HTML reads as reachable. For c the probe uses redirect manual and counts as a provider answer ONLY status 200 with a JSON body holding a data array; an HTML 2xx, any 3xx, any error or timeout is NOT a provider answer and does NOT veto the fallback. A genuine provider answer (JSON model list) while every request failed with a network code vetoes it (the provider is up, so this is not isolation). Trigger a keeps the existing probe unchanged.

## Moved from WSPV40Y5 section 2: time to the first local answer

 - TIME TO THE FIRST LOCAL ANSWER [V from code reading, not measured]. The walk already stops after the first model on a network error (endpoint marked dead, see trigger c), so the whole cost is INSIDE one request, in the http retry loop. The per-call retry window is RETRY_DEADLINE_MS = 300000 (provider/http.ts:126), started at the FIRST failure (http.ts:168) and SHARED by the whole dispatch: ensembleStreaming creates one retry clock and spreads it into every model, chain entry and rotation (index.ts:3604-3609 [V]); a closed window makes every later entry throw dispatchClosed (walkProfileChainOnce catch, static verdict, which the gate at index.ts:3559 rethrows). Per code (classifyFailure, http.ts:789-812 [V]): ECONNREFUSED stops after REFUSED_TRIES = 2 (http.ts:779, 797-803), one backoff of about 1 s (RETRY_BASE_DELAY_MS 1000, jitter 25 percent): about 2 s. DNS failure on a non-OpenRouter host: NAME_LOOKUP_TRIES = 2 (http.ts:780, 808): about 2 s. DNS failure ON THE OPENROUTER HOST (the real no-network case): neverSent, no budget, the attempt is given back (http.ts:805-807, consumesAttempt) so the loop retries until the 300 s window or the request timeout (SOFT_TIMEOUT_MS, profile timeout, default 300 s, index.ts:718): up to about 300 s. ECONNRESET, ETIMEDOUT, ENETUNREACH, EHOSTUNREACH: no verdict, RETRY_MAX_ATTEMPTS = 5 with backoff 1+2+4+8+16 s (http.ts:~111-115): about 31 s plus each attempt own timeout [I].

## Moved from WSPV40Y5 section 2: the armed rule

 - REQUIRED CHANGE (design [I]): an ARMED rule. When the fallback is armed (ready-now already true at dispatch: a record file read plus a PATH probe, no process), a NETWORK_GIVE_UP_MS window (proposal 6 s, the implementer measures) of consecutive network-code failures ends the retry loop with the typed error, for every code in NETWORK_ISOLATION_CODES including the OpenRouter-host DNS case. The knob rides on the RetryClock created at index.ts:3604-3609 so it applies to every model of the dispatch. A DNS blip shorter than the window still heals; unarmed commands keep the D5 behaviour (http.ts:806 comment). EXPECTED: switch warning at about give-up window + strict probe (immediate on refused or unresolvable, up to OUTAGE_PROBE_TIMEOUT_MS 5 s on a blackhole, index.ts:2255 [V]) = under 5 s for closed port and unresolvable host; first local answer under 15 s with a WARM local server. A COLD start (loading a 3-15 GB model) is NOT bounded by this card [I]. NOT covered in increment 1: a blackholed network where connect hangs until the request timeout (up to 300 s): the fetch has no separate connect timeout [I]; listed in section 7.

## Moved from WSPV40Y5 section 7: risks

 - A DNS or network blip shorter than a minute could switch a whole command to a degraded local model, because the latch is final (Q8). The give-up window (section 2) and the strict probe bound this; the window value is the lever.
 - BLACKHOLE (packets dropped, no refusal): connect hangs until the request timeout (up to 300 s); increment 1 does not cover it (no separate connect timeout [I]). ETIMEDOUT-LOCAL is excluded from trigger c on purpose (a slow model is not a dead network).

## Required tests (agent proposal [I] except item 1, moved; real servers, no mocks)

 1. MOVED from WSPV40Y5 section 6 case (3): a pure unit test of classifyFailure for the OpenRouter-host DNS case under the armed rule, because a real OpenRouter DNS failure cannot be forced in a test and is covered at unit level only.
 2. CAPTIVE PORTAL at probe level (the probe-level half of WSPV40Y5 section 6 case 4): a real node:http server answering 302 and 200 HTML on /v1/models gives not a provider answer; a server answering a real JSON models list with a data array gives a provider answer.
 3. TIME-BOUND at dispatch level, with a ready local profile fixture (tiny-llamas + an ok calibration record), since the window arms only when a local target is ready: against a closed port and against an unresolvable host (a .invalid name, RFC 6761), with the window armed, the typed network error is thrown in under 5 s each.
 4. UNARMED: when the probe reports a genuine provider answer, the retry behaviour is the existing one (unit level).
 The end-to-end cases that need the fallback itself (first local answer under 15 s, captive portal still falls back) stay in 1d.
 5. no ready local profile + closed port: the window does NOT arm, the existing retries run unchanged (measure elapsed >= the old retry time)

## Approval log

- 2026-11-13T19:10:59+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-13T19:20:23+0100 — column → design. value and existence of the give-up window pending USER Q10
