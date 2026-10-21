/**
 * Derives the pet animation state purely from the global agent event stream
 * (`electronAPI.onSessionEvent`), so it works in any window — including the
 * standalone desktop-pet window that has no access to the main window's Jotai
 * session atoms.
 *
 *   activity events (text/tool/status) -> running
 *   permission_request                 -> waiting
 *   complete                           -> jumping (brief) then idle
 *   error / interrupted                -> failed (brief) then idle
 *
 * [nessy-fork] desktop-pet-session-aggregation: external CLI sessions
 * (terminal TUI / ACP) feed the same helpers via `pet:sessionUpdate` phase
 * snapshots — one pet, all session types.
 */
import { useEffect, useRef, useState } from 'react';
import type {
  PetSessionUpdate,
  SessionEvent,
} from '@craft-agent/shared/protocol';
import { mapPhaseToPetState } from './pet-session-mapping';
import type { PetState } from './pet-animation';

const TRANSIENT_MS: Record<'jumping' | 'failed', number> = {
  jumping: 1300,
  failed: 2600,
};

// Safety net: if a turn streams activity but never emits a terminal event,
// fall back to idle after this much silence.
const ACTIVITY_TIMEOUT_MS = 10_000;

const ACTIVITY_EVENTS = new Set([
  'text_delta',
  'text_complete',
  'tool_result',
  'status',
  'task_progress',
]);

export function usePetActivityState(): PetState {
  const [processing, setProcessing] = useState(false);
  const [awaiting, setAwaiting] = useState(false);
  const [transient, setTransient] = useState<PetState | null>(null);

  const transientTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activityTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Sessions currently waiting for user input — the pose is 'waiting' iff
  // the set is non-empty. A Set (not a single ref) so concurrent waiting
  // sessions don't collapse: answering B must not clear A's pose.
  const awaitingSessions = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!window.electronAPI?.onSessionEvent && !window.electronAPI?.onPetSessionUpdate)
      return;

    const flash = (next: 'jumping' | 'failed') => {
      setTransient(next);
      if (transientTimer.current) clearTimeout(transientTimer.current);
      transientTimer.current = setTimeout(
        () => setTransient(null),
        TRANSIENT_MS[next],
      );
    };

    const stopActivity = () => {
      setProcessing(false);
      if (activityTimer.current) clearTimeout(activityTimer.current);
    };

    // Activity does NOT clear awaiting: the existing priority model
    // (transient > awaiting > processing > idle) puts waiting higher, and
    // a running sibling session must not tear down another session's
    // waiting pose (the watcher dedups — it won't re-fire).
    const markActivity = () => {
      setProcessing(true);
      if (activityTimer.current) clearTimeout(activityTimer.current);
      activityTimer.current = setTimeout(
        () => setProcessing(false),
        ACTIVITY_TIMEOUT_MS,
      );
    };

    const startAwaiting = (sessionId: string) => {
      awaitingSessions.current.add(sessionId);
      setAwaiting(true);
    };

    const stopAwaiting = (sessionId: string) => {
      awaitingSessions.current.delete(sessionId);
      if (awaitingSessions.current.size === 0) setAwaiting(false);
    };

    const cleanup = window.electronAPI?.onSessionEvent?.((event: SessionEvent) => {
      const sessionId = (event as { sessionId?: string }).sessionId;
      if (!sessionId) return;
      switch (event.type) {
        case 'permission_request':
        case 'elicitation_request':
          startAwaiting(sessionId);
          break;
        case 'complete':
          stopAwaiting(sessionId);
          stopActivity();
          flash('jumping');
          break;
        case 'error':
        case 'interrupted':
          stopAwaiting(sessionId);
          stopActivity();
          flash('failed');
          break;
        default:
          if (ACTIVITY_EVENTS.has(event.type)) markActivity();
          break;
      }
    });

    // External CLI session phases reuse the same helpers via the pure
    // mapping; identical phases are deduped by the watcher, so no extra
    // churn guard is needed here.
    const cleanupPet = window.electronAPI?.onPetSessionUpdate?.(
      (update: PetSessionUpdate) => {
        if (update.phase === 'waiting_input') {
          stopActivity();
          startAwaiting(update.sessionId);
          return;
        }
        const state = mapPhaseToPetState(update.phase);
        if (state === 'running') markActivity();
        else if (state === 'jumping') {
          stopAwaiting(update.sessionId);
          stopActivity();
          flash('jumping');
        } else {
          // idle | gone — no animation; stop draining AND clear awaiting:
          // the watcher emits 'gone' exactly once before forgetting the
          // session, so nothing else would ever reset the waiting pose.
          stopAwaiting(update.sessionId);
          stopActivity();
        }
      },
    );

    return () => {
      cleanup?.();
      cleanupPet?.();
      if (transientTimer.current) clearTimeout(transientTimer.current);
      if (activityTimer.current) clearTimeout(activityTimer.current);
    };
  }, []);

  if (transient) return transient;
  if (awaiting) return 'waiting';
  if (processing) return 'running';
  return 'idle';
}
