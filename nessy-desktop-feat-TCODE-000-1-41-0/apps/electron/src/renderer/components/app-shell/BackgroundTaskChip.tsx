/**
 * A background task of the session (subagent, shell command, workflow) as a chip above the composer,
 * and the card it opens.
 *
 * The chip says what runs and for how long: a spinner and a slow shimmer while it runs, a check, cross
 * or stop mark once it ends (the glyphs cross-fade). The card shows what the task is doing — an agent's
 * live one-line summary, its step count and recent steps, then its result; a command's output tail —
 * refreshed while the card is open, with Open (the full output in an overlay), Copy, and Stop or Dismiss.
 *
 * UB14.7 — ported from craft-agents-oss `v0.15.1:apps/electron/src/renderer/components/app-shell/BackgroundTaskChip.tsx`
 * (Apache-2.0; ADDED in v0.15.0, "Background tasks you can follow and stop"), rebranded. Ours, each named:
 *  - THE READ is ours: `readBackgroundTaskOutput(sessionId, taskId, cursor)` (the Pi supervisor's store from a cursor,
 *    a Claude CLI task file's digest since UB9.8, an ended task's record), folded onto upstream's
 *    `BackgroundTaskOutput` by {@link foldTaskCardOutput} — never upstream's `getBackgroundTaskOutput`. Our
 *    `unknown-task` is upstream's `null`.
 *  - THE GATES moved here from the retired `TaskActionMenu.tsx`: {@link canViewTaskOutput} (UA12.205, UA12.210 and
 *    UB9.8's live Claude read) decides whether the card reads at all and whether Open is offered — a codex terminal
 *    has no live read, so its card never reads and its Open is hidden (the stated residue); {@link canStopTask}
 *    (UA12.18) decides Stop.
 *  - OPEN is upstream's `onOpenOutput(task, output)` (UB12.79) fed by OUR read (L9): a fresh `requestTaskOutput` — the
 *    whole output, not the card's tail, with translated failures — handed up as an agent's digest (upstream's
 *    markdown overlay, {@link agentDocument}) or as our terminal data with the running notice
 *    (`OpenedTaskOutput`), instead of the card's own `output`.
 *  - DISMISS is on every chip (UA12.18's escape hatch for a chip whose end was never reported) and MARKS the row
 *    (UA12.186), so a live set re-stating the task cannot bring it back.
 *  - no `orphaned` state (UA12.18 dropped it), no workflow agent counter (UA4.11 item 1), and the agent's message
 *    renders through a lazily loaded `MemoizedMarkdown`, so this graph never reaches the ui barrel's pdfjs (P6.844).
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AnimatePresence, motion } from 'motion/react'
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Copy,
  FilePen,
  FileText,
  Globe,
  Maximize2,
  Plug,
  Search,
  Square,
  SquareTerminal,
  Workflow,
  Wrench,
  X,
  XCircle,
  type LucideIcon,
} from 'lucide-react'
import { toast } from 'sonner'
// Subpaths, never the `@nessy-agent/ui` barrel: its graph ends at a Vite-only pdfjs specifier `bun test` cannot load.
import { Spinner } from '@nessy-agent/ui/ui/LoadingIndicator'
import { SPRING } from '@nessy-agent/ui/motion'
import type { BackgroundTaskOutput, BackgroundTaskOutputResult, BackgroundTaskStep } from '@nessy-agent/shared/protocol'
import { isSupervisedProcessHandle } from '@nessy-agent/shared/agent/pi-harness/process-supervisor-port'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { BackgroundTask } from '@/atoms/sessions'
import { cn } from '@/lib/utils'
import { COMPOSER_META_CHIP } from './input/composer-styles'
import { backgroundTaskElapsedSeconds, isTerminalBackgroundTask } from './background-task-chip-state'
import { requestTaskOutput, type AgentTaskOutput, type OpenedTaskOutput } from './task-output'

/** How often an open card re-reads a running task's output. */
const OUTPUT_POLL_MS = 2_000
/** Recent steps the card lists. */
const CARD_STEPS = 4
/** A running agent's message is clamped to a few lines: parse only what could show. */
const LIVE_MESSAGE_CHARS = 1_200
/** The card keeps a command's output tail, as the host's Claude read does (64 KiB); Open shows the whole log. */
export const CARD_TAIL_CHARS = 64 * 1024

