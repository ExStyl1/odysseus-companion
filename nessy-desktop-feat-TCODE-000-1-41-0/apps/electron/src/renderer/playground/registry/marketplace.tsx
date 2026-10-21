/**
 * Playground registry for the U5 MARKETPLACE surfaces (browse + installed strip
 * + detail with skill preview). Codex-verified STRUCTURE, OUR tokens/components
 * (MarketplaceBrowsePage/Card/InstalledStrip/Detail; PluginOriginBadge,
 * CapabilityContentPanel, Info_Section/Table, our Button/Input).
 *
 * Category: 'Marketplace' (added to the categoryOrder allow-list in
 * registry/index.ts, else it silently doesn't render).
 *
 * IPC-free: nothing here touches window.electronAPI — install/open/manage are
 * console callbacks, and the search query knob just filters the mock cards
 * client-side (real search stays SERVER-side per the spec). Display strings are
 * supplied by mock data directly (English), like the entity-lists samples — no
 * new i18n keys in this slice. Dark theme is the review target.
 */

import * as React from 'react'
import { AtSign, Boxes, ChevronDown, Cloud, Loader2, Plug, Plus, RefreshCw, Sparkles, Trash2 } from 'lucide-react'
import {
  MarketplaceBrowsePage,
  type MarketplaceBrowseSection,
} from '@/components/marketplace/MarketplaceBrowsePage'
import { Button } from '@/components/ui/button'
import type { MarketplaceCardInstallState } from '@/components/marketplace/MarketplaceBrowseCard'
import { MarketplaceDetail } from '@/components/marketplace/MarketplaceDetail'
import { MarketplaceSkillPreviewModal } from '@/components/marketplace/MarketplaceSkillPreviewModal'
import { MarketplaceAddDialog } from '@/components/marketplace/MarketplaceAddDialog'
import type { MarketplaceInstalledEntry } from '@/components/marketplace/MarketplaceInstalledStrip'
// Specific paths (not the info barrel) — the barrel breaks bun registry tests.
import { PluginComponentsSection } from '@/components/info/PluginComponentsSection'
import type { CapabilityContentPanelStatus } from '@/components/info/CapabilityContentPanel'
import type { CapabilityContentFileRef } from '@/components/info/CapabilityContentPanel'
import { cn } from '@/lib/utils'
import type { SafePluginPresentationOrigin } from '@nessy-agent/shared/protocol/capabilities'
import type { ComponentEntry } from './types'

// ============================================================================
// Mock icon tile (IPC-free; mirrors the app's rounded ring avatar convention)
// ============================================================================

function MockTile({
  icon: Icon,
  color,
}: {
  icon: React.ComponentType<{ className?: string }>
  color: string
}) {
  return (
    <div className="h-full w-full flex items-center justify-center bg-muted">
      <Icon className={cn('w-4 h-4', color)} />
    </div>
  )
}

// ============================================================================
// Mock catalog rows (display strings inline — English, like entity-lists)
// ============================================================================

interface MockCard {
  id: string
  name: string
  description: string
  icon: React.ComponentType<{ className?: string }>
  color: string
  presentation?: SafePluginPresentationOrigin
  tenant?: string
  installState: MarketplaceCardInstallState
  blockedReason?: string
  /**
   * P6.519/P6.424 — the relevance pin. Two labels, because the two signals this
   * fork decides say different things: `cwd` ("Suggested for this directory")
   * and `manifestDeps` ("Suggested for your dependencies"). `suggestionDetail`
   * is the chip's tooltip, which names the three signals we do NOT decide, so
   * the narrowing is visible on the surface rather than inferred.
   */
  suggestionLabel?: string
  suggestionDetail?: string
}

