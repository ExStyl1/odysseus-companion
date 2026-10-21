/**
 * Source: v0.15.1:apps/electron/src/renderer/components/automations/AutomationTestPanel.tsx (taken by
 * UB14.44 with ONE hunk re-applied: the `Spinner` subpath import (P6.844), not the `@nessy-agent/ui`
 * barrel). Apache-2.0, LICENSE and NOTICE kept.
 */
/**
 * AutomationTestPanel
 *
 * Inline panel displaying test execution results.
 * Uses Info_Alert variants for consistent styling.
 */

import { useTranslation } from 'react-i18next'
import { CheckCircle2, XCircle } from 'lucide-react'
// The primitive's own subpath, never the barrel (P6.844: its graph reaches a Vite-only specifier).
import { Spinner } from '@nessy-agent/ui/ui/LoadingIndicator'
import { Info_Alert } from '@/components/info'
import { cn } from '@/lib/utils'
import type { TestResult } from './types'

export interface AutomationTestPanelProps {
  result: TestResult
  className?: string
}

export function AutomationTestPanel({ result, className }: AutomationTestPanelProps) {
  const { t } = useTranslation()
  if (result.state === 'idle') return null

  // Running state
  if (result.state === 'running') {
    return (
      <div className={cn('flex items-center gap-2 px-3.5 py-3 text-label text-tertiary', className)}>
        <Spinner />
        <span>{t('automations.testRunning')}</span>
      </div>
    )
  }

  // Success state
  if (result.state === 'success') {
    return (
      <Info_Alert variant="success" icon={<CheckCircle2 />} className={className}>
        <Info_Alert.Title>
          {t('automations.testPassed')}
          {result.duration != null && (
            <span className="ml-2 text-label-sm font-normal text-tertiary tabular-nums">
              {result.duration}ms
            </span>
          )}
        </Info_Alert.Title>
      </Info_Alert>
    )
  }

  // Error state
  if (result.state === 'error') {
    return (
      <Info_Alert variant="error" icon={<XCircle />} className={className}>
        <Info_Alert.Title>{t('automations.testFailed')}</Info_Alert.Title>
        {result.stderr && (
          <Info_Alert.Description>
            <pre className="mt-1 whitespace-pre-wrap font-mono text-mono-ui text-destructive">{result.stderr}</pre>
          </Info_Alert.Description>
        )}
      </Info_Alert>
    )
  }

  return null
}