/** Compact elapsed time: 45s, 2m 49s, 1h 5m. */
export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`
}

function isLive(task: Pick<BackgroundTask, 'status'>): boolean {
  return task.status === 'running' || task.status === 'stale'
}

/**
 * WHICH CHIPS CAN SHOW OUTPUT — moved from `TaskActionMenu.tsx` (UA12.205, UA12.210), widened by UB9.8.
 *
 * - A Pi `shell` row is a handle in the supervisor's own process store, readable while it runs and after
 *   ({@link isSupervisedProcessHandle} tells it from a Claude task id or a codex terminal id by the store's own shape).
 * - An ENDED row is readable when its `task_completed` carried an output file or a summary (`endOutput`); codex's
 *   background-terminal end carries neither (UA12.210).
 * - UB9.8 — a LIVE row the Claude CLI's live level still names (`listed`, no `unlistedAt`: built from
 *   `background_tasks_replaced`, the same level the host's read is gated by) is read from its own task file.
 *
 * Everything else has nothing the host can read while it runs: a Pi agent task (its output exists at its end) and a
 * codex terminal (`thread/backgroundTerminals/*` is list / terminate / clean, no read). The card does not read those
 * and does not offer Open; the end, if it leaves something, makes the row readable.
 */
export function canViewTaskOutput(
  task: Pick<BackgroundTask, 'id' | 'type' | 'status' | 'endOutput' | 'listed' | 'unlistedAt'>,
): boolean {
  if (task.type === 'shell' && isSupervisedProcessHandle(task.id)) return true // UA12.205
  if (isTerminalBackgroundTask(task)) return task.endOutput === true // UA12.210
  return task.listed === true && task.unlistedAt === undefined // UB9.8
}

/**
 * UA12.18 — WHICH CHIPS CAN BE STOPPED: the live ones, of any kind. A terminal chip only lingers to say how its task
 * ended; a chip the runtime's live set no longer names is held only for its end report — its task is gone. A `stale`
 * chip is still offered Stop: it has no end on record, which is exactly when the user may want one.
 */
export function canStopTask(task: Pick<BackgroundTask, 'status' | 'unlistedAt'>): boolean {
  return !isTerminalBackgroundTask(task) && task.unlistedAt === undefined
}

/** One fold of the card's read: what it shows, and where the live store's next read starts. */
export interface TaskCardRead {
  output: BackgroundTaskOutput | null
  /** The supervisor store's own byte offset — present only when the last read came from the live store. */
  cursor?: number
}

/** A read the card cannot show: the host's reason code, and its detail for the log only (never rendered). */
export class TaskCardReadError extends Error {
  constructor(readonly reason: string, readonly detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason)
  }
}

/**
 * Fold one `readBackgroundTaskOutput` answer onto upstream's `BackgroundTaskOutput`.
 *
 * - `unknown-task` is upstream's `null` (nothing to show); any other refusal throws, so the card offers Retry.
 * - a digest (UB9.8: a Claude task file, live or ended) is shown as it came.
 * - the live store answers FROM THE CURSOR the previous read ended at, so its chunk is appended; anything else is the
 *   whole text. Either way the card keeps the last {@link CARD_TAIL_CHARS} and says when it cut.
 */
export function foldTaskCardOutput(previous: TaskCardRead | null, result: BackgroundTaskOutputResult | undefined): TaskCardRead {
  if (!result?.success) {
    if (result?.reason === 'unknown-task') return { output: null }
    throw new TaskCardReadError(result?.reason ?? 'failed', result?.error)
  }
  if (result.digest) return { output: result.digest }
  const chunk = result.output ?? ''
  const before = previous?.output?.kind === 'text' ? previous.output : undefined
  const appending = previous?.cursor !== undefined && result.nextCursor !== undefined && before !== undefined
  const whole = appending ? before.text + chunk : chunk
  const truncated = (appending && before.truncated) || whole.length > CARD_TAIL_CHARS
  return {
    output: { kind: 'text', text: whole.length > CARD_TAIL_CHARS ? whole.slice(-CARD_TAIL_CHARS) : whole, truncated },
    ...(result.nextCursor === undefined ? {} : { cursor: result.nextCursor }),
  }
}

/** One read of the card: from where the last one ended, through the session-scoped route. */
export async function readTaskCardOutput(
  read: (cursor?: number) => Promise<BackgroundTaskOutputResult>,
  previous: TaskCardRead | null,
): Promise<TaskCardRead> {
  return foldTaskCardOutput(previous, await read(previous?.cursor))
}

