/**
 * UB14.50 (B3-21; v0.15.0, silent) — `CONFIG_DIR/theme.json` colour overrides apply, and apply live.
 *
 * The behaviour is the result of UB13.4 (15fbb68c5), which took v0.15.1's `ThemeContext.tsx` 1:1: the
 * PROVIDER loads the overrides (`electronAPI.getAppTheme`), takes every `onAppThemeChange` push (the
 * host's config watcher broadcasts `theme:appChanged` when the file changes — SessionManager's
 * `onAppThemeChange` → `broadcastAppThemeChanged`), layers them on the preset
 * (`resolveTheme(presetTheme, appThemeOverrides)`) and writes the solved CSS into
 * `<style id="nessy-theme-overrides">`, on the default theme too. Before UB13.4, App.tsx loaded the file
 * into `useTheme({ appTheme })` and read back only `shikiTheme`/`isDark`, while the provider resolved
 * `resolveTheme(presetTheme)` alone — so an override never reached the CSS, although
 * `resources/docs/themes.md` § Live Updates promises it does. These arms drive the REAL provider and read
 * the CSS it injects:
 *  - positive: an override reaches the injected CSS on the default theme and over a preset, and a pushed
 *    change replaces it live (a pushed `null`, the file deleted, takes it away again);
 *  - negative (control): no file (`getAppTheme` → `null`) leaves the preset's CSS exactly what the preset
 *    alone resolves to, and leaves the default theme on its static tokens (an empty style element).
 *
 * UB14.47 (B3-17; v0.15.0 "Windows") reuses this harness for the renderer half of the opaque window: the
 * provider marks `<html data-vibrancy>` (base.css's translucent canvas) only when
 * `electronAPI.getWindowVibrancy()` names a native material — Mica on Windows 11 22H2+ or macOS
 * vibrancy — and the mode it paints matches the OS. With no material (Windows 10, Windows 11 21H2,
 * Linux, the web) the attribute stays off and the canvas is solid. The main-process gate is pinned in
 * `main/__tests__/window-material.test.ts`.
 *
 * ## Harness (the repo has no DOM library)
 *  - `ThemeContext.tsx` calls Vite's `import.meta.glob` at module scope (its BUNDLED_THEMES fallback map),
 *    which bun cannot evaluate (`import.meta.glob is not a function`, measured by the app-shell mount
 *    tests). A bun runtime plugin loads THAT one file with the one call replaced by what Vite's eager
 *    default-import glob yields: an object literal of the matched JSON files keyed by their relative
 *    path. Nothing else in the file changes, and the plugin throws if the call's spelling moved, so the
 *    harness can never quietly load a different module. The plugin is cleared after this file.
 *  - React runs on the real react-dom reconciler over a bare container object (the recipe of
 *    `hooks/__tests__/fixtures/render-hook.ts`); the provider renders no host element.
 *  - `window` (matchMedia, electronAPI, and the `HTMLIFrameElement` react-dom's commit compares with),
 *    `document` (only the members the provider's DOM effects touch) and `localStorage` (a Map) are stubs
 *    installed for this file and removed after it.
 */
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveTheme, themeToCSS, type PresetTheme, type ThemeFile, type ThemeOverrides } from '@config/theme'
import type { WindowVibrancy } from '../../../shared/types'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'

type ThemeContextModule = typeof import('../ThemeContext')
type ThemeContextValue = ReturnType<ThemeContextModule['useTheme']>
type AppThemeListener = (theme: ThemeOverrides | null) => void

const STYLE_ID = 'nessy-theme-overrides'
const PRESET_ID = 'ub14-50-fixture'
/** A preset with base colours only, so the dark render reads them as written (no `dark` block). */
const PRESET: ThemeFile = {
  name: 'UB14.50 fixture',
  background: '#102030',
  foreground: '#f0f0f0',
  accent: '#3355ff',
}
const OVERRIDE: ThemeOverrides = { accent: '#ff0000' }

// --- the Vite-only glob, loaded the way Vite builds it --------------------------------------------------
const EAGER_JSON_GLOB =
  /import\.meta\.glob\(\s*'([^']+\/\*\.json)'\s*,\s*\{\s*eager:\s*true,\s*import:\s*'default',?\s*\}\s*\)/

