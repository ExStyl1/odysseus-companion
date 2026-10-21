/* Copied from v0.13.4:apps/electron/src/renderer/components/app-shell/kanban/TaskChatPreview.tsx
   (craft-agents-oss, Apache-2.0) by UA3.7, 2026-10-02. Presentational, fed by the playground only (as
   upstream: no product surface mounts it). Adaptations, each named:
   1. The three English strings are i18n keys (`kanban.taskWindow.*`, en and ru).
   2. `model` is optional, as on the board since UA12.46 (`KanbanTask.model`): with no model the title
      tag and the input bar show no ModelChip, where upstream always had one (its tiles carried
      `DEFAULT_MODEL`, an Anthropic model a Nessy Gateway workspace does not serve).
   UB14.60 (R2-16), 2026-10-16 — v0.15.1's class hunks (changed in v0.15.0): the paper body, the 48px title bar,
   the bubble fill, the raised subtasks panel and input bar, the accent-solid send mark. */
import { ArrowUp, Workflow } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import type { SessionStatus } from '@/config/session-status-config'
import { StatusBadge } from './StatusBadge'
import { ModelChip } from './ModelChip'
import { SubtaskRow } from './SubtaskRow'
import type { KanbanProject, KanbanSubtask } from './types'

interface TaskChatPreviewProps {
  title: string
  project?: KanbanProject
  status?: SessionStatus
  /** Orchestrator model id for the task (adaptation 2: absent → no model chip). */
  model?: string
  /** The user's opening request. */
  userMessage: string
  /** Orchestrator's intro before it spawns subtasks. */
  assistantIntro: string
  /** Subtasks the orchestrator spawned (each routed to a best-fit model). */
  subtasks: KanbanSubtask[]
  /** Optional closing note after the subtask panel. */
  assistantFollowUp?: string
}

/**
 * The body of the focused, chat-only task window (no board, no sidebar).
 *
 * Presentational: header + a scrollable transcript that shows Task mode acting
 * as an orchestrator — it spawns subtasks and routes each to a best-fit model —
 * plus a non-functional input bar. Fed mock content by the playground.
 */
export function TaskChatPreview({
  title,
  project,
  status,
  model,
  userMessage,
  assistantIntro,
  subtasks,
  assistantFollowUp,
}: TaskChatPreviewProps) {
  const { t } = useTranslation()
  return (
    <div className="flex h-full flex-col bg-paper">
      {/* Title bar: project dot + title + status badge */}
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-subtle px-4">
        {project && (
          <span
            className="size-2 shrink-0 rounded-full"
            style={{ backgroundColor: project.color }}
            aria-hidden
          />
        )}
        <span className="truncate text-label-lg font-semibold text-foreground">{title}</span>
        {status && <StatusBadge status={status} className="ml-auto" />}
      </div>

      {/* Transcript */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
          {/* User message */}
          <div className="flex justify-end">
            <div className="max-w-[80%] rounded-xl bg-fill-bubble px-3.5 py-2 text-copy text-foreground">
              {userMessage}
            </div>
          </div>

          {/* Task-mode orchestrator tag */}
          <div className="flex items-center gap-2 text-label-sm text-tertiary">
            <Workflow className="size-3.5 shrink-0" strokeWidth={1.5} />
            <span className="font-medium">{t('kanban.taskWindow.orchestratorTag')}</span>
            {model && <ModelChip model={model} />}
          </div>

          {/* Orchestrator intro */}
          <p className="text-copy text-foreground">{assistantIntro}</p>

          {/* Spawned subtasks panel */}
          {subtasks.length > 0 && (
            <div className="rounded-lg bg-raised p-3 shadow-elev-1">
              <div className="mb-1 text-label-sm font-medium text-tertiary">
                {t('kanban.taskWindow.spawnedSubtasks')}
              </div>
              <div className="divide-y divide-[color:var(--border-subtle)]">
                {subtasks.map(subtask => (
                  <SubtaskRow key={subtask.id} subtask={subtask} />
                ))}
              </div>
            </div>
          )}

          {/* Follow-up */}
          {assistantFollowUp && (
            <p className="text-copy text-foreground">{assistantFollowUp}</p>
          )}
        </div>
      </div>

      {/* Input bar (presentational) */}
      <div className="px-4 pb-3 pt-1">
        <div className="mx-auto flex max-w-2xl items-center gap-2 rounded-xl bg-raised px-3 py-2 shadow-elev-2">
          {model && <ModelChip model={model} className="shrink-0" />}
          <span className="flex-1 truncate text-copy text-tertiary">{t('kanban.taskWindow.replyPlaceholder')}</span>
          <span
            className={cn(
              'grid size-control shrink-0 place-items-center rounded-full',
              'bg-accent-solid text-on-accent'
            )}
            aria-hidden
          >
            <ArrowUp className="size-4" strokeWidth={2} />
          </span>
        </div>
      </div>
    </div>
  )
}
