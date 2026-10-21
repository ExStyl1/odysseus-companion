/**
 * P6.209, denominator entries A44 and A45 — the auto-mode judge's own rules.
 *
 * The block has been sent on every Claude session since P3.94 and had NO surface
 * anywhere: `autoMode` scored zero across `apps/electron/src`, `packages/ui` and
 * the i18n catalogue. So this deployment has been instructing a second model
 * about what is normal and what is forbidden, and the person it protects could
 * not read a word of it.
 *
 * ## Three limits stated rather than implied
 *
 * **It is Claude Code's judge, in auto mode.** Pi has the Guardian judge and
 * codex has its own reviewer; neither reads these rules. A permissions page that
 * showed one runtime's rules under a neutral heading would be the exact
 * silent-divergence this fork keeps finding.
 *
 * **A call this app already allowed never reaches the judge.** P3.93's measured
 * ceiling: our own PreToolUse `allow` silences the classifier entirely. Without
 * that sentence the section over-promises — a reader would take these rules for
 * a net under everything.
 *
 * **No `allow` list is sent, and the blank is deliberate.** A deployment policy
 * may narrow what the judge permits and never widen it, so a missing section
 * would read as an omission rather than as the rule it is.
 *
 * ## Read-only, and the missing editor is a decision
 *
 * Whether an operator may EDIT these lists is an open owner question. The viewer
 * is the half that is correct under either answer, which is why the row asks for
 * it first, and the channel it reads has no setter at all.
 *
 * ## UB15.7 — on v0.15.1's settings material
 *
 * Each band is its own hairline-separated block of the card (the list's `divide-y divide-separator`, so a band
 * with nothing to say draws no empty rule): its heading on the label ink, its sentences as row descriptions, the
 * `$defaults` sentence as fine print. The two closing notes share the last block, as fine print.
 */

import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SettingsSection, SettingsCard } from '@/components/settings'
import { settingsUI } from '@/components/settings/SettingsUIConstants'
import { cn } from '@/lib/utils'
import type { SafeClaudeAutoModePolicyView } from '@nessy-agent/shared/protocol/capabilities'

/** The literal the runtime documents for "inherit the built-in rules here". */
const DEFAULTS_SPLICE = '$defaults'

function RuleBand({ title, rules }: { title: string; rules: readonly string[] }) {
  const { t } = useTranslation()
  // `$defaults` is a real instruction to the runtime, not decoration, so it is
  // rendered as the sentence it means rather than hidden or shown as a token.
  const keepsDefaults = rules.includes(DEFAULTS_SPLICE)
  const sentences = rules.filter(rule => rule !== DEFAULTS_SPLICE)
  if (sentences.length === 0) return null
  return (
    <div className={cn(settingsUI.cardPadding, 'space-y-1.5')}>
      <div className={settingsUI.label}>{title}</div>
      <ul className="space-y-1.5">
        {sentences.map(rule => (
          <li key={rule} className={settingsUI.description}>
            {rule}
          </li>
        ))}
      </ul>
      {keepsDefaults && (
        <div className={settingsUI.descriptionSmall}>
          {t('settings.permissions.judgeRules.defaultsSplice')}
        </div>
      )}
    </div>
  )
}

export default function AutoModeJudgeRulesSection() {
  const { t } = useTranslation()
  const [policy, setPolicy] = useState<SafeClaudeAutoModePolicyView | null>(null)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async () => {
    if (!window.electronAPI) return
    try {
      setPolicy(await window.electronAPI.getAutoModePolicy())
      setFailed(false)
    } catch {
      // A viewer that cannot read says so. It never guesses: an invented rule
      // here would be indistinguishable from one the judge is really given.
      setPolicy(null)
      setFailed(true)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  return (
    <SettingsSection
      title={t('settings.permissions.judgeRules.title')}
      description={`${t('settings.permissions.judgeRules.description')} ${t('settings.permissions.judgeRules.scopeNote')}`}
    >
      {/* No card until the read answers: an empty raised card would read as "no rules". */}
      {(failed || policy) && (
        <SettingsCard>
          {failed && (
            <p className={cn(settingsUI.cardPadding, settingsUI.description)}>
              {t('settings.permissions.judgeRules.unavailable')}
            </p>
          )}

          {policy && (
            <div className="divide-y divide-separator">
              <RuleBand
                title={t('settings.permissions.judgeRules.hardDeny')}
                rules={policy.hardDeny}
              />
              <RuleBand
                title={t('settings.permissions.judgeRules.softDeny')}
                rules={policy.softDeny}
              />
              <RuleBand
                title={t('settings.permissions.judgeRules.environment')}
                rules={policy.environment}
              />
              <RuleBand
                title={t('settings.permissions.judgeRules.gatewayEnvironment')}
                rules={policy.gatewayEnvironment}
              />
              <div className={cn(settingsUI.cardPadding, 'space-y-1.5')}>
                {policy.classifyAllShell && (
                  <p className={settingsUI.description}>
                    {t('settings.permissions.judgeRules.classifyAllShell')}
                  </p>
                )}
                <p className={settingsUI.descriptionSmall}>
                  {t('settings.permissions.judgeRules.allowWithheld')}
                </p>
              </div>
            </div>
          )}
        </SettingsCard>
      )}
    </SettingsSection>
  )
}
