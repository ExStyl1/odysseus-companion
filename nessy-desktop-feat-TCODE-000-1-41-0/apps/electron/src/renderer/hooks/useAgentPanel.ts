import * as React from 'react'
import type {
  PiHarnessRuntimeControlRequestV1,
  PiHarnessRuntimeControlResultV1,
  PiHarnessRuntimeSnapshotV1,
} from '@nessy-agent/core/types'
import type { PiHarnessRuntimeElectronApi } from '../../shared/types'
import { isAgentChildListed, toAgentPanelRows, type AgentPanelRow } from '@/components/app-shell/AgentPanel' // F1.806

/**
 * Data and controls for the observe-and-steer panel (`sub-agents.md:1021`).
 *
 * Nothing here is new machinery: the child list is the Pi harness runtime
 * snapshot, and open / follow-up / stop are the `read_child`, `steer_child` and
 * `stop_child` control actions that already existed for the runtime control
 * centre. This hook only points them at a surface the user can reach.
 */
export interface UseAgentPanelResult {
  rows: AgentPanelRow[]
  transcripts: Record<string, string>
  /** The last refusal per agent id, cleared when that row is driven again. */
  errors: Record<string, string>
  openTranscript: (agentId: string) => void
  /** Resolves false when the control refused, so the caller can keep the text. */
  followUp: (agentId: string, message: string) => Promise<boolean>
  dismiss: (agentId: string, running: boolean) => void
}

export type AgentPanelControl = (request: PiHarnessRuntimeControlRequestV1) => Promise<PiHarnessRuntimeControlResultV1>

export type AgentPanelControlOutcome =
  | { ok: true; result: PiHarnessRuntimeControlResultV1 }
  | { ok: false; reason: string }

/**
 * Issue one runtime control and REPORT what came back.
 *
 * Every control the panel issues used to end in `.catch(() => null)` and never
 * read `ok`, so `child-session-not-active`, `child-session-not-running` and
 * `pi-child-service-unavailable` all rendered as a cleared input box — the user
 * saw their message vanish and had no way to tell a delivered follow-up from a
 * refused one (`docs/testing/cdp-live-checklist.md`, AGT-2, 2026-07-30).
 *
 * Both failure shapes reach here and both must be reported: `ChildSessionService`
 * THROWS its refusals (they arrive as a rejected IPC call), while the control
 * result carries `{ok: false, error}` for the ones the host answers with. A
 * refusal with no message still yields a reason — an unattributable failure is
 * the thing being removed, so "" is never a valid answer.
 */
export async function runAgentPanelControl(
  control: AgentPanelControl,
  request: PiHarnessRuntimeControlRequestV1,
): Promise<AgentPanelControlOutcome> {
  let result: PiHarnessRuntimeControlResultV1
  try {
    result = await control(request)
  } catch (error) {
    return { ok: false, reason: controlFailureReason(error) }
  }
  if (!result?.ok) return { ok: false, reason: controlFailureReason(result?.error) }
  return { ok: true, result }
}

/** The shortest text that still names WHICH refusal happened. */
function controlFailureReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : 'unknown-error'
}

function runtimeApi(): typeof window.electronAPI & PiHarnessRuntimeElectronApi {
  return window.electronAPI as typeof window.electronAPI & PiHarnessRuntimeElectronApi
}

