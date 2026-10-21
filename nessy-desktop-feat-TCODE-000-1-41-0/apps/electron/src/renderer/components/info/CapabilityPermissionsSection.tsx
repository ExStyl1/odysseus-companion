/**
 * CapabilityPermissionsSection (U2)
 *
 * Source kind-specific section: a read-only pattern/access view of the source's
 * permission rules. Reference-style rows (access badge + monospace pattern),
 * driven by the path-free SafeCapabilityDetail.permissions projection.
 *
 * Placeholder-not-hidden (U1 principle): the section ALWAYS renders for a
 * source. When the source carries no captured permission rule (`permissions`
 * absent/empty) it shows a quiet in-section placeholder.
 *
 * IPC-free: consumes the already-fetched SafeCapabilityDetail projection.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Info_Section } from './Info_Section'
import { Info_StatusBadge } from './Info_StatusBadge'
import { Info_Badge } from './Info_Badge'
import type { SafeCapabilityDetail } from '@nessy-agent/shared/protocol/capabilities'

type PermissionRow = NonNullable<SafeCapabilityDetail['permissions']>[number]

export interface CapabilityPermissionsSectionProps {
  /** Projected permission rows; empty/undefined → placeholder. */
  permissions?: PermissionRow[]
}

export function CapabilityPermissionsSection({ permissions }: CapabilityPermissionsSectionProps) {
  const { t } = useTranslation()
  const hasRows = permissions && permissions.length > 0

  return (
    <Info_Section title={t('sourceInfo.permissions')}>
      {hasRows ? (
        <div className="py-1">
          {/* No inner frame: Info_Section provides the single surface layer
              (reviewer feedback 2026-07-19, same as the About panel). */}
          <div className="overflow-hidden">
            <table className="w-full text-label">
              <thead>
                {/* The data tables' header role (`INFO_TABLE_HEADER_CLASS` in Info_DataTable.tsx), UB14.59. */}
                <tr className="border-b border-subtle text-left text-label-sm text-tertiary">
                  <th className="w-[110px] px-3.5 py-2.5 font-medium">{t('table.access')}</th>
                  <th className="px-3.5 py-2.5 font-medium">{t('table.pattern')}</th>
                </tr>
              </thead>
              <tbody>
                {permissions.map((row, index) => (
                  <tr
                    key={`${row.access}:${row.pattern}:${index}`}
                    className={index < permissions.length - 1 ? 'border-b border-subtle' : undefined}
                    data-testid="permission-row"
                  >
                    <td className="px-3.5 py-2.5 align-top">
                      <Info_StatusBadge status={row.access} className="whitespace-nowrap" />
                    </td>
                    <td className="px-3.5 py-2.5">
                      <Info_Badge color="muted" className="break-all font-mono">{row.pattern}</Info_Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <p className="px-3.5 py-3 text-label text-tertiary" data-testid="permissions-empty">
          {t('table.noPermissionsConfigured')}
        </p>
      )}
    </Info_Section>
  )
}
