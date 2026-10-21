/**
 * Secure Storage Backend
 *
 * Stores credentials in an encrypted file at ~/.nessy-agent/credentials.enc
 * Uses AES-256-GCM for authenticated encryption.
 *
 * Encryption key is derived from OS-native hardware UUID using PBKDF2:
 * - macOS: IOPlatformUUID (tied to logic board, never changes)
 * - Windows: MachineGuid from registry (set at OS install)
 * - Linux: /var/lib/dbus/machine-id (set at OS install)
 *
 * This is more stable than the previous hostname-based derivation, which could
 * change with network/DHCP. Legacy credentials are auto-migrated on first load.
 *
 * File format:
 *   [Header - 64 bytes]
 *   ├── Magic: "NESSY01\0" (8 bytes)
 *   ├── Flags: uint32 LE (4 bytes) - reserved for future use
 *   ├── Salt: 32 bytes (PBKDF2 salt)
 *   ├── Reserved: 20 bytes
 *   [Encrypted Payload]
 *   ├── IV: 12 bytes (random per write)
 *   ├── Auth Tag: 16 bytes (GCM authentication)
 *   └── Ciphertext: variable (encrypted JSON)
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  pbkdf2Sync,
  createHash,
} from 'crypto';
import { execSync } from 'child_process';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { hostname, userInfo } from 'os';
import { basename, join, dirname } from 'path';

import type { CredentialBackend } from './types.ts';
import type {
  CredentialId,
  ResolvedRuntimeCredential,
  RevisionedStoredCredential,
  RuntimeCredentialBinding,
  StoredCredential,
} from '../types.ts';
import { credentialIdToAccount, accountToCredentialId } from '../types.ts';
import { syncDirectory } from '../../utils/durable-fs.ts';
import type { VerifiedStorageLayoutV2 } from '../../workspaces/storage-readiness.ts';
import { CONFIG_DIR } from '../../config/paths.ts';
import { createLogger } from '../../utils/debug.ts';
import { latchedHomeDir } from '../../config/home-latch.ts';

// File location
const CREDENTIALS_DIR = CONFIG_DIR;
const CREDENTIALS_FILE = join(CREDENTIALS_DIR, 'credentials.enc');

const credentialLog = createLogger('credentials');

export interface SecureStorageBackendOptions {
  /** Test seam: override the retained pre-W10 credential file path. */
  filePath?: string;
}

// File format constants
// Format signature. Renamed during the de-brand:
// old credential files fail the magic check on load and are treated as absent,
// so users re-authenticate once (accepted — pre-release, no migration).
const MAGIC_BYTES = Buffer.from('NESSY01\0');
const HEADER_SIZE = 64;
const MAGIC_SIZE = 8;
const FLAGS_SIZE = 4;
const SALT_SIZE = 32;
const IV_SIZE = 12;
const AUTH_TAG_SIZE = 16;
const KEY_SIZE = 32;

// PBKDF2 iterations (balance security vs startup time)
const PBKDF2_ITERATIONS = 100000;

/**
 * Get stable machine identifier using OS-native hardware UUID.
 * This is far more stable than hostname which can change with network/DHCP.
 * Falls back to username + homedir if hardware UUID unavailable.
 *
 * **The fallback reads the LATCHED home, not `os.homedir()` — P3.167.** The
 * store's FILE never moves with `HOME` (it lives at `CONFIG_DIR`, which
 * `config/paths.ts` freezes at import), so a moved `HOME` does not point this
 * backend at another store: it changes the KEY of the one that is already
 * there. The failure therefore surfaces as *not found* rather than *wrong
 * path* — a user reads it as "my credentials vanished", and re-authenticating
 * writes the new entries under the new key and orphans the originals. Every
 * derivation below that takes a home takes this one, so the whole read ladder
 * and the write agree on a single answer for the life of the session.
 */
/**
 * D1.125 — the answer is decided ONCE per process, and only a HARDWARE answer
 * is remembered.
 *
 * The measured failure: about a minute after launch, a first connection switch
 * failed with this backend's machine-identity message on a credential that was
 * perfectly good; the same card answered `{"ok":true}` eight minutes later and
 * again after a relaunch. The cause was never established at the sitting and
 * this is what the code says it is — the platform read below is an `execSync`
 * (on darwin a SHELL pipeline, so two processes), taken afresh on every key
 * derivation, and its `catch` cannot tell *this machine has no hardware UUID*
 * from *I could not read it this time*. A launch busy enough to fail one spawn
 * — and AGENTS.md records that Electron does not inherit the shell's
 * `ulimit -n`, floor 256 on this rig — therefore derives every key from the
 * FALLBACK identity, and a store written under the hardware UUID is intact and
 * unopenable. That is the exact direction `deriveFallbackIdentityKeyV2`'s
 * docblock records as the one it cannot recover.
 *
 * Three narrow changes, and none of them is "try harder forever":
 *
 *  - a successful HARDWARE answer is memoised for the process. The value is a
 *    logic-board id; it cannot change under us. This also removes the repeated
 *    spawns — three key derivations over one read ladder cost six processes
 *    before this.
 *  - a FALLBACK answer is NEVER memoised, so one unlucky moment at launch
 *    cannot poison the rest of the process: the next derivation reads again and
 *    gets the real id.
 *  - one retry before falling back, because the failure this row measures is
 *    transient. A machine that genuinely has no hardware source fails both
 *    attempts and lands on the fallback exactly as before, one spawn later.
 *
 * And the fallback stops being silent: `onMachineIdentityFallback` is called
 * with the reason, never with a value, so the next report of this failure says
 * which identity the key was derived from instead of leaving a lane to guess.
 */
