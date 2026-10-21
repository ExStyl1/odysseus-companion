/**
 * F1.298 — `text_discard` at the host: the failed attempt's queued deltas are
 * DISCARDED, never flushed, and the event reaches the renderer.
 *
 * `queueDelta` holds up to `DELTA_BATCH_INTERVAL_MS` of assistant text for a
 * timer to send. A failed Pi attempt's last tokens can still be in that batch
 * when the adapter says the partial is void; flushing them would put failed text
 * on the wire AFTER the discard and re-create the bubble the renderer just
 * removed. Ported from craft-agents-oss v0.13.4's SessionManager arm
 * (`processEvent` `case 'text_discard'`, Apache-2.0): cancel the batch, clear
 * the streaming residue for that turn, forward the event.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { SESSIONS_DIR } from '@nessy-agent/shared/workspaces'
import type { SessionEvent } from '@nessy-agent/shared/protocol'
import { createManagedSession, type SessionManager } from '../SessionManager'
import { createTestSessionManager } from './test-session-manager'

const managers: SessionManager[] = []

afterEach(() => {
  for (const manager of managers.splice(0)) manager.cleanup()
  rmSync(join(SESSIONS_DIR, 'ws_test'), { recursive: true, force: true })
})

type Internals = {
  processEvent(managed: unknown, event: Record<string, unknown>): Promise<void>
  pendingDeltas: Map<string, unknown>
  deltaFlushTimers: Map<string, unknown>
}

function setUp(sessionId: string) {
  const manager = createTestSessionManager()
  managers.push(manager)
  const sent: SessionEvent[] = []
  manager.setEventSink((_channel, _target, event) => { sent.push(event as SessionEvent) })
  const managed = createManagedSession({ id: sessionId }, {
    id: 'ws_test',
    name: 'Test Workspace',
    rootPath: `/tmp/nessy-${sessionId}`,
    createdAt: 1,
  } as never, { messagesLoaded: true })
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(`ws_test:${sessionId}`, managed)
  return { managed, sent, internals: manager as unknown as Internals }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('F1.298 — text_discard cancels the failed attempt\'s delta batch', () => {
  it('the queued failed text never reaches the wire, the discard does, and the retried text streams after it', async () => {
    const { managed, sent, internals } = setUp('f1298-discard')
    await internals.processEvent(managed, { type: 'text_delta', text: 'Failed partial', turnId: 'pi-turn-1__m0' })
    await internals.processEvent(managed, { type: 'text_discard', turnId: 'pi-turn-1__m0' })
    // Well past the 50 ms batch timer: a surviving timer would have flushed by now.
    await sleep(200)
    expect(sent.filter(event => event.type === 'text_delta')).toEqual([])
    expect(sent.filter(event => event.type === 'text_discard'))
      .toEqual([{ type: 'text_discard', sessionId: 'f1298-discard', turnId: 'pi-turn-1__m0' }])
    expect((managed as { streamingText: string }).streamingText).toBe('')
    expect(internals.pendingDeltas.size).toBe(0)
    expect(internals.deltaFlushTimers.size).toBe(0)

    await internals.processEvent(managed, { type: 'text_delta', text: 'Full answer', turnId: 'pi-turn-1__m0' })
    await sleep(200)
    const types = sent.map(event => event.type)
    expect(types.indexOf('text_discard')).toBeLessThan(types.indexOf('text_delta'))
    expect(sent.filter(event => event.type === 'text_delta').map(event => (event as { delta: string }).delta)).toEqual(['Full answer'])
  })

  it('CONTROL — text already flushed stays sent; only the pending batch is cancelled', async () => {
    const { managed, sent, internals } = setUp('f1298-flushed')
    await internals.processEvent(managed, { type: 'text_delta', text: 'Already on the wire', turnId: 'pi-turn-1__m0' })
    await sleep(200)
    await internals.processEvent(managed, { type: 'text_discard', turnId: 'pi-turn-1__m0' })
    expect(sent.map(event => event.type)).toEqual(['text_delta', 'text_discard'])
  })
})
