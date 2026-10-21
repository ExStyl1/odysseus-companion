/**
 * UA1.10 — host-record integrity: the host-approvals ledger and the guarded
 * record patterns (spec §16, S17/S24).
 *
 * Three invariants, each with a positive and a negative arm:
 *
 * 1. **The ledger accepts only what the host MACed.** An entry the host writes
 *    verifies; an entry edited on disk, forged under another key, carrying a MAC
 *    lifted from a sibling, carrying a field the MAC does not cover, or copied
 *    from another workspace's ledger does not. The canonical form is pinned by a
 *    vector computed here from a hand-written string, not by the module itself.
 * 2. **The key is per install, minted once,** under `host_approvals_key::global`
 *    in the credential store, and a malformed stored value fails CLOSED.
 * 3. **The guard refuses a direct write** to the five records (`pages/*\/page.json`,
 *    `projects/*\/context.md` and the rest) from the gate Pi and Claude both call
 *    (`runPreToolUseChecks`: Pi on `pre_tool_use_request`, Claude as its
 *    matcher-less `PreToolUse` hook), so under `acceptEdits` a Write-tool-only
 *    agent cannot put an entry on disk, and one that lands any other way (codex's
 *    own sandbox is the host's only lever there) still does not verify without
 *    the key.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { createHmac } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  HOST_APPROVALS_FILE,
  HOST_APPROVAL_KINDS,
  HostApprovalsKeyError,
  canonicalJson,
  findHostApproval,
  getHostApprovalsKey,
  hostApprovalMac,
  readHostApprovals,
  recordHostApproval,
  revokeHostApproval,
  type HostApprovalEntry,
} from '../host-approvals.ts'
import { CredentialManager } from '../../credentials/manager.ts'
import { credentialIdToAccount, type CredentialId, type StoredCredential } from '../../credentials/types.ts'
import type { CredentialBackend } from '../../credentials/backends/types.ts'
import * as preToolUse from '../../agent/core/pre-tool-use.ts'
import { runPreToolUseChecks, type PermissionManagerLike } from '../../agent/core/pre-tool-use.ts'
import type { PermissionMode } from '../../agent/mode-types.ts'
import { cleanupModeState, initializeModeState } from '../../agent/mode-manager.ts'

const KEY_A = Buffer.alloc(32, 0xa1)
const KEY_B = Buffer.alloc(32, 0xb2)
const NOW = new Date('2026-10-02T08:00:00.000Z')

let sandbox: string
let wsA: string
let wsB: string

beforeAll(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-ua110-')))
  wsA = join(sandbox, 'nessy-config', 'workspaces', 'ws-a')
  wsB = join(sandbox, 'nessy-config', 'workspaces', 'ws-b')
  for (const dir of [wsA, wsB]) mkdirSync(dir, { recursive: true })
})

afterAll(() => { rmSync(sandbox, { recursive: true, force: true }) })

const ledgerPath = (root: string) => join(root, HOST_APPROVALS_FILE)
const rawLedger = (root: string) => JSON.parse(readFileSync(ledgerPath(root), 'utf-8')) as { version: number; entries: HostApprovalEntry[] }
const writeRaw = (root: string, value: unknown) => writeFileSync(ledgerPath(root), JSON.stringify(value))

describe('UA1.10 · the canonical form the MAC covers', () => {
  it('sorts object keys, drops undefined members, and is whitespace-free', () => {
    expect(canonicalJson({ b: 1, a: [true, null, 'x'], c: undefined, d: { z: 2, y: 'é' } }))
      .toBe('{"a":[true,null,"x"],"b":1,"d":{"y":"é","z":2}}')
  })

  it('refuses what JSON cannot carry faithfully', () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(TypeError)
    expect(() => canonicalJson({ n: Infinity })).toThrow(TypeError)
    expect(() => canonicalJson({ n: 1n })).toThrow(TypeError)
    expect(() => canonicalJson([undefined])).toThrow(TypeError)
  })

  it('PIN: the MAC is HMAC-SHA256 over a hand-written canonical string (an independent vector)', () => {
    const fields = { kind: 'page-grant' as const, subject: 'page:demo', digest: 'sha256:abc', createdAt: '2026-10-02T08:00:00.000Z' }
    const message = `{"entry":{"createdAt":"2026-10-02T08:00:00.000Z","digest":"sha256:abc","kind":"page-grant","subject":"page:demo"},"ledger":"nessy-host-approvals","v":1,"workspace":"/ws/pin"}`
    const expected = createHmac('sha256', KEY_A).update(message, 'utf8').digest('hex')
    expect(hostApprovalMac(KEY_A, '/ws/pin', fields)).toBe(expected)
  })

  it('names the five kinds the plan uses now, so later rows do not reshape the ledger', () => {
    expect([...HOST_APPROVAL_KINDS]).toEqual(['page-grant', 'script-approval', 'refresh-approval', 'task-confirmation', 'project-context'])
  })
})

describe('UA1.10 · the ledger accepts only entries whose MAC verifies', () => {
  afterEach(() => { for (const root of [wsA, wsB]) rmSync(ledgerPath(root), { force: true }) })

  it('POSITIVE: an entry the host writes verifies, and the file is 0600', () => {
    const entry = recordHostApproval(wsA, KEY_A, { kind: 'project-context', subject: 'project:acme', digest: 'sha256:111' }, NOW)
    const found = findHostApproval(wsA, KEY_A, 'project-context', 'project:acme', NOW.getTime())
    const read = readHostApprovals(wsA, KEY_A)
    expect({
      found: found?.digest,
      mac: found?.mac === entry.mac,
      count: read.entries.length,
      rejected: read.rejected,
      mode: (statSync(ledgerPath(wsA)).mode & 0o777).toString(8),
    }).toEqual({ found: 'sha256:111', mac: true, count: 1, rejected: 0, mode: '600' })
  })

  it('NEGATIVE: an entry edited on disk fails its MAC', () => {
    recordHostApproval(wsA, KEY_A, { kind: 'task-confirmation', subject: 'task:t1', digest: 'sha256:aaa' }, NOW)
    const ledger = rawLedger(wsA)
    ledger.entries[0]!.digest = 'sha256:forged'
    writeRaw(wsA, ledger)
    expect({
      found: findHostApproval(wsA, KEY_A, 'task-confirmation', 'task:t1', NOW.getTime()),
      read: readHostApprovals(wsA, KEY_A),
    }).toEqual({ found: undefined, read: { entries: [], rejected: 1 } })
  })

  it('NEGATIVE: an entry MACed under another key, or wearing a sibling\'s MAC, is rejected', () => {
    const real = recordHostApproval(wsA, KEY_A, { kind: 'page-grant', subject: 'page:p1', digest: 'sha256:p1' }, NOW)
    const forgedFields = { kind: 'page-grant' as const, subject: 'page:p2', digest: 'sha256:p2', createdAt: NOW.toISOString() }
    writeRaw(wsA, {
      version: 1,
      entries: [
        real,
        { ...forgedFields, mac: hostApprovalMac(KEY_B, wsA, forgedFields) },
        { ...forgedFields, subject: 'page:p3', mac: real.mac },
      ],
    })
    const read = readHostApprovals(wsA, KEY_A)
    expect({ subjects: read.entries.map(e => e.subject), rejected: read.rejected }).toEqual({ subjects: ['page:p1'], rejected: 2 })
  })

  it('NEGATIVE: a field the MAC does not cover makes the entry unreadable rather than silently trusted', () => {
    const real = recordHostApproval(wsA, KEY_A, { kind: 'script-approval', subject: 'page:s', digest: 'sha256:s' }, NOW)
    writeRaw(wsA, { version: 1, entries: [{ ...real, grantsAllSources: true }] })
    expect(readHostApprovals(wsA, KEY_A)).toEqual({ entries: [], rejected: 1 })
  })

  it('NEGATIVE: another workspace\'s ledger copied over does not verify here (the MAC binds the workspace root)', () => {
    recordHostApproval(wsB, KEY_A, { kind: 'refresh-approval', subject: 'page:r', digest: 'sha256:r' }, NOW)
    writeFileSync(ledgerPath(wsA), readFileSync(ledgerPath(wsB)))
    expect({ b: readHostApprovals(wsB, KEY_A).entries.length, a: readHostApprovals(wsA, KEY_A) })
      .toEqual({ b: 1, a: { entries: [], rejected: 1 } })
  })

  it('BOUNDARY: a missing or unparsable ledger reads as empty — fail closed, never a throw', () => {
    expect(readHostApprovals(wsA, KEY_A)).toEqual({ entries: [], rejected: 0 })
    writeFileSync(ledgerPath(wsA), '{not json')
    expect(readHostApprovals(wsA, KEY_A)).toEqual({ entries: [], rejected: 1 })
  })

  it('expiry, replace and revoke act on verified entries only', () => {
    recordHostApproval(wsA, KEY_A, { kind: 'page-grant', subject: 'page:e', digest: 'sha256:1', expiresAt: '2026-10-02T09:00:00.000Z' }, NOW)
    const live = findHostApproval(wsA, KEY_A, 'page-grant', 'page:e', NOW.getTime())?.digest
    const expired = findHostApproval(wsA, KEY_A, 'page-grant', 'page:e', Date.parse('2026-10-02T09:00:00.000Z'))
    recordHostApproval(wsA, KEY_A, { kind: 'page-grant', subject: 'page:e', digest: 'sha256:2' }, NOW)
    const replaced = readHostApprovals(wsA, KEY_A).entries.map(e => e.digest)
    const revoked = revokeHostApproval(wsA, KEY_A, 'page-grant', 'page:e')
    expect({ live, expired, replaced, revoked, after: readHostApprovals(wsA, KEY_A).entries })
      .toEqual({ live: 'sha256:1', expired: undefined, replaced: ['sha256:2'], revoked: true, after: [] })
  })

  // UA12.4 (LF-1, 2026-10-09, DECIDED: accepted, no counter — the module header's Rollback bullet says why). A READING
  // of the stated residue, not a promise: a counter that refuses an older ledger turns the `restored` arm red.
  it('STATED RESIDUE (UA12.4): an older ledger put back over a revoke verifies again; a ledger from elsewhere still does not', () => {
    recordHostApproval(wsA, KEY_A, { kind: 'script-approval', subject: 'page:r', digest: 'sha256:r' }, NOW)
    const saved = readFileSync(ledgerPath(wsA), 'utf-8')
    const revoked = revokeHostApproval(wsA, KEY_A, 'script-approval', 'page:r')
    const afterRevoke = findHostApproval(wsA, KEY_A, 'script-approval', 'page:r')
    writeFileSync(ledgerPath(wsA), saved)
    const restored = findHostApproval(wsA, KEY_A, 'script-approval', 'page:r')?.digest
    writeFileSync(ledgerPath(wsB), saved) // CONTROL: the MAC binds the workspace root, so the same bytes elsewhere grant nothing
    expect({ revoked, afterRevoke, restored, elsewhere: readHostApprovals(wsB, KEY_A) })
      .toEqual({ revoked: true, afterRevoke: undefined, restored: 'sha256:r', elsewhere: { entries: [], rejected: 1 } })
  })
})

class MemoryBackend implements CredentialBackend {
  readonly name = 'memory'
  readonly priority = 1
  readonly store = new Map<string, StoredCredential>()
  sets = 0
  async isAvailable() { return true }
  async get(id: CredentialId) { return this.store.get(credentialIdToAccount(id)) ?? null }
  async set(id: CredentialId, credential: StoredCredential) { this.sets += 1; this.store.set(credentialIdToAccount(id), credential) }
  async delete(id: CredentialId) { return this.store.delete(credentialIdToAccount(id)) }
  async list() { return [] }
}

describe('UA1.10 · the per-install key', () => {
  it('POSITIVE: minted once under host_approvals_key::global, 32 bytes, stable across calls and concurrent first calls', async () => {
    const backend = new MemoryBackend()
    const manager = new CredentialManager(backend)
    const [first, second] = await Promise.all([getHostApprovalsKey(manager), getHostApprovalsKey(manager)])
    const third = await getHostApprovalsKey(new CredentialManager(backend))
    expect({
      accounts: [...backend.store.keys()],
      sets: backend.sets,
      length: first.length,
      same: first.equals(second) && first.equals(third),
    }).toEqual({ accounts: ['host_approvals_key::global'], sets: 1, length: 32, same: true })
  })

  it('NEGATIVE: a malformed stored key fails closed and is NOT silently re-minted', async () => {
    const backend = new MemoryBackend()
    backend.store.set('host_approvals_key::global', { value: 'not-a-key' })
    await expect(getHostApprovalsKey(new CredentialManager(backend))).rejects.toBeInstanceOf(HostApprovalsKeyError)
    expect(backend.store.get('host_approvals_key::global')?.value).toBe('not-a-key')
  })
})

const GATE_KEY = { workspaceId: 'ws-ua110', sessionId: 'session-ua110' }
const stubPermissions: PermissionManagerLike = {
  isCommandWhitelisted: () => false,
  isDangerousCommand: () => false,
  getBaseCommand: command => command.split(/\s+/)[0] || command,
  extractDomainFromNetworkCommand: () => null,
  isDomainWhitelisted: () => false,
}

/** The gate Pi and Claude both call; the mode is read from the mode-state singleton, so it is set per arm. */
function gate(root: string, toolName: string, input: Record<string, unknown>, mode: PermissionMode, cwd = root): { type: string; record: boolean } {
  cleanupModeState(GATE_KEY)
  initializeModeState(GATE_KEY, mode)
  try {
    const result = runPreToolUseChecks({
      toolName, input, sessionId: GATE_KEY.sessionId, sessionKey: GATE_KEY, permissionMode: mode,
      workspaceRootPath: root, workspaceId: GATE_KEY.workspaceId, workingDirectory: cwd,
      activeSourceSlugs: [], allSourceSlugs: [], hasSourceActivation: false, permissionManager: stubPermissions,
    })
    const reason = result.type === 'block' ? result.reason : ''
    return { type: result.type, record: /are blocked/.test(reason) }
  } finally {
    cleanupModeState(GATE_KEY)
  }
}

