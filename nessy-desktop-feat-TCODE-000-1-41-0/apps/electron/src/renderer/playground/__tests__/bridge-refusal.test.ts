/**
 * The playground refuses to mount against a bridge it did not install (P6.668).
 *
 * ## What was measured
 *
 * `ensureMockElectronAPI()` installs the fixture only `if (!window.electronAPI)`.
 * Every app `BrowserWindow` is created with
 * `preload: join(__dirname, 'bootstrap-preload.cjs')`, which has already run
 * `contextBridge.exposeInMainWorld` by the time `playground.tsx` evaluates — so
 * `playground.html` opened inside an app window rendered every registry entry
 * against the REAL RPC, not the fixture, and silently, because yielding to an
 * existing bridge looks like politeness rather than a decision.
 *
 * It is not theoretical. `overrideElectronApiMethod`'s docblock in the same file
 * records the consequence being hit: *"Inside Electron it does not: the real API
 * arrives through `contextBridge.exposeInMainWorld` … the assignment throws
 * `TypeError: Cannot assign to read only property` … The `input-container` entry
 * crashed this way."* Somebody has run this page against a live bridge.
 *
 * The reachable route is DEV: `WindowManager.isRendererAppUrl` admits any path on
 * the Vite origin, so `http://localhost:5173/playground.html` loads in a real app
 * window. P6.667 narrowed the packaged half of that guard to `index.html`; this
 * is the other half, and it is the half that covers dev.
 *
 * ## Why a refusal and not a wrapper
 *
 * Wrapping the real bridge in something mock-shaped means deciding, per method,
 * which live calls are safe — a judgement that is wrong the moment a method is
 * added, and wrong invisibly. A design surface that cannot prove it is talking to
 * a fixture should not render at all, and should say so where a person can read
 * it rather than only in a console.
 *
 * SAFETY: this file installs a fake object on `globalThis.window` and removes it
 * again. No Electron, no preload, no RPC, and no real bridge is ever constructed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

/**
 * Load a FRESH copy of the module under the window state the test set up.
 *
 * The verdict is decided by a module-level side effect that runs exactly once
 * per module instance, so a shared import would answer for whichever test ran
 * first — the same reason the standalone-import guard spawns children. A cache
 * buster on the specifier is the in-process equivalent and is enough here
 * because nothing else in the graph holds state.
 */
async function loadMockUtils(nonce: number) {
  return await import(`../mock-utils.ts?p6668=${nonce}`) as {
    ensureMockElectronAPI: () => void
    mockElectronAPI: Record<string, unknown>
    playgroundBridgeKind: () => 'mock' | 'foreign'
    playgroundBridgeRefusalHtml: () => string
  }
}

let nonce = 0

beforeEach(() => {
  // A minimal `window` is all that is needed: the module reads
  // `window.electronAPI` and nothing else global. There is no DOM in this test
  // environment at all — which is why the refusal is a pure string function.
  ;(globalThis as any).window = { electronAPI: undefined }
})

afterEach(() => {
  delete (globalThis as any).window
})

describe('playground bridge guard (P6.668)', () => {
  it('mounts on the mock when no bridge is present', async () => {
    const mod = await loadMockUtils(++nonce)
    expect(mod.playgroundBridgeKind()).toBe('mock')
    // And the fixture really was installed — otherwise "mock" would be a label
    // on an absent bridge rather than on the one this module owns.
    expect((globalThis as any).window.electronAPI).toBe(mod.mockElectronAPI)
  })

  it('REFUSES when a bridge it did not install is already present', async () => {
    // The shape an app window's preload leaves behind: present before this
    // module is evaluated, and not ours.
    ;(globalThis as any).window = { electronAPI: { getRuntimeEnvironment: () => 'electron' } }
    const mod = await loadMockUtils(++nonce)
    expect(mod.playgroundBridgeKind()).toBe('foreign')
  })

  it('does not overwrite the real bridge on its way to refusing', async () => {
    // The refusal must not be reached by clobbering: assigning over an
    // `exposeInMainWorld` proxy throws `Cannot assign to read only property`,
    // which is how the `input-container` entry died. Yielding stays correct;
    // what changes is that the yield is now REPORTED.
    const realBridge = { getRuntimeEnvironment: () => 'electron' }
    ;(globalThis as any).window = { electronAPI: realBridge }
    const mod = await loadMockUtils(++nonce)
    mod.ensureMockElectronAPI()
    expect((globalThis as any).window.electronAPI).toBe(realBridge)
    expect(mod.playgroundBridgeKind()).toBe('foreign')
  })

  it('produces a refusal a person can read', async () => {
    const mod = await loadMockUtils(++nonce)
    const html = mod.playgroundBridgeRefusalHtml()

    expect(html).toContain('data-playground-refusal="foreign-bridge"')
    expect(html).toContain('role="alert"')
    // It has to say WHAT happened and WHAT to do instead — a bare "error" is the
    // thing that gets worked around rather than read.
    expect(html).toContain('window.electronAPI')
    expect(html).toContain('refuses')
    expect(html).toContain('browser tab')
    // No interpolation, which is what makes `innerHTML` safe at the call site.
    // A `${` appearing here means the next change needs escaping instead.
    expect(html).not.toContain('${')
    expect(html).not.toContain('undefined')
  })

  it('the entry actually consults the guard before mounting', async () => {
    // The three cases above measure the module. This is what ties them to the
    // page: a verdict nothing reads protects nothing, which is the failure mode
    // a helper-only fix would have.
    const entry = await Bun.file(new URL('../../playground.tsx', import.meta.url)).text()
    expect(entry).toContain('playgroundBridgeKind()')
    expect(entry).toContain('playgroundBridgeRefusalHtml()')
    // The mount must be inside the else branch, not beside it.
    const guardAt = entry.indexOf("if (playgroundBridgeKind() === 'foreign')")
    const mountAt = entry.indexOf('ReactDOM.createRoot(')
    expect(guardAt).toBeGreaterThan(-1)
    expect(mountAt).toBeGreaterThan(guardAt)
  })
})
