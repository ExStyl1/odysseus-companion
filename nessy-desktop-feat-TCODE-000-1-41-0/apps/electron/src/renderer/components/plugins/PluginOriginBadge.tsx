import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Package } from 'lucide-react'
import { NessySymbol } from '@/components/icons/NessySymbol'
import { ClaudeIcon, OpenAiIcon } from '@/components/icons/runtime'
import { cn } from '@/lib/utils'
import type { SafePluginPresentationOrigin } from '@nessy-agent/shared/protocol/capabilities'

export interface PluginOriginBadgeProps {
  /**
   * Display-only origin presentation (A9). `undefined` renders the same as a
   * pre-inspection catalog row: acquisition unknown, generic package icon.
   */
  presentation?: SafePluginPresentationOrigin
  className?: string
}

const FORMAT_LABEL_KEYS: Record<SafePluginPresentationOrigin['format'], string> = {
  nessy: 'plugins.origin.format.nessy',
  codex: 'plugins.origin.format.codex',
  claude: 'plugins.origin.format.claude',
  unknown: 'plugins.origin.format.unknown',
}

const ACQUISITION_LABEL_KEYS: Record<SafePluginPresentationOrigin['acquisition'], string> = {
  'nessy-marketplace': 'plugins.origin.acquisition.nessyMarketplace',
  'external-marketplace': 'plugins.origin.acquisition.externalMarketplace',
  repository: 'plugins.origin.acquisition.repository',
  local: 'plugins.origin.acquisition.local',
  url: 'plugins.origin.acquisition.url',
  unknown: 'plugins.origin.acquisition.unknown',
}

/**
 * Format logo + acquisition label (A9). REUSES existing OpenAI/Anthropic/
 * Nessy icons — never a new logo asset. A pre-inspection catalog row (no
 * `presentation`, or `format: 'unknown'`) always shows the generic package
 * icon; format is never guessed from kind/label/install command.
 */
export function PluginOriginBadge({ presentation, className }: PluginOriginBadgeProps) {
  const { t } = useTranslation()
  const format = presentation?.format ?? 'unknown'
  const acquisition = presentation?.acquisition ?? 'unknown'
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs text-muted-foreground', className)}>
      <FormatIcon format={format} />
      <span>{t(ACQUISITION_LABEL_KEYS[acquisition])}</span>
    </span>
  )
}

function FormatIcon({ format }: { format: SafePluginPresentationOrigin['format'] }) {
  const { t } = useTranslation()
  const label = t(FORMAT_LABEL_KEYS[format])
  if (format === 'codex') return <OpenAiIcon className="h-3.5 w-3.5" aria-label={label} />
  if (format === 'claude') return <ClaudeIcon className="h-3.5 w-3.5" aria-label={label} />
  if (format === 'nessy') return <NessySymbol className="h-3.5 w-3.5 text-accent" aria-label={label} />
  return <Package className="h-3.5 w-3.5" aria-label={label} />
}
