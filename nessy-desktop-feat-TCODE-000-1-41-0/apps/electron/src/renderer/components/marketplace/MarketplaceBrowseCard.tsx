/**
 * MarketplaceBrowseCard (U5)
 *
 * ONE discovery "row" (Codex-verified BROWSE anatomy: 35px icon tile,
 * 13px/500 title, 12px muted single-line description, right-aligned control).
 * Codex's STRUCTURE, OUR tokens: a FLAT row on the page surface — NO card
 * chrome (owner alignment 2026-07-19: Codex browse rows are flat, only a
 * whole-row hover wash + a hairline between shelf rows). rounded-[8px] just
 * clips the hover wash; text-sm title / text-xs muted description;
 * PluginOriginBadge as-is; OUR Button for the install affordance.
 *
 * Two right-aligned control states mirror the Codex inventory:
 *   - not-installed → "Install" (compact pill Button) / "Installing…" while a
 *     mutation runs / a policy-blocked disabled button with a reason tooltip.
 *   - installed     → an "Installed" state chip (NOT an install button — the
 *     supply-channel maps what is already installed; management lives in
 *     Sources).
 *
 * IPC-free + callback-driven: the caller wires onInstall/onOpen to the real
 * install proposal / detail route later; the playground + tests drive it with
 * mock data + console callbacks. Display strings arrive via PROPS (mock data
 * supplies English text directly) — no i18n keys in this slice.
 */

import * as React from 'react'
import { Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { PluginOriginBadge } from '@/components/plugins/PluginOriginBadge'
import { cn } from '@/lib/utils'
import type { SafePluginPresentationOrigin } from '@nessy-agent/shared/protocol/capabilities'

/** Install affordance state for the card's right-aligned control. */
export type MarketplaceCardInstallState =
  | 'not-installed'
  | 'installing'
  | 'installed'
  /** Policy/trust/context blocked — disabled button + reason tooltip. */
  | 'blocked'

export interface MarketplaceBrowseCardProps {
  /** Stable key (listing id) + callback payload. */
  id: string
  /** Icon element (SourceAvatar / brand tile in the app; a mock tile here). */
  icon: React.ReactNode
  /** Display name (already resolved). */
  name: string
  /** One-line short description (truncated). */
  description?: string
  /** Origin/format badge presentation (A9 display-only projection). */
  presentation?: SafePluginPresentationOrigin
  /** Tenant/marketplace suffix shown next to the name (Personal scope). */
  tenant?: string
  /**
   * `plugins/org.md#recommend-plugins`'s annotation on a pinned row — "suggested for this
   * directory". Already translated by the caller; the wire carries only the
   * signal that produced it.
   */
  suggestionLabel?: string
  /**
   * P6.519/P6.424 — the narrowing, named where the suggestion appears rather
   * than left to be inferred: `plugin-relevance.md` specifies five relevance
   * signals and this fork decides two, because `cli`, `hosts` and `filesRead`
   * all need a per-session record of commands run, URLs seen and files read that
   * it deliberately does not keep. Already translated by the caller; shown as
   * the chip's title so it costs the row no layout.
   */
  suggestionDetail?: string
  /** Right-control state. */
  installState: MarketplaceCardInstallState
  /** Install button label (e.g. "Install" or "Connect" for connector-backed). */
  // i18n at integration
  installLabel: string
  /** "Installed" state chip label. */
  // i18n at integration
  installedLabel: string
  /** "Installing…" progress label. */
  // i18n at integration
  installingLabel: string
  /** Reason tooltip shown on the disabled button when blocked. */
  blockedReason?: string
  /** Fires when the install/connect button is pressed. */
  onInstall?: (id: string) => void
  /** Whole-card click → opens the detail surface. */
  onOpen?: (id: string) => void
  className?: string
}

export function MarketplaceBrowseCard({
  id,
  icon,
  name,
  description,
  presentation,
  tenant,
  suggestionLabel,
  suggestionDetail,
  installState,
  installLabel,
  installedLabel,
  installingLabel,
  blockedReason,
  onInstall,
  onOpen,
  className,
}: MarketplaceBrowseCardProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen?.(id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen?.(id)
        }
      }}
      data-testid="marketplace-browse-card"
      className={cn(
        // Flat row (Codex airy browse): NO bg/shadow card chrome — the row sits
        // on the page surface; only a whole-row hover wash. The shelf provides
        // the hairline between rows.
        'group flex items-center gap-3 rounded-[8px] px-3 py-2.5 text-left',
        'transition-colors hover:bg-foreground/5 cursor-pointer',
        'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        // Cheap virtualization: skip layout/paint for offscreen rows and reserve
        // an approximate row box so the scrollbar stays stable with hundreds of
        // rows. `auto` remembers the last-rendered size once painted.
        '[content-visibility:auto] [contain-intrinsic-size:auto_60px]',
        className,
      )}
    >
      {/* 35px icon tile (Codex) → OUR rounded ring tile convention. */}
      <div className="h-9 w-9 shrink-0 rounded-[6px] ring-1 ring-border/30 overflow-hidden flex items-center justify-center bg-muted">
        {icon}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-medium truncate">{name}</span>
          {tenant && (
            <span className="text-xs text-muted-foreground/70 shrink-0 truncate">{tenant}</span>
          )}
          {suggestionLabel && (
            <span
              data-testid="marketplace-card-suggestion"
              title={suggestionDetail}
              className="shrink-0 rounded-full bg-primary/10 text-primary px-2 py-0.5 text-[10px] font-medium"
            >
              {suggestionLabel}
            </span>
          )}
        </div>
        {description && (
          <p className="text-xs text-muted-foreground truncate mt-0.5">{description}</p>
        )}
        {presentation && (
          <div className="mt-1">
            <PluginOriginBadge presentation={presentation} />
          </div>
        )}
      </div>

      {/* Right-aligned control (Codex: Install pill / installed state). */}
      <div className="shrink-0" onClick={(e) => e.stopPropagation()}>
        {installState === 'installed' ? (
          <span
            data-testid="marketplace-card-installed"
            className="inline-flex items-center gap-1.5 rounded-full bg-success/10 text-success px-2.5 h-7 text-xs font-medium"
          >
            <Check className="h-3.5 w-3.5" />
            {installedLabel}
          </span>
        ) : installState === 'installing' ? (
          <Button size="sm" disabled data-testid="marketplace-card-installing">
            {installingLabel}
          </Button>
        ) : installState === 'blocked' ? (
          <Button
            size="sm"
            variant="secondary"
            disabled
            title={blockedReason}
            data-testid="marketplace-card-blocked"
          >
            {installLabel}
          </Button>
        ) : (
          <Button
            size="sm"
            onClick={() => onInstall?.(id)}
            data-testid="marketplace-card-install"
          >
            {installLabel}
          </Button>
        )}
      </div>
    </div>
  )
}
