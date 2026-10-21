import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createCipheriv, createHash, pbkdf2Sync, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import {
  CredentialStoreCorruptError,
  SecureStorageBackend,
  SecureStorageBackendV2,
  createSecureStorageBackendV2,
  readStableMachineIdForTests,
  resetMachineIdentityMemo,
} from '../secure-storage.ts';
import { CredentialManager } from '../../manager.ts';
import { accountToCredentialId, credentialIdToAccount } from '../../types.ts';
import type { VerifiedStorageLayoutV2 } from '../../../workspaces/storage-readiness.ts';
import { latchedHomeDir, relatchHomeDirForTests } from '../../../config/home-latch.ts';

let dir: string;
let filePath: string;

const LAYOUT: VerifiedStorageLayoutV2 = { storageLayoutVersion: 2, verificationId: 'test' };

function newBackend(): SecureStorageBackendV2 {
  return createSecureStorageBackendV2(LAYOUT, { filePath });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'secure-storage-v2-'));
  filePath = join(dir, 'credentials.enc');
});

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('SecureStorageBackendV2', () => {
  it('round-trips a remote Workspace token only through its typed manager methods', async () => {
    const backend = newBackend();
    const manager = new CredentialManager(backend);

    await manager.setRemoteServerToken('workspace-1', 'remote-secret');

    expect(credentialIdToAccount({
      type: 'remote_server_token',
      workspaceId: 'workspace-1',
    })).toBe('remote_server_token::workspace-1');
    expect(accountToCredentialId('remote_server_token::workspace-1')).toEqual({
      type: 'remote_server_token',
      workspaceId: 'workspace-1',
    });
    expect(await manager.getRemoteServerToken('workspace-1')).toBe('remote-secret');
    expect(JSON.stringify(backend.bind({
      type: 'remote_server_token',
      workspaceId: 'workspace-1',
    }))).not.toContain('remote-secret');
    expect(await manager.deleteRemoteServerToken('workspace-1')).toBe(true);
    expect(await manager.getRemoteServerToken('workspace-1')).toBeNull();
  });

  it('keeps corruption fail-closed through typed remote token reads', async () => {
    writeFileSync(filePath, Buffer.alloc(200, 7));
    const manager = new CredentialManager(newBackend());

    await expect(manager.getRemoteServerToken('workspace-1')).rejects.toBeInstanceOf(
      CredentialStoreCorruptError,
    );
    expect(existsSync(filePath)).toBe(true);
  });

  it('round-trips credentials and returns no revision in the DTO', async () => {
    const backend = newBackend();
    await backend.set({ type: 'llm_api_key', connectionSlug: 'primary' }, { value: 'secret-1' });
    const got = await backend.get({ type: 'llm_api_key', connectionSlug: 'primary' });
    expect(got?.value).toBe('secret-1');
    expect('revision' in (got as object)).toBe(false);
  });

  it('persists the global telemetry salt through a fresh encrypted v2 backend', async () => {
    const salt = 'a'.repeat(64);
    const id = { type: 'telemetry_salt' } as const;
    await newBackend().set(id, { value: salt });

    expect(credentialIdToAccount(id)).toBe('telemetry_salt::global');
    expect(await newBackend().get(id)).toEqual({ value: salt });
    expect(readFileSync(filePath).includes(Buffer.from(salt))).toBe(false);
  });

  it('advances a monotonic non-secret revision on every write and delete', async () => {
    const backend = newBackend();
    const id = { type: 'llm_api_key', connectionSlug: 'primary' } as const;
    await backend.set(id, { value: 'a' });
    const r1 = backend.getRevision(id);
    await backend.set(id, { value: 'b' });
    const r2 = backend.getRevision(id);
    expect(r2).toBeGreaterThan(r1);
    const storeRevBefore = backend.getStoreRevision();
    await backend.delete(id);
    expect(backend.getStoreRevision()).toBeGreaterThan(storeRevBefore);
    // Revision is derived from write count, never from secret bytes.
    const backend2 = newBackend();
    await backend2.set({ type: 'llm_api_key', connectionSlug: 'x' }, { value: 'short' });
    await backend2.set({ type: 'llm_api_key', connectionSlug: 'y' }, { value: 'a-much-longer-secret-value' });
    expect(backend2.getRevision({ type: 'llm_api_key', connectionSlug: 'y' })).toBeGreaterThan(
      backend2.getRevision({ type: 'llm_api_key', connectionSlug: 'x' }),
    );
  });

  it('writes with 0600 permissions', async () => {
    if (process.platform === 'win32') return;
    const backend = newBackend();
    await backend.set({ type: 'llm_api_key', connectionSlug: 'primary' }, { value: 'secret' });
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it('resolves a runtime binding only when revision matches (ready-state)', async () => {
    const backend = newBackend();
    const id = { type: 'llm_api_key', connectionSlug: 'primary' } as const;
    await backend.set(id, { value: 'secret-1' });
    const binding = backend.bind(id);

    const ready = backend.resolveRuntimeCredential(binding);
    expect(ready.ready).toBe(true);
    expect(ready.value).toBe('secret-1');

    // Rotate: the old binding is now stale and yields no secret.
    await backend.set(id, { value: 'secret-2' });
    const stale = backend.resolveRuntimeCredential(binding);
    expect(stale.ready).toBe(false);
    expect(stale.value).toBeUndefined();
    expect(stale.revision).toBe(backend.getRevision(id));

    // A fresh binding resolves again.
    expect(backend.resolveRuntimeCredential(backend.bind(id)).value).toBe('secret-2');
  });

  it('never reuses a credential revision after delete and re-add', async () => {
    const backend = newBackend();
    const id = { type: 'llm_api_key', connectionSlug: 'primary' } as const;
    await backend.set(id, { value: 'secret-1' });
    const old = backend.bind(id);
    await backend.delete(id);
    await backend.set(id, { value: 'secret-2' });

    expect(backend.resolveRuntimeCredential(old)).toMatchObject({ ready: false });
    expect(backend.bind(id).expectedRevision).toBeGreaterThan(old.expectedRevision);
  });

  it('a binding carries no secret bytes', async () => {
    const backend = newBackend();
    const id = { type: 'llm_api_key', connectionSlug: 'primary' } as const;
    await backend.set(id, { value: 'top-secret-value' });
    const binding = backend.bind(id);
    expect(JSON.stringify(binding)).not.toContain('top-secret-value');
  });

  it('fails closed on a corrupt file without deleting or overwriting it', () => {
    // Bad magic bytes.
    const corrupt = Buffer.alloc(200, 7);
    writeFileSync(filePath, corrupt);
    const before = readFileSync(filePath);
    const backend = newBackend();
    expect(() => backend.getStoreRevision()).toThrow(CredentialStoreCorruptError);
    // File is byte-identical after the failed read.
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath).equals(before)).toBe(true);
  });

  it('fails closed on a truncated file', () => {
    writeFileSync(filePath, Buffer.alloc(10));
    const backend = newBackend();
    expect(() => backend.getStoreRevision()).toThrow(CredentialStoreCorruptError);
    expect(existsSync(filePath)).toBe(true);
  });

  it('fails closed when the key cannot decrypt a well-formed-looking file', async () => {
    // Produce a valid store, then flip a ciphertext byte so decryption fails.
    const backend = newBackend();
    await backend.set({ type: 'llm_api_key', connectionSlug: 'primary' }, { value: 'secret' });
    const data = readFileSync(filePath);
    data[data.length - 1] = data[data.length - 1]! ^ 0xff;
    writeFileSync(filePath, data);
    const before = readFileSync(filePath);

    const fresh = newBackend();
    expect(() => fresh.getStoreRevision()).toThrow(CredentialStoreCorruptError);
    expect(readFileSync(filePath).equals(before)).toBe(true);
  });

  it('fails closed on malformed persisted credential revisions', () => {
    const writer = newBackend();
    const now = Date.now();
    const commit = (writer as unknown as {
      commit(store: unknown): void;
    }).commit.bind(writer);
    commit({
      version: 2,
      revision: 3,
      credentials: {
        'llm_api_key::primary': { value: 'secret', revision: null },
      },
      metadata: { createdAt: now, updatedAt: now },
    });
    const before = readFileSync(filePath);

    const fresh = newBackend();
    expect(() => fresh.getStoreRevision()).toThrow(CredentialStoreCorruptError);
    expect(readFileSync(filePath).equals(before)).toBe(true);
  });

  it('treats an absent file as an empty store, not corruption', async () => {
    const backend = newBackend();
    expect(backend.getStoreRevision()).toBe(0);
    expect(await backend.get({ type: 'llm_api_key', connectionSlug: 'primary' })).toBeNull();
    expect(await backend.list()).toEqual([]);
  });
});