let memoizedHardwareMachineId: string | null = null;

/** Test seam only — production never passes these. */
export interface MachineIdentityProbe {
  exec?: (command: string) => string;
  platform?: NodeJS.Platform;
  onFallback?: (reason: string) => void;
}

/** D1.125 — drop the memo. Tests only; production reads it once and keeps it. */
export function resetMachineIdentityMemo(): void {
  memoizedHardwareMachineId = null;
}

function readHardwareMachineId(probe?: MachineIdentityProbe): string | null {
  const platform = probe?.platform ?? process.platform;
  const exec = probe?.exec
    ?? ((command: string) => execSync(command, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }));
  if (platform === 'darwin') {
    // macOS: IOPlatformUUID - tied to logic board, never changes
    const output = exec('ioreg -rd1 -c IOPlatformExpertDevice | grep IOPlatformUUID');
    return output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1] ?? null;
  }
  if (platform === 'win32') {
    // Windows: MachineGuid from registry - set at OS install
    const output = exec('reg query HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid');
    return output.match(/MachineGuid\s+REG_SZ\s+(\S+)/)?.[1] ?? null;
  }
  // Linux: dbus machine-id - set at OS install
  const machineIdPath = '/var/lib/dbus/machine-id';
  const altPath = '/etc/machine-id';
  if (existsSync(machineIdPath)) return readFileSync(machineIdPath, 'utf-8').trim();
  if (existsSync(altPath)) return readFileSync(altPath, 'utf-8').trim();
  return null;
}

function getStableMachineId(probe?: MachineIdentityProbe): string {
  if (memoizedHardwareMachineId !== null) return memoizedHardwareMachineId;
  let lastError: unknown;
  // Two attempts, then the fallback. The second exists for the transient spawn
  // failure this row measured; a machine with no hardware source answers `null`
  // twice and costs one extra read.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const hardware = readHardwareMachineId(probe);
      if (hardware !== null && hardware.length > 0) {
        memoizedHardwareMachineId = hardware;
        return hardware;
      }
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
  }
  // NOT memoised: see the docblock. A fallback here is a statement about this
  // moment, not about this machine.
  //
  // And it is no longer SILENT. The report this row came from could not say
  // which identity the failing key had been derived from, which is why its
  // cause went unestablished; the line below is what makes the next one
  // answerable. It carries a REASON and never a value — the fallback identity
  // is a username and a home path, and this file's whole subject is keeping
  // those out of anything that gets copied into a bug report.
  (probe?.onFallback ?? ((reason: string) => credentialLog.warn(
    `machine identity fell back to username+home for this key derivation — ${reason}`,
  )))(
    lastError === undefined
      ? 'no hardware machine id on this platform'
      : `hardware machine id could not be read: ${lastError instanceof Error ? lastError.name : 'unknown'}`,
  );
  // Fallback: username + latched homedir (stable enough for most cases)
  return `${userInfo().username}:${latchedHomeDir()}`;
}

/** D1.125 — the probe seam, exported for the cases that drive both arms. */
export function readStableMachineIdForTests(probe: MachineIdentityProbe): string {
  return getStableMachineId(probe);
}

/** Internal credential store structure */
interface CredentialStore {
  version: 1;
  /** Optional compatibility revision used by the pre-W10 runtime adapter. */
  revision?: number;
  credentials: Record<string, StoredCredential | RevisionedStoredCredential>;
  metadata: {
    createdAt: number;
    updatedAt: number;
  };
}

export class SecureStorageBackend implements CredentialBackend {
  readonly name = 'secure-storage';
  readonly priority = 100;

  private readonly filePath: string;
  private readonly dir: string;
  private cachedStore: CredentialStore | null = null;
  private encryptionKey: Buffer | null = null;
  private salt: Buffer | null = null;

  constructor(options: SecureStorageBackendOptions = {}) {
    this.filePath = options.filePath ?? CREDENTIALS_FILE;
    this.dir = dirname(this.filePath);
  }

  async isAvailable(): Promise<boolean> {
    // File backend is always available - we can always write to filesystem
    return true;
  }

