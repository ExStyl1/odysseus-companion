/**
 * UB7.4 — ported from craft-agents-oss `v0.15.1:apps/electron/src/renderer/components/RtkUpdateDialog.tsx`
 * (Apache-2.0) with the OQ-43.8 (b) divergences: NO installer command —
 * upstream's `<pre>` with the update command, its Copy button and the
 * `rtkUpdate.cop*` keys stay out, and the instructions say to update rtk the
 * way the user installed it; RtkStatusInfo carries no `updateCommand` (the
 * detector never ports the installer constant either). Classes per R6-14:
 * `text-label`/`text-secondary`/`text-tertiary`; Later = ghost, Recheck =
 * primary (our `default` variant). The dismissed-version key is
 * upstream's `craft:rtk-update-dismissed` localStorage key, re-homed per our
 * no-localstorage rule to preferences.json (`rtkUpdateDismissedVersion`), read
 * and written through the existing preferences IPC (read-merge-write preserves
 * the rest of the file).
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useRegisterModal } from '@/context/ModalContext'

export interface RtkStatusInfo {
  installed: boolean
  path: string | null
  version: string | null
  outdated: boolean
  minSafeVersion: string
  foundPath: string | null
}

/** A dismissed version is not prompted again (a newer outdated one would be). */
const DISMISSED_PREFERENCE_KEY = 'rtkUpdateDismissedVersion'

async function readDismissedVersion(): Promise<string | null> {
  try {
    const { content } = await window.electronAPI.readPreferences()
    const parsed = JSON.parse(content ?? '{}') as { rtkUpdateDismissedVersion?: string }
    return parsed.rtkUpdateDismissedVersion ?? null
  } catch {
    return null
  }
}

async function writeDismissedVersion(version: string): Promise<void> {
  try {
    const { content } = await window.electronAPI.readPreferences()
    const parsed = JSON.parse(content ?? '{}') as Record<string, unknown>
    parsed[DISMISSED_PREFERENCE_KEY] = version
    await window.electronAPI.writePreferences(JSON.stringify(parsed, null, 2))
  } catch {
    // Best-effort marker: a failure only means the prompt may re-open.
  }
}

interface RtkUpdateDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  status: RtkStatusInfo
  /** Called with the fresh status after Re-check. */
  onStatusChange?: (status: RtkStatusInfo) => void
  /** "Later" remembers the version so the automatic prompt stays quiet. */
  onDismiss?: () => void
}

export function RtkUpdateDialog({ open, onOpenChange, status, onStatusChange, onDismiss }: RtkUpdateDialogProps) {
  const { t } = useTranslation()
  const [rechecking, setRechecking] = React.useState(false)
  useRegisterModal(open, () => onOpenChange(false))

  const recheck = React.useCallback(async () => {
    setRechecking(true)
    try {
      const fresh = await window.electronAPI?.getRtkStatus({ forceRecheck: true })
      if (!fresh) return
      onStatusChange?.(fresh)
      if (!fresh.outdated) {
        toast.success(t('rtkUpdate.updated', { version: fresh.version ?? '' }))
        onOpenChange(false)
      } else {
        toast.error(t('rtkUpdate.stillOutdated', { version: fresh.version ?? '' }))
      }
    } finally {
      setRechecking(false)
    }
  }, [onOpenChange, onStatusChange, t])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="text-label">{t('rtkUpdate.title')}</DialogTitle>
          <DialogDescription className="text-secondary">
            {t('rtkUpdate.body', { version: status.version ?? '?', min: status.minSafeVersion })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 text-label">
          <p className="text-secondary">{t('rtkUpdate.instructions')}</p>
          {status.foundPath && (
            <p className="text-label-sm text-tertiary">{t('rtkUpdate.foundAt', { path: status.foundPath })}</p>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => { onDismiss?.(); onOpenChange(false) }}
          >
            {t('rtkUpdate.later')}
          </Button>
          <Button variant="default" onClick={() => { void recheck() }} disabled={rechecking}>
            {rechecking ? t('common.checking') : t('rtkUpdate.recheck')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Opens the update dialog once per outdated rtk version while Token Optimization
 * is on. Checks on mount and when the workspace (and so possibly the server) changes.
 */
export function RtkUpdatePrompt({ workspaceId }: { workspaceId?: string | null }) {
  const [status, setStatus] = React.useState<RtkStatusInfo | null>(null)
  const [open, setOpen] = React.useState(false)

  React.useEffect(() => {
    if (!workspaceId || typeof window.electronAPI?.getRtkStatus !== 'function') return
    let cancelled = false
    void (async () => {
      try {
        const [enabled, current, dismissed] = await Promise.all([
          window.electronAPI.getRtkEnabled(),
          window.electronAPI.getRtkStatus(),
          readDismissedVersion(),
        ])
        if (cancelled || !enabled || !current.outdated) return
        if (dismissed === current.version) return
        setStatus(current)
        setOpen(true)
      } catch (error) {
        console.error('[RtkUpdatePrompt] Failed to check rtk status:', error)
      }
    })()
    return () => { cancelled = true }
  }, [workspaceId])

  if (!status) return null
  return (
    <RtkUpdateDialog
      open={open}
      onOpenChange={setOpen}
      status={status}
      onStatusChange={setStatus}
      onDismiss={() => { if (status.version) void writeDismissedVersion(status.version) }}
    />
  )
}
