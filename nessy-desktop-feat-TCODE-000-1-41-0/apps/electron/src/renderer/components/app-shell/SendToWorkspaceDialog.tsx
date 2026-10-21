/**
 * SendToWorkspaceDialog — Transfer sessions to another workspace.
 *
 * Shows a picker over every other workspace (`getTransferTargets`, UA1.14, as
 * v0.13.4 since v0.11.2): remote targets are pushed to over an outbound WS
 * connection (chunked for large bundles), local targets import in-process — which
 * is also how a session moves from a remote workspace back to this machine.
 * Remote workspaces without a saved credential are shown as disabled with a
 * CloudOff icon; local workspaces are always available.
 *
 * The trusted main process orchestrates the transfer: export bundle + summary
 * from the owning server, then import on the target (`session:transferToWorkspace`
 * in `apps/electron/src/main/index.ts`, local arm in `main/session-transfer.ts`).
 */

import * as React from 'react'
import { useTranslation } from "react-i18next"
import { useState, useCallback, useEffect, useRef } from 'react'
import { Send } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useWorkspaceIcons } from '@/hooks/useWorkspaceIcon'
import { WorkspaceTargetList, type RemoteHealth } from './WorkspaceTargetList'
import type { WorkspaceInfo } from '../../../shared/types'
import { getTransferTargets } from './transfer-targets'

export interface SendToWorkspaceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Session IDs to transfer */
  sessionIds: string[]
  /** All workspaces */
  workspaces: WorkspaceInfo[]
  /** Current workspace ID (excluded from picker) */
  activeWorkspaceId: string | null
  /** Called after successful transfer with target workspace ID and new session IDs */
  onTransferComplete?: (targetWorkspaceId: string, newSessionIds: string[]) => void
}

