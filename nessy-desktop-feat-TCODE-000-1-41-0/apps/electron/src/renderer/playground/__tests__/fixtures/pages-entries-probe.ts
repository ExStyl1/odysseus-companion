/**
 * UB14.53 — the CHILD PROCESS behind `../pages-restyle-registry.test.ts`: render every state of the Pages playground
 * entries (`registry/pages.tsx`: the library, the tile, the delete dialog, the share dialog and the page view) the way
 * the playground page draws them — `playground.tsx`'s providers around `ComponentPreview`'s own frame
 * (`PlaygroundEntryFrame`, whose `TooltipProvider` the view's Back tooltip needs) — and print the markup as JSON.
 *
 * Why a child, and why these stubs: `render-every-entry.ts`'s docblock (a Radix portal draws its content in place,
 * so an open dialog is on the page; the process-global stubs must die with the process). Its `ThemeContext` stub
 * resolves DARK, so this is the dark sweep. The same shape as UB14.39's `ours-dialog-entries-probe.ts`, plus the
 * page providers `render-every-entry.ts` puts round every entry (the library and the view read the app shell).
 *
 * Everything with a side effect sits behind `import.meta.main` (AGENTS.md §Traps).
 */
import { installStubs, patchReactForAPageRender } from './render-every-entry'

export const PAGES_ENTRIES_MARKER = '@@PAGES-ENTRIES@@'

export interface PagesEntryRender {
  id: string
  /** `null` for the entry's own defaults; the variant's name otherwise. */
  variant: string | null
  markup?: string
  /** First line of the thrown error, when the render threw. */
  error?: string
}

export async function renderPagesEntries(): Promise<PagesEntryRender[]> {
  const react = patchReactForAPageRender()
  installStubs(react)
  const h = react.createElement
  // `mock-utils` first, as `render-every-entry.ts` and `playground.tsx` import it, so a module that reads
  // `window.electronAPI` at load finds the fixture.
  await import('../../mock-utils')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { Provider: JotaiProvider } = await import('jotai')
  const { setupI18n } = await import('@nessy-agent/shared/i18n')
  const { initReactI18next } = await import('react-i18next')
  const { EscapeInterruptProvider } = await import('@/context/EscapeInterruptContext')
  const { PlaygroundAppShellProvider } = await import('../../PlaygroundAppShellProvider')
  const { PlaygroundEntryFrame, playgroundEntryProps } = await import('../../ComponentPreview')
  const { pagesComponents } = await import('../../registry/pages')

  // The page's own i18n, pinned to English (F1.103's rule).
  const i18n = setupI18n([initReactI18next])
  await i18n.changeLanguage('en')

  const renders: PagesEntryRender[] = []
  for (const entry of pagesComponents) {
    // The defaults an entry is FIRST shown with, then each variant over them (`playgroundEntryProps` merges them).
    const cases = [
      { variant: null as string | null, props: {} as Record<string, unknown> },
      ...(entry.variants ?? []).map(v => ({ variant: v.name as string | null, props: v.props })),
    ]
    for (const { variant, props } of cases) {
      try {
        const markup = renderToStaticMarkup(
          h(JotaiProvider, null,
            h(EscapeInterruptProvider, null,
              h(PlaygroundAppShellProvider, null,
                h(PlaygroundEntryFrame, { component: entry, props: playgroundEntryProps(entry, props) })))),
        )
        renders.push({ id: entry.id, variant, markup })
      } catch (error) {
        renders.push({ id: entry.id, variant, error: (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).split('\n')[0] })
      }
    }
  }
  return renders
}

if (import.meta.main) {
  const renders = await renderPagesEntries()
  // Exit once stdout has drained: the rendered graph leaves timers behind (render-every-entry.ts, measured).
  process.stdout.write(`\n${PAGES_ENTRIES_MARKER}${JSON.stringify(renders)}\n`, () => process.exit(0))
}