/** Elapsed seconds: ticking while the task runs, frozen at its end (`backgroundTaskElapsedSeconds`, UA12.18). */
function useElapsed(task: BackgroundTask): number {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    if (task.status !== 'running') return
    const interval = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(interval)
  }, [task.status])
  return backgroundTaskElapsedSeconds(task, now)
}

const TYPE_ICON: Record<BackgroundTask['type'], LucideIcon> = { agent: Bot, shell: SquareTerminal, workflow: Workflow }
const TYPE_LABEL_KEY: Record<BackgroundTask['type'], string> = {
  agent: 'chat.backgroundTask.typeAgent',
  shell: 'chat.backgroundTask.typeShell',
  workflow: 'chat.backgroundTask.typeWorkflow',
}

function useStatusText(task: BackgroundTask): string {
  const { t } = useTranslation()
  if (task.stopping && isLive(task)) return t('chat.backgroundTask.stopping')
  switch (task.status) {
    case 'running': return t('chat.backgroundTask.running')
    case 'completed': return t('chat.backgroundTask.done')
    case 'failed': return t('chat.backgroundTask.failed')
    case 'stopped': return t('chat.backgroundTask.stopped')
    case 'stale': return t('chat.backgroundTask.noSignal')
  }
}

/** The status glyph; a change cross-fades with a small scale (spring "snap"). */
function StatusGlyph({ task }: { task: BackgroundTask }) {
  const stopping = task.stopping && isLive(task)
  const key = stopping ? 'stopping' : task.status
  const glyph = stopping || task.status === 'running'
    ? <Spinner className="text-label-sm text-tertiary" />
    : task.status === 'completed' ? <CheckCircle2 className="size-3.5 text-success" />
    : task.status === 'failed' ? <XCircle className="size-3.5 text-destructive" />
    : task.status === 'stopped' ? <Square className="size-3 fill-current text-tertiary" />
    : <AlertTriangle className="size-3.5 text-info" />
  return (
    <span className="relative grid size-3.5 shrink-0 place-items-center" aria-hidden>
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={key}
          className="grid place-items-center"
          initial={{ opacity: 0, scale: 0.5 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.5 }}
          transition={SPRING.snap}
        >
          {glyph}
        </motion.span>
      </AnimatePresence>
    </span>
  )
}

function stepIcon(tool: string): LucideIcon {
  if (tool === 'Bash') return SquareTerminal
  if (tool === 'Read') return FileText
  if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit' || tool === 'NotebookEdit') return FilePen
  if (tool === 'Grep' || tool === 'Glob') return Search
  if (tool === 'WebFetch' || tool === 'WebSearch') return Globe
  if (tool === 'Task' || tool === 'Agent') return Bot
  if (tool.startsWith('mcp__')) return Plug
  return Wrench
}

/** A source tool shows its source (`mcp__linear__list_issues` → `linear`; the label names the action); built-in tools keep their name. */
function stepToolName(tool: string): string {
  return tool.startsWith('mcp__') ? tool.split('__')[1] || tool : tool
}

/** The card's text for Copy and Open: a command's output, or an agent's message. */
export function outputText(output: BackgroundTaskOutput | null): string | null {
  if (!output) return null
  if (output.kind === 'text') return output.text.trim() ? output.text : null
  return output.message
}

/**
 * An agent's output as one document for the overlay: its message, then its recent steps. UB12.79 — v0.15.1 1:1
 * (`ChatDisplay`'s task-output overlay renders it in `DocumentFormattedMarkdownOverlay`).
 */
export function agentDocument(output: AgentTaskOutput, stepsHeading: string): string {
  const steps = output.steps.map(step => `- **${stepToolName(step.tool)}**${step.label ? ` ${step.label}` : ''}`).join('\n')
  return [output.message ?? '', steps ? `**${stepsHeading}**\n\n${steps}` : ''].filter(Boolean).join('\n\n---\n\n')
}

