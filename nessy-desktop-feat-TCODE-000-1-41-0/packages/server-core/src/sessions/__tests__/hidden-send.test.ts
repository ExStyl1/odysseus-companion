/**
 * UB2.14 — a HIDDEN send (`SendMessageOptions.hidden`) drives a turn but never
 * renders: the host stamps `hidden: true` on the user row it persists and
 * announces, and the renderer's `groupMessagesByTurn` drops the row (pinned in
 * `packages/ui/src/components/chat/__tests__/turn-lifecycle.test.ts`).
 *
 * Ported from craft-agents-oss v0.15.1 (`SessionManager.sendMessage`'s
 * `...(options?.hidden ? { hidden: true } : {})`, `turnFromUser =
 * !options?.hidden`, the `lastMessageRole` skip; `canSteerTextPayload`'s
 * `hidden: false` neutrality from `midstream-queue.test.ts`; Apache-2.0). The
 * one producer is the source-activation auto-retry
 * (`source-activated-auto-retry.test.ts` pins that it sends `{ hidden: true }`).
 *
 * Every arm drives the REAL `sendMessage`; only the agent below it is a fake,
 * which records the text the model was handed.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { messageToStored, storedToMessage, type AgentEvent } from '@nessy-agent/core/types'
import type { SessionEvent } from '@nessy-agent/shared/protocol'
import { createManagedSession } from '../SessionManager.ts'
import { canSteerTextPayload } from '../mid-stream-interruption.ts'
import { createTestSessionManager } from './test-session-manager.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const tick = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms) })

interface Row { id: string; role: string; content: string; hidden?: true; isQueued?: boolean }
interface Managed {
  id: string
  isProcessing: boolean
  messages: Row[]
  messageQueue: Array<{ message: string; options?: { hidden?: boolean } }>
  lastMessageRole?: string
  turnFromUser?: boolean
  pendingActivationResend?: string
}

function rig(sessionId: string) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'sm-ub2-14-'))
  roots.push(stateRoot)
  const workspace = { id: 'ws-ub2-14', name: 'UB2.14', slug: 'ub2-14', rootPath: join(stateRoot, 'workspace'), createdAt: Date.now() }
  mkdirSync(workspace.rootPath, { recursive: true })

  const manager = createTestSessionManager()
  const managed = createManagedSession({ id: sessionId }, workspace as never, { messagesLoaded: true, ephemeral: true })
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(`${workspace.id}:${managed.id}`, managed)

  const sent: SessionEvent[] = []
  manager.setEventSink(((_channel: unknown, _target: unknown, event: SessionEvent) => { sent.push(event) }) as Parameters<typeof manager.setEventSink>[0])

  const internals = manager as unknown as Record<string, unknown>
  internals.persistSession = () => {}
  manager.flushSession = async () => {}
  internals.createCapabilityTurn = async () => ({ snapshot: { leaseId: 'ub2-14-lease' }, runtime: { view: { sources: [] }, materializer: {} } })
  internals.createRetainedCapabilityLease = () => ({ retain: () => () => {}, release: () => {} })

  /** What the MODEL was handed, one entry per turn. */
  const modelInputs: string[] = []
  const steered: string[] = []
  const agent = {
    isProcessing: () => false,
    setAllSources: () => {},
    setSourceServers: async () => {},
    getModel: () => 'test-model',
    getSessionId: () => undefined,
    setAutomationSystem: () => {},
    setCapabilityTurnRuntime: () => {},
    drainAutomationEvents: async () => {},
    forceAbort: () => {},
    interruptForHandoff: () => {},
    takePendingSteers: () => [],
    redirect: (text: string) => { steered.push(text); return true },
    dispose: () => {},
    updateWorkingDirectory: () => {},
    updateSdkCwd: () => {},
    chat: async function* (message: string) {
      modelInputs.push(message)
      yield { type: 'text_delta', text: 'answer', turnId: `T${modelInputs.length}` } as AgentEvent
      yield { type: 'complete' } as AgentEvent
    },
  }
  internals.getOrCreateAgent = async () => { (managed as unknown as { agent: unknown }).agent = agent; return agent }

  const send = (text: string, options?: { hidden?: boolean }) =>
    manager.sendMessage(managed.id, text, undefined, undefined, options, undefined, undefined, undefined, { workspaceId: workspace.id })
  const userMessageEvents = () => sent.filter((event): event is Extract<SessionEvent, { type: 'user_message' }> => event.type === 'user_message')
  return { manager, managed: managed as unknown as Managed, agent, modelInputs, steered, send, userMessageEvents, cleanup: () => manager.cleanup() }
}

