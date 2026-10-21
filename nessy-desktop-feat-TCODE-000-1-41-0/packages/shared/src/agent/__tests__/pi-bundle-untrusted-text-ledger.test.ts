import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * P2.87 — the packaged Pi bundle inlines a copy of `untrusted-text.ts`, and the
 * rebuild that copy depends on is a DIFFERENT command from the one every
 * `pi-agent.ts` row in this plan owes.
 *
 * The row arrived as "the packaged bundle inlines a stale `untrusted-text`",
 * which reads like a divergence. It is not. Measured, both directions, with
 * string-literal controls (a bundler renames symbols but never rewrites a
 * literal, so this is decisive rather than circumstantial):
 *
 *  - There is exactly ONE `untrusted-text` source file in this repo. Nothing is
 *    vendored, nothing is duplicated, so "the bundle disagrees with the source"
 *    can only ever mean "the bundle is older than the source". That is the first
 *    assertion below, and it is the one that makes the whole question a REBUILD
 *    question forever.
 *  - The bundle really did lag: `renderTranscriptEntry`,
 *    `neutralizeTranscriptEntryOpeners` and the `(?:User|Assistant|Human|System)`
 *    opener pattern — all added 2026-08-23 at 17:58 — were absent from both
 *    `packages/pi-agent-server/dist/index.js` and
 *    `apps/electron/resources/pi-agent-server/index.js`, which were built that
 *    same day at 01:43. Meanwhile `scanSubagentOutput` (12 hits),
 *    `subagentReportMarkerLine` (4) and `neutralizeHarnessMarkers` (2) were
 *    present in both, which is the positive control proving the module IS
 *    inlined and the absence above is staleness rather than a missing import.
 *  - And the lag had a second source beyond "nobody ran the build".
 *    `scripts/electron-dev.ts` REBUILDS `packages/pi-agent-server/dist/index.js`
 *    on every dev launch, and at the time above it did not restage
 *    `apps/electron/resources/pi-agent-server/`. Measured mtimes: staged
 *    01:43:04, dist 01:43:56 — the staged copy was one build behind the dist.
 *
 *    THE ~20KB GAP'S CAUSE, AS STATED HERE, WAS WRONG (corrected by P2.248).
 *    This block used to explain it as "the dev rebuild is a bare `bun build`,
 *    not `pi-agent-server`'s own `build` script", which pointed the next reader
 *    at a divergence that does not exist. There is only ONE recipe: both paths
 *    call the exported `buildPiAgentServerBundle` in `scripts/build/common.ts`,
 *    which `scripts/electron-dev.ts` imports precisely so a second spelling
 *    cannot exist. The gap is two measured properties of `bun build` itself,
 *    recorded on that function on 2026-08-27:
 *      · it writes each module's path RELATIVE TO THE CWD into a comment, so
 *        the identical source built from `packages/pi-agent-server` rather than
 *        the repo root differs by ~20,000 bytes of `../../` prefixes across the
 *        same 4,477 modules — "the bulk of the 20,014-byte gap P2.193 arrived
 *        as, and it is not drift";
 *      · it is not reproducible — the same command line, same cwd, same outdir,
 *        same source, run twice, alternates between two stable images 47 bytes
 *        and 100 hunks apart, every hunk an identifier-suffix counter.
 *    Neither is drift, and neither is a rebuild anyone owes.
 *
 * WHAT THIS FILE MAKES TESTABLE, rather than leaving as a note nobody reads:
 *
 *  1. divergence stays impossible (one source file);
 *  2. the SHIPPED SURFACE is pinned — the Pi orchestrator imports exactly three
 *     functions from that module, and the day it imports a fourth the rebuild
 *     dependency has widened and this file says so;
 *  3. whenever a built bundle is present, it must carry the CURRENT source's
 *     literals for that shipped surface. Today it does, which is the row's own
 *     "no functional drift" claim as an assertion instead of a sentence — P2.53
 *     changed `renderTranscriptEntry`, which the Pi side does not import. The
 *     day someone edits `scanSubagentOutput` and does not run
 *     `bun run electron:build:servers`, this fails.
 *
 * Deliberately NOT asserted HERE: that the staged copy equals the dist.
 *
 * The REASON is no longer the one this block used to give ("It does not today").
 * That equality IS asserted now, in the one place where hashing is sound:
 * `copyPiAgentServer` calls `assertStagedPiMatchesDist` on the way out
 * (`scripts/build/common.ts`), comparing a copy against the exact file it was
 * just copied FROM, and `scripts/electron-dev-staging.test.ts` pins that.
 *
 * It stays out of THIS file for a different reason: the two artifacts can be
 * unequal on a working tree with nothing wrong, because `cd
 * packages/pi-agent-server && bun run build` rebuilds the dist and does not
 * restage. Measured on this tree 2026-08-29 — dist 27,140,123 bytes (mtime
 * 08-28 21:55) against staged 27,115,766 (08-27 17:09), 211 diff hunks apart: a
 * restage away, not a defect. So a hash comparison here would fail for a reason
 * outside this row's scope, which is a broken window; and per the note on
 * `assertStagedPiMatchesDist`, hashing two INDEPENDENTLY built bundles is a coin
 * flip rather than a staleness test. Both artifacts are checked INDEPENDENTLY
 * against the source's LITERALS instead.
 */

