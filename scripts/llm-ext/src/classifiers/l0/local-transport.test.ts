import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createDeadline, type Deadline } from './deadline.js';
import { ClassifierError } from './errors.js';
import { callLocalDecisions, TRUNCATED_HEADER, type LocalDecisionsCall } from './local-transport.js';

/**
 * The LOCAL sender's wire contract: no credential leaves this machine, the decider's own 422 text survives,
 * and a truncated answer is a refused answer. Every case runs against a REAL node:http server: the point of
 * the file is what goes over the socket, so a fetch double would assert nothing.
 */

const REPLY = {
  model: 'elephant-1',
  answers: { team: { p: 0.9 } },
  usage: { input_tokens: 12, output_tokens: 3 },
};

const call: LocalDecisionsCall = {
  model: 'elephant-1',
  state: { ticket: 'My checkout page shows a blank screen after I click Pay.' },
  questions: { team: { type: 'choice', instructions: 'Which category fits?', criteria: { opt0: 'a', opt1: 'b' } } },
};

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

const servers: Server[] = [];
const deadlines: Deadline[] = [];
afterEach(async () => {
  deadlines.splice(0).forEach((d) => d.dispose());
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => resolve());
        }),
    ),
  );
});

/** A real loopback decider that records the request and answers with the given handler. */
async function serve(
  handler: (seen: Seen, res: import('node:http').ServerResponse) => void,
): Promise<{ baseUrl: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      const entry: Seen = { url: req.url ?? '', method: req.method ?? '', headers: req.headers, body };
      seen.push(entry);
      handler(entry, res);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (typeof addr !== 'object' || addr === null) throw new Error('server address unavailable');
  return { baseUrl: `http://127.0.0.1:${addr.port}`, seen };
}

function opts(baseUrl: string, timeoutMs = 5000) {
  const deadline = createDeadline({ timeoutMs });
  deadlines.push(deadline);
  return { baseUrl, deadline, fetchImpl: fetch as (url: string, init: RequestInit) => Promise<Response> };
}

async function failure(p: Promise<unknown>): Promise<ClassifierError> {
  const e = await p.then(
    () => undefined,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(ClassifierError);
  return e as ClassifierError;
}

describe('callLocalDecisions request shape', () => {
  it('POSTs to /v1/systemone with ONLY Content-Type, and no Authorization header at all', async () => {
    const { baseUrl, seen } = await serve((_s, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(REPLY));
    });
    const { reply } = await callLocalDecisions(call, opts(baseUrl));
    expect(reply).toEqual(REPLY);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('/v1/systemone');
    expect(seen[0].method).toBe('POST');
    expect(seen[0].headers['content-type']).toBe('application/json');
    // The CREDENTIAL header is what must never appear, in any spelling, and neither attribution header of
    // the remote sender (l0/transport.ts) may ride along: the local decider has no use for either.
    const names = Object.keys(seen[0].headers).map((k) => k.toLowerCase());
    expect(names).not.toContain('authorization');
    expect(names).not.toContain('http-referer');
    expect(names).not.toContain('x-openrouter-title');
    expect(names.filter((n) => n.startsWith('x-') || n.includes('auth') || n.includes('referer'))).toEqual([]);
    expect(JSON.parse(seen[0].body)).toEqual({ model: call.model, state: call.state, questions: call.questions });
  });

  it('a base url with a trailing slash does not double it', async () => {
    const { baseUrl, seen } = await serve((_s, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(REPLY));
    });
    await callLocalDecisions(call, opts(`${baseUrl}/`));
    expect(seen[0].url).toBe('/v1/systemone');
  });

  it('a state carrying a key-shaped string is sent as is: the local decider has no key to leak', async () => {
    const { baseUrl, seen } = await serve((_s, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(REPLY));
    });
    const state = { note: 'token sk-abcdefgh12345678 was rotated' };
    await callLocalDecisions({ ...call, state }, opts(baseUrl));
    expect(JSON.parse(seen[0].body).state).toEqual(state);
  });
});

