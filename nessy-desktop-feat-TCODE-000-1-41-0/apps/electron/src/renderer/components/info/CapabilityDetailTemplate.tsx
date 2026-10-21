/**
 * CapabilityDetailTemplate
 *
 * ONE common detail-page format for EVERY capability kind (skill / MCP / API /
 * folder source / plugin). The four COMMON sections render for every kind:
 *
 *   1. Hero      — icon tile + name + meta line (state pill, origin badge,
 *      tagline) + actions slot (+ UB14.48: a source's stored connection error,
 *      as an alert under it)
 *   2. Content   — the inset content panel (About / instructions / guide)
 *   3. Metadata  — Info_Table of allowlisted display fields
 *   4. Diagnostics — actionable, path-free diagnostics
 *
 * Placeholder-not-hidden principle: each common section ALWAYS renders. When
 * its data is absent it shows an explicit quiet placeholder, never a missing
 * section. Kind-specific sections (permission modes, MCP tools, API
 * permissions, plugin capabilities) slot in via `kindSections` — for U2/U3
 * they fill these; here they are placeholder stubs.
 *
 * This template is IPC-free: the app page (part 2) fetches the SafeCapability
 * detail + preview and passes the resolved props. The playground exercises it
 * with mock data.
 *
 * UB14.59 — the hero anatomy of v0.15.1's detail pages (`pages/SourceInfoPage.tsx`,
 * `components/automations/AutomationInfoPage.tsx`; our template keeps its own sections):
 * the name lives in the hero ONLY (the header carries no title, so it is never shown
 * twice), the header carries the page's "⋯" menu (`headerActions`, an `Info_HeaderMenu`
 * the page builds, or nothing at all), the state pill and the origin badge sit on the
 * hero's meta line before the tagline, and the page's buttons (Connect, update badges)
 * are the hero's `actions`.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle } from 'lucide-react'
import { Info_Alert } from './Info_Alert'
import { Info_Page } from './Info_Page'
import { Info_Section } from './Info_Section'
import { Info_StatePill, type StatePillTone } from './Info_StatePill'
import { Info_Table } from './Info_Table'
import { Info_TechnicalDetails } from './Info_TechnicalDetails'
import {
  CapabilityContentPanel,
  type CapabilityContentPanelProps,
} from './CapabilityContentPanel'
import { PluginOriginBadge } from '@/components/plugins/PluginOriginBadge'
import type {
  SafeCapabilityDiagnostic,
  SafeCapabilitySummary,
} from '@nessy-agent/shared/protocol/capabilities'
import type { SourceDisplayStatus } from '@/components/ui/source-status-indicator'

/** The hero's state pill: a tone and the plain-language label that names it (never colour alone). */
export interface CapabilityStatePill {
  tone: StatePillTone
  label: string
}

/**
 * UB14.59 — v0.15.1 `pages/SourceInfoPage.tsx` `getStatePill`, keyed on the verdict our pip already
 * derives (`capabilitySummaryConnectionStatus`, which reads UB14.48's stored `lastTestStatus`): the
 * pill and the avatar's pip can never disagree on the verdict, because both read the one status.
 *
 * UB12.75 — the pill reads it through `capabilitySummaryDisplayStatus`, which names a source the user
 * switched off `disabled` instead of rule 4's "Not Tested": the `off` tone the grey pip shows, with
 * upstream's own `sourcesList.statusDisabled` as the word (the Sources list's line 2 says the same).
 */
export function connectionStatePill(
  status: SourceDisplayStatus,
  t: (key: string) => string,
): CapabilityStatePill {
  switch (status) {
    case 'connected': return { tone: 'ok', label: t('sourcesList.statusConnected') }
    case 'needs_auth': return { tone: 'warn', label: t('sourcesList.statusAuthRequired') }
    case 'untested': return { tone: 'off', label: t('sourcesList.statusNotTested') }
    case 'local_disabled':
    case 'disabled': return { tone: 'off', label: t('sourcesList.statusDisabled') }
    default: return { tone: 'bad', label: t('sourcesList.statusDisconnected') }
  }
}

/** A metadata field rendered as an Info_Table row. */
export interface CapabilityMetadataField {
  label: string
  value: React.ReactNode
}