function loadThemeContextWithEagerGlob({ path }: { path: string }) {
  const source = readFileSync(path, 'utf8')
  const call = EAGER_JSON_GLOB.exec(source)
  if (!call) {
    throw new Error(
      `UB14.50 harness: ${path} no longer spells the eager default-import JSON glob this harness replaces; ` +
        'update the pattern before trusting any arm in this file.',
    )
  }
  const pattern = call[1]
  const relativeDir = dirname(pattern)
  const dir = join(dirname(path), relativeDir)
  const modules = Object.fromEntries(
    readdirSync(dir)
      .filter((file) => file.endsWith('.json'))
      .sort()
      .map((file) => [`${relativeDir}/${file}`, JSON.parse(readFileSync(join(dir, file), 'utf8'))]),
  )
  return { contents: source.replace(call[0], `(${JSON.stringify(modules)})`), loader: 'tsx' as const }
}

// --- DOM and host stubs --------------------------------------------------------------------------------
class FakeElement {
  id = ''
  textContent = ''
}

function makeDocument() {
  const byId = new Map<string, FakeElement>()
  const classes = new Set<string>()
  return {
    documentElement: {
      dataset: {} as Record<string, string>,
      classList: {
        add: (...names: string[]) => names.forEach((name) => classes.add(name)),
        remove: (...names: string[]) => names.forEach((name) => classes.delete(name)),
        contains: (name: string) => classes.has(name),
      },
      style: { setProperty() {}, removeProperty() {} },
      setAttribute() {},
      removeAttribute() {},
    },
    head: {
      appendChild(element: FakeElement) {
        if (element.id) byId.set(element.id, element)
        return element
      },
    },
    getElementById: (id: string) => byId.get(id) ?? null,
    createElement: (_tag: string) => new FakeElement(),
  }
}

interface Host {
  /** What `getAppTheme()` resolves to: the parsed theme.json, or null when there is no file. */
  appTheme: ThemeOverrides | null
  /** The provider's `onAppThemeChange` callback, captured so a test can push a file change. */
  listener: AppThemeListener | null
  getAppThemeCalls: number
  /** What the preload's `getWindowVibrancy()` answers (UB14.47): the native material, or null. */
  vibrancy: WindowVibrancy | null
}

type Globals = { window?: unknown; document?: unknown; localStorage?: unknown; IS_REACT_ACT_ENVIRONMENT?: boolean }
const g = globalThis as unknown as Globals
const saved: Globals = { window: g.window, document: g.document, localStorage: g.localStorage }
const store = new Map<string, string>()
let host: Host
let fakeDocument: ReturnType<typeof makeDocument>
let ThemeContext: ThemeContextModule
let previousActEnvironment: boolean | undefined

function installGlobals(): void {
  host = { appTheme: null, listener: null, getAppThemeCalls: 0, vibrancy: null }
  fakeDocument = makeDocument()
  store.clear()
  g.localStorage = {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  }
  g.document = fakeDocument
  g.window = {
    HTMLIFrameElement: class {},
    // The system is dark (owner rule: verify in the dark theme).
    matchMedia: (query: string) => ({
      matches: query === '(prefers-color-scheme: dark)',
      addEventListener() {},
      removeEventListener() {},
    }),
    electronAPI: {
      getAppTheme: async () => {
        host.getAppThemeCalls += 1
        return host.appTheme
      },
      onAppThemeChange: (callback: AppThemeListener) => {
        host.listener = callback
        return () => {
          if (host.listener === callback) host.listener = null
        }
      },
      loadPresetTheme: async (themeId: string): Promise<PresetTheme | null> =>
        themeId === PRESET_ID ? { id: PRESET_ID, path: `/fixture/${PRESET_ID}.json`, theme: PRESET } : null,
      getWindowVibrancy: () => host.vibrancy,
    },
  }
}

/** The renderer's stored theme record (`nessy-theme`): the user picked the fixture preset, dark mode. */
function selectPreset(): void {
  store.set('nessy-theme', JSON.stringify({ mode: 'dark', colorTheme: PRESET_ID, isUserOverride: true }))
}

// --- mounting the real provider ------------------------------------------------------------------------
interface Mounted {
  readonly context: ThemeContextValue
  /** The CSS the provider injected, or null when it never created its style element. */
  css(): string | null
  /** Deliver a theme.json change the way the host does (`theme:appChanged`). */
  push(theme: ThemeOverrides | null): Promise<void>
  unmount(): void
}

let mounted: Mounted | null = null

/** Let the provider's IPC promises resolve and their state updates commit, all inside act. */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await React.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

