/**
 * UA1.23 — binds the inline previews' "Publish" action to ONE session: a nested `PlatformProvider` that keeps every
 * outer platform action and adds `onPublishFile`, which sends the block's PATH (never its bytes) to the host
 * (`artifacts:publishFile`). The host runs the SAME path as `publish_artifact` (UA1.17 guard → UA1.18 card → client →
 * registry → audit row) with this session as the source; the card appears in this session's chat, in every mode,
 * `bypassPermissions` included. Mounted by `ChatPage` around the chat, so the session is the block's session.
 */
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { PlatformProvider, usePlatform } from '@nessy-agent/ui'
import { previewPublishToast } from './preview-publish'

export function SessionPublishPlatform({ sessionId, workspaceId, children }: {
  sessionId: string
  workspaceId: string | null | undefined
  children: React.ReactNode
}) {
  const { t } = useTranslation()
  const outer = usePlatform()
  const onPublishFile = React.useCallback((filePath: string) => {
    if (!workspaceId) return
    void window.electronAPI.publishArtifactFile(workspaceId, { sessionId, filePath })
      .then(result => {
        const view = previewPublishToast(result)
        const description = view.description ? { description: view.description } : undefined
        if (view.kind === 'success') toast.success(t(view.key), description)
        else if (view.kind === 'info') toast(t(view.key), description)
        else toast.error(t(view.key), description)
      })
      .catch((error: unknown) => {
        toast.error(t('preview.publishFailed'), { description: error instanceof Error ? error.message : String(error) })
      })
  }, [sessionId, workspaceId, t])
  const actions = React.useMemo(() => ({ ...outer, onPublishFile }), [outer, onPublishFile])
  return <PlatformProvider actions={actions}>{children}</PlatformProvider>
}
