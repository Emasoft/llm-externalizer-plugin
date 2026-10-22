import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { choice, noul, questionSet, score } from './questions.js';

const fixture = (n: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../__fixtures__/p01/${n}.json`, import.meta.url)), 'utf8'));

describe('question builders: wire shape (P-01 request bodies)', () => {
  it('noul without criteria is {type, instructions}', () => {
    expect(noul('Is the customer reporting a software defect?')).toEqual({ type: 'noul', instructions: 'Is the customer reporting a software defect?' });
  });
  it('noul with criteria carries the true/false pair', () => {
    expect(noul('Is it a bug?', { true: 'a defect', false: 'not a defect' }).criteria).toEqual({ true: 'a defect', false: 'not a defect' });
  });
  it('choice criteria keys are the labels the real reply carries as probabilities keys', () => {
    const q = choice('Which category fits this ticket?', { opt0: 'Category number 0 of the ticket.', opt1: 'Category number 1 of the ticket.' });
    const reply = JSON.parse(fixture('dec-choice2').body).answers.team;
    expect(Object.keys(q.criteria as object).sort()).toEqual(Object.keys(reply.probabilities).sort());
  });
  it('choice accepts a null description', () => {
    expect(choice('Which?', { a: null, b: 'bee' }).criteria).toEqual({ a: null, b: 'bee' });
  });
  it('score criteria is a string list', () => {
    expect(score('How urgent is this ticket?', ['level 0', 'level 1', 'level 2'])).toEqual({ type: 'score', instructions: 'How urgent is this ticket?', criteria: ['level 0', 'level 1', 'level 2'] });
  });
  it('a one-criterion score is accepted', () => {
    expect(score('Rate it', ['only']).criteria).toEqual(['only']);
  });
});

describe('question builders: refusals at build', () => {
  it('E32: empty or blank instructions are refused by every builder', () => {
    for (const bad of ['', '   \n']) {
      expect(() => noul(bad)).toThrow(/instructions/);
      expect(() => choice(bad, { a: 'x', b: 'y' })).toThrow(/instructions/);
      expect(() => score(bad, ['x'])).toThrow(/instructions/);
    }
  });
  it('E31: a choice with fewer than 2 options is refused', () => {
    expect(() => choice('Which?', {})).toThrow(/at least 2 options, got 0/);
    expect(() => choice('Which?', { a: 'x' })).toThrow(/at least 2 options, got 1/);
  });
  it('score with an empty criteria list is refused', () => {
    expect(() => score('Rate it', [])).toThrow(/at least 1 criterion/);
  });
  it('E30: an empty question key and an empty choice criteria key are refused', () => {
    const q = noul('Is it?');
    expect(() => questionSet({ '': q })).toThrow(/question key/);
    expect(() => choice('Which?', { '': 'x', b: 'y' })).toThrow(/choice criteria key/);
  });
  it('E30: keys the API accepts (long, unicode, punctuation) pass', () => {
    const q = noul('Is it?');
    const keys = ['a'.repeat(5000), 'é', '日本', 'a b', 'a/b', 'a.b', '-a'];
    expect(Object.keys(questionSet(Object.fromEntries(keys.map((k) => [k, q]))))).toEqual(keys);
  });
  it('blank criteria texts are refused', () => {
    expect(() => noul('Is it?', { true: '', false: 'x' })).toThrow(/criteria.true/);
    expect(() => choice('Which?', { a: ' ', b: 'y' })).toThrow(/choice criteria text/);
    expect(() => score('Rate it', ['ok', ''])).toThrow(/criteria\[1\]/);
  });
  it('a null noul criteria is refused at build, not a raw TypeError', () => {
    expect(() => noul('Is it?', null as never)).toThrow(/noul criteria must be an object/);
    try { noul('Is it?', null as never); expect.unreachable(); } catch (e) { expect(e).toMatchObject({ class: 'bad-request', retryable: false }); }
  });
  it('refusals are non-retryable bad-request errors', () => {
    try { noul(''); expect.unreachable(); } catch (e) { expect(e).toMatchObject({ class: 'bad-request', retryable: false }); }
  });
});
