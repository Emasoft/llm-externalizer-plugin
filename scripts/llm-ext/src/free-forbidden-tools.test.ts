/**
 * FREE_FORBIDDEN_TOOLS completeness (P6b-fix2 B-2; strengthened fix-queue 47,
 * revised after a coordinator-relayed adversarial review — 1 blocker + 4
 * should-fix, see "Revision" in the fq47 report).
 *
 * The list in `default-profiles.ts` says which tools a `free` profile may never
 * serve. Its members are exactly the ones whose handler SENDS LLM COMPLETIONS
 * ON THE PROFILE'S HEAD — a claim about an implementation, which nothing in the
 * type system can check. So each of those handlers carries a
 * `// FREE-FORBIDDEN:` marker in `mass_scouting/mcp-tools.ts`, and Section 1
 * below asserts the two agree in both directions: a marked handler missing from
 * the list, or a listed mass-scout tool with no marked handler, turns it red.
 *
 * That closes the hole P6b-fix left. Its predicate consulted
 * MASS_SCOUT_TOOL_NAMES — the MCP module's own membership Set — so its
 * completeness test ("EVERY name in MASS_SCOUT_TOOL_NAMES is refused") could
 * not fail by construction, while its stated justification ("a new tool with a
 * non-matching name turns this red") was false: adding a tool to that module
 * added it to the Set, to the predicate and to the test at once.
 *
 * A source-level assertion is the honest instrument here, for the same reason
 * free-rotation-coverage.test.ts is one: the claim is about which code path a
 * handler takes, and no amount of booting proves the negative for a handler no
 * test happens to exercise.
 *
 * The marker convention above has one remaining hole (fix-queue 47 / KV2WCFCS):
 * it agrees with itself by construction whenever BOTH the marker and the list
 * entry are simply missing together — an author who forgets the marker on a
 * brand-new completions-sending handler also (necessarily, since nothing else
 * would put it there) forgets the FREE_FORBIDDEN_TOOLS entry, and the two
 * "agree" on being wrong. Section 2 below closes that hole for the CLI-routed
 * mass-scout tools with an INDEPENDENT, marker-free derivation, using the real
 * TypeScript AST (`typescript`, already a devDependency — see
 * benchmark/ground-truth.ts for precedent) rather than hand-rolled text
 * scanning: for every mass-scout tool dispatched through `runMassScoutCli`, it
 * resolves which `mass_scouting/cli.ts` function handles the tool's
 * sub-command, then walks that function's own call graph — relative imports
 * followed recursively across the WHOLE non-test `src/` tree, not only
 * `mass_scouting/` and `security_scan/` — for a string/template literal that
 * contains the OpenRouter `chat/completions` endpoint. Widening the walk to
 * the whole tree (not just the two subsystem directories) is required because
 * a handler can drive completions through the shared `provider/completion.ts`
 * client, whose own request URL is built two hops further away in
 * `provider/connection.ts` (`` `${route.url}/v1/chat/completions` ``) — see the
 * second red-proof in the report, which sends an unmarked handler through
 * exactly that path and confirms it reddens. That derivation depends on
 * nothing an author writes by hand for a forbidden tool; an unmarked new
 * handler that ends up dialing `chat/completions`, however many hops away,
 * still gets caught.
 *
 * Why not `resolveCliModel` call sites (as fix-queue 47's own wording first
 * suggested)? Traced by hand: `runRegister` and `runEstimate` BOTH call
 * `resolveCliModel`, but only to look up `resolvePricing(model, …)` for a
 * byte-cap / cost estimate — neither ever sends a request. Treating
 * `resolveCliModel` as the signal produces false positives on two tools that
 * are correctly NOT forbidden today. The literal `chat/completions` reference
 * is the only signal that is actually true of every sender and false of every
 * non-sender — traced and cross-checked against ALL 17 CLI-routed tools below.
 *
 * Scope, stated precisely (do not read this as closing the whole hole): this
 * only covers the tools dispatched through `runMassScoutCli`. Six
 * `mass_scouting/mcp-tools.ts` tools are NOT routed that way
 * (`security_triage_benchmark`, `search_existing_benchmark`, `assess_model`,
 * `check_model_health`, `discover_new_models`, `check_tool_replacements`), and
 * neither is `high_quality_scan` (not a mass-scout tool at all) — those six
 * plus `high_quality_scan` stay on Section 1's marker-based coverage alone,
 * unchanged by this section.
 *
 * Two further limitations, named explicitly rather than left implicit (a
 * second review round after the whole-tree widening below): (1) the base
 * case is a bare substring test on every literal reachable from a handler —
 * over 160 files a `chat/completions` mention in an unrelated string (a doc
 * comment quoted into a literal, a log template, a test-fixture URL) sitting
 * on something transitively imported for an unrelated reason could in
 * principle produce a spurious mismatch; not observed on the real tree today
 * (all 17 CLI-routed tools match exactly), but a future false alarm here
 * should be diagnosed as "the literal isn't actually inside a request", not
 * fixed by weakening the literal check itself without re-deriving why. The
 * same holds for the identifier walk's over-collection:
 * `collectLiteralsAndIdentifiers` records EVERY bare identifier in a
 * declaration's subtree, including property names, parameter names, and
 * type names that are never actually called — but an over-collected
 * identifier can only ever ADD a spurious edge to the graph, never hide a
 * real sender, so a future red from one of these is a false edge to
 * diagnose (which identifier, which declaration it accidentally resolved
 * to), never a hidden sender to worry about. (2) the identifier walk
 * resolves calls by IMPORTED OR SAME-FILE NAME only — a handler that
 * reaches completions by invoking a function passed to it as a
 * callback/parameter (rather than importing and calling it by its own
 * module-level name), or through computed/dynamic dispatch
 * (`handlers[name](...)`), is invisible to this derivation the same way the
 * original `runExport`/JSDoc bug was invisible to the first version — no red
 * proof was constructed for this shape. (3) dynamic `import()` is not
 * followed: `parseFile` only records static `import { … } from "./x.js"`
 * declarations, so a handler that reaches completions only through a
 * lazily `await import("./x.js")`-loaded module is invisible to this
 * derivation the same way. All three are accepted, undemonstrated gaps,
 * not closed ones. (4) `resolveDecl`'s own loudness is ROOT-ONLY (fix-queue
 * 77 / TRDD-90DM5YHO): only the direct cli.ts handler resolution below is
 * asserted before trusting `derived`; every deeper hop inside
 * `reachesCompletions` reads a `resolveDecl` null — a type-only import, a
 * re-export naming something outside `src/`, or any other unresolvable
 * target — as "not a sender" and keeps walking silently. The 8-hop
 * depth cap is the one exception: hitting it now throws (naming the chain)
 * instead of returning null, since that deep a chain is a re-export cycle,
 * a source bug, not a legitimate resolution gap.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import ts from "typescript";

import { FREE_FORBIDDEN_TOOLS, isFreeForbiddenTool } from "./default-profiles.js";
import { MASS_SCOUT_TOOL_NAMES } from "./mass_scouting/mcp-tools.js";
import { buildTools } from "./tools/definitions.js";
import { DECISION_SPECS } from "./classifiers/catalog/index.js";

// PT-05 (D34): tools that accept only the scouting profile type send completions on a
// scouting profile's model, not on the active (free) profile's head, so they are never free-forbidden.
const SCOUTING_ONLY_TOOLS = new Set(
  (buildTools("") as Array<{ name: string; acceptedProfileTypes: readonly string[] }>)
    .filter((t) => t.acceptedProfileTypes.length === 1 && t.acceptedProfileTypes[0] === "scouting")
    .map((t) => t.name),
);

const MARKER = "// FREE-FORBIDDEN:";

/** Every `case "<tool>":` in mcp-tools.ts's dispatch whose label is preceded by
 *  the FREE-FORBIDDEN marker (the marker sits on the comment lines directly
 *  above the case label, which is where a handler's author writes it). */
