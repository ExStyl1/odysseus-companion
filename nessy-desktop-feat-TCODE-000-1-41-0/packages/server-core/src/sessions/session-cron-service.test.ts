import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSessionCronStore, type SessionCronStore } from '@nessy-agent/shared/sessions'
import {
  SESSION_CRON_FALLBACK_WAKEUP_MS,
  SESSION_CRON_TICK_MS,
  SESSION_CRON_WAKEUP_MAX_MS,
  SESSION_CRON_WAKEUP_MIN_MS,
  SessionCronService,
  type SessionCronFire,
} from './session-cron-service.ts'

const roots: string[] = []

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

interface Harness {
  service: SessionCronService
  store: SessionCronStore
  delivered: string[][]
  deliveredFires: SessionCronFire[][]
  setNow(value: number): void
  setIdle(value: boolean): void
  setDefaultPrompt(value: string): void
  /**
   * A SECOND service over the same store, clock and delivery sink — what the
   * runtime on the other side of a switch (or the next launch) builds. The only
   * thing it does not inherit is the first service's in-memory state, which is
   * the whole point.
   */
  rebuild(): SessionCronService
}

function harness(startAt = new Date(2026, 2, 15, 9, 0, 0).getTime()): Harness {
  const root = mkdtempSync(join(tmpdir(), 'nessy-cron-service-'))
  roots.push(root)
  const store = openSessionCronStore(root, 'session-a')
  let now = startAt
  let idle = true
  let defaultPrompt = 'default prompt v1'
  const delivered: string[][] = []
  // P6.376 — the same groups, unflattened. `delivered` stays the prompt text
  // so every row written before the widening reads exactly as it did; this one
  // is what the dispatch rows assert on.
  const deliveredFires: SessionCronFire[][] = []
  const build = () => new SessionCronService({
    store,
    isIdle: () => idle,
    deliver: fires => {
      delivered.push(fires.map(fire => fire.prompt))
      deliveredFires.push([...fires])
    },
    resolveDefaultPrompt: () => defaultPrompt,
    now: () => now,
    // Never actually schedule a real interval in a test.
    tickIntervalMs: 3_600_000,
  })
  return {
    service: build(),
    store,
    delivered,
    deliveredFires,
    setNow: value => { now = value },
    setIdle: value => { idle = value },
    setDefaultPrompt: value => { defaultPrompt = value },
    rebuild: build,
  }
}


/**
 * P6.295 arm (2) — the store had two states, armed and gone. These are the
 * three the row's `done_means` asks for: paused-without-deletion, resumed,
 * run-now, plus the unread-run marker `CronList` renders.
 *
 * The pair worth reading twice is pause-does-not-expire and
 * resume-does-not-catch-up. Both are decisions, both are stated on the record's
 * own fields, and both fail loudly here if a later change takes the other
 * branch: an expiring pause deletes what a user asked to keep, and a
 * catching-up resume fires once per missed occurrence, which is the precise
 * behaviour `scheduled-tasks.md:215` forbids.
 */
