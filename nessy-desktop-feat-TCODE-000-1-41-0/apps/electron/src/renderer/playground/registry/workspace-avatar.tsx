/**
 * UB7.2 — the playground entry for the workspace avatar: a gallery of the
 * deterministic hues, the empty-name fallback and the no-id neutral tile.
 * Not an upstream registry file (upstream's playground has no workspace-avatar
 * entry); the row's "Playground states in dark theme" is the visual control —
 * sweep this entry in dark.
 *
 * UB14.61 — the surfaces that wear the avatar, on v0.15.1's classes: the shared
 * `WorkspaceTargetList` in each of its states, both "Send to workspace" dialogs
 * (sessions and resources) open on it, and the two switcher triggers (topbar
 * dropdown, compact drawer — click either to open its menu). Also ours: upstream
 * has no playground entry for any of them. Sweep every variant in dark.
 */
import * as React from 'react'
import type { ComponentEntry } from './types'
import type { WorkspaceInfo } from '../../../shared/types'
import { WorkspaceAvatar } from '@/components/ui/workspace-avatar'
import { Button } from '@/components/ui/button'
import { WorkspaceTargetList, type RemoteHealth } from '@/components/app-shell/WorkspaceTargetList'
import { SendToWorkspaceDialog } from '@/components/app-shell/SendToWorkspaceDialog'
import { SendResourceToWorkspaceDialog } from '@/components/app-shell/SendResourceToWorkspaceDialog'
import { WorkspaceSwitcher } from '@/components/app-shell/WorkspaceSwitcher'
import { CompactWorkspaceSwitcher } from '@/components/app-shell/CompactWorkspaceSwitcher'

const GALLERY_IDS: Array<{ id: string; name: string }> = [
  { id: 'ws-alpha', name: 'Alpha' },
  { id: 'ws-alphb', name: 'Alphb' },
  { id: 'ws-1', name: 'Nessy Core' },
  { id: 'ws-2', name: 'T-Bank' },
  { id: 'ws-3', name: 'Qwen Workspace' },
  { id: 'ws-4', name: 'Codex Sandbox' },
]

/** Wrapper showing the deterministic tiles across ids, names and sizes. */
function WorkspaceAvatarGallery() {
  return (
    <div className="flex flex-col gap-6 p-6">
      <div>
        <div className="text-xs mb-2 text-muted-foreground">Deterministic hues (id-derived, 20 px)</div>
        <div className="flex items-center gap-3">
          {GALLERY_IDS.map(({ id, name }) => (
            <div key={id} className="flex flex-col items-center gap-1">
              <WorkspaceAvatar workspaceId={id} workspaceName={name} className="h-5 w-5 rounded-full ring-1 ring-border/50" />
              <span className="text-[10px] text-muted-foreground">{hueOf(id)}</span>
            </div>
          ))}
        </div>
      </div>
      <div>
        <div className="text-xs mb-2 text-muted-foreground">Sizes (28 px / 20 px / 16 px)</div>
        <div className="flex items-center gap-3">
          <WorkspaceAvatar workspaceId="ws-alpha" workspaceName="Alpha" className="h-7 w-7 rounded-full" fallbackClassName="text-sm" />
          <WorkspaceAvatar workspaceId="ws-alpha" workspaceName="Alpha" className="h-5 w-5 rounded-full" />
          <WorkspaceAvatar workspaceId="ws-alpha" workspaceName="Alpha" className="h-4 w-4 rounded-full" />
        </div>
      </div>
      <div>
        <div className="text-xs mb-2 text-muted-foreground">Fallbacks</div>
        <div className="flex items-center gap-3">
          <WorkspaceAvatar workspaceId="ws-empty" workspaceName="" className="h-5 w-5 rounded-full" />
          <WorkspaceAvatar workspaceId="ws-ws" workspaceName="   " className="h-5 w-5 rounded-full" />
          <WorkspaceAvatar className="h-5 w-5 rounded-full" />
          <WorkspaceAvatar workspaceId="ws-icon" workspaceName="With icon" src="data:image/png;base64,aWNvbg==" className="h-5 w-5 rounded-full" />
        </div>
      </div>
    </div>
  )
}

function hueOf(id: string): number {
  let hash = 5381
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) + hash) + id.charCodeAt(i)
  }
  return Math.abs(hash) % 360
}

