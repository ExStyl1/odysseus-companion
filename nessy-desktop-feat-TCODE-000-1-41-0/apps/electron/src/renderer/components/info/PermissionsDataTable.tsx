/**
 * Source: ours (P3.351, P6.209) with the restyle of
 * v0.15.1:apps/electron/src/renderer/components/info/PermissionsDataTable.tsx re-applied by
 * UB14.58: the header classes, the pattern chip, the comment on the role type and
 * `Info_FullscreenButton`. Our `unenforceable` / `UnenforceableStyle` / `AccessCell` /
 * `CommentCell` are kept (the note moves onto the role type only). Apache-2.0, LICENSE and
 * NOTICE kept.
 * UB12.86, 2026-10-17: kept ours over v0.15.1 — with no `fullscreenTitle` the overlay title reads
 * `settings.permissions.title` (v0.15.1 defaults it to an English literal).
 */
/**
 * PermissionsDataTable
 *
 * Typed Data Table for displaying source permissions.
 * Features: searchable patterns, sortable columns, max-height scroll, fullscreen view.
 */

import * as React from 'react'
import { useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { ColumnDef } from '@tanstack/react-table'
import { Info_DataTable, SortableHeader, INFO_TABLE_HEADER_CLASS, INFO_TABLE_SORTABLE_HEADER_CLASS } from './Info_DataTable'
import { Info_Badge } from './Info_Badge'
import { Info_StatusBadge } from './Info_StatusBadge'
import { Info_FullscreenButton } from './Info_FullscreenButton'
import { Tooltip, TooltipTrigger, TooltipContent } from '@nessy-agent/ui'
import { DataTableOverlay } from '@nessy-agent/ui'
import { cn } from '@/lib/utils'
import { useTheme } from '@/hooks/useTheme'
import { toast } from 'sonner'

export type PermissionAccess = 'allowed' | 'blocked'
export type PermissionType = 'tool' | 'bash' | 'api' | 'mcp'

export interface PermissionRow {
  access: PermissionAccess
  type: PermissionType
  pattern: string
  comment?: string | null
  /**
   * P3.351 — this row states an access the runtime does not actually apply, and
   * this is the sentence saying so. Rendered VERBATIM, the same rule
   * `IsolationNetworkPosture` follows for its own `unenforceable` lines: the
   * classification is made where the decision is made
   * (`agent/blocked-tools-enforcement.ts` over `ALWAYS_ALLOWED_TOOLS`), and a
   * table that re-worded it would be stating a second truth about what binds.
   *
   * WIRED 2026-09-04: `PermissionsSettingsPage` fills it for every declared
   * `blockedTools` entry and renders the workspace table with
   * `unenforceableStyle="annotate"`. Every OTHER caller still passes rows
   * without it, and a row without it is untouched — so opting in stays per
   * table.
   *
   * P6.209 WIDENED WHAT "does not apply" MEANS, and the distinction is worth
   * keeping straight. There are now TWO reasons a row can carry this sentence:
   *
   * 1. **Pre-empted** (P3.351): an earlier branch of the gate decides first, so
   *    the access the row claims is never applied by anyone.
   * 2. **Already granted by a scope applied earlier** (P6.209): the access IS
   *    applied — just not because of this row. The merge is additive, so a
   *    workspace pattern the app defaults already carry contributes nothing and
   *    deleting it changes no verdict.
   *
   * Both are "this row does not do what it appears to do", which is why they
   * share the field, and both are rendered verbatim by the same rule. A caller
   * filling this must say WHICH — a sentence that only said "inert" would leave
   * a user unable to tell a defect from a duplicate.
   *
   * The other treatments remain drawn in
   * `playground/registry/settings-blocked-tools.tsx` (plan row P4.10), because
   * `annotate` is a default and not a closed question.
   */
  unenforceable?: string | null
}

/**
 * How a row carrying {@link PermissionRow.unenforceable} is shown.
 *
 * The knob exists because the choice is a product call, not a derivation, and
 * the two halves are separable: `grey` withdraws the access CLAIM without
 * explaining it, `annotate` explains it while leaving the claim standing, and
 * `both` does what the settings page would ship. A surface that wants the rows
 * gone entirely filters them before passing `data` — there is nothing to
 * configure here for that.
 */
export type UnenforceableStyle = 'grey' | 'annotate' | 'both'

interface PermissionsDataTableProps {
  data: PermissionRow[]
  /** Hide the type column (for MCP sources that only show pattern/comment) */
  hideTypeColumn?: boolean
  /** How rows carrying `unenforceable` are shown. Ignored by rows without it. */
  unenforceableStyle?: UnenforceableStyle
  /** Show search input */
  searchable?: boolean
  /** Max height with scroll */
  maxHeight?: number
  /** Enable fullscreen button (shows Maximize2 icon on hover) */
  fullscreen?: boolean
  /** Title for the fullscreen overlay header (default: `settings.permissions.title`) */
  fullscreenTitle?: string
  className?: string
}

/**
 * PatternBadge - Clickable pattern badge with truncation and tooltip
 * - Dynamic width with max-width of 240px
 * - CSS truncation via text-ellipsis
 * - Tooltip shows full pattern on hover (only for patterns 30+ chars)
 * - Click to copy pattern to clipboard with toast notification
 */
function PatternBadge({ pattern }: { pattern: string }) {
  const { t } = useTranslation()
  const handleClick = async () => {
    try {
      await navigator.clipboard.writeText(pattern)
      toast.success(t('toast.patternCopied'))
    } catch {
      toast.error(t('toast.failedToCopyPattern'))
    }
  }

  const badge = (
    <button type="button" onClick={handleClick} className="-my-0.5 rounded-xs py-0.5 text-left">
      <Info_Badge color="muted" className="font-mono font-normal select-none">
        <span className="block overflow-hidden whitespace-nowrap text-ellipsis max-w-[240px]">
          {pattern}
        </span>
      </Info_Badge>
    </button>
  )

  // Only show tooltip for longer patterns (30+ chars)
  if (pattern.length >= 30) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{badge}</TooltipTrigger>
        <TooltipContent className="font-mono max-w-md break-all">{pattern}</TooltipContent>
      </Tooltip>
    )
  }

  return badge
}

