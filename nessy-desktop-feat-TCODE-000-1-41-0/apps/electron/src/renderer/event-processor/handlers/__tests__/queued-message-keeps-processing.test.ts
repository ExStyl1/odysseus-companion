/**
 * D1.376 — a message QUEUED behind a running turn must not tell the renderer the
 * turn is over, because `isProcessing` is the gate on BOTH of the app's Stop
 * routes.
 *
 * ## What was measured, and what it turned out to be
 *
 * RS-81 (sitting 5e, `docs/testing/cdp-runs/2026-09-18-measure-sitting-5e.md` §2)
 * drove the same Stop twice on the same claude card, differing in one thing:
 *
 * | arm | interrupt rows | settled after | tool calls AFTER the Stop |
 * | --- | --- | --- | --- |
 * | a message QUEUED behind the turn | **0** | 135 839 ms | **2** |
 * | nothing queued (THE CONTROL) | 1 — `Response interrupted` | 16 081 ms | 0 |
 *
 * With a message queued, the remaining shell calls ran, the assistant delivered
 * its full summary, and only then was the queued message answered.
 *
 * WI-be eliminated the claude interrupt seam from the source: `forceAbort` →
 * `interruptLiveTurn` is DOWNSTREAM of `SessionManager.cancelProcessing`, and
 * that method appends the `Response interrupted` row unconditionally for a
 * non-silent Stop and sets `queuePaused` whenever the queue is non-empty. Zero
 * rows AND a delivered queue mean the host never ran the method at all.
 *
 * It never ran because **the renderer never called it.** The one line at the end
 * of `handleUserMessage` is the whole defect:
 *
 *     isProcessing: status === 'accepted' || status === 'processing',
 *
 * `'queued'` is emitted from exactly ONE site in the host —
 * `SessionManager`'s mid-stream branch, `status: steered ? 'accepted' : 'queued'`,
 * INSIDE `if (managed.isProcessing || followUpDuringSendStart)` — so a `'queued'`
 * event is, by construction, the host saying *"a turn is running and I parked
 * this behind it"*. The handler answered that by lowering the renderer's
 * `isProcessing`, and **nothing in the whole event processor raises it again**:
 * this handler is the only `isProcessing: true` in `handlers/`, the sole other
 * one being `createEmptySession` in `helpers.ts`. So for the rest of the running
 * turn the renderer believed the session was idle, and:
 *
 *  * `ChatDisplay.handleStop` returns at its first line, `if (!session?.isProcessing) return`,
 *    so `window.electronAPI.cancelProcessing` is never called;
 *  * `AppShell`'s Esc-Esc action is `enabled: () => … meta?.isProcessing ?? false`
 *    and is disabled outright;
 *  * `resolveSubmitControl` returns `send` rather than `stop`, so the composer's
 *    Stop button turns back into an arrow under the user's finger.
 *
 * Both Stop routes die together. That is why the fix is here and not at the
 * seam: the host cannot decline a Stop it was never asked for.
 *
 * ## Why `true` rather than "leave it as it was"
 *
 * All three statuses this event can carry mean a turn is in flight — `accepted`
 * (steered into the running turn), `processing` (a queued message has just
 * started), `queued` (parked behind one). Carrying the previous value forward
 * would preserve a stale `false` on exactly the path that produced the bug, and
 * the union has no fourth member (`UserMessageEvent.status` in `../../types`).
 * The queue-after-abort case is not an exception: the backend has aborted the
 * turn but `managed.isProcessing` stays true until `onProcessingStopped`, and
 * the queued message is replayed from there.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { handleUserMessage } from '../session'
import { processEvent } from '../../../event-processor/processor'
import { resolveSubmitControl } from '../../../components/app-shell/input/submit-control'
import type { SessionState, UserMessageEvent } from '../../types'

function runningTurn(): SessionState {
  return {
    session: {
      id: 'session-1',
      messages: [
        { id: 'msg-1', role: 'user', content: 'run three shell steps', timestamp: 1 },
      ],
      lastMessageAt: 1,
      isProcessing: true,
    } as never,
    streaming: null,
  }
}

function userMessage(status: UserMessageEvent['status']): UserMessageEvent {
  return {
    type: 'user_message',
    sessionId: 'session-1',
    message: { id: 'msg-2', role: 'user', content: 'a follow-up', timestamp: 2 } as never,
    status,
  }
}

describe('a queued user message leaves the turn running', () => {
  it('THE DEFECT — `queued` must not lower `isProcessing` while the turn runs', () => {
    const next = handleUserMessage(runningTurn(), userMessage('queued'))

    expect(next.state.session.isProcessing).toBe(true)
    // The message itself is still marked queued — the row is about the SESSION
    // flag, not about the bubble's dashed-draft treatment, and a fix that
    // repaired one by breaking the other would be worse than the defect.
    expect(next.state.session.messages.find(m => m.id === 'msg-2')?.isQueued).toBe(true)
  })

  it('THE CONTROL — the two statuses that already worked still do', () => {
    // Green before this row and after it. Without them, an assertion that the
    // flag is `true` could be satisfied by a constant, and nobody would notice
    // that the handler had stopped reading `status` at all.
    for (const status of ['accepted', 'processing'] as const) {
      const next = handleUserMessage(runningTurn(), userMessage(status))
      expect(next.state.session.isProcessing).toBe(true)
      expect(next.state.session.messages.find(m => m.id === 'msg-2')?.isQueued).toBe(false)
    }
  })

  it('nothing in the event stream heals it — the next event of the SAME turn must not have to', () => {
    // The reason the defect survived the whole turn rather than one tick:
    // `handleUserMessage` is the only `isProcessing: true` in the handlers, so
    // the running turn's own later events cannot put the flag back. Driven
    // through the real `processEvent` rather than the handler, because that is
    // the seam the app uses.
    let state = processEvent(runningTurn(), userMessage('queued')).state
    expect(state.session.isProcessing).toBe(true)

    state = processEvent(state, {
      type: 'tool_start',
      sessionId: 'session-1',
      toolUseId: 'tool-2',
      toolName: 'Bash',
      timestamp: 3,
    }).state
    expect(state.session.isProcessing).toBe(true)

    state = processEvent(state, { type: 'text_delta', sessionId: 'session-1', delta: 'STEP-2' }).state
    expect(state.session.isProcessing).toBe(true)
  })

  it('the composer keeps its Stop button after a message is queued', () => {
    // The user-visible half of the same flag, through the composer's own
    // resolver: an empty composer over a running turn is a Stop. On the
    // defective handler this resolved to `send`, which is the button mutating
    // under the finger of the user who is trying to stop the turn.
    const queued = handleUserMessage(runningTurn(), userMessage('queued'))

    expect(resolveSubmitControl({
      isProcessing: queued.state.session.isProcessing === true,
      hasContent: false,
      queueSupported: true,
      sessionId: 'session-1',
    })).toEqual({ mode: 'stop', inert: false })
  })

  it('this flag still steers the Stop surfaces, so it is load-bearing', () => {
    // A source pin, and it is the reason this row is a renderer fix at all.
    //
    // D1.377 then took ONE of the two readers away deliberately: the composer's
    // Stop no longer asks the renderer's copy of the flag whether the host should
    // hear it, because that copy being wrong for one turn was enough to make every
    // Stop a no-op. What the flag still decides is pinned here — the prompt
    // RESTORE, which would be wrong with nothing running, and Esc-Esc's keybinding,
    // which must not swallow Escape on an idle session. If either is ever rewritten
    // to read something else, re-read this test rather than repair it: the argument
    // in this file's header depends on these lines existing.
    const renderer = join(import.meta.dir, '..', '..', '..')
    const chat = readFileSync(join(renderer, 'components', 'app-shell', 'ChatDisplay.tsx'), 'utf8')
    const shell = readFileSync(join(renderer, 'components', 'app-shell', 'AppShell.tsx'), 'utf8')

    const handleStop = chat.slice(chat.indexOf('const handleStop = (silent = false)'), chat.indexOf('const handleStop = (silent = false)') + 1400)
    expect(handleStop).toContain('session.isProcessing')
    // The cancel itself is NOT gated on it any more. Spelled as the removed line
    // was spelled, which no comment in that function repeats.
    expect(handleStop).not.toContain('if (!session?.isProcessing) return')

    const escAction = shell.slice(shell.indexOf("useAction('chat.stopProcessing'"))
    expect(escAction.slice(0, 1200)).toContain('meta?.isProcessing')
  })
})
