import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { motion } from 'motion/react'
import {
  ArrowUpRight,
  Ban,
  BookmarkPlus,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  CircleDashed,
  FolderPlus,
  RotateCcw,
  XCircle,
} from 'lucide-react'
import type { OrchestrationAgentStatus, OrchestrationProgressAgent } from '@nessy-agent/core'
import type { WorkflowSaveScope } from '../../../shared/types'
import type { ActivityItem } from '@nessy-agent/ui/chat/TurnCard'
import { formatTokens } from '@nessy-agent/ui/chat/turn-utils'
import { SPRING } from '@nessy-agent/ui/motion'
import { Button, IconButton } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useAgentElapsed } from './agent-elapsed'
import { orchestrationActivityLabel, orchestrationActivityTitle } from './orchestration-activity'
import { CardWell, CHIP_DESTRUCTIVE, CHIP_NEUTRAL, ROW_ICON_SIZE, ROW_ICON_SLOT, RowSpinner, WORK_LOG_BODY, WORK_LOG_ROW, WORK_LOG_ROW_INTERACTIVE, WORK_LOG_ROW_WRAPPER } from './transcript-card-chrome'

/*
 * UB14.18 — drawn on the work log's language: the run is a group row (chevron · status · the title
 * chip · the summary, with the run's facts on a tertiary second line and its actions beside it as
 * ghost buttons), each phase a row of its own under the inset hairline with its agents as a quiet
 * table, the logs and the result as sunken wells, and a failure as v0.15.1's destructive marker
 * (`SystemMessage type="error"`). Every value, action and condition is unchanged.
 *
 * The imports and this note are sized so that the line anchors the capability ledger cites in this
 * file (H12: `:171-174`, a baselined entry, and `:193`, the P6.305 activity reader) keep landing on
 * the lines they name — a restyle has no business moving someone else's evidence.
 */

type WorkflowPanelProps = {
  activity: ActivityItem
  onOpenDetails?: () => void
  onInsertResumePrompt?: (prompt: string) => void
  /**
   * P6.318 — keep this run. Present ONLY when the session's runtime can
   * dispatch a recipe: the caller answers that with `runtimeDispatchesWorkflows`,
   * the same predicate the resolver, `BaseAgent.canDispatchWorkflowCommands` and
   * `SessionManager.saveSessionWorkflowRecipe` read, so the offer and the
   * refusal cannot disagree. Absent means no keep buttons render at all — the
   * row's own requirement that the two runtimes which cannot execute a recipe
   * say so rather than being offered the save.
   */
  onKeepRun?: (scope: WorkflowSaveScope, source: string) => void
  defaultExpanded?: boolean
}

type PhaseGroup = {
  title: string
  detail?: string
  agents: OrchestrationProgressAgent[]
}

const completedStatuses = new Set<OrchestrationAgentStatus>(['done', 'error', 'aborted'])

/**
 * P6.318 — the recipe text this run executed, or `undefined` when there is none
 * to keep.
 *
 * The workflow tool accepts `script`, `name` or `scriptPath`
 * (`orchestrator/workflow-tool.ts`), and only the INLINE `script` is a recipe
 * the user does not already have: a `name` run is a recipe that is already
 * saved, and a `scriptPath` run is a file that already exists on disk. Keeping
 * either would write a second copy of something the user can already dispatch,
 * so the affordance is offered for the inline case alone.
 */
export function workflowRecipeSource(activity: ActivityItem): string | undefined {
  const script = activity.toolInput?.['script']
  return typeof script === 'string' && script.trim() ? script : undefined
}
const agentGridColumns = 'grid-cols-[minmax(0,1fr)_72px_52px_64px]'

/** The work log's status vocabulary, as `SubagentCard` draws it (one token, one glyph). */
function StatusIcon({ status }: { status: OrchestrationAgentStatus }) {
  switch (status) {
    case 'queued':
      return <CircleDashed aria-hidden className={cn(ROW_ICON_SIZE, 'shrink-0 text-tertiary')} />
    case 'running':
      return <RowSpinner />
    case 'done':
      return <CheckCircle2 aria-hidden className={cn(ROW_ICON_SIZE, 'shrink-0 text-success')} />
    case 'error':
      return <XCircle aria-hidden className={cn(ROW_ICON_SIZE, 'shrink-0 text-destructive')} />
    case 'aborted':
      return <Ban aria-hidden className={cn(ROW_ICON_SIZE, 'shrink-0 text-tertiary')} />
  }
}

