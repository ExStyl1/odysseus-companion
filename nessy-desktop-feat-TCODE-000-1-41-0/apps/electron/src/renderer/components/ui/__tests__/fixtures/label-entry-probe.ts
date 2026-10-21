/**
 * UB4.13 — the CHILD PROCESS behind `../label-chip-entry.test.ts`: drives the three label writers this row
 * touches through their OWN handlers and prints one JSON reading on stdout after `LABEL_ENTRY_PROBE_MARKER`.
 *
 * ## Why a child
 *
 * `EntityListLabelBadge` and `label-icon` (under the `#` menu) import `ThemeContext`, whose `import.meta.glob` cannot
 * load under a plain `bun test`, and `ChatInputZone` reaches pdfjs's Vite-only `?url` import through `FreeFormInput`.
 * The stubs that make that graph load are process-global and two of them cannot be spread and restored (F1.216's
 * ruling for `render-every-entry.ts`, whose `patchReactForAPageRender` / `installStubs` this file reuses, as
 * UB14.3's `session-row-probe.ts` does), so they live and die in this process.
 *
 * ## How each reading is taken
 *
 * A static render cannot click, so every component is called as a FUNCTION inside a probe component (its hooks
 * become the probe's) and the handler its returned tree carries is called once, during the probe's render:
 *  - **badge** — `EntityListLabelBadge` returns its `LabelValuePopover` element; that element's `onValueChange`
 *    / `onRemove` are the chip's own edit and removal, and `onLabelsChange` records what they write.
 *  - **row** — `SessionBadges` (the session row's label line) returns its chips; the probe reads each
 *    `EntityListLabelBadge` element's props, then calls the badge with the SECOND valued chip's props and runs its
 *    edit, so the write reaches the row's own `ctx.onLabelsChange(sessionId, labels)`.
 *  - **menu** — `useInlineLabelMenu`'s `items`, the `#` menu's label list.
 *  - **composer** — `ChatInputZone` returns its tree; the `onLabelAdd` of the element that carries it (the
 *    `InputContainer`, which hands it to the `#` menu's select) is called with a label id, and `onLabelsChange`
 *    records whether it appended. The probe returns null, so the composer's subtree is never rendered. UB14.33: the
 *    same call's write to `pendingLabelValueEditAtom` (the chat header's chip opens a valued label's editor from it)
 *    is read off jotai's default store, which the composer writes when no `Provider` is mounted, as here.
 *  - **chip** (UB14.35, v0.15.1's look half) — the badge's chip element (`role="button"`) gets ONE synthetic
 *    `onKeyDown` during the probe's first render; an uncontrolled chip's own state update re-renders the probe, so
 *    the popover element's `open` is read after it. The props the badge hands its `LabelValuePopover` (`side`,
 *    `sessionId`) and the chip's own class list and inline style are read off the returned tree.
 *
 * Everything with a side effect sits behind `import.meta.main` (AGENTS.md §Traps).
 */
import { installStubs, patchReactForAPageRender } from '../../../../playground/__tests__/fixtures/render-every-entry'

export const LABEL_ENTRY_PROBE_MARKER = '@@LABEL-ENTRY-PROBE@@'

