/**
 * UB14.56 — the CHILD PROCESS behind `../detail-empty-state.test.tsx`: renders every state of the playground entry
 * `main-panel-empty-states` (`playground/registry/panel-stack.tsx`), which mounts the SHIPPED `MainContentPanel`
 * once per navigator with nothing selected, through the playground page's own frame, and prints the markup of each
 * state as one JSON object on stdout after `MAIN_PANEL_EMPTY_PROBE_MARKER`.
 *
 * Why a child: the same reason as `panel-stack-probe.ts` — `MainContentPanel` is the whole page graph, and the
 * stubs that make it load (`render-every-entry.ts` `patchReactForAPageRender` / `installStubs`) are process-global
 * and cannot all be spread and restored. The playground's dark `ThemeContext` stub is the one the registry sweep
 * uses, so this reading is the dark sweep of the entry.
 *
 * Everything with a side effect sits behind `import.meta.main` (AGENTS.md §Traps).
 */
import { installStubs, patchReactForAPageRender } from '../../../../playground/__tests__/fixtures/render-every-entry'

export const MAIN_PANEL_EMPTY_PROBE_MARKER = '@@MAIN-PANEL-EMPTY-PROBE@@'

/** The playground entry the probe renders (its id in `panelStackComponents`). */
export const MAIN_PANEL_EMPTY_ENTRY_ID = 'main-panel-empty-states'

/** `(base state)` plus every variant name → the frame's whole markup for that state. */
export type MainPanelEmptyReading = Record<string, string>

export async function probeMainPanelEmptyStates(): Promise<MainPanelEmptyReading> {
  const react = patchReactForAPageRender()
  installStubs(react)
  const h = react.createElement

  // `mock-utils` first, exactly as `playground.tsx` imports it.
  await import('../../../../playground/mock-utils')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { Provider: JotaiProvider } = await import('jotai')
  const { setupI18n } = await import('@nessy-agent/shared/i18n')
  const { initReactI18next } = await import('react-i18next')
  const { EscapeInterruptProvider } = await import('@/context/EscapeInterruptContext')
  const { PlaygroundAppShellProvider } = await import('../../../../playground/PlaygroundAppShellProvider')
  const { PlaygroundEntryFrame, playgroundEntryProps } = await import('../../../../playground/ComponentPreview')
  const { panelStackComponents } = await import('../../../../playground/registry/panel-stack')

  const i18n = setupI18n([initReactI18next])
  await i18n.changeLanguage('en')

  const entry = panelStackComponents.find(e => e.id === MAIN_PANEL_EMPTY_ENTRY_ID)
  if (!entry) throw new Error(`playground entry ${MAIN_PANEL_EMPTY_ENTRY_ID} is not in panelStackComponents`)

  const defaults: Record<string, unknown> = {}
  for (const prop of entry.props) defaults[prop.name] = prop.defaultValue
  const reading: MainPanelEmptyReading = {}
  for (const { name, props } of [{ name: '(base state)', props: {} }, ...(entry.variants ?? [])]) {
    reading[name] = renderToStaticMarkup(
      h(JotaiProvider, null,
        h(EscapeInterruptProvider, null,
          h(PlaygroundAppShellProvider, null,
            h(PlaygroundEntryFrame, { component: entry, props: playgroundEntryProps(entry, { ...defaults, ...props }) })))),
    )
  }
  return reading
}

if (import.meta.main) {
  const started = performance.now()
  const reading = await probeMainPanelEmptyStates()
  process.stderr.write(`[main-panel-empty-probe] done in ${Math.round(performance.now() - started)} ms\n`)
  // The rendered graph leaves timers and listeners behind: exit once stdout has drained (render-every-entry.ts).
  process.stdout.write(`\n${MAIN_PANEL_EMPTY_PROBE_MARKER}${JSON.stringify(reading)}\n`, () => process.exit(0))
}
