/**
 * F1.192 — `anchorCodexFloorOnCredentialHome`, pure: which floor patterns are
 * re-anchored on the latched home, and — the control — that an unmoved `HOME`
 * changes nothing at all.
 *
 * The binary half (codex really expands `~` with the child's `HOME`) is
 * `credential-floor-managed-home-live.test.ts`; the host wiring is
 * `packages/shared/src/agent/__tests__/codex-credential-floor-latched-home.test.ts`.
 */
import { describe, expect, it } from 'bun:test';
import { anchorCodexFloorOnCredentialHome, mapDeniedPathsToCodexFilesystemKeys } from '../config-writer.ts';

const LATCHED = '/Users/latched';
const MANAGED = '/Users/managed';
const FLOOR = ['~/.nessy/**', '~/.ssh/**', '~/.netrc', '**/.env', '**/credentials.enc', '/etc/secret'] as const;

describe('F1.192 — anchorCodexFloorOnCredentialHome', () => {
  it('a moved HOME: every `~/` pattern is re-anchored on the latched home, absolute', () => {
    const out = anchorCodexFloorOnCredentialHome(FLOOR, { credentialHome: LATCHED, childHome: MANAGED, platform: 'darwin' });
    expect(out).toEqual([
      `${LATCHED}/.nessy/**`, `${LATCHED}/.ssh/**`, `${LATCHED}/.netrc`,
      '**/.env', '**/credentials.enc', '/etc/secret',
    ]);
    const { keys, rejected } = mapDeniedPathsToCodexFilesystemKeys(out, []);
    expect(keys).toContain(`${LATCHED}/.nessy`);
    expect(keys.some(key => key.startsWith('~/'))).toBe(false);
    expect(keys.some(key => key.startsWith(MANAGED))).toBe(false);
    expect(rejected).toEqual([]);
  });

  it('CONTROL — HOME unmoved: the SAME array comes back, so the emitted keys are byte-identical', () => {
    const out = anchorCodexFloorOnCredentialHome(FLOOR, { credentialHome: LATCHED, childHome: LATCHED, platform: 'darwin' });
    expect(out).toBe(FLOOR);
    // A trailing slash is the same home, not a move.
    expect(anchorCodexFloorOnCredentialHome(FLOOR, { credentialHome: LATCHED, childHome: `${LATCHED}/`, platform: 'linux' })).toBe(FLOOR);
  });

  it('bare-home shapes stay bare, so the mapper still refuses them rather than denying a whole home', () => {
    const bare = ['~', '~/', '~/**'];
    const out = anchorCodexFloorOnCredentialHome(bare, { credentialHome: LATCHED, childHome: MANAGED, platform: 'darwin' });
    expect(out).toEqual(bare);
    expect(mapDeniedPathsToCodexFilesystemKeys(out, []).rejected.map(r => r.reason))
      .toEqual(['bare-home', 'bare-home', 'bare-home']);
  });

  it('win32 and an unset/empty child HOME are left alone, each for its stated reason', () => {
    expect(anchorCodexFloorOnCredentialHome(FLOOR, { credentialHome: LATCHED, childHome: MANAGED, platform: 'win32' })).toBe(FLOOR);
    expect(anchorCodexFloorOnCredentialHome(FLOOR, { credentialHome: LATCHED, childHome: undefined, platform: 'darwin' })).toBe(FLOOR);
    expect(anchorCodexFloorOnCredentialHome(FLOOR, { credentialHome: LATCHED, childHome: '', platform: 'darwin' })).toBe(FLOOR);
  });
});
