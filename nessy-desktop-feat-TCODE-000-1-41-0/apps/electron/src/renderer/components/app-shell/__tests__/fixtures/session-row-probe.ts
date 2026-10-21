/**
 * UB14.3 — the CHILD PROCESS behind `../session-item-run-state.test.tsx`: renders the session-row playground
 * entries (`playground/registry/session-list.tsx`) the way the playground page does, drives the two toggles the
 * row owns through their own handlers, and prints one JSON reading on stdout after `SESSION_ROW_PROBE_MARKER`.
 *
 * ## Why a child
 *
 * `SessionItem` cannot load under a plain `bun test`: its graph reaches pdfjs's Vite-only `?url` import and
 * `ThemeContext`'s `import.meta.glob` (`project-grouping.test.ts` measured it). The stubs that make that graph
 * load are process-global and two of them cannot be spread and restored (F1.216's ruling for
 * `render-every-entry.ts`, whose `patchReactForAPageRender` / `installStubs` this file reuses, as UB14.2's
 * `panel-stack-probe.ts` does), so they live and die in this process.
 *
 * ## The two readings
 *
 *  1. **states** — every state of the three entries this row touches (`session-item-search`, `session-badges`,
 *     `session-info-popover`) rendered through `PlaygroundEntryFrame` with `renderToStaticMarkup`, exactly as
 *     `render-every-entry.ts` renders them (dark theme: its `ThemeContext` stub is `mode: 'dark'`).
 *  2. **toggles** — a static render cannot click, so the toggle is driven as a RENDER-PHASE update: the component
 *     is called as a function inside a probe component (its hooks become the probe's), the probe calls the
 *     handler the returned tree carries ONCE during its own render, and React's server renderer re-renders the
 *     probe with the new state — the component's own `useState` and its own handler, nothing re-implemented.
 *     `SessionBadges`: the "+N" element's `onClick` (its `toggle(true)`); `SessionInfoPopover` (uncontrolled,
 *     with a trigger): the `Popover`'s `onOpenChange(true)`.
 *
 * Everything with a side effect sits behind `import.meta.main` (AGENTS.md §Traps).
 */
import { installStubs, patchReactForAPageRender } from '../../../../playground/__tests__/fixtures/render-every-entry'

export const SESSION_ROW_PROBE_MARKER = '@@SESSION-ROW-PROBE@@'

export const PROBED_ENTRIES = ['session-item-search', 'session-badges', 'session-info-popover'] as const

export interface SessionRowProbeReading {
  /** `<entry id> · <variant name or (base state)>` → the entry's whole markup. */
  states: Record<string, string>
  /** States that threw, with the first line of the error. */
  threw: Record<string, string>
  toggles: {
    /** SessionBadges, six labels seeded to two whole: before and after its own "+N" handler ran. */
    badgesBefore: string
    badgesAfter: string
    /** SessionInfoPopover with a trigger and no `open`: before and after its own `onOpenChange(true)`. */
    popoverBefore: string
    popoverAfter: string
  }
}

type ReactModule = typeof import('react')
type AnyElement = import('react').ReactElement<Record<string, unknown>>

/** Depth-first search of an element tree for the first element whose props satisfy `match`. */
function findElement(node: unknown, match: (props: Record<string, unknown>) => boolean): AnyElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findElement(child, match)
      if (hit) return hit
    }
    return null
  }
  if (!node || typeof node !== 'object' || !('props' in node)) return null
  const element = node as AnyElement
  if (match(element.props)) return element
  return findElement(element.props.children, match)
}