describe('callLocalDecisions failure mapping', () => {
  it('X-MLX-Decision-Truncated: true is bad-response with the stated message, even with a parseable body', async () => {
    const { baseUrl } = await serve((_s, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', [TRUNCATED_HEADER]: 'true' });
      res.end(JSON.stringify(REPLY));
    });
    const e = await failure(callLocalDecisions(call, opts(baseUrl)));
    expect(e.class).toBe('bad-response');
    expect(e.message).toBe('the local decider truncated the state; the answer would be incomplete');
    expect(e.retryable).toBe(false);
  });

  it('a truncation header of any other value does not refuse the reply', async () => {
    const { baseUrl } = await serve((_s, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', [TRUNCATED_HEADER]: 'false' });
      res.end(JSON.stringify(REPLY));
    });
    const { reply } = await callLocalDecisions(call, opts(baseUrl));
    expect(reply).toEqual(REPLY);
  });

  it('a 422 becomes bad-request carrying the server text with its token counts', async () => {
    const serverText = 'state needs 18000 input tokens but the limit is 16384';
    const { baseUrl } = await serve((_s, res) => {
      res.writeHead(422, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: serverText } }));
    });
    const e = await failure(callLocalDecisions(call, opts(baseUrl)));
    expect(e.class).toBe('bad-request');
    expect(e.status).toBe(422);
    // EXACT: the numbers are the whole point of the explicit mapping, so the text must survive verbatim.
    expect(e.message).toBe(serverText);
    expect(e.message).toContain('18000');
    expect(e.message).toContain('16384');
    expect(e.retryable).toBe(false);
  });

  it('a 422 with a plain-text body keeps that text too', async () => {
    const { baseUrl } = await serve((_s, res) => {
      res.writeHead(422, { 'Content-Type': 'text/plain' });
      res.end('required 9000 tokens, limit 8000');
    });
    const e = await failure(callLocalDecisions(call, opts(baseUrl)));
    expect(e.class).toBe('bad-request');
    expect(e.message).toBe('required 9000 tokens, limit 8000');
  });

  it('any other non-2xx goes through the shared classifier (500 is unavailable and retryable)', async () => {
    const { baseUrl } = await serve((_s, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'boom' } }));
    });
    const e = await failure(callLocalDecisions(call, opts(baseUrl)));
    expect(e.class).toBe('unavailable');
    expect(e.status).toBe(500);
    expect(e.retryable).toBe(true);
  });

  it('an unreachable decider is a network error', async () => {
    // A port nothing listens on: bind then close, so the number is real but free.
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const addr = probe.address() as { port: number };
    await new Promise<void>((r) => probe.close(() => r()));
    const deadline = createDeadline({ timeoutMs: 5000 });
    deadlines.push(deadline);
    const e = await failure(
      callLocalDecisions(call, { baseUrl: `http://127.0.0.1:${addr.port}`, deadline, fetchImpl: fetch }),
    );
    expect(e.class).toBe('network');
  });

  it('a 200 with a non-JSON body is bad-response', async () => {
    const { baseUrl } = await serve((_s, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html>proxy page</html>');
    });
    const e = await failure(callLocalDecisions(call, opts(baseUrl)));
    expect(e.class).toBe('bad-response');
    expect(e.message).toBe('reply is not valid JSON');
  });
});

describe("callLocalDecisions 422 token counts (TRDD-1L9VMEY7)", () => {
  it("the measured decider text gives needed_tokens 16460 and limit_tokens 16384, message verbatim", async () => {
    const serverText = "the question with its state needs 16460 tokens; the limit is 16384 and input is not cut";
    const { baseUrl } = await serve((_s, res) => {
      res.writeHead(422, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: serverText } }));
    });
    const e = await failure(callLocalDecisions(call, opts(baseUrl)));
    expect(e.status).toBe(422);
    expect(e.message).toBe(serverText);
    expect(e.needed_tokens).toBe(16460);
    expect(e.limit_tokens).toBe(16384);
    expect(e.retryable).toBe(false);
  });

  it("a 422 whose text has no counts keeps the old behaviour: no fields, message verbatim", async () => {
    const { baseUrl } = await serve((_s, res) => {
      res.writeHead(422, { "Content-Type": "text/plain" });
      res.end("required 9000 tokens, limit 8000");
    });
    const e = await failure(callLocalDecisions(call, opts(baseUrl)));
    expect(e.message).toBe("required 9000 tokens, limit 8000");
    expect(e.needed_tokens).toBeUndefined();
    expect(e.limit_tokens).toBeUndefined();
  });
});
