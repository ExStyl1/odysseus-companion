import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { SESSION_CRON_EXPIRY_MS, type SessionCronRecord } from './cron-store.ts'
import {
  CRON_ONE_SHOT_EARLY_JITTER_MS,
  CRON_RECURRING_MAX_JITTER_MS,
  cronExpiresAt,
  cronJitterFraction,
  cronJitterOffsetMs,
  nextCronFireTime,
  planCronRestore,
  planCronTick,
} from './cron-scheduler.ts'

/**
 * D1.110 — A FILE BUDGET, WITH THE MEASUREMENT THAT SIZED IT.
 *
 * This file is class (c): one case re-imports this module in a SEPARATE PROCESS
 * (`execFileSync` on a `bun --eval` child) to prove the jitter offset is derived
 * from the id and not from anything the parent happens to hold. That child pays
 * the module graph, and the graph is not this file's subject — which is the whole
 * reason the budget belongs to the FILE and not to the case.
 *
 * Measured 2026-09-17 at load ~9.5, with `--reporter=junit` as the instrument
 * that separates a BODY's cost from the file's (`bun test` alone cannot, and a
 * budget sized from the failure message would have been sized against the timer
 * rather than against the work):
 *
 *  - at bun's 5 000 ms default the subprocess case fails at **5 043 ms** with
 *    zero assertion failures — the registered red, and the shape AGENTS.md says
 *    has two causes needing different fixes;
 *  - re-run with `--timeout 120000` the SAME body costs **11 843 ms**, 2.4x the
 *    default, and every other body in the file is under 2 ms;
 *  - the file then answers **30 pass / 0 fail across 1 file in 30.93 s**.
 *
 * So this is the PROFILE outcome, not the starvation one: the hook is genuinely
 * expensive and the budget is set against the measured floor rather than against
 * zero. 60 000 ms is five times the measured body and about twice the file's own
 * total, the same head `user-settings-strict-report.test.ts` carries for the same
 * spawn on the same box. Re-measure before lowering it; a warm reading is not a
 * floor.
 */
setDefaultTimeout(60_000)

function record(overrides: Partial<SessionCronRecord> & Pick<SessionCronRecord, 'id'>): SessionCronRecord {
  return {
    schedule: '*/5 * * * *',
    recurring: true,
    prompt: 'check the build',
    createdAt: new Date(2026, 2, 15, 9, 0, 0).getTime(),
    ...overrides,
  }
}