describe('SessionCronService · pause, resume, run-now, unread runs (P6.295)', () => {
  test('a paused task keeps its record and fires nothing', () => {
    const h = harness()
    const record = h.service.create({ schedule: '*/5 * * * *', recurring: true, prompt: 'check the build' })
    expect(h.service.pause(record.id)?.paused).toBe(true)

    h.setNow(new Date(2026, 2, 15, 9, 10, 0).getTime())
    h.service.tick()
    expect(h.delivered).toEqual([])
    // The record is still there — that is the entire difference from CronDelete.
    expect(h.service.list().map(t => t.id)).toEqual([record.id])
    expect(h.service.list()[0]!.prompt).toBe('check the build')
    h.service.stop()
  })

  test('a paused task is not SWEPT AWAY either — no fire means no self-deletion', () => {
    // The decision on `SessionCronRecord.paused`. A one-shot is the sharp case:
    // its fire is FINAL, and a final fire deletes the record at delivery
    // (`:187`). Pausing has to stop both halves, or "pause" quietly becomes a
    // slower delete — which is the one outcome a user who chose pause over
    // CronDelete was avoiding.
    const h = harness()
    const record = h.service.create({ schedule: '30 23 15 3 *', recurring: false, prompt: 'the one-shot' })
    h.service.pause(record.id)
    h.setNow(new Date(2026, 2, 15, 23, 31, 0).getTime())
    h.service.tick()
    expect(h.delivered).toEqual([])
    expect(h.service.list().map(t => t.id)).toEqual([record.id])
    h.service.stop()
  })

  test('the same one-shot DOES fire and delete itself when it is not paused — the control', () => {
    // Without this, the case above passes on a scheduler that fires nothing at
    // all, which would make the pause look like it worked for the wrong reason.
    const h = harness()
    const record = h.service.create({ schedule: '30 23 15 3 *', recurring: false, prompt: 'the one-shot' })
    h.setNow(new Date(2026, 2, 15, 23, 31, 0).getTime())
    h.service.tick()
    expect(h.delivered).toEqual([['the one-shot']])
    expect(h.service.list().map(t => t.id)).not.toContain(record.id)
    h.service.stop()
  })

  test('resume fires again, and does NOT catch up on what it missed', () => {
    const h = harness()
    const record = h.service.create({ schedule: '*/5 * * * *', recurring: true, prompt: 'check the build' })
    h.service.pause(record.id)
    // Two hours of missed occurrences.
    h.setNow(new Date(2026, 2, 15, 11, 0, 0).getTime())
    h.service.tick()
    expect(h.delivered).toEqual([])

    expect(h.service.resume(record.id)?.paused).toBeUndefined()
    h.setNow(new Date(2026, 2, 15, 11, 5, 0).getTime())
    h.service.tick()
    // ONE delivery, not one per missed five-minute slot.
    expect(h.delivered).toEqual([['check the build']])
    h.service.stop()
  })

  test('pause drops a fire already enqueued behind a busy turn', () => {
    const h = harness()
    const record = h.service.create({ schedule: '*/5 * * * *', recurring: true, prompt: 'check the build' })
    h.setIdle(false)
    h.setNow(new Date(2026, 2, 15, 9, 10, 0).getTime())
    h.service.tick()
    expect(h.service.pendingIds()).toEqual([record.id])

    h.service.pause(record.id)
    h.setIdle(true)
    h.service.tick()
    expect(h.delivered).toEqual([])
    h.service.stop()
  })

  test('run-now delivers immediately, and does not delete a one-shot', () => {
    const h = harness()
    const at = new Date(2026, 2, 15, 23, 30, 0)
    const record = h.service.create({
      schedule: `${at.getMinutes()} ${at.getHours()} ${at.getDate()} ${at.getMonth() + 1} *`,
      recurring: false,
      prompt: 'the one-shot',
    })
    expect(h.service.runNow(record.id)?.id).toBe(record.id)
    expect(h.delivered).toEqual([['the one-shot']])
    // The user asked to see it now, not to cancel it.
    expect(h.service.list().map(t => t.id)).toEqual([record.id])
    h.service.stop()
  })

  test('run-now on a PAUSED task still runs — that is the point of pausing rather than deleting', () => {
    const h = harness()
    const record = h.service.create({ schedule: '*/5 * * * *', recurring: true, prompt: 'manual' })
    h.service.pause(record.id)
    h.service.runNow(record.id)
    expect(h.delivered).toEqual([['manual']])
    h.service.stop()
  })

  test('run-now during a turn WAITS for the turn to end (`:172`)', () => {
    const h = harness()
    const record = h.service.create({ schedule: '*/5 * * * *', recurring: true, prompt: 'manual' })
    h.setIdle(false)
    h.service.runNow(record.id)
    expect(h.delivered).toEqual([])
    h.setIdle(true)
    h.service.tick()
    expect(h.delivered).toEqual([['manual']])
    h.service.stop()
  })

  test('run-now and pause answer undefined for an unknown id', () => {
    const h = harness()
    expect(h.service.runNow('no-such-task')).toBeUndefined()
    expect(h.service.pause('no-such-task')).toBeUndefined()
    expect(h.service.resume('no-such-task')).toBeUndefined()
    expect(h.service.acknowledgeRuns('no-such-task')).toBe(false)
    h.service.stop()
  })

  test('unread runs count deliveries and clear on acknowledge', () => {
    const h = harness()
    const record = h.service.create({ schedule: '*/5 * * * *', recurring: true, prompt: 'check the build' })
    expect(h.service.list()[0]!.unreadRuns).toBeUndefined()

    h.setNow(new Date(2026, 2, 15, 9, 10, 0).getTime())
    h.service.tick()
    // 9:20 and not 9:15, and not 9:16 either. Two reasons, and the second is the
    // one this line was wrong about until 2026-09-19 (WI-bs):
    //
    // 1. The tick at the exact occurrence instant does not fire —
    //    `nextCronFireTime` answers the occurrence strictly after the cursor.
    // 2. A RECURRING record's fire time carries `cronJitterOffsetMs`, which for
    //    a `*/5` schedule is `fraction(record.id) * floor(300000 / 2)` — 0 to
    //    150 s past the slot, derived from the record's RANDOM id. So the second
    //    occurrence lands anywhere in 9:15:00-9:17:30, and a tick at 9:16 fired
    //    only for the ids whose fraction is under 0.4. This case was a coin flip
    //    on a random id: red alone at HEAD and on CI job 630520568, green on a
    //    lucky id. The first tick was never at risk (9:05 + at most 150 s is
    //    always before 9:10), which is why only this one flaked.
    //
    // 9:20 is past the whole jitter window for any id, so the case now measures
    // the delivery count it is named for rather than the id it drew.
    h.setNow(new Date(2026, 2, 15, 9, 20, 0).getTime())
    h.service.tick()
    // Two deliveries; `lastFiredAt` alone could not tell these apart from one.
    expect(h.delivered).toHaveLength(2)
    expect(h.service.list()[0]!.unreadRuns).toBe(2)

    expect(h.service.acknowledgeRuns(record.id)).toBe(true)
    expect(h.service.list()[0]!.unreadRuns).toBeUndefined()
    h.service.stop()
  })

  test('the paused state and the unread count survive a runtime switch', () => {
    // The whole reason these live in the STORE and not in the service's memory:
    // a rebuilt service is what the other side of a runtime switch gets.
    const h = harness()
    const record = h.service.create({ schedule: '*/5 * * * *', recurring: true, prompt: 'check the build' })
    h.setNow(new Date(2026, 2, 15, 9, 10, 0).getTime())
    h.service.tick()
    h.service.pause(record.id)
    h.service.stop()

    const next = h.rebuild()
    expect(next.list()[0]!.paused).toBe(true)
    expect(next.list()[0]!.unreadRuns).toBe(1)
    h.setNow(new Date(2026, 2, 15, 9, 20, 0).getTime())
    next.tick()
    expect(h.delivered).toHaveLength(1)
    next.stop()
  })
})

