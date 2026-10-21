/**
 * Source: v0.15.1:apps/electron/src/renderer/components/settings/SettingsRow.tsx (UB15.1; merged: upstream's row with its always-wrap description, `wrapDescription` kept as a deprecated no-op, `SettingsRowLabel` not taken).
 */
/**
 * SettingsRow
 *
 * Generic row component for settings with label on left and content on right.
 * Use for custom layouts that don't fit Toggle/Select patterns.
 *
 * The description ALWAYS wraps (v0.15.1, `[overflow-wrap:anywhere]` so an unbroken path breaks
 * instead of overflowing). That supersedes our truncating default and its `wrapDescription`
 * opt-in (P6.1004, D1.101, D1.213) under the owner's "settings 1:1" rule (2026-10-14); the prop
 * survives as a deprecated no-op. `SettingsRowLabel`, which upstream still ships here, stays
 * deleted (D1.102: zero call sites, and adopting it would drop the siblings' `htmlFor`).
 */

import * as React from 'react'
import { cn } from '@/lib/utils'
import { settingsUI } from './SettingsUIConstants'

export interface SettingsRowProps {
  /** Row label (can be string or JSX for custom rendering) */
  label: React.ReactNode
  /** Optional description below label */
  description?: string
  /** Content on the right side */
  children?: React.ReactNode
  /** Click handler for the entire row */
  onClick?: () => void
  /** Optional action button (e.g., "Change" button) */
  action?: React.ReactNode
  /** Additional className */
  className?: string
  /** Whether the row is inside a card (affects padding) */
  inCard?: boolean
  /**
   * @deprecated No-op since UB15.1: every description wraps (v0.15.1), so the opt-in that
   * P6.1004 / D1.213 added for value rows has nothing left to switch. Kept so the call sites
   * that still pass it compile until their page rows (UB15.6, UB15.11) drop it.
   */
  wrapDescription?: boolean
}

/**
 * SettingsRow - Generic row for custom settings layouts
 *
 * @example
 * <SettingsRow
 *   label="Working Directory"
 *   description="~/Documents"
 *   action={<Button variant="ghost" size="sm">Change</Button>}
 * />
 */
export function SettingsRow({
  label,
  description,
  children,
  onClick,
  action,
  className,
  inCard = true,
}: SettingsRowProps) {
  const Component = onClick ? 'button' : 'div'

  return (
    <Component
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      data-layout="settings-row"
      className={cn(
        'w-full flex items-center justify-between text-left',
        inCard ? settingsUI.row : settingsUI.rowBare,
        onClick && 'cursor-pointer -outline-offset-2 transition-colors duration-micro ease-out-subtle hover:bg-fill-hover hover:duration-instant active:bg-fill-pressed',
        className
      )}
    >
      <div className="flex-1 min-w-0">
        <div className={settingsUI.label}>{label}</div>
        {description && (
          // Descriptions wrap (long paths break anywhere) instead of truncating
          <div className={cn(settingsUI.description, settingsUI.labelDescriptionGap, '[overflow-wrap:anywhere]')}>
            {description}
          </div>
        )}
      </div>
      {(children || action) && (
        <div data-layout="settings-control" className="flex items-center gap-2 shrink-0">
          {children}
          {action}
        </div>
      )}
    </Component>
  )
}
