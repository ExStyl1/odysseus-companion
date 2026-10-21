/* UA4.4 (Nessy; no v0.13.4 counterpart) — the renderer half of the Run UI, pure so `bun test` pins it without a
   React tree:
   - `resolveRunControls`: the Results tab's Pause / Resume / Stop for a run status, as `TaskRunner` honours them
     (`pause` acts on a running run only, `resume` on a paused one or — after a restart — an interrupted one, `stop`
     on anything not terminal). Upstream's Results tab had no run controls; spec §11 item 7 asks for Resume on an
     interrupted run.
   - `startTaskRun`: the ONE run path the tile's Play and the editor's Create & Run / Save & Run take. The host
     enforces the run confirmation (`rpc/tasks.ts` header, spec §10): when `tasks:get` says the spec on disk is not the
     last one a human saved or confirmed, the user is shown `runConfirmation` first, and the run carries the digest
     they confirmed. A spec edited on disk between that read and the run is refused by the host
     (`run-confirmation-required`); this path then reads again and asks once more.
   - `describeConfirmationNode`: how the confirmation names a node's runtime and connection from the editor's model
     catalogue (a node naming no connection runs on the workspace default, as `TaskRunner.dispatch` leaves it). */
import type { TaskGetResult, TaskRunConfirmationDto, TaskRunRequest, TaskRunSnapshotDto } from '@nessy-agent/shared/protocol'
import type { ModelProvider } from '@config/models'
import type { TaskModelGroup } from './model-catalog'

export type RunControl = 'pause' | 'resume' | 'stop'

const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'stopped'])

/** The run controls the Results tab offers for `runStatus` (`tasks:getResults`); none when there is no run. */
export function resolveRunControls(runStatus: string | undefined): RunControl[] {
  if (!runStatus || TERMINAL_RUN_STATUSES.has(runStatus)) return []
  if (runStatus === 'running') return ['pause', 'stop']
  if (runStatus === 'paused' || runStatus === 'interrupted') return ['resume', 'stop']
  return ['stop'] // verifying (and any later non-terminal status): the run can be stopped, not paused
}

/** The slice of `window.electronAPI` a run needs. */
export interface TaskRunApi {
  getTask(workspaceId: string, slug: string): Promise<Pick<TaskGetResult, 'needsRunConfirmation' | 'runConfirmation'>>
  runTask(workspaceId: string, req: TaskRunRequest): Promise<TaskRunSnapshotDto>
}

/** Shows the run confirmation; resolves true when the user chose Run. */
export type ConfirmTaskRun = (confirmation: TaskRunConfirmationDto) => Promise<boolean>

export const RUN_CONFIRMATION_REQUIRED = 'run-confirmation-required'

function isConfirmationRefusal(error: unknown): boolean {
  return (error instanceof Error ? error.message : String(error ?? '')).includes(RUN_CONFIRMATION_REQUIRED)
}

/**
 * Start a run of `req.slug` on its orchestrator, asking first when the host says the spec needs a confirmation.
 * Resolves null when the user declined (nothing was sent to `tasks:run`).
 */
export async function startTaskRun(
  api: TaskRunApi,
  workspaceId: string,
  req: { slug: string; orchestratorSessionId: string },
  confirm: ConfirmTaskRun,
): Promise<TaskRunSnapshotDto | null> {
  const attempt = async (retried: boolean): Promise<TaskRunSnapshotDto | null> => {
    const got = await api.getTask(workspaceId, req.slug)
    let confirmedDigest: string | undefined
    if (got.needsRunConfirmation) {
      // The host sends what to show whenever it asks; a missing one is its refusal, never a silent run.
      if (!got.runConfirmation) throw new Error(`${RUN_CONFIRMATION_REQUIRED}: ${req.slug}`)
      if (!(await confirm(got.runConfirmation))) return null
      confirmedDigest = got.runConfirmation.digest
    }
    try {
      return await api.runTask(workspaceId, { slug: req.slug, orchestratorSessionId: req.orchestratorSessionId, ...(confirmedDigest ? { confirmedDigest } : {}) })
    } catch (error) {
      if (retried || !isConfirmationRefusal(error)) throw error
      return attempt(true) // the spec changed on disk after the read: show what will run now
    }
  }
  return attempt(false)
}

/** A node's runtime and connection as the confirmation names them. */
export interface ConfirmationNodeView {
  /** The connection's name, else its slug; undefined only when no connection is known at all. */
  connectionLabel?: string
  /** The runtime that connection runs on; undefined for a connection the catalogue does not list. */
  runtime?: ModelProvider
  /** True when the node names no connection and runs on the workspace default. */
  workspaceDefault: boolean
}

export function describeConfirmationNode(
  node: { llmConnection?: string },
  groups: readonly TaskModelGroup[],
  defaultConnectionSlug: string | undefined,
): ConfirmationNodeView {
  const slug = node.llmConnection ?? defaultConnectionSlug
  const group = slug ? groups.find(g => g.connectionSlug === slug) : undefined
  return {
    ...(group ? { connectionLabel: group.label, runtime: group.runtime } : slug ? { connectionLabel: slug } : {}),
    workspaceDefault: !node.llmConnection,
  }
}
