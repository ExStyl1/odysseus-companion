/**
 * D1.379 / F1.78 — the renderer must learn that a turn is RUNNING from the
 * turn's own activity, not only from the one event that started it.
 *
 * ## The defect, measured at `edbc4c4fa`
 *
 * Under `apps/electron/src/renderer/event-processor/` there are exactly two
 * writers of `isProcessing: true` — `handleUserMessage` (`handlers/session.ts`,
 * the line D1.376 repaired) and `createEmptySession` (`helpers.ts`). Every other
 * site in the module LOWERS the flag (six of them in `handlers/session.ts`). So
 * a renderer that never saw the `user_message` event believes the session idle
 * for the WHOLE turn, and nothing in the event stream heals it:
 *
 *  * a second window opened mid-turn builds its session from the host's list and
 *    then only watches the live stream — the `user_message` for the running turn
 *    is already in the past;
 *  * a dropped push, or a client reconnecting mid-turn, loses the same event.
 *
 * That belief is load-bearing. `AppShell`'s Esc-Esc action is
 * `enabled: () => … meta?.isProcessing ?? false`, the composer's control
 * resolves to a send arrow rather than a Stop, and the prompt restore that runs
 * on a Stop is gated on it. D1.376 was ONE WRONG VALUE on that single writer and
 * it was release-blocking; a MISSING EVENT has the same reach, which is why this
 * row exists (`queued-message-keeps-processing.test.ts` is that row, and it must
 * stay green in the same run as this file).
 *
 * ## Why the rule lives in `processor.ts` rather than in the handlers
 *
 * One rule in one place. Raising the flag inside the handlers needs ~8 edits
 * across three files (`handlers/text.ts` has four return sites for
 * `handleTextDelta`, `handlers/tool.ts` two for `handleToolStart`,
 * `handlers/session.ts` two in `handleStatus`), and a future handler return path
 * can silently forget it. It is also the anchor-free file: a census over the
 * whole tree at `edbc4c4fa` answers ZERO line citations into
 * `event-processor/processor.ts`, against `handlers/text.ts` (26, 96, 108),
 * `handlers/tool.ts` (243) and `handlers/session.ts` (109, 124), so an insert
 * here moves no documented anchor.
 *
 * ## Why THESE events, and why the set is not wider
 *
 * `text_delta` and `tool_start` can only be produced by a model turn in flight.
 * `status` splits, and it was read at the EMITTER rather than guessed:
 *
 *  * the agent-event pipe stamps `retrying` / `compacting` / undefined inside
 *    `SessionManager.processEvent`'s `case 'status'`, and every status through
 *    that branch comes off a RUNNING agent's own event stream;
 *  * the one status that does not is `statusType: 'hook'`, which has exactly one
 *    emitter in the tree — `hookStatusReporter`, passed to the plugin hooks
 *    automation — and that fires for SessionStart/SessionEnd hooks OUTSIDE any
 *    turn. It is the boundary case, and it is pinned below as a control.
 *
 * Nothing else is admitted. `usage_update`, `name_changed` and `session_flagged`
 * all reach an idle session in normal use and are pinned as negative controls,
 * so a fix that raised the flag on "any event at all" fails this file.
 *
 * ## The residue, stated rather than hidden
 *
 * A raise that outlived its turn would strand the session with a spinner and a
 * Stop that does nothing. The only way in is an event arriving AFTER the turn's
 * terminal event — the seam `handleComplete` records, and the one P3.16 closed at
 * the emitter (`SessionManager` flushes its 50 ms delta batch before every
 * renderer-facing `complete`/`interrupted`; see
 * `late-delta-after-turn-end.test.ts` and
 * `packages/server-core/src/sessions/__tests__/delta-flush-before-turn-end.test.ts`).
 * What survives is the residue this codebase already measured and accepted for
 * the live BUBBLE, and the flag now inherits exactly that lifetime: a late delta
 * raises it, and the next terminal event heals it. The last case below pins that
 * as a documented behaviour, not as an accident.
 */
import { describe, expect, it } from 'bun:test'
import { processEvent } from '../../processor'
import type { AgentEvent, SessionState } from '../../types'

/**
 * A session the renderer believes IDLE while the host is mid-turn: exactly what
 * a window opened during a running turn builds from `listSessions`.
 */
function believedIdle(): SessionState {
  return {
    session: {
      id: 'session-1',
      messages: [
        { id: 'msg-1', role: 'user', content: 'run three shell steps', timestamp: 1 },
      ],
      lastMessageAt: 1,
      isProcessing: false,
    } as never,
    streaming: null,
  }
}

const delta: AgentEvent = { type: 'text_delta', sessionId: 'session-1', delta: 'STEP-1' }

const toolStart: AgentEvent = {
  type: 'tool_start',
  sessionId: 'session-1',
  toolUseId: 'tool-1',
  toolName: 'Bash',
  timestamp: 2,
}

