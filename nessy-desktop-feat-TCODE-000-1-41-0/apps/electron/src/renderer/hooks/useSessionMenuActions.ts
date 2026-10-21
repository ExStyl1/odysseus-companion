/**
 * useSessionMenuActions
 *
 * Single source of truth for session-menu side effects (share / refresh title /
 * copy path / show in finder / open in new panel / share-submenu actions / label
 * toggle). Consumed by both `SessionMenu` (desktop dropdown / context menu) and
 * `CompactSessionMenu` (compact-mode drawer) so a new session action only has
 * to be wired through one place.
 *
 * Also owns **optimistic label state**: the parent's labels-changed pipeline
 * (`onLabelsChange` → IPC → server → `labels_changed` event → atom → re-render)
 * is asynchronous, so a fast second tap that derived from the prop's stale
 * `item.labels` would compute against an out-of-date snapshot and could
 * overwrite the first tap's update. The hook keeps a local optimistic copy
 * mirrored in a `useRef` so toggles read the latest value synchronously
 * (without going through React's update queue, which would be impure under
 * Strict Mode and could double-fire `onLabelsChange`). Prop sync only runs
 * when the server has acknowledged our latest local change (tracked via
 * `lastSentKeyRef`) — avoids a brief checkmark-flash without needing a full
 * request-tracking layer. State is hard-reset when `item.id` changes so
 * pending optimistic state from a previous session can't leak into a new one.
 *
 * Pure label-mutation logic lives in `@nessy-agent/shared/labels`
 * (`toggleLabelInList`) and is unit-tested there.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { navigate, routes } from '@/lib/navigate'
import { extractLabelId, toggleLabelInList } from '@nessy-agent/shared/labels'
import type { FileCheckpointRevertResult } from '@nessy-agent/shared/protocol'
import { distinctSkipReasonKeys } from '@/utils/checkpoint-skip'
import { fileCheckpointsUntracked } from '@/utils/rewind-report'
import type { SessionMeta } from '@/atoms/sessions'

export interface UseSessionMenuActionsOptions {
  item: SessionMeta
  onLabelsChange?: (labels: string[]) => void
}

export interface SessionMenuActions {
  /** Set of base label IDs currently applied (optimistic). */
  appliedLabelIds: Set<string>
  /** Toggle a label (add if absent, remove all entries with this base ID if present). */
  toggleLabel: (labelId: string) => void
  share: () => Promise<void>
  showInFinder: () => void
  copyPath: () => Promise<void>
  refreshTitle: () => Promise<void>
  openInNewPanel: () => void
  /** Open the session's published share URL in the system browser (no-op if not shared). */
  openSharedInBrowser: () => void
  /** Copy the session's published share URL to the clipboard (no-op if not shared). */
  copySharedLink: () => Promise<void>
  /** Re-publish the share to bump the snapshot. */
  updateShare: () => Promise<void>
  /** Revoke the share. */
  revokeShare: () => Promise<void>
  /** Revert the latest captured file checkpoint. */
  revertFileCheckpoint: () => Promise<void>
}

// SOH (U+0001) — non-printable so it can't collide with label IDs (which
// validate to [a-z0-9-]) or values (which may themselves contain '::').
const LABEL_KEY_SEPARATOR = String.fromCharCode(1)

function joinLabelKey(labels: readonly string[] | undefined): string {
  return (labels ?? []).join(LABEL_KEY_SEPARATOR)
}