function markedHandlers(src: string): Set<string> {
  const out = new Set<string>();
  const lines = src.split("\n");
  let marked = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith(MARKER)) {
      marked = true;
      continue;
    }
    const m = /^case "([a-z0-9_]+)":/.exec(trimmed);
    if (m) {
      if (marked) out.add(m[1]);
      marked = false;
      continue;
    }
    // A continuation line of the marker's own comment keeps the flag alive;
    // anything else (blank line, code) ends it, so a stray marker cannot
    // silently annotate a case twenty lines further down.
    if (marked && !trimmed.startsWith("//")) marked = false;
  }
  return out;
}

describe("FREE_FORBIDDEN_TOOLS", () => {
  const src = readFileSync(join(__dirname, "mass_scouting", "mcp-tools.ts"), "utf-8");

  it("the marker is actually present in the dispatch — the derivation is not vacuously empty", () => {
    expect(src).toContain(MARKER);
    expect(markedHandlers(src).size).toBeGreaterThan(0);
  });

  it("for EVERY mass-scout tool, 'is free-forbidden' equals 'its handler drives the LLM on the profile head'", () => {
    const marked = markedHandlers(src);
    expect(MASS_SCOUT_TOOL_NAMES.size).toBeGreaterThan(1);
    for (const tool of MASS_SCOUT_TOOL_NAMES) {
      expect(
        isFreeForbiddenTool(tool),
        marked.has(tool)
          ? `${tool}'s handler is marked FREE-FORBIDDEN but ${tool} is not in FREE_FORBIDDEN_TOOLS`
          : `${tool} is in FREE_FORBIDDEN_TOOLS but its handler carries no FREE-FORBIDDEN marker`,
      ).toBe(marked.has(tool));
    }
  });

  it("every marked handler is a registered mass-scout tool name (a typo'd marker is caught, not ignored)", () => {
    for (const tool of markedHandlers(src)) {
      expect(MASS_SCOUT_TOOL_NAMES.has(tool), `${tool} is marked but not a MASS_SCOUT_TOOLS name`).toBe(true);
    }
  });

  it("high_quality_scan is the one member with no mass-scout handler (addendum H names it directly)", () => {
    // It is not a mass-scout tool, so the marker sweep above cannot see it —
    // stated here so the difference is a documented exception, not a gap.
    // TRDD-HBCCFOUF: high_quality_scan is FITNESS-GATED now, not a member of
    // FREE_FORBIDDEN_TOOLS — isFreeForbiddenTool consults freeFitnessUnlocked
    // for it, so the answer here depends on the fitness ledger (no pass
    // recorded in an isolated test config dir → locked → true).
    expect(MASS_SCOUT_TOOL_NAMES.has("high_quality_scan")).toBe(false);
    expect(FREE_FORBIDDEN_TOOLS).not.toContain("high_quality_scan");
    const nonMassScout = FREE_FORBIDDEN_TOOLS.filter((t) => !MASS_SCOUT_TOOL_NAMES.has(t));
    expect(nonMassScout).toEqual([]);
  });

  it("high_quality_scan is fitness-gated: refused with no recorded pass, unlocked by one; mass_scout is not free-forbidden (PT-05)", () => {
    // The gates read the fitness ledger in the test's own LLM_EXT_CONFIG_DIR
    // (test-hermetic-config.ts isolates it; no verdict is recorded here), so
    // both tools must read REFUSED — and the predicate must flip the moment a
    // ':free' pass lands, which the spy below proves without a second config.
    expect(isFreeForbiddenTool("high_quality_scan")).toBe(true);
    // PT-05 (D34): mass_scout takes a scouting-type profile, so a free profile has nothing to refuse.
    expect(isFreeForbiddenTool("mass_scout")).toBe(false);
  });

  it("the predicate is an exact-name match — no prefix rule smuggles a tool back in", () => {
    // `startsWith("mass_scout")` is what swept the subsystem's read-only
    // accessors and its cost estimator into the refusal in the first place.
    expect(isFreeForbiddenTool("security_scan")).toBe(true);
    expect(isFreeForbiddenTool("mass_scout_jobs_list")).toBe(false);
    expect(isFreeForbiddenTool("mass_scout_estimate")).toBe(false);
    expect(isFreeForbiddenTool("mass_scout_anything_new")).toBe(false);
  });
});

