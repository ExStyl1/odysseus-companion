/**
 * Source: v0.15.1:apps/electron/src/renderer/components/app-shell/input/ComposerModeChip.tsx (UB14.29; ADDED in v0.15.0).
 * ADAPTED (Apache-2.0). Taken: the trigger (a tinted 28px pill keyed by `MODE_CHIP_TONE`, `data-mode`, the
 * "Permission mode: <mode>" name, icon-only under a 32rem panel), the floating material and placement (`side="top"`,
 * `sideOffset={6}`), the focus hand-back to the composer on close, and the footer naming the cycle shortcut with its
 * keycaps. The menu CONTENT stays ours (R4-09):
 * - the rows are `permissionModeMenuDisplays` — the runtime's list narrowed by the workspace cycle (P2.56), each with
 *   F1.1052's Recommended/Default badges, its digit and the check (`PermissionModeItemTitle` / `…Trailing`);
 * - each description wraps inside R15's measured 440px column instead of truncating to one line;
 * - `1`…`9` select a row while the menu is open (`selectPermissionModeByDigit`);
 * - the active runtime's caveat is drawn ONCE, under the rows (`runtimeNote`, R15);
 * - `locked` (the capability set) disables the trigger and the menu never opens.
 * Not taken: upstream's `useAvailablePermissionModes` (its Guarded mode and decision-model feature — our list comes
 * from the capability set), its filter input (a focused filter would swallow the digit shortcuts) and its
 * `SlashCommandMenu bare showDescriptions` body (one truncated line per mode, no badges or digits). R4-09's own rule:
 * without those in R6's port the menu keeps `StyledDropdownMenuContent` on upstream's menu tokens — the same
 * `popover-styled` surface upstream's `PopoverContent` wears, and a Radix menu, so rows stay `menuitem`s that arrow
 * keys, Enter and the digit handler reach.
 * Placement: upstream's `align="end"`, now that the chip sits in the toolbar's right-hand mode · model group (UB14.32
 * moved it there; UB12.110 flipped the `align="start"` UB14.29 had kept while the chip led the LEFT group).
 */
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { PermissionMode } from '@nessy-agent/shared/agent/modes'
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import {
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
  StyledDropdownMenuSeparator,
} from '@/components/ui/styled-dropdown'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { INLINE_MENU_FOOTER } from '@/components/ui/inline-menu-styles'
import { PermissionModeIcon } from '@/components/ui/slash-command-menu'
import {
  selectPermissionModeByDigit,
  type ComposerPermissionModeMenuDisplay,
} from '@/lib/composer-permission-modes'
import { cn } from '@/lib/utils'
import { actionHotkeyKeys, hotkeyKeycaps } from './action-hotkey'
import { MODE_CHIP_TONE, knownMode } from './composer-styles'
import { PermissionModeItemTitle, PermissionModeItemTrailing } from './CompactPermissionModeSelector'

export interface ComposerModeChipProps {
  /** The session's mode, already coerced against what the runtime can honour (`FreeFormInput`'s `effectivePermissionMode`). */
  permissionMode: PermissionMode
  onPermissionModeChange?: (mode: PermissionMode) => void
  /** The rows the menu renders, in order, with their F1.1052 decorations (`permissionModeMenuDisplays`). */
  permissionModeDisplays: ComposerPermissionModeMenuDisplay[]
  /** The active runtime's shared caveat (`ComposerPermissionModeList.runtimeNote`); `undefined` draws no band. */
  runtimeNote?: string
  /** `ComposerCapabilities.permissions.locked`: the trigger is disabled and the menu never opens. */
  locked?: boolean
  sessionId?: string
  /**
   * The cycle action's binding as the registry resolves it (`getHotkey('chat.cyclePermissionMode')`, which reads the
   * user's override, P6.49). Omitted: the shipped default (the playground renders outside the registry). `null`: the
   * user unbound it, so the footer names no shortcut.
   */
  cycleHotkey?: string | null
  /** Start with the menu open (the playground's open state). A locked chip ignores it. */
  defaultOpen?: boolean
}

