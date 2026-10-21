/**
 * UA1.10 — the host-approvals ledger: `{workspaceRoot}/host-approvals.json`
 * (spec §16 "Host-record integrity", threats S17 and S24).
 *
 * The design depends on agents not forging host records, and the agent can often
 * write the workspace folder (the sandbox is off by default; codex writes never
 * pass the host gate). So every approval the host later ACTS on — a page grant, a
 * script digest, a refresh approval, a human-confirmed `task.yaml` digest, a
 * project-context digest — lives here, and every entry carries
 * `mac = HMAC-SHA256(key, canonical(entry))` under a per-install key. Readers
 * accept ONLY entries whose MAC verifies; everything else is counted as rejected
 * and ignored.
 *
 * ## Where the key lives (UA12.1, one port: {@link HostApprovalsKeyProvider})
 *
 * The host installs the provider ({@link setHostApprovalsKeyProvider}); readers
 * take it from {@link getHostApprovalsKeyProvider}. This module never imports
 * Electron.
 * - **Desktop:** the key is sealed with an OS-held secret (Electron
 *   `safeStorage`: the Keychain on macOS) in {@link HOST_APPROVALS_SEALED_KEY_FILE}
 *   under the config dir ({@link sealedFileHostApprovalsKeyProvider}, wired by
 *   `apps/electron/src/main/host-approvals-key.ts`). The blob is ciphertext to an
 *   agent's shell; unsealing it needs the OS secret store, which on macOS asks
 *   the user before another program reads the app's item.
 * - **Headless server (stated residue):** no OS secret store, so it keeps the
 *   UA1.10 key in the credential store (`host_approvals_key::global`,
 *   {@link headlessHostApprovalsKeyProvider}), which any same-user process can
 *   decrypt (`credentials/backends/secure-storage.ts`).
 * - **Migration:** the desktop ignores a credential-store key an earlier build
 *   minted; entries it signed are rejected (invalidated), never re-signed — that
 *   key was readable, so re-signing would launder an entry an agent minted with it.
 *
 * ## The canonical form (pinned by `__tests__/host-approvals.test.ts`)
 *
 * {@link canonicalJson}: objects with their keys sorted by UTF-16 code unit (the
 * default `Array.prototype.sort`), members whose value is `undefined` dropped,
 * arrays in order, strings and finite numbers as `JSON.stringify` writes them,
 * no whitespace; `NaN`, `Infinity`, `bigint`, functions, symbols and an
 * `undefined` array item throw. The MAC message is the canonical form of
 * `{ v: 1, ledger: 'nessy-host-approvals', workspace, entry }`, where `entry` is
 * the entry WITHOUT its `mac` and `workspace` is the real path of the workspace
 * root — so a ledger copied from another workspace does not verify here.
 *
 * ## What it protects, and what it does not (stated, spec §16 "Residue")
 *
 * - It protects against an agent that can WRITE files but cannot read the key:
 *   Write/Edit-only modes, bridged writes, codex commands in a writable root.
 *   The guard patterns in `agent/core/pre-tool-use.ts`
 *   (`GUARDED_WORKSPACE_RECORDS` + `GUARDED_WORKSPACE_RECORD_PATTERNS`) refuse
 *   the direct write on Pi and Claude first; this MAC is what still holds where
 *   that gate does not run.
 * - Who can recover the key: on the headless server, anything that can read
 *   `credentials.enc` (the store is encrypted with a key derived from the machine
 *   identity, `credentials/backends/secure-storage.ts`; UA1.10's reach readings
 *   say which modes that is). On the desktop, nothing that reads files: the sealed
 *   blob needs the OS secret — on Windows (DPAPI) and Linux (the Secret Service)
 *   that secret is open to any same-user process, so there the move does not
 *   close a same-user shell (stated, UA12.1). An agent that can run code as the
 *   app itself (its binary launched with injected options) is the spec's "runs
 *   shell unprompted" residue. The key is never logged and never returned to a
 *   renderer — nothing here exports it beyond the provider, a host-side call.
 * - Rollback (UA12.4, DECIDED 2026-10-09: accepted, stated, no counter): an agent
 *   that saved an older ledger and can write the file again restores an entry the
 *   user since revoked — each MAC covers its entry and the workspace, not the
 *   ledger's age (read in `host-approvals.test.ts`, "STATED RESIDUE (UA12.4)").
 *   On Pi and Claude the guard refuses the direct write of this workspace's ledger
 *   (the exact record) and of another workspace's (`OTHER_WORKSPACE_RECORDS`) in
 *   every mode, for the spellings its suites measure (`host-approvals.test.ts`,
 *   `other-workspace-record-guard.test.ts`); on codex the exact name is a
 *   read-only subpath / `deny` key of its permission profile, which binds only
 *   while codex's sandbox is on. WHY no monotonic counter: the stores it could
 *   live in are files of the same data folder (`credentials.enc`, or a sealed
 *   file beside {@link HOST_APPROVALS_SEALED_KEY_FILE}), and an agent that can put
 *   an old ledger back past those guards (an interpreter with an assembled path,
 *   codex with its sandbox off) can put an old copy of that store back the same
 *   way — so a counter there closes no rollback this agent can perform, while it
 *   would make every ledger read and write wait on the async credential store. A
 *   counter that holds needs a store no agent can roll back (an OS keychain item,
 *   not a file). It does not hold against an agent that can also read the key
 *   (see above): that one can mint a fresh entry instead.
 * - One writer per workspace is assumed (the host process); two host processes
 *   writing the same ledger at once can lose one write (last rename wins).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { getCredentialManager } from '../credentials/manager.ts'
import type { CredentialId, StoredCredential } from '../credentials/types.ts'
import { atomicWriteDurableFileSync } from '../utils/durable-fs.ts'

/** The ledger's file name, directly in the workspace root. Guarded by name in `pre-tool-use.ts`. */
export const HOST_APPROVALS_FILE = 'host-approvals.json'

