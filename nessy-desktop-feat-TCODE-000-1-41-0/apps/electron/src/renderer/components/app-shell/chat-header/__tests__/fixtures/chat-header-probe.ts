/**
 * UB14.6 — the CHILD PROCESS behind `../chat-header.test.tsx`: renders the chat-header playground entry
 * (`playground/registry/chat-header.tsx`) the way the playground page does, drives the header's share menu, its
 * actions slot and its label strip through their own code, and prints one JSON reading on stdout after
 * `CHAT_HEADER_PROBE_MARKER`.
 *
 * ## Why a child
 *
 * `ChatHeader` cannot load under a plain `bun test`: its graph reaches `ThemeContext`'s Vite-only
 * `import.meta.glob` (through `LabelIcon`) and pdfjs's `?url` import. The stubs that make it load are
 * process-global and two of them cannot be spread and restored (F1.216's ruling for `render-every-entry.ts`,
 * whose `patchReactForAPageRender` / `installStubs` this file reuses, as UB14.2's and UB14.3's probes do), so they
 * live and die in this process. Its `ThemeContext` stub is `mode: 'dark'`: every state below is the DARK sweep.
 *
 * ## The readings
 *
 *  1. **states** — every state of the `chat-header` entry through `PlaygroundEntryFrame` with
 *     `renderToStaticMarkup`, as `render-every-entry.ts` renders them. A static render runs no layout effect, so
 *     the label strip keeps its initial fit (`CHAT_HEADER_MAX_LABELS`): three chips, then "+N".
 *  2. **share** — `ChatShareMenu` called as a function inside a probe component (its hooks become the probe's),
 *     its root `DropdownMenu` opened by cloning it with `open`, and the "Learn More" item's own `onClick` called
 *     once with `electronAPI.openUrl` recording the URL — for a session that is not shared and one that is.
 *  3. **actions** — `ChatHeader`'s inner function (the memo's `type`) called the same way; the element types of
 *     its actions slot, in order, for a plain session, a task orchestrator, and sharing off; plus the memo's own
 *     `compare` (`sameHeaderProps`) on a field-equal new meta object and on real changes.
 *  4. **pendingEdit** — `ChatHeaderLabels` mounted on the REAL react-dom reconciler (its effects are the
 *     behaviour), host-less: a probe component calls it as a function and keeps the returned tree, the way
 *     `hooks/__tests__/fixtures/render-hook.ts` (UB14.46) runs hooks. A Jotai store holds
 *     `pendingLabelValueEditAtom`; after the effects flush the reading lists the chips whose `open` prop is true
 *     and what the atom holds.
 *
 * Everything with a side effect sits behind `import.meta.main` (AGENTS.md §Traps).
 */
import { installStubs, patchReactForAPageRender } from '../../../../../playground/__tests__/fixtures/render-every-entry'

export const CHAT_HEADER_PROBE_MARKER = '@@CHAT-HEADER-PROBE@@'

export interface PendingEditCase {
  /** `<label id>` or `<label id>::<raw value>` of every chip rendered with `open` true. */
  openChips: string[]
  /** The atom's value after the effects flushed (null = consumed or dropped). */
  atomAfter: unknown
}

export interface ChatHeaderProbeReading {
  /** `chat-header · <variant name or (base state)>` → the entry's whole markup. */
  states: Record<string, string>
  threw: Record<string, string>
  share: {
    notShared: { markup: string; learnMoreUrls: string[] }
    shared: { markup: string; learnMoreUrls: string[] }
  }
  actions: {
    plain: string[]
    taskOrchestrator: string[]
    sharingOff: string[]
    compact: string[]
    /** Props the WorkspaceActionsMenu element was given (plain session). */
    workspaceActionsProps: Record<string, unknown> | null
  }
  sameHeaderProps: {
    fieldEqualNewMeta: boolean
    titleChanged: boolean
    metaFieldChanged: boolean
    sharingToggled: boolean
  }
  pendingEdit: Record<'matching' | 'otherPanel' | 'stale' | 'notArrived' | 'newestOfTwo', PendingEditCase>
}

type ReactModule = typeof import('react')
type AnyElement = import('react').ReactElement<Record<string, unknown>>

function isElement(node: unknown): node is AnyElement {
  return !!node && typeof node === 'object' && 'props' in node && 'type' in node
}

/** Depth-first walk of an element tree (elements only; components are not rendered). */
function walk(node: unknown, visit: (element: AnyElement) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (!isElement(node)) return
  visit(node)
  walk(node.props.children, visit)
}

/** The string children under an element tree, joined (what a reader would see of an unrendered subtree). */
function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (!isElement(node)) return ''
  return textOf(node.props.children)
}

function typeName(element: AnyElement): string {
  const type = element.type as unknown
  if (typeof type === 'string') return type
  if (typeof type === 'function') return (type as { displayName?: string; name: string }).displayName ?? (type as { name: string }).name
  if (type && typeof type === 'object') {
    const named = type as { displayName?: string; render?: { name?: string } }
    return named.displayName ?? named.render?.name ?? 'object'
  }
  return String(type)
}

