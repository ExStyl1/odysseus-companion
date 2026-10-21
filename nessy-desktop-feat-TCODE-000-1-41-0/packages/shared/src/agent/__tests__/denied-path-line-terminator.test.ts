/**
 * P2.344 (and P2.329's last open site): a `deniedPaths` entry must fire on a
 * path carrying a JS line terminator, and the GRANT built from the same
 * compiler must not move a single path while that happens.
 *
 * ## What was open, measured end-to-end and not at the matcher
 *
 * The row that opened this measured `globToRegex` directly and said so. This
 * file's fixture is the production entry point instead — `shouldAllowToolInMode`
 * with the SHIPPED `deniedPaths` — because "the matcher misses it" and "the
 * product misses it" are different claims and only the second is a defect.
 * Measured at `209e9459a` (darwin, 2026-08-28), one run:
 *
 *   DENIED  Read {file_path: '~/.ssh/id_rsa'}            <- positive control
 *   OPEN    Read {file_path: '~/.ssh/a<LF>b'}            <- the defect
 *   OPEN    Read {file_path: '~/.ssh/a<CR>b'}, U+2028, U+2029
 *   OPEN    Read {file_path: '~/.ssh/a<LF>b/y'}          <- terminator in a DIR
 *   OPEN    the same under `bypassPermissions`
 *
 * So the managed lock `~/.ssh/**` was evadable by one character, in every mode.
 *
 * ## Why the fix could not be one flag, which is why this file exists at all
 *
 * `globToRegex` is BIDIRECTIONAL: `matchesAllowedWritePath` is a GRANT compiled
 * by the same function. An `s` flag would have tightened the deny and widened
 * the grant in the same token — the regression `40d03e4a4` had to repair on the
 * Bash compiler, arriving here by a different road. The compiler now takes an
 * explicit direction, and the assertions below are in two halves for that
 * reason: the deny half proves the hole is closed, and the GRANT half proves
 * nothing moved. Deleting either half destroys the evidence.
 *
 * `config/__tests__/grant-glob-newline-policy.test.ts` is the sibling that holds
 * the same decision for the five compilers outside this file.
 *
 * SAFETY: every path here is DATA handed to a glob matcher. Nothing in this file
 * opens, creates or deletes a file.
 */
import { describe, expect, it, setDefaultTimeout } from 'bun:test';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { matchesAllowedWritePath, matchesToolPattern, shouldAllowToolInMode } from '../mode-manager.ts';

// Same value and reason as `denied-path-tool-vocabulary.test.ts`: `mode-manager`
// is a heavy import and bun's 5s default sits close to its resting cost.
setDefaultTimeout(30_000);

/**
 * Literal characters, built from their code points. `'\n'` written into an
 * ordinary string in a test source is the two-character ESCAPE, which matched
 * even against the broken compiler — a test written with it passes on the bug.
 */
const LF = String.fromCharCode(0x0a);
const CR = String.fromCharCode(0x0d);
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
const TERMINATORS: ReadonlyArray<readonly [string, string]> = [
  ['LF', LF],
  ['CR', CR],
  ['U+2028', LINE_SEPARATOR],
  ['U+2029', PARAGRAPH_SEPARATOR],
];

const HOME = homedir();

function denied(toolName: string, input: Record<string, unknown>, mode = 'default'): boolean {
  const result = shouldAllowToolInMode(toolName, input, mode as never);
  return result.allowed === false && result.denyPathBlocked === true;
}

it('uses literal terminators, so these assertions can fail at all', () => {
  for (const [, terminator] of TERMINATORS) expect(terminator).toHaveLength(1);
  expect(LF).not.toBe(String.raw`\n`);
});

describe('the deniedPaths floor fires through a line terminator', () => {
  it('denies the shipped lock without one (positive control for the instrument)', () => {
    expect(denied('Read', { file_path: join(HOME, '.ssh', 'id_rsa') })).toBe(true);
    expect(denied('Read', { file_path: join(HOME, '.aws', 'credentials') })).toBe(true);
  });

  it('leaves an ordinary path open (negative control, so "true" is not vacuous)', () => {
    expect(denied('Read', { file_path: join(HOME, 'projects', 'app', 'index.ts') })).toBe(false);
    expect(denied('Read', { file_path: `/tmp/a${LF}b.txt` })).toBe(false);
  });

  it.each(TERMINATORS)('denies a %s in the file name under a locked directory', (_label, terminator) => {
    expect(denied('Read', { file_path: join(HOME, '.ssh', `a${terminator}b`) })).toBe(true);
  });

  it.each(TERMINATORS)('denies a %s in a DIRECTORY component the leading wildcard must cross', (_label, terminator) => {
    // `**\/.env` has to cross the terminator on its way down, which is the arm
    // (`.*`) the flag governs.
    expect(denied('Read', { file_path: join(HOME, `p${terminator}q`, 'svc', '.env') })).toBe(true);
    expect(denied('Read', { file_path: join(HOME, '.ssh', `a${terminator}b`, 'id_rsa') })).toBe(true);
  });

  it.each(TERMINATORS)('holds under bypassPermissions too, where the floor is the only thing left (%s)', (_label, terminator) => {
    // `mode-types.ts` documents this floor as holding in EVERY permission mode,
    // so "open under bypass" is not a softer finding than "open under default".
    expect(denied('Read', { file_path: join(HOME, '.ssh', `a${terminator}b`) }, 'bypassPermissions')).toBe(true);
    expect(denied('Write', { file_path: join(HOME, '.ssh', `a${terminator}b`) }, 'bypassPermissions')).toBe(true);
  });

  it.each(TERMINATORS)('reads the Pi argument key as well as the Claude one (%s)', (_label, terminator) => {
    // The vocabulary drift `denied-path-tool-vocabulary.test.ts` pins: Pi sends
    // `path`, Claude sends `file_path`. A fix that reached only one spelling
    // would look done here without it.
    expect(denied('Read', { path: join(HOME, '.ssh', `a${terminator}b`) })).toBe(true);
  });
});

