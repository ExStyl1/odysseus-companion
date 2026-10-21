/**
 * A session fact in the row above the composer — UB14.55 (ours; v0.15.1 has no such chip).
 *
 * WHAT IT IS FOR. A fact the session was CREATED with and keeps for its life: P6.502's never-persist and P6.940's
 * pinned agent (`@X`). Upstream's chat header has no slot for them and they are create-time facts the composer zone
 * already shows (R2 §6 default 1), so they stay above the composer, in `ActiveOptionBadges`' one quiet chip row.
 *
 * WHY STATIC. Nothing here can change a running session's persistence or repin its agent, so a pressable chip would
 * offer a control that does not exist: the chip wears `COMPOSER_STATIC_META_CHIP` (upstream's quiet meta chip without
 * its press and hover), is a `note` rather than a button, and carries the full sentence as its `title` and its name.
 *
 * Its own module, light on purpose: `ActiveOptionBadges` cannot be imported in a bare bun process (see
 * `__tests__/background-task-chip.test.tsx`), and the chip must render alone in a test.
 */
import * as React from 'react'
import { cn } from '@/lib/utils'
import { COMPOSER_STATIC_META_CHIP } from './input/composer-styles'

export interface SessionFactChipProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  /** The short words on the chip. */
  label: string
  /** The whole fact (what it costs or what it pins): the chip's tooltip and its accessible name. */
  title: string
  /** Leading glyph, drawn tertiary. */
  icon?: React.ReactNode
}

export function SessionFactChip({ label, title, icon, className, ...rest }: SessionFactChipProps) {
  return (
    <div
      role="note"
      aria-label={title}
      title={title}
      {...rest}
      className={cn(COMPOSER_STATIC_META_CHIP, 'max-w-full', icon ? 'pl-2' : undefined, className)}
    >
      {icon ? <span aria-hidden className="flex shrink-0 text-tertiary [&>svg]:size-3.5">{icon}</span> : null}
      <span className="min-w-0 truncate">{label}</span>
    </div>
  )
}
