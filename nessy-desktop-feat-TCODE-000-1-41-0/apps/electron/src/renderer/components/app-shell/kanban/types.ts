/* Copied verbatim from v0.13.4:apps/electron/src/renderer/components/app-shell/kanban/types.ts
   (craft-agents-oss, Apache-2.0) by UA2.3, 2026-10-02.
   Manifest row UA2.4; landed with UA2.3 because UA2.3's hook and the Appearance
   page import it (upstream's ordering, same lane).
   UA2.5 adds Nessy's tile fields (needs-input, runtime, connection) at the end of
   `KanbanTask` and the `KanbanTaskConnection` shape; UA4.4 adds `wokeAfterDone`; UA12.77 adds `KanbanSubtask.needsInput` / `waitingOn`; UA12.69 adds `KanbanSubtask.connection`; nothing upstream is changed. */
import type { ModelProvider } from '@config/models'
/**
 * View-models for the Kanban board.
 *
 * `column` (where a tile physically sits) is intentionally separate from
 * `statusId` (what the badge shows). The board has 3 columns but a workspace
 * can have more statuses, so a tile may sit in "In Progress" while showing a
 * "Needs Review" badge. `statusToColumn` (see ./status-column) provides only the
 * default placement; tiles may override it.
 *
 * These are presentational view-models. The wiring phase maps real
 * `SessionConfig` / `ProjectConfig` / status data onto these shapes.
 */

/**
 * Board column id. Widened from the original 3-literal union to `string` so a
 * project can define its own columns (see `KanbanColumnDef` in shared). The
 * built-in set still uses these three ids; `BuiltInKanbanColumnId` names them
 * where the default placement / color maps need exhaustiveness.
 */
export type KanbanColumnId = string

export type BuiltInKanbanColumnId = 'todo' | 'in-progress' | 'done'

export type SubtaskRunState = 'done' | 'running' | 'pending' | 'failed'

/**
 * What the Task editor points at. `create` authors a brand-new task; `edit` opens an
 * existing tile — either spec-backed (`taskSlug` present → prefill from its task.yaml)
 * or a plain quick-add tile (`taskSlug` absent → start from the title, bind the spec
 * on save). Lives here (not in TaskEditor) so the editor-target atom can reference it
 * without importing a component module.
 */
export type TaskEditorTarget =
  | { mode: 'create'; initialProjectId?: string }
  | { mode: 'edit'; sessionId: string; taskSlug?: string; initialTitle?: string }

export interface KanbanSubtask {
  /** Row key. A child session id, or `node:<nodeId>` for an authored-but-never-run spec node. */
  id: string
  /**
   * Backing child session, when one exists. Synthetic rows (spec nodes with no run yet)
   * have none — they are not clickable and don't count toward the Play button's pending set.
   */
  sessionId?: string
  title: string
  runState: SubtaskRunState
  /** Model id the orchestrator routed this subtask to (e.g. 'claude-haiku-4-5-20251001'). UA12.46: absent when
   *  nothing names one (`resolveSessionTaskModel`); the row then shows no model chip. */
  model?: string
  /** UA12.69 — the icon inputs of the connection `model` was resolved from (`resolveSessionTaskModel`), so a
   *  gateway alias row draws ITS connection's icon, not ModelChip's no-connection Anthropic default. */
  connection?: KanbanTaskConnection
  /** UA12.77 — the subtask's session waits on a human (`deriveSubtaskAttention`, the tile's predicate). */
  needsInput?: boolean
  /** UA12.77 — what it waits on, when known; names the request in the badge's label only. */
  waitingOn?: { type?: string; toolName?: string }
}

