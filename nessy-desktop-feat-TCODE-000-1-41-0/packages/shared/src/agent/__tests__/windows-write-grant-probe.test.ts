/**
 * P3.128 — the WINDOWS PROBE for `allowedWritePaths`, driven at the GATE.
 *
 * Owner decision 2026-09-02 (§A4+§A6): *"one Linux container + a Windows probe
 * join the verification kit; the Windows write-grant is fixed WITH the probe,
 * never on darwin evidence."* This file is that probe's Windows half. The Linux
 * half is `scripts/platform-rig/run-linux-removal-probe.ts`, which needs a real
 * kernel and therefore a container; a Windows host cannot be had here at all, so
 * this stands in for it the only way available — the same faked-win32 rig
 * P3.108 used to measure the DENY side, now pointed at the GRANT side.
 *
 * ## What this adds that the existing suite does not
 *
 * `denied-path-windows-separators.test.ts` §"the grant did not move" already
 * asserts the miss at the HELPER: `matchesAllowedWritePath('C:\\ws\\a.ts',
 * ['C:/ws/**'])` is `false`. What nobody had driven is the same grant at the
 * GATE — `shouldAllowToolInMode` with a real `Write`, a real permissions
 * context, and a grant the user actually configured. A helper returning `false`
 * is a hypothesis about the product; a refused `Write` is the product.
 *
 * ## Three independent causes, and each is enough on its own
 *
 * A grant reaches `globToRegex`, which does NOT know the platform. The candidate
 * reaches `normalizeForComparison`, which on win32 rewrites separators AND
 * lowercases. So on Windows:
 *
 *   grant `C:/ws/**`     -> regex `^C:\/ws\/.*$`
 *   candidate `C:\ws\a.ts` -> `c:/ws/a.ts`          -> NO MATCH (case)
 *   grant `~/projects/**` -> `^C:\\Users\\me\/projects\/.*$`
 *   candidate `C:\Users\me\projects\a.ts` -> `c:/users/me/projects/a.ts`
 *                                            -> NO MATCH (separator, escape, case)
 *
 * The deny side was brought into agreement by `normalizeDeniedPathPattern`,
 * deliberately reachable only from the deny matcher so a security patch could
 * not widen a grant. The grant therefore still needs its own mirror-image step,
 * and P3.128 exists because widening a GRANT is an owner call.
 *
 * ## HOW TO READ A FAILURE HERE — and what already happened
 *
 * This file was written as a CENSUS of a known, fail-CLOSED defect, with the
 * instruction: *"if one of them goes red because the grant started matching,
 * that is P3.128 being fixed — check the fix is grant-side only (the deny side
 * must not move), then invert the row and say so in the commit."*
 *
 * That is what happened, on 2026-09-03, in the same wave. All four census rows
 * went red at once against `normalizeAllowedWritePattern` — the grant's own
 * mirror-image helper in `mode-manager.ts`, win32-only, deliberately NOT the
 * deny side's step; `denied-path-windows-separators.test.ts`'s boundary row
 * still pins the two as separate. The rows below are the inverted census, and
 * each now carries an outside-the-grant control so "honoured" cannot be
 * satisfied by a gate that allows everything.
 *
 * The remaining rule is unchanged and is the one that matters: **if a `true`
 * expectation goes red, the instrument stopped working** and every assertion
 * beside it means nothing. And a row returning to `false` means the Windows
 * grant surface died again.
 */
import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import * as hostOs from 'node:os';
import * as hostPath from 'node:path';

import { assertWin32PathMockRestored } from './support/win32-path-mock.ts';
import { relatchHomeDirForTests } from '../../config/home-latch.ts';

/** What `os.homedir()` returns on a stock Windows install. */
const WIN_HOME = 'C:\\Users\\me';
/** A project on the Windows host, deliberately NOT under the home directory. */
const WIN_PROJECT = 'C:\\proj';

