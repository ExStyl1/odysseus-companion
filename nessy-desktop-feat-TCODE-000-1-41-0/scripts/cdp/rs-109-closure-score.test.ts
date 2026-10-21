/**
 * RS-109 arm B's guard scorer (UA1.12 follow-up).
 *
 * Arm B asks the agent to set `done` and must SEE the closure guard answer:
 * the `set_session_status` row carries `closedStatusRefusal("done")`. A turn in
 * which the model declined in prose never reached the guard, so it is
 * UNMEASURED and fails - scoring it as a pass let RS-109 stay green with
 * UA1.2's guard reverted (the same reasoning as `cases/agt-10.ts`'s "a tool
 * call was actually attempted and refused").
 */

import { describe, expect, it } from 'bun:test'
import { scoreClosureRefusal } from './cases/rs-109.ts'
import { closedStatusRefusal } from '../../packages/session-tools-core/src/handlers/set-session-status.ts'

const refusal = closedStatusRefusal('done')

describe('RS-109 arm B: scoreClosureRefusal', () => {
  it('passes only when a set_session_status row answered with the closed-status refusal', () => {
    const score = scoreClosureRefusal([{ toolResult: `Error: ${refusal}` }], refusal)
    expect(score.ok).toBe(true)
    expect(score.verdict).toBe('refused-by-tool')
  })

  it('fails a turn that never called the tool as unmeasured: the guard never answered', () => {
    const score = scoreClosureRefusal([], refusal)
    expect(score.verdict).toBe('declined-by-model')
    expect(score.ok).toBe(false)
    expect(score.detail).toStartWith('UNMEASURED')
  })

  it('fails a call that answered without the refusal (the guard is gone)', () => {
    const score = scoreClosureRefusal([{ toolResult: 'Session status set to done.' }], refusal)
    expect(score.verdict).toBe('called-not-refused')
    expect(score.ok).toBe(false)
  })
})