describe('the GRANT compiled by the same function did not move', () => {
  // THE HALF THAT MUST NOT BE DELETED. `0d7af52cd` closed a deny-side newline
  // hole and opened an allow-side auto-approval in the same stroke; `40d03e4a4`
  // repaired it by keeping the two directions apart. These assertions are what
  // makes that separation observable here.

  it('still refuses every terminator on an allowedWritePaths grant', () => {
    expect(matchesAllowedWritePath('/w/build/out.js', ['/w/build/**'])).toBe(true);
    for (const [, terminator] of TERMINATORS) {
      expect(matchesAllowedWritePath(`/w/build/a${terminator}b`, ['/w/build/**'])).toBe(false);
      expect(matchesAllowedWritePath(`/w/a${terminator}b/out.js`, ['/w/**'])).toBe(false);
    }
  });

  it('still refuses one on the bidirectional tool-name seam', () => {
    // `matchesToolPattern` serves `allowedTools` AND `disallowedTools` from one
    // function, so it keeps the grant policy. Handing a bidirectional seam a
    // single flag is exactly the mistake this whole family is about.
    expect(matchesToolPattern('a/b', ['**'], 'test')).toBe('**');
    expect(matchesToolPattern(`a${LF}b`, ['**'], 'test')).toBeNull();
  });
});

describe('the direction is stated at every call site, not defaulted', () => {
  // Source-shape, and deliberately so: the guarantee is about which callers CAN
  // reach which policy, not about one sampled path. It fires if a future edit
  // gives the parameter a default — the shape that let one token serve two
  // directions in the first place.
  const source = readFileSync(join(import.meta.dir, '..', 'mode-manager.ts'), 'utf-8');
  const callSites = source
    .split('\n')
    .filter(line => line.includes('globToRegex(') && !line.trim().startsWith('*'))
    .filter(line => !line.includes('function globToRegex'));

  it('every call passes an explicit policy', () => {
    expect(callSites.length).toBeGreaterThanOrEqual(6);
    for (const line of callSites) {
      expect(line.includes("'cross'") || line.includes("'stop'")).toBe(true);
    }
  });

  it('the compiler itself has no default for it', () => {
    expect(source).toContain('function globToRegex(pattern: string, terminators: GlobTerminatorPolicy): RegExp');
    expect(source).not.toContain('terminators: GlobTerminatorPolicy =');
  });

  it('the two deny-path calls cross and the grant call stops', () => {
    expect(callSites.filter(line => line.includes('normalizeDeniedPathPattern')).length).toBe(2);
    for (const line of callSites.filter(l => l.includes('normalizeDeniedPathPattern'))) {
      expect(line).toContain("'cross'");
    }
    const grantStart = source.indexOf('export function matchesAllowedWritePath');
    expect(grantStart).toBeGreaterThan(-1);
    const grantEnd = source.indexOf('\nfunction ', grantStart + 1);
    // A slice pin with a moved anchor fails OPEN — an empty body contains no
    // `'cross'` and satisfies every `for` below vacuously. Both ends are
    // asserted, and the call count is asserted non-zero, so a rename of either
    // anchor is reported as a rename rather than passing silently. (W3-c, after
    // the sibling shape G-1 measured in `SessionManager.orchestration.test.ts`.)
    expect(grantEnd).toBeGreaterThan(grantStart);
    const grantBody = source.slice(grantStart, grantEnd);
    // The claim is the POLICY at the grant's call site, not the spelling of its
    // argument: P3.128 wrapped the pattern in `normalizeAllowedWritePattern`, an
    // orthogonal change, and this pin read as a policy regression. Asserted as a
    // property of every `globToRegex` call in the body instead, which is what
    // "the grant call stops" actually means.
    const grantCalls = grantBody
      .split('\n')
      .filter(line => line.includes('globToRegex(') && !line.trim().startsWith('*'));
    expect(grantCalls.length).toBeGreaterThanOrEqual(1);
    for (const line of grantCalls) {
      expect(line).toContain("'stop'");
      expect(line).not.toContain("'cross'");
    }
  });
});
