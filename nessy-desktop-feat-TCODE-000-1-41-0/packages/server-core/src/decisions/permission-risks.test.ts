// UB6.10 — rebased from craft-agents-oss `v0.15.1:packages/server-core/src/decisions/permission-risks.test.ts`
// (Apache-2.0). Upstream's three cases are kept verbatim; the client stub follows
// this tree's decision-point.test.ts seam (a `decide` stand-in behind resolveClient)
// instead of upstream's SystemOneClient-over-fetch build.

import { describe, expect, it } from 'bun:test'
import {
  normalizeDecisionLayerSettings,
  resolveDecisionEndpoint,
  type DecisionClientResolution,
  type DecisionRequest,
  type DecisionResult,
} from '@nessy-agent/shared/decisions'
import { assessPermissionRisks, buildPermissionRiskRequest, PERMISSION_RISK_MAX_CHARS, readPermissionRisks } from './permission-risks'

function nouls(values: Record<string, number>): DecisionResult {
  const answers: DecisionResult['answers'] = {}
  for (const [key, noul] of Object.entries(values)) answers[key] = { type: 'noul', noul }
  return { model: 'jev', requestedModel: 'jev', modelReported: true, answers, usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1 } as unknown as DecisionResult
}

/** Answer one assess call with a canned full answer set (upstream's `answering`, collapsed). */
function answering(values: Record<string, number>) {
  return async (): Promise<DecisionClientResolution> => {
    const settings = normalizeDecisionLayerSettings({ enabled: true, provider: 'openrouter', features: { riskBadges: true } })
    const endpoint = resolveDecisionEndpoint(settings)
    const client = {
      decide: async (request: DecisionRequest): Promise<DecisionResult> => {
        void request
        return nouls(values)
      },
    }
    return { ok: true, value: { client: client as never, settings, provider: 'openrouter', endpoint, keySource: 'provider' } }
  }
}

describe('permission risk badges', () => {
  it('asks one yes/no question per badge and clips long commands', () => {
    const request = buildPermissionRiskRequest({ toolName: 'Bash', description: 'Execute: …', command: 'x'.repeat(10_000) })
    expect(Object.keys(request.questions)).toEqual(['deletes', 'sends', 'publishes', 'credentials', 'system', 'spends'])
    expect((request.state as Record<string, string>).command!.length).toBe(PERMISSION_RISK_MAX_CHARS + 1)
  })

  it('shows badges at or above the threshold, in a fixed order', () => {
    expect(readPermissionRisks(nouls({ spends: 0.9, deletes: 0.8, sends: 0.74, publishes: 0.1, credentials: 0.2, system: 0.3 }))).toEqual(['deletes', 'spends'])
    expect(readPermissionRisks(null)).toBeNull()
  })

  it('is null when the feature is off', async () => {
    const risks = await assessPermissionRisks(
      { toolName: 'Bash', description: 'Execute: rm -rf x', command: 'rm -rf x' },
      { resolveClient: async () => ({ ok: false, failure: { kind: 'disabled', message: 'off' } }) },
    )
    expect(risks).toBeNull()
  })

  it('positive — an rm -rf prompt gains the deletes badge asynchronously, through the real assess', async () => {
    const risks = await assessPermissionRisks(
      { toolName: 'Bash', description: 'Execute: rm -rf dist', command: 'rm -rf dist' },
      { resolveClient: answering({ deletes: 0.9, sends: 0.1, publishes: 0.05, credentials: 0.1, system: 0.2, spends: 0.05 }) },
    )
    expect(risks).toEqual(['deletes'])
  })
})
