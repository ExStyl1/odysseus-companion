/**
 * Auto-update module using electron-updater
 *
 * Auto-update is enabled only for packaged builds whose active brand declares
 * a brand-owned update source. Development builds keep the same public API but
 * skip network update checks.
 *
 * Platform behavior:
 * - macOS: Downloads zip, extracts and swaps app bundle atomically
 * - Windows: Downloads NSIS installer, runs silently on quit
 * - Linux: Downloads AppImage, replaces current file
 *
 * All platforms support download-progress events (electron-updater v6.8.0+).
 * quitAndInstall() handles restart natively — no external scripts.
 */

import { autoUpdater, type UpdateDownloadedEvent, type UpdateInfo as ElectronUpdateInfo } from 'electron-updater'
import { app, net } from 'electron'
import { platform } from 'os'
import * as path from 'path'
import * as fs from 'fs'
import { load as loadYaml } from 'js-yaml'
import { mainLog } from './logger'
import { getCurrentMacCodeSignatureStatus, verifyMacUpdateArchive } from './auto-update-signature'
import { verifyDetachedFile, verifyDetachedText } from './linux-update-signature'
import { showUpdateNotification } from './notifications'
import { getAppVersion } from '@craft-agent/shared/version'
import { BRAND } from '@craft-agent/shared/branding'
import { getDismissedUpdateVersion, clearDismissedUpdateVersion } from '@craft-agent/shared/config'
import { readJsonFileSync } from '@craft-agent/shared/utils/files'
import { RPC_CHANNELS, type UpdateInfo } from '../shared/types'
import type { EventSink } from '@craft-agent/server-core/transport'

// Platform detection
const PLATFORM = platform()
const IS_MAC = PLATFORM === 'darwin'
const IS_WINDOWS = PLATFORM === 'win32'
const IS_LINUX = PLATFORM === 'linux'
const UPDATE_SOURCE = BRAND.updates

interface AutoUpdateCapability {
  enabled: boolean
  reason?: 'development' | 'unconfigured' | 'mac-code-signature' | 'linux-signature'
  message?: string
  details?: Record<string, unknown>
}

let autoUpdateCapability: AutoUpdateCapability | null = null
let updaterCacheDirName: string | null = null

function getAutoUpdateCapability(): AutoUpdateCapability {
  if (autoUpdateCapability) return autoUpdateCapability

  if (!app.isPackaged) {
    autoUpdateCapability = { enabled: false, reason: 'development' }
    return autoUpdateCapability
  }

  if (!UPDATE_SOURCE) {
    autoUpdateCapability = { enabled: false, reason: 'unconfigured' }
    return autoUpdateCapability
  }

  if (IS_MAC) {
    const signature = getCurrentMacCodeSignatureStatus(app.getPath('exe'))
    if (!signature.trustedForAutoUpdate) {
      autoUpdateCapability = {
        enabled: false,
        reason: 'mac-code-signature',
        message:
          'macOS auto-update requires a non-ad-hoc Developer ID signature. Install a signed release build to use automatic updates.',
        details: {
          appBundlePath: signature.appBundlePath,
          identifier: signature.identifier,
          signature: signature.signature,
          teamIdentifier: signature.teamIdentifier,
          signatureReason: signature.reason,
        },
      }
      return autoUpdateCapability
    }

    mainLog.info('[auto-update] macOS code signature accepted for updates', {
      appBundlePath: signature.appBundlePath,
      teamIdentifier: signature.teamIdentifier,
    })
  }

  if (IS_LINUX && BRAND.id !== 'nessy-cli') {
    autoUpdateCapability = {
      enabled: false,
      reason: 'linux-signature',
      message: 'Linux auto-update requires a brand-owned release signing key.',
    }
    return autoUpdateCapability
  }

  autoUpdateCapability = { enabled: true }
  return autoUpdateCapability
}

function getUpdaterCacheDirName(): string {
  if (updaterCacheDirName) return updaterCacheDirName

  const fallback = `${app.getName()}-updater`
  try {
    const updateConfigPath = app.isPackaged
      ? path.join(process.resourcesPath, 'app-update.yml')
      : path.join(app.getAppPath(), 'dev-app-update.yml')
    const updateConfig = fs.readFileSync(updateConfigPath, 'utf8')
    const match = updateConfig.match(/^updaterCacheDirName:\s*['"]?([^'"\n]+)['"]?\s*$/m)
    updaterCacheDirName = match?.[1]?.trim() || fallback
  } catch {
    updaterCacheDirName = fallback
  }

  return updaterCacheDirName
}

