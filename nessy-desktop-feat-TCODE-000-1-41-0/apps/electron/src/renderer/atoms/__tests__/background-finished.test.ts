/**
 * UA1.15 — the background-session-finished chip's state: the preference (default
 * OFF), the App-level detector, the queue and the entry the chip announces.
 *
 * Owner 2026-09-23 (OQ-20 item 3): "Да, выключен по умолчанию". Upstream
 * v0.13.4 `atoms/background-finished.ts` + the `App.tsx` detector. No DOM in
 * `bun test` here, so the chip's selection rule is driven through the module the
 * chip delegates to; `BackgroundFinishedChip.test.tsx` renders the chip itself
 * and pins the click path and the mounts.
 */
import { describe, expect, it } from 'bun:test'
import { createStore } from 'jotai'
import {
  backgroundFinishedAtom,
  dismissBackgroundFinishedAtom,
  queueBackgroundFinished,
  selectBackgroundFinishedEntry,
  showBackgroundFinishedChipAtom,
} from '../background-finished'
import { focusedPanelIdAtom, panelStackAtom, visibleSessionIdsAtom } from '../panel-stack'
import { routes } from '../../../shared/routes'

const FOREGROUND = 'session-on-screen'
const BACKGROUND = 'session-in-background'

function makeStore(opts: { enabled?: boolean } = {}) {
  const store = createStore()
  store.set(panelStackAtom, [
    { id: 'panel-1', route: routes.view.allSessions(FOREGROUND), proportion: 1, panelType: 'session', laneId: 'main' },
  ])
  store.set(focusedPanelIdAtom, 'panel-1')
  if (opts.enabled !== undefined) store.set(showBackgroundFinishedChipAtom, opts.enabled)
  return store
}

const finished = { id: BACKGROUND, name: 'Refactor the importer' }

function announced(store: ReturnType<typeof createStore>) {
  return selectBackgroundFinishedEntry({
    enabled: store.get(showBackgroundFinishedChipAtom),
    queue: store.get(backgroundFinishedAtom),
    focusedSessionId: FOREGROUND,
    sessionId: FOREGROUND,
  })
}

describe('UA1.15 — the preference', () => {
  it('is OFF by default (a fresh store, nothing stored)', () => {
    expect(createStore().get(showBackgroundFinishedChipAtom)).toBe(false)
  })
})

describe('UA1.15 — the detector and the chip it feeds', () => {
  it('POSITIVE — preference on: a BACKGROUND session finishing queues ONE entry, titled, and the focused row announces it', () => {
    const store = makeStore({ enabled: true })
    expect(store.get(visibleSessionIdsAtom).has(FOREGROUND)).toBe(true)
    expect(queueBackgroundFinished(store, BACKGROUND, finished, 1000)).toBe(true)
    expect(store.get(backgroundFinishedAtom)).toEqual([{ sessionId: BACKGROUND, title: 'Refactor the importer', finishedAt: 1000 }])
    expect(announced(store)?.sessionId).toBe(BACKGROUND)
    // Re-finishing replaces the entry: still ONE chip for that session.
    queueBackgroundFinished(store, BACKGROUND, finished, 2000)
    expect(store.get(backgroundFinishedAtom)).toHaveLength(1)
    expect(store.get(backgroundFinishedAtom)[0]?.finishedAt).toBe(2000)
  })

  it('NEGATIVE — preference off (the default): nothing is queued and nothing is announced', () => {
    const store = makeStore()
    expect(queueBackgroundFinished(store, BACKGROUND, finished)).toBe(false)
    expect(store.get(backgroundFinishedAtom)).toEqual([])
    expect(announced(store)).toBeUndefined()
  })

  it('NEGATIVE — the FOREGROUND session finishing (shown in a panel) is never queued', () => {
    const store = makeStore({ enabled: true })
    expect(queueBackgroundFinished(store, FOREGROUND, { id: FOREGROUND, name: 'On screen' })).toBe(false)
    expect(store.get(backgroundFinishedAtom)).toEqual([])
  })

  it('NEGATIVE — a dismissed chip does not return for the same completion; only a NEW completion brings it back', () => {
    const store = makeStore({ enabled: true })
    queueBackgroundFinished(store, BACKGROUND, finished, 1000)
    store.set(dismissBackgroundFinishedAtom, BACKGROUND)
    expect(announced(store)).toBeUndefined()
    // Re-reading (a re-render) does not resurrect it.
    expect(announced(store)).toBeUndefined()
    expect(store.get(backgroundFinishedAtom)).toEqual([])
    // Control: the next completion of that session is a new signal.
    queueBackgroundFinished(store, BACKGROUND, finished, 3000)
    expect(announced(store)?.finishedAt).toBe(3000)
  })

  it('the chip is announced only in the FOCUSED row and never for the row\'s own session', () => {
    const queue = [{ sessionId: BACKGROUND, title: 't', finishedAt: 1 }]
    expect(selectBackgroundFinishedEntry({ enabled: true, queue, focusedSessionId: 'other', sessionId: FOREGROUND })).toBeUndefined()
    expect(selectBackgroundFinishedEntry({ enabled: true, queue, focusedSessionId: BACKGROUND, sessionId: BACKGROUND })).toBeUndefined()
    expect(selectBackgroundFinishedEntry({ enabled: true, queue, focusedSessionId: FOREGROUND, sessionId: FOREGROUND })?.sessionId).toBe(BACKGROUND)
  })
})
