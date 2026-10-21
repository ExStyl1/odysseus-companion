/**
 * Playground support for the SOURCES MANAGEMENT rows (U4).
 *
 * Owner direction (2026-07-19): do NOT invent a separate playground section —
 * EXTEND the existing "Entity Lists → Source List" entry with the management
 * elements (enable/disable + origin) instead. This module therefore exports:
 *
 *   1. `SourceManagementRowsDemo` — the state-rich management row column that
 *      the Source List entry embeds behind its `management` knob (rows are
 *      `SourcesManagementRow`, i.e. the same EntityRow the real panel renders,
 *      extended with the toggle/menu affordance). Since 2026-08-01 the card
 *      itself is the shared one: the category derived from the summary, the
 *      description, and NOTHING else beside the name — since UB12.74 on
 *      v0.15.1's row anatomy (the category is the title meta, line 2 the
 *      description, or the row's notes in its place).
 *   2. The "Plugins Subsection List" entry (category: Entity Lists) — the body
 *      the future `sourcesPlugins` sub-route renders, populated + empty.
 *
 * Enablement (owner decision 2026-07-19): NO inline switch — Enable/Disable
 * lives in the EntityRow "…" / right-click menu (the AutomationMenu pattern);
 * a disabled row dims.
 *
 * Dark theme is the review target. Nothing here touches window.electronAPI —
 * toggles/clicks are console callbacks; app integration wires the real
 * enablement mutations in a later slice after owner playground approval.
 */

import * as React from 'react'
import { Boxes, Cloud, Database, FolderOpen, Plug } from 'lucide-react'
// Import from specific module paths (NOT the info barrel): the barrel
// re-exports CapabilityResources → EditPopover → ThemeContext, whose Vite
// `import.meta.glob` runs at module scope and breaks the bun registry test.
import {
  SourcesManagementRow,
  type SourceManagementEnablement,
} from '@/components/info/SourcesManagementRow'
import {
  SourcesManagementRowList,
  type SourcesManagementRowEntry,
} from '@/components/info/SourcesManagementRowList'
import { useMenuComponents } from '@/components/ui/menu-context'
import { cn } from '@/lib/utils'
import type { SafeCapabilitySummary } from '@nessy-agent/shared/protocol/capabilities'
import type { ComponentEntry } from './types'

const WS = 'playground-workspace'

// ============================================================================
// Mock icon tile (EntityRow's icon slot sizes children to 12px — mirror the
// entity-lists MockAvatar shape)
// ============================================================================

function MockTile({
  icon: Icon,
  color,
}: {
  icon: React.ComponentType<{ className?: string }>
  color: string
}) {
  return (
    <div className="rounded-[4px] ring-1 ring-border/30 shrink-0 flex items-center justify-center bg-muted">
      <Icon className={cn('w-3 h-3 p-[1px]', color)} />
    </div>
  )
}

// ============================================================================
// Mock summaries per row kind (path-free SafeCapabilitySummary)
// ============================================================================

const pluginSummary: SafeCapabilitySummary = {
  key: 'plugin:devtools-suite',
  kind: 'app',
  logicalName: 'DevTools Suite',
  displayName: 'DevTools Suite',
  description: 'A bundle of skills and MCP servers for full-stack development workflows.',
  origin: 'plugin',
  presentation: { format: 'claude', acquisition: 'repository' },
  scope: { kind: 'workspace', workspaceId: WS },
  state: 'active',
  readOnly: true,
  trustState: 'trusted',
  credentialState: 'not-required',
  selectedAsUnqualifiedAlias: false,
  diagnosticCodes: [],
}

const mcpNativeSummary: SafeCapabilitySummary = {
  key: 'source:local-postgres',
  kind: 'mcp',
  logicalName: 'Postgres',
  displayName: 'Postgres',
  description: 'Local Postgres MCP server declared in .mcp.json.',
  origin: 'native',
  scope: { kind: 'workspace', workspaceId: WS },
  state: 'active',
  readOnly: false,
  trustState: 'trusted',
  credentialState: 'not-required',
  selectedAsUnqualifiedAlias: true,
  diagnosticCodes: [],
}

