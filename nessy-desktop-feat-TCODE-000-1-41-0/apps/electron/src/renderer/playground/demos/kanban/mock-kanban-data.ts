/* Copied from v0.13.4:apps/electron/src/renderer/playground/demos/kanban/mock-kanban-data.ts
   (craft-agents-oss, Apache-2.0) by UA2.6, 2026-10-02. Adaptations, each named:
   - the statuses are OUR five defaults (`packages/shared/src/statuses/storage.ts`: backlog, todo,
     needs-review, done, cancelled) — `in-progress` is a board COLUMN here, never a status (plan
     Phase 0.6), so upstream's `in-progress` tiles carry `todo` or `needs-review` and keep their
     column;
   - the tiles run on our three runtimes (UA2.5): a Pi session on the Nessy Gateway with a gateway
     model alias (`coder`, whose chip falls back to the connection's icon), a Claude session and a
     Codex session, plus one tile with no connection (no runtime chip); two tiles need input, one
     naming its request and one not;
   - the model ids are ones our registry knows (`@config/models`) or gateway aliases;
   - UA3.7 restores `mockTaskWindow` (the TaskChatPreview props); its status is `todo`, the status
     its tile (`t4`, column In Progress) carries, where upstream named the `in-progress` status. */
/**
 * Mock data for the Kanban playground demos.
 *
 * Single source of truth for statuses, projects and tasks shared across the
 * Kanban registry entries. Keep shapes shallow — only fields the presentational
 * components actually read.
 *
 * Coverage exercised here: project-colored tiles, a `needs-review` tile parked
 * in the In Progress column (status independent from column), expanded vs
 * collapsed subtasks, auto-routed Haiku/Sonnet sub-models, a no-project tile,
 * a `cancelled` tile in Done, the three runtimes' chips, a gateway model id, and
 * the needs-input badge with and without a named request.
 */

import * as React from 'react'
import { Circle } from 'lucide-react'
import { NESTOR_GATEWAY_CHAT_BASE_URL } from '@nessy-agent/shared/auth/nestor'
import type { SessionStatus } from '@/config/session-status-config'
import type { BoardProject } from '@/components/app-shell/kanban/project-columns'
import type {
  KanbanProject,
  KanbanSubtask,
  KanbanTask,
  KanbanTaskConnection,
} from '@/components/app-shell/kanban/types'

// Model ids (from the centralized registry — see @config/models), and a gateway alias.
const OPUS = 'claude-opus-4-8'
const SONNET = 'claude-sonnet-4-6'
const HAIKU = 'claude-haiku-4-5-20251001'
const GATEWAY_CODER = 'coder'

// Relative timestamps for the footer's "last activity" (resolved once at import).
const MIN = 60_000
const NOW = Date.now()

const circleIcon = () => React.createElement(Circle, { className: 'h-3.5 w-3.5', strokeWidth: 1.5 })

export const mockStatuses: SessionStatus[] = [
  { id: 'backlog', label: 'Backlog', resolvedColor: 'var(--muted-foreground)', icon: circleIcon(), iconColorable: true, category: 'open' },
  { id: 'todo', label: 'Todo', resolvedColor: 'var(--muted-foreground)', icon: circleIcon(), iconColorable: true, category: 'open' },
  { id: 'needs-review', label: 'Needs Review', resolvedColor: 'var(--info)', icon: circleIcon(), iconColorable: true, category: 'open' },
  { id: 'done', label: 'Done', resolvedColor: 'var(--accent)', icon: circleIcon(), iconColorable: true, category: 'closed' },
  { id: 'cancelled', label: 'Cancelled', resolvedColor: 'var(--muted-foreground)', icon: circleIcon(), iconColorable: true, category: 'closed' },
]

export const mockProjects: KanbanProject[] = [
  { id: 'p-eng', name: 'Engineering', color: '#6366f1' }, // indigo
  { id: 'p-growth', name: 'Growth', color: '#10b981' }, // emerald
  { id: 'p-research', name: 'Research', color: '#f59e0b' }, // amber
]

export const mockStatusesById = new Map(mockStatuses.map(s => [s.id, s]))
export const mockProjectsById = new Map(mockProjects.map(p => [p.id, p]))

/**
 * UA12.122 — the focused-project demo state: the column editor's surface. A `BoardProject`-shaped
 * project whose own columns are SEEDED the way a first edit seeds them (the built-in ids survive so
 * existing placement reads, one custom column in the middle) — `resolveActiveColumns` maps these
 * defs onto the board's column metas, and the registry's focused-project knob edits them through
 * the same pure rules the container uses (`withUpdatedColumn`, `withAddedColumn`).
 */
export const mockFocusedProject: BoardProject = {
  config: {
    id: 'p-eng',
    slug: 'engineering',
    name: 'Engineering',
    kanbanColumns: [
      { id: 'todo', name: 'To Do', dropStatusId: 'todo' },
      { id: 'col-design', name: 'Design Review', color: '#f59e0b', dropStatusId: 'needs-review' },
      { id: 'in-progress', name: 'In Progress' },
      { id: 'done', name: 'Done', dropStatusId: 'done' },
    ],
  },
}

