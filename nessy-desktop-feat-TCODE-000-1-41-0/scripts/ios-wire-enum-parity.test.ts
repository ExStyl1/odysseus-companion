/**
 * The CI reader for `ios-wire-enum-parity.ts`.
 *
 * It is a `bun test` file and not only a `--check` script because CI runs
 * `bun test` on every pipeline (the `test` job, `.branch-rules`, no `changes`
 * filter) and does NOT run `validate:ci`. A check CI never executes is the exact
 * failure mode the checker exists to prevent — `apps/ios` already had drift
 * tests, and one reason they missed `worktree_setup` is that `swift test` only
 * runs under `changes: apps/ios/**`, which the causing commit did not touch.
 *
 * The verdict, the registry and the reasoning all live in the module. Run it
 * without a test runner for the same answer: `bun scripts/ios-wire-enum-parity.ts`.
 */

import { describe, expect, it } from 'bun:test'
import {
  EXEMPT,
  MIRRORS,
  discoverSwiftWireEnums,
  findWireEnumDivergences,
  swiftWireHalves,
} from './ios-wire-enum-parity'

/**
 * An explicit budget, set against a MEASURED floor rather than left at the 5 s
 * default — which this file exceeded, as a timeout with ZERO assertion
 * failures, on 2026-09-04 at load 7.5 with nine lanes running.
 *
 * Profiled rather than assumed, because that signature has two causes needing
 * opposite fixes. It is not starvation: the check reads **116 Swift files**
 * under `apps/ios` — a tree nothing else in this repo's suite touches, so it is
 * never already warm — plus `SessionManager.ts`, which is **1.4 MB**. Measured
 * per phase: discovery 23 210 ms cold and 67 ms warm; `swiftWireHalves` 0–2 ms
 * (the P3.358 addition costs nothing); `tsMembers` 5 527 ms cold, 10 ms warm.
 * The control at the wave-5 base measured the same shape — 11 661 ms cold,
 * 74 ms warm — so the cost is PRE-EXISTING, not the extension's.
 *
 * Nine cold first-call readings at that load spanned 9.7 s to 30.3 s; warm is
 * 14–17 ms once `read()` memoizes. CI runs on a fresh checkout, so it meets the
 * COLD number on every pipeline, which is why this is a budget and not a
 * known-failing register entry. 120 s is ~4x the worst reading observed.
 */
const FILESYSTEM_BUDGET_MS = 120_000

describe('apps/ios wire enums', () => {
  it('agree with every TypeScript declaration they mirror', () => {
    // Printed as lines rather than compared as objects: the finding text names
    // the exact value that diverged and which of the copies disagree, which is
    // the whole difference between "a list changed" and "go read six files".
    const findings = findWireEnumDivergences()
      .map(finding => `[${finding.kind}] ${finding.subject} — ${finding.detail}`)

    expect(findings).toEqual([])
  }, FILESYSTEM_BUDGET_MS)

  it('checks something — an empty registry would also report no divergences', () => {
    // The one failure a "no findings" assertion cannot distinguish from success.
    expect(MIRRORS.length).toBeGreaterThanOrEqual(8)
    for (const mirror of MIRRORS) expect(mirror.ts.length).toBeGreaterThan(0)
  })

  it('states why every exemption is one', () => {
    for (const exemption of EXEMPT) expect(exemption.why.length).toBeGreaterThan(40)
  })

  // P3.358. Discovery required a `String` raw value, and an enum with a case
  // carrying an associated value cannot have one — so `ErrorCode` was outside
  // the completeness clause BY CONSTRUCTION, and sat eight codes behind the
  // server with nothing able to say so. These pin the shape of the fix, not
  // just its result: a green run above proves the lists agree TODAY, and would
  // go on proving it if discovery quietly stopped finding this kind again.
  it('sees associated-value wire enums, not only `String`-raw-value ones', () => {
    const shapes = discoverSwiftWireEnums()
    const associated = shapes.filter(found => found.shape === 'associated-value')

    // Both of them: `ErrorCode` (a mirror) and `SessionEvent` (exempt — a
    // deliberate subset). Registered or exempted is asserted by the run above;
    // what is asserted here is that discovery can SEE them at all.
    expect(associated.map(found => found.name).sort()).toEqual(['ErrorCode', 'SessionEvent'])
    expect(shapes.some(found => found.shape === 'raw-value')).toBe(true)
  }, FILESYSTEM_BUDGET_MS)

  it('reads both hand-written halves of `ErrorCode` and they agree', () => {
    const mirror = MIRRORS.find(entry => entry.name === 'ErrorCode')
    expect(mirror?.swiftHalves).toEqual({ map: 'wireMap', property: 'wireValue' })

    const halves = swiftWireHalves(mirror!.file, mirror!.name, mirror!.swiftHalves!)

    // The fork nothing checked before this row: a case can be added to the
    // decode table and not the encode switch, and the compiler holds neither.
    expect([...halves.decode].sort()).toEqual([...halves.encode].sort())
    // A half that reads as empty is a mis-parse — the first draft of this
    // extractor bracket-matched the `[String: ErrorCode]` type annotation
    // instead of the literal and returned zero keys.
    expect(halves.decode.length).toBeGreaterThan(20)
    // The sentinel is not a wire value: `case .unknown(let raw): return raw`
    // contributes no literal, so it must not appear in either half.
    expect(halves.decode).not.toContain('unknown')
    expect(halves.encode).not.toContain('unknown')
  }, FILESYSTEM_BUDGET_MS)
})