async function mount(): Promise<Mounted> {
  const container = {
    nodeType: 1,
    tagName: 'DIV',
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    ownerDocument: null,
    textContent: '',
    addEventListener() {},
    removeEventListener() {},
  }
  let context!: ThemeContextValue
  function Probe(): null {
    context = ThemeContext.useTheme()
    return null
  }
  const root = createRoot(container as unknown as Element)
  await React.act(async () => {
    root.render(React.createElement(ThemeContext.ThemeProvider, null, React.createElement(Probe)))
  })
  await settle()
  mounted = {
    get context() {
      return context
    },
    css: () => fakeDocument.getElementById(STYLE_ID)?.textContent ?? null,
    async push(theme) {
      const listener = host.listener
      if (!listener) throw new Error('the provider never subscribed to onAppThemeChange')
      await React.act(async () => {
        listener(theme)
      })
      await settle()
    },
    unmount() {
      React.act(() => root.unmount())
    },
  }
  return mounted
}

/** The provider's canvas verdict: the material on `<html data-vibrancy>`, or undefined for a solid canvas. */
function canvasVibrancy(): string | undefined {
  return fakeDocument.documentElement.dataset.vibrancy
}

function cssFor(theme: ThemeOverrides, isDark: boolean): string {
  return `:root {\n  ${themeToCSS(theme, isDark)}\n}`
}

beforeAll(async () => {
  Bun.plugin({
    name: 'ub14-50-theme-context-eager-json-glob',
    setup(build) {
      build.onLoad({ filter: /[\\/]renderer[\\/]context[\\/]ThemeContext\.tsx$/ }, loadThemeContextWithEagerGlob)
    },
  })
  previousActEnvironment = g.IS_REACT_ACT_ENVIRONMENT
  g.IS_REACT_ACT_ENVIRONMENT = true
  installGlobals()
  // The import pays the module graph (motion/react under @nessy-agent/ui/motion): I/O-bound, measured
  // 39–76 s of wall at under 1 % cpu on 2026-10-16, hence the shared hook budget, not bun's 5 s.
  ThemeContext = await import('../ThemeContext')
}, MODULE_GRAPH_HOOK_BUDGET_MS)

beforeEach(() => {
  installGlobals()
})

afterEach(() => {
  mounted?.unmount()
  mounted = null
})

afterAll(() => {
  Bun.plugin.clearAll()
  g.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
  for (const key of ['window', 'document', 'localStorage'] as const) {
    if (saved[key] === undefined) delete g[key]
    else g[key] = saved[key]
  }
})

describe('UB14.50 — theme.json overrides reach the injected CSS (positive)', () => {
  it('on the default theme: the provider loads the file once and injects the override colour', async () => {
    host.appTheme = OVERRIDE
    const view = await mount()

    expect(host.getAppThemeCalls).toBe(1)
    expect(view.context.appThemeOverrides).toEqual(OVERRIDE)
    expect(view.context.resolvedTheme.accent).toBe('#ff0000')
    expect(view.css()).toContain('--accent: #ff0000;')
    expect(view.css()).toBe(cssFor(OVERRIDE, true))
  })

  it('over a preset: the override wins its key and every other preset colour stays', async () => {
    selectPreset()
    host.appTheme = OVERRIDE
    const view = await mount()

    expect(view.context.effectiveColorTheme).toBe(PRESET_ID)
    expect(view.context.themeResolvedFrom).toBe('ipc')
    expect(view.context.resolvedTheme).toEqual({ ...PRESET, accent: '#ff0000' })
    const css = view.css()
    expect(css).toContain('--accent: #ff0000;')
    expect(css).toContain('--background: #102030;')
    expect(css).toContain('--foreground: #f0f0f0;')
    expect(css).not.toContain('#3355ff')
  })

  it('live: a changed file replaces the override, and a deleted one restores the theme, with no remount', async () => {
    selectPreset()
    host.appTheme = OVERRIDE
    const view = await mount()
    expect(view.css()).toContain('--accent: #ff0000;')

    await view.push({ accent: '#00aa00' })
    expect(view.context.appThemeOverrides).toEqual({ accent: '#00aa00' })
    expect(view.css()).toContain('--accent: #00aa00;')
    expect(view.css()).not.toContain('#ff0000')

    await view.push(null)
    expect(view.context.appThemeOverrides).toBeNull()
    expect(view.css()).toBe(cssFor(PRESET, true))
    // One load at mount; the change arrived as a push, not as a re-read.
    expect(host.getAppThemeCalls).toBe(1)
  })
})

