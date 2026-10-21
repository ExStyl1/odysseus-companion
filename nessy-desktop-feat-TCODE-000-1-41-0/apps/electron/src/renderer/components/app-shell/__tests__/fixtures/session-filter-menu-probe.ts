/**
 * UB14.5 — the CHILD PROCESS behind `../session-filter-menu.test.tsx`: renders the `session-filter-menu` playground
 * entry (`playground/registry/session-list.tsx`) the way the playground page does, drives the menu through its own
 * handlers, and prints one JSON reading on stdout after `SESSION_FILTER_MENU_PROBE_MARKER`.
 *
 * ## Why a child
 *
 * `SessionFilterMenu` cannot load under a plain `bun test`: `LabelIcon` imports `ThemeContext` (Vite's
 * `import.meta.glob` at module scope), and an open menu's content sits in a Radix portal, which renders nothing on
 * the server. The stubs that answer both are process-global and two of them cannot be spread and restored (F1.216's
 * ruling for `render-every-entry.ts`, whose `patchReactForAPageRender` / `installStubs` this file reuses, as UB14.2's
 * `panel-stack-probe.ts` and UB14.3's `session-row-probe.ts` do), so they live and die in this process. With them a
 * portal renders its content in place, so an OPEN menu's markup is readable.
 *
 * ## The readings
 *
 *  1. **states** — every state of the playground entry rendered through `PlaygroundEntryFrame` with
 *     `renderToStaticMarkup`, exactly as `render-every-entry.ts` renders it (dark: its `ThemeContext` stub is
 *     `mode: 'dark'`).
 *  2. **drives** — a static render cannot click, so each action is a RENDER-PHASE update: `SessionFilterMenu` is
 *     called as a function inside a harness component (its hooks become the harness's), the harness finds an element
 *     in the tree the menu RETURNED and calls that element's own handler once per render, and React's server renderer
 *     re-renders the harness with the new state. The filter maps live in the harness behind AppShell's setter
 *     contract (a Map or an updater over the previous Map). Items inside a closed submenu are still elements of that
 *     tree (Radix only skips DRAWING them), which is how a status, a label in a nested group and a project are
 *     reached: the path a hover would open. `FilterLabelItems` (hook-free, upstream's shape) is expanded by calling
 *     it with its own props, so its items are its own elements and handlers.
 *  3. **stored** — the driven maps written the way AppShell persists a view's filter (`Object.fromEntries` into the
 *     `viewFilters` entry), through JSON, read back the way AppShell derives its Maps (`new Map(Object.entries(…))`),
 *     and rendered again in a fresh menu.
 *
 * Everything with a side effect sits behind `import.meta.main` (AGENTS.md §Traps).
 */
import { installStubs, patchReactForAPageRender } from '../../../../playground/__tests__/fixtures/render-every-entry'

export const SESSION_FILTER_MENU_PROBE_MARKER = '@@SESSION-FILTER-MENU-PROBE@@'

export const PROBED_ENTRY = 'session-filter-menu'

type Entries = Array<[string, string]>

export interface DriveReading {
  /** The three maps after the last action, as entries. */
  listFilter: Entries
  labelFilter: Entries
  projectFilter: Entries
  /** How many actions found their element and ran (each must find one). */
  ran: number
  /** The menu's markup after the last action (open). */
  markup: string
}

export interface SessionFilterMenuProbeReading {
  /** `<variant name or (base state)>` → the entry's whole markup. */
  states: Record<string, string>
  /** States that threw, with the first line of the error. */
  threw: Record<string, string>
  drives: {
    /** From no filter: Done, ⌥ Bug, Frontend (nested in the Area group), Gateway — each through its own item's onClick. */
    everyKind: DriveReading
    /** The same maps written as AppShell stores a view's filter, read back, rendered in a fresh open menu. */
    storedRender: string
    /** The stored entry as JSON (what localStorage holds for the view). */
    storedJson: string
    /** From live AND stale ids of every kind: the header's Clear button. */
    clear: DriveReading
    /** The flat list (query "bug"): Enter on the search input toggles the highlighted label in. */
    searchEnter: DriveReading
    /** The flat list (query "bug"): ⌥ Enter excludes it. */
    searchAltEnter: DriveReading
  }
  /** A live label filter and nothing else, open: the negative arm of UA12.162. */
  liveLabelOnly: string
}

