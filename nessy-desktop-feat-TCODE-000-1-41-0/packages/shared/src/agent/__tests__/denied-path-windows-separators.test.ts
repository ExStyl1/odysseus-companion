/**
 * The credential floor on WINDOWS — a platform we ship and had never probed.
 *
 * ## The defect (P3.108)
 *
 * `deniedPaths` is the only read-side credential protection a default install
 * has: isolation is OFF by standing owner decision. On Windows TEN of the
 * nineteen shipped entries denied nothing.
 *
 * `expandHome('~/.ssh/**')` splices in `C:\Users\me`, so the pattern carries
 * backslashes; `globToRegex` escapes each into a LITERAL backslash. The
 * candidate meanwhile goes through `normalizeForComparison`, which rewrites its
 * separators to `/` and lowercases the whole string on win32. Reproduced
 * verbatim at HEAD:
 *
 *   regex     `^C:\\Users\\me\/\.ssh\/.*$`
 *   candidate `c:/users/me/.ssh/id_rsa`            -> false
 *
 * THREE causes, not the two the row named, and each alone is sufficient — the
 * separator, the escape, and the CASE FOLD. Measured: repairing only the
 * separators yields `^C:\/Users\/me\/\.ssh\/.*$`, which still fails against
 * `c:/users/me/.ssh/id_rsa`. A fix that mirrors one transform and not the other
 * would have looked right and shipped the hole.
 *
 * ## What was MEASURED at HEAD, before the fix (2026-08-28)
 *
 * Through the real `shouldAllowToolInMode`, tool `Read`, mode `default`, with a
 * win32 host and home `C:\Users\me`. Per ENTRY, against a candidate only that
 * entry owns:
 *   INERT (10) `~/.ssh/**`, `~/.gnupg/**`, `~/.aws/**`, `~/.config/gcloud/**`,
 *     `~/.azure/**`, `~/.kube/**`, `~/.docker/config.json`,
 *     `~/.git-credentials`, `~/.config/git/credentials`, `~/.netrc`
 *   LIVE  (9)  every `**\/`-anchored entry — they never touch homedir
 * P3.104's container expansion was inert on all six containers for the same
 * reason, so `Grep path=C:\Users\me\.aws` was open too.
 *
 * `C:\Users\me\.aws\credentials` — AWS access keys — was READABLE by an agent
 * on a default Windows install. That is the finding; every "INERT" line above
 * is an assertion below.
 *
 * ## Why the probe mocks `path` and `os` rather than requiring a Windows box
 *
 * The defect is string handling. `normalizeForComparison` calls `resolve()`,
 * which is platform-specific, so a Windows-shaped candidate cannot be driven
 * through the real gate on darwin without win32 path semantics. Mocking `path`,
 * `os.homedir` and `process.platform` gives the composed behaviour end-to-end
 * through the REAL `shouldAllowToolInMode` — not a re-implementation of it.
 * Every mock is restored in `afterAll`.
 *
 * ## The grant boundary
 *
 * `globToRegex` is bidirectional: it also compiles `allowedWritePaths`, a GRANT.
 * P3.104 kept its fix out of the compiler for that reason and this row holds the
 * same line — the deny side gets its own spelling step. §"the grant did not
 * move" asserts that BEHAVIOURALLY, not by reading the diff: the exact pattern
 * this fix makes live on the deny side stays dead on the grant side.
 *
 * SAFETY: every path here is DATA handed to a glob matcher. Nothing in this
 * file opens, creates or deletes a file, and no path below exists on this host.
 */
import { afterAll, beforeAll, describe, expect, it, mock, setDefaultTimeout, spyOn } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as pathModule from 'node:path';
import * as osModule from 'node:os';

import { assertWin32PathMockRestored } from './support/win32-path-mock.ts';
import { relatchHomeDirForTests } from '../../config/home-latch.ts';