/**
 * The access cell, shared by both column sets.
 *
 * A row whose declaration nothing enforces keeps its place in the table — the
 * user wrote it and has to be able to find it — but stops wearing the
 * destructive BLOCKED badge, which is the claim that was false.
 */
function AccessCell({ row, style }: { row: PermissionRow; style: UnenforceableStyle }) {
  const { t } = useTranslation()
  const withdrawn = Boolean(row.unenforceable) && style !== 'annotate'
  return (
    <div className={cn('p-1.5 pl-2.5', withdrawn && 'opacity-60')}>
      {withdrawn ? (
        <Info_Badge color="default" className="whitespace-nowrap">
          {t('settings.permissions.blockedToolsUnenforcedBadge')}
        </Info_Badge>
      ) : (
        <Info_StatusBadge status={row.access} className="whitespace-nowrap" />
      )}
    </div>
  )
}

/** The comment cell, shared by both column sets. */
function CommentCell({ row, style }: { row: PermissionRow; style: UnenforceableStyle }) {
  const note = style === 'grey' ? null : row.unenforceable
  return (
    <div className="p-1.5 pl-2.5 min-w-0">
      <span className="truncate block text-label text-secondary">
        {row.comment || '—'}
      </span>
      {note ? (
        <span className="block text-label-sm text-tertiary leading-relaxed">{note}</span>
      ) : null}
    </div>
  )
}