describe('SessionCronService', () => {
  test('checks once a second (`:172`)', () => {
    expect(SESSION_CRON_TICK_MS).toBe(1_000)
  })

  test('delivers a due prompt when the session is idle', () => {
    const h = harness()
    h.service.create({ schedule: '*/5 * * * *', recurring: true, prompt: 'check the build' })
    h.service.tick()
    expect(h.delivered).toEqual([])

    h.setNow(new Date(2026, 2, 15, 9, 10, 0).getTime())
    h.service.tick()
    expect(h.delivered).toEqual([['check the build']])
    h.service.stop()
  })

  test('a task due during a busy turn fires exactly ONCE on idle, not once per missed interval (`:215`)', () => {
    const h = harness()
    h.service.create({ schedule: '*/5 * * * *', recurring: true, prompt: 'poll the deploy' })

    // The turn starts, and runs for forty minutes — eight five-minute
    // occurrences pass while the session is busy.
    h.setIdle(false)
    const start = new Date(2026, 2, 15, 9, 1, 0).getTime()
    for (let at = start; at <= start + 40 * 60_000; at += 30_000) {
      h.setNow(at)
      h.service.tick()
    }
    expect(h.delivered).toEqual([])
    expect(h.service.pendingIds()).toHaveLength(1)

    // The turn ends.
    h.setIdle(true)
    h.service.tick()
    expect(h.delivered).toEqual([['poll the deploy']])

    // And it does not immediately re-fire for the occurrences it missed.
    h.service.tick()
    expect(h.delivered).toHaveLength(1)
    h.service.stop()
  })

  test('two tasks due in the same busy turn arrive as ONE group, in order', () => {
    const h = harness()
    h.service.create({ schedule: '*/5 * * * *', recurring: true, prompt: 'first' })
    h.service.create({ schedule: '*/5 * * * *', recurring: true, prompt: 'second' })
    h.setIdle(false)
    h.setNow(new Date(2026, 2, 15, 9, 45, 0).getTime())
    h.service.tick()
    h.setIdle(true)
    h.service.tick()
    expect(h.delivered).toHaveLength(1)
    expect(h.delivered[0]!.sort()).toEqual(['first', 'second'])
    h.service.stop()
  })

  test('a recurring task fires one final time at seven days and then is gone (`:187`)', () => {
    const createdAt = new Date(2026, 2, 15, 9, 0, 0).getTime()
    const h = harness(createdAt)
    const record = h.service.create({ schedule: '0 9 * * *', recurring: true, prompt: 'daily sweep' })

    // Walk day by day. The fire at or after day seven is the last one.
    let fires = 0
    let goneOnDay = 0
    for (let day = 1; day <= 9; day += 1) {
      h.setNow(createdAt + day * 24 * 60 * 60_000 + 60 * 60_000)
      h.service.tick()
      fires = h.delivered.length
      if (h.store.list().length === 0) { goneOnDay = day; break }
    }

    // `fires > 0` was the whole check here, and it cannot see the seven days
    // this test's name states: a three-day cut-off produced three fires, an
    // empty store and a green run. The day is the contract, so pin the day.
    expect(goneOnDay).toBe(7)
    expect(fires).toBe(7)
    expect(h.delivered.at(-1)).toEqual(['daily sweep'])
    // Gone from the store — it deleted itself after the final fire.
    expect(h.store.list()).toEqual([])
    expect(h.store.list().some(task => task.id === record.id)).toBe(false)

    // And no further ticks produce anything.
    const before = h.delivered.length
    h.setNow(createdAt + 12 * 24 * 60 * 60_000)
    h.service.tick()
    expect(h.delivered).toHaveLength(before)
    h.service.stop()
  })

  test('a one-shot deletes itself after running', () => {
    const createdAt = new Date(2026, 2, 15, 8, 0, 0).getTime()
    const h = harness(createdAt)
    h.service.create({ schedule: '17 9 * * *', recurring: false, prompt: 'push the release branch' })
    h.setNow(new Date(2026, 2, 15, 9, 17, 0).getTime())
    h.service.tick()
    expect(h.delivered).toEqual([['push the release branch']])
    expect(h.store.list()).toEqual([])
    h.service.stop()
  })

  test('cancelling drops a fire that was already waiting', () => {
    const h = harness()
    const record = h.service.create({ schedule: '*/5 * * * *', recurring: true, prompt: 'cancel me' })
    h.setIdle(false)
    h.setNow(new Date(2026, 2, 15, 9, 30, 0).getTime())
    h.service.tick()
    expect(h.service.pendingIds()).toEqual([record.id])

    expect(h.service.remove(record.id)?.id).toBe(record.id)
    h.setIdle(true)
    h.service.tick()
    expect(h.delivered).toEqual([])
    h.service.stop()
  })

  test('restore drops expired records and keeps live ones (`:216`)', () => {
    const createdAt = new Date(2026, 2, 15, 9, 0, 0).getTime()
    const h = harness(createdAt)
    const live = h.service.create({ schedule: '0 9 * * *', recurring: true, prompt: 'live' })
    h.service.create({ schedule: '0 9 * * *', recurring: true, prompt: 'stale' })

    // Age the second record past seven days by rewriting the list directly.
    h.store.replace(
      h.store.list().map(task =>
        task.prompt === 'stale' ? { ...task, createdAt: createdAt - 8 * 24 * 60 * 60_000 } : task,
      ),
    )

    const result = h.service.restore()
    expect(result.kept.map(task => task.prompt)).toEqual(['live'])
    expect(result.dropped.map(task => task.prompt)).toEqual(['stale'])
    expect(h.store.list().map(task => task.id)).toEqual([live.id])
    h.service.stop()
  })

  test('clear removes everything, timer and file included (`:216`)', () => {
    const h = harness()
    h.service.create({ schedule: '*/5 * * * *', recurring: true, prompt: 'a' })
    h.service.clear()
    expect(h.store.list()).toEqual([])
    expect(h.service.pendingIds()).toEqual([])
  })
})