// Same value and reason as `credential-read-floor.test.ts`: `shouldAllowToolInMode`
// is a heavy import and bun's 5s default sits close to its resting cost on a
// cold module graph.
setDefaultTimeout(30_000);

// ============================================================
// A win32 host, restored on the way out
// ============================================================

/**
 * SNAPSHOTS, taken before any `mock.module` call.
 *
 * `mock.module` MUTATES the live namespace object of an already-imported module,
 * so `pathModule` itself becomes win32 the moment the mocks below run — and
 * restoring with it would hand back the mock. That is not hypothetical: with the
 * naive restore, `mode-manager-path-boundary.test.ts` (which sorts after this
 * file) failed with `realpath '\var\folders\…'` — six manufactured failures in a
 * neighbouring suite, exactly the amputation the module-mocking rule warns about.
 * These plain copies are the host's real modules and are what `afterAll` puts
 * back.
 */
const hostPath = { ...pathModule };
const hostOs = { ...osModule };
/** The host's own `join`, for reading a real file while `path` is win32. */
const hostJoin = hostPath.join;

/** What `os.homedir()` returns on a stock Windows install. */
const WIN_HOME = 'C:\\Users\\me';

const winPath = {
  ...hostPath.win32,
  win32: hostPath.win32,
  posix: hostPath.posix,
  default: hostPath.win32,
};
const winOs = {
  ...hostOs,
  homedir: () => WIN_HOME,
  default: { ...hostOs, homedir: () => WIN_HOME },
};

// Spread AND restore, per the module-mocking rule: a `mock.module` without a
// spread amputates the module for every later test file, and one without a
// restore is permanent for the process.
mock.module('path', () => winPath);
mock.module('node:path', () => winPath);
mock.module('os', () => winOs);
mock.module('node:os', () => winOs);

/**
 * F1.105 — the LATCH has to move too, and a mock of `os.homedir` no longer
 * reaches the floor's anchor on its own.
 *
 * `mode-manager.ts` expands `~` through `mode-manager-home.ts` symbol
 * `floorHomeDir`, which is `latchedHomeDir()` — a value captured at module
 * import, i.e. from the REAL `os` and before any `mock.module` call in this
 * file. Without this line every `~`-anchored row below compiles against the
 * host's home and this whole file goes red on correct code. It is the same
 * seam `server-core`'s `isolation-home-latch.test.ts` moves for the Pi floor.
 *
 * In a `beforeAll` and NOT at module scope, measured rather than assumed: bun
 * IMPORTS every file of a batch before running any of them, so a module-scope
 * re-latch is live for the whole process and poisons its neighbours — it took
 * `plugin-node-runtime.test.ts`'s dp `HOME` binding to the Windows home, which
 * is the same amputation the module mocks above are spread and restored to
 * avoid.
 */
beforeAll(() => relatchHomeDirForTests(WIN_HOME));

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

afterAll(() => {
  Object.defineProperty(process, 'platform', originalPlatform);
  mock.module('path', () => hostPath);
  mock.module('node:path', () => hostPath);
  mock.module('os', () => hostOs);
  mock.module('node:os', () => hostOs);

  // F1.105 — back to the real home, AFTER the `os` mock is restored and not
  // before it. `relatchHomeDirForTests()` with no argument re-reads
  // `os.homedir()`, so called one line earlier it re-latches to the WINDOWS
  // home permanently — measured: `plugin-node-runtime.test.ts` then binds dp's
  // `HOME` to that value and fails in the batch while passing alone.
  relatchHomeDirForTests();

  // P6.582 — the restore is now PROVEN, not merely intended. This file's
  // restore reads the snapshots and is correct, but nothing checked it, and its
  // sibling `windows-write-grant-probe.test.ts` had the same shape with the
  // WRONG source and looked identical while leaking win32 into every later
  // file. The leaked `join` is then written to disk by whichever unrelated file
  // runs next — the backslash-named directories that appeared in the repository
  // root twice in two days. `pathModule`/`osModule` are the LIVE namespaces,
  // which is deliberately what this reads: `mock.module` mutates them in place,
  // so they are exactly what every later file will get.
  assertWin32PathMockRestored({
    file: 'denied-path-windows-separators',
    livePath: pathModule,
    liveOs: osModule,
    winHome: WIN_HOME,
  });
});

