import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { dpRuntimeEnvironment, hardenDpStateRoot, resolveDpStateRoot } from '../dp-runtime.ts';

describe('resolveDpStateRoot', () => {
  test('DP_WORKDIR wins over the home default and is realpathed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dp-state-'));
    expect(resolveDpStateRoot({ DP_WORKDIR: ` ${dir} ` } as NodeJS.ProcessEnv, '/nonexistent-home'))
      .toBe(realpathSync(dir));
  });

  test('falls back to <home>/.dp only when it exists', () => {
    const home = mkdtempSync(join(tmpdir(), 'dp-home-'));
    expect(resolveDpStateRoot({} as NodeJS.ProcessEnv, home)).toBeUndefined();
    mkdirSync(join(home, '.dp'));
    expect(resolveDpStateRoot({} as NodeJS.ProcessEnv, home))
      .toBe(realpathSync(join(home, '.dp')));
  });

  test('refuses the filesystem root and the home directory itself', () => {
    expect(resolveDpStateRoot({ DP_WORKDIR: '/' } as NodeJS.ProcessEnv, '/nonexistent-home'))
      .toBeUndefined();
    const home = mkdtempSync(join(tmpdir(), 'dp-home-'));
    expect(resolveDpStateRoot({ DP_WORKDIR: home } as NodeJS.ProcessEnv, home)).toBeUndefined();
  });
});

describe('hardenDpStateRoot (DA1.52)', () => {
  // The DA1.6 record's `workdir` is `resolve()`d and nothing else, and at
  // `resolvePluginDpRuntime` that value ALSO becomes a sandbox `writableRoots`
  // grant. These four refusals are what the conversion had to keep.

  test('canonicalises an existing candidate, which is what a grant must match', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dp-harden-'));
    const hardened = hardenDpStateRoot(dir);
    expect(hardened).toBe(realpathSync(dir));
    // On macOS the two spellings differ, and a grant on the uncanonical one
    // does not match a child writing through the canonical one. The assertion
    // is written so it still discriminates where they happen to be equal.
    expect(hardened).not.toBeUndefined();
  });

  test('refuses what must never become a write grant', () => {
    const home = mkdtempSync(join(tmpdir(), 'dp-harden-home-'));
    expect(hardenDpStateRoot(undefined)).toBeUndefined();
    expect(hardenDpStateRoot(join(home, 'never-created'))).toBeUndefined();
    expect(hardenDpStateRoot('/')).toBeUndefined();
    expect(hardenDpStateRoot(home, home)).toBeUndefined();
  });

  test('resolveDpStateRoot delegates to it, so the two can never disagree', () => {
    // The control for the extraction itself: same input, same answer, through
    // both doors.
    const dir = mkdtempSync(join(tmpdir(), 'dp-harden-delegate-'));
    expect(resolveDpStateRoot({ DP_WORKDIR: dir } as NodeJS.ProcessEnv, '/nonexistent-home'))
      .toBe(hardenDpStateRoot(dir));
  });
});

describe('dpRuntimeEnvironment', () => {
  test('carries the non-interactive switches; DP_WORKDIR only with a root', () => {
    expect(dpRuntimeEnvironment(undefined)).toEqual({
      HOME: homedir(),
      DP_NO_WARNINGS: 'true',
      DP_AI_MCP_SKIP_LOGIN: 'true',
    });
    expect(dpRuntimeEnvironment('/x/y')).toEqual({
      HOME: homedir(),
      DP_NO_WARNINGS: 'true',
      DP_AI_MCP_SKIP_LOGIN: 'true',
      DP_WORKDIR: '/x/y',
    });
  });
});
