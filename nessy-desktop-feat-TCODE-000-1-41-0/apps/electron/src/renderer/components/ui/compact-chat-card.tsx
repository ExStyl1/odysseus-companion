/**
 * CompactChatCard — the ONE card the product's compact chats sit in.
 *
 * D1.392 (owner, 2026-09-19, two screenshots). The owner put the shipped `/btw`
 * side-question panel beside the popover the Sources page's "+" opens and ruled
 * they must be the same component — *"там сейчас используется другой компонент …
 * как в плагинах например"*. They were not: the add popover is a compact card
 * with grip dots at the top and nothing else, while the panel had grown a title
 * header, a four-hint footer and a box half again as wide.
 *
 * So the SHELL is extracted here and both render through it: the card (radius,
 * background, shadow), the floating grip handle, and the content slot that hosts
 * the compact {@link ../app-shell/ChatDisplay}. What is NOT shared is behaviour —
 * `EditPopover` mints hidden sessions and builds edit prompts, a side question
 * rides `sessionCommand({ type: 'sideQuestion' })`, and neither knows about the
 * other. One frame, two users.
 *
 * BYTE-IDENTICAL, ON PURPOSE. `EditPopover`'s rendered output through this frame
 * is the same HTML it shipped before the extraction, pinned as a whole string in
 * `__tests__/compact-chat-card.test.tsx` — the class lists below are its own,
 * in its own order, and the two optional arms (a card that can be focused, a
 * grip that cannot be dragged) add nothing to the markup when they are unused.
 * A refactor that "tidies" one of these strings changes a shipped surface, and
 * that test is where it says so.
 *
 * UB14.40 (R6-11) left these strings alone ON PURPOSE: v0.15.1's own
 * `EditPopover.tsx` still draws this card with exactly these classes (its card
 * at line 1041, the grip at 1055, the content slot at 1059), so the redesign's
 * "1:1 with v0.15.1" IS this markup. Re-tokening the card would make it the one
 * surface that differs from upstream, against the row's own test wording —
 * `components/__tests__/ours-dialogs-vocabulary.test.ts` carries the exception
 * and pins the three upstream classes as the ONLY legacy ones here.
 */

import * as React from 'react'
import { GripHorizontal } from 'lucide-react'
import { cn } from '@/lib/utils'

/** The card's own classes — `EditPopover`'s, verbatim. */
export const COMPACT_CHAT_CARD_CLASS =
  'relative bg-foreground-2 overflow-hidden w-full h-full shadow-modal-small'

/** Corner radius, as a number because it rides `style` rather than a class. */
export const COMPACT_CHAT_CARD_RADIUS = 16

export interface CompactChatCardProps {
  /** The card's content — in both users, a compact `ChatDisplay` and its siblings. */
  children: React.ReactNode
  /** The card element itself, for a caller that measures or drags it. */
  cardRef?: React.Ref<HTMLDivElement>
  /** A CSS transform (the drag offset). Omitted entirely when nothing drags. */
  transform?: string
  /**
   * Mouse-down on the grip. When absent the grip is presentational: it keeps the
   * reference card's dots so the two surfaces read as one component, and drops
   * the grab cursor so it does not advertise a drag that would do nothing.
   */
  onGripMouseDown?: (event: React.MouseEvent) => void
  /** Drag in progress — swaps the grab cursor for the grabbing one. */
  isDragging?: boolean
  /** Key handling for a card that is itself focusable (the `/btw` panel's keys). */
  onKeyDown?: (event: React.KeyboardEvent) => void
  /** Focusability. Passing it also removes the focus ring the card cannot use. */
  tabIndex?: number
  /**
   * Accessible name. A card with no visible title still needs one, and Radix
   * does not invent it — the `/btw` panel's title moved here when its header
   * was removed.
   */
  ariaLabel?: string
  /** `data-testid` for a live driver. */
  testId?: string
}

export function CompactChatCard({
  children,
  cardRef,
  transform,
  onGripMouseDown,
  isDragging = false,
  onKeyDown,
  tabIndex,
  ariaLabel,
  testId,
}: CompactChatCardProps) {
  return (
    <div
      ref={cardRef}
      aria-label={ariaLabel}
      tabIndex={tabIndex}
      onKeyDown={onKeyDown}
      data-testid={testId}
      className={
        tabIndex === undefined
          ? COMPACT_CHAT_CARD_CLASS
          : cn(COMPACT_CHAT_CARD_CLASS, 'outline-none')
      }
      style={
        transform === undefined
          ? { borderRadius: COMPACT_CHAT_CARD_RADIUS }
          : { transform, borderRadius: COMPACT_CHAT_CARD_RADIUS }
      }
    >
      {/* Grip dots — floating over the content, which is why the card needs no
          header row at all. This is the thing the owner's screenshot 2 shows. */}
      <div
        onMouseDown={onGripMouseDown}
        className={cn(
          'absolute top-0 left-1/2 -translate-x-1/2 z-50 px-4 py-2',
          onGripMouseDown ? 'cursor-grab' : 'cursor-default',
          'rounded pointer-events-auto titlebar-no-drag',
          isDragging && 'cursor-grabbing',
        )}
      >
        <GripHorizontal className="w-4 h-4 text-muted-foreground/30" />
      </div>

      {/* Content slot - always uses compact ChatDisplay */}
      <div className="flex-1 flex flex-col bg-foreground-2" style={{ height: '100%' }}>
        {children}
      </div>
    </div>
  )
}
