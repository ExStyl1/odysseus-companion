/**
 * UA12.1 — where the host-approvals ledger key lives (spec §16, S17/S24).
 *
 * UA1.10 kept the key in `credentials.enc`, and any same-user process can
 * decrypt that file (`credentials/backends/secure-storage.ts` derives its key
 * from the machine identity and the salt in the file's own header). UA1.10's
 * readings showed a shell below `bypassPermissions` can read it (codex in every
 * mode, Pi/Claude `auto` through cd-relative and interpreter spellings). So the
 * desktop host now seals its key with an OS-held secret (Electron
 * `safeStorage`: Keychain on macOS), injected through ONE port
 * ({@link setHostApprovalsKeyProvider}); the headless server keeps the
 * credential-store key — the stated residue.
 *
 * The instrument ({@link agentRecoverableKey}) is what an agent's shell can do
 * with the files it can reach: read every byte under the config dir (the
 * workspace ledger, `credentials.enc`, the sealed blob) and decrypt the
 * credential store the way any same-user process can (a FRESH
 * `SecureStorageBackendV2` over the same file). It reports the key it found, if
 * any candidate MACs the host's own entry. The OS secret of the fake sealer
 * lives only in this process's memory, like a Keychain item.
 *
 * Invariants:
 * 1. Desktop: no file an agent can read yields the key (NEGATIVE). The headless
 *    arm, which DOES yield it, is the instrument's positive control on the same
 *    scope.
 * 2. Restart: a fresh provider over the same sealed file and the same OS secret
 *    returns the same key, and the host verifies its own entries (POSITIVE).
 * 3. A sealed blob that does not unseal fails CLOSED, never re-minted over.
 * 4. Migration: a ledger signed with the old credential-store key is
 *    INVALIDATED, not re-signed (that key was readable, so re-signing would
 *    launder an agent-minted entry).
 * 5. The port: the host's installed provider is the one the readers get; with
 *    none installed (headless) it is the credential-store provider.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  HOST_APPROVALS_SEALED_KEY_FILE,
  HostApprovalsKeyError,
  credentialStoreHostApprovalsKeyProvider,
  findHostApproval,
  getHostApprovalsKeyProvider,
  headlessHostApprovalsKeyProvider,
  hostApprovalMac,
  readHostApprovals,
  recordHostApproval,
  sealedFileHostApprovalsKeyProvider,
  setHostApprovalsKeyProvider,
  type HostApprovalEntry,
  type HostApprovalsKeyProvider,
  type HostApprovalsKeySealer,
} from '../host-approvals.ts'
import { CredentialManager } from '../../credentials/manager.ts'
import { SecureStorageBackendV2 } from '../../credentials/backends/secure-storage.ts'

/** A fake OS secret store: AES-256-GCM under a key that exists only in this process (a Keychain item stand-in). */
function fakeOsSealer(osSecret: Buffer): HostApprovalsKeySealer {
  return {
    seal(plain: string): Buffer {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', osSecret, iv)
      const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), body])
    },
    unseal(sealed: Buffer): string {
      const decipher = createDecipheriv('aes-256-gcm', osSecret, sealed.subarray(0, 12))
      decipher.setAuthTag(sealed.subarray(12, 28))
      return Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]).toString('utf8')
    },
  }
}

function filesUnder(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...filesUnder(path))
    else out.push(path)
  }
  return out
}

/**
 * What a same-user agent shell can recover from `configDir`: every 64-hex run in
 * every readable file, every raw 32-byte window that equals a candidate, and every
 * value the credential store decrypts to. Returns the candidate that MACs the
 * host's own `entry` (so it could mint one), or null.
 */