describe('UB2.14 — a hidden send drives the turn and its row is hidden', () => {
  it('POSITIVE — the model receives the message; the persisted row and the user_message event carry hidden: true', async () => {
    const r = rig('ub2-14-hidden')
    try {
      await r.send('list my repos\n\n[github activated]', { hidden: true })
      await tick(50)

      // It DROVE a turn: the model was handed the text.
      expect(r.modelInputs).toHaveLength(1)
      expect(r.modelInputs[0]).toContain('list my repos\n\n[github activated]')

      const row = r.managed.messages.find(m => m.role === 'user')!
      expect(row.hidden).toBe(true)
      // The persisted shape keeps it (the jsonl writer's mapper), and a reload restores it.
      const stored = messageToStored(row as never)
      expect(stored.hidden).toBe(true)
      expect(storedToMessage(stored).hidden).toBe(true)
      // The renderer is told the row is hidden.
      expect(r.userMessageEvents().map(event => event.message.hidden)).toEqual([true])
      // Not the user's: no session-list role, no user-begun turn.
      expect(r.managed.lastMessageRole).not.toBe('user')
      expect(r.managed.turnFromUser).toBe(false)
    } finally {
      r.cleanup()
    }
  })

  it('CONTROL — a normal send\'s row carries no hidden key, and the turn is the user\'s', async () => {
    const r = rig('ub2-14-visible')
    try {
      await r.send('list my repos')
      await tick(50)

      expect(r.modelInputs).toHaveLength(1)
      const row = r.managed.messages.find(m => m.role === 'user')!
      expect('hidden' in row).toBe(false)
      expect('hidden' in messageToStored(row as never)).toBe(false)
      expect(r.userMessageEvents().map(event => event.message.hidden)).toEqual([undefined])
      expect(r.managed.lastMessageRole).toBe('user')
      expect(r.managed.turnFromUser).toBe(true)
    } finally {
      r.cleanup()
    }
  })

  it('BOUNDARY — mid-turn, a hidden send is queued (never steered) and its queued row is hidden too', async () => {
    const r = rig('ub2-14-mid-turn')
    try {
      r.managed.isProcessing = true
      ;(r.managed as unknown as { agent: unknown }).agent = r.agent
      await r.send('query the issues\n\n[linear activated]', { hidden: true })

      expect(r.steered).toEqual([])
      expect(r.managed.messageQueue.map(entry => entry.options?.hidden)).toEqual([true])
      const row = r.managed.messages.find(m => m.role === 'user')!
      expect({ hidden: row.hidden, isQueued: row.isQueued }).toEqual({ hidden: true, isQueued: true })
      expect(r.userMessageEvents().map(event => [event.status, event.message.hidden])).toEqual([['queued', true]])
    } finally {
      r.cleanup()
    }
  })

  it('the server\'s own activation retry is recognised once: the field clears and the retried turn\'s origin is kept', async () => {
    const r = rig('ub2-14-activation-resend')
    try {
      await r.send('list my repos')
      await tick(50)
      expect(r.managed.turnFromUser).toBe(true)

      const retry = 'list my repos\n\n[github activated]'
      r.managed.pendingActivationResend = retry
      await r.send(retry, { hidden: true })
      await tick(50)

      expect(r.modelInputs).toHaveLength(2)
      expect(r.managed.pendingActivationResend).toBeUndefined()
      // The retry continues the USER's request: the origin of the turn it retries stands.
      expect(r.managed.turnFromUser).toBe(true)
      expect(r.managed.messages.filter(m => m.role === 'user').map(m => m.hidden)).toEqual([undefined, true])
    } finally {
      r.cleanup()
    }
  })
})

describe('UB2.14 — canSteerTextPayload treats hidden: false as a plain send', () => {
  it('hidden: false steers like no option; hidden: true takes the queue', () => {
    expect(canSteerTextPayload(undefined, undefined, { hidden: false, optimisticMessageId: 'id' })).toBe(true)
    expect(canSteerTextPayload(undefined, undefined, { hidden: true })).toBe(false)
  })
})
