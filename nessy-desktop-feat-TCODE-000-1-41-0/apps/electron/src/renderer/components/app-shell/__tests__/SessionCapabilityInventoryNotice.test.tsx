/**
 * P6.411 — the session-scoped capability inventory renders what did NOT load
 * with its reason, and renders nothing when nothing was withheld.
 *
 * Two arms and a boundary: the positive case (a withheld list, every reason
 * word reachable), the positive CONTROL (an empty withheld list renders the
 * empty string — a card that appeared for a session with nothing to report
 * would be noise on every chat), and the derivation boundary (a capability the
 * session withheld must not also be listed as active — the two halves come from
 * different sources and this is the only place they can contradict).
 *
 * Mutation probe: dropping the `withheld.length === 0` guard turns the control
 * red; dropping the withheld-key subtraction turns the boundary red.
 */

import * as React from 'react'
import { afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import type { RuntimeWithheldCapability } from '../../../../shared/types'
import {
  activeCapabilityNames,
  inventoryReadPhase,
  SessionCapabilityInventoryNotice,
  SessionCapabilityInventoryView,
  withheldReasonKey,
  type CapabilityNameRow,
  type SessionCapabilityInventoryNoticeProps,
} from '../SessionCapabilityInventoryNotice'

const translations = {
  'sessionCapabilities.activeList': 'Active in this chat: {{names}}',
  'sessionCapabilities.activeNone': 'Nothing else is active in this chat.',
  'sessionCapabilities.dismiss': 'Dismiss',
  'sessionCapabilities.reasonBlocked': 'blocked',
  'sessionCapabilities.reasonDisabled': 'turned off',
  'sessionCapabilities.reasonReviewRequired': 'waiting for a trust review',
  'sessionCapabilities.reasonUnsupportedRuntime': 'not supported by this runtime',
  // C3.245 — the collapsed default. Handed to W15-c for the real locale files;
  // the shape here is the shape announced in rezone.
  'sessionCapabilities.summaryHide': '{{active}} active · {{withheld}} did not load — hide list',
  'sessionCapabilities.summaryShow': '{{active}} active · {{withheld}} did not load — show list',
  'sessionCapabilities.title': 'Not everything loaded in this chat',
  'sessionCapabilities.withheldHeading': 'Did not load:',
  'sessionCapabilities.withheldRow': '{{name}} — {{reason}}',
}

let testI18n: I18nInstance

beforeAll(async () => {
  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: translations } },
    interpolation: { escapeValue: false },
  })
})

function entry(
  key: string,
  logicalName: string,
  reason: RuntimeWithheldCapability['reason'],
): RuntimeWithheldCapability {
  return { key, kind: 'mcp', logicalName, reason }
}

function summary(key: string, logicalName: string): CapabilityNameRow {
  return { key, logicalName }
}

/**
 * C3.245 — the card's own default is COLLAPSED, so every assertion about the
 * lists renders with the roster open. `defaultExpanded` exists for exactly
 * this: there is no DOM harness here, so the open state is unreachable by a
 * click and has to be a prop.
 */
function render(
  withheld: readonly RuntimeWithheldCapability[],
  capabilities?: readonly CapabilityNameRow[],
): string {
  return renderCard(withheld, capabilities, true)
}

/** The shipped default: nothing expanded until the user asks. */
function renderCollapsed(
  withheld: readonly RuntimeWithheldCapability[],
  capabilities?: readonly CapabilityNameRow[],
): string {
  return renderCard(withheld, capabilities, false)
}

function renderCard(
  withheld: readonly RuntimeWithheldCapability[],
  capabilities: readonly CapabilityNameRow[] | undefined,
  defaultExpanded: boolean,
): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={testI18n}>
      <SessionCapabilityInventoryView
        withheld={withheld}
        {...(capabilities ? { capabilities } : {})}
        defaultExpanded={defaultExpanded}
        onDismiss={() => {}}
      />
    </I18nextProvider>,
  )
}