describe('SecureStorageBackend pre-W10 compatibility', () => {
  function seedLegacyRecord(
    backend: SecureStorageBackend,
    id: { type: 'llm_api_key'; connectionSlug: string },
    value = 'legacy-secret',
  ): void {
    const now = Date.now();
    const seed = backend as unknown as {
      saveStoreSync(store: {
        version: 1;
        credentials: Record<string, { value: string }>;
        metadata: { createdAt: number; updatedAt: number };
      }): void;
    };
    seed.saveStoreSync({
      version: 1,
      credentials: { [credentialIdToAccount(id)]: { value } },
      metadata: { createdAt: now, updatedAt: now },
    });
  }

  it('upgrades a pre-revision record above the historical implicit revision', async () => {
    const backend = new SecureStorageBackend({ filePath });
    const id = { type: 'llm_api_key', connectionSlug: 'primary' } as const;
    seedLegacyRecord(backend, id);

    const staleImplicitBinding = { id, expectedRevision: 1 };
    expect(backend.resolveRuntimeCredential(staleImplicitBinding)).toMatchObject({
      ready: false,
      revision: 2,
    });
    expect(backend.bind(id).expectedRevision).toBe(2);

    await backend.set(id, { value: 'rotated-secret' });
    expect(backend.resolveRuntimeCredential(staleImplicitBinding).ready).toBe(false);
    expect(backend.bind(id).expectedRevision).toBe(3);
  });

  it('rotates a pre-revision record above revision 1 even when set is the first operation', async () => {
    const backend = new SecureStorageBackend({ filePath });
    const id = { type: 'llm_api_key', connectionSlug: 'primary' } as const;
    seedLegacyRecord(backend, id);

    const staleImplicitBinding = { id, expectedRevision: 1 };
    await backend.set(id, { value: 'rotated-secret' });

    expect(backend.bind(id).expectedRevision).toBe(2);
    expect(backend.resolveRuntimeCredential(staleImplicitBinding).ready).toBe(false);
    expect(backend.resolveRuntimeCredential(backend.bind(id)).value).toBe('rotated-secret');
  });

  it('does not reuse revision 1 when a pre-revision record is deleted and re-added', async () => {
    const backend = new SecureStorageBackend({ filePath });
    const id = { type: 'llm_api_key', connectionSlug: 'primary' } as const;
    seedLegacyRecord(backend, id);

    expect(backend.deleteSync(id)).toBe(true);
    await backend.set(id, { value: 'replacement-secret' });

    expect(backend.bind(id).expectedRevision).toBe(3);
    expect(backend.resolveRuntimeCredential({ id, expectedRevision: 1 }).ready).toBe(false);
  });
});