/** Same content as last time? Then keep the old object, so nothing re-renders. */
function sameOutput(a: BackgroundTaskOutput | null, b: BackgroundTaskOutput | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Reads the task's output while the card is open: once, then again OUTPUT_POLL_MS after each answer
 * while it runs (never two requests in flight, so a slow answer can't overwrite a newer one). A
 * failed read stops the polling and offers Retry. A row with nothing readable ({@link canViewTaskOutput}) is never
 * read at all.
 */
function useTaskOutput(sessionId: string, task: BackgroundTask, readable: boolean) {
  const [state, setState] = React.useState<{ output: BackgroundTaskOutput | null; status: 'loading' | 'ready' | 'error' }>(
    () => ({ output: null, status: readable ? 'loading' : 'ready' }),
  )
  const [attempt, setAttempt] = React.useState(0)
  const live = isLive(task)
  const lastReadRef = React.useRef<TaskCardRead | null>(null)

  React.useEffect(() => {
    if (!readable) return
    let current = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      try {
        const next = await readTaskCardOutput(
          cursor => window.electronAPI.readBackgroundTaskOutput(sessionId, task.id, cursor),
          lastReadRef.current,
        )
        if (!current) return
        lastReadRef.current = next
        const output = next.output
        setState(previous => (previous.status === 'ready' && sameOutput(previous.output, output) ? previous : { output, status: 'ready' }))
        // A running task keeps writing; a finished one was read once more, for its final output
        if (live) timer = setTimeout(() => void load(), OUTPUT_POLL_MS)
      } catch (error) {
        if (!current) return
        // The backend's own words go to the log, never on screen (L9); the card says "couldn't load" in the user's language.
        console.error(`[BackgroundTaskChip] output read for ${task.id} refused:`, error instanceof Error ? error.message : error)
        setState(previous => ({ output: previous.output, status: previous.output ? 'ready' : 'error' }))
      }
    }
    void load()
    return () => {
      current = false
      if (timer) clearTimeout(timer)
    }
  }, [sessionId, task.id, live, task.status, attempt, readable])

  return { ...state, reload: () => setAttempt(n => n + 1) }
}

function CardButton({ icon: Icon, tone, children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon: LucideIcon; tone?: 'destructive' }) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        'motion-press inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-label-sm font-medium -outline-offset-2',
        'transition-[background-color,color] duration-micro ease-out-subtle hover:duration-instant',
        'disabled:pointer-events-none disabled:text-disabled',
        tone === 'destructive' ? 'text-destructive hover:bg-destructive-tint' : 'text-secondary hover:bg-fill-hover hover:text-foreground',
      )}
    >
      <Icon className="size-3.5 shrink-0" />
      {children}
    </button>
  )
}

function StepRow({ step }: { step: BackgroundTaskStep }) {
  const Icon = stepIcon(step.tool)
  return (
    <li className="flex min-w-0 items-center gap-2 text-label-sm">
      <Icon className="size-3.5 shrink-0 text-tertiary" aria-hidden />
      <span className="shrink-0 text-secondary">{stepToolName(step.tool)}</span>
      {step.label && <span className="min-w-0 truncate text-tertiary" title={step.label}>{step.label}</span>}
    </li>
  )
}

/** A command's output, scrolled to its end (and kept there as it grows). */
function OutputTail({ text, truncated }: { text: string; truncated: boolean }) {
  const { t } = useTranslation()
  const ref = React.useRef<HTMLPreElement>(null)
  // Follow the end only while the reader is there: scrolling up to read earlier output must stick
  const atEndRef = React.useRef(true)
  React.useLayoutEffect(() => {
    const el = ref.current
    if (el && atEndRef.current) el.scrollTop = el.scrollHeight
  }, [text])
  return (
    <div className="flex flex-col gap-1">
      {truncated && <span className="text-label-sm text-tertiary">{t('chat.backgroundTask.truncated')}</span>}
      <pre
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget
          atEndRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8
        }}
        className="max-h-56 overflow-auto rounded-md bg-fill-hover px-2.5 py-2 font-mono text-mono-ui whitespace-pre-wrap break-words text-secondary"
      >
        {text}
      </pre>
    </div>
  )
}

/**
 * The agent's message as markdown (upstream's `MemoizedMarkdown mode="minimal"`), loaded on first use: the markdown
 * module's graph reaches the ui barrel's pdfjs, which this chip's graph must not (P6.844). Plain text until it loads.
 */
const LazyMarkdown = React.lazy(() => import('@nessy-agent/ui/markdown').then(module => ({ default: module.MemoizedMarkdown })))

function AgentMessage({ text }: { text: string }) {
  return (
    <React.Suspense fallback={<span className="whitespace-pre-wrap break-words">{text}</span>}>
      <LazyMarkdown mode="minimal">{text}</LazyMarkdown>
    </React.Suspense>
  )
}

export interface BackgroundTaskCardProps {
  task: BackgroundTask
  sessionId: string
  onStop: (task: BackgroundTask) => void
  onDismiss: (task: BackgroundTask) => void
  /** Show a task's full output (ChatDisplay opens it in an overlay, UB12.79). Open is hidden without one. */
  onOpenOutput?: (task: BackgroundTask, output: OpenedTaskOutput) => void
  onClose: () => void
}

