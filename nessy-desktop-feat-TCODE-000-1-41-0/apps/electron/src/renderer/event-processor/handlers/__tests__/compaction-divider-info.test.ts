/**
 * F1.931 — live half of the Compacted divider. `handleInfo` turned the session's `compacting` status row into the
 * `compaction_complete` info, and when there was NO such row (a runtime that announced nothing — Pi's manual /compact
 * before F1.729 — or a row already cleared by an interrupt) it dropped the info altogether, so the live transcript had
 * no boundary row for ChatDisplay to draw as the divider.
 */
import { describe, expect, it } from 'bun:test'
import { handleInfo } from '../session'
import type { InfoEvent, SessionState } from '../../types'

const info: InfoEvent = { type: 'info', sessionId: 's', message: 'Compacted context to fit within limits', statusType: 'compaction_complete' } as InfoEvent

function state(messages: Array<Record<string, unknown>>): SessionState {
  return { session: { id: 's', messages, lastMessageAt: 1, isProcessing: true } as never, streaming: null }
}

describe('handleInfo keeps the compaction boundary (F1.931)', () => {
  it('with no compacting status row to convert, the compaction_complete info is appended', () => {
    const next = handleInfo(state([{ id: 'u1', role: 'user', content: '/compact', timestamp: 1 }]), info)
    const rows = next.state.session.messages.filter(m => m.role === 'info')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ content: info.message, statusType: 'compaction_complete' })
  })

  it('CONTROL — a compacting status row is converted in place, with no second row', () => {
    const next = handleInfo(state([
      { id: 'u1', role: 'user', content: '/compact', timestamp: 1 },
      { id: 's1', role: 'status', content: 'Compacting context...', timestamp: 2, statusType: 'compacting' },
    ]), info)
    expect(next.state.session.messages.map(m => [m.id, m.role, m.statusType])).toEqual([
      ['u1', 'user', undefined],
      ['s1', 'info', 'compaction_complete'],
    ])
  })
})