const connectorSummary: SafeCapabilitySummary = {
  key: 'source:github-connector',
  kind: 'mcp',
  logicalName: 'GitHub',
  displayName: 'GitHub',
  description: 'Repositories, issues, and pull requests over the GitHub MCP server.',
  origin: 'plugin',
  presentation: { format: 'nessy', acquisition: 'nessy-marketplace' },
  connectorOrigin: { pluginKey: 'gh', connectorId: 'github', serverName: 'github', authTiming: 'ON_FIRST_USE' },
  scope: { kind: 'workspace', workspaceId: WS },
  state: 'active',
  readOnly: false,
  trustState: 'trusted',
  credentialState: 'missing',
  selectedAsUnqualifiedAlias: true,
  diagnosticCodes: [],
}

const disabledPluginSummary: SafeCapabilitySummary = {
  ...pluginSummary,
  key: 'plugin:snyk-security',
  logicalName: 'Snyk Security',
  displayName: 'Snyk Security',
  description: 'Dependency and code vulnerability scanning as skills + MCP.',
  presentation: { format: 'codex', acquisition: 'external-marketplace' },
  state: 'disabled',
}

/** R83 — an installed plugin the wire advertises an update for. */
const updatableSummary: SafeCapabilitySummary = {
  ...pluginSummary,
  key: 'plugin:acme-tools',
  logicalName: 'Acme Tools',
  displayName: 'Acme Tools',
  description: 'Scaffolds, linters and CI helpers as skills + MCP.',
  state: 'active',
}

const pendingSummary: SafeCapabilitySummary = {
  ...mcpNativeSummary,
  key: 'source:sentry',
  logicalName: 'Sentry',
  displayName: 'Sentry',
  description: 'Error monitoring over the Sentry MCP server.',
}

const longSummary: SafeCapabilitySummary = {
  key: 'source:very-long',
  kind: 'mcp',
  logicalName: 'Enterprise Knowledge Base Connector with an Exceptionally Long Display Name',
  displayName: 'Enterprise Knowledge Base Connector with an Exceptionally Long Display Name',
  description:
    'This description is intentionally very long so the reviewer can confirm the single-line truncation holds inside the management row without wrapping onto a second line or pushing the scope badge and toggle off the row edge.',
  origin: 'plugin',
  presentation: { format: 'codex', acquisition: 'external-marketplace' },
  connectorOrigin: { pluginKey: 'kb', connectorId: 'kb', serverName: 'knowledge-base', authTiming: 'ON_INSTALL' },
  scope: { kind: 'workspace', workspaceId: WS },
  state: 'active',
  readOnly: false,
  trustState: 'trusted',
  credentialState: 'ready',
  selectedAsUnqualifiedAlias: true,
  diagnosticCodes: [],
}

const apiSummary: SafeCapabilitySummary = {
  key: 'source:linear-api',
  kind: 'source',
  sourceType: 'api',
  logicalName: 'Linear',
  displayName: 'Linear',
  description: 'Issue tracking and project management via the Linear GraphQL API.',
  origin: 'native',
  scope: { kind: 'workspace', workspaceId: WS },
  state: 'active',
  readOnly: false,
  trustState: 'not-required',
  credentialState: 'ready',
  selectedAsUnqualifiedAlias: true,
  diagnosticCodes: [],
}

const localSummary: SafeCapabilitySummary = {
  key: 'source:project-docs',
  kind: 'source',
  sourceType: 'local',
  logicalName: 'Project Docs',
  displayName: 'Project Docs',
  description: 'Local documentation folder mounted read-only for grounding answers.',
  origin: 'native',
  scope: { kind: 'workspace', workspaceId: WS },
  state: 'active',
  readOnly: false,
  trustState: 'not-required',
  credentialState: 'not-required',
  selectedAsUnqualifiedAlias: true,
  diagnosticCodes: [],
}

