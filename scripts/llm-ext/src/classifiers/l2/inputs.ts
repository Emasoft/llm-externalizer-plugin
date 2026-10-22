// L2-06: file/stdin/--items input rules for Jev commands (quicksilver 0.3.0 qs.mjs:27-48, 640-783 ported).
// This file is the only owner of the secret-path deny list and the input walk rules (plan section 4).
import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { sanitizeInputPath } from "../../scan-pipeline.js";
import { redactContent } from "./content-redact.js";
import { InputError } from "./input-error.js";

export { InputError };

// Why 100 MB: qs keeps one huge input from hanging the machine; the cap cannot be raised, --max-bytes can only lower it.
export const HARD_MAX_BYTES = 100 * 1024 * 1024;
export const DEFAULT_LIMIT = 5000;
const BINARY_SNIFF_BYTES = 8192;

// Deny list = quicksilver 0.3.0 SECRET_RE merged with buchmark/claude-jev FORBIDDEN (MIT, commit 06fe407f2894bc5c44f2dfc41e05d3592e5215a5,
// src/infrastructure/fs-source-reader.ts). claude-jev matches path segments, so its credential directories live in SECRET_DIR_RE and its wider
// credentials / secrets name families replace qs's narrower ones here.
const SECRET_RE = /(^|[/\\])(\.env(\..*)?|\.envrc|.*\.(pem|key|p12|pfx|keystore|jks|crt|cer|p8|ppk|kdbx|ovpn|gpg|tfvars|tfstate(\.backup)?)|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.pgpass|\.htpasswd|\.dockercfg|kubeconfig|\.docker[/\\]config\.json|service-account[^/\\]*\.json|\.?credentials?(\..+)?|([^/\\]*[.\-_])?secrets?\.(json|ya?ml|toml|ini|txt|env|conf|cfg))$/i;
const SECRET_DIR_RE = /(^|[/\\])\.(git|ssh|gnupg|aws|gcloud)([/\\]|$)/i;
const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", ".svelte-kit", "target", "vendor", "__pycache__", ".venv", "venv", "coverage", ".turbo", ".cache", ".idea", ".vscode"]);
const LOCK_RE = /(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|composer\.lock)$/i;
const MINIFIED_RE = /\.min\.(js|css)$/i;
const SOURCEMAP_RE = /\.map$/i;
const GLOB_RE = /[*?[\]{}]/;

export function isSecretPath(p: string): boolean {
  return SECRET_RE.test(p) || SECRET_DIR_RE.test(p);
}

export type ReadMode =
  | { kind: "whole" }
  | { kind: "head"; bytes: number }
  | { kind: "lines"; from: number; to: number }
  | { kind: "window"; line: number; radius: number };

export interface Snippet {
  text: string;
  warnings: string[];
  /** 1-based inclusive line range the text covers (0..0 for an empty head). */
  fromLine: number;
  toLine: number;
  totalLines: number;
}

export interface ReadOptions {
  maxBytes?: number;
  /** Wall-clock budget of one redaction pass in ms; a parameter only so the fail-closed refusal is testable. */
  redactBudgetMs?: number;
}

const fmtBytes = (n: number): string => (n % 1048576 === 0 ? `${n / 1048576} MB` : `${n} bytes`);

function effectiveMax(maxBytes: number | undefined): number {
  if (maxBytes === undefined) return HARD_MAX_BYTES;
  // Why throw: a larger value would silently defeat the hard cap.
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > HARD_MAX_BYTES) {
    throw new InputError(`--max-bytes must be an integer from 1 to ${HARD_MAX_BYTES} (the ${fmtBytes(HARD_MAX_BYTES)} hard cap)`);
  }
  return maxBytes;
}

const isBinary = (buf: Buffer): boolean => buf.subarray(0, BINARY_SNIFF_BYTES).includes(0);

// Why strict-then-lossy: only a failed strict decode means invalid UTF-8; a lossy-only decode could not tell
// a real U+FFFD in the file from a replaced byte. TextDecoder strips a leading BOM by default (E38).
function decode(buf: Buffer, label: string, warnings: string[]): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    warnings.push(`${label}: invalid UTF-8 replaced with U+FFFD`);
    return new TextDecoder("utf-8", { fatal: false }).decode(buf);
  }
}

