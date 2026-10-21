/**
 * Auto-update module using electron-updater
 *
 * Handles checking for updates, downloading, and installing via the standard
 * electron-updater library. The update URL is injected by release configuration.
 * using the generic provider (YAML manifests + binaries on R2/S3).
 *
 * Platform behavior:
 * - macOS: Downloads zip, extracts and swaps app bundle atomically
 * - Windows: Downloads NSIS installer, runs silently on quit
 * - Linux: Downloads AppImage, replaces current file
 *
 * All platforms support download-progress events (electron-updater v6.8.0+).
 * quitAndInstall() handles restart natively — no external scripts.
 */

import { autoUpdater } from 'electron-updater'
import { app, BrowserWindow } from 'electron'
import { platform } from 'os'
import * as path from 'path'
import * as fs from 'fs'
import { mainLog, autoUpdateLog } from './logger'
import {
  getDismissedUpdateVersion,
  clearDismissedUpdateVersion,
  areInAppUpdatesManagedDisabled,
  resolveManagedInAppUpdatesSource,
  subscribeManagedInAppUpdatesChange,
} from '@nessy-agent/shared/config'
import { readJsonFileSync } from '@nessy-agent/shared/utils/files'
import { RPC_CHANNELS, type UpdateInfo } from '../shared/types'
import type { EventSink } from '@nessy-agent/server-core/transport'

// Platform detection
const PLATFORM = platform()
const IS_MAC = PLATFORM === 'darwin'
const IS_WINDOWS = PLATFORM === 'win32'

// Get the update cache directory path (for file watcher fallback on macOS)
// electron-updater uses these paths:
// - Windows: %LOCALAPPDATA%/{appName}-updater/pending
// - macOS: ~/Library/Caches/{appName}-updater/pending
// - Linux: ~/.cache/{appName}-updater/pending
function getUpdateCacheDir(): string {
  const appName = app.getName()
  if (IS_MAC) {
    return path.join(app.getPath('home'), 'Library', 'Caches', `${appName}-updater`, 'pending')
  } else if (IS_WINDOWS) {
    // Windows uses LOCALAPPDATA, not APPDATA (roaming)
    const localAppData = process.env.LOCALAPPDATA || path.join(app.getPath('home'), 'AppData', 'Local')
    return path.join(localAppData, `${appName}-updater`, 'pending')
  } else {
    // Linux
    return path.join(app.getPath('home'), '.cache', `${appName}-updater`, 'pending')
  }
}

// Module state — keeps track of update info for IPC queries
let updateInfo: UpdateInfo = {
  available: false,
  currentVersion: app.getVersion(),
  latestVersion: null,
  downloadState: 'idle',
  downloadProgress: 0,
}

let eventSink: EventSink | null = null

// Flag to indicate update is in progress — used to prevent force exit during quitAndInstall
let __isUpdating = false

// Hook fired immediately before quitAndInstall, while BrowserWindows still exist.
// electron-updater destroys windows between quitAndInstall and before-quit firing,
// so the regular before-quit save site would see an empty array.
let beforeUpdateQuitHook: (() => void) | null = null

/**
 * Register a callback to run inside installUpdate() before quitAndInstall.
 * Used by index.ts to snapshot multi-window state while windows are still alive.
 */
export function setBeforeUpdateQuitHook(fn: () => void): void {
  beforeUpdateQuitHook = fn
}

/**
 * Check if an update installation is in progress.
 * Used by main process to avoid force-quitting during update.
 */
export function isUpdating(): boolean {
  return __isUpdating
}

/**
 * Set the event sink for broadcasting update events to renderer windows
 */
export function setAutoUpdateEventSink(sink: EventSink): void {
  eventSink = sink
}

/**
 * The managed gate — `config/managed-in-app-updates.ts` owns the key, this owns
 * what it costs the updater.
 *
 * Asked at every entry point rather than resolved once at startup because the
 * managed value can be registered after this module is first imported (the
 * codex `configRequirements` read that binds it happens after initialize), and
 * a cached "allowed" from before that would outlive the policy.
 *
 * The side effect is the point: electron-updater has two paths that need no
 * caller of ours — `autoDownload` (it fetches as soon as a check finds
 * something) and `autoInstallOnAppQuit` (it installs a staged download on the
 * next quit). Refusing our three exported functions alone would leave both
 * running, so the gate clears them on the way past. They are only ever cleared,
 * never restored, because a process that has seen the policy on has no business
 * turning them back on.
 */