export function ComposerModeChip({
  permissionMode,
  onPermissionModeChange,
  permissionModeDisplays,
  runtimeNote,
  locked = false,
  sessionId,
  cycleHotkey,
  defaultOpen = false,
}: ComposerModeChipProps) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(defaultOpen)
  // Optimistic local state - updates immediately, syncs with prop (upstream)
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

  // A session in a mode the list does not offer (`dontAsk`, set by config or an automation; D1.327) is named by
  // THAT mode, never by the first row. A mode this build does not know draws as `default` (Manual).
  const activeDisplay = permissionModeDisplays.find(display => display.mode === optimisticMode)
  const shownMode = knownMode(optimisticMode)
  const toneMode = knownMode(activeDisplay?.iconMode ?? shownMode)
  const modeLabel = activeDisplay?.label ?? t(`mode.${shownMode}`)
  const cycleKeys = cycleHotkey === undefined ? actionHotkeyKeys('chat.cyclePermissionMode') : hotkeyKeycaps(cycleHotkey)

  return (
    <DropdownMenu open={!locked && open} onOpenChange={(nextOpen) => { if (!locked) setOpen(nextOpen) }}>
      <DropdownMenuTrigger asChild disabled={locked}>
        <button
          type="button"
          data-tutorial="permission-mode-dropdown"
          data-mode={shownMode}
          aria-label={`${t('chat.permissionMode')}: ${modeLabel}`}
          className={cn(
            // Narrow panels: icon only (the mode stays in the aria-label and the tint)
            'input-toolbar-btn motion-press state-overlay inline-flex h-control shrink-0 items-center gap-1.5 rounded-full px-2 @min-[32rem]/panel:pr-2.5',
            'text-label font-medium select-none',
            // Locked keeps the tone, so the chip still says WHICH mode is fixed.
            'disabled:pointer-events-none disabled:opacity-50',
            MODE_CHIP_TONE[toneMode],
          )}
        >
          <PermissionModeIcon mode={toneMode} className="size-3.5 shrink-0" />
          <span className="@max-[32rem]/panel:hidden">{modeLabel}</span>
        </button>
      </DropdownMenuTrigger>
      <StyledDropdownMenuContent
        side="top"
        align="end"
        sideOffset={6}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          // Don't auto-focus the text input on touch devices — it pulls up the virtual keyboard
          const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0
          if (!isTouchDevice) {
            window.dispatchEvent(new CustomEvent('nessy:focus-input', {
              detail: { sessionId },
            }))
          }
        }}
        /*
          `max-w-(--radix-…-available-width)` is the collision-aware ceiling: at the 800px minimum window the 440px
          description column below would otherwise push the menu wider than the space Radix has for it, and the
          content is `overflow-x-hidden`, so the overflow would be CLIPPED with no ellipsis rather than wrapped.
        */
        className="min-w-[240px] max-w-(--radix-dropdown-menu-content-available-width)"
        onKeyDown={selectPermissionModeByDigit}
      >
        {permissionModeDisplays.map((display) => (
          <StyledDropdownMenuItem
            key={display.mode}
            data-permission-mode-shortcut={display.decorations?.shortcut}
            onSelect={() => handleSelect(display.mode)}
            className="items-start gap-2 py-1.5"
          >
            <PermissionModeIcon mode={display.iconMode} className="mt-px size-4 shrink-0" />
            <span className="min-w-0 flex-1">
              <PermissionModeItemTitle label={display.label} decorations={display.decorations} />
              {/*
                R15 — `max-w` + `whitespace-normal` because the menu this sits in is `w-fit whitespace-nowrap
                overflow-x-hidden` (`StyledDropdownMenuContent`), and `white-space` inherits. A description that grew
                past the previous worst case widened the whole dropdown, and once it hit the viewport the tail was
                CLIPPED with no ellipsis.

                280px → 440px on 2026-08-17, and the number is MEASURED, not chosen: it is the width at which every
                mode's one-line description fits on one line in both locales. The binding string is Russian `plan`
                on Codex — `mode.planFullDesc` plus its runtime clause — at 411 CSS px of 12px (`text-xs`, now
                `text-label-sm`) text; English `plan` is 401px. Anything below ~415px puts one of those onto a
                second line again. At 280px, FIVE of the six modes wrapped even on Pi (measured: 63.8px rows against
                48.8px for the one that fit), and on Codex all six ran three to four lines.
              */}
              <span className="block max-w-[440px] whitespace-normal text-label-sm text-tertiary">{display.description}</span>
            </span>
            <PermissionModeItemTrailing current={display.mode === optimisticMode} shortcut={display.decorations?.shortcut} />
          </StyledDropdownMenuItem>
        ))}
        {/*
          The active runtime's caveat, ONCE. It used to be appended to every item's description — one fact about the
          runtime, printed six times, which is what made this menu a wall of text (564px tall on Codex against 384px
          on Pi). It is a plain element and not a `StyledDropdownMenuItem` on purpose: it is not selectable, and
          Radix's keyboard navigation skips a child that is not an item. Rendered only when there IS a note (the three
          local runtimes carry P6.492's resume sentence, codex its own caveat first; Nestor Cloud and a runtime-less
          capability set carry none), so no empty band. The cycle-shortcut footer below is upstream's, also a plain
          element.
        */}
        {runtimeNote && (
          <>
            <StyledDropdownMenuSeparator />
            <p
              data-permission-mode-runtime-note
              className="max-w-[440px] whitespace-normal px-2 pb-1 text-caption font-normal text-tertiary"
            >
              {runtimeNote}
            </p>
          </>
        )}
        {cycleKeys.length > 0 && (
          <>
            <StyledDropdownMenuSeparator className="mb-0" />
            <div data-permission-mode-cycle-hint className={cn(INLINE_MENU_FOOTER, '-mx-1 -mb-1')}>
              <span className="flex-1">{t('shortcuts.action.cyclePermissionMode')}</span>
              <KbdGroup>
                {cycleKeys.map((key) => <Kbd key={key}>{key}</Kbd>)}
              </KbdGroup>
            </div>
          </>
        )}
      </StyledDropdownMenuContent>
    </DropdownMenu>
  )
}