// Why LF-normalise: a stray \r would sit at the end of every line of a CRLF file and shift nothing but break text equality;
// splitting on \r?\n keeps the line numbers identical to the editor's.
const toLines = (text: string): string[] => text.split(/\r?\n/);

function sliceBytes(buf: Buffer, bytes: number): Buffer {
  if (!Number.isInteger(bytes) || bytes < 1) throw new InputError(`head bytes must be a positive integer, got ${bytes}`);
  let end = Math.min(bytes, buf.length);
  // Why walk back: a cut inside a multi-byte character would turn it into U+FFFD in the request.
  while (end > 0 && end < buf.length && (buf[end]! & 0xc0) === 0x80) end--;
  return buf.subarray(0, end);
}

function applyMode(buf: Buffer, mode: ReadMode, label: string, budgetMs?: number): Snippet {
  const warnings: string[] = [];
  // Why redact the whole text before any slice: a range or head cut inside a PEM block has no BEGIN marker, so the key body would be sent (E37).
  // redactContent keeps the line count, so the caller's line numbers still point at the same lines.
  const red = redactContent(decode(buf, label, warnings).replace(/\r\n/g, "\n"), label, budgetMs);
  if (red.warning) warnings.push(red.warning);
  if (mode.kind === "head") {
    const text = sliceBytes(Buffer.from(red.text, "utf8"), mode.bytes).toString("utf8");
    // Why lineCount: head mode must trim one trailing newline like whole mode ("a\nb\n" is 2 lines, not 3) (F4).
    const lineCount = (t: string): number => toLines(t.endsWith("\n") ? t.slice(0, -1) : t).length;
    const n = text === "" ? 0 : lineCount(text);
    return { text, warnings, fromLine: n ? 1 : 0, toLine: n, totalLines: lineCount(red.text) };
  }
  const whole = red.text;
  const lines = toLines(whole.endsWith("\n") ? whole.slice(0, -1) : whole);
  const total = lines.length;
  if (mode.kind === "whole") return { text: whole, warnings, fromLine: 1, toLine: total, totalLines: total };
  let from: number;
  let to: number;
  if (mode.kind === "lines") {
    from = mode.from;
    to = mode.to;
  } else {
    if (!Number.isInteger(mode.radius) || mode.radius < 0) throw new InputError(`window radius must be a non-negative integer, got ${mode.radius}`);
    from = mode.line - mode.radius;
    to = mode.line + mode.radius;
  }
  if (!Number.isInteger(from) || !Number.isInteger(to) || (mode.kind === "lines" && (from < 1 || to < from))) {
    throw new InputError(`invalid line range ${from}-${to} in ${label}`);
  }
  if (mode.kind === "window" && (mode.line < 1 || mode.line > total)) throw new InputError(`line ${mode.line} is beyond the end of ${label} (${total} lines)`);
  if (from > total) throw new InputError(`line ${from} is beyond the end of ${label} (${total} lines)`);
  from = Math.max(from, 1);
  to = Math.min(to, total);
  return { text: lines.slice(from - 1, to).join("\n"), warnings, fromLine: from, toLine: to, totalLines: total };
}

// Why wrap: sanitizeInputPath throws a plain Error; every refusal of an input must be the same InputError type (F5). The message is kept.
function checkRoot(p: string): string {
  try {
    return sanitizeInputPath(p);
  } catch (e) {
    throw new InputError((e as Error).message);
  }
}

// A file the caller named (--state @f, --items, spec file, --labels-json @f): naming a file is not consent to send a credential,
// and a named input that cannot be used is refused, never skipped (E33, E35, E36, E40, E41, E124, E125).
function readNamed(file: string, maxBytes: number): Buffer {
  // Why exists first: sanitizeInputPath reports a missing /tmp path as traversal (realpath of a missing file is not canonical).
  if (!fs.existsSync(file)) throw new InputError(`no such file: ${file}`);
  const safe = checkRoot(file); // E35: roots and leaf symlink
  const st = fs.statSync(safe);
  if (st.isDirectory()) throw new InputError(`${file} is a directory, not a file`);
  // Why before any read: readFileSync on a FIFO blocks forever waiting for a writer (F6).
  if (!st.isFile()) throw new InputError(`${file} is not a regular file`);
  if (isSecretPath(safe) || isSecretPath(fs.realpathSync(safe))) throw new InputError(`${file} looks like a secret file and is never sent`);
  if (st.size > maxBytes) throw new InputError(`${file} is over ${fmtBytes(maxBytes)}; split it`);
  const buf = fs.readFileSync(safe);
  if (isBinary(buf)) throw new InputError(`${file} is binary (NUL byte in the first ${BINARY_SNIFF_BYTES} bytes) and is never sent`);
  if (!buf.toString("utf8").trim()) throw new InputError(`${file}: empty input`);
  return buf;
}