export interface KanbanTask {
  id: string
  title: string
  /** Physical board column. Independent from `statusId`. */
  column: KanbanColumnId
  /** Workspace status id shown on the badge. Independent from `column`. */
  statusId: string
  /** Orchestrator model id for the parent task. UA12.46: absent when nothing names one (`resolveSessionTaskModel`);
   *  the tile then shows no model chip, where upstream showed `DEFAULT_MODEL`. */
  model?: string
  /** Optional project binding; colors the tile. */
  projectId?: string
  /**
   * Slug of the backing task.yaml when this tile is a spec-authored Conductor task. Absent for
   * plain quick-add tiles. Drives edit-mode prefill (spec → editor) vs. start-empty in TaskEditor.
   */
  taskSlug?: string
  subtasks: KanbanSubtask[]
  /**
   * Total subtasks the Conductor run will produce (from the orchestrator's node count). Used as the
   * progress denominator so it stays stable while `subtasks` fills in as children spawn lazily.
   * Undefined for non-Conductor tasks (fall back to `subtasks.length`).
   */
  subtaskTotal?: number
  /** Flagged for attention (drives the flag star). */
  isFlagged?: boolean
  /** A turn is in flight — drives the live-pulse treatment when enabled. */
  isProcessing?: boolean
  /** Creation time (ms timestamp); newest tiles sort to the top of their column. */
  createdAt?: number
  /** Last activity (ms timestamp) for the relative-time footer. */
  lastMessageAt?: number
  /** Total messages exchanged, shown in the footer when > 0. */
  messageCount?: number
  /** Accrued cost in USD, shown in the footer when available. */
  costUsd?: number
  /**
   * UA2.5 (Nessy adaptation, spec §9) — the session waits on a human: the server's
   * `awaitingApprovalCount > 0`, unioned with this window's own live card through the
   * one predicate the session list uses (`sessionAwaitsApproval`). Drives the badge.
   */
  needsInput?: boolean
  /**
   * UA2.5 — WHAT it waits on, when known (`sessionAttentionPrompt`: one source, never
   * mixed). It only names the request in the badge's label; it never decides the badge.
   */
  waitingOn?: { type?: string; toolName?: string }
  /**
   * UA2.5 — the runtime that runs the session, from its connection's `providerType`
   * (`runtimeForProviderType`). Absent when the session names no connection or one
   * this window does not know, and then the tile shows no runtime chip.
   */
  runtime?: ModelProvider
  /**
   * UA2.5 — the session's connection, as the icon inputs `getProviderIcon` reads.
   * `ModelChip` falls back to it for a model id the registry does not know (a gateway id).
   */
  connection?: KanbanTaskConnection
  /**
   * UA4.4 — a node of the task's latest run took another turn after it was done (`node-woke-after-done`); that work
   * is not in the run's output. Drives the tile's badge.
   */
  wokeAfterDone?: boolean
}

/** UA2.5 — the icon inputs of a session's LLM connection (a `Pick` of `LlmConnectionWithStatus`). */
export interface KanbanTaskConnection {
  providerType: string
  baseUrl?: string | null
  piAuthProvider?: string | null
}

export interface KanbanProject {
  id: string
  name: string
  /** Hex accent color (e.g. "#6366f1"). */
  color: string
}

export interface KanbanColumnMeta {
  id: KanbanColumnId
  /**
   * i18n key for a built-in column header (resolved with `t()` at render).
   * Mutually exclusive with `name`: built-ins carry `labelKey`, user-authored
   * project columns carry a verbatim `name`.
   */
  labelKey?: string
  /** Verbatim header label for a custom (per-project) column — never translated. */
  name?: string
  /** Optional header accent (hex). Built-ins resolve color from the global atom instead. */
  color?: string
  /** Status auto-applied when a card is dropped here (per-project columns). */
  dropStatusId?: string
}

/** One selectable model in the subtask composer's provider→model picker. */
export interface KanbanModelOption {
  id: string
  /** Display name shown in the picker (e.g. "Sonnet 4.6", "GPT-5"). */
  name: string
}

/**
 * A provider's group of selectable models, used by the "Add subtask" composer
 * to let the user route a spawned subtask to any provider's model. The wiring
 * phase builds these from the workspace's LLM connections; the playground feeds
 * a static catalog.
 */
export interface KanbanModelProviderGroup {
  /** Provider key for the brand icon (e.g. 'anthropic', 'openai', 'xai'). */
  provider: string
  /** Section-header label (e.g. "Anthropic", "OpenAI"). */
  label: string
  models: KanbanModelOption[]
  /** NESSY (UA3.6 follow-up): the connection this group is, so a pick routes to the group it was made
   *  under (`model-catalog.ts` adaptation 4). Absent in the playground's static catalogue. */
  connectionSlug?: string
}

/**
 * UA12.56 — the identity a mounted `<TaskEditor>` is keyed by in its container
 * (`KanbanBoardContainer`): the editor reads its bound session once per mount
 * (`TaskEditor.tsx` — the `editSession` snapshot, the initial project pick and
 * mode are `useState` initializers), so switching `kanbanEditorTargetAtom` from
 * one target to another while it stays mounted kept the first target's mode
 * ceiling, folder and unprefilled fields. Keying by this string remounts the
 * editor when the identity changes and — equally load-bearing — does NOT
 * remount when a parent re-render recreates an equal target, so typed fields
 * survive. Every field the initializers read is in the key.
 */
export function taskEditorTargetKey(target: TaskEditorTarget): string {
  return target.mode === 'create'
    ? `create:${target.initialProjectId ?? ''}`
    : `edit:${target.sessionId}:${target.taskSlug ?? ''}`
}
