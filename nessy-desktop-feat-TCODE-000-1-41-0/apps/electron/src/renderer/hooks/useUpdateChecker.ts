/**
 * Update Checker Hook
 *
 * Manages auto-update state for the Electron app.
 * - Listens for update availability broadcasts from main process
 * - Tracks download progress
 * - Provides methods to check for updates and install
 * - Shows toast notification when update is ready
 * - Persistent dismissal across app restarts (per version)
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { UpdateInfo } from '../../shared/types'

interface UseUpdateCheckerResult {
  /** Current update info */
  updateInfo: UpdateInfo | null
  /** Whether an update is available */
  updateAvailable: boolean
  /** Whether update is currently downloading */
  isDownloading: boolean
  /** Whether update is ready to install */
  isReadyToInstall: boolean
  /** Download progress (0-100) */
  downloadProgress: number
  /** Check for updates manually */
  checkForUpdates: () => Promise<void>
  /** Install the downloaded update and restart */
  installUpdate: () => Promise<void>
}

// Toast ID for update notification (allows dismiss/update)
const UPDATE_TOAST_ID = 'update-available'

/**
 * What a completed "Check for updates" actually FOUND — P2.7 clause (a).
 *
 * P2.10's gate reports a managed refusal as `available: false`, which is
 * byte-identical to an app that is genuinely up to date, and this hook read only
 * `available`. So the one user-visible consequence of an organization forbidding
 * in-app updates was a green "You're up to date" toast — the app answering a
 * question it had refused to ask. `managedDisabled` is the ONE field that
 * separates the two (the same reasoning `isUpdatesManagedOff` gives on the
 * settings page), and it has to be read FIRST, because every other branch here
 * is a statement about a feed nothing contacted.
 *
 * Extracted and exported rather than inlined for the reason
 * `isUpdatesManagedOff` is: `bun test` has no DOM, so the rule that decides what
 * the user is told is tested as a function and its wiring pinned by source
 * match.
 */
export type UpdateCheckOutcome = 'managed' | 'up-to-date' | 'ready' | 'pending'

export function classifyUpdateCheckOutcome(info: UpdateInfo | null | undefined): UpdateCheckOutcome {
  if (!info) return 'pending'
  if (info.managedDisabled === true) return 'managed'
  if (!info.available) return 'up-to-date'
  if (info.downloadState === 'ready' && info.latestVersion) return 'ready'
  return 'pending'
}

export function useUpdateChecker(): UseUpdateCheckerResult {
  const { t } = useTranslation()
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  // Track if we've shown the toast for this version to avoid duplicates
  const shownToastVersionRef = useRef<string | null>(null)

  // Show toast notification when update is ready
  const showUpdateToast = useCallback((version: string, onInstall: () => void) => {
    // Don't show if already shown for this version in this session
    if (shownToastVersionRef.current === version) {
      return
    }
    shownToastVersionRef.current = version

    toast.info(t('toast.updateReady', { version }), {
      id: UPDATE_TOAST_ID,
      description: t('toast.restartToApply'),
      duration: 10000, // 10 seconds, then auto-dismiss
      action: {
        label: t('toast.restart'),
        onClick: onInstall,
      },
      onDismiss: () => {
        // Persist dismissal so we don't show again after app restart
        window.electronAPI.dismissUpdate(version)
      },
    })
  }, [t])

  // Install the update
  const installUpdate = useCallback(async () => {
    try {
      // Dismiss the update toast first
      toast.dismiss(UPDATE_TOAST_ID)
      toast.info(t('toast.installingUpdate'), {
        description: t('toast.appWillRestart'),
        duration: 5000,
      })
      await window.electronAPI.installUpdate()
    } catch (error) {
      console.error('[useUpdateChecker] Install failed:', error)
      toast.error(t('toast.failedToInstallUpdate'), {
        description: error instanceof Error ? error.message : 'Unknown error',
      })
    }
  }, [])

  // Load initial state and check if update ready
  useEffect(() => {
    const checkAndNotify = async (info: UpdateInfo) => {
      if (!info.available || !info.latestVersion) return
      if (info.downloadState !== 'ready') return

      // Check if this version was dismissed
      const dismissedVersion = await window.electronAPI.getDismissedUpdateVersion()
      if (dismissedVersion === info.latestVersion) {
        return
      }

      // Show toast for ready update
      showUpdateToast(info.latestVersion, installUpdate)
    }

    // Get initial update info
    window.electronAPI.getUpdateInfo().then((info) => {
      setUpdateInfo(info)
      checkAndNotify(info)
    })

    // Subscribe to update availability changes
    const cleanupAvailable = window.electronAPI.onUpdateAvailable((info) => {
      setUpdateInfo(info)
      checkAndNotify(info)
    })

    // Subscribe to download progress updates
    const cleanupProgress = window.electronAPI.onUpdateDownloadProgress((progress) => {
      setUpdateInfo((prev) => prev ? { ...prev, downloadProgress: progress } : prev)
    })

    return () => {
      cleanupAvailable()
      cleanupProgress()
    }
  }, [showUpdateToast, installUpdate])

  // Check for updates manually
  const checkForUpdates = useCallback(async () => {
    try {
      const info = await window.electronAPI.checkForUpdates()
      setUpdateInfo(info)

      const outcome = classifyUpdateCheckOutcome(info)
      if (outcome === 'managed') {
        // The precedent's SENTENCE, not a "Managed" label — the same string the
        // settings page renders, so the two surfaces say one thing.
        toast.info(t('settings.about.updatesManaged'), { duration: 5000 })
      } else if (outcome === 'up-to-date') {
        toast.success(t('toast.upToDate'), {
          description: t('toast.versionIsLatest', { version: info.currentVersion }),
          duration: 3000,
        })
      } else if (outcome === 'ready' && info.latestVersion) {
        // If already ready, show toast (clear any previous dismissal since user explicitly checked)
        shownToastVersionRef.current = null // Reset so toast can show again
        showUpdateToast(info.latestVersion, installUpdate)
      }
    } catch (error) {
      console.error('[useUpdateChecker] Check failed:', error)
      toast.error(t('toast.failedToCheckUpdates'), {
        description: error instanceof Error ? error.message : 'Unknown error',
      })
    }
  }, [showUpdateToast, installUpdate])

  return {
    updateInfo,
    updateAvailable: updateInfo?.available ?? false,
    isDownloading: updateInfo?.downloadState === 'downloading',
    isReadyToInstall: updateInfo?.downloadState === 'ready',
    downloadProgress: updateInfo?.downloadProgress ?? 0,
    checkForUpdates,
    installUpdate,
  }
}
