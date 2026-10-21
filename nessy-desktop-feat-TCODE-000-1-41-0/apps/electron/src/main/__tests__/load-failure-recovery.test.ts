/**
 * UA12.144 — "did-fail-load with isMainFrame:false does not trigger the reload
 * path".
 *
 * The behaviour half runs on the REAL extracted decision
 * (`load-failure-recovery.ts`) — the same route the UA7.2 frame-navigation
 * guard took, because constructing a `WindowManager` means mocking `electron`
 * with `mock.module`, and a `mock.module` without a spread amputates the
 * module for every later test file in the process (AGENTS.md § Traps).
 *
 * The wiring half is a source-shape check on `window-manager.ts` with comment
 * lines stripped, the instrument `renderer-navigation-guard.test.ts` already
 * uses for this very file: the handler must read the FIFTH parameter
 * (`isMainFrame`), and its `leave-alone` return must come before the first
 * navigation call inside the handler — otherwise the behaviour tests pass on a
 * decision the window never consults.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  decideLoadFailureRecovery,
  LOAD_FAILURE_DEV_SERVER_RETRIES,
} from '../load-failure-recovery'

const RAW_SOURCE = readFileSync(join(import.meta.dir, '..', 'window-manager.ts'), 'utf-8')

/** The source with comment lines removed (the fix's comments must not satisfy the shape checks). */
const SOURCE = RAW_SOURCE
  .split('\n')
  .filter((line) => {
    const trimmed = line.trim()
    return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*')
  })
  .join('\n')

describe('load-failure recovery decision (UA12.144)', () => {
  it('NEGATIVE-ARM-FIRST: a SUBFRAME failure in a packaged build leaves the window alone', () => {
    // SITC-F1, repro 3/3: a page iframe's CSP-blocked form POST / self-navigation
    // fired did-fail-load(isMainFrame:false) and the old handler answered it by
    // reloading the whole renderer. This is exactly that call.
    const decision = decideLoadFailureRecovery({
      isMainFrame: false,
      devServerUrl: undefined,
      retriesSoFar: 0,
    })
    expect(decision).toEqual({ action: 'leave-alone' })
  })

  it('a SUBFRAME failure in a dev build leaves the window alone too — the dev retry also navigates', () => {
    // The old first branch retried the Vite URL, which is equally a whole-window
    // navigation; containment must not depend on the build mode.
    const decision = decideLoadFailureRecovery({
      isMainFrame: false,
      devServerUrl: 'http://localhost:5173/',
      retriesSoFar: 0,
    })
    expect(decision).toEqual({ action: 'leave-alone' })
  })

  it('a MAIN-frame failure in a packaged build still loads the fallback shell (#13, preserved)', () => {
    const decision = decideLoadFailureRecovery({
      isMainFrame: true,
      devServerUrl: undefined,
      retriesSoFar: 0,
    })
    expect(decision).toEqual({ action: 'load-fallback' })
  })

  it('a MAIN-frame failure in a dev build retries the dev server below the cap (preserved)', () => {
    expect(
      decideLoadFailureRecovery({ isMainFrame: true, devServerUrl: 'http://localhost:5173/', retriesSoFar: 0 }),
    ).toEqual({ action: 'retry-dev-server' })
    // The last retry that is still allowed — the cap boundary.
    expect(
      decideLoadFailureRecovery({
        isMainFrame: true,
        devServerUrl: 'http://localhost:5173/',
        retriesSoFar: LOAD_FAILURE_DEV_SERVER_RETRIES - 1,
      }),
    ).toEqual({ action: 'retry-dev-server' })
  })

  it('a MAIN-frame dev failure at the retry cap falls back to the shell (cap preserved)', () => {
    expect(
      decideLoadFailureRecovery({
        isMainFrame: true,
        devServerUrl: 'http://localhost:5173/',
        retriesSoFar: LOAD_FAILURE_DEV_SERVER_RETRIES,
      }),
    ).toEqual({ action: 'load-fallback' })
  })
})

describe('the handler wiring (source shape, comment-stripped)', () => {
  const HANDLER_START = "window.webContents.on('did-fail-load'"
  const HANDLER_END = "window.webContents.on('render-process-gone'"

  it('reads isMainFrame as the fifth did-fail-load parameter and consults the decision', () => {
    // If the parameter is dropped or renamed, the gate reads `undefined` and
    // every real failure (isMainFrame:true) would be contained — the inverse
    // defect. The fifth position is Electron's own signature, the same one
    // browser-pane-manager.ts's did-fail-load handlers already read.
    expect(SOURCE).toContain(
      "window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _validatedUrl, isMainFrame)",
    )
    expect(SOURCE).toContain('decideLoadFailureRecovery({')
    expect(SOURCE).toContain("from './load-failure-recovery'")
  })

  it('inside the handler, the leave-alone return precedes the first navigation call', () => {
    const start = SOURCE.indexOf(HANDLER_START)
    const end = SOURCE.indexOf(HANDLER_END)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const handler = SOURCE.slice(start, end)

    const leaveAlone = handler.indexOf("decision.action === 'leave-alone'")
    const firstNavigation = handler.search(/window\.load(File|URL)\(/)
    expect(leaveAlone).toBeGreaterThan(-1)
    expect(firstNavigation).toBeGreaterThan(-1)
    expect(leaveAlone).toBeLessThan(firstNavigation)
    // The return that makes containment real — a gate that only logs still reloads.
    expect(handler).toMatch(/leave-alone'\)[\s\S]{0,200}return/)
  })

  it('CONTROL: the shape check reads a handler that exists (both markers present in the raw file)', () => {
    // A slice between two absent markers is the empty string, which trivially
    // "contains" nothing and fails every indexOf above — this is the positive
    // control that the instrument still sees the handler at all.
    expect(RAW_SOURCE).toContain(HANDLER_START)
    expect(RAW_SOURCE).toContain(HANDLER_END)
  })
})
