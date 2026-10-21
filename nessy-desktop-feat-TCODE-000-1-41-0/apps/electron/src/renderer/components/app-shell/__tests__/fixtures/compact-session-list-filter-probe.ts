/**
 * UB12.41 — the CHILD PROCESS behind `../compact-session-list-filter.test.tsx`: renders every state of the
 * `compact-session-list-filter` playground entry (`playground/registry/session-list.tsx`) the way the playground page
 * does, and prints one JSON reading on stdout after `COMPACT_SESSION_LIST_FILTER_PROBE_MARKER`.
 *
 * ## Why a child
 *
 * The same reasons as `session-filter-menu-probe.ts` (UB14.5): `LabelIcon` imports `ThemeContext` (Vite's
 * `import.meta.glob` at module scope), and the sheet's content sits in a portal. The process-global stubs that answer
 * both are `render-every-entry.ts`'s `patchReactForAPageRender` / `installStubs` (F1.216's ruling), with its
 * `ThemeContext` stub in DARK mode; every state is also rendered inside a `.dark` root.
 *
 * ## The two readings
 *
 *  1. **staticSweep** — every state with NO `document`, exactly as `render-every-entry.ts` (the F1.216 registry
 *     sweep) renders the entry: the trigger alone, nothing thrown.
 *  2. **states** — every state again with the one `document` read vaul 1.1.2 makes while rendering an OPEN drawer
 *     (`useScaleBackground`: `document.body.style.backgroundColor`, in a `useMemo`), answered by a minimal stub. The
 *     entry opens its sheet on the first render once `document` exists, so these are the OPEN sheets' markup.
 *
 * Everything with a side effect sits behind `import.meta.main` (AGENTS.md §Traps).
 */
import { installStubs, patchReactForAPageRender } from '../../../../playground/__tests__/fixtures/render-every-entry'

export const COMPACT_SESSION_LIST_FILTER_PROBE_MARKER = '@@COMPACT-SESSION-LIST-FILTER-PROBE@@'

export const PROBED_ENTRY = 'compact-session-list-filter'

export interface CompactSessionListFilterProbeReading {
  /** `<variant name or (base state)>` → the entry's whole markup with no DOM (the registry sweep's view). */
  staticSweep: Record<string, string>
  /** `<variant name or (base state)>` → the entry's whole markup with the sheet open where the state asks for it. */
  states: Record<string, string>
  /** `<reading>:<state>` → the first line of the error, for any state that threw. */
  threw: Record<string, string>
}

export async function probeCompactSessionListFilter(): Promise<CompactSessionListFilterProbeReading> {
  const react = patchReactForAPageRender()
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
  const { sessionListComponents } = await import('../../../../playground/registry/session-list')

  const i18n = setupI18n([initReactI18next])
  await i18n.changeLanguage('en')

  const entry = sessionListComponents.find(e => e.id === PROBED_ENTRY)
  if (!entry) throw new Error(`no playground entry "${PROBED_ENTRY}"`)
  const defaults: Record<string, unknown> = {}
  for (const prop of entry.props) defaults[prop.name] = prop.defaultValue
  const cases = [
    { variant: '(base state)', props: {} as Record<string, unknown> },
    ...(entry.variants ?? []).map(v => ({ variant: v.name, props: v.props })),
  ]

  const threw: Record<string, string> = {}
  const sweep = (reading: string): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const { variant, props } of cases) {
      try {
        out[variant] = renderToStaticMarkup(
          h('div', { className: 'dark' },
            h(JotaiProvider, null, h(EscapeInterruptProvider, null, h(PlaygroundAppShellProvider, null,
              h(PlaygroundEntryFrame, { component: entry, props: playgroundEntryProps(entry, { ...defaults, ...props }) }),
            ))),
          ),
        )
      } catch (error) {
        threw[`${reading}:${variant}`] = error instanceof Error ? `${error.name}: ${error.message.split('\n')[0]}` : String(error)
      }
    }
    return out
  }

  const page = globalThis as Record<string, unknown>
  if (typeof page.document !== 'undefined') throw new Error('the static sweep needs a process with no document')
  const staticSweep = sweep('static')
  page.document = { body: { style: {} } }
  const states = sweep('open')
  delete page.document

  return { staticSweep, states, threw }
}

if (import.meta.main) {
  const started = performance.now()
  const reading = await probeCompactSessionListFilter()
  process.stderr.write(`[compact-session-list-filter-probe] ${Object.keys(reading.states).length} states in ${Math.round(performance.now() - started)} ms\n`)
  // Exit once stdout has drained: the rendered graph leaves timers behind (render-every-entry.ts measured it).
  process.stdout.write(`\n${COMPACT_SESSION_LIST_FILTER_PROBE_MARKER}${JSON.stringify(reading)}\n`, () => process.exit(0))
}
