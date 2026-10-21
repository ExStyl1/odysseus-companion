/**
 * F1.931 — the 'Conversation Compacted' divider (ChatDisplay's `info` + `compaction_complete` rule) never rendered:
 * `groupMessagesByTurn` dropped every `compaction_complete` info with `continue`, expecting to fold it into a
 * `compacting` status activity of the open turn. Status rows are never stored, so after a reload there is nothing to
 * fold into, and live the renderer converts the status row itself into the info. SIT-ag measured it on Pi and claude
 * after Accept & Compact (`shots/pl2-compacted.png`, `cl2-compacted.png`; a reload did not change it).
 */
import { describe, expect, it } from 'bun:test'
import { groupMessagesByTurn } from '../turn-utils'

const user = (id: string, content: string) => ({ id, role: 'user' as const, content, timestamp: 1 })
const compacted = { id: 'cc', role: 'info' as const, content: 'Compacted context to fit within limits (from ~91,641 tokens)', timestamp: 2, statusType: 'compaction_complete' as const }

describe('the Compacted divider (F1.931)', () => {
  it('a compaction_complete info with no turn to fold into is its own system turn (the divider)', () => {
    const turns = groupMessagesByTurn([user('u1', '/compact'), compacted, user('u2', 'Plan approved, run it')] as never)
    const system = turns.filter(turn => turn.type === 'system')
    expect(system).toHaveLength(1)
    expect((system[0] as { message: { id: string } }).message.id).toBe('cc')
  })

  it('CONTROL — inside a turn that shows a compacting activity, it still completes that activity instead of a second row', () => {
    const turns = groupMessagesByTurn([
      user('u1', 'go on'),
      { id: 's1', role: 'status', content: 'Compacting conversation...', timestamp: 2, statusType: 'compacting' },
      { ...compacted, timestamp: 3 },
    ] as never)
    expect(turns.filter(turn => turn.type === 'system')).toHaveLength(0)
    const assistant = turns.find(turn => turn.type === 'assistant') as { activities: Array<{ status: string; content: string }> }
    expect(assistant.activities.map(activity => [activity.status, activity.content])).toEqual([['completed', compacted.content]])
  })
})
