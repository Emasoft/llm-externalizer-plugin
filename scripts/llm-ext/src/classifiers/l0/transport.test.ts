import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createDeadline, type Deadline } from './deadline.js';
import { ClassifierError } from './errors.js';
import { replayFetch, syntheticResponse, type RecordedReply } from './test-fetch.js';
import { callDecisions, clampAttempts, parseRetryAfter, type DecisionsCall, type GlobalFetch } from './transport.js';

const fixture = (name: string): RecordedReply =>
  JSON.parse(readFileSync(new URL(`../__fixtures__/p01/${name}.json`, import.meta.url), 'utf8')) as RecordedReply;

const KEY = 'sk-or-v1-testkey-0123456789';
const call: DecisionsCall = {
  endpoint: 'decisions',
  model: '~typesafe/jev-latest',
  state: { ticket: 'My checkout page shows a blank screen after I click Pay.' },
  questions: { team: { type: 'choice', instructions: 'Which category fits?', criteria: { opt0: 'a', opt1: 'b' } } },
};

const deadlines: Deadline[] = [];
function opts(fetchImpl: GlobalFetch, key = KEY) {
  const deadline = createDeadline({ timeoutMs: 5000 });
  deadlines.push(deadline);
  return { key, deadline, maxAttempts: 1, fetchImpl };
}
afterEach(() => deadlines.splice(0).forEach((d) => d.dispose()));