// ── Section 2: source-derived (marker-free) completeness — fix-queue 47 ────
// AST-based (TypeScript compiler API), scoped to the WHOLE non-test src/ tree
// via relative-import resolution — see the header comment above for why the
// walk isn't confined to mass_scouting/ + security_scan/.

const SRC_ROOT = __dirname;

/** Every non-test `.ts` file under `dir`, recursively (skips `node_modules`,
 *  `dist`, `reports_dev` — none of which hold source the call graph needs). */
function listSrcFiles(dir: string): string[] {
  let out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === "reports_dev") continue;
    const p = join(dir, entry);
    const stat = statSync(p);
    if (stat.isDirectory()) out = out.concat(listSrcFiles(p));
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

function resolveRelativeImport(fromFile: string, spec: string): string {
  let rel = spec;
  if (rel.endsWith(".js")) rel = rel.slice(0, -3); // source writes .js, disk has .ts
  return `${join(dirname(fromFile), rel)}.ts`;
}

interface ParsedFile {
  file: string;
  sf: ts.SourceFile;
  decls: Map<string, ts.Node>; // top-level function/const/let/default-export name -> node
  imports: Map<string, { file: string; exportName: string }>; // local name -> resolved target
  reExports: Map<string, { file: string; exportName: string }>; // `export { a } from "./x"`
}

/** Walk `node`'s subtree, collecting every string/template literal's text and
 *  every bare identifier name — the two things `reachesCompletions` needs:
 *  literals for the direct base case, identifiers for the recursive step. */
function collectLiteralsAndIdentifiers(
  node: ts.Node,
): { literals: string[]; idents: Set<string> } {
  const literals: string[] = [];
  const idents = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      literals.push(n.text);
    } else if (ts.isTemplateExpression(n)) {
      literals.push(n.head.text);
      for (const span of n.templateSpans) literals.push(span.literal.text);
    } else if (ts.isIdentifier(n)) {
      idents.add(n.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return { literals, idents };
}

function parseFile(file: string): ParsedFile {
  const source = readFileSync(file, "utf-8");
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const decls = new Map<string, ts.Node>();
  const imports = new Map<string, { file: string; exportName: string }>();
  const reExports = new Map<string, { file: string; exportName: string }>();
  let defaultExportNode: ts.Node | null = null;

  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt)) {
      const isDefault = stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) ?? false;
      if (stmt.name) decls.set(stmt.name.text, stmt);
      if (isDefault) defaultExportNode = stmt;
    } else if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer) decls.set(d.name.text, d);
      }
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      // S-1: a class-based handler (`class Foo { ... }`) was otherwise
      // invisible to resolveDecl — record it the same way a function or
      // const declaration already is, so a class-based sender is not blind.
      decls.set(stmt.name.text, stmt);
    } else if (
      ts.isImportDeclaration(stmt) &&
      stmt.moduleSpecifier &&
      ts.isStringLiteral(stmt.moduleSpecifier)
    ) {
      const spec = stmt.moduleSpecifier.text;
      if (!spec.startsWith(".")) continue; // only relative imports are traceable within src/
      const resolved = resolveRelativeImport(file, spec);
      const clause = stmt.importClause;
      if (!clause) continue;
      if (clause.name) imports.set(clause.name.text, { file: resolved, exportName: "default" });
      if (clause.namedBindings) {
        if (ts.isNamedImports(clause.namedBindings)) {
          for (const el of clause.namedBindings.elements) {
            const local = el.name.text;
            const imported = el.propertyName ? el.propertyName.text : el.name.text;
            imports.set(local, { file: resolved, exportName: imported });
          }
        } else if (ts.isNamespaceImport(clause.namedBindings)) {
          imports.set(clause.namedBindings.name.text, { file: resolved, exportName: "*" });
        }
      }
    } else if (
      ts.isExportDeclaration(stmt) &&
      stmt.moduleSpecifier &&
      ts.isStringLiteral(stmt.moduleSpecifier) &&
      stmt.exportClause &&
      ts.isNamedExports(stmt.exportClause)
    ) {
      const spec = stmt.moduleSpecifier.text;
      if (!spec.startsWith(".")) continue;
      const resolved = resolveRelativeImport(file, spec);
      for (const el of stmt.exportClause.elements) {
        const exportedAs = el.name.text;
        const originalName = el.propertyName ? el.propertyName.text : el.name.text;
        reExports.set(exportedAs, { file: resolved, exportName: originalName });
      }
    } else if (ts.isExportAssignment(stmt) && !stmt.isExportEquals && ts.isIdentifier(stmt.expression)) {
      reExports.set("default", { file, exportName: stmt.expression.text });
    }
  }
  if (defaultExportNode) decls.set("default", defaultExportNode);

  return { file, sf, decls, imports, reExports };
}

