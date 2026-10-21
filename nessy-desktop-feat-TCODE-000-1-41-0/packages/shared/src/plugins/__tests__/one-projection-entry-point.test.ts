/**
 * ONE projection entry point for the capability pipeline.
 *
 * F1's defect was not a coding slip. The plugin-hook `mcpTool` wire-name
 * translation was written, tested and reviewed — and wired into
 * `resolvePluginProjectionPlan`, the V1 projection, while every real install
 * resolves through `resolvePluginProjectionCandidates`. The pass existed and
 * never ran. Live verification (2026-08-10/11) is what found it, because nothing
 * in the type system or the test suite can tell a correct pass on the wrong road
 * from a correct pass on the right one.
 *
 * F4 deleted the second road. This file is the net that keeps it deleted: a
 * second projection is how the NEXT translation pass ends up attached to a road
 * nobody drives, and the cost is paid in production, months later, by whoever has
 * to reproduce it live.
 *
 * The failure mode this guards is a NEW function, not a resurrected name — so the
 * census below is by SHAPE (any exported `*Projection*` declaration), with the
 * retired names pinned separately as a second, named net. The shape check and the
 * name check are both here because neither covers the other.
 *
 * What each half actually covers, so a reader does not assume more:
 *
 * - The SHAPE census reads `PROJECTION_SOURCE_ROOTS` — the plugin and capability
 *   sources plus the two server packages, which is where the live consumer sits
 *   (`packages/server-core/src/bootstrap/storage-runtime.ts` calls the entry
 *   point). `apps/electron/src` is deliberately NOT in that list: the renderer
 *   carries its own unrelated `*Projection*` UI builders, and folding them in
 *   would make this guard fail for reasons that have nothing to do with plugin
 *   projection. A projection entry point added under `apps/` is therefore out of
 *   scope for the shape census.
 * - The RETIRED-NAME check reads the wider `PRODUCTION_ROOTS`, apps included,
 *   because a resurrected call can be made from anywhere.
 * - Neither half sees a projection entry point deliberately named without the
 *   word `Projection`, and neither sees one declared in a non-`.ts` source. Those
 *   are the known limits of a source scan.
 *
 * The shape census asks "could this be a ROAD?", not "does this name contain the
 * word" (2026-09-03, P3.284). A road is CALLABLE. `projection` has a second,
 * unrelated sense in this tree — projecting host-authored hooks into codex's
 * `[hooks]` table — and `capabilities/views.ts` exports
 * `CODEX_HOOK_PROJECTION_DIAGNOSTIC_CODE`, a diagnostic-code STRING that nothing
 * can resolve a plugin through. The gate failed on it, and a gate that is red has
 * stopped discriminating, so the census now splits the two.
 *
 * The split is fail-CLOSED: ONLY a binding initialised to a primitive literal is
 * exempt. A function, a class, an arrow, a call expression, an identifier, an
 * object, a string carrying an escape, or a re-export whose shape this scan
 * cannot see all stay in the gate — the guard would rather flag a constant than
 * miss a road. The literal half is PINNED by its own test rather than dropped, so
 * a new one costs a visible, deliberate line, and a red there says "a constant was
 * named" instead of "a second road appeared". Those are different emergencies and
 * the failure output now says which.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as pluginApi from '../index.ts';

const WHY = 'a second projection entry point is how a translation pass ends up attached to a road nobody drives (F1)';

/** The one entry point the capability pipeline resolves plugins through. */
const ENTRY_POINT = 'resolvePluginProjectionCandidates';

/**
 * Names that WERE a second entry point. `resolvePluginProjectionPlan` is the one
 * F1's translation was attached to; the other three are the rest of the V1 chain
 * that read its output.
 */
const RETIRED_ENTRY_POINTS = [
  'resolvePluginProjectionPlan',
  'loadPluginProjectionPlan',
  'buildTrustedPluginHookAutomations',
  'createHookRegistryFromProjection',
];

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..', '..');