const CARDS: MockCard[] = [
  {
    id: 'aspnet-web-api',
    name: 'ASP.NET Web API',
    description: 'Scaffold and refine ASP.NET Core Web API projects with idiomatic controllers, DI, and tests.',
    icon: Sparkles,
    color: 'text-accent',
    presentation: { format: 'codex', acquisition: 'external-marketplace' },
    installState: 'not-installed',
    // The `cwd` pin — the only signal that can match at session start.
    suggestionLabel: 'Suggested for this directory',
    suggestionDetail: 'Matched on the working directory and the project\'s declared dependencies. Not matched: cli, hosts, filesRead.',
  },
  {
    id: 'github-connector',
    name: 'GitHub',
    description: 'Repositories, issues, and pull requests over the GitHub MCP server.',
    icon: Plug,
    color: 'text-accent',
    presentation: { format: 'nessy', acquisition: 'nessy-marketplace' },
    installState: 'installed',
    // The `manifestDeps` pin, beside the `cwd` one, so the two chips can be
    // read against each other at the same width.
    suggestionLabel: 'Suggested for your dependencies',
    suggestionDetail: 'Matched on the working directory and the project\'s declared dependencies. Not matched: cli, hosts, filesRead.',
  },
  {
    id: 'devtools-suite',
    name: 'DevTools Suite',
    description: 'A bundle of skills and MCP servers for full-stack development workflows.',
    icon: Boxes,
    color: 'text-foreground/70',
    presentation: { format: 'claude', acquisition: 'repository' },
    installState: 'installing',
  },
  {
    id: 'linear-api',
    name: 'Linear',
    description: 'Issue tracking and project management via the Linear GraphQL API.',
    icon: Cloud,
    color: 'text-success',
    presentation: { format: 'nessy', acquisition: 'nessy-marketplace' },
    installState: 'not-installed',
  },
  {
    id: 'snyk-security',
    name: 'Snyk Security',
    description: 'Dependency and code vulnerability scanning as skills + MCP.',
    icon: Boxes,
    color: 'text-foreground/70',
    presentation: { format: 'codex', acquisition: 'external-marketplace' },
    installState: 'blocked',
    blockedReason: 'Blocked by workspace policy — ask an admin to allow this marketplace.',
  },
  {
    id: 'postgres-mcp',
    name: 'Postgres',
    description: 'Query and inspect a local Postgres database over MCP.',
    icon: Plug,
    color: 'text-accent',
    presentation: { format: 'nessy', acquisition: 'nessy-marketplace' },
    tenant: 'green-pt',
    installState: 'not-installed',
  },
]

// Skills tab deck (Codex Plugins | Skills split — our MarketplaceListKind
// 'skills'). Standalone skills, not plugin bundles.
const SKILL_CARDS: MockCard[] = [
  {
    id: 'code-review',
    name: 'Code Review',
    description: 'Adversarial review checklist for correctness, security, and over-engineering.',
    icon: Sparkles,
    color: 'text-accent',
    presentation: { format: 'nessy', acquisition: 'nessy-marketplace' },
    installState: 'not-installed',
  },
  {
    id: 'release-notes',
    name: 'Release Notes',
    description: 'Draft user-facing release notes from a merged changelog.',
    icon: Sparkles,
    color: 'text-accent',
    presentation: { format: 'nessy', acquisition: 'nessy-marketplace' },
    installState: 'installed',
  },
  {
    id: 'sql-tuning',
    name: 'SQL Tuning',
    description: 'Explain-plan driven query optimization for Postgres and MySQL.',
    icon: Sparkles,
    color: 'text-accent',
    presentation: { format: 'codex', acquisition: 'external-marketplace' },
    installState: 'not-installed',
  },
]

const INSTALLED_ENTRIES: MarketplaceInstalledEntry[] = [
  { id: 'github-connector', name: 'GitHub', icon: <MockTile icon={Plug} color="text-accent" /> },
  // R83 — the update dot: presence of `updateLabel` is the whole indicator,
  // and the sentence rides the tile's tooltip/accessible name. UB12.84: the
  // tile's amber is `text-info` (v0.15.1's amber role); `text-warning` drew
  // nothing, as tokens.css defines no warning colour.
  { id: 'sentry', name: 'Sentry', icon: <MockTile icon={Boxes} color="text-info" />, updateLabel: 'Update available: 2.4.0' },
  { id: 'project-docs', name: 'Project Docs', icon: <MockTile icon={Cloud} color="text-info" /> },
]

// Bring-your-own registry decks (R3): plugins that came from an added
// marketplace, grouped under a per-registry section beside the built-in market.
const REGISTRY_CARDS: MockCard[] = [
  {
    id: 'acme:toolkit',
    name: 'Acme Toolkit',
    description: 'Internal Acme developer toolkit — scaffolds, linters, and CI helpers.',
    icon: Boxes,
    color: 'text-accent',
    installState: 'not-installed',
  },
  {
    id: 'acme:release-bot',
    name: 'Release Bot',
    description: 'Automate changelog + release-note drafting from merged PRs.',
    icon: Sparkles,
    color: 'text-accent',
    installState: 'installed',
  },
]