  async get(id: CredentialId): Promise<StoredCredential | null> {
    const store = await this.loadStore();
    if (!store) return null;

    const key = credentialIdToAccount(id);
    const record = store.credentials[key];
    return record ? stripRevision(record as RevisionedStoredCredential) : null;
  }

  async set(id: CredentialId, credential: StoredCredential): Promise<void> {
    let store = await this.loadStore();

    if (!store) {
      // Initialize new store
      store = {
        version: 1,
        credentials: {},
        metadata: {
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      };
    }

    const key = credentialIdToAccount(id);
    const revision = this.nextMutationRevision(store, store.credentials[key]);
    store.revision = revision;
    store.credentials[key] = { ...credential, revision };
    store.metadata.updatedAt = Date.now();

    await this.saveStore(store);
  }

  async delete(id: CredentialId): Promise<boolean> {
    return this.deleteSync(id);
  }

  deleteSync(id: CredentialId): boolean {
    const store = this.loadStoreSync();
    if (!store) return false;

    const key = credentialIdToAccount(id);
    if (!(key in store.credentials)) return false;

    const revision = this.nextMutationRevision(store, store.credentials[key]);
    delete store.credentials[key];
    store.revision = revision;
    store.metadata.updatedAt = Date.now();

    this.saveStoreSync(store);
    return true;
  }

  async list(filter?: Partial<CredentialId>): Promise<CredentialId[]> {
    const store = await this.loadStore();
    if (!store) return [];

    const ids = Object.keys(store.credentials)
      .map(accountToCredentialId)
      .filter((id): id is CredentialId => id !== null);

    if (!filter) return ids;

    return ids.filter((id) => {
      if (filter.type && id.type !== filter.type) return false;
      if (filter.workspaceId && id.workspaceId !== filter.workspaceId) return false;
      if (filter.name && id.name !== filter.name) return false;
      return true;
    });
  }

  /** Existing-backend compatibility binding used until W10 switches writers. */
  bind(id: CredentialId): RuntimeCredentialBinding {
    return { id, expectedRevision: this.runtimeRevision(id) };
  }

  getRuntimeCredentialStatus(id: CredentialId): {
    state: 'ready' | 'missing' | 'expired';
    revision: number;
  } {
    const store = this.loadStoreFreshSync();
    const record = store?.credentials[credentialIdToAccount(id)] as RevisionedStoredCredential | undefined;
    if (!record) return { state: 'missing', revision: 0 };
    const revision = this.ensureRuntimeRevision(store!, record);
    if (record.expiresAt !== undefined && record.expiresAt <= Date.now()) {
      return { state: 'expired', revision };
    }
    return { state: 'ready', revision };
  }

  resolveRuntimeCredential(binding: RuntimeCredentialBinding): ResolvedRuntimeCredential {
    const store = this.loadStoreFreshSync();
    const record = store?.credentials[credentialIdToAccount(binding.id)] as RevisionedStoredCredential | undefined;
    if (!record) return { ready: false, revision: 0 };
    const revision = this.ensureRuntimeRevision(store!, record);
    if (revision !== binding.expectedRevision) return { ready: false, revision };
    if (record.expiresAt !== undefined && record.expiresAt <= Date.now()) {
      return { ready: false, revision };
    }
    return {
      ready: true,
      revision,
      value: record.value,
      credential: stripRevision(record),
    };
  }

  // ============================================================
  // Private Methods
  // ============================================================

  private async loadStore(): Promise<CredentialStore | null> {
    return this.loadStoreSync();
  }

  private runtimeRevision(id: CredentialId): number {
    const store = this.loadStoreFreshSync();
    const record = store?.credentials[credentialIdToAccount(id)] as RevisionedStoredCredential | undefined;
    if (!store || !record) return 0;
    return this.ensureRuntimeRevision(store, record);
  }

  private ensureRuntimeRevision(
    store: CredentialStore,
    record: RevisionedStoredCredential,
  ): number {
    if (typeof record.revision === 'number') return record.revision;
    // Revision 1 was the historical implicit fallback. Upgrade a pre-revision
    // record above that floor before status, bind, or resolve can observe it,
    // so a stale expectedRevision=1 can never authorize a later secret.
    const revision = Math.max(store.revision ?? 0, 1) + 1;
    store.revision = revision;
    record.revision = revision;
    store.metadata.updatedAt = Date.now();
    this.saveStoreSync(store);
    return revision;
  }

  private nextMutationRevision(
    store: CredentialStore,
    record: StoredCredential | RevisionedStoredCredential | undefined,
  ): number {
    const explicitRecordRevision = typeof (record as RevisionedStoredCredential | undefined)?.revision === 'number'
      ? (record as RevisionedStoredCredential).revision
      : 0;
    const implicitLegacyFloor = record && explicitRecordRevision === 0 ? 1 : 0;
    return Math.max(store.revision ?? 0, explicitRecordRevision, implicitLegacyFloor) + 1;
  }

  private loadStoreFreshSync(): CredentialStore | null {
    this.cachedStore = null;
    this.encryptionKey = null;
    this.salt = null;
    return this.loadStoreSync();
  }

  private loadStoreSync(): CredentialStore | null {
    // Return cached store if available
    if (this.cachedStore) return this.cachedStore;

    if (!existsSync(this.filePath)) return null;

    let fileData: Buffer;
    try {
      fileData = readFileSync(this.filePath);
    } catch {
      return null;
    }

    // Validate minimum size
    if (fileData.length < HEADER_SIZE + IV_SIZE + AUTH_TAG_SIZE) {
      // File is corrupted, delete and return null
      this.handleCorruptedFile();
      return null;
    }

    // Validate magic bytes
    if (!fileData.subarray(0, MAGIC_SIZE).equals(MAGIC_BYTES)) {
      this.handleCorruptedFile();
      return null;
    }

    // Parse header
    // const flags = fileData.readUInt32LE(MAGIC_SIZE); // Reserved for future use
    const salt = fileData.subarray(MAGIC_SIZE + FLAGS_SIZE, MAGIC_SIZE + FLAGS_SIZE + SALT_SIZE);
    this.salt = salt;

    // Extract encrypted data
    const encryptedData = fileData.subarray(HEADER_SIZE);

    // Try new stable key first (v2 - hardware UUID based)
    const newKey = this.getEncryptionKey(salt);
    let store = this.tryDecrypt(encryptedData, newKey);

    if (store) {
      this.cachedStore = store;
      return store;
    }

    // Try legacy key for migration (v1 - included hostname)
    // This handles credentials encrypted with old key derivation
    const legacyKey = this.getLegacyEncryptionKey(salt);
    store = this.tryDecrypt(encryptedData, legacyKey);

    if (store) {
      // Migration: re-save with new stable key so future loads use hardware UUID
      this.cachedStore = store;
      this.saveStoreSync(store);
      return store;
    }

    // Both keys failed - file is truly corrupted
    this.handleCorruptedFile();
    return null;
  }

  /**
   * Attempt to decrypt data with given key.
   * Returns parsed store on success, null on failure.
   */
  private tryDecrypt(encryptedData: Buffer, key: Buffer): CredentialStore | null {
    try {
      const iv = encryptedData.subarray(0, IV_SIZE);
      const authTag = encryptedData.subarray(IV_SIZE, IV_SIZE + AUTH_TAG_SIZE);
      const ciphertext = encryptedData.subarray(IV_SIZE + AUTH_TAG_SIZE);

      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return JSON.parse(decrypted.toString('utf8'));
    } catch {
      return null;
    }
  }

  private async saveStore(store: CredentialStore): Promise<void> {
    this.saveStoreSync(store);
  }

  private saveStoreSync(store: CredentialStore): void {
    // Ensure directory exists
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    }

    // Use existing salt or generate new one
    const salt = this.salt || randomBytes(SALT_SIZE);
    this.salt = salt;

    // Get encryption key
    const key = this.getEncryptionKey(salt);

    // Serialize payload
    const plaintext = Buffer.from(JSON.stringify(store), 'utf8');

    // Generate new IV for each write (critical for GCM security)
    const iv = randomBytes(IV_SIZE);

    // Encrypt
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Build header
    const header = Buffer.alloc(HEADER_SIZE);
    MAGIC_BYTES.copy(header, 0);
    header.writeUInt32LE(0, MAGIC_SIZE); // Flags (reserved)
    salt.copy(header, MAGIC_SIZE + FLAGS_SIZE);

    // Combine all parts
    const fileData = Buffer.concat([header, iv, authTag, ciphertext]);

    // Write with restrictive permissions (owner read/write only)
    writeFileSync(this.filePath, fileData, { mode: 0o600 });
    this.cachedStore = store;
  }

