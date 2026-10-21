/**
 * The rows above the composer: background-task chips, then ONE quiet chip row — the permission-mode chip while a
 * decision prompt replaces the composer toolbar, and this session's create-time facts. Session status, labels and
 * info live in the chat header (UB14.6), which keeps the composer stack light.
 *
 * UB14.55 — merged with v0.15.1:apps/electron/src/renderer/components/app-shell/ActiveOptionBadges.tsx (R2-08;
 * craft-agents-oss, Apache-2.0). Taken: the structure (the tasks row first, so a growing number of tasks wraps upward
 * without moving the row under it; then the chip row with upstream's classes), `ComposerModeChip` only while
 * `showPermissionMode` (default on for standalone use, as upstream), and the `sessionId`/mode guard. Dropped with
 * upstream: the label and status stack (`LabelBadge`, `StateBadge` and its `useDynamicStack` — the header owns them),
 * `FilesPopoverButton` (the header's Info opens the same `SessionInfoPopover`) and the slash-shaped
 * `PermissionModeDropdown` (F1.1168's menu; the chip carries the composer picker's F1.1052 content, UB14.29).
 * Re-applied (ours, R2 §6 default 1 — upstream's header has no slot for them, and moving them would be an invention):
 *  - P6.502 never-persist and P6.940 `@agent`, as static `SessionFactChip`s in the chip row;
 *  - P6.476 the session goal, read-only at `valueMode="progress"`, in the same row;
 *  - the D1.97/D1.98/D1.269 scheduled-work read, handed to `ActiveTasksBar`;
 *  - UB12.79: upstream's `onStopTask` / `onDismissTask` / `onOpenTaskOutput`, carrying OUR routes (L9 stop, the
 *    UA12.186 dismiss mark, the output read as `OpenedTaskOutput`);
 *  - the chip's menu content the toolbar chip has (the runtime's modes narrowed by the workspace cycle, P2.56; the
 *    F1.1052 decorations; the runtime note; `locked`) — upstream's row passes only the mode, ours has no other source.
 * The chip row also WRAPS (`flex-wrap min-w-0`, ours): it can hold four chips, where upstream's holds one.
 */
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useAtomValue } from 'jotai'
import { AtSign, EyeOff } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { PermissionMode } from '@nessy-agent/shared/agent/modes'
import { useOptionalAppShellContext } from '@/context/AppShellContext'
import {
  applyWorkspaceCycleToComposerModes,
  coercePermissionModeForComposer,
  getSupportedComposerPermissionModes,
  resolveComposerPermissionModeList,
  withPermissionModeMenuDecorations,
} from '@/lib/composer-permission-modes'
import { useSessionGoal } from '@/hooks/useSessionGoal'
import { useSessionScheduledWork } from '@/hooks/useSessionScheduledWork'
import { scheduledWorkRevision } from '@/lib/scheduled-work-refresh'
import { scheduledWorkNudgeAtomFamily } from '@/atoms/sessions'
import { ActiveTasksBar, type BackgroundTask } from './ActiveTasksBar'
import type { OpenedTaskOutput } from './task-output'
import { ComposerModeChip } from './input/ComposerModeChip'
import { useComposerCapabilities } from './input/composer-capabilities-context'
import { SessionGoalBadge } from './SessionGoalBadge'
import { SessionFactChip } from './SessionFactChip'