/**
 * Every kind this plan writes, named now so later rows do not reshape the ledger:
 * page grants (UA9.2), script-digest approvals (UA8.1), refresh approvals
 * (UA8.2), the last human-confirmed `task.yaml` digest (UA4.4), and
 * project-context digests (UA5.5).
 */
export const HOST_APPROVAL_KINDS = [
  'page-grant',
  'script-approval',
  'refresh-approval',
  'task-confirmation',
  'project-context',
] as const

export type HostApprovalKind = typeof HOST_APPROVAL_KINDS[number]

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/** The fields the MAC covers. `subject` names what is approved (e.g. `page:<slug>`), `digest` the bytes approved. */
export interface HostApprovalFields {
  kind: HostApprovalKind
  subject: string
  digest: string
  /** ISO-8601, set by the host when it records the entry. */
  createdAt: string
  /** ISO-8601; an entry at or past it is ignored by {@link findHostApproval}. */
  expiresAt?: string
  /** Kind-specific detail (a grant's action, a source slug); covered by the MAC like every other field. */
  data?: { [key: string]: JsonValue }
}

export interface HostApprovalEntry extends HostApprovalFields {
  /** Lower-case hex HMAC-SHA256 of the canonical form (module header). */
  mac: string
}

export interface HostApprovalsRead {
  /** Entries whose MAC verified, in file order. */
  entries: HostApprovalEntry[]
  /** Entries (or a whole unparsable file, counted as one) that did not verify and were ignored. */
  rejected: number
}

/** A stored key that is not 32 bytes of hex: fail CLOSED rather than re-mint over it. */
export class HostApprovalsKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HostApprovalsKeyError'
  }
}

const LEDGER_VERSION = 1
const MAC_PATTERN = /^[0-9a-f]{64}$/
const KEY_PATTERN = /^[0-9a-f]{64}$/
const ENTRY_KEYS = new Set(['kind', 'subject', 'digest', 'createdAt', 'expiresAt', 'data', 'mac'])
const MAX_FIELD_LENGTH = 4096

/** The canonical JSON the MAC covers (module header). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonicalJson: a number must be finite')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => {
      if (item === undefined) throw new TypeError('canonicalJson: an array item may not be undefined')
      return canonicalJson(item)
    }).join(',')}]`
  }
  if (typeof value === 'object' && value !== undefined) {
    const record = value as Record<string, unknown>
    const members = Object.keys(record).sort()
      .filter(key => record[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    return `{${members.join(',')}}`
  }
  throw new TypeError(`canonicalJson: ${typeof value} cannot be canonicalised`)
}

/** The workspace identity the MAC binds: the real path when the folder exists, else the resolved one. */
function workspaceIdentity(workspaceRootPath: string): string {
  const resolved = resolve(workspaceRootPath)
  try {
    return realpathSync(resolved)
  } catch {
    return resolved
  }
}

/** The MAC the host writes for `fields` in `workspaceRootPath` (lower-case hex). */
export function hostApprovalMac(key: Buffer, workspaceRootPath: string, fields: HostApprovalFields): string {
  const entry: HostApprovalFields = {
    kind: fields.kind,
    subject: fields.subject,
    digest: fields.digest,
    createdAt: fields.createdAt,
    expiresAt: fields.expiresAt,
    data: fields.data,
  }
  const message = canonicalJson({ v: LEDGER_VERSION, ledger: 'nessy-host-approvals', workspace: workspaceIdentity(workspaceRootPath), entry })
  return createHmac('sha256', key).update(message, 'utf8').digest('hex')
}

function isShortString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_FIELD_LENGTH
}