/**
 * Where a plugin projection could plausibly live. The two server packages are in
 * the list because the live consumer is one of them
 * (`packages/server-core/src/bootstrap/storage-runtime.ts`), so a second entry
 * point grown next to the caller is exactly as dangerous as one grown next to the
 * definition. See the file header for why `apps/` is not here.
 */
const PROJECTION_SOURCE_ROOTS = [
  join(REPO_ROOT, 'packages', 'shared', 'src', 'plugins'),
  join(REPO_ROOT, 'packages', 'shared', 'src', 'capabilities'),
  join(REPO_ROOT, 'packages', 'server-core', 'src'),
  join(REPO_ROOT, 'packages', 'server', 'src'),
];

/** Where a production module could plausibly CALL one. */
const PRODUCTION_ROOTS = [
  join(REPO_ROOT, 'packages', 'shared', 'src'),
  join(REPO_ROOT, 'packages', 'server-core', 'src'),
  join(REPO_ROOT, 'packages', 'server', 'src'),
  join(REPO_ROOT, 'apps', 'electron', 'src'),
  join(REPO_ROOT, 'apps', 'cli', 'src'),
];

function isProductionSource(path: string): boolean {
  // No `__tests__` clause: the walk below never descends into one, and the
  // separator-hardcoding version that used to be here was dead on every platform.
  return path.endsWith('.ts')
    && !path.endsWith('.d.ts')
    && !path.endsWith('.test.ts')
    && !path.endsWith('.isolated.ts');
}

function productionSourcesUnder(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      if (name === 'node_modules' || name === 'dist' || name === '__tests__') continue;
      const path = join(directory, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (isProductionSource(path)) found.push(path);
    }
  };
  walk(root);
  return found;
}

// Several source files in this repo carry a NUL byte, which makes plain
// grep/rg skip them SILENTLY. `readFileSync` does not, which is why this test
// reads the files itself rather than shelling out.
function read(path: string): string {
  return readFileSync(path, 'utf-8');
}

/**
 * A primitive-literal initialiser — the ONLY shape exempt from the road census.
 * Anything else, including a string carrying a backslash escape, falls through to
 * `callable` on purpose: this predicate decides what the guard stops looking at.
 */
const PRIMITIVE_LITERAL_INITIALIZER =
  /^\s*(?:'[^'\\]*'|"[^"\\]*"|`[^`$\\]*`|-?\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?n?|true|false|null|undefined)\s*(?:;|$)/;

/** What the census found in one source, split by whether it could be a road. */
interface ProjectionDeclarations {
  /** Could be an entry point. The gate is on this half. */
  callable: string[];
  /** Provably not an entry point: an exported binding holding a primitive. */
  literal: string[];
}

/**
 * Exported runtime declarations (and named exports/re-exports) whose name
 * mentions projection, split by callability.
 *
 * The form list is the whole point: a guard a new entry point can slip past is
 * the failure mode this file exists to prevent, so every shape the repo actually
 * writes has to be here. `let`/`var` and bare `export { name }` with no `from`
 * (live house style — e.g. `packages/shared/src/agent/core/path-processor.ts`)
 * and `export default` were all invisible to the first version of this census.
 */
function classifyProjectionDeclarations(source: string): ProjectionDeclarations {
  const found: ProjectionDeclarations = { callable: [], literal: [] };
  const add = (name: string | undefined, isLiteral: boolean): void => {
    if (!name || !name.toLowerCase().includes('projection')) return;
    (isLiteral ? found.literal : found.callable).push(name);
  };

  for (const match of source.matchAll(/^export\s+(?:async\s+)?(function|const|class|let|var)\s+([A-Za-z0-9_$]+)([^\n]*)$/gm)) {
    const isBinding = match[1] === 'const' || match[1] === 'let' || match[1] === 'var';
    // Skip an optional type annotation, then read the initialiser. A `function`
    // or `class` never reaches the literal branch whatever follows its name.
    const initializer = match[3]!.match(/^\s*(?::[^=]*)?=(.*)$/);
    add(match[2], isBinding && initializer !== null && PRIMITIVE_LITERAL_INITIALIZER.test(initializer[1]!));
  }
  // `export default function foo`, `export default class Foo`, `export default foo`.
  for (const match of source.matchAll(/^export\s+default\s+(?:async\s+)?(?:function\*?|class)?\s*([A-Za-z0-9_$]+)/gm)) {
    add(match[1], false);
  }
  // Both `export { a, b as c } from '…'` and the bare `export { a, b as c };`.
  // The shape behind the name is not visible here, so these are never exempt.
  for (const match of source.matchAll(/^export\s+\{([^}]*)\}/gm)) {
    for (const part of match[1]!.split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name && !name.startsWith('type ')) add(name, false);
    }
  }
  return found;
}