describe('the self-paced loop (R39, `scheduled-tasks.md:62`-`:74`, `:130`)', () => {
  const t0 = new Date(2026, 2, 15, 9, 0, 0).getTime()

  test('creation arms the FIRST iteration to run as soon as the turn ends', () => {
    const h = harness(t0)
    // The /loop turn is running while the model calls CronCreate.
    h.setIdle(false)
    const record = h.service.startSelfPaced({ prompt: 'check whether CI passed' })
    expect(record.dynamic).toBe(true)
    expect(record.schedule).toBe('dynamic')
    expect(record.nextFireAt).toBe(t0)

    // Still busy: nothing delivered.
    h.setNow(t0 + 1_000)
    h.service.tick()
    expect(h.delivered).toEqual([])

    // The turn ends → the first iteration is delivered immediately-ish.
    h.setIdle(true)
    h.setNow(t0 + 2_000)
    h.service.tick()
    expect(h.delivered).toEqual([['check whether CI passed']])
    h.service.stop()
  })

  test('rearm clamps to the documented one-minute-to-one-hour window', () => {
    const h = harness(t0)
    const record = h.service.startSelfPaced({ prompt: 'p' })
    expect(h.service.rearm(record.id, 5_000).firesAt).toBe(t0 + SESSION_CRON_WAKEUP_MIN_MS)
    expect(h.service.rearm(record.id, 24 * 60 * 60_000).firesAt).toBe(t0 + SESSION_CRON_WAKEUP_MAX_MS)
    expect(h.service.rearm(record.id, 300_000).firesAt).toBe(t0 + 300_000)
    expect(h.store.list()[0]!.nextFireAt).toBe(t0 + 300_000)
    h.service.stop()
  })

  test('a rescheduled iteration fires at the model-chosen delay, jitter-free', () => {
    const h = harness(t0)
    const record = h.service.startSelfPaced({ prompt: 'poll the deploy' })
    h.service.tick() // first iteration delivered at t0
    expect(h.delivered).toHaveLength(1)

    // End of iteration 1: the model reschedules 5 minutes out.
    h.service.rearm(record.id, 300_000)

    // One second before the wakeup nothing fires — no jitter is applied.
    h.setNow(t0 + 300_000 - 1_000)
    h.service.tick()
    expect(h.delivered).toHaveLength(1)

    h.setNow(t0 + 300_000)
    h.service.tick()
    expect(h.delivered).toHaveLength(2)
    h.service.stop()
  })

  test('stop cancels the pending wakeup immediately (`:130`)', () => {
    const h = harness(t0)
    const record = h.service.startSelfPaced({ prompt: 'p' })
    h.service.tick()
    h.service.rearm(record.id, 300_000)

    expect(h.service.stopWakeup(record.id)).toBe(true)
    expect(h.store.list()).toEqual([])

    // No later tick delivers anything.
    h.setNow(t0 + 3_600_000)
    h.service.tick()
    expect(h.delivered).toHaveLength(1)
    // A second stop finds nothing.
    expect(h.service.stopWakeup(record.id)).toBe(false)
    h.service.stop()
  })

  test('the `:130` fallback two-step: no rearm → ONE ~20-minute wakeup → still no rearm → loop over', () => {
    const h = harness(t0)
    h.service.startSelfPaced({ prompt: 'p' })
    h.service.tick() // iteration 1 delivered at t0
    expect(h.delivered).toHaveLength(1)

    // The iteration never called ScheduleWakeup. One fallback wakeup is armed
    // ~20 minutes out — and none earlier.
    expect(h.store.list()[0]!.nextFireAt).toBe(t0 + SESSION_CRON_FALLBACK_WAKEUP_MS)
    h.setNow(t0 + SESSION_CRON_FALLBACK_WAKEUP_MS - 60_000)
    h.service.tick()
    expect(h.delivered).toHaveLength(1)

    // The fallback fires: the LAST-chance iteration is delivered.
    h.setNow(t0 + SESSION_CRON_FALLBACK_WAKEUP_MS)
    h.service.tick()
    expect(h.delivered).toHaveLength(2)

    // Its turn runs (busy), then ends without a reschedule → the record is
    // deleted: the loop ended.
    h.setIdle(false)
    h.setNow(t0 + SESSION_CRON_FALLBACK_WAKEUP_MS + 30_000)
    h.service.tick()
    expect(h.store.list()).toHaveLength(1) // still protected while running
    h.setIdle(true)
    h.setNow(t0 + SESSION_CRON_FALLBACK_WAKEUP_MS + 60_000)
    h.service.tick()
    expect(h.store.list()).toEqual([])

    // And nothing ever fires again.
    h.setNow(t0 + 3 * SESSION_CRON_FALLBACK_WAKEUP_MS)
    h.service.tick()
    expect(h.delivered).toHaveLength(2)
    h.service.stop()
  })

  test('a reschedule DURING the fallback iteration continues the loop', () => {
    const h = harness(t0)
    const record = h.service.startSelfPaced({ prompt: 'p' })
    h.service.tick() // iteration 1
    h.setNow(t0 + SESSION_CRON_FALLBACK_WAKEUP_MS)
    h.service.tick() // fallback iteration delivered
    expect(h.delivered).toHaveLength(2)

    // The fallback iteration's turn runs and DOES reschedule this time.
    h.setIdle(false)
    h.setNow(t0 + SESSION_CRON_FALLBACK_WAKEUP_MS + 10_000)
    h.service.tick()
    h.service.rearm(record.id, 120_000)
    h.setIdle(true)
    h.service.tick()

    // The record survived, marker cleared, and the loop keeps going.
    expect(h.store.list()).toHaveLength(1)
    expect(h.store.list()[0]!.fallbackArmed).toBeUndefined()
    h.setNow(t0 + SESSION_CRON_FALLBACK_WAKEUP_MS + 10_000 + 120_000)
    h.service.tick()
    expect(h.delivered).toHaveLength(3)
    h.service.stop()
  })

  test('a `promptSource: loop-md` record delivers the EDITED default prompt on the second fire (`:120`)', () => {
    const h = harness(t0)
    const record = h.service.startSelfPaced({ prompt: 'stored resolution', promptSource: 'loop-md' })
    h.service.tick()
    expect(h.delivered).toEqual([['default prompt v1']])

    // The user edits loop.md while the loop is running.
    h.setDefaultPrompt('default prompt v2 (edited)')
    h.service.rearm(record.id, 60_000)
    h.setNow(t0 + 60_000)
    h.service.tick()
    expect(h.delivered).toEqual([['default prompt v1'], ['default prompt v2 (edited)']])

    // The STORED prompt was never rewritten — CronList still shows something.
    expect(h.store.list()[0]!.prompt).toBe('stored resolution')
    h.service.stop()
  })

  test('a fixed-interval record with `promptSource: loop-md` substitutes at delivery too', () => {
    const h = harness(t0)
    h.service.create({ schedule: '*/5 * * * *', recurring: true, prompt: 'stored', promptSource: 'loop-md' })
    h.setNow(t0 + 10 * 60_000)
    h.service.tick()
    expect(h.delivered).toEqual([['default prompt v1']])
    h.service.stop()
  })

  test('a stale fallback that came due mid-iteration is dropped by the rearm, not delivered after it', () => {
    const h = harness(t0)
    const record = h.service.startSelfPaced({ prompt: 'p' })
    h.service.tick() // iteration 1 delivered; fallback armed at t0+20min

    // The iteration runs LONGER than the fallback delay: the fallback comes
    // due mid-turn and is enqueued, waiting for idle.
    h.setIdle(false)
    h.setNow(t0 + SESSION_CRON_FALLBACK_WAKEUP_MS + 1_000)
    h.service.tick()
    expect(h.service.pendingIds()).toEqual([record.id])

    // The iteration ends with a proper reschedule — the stale fire must die.
    h.service.rearm(record.id, 600_000)
    h.setIdle(true)
    h.service.tick()
    expect(h.delivered).toHaveLength(1)

    // Only the rescheduled wakeup delivers.
    h.setNow(t0 + SESSION_CRON_FALLBACK_WAKEUP_MS + 1_000 + 600_000)
    h.service.tick()
    expect(h.delivered).toHaveLength(2)
    h.service.stop()
  })

  test('a dynamic loop expires at seven days like any recurring task (`:74`)', () => {
    const h = harness(t0)
    const record = h.service.startSelfPaced({ prompt: 'p' })
    h.service.tick() // iteration 1
    // Simulate a long-lived loop: the model keeps rescheduling for 7 days.
    let at = t0
    let guard = 0
    while (h.store.list().length > 0 && guard < 200) {
      h.service.rearm(record.id, SESSION_CRON_WAKEUP_MAX_MS)
      at += SESSION_CRON_WAKEUP_MAX_MS
      h.setNow(at)
      h.service.tick()
      guard += 1
    }
    // The loop ended by expiry (final fire delivered, record gone), not by the
    // guard.
    expect(guard).toBeLessThan(200)
    expect(h.store.list()).toEqual([])
    expect(at - t0).toBeGreaterThanOrEqual(7 * 24 * 60 * 60_000)
    h.service.stop()
  })
})