const CODE_FILES = listSrcFiles(SRC_ROOT);
const PER_FILE = new Map<string, ParsedFile>();
for (const f of CODE_FILES) PER_FILE.set(f, parseFile(f));

/** Resolve `(file, name)` to the ParsedFile + node that actually declares it,
 *  chasing `export { a } from "./x"` re-export chains (depth-capped — a
 *  re-export cycle is a source bug this derivation isn't responsible for
 *  diagnosing, so hitting the cap THROWS naming the chain, rather than
 *  returning null and letting the cycle read as "not a sender"). */
function resolveDecl(
  file: string,
  name: string,
  depth = 0,
  chain: string[] = [],
): { file: string; node: ts.Node; pf: ParsedFile } | null {
  if (depth > 8) {
    // fix-queue 77 / TRDD-90DM5YHO: a null here previously read as "not a
    // sender" for a NON-root import (only the root call site below asserts
    // resolution — see "resolves BEFORE trusting `derived`") — fail-open for
    // a chain this deep. A re-export/import chain that has not resolved in 8
    // hops is a re-export cycle, a source bug, not a legitimate resolution
    // gap, so it throws loud instead of silently letting an unlisted sender
    // pass.
    throw new Error(
      `resolveDecl exceeded its 8-hop re-export/import depth cap resolving ${JSON.stringify(name)} in ${file} — likely a re-export cycle. Chain: ${[...chain, `${file}::${name}`].join(" -> ")}`,
    );
  }
  const pf = PER_FILE.get(file);
  if (!pf) return null;
  if (pf.decls.has(name)) return { file, node: pf.decls.get(name)!, pf };
  if (pf.reExports.has(name)) {
    const re = pf.reExports.get(name)!;
    return resolveDecl(re.file, re.exportName, depth + 1, [...chain, `${file}::${name}`]);
  }
  if (pf.imports.has(name)) {
    // B-1 (fail-open fix, fq47 revision): a handler IMPORTED into `file`
    // (cli.ts routing a case to a function defined in and re-used from a
    // sibling module) was previously invisible here — resolveDecl only ever
    // consulted pf.decls/pf.reExports, so the root handler resolved to null
    // and every downstream `derived` silently fell through to false, letting
    // an unlisted sender pass. Namespace imports (`exportName === "*"`) are
    // excluded: there is no single declaration to chase for `import * as ns`.
    const imp = pf.imports.get(name)!;
    if (imp.exportName !== "*") return resolveDecl(imp.file, imp.exportName, depth + 1, [...chain, `${file}::${name}`]);
  }
  return null;
}


// fix-queue 77 / TRDD-90DM5YHO: proves the depth-cap throw above actually
// fires, since nothing in the real src/ tree has a re-export chain 9 hops
// deep to exercise it. Injects a synthetic 10-file re-export chain directly
// into PER_FILE (never touches the real CODE_FILES/PER_FILE entries — the
// keys are namespaced and removed in `finally`), then asserts resolveDecl
// throws instead of returning null once the chain exceeds the cap.
describe("resolveDecl — depth cap", () => {
  it("throws naming the chain when a re-export chain exceeds the 8-hop cap, instead of silently returning null", () => {
    const chainLen = 10;
    const files = Array.from({ length: chainLen }, (_, i) => `__fq77_cap_probe_${i}__`);
    for (const [i, f] of files.entries()) {
      const isLast = i === files.length - 1;
      PER_FILE.set(f, {
        file: f,
        sf: ts.createSourceFile(f, "", ts.ScriptTarget.Latest, true),
        decls: new Map(),
        imports: new Map(),
        reExports: isLast ? new Map() : new Map([["v", { file: files[i + 1], exportName: "v" }]]),
      });
    }
    try {
      expect(() => resolveDecl(files[0], "v")).toThrow(/depth cap/);
    } finally {
      for (const f of files) PER_FILE.delete(f);
    }
  });
});