export async function readForJev(file: string, mode: ReadMode, opts: ReadOptions = {}): Promise<Snippet> {
  return applyMode(readNamed(file, effectiveMax(opts.maxBytes)), mode, file, opts.redactBudgetMs);
}

// ---- walking ----

export interface Skipped {
  path: string;
  reason: string;
}
export interface Item {
  id: string;
  text: string;
}
export interface Collected {
  items: Item[];
  skipped: Skipped[];
  warnings: string[];
}
export interface CollectOptions {
  /** Path of an --items file, or "-" for stdin. */
  items?: string;
  /** Bytes read from stdin by the caller; used by "-" in specs and by items: "-". */
  stdin?: Buffer;
  lines?: boolean;
  /** Comma list such as "ts,tsx". */
  ext?: string;
  followSymlinks?: boolean;
  maxBytes?: number;
  limit?: number;
  /** Node major version; a parameter only so the below-22 glob refusal is testable on a newer Node. */
  nodeMajor?: number;
  /** Wall-clock budget of one redaction pass in ms; a parameter only so the fail-closed paths are testable. */
  redactBudgetMs?: number;
}

// Why a .git ancestor decides: git answers "not a git repository" both outside any repo and for a repo whose .git it cannot read
// (corrupt HEAD); only the first may fall back to a walk, the second would send gitignored files (F3, E119).
function insideGitDir(dir: string): boolean {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, ".git"))) return true;
    if (path.dirname(d) === d) return false;
  }
}

function gitFiles(dir: string): string[] | null {
  try {
    // Why core.fsmonitor=false: the scanned dir's own .git/config is untrusted and could name a program to run.
    const out = execFileSync("git", ["-c", "core.fsmonitor=false", "ls-files", "-co", "--exclude-standard", "-z", "--", "."], {
      cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024,
    });
    return out.split("\0").filter(Boolean).map((f) => path.join(dir, f));
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string };
    if (err.code !== "ENOENT" && /not a git repository/i.test(err.stderr ?? "") && !insideGitDir(dir)) return null; // outside git: walk (E120)
    throw new InputError(`git ls-files failed in ${dir}: ${(err.stderr || err.message).trim()}`);
  }
}

function walk(dir: string, acc: string[], follow: boolean, visited: Set<string>): string[] {
  if (follow) {
    // Why: a followed link can point back up the tree; walking each real directory once ends loops (E122).
    const real = fs.realpathSync(dir);
    if (visited.has(real)) return acc;
    visited.add(real);
  }
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    let isDir = e.isDirectory();
    let isFile = e.isFile();
    if (follow && e.isSymbolicLink()) {
      try {
        const st = fs.statSync(p);
        isDir = st.isDirectory();
        isFile = st.isFile();
      } catch {
        acc.push(p); // broken link: the caller lists it
        continue;
      }
    }
    if (isDir) {
      if (!IGNORE_DIRS.has(e.name) && !e.name.startsWith(".")) walk(p, acc, follow, visited);
    } else if (isFile || e.isSymbolicLink()) acc.push(p);
  }
  return acc;
}

// One path from a glob, a git listing or the command line, to the files it stands for. A symlink is returned as-is (lstat)
// unless followed, so the caller reports it instead of reading its target (notes.txt -> ~/.aws/credentials).
function entries(f: string, follow: boolean): string[] {
  let st: fs.Stats;
  try { st = fs.lstatSync(f); } catch { return []; }
  if (st.isFile()) return [f];
  if (!st.isSymbolicLink()) return [];
  if (!follow) return [f];
  try { st = fs.statSync(f); } catch { return [f]; }
  return st.isDirectory() ? walk(f, [], true, new Set()) : st.isFile() ? [f] : [];
}