describe('SessionCapabilityInventoryView (P6.411)', () => {
  it('names every withheld capability and the reason it did not load', () => {
    const html = render([
      entry('cap:a', 'linear', 'disabled'),
      entry('cap:b', 'figma', 'review-required'),
      entry('cap:c', 'shell', 'blocked'),
      entry('cap:d', 'browser', 'unsupported-runtime'),
    ])

    expect(html).toContain('Not everything loaded in this chat')
    expect(html).toContain('linear — turned off')
    expect(html).toContain('figma — waiting for a trust review')
    expect(html).toContain('shell — blocked')
    expect(html).toContain('browser — not supported by this runtime')
  })

  it('renders NOTHING when the session withheld nothing — the positive control', () => {
    // A session with a full catalog and an empty withheld record is the normal
    // case; a card there would be on every chat, saying nothing.
    expect(render([], [summary('cap:a', 'linear')])).toBe('')
  })

  it('never lists a withheld capability as active', () => {
    const html = render(
      [entry('cap:b', 'figma', 'disabled')],
      [summary('cap:a', 'linear'), summary('cap:b', 'figma')],
    )

    expect(html).toContain('Active in this chat: linear')
    const activeLine = html.slice(
      html.indexOf('session-capability-active'),
      html.indexOf('Did not load:'),
    )
    expect(activeLine).not.toContain('figma')
  })

  it('says so honestly when the withheld set is everything the catalog had', () => {
    const html = render([entry('cap:a', 'linear', 'blocked')], [summary('cap:a', 'linear')])
    expect(html).toContain('Nothing else is active in this chat.')
  })
})

describe('the collapsed default (C3.245)', () => {
  // The owner's 1.36.0 screenshot: a real workspace put every active capability
  // in one comma-joined sentence and every withheld one on a row of its own,
  // and the card grew over the conversation and the composer. The counts are
  // what is always worth reading; the names are what you go looking for.
  const withheld = [
    entry('cap:b', 'figma', 'disabled'),
    entry('cap:c', 'shell', 'blocked'),
  ]
  const catalog = [
    summary('cap:a', 'linear'),
    summary('cap:b', 'figma'),
    summary('cap:c', 'shell'),
  ]

  it('is one summary line, and neither list is rendered', () => {
    const html = renderCollapsed(withheld, catalog)

    expect(html).toContain('1 active · 2 did not load — show list')
    expect(html).not.toContain('Active in this chat')
    expect(html).not.toContain('Did not load:')
    expect(html).not.toContain('figma — turned off')
  })

  it('counts the two halves from the same derivation the lists use', () => {
    // The boundary: the summary must not invent its own arithmetic. `linear` is
    // the only catalogue row not withheld, so "1 active" and "2 did not load"
    // is the same subtraction `activeCapabilityNames` performs.
    expect(renderCollapsed(withheld, catalog)).toContain('1 active · 2 did not load')
    expect(activeCapabilityNames(catalog, withheld)).toEqual(['linear'])
  })

  it('offers the lists as an expandable control, not as prose', () => {
    const html = renderCollapsed(withheld, catalog)
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('data-testid="session-capability-summary"')
  })

  it('says so in the summary when it is open', () => {
    expect(render(withheld, catalog)).toContain('1 active · 2 did not load — hide list')
    expect(render(withheld, catalog)).toContain('aria-expanded="true"')
  })
})

describe('the two derivations (P6.411)', () => {
  it('maps each of the four reason values to its own key — no fall-through', () => {
    const keys = (['disabled', 'review-required', 'blocked', 'unsupported-runtime'] as const)
      .map(withheldReasonKey)
    expect(new Set(keys).size).toBe(4)
    expect(keys.every(key => key in translations)).toBe(true)
  })

  it('subtracts the withheld keys from the catalog, and tolerates an absent catalog', () => {
    expect(activeCapabilityNames(
      [summary('cap:a', 'linear'), summary('cap:b', 'figma')],
      [entry('cap:b', 'figma', 'disabled')],
    )).toEqual(['linear'])
    expect(activeCapabilityNames(undefined, [entry('cap:b', 'figma', 'disabled')])).toEqual([])
  })
})

