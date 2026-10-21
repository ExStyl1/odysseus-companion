/**
 * Merged with v0.15.1:apps/electron/src/renderer/components/app-shell/input/CompactPermissionModeSelector.tsx (UB14.29;
 * Apache-2.0). Taken: the trigger (the `MODE_CHIP_TONE` pill, `data-mode`, the short name kept for screen readers
 * only under a 24rem panel), the drawer rows (`min-h-row-touch`, the fill roles, `MODE_ICON_TONE`, the role type)
 * and `knownMode`. Kept ours: the rows come from `permissionModeDisplays` (the runtime's list narrowed by the
 * workspace cycle, with F1.1052's badges), the runtime note drawn once under them (R15), `locked` from the
 * capability set, and the "Permission mode" key `chat.permissionMode` (F1.358). Not taken: upstream's
 * `useAvailablePermissionModes` (Guarded / its decision-model feature) and its `MODE_LABEL_KEYS` over its four modes.
 */
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Check } from 'lucide-react'
import {
  Drawer,
  DrawerTrigger,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerClose,
} from '@/components/ui/drawer'
import { cn } from '@/lib/utils'
import type { PermissionMode } from '@nessy-agent/shared/agent/modes'
import { PermissionModeIcon as ModeIcon } from '@/components/ui/slash-command-menu'
import type { ComposerPermissionModeMenuDisplay, PermissionModeMenuDecorations } from '@/lib/composer-permission-modes'
import { MODE_CHIP_TONE, MODE_ICON_TONE, knownMode } from './composer-styles'

// ============================================================================
// Row parts shared with the desktop chip's menu (ComposerModeChip) — F1.1052
// ============================================================================

function PermissionModeBadge({ children }: { children: React.ReactNode }) {
  return (
    <span className="shrink-0 rounded-xs bg-fill-hover px-1.5 py-px text-caption text-secondary">
      {children}
    </span>
  )
}

/**
 * A picker row's label with Claude Desktop's badges: "Recommended" on Auto and
 * "Default" on the mode a new session in this workspace starts in. The badges
 * come from `resolvePermissionModeMenuDecorations`, which gives a
 * backend-supplied row (Nestor Cloud) none, so that picker looks as it did.
 * The label takes its size from the row it sits in (menu `text-label`, drawer `text-copy`).
 */
export function PermissionModeItemTitle({ label, decorations }: {
  label: string
  decorations?: PermissionModeMenuDecorations
}) {
  const { t } = useTranslation()
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 font-medium">
      <span>{label}</span>
      {decorations?.recommended && <PermissionModeBadge>{t('chat.permissionModeBadge.recommended')}</PermissionModeBadge>}
      {decorations?.isDefault && <PermissionModeBadge>{t('chat.permissionModeBadge.default')}</PermissionModeBadge>}
    </span>
  )
}

/** A row's right edge: the check mark on the current mode, then the digit that selects the row. */
export function PermissionModeItemTrailing({ current, shortcut }: { current: boolean, shortcut?: number }) {
  return (
    <span className="mt-0.5 flex shrink-0 items-center gap-2">
      {current && <Check className="size-3.5 text-secondary" />}
      {shortcut !== undefined && (
        <span className="min-w-2 text-right text-label-sm tabular-nums text-tertiary">{shortcut}</span>
      )}
    </span>
  )
}

// ============================================================================
// Component
// ============================================================================

interface CompactPermissionModeSelectorProps {
  permissionMode: PermissionMode
  onPermissionModeChange?: (mode: PermissionMode) => void
  permissionModeDisplays: ComposerPermissionModeMenuDisplay[]
  /**
   * The active runtime's shared caveat — `ComposerPermissionModeList.runtimeNote`,
   * the sibling of the array above. It belongs to the LIST, so it is rendered
   * once at the bottom of the drawer rather than under each row; `undefined`
   * (Nestor Cloud, no runtime — the local runtimes carry P6.492's resume
   * sentence) draws nothing at all, not an empty band.
   *
   * A caller that passes `permissionModeDisplays` and omits this shows the modes
   * without telling the user who is actually deciding on Codex.
   */
  runtimeNote?: string
  locked?: boolean
}

