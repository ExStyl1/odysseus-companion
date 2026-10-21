/**
 * P3.330 — this suite used to track ONE constant and, at the flip, prove
 * nothing.
 *
 * Its first case read `if (!SEATBELT_TESTING_WILDCARD) { expect(SEATBELT_TESTING_WILDCARD).toBe(false); return; }`
 * and its comment promised "when the flag flips off this expectation fails".
 * It does not: `false === false` passes, so the one test meant to be the
 * tripwire was the one guaranteed to stay green. Five further cases
 * early-returned while the wildcard was on, which meant the STRICT branch — the
 * branch carrying the whole security value of this module — had never been
 * executed by the suite at all, and the pre-GA flip would have been a change
 * with no green evidence behind it.
 *
 * Both are fixed the same way: `buildStrictMacosBashSeatbeltProfile` is exported
 * now, so every containment assertion below runs TODAY, on this side of the
 * flip, and the tripwire asserts the RELATION between the constant and the
 * applied profile in both directions instead of restating the constant.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  machLookupRule,
  NETWORK_SANDBOX_MACH_SERVICES,
  SANDBOX_MACH_SERVICES,
} from '@nessy-agent/session-tools-core';
import {
  applyBashSeatbeltSandbox,
  buildMacosBashSeatbeltProfile,
  buildStrictMacosBashSeatbeltProfile,
  isMacosSeatbeltAvailable,
  MACOS_SEATBELT_WILDCARD_PROFILE,
  resetMacosSeatbeltWildcardNotice,
  SEATBELT_TESTING_WILDCARD,
  wrapBashCommandWithMacosSeatbelt,
  wrapBashCommandWithSeatbeltProfile,
} from '../bash-seatbelt.ts';

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Whether a live `sandbox-exec` run can decide anything on this host. */
function liveSandboxAvailable(): boolean {
  return process.platform === 'darwin' && isMacosSeatbeltAvailable();
}

function runUnderProfile(command: string, profile: string, cwd: string) {
  return spawnSync('/bin/bash', ['-lc', wrapBashCommandWithSeatbeltProfile(command, profile)], {
    cwd,
    encoding: 'utf8',
  });
}

