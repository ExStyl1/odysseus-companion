/**
 * Source: v0.15.1:apps/electron/src/renderer/components/automations/AutomationActionRow.tsx (UB14.44;
 * the restyle re-applied on ours: Badge → Info_Badge, role text tokens, the 18px index column; our UA8.3
 * `ScriptActionDetails` kept and restyled onto the same tokens). Apache-2.0, LICENSE and NOTICE kept.
 */
/**
 * AutomationActionRow
 *
 * Inline display of a single automation action (prompt, webhook or — UA8.3 — script).
 * Used within the "Then" section of AutomationInfoPage.
 *
 * UA8.3 (ours — upstream v0.13.4 shows no script action): a script action shows its path, arguments and
 * runtime, and where its current bytes stand against the host ledger. An unapproved or changed script offers
 * "Approve", which names the digest shown here (`automations:approveScript` refuses bytes swapped since); it
 * does not run until approved. Every state is text + icon, never colour only.
 *
 * Prompt actions surface optional per-action overrides (llmConnection,
 * model, thinkingLevel) as low-emphasis badges below the prompt text.
 */

import * as React from 'react'
import { ShieldAlert, ShieldCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { Info_Badge } from '@/components/info/Info_Badge'
import { Button } from '@/components/ui/button'
import { THINKING_LEVELS } from '@nessy-agent/shared/agent/thinking-levels'
import type { AutomationAction, PromptAction, ScriptAction } from './types'
import { ActionTypeIcon } from './ActionTypeIcon'
import { DEFAULT_WEBHOOK_METHOD } from './constants'

export interface AutomationActionRowProps {
  action: AutomationAction
  index: number
  className?: string
  /** UA8.3 — record the approval of THIS script action's shown digest; resolves to the new state. */
  onApproveScript?: (index: number, sha256: string) => Promise<ScriptAction['approval']>
}

/**
 * Highlight @mentions in prompt strings
 */
function PromptText({ text, t }: { text: string; t: (key: string) => string }) {
  if (!text) return <span className="text-label italic text-tertiary">{t('automations.emptyPrompt')}</span>
  const parts = text.split(/(@\w[\w-]*)/g)
  return (
    <span className="break-words text-label text-foreground">
      {parts.map((part, i) =>
        part.startsWith('@') ? (
          <span key={i} className="text-accent font-medium">{part}</span>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </span>
  )
}

function WebhookText({ action }: { action: Extract<AutomationAction, { type: 'webhook' }> }) {
  const method = action.method ?? DEFAULT_WEBHOOK_METHOD
  return (
    <span className="break-words text-label">
      <span className="font-mono text-mono-ui font-medium text-accent">{method}</span>{' '}
      <span className="text-secondary [overflow-wrap:anywhere]">{action.url}</span>
      {action.bodyFormat && (
        <span className="ml-1 text-tertiary">({action.bodyFormat})</span>
      )}
    </span>
  )
}

/**
 * Render the per-action override chips (connection / model / thinking level).
 * Each chip is conditional on its field being set on the action.
 *
 * The connection slug is shown verbatim (no display-name resolution) — that
 * would require fetching the workspace's LlmConnection list into the Info
 * page, which isn't justified for a read-only chip. If the slug becomes
 * stale, executePromptAutomation already logs a warning at run time.
 */
function PromptActionBadges({ action, t }: { action: PromptAction; t: (key: string) => string }) {
  const { llmConnection, model, thinkingLevel } = action
  if (!llmConnection && !model && !thinkingLevel) return null

  const thinkingDef = thinkingLevel ? THINKING_LEVELS.find((l) => l.id === thinkingLevel) : undefined
  const thinkingLabel = thinkingDef ? t(thinkingDef.nameKey) : thinkingLevel

  return (
    <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
      {llmConnection && (
        <Info_Badge
          color="default"
          className="font-mono font-normal"
          title={`${t('automations.labelConnection')}: ${llmConnection}`}
        >
          {llmConnection}
        </Info_Badge>
      )}
      {model && (
        <Info_Badge
          color="default"
          className="max-w-[14rem] font-mono font-normal"
          title={`${t('automations.labelModel')}: ${model}`}
        >
          <span className="truncate">{model}</span>
        </Info_Badge>
      )}
      {thinkingLevel && (
        <Info_Badge
          color="default"
          className="font-normal"
          title={`${t('automations.labelThinking')}: ${thinkingLabel}`}
        >
          {thinkingLabel}
        </Info_Badge>
      )}
    </div>
  )
}

type ScriptApproval = NonNullable<ScriptAction['approval']>

/** UA8.3 — a script action: its command line and where it stands against the ledger, with "Approve". */
export function ScriptActionDetails({
  action,
  index,
  onApproveScript,
}: {
  action: ScriptAction
  index: number
  onApproveScript?: AutomationActionRowProps['onApproveScript']
}) {
  const { t } = useTranslation()
  const [approval, setApproval] = React.useState<ScriptApproval | undefined>(action.approval)
  const [busy, setBusy] = React.useState(false)
  const [failure, setFailure] = React.useState<string | null>(null)
  React.useEffect(() => setApproval(action.approval), [action.approval])

  const state = approval?.state
  const canApprove = (state === 'unapproved' || state === 'changed') && Boolean(approval?.sha256) && Boolean(onApproveScript)
  const approve = async () => {
    if (!onApproveScript || !approval?.sha256) return
    setBusy(true)
    setFailure(null)
    try {
      setApproval((await onApproveScript(index, approval.sha256)) ?? approval)
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  // UB14.44 — the v0.15.1 restyle re-applied on this our-only block: the runtime is the same neutral
  // chip as the prompt overrides, the ledger state an Info_Badge on its role tint with an icon (the old
  // amber "warning" is the info tint, as upstream moved it), Approve a small primary Button.
  return (
    <div className="min-w-0">
      <span className="break-words font-mono text-mono-ui text-foreground [overflow-wrap:anywhere]">
        {[action.script, ...(action.args ?? [])].join(' ')}
      </span>
      <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
        <Info_Badge color="default" className="font-mono font-normal">
          {action.runtime ?? 'bun'}
        </Info_Badge>
        {state === 'approved' ? (
          <Info_Badge color="success" icon={<ShieldCheck aria-hidden />} data-script-approval="approved">
            {t('automations.script.approved')}
          </Info_Badge>
        ) : state ? (
          <Info_Badge color="warning" icon={<ShieldAlert aria-hidden />} data-script-approval={state}>
            {state === 'changed' ? t('automations.script.changed')
              : state === 'missing' ? t('automations.script.missing')
              : state === 'outside' ? t('automations.script.outside')
              : t('automations.script.unapproved')}
          </Info_Badge>
        ) : (
          <span className="text-label-sm text-tertiary" data-script-approval="unknown">{t('automations.script.unknown')}</span>
        )}
        {canApprove && (
          <Button
            type="button"
            variant="primary"
            size="sm"
            disabled={busy}
            onClick={() => void approve()}
            title={approval?.sha256 ? `sha256 ${approval.sha256}` : undefined}
          >
            {t('automations.script.approve')}
          </Button>
        )}
      </div>
      {failure && (
        <div className="mt-1 break-words text-label-sm text-destructive">
          {t('automations.script.approveFailed')}: {failure}
        </div>
      )}
    </div>
  )
}

export function AutomationActionRow({ action, index, className, onApproveScript }: AutomationActionRowProps) {
  const { t } = useTranslation()
  const isWebhook = action.type === 'webhook'

  return (
    <div className={cn('flex items-start gap-3 px-3.5 py-3', className)}>
      {/* Index + icon — h-[18px] matches the first line height of text-label content */}
      <div className="flex h-[18px] shrink-0 items-center gap-2">
        <span className="w-4 text-right text-label-sm text-tertiary tabular-nums">
          {index + 1}.
        </span>
        <ActionTypeIcon type={action.type} className="h-3.5 w-3.5" />
      </div>

      {/* Content — text-label on the block so the line box matches the 18px index column */}
      <div className="flex-1 min-w-0 text-label">
        {isWebhook ? (
          <WebhookText action={action} />
        ) : action.type === 'script' ? (
          <ScriptActionDetails action={action} index={index} onApproveScript={onApproveScript} />
        ) : (
          <>
            <PromptText text={action.prompt} t={t} />
            <PromptActionBadges action={action} t={t} />
          </>
        )}
      </div>
    </div>
  )
}
