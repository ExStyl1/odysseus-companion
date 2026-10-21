/**
 * F1.546 — the two-phase real-server clock (`real-server-clock.ts`).
 *
 * The defect it replaces was ONE timer from spawn covering boot and answers, so a
 * slow boot spent the answer budget. The first arm is that exact shape at small
 * scale: the child's `ready` arrives AFTER the answer budget has elapsed since
 * spawn, and the run must still be judged on its answers. The other arms pin
 * that each phase can still expire, and names itself when it does.
 */
import { describe, expect, it } from 'bun:test'
import { REAL_SERVER_BOOT_WAIT_MS, realServerTestBudget, startRealServerClock, type RealServerClockPhase } from './real-server-clock.ts'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function rig(bootWaitMs: number, answerWaitMs: number) {
  const expired: Array<{ phase: RealServerClockPhase; message: string }> = []
  const clock = startRealServerClock({ bootWaitMs, answerWaitMs, onExpire: (phase, message) => { expired.push({ phase, message }) } })
  return { clock, expired }
}

describe('F1.546 · the real-server clock starts the answer budget at the first ready', () => {
  it('a boot slower than the answer budget does not spend it', async () => {
    const { clock, expired } = rig(400, 80)
    await sleep(160) // twice the answer budget, still inside the boot budget
    expect(clock.phase).toBe('boot')
    clock.ready()
    await sleep(40) // the answers arrive inside their own budget
    clock.clear()
    await sleep(120)
    expect(expired).toEqual([])
  })

  it('a boot that never answers expires as the BOOT phase, naming it', async () => {
    const { expired } = rig(60, 1_000)
    await sleep(120)
    expect(expired).toHaveLength(1)
    expect(expired[0]!.phase).toBe('boot')
    expect(expired[0]!.message).toContain('no ready within 60 ms of spawn')
  })

  it('answers that never come expire as the ANSWER phase, timed from the first ready only', async () => {
    const { clock, expired } = rig(1_000, 60)
    clock.ready()
    await sleep(30)
    clock.ready() // a later ready (a re-init) does not restart the answer budget
    await sleep(60)
    expect(expired.map(e => e.phase)).toEqual(['answer'])
    expect(expired[0]!.message).toContain('no answer within 60 ms of its first ready')
  })

  it('expires at most once, and clear() is idempotent', async () => {
    const { clock, expired } = rig(30, 30)
    await sleep(80)
    clock.ready()
    clock.clear()
    clock.clear()
    await sleep(60)
    expect(expired).toHaveLength(1)
  })

  it('the per-test budget holds boot + answers + teardown', () => {
    expect(realServerTestBudget(120_000)).toBe(REAL_SERVER_BOOT_WAIT_MS + 120_000 + 60_000)
    expect(realServerTestBudget(120_000)).toBeGreaterThan(REAL_SERVER_BOOT_WAIT_MS + 120_000)
  })
})
