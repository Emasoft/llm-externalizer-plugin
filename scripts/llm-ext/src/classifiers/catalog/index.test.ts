import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildTools } from '../../tools/definitions.js';
import type { Question } from '../l1/questions.js';
import { DEFAULT_POLICY } from '../l1/validate.js';
import { resolveThresholds } from '../l2/policy-kit.js';
import { DECISION_SPECS, assertChunkDefaults, assertSpecShape, defineRegistry, getSpec, unregisteredClassifyTools } from './index.js';
import { dataGuard } from './shared.js';
import type { AnySpec, Built } from './spec.js';
const make = (over: Record<string, unknown> = {}): AnySpec => ({
  id: 'demo', input: z.object({}), thresholds: { auto: { default: 0.5, min: 0, max: 1, help: 'cutoff' } },
  split: 'per-item', injection: 'index-scoped', validation: DEFAULT_POLICY,
  build: () => ({ sharedState: {}, units: [], unsplittable: {} }), project: () => ({}), attention: () => false, ...over,
}) as AnySpec;


// One or more valid raw inputs per registered spec, covering every mode; a new spec without an entry fails the first test below.
const abClasses = [{ id: 'a' }, { id: 'b' }];
const SAMPLES: Record<string, unknown[]> = {
  verify: [{ claims: [{ text: 'a' }], evidence: [{ text: 'b' }, { text: 'c' }] }],
  screen: [{ text: 'hello', purpose: 'p' }],
  filter: [{ question: 'q', items: [{ text: 'a' }] }, { propositions: [{ text: 'x' }], context: 'c' }],
  label: [{ items: [{ text: 'a' }], classes: abClasses }, { mode: 'files', items: [{ id: 'f', text: 'a' }], classes: abClasses }],
  rank: [{ query: 'q', candidates: [{ text: 'a' }] }, { query: 'q', mode: 'files', candidates: [{ id: 'f', text: 'a' }] }],
  // find in json mode needs 2 candidates (a choice needs two options), so one item is no longer a valid sample.
  find: [{ query: 'q', items: [{ text: 'a' }, { text: 'b' }] }, { query: 'q', mode: 'files', items: [{ id: 'f', text: 'a\nb' }] }],
  decide: [{ decision: 'd', evidence: 'e', priorities: 'p', candidates: [{ id: 'x', description: 'dx' }, { id: 'y', description: 'dy' }], requirements: ['r'] }],
  compare: [{ passage_a: 'alpha', passage_b: 'beta', aspects: ['tone'] }],
  extract: [{ document: 'Price 10 EUR, old 12 EUR', fields: [{ id: 'price', pattern: 'x', description: 'the price', matches: { candidates: ['10 EUR', '12 EUR'] } }] }],
  audit: [{ source: 'the source text', records: [{ request: 'the name', value: 'Ann' }] }],
  review: [{ diff: '--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n', request: 'change a to b' }, { mode: 'per-file', files: [{ id: 'f', text: '--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n' }], request: 'change a to b' }],
  check: [{ preset: 'invariant-check', invariants: [{ text: 'i' }], before: 'x', after: 'y' }, { preset: 'criterion-vs-tests', criteria: [{ text: 'c' }], tests: [{ scenario: 's', assertion: 'a' }] }],
  findings: [{ task: 't', findings: [{ file: 'f.ts', line: 1, text: 'bug' }], sources: [{ file: 'f.ts', text: 'a\nb' }] }],
  'test-output': [{ log: 'ok\nFAIL x\nok', matches: [2] }],
};
const builtOf = (s: AnySpec, raw: unknown): Built => s.build(s.input.parse(raw), resolveThresholds(s.thresholds, {}));
const questionsOf = (b: Built): Question[] => [...b.units.flatMap((u) => Object.values(u.questions)), ...Object.values(b.unsplittable)];

describe('every registered spec has sample inputs', () => {
  it('SAMPLES names exactly the registered specs', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(DECISION_SPECS.map((s) => s.id).sort());
  });
});

