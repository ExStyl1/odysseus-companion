/**
 * MarketplaceBrowsePage (U5)
 *
 * The BROWSE surface — Codex-verified IA (structure only; OUR tokens):
 *   page title + one-line subtitle
 *   → pill-shaped search (Input + Search icon, clear × when non-empty)
 *   → "Installed" strip (icon-only row + Manage-in-Sources gear)
 *   → category section shelves, each: micro-label header + hairline rule +
 *     2-column card grid (grid gap-3 md:grid-cols-2) of MarketplaceBrowseCard.
 *
 * Codex STRUCTURE, OUR tokens: page title = text-lg font-semibold (our canon,
 * NOT Codex 26px/400); search field radius-full (Codex pill); section header =
 * text-[11px] uppercase tracking-wider muted; hairline = border-foreground/10;
 * card grid = our gap-3 / md:grid-cols-2.
 *
 * LIST STATES (Codex triple/quadruple-state discipline; U1 placeholder-not-
 * hidden): populated / searching (server-side per spec — the query knob just
 * filters mock data client-side in the playground) / loading skeleton / empty
 * (quiet single-line "no results", sections hidden — Codex no-results
 * treatment) / error (Info_Alert + Retry). A mixed installed/not-installed set
 * is expressed through each card's installState (installed cards show an
 * "Installed" state chip, never an install button).
 *
 * IPC-free + callback-driven. Search is a controlled value the caller owns
 * (real search stays SERVER-side — MarketplaceService.list already passes
 * query/page/sort). Display strings via PROPS — no i18n keys in this slice.
 */

import * as React from 'react'; import { useTranslation } from 'react-i18next' // F1.477 (P6) — one line: cited by line
import { Loader2, Plus, Search, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Info_Alert } from '@/components/info/Info_Alert'
import {
  MarketplaceBrowseCard,
  type MarketplaceBrowseCardProps,
} from './MarketplaceBrowseCard'
import {
  MarketplaceInstalledStrip,
  type MarketplaceInstalledEntry,
} from './MarketplaceInstalledStrip'
import { cn } from '@/lib/utils'

export type MarketplaceBrowseStatus = 'ready' | 'loading' | 'empty' | 'error'

/** Top tab (Codex Plugins | Skills — backed by our MarketplaceListKind). */
export type MarketplaceBrowseTab = 'plugins' | 'skills'
/** Scope segment (Codex Public | Personal). */
export type MarketplaceBrowseScope = 'public' | 'personal'