/**
 * M1 (lane K). `getStableMachineId()` answers the hardware UUID when it can and
 * `` `${username}:${homedir}` `` when it cannot, deciding silently per call. A
 * store written while the hardware read failed is keyed to the fallback
 * identity under the CURRENT recipe — which neither `deriveStableKeyV2` (the
 * identity as it is NOW) nor `deriveLegacyKeyV2` (the v1 recipe over hostname)
 * reaches. The store is intact and unopenable.
 *
 * Measured on the owner's machine: the real store, 11 entries, decrypts under
 * exactly this key and under neither of the other two.
 *
 * The fixture writes the file by hand rather than mocking `getStableMachineId`.
 * `mock.module` is process-global in this runner and a replacement without a
 * spread un-implements every other export for every file that loads after it
 * (AGENTS.md), and the format is small enough to reproduce honestly: the write
 * path is `MAGIC | FLAGS | SALT | IV | AUTH_TAG | CIPHERTEXT`.
 */
function writeStoreUnderKey(path: string, key: Buffer, salt: Buffer, store: unknown): void {
  const plaintext = Buffer.from(JSON.stringify(store), 'utf8');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const header = Buffer.alloc(64);
  Buffer.from('NESSY01\0').copy(header, 0);
  header.writeUInt32LE(0, 8);
  salt.copy(header, 12);
  writeFileSync(path, Buffer.concat([header, iv, cipher.getAuthTag(), ciphertext]), { mode: 0o600 });
}

