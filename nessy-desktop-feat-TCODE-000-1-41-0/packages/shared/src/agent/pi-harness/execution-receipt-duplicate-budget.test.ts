/**
 * P2.391 — a failing tool result was charged TWICE against one byte budget, so
 * failures received half the cap successes received.
 *
 * `LocalToolRuntime`'s `result(content, isError)` helper sets `error: content`
 * — literally the same string — for every failure it builds, and
 * `boundExecutionResult` summed both into `originalBytes` and then split the
 * remaining budget in half between them. The half a failure lost was its TAIL,
 * which is the half a failure's reader needs, and which
 * `config/bash-output-limits.ts` had just spent a row (P2.355/P2.366) shaping a
 * head-and-tail excerpt to preserve.
 *
 * ## The two units, and why the collision is not hypothetical
 *
 * `tools-reference.md#output-limits` states the failure excerpt in CHARACTERS
 * ("Inline up to roughly 10,000 characters"); this cap counts BYTES. A
 * 10,000-character Cyrillic excerpt is ~20,000 bytes, and `tool-executor.ts`
 * halves `DEFAULT_TOOL_RESULT_MAX_BYTES` again whenever `reason` duplicates the
 * result — so the excerpt met a ~16 KiB budget, was head-cut, and lost the tail.
 * The first test below measures exactly that arithmetic rather than asserting
 * it.
 *
 * ## What did NOT change
 *
 * The ceiling on DISTINCT payload. A result whose `error` differs from its
 * `content` still splits the budget and still totals at most `maxBytes`, and
 * that is pinned here as the control — without it, "the duplicate case got
 * bigger" is indistinguishable from "the bound stopped working".
 *
 * SAFETY: every value here is a string handed to a pure function. Nothing in
 * this file spawns, opens, creates or deletes anything.
 */
import { describe, expect, it } from 'bun:test'

import { boundExecutionResult } from './execution-receipt.ts'
import { BASH_FAILURE_INLINE_CHARS } from '../../config/bash-output-limits.ts'
import { DEFAULT_TOOL_RESULT_MAX_BYTES } from './tool-executor.ts'

const bytes = (value: string) => new TextEncoder().encode(value).byteLength

/** Total serialized weight of a receipt's payload fields, duplicates counted once. */
function distinctBytes(result: { content: string; error?: string; structuredContent?: unknown }): number {
  const errorBytes = result.error === undefined || result.error === result.content
    ? 0
    : bytes(result.error)
  return bytes(result.content)
    + errorBytes
    + (result.structuredContent ? bytes(JSON.stringify(result.structuredContent)) : 0)
}

describe('a duplicated payload is budgeted once', () => {
  it('gives a duplicate-payload failure the whole text budget, tail included', () => {
    const payload = `HEAD${'x'.repeat(400)}TAIL`
    const bounded = boundExecutionResult({ content: payload, error: payload, isError: true }, 256)

    expect(bounded.content).toContain('HEAD')
    expect(bounded.error).toBe(bounded.content)
    // The whole point: with the payload charged once, 256 bytes of budget buy
    // 256 bytes of message rather than 128.
    expect(bytes(bounded.content)).toBeGreaterThan(128)
    expect(distinctBytes(bounded)).toBeLessThanOrEqual(256)
  })

  it('THE CONTROL: a DISTINCT error still splits the budget and still totals under the cap', () => {
    // Without this, the row above passes just as well if the bound were deleted.
    const content = `C${'c'.repeat(400)}`
    const error = `E${'e'.repeat(400)}`
    const bounded = boundExecutionResult({ content, error, isError: true }, 256)

    expect(bounded.error).not.toBe(bounded.content)
    expect(bounded.content.startsWith('C')).toBe(true)
    expect(bounded.error?.startsWith('E')).toBe(true)
    expect(bytes(bounded.content) + bytes(bounded.error ?? '')).toBeLessThanOrEqual(256)
    // Both halves are genuinely bounded, so neither got the whole budget.
    expect(bytes(bounded.content)).toBeLessThan(256)
    expect(bytes(bounded.error ?? '')).toBeLessThan(256)
  })

  it('a result already under the cap is returned untouched, duplicate or not', () => {
    const small = { content: 'ok', error: 'ok', isError: true }
    expect(boundExecutionResult(small, 256)).toMatchObject({ content: 'ok', error: 'ok' })
    // And the duplicate is not what let it through: the same payload twice would
    // have exceeded a cap sized between one and two copies, under the old rule.
    const eleven = 'x'.repeat(11)
    expect(boundExecutionResult({ content: eleven, error: eleven, isError: true }, 16).content).toBe(eleven)
  })

  it('every `error ?? content` reader is served the same bytes', () => {
    // Measured consumer census (P2.391): `runtime-backed-tools.ts`,
    // `tool-wrapper.ts` and `nestor-cloud/tool-executor.ts` each read
    // `reason ?? error ?? content` — one of the two, never both. A duplicate
    // must therefore stay a duplicate AFTER bounding, or two readers of the
    // same receipt would see different messages.
    const payload = `HEAD${'y'.repeat(2_000)}TAIL`
    const bounded = boundExecutionResult({ content: payload, error: payload, isError: true }, 300)
    expect(bounded.error ?? bounded.content).toBe(bounded.content)
  })
})

describe('the arithmetic that made this reachable, measured rather than asserted', () => {
  it('a documented 10,000-CHARACTER failure excerpt in Cyrillic exceeds the halved BYTE budget', () => {
    // `tools-reference.md#output-limits`: "Inline up to roughly 10,000
    // characters; past that, a head-and-tail excerpt of that size cut from the
    // read-back window, with no file path".
    const excerpt = 'я'.repeat(BASH_FAILURE_INLINE_CHARS)
    const halvedForDuplicateReason = Math.floor(DEFAULT_TOOL_RESULT_MAX_BYTES / 2)

    expect(excerpt).toHaveLength(10_000)
    expect(bytes(excerpt)).toBe(20_000)
    // The old rule: that 32 KiB was split in half again between `content` and
    // `error`, so the excerpt met ~16 KiB and lost its tail.
    expect(bytes(excerpt)).toBeGreaterThan(Math.floor(halvedForDuplicateReason / 2))

    const bounded = boundExecutionResult(
      { content: excerpt, error: excerpt, isError: true },
      halvedForDuplicateReason,
    )
    // Now it survives whole — the tail the excerpt exists to carry included.
    expect(bounded.content).toBe(excerpt)
    expect(bounded.structuredContent).toBeUndefined()
  })
})