type ReactModule = typeof import('react')
type AnyElement = import('react').ReactElement<Record<string, unknown>> & { type: unknown }

/** The component's own name (function declarations keep it after bun's transpile). */
const nameOf = (type: unknown): string | undefined =>
  typeof type === 'function' ? (type as { name?: string }).name : undefined

/**
 * Depth-first search of an element tree for the first element whose props satisfy `match`. `FilterLabelItems` is
 * expanded by calling it with its own props (it holds no hooks), so the label items it returns are searched too.
 */
function findElement(node: unknown, match: (element: AnyElement) => boolean): AnyElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findElement(child, match)
      if (hit) return hit
    }
    return null
  }
  if (!node || typeof node !== 'object' || !('props' in node)) return null
  const element = node as AnyElement
  if (match(element)) return element
  if (nameOf(element.type) === 'FilterLabelItems') {
    return findElement((element.type as (props: unknown) => unknown)(element.props), match)
  }
  return findElement(element.props.children, match)
}

/** An item (or sub-trigger) whose row is a `FilterMenuRow` labelled `label`, carrying an onClick. */
const itemLabelled = (label: string) => (element: AnyElement) => {
  if (typeof element.props.onClick !== 'function') return false
  const row = element.props.children as AnyElement | undefined
  return !!row && typeof row === 'object' && nameOf(row.type) === 'FilterMenuRow' && row.props.label === label
}

const event = (extra: Record<string, unknown> = {}) => ({ preventDefault() {}, stopPropagation() {}, altKey: false, ...extra })