// Column definitions with sorting
function getColumnsWithType(t: TFunction, unenforceableStyle: UnenforceableStyle): ColumnDef<PermissionRow>[] {
  return [
    {
      accessorKey: 'access',
      header: ({ column }) => <SortableHeader column={column} title={t("table.access")} className={INFO_TABLE_SORTABLE_HEADER_CLASS} />,
      cell: ({ row }) => <AccessCell row={row.original} style={unenforceableStyle} />,
      minSize: 80,
    },
    {
      accessorKey: 'type',
      header: ({ column }) => <SortableHeader column={column} title={t("common.type")} className={INFO_TABLE_SORTABLE_HEADER_CLASS} />,
      cell: ({ row }) => (
        <div className="p-1.5 pl-2.5">
          <Info_Badge color="default" className="capitalize whitespace-nowrap">
            {row.original.type}
          </Info_Badge>
        </div>
      ),
      minSize: 80,
    },
    {
      accessorKey: 'pattern',
      header: ({ column }) => <SortableHeader column={column} title={t("table.pattern")} className={INFO_TABLE_SORTABLE_HEADER_CLASS} />,
      cell: ({ row }) => (
        <div className="p-1.5 pl-2.5">
          <PatternBadge pattern={row.original.pattern} />
        </div>
      ),
      minSize: 100,
    },
    {
      id: 'comment',
      accessorKey: 'comment',
      header: () => <span className={cn("p-1.5 pl-2.5", INFO_TABLE_HEADER_CLASS)}>{t("table.comment")}</span>,
      cell: ({ row }) => <CommentCell row={row.original} style={unenforceableStyle} />,
      meta: { fillWidth: true, truncate: true },
    },
  ]
}

function getColumnsWithoutType(t: TFunction, unenforceableStyle: UnenforceableStyle): ColumnDef<PermissionRow>[] {
  return [
    {
      accessorKey: 'access',
      header: ({ column }) => <SortableHeader column={column} title={t("table.access")} className={INFO_TABLE_SORTABLE_HEADER_CLASS} />,
      cell: ({ row }) => <AccessCell row={row.original} style={unenforceableStyle} />,
      minSize: 80,
    },
    {
      accessorKey: 'pattern',
      header: ({ column }) => <SortableHeader column={column} title={t("table.pattern")} className={INFO_TABLE_SORTABLE_HEADER_CLASS} />,
      cell: ({ row }) => (
        <div className="p-1.5 pl-2.5">
          <PatternBadge pattern={row.original.pattern} />
        </div>
      ),
      minSize: 100,
    },
    {
      id: 'comment',
      accessorKey: 'comment',
      header: () => <span className={cn("p-1.5 pl-2.5", INFO_TABLE_HEADER_CLASS)}>{t("table.comment")}</span>,
      cell: ({ row }) => <CommentCell row={row.original} style={unenforceableStyle} />,
      meta: { fillWidth: true, truncate: true },
    },
  ]
}

export function PermissionsDataTable({
  data,
  hideTypeColumn = false,
  unenforceableStyle = 'both',
  searchable = false,
  maxHeight = 400,
  fullscreen = false,
  fullscreenTitle,
  className,
}: PermissionsDataTableProps) {
  const { t } = useTranslation()
  const [isFullscreen, setIsFullscreen] = useState(false)
  const { isDark } = useTheme()
  const columnsWithType = useMemo(() => getColumnsWithType(t, unenforceableStyle), [t, unenforceableStyle])
  const columnsWithoutType = useMemo(() => getColumnsWithoutType(t, unenforceableStyle), [t, unenforceableStyle])
  const columns = hideTypeColumn ? columnsWithoutType : columnsWithType

  // Fullscreen button for toolbar - shown on hover
  const fullscreenButton = fullscreen ? (
    <Info_FullscreenButton onClick={() => setIsFullscreen(true)} />
  ) : undefined

  return (
    <>
      <Info_DataTable
        columns={columns}
        data={data}
        searchable={searchable ? { placeholder: t("table.searchPatterns") } : false}
        maxHeight={maxHeight}
        emptyContent={t("table.noPermissionsConfigured")}
        floatingAction={fullscreenButton}
        className={cn(fullscreen && 'group', className)}
      />

      {/* Fullscreen overlay - renders the table without scroll constraints */}
      {fullscreen && (
        <DataTableOverlay
          isOpen={isFullscreen}
          onClose={() => setIsFullscreen(false)}
          title={fullscreenTitle ?? t('settings.permissions.title')}
          subtitle={t("table.ruleCount", { count: data.length })}
          theme={isDark ? 'dark' : 'light'}
        >
          <Info_DataTable
            columns={columns}
            data={data}
            searchable={searchable ? { placeholder: t("table.searchPatterns") } : false}
            emptyContent={t("table.noPermissionsConfigured")}
          />
        </DataTableOverlay>
      )}
    </>
  )
}
