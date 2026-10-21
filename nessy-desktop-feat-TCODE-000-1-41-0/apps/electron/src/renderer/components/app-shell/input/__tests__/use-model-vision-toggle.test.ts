/**
 * P3.365 — the vision toggle reported success while writing nothing.
 *
 * `setModelSupportsImages` has two bare returns (`!connection.models` and
 * `idx === -1`) and both hand back the INPUT REFERENCE; the hook saved and took
 * the success branch regardless. The flag decides whether images reach the
 * model at all, and on `pi_compat` an undeclared model defaults to
 * `supportsImages: false` — so the exact condition that renders the toggle OFF
 * and raises the image-support banner is the condition that makes the write a
 * no-op. Stuck off forever, no toast, no log.
 *
 * The repo has no renderHook/DOM lib, so the load-bearing decision is exported
 * pure and tested directly (the established pattern for renderer hooks — see
 * `hooks/__tests__/usePluginEnablement.test.ts`). What is pinned here is the
 * DISCRIMINATOR, because that is the part a later edit can quietly break: a
 * value comparison would call a same-value re-toggle a no-op, and dropping the
 * check restores the silent failure.
 */

import { describe, expect, it } from 'bun:test'
import { resolveVisionToggle } from '../useModelVisionToggle.ts'
import { modelSupportsImages, type LlmConnection } from '@nessy-agent/shared/config/llm-connections'

function connection(models?: unknown): LlmConnection {
  return {
    slug: 'byo-1',
    name: 'BYO',
    providerType: 'pi_compat',
    ...(models === undefined ? {} : { models }),
  } as unknown as LlmConnection
}

describe('resolveVisionToggle — the no-op arms P3.365 is about', () => {
  it('a connection declaring no models at all is a no-op, not a success', () => {
    // Reachable structurally: `connectionDefaultModel` is non-null exactly when
    // `models` is absent or has one entry, and both `LockedSingleRow` and the
    // desktop locked-single branch render against it.
    expect(resolveVisionToggle(connection(), 'm-1', true)).toEqual({ kind: 'no-op' })
  })

  it('a model id that is not on the connection is a no-op, not a success', () => {
    // The sharpest writer is the image-warning banner's onEnable, which passes
    // the SESSION's model id — nothing checks it against the list first, and
    // `llmConnections.SAVE` skips `validateModelList`.
    expect(resolveVisionToggle(connection(['other-model']), 'm-1', true)).toEqual({ kind: 'no-op' })
  })

  it('an empty models array is a no-op too', () => {
    expect(resolveVisionToggle(connection([]), 'm-1', true)).toEqual({ kind: 'no-op' })
  })
})

describe('resolveVisionToggle — the write arms', () => {
  it('promotes a string entry and reports a write carrying the new connection', () => {
    const before = connection(['m-1'])
    const outcome = resolveVisionToggle(before, 'm-1', true)
    expect(outcome.kind).toBe('write')
    if (outcome.kind !== 'write') throw new Error('unreachable')
    expect(modelSupportsImages(outcome.connection, 'm-1')).toBe(true)
    // Pure: the connection the caller held is untouched, so a failed save
    // cannot leave a half-applied override in the renderer's state.
    expect(before.models).toEqual(['m-1'] as never)
  })

  it('updates an object entry and can turn the flag back OFF', () => {
    const before = connection([{ id: 'm-1', name: 'M1', supportsImages: true }])
    const outcome = resolveVisionToggle(before, 'm-1', false)
    expect(outcome.kind).toBe('write')
    if (outcome.kind !== 'write') throw new Error('unreachable')
    expect(modelSupportsImages(outcome.connection, 'm-1')).toBe(false)
  })

  it('setting the value it already has is a WRITE, not a no-op', () => {
    // The boundary that rules out a value/deep-equality discriminator: this
    // connection deep-equals its input and the user's action did land.
    const before = connection([{ id: 'm-1', name: 'M1', supportsImages: true }])
    const outcome = resolveVisionToggle(before, 'm-1', true)
    expect(outcome.kind).toBe('write')
    if (outcome.kind !== 'write') throw new Error('unreachable')
    expect(outcome.connection).not.toBe(before)
    expect(outcome.connection).toEqual(before)
  })
})

describe('the discriminator itself', () => {
  it('identity separates the two no-op arms from every write arm, on one rig', () => {
    // The positive control sits in the same assertion as the two negatives, so
    // a rig that classified everything as a no-op could not pass it.
    const noModels = connection()
    const wrongId = connection(['other-model'])
    const present = connection(['m-1'])
    expect([
      resolveVisionToggle(noModels, 'm-1', true).kind,
      resolveVisionToggle(wrongId, 'm-1', true).kind,
      resolveVisionToggle(present, 'm-1', true).kind,
    ]).toEqual(['no-op', 'no-op', 'write'])
  })
})
