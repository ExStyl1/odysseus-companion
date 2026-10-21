/**
 * F1.244 — A MID-TURN MESSAGE WITH ATTACHMENTS IS QUEUED, NEVER STEERED.
 *
 * `redirect()` is a TEXT door on every runtime (`AgentBackend.redirect(message:
 * string)`): Pi sends `{ type: 'steer', message }`, Claude parks a string for
 * its PreToolUse hook, codex sends a text-only `turn/steer` input. So a steer
 * of a message that carries files hands the model the words and drops the
 * files — while the transcript row keeps the attachments and the composer
 * reads "accepted". The default is `'steer'` on every provider except
 * `nestor-cloud-agent`, so this was the ordinary path for a mid-turn send with
 * a file on Pi, Claude and codex alike.
 *
 * Reference: craft-agents-oss v0.13.4 `canSteerTextPayload` (Apache-2.0) —
 * "Text redirects cannot carry attachments or options that affect model
 * input", called at its mid-stream branch.
 *
 * The host is the one seam all three share, so the rows below drive the REAL
 * `SessionManager.sendMessage` and `sendQueuedNow` with one agent per runtime.
 * Each agent is built on its real prototype (`Object.create`, no subprocess),
 * so codex's own `redirectFallbackInterruptsTurn` answers for it, and its
 * `redirect` is replaced by a spy that WOULD accept — a steer it is never
 * offered is the property under test.
 */
import { describe, expect, it, mock } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { ClaudeAgent } from '../../../../shared/src/agent/claude-agent.ts'
import { PiAgent } from '../../../../shared/src/agent/pi-agent.ts'
import { CodexAgent } from '../../../../shared/src/agent/codex-agent.ts'
import { createManagedSession } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

const WORKSPACE_ID = 'ws-f1-244'

const RUNTIMES = [
  { name: 'pi', prototype: PiAgent.prototype },
  { name: 'claude', prototype: ClaudeAgent.prototype },
  { name: 'codex', prototype: CodexAgent.prototype },
] as const

const ATTACHMENTS = [{
  type: 'image',
  path: '/tmp/f1-244/screenshot.png',
  name: 'screenshot.png',
  mimeType: 'image/png',
  base64: 'aW1hZ2UtYnl0ZXM=',
  size: 11,
}]
const STORED_ATTACHMENTS = [{
  id: 'stored-1',
  type: 'image',
  name: 'screenshot.png',
  mimeType: 'image/png',
  size: 11,
  storedPath: '/tmp/f1-244/attachments/screenshot.png',
}]

interface QueueEntry {
  message: string
  messageId?: string
  attachments?: unknown[]
  storedAttachments?: unknown[]
}
interface TranscriptRow { id: string; role: string; content: string; isQueued?: boolean; attachments?: unknown[] }
interface Managed {
  id: string
  isProcessing: boolean
  agent: unknown
  messages: TranscriptRow[]
  messageQueue: QueueEntry[]
  wasInterrupted?: boolean
}

function rig(prototype: object, sessionId: string) {
  const sm = createTestSessionManager()
  const events: Array<{ type: string; status?: string }> = []
  sm.setEventSink(((...args: unknown[]) => { events.push(args[2] as { type: string; status?: string }) }) as never)
  const root = mkdtempSync(join(tmpdir(), 'f1-244-'))
  const managed = createManagedSession(
    { id: sessionId, name: 'F1.244' },
    { id: WORKSPACE_ID, name: 'F1.244', rootPath: root, createdAt: Date.now() } as never,
    { messagesLoaded: true },
  ) as unknown as Managed
  ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(
    encodeSessionKey({ workspaceId: WORKSPACE_ID, sessionId }),
    managed,
  )
  const redirect = mock((_message: string, _metadata?: unknown) => true)
  const agent = Object.create(prototype) as Record<string, unknown>
  agent.redirect = redirect
  agent.forceAbort = () => undefined
  agent.debug = () => undefined
  managed.agent = agent
  managed.isProcessing = true
  return { sm, managed, events, redirect }
}

function lastUserMessageStatus(events: Array<{ type: string; status?: string }>): string | undefined {
  return events.filter(event => event.type === 'user_message').at(-1)?.status
}