describe('UB14.50 — no theme.json leaves the theme as it is (negative / control)', () => {
  it('a preset with no file injects exactly what the preset alone resolves to', async () => {
    selectPreset()
    host.appTheme = null
    const view = await mount()

    expect(view.context.appThemeOverrides).toBeNull()
    expect(view.context.resolvedTheme).toEqual(PRESET)
    expect(view.css()).toBe(cssFor(resolveTheme(PRESET, null), true))
    expect(view.css()).toContain('--accent: #3355ff;')
    expect(view.css()).not.toContain('#ff0000')
  })

  it('the default theme with no file keeps its static tokens: the style element stays empty', async () => {
    host.appTheme = null
    const view = await mount()

    expect(view.context.appThemeOverrides).toBeNull()
    expect(view.css()).toBe('')
  })

  it('the App-level loader stays gone: App.tsx neither reads theme.json nor passes it to useTheme', () => {
    const app = readFileSync(join(import.meta.dir, '..', '..', 'App.tsx'), 'utf8')
    expect(app).toContain('useTheme()')
    expect(app).not.toContain('getAppTheme')
    expect(app).not.toContain('onAppThemeChange')
    expect(app).not.toMatch(/useTheme\(\{/)
  })
})

describe('UB14.47 — the canvas is translucent over a native material (positive)', () => {
  it('Mica (Windows 11 22H2+) in the OS mode: <html data-vibrancy="mica">', async () => {
    host.vibrancy = 'mica'
    const view = await mount()

    expect(view.context.resolvedMode).toBe('dark')
    expect(view.context.systemPreference).toBe('dark')
    expect(canvasVibrancy()).toBe('mica')
  })

  it("macOS vibrancy (ours, unchanged): <html data-vibrancy=\"under-window\">", async () => {
    host.vibrancy = 'under-window'
    await mount()

    expect(canvasVibrancy()).toBe('under-window')
  })
})

describe('UB14.47 — no material, or a mode the material cannot match, paints solid (negative / control)', () => {
  it('no material (Windows 10, Windows 11 21H2, Linux): data-vibrancy stays off', async () => {
    host.vibrancy = null
    await mount()

    expect(canvasVibrancy()).toBeUndefined()
  })

  it('Mica but the user picked light while the OS is dark: solid, since the material follows the OS', async () => {
    store.set('nessy-theme', JSON.stringify({ mode: 'light', colorTheme: 'default' }))
    host.vibrancy = 'mica'
    const view = await mount()

    expect(view.context.resolvedMode).toBe('light')
    expect(canvasVibrancy()).toBeUndefined()
  })
})

/**
 * UB15.9 — the Motion row on Settings › Appearance (System / Reduced / Full) writes through the provider's
 * `setMotion`; a chosen value must survive a restart. A restart here is the real provider unmounted and mounted
 * again over the same `localStorage` (the theme record `nessy-theme`), which is all the renderer keeps across one.
 */
describe('UB15.9 — the Motion choice survives a restart', () => {
  async function chooseAndRestart(choice: 'reduced' | 'full'): Promise<Mounted> {
    const first = await mount()
    expect(first.context.motion).toBe('system')
    await React.act(async () => {
      first.context.setMotion(choice)
    })
    expect(fakeDocument.documentElement.dataset.motion).toBe(choice)
    first.unmount()
    mounted = null
    return mount()
  }

  it("positive: 'reduced' is stored in the theme record and read back by the next boot, which stamps it again", async () => {
    const second = await chooseAndRestart('reduced')
    expect(JSON.parse(store.get('nessy-theme')!).motion).toBe('reduced')
    expect(second.context.motion).toBe('reduced')
    expect(fakeDocument.documentElement.dataset.motion).toBe('reduced')
  })

  it("control: the boot reads back the CHOSEN value ('full'), and with no record at all it boots 'system' (unstamped)", async () => {
    const second = await chooseAndRestart('full')
    expect(second.context.motion).toBe('full')
    expect(fakeDocument.documentElement.dataset.motion).toBe('full')
    second.unmount()
    mounted = null
    store.clear()
    const fresh = await mount()
    expect(fresh.context.motion).toBe('system')
    expect(fakeDocument.documentElement.dataset.motion).toBeUndefined()
  })
})
