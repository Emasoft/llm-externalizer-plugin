/**
 * vitest `globalSetup` — FAILS the run if the suite leaves temp dirs behind.
 *
 * Second layer over test-tmpdir-tracker.ts. The tracker prevents the leak for
 * anything that goes through fs.mkdtemp*; this guard DETECTS a leak through any
 * other route (mkdirSync with a hand-rolled name, a spawned CLI writing its own
 * temp dir, a future helper) so it is noticed on the first run instead of after
 * /tmp holds 2,400 orphan dirs again. It snapshots the top-level entries of the
 * two temp roots before the run and, at teardown, lists the entries that are
 * NEW and still present; any whose name carries the project's `llm-ext` /
 * `__llm_ext` marker fails the run — and with it `npm test` and the publish
 * gate. Only project-named entries are checked because other sessions create
 * temp dirs concurrently; name your test temp dirs with an `llm-ext-` prefix so
 * this guard can see them.
 */
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOTS = ["/tmp", tmpdir()].filter((r, i, a) => existsSync(r) && a.indexOf(r) === i);
const PROJECT_MARKER = /llm[-_]?ext/i;

function snapshot(): Map<string, Set<string>> {
  return new Map(ROOTS.map((r) => [r, new Set(readdirSync(r))]));
}

export default function setup(): () => void {
  const before = snapshot();
  return () => {
    const leaked: string[] = [];
    for (const [root, names] of snapshot()) {
      for (const name of names) {
        if (!before.get(root)?.has(name) && PROJECT_MARKER.test(name)) leaked.push(join(root, name));
      }
    }
    if (leaked.length > 0) {
      // A throw alone is only REPORTED ("error during close") — vitest still
      // exits 0, so the gate would be decoration. exitCode is what `npm test`
      // and the publish gate actually see.
      process.exitCode = 1;
      throw new Error(
        `TEMP-DIR LEAK: ${leaked.length} project temp entr${leaked.length === 1 ? "y" : "ies"} left behind by this run — ` +
          `every test must remove what it creates (mkdtempSync is auto-cleaned by src/test-tmpdir-tracker.ts; ` +
          `anything else needs an explicit rmSync in afterEach/afterAll):\n  ${leaked.join("\n  ")}`,
      );
    }
  };
}