function inAppUpdatesDisabledByPolicy(): boolean {
  if (!areInAppUpdatesManagedDisabled()) return false
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  return true
}

/**
 * Get current update info (called by IPC handler)
 *
 * Under a managed policy this reports the state the app is actually IN, not the
 * last state electron-updater left behind: nothing is available, because
 * nothing can be installed. Reporting a stale `ready` here would put the
 * "Restart to update" row and the update toast back on screen
 * (`useUpdateChecker` fires on `available && downloadState === 'ready'`) for an
 * install that `installUpdate` then refuses.
 *
 * P3.240 — the payload also carries WHICH tier decided. Resolved here, in the
 * same call as the gate, so the flag and its source can never describe two
 * different moments: the codex tier arms mid-session, and a source read a
 * moment later could name a document that was not the reason for THIS refusal.
 * Only ever set alongside `managedDisabled`, and only when a tier actually
 * answered — a resolver that returns nothing leaves the field absent rather than
 * inventing a document to blame.
 */
export function getUpdateInfo(): UpdateInfo {
  if (inAppUpdatesDisabledByPolicy()) {
    const managedSource = resolveManagedInAppUpdatesSource()
    return {
      ...updateInfo,
      available: false,
      downloadState: 'idle',
      downloadProgress: 0,
      managedDisabled: true,
      ...(managedSource ? { managedSource } : {}),
    }
  }
  return { ...updateInfo }
}

/**
 * Broadcast update info to all renderer windows.
 * Creates a snapshot to avoid race conditions during broadcast.
 */
function broadcastUpdateInfo(): void {
  if (!eventSink) return

  // Through getUpdateInfo(), not `{ ...updateInfo }`: the broadcast and the
  // pull must carry the same payload, or a push would overwrite a renderer's
  // managed-aware state with one that has lost the flag.
  const snapshot = getUpdateInfo()
  eventSink(RPC_CHANNELS.update.AVAILABLE, { to: 'all' }, snapshot)
}

/**
 * P2.7 clause (b) — a managed answer that ARRIVES flips a live settings page.
 *
 * P2.10's gate reports `managedDisabled` correctly to anything that asks, and
 * nothing asked again after the answer changed: the renderer pulls
 * `getUpdateInfo()` once on mount and then listens, so a policy registered
 * afterwards left the page saying updates were available until the user
 * navigated away and back. Both writers of the policy now arrive after mount in
 * the ordinary case — the codex `configRequirements` read happens when the first
 * codex runtime starts — so the subscription is not an optimisation.
 *
 * Subscribed at MODULE scope, next to the two `autoUpdater` flag assignments
 * below, because this module is imported once per process and the subscription
 * has the same lifetime as the updater it speaks for. `broadcastUpdateInfo`
 * itself no-ops until `setAutoUpdateEventSink` has run, so an early policy
 * registration costs nothing and the renderer's own mount-time pull covers it.
 */
subscribeManagedInAppUpdatesChange(() => {
  broadcastUpdateInfo()
})

/**
 * Broadcast download progress to all renderer windows.
 */
function broadcastDownloadProgress(progress: number): void {
  if (!eventSink) return

  eventSink(RPC_CHANNELS.update.DOWNLOAD_PROGRESS, { to: 'all' }, progress)
}

// ─── Configure electron-updater ───────────────────────────────────────────────

// Auto-download updates in the background after detection
autoUpdater.autoDownload = true

// Install on app quit (if update is downloaded but user hasn't clicked "Restart")
autoUpdater.autoInstallOnAppQuit = true

// Use the logger for electron-updater internal logging
autoUpdater.logger = {
  info: (msg: unknown) => mainLog.info('[electron-updater]', msg),
  warn: (msg: unknown) => mainLog.warn('[electron-updater]', msg),
  error: (msg: unknown) => mainLog.error('[electron-updater]', msg),
  debug: (msg: unknown) => mainLog.info('[electron-updater:debug]', msg),
}

// ─── Event handlers ───────────────────────────────────────────────────────────

autoUpdater.on('checking-for-update', () => {
  mainLog.info('[auto-update] Checking for updates...')
})