  private getEncryptionKey(salt: Buffer): Buffer {
    if (this.encryptionKey) return this.encryptionKey;

    // New stable machine ID using hardware UUID (v2)
    // This is far more stable than hostname which can change with network/DHCP
    const stableMachineId = createHash('sha256')
      .update(getStableMachineId())
      .update('nessy-general-agent-v2') // Bumped version for new key derivation
      .digest();

    // Derive key using PBKDF2
    this.encryptionKey = pbkdf2Sync(stableMachineId, salt, PBKDF2_ITERATIONS, KEY_SIZE, 'sha256');

    return this.encryptionKey;
  }

  /**
   * Legacy key derivation for migration from v1 (included hostname).
   * Used to decrypt credentials from older versions before re-encrypting with stable key.
   */
  private getLegacyEncryptionKey(salt: Buffer): Buffer {
    const legacyMachineId = createHash('sha256')
      .update(hostname())
      .update(userInfo().username)
      .update(latchedHomeDir())
      .update('nessy-general-agent-v1')
      .digest();

    return pbkdf2Sync(legacyMachineId, salt, PBKDF2_ITERATIONS, KEY_SIZE, 'sha256');
  }

  /**
   * Forget the cache. **Does not delete the file** — and it used to.
   *
   * This method ran `unlinkSync(this.filePath)` on three paths, one of which is
   * "both keys failed". That is not corruption: it is the case lane K exists
   * for — a structurally valid store encrypted under a different machine
   * identity — and on that path v1 DESTROYED the user's credentials, silently,
   * on a read. The v2 backend has always failed closed instead
   * (`CredentialStoreCorruptError`, file left untouched).
   *
   * The class is **not reachable in production**: `initializeCredentialManagerV2`
   * is the only construction site (`manager.ts:789`) and it passes a v2 backend,
   * `getCredentialManager()` throws without it, and the two `new SecureStorageBackend()`
   * sites (`manager.ts:78`, `:89`) sit on init branches a constructor-supplied
   * backend never reaches. It is kept for the pre-W10 v1 FORMAT it can read —
   * `SecureStorageBackend pre-W10 compatibility` in this backend's tests is that
   * contract — which is why quarantining the delete is the right shape and
   * deleting the class is not.
   *
   * Kept as unreachable-by-refactor safety rather than left to a future reader
   * to rediscover: a deny path that destroys credentials must not survive
   * merely because nothing calls it today.
   */
  private handleCorruptedFile(): void {
    this.cachedStore = null;
    this.encryptionKey = null;
    this.salt = null;
  }

