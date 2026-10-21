/**
 * UB14.2 — the CHILD PROCESS behind `../panel-stack-materials.test.tsx`: renders the shipped panel stack the way
 * the playground page does, drives its FLIP and its toast anchor through their own code, and prints one JSON
 * reading on stdout after `PANEL_STACK_PROBE_MARKER`.
 *
 * ## Why a child
 *
 * `PanelStackContainer` imports `useToastAnchor` from `ui/sonner.tsx`, which imports `ThemeContext` (Vite's
 * `import.meta.glob` at module scope: it cannot load under bun), and `PanelSlot` mounts `MainContentPanel`, the
 * whole page graph. The stubs that make that graph load are process-global and two of them cannot be spread and
 * restored (F1.216's ruling for `render-every-entry.ts`, whose `patchReactForAPageRender` / `installStubs` this
 * file reuses), so they live and die in this process.
 *
 * ## The three readings
 *
 *  1. **materials** — every state of the playground entry (`registry/panel-stack.tsx`) rendered through
 *     `PlaygroundEntryFrame` with `renderToStaticMarkup`, exactly as `render-every-entry.ts` renders it.
 *  2. **anchor** — `useToastAnchor`'s layout effect does not run on the server. `react.useLayoutEffect` is
 *     wrapped on the CommonJS object BEFORE any ESM import of `react` (bun snapshots a CommonJS module's named
 *     exports at the first ESM import — `render-every-entry.ts` point 1), so the wrapper sees every layout effect
 *     `PanelStackContainer` declares. The anchor's is the FIRST one the container calls (`useToastAnchor` precedes
 *     its two own `useLayoutEffect`s); the probe runs that effect's real body against a recording
 *     `document.documentElement.style`, then its cleanup.
 *  3. **flip** — `PanelStackContainer` is called as a function inside a probe component (its hooks become the
 *     probe's), so the element tree it RETURNS can be read: the `FlipOnChange` element's real props (`value`,
 *     `enabled`, `axis`, `getTargets`, `onPlay`) and the ref objects of its sidebar / navigator / scroller, which
 *     the probe points at fake elements; each `PanelSlot` element's real `onElements` registers a fake panel and
 *     material. The REAL `FlipOnChange` class is then driven through React's own update order
 *     (`getSnapshotBeforeUpdate` with the old rects, the layout change, `componentDidUpdate`), so `playFlip`,
 *     `playSlideX` and the container's `handleFlipPlayed` run for real and every `el.animate` call is recorded.
 *     Reduced motion is `<html data-motion="reduced">`, the setting's own switch (`flip.ts` `prefersReducedMotion`).
 *
 * Everything with a side effect sits behind `import.meta.main` (AGENTS.md §Traps).
 */
import { installStubs, patchReactForAPageRender } from '../../../../playground/__tests__/fixtures/render-every-entry'

export const PANEL_STACK_PROBE_MARKER = '@@PANEL-STACK-PROBE@@'

export interface AnchorReading {
  case: string
  /** The effect's dependency array: `[left, paneWidth]`. */
  deps: unknown[]
  /** The CSS variables the effect body set on `<html>`. */
  set: Record<string, string>
  /** The variables still set after the cleanup ran. */
  afterCleanup: string[]
}

export interface FlipReading {
  case: string
  value: unknown
  enabled: boolean
  axis: unknown
  /** `getTargets()` as the container answers it: the fake element's role and the FLIP mode. */
  targets: Array<{ role: string; mode: string }>
  /** Every `el.animate` call, in order: the element's role and the first keyframe's transform. */
  animations: Array<{ role: string; from: string }>
  /** `onPlay`'s arguments, when FlipOnChange called it. */
  played: { count: number; from: unknown; to: unknown } | null
}

export interface ProbeReading {
  radiusInner: number
  radiusEdge: number
  panelGap: number
  edgeInset: number
  materials: Record<string, string>
  anchor: AnchorReading[]
  flip: FlipReading[]
}

type ReactModule = typeof import('react')
type Rect = { left: number; top: number; width: number; height: number }

interface FakeElement {
  role: string
  isConnected: boolean
  style: Record<string, string>
  rect: Rect
  getBoundingClientRect: () => Rect
  getAnimations: () => Array<{ id: string; cancel: () => void }>
  animate: (keyframes: Array<Record<string, string>>, options: unknown) => unknown
}