export function useSessionMenuActions({
  item,
  onLabelsChange,
}: UseSessionMenuActionsOptions): SessionMenuActions {
  const { t, i18n } = useTranslation()
  const sessionId = item.id
  const sharedUrl = item.sharedUrl
  const propLabels = item.labels

  const [optimisticLabels, setOptimisticLabels] = React.useState<string[]>(() => propLabels ?? [])
  // Mirror of `optimisticLabels` so toggles can read the latest value
  // synchronously without going through React's update queue. Reading from
  // a state-updater callback would be impure (Strict Mode can invoke updaters
  // twice in dev), which would double-fire onLabelsChange.
  const optimisticLabelsRef = React.useRef<string[]>(propLabels ?? [])
  const propKey = React.useMemo(() => joinLabelKey(propLabels), [propLabels])
  const lastSentKeyRef = React.useRef<string | null>(null)

  // Hard-reset on session change so optimistic state from a previous session
  // cannot leak into a new one (e.g. user toggles `bug` on session A, navigates
  // to B before the IPC ACK — without this reset, lastSentKeyRef would block
  // the prop sync and B would briefly render A's labels).
  React.useEffect(() => {
    const next = propLabels ?? []
    optimisticLabelsRef.current = next
    lastSentKeyRef.current = null
    setOptimisticLabels(next)
    // Intentionally only depending on sessionId — propLabels changes within
    // the same session are handled by the prop-sync effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  React.useEffect(() => {
    // Sync from prop only when the server has caught up to (or surpassed)
    // our last sent value — otherwise an in-flight prop update would briefly
    // erase a queued local toggle. lastSentKeyRef === null means we have
    // no pending local changes, so the prop is authoritative.
    if (lastSentKeyRef.current === null || lastSentKeyRef.current === propKey) {
      const next = propLabels ?? []
      optimisticLabelsRef.current = next
      setOptimisticLabels(next)
      lastSentKeyRef.current = null
    }
  }, [propKey, propLabels])

  const appliedLabelIds = React.useMemo(
    () => new Set(optimisticLabels.map(extractLabelId)),
    [optimisticLabels],
  )

  const toggleLabel = React.useCallback((labelId: string) => {
    if (!onLabelsChange) return
    // Read the canonical latest value from the ref, mutate refs, fire the
    // callback, and only THEN call setState. All side effects happen outside
    // any state-updater callback so they fire exactly once per user tap
    // even under Strict Mode's double-render checks.
    const next = toggleLabelInList(optimisticLabelsRef.current, labelId)
    optimisticLabelsRef.current = next
    lastSentKeyRef.current = joinLabelKey(next)
    setOptimisticLabels(next)
    onLabelsChange(next)
  }, [onLabelsChange])

  const share = React.useCallback(async () => {
    const result = await window.electronAPI.sessionCommand(sessionId, { type: 'shareToViewer' }) as ShareResult | undefined
    // UA1.26 — the toast names the link AND its expiry; a declined card toasts nothing (`share-result-toast.ts`).
    const view = shareToastView('share', result)
    if (result?.success && result.url) {
      await navigator.clipboard.writeText(result.url)
      const url = result.url
      showShareToast(view, t, i18n.language, {
        label: t('common.open'),
        onClick: () => window.electronAPI.openUrl(url),
      })
    } else {
      showShareToast(view, t, i18n.language)
    }
  }, [sessionId, t, i18n.language])

  const showInFinder = React.useCallback(() => {
    void window.electronAPI.revealSessionStorage({ sessionId, workspaceId: item.workspaceId })
  }, [item.workspaceId, sessionId])

  const copyPath = React.useCallback(async () => {
    await window.electronAPI.copySessionStoragePath({ sessionId, workspaceId: item.workspaceId })
    toast.success(t('toast.pathCopied'))
  }, [item.workspaceId, sessionId, t])

  const refreshTitle = React.useCallback(async () => {
    const result = await window.electronAPI.sessionCommand(sessionId, { type: 'refreshTitle' }) as { success: boolean; title?: string; error?: string } | undefined
    if (result?.success) {
      toast.success(t('toast.titleRefreshed'), { description: result.title })
    } else {
      toast.error(t('toast.failedToRefreshTitle'), { description: result?.error || t('toast.unknownError') })
    }
  }, [sessionId, t])

  const openInNewPanel = React.useCallback(() => {
    navigate(routes.view.allSessions(sessionId), { newPanel: true })
  }, [sessionId])

  const openSharedInBrowser = React.useCallback(() => {
    if (!sharedUrl) return
    window.electronAPI.openUrl(sharedUrl)
  }, [sharedUrl])

  const copySharedLink = React.useCallback(async () => {
    if (!sharedUrl) return
    await navigator.clipboard.writeText(sharedUrl)
    toast.success(t('toast.linkCopied'))
  }, [sharedUrl, t])

  const updateShare = React.useCallback(async () => {
    // UA1.26 — the card again (UA1.25), then one PUT to the same link. The toast names the link and its
    // expiry; a declined card toasts nothing; a failure leaves the shared state as it was. The wording lives
    // in `share-result-toast.ts`; the chat header's Share button (`ChatShareMenu`) runs this hook too since
    // UB14.6, so the session menus and the header say the same thing.
    const result = await window.electronAPI.sessionCommand(sessionId, { type: 'updateShare' }) as ShareResult | undefined
    showShareToast(shareToastView('update', result), t, i18n.language)
    // (no other state here: the host's session_shared / session_unshared events move the menu)
  }, [sessionId, t, i18n.language])

  const revokeShare = React.useCallback(async () => {
    // UA1.26 — one DELETE (UA1.25), no card. A DELETE that could not be sent now is kept as a pending
    // deletion and retried (Published pages), so the share is cleared and the toast is a warning saying so;
    // any other failure keeps the share as it was. The wording lives in `share-result-toast.ts`, read by
    // both share surfaces, so the session menus and the chat header say the same thing.
    const result = await window.electronAPI.sessionCommand(sessionId, { type: 'revokeShare' }) as ShareResult | undefined
    showShareToast(shareToastView('revoke', result), t, i18n.language)
    // (no other state here: the host's session_unshared event moves the menu back to Share)
  }, [sessionId, t, i18n.language])

  const revertFileCheckpoint = React.useCallback(async () => {
    const result = await window.electronAPI.sessionCommand(sessionId, { type: 'revertFileCheckpoint' }) as FileCheckpointRevertResult | undefined
    if (result?.success) {
      toast.success(t(result.deleted ? 'toast.fileCheckpointDeleted' : 'toast.fileCheckpointReverted'), {
        description: result.filePath,
      })
    } else if (result?.skippedLinks) {
      // A link-safety refusal is not a failure of ours — it is a fact about the
      // path. Name the path and the reason so the user can act on it instead of
      // discovering the file is unchanged from a diff later.
      const reasonKeys = distinctSkipReasonKeys(result.skippedPaths)
      toast.warning(t('toast.fileCheckpointSkipped'), {
        description: t('toast.fileCheckpointSkippedDescription', {
          path: result.filePath ?? '',
          reason: reasonKeys.map(key => t(key)).join('; '),
        }),
      })
    } else if (fileCheckpointsUntracked(result)) {
      // Not a failure and not a "try again later": this session's runtime never
      // checkpoints an edit, so the menu entry can never do anything here. The
      // bare "No file checkpoint found" invited the user to make an edit and
      // retry, which would land in exactly the same place.
      toast.warning(t('toast.fileCheckpointsNotTracked'), {
        description: t('toast.fileCheckpointsNotTrackedDescription'),
      })
    } else {
      toast.error(t('toast.failedToRevertFileCheckpoint'), {
        description: result?.error || t('toast.unknownError'),
      })
    }
  }, [sessionId, t])

  return {
    appliedLabelIds,
    toggleLabel,
    share,
    showInFinder,
    copyPath,
    refreshTitle,
    openInNewPanel,
    openSharedInBrowser,
    copySharedLink,
    updateShare,
    revokeShare,
    revertFileCheckpoint,
  }
}

// UA1.26 — imported at the end: this file is cited by line in the docs (to line 221), so a new import line at the
// top would move those anchors (AGENTS.md "hot files"). An ES import is hoisted wherever it is written.
import type { ShareResult } from '@nessy-agent/shared/protocol'
import { shareToastView, showShareToast } from './share-result-toast'
