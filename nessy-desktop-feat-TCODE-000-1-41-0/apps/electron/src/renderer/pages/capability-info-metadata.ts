/**
 * Pure metadata-row builders for the skill/source detail pages (U1).
 *
 * Extracted so the "nothing currently displayed may disappear" invariant is
 * testable without a DOM: every field the pre-U1 pages rendered in their
 * connection/metadata tables — kind/type, scope, status, connector origin +
 * auth timing, and the server-provided `safeFields` — is mapped here into the
 * CapabilityDetailTemplate's `metadata` rows.
 */

import { createElement } from 'react'
import type { SafeCapabilityDetail } from '@nessy-agent/shared/protocol/capabilities'
import type { CapabilityMetadataField } from '@/components/info'

/** i18n `t` with interpolation, kept structural so tests can pass a stub. */
type Translate = (key: string, options?: Record<string, unknown>) => string

export function buildSkillMetadata(detail: SafeCapabilityDetail, t: Translate): CapabilityMetadataField[] {
  const { summary } = detail
  return [
    // UB14.59 — v0.15.1 `pages/SkillInfoPage.tsx`'s slug row, first and in mono: the skill's logical
    // name is the id a user types (`/name`, `@name`), which the hero's display name may not be.
    { label: t('common.slug'), value: createElement('span', { className: 'font-mono text-mono-ui' }, summary.logicalName) },
    { label: t('common.type'), value: summary.kind },
    { label: t('skillInfo.scope'), value: summary.scope.kind },
    { label: t('sessionMenu.status'), value: summary.state },
    ...detail.safeFields.map((field) => ({ label: field.label, value: field.value })),
  ]
}

export function buildSourceMetadata(detail: SafeCapabilityDetail, t: Translate): CapabilityMetadataField[] {
  const { summary } = detail
  const rows: CapabilityMetadataField[] = [
    { label: t('common.type'), value: (summary.sourceType ?? summary.kind).toUpperCase() },
    { label: t('sourceInfo.scope'), value: summary.scope.kind },
    { label: t('sessionMenu.status'), value: summary.state },
  ]
  if (summary.connectorOrigin) {
    rows.push({
      label: t('sourceInfo.connector'),
      value: t('sourceInfo.connectorProvidedBy', { connector: summary.connectorOrigin.connectorId }),
    })
  }
  if (summary.connectorOrigin?.authTiming) {
    rows.push({
      label: t('sourceInfo.connectorAuthTiming'),
      value: summary.connectorOrigin.authTiming === 'ON_INSTALL'
        ? t('sourceInfo.connectorAuthOnInstall')
        : t('sourceInfo.connectorAuthOnFirstUse'),
    })
  }
  for (const field of detail.safeFields) {
    rows.push({ label: field.label, value: field.value })
  }
  return rows
}
