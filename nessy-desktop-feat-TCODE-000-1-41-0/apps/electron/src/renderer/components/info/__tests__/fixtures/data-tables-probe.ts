/**
 * UB14.58 — the CHILD PROCESS behind `../data-tables.test.tsx`: renders the four info data tables
 * (`components/info/{Labels,AutoRules,Permissions,Tools}DataTable.tsx`) and prints one JSON reading on
 * stdout after `DATA_TABLES_PROBE_MARKER`.
 *
 * ## Why a child
 *
 * Every table reads `useTheme` (`hooks/useTheme.ts` → `ThemeContext`, whose Vite-only `import.meta.glob`
 * cannot load under bun), and Labels/AutoRules reach it again through `LabelIcon`; the `@nessy-agent/ui`
 * barrel they import reaches pdfjs's `?url` worker. The stubs that make that graph load are process-global
 * and the `ThemeContext` one cannot be spread and restored (F1.216's ruling for `render-every-entry.ts`,
 * whose `patchReactForAPageRender` / `installStubs` this file reuses, as the chat-header probe does), so they
 * live and die in this process. That stub is `mode: 'dark'`: every state below is the DARK sweep.
 *
 * ## The readings
 *
 *  1. **states** — every state of the four `registry/info-data-tables.tsx` entries through
 *     `PlaygroundEntryFrame` with `renderToStaticMarkup`, as `render-every-entry.ts` renders them.
 *  2. **arms** — single-row tables rendered directly for the row's arms: a plain label's auto-rule that
 *     carries a stray `valueTemplate`, a valued label's rule, and one `unenforceable` permission row in
 *     the `annotate` and `grey` styles.
 *
 * Everything with a side effect sits behind `import.meta.main` (AGENTS.md §Traps).
 */
import { installStubs, patchReactForAPageRender } from '../../../../playground/__tests__/fixtures/render-every-entry'

export const DATA_TABLES_PROBE_MARKER = '@@DATA-TABLES-PROBE@@'

/** The stray template a plain label's rule carries, and the one a valued label shows. */
export const PLAIN_TEMPLATE = '$1-plain-ignored'
export const VALUED_TEMPLATE = '$1-valued-shown'
export const ARM_SENTENCE = 'Not enforced: Read is always allowed, so this entry never blocks anything.'

export interface DataTablesProbeReading {
  /** `<entry id> · <variant name or (base state)>` → the entry's whole markup. */
  states: Record<string, string>
  threw: Record<string, string>
  arms: {
    autoRulesPlain: string
    autoRulesValued: string
    permissionsAnnotate: string
    permissionsGrey: string
  }
  /** The playground sample's `unenforceable` sentence (`registry/info-data-tables.tsx`), which the parent cannot import. */
  sampleSentence: string
  /** en strings the assertions name, read from the same i18n instance the render used. */
  strings: Record<'viewFullscreen' | 'statusBlocked' | 'unenforcedBadge' | 'tool' | 'description' | 'access', string>
}

type ReactModule = typeof import('react')

export async function probeDataTables(): Promise<DataTablesProbeReading> {
  const react: ReactModule = patchReactForAPageRender()
  installStubs(react)
  const h = react.createElement
  await import('../../../../playground/mock-utils')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { Provider: JotaiProvider } = await import('jotai')
  const { setupI18n } = await import('@nessy-agent/shared/i18n')
  const { initReactI18next } = await import('react-i18next')
  const { TooltipProvider } = await import('@nessy-agent/ui')
  const { EscapeInterruptProvider } = await import('@/context/EscapeInterruptContext')
  const { PlaygroundAppShellProvider } = await import('../../../../playground/PlaygroundAppShellProvider')
  const { PlaygroundEntryFrame, playgroundEntryProps } = await import('../../../../playground/ComponentPreview')
  const { infoDataTableComponents, UNENFORCEABLE_SENTENCE } = await import('../../../../playground/registry/info-data-tables')
  const { AutoRulesDataTable } = await import('../../AutoRulesDataTable')
  const { PermissionsDataTable } = await import('../../PermissionsDataTable')

  const i18n = setupI18n([initReactI18next])
  await i18n.changeLanguage('en')

  const page = (child: import('react').ReactNode) =>
    h(JotaiProvider, null, h(EscapeInterruptProvider, null, h(PlaygroundAppShellProvider, null, child)))

  // --- 1. states ---------------------------------------------------------------------------------------------
  const states: Record<string, string> = {}
  const threw: Record<string, string> = {}
  for (const entry of infoDataTableComponents) {
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

  // --- 2. arms -----------------------------------------------------------------------------------------------
  const direct = (element: import('react').ReactElement) =>
    renderToStaticMarkup(h('div', { className: 'dark' }, h(TooltipProvider, null, element)))
  const arms = {
    autoRulesPlain: direct(h(AutoRulesDataTable, {
      data: [{ id: 'bug', name: 'Bug', autoRules: [{ pattern: '\\bbug\\b', valueTemplate: PLAIN_TEMPLATE }] }],
    })),
    autoRulesValued: direct(h(AutoRulesDataTable, {
      data: [{ id: 'ticket', name: 'Ticket', valueType: 'string', autoRules: [{ pattern: '(NES-\\d+)', valueTemplate: VALUED_TEMPLATE }] }],
    })),
    permissionsAnnotate: direct(h(PermissionsDataTable, {
      data: [{ access: 'blocked', type: 'tool', pattern: 'Read', comment: 'Workspace blockedTools', unenforceable: ARM_SENTENCE }],
      unenforceableStyle: 'annotate',
    })),
    permissionsGrey: direct(h(PermissionsDataTable, {
      data: [{ access: 'blocked', type: 'tool', pattern: 'Read', comment: 'Workspace blockedTools', unenforceable: ARM_SENTENCE }],
      unenforceableStyle: 'grey',
    })),
  }

  const strings = {
    viewFullscreen: i18n.t('table.viewFullscreen'),
    statusBlocked: i18n.t('table.statusBlocked'),
    unenforcedBadge: i18n.t('settings.permissions.blockedToolsUnenforcedBadge'),
    tool: i18n.t('table.tool'),
    description: i18n.t('common.description'),
    access: i18n.t('table.access'),
  }

  return { states, threw, arms, sampleSentence: UNENFORCEABLE_SENTENCE, strings }
}

if (import.meta.main) {
  const started = performance.now()
  const reading = await probeDataTables()
  process.stderr.write(`[data-tables-probe] ${Object.keys(reading.states).length} states in ${Math.round(performance.now() - started)} ms\n`)
  // Exit once stdout has drained: the rendered graph leaves timers behind (render-every-entry.ts measured it).
  process.stdout.write(`\n${DATA_TABLES_PROBE_MARKER}${JSON.stringify(reading)}\n`, () => process.exit(0))
}
