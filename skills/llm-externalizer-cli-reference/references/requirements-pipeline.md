# llm-ext recipe: detect requirements in a prompt and keep a rules file free of duplicates

Use this when a user prompt may contain rules or requirements (for example "the loading screen background should be blue") that must end up in a rules file such as PRRD.md, once, without duplicates, and merged into an older rule when it is an updated version of that rule. `llm-ext` only reports: every command below writes its result to stdout or to a report file and never edits PRRD.md or any rules file; the calling agent (or the user) writes the file.

The flow has three steps, here is the user's specification of it, quoted verbatim (the four lines that end with two trailing spaces in the source keep them):

```text
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
```

The headings use five codes for the capabilities the flow needs: C1 extract the explicit requirements from a prompt; C2 use the earlier messages of the conversation as context; C3 compare one phrase with a list of rules; C4 deduplicate a list of rules; C5 decide whether a phrase is a duplicate, an updated version or a new rule compared with an existing rule (the rules normally come from a file such as PRRD.md).

Every recipe below was run once (2026-11-04), with the environment `HOME`, `LLM_EXT_CONFIG_DIR` and `LLM_EXT_INSTALL_RULE=0` set to scratch values and `--command_timeout 180`. Step 1 ran on this example; steps 2a, 2b and 3 compare its requirement with rules written for this document (four in 2a, three in 2b, one each in cases 1 and 2 of step 3 and none in case 3); step 2c ran on its own six-line list of rules. Step 3 cases 1 and 3 need no LLM call; each was run once as a check (case 1 printed NO CHANGE, case 3 failed on the echo guard; see step 3). Results are quoted as printed, trimmed to the relevant fields where stated. Models vary run to run: probabilities, and sometimes labels, change a little between runs. Commands that call an LLM (`llm ask`, `llm sem-deduplicate`): the examples ran on `--profile free`; any LLM profile works.

Files used by the examples: `prompt.txt` holds `the colors are horrible. let's improve it a little. the loading screen background should be blue. change it and rebuild. then open the web site in chrome for me to see.` and `context.txt` holds `We implemented the loading screen, but we need to improve the style. Let me see how is it now.`

## Step 1: extract the requirements from the prompt (C1 and C2)

`classify requirements` ships in llm-ext 14.3.0 and later; an installed llm-ext without it exits 1 with `llm-ext: unknown action 'requirements' in group 'classify'.` (measured on llm-ext 14.2.0, 2026-11-04). The runs quoted below used a build that includes it.

### 1a. Score every sentence with Jev, using the earlier messages as context

```bash
llm-ext classify requirements ./prompt.txt --context ./context.txt
```

Result (exit 0, trimmed): `requirements` holds exactly `s3` "the loading screen background should be blue." (requirement 0.98, confidence 0.97); `sentences` holds all five sentences with their labels: s1 opinion (confidence 1), s2 instruction (confidence 0.16, accepted false), s3 requirement (0.97), s4 instruction (0.91), s5 instruction (0.92). Full output, flags, limits and the known limitation: `classify requirements` in `references/classify.md`. Read its "Known limitation" paragraph before trusting the list: a vague sentence can be returned as a requirement, so review the list before writing it into a rules file.

`classify requirements` does not group sentences. A requirement may be written over two sentences, and a list item and its explanation form one rule; step 1b does the grouping.

The caller builds `group-in.txt` from the JSON of 1a (no command does it): one line per entry of `decision.sentences` with id, label, confidence and text, as in the file below; mark `low confidence` when `accepted` is false.

### 1b. Group the sentences with the free LLM, given every sentence with its Jev label

Input file `group-in.txt` (the context, then every sentence with the label and confidence from 1a):

