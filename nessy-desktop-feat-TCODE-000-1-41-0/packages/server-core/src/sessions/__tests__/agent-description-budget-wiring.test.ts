/**
 * P6.315 · the agent-description budget report is WIRED, at every site that
 * loads definitions.
 *
 * The producer landed in W7-m and fired nowhere for a day: W7-u traced the
 * routing and found four production call sites of
 * `materializePiRuntimeAgentDefinitions` — three here and one in `pi-agent.ts` —
 * and not one of them passed `onDescriptionsOverBudget`, so the measurement was
 * computed by nobody. A producer with no caller is indistinguishable from an
 * absent feature, and it is exactly the shape a unit test of the producer
 * cannot see: `pi-runtime-agent-description-budget.test.ts` was green the whole
 * time.
 *
 * So what is pinned is the WIRING, and it is pinned as TOTALITY over the call
 * sites rather than as a count: a fourth `SessionManager` site added later fails
 * here until someone passes the callback.
 *
 * Source-matched rather than driven, for the reason the three sites make
 * unavoidable: each sits inside a 30 000-line class and needs a live capability
 * runtime, a materializer and a workspace to reach, and the proposition is
 * about which OPTION the call carries.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(fileURLToPath(new URL('../SessionManager.ts', import.meta.url)), 'utf8')
const piAgent = readFileSync(
  fileURLToPath(new URL('../../../../shared/src/agent/pi-agent.ts', import.meta.url)),
  'utf8',
)

/** The bodies of every `materializePiRuntimeAgentDefinitions({ … })` call. */
function callBodies(text: string): string[] {
  const needle = 'materializePiRuntimeAgentDefinitions({'
  const bodies: string[] = []
  let at = text.indexOf(needle)
  while (at !== -1) {
    let depth = 1
    let i = at + needle.length
    for (; i < text.length && depth > 0; i += 1) {
      const ch = text[i]!
      if (ch === '{') depth += 1
      else if (ch === '}') depth -= 1
    }
    bodies.push(text.slice(at, i))
    at = text.indexOf(needle, i)
  }
  return bodies
}

describe('P6.315 · every load-time materialization reports the description budget', () => {
  const calls = callBodies(source)

  it('finds the call sites', () => {
    // Positive control: a renamed helper would make every assertion below
    // vacuously true, which is the failure mode this whole file exists to catch
    // one layer up.
    expect(calls.length).toBeGreaterThanOrEqual(3)
    for (const body of calls) expect(body).toContain('materializer')
  })

  it('passes onDescriptionsOverBudget at every one of them', () => {
    for (const [index, body] of calls.entries()) {
      expect(body, `SessionManager call #${index} does not report the description budget`)
        .toContain('onDescriptionsOverBudget')
    }
  })

  it('names the offenders and the limit, not just a boolean', () => {
    // The row's `done_means` is "a notice naming the offenders". A handler that
    // logged "over budget" and stopped would satisfy the wiring assertion above
    // and none of the row.
    const handler = source.slice(source.indexOf('function agentDescriptionBudgetWarning'))
      .slice(0, 900)
    expect(handler).toContain('offender.name')
    expect(handler).toContain('offender.file')
    expect(handler).toContain('diagnostic.limit')
    expect(handler).toContain('diagnostic.estimatedTokens')
  })

  it('the per-turn refresh does NOT report it, and says why', () => {
    // The fourth call site. Its omission is a decision, not the gap this file
    // pins: the budget is a property of the definition SET, so reporting it on
    // every turn's re-registration would repeat one identical line forever.
    const refresh = callBodies(piAgent)
    expect(refresh).toHaveLength(1)
    expect(refresh[0]).not.toContain('onDescriptionsOverBudget:')
    expect(refresh[0]).toContain('DELIBERATELY NOT passed')
  })
})
