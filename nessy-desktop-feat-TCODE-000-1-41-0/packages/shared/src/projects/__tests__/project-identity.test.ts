import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';

import {
  isValidProjectKey,
  resolveProjectIdentity,
  type ResolveProjectIdentityOptions,
} from '../project-identity.ts';

const created: string[] = [];

function tempDir(prefix = 'proj-identity-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return realpathSync(dir);
}

afterEach(() => {
  while (created.length) {
    const dir = created.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveProjectIdentity — stable roots', () => {
  it('produces a stable, path-free key that is identical across calls', async () => {
    const dir = tempDir();
    const first = await resolveProjectIdentity(dir);
    const second = await resolveProjectIdentity(dir);

    expect(first.persistence).toBe('stable');
    expect(first.projectKey).toBe(second.projectKey);
    expect(first.identityFingerprint).toBe(second.identityFingerprint);
    expect(isValidProjectKey(first.projectKey)).toBe(true);
    // The key must not embed the absolute path.
    expect(first.projectKey).not.toContain(dir);
    expect(first.identityFingerprint).not.toContain(dir);
  });

  it('gives different keys to different directories with similar paths', async () => {
    const base = tempDir();
    const a = join(base, 'project-1');
    const b = join(base, 'project-10');
    mkdirSync(a);
    mkdirSync(b);

    const idA = await resolveProjectIdentity(a);
    const idB = await resolveProjectIdentity(b);
    expect(idA.projectKey).not.toBe(idB.projectKey);
  });

  it('preserves the key across a rename (same inode) but changes it on inode replacement at the same path', async () => {
    // Same device/inode -> same fingerprint/key (move/rename tolerant).
    const same: ResolveProjectIdentityOptions = {
      realpathSync: (p) => p,
      statSync: () => ({ dev: 42n, ino: 1001n }),
    };
    const before = await resolveProjectIdentity('/wherever/original', same);
    const afterRename = await resolveProjectIdentity('/wherever/renamed', same);
    expect(afterRename.projectKey).toBe(before.projectKey);

    // Same realpath but a replaced inode -> different fingerprint -> different key.
    const replaced: ResolveProjectIdentityOptions = {
      realpathSync: (p) => p,
      statSync: () => ({ dev: 42n, ino: 2002n }),
    };
    const afterReplacement = await resolveProjectIdentity('/wherever/original', replaced);
    expect(afterReplacement.identityFingerprint).not.toBe(before.identityFingerprint);
    expect(afterReplacement.projectKey).not.toBe(before.projectKey);
  });
});

describe('resolveProjectIdentity — symlink swap', () => {
  it('follows the realpath so swapping the symlink target changes the identity', async () => {
    const base = tempDir();
    const targetA = join(base, 'a');
    const targetB = join(base, 'b');
    mkdirSync(targetA);
    mkdirSync(targetB);
    const link = join(base, 'link');

    symlinkSync(targetA, link);
    const idA = await resolveProjectIdentity(link);
    const directA = await resolveProjectIdentity(targetA);
    expect(idA.canonicalPath).toBe(realpathSync(targetA));
    expect(idA.projectKey).toBe(directA.projectKey);

    rmSync(link);
    symlinkSync(targetB, link);
    const idB = await resolveProjectIdentity(link);
    expect(idB.projectKey).not.toBe(idA.projectKey);
    expect(idB.projectKey).toBe((await resolveProjectIdentity(targetB)).projectKey);
  });
});

describe('resolveProjectIdentity — process-only fallback', () => {
  it('falls back to a process-only identity when platform identity fails', async () => {
    const failing: ResolveProjectIdentityOptions = {
      realpathSync: (p) => p,
      statSync: () => { throw new Error('EIO'); },
      processSalt: 'salt-1',
    };
    const id = await resolveProjectIdentity('/mount/unstable', failing);
    expect(id.persistence).toBe('process-only');
    expect(isValidProjectKey(id.projectKey)).toBe(true);
  });

  it('treats a zero inode as an unavailable identity (process-only)', async () => {
    const zeroInode: ResolveProjectIdentityOptions = {
      realpathSync: (p) => p,
      statSync: () => ({ dev: 0n, ino: 0n }),
      processSalt: 'salt-1',
    };
    const id = await resolveProjectIdentity('/mount/win', zeroInode);
    expect(id.persistence).toBe('process-only');
  });

  it('salts process-only identities so they cannot be reproduced across processes', async () => {
    const withSalt = (processSalt: string): ResolveProjectIdentityOptions => ({
      realpathSync: (p) => p,
      statSync: () => { throw new Error('EIO'); },
      processSalt,
    });
    const first = await resolveProjectIdentity('/mount/x', withSalt('salt-a'));
    const sameSalt = await resolveProjectIdentity('/mount/x', withSalt('salt-a'));
    const otherSalt = await resolveProjectIdentity('/mount/x', withSalt('salt-b'));
    expect(first.projectKey).toBe(sameSalt.projectKey);
    expect(first.projectKey).not.toBe(otherSalt.projectKey);
  });

  it('resolves a missing path to a process-only identity', async () => {
    const id = await resolveProjectIdentity(join(tmpdir(), 'does-not-exist-abc123'));
    expect(id.persistence).toBe('process-only');
  });
});

describe('resolveProjectIdentity — home-directory carve-out', () => {
  // glossary.md:231: "Acceptance is saved per project directory, except your
  // home directory, where trust is held for the current session only and the
  // prompt reappears on each launch."
  it('classifies the home directory as process-only even when stat succeeds, with a salt-dependent key', async () => {
    const withSalt = (processSalt: string): ResolveProjectIdentityOptions => ({
      realpathSync: (p) => p,
      // A healthy stable root identity — the carve-out, not the stat fallback.
      statSync: () => ({ dev: 7n, ino: 1234n }),
      processSalt,
      homeDir: '/home/user',
    });
    const first = await resolveProjectIdentity('/home/user', withSalt('salt-a'));
    expect(first.persistence).toBe('process-only');
    expect(isValidProjectKey(first.projectKey)).toBe(true);
    // A different process salt (restart simulation) yields a different key.
    const otherProcess = await resolveProjectIdentity('/home/user', withSalt('salt-b'));
    expect(otherProcess.persistence).toBe('process-only');
    expect(otherProcess.projectKey).not.toBe(first.projectKey);
  });

  it('keeps a subdirectory of home stable', async () => {
    const opts: ResolveProjectIdentityOptions = {
      realpathSync: (p) => p,
      statSync: () => ({ dev: 7n, ino: 1234n }),
      processSalt: 'salt-a',
      homeDir: '/home/user',
    };
    const id = await resolveProjectIdentity('/home/user/projects/app', opts);
    expect(id.persistence).toBe('stable');
  });

  it('carves out home reached through a symlink (comparison on the realpath)', async () => {
    const base = tempDir();
    const home = join(base, 'home');
    const other = join(base, 'other');
    mkdirSync(home);
    mkdirSync(other);
    const link = join(base, 'home-link');
    symlinkSync(home, link);

    const viaLink = await resolveProjectIdentity(link, { homeDir: home });
    expect(viaLink.persistence).toBe('process-only');
    // Control: the same link with home pointing elsewhere stays stable.
    expect((await resolveProjectIdentity(link, { homeDir: other })).persistence).toBe('stable');
  });

  it('uses os.homedir() as the default carve-out root', async () => {
    const id = await resolveProjectIdentity(homedir());
    expect(id.persistence).toBe('process-only');
  });
});

describe('isValidProjectKey', () => {
  it('rejects absolute paths and malformed keys', () => {
    expect(isValidProjectKey('/Users/me/project')).toBe(false);
    expect(isValidProjectKey('p_' + 'z'.repeat(32))).toBe(false);
    expect(isValidProjectKey('project')).toBe(false);
    expect(isValidProjectKey(42 as unknown)).toBe(false);
  });
});
