/**
 * F1.198 (origin WJ-q P-WJ-q-1, F1.144's live half) — a runtime switch must not
 * leave the permission gate and the session record disagreeing.
 *
 * ## The drift, reproduced on the real path
 *
 * Two things hold a session's mode: the RECORD (`managed.permissionMode`, what
 * `getSessions()` reports and the renderer shows) and the mode-state SINGLETON
 * (`getPermissionModeDiagnostics`, what every runtime's gate reads through
 * `runPreToolUseChecks`). `SessionManager.setSessionPermissionMode` writes both,
 * and warns "Permission mode drift detected" when it finds them apart.
 *
 * Measured 2026-09-23 (WJ-w) with the REAL manager, a REAL `ClaudeAgent` built
 * by the composer's own `refreshContextUsage`, and the REAL
 * `switchSessionRuntime`: a fresh claude session in `bypassPermissions` reads
 * `bypassPermissions` on both before the switch, and after a switch to Pi the
 * record still says `bypassPermissions` while the gate reads `default`. The
 * switch's strict drain disposes the outgoing agent, `ClaudeAgent.destroy()`
 * clears the session's mode-state entry (`cleanupModeState`), and the switch
 * then carried the record's mode across WITHOUT re-asserting it — its one-door
 * call was guarded by `renormalized.permissionMode !== managed.permissionMode`,
 * and a mode the target runtime also offers is not renormalized. The control
 * that the arm reads a real difference: the same fresh session in `default`
 * reads `default` on both sides of the same switch, because a cleared entry
 * reads as `default`.
 *
 * ## The fix — one door, taken every time
 *
 * The switch now routes the renormalized mode through `setSessionPermissionMode`
 * unconditionally. When the two already agree it returns without a write (its
 * own no-op branch); when the drain cleared the singleton it reconciles from the
 * record, which is the drift heal the method already had. The record stays the
 * authority the host writes; nothing new decides a mode.
 *
 * ## What this does NOT prove
 *
 * That this drift is the one SIT-10 met. The rig's order is fresh session →
 * switch → an explicit `setPermissionMode`, and a same-mode set already heals
 * the drift, so the live card is not explained by this alone; the instrument for
 * the next sitting (read the gate's mode beside the record while the card is up)
 * is handed back with the row.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, rmSync } from 'node:fs'
import type { StoredConfig } from '@nessy-agent/shared/config/storage'
import type { PermissionMode } from '@nessy-agent/shared/agent/mode-types'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'

const TEST_CONNECTIONS = [
  {
    slug: 'drift-pi',
    name: 'Pi',
    providerType: 'pi',
    authType: 'api_key',
    defaultModel: 'pi-model-a',
    createdAt: Date.now(),
  },
  {
    slug: 'drift-claude',
    name: 'Claude Code (Nessy Gateway)',
    providerType: 'claude-runtime',
    authType: 'bearer_token',
    defaultModel: 'claude-gw-model-a',
    createdAt: Date.now(),
  },
] as unknown as NonNullable<StoredConfig['llmConnections']>

type ManagerModule = typeof import('./test-session-manager.ts')
type DiagnosticsFn = typeof import('@nessy-agent/shared/agent')['getPermissionModeDiagnostics']

let createTestSessionManager: ManagerModule['createTestSessionManager']
let getPermissionModeDiagnostics: DiagnosticsFn
let restoreConfig: () => void = () => {}

beforeAll(async () => {
  ;({ createTestSessionManager } = await import('./test-session-manager.ts'))
  ;({ getPermissionModeDiagnostics } = await import('@nessy-agent/shared/agent'))
  const { setSessionPlatform } = await import('../SessionManager.ts')
  const { createHeadlessPlatform } = await import('../../runtime/platform-headless.ts')
  const { initializeCredentialManagerV2 } = await import('@nessy-agent/shared/credentials')
  // Both are what a real claude agent build needs before it can publish; the
  // switch suite binds them the same way for its real-hostability row.
  setSessionPlatform(createHeadlessPlatform())
  try {
    initializeCredentialManagerV2({ storageLayoutVersion: 2, verificationId: 'test-runtime-switch-mode-drift' })
  } catch {
    // Already bound by another suite in this process — a manager exists either way.
  }

  const storage = await import('@nessy-agent/shared/config/storage')
  const configPath = storage.getConfigPath()
  const previous = existsSync(configPath) ? storage.loadStoredConfig() : null
  const base: StoredConfig = previous ?? ({
    storageLayoutVersion: 2,
    workspaceRefs: [],
    activeWorkspaceId: null,
    activeSessionId: null,
  } as unknown as StoredConfig)
  storage.saveConfig({ ...base, defaultLlmConnection: 'drift-claude', llmConnections: TEST_CONNECTIONS })
  restoreConfig = () => {
    if (previous) storage.saveConfig(previous)
    else if (existsSync(configPath)) rmSync(configPath)
  }
}, MODULE_GRAPH_HOOK_BUDGET_MS)

afterAll(() => { restoreConfig() })

interface Reading {
  agent: string | null
  record: PermissionMode | undefined
  gate: PermissionMode
}

/**
 * A fresh claude session in `mode`, its agent built by the composer's own
 * refresh, then — unless `switchTo` is absent — switched to Pi. Every reading
 * is taken off the real manager: the record the renderer lists and the
 * singleton the gate reads, under the manager's own composite key.
 */