const COMPLETIONS_LITERAL = "chat/completions";


// S-2 (restored SAFE half of the memo, fq47 revision): a POSITIVE result is
// safe to cache unconditionally — once ANY path to the literal is found for
// (file, name), that path exists regardless of which call discovered it
// first. A NEGATIVE result is only safe to cache when it was computed at a
// DFS ROOT (`visiting.size === 1` on return, i.e. no ancestor call is still
// on the stack) — a nested `false` can be an artifact of the cycle guard
// below (see the A/B/C example in reachesCompletions' own docblock), but a
// root call's `false` means the graph rooted there truly has no path,
// independent of any caller.
// ponytail: this still re-walks shared subgraphs across distinct roots that
// each hit a positive result on a different branch — a topological pre-pass
// (compute every node's reachability once, in dependency order) would make
// every case O(V+E) if this graph ever grows large enough for that to matter.
const memo = new Map<string, boolean>();

/**
 * Does the declaration `name` in `file` reach a `chat/completions` request —
 * directly (a literal in its own text) or transitively (an identifier it
 * contains names another declaration, anywhere in `src/`, that does)?
 *
 * Deliberately NOT memoized across top-level calls. A first attempt memoized
 * by `(file, name)` alone and broke on exactly the shape this call graph can
 * have: A references both B and C; B references A back; C is a direct sink.
 * Resolving A explores B first — B's only edge (back to A) is a live cycle,
 * so B's own DFS correctly returns `false` for that in-progress branch, and
 * a naive cache stores `B -> false` right there. Resolving C next makes A
 * `true` — but a LATER, independent query for B alone would still hit the
 * stale `false`, even though B actually reaches the literal via B -> A -> C.
 * The `visiting` set is a same-call cycle guard ONLY (torn down again once
 * each call returns); a fresh `visiting = new Set()` per top-level entry
 * point means every root query re-walks the graph from scratch, so no result
 * ever survives past the query that produced it. With 17 roots over a
 * few-hundred-node graph the redundant work is negligible — correctness over
 * a cache that cannot be made both const-time and race-free without a
 * topological pre-pass on a graph this small.
 */
function reachesCompletions(file: string, name: string, visiting: Set<string> = new Set()): boolean {
  const key = `${file}::${name}`;
  if (memo.has(key)) return memo.get(key)!;
  if (visiting.has(key)) return false;
  visiting.add(key);

  const resolved = resolveDecl(file, name);
  let result = false;
  if (resolved) {
    const { literals, idents } = collectLiteralsAndIdentifiers(resolved.node);
    if (literals.some((l) => l.includes(COMPLETIONS_LITERAL))) {
      result = true;
    } else {
      const pf = resolved.pf;
      for (const id of idents) {
        if (id === name) continue;
        if (pf.decls.has(id) || pf.reExports.has(id)) {
          if (reachesCompletions(resolved.file, id, visiting)) {
            result = true;
            break;
          }
        } else if (pf.imports.has(id)) {
          const imp = pf.imports.get(id)!;
          if (imp.exportName === "*") continue; // namespace import — handled below via property access
          if (PER_FILE.has(imp.file) && reachesCompletions(imp.file, imp.exportName, visiting)) {
            result = true;
            break;
          }
        }
      }
      if (!result) {
        // `ns.member` where `ns` is a namespace import: the bare-identifier
        // walk above only sees `ns`, not `member` — scan this declaration's
        // own text for the property-access shape instead. Not exercised by
        // anything in src/ today (no relative namespace imports exist), kept
        // so a future one doesn't silently fall through the cracks.
        const text = resolved.node.getText(resolved.pf.sf);
        for (const [local, imp] of pf.imports) {
          if (imp.exportName !== "*") continue;
          const re = new RegExp(`\\b${local}\\.(\\w+)`, "g");
          let m: RegExpExecArray | null;
          while ((m = re.exec(text))) {
            if (PER_FILE.has(imp.file) && reachesCompletions(imp.file, m[1], visiting)) {
              result = true;
              break;
            }
          }
          if (result) break;
        }
      }
    }
  }
  // S-2: a positive result is sound to cache from any depth (see the memo
  // docblock above); a negative one only when this call is the DFS root —
  // check visiting.size before deleting this call's own key, since a root
  // call is the one where nothing but its own key remains on the stack.
  const isRoot = visiting.size === 1;
  visiting.delete(key);
  if (result) memo.set(key, true);
  else if (isRoot) memo.set(key, false);
  return result;
}

const cliFile = join(SRC_ROOT, "mass_scouting", "cli.ts");
const mcpFile = join(SRC_ROOT, "mass_scouting", "mcp-tools.ts");

/** Sub-command string ("chain", "register", …) -> the `cli.ts` function that
 *  handles it, read straight off `runMassScoutCli`'s own dispatch switch. */
function subcommandToFunction(): Map<string, string> {
  const decl = resolveDecl(cliFile, "runMassScoutCli");
  const body = decl ? decl.node.getText(decl.pf.sf) : "";
  const map = new Map<string, string>();
  const re = /case "([a-z-]+)":\s*\n\s*return (\w+)\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) map.set(m[1], m[2]);
  return map;
}