/** A per-registry Upgrade / Remove affordance rendered in the section header (R3). */
function RegistryActions({ upgrading }: { upgrading?: boolean }) {
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        disabled={upgrading}
        onClick={() => console.log('[Playground] upgrade registry')}
        data-testid="marketplace-registry-upgrade"
      >
        {upgrading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
        Upgrade
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => console.log('[Playground] remove registry')}
        data-testid="marketplace-registry-remove"
      >
        <Trash2 className="h-3.5 w-3.5" />
        Remove
      </Button>
    </>
  )
}

function toSection(cards: MockCard[]): MarketplaceBrowseSection[] {
  const [featured, ...rest] = cards
  return [
    {
      id: 'featured',
      title: 'Featured',
      cards: [featured, rest[0]].filter(Boolean).map(toCardProps),
    },
    {
      id: 'productivity',
      title: 'Productivity',
      count: rest.length - 1,
      cards: rest.slice(1).map(toCardProps),
    },
  ].filter((s) => s.cards.length > 0)
}

function toCardProps(card: MockCard) {
  return {
    id: card.id,
    icon: <MockTile icon={card.icon} color={card.color} />,
    name: card.name,
    description: card.description,
    presentation: card.presentation,
    tenant: card.tenant,
    installState: card.installState,
    installLabel: card.id === 'github-connector' || card.id === 'postgres-mcp' ? 'Connect' : 'Install',
    installedLabel: 'Installed',
    installingLabel: 'Installing…',
    blockedReason: card.blockedReason,
    suggestionLabel: card.suggestionLabel,
    suggestionDetail: card.suggestionDetail,
    onInstall: (id: string) => console.log('[Playground] install:', id),
    onOpen: (id: string) => console.log('[Playground] open detail:', id),
  }
}

// ============================================================================
// Browse page preview (knobs → all list states)
// ============================================================================

type BrowseState = 'populated' | 'searching' | 'mixed' | 'loading' | 'empty' | 'error'

interface BrowsePreviewProps {
  state?: BrowseState
  query?: string
  showInstalledStrip?: boolean
  addMarketplaceOpen?: boolean
  showTabs?: boolean
  /** A bring-your-own registry is configured → the marketplace selector renders. */
  showRegistries?: boolean
  /** The registry section's Upgrade affordance is mid-fetch. */
  registryUpgrading?: boolean
  /** The selected registry's catalog failed to load (per-section note). */
  registryLoadError?: boolean
  /** Start ON the registry marketplace (vs the default built-in Skills Market). */
  startInRegistry?: boolean
  /**
   * P6.517 / P6.518 — a DELIVERED-but-off catalog is on offer. It renders as a
   * dashed chip with a "Not added" badge; clicking it enables (it does not
   * select). The selector row shows for an offer alone, with no registry.
   */
  showOffer?: boolean
  /** That offer's enable click is in flight (spinner in place of the plus). */
  offerEnabling?: boolean
}