// Imported AFTER the mocks so the module graph captures win32 bindings.
const { classifyDeniedPathPattern, matchesAllowedWritePath, shouldAllowToolInMode } =
  await import('../mode-manager.ts');
const { SAFE_MODE_CONFIG } = await import('../mode-types.ts');

// ============================================================
// Fixtures
// ============================================================

/**
 * The shipped floor, as `SAFE_MODE_CONFIG` carries it. `deniedPaths` is optional
 * on `ModeConfig`; the first assertion below is what makes it non-optional here,
 * so an empty list cannot make this suite vacuously green.
 */
const SHIPPED_DENIED_PATHS: readonly string[] = SAFE_MODE_CONFIG.deniedPaths ?? [];

/** A project on the Windows host. Not under the home directory, on purpose. */
const WIN_PROJECT = 'C:\\proj';

/**
 * One candidate per shipped entry, chosen so that ONLY that entry can claim it —
 * otherwise `**\/id_rsa` would mask `~/.ssh/**` and the table would read as
 * "everything is fine" while ten entries were dead. The key material names are
 * the ones `agent-sdk/secure-deployment.md#read-only-code-mounting` lists.
 */
const ENTRY_PROBES: ReadonlyArray<readonly [entry: string, candidate: string]> = [
  ['**/.env', `${WIN_PROJECT}\\.env`],
  ['**/.env.*', `${WIN_PROJECT}\\.env.local`],
  // `known_hosts`/`secring.gpg`/… rather than `id_rsa`: no other entry owns them.
  ['~/.ssh/**', `${WIN_HOME}\\.ssh\\known_hosts`],
  ['~/.gnupg/**', `${WIN_HOME}\\.gnupg\\secring.gpg`],
  ['~/.aws/**', `${WIN_HOME}\\.aws\\credentials`],
  ['~/.config/gcloud/**', `${WIN_HOME}\\.config\\gcloud\\application_default_credentials.json`],
  ['~/.azure/**', `${WIN_HOME}\\.azure\\msal_token_cache.json`],
  ['~/.kube/**', `${WIN_HOME}\\.kube\\config`],
  ['~/.docker/config.json', `${WIN_HOME}\\.docker\\config.json`],
  ['~/.git-credentials', `${WIN_HOME}\\.git-credentials`],
  ['~/.config/git/credentials', `${WIN_HOME}\\.config\\git\\credentials`],
  // The forge CLIs (P6.197). These three shipped without a probe, so this table
  // was three entries short of the list and the case above it — the instrument's
  // own positive control — was RED at HEAD before P6.674 touched it. That is
  // exactly what that control is for, and it went unread for a week.
  ['~/.config/gh/**', `${WIN_HOME}\\.config\\gh\\hosts.yml`],
  ['~/.config/glab-cli/**', `${WIN_HOME}\\.config\\glab-cli\\config.yml`],
  // Repo-local, not home-anchored: the glab store INSIDE a workspace.
  ['**/.git/glab-cli/**', `${WIN_PROJECT}\\.git\\glab-cli\\config.yml`],
  // Our own two (P6.674). `dp_auth_creds.json` is the JWT nessy-cli and the
  // desktop share; `credentials.enc` is this app's encrypted store, probed
  // OUTSIDE the home directory on purpose because the entry is unprefixed so
  // that a relocated `NESSY_CONFIG_DIR` is covered too.
  ['~/.nessy/**', `${WIN_HOME}\\.nessy\\dp_auth_creds.json`],
  ['**/credentials.enc', `${WIN_PROJECT}\\nessy-agent\\credentials.enc`],
  ['**/.npmrc', `${WIN_PROJECT}\\.npmrc`],
  ['**/.pypirc', `${WIN_PROJECT}\\.pypirc`],
  ['~/.netrc', `${WIN_HOME}\\.netrc`],
  ['**/*-service-account.json', `${WIN_PROJECT}\\gcp-service-account.json`],
  ['**/*.pem', `${WIN_PROJECT}\\certs\\server.pem`],
  ['**/*.key', `${WIN_PROJECT}\\certs\\server.key`],
  // Outside `~/.ssh`, so the `~/.ssh/**` entry cannot answer for these two.
  ['**/id_rsa', `${WIN_PROJECT}\\keys\\id_rsa`],
  ['**/id_ed25519', `${WIN_PROJECT}\\keys\\id_ed25519`],
  // UA1.16 — the t-artifacts registry, under a (relocatable) config dir's workspaces/<id>.
  ['**/workspaces/*/artifacts/registry.json', `${WIN_HOME}\\.nessy-agent\\workspaces\\ws-1\\artifacts\\registry.json`],
];

