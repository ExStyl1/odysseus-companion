/**
 * F1.1288 (origin lane PI-1, 2026-10-02) — the Pi subprocess reader dispatched
 * every inbound message WITHOUT awaiting (`rl.on('line', …)` → `processMessage
 * (msg).catch(…)`), so an `abort` and a `prompt` sent milliseconds apart — the
 * Stop-followed-by-an-immediate-send shape — ran concurrently: `handlePrompt`
 * fires `session.prompt(...)` on a session the abort has not yet made idle, and
 * the abort's own `waitForIdle` (pi-coding-agent 0.85+) can take the new turn
 * with it. The host believes the send was accepted.
 *
 * The serialization is ONE direction, deliberately: a prompt that arrives while
 * an abort is in flight JOINS the abort; a prompt in flight never holds an
 * abort (Stop must stay immediate — `handlePrompt` awaits the whole turn, so a
 * symmetric gate would queue every Stop behind a multi-minute run). The gate
 * also coalesces Stops: a second `abort` joins the first (idempotent per
 * F1.591) instead of racing it through `abortCompaction`/`abort`.
 *
 * The gate is its own module so these arms are unit-fast; the wiring inside
 * `index.ts` is pinned by the source arm below (the handlers are module-internal,
 * and the import-guard test holds `from '../index.ts'` as a one-importer seam).
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { TurnTransitionGate } from '../turn-transition.ts'

const tick = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms) })

/** A body the test resolves by hand, with a marker for ordering assertions. */
function deferredBody() {
  const events: string[] = []
  let release!: () => void
  const done = new Promise<void>(resolve => { release = resolve })
  return {
    events,
    run: async () => {
      events.push('abort-started')
      await done
      events.push('abort-settled')
    },
    release: () => { release(); },
  }
}

describe('TurnTransitionGate — the abort side coalesces Stops', () => {
  it('a second Stop joins the first: the body runs once, and the join settles after it', async () => {
    const gate = new TurnTransitionGate()
    const body = deferredBody()
    let firstSettled = false
    const first = gate.runAbort(async () => { await body.run(); firstSettled = true })
    const joinedOrder: string[] = []
    const second = gate.runAbort(async () => { joinedOrder.push('second-ran') })

    await tick(10)
    // Coalescing: the second Stop's body never runs — the first abort does the work.
    expect(joinedOrder).toEqual([])
    body.release()
    await Promise.all([first, second])
    expect(firstSettled).toBe(true)
    expect(joinedOrder).toEqual([])
    await tick(10)
    // The gate is clear: a following prompt side is not held.
    await gate.waitForAbort()
  })

  it('an abort body that REJECTS still releases its joiners and clears the gate', async () => {
    const gate = new TurnTransitionGate()
    const first = gate.runAbort(async () => { throw new Error('abort failed') })
    const joined = gate.runAbort(async () => { /* the coalesced Stop runs nothing */ })
    await expect(first).rejects.toThrow('abort failed')
    await joined // resolved, not rejected: the coalesced Stop has nothing left to do
    await gate.waitForAbort()
    let ran = 0
    await gate.runAbort(async () => { ran += 1 })
    expect(ran).toBe(1)
  })
})

describe('TurnTransitionGate — the prompt side joins an in-flight abort, and only that', () => {
  it('THE DEFECT — waitForAbort stays pending until the in-flight abort settles (ordering, not timing)', async () => {
    const gate = new TurnTransitionGate()
    const body = deferredBody()
    const order: string[] = []
    const abort = gate.runAbort(body.run)
    const promptSide = gate.waitForAbort().then(() => { order.push('prompt-after-abort') })

    await tick(10)
    expect(order).toEqual([])
    body.release()
    await abort
    await promptSide
    expect(order).toEqual(['prompt-after-abort'])
    expect(body.events).toEqual(['abort-started', 'abort-settled'])
  })

  it('CONTROL — with no abort in flight the prompt side resolves at once', async () => {
    const gate = new TurnTransitionGate()
    await gate.waitForAbort()
    let ran = false
    await gate.waitForAbort().then(() => { ran = true })
    expect(ran).toBe(true)
  })
})

describe('F1.1288 — the subprocess handlers are wired through the gate', () => {
  const index = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
  const handlePrompt = index.slice(index.indexOf('async function handlePrompt'), index.indexOf('async function registerToolsHandler') > 0 ? index.indexOf('async function registerToolsHandler') : index.indexOf('async function handleAbort'))
  const handleAbort = index.slice(index.indexOf('async function handleAbort'), index.indexOf('async function handleAbort') + 2_000)

  it('handlePrompt joins an in-flight abort before it touches the session', () => {
    expect(handlePrompt).toContain('await turnTransitions.waitForAbort()')
  })

  it('handleAbort runs through the gate (coalescing Stops, naming the join for the late one)', () => {
    expect(handleAbort).toContain('turnTransitions.runAbort')
  })

  it('the reader itself still dispatches without awaiting — Stop stays immediate', () => {
    expect(index).toContain('processMessage(msg).catch((error) => {')
  })
})