/**
 * MCP tool name -> the sub-command string its `dispatchMassScoutTool` case
 * passes to `runMassScoutCli`, read off `mcp-tools.ts`. The sub-command is
 * always the array's first element, but three shapes appear in the wild —
 * `buildArgv("chain", …)`, a raw literal `["security-scan", …]`, and a
 * locally-built `argv` variable (`mass_scout_build_fieldset`) — so rather
 * than special-case each shape, this looks for whichever KNOWN sub-command
 * name (from `subToFn`) appears as a quoted token inside the case's own
 * body; exactly one must match for the case to be considered resolved.
 * A case that calls `runMassScoutCli` but resolves to zero or more than one
 * candidate is a genuine gap in this derivation, not something to guess at —
 * it is surfaced as `unresolved` so the completeness test below fails loud
 * instead of silently treating an unrecognized case as "not forbidden".
 */
function toolToSubcommand(subToFn: Map<string, string>): {
  map: Map<string, string>;
  unresolved: string[];
} {
  const decl = resolveDecl(mcpFile, "dispatchMassScoutTool");
  const body = decl ? decl.node.getText(decl.pf.sf) : "";
  const caseRe = /case "([a-z0-9_]+)":/g;
  const starts: { name: string; idx: number }[] = [];
  let cm: RegExpExecArray | null;
  while ((cm = caseRe.exec(body))) starts.push({ name: cm[1], idx: cm.index });
  starts.push({ name: "", idx: body.length });

  const map = new Map<string, string>();
  const unresolved: string[] = [];
  for (let i = 0; i < starts.length - 1; i++) {
    const { name, idx } = starts[i];
    const blob = body.slice(idx, starts[i + 1].idx);
    if (!blob.includes("runMassScoutCli(")) continue; // not CLI-routed — out of this method's scope
    const hits = [...subToFn.keys()].filter((sub) => new RegExp(`["']${sub}["']`).test(blob));
    if (hits.length === 1) map.set(name, hits[0]);
    else unresolved.push(name);
  }
  return { map, unresolved };
}

/** Mass-scout tools whose handler is known, by direct reading, to NOT route
 *  through `runMassScoutCli` (they call their own in-process function —
 *  `assessModelById`, `runCheckModelHealth`, etc. — straight from
 *  `dispatchMassScoutTool`). This derivation cannot see inside them the same
 *  way; they stay on Section 1's marker-based coverage. Named explicitly (not
 *  "whatever toolToSubcommand didn't resolve") so a rename of
 *  `runMassScoutCli` or a new tool that silently fails to route through it
 *  can't shrink this list on its own — the membership check below requires
 *  every MASS_SCOUT_TOOL_NAMES entry to be in `toolToSub` OR in this exact
 *  list, nothing else. */
const KNOWN_NON_CLI_ROUTED_TOOLS = new Set([
  "security_triage_benchmark",
  "search_existing_benchmark",
  "assess_model",
  "check_model_health",
  "discover_new_models",
  "check_tool_replacements",
  // P6: queueManual + ensureCalibrator / calibrationStatusText, in-process (no CLI sub-command, no model request).
  "calibrate_model",
  "calibration_status",
]);

describe("FREE_FORBIDDEN_TOOLS — source-derived (marker-free) completeness", () => {
  const subToFn = subcommandToFunction();
  const { map: toolToSub, unresolved } = toolToSubcommand(subToFn);

  it("every MASS_SCOUT_TOOL_NAMES entry is accounted for: CLI-routed (resolved) or on the explicit non-CLI-routed list", () => {
    // Replaces a bare size-floor sanity check: a size floor cannot tell "the
    // extractor silently dropped a few tools" apart from "the extractor is
    // fine and the tool set just happens to be this big" — membership can.
    expect(unresolved, `case(s) route through runMassScoutCli but this derivation could not pin a sub-command for: ${unresolved.join(", ")} — extend toolToSubcommand's shapes, don't ignore the gap`).toEqual([]);
    for (const tool of MASS_SCOUT_TOOL_NAMES) {
      expect(
        toolToSub.has(tool) || KNOWN_NON_CLI_ROUTED_TOOLS.has(tool),
        `${tool} is in MASS_SCOUT_TOOL_NAMES but is neither CLI-routed (in toolToSub) nor on KNOWN_NON_CLI_ROUTED_TOOLS — a new tool landed in neither and this derivation has no opinion on it`,
      ).toBe(true);
    }
  });

  it("for EVERY CLI-routed mass-scout tool, isFreeForbiddenTool equals the call-graph's own answer — independent of any // FREE-FORBIDDEN marker", () => {
    for (const [tool, sub] of toolToSub) {
      const fn = subToFn.get(sub);
      expect(fn, `${tool} resolved to sub-command ${JSON.stringify(sub)}, which is not a case in runMassScoutCli's switch`).toBeDefined();
      // B-1 (fail-open fix, fq47 revision): resolveDecl previously only walked
      // cliFile's OWN top-level declarations and re-exports, never its imports —
      // a handler imported into cli.ts from a sibling module resolved to null,
      // reachesCompletions silently returned false, and an unlisted sender
      // passed green. Assert the root itself resolves BEFORE trusting `derived`,
      // so a future resolution gap fails loud instead of reading as "not forbidden".
      expect(
        resolveDecl(cliFile, fn!),
        `handler ${fn} is not declared or imported in cli.ts — extend resolveDecl`,
      ).not.toBeNull();
      // PT-05 (D34): a scouting-only tool reaches completions yet is never free-forbidden (its model comes from a scouting profile).
      const derived = reachesCompletions(cliFile, fn!) && !SCOUTING_ONLY_TOOLS.has(tool);
      expect(
        isFreeForbiddenTool(tool),
        derived
          ? `${tool} -> ${sub} -> ${fn}() reaches a chat/completions request in the call graph, but ${tool} is not in FREE_FORBIDDEN_TOOLS (missing the marker AND the list entry would both go unnoticed by the marker-only check above)`
          : `${tool} -> ${sub} -> ${fn}() never reaches chat/completions in the call graph, yet ${tool} is in FREE_FORBIDDEN_TOOLS`,
      ).toBe(derived);
    }
  });
});