```text
PREVIOUS MESSAGE (context):
We implemented the loading screen, but we need to improve the style. Let me see how is it now.

USER PROMPT, numbered sentences, each with the label a classifier gave it (requirement, instruction, opinion or other) and its confidence:
s1 [opinion 1.00]: the colors are horrible.
s2 [instruction 0.16, low confidence]: let's improve it a little.
s3 [requirement 0.97]: the loading screen background should be blue.
s4 [instruction 0.91]: change it and rebuild.
s5 [instruction 0.92]: then open the web site in chrome for me to see.
```

Instruction file `group-instr.txt`:

```text
You are given a prompt that a user wrote to an AI coding assistant, split into numbered sentences, each with a label from a classifier, plus (when present) the previous message as context. Find the requirements in it.
A REQUIREMENT is a LASTING rule about how the product must look, behave or be built, something that can still be checked after the work is done. A one-off request to the assistant to do something now (rebuild, run, open, show me, commit, push, refresh, change it, fix it, rename or delete something, update a file) is NOT a requirement. Neither are opinions, questions, descriptions or greetings.
Sentence B continues sentence A when B refers back to A (a pronoun, "also", "but", "except", "for example") or qualifies, limits or illustrates A, so B cannot stand alone as its own rule. A requirement together with the sentences that continue it or illustrate it forms ONE group; separate list items are separate requirements; a requirement that stands alone is its own group.
The labels are hints from a classifier, not verdicts: use them, but a sentence with a low confidence needs your own judgement.
Reply with ONLY a JSON array, no prose and no code fence, of the requirement groups in the order they appear, each shaped like {"sentences":["s3"]} and naming the ids of the sentences of that group. Every group must contain at least one requirement. Put a continuation sentence in the group of the sentence it continues, even if it is not a rule on its own (a one-off instruction that merely carries the pronoun of a requirement may join its group, but a one-off instruction that continues nothing is never included). Never include a sentence that is only an instruction, opinion, question, description or greeting and is not tied to a requirement. Reply [] when the prompt has no requirement.
```

```bash
llm-ext llm ask ./group-in.txt --profile free --instructions_files_paths ./group-instr.txt --output_dir ./reports
```

Result (exit 0): stdout is the report path; the answer in the report body is `[{"sentences":["s3","s4"]}]`. s4 ("change it and rebuild.", an instruction) joined s3 because the instruction lets "a one-off instruction that merely carries the pronoun of a requirement" join its group. The rule text to write is the requirement-labelled sentence(s) of each group ("the loading screen background should be blue."). Reading rule (rule of this document, not measured): a sentence labelled instruction (accepted) inside a group is not rule text; show any other non-requirement member to the caller. The free profile can be unavailable; then the command exits non-zero and the step is retried or left to the calling agent.

The same instruction without labels (no label prefixes, no "labels are hints" line) got exactly the expected groups on 75.7% of 37 prompts in a set written during development to its authors' own grouping theory (not blind); with labels it has been run only on this example.

## Step 2: check whether the rule already exists in the rules file (C3, C4, C5)

Candidate rules come from the rules file (one rule per line is easiest). The examples use four rules: r1 "make the background color of the loading dialog of a shade of blue" (a duplicate of the new phrase), r2 "the background of the load panel must not be transparent." (an earlier version of the same requirement), u1 "every API response must include a request id header" and u2 "the settings page must be reachable from the main menu" (unrelated).

`--json` on `classify find` and `classify label` (steps 2a and 2b) ships in llm-ext 14.3.0 and later: llm-ext 14.2.0 exits 1 with `llm-ext: unknown option --json for classify find` (the same for `classify label`; measured 2026-11-04).

### 2a. Does one of the rules say the same thing? (C3)

`classify find` in json mode compares one phrase with a list of candidates. The command line cannot select json mode, so the request goes in a JSON file given with `--input` (shape: "Request JSON shapes" in `references/classify.md`). `find-req.json`:

```json
{"query": "the loading screen background should be blue", "mode": "json",
 "items": [{"id": "r1", "text": "make the background color of the loading dialog of a shade of blue"},
           {"id": "r2", "text": "the background of the load panel must not be transparent."},
           {"id": "u1", "text": "every API response must include a request id header"},
           {"id": "u2", "text": "the settings page must be reachable from the main menu"}]}
```

