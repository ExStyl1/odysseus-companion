import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AtSign, EyeOff } from 'lucide-react'
import type { ComponentEntry } from './types'
import type { PiHarnessGoalSummaryV1 } from '@nessy-agent/core/types'
import {
  SessionGoalBadge,
  SessionGoalDetails,
  type SessionGoalBadgeValueMode,
} from '@/components/app-shell/SessionGoalBadge'
import { SessionFactChip } from '@/components/app-shell/SessionFactChip'

// =============================================================================
// Session goal chip (above-composer strip) — P4.2's DRAFT, for owner review.
//
// This is the only surface the chip has: the owner's 2026-08-23 process rule
// puts every new Phase-4 surface in the playground first and corrects it here
// before it reaches the app. So the states below are not a demo of a shipped
// component — they are the proposal, and every open question in it is a variant
// rather than a sentence in a report.
//
// THE STATES ARE THE STATUS UNION, NOT A SELECTION. `PiHarnessGoalStatusV1` has
// exactly five members and all five are here, plus the two `blockedBy` arms
// (they change the sentence in the popover, which is the only place that fact
// is visible), plus the state that renders NOTHING — a session with no goal,
// which is the overwhelmingly common one and is invisible in the app by
// construction, so the playground is the only place a reviewer can confirm the
// chip adds no empty box to the strip.
//
// THE TWO OPEN DESIGN QUESTIONS, both wired as knobs so they can be looked at:
//
//  1. `valueMode` — does the chip's one line carry the BUDGET POSITION
//     ("Goal · 3 of 32 turns", the draft's default) or the CONDITION
//     ("Goal · Ship the verified change", truncated at the 140px value slot)?
//     Progress is proposed because it is the part that moves while the user
//     watches, and because the condition is a model-authored sentence that
//     truncates to a few words. The `Active (condition, long)` variant is what
//     that truncation actually looks like.
//  2. `neighbours` — the chip's fit beside the row's other chips. Since
//     UB14.55 the row is ONE quiet chip row and the goal's neighbours are the
//     session-fact chips (never persisted, the pinned agent): the reference
//     chips here ARE that component (`SessionFactChip`, a light module), in
//     the row's own container classes, so height, radius and gap are the real
//     ones. The row itself is not drawn — importing `ActiveOptionBadges` into
//     a registry module drags `@nessy-agent/ui` in and cannot be loaded in a
//     shared bun test process at all (measured and documented in
//     `background-task-chip.test.tsx`).
// =============================================================================

const CONDITION = 'Ship the verified change'
const LONG_CONDITION =
  'Ship the verified change: every renderer test green, the i18n parity and sorted gates green,'
  + ' and the release notes updated for the version this lands in'

/**
 * Shaped exactly like `GoalService.safeSnapshot()`'s output, which is what the
 * wire will carry — `condition`, `creator` and every evaluation `reason` have
 * already been through `redact()`/`redactIdentifier()` by the time the renderer
 * sees them, so nothing below is more permissive than the real payload.
 */
function goal(overrides: Partial<PiHarnessGoalSummaryV1> = {}): PiHarnessGoalSummaryV1 {
  return {
    id: 'goal-7f3c1a',
    revision: 4,
    status: 'active',
    source: 'user',
    creator: 'user',
    condition: CONDITION,
    budgets: { turnLimit: 32, tokenLimit: 250_000, costLimitUsd: 5, elapsedLimitMs: 3_600_000 },
    accounting: { turns: 3, tokens: 18_400, costUsd: 0.42, elapsedMs: 214_000, resumeCount: 0 },
    createdAt: Date.now() - 214_000,
    updatedAt: Date.now(),
    ...overrides,
  }
}

const EVALUATION = {
  notComplete: {
    source: 'evaluator' as const,
    verdict: 'not_complete' as const,
    reason: 'The renderer tests pass but the i18n sorted gate has not been run yet.',
    evidence: ['bun test apps/electron: 412 pass'],
    evaluatedAt: Date.now(),
  },
  completed: {
    source: 'evaluator' as const,
    verdict: 'completed' as const,
    reason: 'All four gates are green and the release notes name this version.',
    evidence: ['lint:i18n:parity ok', 'lint:i18n:sorted ok'],
    evaluatedAt: Date.now(),
  },
  budget: {
    source: 'budget' as const,
    verdict: 'budget_exhausted' as const,
    reason: 'Usage: 32/32 turns, 61200/250000 tokens, $1.9100/$5.',
    evidence: [],
    evaluatedAt: Date.now(),
  },
}

const GOALS: Record<string, PiHarnessGoalSummaryV1 | undefined> = {
  none: undefined,
  'active-early': goal(),
  'active-near-budget': goal({
    accounting: { turns: 30, tokens: 208_000, costUsd: 3.9, elapsedMs: 2_900_000, resumeCount: 1 },
    lastEvaluation: EVALUATION.notComplete,
  }),
  'active-long-condition': goal({ condition: LONG_CONDITION }),
  complete: goal({
    status: 'complete',
    accounting: { turns: 11, tokens: 74_000, costUsd: 1.2, elapsedMs: 900_000, resumeCount: 0 },
    lastEvaluation: EVALUATION.completed,
  }),
  'blocked-user': goal({
    status: 'blocked',
    blocking: { condition: 'Needs the owner to approve the release notes wording.', blockedBy: 'user', consecutive: 2 },
    lastEvaluation: EVALUATION.notComplete,
  }),
  'blocked-external': goal({
    status: 'blocked',
    blocking: { condition: 'Waiting for the signed build to appear in the update feed.', blockedBy: 'external', consecutive: 5 },
    lastEvaluation: EVALUATION.notComplete,
  }),
  cancelled: goal({ status: 'cancelled', accounting: { turns: 2, tokens: 4_100, costUsd: 0.08, elapsedMs: 61_000, resumeCount: 0 } }),
  'budget-exhausted': goal({
    status: 'budget_exhausted',
    accounting: { turns: 32, tokens: 61_200, costUsd: 1.91, elapsedMs: 3_600_000, resumeCount: 0 },
    lastEvaluation: EVALUATION.budget,
  }),
}

