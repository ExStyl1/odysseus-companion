/**
 * F1.216 — the CHILD PROCESS behind `../registry-render.test.ts`: render every
 * entry in `componentRegistry`, and every variant of it, the way the playground
 * page does, and print one verdict per render as JSON on stdout.
 *
 * ## Why a child
 *
 * Every stub below is process-global — three `mock.module`s, a `window`, a
 * `location`, a `localStorage`, a `DOMMatrix`, a patched React export, the i18n
 * singleton, and the mock `electronAPI` that `mock-utils` installs on import.
 * The CI `test` job runs one bun process per DIRECTORY, so in the parent they
 * would reach every sibling file in `playground/__tests__`, and two of the
 * stubs cannot be spread and restored at all: spreading means importing the
 * module that cannot load (`ThemeContext`'s `import.meta.glob`, the Vite-only
 * `?url` specifier). Here they die with the process. It is P3.316's ruling for
 * this directory — containment, not one more bare `mock.module` in the batch.
 *
 * ## What the static render is, and the four places it is made to match a page
 *
 * `react-dom/server` is the renderer instrument this repo has (no DOM library
 * ships). A page render differs from it in exactly four ways that decided a
 * verdict here (each met on the first runs, 2026-09-23), and each is closed
 * toward what the PAGE draws, never toward a pass:
 *
 *  1. `useSyncExternalStore` without a server snapshot THROWS on the server; a
 *     client render reads `getSnapshot`. The export is wrapped so the server
 *     reads what the client would. It must be patched on the CommonJS object
 *     BEFORE anything imports `react` as ESM: bun snapshots a CommonJS module's
 *     named exports into the namespace at the first ESM import (measured
 *     2026-09-23: a patch applied after one early `import * as React` reached
 *     neither that namespace nor any later importer; applied before, both).
 *     Hence no JSX and no static `react` import in this file.
 *  2. A Radix `Portal` renders NOTHING on the server (it waits for a layout
 *     effect to find `document.body`). On a page an open dialog's content is on
 *     screen, so the portal renders its content in place here — otherwise
 *     every dialog entry would read as empty, and an exception list would have
 *     to hide them.
 *  3. A page has `localStorage` and a `location`; they are supplied.
 *  4. A modal dialog's scroll lock (`react-remove-scroll-bar`'s
 *     `RemoveScrollBar`) measures the page's scrollbar gap from
 *     `document.body` DURING render — which, with point 2 putting dialog
 *     content on the page, has no DOM to read. It draws no markup of its own
 *     (its CSS goes to the document head from an effect), so it is replaced by
 *     a component that draws the same nothing.
 *
 * Everything with a side effect sits behind `import.meta.main` (AGENTS.md
 * §Traps: a fixture whose body exits kills a runner that imports it).
 */
import { mock } from 'bun:test'

export const VERDICTS_MARKER = '@@PLAYGROUND-RENDER-VERDICTS@@'

export interface EntryVerdict {
  id: string
  /** `null` for the entry's own defaults; the variant's name otherwise. */
  variant: string | null
  outcome: 'rendered' | 'empty' | 'threw'
  /** First line of the thrown error, when `outcome` is `threw`. */
  error?: string
  /** Length of the entry's own markup (the frame's markup subtracted). */
  markupLength: number
  /** The whole markup, only for ids named on the command line. */
  markup?: string
}

type ReactModule = typeof import('react')

/** Exported for UB14.2's panel-stack probe (`components/app-shell/__tests__/fixtures/panel-stack-probe.ts`), which needs the same page render. */
export function patchReactForAPageRender(): ReactModule {
  const react = require('react') as ReactModule & Record<string, unknown>
  const clientSnapshot = react.useSyncExternalStore
  react.useSyncExternalStore = ((subscribe, getSnapshot, getServerSnapshot) =>
    clientSnapshot(subscribe, getSnapshot, getServerSnapshot ?? getSnapshot)) as typeof clientSnapshot
  return react
}

