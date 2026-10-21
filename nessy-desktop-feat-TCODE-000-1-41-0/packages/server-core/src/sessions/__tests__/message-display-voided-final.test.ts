/**
 * F1.473 — a voided assistant message still gets its ONE `final: true` MessageDisplay batch.
 *
 * hooks.md#messagedisplay-input: "`final` | `true` on the message's last batch. Each message
 * has exactly one final batch", and "the final batch's delta is empty when the message ends
 * on a newline, so treat `final`, not a non-empty delta, as the end-of-message signal". F1.298
 * dropped the display cursor on `text_discard` exactly as a turn start drops a stale one after
 * an abort, so both voided messages ended with NO final batch — a hook that tracks a message
 * by `message_id` (to redact across batches, say) never saw it close.
 *
 * Decided (uniform, smallest, the page's own shape): a voided message the hook has SEEN gets
 * an empty final batch — `delta: ''`, `final: true`, the next `index` — and nothing is
 * displayed from it. A message the hook never saw a batch of fires nothing: there is nothing
 * to close, and hooks.md says a message with no displayed text does not trigger the event.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { SESSIONS_DIR } from '@nessy-agent/shared/workspaces'
import type { AgentEvent, AgentEventExecutionResult, SdkAutomationInput } from '@nessy-agent/shared/automations'
import { createManagedSession, type SessionManager } from '../SessionManager'
import { createTestSessionManager } from './test-session-manager'

const managers: SessionManager[] = []

afterEach(() => {
  for (const manager of managers.splice(0)) manager.cleanup()
  rmSync(join(SESSIONS_DIR, 'ws_test'), { recursive: true, force: true })
})

type Internals = {
  processEvent(managed: unknown, event: Record<string, unknown>): Promise<void>
  flushDelta(sessionId: string, workspaceId: string): Promise<void>
}

function setUp(sessionId: string) {
  const inputs: SdkAutomationInput[] = []
  const system = {
    executeAgentEvent: async (event: AgentEvent, input: SdkAutomationInput): Promise<AgentEventExecutionResult> => {
      if (event === 'MessageDisplay') inputs.push(input)
      return { matchedCount: 1 } as AgentEventExecutionResult
    },
    hasAgentEventMatchers: (event: AgentEvent) => event === 'MessageDisplay',
  }
  const manager = createTestSessionManager()
  managers.push(manager)
  manager.setEventSink(() => {})
  const managed = createManagedSession({ id: sessionId }, {
    id: 'ws_test',
    name: 'Test Workspace',
    rootPath: `/tmp/nessy-${sessionId}`,
    createdAt: 1,
  } as never, { messagesLoaded: true })
  ;(managed as unknown as { agentAutomationSystem: unknown }).agentAutomationSystem = system
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(`ws_test:${sessionId}`, managed)
  return { managed, inputs, internals: manager as unknown as Internals }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))

/** `final: true` batches per message_id, in first-seen order. */
function finalsPerMessage(inputs: SdkAutomationInput[]): Array<[string, number]> {
  const counts = new Map<string, number>()
  for (const input of inputs) {
    const id = String(input.message_id)
    counts.set(id, (counts.get(id) ?? 0) + (input.final === true ? 1 : 0))
  }
  return [...counts.entries()]
}

describe('F1.473 · a voided message still gets its one final MessageDisplay batch', () => {
  it('text_discard closes the voided message with an empty final batch; the retried one closes normally', async () => {
    const { managed, inputs, internals } = setUp('f1473-discard')
    await internals.processEvent(managed, { type: 'text_delta', text: 'Partial line\n', turnId: 'pi-turn-1__m0' })
    await internals.flushDelta('f1473-discard', 'ws_test')
    await internals.processEvent(managed, { type: 'text_discard', turnId: 'pi-turn-1__m0' })
    await settle()
    await internals.processEvent(managed, { type: 'text_delta', text: 'Full answer', turnId: 'pi-turn-1__m0' })
    await internals.processEvent(managed, { type: 'text_complete', text: 'Full answer', turnId: 'pi-turn-1__m0' })
    await settle()

    const perMessage = finalsPerMessage(inputs)
    expect(perMessage).toHaveLength(2)
    expect(perMessage.map(([, finals]) => finals)).toEqual([1, 1])
    const voided = inputs.filter(input => input.message_id === perMessage[0]![0])
    expect(voided.map(input => ({ index: input.index, final: input.final, delta: input.delta }))).toEqual([
      { index: 0, final: false, delta: 'Partial line\n' },
      { index: 1, final: true, delta: '' },
    ])
    expect(voided[1]!.turn_id).toBe('pi-turn-1__m0')
  })

  it('BOUNDARY: a voided message the hook never saw a batch of fires nothing', async () => {
    const { managed, inputs, internals } = setUp('f1473-unseen')
    // No newline and no flush: the whole-lines hold keeps it back, so the hook saw nothing.
    await internals.processEvent(managed, { type: 'text_delta', text: 'Partial', turnId: 'pi-turn-1__m0' })
    await internals.processEvent(managed, { type: 'text_discard', turnId: 'pi-turn-1__m0' })
    await settle()
    expect(inputs).toEqual([])
  })
})