/** The six `<dir>/**` entries whose CONTAINER P3.104 made denyable. */
const CONTAINER_PROBES: ReadonlyArray<readonly [entry: string, container: string]> = [
  ['~/.ssh/**', `${WIN_HOME}\\.ssh`],
  ['~/.gnupg/**', `${WIN_HOME}\\.gnupg`],
  ['~/.aws/**', `${WIN_HOME}\\.aws`],
  ['~/.config/gcloud/**', `${WIN_HOME}\\.config\\gcloud`],
  ['~/.azure/**', `${WIN_HOME}\\.azure`],
  ['~/.kube/**', `${WIN_HOME}\\.kube`],
  ['~/.nessy/**', `${WIN_HOME}\\.nessy`],
];

/**
 * Must stay open. Without these, "the ten are closed" is also satisfied by a
 * matcher that refuses everything on Windows — which is the failure a
 * separator/case rewrite is most likely to produce.
 */
const MUST_STAY_OPEN: ReadonlyArray<readonly [label: string, path: string]> = [
  ['an ordinary source file', `${WIN_PROJECT}\\src\\index.ts`],
  ['an ordinary manifest', `${WIN_PROJECT}\\package.json`],
  ['a sibling of a denied directory', `${WIN_HOME}\\.ssh-backup\\notes.txt`],
  ['a directory one letter off', `${WIN_HOME}\\.awsx\\thing.txt`],
  ['the parent of a denied subdirectory', `${WIN_HOME}\\.config`],
  ['a sibling under that parent', `${WIN_HOME}\\.config\\gcloudx\\f.json`],
  ['npmrc without the leading dot', `${WIN_PROJECT}\\npmrc`],
  ['a file whose extension only starts like pem', `${WIN_PROJECT}\\notes.pem.txt`],
  ['the home directory itself', WIN_HOME],
];

/** `{ denied, by }` for a `Read`, straight off the real gate's own reason line. */
function verdict(path: string): { denied: boolean; by: string | null } {
  const result = shouldAllowToolInMode('Read', { file_path: path }, 'default');
  if (result.allowed === false && result.denyPathBlocked === true) {
    const matched = /pattern (.+)\)\.$/.exec(result.reason ?? '');
    return { denied: true, by: matched?.[1] ?? null };
  }
  return { denied: false, by: null };
}

// ============================================================
// The nineteen shipped entries, one verdict each
// ============================================================

describe('every shipped deniedPaths entry denies something on Windows', () => {
  it('the probe table covers the whole shipped list, once each', () => {
    // Positive control for the INSTRUMENT: if an entry is added to the floor and
    // not to this table, the Windows verdict for it is simply never taken.
    expect(ENTRY_PROBES.map(([entry]) => entry)).toEqual([...SHIPPED_DENIED_PATHS]);
  });

  it.each(ENTRY_PROBES)('%s denies %s', (entry, candidate) => {
    const { denied, by } = verdict(candidate);
    expect(denied).toBe(true);
    // Not merely "something denied it" — THIS entry did. Ten of these were the
    // defect and two more would have been masked by a neighbouring entry.
    expect(by).toBe(entry);
  });
});

