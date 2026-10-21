/**
 * The pre-plan compaction wait cannot hang.
 *
 * "Accept & Compact" used to `addEventListener('nessy:compaction-complete')`
 * with no timeout, so a compaction event that never arrived left the user in
 * silence with the plan un-executed and the listener attached forever. The happy
 * path is the first test; the other two are the ones that were missing.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { awaitCompactionComplete, COMPACTION_WAIT_TIMEOUT_MS, compactTurnLeftPlanOpen } from '../compaction-wait'

/** A minimal EventTarget stand-in that also reports whether it leaked. */
function fakeTarget() {
  const listeners = new Map<string, Set<EventListener>>()
  return {
    addEventListener(type: string, listener: EventListener) {
      const set = listeners.get(type) ?? new Set()
      set.add(listener)
      listeners.set(type, set)
    },
    removeEventListener(type: string, listener: EventListener) {
      listeners.get(type)?.delete(listener)
    },
    listenerCount(type = 'nessy:compaction-complete') {
      return listeners.get(type)?.size ?? 0
    },
    emit(sessionId: string) {
      for (const listener of [...(listeners.get('nessy:compaction-complete') ?? [])]) {
        listener({ detail: { sessionId } } as unknown as Event)
      }
    },
  }
}

const tick = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('awaitCompactionComplete', () => {
  it('completes on the event for its own session and detaches', async () => {
    const target = fakeTarget()
    const settled: string[] = []
    awaitCompactionComplete({
      sessionId: 'session-a',
      timeoutMs: 10_000,
      target,
      onComplete: () => { settled.push('complete') },
      onTimeout: () => { settled.push('timeout') },
    })

    // Another session's compaction must not settle this wait.
    target.emit('session-b')
    expect(settled).toEqual([])
    expect(target.listenerCount()).toBe(1)

    target.emit('session-a')
    expect(settled).toEqual(['complete'])
    expect(target.listenerCount()).toBe(0)

    // A late duplicate cannot submit the plan twice.
    target.emit('session-a')
    expect(settled).toEqual(['complete'])
  })

  it('times out with a stated failure when the event never arrives', async () => {
    const target = fakeTarget()
    const settled: string[] = []
    awaitCompactionComplete({
      sessionId: 'session-a',
      timeoutMs: 5,
      target,
      onComplete: () => { settled.push('complete') },
      onTimeout: () => { settled.push('timeout') },
    })

    await tick(30)

    expect(settled).toEqual(['timeout'])
    expect(target.listenerCount()).toBe(0)
  })

  it('cancels without settling, so an unmount cannot orphan the listener', async () => {
    const target = fakeTarget()
    const settled: string[] = []
    const cancel = awaitCompactionComplete({
      sessionId: 'session-a',
      timeoutMs: 5,
      target,
      onComplete: () => { settled.push('complete') },
      onTimeout: () => { settled.push('timeout') },
    })

    cancel()
    expect(target.listenerCount()).toBe(0)

    target.emit('session-a')
    await tick(30)
    expect(settled).toEqual([])
  })

  it('outlasts the backend compact RPC, so a slow compaction is never abandoned', () => {
    // PiAgent.requestCompact bounds itself at 300s. A shorter wait here would
    // fail a compaction that is still about to succeed.
    expect(COMPACTION_WAIT_TIMEOUT_MS).toBeGreaterThan(300_000)
  })
})

/**
 * F1.856 — Accept & Compact on a Pi session with nothing to compact dead-ended (SIT-x, SIT-y on
 * the 1.41.0 RC): Pi refused the `/compact`, no plan turn followed, and the plan card lost its
 * Accept. The plan is now sent through the host's readiness (a refused-as-nothing-to-do
 * compaction counts as done), so this wait never hears `compaction-complete` for it — and 330 s
 * later it must NOT tell the user a plan that already ran "was not executed".
 */
describe('F1.856 — the wait reports a failure only while the plan still awaits its compaction', () => {
  it('a timeout whose plan is no longer awaiting (sent, cleared, or made ready) runs neither callback', async () => {
    const target = fakeTarget()
    const settled: string[] = []
    awaitCompactionComplete({
      sessionId: 'session-a',
      timeoutMs: 5,
      target,
      isStillAwaiting: async () => false,
      onComplete: () => { settled.push('complete') },
      onTimeout: () => { settled.push('timeout') },
    })
    await tick(40)
    expect(settled).toEqual([])
    expect(target.listenerCount()).toBe(0)
  })

  it('CONTROL: a timeout whose plan still awaits (a compaction that genuinely failed) keeps the refusal', async () => {
    const target = fakeTarget()
    const settled: string[] = []
    awaitCompactionComplete({
      sessionId: 'session-a',
      timeoutMs: 5,
      target,
      isStillAwaiting: async () => true,
      onComplete: () => { settled.push('complete') },
      onTimeout: () => { settled.push('timeout') },
    })
    await tick(40)
    expect(settled).toEqual(['timeout'])
  })
})

/**
 * F1.856 — why the card lost its Accept: `ChatDisplay` offers Accept only while no user turn
 * follows the plan, and Accept & Compact's own `/compact` IS a user turn. When that compaction
 * ends in an error the plan was not run, so the `/compact` must not take the plan's Accept away
 * (the timeout toast's "Approve it again to retry" was otherwise impossible).
 */
describe('F1.856 — a /compact that ended in an error leaves the plan open', () => {
  const user = (content: string) => ({ type: 'user', message: { role: 'user', content } })
  const system = (role: string, content: string, statusType?: string) => ({ type: 'system', message: { role, content, ...(statusType ? { statusType } : {}) } })

  it('a /compact followed (before any other user turn) by an error does not supersede the plan', () => {
    const after = [user('/compact'), system('info', 'Debug mode is on …'), system('error', 'Context compaction failed: summary failed')]
    expect(compactTurnLeftPlanOpen(after, 0)).toBe(true)
  })

  it('CONTROLS: a compaction that completed, any other user turn, and a later user turn after the error all supersede it', () => {
    expect(compactTurnLeftPlanOpen([user('/compact'), system('info', 'Compacted context', 'compaction_complete')], 0)).toBe(false)
    expect(compactTurnLeftPlanOpen([user('/compact')], 0)).toBe(false)
    expect(compactTurnLeftPlanOpen([user('hello'), system('error', 'boom')], 0)).toBe(false)
    const retried = [user('/compact'), user('Plan approved, please execute.'), system('error', 'boom')]
    expect(compactTurnLeftPlanOpen(retried, 0)).toBe(false)
    expect(compactTurnLeftPlanOpen(retried, 1)).toBe(false)
  })
})

describe('F1.856 — both halves are wired where the flow runs', () => {
  const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8')

  it("ChatDisplay's Accept visibility skips only a /compact that left the plan open", () => {
    const line = read('../../ChatDisplay.tsx').split('\n').find(l => l.includes('const isLastResponse = '))
    expect(line).toContain("t.type === 'user' && !compactTurnLeftPlanOpen(after, i)")
  })

  it("the Accept & Compact wait asks the host whether the plan still awaits before it reports a failure", () => {
    const source = read('../FreeFormInput.tsx')
    const wait = source.slice(source.indexOf('awaitCompactionComplete({'), source.indexOf('onComplete:', source.indexOf('awaitCompactionComplete({')))
    expect(wait).toContain('isStillAwaiting: async () =>')
    expect(wait).toContain('getPendingPlanExecution(sessionId))?.awaitingCompaction === true')
  })
})
