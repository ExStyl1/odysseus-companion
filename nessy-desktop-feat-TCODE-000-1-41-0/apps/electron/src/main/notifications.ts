/**
 * Notification Service
 *
 * Handles native OS notifications and app badge count.
 * - Shows notifications when new messages arrive, at the timing the user chose
 *   (`learn.chatgpt.com/docs/notifications.md#configure-desktop-notifications`: never, only while in
 *   the background, or always). "Only while in the background" used to be the
 *   only reachable position and was written here as an unconditional focus
 *   check; it is now one of three, resolved by `shouldNotifyAtTiming`.
 * - Updates dock badge count with total unread messages
 * - Clicking notification navigates to the relevant session
 */

import { Notification, app, BrowserWindow, nativeImage } from 'electron'
import { join } from 'path'
import { readFileSync } from 'fs'
import { mainLog } from './logger'
import { RPC_CHANNELS } from '../shared/types'
import type { WindowManager } from './window-manager'
import type { EventSink } from '@nessy-agent/server-core/transport'
import { shouldNotifyAtTiming, type NotificationTiming } from '@nessy-agent/shared/config/notification-timing'

type ClientResolver = (webContentsId: number) => string | undefined

let windowManager: WindowManager | null = null
let eventSink: EventSink | null = null
let clientResolver: ClientResolver | null = null
let baseIconPath: string | null = null
let baseIconDataUrl: string | null = null
let currentBadgeCount: number = 0
let instanceNumber: number | null = null  // Multi-instance dev: instance number for dock badge

/**
 * Initialize the notification service with window manager reference
 */
export function initNotificationService(wm: WindowManager): void {
  windowManager = wm
}

/**
 * Set the event sink for notification broadcasts (called after server creation).
 *
 * When a resolver is provided we can route session navigation events to a
 * single client instead of broadcasting to every window in the workspace.
 */
export function setNotificationEventSink(sink: EventSink, resolver?: ClientResolver): void {
  eventSink = sink
  clientResolver = resolver ?? null
}

/**
 * Show a native notification for a new message
 *
 * @param title - Notification title (e.g., session name)
 * @param body - Notification body (e.g., message preview)
 * @param workspaceId - Workspace ID for navigation
 * @param sessionId - Session ID for navigation
 */
export function showNotification(
  title: string,
  body: string,
  workspaceId: string,
  sessionId: string
): void {
  if (!Notification.isSupported()) {
    mainLog.info('Notifications not supported on this platform')
    return
  }

  const notification = new Notification({
    title,
    body,
    // macOS-specific options
    silent: false,
    // Use the app icon
    icon: undefined,  // Will use app icon by default on macOS
  })

  notification.on('click', () => {
    mainLog.info('Notification clicked:', { workspaceId, sessionId })
    handleNotificationClick(workspaceId, sessionId)
  })

  notification.show()
  mainLog.info('Notification shown:', { title, sessionId })
}

/**
 * Deliver a model-requested notification (`PushNotification`, R27a).
 *
 * Deliberately NOT a second notification path: the decision lives here and the
 * delivery is the same {@link showNotification} the renderer already drives.
 * What this adds is the two suppressions the renderer applies on its side
 * (`useNotifications.ts`) and the tool needs applied on ours:
 *
 * - the user's notifications setting, and
 * - focus. `tools-reference.md:41` scopes the tool to reaching the user "when
 *   you step away", so notifying about work the user is already watching is
 *   noise. Focus is checked on the window showing THIS session's workspace,
 *   not on any window: another workspace's window having focus says nothing
 *   about whether this session is being watched.
 *
 * Both suppressions are now the SAME question — which of the three positions
 * the user chose — so they are asked once, of `shouldNotifyAtTiming`. At
 * "background" that is byte-for-byte the pair above; at "never" it is the
 * disabled case; at "always" the user has said, in the one control that can say
 * it, that they want the alert while watching, and the "step away" rationale is
 * the description of position two rather than a rule that outranks their choice.
 *
 * Never throws — a notification failure must not fail the model's turn.
 */
export async function deliverModelNotification(input: {
  title?: string
  body: string
  workspaceId: string
  sessionId: string
}): Promise<{ delivered: boolean; reason?: 'window-focused' | 'notifications-disabled' | 'unsupported' }> {
  if (!Notification.isSupported()) return { delivered: false, reason: 'unsupported' }

  let timing: NotificationTiming
  try {
    const { getNotificationSettings } = await import('@nessy-agent/shared/config/storage')
    timing = getNotificationSettings().timing
  } catch (error) {
    mainLog.error('Failed to read the notifications setting:', error)
    return { delivered: false, reason: 'unsupported' }
  }

  if (timing === 'never') return { delivered: false, reason: 'notifications-disabled' }
  if (!shouldNotifyAtTiming(timing, isWorkspaceWindowFocused(input.workspaceId))) {
    return { delivered: false, reason: 'window-focused' }
  }

  showNotification(input.title ?? 'Nessy Desktop', input.body, input.workspaceId, input.sessionId)
  return { delivered: true }
}