function MarketplaceBrowsePreview({
  state = 'populated',
  query: initialQuery = '',
  showInstalledStrip = true,
  addMarketplaceOpen = false,
  showTabs = true,
  showRegistries = false,
  registryUpgrading = false,
  registryLoadError = false,
  startInRegistry = false,
  showOffer = false,
  offerEnabling = false,
}: BrowsePreviewProps) {
  // Marketplace-first selector (design-only): the TOP-LEVEL chip row picks ONE
  // marketplace — 'skills-market' = built-in (default), 'acme' = a registry.
  // There is NO cross-market "All".
  const [mpFilter, setMpFilter] = React.useState(startInRegistry && showRegistries ? 'acme' : 'skills-market')
  React.useEffect(
    () => setMpFilter(startInRegistry && showRegistries ? 'acme' : 'skills-market'),
    [startInRegistry, showRegistries],
  )
  // The query knob filters the mock cards CLIENT-side (real search is
  // server-side per the spec) so the reviewer can see search regrouping.
  const [query, setQuery] = React.useState(initialQuery)
  React.useEffect(() => setQuery(initialQuery), [initialQuery])

  // "Create ▾" header dropdown → Add marketplace dialog (design only; the
  // registry backend is the 1.10.0 ADDENDUM candidate).
  const [menuOpen, setMenuOpen] = React.useState(false)
  const [addOpen, setAddOpen] = React.useState(addMarketplaceOpen)
  React.useEffect(() => setAddOpen(addMarketplaceOpen), [addMarketplaceOpen])

  // Plugins | Skills tab + Public | Personal scope (Codex top row). The tab
  // switches the listing kind (our MarketplaceService `kind`); here it swaps
  // the mock deck so the reviewer sees the split.
  const [tab, setTab] = React.useState<'plugins' | 'skills'>('plugins')
  const [scope, setScope] = React.useState<'public' | 'personal'>('public')

  const status =
    state === 'loading' ? 'loading' : state === 'empty' ? 'empty' : state === 'error' ? 'error' : 'ready'

  // The selector renders whenever a registry is configured (matches the app:
  // the built-in Skills Market alone stays implicit, no selector).
  // …or whenever a delivered catalog is still off: the offer chip IS the only
  // affordance that turns it on, so hiding the row would hide the feature.
  const selectorVisible = showRegistries || showOffer
  const activeMarket = selectorVisible ? mpFilter : 'skills-market'
  const isRegistry = activeMarket !== 'skills-market'
  // Registries feed plugins only today → the Skills tab is disabled inside a
  // registry (data-driven in the app; hard-coded here for the design surface).
  const skillsDisabled = isRegistry
  const effectiveTab = skillsDisabled ? 'plugins' : tab

  // Built-in market deck: 'mixed' shows every install state; the tab picks
  // plugins vs skills. Registry deck: the bring-your-own plugins.
  const deck = effectiveTab === 'skills' ? SKILL_CARDS : CARDS
  const filterCards = (cards: MockCard[]) =>
    query.trim().length > 0
      ? cards.filter((c) => (c.name + ' ' + c.description).toLowerCase().includes(query.trim().toLowerCase()))
      : cards

  // Sections are scoped to the SELECTED marketplace — exactly one bucket.
  const sections: MarketplaceBrowseSection[] = isRegistry
    ? [{
        id: 'registry:acme',
        title: 'Acme Registry',
        actions: <RegistryActions upgrading={registryUpgrading} />,
        note: registryLoadError ? 'This marketplace could not be loaded.' : undefined,
        cards: registryLoadError ? [] : filterCards(REGISTRY_CARDS).map(toCardProps),
      }]
    : toSection(filterCards(deck))

  // The empty/searching-empty states: quiet no-results line. A registry section
  // stays visible even with zero cards (so Upgrade / Remove stay reachable).
  const effectiveStatus =
    status === 'ready' && !isRegistry && sections.every((s) => s.cards.length === 0) ? 'empty' : status

  const marketplaceFilterProp = selectorVisible
    ? {
        active: activeMarket,
        options: [
          { id: 'skills-market', label: 'Skills Market' },
          ...(showRegistries ? [{ id: 'acme', label: 'Acme Registry' }] : []),
          ...(showOffer
            ? [{
                id: 'claude-plugins-official',
                label: 'claude-plugins-official',
                offered: true,
                description: 'The official Anthropic plugin marketplace.',
              }]
            : []),
        ],
        onChange: setMpFilter,
        onEnable: (id: string) => console.log('[playground] enable offer', id),
        offeredLabel: 'Not added',
        enableLabel: 'Enable this marketplace',
        ...(offerEnabling ? { enabling: ['claude-plugins-official'] } : {}),
      }
    : undefined

  return (
    <div className="h-[760px] w-full overflow-y-auto bg-background">
      <MarketplaceBrowsePage
        title="Marketplace"
        subtitle="Discover and install skills, plugins, and connectors."
        status={effectiveStatus}
        marketplaceFilter={marketplaceFilterProp}
        query={query}
        searchPlaceholder="Search the marketplace…"
        onQueryChange={setQuery}
        tabs={
          showTabs
            ? {
                active: effectiveTab,
                pluginsLabel: 'Plugins',
                skillsLabel: 'Skills',
                onChange: setTab,
                ...(skillsDisabled
                  ? { disabled: { skills: true }, note: 'This marketplace has no skills' }
                  : {}),
              }
            : undefined
        }
        scope={
          showTabs
            ? { active: scope, publicLabel: 'Public', personalLabel: 'Personal', onChange: setScope }
            : undefined
        }
        headerActions={
          <div className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              className="inline-flex items-center gap-1 h-8 px-3 rounded-full bg-background shadow-minimal text-sm font-medium hover:bg-foreground/[0.03]"
              data-testid="marketplace-create"
            >
              Create
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-9 z-10 w-52 rounded-[8px] bg-background shadow-minimal border border-border/50 p-1">
                <button
                  type="button"
                  onClick={() => { setMenuOpen(false); console.log('[Playground] create plugin') }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-sm rounded-[6px] hover:bg-foreground/5"
                >
                  <AtSign className="h-3.5 w-3.5 text-muted-foreground" /> Create plugin
                </button>
                <button
                  type="button"
                  onClick={() => { setMenuOpen(false); setAddOpen(true) }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-sm rounded-[6px] hover:bg-foreground/5"
                  data-testid="marketplace-add-open"
                >
                  <Plus className="h-3.5 w-3.5 text-muted-foreground" /> Add marketplace
                </button>
              </div>
            )}
          </div>
        }
        installedStrip={
          showInstalledStrip
            ? {
                title: 'Installed',
                entries: INSTALLED_ENTRIES,
                manageLabel: 'Manage in Sources',
                onManage: () => console.log('[Playground] manage in Sources'),
                onOpenInstalled: (id) => console.log('[Playground] open installed:', id),
              }
            : undefined
        }
        sections={sections}
        emptyMessage="No results found"
        errorMessage="Failed to load the marketplace"
        retryLabel="Retry"
        onRetry={() => console.log('[Playground] retry marketplace')}
      />
      <MarketplaceAddDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        title="Add plugin marketplace"
        description={<>Add from a GitHub repo, Git URL, or local folder. <a className="text-accent" href="#" onClick={(e) => e.preventDefault()}>Learn more</a></>}
        sourceLabel="Source"
        sourcePlaceholder="openai/plugins or git@github.com:org/repo.git"
        gitRefLabel="Git ref"
        sparsePathsLabel="Sparse paths"
        sparsePathsPlaceholder="plugins/codex"
        cancelLabel="Cancel"
        submitLabel="Add marketplace"
        onSubmit={(v) => { console.log('[Playground] add marketplace:', v); setAddOpen(false) }}
      />
    </div>
  )
}