function fallbackIdentityKey(salt: Buffer): Buffer {
  const id = createHash('sha256')
    .update(`${userInfo().username}:${homedir()}`)
    .update('nessy-general-agent-v2')
    .digest();
  return pbkdf2Sync(id, salt, 100000, 32, 'sha256');
}

describe('SecureStorageBackendV2 — a store keyed to the fallback machine identity', () => {
  const storeFixture = {
    version: 2,
    revision: 7,
    credentials: {
      'anthropic_api_key::global': { value: 'sk-fixture-value', revision: 7, updatedAt: 1 },
    },
    metadata: { createdAt: 1, updatedAt: 1 },
  };

  it('opens it and migrates it to the current stable key', async () => {
    const salt = randomBytes(32);
    writeStoreUnderKey(filePath, fallbackIdentityKey(salt), salt, storeFixture);

    // It opens: the credential is readable rather than reported missing.
    const backend = newBackend();
    const read = await new CredentialManager(backend).getApiKey();
    expect(read).toBe('sk-fixture-value');

    // And it MIGRATED: a second backend, with no cache, opens the rewritten
    // file under the stable key alone. Without the re-encrypt this passes on
    // the fallback path forever and the defect is merely hidden.
    const rewritten = readFileSync(filePath);
    expect(rewritten.subarray(0, 8).toString()).toBe('NESSY01\0');
    expect(await new CredentialManager(newBackend()).getApiKey()).toBe('sk-fixture-value');
  });

  // The negative subject: a file that is genuinely not a credential store must
  // still say so. Without this, "always report a machine-identity mismatch"
  // passes the row above and misdiagnoses real damage in the other direction.
  it('still reports structural damage as corruption, not as a key mismatch', async () => {
    writeFileSync(filePath, Buffer.alloc(200, 7));
    // Asserted against the BACKEND, not through `CredentialManager.get()`:
    // that method catches every backend error and returns null (`manager.ts:160`),
    // so a corrupt store reads as "no credential" through most typed accessors.
    // Recorded as its own finding below; asserting through it here would test
    // the swallow rather than the message.
    const backend = newBackend();
    await expect(backend.get({ type: 'anthropic_api_key' })).rejects.toBeInstanceOf(CredentialStoreCorruptError);
    await expect(backend.get({ type: 'anthropic_api_key' })).rejects.toThrow(/bad magic bytes/);
  });

  /**
   * FINDING, recorded rather than fixed here — it is not M1's deliverable and
   * fixing it changes behaviour for every caller.
   *
   * `CredentialManager.get()` catches EVERY backend error and returns null
   * (`manager.ts:160-162`), so a `CredentialStoreCorruptError` reaches most
   * typed accessors as "no credential". Measured: with a store this machine
   * cannot open, `getApiKey()` RESOLVES with `null`. `getRemoteServerToken()`
   * propagates, so the two disagree.
   *
   * That is why the packaged app does not hard-fail on an unopenable store: it
   * reports every BYO key as simply not configured. The honest message M1 adds
   * is therefore invisible on this path until the swallow is addressed — which
   * is the argument for addressing it, and also the reason it needs its own
   * decision rather than riding along in this commit.
   */
  /**
   * The narrow un-swallow (owner decision 2026-08-15, variant B).
   *
   * `CredentialManager.get()` used to catch EVERY backend error and return
   * null, so "the store could not be opened" and "no credential is stored"
   * arrived at all nine typed accessors as the same value — which is why the
   * packaged build showed empty connections instead of a reason.
   *
   * Only the different-identity failure propagates. Everything else keeps
   * today's silence: un-swallowing all of it would trade one false answer for a
   * worse one, since a new user with no store yet would meet errors where
   * "you have not added a key" is the honest reply.
   */
  it('propagates the different-identity failure through a typed accessor', async () => {
    const salt = randomBytes(32);
    writeStoreUnderKey(filePath, randomBytes(32), salt, storeFixture);

    const manager = new CredentialManager(newBackend());
    await expect(manager.getApiKey()).rejects.toThrow(/different machine identity/);
    // And it names the way out, because the fear is "my keys are gone".
    await expect(manager.getApiKey()).rejects.toThrow(/Enter the key again/);
  });

  // THE negative subject, and the reason the fix is narrow: a user who has
  // simply not added a key must still get null, not an error.
  it('still reads as "no credential" when there is no store at all', async () => {
    expect(existsSync(filePath)).toBe(false);
    expect(await new CredentialManager(newBackend()).getApiKey()).toBeNull();
  });

  // Structural damage keeps today's silence too — only the identity case is
  // discriminated, and it is discriminated by a FIELD, never by the sentence.
  it('still reads as "no credential" when the file is structurally damaged', async () => {
    writeFileSync(filePath, Buffer.alloc(200, 7));
    expect(await new CredentialManager(newBackend()).getApiKey()).toBeNull();
  });

  // A structurally valid store under a key nobody has is the honest end state:
  // it must fail closed, keep the file, and name the cause.
  it('names the cause when no known key opens a structurally valid store', async () => {
    const salt = randomBytes(32);
    writeStoreUnderKey(filePath, randomBytes(32), salt, storeFixture);
    const before = readFileSync(filePath);

    const backend = newBackend();
    await expect(backend.get({ type: 'anthropic_api_key' })).rejects.toThrow(/different machine identity/);
    await expect(backend.get({ type: 'anthropic_api_key' })).rejects.toBeInstanceOf(CredentialStoreCorruptError);
    // Fail-closed is the contract this lane must not weaken.
    expect(readFileSync(filePath).equals(before)).toBe(true);
  });
});