/**
 * The REAL modules, snapshotted with a spread BEFORE anything is mocked — and
 * the `before` is the entire point, measured rather than assumed.
 *
 * `mock.module` MUTATES the already-imported namespace object IN PLACE. After
 * `mock.module('node:path', () => winPath)`, the `hostPath` binding above IS
 * the win32 mock: measured on a throwaway two-file rig,
 * `hostPath.join('/a','b')` returns `'\\a\\b'` and
 * `hostPath.join === winPath.join` is `true`, while a spread taken beforehand
 * and a function reference captured beforehand both still return `'/a/b'`.
 *
 * So an `afterAll` that restores FROM THE LIVE NAMESPACE — which is what this
 * file did until P3.128's follow-up — re-installs the MOCK and leaks win32 path
 * semantics into every later file in the same `bun test` invocation. It cost
 * exactly that: batching this file with
 * `denied-path-windows-separators.test.ts` made that file's source-shape row
 * fail with `ENOENT … '\\Users\\…\\mode-manager.ts'`, because its own
 * `join` had become win32. Each file alone was green, which is what made it
 * look like a rig quirk rather than a leak.
 *
 * This is the second half of the repo's "spread AND restore" rule
 * (`claude-gateway-adapter.test.ts`, which snapshots `{ ...configStorage }`
 * before mocking and restores from that): the spread has to be the thing the
 * restore reads.
 */
const realPath = { ...hostPath };
const realOs = { ...hostOs };

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

mock.module('path', () => winPath);
mock.module('node:path', () => winPath);
mock.module('os', () => winOs);
mock.module('node:os', () => winOs);

/**
 * F1.105 — the LATCH has to move too, and a mock of `os.homedir` no longer
 * reaches `expandHome` on its own.
 *
 * `mode-manager.ts` expands `~` through `mode-manager-home.ts` symbol
 * `floorHomeDir`, which is `latchedHomeDir()` — captured at module import, from
 * the REAL `os`, before any `mock.module` call here. This file's `~`-anchored
 * GRANT rows read that same expansion, which is the point: the latch is not a
 * deny-side-only change, and a grant written `~/projects/**` still names the
 * home its author meant.
 *
 * In a `beforeAll` and NOT at module scope: bun imports every file of a batch
 * before running any of them, so a module-scope re-latch is live for the whole
 * process and poisons its neighbours.
 */
beforeAll(() => relatchHomeDirForTests(WIN_HOME));

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

afterAll(() => {
  Object.defineProperty(process, 'platform', originalPlatform);
  // From the SNAPSHOTS, never from `hostPath`/`hostOs` — those bindings are the
  // mock by now. See the block above for the measurement.
  mock.module('path', () => realPath);
  mock.module('node:path', () => realPath);
  mock.module('os', () => realOs);
  mock.module('node:os', () => realOs);

  // F1.105 — back to the real home, AFTER the `os` mock is restored and not
  // before it: `relatchHomeDirForTests()` with no argument re-reads
  // `os.homedir()`, so one line earlier it would re-latch to the WINDOWS home
  // for the rest of the process.
  relatchHomeDirForTests();

  // The check that makes the restore PROVEN rather than intended. A restore
  // nobody verifies is how this leaked in the first place: the old `afterAll`
  // looked correct, ran without error, and reinstalled the mock.
  //
  // P6.582 moved the two halves apart. The MECHANISM — is `node:path` POSIX
  // again — is this file's own property and is asserted here, through the
  // helper both win32-mocking files now share so neither can omit it. The
  // SYMPTOM — backslash-named entries in the repository ROOT, which this leak
  // produced ten of via `mode-gate.test.ts`'s
  // `mkdtempSync(join(tmpdir(), 'nessy-mode-gate-'))` — moved to the `bun test`
  // preload, where it is BASELINED: a per-file `readdirSync` here blames this
  // file for litter another concurrent process left in the tree, and a dozen
  // lanes run tests against this one working tree.
  assertWin32PathMockRestored({
    file: 'windows-write-grant-probe',
    livePath: hostPath,
    liveOs: hostOs,
    winHome: WIN_HOME,
  });
});

// Imported AFTER the mocks so the module graph captures win32 bindings.
const { matchesAllowedWritePath } = await import('../mode-manager.ts');
const { permissionsConfigCache } = await import('../permissions-config.ts');
type PermissionsContextT = import('../permissions-config.ts').PermissionsContext;

/** A permissions context carrying exactly one user-configured write grant. */
let generation = 0;
function contextGranting(...allowedWritePaths: string[]): PermissionsContextT {
  // A fresh generation per call so no assertion is served another's merge.
  generation += 1;
  return {
    workspaceRootPath: WIN_PROJECT,
    pinnedRevision: `probe-${generation}`,
    pinnedConfigs: [
      {
        config: {
          allowedBashPatterns: [],
          allowedMcpPatterns: [],
          allowedApiEndpoints: [],
          allowedWritePaths,
          deniedPaths: [],
          deniedToolPatterns: [],
          allowedTools: [],
          disallowedTools: [],
          toolRules: [],
          blockedTools: [],
          blockedCommandHints: [],
        },
        scope: 'workspace',
      },
    ],
  };
}

