#!/usr/bin/env node
// Deterministic synthetic fixture generator for cluster_synonyms tests.
// Produces 3 fixture files under scripts/llm-ext/src/cluster/fixtures/:
//
//   synthetic_500.jsonl       — 500 items, 130 ground-truth clusters
//   synthetic_500.expected.json — id → cluster_id ground truth
//   budget_exhaust.jsonl      — 60 items, used in the budget-cap test
//   merge_3_floor.jsonl       — 12 items, 2 pre-defined clusters (used in T15)
//
// All output is deterministic given the same seeds in this script.
// Re-run anytime: `node scripts/llm-ext/scripts/gen_cluster_fixtures.mjs`

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIX_DIR = join(__dirname, "..", "src", "cluster", "fixtures");
mkdirSync(FIX_DIR, { recursive: true });

// ── deterministic PRNG ──────────────────────────────────────────────
function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── paraphrase templates ────────────────────────────────────────────
// Each "concept" gets multiple paraphrases. The cluster_synonyms tool
// is supposed to group all paraphrases of one concept together.
const CONCEPT_TEMPLATES = [
  ["Compile the code", "Build the project", "Compile the source", "Compile the program", "Build the binary"],
  ["Run the tests", "Execute the test suite", "Run unit tests", "Run the testsuite", "Execute the tests"],
  ["Deploy to production", "Ship to prod", "Deploy to live", "Push to production", "Release to prod"],
  ["Open a pull request", "Submit a PR", "Open a code review", "Create a pull request", "Open a merge request"],
  ["Commit the changes", "Save the changes", "Stage and commit", "Record the changes", "Make a commit"],
  ["Lint the code", "Run linter", "Check style", "Style-check the code", "Run code quality checks"],
  ["Format the code", "Auto-format", "Apply formatter", "Run prettier", "Beautify the code"],
  ["Profile performance", "Measure latency", "Benchmark performance", "Profile the runtime", "Measure speed"],
  ["Refactor the function", "Clean up the function", "Restructure the function", "Simplify the function", "Rewrite the function"],
  ["Add a comment", "Document the code", "Annotate the function", "Write inline docs", "Add doc-comments"],
  // Cluster 11-30: medium clusters of 10 paraphrases each
  ["Configure the linter", "Set up linting rules", "Configure code style", "Tune the linter", "Update lint config"],
  ["Update dependencies", "Bump dependencies", "Upgrade deps", "Refresh dependencies", "Pull dep updates"],
  ["Resolve merge conflicts", "Fix merge conflicts", "Reconcile branches", "Sort out conflicts", "Resolve git conflicts"],
  ["Check the logs", "Read the logs", "Inspect log output", "Look at the logs", "Review the logs"],
  ["Open a terminal", "Start a shell", "Launch the terminal", "Spawn a shell", "Open a console"],
  ["Read the documentation", "Check the docs", "Look at the documentation", "Consult the docs", "Read the manual"],
  ["Write a test case", "Add a unit test", "Create a test", "Author a new test", "Add a test case"],
  ["Push the branch", "Push to remote", "Sync to origin", "Push commits up", "Push to upstream"],
  ["Pull the latest", "Pull from main", "Sync with upstream", "Fetch and merge", "Pull latest changes"],
  ["Run the linter", "Lint check", "Check for lint", "Verify lint passes", "Run lint validation"],
];