/**
 * Announce a start/wake catch-up run.
 *
 * desktop-scheduled-tasks.md:74 — "Desktop shows a notification when a catch-up
 * run starts."
 *
 * Shares {@link deliverModelNotification}'s notifications-enabled gate and
 * deliberately NOT its focus gate: a catch-up fires seconds after the app opens
 * or the machine wakes, which is exactly when the window is focused, so gating
 * on focus would swallow almost every one of them. The user is being told that
 * a run they did not ask for just started — that is worth saying even while
 * they are looking at the app.
 *
 * So of the three positions only "never" changes anything here: this path was
 * already behaving as "always", and reading the timing would give position two
 * a focus gate it has never had.
 *
 * Never throws.
 */
export async function deliverScheduledRunNotification(input: {
  title?: string
  body: string
  workspaceId: string
  sessionId: string
}): Promise<{ delivered: boolean; reason?: 'window-focused' | 'notifications-disabled' | 'unsupported' }> {
  if (!Notification.isSupported()) return { delivered: false, reason: 'unsupported' }

  try {
    const { getNotificationsEnabled } = await import('@nessy-agent/shared/config/storage')
    if (!getNotificationsEnabled()) return { delivered: false, reason: 'notifications-disabled' }
  } catch (error) {
    mainLog.error('Failed to read the notifications setting:', error)
    return { delivered: false, reason: 'unsupported' }
  }

  showNotification(input.title ?? 'Nessy Desktop', input.body, input.workspaceId, input.sessionId)
  return { delivered: true }
}

/**
 * Whether the window showing this workspace currently has focus.
 *
 * Not {@link isAnyWindowFocused}: that answers "is the app in front", which is
 * the wrong question when several workspaces are open in separate windows.
 */
export function isWorkspaceWindowFocused(workspaceId: string): boolean {
  const window = windowManager?.getWindowByWorkspace(workspaceId)
  return Boolean(window && !window.isDestroyed() && window.isFocused())
}

/**
 * Handle notification click - focus window and navigate to session
 */
function handleNotificationClick(workspaceId: string, sessionId: string): void {
  if (!windowManager) {
    mainLog.error('WindowManager not initialized for notification click')
    return
  }

  // Find or create window for this workspace
  let window = windowManager.getWindowByWorkspace(workspaceId)

  if (!window) {
    // Create a new window for this workspace
    windowManager.createWindow({ workspaceId })
    window = windowManager.getWindowByWorkspace(workspaceId)
  }

  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
    // Focus the window
    if (window.isMinimized()) {
      window.restore()
    }
    window.focus()

    // Send navigation event to renderer to open the session.
    // Prefer a single-client target to avoid cross-window navigation side effects.
    if (eventSink) {
      const clientId = clientResolver?.(window.webContents.id)
      if (clientId) {
        eventSink(RPC_CHANNELS.notification.NAVIGATE, { to: 'client', clientId }, {
          workspaceId,
          sessionId,
        })
      } else {
        eventSink(RPC_CHANNELS.notification.NAVIGATE, { to: 'workspace', workspaceId }, {
          workspaceId,
          sessionId,
        })
      }
    }
  }
}

/**
 * Initialize the base icon for badge overlay
 * Call this during app startup
 */
export function initBadgeIcon(iconPath: string): void {
  try {
    baseIconPath = iconPath
    // Read and cache the icon as base64 data URL
    const iconBuffer = readFileSync(iconPath)
    baseIconDataUrl = `data:image/png;base64,${iconBuffer.toString('base64')}`
    mainLog.info('Badge icon initialized:', iconPath)
  } catch (error) {
    mainLog.error('Failed to initialize badge icon:', error)
  }
}

/**
 * Update the app badge count (cross-platform)
 *
 * - macOS: Uses a canvas-based approach to draw the badge directly onto the dock icon.
 * - Windows: Uses taskbar overlay icon for badge display.
 * - Linux: Uses app.setBadgeCount() where supported (Unity, KDE).
 *
 * @param count - Number to show on badge (0 to clear)
 */