/**
 * T8 (e). The gap between "this fire is owed" and "the model saw it" is
 * unbounded — `:172` holds a fire that comes due mid-turn until the turn ends —
 * and the queue that held it was in memory only. A runtime switch or a quit
 * inside that gap destroyed the queue and found nothing on disk, because the
 * record had already deleted itself at enqueue.
 */
describe('a final fire enqueued during a busy turn survives the teardown', () => {
  test('a one-shot that came due while busy is delivered by the service rebuilt after a switch', () => {
    const createdAt = new Date(2026, 2, 15, 8, 0, 0).getTime()
    const h = harness(createdAt)
    const record = h.service.create({
      schedule: '17 9 * * *', recurring: false, prompt: 'push the release branch',
    })

    // The turn is running when the one-shot comes due: enqueued, not delivered.
    h.setIdle(false)
    h.setNow(new Date(2026, 2, 15, 9, 17, 0).getTime())
    h.service.tick()
    expect(h.delivered).toEqual([])
    expect(h.service.pendingIds()).toEqual([record.id])
    // The record is still ON DISK, marked as owing a delivery — this is the line
    // that used to read `expect(h.store.list()).toEqual([])`.
    expect(h.store.list().map(task => task.id)).toEqual([record.id])
    expect(h.store.list()[0]!.owedFire).toBe(true)

    // The switch: the service is torn down with the prompt still in memory.
    h.service.stop()

    // The runtime on the other side rebuilds a service over the same store.
    const rebuilt = h.rebuild()
    expect(rebuilt.restore().kept.map(task => task.id)).toEqual([record.id])
    h.setIdle(true)
    h.setNow(new Date(2026, 2, 15, 9, 40, 0).getTime())
    rebuilt.tick()
    expect(h.delivered).toEqual([['push the release branch']])
    // Delivered exactly once, and the record is gone now that it has been.
    expect(h.store.list()).toEqual([])
    rebuilt.tick()
    expect(h.delivered).toHaveLength(1)
    rebuilt.stop()
  })

  test('cancelling an owed fire still cancels it — the marker is not a second life', () => {
    const createdAt = new Date(2026, 2, 15, 8, 0, 0).getTime()
    const h = harness(createdAt)
    const record = h.service.create({ schedule: '17 9 * * *', recurring: false, prompt: 'cancel me' })
    h.setIdle(false)
    h.setNow(new Date(2026, 2, 15, 9, 17, 0).getTime())
    h.service.tick()
    expect(h.store.list()[0]!.owedFire).toBe(true)

    expect(h.service.remove(record.id)?.id).toBe(record.id)
    expect(h.store.list()).toEqual([])

    h.setIdle(true)
    h.service.tick()
    expect(h.delivered).toEqual([])
    h.service.stop()
  })
})

