/**
 * UA12.1 — the desktop host's key for the host-approvals ledger
 * (`@nessy-agent/shared/approvals/host-approvals`, spec §16, S17/S24).
 *
 * UA1.10 kept the key in `credentials.enc`, which any same-user process can
 * decrypt, and its readings showed an agent shell below `bypassPermissions` can
 * read that file. Native-first: the platform's own mechanism for an app secret is
 * Electron `safeStorage` (the Keychain on macOS, DPAPI on Windows, the Secret
 * Service / KWallet on Linux). So the desktop seals the key with it and keeps only
 * the sealed blob, `host-approvals-key.sealed`, in the config dir beside the
 * app's other records. Shared code never imports Electron: this module installs
 * the provider through the ledger's one port (`setHostApprovalsKeyProvider`).
 *
 * Per platform (stated):
 * - macOS: the blob is ciphertext to an agent's shell; the Keychain item that
 *   unseals it is the app's, and another program reading it raises a Keychain
 *   prompt to the user.
 * - Windows (DPAPI) and Linux (Secret Service / KWallet): any same-user process
 *   can ask for that secret without a prompt, so there the move does not close a
 *   same-user shell — the residue is the same as the credential store's.
 * - No OS secret store (`isEncryptionAvailable()` false, or Linux on Chromium's
 *   hard-coded `basic_text` password): the credential-store key is used and a
 *   warning names the residue — unless a sealed blob already exists, which then
 *   fails CLOSED (switching keys silently would drop every approval unseen).
 *
 * Migration: a credential-store key an earlier build minted is ignored; ledger
 * entries it signed no longer verify (invalidated, never re-signed: that key was
 * readable). No shipped build wrote a ledger.
 */
import { app, safeStorage } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'

import { CONFIG_DIR } from '@nessy-agent/shared/config/paths'
import {
  HOST_APPROVALS_SEALED_KEY_FILE,
  HostApprovalsKeyError,
  headlessHostApprovalsKeyProvider,
  sealedFileHostApprovalsKeyProvider,
  setHostApprovalsKeyProvider,
  type HostApprovalsKeyProvider,
} from '@nessy-agent/shared/approvals/host-approvals'

import { mainLog } from './logger'

/** The slice of Electron `safeStorage` this module uses. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
  /** Linux only in Electron. */
  getSelectedStorageBackend?(): string
}

export interface ElectronHostApprovalsKeyDeps {
  safeStorage: SafeStorageLike
  /** `safeStorage` is usable only after `ready` on Linux and Windows. */
  whenReady: () => Promise<unknown>
  configDir: string
  platform: NodeJS.Platform
  /** Used only when no OS secret store is usable AND no sealed key exists yet. */
  fallback: HostApprovalsKeyProvider
  log: { info(message: string): void; warn(message: string): void }
}

/** Linux backends that are not an OS secret store (Chromium's hard-coded password, or none chosen). */
const LINUX_NON_SECRET_BACKENDS = new Set(['basic_text', 'unknown'])

/** True when `safeStorage` is backed by an OS secret store on this platform. */
export function osSecretStoreUsable(storage: SafeStorageLike, platform: NodeJS.Platform): boolean {
  if (!storage.isEncryptionAvailable()) return false
  if (platform !== 'linux') return true
  return !LINUX_NON_SECRET_BACKENDS.has(storage.getSelectedStorageBackend?.() ?? 'unknown')
}

/** The desktop provider: OS-sealed when the OS secret store is usable (module header). */
export function createElectronHostApprovalsKeyProvider(deps: ElectronHostApprovalsKeyDeps): HostApprovalsKeyProvider {
  const blobPath = join(deps.configDir, HOST_APPROVALS_SEALED_KEY_FILE)
  const sealed = sealedFileHostApprovalsKeyProvider(blobPath, {
    seal: plain => deps.safeStorage.encryptString(plain),
    unseal: blob => deps.safeStorage.decryptString(blob),
  })
  const choose = async (): Promise<HostApprovalsKeyProvider> => {
    await deps.whenReady()
    if (osSecretStoreUsable(deps.safeStorage, deps.platform)) {
      deps.log.info('[host-approvals] ledger key: sealed by the OS secret store (UA12.1)')
      return sealed
    }
    if (existsSync(blobPath)) {
      throw new HostApprovalsKeyError(`the OS secret store is unavailable and the ledger key is sealed by it (${blobPath}): no host approval is trusted`)
    }
    deps.log.warn('[host-approvals] no OS secret store: the ledger key falls back to the credential store, which any same-user process can decrypt (UA12.1 residue)')
    return deps.fallback
  }
  let chosen: Promise<HostApprovalsKeyProvider> | undefined
  return {
    async getKey() {
      if (!chosen) {
        chosen = choose()
        chosen.catch(() => { chosen = undefined })
      }
      return (await chosen).getKey()
    },
  }
}

/** Called once by the main process at load; nothing is read or minted until a reader asks for the key. */
export function installElectronHostApprovalsKeyProvider(): void {
  setHostApprovalsKeyProvider(createElectronHostApprovalsKeyProvider({
    safeStorage,
    whenReady: () => app.whenReady(),
    configDir: CONFIG_DIR,
    platform: process.platform,
    fallback: headlessHostApprovalsKeyProvider,
    log: { info: message => mainLog.info(message), warn: message => mainLog.warn(message) },
  }))
}