```bash
llm-ext classify find --input ./find-req.json --json
```

Result (exit 0, `decision` only): `status` answered, `exists` 0.71, `ranked` r1 0.97, r2 0.02, u2 0.01, u1 0, `tie` false, `hits` and `invalid` empty. Reading: `status` answered means a rule says the same thing, and `ranked[0]` (r1) is that rule. The same query against only r2, u1 and u2 gave `status` absent, `exists` 0.17 (r2 still ranked first at 0.96, because `ranked` is relative): in these runs find did not report the earlier version (r2) as present. Use `exists` and `status`, never the rank alone.

A rerun of the same request on llm-ext 14.6.1 (2026-11-17, n=1, remote typesafe/jev-1.14) gave `status` partial, `exists` 0.36, `ranked` r1 0.92, r2 0.06, u1 0.01, u2 0.01: `exists` for the same request varied between runs (0.71 and 0.36), so `status` partial is not proof that no rule says the same thing. r1 stayed ranked first, and the top 3 go on to 2b either way (next paragraph), so 2b decides.

Which rules go on to 2b (rule of this document, not measured): the top 3 of `ranked` (all of them, if fewer), in rank order, also when `status` is absent, because an earlier version of a rule can come back absent (r2 did in every run here) and stopping at absent would lose case 2 of step 3. The reading rules of 2b then combine their verdicts. When the combined verdict is updated_version, step 3 merges with the candidate that got updated_version at confidence >= 0.6; if two or more did, ask the user which rule to update.

Repeated in sequence (n=1, 2026-11-04), 2b on the top-ranked candidate of 2a: find on r2, u1 and u2 gave `status` absent, `exists` 0.14, `ranked[0]` r2 0.97; label on r2 gave updated_version, confidence 0.89 (probabilities 0.01 / 0.93 / 0.06).

### 2b. Is it a duplicate, an updated version or new? (C5)

`classify label` with three classes, one run per candidate rule. The item holds the new phrase and one existing rule; the class descriptions carry the definitions. `label-r2.json` (the files for r1 and u2 differ only in the text after `EXISTING RULE:`):

```json
{"mode": "json",
 "purpose": "Decide how a NEW requirement phrase relates to ONE EXISTING rule of a requirements file.",
 "items": [{"id": "pair", "text": "NEW PHRASE: the loading screen background should be blue.\nEXISTING RULE: the background of the load panel must not be transparent."}],
 "classes": [
   {"id": "duplicate", "description": "the new phrase asks for the same thing as the existing rule, in other words"},
   {"id": "updated_version", "description": "the new phrase changes, extends or refines the same requirement as the existing rule: same subject, different or additional detail"},
   {"id": "new", "description": "the new phrase is about a different requirement than the existing rule"}]}
```

```bash
llm-ext classify label --input ./label-r2.json --json
llm-ext classify label --input ./label-r2.json --json --context ./context.txt   # earlier messages as background; ships in llm-ext 14.3.0 and later (label-r2.json must not hold a `context` key); measured effect mixed, see classify.md
```

Results (exit 0 each, first row of `decision.rows`):

| rule | label | confidence | probabilities (duplicate / updated_version / new) | auto | review |
|---|---|---|---|---|---|
| r1 | duplicate | 0.70 | 0.80 / 0.19 / 0.01 | false | true |
| r2 | updated_version | 0.86 | 0.01 / 0.91 / 0.08 | true | false |
| u2 | new | 1 | 0 / 0 / 1 | true | false |

Rules for reading the runs (rule of this document, not measured): duplicate wins if any candidate is `duplicate` with confidence >= 0.6; otherwise updated_version if any candidate is `updated_version` with confidence >= 0.6; new if every candidate is `new`; any other outcome is uncertain and goes to the LLM or the user (0.6 is the default `--min_confidence` of `classify label`). Gap: no single command returns duplicate / updated version / new yet; until one exists this two-command recipe is the way. Here r1 at 0.70 passes but is below the 0.85 `auto` line, so `review` is true.

