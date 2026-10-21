/**
 * UB6.5 — the pure half of the Settings > AI > Decision model card, extracted so the
 * usage-note and test-description wordings are testable without a DOM (upstream v0.15.1
 * keeps these inline in AiSettingsPage; the arms are the row's named tests: the usage
 * {withOutcome:30, changed:0} / boundary 29 / withOutcome:0 lines, the connected line,
 * and the honest failure line). Upstream v0.15.1
 * `apps/electron/src/renderer/pages/settings/AiSettingsPage.tsx`, Apache-2.0.
 */

import type { DecisionTestResult } from '@nessy-agent/shared/decisions'
import type { DecisionLayerFeature } from '@nessy-agent/shared/decisions/settings'
import type { DecisionToggleUsage } from '@nessy-agent/shared/decisions'

/** A feature must have had this many answered checks before "has not changed anything" is honest. */
export const DECISION_NO_CHANGE_MIN_CHECKS = 30

type TFunc = (key: string, opts?: Record<string, unknown>) => string

/** The per-toggle usage note, or undefined when the feature has no calls. */
export function decisionUsageNote(usage: DecisionToggleUsage | undefined, t: TFunc): string | undefined {
  if (!usage) return undefined
  if (usage.withOutcome === 0) return t('settings.ai.decisions.usageChecks', { calls: usage.calls, failures: usage.failures })
  const line = t('settings.ai.decisions.usageChanged', { calls: usage.calls, changed: usage.changed, failures: usage.failures })
  // Every extra call should earn its place: say so when a feature has had its chances and changed nothing.
  return usage.withOutcome >= DECISION_NO_CHANGE_MIN_CHECKS && usage.changed === 0 ? `${line} · ${t('settings.ai.decisions.usageNoChange')}` : line
}

/** The connection-test row's description: the canned line, the honest failure, or the connected line. */
export function decisionTestDescription(result: DecisionTestResult | null, t: TFunc): string {
  return result
    ? result.ok
      ? t('settings.ai.decisions.testSuccess', { model: result.model, latency: result.latencyMs })
      : t('settings.ai.decisions.testFailed', { message: result.failure.message })
    : t('settings.ai.decisions.testDesc')
}

/** One Advanced-settings toggle: the feature, its label/description and the tooltip naming what is sent. */
export interface DecisionFeatureRow {
  feature: DecisionLayerFeature
  label: string
  description: string
  tooltip: string
}

export interface DecisionFeatureGroup {
  id: string
  title: string
  toggles: DecisionFeatureRow[]
}

/**
 * The ADOPTED features only (B1 S1 / the UB6.5 Files line): upstream's guardedMode
 * (OQ-43.4 (a)) and adaptiveThinking groups are dropped, and largeResults joins only if
 * UB5.6's measurement takes UB6.16 — a new row there, never a silent one. Literal t()
 * keys keep the i18n coverage check effective.
 */
export function buildDecisionFeatureGroups(t: TFunc): DecisionFeatureGroup[] {
  return [
    { id: 'agent', title: t('settings.ai.decisions.groupAgent'), toggles: [
      { feature: 'decideTool', label: t('settings.ai.decisions.featureDecideTool'), description: t('settings.ai.decisions.featureDecideToolDesc'), tooltip: t('settings.ai.decisions.featureDecideToolTooltip') },
      { feature: 'suggestions', label: t('settings.ai.decisions.featureSuggestions'), description: t('settings.ai.decisions.featureSuggestionsDesc'), tooltip: t('settings.ai.decisions.featureSuggestionsTooltip') },
    ] },
    { id: 'conversation', title: t('settings.ai.decisions.groupConversation'), toggles: [
      { feature: 'midTurnMessages', label: t('settings.ai.decisions.featureMidTurnMessages'), description: t('settings.ai.decisions.featureMidTurnMessagesDesc'), tooltip: t('settings.ai.decisions.featureMidTurnMessagesTooltip') },
      { feature: 'turnOutcome', label: t('settings.ai.decisions.featureTurnOutcome'), description: t('settings.ai.decisions.featureTurnOutcomeDesc'), tooltip: t('settings.ai.decisions.featureTurnOutcomeTooltip') },
      { feature: 'smartTitles', label: t('settings.ai.decisions.featureSmartTitles'), description: t('settings.ai.decisions.featureSmartTitlesDesc'), tooltip: t('settings.ai.decisions.featureSmartTitlesTooltip') },
    ] },
    { id: 'permissions', title: t('settings.ai.decisions.groupPermissions'), toggles: [
      { feature: 'riskBadges', label: t('settings.ai.decisions.featureRiskBadges'), description: t('settings.ai.decisions.featureRiskBadgesDesc'), tooltip: t('settings.ai.decisions.featureRiskBadgesTooltip') },
    ] },
    { id: 'automations', title: t('settings.ai.decisions.groupAutomations'), toggles: [
      { feature: 'semanticLabels', label: t('settings.ai.decisions.featureSemanticLabels'), description: t('settings.ai.decisions.featureSemanticLabelsDesc'), tooltip: t('settings.ai.decisions.featureSemanticLabelsTooltip') },
      { feature: 'automationConditions', label: t('settings.ai.decisions.featureAutomationConditions'), description: t('settings.ai.decisions.featureAutomationConditionsDesc'), tooltip: t('settings.ai.decisions.featureAutomationConditionsTooltip') },
      { feature: 'taskVerdicts', label: t('settings.ai.decisions.featureTaskVerdicts'), description: t('settings.ai.decisions.featureTaskVerdictsDesc'), tooltip: t('settings.ai.decisions.featureTaskVerdictsTooltip') },
      { feature: 'taskRepairs', label: t('settings.ai.decisions.featureTaskRepairs'), description: t('settings.ai.decisions.featureTaskRepairsDesc'), tooltip: t('settings.ai.decisions.featureTaskRepairsTooltip') },
    ] },
  ]
}

/**
 * A remote server on an older version reports fewer features: show and count only what it
 * knows (upstream's filter, unchanged).
 */
export function filterReportedGroups(groups: DecisionFeatureGroup[], features: Partial<Record<DecisionLayerFeature, boolean>>): DecisionFeatureGroup[] {
  return groups
    .map(group => ({ ...group, toggles: group.toggles.filter(({ feature }) => feature in features) }))
    .filter(group => group.toggles.length > 0)
}
