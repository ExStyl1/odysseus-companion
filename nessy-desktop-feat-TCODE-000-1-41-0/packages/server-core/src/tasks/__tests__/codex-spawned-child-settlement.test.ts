/**
 * UA12.99 (P-UA-am-1) — the Tasks Conductor's settlement gate defers while a codex `spawn_agent` child the node left
 * running after its turn lives, and settles once the child's own turn ends.
 *
 * The real chain, end to end below the gate: a real `CodexAgent` (its notification handler fed the parent's spawn
 * call and the child's lifecycle), held as `managed.agent` by a real `SessionManager`, read through
 * `SessionManager.getBackendBackgroundActivity` by the real `createSessionConductorHost(...).isSessionSettled`. The
 * gate's other inputs (runtime settlement, goal, crons, registry tasks, host turn) are a settled structural stub, so
 * the child is the only thing that can defer it.
 *
 * Control: before the fix `CodexAgent` declared no `backgroundActivityCount`, the host read `backgroundWorkCount`
 * (background terminals only), and the gate settled at the parent's door while the child ran.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager, createManagedSession } from '../../sessions/SessionManager.ts'
import { createTestSessionManager } from '../../sessions/__tests__/test-session-manager.ts'
import { createSessionConductorHost, type ConductorSessionManager } from '../conductor-host'
import { CodexAgent } from '../../../../shared/src/agent/codex-agent.ts'
import { cleanupModeState } from '../../../../shared/src/agent/mode-manager.ts'

const WS = 'ws-ua12-99-gate'
const SESS = 'session-ua12-99-gate'
const PARENT = 'parent-thread'
const CHILD = 'child-thread'
const roots: string[] = []

afterEach(() => {
  cleanupModeState({ workspaceId: WS, sessionId: SESS })
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function rig() {
  const root = mkdtempSync(join(tmpdir(), 'ua12-99-gate-'))
  roots.push(root)
  const workspace = { id: WS, name: 'UA12.99', slug: 'ua12-99', rootPath: join(root, 'workspace'), createdAt: Date.now() }
  mkdirSync(workspace.rootPath, { recursive: true })
  const manager: SessionManager = createTestSessionManager()
  const managed = createManagedSession({ id: SESS }, workspace as never, { messagesLoaded: true, ephemeral: true })
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(`${WS}:${SESS}`, managed)

  const agent = new CodexAgent({
    provider: 'codex-runtime',
    workspace: { id: WS, name: 'UA12.99', rootPath: '/tmp/ua12-99', workspaceRootPath: '/tmp/ua12-99', sessionRootPath: '/tmp/ua12-99/sessions' } as never,
    session: { id: SESS, createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: '/tmp/ua12-99' } as never,
    model: 'codex/test-model',
    isHeadless: true,
  } as never)
  const internals = agent as unknown as {
    threadId: string | null
    turnSink: { push: (e: unknown) => void; finish: () => void } | null
    handleNotification: (method: string, params: unknown) => void
  }
  internals.threadId = PARENT
  ;(managed as unknown as { agent: unknown }).agent = agent

  // Every other gate input settled: the child is the only thing that can defer the door.
  const sm = {
    getPiHarnessRuntimeSnapshot: async () => ({ settlement: { settled: true } }),
    listSessionScheduledWork: () => ({ crons: [], tasks: [] }),
    getBackendBackgroundActivity: (sessionId: string, workspaceId?: string) => manager.getBackendBackgroundActivity(sessionId, workspaceId),
    hasHostTurnDueOrRunning: () => false,
    getSessions: () => [],
  }
  const host = createSessionConductorHost(sm as unknown as ConductorSessionManager, { workspaceId: WS, workspaceRoot: root })
  const notify = (method: string, params: unknown) => internals.handleNotification(method, params)
  const spawn = () => {
    internals.turnSink = { push: () => {}, finish: () => {} }
    notify('item/completed', {
      threadId: PARENT, turnId: 'turn-1', completedAtMs: 0,
      item: { type: 'collabAgentToolCall', id: 'collab-spawn-1', tool: 'spawnAgent', status: 'completed', senderThreadId: PARENT, receiverThreadIds: [CHILD], prompt: 'check X', model: null },
    })
    notify('turn/started', { threadId: CHILD, turn: { id: 'child-turn-1' } })
    internals.turnSink = null // the node's turn is over; the child was not waited for
  }
  return { agent, manager, host, notify, spawn }
}

describe('UA12.99 — the settlement gate defers while a codex spawn_agent child lives', () => {
  it('a child left running after the node\'s turn defers the gate; its own turn/completed settles it', async () => {
    const { agent, manager, host, notify, spawn } = rig()
    try {
      spawn()
      expect(manager.getBackendBackgroundActivity(SESS, WS)).toBe(1)
      expect(await host.isSessionSettled!(SESS)).toBe(false)
      notify('turn/completed', { threadId: CHILD, turn: { id: 'child-turn-1', status: 'completed' } })
      expect(manager.getBackendBackgroundActivity(SESS, WS)).toBe(0)
      expect(await host.isSessionSettled!(SESS)).toBe(true)
    } finally {
      agent.destroy()
    }
  })

  it('boundary: with no child the same gate settles at the door', async () => {
    const { agent, manager, host } = rig()
    try {
      expect(manager.getBackendBackgroundActivity(SESS, WS)).toBe(0)
      expect(await host.isSessionSettled!(SESS)).toBe(true)
    } finally {
      agent.destroy()
    }
  })
})
