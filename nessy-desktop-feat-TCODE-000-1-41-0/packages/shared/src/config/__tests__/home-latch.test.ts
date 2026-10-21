/**
 * P3.143 — the session's home is latched, and the credential source reads the
 * latch rather than a live `os.homedir()`.
 *
 * ## Why these tests move the LATCH and not `process.env.HOME`
 *
 * The obvious test — set `process.env.HOME`, assert the creds path did not
 * move — CANNOT FAIL under `bun test`, and would therefore have been a test
 * that proves the fix without being able to detect its absence. Measured
 * 2026-08-28 on this rig:
 *
 *   - Bun 1.3.14: `process.env.HOME = x` mid-process → `os.homedir()` unchanged
 *   - Node 24.4.1: same mutation → `os.homedir()` returns `x`
 *   - Electron 39.8.10 (Node 22.22.1): same mutation → returns `x`
 *
 * Positive control on all three: with `HOME` unset at spawn, `os.homedir()`
 * returns the passwd entry, so the probe was reading the variable.
 *
 * The process that both applies a managed `env` block and resolves the creds
 * path is the Electron main process, which is Node — so the defect is live
 * where it matters and invisible to the runtime these tests run in. Moving the
 * latch is the only assertion that discriminates: pre-fix, every call site
 * below answered `os.homedir()` and would fail these.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { homedir } from 'node:os';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { latchedHomeDir, relatchHomeDirForTests } from '../home-latch.ts';
import { latchedHomeDir as adapterLatchedHomeDir } from '@nessy-agent/codex-responses-adapter/home-latch';
import { defaultCredsPath } from '@nessy-agent/codex-responses-adapter/nestor-auth';
import { getCredsPath, getOauthCredsPath } from '../../auth/dp/creds-store.ts';
import { dpRuntimeEnvironment, resolveDpStateRoot } from '../../auth/dp/dp-runtime.ts';
import { parseManagedSandboxSettingsV1 } from '../sandbox-settings.ts';
import { sandboxRootsFromClaudeRules } from '../../agent/pi-harness/sandbox-permission-rules.ts';
import { parseClaudeRuleString } from '../../agent/pi-harness/claude-permission-rules.ts';
import { compilePermissionDslV1, evaluateCdPermissionDslV1 } from '../../agent/pi-harness/permission-dsl.ts';
import { PathProcessor } from '../../agent/core/path-processor.ts';

afterEach(() => {
  relatchHomeDirForTests();
});

describe('the latch itself', () => {
  test('at rest it is the real home, not a constant', () => {
    // Negative control for every test below: if the module answered a fixed
    // string, the "moved" assertions would still pass and prove nothing.
    expect(latchedHomeDir()).toBe(homedir());
  });

  test('a mutated `process.env.HOME` never reaches it', () => {
    // Vacuous under Bun by the measurement in this file's header, and kept
    // anyway: it is the assertion that fails first if these suites are ever
    // run under Node, which is the runtime the defect lives in.
    const before = latchedHomeDir();
    // RESTORED, not deleted. The `finally` used to `delete process.env.HOME`
    // unconditionally, which left the whole `bun test` process without a HOME
    // for every file that ran after this one — and one of them reads it:
    // `mcp/__tests__/client-transport.test.ts` asserts the supervised child's
    // env carries `HOME: process.env.HOME`, so its expectation degraded to
    // `undefined` while the code under test still supplied the real home. It
    // passed alone (20/0, 0.6 s) and failed in the full run at 5.73 ms — a
    // millisecond failure, which is what says "not starvation" (P3.316 lane,
    // 2026-09-03). Delete only if there was nothing here at launch, because
    // assigning `undefined` writes the string "undefined".
    const previousHome = process.env.HOME;
    process.env.HOME = '/tmp/nessy-p3143-attacker-home';
    try {
      expect(latchedHomeDir()).toBe(before);
    } finally {
      delete process.env.HOME;
      if (previousHome !== undefined) process.env.HOME = previousHome;
    }
  });
});

describe('the credential source reads the latch', () => {
  const SESSION_HOME = '/tmp/nessy-p3143-session-home';

  test('both creds paths follow the latch', () => {
    relatchHomeDirForTests(SESSION_HOME);
    expect(getCredsPath()).toBe(join(SESSION_HOME, '.nessy', 'dp_auth_creds.json'));
    expect(getOauthCredsPath()).toBe(join(SESSION_HOME, '.nessy', 'oauth_creds.json'));
  });

  test('and go back with it — the latch is the only input', () => {
    relatchHomeDirForTests(SESSION_HOME);
    relatchHomeDirForTests();
    expect(getCredsPath()).toBe(join(homedir(), '.nessy', 'dp_auth_creds.json'));
  });

  test('the `HOME` handed to the token-minting dp subprocess follows the latch', () => {
    relatchHomeDirForTests(SESSION_HOME);
    const env = dpRuntimeEnvironment(undefined);
    expect(env.HOME).toBe(SESSION_HOME);
    // Boundary: the latch moves the home and nothing else about the block.
    expect(env.DP_NO_WARNINGS).toBe('true');
    expect(env.DP_AI_MCP_SKIP_LOGIN).toBe('true');
    expect('DP_WORKDIR' in env).toBe(false);
  });

  test("dp's default state root resolves under the latched home", () => {
    const home = mkdtempSync(join(tmpdir(), 'nessy-p3143-home-'));
    mkdirSync(join(home, '.dp'));
    relatchHomeDirForTests(home);
    // Default argument — this is the call shape the callers use.
    // `resolveDpStateRoot` realpaths its answer, so `/var` -> `/private/var`
    // on macOS; compare against the same canonicalization, not the raw join.
    expect(resolveDpStateRoot({})).toBe(realpathSync(join(home, '.dp')));
    // Negative control: the real home has no `.dp` under it in this fixture,
    // so an unlatched resolution would answer something else (or undefined).
    expect(resolveDpStateRoot({}, join(home, 'no-such-home'))).toBeUndefined();
  });
});

describe('the floor protecting the credential source reads the latch', () => {
  const SESSION_HOME = '/tmp/nessy-p3143-floor-home';

  test('a `~/` deny entry expands against the latched home', () => {
    relatchHomeDirForTests(SESSION_HOME);
    const parsed = parseManagedSandboxSettingsV1({
      filesystem: { denyRead: ['~/.nessy'], denyWrite: ['~/.nessy'] },
      deniedReadRoots: ['~/.nessy'],
      deniedWriteRoots: ['~/.nessy'],
    });
    const denied = join(SESSION_HOME, '.nessy');
    expect(parsed.deniedReadRoots).toEqual([denied]);
    expect(parsed.deniedWriteRoots).toEqual([denied]);
    expect(parsed.filesystem?.denyRead).toEqual([denied]);
    expect(parsed.filesystem?.denyWrite).toEqual([denied]);
  });

  test('an absolute entry is untouched by the latch, and an explicit scope still wins', () => {
    relatchHomeDirForTests(SESSION_HOME);
    const absolute = parseManagedSandboxSettingsV1({ deniedReadRoots: ['/etc/nessy'] });
    expect(absolute.deniedReadRoots).toEqual(['/etc/nessy']);

    const scoped = parseManagedSandboxSettingsV1(
      { deniedReadRoots: ['~/.nessy'] },
      { scope: { home: '/tmp/nessy-p3143-explicit-home' } },
    );
    expect(scoped.deniedReadRoots).toEqual(['/tmp/nessy-p3143-explicit-home/.nessy']);
  });
});

/**
 * P3.168 — the five sites P3.143 measured and left, plus the third hand-written
 * copy of the credential path.
 *
 * Every one of them is `os.homedir()` doing the same job the four converted call
 * sites did: deciding where a credential is read from, or anchoring the floor
 * that protects it. They are asserted TOGETHER rather than one per suite because
 * the failure the row names is not any single site — it is two sites answering
 * two different homes in the same process and the same second.
 *
 * These move the latch, not `process.env.HOME`, for the reason in this file's
 * header: under `bun test` the environment variable moves nothing (P3.169), so a
 * `$HOME` assertion here could never fail. The end-to-end claim — that a
 * confirmed managed `HOME` no longer moves any of this mid-session — still needs
 * a Node-hosted or packaged check.
 */