// ── Section 3: per-tool derivation for the tools Sections 1 and 2 cannot see ─
// (KV2WCFCS). Section 2 only covers the 17 CLI-routed mass-scout tools. This
// section runs the SAME call-graph test (`reachesCompletions`) on every other
// tool's own `case` body — all of `dispatchCallToolInner`'s cases in index.ts
// and the six KNOWN_NON_CLI_ROUTED_TOOLS cases in mcp-tools.ts — so a tool that
// drives completions must be a DECISION: either forbidden on a free profile
// (isFreeForbiddenTool, incl. fitness-gated) or listed below with the reason
// free mode legitimately serves it. An unmarked new tool whose case reaches
// chat/completions and has neither fails here, whatever its name or marker.
// Ceiling (same as Section 2): resolution is by imported/same-file NAME, and
// a case body is scanned for identifiers by regex, so an over-collected
// identifier can only ADD a spurious "sender" (demands a decision, never
// hides one); callbacks / dynamic dispatch / dynamic import() stay invisible.

/** Tools that reach chat/completions yet free mode legitimately serves. */
const FREE_SERVED_LLM_TOOLS: Record<string, string> = {
  chat: "core ensemble pipeline; free-model rotation is its whole point",
  code_task: "core pipeline tool; served from the free rotation pool",
  summarize: "text tool on the core ensemble pipeline; served from the free pool",
  topics: "text tool on the core ensemble pipeline; served from the free pool",
  sem_deduplicate: "text tool on the core ensemble pipeline; served from the free pool",
  describe: "text tool on the core ensemble pipeline; served from the free pool",
  session_summary: "single bounded completion per session; served from the free pool",
  batch_check: "per-file checks through the core pipeline; free rotation covers it",
  scan_folder: "per-file scan through the core pipeline; free rotation covers it",
  search_existing_implementations: "core ensemble pipeline; served from the free pool",
  compare_files: "core ensemble pipeline; served from the free pool",
  check_references: "core ensemble pipeline; served from the free pool",
  check_imports: "bounded JSON completions through the core client; served from the free pool",
  check_against_specs: "per-file checks through the core pipeline; free rotation covers it",
  cluster_synonyms: "completions with profile fallback; served from the free pool",
  security_triage_benchmark: "benchmark picks its own candidate models, never the profile head",
  search_existing_benchmark: "benchmark picks its own candidate models, never the profile head",
  check_tool_replacements: "qualification probe picks its own candidate models, never the profile head",
}

/** `case "<tool>":` label -> that case's body text, for a dispatch function
 *  whose top-level cases sit at exactly `indent` spaces. Consecutive labels
 *  with no code between them (fall-through) share the next body. */
function caseBodies(file: string, fn: string, indent: number): Map<string, string> {
  const decl = resolveDecl(file, fn);
  expect(decl, `${fn} not found in ${file} — update Section 3`).not.toBeNull();
  const body = decl!.node.getText(decl!.pf.sf);
  const re = new RegExp(`^ {${indent}}case "([a-z0-9_]+)":`, "gm");
  const starts: { name: string; idx: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) starts.push({ name: m[1], idx: m.index, end: m.index + m[0].length });
  const out = new Map<string, string>();
  let pending: string[] = [];
  for (let i = 0; i < starts.length; i++) {
    pending.push(starts[i].name);
    const text = body.slice(starts[i].end, i + 1 < starts.length ? starts[i + 1].idx : body.length);
    if (text.trim().length === 0) continue; // fall-through label
    for (const n of pending) out.set(n, text);
    pending = [];
  }
  return out;
}

/** The first identifier in `blob` whose declaration reaches chat/completions
 *  (or "chat/completions" itself when the literal is in the blob), else null. */
function blobSender(file: string, blob: string): string | null {
  if (blob.includes(COMPLETIONS_LITERAL)) return COMPLETIONS_LITERAL;
  const pf = PER_FILE.get(file)!;
  for (const id of new Set(blob.match(/[A-Za-z_$][\w$]*/g) ?? [])) {
    if (!pf.decls.has(id) && !pf.imports.has(id) && !pf.reExports.has(id)) continue;
    if (reachesCompletions(file, id)) return id;
  }
  return null;
}

