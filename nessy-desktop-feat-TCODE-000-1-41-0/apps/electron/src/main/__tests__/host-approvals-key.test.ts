/**
 * UA12.1 — the desktop host seals the host-approvals ledger key with the OS
 * secret store (Electron `safeStorage`) and installs it through the ledger's one
 * port; `host-approvals-key.ts` header.
 *
 * The fake `safeStorage` is AES-256-GCM under a key that lives only in this
 * process (a Keychain stand-in). Arms:
 * - POSITIVE: OS store usable → the sealed blob is written, a restart returns
 *   the same key, the host verifies its own entry, and the credential-store
 *   fallback is never asked;
 * - NEGATIVE: no OS store and no blob → the credential-store fallback, with a
 *   warning naming the residue; no OS store but a blob → fails CLOSED;
 * - BOUNDARY: Linux on `basic_text` falls back, Linux on libsecret seals;
 *   `safeStorage` is not touched before `ready`;
 * - WIRING: the main process installs the provider at load (source pin).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  HOST_APPROVALS_SEALED_KEY_FILE,
  HostApprovalsKeyError,
  findHostApproval,
  recordHostApproval,
  type HostApprovalsKeyProvider,
} from '@nessy-agent/shared/approvals/host-approvals'
import {
  createElectronHostApprovalsKeyProvider,
  osSecretStoreUsable,
  type ElectronHostApprovalsKeyDeps,
  type SafeStorageLike,
} from '../host-approvals-key'

function fakeSafeStorage(osSecret: Buffer, options: { available?: boolean; backend?: string } = {}): SafeStorageLike & { calls: number } {
  const storage = {
    calls: 0,
    isEncryptionAvailable() { storage.calls += 1; return options.available ?? true },
    encryptString(plain: string): Buffer {
      storage.calls += 1
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', osSecret, iv)
      const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), body])
    },
    decryptString(blob: Buffer): string {
      storage.calls += 1
      const decipher = createDecipheriv('aes-256-gcm', osSecret, blob.subarray(0, 12))
      decipher.setAuthTag(blob.subarray(12, 28))
      return Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]).toString('utf8')
    },
    getSelectedStorageBackend() { return options.backend ?? 'gnome_libsecret' },
  }
  return storage
}

let configDir: string
let workspaceRoot: string
let fallbackCalls: number
let logs: string[]
const FALLBACK_KEY = Buffer.alloc(32, 0x5f)
const fallback: HostApprovalsKeyProvider = { getKey: async () => { fallbackCalls += 1; return FALLBACK_KEY } }

beforeEach(() => {
  configDir = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-ua121-electron-')))
  workspaceRoot = join(configDir, 'workspaces', 'ws-a')
  fallbackCalls = 0
  logs = []
})

afterEach(() => { rmSync(configDir, { recursive: true, force: true }) })

function deps(storage: SafeStorageLike, platform: NodeJS.Platform = 'darwin', whenReady: () => Promise<unknown> = async () => {}): ElectronHostApprovalsKeyDeps {
  return {
    safeStorage: storage,
    whenReady,
    configDir,
    platform,
    fallback,
    log: { info: message => { logs.push(`info ${message}`) }, warn: message => { logs.push(`warn ${message}`) } },
  }
}

describe('UA12.1 · the desktop ledger key is sealed by the OS secret store', () => {
  it('POSITIVE: sealed blob written, same key after a restart, the host verifies its own entry, no fallback', async () => {
    const osSecret = randomBytes(32)
    const key = await createElectronHostApprovalsKeyProvider(deps(fakeSafeStorage(osSecret))).getKey()
    recordHostApproval(workspaceRoot, key, { kind: 'script-approval', subject: 'page:demo', digest: 'sha256:def' })
    const blob = readFileSync(join(configDir, HOST_APPROVALS_SEALED_KEY_FILE), 'utf8')
    const restarted = await createElectronHostApprovalsKeyProvider(deps(fakeSafeStorage(osSecret))).getKey()
    expect({
      restartSame: restarted.equals(key),
      verifies: findHostApproval(workspaceRoot, restarted, 'script-approval', 'page:demo')?.digest,
      blobHoldsKey: blob.includes(key.toString('hex')) || Buffer.from(blob.trim(), 'base64').includes(key),
      fallbackCalls,
      logs,
    }).toEqual({
      restartSame: true,
      verifies: 'sha256:def',
      blobHoldsKey: false,
      fallbackCalls: 0,
      logs: ['info [host-approvals] ledger key: sealed by the OS secret store (UA12.1)', 'info [host-approvals] ledger key: sealed by the OS secret store (UA12.1)'],
    })
  })

  it('NEGATIVE: no OS secret store and no sealed key → the credential-store fallback, with the residue named', async () => {
    const key = await createElectronHostApprovalsKeyProvider(deps(fakeSafeStorage(randomBytes(32), { available: false }))).getKey()
    expect({ fallback: key.equals(FALLBACK_KEY), fallbackCalls, blob: existsSync(join(configDir, HOST_APPROVALS_SEALED_KEY_FILE)), logs })
      .toEqual({ fallback: true, fallbackCalls: 1, blob: false, logs: ['warn [host-approvals] no OS secret store: the ledger key falls back to the credential store, which any same-user process can decrypt (UA12.1 residue)'] })
  })

  it('NEGATIVE: no OS secret store but a sealed key exists → fails closed, no fallback', async () => {
    writeFileSync(join(configDir, HOST_APPROVALS_SEALED_KEY_FILE), 'c2VhbGVk\n')
    await expect(createElectronHostApprovalsKeyProvider(deps(fakeSafeStorage(randomBytes(32), { available: false }))).getKey())
      .rejects.toBeInstanceOf(HostApprovalsKeyError)
    expect(fallbackCalls).toBe(0)
  })

  it('NEGATIVE: a sealed key the OS secret store cannot open (a reset Keychain item) fails closed and is kept', async () => {
    await createElectronHostApprovalsKeyProvider(deps(fakeSafeStorage(randomBytes(32)))).getKey()
    const blob = readFileSync(join(configDir, HOST_APPROVALS_SEALED_KEY_FILE), 'utf8')
    await expect(createElectronHostApprovalsKeyProvider(deps(fakeSafeStorage(randomBytes(32)))).getKey())
      .rejects.toBeInstanceOf(HostApprovalsKeyError)
    expect({ kept: readFileSync(join(configDir, HOST_APPROVALS_SEALED_KEY_FILE), 'utf8') === blob, fallbackCalls }).toEqual({ kept: true, fallbackCalls: 0 })
  })
})

describe('UA12.1 · which backends count as an OS secret store', () => {
  it('BOUNDARY: Linux on basic_text (or none) is not one; libsecret and kwallet are; macOS and Windows follow availability', () => {
    const secret = randomBytes(32)
    expect([
      osSecretStoreUsable(fakeSafeStorage(secret, { backend: 'basic_text' }), 'linux'),
      osSecretStoreUsable(fakeSafeStorage(secret, { backend: 'unknown' }), 'linux'),
      osSecretStoreUsable(fakeSafeStorage(secret, { backend: 'gnome_libsecret' }), 'linux'),
      osSecretStoreUsable(fakeSafeStorage(secret, { backend: 'kwallet5' }), 'linux'),
      osSecretStoreUsable(fakeSafeStorage(secret), 'darwin'),
      osSecretStoreUsable(fakeSafeStorage(secret), 'win32'),
      osSecretStoreUsable(fakeSafeStorage(secret, { available: false }), 'darwin'),
    ]).toEqual([false, false, true, true, true, true, false])
  })

  it('BOUNDARY: Linux on basic_text takes the fallback end to end', async () => {
    const key = await createElectronHostApprovalsKeyProvider(deps(fakeSafeStorage(randomBytes(32), { backend: 'basic_text' }), 'linux')).getKey()
    expect({ fallback: key.equals(FALLBACK_KEY), blob: existsSync(join(configDir, HOST_APPROVALS_SEALED_KEY_FILE)) }).toEqual({ fallback: true, blob: false })
  })

  it('BOUNDARY: safeStorage is not touched before the app is ready', async () => {
    let release!: () => void
    const ready = new Promise<void>(resolve => { release = resolve })
    const storage = fakeSafeStorage(randomBytes(32))
    const pending = createElectronHostApprovalsKeyProvider(deps(storage, 'darwin', () => ready)).getKey()
    await new Promise(resolve => setTimeout(resolve, 10))
    const before = storage.calls
    release()
    const key = await pending
    expect({ before, after: storage.calls > 0, length: key.length }).toEqual({ before: 0, after: true, length: 32 })
  })
})

describe('UA12.1 · the main process installs the provider', () => {
  it('WIRING: index.ts imports and calls installElectronHostApprovalsKeyProvider at top level', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'index.ts'), 'utf8')
    expect({
      imported: source.includes("import { installElectronHostApprovalsKeyProvider } from './host-approvals-key'"),
      calledAtTopLevel: /^installElectronHostApprovalsKeyProvider\(\)$/m.test(source),
    }).toEqual({ imported: true, calledAtTopLevel: true })
  })
})
