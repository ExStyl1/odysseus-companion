import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { motion } from 'motion/react'
import {
  ArrowUpRight,
  Ban,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  XCircle,
} from 'lucide-react'
import type { OrchestrationAgentStatus, OrchestrationProgressAgent } from '@nessy-agent/core'
import type { ActivityItem } from '@nessy-agent/ui/chat/TurnCard'
import { formatTokens } from '@nessy-agent/ui/chat/turn-utils'
import { SPRING } from '@nessy-agent/ui/motion'
import { IconButton } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useAgentElapsed } from './agent-elapsed'
import { orchestrationActivityLabel, orchestrationActivityTitle } from './orchestration-activity'
import { CardWell, CHIP_NEUTRAL, HOVER_REVEAL, ROW_ICON_SIZE, ROW_ICON_SLOT, RowSpinner, WORK_LOG_BODY, WORK_LOG_ROW, WORK_LOG_ROW_INTERACTIVE, WORK_LOG_ROW_WRAPPER } from './transcript-card-chrome'

/*
 * UB14.18 — drawn as a work-log group, the look v0.15.1's `ActivityGroupRow` gives a Task subagent:
 * a header row (chevron · status · the title chip · the summary) whose "open the result" action is
 * the row's hover-revealed icon button, and the agents under the inset hairline as rows. The
 * subagent's result is a sunken well. Every value it shows is unchanged; the imports and this note
 * are sized so the ledger's H12 anchors here (`:91-110`, `:110`) still land on the code they name.
 */

type SubagentCardProps = {
  activity: ActivityItem
  onOpenDetails?: () => void
  defaultExpanded?: boolean
}

const completedStatuses = new Set<OrchestrationAgentStatus>(['done', 'error', 'aborted'])

function statusRank(status: OrchestrationAgentStatus): number {
  switch (status) {
    case 'error':
      return 0
    case 'aborted':
      return 1
    case 'running':
      return 2
    case 'queued':
      return 3
    case 'done':
      return 4
  }
}

function summarizeStatus(agents: OrchestrationProgressAgent[], fallback: ActivityItem['status']): OrchestrationAgentStatus {
  if (agents.length === 0) {
    if (fallback === 'error') return 'error'
    if (fallback === 'completed') return 'done'
    return 'running'
  }

  return agents.reduce<OrchestrationAgentStatus>((current, agent) => (
    statusRank(agent.status) < statusRank(current) ? agent.status : current
  ), 'done')
}

/**
 * The agent's status glyph on the work log's vocabulary (`ActivityStatusIcon`): the accent spinner
 * while running, the success check, the destructive cross; queued and aborted — states a tool row
 * never has — stay in the tertiary ink with their own shapes, so status never rests on colour alone.
 */
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

/**
 * P6.641 — the row's token total, and whether a split exists to show beside it.
 *
 * The pair is preferred when present (Pi and codex both report it) and
 * `tokensTotal` is the fallback for a runtime that reports only a total —
 * claude, whose `SDKTaskProgressMessage.usage` is
 * `{ total_tokens, tool_uses, duration_ms }` with no split anywhere on the
 * message (agent-sdk 0.3.233). `hasSplit` is what keeps the second line OFF in
 * that case: rendering `0 in / 0 out` beside a real total would state a fact the
 * runtime never reported.
 */
function agentTokens(agent: OrchestrationProgressAgent): { total: number; hasSplit: boolean } {
  const hasSplit = typeof agent.tokensIn === 'number' && typeof agent.tokensOut === 'number'
  if (hasSplit) return { total: (agent.tokensIn ?? 0) + (agent.tokensOut ?? 0), hasSplit }
  return { total: agent.tokensTotal ?? 0, hasSplit }
}

