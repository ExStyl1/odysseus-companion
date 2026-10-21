/**
 * D1.245 · the HOST half — an `info` marked as a session command's answer is
 * kept in the transcript, and nothing else is.
 *
 * ## What this pins, and why the negative is the case that matters
 *
 * `case 'info'` persisted exactly two kinds before this row: a compaction
 * completion and a WARNING-level banner. Everything else was transient, so a
 * user's `/help` line survived a reload with nothing after it (`RS-46` on the
 * packaged 1.39.0). The new clause is keyed on `answersSessionCommand`, which
 * only the `BaseAgent.chat` seam sets.
 *
 * The dangerous direction is the other one: a clause that persisted every info
 * would put unsolicited notices about states that CHANGE — a lapsed `dp`
 * session, a retry in flight, a budget currently exhausted — into a transcript
 * that would then claim a condition since fixed.
 * `SessionManager.recordSessionInfoEntry`'s docblock is where that rule is
 * written, and `announceDpSessionLapse` is its worked example. So the unmarked
 * case is asserted as carefully as the marked one.
 *
 * The SEAM half — that the six read answers carry the field and `/clear` does
 * not — is
 * `packages/shared/src/agent/__tests__/session-command-answer-marker-seam.test.ts`.
 * Neither half is worth anything alone: a marker nothing reads is an inert
 * field, and a clause nothing sets is dead code.
 *
 * The REAL `processEvent` runs here against a hand-built managed session, so
 * the assertion rests on the shipped arm rather than on a re-implementation of
 * it; only the leaf collaborators (`sendEvent`, `persistSession`, the
 * provenance stamp) are supplied.
 */
import { describe, expect, test } from 'bun:test'
import type { AgentEvent, Message } from '@nessy-agent/core/types'
import { SessionManager } from '../SessionManager'
import { createTestSessionManager } from './test-session-manager.ts'

function rig(options: { ephemeral?: boolean } = {}) {
  const manager = createTestSessionManager() as any
  const sent: Array<{ type: string; message?: string; level?: string }> = []
  const managed = {
    id: 'session-1',
    workspace: { id: 'workspace-1' },
    messages: [] as Message[],
    ...(options.ephemeral ? { ephemeral: true } : {}),
  }
  manager.sendEvent = (event: { type: string }) => { sent.push(event as never) }
  manager.persistSession = () => {}
  manager.stampMessageProvenance = (_managed: unknown, message: Message) => message
  const deliver = (event: AgentEvent) =>
    SessionManager.prototype['processEvent'].call(manager, managed as never, event)
  return { deliver, managed, sent }
}

const ANSWER: AgentEvent = {
  type: 'info',
  message: 'Commands: /help, /status …',
  answersSessionCommand: true,
}

describe('D1.245 · a session command answer is kept beside the question', () => {
  test('a marked info becomes a durable transcript row AND is still sent', async () => {
    const h = rig()
    await h.deliver(ANSWER)
    expect(h.managed.messages).toHaveLength(1)
    expect(h.managed.messages[0]!.role).toBe('info')
    expect(h.managed.messages[0]!.content).toBe('Commands: /help, /status …')
    // The renderer's copy is unchanged: this row adds persistence, it does not
    // move the answer off the channel it already arrived on.
    expect(h.sent.filter(event => event.type === 'info')).toHaveLength(1)
  })

  test('an ordinary info is still transient — the control the clause needs', async () => {
    const h = rig()
    // The exact shape `announceDpSessionLapse` emits: a state that can change,
    // which the user never asked about. Persisting it would leave a sentence
    // claiming a condition that has since been fixed.
    await h.deliver({ type: 'info', message: 'The dp CLI session has lapsed.' })
    expect(h.managed.messages).toEqual([])
    expect(h.sent.filter(event => event.type === 'info')).toHaveLength(1)
  })

  test('an answer keeps its LEVEL, which is why the clause sits after the warning arm', async () => {
    const h = rig()
    // A quota read that failed answers at `warning`. The warning arm claims it
    // first and stores `infoLevel: 'warning'`; reaching the new clause instead
    // would have stored the row without a level and the banner would be lost.
    await h.deliver({
      type: 'info',
      message: 'Quota could not be read for this connection.',
      level: 'warning',
      answersSessionCommand: true,
    })
    expect(h.managed.messages).toHaveLength(1)
    expect(h.managed.messages[0]!.infoLevel).toBe('warning')
  })

  test('an ephemeral session persists nothing, exactly as the warning arm does', async () => {
    const h = rig({ ephemeral: true })
    await h.deliver(ANSWER)
    expect(h.managed.messages).toEqual([])
    // Still on screen, though: ephemeral is about what survives, not about what
    // the user is shown.
    expect(h.sent.filter(event => event.type === 'info')).toHaveLength(1)
  })
})
