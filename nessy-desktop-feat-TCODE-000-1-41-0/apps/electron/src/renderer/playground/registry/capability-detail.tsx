/**
 * Playground registry for the UNIVERSAL CAPABILITY DETAIL template (U1).
 *
 * Exercises CapabilityDetailTemplate + CapabilityContentPanel with mock,
 * path-free SafeCapability data across every kind (skill / MCP source / API
 * source / folder source / plugin) and every content state (loaded / loading
 * skeleton / preview error / empty-with-placeholder), plus diagnostics
 * present/absent, and (UB14.48) a source whose last connection test failed.
 * UB14.59: the hero anatomy — the state pill a source page derives from the
 * pip's verdict (ok / warn / off / bad), the type prefixed to the tagline, the
 * header's "⋯" menu (or none), and the page's buttons as hero actions.
 * UB12.75: a source the user switched off (Disabled, off) beside one that is
 * merely not tested (Not Tested, off).
 * UB12.80: a skill's header "⋯" is the real `SkillMenu`, fed by the real
 * `skillMenuProps` for the tier the skill sits in (Delete for a workspace skill,
 * the owning tier's label on a greyed Delete otherwise); its actions only log.
 * Dark theme is the review target.
 *
 * IPC-free: the mock avatars are simple colored tiles and the content panel is
 * callback-driven, so nothing here touches window.electronAPI.
 */

import * as React from 'react'
import { Boxes, Cloud, FolderOpen, Plug, Sparkles } from 'lucide-react'
import { CapabilityDetailTemplate, connectionStatePill } from '@/components/info/CapabilityDetailTemplate'
import { Info_HeaderMenu } from '@/components/info/Info_HeaderMenu'
import { capabilitySummaryDisplayStatus } from '@/components/ui/source-status-indicator'
import { StyledDropdownMenuItem } from '@/components/ui/styled-dropdown'
import { useTranslation } from 'react-i18next'
import { CapabilityMcpToolsSection } from '@/components/info/CapabilityMcpToolsSection'
import { CapabilityPermissionModesSection } from '@/components/info/CapabilityPermissionModesSection'
import { SkillMenu } from '@/components/app-shell/SkillMenu'
import { skillMenuProps, type SkillActions } from '@/hooks/useSkillActions'
import type { SafeSkillRow } from '@/lib/capability-catalog'
import { CapabilityPermissionsSection } from '@/components/info/CapabilityPermissionsSection'
import { PluginComponentsSection } from '@/components/info/PluginComponentsSection'
import { Info_Section } from '@/components/info/Info_Section'
import { Info_Table } from '@/components/info/Info_Table'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type {
  CapabilityContentFileRef,
  CapabilityContentPanelStatus,
  CapabilityMcpToolsState,
  CapabilityMetadataField,
} from '@/components/info'
import type {
  SafeCapabilityDetail,
  SafeCapabilityDiagnostic,
  SafeCapabilitySummary,
} from '@nessy-agent/shared/protocol/capabilities'
import type { ComponentEntry } from './types'

// ============================================================================
// Mock icon tile (IPC-free, mirrors the app's rounded ring avatar convention)
// ============================================================================

function MockTile({
  icon: Icon,
  color,
}: {
  icon: React.ComponentType<{ className?: string }>
  color: string
}) {
  return (
    <div className="grid size-full place-items-center bg-fill-hover">
      <Icon className={cn('size-5', color)} />
    </div>
  )
}

/** Small row tile for the plugin components list (20px, ring — house style). */
function ComponentTile({
  icon: Icon,
  color,
}: {
  icon: React.ComponentType<{ className?: string }>
  color: string
}) {
  return (
    <div className="grid size-5 shrink-0 place-items-center rounded-xs bg-fill-hover ring-1 ring-[var(--border-strong)]">
      <Icon className={cn('size-3', color)} />
    </div>
  )
}

// ============================================================================
// Mock summaries per kind (path-free SafeCapabilitySummary)
// ============================================================================

const WS = 'playground-workspace'

const skillSummary: SafeCapabilitySummary = {
  key: 'skill:aspnet-web-api',
  kind: 'skill',
  logicalName: 'aspnet-web-api',
  displayName: 'ASP.NET Web API',
  description: 'Scaffold and refine ASP.NET Core Web API projects with idiomatic controllers, DI, and tests.',
  origin: 'plugin',
  presentation: { format: 'codex', acquisition: 'external-marketplace' },
  scope: { kind: 'workspace', workspaceId: WS },
  state: 'active',
  readOnly: true,
  trustState: 'trusted',
  credentialState: 'not-required',
  selectedAsUnqualifiedAlias: true,
  diagnosticCodes: [],
}