describe('the container of a <dir>/** entry is denied on Windows too (P3.104)', () => {
  it.each(CONTAINER_PROBES)('%s denies the directory %s', (entry, container) => {
    const { denied, by } = verdict(container);
    expect(denied).toBe(true);
    expect(by).toBe(entry);
  });

  it('Grep and Glob cannot be rooted at a denied directory', () => {
    for (const tool of ['Grep', 'Glob']) {
      const result = shouldAllowToolInMode(tool, { path: `${WIN_HOME}\\.aws` }, 'default');
      expect(result.allowed === false && result.denyPathBlocked === true).toBe(true);
    }
  });
});

describe('the Windows repair does not turn into a refuse-everything', () => {
  it.each(MUST_STAY_OPEN)('%s stays readable (%s)', (_label, path) => {
    expect(verdict(path).denied).toBe(false);
  });
});

describe('folding case closes a spelling bypass rather than opening one', () => {
  // Windows filenames are case-insensitive, so `.AWS` and `.aws` ARE the same
  // directory. Before the fold the pattern side was case-SENSITIVE while the
  // candidate side was folded, so these were open on top of everything else.
  it.each([
    ['uppercased directory', `${WIN_HOME}\\.AWS\\credentials`],
    ['mixed-case directory', `${WIN_HOME}\\.Ssh\\id_rsa`],
    ['mixed-case filename', `${WIN_HOME}\\.Git-Credentials`],
  ])('%s is still denied (%s)', (_label, path) => {
    expect(verdict(path).denied).toBe(true);
  });

  it('and does not fold a path that was never denied', () => {
    expect(verdict(`${WIN_PROJECT}\\SRC\\Index.ts`).denied).toBe(false);
  });
});

// ============================================================
// The grant did not move
// ============================================================

