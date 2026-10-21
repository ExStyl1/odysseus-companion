/* Copied verbatim from v0.13.4:apps/electron/src/renderer/components/ui/color-picker.tsx
   (craft-agents-oss, Apache-2.0) by UA2.3, 2026-10-02.
   UB14.36, 2026-10-16: v0.15.1's one hunk applied (the preset swatch presses with `motion-press` instead of
   `transition-all`), so below this header the file equals v0.15.1:apps/electron/src/renderer/components/ui/color-picker.tsx
   except UB12.86's hunk (2026-10-17, kept ours): with no `ariaLabel` / `clearLabel` the trigger's label and the
   reset link read `common.pickColor` / `common.resetToDefault` (v0.15.1 defaults both to English literals). */
/**
 * ColorPicker - Hex color picker in a Popover.
 *
 * Wraps `react-colorful`'s `HexColorPicker` and exposes optional preset
 * swatches above it. Designed to replace native `<input type="color">` so
 * the picker stays inside the app window and respects app theming.
 *
 * Value is a 6-digit hex string (`#RRGGBB`) or `''` for "no color".
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Check } from 'lucide-react'
import { HexColorPicker, HexColorInput } from 'react-colorful'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

interface ColorPickerProps {
  value: string
  onChange: (hex: string) => void
  /** Optional preset swatches shown above the picker for quick selection. */
  presets?: readonly string[]
  /** Fallback hex used when `value` is empty (just for the popover's initial state). */
  fallbackColor?: string
  /** Visual style of the trigger swatch. */
  triggerClassName?: string
  /** Accessible label for the trigger button (default: `common.pickColor`). */
  ariaLabel?: string
  /** Where the popover opens relative to the trigger. */
  align?: 'start' | 'center' | 'end'
  /** Render-prop trigger to fully replace the default swatch button. */
  trigger?: React.ReactNode
  /** If set, shows a "Reset" link inside the popover that invokes this callback. */
  onClear?: () => void
  /** Label for the clear/reset action (default: `common.resetToDefault`, "Reset to default"). */
  clearLabel?: string
}

export function ColorPicker({
  value,
  onChange,
  presets,
  fallbackColor = '#6366f1',
  triggerClassName,
  ariaLabel,
  align = 'start',
  trigger,
  onClear,
  clearLabel,
}: ColorPickerProps) {
  const { t } = useTranslation()
  const displayColor = value || fallbackColor

  return (
    <Popover>
      <PopoverTrigger asChild>
        {trigger ?? (
          <button
            type="button"
            aria-label={ariaLabel ?? t('common.pickColor')}
            className={cn(
              'h-7 w-7 rounded-md ring-1 ring-foreground/10 hover:ring-foreground/30 transition-shadow cursor-pointer',
              triggerClassName
            )}
            style={{ backgroundColor: value || 'transparent' }}
          />
        )}
      </PopoverTrigger>
      <PopoverContent
        align={align}
        sideOffset={6}
        className="w-auto p-3 font-sans"
      >
        <div className="flex flex-col gap-3">
          <HexColorPicker
            color={displayColor}
            onChange={onChange}
            className="!w-48 !h-40"
          />

          <div className="flex items-center gap-2 px-0.5">
            <span className="text-foreground/40 text-xs font-mono">#</span>
            <HexColorInput
              color={displayColor}
              onChange={onChange}
              prefixed={false}
              className="flex-1 bg-transparent text-sm font-mono outline-none rounded px-1.5 py-1 ring-1 ring-foreground/10 focus:ring-foreground/30 transition-shadow"
              aria-label={t('common.hexValue')}
            />
          </div>

          {presets && presets.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-2 border-t border-foreground/5">
              {presets.map((swatch) => {
                const isActive = swatch.toLowerCase() === value.toLowerCase()
                return (
                  <button
                    key={swatch}
                    type="button"
                    onClick={() => onChange(swatch)}
                    className={cn(
                      'motion-press relative h-5 w-5 rounded-full flex items-center justify-center',
                      isActive
                        ? 'ring-2 ring-offset-2 ring-foreground ring-offset-background'
                        : 'ring-1 ring-foreground/10 hover:ring-foreground/40 hover:scale-110'
                    )}
                    style={{ backgroundColor: swatch }}
                    aria-label={swatch}
                    aria-pressed={isActive}
                  >
                    {isActive && (
                      <Check
                        className="h-3 w-3 text-white"
                        strokeWidth={3}
                        style={{ filter: 'drop-shadow(0 1px 1px rgba(0,0,0,0.4))' }}
                      />
                    )}
                  </button>
                )
              })}
            </div>
          )}

          {onClear && value && (
            <button
              type="button"
              onClick={onClear}
              className="text-xs text-foreground/50 hover:text-foreground self-start mt-1"
            >
              {clearLabel ?? t('common.resetToDefault')}
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