function GoalBadgePreview({
  state = 'active-early',
  valueMode = 'progress',
  detailsOpen = false,
  neighbours = true,
}: {
  state?: string
  valueMode?: string
  detailsOpen?: boolean
  neighbours?: boolean
}) {
  const { t } = useTranslation()
  const selected = GOALS[state]
  return (
    // The chip row's own container classes (`ActiveOptionBadges`, UB14.55), so gap and vertical rhythm read true.
    <div className="w-[620px] max-w-full flex min-w-0 flex-wrap items-center gap-1.5 mb-2 px-px">
      {neighbours && (
        <>
          <SessionFactChip label={t('session.neverPersistBadge')} title={t('session.neverPersistBadgeTitle')} icon={<EyeOff />} />
          <SessionFactChip
            label={t('session.sessionAgentBadge', { name: 'reviewer' })}
            title={t('session.sessionAgentBadgeTitle', { name: 'reviewer' })}
            icon={<AtSign />}
          />
        </>
      )}
      <SessionGoalBadge
        goal={selected}
        valueMode={valueMode as SessionGoalBadgeValueMode}
        detailsOpen={detailsOpen}
        onDetailsOpenChange={() => {}}
      />
      {!selected && (
        <span className="text-xs text-muted-foreground self-center">
          (no goal — the chip renders nothing and the strip keeps its own spacing)
        </span>
      )}
    </div>
  )
}

function GoalDetailsPreview({ state = 'active-near-budget' }: { state?: string }) {
  const selected = GOALS[state]
  if (!selected) {
    return (
      <span className="text-xs text-muted-foreground">
        (no goal — there is no popover to open)
      </span>
    )
  }
  return (
    <div className="rounded-md border border-border bg-popover shadow-md">
      <SessionGoalDetails goal={selected} />
    </div>
  )
}

const STATE_OPTIONS = Object.keys(GOALS).map(value => ({ label: value, value }))

export const sessionGoalComponents: ComponentEntry[] = [
  {
    id: 'session-goal-badge',
    name: 'SessionGoalBadge',
    category: 'Chat',
    description: 'DRAFT for owner review (P4.2) — the goal chip proposed for the above-composer strip, in every goal status',
    component: GoalBadgePreview,
    layout: 'centered',
    props: [
      {
        name: 'state',
        description: 'Goal status / shape',
        control: { type: 'select', options: STATE_OPTIONS },
        defaultValue: 'active-early',
      },
      {
        name: 'valueMode',
        description: 'OPEN QUESTION: what the chip line carries after "Goal ·"',
        control: {
          type: 'select',
          options: [
            { label: 'progress (draft default)', value: 'progress' },
            { label: 'condition', value: 'condition' },
          ],
        },
        defaultValue: 'progress',
      },
      {
        name: 'detailsOpen',
        description: 'Open the popover in place',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'neighbours',
        description: 'Show reference chips for fit against the strip\'s existing ones',
        control: { type: 'boolean' },
        defaultValue: true,
      },
    ],
    variants: [
      { name: 'No goal (renders nothing)', props: { state: 'none' } },
      { name: 'Active (early)', props: { state: 'active-early' } },
      { name: 'Active (near budget)', props: { state: 'active-near-budget' } },
      { name: 'Active (condition, long)', props: { state: 'active-long-condition', valueMode: 'condition' } },
      { name: 'Complete', props: { state: 'complete' } },
      { name: 'Blocked (user)', props: { state: 'blocked-user' } },
      { name: 'Blocked (external)', props: { state: 'blocked-external' } },
      { name: 'Cancelled', props: { state: 'cancelled' } },
      { name: 'Budget exhausted', props: { state: 'budget-exhausted' } },
      { name: 'Popover open', props: { state: 'active-near-budget', detailsOpen: true } },
      { name: 'Alone in the strip', props: { state: 'active-early', neighbours: false } },
    ],
  },
  {
    id: 'session-goal-details',
    name: 'SessionGoalDetails',
    category: 'Chat',
    description: 'DRAFT for owner review (P4.2) — the goal chip\'s popover body: condition, status, turn budget, blocking note, last check',
    component: GoalDetailsPreview,
    layout: 'centered',
    props: [
      {
        name: 'state',
        description: 'Goal status / shape',
        control: { type: 'select', options: STATE_OPTIONS },
        defaultValue: 'active-near-budget',
      },
    ],
    variants: [
      { name: 'No goal', props: { state: 'none' } },
      { name: 'Active (no evaluation yet)', props: { state: 'active-early' } },
      { name: 'Active (near budget)', props: { state: 'active-near-budget' } },
      { name: 'Active (condition, long)', props: { state: 'active-long-condition' } },
      { name: 'Complete', props: { state: 'complete' } },
      { name: 'Blocked (user)', props: { state: 'blocked-user' } },
      { name: 'Blocked (external)', props: { state: 'blocked-external' } },
      { name: 'Cancelled', props: { state: 'cancelled' } },
      { name: 'Budget exhausted', props: { state: 'budget-exhausted' } },
    ],
  },
]
