/**
 * P6.482 (ledger J8/claude) — the endpoint's named image refusal is written down
 * once instead of being relearned every turn.
 *
 * Owner decision Q12 of 2026-09-05 amends the 2026-08-28 ruling by one narrow
 * clause, and this file is that clause: a flag MAY be written when the endpoint
 * returns its **exact named image refusal**, stamped LEARNED rather than
 * declared and reversible in one click; **a generic 400 never writes**.
 *
 * The detector is the whole safety of the feature, so the negatives below carry
 * as much weight as the positive — each of them is a message that arrives on the
 * same code path and must leave the connection untouched.
 */
import { describe, expect, it } from 'bun:test'
import {
  isNamedImageRefusal,
  learnImageRefusal,
  modelImageRefusalSentence,
  modelSupportsImages,
  setModelSupportsImages,
  LEARNED_IMAGE_REFUSAL_MAX_CHARS,
  type LlmConnection,
} from '../llm-connections.ts'

/** The measured positive: the gateway's own named 400 (2026-08-28). */
const NAMED_REFUSAL = 'Invalid Chat Message Part: Model Does Not Support Image Inputs'

const BYO: LlmConnection = {
  slug: 'byo',
  name: 'A domain endpoint',
  providerType: 'claude-runtime',
  authType: 'api_key_with_endpoint',
  baseUrl: 'https://llm.example.internal/v1',
  customEndpoint: { api: 'openai-completions' },
  models: ['house-model'],
  createdAt: 1,
}

describe('the detector — a generic failure never writes', () => {
  it('recognises the endpoint refusal that was actually measured', () => {
    expect(isNamedImageRefusal(NAMED_REFUSAL)).toBe(true)
  })

  it.each([
    ['a bare status line', 'Bad Request'],
    ['an empty message', ''],
    ['a null message', null],
    ['a context-window message', 'This model supports a maximum context length of 8192 tokens'],
    ['a tool-schema complaint', 'Invalid schema for function "Bash": additionalProperties is not supported'],
    ['a modality word with no refusal', 'image_url part accepted'],
    ['a refusal with no modality', 'This parameter is not supported by this model'],
    // An OUTPUT capability. A model that will not draw an image may still read
    // one, so this must not gate the composer's attach control.
    ['an image-GENERATION refusal', 'This model does not support image generation'],
  ])('does not fire on %s', (_label, message) => {
    expect(isNamedImageRefusal(message)).toBe(false)
  })

  it('a generic 400 leaves the connection byte-identical', () => {
    const result = learnImageRefusal(BYO, 'house-model', 'Bad Request')
    expect(result.learned).toBe(false)
    expect(result.connection).toBe(BYO)
  })
})

describe('the write — once, stamped, and quoting the endpoint', () => {
  it('writes the flag and stores the endpoint\'s own sentence', () => {
    const { connection, learned } = learnImageRefusal(BYO, 'house-model', NAMED_REFUSAL)

    expect(learned).toBe(true)
    expect(modelSupportsImages(connection, 'house-model')).toBe(false)
    // The composer greys out quoting THIS, not a sentence of ours.
    expect(modelImageRefusalSentence(connection, 'house-model')).toBe(NAMED_REFUSAL)
  })

  it('learned and declared are distinguishable wherever the flag is shown', () => {
    const learnedConn = learnImageRefusal(BYO, 'house-model', NAMED_REFUSAL).connection
    const declaredConn = setModelSupportsImages(BYO, 'house-model', false)

    // Same answer to "can this model take an image"…
    expect(modelSupportsImages(learnedConn, 'house-model')).toBe(false)
    expect(modelSupportsImages(declaredConn, 'house-model')).toBe(false)
    // …and only one of them has a reason to show.
    expect(modelImageRefusalSentence(learnedConn, 'house-model')).toBe(NAMED_REFUSAL)
    expect(modelImageRefusalSentence(declaredConn, 'house-model')).toBeUndefined()
  })

  it('the existing toggle reverses it in one write, and un-learns the stamp', () => {
    // The ruling's "reversible in one click" needs no new code path: the vision
    // toggle already calls `setModelSupportsImages`.
    const learnedConn = learnImageRefusal(BYO, 'house-model', NAMED_REFUSAL).connection
    const reversed = setModelSupportsImages(learnedConn, 'house-model', true)

    expect(modelSupportsImages(reversed, 'house-model')).toBe(true)
    expect(modelImageRefusalSentence(reversed, 'house-model')).toBeUndefined()
  })

  it('a person\'s declaration outranks a sentence we pattern-matched', () => {
    const declaredYes = setModelSupportsImages(BYO, 'house-model', true)
    const afterRefusal = learnImageRefusal(declaredYes, 'house-model', NAMED_REFUSAL)

    expect(afterRefusal.learned).toBe(false)
    expect(modelSupportsImages(afterRefusal.connection, 'house-model')).toBe(true)
  })

  it('but a previous LEARNED stamp is not a declaration — it may be refreshed', () => {
    const first = learnImageRefusal(BYO, 'house-model', NAMED_REFUSAL).connection
    const second = learnImageRefusal(first, 'house-model', 'vision is not supported on this deployment')

    expect(second.learned).toBe(true)
    expect(modelImageRefusalSentence(second.connection, 'house-model'))
      .toBe('vision is not supported on this deployment')
  })

  it('caps a runaway endpoint message rather than storing it whole', () => {
    const shouty = `${'x '.repeat(600)}does not support image`
    const { connection, learned } = learnImageRefusal(BYO, 'house-model', shouty)

    expect(learned).toBe(true)
    expect(modelImageRefusalSentence(connection, 'house-model')!.length)
      .toBe(LEARNED_IMAGE_REFUSAL_MAX_CHARS)
  })

  it('a model this connection does not list is never invented', () => {
    const result = learnImageRefusal(BYO, 'some-other-model', NAMED_REFUSAL)
    expect(result.learned).toBe(false)
    expect(result.connection).toBe(BYO)
  })
})