export async function probeSessionFilterMenu(): Promise<SessionFilterMenuProbeReading> {
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
  const { sessionListComponents, filterMenuLabels, filterMenuProjects, filterMenuStatuses } = await import('../../../../playground/registry/session-list')
  const { SessionFilterMenu } = await import('../../SessionFilterMenu')

  const i18n = setupI18n([initReactI18next])
  await i18n.changeLanguage('en')

  const page = (child: import('react').ReactNode) =>
    h(JotaiProvider, null, h(EscapeInterruptProvider, null, h(PlaygroundAppShellProvider, null, child)))

  // --- 1. states: the playground entry, every variant ----------------------------------------------------------
  const states: Record<string, string> = {}
  const threw: Record<string, string> = {}
  const entry = sessionListComponents.find(e => e.id === PROBED_ENTRY)
  if (!entry) throw new Error(`no playground entry "${PROBED_ENTRY}"`)
  const defaults: Record<string, unknown> = {}
  for (const prop of entry.props) defaults[prop.name] = prop.defaultValue
  for (const { variant, props } of [
    { variant: '(base state)', props: {} as Record<string, unknown> },
    ...(entry.variants ?? []).map(v => ({ variant: v.name, props: v.props })),
  ]) {
    try {
      states[variant] = renderToStaticMarkup(
        page(h(PlaygroundEntryFrame, { component: entry, props: playgroundEntryProps(entry, { ...defaults, ...props }) })),
      )
    } catch (error) {
      threw[variant] = error instanceof Error ? `${error.name}: ${error.message.split('\n')[0]}` : String(error)
    }
  }

  // --- 2. drives: render-phase updates through the menu's own handlers -----------------------------------------
  type Mode = 'include' | 'exclude'
  type FilterMap = Map<string, Mode>
  type Action = (tree: unknown) => boolean

  const drive = (seed: { list: FilterMap; label: FilterMap; project: FilterMap }, actions: Action[], query = ''): DriveReading => {
    let step = 0
    let ran = 0
    const out: { list: FilterMap; label: FilterMap; project: FilterMap } = { list: seed.list, label: seed.label, project: seed.project }
    function useMap(initial: FilterMap): [FilterMap, (u: FilterMap | ((prev: FilterMap) => FilterMap)) => void] {
      const [value, setValue] = react.useState(initial)
      return [value, u => setValue(prev => (typeof u === 'function' ? u(prev) : u))]
    }
    function Harness() {
      const [list, setList] = useMap(seed.list)
      const [label, setLabel] = useMap(seed.label)
      const [project, setProject] = useMap(seed.project)
      const tree = SessionFilterMenu({
        listFilter: list, setListFilter: setList as never,
        labelFilter: label, setLabelFilter: setLabel,
        projectFilter: project, setProjectFilter: setProject,
        pinnedFilters: { pinnedStatusId: null, pinnedLabelId: null, pinnedFlagged: false },
        effectiveSessionStatuses: filterMenuStatuses,
        labelConfigs: filterMenuLabels, displayLabelConfigs: filterMenuLabels,
        projectMenuOptions: filterMenuProjects,
        isStateSubView: false,
        chatGroupingMode: 'date', setChatGroupingMode: () => {},
        onOpenSearch: () => {},
        defaultOpen: true,
        defaultQuery: query,
      })
      if (step < actions.length) {
        const action = actions[step++]!
        if (action(tree)) ran++
      }
      out.list = list
      out.label = label
      out.project = project
      return tree
    }
    const markup = renderToStaticMarkup(page(h(Harness)))
    return { listFilter: [...out.list], labelFilter: [...out.label], projectFilter: [...out.project], ran, markup }
  }

  const click = (label: string, altKey = false): Action => tree => {
    const item = findElement(tree, itemLabelled(label))
    if (!item) return false
    ;(item.props.onClick as (e: unknown) => void)(event({ altKey }))
    return true
  }
  const clickClear: Action = tree => {
    const clear = findElement(tree, el => el.type === 'button' && el.props.children === i18n.t('common.clear'))
    if (!clear) return false
    ;(clear.props.onClick as (e: unknown) => void)(event())
    return true
  }
  const pressInSearch = (key: string, altKey = false): Action => tree => {
    const input = findElement(tree, el => el.type === 'input' && typeof el.props.onKeyDown === 'function')
    if (!input) return false
    ;(input.props.onKeyDown as (e: unknown) => void)(event({ key, altKey, target: {} }))
    return true
  }

  const empty = () => ({ list: new Map() as FilterMap, label: new Map() as FilterMap, project: new Map() as FilterMap })
  const everyKind = drive(empty(), [click('Done'), click('Bug', true), click('Frontend'), click('Gateway')])

  // --- 3. stored: AppShell's persistence shape, through JSON and back ------------------------------------------
  const storedJson = JSON.stringify({
    'allSessions': {
      statuses: Object.fromEntries(everyKind.listFilter),
      labels: Object.fromEntries(everyKind.labelFilter),
      projects: Object.fromEntries(everyKind.projectFilter),
      groupingMode: 'date',
    },
  })
  const stored = (JSON.parse(storedJson) as Record<string, { statuses: Record<string, Mode>; labels: Record<string, Mode>; projects: Record<string, Mode> }>).allSessions!
  const storedRender = drive({
    list: new Map(Object.entries(stored.statuses)),
    label: new Map(Object.entries(stored.labels)),
    project: new Map(Object.entries(stored.projects)),
  }, []).markup

  const clear = drive({
    list: new Map([['done', 'include'], ['archived-gone', 'include']]),
    label: new Map([['bug', 'exclude'], ['gone', 'include']]),
    project: new Map([['p-gateway', 'include'], ['p-gone', 'exclude']]),
  }, [clickClear])

  const searchEnter = drive(empty(), [pressInSearch('Enter')], 'bug')
  const searchAltEnter = drive(empty(), [pressInSearch('Enter', true)], 'bug')
  const liveLabelOnly = drive({ list: new Map(), label: new Map([['bug', 'include']]), project: new Map() }, []).markup

  return {
    states,
    threw,
    drives: { everyKind, storedRender, storedJson, clear, searchEnter, searchAltEnter },
    liveLabelOnly,
  }

}

if (import.meta.main) {
  const started = performance.now()
  const reading = await probeSessionFilterMenu()
  process.stderr.write(`[session-filter-menu-probe] ${Object.keys(reading.states).length} states in ${Math.round(performance.now() - started)} ms\n`)
  // Exit once stdout has drained: the rendered graph leaves timers behind (render-every-entry.ts measured it).
  process.stdout.write(`\n${SESSION_FILTER_MENU_PROBE_MARKER}${JSON.stringify(reading)}\n`, () => process.exit(0))
}