/**
 * P6.376 — a cron record carries a model ID and an effort LEVEL, and the fire
 * it delivers carries them with it.
 *
 * The row's `done_means` asks for all THREE combinations plus the resting one,
 * and for a mutation dropping the field from the dispatch to go RED. The
 * mutation guard is the last row: it asserts on the FIRE the service hands the
 * host, not on the stored record, so deleting the two spread lines in `flush`
 * (which is the dispatch) fails it while the store still reads correctly.
 */
describe('P6.376 · the dispatch a scheduled run uses', () => {
  const due = () => new Date(2026, 2, 15, 9, 17, 0).getTime()

  test('a record with a model and an effort delivers both', () => {
    const h = harness()
    h.service.create({
      schedule: '17 9 * * *', recurring: false, prompt: 'nightly sweep',
      model: 'claude-haiku-4-5', effort: 'low',
    })
    h.setNow(due())
    h.service.tick()
    expect(h.deliveredFires).toEqual([[{ prompt: 'nightly sweep', model: 'claude-haiku-4-5', effort: 'low' }]])
    h.service.stop()
  })

  test('a model alone travels alone, and an effort alone travels alone', () => {
    const modelOnly = harness()
    modelOnly.service.create({ schedule: '17 9 * * *', recurring: false, prompt: 'm', model: 'claude-haiku-4-5' })
    modelOnly.setNow(due())
    modelOnly.service.tick()
    expect(modelOnly.deliveredFires).toEqual([[{ prompt: 'm', model: 'claude-haiku-4-5' }]])
    modelOnly.service.stop()

    const effortOnly = harness()
    effortOnly.service.create({ schedule: '17 9 * * *', recurring: false, prompt: 'e', effort: 'off' })
    effortOnly.setNow(due())
    effortOnly.service.tick()
    // `off` is a real choice — it is the cheapest one — so it must survive the
    // falsy-looking spread rather than being dropped as "unset".
    expect(effortOnly.deliveredFires).toEqual([[{ prompt: 'e', effort: 'off' }]])
    effortOnly.service.stop()
  })

  // The resting case: a record with neither is byte-identical to one written
  // before the fields existed, and its fire carries nothing extra.
  test('a record with neither carries neither, in the store and in the fire', () => {
    const h = harness()
    h.service.create({ schedule: '17 9 * * *', recurring: false, prompt: 'as before' })
    expect(Object.keys(h.store.list()[0]!)).not.toContain('model')
    expect(Object.keys(h.store.list()[0]!)).not.toContain('effort')
    h.setNow(due())
    h.service.tick()
    expect(h.deliveredFires).toEqual([[{ prompt: 'as before' }]])
    h.service.stop()
  })

  // MUTATION GUARD — the row asks for this explicitly. One group, two records:
  // dropping the per-record read from `flush` would deliver the same two
  // prompts with no dispatch at all, so `delivered` (the prompt text) stays
  // green and only this row goes red.
  test('one group mixes records that name a dispatch with records that do not', () => {
    const h = harness()
    h.service.create({ schedule: '17 9 * * *', recurring: false, prompt: 'cheap', model: 'claude-haiku-4-5', effort: 'off' })
    h.service.create({ schedule: '17 9 * * *', recurring: false, prompt: 'ordinary' })
    h.setNow(due())
    h.service.tick()
    expect(h.delivered).toEqual([['cheap', 'ordinary']])
    expect(h.deliveredFires).toEqual([[
      { prompt: 'cheap', model: 'claude-haiku-4-5', effort: 'off' },
      { prompt: 'ordinary' },
    ]])
    h.service.stop()
  })

  // NEGATIVE — a stored value outside the level union is dropped by the store's
  // own validator rather than reaching a setter that would refuse it mid-run.
  // `sonnet` is the shape this guards against: a TIER, which cannot travel to
  // claude at all.
  test('a tier stored where a level belongs is dropped on load, not dispatched', () => {
    const h = harness()
    const record = h.service.create({ schedule: '17 9 * * *', recurring: false, prompt: 'tiered' })
    h.store.replace([{ ...record, effort: 'sonnet' } as unknown as typeof record])
    // The whole record fails validation, which is the store's documented
    // posture for a present-but-mistyped optional: dropped, not half-loaded.
    expect(h.store.list()).toEqual([])
    h.service.stop()
  })
})