function summarizeStatus(agents: OrchestrationProgressAgent[], fallback: ActivityItem['status']): OrchestrationAgentStatus {
  if (fallback === 'error' || agents.some(agent => agent.status === 'error')) return 'error'
  if (agents.some(agent => agent.status === 'aborted')) return 'aborted'
  if (agents.some(agent => agent.status === 'running')) return 'running'
  if (agents.some(agent => agent.status === 'queued')) return 'queued'
  if (fallback === 'completed') return 'done'
  return agents.length > 0 ? 'running' : 'queued'
}

function summarizePhaseStatus(agents: OrchestrationProgressAgent[]): OrchestrationAgentStatus {
  if (agents.length === 0) return 'queued'
  if (agents.some(agent => agent.status === 'error')) return 'error'
  if (agents.some(agent => agent.status === 'aborted')) return 'aborted'
  if (agents.some(agent => agent.status === 'running')) return 'running'
  if (agents.some(agent => agent.status === 'queued')) return 'queued'
  return 'done'
}

function numberFromInput(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringFromInput(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function extractWorkflowLogs(content: string | undefined): string[] {
  if (!content) return []
  const marker = '\n\nLogs:\n'
  const start = content.indexOf(marker)
  if (start === -1) return []
  const rest = content.slice(start + marker.length)
  const nextSection = rest.search(/\n\n(?:Failures:|\d+\.\s)/)
  const block = nextSection === -1 ? rest : rest.slice(0, nextSection)
  return block
    .split('\n')
    .map(line => line.replace(/^\s*-\s?/, '').trim())
    .filter(Boolean)
}

function extractWorkflowError(content: string | undefined, status: OrchestrationAgentStatus): string | undefined {
  if (!content || status !== 'error') return undefined
  const lines = content.trim().split('\n')
  if (/^workflow\s+error/i.test(lines[0] ?? '')) {
    lines.shift()
  }

  const errorLines: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed && errorLines.length === 0) continue
    if (trimmed === 'Logs:' || trimmed === 'Failures:' || /^\d+\.\s/.test(trimmed)) break
    errorLines.push(line)
  }

  return errorLines.join('\n').trim() || undefined
}

