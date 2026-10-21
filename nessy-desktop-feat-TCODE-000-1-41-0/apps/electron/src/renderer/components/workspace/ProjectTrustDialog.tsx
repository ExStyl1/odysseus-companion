import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { IssuedProjectHandle } from '@nessy-agent/shared/projects/project-handle-service'
import type { ProjectContributionReport, ProjectTrustSelection, SetProjectTrustInput } from '@nessy-agent/shared/protocol'
import { Button } from '@/components/ui/button'
import { ProjectContributionsList } from './ProjectContributionsList'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

export interface ProjectTrustDialogProps {
  open: boolean
  project: IssuedProjectHandle | null
  onClose: () => void
  onDecision: (project: IssuedProjectHandle) => void
}

export function projectTrustRequest(
  project: IssuedProjectHandle,
  state: ProjectTrustSelection,
): SetProjectTrustInput {
  return {
    workspaceId: project.workspaceId,
    projectHandleId: project.id,
    state,
  }
}

/**
 * D1.363 — is this failure one the user can click past, or is it terminal?
 *
 * Measured on the packaged 1.40.0 (measure sitting 5e, case `RS-80`): the folder
 * this dialog named was deleted while the dialog was up, and from then on every
 * click answered `Could not update project trust` — a retry prompt for a thing
 * that can never succeed, with the dialog holding the screen until the user found
 * its Cancel button. `project-directory-missing` is the handler's word for "the
 * folder is gone", and it is the only one that closes the dialog.
 *
 * **Read off the MESSAGE, deliberately, and not off `error.code`.** The rebuilt
 * error does carry a `code` — but `toRpcErrorEnvelope`
 * (`apps/electron/src/shared/rpc-error.ts`) only forwards a code matching
 * `/^[A-Z0-9_]+$/`, and the wire code for a handler throw is the generic
 * `HANDLER_ERROR` anyway. The message is copied verbatim at every hop
 * (`server.ts` reads `err.message`, `client.ts` rebuilds with it, the envelope
 * carries it), so it is the channel that actually arrives.
 */
export type ProjectTrustFailure = 'retryable' | 'project-missing'

export function classifyProjectTrustFailure(error: unknown): ProjectTrustFailure {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return message.includes('project-directory-missing') ? 'project-missing' : 'retryable'
}

/**
 * UB14.39 (R6-10) — on v0.15.1's dialog vocabulary (recipe: v0.15.1 `ResetConfirmationDialog.tsx`): Cancel is the
 * ghost, Keep restricted the secondary, and the irreversible Trust folder `danger-solid` (trusting lets the folder's
 * instructions, servers and hooks run). The path and the contribution list sit in sunken wells, the failure on the
 * destructive text role. The trust decision, its fail-soft report and D1.363's terminal close are unchanged.
 */
export function ProjectTrustDialog({
  open,
  project,
  onClose,
  onDecision,
}: ProjectTrustDialogProps) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [report, setReport] = useState<ProjectContributionReport | null>(null)

  useEffect(() => {
    if (!open) {
      setBusy(false)
      setFailed(false)
      setReport(null)
    }
  }, [open])

  // Fetch what the project would contribute the moment the dialog opens. This is
  // consent-before-trust visibility; it is read-only and fail-soft — any error
  // leaves `report` null so the dialog renders exactly as it did before.
  useEffect(() => {
    if (!open || !project) return
    let cancelled = false
    void window.electronAPI.capabilities
      .detectProjectContributions({ workspaceId: project.workspaceId, projectHandleId: project.id })
      .then(result => { if (!cancelled) setReport(result) })
      .catch(() => { if (!cancelled) setReport(null) })
    return () => { cancelled = true }
  }, [open, project])

  const decide = async (state: ProjectTrustSelection) => {
    if (!project || busy) return
    setBusy(true)
    setFailed(false)
    try {
      onDecision(await window.electronAPI.setProjectTrust(projectTrustRequest(project, state)))
      onClose()
    } catch (error) {
      // D1.363 — a terminal answer CLOSES this dialog and says why. Leaving it
      // open with a retry message is the dead end the sitting measured; nothing
      // was trusted, and there is nothing here left to answer.
      if (classifyProjectTrustFailure(error) === 'project-missing') {
        toast.error(t('projectTrust.projectMissing', {
          path: project.displayPath,
          defaultValue: '{{path}} is no longer there — the folder was moved, renamed or deleted. Nothing was trusted.',
        }))
        onClose()
        return
      }
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open && !!project} onOpenChange={next => { if (!next && !busy) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t('projectTrust.title', { defaultValue: 'Trust this folder?' })}
          </DialogTitle>
          <DialogDescription>
            {t('projectTrust.description', {
              defaultValue: 'Instructions, skills, agents, MCP servers, hooks, and memory can run from this folder.',
            })}
          </DialogDescription>
        </DialogHeader>

        <div data-testid="project-trust-path" className="rounded-md bg-sunken px-3 py-2 font-mono text-mono-ui break-all">
          {project?.displayPath}
        </div>
        <ProjectContributionsList
          report={report}
          className="rounded-md bg-sunken px-3 py-2.5"
        />
        {failed && (
          <p role="alert" className="text-label text-destructive">
            {t('projectTrust.updateFailed', { defaultValue: 'Could not update folder trust.' })}
          </p>
        )}

        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => void decide('untrusted')}>
            {t('projectTrust.keepRestricted', { defaultValue: 'Keep restricted' })}
          </Button>
          <Button variant="danger-solid" disabled={busy} onClick={() => void decide('trusted')}>
            {t('projectTrust.trust', { defaultValue: 'Trust folder' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