// ============================================================================
// UB14.61 — the target list, the two send dialogs and the switcher triggers
// ============================================================================

const ACTIVE_WORKSPACE: WorkspaceInfo = { id: 'ws-1', name: 'Nessy Core' }

/** One of each kind a "Send to workspace" picker meets: locals, a reachable remote, one still checking, one without a saved credential. */
const TARGETS: WorkspaceInfo[] = [
  { id: 'ws-2', name: 'T-Bank' },
  { id: 'ws-3', name: 'Qwen Workspace — a long name that truncates in the dialog' },
  { id: 'ws-remote-ok', name: 'Build server', remoteServer: { url: 'wss://build.example.test:9100', remoteWorkspaceId: 'w-1' }, hasCredential: true },
  { id: 'ws-remote-wait', name: 'Staging', remoteServer: { url: 'wss://staging.example.test:9100', remoteWorkspaceId: 'w-2' }, hasCredential: true },
  { id: 'ws-remote-down', name: 'Old laptop', remoteServer: { url: 'wss://old.example.test:9100', remoteWorkspaceId: 'w-3' }, hasCredential: false },
]

const TARGET_HEALTH: Array<[string, RemoteHealth]> = [
  ['ws-remote-ok', 'ok'],
  ['ws-remote-wait', 'checking'],
  ['ws-remote-down', 'error'],
]

type TargetListScenario = 'mixed' | 'sending' | 'empty'

/** The list alone, at the dialogs' width (`sm:max-w-sm`), on the dialog surface. */
function WorkspaceTargetListPreview({
  scenario = 'mixed',
  selected = true,
}: {
  scenario?: TargetListScenario
  selected?: boolean
}) {
  const [selectedId, setSelectedId] = React.useState<string | null>(selected ? 'ws-2' : null)
  return (
    <div className="w-[384px] rounded-xl bg-background p-4 shadow-elev-2">
      <WorkspaceTargetList
        workspaces={scenario === 'empty' ? [] : TARGETS}
        selectedId={selectedId}
        onSelect={setSelectedId}
        disabled={scenario === 'sending'}
        remoteHealth={new Map(TARGET_HEALTH)}
        iconById={new Map()}
        emptyLabel="No other workspaces available."
      />
    </div>
  )
}

/** The real dialogs, open on the list; Cancel closes and the button reopens. */
function SendToWorkspaceDialogPreview({
  kind = 'sessions',
  targets = true,
}: {
  kind?: 'sessions' | 'resources'
  targets?: boolean
}) {
  const [open, setOpen] = React.useState(true)
  const workspaces = targets ? [ACTIVE_WORKSPACE, ...TARGETS] : [ACTIVE_WORKSPACE]
  return (
    <div className="flex flex-col items-center gap-3">
      <Button variant="secondary" onClick={() => setOpen(true)}>Open the dialog</Button>
      {kind === 'sessions' ? (
        <SendToWorkspaceDialog
          open={open}
          onOpenChange={setOpen}
          sessionIds={['playground-session-1', 'playground-session-2']}
          workspaces={workspaces}
          activeWorkspaceId={ACTIVE_WORKSPACE.id}
        />
      ) : (
        <SendResourceToWorkspaceDialog
          open={open}
          onOpenChange={setOpen}
          resourceType="skill"
          resourceIds={['commit-helper']}
          resourceLabel="commit-helper"
          workspaces={workspaces}
          activeWorkspaceId={ACTIVE_WORKSPACE.id}
        />
      )}
    </div>
  )
}

/** Both switcher triggers on the top-bar strip; each opens its real menu (dropdown / drawer). */
function WorkspaceSwitcherTriggersPreview({
  active = 'local',
  unread = true,
}: {
  active?: 'local' | 'remote'
  unread?: boolean
}) {
  const workspaces = [ACTIVE_WORKSPACE, ...TARGETS]
  const activeWorkspaceId = active === 'remote' ? 'ws-remote-ok' : ACTIVE_WORKSPACE.id
  const workspaceUnreadMap = unread ? { 'ws-3': true } : undefined
  const onSelect = (workspaceId: string) => console.log('[Playground] select workspace', workspaceId)
  return (
    <div className="flex w-[420px] flex-col gap-4">
      <div>
        <div className="text-xs mb-2 text-muted-foreground">Top bar (dropdown)</div>
        <div className="flex h-10 items-center rounded-lg bg-background px-2">
          <WorkspaceSwitcher
            variant="topbar"
            workspaces={workspaces}
            activeWorkspaceId={activeWorkspaceId}
            onSelect={onSelect}
            workspaceUnreadMap={workspaceUnreadMap}
          />
        </div>
      </div>
      <div>
        <div className="text-xs mb-2 text-muted-foreground">Compact (drawer)</div>
        <div className="flex h-12 items-center rounded-lg bg-background px-2">
          <CompactWorkspaceSwitcher
            workspaces={workspaces}
            activeWorkspaceId={activeWorkspaceId}
            onSelect={onSelect}
            workspaceUnreadMap={workspaceUnreadMap}
          />
        </div>
      </div>
    </div>
  )
}

