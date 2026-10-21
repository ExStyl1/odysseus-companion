/**
 * Playground registry for the INFO DATA TABLES at v0.15.1 (UB14.58).
 *
 * The four `components/info/*DataTable.tsx` tables on the role type, each inside the raised card
 * the settings and detail pages put them in (`SettingsCard className="p-0"`):
 * - `info-labels-table`: `LabelsDataTable` — the label tree with its named expander
 *   (`aria-expanded` / `aria-label`), the color, name and type columns, the hover-revealed
 *   `Info_FullscreenButton`; the control without the fullscreen knob, and the empty table.
 * - `info-auto-rules-table`: `AutoRulesDataTable` — a plain label whose rule carries a stray
 *   `valueTemplate` (the template cell shows "—": a plain label ignores it), a valued label showing
 *   its template, and two semantic rules (the "Semantic" chip, the threshold in the flags column,
 *   a valued semantic rule's fixed value).
 * - `info-permissions-table`: `PermissionsDataTable` — allowed/blocked rows by type, a long pattern
 *   (its tooltip), and a row carrying our `unenforceable` sentence in each `UnenforceableStyle`
 *   (P3.351, P6.209), with and without the type column.
 * - `info-tools-table`: `ToolsDataTable` — the mono tool name, the two-line description and the
 *   access chip LAST; loading, error, needs-auth and empty states.
 *
 * Fullscreen: the knob puts the table's `Info_FullscreenButton` in its toolbar (hover-revealed,
 * always visible on touch); clicking it opens the table's own `DataTableOverlay`, which the tables
 * hold as internal state, so the opened overlay is driven by hand here (and drawn standalone by the
 * `DataTableOverlay` entry under Fullscreen).
 *
 * Dark theme is the review target. IPC-free: sample data only, nothing touches `window.electronAPI`.
 */

import * as React from 'react'
import { AutoRulesDataTable } from '@/components/info/AutoRulesDataTable'
import { LabelsDataTable } from '@/components/info/LabelsDataTable'
import {
  PermissionsDataTable,
  type PermissionRow,
  type UnenforceableStyle,
} from '@/components/info/PermissionsDataTable'
import { ToolsDataTable, type ToolRow } from '@/components/info/ToolsDataTable'
import { SettingsCard } from '@/components/settings/SettingsCard'
import type { LabelConfig } from '@nessy-agent/shared/labels'
import type { ComponentEntry } from './types'

// ============================================================================
// Sample data
// ============================================================================

/** A plain label, three valued ones, and a parent with two children (collapsed by default). */
export const SAMPLE_LABELS: LabelConfig[] = [
  {
    id: 'bug',
    name: 'Bug',
    color: 'destructive',
    // A plain label: the stray valueTemplate is ignored, so the template cell shows "—".
    autoRules: [{ pattern: '\\b(bug|crash|regression)\\b', valueTemplate: '$1', description: 'Mentions of a defect' }],
  },
  {
    id: 'ticket',
    name: 'Ticket',
    color: 'info',
    valueType: 'string',
    autoRules: [{ pattern: '\\b(NES-\\d+)\\b', flags: 'g', valueTemplate: '$1', description: 'Tracker keys' }],
  },
  {
    id: 'priority',
    name: 'Priority',
    color: 'accent',
    valueType: 'number',
  },
  {
    id: 'billing',
    name: 'Billing',
    color: 'success',
    autoRules: [{ semantic: 'Is the user asking about billing or invoices?', description: 'Decision model' }],
  },
  {
    id: 'area',
    name: 'Area',
    color: 'foreground/50',
    valueType: 'string',
    autoRules: [{ semantic: 'Is this about the release pipeline?', threshold: 0.75, value: 'release' }],
    children: [
      { id: 'frontend', name: 'Frontend', color: 'info/80' },
      { id: 'backend', name: 'Backend', color: 'accent/80' },
    ],
  },
]

export const UNENFORCEABLE_SENTENCE =
  'Not enforced: WebFetch is always allowed, so this entry never blocks anything.'

export const SAMPLE_PERMISSIONS: PermissionRow[] = [
  { access: 'allowed', type: 'bash', pattern: 'git status', comment: 'Read-only git' },
  { access: 'allowed', type: 'tool', pattern: 'Read', comment: null },
  {
    access: 'blocked',
    type: 'mcp',
    pattern: 'mcp__github__delete_repository_and_all_branches',
    comment: 'Destructive repository actions',
  },
  { access: 'blocked', type: 'tool', pattern: 'WebFetch', comment: 'Workspace blockedTools', unenforceable: UNENFORCEABLE_SENTENCE },
  { access: 'allowed', type: 'api', pattern: 'GET /repos/*', comment: 'Read the API' },
]

export const SAMPLE_TOOLS: ToolRow[] = [
  { name: 'list_issues', description: 'List issues in a repository, filtered by state, labels and assignee.', permission: 'allowed' },
  {
    name: 'create_pull_request',
    description:
      'Open a pull request from a head branch into a base branch, with a title, a body and optional reviewers; '
      + 'the description wraps to two lines so the access column stays in view.',
    permission: 'requires-permission',
  },
  { name: 'get_file_contents', description: 'Read one file or a directory listing at a ref.', permission: 'allowed' },
]

// ============================================================================
// Previews
// ============================================================================

function TableCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-[680px] p-4">
      <SettingsCard className="p-0">{children}</SettingsCard>
    </div>
  )
}

