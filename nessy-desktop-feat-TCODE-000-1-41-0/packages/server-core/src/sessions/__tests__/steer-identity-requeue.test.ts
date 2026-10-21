/**
 * F1.238 — the host re-queues an undelivered steer AS THE MESSAGE IT WAS.
 *
 * Measured at HEAD before this row (`SessionManager.ts`): `sendMessage` pushed
 * every steered id onto `pendingSteeredMessageIds`, nothing popped the list when
 * a steer was DELIVERED (no backend reports one), and the `steer_undelivered`
 * case did `pendingSteeredMessageIds.shift()`. So with A delivered and B refused
 * the host flipped A — already delivered — back to queued and replayed B's text
 * under A's id, while B went on showing as delivered. A Stop or a handoff with
 * an accepted-but-undelivered Claude steer re-queued nothing at all: the
 * backend dropped it and emitted no event.
 *
 * The rows below pin the three resolutions — the backend's own `messageId`
 * (Claude), the exact steer text (codex names only text today), the
 * synchronous `takePendingSteers()` transfer at a Stop, a handoff and the
 * turn's `complete` — and the two runtimes that must NOT change: Pi (native
 * steering, never reports) and codex (no `takePendingSteers`).
 */
import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '@nessy-agent/core/types'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { createManagedSession } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

const WORKSPACE_ID = 'ws-f1-238'

interface QueueEntry { message: string; messageId?: string; modelMessage?: string }
interface Row { id: string; role: string; content: string; isQueued?: boolean }
interface Managed {
  id: string
  isProcessing: boolean
  agent: unknown
  messages: Row[]
  messageQueue: QueueEntry[]
  queuePaused: boolean
  wasInterrupted?: boolean
}

/** A backend that holds steers the way Claude's PreToolUse emulation does. */
function claudeShapedAgent() {
  const held: Array<{ message: string; messageId?: string }> = []
  const redirectCalls: Array<[string, { messageId?: string } | undefined]> = []
  return {
    held,
    redirectCalls,
    agent: {
      isProcessing: () => true,
      redirect(message: string, metadata?: { messageId?: string }) {
        redirectCalls.push([message, metadata])
        held.push({ message, ...(metadata?.messageId === undefined ? {} : { messageId: metadata.messageId }) })
        return true
      },
      takePendingSteers: () => held.splice(0),
      forceAbort: () => undefined,
      interruptForHandoff: () => undefined,
    },
  }
}

function rig(sessionId: string, agent: unknown) {
  const sm = createTestSessionManager()
  const events: Array<{ type: string; status?: string }> = []
  sm.setEventSink(((...args: unknown[]) => { events.push(args[2] as { type: string }) }) as never)
  const root = mkdtempSync(join(tmpdir(), 'f1-238-'))
  const managed = createManagedSession(
    { id: sessionId, name: 'F1.238' },
    { id: WORKSPACE_ID, name: 'F1.238', rootPath: root, createdAt: Date.now() } as never,
    { messagesLoaded: true },
  ) as unknown as Managed
  ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(
    encodeSessionKey({ workspaceId: WORKSPACE_ID, sessionId }),
    managed,
  )
  managed.agent = agent
  managed.isProcessing = true
  const internals = sm as unknown as {
    processEvent(managed: unknown, event: AgentEvent): Promise<void>
    beginAuthRequest(managed: unknown, request: unknown): Promise<void>
  }
  return { sm, managed, events, internals }
}

async function steer(h: ReturnType<typeof rig>, text: string): Promise<string> {
  await h.sm.sendMessage(h.managed.id, text)
  const row = h.managed.messages.filter(m => m.role === 'user').at(-1)!
  expect(row.content).toBe(text)
  expect(row.isQueued).toBe(false)
  return row.id
}

