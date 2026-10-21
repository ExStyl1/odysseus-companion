/**
 * L11 — "the composer keeps a prompt it already sent, after a Stop".
 *
 * The row filed the observation with a candidate mechanism: a debounced draft
 * write landing AFTER submit's clear, restoring an already-sent prompt. That
 * mechanism is refuted in the code — submit cancels its pending write, and the
 * restore is produced deliberately by `ChatDisplay.handleStop(silent=false)`.
 * The test below pins that refutation (submit's cancel really happens) and
 * covers the ordering hole the same reading DID uncover: the PARENT-DRIVEN
 * re-seed path — which is how the Stop restore, a session switch and a
 * deep-link prefill all arrive — did not cancel the pending write, so a stale
 * composer → parent write landed after it and left the visible composer and the
 * persisted draft disagreeing permanently.
 *
 * `bun test` has no DOM (no happy-dom/jsdom/testing-library in this repo, and
 * the renderer's component tests are `renderToStaticMarkup`-only, which runs no
 * effects), so the ordering is driven through the module `FreeFormInput`
 * delegates to rather than through a rendered component.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'
import {
  createDraftParentSync,
  DRAFT_PARENT_SYNC_DEBOUNCE_MS,
  seedComposerFromParent,
  type DraftParentSync,
} from '../draft-parent-sync'

/** Manual clock: the debounce is the whole subject, so it must not be real. */
function makeHarness(initialValue = '') {
  const writes: string[] = []
  const notify = (value: string) => {
    writes.push(value)
  }
  // Recorded, never compared against the module's own constant: an assertion of
  // the form `expect(ms).toBe(DRAFT_PARENT_SYNC_DEBOUNCE_MS)` is a tautology —
  // it holds for any window, so moving the constant to 5 s left every test here
  // green. The window is pinned against a LITERAL below instead.
  const scheduledDelays: number[] = []
  let nextHandle = 1
  const timers = new Map<number, () => void>()
  const sync: DraftParentSync = createDraftParentSync(initialValue, {
    schedule: (fn, ms) => {
      scheduledDelays.push(ms)
      const handle = nextHandle++
      timers.set(handle, fn)
      return handle as unknown as ReturnType<typeof setTimeout>
    },
    cancel: (handle) => {
      timers.delete(handle as unknown as number)
    },
  })
  const runPendingTimers = () => {
    const due = [...timers.entries()]
    timers.clear()
    for (const [, fn] of due) fn()
  }
  return {
    sync,
    notify,
    writes,
    scheduledDelays,
    runPendingTimers,
    liveTimerCount: () => timers.size,
  }
}

describe('createDraftParentSync — composer → parent debounce', () => {
  it('schedules the write 300 ms out — the literal window, not the module’s own constant', () => {
    const { sync, notify, scheduledDelays } = makeHarness()

    sync.syncToParent('h', notify)
    sync.syncToParent('ha', notify)

    expect(scheduledDelays).toEqual([300, 300])
    expect(DRAFT_PARENT_SYNC_DEBOUNCE_MS).toBe(300)
  })

  it('coalesces keystrokes into one write and reports the parent value it delivered', () => {
    const { sync, notify, writes, runPendingTimers } = makeHarness()

    sync.syncToParent('h', notify)
    sync.syncToParent('ha', notify)
    sync.syncToParent('half', notify)
    expect(writes).toEqual([])
    expect(sync.pendingValue).toBe('half')

    runPendingTimers()
    expect(writes).toEqual(['half'])
    expect(sync.lastSyncedValue).toBe('half')
    expect(sync.pendingValue).toBeNull()
  })

  it('writes nothing at all when the parent accepts no draft writes', () => {
    const { sync, writes, runPendingTimers, liveTimerCount } = makeHarness()

    sync.syncToParent('half', undefined)
    expect(liveTimerCount()).toBe(0)
    runPendingTimers()
    expect(writes).toEqual([])
    expect(sync.lastSyncedValue).toBe('')
  })
})

describe('createDraftParentSync — a parent-driven re-seed wins over a pending write (L11)', () => {
  it('cancels the pending write, so the seeded value cannot be overwritten by pre-seed text', () => {
    // The live L11 sequence: the user is typing while a turn runs, presses Stop,
    // and `ChatDisplay.handleStop` pushes the restored prompt into the draft
    // 100 ms into the composer's 300 ms debounce window.
    const { sync, notify, writes, runPendingTimers } = makeHarness()

    sync.syncToParent('half typed', notify)
    expect(sync.acceptParentValue('the prompt that was already sent')).toBe(true)

    runPendingTimers()

    // Without the cancel, 'half typed' lands here: the parent draft (and the
    // disk snapshot behind it) says 'half typed' while the composer shows the
    // restored prompt, and the re-seed guard is now anchored to the wrong value.
    expect(writes).toEqual([])
    expect(sync.lastSyncedValue).toBe('the prompt that was already sent')
    expect(sync.pendingValue).toBeNull()
  })

  it('does not re-seed, and does not cancel, when the parent echoes back what was already synced', () => {
    // The ordinary path: the debounce fires, the parent re-renders with the
    // value the composer itself just sent. Re-seeding there would fight the
    // user's typing, and cancelling a later write would drop keystrokes.
    const { sync, notify, writes, runPendingTimers } = makeHarness()

    sync.syncToParent('hello', notify)
    runPendingTimers()
    expect(writes).toEqual(['hello'])

    expect(sync.acceptParentValue('hello')).toBe(false)

    sync.syncToParent('hello there', notify)
    expect(sync.acceptParentValue('hello')).toBe(false)
    expect(sync.pendingValue).toBe('hello there')
    runPendingTimers()
    expect(writes).toEqual(['hello', 'hello there'])
  })
})