describe('deterministic jitter (`:178`, `:180`, `:181`, `:183`)', () => {
  test('the offset is a function of the task id and nothing else', () => {
    const scheduled = new Date(2026, 2, 15, 9, 5, 0)
    const first = cronJitterOffsetMs({ id: 'a1b2c3d4', recurring: true }, scheduled, 5 * 60_000)
    for (let repeat = 0; repeat < 20; repeat += 1) {
      expect(cronJitterOffsetMs({ id: 'a1b2c3d4', recurring: true }, scheduled, 5 * 60_000)).toBe(first)
    }
    // A different id must generally land somewhere else, or "deterministic"
    // would be indistinguishable from "constant".
    const others = ['b1b2c3d4', 'c1b2c3d4', 'd1b2c3d4', 'e1b2c3d4'].map(id =>
      cronJitterOffsetMs({ id, recurring: true }, scheduled, 5 * 60_000),
    )
    expect(new Set([first, ...others]).size).toBeGreaterThan(1)
  })

  test('the SAME id gets the SAME offset in a SEPARATE PROCESS (`:183`)', () => {
    // `:183` says "the same task always gets the same offset" — across a resume,
    // which is a different process. Computing it twice in one process would not
    // catch a derivation seeded from anything ambient, so this really spawns one.
    const ids = ['a1b2c3d4', 'zzzzzzzz', '00000000', 'q7w8e9r0']
    const inProcess = ids.map(id => cronJitterFraction(id))

    const dir = mkdtempSync(join(tmpdir(), 'nessy-cron-jitter-'))
    try {
      const script = join(dir, 'probe.ts')
      const module = resolve(import.meta.dir, 'cron-scheduler.ts')
      writeFileSync(
        script,
        `import { cronJitterFraction } from ${JSON.stringify(module)}\n` +
          `console.log(JSON.stringify(${JSON.stringify(ids)}.map(cronJitterFraction)))\n`,
        'utf8',
      )
      // The child inherits `NODE_ENV=test` but not the root bunfig preload, so
      // it needs the config-dir isolation the guard in `config/paths.ts` demands
      // spelled out. It points at this test's own temp directory, so the real
      // `~/.nessy-agent` is never in reach.
      const output = execFileSync(process.execPath, [script], {
        encoding: 'utf8',
        env: { ...process.env, NESSY_CONFIG_DIR: join(dir, 'config') },
      })
      expect(JSON.parse(output.trim())).toEqual(inProcess)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('recurring: up to +30 minutes when the task runs hourly or less often (`:180`)', () => {
    const scheduled = new Date(2026, 2, 15, 9, 0, 0)
    for (const id of ['a1b2c3d4', 'zzzzzzzz', '00000000', 'q7w8e9r0', 'mmmmmmmm']) {
      const hourly = cronJitterOffsetMs({ id, recurring: true }, scheduled, 60 * 60_000)
      expect(hourly).toBeGreaterThanOrEqual(0)
      expect(hourly).toBeLessThan(CRON_RECURRING_MAX_JITTER_MS)
      // Daily is "less often than hourly" and keeps the same ceiling.
      const daily = cronJitterOffsetMs({ id, recurring: true }, scheduled, 24 * 60 * 60_000)
      expect(daily).toBe(hourly)
    }
  })

  test('recurring: up to half the interval when it runs more often than hourly (`:180`)', () => {
    const scheduled = new Date(2026, 2, 15, 9, 5, 0)
    for (const id of ['a1b2c3d4', 'zzzzzzzz', '00000000', 'q7w8e9r0', 'mmmmmmmm']) {
      const offset = cronJitterOffsetMs({ id, recurring: true }, scheduled, 5 * 60_000)
      expect(offset).toBeGreaterThanOrEqual(0)
      expect(offset).toBeLessThan((5 * 60_000) / 2)
    }
  })

  test('one-shot on the hour or half hour fires up to 90 seconds EARLY (`:181`)', () => {
    for (const minute of [0, 30]) {
      const scheduled = new Date(2026, 2, 15, 9, minute, 0)
      for (const id of ['a1b2c3d4', 'zzzzzzzz', '00000000', 'q7w8e9r0']) {
        const offset = cronJitterOffsetMs({ id, recurring: false }, scheduled, null)
        expect(offset).toBeLessThanOrEqual(0)
        expect(offset).toBeGreaterThan(-CRON_ONE_SHOT_EARLY_JITTER_MS)
      }
    }
  })

  test('one-shot off the hour and half hour gets NO jitter at all (`:183`)', () => {
    for (const minute of [1, 7, 29, 31, 59]) {
      const scheduled = new Date(2026, 2, 15, 9, minute, 0)
      expect(cronJitterOffsetMs({ id: 'a1b2c3d4', recurring: false }, scheduled, null)).toBe(0)
    }
  })

  test('the jitter lands on the fire time, so a one-shot at 09:00 is due before 09:00', () => {
    const oneShot = record({
      id: 'a1b2c3d4',
      recurring: false,
      schedule: '0 9 * * *',
      createdAt: new Date(2026, 2, 15, 8, 0, 0).getTime(),
    })
    const fire = nextCronFireTime(oneShot, new Date(oneShot.createdAt))!
    const scheduled = new Date(2026, 2, 15, 9, 0, 0).getTime()
    expect(fire.getTime()).toBeLessThan(scheduled)
    expect(scheduled - fire.getTime()).toBeLessThan(CRON_ONE_SHOT_EARLY_JITTER_MS)
  })
})

describe('the seven-day expiry fires one final time (`:187`)', () => {
  const createdAt = new Date(2026, 2, 15, 9, 0, 0).getTime()
  const daily = record({ id: 'a1b2c3d4', schedule: '0 9 * * *', createdAt })

  test('at day 7 the task fires, and that fire is marked final', () => {
    // Search from the last fire on day 6 so the next occurrence is day 7's.
    const lastFiredAt = createdAt + 6 * 24 * 60 * 60_000
    const task = { ...daily, lastFiredAt }
    const dueAt = nextCronFireTime(task, new Date(lastFiredAt))!
    expect(dueAt.getTime()).toBeGreaterThanOrEqual(cronExpiresAt(task))

    const plan = planCronTick({ tasks: [task], now: dueAt.getTime() })
    expect(plan.fires).toHaveLength(1)
    expect(plan.fires[0]!.final).toBe(true)
    expect(plan.expired).toEqual([])
  })

  test('a fire BEFORE the expiry is not final — the final one is not an off-by-one', () => {
    const lastFiredAt = createdAt + 24 * 60 * 60_000
    const task = { ...daily, lastFiredAt }
    const dueAt = nextCronFireTime(task, new Date(lastFiredAt))!
    expect(dueAt.getTime()).toBeLessThan(cronExpiresAt(task))
    const plan = planCronTick({ tasks: [task], now: dueAt.getTime() })
    expect(plan.fires[0]!.final).toBe(false)
  })

  test('the resume sweep KEEPS a task owed its final fire, and drops it after', () => {
    // Exactly at the expiry: `:187` still owes one fire, so `:216` must not
    // swallow it.
    const atExpiry = planCronRestore([daily], cronExpiresAt(daily))
    expect(atExpiry.keep).toEqual([daily])

    const pastExpiry = planCronRestore([daily], cronExpiresAt(daily) + 1)
    expect(pastExpiry.keep).toEqual([])
    expect(pastExpiry.drop).toEqual([daily])
  })

  test('seven days is seven days', () => {
    expect(SESSION_CRON_EXPIRY_MS).toBe(7 * 24 * 60 * 60 * 1000)
    expect(cronExpiresAt(daily)).toBe(createdAt + SESSION_CRON_EXPIRY_MS)
  })
})

describe('no catch-up for missed fires (`:215`)', () => {
  const createdAt = new Date(2026, 2, 15, 9, 0, 0).getTime()
  const everyFive = record({ id: 'a1b2c3d4', schedule: '*/5 * * * *', createdAt })

  test('a task due many times during a busy turn is planned ONCE while pending', () => {
    const busyStart = createdAt + 60_000
    const busyEnd = busyStart + 40 * 60_000

    // First tick after it comes due: one fire.
    const first = planCronTick({ tasks: [everyFive], now: busyStart + 10 * 60_000 })
    expect(first.fires).toHaveLength(1)

    // The host is busy, so that fire is still waiting. Every later tick in the
    // same turn — eight more five-minute occurrences — must add nothing.
    const pending = new Set([everyFive.id])
    for (let at = busyStart; at <= busyEnd; at += 60_000) {
      expect(planCronTick({ tasks: [everyFive], now: at, pending }).fires).toEqual([])
    }
  })

  test('once delivered, the cursor moves to the delivery, so missed occurrences are gone', () => {
    // 40 minutes of missed five-minute occurrences, then one delivery.
    const delivered = createdAt + 40 * 60_000
    const afterDelivery = { ...everyFive, lastFiredAt: delivered }

    // The very next tick must NOT re-report the eight occurrences it skipped.
    expect(planCronTick({ tasks: [afterDelivery], now: delivered + 1_000 }).fires).toEqual([])

    // It fires again on the next occurrence, once.
    const next = nextCronFireTime(afterDelivery, new Date(delivered))!
    expect(next.getTime()).toBeGreaterThan(delivered)
    expect(planCronTick({ tasks: [afterDelivery], now: next.getTime() }).fires).toHaveLength(1)
  })

  test('a task not yet due is not reported', () => {
    expect(planCronTick({ tasks: [everyFive], now: createdAt + 1_000 }).fires).toEqual([])
  })

  test('an expression that can never match again is expired without firing', () => {
    const impossible = record({ id: 'b1b2c3d4', schedule: '0 0 30 2 *', createdAt })
    const plan = planCronTick({ tasks: [impossible], now: createdAt + 1_000 })
    expect(plan.fires).toEqual([])
    expect(plan.expired).toEqual(['b1b2c3d4'])
  })

  test('the fire-time memo does not change the plan', () => {
    const cache = new Map<string, number | null>()
    const now = createdAt + 10 * 60_000
    const withCache = planCronTick({ tasks: [everyFive], now, fireTimeCache: cache })
    const withoutCache = planCronTick({ tasks: [everyFive], now })
    expect(withCache.fires.map(fire => fire.dueAt)).toEqual(withoutCache.fires.map(fire => fire.dueAt))
    expect(cache.size).toBe(1)
    // A second call answers from the memo and agrees.
    expect(planCronTick({ tasks: [everyFive], now, fireTimeCache: cache }).fires.map(f => f.dueAt))
      .toEqual(withoutCache.fires.map(fire => fire.dueAt))
  })
})

describe('a dynamic (self-paced) loop record (R39, `:74`)', () => {
  const createdAt = new Date(2026, 2, 15, 9, 0, 0).getTime()
  const dynamic = record({
    id: 'd1b2c3d4',
    schedule: 'dynamic',
    dynamic: true,
    nextFireAt: createdAt + 5 * 60_000,
    createdAt,
  })

  test('the jitter rules do NOT apply to it (`:74`)', () => {
    const scheduled = new Date(2026, 2, 15, 9, 0, 0)
    // Positive control: the same id WITHOUT the marker gets a real offset, so
    // the zero below is the exemption and not a lucky hash.
    expect(cronJitterOffsetMs({ id: 'd1b2c3d4', recurring: true }, scheduled, 60 * 60_000)).toBeGreaterThan(0)
    expect(cronJitterOffsetMs({ id: 'd1b2c3d4', recurring: true, dynamic: true }, scheduled, 60 * 60_000)).toBe(0)
  })

  test('the fire time is `nextFireAt`, never the schedule field', () => {
    const fire = nextCronFireTime(dynamic, new Date(createdAt))
    expect(fire?.getTime()).toBe(createdAt + 5 * 60_000)
  })

  test('no pending wakeup means the loop is over: expired, not fired', () => {
    const { nextFireAt: _next, ...dueless } = dynamic
    expect(nextCronFireTime(dueless, new Date(createdAt))).toBeNull()
    const plan = planCronTick({ tasks: [dueless], now: createdAt + 60_000 })
    expect(plan.fires).toEqual([])
    expect(plan.expired).toEqual(['d1b2c3d4'])
  })

  test('a rearm is visible through the fire-time memo, which must not cache it', () => {
    const cache = new Map<string, number | null>()
    // First tick memoizes nothing binding: the wakeup is not yet due.
    expect(planCronTick({ tasks: [dynamic], now: createdAt + 60_000, fireTimeCache: cache }).fires).toEqual([])
    // The model reschedules EARLIER without the cursor moving.
    const rearmed = { ...dynamic, nextFireAt: createdAt + 2 * 60_000 }
    const plan = planCronTick({ tasks: [rearmed], now: createdAt + 2 * 60_000, fireTimeCache: cache })
    expect(plan.fires).toHaveLength(1)
    expect(plan.fires[0]!.dueAt).toBe(createdAt + 2 * 60_000)
  })

  test('the seven-day bound applies to a dynamic record (`:74`)', () => {
    // Within seven days: restored (planCronRestore has NO dynamic branch — the
    // recurring path answers, which is what `:74` requires).
    expect(planCronRestore([dynamic], createdAt + 24 * 60 * 60_000).keep).toEqual([dynamic])
    // Past seven days: dropped even though a wakeup is still armed.
    const stale = { ...dynamic, nextFireAt: createdAt + 8 * 24 * 60 * 60_000 + 60_000 }
    const past = planCronRestore([stale], createdAt + 8 * 24 * 60 * 60_000)
    expect(past.keep).toEqual([])
    expect(past.drop).toEqual([stale])
    // And the fire at or past the expiry instant is FINAL, so the loop ends.
    const atExpiry = { ...dynamic, nextFireAt: cronExpiresAt(dynamic) + 1 }
    const plan = planCronTick({ tasks: [atExpiry], now: cronExpiresAt(dynamic) + 1 })
    expect(plan.fires).toHaveLength(1)
    expect(plan.fires[0]!.final).toBe(true)
  })

  test('a dynamic record whose iteration died with the process is dropped on resume', () => {
    // Dueless at restore time (the app quit mid-fallback-iteration): the loop
    // is over, not restorable.
    const { nextFireAt: _next, ...dueless } = dynamic
    const swept = planCronRestore([dueless], createdAt + 60_000)
    expect(swept.keep).toEqual([])
    expect(swept.drop).toEqual([dueless])
  })
})

describe('the resume sweep (`:216`)', () => {
  const now = new Date(2026, 2, 15, 12, 0, 0).getTime()

  test('a one-shot whose time has not passed is restored', () => {
    const pending = record({
      id: 'a1b2c3d4',
      recurring: false,
      schedule: '0 18 * * *',
      createdAt: now - 60_000,
    })
    expect(planCronRestore([pending], now).keep).toEqual([pending])
  })

  test('a one-shot whose time has passed is dropped', () => {
    const past = record({
      id: 'b1b2c3d4',
      recurring: false,
      schedule: '0 9 15 3 *',
      createdAt: new Date(2026, 2, 15, 8, 0, 0).getTime(),
    })
    expect(planCronRestore([past], now).drop).toEqual([past])
  })

  test('a recurring task inside seven days is restored', () => {
    const fresh = record({ id: 'c1b2c3d4', createdAt: now - 24 * 60 * 60_000 })
    expect(planCronRestore([fresh], now).keep).toEqual([fresh])
  })
})

describe('an owed final fire outlives the process that enqueued it (T8 (e))', () => {
  const now = new Date(2026, 2, 15, 12, 0, 0).getTime()

  test('a one-shot marked owedFire is restored even though its time has passed', () => {
    // Without the marker this is byte-for-byte the record the row above proves
    // is DROPPED — which is what made a busy-then-switched one-shot vanish.
    const owed = record({
      id: 'd1b2c3d4',
      recurring: false,
      schedule: '0 9 15 3 *',
      createdAt: new Date(2026, 2, 15, 8, 0, 0).getTime(),
      owedFire: true,
    })
    expect(planCronRestore([owed], now).keep).toEqual([owed])
    expect(planCronRestore([owed], now).drop).toEqual([])
  })

  test('an owedFire record is due NOW and final, whatever its schedule says', () => {
    const owed = record({
      id: 'e1b2c3d4',
      recurring: false,
      schedule: '0 9 15 3 *',
      createdAt: new Date(2026, 2, 15, 8, 0, 0).getTime(),
      owedFire: true,
    })
    const plan = planCronTick({ tasks: [owed], now })
    expect(plan.expired).toEqual([])
    expect(plan.fires).toHaveLength(1)
    expect(plan.fires[0]!.final).toBe(true)
    expect(plan.fires[0]!.dueAt).toBe(now)

    // …and it is still subject to the `:215` pending guard, so it cannot be
    // enqueued twice while the turn it is waiting on runs.
    expect(planCronTick({ tasks: [owed], now, pending: new Set([owed.id]) }).fires).toEqual([])
  })

  test('an expired RECURRING record carrying the marker is kept and fired too', () => {
    const owed = record({
      id: 'f1b2c3d4',
      recurring: true,
      createdAt: now - SESSION_CRON_EXPIRY_MS - 60_000,
      owedFire: true,
    })
    expect(planCronRestore([owed], now).keep).toEqual([owed])
    expect(planCronTick({ tasks: [owed], now }).fires.map(fire => fire.final)).toEqual([true])
  })
})

describe('a dueless dynamic record is dropped at restore, and that is intended (T8 (f))', () => {
  const now = new Date(2026, 2, 15, 12, 0, 0).getTime()

  test('no nextFireAt means the loop is over, so the restore ends it', () => {
    // `SessionCronService.awaitingReschedule` shields exactly this shape while
    // the delivered iteration might still call `ScheduleWakeup` — in memory,
    // for the life of that iteration. A record that reached a restore has no
    // iteration left to wait for, so `:130`'s "ends the loop when that
    // iteration doesn't reschedule either" is the outcome here.
    const dueless = record({
      id: 'a9b8c7d6',
      schedule: 'dynamic',
      recurring: true,
      dynamic: true,
      fallbackArmed: true,
      createdAt: now - 60_000,
    })
    expect(dueless.nextFireAt).toBeUndefined()
    const plan = planCronRestore([dueless], now)
    expect(plan.keep).toEqual([])
    expect(plan.drop).toEqual([dueless])
  })

  test('the same record WITH a pending wakeup is restored — the positive control', () => {
    const armed = record({
      id: 'b9b8c7d6',
      schedule: 'dynamic',
      recurring: true,
      dynamic: true,
      nextFireAt: now + 60_000,
      createdAt: now - 60_000,
    })
    expect(planCronRestore([armed], now).keep).toEqual([armed])
  })
})