function LabelsTablePreview({ empty, searchable, fullscreen }: { empty: boolean; searchable: boolean; fullscreen: boolean }) {
  return (
    <TableCard>
      <LabelsDataTable
        data={empty ? [] : SAMPLE_LABELS}
        searchable={searchable}
        maxHeight={350}
        fullscreen={fullscreen}
        fullscreenTitle="Label hierarchy"
      />
    </TableCard>
  )
}

function AutoRulesTablePreview({ empty, searchable, fullscreen }: { empty: boolean; searchable: boolean; fullscreen: boolean }) {
  return (
    <TableCard>
      <AutoRulesDataTable
        data={empty ? [] : SAMPLE_LABELS}
        searchable={searchable}
        maxHeight={350}
        fullscreen={fullscreen}
        fullscreenTitle="Auto-apply rules"
      />
    </TableCard>
  )
}

interface PermissionsTablePreviewProps {
  empty: boolean
  hideTypeColumn: boolean
  unenforceableStyle: UnenforceableStyle
  searchable: boolean
  fullscreen: boolean
}

function PermissionsTablePreview({ empty, hideTypeColumn, unenforceableStyle, searchable, fullscreen }: PermissionsTablePreviewProps) {
  return (
    <TableCard>
      <PermissionsDataTable
        data={empty ? [] : SAMPLE_PERMISSIONS}
        hideTypeColumn={hideTypeColumn}
        unenforceableStyle={unenforceableStyle}
        searchable={searchable}
        maxHeight={350}
        fullscreen={fullscreen}
        fullscreenTitle="Permissions"
      />
    </TableCard>
  )
}

type ToolsState = 'data' | 'loading' | 'error' | 'auth' | 'empty'

function ToolsTablePreview({ state }: { state: ToolsState }) {
  return (
    <TableCard>
      <ToolsDataTable
        data={state === 'data' ? SAMPLE_TOOLS : []}
        loading={state === 'loading'}
        error={state === 'error' ? 'The server closed the connection.' : state === 'auth' ? 'Source requires authentication' : undefined}
        maxHeight={350}
      />
    </TableCard>
  )
}

// ============================================================================
// Entries
// ============================================================================

const tableKnobs = [
  { name: 'empty', description: 'No rows (the table\'s empty message)', control: { type: 'boolean' as const }, defaultValue: false },
  { name: 'searchable', description: 'Search input above the table', control: { type: 'boolean' as const }, defaultValue: true },
  { name: 'fullscreen', description: 'The hover-revealed Info_FullscreenButton (click opens the overlay)', control: { type: 'boolean' as const }, defaultValue: true },
]

export const infoDataTableComponents: ComponentEntry[] = [
  {
    id: 'info-labels-table',
    name: 'Labels Table',
    category: 'Capability Detail',
    description: 'LabelsDataTable at v0.15.1: the label tree with a named expander, role-type headers and Info_FullscreenButton.',
    component: LabelsTablePreview,
    layout: 'top',
    props: tableKnobs,
    variants: [
      { name: 'No fullscreen', props: { fullscreen: false } },
      { name: 'Empty', props: { empty: true } },
    ],
  },
  {
    id: 'info-auto-rules-table',
    name: 'Auto-Apply Rules Table',
    category: 'Capability Detail',
    description: 'AutoRulesDataTable at v0.15.1: regex and semantic rules; a plain label shows no template ("—").',
    component: AutoRulesTablePreview,
    layout: 'top',
    props: tableKnobs,
    variants: [
      { name: 'No fullscreen', props: { fullscreen: false } },
      { name: 'Empty', props: { empty: true } },
    ],
  },
  {
    id: 'info-permissions-table',
    name: 'Permissions Table',
    category: 'Capability Detail',
    description: 'PermissionsDataTable: the v0.15.1 restyle with our unenforceable rows (P3.351, P6.209) in each style.',
    component: PermissionsTablePreview,
    layout: 'top',
    props: [
      ...tableKnobs,
      { name: 'hideTypeColumn', description: 'Hide the type column (MCP sources)', control: { type: 'boolean' }, defaultValue: false },
      {
        name: 'unenforceableStyle',
        description: 'How a row carrying an unenforceable sentence is shown',
        control: {
          type: 'select',
          options: [
            { label: 'annotate', value: 'annotate' },
            { label: 'grey', value: 'grey' },
            { label: 'both', value: 'both' },
          ],
        },
        defaultValue: 'annotate',
      },
    ],
    variants: [
      { name: 'Grey', props: { unenforceableStyle: 'grey' } },
      { name: 'Both', props: { unenforceableStyle: 'both' } },
      { name: 'No type column', props: { hideTypeColumn: true } },
      { name: 'No fullscreen', props: { fullscreen: false } },
      { name: 'Empty', props: { empty: true } },
    ],
  },
  {
    id: 'info-tools-table',
    name: 'Tools Table',
    category: 'Capability Detail',
    description: 'ToolsDataTable at v0.15.1: mono tool name, two-line description, the access chip last.',
    component: ToolsTablePreview,
    layout: 'top',
    props: [
      {
        name: 'state',
        description: 'Table state',
        control: {
          type: 'select',
          options: [
            { label: 'Data', value: 'data' },
            { label: 'Loading', value: 'loading' },
            { label: 'Error', value: 'error' },
            { label: 'Needs auth', value: 'auth' },
            { label: 'Empty', value: 'empty' },
          ],
        },
        defaultValue: 'data',
      },
    ],
    variants: [
      { name: 'Loading', props: { state: 'loading' } },
      { name: 'Error', props: { state: 'error' } },
      { name: 'Needs auth', props: { state: 'auth' } },
      { name: 'Empty', props: { state: 'empty' } },
    ],
  },
]