export interface ActiveOptionBadgesProps {
  /**
   * Render the permission-mode chip. ChatInputZone turns it on only while a decision prompt replaces the composer
   * toolbar, where the chip normally lives (spec §7.5). Defaults to on for standalone use.
   */
  showPermissionMode?: boolean
  /** Current permission mode */
  permissionMode?: PermissionMode
  /** Callback when permission mode changes */
  onPermissionModeChange?: (mode: PermissionMode) => void
  /**
   * The workspace's cyclable modes (`InputContainer`'s `enabledModes`): the chip's menu offers what ⇧Tab cycles
   * through, exactly as the toolbar chip's does (P2.56). Omitted: the runtime's whole list.
   */
  enabledModes?: PermissionMode[]
  /** The cycle action's binding (`getHotkey('chat.cyclePermissionMode')`, P6.49); see `ComposerModeChip`. */
  cycleHotkey?: string | null
  /**
   * P6.502 — this session is never written to disk.
   *
   * WHY A CHIP AND NOT ONLY THE TRANSCRIPT LINE. The host half (`7f564181d`)
   * puts the cost in the chat when the mode is entered; the row asks for the
   * mode to be *"visible for the life of the session rather than only at
   * entry"*, and a line in a transcript scrolls away. This row does not.
   *
   * WHY A PROP AND NOT A HOOK, unlike `useSessionGoal` below. The fact is the
   * SESSION's, decided once at create time by `options.ephemeral`, the
   * documented `CLAUDE_CODE_SKIP_PROMPT_HISTORY` env, or the
   * `neverPersistSessions` setting — it can never change while the session is
   * open, so there is nothing to subscribe to and a read here would be an RPC
   * per render for a constant.
   *
   * Optional and defaulting to false, so the playground and every caller that
   * does not know renders exactly what it rendered before.
   */
  neverPersist?: boolean
  /** Background tasks to display (`ActiveTasksBar` draws them; the count also feeds the scheduled-work read) */
  tasks?: BackgroundTask[]
  sessionId?: string
  /** With `sessionId`, the goal read's address (P6.476) */
  workspaceId?: string
  onStopTask?: (task: BackgroundTask) => void
  onDismissTask?: (task: BackgroundTask) => void
  /**
   * Show a task's full output (ChatDisplay opens it in an overlay). Supplied by the product as of L9 — `ChatDisplay`
   * owns a `task-output` overlay state and `ChatInputZone` passes the handler down. It stays OPTIONAL because the
   * task chip's card (UB14.7, `BackgroundTaskChip`) must remain usable by a caller with no overlay, and it hides its
   * Open button when there is none.
   */
  onOpenTaskOutput?: (task: BackgroundTask, output: OpenedTaskOutput) => void
  /** Additional CSS classes for the chip row */
  className?: string
}

export function ActiveOptionBadges({
  showPermissionMode = true,
  permissionMode = 'default',
  onPermissionModeChange,
  enabledModes,
  cycleHotkey,
  neverPersist = false,
  tasks = [],
  sessionId,
  workspaceId,
  onStopTask,
  onDismissTask,
  onOpenTaskOutput,
  className,
}: ActiveOptionBadgesProps) {
  const { t } = useTranslation()

  // P6.476 — the session goal, read here rather than threaded down as a prop:
  // the two ids the read needs are already in this signature. `undefined` for
  // the overwhelmingly common session that has no goal, and for every caller
  // outside Electron (the playground renders this component too).
  const goal = useSessionGoal(sessionId, workspaceId)

  // D1.97 + D1.98 — this session's cron records and the background work the
  // event feed cannot mint (watches, which are `type: 'monitor'`), read here for
  // `useSessionGoal`'s reason: `sessionId` is already in this signature, and
  // threading a page through two more component signatures would add a prop
  // nothing else in either would read.
  //
  // D1.269 — the revision is now BOTH signals: the task count (a running row
  // moved) and the host's `scheduled_work_changed` nudge count (the scheduled
  // half moved). Composite rather than a sum, because the two move in opposite
  // directions and a sum can cancel — see `lib/scheduled-work-refresh.ts`.
  const scheduledWorkNudges = useAtomValue(scheduledWorkNudgeAtomFamily(sessionId ?? ''))
  const scheduledWork = useSessionScheduledWork(
    sessionId,
    scheduledWorkRevision(tasks.length, scheduledWorkNudges),
  )

  // P6.940 clause (1) — the agent this session runs AS, read from the composer
  // capabilities rather than threaded as a prop: this component is already
  // inside `ComposerCapabilitiesProvider` (`ChatInputZone`), and the server has
  // already decided whether the pin APPLIES on this session's runtime. Reading
  // the `sessionAgent` setting here instead would put `@X` on a Pi or codex
  // session that ignores it.
  const sessionAgent = useComposerCapabilities().sessionAgent

  const showMode = showPermissionMode && !!permissionMode
  // The chip row shows for the mode chip OR any one session fact alone — P6.502, P6.940, P6.476: the whole point of
  // a fact chip is that it stays visible in a session that has nothing else here, a brand-new chat above all.
  const showChipRow = showMode || neverPersist || !!sessionAgent || !!goal
  if (!sessionId && !showChipRow) return null

  return (
    <>
      {/* Background tasks row (running / done / orphaned chips, and our scheduled-work chips), above the chip row so
       * a growing number of tasks wraps without moving it. Always mounted with a session: it animates its own exit
       * and draws nothing while it has nothing (dismissed rows included, UA12.186). */}
      {sessionId && (
        <ActiveTasksBar
          tasks={tasks}
          scheduledWork={scheduledWork}
          sessionId={sessionId}
          onStopTask={onStopTask}
          onDismissTask={onDismissTask}
          onOpenTaskOutput={onOpenTaskOutput}
        />
      )}

      {showChipRow && (
        <div data-slot="session-chips" className={cn('flex min-w-0 flex-wrap items-center gap-1.5 mb-2 px-px', className)}>
          {showMode && (
            <DecisionPromptModeChip
              permissionMode={permissionMode}
              onPermissionModeChange={onPermissionModeChange}
              enabledModes={enabledModes}
              cycleHotkey={cycleHotkey}
              sessionId={sessionId}
            />
          )}

          {/* P6.502 — never-persist, beside the mode because it is the same kind of
           * fact: session-wide, fixed at create time, and it changes what the
           * session can do. Static: nothing here can turn persistence back on.
           * The label is short and the full cost is the `title`: the sentence
           * names resume, rewind and search. */}
          {neverPersist && (
            <SessionFactChip
              label={t('session.neverPersistBadge')}
              title={t('session.neverPersistBadgeTitle')}
              icon={<EyeOff />}
              data-testid="never-persist-badge"
            />
          )}

          {/* P6.940 clause (1) — the pinned session agent. Static, like the
           * never-persist chip: nothing here can repin a running session. The
           * title carries the half the label cannot — the prompt and the tools
           * apply, the model does not. */}
          {sessionAgent && (
            <SessionFactChip
              label={t('session.sessionAgentBadge', { name: sessionAgent })}
              title={t('session.sessionAgentBadgeTitle', { name: sessionAgent })}
              icon={<AtSign />}
              data-testid="session-agent-badge"
            />
          )}

          {/* P6.476 — the session goal, the owner's 2026-09-05 Q3 option A:
           * READ-ONLY at `valueMode: progress` (B's composer command and cancel
           * popover were declined). Its popover explains the goal; nothing here
           * creates, cancels or edits one. `SessionGoalBadge` returns null with
           * no goal, and `showChipRow` carries `goal` so a goal alone shows the row. */}
          {goal && (
            <SessionGoalBadge goal={goal} valueMode="progress" />
          )}
        </div>
      )}
    </>
  )
}

