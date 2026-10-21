/* Moved from v0.13.4:apps/electron/src/renderer/components/app-shell/kanban/KanbanBoardContainer.tsx
   (craft-agents-oss, Apache-2.0) by UA2.4, 2026-10-02: `deriveRunState` (L36–L53) and the
   container's `tasks` memo body (L238–L289) as one pure function, so `bun test` pins the
   board's derivation without loading the container's context graph. UA3.6 restored
   v0.13.4 L256–L267 and L279: a spec-backed tile's rows merge its DAG nodes with its children
   (`mergeSubtaskRows`), from the nodes the container fetched (`BoardDeriveContext.specNodesBySlug`).
   UA2.5 (Nessy adaptation, spec §9): the optional third argument carries what the tile's
   needs-input badge, runtime chip and ModelChip fallback read — this window's live cards
   and the workspace's connections — so the derivation stays pure and testable.
   UA12.46 (Nessy divergence, reason (c): our gateway aliases — upstream's `DEFAULT_MODEL` is an Anthropic
   model a Nessy Gateway workspace does not serve): upstream's `model ?? DEFAULT_MODEL` (L260, L273 and
   `mergeSubtaskRows(…, DEFAULT_MODEL)` of L267) became the model the session WILL run on — its own model,
   else its effective connection's default named as the catalogue names it (`resolveSessionTaskModel`,
   model-catalog.ts; the composer's own resolution) — and a never-run spec node with no model shows the
   default of the connection the Conductor runs it on (the node's, the spec's, else the workspace default);
   with nothing to name, the tile and row show no model chip.
   UA12.69: a subtask row also carries `connection` — the icon inputs of the connection its model was
   resolved from, projected the same way the tile's is — so its ModelChip draws that connection's icon
   and an alias row's name and icon cannot disagree (the UA12.46 re-check's residue). A row (child or
   never-run node) whose own `llmConnection` names a known connection carries THAT one first, as the
   tile's deriveTileAttention does — also when the row names its model outright (the 2026-10-08
   follow-up: a gateway row naming `coder` drew Anthropic's icon); a registry model keeps its own icon.
   UA4.4 (Nessy, spec §11 item 4): a spec-backed tile whose latest run logged `node-woke-after-done` carries
   `wokeAfterDone` (the container's `tasks:get` fetch, `BoardDeriveContext.wokeAfterDoneBySlug`).
   UA12.77 (Nessy, spec §11 item 2 "A node blocked on a card shows needs-input"): every session-backed subtask row
   carries the needs-input fields of its CHILD session (`deriveSubtaskAttention`, the tile's own predicate), joined
   after `mergeSubtaskRows` so that verbatim copy stays untouched; a never-run node row has no session and no badge. */
import { getSessionTitle } from '@/utils/session'
import type { LlmProviderType } from '@config/llm-connections'
import type { PermissionRequestType } from '@nessy-agent/core/types'
import { sessionAttentionPrompt, sessionAwaitsApproval, type SessionMeta } from '@/atoms/sessions'
import type { SessionStatus } from '@/config/session-status-config'
import { runtimeForProviderType } from '../input/runtime-switch-copy'
import { statusToColumn } from './status-column'
import { mergeSubtaskRows, type SpecNodeSummary, type SubtaskChildRow } from './subtask-merge'
import { resolveSessionTaskModel, type TaskModelConnection } from './model-catalog'
import type { KanbanSubtask, KanbanTask, KanbanTaskConnection, SubtaskRunState } from './types'

/**
 * UA2.5 — what the board reads beside the session metadata, both from `AppShellContext`.
 *
 * - `pendingPermissions`: this window's live permission cards per session. Unioned with
 *   the server's `awaitingApprovalCount` through `sessionAwaitsApproval`, exactly as the
 *   session list's row does (P6.757), so a tile and its row cannot disagree.
 * - `connections`: the workspace's LLM connections, for the runtime chip (`providerType`)
 *   and ModelChip's icon fallback. A slug not in this list is an unknown connection.
 */
export interface BoardDeriveContext {
  pendingPermissions?: ReadonlyMap<string, ReadonlyArray<{ type?: PermissionRequestType; toolName?: string }>>
  connections?: ReadonlyArray<KanbanTaskConnection & Omit<TaskModelConnection, keyof KanbanTaskConnection>>
  /**
   * UA12.46 — the workspace's default connection (`AppShellContext.workspaceDefaultLlmConnection`): the one a
   * session that names no connection runs on, so the model its tile shows ({@link resolveSessionTaskModel}).
   */
  workspaceDefaultConnection?: string
  /**
   * UA3.6 — the DAG nodes of each spec-backed tile, keyed by task slug (the container's
   * `tasks:get` fetch, v0.13.4 L187–L236). A slug absent here (not fetched yet, or an
   * unreadable spec) keeps the children-only rows.
   */
  specNodesBySlug?: ReadonlyMap<string, SpecNodeSummary[]>
  /** UA4.4 — per task slug, the latest run's nodes whose session worked again after done (`tasks:get`). */
  wokeAfterDoneBySlug?: ReadonlyMap<string, readonly string[]>
}

