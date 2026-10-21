import * as React from 'react'
import type { ComponentEntry } from './types'
import type { SessionMeta } from '@/atoms/sessions'
import type { SessionStatus } from '@/config/session-status-config'
import type { ContentSearchResult } from '@/hooks/useSessionSearch'
import { Circle } from 'lucide-react'
import { SessionSearchHeader } from '@/components/app-shell/SessionSearchHeader'
import { SessionItem } from '@/components/app-shell/SessionItem'
import { SessionRowPermissionAnswer } from '@/components/app-shell/SessionRowPermissionAnswer'
import { SessionBadges } from '@/components/app-shell/SessionBadges'
import { SessionInfoPopover } from '@/components/app-shell/SessionInfoPopover'
import { SessionFilterMenu } from '@/components/app-shell/SessionFilterMenu'
import { CompactSessionListFilter } from '@/components/app-shell/CompactSessionListFilter'
import type { FilterMode } from '@/components/app-shell/inherited-filter-params'
import type { ChatGroupingMode } from '@/components/app-shell/SessionList'
import type { LabelConfig } from '@nessy-agent/shared/labels'
import { SessionListProvider, type SessionListContextValue } from '@/context/SessionListContext'
import { ActionRegistryProvider } from '@/actions/registry'
import { PlaygroundAppShellProvider } from '../PlaygroundAppShellProvider'
import type { PermissionRequest } from '@nessy-agent/shared/protocol'

// ============================================================================
// Mock Todo States (minimal set for playground)
// ============================================================================

const mockSessionStatuses: SessionStatus[] = [
  {
    id: 'todo',
    label: 'Todo',
    resolvedColor: 'var(--muted-foreground)',
    icon: <Circle className="h-3.5 w-3.5" strokeWidth={1.5} />,
    iconColorable: true,
    category: 'open',
  },
  {
    id: 'in-progress',
    label: 'In Progress',
    resolvedColor: 'var(--info)',
    icon: <Circle className="h-3.5 w-3.5" strokeWidth={1.5} />,
    iconColorable: true,
    category: 'open',
  },
  {
    id: 'done',
    label: 'Done',
    resolvedColor: 'var(--success)',
    icon: <Circle className="h-3.5 w-3.5" strokeWidth={1.5} />,
    iconColorable: true,
    category: 'closed',
  },
]

// ============================================================================
// Sample Session Data
// ============================================================================

const sampleSessions: SessionMeta[] = [
  {
    id: 'session-1',
    name: 'Fix authentication bug in login flow',
    workspaceId: 'workspace-1',
    lastMessageAt: Date.now() - 1000 * 60 * 5, // 5 min ago
    sessionStatus: 'in-progress',
    hasUnread: true,
    isFlagged: true,
  },
  {
    id: 'session-2',
    name: 'Implement search functionality',
    workspaceId: 'workspace-1',
    lastMessageAt: Date.now() - 1000 * 60 * 30, // 30 min ago
    sessionStatus: 'todo',
    isFlagged: true,
    labels: ['feature', 'priority::high'],
  },
  {
    id: 'session-3',
    name: 'Review pull request #42',
    workspaceId: 'workspace-1',
    lastMessageAt: Date.now() - 1000 * 60 * 60, // 1 hour ago
    sessionStatus: 'done',
    isFlagged: true,
    isProcessing: true,
  },
  {
    id: 'session-4',
    name: 'Debug API response handling',
    workspaceId: 'workspace-1',
    lastMessageAt: Date.now() - 1000 * 60 * 60 * 2, // 2 hours ago
    sessionStatus: 'todo',
    isFlagged: true,
  },
]

function createMockContext(overrides: Partial<SessionListContextValue> = {}): SessionListContextValue {
  return {
    onRenameClick: () => {},
    onSessionStatusChange: () => {},
    onMarkUnread: () => {},
    onDelete: async () => true,
    onSelectSessionById: () => {},
    onOpenInNewWindow: () => {},
    onFocusZone: () => {},
    onKeyDown: () => {},
    sessionStatuses: mockSessionStatuses,
    flatLabels: [],
    labels: [],
    isMultiSelectActive: false,
    contentSearchResults: new Map(),
    ...overrides,
  }
}

const noopKeyDown = () => {}

// UB14.3 — labels for the row's second line and the "+N" expand. Six entries: on a 320px row only the
// first few chips are whole, the rest sit behind "+N".
const mockLabels: LabelConfig[] = [
  { id: 'bug', name: 'Bug', color: 'destructive' },
  { id: 'feature', name: 'Feature', color: 'accent' },
  { id: 'frontend', name: 'Frontend', color: 'info' },
  { id: 'backend', name: 'Backend', color: 'success' },
  { id: 'priority', name: 'Priority', color: 'foreground/50', valueType: 'string' },
  { id: 'research', name: 'Research' },
]
const sixLabelEntries = ['bug', 'feature', 'frontend', 'backend', 'priority::high', 'research']

// ============================================================================
// SessionListSearchPreview - Renders REAL SessionItem components with context
// ============================================================================

interface SessionListSearchPreviewProps {
  /** Current search query (highlights matches in titles) */
  searchQuery?: string
  /** Show search input bar */
  showSearchInput?: boolean
  /** Show loading state in status row */
  isSearching?: boolean
  /** Index of currently selected session (0-based) */
  selectedIndex?: number
  /** Match count for selected session (shows yellow badge) */
  chatMatchCount?: number
  /** Whether to show "no results" state */
  showNoResults?: boolean
  /** Explicit result count to display (defaults to filtered session count) */
  resultCount?: number
}

