/**
 * UB12.55 — the CHILD PROCESS behind `../server-directory-browser-registry.test.ts`: render every state of
 * `registry/server-directory-browser.tsx` (the entry's own defaults, then each variant over them) inside
 * `PlaygroundEntryFrame`, the frame the playground page draws every entry in, and print the markup as JSON on stdout.
 *
 * Why a child, and why these stubs: `render-every-entry.ts`'s docblock — the same page render (a Radix portal draws
 * its content in place, so the open dialog is on the page; the scroll lock draws nothing), the same process-global
 * stubs, which must die with the process. Its `ThemeContext` stub resolves DARK, so this is the dark sweep. Only this
 * registry is imported, not `componentRegistry` (UB14.36's `dialog-entries-probe.ts` shape), so the child does not pay
 * for the whole playground graph; `registry-render.test.ts` renders the entry too, by construction, for its census.
 *
 * Everything with a side effect sits behind `import.meta.main` (AGENTS.md §Traps).
 */
import { installStubs, patchReactForAPageRender } from './render-every-entry'

export const SERVER_DIRECTORY_BROWSER_MARKER = '@@SERVER-DIRECTORY-BROWSER-ENTRIES@@'

export interface ServerDirectoryBrowserRender {
  id: string
  /** `null` for the entry's own defaults; the variant's name otherwise. */
  variant: string | null
  markup?: string
  /** First line of the thrown error, when the render threw. */
  error?: string
}

export async function renderServerDirectoryBrowserEntries(): Promise<ServerDirectoryBrowserRender[]> {
  const react = patchReactForAPageRender()
  installStubs(react)
  const h = react.createElement
  // `mock-utils` first, as `render-every-entry.ts` and `playground.tsx` import it, so a module that reads
  // `window.electronAPI` at load finds the fixture.
  await import('../../mock-utils')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { setupI18n } = await import('@nessy-agent/shared/i18n')
  const { initReactI18next } = await import('react-i18next')
  const { PlaygroundEntryFrame, playgroundEntryProps } = await import('../../ComponentPreview')
  const { serverDirectoryBrowserComponents } = await import('../../registry/server-directory-browser')

  // The page's own i18n, pinned to English (F1.103's rule).
  const i18n = setupI18n([initReactI18next])
  await i18n.changeLanguage('en')

  const renders: ServerDirectoryBrowserRender[] = []
  for (const entry of serverDirectoryBrowserComponents) {
    const defaults: Record<string, unknown> = {}
    for (const prop of entry.props) defaults[prop.name] = prop.defaultValue
    const cases = [{ variant: null as string | null, props: {} as Record<string, unknown> }, ...(entry.variants ?? []).map(v => ({ variant: v.name, props: v.props }))]
    for (const { variant, props } of cases) {
      try {
        const markup = renderToStaticMarkup(h(PlaygroundEntryFrame, { component: entry, props: playgroundEntryProps(entry, { ...defaults, ...props }) }))
        renders.push({ id: entry.id, variant, markup })
      } catch (error) {
        renders.push({ id: entry.id, variant, error: (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).split('\n')[0] })
      }
    }
  }
  return renders
}

if (import.meta.main) {
  const renders = await renderServerDirectoryBrowserEntries()
  // Exit once stdout has drained: the rendered graph leaves timers behind (render-every-entry.ts, measured).
  process.stdout.write(`\n${SERVER_DIRECTORY_BROWSER_MARKER}${JSON.stringify(renders)}\n`, () => process.exit(0))
}
