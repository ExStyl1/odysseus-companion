/**
 * Playground registry for the PANEL STACK — UB14.2 (upstream v0.15.1 `PanelStackContainer.tsx` / `PanelSlot.tsx`:
 * the navigator canvas and the joined paper card, design spec §7.1).
 *
 * Upstream v0.15.1 has no panel-stack playground entry, so this file is ours (Extensions log, UB14.2 ADDED). It
 * renders the SHIPPED `PanelStackContainer` (and through it the shipped `PanelSlot` + `MainContentPanel`) on the
 * navigator canvas (`bg-navigator`), with a private Jotai store holding the content panels. Each content panel
 * shows the Projects route with nothing selected — a light page, so the materials are the subject. The states
 * worth reviewing, in dark theme too:
 *
 *  - **one panel** — the sidebar flush on the canvas (no card), the list and the content panel joined edge to
 *    edge into ONE paper card (square inner corners, the list's hairline is the divider);
 *  - **two panels** — the second panel is its own card, lifted (`shadow-elev-2`) because it is focused;
 *  - **sidebar hidden** — the joined card moves to the window edge (its outer left corners take `RADIUS_EDGE`);
 *  - **list hidden** — no joined card: the first content panel rounds all four corners;
 *  - **compact** — the absolute slide stack (the navigator over the canvas, no sidebar, no joined card).
 *
 * The FLIP motion (collapse/expand commits once and FLIPs the cards) needs a live layout: toggle `sidebar` or
 * `navigator` with `animate` on to watch it, off to see the instant (keyboard ⌘B / ⌘.) path. Under the Motion
 * setting "Reduced" nothing animates. Clicks have no listener beyond the panel's own close / focus.
 *
 * UB14.56 adds a second entry here, `main-panel-empty-states`: the shipped `MainContentPanel` itself, one state per
 * navigator with nothing selected (upstream v0.15.1 `DetailEmptyState` / `SessionsEmptyState`). It lives in this
 * file because this file already loads the content panel's graph — `left-sidebar.tsx`, home of UB14.4's bare
 * component entry, is imported in-process by `sidebar-pane.test.tsx` and `left-sidebar-title.test.tsx`, whose
 * process cannot load that graph (the pdfjs chain; `PendingAuthNotice.test.tsx` measured it).
 */

import * as React from 'react'
import { Provider as JotaiProvider, createStore } from 'jotai'
import { PanelStackContainer } from '@/components/app-shell/PanelStackContainer'
import { MainContentPanel } from '@/components/app-shell/MainContentPanel'
import { panelStackAtom, focusedPanelIdAtom, type PanelStackEntry } from '@/atoms/panel-stack'
import { sessionMetaMapAtom, type SessionMeta } from '@/atoms/sessions'
import { automationsAtom } from '@/atoms/automations'
import type { NavigationState } from '../../../shared/types'
import { PlaygroundAppShellProvider } from '../PlaygroundAppShellProvider'
import { mockScriptAutomation } from './automation-script-states'
import type { ComponentEntry } from './types'

/** Sidebar and list widths: the AppShell `storage.get` fallbacks of this tree (232/304 arrive with UB14.4). */
export const PREVIEW_SIDEBAR_WIDTH = 220
export const PREVIEW_NAVIGATOR_WIDTH = 300

export interface PanelStackPreviewProps {
  panels: '1' | '2'
  sidebar: boolean
  navigator: boolean
  compact: boolean
  animate: boolean
}

/** The content panels the preview's store holds; the last one is focused (lifted in a split view). */
export function buildPreviewPanels(panels: PanelStackPreviewProps['panels']): PanelStackEntry[] {
  const count = panels === '2' ? 2 : 1
  return Array.from({ length: count }, (_, index) => ({
    id: `playground-panel-${index + 1}`,
    route: 'projects',
    proportion: 1 / count,
    panelType: 'other',
    laneId: 'main',
  }))
}

function StubRows({ label, rows }: { label: string; rows: string[] }) {
  return (
    <div className="flex h-full flex-col gap-1 p-3 text-label">
      <p className="px-2 pb-1 font-semibold text-muted-foreground">{label}</p>
      {rows.map(row => (
        <div key={row} className="truncate rounded-[6px] px-2 py-1.5 text-foreground">{row}</div>
      ))}
    </div>
  )
}

function PanelStackPreview({ panels, sidebar, navigator, compact, animate }: PanelStackPreviewProps) {
  // A private store per panel count: the preview never reads or writes the playground window's own panel stack.
  const store = React.useMemo(() => {
    const next = createStore()
    const entries = buildPreviewPanels(panels)
    next.set(panelStackAtom, entries)
    next.set(focusedPanelIdAtom, entries[entries.length - 1]?.id ?? null)
    return next
  }, [panels])

  return (
    <JotaiProvider store={store}>
      <PlaygroundAppShellProvider>
        <div
          data-testid="panel-stack-preview"
          className="flex h-[440px] w-[980px] items-stretch bg-navigator"
          style={{ paddingRight: compact ? 0 : 6, paddingBottom: compact ? 0 : 6, paddingTop: 6 }}
        >
          <PanelStackContainer
            sidebarSlot={<StubRows label="Workspace" rows={['All sessions', 'Flagged', 'Projects', 'Pages', 'Automations']} />}
            sidebarWidth={sidebar && !compact ? PREVIEW_SIDEBAR_WIDTH : 0}
            navigatorSlot={<StubRows label="Sessions" rows={['Release checklist', 'Gateway latency review', 'Board triage']} />}
            navigatorWidth={navigator ? PREVIEW_NAVIGATOR_WIDTH : 0}
            isSidebarAndNavigatorHidden={!sidebar && !navigator}
            isRightSidebarVisible={false}
            isCompact={compact}
            animateLayout={animate}
          />
        </div>
      </PlaygroundAppShellProvider>
    </JotaiProvider>
  )
}

