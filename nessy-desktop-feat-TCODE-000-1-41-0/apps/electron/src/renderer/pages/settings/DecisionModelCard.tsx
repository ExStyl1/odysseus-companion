/**
 * UB6.5 — the Settings > AI > Decision model card (presentational).
 *
 * Ported ONCE from craft-agents-oss `v0.15.1:apps/electron/src/renderer/pages/settings/AiSettingsPage.tsx`
 * (the v0.15.0-restyled card; Apache-2.0) as a presentational component so the page wires
 * `window.electronAPI` into it and the playground/tests feed fixtures. UB6.5 shipped the card's
 * STRUCTURE and BEHAVIOUR (provider/key/Laya health/test/advanced toggles with the per-toggle
 * usage note and the tooltip naming what is sent); UB15.11 took v0.15.1's LOOK on top: every
 * button `secondary md`, the install hint and privacy note on `text-label-sm text-tertiary`,
 * the Advanced expander on `EXPANDER_ROW_CLASS` with an `AnimatedCollapsibleContent` body and
 * `border-subtle` hairlines between its groups.
 *
 * The adopted features only (see decision-model-shared.ts): no toggle for a dropped feature
 * ships. Every provider preset appears and the Laya install hint + docs link ship verbatim
 * (the owner's 2026-10-02 answer to OQ-43.2b: identical to craft agents).
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, Settings2 } from 'lucide-react'
// Direct files, not the settings barrel: the barrel's graph reaches pdfjs and the
// render test (and the playground entry) would pay for it (AGENTS.md barrel trap).
import { SettingsCard } from '@/components/settings/SettingsCard'
import { SettingsInput } from '@/components/settings/SettingsInput'
import { SettingsMenuSelectRow } from '@/components/settings/SettingsMenuSelect'
import { SettingsRow } from '@/components/settings/SettingsRow'
import { SettingsToggle } from '@/components/settings/SettingsToggle'
import { Button } from '@/components/ui/button'
import { settingsUI } from '@/components/settings/SettingsUIConstants'
// The subpath, not the `@nessy-agent/ui` barrel (UB13.9's export; the barrel trap above).
import { AnimatedCollapsibleContent } from '@nessy-agent/ui/ui/AnimatedCollapsibleContent'
import { cn } from '@/lib/utils'
import type {
  DecisionLayerStatus,
  DecisionServerProbe,
  DecisionTestResult,
  DecisionToggleUsage,
} from '@nessy-agent/shared/decisions'
import type { DecisionLayerSettingsPatch } from '@nessy-agent/shared/decisions/settings'
import {
  buildDecisionFeatureGroups,
  decisionTestDescription,
  decisionUsageNote,
  filterReportedGroups,
} from './decision-model-shared'

/**
 * Full-width row that expands a card in place (workspace overrides, decision Advanced settings).
 * v0.15.1 declares it in `AiSettingsPage.tsx`; it lives here because this card is the one module
 * both expanders can read without an import cycle (the page imports the card, never the reverse).
 */
export const EXPANDER_ROW_CLASS = cn(
  'w-full min-h-14 flex items-center justify-between gap-4 px-3.5 py-2.5 text-left -outline-offset-2',
  'transition-colors duration-micro ease-out-subtle hover:bg-fill-hover hover:duration-instant'
)

export interface DecisionModelCardProps {
  status: DecisionLayerStatus
  /** Per-toggle usage, loaded when Advanced opens (undefined = collapsed/not loaded). */
  usage: Partial<Record<string, DecisionToggleUsage>>
  testResult: DecisionTestResult | null
  testing: boolean
  probe: DecisionServerProbe | null
  probing: boolean
  advancedOpen: boolean
  onAdvancedOpenChange: (open: boolean) => void
  modelDraft: string
  baseUrlDraft: string
  keyDraft: string
  onModelDraftChange: (value: string) => void
  onBaseUrlDraftChange: (value: string) => void
  onKeyDraftChange: (value: string) => void
  onUpdate: (patch: DecisionLayerSettingsPatch) => void
  onCommitField: (field: 'model' | 'baseUrl', value: string) => void
  onKeySourceChange: (value: string) => void
  onSaveKey: () => void
  onRemoveKey: () => void
  onTest: () => void
  onProbe: (baseUrl?: string) => void
}

