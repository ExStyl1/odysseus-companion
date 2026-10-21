/**
 * The session goal chip — MOUNTED in the above-composer strip (P6.476).
 *
 * It reached the app the way the owner's 2026-08-23 process rule requires: the
 * playground FIRST, corrected there against the data that actually exists, and
 * only then into the strip. `playground/registry/session-goal.tsx` is still a
 * real consumer and stays one — it is where all five statuses, both `blockedBy`
 * arms, the no-goal state and both `valueMode` knobs can be looked at at once.
 *
 * READ-ONLY, by the owner's 2026-09-05 Q3 answer (option A): the chip shows the
 * goal and its popover explains it; B's composer command and cancel popover were
 * declined, so no control affordance is offered here. The `goal_create` /
 * `goal_cancel` control verbs exist on the wire and this surface does not use
 * them.
 *
 * WHERE IT IS MOUNTED. `ActiveOptionBadges` renders it in its one quiet chip
 * row above the composer, after the session-fact chips (UB14.55; the state chip
 * it used to follow moved to the chat header, UB14.6), and reads the goal itself
 * through `useSessionGoal` from the `sessionId`/`workspaceId` it already
 * receives — no prop was threaded down through `ChatInputZone`. That is the
 * reuse the 2026-08-22 ruling asked for (*"reuse, not a new panel"*), and
 * `valueMode` is pinned to `progress` at the mount rather than left to this
 * file's default.
 *
 * THE LOOK (UB14.55). The trigger wears v0.15.1's quiet meta chip
 * (`COMPOSER_META_CHIP`, the material of every chip in that row upstream —
 * `BackgroundTaskChip` is the model): a status glyph, the label, the value in
 * tertiary, and a tint only where the goal needs the user (blocked, budget
 * exhausted: the failed chip's destructive tint). It was a 30px `MetadataBadge`
 * with a chevron, the pre-redesign row's chip.
 *
 * WHAT THE DATA IS. `PiHarnessGoalSummaryV1` is the redacted projection
 * `GoalService.safeSnapshot()` already produces — condition and evaluation
 * reasons pass through `redact()`, the creator through `redactIdentifier()` — so
 * nothing here needs its own truncation policy for safety, only for layout.
 *
 * THE DIVERGENCE THIS FILE USED TO WARN ABOUT IS CLOSED, and the note stays
 * because the shape of it is worth keeping: since P2.2 the goal is HOST-SIDE on
 * Pi, claude and codex alike, but both paths that carry it to the renderer were
 * once Pi-gated, so a mount would have rendered on Pi and SILENTLY never on the
 * other two. P2.488 (`f3ddcedda`) closed both — `getPiHarnessRuntimeSnapshot`
 * carries `goal` past its `provider !== 'pi'` early return, and
 * `emitPiHarnessInvalidation` gates on `SCHEDULED_DELIVERY_RUNTIMES` instead. A
 * provider gate re-introduced anywhere on this path would re-open exactly the
 * silent divergence `AGENTS.md` names as this fork's largest defect class;
 * `__tests__/session-goal-mount.test.tsx` pins its absence.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { CircleAlert, CircleCheck, CircleSlash, Gauge, Target } from 'lucide-react'
import type { PiHarnessGoalStatusV1, PiHarnessGoalSummaryV1 } from '@nessy-agent/core/types'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { COMPOSER_META_CHIP } from './input/composer-styles'

/**
 * One i18n key per `PiHarnessGoalStatusV1` member, keyed by the union itself so
 * a sixth status cannot be added upstream without this map failing to typecheck.
 */
export const SESSION_GOAL_STATUS_KEYS: Record<PiHarnessGoalStatusV1, string> = {
  active: 'chat.goal.statusActive',
  complete: 'chat.goal.statusComplete',
  blocked: 'chat.goal.statusBlocked',
  cancelled: 'chat.goal.statusCancelled',
  budget_exhausted: 'chat.goal.statusBudgetExhausted',
}

/**
 * The status word's colour in the popover (the chip's own tone is `SESSION_GOAL_CHIP_TONE` below, since UB14.55),
 * from the tokens `index.css` actually defines. There is
 * no `--warning` token in this tree, so `budget_exhausted` shares
 * `--destructive` with `blocked` and is separated by its icon and its word
 * instead — a colour invented here would be the only place in the renderer that
 * knows it.
 */
export const SESSION_GOAL_STATUS_COLORS: Record<PiHarnessGoalStatusV1, string> = {
  active: 'var(--foreground)',
  complete: 'var(--success)',
  blocked: 'var(--destructive)',
  cancelled: 'var(--muted-foreground)',
  budget_exhausted: 'var(--destructive)',
}

/**
 * UB14.55 — the chip's tint and glyph tone, in role classes. Only the two states that wait on the user carry a tint
 * (the failed task chip's destructive one); the others keep the quiet chip and say their status with the glyph.
 */
const DESTRUCTIVE_CHIP_TONE = 'bg-destructive-tint text-destructive ring-[color:var(--destructive-border)]'
export const SESSION_GOAL_CHIP_TONE: Record<PiHarnessGoalStatusV1, string | undefined> = {
  active: undefined,
  complete: undefined,
  blocked: DESTRUCTIVE_CHIP_TONE,
  cancelled: undefined,
  budget_exhausted: DESTRUCTIVE_CHIP_TONE,
}
const SESSION_GOAL_ICON_TONE: Record<PiHarnessGoalStatusV1, string> = {
  active: 'text-tertiary',
  complete: 'text-success',
  blocked: 'text-destructive',
  cancelled: 'text-tertiary',
  budget_exhausted: 'text-destructive',
}

