/**
 * Typed event map for server → client push channels.
 * Keys are channel string literals, values are argument tuples.
 */

import type { ThemeOverrides } from '../config/index'
import { RPC_CHANNELS } from './channels'
import type { CapabilityCatalogChangedEvent } from './capabilities'
import type {
  SessionEvent,
  UnreadSummary,
  UpdateInfo,
  BrowserInstanceInfo,
  DeepLinkNavigation,
} from './dto'

export interface BroadcastEventMap {
  // Session events (workspace-scoped via broadcastToWorkspace)
  [RPC_CHANNELS.sessions.EVENT]: [event: SessionEvent]
  [RPC_CHANNELS.sessions.UNREAD_SUMMARY_CHANGED]: [summary: UnreadSummary]
  [RPC_CHANNELS.sessions.FILES_CHANGED]: [sessionId: string]

  // Domain change broadcasts (global via broadcastToAll)
  [RPC_CHANNELS.labels.CHANGED]: [workspaceId: string]
  [RPC_CHANNELS.statuses.CHANGED]: [workspaceId: string]
  [RPC_CHANNELS.automations.CHANGED]: [workspaceId: string]
  [RPC_CHANNELS.capabilities.CHANGED]: [event: CapabilityCatalogChangedEvent]
  [RPC_CHANNELS.llmConnections.CHANGED]: []
  [RPC_CHANNELS.permissions.DEFAULTS_CHANGED]: [value: null]

  // Theme broadcasts (global)
  [RPC_CHANNELS.theme.APP_CHANGED]: [theme: ThemeOverrides | null]
  [RPC_CHANNELS.theme.SYSTEM_CHANGED]: [isDark: boolean]
  [RPC_CHANNELS.theme.PREFERENCES_CHANGED]: [preferences: { mode: string; colorTheme: string; font: string; motion?: string }]
  [RPC_CHANNELS.theme.WORKSPACE_THEME_CHANGED]: [data: { workspaceId: string; themeId: string | null }]

  // Update broadcasts (global)
  [RPC_CHANNELS.update.AVAILABLE]: [info: UpdateInfo]
  [RPC_CHANNELS.update.DOWNLOAD_PROGRESS]: [progress: number]

  // Badge broadcasts (global)
  [RPC_CHANNELS.badge.DRAW]: [data: { count: number; iconDataUrl: string }]
  [RPC_CHANNELS.badge.DRAW_WINDOWS]: [data: { count: number }]

  // Window events (per-window)
  [RPC_CHANNELS.window.FOCUS_STATE]: [isFocused: boolean]
  [RPC_CHANNELS.window.CLOSE_REQUESTED]: []

  // Browser pane events (global)
  [RPC_CHANNELS.browserPane.STATE_CHANGED]: [info: BrowserInstanceInfo]
  [RPC_CHANNELS.browserPane.REMOVED]: [id: string]
  [RPC_CHANNELS.browserPane.INTERACTED]: [id: string]

  // Navigation events (per-window)
  [RPC_CHANNELS.notification.NAVIGATE]: [data: { workspaceId: string; sessionId: string }]
  [RPC_CHANNELS.deeplink.NAVIGATE]: [navigation: DeepLinkNavigation]

  // Copilot device code event
  [RPC_CHANNELS.copilot.DEVICE_CODE]: [data: { userCode: string; verificationUri: string }]

  // Menu events (per-window, no payload)
  [RPC_CHANNELS.menu.NEW_CHAT]: []
  [RPC_CHANNELS.menu.OPEN_SETTINGS]: []
  [RPC_CHANNELS.menu.KEYBOARD_SHORTCUTS]: []
  [RPC_CHANNELS.menu.TOGGLE_FOCUS_MODE]: []
  [RPC_CHANNELS.menu.TOGGLE_SIDEBAR]: []

}

// UA3.3 — the async `tasks:generate` result (v0.13.4 protocol/events.ts), to the workspace's windows.
// Declared here by interface merging, with its import at the file end, so lines 1-68 above keep the
// numbers the docs cite (events.ts lines 34 and 56 — f154/f184 of the 2026-08-02 doc sweep).
import type { TaskGenerateResult } from './dto'

export interface BroadcastEventMap {
  [RPC_CHANNELS.tasks.GENERATED]: [workspaceId: string, result: TaskGenerateResult]
}

// UA6.4 — the workspace page list push (v0.13.4 protocol/events.ts), declared by interface merging at the file end
// for UA3.3's reason above (the docs cite lines 34 and 56).
import type { LoadedPage } from '../pages/types'

export interface BroadcastEventMap {
  [RPC_CHANNELS.pages.CHANGED]: [workspaceId: string, pages: LoadedPage[]]
}

// UA5.3 — the workspace project list push (v0.13.4 protocol/events.ts), declared by interface merging at the file end
// for UA3.3's reason above. The payload is the renderer view: a folder is a handle, never a stored path (spec §12).
import type { LoadedProjectView } from './dto'

export interface BroadcastEventMap {
  [RPC_CHANNELS.projects.CHANGED]: [workspaceId: string, projects: LoadedProjectView[]]
}

// UA12.52 — the workspace artifact-registry push (a publish or share landed a row): the section refetches, so the
// payload is the workspace id only — like `labels:changed`, never the rows.
export interface BroadcastEventMap {
  [RPC_CHANNELS.artifacts.CHANGED]: [workspaceId: string]
}