export interface LabelEntryProbeReading {
  badge: {
    /** `customer::acme`, `bug`, `customer::globex`: the chip at entry 2 set to `initech`. */
    editOwnEntry: string[][]
    /** The same chip removed. */
    removeOwnEntry: string[][]
    /** The same edit with no `entryIndex` (upstream's documented fallback: every entry of the id). */
    editWithoutIndex: string[][]
    /** A plain chip (no `entryIndex`, as `sessionLabelChips` gives it) removed from `bug::bug`, `code`, `bug`. */
    removePlain: string[][]
  }
  row: {
    /** Each chip the session row drew: its label id and the `entryIndex` it passed (null when absent). */
    chips: Array<{ id: string; rawValue: string | null; entryIndex: number | null }>
    /** The row's second `customer` chip edited to `initech`, as `ctx.onLabelsChange` received it. */
    editSecond: Array<{ sessionId: string; labels: string[] }>
  }
  menu: {
    /** `#` menu label ids for a session holding legacy `bug::bug` and `priority::3`. */
    legacyPlainAndValued: string[]
    /** The same tree with nothing applied. */
    nothingApplied: string[]
  }
  chip: {
    /** Enter on an uncontrolled chip (no `open` prop). */
    enterUncontrolled: ChipKeyReading
    /** Enter on a controlled, closed chip: the parent decides. */
    enterControlledClosed: ChipKeyReading
    /** Space on a controlled, open chip. */
    spaceControlledOpen: ChipKeyReading
    /** Any other key ("a") on an uncontrolled chip. */
    otherKey: ChipKeyReading
    /** What the popover receives with `popoverSide="bottom"` and `sessionId="session-9"`, and with neither. */
    popoverPinned: { side: string | null; sessionId: string | null }
    popoverDefaults: { side: string | null; sessionId: string | null }
    /** The chip's class list and inline style: a coloured label (dark `#F87171`) and an uncoloured one. */
    lookColored: ChipLook
    lookUncolored: ChipLook
  }
  composer: {
    /** `priority` picked from `#` while `priority::3` is applied. */
    valuedAlreadyApplied: string[][]
    /** `bug` picked while the session holds legacy `bug::bug`. */
    plainLegacyApplied: string[][]
    /** `bug` picked on a session without it (control: the composer still appends). */
    plainFresh: string[][]
    /**
     * UB14.33 — what each pick left in `pendingLabelValueEditAtom` (`requestedAt` dropped), the atom cleared before
     * each: the three picks above (desktop), then `priority` picked in a COMPACT composer on a session without it.
     */
    pending: {
      valuedAlreadyApplied: PendingEditReading | null
      plainLegacyApplied: PendingEditReading | null
      plainFresh: PendingEditReading | null
      valuedCompact: PendingEditReading | null
      /** What the compact pick wrote to the labels (control: the compact composer still appends). */
      valuedCompactWrites: string[][]
    }
  }
}

export interface PendingEditReading {
  sessionId: string
  panelId: string | null
  labelId: string
  /** `requestedAt` was a number (the header drops a request older than its TTL). */
  stamped: boolean
}

export interface ChipKeyReading {
  /** Whether the chip carries an `onKeyDown` at all. */
  handled: boolean
  /** Every value the chip passed to `onOpenChange`. */
  onOpenChange: boolean[]
  prevented: number
  stopped: number
  /** The popover element's `open` after the key (and any re-render it caused). */
  popoverOpen: boolean | null
}

export interface ChipLook {
  className: string
  background: string | null
  color: string | null
}

type ReactModule = typeof import('react')
type AnyElement = import('react').ReactElement<Record<string, unknown>> & { type: unknown }

/** Depth-first search of an element tree for every element satisfying `match`. */
function findElements(node: unknown, match: (element: AnyElement) => boolean, out: AnyElement[] = []): AnyElement[] {
  if (Array.isArray(node)) {
    for (const child of node) findElements(child, match, out)
    return out
  }
  if (!node || typeof node !== 'object' || !('props' in node)) return out
  const element = node as AnyElement
  if (match(element)) out.push(element)
  findElements(element.props.children, match, out)
  return out
}