export function updateBadgeCount(count: number): void {
  // Skip if count hasn't changed
  if (count === currentBadgeCount) {
    return
  }

  currentBadgeCount = count

  if (process.platform === 'darwin') {
    updateBadgeCountMacOS(count)
  } else if (process.platform === 'win32') {
    updateBadgeCountWindows(count)
  } else if (process.platform === 'linux') {
    updateBadgeCountLinux(count)
  }
}

/**
 * Update badge count on macOS using dock icon overlay
 */
function updateBadgeCountMacOS(count: number): void {
  try {
    if (count > 0) {
      // Draw badge onto icon using the renderer process (Canvas API)
      if (eventSink && baseIconDataUrl) {
        eventSink(RPC_CHANNELS.badge.DRAW, { to: 'all' }, { count, iconDataUrl: baseIconDataUrl })
      }
    } else {
      // Reset to original icon (no badge)
      if (baseIconPath) {
        const originalIcon = nativeImage.createFromPath(baseIconPath)
        app.dock?.setIcon(originalIcon)
      }
    }
    mainLog.info('Badge count updated (macOS):', count)
  } catch (error) {
    mainLog.error('Failed to update badge count (macOS):', error)
  }
}

/**
 * Update badge count on Windows using taskbar overlay icon
 */
function updateBadgeCountWindows(count: number): void {
  try {
    if (count > 0) {
      // Draw overlay icon using the renderer process (Canvas API)
      if (eventSink) {
        eventSink(RPC_CHANNELS.badge.DRAW_WINDOWS, { to: 'all' }, { count })
      }
    } else {
      // Clear the overlay on all windows (UA12.80 — not the hidden capture window)
      const windows = appWindows(BrowserWindow.getAllWindows())
      for (const window of windows) {
        if (!window.isDestroyed()) {
          window.setOverlayIcon(null, '')
        }
      }
    }
    mainLog.info('Badge count updated (Windows):', count)
  } catch (error) {
    mainLog.error('Failed to update badge count (Windows):', error)
  }
}

/**
 * Update badge count on Linux using app.setBadgeCount (Unity/KDE)
 */
function updateBadgeCountLinux(count: number): void {
  try {
    // Electron's setBadgeCount works on Linux with Unity launcher and KDE
    app.setBadgeCount(count)
    mainLog.info('Badge count updated (Linux):', count)
  } catch (error) {
    mainLog.error('Failed to update badge count (Linux):', error)
  }
}

/**
 * Set the dock/taskbar icon with a pre-rendered badge image (cross-platform)
 * Called from IPC when renderer has drawn the badge
 */
export function setDockIconWithBadge(dataUrl: string): void {
  try {
    const icon = nativeImage.createFromDataURL(dataUrl)

    if (process.platform === 'darwin') {
      app.dock?.setIcon(icon)
      mainLog.info('Dock icon updated with badge (macOS)')
    } else if (process.platform === 'win32') {
      // On Windows, set the taskbar overlay icon (UA12.80 — on an app window, never the hidden capture window)
      const windows = appWindows(BrowserWindow.getAllWindows())
      const window = windows[0]
      if (window && !window.isDestroyed()) {
        window.setOverlayIcon(icon, `${currentBadgeCount} notifications`)
        mainLog.info('Taskbar overlay updated with badge (Windows)')
      }
    }
  } catch (error) {
    mainLog.error('Failed to set dock/taskbar icon with badge:', error)
  }
}

/**
 * Clear the app dock badge
 */
export function clearBadgeCount(): void {
  updateBadgeCount(0)
}

/**
 * Check if any window is currently focused
 */
export function isAnyWindowFocused(): boolean {
  const focusedWindow = BrowserWindow.getFocusedWindow()
  return focusedWindow !== null && !focusedWindow.isDestroyed()
}

/**
 * Initialize instance badge for multi-instance development.
 *
 * When running from a numbered folder (e.g., nessy-tui-agent-1), this shows
 * a permanent badge on the dock icon to distinguish between instances.
 * Uses macOS dock.setBadge() for text-based badge display.
 *
 * @param number - Instance number (1, 2, etc.) or null for default instance
 */
export function initInstanceBadge(number: number): void {
  if (process.platform !== 'darwin') {
    // Instance badge only supported on macOS for now
    return
  }

  instanceNumber = number

  try {
    // Use dock.setBadge() for simple text badge
    // This shows the number in a red badge on the dock icon
    app.dock?.setBadge(String(number))
    mainLog.info(`Instance badge set: ${number}`)
  } catch (error) {
    mainLog.error('Failed to set instance badge:', error)
  }
}

// UA12.80 — appended below the lines the docs cite (import declarations are hoisted).
import { appWindows } from './app-windows'