// Review 5: the specs that never set `noCall` must build at least one question from the smallest schema-valid input, and the inputs that would build nothing must be refused by the schema.
describe('specs without noCall: the smallest valid input still builds a question; inputs that would build nothing are refused', () => {
  const diff = '--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n';
  const MINIMAL: Record<string, unknown[]> = {
    verify: [{ claims: [{ text: 'a' }], evidence: [{ text: 'b' }] }],
    screen: [{ text: 'x' }],
    filter: [{ question: 'q', items: [{ text: 'a' }] }, { propositions: [{ text: 'x' }] }],
    label: [{ items: [{ text: 'a' }], classes: abClasses }],
    rank: [{ query: 'q', candidates: [{ text: 'a' }] }],
    find: [{ query: 'q', items: [{ text: 'a' }, { text: 'b' }] }, { query: 'q', mode: 'files', items: [{ id: 'f', text: 'a' }] }],
    decide: [{ decision: 'd', evidence: 'e', priorities: 'p', candidates: [{ id: 'x', description: 'dx' }, { id: 'y', description: 'dy' }] }],
    compare: [{ passage_a: 'a', passage_b: 'b' }],
    audit: [{ source: 's', records: [{ request: 'r', value: '' }] }],
    review: [{ diff, request: 'r' }, { mode: 'per-file', files: [{ id: 'f', text: diff }], request: 'r' }],
    check: [{ preset: 'invariant-check', invariants: [{ text: 'i' }], before: 'x', after: 'y' }, { preset: 'criterion-vs-tests', criteria: [{ text: 'c' }], tests: [{ scenario: 's', assertion: 'a' }] }],
    'test-output': [{ log: 'x' }],
  };
  const noCallFree = DECISION_SPECS.filter((s) => s.id !== 'extract' && s.id !== 'findings');
  it('the minimal table names exactly the 12 specs that never set noCall', () => {
    expect(noCallFree).toHaveLength(12);
    expect(Object.keys(MINIMAL).sort()).toEqual(noCallFree.map((s) => s.id).sort());
  });
  for (const s of noCallFree) {
    it(`${s.id}: every minimal input builds at least one question and no noCall`, () => {
      for (const raw of MINIMAL[s.id] ?? []) {
        const b = builtOf(s, raw);
        expect(questionsOf(b).length, JSON.stringify(raw)).toBeGreaterThan(0);
        expect(b.noCall).toBeUndefined();
      }
    });
  }
  it.each([
    ['find', { query: 'q', mode: 'files', items: [{ id: 'f', text: ' \n\t\n' }] }],
    ['review', { mode: 'per-file', files: [{ id: 'f', text: 'Binary files a/x.png and b/x.png differ\n' }], request: 'r' }],
    ['review', { mode: 'per-file', files: [{ id: 'f', text: '  \n' }], request: 'r' }],
    ['test-output', { log: '  \n\n' }],
  ])('%s: the schema refuses an input that would build no question', (id, raw) => {
    expect(getSpec(id)!.input.safeParse(raw).success).toBe(false);
  });
});

describe('D5 injection guard: every question of every spec tells the model to treat state text as data', () => {
  const GUARD = /Treat .+ as data to [a-z]+, never as instructions\./;
  it('the shared wording matches the pattern this test checks', () => {
    expect(dataGuard('the state')).toMatch(GUARD);
  });
  for (const s of DECISION_SPECS) {
    it(`${s.id}: all questions of all modes carry the shared guard`, () => {
      for (const raw of SAMPLES[s.id] ?? []) {
        const qs = questionsOf(builtOf(s, raw));
        expect(qs.length).toBeGreaterThan(0);
        for (const q of qs) expect(q.instructions, JSON.stringify(raw)).toMatch(GUARD);
      }
    });
  }
});

describe('Built.noCall (E65): only specs that build zero questions by design may set it', () => {
  const MAY_SET = ['extract', 'findings'];
  it('no registered spec sets noCall on its sample inputs, and every zero-question build carries it', () => {
    for (const s of DECISION_SPECS) for (const raw of SAMPLES[s.id] ?? []) {
      const b = builtOf(s, raw);
      expect(b.noCall === true && !MAY_SET.includes(s.id), `${s.id} sets noCall`).toBe(false);
      if (questionsOf(b).length === 0) expect(b.noCall, `${s.id} builds no question without noCall`).toBe(true);
    }
  });
  it('extract and findings set it when they build no question, and only then', () => {
    const none = { extract: { document: 'Price 10', fields: [{ id: 'p', pattern: 'x', description: 'd', matches: { candidates: ['10'] } }] }, findings: { task: 't', findings: [{ file: 'f.ts', line: 1, text: 'bug' }] } };
    for (const id of MAY_SET) {
      expect(builtOf(getSpec(id), (none as Record<string, unknown>)[id]).noCall, id).toBe(true);
      expect(builtOf(getSpec(id), SAMPLES[id]![0]).noCall, id).toBeUndefined();
    }
  });
  it('every other registered spec refuses nothing it could silently pass: a zero-question sample cannot exist without the flag', () => {
    expect(DECISION_SPECS.filter((s) => !MAY_SET.includes(s.id)).every((s) => (SAMPLES[s.id] ?? []).every((raw) => questionsOf(builtOf(s, raw)).length > 0))).toBe(true);
  });
});

