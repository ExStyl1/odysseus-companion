/* Copied from v0.13.4:apps/electron/src/renderer/components/app-shell/kanban/KanbanBoardContainer.tsx
   (craft-agents-oss, Apache-2.0) by UA2.4, 2026-10-02 — the board over existing sessions. UA5.10
   restored the last withheld ranges (projects, the project filter, per-project columns and their
   editor, the scoped jump): L8, L9's `kanbanProjectFilterAtom`, L12, L15, L19, L23, L97's
   `onJumpToTaskSessions`, L101–L102, L107–L126, L143–L158, L165–L185, L291–L297, L366–L367, L371,
   L375, L379, L410–L467, L475–L478, L486, L489–L510, L545–L551, L564–L571, L576, L593–L594, L600,
   L603, L612–L618. Adaptations (UA5.10), each named: the filter pruning, the focused project, the
   active columns, the filter over tiles, the bound project of a new task and the column editor's set
   arithmetic are `project-columns.ts`'s pure functions, called where upstream wrote them inline; the
   filter offers "No project" (spec §9, `KANBAN_UNASSIGNED_PROJECT`: unbound tiles and tiles of a gone
   project), which never binds a new task nor focuses a project; removing a project's last column is a
   no-op (`planColumnRemoval`; the board already hides the control); a failed column write shows
   `projectInfo.saveFailed` with the host's reason (upstream dropped the rejection: `void updateProject`).
   UA2.4 adaptations, each named: `deriveRunState` (L36–L53) and the `tasks` memo body (L238–L289)
   live in `board-derive.ts` as the pure `deriveBoardTasks`, unchanged in what they read, so
   `bun test` pins them without loading this file's context graph (their imports went with
   them: `SessionMeta` of L7, `statusToColumn` of L21, `KanbanTask`/`SubtaskRunState` of
   L32–L33, `DEFAULT_MODEL` of L16, `getSessionTitle` of L13); the drop guard is `resolveDropStatus` (atoms/kanban.ts, UA2.3) — upstream's line, read
   defensively; the drop-status setter is `withColumnDropStatus` (the same rule the Appearance
   page uses); `columnDropStatus` (L610) passes `readColumnMap(columnStatus)`, the same
   defensive read; the pulse keys on `isProcessing` as upstream. Residue: no keyboard drag (OQ-14).
   UA2.5 (Nessy adaptation, spec §9): the context's `llmConnections` and `pendingPermissions`
   go to `deriveBoardTasks` for the needs-input badge, the runtime chip and ModelChip's
   gateway fallback.
   UA2.2 restored upstream's List ⇄ Board toggle in the header (L14 `routes`, L22, L106
   `navigate`, the L573 controls wrapper, L582–L587), as upstream wrote it.
   UA3.6 restored the editor and the subtasks: L2 `Plus`, L9 `kanbanEditorTargetAtom`, L24–L26,
   L130–L135, L160–L163, L187–L236, L299, L310–L329, L512–L557 (less the parts above), L574–L581,
   and the KanbanBoard props L601, L604, L606–L607. Adaptations, each named: `buildModelCatalog`
   (L55–L87, with L16–L17 and L30) lives in `model-catalog.ts` — one group per connection with its
   runtime, gateway models under their alias; `mergeSubtaskRows` (L264–L267) runs in
   `deriveBoardTasks` from the fetched nodes (`specNodesBySlug`); `defaultSubtaskModel` (L299) is
   the workspace default connection's model from the catalogue (`resolveCatalogDefaultModel`), not
   `DEFAULT_MODEL`, which a gateway workspace does not serve; the editor gets our permission modes
   (the workspace's `enabledModes` in the composer's picker order) and the workspace's new-session
   mode (`defaultPermissionMode`) as a new task's initial mode.
   UA12.46 (Nessy divergence, reason (c): our gateway aliases — upstream's `DEFAULT_MODEL` is an Anthropic
   model a Nessy Gateway workspace does not serve): the derivation gets the workspace default
   connection, so a tile with no model shows the one its session will run on (board-derive.ts), and an add-subtask
   pick with no model (an empty catalogue) creates the child with no model, so it runs on its connection's default.
   UA12.69: the editor's `defaultModel` sends the `''` sentinel where upstream appended `DEFAULT_MODEL`
   (an empty catalogue — no authenticated connection — names no model; the import is gone), never an
   Anthropic id.
   UA4.4 restored L3 (`toast`), L97's `onSendMessage`, L331–L362 (`handleRunSubtasks`, the tile's Play), L540–L543
   (`onOpenChildSession`) and L605. Adaptations, each named: a spec-backed Play goes through the run confirmation
   (`run-controls.ts` `startTaskRun` + `RunConfirmationDialog`; the host refuses a spec no human saved or confirmed,
   `rpc/tasks.ts`) — a declined confirmation runs nothing; the spec fetch also reads `tasks:get`'s `wokeAfterDone`
   (the latest run's nodes whose session worked after done) for the tile's badge (`board-derive.ts`), refetched when a
   task's child stops or starts a turn as well as when the slug set changes or the editor closes.
   UA12.91: each of those fetches is followed by one bounded second read (`WOKE_REFETCH_DELAY_MS`) — the woke entry
   is appended by the completion seam AFTER the turn end that triggered the fetch, so the edge read races the write
   and could leave the badge waiting for the next edge (P-UAal-3).
   UB14.60 (R2-16), 2026-10-16 — v0.15.1's header (changed in v0.15.0): no surface of its own (the panel's paper shows
   through, the columns are wells on it), the 48px header on the gutter, the title in label-lg, the project filter
   beside it, List/Board then a secondary `Button` "New Task" at the trailing end. Kept: the New Task seed is
   `firstFilteredProjectId(projectFilter)` (UA5.10: the "No project" filter entry never binds a new task) where
   upstream reads `projectFilter[0]`. */
