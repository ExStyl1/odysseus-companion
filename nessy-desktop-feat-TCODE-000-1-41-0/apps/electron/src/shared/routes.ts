/**
 * Route Registry
 *
 * Type-safe route definitions for navigation throughout the app.
 * All navigation should use these route builders instead of hardcoded strings.
 *
 * Route Formats:
 * - action/{name}[/{id}] - Trigger side effects
 * - {filter}[/session/{sessionId}] - Compound view routes for full navigation state
 *
 * Usage:
 *   import { routes } from '@/shared/routes'
 *   navigate(routes.action.newSession())
 *   navigate(routes.view.allSessions())
 *   navigate(routes.view.settings('shortcuts'))
 */

import type { SettingsSubpage } from './settings-registry'
import type { PermissionMode } from '@nessy-agent/shared/agent/mode-types'

// Helper to build query strings from params
function toQueryString(params?: Record<string, string | undefined>): string {
  if (!params) return ''
  const filtered = Object.entries(params).filter(([, v]) => v !== undefined)
  if (filtered.length === 0) return ''
  const searchParams = new URLSearchParams(
    filtered as [string, string][]
  )
  return `?${searchParams.toString()}`
}

/**
 * Route definitions with type-safe builders
 */
export const routes = {
  // ============================================
  // Action Routes - Trigger actions
  // ============================================
  action: {
    /**
     * Create a new session
     * @param input - Optional initial message to pre-fill or send
     * @param name - Optional session name
     * @param send - If true and input is provided, immediately sends the message
     * @param status - Optional status/todo-state ID to apply to the new session
     * @param label - Optional label ID to apply to the new session
     * @param worktree - Start the session already isolated in a git worktree
     *   (P6.133). Honoured only for an IN-APP navigation: the handler drops it
     *   from an external link, because creating a worktree is a filesystem side
     *   effect a single click on an untrusted page must not be able to cause.
     * @param project - UA5.8 (v0.13.4): optional project id to bind the new session to
     */
    newSession: (params?: { input?: string; name?: string; send?: boolean; status?: string; label?: string; worktree?: boolean; project?: string }) =>
      `action/new-session${toQueryString(params ? { ...params, send: params.send ? 'true' : undefined, worktree: params.worktree ? 'true' : undefined } : undefined)}` as const,

    /** Rename a session */
    renameSession: (sessionId: string, name: string) =>
      `action/rename-session/${sessionId}?name=${encodeURIComponent(name)}` as const,

    /** Delete a session (with confirmation) */
    deleteSession: (sessionId: string) =>
      `action/delete-session/${sessionId}` as const,

    /** Toggle flag on a session */
    flagSession: (sessionId: string) =>
      `action/flag-session/${sessionId}` as const,

    /** Unflag a session */
    unflagSession: (sessionId: string) =>
      `action/unflag-session/${sessionId}` as const,

    /** Start OAuth flow for a source */
    oauth: (sourceSlug: string) => `action/oauth/${sourceSlug}` as const,

    /** Open add source UI */
    addSource: () => 'action/add-source' as const,

    // Note: test-source route can be added when API support is available
    // testSource: (sourceSlug: string) => `action/test-source/${sourceSlug}` as const,

    /** Delete a source */
    deleteSource: (sourceSlug: string) =>
      `action/delete-source/${sourceSlug}` as const,

    /** Set permission mode for a session */
    setPermissionMode: (
      sessionId: string,
      mode: PermissionMode
    ) => `action/set-mode/${sessionId}?mode=${mode}` as const,

    /** Copy text to clipboard */
    copyToClipboard: (text: string) =>
      `action/copy?text=${encodeURIComponent(text)}` as const,
  },

  // ============================================
  // View Routes - Compound sidebar/navigator/details routes
  // ============================================
  view: {
    /** All sessions view (sessions navigator, allSessions filter) */
    allSessions: (sessionId?: string) =>
      sessionId ? `allSessions/session/${sessionId}` as const : 'allSessions' as const,

    /** Flagged view (sessions navigator, flagged filter) */
    flagged: (sessionId?: string) =>
      sessionId ? `flagged/session/${sessionId}` as const : 'flagged' as const,

    /** Archived view (sessions navigator, archived filter) */
    archived: (sessionId?: string) =>
      sessionId ? `archived/session/${sessionId}` as const : 'archived' as const,

    /** Todo state filter view (sessions navigator, state filter) */
    state: (stateId: string, sessionId?: string) =>
      sessionId
        ? `state/${stateId}/session/${sessionId}` as const
        : `state/${stateId}` as const,

    /** Label filter view (sessions navigator, label filter — includes descendants via tree hierarchy) */
    label: (labelId: string, sessionId?: string) =>
      sessionId
        ? `label/${encodeURIComponent(labelId)}/session/${sessionId}` as const
        : `label/${encodeURIComponent(labelId)}` as const,

    /** View filter (sessions navigator, view filter — evaluated dynamically) */
    view: (viewId: string, sessionId?: string) =>
      sessionId
        ? `view/${encodeURIComponent(viewId)}/session/${sessionId}` as const
        : `view/${encodeURIComponent(viewId)}` as const,

    /** Sources view (sources navigator) - supports type filtering */
    sources: (params?: { sourceSlug?: string; type?: 'api' | 'mcp' | 'local' }) => {
      const { sourceSlug, type } = params ?? {}
      // Build base from filter type
      const base = type ? `sources/${type}` : 'sources'
      if (sourceSlug) {
        return `${base}/source/${sourceSlug}` as const
      }
      return base as 'sources' | `sources/${'api' | 'mcp' | 'local'}`
    },

    /** API sources view (sources navigator, api filter) */
    sourcesApi: (sourceSlug?: string) =>
      sourceSlug
        ? `sources/api/source/${sourceSlug}` as const
        : 'sources/api' as const,

    /** MCP sources view (sources navigator, mcp filter) */
    sourcesMcp: (sourceSlug?: string) =>
      sourceSlug
        ? `sources/mcp/source/${sourceSlug}` as const
        : 'sources/mcp' as const,

    /** Local folder sources view (sources navigator, local filter) */
    sourcesLocal: (sourceSlug?: string) =>
      sourceSlug
        ? `sources/local/source/${sourceSlug}` as const
        : 'sources/local' as const,

    /**
     * Installed-plugins management subsection (sources navigator, plugins
     * filter). Pass a pluginKey for the plugin-detail view (U4). The key is
     * URL-encoded because a pluginKey is opaque and may contain reserved chars.
     */
    sourcesPlugins: (pluginKey?: string) =>
      pluginKey
        ? `sources/plugins/plugin/${encodeURIComponent(pluginKey)}` as const
        : 'sources/plugins' as const,

    /** Native project hooks under Sources. */
    sourcesHooks: () => 'sources/hooks' as const,

    /** Skills view (skills navigator). Pass a slug string for a local skill detail view. */
    skills: (skillSlug?: string) => {
      if (!skillSlug) return 'skills' as const
      return `skills/skill/${skillSlug}` as const
    },

    /** Automations view (automations navigator) - supports type filtering */
    automations: (params?: { automationId?: string; type?: 'scheduled' | 'event' | 'agentic' }) => {
      const { automationId, type } = params ?? {}
      const base = type ? `automations/${type}` : 'automations'
      if (automationId) return `${base}/automation/${automationId}` as const
      return base as 'automations' | `automations/${'scheduled' | 'event' | 'agentic'}`
    },

    /** Scheduled automations view (automations navigator, scheduled filter) */
    automationsScheduled: (automationId?: string) =>
      automationId ? `automations/scheduled/automation/${automationId}` as const : 'automations/scheduled' as const,

    /** Event-based automations view (automations navigator, event filter) */
    automationsEvent: (automationId?: string) =>
      automationId ? `automations/event/automation/${automationId}` as const : 'automations/event' as const,

    /** Agentic automations view (automations navigator, agentic filter) */
    automationsAgentic: (automationId?: string) =>
      automationId ? `automations/agentic/automation/${automationId}` as const : 'automations/agentic' as const,

    /** Plugins management view */
    plugins: () => 'plugins' as const,
    knowledge: () => 'knowledge' as const,
    knowledgeChat: () => 'knowledge-chat' as const,

    /** UA7.3 (v0.13.4) — Pages view (full-width library grid, or one page's embedded render) */
    pages: (pageSlug?: string) =>
      pageSlug
        ? `pages/page/${pageSlug}` as const
        : 'pages' as const,

    /** UA5.8 (v0.13.4) — Projects view (projects navigator) */
    projects: (projectSlug?: string) =>
      projectSlug
        ? `projects/project/${projectSlug}` as const
        : 'projects' as const,

    /** UA2.2 (v0.13.4) — Kanban board view (sessions navigator, board view mode, all sessions) */
    board: () => 'board' as const,

    /**
     * Settings view (settings navigator) - uses SettingsSubpage from registry.
     *
     * D1.254 — the optional SECOND argument names a connection, and it is the
     * only way a surface outside `AiSettingsPage` can open one connection's
     * setup: the overlay is local state there (`setEditingConnectionSlug` +
     * `setShowApiSetup`), so before this segment existed every caller — a chat
     * card offering *Update credentials*, D1.194's expired-subscription card —
     * could only land the user on the page and leave them to find the row.
     *
     * A VIEW segment rather than an `action/…` route, because an action route is
     * handled inside `NavigationContext` and would need a second channel to
     * reach a page's local state — the segment travels the way the page is
     * chosen. It round-trips through the parser and the panel stack like every
     * other segment, and the PAGE DROPS IT the moment it has acted on it, so the
     * route never outlives what it describes and pressing the same button twice
     * works the second time. That is stated here because it is the one thing
     * about this segment a reader cannot guess: it is consumed, not held.
     *
     * Honoured by the `ai` subpage alone today. The segment is accepted after
     * any subpage because the grammar belongs to the route rather than to one
     * page, and a page that does not read it simply renders as before.
     */
    settings: (subpage?: SettingsSubpage, connectionSlug?: string) => {
      if (!subpage) return 'settings' as const
      return connectionSlug
        ? `settings/${subpage}/connection/${encodeURIComponent(connectionSlug)}` as const
        : `settings/${subpage}` as const
    },
  },
} as const

/**
 * Type representing any valid route string
 */
export type ActionRoute = ReturnType<(typeof routes.action)[keyof typeof routes.action]>
export type ViewRoute = ReturnType<(typeof routes.view)[keyof typeof routes.view]>
export type Route = ActionRoute | ViewRoute