/** Drive the real gate: does a `Write` to `filePath` pass on this grant? */
function writeAllowed(filePath: string, ...grants: string[]): boolean {
  permissionsConfigCache.clear();
  // F1.1050 (DN-272): this drove the gate in `explore`, the ONLY mode whose Write branch read
  // `allowedWritePaths`. Explore is retired and plan does not inherit the grant (it would let plan
  // edit source), so the gate reads it in no mode; the grant is now driven at its own matcher, over
  // the MERGED config the gate would have read — the loading and compiling half P3.128 fixed.
  const merged = permissionsConfigCache.getMergedConfig(contextGranting(...grants));
  return matchesAllowedWritePath(filePath, merged.allowedWritePaths ?? []);
}

describe('P3.128 — a write grant at the gate, on a Windows host', () => {
  it('the gate is really being driven — the instrument control', () => {
    // A `**\/`-shaped grant never touches homedir and carries no drive letter,
    // so it is the one shape unaffected by all three causes. If this is not
    // `true`, every `false` below is a broken rig and not a finding.
    expect(writeAllowed(`${WIN_PROJECT}\\out\\a.ts`, '**/out/**')).toBe(true);
    // ... and the same grant must still refuse a path outside it, or "allowed"
    // would just be the gate saying yes to everything.
    expect(writeAllowed(`${WIN_PROJECT}\\src\\a.ts`, '**/out/**')).toBe(false);
  });

  // ── the census, INVERTED by P3.128 (W2-u, 2026-09-03) ───────────────────
  //
  // Every `false` below was a measured defect, and this file's own header says
  // what to do when one goes red: *"that is P3.128 being fixed — check the fix
  // is grant-side only (the deny side must not move), then invert the row and
  // say so in the commit."* All four went red together, the deny side was shown
  // not to have moved (`denied-path-windows-separators.test.ts`, whose boundary
  // row still pins `normalizeDeniedPathPattern` as unreachable from the grant),
  // and they are inverted here. The fix is `normalizeAllowedWritePattern` —
  // the grant's own mirror-image helper, win32-only, so no POSIX grant moves.
  //
  // This is a WIDENING: writes a Windows user granted and was prompted for now
  // go through. That was the owner call P3.128 existed to make explicit.

  it('a DRIVE-LETTER grant is honoured at the gate — case is no longer fatal', () => {
    // No `~`, no separator ambiguity in the grant: the operator wrote forward
    // slashes exactly as our own docs show. The candidate is lowercased by
    // `normalizeForComparison`, and now so is the compiled grant.
    expect(writeAllowed('C:\\ws\\a.ts', 'C:/ws/**')).toBe(true);
    // Backslashes in the grant work too: the helper rewrites them before
    // `globToRegex` can escape them into literals.
    expect(writeAllowed('C:\\ws\\a.ts', 'C:\\ws\\**')).toBe(true);
    // The widening is a SPELLING widening. A path outside the grant is still
    // refused, or "honoured" would just mean "allows everything".
    expect(writeAllowed('C:\\other\\a.ts', 'C:/ws/**')).toBe(false);
  });

  it('a ~/-anchored grant is honoured at the gate — all three causes closed', () => {
    expect(writeAllowed(`${WIN_HOME}\\projects\\a.ts`, '~/projects/**')).toBe(true);
    expect(writeAllowed(`${WIN_HOME}\\secrets\\a.ts`, '~/projects/**')).toBe(false);
  });

  // F1.1050 (DN-272) deleted "the gate now allows, and it allows only what the grant names": it drove the gate
  // in the retired explore, and no mode's gate reads allowedWritePaths any more.

  it('the helper and the gate agree, so the census can be read off either', () => {
    // The existing suite measures the helper. This asserts the two do not
    // disagree, which is what let this fix be validated at the cheaper one.
    expect(matchesAllowedWritePath('C:\\ws\\a.ts', ['C:/ws/**'])).toBe(true);
    expect(matchesAllowedWritePath('C:\\other\\a.ts', ['C:/ws/**'])).toBe(false);
    expect(matchesAllowedWritePath(`${WIN_PROJECT}\\out\\a.ts`, ['**/out/**'])).toBe(true);
  });
});
