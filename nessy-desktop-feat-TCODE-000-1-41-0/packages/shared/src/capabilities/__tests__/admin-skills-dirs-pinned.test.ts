/**
 * P2.455 / P2.461 — no rig in `packages/shared` may let the administrator skill
 * tier default to the machine's own directories.
 *
 * ## The defect, stated as what it does to whoever meets it
 *
 * `loadAllSkills` DEFAULTS to absolute, machine-wide, administrator-provisioned
 * directories (`getAdminAgentSkillsDirs`), and until P2.461
 * `buildNativeCapabilityInventory` did too. A test that leaves either defaulting
 * reads a different set of skills depending on whether the machine running it is
 * centrally managed — so it is green on every developer's laptop and red only on
 * the deployment the tier exists for, with output that looks like a content
 * mismatch (a record count, a name list) rather than a rig defect. That is the
 * most expensive shape a test failure has, which is why P2.449's lane named it
 * instead of leaving it, and why this file exists rather than six pinned call
 * sites alone: pinning fixes today's six, a guard fixes the seventh.
 *
 * ## The required parameter LANDED, and this file is now its backstop (P2.461)
 *
 * This section used to explain why the type-level fix was out of reach. It is
 * not any more. `adminSkillsDirs` is REQUIRED on `NativeSourcesEnv` since
 * P2.461, so a new call site cannot inherit a machine root by omission — the
 * compiler refuses it, per call site, which is the parser a per-file scan could
 * never be. Measured when it landed: sixteen call sites across thirteen files
 * stopped compiling, exactly the count P2.455 predicted —
 * `packages/server-core/src/bootstrap/storage-runtime.ts` (the production
 * caller, which now names `getAdminAgentSkillsDirs()` where it used to inherit
 * it) plus twelve `server-core` test files that injected `nativeSourcesEnv`
 * without the field and were the SAME defect one layer up.
 *
 * The scan stays for three things the type cannot do:
 *
 * - The LOADER half. `loadAllSkills` is called from production paths all over
 *   the tree, so requiring its seam would make every caller restate a default it
 *   has no opinion about. P2.461 gave it an OPTIONAL `adminSkillsDirs` seam
 *   beside the environment lever; either pin satisfies the rule below, and a rig
 *   with neither is still what this guard catches.
 * - A cast. `{...} as NativeSourcesEnv` silences the compiler and not this scan.
 * - The shape itself: the last rule below reads the interface's own source and
 *   fails if the `?` ever comes back, which is the one edit that would silently
 *   un-do everything above.
 *
 * ## What this guard still does NOT cover, said plainly
 *
 * - Granularity is per FILE, not per call site, for the two rules that scan text.
 *   MEASURED while writing this file's own mutants: a rig that keeps the WORD
 *   while dropping the ARGUMENT passes a per-file scan. For the inventory
 *   builder that residue is closed by the required field; for `loadAllSkills` it
 *   is not, and remains the honest limit of a text scan.
 * - Reach is `packages/shared/src` only. The `server-core` rigs named above are
 *   outside it and are held by the compiler rather than by this file.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ADMIN_SKILLS_DIR_ENV, getAdminAgentSkillsDirs } from '../../skills/storage.ts';

/** `packages/shared/src`, resolved from this file rather than from any cwd. */
const SHARED_SRC = fileURLToPath(new URL('../..', import.meta.url));

/** This file itself: it necessarily contains every needle below as a literal. */
const SELF = 'admin-skills-dirs-pinned.test.ts';

function testFilesUnder(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        walk(path);
      } else if (entry.name.endsWith('.test.ts') && entry.name !== SELF) {
        found.push(path);
      }
    }
  };
  walk(dir);
  return found.sort();
}

const TEST_FILES = testFilesUnder(SHARED_SRC);
const SOURCES = new Map(TEST_FILES.map(path => [path, readFileSync(path, 'utf8')]));

/** Repo-relative, POSIX-spelled, so a failure message carries no absolute path. */
const shortName = (path: string): string => relative(SHARED_SRC, path).split(sep).join('/');

/** Absolute paths, so no name has to survive a round trip back through `join`. */
const filesContaining = (needle: string): string[] =>
  TEST_FILES.filter(path => SOURCES.get(path)!.includes(needle));

/** The same set, named for a failure message. */
const named = (paths: readonly string[]): string[] => paths.map(shortName);

describe('the scan itself can see and can report an absence', () => {
  it('walked the package and found the files this guard is about', () => {
    // Positive control by NAME, not by count: a walker that returned nothing —
    // or that stopped at the first directory — would make every assertion below
    // vacuously green, and a hand-written count would be its own drift.
    expect(TEST_FILES.length).toBeGreaterThan(100);
    expect(named(filesContaining('buildNativeCapabilityInventory(')))
      .toContain('capabilities/__tests__/native-sources.test.ts');
    expect(named(filesContaining('loadAllSkills(')))
      .toContain('skills/__tests__/storage.test.ts');
  });

  it('reports an empty set for a token that is not there', () => {
    // The negative control the two absence claims below need: the matcher is
    // capable of answering "none", so an empty failure list means something.
    expect(named(filesContaining('noSuchSymbolInThisPackage_P2_455'))).toEqual([]);
  });
});