// Why every path is root-checked: a glob has no single named path, so its static prefix and each file it returns get the same E35 check a
// named path gets; otherwise `/etc/*.conf` or `../../*` would be read, limited only by the deny list.
function checkGlobPrefix(spec: string): void {
  const segs = spec.split("/");
  checkRoot(segs.slice(0, segs.findIndex((s) => GLOB_RE.test(s))).join("/") || (spec.startsWith("/") ? "/" : "."));
}

function expand(spec: string, follow: boolean, nodeMajor: number): string[] {
  // Why existsSync first: a real file or directory named like `[draft] notes` or `a{1}` is that path, never a pattern (F9).
  if (GLOB_RE.test(spec) && !fs.existsSync(spec)) {
    // E121: fs.globSync is Node 22+.
    if (nodeMajor < 22) throw new InputError("glob patterns need Node 22+; pass a directory instead");
    checkGlobPrefix(spec);
    const globSync = (fs as unknown as { globSync: (p: string, o: { exclude: (p: string) => boolean }) => string[] }).globSync;
    const files = globSync(spec, { exclude: (p) => IGNORE_DIRS.has(path.basename(p)) });
    // A symlink is returned unfollowed and listed later; every other file must really sit inside the roots (a glob can pass through a linked directory).
    for (const f of files) if (!fs.lstatSync(f).isSymbolicLink()) checkRoot(f);
    return files.flatMap((f) => entries(f, follow));
  }
  if (!fs.existsSync(spec)) throw new InputError(`no such file or directory: ${spec}`);
  checkRoot(spec); // E35: a named root outside cwd/HOME//tmp is refused before it is listed; a root that is itself a link is refused too
  if (!fs.lstatSync(spec).isDirectory()) return entries(spec, follow);
  // E119: an empty git listing means "everything ignored"; walking it would send exactly the gitignored files.
  return (gitFiles(spec) ?? walk(spec, [], follow, new Set())).flatMap((f) => entries(f, follow));
}

function parseItems(raw: string): Item[] {
  const out: Item[] = [];
  for (const [i, line] of raw.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    if (line.trimStart().startsWith("{")) {
      // E127: a line opening an object must be valid JSON; sending a broken record as text would hide the typo.
      let obj: Record<string, unknown>;
      try { obj = JSON.parse(line) as Record<string, unknown>; } catch (e) {
        throw new InputError(`--items line ${i + 1} is not valid JSON: ${(e as Error).message}`);
      }
      const { id, text, content, ...rest } = obj;
      const body = text ?? content ?? JSON.stringify(rest);
      out.push({ id: String(id ?? i + 1), text: typeof body === "string" ? body : JSON.stringify(body) });
    } else out.push({ id: String(i + 1), text: line });
  }
  return out;
}

// Why on the whole text before any line split: a PEM block spans lines, so redacting each line afterwards would miss it (E37).
function redactWhole(text: string, label: string, warnings: string[], budgetMs?: number): string {
  const red = redactContent(text, label, budgetMs);
  if (red.warning) warnings.push(red.warning);
  return red.text;
}

function stdinText(buf: Buffer | undefined, maxBytes: number, warnings: string[], budgetMs?: number): string {
  if (!buf) throw new InputError("stdin was requested but none was supplied");
  if (buf.length > maxBytes) throw new InputError(`stdin is over ${fmtBytes(maxBytes)}; pass files instead, or split the input`);
  if (isBinary(buf)) throw new InputError("stdin is binary (NUL byte in the first 8192 bytes) and is never sent");
  const text = decode(buf, "stdin", warnings).replace(/\r\n/g, "\n");
  if (!text.trim()) throw new InputError("stdin: empty input");
  return redactWhole(text, "stdin", warnings, budgetMs);
}

