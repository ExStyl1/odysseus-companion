/**
 * UB7.4 — ported from craft-agents-oss `v0.15.1:packages/shared/src/agent/core/__tests__/rtk-rewrite.test.ts`
 * (Apache-2.0) plus the row's negative control: no installer command ships —
 * the detector and the dialog sources are READ for the installer string, so a
 * re-introduction of `RTK_UPDATE_COMMAND` fails here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { rewriteBashWithRtk } from '../rtk-rewrite.ts';
import { meetsMinVersion, RTK_MIN_SAFE_VERSION } from '../rtk-detector.ts';

// A /bin/sh fake can take longer than the production 200 ms budget under test load.
const SLOW_SPAWN_MS = 5_000;

let dir: string;
let fakeRtk: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'rtk-rewrite-'));
  fakeRtk = join(dir, 'rtk');
  // Mimics `rtk rewrite "<cmd>"`: prefixes the command with rtk and signals "rewrite" (exit 0).
  writeFileSync(fakeRtk, '#!/bin/sh\n[ "$1" = rewrite ] || exit 1\necho "rtk $2"\nexit 0\n');
  chmodSync(fakeRtk, 0o755);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('rewriteBashWithRtk', () => {
  it('rewrites a plain command through rtk (rtk >= 0.44 is the usable floor)', () => {
    expect(rewriteBashWithRtk('Bash', { command: 'grep -n foo a.ts' }, fakeRtk, [], undefined, SLOW_SPAWN_MS)).toEqual({
      modified: true,
      input: { command: 'rtk grep -n foo a.ts' },
    });
  });

  it('leaves `command` and `builtin` prefixed commands alone (the POSIX bypass)', () => {
    for (const command of ['command grep -n foo a.ts', '  command cat a.ts', 'builtin echo hi']) {
      expect(rewriteBashWithRtk('Bash', { command }, fakeRtk, [])).toEqual({ modified: false, input: { command } });
    }
  });

  it('leaves excluded base commands alone (the rtkExcludeCommands list)', () => {
    expect(rewriteBashWithRtk('Bash', { command: 'grep -n foo a.ts' }, fakeRtk, ['grep']).modified).toBe(false);
    expect(rewriteBashWithRtk('Bash', { command: 'ls -la' }, fakeRtk, ['grep'], undefined, SLOW_SPAWN_MS).modified).toBe(true);
  });

  it('does nothing without a usable rtk or for other tools', () => {
    expect(rewriteBashWithRtk('Bash', { command: 'ls' }, null, []).modified).toBe(false);
    expect(rewriteBashWithRtk('Read', { command: 'ls' }, fakeRtk, []).modified).toBe(false);
  });
});

describe('rtk version gate', () => {
  it('treats releases before the safe minimum as outdated (rtk 0.43 is paused with the notice)', () => {
    expect(RTK_MIN_SAFE_VERSION).toBe('0.44.0');
    const safe = { major: 0, minor: 44, patch: 0 };
    expect(meetsMinVersion('0.23.0', safe)).toBe(false);
    expect(meetsMinVersion('0.40.0', safe)).toBe(false);
    expect(meetsMinVersion('0.43.0', safe)).toBe(false);
    expect(meetsMinVersion('0.43.9', safe)).toBe(false);
    expect(meetsMinVersion('0.44.0', safe)).toBe(true);
    expect(meetsMinVersion('0.50.0', safe)).toBe(true);
    expect(meetsMinVersion('1.0.0', safe)).toBe(true);
    expect(meetsMinVersion('rtk 0.50.0', safe)).toBe(true);
    expect(meetsMinVersion('garbage', safe)).toBe(false);
  });
});

describe('no installer command ships (OQ-43.8 (b))', () => {
  it('neither the detector nor the update dialog carries the upstream installer string', () => {
    const detector = readFileSync(resolve(import.meta.dir, '../rtk-detector.ts'), 'utf8');
    const dialog = readFileSync(resolve(import.meta.dir, '../../../../../../apps/electron/src/renderer/components/RtkUpdateDialog.tsx'), 'utf8');
    for (const source of [detector, dialog]) {
      expect(source).not.toContain('install.sh');
      expect(source).not.toContain('RTK_UPDATE_COMMAND');
      expect(source).not.toContain('curl -fsSL');
    }
  });
});