describe('the administrator roots this guard exists to keep out of a rig', () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[ADMIN_SKILLS_DIR_ENV];
  });

  afterEach(() => {
    // `delete` first, then assign: assigning over an existing name in Bun 1.3.14
    // can leave it readable by property and invisible to a spread, and every
    // subprocess env in this tree is built by spreading `process.env`.
    delete process.env[ADMIN_SKILLS_DIR_ENV];
    if (saved !== undefined) process.env[ADMIN_SKILLS_DIR_ENV] = saved;
  });

  it('defaults to absolute machine-wide directories, which is the whole hazard', () => {
    // Read as STRINGS only. Nothing here touches the filesystem, resolves a
    // symlink, or executes a path — the point is that these paths come from the
    // host rather than from any fixture, which is exactly what makes a
    // defaulting rig machine-dependent.
    delete process.env[ADMIN_SKILLS_DIR_ENV];
    const defaults = getAdminAgentSkillsDirs();

    expect(defaults.length).toBeGreaterThan(0);
    for (const root of defaults) expect(isAbsolute(root)).toBe(true);

    // And the operator's off switch is the same lever a rig should not need:
    // with it set empty the tier is inert, which is what `adminSkillsDirs: []`
    // reproduces for one inventory pass without touching the environment.
    delete process.env[ADMIN_SKILLS_DIR_ENV];
    process.env[ADMIN_SKILLS_DIR_ENV] = '';
    expect(getAdminAgentSkillsDirs()).toEqual([]);
  });
});

describe('every rig in packages/shared pins the administrator tier', () => {
  it('passes adminSkillsDirs at every buildNativeCapabilityInventory call site', () => {
    const unpinned = named(filesContaining('buildNativeCapabilityInventory(')
      .filter(path => !SOURCES.get(path)!.includes('adminSkillsDirs')));

    // `admin-skill-tier-catalog.test.ts` is the ONE file that drives the default
    // path on purpose — its off-switch case is the only assertion an operator's
    // lever actually has — and it names the seam in the same file, so it is
    // pinned by this rule rather than excused from it.
    expect(unpinned).toEqual([]);
  });

  it('pins the administrator roots at every loadAllSkills call site', () => {
    // The second loader takes an OPTIONAL seam (P2.461) beside the environment
    // lever, because it is called from production paths all over the tree and a
    // required field there would make every caller restate a default it has no
    // opinion about. So a rig has two ways to be machine-independent here and
    // this rule accepts either — what it refuses is neither.
    //
    // Every spelling counts: `storage.test.ts` imports the CONSTANT and never
    // writes the variable's value, so a literal-only needle would report it
    // unpinned when it is pinned — a guard that cries wolf once stops being run.
    const unpinned = named(filesContaining('loadAllSkills(').filter(path => {
      const text = SOURCES.get(path)!;
      return !text.includes(ADMIN_SKILLS_DIR_ENV)
        && !text.includes('ADMIN_SKILLS_DIR_ENV')
        && !text.includes('adminSkillsDirs');
    }));

    expect(unpinned).toEqual([]);
  });
});

describe('the type-level half of the same rule (P2.461)', () => {
  // The compiler is what actually enforces this, at every call site in the
  // monorepo rather than in this package alone. What a compiler cannot do is
  // notice that someone made the field optional again — that edit compiles
  // perfectly and silently restores a machine-root default at sixteen sites. So
  // the interface's own source is read here, which is the only artefact that
  // states the requiredness.
  const NATIVE_SOURCES = readFileSync(join(SHARED_SRC, 'capabilities', 'native-sources.ts'), 'utf8');

  it('declares adminSkillsDirs as a REQUIRED field on NativeSourcesEnv', () => {
    // Positive control first: the needle can find a sibling that IS optional, so
    // a miss below means "not optional" rather than "regex found nothing".
    expect(NATIVE_SOURCES).toContain('nestedSkillRoots?: readonly string[];');

    expect(NATIVE_SOURCES).toContain('adminSkillsDirs: readonly string[];');
    expect(NATIVE_SOURCES).not.toContain('adminSkillsDirs?:');
  });

  it('leaves no machine-root default inside the builder', () => {
    // The default this row removed, spelled exactly as it was. If it comes back
    // the required field above is cosmetic: every rig would satisfy the type by
    // passing `undefined`.
    expect(NATIVE_SOURCES).not.toContain('env.adminSkillsDirs ??');
    expect(NATIVE_SOURCES).not.toContain('env: NativeSourcesEnv = {}');
  });
});
