/**
 * ClaudeImportContainer — owns the scan/import lifecycle for a Claude Code setup
 * import and drives the presentational {@link ClaudeImportPanel} through the
 * `previewClaudeSetupImport` / `applyClaudeSetupImport` IPC (P2.9).
 *
 * Kept separate from the panel so the panel stays pure and prop-tested; kept
 * free of any app-shell context so it can be used from Settings and from the
 * onboarding step alike — the caller supplies the target `workspaceId`.
 */

import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  ClaudeSetupImportPlan,
  ClaudeSetupImportResult,
} from '@nessy-agent/shared/capabilities/claude-setup-import'
import { ClaudeImportPanel, type ClaudeImportStatus } from './ClaudeImportPanel'

export interface ClaudeImportContainerProps {
  /** The workspace the import writes into. When absent, scanning reports that no
   * workspace is active rather than throwing. */
  workspaceId?: string
}

export function ClaudeImportContainer({ workspaceId }: ClaudeImportContainerProps) {
  const { t } = useTranslation()
  const [status, setStatus] = useState<ClaudeImportStatus>('idle')
  const [plan, setPlan] = useState<ClaudeSetupImportPlan | null>(null)
  const [result, setResult] = useState<ClaudeSetupImportResult | null>(null)
  const [errorMessage, setErrorMessage] = useState<string>()

  const onScan = useCallback(async () => {
    if (!workspaceId) {
      setErrorMessage(t('claudeImport.noWorkspace'))
      setStatus('error')
      return
    }
    setStatus('scanning')
    setErrorMessage(undefined)
    try {
      const scanned = await window.electronAPI.previewClaudeSetupImport(workspaceId)
      setPlan(scanned)
      setStatus('preview')
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error))
      setStatus('error')
    }
  }, [workspaceId, t])

  const onImport = useCallback(async () => {
    if (!workspaceId) return
    setStatus('importing')
    try {
      // The plan the user is looking at is what gets written — not a fresh scan.
      const applied = await window.electronAPI.applyClaudeSetupImport(workspaceId, plan ?? undefined)
      setResult(applied)
      setStatus('done')
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error))
      setStatus('error')
    }
  }, [workspaceId, plan])

  const onCancel = useCallback(() => {
    setStatus('idle')
    setPlan(null)
  }, [])

  return (
    <ClaudeImportPanel
      status={status}
      plan={plan}
      result={result}
      errorMessage={errorMessage}
      onScan={onScan}
      onImport={onImport}
      onCancel={onCancel}
    />
  )
}
