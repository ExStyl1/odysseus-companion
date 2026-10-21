/**
 * P2.525 — the resume port is no longer `provider === 'pi'`.
 *
 * `PiDeferredToolCallV1` + `onToolCallDeferred` / `getDeferredToolCall` is a
 * complete persisted resume mechanism, and it was gated to one provider on the
 * premise that nothing in this fork keeps a promise to come back. The premise
 * was false twice over: the mechanism is provider-agnostic, and the runtime that
 * could not use it was the one whose gate refused to defer at all. With the
 * claude gate emitting the runtime's own `defer` and the event adapter reading
 * both endings, a deferral is reachable there and the record has to exist for it.
 *
 * ## WHAT THIS INSTRUMENT IS, AND WHAT IT CANNOT SEE — stated, not implied
 *
 * This is a SOURCE-level pin, which `AGENTS.md` records as the weaker kind: a
 * string matcher caught 1 of 8 evasion shapes once, and the lesson stuck. It is
 * used here because the two lines sit inside the backend-config literal that
 * `getOrCreateAgent` builds around a real `createAgent()`, and driving that in a
 * unit test means constructing a live backend — the reason the gate survived
 * unexamined in the first place.
 *
 * Two things make it more than a bare regex:
 *
 *  - it carries a POSITIVE CONTROL on the same read. `onExecutionReceipt` is a
 *    genuinely Pi-scoped sink one line above and still carries its gate, so a
 *    matcher that had stopped seeing gates fails here instead of reporting a
 *    clean bill;
 *  - it reads the two lines by NAME rather than by position, so a reorder does
 *    not silently disarm it.
 *
 * What it still cannot see: a gate reintroduced in a different spelling (a
 * ternary on a variable, an early return above the literal), or the port being
 * passed and then ignored by a backend. The first is covered by nothing today
 * and is named here rather than left implicit; the second is covered on the
 * claude side by `claude-hook-defer.test.ts`'s reconcile arms, which drive the
 * real method against real events.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'

const SOURCE = readFileSync(new URL('../SessionManager.ts', import.meta.url), 'utf8')

/** The line that binds `name:` in the backend-config literal, without its body. */
function bindingLine(name: string): string {
  const at = SOURCE.indexOf(`\n        ${name}: `)
  expect(at).toBeGreaterThan(-1)
  return SOURCE.slice(at + 1, SOURCE.indexOf('\n', at + 1))
}

describe('P2.525 — the deferred-call resume port', () => {
  it('is handed to every backend, not only to Pi', () => {
    expect(bindingLine('onToolCallDeferred')).not.toContain("provider === 'pi'")
    expect(bindingLine('getDeferredToolCall')).not.toContain("provider === 'pi'")
  })

  it('THE POSITIVE CONTROL — a genuinely Pi-scoped sink beside it still reads as gated', () => {
    // Without this the assertion above passes just as well against a matcher
    // that has stopped finding anything at all, which is the failure mode a
    // source-level check is most likely to have.
    expect(bindingLine('onExecutionReceipt')).toContain("provider === 'pi'")
  })

  it('the reader answers the session record itself, so a held call survives a reload', () => {
    // The other half of the ungate: `getDeferredToolCall` must read
    // `managed.deferredToolCall` — the persisted field — and not a local, or the
    // record would be written durably and read back from nothing.
    expect(bindingLine('getDeferredToolCall')).toContain('managed.deferredToolCall')
  })
})