// Get the update cache directory path (for file watcher fallback on macOS)
// electron-updater uses these paths:
// - Windows: %LOCALAPPDATA%/{appName}-updater/pending
// - macOS: ~/Library/Caches/{appName}-updater/pending
// - Linux: ~/.cache/{appName}-updater/pending
function getUpdateCacheDir(): string {
  const cacheDirName = getUpdaterCacheDirName()
  if (IS_MAC) {
    return path.join(app.getPath('home'), 'Library', 'Caches', cacheDirName, 'pending')
  } else if (IS_WINDOWS) {
    // Windows uses LOCALAPPDATA, not APPDATA (roaming)
    const localAppData = process.env.LOCALAPPDATA || path.join(app.getPath('home'), 'AppData', 'Local')
    return path.join(localAppData, cacheDirName, 'pending')
  } else {
    // Linux
    return path.join(app.getPath('home'), '.cache', cacheDirName, 'pending')
  }
}

// Module state — keeps track of update info for IPC queries
let updateInfo: UpdateInfo = {
  available: false,
  currentVersion: getAppVersion(),
  latestVersion: null,
  downloadState: 'idle',
  downloadProgress: 0,
}

let eventSink: EventSink | null = null

// Flag to indicate update is in progress — used to prevent force exit during quitAndInstall
let __isUpdating = false
let verifiedLinuxUpdate: {
  filePath: string
  signature: string
  publicKey: string
} | null = null

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
 * Get current update info (called by IPC handler)
 */
export function getUpdateInfo(): UpdateInfo {
  return { ...updateInfo }
}

/**
 * Broadcast update info to all renderer windows.
 * Creates a snapshot to avoid race conditions during broadcast.
 */
function broadcastUpdateInfo(): void {
  if (!eventSink) return

  const snapshot = { ...updateInfo }
  eventSink(RPC_CHANNELS.update.AVAILABLE, { to: 'all' }, snapshot)
}

/**
 * Broadcast download progress to all renderer windows.
 */
function broadcastDownloadProgress(progress: number): void {
  if (!eventSink) return

  eventSink(RPC_CHANNELS.update.DOWNLOAD_PROGRESS, { to: 'all' }, progress)
}

// ─── Configure electron-updater ───────────────────────────────────────────────

// Download updates only after checkForUpdates verifies this build can safely
// pass the platform updater validation.
autoUpdater.autoDownload = false
// [nessy-fork] desktop-linux-update-signing
autoUpdater.autoInstallOnAppQuit = false

// [nessy-fork] desktop-stable-update-channel
autoUpdater.channel = 'latest'
autoUpdater.allowPrerelease = false
autoUpdater.allowDowngrade = false

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

