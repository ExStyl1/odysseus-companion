import { useState, useCallback, useEffect, useRef, useMemo } from "react"
import { isToday, isYesterday, format, startOfDay } from "date-fns"

import { searchLog } from "@/lib/logger"
import { findLabelById, matchesLabelFilter, type LabelConfig } from "@nessy-agent/shared/labels"
import { fuzzyScore } from "@nessy-agent/shared/search"
import { getSessionTitle, getSessionStatus } from "@/utils/session"
import type { SessionMeta } from "@/atoms/sessions"
import type { ViewConfig } from "@nessy-agent/shared/views"
import type { SessionFilter } from "@/contexts/NavigationContext"; import { projectGroupKeyOf } from "@/components/app-shell/session-list-project-groups" // UA12.121 — two statements on one line: this file is docs-cited at L18/L352, and nothing above them may add a line

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INITIAL_DISPLAY_LIMIT = 50
const BATCH_SIZE = 50
const MAX_SEARCH_RESULTS = 100

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Filter mode for tri-state filtering: include shows only matching, exclude hides matching */
export type FilterMode = 'include' | 'exclude'

export interface DateGroup {
  date: Date
  label: string
  sessions: SessionMeta[]
}

export interface ContentSearchResult {
  matchCount: number
  snippet: string
}

/** Metadata for a collapsed group — emitted by the data pipeline so the renderer can show header-only groups */
export interface CollapsedGroupMeta {
  key: string
  count: number
}

export interface UseSessionSearchOptions {
  items: SessionMeta[]
  searchActive: boolean
  searchQuery: string
  workspaceId?: string
  currentFilter?: SessionFilter
  evaluateViews?: (meta: SessionMeta) => ViewConfig[]
  statusFilter?: Map<string, FilterMode>
  labelFilterMap?: Map<string, FilterMode>
  labelConfigs?: LabelConfig[] // F1.353 — the workspace label tree; label filters match a label's descendants through it
  /** Collapsed group keys — collapsed items are excluded from pagination and flatItems */
  collapsedGroups?: Set<string>
  groupingMode?: 'date' | 'status' | 'unread' | 'project'; knownProjects?: ReadonlyArray<{ id: string }> // grouping mode — the group keys of collapse-aware pagination ('project': v0.13.4, UA1.6); UA12.121 — the workspace's projects, so a session bound to a deleted one collapses with "No project" (the grouping's own resolution)
  /** Ref to the ScrollArea viewport element — used for scroll-based pagination */
  scrollViewportRef?: React.RefObject<HTMLDivElement>
}

export interface UseSessionSearchResult {
  // Search state
  isSearchMode: boolean
  highlightQuery: string | undefined
  isSearchingContent: boolean
  /** Whether the search service is unavailable (e.g. ripgrep not found on remote server) */
  isSearchUnavailable: boolean
  /** Raw content search results — needed by SessionItem for `chatMatchCount` */
  contentSearchResults: Map<string, ContentSearchResult>

  // Filtered + grouped results
  matchingFilterItems: SessionMeta[]
  otherResultItems: SessionMeta[]
  exceededSearchLimit: boolean

  // Render-ready outputs
  flatItems: SessionMeta[]
  dateGroups: DateGroup[]
  sessionIndexMap: Map<string, number>

  // Pagination
  hasMore: boolean
  /** Metadata for collapsed groups (key + item count) — used to build header-only placeholder groups */
  collapsedGroupsMeta: CollapsedGroupMeta[]

  // Refs
  searchInputRef: React.RefObject<HTMLInputElement>
}

// ---------------------------------------------------------------------------
// Pure helpers (moved from SessionList)
// ---------------------------------------------------------------------------

function formatDateHeader(date: Date): string {
  if (isToday(date)) return "Today"
  if (isYesterday(date)) return "Yesterday"
  return format(date, "MMM d")
}