export async function probeChatHeader(): Promise<ChatHeaderProbeReading> {
  const react: ReactModule = patchReactForAPageRender()
  installStubs(react)
  const h = react.createElement
  await import('../../../../../playground/mock-utils')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { createRoot } = await import('react-dom/client')
  const { Provider: JotaiProvider, createStore } = await import('jotai')
  const { setupI18n } = await import('@nessy-agent/shared/i18n')
  const { initReactI18next } = await import('react-i18next')
  const { EscapeInterruptProvider } = await import('@/context/EscapeInterruptContext')
  const { AppShellProvider } = await import('@/context/AppShellContext')
  const { PlaygroundAppShellProvider, playgroundAppShellValue } = await import('../../../../../playground/PlaygroundAppShellProvider')
  const { PlaygroundEntryFrame, playgroundEntryProps } = await import('../../../../../playground/ComponentPreview')
  const { chatHeaderComponents } = await import('../../../../../playground/registry/chat-header')
  const { ChatHeader } = await import('../../ChatHeader')
  const { ChatShareMenu } = await import('../../ChatShareMenu')
  const { ChatHeaderLabels } = await import('../../ChatHeaderLabels')
  const { pendingLabelValueEditAtom } = await import('@/atoms/label-value-edit')

  const i18n = setupI18n([initReactI18next])
  await i18n.changeLanguage('en')

  const page = (child: import('react').ReactNode) =>
    h(JotaiProvider, null, h(EscapeInterruptProvider, null, h(PlaygroundAppShellProvider, null, child)))

  // --- 1. states ---------------------------------------------------------------------------------------------
  const states: Record<string, string> = {}
  const threw: Record<string, string> = {}
  for (const entry of chatHeaderComponents) {
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

  // --- 2. share menu -----------------------------------------------------------------------------------------
  const api = (globalThis as unknown as { window: { electronAPI: Record<string, unknown> } }).window.electronAPI
  const baseItem = {
    id: 'session-1', workspaceId: 'playground-workspace', name: 'Port the regression test', lastMessageAt: 0,
    labels: ['bug', 'code::git', 'priority::2'], sessionStatus: 'in-progress', workingDirectory: '/Users/demo/nessy-desktop',
  }
  const readShare = (item: Record<string, unknown>) => {
    const urls: string[] = []
    const realOpenUrl = api.openUrl
    api.openUrl = async (url: string) => { urls.push(url) }
    try {
      let clicked = false
      function ShareProbe() {
        const tree = (ChatShareMenu as unknown as (props: { item: unknown }) => AnyElement)({ item })
        if (!clicked) {
          clicked = true
          let learnMore: AnyElement | null = null
          walk(tree, element => {
            if (!learnMore && typeof element.props.onClick === 'function' && textOf(element.props.children) === i18n.t('chat.learnMore')) {
              learnMore = element
            }
          })
          if (!learnMore) throw new Error('no "Learn More" item in the ChatShareMenu tree')
          ;((learnMore as AnyElement).props.onClick as () => void)()
        }
        return react.cloneElement(tree, { open: true })
      }
      const markup = renderToStaticMarkup(page(h(ShareProbe)))
      return { markup, learnMoreUrls: urls }
    } finally {
      api.openUrl = realOpenUrl
    }
  }
  const share = {
    notShared: readShare(baseItem),
    shared: readShare({ ...baseItem, sharedUrl: 'https://artifacts.example/s/abc' }),
  }

  // --- 3. actions slot + sameHeaderProps ---------------------------------------------------------------------
  const memo = ChatHeader as unknown as {
    type: (props: Record<string, unknown>) => AnyElement
    compare: (a: Record<string, unknown>, b: Record<string, unknown>) => boolean
  }
  const shell = (compact: boolean) => ({
    ...playgroundAppShellValue,
    isCompactMode: compact,
    sessionStatuses: [{ id: 'in-progress', label: 'In Progress', resolvedColor: 'currentColor', icon: null, iconColorable: true }],
    labels: [{ id: 'bug', name: 'Bug' }, { id: 'code', name: 'Code', valueType: 'string' }, { id: 'priority', name: 'Priority', valueType: 'number' }],
  })
  let workspaceActionsProps: Record<string, unknown> | null = null
  const readActions = (props: Record<string, unknown>, compact = false) => {
    let order: string[] = []
    function ActionsProbe() {
      const tree = memo.type(props)
      let panelHeader: AnyElement | null = null
      walk(tree, element => {
        if (!panelHeader && typeName(element) === 'PanelHeader') panelHeader = element
      })
      if (!panelHeader) throw new Error('no PanelHeader in the ChatHeader tree')
      const actions = (panelHeader as AnyElement).props.actions as AnyElement
      const children = ([] as unknown[]).concat(actions.props.children).filter(isElement) as AnyElement[]
      order = children.map(typeName)
      const launcher = children.find(child => typeName(child) === 'WorkspaceActionsMenu')
      if (launcher && !workspaceActionsProps) workspaceActionsProps = { ...launcher.props }
      return null
    }
    renderToStaticMarkup(h(JotaiProvider, null, h(AppShellProvider, { value: shell(compact) as never, children: h(ActionsProbe) })))
    return order
  }
  const headerProps = { sessionId: 'session-1', item: baseItem, title: 'Port the regression test', workingDirectory: baseItem.workingDirectory }
  const actions = {
    plain: readActions(headerProps),
    taskOrchestrator: readActions({ ...headerProps, item: { ...baseItem, taskSlug: 'port-the-regression-test' } }),
    sharingOff: readActions({ ...headerProps, sharingEnabled: false }),
    compact: readActions(headerProps, true),
    workspaceActionsProps: null as Record<string, unknown> | null,
  }
  actions.workspaceActionsProps = workspaceActionsProps
  const sameHeaderProps = {
    fieldEqualNewMeta: memo.compare(headerProps, { ...headerProps, item: { ...baseItem, labels: baseItem.labels } }),
    titleChanged: memo.compare(headerProps, { ...headerProps, title: 'Renamed' }),
    metaFieldChanged: memo.compare(headerProps, { ...headerProps, item: { ...baseItem, sessionStatus: 'done' } }),
    sharingToggled: memo.compare(headerProps, { ...headerProps, sharingEnabled: false }),
  }

  // --- 4. the pending label-value edit, on the real reconciler ------------------------------------------------
  const g = globalThis as Record<string, unknown>
  // react-dom's commit compares the focused element with `instanceof window.HTMLIFrameElement`; `window` is this
  // global object here (installStubs), so the class goes on it.
  if (typeof g.HTMLIFrameElement === 'undefined') g.HTMLIFrameElement = class {}
  g.IS_REACT_ACT_ENVIRONMENT = true
  const container = {
    nodeType: 1, tagName: 'DIV', namespaceURI: 'http://www.w3.org/1999/xhtml', ownerDocument: null, textContent: '',
    addEventListener() {}, removeEventListener() {},
  }
  const labelTree = [
    { id: 'bug', name: 'Bug' }, { id: 'code', name: 'Code', valueType: 'string' },
    { id: 'priority', name: 'Priority', valueType: 'number' }, { id: 'due', name: 'Due', valueType: 'date' },
  ]
  const readPending = (labels: string[], pending: Record<string, unknown>): PendingEditCase => {
    const store = createStore()
    store.set(pendingLabelValueEditAtom, pending as never)
    let last: unknown = null
    function LabelsProbe() {
      last = (ChatHeaderLabels as unknown as (props: Record<string, unknown>) => unknown)({
        item: { ...baseItem, labels }, labels: labelTree, onLabelsChange: () => {}, rowEl: null,
      })
      return null
    }
    const root = createRoot(container as unknown as Element)
    react.act(() => {
      root.render(h(JotaiProvider, { store }, h(AppShellProvider, { value: { ...shell(false), panelId: 'panel-a' } as never, children: h(LabelsProbe) })))
    })
    const openChips: string[] = []
    walk(last, element => {
      if (typeName(element) !== 'EntityListLabelBadge' || element.props.open !== true) return
      const label = element.props.label as { id: string }
      const raw = element.props.rawValue as string | undefined
      openChips.push(raw ? `${label.id}::${raw}` : label.id)
    })
    const atomAfter = store.get(pendingLabelValueEditAtom)
    react.act(() => root.unmount())
    return { openChips, atomAfter }
  }
  const now = Date.now()
  const pendingEdit = {
    matching: readPending(['bug', 'priority::2'], { sessionId: 'session-1', panelId: 'panel-a', labelId: 'priority', requestedAt: now }),
    otherPanel: readPending(['bug', 'priority::2'], { sessionId: 'session-1', panelId: 'panel-b', labelId: 'priority', requestedAt: now }),
    stale: readPending(['bug', 'priority::2'], { sessionId: 'session-1', panelId: 'panel-a', labelId: 'priority', requestedAt: now - 11_000 }),
    notArrived: readPending(['bug'], { sessionId: 'session-1', panelId: 'panel-a', labelId: 'due', requestedAt: now }),
    newestOfTwo: readPending(['code::git', 'code::svn'], { sessionId: 'session-1', panelId: 'panel-a', labelId: 'code', requestedAt: now }),
  }

  return { states, threw, share, actions, sameHeaderProps, pendingEdit }
}

if (import.meta.main) {
  const started = performance.now()
  const reading = await probeChatHeader()
  process.stderr.write(`[chat-header-probe] ${Object.keys(reading.states).length} states in ${Math.round(performance.now() - started)} ms\n`)
  // Exit once stdout has drained: the rendered graph leaves timers behind (render-every-entry.ts measured it).
  process.stdout.write(`\n${CHAT_HEADER_PROBE_MARKER}${JSON.stringify(reading)}\n`, () => process.exit(0))
}
