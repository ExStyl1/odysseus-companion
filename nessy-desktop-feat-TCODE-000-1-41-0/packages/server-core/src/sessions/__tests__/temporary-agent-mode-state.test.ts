/**
 * F1.416 + F1.417 (origin WJ-ff verifier on F1.257) — the mode entries of agents
 * the HOST builds under keys no session owns, and of a branch the host rolls back.
 *
 * Since F1.257 (`da4d5d282`) a ClaudeAgent's `destroy()` keeps its session key's
 * mode entry, because for a real session that entry is the host's and
 * `deleteSession` removes it. Two paths never reach `deleteSession`:
 *
 * - F1.416 — temporary agents under SYNTHETIC keys: `title-<id>` (`generateTitle`
 *   and `refreshTitle`) and `<id>-remote-transfer-summary`. Nothing owns those
 *   keys, so each temporary agent left one entry behind for the process's life
 *   (WJ-ff's PROBE-TITLE: the entry survived `destroy()` AND `deleteSession`).
 *   The fix clears the synthetic key beside each `destroy()`.
 * - F1.417 — a failed sdk-fork branch preflight is undone by
 *   `rollbackFailedBranchCreation` → `deleteFromRuntimeSessions`, which removes the
 *   session without `deleteSession` and relied on the preflight ClaudeAgent's old
 *   `destroy()` to clear the branch key. The fix clears it there, beside the
 *   per-session map deletes that closure already copies from `deleteSession`.
 *
 * Every temporary agent below is a REAL ClaudeAgent built by the production call
 * site; only its SDK-facing steps (`postInit`, `runMiniCompletion`,
 * `ensureBranchReady`) are replaced on the prototype for this file and put back
 * after. The CONTROL in every arm: the host session's own entry is untouched,
 * and the stub saw the synthetic session id (so the arm is not vacuous).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, rmSync } from 'node:fs'
import type { StoredConfig } from '@nessy-agent/shared/config/storage'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'

const CONNECTIONS = [
  { slug: 'f1416-claude', name: 'Claude Code (F1.416)', providerType: 'claude-runtime', authType: 'api_key', defaultModel: 'f1416-model', createdAt: Date.now() },
] as unknown as NonNullable<StoredConfig['llmConnections']>

type ModeStates = { states: Map<string, { permissionMode: string }>; callbacks: Map<string, unknown> }
type AgentProto = {
  postInit(): Promise<unknown>
  runMiniCompletion(this: { config: { session?: { id?: string } } }, prompt: string): Promise<string | null>
  ensureBranchReady(this: { config: { session?: { id?: string } } }): Promise<void>
}

let createTestSessionManager: typeof import('./test-session-manager.ts')['createTestSessionManager']
let mm: ModeStates
let encodeSessionKey: (key: { workspaceId: string; sessionId: string }) => string
let proto: AgentProto
let real: Pick<AgentProto, 'postInit' | 'runMiniCompletion' | 'ensureBranchReady'>
let restoreConfig: () => void = () => {}
const seen: string[] = []
const seenBranch: string[] = []

beforeAll(async () => {
  ;({ createTestSessionManager } = await import('./test-session-manager.ts'))
  const agentModule = await import('@nessy-agent/shared/agent')
  mm = agentModule.modeManager as unknown as ModeStates
  ;({ encodeSessionKey } = await import('@nessy-agent/shared/sessions/session-key'))
  const { setSessionPlatform } = await import('../SessionManager.ts')
  const { createHeadlessPlatform } = await import('../../runtime/platform-headless.ts')
  setSessionPlatform(createHeadlessPlatform())
  const { initializeCredentialManagerV2 } = await import('@nessy-agent/shared/credentials')
  try { initializeCredentialManagerV2({ storageLayoutVersion: 2, verificationId: 'f1416-temporary-agent-mode-state' }) } catch { /* initialised */ }
  const storage = await import('@nessy-agent/shared/config/storage')
  const configPath = storage.getConfigPath()
  const previous = existsSync(configPath) ? storage.loadStoredConfig() : null
  const base: StoredConfig = previous ?? ({ storageLayoutVersion: 2, workspaceRefs: [], activeWorkspaceId: null, activeSessionId: null } as unknown as StoredConfig)
  storage.saveConfig({ ...base, defaultLlmConnection: 'f1416-claude', llmConnections: CONNECTIONS })
  restoreConfig = () => {
    if (previous) storage.saveConfig(previous)
    else if (existsSync(configPath)) rmSync(configPath)
  }
  // The fixture's own positive control: every arm below is about a claude agent.
  const { resolveBackendContext } = await import('@nessy-agent/shared/agent/backend')
  expect(resolveBackendContext({ sessionConnectionSlug: 'f1416-claude' }).provider).toBe('anthropic')

  const { ClaudeAgent } = await import('@nessy-agent/shared/agent')
  proto = ClaudeAgent.prototype as unknown as AgentProto
  real = { postInit: proto.postInit, runMiniCompletion: proto.runMiniCompletion, ensureBranchReady: proto.ensureBranchReady }
  proto.postInit = async () => ({ authInjected: true })
  proto.runMiniCompletion = async function () {
    seen.push(this.config.session?.id ?? '')
    return 'Probe Title'
  }
  proto.ensureBranchReady = async function () {
    seenBranch.push(this.config.session?.id ?? '')
    throw new Error('f1417 branch preflight refused')
  }
}, MODULE_GRAPH_HOOK_BUDGET_MS)

