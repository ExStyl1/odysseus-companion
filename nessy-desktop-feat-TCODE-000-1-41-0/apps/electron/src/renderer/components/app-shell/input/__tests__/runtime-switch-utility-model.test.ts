/**
 * P3.70 · the pre-switch dialog reports the side model a switch re-resolves.
 *
 * The row: *"the utility model is a per-connection field a switch silently
 * re-resolves"* — only the MAIN model was reported at switch time, so a user
 * who chose a cheap side model neither kept it nor heard about it.
 *
 * What is worth driving here is not the happy path but the three SILENCES: a
 * rule that decides when NOT to speak is the kind that rots unobserved, and two
 * of the three are refusals to make a claim that would be FALSE rather than
 * merely noisy.
 */
import { describe, expect, it } from 'bun:test'
import {
  resolveUtilityModel,
  resolveUtilityModelChange,
  type UtilityModelConnection,
} from '../runtime-switch-utility-model'

/** A connection whose side model is decided by the heuristic, not by a field. */
function connection(overrides: Partial<UtilityModelConnection> = {}): UtilityModelConnection {
  return {
    providerType: 'pi',
    models: ['pi/qwen-big', 'pi/qwen-mini'],
    defaultModel: 'pi/qwen-big',
    ...overrides,
  } as UtilityModelConnection
}

describe('P3.70 · the side model a switch re-resolves', () => {
  it('reads the host expression: the explicit field first, the heuristic next, the default last', () => {
    // Not a restatement of `getMiniModel` — the point is that this surface asks
    // it rather than deriving a second answer, and that the `?? defaultModel`
    // tail is present, because every backend call site reads it that way.
    expect(resolveUtilityModel(connection({ miniModel: 'pi/cheap-one' }))).toBe('pi/cheap-one')
    expect(resolveUtilityModel(connection())).toBe('pi/qwen-mini')
    expect(resolveUtilityModel(connection({ models: ['pi/only-one'], defaultModel: 'pi/only-one' })))
      .toBe('pi/only-one')
  })

  it('names both ends when the two connections resolve differently', () => {
    const change = resolveUtilityModelChange(
      connection({ miniModel: 'pi/cheap-one' }),
      connection({ miniModel: 'anthropic/haiku' }),
    )

    expect(change).toEqual({ from: 'pi/cheap-one', to: 'anthropic/haiku' })
  })

  it('says nothing when the two ends agree', () => {
    // The common case: all three gateway cards are seeded from one catalogue.
    // A dialog that announces a change that is not one teaches the user to skip
    // the dialog.
    expect(resolveUtilityModelChange(connection(), connection())).toBeNull()
    expect(resolveUtilityModelChange(
      connection({ miniModel: 'pi/same' }),
      connection({ miniModel: 'pi/same' }),
    )).toBeNull()
  })

  it('says nothing when EITHER end does not resolve', () => {
    // A line naming `undefined` on one side reads as "your side model was
    // removed" — a different claim, and a false one. Both directions, because a
    // guard written for one end is how half of this class of bug survives.
    const unresolvable = { providerType: 'pi', models: [] } as unknown as UtilityModelConnection

    expect(resolveUtilityModelChange(unresolvable, connection())).toBeNull()
    expect(resolveUtilityModelChange(connection(), unresolvable)).toBeNull()
    // Positive control on the same rig: the resolvable pair still speaks.
    expect(resolveUtilityModelChange(connection({ miniModel: 'pi/a' }), connection({ miniModel: 'pi/b' })))
      .not.toBeNull()
  })

  it('says nothing when there is no source connection', () => {
    // The first integration a session picks changes nothing away from anything.
    expect(resolveUtilityModelChange(null, connection())).toBeNull()
    expect(resolveUtilityModelChange(undefined, connection())).toBeNull()
  })
})