// F1.1258 (origin SIT2-a D-11) — a brand-new chat resolves its capabilities at its FIRST send, after the mount's read
// answered `[]`, and nothing re-read it, so "Not everything loaded" appeared only once the chat was re-opened. The
// wrapper's read now also re-runs when the session's turn ends: `inventoryReadPhase` is one of the effect's keys.
describe('the re-read at a turn\'s end (F1.1258)', () => {
  it('a turn starting and ending changes the read key, so the read runs again when the first turn ends', () => {
    expect(inventoryReadPhase(true)).not.toBe(inventoryReadPhase(false))
  })

  it('boundary: no turn (undefined, false) is one phase — a chat that never runs reads once', () => {
    expect(inventoryReadPhase(undefined)).toBe(inventoryReadPhase(false))
  })

  it('ChatDisplay hands the notice the session\'s processing state', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(new URL('../ChatDisplay.tsx', import.meta.url), 'utf8')
    const mount = source.slice(source.indexOf('<SessionCapabilityInventoryNotice'))
    expect(mount.slice(0, mount.indexOf('/>'))).toContain('isProcessing={session.isProcessing}')
  })
})

/**
 * F1.1258 follow-up — the KEYING guard. The three arms in the block above pin
 * `inventoryReadPhase`'s values and ChatDisplay's wiring, but none of them can
 * fail when the read effect drops the phase from its OWN dependency array: the
 * effect body never names `readPhase`, so an "unnecessary dependency" cleanup
 * reverting `[sessionId, readPhase]` to `[sessionId]` re-introduces the row's
 * exact bug (the first turn's end never re-reads, the card waits for a
 * re-open) with every test above green. These two arms mount the wrapper and
 * count the reads.
 *
 * The harness is the family one (PendingAuthNotice.test.tsx) with `setProps`
 * added, because the invariant lives in a PROP change; `renderToStaticMarkup`
 * never runs effects, so the render-based helpers above cannot see a re-read.
 * It supports only the hooks the wrapper uses (useState, useEffect); the View
 * is returned as an element and never rendered here, so useTranslation does not
 * run.
 */