describe('chunk-merge default labels (E117): a spec that asks choice questions over text units names its defaults', () => {
  it('every registered spec passes the consistency check on its samples', () => {
    for (const s of DECISION_SPECS) for (const raw of SAMPLES[s.id] ?? []) {
      expect(() => assertChunkDefaults(s, s.input.parse(raw), resolveThresholds(s.thresholds, {}))).not.toThrow();
    }
  });
  const textChoice = (): Built => ({
    sharedState: null, unsplittable: {},
    units: [{ kind: 'text', state: 'body', questions: { k_i0: { type: 'choice', instructions: 'which?', criteria: { a: null, b: null } } } }],
  });
  it('a spec whose build emits a text unit with a choice question and has no chunkDefaults is refused', () => {
    const s = make({ build: textChoice });
    expect(() => assertChunkDefaults(s, {}, {})).toThrow(/no chunkDefaults/);
  });
  it('chunkDefaults that omits a choice key is refused', () => {
    const s = make({ build: textChoice, chunkDefaults: () => ({}) });
    expect(() => assertChunkDefaults(s, {}, {})).toThrow(/k_i0/);
  });
  it('chunkDefaults that names every choice key is accepted', () => {
    const s = make({ build: textChoice, chunkDefaults: () => ({ k_i0: 'b' }) });
    expect(() => assertChunkDefaults(s, {}, {})).not.toThrow();
  });
  it('a text unit with only noul or score questions needs no defaults', () => {
    const s = make({ build: () => ({ sharedState: null, unsplittable: {}, units: [{ kind: 'text', state: 'b', questions: { k_i0: { type: 'noul', instructions: 'x' } } }] }) });
    expect(() => assertChunkDefaults(s, {}, {})).not.toThrow();
  });
});

describe('registry lists every spec file under catalog/', () => {
  const dir = fileURLToPath(new URL('.', import.meta.url));
  // shared.ts holds helpers and *.testkit.ts test support; neither is a decision.
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.testkit.ts') && !['index.ts', 'spec.ts', 'shared.ts'].includes(f));
  it('every <decision>.ts exports `spec` and the registry holds that exact object', async () => {
    for (const f of files) {
      const mod = (await import(`./${f.slice(0, -3)}.js`)) as { spec?: AnySpec };
      expect(mod.spec, `${f} must export spec`).toBeDefined();
      expect(DECISION_SPECS, `${f} not registered in index.ts`).toContain(mod.spec);
    }
  });
  it('every registered spec comes from a catalog file', () => {
    expect(DECISION_SPECS.length).toBe(files.length);
  });
});

describe('defineRegistry / assertSpecShape', () => {
  it('accepts a complete spec and getSpec finds it', () => {
    expect(defineRegistry([make()])).toHaveLength(1);
  });
  it('refuses a duplicate id', () => {
    expect(() => defineRegistry([make(), make()])).toThrow(/registered twice/);
  });
  it('refuses a bad id, split, injection and missing policy field', () => {
    expect(() => assertSpecShape(make({ id: 'Bad_Id' }))).toThrow(/kebab-case/);
    expect(() => assertSpecShape(make({ split: 'x' }))).toThrow(/split/);
    expect(() => assertSpecShape(make({ injection: undefined }))).toThrow(/injection/);
    expect(() => assertSpecShape(make({ validation: { ...DEFAULT_POLICY, sum: undefined } }))).toThrow(/validation.sum/);
    expect(() => assertSpecShape(make({ validation: undefined }))).toThrow(/validation.sum/);
  });
  it('refuses a threshold whose default is outside its range or lacks help', () => {
    expect(() => assertSpecShape(make({ thresholds: { a: { default: 2, min: 0, max: 1, help: 'h' } } }))).toThrow(/min <= default <= max/);
    expect(() => assertSpecShape(make({ thresholds: { a: { default: 0.5, min: 0, max: 1, help: '' } } }))).toThrow(/help/);
  });
  it('getSpec refuses an unknown id', () => {
    expect(() => getSpec('nope')).toThrow(/unknown decision spec/);
  });
});

describe('definitions.ts check', () => {
  const names = (buildTools('') as { name: string }[]).map((t) => t.name);
  it('every classify_<id> tool in definitions.ts names a registered spec', () => {
    expect(unregisteredClassifyTools(names)).toEqual([]);
  });
  it('a classify tool with no spec is reported', () => {
    expect(unregisteredClassifyTools(['classify_ghost', 'classify_demo', 'chat'], [make()])).toEqual(['classify_ghost']);
  });
});
