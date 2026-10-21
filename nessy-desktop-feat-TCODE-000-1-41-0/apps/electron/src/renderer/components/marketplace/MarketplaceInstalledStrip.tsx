/**
 * MarketplaceInstalledStrip (U5)
 *
 * The compact "Installed" strip at the top of the BROWSE page (Codex-verified:
 * an ICON-ONLY row of installed plugins + a gear that deep-links to the
 * management surface). R2 browse/manage separation: this strip only MAPS what
 * is already installed and hands off to Sources for management — it never
 * duplicates enable/disable menus.
 *
 * Codex STRUCTURE, OUR tokens: a micro-label header
 * (text-[11px] uppercase tracking-wider muted), a horizontal row of small
 * rounded ring icon tiles (our avatar tile convention), and a "Manage in
 * Sources" affordance rendered as OUR ghost Button with a Settings icon.
 *
 * IPC-free + callback-driven. Display strings via PROPS — no i18n keys here.
 */

import * as React from 'react'
import { Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/** One installed entry rendered as an icon tile in the strip. */
export interface MarketplaceInstalledEntry {
  id: string
  /** Icon element (mock tile / SourceAvatar). */
  icon: React.ReactNode
  /** Accessible label + tooltip (display name). */
  name: string
  /**
   * R83 — the wire advertises an update for this installed plugin: the
   * already-localized sentence (e.g. "Update available: 2.4.0"), supplied by
   * the caller like every other display string here.
   *
   * Its PRESENCE is the indicator, and the indicator is a DOT: these tiles are
   * 32 px icons with no text at all, so the sentence itself is three times the
   * width of the thing it marks and would turn a glanceable map of what is
   * installed into a list. The sentence still reaches the user — it is the
   * tile's tooltip and accessible name, so hover and a screen reader both get
   * the version the dot cannot say.
   */
  updateLabel?: string
}

export interface MarketplaceInstalledStripProps {
  /** Section micro-label (e.g. "Installed"). */
  // i18n at integration
  title: string
  /** The installed entries; empty → the strip is not rendered by the caller. */
  entries: MarketplaceInstalledEntry[]
  /** "Manage in Sources" affordance label. */
  // i18n at integration
  manageLabel: string
  /** Deep-link handoff to the Sources management surface. */
  onManage?: () => void
  /** An installed tile click → opens that item's detail. */
  onOpen?: (id: string) => void
  className?: string
}

export function MarketplaceInstalledStrip({
  title,
  entries,
  manageLabel,
  onManage,
  onOpen,
  className,
}: MarketplaceInstalledStripProps) {
  return (
    <div className={cn('flex flex-col gap-2', className)} data-testid="marketplace-installed-strip">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {title}
        </span>
        {/* Gear → management handoff (Codex), OUR ghost Button. */}
        <Button
          variant="ghost"
          size="sm"
          onClick={onManage}
          data-testid="marketplace-manage-in-sources"
        >
          <Settings2 className="h-3.5 w-3.5" />
          {manageLabel}
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {entries.map((entry) => {
          // The tooltip/accessible name carries the whole sentence; the dot is
          // only the thing that makes you look.
          const label = entry.updateLabel ? `${entry.name} — ${entry.updateLabel}` : entry.name
          return (
            <span key={entry.id} className="relative inline-flex shrink-0">
              <button
                type="button"
                title={label}
                aria-label={label}
                onClick={() => onOpen?.(entry.id)}
                data-testid="marketplace-installed-tile"
                className={cn(
                  'h-8 w-8 shrink-0 rounded-[6px] ring-1 ring-border/30 overflow-hidden flex items-center justify-center bg-muted',
                  'transition-colors hover:ring-border focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                )}
              >
                {entry.icon}
              </button>
              {/* Outside the tile, because the tile clips (overflow-hidden).
                  `info` is the app's attention amber — the same colour the
                  management row's update note uses, so one signal reads as one
                  thing on both surfaces. */}
              {entry.updateLabel && (
                <span
                  aria-hidden="true"
                  data-testid="marketplace-installed-update-dot"
                  className="pointer-events-none absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-info ring-2 ring-background"
                />
              )}
            </span>
          )
        })}
      </div>
    </div>
  )
}
