/**
 * SendResourceToWorkspaceDialog — Copy a source, skill, or automation to another workspace.
 *
 * Uses the resources:export → resources:import RPC pipeline.
 * Supports both local and remote target workspaces:
 * - Local: both RPC calls go to the same server
 * - Remote: export runs locally, trusted main resolves and imports on the target
 *
 * Adapted from SendToWorkspaceDialog (session transfer).
 */

import * as React from 'react'
import { useState, useCallback, useEffect, useRef } from 'react'
import { Send } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
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
import { collectSendResourceNotes } from '@/lib/send-resource-notes'
import type { WorkspaceInfo, ExportResourcesOptions, ResourceImportMode } from '../../../shared/types'

export type SendResourceType = 'source' | 'skill' | 'automation'

export interface SendResourceToWorkspaceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** What kind of resource to send */
  resourceType: SendResourceType
  /** Slug(s) or ID(s) of resources to send */
  resourceIds: string[]
  /** Display label for the dialog description (e.g., "Slack source") */
  resourceLabel: string
  /** All workspaces */
  workspaces: WorkspaceInfo[]
  /** Current workspace ID (excluded from picker) */
  activeWorkspaceId: string | null
  /** Called after successful transfer */
  onTransferComplete?: () => void
}

/**
 * F1.606 — the phrases that name the resource type, one plural family per type: `count` is
 * "N skills", `failed` is "Failed to send skills". They are whole keys, not an English noun
 * spliced into a sentence, because Russian inflects the noun by count and by case.
 */
export const RESOURCE_TYPE_KEYS: Record<SendResourceType, { count: string; failed: string }> = {
  source: { count: 'sendToWorkspace.sourceCount', failed: 'sendToWorkspace.failedToSendSource' },
  skill: { count: 'sendToWorkspace.skillCount', failed: 'sendToWorkspace.failedToSendSkill' },
  automation: { count: 'sendToWorkspace.automationCount', failed: 'sendToWorkspace.failedToSendAutomation' },
}

