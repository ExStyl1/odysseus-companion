/* UB14.39 (R6-10) — our own dialogs (no v0.15.1 counterpart) on v0.15.1's dialog vocabulary: Cancel is the ghost,
   the forward action the primary, the irreversible confirmations (bypass, folder trust, deleting a published page)
   `danger-solid`, text on the role tokens. Each entry mounts the SHIPPED component, forced open, never a mock-up
   beside it; every state is swept in dark by `../__tests__/ours-dialogs-registry.test.ts`. The dialogs that already
   had an entry keep it (runtime switch costs, plugin configuration prompt, plugin install checklist, the Add
   marketplace variant of Marketplace Browse); the same test sweeps those states too. Not here: PageFrame's link-out
   confirmation and the four PluginsPage dialogs are inline in their page components (an iframe page, the whole
   marketplace page), so `components/__tests__/ours-dialogs-vocabulary.test.ts` pins them at the source. */
import * as React from 'react'
import type { IssuedProjectHandle } from '@nessy-agent/shared/projects/project-handle-service'
import type { PublishedArtifactDto, TaskRunConfirmationDto } from '@nessy-agent/shared/protocol'
import type { ProjectContributionReport } from '@nessy-agent/shared/protocol/capabilities'
import type { ComponentEntry } from './types'
import { BypassPermissionsDialog } from '@/components/BypassPermissionsDialog'
import { ProjectTrustDialog } from '@/components/workspace/ProjectTrustDialog'
import { ProjectContributionsList } from '@/components/workspace/ProjectContributionsList'
import { RunConfirmationDialog } from '@/components/app-shell/kanban/RunConfirmationDialog'
import type { TaskModelGroup } from '@/components/app-shell/kanban/model-catalog'
import { DeletePublishedPageDialog, ExtendPublishedPageDialog } from '@/components/artifacts/PublishedPagesSection'
import { MarketplaceSkillPreviewModal } from '@/components/marketplace/MarketplaceSkillPreviewModal'

const log = (what: string) => () => console.log(`[Playground] ${what}`)

const OPEN_PROP = { name: 'open', description: 'Force open', control: { type: 'boolean' as const }, defaultValue: true }

function BypassPermissionsDialogPreview({ open = true }: { open?: boolean }) {
  return <BypassPermissionsDialog open={open} onConfirm={log('BypassPermissionsDialog confirm')} onCancel={log('BypassPermissionsDialog cancel')} />
}

const TRUST_PROJECT: IssuedProjectHandle = {
  id: 'project-handle-1',
  workspaceId: 'ws-preview',
  displayPath: '~/work/payments-service',
  trustState: 'unknown',
  expiresAt: Date.parse('2026-10-16T12:00:00.000Z'),
}

function ProjectTrustDialogPreview({ open = true }: { open?: boolean }) {
  // The contribution report arrives from an effect (`detectProjectContributions`), so a first render shows the dialog
  // without it, exactly as the app does until the read answers; `project-contributions-list` shows the list itself.
  return <ProjectTrustDialog open={open} project={TRUST_PROJECT} onClose={log('ProjectTrustDialog close')} onDecision={log('ProjectTrustDialog decision')} />
}

const CONTRIBUTIONS: ProjectContributionReport = {
  items: [
    { itemType: 'AGENTS_MD', count: 1, names: ['AGENTS.md'], sourceLabel: 'project root' },
    { itemType: 'MCP_SERVER_CONFIG', count: 2, names: ['postgres', 'jira'], sourceLabel: 'project .mcp.json' },
    { itemType: 'SKILLS', count: 7, names: ['release-notes', 'sql-tuning', 'code-review'], truncated: true, sourceLabel: '.claude/skills' },
    { itemType: 'HOOKS', count: 1, names: ['PreToolUse'], sourceLabel: '.claude/settings.json' },
  ],
}

function ProjectContributionsListPreview({ empty = false }: { empty?: boolean }) {
  // In the trust dialog's sunken well, as the dialog mounts it.
  return (
    <div className="w-[420px]">
      <ProjectContributionsList report={empty ? { items: [] } : CONTRIBUTIONS} className="rounded-md bg-sunken px-3 py-2.5" />
    </div>
  )
}

const RUN_GROUPS: TaskModelGroup[] = [
  { provider: 'nessy', label: 'Nessy Gateway', models: [], connectionSlug: 'nessy-gateway', runtime: 'pi' },
  { provider: 'anthropic', label: 'Claude Code (Nessy Gateway)', models: [], connectionSlug: 'claude-gateway', runtime: 'anthropic' },
]

type PluginsState = 'listed' | 'none' | 'unknown'

function runConfirmation(plugins: PluginsState): TaskRunConfirmationDto {
  return {
    digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    nodeCount: 3,
    orchestratorPermissionMode: 'acceptEdits',
    nodes: [
      { id: 'n1', title: 'Collect the failing payment traces', permissionMode: 'plan' },
      { id: 'n2', title: 'Draft the fix', model: 'coder', llmConnection: 'claude-gateway', permissionMode: 'acceptEdits' },
      { id: 'n3', title: 'Write the release note', llmConnection: 'retired-connection' },
    ],
    sources: plugins === 'listed' ? ['jira', 'confluence'] : [],
    ...(plugins === 'unknown' ? {} : {
      plugins: plugins === 'listed' ? [{ name: 'nessy-default-extension', mcpServers: ['dpJira', 'dpGitlab'] }, { name: 'figma', mcpServers: [] }] : [],
    }),
  }
}

