/**
 * F1.524 (2) (origin WJ-am P-WJ-am-2) — the renderer's busy state for a turn the claude child opened ITSELF.
 *
 * When a background subagent ends between host turns, the claude CLI opens a turn of its own to hand the model the
 * `<task-notification>` (F1.492). The host holds no turn then (`managed.isProcessing` is false), so:
 *
 * - the session looked IDLE while Claude answered — no spinner, no Stop — and a message sent then was queued behind a
 *   turn nobody could see (F1.509);
 * - since F1.511 that turn's `tool_start` rows reach the renderer through the between-turns door, and the renderer's
 *   D1.379 rule raises `isProcessing` on a `tool_start` — with nothing ever lowering it, because no terminal event
 *   follows a turn the host did not run. A spinner, and a Stop that did nothing, outlived the turn until the NEXT
 *   host turn's `complete`.
 *
 * The agent reports the turn's start and end (`ClaudeAgent.onRuntimeOwnTurn`); this turns them into the renderer's
 * two existing signals, and only while no host turn owns the indicator:
 *
 * - `running` → a `status` event of type `runtime_turn` with an empty message: the renderer shows it like a hook's
 *   status (a spinner label, never a transcript entry — the empty message leaves the default label), and D1.379
 *   raises `isProcessing` on it, which is what puts the spinner and the Stop on screen.
 * - `ended` → a renderer-only `complete` — only if this module raised the indicator, and only if no host turn has
 *   started or been announced meanwhile (that turn's own `complete` lowers it; a `complete` from here would lower a
 *   running turn — {@link RuntimeOwnTurnIndicatorHost.endTurn} carries the announced half, F1.612). The
 *   renderer's `complete` handler also ends any tool row still `executing`, and it is the event its turn-completion
 *   notification listens to — Claude did answer something.
 *
 * The Stop that the raised indicator shows reaches the turn through `SessionManager.cancelProcessing`, which asks the
 * agent to interrupt its own turn when no host turn is running (`ClaudeAgent.interruptRuntimeOwnTurn`).
 *
 * Nothing here is persisted: the indicator is live state, rebuilt from the next event a window receives, exactly
 * like a hook's status.
 */
import type { SessionEvent } from '@nessy-agent/shared/protocol'

export interface RuntimeOwnTurnIndicatorHost {
  /** The host's own turn is running (`managed.isProcessing`): it owns the indicator, and this module stays quiet. */
  hostTurnRunning(): boolean
  /** The renderer-facing send (`SessionManager.sendEvent` bound to the session's workspace). */
  send(event: Extract<SessionEvent, { type: 'status' }>): void
  /**
   * The renderer-facing TERMINAL send — P3.16's door (`SessionManager.flushBeforeTurnEndEvent`), which flushes the
   * delta batch before a `complete` leaves (and P3.21's check warns about a `complete` that skipped it). F1.612: the
   * host decides AFTER that flush, and drops the `complete` when it announced a queued host turn since `ended` — the
   * replay armed on the settled own turn runs first, while `hostTurnRunning()` still reads false.
   */
  endTurn(event: Extract<SessionEvent, { type: 'complete' }>): void
}

/** The callback to hand `ClaudeAgent.onRuntimeOwnTurn`, for one session. */
export function runtimeOwnTurnIndicator(
  sessionId: string,
  host: RuntimeOwnTurnIndicatorHost,
): (phase: 'running' | 'ended') => void {
  let raised = false
  return phase => {
    if (phase === 'running') {
      if (raised || host.hostTurnRunning()) return
      raised = true
      host.send({ type: 'status', sessionId, message: '', statusType: 'runtime_turn' })
      return
    }
    if (!raised) return
    raised = false
    if (host.hostTurnRunning()) return
    host.endTurn({ type: 'complete', sessionId })
  }
}
