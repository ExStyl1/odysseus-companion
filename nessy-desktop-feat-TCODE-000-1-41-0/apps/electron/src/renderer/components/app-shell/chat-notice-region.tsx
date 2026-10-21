/**
 * C3.245 — the ONE bounded region the chat's session notices live in.
 *
 * Owner request 2026-09-11, from a screenshot of packaged 1.36.0: with a long
 * capability inventory the "Not everything loaded in this chat" card grew until
 * it covered the conversation and the composer, and there was nothing to scroll
 * — the card was as tall as its content, and its content was every capability
 * the session had. `PendingAuthNotice` has the same shape and the same failure
 * mode on a workspace with many sources awaiting sign-in.
 *
 * ONE region, not one per card, and that is the whole point: two separately
 * bounded cards can still add up to the whole pane, which is the defect. The
 * ceiling belongs to the STACK.
 *
 * WHY `vh` AND NOT A PERCENTAGE OF THE PANE, stated because it is an
 * approximation and an unexplained approximation is indistinguishable from a
 * defect: the plate stack is an auto-height flex item, so `max-height: 33%`
 * resolves against an `auto` height and is ignored by the browser — a
 * percentage here would silently do nothing. The pane is the window minus the
 * title bar and the composer, so `33vh` is a little over a third of it and
 * never more than a third of the window. The residue is that a very short
 * window makes the region proportionally taller; the region is still bounded
 * and still scrolls, which is what the row asks for.
 *
 * `empty:hidden` keeps the collapsed case exactly as it was: when both notices
 * render `null` the region has no child nodes, `:empty` matches, and the stack
 * is 0-height with no stray gap from `space-y`.
 *
 * The dismiss `x` is NOT kept reachable here — it is kept reachable by the
 * cards, which pass `stickyHeader` to `SystemCard` so their header pins to the
 * top of THIS scroll container. That is deliberate: a region that reached into
 * its children to hoist their controls would have to know what they are.
 */
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * About a third of the chat pane. Exported so the ceiling is one value a test
 * can name, rather than a literal repeated in a class string and an assertion.
 */
export const CHAT_NOTICE_REGION_MAX_HEIGHT = 'max-h-[33vh]'

export const CHAT_NOTICE_REGION_CLASS = cn(
  CHAT_NOTICE_REGION_MAX_HEIGHT,
  // Its own scroll, contained: a wheel that reaches the end of the notice must
  // not carry on into the transcript behind it.
  'overflow-y-auto overscroll-contain',
  // The stack's own rhythm, and the collapse when every notice renders null.
  'space-y-1.5 empty:hidden',
)

export function ChatNoticeRegion({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn(CHAT_NOTICE_REGION_CLASS, className)} data-testid="chat-notice-region">
      {children}
    </div>
  )
}