export function SendResourceToWorkspaceDialog({
  open,
  onOpenChange,
  resourceType,
  resourceIds,
  resourceLabel,
  workspaces,
  activeWorkspaceId,
  onTransferComplete,
}: SendResourceToWorkspaceDialogProps) {
  const { t } = useTranslation()
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null)
  const [isSending, setIsSending] = useState(false)
  const workspaceIconMap = useWorkspaceIcons(workspaces)

  // Health check results for remote workspaces
  const [remoteHealthMap, setRemoteHealthMap] = useState<Map<string, RemoteHealth>>(new Map())
  const healthCheckAbort = useRef<AbortController | null>(null)

  // All workspaces except current (both local and remote)
  const targetWorkspaces = workspaces.filter(w => w.id !== activeWorkspaceId)

  // Health-check remote workspaces when dialog opens
  useEffect(() => {
    if (!open) {
      healthCheckAbort.current?.abort()
      return
    }

    healthCheckAbort.current?.abort()
    const abort = new AbortController()
    healthCheckAbort.current = abort

    const remoteTargets = targetWorkspaces.filter(w => w.remoteServer)
    if (remoteTargets.length === 0) return

    // Mark all remote as checking
    setRemoteHealthMap(() => {
      const next = new Map<string, RemoteHealth>()
      for (const ws of remoteTargets) next.set(ws.id, 'checking')
      return next
    })

    // Saved credentials are not renderer-visible. Missing credentials are the
    // only preflight state available without initiating a trusted-main route.
    for (const ws of remoteTargets) {
      if (abort.signal.aborted) break
      setRemoteHealthMap(prev => new Map(prev).set(ws.id, ws.hasCredential ? 'ok' : 'error'))
    }

    return () => abort.abort()
  }, [open, targetWorkspaces.map(w => w.id).join(',')])

  const handleSend = useCallback(async () => {
    if (!selectedWorkspaceId || !activeWorkspaceId || resourceIds.length === 0) return

    const targetWorkspace = workspaces.find(w => w.id === selectedWorkspaceId)
    if (!targetWorkspace) return

    setIsSending(true)
    const targetName = targetWorkspace.name
    const typeKeys = RESOURCE_TYPE_KEYS[resourceType]
    const count = resourceIds.length
    const mode: ResourceImportMode = 'skip'

    const toastId = toast.loading(t('sendToWorkspace.resourceSending', { resource: resourceLabel, target: targetName }))

    try {
      // 1. Export the selected resource(s) from current workspace
      const exportOptions: ExportResourcesOptions = {}
      if (resourceType === 'source') exportOptions.sources = resourceIds
      else if (resourceType === 'skill') exportOptions.skills = resourceIds
      else if (resourceType === 'automation') exportOptions.automations = resourceIds

      const { bundle, warnings: exportWarnings } = await window.electronAPI.exportResources(
        activeWorkspaceId,
        exportOptions,
      )

      // 2. Import into target workspace
      let importResult
      if (targetWorkspace.remoteServer) {
        importResult = await window.electronAPI.importResourcesIntoRemoteWorkspace(
          selectedWorkspaceId,
          bundle,
          mode,
        )
      } else {
        // Local target — direct RPC
        importResult = await window.electronAPI.importResources(
          selectedWorkspaceId,
          bundle,
          mode,
        )
      }

      // 3. Report result
      const bucket = importResult[`${resourceType}s` as 'sources' | 'skills' | 'automations']
      const imported = bucket?.imported?.length ?? 0
      const skipped = bucket?.skipped?.length ?? 0
      // F1.577 — the reasons the export and the import returned, shown on every result toast
      // (their count and the first one), so "Nothing was sent" is never left without a reason.
      const notes = collectSendResourceNotes(exportWarnings, bucket)
      const notesDescription = notes
        ? t('sendToWorkspace.resourceNotes', { count: notes.count, reason: notes.first })
        : undefined

      if (imported > 0 && skipped === 0) {
        toast.success(t('sendToWorkspace.resourceSent', { resource: resourceLabel, target: targetName }), { id: toastId, description: notesDescription })
      } else if (imported > 0 && skipped > 0) {
        // The noun counts what arrived; it used to follow the whole selection ("Sent 1 skills").
        const sent = t(typeKeys.count, { count: imported })
        toast.success(t('sendToWorkspace.resourceSentPartial', { sent, skipped }), { id: toastId, description: notesDescription })
      } else if (skipped > 0) {
        toast.info(t('sendToWorkspace.resourceAlreadyExists', { resource: resourceLabel, target: targetName }), { id: toastId, description: notesDescription })
      } else {
        toast.warning(t('sendToWorkspace.resourceNothingSent', { target: targetName }), { id: toastId, description: notesDescription })
      }

      if (exportWarnings.length > 0) {
        console.warn('[SendResource] Export warnings:', exportWarnings)
      }

      onOpenChange(false)
      setSelectedWorkspaceId(null)
      onTransferComplete?.()
    } catch (error: any) {
      const isUnsupported = error?.code === 'CHANNEL_NOT_FOUND' ||
        (error?.message ?? '').includes('No handler for')
      const message = isUnsupported
        ? t('sendToWorkspace.resourceUnsupportedRemote', { target: targetName })
        : error instanceof Error ? error.message : t('toast.unknownError')
      toast.error(t(typeKeys.failed, { count }), { id: toastId, description: message })
    } finally {
      setIsSending(false)
    }
  }, [selectedWorkspaceId, activeWorkspaceId, resourceIds, resourceType, resourceLabel, workspaces, onOpenChange, onTransferComplete, t])

  return (
    <Dialog open={open} onOpenChange={(isOpen) => {
      if (!isSending) {
        onOpenChange(isOpen)
        if (!isOpen) setSelectedWorkspaceId(null)
      }
    }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Send className="size-4 text-tertiary" />
            {t('sendToWorkspace.title')}
          </DialogTitle>
          <DialogDescription>
            {t('sendToWorkspace.resourceDescription', { resource: resourceLabel })}
          </DialogDescription>
        </DialogHeader>

        {/* Workspace list */}
        <WorkspaceTargetList
          workspaces={targetWorkspaces}
          selectedId={selectedWorkspaceId}
          onSelect={setSelectedWorkspaceId}
          disabled={isSending}
          remoteHealth={remoteHealthMap}
          iconById={workspaceIconMap}
          emptyLabel={t('sendToWorkspace.noOtherWorkspaces')}
        />

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={isSending}
          >
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={handleSend}
            disabled={!selectedWorkspaceId || isSending}
          >
            {isSending ? t('sendToWorkspace.resourceSendingButton') : t('sendToWorkspace.resourceSend')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