/**
 * The toolbar's own mode chip, raised into the chip row while a decision prompt replaces the toolbar (the toolbar,
 * and with it `FreeFormInput`'s chip, is not mounted then). Its menu is derived exactly as `FreeFormInput` derives the
 * toolbar chip's — so both offer the same rows — but it writes nothing back: the D1.327 coercion effect stays the
 * toolbar's, and here the coerced mode is only what the chip shows.
 */
function DecisionPromptModeChip({
  permissionMode,
  onPermissionModeChange,
  enabledModes,
  cycleHotkey,
  sessionId,
}: {
  permissionMode: PermissionMode
  onPermissionModeChange?: (mode: PermissionMode) => void
  enabledModes?: PermissionMode[]
  cycleHotkey?: string | null
  sessionId?: string
}) {
  const { t } = useTranslation()
  const capabilities = useComposerCapabilities()
  const defaultMode = useOptionalAppShellContext()?.defaultPermissionMode
  const list = React.useMemo(() => resolveComposerPermissionModeList(capabilities, t), [capabilities, t])
  const displays = React.useMemo(
    () => applyWorkspaceCycleToComposerModes(list.modes, enabledModes).map(withPermissionModeMenuDecorations(defaultMode)),
    [list.modes, enabledModes, defaultMode],
  )
  const mode = React.useMemo(
    () => coercePermissionModeForComposer(permissionMode, getSupportedComposerPermissionModes(capabilities)),
    [permissionMode, capabilities],
  )
  return (
    <ComposerModeChip
      permissionMode={mode}
      onPermissionModeChange={onPermissionModeChange}
      permissionModeDisplays={displays}
      runtimeNote={list.runtimeNote}
      locked={capabilities.permissions.locked}
      sessionId={sessionId}
      cycleHotkey={cycleHotkey}
    />
  )
}
