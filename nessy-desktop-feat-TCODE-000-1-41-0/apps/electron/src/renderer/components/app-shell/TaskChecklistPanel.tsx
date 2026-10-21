import { CheckCircle2, Circle, ListTodo, LoaderCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ActivityItem } from '@nessy-agent/ui/chat/TurnCard'
import {
  checklistItemLabel,
  extractChecklistFromActivities,
  type ChecklistItem,
} from '@nessy-agent/ui/chat/task-checklist'
import { SystemCard } from '@/components/ui/system-card'
import { cn } from '@/lib/utils'

/**
 * The session task checklist (R20 Task 5).
 *
 * `interactive-mode.md:36` — this is the checklist surface, toggled by a
 * dedicated binding, and explicitly "not the background-task view; use `/tasks`
 * to see running shells and subagents". The background-task view stays where it
 * is, in the composer's task chip row.
 *
 * `interactive-mode.md` also specifies "The display shows up to five tasks at a
 * time" and that the toggle is a visible no-op when the list is empty.
 */
export const TASK_CHECKLIST_VISIBLE_LIMIT = 5

type TaskChecklistPanelProps = {
  /** Every activity in the session, newest turn last. */
  activities: ActivityItem[]
  open: boolean
}

function StatusIcon({ status }: { status: ChecklistItem['status'] }) {
  if (status === 'completed') {
    return <CheckCircle2 className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
  }
  if (status === 'in_progress') {
    return <LoaderCircle className="size-3.5 shrink-0 animate-spin text-foreground" aria-hidden />
  }
  return <Circle className="size-3.5 shrink-0 text-muted-foreground/60" aria-hidden />
}

export function TaskChecklistPanel({ activities, open }: TaskChecklistPanelProps) {
  const { t } = useTranslation()
  const items = extractChecklistFromActivities(activities)

  // "The toggle is a visible no-op when the list is empty" — nothing is drawn
  // rather than an empty frame the user has to dismiss.
  if (!open || items.length === 0) return null

  const visible = items.slice(0, TASK_CHECKLIST_VISIBLE_LIMIT)
  const overflow = items.length - visible.length
  const completed = items.filter(item => item.status === 'completed').length

  return (
    <SystemCard
      data-testid="task-checklist-panel"
      role="region"
      aria-label={t('taskChecklist.title')}
      icon={<ListTodo className="size-3.5 shrink-0" aria-hidden />}
      title={t('taskChecklist.title')}
      meta={<span className="tabular-nums">{t('taskChecklist.progress', { completed, total: items.length })}</span>}
    >
      <ul className="flex flex-col gap-1">
        {visible.map(item => (
          <li
            key={item.id ?? item.content}
            className="flex items-start gap-1.5"
            data-status={item.status}
          >
            <span className="mt-0.5">
              <StatusIcon status={item.status} />
            </span>
            <span
              className={cn(
                'min-w-0 break-words',
                item.status === 'completed' && 'text-muted-foreground line-through',
                item.status === 'in_progress' && 'text-foreground',
              )}
            >
              {checklistItemLabel(item)}
            </span>
          </li>
        ))}
      </ul>

      {overflow > 0 && (
        <div className="mt-1.5 text-muted-foreground">
          {t('taskChecklist.more', { count: overflow })}
        </div>
      )}
    </SystemCard>
  )
}
