/**
 * Playground registry for the LEFT SIDEBAR's navigation rows — UB4.11 (upstream v0.14.1 "Long sidebar names fit on
 * one line": `LeftSidebar.tsx` `SidebarButton` puts the title in a `min-w-0 flex-1 truncate` span with `title=` the
 * name) — and, since UB14.4, the shell chrome around it: `SidebarPane` (New session, the scrolling
 * navigation with the "Workspace" section heading, the PINNED footer), a `ShellResizeHandle` on its seam, and the
 * detail pane's empty states (`DetailEmptyState`, `SessionsEmptyState`).
 *
 * Upstream v0.15.1 has no LeftSidebar/SidebarPane playground entry, so this file is ours (Extensions log, UB4.11 and
 * UB14.4 ADDED). It renders the SHIPPED components at the sidebar's resting width (232 px, the `AppShell.tsx`
 * `storage.KEYS.sidebarWidth` fallback since UB14.4; 220 before), with the sections the app mounts (UA5.8, UA7.3).
 * The one-line-titles states worth reviewing, in dark theme too:
 *
 *  - **short names** — every row reads in full, the counts sit right-aligned;
 *  - **a long page name** — one line ending in "…", the full name in the native tooltip (`title=`), the row height
 *    unchanged (before UB4.11 it wrapped onto several centred lines);
 *  - **a long top-level name** — the same rule on a top-level row: the count badge stays outside the truncation;
 *  - **collapsed** — the sections closed, their children absent.
 *
 * No context menus here (the right-click menus are `SidebarMenu`'s own surface); clicks have no listener.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Archive,
  Bot,
  Cake,
  CheckCircle2,
  Circle,
  Clock,
  DatabaseZap,
  Flag,
  FolderKanban,
  Inbox,
  ListTodo,
  PanelsTopLeft,
  Puzzle,
  Settings,
  Tag,
  Webhook,
  Zap,
} from 'lucide-react'
import { LeftSidebar, type SidebarItem } from '@/components/app-shell/LeftSidebar'
import { SidebarPane } from '@/components/app-shell/SidebarPane'
import { ShellResizeHandle } from '@/components/app-shell/ShellResizeHandle'
import { DetailEmptyState, SessionsEmptyState } from '@/components/app-shell/DetailEmptyState'
import { PANEL_SASH_HALF_HIT_WIDTH } from '@/components/app-shell/panel-constants'
import { ActionRegistryProvider } from '@/actions/registry'
import type { ComponentEntry } from './types'

/** 120 characters: the row's positive case ("a 120-character page name renders one line"). */
export const LONG_PAGE_NAME =
  'Quarterly gateway latency review for the Nestor coder and fast aliases across every region, with per-model breakdown too'
export const LONG_PROJECT_NAME = 'Nessy Desktop — upstream adoption through v0.15.1 with the redesign carried over one to one'

export interface LeftSidebarPreviewProps {
  pageName: 'short' | 'long'
  projectName: 'short' | 'long'
  expanded: boolean
}

export function buildLeftSidebarLinks(
  { pageName, projectName, expanded }: LeftSidebarPreviewProps,
  titles: { projects: string; pages: string },
): SidebarItem[] {
  const pages = [
    { id: 'build-health', name: 'Build Health' },
    { id: 'release-notes', name: pageName === 'long' ? LONG_PAGE_NAME : 'Release Notes' },
  ]
  const projects = [{ id: 'nessy', name: projectName === 'long' ? LONG_PROJECT_NAME : 'Nessy Desktop' }]
  return [
    {
      id: 'nav:projects',
      title: titles.projects,
      label: String(projects.length),
      icon: FolderKanban,
      variant: 'ghost',
      expandable: true,
      expanded,
      items: projects.map(p => ({ id: `nav:projects:${p.id}`, title: p.name, icon: FolderKanban, variant: 'ghost' as const })),
    },
    {
      id: 'nav:pages',
      title: titles.pages,
      label: String(pages.length),
      icon: PanelsTopLeft,
      variant: 'default',
      expandable: true,
      expanded,
      items: pages.map(p => ({ id: `nav:pages:${p.id}`, title: p.name, icon: PanelsTopLeft, variant: 'ghost' as const })),
    },
    // A top-level row whose own name is long: the count badge must stay visible beside the "…".
    { id: 'nav:long-top-level', title: projectName === 'long' ? LONG_PROJECT_NAME : 'Automations', label: '12', icon: PanelsTopLeft, variant: 'ghost' },
  ]
}

