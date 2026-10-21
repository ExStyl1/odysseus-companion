import { useTranslation } from 'react-i18next'
import type { IsolationNetworkPostureV1 } from '@nessy-agent/core/types'
import { cn } from '@/lib/utils'
import { settingsUI } from './SettingsUIConstants'

export interface IsolationNetworkPostureProps {
  /**
   * The host's reported posture. `undefined` means the report carried none —
   * an on-demand probe without resolved sandbox settings — and nothing is shown
   * rather than a guess.
   */
  posture?: IsolationNetworkPostureV1
  /**
   * The host's `sandbox.enabled` master switch. `false` means nothing is
   * running under these profiles right now, so every sentence below is about
   * an EMPTY category (P2.365) — true, and read by a user as a claim about
   * their session. `undefined` is "not reported", which is not the same as off
   * and must not render the qualifier.
   */
  sandboxEnabled?: boolean
}

/**
 * What outbound network a sandboxed command actually gets, stated where the
 * isolation posture is shown.
 *
 * DISCLOSURE ONLY. It changes no profile and gates nothing: `egress: 'open'` is
 * a recorded owner decision, not a defect, and this block is deliberately
 * written as "here is your posture" rather than as a warning. The reason it
 * exists is that a profile row reading `networked: available` tells an
 * administrator that the profile works, and says nothing about the fact that
 * "works" means any host is reachable.
 *
 * The unenforceable lines are rendered VERBATIM from the server. They are
 * produced by `resolveSandboxNetworkEnforcement`, the same unit the process
 * supervisor enforces from, so this page cannot state a second truth about what
 * binds; re-wording them here is exactly how the two would drift apart.
 *
 * UB15.7 — one group of the isolation card's `<dl>` on v0.15.1's settings material: the in-card padding, the
 * profile name in mono, the value on the secondary ink, the sentence under it as a row description, and the
 * qualifiers as fine print. The hairline above it is the list's (`divide-y divide-separator` on the page's `<dl>`),
 * so the block no longer draws its own rule.
 */
export function IsolationNetworkPosture({ posture, sandboxEnabled }: IsolationNetworkPostureProps) {
  const { t } = useTranslation()
  if (!posture) return null

  return (
    <div className={cn(settingsUI.cardPadding, 'space-y-1')}>
      <div className="flex items-baseline justify-between gap-3">
        <dt className="font-mono text-mono-ui text-foreground">{t('settings.permissions.isolationEgress')}</dt>
        <dd className="text-label text-secondary">
          {posture.egress === 'denied'
            ? t('settings.permissions.isolationEgressDenied')
            : t('settings.permissions.isolationEgressOpen')}
        </dd>
      </div>
      <p className={settingsUI.description}>
        {posture.egress === 'denied'
          ? t('settings.permissions.isolationEgressDeniedDesc')
          : t('settings.permissions.isolationEgressOpenDesc')}
      </p>
      {/* P2.365 — the two sentences above are correctly scoped to SANDBOXED
          commands, so neither is the false copy P2.331 closed. But with the
          master switch off there are no sandboxed commands, and a sentence
          that is true about an empty category reads as a claim about the
          session. The block still renders: an administrator asking what a
          profile would grant is why it exists. It is the tense that was
          wrong, so this qualifier states it rather than a condition hiding
          the disclosure. */}
      {sandboxEnabled === false && (
        <p className={settingsUI.descriptionSmall}>
          {t('settings.permissions.isolationEgressInactive')}
        </p>
      )}
      {posture.unenforceable.length > 0 && (
        <div className="space-y-1 pt-1">
          <p className={settingsUI.descriptionSmall}>
            {t('settings.permissions.isolationEgressUnenforced')}
          </p>
          <ul className="space-y-1">
            {posture.unenforceable.map(entry => (
              <li key={entry} className={cn(settingsUI.descriptionSmall, '[overflow-wrap:anywhere]')}>
                {entry}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