/** A generic segmented control (pill row) — Codex tab/scope selector. */
function Segmented<T extends string>({
  value,
  options,
  onChange,
  testid,
}: {
  value: T
  options: { value: T; label: string; disabled?: boolean; title?: string }[]
  onChange?: (value: T) => void
  testid?: string
}) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-full bg-foreground/5 p-0.5" data-testid={testid}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          disabled={opt.disabled}
          title={opt.title}
          onClick={() => { if (!opt.disabled) onChange?.(opt.value) }}
          aria-pressed={value === opt.value}
          className={cn(
            'rounded-full px-3 py-1 text-xs font-medium transition-colors',
            opt.disabled
              ? 'text-muted-foreground/40 cursor-not-allowed'
              : value === opt.value
                ? 'bg-background shadow-minimal text-foreground'
                : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

/** A card entry within a section (browse card props + no wrapper key). */
export type MarketplaceBrowseCardEntry = MarketplaceBrowseCardProps

/** One labeled section shelf (Codex "Featured" / "Productivity" / …). */
export interface MarketplaceBrowseSection {
  id: string
  /** Section micro-label. */
  // i18n at integration
  title: string
  /** Optional count suffix (Codex regroups search results with counts). */
  count?: number
  /**
   * Right-aligned per-section header actions (R3: a registry section's
   * Upgrade / Remove affordance). Callback-driven; the caller owns the menu.
   */
  actions?: React.ReactNode
  /**
   * Optional per-section note under the header (R3: a per-registry load-error
   * line for a registry whose catalog could not be loaded).
   */
  note?: React.ReactNode
  cards: MarketplaceBrowseCardEntry[]
}

export interface MarketplaceBrowsePageProps {
  /** Page title. */
  // i18n at integration
  title: string
  /** One-line subtitle under the title. */
  // i18n at integration
  subtitle?: string
  /**
   * Right-aligned header actions (Codex "Create ▾" dropdown → Create plugin /
   * Add marketplace). Callback-driven; the caller owns the dropdown + dialogs.
   * The Add-marketplace registry backend is the 1.10.0 ADDENDUM candidate —
   * this is the entry-point slot only.
   */
  headerActions?: React.ReactNode
  /**
   * Top tabs (Codex Plugins | Skills). Present → renders the tab segment; the
   * caller switches the listing kind (our MarketplaceService `kind`). Omit to
   * hide the tabs entirely. In the marketplace-first IA the tabs are SCOPED to
   * the selected marketplace: `disabled` marks kinds the marketplace does not
   * carry, and `note` is a subtle inline explanation shown beside them.
   */
  tabs?: {
    active: MarketplaceBrowseTab
    // i18n at integration
    pluginsLabel: string
    // i18n at integration
    skillsLabel: string
    onChange?: (tab: MarketplaceBrowseTab) => void
    /** Kinds the selected marketplace does not carry → shown disabled. */
    disabled?: Partial<Record<MarketplaceBrowseTab, boolean>>
    /** Subtle note beside the tabs (e.g. why the Skills tab is disabled). */
    // i18n at integration
    note?: string
  }
  /**
   * Scope segment (Codex Public | Personal). Present → renders the scope
   * selector next to the tabs.
   */
  scope?: {
    active: MarketplaceBrowseScope
    // i18n at integration
    publicLabel: string
    // i18n at integration
    personalLabel: string
    onChange?: (scope: MarketplaceBrowseScope) => void
  }
  /**
   * Top-level marketplace SELECTOR row (`Skills Market | <registry> | …`).
   * Present → renders a horizontally scrollable chip row ABOVE the kind tabs;
   * the caller owns the selection and narrows the sections + scopes the tabs it
   * passes. Omit to hide the row (e.g. no bring-your-own registries configured —
   * the built-in Skills Market is then implicit).
   */
  marketplaceFilter?: {
    active: string
    /**
     * `offered` (P6.517 / P6.518) marks a catalog this build DELIVERS and has
     * not registered. It is not selectable: it renders with a visible off state
     * and its click calls `onEnable`, not `onChange`.
     */
    options: { id: string; label: string; offered?: boolean; description?: string }[]
    onChange?: (id: string) => void
    onEnable?: (id: string) => void
    /** The badge on an offered chip, e.g. "Not added". */
    offeredLabel?: string
    /** The offered chip's accessible name, e.g. "Enable this marketplace". */
    enableLabel?: string
    /** Ids whose enable click is in flight. */
    enabling?: readonly string[]
  }
  /** List/search state. */
  status: MarketplaceBrowseStatus
  /** Controlled search value (caller owns it; real search is server-side). */
  query: string
  /** Search field placeholder. */
  // i18n at integration
  searchPlaceholder: string
  onQueryChange?: (query: string) => void
  /** Installed strip (omitted when there are no installed entries). */
  installedStrip?: {
    // i18n at integration
    title: string
    entries: MarketplaceInstalledEntry[]
    // i18n at integration
    manageLabel: string
    onManage?: () => void
    onOpenInstalled?: (id: string) => void
  }
  /** Section shelves (ready state). */
  sections: MarketplaceBrowseSection[]
  /**
   * Partial-state note above the sections (R3: "Some marketplaces could not be
   * loaded"). Shown alongside a populated list — one or more registries failed
   * but the built-in market + healthy registries still render.
   */
  loadErrorNote?: React.ReactNode
  /** Quiet single-line no-results message (empty state). */
  // i18n at integration
  emptyMessage: string
  /** Error state copy + retry. */
  // i18n at integration
  errorMessage?: string
  // i18n at integration
  retryLabel?: string
  onRetry?: () => void
  className?: string
}

/** Flat row skeleton for the loading grid (matches the chrome-free browse row). */
function CardSkeleton() {
  return (
    <div className="flex items-center gap-3 px-3 py-2.5" aria-hidden="true">
      <div className="h-9 w-9 shrink-0 rounded-[6px] bg-foreground/5 animate-pulse" />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="h-3 w-1/3 rounded bg-foreground/5 animate-pulse" />
        <div className="h-2.5 w-2/3 rounded bg-foreground/5 animate-pulse" />
      </div>
      <div className="h-7 w-16 shrink-0 rounded-full bg-foreground/5 animate-pulse" />
    </div>
  )
}

/**
 * Shelf header (Codex alignment 2026-07-19): a larger title-case heading on its
 * own line, foreground (not a muted uppercase micro-label), with a full-width
 * hairline below it.
 */
function SectionHeader({ title, count, actions }: { title: string; count?: number; actions?: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[15px] font-medium text-foreground">
          {title}
          {typeof count === 'number' && <span className="ml-1.5 text-muted-foreground">{count}</span>}
        </h2>
        {actions && <div className="shrink-0 flex items-center gap-1">{actions}</div>}
      </div>
      <div className="h-px w-full bg-border/60" aria-hidden="true" />
    </div>
  )
}

export function MarketplaceBrowsePage({
  title,
  subtitle,
  status,
  query,
  searchPlaceholder,
  onQueryChange,
  installedStrip,
  sections,
  loadErrorNote,
  emptyMessage,
  errorMessage,
  retryLabel,
  onRetry,
  headerActions,
  tabs,
  scope,
  marketplaceFilter,
  className,
}: MarketplaceBrowsePageProps) {
  const { t } = useTranslation()
  return (
    <div className={cn('flex flex-col gap-4 p-5 max-w-[860px] mx-auto w-full', className)}>
      {/* Page title + subtitle, with right-aligned header actions (Create ▾) */}
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-0.5 min-w-0">
          <h1 className="text-lg font-semibold">{title}</h1>
          {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
        </div>
        {headerActions && <div className="shrink-0 flex items-center gap-2">{headerActions}</div>}
      </div>

      {/* Top-level marketplace SELECTOR (Skills Market | <registry> | …).
          Horizontally scrollable so many registries never wrap the header; the
          caller narrows the sections it passes to the selected marketplace and
          scopes the kind tabs below. */}
      {marketplaceFilter && marketplaceFilter.options.length > 1 && (
        <div className="-mx-1 flex items-center gap-1.5 overflow-x-auto px-1 pb-0.5" data-testid="marketplace-filter">
          {marketplaceFilter.options.map((option) => {
            const active = option.id === marketplaceFilter.active
            // An OFFER is a delivered catalog nobody has turned on. It is not a
            // selection: the dashed edge and the badge are the off state, and
            // the click enables it. Nothing is fetched until then.
            if (option.offered) {
              const busy = marketplaceFilter.enabling?.includes(option.id) ?? false
              return (
                <button
                  key={option.id}
                  type="button"
                  disabled={busy}
                  onClick={() => marketplaceFilter.onEnable?.(option.id)}
                  title={option.description}
                  aria-label={marketplaceFilter.enableLabel
                    ? `${marketplaceFilter.enableLabel}: ${option.label}`
                    : option.label}
                  data-testid="marketplace-filter-offer"
                  data-filter-id={option.id}
                  className={cn(
                    'shrink-0 rounded-full border border-dashed px-3 py-1 text-xs font-medium transition-colors whitespace-nowrap',
                    'border-border/60 text-muted-foreground hover:text-foreground hover:bg-foreground/5',
                    'disabled:opacity-60 disabled:pointer-events-none',
                    'inline-flex items-center gap-1.5',
                  )}
                >
                  {busy
                    ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                    : <Plus className="h-3 w-3" aria-hidden="true" />}
                  {option.label}
                  {marketplaceFilter.offeredLabel && (
                    <span className="rounded-full bg-foreground/10 px-1.5 py-0.5 text-[10px] font-normal">
                      {marketplaceFilter.offeredLabel}
                    </span>
                  )}
                </button>
              )
            }
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => marketplaceFilter.onChange?.(option.id)}
                aria-pressed={active}
                data-testid="marketplace-filter-chip"
                data-filter-id={option.id}
                className={cn(
                  'shrink-0 rounded-full border px-3 py-1 text-xs font-medium transition-colors whitespace-nowrap',
                  active
                    ? 'border-transparent bg-foreground/10 text-foreground'
                    : 'border-border/60 text-muted-foreground hover:text-foreground hover:bg-foreground/5',
                )}
              >
                {option.label}
              </button>
            )
          })}
        </div>
      )}

      {/* Kind tabs (Plugins | Skills), SCOPED to the selected marketplace, +
          scope (Public | Personal) — Codex top row. A kind the marketplace does
          not carry renders disabled with a subtle note beside the tabs. */}
      {(tabs || scope) && (
        <div className="flex items-center gap-3">
          {tabs && (
            <div className="flex items-center gap-2">
              <Segmented<MarketplaceBrowseTab>
                value={tabs.active}
                onChange={tabs.onChange}
                testid="marketplace-tabs"
                options={[
                  { value: 'plugins', label: tabs.pluginsLabel, disabled: tabs.disabled?.plugins },
                  {
                    value: 'skills',
                    label: tabs.skillsLabel,
                    disabled: tabs.disabled?.skills,
                    title: tabs.disabled?.skills ? tabs.note : undefined,
                  },
                ]}
              />
              {tabs.note && (
                <span className="text-xs text-muted-foreground" data-testid="marketplace-tabs-note">
                  {tabs.note}
                </span>
              )}
            </div>
          )}
          {scope && (
            <Segmented<MarketplaceBrowseScope>
              value={scope.active}
              onChange={scope.onChange}
              testid="marketplace-scope"
              options={[
                { value: 'public', label: scope.publicLabel },
                { value: 'personal', label: scope.personalLabel },
              ]}
            />
          )}
        </div>
      )}

      {/* Pill search (Codex full-radius; our Input) */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
        <Input
          value={query}
          onChange={(e) => onQueryChange?.(e.target.value)}
          placeholder={searchPlaceholder}
          className="rounded-full pl-9 pr-9"
          data-testid="marketplace-search"
        />
        {query.length > 0 && (
          <button
            type="button"
            onClick={() => onQueryChange?.('')}
            aria-label={t('common.clearSearch')}
            data-testid="marketplace-search-clear"
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground focus:outline-none"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Installed strip — only when the caller supplies one */}
      {installedStrip && installedStrip.entries.length > 0 && (
        <MarketplaceInstalledStrip
          title={installedStrip.title}
          entries={installedStrip.entries}
          manageLabel={installedStrip.manageLabel}
          onManage={installedStrip.onManage}
          onOpen={installedStrip.onOpenInstalled}
        />
      )}

      {/* Body states */}
      {status === 'loading' && (
        <div className="grid gap-3 md:grid-cols-2" data-testid="marketplace-loading">
          {Array.from({ length: 6 }, (_, i) => (
            <CardSkeleton key={i} />
          ))}
        </div>
      )}

      {status === 'error' && (
        <Info_Alert variant="error" data-testid="marketplace-error">
          <div className="flex items-center justify-between gap-3">
            <Info_Alert.Title>{errorMessage}</Info_Alert.Title>
            {onRetry && (
              <Button variant="outline" size="sm" onClick={onRetry} data-testid="marketplace-retry">
                {retryLabel}
              </Button>
            )}
          </div>
        </Info_Alert>
      )}

      {status === 'empty' && (
        // Codex no-results: a single quiet muted line, sections hidden.
        <p className="py-8 text-center text-sm text-muted-foreground" data-testid="marketplace-empty">
          {emptyMessage}
        </p>
      )}

      {/* Partial-state note (R3): some registries failed but the list still renders. */}
      {status === 'ready' && loadErrorNote && (
        <Info_Alert variant="warning" data-testid="marketplace-load-error-note">
          <Info_Alert.Title>{loadErrorNote}</Info_Alert.Title>
        </Info_Alert>
      )}

      {status === 'ready' &&
        sections.map((section) => (
          <section key={section.id} className="flex flex-col gap-3" data-testid="marketplace-section">
            <SectionHeader title={section.title} count={section.count} actions={section.actions} />
            {section.note && (
              <p className="text-xs text-muted-foreground" data-testid="marketplace-section-note">
                {section.note}
              </p>
            )}
            <div className="grid gap-3 md:grid-cols-2">
              {section.cards.map((card) => (
                <MarketplaceBrowseCard key={card.id} {...card} />
              ))}
            </div>
          </section>
        ))}
    </div>
  )
}
