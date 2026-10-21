/**
 * The ONE Sources card (owner decisions 2026-08-01), on v0.15.1's row anatomy.
 *
 * The card is four things and nothing else: the status-bearing icon, the name,
 * ONE category, and the description. Provenance (`presentation`, a second
 * "Plugin" label, the acquisition pill) is deliberately absent: every caller
 * hands the card its whole row, so the absence is a choice this file makes
 * rather than a missing input, and a regression that puts it back is a change
 * to this file.
 *
 * There is NO extension slot, deliberately. An `extras` prop once sat beside
 * the category as "the one sanctioned way a row carries MORE", and the MCP
 * subsection was its only user — which is how that subsection ended up with four
 * badges where the aggregate list had one. The owner NARROWED that ruling on
 * 2026-08-01: the licence to carry more covers CONTROLS (a switch, a state
 * area — both live in the row's own `overlay`, not here), never more CONTENT.
 *
 * ## The anatomy ({@link sourceCardSlots}, UB14.57 + UB12.74)
 *
 * Upstream v0.15.1 (`SourcesListPanel.tsx`) moved the list row off the badge
 * row: the TYPE is the title line's trailing meta (tertiary text, replaced by
 * the "⋯" on hover), the DESCRIPTION is line 2, and a state other than
 * connected REPLACES the description on line 2 in its status colour, the stored
 * connection error as its tooltip. The owner's 2026-10-14 ruling takes the
 * redesign 1:1, and the 2026-08-01 card keeps its CONTENT on it: ONE category
 * (now the meta, never plural, never absent) and the description (now line 2).
 *
 * UB14.57 put the aggregate Sources list (and its APIs / Local Folders / Skills
 * filters) on these slots; UB12.74 put the three subsections whose rows carry a
 * control at the right edge on them too — MCPs (`McpServersPanel`), Plugins
 * (`SourcesManagementRow`) and Hooks (`ProjectHooksPanel`) — and RETIRED the
 * coloured category badge with its description strip, so the same server reads
 * the same one click apart again. Each of those rows states its own condition
 * (an outstanding sign-in, a failed enable, an update) on line 2 the way the
 * aggregate states a connection verdict: in place of the description. The
 * file keeps its historical name.
 */

import { skillRussianDescription } from '@/lib/odysseus-skills'
import * as React from 'react'
// The tooltip SUBPATH, never the barrel (P6.837, `source-status-indicator.tsx`): this module must stay
// loadable under `bun test`, and it carries its own `TooltipProvider` (P6.681) so line 2 renders under any host.
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@nessy-agent/ui/ui/tooltip'
import type { SafeCapabilitySummary } from '@nessy-agent/shared/protocol/capabilities'
import { capabilitySummaryDisplayStatus, type SourceDisplayStatus } from '@/components/ui/source-status-indicator'
import { cn } from '@/lib/utils'
import { SOURCE_CATEGORY_BADGE, sourceCategoryFor, type SourceCardRow } from '@/lib/source-card'

/**
 * The description on line 2. Its own component so every subsection truncates the
 * same way — the MCP row's `truncate` span, which is what the owner pointed at.
 */
export function SourceCardDescription({ description }: { description?: string }) {
  if (!description) return null
  return <span className="truncate" data-testid="source-card-description">{description}</span>
}

/**
 * v0.15.1 `SourcesListPanel.tsx` `SOURCE_STATUS_CONFIG`, verbatim: a state other than connected replaces the
 * description on line 2, in its status colour (the same five statuses the pip and the detail page's state
 * pill read, so every surface agrees).
 *
 * UB12.75 adds ONE entry upstream has no row for: `disabled`, a source the user switched off, which our wider
 * `untested` bucket used to print as "Not Tested". It reuses upstream's own `sourcesList.statusDisabled` and
 * `local_disabled`'s colour ({@link capabilitySummaryDisplayStatus} says why and what it does not cover).
 */
export const SOURCE_ROW_STATUS: Record<SourceDisplayStatus, { labelKey: string; textClass: string } | null> = {
  connected: null,
  needs_auth: { labelKey: 'sourcesList.statusAuthRequired', textClass: 'text-info' },
  failed: { labelKey: 'sourcesList.statusDisconnected', textClass: 'text-destructive' },
  untested: { labelKey: 'sourcesList.statusNotTested', textClass: 'text-tertiary' },
  local_disabled: { labelKey: 'sourcesList.statusDisabled', textClass: 'text-tertiary' },
  disabled: { labelKey: 'sourcesList.statusDisabled', textClass: 'text-tertiary' },
}