export function SendToWorkspaceDialog({
  open,
  onOpenChange,
  sessionIds,
  workspaces,
  activeWorkspaceId,
  onTransferComplete,
}: SendToWorkspaceDialogProps) {
  const { t } = useTranslation()
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null)
  const [isTransferring, setIsTransferring] = useState(false)
  // Normalized overall progress (0–1) across all sessions in the batch
  const [overallProgress, setOverallProgress] = useState(0)
  const workspaceIconMap = useWorkspaceIcons(workspaces)

  // Listen for chunk upload progress from main process and normalize across batch
  useEffect(() => {
    if (!isTransferring) {
      setOverallProgress(0)
      return
    }
    const cleanup = window.electronAPI.onTransferProgress((p) => {
      // Each session contributes 1/sessionCount to the total.
      // Within a session, chunkSent/chunkTotal fills that slice.
      const sessionSlice = 1 / p.sessionCount
      const withinSession = p.chunkTotal > 0 ? p.chunkSent / p.chunkTotal : 1
      setOverallProgress(p.sessionIndex * sessionSlice + withinSession * sessionSlice)
    })
    return cleanup
  }, [isTransferring])

  // Credential readiness for remote workspaces. Secrets remain in trusted main.
  const [remoteHealthMap, setRemoteHealthMap] = useState<Map<string, RemoteHealth>>(new Map())

  // Every other workspace is a valid target; only remote ones need a credential check
  const targetWorkspaces = getTransferTargets(workspaces, activeWorkspaceId)
  const remoteTargets = targetWorkspaces.filter(w => w.remoteServer)

  // Do not probe with saved tokens from renderer; only expose hasCredential.
  useEffect(() => {
    if (!open) return
    setRemoteHealthMap(() => {
      const next = new Map<string, RemoteHealth>()
      for (const ws of remoteTargets) next.set(ws.id, ws.hasCredential ? 'ok' : 'error')
      return next
    })
  }, [open, remoteTargets.map(w => w.id).join(',')])

  const handleTransfer = useCallback(async () => {
    if (!selectedWorkspaceId || sessionIds.length === 0) return

    const targetWorkspace = workspaces.find(w => w.id === selectedWorkspaceId)
    if (!targetWorkspace) return

    setIsTransferring(true)
    const targetName = targetWorkspace.name
    const count = sessionIds.length

    const toastId = toast.loading(t('sendToWorkspace.sending', { count, target: targetName }))

    try {
      const newSessionIds: string[] = []

      for (let i = 0; i < sessionIds.length; i++) {
        const sessionId = sessionIds[i]
        // Main process handles export + summary + transport (chunked for large bundles)
        const result = await window.electronAPI.transferSessionToWorkspace(sessionId, selectedWorkspaceId, i, sessionIds.length)
        newSessionIds.push(result.sessionId)
      }

      toast.success(t('sendToWorkspace.sent', { count, target: targetName }), {
        id: toastId,
        action: onTransferComplete ? {
          label: t('sendToWorkspace.open'),
          onClick: () => onTransferComplete(selectedWorkspaceId, newSessionIds),
        } : undefined,
      })

      onOpenChange(false)
      setSelectedWorkspaceId(null)
    } catch (error) {
      const message = error instanceof Error ? error.message : t('toast.unknownError') // F1.627
      toast.error(t('sendToWorkspace.failedToSend', { count }), {
        id: toastId,
        description: message,
      })
    } finally {
      setIsTransferring(false)
    }
  }, [selectedWorkspaceId, sessionIds, workspaces, onOpenChange, onTransferComplete, t])

  const count = sessionIds.length

  return (
    <Dialog open={open} onOpenChange={(isOpen) => {
      if (!isTransferring) {
        onOpenChange(isOpen)
        if (!isOpen) setSelectedWorkspaceId(null)
      }
    }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Send className="size-4 text-tertiary" />
            {t("sendToWorkspace.title")}
          </DialogTitle>
          <DialogDescription>
            {t("sendToWorkspace.description", { count })}
          </DialogDescription>
        </DialogHeader>

        {/* Workspace list — every other workspace; locals are always selectable */}
        <WorkspaceTargetList
          workspaces={targetWorkspaces}
          selectedId={selectedWorkspaceId}
          onSelect={setSelectedWorkspaceId}
          disabled={isTransferring}
          remoteHealth={remoteHealthMap}
          iconById={workspaceIconMap}
          emptyLabel={t("sendToWorkspace.noRemoteWorkspaces")}
        />

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={isTransferring}
          >
            {t('common.cancel')}
          </Button>
          <TransferButton
            onClick={handleTransfer}
            disabled={!selectedWorkspaceId || isTransferring}
            isTransferring={isTransferring}
            progress={overallProgress}
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Send button with an accent progress stroke that traces around it during transfer */
function TransferButton({ onClick, disabled, isTransferring, progress }: {
  onClick: () => void
  disabled: boolean
  isTransferring: boolean
  progress: number
}) {
  const { t } = useTranslation()
  const wrapperRef = useRef<HTMLDivElement>(null)
  const rectRef = useRef<SVGRectElement>(null)
  const [perim, setPerim] = useState(0)

  useEffect(() => {
    if (rectRef.current && isTransferring) {
      setPerim(rectRef.current.getTotalLength())
    }
  }, [isTransferring])

  return (
    <div ref={wrapperRef} className="relative">
      <Button variant="primary" onClick={onClick} disabled={disabled}>
        {isTransferring ? t('sendToWorkspace.resourceSendingButton') : t('sendToWorkspace.resourceSend')}
      </Button>
      {isTransferring && (
        <svg
          className="absolute pointer-events-none"
          style={{ inset: '-3px', width: 'calc(100% + 6px)', height: 'calc(100% + 6px)', overflow: 'visible' }}
        >
          <rect
            ref={rectRef}
            x="1.5" y="1.5"
            width="calc(100% - 3px)" height="calc(100% - 3px)"
            rx="10" ry="10"
            fill="none"
            stroke="var(--accent)"
            strokeWidth="2"
            strokeDasharray={perim > 0 ? `${progress * perim} ${perim}` : '0 999'}
            style={{ transition: 'stroke-dasharray var(--dur-base) var(--ease-out)' }}
          />
        </svg>
      )}
    </div>
  )
}