function groupSessionsByDate(sessions: SessionMeta[]): DateGroup[] {
  const groups = new Map<string, { date: Date; sessions: SessionMeta[] }>()

  for (const session of sessions) {
    const timestamp = session.lastMessageAt || 0
    const date = startOfDay(new Date(timestamp))
    const key = date.toISOString()

    if (!groups.has(key)) {
      groups.set(key, { date, sessions: [] })
    }
    groups.get(key)!.sessions.push(session)
  }

  return Array.from(groups.values())
    .sort((a, b) => b.date.getTime() - a.date.getTime())
    .map(group => ({
      ...group,
      label: formatDateHeader(group.date),
    }))
}

function getCollapseGroupKey(item: SessionMeta, groupingMode?: 'date' | 'status' | 'unread' | 'project', knownProjectIds?: Set<string>): string {
  if (groupingMode === 'status') return `status-${getSessionStatus(item)}`
  if (groupingMode === 'unread') return item.hasUnread ? 'unread-yes' : 'unread-no'
  if (groupingMode === 'project') return knownProjectIds ? projectGroupKeyOf(item, knownProjectIds) : `project-${(item as { projectId?: string }).projectId ?? '__none__'}` // UA12.121 — with the ids, the grouping's own resolution (`projectGroupKeyOf`); without them the blind key stands
  return startOfDay(new Date(item.lastMessageAt || 0)).toISOString()
}

export interface CollapsedPaginationResult {
  paginatedItems: SessionMeta[]
  hasMore: boolean
  collapsedGroupsMeta: CollapsedGroupMeta[]
}

export function computeCollapsedPagination(
  items: SessionMeta[],
  displayLimit: number,
  collapsedGroups?: Set<string>,
  groupingMode?: 'date' | 'status' | 'unread' | 'project', knownProjectIds?: Set<string>,
): CollapsedPaginationResult {
  // Fast path: no collapse state → original slice
  if (!collapsedGroups || collapsedGroups.size === 0) {
    return {
      paginatedItems: items.slice(0, displayLimit),
      hasMore: displayLimit < items.length,
      collapsedGroupsMeta: [],
    }
  }

  const groupKeysInView = new Set(items.map(item => getCollapseGroupKey(item, groupingMode, knownProjectIds)))

  // Safety guard: don't allow collapse state to hide the entire list when only one
  // group exists in the current filtered view (there would be no meaningful collapse UX).
  if (groupKeysInView.size <= 1) {
    return {
      paginatedItems: items.slice(0, displayLimit),
      hasMore: displayLimit < items.length,
      collapsedGroupsMeta: [],
    }
  }

  const effectiveCollapsedKeys = new Set(
    Array.from(collapsedGroups).filter(key => groupKeysInView.has(key))
  )

  if (effectiveCollapsedKeys.size === 0) {
    return {
      paginatedItems: items.slice(0, displayLimit),
      hasMore: displayLimit < items.length,
      collapsedGroupsMeta: [],
    }
  }

  const expandedItems: SessionMeta[] = []
  const collapsedCounts = new Map<string, number>()

  for (const item of items) {
    const groupKey = getCollapseGroupKey(item, groupingMode, knownProjectIds)

    if (effectiveCollapsedKeys.has(groupKey)) {
      collapsedCounts.set(groupKey, (collapsedCounts.get(groupKey) || 0) + 1)
    } else {
      expandedItems.push(item)
    }
  }

  const meta: CollapsedGroupMeta[] = Array.from(collapsedCounts.entries()).map(
    ([key, count]) => ({ key, count })
  )

  return {
    paginatedItems: expandedItems.slice(0, displayLimit),
    hasMore: displayLimit < expandedItems.length,
    collapsedGroupsMeta: meta,
  }
}

interface FilterMatchOptions {
  evaluateViews?: (meta: SessionMeta) => ViewConfig[]
  statusFilter?: Map<string, 'include' | 'exclude'>
  labelFilterMap?: Map<string, 'include' | 'exclude'>
  labelConfigs?: LabelConfig[]
}

