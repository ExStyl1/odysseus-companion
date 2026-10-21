import { describe, expect, it } from 'bun:test'
import {
  IMAGE_REFUSAL_DETAIL_PREFIX,
  setModelSupportsImages,
  type LlmConnection,
} from '@config/llm-connections'
import { mapClaudeSdkAssistantError } from '@nessy-agent/shared/agent/claude-sdk-error-mapper'
import { resolveLearnImageRefusal } from '../useLearnImageRefusal'
import { resolveStagedImagePolicy } from '../attachment-capability'

/**
 * P6.584 — the learned image-refusal writer, end to end over the seam it was
 * missing.
 *
 * The measured positive is the gateway's own named 400 of 2026-08-28,
 * `Invalid Chat Message Part: Model Does Not Support Image Inputs`; the
 * negative that must never write is a bare `Bad Request`. Both are exercised
 * through the REAL mapper rather than a hand-written details array, because the
 * anchored detail line is the whole channel between the two halves and a test
 * that fabricates it would pass with the seam removed.
 */
const GATEWAY_IMAGE_REFUSAL = 'Invalid Chat Message Part: Model Does Not Support Image Inputs'

const BYO: LlmConnection = {
  slug: 'byo',
  name: 'BYO',
  providerType: 'claude-runtime',
  models: [{ id: 'house-model', name: 'house-model', shortName: 'house' }],
} as unknown as LlmConnection

const detailsFor = (message: string | null) => mapClaudeSdkAssistantError('invalid_request', {
  actualError: null,
  capturedApiError: message === null
    ? null
    : { status: 400, statusText: 'Bad Request', message, timestamp: 1 },
  providerType: 'claude-runtime',
  claudeRuntimeUpstreamKind: 'nestor',
  userTurnHadAttachments: true,
}).details

describe('the turn-error seam anchors a named image refusal', () => {
  it('writes the LEARNED flag once from the endpoint\'s own sentence', () => {
    const details = detailsFor(GATEWAY_IMAGE_REFUSAL)
    expect(details?.some(d => d.startsWith(IMAGE_REFUSAL_DETAIL_PREFIX))).toBe(true)
    // The sentence is anchored INSTEAD of the generic prefix, not beside it —
    // the panel must not print one sentence twice.
    expect(details?.some(d => d.startsWith('API message: '))).toBe(false)

    const first = resolveLearnImageRefusal(BYO, 'house-model', details)
    expect(first.kind).toBe('write')
    if (first.kind !== 'write') throw new Error('unreachable')
    expect(first.sentence).toBe(GATEWAY_IMAGE_REFUSAL)

    // ONCE: the same refusal against the connection that already stores it is a
    // skip, so a repeating turn does not round-trip storage every time.
    expect(resolveLearnImageRefusal(first.connection, 'house-model', details).kind).toBe('skip')

    // The banner quotes what was stored.
    expect(resolveStagedImagePolicy({
      hasStagedImages: true,
      images: 'no',
      providerType: 'claude-runtime',
      connection: first.connection,
      modelId: 'house-model',
    }).refusalSentence).toBe(GATEWAY_IMAGE_REFUSAL)

    // Reversible through the EXISTING P3.136 toggle and no other path: the
    // toggle's ordinary write carries no `learnedFrom`, which clears the stamp.
    const reversed = setModelSupportsImages(first.connection, 'house-model', true)
    expect(resolveStagedImagePolicy({
      hasStagedImages: true,
      images: 'no',
      providerType: 'claude-runtime',
      connection: reversed,
      modelId: 'house-model',
    }).refusalSentence).toBeUndefined()
  })

  it('negative — a generic 400 anchors nothing and learns nothing', () => {
    const details = detailsFor('Bad Request')
    expect(details?.some(d => d.startsWith(IMAGE_REFUSAL_DETAIL_PREFIX))).toBe(false)
    expect(resolveLearnImageRefusal(BYO, 'house-model', details).kind).toBe('skip')
  })

  it('negative — an explicit declaration outranks the endpoint\'s sentence', () => {
    const declared = setModelSupportsImages(BYO, 'house-model', true)
    expect(resolveLearnImageRefusal(declared, 'house-model', detailsFor(GATEWAY_IMAGE_REFUSAL)).kind)
      .toBe('skip')
  })
})