function SessionListSearchPreview({
  searchQuery = '',
  showSearchInput = true,
  isSearching = false,
  selectedIndex = 0,
  chatMatchCount,
  showNoResults = false,
  resultCount,
}: SessionListSearchPreviewProps) {
  // Filter if there's a search query (simple title match for demo)
  const filteredSessions = React.useMemo(() => {
    if (showNoResults) return []
    if (!searchQuery) return sampleSessions
    return sampleSessions.filter(s => (s.name || '').toLowerCase().includes(searchQuery.toLowerCase()))
  }, [showNoResults, searchQuery])

  const selectedSessionId = filteredSessions[selectedIndex]?.id ?? null

  // Build content search results for match badge
  const contentSearchResults = new Map<string, ContentSearchResult>()
  if (chatMatchCount && selectedSessionId) {
    contentSearchResults.set(selectedSessionId, { matchCount: chatMatchCount, snippet: '' })
  }

  const ctx = createMockContext({
    searchQuery,
    selectedSessionId,
    contentSearchResults,
  })

  const displayCount = resultCount ?? filteredSessions.length

  return (
    <ActionRegistryProvider>
      <SessionListProvider value={ctx}>
        <div className="w-[320px] h-[480px] flex flex-col border border-border rounded-lg overflow-hidden bg-background">
          {/* Search header - uses the SAME component as the real app */}
          {showSearchInput && (
            <SessionSearchHeader
              searchQuery={searchQuery}
              isSearching={isSearching}
              resultCount={displayCount}
              readOnly
            />
          )}

          {/* Session list */}
          <div className="flex-1 overflow-auto">
            {showNoResults ? (
              <div className="flex flex-col items-center justify-center py-12 px-4">
                <p className="text-sm text-muted-foreground">No conversations found</p>
                <p className="text-xs text-muted-foreground/60 mt-0.5">
                  Searched titles and message content
                </p>
                <button className="text-xs text-foreground hover:underline mt-2">
                  Clear search
                </button>
              </div>
            ) : (
              <div className="flex flex-col pb-4">
                {/* Date header */}
                <div className="px-4 py-2">
                  <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                    Today
                  </span>
                </div>

                {filteredSessions.map((session, index) => (
                  <SessionItem
                    key={session.id}
                    item={session}
                    index={index}
                    itemProps={{ tabIndex: 0, onKeyDown: noopKeyDown }}
                    isSelected={session.id === selectedSessionId}
                    isFirstInGroup={index === 0}
                    isInMultiSelect={false}
                    onSelect={() => {}}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </SessionListProvider>
    </ActionRegistryProvider>
  )
}

// ============================================================================
// SessionItemPreview - Single real SessionItem with context providers
// ============================================================================

interface SessionItemPreviewProps {
  item?: SessionMeta
  isSelected?: boolean
  searchQuery?: string
  chatMatchCount?: number
  state?: 'none' | 'loading' | 'plan' | 'new' | 'waiting' | 'waiting-question' | 'waiting-server' | 'failed'
  flagged?: boolean
  /** UB14.3 — two labels on the row (line 2 when nothing else claims it). */
  withLabels?: boolean
  /**
   * P6.504 — the session's own last output, one line, as the row's subtitle.
   * Empty is the ordinary case for a session that has produced nothing yet.
   */
  lastOutputSummary?: string
}

function SessionItemPreview({
  item = sampleSessions[0],
  isSelected = false,
  searchQuery = '',
  chatMatchCount,
  state = 'none',
  flagged = false,
  lastOutputSummary,
  withLabels = false,
}: SessionItemPreviewProps) {
  const resolvedItem = React.useMemo(() => {
    const base: SessionMeta = { ...item, isProcessing: false, hasUnread: false, lastMessageRole: undefined, isFlagged: flagged }
    if (lastOutputSummary) base.lastOutputSummary = lastOutputSummary
    if (withLabels) base.labels = ['bug', 'priority::high']
    switch (state) {
      case 'loading': base.isProcessing = true; break
      case 'plan': base.lastMessageRole = 'plan'; break
      case 'new': base.hasUnread = true; break
      // P6.270 — a session holding a prompt is also mid-turn in real life, which
      // is exactly the case the classifier's precedence decides: it renders as
      // WAITING, because the prompt is the part only the user can clear.
      case 'waiting':
      case 'waiting-question':
        base.isProcessing = true
        break
      // P6.757 / P6.764 — a prompt this window has no card for (raised before it connected): only the
      // server's count and the subject it sends. The row still says "needs you", naming the tool.
      case 'waiting-server':
        base.isProcessing = true
        base.awaitingApprovalCount = 1
        base.awaitingApprovalToolName = 'Bash'
        base.awaitingApprovalType = 'bash'
        break
      case 'failed': base.lastMessageRole = 'error'; break
    }
    return base
  }, [item, state, flagged, lastOutputSummary, withLabels])

  // P6.270 — the waiting marker is driven by the AppShell's pending-permission
  // map rather than by the session record, so the demo has to supply one.
  const isWaiting = state === 'waiting' || state === 'waiting-question'
  const pendingPermissions = React.useMemo(() => {
    const map = new Map<string, PermissionRequest[]>()
    if (isWaiting) {
      map.set(resolvedItem.id, [state === 'waiting-question'
        ? {
            sessionId: resolvedItem.id,
            requestId: 'playground-ask',
            toolName: 'AskUserQuestion',
            description: 'Which branch should I target?',
            type: 'ask_user',
          }
        : {
            sessionId: resolvedItem.id,
            requestId: 'playground-bash',
            toolName: 'Bash',
            command: 'rm -rf ./dist',
            description: 'Remove the build output',
            type: 'bash',
          }])
    }
    return map
  }, [isWaiting, state, resolvedItem.id])

  const contentSearchResults = new Map<string, ContentSearchResult>()
  if (chatMatchCount && resolvedItem) {
    contentSearchResults.set(resolvedItem.id, { matchCount: chatMatchCount, snippet: '' })
  }

  const ctx = createMockContext({
    searchQuery,
    selectedSessionId: isSelected ? resolvedItem.id : null,
    contentSearchResults,
    flatLabels: mockLabels,
    labels: mockLabels,
    // The list derives this from the same pending-permission map (SessionList); without it the "Waiting"
    // states rendered as merely running (UB14.3 found it: the row reads the local half through the context).
    hasPendingPrompt: (sessionId: string) => (pendingPermissions.get(sessionId)?.length ?? 0) > 0,
  })

  return (
    <PlaygroundAppShellProvider pendingPermissions={pendingPermissions}>
      <ActionRegistryProvider>
        <SessionListProvider value={ctx}>
          <SessionItem
            item={resolvedItem}
            index={0}
            itemProps={{ tabIndex: 0, onKeyDown: noopKeyDown }}
            isSelected={isSelected}
            isFirstInGroup
            isInMultiSelect={false}
            onSelect={() => {}}
          />
        </SessionListProvider>
      </ActionRegistryProvider>
    </PlaygroundAppShellProvider>
  )
}

// ============================================================================
// UB14.3 — SessionBadges ("+N" expands in place) and SessionInfoPopover
// ============================================================================

/**
 * The row's label line on its own. The browser measures the fit; `initialFit` seeds the static render
 * (and the registry sweep) so the collapsed and expanded "+N" states are each one click away.
 */
function SessionBadgesPreview({
  labelCount = 6,
  initialFit,
  defaultExpanded = false,
}: {
  labelCount?: number
  initialFit?: number
  defaultExpanded?: boolean
}) {
  const item: SessionMeta = { ...sampleSessions[0], labels: sixLabelEntries.slice(0, labelCount) }
  const ctx = createMockContext({ flatLabels: mockLabels, labels: mockLabels })
  return (
    <SessionListProvider value={ctx}>
      <div className="w-[260px] p-3">
        <SessionBadges item={item} initialFit={initialFit} defaultExpanded={defaultExpanded} />
      </div>
    </SessionListProvider>
  )
}

/** v0.15.1's controlled `open` and optional trigger (the compact chat header opens it from its drawer). */
function SessionInfoPopoverPreview({ controlledOpen = true }: { controlledOpen?: boolean }) {
  const session = { sessionId: 'session-1', workspaceId: 'workspace-1' }
  return (
    <div className="p-3">
      {controlledOpen ? (
        <SessionInfoPopover session={session} open onOpenChange={() => {}} />
      ) : (
        <SessionInfoPopover
          session={session}
          trigger={<button type="button" className="h-7 px-2 rounded-md text-label-sm bg-fill-hover">Session info</button>}
        />
      )}
    </div>
  )
}

// ============================================================================
// UB14.5 — SessionFilterMenu (v0.15.1) over our filter set
// ============================================================================

/** The playground's statuses, exported for the UB14.5 probe so the drives read the entry's own data. */
export const filterMenuStatuses = mockSessionStatuses

/** Labels for the filter menu: two leaves, a group with two children (the nested submenu), a valued label. */
export const filterMenuLabels: LabelConfig[] = [
  { id: 'bug', name: 'Bug', color: 'destructive' },
  { id: 'feature', name: 'Feature', color: 'accent' },
  {
    id: 'area',
    name: 'Area',
    children: [
      { id: 'frontend', name: 'Frontend', color: 'info' },
      { id: 'backend', name: 'Backend', color: 'success' },
    ],
  },
  { id: 'priority', name: 'Priority', color: 'foreground/50', valueType: 'string' },
]

export const filterMenuProjects = [
  { id: 'p-gateway', slug: 'gateway', name: 'Gateway', color: 'info' },
  { id: 'p-desktop', slug: 'desktop', name: 'Desktop' },
]

export type FilterMenuScenario = 'none' | 'every-kind' | 'dead-label-only' | 'pinned-status' | 'stale-ids'

export interface FilterMenuSeed {
  listFilter: Map<string, FilterMode>
  labelFilter: Map<string, FilterMode>
  projectFilter: Map<string, FilterMode>
  pinnedFilters: { pinnedStatusId: string | null; pinnedLabelId: string | null; pinnedFlagged: boolean }
  isStateSubView: boolean
}

/** The persisted per-view filter each scenario starts from (AppShell's `viewFiltersMap` entry, as Maps). */
export function filterMenuSeed(scenario: FilterMenuScenario): FilterMenuSeed {
  const none = { pinnedStatusId: null, pinnedLabelId: null, pinnedFlagged: false }
  switch (scenario) {
    case 'every-kind':
      return {
        listFilter: new Map([['done', 'include']]),
        labelFilter: new Map([['bug', 'exclude'], ['frontend', 'include']]),
        projectFilter: new Map([['p-gateway', 'include']]),
        pinnedFilters: none,
        isStateSubView: false,
      }
    case 'dead-label-only':
      // UA12.162 / UA12.154: a filter whose only label was deleted filters like no filter, so it shows no tint and no Clear.
      return { listFilter: new Map(), labelFilter: new Map([['task-gone-1', 'include']]), projectFilter: new Map(), pinnedFilters: none, isStateSubView: false }
    case 'pinned-status':
      // A status view pins its status (checked, not removable) and hides the Group submenu.
      return {
        listFilter: new Map(),
        labelFilter: new Map([['feature', 'include']]),
        projectFilter: new Map(),
        pinnedFilters: { pinnedStatusId: 'in-progress', pinnedLabelId: null, pinnedFlagged: false },
        isStateSubView: true,
      }
    case 'stale-ids':
      // A deleted status, label and project left in the stored filter: no row is drawn for them, nothing throws.
      return {
        listFilter: new Map([['archived-gone', 'include']]),
        labelFilter: new Map([['gone', 'include']]),
        projectFilter: new Map([['p-gone', 'exclude']]),
        pinnedFilters: none,
        isStateSubView: false,
      }
    default:
      return { listFilter: new Map(), labelFilter: new Map(), projectFilter: new Map(), pinnedFilters: none, isStateSubView: false }
  }
}

type FilterMapSetter = (updater: Map<string, FilterMode> | ((prev: Map<string, FilterMode>) => Map<string, FilterMode>)) => void

/** AppShell's setter contract: a Map or an updater over the previous Map. */
function useFilterMap(initial: Map<string, FilterMode>): [Map<string, FilterMode>, FilterMapSetter] {
  const [value, setValue] = React.useState(initial)
  const set = React.useCallback<FilterMapSetter>(
    updater => setValue(prev => (typeof updater === 'function' ? updater(prev) : updater)),
    [],
  )
  return [value, set]
}

function SessionFilterMenuHarness({ scenario, open, query, labelsConfigured }: { scenario: FilterMenuScenario; open: boolean; query: string; labelsConfigured: boolean }) {
  const seed = filterMenuSeed(scenario)
  const [listFilter, setListFilter] = useFilterMap(seed.listFilter)
  const [labelFilter, setLabelFilter] = useFilterMap(seed.labelFilter)
  const [projectFilter, setProjectFilter] = useFilterMap(seed.projectFilter)
  const [grouping, setGrouping] = React.useState<ChatGroupingMode>('date')
  const labels = labelsConfigured ? filterMenuLabels : []
  return (
    <SessionFilterMenu
      listFilter={listFilter}
      setListFilter={setListFilter}
      labelFilter={labelFilter}
      setLabelFilter={setLabelFilter}
      projectFilter={projectFilter}
      setProjectFilter={setProjectFilter}
      pinnedFilters={seed.pinnedFilters}
      effectiveSessionStatuses={mockSessionStatuses}
      labelConfigs={labels}
      displayLabelConfigs={labels}
      projectMenuOptions={filterMenuProjects}
      isStateSubView={seed.isStateSubView}
      chatGroupingMode={grouping}
      setChatGroupingMode={setGrouping}
      onOpenSearch={() => console.info('[Playground] Open search')}
      defaultOpen={open}
      defaultQuery={query}
    />
  )
}

/** The navigator header's corner, where AppShell mounts the menu; a new scenario remounts it, as a workspace switch does. */
function SessionFilterMenuPreview({
  scenario = 'every-kind',
  open = true,
  query = '',
  labelsConfigured = true,
}: {
  scenario?: FilterMenuScenario
  open?: boolean
  query?: string
  labelsConfigured?: boolean
}) {
  return (
    <div className="flex h-[480px] w-[440px] items-start justify-end p-3">
      <SessionFilterMenuHarness
        key={`${scenario}:${open}:${query}:${labelsConfigured}`}
        scenario={scenario}
        open={open}
        query={query}
        labelsConfigured={labelsConfigured}
      />
    </div>
  )
}

// ============================================================================
// UB12.41 — CompactSessionListFilter (the compact navigator's bottom sheet) on v0.15.1's classes
// ============================================================================

/**
 * The sheet opens on the first render only where there is a DOM: vaul (1.1.2, `useScaleBackground`) reads
 * `document.body` while rendering an OPEN drawer, so the static sweep (`render-every-entry.ts`, no DOM — UB14.30
 * measured `document is not defined`) reads the trigger alone, and the page opens the sheet itself.
 */
function CompactSessionListFilterHarness({
  scenario,
  open,
  query,
  labelsConfigured,
  projectsAvailable,
  grouping,
}: {
  scenario: FilterMenuScenario
  open: boolean
  query: string
  labelsConfigured: boolean
  projectsAvailable: boolean
  grouping: ChatGroupingMode
}) {
  const seed = filterMenuSeed(scenario)
  const [listFilter, setListFilter] = useFilterMap(seed.listFilter)
  const [labelFilter, setLabelFilter] = useFilterMap(seed.labelFilter)
  const [chatGroupingMode, setChatGroupingMode] = React.useState<ChatGroupingMode>(grouping)
  const labels = labelsConfigured ? filterMenuLabels : []
  return (
    <CompactSessionListFilter
      listFilter={listFilter}
      setListFilter={setListFilter}
      labelFilter={labelFilter}
      setLabelFilter={setLabelFilter}
      pinnedFilters={seed.pinnedFilters}
      effectiveSessionStatuses={mockSessionStatuses}
      displayLabelConfigs={labels}
      labelConfigs={labels}
      chatGroupingMode={chatGroupingMode}
      setChatGroupingMode={setChatGroupingMode}
      isStateSubView={seed.isStateSubView}
      projectsAvailable={projectsAvailable}
      onOpenSearch={() => console.info('[Playground] Open search')}
      defaultOpen={open && typeof document !== 'undefined'}
      defaultQuery={query}
    />
  )
}

/** The compact navigator's header, where AppShell mounts the trigger; a knob change remounts it with a fresh sheet. */
function CompactSessionListFilterPreview({
  scenario = 'every-kind',
  open = true,
  query = '',
  labelsConfigured = true,
  projectsAvailable = false,
  grouping = 'date',
}: {
  scenario?: FilterMenuScenario
  open?: boolean
  query?: string
  labelsConfigured?: boolean
  projectsAvailable?: boolean
  grouping?: ChatGroupingMode
}) {
  return (
    <div className="flex h-[480px] w-[375px] items-start justify-end p-3">
      <CompactSessionListFilterHarness
        key={`${scenario}:${open}:${query}:${labelsConfigured}:${projectsAvailable}:${grouping}`}
        scenario={scenario}
        open={open}
        query={query}
        labelsConfigured={labelsConfigured}
        projectsAvailable={projectsAvailable}
        grouping={grouping}
      />
    </div>
  )
}

// ============================================================================
// Registry Entries
// ============================================================================

/** P6.589 · the affordance alone, so its four states are each one click away. */
function SessionRowPermissionAnswerPreview({
  type = 'bash',
  toolName = 'Bash',
  withHandler = true,
}: {
  type?: string
  toolName?: string
  withHandler?: boolean
}) {
  const [answered, setAnswered] = React.useState<string | null>(null)
  const request: PermissionRequest | undefined = type === 'none'
    ? undefined
    : {
        sessionId: 'playground-session',
        requestId: 'playground-request',
        toolName,
        description: `Run ${toolName}`,
        type: type as PermissionRequest['type'],
      }

  return (
    <div className="flex flex-col gap-2 p-3">
      <SessionRowPermissionAnswer
        sessionId="playground-session"
        request={request}
        onRespond={withHandler
          ? (_sessionId, _requestId, allowed, alwaysAllow) => {
              // The playground shows the fourth argument on purpose: `alwaysAllow`
              // is the decision this row is about, and it must read `false` here
              // whichever button was pressed.
              setAnswered(`allowed=${allowed} alwaysAllow=${alwaysAllow}`)
            }
          : undefined}
      />
      <div className="text-[11px] text-muted-foreground">
        {answered ?? 'No answer sent yet.'}
      </div>
    </div>
  )
}

export const sessionListComponents: ComponentEntry[] = [
  {
    id: 'session-list-search',
    name: 'SessionList Search States',
    category: 'Session List',
    description: 'Session list using real SessionItem components with search and badges',
    component: SessionListSearchPreview,
    props: [
      {
        name: 'searchQuery',
        description: 'Current search query text',
        control: { type: 'string', placeholder: 'Search...' },
        defaultValue: '',
      },
      {
        name: 'showSearchInput',
        description: 'Show the search input bar',
        control: { type: 'boolean' },
        defaultValue: true,
      },
      {
        name: 'isSearching',
        description: 'Show loading spinner while searching',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'selectedIndex',
        description: 'Index of selected session (0-based)',
        control: { type: 'number', min: 0, max: 3, step: 1 },
        defaultValue: 0,
      },
      {
        name: 'chatMatchCount',
        description: 'Number of matches in chat (shows yellow badge)',
        control: { type: 'number', min: 0, max: 50, step: 1 },
        defaultValue: 0,
      },
      {
        name: 'showNoResults',
        description: 'Show empty/no results state',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'resultCount',
        description: 'Explicit result count to display',
        control: { type: 'number', min: 0, max: 999, step: 1 },
        defaultValue: undefined,
      },
    ],
    variants: [
      {
        name: 'Default (No Search)',
        description: 'Normal session list without search active',
        props: {
          searchQuery: '',
          showSearchInput: false,
        },
      },
      {
        name: 'Search Active',
        description: 'Search input visible, no query yet',
        props: {
          searchQuery: '',
          showSearchInput: true,
        },
      },
      {
        name: 'Title Match Highlight',
        description: 'Search query matching session titles',
        props: {
          searchQuery: 'auth',
          showSearchInput: true,
          selectedIndex: 0,
          resultCount: 2,
        },
      },
      {
        name: 'With Match Badge',
        description: 'Selected session with yellow match count badge',
        props: {
          searchQuery: 'auth',
          showSearchInput: true,
          selectedIndex: 0,
          chatMatchCount: 5,
          resultCount: 47,
        },
      },
      {
        name: 'Searching (Loading)',
        description: 'Content search in progress',
        props: {
          searchQuery: 'complex query',
          showSearchInput: true,
          isSearching: true,
        },
      },
      {
        name: 'No Results',
        description: 'Search returned no matches',
        props: {
          searchQuery: 'xyznonexistent',
          showSearchInput: true,
          showNoResults: true,
          resultCount: 0,
        },
      },
    ],
    mockData: () => ({}),
  },
  {
    id: 'session-item-search',
    name: 'SessionItem States',
    category: 'Session List',
    description: 'Individual real SessionItem showing visual states with search and badges',
    component: SessionItemPreview,
    props: [
      {
        name: 'state',
        description: 'Indicator state shown next to status icon',
        control: {
          type: 'select',
          options: [
            { label: 'None', value: 'none' },
            { label: 'Loading', value: 'loading' },
            { label: 'Plan', value: 'plan' },
            { label: 'New', value: 'new' },
            { label: 'Waiting (tool)', value: 'waiting' },
            { label: 'Waiting (question)', value: 'waiting-question' },
            { label: 'Waiting (server count only)', value: 'waiting-server' },
            { label: 'Failed', value: 'failed' },
          ],
        },
        defaultValue: 'none',
      },
      {
        name: 'withLabels',
        description: 'Two labels on the row (line 2 unless a run state claims it)',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'searchQuery',
        description: 'Search query for highlighting',
        control: { type: 'string', placeholder: 'Search...' },
        defaultValue: '',
      },
      {
        name: 'isSelected',
        description: 'Whether this session is selected',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'chatMatchCount',
        description: 'Number of matches (shows yellow badge)',
        control: { type: 'number', min: 0, max: 50, step: 1 },
        defaultValue: 0,
      },
      {
        name: 'flagged',
        description: 'Whether the session is flagged',
        control: { type: 'boolean' },
        defaultValue: false,
      },
    ],
    variants: [
      {
        name: 'Default',
        description: 'Normal state without indicators',
        props: {
          item: sampleSessions[0],
          state: 'none',
        },
      },
      {
        name: 'Loading',
        description: 'Session is processing (shows spinner)',
        props: {
          item: sampleSessions[0],
          state: 'loading',
        },
      },
      {
        name: 'Activity line — the session\'s own last words',
        description: 'P6.504 · one line saying what the session is doing, extracted from its own last output at save time. No model turn is spent per row (Q-den 22 = A refused that: it is a recurring charge the user cannot see, and on our default gateway it lands on the MAIN model). The tooltip says whose words these are, because a long or tool-heavy turn reads worse and that limit must be legible rather than discovered.',
        props: {
          item: sampleSessions[0],
          state: 'none',
          lastOutputSummary: 'The build is green again after removing the duplicate import.',
        },
      },
      {
        name: 'Activity line — nothing to say yet',
        description: 'Boundary: a session whose last turn produced no readable output draws NO line. Nothing is invented, because a confident-looking fragment of a diff would be worse than silence.',
        props: {
          item: sampleSessions[0],
          state: 'loading',
        },
      },
      {
        name: 'Plan Pending',
        description: 'Session has a pending plan (shows compass icon)',
        props: {
          item: sampleSessions[0],
          state: 'plan',
        },
      },
      {
        name: 'New / Unread',
        description: 'Session has unread messages (shows accent dot)',
        props: {
          item: sampleSessions[0],
          state: 'new',
        },
      },
      {
        name: 'Flagged',
        description: 'Session is flagged',
        props: {
          item: sampleSessions[0],
          flagged: true,
        },
      },
      {
        name: 'Needs you — server count only',
        description: 'UB14.3 · P6.757/P6.764 — a prompt raised before this window connected: no local card, only the server\'s awaitingApprovalCount and the subject it sends. The run-state line says "Waiting for you"; its tooltip and accessible name name the tool. No Allow/Deny: there is no local card to answer.',
        props: {
          item: sampleSessions[0],
          state: 'waiting-server',
        },
      },
      {
        name: 'Needs you — labels give way',
        description: 'UB14.3 (v0.15.1) — while the row needs attention its labels are hidden. In the app the one-shot answer (P6.589) takes the line\'s trailing slot; this host supplies no onRespondToPermission, so it draws nothing here (see the SessionRowPermissionAnswer entry).',
        props: {
          item: sampleSessions[0],
          state: 'waiting',
          withLabels: true,
        },
      },
      {
        name: 'Failed',
        description: 'UB14.3 (v0.15.1) — the last turn ended in an error: "Stopped with an error" in the destructive tone.',
        props: {
          item: sampleSessions[0],
          state: 'failed',
        },
      },
      {
        name: 'Labels on line 2',
        description: 'UB14.3 (v0.15.1) — with no run state the labels own the second line, full width.',
        props: {
          item: sampleSessions[0],
          state: 'none',
          withLabels: true,
        },
      },
      {
        name: 'Title Highlighted',
        description: 'Search query highlights in title',
        props: {
          item: sampleSessions[0],
          searchQuery: 'auth',
        },
      },
      {
        name: 'Selected with Match Badge',
        description: 'Selected session with yellow match count badge',
        props: {
          item: sampleSessions[0],
          searchQuery: 'auth',
          isSelected: true,
          chatMatchCount: 5,
        },
      },
    ],
    mockData: () => ({
      item: sampleSessions[0],
    }),
  },
  {
    id: 'session-row-permission-answer',
    name: 'SessionRowPermissionAnswer',
    category: 'Session List',
    description: 'P6.589 · the one-shot approve/deny on a blocked session row. There is NO always-allow choice and there never will be: a permission answered without seeing the conversation must never widen the session, so the row offers the narrow answer and the tooltip states the narrowness — a missing button on its own is indistinguishable from an oversight.',
    component: SessionRowPermissionAnswerPreview,
    props: [
      {
        name: 'type',
        description: 'The pending prompt kind. `ask_user` deliberately renders nothing.',
        control: {
          type: 'select',
          options: [
            { label: 'bash', value: 'bash' },
            { label: 'file_write', value: 'file_write' },
            { label: 'mcp_mutation', value: 'mcp_mutation' },
            { label: 'ask_user', value: 'ask_user' },
            { label: 'none (no pending request)', value: 'none' },
          ],
        },
        defaultValue: 'bash',
      },
      {
        name: 'toolName',
        description: 'The tool the session is blocked on',
        control: { type: 'string' },
        defaultValue: 'Bash',
      },
      {
        name: 'withHandler',
        description: 'Whether the host supplied onRespondToPermission',
        control: { type: 'boolean' },
        defaultValue: true,
      },
    ],
    variants: [
      {
        name: 'Blocked on a command',
        description: 'The normal case: allow once, or deny. Two buttons, no third.',
        props: { type: 'bash', toolName: 'Bash', withHandler: true },
      },
      {
        name: 'A question — renders nothing',
        description: 'Boundary. `ask_user` carries an answer the user TYPES, so approve/deny would answer a question that was never yes-or-no. The row keeps its "Waiting for you: a question" label and the session is one click away.',
        props: { type: 'ask_user', toolName: 'ask_user', withHandler: true },
      },
      {
        name: 'No pending request — renders nothing',
        description: 'Every non-waiting row in the list, which is nearly all of them.',
        props: { type: 'none', toolName: 'Bash', withHandler: true },
      },
      {
        name: 'No handler — renders nothing',
        description: 'Boundary. `onRespondToPermission` is optional on the AppShell context, and a button that silently does nothing is worse than no button.',
        props: { type: 'bash', toolName: 'Bash', withHandler: false },
      },
    ],
    mockData: () => ({}),
  },
  {
    id: 'session-badges',
    name: 'SessionBadges (+N labels)',
    category: 'Session List',
    description: 'UB14.3 (v0.15.1) — the session row\'s label line: whole chips that fit, then "+N"; clicking "+N" reveals the rest in place (they wrap), and a chevron shows fewer.',
    component: SessionBadgesPreview,
    props: [
      {
        name: 'labelCount',
        description: 'How many labels the session carries',
        control: { type: 'number', min: 0, max: 6, step: 1 },
        defaultValue: 6,
      },
      {
        name: 'initialFit',
        description: 'First render\'s fit (the browser re-measures)',
        control: { type: 'number', min: 1, max: 6, step: 1 },
        defaultValue: undefined,
      },
      {
        name: 'defaultExpanded',
        description: 'Start with the hidden chips revealed',
        control: { type: 'boolean' },
        defaultValue: false,
      },
    ],
    variants: [
      {
        name: 'All fit',
        description: 'Two labels: no counter.',
        props: { labelCount: 2 },
      },
      {
        name: '+N collapsed',
        description: 'Six labels, two whole: "+4" names the rest in its tooltip.',
        props: { labelCount: 6, initialFit: 2 },
      },
      {
        name: '+N expanded',
        description: 'The same row after "+4": every chip in place, then the "show fewer" chevron.',
        props: { labelCount: 6, initialFit: 2, defaultExpanded: true },
      },
    ],
    mockData: () => ({}),
  },
  {
    id: 'session-info-popover',
    name: 'SessionInfoPopover',
    category: 'Session List',
    description: 'UB14.3 (v0.15.1) — the session info card hugs its content up to 460px; it opens from its own trigger or, with no trigger, from a controlled `open`.',
    component: SessionInfoPopoverPreview,
    props: [
      {
        name: 'controlledOpen',
        description: 'Controlled and open with no trigger (on) vs its own trigger, closed (off)',
        control: { type: 'boolean' },
        defaultValue: true,
      },
    ],
    variants: [
      {
        name: 'Open, no trigger (controlled)',
        description: 'The compact chat header\'s path: the drawer row opens it.',
        props: { controlledOpen: true },
      },
      {
        name: 'Trigger, closed (uncontrolled)',
        description: 'Boundary: the component owns its state; only the trigger renders until it is pressed.',
        props: { controlledOpen: false },
      },
    ],
    mockData: () => ({}),
  },
  {
    id: 'session-filter-menu',
    name: 'SessionFilterMenu',
    category: 'Session List',
    description: 'UB14.5 (v0.15.1) — the session list\'s filter dropdown over our filter set: statuses, labels (groups nest), projects (UA5.9), Group by and Search; active filters tint the trigger and show Clear on LIVE label ids only (UA12.162); typing switches to a flat list. ⌥-click excludes.',
    component: SessionFilterMenuPreview,
    layout: 'top',
    previewOverflow: 'visible',
    props: [
      {
        name: 'scenario',
        description: 'The stored filter the menu opens over',
        control: {
          type: 'select',
          options: [
            { label: 'No filter', value: 'none' },
            { label: 'Every kind (status, labels, project)', value: 'every-kind' },
            { label: 'Deleted label only (UA12.162)', value: 'dead-label-only' },
            { label: 'Pinned status view', value: 'pinned-status' },
            { label: 'Stale ids (deleted status, label, project)', value: 'stale-ids' },
          ],
        },
        defaultValue: 'every-kind',
      },
      {
        name: 'open',
        description: 'Menu open on the first render',
        control: { type: 'boolean' },
        defaultValue: true,
      },
      {
        name: 'query',
        description: 'Inline search query (non-empty shows the flat list)',
        control: { type: 'string', placeholder: 'Search statuses & labels...' },
        defaultValue: '',
      },
      {
        name: 'labelsConfigured',
        description: 'The workspace has labels',
        control: { type: 'boolean' },
        defaultValue: true,
      },
    ],
    variants: [
      { name: 'Closed, no filter', description: 'The quiet trigger.', props: { scenario: 'none', open: false } },
      { name: 'Closed, active filter', description: 'The accent-tinted trigger.', props: { scenario: 'every-kind', open: false } },
      { name: 'Open, no filter', description: 'Statuses, Labels, Projects, Group, Search; no chips and no Clear.', props: { scenario: 'none' } },
      { name: 'Open, every kind', description: 'Chips for a status, two labels and a project with their mode badges, then Clear.', props: { scenario: 'every-kind' } },
      { name: 'Open, deleted label only', description: 'UA12.162: the only stored label is gone, so no tint, no chip and no Clear.', props: { scenario: 'dead-label-only' } },
      { name: 'Open, pinned status view', description: 'The pinned status is checked and fixed; a status view has no Group submenu.', props: { scenario: 'pinned-status' } },
      { name: 'Open, stale ids', description: 'Deleted ids draw no rows and break nothing; Clear still empties them.', props: { scenario: 'stale-ids' } },
      { name: 'Open, no labels configured', description: 'The Labels submenu says so.', props: { scenario: 'none', labelsConfigured: false } },
      { name: 'Search: matches', description: 'Typing switches to the flat list: matching statuses, then labels with their parent path.', props: { scenario: 'every-kind', query: 'e' } },
      { name: 'Search: no matches', description: 'The empty result line.', props: { scenario: 'none', query: 'zzz' } },
    ],
    mockData: () => ({}),
  },
  {
    id: 'compact-session-list-filter',
    name: 'CompactSessionListFilter',
    category: 'Session List',
    description: 'UB12.41 (v0.15.1) — the compact navigator\'s filter sheet: the field-surface search, Statuses / Labels / Group sections, 44px rows with the accent radio check, the raised include and destructive-tint exclude pills, and the pinned chips. The trigger tint and Clear key on LIVE label ids (UA12.162); Group by Project shows when the workspace has projects (UA5.9).',
    component: CompactSessionListFilterPreview,
    layout: 'top',
    previewOverflow: 'visible',
    props: [
      {
        name: 'scenario',
        description: 'The stored filter the sheet opens over',
        control: {
          type: 'select',
          options: [
            { label: 'No filter', value: 'none' },
            { label: 'Every kind (status, labels)', value: 'every-kind' },
            { label: 'Deleted label only (UA12.162)', value: 'dead-label-only' },
            { label: 'Pinned status view', value: 'pinned-status' },
            { label: 'Stale ids (deleted status, label)', value: 'stale-ids' },
          ],
        },
        defaultValue: 'every-kind',
      },
      {
        name: 'open',
        description: 'Sheet open on the first render',
        control: { type: 'boolean' },
        defaultValue: true,
      },
      {
        name: 'query',
        description: 'Search query (non-empty shows the combined result)',
        control: { type: 'string', placeholder: 'Search statuses & labels...' },
        defaultValue: '',
      },
      {
        name: 'labelsConfigured',
        description: 'The workspace has labels',
        control: { type: 'boolean' },
        defaultValue: true,
      },
      {
        name: 'projectsAvailable',
        description: 'The workspace has projects (offers Group by Project)',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'grouping',
        description: 'The selected Group by mode (the accent check)',
        control: {
          type: 'select',
          options: [
            { label: 'Date', value: 'date' },
            { label: 'Status', value: 'status' },
            { label: 'Unread', value: 'unread' },
            { label: 'Project', value: 'project' },
          ],
        },
        defaultValue: 'date',
      },
    ],
    variants: [
      { name: 'Closed, no filter', description: 'The quiet trigger.', props: { scenario: 'none', open: false } },
      { name: 'Closed, active filter', description: 'The accent-tinted trigger.', props: { scenario: 'every-kind', open: false } },
      { name: 'Open, no filter', description: 'Statuses, Labels, Group and Search; no chips and no Clear.', props: { scenario: 'none' } },
      { name: 'Open, every kind', description: 'A status and a label included (raised pills), a label excluded (destructive tint), then Clear.', props: { scenario: 'every-kind' } },
      { name: 'Open, deleted label only', description: 'UA12.162: the only stored label is gone, so no tint and no Clear.', props: { scenario: 'dead-label-only' } },
      { name: 'Open, pinned status view', description: 'The pinned chip and the fixed, checked status row; a status view has no Group section.', props: { scenario: 'pinned-status' } },
      { name: 'Open, stale ids', description: 'Deleted ids draw no rows; a stale status still counts, so Clear is there to remove it.', props: { scenario: 'stale-ids' } },
      { name: 'Open, grouped by project', description: 'UA5.9: the workspace has projects, and Project is the checked grouping.', props: { scenario: 'none', projectsAvailable: true, grouping: 'project' } },
      { name: 'Open, no labels configured', description: 'No Labels section.', props: { scenario: 'none', labelsConfigured: false } },
      { name: 'Search: matches', description: 'Matching statuses, then labels with their parent path.', props: { scenario: 'every-kind', query: 'end' } },
      { name: 'Search: no matches', description: 'The empty result line.', props: { scenario: 'none', query: 'zzz' } },
    ],
    mockData: () => ({}),
  },
]