// ============================================================================
// Detail preview (knobs → skill-preview content states)
// ============================================================================

const SKILL_MARKDOWN = `# ASP.NET Web API

## Overview

Use this skill when scaffolding or extending an ASP.NET Core Web API. It
enforces idiomatic controllers, constructor dependency injection, and a
test-first workflow. Prefer \`minimal APIs\` for small surfaces and controllers
for larger, versioned APIs.

## Workflow

1. Confirm the target framework (\`net8.0\`) and read \`Program.cs\`.
2. Add the endpoint or controller with DI-injected services.
3. Register the service in the composition root.
4. Add a matching integration test using \`WebApplicationFactory\`.

Inline code like \`services.AddScoped<IClock, SystemClock>()\` should stay
consistent with the existing registration style.`

const SKILL_FILE_REFS: CapabilityContentFileRef[] = [
  { id: 'ref-program', label: 'Program.cs', relativePath: 'src/Api/Program.cs' },
  { id: 'ref-controller', label: 'WeatherController.cs', relativePath: 'src/Api/Controllers/WeatherController.cs' },
  { id: 'ref-tests', label: 'ApiTests.cs', relativePath: 'tests/Api.Tests/ApiTests.cs' },
]

interface DetailPreviewProps {
  contentState?: CapabilityContentPanelStatus
  installed?: boolean
  showStarters?: boolean
  showInformation?: boolean
  showFileRefs?: boolean
  showComponents?: boolean
}

/** Mock skill bodies for the skill-preview modal (key → markdown). */
const COMPONENT_SKILL_MARKDOWN: Record<string, { name: string; description: string; markdown: string }> = {
  'skill:aspnet-web-api': {
    name: 'ASP.NET Web API',
    description: 'Design and review ASP.NET Core Web APIs.',
    markdown: SKILL_MARKDOWN,
  },
  'skill:ef-migrations': {
    name: 'EF Migrations',
    description: 'Author and verify Entity Framework migrations.',
    markdown: '# EF Migrations\n\nAuthor, review, and verify Entity Framework Core migrations.\n\n## When to use\n\n- Adding or altering entities\n- Squashing a long migration chain\n\n## Rules\n\n1. Never edit an applied migration\n2. Verify `dotnet ef migrations script` output before merging',
  },
}