/** Shape check before the MAC: an unknown member is a rejection, so nothing the MAC does not cover is ever read. */
function asEntry(value: unknown): HostApprovalEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (Object.keys(record).some(key => !ENTRY_KEYS.has(key))) return null
  if (!(HOST_APPROVAL_KINDS as readonly unknown[]).includes(record.kind)) return null
  if (!isShortString(record.subject) || !isShortString(record.digest) || !isShortString(record.createdAt)) return null
  if (record.expiresAt !== undefined && !isShortString(record.expiresAt)) return null
  if (record.data !== undefined && (!record.data || typeof record.data !== 'object' || Array.isArray(record.data))) return null
  if (typeof record.mac !== 'string' || !MAC_PATTERN.test(record.mac)) return null
  return record as unknown as HostApprovalEntry
}

function macVerifies(key: Buffer, workspaceRootPath: string, entry: HostApprovalEntry): boolean {
  let expected: string
  try {
    expected = hostApprovalMac(key, workspaceRootPath, entry)
  } catch {
    return false
  }
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(entry.mac, 'hex'))
}

/** Every entry of the workspace's ledger whose MAC verifies under `key`. Never throws on a bad file. */
export function readHostApprovals(workspaceRootPath: string, key: Buffer): HostApprovalsRead {
  const path = join(workspaceRootPath, HOST_APPROVALS_FILE)
  if (!existsSync(path)) return { entries: [], rejected: 0 }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return { entries: [], rejected: 1 }
  }
  const raw = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    && (parsed as { version?: unknown }).version === LEDGER_VERSION
    ? (parsed as { entries?: unknown }).entries
    : undefined
  if (!Array.isArray(raw)) return { entries: [], rejected: 1 }
  const entries: HostApprovalEntry[] = []
  let rejected = 0
  for (const item of raw) {
    const entry = asEntry(item)
    if (entry && macVerifies(key, workspaceRootPath, entry)) entries.push(entry)
    else rejected += 1
  }
  return { entries, rejected }
}

/** The verified, unexpired entry for `kind` + `subject`, or undefined. */
export function findHostApproval(
  workspaceRootPath: string,
  key: Buffer,
  kind: HostApprovalKind,
  subject: string,
  now: number = Date.now(),
): HostApprovalEntry | undefined {
  const matches = readHostApprovals(workspaceRootPath, key).entries
    .filter(entry => entry.kind === kind && entry.subject === subject)
    .filter(entry => entry.expiresAt === undefined || Date.parse(entry.expiresAt) > now)
  return matches[matches.length - 1]
}

function writeLedger(workspaceRootPath: string, entries: HostApprovalEntry[]): void {
  atomicWriteDurableFileSync(
    join(workspaceRootPath, HOST_APPROVALS_FILE),
    `${JSON.stringify({ version: LEDGER_VERSION, entries }, null, 2)}\n`,
    { mode: 0o600 },
  )
}

/**
 * Record (or replace) the approval for `kind` + `subject`. Only verified entries
 * are carried over, so a forged line never survives a host write.
 */
export function recordHostApproval(
  workspaceRootPath: string,
  key: Buffer,
  input: { kind: HostApprovalKind; subject: string; digest: string; expiresAt?: string; data?: { [key: string]: JsonValue } },
  now: Date = new Date(),
): HostApprovalEntry {
  const fields: HostApprovalFields = {
    kind: input.kind,
    subject: input.subject,
    digest: input.digest,
    createdAt: now.toISOString(),
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    ...(input.data !== undefined ? { data: input.data } : {}),
  }
  const entry: HostApprovalEntry = { ...fields, mac: hostApprovalMac(key, workspaceRootPath, fields) }
  if (!asEntry(entry)) throw new TypeError('recordHostApproval: the entry is not a valid ledger entry')
  const kept = readHostApprovals(workspaceRootPath, key).entries
    .filter(existing => !(existing.kind === input.kind && existing.subject === input.subject))
  writeLedger(workspaceRootPath, [...kept, entry])
  return entry
}

/** Remove the approval for `kind` + `subject`. True when one was removed. */
export function revokeHostApproval(workspaceRootPath: string, key: Buffer, kind: HostApprovalKind, subject: string): boolean {
  const { entries } = readHostApprovals(workspaceRootPath, key)
  const kept = entries.filter(entry => !(entry.kind === kind && entry.subject === subject))
  if (kept.length === entries.length) return false
  writeLedger(workspaceRootPath, kept)
  return true
}

/** The slice of `CredentialManager` the key needs; host-side only. */
export interface HostApprovalsKeyStore {
  get(id: CredentialId): Promise<StoredCredential | null>
  set(id: CredentialId, credential: StoredCredential): Promise<void>
}

