/**
 * CapabilityContentPanel
 *
 * Codex-verified content treatment for a capability's primary body (skill
 * instructions, source guide, plugin description). Renders an INSET elevated
 * panel — rounded, scrollable with a maxHeight + fullscreen affordance — that
 * shows full markdown via Info_Markdown, plus FILE REFERENCES as icon chips
 * with a relative-path tooltip.
 *
 * Placeholder-not-hidden: the panel is ALWAYS present. Its four states are
 *   - loaded:  markdown body + optional file-ref chips
 *   - loading: a quiet skeleton
 *   - error:   a fail-soft placeholder + retry affordance
 *   - empty:   a quiet placeholder ("No documentation provided")
 *
 * This component is IPC-free and callback-driven so it can be exercised in the
 * playground and wired to the capabilities.preview RPC during integration.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { FileText, RotateCw } from 'lucide-react'
import { Info_Markdown } from './Info_Markdown'
import { cn } from '@/lib/utils'

/** A single file reference rendered as a click-to-open chip. */
export interface CapabilityContentFileRef {
  /** Stable key + callback payload; the display label is the basename. */
  id: string
  /** Short label shown inside the chip (e.g. a basename). */
  label: string
  /** Relative path shown as the chip's tooltip; never an absolute path. */
  relativePath: string
}

export type CapabilityContentPanelStatus = 'loaded' | 'loading' | 'error' | 'empty'

export interface CapabilityContentPanelProps {
  status: CapabilityContentPanelStatus
  /** Markdown body — required when status is 'loaded'. */
  markdown?: string
  /** File-reference chips shown under the body (loaded state only). */
  fileRefs?: CapabilityContentFileRef[]
  /** Error message for the 'error' state placeholder. */
  errorMessage?: string
  /** Empty-state placeholder text; falls back to a localized default. */
  emptyMessage?: string
  /** Scroll cap for the loaded body. */
  maxHeight?: number
  /** Chip click — integration wires this to preview/open later. */
  onOpenFileRef?: (ref: CapabilityContentFileRef) => void
  /** Retry affordance for the error state. */
  onRetry?: () => void
  className?: string
}

function SkeletonBar({ className }: { className?: string }) {
  return <div className={cn('h-3 animate-pulse rounded-xs bg-fill-hover', className)} />
}

/**
 * File-reference chips. Hook-free so it can be unit-tested by invoking a
 * chip's onClick directly (no DOM needed).
 */
export function ContentFileRefChips({
  fileRefs,
  onOpenFileRef,
}: {
  fileRefs: CapabilityContentFileRef[]
  onOpenFileRef?: (ref: CapabilityContentFileRef) => void
}) {
  return (
    <div className="flex flex-wrap gap-1.5 px-3.5 pb-3 pt-1">
      {fileRefs.map((ref) => (
        <button
          key={ref.id}
          type="button"
          title={ref.relativePath}
          onClick={() => onOpenFileRef?.(ref)}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-sm py-1 pl-2 pr-2.5 text-label-sm',
            'bg-accent-tint text-accent hover:bg-accent-tint-strong',
            'transition-colors duration-micro ease-out-subtle hover:duration-instant',
            'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          )}
          data-testid="content-file-ref"
        >
          <FileText className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate max-w-[220px]">{ref.label}</span>
        </button>
      ))}
    </div>
  )
}

export function CapabilityContentPanel({
  status,
  markdown,
  fileRefs,
  errorMessage,
  emptyMessage,
  maxHeight = 420,
  onOpenFileRef,
  onRetry,
  className,
}: CapabilityContentPanelProps) {
  const { t } = useTranslation()

  return (
    // No own card chrome: the surrounding Info_Section already provides the
    // single surface layer (bg + shadow + radius); doubling it read as a
    // nested frame (reviewer feedback 2026-07-19).
    <div className={cn('overflow-hidden', className)}>
      {status === 'loading' && (
        <div className="space-y-3 p-3.5" aria-busy="true" data-testid="content-loading">
          <SkeletonBar className="w-1/3 h-4" />
          <SkeletonBar className="w-full" />
          <SkeletonBar className="w-11/12" />
          <SkeletonBar className="w-4/5" />
        </div>
      )}

      {status === 'error' && (
        <div
          className="flex flex-col items-start gap-2 p-3.5 text-label"
          data-testid="content-error"
        >
          <p className="text-secondary">
            {errorMessage ?? t('capabilityDetail.contentUnavailable')}
          </p>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex items-center gap-1.5 rounded-sm px-1.5 py-1 text-label-sm text-secondary transition-colors duration-micro ease-out-subtle hover:bg-fill-hover hover:text-foreground hover:duration-instant focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <RotateCw className="size-3.5" aria-hidden />
              {t('capabilityDetail.retry')}
            </button>
          )}
        </div>
      )}

      {status === 'empty' && (
        <div className="p-3.5 text-label text-tertiary" data-testid="content-empty">
          {emptyMessage ?? t('capabilityDetail.noContent')}
        </div>
      )}

      {status === 'loaded' && (
        <div data-testid="content-loaded">
          {/* px-3.5/pt-3 override Info_Markdown's default px-card-pad: match the info
              card inset (reviewer feedback 2026-07-19; UB14.59 the 14px card pad). */}
          <Info_Markdown maxHeight={maxHeight} fullscreen className="px-3.5 pb-3.5 pt-3">
            {markdown ?? ''}
          </Info_Markdown>
          {fileRefs && fileRefs.length > 0 && (
            <ContentFileRefChips fileRefs={fileRefs} onOpenFileRef={onOpenFileRef} />
          )}
        </div>
      )}
    </div>
  )
}
