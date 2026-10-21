/**
 * ActiveTasksBar — the row of background-task chips above the composer (BackgroundTaskChip).
 *
 * Chips slide in, leave with a fade, and the rest close the gap (motion layout). One card is open at
 * a time; its chip stays while it is open, even after its task finished and its linger ran out.
 *
 * UB14.7 — craft-agents-oss `v0.15.1:apps/electron/src/renderer/components/app-shell/ActiveTasksBar.tsx` (Apache-2.0),
 * rebranded. Upstream's WRAPPING row replaces our horizontal scroll (R2 default 2): many tasks take more lines rather
 * than hiding off the edge. Ours, each named:
 *  - the D1.97 + D1.98 static chips — what the event feed cannot mint: the cron records this session will run later
 *    and the running work with no renderer event of its own (`monitor` rows, D1.98's watches), from ONE read
 *    (`sessions:listScheduledWork`) supplied as `scheduledWork`; the rule that turns a page into chips, and why an
 *    entry already on screen is dropped instead of drawn twice, is `lib/scheduled-work-chips.ts`. Static: no spinner
 *    (a record is not running), no card (neither the stop nor the output route accepts one of these ids);
 *  - the D1.268 empty sentence and the unavailable notice, both riding a row already open, never opening one;
 *  - UA12.186: a dismissed row stays in the atom (the live set would rebuild it) and is not drawn;
 *  - UA12.192's shell-liveness probe on the same one-second ticker;
 *  - UB12.79 takes upstream's composer props (`onStopTask`, `onDismissTask`, `onOpenTaskOutput`) onto OUR routes: Stop is
 *    `useBackgroundTasks.stopTask` (the L9 route by the row's own type, `stopping` since UB14.7), Dismiss its
 *    `dismissTask` (the UA12.186 mark below, never upstream's removal), Open ChatDisplay's task-output overlay with our
 *    read's answer (`OpenedTaskOutput`: an agent's digest, or our terminal data).
 * UB14.55: the row is its own line above `ActiveOptionBadges`' chip row (the mode chip during a decision prompt and
 * our session facts), with upstream's `mb-2`, so a growing number of tasks wraps upward without moving that row.
 */

import React from 'react'
import { useTranslation } from 'react-i18next'
import { useSetAtom } from 'jotai'
import { AnimatePresence, motion } from 'motion/react'
import { SPRING, TWEEN } from '@nessy-agent/ui/motion'
import type { SessionScheduledWorkPageV1 } from '@nessy-agent/shared/protocol'
import { cn } from '@/lib/utils'
import { projectScheduledWorkView, type ScheduledWorkChip } from '@/lib/scheduled-work-chips'
import { backgroundTasksAtomFamily, type BackgroundTask } from '@/atoms/sessions'
import { isShownBackgroundTask } from '@/lib/background-task-rows'
import { BackgroundTaskChip } from './BackgroundTaskChip'
import { advanceBackgroundTaskChips, confirmBackgroundTasksLive, probeShellLiveness } from './background-task-chip-state'
import type { OpenedTaskOutput } from './task-output'
import { COMPOSER_STATIC_META_CHIP } from './input/composer-styles'

// UA12.18 — ONE definition, in `atoms/sessions.ts` (as upstream): re-exported for the existing consumers.
export type { BackgroundTask } from '@/atoms/sessions'

/**
 * D1.97 + D1.98 — one static chip for a piece of background work the event feed cannot produce: a cron record that
 * will fire later, or running work with no renderer event of its own (a `monitor` — a watch — above all). No
 * spinner and no card, each a decision: a scheduled record is not running, a monitor's progress is not something
 * this renderer is told about, and neither the stop nor the output route accepts one of these ids. The description
 * is the chip's `title`.
 */
function ScheduledWorkBadge({ chip }: { chip: ScheduledWorkChip }) {
  const { t } = useTranslation()
  return (
    <div
      data-testid="scheduled-work-badge"
      title={chip.schedule ? `${chip.schedule} — ${chip.description}` : chip.description}
      className={COMPOSER_STATIC_META_CHIP}
    >
      <span className="text-tertiary">
        {chip.scheduled ? t('chat.backgroundTasks.scheduled') : chip.type}
      </span>
      <span className="font-mono text-mono-ui">{shortenScheduledId(chip.id)}</span>
      {chip.cadenceKey ? <span className="text-tertiary">{t(chip.cadenceKey)}</span> : null}
    </div>
  )
}