export interface CapabilityDetailTemplateProps {
  /** Path-free capability summary driving the hero + origin badge. */
  summary: SafeCapabilitySummary
  /** Display name (already resolved by the caller). */
  displayName: string
  /** Icon element for the hero tile (mock avatar in the playground). */
  avatar: React.ReactNode
  /** Hero actions, right of the name (e.g. Connect, update badges); the "⋯" menu is `headerActions`. */
  actions?: React.ReactNode
  /**
   * UB14.59 — the header's actions: the page's "⋯" menu, built with `Info_HeaderMenu` by the
   * page (v0.15.1 detail pages). Absent → the header carries no menu, never an empty one.
   */
  headerActions?: React.ReactNode
  /** UB14.59 — the connection state pill on the hero's meta line (a source's verdict). */
  statePill?: CapabilityStatePill
  /** Hero tagline; defaults to the summary's description (a source prefixes its type, v0.15.1). */
  tagline?: string | null
  /** Content/About panel state + payload (loaded/loading/error/empty). */
  content: CapabilityContentPanelProps
  /** Metadata rows; when empty a placeholder renders inside the section. */
  metadata?: CapabilityMetadataField[]
  /** Diagnostics; when empty a placeholder renders inside the section. */
  diagnostics?: SafeCapabilityDiagnostic[]
  /**
   * Kind-specific sections inserted between Content and Metadata. Each is a
   * fully-formed section (Info_Section wrapping its own body). U2/U3 fill
   * these per kind; absent = no extra sections (the common four still render).
   */
  kindSections?: React.ReactNode
  /** Page-level loading (before the summary resolves). */
  loading?: boolean
  /** Page-level error (summary fetch failed). */
  error?: string
}

function diagnosticToneClass(severity: SafeCapabilityDiagnostic['severity']): string | undefined {
  if (severity === 'error') return 'text-destructive'
  if (severity === 'warning') return 'text-info'
  return undefined
}

/**
 * `unavailableReason` is a server-composed FREE STRING, not a closed enum: it
 * is sometimes a coded reason (`'duplicates-builtin'`, `'source-disabled'`)
 * and sometimes an already-worded sentence (e.g. the dp-not-installed
 * diagnostic, or a plugin's own review-required copy) — so this map translates
 * the codes it recognizes and passes everything else through unchanged
 * (`'shadowed-by-mcp-precedence'` has none yet: `2026-07-29-deviation-unit-3.md`).
 */
const UNAVAILABLE_REASON_KEYS: Readonly<Record<string, string>> = {
  'duplicates-builtin': 'sourceInfo.unavailable.duplicatesBuiltin',
  'duplicates-endpoint': 'sourceInfo.unavailable.duplicatesEndpoint',
  // P3.218 — never the user's own OFF wording for a decision they cannot
  // change. Without an entry here the code falls through to `base = reason` two
  // functions below and the raw string `managed-denied` would be what a user
  // reads, which is why the map edit is part of the same commit as the stamp.
  'managed-denied': 'sourceInfo.unavailable.managedDenied',
  'source-disabled': 'sourceInfo.unavailable.sourceDisabled', // F1.499: the user's own OFF
}

/**
 * F2: the two dedup reasons above are each set by exactly one diagnostic code
 * (`resolver.ts`'s T4/T4b passes, same `capabilityKey` as this row), and that
 * diagnostic may carry `safeArgs.inertComponents` — the plugin's own
 * hooks/skills that referenced the now-inert server. `diagnostics` here is
 * already filtered to this capability server-side (`buildDetail` in
 * `capabilities.ts`), so a lookup by code is enough to find it.
 */
const DEDUP_DIAGNOSTIC_CODE_BY_REASON: Readonly<Record<string, string>> = {
  'duplicates-builtin': 'capability.dedup.builtin-identity',
  'duplicates-endpoint': 'capability.dedup.endpoint-identity',
}

/**
 * F3: unlike the dedup reasons above, `capability.mcp.unusable-wire-name`
 * never disables its capability or sets `unavailableReason` (`resolver.ts`'s
 * `diagnoseUnusableMcpWireNames` — it is a net for a mint defect the sanitizer
 * fix makes unreachable, not a new way for a server to go inert), so it has
 * no reason code to key `UNAVAILABLE_REASON_KEYS` off. Read directly off
 * `diagnostics` instead, same server-side pre-filtering as the map above.
 */
const UNUSABLE_WIRE_NAME_DIAGNOSTIC_CODE = 'capability.mcp.unusable-wire-name'

function unavailableReasonText(
  reason: string | undefined,
  diagnostics: SafeCapabilityDiagnostic[] | undefined,
  t: (key: string, options?: Record<string, unknown>) => string,
): string | undefined {
  if (!reason) {
    return diagnostics?.some(diagnostic => diagnostic.code === UNUSABLE_WIRE_NAME_DIAGNOSTIC_CODE)
      ? t('sourceInfo.unavailable.unusableWireName')
      : undefined
  }
  const key = UNAVAILABLE_REASON_KEYS[reason]
  const base = key ? t(key) : reason
  const diagnosticCode = DEDUP_DIAGNOSTIC_CODE_BY_REASON[reason]
  const inertComponents = diagnosticCode
    ? diagnostics?.find(diagnostic => diagnostic.code === diagnosticCode)?.safeArgs?.inertComponents
    : undefined
  return inertComponents
    // The reason strings deliberately carry no terminal punctuation (they are
    // also rendered alone), so the joint supplies the sentence boundary.
    ? `${base}. ${t('capabilityDetail.dedupInertComponents', { components: inertComponents })}`
    : base
}