  /** Clear cached data (for testing or forced refresh) */
  clearCache(): void {
    this.cachedStore = null;
    this.encryptionKey = null;
    this.salt = null;
  }
}

// ============================================================
// Revisioned v2 backend (W7 Step 9)
// ============================================================

/** Fail-closed corruption signal. The file is NEVER deleted or overwritten. */
export class CredentialStoreCorruptError extends Error {
  /**
   * Which failure this is, as a FIELD rather than a sentence.
   *
   * `foreign-identity` means the file is a valid credential store this machine
   * identity cannot open; `corrupt` means it is structurally not one. Callers
   * that need to tell them apart — `CredentialManager.get()` propagates the
   * first and stays silent for the second — branch on this.
   *
   * Deliberately not derivable from the message: that text is user-facing and
   * will be reworded or translated, and a caller matching on it is a defect
   * scheduled for the first copy change.
   */
  readonly kind: 'corrupt' | 'foreign-identity';

  constructor(reason: string, kind: 'corrupt' | 'foreign-identity' = 'corrupt') {
    // Message carries a reason only — never any secret bytes.
    super(kind === 'foreign-identity' ? reason : `Credential store is corrupt and was left untouched: ${reason}`);
    this.name = 'CredentialStoreCorruptError';
    this.kind = kind;
  }
}

interface CredentialStoreV2 {
  version: 2;
  /** Monotonic store revision advanced on every write/rotation/delete. */
  revision: number;
  credentials: Record<string, RevisionedStoredCredential>;
  metadata: { createdAt: number; updatedAt: number };
}

function deriveStableKeyV2(salt: Buffer): Buffer {
  const stableMachineId = createHash('sha256')
    .update(getStableMachineId())
    .update('nessy-general-agent-v2')
    .digest();
  return pbkdf2Sync(stableMachineId, salt, PBKDF2_ITERATIONS, KEY_SIZE, 'sha256');
}

function deriveLegacyKeyV2(salt: Buffer): Buffer {
  const legacyMachineId = createHash('sha256')
    .update(hostname())
    .update(userInfo().username)
    .update(latchedHomeDir())
    .update('nessy-general-agent-v1')
    .digest();
  return pbkdf2Sync(legacyMachineId, salt, PBKDF2_ITERATIONS, KEY_SIZE, 'sha256');
}