function LeftSidebarPreview(props: LeftSidebarPreviewProps) {
  const { t } = useTranslation()
  const links = buildLeftSidebarLinks(props, { projects: t('sidebar.projects'), pages: t('sidebar.pages') })
  return (
    <div className="w-[232px] rounded-[8px] bg-background shadow-minimal">
      <LeftSidebar isCollapsed={false} links={links} />
    </div>
  )
}

// ============================================================================
// UB14.4 — SidebarPane (pinned footer, Workspace section) + the seam handle
// ============================================================================

export type SidebarPaneHeight = 'tall' | 'window600' | 'short'

/** The preview column's height: a tall window, the row's 600 px window ("the footer stays visible"), a short one. */
export const SIDEBAR_PANE_HEIGHTS: Record<SidebarPaneHeight, number> = { tall: 860, window600: 556, short: 360 }

export interface SidebarPanePreviewProps {
  height: SidebarPaneHeight
  /** Which row is the current one (a fill, never weight) */
  selected: 'allSessions' | 'sources' | 'settings'
  expanded: boolean
  /** The seam handle beside the pane: idle, or hovered (its pointer-following gradient) */
  handle: 'idle' | 'hover'
}

/**
 * The app's navigator set (AppShell `sidebarLinks` / `sidebarFooterLinks`), with fixture counts: All Sessions with
 * statuses, Flagged and Archived; Labels; the "Workspace" heading; Sources with our nested Plugins/Hooks/Skills;
 * Projects; Pages; Automations. The footer: Settings, our top-level Plugins, What's New.
 */
export function buildSidebarPaneLinks(
  { selected, expanded }: Pick<SidebarPanePreviewProps, 'selected' | 'expanded'>,
  t: (key: string) => string,
): { links: SidebarItem[]; footerLinks: SidebarItem[] } {
  const v = (id: SidebarPanePreviewProps['selected']) => (selected === id ? 'default' as const : 'ghost' as const)
  const links: SidebarItem[] = [
    {
      id: 'nav:allSessions', title: t('sidebar.allSessions'), label: '42', icon: Inbox, variant: v('allSessions'),
      expandable: true, expanded,
      items: [
        { id: 'nav:state:todo', title: t('status.todo'), label: '12', icon: Circle, variant: 'ghost' },
        { id: 'nav:state:done', title: t('status.done'), label: '0', icon: CheckCircle2, variant: 'ghost' },
        { id: 'separator:states-flagged', type: 'separator' },
        { id: 'nav:flagged', title: t('sidebar.flagged'), label: '3', icon: Flag, variant: 'ghost' },
        { id: 'nav:archived', title: t('sidebar.archived'), icon: Archive, variant: 'ghost' },
      ],
    },
    { id: 'nav:labels', title: t('sidebar.labels'), icon: Tag, variant: 'ghost' },
    { id: 'section:workspace', type: 'section', title: t('sidebar.workspaceSection') },
    {
      id: 'nav:sources', title: t('sidebar.sources'), label: '7', icon: DatabaseZap, variant: v('sources'),
      expandable: true, expanded,
      items: [
        { id: 'nav:sources:plugins', title: t('sidebar.plugins'), label: '2', icon: Puzzle, variant: 'ghost' },
        { id: 'nav:sources:hooks', title: t('sidebar.hooks'), icon: Webhook, variant: 'ghost' },
        { id: 'nav:sources:skills', title: t('sidebar.skills'), label: '5', icon: Zap, variant: 'ghost' },
      ],
    },
    { id: 'nav:projects', title: t('sidebar.projects'), label: '1', icon: FolderKanban, variant: 'ghost' },
    { id: 'nav:pages', title: t('sidebar.pages'), label: '2', icon: PanelsTopLeft, variant: 'ghost' },
    {
      id: 'nav:automations', title: t('sidebar.automations'), label: '4', icon: ListTodo, variant: 'ghost',
      expandable: true, expanded,
      items: [
        { id: 'nav:automations:scheduled', title: t('sidebar.scheduled'), label: '2', icon: Clock, variant: 'ghost' },
        { id: 'nav:automations:agentic', title: t('sidebar.agentic'), label: '2', icon: Bot, variant: 'ghost' },
      ],
    },
  ]
  const footerLinks: SidebarItem[] = [
    { id: 'nav:settings', title: t('sidebar.settings'), icon: Settings, variant: v('settings') },
    { id: 'nav:plugins', title: t('sidebar.plugins'), icon: Puzzle, variant: 'ghost' },
    { id: 'nav:whats-new', title: t('sidebar.whatsNew'), icon: Cake, variant: 'ghost' },
  ]
  return { links, footerLinks }
}

