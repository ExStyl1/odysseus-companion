import * as React from 'react'
import type { SessionScheduledWorkPageV1 } from '@nessy-agent/shared/protocol'
import { asSessionScheduledWorkPage } from '@/lib/scheduled-work-chips'

/**
 * D1.97 + D1.98 — this session's scheduled work and the background work the
 * event feed cannot mint, read through `sessions:listScheduledWork`.
 *
 * WHY A HOOK AND NOT A PROP, and the precedent is beside it: `useSessionGoal`
 * takes the same shape for the same reason — `ActiveOptionBadges` already has
 * `sessionId`, which is everything the read needs, so sourcing it there keeps
 * the mount to one call instead of a prop added to three signatures that
 * nothing else in any of them would use.
 *
 * READ-ONLY. There is no control verb here: a cron record is stopped from the
 * automations surface that owns it, and a monitor from the service that started
 * it. The running rows keep their own Stop item, which comes from the atom and
 * not from this read.
 *
 * ## `revision` is every refresh signal this renderer has, and they are named
 *
 * The wire has a read and, until D1.269's host half exists, no feed. What the
 * renderer has always had is the background-task atom, which moves whenever the
 * session starts or finishes an agent or a shell — a cheap and honest
 * approximation of "the session's background work moved". D1.269 adds the second
 * half: a `scheduled_work_changed` nudge from the host, counted per session and
 * folded into the same value by
 * {@link scheduledWorkRevision}, which is a COMPOSITE and not a sum for the
 * reason stated there (the two counters move in opposite directions and a sum
 * can cancel).
 *
 * **The residue is stated rather than hidden, and it is now the PRODUCER's:**
 * with no nudge on the wire, a cron record created while the session is open and
 * nothing else happening still appears at the next task change or the next
 * session switch. The renderer half cannot close that alone.
 *
 * ## Every failure is silence, and that is not the same as `unavailable`
 *
 * The API is absent outside Electron (the playground renders this component
 * too), which is what the optional chain is for. Inside Electron a failed call
 * REJECTS and the `catch` below takes it: the preload resolves it with an error
 * envelope and the renderer entry rehydrates that envelope into a real `Error`
 * before product code sees it (D1.267 — the sentence that stood here said the
 * envelope reached this line, and it does not). The answer is filtered through
 * {@link asSessionScheduledWorkPage} anyway, which is what keeps a surface that
 * builds the API without that entry safe, and anything that is not a page
 * becomes `undefined`. `undefined` renders nothing. The host's own `unavailable`
 * answer is a different fact and survives on the page, where the bar turns it
 * into one sentence.
 */
export function useSessionScheduledWork(
  sessionId?: string,
  revision?: number | string,
): SessionScheduledWorkPageV1 | undefined {
  const [page, setPage] = React.useState<SessionScheduledWorkPageV1 | undefined>(undefined)

  React.useEffect(() => {
    if (!sessionId) {
      setPage(undefined)
      return
    }
    let cancelled = false
    const read = async () => {
      try {
        const answer = await window.electronAPI?.listSessionScheduledWork(sessionId)
        if (cancelled) return
        const parsed = asSessionScheduledWorkPage(answer)
        if (!parsed && answer !== undefined) {
          // The unusable answer is a DIAGNOSTIC and never reaches the user —
          // the same rule `StopTaskOutcome.failureDetail` states for the stop
          // routes. Without this line an unreachable channel is indistinguishable
          // from a session with nothing queued.
          console.error('[useSessionScheduledWork] unusable answer for', sessionId, answer)
        }
        setPage(parsed)
      } catch {
        if (!cancelled) setPage(undefined)
      }
    }
    void read()
    return () => { cancelled = true }
  }, [sessionId, revision])

  return page
}
