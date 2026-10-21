import type { ComposerCapabilities, GitBranchesResult, GitCheckoutResult } from '@nessy-agent/shared/protocol'

/**
 * Pure state helpers for the composer branch switcher (and the toolbar floor its
 * chip widens, UB12.78), kept free of React/UI imports so they can be unit-tested
 * without pulling the component's heavy dependency barrel (which loads a pdfjs
 * worker URL under `bun test`).
 */

/**
 * i18n key explaining why the switcher is disabled for a non-`ok` listing.
 * `null` when the listing is healthy or still loading — no explanation needed.
 */
export function branchUnavailableReasonKey(
  data: GitBranchesResult | undefined,
): string | null {
  if (!data) return null
  switch (data.status) {
    case 'no-cwd':
      return 'chat.branch.noWorkingDir'
    case 'not-a-repo':
      return 'chat.branch.noRepo'
    case 'error':
      return 'chat.branch.unavailable'
    default:
      return null
  }
}

/** The UI action the switcher must take for a given checkout result. */
export type BranchCheckoutAction =
  | { kind: 'dirty-confirm' }
  | { kind: 'error'; message: string }
  | { kind: 'success' }
  | { kind: 'success-stash-conflict' }

/**
 * Map a {@link GitCheckoutResult} to the UI action. Pure and exhaustive so the
 * dirty-tree confirm affordance, friendly-error path, and surfaced stash-pop
 * conflict are unit-testable without rendering.
 */
export function checkoutResultAction(result: GitCheckoutResult): BranchCheckoutAction {
  if (result.status === 'dirty') return { kind: 'dirty-confirm' }
  if (result.status === 'error') return { kind: 'error', message: result.error ?? '' }
  if (result.stashPopConflict) return { kind: 'success-stash-conflict' }
  return { kind: 'success' }
}

/**
 * UB12.77 — whether the composer mounts the branch chip: desktop toolbar only (compact never had it), only where the
 * folder chip can change the folder and the session is known, and only when the server says this session may show it
 * (`ComposerCapabilities.externalFooter.gitBranch`; that field's docblock says why it keeps its footer-era name).
 * FreeFormInput's one `<BranchSwitcher>` mount reads this, so the capability and the chip cannot drift apart.
 */
export function composerMountsBranchChip(gate: {
  compactMode: boolean | undefined
  canChangeWorkingDirectory: boolean
  workspaceId: string | undefined
  sessionId: string | undefined
  capabilities: Pick<ComposerCapabilities, 'externalFooter'>
}): boolean {
  return !gate.compactMode
    && gate.canChangeWorkingDirectory
    && !!gate.workspaceId
    && !!gate.sessionId
    && gate.capabilities.externalFooter.gitBranch
}

/** v0.15.1's desktop floor for the toolbar's left group, verbatim: "the three icons (96px)" — attach · sources · folder. */
export const COMPOSER_LEFT_FLOOR_THREE_ICONS = 'min-w-[clamp(0px,calc(100%-11rem),6rem)]'
/** Ours (UB12.78): the same floor for FOUR icons, upstream's 2rem per icon plus one for the branch chip. */
export const COMPOSER_LEFT_FLOOR_FOUR_ICONS = 'min-w-[clamp(0px,calc(100%-11rem),8rem)]'

/**
 * UB12.78 — the desktop toolbar left group's `min-width` floor. v0.15.1 sized it for its three icons (6rem); where
 * {@link composerMountsBranchChip} mounts our branch chip the group holds four, so the floor is four icons (8rem).
 * Measured offline in Chrome on the playground's own markup (2026-10-17): with a long model name at the narrowest
 * product composer (440 px panel − 2×24 px gutter = 392 px) the 6rem floor let the four chips shrink below their icons
 * (the folder icon 63% visible), where upstream's three chips keep 96%; at 8rem every icon is ≥ 97% visible. Upstream's
 * `100% − 11rem` term is unchanged, so the floor still gives way before Send can leave the card. The floor follows the
 * mount gate, not the chip's first paint: the chip draws nothing only while its first branch listing is in flight.
 */
export function composerLeftGroupFloor(mountsBranchChip: boolean): string {
  return mountsBranchChip ? COMPOSER_LEFT_FLOOR_FOUR_ICONS : COMPOSER_LEFT_FLOOR_THREE_ICONS
}
