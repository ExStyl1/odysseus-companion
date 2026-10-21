/**
 * F1.1298 — what a failed manual `compact` answers the host. A Stop's answer is Pi's own
 * `Compaction cancelled` whichever summarization the Stop interrupted: the SDK throws that text for
 * a history summary, but `Turn prefix summarization failed: The operation was aborted.` when the cut
 * splits a turn (measured on Pi 0.85.1, F1.1080's rig with every turn large). The real-server arm is
 * `__tests__/pi-stop-cancels-manual-compact-real-server.test.ts`; these pin the rule's edges.
 */
import { describe, expect, it } from 'bun:test'
import { compactFailureText } from './compact-failure-text.ts'

describe('compactFailureText (F1.1298)', () => {
  it('a stopped compaction answers "Compaction cancelled", whatever the SDK threw', () => {
    expect(compactFailureText('Turn prefix summarization failed: The operation was aborted.', { stopped: true })).toBe('Compaction cancelled')
    expect(compactFailureText('Compaction cancelled', { stopped: true, preCompactBlockReason: 'blocked by policy' })).toBe('Compaction cancelled')
  })

  it('CONTROL: a failure with no Stop keeps its own text', () => {
    expect(compactFailureText('Turn prefix summarization failed: 500 Internal Server Error', { stopped: false })).toBe('Turn prefix summarization failed: 500 Internal Server Error')
  })

  it('CONTROL: a PreCompact block (no Stop) still reports the hook\'s own reason (R73)', () => {
    expect(compactFailureText('Compaction cancelled', { stopped: false, preCompactBlockReason: 'blocked by policy' })).toBe('blocked by policy')
    expect(compactFailureText('Summarization failed: x', { stopped: false, preCompactBlockReason: 'blocked by policy' })).toBe('Summarization failed: x')
  })
})