// ── synthetic 500 generator ────────────────────────────────────────
function buildSynthetic500() {
  const items = [];
  const expected = {};
  let idCounter = 1;
  // Block 1: 10 concepts × 20 paraphrases = 200 items
  for (let c = 0; c < 10; c++) {
    const tmpl = CONCEPT_TEMPLATES[c % CONCEPT_TEMPLATES.length];
    const clusterId = `cluster_concept_${String(c + 1).padStart(3, "0")}`;
    for (let p = 0; p < 20; p++) {
      const base = tmpl[p % tmpl.length];
      // Add tiny variation to each paraphrase (different ending) without changing meaning.
      const variation = p < tmpl.length ? "" : ` (v${Math.floor(p / tmpl.length)})`;
      const sentence = `${base}${variation}`;
      const id = `s${String(idCounter++).padStart(4, "0")}`;
      items.push({ id, sentence });
      expected[id] = clusterId;
    }
  }
  // Block 2: 20 concepts × 10 paraphrases = 200 items
  for (let c = 0; c < 20; c++) {
    const tmplIdx = (c + 10) % CONCEPT_TEMPLATES.length;
    const tmpl = CONCEPT_TEMPLATES[tmplIdx];
    const clusterId = `cluster_med_${String(c + 1).padStart(3, "0")}`;
    for (let p = 0; p < 10; p++) {
      const base = tmpl[p % tmpl.length];
      const variation = p < tmpl.length ? "" : ` (v${Math.floor(p / tmpl.length)}b)`;
      const sentence = `${base}${variation}`;
      const id = `s${String(idCounter++).padStart(4, "0")}`;
      items.push({ id, sentence });
      expected[id] = clusterId;
    }
  }
  // Block 3: 100 unique singletons
  for (let s = 0; s < 100; s++) {
    const clusterId = `cluster_single_${String(s + 1).padStart(3, "0")}`;
    const sentence = `Singleton concept number ${s + 1}: ${unique(s)}`;
    const id = `s${String(idCounter++).padStart(4, "0")}`;
    items.push({ id, sentence });
    expected[id] = clusterId;
  }
  return { items, expected };
}

const SINGLETON_FILLERS = [
  "configure timeouts", "deprecated API note", "polling interval setup", "rate-limit budget review",
  "memory profile sample", "GPU benchmark trace", "shader compilation log", "JIT compile flag tuning",
  "circuit-breaker reset", "feature-flag rollout plan", "A/B test variant assignment",
];
function unique(s) {
  return SINGLETON_FILLERS[s % SINGLETON_FILLERS.length] + " #" + (Math.floor(s / SINGLETON_FILLERS.length) + 1);
}

// ── budget_exhaust generator ───────────────────────────────────────
function buildBudgetExhaust() {
  const rng = mulberry32(0xBEEF);
  const items = [];
  for (let i = 0; i < 60; i++) {
    const id = `b${String(i + 1).padStart(3, "0")}`;
    const sentence = `Budget exhaust filler ${i + 1}: ${(rng() * 1e6).toFixed(0)}`;
    items.push({ id, sentence });
  }
  return items;
}

// ── merge_3_floor generator ────────────────────────────────────────
// 12 items: 6 items definitely meaning "open a terminal", 6 items
// definitely meaning "close a window". The Phase 2 test will pre-seed
// these into two clusters (A: items 1-6, B: items 7-12) and then feed
// the mock LLM a response that groups 2-from-A + 2-from-B (NO merge,
// case X) or 3-from-A + 3-from-B (MERGE, case Y).
function buildMerge3Floor() {
  const items = [];
  const A_template = [
    "Open a terminal", "Launch a shell", "Start the terminal app",
    "Spawn a new shell", "Open a console window", "Bring up a terminal",
  ];
  const B_template = [
    "Close the window", "Dismiss the dialog", "Close the modal",
    "Shut the popup", "Close the panel", "Close the overlay",
  ];
  for (let i = 0; i < 6; i++) {
    items.push({ id: `a${i + 1}`, sentence: A_template[i] });
  }
  for (let i = 0; i < 6; i++) {
    items.push({ id: `b${i + 1}`, sentence: B_template[i] });
  }
  return items;
}

// ── write all files ─────────────────────────────────────────────────
function jsonlOf(items) {
  return items.map((o) => JSON.stringify(o)).join("\n") + "\n";
}

const { items, expected } = buildSynthetic500();
writeFileSync(join(FIX_DIR, "synthetic_500.jsonl"), jsonlOf(items));
writeFileSync(join(FIX_DIR, "synthetic_500.expected.json"), JSON.stringify(expected, null, 2) + "\n");

writeFileSync(join(FIX_DIR, "budget_exhaust.jsonl"), jsonlOf(buildBudgetExhaust()));
writeFileSync(join(FIX_DIR, "merge_3_floor.jsonl"), jsonlOf(buildMerge3Floor()));

console.log(`wrote fixtures to ${FIX_DIR}:`);
console.log(`  synthetic_500.jsonl        (${items.length} items, ${new Set(Object.values(expected)).size} clusters)`);
console.log(`  synthetic_500.expected.json`);
console.log(`  budget_exhaust.jsonl       (60 items)`);
console.log(`  merge_3_floor.jsonl        (12 items, 2 ground-truth clusters)`);
