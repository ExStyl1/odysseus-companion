import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Globe, ShieldAlert, ShieldCheck } from 'lucide-react'
import type { BrowserOriginTrustListing } from '../../../shared/types'
import { SettingsSection, SettingsCard } from '@/components/settings'
import { settingsUI } from '@/components/settings/SettingsUIConstants'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * P6.536 — *"the verdict … is revocable from settings, and survives a restart"*,
 * and *"the store answers which origins did this session touch"*.
 *
 * ## Read and revoke ONLY
 *
 * There is no way to GRANT an origin from here. A trust decision is made on the
 * card, in the window the page is in, where the user can see what they are
 * approving; a settings list shows an origin as a string with no page behind it,
 * and a control that granted from there would be the easiest place in the
 * product to approve the wrong thing.
 *
 * ## Two lists, and their difference is the point
 *
 * The decisions are persisted and survive a restart. *Visited this session* is a
 * process-lifetime set that is deliberately NOT persisted — a durable version of
 * it would be a browsing history on disk, which nobody asked for and which this
 * row must not ship by accident. Showing them together is what makes the
 * distinction legible instead of a footnote.
 *
 * ## UB15.7 — on v0.15.1's settings material
 *
 * The decisions are list rows the way upstream's Messaging page draws its bindings (one hairline between rows,
 * 14px sides, the origin on the label ink, the verdict chips on the secondary ink, the removal a `danger` small
 * `Button`); the empty line is in-card prose; the session footer is fine print in its own hairline-separated
 * block of the card.
 */
export function BrowserOriginTrustSection() {
  const { t } = useTranslation()
  const [listing, setListing] = React.useState<BrowserOriginTrustListing | null>(null)

  const refresh = React.useCallback(async () => {
    const api = window.electronAPI?.browserPane
    if (!api?.trustList) return
    try {
      setListing(await api.trustList())
    } catch {
      // A listing that cannot be read shows as empty rather than as an error
      // banner: nothing here is actionable if the channel is unavailable, and
      // the gate itself is unaffected — it reads the store in the main process.
      setListing({ origins: [], seenThisSession: [] })
    }
  }, [])

  React.useEffect(() => { void refresh() }, [refresh])

  const revoke = React.useCallback(async (origin: string) => {
    await window.electronAPI?.browserPane?.trustRevoke?.(origin)
    await refresh()
  }, [refresh])

  const origins = listing?.origins ?? []
  const seen = listing?.seenThisSession ?? []

  return (
    <SettingsSection
      title={t('settings.permissions.browserTrustSection')}
      description={t('settings.permissions.browserTrustSectionDesc')}
    >
      <SettingsCard>
        {origins.length === 0 ? (
          <p className={cn(settingsUI.cardPadding, settingsUI.prose)}>
            {t('settings.permissions.browserTrustEmpty')}
          </p>
        ) : (
          <ul className="divide-y divide-separator">
            {origins.map(entry => (
              <li key={entry.origin} className="flex items-center gap-3 px-3.5 py-2.5">
                <Globe className="size-4 shrink-0 text-tertiary" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-label text-foreground">{entry.origin}</span>
                {entry.navigation && (
                  <span className="inline-flex shrink-0 items-center gap-1 text-label-sm text-secondary">
                    {entry.navigation === 'deny'
                      ? <ShieldAlert className="size-3.5 text-destructive" aria-hidden />
                      : <ShieldCheck className="size-3.5 text-success" aria-hidden />}
                    {t(`settings.permissions.browserTrustNavigation.${entry.navigation}`)}
                  </span>
                )}
                {entry.cdp && (
                  <span className="inline-flex shrink-0 items-center gap-1 text-label-sm text-secondary">
                    {entry.cdp === 'deny'
                      ? <ShieldAlert className="size-3.5 text-destructive" aria-hidden />
                      : <ShieldCheck className="size-3.5 text-success" aria-hidden />}
                    {t(`settings.permissions.browserTrustCdp.${entry.cdp}`)}
                  </span>
                )}
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => { void revoke(entry.origin) }}
                >
                  {t('settings.permissions.browserTrustRevoke')}
                </Button>
              </li>
            ))}
          </ul>
        )}

        <p className={cn(settingsUI.cardPadding, settingsUI.descriptionSmall, '[overflow-wrap:anywhere]')}>
          {seen.length === 0
            ? t('settings.permissions.browserTrustSeenNone')
            : t('settings.permissions.browserTrustSeen', { origins: seen.join(', ') })}
        </p>
      </SettingsCard>
    </SettingsSection>
  )
}
