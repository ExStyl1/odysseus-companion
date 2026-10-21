import { describe, expect, it } from 'bun:test'
import {
  SAFE_MODE_COMPAT_ENV_VAR,
  SAFE_MODE_ENV_VAR,
  isSafeModeEnabled,
} from '../safe-mode.ts'

describe('isSafeModeEnabled', () => {
  it('is off when neither spelling is set', () => {
    expect(isSafeModeEnabled({})).toBe(false)
  })

  it.each(['1', 'true', 'yes', 'on', ' ON '])('accepts %p under either spelling', value => {
    expect(isSafeModeEnabled({ [SAFE_MODE_ENV_VAR]: value })).toBe(true)
    expect(isSafeModeEnabled({ [SAFE_MODE_COMPAT_ENV_VAR]: value })).toBe(true)
  })

  it.each(['0', 'false', 'no', 'off', '', 'maybe'])('rejects %p under either spelling', value => {
    expect(isSafeModeEnabled({ [SAFE_MODE_ENV_VAR]: value })).toBe(false)
    expect(isSafeModeEnabled({ [SAFE_MODE_COMPAT_ENV_VAR]: value })).toBe(false)
  })

  it('lets the Nessy name win when both are set, per the isCronDisabled precedent', () => {
    expect(isSafeModeEnabled({
      [SAFE_MODE_ENV_VAR]: '0',
      [SAFE_MODE_COMPAT_ENV_VAR]: '1',
    })).toBe(false)
    expect(isSafeModeEnabled({
      [SAFE_MODE_ENV_VAR]: '1',
      [SAFE_MODE_COMPAT_ENV_VAR]: '0',
    })).toBe(true)
  })
})
