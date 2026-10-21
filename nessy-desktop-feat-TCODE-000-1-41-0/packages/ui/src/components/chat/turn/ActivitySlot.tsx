/**
 * Ours (UB14.11, no upstream counterpart): the one place a work-log row asks the host's
 * `renderActivity` for a specialised card before drawing the ordinary `ActivityRow`.
 *
 * v0.15.1 has no `renderActivity`; our `ChatDisplay` routes Pi `subagent` and codex collab rows to
 * `SubagentCard` (P3.24), workflow rows to `WorkflowPanel`, recoverable TodoWrite rows to
 * `TodoListCard` (P2.503) and advisor consultations to `AdvisorConsultationCard` (P4.5) through it.
 * Both row lists — the flat/grouped list (`WorkLog`) and a subagent group's children
 * (`ActivityGroupRow`) — render through this slot, so a card reaches a row wherever it sits.
 *
 * A card that DECLINES (returns `null`, `undefined` or `false`) yields the ordinary row: the slot
 * never deletes a row, which is the P3.24 failure mode (a card returning null emptied the row).
 * The insert-animation props land on the card's wrapper exactly as they land on the row's.
 */
import * as React from 'react'
import { cn } from '../../../lib/utils'
import type { ActivityItem, ActivityRenderProps } from '../TurnCard'
import { ActivityRow } from './ActivityRow'

export interface ActivitySlotProps {
  activity: ActivityItem
  /** Optional custom renderer for specialised activity cards (ours: `TurnCardProps.renderActivity`) */
  renderActivity?: (props: ActivityRenderProps) => React.ReactNode
  onOpenDetails?: () => void
  isLastChild?: boolean
  sessionFolderPath?: string
  displayMode: 'informative' | 'detailed'
  /** Insert animation from the parent list (`useRowReveal`) */
  className?: string
  style?: React.CSSProperties
}

export function ActivitySlot({
  activity,
  renderActivity,
  onOpenDetails,
  isLastChild,
  sessionFolderPath,
  displayMode,
  className,
  style,
}: ActivitySlotProps) {
  const card = renderActivity?.({ activity, onOpenDetails, isLastChild, sessionFolderPath, displayMode })
  if (card !== null && card !== undefined && card !== false) {
    return (
      <div className={cn('min-w-0 py-0.5', className)} style={style} data-activity-card="true">
        {card}
      </div>
    )
  }
  return (
    <ActivityRow
      activity={activity}
      onOpenDetails={onOpenDetails}
      isLastChild={isLastChild}
      sessionFolderPath={sessionFolderPath}
      displayMode={displayMode}
      className={className}
      style={style}
    />
  )
}
