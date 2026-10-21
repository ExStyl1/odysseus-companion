import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface SystemCardProps {
  /** Leading mark in the header row (usually a 3.5-size lucide icon). */
  icon?: ReactNode
  title: ReactNode
  /** Right-aligned header content — a count, a progress readout, a dismiss button. */
  meta?: ReactNode
  /** Extra classes on the title, for the one card that wants a louder heading. */
  titleClassName?: string
  /**
   * C3.245 — pin the header row to the top of the nearest scroll container.
   *
   * Opt-in, because it is only right for a card that lives inside one: the
   * chat's notice region (`ChatNoticeRegion`) is bounded and scrolls, and the
   * dismiss `x` these cards put in `meta` would otherwise scroll out of reach
   * on a long inventory — which is half of what the owner reported. The other
   * cards in this stack are not in a scroller and must not gain a sticky band.
   *
   * The opaque background is not taste: a translucent sticky header lets the
   * rows scrolling under it show through and become unreadable, so the band
   * takes an OPAQUE tint where the card body keeps `muted/30`, and is pulled
   * out to the card's edges so it covers the full width.
   *
   * C3.248 — that sentence was written about `bg-muted`, which is not opaque.
   * MEASURED in `apps/electron/src/renderer/index.css`: `--muted` is
   * `oklch(from var(--foreground) l c h / 0.05)` in BOTH theme blocks — five
   * per cent ALPHA, in light and in dark alike — so the band was letting
   * ninety-five per cent of the scrolling rows through and the C3.245 docblock
   * was describing something the stylesheet never provided.
   *
   * `bg-foreground-5` is the same 5 % tint composed the other way:
   * `color-mix(in srgb, var(--foreground) 5%, var(--background))`, declared in
   * both theme blocks and exposed as a utility by `--color-foreground-5`. Same
   * appearance, actually opaque, no new token. (`bg-card` is the other opaque
   * choice and is what `components/ui/table.tsx`'s sticky header uses; it is
   * the flat page colour, which would drop the band's tint.)
   * `__tests__/system-card-sticky-band.test.ts` pins the class AND the two
   * stylesheet readings it depends on, so a theme edit that gives
   * `--foreground-5` an alpha reddens instead of shipping.
   *
   * UB14.40 — the card is now v0.15.1's sunken well, and `bg-sunken` is opaque
   * by construction (`--surface-sunken` is a plain hex in both theme blocks of
   * `packages/ui/src/styles/tokens.css`), so the band takes the card's OWN
   * surface: still opaque, and now the same colour as the body it scrolls over
   * instead of a second tint. The test pins that reading instead.
   */
  stickyHeader?: boolean
  children?: ReactNode
  className?: string
  role?: string
  'aria-label'?: string
  'data-testid'?: string
}

/**
 * The chrome the session's system cards share — the plates that sit between
 * the message list and the composer (pending sign-in, task checklist, running
 * agents). It exists because that chrome was copy-pasted three times, with a
 * comment in one of them admitting it.
 *
 * Placement and gutter are NOT this component's business: ChatDisplay's plate
 * stack owns those (CHAT_LAYOUT.controlGutter).
 *
 * UB14.40 (R6-11) — drawn with v0.15.1's info-well recipe (onboarding
 * GitBashWarning's: `bg-sunken` on a `separator` hairline), the body on
 * `text-label-sm` and the header on secondary ink. The hairline is a BORDER,
 * not GitBashWarning's inset ring: the sticky band below paints over the
 * padding box, and an inset ring would vanish under it.
 */
export function SystemCard({
  icon,
  title,
  meta,
  titleClassName,
  stickyHeader = false,
  children,
  className,
  role,
  'aria-label': ariaLabel,
  'data-testid': testId,
}: SystemCardProps) {
  return (
    <div
      className={cn('rounded-lg border border-separator bg-sunken px-3 py-2 text-label-sm', className)}
      role={role}
      aria-label={ariaLabel}
      data-testid={testId}
    >
      <div
        className={cn(
          'mb-1.5 flex items-center gap-1.5 text-secondary',
          stickyHeader && 'sticky top-0 z-10 -mx-3 -mt-2 rounded-t-lg bg-sunken px-3 pt-2',
        )}
      >
        {icon}
        <h3 className={cn('font-medium', titleClassName)}>{title}</h3>
        {meta && <span className="ml-auto">{meta}</span>}
      </div>
      {children}
    </div>
  )
}

/** Inline failure strip for a row inside a SystemCard — v0.15.1's ErrorMessage tint and its destructive hairline. */
export function SystemCardError({ children, className, ...rest }: {
  children: ReactNode
  className?: string
  'data-testid'?: string
}) {
  return (
    <div
      role="alert"
      className={cn('mt-1 rounded-sm bg-destructive-tint px-1.5 py-1 text-destructive inset-ring inset-ring-[var(--destructive-border)]', className)}
      {...rest}
    >
      {children}
    </div>
  )
}