const runningStatus: AgentEvent = {
  type: 'status',
  sessionId: 'session-1',
  message: 'Compacting conversation',
  statusType: 'compacting',
}

function drive(events: AgentEvent[], from: SessionState = believedIdle()): SessionState {
  let state = from
  for (const event of events) state = processEvent(state, event).state
  return state
}

describe('an event that can only occur mid-turn tells the renderer the turn is running', () => {
  it('THE DEFECT — a `text_delta` on a session believed idle raises `isProcessing`', () => {
    expect(believedIdle().session.isProcessing).toBe(false)
    expect(drive([delta]).session.isProcessing).toBe(true)
  })

  it('THE DEFECT — a `tool_start` raises it too', () => {
    expect(drive([toolStart]).session.isProcessing).toBe(true)
  })

  it('THE DEFECT — a non-hook `status` raises it too', () => {
    expect(drive([runningStatus]).session.isProcessing).toBe(true)
    // `retrying` is the gateway 429 backoff; it is a running turn waiting, and
    // the Stop must work through the wait.
    expect(drive([{
      type: 'status',
      sessionId: 'session-1',
      message: 'Retrying in 15s',
      statusType: 'retrying',
    }]).session.isProcessing).toBe(true)
    // A status with no `statusType` is the ordinary agent status line.
    expect(drive([{
      type: 'status',
      sessionId: 'session-1',
      message: 'Thinking',
    }]).session.isProcessing).toBe(true)
  })

  it('CONTROL — the handler\'s own work survives the raise', () => {
    // The raise rebuilds the session object, so this is the arm that catches a
    // fix which returns a session of its own instead of the handler's.
    const after = drive([delta, delta])
    expect(after.streaming?.content).toBe('STEP-1STEP-1')
    expect(after.session.messages.at(-1)?.content).toBe('STEP-1STEP-1')

    const withTool = drive([toolStart])
    expect(withTool.session.messages.some(m => m.toolName === 'Bash')).toBe(true)

    const withStatus = drive([runningStatus])
    expect(withStatus.session.currentStatus?.message).toBe('Compacting conversation')
  })

  it('CONTROL (negative) — a session that receives nothing stays idle', () => {
    expect(believedIdle().session.isProcessing).toBe(false)
  })

  it('CONTROL (boundary) — a `hook` status does NOT raise it', () => {
    // `hookStatusReporter` is the one emitter of `statusType: 'hook'` and it
    // fires for SessionStart/SessionEnd hooks outside any turn. Raising on it
    // would put a Stop on an idle session.
    expect(drive([{
      type: 'status',
      sessionId: 'session-1',
      message: 'Running PreToolUse hook',
      statusType: 'hook',
    }]).session.isProcessing).toBe(false)
  })

  it('CONTROL — events that reach an idle session do not raise it', () => {
    // Without these, "raise on every event" would pass this file, and the app
    // would grow a Stop button on every idle session in the sidebar.
    const quiet: AgentEvent[] = [
      { type: 'usage_update', sessionId: 'session-1', tokenUsage: { inputTokens: 10 } },
      { type: 'name_changed', sessionId: 'session-1', name: 'renamed' },
      { type: 'session_flagged', sessionId: 'session-1' },
    ]
    for (const event of quiet) {
      expect(drive([event]).session.isProcessing).toBe(false)
    }
  })

  it('CONTROL — the raise cannot outlive the turn', () => {
    // Every terminal event lowers the flag, and the raise must not out-rank one.
    expect(drive([delta, { type: 'complete', sessionId: 'session-1' }]).session.isProcessing).toBe(false)
    expect(drive([toolStart, {
      type: 'interrupted',
      sessionId: 'session-1',
    }]).session.isProcessing).toBe(false)
  })

  it('STATED RESIDUE — a late delta after `complete` raises, and the next `complete` heals it', () => {
    // Not a defect and not an accident: the flag inherits exactly the lifetime
    // this codebase already accepted for the live bubble. P3.16 closed the
    // emitter-side window; if a sitting ever shows a spinner surviving a turn,
    // THIS is the arm that has become a defect.
    const stranded = drive([delta, { type: 'complete', sessionId: 'session-1' }, delta])
    expect(stranded.session.isProcessing).toBe(true)

    const healed = processEvent(stranded, { type: 'complete', sessionId: 'session-1' }).state
    expect(healed.session.isProcessing).toBe(false)
  })

  it('CONTROL — a session already processing is left exactly as the handler returned it', () => {
    // The raise is a floor, never an override: it must not touch a turn that is
    // already known to be running, or D1.376's repair would be re-decided here.
    const running: SessionState = {
      ...believedIdle(),
      session: { ...believedIdle().session, isProcessing: true },
    }
    const after = processEvent(running, delta)
    expect(after.state.session.isProcessing).toBe(true)
    expect(after.effects).toEqual([])
  })
})
