/**
 * F1.800 (half 2) — an error the chat generator THROWS reaches the transcript
 * that survives a reload, not only the live renderer.
 *
 * `processEvent`'s `case 'error'` records a yielded `error` event as a
 * `role: 'error'` row (`appendManagedMessage`) and sends it. The chat loop's own
 * `catch` — where every THROWN runtime failure lands (the codex session in an
 * unknown mode threw `Cannot read properties of undefined (reading
 * 'approval_policy')`, release sitting SIT-r) — only sent the live event, so a
 * reload, a refetch or a second client saw one unanswered user message: the same
 * loss P2.98 fixed for the terminal verdict.
 *
 * Driven on the real `sendMessage` loop over a stub agent whose generator throws
 * (the rig of `late-abort-ends-only-its-turn.test.ts`). CONTROL: a yielded
 * `error` is recorded ONCE, as before — the new row is only the thrown path's.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '@nessy-agent/core/types'
import type { SessionEvent } from '@nessy-agent/shared/protocol'
import { createManagedSession } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

async function rig(sessionId: string, chat: () => AsyncGenerator<AgentEvent>) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'sm-f1800-'))
  roots.push(stateRoot)
  const workspace = { id: 'ws-f1800', name: 'F1.800', slug: 'f1800', rootPath: join(stateRoot, 'workspace'), createdAt: Date.now() }
  mkdirSync(workspace.rootPath, { recursive: true })

  const manager = createTestSessionManager()
  const managed = createManagedSession({ id: sessionId }, workspace as never, { messagesLoaded: true, ephemeral: true })
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(`${workspace.id}:${managed.id}`, managed)

  const sent: SessionEvent[] = []
  manager.setEventSink(((_channel: unknown, _target: unknown, event: SessionEvent) => { sent.push(event) }) as Parameters<typeof manager.setEventSink>[0])

  const internals = manager as unknown as Record<string, unknown>
  internals.persistSession = () => {}
  manager.flushSession = async () => {}
  internals.acquireCapabilityTurn = async () => () => {}
  internals.createCapabilityTurn = async () => ({ snapshot: { leaseId: 'f1800-lease' }, runtime: { view: { sources: [] }, materializer: {} } })
  internals.createRetainedCapabilityLease = () => ({ retain: () => () => {}, release: () => {} })

  const agent = {
    isProcessing: () => true,
    setAllSources: () => {},
    setSourceServers: async () => {},
    getModel: () => 'test-model',
    getSessionId: () => undefined,
    setAutomationSystem: () => {},
    setCapabilityTurnRuntime: () => {},
    drainAutomationEvents: async () => {},
    forceAbort: () => {},
    interruptForHandoff: () => {},
    dispose: () => {},
    updateWorkingDirectory: () => {},
    updateSdkCwd: () => {},
    chat,
  }
  internals.getOrCreateAgent = async () => { managed.agent = agent as never; return agent }

  await manager.sendMessage(managed.id, 'hello', undefined, undefined, undefined, undefined, undefined, undefined, { workspaceId: workspace.id })
  const errorRows = (managed.messages as Array<{ role: string; content: string }>).filter(message => message.role === 'error')
  return { manager, managed, sent, errorRows }
}

const THROWN = "Cannot read properties of undefined (reading 'approval_policy')"

describe('F1.800 — a thrown chat error is recorded in the transcript', () => {
  it('the generator throws at once → one `role: error` row with the message, and the turn ends', async () => {
    // Throws while computing its first event, before yielding anything — the codex shape.
    const firstEvent = (): AgentEvent => { throw new TypeError(THROWN) }
    const r = await rig('f1800-thrown', async function* () {
      yield firstEvent()
    })
    try {
      expect(r.errorRows.map(row => row.content)).toEqual([THROWN])
      expect(r.sent.filter(event => event.type === 'error').map(event => (event as { error: string }).error)).toEqual([THROWN])
      expect(r.managed.isProcessing).toBe(false)
    } finally {
      r.manager.cleanup()
    }
  })

  it('CONTROL — a YIELDED error is recorded once, as before (the new row is only the thrown path\'s)', async () => {
    const r = await rig('f1800-yielded', async function* () {
      yield { type: 'error', message: 'upstream refused' } as AgentEvent
      yield { type: 'complete' } as AgentEvent
    })
    try {
      expect(r.errorRows.map(row => row.content)).toEqual(['upstream refused'])
    } finally {
      r.manager.cleanup()
    }
  })
})