import * as React from 'react'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import { useAppShellContext } from '@/context/AppShellContext'
import { sessionMetaMapAtom, updateSessionMetaAtom } from '@/atoms/sessions'
import { projectsAtom } from '@/atoms/projects'
import { kanbanProjectFilterAtom, kanbanColumnStatusAtom, kanbanEditorTargetAtom, readColumnMap, resolveDropStatus, withColumnDropStatus } from '@/atoms/kanban'
import { useNavigation } from '@/contexts/NavigationContext'
import { Button } from '@/components/ui/button'
import { useProjectColorTreatment } from '@/hooks/useProjectColorTreatment' // UA5.9 (v0.13.4 L11)
import { useLabels } from '@/hooks/useLabels'
import { routes } from '@/lib/navigate'
import { getSessionTitle } from '@/utils/session'
import { resolveTaskScopeLabelId } from '@nessy-agent/shared/labels'
import { PERMISSION_MODE_PICKER_ORDER } from '@/lib/composer-permission-modes'
import type { SessionStatus } from '@/config/session-status-config'
import type { KanbanColumnDef } from '@nessy-agent/shared/projects/types'
import { KanbanBoard } from './KanbanBoard'
import { BoardListToggle } from './BoardListToggle'
import { KanbanProjectFilter, type KanbanProjectFilterOption } from './KanbanProjectFilter'
import {
  editableColumns,
  filterTasksByProject,
  firstFilteredProjectId,
  focusedProjectOf,
  planColumnRemoval,
  pruneProjectFilter,
  resolveActiveColumns,
  withAddedColumn,
  withUpdatedColumn,
} from './project-columns'
import { deriveBoardTasks, deriveRunState } from './board-derive'
import { TaskEditor } from './TaskEditor'
import { startTaskRun } from './run-controls'
import { RunConfirmationDialog, useRunConfirmation } from './RunConfirmationDialog'
import { buildModelCatalog, resolveCatalogDefaultModel, resolveDefaultConnectionSlug } from './model-catalog'
import type { SpecNodeSummary } from './subtask-merge'
import type { SpecNode } from './task-spec-form'
import type { KanbanColumnId, KanbanColumnMeta, KanbanProject } from './types'
import { taskEditorTargetKey } from './types'

/**
 * UA12.91 — the delay of the spec fetch's bounded second read (see the fetch effect): the woke entry
 * is appended by the server's completion seam AFTER the turn end that triggers the fetch, so the edge
 * read can lose that race. One second covers it with orders of magnitude to spare; a newer trigger
 * supersedes the timer.
 */