/**
 * The v2 recipe over `getStableMachineId()`'s FALLBACK identity.
 *
 * `getStableMachineId()` answers the hardware UUID when it can and
 * `` `${username}:${homedir}` `` when it cannot — and it decides that silently,
 * per call. A store written while the hardware read failed is therefore keyed
 * to the fallback identity under the CURRENT recipe, and neither of the two
 * keys above reaches it: `deriveStableKeyV2` uses whatever the identity is now,
 * and `deriveLegacyKeyV2` is the v1 recipe over hostname. The store is fully
 * intact and simply unopenable.
 *
 * That is not hypothetical. On the owner's machine the real store — 11 entries,
 * structurally valid — decrypts under exactly this key and under neither of the
 * other two, so a packaged build (where `loadShellEnv()` restores a PATH that
 * makes `ioreg` resolve) reports every credential missing. The user-facing
 * shape is narrower than "the store is corrupt": BYO credentials are invisible
 * while the gateway cards keep working, because those authenticate from
 * `~/.nessy/dp_auth_creds.json`, outside the credential store entirely.
 *
 * **The latch (P3.167) needs no migration, and this is the reason.** The home
 * that reaches this recipe — and `deriveLegacyKeyV2`, and `getStableMachineId`'s
 * fallback — is now `latchedHomeDir()`. In any session where `HOME` does not
 * move mid-process, that is byte-identical to `os.homedir()`, so every key over
 * every existing store is unchanged. The only stores it can miss are ones
 * WRITTEN while `HOME` was already moved — and those were already unreadable in
 * every session that did not repeat the same move at the same moment, which is
 * the "my credentials vanished" report this row exists to stop. The latch does
 * not create that orphan; it removes the mechanism that makes new ones. Adding a
 * fourth attempt keyed on the LIVE home to recover them was considered and
 * rejected: it re-admits the very input the latch removes, and the population it
 * could serve is the intersection of "hardware UUID unavailable" (measured on
 * this rig as NOT taken — `ioreg` answered a 36-character UUID, positive control
 * on the same rig: a bogus binary throws, so the fallback branch is reachable
 * and simply was not reached) with "an administrator delivered `env.HOME`".
 *
 * **Only this direction is recoverable, and the asymmetry is worth stating.**
 * A store written under the hardware UUID and read on a launch where the
 * hardware read now fails cannot be opened by trying harder: the UUID is
 * exactly what we failed to obtain. The plan asked for "and vice versa"; that
 * half is not implementable, and pretending otherwise would put a key
 * derivation in the file that can never succeed.
 */
function deriveFallbackIdentityKeyV2(salt: Buffer): Buffer {
  const fallbackMachineId = createHash('sha256')
    .update(`${userInfo().username}:${latchedHomeDir()}`)
    .update('nessy-general-agent-v2')
    .digest();
  return pbkdf2Sync(fallbackMachineId, salt, PBKDF2_ITERATIONS, KEY_SIZE, 'sha256');
}

export interface SecureStorageBackendV2Options {
  /** Test seam: override the credential file path. Defaults to the managed file. */
  filePath?: string;
}

/**
 * Revisioned, fail-closed secure-storage backend required before W8.
 *
 * Contract:
 * - Corruption fails closed: a present-but-unreadable file throws
 *   `CredentialStoreCorruptError` and is never deleted or overwritten.
 * - Every write/rotation/delete atomically advances a non-secret store revision
 *   and a per-credential revision, uses temp → fsync → rename → directory
 *   durability, and preserves mode `0600`.
 * - Legacy-key credentials are forward-migrated to the stable key atomically
 *   (with a revision bump) on first successful read.
 * - `resolveRuntimeCredential` performs atomic expected-revision + ready-state
 *   resolution; secret bytes never enter revisions, DTOs, logs or errors.
 */
export class SecureStorageBackendV2 implements CredentialBackend {
  readonly name = 'secure-storage-v2';
  readonly priority = 110;

  private readonly filePath: string;
  private readonly dir: string;
  private cachedStore: CredentialStoreV2 | null = null;
  private salt: Buffer | null = null;

