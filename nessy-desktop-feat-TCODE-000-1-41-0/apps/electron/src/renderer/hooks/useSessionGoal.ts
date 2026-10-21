import * as React from 'react'
import type { PiHarnessGoalSummaryV1, PiHarnessRuntimeSnapshotV1 } from '@nessy-agent/core/types'
import type { PiHarnessRuntimeElectronApi } from '../../shared/types'

/**
 * The active session goal, for the above-composer strip (P6.476).
 *
 * WHY A HOOK AND NOT A PROP. `SessionGoalBadge`'s own docblock proposed threading
 * `goal` down from `ChatInputZone`. It is not threaded: `ActiveOptionBadges`
 * already receives `sessionId` and `workspaceId`, which is everything the read
 * needs, and sourcing it here keeps the mount to one file instead of a prop
 * added to two signatures that nothing else in either would use. Same shape as
 * `useAgentPanel`, which reads the same snapshot for the child rows.
 *
 * READ-ONLY, BY THE OWNER'S 2026-09-05 Q3 RULING — option A: mount the drafted
 * chip read-only. There is deliberately no control action here; the
 * `goal_create`/`goal_cancel` control verbs exist on the wire and stay unused by
 * this surface.
 *
 * IT IS PROVIDER-BLIND, and that is load-bearing rather than incidental. Since
 * P2.2 the goal is host-side on Pi, claude and codex alike, and P2.488 carried
 * `goal` past `getPiHarnessRuntimeSnapshot`'s `provider !== 'pi'` early return
 * and widened `emitPiHarnessInvalidation`'s gate to the same
 * `SCHEDULED_DELIVERY_RUNTIMES` constant. So both halves — the read and the
 * invalidation — answer on all three runtimes at HEAD; a chip that appeared only
 * on Pi would be exactly the silent divergence `AGENTS.md` names as this fork's
 * largest defect class.
 *
 * EVERY FAILURE IS "NO GOAL". The API is absent in the playground and in any
 * render outside Electron, and a session with no Pi harness yet simply has none —
 * all of it collapses to `undefined`, which is the state the chip renders as
 * nothing.
 */
export function useSessionGoal(sessionId?: string, workspaceId?: string): PiHarnessGoalSummaryV1 | undefined {
  const [goal, setGoal] = React.useState<PiHarnessGoalSummaryV1 | undefined>(undefined)

  React.useEffect(() => {
    if (!sessionId || !workspaceId) {
      setGoal(undefined)
      return
    }
    let cancelled = false
    const api = window.electronAPI as (typeof window.electronAPI & PiHarnessRuntimeElectronApi) | undefined

    const reload = async () => {
      try {
        const result = await api?.getPiHarnessRuntime({ workspaceId, sessionId })
        if (cancelled) return
        const snapshot = result?.snapshot as PiHarnessRuntimeSnapshotV1 | undefined
        setGoal(snapshot?.goal)
      } catch {
        if (!cancelled) setGoal(undefined)
      }
    }

    void reload()

    let dispose: (() => void) | undefined
    try {
      dispose = api?.onPiHarnessRuntimeInvalidated(({ event }) => {
        if (event.session.workspaceId !== workspaceId || event.session.sessionId !== sessionId) return
        if (!event.changedDomains.includes('goal')) return
        void reload()
      })
    } catch {
      dispose = undefined
    }
    return () => {
      cancelled = true
      dispose?.()
    }
  }, [sessionId, workspaceId])

  return goal
}