/** A source row's connection verdict and the stored reason beside it (UB14.48's `connectionError`). */
export interface SourceCardConnection {
  status: SourceDisplayStatus
  error?: string
}

/**
 * The verdict a Sources list row shows: the shared {@link capabilitySummaryDisplayStatus} (the detail pill's; the
 * pip's verdict with UB12.75's `disabled` split out), with P6.769's `localMcpEnabled`, and the reduced reason the
 * host stored beside it.
 */
export function sourceRowConnection(
  source: Pick<SafeCapabilitySummary, 'state' | 'credentialState' | 'mcpTransport' | 'lastTestStatus' | 'connectionError'>,
  localMcpEnabled: boolean,
): SourceCardConnection {
  return { status: capabilitySummaryDisplayStatus(source, localMcpEnabled), error: source.connectionError?.trim() || undefined }
}

/** The `EntityRow` slots one card fills: the category as title meta, line 2 as subtitle ({@link SourceCardRowLines} draws them where a row is not `EntityRow`). */
export interface SourceCardSlots {
  titleTrailing: React.ReactNode
  subtitle?: React.ReactNode
}

/**
 * The ONE card on the row anatomy (UB14.57, v0.15.1 `SourcesListPanel.tsx` `mapItem`): the category label as the
 * title meta, and line 2 — the non-connected state in its status colour (the stored error as its tooltip) when
 * `connection` says so, else the description, else nothing (no empty second line).
 *
 * Every Sources row fills its slots here (UB12.74): the aggregate list and its filters with a `connection`; the
 * MCPs, Plugins and Hooks subsections without one, each putting its OWN statement (the MCP sign-in or live marker,
 * the management row's notes) in `subtitle`'s place the way a verdict takes it — the same line-2 rule.
 */
export function sourceCardSlots(
  item: SourceCardRow,
  t: (key: string) => string,
  connection?: SourceCardConnection,
): SourceCardSlots {
  const category = sourceCategoryFor(item)
  const statusConfig = connection ? SOURCE_ROW_STATUS[connection.status] : null
  let subtitle: React.ReactNode | undefined
  if (statusConfig && connection) {
    const label = (
      <span
        data-source-row-status={connection.status}
        className={cn(connection.error && 'cursor-default', statusConfig.textClass)}
      >
        {t(statusConfig.labelKey)}
      </span>
    )
    subtitle = connection.error ? (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>{label}</TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs">{connection.error}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    ) : label
  } else if (item.description) {
    subtitle = <SourceCardDescription description={item.kind === 'skill' ? skillRussianDescription(item) : item.description} />
  }
  return {
    titleTrailing: <span data-testid={`source-card-meta-${category}`}>{t(SOURCE_CATEGORY_BADGE[category].labelKey)}</span>,
    subtitle,
  }
}

/**
 * UB12.74 — the card's two lines for the Sources rows that are not `EntityRow`: the MCPs subsection's
 * `McpEntityRow` (its Switch must stay a sibling of the row button) and the Hooks list's row (not clickable at
 * all, so no button). Class-for-class `EntityRow`'s content column on its `titleTrailing` branch
 * (`components/ui/entity-row.tsx`, v0.15.1 via UB13.13): glyph · title (truncated) · the meta at the line's end,
 * then line 2 behind an invisible copy of the glyph so it starts on the title's text edge. There is no "⋯" here,
 * so the meta never hides on hover.
 *
 * The caller's right-edge control is vertically centred across BOTH lines, so its clearance stays the padding of
 * the box this sits in: the meta ends at that clearance, and line 2 does too.
 */
export function SourceCardRowLines({
  icon,
  title,
  titleTrailing,
  subtitle,
}: SourceCardSlots & { icon: React.ReactNode; title: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0 flex-1">
      <div className="flex items-center gap-2.5 w-full min-w-0">
        <div className="shrink-0 flex items-center gap-2 [&>*]:size-4">{icon}</div>
        <div data-slot="entity-row-title" className="font-sans min-w-0 text-foreground truncate">{title}</div>
        <div
          data-slot="entity-row-meta"
          className="shrink-0 ml-auto pl-2 flex items-center text-label-sm text-tertiary tabular-nums whitespace-nowrap"
        >
          {titleTrailing}
        </div>
      </div>
      {subtitle && (
        <div data-slot="entity-row-subtitle" className="flex items-center gap-2.5 w-full min-w-0 text-label-sm text-secondary">
          <div className="shrink-0 flex items-center gap-2 [&>*]:size-4 invisible" aria-hidden="true">{icon}</div>
          <div className="min-w-0 flex-1 truncate">{subtitle}</div>
        </div>
      )}
    </div>
  )
}