const WOKE_REFETCH_DELAY_MS = 1_000

/**
 * Live Kanban board. Derives tiles from the session metadata map: top-level
 * sessions become task tiles, child sessions (those carrying a `parentSessionId`)
 * become subtask rows under their parent. Column placement comes from the
 * persisted `kanbanColumn`, falling back to the session status' default column;
 * the status badge is independent from the column.
 */
export function KanbanBoardContainer() {
  const {
    activeWorkspaceId,
    sessionStatuses,
    onCreateSession,
    onSendMessage,
    llmConnections,
    pendingPermissions,
    workspaceDefaultLlmConnection,
    enabledModes,
    defaultPermissionMode,
    onJumpToTaskSessions,
  } = useAppShellContext()
  const { t } = useTranslation()
  const metaMap = useAtomValue(sessionMetaMapAtom)
  const projects = useAtomValue(projectsAtom)
  const [projectFilter, setProjectFilter] = useAtom(kanbanProjectFilterAtom)
  const [columnStatus, setColumnStatus] = useAtom(kanbanColumnStatusAtom)
  const treatment = useProjectColorTreatment() // UA5.9 (v0.13.4 L104)
  const updateSessionMeta = useSetAtom(updateSessionMetaAtom)
  const { navigate, navigateToSession } = useNavigation()
  // Label tree for resolving the reserved Task label (scoped tile-click navigation).
  const { labels: labelConfigs } = useLabels(activeWorkspaceId ?? null)

  const liveProjectIds = React.useMemo(() => new Set(projects.map(p => p.config.id)), [projects])

  // Keep the (module-global) board project filter scoped to the current workspace + live projects:
  //  • on workspace switch, clear it — the previous workspace's project ids are meaningless here;
  //  • otherwise prune ids whose project no longer exists (e.g. after a delete) so the board can't
  //    stay filtered to nothing. Identity-preserving returns avoid needless re-renders/loops.
  //    ("No project" always survives — project-columns.ts adaptation 1.)
  const prevWorkspaceRef = React.useRef(activeWorkspaceId)
  React.useEffect(() => {
    if (prevWorkspaceRef.current !== activeWorkspaceId) {
      prevWorkspaceRef.current = activeWorkspaceId
      setProjectFilter(prev => (prev.length ? [] : prev))
      return
    }
    setProjectFilter(prev => pruneProjectFilter(prev, liveProjectIds))
  }, [activeWorkspaceId, liveProjectIds, setProjectFilter])

  const [expandedTaskIds, setExpandedTaskIds] = React.useState<Set<string>>(() => new Set())

  // Full-pane Task editor overlays the board pane (no global route needed). "Add task" opens it in
  // create mode; the tile "Edit task" affordance opens it in edit mode pointed at that session.
  // Atom-backed (not local state) so the chat header's "Edit task" can set the target and
  // navigate here — the overlay is already open when the board mounts. Declared before the
  // spec fetch below, which refetches when the editor closes (a save may have changed specs).
  const [editorTarget, setEditorTarget] = useAtom(kanbanEditorTargetAtom)

  const statusesById = React.useMemo(() => {
    const map = new Map<string, SessionStatus>()
    for (const status of sessionStatuses ?? []) map.set(status.id, status)
    return map
  }, [sessionStatuses])

  // UA3.6 follow-up (model-catalog.ts adaptation 4): the workspace default connection heads the groups and
  // wins a model id two connections offer (two gateway cards both list `coder`).
  const { groups: subtaskModelGroups, modelToConnection } = React.useMemo(
    () => buildModelCatalog(llmConnections, resolveDefaultConnectionSlug(llmConnections, workspaceDefaultLlmConnection)),
    [llmConnections, workspaceDefaultLlmConnection]
  )

  const projectsById = React.useMemo(() => {
    const map = new Map<string, KanbanProject>()
    for (const project of projects) {
      const color = project.config.color
      // Only color-bearing projects need an entry; a tile without one renders plain.
      if (!color) continue
      map.set(project.config.id, { id: project.config.id, name: project.config.name, color })
    }
    return map
  }, [projects])

  // Every project (with or without a color) is selectable in the header filter.
  const projectOptions = React.useMemo<KanbanProjectFilterOption[]>(
    () => projects.map(p => ({ id: p.config.id, name: p.config.name, color: p.config.color })),
    [projects]
  )

  // Per-project columns apply only when exactly one project is in focus — the
  // cross-project "all tasks" view always uses the default 3 columns so it stays
  // coherent. `editingProject` is that single project (column editing is a project
  // property, so it's only offered here).
  const editingProject = React.useMemo(() => focusedProjectOf(projectFilter, projects), [projectFilter, projects])

  // The active column set: the focused project's custom columns when it defines
  // any, otherwise the default built-ins.
  const activeColumns = React.useMemo<readonly KanbanColumnMeta[]>(() => resolveActiveColumns(editingProject), [editingProject])

  const usingProjectColumns = !!editingProject?.config.kanbanColumns?.length

  // ---------------------------------------------------------------------------
  // Spec node summaries for spec-backed tiles, keyed by task slug. The tile merges
  // these with live child sessions (see mergeSubtaskRows) so authored-but-never-run
  // nodes show as pending rows. Refetched when the slug set changes and whenever the
  // editor closes — a save/generate may have rewritten any task.yaml.
  // ---------------------------------------------------------------------------
  const [specNodesBySlug, setSpecNodesBySlug] = React.useState<ReadonlyMap<string, SpecNodeSummary[]>>(
    () => new Map()
  )
  // UA4.4 — per slug, the latest run's nodes whose session worked again after done (the tile's badge).
  const [wokeAfterDoneBySlug, setWokeAfterDoneBySlug] = React.useState<ReadonlyMap<string, readonly string[]>>(
    () => new Map()
  )

  const specSlugsKey = React.useMemo(() => {
    const slugs = new Set<string>()
    for (const meta of metaMap.values()) {
      if (meta.parentSessionId || meta.isArchived || meta.hidden || meta.taskDraft) continue
      if (meta.taskSlug) slugs.add(meta.taskSlug)
    }
    return [...slugs].sort().join(',')
  }, [metaMap])

  // UA4.4 — the turn edges of spec-backed tasks' children: a woke-after-done is logged as such a turn ends, so the
  // spec fetch below re-reads when one starts or stops (not on every streamed token). UA12.91: the edge fetch is
  // followed by one bounded re-read (WOKE_REFETCH_DELAY_MS below) — see the effect.
  const taskChildTurnsKey = React.useMemo(() => {
    const busy: string[] = []
    for (const meta of metaMap.values()) {
      if (meta.parentSessionId && meta.taskSlug && meta.isProcessing) busy.push(meta.id)
    }
    return busy.sort().join(',')
  }, [metaMap])

  const editorOpen = editorTarget != null
  React.useEffect(() => {
    if (!activeWorkspaceId || editorOpen) return
    const slugs = specSlugsKey ? specSlugsKey.split(',') : []
    if (slugs.length === 0) {
      setSpecNodesBySlug(new Map())
      setWokeAfterDoneBySlug(new Map())
      return
    }
    let cancelled = false
    const fetchSpecs = async () => {
      const entries = await Promise.all(
        slugs.map(async (slug): Promise<readonly [string, SpecNodeSummary[], readonly string[]]> => {
          try {
            const res = await window.electronAPI.getTask(activeWorkspaceId, slug)
            const spec = res.spec as { defaults?: { model?: string; llmConnection?: string }; nodes?: SpecNode[] } | undefined
            const defaultModel = spec?.defaults?.model
            // UA12.46 — the connection the Conductor runs the node on, so a never-run row names that one's model.
            const defaultConnection = spec?.defaults?.llmConnection
            return [
              slug,
              (spec?.nodes ?? []).map(n => ({
                id: n.id,
                title: n.title || n.id,
                model: n.model ?? defaultModel,
                llmConnection: n.llmConnection ?? defaultConnection,
              })),
              res.wokeAfterDone ?? [],
            ]
          } catch {
            // Unreadable spec → empty node list: the tile falls back to children-only rows.
            return [slug, [], []]
          }
        })
      )
      if (cancelled) return
      setSpecNodesBySlug(new Map(entries.map(([slug, nodes]) => [slug, nodes])))
      setWokeAfterDoneBySlug(new Map(entries.flatMap(([slug, , woke]) => (woke.length ? [[slug, woke] as const] : []))))
    }
    void fetchSpecs()
    // UA12.91 — the woke entry is appended by the runner's completion seam, which the server reaches
    // AFTER the turn end that flips `taskChildTurnsKey` (`onProcessingStopped` sends the turn-end event
    // first, then emits `sessionComplete`), so THIS effect's own fetch races the write and can read the
    // run log before the entry lands — with no later edge to retry on. One bounded second read on the
    // SAME trigger closes it: the badge shows within a beat of the edge instead of at the next one. A
    // newer trigger cancels both the pending read's write and the timer.
    const repeat = setTimeout(() => {
      void fetchSpecs()
    }, WOKE_REFETCH_DELAY_MS)
    return () => {
      cancelled = true
      clearTimeout(repeat)
    }
  }, [activeWorkspaceId, specSlugsKey, editorOpen, taskChildTurnsKey])

  const tasks = React.useMemo(
    () => deriveBoardTasks(metaMap, statusesById, { connections: llmConnections, pendingPermissions, specNodesBySlug, wokeAfterDoneBySlug, workspaceDefaultConnection: workspaceDefaultLlmConnection }),
    [metaMap, statusesById, llmConnections, pendingPermissions, specNodesBySlug, wokeAfterDoneBySlug, workspaceDefaultLlmConnection]
  )

  // Project filter: empty selection = show all; "No project" selects unbound tiles (adaptation in the header).
  const visibleTasks = React.useMemo(
    () => filterTasksByProject(tasks, projectFilter, liveProjectIds),
    [tasks, projectFilter, liveProjectIds]
  )

  const defaultSubtaskModel = resolveCatalogDefaultModel(llmConnections, subtaskModelGroups, workspaceDefaultLlmConnection)

  // The task editor's mode picker: the workspace's modes in the composer's order (all of them
  // when the workspace names none).
  const taskPermissionModes = React.useMemo(() => {
    const offered = PERMISSION_MODE_PICKER_ORDER.filter(mode => !enabledModes?.length || enabledModes.includes(mode))
    return offered.length > 0 ? offered : [...PERMISSION_MODE_PICKER_ORDER]
  }, [enabledModes])

  const handleToggleSubtasks = React.useCallback((taskId: string) => {
    setExpandedTaskIds(prev => {
      const next = new Set(prev)
      if (next.has(taskId)) next.delete(taskId)
      else next.add(taskId)
      return next
    })
  }, [])

  const handleAddSubtask = React.useCallback(
    async (taskId: string, title: string, model: string, connectionSlug?: string) => {
      if (!activeWorkspaceId) return
      // The group the model was picked under; an untouched default routes as the catalogue does.
      const llmConnection = connectionSlug ?? modelToConnection.get(model)
      // Create only — the subtask lands as a pending row. The title is stored as
      // the session `name` so it shows on the row, is recovered as the prompt when
      // Play dispatches it, and suppresses AI title-gen. Execution is deferred.
      // applyTaskLabel: the child inherits the parent's task::N (numbering a
      // plain-chat parent in the same pass — it becomes a task by gaining a subtask).
      await onCreateSession(activeWorkspaceId, {
        parentSessionId: taskId,
        ...(model ? { model } : {}),
        ...(llmConnection ? { llmConnection } : {}),
        name: title,
        applyTaskLabel: true,
      })
      setExpandedTaskIds(prev => new Set(prev).add(taskId))
    },
    [activeWorkspaceId, modelToConnection, onCreateSession]
  )

  // UA4.4 — the run confirmation the tile's Play shows (adaptation in the header).
  const runConfirmation = useRunConfirmation()
  const defaultConnectionSlug = resolveDefaultConnectionSlug(llmConnections, workspaceDefaultLlmConnection)

  // Tile Play. Spec-backed tasks start a Conductor run of the whole DAG (tasks:run —
  // the runner drives child creation, statuses, and columns; it throws if a run is
  // already active). Plain tiles dispatch every pending quick-add child directly: the
  // prompt is the child's `name` (set at creation), with `isProcessing` flipped
  // optimistically so the row spins immediately and a double-click is a no-op.
  const handleRunSubtasks = React.useCallback(
    (taskId: string) => {
      const meta = metaMap.get(taskId)
      if (activeWorkspaceId && meta?.taskSlug) {
        // NESSY (header): through the run confirmation; a declined one resolves null and runs nothing.
        startTaskRun(window.electronAPI, activeWorkspaceId, { slug: meta.taskSlug, orchestratorSessionId: taskId }, runConfirmation.confirm)
          .catch((err: unknown) => {
            toast.error(t('tasks.toastRunFailed'), {
              description: err instanceof Error ? err.message : String(err),
            })
          })
        return
      }
      for (const child of metaMap.values()) {
        if (child.parentSessionId !== taskId) continue
        // Skip Conductor-owned children: the TaskRunner drives their lifecycle (prompts,
        // status, retries). Dispatching them manually would double-run and race the runner.
        if (child.taskRunId) continue
        if (deriveRunState(child, statusesById) !== 'pending') continue
        const prompt = child.name?.trim()
        if (!prompt) continue
        onSendMessage(child.id, prompt)
        updateSessionMeta(child.id, { isProcessing: true })
      }
    },
    [metaMap, statusesById, onSendMessage, updateSessionMeta, activeWorkspaceId, t, runConfirmation.confirm]
  )

  // Create a parent task tile in place — no navigation. It lands in ToDo (no
  // kanbanColumn + todo status → todo column). While a project filter is active,
  // bind the new task to the first selected project so it stays visible under the
  // filter (an unbound task would be hidden the moment it's created).
  const handleCreateTask = React.useCallback(
    async (title: string) => {
      if (!activeWorkspaceId) return
      const boundProjectId = firstFilteredProjectId(projectFilter)
      await onCreateSession(activeWorkspaceId, {
        name: title,
        sessionStatus: 'todo',
        ...(boundProjectId ? { projectId: boundProjectId } : {}),
        applyTaskLabel: true,
      })
    },
    [activeWorkspaceId, onCreateSession, projectFilter]
  )

  // Change a task's status badge directly (independent from its column). Mirrors
  // the move handler's optimistic-then-persist shape so the badge reflows before
  // the RPC lands.
  const handleChangeStatus = React.useCallback(
    (taskId: string, statusId: string) => {
      updateSessionMeta(taskId, { sessionStatus: statusId })
      void window.electronAPI.sessionCommand(taskId, { type: 'setSessionStatus', state: statusId })
    },
    [updateSessionMeta]
  )

  const handleMoveTask = React.useCallback(
    (taskId: string, toColumn: KanbanColumnId) => {
      // Optimistic: the column derives from `kanbanColumn` first, so writing it
      // immediately reflows the tile before the RPC lands.
      updateSessionMeta(taskId, { kanbanColumn: toColumn })
      void window.electronAPI.sessionCommand(taskId, { type: 'setKanbanColumn', column: toColumn })
      // Optionally fold the status to the column's configured target. Project
      // columns carry their own `dropStatusId`; the default view reads the global
      // atom. Guarded on a known status so a stale mapping is a no-op.
      const autoStatus = resolveDropStatus({
        toColumn,
        columnDropStatusId: activeColumns.find(c => c.id === toColumn)?.dropStatusId,
        columnStatus,
        isKnownStatus: statusId => statusesById.has(statusId),
      })
      if (autoStatus) {
        handleChangeStatus(taskId, autoStatus)
      }
    },
    [updateSessionMeta, activeColumns, columnStatus, statusesById, handleChangeStatus]
  )

  // Persist a full ordered column set onto the focused project. The `projects:changed`
  // broadcast refreshes `projectsAtom`, so the board reflows without optimistic state.
  const persistProjectColumns = React.useCallback(
    (columns: KanbanColumnDef[]) => {
      if (!activeWorkspaceId || !editingProject) return
      window.electronAPI
        .updateProject(activeWorkspaceId, editingProject.config.slug, { kanbanColumns: columns })
        .catch((err: unknown) => {
          // NESSY (header): the host refuses a bad set (`project-columns-invalid`); say so.
          toast.error(t('projectInfo.saveFailed'), { description: err instanceof Error ? err.message : String(err) })
        })
    },
    [activeWorkspaceId, editingProject, t]
  )

  // The project's current custom set, or — on first customization — a seed
  // materialized from the active (default) columns (project-columns.ts `editableColumns`).
  const resolveEditableColumns = React.useCallback(
    (): KanbanColumnDef[] => editableColumns(editingProject, activeColumns, t),
    [editingProject, activeColumns, t]
  )

  const handleAddColumn = React.useCallback(() => {
    const id = `col-${crypto.randomUUID().slice(0, 8)}`
    persistProjectColumns(withAddedColumn(resolveEditableColumns(), id, t('kanban.column.newColumnName')))
  }, [resolveEditableColumns, persistProjectColumns, t])

  const handleUpdateColumn = React.useCallback(
    (columnId: string, patch: Partial<KanbanColumnDef>) => {
      persistProjectColumns(withUpdatedColumn(resolveEditableColumns(), columnId, patch))
    },
    [resolveEditableColumns, persistProjectColumns]
  )

  const handleRemoveColumn = React.useCallback(
    (columnId: string) => {
      const plan = planColumnRemoval(resolveEditableColumns(), columnId, visibleTasks)
      if (!plan) return
      // Reassign orphaned cards to the first remaining column so none disappears
      // (optimistic per-task, mirroring handleMoveTask).
      for (const { taskId, toColumn } of plan.reassign) {
        updateSessionMeta(taskId, { kanbanColumn: toColumn })
        void window.electronAPI.sessionCommand(taskId, { type: 'setKanbanColumn', column: toColumn })
      }
      persistProjectColumns(plan.remaining)
    },
    [resolveEditableColumns, persistProjectColumns, visibleTasks, updateSessionMeta]
  )

  // Set the status auto-applied when a task is dropped into a column (header picker).
  // In single-project view this persists onto the project column's `dropStatusId`;
  // the default/all view edits the global atom (shared with AppearanceSettingsPage,
  // so board header and Settings stay in sync).
  const handleSelectDropStatus = React.useCallback(
    (column: KanbanColumnId, statusId: string) => {
      if (editingProject) {
        handleUpdateColumn(column, { dropStatusId: statusId || undefined })
        return
      }
      setColumnStatus(prev => withColumnDropStatus(prev, column, statusId))
    },
    [editingProject, handleUpdateColumn, setColumnStatus]
  )

  // Board clicks land on All Sessions with the task's scope applied as the NORMAL,
  // user-clearable header-chip filters: label filter = the session's per-task item
  // label (`TASK-<slug>-<N>` — exactly this task's family; legacy root-only sessions
  // fall back to the Task root), project filter = the task's project (when bound).
  // Sessions without any task label (plain chats) fall back to plain navigation.
  // `projectFallbackId` lets subtask rows inherit the parent tile's project when
  // the child session itself carries none (older quick-add subtasks).
  const openSessionScoped = React.useCallback(
    (sessionId: string, projectFallbackId?: string) => {
      const meta = metaMap.get(sessionId)
      const scopeLabelId = resolveTaskScopeLabelId(meta?.labels, labelConfigs)
      if (scopeLabelId && onJumpToTaskSessions) {
        onJumpToTaskSessions(sessionId, {
          labelId: scopeLabelId,
          projectId: meta?.projectId ?? projectFallbackId,
        })
        return
      }
      navigateToSession(sessionId)
    },
    [metaMap, labelConfigs, onJumpToTaskSessions, navigateToSession]
  )

  const handleEditTask = React.useCallback(
    (taskId: string) => {
      const meta = metaMap.get(taskId)
      setEditorTarget({
        mode: 'edit',
        sessionId: taskId,
        taskSlug: meta?.taskSlug,
        initialTitle: meta ? getSessionTitle(meta) : undefined,
      })
    },
    [metaMap, setEditorTarget]
  )

  if (editorTarget && activeWorkspaceId) {
    return (
      <TaskEditor
        key={taskEditorTargetKey(editorTarget)}
        workspaceId={activeWorkspaceId}
        target={editorTarget}
        onClose={() => setEditorTarget(null)}
        onOpenSession={
          editorTarget.mode === 'edit'
            ? () => {
                const sessionId = editorTarget.sessionId
                setEditorTarget(null)
                navigateToSession(sessionId)
              }
            : undefined
        }
        onOpenChildSession={(sessionId) => {
          setEditorTarget(null)
          navigateToSession(sessionId)
        }}
        onCreated={({ sessionId, taskLabelId, projectId: createdProjectId }) => {
          // Same human-clearable scope as a tile click; no label (fail-soft) → plain open.
          if (taskLabelId && onJumpToTaskSessions) {
            onJumpToTaskSessions(sessionId, { labelId: taskLabelId, projectId: createdProjectId })
          } else {
            navigateToSession(sessionId)
          }
        }}
        modelGroups={subtaskModelGroups}
        modelToConnection={modelToConnection}
        // UA12.69: an empty catalogue names no model — the `''` sentinel, never upstream's `DEFAULT_MODEL`.
        defaultModel={defaultSubtaskModel ?? ''}
        permissionModes={taskPermissionModes}
        defaultPermissionMode={defaultPermissionMode ?? 'default'}
        defaultConnectionSlug={defaultConnectionSlug}
      />
    )
  }

  return (
    // No surface of its own: the panel card (paper) shows through; columns are neutral wells on it.
    <div className="flex h-full flex-col">
      {/* Header (48px, like the panel headers): title, project filter … List/Board, New Task. Both ends
          sit on the gutter, the board columns' edge (the trailing New Task button is a bordered box). */}
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 px-gutter">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-label-lg font-semibold">{t('kanban.allTasks')}</span>
          {projectOptions.length > 0 && (
            <KanbanProjectFilter
              projects={projectOptions}
              value={projectFilter}
              onChange={setProjectFilter}
              className="ml-1"
            />
          )}
          {usingProjectColumns && editingProject && (
            <span className="truncate text-label-sm text-tertiary">
              {t('kanban.column.columnsFrom', { project: editingProject.config.name })}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <BoardListToggle
            value="board"
            onChange={view => {
              if (view === 'list') navigate(routes.view.allSessions())
            }}
          />
          <Button
            type="button"
            variant="secondary"
            onClick={() => setEditorTarget({ mode: 'create', initialProjectId: firstFilteredProjectId(projectFilter) })}
            disabled={!activeWorkspaceId}
            className="@max-mobile/shell:h-9"
          >
            <Plus /> {t('kanban.newTask')}
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <KanbanBoard
          columns={activeColumns}
          tasks={visibleTasks}
          projectsById={projectsById}
          statusesById={statusesById}
          statuses={sessionStatuses ?? []}
          onChangeStatus={handleChangeStatus}
          treatment={treatment}
          expandedTaskIds={expandedTaskIds}
          onTaskClick={openSessionScoped}
          onEditTask={handleEditTask}
          onToggleSubtasks={handleToggleSubtasks}
          onSubtaskClick={(taskId, subtaskId) => openSessionScoped(subtaskId, metaMap.get(taskId)?.projectId)}
          onAddSubtask={handleAddSubtask}
          onRunSubtasks={handleRunSubtasks}
          subtaskModelGroups={subtaskModelGroups}
          defaultSubtaskModel={defaultSubtaskModel}
          onCreateTask={handleCreateTask}
          onMoveTask={handleMoveTask}
          columnDropStatus={readColumnMap(columnStatus)}
          onSelectDropStatus={handleSelectDropStatus}
          {...(editingProject
            ? {
                onUpdateColumn: handleUpdateColumn,
                onRemoveColumn: handleRemoveColumn,
                onAddColumn: handleAddColumn,
              }
            : {})}
        />
      </div>
      <RunConfirmationDialog
        confirmation={runConfirmation.pending}
        groups={subtaskModelGroups}
        defaultConnectionSlug={defaultConnectionSlug}
        onSettle={runConfirmation.settle}
      />
    </div>
  )
}