export function DecisionModelCard({
  status,
  usage,
  testResult,
  testing,
  probe,
  probing,
  advancedOpen,
  onAdvancedOpenChange,
  modelDraft,
  baseUrlDraft,
  keyDraft,
  onModelDraftChange,
  onBaseUrlDraftChange,
  onKeyDraftChange,
  onUpdate,
  onCommitField,
  onKeySourceChange,
  onSaveKey,
  onRemoveKey,
  onTest,
  onProbe,
}: DecisionModelCardProps) {
  const { t } = useTranslation()

  const preset = status.presets.find(p => p.id === status.settings.provider)
  const groups = React.useMemo(() => buildDecisionFeatureGroups(t), [t])
  // A remote server on an older version reports fewer features: show and count only what it knows.
  const reportedGroups = React.useMemo(
    () => filterReportedGroups(groups, status.settings.features),
    [groups, status.settings.features],
  )
  const reportedToggles = reportedGroups.flatMap(group => group.toggles)
  const featuresOn = reportedToggles.filter(({ feature }) => status.settings.features[feature]).length

  const keySourceValue = status.settings.connectionSlug
    ? `connection:${status.settings.connectionSlug}`
    : `provider:${status.settings.provider}`
  const keySourceOptions = [
    ...status.presets.map(p => ({
      value: `provider:${p.id}`,
      label: p.label,
      description: p.local
        ? (p.id === 'custom' ? t('settings.ai.decisions.customProviderDesc') : t('settings.ai.decisions.localProviderDesc'))
        : p.baseUrl,
    })),
    ...status.reusableConnections.map(c => ({
      value: `connection:${c.slug}`,
      label: t('settings.ai.decisions.reuseConnection', { name: c.name }),
      description: status.presets.find(p => p.id === c.provider)?.label ?? c.provider,
    })),
  ]

  const hasStoredKey = status.providersWithKey.includes(status.settings.provider)
  const keyHelpUrl = preset?.dashboardUrl ?? preset?.docsUrl
  const usesConnection = !!status.settings.connectionSlug
  // Local presets (Laya, custom) expose the base URL and a server probe instead of a key hint.
  const usesLocalProvider = !!preset?.local && !usesConnection
  const usesCustomProvider = status.settings.provider === 'custom' && !usesConnection

  const probeDescription = probing || (usesLocalProvider && !probe)
    ? t('common.checking')
    : probe?.reachable && probe.health
      ? t('settings.ai.decisions.localServerRunning', { url: probe.baseUrl, models: probe.health.loaded?.length ? probe.health.loaded.join(', ') : '—' })
      : probe?.reachable
        ? t('settings.ai.decisions.localServerReachable', { url: probe.baseUrl })
        : t('settings.ai.decisions.localServerUnreachable', { url: probe?.baseUrl ?? '' })
  const testDescription = decisionTestDescription(testResult, t)

  return (
    <>
      <SettingsCard>
        <SettingsToggle
          label={t('settings.ai.decisions.enable')}
          description={t('settings.ai.decisions.enableDesc')}
          checked={status.settings.enabled}
          onCheckedChange={(enabled) => { onUpdate({ enabled }) }}
        />
        <SettingsMenuSelectRow
          label={t('settings.ai.decisions.keySource')}
          description={t('settings.ai.decisions.keySourceDesc')}
          value={keySourceValue}
          onValueChange={onKeySourceChange}
          options={keySourceOptions}
          menuWidth={340}
        />
        {usesLocalProvider && (
          <SettingsInput
            inCard
            type="url"
            label={t('settings.ai.decisions.baseUrl')}
            description={usesCustomProvider ? t('settings.ai.decisions.baseUrlDesc') : t('settings.ai.decisions.baseUrlLocalDesc')}
            value={baseUrlDraft}
            onChange={onBaseUrlDraftChange}
            onBlur={() => onCommitField('baseUrl', baseUrlDraft)}
            placeholder={preset?.baseUrl || 'http://localhost:8080'}
          />
        )}
        {/* Row and install hint are one card child, so no hairline separates them */}
        {usesLocalProvider && (
          <div>
            <SettingsRow
              label={t('settings.ai.decisions.localServer')}
              description={probeDescription}
            >
              {preset?.docsUrl && (
                <Button size="md" onClick={() => { void window.electronAPI?.openUrl(preset.docsUrl!) }} variant="secondary">
                  {t('settings.ai.decisions.localServerDocs')}
                </Button>
              )}
              <Button
                size="md"
                onClick={() => { onProbe(baseUrlDraft.trim() || undefined) }}
                disabled={probing}
                variant="secondary"
              >
                {probing ? t('common.checking') : t('settings.ai.decisions.recheck')}
              </Button>
            </SettingsRow>
            {preset?.installHint && probe && !probe.reachable && (
              <p className="-mt-1 px-3.5 pb-3 text-label-sm text-tertiary">
                {t('settings.ai.decisions.localServerInstallHint')}{' '}
                <code className="select-all font-mono text-mono-ui text-secondary">{preset.installHint}</code>
              </p>
            )}
          </div>
        )}
        {!usesConnection && (
          hasStoredKey ? (
            <SettingsRow
              label={t('settings.ai.decisions.apiKey')}
              description={t('settings.ai.decisions.apiKeySaved')}
            >
              <Button size="md" onClick={onRemoveKey} variant="secondary">
                {t('settings.ai.decisions.removeKey')}
              </Button>
            </SettingsRow>
          ) : (
            <SettingsInput
              inCard
              type="password"
              label={t('settings.ai.decisions.apiKey')}
              description={keyHelpUrl
                ? t('settings.ai.decisions.apiKeyDesc', { url: keyHelpUrl })
                : t('settings.ai.decisions.apiKeyDescGeneric')}
              value={keyDraft}
              onChange={onKeyDraftChange}
              placeholder={preset?.keyPlaceholder}
              action={(
                <Button size="md" onClick={onSaveKey} disabled={!keyDraft.trim()} variant="secondary">
                  {t('settings.ai.decisions.saveKey')}
                </Button>
              )}
            />
          )
        )}
        <SettingsInput
          inCard
          label={t('settings.ai.decisions.model')}
          description={t('settings.ai.decisions.modelDesc')}
          value={modelDraft}
          onChange={onModelDraftChange}
          onBlur={() => onCommitField('model', modelDraft)}
          placeholder={preset?.defaultModel}
        />
        {/* The privacy note belongs to the test row: one card child, no hairline between */}
        <div>
          <SettingsRow
            label={t('settings.ai.decisions.test')}
            description={testDescription}
          >
            <Button size="md" onClick={onTest} disabled={testing} variant="secondary">
              {testing ? t('common.checking') : t('settings.ai.decisions.testRun')}
            </Button>
          </SettingsRow>
          <p className="-mt-1 px-3.5 pb-3.5 text-label-sm text-tertiary">
            {t('settings.ai.decisions.privacyNote')}
          </p>
        </div>
      </SettingsCard>

      {/* Advanced settings: what the decision model is used for, collapsed by default.
          The toggles expand inside the card; each tooltip names what is sent. */}
      <SettingsCard divided={false}>
        <button
          type="button"
          aria-expanded={advancedOpen}
          onClick={() => onAdvancedOpenChange(!advancedOpen)}
          className={EXPANDER_ROW_CLASS}
        >
          <div className="flex min-w-0 items-center gap-3">
            <div className="size-6 shrink-0 rounded-full bg-fill-hover ring-1 ring-border flex items-center justify-center">
              <Settings2 className="size-3.5 text-tertiary" aria-hidden />
            </div>
            <div className="min-w-0 text-left">
              <div className={settingsUI.label}>{t('settings.ai.decisions.advanced')}</div>
              <div className={settingsUI.description}>
                {status.settings.enabled
                  ? t('settings.ai.decisions.advancedSummary', { on: featuresOn, total: reportedToggles.length })
                  : t('settings.ai.decisions.advancedSummaryOff')}
              </div>
            </div>
          </div>
          {advancedOpen ? (
            <ChevronDown className="size-4 shrink-0 text-tertiary" aria-hidden />
          ) : (
            <ChevronRight className="size-4 shrink-0 text-tertiary" aria-hidden />
          )}
        </button>

        {/* Expands in place: content swaps once, fades with a 4px drop (no height animation) */}
        <AnimatedCollapsibleContent isOpen={advancedOpen}>
          <div className="border-t border-subtle">
            {reportedGroups.map((group, index) => (
              <div key={group.id} className={cn(index > 0 && 'border-t border-subtle')}>
                <div className="px-3.5 pt-3 pb-0.5 text-label-sm font-medium text-tertiary">
                  {group.title}
                </div>
                {group.toggles.map(({ feature, label, description, tooltip }) => (
                  <SettingsToggle
                    key={feature}
                    label={label}
                    description={description}
                    tooltip={tooltip}
                    note={decisionUsageNote(usage[feature], t)}
                    checked={status.settings.features[feature] ?? false}
                    disabled={!status.settings.enabled}
                    onCheckedChange={(checked) => { onUpdate({ features: { [feature]: checked } }) }}
                  />
                ))}
              </div>
            ))}
          </div>
        </AnimatedCollapsibleContent>
      </SettingsCard>
    </>
  )
}
