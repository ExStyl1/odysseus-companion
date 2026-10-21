/**
 * SourcesManagementRowList (U4)
 *
 * The list body the future `sourcesPlugins` sub-route renders: installed
 * plugins (and, more generally, any management-panel rows) as
 * SourcesManagementRow rows — the same EntityRow column the real Sources
 * panel renders (owner feedback 2026-07-19), with hairline separators between
 * rows and the house Empty screen when nothing is installed.
 *
 * Placeholder-not-hidden (U1 principle): an empty list renders an explicit
 * "no plugins installed" placeholder — the section never disappears.
 *
 * IPC-free + callback-driven so the playground + tests drive it directly.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Boxes } from 'lucide-react'
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import {
  SourcesManagementRow,
  type SourcesManagementRowProps,
} from './SourcesManagementRow'

/** One entry in the list: the row props plus a stable key. */
export interface SourcesManagementRowEntry extends SourcesManagementRowProps {
  /** Stable list key (capability/plugin key). */
  id: string
}

export interface SourcesManagementRowListProps {
  /**
   * Optional panel heading. OMITTED by the Plugins subsection since
   * 2026-08-01: no other Sources subsection carries a title + blurb above its
   * rows, and that header ("Plugins" / "Installed plugins and their
   * components.") was half of what made the subsection read as its own screen.
   * The nav item beside the list already names it.
   */
  title?: string
  /** Optional description under the title; rendered only alongside a title. */
  description?: string
  /** Optional right-aligned header actions. */
  actions?: React.ReactNode
  /** The rows to render; empty → the empty-state placeholder. */
  rows: SourcesManagementRowEntry[]
  /**
   * Empty-state copy override. Defaults to the plugins-subsection message
   * ("No plugins installed."); a non-plugin list can pass its own.
   */
  emptyMessage?: string
  /**
   * The `id` of the row whose detail page is open, highlighted the way every
   * sibling list highlights its open row. Same contract as `EntityPanel`'s
   * `selectedId` (`SourcesListPanel` passes `selectedSourceSlug` into it) —
   * named and shaped alike on purpose, since the two are the same idea one
   * subsection apart. `null`/omitted → nothing highlighted.
   */
  selectedId?: string | null
}

export function SourcesManagementRowList({
  title,
  description,
  actions,
  rows,
  emptyMessage,
  selectedId,
}: SourcesManagementRowListProps) {
  const { t } = useTranslation()

  return (
    <div className="flex flex-col min-h-0">
      {(title || actions) && (
        <div className="flex items-start justify-between gap-2 px-4 pt-3 pb-1.5">
          <div className="min-w-0">
            {title && <h3 className="text-label font-medium text-foreground">{title}</h3>}
            {title && description && <p className="mt-0.5 text-label-sm text-tertiary">{description}</p>}
          </div>
          {actions && <div className="shrink-0">{actions}</div>}
        </div>
      )}
      {rows.length === 0 ? (
        <div data-testid="sources-management-empty">
          <Empty className="flex-1 py-10">
            <EmptyHeader>
              <EmptyMedia variant="icon"><Boxes /></EmptyMedia>
              <EmptyTitle>{emptyMessage ?? t('sourcesManagement.noPluginsInstalled')}</EmptyTitle>
            </EmptyHeader>
          </Empty>
        </div>
      ) : (
        <div className="flex flex-col">
          {rows.map((row, index) => {
            const { id, ...rowProps } = row
            return (
              <SourcesManagementRow
                key={id}
                {...rowProps}
                // Owned by the list, exactly like `showSeparator` below: a row
                // cannot know whether it is the open one, and no caller sets
                // either per entry.
                isSelected={selectedId != null && id === selectedId}
                showSeparator={index > 0}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}