/**
 * M2 (lane K). The v1 backend deleted the credential file on three read paths,
 * one of which is "both keys failed" — which is not corruption but exactly the
 * case lane K exists for: a structurally valid store under a different machine
 * identity. On that path v1 destroyed the user's credentials during a READ.
 *
 * v1 is unreachable in production (`initializeCredentialManagerV2` is the only
 * construction site and passes a v2 backend; `getCredentialManager()` throws
 * without it), and it is kept for the pre-W10 v1 FORMAT it reads. So the delete
 * is quarantined rather than the class removed — a deny path that destroys
 * credentials must not survive merely because nothing calls it today.
 */
describe('SecureStorageBackend — the v1 delete path is quarantined', () => {
  it('leaves an unreadable file on disk instead of deleting it', async () => {
    writeFileSync(filePath, Buffer.alloc(200, 7));
    const before = readFileSync(filePath);

    const backend = new SecureStorageBackend({ filePath } as never);
    // Fail-soft is v1's contract and is unchanged; only the deletion is gone.
    expect(await backend.get({ type: 'anthropic_api_key' })).toBeNull();

    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath).equals(before)).toBe(true);
  });
})

/**
 * P3.167 — a moved `HOME` does not relocate this store, it RE-KEYS it.
 *
 * The file lives at `CONFIG_DIR`, which `config/paths.ts` freezes at import and
 * which P3.133 measured as the one path a delivered `HOME` never moves. So the
 * failure has a different shape from the creds-file one P3.143 fixed: the
 * backend still opens the right FILE, derives a different KEY for it, and
 * answers *not found* rather than *wrong path*. A user reads that as "my
 * credentials vanished" and re-authenticates, which writes the new entries
 * under the new key and orphans the originals.
 *
 * `homedir()` reaches the key through three recipes — `getStableMachineId()`'s
 * fallback, `deriveLegacyKeyV2`, `deriveFallbackIdentityKeyV2` — and all three
 * now read `latchedHomeDir()`. The fallback-identity recipe is the one asserted
 * here because it is the only one reachable without mocking the hardware-UUID
 * read: on this rig `ioreg` answers a 36-character UUID (positive control on
 * the same rig: a bogus binary throws, so the fallback branch is reachable and
 * simply is not reached), which is exactly why `homedir()` is absent from the
 * stable key on a healthy machine and present the moment that read fails.
 *
 * MIGRATION, measured rather than assumed. In any session where `HOME` does not
 * move mid-process the latch is byte-identical to `os.homedir()`, so every key
 * over every existing store is unchanged and there is nothing to migrate. The
 * only stores the latch can miss are ones WRITTEN while `HOME` had already
 * moved — and those were already unopenable in every session that did not
 * repeat the same move at the same moment, which is the report this row exists
 * to stop. The latch removes the mechanism; it does not create the orphan.
 */
