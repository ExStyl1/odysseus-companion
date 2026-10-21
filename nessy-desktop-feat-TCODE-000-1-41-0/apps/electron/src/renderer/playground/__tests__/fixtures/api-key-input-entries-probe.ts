/**
 * UB14.38 — the CHILD PROCESS behind `../api-key-input-registry.test.ts`: render every state of
 * `registry/api-key-input.tsx` (each entry's own defaults, then each variant over them) inside
 * `PlaygroundEntryFrame`, the frame the playground page draws every entry in, once in English and once in
 * Russian, and print the markup as JSON on stdout.
 *
 * The recipe is `dialog-entries-probe.ts`'s (UB14.36), with the API-key registry in place of the dialogs one:
 * why a child and why these stubs is `render-every-entry.ts`'s docblock — the same page render, the same
 * process-global stubs, which must die with the process (the form's import chain is also why
 * `apisetup/__tests__/ModelCatalogPicker.test.tsx` reads source instead of rendering in-process). Its
 * `ThemeContext` stub resolves DARK, so this is the dark sweep. The second language is the row's own need: the
 * eye toggle's accessible name must read the ru value of `common.show`.
 *
 * Everything with a side effect sits behind `import.meta.main` (AGENTS.md §Traps).
 */
import { installStubs, patchReactForAPageRender } from './render-every-entry'

export const API_KEY_INPUT_ENTRIES_MARKER = '@@API-KEY-INPUT-ENTRIES@@'

export interface ApiKeyInputEntryRender {
  id: string
  /** `null` for the entry's own defaults; the variant's name otherwise. */
  variant: string | null
  language: 'en' | 'ru'
  markup?: string
  /** First line of the thrown error, when the render threw. */
  error?: string
}

export async function renderApiKeyInputEntries(): Promise<ApiKeyInputEntryRender[]> {
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
  const { apiKeyInputComponents } = await import('../../registry/api-key-input')

  const i18n = setupI18n([initReactI18next])
  const renders: ApiKeyInputEntryRender[] = []
  for (const language of ['en', 'ru'] as const) {
    await i18n.changeLanguage(language)
    for (const entry of apiKeyInputComponents) {
      const defaults: Record<string, unknown> = {}
      for (const prop of entry.props) defaults[prop.name] = prop.defaultValue
      const cases = [{ variant: null as string | null, props: {} as Record<string, unknown> }, ...(entry.variants ?? []).map(v => ({ variant: v.name, props: v.props }))]
      for (const { variant, props } of cases) {
        try {
          const markup = renderToStaticMarkup(h(PlaygroundEntryFrame, { component: entry, props: playgroundEntryProps(entry, { ...defaults, ...props }) }))
          renders.push({ id: entry.id, variant, language, markup })
        } catch (error) {
          renders.push({ id: entry.id, variant, language, error: (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).split('\n')[0] })
        }
      }
    }
  }
  return renders
}

if (import.meta.main) {
  const renders = await renderApiKeyInputEntries()
  // Exit once stdout has drained: the rendered graph leaves timers behind (render-every-entry.ts, measured).
  process.stdout.write(`\n${API_KEY_INPUT_ENTRIES_MARKER}${JSON.stringify(renders)}\n`, () => process.exit(0))
}