const SIDEBAR_PANE_WIDTH = 232

function SidebarPanePreview({ height, selected, expanded, handle }: SidebarPanePreviewProps) {
  const { t } = useTranslation()
  const { links, footerLinks } = buildSidebarPaneLinks({ selected, expanded }, t)
  const handleRef = React.useRef<HTMLDivElement>(null)
  const [hoverY, setHoverY] = React.useState<number | null>(handle === 'hover' ? 120 : null)
  React.useEffect(() => setHoverY(handle === 'hover' ? 120 : null), [handle])
  return (
    <div className="relative flex bg-navigator" style={{ height: SIDEBAR_PANE_HEIGHTS[height], width: SIDEBAR_PANE_WIDTH + 120 }}>
      <SidebarPane
        paneRef={() => {}}
        width={SIDEBAR_PANE_WIDTH}
        focused={false}
        onKeyDown={() => {}}
        links={links}
        footerLinks={footerLinks}
        onNewSession={() => {}}
        newSessionLabel={t('session.newSession')}
        newSessionHotkey="⌘N"
        onNewChatInWorktree={() => {}}
      />
      <ShellResizeHandle
        handleRef={handleRef}
        left={SIDEBAR_PANE_WIDTH - PANEL_SASH_HALF_HIT_WIDTH}
        hoverY={hoverY}
        onHoverYChange={setHoverY}
        keepHoverOnLeave={handle === 'hover'}
        onDragStart={() => {}}
      />
      <div className="flex-1 rounded-l-[12px] bg-background shadow-elev-1" />
    </div>
  )
}

// ============================================================================
// UB14.4 — the detail pane's empty states (mounted per navigator by UB14.56)
// ============================================================================

export interface DetailEmptyStatePreviewProps {
  kind: 'sessions' | 'firstSession' | 'message'
}

function DetailEmptyStatePreview({ kind }: DetailEmptyStatePreviewProps) {
  const { t } = useTranslation()
  return (
    <ActionRegistryProvider>
      <div className="h-[360px] w-[520px] rounded-[12px] bg-background shadow-elev-1">
        {kind === 'message'
          ? <DetailEmptyState message={t('automations.selectAutomation')} />
          : <SessionsEmptyState hasSessions={kind === 'sessions'} />}
      </div>
    </ActionRegistryProvider>
  )
}