function MarketplaceDetailPreview({
  contentState = 'loaded',
  installed = false,
  showStarters = true,
  showInformation = true,
  showFileRefs = true,
  showComponents = true,
}: DetailPreviewProps) {
  // Skill-preview MODAL (owner request 2026-07-19): clicking a skill in the
  // component inventory opens the Codex-style modal — live in the playground.
  const [previewSkill, setPreviewSkill] = React.useState<string | null>(null)
  const skill = previewSkill ? COMPONENT_SKILL_MARKDOWN[previewSkill] : undefined
  return (
    <div className="h-[760px] w-full overflow-y-auto bg-background">
      <MarketplaceDetail
        icon={<MockTile icon={Sparkles} color="text-accent" />}
        name="ASP.NET Web API"
        tagline="Scaffold and refine ASP.NET Core Web API projects."
        presentation={{ format: 'codex', acquisition: 'external-marketplace' }}
        breadcrumbParent="Plugins"
        actions={
          <>
            <button
              type="button"
              onClick={() => console.log('[Playground] overflow menu')}
              className="h-8 px-2 rounded-md text-sm hover:bg-foreground/5"
            >
              …
            </button>
            <button
              type="button"
              onClick={() => console.log('[Playground] primary CTA')}
              className="h-8 px-3 rounded-full bg-foreground text-background text-sm font-medium hover:bg-foreground/90"
            >
              {installed ? 'Try now' : 'Install'}
            </button>
          </>
        }
        starterPrompts={
          showStarters
            ? [
                'Scaffold a CRUD controller for the Order entity',
                'Add an integration test for the /health endpoint',
                'Review this controller for idiomatic DI',
              ]
            : undefined
        }
        onStarterPrompt={(p) => console.log('[Playground] starter prompt:', p)}
        aboutTitle="About"
        content={{
          status: contentState,
          markdown: SKILL_MARKDOWN,
          fileRefs: showFileRefs ? SKILL_FILE_REFS : undefined,
          onOpenFileRef: (ref) => console.log('[Playground] open file ref:', ref.relativePath),
          onRetry: () => console.log('[Playground] retry preview'),
        }}
        informationTitle="Information"
        information={
          showInformation
            ? [
                { label: 'Developer', value: 'acme' },
                { label: 'Category', value: 'Productivity' },
                { label: 'Version', value: '1.4.0' },
                { label: 'Website', value: 'acme.example' },
              ]
            : undefined
        }
        informationEmpty="No additional information provided."
        componentsSlot={
          showComponents ? (
            <PluginComponentsSection
              groups={[
                {
                  kind: 'skill',
                  items: [
                    { key: 'skill:aspnet-web-api', name: 'ASP.NET Web API', description: 'Design and review ASP.NET Core Web APIs.', icon: <MockTile icon={Sparkles} color="text-accent" />, clickable: true },
                    { key: 'skill:ef-migrations', name: 'EF Migrations', description: 'Author and verify Entity Framework migrations.', icon: <MockTile icon={Sparkles} color="text-accent" />, clickable: true },
                  ],
                },
                {
                  kind: 'hook',
                  items: [
                    { key: 'hook:pre-tool-lint', name: 'pre-tool-lint', description: 'PreToolUse — lints staged edits before writes.' },
                  ],
                },
                {
                  kind: 'connector',
                  items: [
                    { key: 'source:github-connector', name: 'GitHub', description: 'Repositories, issues, and pull requests.' },
                  ],
                },
              ]}
              onOpen={(key) => setPreviewSkill(key)}
            />
          ) : undefined
        }
      />
      <MarketplaceSkillPreviewModal
        open={previewSkill !== null}
        onOpenChange={(open) => { if (!open) setPreviewSkill(null) }}
        name={skill?.name ?? ''}
        kindLabel="Skill"
        description={skill?.description}
        content={{
          status: 'loaded',
          markdown: skill?.markdown ?? '',
          fileRefs: previewSkill === 'skill:aspnet-web-api' ? SKILL_FILE_REFS : undefined,
          onOpenFileRef: (ref) => console.log('[Playground] open file ref:', ref.relativePath),
        }}
        // Installed → Codex-faithful single Close. Not-installed (pre-install
        // preview) → offer Install plugin.
        primaryLabel={installed ? undefined : 'Install plugin'}
        onPrimary={() => console.log('[Playground] skill preview primary CTA')}
        closeLabel="Close"
      />
    </div>
  )
}

// ============================================================================
// Registry entries (category: Marketplace)
// ============================================================================