/**
 * UB12.80 — the tier a skill sits in, which decides its header "⋯": Delete for a native workspace
 * skill, otherwise a greyed Delete naming the owner (P2.439). `plugin` is the base summary above.
 */
const SKILL_TIER_FIELDS: Record<string, Partial<SafeCapabilitySummary>> = {
  plugin: {},
  workspace: { origin: 'native', presentation: undefined, scope: { kind: 'workspace', workspaceId: WS }, readOnly: false },
  global: { origin: 'native', presentation: undefined, scope: { kind: 'global' }, readOnly: true },
  administrator: { origin: 'native', presentation: undefined, scope: { kind: 'builtin' }, readOnly: true },
}

/** The playground's skill actions: IPC-free, they only log. */
const PLAYGROUND_SKILL_ACTIONS: SkillActions = {
  reveal: async (key) => { console.log('[Playground] reveal skill:', key) },
  deleteSkill: async (key) => { console.log('[Playground] delete skill:', key); return false },
}

const mcpSummary: SafeCapabilitySummary = {
  key: 'source:github-mcp',
  kind: 'source',
  sourceType: 'mcp',
  logicalName: 'GitHub',
  description: 'Repositories, issues, pull requests, and code search over the GitHub MCP server.',
  origin: 'plugin',
  presentation: { format: 'nessy', acquisition: 'nessy-marketplace' },
  connectorOrigin: { pluginKey: 'gh', connectorId: 'github', serverName: 'github', authTiming: 'ON_FIRST_USE' },
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

const folderSummary: SafeCapabilitySummary = {
  key: 'source:project-docs',
  kind: 'source',
  sourceType: 'local',
  logicalName: 'Project Docs',
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

const pluginSummary: SafeCapabilitySummary = {
  key: 'plugin:devtools-suite',
  kind: 'app',
  logicalName: 'DevTools Suite',
  description: 'A bundle of skills and MCP servers for full-stack development workflows.',
  origin: 'plugin',
  presentation: { format: 'claude', acquisition: 'repository' },
  scope: { kind: 'workspace', workspaceId: WS },
  state: 'review-required',
  readOnly: true,
  trustState: 'review-required',
  credentialState: 'not-required',
  selectedAsUnqualifiedAlias: false,
  unavailableReason: 'Awaiting trust review before activation.',
  diagnosticCodes: ['trust-review-required'],
}

// ============================================================================
// Mock markdown + file refs
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

const SOURCE_GUIDE_MARKDOWN = `# GitHub source

Grounds the agent in the connected GitHub organization. Prefer read tools for
inspection and confirm before any write (issue/PR creation).

- Use \`search_code\` before \`get_file_contents\` to locate symbols.
- Reference issues by number, never paste tokens.`

const API_GUIDE_MARKDOWN = `# Linear API

Query issues, projects, and cycles. Respect team scoping — always pass a
\`teamId\` on mutations. The agent should summarize before creating issues.`

const skillFileRefs: CapabilityContentFileRef[] = [
  { id: 'ref-program', label: 'Program.cs', relativePath: 'src/Api/Program.cs' },
  { id: 'ref-controller', label: 'WeatherController.cs', relativePath: 'src/Api/Controllers/WeatherController.cs' },
  { id: 'ref-tests', label: 'ApiTests.cs', relativePath: 'tests/Api.Tests/ApiTests.cs' },
]

const diagnosticsPresent: SafeCapabilityDiagnostic[] = [
  { severity: 'warning', code: 'cred-expiring', messageKey: 'Credential expires in 3 days — re-authenticate to avoid interruption.' },
  { severity: 'info', code: 'shadowed-alias', messageKey: 'A workspace source uses the same short alias; qualify @mentions to disambiguate.' },
]

const pluginDiagnostics: SafeCapabilityDiagnostic[] = [
  { severity: 'error', code: 'trust-review-required', messageKey: 'This plugin has not been reviewed and cannot activate yet.' },
]

// U2 projections (path-free, mirrors the SafeCapabilityDetail shape).
// F1.1052: what the server projects (`buildPermissionModes`) — the real mode ids, in the picker's order.
const skillPermissionModes: NonNullable<SafeCapabilityDetail['permissionModes']> = [
  { mode: 'auto', behavior: 'allowed' },
  { mode: 'default', behavior: 'allowed' },
  { mode: 'acceptEdits', behavior: 'allowed' },
  { mode: 'plan', behavior: 'blocked' },
  { mode: 'bypassPermissions', behavior: 'neutral' },
]

const sourcePermissions: NonNullable<SafeCapabilityDetail['permissions']> = [
  { access: 'allowed', pattern: 'GET /issues' },
  { access: 'allowed', pattern: 'GET /projects' },
  { access: 'blocked', pattern: 'mcp__linear__delete_.*' },
  { access: 'allowed', pattern: 'search' },
]

// U3 mock MCP tools (path-free; name + description only).
const mcpTools = [
  { name: 'search_code', description: 'Search code across the connected organization.' },
  { name: 'get_issue', description: 'Fetch a single issue by number.' },
  { name: 'create_pull_request', description: 'Open a pull request from a branch.' },
  { name: 'list_repositories' },
]

/** All U3 tools-section states, driven by the mcpToolsState knob. */
const MCP_TOOLS_STATES: Record<string, CapabilityMcpToolsState> = {
  collapsed: { status: 'collapsed' },
  loading: { status: 'loading' },
  loaded: { status: 'ok', tools: mcpTools },
  empty: { status: 'ok', tools: [] },
  error: { status: 'error' },
  disabled: { status: 'refused', reason: 'disabled' },
  disconnected: { status: 'refused', reason: 'disconnected' },
}

// ============================================================================
// Kind config
// ============================================================================

type KindKey = 'skill' | 'mcp' | 'api' | 'folder' | 'plugin'

/** U2/U3 knobs that steer the kind-specific section's present/absent state. */
interface KindSectionKnobs {
  showPermissionModes: boolean
  showPermissions: boolean
  /** U3: which tools-section state the MCP kind renders. */
  mcpToolsState: keyof typeof MCP_TOOLS_STATES
}

interface KindConfig {
  summary: SafeCapabilitySummary
  icon: React.ComponentType<{ className?: string }>
  color: string
  markdown: string
  fileRefs?: CapabilityContentFileRef[]
  metadata: CapabilityMetadataField[]
  /**
   * Kind-specific section. Skill/API/folder now render the REAL U2 components
   * (permission modes / permissions) with present/absent driven by the knobs.
   * MCP (tools = U3) and plugin (capabilities) remain stubs for now.
   */
  renderKindSection: (knobs: KindSectionKnobs) => React.ReactNode
}

const KIND_CONFIG: Record<KindKey, KindConfig> = {
  skill: {
    summary: skillSummary,
    icon: Sparkles,
    color: 'text-accent',
    markdown: SKILL_MARKDOWN,
    fileRefs: skillFileRefs,
    metadata: [
      { label: 'Type', value: 'Skill' },
      { label: 'Scope', value: 'Workspace' },
      { label: 'Status', value: 'Active' },
      { label: 'Version', value: '1.4.0' },
    ],
    renderKindSection: ({ showPermissionModes }) => (
      <CapabilityPermissionModesSection modes={showPermissionModes ? skillPermissionModes : undefined} />
    ),
  },
  mcp: {
    summary: mcpSummary,
    icon: Plug,
    color: 'text-accent',
    markdown: SOURCE_GUIDE_MARKDOWN,
    metadata: [
      { label: 'Type', value: 'MCP' },
      { label: 'Scope', value: 'Workspace' },
      { label: 'Status', value: 'Active' },
      { label: 'Connector', value: 'Provided by connector github' },
    ],
    // U3: lazy MCP tools section across all its states (knob-driven).
    renderKindSection: ({ mcpToolsState }) => (
      <CapabilityMcpToolsSection
        state={MCP_TOOLS_STATES[mcpToolsState] ?? MCP_TOOLS_STATES.collapsed}
        onLoad={() => console.log('[Playground] load mcp tools')}
        onRetry={() => console.log('[Playground] retry mcp tools')}
      />
    ),
  },
  api: {
    summary: apiSummary,
    icon: Cloud,
    color: 'text-success',
    markdown: API_GUIDE_MARKDOWN,
    metadata: [
      { label: 'Type', value: 'API' },
      { label: 'Scope', value: 'Workspace' },
      { label: 'Status', value: 'Active' },
      { label: 'Last Tested', value: '2 hours ago' },
    ],
    renderKindSection: ({ showPermissions }) => (
      <CapabilityPermissionsSection permissions={showPermissions ? sourcePermissions : undefined} />
    ),
  },
  folder: {
    summary: folderSummary,
    icon: FolderOpen,
    color: 'text-info',
    markdown: '',
    metadata: [
      { label: 'Type', value: 'Local' },
      { label: 'Scope', value: 'Workspace' },
      { label: 'Status', value: 'Active' },
    ],
    // Folder sources rarely carry permission rules → default to the placeholder
    // so the empty-in-section state is visible.
    renderKindSection: ({ showPermissions }) => (
      <CapabilityPermissionsSection
        permissions={showPermissions ? [{ access: 'allowed', pattern: 'read' }] : undefined}
      />
    ),
  },
  plugin: {
    summary: pluginSummary,
    icon: Boxes,
    color: 'text-secondary',
    markdown: 'A bundle of skills and MCP servers for full-stack development. Includes the ASP.NET Web API skill and the GitHub connector.',
    metadata: [
      { label: 'Developer', value: 'acme' },
      { label: 'Category', value: 'Productivity' },
      { label: 'Version', value: '0.9.2' },
      { label: 'Website', value: 'acme.example' },
    ],
    // U4: FULL component inventory — Codex plugin-detail IA (owner reference
    // screenshot 2026-07-19) on our components: a section per kind with a
    // count, two-line rows with per-component switches, collapse after 5.
    renderKindSection: () => (
      <PluginComponentsSection
        groups={[
          {
            kind: 'skill',
            items: [
              { key: 'skill:aspnet-web-api', name: 'ASP.NET Web API', description: 'Design and review ASP.NET Core Web APIs.', icon: <ComponentTile icon={Sparkles} color="text-accent" />, clickable: true, toggle: { capabilityId: 'aspnet-web-api', enabled: true } },
              { key: 'skill:ef-migrations', name: 'EF Migrations', description: 'Author and verify Entity Framework migrations.', icon: <ComponentTile icon={Sparkles} color="text-accent" />, clickable: true, toggle: { capabilityId: 'ef-migrations', enabled: true } },
              // Capability disabled via the per-component switch: dimmed + reason line.
              { key: 'skill:api-review', name: 'API Review', description: 'Adversarial review checklist for public API changes.', icon: <ComponentTile icon={Sparkles} color="text-accent" />, clickable: true, toggle: { capabilityId: 'api-review', enabled: false }, dimmed: true, disabledReasonKey: 'pluginDetail.componentCapabilityDisabled' },
              // In-flight toggle: switch renders disabled while the RPC settles.
              { key: 'skill:load-tests', name: 'Load Tests', description: 'Author k6 load-test scenarios from endpoint specs.', icon: <ComponentTile icon={Sparkles} color="text-accent" />, clickable: true, toggle: { capabilityId: 'load-tests', enabled: true, pending: true } },
              { key: 'skill:release-notes', name: 'Release Notes', description: 'Draft release notes from the merged changelog.', icon: <ComponentTile icon={Sparkles} color="text-accent" />, clickable: true, toggle: { capabilityId: 'release-notes', enabled: true } },
              { key: 'skill:sql-tuning', name: 'SQL Tuning', description: 'Explain-plan driven query optimization.', icon: <ComponentTile icon={Sparkles} color="text-accent" />, clickable: true, toggle: { capabilityId: 'sql-tuning', enabled: true } },
            ],
          },
          {
            kind: 'command',
            items: [
              { key: 'command:scaffold-endpoint', name: '/scaffold-endpoint', description: 'Generate a controller + tests from a spec.', icon: <ComponentTile icon={Boxes} color="text-secondary" />, toggle: { capabilityId: 'scaffold-endpoint', enabled: true } },
            ],
          },
          {
            kind: 'hook',
            items: [
              { key: 'hook:pre-tool-lint', name: 'pre-tool-lint', description: 'PreToolUse — lints staged edits before writes.', icon: <ComponentTile icon={Boxes} color="text-info" />, toggle: { capabilityId: 'pre-tool-lint', enabled: true } },
              { key: 'hook:stop-summary', name: 'stop-summary', description: 'Stop — posts a run summary to the session.', icon: <ComponentTile icon={Boxes} color="text-info" />, toggle: { capabilityId: 'stop-summary', enabled: false }, dimmed: true, disabledReasonKey: 'pluginDetail.componentCapabilityDisabled' },
            ],
          },
          {
            kind: 'connector',
            items: [
              { key: 'source:github-connector', name: 'GitHub', description: 'Repositories, issues, and pull requests.', icon: <ComponentTile icon={Plug} color="text-accent" />, clickable: true },
            ],
          },
          {
            kind: 'mcp',
            items: [
              { key: 'source:local-postgres', name: 'Postgres', description: 'Local Postgres MCP server.', icon: <ComponentTile icon={Plug} color="text-accent" />, clickable: true, toggle: { capabilityId: 'local-postgres', enabled: true } },
            ],
          },
        ]}
        onOpen={(key) => console.log('[Playground] open component detail:', key)}
        onToggle={(capabilityId, next) => console.log('[Playground] toggle component:', capabilityId, '→', next)}
      />
    ),
  },
}

// ============================================================================
// Preview component (knobs → template props)
// ============================================================================

interface CapabilityDetailPreviewProps {
  kind?: KindKey
  contentState?: CapabilityContentPanelStatus
  showDiagnostics?: boolean
  showFileRefs?: boolean
  showKindSection?: boolean
  showActions?: boolean
  showMetadata?: boolean
  /** U2: skill permission-mode rows present (off = in-section placeholder). */
  showPermissionModes?: boolean
  /** U2: source permission rows present (off = in-section placeholder). */
  showPermissions?: boolean
  /** U3: MCP tools-section state (only affects the MCP kind). */
  mcpToolsState?: keyof typeof MCP_TOOLS_STATES
  /** UB14.48: the source's last connection test failed (stored verdict + reduced reason). */
  lastTestFailed?: boolean
  /** UB14.59: a source's connection verdict before any stored failure (drives the hero state pill). */
  connection?: keyof typeof CONNECTION_FIELDS
  /** UB14.59: the header's "⋯" menu (off = a page with no actions: no trigger at all). */
  showHeaderMenu?: boolean
  /** UB12.80: the skill's tier, which decides its header "⋯" (Delete, or the owner's label). */
  skillTier?: keyof typeof SKILL_TIER_FIELDS
}

/**
 * UB14.59 — the summary fields behind each pip verdict the hero's state pill names. UB12.75: `untested`
 * is a source awaiting review (rule 4's bucket, still "Not Tested"), and `disabled` the source the user
 * switched off, which the pill names "Disabled" (`capabilitySummaryDisplayStatus`).
 */
const CONNECTION_FIELDS: Record<string, Pick<SafeCapabilitySummary, 'state' | 'credentialState'>> = {
  connected: { state: 'active', credentialState: 'ready' },
  needsAuth: { state: 'missing-credential', credentialState: 'missing' },
  untested: { state: 'review-required', credentialState: 'not-required' },
  disabled: { state: 'disabled', credentialState: 'not-required' },
}

/** v0.15.1 `pages/SourceInfoPage.tsx`'s type label, prefixed to a source's tagline (as `SourceInfoPage` does). */
const SOURCE_TYPE_LABEL_KEYS: Record<string, string> = {
  mcp: 'sourcesList.typeMcp',
  api: 'sourcesList.typeApi',
  local: 'sourcesList.typeLocal',
}

/**
 * UB14.48 — what the host hands the renderer after a failed `source_test`: the verdict already
 * normalised (`error` → `failed`) and the reason already reduced (the URL to scheme and host).
 */
const FAILED_TEST_FIELDS: Pick<SafeCapabilitySummary, 'lastTestStatus' | 'connectionError'> = {
  lastTestStatus: 'failed',
  connectionError: 'MCP connection failed: HTTP 502 Bad Gateway from https://mcp.github.example/… (upstream timed out after 10 s)',
}

function CapabilityDetailPreview({
  kind = 'skill',
  contentState = 'loaded',
  showDiagnostics = false,
  showFileRefs = true,
  showKindSection = true,
  showActions = true,
  showMetadata = true,
  showPermissionModes = true,
  showPermissions = true,
  mcpToolsState = 'loaded',
  lastTestFailed = false,
  connection = 'connected',
  showHeaderMenu = true,
  skillTier = 'plugin',
}: CapabilityDetailPreviewProps) {
  const { t } = useTranslation()
  const config = KIND_CONFIG[kind]
  const isSource = config.summary.kind === 'source' || config.summary.kind === 'mcp'
  const isSkill = config.summary.kind === 'skill'
  const withConnection = isSource
    ? { ...config.summary, ...(CONNECTION_FIELDS[connection] ?? CONNECTION_FIELDS.connected) }
    : isSkill ? { ...config.summary, ...(SKILL_TIER_FIELDS[skillTier] ?? SKILL_TIER_FIELDS.plugin) } : config.summary
  const summary = lastTestFailed ? { ...withConnection, ...FAILED_TEST_FIELDS } : withConnection
  // As SourceInfoPage builds them: the pill from the pip's own verdict, the type before the tagline.
  const statePill = isSource ? connectionStatePill(capabilitySummaryDisplayStatus(summary), t) : undefined
  const typeKey = isSource ? SOURCE_TYPE_LABEL_KEYS[summary.sourceType ?? 'mcp'] : undefined
  const tagline = isSource ? [typeKey ? t(typeKey) : null, summary.description].filter(Boolean).join(' · ') : undefined

  // Empty-content kinds (folder) start empty regardless of the knob so the
  // placeholder-not-hidden principle is visible by default.
  const effectiveState: CapabilityContentPanelStatus =
    contentState === 'loaded' && config.markdown.trim() === '' ? 'empty' : contentState

  const diagnostics = showDiagnostics
    ? (kind === 'plugin' ? pluginDiagnostics : diagnosticsPresent)
    : []

  return (
    <div className="h-[720px] w-full">
      <CapabilityDetailTemplate
        summary={summary}
        displayName={summary.displayName ?? summary.logicalName}
        avatar={<MockTile icon={config.icon} color={config.color} />}
        statePill={statePill}
        tagline={tagline}
        actions={
          showActions ? (
            <>
              <Button variant="secondary">Edit</Button>
              <Button variant="primary">Try now</Button>
            </>
          ) : undefined
        }
        headerActions={
          !showHeaderMenu ? undefined : isSkill ? (
            // As `SkillDetailMenu` builds it (UB12.80): the real items from the real builder.
            <Info_HeaderMenu>
              <SkillMenu
                {...skillMenuProps(summary as SafeSkillRow, {
                  actions: PLAYGROUND_SKILL_ACTIONS,
                  t,
                  hasOtherWorkspaces: true,
                  onSendToWorkspace: () => console.log('[Playground] send skill to workspace'),
                })}
                onOpenInNewWindow={() => console.log('[Playground] open skill in new window')}
              />
            </Info_HeaderMenu>
          ) : (
            <Info_HeaderMenu label={t('sourcesManagement.actions')}>
              <StyledDropdownMenuItem>Disable</StyledDropdownMenuItem>
            </Info_HeaderMenu>
          )
        }
        content={{
          status: effectiveState,
          markdown: config.markdown,
          fileRefs: showFileRefs ? config.fileRefs : undefined,
          errorMessage: undefined,
          onOpenFileRef: (ref) => console.log('[Playground] open file ref:', ref.relativePath),
          onRetry: () => console.log('[Playground] retry content load'),
        }}
        metadata={showMetadata ? config.metadata : []}
        diagnostics={diagnostics}
        kindSections={showKindSection ? config.renderKindSection({ showPermissionModes, showPermissions, mcpToolsState }) : undefined}
      />
    </div>
  )
}

// ============================================================================
// Registry entries
// ============================================================================

export const capabilityDetailComponents: ComponentEntry[] = [
  {
    id: 'capability-detail-template',
    name: 'Capability Detail',
    category: 'Capability Detail',
    description:
      'Universal detail-page template — common Hero / Content / Metadata / Diagnostics sections for every kind, with placeholder-not-hidden empty states and a kind-specific section slot.',
    component: CapabilityDetailPreview,
    layout: 'full',
    previewOverflow: 'hidden',
    props: [
      {
        name: 'kind',
        description: 'Capability kind',
        control: {
          type: 'select',
          options: [
            { label: 'Skill', value: 'skill' },
            { label: 'MCP source', value: 'mcp' },
            { label: 'API source', value: 'api' },
            { label: 'Folder source', value: 'folder' },
            { label: 'Plugin', value: 'plugin' },
          ],
        },
        defaultValue: 'skill',
      },
      {
        name: 'contentState',
        description: 'Content panel state',
        control: {
          type: 'select',
          options: [
            { label: 'Loaded', value: 'loaded' },
            { label: 'Loading skeleton', value: 'loading' },
            { label: 'Preview error', value: 'error' },
            { label: 'Empty (placeholder)', value: 'empty' },
          ],
        },
        defaultValue: 'loaded',
      },
      { name: 'showDiagnostics', description: 'Show diagnostics rows', control: { type: 'boolean' }, defaultValue: false },
      { name: 'showFileRefs', description: 'Show file-reference chips', control: { type: 'boolean' }, defaultValue: true },
      { name: 'showKindSection', description: 'Show the kind-specific section', control: { type: 'boolean' }, defaultValue: true },
      { name: 'showActions', description: 'Show hero action buttons', control: { type: 'boolean' }, defaultValue: true },
      { name: 'showMetadata', description: 'Show metadata rows (off = placeholder)', control: { type: 'boolean' }, defaultValue: true },
      { name: 'showPermissionModes', description: 'Skill: permission-mode rows present (off = placeholder)', control: { type: 'boolean' }, defaultValue: true },
      { name: 'showPermissions', description: 'Source: permission rows present (off = placeholder)', control: { type: 'boolean' }, defaultValue: true },
      {
        name: 'mcpToolsState',
        description: 'MCP source: tools-section state (U3)',
        control: {
          type: 'select',
          options: [
            { label: 'Collapsed (lazy)', value: 'collapsed' },
            { label: 'Loading', value: 'loading' },
            { label: 'Loaded', value: 'loaded' },
            { label: 'Empty (no tools)', value: 'empty' },
            { label: 'Error + retry', value: 'error' },
            { label: 'Disabled source', value: 'disabled' },
            { label: 'Disconnected', value: 'disconnected' },
          ],
        },
        defaultValue: 'loaded',
      },
      { name: 'lastTestFailed', description: 'Source: the last connection test failed (UB14.48 alert)', control: { type: 'boolean' }, defaultValue: false },
      {
        name: 'connection',
        description: 'Source: the connection verdict behind the hero state pill (UB14.59)',
        control: {
          type: 'select',
          options: [
            { label: 'Connected (ok)', value: 'connected' },
            { label: 'Needs sign-in (warn)', value: 'needsAuth' },
            { label: 'Not tested (off)', value: 'untested' },
            { label: 'Switched off (off, UB12.75)', value: 'disabled' },
          ],
        },
        defaultValue: 'connected',
      },
      { name: 'showHeaderMenu', description: 'Header "⋯" menu (off = no trigger at all, UB14.59)', control: { type: 'boolean' }, defaultValue: true },
      {
        name: 'skillTier',
        description: 'Skill: the tier it sits in — decides the header "⋯" Delete or the owner label (UB12.80)',
        control: {
          type: 'select',
          options: [
            { label: 'Plugin-provided (Delete greyed)', value: 'plugin' },
            { label: 'Workspace (Delete)', value: 'workspace' },
            { label: 'Personal global (Delete greyed)', value: 'global' },
            { label: 'Administrator (Delete greyed)', value: 'administrator' },
          ],
        },
        defaultValue: 'plugin',
      },
    ],
    variants: [
      {
        name: 'Skill — content loaded',
        description: 'Full markdown body with file-ref chips and permission-mode table (always-allowed present)',
        props: { kind: 'skill', contentState: 'loaded', showFileRefs: true, showKindSection: true, showPermissionModes: true, showDiagnostics: false },
      },
      {
        name: 'Skill — no always-allowed (placeholder)',
        description: 'Permission-mode section renders with an in-section placeholder (no always-allowed tools)',
        props: { kind: 'skill', contentState: 'loaded', showPermissionModes: false, showFileRefs: false },
      },
      {
        name: 'Skill — loading skeleton',
        description: 'Content panel skeleton while preview loads',
        props: { kind: 'skill', contentState: 'loading' },
      },
      {
        name: 'Skill — preview error',
        description: 'Content fails soft to a placeholder + retry affordance',
        props: { kind: 'skill', contentState: 'error' },
      },
      {
        name: 'Skill — header menu, workspace skill (Delete)',
        description: 'UB12.80: the header "⋯" carries the list row\'s items; a native workspace skill can be deleted and sent to another workspace',
        props: { kind: 'skill', contentState: 'loaded', skillTier: 'workspace' },
      },
      {
        name: 'Skill — header menu, administrator skill (owner label)',
        description: 'UB12.80: Delete is greyed and names the owning tier (P2.439); no Send to workspace',
        props: { kind: 'skill', contentState: 'loaded', skillTier: 'administrator' },
      },
      {
        name: 'MCP source — tools loaded',
        description: 'MCP source guide + loaded tools table (name/description) + diagnostics',
        props: { kind: 'mcp', contentState: 'loaded', showDiagnostics: true, showKindSection: true, mcpToolsState: 'loaded' },
      },
      {
        name: 'MCP source — tools collapsed (lazy)',
        description: 'Tools section collapsed with a Load affordance (nothing fetched yet)',
        props: { kind: 'mcp', contentState: 'loaded', mcpToolsState: 'collapsed' },
      },
      {
        name: 'MCP source — tools loading',
        description: 'Tools section skeleton rows while the pool read resolves',
        props: { kind: 'mcp', contentState: 'loaded', mcpToolsState: 'loading' },
      },
      {
        name: 'MCP source — tools error',
        description: 'Tools list fails soft to a placeholder + retry',
        props: { kind: 'mcp', contentState: 'loaded', mcpToolsState: 'error' },
      },
      {
        name: 'MCP source — no tools reported',
        description: 'Connected server reported zero tools → explicit empty placeholder',
        props: { kind: 'mcp', contentState: 'loaded', mcpToolsState: 'empty' },
      },
      {
        name: 'MCP source — disabled',
        description: 'Disabled source → explanatory placeholder, no connection attempt',
        props: { kind: 'mcp', contentState: 'loaded', mcpToolsState: 'disabled' },
      },
      {
        name: 'MCP source — disconnected',
        description: 'Active but not connected in this chat → explanatory placeholder',
        props: { kind: 'mcp', contentState: 'loaded', mcpToolsState: 'disconnected' },
      },
      {
        name: 'MCP source — last test failed',
        description: 'UB14.48: the stored source_test verdict — a connection-error alert with the reduced reason under Technical details',
        props: { kind: 'mcp', contentState: 'loaded', mcpToolsState: 'error', lastTestFailed: true },
      },
      {
        name: 'MCP source — needs sign-in (warn pill)',
        description: 'UB14.59: the hero state pill on the info tint for a source awaiting sign-in',
        props: { kind: 'mcp', contentState: 'loaded', mcpToolsState: 'collapsed', connection: 'needsAuth' },
      },
      {
        name: 'MCP source — disabled (off pill), no menu',
        description: 'UB14.59: the neutral pill, and a page with no actions renders no header menu; UB12.75: a source the user switched off reads Disabled',
        props: { kind: 'mcp', contentState: 'loaded', mcpToolsState: 'disabled', connection: 'disabled', showHeaderMenu: false },
      },
      {
        name: 'MCP source — not tested (off pill)',
        description: 'UB12.75: a source no check has reached (awaiting review) keeps Not Tested on the same neutral pill',
        props: { kind: 'mcp', contentState: 'loaded', mcpToolsState: 'collapsed', connection: 'untested' },
      },
      {
        name: 'API source — with guide + permissions',
        description: 'API source guide + permissions table (allowed/blocked pattern rows)',
        props: { kind: 'api', contentState: 'loaded', showKindSection: true, showPermissions: true },
      },
      {
        name: 'API source — no permissions (placeholder)',
        description: 'Permissions section renders with an in-section placeholder (no rules configured)',
        props: { kind: 'api', contentState: 'loaded', showPermissions: false },
      },
      {
        name: 'Folder source — empty content',
        description: 'No documentation → explicit placeholder (section still renders)',
        props: { kind: 'folder', contentState: 'empty', showFileRefs: false, showPermissions: false },
      },
      {
        name: 'Plugin — review required',
        description: 'Plugin bundle, error diagnostic, capabilities section, no metadata (placeholder)',
        props: { kind: 'plugin', contentState: 'loaded', showDiagnostics: true, showMetadata: false, showFileRefs: false },
      },
      {
        name: 'Bare — all placeholders',
        description: 'Every common section falls to its placeholder (no content, metadata, diagnostics, or kind section)',
        props: { kind: 'skill', contentState: 'empty', showFileRefs: false, showKindSection: false, showMetadata: false, showDiagnostics: false, showActions: false, showHeaderMenu: false },
      },
    ],
  },
]
