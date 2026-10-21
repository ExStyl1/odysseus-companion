import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { GatewayAuthUrlHint } from '@/components/apisetup/GatewayAuthUrlHint'
import { DP_SESSION_FILE_TOAST_ID, gatewaySignInFailureView, useNessyGatewayAuth, type GatewayAuthPhase } from '@/hooks/useNessyGatewayAuth'

export interface GatewayBannerView {
  /** i18n key for the banner title. */
  titleKey: string
  /**
   * F1.361 — i18n key of the next step, shown in place of the re-auth note when
   * a failure has one (`gatewaySignInFailureView`).
   */
  nextStepKey?: string
  /** i18n key for the action button label. */
  buttonKey: string
  /** Auth flow is in progress — button disabled. */
  busy: boolean
}

/**
 * Pure phase → banner content mapping, unit-tested without React. Returns the
 * view for a VISIBLE banner; visibility itself (armed by `login-required`,
 * cleared by `done`/dismiss) is component state.
 */
export function computeGatewayBannerView(phase: GatewayAuthPhase, errorCode?: string): GatewayBannerView {
  switch (phase) {
    case 'checking':
    case 'exchanging':
      return { titleKey: 'auth.nessyGatewaySignInRequired', buttonKey: 'onboarding.gatewayConnect.connecting', busy: true }
    case 'waiting-browser':
      return { titleKey: 'auth.nessyGatewaySignInRequired', buttonKey: 'onboarding.gatewayConnect.waitingBrowser', busy: true }
    case 'error': {
      // F1.361 — the per-code reason, not "DpNotFound or generic".
      const failure = gatewaySignInFailureView(errorCode)
      return {
        titleKey: failure.reasonKey,
        ...(failure.nextStepKey ? { nextStepKey: failure.nextStepKey } : {}),
        buttonKey: 'onboarding.gatewayConnect.retry',
        busy: false,
      }
    }
    default:
      return { titleKey: 'auth.nessyGatewaySignInRequired', buttonKey: 'auth.nessyGatewaySignIn', busy: false }
  }
}

/**
 * Non-blocking top strip shown when the launch check reports a Nessy Gateway
 * connection without a valid dp JWT (`login-required`). One click runs the same
 * one-click auth flow the cards use; hides on success or dismiss. Mounted once
 * above the main content panel (MainContentPanel wrapWithStoplight).
 */
export function GatewayAuthBanner() {
  const { t } = useTranslation()
  const { phase, errorCode, authUrl, dpSessionFileUsed, ensure } = useNessyGatewayAuth()
  const [armed, setArmed] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    if (phase === 'login-required') {
      setArmed(true)
      setDismissed(false)
    } else if (phase === 'done') {
      setArmed(false)
    }
  }, [phase])

  // F1.366 rule 6 — signed in with dp's STORED session: say so, whether or not
  // the strip itself is showing (the banner is the one mount every main-window
  // surface shares, Settings included).
  useEffect(() => {
    if (dpSessionFileUsed) toast.info(t('onboarding.gatewayConnect.dpSessionFileUsed'), { id: DP_SESSION_FILE_TOAST_ID })
  }, [dpSessionFileUsed, t])

  if (!armed || dismissed) return null

  const view = computeGatewayBannerView(phase, errorCode)

  return (
    <div className="h-12 shrink-0 pl-4 pr-2 flex items-center justify-between gap-3 border-b border-foreground/10 bg-background select-none">
      {/* `title` carries the whole text: a per-code reason can be longer than one truncated line. */}
      <h3
        className="text-sm font-medium text-foreground font-sans min-w-0 truncate"
        title={`${t(view.titleKey)} ${t(view.nextStepKey ?? 'auth.nessyGatewayReauthNote')}`}
      >
        {t(view.titleKey)}
        <span className="ml-2 text-xs font-normal text-muted-foreground">{t(view.nextStepKey ?? 'auth.nessyGatewayReauthNote')}</span>
      </h3>
      <div className="flex items-center gap-1 shrink-0">
        {/* F1.2 — the link dp handed its browser, for a tab the user cannot see. */}
        {phase === 'waiting-browser' && authUrl && <GatewayAuthUrlHint url={authUrl} compact />}
        <Button size="sm" disabled={view.busy} onClick={() => { void ensure() }}>
          {t(view.buttonKey)}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setDismissed(true)} aria-label={t('common.dismiss')}>
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
