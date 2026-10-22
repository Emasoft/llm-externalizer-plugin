import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { classifyHttpError, networkError, timeoutError, badResponseError } from './errors.js';
import { replayFixture, syntheticResponse, type RecordedReply } from './test-fetch.js';

const fixture = (n: string): RecordedReply =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../__fixtures__/p01/${n}.json`, import.meta.url)), 'utf8'));
async function classify(res: Response) {
  return classifyHttpError(res.status, res.headers, await res.text());
}
const fromFixture = (n: string) => classify(replayFixture(fixture(n)));
const synth = (s: number, body: unknown, h: Record<string, string> = {}) =>
  classify(syntheticResponse(s, typeof body === 'string' ? body : JSON.stringify(body), h));

describe('classifyHttpError on real P-01 replies', () => {
  it('401 -> auth, status kept, not retried', async () => {
    const e = await fromFixture('dec-err401');
    expect([e.class, e.status, e.retryable]).toEqual(['auth', 401, false]);
    expect(e.message).toContain('401');
  });
  it('unknown model id is HTTP 400 and classified by body -> not-found', async () => {
    const e = await fromFixture('dec-err404');
    expect([e.class, e.status, e.retryable]).toEqual(['not-found', 400, false]);
  });
  it('wrong URL path 404 with text body -> not-found', async () => {
    expect((await fromFixture('err404-path')).class).toBe('not-found');
  });
  it('max_tokens_exceeded (400, JSON inside a string) -> context-overflow', async () => {
    for (const n of ['dec-err413-12mb', 'ctx-state165k', 'sys-ctx-state165k']) {
      const e = await fromFixture(n);
      expect([e.class, e.status, e.retryable]).toEqual(['context-overflow', 400, false]);
    }
  });
  it('413 above 52,428,800 bytes -> too-large', async () => {
    const e = await fromFixture('dec-err413-60mb');
    expect([e.class, e.status, e.retryable]).toEqual(['too-large', 413, false]);
  });
  it('malformed, not-JSON and key-quality 400s -> bad-request', async () => {
    for (const n of ['dec-err400-malformed', 'dec-err400-noquestions', 'dec-err400-notjson', 'dec-keyq-ch14', 'sys-keyq-ch4']) {
      const e = await fromFixture(n);
      expect([e.class, e.status, e.retryable]).toEqual(['bad-request', 400, false]);
    }
  });
});

describe('classifyHttpError on synthetic replies (D21)', () => {
  it('synthetic: 402 in-flight budget is retried (E06)', async () => {
    const e = await synth(402, { error: { message: 'Too many in-flight requests: budget exceeded', code: 402, limit_source: 'openrouter_in_flight_budget' } });
    expect([e.class, e.limit_source, e.retryable]).toEqual(['in-flight-budget', 'openrouter_in_flight_budget', true]);
  });
  it('synthetic: 402 mentioning in flight but without the marker is payment, not retried (E06)', async () => {
    const e = await synth(402, { error: { message: 'payment in flight, insufficient credits', code: 402 } });
    expect([e.class, e.retryable]).toEqual(['payment', false]);
  });
  it('synthetic: 402 insufficient credits is not retried and shows a remedy (E06)', async () => {
    const e = await synth(402, { error: { message: 'Insufficient credits', code: 402 } });
    expect([e.class, e.retryable]).toEqual(['payment', false]);
    expect(e.remedy_hint).toMatch(/credits/);
  });
  it('synthetic: 402 key limit is not retried and shows a remedy (E06)', async () => {
    const e = await synth(402, { error: { message: 'API key limit exceeded', code: 402 } });
    expect([e.class, e.retryable]).toEqual(['key-limit', false]);
    expect(e.remedy_hint).toBeTruthy();
  });
  it('synthetic: 403 key limit -> key-limit, plain 403 -> auth', async () => {
    expect((await synth(403, { error: { message: 'Key limit exceeded', code: 403 } })).class).toBe('key-limit');
    expect((await synth(403, { error: { message: 'forbidden', code: 403 } })).class).toBe('auth');
  });
  it('synthetic: 429 from the provider keeps provider_code and is retried (E07)', async () => {
    const e = await synth(429, { error: { message: 'slow down', code: 'upstream_rate_limit' } });
    expect([e.class, e.limit_source, e.provider_code, e.retryable]).toEqual(['rate-limited', 'provider', 'upstream_rate_limit', true]);
  });
  it('synthetic: 429 from the platform (X-RateLimit headers) keeps provider_code and is retried (E07)', async () => {
    const e = await synth(429, { error: { message: 'limit', code: 429 } }, { 'X-RateLimit-Remaining': '0' });
    expect([e.class, e.limit_source, e.provider_code, e.retryable]).toEqual(['rate-limited', 'platform', '429', true]);
  });
  it('synthetic: 408, 409, 500, 524, 529 -> unavailable, retried, status kept', async () => {
    for (const s of [408, 409, 500, 524, 529]) {
      const e = await synth(s, 'oops');
      expect([e.class, e.status, e.retryable]).toEqual(['unavailable', s, true]);
      expect(e.message).toContain(String(s));
    }
  });
  it('synthetic: message is sanitized but keeps the status', async () => {
    const e = await synth(500, { error: { message: 'boom user_id: "user_abc123" sk-abcdefghijkl', code: 500 } });
    expect(e.message).toContain('500');
    expect(e.message).not.toMatch(/user_abc123|sk-abcdefghijkl/);
  });
});

describe('client-side failures', () => {
  it('network, timeout, bad-response are classified and never retried', () => {
    expect([networkError(new Error('ECONNRESET')).class, networkError('x').retryable]).toEqual(['network', false]);
    expect([timeoutError().class, timeoutError().retryable]).toEqual(['timeout', false]);
    expect([badResponseError('answers missing').class, badResponseError('x').retryable]).toEqual(['bad-response', false]);
  });
});
