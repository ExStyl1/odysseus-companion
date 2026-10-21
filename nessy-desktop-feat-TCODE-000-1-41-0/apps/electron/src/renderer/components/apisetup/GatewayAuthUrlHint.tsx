import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * F1.2 — the authorization link dp handed its browser, for a sign-in whose tab
 * the user cannot see (another Space, a hidden window, a remote session).
 *
 * It shows the HOST (so the user can tell where the link leads) and a Copy
 * action; never the path or the query, which carries dp's OAuth `state` and
 * PKCE challenge. Copy rather than open, deliberately: the browser dp already
 * asked to open is the one the user could not see, and opening through the
 * app's URL bridge would write the whole URL, query included, to the main log.
 * The sentence says where it has to be opened — the OAuth callback lands on
 * `localhost:25565` of THIS machine (`dp-api.ts` symbol `createBrowserHook`).
 *
 * `compact` is the one-line form for the banner strip: the button alone, the
 * sentence as its tooltip.
 *
 * UB14.40 — on v0.15.1's role inks: the sentence is tertiary fine print, the
 * host an inline code chip (v0.15.1 ServerSettingsPage's: the neutral fill,
 * mono, secondary ink), Copy the `secondary` button.
 */
export function GatewayAuthUrlHint({ url, className, compact = false }: {
  url: string
  className?: string
  compact?: boolean
}) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  let host = ''
  try {
    host = new URL(url).host
  } catch {
    host = ''
  }
  const copy = () => {
    void navigator.clipboard.writeText(url).then(() => setCopied(true), () => setCopied(false))
  }
  const label = copied ? t('common.copied') : t('onboarding.gatewayConnect.copyAuthUrl')
  if (compact) {
    return (
      <Button size="sm" variant="ghost" onClick={copy} title={t('onboarding.gatewayConnect.authUrlHint')} data-testid="gateway-auth-url-hint">
        {label}
      </Button>
    )
  }
  return (
    <div data-testid="gateway-auth-url-hint" className={cn('flex flex-col items-center gap-1.5 text-label-sm text-tertiary', className)}>
      <span className="max-w-sm">{t('onboarding.gatewayConnect.authUrlHint')}</span>
      <div className="flex items-center gap-2">
        {host && <code className="rounded-xs bg-fill-hover px-1.5 py-0.5 font-mono text-mono-ui text-secondary">{host}</code>}
        <Button size="sm" variant="secondary" onClick={copy}>
          {label}
        </Button>
      </div>
    </div>
  )
}