autoUpdater.on('update-available', (info) => {
  // The two handlers that raise `available: true` are guarded as well as the
  // three entry points, because electron-updater is an event source of its own:
  // a check already in flight when the policy is registered would otherwise
  // still land a downloaded update and a toast.
  if (inAppUpdatesDisabledByPolicy()) {
    autoUpdateLog.info('Ignoring update-available: in-app updates disabled by managed policy')
    return
  }

  autoUpdateLog.info(`Update available: ${updateInfo.currentVersion} → ${info.version}`)

  // First, check electron-updater's internal state (most reliable)
  const internalState = checkElectronUpdaterState()
  if (internalState.ready) {
    mainLog.info(`[auto-update] electron-updater reports download ready`)
    updateInfo = {
      ...updateInfo,
      available: true,
      latestVersion: info.version,
      downloadState: 'ready',
      downloadProgress: 100,
    }
    broadcastUpdateInfo()
    return
  }

  // Fallback: check if file exists in cache directory
  const existing = checkForExistingDownload()
  if (existing.exists) {
    mainLog.info(`[auto-update] Update already downloaded (file check), setting state to ready`)
    updateInfo = {
      ...updateInfo,
      available: true,
      latestVersion: info.version,
      downloadState: 'ready',
      downloadProgress: 100,
    }
    broadcastUpdateInfo()
    return
  }

  updateInfo = {
    ...updateInfo,
    available: true,
    latestVersion: info.version,
    downloadState: 'downloading',
    downloadProgress: 0,
  }
  broadcastUpdateInfo()
})

autoUpdater.on('update-not-available', (info) => {
  mainLog.info(`[auto-update] Already up to date (${info.version})`)

  updateInfo = {
    ...updateInfo,
    available: false,
    latestVersion: info.version,
    downloadState: 'idle',
  }
  broadcastUpdateInfo()
})

autoUpdater.on('download-progress', (progress) => {
  const percent = Math.round(progress.percent)
  updateInfo = { ...updateInfo, downloadProgress: percent }
  broadcastDownloadProgress(percent)
})

autoUpdater.on('update-downloaded', async (info) => {
  // Same reason as update-available, plus one of its own: this handler is what
  // rewrites the app menu to "Install Update…", and a managed install must not
  // be offered an install it will refuse.
  if (inAppUpdatesDisabledByPolicy()) {
    autoUpdateLog.info('Ignoring update-downloaded: in-app updates disabled by managed policy')
    return
  }

  autoUpdateLog.info(`Update downloaded: v${info.version}`)

  updateInfo = {
    ...updateInfo,
    available: true,
    latestVersion: info.version,
    downloadState: 'ready',
    downloadProgress: 100,
  }
  broadcastUpdateInfo()

  // Rebuild menu to show "Install Update..." option
  const { rebuildMenu } = await import('./menu')
  rebuildMenu()
})

autoUpdater.on('error', (error) => {
  autoUpdateLog.error('electron-updater error', error)

  updateInfo = {
    ...updateInfo,
    downloadState: 'error',
    error: error.message,
  }
  broadcastUpdateInfo()
})

// ─── Exported API ─────────────────────────────────────────────────────────────

/**
 * Check if electron-updater already has a validated download ready.
 * This uses electron-updater's internal state which is more reliable than file checks.
 */
function checkElectronUpdaterState(): { ready: boolean; version?: string } {
  try {
    // Access electron-updater's internal downloadedUpdateHelper
    // @ts-expect-error - accessing internal API for reliability
    const helper = autoUpdater.downloadedUpdateHelper
    if (helper) {
      mainLog.info(`[auto-update] downloadedUpdateHelper exists, cacheDir: ${helper.cacheDir}`)
      // @ts-expect-error - accessing internal API
      const versionInfo = helper.versionInfo
      if (versionInfo) {
        mainLog.info(`[auto-update] electron-updater has validated download: ${JSON.stringify(versionInfo)}`)
        return { ready: true, version: versionInfo.version }
      }
    }
  } catch (error) {
    mainLog.warn('[auto-update] Error checking electron-updater state:', error)
  }
  return { ready: false }
}

/**
 * Options for checkForUpdates
 */
interface CheckOptions {
  /** If true, automatically start download when update is found (default: true) */
  autoDownload?: boolean
}

/**
 * Check if a downloaded update already exists in the cache directory.
 * This helps detect updates that were downloaded in a previous session.
 */