  constructor(options: SecureStorageBackendV2Options = {}) {
    this.filePath = options.filePath ?? join(CONFIG_DIR, 'credentials.enc');
    this.dir = dirname(this.filePath);
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async get(id: CredentialId): Promise<StoredCredential | null> {
    const store = this.loadStore();
    if (!store) return null;
    const record = store.credentials[credentialIdToAccount(id)];
    return record ? stripRevision(record) : null;
  }

  async set(id: CredentialId, credential: StoredCredential): Promise<void> {
    const store = this.loadStore() ?? this.emptyStore();
    const key = credentialIdToAccount(id);
    // Use the next STORE revision as the credential revision. This stays
    // monotonic across delete/re-add and prevents an old binding from matching
    // a different secret that happened to restart at per-record revision 1.
    store.credentials[key] = { ...credential, revision: store.revision + 1 };
    this.commit(store);
  }

  async delete(id: CredentialId): Promise<boolean> {
    return this.deleteSync(id);
  }

  deleteSync(id: CredentialId): boolean {
    const store = this.loadStore();
    if (!store) return false;
    const key = credentialIdToAccount(id);
    if (!(key in store.credentials)) return false;
    delete store.credentials[key];
    this.commit(store);
    return true;
  }

  async list(filter?: Partial<CredentialId>): Promise<CredentialId[]> {
    const store = this.loadStore();
    if (!store) return [];
    const ids = Object.keys(store.credentials)
      .map(accountToCredentialId)
      .filter((id): id is CredentialId => id !== null);
    if (!filter) return ids;
    return ids.filter((id) => {
      if (filter.type && id.type !== filter.type) return false;
      if (filter.workspaceId && id.workspaceId !== filter.workspaceId) return false;
      if (filter.name && id.name !== filter.name) return false;
      return true;
    });
  }

  /** Current store revision (0 when the store is absent). */
  getStoreRevision(): number {
    return this.loadStoreFresh()?.revision ?? 0;
  }

  /** Non-secret per-credential revision (0 when absent). */
  getRevision(id: CredentialId): number {
    const store = this.loadStoreFresh();
    return store?.credentials[credentialIdToAccount(id)]?.revision ?? 0;
  }

  /** Non-secret readiness snapshot used by capability generation/catalogs. */
  getRuntimeCredentialStatus(id: CredentialId): {
    state: 'ready' | 'missing' | 'expired';
    revision: number;
  } {
    const record = this.loadStoreFresh()?.credentials[credentialIdToAccount(id)];
    if (!record) return { state: 'missing', revision: 0 };
    if (record.expiresAt !== undefined && record.expiresAt <= Date.now()) {
      return { state: 'expired', revision: record.revision };
    }
    return { state: 'ready', revision: record.revision };
  }

  /** Create a binding a runtime can hold and later re-resolve. */
  bind(id: CredentialId): RuntimeCredentialBinding {
    return { id, expectedRevision: this.getRevision(id) };
  }

  /**
   * Atomic expected-revision + ready-state resolution. Returns the secret only
   * when the credential exists AND its current revision matches the binding.
   */
  resolveRuntimeCredential(binding: RuntimeCredentialBinding): ResolvedRuntimeCredential {
    const store = this.loadStoreFresh();
    const record = store?.credentials[credentialIdToAccount(binding.id)];
    if (!record) return { ready: false, revision: 0 };
    if (record.revision !== binding.expectedRevision) {
      return { ready: false, revision: record.revision };
    }
    if (record.expiresAt !== undefined && record.expiresAt <= Date.now()) {
      return { ready: false, revision: record.revision };
    }
    return { ready: true, revision: record.revision, value: record.value, credential: stripRevision(record) };
  }

  clearCache(): void {
    this.cachedStore = null;
    this.salt = null;
  }

  /** Runtime reads must observe writes made through the retained pre-W10 manager. */
  private loadStoreFresh(): CredentialStoreV2 | null {
    this.cachedStore = null;
    this.salt = null;
    return this.loadStore();
  }

  // ---- internals ----

  private emptyStore(): CredentialStoreV2 {
    const now = Date.now();
    return { version: 2, revision: 0, credentials: {}, metadata: { createdAt: now, updatedAt: now } };
  }

  private loadStore(): CredentialStoreV2 | null {
    if (this.cachedStore) return this.cachedStore;
    if (!existsSync(this.filePath)) return null;

    let fileData: Buffer;
    try {
      fileData = readFileSync(this.filePath);
    } catch (error) {
      throw new CredentialStoreCorruptError(`unreadable file (${errorReason(error)})`);
    }

    if (fileData.length < HEADER_SIZE + IV_SIZE + AUTH_TAG_SIZE) {
      throw new CredentialStoreCorruptError('file smaller than header');
    }
    if (!fileData.subarray(0, MAGIC_SIZE).equals(MAGIC_BYTES)) {
      throw new CredentialStoreCorruptError('bad magic bytes');
    }

    const salt = fileData.subarray(MAGIC_SIZE + FLAGS_SIZE, MAGIC_SIZE + FLAGS_SIZE + SALT_SIZE);
    this.salt = salt;
    const encrypted = fileData.subarray(HEADER_SIZE);

    const decoded = tryDecryptV2(encrypted, deriveStableKeyV2(salt));
    if (decoded) {
      const store = this.normalize(decoded);
      this.cachedStore = store;
      return store;
    }

    const legacy = tryDecryptV2(encrypted, deriveLegacyKeyV2(salt));
    if (legacy) {
      // Forward-migrate to the stable key atomically, bumping the revision.
      const store = this.normalize(legacy);
      store.revision += 1;
      store.metadata.updatedAt = Date.now();
      this.commit(store);
      return store;
    }

    // The same migration-on-read, for a store keyed to the fallback identity.
    // Third and last, so a normally-keyed store never pays for it.
    const fallbackIdentity = tryDecryptV2(encrypted, deriveFallbackIdentityKeyV2(salt));
    if (fallbackIdentity) {
      const store = this.normalize(fallbackIdentity);
      store.revision += 1;
      store.metadata.updatedAt = Date.now();
      this.commit(store);
      return store;
    }

    // Every key failed on a file that PASSED the magic-byte check, so it is a
    // credential store — just not one this machine identity can open. Saying
    // "corrupt" here misdiagnoses it and pushes the user to re-enter every key
    // when the data is intact; the honest failure names the cause. Structural
    // damage is reported separately above ("bad magic bytes", "file smaller
    // than header"), which is what keeps these two distinguishable.
    // The message names the WAY OUT, not just the cause. The fear this failure
    // produces is "my keys are gone"; they are not, and the fix is one action.
    // Entering a key again writes a fresh store under the current identity and
    // leaves this file untouched, so nothing is destroyed by recovering.
    throw new CredentialStoreCorruptError(
      'Your saved keys are still on disk, but they were encrypted on a different machine identity, '
      + 'so this installation cannot open them. This happens after moving to a new Mac, a hardware change, '
      + 'or a launch where the hardware id could not be read. '
      + 'Enter the key again to continue — that writes a fresh entry under this machine and leaves the old file untouched.',
      'foreign-identity',
    );
  }

  private normalize(parsed: unknown): CredentialStoreV2 {
    if (!isPlainObject(parsed)) throw new CredentialStoreCorruptError('decrypted payload is not an object');
    const rawCredentials = (parsed as { credentials?: unknown }).credentials;
    if (rawCredentials !== undefined && !isPlainObject(rawCredentials)) {
      throw new CredentialStoreCorruptError('credentials map is malformed');
    }
    const credentials: Record<string, RevisionedStoredCredential> = {};
    for (const [key, value] of Object.entries((rawCredentials as Record<string, unknown>) ?? {})) {
      if (!isPlainObject(value) || typeof (value as { value?: unknown }).value !== 'string') {
        throw new CredentialStoreCorruptError('credential record is malformed');
      }
      const rev = (value as { revision?: unknown }).revision;
      if (!isPositiveInteger(rev)) {
        throw new CredentialStoreCorruptError('credential revision is malformed');
      }
      credentials[key] = {
        ...(value as unknown as StoredCredential),
        revision: rev,
      };
    }
    const revisionRaw = (parsed as { revision?: unknown }).revision;
    if (!isNonNegativeInteger(revisionRaw)) {
      throw new CredentialStoreCorruptError('store revision is malformed');
    }
    const metadataRaw = (parsed as { metadata?: unknown }).metadata;
    const now = Date.now();
    const metadata = isPlainObject(metadataRaw)
      ? {
          createdAt: numberOr((metadataRaw as { createdAt?: unknown }).createdAt, now),
          updatedAt: numberOr((metadataRaw as { updatedAt?: unknown }).updatedAt, now),
        }
      : { createdAt: now, updatedAt: now };
    return {
      version: 2,
      revision: revisionRaw,
      credentials,
      metadata,
    };
  }

  private commit(store: CredentialStoreV2): void {
    store.revision += 1;
    store.metadata.updatedAt = Date.now();

    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    }

    const salt = this.salt ?? randomBytes(SALT_SIZE);
    this.salt = salt;
    const key = deriveStableKeyV2(salt);
    const plaintext = Buffer.from(JSON.stringify(store), 'utf8');
    const iv = randomBytes(IV_SIZE);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();

    const header = Buffer.alloc(HEADER_SIZE);
    MAGIC_BYTES.copy(header, 0);
    header.writeUInt32LE(0, MAGIC_SIZE);
    salt.copy(header, MAGIC_SIZE + FLAGS_SIZE);

    const fileData = Buffer.concat([header, iv, authTag, ciphertext]);
    this.atomicWriteBinary(fileData);
    this.cachedStore = store;
  }