function fallbackIdentityKeyForHome(home: string, salt: Buffer): Buffer {
  const id = createHash('sha256')
    .update(`${userInfo().username}:${home}`)
    .update('nessy-general-agent-v2')
    .digest();
  return pbkdf2Sync(id, salt, 100000, 32, 'sha256');
}

describe('SecureStorageBackendV2 — the key derivation reads the latched home', () => {
  const SESSION_HOME = '/nessy-p3167-session-home';
  const MOVED_HOME = '/nessy-p3167-admin-home';
  const storeFixture = {
    version: 2,
    revision: 3,
    credentials: {
      'anthropic_api_key::global': { value: 'sk-p3167-value', revision: 3, updatedAt: 1 },
    },
    metadata: { createdAt: 1, updatedAt: 1 },
  };

  afterEach(() => {
    relatchHomeDirForTests();
  });

  it('opens a store keyed to the LATCHED home while `os.homedir()` says something else', async () => {
    relatchHomeDirForTests(SESSION_HOME);
    // Negative control: the latch and the live home genuinely differ here, so a
    // pass cannot come from the two being the same string.
    expect(latchedHomeDir()).toBe(SESSION_HOME);
    expect(homedir()).not.toBe(SESSION_HOME);

    const salt = randomBytes(32);
    writeStoreUnderKey(filePath, fallbackIdentityKeyForHome(SESSION_HOME, salt), salt, storeFixture);

    // Pre-P3.167 the third read attempt derived over `os.homedir()` and missed,
    // so this resolved to a `different machine identity` rejection instead.
    expect(await new CredentialManager(newBackend()).getApiKey()).toBe('sk-p3167-value');
  });

  it('and a moved home is a RE-KEY, not a relocation: same file, different identity', async () => {
    const salt = randomBytes(32);
    writeStoreUnderKey(filePath, fallbackIdentityKeyForHome(SESSION_HOME, salt), salt, storeFixture);
    const before = readFileSync(filePath);

    relatchHomeDirForTests(MOVED_HOME);

    // The FILE is untouched and exactly where it was — this is the half that
    // makes the failure read as "vanished" rather than "wrong path".
    expect(existsSync(filePath)).toBe(true);
    await expect(new CredentialManager(newBackend()).getApiKey()).rejects.toThrow(/different machine identity/);
    expect(readFileSync(filePath).equals(before)).toBe(true);
  });
});