// ============================================================================
// Mock management menu (the AutomationMenu enable/disable pattern)
// ============================================================================

function MockManagementMenu({ name, enabled, scope }: { name: string; enabled: boolean; scope: 'workspace' | 'project' }) {
  const { MenuItem, Separator } = useMenuComponents()
  return (
    <>
      <MenuItem onClick={() => console.log('[Playground] toggle via menu:', name, '→', !enabled)}>
        {enabled ? `Disable in ${scope}` : `Enable in ${scope}`}
      </MenuItem>
      <MenuItem onClick={() => console.log('[Playground] open detail:', name)}>Open Details</MenuItem>
      <Separator />
      <MenuItem variant="destructive" onClick={() => console.log('[Playground] remove:', name)}>Remove</MenuItem>
    </>
  )
}

// ============================================================================
// The management rows demo — embedded by the Source List entry
// ============================================================================

interface DemoRow {
  summary: SafeCapabilitySummary
  icon: React.ComponentType<{ className?: string }>
  color: string
  /** Kinds that carry enablement; api + local are display-only. */
  enablement?: SourceManagementEnablement
  /** R83 — the wire advertises an update for this row's plugin. */
  updateAvailableVersion?: string
}

const DEMO_ROWS: DemoRow[] = [
  { summary: pluginSummary, icon: Boxes, color: 'text-foreground/70', enablement: { enabled: true, scope: 'workspace' } },
  { summary: mcpNativeSummary, icon: Database, color: 'text-accent', enablement: { enabled: true, scope: 'workspace' } },
  { summary: connectorSummary, icon: Plug, color: 'text-accent', enablement: { enabled: true, scope: 'workspace', awaitingAuth: true } },
  { summary: disabledPluginSummary, icon: Boxes, color: 'text-foreground/70', enablement: { enabled: false, scope: 'project' } },
  { summary: pendingSummary, icon: Database, color: 'text-accent', enablement: { enabled: true, scope: 'workspace', pending: true } },
  { summary: updatableSummary, icon: Boxes, color: 'text-foreground/70', enablement: { enabled: true, scope: 'workspace' }, updateAvailableVersion: '2.4.0' },
  { summary: longSummary, icon: Plug, color: 'text-accent', enablement: { enabled: false, scope: 'workspace', error: true } },
  { summary: apiSummary, icon: Cloud, color: 'text-success' },
  { summary: localSummary, icon: FolderOpen, color: 'text-info' },
]

export function SourceManagementRowsDemo() {
  return (
    <>
      {DEMO_ROWS.map((row, index) => {
        const name = row.summary.displayName ?? row.summary.logicalName
        const enabled = row.enablement?.enabled ?? row.summary.state === 'active'
        return (
          <SourcesManagementRow
            key={row.summary.key}
            summary={row.summary}
            displayName={name}
            avatar={<MockTile icon={row.icon} color={row.color} />}
            showSeparator={index > 0}
            onClick={() => console.log('[Playground] open detail:', row.summary.key)}
            enablement={row.enablement}
            updateAvailableVersion={row.updateAvailableVersion}
            menu={
              row.enablement
                ? <MockManagementMenu name={name} enabled={enabled} scope={row.enablement.scope} />
                : undefined
            }
          />
        )
      })}
    </>
  )
}

// ============================================================================
// Plugins-subsection list preview (populated + empty)
// ============================================================================

