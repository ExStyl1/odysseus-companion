/**
 * Source: v0.15.1:apps/electron/src/renderer/components/app-shell/input/composer-styles.ts (UB14.20; ADDED in v0.15.0).
 * Taken (Apache-2.0), then re-keyed: `MODE_CHIP_TONE`, `MODE_ICON_TONE` and `knownMode` name OUR six permission
 * modes (`PERMISSION_MODE_ORDER` in `@nessy-agent/shared/agent/modes`) instead of upstream's four
 * (`safe|ask|guarded|allow-all`). Each mode keeps the tone our selector gives it today
 * (`CompactPermissionModeSelector.tsx` `MODE_STYLES`: dontAsk neutral, plan accent, default info, acceptEdits
 * success, auto info, bypassPermissions accent), written in upstream's role classes. An unknown mode falls back
 * to `'default'` (upstream: `'ask'`, its "needs you" mode; ours is `default`, labelled "Manual"). Our selectors
 * have no unknown-mode arm today (`MODE_STYLES[mode]` is simply absent); the chip that reads this (UB14.29)
 * gains it. `COMPOSER_CHIP` and `COMPOSER_META_CHIP` are upstream's verbatim. `COMPOSER_STATIC_META_CHIP` is ours
 * (UB14.55): upstream's meta chip minus its press and hover, for the chips in the row above the composer that nothing
 * can press (the D1.97/D1.98 scheduled-work chips, UB14.7; the P6.502/P6.940 session-fact chips).
 */
import type { PermissionMode } from '@nessy-agent/shared/agent/modes'

/**
 * Shared composer materials (design spec §7.5, mockup `.composer` / `.cx-bar`).
 * Role utilities only — no palette colors, literal shadows or durations.
 */

/**
 * Toolbar chip (mockup `.cx-bar .chip-btn`): 28px ghost pill, secondary label, tertiary icon.
 * `input-toolbar-btn` is the compact hook in index.css (36px targets ≤ 768px).
 * `motion-press`: hover-in instant, hover-out 100ms, press .97.
 */
export const COMPOSER_CHIP = [
  'input-toolbar-btn motion-press inline-flex h-control min-w-0 items-center gap-1.5 rounded-full px-2',
  'text-label font-medium text-secondary select-none',
  'hover:bg-fill-hover hover:text-foreground data-[state=open]:bg-fill-hover data-[state=open]:text-foreground',
  'disabled:pointer-events-none disabled:text-disabled',
  "[&_svg:not([class*='text-'])]:text-tertiary",
].join(' ')

/**
 * Permission-mode chip tones, keyed to our six modes: Don't ask neutral, Manual (`default`) and Auto
 * "needs you" info, Accept edits success, Plan and Bypass permissions accent. Text roles are
 * contrast-solved on their own tints.
 */
export const MODE_CHIP_TONE: Record<PermissionMode, string> = {
  dontAsk: 'bg-fill-hover text-secondary',
  plan: 'bg-accent-tint text-accent',
  default: 'bg-info-tint text-info',
  acceptEdits: 'bg-success-tint text-success',
  auto: 'bg-info-tint text-info',
  bypassPermissions: 'bg-accent-tint text-accent',
}

/** Icon tone for the same modes when shown on a neutral row (menus, drawers). */
export const MODE_ICON_TONE: Record<PermissionMode, string> = {
  dontAsk: 'text-secondary',
  plan: 'text-accent',
  default: 'text-info',
  acceptEdits: 'text-success',
  auto: 'text-info',
  bypassPermissions: 'text-accent',
}

/** A mode this build does not know (newer server) is shown as `default` (Manual), the mode that asks. */
export function knownMode(mode: PermissionMode): PermissionMode {
  return Object.hasOwn(MODE_CHIP_TONE, mode) ? mode : 'default'
}

/**
 * Quiet metadata chip for the row above the composer (status, labels, Info, background tasks):
 * 24px, opaque raised fill + hairline so stacked chips never show through each other.
 */
export const COMPOSER_META_CHIP = [
  'motion-press state-overlay inline-flex h-control-sm shrink-0 items-center gap-1.5 rounded-full px-2.5',
  'bg-raised text-label-sm font-medium text-secondary ring-1 ring-inset ring-border select-none',
  'data-[state=open]:text-foreground',
].join(' ')

/**
 * Ours (UB14.55): the same quiet chip with nothing to press — `COMPOSER_META_CHIP` without `motion-press`,
 * `state-overlay` and the open state, so a static fact never looks pressable. One definition for the scheduled-work
 * chips (`ActiveTasksBar`) and the session-fact chips (`SessionFactChip`).
 */
export const COMPOSER_STATIC_META_CHIP = [
  'inline-flex h-control-sm shrink-0 items-center gap-1.5 rounded-full px-2.5',
  'bg-raised text-label-sm font-medium text-secondary ring-1 ring-inset ring-border select-none',
].join(' ')