function fakeElement(role: string, rect: Rect, log: Array<{ role: string; from: string }>): FakeElement {
  const el: FakeElement = {
    role,
    isConnected: true,
    style: {},
    rect,
    getBoundingClientRect: () => el.rect,
    getAnimations: () => [],
    animate: (keyframes) => {
      log.push({ role, from: String(keyframes[0]?.transform ?? '') })
      const animation = { id: '', finished: Promise.resolve(), cancel: () => {} }
      return animation
    },
  }
  return el
}

export async function probePanelStack(): Promise<ProbeReading> {
  const react = patchReactForAPageRender()
  // Reading 2: every layout effect declared during a render is recorded (then delegated to the real hook).
  const layoutEffects: Array<{ create: () => void | (() => void); deps: unknown[] | undefined }> = []
  const realLayoutEffect = react.useLayoutEffect
  ;(react as unknown as Record<string, unknown>).useLayoutEffect = ((create: () => void | (() => void), deps?: unknown[]) => {
    layoutEffects.push({ create, deps })
    return realLayoutEffect(create, deps)
  }) as typeof realLayoutEffect
  installStubs(react)
  const h = react.createElement

  await import('../../../../playground/mock-utils')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { Provider: JotaiProvider, createStore } = await import('jotai')
  const { setupI18n } = await import('@nessy-agent/shared/i18n')
  const { initReactI18next } = await import('react-i18next')
  const { EscapeInterruptProvider } = await import('@/context/EscapeInterruptContext')
  const { PlaygroundAppShellProvider } = await import('../../../../playground/PlaygroundAppShellProvider')
  const { PlaygroundEntryFrame, playgroundEntryProps } = await import('../../../../playground/ComponentPreview')
  const { panelStackComponents, buildPreviewPanels } = await import('../../../../playground/registry/panel-stack')
  const { PanelStackContainer } = await import('../../PanelStackContainer')
  const { PanelSlot } = await import('../../PanelSlot')
  const constants = await import('../../panel-constants')
  const { FlipOnChange } = await import('@nessy-agent/ui/motion')
  const { panelStackAtom, focusedPanelIdAtom } = await import('@/atoms/panel-stack')

  const i18n = setupI18n([initReactI18next])
  await i18n.changeLanguage('en')

  // --- 1. materials: the entry's base state and every variant, through the page's own frame.
  const entry = panelStackComponents[0]!
  const materials: Record<string, string> = {}
  const defaults: Record<string, unknown> = {}
  for (const prop of entry.props) defaults[prop.name] = prop.defaultValue
  for (const { name, props } of [{ name: '(base state)', props: {} }, ...(entry.variants ?? [])]) {
    materials[name] = renderToStaticMarkup(
      h(JotaiProvider, null,
        h(EscapeInterruptProvider, null,
          h(PlaygroundAppShellProvider, null,
            h(PlaygroundEntryFrame, { component: entry, props: playgroundEntryProps(entry, { ...defaults, ...props }) })))),
    )
  }

  // The probe: PanelStackContainer's hooks run as the probe's own, and the tree it returns is kept, not rendered.
  type StackProps = Parameters<typeof PanelStackContainer>[0]
  const stackProps = (over: Partial<StackProps>): StackProps => ({
    sidebarSlot: null,
    sidebarWidth: 220,
    navigatorSlot: null,
    navigatorWidth: 300,
    isSidebarAndNavigatorHidden: false,
    isRightSidebarVisible: false,
    ...over,
  })
  const probe = (props: StackProps, panels: '1' | '2' = '1') => {
    const store = createStore()
    const entries = buildPreviewPanels(panels)
    store.set(panelStackAtom, entries)
    store.set(focusedPanelIdAtom, entries[entries.length - 1]!.id)
    let tree: unknown = null
    const Probe = () => {
      tree = PanelStackContainer(props)
      return null
    }
    layoutEffects.length = 0
    // React's server renderer warns once per layout effect; the probe declares them on purpose (reading 2).
    const consoleError = console.error
    console.error = (...args: unknown[]) => {
      if (String(args[0]).startsWith('Warning: useLayoutEffect does nothing on the server')) return
      consoleError(...args)
    }
    try {
      renderToStaticMarkup(h(JotaiProvider, { store }, h(Probe)))
    } finally {
      console.error = consoleError
    }
    return { tree: tree as import('react').ReactElement, effects: [...layoutEffects] }
  }

  // --- 2. anchor: the container's first layout effect is useToastAnchor's; run its real body.
  const page = globalThis as Record<string, unknown>
  const runAnchor = (name: string, props: StackProps): AnchorReading => {
    const { effects } = probe(props)
    const anchor = effects[0]!
    const vars = new Map<string, string>()
    const hadDocument = 'document' in page
    const savedDocument = page.document
    page.document = {
      documentElement: {
        dataset: {},
        style: {
          setProperty: (key: string, value: string) => { vars.set(key, value) },
          removeProperty: (key: string) => { vars.delete(key) },
        },
      },
    }
    try {
      const cleanup = anchor.create()
      const set = Object.fromEntries(vars)
      if (typeof cleanup === 'function') cleanup()
      return { case: name, deps: anchor.deps ?? [], set, afterCleanup: [...vars.keys()] }
    } finally {
      if (hadDocument) page.document = savedDocument
      else delete page.document
    }
  }
  const anchor = [
    runAnchor('desktop: sidebar 220 + list 300', stackProps({})),
    runAnchor('desktop: sidebar hidden', stackProps({ sidebarWidth: 0 })),
    runAnchor('desktop: list hidden', stackProps({ navigatorWidth: 0 })),
    runAnchor('compact', stackProps({ sidebarWidth: 0, isCompact: true })),
  ]

  // --- 3. flip: the real FlipOnChange driven through React's update order on fake elements.
  const findAll = (node: unknown, match: (el: import('react').ReactElement) => boolean, out: import('react').ReactElement[] = []) => {
    if (Array.isArray(node)) {
      for (const child of node) findAll(child, match, out)
      return out
    }
    if (!react.isValidElement(node)) return out
    if (match(node)) out.push(node)
    findAll((node.props as { children?: unknown }).children, match, out)
    return out
  }
  const refOf = (el: import('react').ReactElement | undefined) => (el as unknown as { ref?: { current: unknown } } | undefined)?.ref

  const runFlip = (
    name: string,
    before: StackProps,
    after: StackProps,
    rects: { before: Record<string, Rect>; after: Record<string, Rect> },
    motion: 'full' | 'reduced',
  ): FlipReading => {
    const prev = probe(before).tree
    const next = probe(after).tree
    const [prevFlip] = findAll(prev, el => el.type === FlipOnChange)
    const [nextFlip] = findAll(next, el => el.type === FlipOnChange)
    if (!prevFlip || !nextFlip) throw new Error(`${name}: no FlipOnChange in the desktop tree`)
    const log: Array<{ role: string; from: string }> = []
    const elements = new Map<unknown, FakeElement>()
    const make = (role: string) => {
      const el = fakeElement(role, rects.before[role] ?? { left: 0, top: 0, width: 0, height: 0 }, log)
      elements.set(el, el)
      return el
    }
    // The scroller (holdOverflow), the sidebar and the navigator: the container's own ref objects.
    const scrollerRef = refOf(next)
    if (scrollerRef) scrollerRef.current = make('scroller')
    const [sidebar] = findAll(next, el => (el.props as Record<string, unknown>)['data-panel-role'] === 'sidebar')
    const [navigator] = findAll(next, el => (el.props as Record<string, unknown>)['data-panel-role'] === 'navigator')
    const sidebarRef = refOf(sidebar)
    const navigatorRef = refOf(navigator)
    if (sidebarRef) sidebarRef.current = make('sidebar')
    if (navigatorRef) navigatorRef.current = make('navigator')
    // Each PanelSlot registers its panel and material through the container's own onElements.
    for (const slot of findAll(next, el => el.type === PanelSlot)) {
      const { entry: slotEntry, onElements } = slot.props as { entry: { id: string }; onElements?: (id: string, els: unknown) => void }
      const index = slotEntry.id.split('-').pop()
      onElements?.(slotEntry.id, { panel: make(`panel-${index}`), material: make(`material-${index}`) })
    }

    const flipProps = nextFlip.props as {
      value: unknown
      enabled: boolean
      axis: unknown
      getTargets: () => Array<{ el: FakeElement; mode?: string }>
      onPlay?: (animations: unknown[], change: { from: unknown; to: unknown }) => void
    }
    let played: FlipReading['played'] = null
    const onPlay = flipProps.onPlay
    const drivenProps = {
      ...flipProps,
      onPlay: (animations: unknown[], change: { from: unknown; to: unknown }) => {
        played = { count: animations.length, from: change.from, to: change.to }
        onPlay?.(animations, change)
      },
    }

    const hadDocument = 'document' in page
    const savedDocument = page.document
    page.document = { documentElement: { dataset: { motion }, style: { setProperty: () => {}, removeProperty: () => {} } } }
    try {
      const instance = new FlipOnChange(drivenProps as never)
      // React's order: the snapshot is taken after render, before the DOM changes (the OLD rects) …
      const snapshot = instance.getSnapshotBeforeUpdate(prevFlip.props as never)
      // … the layout commits …
      for (const el of elements.values()) el.rect = rects.after[el.role] ?? el.rect
      // … and the FLIP starts in componentDidUpdate.
      instance.componentDidUpdate(prevFlip.props as never, undefined, snapshot)
    } finally {
      if (hadDocument) page.document = savedDocument
      else delete page.document
    }
    return {
      case: name,
      value: flipProps.value,
      enabled: flipProps.enabled,
      axis: flipProps.axis,
      targets: flipProps.getTargets().map(target => ({ role: target.el.role, mode: target.mode ?? 'translate' })),
      animations: log,
      played,
    }
  }

  // Sidebar 220 + gap 6: the joined card starts at 226 and is 300 + 600 wide; collapsing the sidebar moves it to
  // the window inset (6) and the content card grows by the 220 the sidebar gave up.
  const H = 800
  const open = {
    sidebar: { left: 0, top: 6, width: 220, height: H },
    navigator: { left: 226, top: 6, width: 300, height: H },
    'panel-1': { left: 526, top: 6, width: 600, height: H },
    'material-1': { left: 526, top: 6, width: 600, height: H },
    scroller: { left: 0, top: 0, width: 1132, height: H },
  }
  const collapsed = {
    sidebar: { left: 0, top: 6, width: 0, height: H },
    navigator: { left: 6, top: 6, width: 300, height: H },
    'panel-1': { left: 306, top: 6, width: 820, height: H },
    'material-1': { left: 306, top: 6, width: 820, height: H },
    scroller: { left: 0, top: 0, width: 1132, height: H },
  }
  const flip = [
    runFlip('sidebar collapse (pointer)', stackProps({}), stackProps({ sidebarWidth: 0 }), { before: open, after: collapsed }, 'full'),
    runFlip('sidebar expand (pointer)', stackProps({ sidebarWidth: 0 }), stackProps({}), { before: collapsed, after: open }, 'full'),
    runFlip('sidebar collapse, reduced motion', stackProps({}), stackProps({ sidebarWidth: 0 }), { before: open, after: collapsed }, 'reduced'),
    runFlip('sidebar collapse, keyboard (animateLayout false)', stackProps({ animateLayout: false }), stackProps({ sidebarWidth: 0, animateLayout: false }), { before: open, after: collapsed }, 'full'),
    runFlip('sidebar collapse while resizing', stackProps({ isResizing: true }), stackProps({ sidebarWidth: 0, isResizing: true }), { before: open, after: collapsed }, 'full'),
  ]

  return {
    radiusInner: constants.RADIUS_INNER,
    radiusEdge: constants.RADIUS_EDGE,
    panelGap: constants.PANEL_GAP,
    edgeInset: constants.PANEL_EDGE_INSET,
    materials,
    anchor,
    flip,
  }
}

if (import.meta.main) {
  const started = performance.now()
  const reading = await probePanelStack()
  process.stderr.write(`[panel-stack-probe] done in ${Math.round(performance.now() - started)} ms\n`)
  // The rendered graph leaves timers and listeners behind: exit once stdout has drained (render-every-entry.ts).
  process.stdout.write(`\n${PANEL_STACK_PROBE_MARKER}${JSON.stringify(reading)}\n`, () => process.exit(0))
}