export const workspaceAvatarComponents: ComponentEntry[] = [
  {
    id: 'workspace-avatar',
    name: 'WorkspaceAvatar',
    category: 'Session List',
    description: 'Deterministic hue-initial workspace tile (id-derived); the switcher and target-list identity. Colour overrides arrive with UB15.9.',
    component: WorkspaceAvatarGallery,
    props: [],
  },
  {
    id: 'workspace-target-list',
    name: 'WorkspaceTargetList',
    category: 'Session List',
    description: 'UB14.61 — the pick-a-workspace list both Send to workspace dialogs share (v0.15.1): locals (Laptop), a reachable remote (Cloud), one still checking (pulsing), one without a saved credential (CloudOff, not pickable).',
    component: WorkspaceTargetListPreview,
    props: [
      {
        name: 'scenario',
        description: 'Which list the dialog hands over',
        control: { type: 'select', options: [
          { label: 'Every kind of target', value: 'mixed' },
          { label: 'Sending (every row disabled)', value: 'sending' },
          { label: 'No other workspace', value: 'empty' },
        ] },
        defaultValue: 'mixed',
      },
      { name: 'selected', description: 'A target is picked', control: { type: 'boolean' }, defaultValue: true },
    ],
    variants: [
      { name: 'Every kind of target', props: { scenario: 'mixed', selected: true } },
      { name: 'Nothing picked yet', props: { scenario: 'mixed', selected: false } },
      { name: 'Sending', props: { scenario: 'sending', selected: true } },
      { name: 'Empty', props: { scenario: 'empty' } },
    ],
  },
  {
    id: 'send-to-workspace-dialog',
    name: 'SendToWorkspaceDialog',
    category: 'Session List',
    description: 'UB14.61 — the two Send to workspace dialogs on the shared list: ghost Cancel, primary Send, the muted title glyph. Sessions or a resource (a skill here).',
    component: SendToWorkspaceDialogPreview,
    props: [
      {
        name: 'kind',
        description: 'Which dialog',
        control: { type: 'select', options: [
          { label: 'Sessions', value: 'sessions' },
          { label: 'Resource (skill)', value: 'resources' },
        ] },
        defaultValue: 'sessions',
      },
      { name: 'targets', description: 'Other workspaces exist', control: { type: 'boolean' }, defaultValue: true },
    ],
    variants: [
      { name: 'Sessions', props: { kind: 'sessions', targets: true } },
      { name: 'Sessions, no other workspace', props: { kind: 'sessions', targets: false } },
      { name: 'Resource', props: { kind: 'resources', targets: true } },
      { name: 'Resource, no other workspace', props: { kind: 'resources', targets: false } },
    ],
  },
  {
    id: 'workspace-switcher-triggers',
    name: 'WorkspaceSwitcher',
    category: 'Session List',
    description: 'UB14.61 — the top-bar and compact switcher triggers on v0.15.1 classes (flat label, square avatar, accent unread dot); click to open the dropdown or the drawer.',
    component: WorkspaceSwitcherTriggersPreview,
    props: [
      {
        name: 'active',
        description: 'The active workspace',
        control: { type: 'select', options: [
          { label: 'Local', value: 'local' },
          { label: 'Remote', value: 'remote' },
        ] },
        defaultValue: 'local',
      },
      { name: 'unread', description: 'Another workspace has unread sessions', control: { type: 'boolean' }, defaultValue: true },
    ],
    variants: [
      { name: 'Local, unread elsewhere', props: { active: 'local', unread: true } },
      { name: 'Remote active', props: { active: 'remote', unread: false } },
    ],
  },
]