export function installStubs(react: ReactModule): void {
  // The pdfjs recipe (AGENTS.md §Traps; `capability-info-pages.test.tsx`), as one
  // block: the three `mock.module` stubs AND the `DOMMatrix` polyfill.
  // `ThemeContext` runs Vite's `import.meta.glob` at module scope.
  mock.module('@/context/ThemeContext', () => ({
    useTheme: () => ({
      mode: 'dark',
      colorTheme: 'default',
      font: 'inter',
      setMode: () => {},
      setColorTheme: () => {},
      setFont: () => {},
      activeWorkspaceId: 'playground-workspace',
      workspaceColorTheme: null,
      setWorkspaceColorTheme: () => {},
      resolvedMode: 'dark',
      systemPreference: 'dark',
      effectiveColorTheme: 'default',
      previewColorTheme: null,
      setPreviewColorTheme: () => {},
      effectiveColorThemeSource: 'app',
      themeResolvedFrom: 'none',
      themeLoadError: null,
      presetTheme: null,
      resolvedTheme: {},
      isDark: true,
      isScenic: false,
      shikiTheme: 'github-dark',
      shikiConfig: { light: 'github-light', dark: 'github-dark' },
    }),
    ThemeProvider: ({ children }: { children: unknown }) => children,
  }))
  mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '' }))
  mock.module('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument: () => ({}) }))
  const page = globalThis as Record<string, unknown>
  if (typeof page.DOMMatrix === 'undefined') {
    page.DOMMatrix = class DOMMatrix {
      a = 1; b = 0; c = 0; d = 1; e = 0; f = 0
      is2D = true
    }
  }

  // Point 2 of the docblock: a Radix portal renders its content in place.
  const InPlacePortal = react.forwardRef<HTMLDivElement, Record<string, unknown>>(
    ({ container: _container, ...props }, ref) => react.createElement('div', { ...props, ref }),
  )
  mock.module('@radix-ui/react-portal', () => ({ Portal: InPlacePortal, Root: InPlacePortal }))
  // Point 4: the scroll lock, spread so every other export stays the real one.
  const scrollBar = require('react-remove-scroll-bar') as Record<string, unknown>
  mock.module('react-remove-scroll-bar', () => ({ ...scrollBar, RemoveScrollBar: () => null }))

  // Point 3: the page's globals. There is no DOM, so `window` is the global
  // object itself — `mock-utils` installs the fixture bridge on it at import.
  if (typeof page.window === 'undefined') page.window = globalThis
  if (typeof page.location === 'undefined') page.location = new URL('http://localhost/playground.html')
  for (const name of ['localStorage', 'sessionStorage']) {
    if (typeof page[name] !== 'undefined') continue
    const values = new Map<string, string>()
    page[name] = {
      get length() { return values.size },
      key: (index: number) => [...values.keys()][index] ?? null,
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, String(value)) },
      removeItem: (key: string) => { values.delete(key) },
      clear: () => { values.clear() },
    }
  }
}

/** The error's first line and the frame it was thrown from — enough to act on. */
function firstLine(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  const frame = error instanceof Error ? (error.stack ?? '').split('\n').find(line => line.trim().startsWith('at ')) : undefined
  return `${text.split('\n')[0]!.slice(0, 300)}${frame ? ` (${frame.trim().slice(3, 200)})` : ''}`
}

export async function renderEveryEntry(markupIds: ReadonlySet<string> = new Set()): Promise<EntryVerdict[]> {
  const react = patchReactForAPageRender()
  installStubs(react)
  const h = react.createElement
  // `mock-utils` first, exactly as `playground.tsx` imports it, so any module
  // that reads `window.electronAPI` at load finds the fixture.
  await import('../../mock-utils')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { Provider: JotaiProvider } = await import('jotai')
  const { setupI18n } = await import('@nessy-agent/shared/i18n')
  const { initReactI18next } = await import('react-i18next')
  const { EscapeInterruptProvider } = await import('@/context/EscapeInterruptContext')
  const { PlaygroundAppShellProvider } = await import('../../PlaygroundAppShellProvider')
  const { PlaygroundEntryFrame, playgroundEntryProps } = await import('../../ComponentPreview')
  const { componentRegistry } = await import('../../registry')

  // The page's own i18n, pinned to English (F1.103's rule), so no verdict turns
  // on a language something else left behind.
  const i18n = setupI18n([initReactI18next])
  await i18n.changeLanguage('en')

  const verdicts: EntryVerdict[] = []
  for (const entry of componentRegistry) {
    const cases: Array<{ variant: string | null; props: Record<string, unknown> }> = [
      { variant: null, props: {} },
      ...(entry.variants ?? []).map(variant => ({ variant: variant.name, props: variant.props })),
    ]
    for (const { variant, props } of cases) {
      // `playground.tsx`'s providers round `ComponentPreview`'s own frame; the
      // same frame with an entry that draws nothing is the baseline subtracted.
      const page = (child: import('react').ReactNode) =>
        h(JotaiProvider, null,
          h(EscapeInterruptProvider, null,
            h(PlaygroundAppShellProvider, null, child)))
      try {
        // The defaults an entry is FIRST shown with, then each variant over them —
        // `PlaygroundApp`'s own order (`handleVariantSelect`).
        const defaults: Record<string, unknown> = {}
        for (const prop of entry.props) defaults[prop.name] = prop.defaultValue
        const full = renderToStaticMarkup(
          page(h(PlaygroundEntryFrame, { component: entry, props: playgroundEntryProps(entry, { ...defaults, ...props }) })),
        )
        const bare = renderToStaticMarkup(
          page(h(PlaygroundEntryFrame, { component: { ...entry, component: () => null }, props: {} })),
        )
        const markupLength = full.length - bare.length
        verdicts.push({
          id: entry.id,
          variant,
          outcome: markupLength > 0 ? 'rendered' : 'empty',
          markupLength,
          ...(markupIds.has(entry.id) ? { markup: full } : {}),
        })
      } catch (error) {
        verdicts.push({ id: entry.id, variant, outcome: 'threw', error: firstLine(error), markupLength: 0 })
      }
    }
  }
  return verdicts
}

if (import.meta.main) {
  const started = performance.now()
  const verdicts = await renderEveryEntry(new Set(process.argv.slice(2)))
  process.stderr.write(`[render-every-entry] ${verdicts.length} renders in ${Math.round(performance.now() - started)} ms\n`)
  // Exit explicitly once stdout has drained: the rendered graph leaves timers
  // and listeners behind, and without this the child never exits (measured
  // 2026-09-23: verdicts printed, process still alive an hour later).
  process.stdout.write(`\n${VERDICTS_MARKER}${JSON.stringify(verdicts)}\n`, () => process.exit(0))
}