autoUpdater.on('update-available', async (info) => {
  mainLog.info(`[auto-update] Update available: ${updateInfo.currentVersion} → ${info.version}`)

  verifiedLinuxUpdate = null
  const downloadedUpdate = await validateDownloadedUpdate(info)
  if (downloadedUpdate.ready) {
    mainLog.info('[auto-update] A validated download is ready')
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

  if (downloadedUpdate.error) {
    updateInfo = {
      ...updateInfo,
      available: true,
      latestVersion: info.version,
      downloadState: 'error',
      error: downloadedUpdate.error,
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

  verifiedLinuxUpdate = null
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

autoUpdater.on('update-downloaded', async (info: UpdateDownloadedEvent) => {
  mainLog.info(`[auto-update] Update downloaded: v${info.version}`)

  const downloadedUpdate = await validateDownloadedUpdate(info, info.downloadedFile)
  if (!downloadedUpdate.ready) {
    const error = downloadedUpdate.error ?? 'Downloaded update file is unavailable'
    mainLog.error('[auto-update] Downloaded update rejected:', error)
    updateInfo = {
      ...updateInfo,
      available: true,
      latestVersion: info.version,
      downloadState: 'error',
      error,
    }
    broadcastUpdateInfo()
    return
  }

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
  mainLog.error('[auto-update] Error:', error.message)

  verifiedLinuxUpdate = null
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
function checkElectronUpdaterState(): { ready: boolean; filePath?: string } {
  try {
    // Access electron-updater's internal downloadedUpdateHelper
    // @ts-expect-error - accessing internal API for reliability
    const helper = autoUpdater.downloadedUpdateHelper
    if (helper) {
      mainLog.info(`[auto-update] downloadedUpdateHelper exists, cacheDir: ${helper.cacheDir}`)
      const filePath = helper.file as string | null
      if (filePath && fs.existsSync(filePath)) {
        mainLog.info(`[auto-update] electron-updater has a validated download: ${filePath}`)
        return { ready: true, filePath }
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
function checkForExistingDownload(): {
  exists: boolean
  version?: string
  filePath?: string
} {
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
    const updateInfoFile = files.find((f) => f === 'update-info.json')
    if (updateInfoFile) {
      const infoPath = path.join(cacheDir, updateInfoFile)
      const info = readJsonFileSync(infoPath) as Record<string, unknown> | null
      mainLog.info(`[auto-update] update-info.json contents: ${JSON.stringify(info)}`)

      // electron-updater uses 'fileName' (not 'path') in update-info.json
      const fileName = (info?.fileName || info?.path) as string | undefined
      const filePath = fileName ? path.join(cacheDir, fileName) : undefined
      if (filePath && fs.existsSync(filePath)) {
        mainLog.info(`[auto-update] Found existing download via update-info.json: ${fileName}`)
        return { exists: true, version: info?.version as string, filePath }
      }
    }

    // Fallback: check for any installer/zip/dmg file
    const downloadFile = files.find(
      (f) =>
        f.endsWith('.zip') ||
        f.endsWith('.exe') ||
        f.endsWith('.AppImage') ||
        f.endsWith('.dmg') ||
        f.endsWith('.nupkg'),
    )
    if (downloadFile) {
      mainLog.info(`[auto-update] Found existing download file: ${downloadFile}`)
      return { exists: true, filePath: path.join(cacheDir, downloadFile) }
    }

    mainLog.info(`[auto-update] No existing download found in cache`)
    return { exists: false }
  } catch (error) {
    mainLog.warn('[auto-update] Error checking for existing download:', error)
    return { exists: false }
  }
}

interface LinuxUpdateManifest {
  version?: unknown
  files?: Array<{ url?: unknown; sha512?: unknown }>
}

function linuxUpdateBaseUrl(): URL {
  if (!UPDATE_SOURCE || UPDATE_SOURCE.provider !== 'generic') {
    throw new Error('Linux update signatures require a generic update source')
  }
  return new URL(UPDATE_SOURCE.url.endsWith('/') ? UPDATE_SOURCE.url : `${UPDATE_SOURCE.url}/`)
}

async function fetchUpdateText(url: URL): Promise<string> {
  const maxBytes = 1024 * 1024
  const expectedOrigin = linuxUpdateBaseUrl().origin
  if (url.origin !== expectedOrigin) {
    throw new Error('Linux update signature URL has an unexpected origin')
  }

  const response = await net.fetch(url.toString(), {
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok || new URL(response.url).origin !== expectedOrigin) {
    throw new Error(`Linux update signature download failed (${response.status})`)
  }
  if (Number(response.headers.get('content-length')) > maxBytes || !response.body) {
    throw new Error('Linux update signature response is too large')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let size = 0
  let text = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) return text + decoder.decode()
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel()
      throw new Error('Linux update signature response is too large')
    }
    text += decoder.decode(value, { stream: true })
  }
}

function loadLinuxUpdatePublicKey(): string {
  return fs.readFileSync(path.join(__dirname, BRAND.assets.resourceDir, 'linux-update-public-key.asc'), 'utf8')
}

async function verifyLinuxUpdate(info: ElectronUpdateInfo, filePath: string): Promise<void> {
  if (!filePath.endsWith('.AppImage')) {
    throw new Error('Linux update is not an AppImage')
  }

  const baseUrl = linuxUpdateBaseUrl()
  const archSuffix = process.arch === 'x64' ? '' : `-${process.arch}`
  const manifestUrl = new URL(`latest-linux${archSuffix}.yml`, baseUrl)
  const manifestText = await fetchUpdateText(manifestUrl)
  const publicKey = loadLinuxUpdatePublicKey()
  await verifyDetachedText(
    manifestText,
    await fetchUpdateText(new URL(`${manifestUrl.pathname}.asc`, manifestUrl)),
    publicKey,
  )

  const manifest = loadYaml(manifestText) as LinuxUpdateManifest
  const downloadedName = path.basename(filePath)
  const manifestFile = manifest.files?.find((file) => {
    if (typeof file.url !== 'string') return false
    return path.posix.basename(new URL(file.url, baseUrl).pathname) === downloadedName
  })
  const updaterFile = info.files.find((file) => {
    return path.posix.basename(new URL(file.url, baseUrl).pathname) === downloadedName
  })
  if (
    manifest.version !== info.version ||
    !manifestFile ||
    !updaterFile ||
    manifestFile.sha512 !== updaterFile.sha512
  ) {
    throw new Error('Signed Linux update manifest does not match the downloaded update')
  }

  const artifactUrl = new URL(String(manifestFile.url), baseUrl)
  const signatureUrl = new URL(`${artifactUrl.pathname}.asc`, artifactUrl)
  const signature = await fetchUpdateText(signatureUrl)
  await verifyDetachedFile(filePath, signature, publicKey)
  verifiedLinuxUpdate = { filePath, signature, publicKey }
}

async function validateDownloadedUpdate(
  info?: ElectronUpdateInfo,
  candidatePath?: string,
): Promise<{ ready: boolean; error?: string }> {
  const internalState = checkElectronUpdaterState()
  const existing = candidatePath
    ? { exists: fs.existsSync(candidatePath), filePath: candidatePath }
    : internalState.ready
      ? { exists: true, filePath: internalState.filePath }
      : checkForExistingDownload()

  if (!existing.exists || !existing.filePath) return { ready: false }
  if (IS_WINDOWS) return { ready: true }

  if (IS_LINUX) {
    if (!info) {
      return { ready: false, error: 'Linux update metadata is unavailable' }
    }
    try {
      await verifyLinuxUpdate(info, existing.filePath)
      mainLog.info('[auto-update] Linux update signatures accepted', {
        filePath: existing.filePath,
      })
      return { ready: true }
    } catch (error) {
      verifiedLinuxUpdate = null
      mainLog.error('[auto-update] Linux update signature rejected', error)
      return {
        ready: false,
        error: 'Downloaded Linux update failed security verification',
      }
    }
  }

  if (!existing.filePath.endsWith('.zip')) {
    return { ready: false, error: 'macOS update is not a ZIP archive' }
  }

  const signature = verifyMacUpdateArchive(existing.filePath)
  if (!signature.trustedForAutoUpdate) {
    mainLog.error('[auto-update] macOS update signature rejected', signature)
    return {
      ready: false,
      error: 'Downloaded macOS update failed security verification',
    }
  }

  mainLog.info('[auto-update] macOS update signature accepted', {
    archivePath: existing.filePath,
    teamIdentifier: signature.appSignature?.teamIdentifier,
  })
  return { ready: true }
}

/**
 * Check for available updates.
 * Returns the current UpdateInfo state after check completes.
 *
 * @param options.autoDownload - If false, only checks without downloading (for manual "Check Now")
 */
export async function checkForUpdates(options: CheckOptions = {}): Promise<UpdateInfo> {
  const capability = getAutoUpdateCapability()
  if (!capability.enabled) {
    mainLog.info('[auto-update] Skipping update check', {
      packaged: app.isPackaged,
      brand: BRAND.id,
      hasUpdateSource: !!UPDATE_SOURCE,
      reason: capability.reason,
      details: capability.details,
    })

    const isUnsupportedPackagedBuild =
      capability.reason === 'mac-code-signature' || capability.reason === 'linux-signature'
    updateInfo = {
      available: false,
      currentVersion: getAppVersion(),
      latestVersion: null,
      downloadState: isUnsupportedPackagedBuild ? 'error' : 'idle',
      downloadProgress: 0,
      error: isUnsupportedPackagedBuild ? capability.message : undefined,
    }
    return getUpdateInfo()
  }

  const updateSource = UPDATE_SOURCE
  if (!updateSource) {
    throw new Error('Auto-update source is not configured')
  }

  const { autoDownload = true } = options
  mainLog.info('[auto-update] Checking stable release feed', {
    brand: BRAND.id,
    provider: updateSource.provider,
    ...(updateSource.provider === 'github'
      ? { owner: updateSource.owner, repo: updateSource.repo }
      : { url: updateSource.url }),
    autoDownload,
  })

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
      await new Promise((resolve) => setTimeout(resolve, 500))

      // Double-check: if we're still showing 'downloading' but file exists, update state
      if (updateInfo.downloadState === 'downloading') {
        const downloadedUpdate = await validateDownloadedUpdate(result.updateInfo)
        if (downloadedUpdate.ready) {
          mainLog.info('[auto-update] Update already downloaded, updating state to ready')
          updateInfo = {
            ...updateInfo,
            downloadState: 'ready',
            downloadProgress: 100,
          }
          broadcastUpdateInfo()
        } else if (downloadedUpdate.error) {
          updateInfo = {
            ...updateInfo,
            downloadState: 'error',
            error: downloadedUpdate.error,
          }
          broadcastUpdateInfo()
        }
      }
    }
  } catch (error) {
    mainLog.error('[auto-update] Check failed:', error)
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
  const capability = getAutoUpdateCapability()
  if (!capability.enabled) {
    throw new Error(capability.message ?? 'Auto-update is not available for this build')
  }

  if (updateInfo.downloadState !== 'ready') {
    throw new Error('No update ready to install')
  }

  if (IS_LINUX) {
    if (!verifiedLinuxUpdate) {
      throw new Error('Linux update signature has not been verified')
    }
    try {
      const updaterState = checkElectronUpdaterState()
      if (
        !updaterState.ready ||
        !updaterState.filePath ||
        path.resolve(updaterState.filePath) !== path.resolve(verifiedLinuxUpdate.filePath)
      ) {
        throw new Error('Verified Linux update does not match the pending installer')
      }
      await verifyDetachedFile(
        verifiedLinuxUpdate.filePath,
        verifiedLinuxUpdate.signature,
        verifiedLinuxUpdate.publicKey,
      )
    } catch (error) {
      verifiedLinuxUpdate = null
      updateInfo = {
        ...updateInfo,
        downloadState: 'error',
        error: 'Downloaded Linux update failed security verification',
      }
      broadcastUpdateInfo()
      throw error
    }
  }

  mainLog.info('[auto-update] Installing update and restarting...')

  updateInfo = { ...updateInfo, downloadState: 'installing' }
  broadcastUpdateInfo()

  // Clear dismissed version since user is explicitly updating
  clearDismissedUpdateVersion()

  // Set flag to prevent force exit from breaking electron-updater's shutdown sequence
  __isUpdating = true

  try {
    // isSilent=false shows the installer UI on Windows if needed (fallback)
    // isForceRunAfter=true ensures the app relaunches after install
    autoUpdater.quitAndInstall(false, true)
  } catch (error) {
    __isUpdating = false
    mainLog.error('[auto-update] quitAndInstall failed:', error)
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
  const capability = getAutoUpdateCapability()
  if (!capability.enabled) {
    mainLog.info('[auto-update] Skipping launch update check', {
      packaged: app.isPackaged,
      brand: BRAND.id,
      hasUpdateSource: !!UPDATE_SOURCE,
      reason: capability.reason,
      details: capability.details,
    })
    return {
      action: 'skipped',
      reason:
        capability.reason === 'mac-code-signature' || capability.reason === 'linux-signature'
          ? capability.reason
          : app.isPackaged
            ? 'unconfigured'
            : 'development',
    }
  }

  const updateSource = UPDATE_SOURCE
  if (!updateSource) {
    throw new Error('Auto-update source is not configured')
  }

  mainLog.info('[auto-update] Checking for updates on launch...', {
    brand: BRAND.id,
    provider: updateSource.provider,
    ...(updateSource.provider === 'github'
      ? { owner: updateSource.owner, repo: updateSource.repo }
      : { url: updateSource.url }),
  })

  const info = await checkForUpdates({ autoDownload: true })

  if (!info.available) {
    return { action: 'none' }
  }

  // Check if this version was dismissed by user
  const dismissedVersion = getDismissedUpdateVersion()
  if (dismissedVersion === info.latestVersion) {
    mainLog.info(`[auto-update] Update ${info.latestVersion} was dismissed, skipping notification`)
    return {
      action: 'skipped',
      reason: 'dismissed',
      version: info.latestVersion,
    }
  }

  // [nessy-fork] desktop-update-notification
  if (info.latestVersion) {
    showUpdateNotification(info.latestVersion)
  }

  if (info.downloadState === 'ready') {
    return { action: 'ready', version: info.latestVersion }
  }

  return { action: 'downloading', version: info.latestVersion }
}
