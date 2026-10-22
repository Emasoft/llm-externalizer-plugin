import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ClassifierError } from '../l0/errors.js';
import { noul, questionSet } from './questions.js';
import { MAX_REQUEST_BODY_BYTES, checkRequestShape } from './request-shape.js';

const fixture = (n: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../__fixtures__/p01/${n}.json`, import.meta.url)), 'utf8'));
const qs = (n: number) => questionSet(Object.fromEntries(Array.from({ length: n }, (_, i) => [`q${i}`, noul('Is it a defect?')])));
const refusal = (f: () => void): ClassifierError => {
  try {
    f();
  } catch (e) {
    return e as ClassifierError;
  }
  throw new Error('expected a refusal');
};

describe('checkRequestShape: question count', () => {
  it('accepts a count equal to the limit', () => {
    expect(() => checkRequestShape(qs(3), 'text', { maxQuestions: 3 })).not.toThrow();
  });
  it('refuses a count over the limit, naming the count, the limit and what to change', () => {
    const e = refusal(() => checkRequestShape(qs(20), 'text', { maxQuestions: 19 }));
    expect(e).toBeInstanceOf(ClassifierError);
    expect(e.class).toBe('bad-request');
    expect(e.retryable).toBe(false);
    expect(e.message).toContain('20 questions');
    expect(e.message).toContain('19');
    expect(e.message).toMatch(/remove|split/);
  });
  it('refuses zero questions: the real API answers 400 without a questions record (P-01 dec-err400-noquestions)', () => {
    expect(fixture('dec-err400-noquestions').status).toBe(400);
    expect(refusal(() => checkRequestShape({}, 'text', { maxQuestions: 19 })).message).toContain('at least 1 question');
  });
  it('refuses a limit that is not a positive integer', () => {
    expect(() => checkRequestShape(qs(1), 'text', { maxQuestions: 0 })).toThrow(/maxQuestions/);
  });
});

describe('checkRequestShape: serialized size', () => {
  it('uses the P-01 measured API cap: the 60 MB probe was refused with 52428800 bytes as the maximum', () => {
    expect(JSON.parse(fixture('dec-err413-60mb').body).error.message).toContain(String(MAX_REQUEST_BODY_BYTES));
  });
  it('refuses a body over the byte limit, naming the size, the limit and what to change', () => {
    const e = refusal(() => checkRequestShape(qs(1), 'x'.repeat(2000), { maxQuestions: 19, maxBytes: 1000 }));
    expect(e.class).toBe('bad-request');
    expect(e.message).toMatch(/\d{4} bytes/);
    expect(e.message).toContain('1000');
    expect(e.message).toMatch(/shorten|split/);
  });
  it('counts bytes, not characters', () => {
    const state = 'é'.repeat(600);
    expect(() => checkRequestShape(qs(1), state, { maxQuestions: 19, maxBytes: 1000 })).toThrow(/bytes/);
  });
  it('accepts a body under the default cap', () => {
    expect(() => checkRequestShape(qs(1), 'x'.repeat(1000), { maxQuestions: 19 })).not.toThrow();
  });
});