/**
 * The two cases below walk real directories with `readdirSync`/`statSync`, so
 * their wall time is the filesystem's, not the assertion's. Both have already
 * blown bun's 5s default under mutex contention while the tree was unchanged —
 * P2.193's review measured `imports exactly the three functions` at 7.39s and
 * then 0.68s on the SAME tree and commit. A timeout that a healthy run can trip
 * manufactures a failure the register will misattribute to the code under test,
 * so both walkers get an explicit, generous one. It is a floor on the machine,
 * never a bound on the assertion: nothing here should take seconds, and if one
 * of these ever approaches this ceiling the walk itself has changed.
 *
 * The number is sized from the COLD cache, not the warm one, because that is
 * this suite's resting state on a machine that has not just run it: measured
 * 2026-08-29, the four cases took 61.48s on a cold filesystem cache and 4.75s
 * on the immediately following warm run — same tree, same commit, 13x. A knob
 * set at the cold total would manufacture its own failure, which is the trap
 * this constant exists to avoid rather than to re-enact.
 */
const FS_WALK_TIMEOUT_MS = 120_000;

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..', '..');
const UNTRUSTED_TEXT = join(REPO_ROOT, 'packages', 'shared', 'src', 'prompts', 'untrusted-text.ts');
const PI_SERVER_SRC = join(REPO_ROOT, 'packages', 'pi-agent-server', 'src');

/** The two artifacts that inline this module, and the command each is owed by. */
const PI_BUNDLES = [
  { path: join(REPO_ROOT, 'packages', 'pi-agent-server', 'dist', 'index.js'), owedBy: 'cd packages/pi-agent-server && bun run build' },
  { path: join(REPO_ROOT, 'apps', 'electron', 'resources', 'pi-agent-server', 'index.js'), owedBy: 'bun run electron:build:servers' },
];

/**
 * What `pi-agent-server`'s SHIPPED code imports from `untrusted-text`.
 *
 * It was three names until `a266eba9f` (2026-09-06) fenced the search-citation
 * branch's snippets and `af589fdb5`/`7a459959b` fenced the fetched page, all
 * three through `wrapUntrusted`. That is exactly the growth the second case
 * below exists to report: the set of source changes owing
 * `electron:build:servers` is wider now, and every literal reachable from
 * `wrapUntrusted` joins the ledger the bundle-freshness case checks. Widening
 * this list is the ACT of accepting that, not a way around the red.
 */
const SHIPPED_SURFACE = [
  'scanSubagentOutput',
  'scanSubagentReport',
  'subagentReportMarkerLine',
  'wrapUntrusted',
];