export const leftSidebarComponents: ComponentEntry[] = [
  {
    id: 'left-sidebar-titles',
    name: 'Left Sidebar · one-line titles',
    category: 'Session List',
    description: 'UB4.11 (v0.14.1): sidebar names stay on one line, end in "…" and show the full name on hover',
    component: LeftSidebarPreview,
    layout: 'top',
    props: [
      {
        name: 'pageName',
        description: 'The second page\'s name under Pages',
        control: { type: 'select', options: [{ label: 'Short', value: 'short' }, { label: 'Long (120 characters)', value: 'long' }] },
        defaultValue: 'long',
      },
      {
        name: 'projectName',
        description: 'The project\'s name and the top-level row\'s name',
        control: { type: 'select', options: [{ label: 'Short', value: 'short' }, { label: 'Long', value: 'long' }] },
        defaultValue: 'short',
      },
      { name: 'expanded', description: 'Projects and Pages expanded', control: { type: 'boolean' }, defaultValue: true },
    ],
    variants: [
      { name: 'Short names', props: { pageName: 'short', projectName: 'short', expanded: true } },
      { name: 'Long page name', props: { pageName: 'long', projectName: 'short', expanded: true } },
      { name: 'Long top-level name', props: { pageName: 'short', projectName: 'long', expanded: true } },
      { name: 'Collapsed', props: { pageName: 'long', projectName: 'long', expanded: false } },
    ],
  },
  {
    id: 'sidebar-pane',
    name: 'Sidebar Pane · pinned footer',
    category: 'Session List',
    description: 'UB14.4 (v0.15.1): New session with its shortcut on hover, the scrolling navigation with the Workspace heading, Settings / Plugins / What\'s New pinned below at any height, the seam handle',
    component: SidebarPanePreview,
    layout: 'top',
    props: [
      {
        name: 'height',
        description: 'The window height the pane gets',
        control: { type: 'select', options: [{ label: 'Tall', value: 'tall' }, { label: '600 px window', value: 'window600' }, { label: 'Short', value: 'short' }] },
        defaultValue: 'window600',
      },
      {
        name: 'selected',
        description: 'The current row (a fill, never weight)',
        control: { type: 'select', options: [{ label: 'All Sessions', value: 'allSessions' }, { label: 'Sources', value: 'sources' }, { label: 'Settings (footer)', value: 'settings' }] },
        defaultValue: 'allSessions',
      },
      { name: 'expanded', description: 'All Sessions, Sources and Automations expanded', control: { type: 'boolean' }, defaultValue: true },
      {
        name: 'handle',
        description: 'The seam handle beside the pane',
        control: { type: 'select', options: [{ label: 'Idle', value: 'idle' }, { label: 'Hovered', value: 'hover' }] },
        defaultValue: 'idle',
      },
    ],
    variants: [
      { name: 'Tall window', props: { height: 'tall', selected: 'allSessions', expanded: true, handle: 'idle' } },
      { name: '600 px window', props: { height: 'window600', selected: 'allSessions', expanded: true, handle: 'idle' } },
      { name: 'Short window', props: { height: 'short', selected: 'settings', expanded: true, handle: 'idle' } },
      { name: 'Collapsed sections', props: { height: 'window600', selected: 'sources', expanded: false, handle: 'idle' } },
      { name: 'Seam hovered', props: { height: 'window600', selected: 'allSessions', expanded: false, handle: 'hover' } },
    ],
  },
  {
    id: 'detail-empty-states',
    name: 'Detail Empty States',
    category: 'Session List',
    description: 'UB14.4 (v0.15.1 DetailEmptyState): what the pane beside a list shows while nothing is selected',
    component: DetailEmptyStatePreview,
    layout: 'top',
    props: [
      {
        name: 'kind',
        description: 'Sessions with sessions, the first-session question, or one quiet line',
        control: { type: 'select', options: [{ label: 'Sessions', value: 'sessions' }, { label: 'First session', value: 'firstSession' }, { label: 'Message', value: 'message' }] },
        defaultValue: 'sessions',
      },
    ],
    variants: [
      { name: 'Sessions', props: { kind: 'sessions' } },
      { name: 'First session', props: { kind: 'firstSession' } },
      { name: 'Message', props: { kind: 'message' } },
    ],
  },
]