/** UA2.5 — the three runtimes' connections, as the tile's runtime chip and ModelChip read them. */
export const mockConnections = {
  pi: { providerType: 'pi', baseUrl: NESTOR_GATEWAY_CHAT_BASE_URL },
  claude: { providerType: 'claude-runtime', baseUrl: null },
  codex: { providerType: 'codex-runtime', baseUrl: null },
} as const satisfies Record<string, KanbanTaskConnection>

// Subtasks for the "Migrate auth" task — reused by the tile anatomy preview.
const AUTH_SUBTASKS: KanbanSubtask[] = [
  { id: 'auth-1', title: 'Audit current auth middleware', runState: 'done', model: HAIKU },
  { id: 'auth-2', title: 'Draft migration plan', runState: 'running', model: SONNET },
  { id: 'auth-3', title: 'Update integration tests', runState: 'pending', model: SONNET },
]

export const mockTasks: KanbanTask[] = [
  // ToDo
  // Pi on the Nessy Gateway, a gateway alias: the model chip takes the connection's icon.
  { id: 't1', title: 'Redesign onboarding flow', column: 'todo', statusId: 'backlog', model: GATEWAY_CODER, projectId: 'p-eng', subtasks: [], isFlagged: true, lastMessageAt: NOW - 1440 * MIN, messageCount: 3, runtime: 'pi', connection: mockConnections.pi },
  // Needs input with no named request: the badge still shows, its label says only "waiting".
  { id: 't2', title: 'Draft Q3 launch announcement', column: 'todo', statusId: 'todo', model: SONNET, projectId: 'p-growth', subtasks: [], runtime: 'anthropic', connection: mockConnections.claude, needsInput: true },
  // No connection known to this window: no runtime chip.
  { id: 't3', title: 'Investigate flaky CI on Windows runners', column: 'todo', statusId: 'todo', model: OPUS, subtasks: [] },

  // In Progress
  // Live: an in-flight turn in the active column drives the pulse + card glow.
  { id: 't4', title: 'Migrate auth to new session model', column: 'in-progress', statusId: 'todo', model: OPUS, projectId: 'p-eng', subtasks: AUTH_SUBTASKS, isProcessing: true, lastMessageAt: NOW - 2 * MIN, messageCount: 14, costUsd: 0.42, runtime: 'anthropic', connection: mockConnections.claude },
  // needs-review badge while physically sitting in In Progress — demonstrates column ⊥ status;
  // a Codex session waiting on a named request (Bash).
  {
    id: 't5',
    title: 'Synthesize user interviews',
    column: 'in-progress',
    statusId: 'needs-review',
    model: GATEWAY_CODER,
    projectId: 'p-research',
    isFlagged: true,
    lastMessageAt: NOW - 180 * MIN,
    messageCount: 8,
    costUsd: 0.18,
    runtime: 'codex-runtime',
    connection: mockConnections.codex,
    needsInput: true,
    waitingOn: { type: 'bash', toolName: 'Bash' },
    subtasks: [
      { id: 't5-1', title: 'Cluster recurring themes', runState: 'done', model: HAIKU },
      { id: 't5-2', title: 'Summarize findings', runState: 'done', model: SONNET },
    ],
  },

  // Done
  {
    id: 't6',
    title: 'Ship pricing page copy',
    column: 'done',
    statusId: 'done',
    model: SONNET,
    projectId: 'p-growth',
    lastMessageAt: NOW - 2880 * MIN,
    messageCount: 22,
    costUsd: 0.91,
    runtime: 'pi',
    connection: mockConnections.pi,
    subtasks: [
      { id: 't6-1', title: 'Rewrite hero section', runState: 'done', model: HAIKU },
      { id: 't6-2', title: 'Generate A/B variants', runState: 'done', model: SONNET },
    ],
  },
  // cancelled badge in Done, no project
  { id: 't7', title: 'Legacy CSV export tool', column: 'done', statusId: 'cancelled', model: HAIKU, subtasks: [], runtime: 'codex-runtime', connection: mockConnections.codex },
]

/** Tiles expanded by default in the board preview. */
export const DEFAULT_EXPANDED_TASK_IDS = new Set<string>(['t4'])

/** Subtasks surfaced in the tile-anatomy preview. */
export const ANATOMY_SUBTASKS = AUTH_SUBTASKS

/** Props for the focused task-window preview (TaskChatPreview). UA3.7: status `todo` (see the header). */
export const mockTaskWindow = {
  title: 'Migrate auth to new session model',
  project: mockProjectsById.get('p-eng'),
  status: mockStatusesById.get('todo'),
  model: OPUS,
  userMessage:
    'Migrate our auth layer to the new session model. Coordinate the work and use the best model for each part.',
  assistantIntro:
    "I'll act as the orchestrator for this task — breaking it into focused subtasks and routing each to the best-fit model rather than doing everything inline:",
  subtasks: AUTH_SUBTASKS,
  assistantFollowUp:
    "The migration plan is in progress. I'll update each subtask here as the spawned sessions report back.",
}
