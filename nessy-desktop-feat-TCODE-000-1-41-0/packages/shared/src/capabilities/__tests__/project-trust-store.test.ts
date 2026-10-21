import { mkdtempSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';

import { resolveProjectIdentity, type ResolveProjectIdentityOptions } from '../../projects/project-identity.ts';
import { ProjectTrustStore } from '../project-trust-store.ts';

const tmpFiles: string[] = [];

function trustPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'proj-trust-'));
  tmpFiles.push(dir);
  return join(dir, 'project-trust.json');
}

afterEach(() => {
  tmpFiles.length = 0;
});

// A stable identity derived from resolveProjectIdentity (no trust-local key derivation).
function stableIdentity(ino: bigint) {
  const opts: ResolveProjectIdentityOptions = {
    realpathSync: (p) => p,
    statSync: () => ({ dev: 7n, ino }),
  };
  return resolveProjectIdentity('/repo/project', opts);
}

describe('ProjectTrustStore — persistence', () => {
  it('folder selection alone is untrusted until a decision is recorded', async () => {
    const store = new ProjectTrustStore({ path: trustPath() });
    const identity = await stableIdentity(1n);
    expect(store.resolve(identity).state).toBe('none');
  });

  it('persists a trusted grant and re-reads it in a fresh store instance', async () => {
    const path = trustPath();
    const identity = await stableIdentity(1n);

    const writer = new ProjectTrustStore({ path });
    writer.record(identity, 'trusted');

    const reader = new ProjectTrustStore({ path });
    const decision = reader.resolve(identity);
    expect(decision.state).toBe('trusted');
    expect(decision.source).toBe('user');
    expect(decision.revision).not.toBe('');
  });

  it('persists only key/fingerprint/state/source/revision/timestamp — never an absolute path', async () => {
    const path = trustPath();
    const identity = await stableIdentity(1n);
    new ProjectTrustStore({ path }).record(identity, 'trusted');

    const raw = readFileSync(path, 'utf-8');
    expect(raw).not.toContain('/repo/project');
    const parsed = JSON.parse(raw);
    const record = parsed.projects[identity.projectKey];
    expect(Object.keys(record).sort()).toEqual(
      ['identityFingerprint', 'projectKey', 'revision', 'source', 'state', 'updatedAt'],
    );
    expect(record.identityFingerprint).toBe(identity.identityFingerprint);
    // File must be owner-only.
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('invalidates trust when the root inode is replaced at the same path', async () => {
    const path = trustPath();
    const original = await stableIdentity(1n);
    new ProjectTrustStore({ path }).record(original, 'trusted');

    // Same key derivation, but a replaced inode -> different fingerprint/key.
    const replaced = await stableIdentity(999n);
    expect(new ProjectTrustStore({ path }).resolve(replaced).state).toBe('none');
  });

  it('records a blocked decision distinctly from none', async () => {
    const path = trustPath();
    const identity = await stableIdentity(1n);
    new ProjectTrustStore({ path }).record(identity, 'blocked');
    expect(new ProjectTrustStore({ path }).resolve(identity).state).toBe('blocked');
  });

  it('merge-preserves other projects when recording a new grant', async () => {
    const path = trustPath();
    const a = await stableIdentity(1n);
    const b = await stableIdentity(2n);
    const store = new ProjectTrustStore({ path });
    store.record(a, 'trusted');
    store.record(b, 'blocked');

    const fresh = new ProjectTrustStore({ path });
    expect(fresh.resolve(a).state).toBe('trusted');
    expect(fresh.resolve(b).state).toBe('blocked');
  });
});

describe('ProjectTrustStore — process-only identities', () => {
  it('never persists a process-only decision', async () => {
    const path = trustPath();
    const processOnly = await resolveProjectIdentity('/mount/unstable', {
      realpathSync: (p) => p,
      statSync: () => { throw new Error('EIO'); },
      processSalt: 'salt',
    });
    expect(processOnly.persistence).toBe('process-only');

    const store = new ProjectTrustStore({ path });
    store.record(processOnly, 'trusted');
    // In-memory grant is visible within the same store instance...
    expect(store.resolve(processOnly).state).toBe('trusted');
    // ...but nothing was written to disk.
    expect(existsSync(path)).toBe(false);
    // ...and a fresh instance sees no grant.
    expect(new ProjectTrustStore({ path }).resolve(processOnly).state).toBe('none');
  });

  // glossary.md:231 home carve-out: trusting the home directory "is held for
  // the current session only". The stable-identity persistence test above
  // ('persists a trusted grant and re-reads it in a fresh store instance') is
  // the positive control for this restart-simulation probe.
  it('keeps a home-directory grant session-only: nothing on disk, a fresh store resolves none', async () => {
    const path = trustPath();
    const home = await resolveProjectIdentity('/home/user', {
      realpathSync: (p) => p,
      // Stat SUCCEEDS — this is the home carve-out, not the unstable-fs fallback.
      statSync: () => ({ dev: 7n, ino: 42n }),
      processSalt: 'salt',
      homeDir: '/home/user',
    });
    expect(home.persistence).toBe('process-only');

    const store = new ProjectTrustStore({ path });
    const recorded = store.record(home, 'trusted');
    expect(recorded.persistence).toBe('process-only');
    // Visible in-process...
    expect(store.resolve(home).state).toBe('trusted');
    // ...but the trust file was never written...
    expect(existsSync(path)).toBe(false);
    // ...and a FRESH store over the same file (restart simulation) sees none.
    expect(new ProjectTrustStore({ path }).resolve(home).state).toBe('none');
  });
});

describe('ProjectTrustStore — malformed records', () => {
  it('drops malformed keys and records on read', async () => {
    const path = trustPath();
    const good = await stableIdentity(1n);
    const store = new ProjectTrustStore({ path });
    store.record(good, 'trusted');

    // Corrupt the file with an absolute-path key and a record missing fields.
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    parsed.projects['/Users/me/evil'] = { state: 'trusted' };
    parsed.projects['p_' + 'a'.repeat(32)] = { projectKey: 'p_' + 'a'.repeat(32), state: 'weird' };
    require('node:fs').writeFileSync(path, JSON.stringify(parsed));

    const reader = new ProjectTrustStore({ path });
    expect(reader.resolve(good).state).toBe('trusted');
    // The absolute-path key never surfaces as a valid grant.
    const badIdentity = await stableIdentity(1n);
    expect(reader.resolve(badIdentity).state).toBe('trusted'); // still just the good one
  });
});