function checkForExistingDownload(): { exists: boolean; version?: string } {
  try {
    const cacheDir = getUpdateCacheDir()
    mainLog.info(`[auto-update] Checking cache directory: ${cacheDir}`)

    if (!fs.existsSync(cacheDir)) {
      mainLog.info(`[auto-update] Cache directory does not exist`)
      return { exists: false }
    }

    const files = fs.readdirSync(cacheDir)
    mainLog.info(`[auto-update] Files in cache: ${JSON.stringify(files)}`)

    // Look for update info file that electron-updater creates
    const updateInfoFile = files.find(f => f === 'update-info.json')
    if (updateInfoFile) {
      const infoPath = path.join(cacheDir, updateInfoFile)
      const info = readJsonFileSync(infoPath) as Record<string, unknown> | null
      mainLog.info(`[auto-update] update-info.json contents: ${JSON.stringify(info)}`)

      // electron-updater uses 'fileName' (not 'path') in update-info.json
      const fileName = (info?.fileName || info?.path) as string | undefined
      if (fileName && fs.existsSync(path.join(cacheDir, fileName))) {
        mainLog.info(`[auto-update] Found existing download via update-info.json: ${fileName}`)
        return { exists: true, version: info?.version as string }
      }
    }

    // Fallback: check for any installer/zip/dmg file
    const downloadFile = files.find(f =>
      f.endsWith('.zip') ||
      f.endsWith('.exe') ||
      f.endsWith('.AppImage') ||
      f.endsWith('.dmg') ||
      f.endsWith('.nupkg')
    )
    if (downloadFile) {
      mainLog.info(`[auto-update] Found existing download file: ${downloadFile}`)
      return { exists: true }
    }

    mainLog.info(`[auto-update] No existing download found in cache`)
    return { exists: false }
  } catch (error) {
    mainLog.warn('[auto-update] Error checking for existing download:', error)
    return { exists: false }
  }
}

/**
 * Check for available updates.
 * Returns the current UpdateInfo state after check completes.
 *
 * @param options.autoDownload - If false, only checks without downloading (for manual "Check Now")
 */
export async function checkForUpdates(options: CheckOptions = {}): Promise<UpdateInfo> {
  const { autoDownload = true } = options

  // Entry point 1 of 3: the macOS app menu's "Check for Updates…", the debug
  // menu's, the renderer's Check Now (RPC_CHANNELS.update.CHECK), and
  // checkForUpdatesOnLaunch all arrive here. Nothing touches the feed under a
  // managed policy — no request, no download, no notification.
  //
  // The menu item itself stays visible:
  // `learn.chatgpt.com/docs/enterprise/manage-app-updates.md#verify-the-managed-setting`
  // says "The **Check for Updates** menu option can remain visible even when the
  // policy blocks in-app updates", so the refusal lives at the action, not in the
  // menu template. (P2.377 gave the citation its host and its section: it read
  // `manage-app-updates.md:84`-`:86`, a bare name that resolves in codex's corpus
  // and 404s in Claude's, which is the only one a reader here would try.)
  if (inAppUpdatesDisabledByPolicy()) {
    autoUpdateLog.info('Update check refused: in-app updates disabled by managed policy')
    updateInfo = {
      ...updateInfo,
      available: false,
      latestVersion: null,
      downloadState: 'idle',
      downloadProgress: 0,
    }
    broadcastUpdateInfo()
    return getUpdateInfo()
  }

  // Temporarily override autoDownload for this check if needed
  // (e.g., manual check from settings shouldn't auto-download on metered connections)
  const previousAutoDownload = autoUpdater.autoDownload
  autoUpdater.autoDownload = autoDownload

  try {
    // Check for updates - this returns a promise that resolves with the check result
    const result = await autoUpdater.checkForUpdates()

    // If update is available and was already downloaded, the update-downloaded event
    // should fire. Wait a moment for events to settle before returning.
    if (result?.updateInfo) {
      // Give electron-updater time to fire update-downloaded if file exists
      await new Promise(resolve => setTimeout(resolve, 500))

      // Double-check: if we're still showing 'downloading' but file exists, update state
      if (updateInfo.downloadState === 'downloading') {
        const existing = checkForExistingDownload()
        if (existing.exists) {
          mainLog.info('[auto-update] Update already downloaded, updating state to ready')
          updateInfo = {
            ...updateInfo,
            downloadState: 'ready',
            downloadProgress: 100,
          }
          broadcastUpdateInfo()
        }
      }
    }
  } catch (error) {
    autoUpdateLog.error('Update check failed', error)
    updateInfo = {
      ...updateInfo,
      downloadState: 'error',
      error: error instanceof Error ? error.message : 'Check failed',
    }
  } finally {
    // Restore previous autoDownload setting
    autoUpdater.autoDownload = previousAutoDownload
  }

  return getUpdateInfo()
}