afterAll(() => {
  if (proto) Object.assign(proto, real)
  restoreConfig()
})

type Manager = ReturnType<typeof createTestSessionManager>
type Internals = {
  getManaged(id: string, ws?: string): { id: string; agent?: unknown; messages: Array<Record<string, unknown>>; sdkSessionId?: string; workspace: { id: string } }
  generateTitle(managed: unknown, userMessage: string, retryOnSkip?: boolean): Promise<void>
  generateRemoteTransferSummary(managed: unknown): Promise<string | null>
  persistSession(managed: unknown): void
}

async function hostSession(manager: Manager, ws: string) {
  const session = await manager.createSession(ws, { llmConnection: 'f1416-claude', permissionMode: 'default' })
  const internals = manager as unknown as Internals
  const managed = internals.getManaged(session.id, ws)
  const host = encodeSessionKey({ workspaceId: ws, sessionId: session.id })
  return { session, internals, managed, host }
}

describe('F1.416 · a temporary agent under a synthetic key leaves no mode entry', () => {
  it('generateTitle: the `title-<id>` entry goes with the temporary agent; the host entry stays', async () => {
    const manager = createTestSessionManager()
    const ws = 'ws-f1416-generate-title'
    try {
      const { session, internals, managed, host } = await hostSession(manager, ws)
      expect(managed.agent ?? null).toBeNull()
      const synthetic = encodeSessionKey({ workspaceId: ws, sessionId: `title-${session.id}` })
      await internals.generateTitle(managed, 'Summarise the build failures', false)
      expect(seen).toContain(`title-${session.id}`)
      expect({ state: mm.states.has(synthetic), callbacks: mm.callbacks.has(synthetic) }).toEqual({ state: false, callbacks: false })
      expect(mm.states.has(host)).toBe(true)
    } finally {
      await manager.cleanup()
    }
  }, 120_000)

  it('refreshTitle: the same, through the public entry point', async () => {
    const manager = createTestSessionManager()
    const ws = 'ws-f1416-refresh-title'
    try {
      const { session, managed, host } = await hostSession(manager, ws)
      managed.messages.push({ id: 'u1', role: 'user', content: 'Fix the flaky test', timestamp: Date.now() })
      const synthetic = encodeSessionKey({ workspaceId: ws, sessionId: `title-${session.id}` })
      const result = await manager.refreshTitle(session.id, ws)
      expect(result).toEqual({ success: true, title: 'Probe Title' })
      expect(mm.states.has(synthetic)).toBe(false)
      expect(mm.states.has(host)).toBe(true)
    } finally {
      await manager.cleanup()
    }
  }, 120_000)

  it('the remote-transfer summary: `<id>-remote-transfer-summary` goes with its agent', async () => {
    const manager = createTestSessionManager()
    const ws = 'ws-f1416-transfer-summary'
    try {
      const { session, internals, managed, host } = await hostSession(manager, ws)
      managed.messages.push(
        { id: 'u1', role: 'user', content: 'Plan the migration', timestamp: Date.now() },
        { id: 'a1', role: 'assistant', content: 'Here is the plan', timestamp: Date.now() },
      )
      const syntheticId = `${session.id}-remote-transfer-summary`
      const summary = await internals.generateRemoteTransferSummary(managed)
      expect(summary).not.toBeNull()
      expect(seen).toContain(syntheticId)
      expect(mm.states.has(encodeSessionKey({ workspaceId: ws, sessionId: syntheticId }))).toBe(false)
      expect(mm.states.has(host)).toBe(true)
    } finally {
      await manager.cleanup()
    }
  }, 120_000)
})

describe('F1.417 · a rolled-back sdk-fork branch takes its mode entry with it', () => {
  it('ensureBranchReady throws: the branch key is absent after the rollback; the source session keeps its entry', async () => {
    const manager = createTestSessionManager()
    const ws = 'ws-f1417-branch-rollback'
    try {
      const { session: source, managed: sourceManaged, host } = await hostSession(manager, ws)
      // A branch needs the parent's SDK context and a message to branch at, seeded
      // on the LIVE source (cron-store-lifecycle.test.ts's recipe).
      sourceManaged.sdkSessionId = '2f24c2a1-4c1e-4f2b-9c6d-0f5a2b6a11c8'
      sourceManaged.messages.push({ id: 'msg-branch-point', role: 'assistant', content: 'branch here', timestamp: Date.now() })
      const before = new Set(mm.states.keys())
      await expect(manager.createSession(ws, {
        llmConnection: 'f1416-claude',
        branchFromSessionId: source.id,
        branchFromMessageId: 'msg-branch-point',
      } as never)).rejects.toThrow(/Could not create branch/)
      // CONTROL: the preflight really ran a ClaudeAgent on the branch's own key.
      expect(seenBranch).toHaveLength(1)
      const branchId = seenBranch[0]
      expect(branchId).not.toBe(source.id)
      const branchKey = encodeSessionKey({ workspaceId: ws, sessionId: branchId! })
      expect(mm.states.has(branchKey)).toBe(false)
      expect([...mm.states.keys()].filter(key => !before.has(key))).toEqual([])
      expect(mm.states.has(host)).toBe(true)
    } finally {
      await manager.cleanup()
    }
  }, 120_000)
})
