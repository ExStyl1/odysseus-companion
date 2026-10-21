/**
 * A background task's full output, opened from its chip card (the card's Open): a command's output in the terminal
 * overlay, an agent's message and recent steps as one document in the markdown overlay.
 *
 * UB12.79 — v0.15.1:apps/electron/src/renderer/components/app-shell/ChatDisplay.tsx (craft-agents-oss, Apache-2.0),
 * its `overlayState?.type === 'task-output'` branch: `kind === 'text'` → `TerminalPreviewOverlay`, an agent →
 * `DocumentFormattedMarkdownOverlay` with `agentDocument(output, t('chat.backgroundTask.recentSteps'))` and a blue
 * `Bot` badge naming the task. Ours, each named:
 *  - its own file (upstream keeps it inline in `ChatDisplay`), so the playground's sweep can render both arms for real
 *    — `ChatDisplay` cannot be imported by a test (its graph reaches the ui barrel's Vite-only pdfjs specifier);
 *  - the TEXT arm is L9's, not upstream's `command={title} output={text}`: the host's own command line, the whole log
 *    read afresh, the exit code, and the running notice in the header. That notice is a claim with a shelf life — the
 *    read is fetch-once and nothing re-reads while the overlay stays open — so it is ANDed with the live signal the
 *    caller holds: the task is still in the session's background-task list. That list is retired by the very events
 *    the process's ending produces (`shell_killed`, `task_completed`), so the notice stops with the row, with no
 *    timer, no subscription and no second source of truth. `TerminalOutput` prints `(no output)` for an empty string,
 *    a FINISHED command's vocabulary, which is why the header has to carry the running fact at all (see
 *    `taskOutputOverlayTitle`, the only reader `isRunning` has). `error` is deliberately unset: a read that failed
 *    never reaches this overlay — it is a translated toast in the card (UB14.7).
 */
import * as React from "react"
import { useTranslation } from "react-i18next"
import { Bot } from "lucide-react"
import { DocumentFormattedMarkdownOverlay, TerminalPreviewOverlay } from "@nessy-agent/ui"
import type { BackgroundTask } from "@/atoms/sessions"
import { agentDocument } from "../BackgroundTaskChip"
import { taskOutputOverlayTitle, type TaskOutputOverlayState } from "../task-output"

export interface TaskOutputOverlayProps {
  state: TaskOutputOverlayState
  /** The session's background-task rows: the running notice holds only while its task is still among them (L9). */
  tasks: readonly Pick<BackgroundTask, 'id'>[]
  onClose: () => void
  theme: 'dark' | 'light'
  onOpenUrl?: (url: string) => void
  onOpenFile?: (path: string) => void
}

export function TaskOutputOverlay({ state, tasks, onClose, theme, onOpenUrl, onOpenFile }: TaskOutputOverlayProps) {
  const { t } = useTranslation()
  const { output } = state

  if (output.kind === 'agent') {
    return (
      <DocumentFormattedMarkdownOverlay
        isOpen={true}
        onClose={onClose}
        content={agentDocument(output, t('chat.backgroundTask.recentSteps'))}
        onOpenUrl={onOpenUrl}
        onOpenFile={onOpenFile}
        typeBadge={{ icon: Bot, label: state.title, variant: 'blue' }}
      />
    )
  }

  const stillListed = output.taskId === undefined || tasks.some(task => task.id === output.taskId)
  const title = taskOutputOverlayTitle({ ...output, isRunning: output.isRunning === true && stillListed })
  return (
    <TerminalPreviewOverlay
      isOpen={true}
      onClose={onClose}
      command={output.command}
      output={output.output}
      exitCode={output.exitCode}
      toolType={output.toolType}
      description={title.runningKey ? t(title.runningKey, { subject: title.subject }) : title.subject}
      theme={theme}
    />
  )
}