function agentTimestamp(agent: OrchestrationProgressAgent, key: 'startedAt' | 'endedAt'): number | undefined {
  const value = agent[key]
  if (!value) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function earliestStartedAt(agents: OrchestrationProgressAgent[]): string | undefined {
  let earliest: { value: string; time: number } | undefined
  for (const agent of agents) {
    const time = agentTimestamp(agent, 'startedAt')
    if (time === undefined) continue
    if (!earliest || time < earliest.time) earliest = { value: agent.startedAt!, time }
  }
  return earliest?.value
}

function latestEndedAt(agents: OrchestrationProgressAgent[]): string | undefined {
  if (agents.length === 0 || agents.some(agent => !completedStatuses.has(agent.status) || !agent.endedAt)) return undefined
  let latest: { value: string; time: number } | undefined
  for (const agent of agents) {
    const time = agentTimestamp(agent, 'endedAt')
    if (time === undefined) return undefined
    if (!latest || time > latest.time) latest = { value: agent.endedAt!, time }
  }
  return latest?.value
}

function AgentRow({ agent }: { agent: OrchestrationProgressAgent }) {
  const { t } = useTranslation()
  // P6.641 — a runtime may report a total with no split (claude's
  // `SDKTaskProgressMessage.usage` has none). The pair is preferred where it
  // exists; the second line below is omitted rather than filled with zeros.
  const hasSplit = typeof agent.tokensIn === 'number' && typeof agent.tokensOut === 'number'
  const totalTokens = hasSplit
    ? (agent.tokensIn ?? 0) + (agent.tokensOut ?? 0)
    : (agent.tokensTotal ?? 0)
  const elapsed = useAgentElapsed(agent.startedAt, agent.endedAt)
  const activity = orchestrationActivityLabel(agent.lastActivity, t)
  const activityTitle = orchestrationActivityTitle(agent.lastActivity, t)

  return (
    <div className={cn('grid min-h-7 items-center gap-2 py-1 text-label text-secondary', agentGridColumns)} data-workflow-agent="">
      <div className="flex min-w-0 items-start gap-2">
        <span className={cn(ROW_ICON_SLOT, 'h-5')}>
          <StatusIcon status={agent.status} />
        </span>
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate">{agent.label}</span>
            <span className={CHIP_NEUTRAL}>{agent.agentType}</span>
          </div>
          <div className="flex min-w-0 items-center gap-1.5 text-label-sm text-tertiary">
            <span>{t(`turnCard.workflow.status.${agent.status}`)}</span>
            {/*
              * P6.305. This slot used to print `agent.lastActivity` RAW, so a
              * user watching a workflow read `tool_execution_start`. The token
              * now goes through the one shared reader both orchestration cards
              * use, and the raw value stays on `title`.
              */}
            {activity && (
              <>
                <span aria-hidden>·</span>
                <span className="truncate" title={activityTitle}>{activity}</span>
              </>
            )}
          </div>
        </div>
      </div>
      <div className="text-right text-label-sm tabular-nums text-tertiary">
        <div>{formatTokens(totalTokens)}</div>
        {hasSplit && (
          <div className="text-caption">
            {t('turnCard.workflow.tokens', {
              input: formatTokens(agent.tokensIn ?? 0),
              output: formatTokens(agent.tokensOut ?? 0),
            })}
          </div>
        )}
      </div>
      <span className="text-right text-label-sm tabular-nums text-tertiary">
        {agent.toolCalls ?? 0}
      </span>
      <span className="text-right text-label-sm tabular-nums text-tertiary">
        {elapsed ?? '-'}
      </span>
    </div>
  )
}

function PhaseSection({ phase }: { phase: PhaseGroup }) {
  const { t } = useTranslation()
  const [isExpanded, setIsExpanded] = useState(true)
  const status = summarizePhaseStatus(phase.agents)

  return (
    <section className="flex min-w-0 flex-col" data-workflow-phase="">
      <div className={WORK_LOG_ROW_WRAPPER}>
        <button
          type="button"
          onClick={() => setIsExpanded(value => !value)}
          aria-expanded={isExpanded}
          aria-label={t('turnCard.workflow.phase.toggle', { phase: phase.title })}
          className={cn(WORK_LOG_ROW, WORK_LOG_ROW_INTERACTIVE)}
        >
          <motion.span
            initial={false}
            animate={{ rotate: isExpanded ? 90 : 0 }}
            transition={SPRING.snap}
            className={cn(ROW_ICON_SLOT, 'text-tertiary')}
          >
            <ChevronRight aria-hidden className={ROW_ICON_SIZE} />
          </motion.span>
          <span className={ROW_ICON_SLOT}>
            <StatusIcon status={status} />
          </span>
          <span className="min-w-0 flex-1 truncate">
            {phase.title}
            {phase.detail && (
              <span className="ml-1.5 text-tertiary">
                {phase.detail}
              </span>
            )}
          </span>
          <span className="shrink-0 pl-1 text-label-sm tabular-nums text-tertiary">
            {t('turnCard.workflow.phase.agentCount', { count: phase.agents.length })}
          </span>
        </button>
      </div>

      {isExpanded && (
        <div className={cn(WORK_LOG_BODY, 'mb-0.5')}>
          {phase.agents.length > 0
            ? (
              <>
                <div className={cn('grid min-h-6 items-center gap-2 text-label-sm font-medium text-tertiary', agentGridColumns)}>
                  <span className="pl-6">{t('turnCard.workflow.column.agent')}</span>
                  <span className="text-right">{t('turnCard.workflow.column.tokens')}</span>
                  <span className="text-right">{t('turnCard.workflow.column.tools')}</span>
                  <span className="text-right">{t('turnCard.workflow.column.time')}</span>
                </div>
                {phase.agents.map(agent => (
                  <AgentRow key={agent.id} agent={agent} />
                ))}
              </>
            )
            : (
              <div className="flex min-h-7 items-center text-label text-tertiary">
                {t('turnCard.workflow.phase.pending')}
              </div>
            )}
        </div>
      )}
    </section>
  )
}

export function WorkflowPanel({
  activity,
  onOpenDetails,
  onInsertResumePrompt,
  onKeepRun,
  defaultExpanded = false,
}: WorkflowPanelProps) {
  const { t } = useTranslation()
  const [isExpanded, setIsExpanded] = useState(defaultExpanded)
  const progress = activity.orchestrationProgress

  const summary = useMemo(() => {
    const agents = progress?.agents ?? []
    const phaseLabel = (agent: OrchestrationProgressAgent) => agent.phase || t('turnCard.workflow.phase.default')
    const grouped = new Map<string, PhaseGroup>()
    for (const phase of progress?.phases ?? []) {
      if (!phase.title.trim() || grouped.has(phase.title)) continue
      grouped.set(phase.title, {
        title: phase.title,
        ...(phase.detail === undefined ? {} : { detail: phase.detail }),
        agents: [],
      })
    }
    for (const agent of agents) {
      const phase = phaseLabel(agent)
      const group = grouped.get(phase)
      if (group) {
        group.agents.push(agent)
      } else {
        grouped.set(phase, { title: phase, agents: [agent] })
      }
    }

    const tokensIn = agents.reduce((sum, agent) => sum + (agent.tokensIn ?? 0), 0)
    const tokensOut = agents.reduce((sum, agent) => sum + (agent.tokensOut ?? 0), 0)
    // P6.641 — the BUDGET figure must count a split-less agent too, or a run on
    // a runtime that reports only totals would look free and the tokenBudget
    // check below would never fire.
    const spentTokens = agents.reduce((sum, agent) => sum + (
      typeof agent.tokensIn === 'number' && typeof agent.tokensOut === 'number'
        ? (agent.tokensIn ?? 0) + (agent.tokensOut ?? 0)
        : (agent.tokensTotal ?? 0)
    ), 0)
    const tokenBudget = numberFromInput(activity.toolInput?.tokenBudget)
    const resumedFrom = stringFromInput(activity.toolInput?.resumeRunId)
    const status = summarizeStatus(agents, activity.status)
    const isBudgetExceeded = (tokenBudget !== undefined && spentTokens > tokenBudget)
      || /tokenBudget exceeded/i.test(activity.content ?? '')

    return {
      agents,
      phaseGroups: Array.from(grouped.values()),
      tokensIn,
      tokensOut,
      spentTokens,
      tokenBudget,
      resumedFrom,
      status,
      isBudgetExceeded,
      runStartedAt: earliestStartedAt(agents),
      runEndedAt: latestEndedAt(agents),
      logs: extractWorkflowLogs(activity.content),
      errorText: extractWorkflowError(activity.content, status),
    }
  }, [activity.content, activity.status, activity.toolInput, progress, t])

  const isActive = summary.status === 'running' || summary.status === 'queued'
  const rawRunElapsed = useAgentElapsed(summary.runStartedAt, isActive ? undefined : summary.runEndedAt)
  const runElapsed = isActive || summary.runEndedAt ? rawRunElapsed : undefined

  if (!progress || progress.kind !== 'workflow') {
    return null
  }

  const resultText = (activity.status === 'completed' || activity.status === 'error')
    ? activity.content?.trim()
    : undefined
  const canResume = Boolean(onInsertResumePrompt && completedStatuses.has(summary.status))
  // P6.318 — offered only once the run is over, for the same reason Resume is:
  // a recipe kept mid-run is a recipe kept before anyone knows whether it works.
  const keepSource = onKeepRun && completedStatuses.has(summary.status)
    ? workflowRecipeSource(activity)
    : undefined

  return (
    <div className="flex min-w-0 flex-col" data-workflow-panel="">
      <div className={cn(WORK_LOG_ROW_WRAPPER, 'items-start gap-0.5')}>
        <button
          type="button"
          onClick={() => setIsExpanded(value => !value)}
          aria-expanded={isExpanded}
          aria-label={t('turnCard.workflow.toggle')}
          className={cn(WORK_LOG_ROW, WORK_LOG_ROW_INTERACTIVE, 'items-start')}
        >
          <motion.span
            initial={false}
            animate={{ rotate: isExpanded ? 90 : 0 }}
            transition={SPRING.snap}
            className={cn(ROW_ICON_SLOT, 'h-5 text-tertiary')}
          >
            <ChevronRight aria-hidden className={ROW_ICON_SIZE} />
          </motion.span>
          <span className={cn(ROW_ICON_SLOT, 'h-5')}>
            <StatusIcon status={summary.status} />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-h-5 min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <span className={cn(CHIP_NEUTRAL, 'font-medium')}>
                {t('turnCard.workflow.title')}
              </span>
              <span className="min-w-0 truncate">
                {t('turnCard.workflow.summary', {
                  count: summary.phaseGroups.length,
                  agents: summary.agents.length,
                })}
              </span>
            </span>
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-label-sm text-tertiary">
              <span className="min-w-0 truncate">
                {t('turnCard.workflow.runId')}: <code className="font-mono text-mono-ui">{progress.runId}</code>
              </span>
              <span className="tabular-nums">
                {summary.tokenBudget === undefined
                  ? t('turnCard.workflow.tokensNoBudget', { spent: formatTokens(summary.spentTokens) })
                  : t('turnCard.workflow.tokensWithBudget', {
                    spent: formatTokens(summary.spentTokens),
                    budget: formatTokens(summary.tokenBudget),
                  })}
              </span>
              {runElapsed && (
                <span className="tabular-nums">{t('turnCard.workflow.elapsed', { elapsed: runElapsed })}</span>
              )}
              {summary.resumedFrom && (
                <span className="min-w-0 truncate">
                  {t('turnCard.workflow.resumedFrom', { runId: summary.resumedFrom })}
                </span>
              )}
              {summary.isBudgetExceeded && (
                <span className={CHIP_DESTRUCTIVE}>
                  {t('turnCard.workflow.budgetExceeded')}
                </span>
              )}
            </span>
          </span>
        </button>

        {canResume && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onInsertResumePrompt?.(t('turnCard.workflow.resumePrompt', { runId: progress.runId }))}
            className="text-secondary hover:text-foreground"
          >
            <RotateCcw className={ROW_ICON_SIZE} />
            <span>{t('turnCard.workflow.resume')}</span>
          </Button>
        )}

        {/*
          P6.318 — the two scopes are two buttons rather than a menu behind one.
          Which one a user wants is not a default anybody can guess: a recipe
          kept in the project is shared with everyone who clones it, and a
          personal one travels between repositories with the person. A single
          button would have to pick, and the wrong pick is either a private
          workflow committed to someone's repository or a team recipe nobody
          else can see.
        */}
        {keepSource && (
          <>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onKeepRun?.('project', keepSource)}
              title={t('turnCard.workflow.keepProject')}
              className="text-secondary hover:text-foreground"
            >
              <FolderPlus className={ROW_ICON_SIZE} />
              <span>{t('turnCard.workflow.keepProject')}</span>
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onKeepRun?.('personal', keepSource)}
              title={t('turnCard.workflow.keepPersonal')}
              className="text-secondary hover:text-foreground"
            >
              <BookmarkPlus className={ROW_ICON_SIZE} />
              <span>{t('turnCard.workflow.keepPersonal')}</span>
            </Button>
          </>
        )}

        {onOpenDetails && resultText && (
          <IconButton
            size="sm"
            aria-label={t('turnCard.workflow.openDetails')}
            title={t('turnCard.workflow.openDetails')}
            icon={<ArrowUpRight className={ROW_ICON_SIZE} />}
            onClick={onOpenDetails}
            className="focus-visible:-outline-offset-2"
          />
        )}
      </div>

      {isActive && (
        <p className="pl-12 text-label-sm text-tertiary">
          {t('turnCard.workflow.cancelNote')}
        </p>
      )}

      {isExpanded && (
        <div className={cn(WORK_LOG_BODY, 'mb-0.5')}>
          {summary.phaseGroups.map(phase => (
            <PhaseSection key={phase.title} phase={phase} />
          ))}

          {summary.logs.length > 0 && (
            <CardWell title={t('turnCard.workflow.logs')} className="my-1">
              <ul className="space-y-0.5 px-3 py-2 text-label text-secondary">
                {summary.logs.map((line, index) => (
                  <li key={`${index}-${line}`} className="break-words">
                    {line}
                  </li>
                ))}
              </ul>
            </CardWell>
          )}

          {(summary.errorText || summary.isBudgetExceeded) && (
            <div
              className="my-1 flex gap-2.5 rounded-md border-l-2 border-destructive bg-destructive-tint px-3 py-2.5 text-label text-foreground"
            >
              <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
              <div className="min-w-0 flex-1 break-words">
                <div className="font-medium text-destructive">
                  {summary.isBudgetExceeded ? t('turnCard.workflow.budgetExceeded') : t('turnCard.workflow.error')}
                </div>
                {summary.errorText && (
                  <div className="mt-0.5 whitespace-pre-wrap">
                    {summary.errorText}
                  </div>
                )}
              </div>
            </div>
          )}

          {resultText && (
            <CardWell title={t('turnCard.workflow.result')} className="my-1">
              <div className="max-h-32 overflow-y-auto whitespace-pre-wrap px-3 py-2 text-label text-foreground">
                {resultText}
              </div>
            </CardWell>
          )}
        </div>
      )}
    </div>
  )
}