const KEY_ID: CredentialId = { type: 'host_approvals_key' }
const pendingKeys = new WeakMap<HostApprovalsKeyStore, Promise<Buffer>>()

/**
 * The per-install ledger key: read from the credential store, or minted once
 * (32 random bytes, hex) and stored. Concurrent first calls on one store share
 * one mint. A stored value that is not a key throws {@link HostApprovalsKeyError}
 * — the caller then trusts no entry, which is the closed failure; re-minting over
 * it would hide the damage. The key is never logged.
 */
export function getHostApprovalsKey(store: HostApprovalsKeyStore): Promise<Buffer> {
  const pending = pendingKeys.get(store)
  if (pending) return pending
  const loading = (async () => {
    const stored = await store.get(KEY_ID)
    if (stored) {
      if (!KEY_PATTERN.test(stored.value)) throw new HostApprovalsKeyError('the stored host-approvals key is malformed')
      return Buffer.from(stored.value, 'hex')
    }
    const value = randomBytes(32).toString('hex')
    await store.set(KEY_ID, { value })
    return Buffer.from(value, 'hex')
  })()
  pendingKeys.set(store, loading)
  loading.catch(() => { pendingKeys.delete(store) })
  return loading
}

/**
 * UA12.1 — the one port through which the host hands the ledger its key. Readers
 * call `getHostApprovalsKeyProvider().getKey()`; a rejection is the closed
 * failure (trust no entry).
 */
export interface HostApprovalsKeyProvider {
  getKey(): Promise<Buffer>
}

/** The credential-store provider (UA1.10's key, `host_approvals_key::global`). */
export function credentialStoreHostApprovalsKeyProvider(store: HostApprovalsKeyStore): HostApprovalsKeyProvider {
  return { getKey: () => getHostApprovalsKey(store) }
}

/**
 * The headless server's provider, and the default when no host installed one:
 * the process credential store. STATED RESIDUE (UA12.1): any same-user process
 * can decrypt that store, so on the headless server a shell that can read
 * `credentials.enc` can recover the key and mint an entry.
 */
export const headlessHostApprovalsKeyProvider: HostApprovalsKeyProvider = {
  getKey: () => getHostApprovalsKey(getCredentialManager()),
}

let installedKeyProvider: HostApprovalsKeyProvider | undefined

/** Installed once by the host at startup (the desktop's OS-sealed provider); `undefined` restores the default. */
export function setHostApprovalsKeyProvider(provider: HostApprovalsKeyProvider | undefined): void {
  installedKeyProvider = provider
}

/** The provider the host installed, else {@link headlessHostApprovalsKeyProvider}. */
export function getHostApprovalsKeyProvider(): HostApprovalsKeyProvider {
  return installedKeyProvider ?? headlessHostApprovalsKeyProvider
}

/** The sealed key's file name, directly in the config dir (the app's own records, beside `credentials.enc`). */
export const HOST_APPROVALS_SEALED_KEY_FILE = 'host-approvals-key.sealed'

/** The OS secret store, as the host supplies it (Electron `safeStorage.encryptString` / `decryptString`). */
export interface HostApprovalsKeySealer {
  seal(plain: string): Buffer
  unseal(sealed: Buffer): string
}

/**
 * The desktop provider: the key is minted once, sealed by `sealer`, and kept as
 * base64 text in `filePath` (0600, atomic). Only the sealed form touches disk.
 * A file that does not unseal to a key throws {@link HostApprovalsKeyError} and is
 * left in place — the closed failure; re-minting over it would hide the damage
 * (an operator who deletes it mints a fresh key, and every approval is asked
 * again). A deleted file is re-minted, which also invalidates every entry.
 */
export function sealedFileHostApprovalsKeyProvider(filePath: string, sealer: HostApprovalsKeySealer): HostApprovalsKeyProvider {
  let loading: Promise<Buffer> | undefined
  const load = async (): Promise<Buffer> => {
    if (existsSync(filePath)) {
      let value: string
      try {
        value = sealer.unseal(Buffer.from(readFileSync(filePath, 'utf-8').trim(), 'base64'))
      } catch {
        throw new HostApprovalsKeyError(`the sealed host-approvals key (${filePath}) cannot be unsealed by the OS secret store`)
      }
      if (!KEY_PATTERN.test(value)) throw new HostApprovalsKeyError(`the sealed host-approvals key (${filePath}) is malformed`)
      return Buffer.from(value, 'hex')
    }
    const value = randomBytes(32).toString('hex')
    atomicWriteDurableFileSync(filePath, `${sealer.seal(value).toString('base64')}\n`, { mode: 0o600 })
    return Buffer.from(value, 'hex')
  }
  return {
    getKey() {
      if (!loading) {
        loading = load()
        loading.catch(() => { loading = undefined })
      }
      return loading
    },
  }
}
