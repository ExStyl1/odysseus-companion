/**
 * P4.9 · the whole chain, for an ORDINARY (non-backgrounded) running tool:
 * `task_progress` heartbeat → tool message → activity → painted text.
 *
 * P0.7 built the beat and its own closing note recorded the residue precisely:
 * "a silent, non-backgrounded tool now carries live elapsed in renderer state
 * that nothing draws yet." Each half of that chain had a test; the join did not,
 * which is exactly how a value can be delivered correctly all the way to a
 * renderer that never paints it.
 *
 * One premise in P4.9's pre-check is refined here rather than assumed. The row
 * says `App.tsx` "updates only registered background-task rows", implying the
 * TICK is gated too. It is not: that App-level code maintains
 * `backgroundTasksAtomFamily` — the task chips in `ActiveTasksBar`, a different
 * surface. The MESSAGE tick is `handleTaskProgress` below, which resolves the
 * tool by `toolUseId` with no status filter and was already updating ordinary
 * running rows. Only the paint was gated. The first test asserts that, so the
 * refinement is checked and not just claimed.
 */
import { describe, expect, it } from 'bun:test'
import type { Message } from '../../../../shared/types'
import type { SessionState, TaskProgressEvent } from '../../types'
import { handleTaskProgress } from '../tool'
import { groupMessagesByTurn } from '@nessy-agent/ui/chat/turn-utils'
import { describeToolElapsed, type ToolElapsedLabels } from '@nessy-agent/ui/chat/tool-elapsed'

/**
 * P2.494 · the painter's three strings are injected now that they carry i18n
 * keys. This chain test asserts the value CHANGES per beat, so the labels only
 * have to be stable and interpolating — the byte-identical English pins live in
 * `packages/ui/src/components/chat/__tests__/tool-elapsed.test.ts`, which reads
 * them out of `en.json`.
 */
const labels: ToolElapsedLabels = {
  elapsed: duration => `${duration} elapsed`,
  taskId: id => `Task ID: ${id}`,
  shellId: id => `Shell ID: ${id}`,
}

function createState(messages: Message[]): SessionState {
  return {
    session: { id: 'session-1', messages } as SessionState['session'],
    streaming: null,
  }
}

/**
 * An ordinary running tool: no taskId, no shellId, not backgrounded.
 *
 * `toolStatus: 'executing'` and not `'pending'`, and the distinction is the
 * feature rather than a fixture detail. `getToolStatus` (turn-utils) maps
 * `'pending'` to the `pending` ACTIVITY status and anything unrecognised to
 * `running`; `describeToolElapsed` paints only for `running`. A `pending` row is
 * awaiting permission or dispatch, so a clock beside it would be timing
 * something that has not started — asserted directly in
 * `packages/ui/src/components/chat/__tests__/tool-elapsed.test.ts`.
 */
function runningTool(overrides: Partial<Message> = {}): Message {
  return {
    id: 'message-1',
    role: 'tool',
    content: '',
    timestamp: 1_700_000_000_000,
    turnId: 'turn-1',
    toolUseId: 'call_1',
    toolName: 'Bash',
    toolStatus: 'executing',
    ...overrides,
  } as Message
}

function beat(elapsedSeconds: number): TaskProgressEvent {
  return { type: 'task_progress', sessionId: 'session-1', toolUseId: 'call_1', elapsedSeconds }
}

/** The text the activity row would paint for the single tool in this state. */
function paintedElapsed(state: SessionState): string | null {
  const turn = groupMessagesByTurn(state.session.messages).find(t => t.type === 'assistant')
  if (!turn || turn.type !== 'assistant') throw new Error('no assistant turn')
  const activity = turn.activities.find(a => a.toolUseId === 'call_1')
  if (!activity) throw new Error('tool activity missing')
  return describeToolElapsed(activity, labels).text
}

describe('P4.9 · heartbeat reaches and paints an ordinary running tool row', () => {
  it('writes elapsed onto a non-backgrounded tool message (the tick was never gated)', () => {
    const state = handleTaskProgress(createState([runningTool()]), beat(30))
    const message = state.session.messages[0]!
    expect(message.elapsedSeconds).toBe(30)
    // Positive control that this row really is the ordinary case and not a
    // backgrounded one wearing a different name.
    expect(message.taskId).toBeUndefined()
    expect(message.shellId).toBeUndefined()
    expect(message.toolStatus).not.toBe('backgrounded')
  })

  it('is an ordinary RUNNING activity, not a pending or backgrounded one', () => {
    // The detector check: without this, every assertion below could be passing
    // against a row whose activity status is something other than what P4.9 is
    // about. A live case's detector is the thing most likely to be wrong.
    const state = handleTaskProgress(createState([runningTool()]), beat(30))
    const turn = groupMessagesByTurn(state.session.messages).find(t => t.type === 'assistant')!
    const activity = (turn as { activities: { toolUseId?: string; status: string }[] }).activities
      .find(a => a.toolUseId === 'call_1')!
    expect(activity.status).toBe('running')
  })

  it('paints the elapsed on that row', () => {
    const state = handleTaskProgress(createState([runningTool()]), beat(30))
    expect(paintedElapsed(state)).toBe('30.0s elapsed')
  })

  it('repaints a new value on each successive beat', () => {
    // The defect P4.9's acceptance names: a heartbeat that renders once and
    // never ticks. Drive three real beats through the reducer.
    let state = createState([runningTool()])
    const painted: (string | null)[] = []
    for (const seconds of [30, 60, 90]) {
      state = handleTaskProgress(state, beat(seconds))
      painted.push(paintedElapsed(state))
    }
    expect(painted).toEqual(['30.0s elapsed', '1m 0s elapsed', '1m 30s elapsed'])
  })

  it('paints nothing before the first beat', () => {
    expect(paintedElapsed(createState([runningTool()]))).toBeNull()
  })

  it('stops painting once the tool completes, stale beat and all', () => {
    let state = handleTaskProgress(createState([runningTool()]), beat(90))
    expect(paintedElapsed(state)).toBe('1m 30s elapsed')

    // The tool finishes. `elapsedSeconds` stays on the message — a frozen clock
    // beside a finished row is what this must not do.
    state = createState([{ ...state.session.messages[0]!, toolStatus: 'completed', toolResult: 'ok' } as Message])
    expect(state.session.messages[0]!.elapsedSeconds).toBe(90)
    expect(paintedElapsed(state)).toBeNull()
  })

  it('still paints the id and elapsed once the tool backgrounds', () => {
    // The pre-P4.9 behaviour, reached through the same chain.
    let state = handleTaskProgress(createState([runningTool()]), beat(30))
    state = createState([
      { ...state.session.messages[0]!, toolStatus: 'backgrounded', taskId: 'agent_7' } as Message,
    ])
    expect(paintedElapsed(state)).toBe('Task ID: agent_7, 30.0s elapsed')
  })
})