async function drive(workspaceId: string, mode: PermissionMode, switchTo?: string): Promise<{ before: Reading; after: Reading }> {
  const manager = createTestSessionManager()
  // The switch's hostability precondition consults this machine's runtime
  // binaries and credential store; `runtime-switch-session.test.ts` stubs it
  // for the same reason and owns its decision logic.
  ;(manager as unknown as Record<string, unknown>).assertSwitchTargetHostable = async () => {}
  try {
    const session = await manager.createSession(workspaceId, { llmConnection: 'drift-claude', permissionMode: mode })
    const managed = (manager as unknown as {
      getManaged(id: string, ws?: string): { agent?: { constructor?: { name?: string } } | null; permissionMode?: PermissionMode; workspace: { id: string } }
    }).getManaged(session.id, workspaceId)
    // The collaborator the drift needs, built by production and asserted
    // present: an outgoing agent the switch's drain really disposes.
    await manager.refreshContextUsage(session.id, workspaceId)
    const read = (): Reading => ({
      agent: managed.agent?.constructor?.name ?? null,
      record: manager.getSessions(workspaceId).find(row => row.id === session.id)?.permissionMode,
      gate: getPermissionModeDiagnostics({ workspaceId: managed.workspace.id, sessionId: session.id }).permissionMode,
    })
    const before = read()
    if (switchTo) await manager.switchSessionRuntime(session.id, switchTo, workspaceId)
    return { before, after: read() }
  } finally {
    await manager.cleanup()
  }
}

describe('F1.198 · a runtime switch leaves the gate and the record on one mode', () => {
  it('a claude session in bypassPermissions switched to Pi: the gate reads what the record shows', async () => {
    const { before, after } = await drive('ws-f1198-bypass', 'bypassPermissions', 'drift-pi')
    // Read into locals, then assert (the toMatchObject mutation trap does not
    // apply to toEqual, but the habit keeps the readings reportable).
    expect(before).toEqual({ agent: 'ClaudeAgent', record: 'bypassPermissions', gate: 'bypassPermissions' })
    // RED before the fix: `{ agent: null, record: 'bypassPermissions', gate: 'default' }`.
    expect(after).toEqual({ agent: null, record: 'bypassPermissions', gate: 'bypassPermissions' })
  }, 120_000)

  it('CONTROL: a session that never switched runtime reads the same mode on both', async () => {
    const { before, after } = await drive('ws-f1198-noswitch', 'bypassPermissions')
    expect(before).toEqual({ agent: 'ClaudeAgent', record: 'bypassPermissions', gate: 'bypassPermissions' })
    expect(after).toEqual(before)
  }, 120_000)

  it('CONTROL: the same switch from default reads default on both — a cleared entry reads as default', async () => {
    const { before, after } = await drive('ws-f1198-default', 'default', 'drift-pi')
    expect(before).toEqual({ agent: 'ClaudeAgent', record: 'default', gate: 'default' })
    expect(after).toEqual({ agent: null, record: 'default', gate: 'default' })
  }, 120_000)
})