const PLUGIN_LIST_ROWS: SourcesManagementRowEntry[] = [
  {
    id: pluginSummary.key,
    summary: pluginSummary,
    displayName: 'DevTools Suite',
    avatar: <MockTile icon={Boxes} color="text-foreground/70" />,
    onClick: () => console.log('[Playground] open plugin detail'),
    enablement: { enabled: true, scope: 'workspace' },
    menu: <MockManagementMenu name="DevTools Suite" enabled scope="workspace" />,
  },
  {
    id: connectorSummary.key,
    summary: connectorSummary,
    displayName: 'GitHub',
    avatar: <MockTile icon={Plug} color="text-accent" />,
    onClick: () => console.log('[Playground] open connector detail'),
    enablement: { enabled: true, scope: 'workspace', awaitingAuth: true },
    menu: <MockManagementMenu name="GitHub" enabled scope="workspace" />,
  },
  {
    id: disabledPluginSummary.key,
    summary: disabledPluginSummary,
    displayName: 'Snyk Security',
    avatar: <MockTile icon={Boxes} color="text-foreground/70" />,
    onClick: () => console.log('[Playground] open snyk detail'),
    enablement: { enabled: false, scope: 'project' },
    menu: <MockManagementMenu name="Snyk Security" enabled={false} scope="project" />,
  },
  {
    id: updatableSummary.key,
    summary: updatableSummary,
    displayName: 'Acme Tools',
    avatar: <MockTile icon={Boxes} color="text-foreground/70" />,
    onClick: () => console.log('[Playground] open acme detail'),
    enablement: { enabled: true, scope: 'workspace' },
    // R83 — the update note, in the row's own note family (beside awaiting-auth
    // and the enablement error) on line 2, never in the title meta.
    updateAvailableVersion: '2.4.0',
    menu: <MockManagementMenu name="Acme Tools" enabled scope="workspace" />,
  },
]

interface ListPreviewProps {
  empty?: boolean
  selectedIndex?: number
}

function SourcesManagementListPreview({ empty = false, selectedIndex = -1 }: ListPreviewProps) {
  const selectedId = PLUGIN_LIST_ROWS[selectedIndex]?.id ?? null
  return (
    // The panel frame from the Entity Lists previews — the list body is the
    // same EntityRow column the real Sources panel renders.
    <div className="w-[420px] min-h-[280px] flex flex-col border border-border rounded-lg overflow-hidden bg-background">
      {/* Headerless, exactly like production: no other Sources subsection
          carries a title + blurb above its rows (owner report 2026-08-01). */}
      <SourcesManagementRowList rows={empty ? [] : PLUGIN_LIST_ROWS} selectedId={selectedId} />
    </div>
  )
}

// ============================================================================
// Registry entries (category: Entity Lists — beside the Source List entry)
// ============================================================================

export const sourcesManagementComponents: ComponentEntry[] = [
  {
    id: 'entity-list-plugins-subsection',
    name: 'Plugins Subsection List',
    category: 'Entity Lists',
    description:
      'The plugins-subsection body the sourcesPlugins sub-route renders: installed plugins on the ONE Sources card (icon, name, the category meta, line 2 the description or the row\'s note — UB12.74) plus the row menu, with an honest empty state and no section header. The open plugin\'s row is highlighted with EntityRow\'s own selected treatment (accent bar + tinted background) — the same one every sibling list draws.',
    component: SourcesManagementListPreview,
    layout: 'centered',
    props: [
      { name: 'empty', description: 'Empty state (no plugins installed)', control: { type: 'boolean' }, defaultValue: false },
      { name: 'selectedIndex', description: 'Which row\'s detail page is open (-1 = none) — the highlight the subsection was missing', control: { type: 'number', min: -1, max: 2 }, defaultValue: -1 },
    ],
    variants: [
      { name: 'Populated', description: 'Installed plugins on the ONE card (enabled, disabled, awaiting-auth) — same skeleton as Sources/MCPs/Skills', props: { empty: false, selectedIndex: -1 } },
      { name: 'Selected', description: 'The open plugin\'s row highlighted — accent bar + tinted background, exactly as in Sources/MCPs/Skills', props: { empty: false, selectedIndex: 1 } },
      { name: 'Empty', description: 'No plugins installed — honest placeholder, section still present', props: { empty: true, selectedIndex: -1 } },
    ],
  },
]