export function CapabilityDetailTemplate({
  summary,
  displayName,
  avatar,
  actions,
  headerActions,
  statePill,
  tagline,
  content,
  metadata,
  diagnostics,
  kindSections,
  loading,
  error,
}: CapabilityDetailTemplateProps) {
  const { t } = useTranslation()

  // The meta line (v0.15.1 `Info_Page.Hero` `meta`): the state pill first, then where the
  // capability came from — both before the tagline on the same wrapping line.
  const meta = statePill || summary.presentation ? (
    <>
      {statePill && (
        <Info_StatePill tone={statePill.tone}>{statePill.label}</Info_StatePill>
      )}
      {summary.presentation && (
        <PluginOriginBadge presentation={summary.presentation} className="text-label-sm text-tertiary" />
      )}
    </>
  ) : undefined

  return (
    <Info_Page loading={loading} error={error}>
      {/* The name lives in the hero; the header carries the page's "⋯" menu, or nothing. */}
      <Info_Page.Header actions={headerActions} />
      {!loading && !error && (
        <Info_Page.Content>
          {/* 1. Hero — always present */}
          <Info_Page.Hero
            avatar={avatar}
            title={displayName}
            meta={meta}
            tagline={tagline !== undefined ? tagline : summary.description ?? null}
            actions={actions}
          />

          {/* UB14.48 — the connection error the source's last check stored (v0.15.1
              `SourceInfoPage.tsx`: a plain banner titled with the source's name, the raw text under
              Technical details). The text arrives already reduced by the host
              (`sanitizeStoredConnectionError`): no URL path or query, no absolute path, no
              recognised secret. The hero's `bad` state pill (UB14.59) names the same verdict. */}
          {summary.connectionError?.trim() && (
            <Info_Alert variant="error" icon={<AlertCircle />} data-testid="connection-error">
              <Info_Alert.Title>{t('sourceInfo.connectionErrorTitle', { name: displayName })}</Info_Alert.Title>
              <Info_TechnicalDetails className="mt-1.5">{summary.connectionError.trim()}</Info_TechnicalDetails>
            </Info_Alert>
          )}

          {/* 2. Content / About — always present (placeholder when empty) */}
          <Info_Section
            title={t('capabilityDetail.about')}
            description={summary.readOnly ? t('capabilityDetail.readOnly') : undefined}
          >
            {/* No wrapper padding: the panel pads each of its own states
                (p-3.5 / px-3.5, the info card inset) — doubling it read as an
                oversized inset (reviewer feedback 2026-07-19). */}
            <CapabilityContentPanel {...content} />
          </Info_Section>

          {/* 3. Kind-specific sections slot in here (U2/U3). */}
          {kindSections}

          {/* 4. Metadata — always present (placeholder when empty) */}
          <Info_Section title={t('capabilityDetail.metadata')} description={unavailableReasonText(summary.unavailableReason, diagnostics, t)}>
            {metadata && metadata.length > 0 ? (
              <Info_Table>
                {metadata.map((field, index) => (
                  // Index-qualified: server-controlled safeFields may repeat a label.
                  <Info_Table.Row key={`${field.label}:${index}`} label={field.label} value={field.value} />
                ))}
              </Info_Table>
            ) : (
              <p className="px-3.5 py-3 text-label text-tertiary" data-testid="metadata-empty">
                {t('capabilityDetail.noMetadata')}
              </p>
            )}
          </Info_Section>

          {/* 5. Diagnostics — always present (placeholder when empty) */}
          <Info_Section title={t('capabilityDetail.diagnostics')}>
            {diagnostics && diagnostics.length > 0 ? (
              <ul className="space-y-1 px-3.5 py-3 text-label text-tertiary">
                {diagnostics.map((diagnostic, index) => (
                  <li key={`${diagnostic.code}:${index}`} className={diagnosticToneClass(diagnostic.severity)}>
                    {/* `messageKey` is a key when one is localized and the bare
                        diagnostic code otherwise (`toSafeDiagnostic` sets
                        `messageKey = code` for every resolver diagnostic, none
                        of which has copy yet). `defaultValue` preserves that
                        code-as-text rendering unchanged while letting a caller
                        that DOES pass a real key — the plugin page's refused
                        components — render its sentence, interpolated from the
                        same path-free `safeArgs`. */}
                    {t(diagnostic.messageKey, {
                      defaultValue: diagnostic.messageKey,
                      ...(diagnostic.safeArgs ?? {}),
                    })}
                    {diagnostic.safeArgs?.names ? `: ${diagnostic.safeArgs.names}` : ''}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-3.5 py-3 text-label text-tertiary" data-testid="diagnostics-empty">
                {t('capabilityDetail.noDiagnostics')}
              </p>
            )}
          </Info_Section>
        </Info_Page.Content>
      )}
    </Info_Page>
  )
}
