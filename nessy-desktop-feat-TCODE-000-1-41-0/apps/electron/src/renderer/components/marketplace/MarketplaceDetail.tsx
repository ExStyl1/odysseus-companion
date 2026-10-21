/**
 * MarketplaceDetail (U5)
 *
 * The marketplace DETAIL surface with the SKILL PREVIEW. Codex-verified detail
 * IA (structure only; OUR tokens/components):
 *   breadcrumb ("Plugins > Name")
 *   → hero: 64px icon + title + tagline + origin badge; right: actions slot
 *     (…/uninstall + primary CTA) — all callback-driven
 *   → PROMO band with starter-prompt pills
 *   → full SKILL.md-style markdown inline (CapabilityContentPanel = Info_Markdown
 *     with maxHeight + fullscreen affordance) + file-ref chips (tooltip =
 *     relative path)
 *   → "Information" label/value metadata (Info_Table).
 *
 * The content panel is the SAME U1 mechanism (CapabilityContentPanel) so its
 * four states are honored: loaded / loading skeleton / error+retry / empty.
 * For an installed/inspectable item the app feeds the previewed body; for a
 * not-yet-installed item it feeds the bounded install-proposal preview (never a
 * renderer-side remote fetch) — the component is agnostic and only renders what
 * it is handed.
 *
 * Codex STRUCTURE, OUR tokens: hero title text-lg font-semibold; breadcrumb
 * text-xs muted; starter-prompt pills rounded-full bg-foreground/5; sections
 * are Info_Section (single surface, shadow-minimal, rounded-[8px]); Info_Table
 * for the Information rows.
 *
 * IPC-free + callback-driven. Display strings via PROPS — no i18n keys here.
 */

import * as React from 'react'
import { ChevronRight } from 'lucide-react'
import { Info_Section } from '@/components/info/Info_Section'
import { Info_Table } from '@/components/info/Info_Table'
import {
  CapabilityContentPanel,
  type CapabilityContentPanelProps,
} from '@/components/info/CapabilityContentPanel'
import { PluginOriginBadge } from '@/components/plugins/PluginOriginBadge'
import { cn } from '@/lib/utils'
import type { SafePluginPresentationOrigin } from '@nessy-agent/shared/protocol/capabilities'

/** One label/value row in the "Information" table. */
export interface MarketplaceDetailInfoField {
  // i18n at integration
  label: string
  value: React.ReactNode
}

export interface MarketplaceDetailProps {
  /** Icon element (64px hero tile). */
  icon: React.ReactNode
  /** Display name. */
  name: string
  /** Short tagline under the name. */
  tagline?: string
  /** Origin/format badge presentation. */
  presentation?: SafePluginPresentationOrigin
  /** Breadcrumb parent label (e.g. "Plugins"). */
  // i18n at integration
  breadcrumbParent?: string
  /** Right-aligned hero actions (…/uninstall + primary CTA — wired later). */
  actions?: React.ReactNode
  /** Starter-prompt pills (Codex promo band); omitted when empty. */
  starterPrompts?: string[]
  /** Fires when a starter-prompt pill is pressed. */
  onStarterPrompt?: (prompt: string) => void
  /** Section title for the skill preview / About panel. */
  // i18n at integration
  aboutTitle: string
  /** The skill-body preview panel state + payload (U1 mechanism). */
  content: CapabilityContentPanelProps
  /**
   * Component inventory slot (owner request 2026-07-19): the plugin's full
   * composition, rendered with the SAME PluginComponentsSection the Sources
   * plugin detail uses. Skill rows there open the marketplace skill-preview
   * MODAL (wired by the page/preview that owns the modal state).
   */
  componentsSlot?: React.ReactNode
  /** Section title for the Information table. */
  // i18n at integration
  informationTitle: string
  /** Information rows; empty → in-section placeholder. */
  information?: MarketplaceDetailInfoField[]
  /** Placeholder when Information rows are absent. */
  // i18n at integration
  informationEmpty?: string
  className?: string
}

export function MarketplaceDetail({
  icon,
  name,
  tagline,
  presentation,
  breadcrumbParent,
  actions,
  starterPrompts,
  onStarterPrompt,
  aboutTitle,
  content,
  componentsSlot,
  informationTitle,
  information,
  informationEmpty,
  className,
}: MarketplaceDetailProps) {
  return (
    <div className={cn('flex flex-col gap-5 p-5 max-w-[820px] mx-auto w-full', className)}>
      {/* Breadcrumb (Codex "Plugins > Name") */}
      {breadcrumbParent && (
        <nav className="flex items-center gap-1 text-xs text-muted-foreground" data-testid="marketplace-detail-breadcrumb">
          <span>{breadcrumbParent}</span>
          <ChevronRight className="h-3 w-3" />
          <span className="text-foreground/70">{name}</span>
        </nav>
      )}

      {/* Hero — 64px tile + title/tagline/origin + actions */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-4 min-w-0">
          <div className="h-16 w-16 shrink-0 rounded-[8px] ring-1 ring-border/30 overflow-hidden flex items-center justify-center bg-muted">
            {icon}
          </div>
          <div className="min-w-0 space-y-1 pt-0.5">
            <h1 className="text-lg font-semibold truncate">{name}</h1>
            {tagline && <p className="text-sm text-muted-foreground">{tagline}</p>}
            {presentation && <PluginOriginBadge presentation={presentation} />}
          </div>
        </div>
        {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
      </div>

      {/* Promo band — starter-prompt pills */}
      {starterPrompts && starterPrompts.length > 0 && (
        <div className="flex flex-wrap gap-2" data-testid="marketplace-detail-starters">
          {starterPrompts.map((prompt, index) => (
            <button
              key={index}
              type="button"
              onClick={() => onStarterPrompt?.(prompt)}
              data-testid="marketplace-detail-starter"
              className={cn(
                'rounded-full bg-foreground/5 hover:bg-foreground/10 px-3 py-1.5 text-xs text-foreground/80',
                'transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-ring text-left',
              )}
            >
              {prompt}
            </button>
          ))}
        </div>
      )}

      {/* Skill preview — full SKILL.md inline (U1 content panel). */}
      <Info_Section title={aboutTitle}>
        <CapabilityContentPanel {...content} />
      </Info_Section>

      {/* Component inventory — same section family as the Sources plugin
          detail; skill rows open the skill-preview modal. */}
      {componentsSlot}

      {/* Information — label/value metadata table. */}
      <Info_Section title={informationTitle}>
        {information && information.length > 0 ? (
          <Info_Table>
            {information.map((field, index) => (
              <Info_Table.Row key={`${field.label}:${index}`} label={field.label} value={field.value} />
            ))}
          </Info_Table>
        ) : (
          <p className="px-4 py-3 text-sm text-muted-foreground" data-testid="marketplace-detail-info-empty">
            {informationEmpty}
          </p>
        )}
      </Info_Section>
    </div>
  )
}
