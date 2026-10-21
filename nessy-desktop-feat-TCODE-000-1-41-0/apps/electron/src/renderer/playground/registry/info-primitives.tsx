/**
 * Playground registry for the INFO PRIMITIVES at v0.15.1 (UB14.43).
 *
 * The detail pages (Source, Skill, Plugin through `CapabilityDetailTemplate`; Automation and
 * Project through `Info_Page` directly) are built from these primitives, so their states are
 * reviewed here once, apart from any page's data:
 * - `info-page`: `Info_Page` in each of its four states (content, loading, error, empty) and the
 *   hero anatomy v0.15.1 adds — the 36px tile with a hairline ring, the 20/28 title, the meta line
 *   (`meta` before the tagline) and `actions` on the right, under a header that carries the named
 *   ⋯ (`Info_HeaderMenu`) only. The bare hero (no meta, no tagline, no actions) is the control.
 * - `info-alerts`: `Info_Alert` in all four roles (warning neutral, error, info amber, success).
 * - `info-badges`: `Info_Badge` in every colour with and without `dot` (`default` is the neutral
 *   fill, `muted` the outlined code-like chip), `Info_StatusBadge` and `Info_StatePill`'s four tones.
 *
 * Dark theme is the review target. IPC-free: the avatar is a plain tile and nothing here touches
 * `window.electronAPI`.
 */

import * as React from 'react'
import { AlertTriangle, CircleAlert, CircleCheck, Info, Pencil, Plug } from 'lucide-react'
import { Info_Alert } from '@/components/info/Info_Alert'
import { Info_Badge, type BadgeColor } from '@/components/info/Info_Badge'
import { Info_HeaderMenu } from '@/components/info/Info_HeaderMenu'
import { Info_Page } from '@/components/info/Info_Page'
import { Info_Section } from '@/components/info/Info_Section'
import { Info_StatePill, type StatePillTone } from '@/components/info/Info_StatePill'
import { Info_StatusBadge } from '@/components/info/Info_StatusBadge'
import { Info_Table } from '@/components/info/Info_Table'
import { Button } from '@/components/ui/button'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import type { ComponentEntry } from './types'

// ============================================================================
// info-page
// ============================================================================

type PageState = 'content' | 'loading' | 'error' | 'empty'

interface InfoPagePreviewProps {
  state: PageState
  withMeta: boolean
  withTagline: boolean
  withActions: boolean
  withHeaderMenu: boolean
}

function HeroTile() {
  return (
    <div className="flex size-full items-center justify-center bg-fill-hover">
      <Plug className="size-4 text-secondary" />
    </div>
  )
}

function InfoPagePreview({ state, withMeta, withTagline, withActions, withHeaderMenu }: InfoPagePreviewProps) {
  return (
    <Info_Page
      loading={state === 'loading'}
      error={state === 'error' ? 'The source configuration could not be read.' : undefined}
      empty={state === 'empty' ? 'Nothing to show for this source yet.' : undefined}
    >
      <Info_Page.Header
        actions={withHeaderMenu ? (
          <Info_HeaderMenu label="More source actions">
            <DropdownMenuItem>Open in new window</DropdownMenuItem>
            <DropdownMenuItem>Delete source</DropdownMenuItem>
          </Info_HeaderMenu>
        ) : undefined}
      />
      {state === 'content' && (
        <Info_Page.Content>
          <Info_Page.Hero
            avatar={<HeroTile />}
            title="GitHub"
            tagline={withTagline ? 'Repositories, issues and pull requests for the connected organization.' : null}
            meta={withMeta ? (
              <>
                <Info_StatePill tone="ok">Connected</Info_StatePill>
                <Info_Badge>MCP</Info_Badge>
              </>
            ) : undefined}
            actions={withActions ? (
              <Button variant="secondary" size="sm">
                <Pencil />
                Edit
              </Button>
            ) : undefined}
          />
          <Info_Section title="Connection" count={3}>
            <Info_Table>
              <Info_Table.Row label="Transport" value="Streamable HTTP" />
              <Info_Table.Row label="Endpoint">
                <code className="font-mono text-mono-ui">https://mcp.github.example/…</code>
              </Info_Table.Row>
              <Info_Table.Row label="Status">
                <Info_Badge color="success" dot>Active</Info_Badge>
              </Info_Table.Row>
            </Info_Table>
          </Info_Section>
          <Info_Section
            title="Permissions"
            description="Tools the agent may call without asking."
            actions={<Button variant="ghost" size="sm">Edit</Button>}
          >
            <Info_Table>
              <Info_Table.Row label="search_code">
                <Info_StatusBadge status="allowed" />
              </Info_Table.Row>
              <Info_Table.Row label="create_pull_request">
                <Info_StatusBadge status="requires-permission" />
              </Info_Table.Row>
            </Info_Table>
          </Info_Section>
        </Info_Page.Content>
      )}
    </Info_Page>
  )
}

// ============================================================================
// info-alerts
// ============================================================================

