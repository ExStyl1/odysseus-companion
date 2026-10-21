/**
 * P3.331 — the trust guard for the machine-wide managed tier, and the win32
 * posture change.
 *
 * `isHostOwnedManagedFile` opened with `if (platform === 'win32') return true`,
 * placed before the ownership and mode checks. It is the ONLY guard on the
 * managed `CLAUDE.md` tier — the tier `memory.md` calls un-excludable — so on
 * Windows an un-excludable instruction file was trusted without a single check
 * having run, in a directory (`%ProgramData%\Nessy`) that no code in this
 * repository ever creates with an administrator ACL. **P6.235 moved that
 * directory to `%ProgramFiles%\Nessy` for the POLICY tier and left this one
 * withheld; the test below pins both halves so neither can move alone.**
 *
 * The guard now answers three ways, and this suite pins all three. It runs on
 * darwin, which is the point: the win32 verdict is decided by the `platform`
 * argument, not by the host, so the posture is testable on the machine we have
 * while the real Windows check stays parked with P3.7.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MANAGED_INSTRUCTION_FILE,
  isHostOwnedManagedFile,
  legacyManagedSystemDirForPlatform,
  managedFileTrustVerdict,
  managedSystemDirForPlatform,
} from '../managed-system-paths.ts';

const roots: string[] = [];

function fixture(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'managed-tier-'));
  roots.push(dir);
  const file = join(dir, MANAGED_INSTRUCTION_FILE);
  writeFileSync(file, '# managed\n', 'utf-8');
  chmodSync(file, 0o644);
  chmodSync(dir, 0o755);
  return { dir, file };
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('managedSystemDirForPlatform', () => {
  it('resolves the three platforms and nothing else', () => {
    expect(managedSystemDirForPlatform('darwin')).toBe('/Library/Application Support/Nessy');
    expect(managedSystemDirForPlatform('linux')).toBe('/etc/nessy');
    expect(managedSystemDirForPlatform('win32', 'C:\\Program Files')).toBe('C:\\Program Files\\Nessy');
    expect(managedSystemDirForPlatform('freebsd')).toBeUndefined();
    // win32 without the variable has no directory at all, rather than a path
    // built from an empty root.
    expect(managedSystemDirForPlatform('win32', undefined)).toBeUndefined();
  });

  it('is the DOCUMENTED Windows location now, and the instruction tier is still withheld', () => {
    // P6.235 moved it. `managed-settings.md#where-each-mechanism-stores-the-policy`:
    // "Claude Code doesn't read the legacy Windows path
    // `C:\ProgramData\ClaudeCode\managed-settings.json`" — ours used to sit
    // under the same `%ProgramData%` root and now sits under `%ProgramFiles%`,
    // which is administrator-writable by default.
    expect(managedSystemDirForPlatform('win32', 'C:\\Program Files')).not.toContain('ProgramData');
    expect(legacyManagedSystemDirForPlatform('win32', 'C:\\ProgramData')).toBe('C:\\ProgramData\\Nessy');
    // On every other platform there is no former location to name.
    expect(legacyManagedSystemDirForPlatform('darwin')).toBeUndefined();
    expect(legacyManagedSystemDirForPlatform('linux')).toBeUndefined();

    // The POLICY tier now reads that directory (see `managed-policy-loader`).
    // The INSTRUCTION tier deliberately does NOT follow it in the same commit:
    // `memory.md` — "Managed policy CLAUDE.md files cannot be excluded" — so the
    // tier a user cannot turn off waits for a real ACL or HKLM check rather than
    // inheriting a location-based one. This assertion is what makes that a
    // decision instead of an oversight.
    expect(managedFileTrustVerdict('C:\\Program Files\\Nessy\\CLAUDE.md', 'win32'))
      .toBe('unverifiable-platform');
  });
});

describe('managedFileTrustVerdict', () => {
  it('trusts a file the current user owns in a directory nobody else can write', () => {
    const { file } = fixture();
    expect(managedFileTrustVerdict(file, 'darwin')).toBe('trusted');
    expect(isHostOwnedManagedFile(file, 'darwin')).toBe(true);
  });

  it('refuses a world-writable file, and a file in a world-writable directory', () => {
    const a = fixture();
    chmodSync(a.file, 0o666);
    expect(managedFileTrustVerdict(a.file, 'darwin')).toBe('untrusted');

    const b = fixture();
    chmodSync(b.dir, 0o777);
    expect(managedFileTrustVerdict(b.file, 'darwin')).toBe('untrusted');
  });

  it('refuses a symlink, so a link planted in a writable directory cannot redirect the read', () => {
    const { dir } = fixture();
    const target = join(dir, 'elsewhere.md');
    writeFileSync(target, '# planted\n', 'utf-8');
    const link = join(dir, 'linked-CLAUDE.md');
    symlinkSync(target, link);
    expect(managedFileTrustVerdict(link, 'darwin')).toBe('untrusted');
  });

  it('refuses an absent file and a directory', () => {
    const { dir } = fixture();
    expect(managedFileTrustVerdict(join(dir, 'nope.md'), 'darwin')).toBe('untrusted');
    mkdirSync(join(dir, 'adir'));
    expect(managedFileTrustVerdict(join(dir, 'adir'), 'darwin')).toBe('untrusted');
  });

  it('answers unverifiable-platform on win32 — NOT trusted — even for a file that passes on darwin', () => {
    // THE POSTURE CHANGE. The same path, same bytes, same permissions: darwin
    // says `trusted`, win32 says the checks did not run. Before P3.331 win32
    // returned `true` here, i.e. the strongest possible answer from a guard
    // that had evaluated nothing.
    const { file } = fixture();
    expect(managedFileTrustVerdict(file, 'darwin')).toBe('trusted');
    expect(managedFileTrustVerdict(file, 'win32')).toBe('unverifiable-platform');
    expect(isHostOwnedManagedFile(file, 'win32')).toBe(false);
  });

  it('does not touch the filesystem at all on win32', () => {
    // The verdict is decided before any `lstat`, so a path that would throw is
    // still answered — this is what makes the posture testable off Windows.
    expect(managedFileTrustVerdict('\u0000', 'win32')).toBe('unverifiable-platform');
  });
});