describe("FREE_FORBIDDEN_TOOLS — per-tool derivation beyond the CLI-routed tools", () => {
  const indexFile = join(SRC_ROOT, "index.ts");
  const cases = new Map<string, { file: string; blob: string }>();
  for (const [tool, blob] of caseBodies(indexFile, "dispatchCallToolInner", 6)) cases.set(tool, { file: indexFile, blob });
  for (const [tool, blob] of caseBodies(mcpFile, "dispatchMassScoutTool", 4)) {
    if (KNOWN_NON_CLI_ROUTED_TOOLS.has(tool)) cases.set(tool, { file: mcpFile, blob });
  }
  const derived = new Map<string, string>();
  for (const [tool, { file, blob }] of cases) {
    const via = blobSender(file, blob);
    if (via) derived.set(tool, via);
  }

  it("the derivation is not vacuous: it sees the known senders", () => {
    expect(cases.size).toBeGreaterThan(20);
    for (const t of ["chat", "code_task", "high_quality_scan"]) {
      expect(derived.has(t), `${t} should reach chat/completions in the call graph`).toBe(true);
    }
  });

  it("every tool whose case reaches chat/completions is forbidden on free OR carries a reasoned entry in FREE_SERVED_LLM_TOOLS", () => {
    for (const [tool, via] of derived) {
      expect(
        isFreeForbiddenTool(tool) || tool in FREE_SERVED_LLM_TOOLS,
        `${tool} reaches chat/completions (via ${via}) but has no free-mode decision: add it to FREE_FORBIDDEN_TOOLS (default-profiles.ts) or to FREE_SERVED_LLM_TOOLS in this test with the reason a free profile may serve it`,
      ).toBe(true);
    }
  });

  it("FREE_SERVED_LLM_TOOLS has no stale entries (each is derived as a sender and is not forbidden)", () => {
    for (const tool of Object.keys(FREE_SERVED_LLM_TOOLS)) {
      expect(derived.has(tool), `${tool} is listed as free-served but no longer reaches chat/completions — drop it`).toBe(true);
      expect(isFreeForbiddenTool(tool), `${tool} is listed as free-served but is free-forbidden — drop it`).toBe(false);
    }
  });
});

// PF-10 (plan section 15, KV2WCFCS conflict). WHY a separate category and not FREE_FORBIDDEN_TOOLS: a classifier tool sends decisions requests on a classifier profile's model, which is billed by design (D2) and has no free tier, so the free-only rule cannot apply to it; but a tool that CAN send a decisions request must still be listed here, so a new one cannot slip in unnoticed.
// Derived from the catalog registry (one `classify_<id>` tool per registered decision spec, the naming rule of unregisteredClassifyTools), never typed by hand.
const CLASSIFIER_TOOLS: ReadonlySet<string> = new Set(DECISION_SPECS.map((spec) => `classify_${spec.id.replaceAll("-", "_")}`));

describe("CLASSIFIER_TOOLS — exempt from the free-only rule: classifiers are paid by design (D2)", () => {
  it("is derived from the registry and not empty", () => {
    expect(CLASSIFIER_TOOLS.size).toBe(DECISION_SPECS.length);
    expect(CLASSIFIER_TOOLS.has("classify_filter")).toBe(true);
  });

  it("no classifier tool is free-forbidden: the free-only rule does not apply to a tool with no free tier", () => {
    for (const tool of CLASSIFIER_TOOLS) {
      expect(FREE_FORBIDDEN_TOOLS, `${tool}: classifiers are paid by design (D2), not a free-forbidden tool`).not.toContain(tool);
      expect(isFreeForbiddenTool(tool), tool).toBe(false);
    }
  });

  it("every tool that can send a decisions request is in CLASSIFIER_TOOLS (section 15)", () => {
    // A tool can send a decisions request when it names the classifier profile type among a restricted set of accepted types (not the "any type" commands such as settings or models, which make no model call), or is named classify_*. WHY the profile type: PT-03 makes `acceptedProfileTypes` the one declaration of which profile a command runs on, and only a classifier profile reaches /decisions. C4-02 must add the classify_* tools with acceptedProfileTypes ["classifier"]; a mixed tool such as `browse run` (typing profile plus decisions profile) lists both and is caught by the same filter.
    const tools = buildTools("") as Array<{ name: string; acceptedProfileTypes: readonly string[] }>;
    const senders = tools.filter((t) => (t.acceptedProfileTypes.includes("classifier") && t.acceptedProfileTypes.length < 5) || t.name.startsWith("classify_")).map((t) => t.name);
    const unlisted = senders.filter((n) => !CLASSIFIER_TOOLS.has(n));
    expect(unlisted, `tools that can send a decisions request but are not in CLASSIFIER_TOOLS (registry: ${[...CLASSIFIER_TOOLS].join(", ")})`).toEqual([]);
  });

  it("every classify_* tool defined in definitions.ts maps to a registered decision spec", () => {
    const names = (buildTools("") as Array<{ name: string }>).map((t) => t.name).filter((n) => n.startsWith("classify_"));
    expect(names.filter((n) => !CLASSIFIER_TOOLS.has(n))).toEqual([]);
  });
});