describe('P3.168 — every remaining copy of the credential path reads one latch', () => {
  const SESSION_HOME = '/nessy-p3168-session-home';

  test('the adapter and shared resolve ONE creds file, and it follows the latch', () => {
    // Negative control: the two modules are different files in different
    // packages, so the interesting claim is that they agree — and they can only
    // agree by construction if there is one latch, not two.
    expect(adapterLatchedHomeDir()).toBe(latchedHomeDir());

    relatchHomeDirForTests(SESSION_HOME);
    // Moving the shared latch moves the ADAPTER's answer. Pre-P3.168 the
    // adapter read `os.homedir()`, so this line answered the real home while
    // `getCredsPath()` answered the session one — the split-brain the single
    // latch exists to prevent, on a file whose shape is nessy-cli's contract.
    expect(defaultCredsPath()).toBe(join(SESSION_HOME, '.nessy', 'dp_auth_creds.json'));
    expect(defaultCredsPath()).toBe(getCredsPath());
  });

  test("Pi's `~/` sandbox roots expand against the latch, and an explicit home still wins", () => {
    relatchHomeDirForTests(SESSION_HOME);
    const rules = {
      deny: ['Read(~/.nessy)', 'Edit(~/.nessy)'],
      allow: [],
      ask: [],
    };
    const latched = sandboxRootsFromClaudeRules(rules);
    expect(latched.deniedReadRoots).toEqual([join(SESSION_HOME, '.nessy')]);
    expect(latched.deniedWriteRoots).toEqual([join(SESSION_HOME, '.nessy')]);

    // The `options.home` seam is unchanged: a caller that knows the boundary's
    // home still overrides the latch, which is what the Pi host does per plan.
    const explicit = sandboxRootsFromClaudeRules(rules, { home: '/nessy-p3168-explicit' });
    expect(explicit.deniedReadRoots).toEqual([join('/nessy-p3168-explicit', '.nessy')]);
  });

  test("the permission DSL's `~/` anchor compiles against the latch", () => {
    relatchHomeDirForTests(SESSION_HOME);
    const parsed = parseClaudeRuleString('Cd(~/code/**)', 'deny');
    expect(parsed.rule).toBeTruthy();
    const program = compilePermissionDslV1({
      generation: 'p3168',
      projectTrusted: true,
      layers: [{
        scope: 'workspace',
        sourceDigest: 'p3168',
        sourceRoot: '/nessy-p3168-workspace',
        document: { version: 1, rules: [{ id: 'p3168-0', action: 'deny', match: parsed.rule!.match }] },
      }],
    });
    const decide = (path: string): string =>
      evaluateCdPermissionDslV1(program, { path, alternatePaths: [], cwd: '/nessy-p3168-workspace' }).decision;

    expect(decide(join(SESSION_HOME, 'code'))).toBe('deny');
    // Negative control: the REAL home is not what the rule compiled against, so
    // a path under it must not be caught. Pre-fix this pair was inverted.
    expect(decide(join(homedir(), 'code'))).toBe('prompt');
  });

  test('PathProcessor expands `~` against the latch, and its explicit seam still wins', () => {
    relatchHomeDirForTests(SESSION_HOME);
    expect(new PathProcessor().getHomeDir()).toBe(SESSION_HOME);
    expect(new PathProcessor({ homeDir: '/nessy-p3168-explicit' }).getHomeDir()).toBe('/nessy-p3168-explicit');
  });
});
