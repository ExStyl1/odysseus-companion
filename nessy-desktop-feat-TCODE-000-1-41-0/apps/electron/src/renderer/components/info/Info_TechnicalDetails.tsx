/**
 * Source: v0.15.1:apps/electron/src/renderer/components/info/Info_TechnicalDetails.tsx (ADDED in v0.15.1;
 * taken 1:1 by UB14.48, whose connection-error alert is its first reader; UB14.43 owns the rest of the
 * info primitives). Apache-2.0, LICENSE and NOTICE kept.
 */
/**
 * Info_TechnicalDetails
 *
 * "Technical details" disclosure for raw transport/tool errors (design spec §7.7/§7.11): the plain
 * message stays visible, the raw text sits collapsed in a sunken mono well.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

export function Info_TechnicalDetails({
  children,
  className,
}: {
  /** The raw text (error message, stack, response) */
  children: React.ReactNode
  className?: string
}) {
  const { t } = useTranslation()
  return (
    <details className={cn('group/tech', className)}>
      <summary className="-ml-1 inline-flex h-6 in-data-compact:h-9 cursor-default list-none items-center gap-1 rounded-sm pl-1 pr-1.5 text-label-sm text-secondary transition-colors duration-micro ease-out-subtle hover:text-foreground hover:duration-instant [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden
          className="size-3.5 text-tertiary transition-transform duration-[calc(var(--spring-snap-dur)*var(--motion-scale))] ease-[var(--spring-snap)] group-open/tech:rotate-90"
        />
        {t('sourceInfo.technicalDetails')}
      </summary>
      <pre className="mt-1.5 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md bg-sunken px-2.5 py-2 font-mono text-mono-ui text-secondary">
        {children}
      </pre>
    </details>
  )
}