/** The eight-character head a static chip identifies its work by. */
function shortenScheduledId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}...` : id
}

export interface ActiveTasksBarProps {
  /** Background tasks of the session */
  tasks: BackgroundTask[]
  /**
   * D1.97 + D1.98 — the answer to one `sessions:listScheduledWork` read, or `undefined` before one has answered (and
   * after one that could not be read, which is silence rather than a claim — see `scheduled-work-chips.ts`).
   */
  scheduledWork?: SessionScheduledWorkPageV1
  sessionId: string
  /** Stop one task (ChatDisplay: `useBackgroundTasks.stopTask`, the L9 route by the row's own type) */
  onStopTask?: (task: BackgroundTask) => void
  /** Dismiss one chip (ChatDisplay: `useBackgroundTasks.dismissTask`, which marks the row, UA12.186) */
  onDismissTask?: (task: BackgroundTask) => void
  /** Show a task's full output (ChatDisplay opens it in an overlay) */
  onOpenTaskOutput?: (task: BackgroundTask, output: OpenedTaskOutput) => void
}

export function ActiveTasksBar({ tasks, scheduledWork, sessionId, onStopTask, onDismissTask, onOpenTaskOutput }: ActiveTasksBarProps) {
  const { t } = useTranslation()
  const setTasks = useSetAtom(backgroundTasksAtomFamily(sessionId))
  const [openTaskId, setOpenTaskId] = React.useState<string | null>(null)
  const openTaskIdRef = React.useRef(openTaskId)
  openTaskIdRef.current = openTaskId

  // Stop an unconfirmed chip from spinning forever without pretending the task died: old no-signal
  // tasks become `stale`, terminal ones are pruned after their linger — except the one whose card is open.
  //
  // UA12.192 — and, a minute before a SHELL chip's signal runs out, ask the supervisor (the session-scoped read Open
  // uses; the cursor past the end, so no log comes back) whether the shell still runs: a confirmed shell keeps reading
  // running instead of turning "no signal" at 20 min. `tasks` is read through a ref so the interval is not torn down on
  // every update; `asked` keeps each (row, signal) pair to one read.
  const tasksRef = React.useRef(tasks)
  tasksRef.current = tasks
  const askedRef = React.useRef(new Set<string>())
  React.useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now()
      setTasks((prev) => advanceBackgroundTaskChips(prev, now, openTaskIdRef.current))
      const api = typeof window === 'undefined' ? undefined : window.electronAPI
      if (typeof api?.readBackgroundTaskOutput !== 'function') return
      void probeShellLiveness(tasksRef.current, now, askedRef.current, taskId => api.readBackgroundTaskOutput(sessionId, taskId, Number.MAX_SAFE_INTEGER))
        .then(ids => { if (ids.length > 0) setTasks((prev) => confirmBackgroundTasksLive(prev, ids, Date.now())) })
    }, 1000)
    return () => clearInterval(interval)
  }, [sessionId, setTasks])

  // The ids already on screen, so the read's own copy of them is dropped rather than drawn a second time (a dismissed
  // row counts too: its task is still the event feed's, not a static chip's).
  const view = projectScheduledWorkView(scheduledWork, tasks.map(task => task.id))
  const shown = tasks.filter(isShownBackgroundTask)
  const visible = shown.length > 0 || view.chips.length > 0 || Boolean(view.noticeKey)

  return (
    <AnimatePresence initial={false}>
      {visible && (
        <motion.div
          key="background-tasks"
          data-slot="background-tasks"
          data-testid="active-tasks-bar"
          className="mb-2 flex min-w-0 flex-wrap items-center gap-1.5 px-px"
          // The row arrives with the session's first task: it rises in (the chips inside skip their
          // own enter on the row's first render). Rows already there on load don't animate.
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ ...SPRING.base, opacity: TWEEN.fast }}
          exit={{ opacity: 0, transition: TWEEN.exit }}
        >
          <AnimatePresence initial={false} mode="popLayout">
            {shown.map((task) => (
              <motion.div
                key={task.id}
                layout="position"
                // A flex wrapper: the chip must not sit on a text baseline. A running chip's shimmer sets
                // overflow:hidden, which moves an inline-flex box's baseline to its bottom edge, so running
                // and finished chips landed ~5px apart.
                className="flex min-w-0 max-w-full"
                initial={{ opacity: 0, y: 6, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, scale: 0.96, transition: TWEEN.exit }}
                transition={{ ...SPRING.base, opacity: TWEEN.fast }}
              >
                <BackgroundTaskChip
                  task={task}
                  sessionId={sessionId}
                  open={openTaskId === task.id}
                  onOpenChange={(open) => setOpenTaskId(current => (open ? task.id : current === task.id ? null : current))}
                  onStop={(target) => onStopTask?.(target)}
                  onDismiss={(target) => {
                    setOpenTaskId(null)
                    onDismissTask?.(target)
                  }}
                  onOpenOutput={onOpenTaskOutput}
                />
              </motion.div>
            ))}
          </AnimatePresence>
          {view.chips.map(chip => (
            <ScheduledWorkBadge key={`scheduled:${chip.id}`} chip={chip} />
          ))}
          {view.noticeKey ? (
            <div data-testid="scheduled-work-unavailable" className={cn(COMPOSER_STATIC_META_CHIP, 'text-tertiary')}>
              {t(view.noticeKey)}
            </div>
          ) : null}
          {/*
            D1.268 — the empty sentence rides a row that is already open: the guard above returns nothing for a session
            with no running rows, no chips and no notice, so it can only appear beside work already on screen, where
            "is anything else queued?" is the question the chips raise. A permanent chip on EVERY session with nothing
            queued is the `[product]` choice declined (the owner's "a flat list in the existing background-task panel
            with no new design"); `/tasks` prints the sentence durably. Flipping it is deleting the condition below.
          */}
          {view.emptyKey && !view.noticeKey ? (
            <div data-testid="scheduled-work-empty" className={cn(COMPOSER_STATIC_META_CHIP, 'text-tertiary')}>
              {t(view.emptyKey)}
            </div>
          ) : null}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