describe('F1.244 — sendMessage mid-turn: attachments are queued, text still steers', () => {
  for (const runtime of RUNTIMES) {
    it(`${runtime.name}: a message WITH attachments is queued with them and never offered to redirect()`, async () => {
      const h = rig(runtime.prototype, `attach-${runtime.name}`)
      await h.sm.sendMessage(h.managed.id, 'what is wrong in this screenshot?', ATTACHMENTS as never, STORED_ATTACHMENTS as never)

      // THE ASSERTION THIS FILE EXISTS FOR: the text door is never tried.
      expect(h.redirect).not.toHaveBeenCalled()
      expect(h.managed.messageQueue).toHaveLength(1)
      const entry = h.managed.messageQueue[0]!
      expect(entry.attachments).toBe(ATTACHMENTS)
      expect(entry.storedAttachments).toBe(STORED_ATTACHMENTS)
      const row = h.managed.messages.find(m => m.id === entry.messageId)!
      expect(row.isQueued).toBe(true)
      expect(lastUserMessageStatus(h.events)).toBe('queued')
      // Queued, not a failed steer: the running turn was not disturbed, so the
      // next turn must not be told its predecessor was cut off.
      expect(h.managed.wasInterrupted).not.toBe(true)
    })

    it(`${runtime.name}: CONTROL — a text-only message still steers exactly as before`, async () => {
      // Proves the rig resolves `'steer'` (no connection → the documented
      // fallback), so the arm above is not green because nothing steers here.
      const h = rig(runtime.prototype, `text-${runtime.name}`)
      await h.sm.sendMessage(h.managed.id, 'use the other API instead')

      expect(h.redirect).toHaveBeenCalledTimes(1)
      expect(h.redirect.mock.calls[0]![0]).toBe('use the other API instead')
      expect(h.managed.messageQueue).toHaveLength(0)
      expect(lastUserMessageStatus(h.events)).toBe('accepted')
    })
  }

  it('the queued attachment message replays WITH its attachments once the turn ends', async () => {
    const h = rig(ClaudeAgent.prototype, 'attach-replay')
    await h.sm.sendMessage(h.managed.id, 'and this log file', ATTACHMENTS as never, STORED_ATTACHMENTS as never)
    const queuedId = h.managed.messageQueue[0]!.messageId

    const replayed: unknown[][] = []
    ;(h.sm as unknown as { sendMessage: (...args: unknown[]) => Promise<void> }).sendMessage = async (...args: unknown[]) => {
      replayed.push(args)
    }
    h.managed.isProcessing = false
    ;(h.sm as unknown as { processNextQueuedMessage(id: string, ws: string): void })
      .processNextQueuedMessage(h.managed.id, WORKSPACE_ID)
    await new Promise<void>(resolve => setImmediate(resolve))

    expect(replayed).toHaveLength(1)
    const [sessionId, message, attachments, storedAttachments, , existingMessageId] = replayed[0]!
    expect(sessionId).toBe(h.managed.id)
    expect(message).toBe('and this log file')
    expect(attachments).toBe(ATTACHMENTS)
    expect(storedAttachments).toBe(STORED_ATTACHMENTS)
    expect(existingMessageId).toBe(queuedId)
  })
})

describe('F1.244 — sendQueuedNow ("Steer" on a queued row) never steers a row that carries files', () => {
  for (const runtime of RUNTIMES) {
    it(`${runtime.name}: an attachment row stays queued, in place, with its attachments`, async () => {
      const h = rig(runtime.prototype, `queued-attach-${runtime.name}`)
      // Two rows queued behind a running turn: the text one first, the file one
      // second — so "stays in place" is observable as an index, not a length.
      h.managed.messageQueue.push(
        { message: 'first, text only', messageId: 'q-text' },
        { message: 'second, with a file', messageId: 'q-file', attachments: ATTACHMENTS, storedAttachments: STORED_ATTACHMENTS },
      )
      h.managed.messages.push(
        { id: 'q-text', role: 'user', content: 'first, text only', isQueued: true },
        { id: 'q-file', role: 'user', content: 'second, with a file', isQueued: true, attachments: STORED_ATTACHMENTS },
      )

      await h.sm.sendQueuedNow(h.managed.id, 'q-file', WORKSPACE_ID)

      expect(h.redirect).not.toHaveBeenCalled()
      expect(h.managed.messageQueue.map(entry => entry.messageId)).toEqual(['q-text', 'q-file'])
      expect(h.managed.messageQueue[1]!.attachments).toBe(ATTACHMENTS)
      expect(h.managed.messageQueue[1]!.storedAttachments).toBe(STORED_ATTACHMENTS)
      expect(h.managed.messages.find(m => m.id === 'q-file')!.isQueued).toBe(true)
    })
  }

  it('CONTROL — a text-only queued row still steers and leaves the queue', async () => {
    const h = rig(PiAgent.prototype, 'queued-text')
    h.managed.messageQueue.push({ message: 'steer me', messageId: 'q-text' })
    h.managed.messages.push({ id: 'q-text', role: 'user', content: 'steer me', isQueued: true })

    await h.sm.sendQueuedNow(h.managed.id, 'q-text', WORKSPACE_ID)

    expect(h.redirect).toHaveBeenCalledTimes(1)
    expect(h.redirect.mock.calls[0]![0]).toBe('steer me')
    expect(h.managed.messageQueue).toHaveLength(0)
    expect(h.managed.messages.find(m => m.id === 'q-text')!.isQueued).toBe(false)
  })
})

