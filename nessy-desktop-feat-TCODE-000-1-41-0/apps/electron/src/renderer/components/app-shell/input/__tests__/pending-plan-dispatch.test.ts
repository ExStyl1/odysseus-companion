/**
 * F1.241 — ONE dispatcher sends an Accept & Compact plan, and only on the host's claim.
 *
 * Before this row the plan left the composer from TWO paths with no shared claim: the
 * live wait's `onComplete` called `onSubmit` straight away, and the reload-recovery
 * effect woke on the same `nessy:compaction-complete` 100 ms later and sent again unless
 * its read of the persisted state came back empty. Neither path asked the host whether it
 * MAY send — `markPendingPlanExecutionDispatched` returned `void` and could not refuse.
 *
 * The first five cases are upstream's own (craft-agents-oss v0.13.4,
 * `apps/electron/src/renderer/components/app-shell/input/__tests__/pending-plan-dispatch.test.ts`,
 * Apache-2.0), adapted to our persisted shape, which carries no `planPath` on the wire
 * (the host resolves the plan from its handle). The last case pins the WIRING — a
 * dispatcher nobody calls closes nothing — against `FreeFormInput`'s comment-stripped
 * source: the compaction wait's completion is a wakeup, never a send, and every plan send
 * goes through the one dispatcher.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createPendingPlanDispatcher, type PendingPlanExecution } from '../pending-plan-dispatch'

const ready: PendingPlanExecution = { draftInputSnapshot: 'Keep this', awaitingCompaction: false, executionDispatched: false }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

describe('persisted plan dispatch (F1.241, upstream port)', () => {
  it('waits for idle and persisted success; failure/awaiting cannot execute', async () => {
    let busy = true
    let pending: PendingPlanExecution | null = ready
    let claims = 0
    let sends = 0
    const dispatcher = createPendingPlanDispatcher({
      isBusy: () => busy, load: async () => pending, claim: async () => { claims++; return true }, submit: () => { sends++ }, clear: async () => {},
    })
    await dispatcher.request()
    expect(claims).toBe(0)
    busy = false
    pending = { ...ready, awaitingCompaction: true }
    await dispatcher.request()
    pending = null // host cleared a failed manual compaction
    await dispatcher.request()
    expect(sends).toBe(0)
    pending = ready
    await dispatcher.request()
    expect(sends).toBe(1)
  })

  it('requires claim === true; duplicate listeners and reloads send once', async () => {
    let claimed = false
    const sent: PendingPlanExecution[] = []
    const dependencies = {
      isBusy: () => false, load: async () => ready,
      claim: async () => { if (claimed) return false; claimed = true; return true },
      submit: (pending: PendingPlanExecution) => { sent.push(pending) }, clear: async () => {},
    }
    const first = createPendingPlanDispatcher(dependencies)
    const second = createPendingPlanDispatcher(dependencies)
    await Promise.all([first.request(), second.request(), first.request()])
    await createPendingPlanDispatcher(dependencies).request()
    expect(sent).toEqual([ready])
  })

  it('does not accept a legacy void claim as ownership', async () => {
    let sends = 0
    const dispatcher = createPendingPlanDispatcher({ isBusy: () => false, load: async () => ready, claim: async () => undefined, submit: () => { sends++ }, clear: async () => {} })
    await dispatcher.request()
    expect(sends).toBe(0)
  })

  it('rechecks busy after loading; disposal cancels an unclaimed read', async () => {
    const read = deferred<PendingPlanExecution | null>()
    let claims = 0
    const dispatcher = createPendingPlanDispatcher({ isBusy: () => false, load: () => read.promise, claim: async () => { claims++; return true }, submit: () => {}, clear: async () => {} })
    const running = dispatcher.request()
    dispatcher.dispose()
    read.resolve(ready)
    await running
    expect(claims).toBe(0)
  })

  it('finishes an already accepted claim even if its listener is disposed', async () => {
    const claim = deferred<boolean>()
    let sends = 0
    const dispatcher = createPendingPlanDispatcher({ isBusy: () => false, load: async () => ready, claim: () => claim.promise, submit: () => { sends++ }, clear: async () => {} })
    const running = dispatcher.request()
    await Promise.resolve()
    dispatcher.dispose()
    claim.resolve(true)
    await running
    expect(sends).toBe(1)
  })
})

/** Comment-stripped source, so a sentence in a docblock cannot satisfy a pin. */
function stripped(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('FreeFormInput sends an Accept & Compact plan through the one dispatcher (F1.241)', () => {
  const source = stripped('../FreeFormInput.tsx')

  it('builds the dispatcher over the host claim and wakes it on idle', () => {
    expect(source).toContain('createPendingPlanDispatcher({')
    expect(source).toContain("claim: () => window.electronAPI.sessionCommand(sessionId, { type: 'markPendingPlanExecutionDispatched' })")
    expect(source).toContain('if (!isProcessing) requestPendingPlanRef.current?.()')
  })

  it('never sends the plan from the compaction wait, and has no second recovery sender', () => {
    const wait = source.slice(source.indexOf('awaitCompactionComplete({'), source.indexOf('onTimeout:', source.indexOf('awaitCompactionComplete({')))
    expect(wait.length).toBeGreaterThan(0)
    expect(wait).not.toContain('onSubmit(')
    // The old recovery sender: its own claim-less local flag and its 100 ms guess.
    expect(source).not.toContain('hasExecuted')
    expect(source).not.toContain('setTimeout(resolve, 100)')
    // Exactly one place builds the execution message for a pending plan.
    expect(source.split('pending.draftInputSnapshot').length - 1).toBe(1)
  })
})
