import * as React from 'react'
import { Bot, GitFork, MessageSquare, MessagesSquare, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { PiHarnessChildSummaryV1 } from '@nessy-agent/core/types'
import { getModelShortName } from '@config/models'
import { stripPiPrefixForDisplay } from '@/components/app-shell/input/model-picker-helpers'
import { SystemCard, SystemCardError } from '@/components/ui/system-card'
import { cn } from '@/lib/utils'

/**
 * The observe-and-steer panel (`sub-agents.md:1021`–`:1032`).
 *
 * > Running forks appear in a panel below the prompt input, with one row for
 * > the main session and one for each fork.
 *
 * The page gives TERMINAL key bindings. This is a desktop app, so the
 * CAPABILITIES are mapped rather than the keystrokes:
 *
 * | Documented key | Mapped to |
 * | :-- | :-- |
 * | `↑` / `↓` move between rows | arrow keys inside the panel's listbox, and a click on any row |
 * | `Enter` open the transcript and send follow-ups | `Enter` on the focused row, or its transcript button — both expand the row's output with a follow-up field |
 * | `x` dismiss a finished fork or stop a running one | `x`, `Delete` or `Backspace` on the focused row, and the row's ✕ button |
 * | `Esc` return focus to the prompt input | `Escape` inside the panel, which calls `onReturnFocus` |
 *
 * `Enter` and `x` keep their documented letters where a desktop app has no
 * competing meaning for them; the arrow keys move a roving `tabindex` rather
 * than a terminal cursor. Every keyboard action has a pointer equivalent,
 * because a desktop user should not have to discover a terminal binding.
 *
 * Rows are children of THIS session. `:1023` says "one for each fork", and a
 * fork is `agent === 'fork'` (a reserved name no authored agent can claim), but
 * a named background subagent is shown too: `:770` puts its prompts and its
 * progress in the main session as well, and hiding it would leave the running
 * work that most often blocks the user invisible.
 */

export interface AgentPanelRow {
  agentId: string
  agent: string
  task?: string
  status: PiHarnessChildSummaryV1['status']
  fork: boolean
  /**
   * The effort this child is RUNNING at and the model it runs on, both carried
   * raw off the wire (`PiHarnessChildSummaryV1.effort`/`.model`). Optional
   * because a summary from a host that predates them has neither, and such a
   * row must render exactly as it did before.
   */
  effort?: PiHarnessChildSummaryV1['effort']
  model?: string
}

/**
 * The model as the rest of this app writes it in a tight space — the same pair
 * `CompactModelSelector` uses for its own collapsed label. The RAW id stays on
 * the row's `title`, so shortening never costs the user the exact value.
 *
 * `getModelShortName` and NOT `getModelDisplayName`, deliberately: the display
 * name resolves a deprecated id through `DEPRECATED_MODEL_REPLACEMENTS` first,
 * so `claude-opus-4-6` renders as "Opus 4.8" — a version the child is not
 * running. On a row whose entire job is saying what ran, an omitted version
 * ("Opus") is acceptable and a wrong one is not. The short name also survives
 * a gateway id intact (`pi/tgpt/qwen35-…` → `qwen35-…`) where the display name
 * mangles it.
 */
export function agentRowModelLabel(modelId: string): string {
  return stripPiPrefixForDisplay(getModelShortName(modelId))
}

export interface AgentPanelProps {
  /** Name of the main session's row; the panel always shows it first. */
  mainSessionLabel: string
  rows: readonly AgentPanelRow[]
  /** Output already read for a row, keyed by agentId. */
  transcripts?: Readonly<Record<string, string>>
  /**
   * The last refusal for a row, keyed by agentId. A control that fails
   * (`child-session-not-active`, `child-session-not-running`,
   * `pi-child-service-unavailable`) has to say so on the row the user acted on;
   * before this, every one of them rendered as a cleared input box.
   */
  errors?: Readonly<Record<string, string>>
  onOpenTranscript: (agentId: string) => void
  /**
   * Returns false when the control refused. Kept optional in the return type so
   * a caller with nothing to report (the playground, a static render) stays a
   * plain void callback.
   */
  onFollowUp: (agentId: string, message: string) => void | Promise<boolean>
  /** Stop a running row, or dismiss a finished one. The panel does not decide which. */
  onDismiss: (agentId: string, running: boolean) => void
  onReturnFocus?: () => void
  open: boolean
}

const RUNNING_STATUSES: ReadonlySet<AgentPanelRow['status']> = new Set(['starting', 'running'])

export function isAgentRowRunning(status: AgentPanelRow['status']): boolean {
  return RUNNING_STATUSES.has(status)
}

export function toAgentPanelRows(children: readonly PiHarnessChildSummaryV1[]): AgentPanelRow[] {
  return children.map(child => ({
    agentId: child.agentId,
    agent: child.agent,
    ...(child.task ? { task: child.task } : {}),
    status: child.status,
    // `fork` is a reserved agent name — `BUILTIN_AGENT_NAME_SET` refuses it to
    // every user, workspace, project and plugin definition — so the name is a
    // safe discriminator here and needs no second field on the wire.
    fork: child.agent === 'fork',
    ...(child.effort ? { effort: child.effort } : {}),
    ...(child.model ? { model: child.model } : {}),
  }))
}

export const MAIN_ROW_ID = '__main__'

/**
 * The documented key bindings, as capabilities. Pure so the mapping can be
 * asserted without a DOM: this repo's renderer tests render statically.
 */
export type AgentPanelKeyAction = 'next' | 'previous' | 'open' | 'dismiss' | 'return-focus' | null

export function agentPanelKeyAction(key: string): AgentPanelKeyAction {
  if (key === 'ArrowDown') return 'next'
  if (key === 'ArrowUp') return 'previous'
  if (key === 'Enter') return 'open'
  if (key === 'x' || key === 'Delete' || key === 'Backspace') return 'dismiss'
  if (key === 'Escape') return 'return-focus'
  return null
}

/**
 * Whether a submitted follow-up clears the input box.
 *
 * Clearing is the RECEIPT for a delivered message, so a refusal must NOT clear
 * it: the old code cleared unconditionally, which made a refused follow-up and a
 * delivered one look identical and cost the user their text. A caller that
 * reports nothing (`void`) counts as delivered, so the success path is unchanged
 * for every caller that has nothing to report.
 */
export function followUpClearsInput(accepted: boolean | void): boolean {
  return accepted !== false
}

/** Row movement is clamped, not wrapped: `↑` on the main row stays put. */
export function nextFocusedRowId(ids: readonly string[], current: string, delta: number): string {
  if (ids.length === 0) return current
  const index = ids.indexOf(current)
  if (index === -1) return ids[0]!
  return ids[Math.min(ids.length - 1, Math.max(0, index + delta))]!
}

export function AgentPanel({
  mainSessionLabel,
  rows,
  transcripts,
  errors,
  onOpenTranscript,
  onFollowUp,
  onDismiss,
  onReturnFocus,
  open,
}: AgentPanelProps) {
  const { t } = useTranslation()
  const [focusedId, setFocusedId] = React.useState<string>(MAIN_ROW_ID)
  const [expandedId, setExpandedId] = React.useState<string | null>(null)
  const [followUp, setFollowUp] = React.useState('')

  const ids = React.useMemo(() => [MAIN_ROW_ID, ...rows.map(row => row.agentId)], [rows])

  React.useEffect(() => {
    if (!ids.includes(focusedId)) setFocusedId(MAIN_ROW_ID)
    if (expandedId && !ids.includes(expandedId)) setExpandedId(null)
  }, [ids, focusedId, expandedId])

  if (!open || rows.length === 0) return null

  const move = (delta: number) => setFocusedId(current => nextFocusedRowId(ids, current, delta))

  const toggleTranscript = (agentId: string) => {
    setExpandedId(current => {
      if (current === agentId) return null
      onOpenTranscript(agentId)
      return agentId
    })
    setFollowUp('')
  }

  const handleRowKeyDown = (event: React.KeyboardEvent, row?: AgentPanelRow) => {
    const action = agentPanelKeyAction(event.key)
    if (!action) return
    if (action === 'next') { event.preventDefault(); move(1); return }
    if (action === 'previous') { event.preventDefault(); move(-1); return }
    if (action === 'return-focus') { event.preventDefault(); onReturnFocus?.(); return }
    if (!row) return
    event.preventDefault()
    if (action === 'open') toggleTranscript(row.agentId)
    else onDismiss(row.agentId, isAgentRowRunning(row.status))
  }

  const submitFollowUp = async (agentId: string) => {
    const message = followUp.trim()
    if (!message) return
    const accepted = await onFollowUp(agentId, message)
    if (followUpClearsInput(accepted)) setFollowUp('')
  }

  return (
    <SystemCard
      data-testid="agent-panel"
      role="region"
      aria-label={t('agentPanel.title')}
      icon={<MessagesSquare className="size-3.5 shrink-0" aria-hidden />}
      title={t('agentPanel.title')}
      meta={<span className="tabular-nums">{t('agentPanel.count', { count: rows.length })}</span>}
    >
      <ul role="listbox" aria-label={t('agentPanel.title')} className="flex flex-col gap-0.5">
        <li
          role="option"
          aria-selected={focusedId === MAIN_ROW_ID}
          tabIndex={focusedId === MAIN_ROW_ID ? 0 : -1}
          data-testid="agent-panel-row-main"
          onKeyDown={event => handleRowKeyDown(event)}
          onClick={() => setFocusedId(MAIN_ROW_ID)}
          className={cn(
            'flex items-center gap-1.5 rounded px-1.5 py-1 outline-none',
            focusedId === MAIN_ROW_ID && 'bg-foreground/5 ring-1 ring-info/40',
          )}
        >
          <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 truncate font-medium">{mainSessionLabel}</span>
          <span className="ml-auto shrink-0 text-muted-foreground">{t('agentPanel.mainSession')}</span>
        </li>

        {rows.map(row => {
          const running = isAgentRowRunning(row.status)
          const focused = focusedId === row.agentId
          const expanded = expandedId === row.agentId
          /*
           * The run-parameters cluster (`statusline.md` § `subagentStatusLine`,
           * whose per-subagent row body carries `model` and `effort`). This row
           * already ended in a muted, untranslated `status` token, so the two
           * new facts join it in that same slot and that same register instead
           * of arriving as a badge of their own — the row is compact and a
           * badge would double its height. The `·` is the row's own separator,
           * already used on the left as `agent · task`, and it is what stops
           * "xhigh" reading as a second status word.
           *
           * `null` when the summary carries neither field, which is what keeps
           * the trailing span byte-identical to what it rendered before these
           * fields existed — a host that predates them must change nothing.
           */
          const meta = row.effort || row.model
            ? (
              <>
                {row.effort ? (
                  <>
                    <span data-testid={`agent-panel-effort-${row.agentId}`} title={t('agentPanel.effortTitle', { level: row.effort })}>{row.effort}</span>
                    <span aria-hidden>·</span>
                  </>
                ) : null}
                {row.model ? (
                  <>
                    <span className="max-w-28 truncate" data-testid={`agent-panel-model-${row.agentId}`} title={t('agentPanel.modelTitle', { model: row.model })}>{agentRowModelLabel(row.model)}</span>
                    <span aria-hidden>·</span>
                  </>
                ) : null}
              </>
            )
            : null
          return (
            <li
              key={row.agentId}
              role="option"
              aria-selected={focused}
              aria-expanded={expanded}
              tabIndex={focused ? 0 : -1}
              data-testid={`agent-panel-row-${row.agentId}`}
              data-fork={row.fork ? 'true' : 'false'}
              data-status={row.status}
              onKeyDown={event => handleRowKeyDown(event, row)}
              onClick={() => setFocusedId(row.agentId)}
              className={cn(
                'rounded px-1.5 py-1 outline-none',
                focused && 'bg-foreground/5 ring-1 ring-info/40',
              )}
            >
              <div className="flex items-center gap-1.5">
                {row.fork
                  ? <GitFork className="size-3.5 shrink-0 text-info" aria-hidden />
                  : <Bot className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
                <span className="min-w-0 truncate">
                  <span className="font-medium">{row.fork ? t('agentPanel.fork') : row.agent}</span>
                  {row.task ? <span className="text-muted-foreground"> · {row.task}</span> : null}
                </span>
                <span className={cn('ml-auto shrink-0 text-muted-foreground', meta && 'flex items-center gap-1')}>
                  {meta}
                  {row.status}
                </span>
                <button
                  type="button"
                  className="shrink-0 rounded px-1 hover:bg-foreground/10"
                  aria-label={t('agentPanel.openTranscript')}
                  data-testid={`agent-panel-open-${row.agentId}`}
                  onClick={event => { event.stopPropagation(); setFocusedId(row.agentId); toggleTranscript(row.agentId) }}
                >
                  <MessageSquare className="size-3.5" aria-hidden />
                </button>
                <button
                  type="button"
                  className="shrink-0 rounded px-1 text-destructive hover:bg-destructive/10"
                  aria-label={running ? t('agentPanel.stop') : t('agentPanel.dismiss')}
                  data-testid={`agent-panel-dismiss-${row.agentId}`}
                  onClick={event => { event.stopPropagation(); onDismiss(row.agentId, running) }}
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              </div>

              {errors?.[row.agentId] && (
                <SystemCardError data-testid={`agent-panel-error-${row.agentId}`}>
                  {t('agentPanel.actionFailed', { reason: errors[row.agentId] })}
                </SystemCardError>
              )}

              {expanded && (
                <div className="mt-1 space-y-1" data-testid={`agent-panel-transcript-${row.agentId}`}>
                  <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded bg-foreground/5 p-2 font-mono text-[11px]">
                    {transcripts?.[row.agentId] ?? t('agentPanel.transcriptEmpty')}
                  </pre>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="text"
                      value={followUp}
                      aria-label={t('agentPanel.followUp')}
                      placeholder={t('agentPanel.followUp')}
                      data-testid={`agent-panel-followup-${row.agentId}`}
                      className="min-w-0 flex-1 rounded border border-border/60 bg-background px-2 py-1"
                      onChange={event => setFollowUp(event.target.value)}
                      onKeyDown={event => {
                        event.stopPropagation()
                        if (event.key === 'Enter') { event.preventDefault(); void submitFollowUp(row.agentId) }
                        if (event.key === 'Escape') { event.preventDefault(); onReturnFocus?.() }
                      }}
                    />
                    <button
                      type="button"
                      className="shrink-0 rounded border border-border/60 px-2 py-1 hover:bg-foreground/5"
                      data-testid={`agent-panel-send-${row.agentId}`}
                      onClick={() => void submitFollowUp(row.agentId)}
                    >
                      {t('agentPanel.send')}
                    </button>
                  </div>
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </SystemCard>
  )
}

/**
 * F1.806 (origin SIT-p, 2026-09-25) — whether a child is a row of the panel at all. The Pi "Running agents" panel kept
 * a background worker after it had completed and been reported. Claude Code's own panel, the surface this one follows
 * (sub-agents.md#run-subagents-in-foreground-or-background): "When a subagent finishes successfully, Claude Code
 * removes its row immediately"; "When a subagent fails or you stop it, Claude Code keeps its row for 30 seconds. To
 * clear the row sooner, select it and press `x`." So a `completed` child is not listed, and a failed, stopped or
 * interrupted one stays, with its dismiss. Residue, stated: Claude also clears that row by itself after 30 s; here it
 * stays until it is dismissed (the panel re-reads on a `children` invalidation and keeps no timer).
 */
export function isAgentChildListed(child: Pick<PiHarnessChildSummaryV1, 'status'>): boolean {
  return child.status !== 'completed'
}