/** Exported for the playground and the tests; the product reaches it through {@link BackgroundTaskChip}. */
export function BackgroundTaskCard({ task, sessionId, onStop, onDismiss, onOpenOutput, onClose }: BackgroundTaskCardProps) {
  const { t } = useTranslation()
  const elapsed = useElapsed(task)
  const statusText = useStatusText(task)
  const readable = canViewTaskOutput(task)
  const { output, status, reload } = useTaskOutput(sessionId, task, readable)
  const live = isLive(task)
  const TypeIcon = TYPE_ICON[task.type]
  const title = task.intent?.trim() || task.id
  const copyText = outputText(output)
  const activity = task.activity
  const [opening, setOpening] = React.useState(false)

  const handleCopy = async () => {
    if (!copyText) return
    await navigator.clipboard?.writeText(copyText)
    toast.success(t('toast.taskOutputCopied'))
  }

  // L9 — Open reads the WHOLE output afresh (the card holds a tail) into the overlay ChatDisplay owns; a refusal is a
  // translated toast with the backend's detail in the log, and the overlay never opens on it. UB12.79: an agent's
  // digest goes up as itself (upstream's document overlay), anything else as our terminal data.
  const handleOpen = async () => {
    if (!onOpenOutput) return
    setOpening(true)
    const outcome = await requestTaskOutput(task, {
      readOutput: (taskId, cursor) => window.electronAPI.readBackgroundTaskOutput(sessionId, taskId, cursor),
    })
    setOpening(false)
    if (!outcome.show) {
      if (outcome.failureDetail) console.error(`[BackgroundTaskChip] output read for ${task.id} refused:`, outcome.failureDetail)
      toast.error(t(outcome.failureKey))
      return
    }
    onOpenOutput(task, outcome.agent ?? { kind: 'text', ...outcome.data })
    onClose()
  }

  let body: React.ReactNode
  if (status === 'loading' && !output) {
    body = (
      <div className="flex flex-col gap-2" aria-busy>
        <div className="skeleton h-3.5 w-3/4" />
        <div className="skeleton h-3.5 w-1/2" />
        <div className="skeleton h-3.5 w-2/3" />
      </div>
    )
  } else if (status === 'error') {
    body = (
      <div className="flex items-center justify-between gap-2 text-label-sm text-secondary">
        <span>{t('chat.backgroundTask.loadFailed')}</span>
        <CardButton icon={Wrench} onClick={reload}>{t('common.retry')}</CardButton>
      </div>
    )
  } else if (output?.kind === 'text' && output.text.trim()) {
    body = <OutputTail text={output.text} truncated={output.truncated} />
  } else if (output?.kind === 'agent' && (output.message || output.steps.length > 0)) {
    body = (
      <div className="flex flex-col gap-3">
        {output.steps.length > 0 && live && (
          <section className="flex flex-col gap-1.5">
            <h4 className="text-label-sm font-medium text-tertiary">{t('chat.backgroundTask.recentSteps')}</h4>
            <ul className="flex flex-col gap-1">
              {output.steps.slice(-CARD_STEPS).map((step, index) => <StepRow key={`${index}-${step.tool}`} step={step} />)}
            </ul>
          </section>
        )}
        {output.message && (
          <section className="flex flex-col gap-1.5">
            <h4 className="text-label-sm font-medium text-tertiary">
              {live ? t('chat.backgroundTask.latestMessage') : t('chat.backgroundTask.result')}
            </h4>
            <div className={cn('min-w-0 text-label text-foreground', live && 'line-clamp-6')}>
              <AgentMessage text={live && output.message.length > LIVE_MESSAGE_CHARS ? `${output.message.slice(0, LIVE_MESSAGE_CHARS)}…` : output.message} />
            </div>
          </section>
        )}
      </div>
    )
  } else {
    // Ours: "waiting" only where output can come — a row with no host read says it has none.
    body = (
      <p className="text-label-sm text-tertiary">
        {task.summary || (live && readable ? t('chat.backgroundTask.waiting') : t('chat.backgroundTask.noOutput'))}
      </p>
    )
  }

  return (
    <div className="flex max-h-[min(520px,70vh)] flex-col" data-testid="background-task-card">
      <header className="flex gap-2.5 px-3.5 pt-3 pb-2.5">
        <TypeIcon className="mt-0.5 size-4 shrink-0 text-tertiary" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-label font-medium text-foreground" title={title}>{title}</p>
          <p className="mt-0.5 text-label-sm text-tertiary tabular-nums">
            {t(TYPE_LABEL_KEY[task.type])} · {statusText} · {formatElapsed(elapsed)}
          </p>
          {/* The agent's own one-line status and its step count (task_activity) */}
          {live && (activity?.summary || activity?.toolUses) ? (
            <p className="mt-1.5 flex min-w-0 items-baseline gap-1.5 text-label-sm text-secondary">
              {activity?.summary && <span className="min-w-0 truncate animate-shimmer-text" title={activity.summary}>{activity.summary}</span>}
              {activity?.toolUses ? (
                <span className="shrink-0 text-tertiary tabular-nums">{t('chat.backgroundTask.steps', { count: activity.toolUses })}</span>
              ) : null}
            </p>
          ) : null}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto border-t border-separator px-3.5 py-3">{body}</div>

      <footer className="flex items-center gap-0.5 border-t border-separator p-1.5">
        {readable && onOpenOutput ? (
          <CardButton icon={Maximize2} disabled={!output || !copyText || opening} onClick={() => void handleOpen()}>
            {t('common.open')}
          </CardButton>
        ) : null}
        <CardButton icon={Copy} disabled={!copyText} onClick={() => void handleCopy()}>{t('common.copy')}</CardButton>
        <div className="flex-1" />
        <CardButton icon={X} onClick={() => onDismiss(task)}>{t('common.dismiss')}</CardButton>
        {canStopTask(task) ? (
          <CardButton icon={Square} tone="destructive" disabled={task.stopping} onClick={() => onStop(task)}>
            {task.stopping ? t('chat.backgroundTask.stopping') : t('chat.backgroundTask.stop')}
          </CardButton>
        ) : null}
      </footer>
    </div>
  )
}

