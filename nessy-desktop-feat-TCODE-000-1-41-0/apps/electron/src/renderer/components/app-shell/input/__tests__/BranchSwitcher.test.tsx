/**
 * BranchSwitcher Tier-1 states:
 *  - disabled/explained affordance (not hidden) when there is no repo / no cwd /
 *    a git error — one i18n key per reason;
 *  - dirty-tree checkout returns a confirm affordance (never mutates by default);
 *  - a git error maps to the friendly message toast, not a raw stderr dump;
 *  - an auto-stash success whose pop conflicted is surfaced.
 *
 * The state decisions live in the pure `branch-switcher-helpers` module and are
 * tested directly; the toast wiring is asserted at source level. Since UB14.31 the
 * component imports only barrel-free subpaths (its Tooltip from `ui/tooltip`), so
 * the chip itself is rendered too: `renderToStaticMarkup` (no DOM, no effects),
 * seeded through `initialBranches` because a static render never runs the fetch.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { TooltipProvider } from '@nessy-agent/ui/ui/tooltip'
import { LOCALE_REGISTRY } from '@nessy-agent/shared/i18n'
import type { GitBranchesResult, GitCheckoutResult } from '@nessy-agent/shared/protocol'
import {
  branchUnavailableReasonKey,
  checkoutResultAction,
  COMPOSER_LEFT_FLOOR_FOUR_ICONS,
  COMPOSER_LEFT_FLOOR_THREE_ICONS,
  composerLeftGroupFloor,
  composerMountsBranchChip,
} from '../branch-switcher-helpers'
import { BranchSwitcher } from '../BranchSwitcher'
import { DEFAULT_COMPOSER_CAPABILITIES } from '../composer-capabilities-context'

const source = readFileSync(
  fileURLToPath(new URL('../BranchSwitcher.tsx', import.meta.url)),
  'utf8',
)

describe('branchUnavailableReasonKey — disabled/explained state (G2/G5)', () => {
  it('maps each non-ok listing to a distinct explanation key', () => {
    expect(branchUnavailableReasonKey({ status: 'no-cwd' })).toBe('chat.branch.noWorkingDir')
    expect(branchUnavailableReasonKey({ status: 'not-a-repo' })).toBe('chat.branch.noRepo')
    expect(branchUnavailableReasonKey({ status: 'error', error: 'fatal: bad object' }))
      .toBe('chat.branch.unavailable')
  })

  it('returns null for a healthy listing and while loading (no explanation needed)', () => {
    const ok: GitBranchesResult = { status: 'ok', current: 'main', branches: ['main'] }
    expect(branchUnavailableReasonKey(ok)).toBeNull()
    expect(branchUnavailableReasonKey(undefined)).toBeNull()
  })
})

describe('checkoutResultAction — checkout result → UI action (G1/G5)', () => {
  it('dirty → confirm affordance, never a silent mutation', () => {
    expect(checkoutResultAction({ status: 'dirty' })).toEqual({ kind: 'dirty-confirm' })
  })

  it('error → friendly message action carrying the git message (not a raw dump into a toast)', () => {
    const result: GitCheckoutResult = { status: 'error', error: 'pathspec did not match' }
    expect(checkoutResultAction(result)).toEqual({ kind: 'error', message: 'pathspec did not match' })
    // Missing message falls back to empty string rather than "undefined".
    expect(checkoutResultAction({ status: 'error' })).toEqual({ kind: 'error', message: '' })
  })

  it('plain success → success action', () => {
    expect(checkoutResultAction({ status: 'success' })).toEqual({ kind: 'success' })
  })

  it('success with a stash-pop conflict → surfaced as a distinct action', () => {
    expect(checkoutResultAction({ status: 'success', stashPopConflict: true }))
      .toEqual({ kind: 'success-stash-conflict' })
  })
})

describe('BranchSwitcher wiring (source-level invariants)', () => {
  it('renders a disabled, explained affordance instead of returning null on non-repo', () => {
    // The only bare `return null` is the loading guard; the non-ok branch renders
    // a disabled button inside a Tooltip that shows the unavailable reason.
    expect(source).toContain('const unavailableReason = unavailableReasonKey ? t(unavailableReasonKey) : null')
    expect(source).toContain('disabled')
    expect(source).toContain('<TooltipContent')
    expect(source).toContain('{unavailableReason}')
  })

  it('offers an explicit stash-and-switch confirm for a dirty tree (auto-stash on confirm only)', () => {
    expect(source).toContain("case 'dirty-confirm':")
    expect(source).toContain("label: t('chat.branch.stashAndSwitch')")
    expect(source).toContain('onClick: () => void checkout(branch, true)')
  })

  it('surfaces a stash-pop conflict rather than swallowing it', () => {
    expect(source).toContain("case 'success-stash-conflict':")
    expect(source).toContain("t('chat.branch.stashPopConflict')")
  })

  it('passes the autoStash flag through the gitCheckout IPC', () => {
    expect(source).toContain('window.electronAPI.gitCheckout(sessionId, branch, autoStash)')
  })
})

/**
 * UB14.31 — the chip moved from the footer row under the card into the composer toolbar, on v0.15.1's chip
 * material (`COMPOSER_CHIP`), with its label and chevron as `data-badge-label` so a narrow panel folds it to the
 * icon like its neighbours. Rendered for real; `initialBranches` stands in for the fetch a static render never runs.
 */
