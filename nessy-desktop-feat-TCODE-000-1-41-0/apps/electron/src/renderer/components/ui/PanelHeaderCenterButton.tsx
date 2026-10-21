import * as React from 'react'
import { forwardRef } from 'react'
import { Tooltip, TooltipTrigger, TooltipContent } from '@nessy-agent/ui'
import { cn } from '@/lib/utils'
import { PANEL_HEADER_BUTTON_CLASS } from './panel-header-button-style.ts'

interface PanelHeaderCenterButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Icon as React element - caller controls size/styling */
  icon: React.ReactNode
  /** Optional tooltip text (also used as the accessible name) */
  tooltip?: string
}

/**
 * Icon button for panel-header actions (share, info, close, back): a 28×28 ghost button with a
 * secondary icon (spec §7.3). In the compact shell `.panel-header-btn` grows it to a 44px touch target.
 *
 * Source: v0.15.1:apps/electron/src/renderer/components/ui/PanelHeaderCenterButton.tsx (UB14.6, Apache-2.0): its doc
 * and classes, the classes kept in `PANEL_HEADER_BUTTON_CLASS` (see that module for why they live apart).
 */
export const PanelHeaderCenterButton = forwardRef<HTMLButtonElement, PanelHeaderCenterButtonProps>(
  ({ icon, tooltip, className, ...props }, ref) => {
    const button = (
      <button
        ref={ref}
        type="button"
        aria-label={props['aria-label'] ?? tooltip}
        className={cn(PANEL_HEADER_BUTTON_CLASS, className)}
        {...props}
      >
        {icon}
      </button>
    )

    if (tooltip) {
      return (
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent>{tooltip}</TooltipContent>
        </Tooltip>
      )
    }

    return button
  }
)
PanelHeaderCenterButton.displayName = 'PanelHeaderCenterButton'