export function useAgentPanel(sessionId: string, workspaceId: string): UseAgentPanelResult {
  const [rows, setRows] = React.useState<AgentPanelRow[]>([])
  const [transcripts, setTranscripts] = React.useState<Record<string, string>>({})
  const [errors, setErrors] = React.useState<Record<string, string>>({})
  const cursorsRef = React.useRef<Record<string, number>>({})
  /**
   * Rows the user dismissed, for this session view's lifetime. `dismiss` used
   * to filter local state only, so the next `children` invalidation rebuilt
   * the rows from `childState` and the dismissed row CAME BACK — measured live
   * by AGT-2 (2026-07-31, `rows-after-dismiss-settle: 1`). The durable child
   * record still lives in the parent's history; dismissal hides the row, it
   * does not delete the child.
   */
  const dismissedRef = React.useRef<Set<string>>(new Set())

  const reload = React.useCallback(async () => {
    if (!sessionId || !workspaceId) return
    try {
      const result = await runtimeApi().getPiHarnessRuntime({ workspaceId, sessionId })
      const snapshot: PiHarnessRuntimeSnapshotV1 = result.snapshot
      setRows(toAgentPanelRows((snapshot.childState?.children ?? []).filter(isAgentChildListed))
        .filter(row => !dismissedRef.current.has(row.agentId)))
    } catch {
      // A session with no Pi runtime yet simply has no rows; the panel hides.
      setRows([])
    }
  }, [sessionId, workspaceId])

  React.useEffect(() => {
    cursorsRef.current = {}
    setTranscripts({})
    dismissedRef.current = new Set()
    void reload()
    let dispose: (() => void) | undefined
    try {
      dispose = runtimeApi().onPiHarnessRuntimeInvalidated(({ event }) => {
        if (event.session.workspaceId !== workspaceId || event.session.sessionId !== sessionId) return
        if (!event.changedDomains.includes('children')) return
        void reload()
      })
    } catch {
      dispose = undefined
    }
    return () => dispose?.()
  }, [reload, sessionId, workspaceId])

  const control = React.useCallback(async (request: PiHarnessRuntimeControlRequestV1) => {
    return runtimeApi().controlPiHarnessRuntime(request)
  }, [])

  /** Drive one row, and leave the refusal where the user acted. */
  const drive = React.useCallback(async (agentId: string, request: PiHarnessRuntimeControlRequestV1) => {
    setErrors(current => {
      if (!(agentId in current)) return current
      const next = { ...current }
      delete next[agentId]
      return next
    })
    const outcome = await runAgentPanelControl(control, request)
    if (!outcome.ok) setErrors(current => ({ ...current, [agentId]: outcome.reason }))
    return outcome
  }, [control])

  const openTranscript = React.useCallback((agentId: string) => {
    void (async () => {
      const outcome = await drive(agentId, {
        schemaVersion: 1,
        session: { workspaceId, sessionId },
        action: 'read_child',
        agentId,
        cursor: cursorsRef.current[agentId] ?? 0,
      })
      if (!outcome.ok) return
      const { result } = outcome
      if (result.nextCursor !== undefined) cursorsRef.current[agentId] = result.nextCursor
      if (result.output) {
        setTranscripts(current => ({ ...current, [agentId]: `${current[agentId] ?? ''}${result.output}` }))
      }
    })()
  }, [drive, sessionId, workspaceId])

  const followUp = React.useCallback(async (agentId: string, message: string) => {
    const outcome = await drive(agentId, {
      schemaVersion: 1,
      session: { workspaceId, sessionId },
      action: 'steer_child',
      agentId,
      message,
    })
    return outcome.ok
  }, [drive, sessionId, workspaceId])

  const dismiss = React.useCallback((agentId: string, running: boolean) => {
    if (running) {
      void (async () => {
        // The row's `running` prop can be STALE: a fork that just finished (or
        // was just stopped) still renders `running` until the next children
        // invalidation lands, and a click in that window used to send a second
        // stop instead of dismissing — the row then sat forever (measured live
        // by AGT-2 twice, race-dependent). Decide from the freshest snapshot,
        // not the render prop.
        const fresh = await runtimeApi()
          .getPiHarnessRuntime({ workspaceId, sessionId })
          .then(result => (result.snapshot.childState?.children ?? []).find(child => child.agentId === agentId))
          .catch(() => undefined)
        const stillLive = fresh !== undefined && (fresh.status === 'starting' || fresh.status === 'running')
        if (stillLive) {
          const outcome = await drive(agentId, {
            schemaVersion: 1,
            session: { workspaceId, sessionId },
            action: 'stop_child',
            agentId,
          })
          if (outcome.ok) await reload()
          return
        }
        dismissedRef.current.add(agentId)
        setRows(current => current.filter(row => row.agentId !== agentId))
      })()
      return
    }
    // A finished row is dismissed from the panel only; the durable child record
    // is the parent's own history and is not deleted by looking away from it.
    // Recorded in dismissedRef so a `children` invalidation cannot resurrect it.
    dismissedRef.current.add(agentId)
    setRows(current => current.filter(row => row.agentId !== agentId))
  }, [drive, reload, sessionId, workspaceId])

  return { rows, transcripts, errors, openTranscript, followUp, dismiss }
}