async function agentRecoverableKey(configDir: string, workspaceRoot: string, entry: HostApprovalEntry): Promise<{ key: string | null; filesRead: number; storeValues: number }> {
  const candidates = new Set<string>()
  const files = filesUnder(configDir)
  for (const file of files) {
    const raw = readFileSync(file)
    // The bytes as stored, and the same bytes base64-decoded (the blob's own encoding).
    for (const bytes of [raw, Buffer.from(raw.toString('utf8').trim(), 'base64')]) {
      for (const text of [bytes.toString('utf8'), bytes.toString('latin1')]) {
        for (const match of text.match(/[0-9a-f]{64}/g) ?? []) candidates.add(match)
      }
      for (let at = 0; at + 32 <= bytes.length; at += 1) candidates.add(bytes.subarray(at, at + 32).toString('hex'))
    }
  }
  // The same-user decryption of the credential store (no secret beyond the user's own).
  const store = new SecureStorageBackendV2({ filePath: join(configDir, 'credentials.enc') })
  const ids = await store.list()
  for (const id of ids) {
    const value = (await store.get(id))?.value
    if (value) candidates.add(value)
  }
  for (const candidate of candidates) {
    if (!/^[0-9a-f]{64}$/.test(candidate)) continue
    if (hostApprovalMac(Buffer.from(candidate, 'hex'), workspaceRoot, entry) === entry.mac) return { key: candidate, filesRead: files.length, storeValues: ids.length }
  }
  return { key: null, filesRead: files.length, storeValues: ids.length }
}

let sandbox: string
let configDir: string
let workspaceRoot: string
let credentialsPath: string

beforeEach(async () => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-ua121-')))
  configDir = join(sandbox, 'nessy-config')
  workspaceRoot = join(configDir, 'workspaces', 'ws-a')
  mkdirSync(workspaceRoot, { recursive: true })
  credentialsPath = join(configDir, 'credentials.enc')
  // An ordinary credential, so credentials.enc exists on both arms (an obviously fake value).
  await new SecureStorageBackendV2({ filePath: credentialsPath }).set({ type: 'llm_api_key', name: 'probe' }, { value: ['fake', 'ua121', 'value'].join('-') })
})

afterEach(() => {
  setHostApprovalsKeyProvider(undefined)
  rmSync(sandbox, { recursive: true, force: true })
})

const record = (key: Buffer) => recordHostApproval(workspaceRoot, key, { kind: 'page-grant', subject: 'page:demo', digest: 'sha256:abc' })

describe('UA12.1 · an agent shell cannot recover the desktop ledger key', () => {
  it('CONTROL (headless residue): with the credential-store key, the same-user read DOES yield it', async () => {
    const provider = credentialStoreHostApprovalsKeyProvider(new CredentialManager(new SecureStorageBackendV2({ filePath: credentialsPath })))
    const key = await provider.getKey()
    const entry = record(key)
    const found = await agentRecoverableKey(configDir, workspaceRoot, entry)
    expect({ found: found.key === key.toString('hex'), storeValues: found.storeValues }).toEqual({ found: true, storeValues: 2 })
  })

  it('CONTROL (instrument): a "sealer" that only encodes (no OS secret) IS recovered from the blob', async () => {
    const encodeOnly: HostApprovalsKeySealer = { seal: plain => Buffer.from(plain, 'utf8'), unseal: sealed => sealed.toString('utf8') }
    const key = await sealedFileHostApprovalsKeyProvider(join(configDir, HOST_APPROVALS_SEALED_KEY_FILE), encodeOnly).getKey()
    const found = await agentRecoverableKey(configDir, workspaceRoot, record(key))
    expect(found.key).toBe(key.toString('hex'))
  })

  it('NEGATIVE (desktop): with the OS-sealed key, no readable file and no decrypted store value yields it', async () => {
    const provider = sealedFileHostApprovalsKeyProvider(join(configDir, HOST_APPROVALS_SEALED_KEY_FILE), fakeOsSealer(randomBytes(32)))
    const key = await provider.getKey()
    const entry = record(key)
    const found = await agentRecoverableKey(configDir, workspaceRoot, entry)
    // credentials.enc, the ledger and the sealed blob were all read; the store holds only the ordinary credential.
    expect({ found: found.key, filesRead: found.filesRead, storeValues: found.storeValues }).toEqual({ found: null, filesRead: 3, storeValues: 1 })
    expect(readFileSync(join(configDir, HOST_APPROVALS_SEALED_KEY_FILE), 'utf8')).not.toContain(key.toString('hex'))
    expect(statSync(join(configDir, HOST_APPROVALS_SEALED_KEY_FILE)).mode & 0o777).toBe(0o600)
  })
})

