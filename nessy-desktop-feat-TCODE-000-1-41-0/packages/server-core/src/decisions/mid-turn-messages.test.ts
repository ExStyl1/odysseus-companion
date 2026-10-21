// UB6.13 — rebased from craft-agents-oss `v0.15.1:packages/server-core/src/decisions/mid-turn-messages.test.ts`
// (Apache-2.0). The client stub follows this tree's decision-point.test.ts seam.
// The SessionManager half (record-as-queued, steerQueuedIfDecided, the continuation
// merge replay) is pinned in `sessions/__tests__/mid-turn-post-queue.test.ts`.

import { describe, expect, it } from 'bun:test'
import {
  normalizeDecisionLayerSettings,
  resolveDecisionEndpoint,
  type DecisionClientResolution,
  type DecisionRequest,
  type DecisionResult,
} from '@nessy-agent/shared/decisions'
import { buildMidTurnRequest, decideMidTurnDelivery, isContinuation, MID_TURN_MAX_CHARS } from './mid-turn-messages'

/** Answer every question with the given answers (upstream's `answering`, over our client stub). */
function answering(answers: Record<string, unknown>): () => Promise<DecisionClientResolution> {
  return async () => {
    const settings = normalizeDecisionLayerSettings({ enabled: true, provider: 'openrouter', features: { midTurnMessages: true } })
    const endpoint = resolveDecisionEndpoint(settings)
    const client = {
      decide: async (request: DecisionRequest): Promise<DecisionResult> => {
        void request
        return { model: 'jev-1.13.0', modelReported: true, requestedModel: 'jev-1.13.0', answers: answers as DecisionResult['answers'], usage: { inputTokens: 5, outputTokens: 1 }, latencyMs: 5, state: { sha256: 'x', bytes: 2, truncated: false } }
      },
    }
    return { ok: true, value: { client: client as never, settings, provider: 'openrouter', endpoint, keySource: 'provider' } }
  }
}
/** Answer the delivery question with one choice at one confidence. */
function answeringChoice(choice: string, confidence: number): () => Promise<DecisionClientResolution> {
  return answering({ delivery: { type: 'choice', choice, confidence, probabilities: { [choice]: confidence } } })
}
const off = async () => ({ ok: false as const, failure: { kind: 'disabled' as const, message: 'off' } })

describe('decideMidTurnDelivery', () => {
  it('sends the running request and the new message, clipped (upstream case)', () => {
    const state = buildMidTurnRequest({ runningRequest: 'x'.repeat(5_000), newMessage: 'use tabs' }).state as Record<string, string>
    expect(state.request_being_worked_on!.length).toBe(MID_TURN_MAX_CHARS + 1)
    expect(state.new_message).toBe('use tabs')
    // Without a running request the state names the new message alone.
    expect(Object.keys(buildMidTurnRequest({ newMessage: 'use tabs' }).state as object)).toEqual(['new_message'])
  })

  it('is null when the feature is off, so the connection behaviour applies', async () => {
    expect(await decideMidTurnDelivery({ newMessage: 'call it X', configured: 'queue' }, { resolveClient: off })).toBeNull()
  })

  it('steers a confident correction and queues a confident follow-up, over the configured default', async () => {
    expect(await decideMidTurnDelivery({ newMessage: 'actually call it Y instead', configured: 'queue' }, { resolveClient: answeringChoice('steer', 0.9) })).toBe('steer')
    expect(await decideMidTurnDelivery({ newMessage: 'also check the logs afterwards', configured: 'steer' }, { resolveClient: answeringChoice('queue', 0.85) })).toBe('queue')
  })

  it('is null below the confidence floor and records the configured default', async () => {
    expect(await decideMidTurnDelivery({ newMessage: 'call it X', configured: 'steer' }, { resolveClient: answeringChoice('steer', 0.5) })).toBeNull()
  })

  it('clips a long message to the state cap', async () => {
    let seen: DecisionRequest | undefined
    const settings = normalizeDecisionLayerSettings({ enabled: true, provider: 'openrouter', features: { midTurnMessages: true } })
    const endpoint = resolveDecisionEndpoint(settings)
    const client = {
      decide: async (request: DecisionRequest): Promise<DecisionResult> => {
        seen = request
        return { model: 'jev', modelReported: true, requestedModel: 'jev', answers: {}, usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1, state: { sha256: 'x', bytes: 2, truncated: false } }
      },
    }
    await decideMidTurnDelivery({ newMessage: 'y'.repeat(10_000) }, { resolveClient: async () => ({ ok: true, value: { client: client as never, settings, provider: 'openrouter', endpoint, keySource: 'provider' } }) })
    expect((seen?.state as Record<string, string> | undefined)?.new_message?.length).toBe(MID_TURN_MAX_CHARS + 1)
  })

  it('answers null without a message at all', async () => {
    expect(await decideMidTurnDelivery({ newMessage: '  ', configured: 'steer' }, { resolveClient: answeringChoice('steer', 0.9) })).toBeNull()
  })
})

describe('isContinuation', () => {
  it('merges only when the model is confident both messages are one request (upstream case)', async () => {
    expect(await isContinuation('rename the files', 'and keep the dates', { resolveClient: answering({ same_request: { type: 'noul', noul: 0.9 } }) })).toBe(true)
    expect(await isContinuation('rename the files', 'what is the weather', { resolveClient: answering({ same_request: { type: 'noul', noul: 0.1 } }) })).toBe(false)
    // Boundary: just below the 0.75 floor keeps them apart.
    expect(await isContinuation('rename the files', 'and keep the dates', { resolveClient: answering({ same_request: { type: 'noul', noul: 0.74 } }) })).toBe(false)
  })

  it('is null without both texts, without the layer or without an answer', async () => {
    expect(await isContinuation('', 'next', { resolveClient: answering({ same_request: { type: 'noul', noul: 0.9 } }) })).toBeNull()
    expect(await isContinuation('first', '', { resolveClient: off })).toBeNull()
    expect(await isContinuation('first', 'next', { resolveClient: off })).toBeNull()
    expect(await isContinuation('first', 'next', { resolveClient: answering({}) })).toBeNull()
  })
})