  private atomicWriteBinary(data: Buffer): void {
    const tmpPath = join(this.dir, `.${basename(this.filePath)}.${process.pid}.${Date.now()}.tmp`);
    let fd: number | null = null;
    try {
      fd = openSync(tmpPath, 'wx', 0o600);
      writeFileSync(fd, data);
      fsyncSync(fd);
    } finally {
      if (fd !== null) closeSync(fd);
    }
    try {
      renameSync(tmpPath, this.filePath);
    } catch (error) {
      try { unlinkSync(tmpPath); } catch {}
      throw error;
    }
    syncDirectory(this.dir);
  }
}

/**
 * Build the revisioned v2 backend. Requires a proof that the v2 storage layout is
 * ready (the token is not otherwise consumed here — paths derive from CONFIG_DIR).
 */
export function createSecureStorageBackendV2(
  _layout: VerifiedStorageLayoutV2,
  options: SecureStorageBackendV2Options = {},
): SecureStorageBackendV2 {
  return new SecureStorageBackendV2(options);
}

function tryDecryptV2(encryptedData: Buffer, key: Buffer): unknown | null {
  try {
    const iv = encryptedData.subarray(0, IV_SIZE);
    const authTag = encryptedData.subarray(IV_SIZE, IV_SIZE + AUTH_TAG_SIZE);
    const ciphertext = encryptedData.subarray(IV_SIZE + AUTH_TAG_SIZE);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(decrypted.toString('utf8'));
  } catch {
    return null;
  }
}

function stripRevision(record: RevisionedStoredCredential): StoredCredential {
  const { revision: _revision, ...rest } = record;
  return rest;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return isNonNegativeInteger(value) && value > 0;
}

function errorReason(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) return String((error as { code?: unknown }).code);
  return error instanceof Error ? error.name : 'unknown';
}