describe('UA12.1 · the sealed key across a restart', () => {
  it('POSITIVE: a fresh provider over the same blob and OS secret returns the same key, and the host verifies its own entry', async () => {
    const osSecret = randomBytes(32)
    const blob = join(configDir, HOST_APPROVALS_SEALED_KEY_FILE)
    const first = sealedFileHostApprovalsKeyProvider(blob, fakeOsSealer(osSecret))
    const [a, b] = await Promise.all([first.getKey(), first.getKey()])
    record(a)
    const blobBefore = readFileSync(blob, 'utf8')
    const restarted = await sealedFileHostApprovalsKeyProvider(blob, fakeOsSealer(osSecret)).getKey()
    expect({
      length: a.length,
      concurrentSame: a.equals(b),
      restartSame: restarted.equals(a),
      blobKept: readFileSync(blob, 'utf8') === blobBefore,
      verifies: findHostApproval(workspaceRoot, restarted, 'page-grant', 'page:demo')?.digest,
    }).toEqual({ length: 32, concurrentSame: true, restartSame: true, blobKept: true, verifies: 'sha256:abc' })
  })

  it('NEGATIVE: a blob that does not unseal (tampered, or another OS secret) fails closed and is NOT re-minted', async () => {
    const blob = join(configDir, HOST_APPROVALS_SEALED_KEY_FILE)
    await sealedFileHostApprovalsKeyProvider(blob, fakeOsSealer(randomBytes(32))).getKey()
    const sealed = readFileSync(blob, 'utf8')
    await expect(sealedFileHostApprovalsKeyProvider(blob, fakeOsSealer(randomBytes(32))).getKey()).rejects.toBeInstanceOf(HostApprovalsKeyError)
    writeFileSync(blob, 'not-a-sealed-key\n')
    await expect(sealedFileHostApprovalsKeyProvider(blob, fakeOsSealer(randomBytes(32))).getKey()).rejects.toBeInstanceOf(HostApprovalsKeyError)
    expect(readFileSync(blob, 'utf8')).toBe('not-a-sealed-key\n')
    expect(sealed.length).toBeGreaterThan(0)
  })

  it('NEGATIVE: an OS secret that unseals to something other than a key fails closed', async () => {
    const osSecret = randomBytes(32)
    const sealer = fakeOsSealer(osSecret)
    const blob = join(configDir, HOST_APPROVALS_SEALED_KEY_FILE)
    writeFileSync(blob, `${sealer.seal('not-a-key').toString('base64')}\n`)
    await expect(sealedFileHostApprovalsKeyProvider(blob, sealer).getKey()).rejects.toBeInstanceOf(HostApprovalsKeyError)
  })
})

describe('UA12.1 · migration from the credential-store key', () => {
  it('a ledger signed with the old credential-store key is invalidated on the desktop, not re-signed', async () => {
    const oldKey = await credentialStoreHostApprovalsKeyProvider(new CredentialManager(new SecureStorageBackendV2({ filePath: credentialsPath }))).getKey()
    record(oldKey)
    const desktopKey = await sealedFileHostApprovalsKeyProvider(join(configDir, HOST_APPROVALS_SEALED_KEY_FILE), fakeOsSealer(randomBytes(32))).getKey()
    expect(readHostApprovals(workspaceRoot, desktopKey)).toEqual({ entries: [], rejected: 1 })
    expect(desktopKey.equals(oldKey)).toBe(false)
    // The next host write carries only verified entries, so the old line is dropped, never re-signed.
    record(desktopKey)
    const after = JSON.parse(readFileSync(join(workspaceRoot, 'host-approvals.json'), 'utf8')) as { entries: HostApprovalEntry[] }
    expect(after.entries.map(entry => entry.mac === hostApprovalMac(desktopKey, workspaceRoot, entry))).toEqual([true])
  })
})

describe('UA12.1 · the key-provider port', () => {
  it('POSITIVE: the host-installed provider is the one readers get', async () => {
    const installed: HostApprovalsKeyProvider = { getKey: async () => Buffer.alloc(32, 7) }
    setHostApprovalsKeyProvider(installed)
    expect(getHostApprovalsKeyProvider()).toBe(installed)
    expect((await getHostApprovalsKeyProvider().getKey()).equals(Buffer.alloc(32, 7))).toBe(true)
  })

  it('BOUNDARY (headless): with nothing installed, readers get the credential-store provider', () => {
    setHostApprovalsKeyProvider({ getKey: async () => Buffer.alloc(32, 1) })
    setHostApprovalsKeyProvider(undefined)
    expect(getHostApprovalsKeyProvider()).toBe(headlessHostApprovalsKeyProvider)
  })
})