export interface BackgroundTaskChipProps {
  task: BackgroundTask
  sessionId: string
  /** The card is open (ActiveTasksBar keeps one open at a time, and keeps its chip while it is) */
  open: boolean
  onOpenChange: (open: boolean) => void
  onStop: (task: BackgroundTask) => void
  onDismiss: (task: BackgroundTask) => void
  /** Show the task's full output (ChatDisplay opens it in an overlay) */
  onOpenOutput?: (task: BackgroundTask, output: OpenedTaskOutput) => void
}

export function BackgroundTaskChip({ task, sessionId, open, onOpenChange, onStop, onDismiss, onOpenOutput }: BackgroundTaskChipProps) {
  const { t } = useTranslation()
  const elapsed = useElapsed(task)
  const statusText = useStatusText(task)
  const label = task.intent?.trim() || task.id
  const running = task.status === 'running' && !task.stopping
  const tone = task.status === 'failed'
    ? 'bg-destructive-tint text-destructive ring-[color:var(--destructive-border)]'
    : task.status === 'stale'
      ? 'bg-info-tint text-info ring-[color:var(--info-border)]'
      : undefined
  const hint = task.status === 'stale' ? t('chat.taskStaleHint') : undefined

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-task-status={task.status}
          aria-label={`${t('chat.backgroundTask.chipLabel', { type: t(TYPE_LABEL_KEY[task.type]), intent: label })} · ${statusText} · ${formatElapsed(elapsed)}`}
          title={hint ?? label}
          className={cn(COMPOSER_META_CHIP, 'max-w-full cursor-pointer pl-2', running && 'animate-shimmer', tone)}
        >
          <StatusGlyph task={task} />
          <span className="min-w-0 max-w-[240px] truncate">{label}</span>
          <span className={cn('shrink-0 tabular-nums', tone ? 'font-medium' : 'text-tertiary')}>
            {running ? formatElapsed(elapsed) : statusText}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-[360px] max-w-[calc(100vw-24px)] p-0"
        // Focus the card itself: while it loads, Open and Copy are disabled, and focus must never
        // land on Stop (holding Enter that opened the card would stop the task)
        tabIndex={-1}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          ;(event.currentTarget as HTMLElement | null)?.focus()
        }}
      >
        <BackgroundTaskCard
          task={task}
          sessionId={sessionId}
          onStop={onStop}
          onDismiss={onDismiss}
          onOpenOutput={onOpenOutput}
          onClose={() => onOpenChange(false)}
        />
      </PopoverContent>
    </Popover>
  )
}
