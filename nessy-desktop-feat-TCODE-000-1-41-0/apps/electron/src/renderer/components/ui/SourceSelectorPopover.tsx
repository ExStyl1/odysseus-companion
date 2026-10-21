import * as React from 'react'
import { Check, DatabaseZap } from 'lucide-react'
import { FilterableSelectPopover } from '@nessy-agent/ui'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/utils'
import { sourceSelectionId } from '@/lib/capability-catalog'
import { SourceAvatar } from '@/components/ui/source-avatar'
import type { SafeCapabilitySummary } from '@nessy-agent/shared/protocol/capabilities'

export interface SourceSelectorPopoverProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  anchorRef: React.RefObject<HTMLButtonElement | null>
  sources: SafeCapabilitySummary[]
  selectedSlugs: string[]
  onToggleSlug: (slug: string) => void
}

export function SourceSelectorPopover({
  open,
  onOpenChange,
  anchorRef,
  sources,
  selectedSlugs,
  onToggleSlug,
}: SourceSelectorPopoverProps) {
  const { t } = useTranslation() // UA12.194
  return (
    <FilterableSelectPopover
      open={open}
      onOpenChange={onOpenChange}
      anchorRef={anchorRef}
      items={sources}
      getKey={(source) => source.key}
      getLabel={(source) => source.logicalName}
      isSelected={(source) => selectedSlugs.includes(sourceSelectionId(source))}
      onToggle={(source) => onToggleSlug(sourceSelectionId(source))}
      filterPlaceholder={t('sourcesList.searchPlaceholder')} // UA12.206
      emptyState={(
        <>
          {t('sourcesList.noSourcesConfigured')}
          <br />
          {t('sourcesList.addInSettings')}
        </>
      )}
      noResultsState={t('sourcesList.noMatchingSources')}
      minWidth={200}
      maxWidth={320}
      renderItem={(source, state, index) => (
        <div
          data-tutorial={index === 0 ? 'source-dropdown-item-first' : undefined}
          className={cn(
            'flex cursor-pointer select-none items-center gap-3 rounded-[6px] px-3 py-2 text-[13px]',
            state.highlighted && 'bg-foreground/5',
            state.selected && 'bg-foreground/3',
          )}
        >
          <div className="shrink-0 text-muted-foreground flex items-center">
            {sourceSelectionId(source)
              ? <SourceAvatar source={source} size="sm" />
              : <DatabaseZap className="h-4 w-4" />}
          </div>
          <div className="flex-1 min-w-0 truncate">{source.logicalName}</div>
          <div
            className={cn(
              'shrink-0 h-4 w-4 rounded-full bg-current flex items-center justify-center',
              !state.selected && 'opacity-0',
            )}
          >
            <Check className="h-2.5 w-2.5 text-white dark:text-black" strokeWidth={3} />
          </div>
        </div>
      )}
    />
  )
}
