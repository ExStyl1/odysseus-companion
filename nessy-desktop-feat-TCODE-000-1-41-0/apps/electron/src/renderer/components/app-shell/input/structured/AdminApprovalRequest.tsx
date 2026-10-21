/**
 * Source: v0.15.1:apps/electron/src/renderer/components/app-shell/input/structured/AdminApprovalRequest.tsx (UB14.23; the
 * decision anatomy ADDED in v0.15.0). Merged (Apache-2.0): upstream's anatomy, then OUR hunks re-applied —
 * `adminApprovalCardData` (F1.885), the `canRemember` gate (no switch without a named lifetime or under
 * `noAlwaysAllow`, F1.869/F1.885; upstream still defaults the window to 10 min and always draws the switch),
 * the ask-rule `ruleSentence` line, and the `Trans`/`t()` copy (F1.554; upstream still ships English).
 */
import * as React from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import type { PermissionRequest } from '../../../../../shared/types'
import {
  DECISION_ACTION,
  DecisionActions,
  DecisionBody,
  DecisionCard,
  DecisionDetails,
  DecisionHeader,
  DecisionPreview,
  DecisionSpacer,
} from './DecisionCard'

export interface AdminApprovalRequestData {
  appName: string
  reason: string
  command: string
  impact?: string
  requiresSystemPrompt?: boolean
  /** The remember window the request itself named. Absent → the card offers no remember switch (F1.885). */
  rememberForMinutes?: number
  /** The request's own "offer no always-allow choice" flag (F1.842). Set → no remember switch (F1.885). */
  noAlwaysAllow?: boolean
  /** F1.885 — the sentence naming the ask rule that raised this card, when it is not already the "why". */
  ruleSentence?: string
}

/**
 * The card's data from an `admin_approval` permission request — what ChatDisplay renders the card from.
 *
 * F1.885 (F1.842's twin): under a readable ASK rule the admin card arrives as
 * `claudeReadablePermissionAskCheckResult` (claude) and `piReadableAskOverModePrompt` (Pi) shape it —
 * the rule sentence as `description`, the classifier's own `reason` kept, NO `rememberForMinutes`, and
 * `noAlwaysAllow`. This mapping used to default the window to 10 min and keep neither of the other two, so
 * the card offered "Remember for 10 min" — a window `SessionManager` neither stores nor honours for a card
 * that names no lifetime (`adminCardRememberWindowOffered`, F1.869) — and never showed the rule. Now the
 * window is passed as the request named it, the flag is carried, and the rule sentence is shown beside the
 * reason. On a no-rule card `description` only restates the header (`classifyAdminApproval`'s "Admin
 * approval required for …"), so it stays hidden there; a card with no `reason` of its own (Pi's gate-card
 * forwarding sends none) already shows its description as the "why", so it is not shown twice.
 */
export function adminApprovalCardData(request: PermissionRequest): AdminApprovalRequestData {
  const reason = request.reason || request.description
  const unrememberable = request.noAlwaysAllow === true
  return {
    appName: request.appName || request.toolName || 'System action',
    reason,
    impact: request.impact,
    command: request.command || '',
    requiresSystemPrompt: request.requiresSystemPrompt ?? true,
    ...(request.rememberForMinutes !== undefined ? { rememberForMinutes: request.rememberForMinutes } : {}),
    ...(unrememberable ? { noAlwaysAllow: true } : {}),
    ...(unrememberable && request.description && request.description !== reason ? { ruleSentence: request.description } : {}),
  }
}

interface AdminApprovalRequestProps {
  request: AdminApprovalRequestData
  onApprove: (options: { rememberForMinutes?: number }) => void
  onCancel: () => void
  /** When true, the composer slot (InputContainer) draws the card material and ring */
  unstyled?: boolean
}

/**
 * AdminApprovalRequest - Friendly admin-elevation approval card for non-technical users.
 *
 * Goal: make privileged escalation understandable and safe. Decision-card anatomy (spec §7.6):
 * Approve (primary) · Cancel (ghost) · "Remember" switch.
 */
export function AdminApprovalRequest({
  request,
  onApprove,
  onCancel,
  unstyled = false,
}: AdminApprovalRequestProps) {
  const { t } = useTranslation()
  const [rememberChoice, setRememberChoice] = React.useState(false)

  const rememberForMinutes = request.rememberForMinutes
  // F1.885 — the switch only where the host would keep what it promises: not on a card the server
  // flagged unrememberable (the wire's `noAlwaysAllow`), and not on one that names no lifetime, for which
  // `SessionManager` stores no window (F1.869). It used to render on every card with a 10-min default.
  const canRemember = request.noAlwaysAllow !== true && typeof rememberForMinutes === 'number'

  const handleApprove = () => {
    onApprove({ rememberForMinutes: canRemember && rememberChoice ? rememberForMinutes : undefined })
  }

  return (
    <DecisionCard tone="info" standalone={!unstyled}>
      <DecisionBody>
        <DecisionHeader tone="info" icon={<ShieldAlert />} title={t('chat.adminApprovalRequired')} />
        <DecisionDetails>
          <p className="text-label text-secondary">
            {/* F1.554: `<app/>` is self-closing, so the name is a React child and never parsed as markup. */}
            <Trans i18nKey="chat.adminApproval.installNeedsApproval" components={{ app: <span className="font-medium text-foreground">{request.appName}</span> }} />
            {request.requiresSystemPrompt ? <>{' '}{t('chat.adminApproval.systemPrompt')}</> : ''}
            <br />
            <span className="font-medium text-foreground">{t('chat.adminApproval.why')}</span> {request.reason}
            {request.impact && (
              <>
                <br />
                <span className="font-medium text-foreground">{t('chat.adminApproval.impact')}</span> {request.impact}
              </>
            )}
            {request.ruleSentence && (
              <>
                <br />
                <span className="text-foreground">{request.ruleSentence}</span>
              </>
            )}
          </p>

          <DecisionPreview>{request.command}</DecisionPreview>
        </DecisionDetails>
      </DecisionBody>

      <DecisionActions>
        <Button
          variant="primary"
          size="lg"
          className={`${DECISION_ACTION} cursor-pointer`}
          onClick={handleApprove}
        >
          {t('chat.adminApproval.approve')}
        </Button>

        <Button
          variant="ghost"
          size="lg"
          className={DECISION_ACTION}
          onClick={onCancel}
        >
          {t('common.cancel')}
        </Button>

        <DecisionSpacer />

        {canRemember && (
          <div className="flex items-center gap-2">
            <Switch
              checked={rememberChoice}
              onCheckedChange={setRememberChoice}
              aria-label={t('chat.adminApproval.rememberExactCommand', { count: rememberForMinutes })}
            />
            <Label className="cursor-pointer text-label-sm text-secondary" onClick={() => setRememberChoice(!rememberChoice)}>
              {t('chat.adminApproval.rememberFor', { minutes: rememberForMinutes })}
            </Label>
          </div>
        )}
      </DecisionActions>
    </DecisionCard>
  )
}