export const marketplaceComponents: ComponentEntry[] = [
  {
    id: 'marketplace-browse',
    name: 'Marketplace Browse',
    category: 'Marketplace',
    description:
      'Discovery surface: pill search + Installed strip + 2-column card grid across labeled section shelves, with populated / searching / mixed install-states / loading / empty / error states.',
    component: MarketplaceBrowsePreview,
    layout: 'full',
    previewOverflow: 'hidden',
    props: [
      {
        name: 'state',
        description: 'Browse/list state',
        control: {
          type: 'select',
          options: [
            { label: 'Populated', value: 'populated' },
            { label: 'Searching (filter mock)', value: 'searching' },
            { label: 'Mixed install states', value: 'mixed' },
            { label: 'Loading skeleton', value: 'loading' },
            { label: 'Empty (no results)', value: 'empty' },
            { label: 'Error + retry', value: 'error' },
          ],
        },
        defaultValue: 'populated',
      },
      { name: 'query', description: 'Search query (filters mock cards client-side)', control: { type: 'string', placeholder: 'e.g. github' }, defaultValue: '' },
      { name: 'showInstalledStrip', description: 'Show the Installed strip + Manage handoff', control: { type: 'boolean' }, defaultValue: true },
      { name: 'showTabs', description: 'Show the Plugins | Skills tabs + Public | Personal scope (Codex top row)', control: { type: 'boolean' }, defaultValue: true },
      { name: 'addMarketplaceOpen', description: 'Open the "Add plugin marketplace" dialog (Create ▾ → Add marketplace)', control: { type: 'boolean' }, defaultValue: false },
      { name: 'showRegistries', description: 'A bring-your-own registry is configured → the top-level marketplace selector (Skills Market | Acme Registry) renders', control: { type: 'boolean' }, defaultValue: false },
      { name: 'startInRegistry', description: 'Start ON the registry marketplace (Skills tab disabled + note) vs the default built-in Skills Market — needs showRegistries', control: { type: 'boolean' }, defaultValue: false },
      { name: 'registryUpgrading', description: 'The selected registry section Upgrade affordance is mid-fetch', control: { type: 'boolean' }, defaultValue: false },
      { name: 'registryLoadError', description: 'The selected registry catalog failed — per-section note, section stays reachable', control: { type: 'boolean' }, defaultValue: false },
      { name: 'showOffer', description: 'A delivered-but-off catalog is offered → a dashed "Not added" chip whose click ENABLES it (it is not selectable)', control: { type: 'boolean' }, defaultValue: false },
      { name: 'offerEnabling', description: 'That offer\'s enable click is in flight — spinner in place of the plus, chip disabled', control: { type: 'boolean' }, defaultValue: false },
    ],
    variants: [
      { name: 'Populated', description: 'Full deck across Featured + Productivity shelves; mixed installed/not-installed. Use the "Create ▾" header → Add marketplace', props: { state: 'populated', query: '', showInstalledStrip: true } },
      { name: 'Skills tab', description: 'The Plugins | Skills split — switch the tab to see the standalone-skills deck (our MarketplaceService kind:skills)', props: { state: 'populated', showTabs: true } },
      { name: 'Add marketplace dialog', description: 'The Codex-style "Add plugin marketplace" dialog (Source / Git ref / Sparse paths) — Create ▾ → Add marketplace calls ADD_REGISTRY', props: { state: 'populated', addMarketplaceOpen: true } },
      { name: 'Marketplace selector (top-level)', description: 'Marketplace-first IA: the Skills Market | <registry> chip row ABOVE the kind tabs. Default lands on the built-in Skills Market — click the Acme chip to scope into the registry', props: { state: 'populated', showRegistries: true } },
      { name: 'Registry — scoped view', description: 'Inside a registry: the list is scoped to it, the Skills tab is disabled with a subtle note, and the section carries Upgrade / Remove', props: { state: 'populated', showRegistries: true, startInRegistry: true } },
      { name: 'Registry — upgrading', description: 'The registry Upgrade affordance mid git re-fetch (spinner)', props: { state: 'populated', showRegistries: true, startInRegistry: true, registryUpgrading: true } },
      { name: 'Registry — load error', description: 'A registry whose catalog failed — per-section note, section stays reachable (Upgrade / Remove)', props: { state: 'populated', showRegistries: true, startInRegistry: true, registryLoadError: true } },
      { name: 'Registries — none', description: 'No registries added yet — only the built-in Skills Market renders, no selector (Create ▾ → Add marketplace to add one)', props: { state: 'populated', showRegistries: false } },
      { name: 'Offer — delivered but off', description: 'P6.517 / P6.518: a catalog this build ships and has NOT registered. Dashed chip + "Not added" badge, its own row even with no registry; the click enables rather than selects', props: { state: 'populated', showRegistries: false, showOffer: true } },
      { name: 'Offer — enabling', description: 'The enable click mid-flight: spinner in place of the plus, chip disabled so a second click cannot double-register', props: { state: 'populated', showRegistries: false, showOffer: true, offerEnabling: true } },
      { name: 'Offer beside a registry', description: 'The full chip row: built-in Skills Market, a configured registry, and a still-off offer — three visually distinct states side by side', props: { state: 'populated', showRegistries: true, showOffer: true } },
      { name: 'Searching', description: 'Server-side search UX — query regroups sections (mock filter)', props: { state: 'searching', query: 'github' } },
      { name: 'Mixed install states', description: 'Install / Installing… / Installed chip / blocked-with-reason together', props: { state: 'mixed', query: '' } },
      { name: 'Loading skeleton', description: 'Card-shaped skeletons while the list loads', props: { state: 'loading' } },
      { name: 'Empty (no results)', description: 'Quiet single-line no-results treatment, sections hidden', props: { state: 'empty' } },
      { name: 'Error + retry', description: 'Info_Alert with a Retry affordance', props: { state: 'error' } },
      { name: 'No installed strip', description: 'First-run browse with nothing installed yet', props: { state: 'populated', showInstalledStrip: false } },
    ],
  },
  {
    id: 'marketplace-detail',
    name: 'Marketplace Detail',
    category: 'Marketplace',
    description:
      'Plugin/skill detail: breadcrumb + hero (icon/name/badges/actions) + starter-prompt promo pills + full SKILL.md inline (Info_Markdown + maxHeight + fullscreen) with file-ref chips + Information table, across loaded / loading / error / empty preview states.',
    component: MarketplaceDetailPreview,
    layout: 'full',
    previewOverflow: 'hidden',
    props: [
      {
        name: 'contentState',
        description: 'Skill-preview content panel state',
        control: {
          type: 'select',
          options: [
            { label: 'Loaded', value: 'loaded' },
            { label: 'Loading skeleton', value: 'loading' },
            { label: 'Preview error', value: 'error' },
            { label: 'Empty (no preview)', value: 'empty' },
          ],
        },
        defaultValue: 'loaded',
      },
      { name: 'installed', description: 'Installed (primary CTA = Try now) vs not (Install)', control: { type: 'boolean' }, defaultValue: false },
      { name: 'showStarters', description: 'Show the starter-prompt promo pills', control: { type: 'boolean' }, defaultValue: true },
      { name: 'showInformation', description: 'Show Information rows (off = placeholder)', control: { type: 'boolean' }, defaultValue: true },
      { name: 'showFileRefs', description: 'Show SKILL.md file-reference chips', control: { type: 'boolean' }, defaultValue: true },
      { name: 'showComponents', description: 'Show the component inventory (skill rows open the preview modal)', control: { type: 'boolean' }, defaultValue: true },
    ],
    variants: [
      { name: 'Loaded — installed', description: 'Full SKILL.md preview + file-ref chips + Try now CTA + Information', props: { contentState: 'loaded', installed: true, showStarters: true, showInformation: true, showFileRefs: true } },
      { name: 'Components + skill modal', description: 'Component inventory (Skills/Hooks/Connectors); CLICK a skill row → Codex-style preview modal with the full SKILL.md', props: { contentState: 'loaded', installed: false, showComponents: true } },
      { name: 'Loaded — not installed', description: 'Pre-install bounded preview + Install CTA', props: { contentState: 'loaded', installed: false } },
      { name: 'Loading skeleton', description: 'Content panel skeleton while the preview resolves', props: { contentState: 'loading' } },
      { name: 'Preview error', description: 'Preview fails soft to a placeholder + retry', props: { contentState: 'error' } },
      { name: 'Empty preview', description: 'Nothing available pre-install → placeholder (metadata still shows)', props: { contentState: 'empty', showFileRefs: false, installed: false } },
      { name: 'No Information (placeholder)', description: 'Information section renders its in-section placeholder', props: { contentState: 'loaded', showInformation: false, showStarters: false } },
    ],
  },
]