/**
 * F1.257 (origin WJ-w P-WJ-w-2) — the mode entry is the HOST's, so the agent's
 * teardown no longer clears it; the session's deletion does.
 *
 * `ClaudeAgent.destroy()` called `cleanupModeState` for the host's session key,
 * so ANY claude disposal — a runtime switch, a runtime refresh, a failed
 * construction, a respawn — reset the gate's mode for a session that continued
 * to exist. F1.198 re-asserted it on the switch only. DECIDED by the controller:
 * the agent stops clearing state it does not own (it silences only its own
 * echo, `onPermissionModeChange`), and `SessionManager.deleteSession` clears the
 * entry, so nothing leaks.
 *
 * The first arm is the row's CONTROL, taken without touching the tree: the
 * switch's F1.198 re-assert is made a no-op INSIDE the test (the one-door call it
 * added, `setSessionPermissionMode`, stubbed for the duration of the switch), so
 * the gate's reading after the switch is whatever the disposal left behind.
 */
describe('F1.257 · a claude disposal leaves the host-owned mode entry; deletion clears it', () => {
  it('with F1.198\'s re-assert disabled in the test, a switch off claude keeps the gate on the record\'s mode', async () => {
    const manager = createTestSessionManager()
    ;(manager as unknown as Record<string, unknown>).assertSwitchTargetHostable = async () => {}
    const workspaceId = 'ws-f1257-switch'
    try {
      const session = await manager.createSession(workspaceId, { llmConnection: 'drift-claude', permissionMode: 'bypassPermissions' })
      const internals = manager as unknown as {
        getManaged(id: string, ws?: string): { agent?: { constructor?: { name?: string }; onPermissionModeChange?: unknown } | null; workspace: { id: string } }
        setSessionPermissionMode: (...args: unknown[]) => void
      }
      const managed = internals.getManaged(session.id, workspaceId)
      await manager.refreshContextUsage(session.id, workspaceId)
      const outgoing = managed.agent
      const gate = () => getPermissionModeDiagnostics({ workspaceId: managed.workspace.id, sessionId: session.id }).permissionMode
      const before = { agent: outgoing?.constructor?.name ?? null, gate: gate() }
      const realDoor = internals.setSessionPermissionMode
      internals.setSessionPermissionMode = () => {}
      try {
        await manager.switchSessionRuntime(session.id, 'drift-pi', workspaceId)
      } finally {
        internals.setSessionPermissionMode = realDoor
      }
      const after = { agent: managed.agent?.constructor?.name ?? null, gate: gate(), outgoingEcho: outgoing?.onPermissionModeChange ?? null }
      expect(before).toEqual({ agent: 'ClaudeAgent', gate: 'bypassPermissions' })
      // RED before F1.257: `{ agent: null, gate: 'default', outgoingEcho: [Function] }`.
      expect(after).toEqual({ agent: null, gate: 'bypassPermissions', outgoingEcho: null })
    } finally {
      await manager.cleanup()
    }
  }, 120_000)

  it('deleting a session clears its mode entry, even one no claude agent ever held', async () => {
    const manager = createTestSessionManager()
    const workspaceId = 'ws-f1257-delete'
    try {
      const session = await manager.createSession(workspaceId, { llmConnection: 'drift-pi', permissionMode: 'default' })
      manager.setSessionPermissionMode(session.id, 'bypassPermissions', workspaceId)
      const key = { workspaceId, sessionId: session.id }
      // Positive control on the instrument: the host wrote the entry.
      expect(getPermissionModeDiagnostics(key).permissionMode).toBe('bypassPermissions')
      await manager.deleteSession(session.id, workspaceId)
      // RED before F1.257: the entry outlived its session (`'bypassPermissions'`). A cleared entry reads as `default`.
      expect(getPermissionModeDiagnostics(key).permissionMode).toBe('default')
    } finally {
      await manager.cleanup()
    }
  }, 120_000)

  it('CONTROL — deleting one session leaves another session\'s mode entry alone', async () => {
    const manager = createTestSessionManager()
    const workspaceId = 'ws-f1257-sibling'
    try {
      const doomed = await manager.createSession(workspaceId, { llmConnection: 'drift-pi', permissionMode: 'default' })
      const sibling = await manager.createSession(workspaceId, { llmConnection: 'drift-pi', permissionMode: 'default' })
      manager.setSessionPermissionMode(sibling.id, 'bypassPermissions', workspaceId)
      await manager.deleteSession(doomed.id, workspaceId)
      expect(getPermissionModeDiagnostics({ workspaceId, sessionId: sibling.id }).permissionMode).toBe('bypassPermissions')
    } finally {
      await manager.cleanup()
    }
  }, 120_000)
})
