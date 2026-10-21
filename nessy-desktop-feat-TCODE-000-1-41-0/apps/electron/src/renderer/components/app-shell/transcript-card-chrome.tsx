/**
 * UB14.18 (R3-12; no upstream counterpart) — the transcript's row language for OUR cards: the
 * `renderActivity` slot's SubagentCard (P3.24), WorkflowPanel, TodoListCard (P2.503) and
 * AdvisorConsultationCard (P4.5), the F1.351 task-notification line and the P6.334 spawn chip.
 *
 * v0.15.1 draws its work log from `packages/ui/src/components/chat/turn/turn-classes.ts` and its
 * wells from `markdown/PreviewBlockChrome.tsx`. Neither is reachable from this package: the ui
 * package exports no subpath for them, and the barrel and `./chat/TurnCard` pull Markdown's
 * react-pdf graph, which bun cannot load (a Vite-only `?url` worker), so every card test here would
 * stop loading. v0.15.1's own electron files meet the same wall the same way — they spell the chip
 * literal inline (`SessionBadges.tsx` `counterClass`, `kanban/StatusBadge.tsx`,
 * `pages/page-visuals.tsx`). These are those literals, copied, and
 * `__tests__/transcript-cards-look.test.tsx` pins every one EQUAL to its packages/ui twin, so the
 * cards cannot drift from the rows they sit between. The icon button is electron's own
 * `IconButton size="sm"`, the primitive `TurnIconButton` says it mirrors.
 */
import * as React from 'react'
import { Spinner } from '@nessy-agent/ui/ui/LoadingIndicator'
import { cn } from '@/lib/utils'

/** = turn-classes `WORK_LOG_ROW`: one 28px row, 13px label, secondary ink; the hover fill bleeds 6px. */
export const WORK_LOG_ROW =
  'flex min-h-7 in-data-compact:min-h-9 min-w-0 flex-1 -ml-1.5 items-center gap-2 rounded-sm px-1.5 py-0.5 text-left text-label text-secondary'

/** = turn-classes `WORK_LOG_ROW_WRAPPER`. */
export const WORK_LOG_ROW_WRAPPER = 'flex min-w-0'

/** = turn-classes `WORK_LOG_ROW_INTERACTIVE`: hover-in instant, hover-out 100ms. */
export const WORK_LOG_ROW_INTERACTIVE =
  'transition-colors duration-micro ease-out-subtle hover:bg-fill-hover hover:duration-instant active:bg-fill-pressed focus-visible:-outline-offset-2'

/** = turn-classes `ROW_ICON_SLOT`: the 16px slot every row's leading icon sits in. */
export const ROW_ICON_SLOT = 'flex size-4 shrink-0 items-center justify-center'

/** = turn-classes `WORK_LOG_BODY`: the inset hairline a group's children hang under. */
export const WORK_LOG_BODY = 'ml-1.75 flex min-w-0 flex-col border-l border-default pl-3.5'

/** = turn-classes `CHIP_NEUTRAL` / `CHIP_DESTRUCTIVE`: 20px status chips. */
export const CHIP_NEUTRAL =
  'inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-xs bg-fill-hover px-1.5 text-label-sm text-secondary'
export const CHIP_DESTRUCTIVE =
  'inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-xs bg-destructive-tint px-1.5 text-label-sm text-destructive'

/** = turn-classes `HOVER_REVEAL`: a row's quiet action, shown on hover/focus (always on touch). */
export const HOVER_REVEAL =
  'opacity-0 transition-opacity duration-micro ease-out-subtle focus-within:opacity-100 has-[[data-state=open]]:opacity-100 has-[[aria-expanded=true]]:opacity-100 [@media(hover:none)]:opacity-100'

/** = turn-classes `SIZE_CONFIG.iconSize` / `SIZE_CONFIG.spinnerSize`. */
export const ROW_ICON_SIZE = 'size-3.5'
export const ROW_SPINNER_SIZE = 'text-caption'

/** = turn/ActivityIcons `ResultGlyph status="running"`: the work log's accent spinner. */
export function RowSpinner() {
  return <Spinner className={cn(ROW_SPINNER_SIZE, 'text-accent')} />
}

/** = `PreviewBlockFrame`'s class: the sunken well (radius-md, hairline). */
export const CARD_WELL_FRAME = 'relative isolate overflow-hidden rounded-md border border-subtle bg-sunken'

/** = `PreviewBlockHeader`'s base class (its `pr-1`/`pr-3` arm is chosen below exactly as it chooses). */
export const CARD_WELL_HEADER = 'flex h-8 items-center gap-2 border-b border-subtle pl-3 text-label-sm text-tertiary'

/**
 * A well with v0.15.1's 32px header: icon · title · (ours: `meta`) · spacer · actions. With no `meta`,
 * `icon` or `actions` its frame and header are byte-equal to `<PreviewBlockFrame><PreviewBlockHeader
 * title=…/>` (pinned); `meta` is the one addition, for a header that qualifies its title (the
 * advisor's moment).
 */
export function CardWell({
  title,
  icon,
  meta,
  actions,
  className,
  children,
  ...rest
}: {
  title: string
  icon?: React.ReactNode
  meta?: React.ReactNode
  actions?: React.ReactNode
  className?: string
  children?: React.ReactNode
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'title' | 'children' | 'className'>) {
  return (
    <div className={cn(CARD_WELL_FRAME, className)} {...rest}>
      <div className={cn(CARD_WELL_HEADER, actions ? 'pr-1' : 'pr-3')}>
        {icon && (
          <span aria-hidden className="flex shrink-0 [&_svg]:size-3.5">
            {icon}
          </span>
        )}
        <span title={title} className="min-w-0 truncate text-secondary">
          {title}
        </span>
        {meta}
        <span className="flex-1" />
        {actions && <div className="flex shrink-0 items-center gap-0.5">{actions}</div>}
      </div>
      {children}
    </div>
  )
}
