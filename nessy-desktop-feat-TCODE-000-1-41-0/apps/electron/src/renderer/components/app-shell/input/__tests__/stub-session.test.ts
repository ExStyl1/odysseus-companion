/**
 * D1.383 — THE COMPOSER DOES NOT ASK THE HOST ABOUT A SESSION THE RENDERER MINTED.
 *
 * `ChatInputZone` hydrates its queue with `queueGet(sessionId)` on every mount.
 * Two of its mounts are over session ids no server has ever seen: `EditPopover`'s
 * pre-session stub (`'pending'`, there since inline mode shipped) and the `/btw`
 * panel's synthetic id (one per `/btw` since D1.375). Each open therefore made a
 * round trip that can only fail, and logged `[ChatInputZone] Failed to hydrate
 * queue` for it — a console error with no defect behind it, which is the kind
 * that teaches a reader to ignore the console.
 *
 * THE DISCRIMINATOR IS A PROPERTY OF THE ID, NAMED ONCE. Both ids are minted by
 * the renderer, so this module owns both spellings and `ChatInputZone` asks it
 * rather than sniffing for `'pending'` at the call site. The pin below is what
 * keeps the constant honest: it reads `EditPopover`'s own source, so renaming
 * the stub id there without telling this module goes red here instead of going
 * quiet in production.
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { EDIT_POPOVER_STUB_SESSION_ID, isRendererMintedSessionId } from '../stub-session'
import { sideQuestionSessionId } from '../../side-question-composer'

/** Comment-stripped source, so a sentence in a docblock cannot satisfy a pin. */
function stripped(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('renderer-minted session ids (D1.383)', () => {
  it('POSITIVE: both ids the renderer mints are recognised', () => {
    expect(isRendererMintedSessionId(EDIT_POPOVER_STUB_SESSION_ID)).toBe(true)
    expect(isRendererMintedSessionId(sideQuestionSessionId('abc-123'))).toBe(true)
  })

  it('NEGATIVE: a real session id is not one of them', () => {
    // The whole point of the predicate is that it stays false for everything the
    // HOST minted — a real session must still hydrate its queue.
    for (const real of [
      'abc-123',
      '0f2a6c1e-9d3b-4a77-8c21-1b9f0e5d4a6c',
      'pending-migration',
      'my-pending',
      `real-${EDIT_POPOVER_STUB_SESSION_ID}`,
    ]) {
      expect(isRendererMintedSessionId(real)).toBe(false)
    }
    // BOUNDARY: the empty id `EditPopover` passes to `useSession` before it has
    // one. Not a minted id, and not a real one either — it must not be claimed.
    expect(isRendererMintedSessionId('')).toBe(false)
  })

  it('the stub id is the one EditPopover actually mints', () => {
    // The constant is only worth having if it cannot drift from the component
    // that mints it. `EditPopover` builds its stub session inline, so this reads
    // its source rather than importing it: importing `EditPopover` pulls the
    // renderer graph (and with it the 136 s `pdfjs`/`DOMMatrix` trap AGENTS.md
    // records) into a bare bun process, which the neighbours all decline too.
    const editPopover = stripped('../../../ui/EditPopover.tsx')
    expect(editPopover).toContain(`id: '${EDIT_POPOVER_STUB_SESSION_ID}'`)
  })
})

describe('ChatInputZone skips the hydrate for an id no server knows (D1.383)', () => {
  const zone = stripped('../ChatInputZone.tsx')

  it('POSITIVE: the guard is read, and it is the shared predicate', () => {
    expect(zone).toContain('isRendererMintedSessionId(sessionId)')
    // The guard must sit BEFORE the call it guards, inside the same effect —
    // and both anchors are below the effect's start, so a runaway region cannot
    // satisfy this by accident (AGENTS.md §Traps).
    const effect = zone.slice(zone.indexOf('sawQueueEventRef.current = false'))
    const guard = effect.indexOf('isRendererMintedSessionId(sessionId)')
    const call = effect.indexOf('window.electronAPI.queueGet(sessionId)')
    expect(guard).toBeGreaterThan(-1)
    expect(call).toBeGreaterThan(guard)
  })

  it('NEGATIVE: the skip is not a string sniff at the call site', () => {
    // The row asks for a property of the id the renderer already has, not a
    // literal here — one spelling of each minted id, in `stub-session.ts`.
    expect(zone).not.toContain("=== 'pending'")
    expect(zone).not.toContain("startsWith('side-question:')")
  })

  it('the subscription is NOT skipped — a stub session still answers its own events', () => {
    // Only the hydrate is a round trip that cannot succeed. The `queue_changed`
    // listener is local and filters by id, so leaving it alone costs nothing and
    // keeps the two mounts on the same code path as every other composer.
    const listener = zone.slice(zone.indexOf('onSessionEvent'))
    expect(listener).not.toContain('isRendererMintedSessionId')
  })
})

/**
 * F1.88 (origin D1.391) + F1.167 (origin WJ-b P-WJ-b-2) — the rest of the
 * round trips a minted id makes, counted by CHANNEL on a drive, not by grep.
 *
 * Measured 2026-09-23 on the dev playground with a recorder wrapped round the
 * mock bridge: opening `EditPopover`'s inline chat (stub `'pending'`, workspace
 * set) and mounting the `/btw` panel (synthetic id, workspace `''`), each call's
 * channel and arguments logged, and the same compact `ChatDisplay` over a
 * host-shaped id (`playground-session`) as the positive control. Per mount (the
 * dev build's StrictMode doubles each), against the minted id:
 *
 *  - `getPendingPlanExecution`       — both mounts; `FreeFormInput`'s reload
 *    recovery. The host answers `null` for an unknown id.
 *  - `getSessionCapabilityInventory` — both mounts; `SessionCapabilityInventoryNotice`.
 *    The host answers `[]` for an unknown id.
 *  - `getPiHarnessRuntime`           — `EditPopover` only (the `/btw` id carries
 *    no workspace, so `useAgentPanel` already declined); `ChatDisplay`'s agent
 *    panel. The host THROWS `session-not-found` — the one FAILED call; the hook
 *    swallows it.
 *
 * The control answered all three for `playground-session`, plus `queueGet`,
 * which D1.383 already skips for a minted id. The four components D1.391 named —
 * `ActiveOptionBadges`, `BranchSwitcher`, `InputErrorBoundary`,
 * `WorkingDirectoryBadge` — made NO call in either minted mount: three are not
 * rendered in compact mode at all (pinned below) and the boundary makes none.
 * Each of the three channels is one guard at the site that makes the call.
 */
describe('the other round trips a minted id made (F1.88 + F1.167)', () => {
  /** The guard must sit inside the effect that makes the call, and before it. */
  function guardPrecedesCall(source: string, guard: string, call: string, effectOpener: string) {
    const callAt = source.indexOf(call)
    expect(callAt).toBeGreaterThan(-1)
    const effectAt = source.lastIndexOf(effectOpener, callAt)
    expect(effectAt).toBeGreaterThan(-1)
    // Positive control on the region: one effect, not a runaway past its brace.
    expect(callAt - effectAt).toBeLessThan(2_000)
    const guardAt = source.indexOf(guard, effectAt)
    expect(guardAt).toBeGreaterThan(effectAt)
    expect(guardAt).toBeLessThan(callAt)
  }

  it('getPendingPlanExecution — FreeFormInput’s reload recovery never asks for a minted id', () => {
    guardPrecedesCall(
      stripped('../FreeFormInput.tsx'),
      'if (!sessionId || isRendererMintedSessionId(sessionId)) return',
      'window.electronAPI.getPendingPlanExecution(sessionId)',
      'React.useEffect(() => {',
    )
  })

  it('getSessionCapabilityInventory — the inventory notice never asks for a minted id', () => {
    guardPrecedesCall(
      stripped('../../SessionCapabilityInventoryNotice.tsx'),
      'if (isRendererMintedSessionId(sessionId))',
      'window.electronAPI.getSessionCapabilityInventory(sessionId)',
      'useEffect(() => {',
    )
  })

  it('getPiHarnessRuntime — ChatDisplay hands the agent panel no minted id', () => {
    const display = stripped('../../ChatDisplay.tsx')
    expect(display).toContain(
      "useAgentPanel(session && !isRendererMintedSessionId(session.id) ? session.id : '', session?.workspaceId ?? '')",
    )
    // …and the hook's own early return is what turns the empty id into no call.
    expect(stripped('../../../../hooks/useAgentPanel.ts')).toContain('if (!sessionId || !workspaceId) return')
  })

  it('CONTROL — the four components D1.391 named are not rendered in compact mode (why they made no call)', () => {
    const zone = stripped('../ChatInputZone.tsx')
    expect(zone).toContain('const shouldShowOptionBadges = showOptionBadges ?? !compactMode')
    // UB14.31 moved `WorkingDirectoryBadge` and `BranchSwitcher` out of ChatInputZone's footer row into
    // FreeFormInput's toolbar; since UB14.32's one toolbar they mount only on its desktop (`!compactMode`) arms:
    // the badge as the folder ternary's second arm, the branch chip behind `composerMountsBranchChip`, which refuses
    // compact first (UB12.77).
    const input = stripped('../FreeFormInput.tsx')
    const compactArmAt = input.indexOf('(compactMode ? (\n            <CompactWorkingDirectorySelector')
    const desktopArmAt = input.indexOf(') : (\n            <WorkingDirectoryBadge', compactArmAt)
    expect({ compactArm: compactArmAt > -1, badgeOnDesktopArm: desktopArmAt > compactArmAt }).toEqual({ compactArm: true, badgeOnDesktopArm: true })
    expect(input.match(/<WorkingDirectoryBadge\b/g)).toHaveLength(1)
    expect(input.match(/<BranchSwitcher\b/g)).toHaveLength(1)
    // UB12.78 — the gate is read once into `mountsBranchChip` (the mount and the left group's floor share it).
    expect(input).toContain('const mountsBranchChip = composerMountsBranchChip({ compactMode, canChangeWorkingDirectory: !!onWorkingDirectoryChange, workspaceId, sessionId, capabilities: composerCapabilities })')
    expect(input).toContain('{mountsBranchChip && sessionId && (\n            <BranchSwitcher')
    // Neither minted mount passes `showOptionBadges`, so the badges stay off.
    expect(stripped('../../../ui/EditPopover.tsx')).not.toContain('showOptionBadges')
    expect(stripped('../../SideQuestionOverlay.tsx')).not.toContain('showOptionBadges')
  })
})