const SKIP_DIRS = new Set(['node_modules', 'dist', 'release', '.git', '.references', 'out', 'build', 'coverage']);

function walk(dir: string, hits: string[]): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return hits;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) walk(full, hits);
    // A `.test.` file is not a copy: it does not ship (F1.1139; prose in format-tolerant-tags.test.ts).
    else if (/^untrusted-text\b.*\.(ts|tsx|js|mjs|cjs)$/.test(entry) && !entry.includes('.test.')) hits.push(full);
  }
  return hits;
}

/** Drop comments so a literal quoted in a docblock cannot enter the ledger. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => !line.trim().startsWith('//'))
    .join('\n');
}

/** The body of `name`, by brace matching from its declaration. */
function declarationBody(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) return '';
  let depth = 0;
  let seenOpen = false;
  for (let index = source.indexOf('{', start); index < source.length; index += 1) {
    if (source[index] === '{') {
      depth += 1;
      seenOpen = true;
    } else if (source[index] === '}') {
      depth -= 1;
      if (seenOpen && depth === 0) return source.slice(start, index + 1);
    }
  }
  return source.slice(start);
}

/**
 * Every string and regex literal reachable from the shipped surface: the three
 * function bodies, plus the module-level declaration of every identifier they
 * name, one level deep and then transitively.
 *
 * Deliberately literal-based rather than symbol-based. A bundler may rename
 * `scanSubagentOutput`, and this repo has already been burned by treating a
 * symbol's presence as evidence; it will never rewrite the text inside a string
 * or the source of a regex.
 */
function shippedLiterals(source: string): string[] {
  const stripped = stripComments(source);
  const wanted = new Set(SHIPPED_SURFACE);
  const closure: string[] = [];
  const resolved = new Set<string>();
  while (wanted.size > 0) {
    const name = [...wanted][0]!;
    wanted.delete(name);
    if (resolved.has(name)) continue;
    resolved.add(name);
    let text = declarationBody(stripped, name);
    if (!text) {
      // A module-level `const NAME = …;` — take the whole statement, which may
      // span lines (the multi-line `new RegExp(...)` constants do).
      const match = new RegExp(`\\bconst ${name}\\b[\\s\\S]*?;\\n`).exec(stripped);
      text = match ? match[0] : '';
    }
    if (!text) continue;
    closure.push(text);
    for (const identifier of text.match(/\b[A-Za-z_$][A-Za-z0-9_$]*\b/g) ?? []) {
      if (identifier === name || resolved.has(identifier)) continue;
      if (new RegExp(`\\b(const|function) ${identifier}\\b`).test(stripped)) wanted.add(identifier);
    }
  }
  const body = closure.join('\n');
  const literals = new Set<string>();
  for (const match of body.match(/'(?:[^'\\\n]|\\.){6,}'/g) ?? []) literals.add(match.slice(1, -1));
  for (const match of body.match(/\/(?:[^/\\\n[]|\\.|\[(?:[^\]\\]|\\.)*\]){6,}\/[gimsuy]*/g) ?? []) literals.add(match);
  // Template literals (F1.1140): F1.1016 builds the tag patterns from one. A
  // bundler keeps the static text but may rename the names in `${…}`, so each
  // placeholder is reduced to `${}` and the entry keeps its backticks;
  // {@link bundleCarries} matches it with any placeholder there. Static text
  // under six characters is skipped, as short quoted strings are.
  for (const template of templateLiterals(body)) {
    const reduced = reduceTemplate(template);
    if (reduced.slice(1, -1).split('${}').join('').length < 6) continue;
    literals.add(reduced.includes('${}') ? reduced : reduced.slice(1, -1));
  }
  return [...literals];
}

