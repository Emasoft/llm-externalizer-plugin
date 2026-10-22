import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { collectInputs, readForJev, isSecretPath, HARD_MAX_BYTES, InputError } from './inputs.js';

// /tmp (not os.tmpdir()): sanitizeInputPath only allows cwd, HOME and /tmp.
const made: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join('/tmp', 'llm-ext-inputs-'));
  made.push(d);
  return d;
}
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

function put(dir: string, rel: string, content: string | Buffer): string {
  const p = join(dir, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
  return p;
}
const reasons = (c: { skipped: { path: string; reason: string }[] }): string[] =>
  c.skipped.map((s) => `${s.path}|${s.reason}`);
const ids = (c: { items: { id: string }[] }): string[] => c.items.map((i) => i.id).sort();

describe('readForJev named single input', () => {
  it('whole mode returns the text and its line count', async () => {
    const f = put(tmp(), 'a.txt', 'one\ntwo\nthree\n');
    const s = await readForJev(f, { kind: 'whole' });
    expect(s.text).toBe('one\ntwo\nthree\n');
    expect(s.totalLines).toBe(3);
  });

  it('E38: CRLF and BOM file gives correct line windows and no BOM', async () => {
    const f = put(tmp(), 'crlf.txt', '﻿a\r\nb\r\nc\r\n');
    const s = await readForJev(f, { kind: 'lines', from: 2, to: 3 });
    expect(s.text).toBe('b\nc');
    expect(s.fromLine).toBe(2);
    expect(s.toLine).toBe(3);
    expect((await readForJev(f, { kind: 'whole' })).text.startsWith('a\n')).toBe(true);
  });

  it('E39: invalid UTF-8 becomes U+FFFD with a warning', async () => {
    const f = put(tmp(), 'bad.txt', Buffer.from([0x61, 0xff, 0x62, 0x0a]));
    const s = await readForJev(f, { kind: 'whole' });
    expect(s.text).toContain('a�b');
    expect(s.warnings.join(' ')).toMatch(/invalid UTF-8/);
  });

  it('E40: an empty file is refused as empty input', async () => {
    const f = put(tmp(), 'empty.txt', '  \n');
    await expect(readForJev(f, { kind: 'whole' })).rejects.toThrow(/empty input/);
  });

  it('E41: a directory given where one file is expected is refused', async () => {
    await expect(readForJev(tmp(), { kind: 'whole' })).rejects.toThrow(/directory/);
  });

  it('E33: a binary file (NUL in the first 8 KB) is refused when named', async () => {
    const f = put(tmp(), 'b.dat', Buffer.from([0x61, 0x00, 0x62]));
    await expect(readForJev(f, { kind: 'whole' })).rejects.toThrow(/binary/);
  });

  it('E36/E124: a named secret file is refused', async () => {
    const d = tmp();
    for (const n of ['.env', '.env.local', 'id_rsa', 'server.pem', 'credentials', 'creds/kubeconfig', 'x.tfstate']) {
      const f = put(d, n, 'SECRET=1\n');
      await expect(readForJev(f, { kind: 'whole' })).rejects.toThrow(/secret/);
    }
  });

  it('E125: over --max-bytes is refused; a max above the 100 MB hard cap is rejected', async () => {
    const f = put(tmp(), 'big.txt', 'x'.repeat(100));
    await expect(readForJev(f, { kind: 'whole' }, { maxBytes: 50 })).rejects.toThrow(/over 50 bytes/);
    await expect(readForJev(f, { kind: 'whole' }, { maxBytes: HARD_MAX_BYTES + 1 })).rejects.toThrow(/hard cap/);
  });

  it('E35: a path outside the allowed roots is refused by sanitizeInputPath', async () => {
    await expect(readForJev('/etc/hosts', { kind: 'whole' })).rejects.toThrow(/Path traversal blocked/);
  });

  it('E35/E122: a named symlink is refused', async () => {
    const d = tmp();
    const t = put(d, 'real.txt', 'hi\n');
    symlinkSync(t, join(d, 'link.txt'));
    await expect(readForJev(join(d, 'link.txt'), { kind: 'whole' })).rejects.toThrow(/Symlink rejected/);
  });

  it('head mode cuts at a character boundary, never inside a multi-byte character', async () => {
    const f = put(tmp(), 'u.txt', 'aé€b'); // bytes: a(1) é(2) €(3) b(1)
    expect((await readForJev(f, { kind: 'head', bytes: 2 }, {})).text).toBe('a');
    expect((await readForJev(f, { kind: 'head', bytes: 3 }, {})).text).toBe('aé');
    expect((await readForJev(f, { kind: 'head', bytes: 100 }, {})).text).toBe('aé€b');
  });

  it('window mode clamps to the file and lines mode rejects a start past the end', async () => {
    const f = put(tmp(), 'w.txt', '1\n2\n3\n4\n5\n');
    const w = await readForJev(f, { kind: 'window', line: 1, radius: 2 });
    expect(w.text).toBe('1\n2\n3');
    expect(w.fromLine).toBe(1);
    expect(w.toLine).toBe(3);
    await expect(readForJev(f, { kind: 'lines', from: 9, to: 10 })).rejects.toThrow(/beyond/);
    await expect(readForJev(f, { kind: 'lines', from: 3, to: 2 })).rejects.toThrow(/invalid line range/);
  });
});

describe('isSecretPath', () => {
  it('matches credential-style names and leaves ordinary files alone', () => {
    for (const p of ['/a/.env', '/a/.env.production', '/a/id_ed25519.pub', '/a/k.p12', '/a/.docker/config.json', '/a/service-account-x.json', '/a/secrets.yaml', '/a/.npmrc'])
      expect(isSecretPath(p), p).toBe(true);
    for (const p of ['/a/environment.ts', '/a/keyboard.ts', '/a/readme.md'])
      expect(isSecretPath(p), p).toBe(false);
  });
});

describe('collectInputs walking', () => {
  it('E119: inside a git repo it lists git ls-files -co --exclude-standard', async () => {
    const d = tmp();
    execFileSync('git', ['init', '-q'], { cwd: d });
    put(d, '.gitignore', 'ignored.txt\n');
    put(d, 'kept.txt', 'k\n');
    put(d, 'ignored.txt', 'i\n');
    put(d, 'node_modules/x.js', 'n\n'); // inside git only .gitignore decides, not the skip list
    const c = await collectInputs([d]);
    expect(ids(c).map((i) => i.split('/').pop())).toEqual(['.gitignore', 'kept.txt', 'node_modules/x.js'.split('/').pop()]);
    expect(ids(c).some((i) => i.endsWith('ignored.txt'))).toBe(false);
  });

  it('E119: an empty git listing sends nothing and does not fall back to walking', async () => {
    const d = tmp();
    execFileSync('git', ['init', '-q'], { cwd: d });
    put(d, '.gitignore', '*\n');
    put(d, 'a.txt', 'a\n');
    const c = await collectInputs([d]);
    expect(c.items).toEqual([]);
  });

  it('E120: outside git it skips build and dependency dirs and dot-directories but keeps dot-files', async () => {
    const d = tmp();
    put(d, 'src/a.ts', 'a\n');
    put(d, '.eslintrc', 'e\n');
    put(d, 'node_modules/p/i.js', 'n\n');
    put(d, 'dist/o.js', 'o\n');
    put(d, '.cache/c.txt', 'c\n');
    const c = await collectInputs([d]);
    const tails = ids(c).map((i) => i.split('/').pop());
    expect(tails.sort()).toEqual(['.eslintrc', 'a.ts']);
  });

  it('E121: a glob on Node below 22 is refused with "pass a directory instead"', async () => {
    await expect(collectInputs(['/tmp/*.txt'], { nodeMajor: 20 })).rejects.toThrow(/pass a directory instead/);
  });

  it.skipIf(Number(process.versions.node.split('.')[0]) < 22)('a glob expands to its files on Node 22+', async () => {
    const d = tmp();
    put(d, 'a.txt', 'a\n');
    put(d, 'b.md', 'b\n');
    const c = await collectInputs([join(d, '*.txt')]);
    expect(ids(c).map((i) => i.split('/').pop())).toEqual(['a.txt']);
  });

  it('E122: a symlink is skipped and listed unless --follow-symlinks', async () => {
    const d = tmp();
    put(d, 'real.txt', 'r\n');
    symlinkSync(join(d, 'real.txt'), join(d, 'link.txt'));
    const c = await collectInputs([d]);
    expect(ids(c).map((i) => i.split('/').pop())).toEqual(['real.txt']);
    expect(reasons(c).some((r) => r.includes('link.txt') && r.includes('symlink'))).toBe(true);
  });

  it('E122: when followed, the target is secret-checked and a directory loop terminates', async () => {
    const d = tmp();
    put(d, 'sub/a.txt', 'a\n');
    const outside = put(tmp(), 'id_rsa', 'KEY\n'); // target not in the walked tree: only the target check can catch it
    symlinkSync(outside, join(d, 'notes.txt'));
    symlinkSync(d, join(d, 'sub', 'loop'));
    const c = await collectInputs([d], { followSymlinks: true });
    expect(ids(c).map((i) => i.split('/').pop())).toEqual(['a.txt']);
    expect(reasons(c).some((r) => r.includes('notes.txt') && r.includes('secret'))).toBe(true);
  });

  it('E124/E36: a secret found while walking is skipped and listed', async () => {
    const d = tmp();
    put(d, 'a.txt', 'a\n');
    put(d, '.env', 'X=1\n');
    put(d, 'k.pem', 'K\n');
    const c = await collectInputs([d]);
    expect(ids(c).map((i) => i.split('/').pop())).toEqual(['a.txt']);
    expect(reasons(c).filter((r) => r.includes('secret')).length).toBe(2);
  });

  it('E123/E33: lock, minified, source-map, empty and binary files are skipped and listed', async () => {
    const d = tmp();
    put(d, 'a.txt', 'a\n');
    put(d, 'package-lock.json', '{}\n');
    put(d, 'app.min.js', 'x\n');
    put(d, 'app.js.map', '{}\n');
    put(d, 'empty.txt', '');
    put(d, 'bin.dat', Buffer.from([1, 0, 2]));
    const c = await collectInputs([d]);
    expect(ids(c).map((i) => i.split('/').pop())).toEqual(['a.txt']);
    const r = reasons(c).join('\n');
    expect(r).toMatch(/package-lock\.json\|lock/);
    expect(r).toMatch(/app\.min\.js\|minified/);
    expect(r).toMatch(/app\.js\.map\|source map/);
    expect(r).toMatch(/empty\.txt\|empty/);
    expect(r).toMatch(/bin\.dat\|binary/);
  });

  it('E125: a walked file over --max-bytes is skipped and listed', async () => {
    const d = tmp();
    put(d, 'small.txt', 'ok\n');
    put(d, 'large.txt', 'x'.repeat(500));
    const c = await collectInputs([d], { maxBytes: 100 });
    expect(ids(c).map((i) => i.split('/').pop())).toEqual(['small.txt']);
    expect(reasons(c).some((r) => r.includes('large.txt') && r.includes('over 100 bytes'))).toBe(true);
  });

  it('--ext keeps only the listed extensions and --lines makes one item per non-empty line', async () => {
    const d = tmp();
    put(d, 'a.ts', 'x\n\ny\n');
    put(d, 'b.md', 'z\n');
    const c = await collectInputs([d], { ext: 'ts', lines: true });
    expect(c.items.map((i) => i.text)).toEqual(['x', 'y']);
    expect(c.items.map((i) => i.id.split(':').pop())).toEqual(['1', '3']);
  });

  it('E126: more items than --limit is refused', async () => {
    const d = tmp();
    put(d, 'a.txt', '1\n2\n3\n');
    await expect(collectInputs([d], { lines: true, limit: 2 })).rejects.toThrow(/more than 2 items/);
  });

  it('a missing path is refused', async () => {
    await expect(collectInputs(['/tmp/llm-ext-inputs-does-not-exist'])).rejects.toThrow(/no such file or directory/);
  });
});

describe('collectInputs --items and stdin', () => {
  it('E127: an --items line starting { that is not valid JSON is refused naming the line', async () => {
    const f = put(tmp(), 'items.jsonl', 'plain\n{"id":"a","text":"t"}\n{broken\n');
    await expect(collectInputs([], { items: f })).rejects.toThrow(/--items line 3/);
  });

  it('--items accepts plain lines and {id,text} objects', async () => {
    const f = put(tmp(), 'items.jsonl', 'plain\n{"id":"a","text":"t"}\n');
    const c = await collectInputs([], { items: f });
    expect(c.items).toEqual([{ id: '1', text: 'plain' }, { id: 'a', text: 't' }]);
  });

  it('E124/E41/E40: an --items path that is a secret, a directory or empty is refused', async () => {
    const d = tmp();
    await expect(collectInputs([], { items: put(d, '.env', 'a\n') })).rejects.toThrow(/secret/);
    await expect(collectInputs([], { items: d })).rejects.toThrow(/directory/);
    await expect(collectInputs([], { items: put(d, 'e.jsonl', '') })).rejects.toThrow(/empty input/);
  });

  it('stdin: "-" reads the supplied bytes; over the cap, binary or empty stdin is refused', async () => {
    const c = await collectInputs(['-'], { stdin: Buffer.from('hello\n') });
    expect(c.items).toEqual([{ id: 'stdin', text: 'hello\n' }]);
    await expect(collectInputs(['-'], { stdin: Buffer.from('x'.repeat(50)), maxBytes: 10 })).rejects.toThrow(/stdin is over 10 bytes/);
    await expect(collectInputs(['-'], { stdin: Buffer.from([0x61, 0, 0x62]) })).rejects.toThrow(/binary/);
    await expect(collectInputs(['-'], { stdin: Buffer.from(' \n') })).rejects.toThrow(/empty input/);
  });

  it('stdin with --lines gives one item per non-empty line', async () => {
    const c = await collectInputs(['-'], { stdin: Buffer.from('a\r\n\r\nb\n'), lines: true });
    expect(c.items).toEqual([{ id: 'stdin:1', text: 'a' }, { id: 'stdin:3', text: 'b' }]);
  });
});

describe('review fixes F1-F9', () => {
  const node22 = Number(process.versions.node.split('.')[0]) >= 22;

  it.skipIf(!node22)('F1: a glob whose static prefix is outside the allowed roots is refused like a named path', async () => {
    for (const g of ['/etc/*.conf', '/*', '../'.repeat(30) + 'etc/*.conf']) {
      await expect(collectInputs([g]), g).rejects.toThrow(/Path traversal blocked/);
    }
  });

  it.skipIf(!node22)('F1: a file a glob reaches through a link to outside the roots is refused', async () => {
    const d = tmp();
    symlinkSync('/etc', join(d, 'lnk'));
    // l[n]k keeps the static prefix inside the roots, so only the per-file check can catch /etc/hosts
    await expect(collectInputs([join(d, 'l[n]k', 'hosts')])).rejects.toThrow(/Path traversal blocked/);
  });

  it('F2: the claude-jev deny names are refused alongside the quicksilver ones', () => {
    for (const p of ['/a/.aws/config', '/a/.ssh/known_hosts', '/a/.gnupg/pubring.kbx', '/a/.git/config', '/a/.gcloud/x.json',
      '/a/credentials.xml', '/a/credential', '/a/.credentials', '/a/my-secrets.json', '/a/secret.ini', '/a/secrets.env'])
      expect(isSecretPath(p), p).toBe(true);
    for (const p of ['/a/.github/workflows/ci.yml', '/a/gitignore.txt', '/a/secretary.json'])
      expect(isSecretPath(p), p).toBe(false);
  });

  it('F3: a repository git cannot read fails with the git error instead of walking past .gitignore', async () => {
    const d = tmp();
    execFileSync('git', ['init', '-q'], { cwd: d });
    put(d, 'a.txt', 'a\n');
    writeFileSync(join(d, '.git', 'HEAD'), 'garbage\n'); // git now answers "not a git repository" although .git exists
    const err = await collectInputs([d]).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(InputError);
    expect((err as Error).message).toMatch(/git ls-files failed/);
    expect((err as Error).message).toMatch(/not a git repository/);
  });

  it('F4: head mode line fields drop the trailing newline exactly like whole mode', async () => {
    const f = put(tmp(), 'h.txt', 'a\nb\n');
    const all = await readForJev(f, { kind: 'head', bytes: 100 });
    expect([all.fromLine, all.toLine, all.totalLines]).toEqual([1, 2, 2]);
    const part = await readForJev(f, { kind: 'head', bytes: 2 });
    expect([part.text, part.fromLine, part.toLine, part.totalLines]).toEqual(['a\n', 1, 1, 2]);
  });

  it('F5: every refusal of a named path is an InputError with the sanitizeInputPath message', async () => {
    const d = tmp();
    const t = put(d, 'real.txt', 'hi\n');
    symlinkSync(t, join(d, 'link.txt'));
    for (const p of ['/etc/hosts', join(d, 'link.txt')]) {
      const err = await readForJev(p, { kind: 'whole' }).then(() => null, (e: unknown) => e);
      expect(err, p).toBeInstanceOf(InputError);
      expect((err as Error).message).toMatch(/Path traversal blocked|Symlink rejected/);
    }
    await expect(collectInputs(['/etc/hosts'])).rejects.toBeInstanceOf(InputError);
  });

  it('F6: a FIFO named as an input is refused before any read', async () => {
    const p = join(tmp(), 'pipe');
    execFileSync('mkfifo', [p]);
    await expect(readForJev(p, { kind: 'whole' })).rejects.toThrow(/not a regular file/);
  }, 3000);

  it('F7: --limit must be a positive integer', async () => {
    const d = tmp();
    put(d, 'a.txt', '1\n');
    for (const limit of [Number.NaN, 0, -3, 1.5]) {
      await expect(collectInputs([d], { limit }), String(limit)).rejects.toThrow(/--limit must be a positive integer/);
    }
  });

  it('F9: file and directory names with spaces, non-ASCII characters and brackets are read, not globbed', async () => {
    const d = tmp();
    put(d, 'my dir/é ü 日本.txt', 'a\n');
    put(d, '[draft] notes/a{1}.txt', 'b\n');
    put(d, 'plain/[x] r?.txt', 'c\n');
    const walked = await collectInputs([join(d, '[draft] notes')]);
    expect(walked.items.map((i) => i.text)).toEqual(['b\n']);
    const named = await collectInputs([join(d, 'plain', '[x] r?.txt'), join(d, 'my dir')]);
    expect(named.items.map((i) => i.text).sort()).toEqual(['a\n', 'c\n']);
    expect((await readForJev(join(d, 'my dir', 'é ü 日本.txt'), { kind: 'whole' })).text).toBe('a\n');
  });

  it('F9: the same names survive the git listing', async () => {
    const d = tmp();
    execFileSync('git', ['init', '-q'], { cwd: d });
    put(d, 'sp ace/é.txt', 'a\n');
    put(d, '[b] r.txt', 'b\n');
    const c = await collectInputs([d]);
    expect(c.items.map((i) => i.text).sort()).toEqual(['a\n', 'b\n']);
  });
});