### 2c. Deduplicate a list of rules (C4)

For a list that may hold near-duplicates (a rules file, or phrases extracted from many prompts), `llm sem-deduplicate` (C4; it runs on an LLM profile, not on Jev); the input is one phrase per line. `rules-list.txt`:

```text
the loading screen background must be blue
the background of the loading screen should be a blue color
all API responses must include a request id header
every response from the API has to carry a request id header
the settings page must be reachable from the main menu
the login form must reject passwords shorter than 8 characters
```

```bash
llm-ext llm sem-deduplicate ./rules-list.txt --profile free
```

Result (exit 0): stdout is the report path; the report body is:

```text
Deduplicated list (4 phrases):
the loading screen background must be blue
all API responses must include a request id header
the settings page must be reachable from the main menu
the login form must reject passwords shorter than 8 characters

Removed as semantic duplicates:
- the background of the loading screen should be a blue color
- every response from the API has to carry a request id header
```

Survivors are verbatim input lines. This command has no `--output_dir`; the report goes to the default reports folder, or to the folder in the environment variable `LLM_EXT_OUTPUT_DIR`. For 10k+ phrases use `llm-ext llm cluster`.

Gap, not shown (C5 "from a file", which also feeds C3): extracting the candidate rules from a real PRRD.md (lines like `- **G7.4** — text`) or from TRDD files. The json mode of `classify find` takes at most 250 candidates, so a large file needs a pre-filter first. `classify find` in files mode (it searches a file line by line) was not run.

## Step 3: write the rule (the free LLM reformulates)

Only case 2 (updated_version) needs the LLM: give `llm ask` on the free profile the verdict, the existing rule and the new phrase; it answers with the one line to write. Cases 1 and 3 follow from the verdict alone (nothing is written / the phrase is added as is). Instruction file `write-instr.txt`:

```text
You maintain a requirements file. You are given a NEW PHRASE, the most similar EXISTING RULE of the file (or none) and a VERDICT from a classifier: duplicate, updated_version or new.
Reply with ONLY the single line to write in the file, no prose, no quotes, no code fence:
- VERDICT duplicate: reply NO CHANGE.
- VERDICT updated_version: reply ONE rule that merges the existing rule and the new phrase. Keep the wording and form of the EXISTING RULE as far as possible and add only what the new phrase adds. Do not drop anything the existing rule states.
- VERDICT new (or no existing rule): reply the NEW PHRASE exactly as given, without rephrasing it.
```

- Case 1 (duplicate): no LLM call; the verdict alone decides and nothing is written. Run live, the report body was `NO CHANGE`: evidence that the instruction behaves, not a required step.
- Case 3 (new, nothing found): no LLM call; the verdict alone decides and the calling agent adds the new phrase as is. Run live with the instruction file above on `write-case3.txt`: exit 1, no report, stdout empty; stderr `FAILED: ./write-case3.txt — LLM echoed its input back instead of answering`; llm-ext reported the reply as an echo of its input and wrote no report.
- Case 2 (updated version), run live. Input `write-case2.txt`:

```text
VERDICT: updated_version
EXISTING RULE: the background of the load panel must not be transparent.
NEW PHRASE: the loading screen background should be blue.
```

```bash
llm-ext llm ask ./write-case2.txt --profile free --instructions_files_paths ./write-instr.txt --output_dir ./reports
```

Result (exit 0): stdout is the report path; the report body is `the background of the load panel must not be transparent and should be blue.` The preexisting rule's wording is kept and only what the new phrase adds ("should be blue") is appended, as the specification asks.

The report is all `llm-ext` produces. Replacing the old line in PRRD.md with the merged line (case 2), appending the phrase (case 3) or doing nothing (case 1) is done by the calling agent, through the project's own tool for that file; PRRD golden rules are changed by the user only.