describe('BranchSwitcher on the composer chip material (UB14.31)', () => {
  const EN = LOCALE_REGISTRY.en.messages as Record<string, string>
  let testI18n: I18nInstance
  beforeAll(async () => {
    testI18n = createInstance()
    await testI18n.use(initReactI18next).init({
      lng: 'en',
      fallbackLng: 'en',
      keySeparator: false,
      resources: { en: { translation: EN } },
      interpolation: { escapeValue: false },
    })
  })
  const render = (initialBranches?: GitBranchesResult) => renderToStaticMarkup(
    <I18nextProvider i18n={testI18n}>
      <TooltipProvider>
        <BranchSwitcher sessionId="s-1" {...(initialBranches ? { initialBranches } : {})} />
      </TooltipProvider>
    </I18nextProvider>,
  )
  const buttonTag = (markup: string): string => {
    const tags = markup.match(/<button[^>]*>/g) ?? []
    expect(tags).toHaveLength(1)
    return tags[0]!
  }
  /** The chip's own material, as `COMPOSER_CHIP` spells it (`composer-styles.ts`). */
  const CHIP_PARTS = ['input-toolbar-btn', 'motion-press', 'h-control', 'rounded-full', 'text-label', 'max-w-40']

  it('POSITIVE — a repo: the chip names the current branch in a foldable label, with a foldable chevron', () => {
    const markup = render({ status: 'ok', current: 'feat/TCODE-000', branches: ['main', 'feat/TCODE-000'] })
    const tag = buttonTag(markup)
    for (const part of CHIP_PARTS) expect({ part, inTag: tag.includes(part) }).toEqual({ part, inTag: true })
    expect(tag).toContain('aria-label="feat/TCODE-000"')
    expect(tag).not.toContain('disabled=""')
    expect(tag).toContain('aria-haspopup="menu"')
    expect(markup).toMatch(/<span data-badge-label="true" class="[^"]*truncate[^"]*">feat\/TCODE-000<\/span>/)
    expect(markup.match(/data-badge-label="true"/g)).toHaveLength(2) // the name and the chevron fold together
    // The pre-UB14.31 footer look is gone.
    for (const old of ['rounded-[6px]', 'text-[13px]', 'h-6 ']) expect({ old, inTag: tag.includes(old) }).toEqual({ old, inTag: false })
  })

  it('NEGATIVE (control) — no repo: the same chip, disabled but still pointable (its tooltip says why), named "Branch"', () => {
    const tag = buttonTag(render({ status: 'not-a-repo' }))
    for (const part of CHIP_PARTS) expect(tag).toContain(part)
    expect(tag).toContain('disabled=""')
    expect(tag).toContain('aria-disabled="true"')
    expect(tag).toContain(`aria-label="${EN['chat.branch.label']}"`)
    // COMPOSER_CHIP's `disabled:pointer-events-none` would silence the explaining tooltip; the override wins.
    expect(tag).toContain('disabled:pointer-events-auto')
    expect(tag).not.toContain('disabled:pointer-events-none')
  })

  it('BOUNDARY — before the first listing answers the chip draws nothing (no flicker)', () => {
    expect(render()).toBe('')
  })
})

/**
 * UB12.77 — the capability that gates the chip. `ComposerCapabilities.externalFooter` kept its footer-era name (an
 * older 1.x renderer reads `externalFooter.gitBranch` unguarded) and lost its never-read `workingDir` half; what is
 * left, `gitBranch`, decides whether FreeFormInput's one `<BranchSwitcher>` mount happens, through
 * `composerMountsBranchChip` (the mount's source pins: composer-sources-chip.test.tsx, stub-session.test.ts).
 */