const SESSION_GOAL_STATUS_ICONS: Record<PiHarnessGoalStatusV1, React.ComponentType<{ className?: string }>> = {
  active: Target,
  complete: CircleCheck,
  blocked: CircleAlert,
  cancelled: CircleSlash,
  budget_exhausted: Gauge,
}

/**
 * What the chip's one line says after "Goal ·".
 *
 * `progress` is what the app mounts — the owner chose it on 2026-09-05 (Q3) for
 * the reason it was proposed with: an active goal's budget position is the part
 * that CHANGES while the user watches, and the condition is a model-authored
 * sentence that the 140px value slot truncates to a few words. `condition` stays
 * as a knob so the playground can still show what that truncation looks like.
 */
export type SessionGoalBadgeValueMode = 'progress' | 'condition'

export interface SessionGoalBadgeProps {
  /** Absent for the overwhelmingly common session that has no goal. */
  goal?: PiHarnessGoalSummaryV1
  valueMode?: SessionGoalBadgeValueMode
  /** Controlled popover state; the playground and tests drive it open. */
  detailsOpen?: boolean
  onDetailsOpenChange?: (open: boolean) => void
  className?: string
}

/**
 * The turn budget line, which every goal has: `positiveInteger(turnLimit, …)` in
 * `goal-service.ts` admits no zero, so there is no "unlimited" state to spell
 * and no second key for one.
 *
 * A plain function of `t` rather than a hook, because the chip needs it only
 * when a goal exists and a hook may not be called conditionally.
 */
function turnProgress(goal: PiHarnessGoalSummaryV1, t: (key: string, options?: Record<string, unknown>) => string): string {
  return t('chat.goal.progressTurns', {
    used: goal.accounting.turns,
    limit: goal.budgets.turnLimit,
  })
}

/**
 * The popover body: the parts of the goal that cannot fit on one chip.
 *
 * Exported on its own so a test can render it without driving a Radix popover,
 * and so the playground can show it as its own entry — it is the half of this
 * draft with the open design questions in it.
 */
export function SessionGoalDetails({ goal }: { goal: PiHarnessGoalSummaryV1 }) {
  const { t } = useTranslation()
  const progress = turnProgress(goal, t)
  const statusWord = t(SESSION_GOAL_STATUS_KEYS[goal.status])

  return (
    <div className="w-[280px] p-3 flex flex-col gap-2 text-xs" data-testid="session-goal-details">
      <p className="text-foreground/90 leading-snug break-words">{goal.condition}</p>
      <p className="text-foreground/60">
        <span style={{ color: SESSION_GOAL_STATUS_COLORS[goal.status] }}>{statusWord}</span>
        <span className="opacity-30 mx-1">·</span>
        {progress}
      </p>
      {goal.blocking && (
        <p className="text-foreground/60 leading-snug break-words" data-testid="session-goal-blocking">
          {goal.blocking.blockedBy === 'user'
            ? t('chat.goal.blockedByUser')
            : t('chat.goal.blockedByExternal')}
        </p>
      )}
      {goal.lastEvaluation && goal.lastEvaluation.reason.length > 0 && (
        <div className="flex flex-col gap-0.5" data-testid="session-goal-last-check">
          <span className="text-foreground/40 uppercase tracking-wide text-[10px]">{t('chat.goal.lastCheck')}</span>
          <span className="text-foreground/70 leading-snug break-words">{goal.lastEvaluation.reason}</span>
        </div>
      )}
    </div>
  )
}

/**
 * The chip itself. Returns `null` with no goal, so the strip's existing
 * visibility guard and spacing are untouched for every session that never sets
 * one — the reuse P4.2 asked for rather than a row that is always present and
 * usually empty.
 */
export function SessionGoalBadge({
  goal,
  valueMode = 'progress',
  detailsOpen,
  onDetailsOpenChange,
  className,
}: SessionGoalBadgeProps) {
  const { t } = useTranslation()
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(false)
  const open = detailsOpen ?? uncontrolledOpen
  const setOpen = onDetailsOpenChange ?? setUncontrolledOpen
  if (!goal) return null

  const StatusIcon = SESSION_GOAL_STATUS_ICONS[goal.status]
  const value = valueMode === 'condition' ? goal.condition : turnProgress(goal, t)
  const tone = SESSION_GOAL_CHIP_TONE[goal.status]

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="session-goal-badge"
          data-goal-status={goal.status}
          title={goal.condition}
          className={cn(COMPOSER_META_CHIP, 'max-w-full cursor-pointer pl-2', tone, className)}
        >
          <StatusIcon aria-hidden className={cn('size-3.5 shrink-0', SESSION_GOAL_ICON_TONE[goal.status])} />
          <span className="shrink-0">{t('chat.goal.label')}</span>
          {/* 140px, the value slot the 2026-09-05 Q3 answer weighed (a long condition truncates; progress never does) */}
          <span className={cn('min-w-0 max-w-[140px] truncate tabular-nums', tone ? 'font-medium' : 'text-tertiary')}>
            {value}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" side="top" align="start" sideOffset={4}>
        <SessionGoalDetails goal={goal} />
      </PopoverContent>
    </Popover>
  )
}