describe('seedComposerFromParent — the re-seed CONSEQUENCE, not just the decision (L11)', () => {
  // Why this block exists: the decision (`acceptParentValue`) and the
  // consequence (`setInput`) used to live on opposite sides of the module
  // boundary, and only the decision was tested. Deleting the consequence — one
  // line, which kills EVERY parent-driven re-seed: session switch, deep-link
  // prefill, queued-message insert and the Stop restore — left this whole zone
  // suite green at 145 pass / 0 fail, because the only thing watching it was a
  // source-text match on the `acceptParentValue` call. A source-text assertion
  // is not a behavioural test.
  it('pushes the parent value into the composer and cancels the pending write', () => {
    const { sync, notify, writes, runPendingTimers } = makeHarness()
    const seeded: string[] = []

    sync.syncToParent('half typed', notify)
    const reseeded = seedComposerFromParent(
      sync,
      'the prompt that was already sent',
      (value) => seeded.push(value),
    )

    expect(reseeded).toBe(true)
    expect(seeded).toEqual(['the prompt that was already sent'])

    runPendingTimers()
    expect(writes).toEqual([])
    expect(sync.lastSyncedValue).toBe('the prompt that was already sent')
  })

  it('does not touch the composer when the parent echoes back the value already synced', () => {
    const { sync, notify, runPendingTimers } = makeHarness()
    const seeded: string[] = []

    sync.syncToParent('hello', notify)
    runPendingTimers()

    expect(seedComposerFromParent(sync, 'hello', (value) => seeded.push(value))).toBe(false)
    expect(seeded).toEqual([])
  })

  it('does not touch the composer when the parent wires no draft value at all', () => {
    const { sync } = makeHarness('typed by the user')
    const seeded: string[] = []

    expect(seedComposerFromParent(sync, undefined, (value) => seeded.push(value))).toBe(false)
    expect(seeded).toEqual([])
    expect(sync.lastSyncedValue).toBe('typed by the user')
  })

  it('seeds the coerced text when a stale persisted draft arrives as an object', () => {
    const { sync } = makeHarness()
    const seeded: string[] = []
    // The shape `coerceInputText` exists for: an installed build reading a draft
    // that was persisted as a whole object rather than as its text.
    const malformed = { text: 'restored from a stale draft object' } as unknown as string

    expect(seedComposerFromParent(sync, malformed, (value) => seeded.push(value))).toBe(true)
    expect(seeded).toEqual(['restored from a stale draft object'])
    expect(sync.lastSyncedValue).toBe('restored from a stale draft object')
  })
})

describe('FreeFormInput delegates its draft sync to this module', () => {
  // Without this, the tests above would be a PARALLEL MODEL of the composer
  // rather than a test of it: `bun test` cannot render the component, so the
  // only executable check that the ordering above is the ordering that ships is
  // that the composer owns no second copy of it. The same claim, hand-written in
  // a comment, is exactly what rotted the last time.
  const source = readFileSync(
    fileURLToPath(new URL('../FreeFormInput.tsx', import.meta.url)),
    'utf8',
  )
  // `expect(source).toContain(needle)` prints the whole 3 000-line component on
  // failure. Report the needle instead.
  const present = (needle: string) => ({ needle, inSource: source.includes(needle) })
  const found = (needle: string) => ({ needle, inSource: true })
  const absent = (needle: string) => ({ needle, inSource: false })

  it('calls every entry point of the module and keeps no draft timer of its own', () => {
    for (const needle of [
      'createDraftParentSync(coerceInputText(inputValue))',
      'seedComposerFromParent(draftSync, inputValue, setInput)',
      'draftSync.syncToParent(value, onInputChange)',
      'draftSync.markCleared(onInputChange)',
      'draftSync.flushOnUnmount(inputRef.current, onInputChange)',
    ]) {
      expect(present(needle)).toEqual(found(needle))
    }

    for (const needle of [
      // The parent → composer direction must be delegated WHOLE. The component
      // holding its own `if (accept(v)) setInput(v)` is exactly the split that
      // left the re-seed unpinned.
      'acceptParentValue',
      // The pre-L11 shape: a local debounce timer plus a "last value the parent
      // has" ref, with the cancel wired into submit only.
      'syncTimeoutRef',
      'prevInputValueRef',
    ]) {
      expect(present(needle)).toEqual(absent(needle))
    }
  })
})

describe('createDraftParentSync — clear and unmount', () => {
  it('a submit-clear empties the parent draft and drops the pending write (the row’s own hypothesis, already handled)', () => {
    const { sync, notify, writes, runPendingTimers } = makeHarness()

    sync.syncToParent('the prompt being sent', notify)
    sync.markCleared(notify)

    runPendingTimers()
    expect(writes).toEqual([''])
    expect(sync.lastSyncedValue).toBe('')
  })

  it('flushes an unsynced local value on unmount, and stays quiet when the parent already has it', () => {
    const withPending = makeHarness()
    withPending.sync.syncToParent('typed but never flushed', withPending.notify)
    withPending.sync.flushOnUnmount('typed but never flushed', withPending.notify)
    expect(withPending.writes).toEqual(['typed but never flushed'])
    withPending.runPendingTimers()
    expect(withPending.writes).toEqual(['typed but never flushed'])

    const alreadySynced = makeHarness()
    alreadySynced.sync.syncToParent('settled', alreadySynced.notify)
    alreadySynced.runPendingTimers()
    alreadySynced.sync.flushOnUnmount('settled', alreadySynced.notify)
    expect(alreadySynced.writes).toEqual(['settled'])
  })
})
