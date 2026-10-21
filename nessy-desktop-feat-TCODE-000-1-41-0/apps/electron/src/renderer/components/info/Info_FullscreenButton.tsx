/**
 * Source: v0.15.1:apps/electron/src/renderer/components/info/Info_FullscreenButton.tsx (ADDED in
 * v0.15.0; Apache-2.0). Landed by UB14.17 for its first reader, `Info_Markdown`; UB14.43 lists it
 * among the info primitives and UB14.58's data tables are its other readers upstream.
 */
/**
 * Info_FullscreenButton
 *
 * Hover-revealed "view fullscreen" button for Info tables and markdown. Floating material so it
 * reads over content; the parent needs `group`. Always visible on touch (data-touch-reveal).
 */

import { useTranslation } from 'react-i18next'
import { Maximize2 } from 'lucide-react'
import { IconButton } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export function Info_FullscreenButton({ onClick, className }: { onClick: () => void; className?: string }) {
  const { t } = useTranslation()
  return (
    <IconButton
      size="sm"
      aria-label={t('table.viewFullscreen')}
      title={t('table.viewFullscreen')}
      icon={<Maximize2 className="size-3.5" />}
      onClick={onClick}
      data-touch-reveal="true"
      className={cn(
        'state-overlay bg-floating shadow-elev-1 hover:bg-floating',
        'opacity-0 transition-opacity duration-micro ease-out-subtle group-hover:opacity-100 group-hover:duration-instant focus-visible:opacity-100',
        className
      )}
    />
  )
}
