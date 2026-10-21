// UB6.9 — rebased from craft-agents-oss `v0.15.1:packages/server-core/src/decisions/automation-condition.test.ts`
// (Apache-2.0). The fake client follows this tree's decision-point.test.ts seam
// (a `decide` stand-in) instead of upstream's SystemOneClient-over-fetch build;
// the assertions are upstream's. A distinct provider per call keeps the
// process-wide cold-start warmth from leaking between tests.

import { describe, expect, it } from 'bun:test'
import {
  normalizeDecisionLayerSettings,
  resolveDecisionEndpoint,
  type DecisionClientResolution,
  type DecisionRequest,
  type DecisionResult,
} from '@nessy-agent/shared/decisions'
import { AUTOMATION_CONDITION_MAX_MESSAGE_CHARS, buildAutomationConditionRequest, checkAutomationCondition } from './automation-condition'

/** Answer every decide with one canned noul probability (upstream's `answering`). */
function answering(noul: number) {
  return async (): Promise<DecisionClientResolution> => {
    const settings = normalizeDecisionLayerSettings({ enabled: true, provider: 'openrouter', features: { automationConditions: true } })
    const endpoint = resolveDecisionEndpoint(settings)
    const client = {
      decide: async (request: DecisionRequest): Promise<DecisionResult> => {
        void request
        return { model: 'jev-1.13.0', modelReported: true, requestedModel: 'jev-1.13.0', answers: { condition: { type: 'noul', noul } }, usage: { inputTokens: 10, outputTokens: 1 }, latencyMs: 5, state: { sha256: 'x', bytes: 2, truncated: false } }
      },
    }
    return { ok: true, value: { client: client as never, settings, provider: 'openrouter', endpoint, keySource: 'provider' } }
  }
}

describe('buildAutomationConditionRequest', () => {
  it('sends the event, the payload without ids, and the session excerpt', () => {
    const request = buildAutomationConditionRequest(
      { question: 'Is it a bug report?' },
      {
        event: 'LabelAdd',
        automationName: 'Triage',
        payload: { label: 'bug', sessionId: 's-1', workspaceId: 'w', timestamp: 1 },
        session: { name: 'Crash on start', labels: ['bug'], lastUserMessage: 'x'.repeat(5_000) },
      },
    )
    const state = request.state as Record<string, any>
    expect(state.event).toBe('LabelAdd')
    expect(state.automation).toBe('Triage')
    expect(state.trigger).toEqual({ label: 'bug' })
    expect(state.session.name).toBe('Crash on start')
    expect(state.session.last_user_message.length).toBe(AUTOMATION_CONDITION_MAX_MESSAGE_CHARS + 1)
    expect(request.questions.condition).toEqual({ type: 'noul', instructions: 'Is it a bug report?' })
  })
})

describe('checkAutomationCondition', () => {
  const context = { event: 'LabelAdd', payload: { label: 'bug' } }

  it('is null when the feature is off, so the automation runs', async () => {
    const verdict = await checkAutomationCondition({ question: 'q' }, context, {
      resolveClient: async () => ({ ok: false, failure: { kind: 'disabled', message: 'off' } }),
    })
    expect(verdict).toBeNull()
  })

  it('runs at or above the threshold and skips below it, with its probability', async () => {
    expect(await checkAutomationCondition({ question: 'q' }, context, { resolveClient: answering(0.5) })).toEqual({ run: true, probability: 0.5 })
    expect(await checkAutomationCondition({ question: 'q' }, context, { resolveClient: answering(0.2) })).toEqual({ run: false, probability: 0.2 })
    expect(await checkAutomationCondition({ question: 'q', threshold: 0.9 }, context, { resolveClient: answering(0.8) })).toEqual({ run: false, probability: 0.8 })
  })
})