const ALERTS: Array<{ variant: 'warning' | 'error' | 'info' | 'success'; icon: React.ReactNode; title: string; body: string }> = [
  { variant: 'warning', icon: <Info />, title: 'Automation paused', body: 'It will not run until you turn it back on.' },
  { variant: 'error', icon: <CircleAlert />, title: 'Couldn\'t connect to GitHub', body: 'The server answered 401 Unauthorized.' },
  { variant: 'info', icon: <AlertTriangle />, title: 'Sign-in needed', body: 'Authenticate to load this source\'s tools.' },
  { variant: 'success', icon: <CircleCheck />, title: 'Test passed', body: 'The automation ran and every action succeeded.' },
]

function InfoAlertsPreview({ inline }: { inline: boolean }) {
  return (
    <div className="w-[560px] space-y-3">
      {ALERTS.map(alert => (
        <Info_Alert key={alert.variant} variant={alert.variant} inline={inline} icon={alert.icon}>
          <Info_Alert.Title>{alert.title}</Info_Alert.Title>
          <Info_Alert.Description>{alert.body}</Info_Alert.Description>
        </Info_Alert>
      ))}
    </div>
  )
}

// ============================================================================
// info-badges
// ============================================================================

const BADGE_COLORS: BadgeColor[] = ['success', 'warning', 'destructive', 'default', 'muted']
const PILL_TONES: Array<{ tone: StatePillTone; label: string }> = [
  { tone: 'ok', label: 'Connected' },
  { tone: 'warn', label: 'Needs sign-in' },
  { tone: 'bad', label: 'Failed' },
  { tone: 'off', label: 'Disabled' },
]

function InfoBadgesPreview({ dot }: { dot: boolean }) {
  return (
    <div className="w-[560px] space-y-4">
      <div className="flex flex-wrap items-center gap-2" data-row="badges">
        {BADGE_COLORS.map(color => (
          <Info_Badge key={color} color={color} dot={dot}>
            {color}
          </Info_Badge>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2" data-row="status-badges">
        <Info_StatusBadge status="allowed" />
        <Info_StatusBadge status="blocked" />
        <Info_StatusBadge status="requires-permission" />
      </div>
      <div className="flex flex-wrap items-center gap-2" data-row="state-pills">
        {PILL_TONES.map(pill => (
          <Info_StatePill key={pill.tone} tone={pill.tone}>
            {pill.label}
          </Info_StatePill>
        ))}
      </div>
    </div>
  )
}

export const infoPrimitiveComponents: ComponentEntry[] = [
  {
    id: 'info-page',
    name: 'Info Page',
    category: 'Capability Detail',
    description: 'Info_Page at v0.15.1 (UB14.43): the settings detail column, the hero with meta and actions under a header carrying the named ⋯ only, and the loading, error and empty states.',
    component: InfoPagePreview,
    layout: 'full',
    props: [
      {
        name: 'state',
        description: 'Which Info_Page state renders',
        control: {
          type: 'select',
          options: [
            { label: 'Content (hero + sections)', value: 'content' },
            { label: 'Loading', value: 'loading' },
            { label: 'Error', value: 'error' },
            { label: 'Empty', value: 'empty' },
          ],
        },
        defaultValue: 'content',
      },
      { name: 'withMeta', description: 'Hero meta line items (state pill + badge)', control: { type: 'boolean' }, defaultValue: true },
      { name: 'withTagline', description: 'Hero tagline', control: { type: 'boolean' }, defaultValue: true },
      { name: 'withActions', description: 'Hero actions (Edit)', control: { type: 'boolean' }, defaultValue: true },
      { name: 'withHeaderMenu', description: 'The named ⋯ in the header', control: { type: 'boolean' }, defaultValue: true },
    ],
    variants: [
      { name: 'Loading', props: { state: 'loading' } },
      { name: 'Error', props: { state: 'error' } },
      { name: 'Empty', props: { state: 'empty' } },
      {
        name: 'Bare hero',
        description: 'No meta, no tagline, no actions and no header menu: the hero draws the tile and the title only',
        props: { state: 'content', withMeta: false, withTagline: false, withActions: false, withHeaderMenu: false },
      },
    ],
  },
  {
    id: 'info-alerts',
    name: 'Info Alerts',
    category: 'Capability Detail',
    description: 'Info_Alert at v0.15.1 (UB14.43): warning (neutral), error, info (amber) and success on their role tints with an inset hairline.',
    component: InfoAlertsPreview,
    props: [
      { name: 'inline', description: 'Inline (tighter) padding', control: { type: 'boolean' }, defaultValue: false },
    ],
    variants: [{ name: 'Inline', props: { inline: true } }],
  },
  {
    id: 'info-badges',
    name: 'Info Badges',
    category: 'Capability Detail',
    description: 'Info_Badge (every colour; default = neutral fill, muted = outlined code-like), Info_StatusBadge with its dot, and Info_StatePill\'s four tones (UB14.43).',
    component: InfoBadgesPreview,
    props: [
      { name: 'dot', description: 'Leading status dot on every Info_Badge', control: { type: 'boolean' }, defaultValue: false },
    ],
    variants: [{ name: 'With dots', props: { dot: true } }],
  },
]