describe('the grant did not move', () => {
  // `allowedWritePaths` is a GRANT compiled by the same bidirectional
  // `globToRegex`. A deny-side repair that reached the compiler would widen it
  // silently. These assert the boundary behaviourally, on the very platform the
  // deny side just changed on.

  // P3.128 INVERTED the two behavioural rows below, and this describe's name is
  // still exactly right: the grant did not move BECAUSE OF THE DENY FIX. It
  // moved because a separate, deliberate, owner-called commit gave the grant its
  // OWN mirror-image helper. The boundary row at the bottom of this block is
  // what proves the two never became one, and it is the row that must never be
  // inverted.

  it('the pattern that is live as a DENY is live as a GRANT too — by its OWN helper', () => {
    // Was `false` until P3.128. `~/.ssh/**` denies `C:\Users\me\.ssh\id_rsa`
    // (asserted above) and, as a grant over the same path, now matches as well —
    // through `normalizeAllowedWritePattern`, not through the deny side's step,
    // which the boundary row below still pins as unreachable from here.
    expect(matchesAllowedWritePath(`${WIN_HOME}\\.ssh\\id_rsa`, ['~/.ssh/**'])).toBe(true);
  });

  it('a ~/-anchored grant WORKS on Windows now, and that is a widening', () => {
    // Both were `false` — the entire Windows write-grant surface was inert, in
    // the fail-CLOSED direction. P3.128 is the owner-called commit that turns it
    // on, so a Windows user is no longer prompted for writes they granted. If
    // either of these returns to `false`, the grant surface died again.
    expect(matchesAllowedWritePath(`${WIN_HOME}\\projects\\a.ts`, ['~/projects/**'])).toBe(true);
    expect(matchesAllowedWritePath('C:\\ws\\a.ts', ['C:/ws/**'])).toBe(true);
    // The widening is a SPELLING widening and nothing more. These two are what
    // separate "the grant now matches its own paths" from "the grant matches
    // everything", and they are the reason the row can be read as a fix rather
    // than as a hole.
    expect(matchesAllowedWritePath('C:\\other\\a.ts', ['C:/ws/**'])).toBe(false);
    expect(matchesAllowedWritePath(`${WIN_HOME}\\secrets\\a.ts`, ['~/projects/**'])).toBe(false);
  });

  it('a grant that worked on Windows still works', () => {
    // Positive control for the INSTRUMENT: `matchesAllowedWritePath` is really
    // being exercised, so the two `false`s above are a verdict and not a stub.
    expect(matchesAllowedWritePath(`${WIN_PROJECT}\\out\\a.ts`, ['**/out/**'])).toBe(true);
    expect(matchesAllowedWritePath(`${WIN_PROJECT}\\src\\a.ts`, ['**/out/**'])).toBe(false);
  });

  it('the spelling step is reachable ONLY from the deny matcher', () => {
    // Mirrors P3.104's own boundary test. Source-shape, because the guarantee is
    // about which functions CAN reach it, not about one sampled path.
    const source = readFileSync(hostJoin(import.meta.dir, '..', 'mode-manager.ts'), 'utf-8');
    const callers = source
      .split('\n')
      .filter((line) => line.includes('normalizeDeniedPathPattern(') && !line.trim().startsWith('*'));
    // One declaration plus the THREE calls in `matchesDeniedPath` — the
    // pattern, its container, and P6.673's unresolved-token comparison, which is
    // reached from the same loop and for the same candidate. Nothing else.
    // A fourth caller appearing anywhere OUTSIDE `matchesDeniedPath` is what
    // this case exists to catch, so a bump here is only ever legitimate
    // alongside the `grantBody` and `compilerBody` assertions below staying
    // green — they are what say the new caller is not on the grant side.
    expect(callers).toHaveLength(4);

    const grantStart = source.indexOf('export function matchesAllowedWritePath');
    expect(grantStart).toBeGreaterThan(-1);
    const grantBody = source.slice(grantStart, source.indexOf('\nfunction ', grantStart + 1));
    expect(grantBody).toContain('globToRegex');
    expect(grantBody).not.toContain('normalizeDeniedPathPattern');

    const compilerStart = source.indexOf('function globToRegex');
    const compilerBody = source.slice(compilerStart, source.indexOf('\n/**', compilerStart));
    expect(compilerBody).toContain('expandHome');
    // The compiler takes a terminator DIRECTION (P2.344) and nothing else: no
    // platform branch, no case fold — both stay on the deny side's pre-step.
    expect(compilerBody).not.toContain('normalizeDeniedPathPattern');
    expect(compilerBody).not.toContain('toLowerCase');
    expect(compilerBody).not.toContain('win32');
  });
});

// ============================================================
// P3.106's classifier still behaves
// ============================================================

describe('the malformed-entry warning stays silent about our own defaults', () => {
  // P3.106 tests the RAW pattern for backslashes precisely so a Windows home
  // does not make the product warn about every shipped entry on every boot. A
  // fix that changed how patterns are built or stored could have broken that,
  // and it would have been a worse bug than the one being fixed.

  it.each([...SHIPPED_DENIED_PATHS])('%s is not classified as malformed', (pattern) => {
    expect(classifyDeniedPathPattern(pattern)).toBeNull();
  });

  it('and no warning is emitted while the whole floor is exercised', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const [, candidate] of ENTRY_PROBES) verdict(candidate);
      for (const [, container] of CONTAINER_PROBES) verdict(container);
      expect(warn.mock.calls).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  it('but a genuinely malformed entry is still caught under a Windows home', () => {
    // Positive control: the classifier is live in this process, so the silence
    // above is a verdict rather than a disabled code path.
    expect(classifyDeniedPathPattern('C:\\Users\\me\\.aws\\**')).toBe('backslash');
    expect(classifyDeniedPathPattern('secrets/**')).toBe('unanchored');
    expect(classifyDeniedPathPattern('   ')).toBe('empty');
  });
});