// ============================================================================
// UB14.56 — the content panel's empty state per navigator (v0.15.1 MainContentPanel + DetailEmptyState)
// ============================================================================

export type MainPanelEmptyKind = 'sessions' | 'firstSession' | 'sources' | 'skills' | 'automations' | 'noAutomations' | 'projects'

export interface MainPanelEmptyStatePreviewProps {
  kind: MainPanelEmptyKind
}

const PREVIEW_SESSION: SessionMeta = { id: 'playground-session-1', name: 'Release checklist', workspaceId: 'playground-workspace' }

/** The route each state shows: the navigator open, nothing selected in it. */
export function mainPanelEmptyNavState(kind: MainPanelEmptyKind): NavigationState {
  switch (kind) {
    case 'sessions':
    case 'firstSession':
      return { navigator: 'sessions', filter: { kind: 'allSessions' }, details: null }
    case 'sources':
      return { navigator: 'sources', details: null }
    case 'skills':
      return { navigator: 'skills', details: null }
    case 'automations':
    case 'noAutomations':
      return { navigator: 'automations', details: null }
    case 'projects':
      return { navigator: 'projects', details: null }
  }
}

function MainPanelEmptyStatePreview({ kind }: MainPanelEmptyStatePreviewProps) {
  // A private store: "has sessions" and "has automations" are the two lists the panel reads to pick its sentence.
  const store = React.useMemo(() => {
    const next = createStore()
    next.set(sessionMetaMapAtom, kind === 'sessions' ? new Map([[PREVIEW_SESSION.id, PREVIEW_SESSION]]) : new Map())
    next.set(automationsAtom, kind === 'automations' ? [mockScriptAutomation] : [])
    return next
  }, [kind])

  return (
    <JotaiProvider store={store}>
      <PlaygroundAppShellProvider>
        <div data-testid="main-panel-empty-preview" className="flex h-[360px] w-[640px] rounded-[12px] bg-background shadow-elev-1">
          <MainContentPanel navStateOverride={mainPanelEmptyNavState(kind)} />
        </div>
      </PlaygroundAppShellProvider>
    </JotaiProvider>
  )
}

export const panelStackComponents: ComponentEntry[] = [
  {
    id: 'panel-stack-materials',
    name: 'Panel Stack · joined paper card',
    category: 'Session List',
    description:
      'UB14.2 (v0.15.1): the sidebar flush on the navigator canvas, the list and the first content panel joined into one paper card, further panels in their own card; collapse/expand FLIPs the cards.',
    component: PanelStackPreview,
    layout: 'top',
    previewOverflow: 'auto',
    props: [
      {
        name: 'panels',
        description: 'Content panels in the stack (the last one is focused)',
        control: { type: 'select', options: [{ label: 'One', value: '1' }, { label: 'Two', value: '2' }] },
        defaultValue: '1',
      },
      { name: 'sidebar', description: 'Sidebar shown (flush on the canvas)', control: { type: 'boolean' }, defaultValue: true },
      { name: 'navigator', description: 'List shown (joins the first content panel)', control: { type: 'boolean' }, defaultValue: true },
      { name: 'compact', description: 'Compact layout (absolute slide stack)', control: { type: 'boolean' }, defaultValue: false },
      { name: 'animate', description: 'Pointer toggles animate (off = the instant keyboard path)', control: { type: 'boolean' }, defaultValue: true },
    ],
    variants: [
      { name: 'Joined card', props: { panels: '1', sidebar: true, navigator: true, compact: false } },
      { name: 'Joined card + second panel', props: { panels: '2', sidebar: true, navigator: true, compact: false } },
      { name: 'Sidebar hidden', props: { panels: '1', sidebar: false, navigator: true, compact: false } },
      { name: 'List hidden', props: { panels: '2', sidebar: true, navigator: false, compact: false } },
      { name: 'Compact', props: { panels: '1', sidebar: false, navigator: true, compact: true } },
    ],
  },
  {
    id: 'main-panel-empty-states',
    name: 'Main Panel · empty state per navigator',
    category: 'Session List',
    description:
      'UB14.56 (v0.15.1 MainContentPanel): the shipped content panel with nothing selected — the serif "pick up" or "first session" heading with the New session keycaps for sessions, one quiet line for sources, skills, automations and projects.',
    component: MainPanelEmptyStatePreview,
    layout: 'top',
    props: [
      {
        name: 'kind',
        description: 'The navigator open beside the panel, and whether its list has anything in it',
        control: {
          type: 'select',
          options: [
            { label: 'Sessions (some exist)', value: 'sessions' },
            { label: 'Sessions (none yet)', value: 'firstSession' },
            { label: 'Sources', value: 'sources' },
            { label: 'Skills', value: 'skills' },
            { label: 'Automations (some exist)', value: 'automations' },
            { label: 'Automations (none)', value: 'noAutomations' },
            { label: 'Projects', value: 'projects' },
          ],
        },
        defaultValue: 'sessions',
      },
    ],
    variants: [
      { name: 'Sessions', props: { kind: 'sessions' } },
      { name: 'First session', props: { kind: 'firstSession' } },
      { name: 'Sources', props: { kind: 'sources' } },
      { name: 'Skills', props: { kind: 'skills' } },
      { name: 'Automations', props: { kind: 'automations' } },
      { name: 'No automations', props: { kind: 'noAutomations' } },
      { name: 'Projects', props: { kind: 'projects' } },
    ],
  },
]
