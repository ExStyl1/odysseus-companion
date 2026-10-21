/**
 * UB14.44 — the CHILD PROCESS behind `../automations-restyle.test.tsx`: renders every state of the automations
 * playground (`playground/registry/automations.tsx`: the list panel, the info page, the card, the cron builder,
 * the avatar gallery, the test panel, the timeline and the webhook details well) the way the playground page does,
 * and prints one JSON reading on stdout after `AUTOMATIONS_PROBE_MARKER`.
 *
 * ## Why a child
 *
 * The list panel and the info page cannot load under a plain `bun test`: their graph reaches pdfjs's Vite-only
 * `?url` import and `ThemeContext`'s `import.meta.glob` (`automation-script-registry.test.ts` names the first).
 * The stubs that make that graph load are process-global and two of them cannot be spread and restored (F1.216's
 * ruling for `render-every-entry.ts`, whose `patchReactForAPageRender` / `installStubs` this file reuses, as
 * UB14.3's `session-row-probe.ts` does), so they live and die in this process.
 *
 * ## The reading
 *
 * Every state (the base state and each variant) of every entry, rendered through `PlaygroundEntryFrame` with
 * `renderToStaticMarkup` exactly as `render-every-entry.ts` renders it, inside a `.dark` root (and the stub's
 * `ThemeContext` is `mode: 'dark'`): the owner's dark-theme sweep of the design surface.
 *
 * Everything with a side effect sits behind `import.meta.main` (AGENTS.md §Traps).
 */
import { installStubs, patchReactForAPageRender } from '../../../../playground/__tests__/fixtures/render-every-entry'

export const AUTOMATIONS_PROBE_MARKER = '@@AUTOMATIONS-PROBE@@'

export interface AutomationsProbeReading {
  /** `<entry id> · <variant name or (base state)>` → the whole markup. */
  states: Record<string, string>
  /** States that threw, with the first line of the error. */
  threw: Record<string, string>
}

type ReactModule = typeof import('react')

export async function probeAutomations(): Promise<AutomationsProbeReading> {
  const react: ReactModule = patchReactForAPageRender()
  installStubs(react)
  const h = react.createElement
  await import('../../../../playground/mock-utils')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { Provider: JotaiProvider } = await import('jotai')
  const { setupI18n } = await import('@nessy-agent/shared/i18n')
  const { initReactI18next } = await import('react-i18next')
  const { EscapeInterruptProvider } = await import('@/context/EscapeInterruptContext')
  const { PlaygroundAppShellProvider } = await import('../../../../playground/PlaygroundAppShellProvider')
  const { PlaygroundEntryFrame, playgroundEntryProps } = await import('../../../../playground/ComponentPreview')
  const { automationComponents } = await import('../../../../playground/registry/automations')

  const i18n = setupI18n([initReactI18next])
  await i18n.changeLanguage('en')

  const page = (child: import('react').ReactNode) =>
    h(JotaiProvider, null,
      h(EscapeInterruptProvider, null,
        h(PlaygroundAppShellProvider, null, h('div', { className: 'dark' }, child))))

  const states: Record<string, string> = {}
  const threw: Record<string, string> = {}
  for (const entry of automationComponents) {
    const defaults: Record<string, unknown> = {}
    for (const prop of entry.props) defaults[prop.name] = prop.defaultValue
    const cases = [
      { variant: '(base state)', props: {} as Record<string, unknown> },
      ...(entry.variants ?? []).map(variant => ({ variant: variant.name, props: variant.props })),
    ]
    for (const { variant, props } of cases) {
      const key = `${entry.id} · ${variant}`
      try {
        states[key] = renderToStaticMarkup(
          page(h(PlaygroundEntryFrame, { component: entry, props: playgroundEntryProps(entry, { ...defaults, ...props }) })),
        )
      } catch (error) {
        threw[key] = error instanceof Error ? `${error.name}: ${error.message.split('\n')[0]}` : String(error)
      }
    }
  }
  return { states, threw }
}

if (import.meta.main) {
  const started = performance.now()
  const reading = await probeAutomations()
  process.stderr.write(`[automations-probe] ${Object.keys(reading.states).length} states in ${Math.round(performance.now() - started)} ms\n`)
  // Exit once stdout has drained: the rendered graph leaves timers behind (render-every-entry.ts measured it).
  process.stdout.write(`\n${AUTOMATIONS_PROBE_MARKER}${JSON.stringify(reading)}\n`, () => process.exit(0))
}
