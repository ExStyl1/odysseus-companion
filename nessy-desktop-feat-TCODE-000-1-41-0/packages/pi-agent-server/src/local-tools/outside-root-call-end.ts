/**
 * F1.957 (origin SIT-ak, RC #3, 2026-09-25) — an outside-root request lives only as long as the tool call that asked.
 *
 * Measured live: a Pi `Write` outside the session root raised "Allow write access outside the session root", the call
 * ended "Tool execution timed out" (the executor's deadline, `pi-harness/tool-executor.ts`) — twice, a retry did the
 * same — and both cards stayed on screen after the calls and the turn had ended. Nothing tied the request to its call:
 * the deadline aborts the call's signal and fails the call, but the suspended `requestOutsideRootApproval` promise kept
 * its `pendingOutsideRoot` entry and the host kept its card, so the only answer left was one no call was waiting for.
 *
 * The shape is `requestAskUser`'s (`index.ts`), the in-repo precedent for the same problem: on the asking call's abort
 * the pending entry is dropped, the host is told with `outside_root_cancel` (the host withdraws the card with that
 * reason, `PiAgent.handleOutsideRootCancel`), and the suspended scope check resolves `null` — the denial it already had
 * for every other ending, although nobody reads it, because the executor has already failed the call.
 *
 * An answer that arrives first detaches the listener, so an answered request never sends a cancel. A request with no
 * signal (a caller outside the tool executor) keeps the old lifetime. A signal already aborted when the request is
 * made still sends the request and then the cancel at once: the host raises and withdraws it in one dispatch pass,
 * which keeps this helper free of a second decision about whether to ask at all.
 */
import type { SessionFilesystemScopeRoot } from '@nessy-agent/shared/agent/session-filesystem-scope'

export interface PendingOutsideRootEntry {
  resolve: (root: SessionFilesystemScopeRoot | null) => void
  refuse: (reason: string) => void
}

export interface OutsideRootCancelMessage {
  type: 'outside_root_cancel'
  requestId: string
  reason: 'timed_out' | 'aborted'
}

/**
 * Bind the pending entry registered under `requestId` to the asking call's `signal`. Call it right after the entry is
 * set; it re-registers a wrapped entry whose settle detaches the listener.
 */
export function bindOutsideRootRequestToCall(
  pending: Map<string, PendingOutsideRootEntry>,
  requestId: string,
  signal: AbortSignal | undefined,
  send: (message: OutsideRootCancelMessage) => void,
): void {
  const entry = pending.get(requestId)
  if (!signal || !entry) return
  const onAbort = () => {
    if (pending.get(requestId) !== wrapped) return
    pending.delete(requestId)
    send({ type: 'outside_root_cancel', requestId, reason: signal.reason === 'timed_out' ? 'timed_out' : 'aborted' })
    entry.resolve(null)
  }
  const wrapped: PendingOutsideRootEntry = {
    resolve: root => { signal.removeEventListener('abort', onAbort); entry.resolve(root) },
    refuse: reason => { signal.removeEventListener('abort', onAbort); entry.refuse(reason) },
  }
  pending.set(requestId, wrapped)
  if (signal.aborted) { onAbort(); return }
  signal.addEventListener('abort', onAbort, { once: true })
}