export async function probeSessionRows(): Promise<SessionRowProbeReading> {
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
  const { sessionListComponents } = await import('../../../../playground/registry/session-list')
  const { SessionBadges } = await import('../../SessionBadges')
  const { SessionInfoPopover } = await import('../../SessionInfoPopover')
  const { SessionListProvider } = await import('@/context/SessionListContext')

  const i18n = setupI18n([initReactI18next])
  await i18n.changeLanguage('en')

  const page = (child: import('react').ReactNode) =>
    h(JotaiProvider, null, h(EscapeInterruptProvider, null, h(PlaygroundAppShellProvider, null, child)))

  const states: Record<string, string> = {}
  const threw: Record<string, string> = {}
  for (const entry of sessionListComponents.filter(e => (PROBED_ENTRIES as readonly string[]).includes(e.id))) {
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

  // --- toggles: render-phase updates through the components' own handlers ---------------------------------
  const labels = [
    { id: 'bug', name: 'Bug' }, { id: 'feature', name: 'Feature' }, { id: 'frontend', name: 'Frontend' },
    { id: 'backend', name: 'Backend' }, { id: 'priority', name: 'Priority', valueType: 'string' as const },
    { id: 'research', name: 'Research' },
  ]
  const item = {
    id: 'session-1', workspaceId: 'workspace-1', name: 'Labels', lastMessageAt: 0,
    labels: ['bug', 'feature', 'frontend', 'backend', 'priority::high', 'research'],
  }
  const listContext = {
    onRenameClick: () => {}, onSessionStatusChange: () => {}, onMarkUnread: () => {}, onDelete: async () => true,
    onSelectSessionById: () => {}, onOpenInNewWindow: () => {}, onFocusZone: () => {}, onKeyDown: () => {},
    sessionStatuses: [], flatLabels: labels, labels, isMultiSelectActive: false, contentSearchResults: new Map(),
  }
  const renderBadges = (click: boolean) => {
    let clicked = false
    function BadgesProbe() {
      const tree = SessionBadges({ item: item as never, initialFit: 2 }) as unknown as AnyElement | null
      if (click && !clicked) {
        clicked = true
        const more = findElement(tree, props => props['aria-expanded'] === false)
        if (!more) throw new Error('no "+N" element in the SessionBadges tree')
        // `toggle` reads `document.activeElement` (its keyboard focus hand-off). There is no DOM here, so a
        // document with nothing focused stands in for the length of the one call, and is removed again.
        const globals = globalThis as Record<string, unknown>
        const hadDocument = 'document' in globals
        if (!hadDocument) globals.document = { activeElement: undefined }
        try {
          ;(more.props.onClick as (event: unknown) => void)({ stopPropagation() {}, preventDefault() {} })
        } finally {
          if (!hadDocument) delete globals.document
        }
      }
      return tree
    }
    return renderToStaticMarkup(page(h(SessionListProvider, { value: listContext as never }, h(BadgesProbe))))
  }

  const trigger = h('button', { type: 'button' }, 'Info trigger')
  const renderPopover = (open: boolean) => {
    let opened = false
    function PopoverProbe() {
      const tree = SessionInfoPopover({ session: { sessionId: 'session-1', workspaceId: 'workspace-1' }, trigger }) as unknown as AnyElement
      if (open && !opened) {
        opened = true
        ;(tree.props.onOpenChange as (next: boolean) => void)(true)
      }
      return tree
    }
    return renderToStaticMarkup(page(h(PopoverProbe)))
  }

  return {
    states,
    threw,
    toggles: {
      badgesBefore: renderBadges(false),
      badgesAfter: renderBadges(true),
      popoverBefore: renderPopover(false),
      popoverAfter: renderPopover(true),
    },
  }
}

if (import.meta.main) {
  const started = performance.now()
  const reading = await probeSessionRows()
  process.stderr.write(`[session-row-probe] ${Object.keys(reading.states).length} states in ${Math.round(performance.now() - started)} ms\n`)
  // Exit once stdout has drained: the rendered graph leaves timers behind (render-every-entry.ts measured it).
  process.stdout.write(`\n${SESSION_ROW_PROBE_MARKER}${JSON.stringify(reading)}\n`, () => process.exit(0))
}