export function CompactPermissionModeSelector({
  permissionMode,
  onPermissionModeChange,
  permissionModeDisplays,
  runtimeNote,
  locked = false,
}: CompactPermissionModeSelectorProps) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  // Optimistic local state — updates immediately, syncs with prop
  const [optimisticMode, setOptimisticMode] = React.useState(permissionMode)

  React.useEffect(() => {
    setOptimisticMode(permissionMode)
  }, [permissionMode])

  const handleSelect = React.useCallback((mode: PermissionMode) => {
    if (locked) return
    setOptimisticMode(mode)
    onPermissionModeChange?.(mode)
    setOpen(false)
  }, [locked, onPermissionModeChange])

  // No fallback to the first row: a session in a mode the list does not offer
  // (`dontAsk`, set by config or an automation) shows THAT mode — "Don't ask" —
  // rather than borrowing whichever mode the picker happens to list first.
  // A mode this build does not know (newer server) renders as `default` instead of crashing the input.
  const activeDisplay = permissionModeDisplays.find(display => display.mode === optimisticMode)
  const shownMode = knownMode(optimisticMode)
  const iconMode = knownMode(activeDisplay?.iconMode ?? shownMode)
  const modeLabel = activeDisplay?.label ?? t(`mode.${shownMode}`)

  return (
    <Drawer open={!locked && open} onOpenChange={(nextOpen) => !locked && setOpen(nextOpen)}>
      <DrawerTrigger asChild>
        <button
          type="button"
          aria-label={`${t('chat.permissionMode')}: ${modeLabel}`}
          data-mode={shownMode}
          disabled={locked}
          className={cn(
            "input-toolbar-btn motion-press state-overlay flex h-control shrink-0 items-center justify-center gap-1.5 rounded-full px-2.5 text-label font-medium select-none",
            "@min-[24rem]/panel:pr-3",
            "disabled:pointer-events-none disabled:opacity-50",
            MODE_CHIP_TONE[iconMode],
          )}
        >
          <ModeIcon mode={iconMode} className="size-3.5 shrink-0" />
          {/* Narrow phones keep the tinted icon only (the card sits on the 16px gutter, so a 420px
              screen gives it 388px; 24rem is the narrowest card the named chip fits) so
              attach · sources · folder · mode · model · Send fit on one row; the mode name stays
              in the aria-label and the drawer. */}
          <span className="sr-only @min-[24rem]/panel:not-sr-only">{activeDisplay?.shortLabel ?? t(`mode.${shownMode}Short`)}</span>
        </button>
      </DrawerTrigger>

      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>{t('chat.permissionMode')}</DrawerTitle>
        </DrawerHeader>

        {/* Rows sit on the title's 16px edge: 8px container inset + 8px row padding */}
        <div className="px-2 pb-6 flex flex-col gap-1">
          {permissionModeDisplays.map((display) => {
            const isSelected = display.mode === optimisticMode
            return (
              <DrawerClose asChild key={display.mode}>
                <button
                  type="button"
                  className={cn(
                    "flex min-h-row-touch w-full shrink-0 items-center gap-3 rounded-md px-2 py-2.5 text-left transition-colors hover:duration-instant",
                    isSelected ? "bg-fill-selected" : "hover:bg-fill-hover active:bg-fill-pressed",
                  )}
                  onClick={() => handleSelect(display.mode)}
                >
                  <span className={cn("shrink-0", MODE_ICON_TONE[knownMode(display.iconMode)])}>
                    <ModeIcon mode={display.iconMode} className="size-5" />
                  </span>
                  <div className="flex-1 min-w-0 text-copy">
                    <PermissionModeItemTitle label={display.label} decorations={display.decorations} />
                    <div className="text-label text-tertiary">{display.description}</div>
                  </div>
                  {isSelected && (
                    <Check className="size-4 shrink-0 text-secondary" />
                  )}
                </button>
              </DrawerClose>
            )
          })}
          {runtimeNote && (
            <p
              data-permission-mode-runtime-note
              className="mt-1 border-t border-subtle px-2 pt-3 text-label text-tertiary"
            >
              {runtimeNote}
            </p>
          )}
        </div>
      </DrawerContent>
    </Drawer>
  )
}