export async function probeLabelEntries(): Promise<LabelEntryProbeReading> {
  const react: ReactModule = patchReactForAPageRender()
  installStubs(react)
  const h = react.createElement
  // The composer's callbacks reach `window.electronAPI` only from effects and handlers this probe never runs;
  // the fixture bridge is installed anyway so an accidental call fails loudly instead of on `undefined`.
  await import('../../../../playground/mock-utils')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { setupI18n } = await import('@nessy-agent/shared/i18n')
  const { initReactI18next } = await import('react-i18next')
  const { EntityListLabelBadge } = await import('../../entity-list-label-badge')
  const { useInlineLabelMenu } = await import('../../label-menu')
  const { SessionBadges } = await import('../../../app-shell/SessionBadges')
  const { SessionListProvider } = await import('@/context/SessionListContext')
  const { ChatInputZone } = await import('../../../app-shell/input/ChatInputZone')
  const { getDefaultStore } = await import('jotai')
  const { pendingLabelValueEditAtom } = await import('@/atoms/label-value-edit')

  const i18n = setupI18n([initReactI18next])
  await i18n.changeLanguage('en')

  const labels = [
    { id: 'bug', name: 'Bug' },
    { id: 'code', name: 'Code' },
    { id: 'priority', name: 'Priority', valueType: 'number' as const },
    { id: 'customer', name: 'Customer', valueType: 'string' as const },
  ]
  const [bug, , , customer] = labels

  /** Calls the badge inside a probe render and runs one of its popover's handlers once. */
  const driveBadge = (
    props: Record<string, unknown>,
    run: (popover: Record<string, unknown>) => void,
  ): string[][] => {
    const writes: string[][] = []
    function BadgeProbe() {
      const tree = EntityListLabelBadge({ ...props, onLabelsChange: (next: string[]) => writes.push(next) } as never) as unknown as AnyElement
      run(tree.props)
      return null
    }
    renderToStaticMarkup(h(BadgeProbe))
    return writes
  }
  const twoCustomers = ['customer::acme', 'bug', 'customer::globex']
  const badge = {
    editOwnEntry: driveBadge(
      { label: customer, rawValue: 'globex', sessionLabels: twoCustomers, entryIndex: 2 },
      popover => (popover.onValueChange as (value: string) => void)('initech'),
    ),
    removeOwnEntry: driveBadge(
      { label: customer, rawValue: 'globex', sessionLabels: twoCustomers, entryIndex: 2 },
      popover => (popover.onRemove as () => void)(),
    ),
    editWithoutIndex: driveBadge(
      { label: customer, rawValue: 'globex', sessionLabels: twoCustomers },
      popover => (popover.onValueChange as (value: string) => void)('initech'),
    ),
    removePlain: driveBadge(
      { label: bug, sessionLabels: ['bug::bug', 'code', 'bug'] },
      popover => (popover.onRemove as () => void)(),
    ),
  }

  // --- UB14.35: the chip's keyboard activation, its controlled editor, what it hands the popover, its tint -----
  const chipOf = (tree: AnyElement): AnyElement => {
    const [chip] = findElements(tree.props.children, element => element.props.role === 'button')
    if (!chip) throw new Error('the badge drew no role="button" chip')
    return chip
  }
  const pressKey = (props: Record<string, unknown>, key: string): ChipKeyReading => {
    const reading: ChipKeyReading = { handled: false, onOpenChange: [], prevented: 0, stopped: 0, popoverOpen: null }
    let pressed = false
    function ChipKeyProbe() {
      const tree = EntityListLabelBadge({
        ...props,
        onOpenChange: (next: boolean) => reading.onOpenChange.push(next),
      } as never) as unknown as AnyElement
      reading.popoverOpen = (tree.props.open as boolean | undefined) ?? null
      if (!pressed) {
        pressed = true
        const onKeyDown = chipOf(tree).props.onKeyDown
        reading.handled = typeof onKeyDown === 'function'
        if (reading.handled) {
          ;(onKeyDown as (event: unknown) => void)({
            key,
            preventDefault: () => { reading.prevented += 1 },
            stopPropagation: () => { reading.stopped += 1 },
          })
        }
      }
      return null
    }
    renderToStaticMarkup(h(ChipKeyProbe))
    return reading
  }
  const popoverProps = (props: Record<string, unknown>) => {
    let read = { side: null as string | null, sessionId: null as string | null }
    function PopoverPropsProbe() {
      const tree = EntityListLabelBadge(props as never) as unknown as AnyElement
      read = { side: (tree.props.side as string | undefined) ?? null, sessionId: (tree.props.sessionId as string | undefined) ?? null }
      return null
    }
    renderToStaticMarkup(h(PopoverPropsProbe))
    return read
  }
  const chipLook = (props: Record<string, unknown>): ChipLook => {
    let look: ChipLook = { className: '', background: null, color: null }
    function ChipLookProbe() {
      const chip = chipOf(EntityListLabelBadge(props as never) as unknown as AnyElement)
      const style = chip.props.style as { backgroundColor?: string; color?: string } | undefined
      look = { className: String(chip.props.className ?? ''), background: style?.backgroundColor ?? null, color: style?.color ?? null }
      return null
    }
    renderToStaticMarkup(h(ChipLookProbe))
    return look
  }
  const red = { id: 'bug', name: 'Bug', color: { light: '#EF4444', dark: '#F87171' } }
  const chipBase = { label: bug, sessionLabels: ['bug'] }
  const chip = {
    enterUncontrolled: pressKey(chipBase, 'Enter'),
    enterControlledClosed: pressKey({ ...chipBase, open: false }, 'Enter'),
    spaceControlledOpen: pressKey({ ...chipBase, open: true }, ' '),
    otherKey: pressKey(chipBase, 'a'),
    popoverPinned: popoverProps({ ...chipBase, popoverSide: 'bottom', sessionId: 'session-9' }),
    popoverDefaults: popoverProps(chipBase),
    lookColored: chipLook({ label: red, sessionLabels: ['bug'] }),
    lookUncolored: chipLook(chipBase),
  }

  // --- the session row: SessionBadges → its chips → the second valued chip's own edit ------------------------
  const item = { id: 'session-1', workspaceId: 'workspace-1', name: 'Labels', lastMessageAt: 0, labels: ['customer::acme', 'bug::bug', 'customer::globex', 'bug', 'priority::3'] }
  const rowWrites: Array<{ sessionId: string; labels: string[] }> = []
  const listContext = {
    onRenameClick: () => {}, onSessionStatusChange: () => {}, onMarkUnread: () => {}, onDelete: async () => true,
    onSelectSessionById: () => {}, onOpenInNewWindow: () => {}, onFocusZone: () => {}, onKeyDown: () => {},
    onLabelsChange: (sessionId: string, next: string[]) => rowWrites.push({ sessionId, labels: next }),
    sessionStatuses: [], flatLabels: labels, labels, isMultiSelectActive: false, contentSearchResults: new Map(),
  }
  let rowChips: LabelEntryProbeReading['row']['chips'] = []
  function RowProbe() {
    const tree = SessionBadges({ item: item as never }) as unknown as AnyElement | null
    const chips = findElements(tree, element => element.type === EntityListLabelBadge)
    rowChips = chips.map(chip => ({
      id: (chip.props.label as { id: string }).id,
      rawValue: (chip.props.rawValue as string | undefined) ?? null,
      entryIndex: (chip.props.entryIndex as number | undefined) ?? null,
    }))
    const second = chips.filter(chip => (chip.props.label as { id: string }).id === 'customer')[1]
    if (!second) throw new Error('the row drew fewer than two customer chips')
    const popover = (EntityListLabelBadge(second.props as never) as unknown as AnyElement).props
    ;(popover.onValueChange as (value: string) => void)('initech')
    return null
  }
  renderToStaticMarkup(h(SessionListProvider, { value: listContext as never }, h(RowProbe)))

  // --- the # menu ----------------------------------------------------------------------------------------------
  const menuItems = (sessionLabels: string[]) => {
    let ids: string[] = []
    function MenuProbe() {
      ids = useInlineLabelMenu({ inputRef: { current: null }, labels, sessionLabels, onSelect: () => {} }).items.map(i => i.id)
      return null
    }
    renderToStaticMarkup(h(MenuProbe))
    return ids
  }
  const menu = {
    legacyPlainAndValued: menuItems(['bug::bug', 'priority::3']),
    nothingApplied: menuItems([]),
  }

  // --- the composer ----------------------------------------------------------------------------------------------
  const store = getDefaultStore()
  const pendingAfter: Array<PendingEditReading | null> = []
  const pick = (sessionLabels: string[], labelId: string, compactMode = false): string[][] => {
    const writes: string[][] = []
    let picked = false
    store.set(pendingLabelValueEditAtom, null)
    function ComposerProbe() {
      const tree = ChatInputZone({
        compactMode,
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        sessionLabels,
        labels,
        onLabelsChange: (next: string[]) => writes.push(next),
        inputProps: {} as never,
      }) as unknown as AnyElement
      if (!picked) {
        picked = true
        const [carrier] = findElements(tree, element => typeof element.props.onLabelAdd === 'function')
        if (!carrier) throw new Error('no element carries ChatInputZone\'s onLabelAdd')
        ;(carrier.props.onLabelAdd as (id: string) => void)(labelId)
      }
      return null
    }
    renderToStaticMarkup(h(ComposerProbe))
    const pending = store.get(pendingLabelValueEditAtom)
    pendingAfter.push(pending && {
      sessionId: pending.sessionId,
      panelId: pending.panelId ?? null,
      labelId: pending.labelId,
      stamped: typeof pending.requestedAt === 'number',
    })
    return writes
  }
  const valuedAlreadyApplied = pick(['priority::3'], 'priority')
  const plainLegacyApplied = pick(['bug::bug'], 'bug')
  const plainFresh = pick(['priority::3'], 'bug')
  const valuedCompactWrites = pick(['bug'], 'priority', true)
  const [pendingValued, pendingLegacy, pendingFresh, pendingCompact] = pendingAfter
  const composer = {
    valuedAlreadyApplied,
    plainLegacyApplied,
    plainFresh,
    pending: {
      valuedAlreadyApplied: pendingValued ?? null,
      plainLegacyApplied: pendingLegacy ?? null,
      plainFresh: pendingFresh ?? null,
      valuedCompact: pendingCompact ?? null,
      valuedCompactWrites,
    },
  }

  return { badge, chip, row: { chips: rowChips, editSecond: rowWrites }, menu, composer }
}

if (import.meta.main) {
  const started = performance.now()
  const reading = await probeLabelEntries()
  process.stderr.write(`[label-entry-probe] read in ${Math.round(performance.now() - started)} ms\n`)
  // Exit once stdout has drained: the imported graph leaves timers behind (render-every-entry.ts measured it).
  process.stdout.write(`\n${LABEL_ENTRY_PROBE_MARKER}${JSON.stringify(reading)}\n`, () => process.exit(0))
}