/**
 * Install the downloaded update and restart the app.
 * Calls electron-updater's quitAndInstall which handles:
 * - macOS: Extracts zip and swaps app bundle
 * - Windows: Runs NSIS installer silently
 * - Linux: Replaces AppImage file
 * Then relaunches the app automatically.
 */
export async function installUpdate(): Promise<void> {
  // Entry point 2 of 3: the app menu's "Install Update", the debug menu's, the
  // renderer's Restart action (RPC_CHANNELS.update.INSTALL) and the update
  // toast. Checked BEFORE the readiness guard, because a download staged before
  // the policy arrived is exactly the case this has to refuse.
  if (inAppUpdatesDisabledByPolicy()) {
    autoUpdateLog.info('Update install refused: in-app updates disabled by managed policy')
    throw new Error('In-app updates are disabled by a managed policy')
  }

  if (updateInfo.downloadState !== 'ready') {
    throw new Error('No update ready to install')
  }

  autoUpdateLog.info('Installing update and restarting...')

  updateInfo = { ...updateInfo, downloadState: 'installing' }
  broadcastUpdateInfo()

  // Clear dismissed version since user is explicitly updating
  clearDismissedUpdateVersion()

  // Set flag to prevent force exit from breaking electron-updater's shutdown sequence
  __isUpdating = true

  // Diagnostic correlation with before-quit's [update-flow] log. If these
  // window counts diverge, electron-updater is destroying windows between
  // here and before-quit firing — confirms the multi-window restore bug.
  autoUpdateLog.info('installUpdate pre-quit', {
    electronWindowCount: BrowserWindow.getAllWindows().length,
    downloadState: updateInfo.downloadState,
    latestVersion: updateInfo.latestVersion,
  })

  // Snapshot window state BEFORE quitAndInstall — electron-updater destroys
  // BrowserWindows between this call and before-quit firing, so the regular
  // before-quit save would clobber window-state.json with an empty array.
  try {
    beforeUpdateQuitHook?.()
  } catch (err) {
    autoUpdateLog.error('beforeUpdateQuit hook failed', err)
  }

  try {
    // isSilent=false shows the installer UI on Windows if needed (fallback)
    // isForceRunAfter=true ensures the app relaunches after install
    autoUpdater.quitAndInstall(false, true)
  } catch (error) {
    __isUpdating = false
    autoUpdateLog.error('quitAndInstall failed', error)
    updateInfo = { ...updateInfo, downloadState: 'error' }
    broadcastUpdateInfo()
    throw error
  }
}

/**
 * Result of update check on launch
 */
export interface UpdateOnLaunchResult {
  action: 'none' | 'skipped' | 'ready' | 'downloading'
  reason?: string
  version?: string | null
}

/**
 * Check for updates on app launch.
 * - Checks immediately (no delay)
 * - Respects dismissed version (skips notification but allows manual check)
 * - Auto-downloads if update available
 */
export async function checkForUpdatesOnLaunch(): Promise<UpdateOnLaunchResult> {
  // Entry point 3 of 3: the only one with no user behind it. Gated here as well
  // as inside checkForUpdates so the launch path is a single early return that
  // logs its own reason — `reason: 'managed'` is what distinguishes it from
  // `'dismissed'` in the same result shape.
  if (inAppUpdatesDisabledByPolicy()) {
    autoUpdateLog.info('Launch update check refused: in-app updates disabled by managed policy')
    return { action: 'skipped', reason: 'managed' }
  }

  autoUpdateLog.info('Checking for updates on launch...')

  const info = await checkForUpdates({ autoDownload: true })

  if (!info.available) {
    return { action: 'none' }
  }

  // Check if this version was dismissed by user
  const dismissedVersion = getDismissedUpdateVersion()
  if (dismissedVersion === info.latestVersion) {
    mainLog.info(`[auto-update] Update ${info.latestVersion} was dismissed, skipping notification`)
    return { action: 'skipped', reason: 'dismissed', version: info.latestVersion }
  }

  if (info.downloadState === 'ready') {
    return { action: 'ready', version: info.latestVersion }
  }

  // Download in progress — will notify when ready via update-downloaded event
  return { action: 'downloading', version: info.latestVersion }
}
