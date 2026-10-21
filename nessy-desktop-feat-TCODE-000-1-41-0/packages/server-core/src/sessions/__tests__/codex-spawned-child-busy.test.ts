/**
 * UA12.191 (P-LF-5-1) — a codex `spawn_agent` child that works between its parent's turns holds the session against
 * the idle reaper and the live-agent ceiling, within a bound that cannot latch.
 *
 * The real chain: a real `CodexAgent` (its notification handler fed the parent's spawn call and the child's
 * lifecycle), held as `managed.agent` by a real `SessionManager`, read through the real private
 * `liveAgentBusyDomainsFor` — the predicate `reapIdleAgents` and the ceiling's eviction both ask. Before this row the
 * agent's `backgroundWorkCount` counted background terminals only (UA12.99 kept children out, QUESTIONS.md LF-5
 * default (a)), so the predicate read the session idle while its child ran and a reap killed the app-server with the
 * child inside it.
 *
 * Arms: positive — a running child puts `background_task` on the list; negative — a child whose end never arrives
 * and that has sent nothing for `CodexEventAdapter.SPAWNED_CHILD_LIVENESS_BOUND_MS` stops holding the session.
 */
import { afterEach, describe, expect, it, setSystemTime } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager, createManagedSession } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'
import { CodexAgent } from '../../../../shared/src/agent/codex-agent.ts'
import { CodexEventAdapter } from '../../../../shared/src/agent/backend/codex/event-adapter.ts'
import { cleanupModeState } from '../../../../shared/src/agent/mode-manager.ts'

const WS = 'ws-ua12-191-busy'
const SESS = 'session-ua12-191-busy'
const PARENT = 'parent-thread'
const CHILD = 'child-thread'
const roots: string[] = []

afterEach(() => {
  setSystemTime()
  cleanupModeState({ workspaceId: WS, sessionId: SESS })
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function rig() {
  const root = mkdtempSync(join(tmpdir(), 'ua12-191-busy-'))
  roots.push(root)
  const workspace = { id: WS, name: 'UA12.191', slug: 'ua12-191', rootPath: join(root, 'workspace'), createdAt: Date.now() }
  mkdirSync(workspace.rootPath, { recursive: true })
  const manager: SessionManager = createTestSessionManager()
  const managed = createManagedSession({ id: SESS }, workspace as never, { messagesLoaded: true, ephemeral: true })
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(`${WS}:${SESS}`, managed)

  const agent = new CodexAgent({
    provider: 'codex-runtime',
    workspace: { id: WS, name: 'UA12.191', rootPath: '/tmp/ua12-191', workspaceRootPath: '/tmp/ua12-191', sessionRootPath: '/tmp/ua12-191/sessions' } as never,
    session: { id: SESS, createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: '/tmp/ua12-191' } as never,
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

  const notify = (method: string, params: unknown) => internals.handleNotification(method, params)
  const spawn = () => {
    internals.turnSink = { push: () => {}, finish: () => {} }
    notify('item/completed', {
      threadId: PARENT, turnId: 'turn-1', completedAtMs: 0,
      item: { type: 'collabAgentToolCall', id: 'collab-spawn-1', tool: 'spawnAgent', status: 'completed', senderThreadId: PARENT, receiverThreadIds: [CHILD], prompt: 'check X', model: null },
    })
    notify('turn/started', { threadId: CHILD, turn: { id: 'child-turn-1' } })
    internals.turnSink = null // the parent's turn is over; the child was not waited for
  }
  const busy = () => (manager as unknown as {
    liveAgentBusyDomainsFor: (m: unknown) => Promise<readonly string[]>
  }).liveAgentBusyDomainsFor(managed)
  return { agent, spawn, notify, busy }
}

describe('UA12.191 — a codex spawn_agent child between turns holds the session against the reaper, bounded', () => {
  it('a running child puts background_task on the busy list; its turn/completed takes it off', async () => {
    const { agent, spawn, notify, busy } = rig()
    try {
      expect(await busy()).not.toContain('background_task')
      spawn()
      expect(await busy()).toContain('background_task')
      notify('turn/completed', { threadId: CHILD, turn: { id: 'child-turn-1', status: 'completed' } })
      expect(await busy()).not.toContain('background_task')
    } finally {
      agent.destroy()
    }
  })

  it('negative: a child whose end never arrives stops holding the session once it is silent past the bound', async () => {
    const { agent, spawn, busy } = rig()
    const start = Date.now()
    try {
      spawn()
      expect(await busy()).toContain('background_task')
      setSystemTime(new Date(start + CodexEventAdapter.SPAWNED_CHILD_LIVENESS_BOUND_MS + 1_000))
      expect(await busy()).not.toContain('background_task')
    } finally {
      agent.destroy()
    }
  })
})
