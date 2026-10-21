/**
 * Truth table for `derivePickerMode`.
 *
 * The helper used to decide between FOUR layouts, one of which (`switcher`)
 * was a hierarchical connection → model tree. That tree is what made one tap
 * change both the integration and the model, and it is why "did you mean to
 * change runtime?" had to be inferred from where the tap landed. The
 * integration is now its own control (`ConnectionRow`) above the model list,
 * so this helper decides only how the MODEL list renders — and the whole
 * `isEmptySession` / `connectionCount` precedence problem (#727) stops
 * existing rather than being worked around.
 */

import { describe, test, expect } from 'bun:test'
import { derivePickerMode, type PickerModeInput } from '../picker-mode'

function input(overrides: Partial<PickerModeInput> = {}): PickerModeInput {
  return {
    connectionUnavailable: false,
    connectionDefaultModel: null,
    ...overrides,
  }
}

describe('derivePickerMode', () => {
  test('puts an unavailable connection first', () => {
    expect(derivePickerMode(input({ connectionUnavailable: true, connectionDefaultModel: 'm' })))
      .toBe('unavailable')
  })

  test('renders a single-model connection as a label, not a list', () => {
    expect(derivePickerMode(input({ connectionDefaultModel: 'mistral-7b' }))).toBe('locked-single')
  })

  test("renders the active connection's models otherwise", () => {
    expect(derivePickerMode(input())).toBe('flat')
  })

  // Regression guard for #727. A user whose only connection was a single-model
  // `pi_compat` used to be unreachable by the switcher, because `switcher` and
  // `locked-single` competed for precedence and the ordering had been wrong
  // once already. With the integration row always present there is nothing to
  // compete with: the same input now has ONE answer regardless of how many
  // connections exist or whether the session has started.
  test('no longer depends on the session or on how many connections exist', () => {
    expect(derivePickerMode(input({ connectionDefaultModel: 'mistral-7b' }))).toBe('locked-single')
    expect(derivePickerMode(input({ connectionDefaultModel: null }))).toBe('flat')
  })

  // Negative subject for the precedence: `unavailable` must NOT swallow the
  // ordinary case. Without this, a helper that returned 'unavailable'
  // unconditionally would pass the first test.
  test('does not report unavailable when the connection is fine', () => {
    expect(derivePickerMode(input({ connectionUnavailable: false, connectionDefaultModel: 'm' })))
      .not.toBe('unavailable')
  })
})