/** Every top-level template literal in `source`, backticks included (placeholders scanned by brace depth). */
function templateLiterals(source: string): string[] {
  const found: string[] = [];
  for (let start = source.indexOf('`'); start >= 0; start = source.indexOf('`', start)) {
    let index = start + 1;
    while (index < source.length && source[index] !== '`') {
      if (source[index] === '\\') index += 2;
      else if (source.startsWith('${', index)) index = placeholderEnd(source, index);
      else index += 1;
    }
    found.push(source.slice(start, index + 1));
    start = index + 1;
  }
  return found;
}

/** The index just past the `}` closing the `${` at `open`, counting nested braces. */
function placeholderEnd(source: string, open: number): number {
  let depth = 0;
  for (let index = open + 1; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}' && --depth === 0) return index + 1;
  }
  return source.length;
}

/** A template with each `${…}` reduced to `${}`. */
function reduceTemplate(template: string): string {
  let out = '';
  for (let index = 0; index < template.length;) {
    if (template[index] === '\\') {
      out += template.slice(index, index + 2);
      index += 2;
    } else if (template.startsWith('${', index)) {
      out += '${}';
      index = placeholderEnd(template, index);
    } else {
      out += template[index];
      index += 1;
    }
  }
  return out;
}

/**
 * Whether a built bundle carries one ledger entry. A reduced template matches
 * with any placeholder in each `${}`, and its `\n` escape as either spelling —
 * bun prints a template's `\n` as a real newline. A placeholder matches no
 * backtick, so it cannot run from an unrelated template megabytes earlier and
 * leave the leading fragment unchecked (a dropped `^` read as current).
 */
function bundleCarries(built: string, literal: string): boolean {
  if (!(literal.startsWith('`') && literal.includes('${}'))) return built.includes(literal);
  const escaped = literal.split('${}').map(part =>
    part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll('\\\\n', '(?:\\\\n|\\n)'));
  return new RegExp(escaped.join('\\$\\{[^`]*?\\}')).test(built);
}