function RunConfirmationDialogPreview({ open = true, plugins = 'listed' }: { open?: boolean; plugins?: PluginsState }) {
  return (
    <RunConfirmationDialog
      confirmation={open ? runConfirmation(plugins) : null}
      groups={RUN_GROUPS}
      defaultConnectionSlug="nessy-gateway"
      onSettle={log('RunConfirmationDialog settle')}
    />
  )
}

const PUBLISHED_ROW: PublishedArtifactDto = {
  id: 'AbCdEfGhIjKlMnOpQrStUv',
  url: 'https://t-artifacts.t-tech.team/a/AbCdEfGhIjKlMnOpQrStUv',
  title: 'Q3 report',
  emoji: '📊',
  expiresAt: '2026-10-22T12:00:00.000Z',
  retentionDays: 7,
}

function ExtendPublishedPageDialogPreview({ open = true }: { open?: boolean }) {
  return <ExtendPublishedPageDialog row={open ? PUBLISHED_ROW : null} onCancel={log('Extend cancel')} onConfirm={log('Extend confirm')} />
}

function DeletePublishedPageDialogPreview({ open = true }: { open?: boolean }) {
  return <DeletePublishedPageDialog row={open ? PUBLISHED_ROW : null} onCancel={log('Delete cancel')} onConfirm={log('Delete confirm')} />
}

const SKILL_MARKDOWN = '# Release notes\n\nCollects the merged changes since the last tag and writes the notes in the house style.'

function MarketplaceSkillPreviewModalPreview({ open = true, withPrimary = true }: { open?: boolean; withPrimary?: boolean }) {
  return (
    <MarketplaceSkillPreviewModal
      open={open}
      onOpenChange={log('MarketplaceSkillPreviewModal onOpenChange')}
      name="release-notes"
      kindLabel="Skill"
      description="Writes release notes from the merged changes."
      content={{ status: 'loaded', markdown: SKILL_MARKDOWN }}
      primaryLabel={withPrimary ? 'Install plugin' : undefined}
      onPrimary={log('MarketplaceSkillPreviewModal primary')}
      closeLabel="Close"
    />
  )
}

export const oursDialogComponents: ComponentEntry[] = [
  {
    id: 'bypass-permissions-dialog',
    name: 'Bypass permissions dialog',
    category: 'Primitives',
    description: 'UB14.39 (ours): the one-time bypass acknowledgment. Cancel ghost; the irreversible "I accept the risk" is danger-solid; the warning glyph on the info role, the runtime note and recommendation on the text roles.',
    component: BypassPermissionsDialogPreview,
    props: [OPEN_PROP],
  },
  {
    id: 'project-trust-dialog',
    name: 'Folder trust dialog',
    category: 'Primitives',
    description: 'UB14.39 (ours): Cancel ghost, Keep restricted secondary, the irreversible Trust folder danger-solid; the path in a sunken well.',
    component: ProjectTrustDialogPreview,
    props: [OPEN_PROP],
  },
  {
    id: 'project-contributions-list',
    name: 'Folder trust — what the folder provides',
    category: 'Primitives',
    description: 'UB14.39 (ours): the contribution list the trust dialog shows in its sunken well; the heading is upstream\'s quiet section label, names secondary, the source tertiary mono. Empty renders nothing.',
    component: ProjectContributionsListPreview,
    props: [{ name: 'empty', description: 'An empty report (renders nothing)', control: { type: 'boolean' }, defaultValue: false }],
    variants: [{ name: 'Empty report', description: 'Nothing detected: the list renders nothing', props: { empty: true } }],
  },
  {
    id: 'run-confirmation-dialog',
    name: 'Task run confirmation',
    category: 'Kanban',
    description: 'UB14.39 (ours, UA4.4): Cancel ghost, Run primary; nodes on hairline cards with the runtime on the quiet badge, values secondary, the two residues tertiary.',
    component: RunConfirmationDialogPreview,
    props: [
      OPEN_PROP,
      {
        name: 'plugins',
        description: 'What the host could read about the plugins a node sees',
        control: { type: 'select', options: [{ value: 'listed', label: 'Listed' }, { value: 'none', label: 'None active' }, { value: 'unknown', label: 'Could not be read' }] },
        defaultValue: 'listed',
      },
    ],
    variants: [
      { name: 'No plugins', description: 'No active plugin; default sources', props: { plugins: 'none' } },
      { name: 'Plugins unknown', description: 'The host could not read them', props: { plugins: 'unknown' } },
    ],
  },
  {
    id: 'extend-published-page-dialog',
    name: 'Extend a published page',
    category: 'Pages',
    description: 'UB14.39 (ours, UA1.19): the retention choices on upstream\'s segmented control (radiogroup kept), Cancel ghost, Extend primary.',
    component: ExtendPublishedPageDialogPreview,
    props: [OPEN_PROP],
  },
  {
    id: 'delete-published-page-dialog',
    name: 'Delete a published page',
    category: 'Pages',
    description: 'UB14.39 (ours, UA1.19): Cancel ghost; the irreversible Delete is danger-solid.',
    component: DeletePublishedPageDialogPreview,
    props: [OPEN_PROP],
  },
  {
    id: 'marketplace-skill-preview-modal',
    name: 'Marketplace skill preview',
    category: 'Marketplace',
    description: 'UB14.39 (ours, U5): Close ghost beside the primary Install, or the lone secondary Close; the SKILL.md body on the raised card Info_Section draws.',
    component: MarketplaceSkillPreviewModalPreview,
    props: [
      OPEN_PROP,
      { name: 'withPrimary', description: 'The pre-install Install plugin CTA', control: { type: 'boolean' }, defaultValue: true },
    ],
    variants: [{ name: 'Close only', description: 'An installed plugin\'s skill: one quiet Close', props: { withPrimary: false } }],
  },
]