/**
 * UA2.5 — the tile's needs-input and runtime fields for one top-level session. The badge
 * is decided by the count (or a live card) alone; the subject pair only names the request,
 * so a request with no `toolName` still shows the badge.
 */
export function deriveTileAttention(
  meta: SessionMeta,
  context: BoardDeriveContext | undefined
): Pick<KanbanTask, 'needsInput' | 'waitingOn' | 'runtime' | 'connection'> {
  const localPrompt = context?.pendingPermissions?.get(meta.id)?.[0] ?? null
  const needsInput = sessionAwaitsApproval(meta, localPrompt !== null)
  const waitingOn = needsInput
    ? sessionAttentionPrompt(meta, localPrompt)
    : undefined
  const found = meta.llmConnection
    ? context?.connections?.find(connection => connection.slug === meta.llmConnection)
    : undefined
  return {
    ...(needsInput ? { needsInput } : {}),
    ...(waitingOn ? { waitingOn } : {}),
    ...(found
      ? {
          runtime: runtimeForProviderType(found.providerType as LlmProviderType),
          connection: { providerType: found.providerType, baseUrl: found.baseUrl, piAuthProvider: found.piAuthProvider },
        }
      : {}),
  }
}

/**
 * UA12.77 — a subtask row's needs-input fields: its child session's, by the tile's predicate
 * ({@link deriveTileAttention}: the server's count unioned with this window's live card), so a row
 * and the list row of that session cannot disagree.
 */
export function deriveSubtaskAttention(
  child: SessionMeta | undefined,
  context: BoardDeriveContext | undefined
): Pick<KanbanSubtask, 'needsInput' | 'waitingOn'> {
  if (!child) return {}
  const { needsInput, waitingOn } = deriveTileAttention(child, context)
  return { ...(needsInput ? { needsInput } : {}), ...(waitingOn ? { waitingOn } : {}) }
}

/**
 * Subtask run-state from the child session. A closed status wins (done), then an
 * in-flight turn (running). A subtask that has exchanged at least one message has
 * been dispatched — in the create-then-run flow these are one-shot, so a finished
 * turn reads as done. Only a created-but-never-run child (no messages) is pending —
 * and that is exactly what the tile's Play button dispatches. `lastMessageAt` can't
 * carry this distinction: the server stamps it at creation time as a sort key.
 */
export function deriveRunState(child: SessionMeta, statusesById: Map<string, SessionStatus>): SubtaskRunState {
  if (statusesById.get(child.sessionStatus ?? '')?.category === 'closed') return 'done'
  // The Conductor marks a failed node 'needs-review' (there is no 'failed' session
  // status), so within a task that reads as a failed subtask on the board. v1 heuristic;
  // the precise source is the run-log node-state (P1 inspector wires the live run snapshot).
  if (child.sessionStatus === 'needs-review') return 'failed'
  if (child.isProcessing) return 'running'
  if ((child.messageCount ?? 0) > 0) return 'done'
  return 'pending'
}

/**
 * UA12.69 — the icon inputs a subtask row's ModelChip reads (`KanbanSubtask.connection`), the same
 * projection of a resolved connection the tile's `tileModel` makes. A session naming its own
 * registry model resolves none: the chip takes that icon from the registry.
 */
function kanbanConnectionInputs(connection: TaskModelConnection | undefined): KanbanTaskConnection | undefined {
  return connection
    ? { providerType: connection.providerType, baseUrl: connection.baseUrl, piAuthProvider: connection.piAuthProvider }
    : undefined
}

/**
 * The board's tiles from the session metadata map (upstream's `tasks` memo, pure):
 * top-level sessions become task tiles, child sessions (those carrying a
 * `parentSessionId`) become subtask rows under their parent; archived, hidden and
 * draft sessions are not tiles. Column placement comes from the persisted
 * `kanbanColumn`, falling back to the session status' default column; the status
 * badge is independent from the column.
 */