export async function collectInputs(specs: string[], opts: CollectOptions = {}): Promise<Collected> {
  const maxBytes = effectiveMax(opts.maxBytes);
  const limit = opts.limit ?? DEFAULT_LIMIT;
  // Why validated like maxBytes: NaN makes `items.length >= limit` never true, so E126 would never fire; 0 or less refuses everything (F7).
  if (!Number.isInteger(limit) || limit < 1) throw new InputError(`--limit must be a positive integer, got ${limit}`);
  const follow = opts.followSymlinks === true;
  const nodeMajor = opts.nodeMajor ?? Number(process.versions.node.split(".")[0]);
  const exts = opts.ext ? opts.ext.split(",").map((e) => "." + e.trim().replace(/^\./, "").toLowerCase()) : null;
  const items: Item[] = [];
  const skipped: Skipped[] = [];
  const warnings: string[] = [];
  const push = (id: string, text: string): void => {
    // Checked per item so a run over the limit stops before the rest is read (E126).
    if (items.length >= limit) throw new InputError(`more than ${limit} items (--limit ${limit}). Narrow the input or raise --limit.`);
    items.push({ id, text });
  };
  const pushLines = (name: string, text: string): void => {
    text.split(/\r?\n/).forEach((l, i) => { if (l.trim()) push(`${name}:${i + 1}`, l); });
  };

  if (opts.items !== undefined) {
    const raw = opts.items === "-"
      ? stdinText(opts.stdin, maxBytes, warnings, opts.redactBudgetMs)
      : (() => { const s = applyMode(readNamed(opts.items, maxBytes), { kind: "whole" }, opts.items, opts.redactBudgetMs); warnings.push(...s.warnings); return s.text; })();
    for (const it of parseItems(raw)) push(it.id, it.text);
  }

  const files: string[] = [];
  for (const spec of specs) {
    if (spec === "-") {
      const t = stdinText(opts.stdin, maxBytes, warnings, opts.redactBudgetMs);
      if (opts.lines) pushLines("stdin", t); else push("stdin", t);
      continue;
    }
    files.push(...expand(spec, follow, nodeMajor));
  }

  const cwd = process.cwd();
  const seen = new Set<string>();
  for (const f of files) {
    const abs = path.resolve(f);
    const rel = abs.startsWith(cwd + path.sep) ? path.relative(cwd, abs) : abs;
    if (exts && !exts.includes(path.extname(f).toLowerCase())) continue;
    let real = abs;
    if (follow) {
      try { real = fs.realpathSync(abs); } catch { skipped.push({ path: rel, reason: "broken symlink" }); continue; }
    } else if (fs.lstatSync(abs).isSymbolicLink()) {
      // Why list, never read: the target may sit outside the input tree and SECRET_RE would only see the link's own name.
      skipped.push({ path: rel, reason: "symlink, never followed" });
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    if (isSecretPath(abs) || (real !== abs && isSecretPath(real))) { skipped.push({ path: rel, reason: "secret-like, never sent" }); continue; }
    if (real !== abs) {
      try { sanitizeInputPath(real); } catch { skipped.push({ path: rel, reason: "symlink target outside the allowed roots" }); continue; }
    }
    // E123: qs skips these silently; we list them.
    if (LOCK_RE.test(rel)) { skipped.push({ path: rel, reason: "lock file" }); continue; }
    if (MINIFIED_RE.test(rel)) { skipped.push({ path: rel, reason: "minified file" }); continue; }
    if (SOURCEMAP_RE.test(rel)) { skipped.push({ path: rel, reason: "source map" }); continue; }
    if (fs.statSync(abs).size > maxBytes) { skipped.push({ path: rel, reason: `over ${fmtBytes(maxBytes)}` }); continue; }
    const buf = fs.readFileSync(abs);
    if (isBinary(buf)) { skipped.push({ path: rel, reason: "binary" }); continue; }
    const text = decode(buf, rel, warnings).replace(/\r\n/g, "\n");
    if (!text.trim()) { skipped.push({ path: rel, reason: "empty" }); continue; }
    let clean: string;
    try {
      clean = redactWhole(text, rel, warnings, opts.redactBudgetMs);
    } catch (e) {
      // Why skip, not abort: one file that cannot be redacted must not be sent, but it must not kill the other files of the walk either.
      if (!(e instanceof InputError)) throw e;
      skipped.push({ path: rel, reason: `redaction failed, never sent: ${e.message}` });
      continue;
    }
    if (opts.lines) pushLines(rel, clean); else push(rel, clean);
  }
  return { items, skipped, warnings };
}
