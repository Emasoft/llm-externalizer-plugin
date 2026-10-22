# RD-01 report: style study of the quicksilver README and chart script (2026-10-09)

Files written: /Volumes/EmaUITEK4TBSSD/Code/llm-externalizer/llm-externalizer-plugin/NOTICE (new), this report. No code changed, nothing committed (rule 4; the card asks one commit, left to the orchestrator).

## Sources read (as data)
- GitHub UditAkhourii/quicksilver (default branch main, MIT, last push 2026-09-25): README.md (177 lines), LICENSE (21 lines), bench/chart.mjs (62 lines), fetched with `gh api`. The local clone ~/Code/quicksilver has a byte-identical LICENSE.
- The installed ~/.claude/skills/quicksilver/ has only SKILL.md, qs.mjs, providers.example.json: no README, LICENSE or chart script, so the repo is the only source (consistent with plan D28: installed 0.3.0 differs from the 0.2.0 repo).
- Plan section 13b, D17, D26, D28.

## LICENSE finding
MIT, "Copyright (c) 2026 Udit Akhouri". D28: only repo text may be copied, with the full MIT notice in NOTICE; hence NOTICE carries the full text. The licence covers the repo (README, chart.mjs), not the unlicensed 0.3.0 additions.

## Style findings
README (QR = quicksilver README line):
- QR1-3 centered banner SVG at 100% width; QR5-11 centered shields.io badges (flat-square, install anchor, platform, headline number, zero deps, licence); QR13 one-sentence centered tagline h3.
- QR15-24 pitch in two paragraphs: the pain with three italic concrete questions, then what the tool is and the headline cost.
- QR26-30 one ASCII flow diagram.
- QR32-60 Install: one npx line, what the installer does, restart; alternatives in a collapsed `<details>` (QR43-60).
- QR62-97 The benchmark: setup paragraph, centered chart SVG (QR70), 12-row table with columns Situation/Metric/before/after/tokens/cut/time/cost (QR72-85), bold = within 2 points (QR87), one blockquote "The claim" (QR89-91), then a method/reproducibility paragraph linking bench/ (QR93-97).
- QR99-122 "Where it shines, and where it doesn't": three bold-led bullet groups (use and trust / use as shortlist / do not use for), each bullet a bold phrase plus measured evidence.
- QR124-142 "What Claude can do with it": one code block, one command per line with aligned trailing comment (QR127-133), then the output format and a real receipt line (QR140-142).
- QR144-152 a short rationale section; QR154-162 Safety (3 bullets); QR164-173 FAQ (bold question, short answer); QR175-177 License one line.
- Tone: second-person-free, concrete numbers, short paragraphs, no reference prose; total 177 lines.

chart.mjs (QC = chart.mjs line):
- QC6 reads one committed results JSON ({rows, all}); QC60-62 writes one SVG: single script, data in, SVG out (matches 13b rule 1).
- QC8-13 fixed layout constants and helpers (esc, k, pct); QC16-30 one row per task with two bars (baseline grey, tool gradient) scaled to the max baseline, value labels, cut percent, quality "a -> b" coloured ok/warn by the 2-point parity rule (QC20), speedup.
- QC32-47 SVG with an embedded <style> and gradients; QC48 dark background rect; QC49-57 title, subtitle with overall figures, legend, column headers, footer defining the metric and pointing at reproduction docs.
- Output is deterministic (no timestamps or randomness), hence rerender-and-compare is possible (RD-07).

## Gaps to fix in our version (not copied)
- chart.mjs is dark-only: fixed hex fills and a dark background rect (QC34-48), no prefers-color-scheme. 13b requires correct light and dark rendering on GitHub: use an embedded `@media (prefers-color-scheme: dark)` style, no background rect (or theme-aware), screenshots in both (RD-16).
- QC5 derives paths with a Windows regex hack and reads/writes relative to the file; ours must take paths from assets/data/ and the committed output path explicitly (RD-07) and fail fast on a missing or malformed results file.
- The quicksilver table numbers are in README prose by hand (QR72-91); ours must come from committed results files (13b rule 1), including the headline claim (QR8 badge, QR89-91).
- Quicksilver has no per-command section; llm-ext needs one per CLI command (13b rule 2) and docs/ split (D26).

## Outline (each item cites the quicksilver README line it mirrors)
1. Banner SVG, centered, 100% width - QR1-3 (RD-04)
2. Badge row: install anchor, Claude Code plugin, one headline measured number, zero/low deps if true, licence - QR5-11 (RD-04)
3. One-line tagline - QR13
4. Pitch: pain with 3 concrete questions, then what llm-ext is and its cost per token - QR15-24
5. ASCII flow diagram of caller -> llm-ext -> model -> shortlist - QR26-30
6. Install: one-liner, what it does, restart; alternatives in `<details>` - QR32-60 (RD-13)
7. The benchmark: setup paragraph, chart SVG, table (before/after tokens, cost, time) with data-file-sourced numbers, parity note, one claim blockquote, method paragraph linking docs - QR62-97 (RD-05,06,07,12)
8. Where it shines, and where it doesn't: three bold-led groups with cited evidence - QR99-122 (RD-12)
9. What Claude can do with it: aligned one-line-per-command examples plus the receipt/output-format paragraph - QR124-142 (RD-09,10,11); per-command what / when / not when / 1-3 captured examples is our extension of QR127-133
10. Command x profile-type table (SUPPORTED PROFILE TYPES) - no quicksilver counterpart, placed after item 9 in the QR124-142 style (RD-20)
11. Rationale short section (typed narrow judgments) - QR144-152, optional
12. Safety, 3 to 5 bullets - QR154-162 (RD-13)
13. FAQ, bold question plus short answer - QR164-173 (RD-13)
14. License, one line, plus pointer to NOTICE - QR175-177
15. Reference detail (auth precedence, scouting parameters, profile schema) moved to linked docs/*.md pages - QR93-94 links bench/ instead of inlining (D26, RD-14)

## Acceptance
- reads quicksilver LICENSE itself: satisfied (fetched LICENSE via gh api, 21 lines, MIT; also cmp-identical to local clone).
- NOTICE created with the quicksilver entry: satisfied (/Volumes/EmaUITEK4TBSSD/Code/llm-externalizer/llm-externalizer-plugin/NOTICE, full MIT text).
- every outline item cites the quicksilver README line: satisfied, except item 10 (no counterpart, stated) and the item 9 extension (stated).
- definition of done: no code changed, README not touched so RD-15 test not applicable; the single commit with the card id in its subject is NOT made by me (rule 4); orchestrator to commit NOTICE and this study.

## Notes
- Card says "Files: to be listed at card start": done above. Plan/card errors found: none. The card does not name the GitHub repo; the plan 13b/D28 does (the repo URL was found via gh search).
- DOC-15 owns the classifier-source NOTICE entries; this NOTICE has only the quicksilver entry and its header, so DOC-15 appends.
- The NOTICE "Used for" line claims style/structure use; if the orchestrator prefers a copy-only entry, edit that line.