export function deriveBoardTasks(
  metaMap: ReadonlyMap<string, SessionMeta>,
  statusesById: Map<string, SessionStatus>,
  context?: BoardDeriveContext
): KanbanTask[] {
  const childrenByParent = new Map<string, SessionMeta[]>()
  for (const meta of metaMap.values()) {
    if (!meta.parentSessionId) continue
    const siblings = childrenByParent.get(meta.parentSessionId)
    if (siblings) siblings.push(meta)
    else childrenByParent.set(meta.parentSessionId, [meta])
  }

  // UA12.46 — the model a session will run on, never upstream's `DEFAULT_MODEL` (see the header).
  const connections: readonly TaskModelConnection[] | undefined = context?.connections
  // A never-run node runs on `node.llmConnection ?? spec.defaults.llmConnection` (TaskRunner), so its row resolves
  // through that connection exactly like a session naming it — never one fallback shared by every node.
  // UA12.69 follow-up — a row naming its model outright still draws the connection it NAMES, exactly as the tile
  // does (deriveTileAttention): the common gateway row names `coder` (a child runs `node.model ?? defaults.model`).
  const ownConnection = (slug: string | undefined): TaskModelConnection | undefined =>
    slug ? connections?.find(connection => connection.slug === slug) : undefined
  const withNodeModels = (nodes: readonly SpecNodeSummary[] | undefined): SpecNodeSummary[] | undefined =>
    nodes?.map(n => {
      if (n.model) {
        const own = ownConnection(n.llmConnection)
        return own ? { ...n, connection: kanbanConnectionInputs(own) } : n
      }
      // UA12.69 — the icon inputs travel beside the resolved model (the row's chip draws them).
      const resolved = resolveSessionTaskModel(n, connections, context?.workspaceDefaultConnection)
      return { ...n, model: resolved.model, connection: kanbanConnectionInputs(resolved.connection) }
    })
  const tileModel = (meta: SessionMeta): Pick<KanbanTask, 'model' | 'connection'> => {
    const resolved = resolveSessionTaskModel(meta, connections, context?.workspaceDefaultConnection)
    const icon = resolved.connection
    return {
      ...(resolved.model ? { model: resolved.model } : {}),
      // ModelChip's icon for a model resolved through a connection the session does not name; a session's own
      // known connection overrides it below (deriveTileAttention).
      ...(icon ? { connection: { providerType: icon.providerType, baseUrl: icon.baseUrl, piAuthProvider: icon.piAuthProvider } } : {}),
    }
  }
  const result: KanbanTask[] = []
  for (const meta of metaMap.values()) {
    if (meta.parentSessionId) continue
    if (meta.isArchived || meta.hidden || meta.taskDraft) continue
    const statusId = meta.sessionStatus ?? 'todo'
    // Placement is the persisted free-string column, else the status' default column.
    // Validity against the *active* column set is enforced by KanbanBoard (unknown
    // ids fall back to the first column), so no built-in-only guard is needed here.
    const column = meta.kanbanColumn ?? statusToColumn(statusId)
    const children: SubtaskChildRow[] = (childrenByParent.get(meta.id) ?? []).map(child => {
      // UA12.69 — the row's model and its icon inputs come from the ONE resolution (see the header).
      const resolved = resolveSessionTaskModel(child, connections, context?.workspaceDefaultConnection)
      return {
        id: child.id,
        title: getSessionTitle(child),
        runState: deriveRunState(child, statusesById),
        model: resolved.model,
        connection: kanbanConnectionInputs(ownConnection(child.llmConnection) ?? resolved.connection),
        taskNodeId: child.taskNodeId,
        createdAt: child.createdAt,
      }
    })
    // Spec-backed tiles show one row per DAG node (bound to its latest child session,
    // or pending when never run) plus unadopted quick-adds; plain tiles show children.
    const specNodes = meta.taskSlug ? context?.specNodesBySlug?.get(meta.taskSlug) : undefined
    const subtasks = mergeSubtaskRows(withNodeModels(specNodes), children, undefined).map(row => {
      const attention = deriveSubtaskAttention(row.sessionId ? metaMap.get(row.sessionId) : undefined, context)
      return attention.needsInput ? { ...row, ...attention } : row
    })
    result.push({
      id: meta.id,
      title: getSessionTitle(meta),
      column,
      statusId,
      ...tileModel(meta),
      projectId: meta.projectId,
      taskSlug: meta.taskSlug,
      subtasks,
      // With merged spec rows the list already contains every node, so it IS the
      // denominator; the header count only backstops the not-yet-fetched window.
      subtaskTotal: specNodes?.length ? undefined : meta.taskNodeCount,
      isFlagged: meta.isFlagged,
      isProcessing: meta.isProcessing,
      createdAt: meta.createdAt,
      lastMessageAt: meta.lastMessageAt,
      messageCount: meta.messageCount,
      costUsd: meta.tokenUsage?.costUsd,
      ...(meta.taskSlug && context?.wokeAfterDoneBySlug?.get(meta.taskSlug)?.length ? { wokeAfterDone: true } : {}),
      ...deriveTileAttention(meta, context),
    })
  }
  return result
}
