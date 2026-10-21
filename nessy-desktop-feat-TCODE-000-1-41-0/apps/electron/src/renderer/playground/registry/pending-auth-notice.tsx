/**
 * Playground registry for the SESSION-START PENDING-AUTH NOTICE (T4,
 * plugin-install plan § 5).
 *
 * The knobs are the notice's feeds, because each is a distinct truth source:
 * the silently-dropped dp set (one sign-in unblocks N), sources awaiting
 * OAuth sign-in, credential-parked servers (informational), and servers whose
 * session-start connect failed (T10's broken-server surfacing).
 *
 * IPC-free: callbacks are no-ops, row states are knobs. The empty state is a
 * deliberate variant — the positive control is that NOTHING renders.
 */

import * as React from 'react'
import { PendingAuthNoticeView, type PendingAuthRowState } from '@/components/app-shell/PendingAuthNotice'
import type { SafeWorkspacePendingAuth } from '@nessy-agent/shared/protocol'
import type { ComponentEntry } from './types'

interface NoticeKnobs {
  dpServers: number
  oauthSources: number
  credentialMissing: boolean
  credentialExpired: boolean
  failedServers: number
  dpState: string
}

function buildSummary(knobs: NoticeKnobs): SafeWorkspacePendingAuth {
  const sources: SafeWorkspacePendingAuth['sources'] = []
  for (let index = 0; index < Math.max(0, knobs.oauthSources); index += 1) {
    sources.push({
      workspaceId: 'ws-preview',
      sourceSlug: `jira-${index + 1}`,
      name: `Jira ${index + 1}`,
      reason: 'needs-auth',
      canSignIn: true,
    })
  }
  if (knobs.credentialMissing) {
    sources.push({
      workspaceId: 'ws-preview',
      sourceSlug: 'internal-api',
      name: 'Internal API',
      reason: 'credential-missing',
      canSignIn: false,
    })
  }
  if (knobs.credentialExpired) {
    sources.push({
      workspaceId: 'ws-preview',
      sourceSlug: 'wiki',
      name: 'Wiki',
      reason: 'credential-expired',
      canSignIn: true,
    })
  }
  return {
    ...(knobs.dpServers > 0
      ? {
          dp: {
            state: 'needs-login' as const,
            serverNames: Array.from({ length: knobs.dpServers }, (_, index) => `dp-server-${index + 1}`),
          },
        }
      : {}),
    sources,
    failedServers: Array.from({ length: Math.max(0, knobs.failedServers) }, (_, index) => `broken-${index + 1}`),
  }
}

function NoticePreview(knobs: NoticeKnobs) {
  return (
    <div className="w-[560px] rounded-lg border">
      <PendingAuthNoticeView
        summary={buildSummary(knobs)}
        dpState={(knobs.dpState as PendingAuthRowState) ?? 'pending'}
        busySourceSlug={null}
        errorSourceSlug={null}
        onDpSignIn={() => {}}
        onSourceSignIn={() => {}}
        onDismiss={() => {}}
      />
    </div>
  )
}

const KNOBS: ComponentEntry['props'] = [
  { name: 'dpServers', description: 'dp-backed servers one Developer Platform sign-in unblocks (0 hides the row)', control: { type: 'number', min: 0, max: 14 }, defaultValue: 9 },
  { name: 'oauthSources', description: 'Sources awaiting OAuth sign-in — each row has a one-click non-interrupting Connect', control: { type: 'number', min: 0, max: 6 }, defaultValue: 2 },
  { name: 'credentialMissing', description: 'A credential-parked capability server — informational, values live on the plugin page', control: { type: 'boolean' }, defaultValue: false },
  { name: 'credentialExpired', description: 'A source whose stored credential expired — sign-in offered again', control: { type: 'boolean' }, defaultValue: false },
  { name: 'failedServers', description: 'Servers whose session-start connect failed (T10 broken-server surfacing)', control: { type: 'number', min: 0, max: 6 }, defaultValue: 0 },
  { name: 'dpState', description: 'The dp sign-in action state', control: { type: 'select', options: [
    { label: 'pending', value: 'pending' },
    { label: 'busy', value: 'busy' },
    { label: 'error', value: 'error' },
  ] }, defaultValue: 'pending' },
]

export const pendingAuthNoticeComponents: ComponentEntry[] = [
  {
    id: 'pending-auth-notice',
    name: 'Pending Auth Notice',
    category: 'Sources',
    description:
      'The session-start notice (plugin-install plan § 5): every server needing auth, each with a one-click sign-in that never interrupts a turn. Renders NOTHING when everything is ready (the positive control). Chrome comes from the shared SystemCard primitive.',
    component: NoticePreview,
    layout: 'centered',
    props: KNOBS,
    variants: [
      { name: 'nessy-default-extension', description: 'Fresh install: 9 dp servers + 2 OAuth sources pending', props: { dpServers: 9, oauthSources: 2, credentialMissing: false, credentialExpired: false, failedServers: 0, dpState: 'pending' } },
      { name: 'dp signing in', description: 'The one-click system flow in progress — the turn is never interrupted', props: { dpServers: 9, oauthSources: 0, credentialMissing: false, credentialExpired: false, failedServers: 0, dpState: 'busy' } },
      { name: 'Credential problems', description: 'A parked capability server (informational) and an expired source credential', props: { dpServers: 0, oauthSources: 0, credentialMissing: true, credentialExpired: true, failedServers: 0, dpState: 'pending' } },
      { name: 'Broken server at start', description: 'T10: a failed session-start connect surfaces here, not at first tool call', props: { dpServers: 0, oauthSources: 1, credentialMissing: false, credentialExpired: false, failedServers: 1, dpState: 'pending' } },
      { name: 'All ready (renders nothing)', description: 'The positive control: dp ready and all sources authed → no notice', props: { dpServers: 0, oauthSources: 0, credentialMissing: false, credentialExpired: false, failedServers: 0, dpState: 'pending' } },
    ],
  },
]
