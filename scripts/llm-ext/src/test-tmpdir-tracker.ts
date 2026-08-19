/**
 * vitest `setupFiles` entry — removes every temp directory a test file creates.
 *
 * WHY: ~100 `mkdtempSync("/tmp/…")` call sites across the suite (tests must use
 * /tmp, not os.tmpdir(), because config.ts getConfigDir() only accepts $HOME or
 * /private/tmp) and most never `rmSync` what they made — /tmp held 2,400+
 * orphan `llm-ext-*` / `__llm_ext_*` dirs on 2026-08-19. Fixing each site
 * leaves the next test free to leak again, so cleanup is done here BY
 * CONSTRUCTION: `fs.mkdtempSync` is wrapped to record what it creates, and the
 * file-scoped `afterAll` (vitest runs setupFiles hooks once per test file)
 * removes it all. Nothing is removed before `afterAll` because beforeAll-created
 * dirs must outlive every test in the file.
 *
 * The default import + `syncBuiltinESMExports()` is what makes the patch reach
 * `import { mkdtempSync } from "node:fs"` in test files and test-helpers.ts: the
 * ESM namespace is frozen, but the builtin module object is not, and the sync
 * call republishes its properties as the live named-export bindings.
 */
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { afterAll } from "vitest";

const created: string[] = [];
const originalMkdtempSync = fs.mkdtempSync;
const originalMkdtempAsync = fs.promises.mkdtemp;

fs.mkdtempSync = ((prefix: string, options?: unknown) => {
  const dir = (originalMkdtempSync as (p: string, o?: unknown) => string | Buffer)(prefix, options);
  created.push(dir.toString());
  return dir;
}) as typeof fs.mkdtempSync;
// The promise variant too (`import { mkdtemp } from "node:fs/promises"`) — no
// test uses it today; this keeps the next one from being the leak.
fs.promises.mkdtemp = (async (prefix: string, options?: unknown) => {
  const dir = await (originalMkdtempAsync as (p: string, o?: unknown) => Promise<string | Buffer>)(prefix, options);
  created.push(dir.toString());
  return dir;
}) as typeof fs.promises.mkdtemp;
syncBuiltinESMExports();

afterAll(() => {
  // force: a test that already removed (or renamed) its own dir is not an error.
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