describe('the packaged Pi bundle and untrusted-text — the rebuild ledger (P2.87)', () => {
  it('there is exactly one untrusted-text source, so staleness can never be divergence', () => {
    const found = [
      ...walk(join(REPO_ROOT, 'packages'), []),
      ...walk(join(REPO_ROOT, 'apps'), []),
      ...walk(join(REPO_ROOT, 'scripts'), []),
    ];
    // A second copy is the ONE state that would turn every future "the bundle
    // disagrees" into a real investigation instead of a rebuild.
    expect(found).toEqual([UNTRUSTED_TEXT]);
  }, FS_WALK_TIMEOUT_MS);

  it('a test file named after the module is not a copy of it (F1.1139)', () => {
    // The naming rule the walk applies: `untrusted-text*` with a source
    // extension is a copy, unless its name carries `.test.` — a test does not
    // ship and cannot diverge from the bundle. CONTROL: the planted copy below
    // (`untrusted-text-copy.ts`) is still reported, so the skip is not blindness.
    const root = mkdtempSync(join(tmpdir(), 'f1-1139-'));
    try {
      mkdirSync(join(root, '__tests__'));
      for (const name of ['untrusted-text.ts', 'untrusted-text-copy.ts', 'untrusted-text.test.ts', '__tests__/untrusted-text-fences.test.ts']) {
        writeFileSync(join(root, name), '');
      }
      expect(walk(root, []).sort()).toEqual([join(root, 'untrusted-text-copy.ts'), join(root, 'untrusted-text.ts')]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('the Pi orchestrator imports exactly the functions the rebuild ledger names', () => {
    const imported = new Set<string>();
    const sources: string[] = [];
    const collect = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (SKIP_DIRS.has(entry)) continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) collect(full);
        // A `.test.ts` does not ship, so what it imports cannot widen the ledger.
        else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) sources.push(full);
      }
    };
    collect(PI_SERVER_SRC);
    for (const file of sources) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'[^']*untrusted-text\.ts'/g)) {
        for (const name of match[1]!.split(',')) {
          const trimmed = name.trim();
          if (trimmed) imported.add(trimmed);
        }
      }
    }
    // If this fails UPWARD, the set of source changes that owe
    // `electron:build:servers` has grown and P5.4's rebuild list is now wrong.
    expect([...imported].sort()).toEqual([...SHIPPED_SURFACE].sort());
  }, FS_WALK_TIMEOUT_MS);

  it('the literal ledger is not vacuous', () => {
    // The trap this kills: an assertion that passes because the extractor found
    // nothing. A ledger of zero literals would make the freshness test below
    // green against any bundle, including an empty file.
    const literals = shippedLiterals(readFileSync(UNTRUSTED_TEXT, 'utf8'));
    expect(literals.length).toBeGreaterThanOrEqual(5);
    // One named anchor, so the extractor cannot pass by collecting the wrong
    // things: this is the marker sentence `sub-agents.md` specifies and the
    // shipped surface's most load-bearing literal.
    expect(literals.some(literal =>
      literal.includes('harness: subagent output matched instruction-shaped pattern(s):'))).toBe(true);
    // And a literal from the part P2.53 changed must NOT be in the ledger — that
    // part is not imported by the Pi side, which is exactly why P2.53 did not owe
    // a restage. If this flips, the "no functional drift" claim has expired.
    expect(literals.some(literal => literal.includes('User|Assistant|Human|System'))).toBe(false);
    // F1.1140: F1.1016 builds every tag pattern from one TEMPLATE literal in
    // `formatTolerantTagPattern`; its body is in the ledger too, with each
    // `${…}` placeholder reduced to `${}` (a bundler may rename the names).
    expect(literals).toContain('`<${}(\\\\/?)${}(${})\\\\b`');
  });

  it('a reduced template entry matches renamed placeholders and nothing else (F1.1140)', () => {
    const entry = '`<${}(\\\\/?)${}(${})\\\\b`';
    // The shape the bundle prints, with the names a bundler is free to rename.
    expect(bundleCarries('return new RegExp(`<${gap2}(\\\\/?)${gap2}(${alt})\\\\b`, "giu");', entry)).toBe(true);
    // CONTROL: the static body edited (the optional slash dropped) is missing.
    expect(bundleCarries('return new RegExp(`<${gap}(\\\\/)${gap}(${alternation})\\\\b`, "giu");', entry)).toBe(false);
    // CONTROL: a placeholder cannot leave its template. Each prefix below sits
    // in a DIFFERENT template from the rest, as unrelated code puts one
    // megabytes earlier in the real bundle, so an edited leading fragment
    // (here the `<`, or FORGED_MARKER's `^` anchor dropped) reads as missing.
    expect(bundleCarries('a = `<${x}`; b = `(${gap}(\\\\/?)${gap}(${alt})\\\\b`;', entry)).toBe(false);
    expect(bundleCarries('a = `(${x}`; b = `^(${lead}*)\\\\[(?=harness:)`;', '`(${}*)\\\\[(?=harness:)`')).toBe(false);
  });

  it('every built Pi bundle carries the current shipped surface', () => {
    const literals = shippedLiterals(readFileSync(UNTRUSTED_TEXT, 'utf8'));
    const present = PI_BUNDLES.filter(bundle => existsSync(bundle.path));
    if (present.length === 0) {
      // A fresh clone has no artifacts. The ledger itself is still asserted, so
      // this branch cannot silently mean "nothing was checked".
      expect(PI_BUNDLES.map(bundle => bundle.owedBy)).toEqual([
        'cd packages/pi-agent-server && bun run build',
        'bun run electron:build:servers',
      ]);
      return;
    }
    for (const bundle of present) {
      const built = readFileSync(bundle.path, 'latin1');
      const missing = literals.filter(literal => !bundleCarries(built, literal));
      // The message names the command, because the failure mode this catches is
      // someone reading a stale bundle's behaviour as a broken fix.
      expect({ bundle: bundle.path, owedBy: bundle.owedBy, missing }).toEqual({
        bundle: bundle.path,
        owedBy: bundle.owedBy,
        missing: [],
      });
    }
  });
});
