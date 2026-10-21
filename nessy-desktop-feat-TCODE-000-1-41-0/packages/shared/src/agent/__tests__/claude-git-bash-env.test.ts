/**
 * UB4.5 — `buildClaudeSubprocessEnv` points the SDK's Bash tool at the
 * user-configured Git Bash on Windows, from config, when the variable is not
 * already set (upstream craft-agents-oss#935: without it the SDK falls back to
 * a hardcoded Program Files search that misses per-user installs — "No bash
 * shell found" — and the HEADLESS server never runs the `gitbash.CHECK` RPC
 * whose handler writes `process.env` directly, so the subprocess env is the
 * one place every Claude spawn path shares).
 *
 * Ported from upstream v0.15.1 `options.ts` `buildClaudeSubprocessEnv`
 * (Apache-2.0). Arms: the positive fill; the live-validated value wins; the
 * non-Windows platform writes nothing; no configured path writes nothing;
 * the configured value is trimmed.
 */
import { afterAll, afterEach, describe, expect, it, mock } from 'bun:test';
import * as configStorage from '../../config/storage.ts';

// Same seam as `claude-auto-memory-off-switch.test.ts`: spread the REAL module
// into the stub, restore the real one in `afterAll` (restoring from the
// imported namespace would restore the mock — F1.462).
const realStorage = { ...configStorage };

let configuredGitBash: string | undefined;

mock.module('../../config/storage.ts', () => ({
  ...realStorage,
  getGitBashPath: () => configuredGitBash,
}));

afterAll(() => {
  mock.module('../../config/storage.ts', () => realStorage);
});

const { buildClaudeSubprocessEnv } = await import('../options.ts');

const VARIABLE = 'CLAUDE_CODE_GIT_BASH_PATH';
const originalPlatform = process.platform;
const priorAmbient = process.env[VARIABLE];

function usePlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

afterEach(() => {
  usePlatform(originalPlatform);
  if (priorAmbient === undefined) delete process.env[VARIABLE];
  else process.env[VARIABLE] = priorAmbient;
});

describe('UB4.5 — the Git Bash path reaches the Claude subprocess env on Windows', () => {
  it('positive — win32 with nothing set: the configured path fills the env, trimmed', () => {
    usePlatform('win32');
    delete process.env[VARIABLE];
    configuredGitBash = ' C:\\Users\\me\\AppData\\Local\\Programs\\Git\\bin\\bash.exe ';
    expect(buildClaudeSubprocessEnv()[VARIABLE]).toBe('C:\\Users\\me\\AppData\\Local\\Programs\\Git\\bin\\bash.exe');
  });

  it('negative — a value already in the env (the CHECK probe\'s live-validated one) wins', () => {
    usePlatform('win32');
    process.env[VARIABLE] = 'C:\\live-validated\\bash.exe';
    configuredGitBash = 'C:\\stale-config\\bash.exe';
    expect(buildClaudeSubprocessEnv()[VARIABLE]).toBe('C:\\live-validated\\bash.exe');
  });

  it('negative — a non-Windows host writes nothing, even with a configured path', () => {
    usePlatform('darwin');
    delete process.env[VARIABLE];
    configuredGitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
    expect(buildClaudeSubprocessEnv()[VARIABLE]).toBeUndefined();
  });

  it('boundary — win32 with nothing configured leaves the variable unset', () => {
    usePlatform('win32');
    delete process.env[VARIABLE];
    configuredGitBash = undefined;
    expect(buildClaudeSubprocessEnv()[VARIABLE]).toBeUndefined();
  });
});