/**
 * Exported `*Projection*` names that are provably NOT roads, each with the reason
 * it carries the word. Pinned so adding one is deliberate and reviewable.
 *
 * `CODEX_HOOK_PROJECTION_DIAGNOSTIC_CODE` (`capabilities/views.ts`, `e2707e0c2`)
 * is the catalog diagnostic code for the OTHER sense of projection — host-authored
 * hooks projected into codex's `[hooks]` table (P2.414). It is a string.
 */
const LITERAL_PROJECTION_NAMES = ['CODEX_HOOK_PROJECTION_DIAGNOSTIC_CODE'];

describe('the capability pipeline has one plugin projection entry point', () => {
  // The census IS the guard, so its blind spots are the guard's blind spots.
  // Every form here is one a second entry point could be declared in; three of
  // them (bare `export {}`, `export default`, `export let/var`) were invisible
  // to the first version and would have let a new projection through silently.
  it('counts every export form a second entry point could be declared in', () => {
    const source = [
      "export function resolveAProjection() {}",
      "export async function resolveBProjection() {}",
      "export const cProjection = () => {};",
      "export let dProjection = makeProjection();",
      "export var eProjection = { run() {} };",
      "export class FProjection {}",
      "export default function gProjection() {}",
      "export { hProjection };",
      "export { iProjection } from './x.ts';",
      "export { jRaw as kProjection };",
      "export const lProjection = resolvePluginProjectionCandidates;",
      "export const mProjection: Builder = function () {};",
      "export type { NotAProjection } from './y.ts';",
      "const unexportedProjection = 1;",
    ].join('\n');

    expect(classifyProjectionDeclarations(source).callable.sort()).toEqual([
      'FProjection', 'cProjection', 'dProjection', 'eProjection', 'gProjection',
      'hProjection', 'iProjection', 'kProjection', 'lProjection', 'mProjection',
      'resolveAProjection', 'resolveBProjection',
    ]);
  });

  // The exemption is the part that can reopen the hole, so it is tested from
  // both sides: what it lets through, and what it must NOT.
  it('exempts only a binding initialised to a primitive literal', () => {
    const exempt = [
      "export const aProjection = 'code.string';",
      'export const bProjection = "code.string";',
      "export const cProjection = `code.string`;",
      "export const dProjection = 42;",
      "export const eProjection = -1.5e3;",
      "export let fProjection = true;",
      "export var gProjection = null;",
      "export const hProjection: string = 'annotated';",
    ].join('\n');
    const classified = classifyProjectionDeclarations(exempt);
    expect(classified.callable).toEqual([]);
    expect(classified.literal.length).toBe(8);

    // Fail-closed cases: each is a shape the scan cannot prove inert.
    const notExempt = [
      "export const iProjection = `interpolated ${x}`;",
      "export const jProjection = 'has \\' escape';",
      "export const kProjection = [1, 2];",
      "export const lProjection = 'multi' +",
    ].join('\n');
    expect(classifyProjectionDeclarations(notExempt).literal).toEqual([]);
    expect(classifyProjectionDeclarations(notExempt).callable.length).toBe(4);
  });

  it(`exposes ${ENTRY_POINT} as a callable export of the plugins package`, () => {
    const api = pluginApi as unknown as Record<string, unknown>;
    expect(Object.keys(api)).toContain(ENTRY_POINT);
    expect(typeof api[ENTRY_POINT]).toBe('function');
  });

  function censusAcrossProjectionSources(): { callable: Map<string, string[]>; literal: Map<string, string[]> } {
    const callable = new Map<string, string[]>();
    const literal = new Map<string, string[]>();
    for (const root of PROJECTION_SOURCE_ROOTS) {
      for (const path of productionSourcesUnder(root)) {
        const found = classifyProjectionDeclarations(read(path));
        const where = path.slice(REPO_ROOT.length + 1);
        for (const name of found.callable) callable.set(name, [...(callable.get(name) ?? []), where]);
        for (const name of found.literal) literal.set(name, [...(literal.get(name) ?? []), where]);
      }
    }
    return { callable, literal };
  }

  it('declares exactly one projection entry point across the plugin and capability sources', () => {
    const { callable } = censusAcrossProjectionSources();

    // Reported as `<name> in <file> — <why>` so the failure names the offender
    // AND the reason, rather than printing two bare arrays.
    const second = [...callable.entries()]
      .filter(([name]) => name !== ENTRY_POINT)
      .map(([name, files]) => `${name} in ${files.join(', ')} — ${WHY}`);

    expect(second).toEqual([]);
    // Positive control: the census can see the entry point it is allowing, so an
    // empty `second` cannot come from a scan that matched nothing at all.
    expect([...callable.keys()]).toEqual([ENTRY_POINT]);
    // Same measured budget as the tree-wide case below, and for the same reason:
    // this census walks the plugin and capability sources plus both server
    // packages. Measured 2026-09-04 at 5.5 s inside a 114-file batch against
    // bun's 5 s default — a case that is red because it is BIG, not because it
    // is broken.
  }, 60_000);

  // A red HERE is bookkeeping, not an emergency: a name was added that carries
  // the word `projection` and provably holds a primitive. Confirm it is not a
  // road, then add it to LITERAL_PROJECTION_NAMES with its reason.
  it('has no unpinned non-road carrying the word projection', () => {
    const { literal } = censusAcrossProjectionSources();
    const unpinned = [...literal.entries()]
      .filter(([name]) => !LITERAL_PROJECTION_NAMES.includes(name))
      .map(([name, files]) => `${name} in ${files.join(', ')} — not a road, so pin it in LITERAL_PROJECTION_NAMES with the reason it carries the word`);

    expect(unpinned).toEqual([]);
    // A pinned name that has been deleted or renamed should lose its pin.
    expect([...literal.keys()].sort()).toEqual([...LITERAL_PROJECTION_NAMES].sort());
    // Same census, same walk, same budget.
  }, 60_000);

  /**
   * An EXPLICIT budget, set against a measured floor rather than left on bun's
   * 5 s default (AGENTS.md: a timeout with zero assertion failures is a
   * different defect from a starved suite, and the fix for the profiled kind is
   * a budget, never zero).
   *
   * This case is the only one here that reads all five `PRODUCTION_ROOTS`,
   * `apps/electron/src` included — every production `.ts` in the tree, then a
   * regex per retired name per file. Measured 2026-09-04 running ALONE:
   * **16.4 s at load 6.58**, and 17.2 s inside a 113-file batch. So it is not
   * contention; the work simply costs more than the default allows, and it has
   * been failing for that reason.
   *
   * 60 s is ~3.5x the measured floor: enough headroom that a loaded box does not
   * make it red, small enough that a scan which genuinely hangs still fails.
   */
  it('has no production module left speaking a retired projection entry point', () => {
    const offenders: string[] = [];
    for (const root of PRODUCTION_ROOTS) {
      for (const path of productionSourcesUnder(root)) {
        const source = read(path);
        for (const retired of RETIRED_ENTRY_POINTS) {
          // Declaration or call — a bare mention inside a comment is prose about
          // history and is deliberately not a failure, so require a `(` or `=`.
          if (new RegExp(`\\b${retired}\\s*[(=]`).test(source)) {
            offenders.push(`${retired} in ${path.slice(REPO_ROOT.length + 1)} — ${WHY}`);
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  }, 60_000);
});