describe('composerMountsBranchChip — the branch chip follows externalFooter.gitBranch (UB12.77)', () => {
  const desktop = (gitBranch: boolean) => ({
    compactMode: false,
    canChangeWorkingDirectory: true,
    workspaceId: 'ws-1',
    sessionId: 's-1',
    capabilities: { externalFooter: { gitBranch } },
  })

  it('POSITIVE — the desktop toolbar mounts the chip when the server answers gitBranch: true, and the fallback answers it too', () => {
    expect(composerMountsBranchChip(desktop(true))).toBe(true)
    // The renderer's fallback before the server answers keeps the chip (unchanged since 1.0.1), and carries no
    // `workingDir` any more.
    expect(DEFAULT_COMPOSER_CAPABILITIES.externalFooter).toEqual({ gitBranch: true })
    expect(composerMountsBranchChip({ ...desktop(true), capabilities: DEFAULT_COMPOSER_CAPABILITIES })).toBe(true)
  })

  it('NEGATIVE (control) — a provider answering gitBranch: false mounts no chip, on an otherwise mounting composer', () => {
    expect(composerMountsBranchChip(desktop(false))).toBe(false)
  })

  it('BOUNDARY — compact, no folder callback, no workspace or no session each refuse, whatever the capability says', () => {
    for (const [name, gate] of [
      ['compact', { ...desktop(true), compactMode: true }],
      ['no folder callback', { ...desktop(true), canChangeWorkingDirectory: false }],
      ['no workspace', { ...desktop(true), workspaceId: undefined }],
      ['no session', { ...desktop(true), sessionId: undefined }],
      ['empty session id', { ...desktop(true), sessionId: '' }],
    ] as const) {
      expect({ name, mounts: composerMountsBranchChip(gate) }).toEqual({ name, mounts: false })
    }
    // compactMode left undefined is the desktop default (FreeFormInput defaults it to false).
    expect(composerMountsBranchChip({ ...desktop(true), compactMode: undefined })).toBe(true)
  })
})

/**
 * UB12.78 — the toolbar left group's floor. v0.15.1 sized it for three icons (6rem: attach · sources · folder); our
 * branch chip is a fourth, so where it mounts the floor is four icons (8rem). The geometry was measured offline in
 * Chrome on the playground's markup (the helper's docblock has the readings); these arms pin the classes the
 * measurement priced. The mount and the floor read ONE `mountsBranchChip` (the source pins: composer-sources-chip
 * and stub-session tests), and the playground sweep reads both floors in dark (registry-render.test.ts, UB12.78).
 */
describe('composerLeftGroupFloor — four icons where the branch chip mounts (UB12.78)', () => {
  /** The pixel floor a class encodes (1rem = 16px) and the room it always leaves for mode · model · context · Send. */
  const parse = (floor: string) => {
    const match = /^min-w-\[clamp\(0px,calc\(100%-(\d+)rem\),(\d+)rem\)\]$/.exec(floor)
    return match ? { reservedPx: Number(match[1]) * 16, floorPx: Number(match[2]) * 16 } : null
  }

  it('POSITIVE — a mounted branch chip widens the floor to four icons (128px), upstream\'s 11rem reserve unchanged', () => {
    expect(composerLeftGroupFloor(true)).toBe(COMPOSER_LEFT_FLOOR_FOUR_ICONS)
    expect(parse(composerLeftGroupFloor(true))).toEqual({ reservedPx: 176, floorPx: 128 })
    // Upstream's 2rem per icon: the fourth chip adds exactly one icon's worth.
    expect(parse(COMPOSER_LEFT_FLOOR_FOUR_ICONS)!.floorPx - parse(COMPOSER_LEFT_FLOOR_THREE_ICONS)!.floorPx)
      .toBe(parse(COMPOSER_LEFT_FLOOR_THREE_ICONS)!.floorPx / 3)
  })

  it('NEGATIVE (control) — without the branch chip the floor is v0.15.1\'s three-icon class, verbatim', () => {
    expect(composerLeftGroupFloor(false)).toBe('min-w-[clamp(0px,calc(100%-11rem),6rem)]')
    expect(parse(composerLeftGroupFloor(false))).toEqual({ reservedPx: 176, floorPx: 96 })
    // The gate that decides it: compact (and every other refusal) keeps upstream's floor.
    const gate = { compactMode: true, canChangeWorkingDirectory: true, workspaceId: 'ws-1', sessionId: 's-1', capabilities: { externalFooter: { gitBranch: true } } }
    expect(composerLeftGroupFloor(composerMountsBranchChip(gate))).toBe(COMPOSER_LEFT_FLOOR_THREE_ICONS)
    expect(composerLeftGroupFloor(composerMountsBranchChip({ ...gate, compactMode: false }))).toBe(COMPOSER_LEFT_FLOOR_FOUR_ICONS)
  })
})
