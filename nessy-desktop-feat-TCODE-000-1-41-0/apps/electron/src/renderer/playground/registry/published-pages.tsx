/**
 * UA1.19 — playground entries for the Published pages list and the artifact chip (t-artifacts). The plan's sweep
 * names six list states — none, live, expiring in under 24 h, expired, needs-login, pending deletion — and the chip's
 * three (live, never expires, expired). IPC-free: the list is the pure `PublishedPagesView`, callbacks are no-ops,
 * and `now` is fixed so the states do not drift with the clock.
 *
 * UB12.58 — the list moved onto v0.15.1's settings material, so every state that material touches is a variant: the
 * first paint (loading), the service failure (the same ONE card as needs-login), the registry note over a list whose
 * rows lost their sources, a row while its extend or delete is in flight (busy), and a shared chat's badge.
 */
import * as React from 'react'
import { PublishedArtifactChip } from '@nessy-agent/ui/chat/PublishedArtifactChip'
import type { PublishedArtifactDto } from '@nessy-agent/shared/protocol'
import { PublishedPagesView, type PublishedPagesStatus } from '@/components/artifacts/PublishedPagesSection'
import type { ComponentEntry } from './types'

const NOW = Date.parse('2026-10-02T12:00:00.000Z')
const HOUR = 60 * 60 * 1000
const link = (id: string) => `https://t-artifacts.t-tech.team/a/${id}`

type ListState =
  | 'none' | 'live' | 'expiring-soon' | 'expired' | 'needs-login' | 'pending-deletion'
  | 'loading' | 'unavailable' | 'registry-unreadable' | 'busy' | 'shared-chat'

const LIVE: PublishedArtifactDto = {
  id: 'AbCdEfGhIjKlMnOpQrStUv', url: link('AbCdEfGhIjKlMnOpQrStUv'), title: 'Q3 report', emoji: '📊',
  expiresAt: new Date(NOW + 6 * 24 * HOUR).toISOString(), retentionDays: 7,
  source: { sessionId: 'session-1', path: 'out/q3.html', kind: 'file' },
}
const OUTSIDE: PublishedArtifactDto = {
  id: 'ZyXwVuTsRqPoNmLkJiHgFe', url: link('ZyXwVuTsRqPoNmLkJiHgFe'), title: 'Published elsewhere',
  expiresAt: null, retentionDays: 0,
}

function rowsFor(state: ListState): { status: PublishedPagesStatus; rows: PublishedArtifactDto[]; message?: string; busyId?: string } {
  switch (state) {
    case 'none': return { status: 'ok', rows: [] }
    case 'live': return { status: 'ok', rows: [LIVE, OUTSIDE] }
    case 'expiring-soon': return { status: 'ok', rows: [{ ...LIVE, expiresAt: new Date(NOW + 5 * HOUR).toISOString() }] }
    case 'expired': return { status: 'ok', rows: [{ ...LIVE, expiresAt: new Date(NOW - 2 * HOUR).toISOString() }] }
    case 'needs-login': return {
      status: 'needs-login',
      message: 'dp is not signed in. Sign in to dp and try again.',
      rows: [{ ...LIVE, pendingDelete: { requestedAt: new Date(NOW - HOUR).toISOString(), lastErrorKind: 'needs-login' } }],
    }
    case 'pending-deletion': return {
      status: 'ok',
      rows: [LIVE, { ...OUTSIDE, pendingDelete: { requestedAt: new Date(NOW - HOUR).toISOString(), lastErrorKind: 'network' } }],
    }
    case 'loading': return { status: 'loading', rows: [] }
    case 'unavailable': return { status: 'unavailable', message: 't-artifacts answered 503 Service Unavailable.', rows: [] }
    case 'registry-unreadable': return {
      status: 'ok',
      // The host's own sentence (server-core `listPublishedArtifacts`) when the registry cannot be read.
      message: 'This workspace\'s artifact registry could not be read; pages are listed without their source sessions.',
      rows: [{ ...LIVE, source: undefined }],
    }
    case 'busy': return { status: 'ok', rows: [LIVE, OUTSIDE], busyId: LIVE.id }
    case 'shared-chat': return {
      status: 'ok',
      rows: [{ ...LIVE, id: 'ChAtShArEdLiNk00000001', url: link('ChAtShArEdLiNk00000001'), title: 'Fix the build', emoji: '💬', source: { sessionId: 'session-2', path: 'Fix the build', kind: 'chat' } }, LIVE],
    }
  }
}

function PublishedPagesPreview({ state }: { state: ListState }) {
  const { status, rows, message, busyId } = rowsFor(state)
  const noop = () => {}
  return (
    <div className="w-[720px]">
      <PublishedPagesView
        status={status}
        message={message}
        rows={rows}
        now={NOW}
        busyId={busyId}
        onOpen={noop}
        onCopy={noop}
        onExtend={noop}
        onDelete={noop}
        onRetry={noop}
      />
    </div>
  )
}

type ChipState = 'live' | 'never' | 'expired'

function ChipPreview({ state }: { state: ChipState }) {
  const expires = state === 'never' ? null : new Date(NOW + (state === 'expired' ? -HOUR : 6 * 24 * HOUR)).toISOString()
  const content = JSON.stringify({ url: LIVE.url, expires_at: expires, updated: false, note: 'Published out/q3.html.' }, null, 2)
  return (
    <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
      <span>Publish Artifact · out/q3.html</span>
      <PublishedArtifactChip activity={{ toolName: 'mcp__session__publish_artifact', status: 'completed', content }} now={NOW} />
    </div>
  )
}

const LIST_STATES = [
  'none', 'live', 'expiring-soon', 'expired', 'needs-login', 'pending-deletion',
  'loading', 'unavailable', 'registry-unreadable', 'busy', 'shared-chat',
] as const

export const publishedPagesComponents: ComponentEntry[] = [
  {
    id: 'published-pages-list',
    name: 'Published pages',
    category: 'Settings',
    description: 'UA1.19 — Settings → Workspace: the dp identity\'s pages on t-artifacts joined to this workspace\'s registry; open, copy, extend (unlimited included) and delete, each with its own confirmation; a failed delete stays as a pending deletion; signed out = ONE card, no browser.',
    component: PublishedPagesPreview,
    layout: 'top',
    props: [
      { name: 'state', description: 'The list state', control: { type: 'select', options: LIST_STATES.map(value => ({ label: value, value })) }, defaultValue: 'live' },
    ],
    variants: LIST_STATES.map(state => ({ name: state, props: { state } })),
  },
  {
    id: 'published-artifact-chip',
    name: 'Artifact chip',
    category: 'Turn Cards',
    description: 'UA1.19 — the chip on a completed publish_artifact row: open, copy, and the absolute expiry date.',
    component: ChipPreview,
    props: [
      { name: 'state', description: 'The link\'s expiry', control: { type: 'select', options: [
        { label: 'live', value: 'live' },
        { label: 'never expires', value: 'never' },
        { label: 'expired', value: 'expired' },
      ] }, defaultValue: 'live' },
    ],
    variants: [
      { name: 'live', props: { state: 'live' } },
      { name: 'never expires', props: { state: 'never' } },
      { name: 'expired', props: { state: 'expired' } },
    ],
  },
]