/**
 * F1.338 — FIFO: a steerable send never overtakes a queued payload that cannot
 * be steered.
 *
 * Measured before this row (WJ-gg verifier probe P6, `work/wj-gg-verify/`): after
 * F1.244 queued an attachment message, a later text-only send was STEERED into the
 * running turn, so the model read "what is on line 3 of it?" before the screenshot
 * it refers to. DECIDED by the controller (2026-09-23): while the queue holds a
 * payload that cannot be steered, a later steerable send queues behind it — order
 * is what the user typed. The scope is exactly that: a text-only row the user
 * queued on purpose does not hold a later steer back.
 */
describe('F1.338 — a later text send queues behind a queued attachment message', () => {
  for (const runtime of RUNTIMES) {
    it(`${runtime.name}: the text follow-up is queued BEHIND the file, never steered past it`, async () => {
      const h = rig(runtime.prototype, `fifo-${runtime.name}`)
      await h.sm.sendMessage(h.managed.id, 'here is the screenshot', ATTACHMENTS as never, STORED_ATTACHMENTS as never)
      await h.sm.sendMessage(h.managed.id, 'what is on line 3 of it?')

      expect(h.redirect).not.toHaveBeenCalled()
      expect(h.managed.messageQueue.map(entry => entry.message)).toEqual(['here is the screenshot', 'what is on line 3 of it?'])
      expect(lastUserMessageStatus(h.events)).toBe('queued')
      // Queued by order, not a failed steer: nothing disturbed the running turn.
      expect(h.managed.wasInterrupted).not.toBe(true)
    })
  }

  it('a queued WORKFLOW invocation holds a later text send back the same way', async () => {
    const h = rig(PiAgent.prototype, 'fifo-workflow')
    h.managed.messageQueue.push({ message: '/my-workflow go', messageId: 'q-wf', workflowInvocation: { name: 'my-workflow' } } as never)
    await h.sm.sendMessage(h.managed.id, 'and then summarise it')

    expect(h.redirect).not.toHaveBeenCalled()
    expect(h.managed.messageQueue.map(entry => entry.message)).toEqual(['/my-workflow go', 'and then summarise it'])
  })

  it('CONTROL — a text-only row queued ahead (the user\'s own queue choice) does not hold a later steer back', async () => {
    const h = rig(ClaudeAgent.prototype, 'fifo-text-ahead')
    h.managed.messageQueue.push({ message: 'do this afterwards', messageId: 'q-text' })
    await h.sm.sendMessage(h.managed.id, 'stop, use the v2 endpoint')

    expect(h.redirect).toHaveBeenCalledTimes(1)
    expect(h.redirect.mock.calls[0]![0]).toBe('stop, use the v2 endpoint')
    expect(h.managed.messageQueue.map(entry => entry.message)).toEqual(['do this afterwards'])
  })
})

/**
 * F1.337 — "Steer" on a queued WORKFLOW-invocation row keeps it queued.
 *
 * Measured before this row (WJ-gg verifier probe P1): `sendQueuedNow` on a queued
 * workflow row while a turn ran called `redirect()` with the EXPANDED body and
 * spliced the row out, so the host-resolved `workflowInvocation` was dropped and
 * the workflow command reached the model as prose. `sendMessage` already queues
 * such a send first (rule 1 of `effectiveMidStreamBehavior`); the queue door now
 * applies the same rule, through the same predicate the FIFO reads.
 */
describe('F1.337 — sendQueuedNow never steers a workflow invocation as text', () => {
  for (const runtime of RUNTIMES) {
    it(`${runtime.name}: a queued workflow row stays queued, in place, with its invocation`, async () => {
      const h = rig(runtime.prototype, `queued-workflow-${runtime.name}`)
      const invocation = { name: 'my-workflow', args: { input: 'go' } }
      h.managed.messageQueue.push(
        { message: 'first, text only', messageId: 'q-text' },
        { message: '/my-workflow go', messageId: 'q-wf', modelMessage: 'expanded workflow body', workflowInvocation: invocation } as never,
      )
      h.managed.messages.push(
        { id: 'q-text', role: 'user', content: 'first, text only', isQueued: true },
        { id: 'q-wf', role: 'user', content: '/my-workflow go', isQueued: true },
      )

      await h.sm.sendQueuedNow(h.managed.id, 'q-wf', WORKSPACE_ID)

      expect(h.redirect).not.toHaveBeenCalled()
      expect(h.managed.messageQueue.map(entry => entry.messageId)).toEqual(['q-text', 'q-wf'])
      expect((h.managed.messageQueue[1] as { workflowInvocation?: unknown }).workflowInvocation).toBe(invocation)
      expect(h.managed.messages.find(m => m.id === 'q-wf')!.isQueued).toBe(true)
    })
  }
})