const BLOCKED = { type: 'block', record: true }

describe('UA1.10 · the guarded record patterns refuse a direct model write', () => {
  const RECORDS = ['tasks/t1/task.yaml', 'pages/x/page.json', 'projects/x/config.json', 'projects/x/context.md', HOST_APPROVALS_FILE]

  it('NEGATIVE: a direct Write to pages/x/page.json or projects/x/context.md is refused, in both tool spellings (Claude file_path, Pi path)', () => {
    const verdicts = ['pages/x/page.json', 'projects/x/context.md'].flatMap(rel => [
      gate(wsA, 'Write', { file_path: join(wsA, rel), content: '{}' }, 'acceptEdits'),
      gate(wsA, 'Write', { path: join(wsA, rel), content: '{}' }, 'acceptEdits'),
    ])
    expect(verdicts).toEqual([BLOCKED, BLOCKED, BLOCKED, BLOCKED])
  })

  for (const mode of ['default', 'acceptEdits', 'auto', 'bypassPermissions'] as const) {
    it(`refuses Write, Edit and a shell redirect to each of the five records in ${mode}`, () => {
      const verdicts = RECORDS.flatMap(rel => {
        const target = join(wsA, rel)
        return [
          `${rel}:Write:${JSON.stringify(gate(wsA, 'Write', { file_path: target, content: '{}' }, mode))}`,
          `${rel}:Edit:${JSON.stringify(gate(wsA, 'Edit', { file_path: target, old_string: 'a', new_string: 'b' }, mode))}`,
          `${rel}:Bash:${JSON.stringify(gate(wsA, 'Bash', { command: `printf x > ${target}` }, mode))}`,
        ]
      })
      expect(verdicts).toEqual(RECORDS.flatMap(rel => ['Write', 'Edit', 'Bash'].map(tool => `${rel}:${tool}:${JSON.stringify(BLOCKED)}`)))
    })
  }

  it('reads a record named from inside its own folder (cd, then a bare name)', () => {
    const verdicts = ['tasks/t1/task.yaml', 'projects/x/context.md'].map(rel => {
      const [dir, name] = [rel.slice(0, rel.lastIndexOf('/')), rel.slice(rel.lastIndexOf('/') + 1)]
      return gate(wsA, 'Bash', { command: `cd ${join(wsA, dir)} && printf x > ${name}` }, 'acceptEdits')
    })
    expect(verdicts).toEqual([BLOCKED, BLOCKED])
  })

  it('names the host as the writer, and the page record does not point at a door that does not exist', () => {
    cleanupModeState(GATE_KEY)
    initializeModeState(GATE_KEY, 'acceptEdits')
    const reason = (rel: string) => {
      const result = runPreToolUseChecks({
        toolName: 'Write', input: { file_path: join(wsA, rel), content: '{}' }, sessionId: GATE_KEY.sessionId,
        sessionKey: GATE_KEY, permissionMode: 'acceptEdits', workspaceRootPath: wsA, workspaceId: GATE_KEY.workspaceId,
        workingDirectory: wsA, activeSourceSlugs: [], allSourceSlugs: [], hasSourceActivation: false, permissionManager: stubPermissions,
      })
      return result.type === 'block' ? result.reason : ''
    }
    const ledger = reason(HOST_APPROVALS_FILE)
    const page = reason('pages/x/page.json')
    cleanupModeState(GATE_KEY)
    expect({
      ledgerNamesHost: ledger.includes('only Nessy writes it'),
      pageNamesPath: page.includes('pages/x/page.json are blocked'),
      noAutomationDoor: !page.includes('automation_create'),
    }).toEqual({ ledgerNamesHost: true, pageNamesPath: true, noAutomationDoor: true })
  })

  it('CONTROL: an ordinary page or project file still writes with no card, so the patterns are not a folder block', () => {
    const verdicts = ['pages/x/index.html', 'projects/x/MEMORY.md', 'tasks/t1/notes.md'].map(rel =>
      gate(wsA, 'Write', { file_path: join(wsA, rel), content: 'x' }, 'acceptEdits').type)
    expect(verdicts).toEqual(['allow', 'allow', 'allow'])
  })

  it('BOUNDARY: one folder level only, and nothing outside the workspace root', () => {
    const outside = join(sandbox, 'project')
    mkdirSync(join(outside, 'pages', 'x'), { recursive: true })
    expect({
      nested: gate(wsA, 'Write', { file_path: join(wsA, 'pages/x/y/page.json'), content: '{}' }, 'acceptEdits').type,
      rootLevel: gate(wsA, 'Write', { file_path: join(wsA, 'page.json'), content: '{}' }, 'acceptEdits').type,
      outside: gate(wsA, 'Write', { file_path: join(outside, 'pages/x/page.json'), content: '{}' }, 'acceptEdits', outside).type,
    }).toEqual({ nested: 'allow', rootLevel: 'allow', outside: 'allow' })
  })

  it('PIN (codex): the exact-name records codex receives carry no glob character, and the patterns stay a separate list', () => {
    // codex `rust-v0.159.3` `codex-rs/core/src/config/permissions.rs`: "filesystem glob
    // subpath `{subpath}` only supports `deny` access" — a pattern key projected as a
    // `":workspace_roots"` `read` subpath would fail codex's config load. `codex-agent.ts`
    // projects `GUARDED_WORKSPACE_RECORDS.keys()` verbatim, so the patterns must never
    // enter that map.
    const exact = [...preToolUse.GUARDED_WORKSPACE_RECORDS.keys()]
    const patterns = [...preToolUse.GUARDED_WORKSPACE_RECORD_PATTERNS.keys()]
    expect({
      exactHasLedger: exact.includes(HOST_APPROVALS_FILE),
      exactGlobs: exact.filter(key => /[*?[\]]/.test(key)),
      patterns,
    }).toEqual({
      exactHasLedger: true,
      exactGlobs: [],
      patterns: ['tasks/*/task.yaml', 'pages/*/page.json', 'projects/*/config.json', 'projects/*/context.md'],
    })
  })
})