export function sessionMatchesCurrentFilter(
  session: SessionMeta,
  currentFilter: SessionFilter | undefined,
  options: FilterMatchOptions = {}
): boolean {
  const { evaluateViews, statusFilter, labelFilterMap, labelConfigs } = options

  const passesStatusFilter = (): boolean => {
    if (!statusFilter || statusFilter.size === 0) return true
    const sessionState = (session.sessionStatus || 'todo') as string

    let hasIncludes = false
    let matchesInclude = false
    for (const [stateId, mode] of statusFilter) {
      if (mode === 'exclude' && sessionState === stateId) return false
      if (mode === 'include') {
        hasIncludes = true
        if (sessionState === stateId) matchesInclude = true
      }
    }
    return !hasIncludes || matchesInclude
  }

  const passesLabelFilter = (): boolean => {
    if (!labelFilterMap || labelFilterMap.size === 0) return true
    const matches = (labelId: string) => matchesLabelFilter(session, { labelId }, labelConfigs ?? []) // F1.353 — descendants too, as AppShell
    let hasIncludes = false
    let matchesInclude = false
    for (const [labelId, mode] of labelFilterMap) {
      if (mode === 'exclude' && matches(labelId)) return false // a dead id matches nothing, so its exclude is inert
      if (mode === 'include' && (!labelConfigs || findLabelById(labelConfigs, labelId))) { // UA12.154 — drop ids no config carries (a deleted label's persisted filter must not blank the list)
        hasIncludes = true
        if (matches(labelId)) matchesInclude = true
      }
    }
    return !hasIncludes || matchesInclude
  }

  if (!passesStatusFilter() || !passesLabelFilter()) return false

  if (!currentFilter) return true

  switch (currentFilter.kind) {
    case 'allSessions':
      return session.isArchived !== true

    case 'flagged':
      return session.isFlagged === true && session.isArchived !== true

    case 'archived':
      return session.isArchived === true

    case 'state':
      return (session.sessionStatus || 'todo') === currentFilter.stateId && session.isArchived !== true

    case 'label': {
      if (!session.labels?.length) return false
      if (session.isArchived === true) return false
      // F1.353 — through the label tree, the one predicate AppShell and NavigationContext use too
      return matchesLabelFilter(session, currentFilter, labelConfigs ?? [])
    }

    case 'view':
      if (session.isArchived === true) return false
      if (!evaluateViews) return true
      const matched = evaluateViews(session)
      if (currentFilter.viewId === '__all__') return matched.length > 0
      return matched.some(v => v.id === currentFilter.viewId)

    default:
      const _exhaustive: never = currentFilter
      return true
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useSessionSearch({
  items,
  searchActive,
  searchQuery,
  workspaceId,
  currentFilter,
  evaluateViews,
  statusFilter,
  labelFilterMap, labelConfigs,
  collapsedGroups,
  groupingMode, knownProjects,
  scrollViewportRef,
}: UseSessionSearchOptions): UseSessionSearchResult {

  const [contentSearchResults, setContentSearchResults] = useState<Map<string, ContentSearchResult>>(new Map())
  const [isSearchingContent, setIsSearchingContent] = useState(false)
  const [isSearchUnavailable, setIsSearchUnavailable] = useState(false)
  const [displayLimit, setDisplayLimit] = useState(INITIAL_DISPLAY_LIMIT)
  const searchInputRef = useRef<HTMLInputElement>(null)

  // Search mode is active when search is open AND query has 2+ characters
  const isSearchMode = searchActive && searchQuery.length >= 2
  const highlightQuery = isSearchMode ? searchQuery : undefined

  // --- Content search (ripgrep IPC with debounce + cancellation) ---

  useEffect(() => {
    if (!workspaceId || !isSearchMode) {
      setContentSearchResults(new Map())
      return
    }

    const searchId = Date.now().toString(36)
    searchLog.info('query:change', { searchId, query: searchQuery })

    let cancelled = false
    setIsSearchingContent(true)
    setIsSearchUnavailable(false)

    const timer = setTimeout(async () => {
      try {
        searchLog.info('ipc:call', { searchId })
        const ipcStart = performance.now()

        const results = await window.electronAPI.searchSessionContent(workspaceId, searchQuery, searchId)

        if (cancelled) return

        searchLog.info('ipc:received', {
          searchId,
          durationMs: Math.round(performance.now() - ipcStart),
          resultCount: results.length,
        })

        const resultMap = new Map<string, ContentSearchResult>()
        for (const result of results) {
          resultMap.set(result.sessionId, {
            matchCount: result.matchCount,
            snippet: result.matches[0]?.snippet || '',
          })
        }
        setContentSearchResults(resultMap)

        requestAnimationFrame(() => {
          searchLog.info('render:complete', { searchId, sessionsDisplayed: resultMap.size })
        })
      } catch (error) {
        if (cancelled) return
        // Detect search unavailable (ripgrep not found) vs transient errors
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes('SearchUnavailableError') || message.includes('ripgrep')) {
          console.warn('[useSessionSearch] Search unavailable:', message)
          setIsSearchUnavailable(true)
        } else {
          console.error('[useSessionSearch] Content search error:', error)
        }
        setContentSearchResults(new Map())
      } finally {
        if (!cancelled) {
          setIsSearchingContent(false)
        }
      }
    }, 100)

    return () => {
      cancelled = true
      clearTimeout(timer)
      setIsSearchingContent(false)
    }
  }, [workspaceId, isSearchMode, searchQuery])

  // --- Focus search input when search activates ---

  useEffect(() => {
    if (searchActive) {
      searchInputRef.current?.focus()
    }
  }, [searchActive])

  // --- Data pipeline ---

  // Filter out hidden sessions before any processing
  const visibleItems = useMemo(() => items.filter(item => !item.hidden), [items])

  // Sort by most recent activity first
  const sortedItems = useMemo(() =>
    [...visibleItems].sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0)),
    [visibleItems]
  )

  // Filter items by search query or current filter
  const searchFilteredItems = useMemo(() => {
    if (!isSearchMode) {
      return sortedItems.filter(item =>
        sessionMatchesCurrentFilter(item, currentFilter, { evaluateViews, statusFilter, labelFilterMap, labelConfigs })
      )
    }

    return sortedItems
      .filter(item => contentSearchResults.has(item.id))
      .sort((a, b) => {
        const aScore = fuzzyScore(getSessionTitle(a), searchQuery)
        const bScore = fuzzyScore(getSessionTitle(b), searchQuery)

        if (aScore > 0 && bScore === 0) return -1
        if (aScore === 0 && bScore > 0) return 1
        if (aScore !== bScore) return bScore - aScore

        const countA = contentSearchResults.get(a.id)?.matchCount || 0
        const countB = contentSearchResults.get(b.id)?.matchCount || 0
        return countB - countA
      })
  }, [sortedItems, isSearchMode, searchQuery, contentSearchResults, currentFilter, evaluateViews, statusFilter, labelFilterMap, labelConfigs])

  // Split search results: matching current filter vs others
  const { matchingFilterItems, otherResultItems, exceededSearchLimit } = useMemo(() => {
    const hasActiveFilters =
      (currentFilter && currentFilter.kind !== 'allSessions') ||
      (statusFilter && statusFilter.size > 0) ||
      (labelFilterMap && labelFilterMap.size > 0)

    if (searchQuery.trim() && searchFilteredItems.length > 0) {
      searchLog.info('search:grouping', {
        searchQuery,
        currentFilterKind: currentFilter?.kind,
        currentFilterStateId: currentFilter?.kind === 'state' ? currentFilter.stateId : undefined,
        hasActiveFilters,
        statusFilterSize: statusFilter?.size ?? 0,
        labelFilterSize: labelFilterMap?.size ?? 0,
        itemCount: searchFilteredItems.length,
      })
    }

    const totalCount = searchFilteredItems.length
    const exceeded = totalCount > MAX_SEARCH_RESULTS

    if (!isSearchMode || !hasActiveFilters) {
      const limitedItems = searchFilteredItems.slice(0, MAX_SEARCH_RESULTS)
      return { matchingFilterItems: limitedItems, otherResultItems: [] as SessionMeta[], exceededSearchLimit: exceeded }
    }

    const matching: SessionMeta[] = []
    const others: SessionMeta[] = []

    for (const item of searchFilteredItems) {
      if (matching.length + others.length >= MAX_SEARCH_RESULTS) break

      const matches = sessionMatchesCurrentFilter(item, currentFilter, { evaluateViews, statusFilter, labelFilterMap, labelConfigs })
      if (matches) {
        matching.push(item)
      } else {
        others.push(item)
      }
    }

    if (searchFilteredItems.length > 0) {
      searchLog.info('search:grouping:result', {
        matchingCount: matching.length,
        othersCount: others.length,
        exceeded,
      })
    }

    return { matchingFilterItems: matching, otherResultItems: others, exceededSearchLimit: exceeded }
  }, [searchFilteredItems, currentFilter, evaluateViews, isSearchMode, statusFilter, labelFilterMap, labelConfigs, searchQuery])

  // --- Pagination ---

  useEffect(() => {
    setDisplayLimit(INITIAL_DISPLAY_LIMIT)
  }, [searchQuery])

  // Collapse-aware pagination: collapsed items are excluded entirely from
  // paginatedItems (and therefore flatItems / keyboard nav). Their counts are
  // returned as collapsedGroupsMeta so the renderer can show header-only groups.
  // UA12.121 — the id set the project collapse key resolves through (`projectGroupKeyOf`, the
  // grouping's own resolution): a session bound to a deleted project collapses with "No project"
  // instead of under a blind `project-<gone>` key no header carries. This block sits below the
  // file's highest docs-cited line (352) — new blocks go below it, nothing above may add a line.
  const knownProjectIds = useMemo(() => new Set((knownProjects ?? []).map(p => p.id)), [knownProjects])
  const { paginatedItems, hasMore, collapsedGroupsMeta } = useMemo(() => {
    return computeCollapsedPagination(searchFilteredItems, displayLimit, collapsedGroups, groupingMode, knownProjectIds)
  }, [searchFilteredItems, displayLimit, collapsedGroups, groupingMode, knownProjectIds])

  const loadMore = useCallback(() => {
    setDisplayLimit(prev => Math.min(prev + BATCH_SIZE, searchFilteredItems.length))
  }, [searchFilteredItems.length])

  // Scroll-based pagination: listen for scroll on the actual ScrollArea viewport
  // (IntersectionObserver with root=null doesn't detect scroll inside Radix ScrollArea)
  useEffect(() => {
    if (!hasMore) return
    const viewport = scrollViewportRef?.current
    if (!viewport) return

    const check = () => {
      const { scrollTop, scrollHeight, clientHeight } = viewport
      if (scrollHeight - scrollTop - clientHeight < 200) {
        loadMore()
      }
    }

    check() // fill viewport on mount / after group expand
    viewport.addEventListener('scroll', check, { passive: true })
    return () => viewport.removeEventListener('scroll', check)
  }, [hasMore, loadMore, displayLimit, scrollViewportRef])

  // --- Derived render data ---

  const dateGroups = useMemo(() => groupSessionsByDate(paginatedItems), [paginatedItems])

  const flatItems = useMemo(() => {
    if (isSearchMode) {
      return [...matchingFilterItems, ...otherResultItems]
    }
    return dateGroups.flatMap(group => group.sessions)
  }, [isSearchMode, matchingFilterItems, otherResultItems, dateGroups])

  const sessionIndexMap = useMemo(() => {
    const map = new Map<string, number>()
    flatItems.forEach((item, index) => map.set(item.id, index))
    return map
  }, [flatItems])

  return {
    isSearchMode,
    highlightQuery,
    isSearchingContent,
    isSearchUnavailable,
    contentSearchResults,
    matchingFilterItems,
    otherResultItems,
    exceededSearchLimit,
    flatItems,
    dateGroups,
    sessionIndexMap,
    hasMore,
    collapsedGroupsMeta,
    searchInputRef,
  }
}