function AgentRow({ agent }: { agent: OrchestrationProgressAgent }) {
  const { t } = useTranslation()
  const { total: totalTokens, hasSplit } = agentTokens(agent)
  const elapsed = useAgentElapsed(agent.startedAt, agent.endedAt)
  // P6.305. Until now this card answered "what is this subagent doing?" with a
  // spinner and a clock: `lastActivity` reached it on every progress emit and
  // was dropped on the floor. Same reader as `WorkflowPanel`, so one token has
  // one rendering.
  const activity = orchestrationActivityLabel(agent.lastActivity, t)
  const activityTitle = orchestrationActivityTitle(agent.lastActivity, t)

  return (
    <div className="flex min-h-7 min-w-0 items-start gap-2 py-1 text-label text-secondary" data-subagent-agent="">
      <span className={cn(ROW_ICON_SLOT, 'h-5')}>
        <StatusIcon status={agent.status} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate">{agent.label}</span>
          <span className={CHIP_NEUTRAL}>{agent.agentType}</span>
        </div>
        <div className="flex min-w-0 items-center gap-1.5 text-label-sm text-tertiary">
          <span>{t(`turnCard.subagent.status.${agent.status}`)}</span>
          {elapsed && (
            <>
              <span aria-hidden>·</span>
              <span className="shrink-0 tabular-nums">{elapsed}</span>
            </>
          )}
          {agent.phase && (
            <>
              <span aria-hidden>·</span>
              <span className="truncate">{agent.phase}</span>
            </>
          )}
          {/* I2.9 — the two nesting facts, each rendered ONLY when the runtime
              stated it. `agent.isBackgrounded === true` and not a truthiness
              test: `undefined` means the runtime never reported the
              distinction (Pi and codex do not), and `false` means it reported
              the FOREGROUND — which is the ordinary case and needs no chip,
              because the turn blocking on its child is what a reader already
              assumes. So only the surprising half is drawn. */}
          {agent.isBackgrounded === true && (
            <>
              <span aria-hidden>·</span>
              <span className="shrink-0">{t('turnCard.subagent.backgrounded')}</span>
            </>
          )}
          {/* Depth 1 is a top-level spawn by the SDK's own gloss, so it is the
              default shape and says nothing; a deeper one is the fact worth
              showing. Absent on every task that is not a `local_agent`. */}
          {typeof agent.spawnDepth === 'number' && agent.spawnDepth > 1 && (
            <>
              <span aria-hidden>·</span>
              <span className="shrink-0 tabular-nums">
                {t('turnCard.subagent.nested', { depth: agent.spawnDepth })}
              </span>
            </>
          )}
          {activity && (
            <>
              <span aria-hidden>·</span>
              <span className="truncate" title={activityTitle}>{activity}</span>
            </>
          )}
        </div>
      </div>
      <div className="shrink-0 pl-1 text-right text-label-sm tabular-nums text-tertiary">
        <div>{formatTokens(totalTokens)}</div>
        {hasSplit && (
          <div className="text-caption">
            {t('turnCard.subagent.tokens', {
              input: formatTokens(agent.tokensIn ?? 0),
              output: formatTokens(agent.tokensOut ?? 0),
            })}
          </div>
        )}
      </div>
    </div>
  )
}

export function SubagentCard({ activity, onOpenDetails, defaultExpanded = false }: SubagentCardProps) {
  const { t } = useTranslation()
  const [isExpanded, setIsExpanded] = useState(defaultExpanded)
  const progress = activity.orchestrationProgress

  const summary = useMemo(() => {
    const agents = progress?.agents ?? []
    const tokensIn = agents.reduce((sum, agent) => sum + (agent.tokensIn ?? 0), 0)
    const tokensOut = agents.reduce((sum, agent) => sum + (agent.tokensOut ?? 0), 0)
    // P6.641 — the header takes the split line only when EVERY agent has one.
    // A mixed roster cannot be summed honestly into an in/out pair, and one
    // agent's split presented as the run's would be a smaller number wearing a
    // bigger label.
    const hasSplit = agents.length > 0
      && agents.every(agent => typeof agent.tokensIn === 'number' && typeof agent.tokensOut === 'number')
    const totalTokens = agents.reduce((sum, agent) => sum + agentTokens(agent).total, 0)
    const doneCount = agents.filter(agent => completedStatuses.has(agent.status)).length
    return {
      agents,
      doneCount,
      tokensIn,
      tokensOut,
      hasSplit,
      totalTokens,
      status: summarizeStatus(agents, activity.status),
    }
  }, [activity.status, progress])

  if (!progress || progress.kind !== 'subagent') {
    return null
  }

  const resultText = (activity.status === 'completed' || activity.status === 'error')
    ? activity.content?.trim()
    : undefined

  return (
    <div className="flex min-w-0 flex-col" data-subagent-card="">
      <div className={cn(WORK_LOG_ROW_WRAPPER, 'group/row items-center')}>
        <button
          type="button"
          onClick={() => setIsExpanded(value => !value)}
          aria-expanded={isExpanded}
          aria-label={t('turnCard.subagent.toggle')}
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
            <StatusIcon status={summary.status} />
          </span>
          <span className={cn(CHIP_NEUTRAL, 'font-medium')}>
            {t('turnCard.subagent.title')}
          </span>
          <span className="min-w-0 flex-1 truncate tabular-nums text-tertiary">
            {summary.hasSplit
              ? t('turnCard.subagent.summary', {
                count: summary.agents.length,
                done: summary.doneCount,
                tokensIn: formatTokens(summary.tokensIn),
                tokensOut: formatTokens(summary.tokensOut),
              })
              : t('turnCard.subagent.summaryTotal', {
                count: summary.agents.length,
                done: summary.doneCount,
                tokens: formatTokens(summary.totalTokens),
              })}
          </span>
        </button>

        {onOpenDetails && resultText && (
          <IconButton
            size="sm"
            aria-label={t('turnCard.subagent.openDetails')}
            title={t('turnCard.subagent.openDetails')}
            icon={<ArrowUpRight className={ROW_ICON_SIZE} />}
            onClick={onOpenDetails}
            data-touch-reveal="true"
            className={cn(HOVER_REVEAL, 'ml-1 group-hover/row:opacity-100 group-hover/row:duration-instant group-focus-within/row:opacity-100 focus-visible:-outline-offset-2')}
          />
        )}
      </div>

      {isExpanded && (
        <div className={cn(WORK_LOG_BODY, 'mb-0.5')}>
          {summary.agents.map(agent => (
            <AgentRow key={agent.id} agent={agent} />
          ))}

          {resultText && (
            <CardWell title={t('turnCard.subagent.result')} className="my-1">
              <div className="max-h-28 overflow-y-auto whitespace-pre-wrap px-3 py-2 text-label text-foreground">
                {resultText}
              </div>
            </CardWell>
          )}
        </div>
      )}
    </div>
  )
}