describe('Bash seatbelt sandbox', () => {
  it('applies the wildcard profile if and only if the constant says so', () => {
    // THE TRIPWIRE. Not a restatement of the constant: it pins the RELATION, so
    // it is a real assertion in both states of the flag. Flip the constant and
    // this case keeps testing something — it just tests the other side.
    if (SEATBELT_TESTING_WILDCARD) {
      expect(buildMacosBashSeatbeltProfile('/tmp/nessy-work')).toBe(MACOS_SEATBELT_WILDCARD_PROFILE);
    } else {
      expect(buildMacosBashSeatbeltProfile('/tmp/nessy-work'))
        .toBe(buildStrictMacosBashSeatbeltProfile('/tmp/nessy-work'));
      expect(buildMacosBashSeatbeltProfile('/tmp/nessy-work')).not.toBe(MACOS_SEATBELT_WILDCARD_PROFILE);
    }
  });

  it('names the wildcard as denying nothing, so the two can never drift apart', () => {
    // The string is asserted here rather than trusted: the diagnostic and the
    // docblock's cost table both quote it.
    expect(MACOS_SEATBELT_WILDCARD_PROFILE).toBe('(version 1) (allow default)');
    expect(buildStrictMacosBashSeatbeltProfile('/tmp/nessy-work')).toContain('(deny default)');
  });

  it('builds a strict profile that denies writes outside cwd', () => {
    const profile = buildStrictMacosBashSeatbeltProfile('/tmp/nessy-work');

    expect(profile).toContain('(deny default)');
    expect(profile).toContain('(allow file-read*)');
    expect(profile).toContain('(allow file-write* (literal "/dev/null"))');
    expect(profile).toContain('(allow file-write* (subpath "/tmp/nessy-work"))');
  });

  it('builds a strict profile that allows session plans and data write paths', () => {
    const profile = buildStrictMacosBashSeatbeltProfile('/tmp/nessy-work', [
      '/tmp/nessy-session/plans',
      '/tmp/nessy-session/data',
    ]);

    expect(profile).toContain('(deny default)');
    expect(profile).toContain('(allow file-write* (subpath "/tmp/nessy-work"))');
    expect(profile).toContain('(allow file-write* (subpath "/tmp/nessy-session/plans"))');
    expect(profile).toContain('(allow file-write* (subpath "/tmp/nessy-session/data"))');
  });

  it('keeps network open — the sandbox contains writes, not sockets (tester bug: dig bind EPERM)', () => {
    const profile = buildStrictMacosBashSeatbeltProfile('/tmp/nessy-work');

    expect(profile).toContain('(allow network*)');
    expect(profile).toContain('(allow system-socket)');
    // Filtered, never bare — a bare grant reaches `com.apple.pasteboard.1`.
    expect(profile).not.toMatch(/\(allow mach-lookup\)/);
    expect(profile).toContain(machLookupRule([...SANDBOX_MACH_SERVICES, ...NETWORK_SANDBOX_MACH_SERVICES]));
    expect(profile).not.toContain('com.apple.pasteboard.1');
  });

  it('resolves DNS inside the live sandbox when the host backend is available', () => {
    if (!liveSandboxAvailable()) {
      expect(liveSandboxAvailable()).toBe(false);
      return;
    }
    const rootDir = mkdtempSync(join(tmpdir(), 'bash-seatbelt-net-'));
    const cwd = join(rootDir, 'cwd');
    mkdirSync(cwd, { recursive: true });
    try {
      // dscacheutil exercises the same socket/mach paths that broke dig;
      // localhost avoids external network dependence in CI.
      const wrapped = wrapBashCommandWithMacosSeatbelt('dscacheutil -q host -a name localhost', cwd);
      const result = spawnSync('/bin/bash', ['-lc', wrapped], { cwd, encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('localhost');
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('leaves Bash input unchanged when opt-in is disabled', () => {
    const input = { command: 'printf ok' };
    const result = applyBashSeatbeltSandbox('Bash', input, {
      enabled: false,
      cwd: '/tmp/nessy-work',
      platform: 'darwin',
      sandboxExecAvailable: true,
    });

    expect(result.modified).toBe(false);
    expect(result.input).toBe(input);
  });

  it('wraps Bash input when opt-in is enabled on macOS with sandbox-exec', () => {
    const result = applyBashSeatbeltSandbox('Bash', { command: 'printf ok' }, {
      enabled: true,
      cwd: '/tmp/nessy-work',
      platform: 'darwin',
      sandboxExecAvailable: true,
    });

    expect(result.modified).toBe(true);
    expect(result.input.command).toContain('sandbox-exec -p');
    expect(result.input.command).toContain('/bin/bash -lc');
    expect(result.input.command).toContain('printf ok');
  });

  describe('the success path says what it applied', () => {
    beforeEach(() => resetMacosSeatbeltWildcardNotice());
    afterEach(() => resetMacosSeatbeltWildcardNotice());

    it('hands the wildcard notice to onDebug on the SUCCESS path, not only on the two failures', () => {
      // Before P3.330 a successful wrap emitted nothing at all: an operator who
      // enabled containment got a `sandbox-exec` prefix and no way to learn the
      // profile inside it permits everything.
      const messages: string[] = [];
      const result = applyBashSeatbeltSandbox('Bash', { command: 'printf ok' }, {
        enabled: true,
        cwd: '/tmp/nessy-work',
        platform: 'darwin',
        sandboxExecAvailable: true,
      }, message => messages.push(message));

      expect(result.modified).toBe(true);
      if (SEATBELT_TESTING_WILDCARD) {
        expect(messages).toHaveLength(1);
        expect(messages[0]).toContain('denies NOTHING');
        expect(messages[0]).toContain(MACOS_SEATBELT_WILDCARD_PROFILE);
      } else {
        expect(messages).toHaveLength(0);
      }
    });
  });

  it('blocks writes outside cwd under the strict profile, and does not under the wildcard', () => {
    // The cost table in the module docblock, pinned. Both arms run on every
    // pass: the strict arm is the positive control that proves the rig can
    // deny, and the wildcard arm is the finding — the profile we actually ship
    // when the opt-in is on contains nothing.
    if (!liveSandboxAvailable()) {
      expect(liveSandboxAvailable()).toBe(false);
      return;
    }

    const rootDir = mkdtempSync(join(tmpdir(), 'bash-seatbelt-'));
    const cwd = join(rootDir, 'cwd');
    const outsidePath = join(rootDir, 'outside.txt');
    mkdirSync(cwd, { recursive: true });

    try {
      const command = `printf nope > ${shQuote(outsidePath)}`;

      const strict = runUnderProfile(command, buildStrictMacosBashSeatbeltProfile(cwd), cwd);
      expect(strict.status).not.toBe(0);
      expect(strict.stderr).toContain('Operation not permitted');
      expect(existsSync(outsidePath)).toBe(false);

      const wildcard = runUnderProfile(command, MACOS_SEATBELT_WILDCARD_PROFILE, cwd);
      expect(wildcard.status).toBe(0);
      expect(existsSync(outsidePath)).toBe(true);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('allows configured session write paths while still blocking unrelated paths', () => {
    if (!liveSandboxAvailable()) {
      expect(liveSandboxAvailable()).toBe(false);
      return;
    }

    const rootDir = mkdtempSync(join(tmpdir(), 'bash-seatbelt-extra-'));
    const cwd = join(rootDir, 'cwd');
    const dataDir = join(rootDir, 'data');
    const outsidePath = join(rootDir, 'outside.txt');
    const dataPath = join(dataDir, 'result.txt');
    mkdirSync(cwd, { recursive: true });
    mkdirSync(dataDir, { recursive: true });

    try {
      const profile = buildStrictMacosBashSeatbeltProfile(cwd, [dataDir]);

      const allowedResult = runUnderProfile(`printf ok > ${shQuote(dataPath)}`, profile, cwd);
      expect(allowedResult.status).toBe(0);
      expect(existsSync(dataPath)).toBe(true);

      const deniedResult = runUnderProfile(`printf nope > ${shQuote(outsidePath)}`, profile, cwd);
      expect(deniedResult.status).not.toBe(0);
      expect(existsSync(outsidePath)).toBe(false);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