describe('F1.238 — a refusal re-queues ITS message, never the oldest one', () => {
  it('Claude: A delivered, B refused — only B is re-queued, under B\'s id', async () => {
    const backend = claudeShapedAgent()
    const h = rig('claude-a-b', backend.agent)
    const a = await steer(h, 'A: use the v2 endpoint')
    const b = await steer(h, 'B: and keep the old one as a fallback')
    // A reached the model at a tool call (the backend drained it) — no event says so.
    backend.held.splice(0, 1)

    await h.internals.processEvent(h.managed, { type: 'steer_undelivered', message: 'B: and keep the old one as a fallback', messageId: b } as AgentEvent)

    expect(h.managed.messageQueue.map(entry => entry.messageId)).toEqual([b])
    expect(h.managed.messageQueue[0]!.message).toBe('B: and keep the old one as a fallback')
    // THE DEFECT: A (delivered) was flipped back to queued, B stayed "delivered".
    expect(h.managed.messages.find(m => m.id === a)!.isQueued).toBe(false)
    expect(h.managed.messages.find(m => m.id === b)!.isQueued).toBe(true)
  })

  it('the backend was TOLD each steer\'s id, so it can name it back', async () => {
    const backend = claudeShapedAgent()
    const h = rig('claude-told', backend.agent)
    const a = await steer(h, 'first')
    expect(backend.redirectCalls[0]![1]).toEqual({ messageId: a })
  })

  it('codex (the refusal names only the TEXT): A delivered, B refused — matched on B\'s text', async () => {
    const redirectCalls: string[] = []
    const codexShaped = {
      isProcessing: () => true,
      redirect(message: string) { redirectCalls.push(message); return true },
      forceAbort: () => undefined,
      // Declared inert, exactly as `CodexAgent.redirectFallbackInterruptsTurn` is.
      redirectFallbackInterruptsTurn: () => false,
    }
    const h = rig('codex-a-b', codexShaped)
    const a = await steer(h, 'A: rename the flag')
    const b = await steer(h, 'B: and update the docs')

    await h.internals.processEvent(h.managed, { type: 'steer_undelivered', message: 'B: and update the docs' })

    expect(h.managed.messageQueue.map(entry => entry.messageId)).toEqual([b])
    expect(h.managed.messages.find(m => m.id === a)!.isQueued).toBe(false)
    expect(h.managed.messages.find(m => m.id === b)!.isQueued).toBe(true)
    expect(h.managed.wasInterrupted).not.toBe(true)
  })

  it('the same refusal reported twice queues the message once', async () => {
    const backend = claudeShapedAgent()
    const h = rig('claude-twice', backend.agent)
    const b = await steer(h, 'only once')
    const event = { type: 'steer_undelivered', message: 'only once', messageId: b } as AgentEvent
    await h.internals.processEvent(h.managed, event)
    await h.internals.processEvent(h.managed, event)
    expect(h.managed.messageQueue.map(entry => entry.messageId)).toEqual([b])
  })
})

describe('F1.238 — Stop and handoff hand accepted steers back instead of dropping them', () => {
  it('Stop with one accepted-but-undelivered steer re-queues exactly that message, under its own id, paused', async () => {
    const backend = claudeShapedAgent()
    const h = rig('claude-stop', backend.agent)
    const a = await steer(h, 'A: delivered at a tool call')
    backend.held.splice(0, 1)
    const b = await steer(h, 'B: still waiting for a tool call')

    await h.sm.cancelProcessing(h.managed.id, true, WORKSPACE_ID)

    expect(h.managed.messageQueue.map(entry => entry.messageId)).toEqual([b])
    expect(h.managed.messages.find(m => m.id === b)!.isQueued).toBe(true)
    // A delivered steer is never flipped back to queued.
    expect(h.managed.messages.find(m => m.id === a)!.isQueued).toBe(false)
    // Like any message queued at a Stop, it waits for the user rather than draining.
    expect(h.managed.queuePaused).toBe(true)
    expect(backend.held).toEqual([])
  })

  it('an auth handoff re-queues the accepted steer under its own id', async () => {
    const backend = claudeShapedAgent()
    const h = rig('claude-handoff', backend.agent)
    const b = await steer(h, 'B: accepted before the card')

    await h.internals.beginAuthRequest(h.managed, {
      type: 'credential',
      requestId: 'auth-f1-238',
      sourceSlug: 'example',
      sourceName: 'Example',
      mode: 'bearer',
    })

    expect(h.managed.messageQueue.map(entry => entry.messageId)).toEqual([b])
    expect(h.managed.messages.find(m => m.id === b)!.isQueued).toBe(true)
  })

  it('CONTROL — Pi (native steering, nothing to take) and codex are untouched by a Stop', async () => {
    for (const shape of [
      { name: 'pi', agent: { isProcessing: () => true, redirect: () => true, forceAbort: () => undefined } },
      { name: 'codex', agent: { isProcessing: () => true, redirect: () => true, forceAbort: () => undefined, redirectFallbackInterruptsTurn: () => false } },
    ]) {
      const h = rig(`${shape.name}-stop`, shape.agent)
      const a = await steer(h, `${shape.name}: steered`)
      await h.sm.cancelProcessing(h.managed.id, true, WORKSPACE_ID)
      expect(h.managed.messageQueue).toEqual([])
      expect(h.managed.messages.find(m => m.id === a)!.isQueued).toBe(false)
    }
  })
})