describe('the read re-runs when the turn phase changes (F1.1258 keying)', () => {
  const WITHHELD: RuntimeWithheldCapability[] = [entry('cap:b', 'figma', 'disabled')]

  // This block writes a `window` global; leaving it behind would hand the next
  // file in a repository-wide run a half-stubbed preload.
  const priorWindow = (globalThis as unknown as { window?: unknown }).window
  afterEach(() => {
    ;(globalThis as unknown as { window?: unknown }).window = priorWindow
  })

  /**
   * Stub the preload seam the wrapper touches, with the READ counted.
   * `unsubscribe` really drops the listener, as `ipcRenderer.removeListener`
   * does — otherwise the effect's cleanup could not be told from a leak.
   */
  function installPreloadStub() {
    let listener: (() => void) | null = null
    let unsubscribed = 0
    let reads = 0
    const win = globalThis as unknown as { window?: unknown }
    win.window = {
      electronAPI: {
        getSessionCapabilityInventory(_sessionId: string): Promise<RuntimeWithheldCapability[]> {
          reads += 1
          return Promise.resolve([...WITHHELD])
        },
        capabilities: {
          onChanged(callback: () => void) {
            listener = callback
            return () => { unsubscribed += 1; listener = null }
          },
        },
      },
    }
    return {
      emitChanged: () => { listener?.() },
      readCount: () => reads,
      unsubscribeCount: () => unsubscribed,
    }
  }

  type HookSlot = { value?: unknown; deps?: unknown[]; cleanup?: (() => void) | void }

  const reactDispatcherRef = (
    React as unknown as {
      __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: { ReactCurrentDispatcher: { current: unknown } }
    }
  ).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher

  function mountNotice(initial: SessionCapabilityInventoryNoticeProps) {
    const props = { ...initial }
    const slots: HookSlot[] = []
    const pendingEffects: Array<{ slot: HookSlot; create: () => (() => void) | void }> = []
    let cursor = 0
    let renderQueued = false
    let unmounted = false

    const takeSlot = (): HookSlot => {
      const slot = slots[cursor] ?? (slots[cursor] = {})
      cursor += 1
      return slot
    }
    const depsChanged = (slot: HookSlot, deps: unknown[] | undefined): boolean =>
      !slot.deps || !deps || deps.length !== slot.deps.length
        || deps.some((dep, index) => !Object.is(dep, slot.deps?.[index]))

    const dispatcher = {
      useState(initial: unknown) {
        const slot = takeSlot()
        if (!('value' in slot)) slot.value = initial
        const setState = (next: unknown) => {
          const previous = slot.value
          const value = typeof next === 'function' ? (next as (prev: unknown) => unknown)(previous) : next
          if (Object.is(value, previous)) return
          slot.value = value
          if (!unmounted) renderQueued = true
        }
        return [slot.value, setState]
      },
      useEffect(create: () => (() => void) | void, deps?: unknown[]) {
        const slot = takeSlot()
        if (!depsChanged(slot, deps)) return
        slot.deps = deps ? [...deps] : undefined
        pendingEffects.push({ slot, create })
      },
    }

    const renderPass = () => {
      const previous = reactDispatcherRef.current
      reactDispatcherRef.current = dispatcher
      cursor = 0
      try {
        SessionCapabilityInventoryNotice(props)
      } finally {
        reactDispatcherRef.current = previous
      }
      while (pendingEffects.length > 0) {
        const effect = pendingEffects.shift()
        if (!effect) break
        if (typeof effect.slot.cleanup === 'function') effect.slot.cleanup()
        effect.slot.cleanup = effect.create()
      }
    }

    const renderLoop = () => {
      for (let pass = 0; pass < 25; pass += 1) {
        renderQueued = false
        renderPass()
        if (!renderQueued) return
      }
      throw new Error('mountNotice: render loop did not settle')
    }

    renderLoop()

    return {
      /** Change props (the turn phase flips) and re-render, re-running the effects whose keys moved. */
      setProps(next: Partial<SessionCapabilityInventoryNoticeProps>) {
        Object.assign(props, next)
        renderLoop()
      },
      /** Let the wrapper's read promises resolve, then re-render if state moved. */
      flush: async (): Promise<void> => {
        for (let tick = 0; tick < 8; tick += 1) {
          await new Promise<void>(resolve => { setTimeout(resolve, 0) })
          if (renderQueued && !unmounted) renderLoop()
        }
      },
      unmount: () => {
        unmounted = true
        for (const slot of slots) {
          if (typeof slot.cleanup === 'function') slot.cleanup()
          slot.cleanup = undefined
        }
      },
    }
  }

  it('a turn starting re-runs the read (2 reads, not 1)', async () => {
    const stub = installPreloadStub()
    const mounted = mountNotice({ sessionId: 'session-1', isProcessing: false })

    await mounted.flush()
    expect(stub.readCount()).toBe(1)

    mounted.setProps({ isProcessing: true })
    await mounted.flush()
    // The mutation probe: the read key dropped back to `[sessionId]` fails here
    // at 1 — the read that would find the first turn's answer never runs.
    expect(stub.readCount()).toBe(2)

    mounted.unmount()
  })

  // Boundary. Its probe is the WRONG fix: keying the raw `isProcessing` prop
  // instead of the phase re-runs on the false → undefined flip too, which is
  // the chat that never runs a turn reading more than once.
  it('boundary: undefined after false is no phase change — an idle chat never re-reads', async () => {
    const stub = installPreloadStub()
    const mounted = mountNotice({ sessionId: 'session-1', isProcessing: false })

    await mounted.flush()
    expect(stub.readCount()).toBe(1)

    mounted.setProps({ isProcessing: undefined })
    await mounted.flush()
    expect(stub.readCount()).toBe(1)

    mounted.unmount()
  })
})