async function failure(p: Promise<unknown>): Promise<ClassifierError> {
  const e = await p.then(
    () => undefined,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(ClassifierError);
  return e as ClassifierError;
}

describe('callDecisions request building', () => {
  it('sends one POST with the four headers, redirect error, the right URL and a JSON body (real P-01 reply)', async () => {
    const r = replayFetch([fixture('dec-choice2')]);
    const reply = await callDecisions({ ...call, sessionId: 's1' }, opts(r.fetch));
    expect(reply.model).toBe('typesafe/jev-1.13-20260917');
    expect(r.calls).toHaveLength(1);
    const { url, init } = r.calls[0];
    expect(url).toBe('https://openrouter.ai/api/alpha/decisions');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(init.headers).toEqual({
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/Emasoft/llm-externalizer-plugin',
      'X-OpenRouter-Title': 'llm-externalizer',
    });
    expect(JSON.parse(init.body as string)).toEqual({ model: call.model, state: call.state, questions: call.questions, session_id: 's1' });
  });

  it('the systemone endpoint posts to /api/v1/systemone', async () => {
    const r = replayFetch([fixture('sys-choice2')]);
    await callDecisions({ ...call, endpoint: 'systemone' }, opts(r.fetch));
    expect(r.calls[0].url).toBe('https://openrouter.ai/api/v1/systemone');
  });

  it('an endpoint name outside decisions and systemone is refused before any request is sent', async () => {
    const r = replayFetch([]);
    for (const endpoint of ['systemtwo', 'constructor']) {
      const e = await failure(callDecisions({ ...call, endpoint: endpoint as DecisionsCall['endpoint'] }, opts(r.fetch)));
      expect(e.class).toBe('bad-request');
    }
    expect(r.calls).toHaveLength(0);
  });

  it('E14: key text inside the state is refused before any request is sent', async () => {
    const r = replayFetch([]);
    const e = await failure(callDecisions({ ...call, state: `token ${KEY} leaked` }, opts(r.fetch)));
    expect(e.class).toBe('bad-request');
    expect(e.message).not.toContain(KEY);
    expect(r.calls).toHaveLength(0);
  });

  it('E14: key text inside the questions is refused before any request is sent', async () => {
    const r = replayFetch([]);
    const q = { k: { type: 'noul', instructions: `use ${KEY}` } };
    await failure(callDecisions({ ...call, questions: q }, opts(r.fetch)));
    expect(r.calls).toHaveLength(0);
  });

  it('E02 synthetic: a body over 1 MB with no Content-Length is bad-response (too large)', async () => {
    const r = replayFetch([syntheticResponse(200, 'x'.repeat(1_000_001))]);
    const e = await failure(callDecisions(call, opts(r.fetch)));
    expect(e.class).toBe('bad-response');
    expect(e.message).toMatch(/too large/);
  });

  it('E02 synthetic: a Content-Length over 1 MB is bad-response (too large) without reading the body', async () => {
    const r = replayFetch([syntheticResponse(200, '{}', { 'content-length': '5000000' })]);
    const e = await failure(callDecisions(call, opts(r.fetch)));
    expect(e.class).toBe('bad-response');
    expect(e.message).toMatch(/too large/);
  });

  it('a real P-01 401 reply becomes an auth error with its status', async () => {
    const e = await failure(callDecisions(call, opts(replayFetch([fixture('dec-err401')]).fetch)));
    expect(e.class).toBe('auth');
    expect(e.status).toBe(401);
  });

  it('synthetic: a 200 with a non-JSON body is bad-response', async () => {
    const e = await failure(callDecisions(call, opts(replayFetch([syntheticResponse(200, '<html>')]).fetch)));
    expect(e.class).toBe('bad-response');
  });

  it('E08: a real 3xx from a live local server is an error, not followed (redirect: "error")', async () => {
    let hits = 0;
    const server = createServer((req, res) => {
      hits++;
      if (req.url === '/target') res.end('{}');
      else res.writeHead(302, { location: '/target' }).end();
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    try {
      const { port } = server.address() as { port: number };
      // The seam retargets the fixed URL to the local server and forwards init untouched to the real fetch.
      const toLocal: GlobalFetch = (_url, init) => fetch(`http://127.0.0.1:${port}/start`, init);
      const e = await failure(callDecisions(call, opts(toLocal)));
      expect(e.class).toBe('network');
      expect(hits).toBe(1);
    } finally {
      server.close();
    }
  });
});


// L0-03 retry loop. Real waits are used (computeBackoffMs has no seam): keep attempts low and prefer the fail-now paths.
const synth = (status: number, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): Response =>
  syntheticResponse(status, JSON.stringify({ error: { message: `status ${status}`, code: status, ...extra } }), headers);
function retryOpts(fetchImpl: GlobalFetch, maxAttempts: number, timeoutMs = 20_000) {
  const deadline = createDeadline({ timeoutMs });
  deadlines.push(deadline);
  return { key: KEY, deadline, maxAttempts, fetchImpl };
}

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-10-09T12:00:00Z');
  const h = (o: Record<string, string>) => new Headers(o);
  it('synthetic E05: retry-after-ms wins over Retry-After', () => {
    expect(parseRetryAfter(h({ 'retry-after-ms': '1500', 'retry-after': '30' }), now)).toBe(1500);
  });
  it('synthetic: Retry-After integer seconds', () => expect(parseRetryAfter(h({ 'retry-after': '7' }), now)).toBe(7000));
  it('synthetic: Retry-After HTTP-date in the future', () => {
    expect(parseRetryAfter(h({ 'retry-after': 'Fri, 09 Oct 2026 12:00:09 GMT' }), now)).toBe(9000);
  });
  it('synthetic E03: Retry-After HTTP-date in the past gives 0', () => {
    expect(parseRetryAfter(h({ 'retry-after': 'Fri, 09 Oct 2026 11:00:00 GMT' }), now)).toBe(0);
  });
  it('synthetic: garbage, negative, fractional and absent values give 0', () => {
    for (const v of ['soon', '-5', '1.5', '5 apples', '']) expect(parseRetryAfter(h({ 'retry-after': v }), now)).toBe(0);
    expect(parseRetryAfter(h({ 'retry-after-ms': 'x' }), now)).toBe(0);
    expect(parseRetryAfter(h({}), now)).toBe(0);
  });
});

describe('clampAttempts', () => {
  it('clamps to 1..6 and truncates', () => {
    expect([0, -3, 1, 3, 6, 99, 2.9].map(clampAttempts)).toEqual([1, 1, 1, 3, 6, 6, 2]);
  });
  it('NaN is refused, not defaulted', () => expect(() => clampAttempts(Number.NaN)).toThrow(RangeError));
});

describe('callDecisions retry loop', () => {
  it('a non-retryable real P-01 401 is thrown on the first failure with no wait, whatever max_attempts is', async () => {
    const r = replayFetch([fixture('dec-err401')]);
    const t0 = Date.now();
    const e = await failure(callDecisions(call, retryOpts(r.fetch, 6)));
    expect(e.class).toBe('auth');
    expect(r.calls).toHaveLength(1);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('synthetic: max_attempts below 1 still sends once', async () => {
    const r = replayFetch([synth(503)]);
    const e = await failure(callDecisions(call, retryOpts(r.fetch, 0)));
    expect(e.class).toBe('unavailable');
    expect(r.calls).toHaveLength(1);
  });

  it('synthetic: a 503 is retried, the failed body is drained before the next send, then the real reply is returned', async () => {
    const failed = synth(503);
    const drained: boolean[] = [];
    const inner = replayFetch([failed, fixture('dec-choice2')]);
    const spy: GlobalFetch = (url, init) => {
      drained.push(failed.bodyUsed);
      return inner.fetch(url, init);
    };
    const reply = await callDecisions(call, retryOpts(spy, 2));
    expect(reply.model).toBe('typesafe/jev-1.13-20260917');
    expect(inner.calls).toHaveLength(2);
    expect(drained).toEqual([false, true]);
  });

  it('synthetic: attempts are used up, then the last error is thrown', async () => {
    const r = replayFetch([synth(503), synth(503)]);
    const e = await failure(callDecisions(call, retryOpts(r.fetch, 2)));
    expect(e.class).toBe('unavailable');
    expect(r.calls).toHaveLength(2);
  });

  it('synthetic E06: 402 in-flight budget is retried; 402 credits is not', async () => {
    const inflight = replayFetch([synth(402, { limit_source: 'openrouter_in_flight_budget' }), fixture('dec-choice2')]);
    await callDecisions(call, retryOpts(inflight.fetch, 2));
    expect(inflight.calls).toHaveLength(2);
    const credits = replayFetch([synth(402, { message: 'Insufficient credits' })]);
    const e = await failure(callDecisions(call, retryOpts(credits.fetch, 3)));
    expect(e.class).toBe('payment');
    expect(credits.calls).toHaveLength(1);
  });

  it('synthetic: retry-after-ms longer than the backoff is waited in full', async () => {
    const r = replayFetch([synth(429, {}, { 'retry-after-ms': '2000' }), fixture('dec-choice2')]);
    const t0 = Date.now();
    await callDecisions(call, retryOpts(r.fetch, 2));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1990);
  });

  it('synthetic E04: a Retry-After beyond the deadline fails now as rate-limited with the wait reported', async () => {
    const r = replayFetch([synth(429, {}, { 'retry-after': '120' })]);
    const t0 = Date.now();
    const e = await failure(callDecisions(call, retryOpts(r.fetch, 3, 5000)));
    expect(e.class).toBe('rate-limited');
    expect(e.status).toBe(429);
    expect(e.message).toContain('120000 ms');
    expect(r.calls).toHaveLength(1);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('synthetic: the retry set is 408, 409, 429, 500-599; every other status is thrown as classified', async () => {
    for (const status of [408, 409, 429, 500, 524, 529, 599]) {
      const e = await failure(callDecisions(call, retryOpts(replayFetch([synth(status, {}, { 'retry-after': '120' })]).fetch, 3, 5000)));
      expect(e.class, `status ${status}`).toBe('rate-limited');
    }
    for (const status of [400, 401, 403, 404, 413]) {
      const r = replayFetch([synth(status, {}, { 'retry-after': '120' })]);
      const e = await failure(callDecisions(call, retryOpts(r.fetch, 3, 5000)));
      expect(e.class, `status ${status}`).not.toBe('rate-limited');
      expect(r.calls).toHaveLength(1);
    }
  });

  it('synthetic E09: a connection reset is thrown at once, not retried, and says the call may have been billed', async () => {
    let n = 0;
    const reset: GlobalFetch = async () => {
      n++;
      throw new TypeError('fetch failed: ECONNRESET');
    };
    const e = await failure(callDecisions(call, retryOpts(reset, 3)));
    expect(e.class).toBe('network');
    expect(e.retryable).toBe(false);
    expect(e.message).toMatch(/may have been billed/);
    expect(n).toBe(1);
  });

  it('a timeout is thrown at once, not retried, and says the call may have been billed', async () => {
    let n = 0;
    const hang: GlobalFetch = (_url, init) =>
      new Promise((_ok, no) => {
        n++;
        init.signal?.addEventListener('abort', () => no(init.signal?.reason));
      });
    const e = await failure(callDecisions(call, retryOpts(hang, 3, 150)));
    expect(e.class).toBe('timeout');
    expect(e.message).toMatch(/may have been billed/);
    expect(n).toBe(1);
  });
});

describe('callDecisions parseReply (the winning body is parsed once, by the caller\'s parser)', () => {
  it('returns what parseReply returns, from the same text', async () => {
    const rec = fixture('dec-noul');
    const raw = await callDecisions(call, { ...opts(replayFetch([rec]).fetch), parseReply: (text) => ({ ...(JSON.parse(text) as object), model: 'parsed-by-caller' }) as never });
    expect(raw.model).toBe('parsed-by-caller');
  });
  it('a ClassifierError thrown by parseReply reaches the caller unchanged (not relabeled as invalid JSON)', async () => {
    const boom = new ClassifierError({ class: 'bad-response', message: 'my own refusal', retryable: false });
    await expect(callDecisions(call, { ...opts(replayFetch([fixture('dec-noul')]).fetch), parseReply: () => { throw boom; } })).rejects.toBe(boom);
  });
  it('a SyntaxError from parseReply (JSON.parse) is labeled "reply is not valid JSON" (bad-response)', async () => {
    const err = await callDecisions(call, { ...opts(replayFetch([fixture('dec-noul')]).fetch), parseReply: (t) => JSON.parse(`${t}}`) as never }).then(() => undefined, (e: unknown) => e as ClassifierError);
    expect(err).toBeInstanceOf(ClassifierError);
    expect(err!.class).toBe('bad-response');
    expect(err!.message).toMatch(/reply is not valid JSON/);
  });
  it('review 2: with maxAttempts 3 a parser TypeError causes exactly ONE fetch and the same TypeError out (the retry loop never reads .retryable)', async () => {
    const bug = new TypeError('parser bug');
    const f = replayFetch([fixture('dec-noul'), fixture('dec-noul'), fixture('dec-noul')]);
    await expect(callDecisions(call, { ...opts(f.fetch), maxAttempts: 3, parseReply: () => { throw bug; } })).rejects.toBe(bug);
    expect(f.calls).toHaveLength(1);
  });
  it('any other error from parseReply is a programming error and propagates unchanged', async () => {
    const bug = new TypeError('cannot read properties of undefined');
    await expect(callDecisions(call, { ...opts(replayFetch([fixture('dec-noul')]).fetch), parseReply: () => { throw bug; } })).rejects.toBe(bug);
  });
});