/**
 * D1.125 — a first connection switch shortly after launch failed telling the
 * user to re-enter a credential that was perfectly good, and the cause went
 * unestablished at the sitting.
 *
 * What the code says: the hardware read is an `execSync` taken afresh on every
 * key derivation, and its catch cannot tell "no hardware id on this machine"
 * from "I could not read it this time" — so one unlucky spawn at a busy launch
 * derives every key from the FALLBACK identity, and a store written under the
 * hardware id is intact and unopenable. These four cases drive that seam
 * directly rather than through a store, because the identity is the input the
 * whole read ladder shares.
 */
describe('D1.125 · the machine identity is decided once, and a bad moment is not a verdict', () => {
  const UUID = '00000000-1111-2222-3333-444444444444';
  const IOREG = `"IOPlatformUUID" = "${UUID}"`;

  beforeEach(() => { resetMachineIdentityMemo(); });
  afterEach(() => { resetMachineIdentityMemo(); });

  it('survives ONE transient failure instead of falling back — the measured case', () => {
    let calls = 0;
    const fallbacks: string[] = [];
    const id = readStableMachineIdForTests({
      platform: 'darwin',
      onFallback: reason => { fallbacks.push(reason); },
      exec: () => {
        calls += 1;
        if (calls === 1) throw new Error('spawn ENOMEM');
        return IOREG;
      },
    });
    expect(id).toBe(UUID);
    expect(calls).toBe(2);
    expect(fallbacks).toEqual([]);
  });

  it('remembers a HARDWARE answer, so later derivations spawn nothing', () => {
    let calls = 0;
    const probe = { platform: 'darwin' as const, exec: () => { calls += 1; return IOREG; } };
    expect(readStableMachineIdForTests(probe)).toBe(UUID);
    expect(readStableMachineIdForTests(probe)).toBe(UUID);
    expect(readStableMachineIdForTests(probe)).toBe(UUID);
    // Three derivations over one read ladder used to cost six processes on
    // darwin, the platform read being a shell pipeline.
    expect(calls).toBe(1);
  });

  it('NEVER remembers a fallback, so one bad moment cannot poison the process', () => {
    let calls = 0;
    const fallbacks: string[] = [];
    const exec = () => {
      calls += 1;
      if (calls <= 2) throw new Error('spawn EAGAIN');
      return IOREG;
    };
    const first = readStableMachineIdForTests({ platform: 'darwin', exec, onFallback: r => { fallbacks.push(r); } });
    expect(first).toBe(`${userInfo().username}:${latchedHomeDir()}`);
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]).toContain('could not be read');
    // ...and the value is never in the reason: this file's whole subject is
    // keeping a username and a home path out of a bug report.
    expect(fallbacks[0]).not.toContain(userInfo().username);

    // The very next derivation reads again and gets the real id — which is the
    // difference between a launch hiccup and a session-long wrong key.
    expect(readStableMachineIdForTests({ platform: 'darwin', exec })).toBe(UUID);
  });

  it('a platform with no hardware source still falls back, one read later', () => {
    // The NEGATIVE: the retry must not turn "this machine has no id" into a
    // spin. Two attempts, a distinguishable reason, and the same answer as
    // before this row.
    let calls = 0;
    const fallbacks: string[] = [];
    const id = readStableMachineIdForTests({
      platform: 'darwin',
      exec: () => { calls += 1; return 'no uuid in this output'; },
      onFallback: reason => { fallbacks.push(reason); },
    });
    expect(id).toBe(`${userInfo().username}:${latchedHomeDir()}`);
    expect(calls).toBe(2);
    expect(fallbacks).toEqual(['no hardware machine id on this platform']);
  });
});