describe('F1.238 — a turn that ENDS with a steer still held re-queues it before anything replays', () => {
  it('a reason-bearing complete (a budget cap) does not swallow the accepted steer', async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'f1-238-complete-'))
    const workspace = { id: WORKSPACE_ID, name: 'F1.238', slug: 'f1-238', rootPath: join(stateRoot, 'workspace'), createdAt: Date.now() }
    mkdirSync(workspace.rootPath, { recursive: true })
    const sm = createTestSessionManager()
    const managed = createManagedSession({ id: 'claude-complete' }, workspace as never, { messagesLoaded: true, ephemeral: true }) as unknown as Managed
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(encodeSessionKey({ workspaceId: WORKSPACE_ID, sessionId: managed.id }), managed)
    const events: Array<{ type: string }> = []
    sm.setEventSink(((...args: unknown[]) => { events.push(args[2] as { type: string }) }) as never)
    const internals = sm as unknown as Record<string, unknown>
    internals.persistSession = () => {}
    sm.flushSession = async () => {}
    internals.acquireCapabilityTurn = async () => () => {}
    internals.createCapabilityTurn = async () => ({ snapshot: { leaseId: 'f1-238-lease' }, runtime: { view: { sources: [] }, materializer: {} } })
    internals.createRetainedCapabilityLease = () => ({ retain: () => () => {}, release: () => {} })

    const held: Array<{ message: string; messageId?: string }> = []
    const chatMessages: string[] = []
    let releaseFirstTurn!: () => void
    const firstTurnGate = new Promise<void>(resolve => { releaseFirstTurn = resolve })
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
      dispose: () => {},
      updateWorkingDirectory: () => {},
      updateSdkCwd: () => {},
      generateTitle: async () => null,
      redirect(message: string, metadata?: { messageId?: string }) {
        held.push({ message, ...(metadata?.messageId === undefined ? {} : { messageId: metadata.messageId }) })
        return true
      },
      takePendingSteers: () => held.splice(0),
      chat: async function* (message: string) {
        chatMessages.push(message)
        if (chatMessages.length === 1) {
          await firstTurnGate
          yield { type: 'complete', terminalReason: 'max_budget_usd' } as AgentEvent
          return
        }
        yield { type: 'complete' } as AgentEvent
      },
    }
    internals.getOrCreateAgent = async () => {
      managed.agent = agent
      return agent
    }

    try {
      const first = sm.sendMessage(managed.id, 'do the work', undefined, undefined, undefined, undefined, undefined, undefined, { workspaceId: WORKSPACE_ID })
      const deadline = Date.now() + 5_000
      while (!managed.isProcessing || chatMessages.length === 0) {
        if (Date.now() > deadline) throw new Error('the first turn never started')
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      await sm.sendMessage(managed.id, 'and also the changelog', undefined, undefined, undefined, undefined, undefined, undefined, { workspaceId: WORKSPACE_ID })
      const steered = managed.messages.filter(m => m.role === 'user').at(-1)!
      expect(steered.isQueued).toBe(false)
      releaseFirstTurn()
      await first
      // Bounded well inside the case budget, so a missing replay is an
      // assertion failure below rather than a timeout that names nothing.
      const replayDeadline = Date.now() + 1_500
      while (chatMessages.length < 2) {
        if (Date.now() > replayDeadline) break
        await new Promise(resolve => setTimeout(resolve, 5))
      }

      // THE DEFECT: the cap's `complete` ended the turn and the steer — accepted,
      // shown as delivered — was never sent.
      expect(chatMessages).toHaveLength(2)
      expect(chatMessages[1]).toContain('and also the changelog')
      // Replayed AS the transcript message it was, not as a second copy of it.
      expect(managed.messages.filter(m => m.role === 'user' && m.content === 'and also the changelog')).toHaveLength(1)
      expect(held).toEqual([])
    } finally {
      sm.cleanup()
    }
  }, 20_000)
})
