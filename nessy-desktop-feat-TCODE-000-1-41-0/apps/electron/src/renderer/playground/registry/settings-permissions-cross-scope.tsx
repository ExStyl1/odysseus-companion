import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { ComponentEntry } from './types'
import {
  PermissionsDataTable,
  type PermissionRow,
} from '@/components/info/PermissionsDataTable'
import { annotateRowsAlreadyGrantedByDefaults } from '@/pages/settings/permissions-cross-scope'
import { SettingsSection } from '@/components/settings/SettingsSection'
import { SettingsCard } from '@/components/settings/SettingsCard'

// =============================================================================
// Cross-scope precedence in the Permissions table — P6.209
//
// The page shows two tables, the app defaults above and the workspace additions
// below, and it never said how they compose. A stacked layout reads as
// "the lower one overrides the upper one"; the resolver does the opposite —
// `buildMergedConfig` applies the global layer first and the workspace layer
// second, and both only PUSH, so a workspace pattern can extend the defaults and
// can never remove one.
//
// The state worth looking at is `mixed`. The `git status` row is a duplicate of
// a default grant: it looks exactly like the live row beside it and it decides
// nothing, which is the failure this row closes. The `off` state is the control
// — the same rows with the annotation withheld — so the two can be read against
// each other, the same way `settings-blocked-tools.tsx` keeps its `none` state.
//
// The annotation is computed by the SHIPPED function, not restated here, so this
// draft cannot claim a behaviour the page does not have.
// =============================================================================

const DEFAULT_ROWS: PermissionRow[] = [
  { access: 'allowed', type: 'bash', pattern: 'git status', comment: 'Read-only status' },
  { access: 'allowed', type: 'bash', pattern: 'ls -la', comment: 'Directory listing' },
  { access: 'allowed', type: 'mcp', pattern: 'mcp__.*__read_.*', comment: 'Read-only MCP calls' },
]

const WORKSPACE_ROWS: PermissionRow[] = [
  // The duplicate: identical type and pattern to a default grant above.
  { access: 'allowed', type: 'bash', pattern: 'git status', comment: 'Added by this workspace' },
  // Genuinely new, and must stay unannotated or the display says nothing.
  { access: 'allowed', type: 'bash', pattern: 'bun run deploy', comment: 'Added by this workspace' },
  // Same string as a default BASH pattern but a different type — not a duplicate.
  { access: 'allowed', type: 'mcp', pattern: 'ls -la', comment: 'Added by this workspace' },
  // A block already carrying P3.351's stronger reason, which must survive.
  {
    access: 'blocked',
    type: 'tool',
    pattern: 'Bash',
    comment: 'Blocked tool',
    unenforceable: 'Bash is decided by the command classifier before this list is read.',
  },
]

type CrossScopeState = 'mixed' | 'off'

function CrossScopePreview({ state = 'mixed' }: { state?: CrossScopeState }) {
  const { t } = useTranslation()
  const rows = state === 'off'
    ? WORKSPACE_ROWS
    : annotateRowsAlreadyGrantedByDefaults(
        WORKSPACE_ROWS,
        DEFAULT_ROWS,
        t('settings.permissions.rowAlreadyGranted'),
      )

  // UB15.7 — the page's two sections as it draws them: headed groups, each table in a padless SettingsCard, the
  // precedence sentence in the workspace section's description.
  return (
    <div className="max-w-[680px] space-y-6">
      <SettingsSection
        title={t('settings.permissions.defaultPermissions')}
        description={t('settings.permissions.defaultPermissionsDesc')}
      >
        <SettingsCard className="p-0">
          <PermissionsDataTable data={DEFAULT_ROWS} />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection
        title={t('settings.permissions.workspaceCustomizations')}
        description={`${t('settings.permissions.workspaceCustomizationsDesc')} ${t('settings.permissions.crossScopeNote')}`}
      >
        <SettingsCard className="p-0">
          <PermissionsDataTable data={rows} unenforceableStyle="annotate" />
        </SettingsCard>
      </SettingsSection>
    </div>
  )
}

export const settingsPermissionsCrossScopeComponents: ComponentEntry[] = [
  {
    id: 'settings-permissions-cross-scope',
    name: 'Permissions across scopes',
    category: 'Settings',
    description:
      'P6.209: the two permission scopes are additive, not layered — a workspace pattern the app defaults already grant decides nothing, and is marked inert instead of reading as a live rule',
    component: CrossScopePreview,
    layout: 'top',
    props: [
      {
        name: 'state',
        description: 'With the cross-scope annotation, or the control without it',
        control: {
          type: 'select',
          options: [
            { value: 'mixed', label: 'Annotated — the duplicate is marked inert' },
            { value: 'off', label: 'Control — what shipped before (duplicate looks live)' },
          ],
        },
        defaultValue: 'mixed',
      },
    ],
  },
]