describe('UA1.10 · under acceptEdits a Write-tool-only agent cannot produce a ledger entry that verifies', () => {
  afterEach(() => { rmSync(ledgerPath(wsA), { force: true }) })

  it('Pi and Claude: the Write is refused before anything lands, and the key\'s store is unreadable to the Read tool', () => {
    const forged = { kind: 'page-grant', subject: 'page:x', digest: 'sha256:x', createdAt: NOW.toISOString(), mac: '0'.repeat(64) }
    expect({
      write: gate(wsA, 'Write', { file_path: ledgerPath(wsA), content: JSON.stringify({ version: 1, entries: [forged] }) }, 'acceptEdits'),
      piWrite: gate(wsA, 'Write', { path: ledgerPath(wsA), content: '{}' }, 'acceptEdits'),
      readStore: gate(wsA, 'Read', { file_path: join(sandbox, 'nessy-config', 'credentials.enc') }, 'acceptEdits').type,
    }).toEqual({ write: BLOCKED, piWrite: BLOCKED, readStore: 'block' })
  })

  it('every runtime (codex included, whose writes never reach this gate): an entry that lands without the key does not verify', () => {
    // What an agent that cannot read the key can produce: any bytes, including a
    // MAC under a key of its own choosing and a real entry's MAC moved onto a new subject.
    const real = recordHostApproval(wsA, KEY_A, { kind: 'page-grant', subject: 'page:real', digest: 'sha256:real' }, NOW)
    const own = { kind: 'page-grant' as const, subject: 'page:own', digest: 'sha256:own', createdAt: NOW.toISOString() }
    writeRaw(wsA, { version: 1, entries: [{ ...own, mac: hostApprovalMac(KEY_B, wsA, own) }, { ...own, mac: real.mac }, { ...own, mac: '0'.repeat(64) }] })
    expect(readHostApprovals(wsA, KEY_A)).toEqual({ entries: [], rejected: 3 })
  })
})
