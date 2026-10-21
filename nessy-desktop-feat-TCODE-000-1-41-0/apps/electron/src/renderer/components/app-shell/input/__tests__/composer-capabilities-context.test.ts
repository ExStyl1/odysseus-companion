import { describe, expect, it } from 'bun:test'
import { PERMISSION_MODE_ORDER } from '@nessy-agent/shared/agent/modes'
import { DEFAULT_COMPOSER_CAPABILITIES } from '../composer-capabilities-context'

describe('DEFAULT_COMPOSER_CAPABILITIES', () => {
  it('exposes every permission mode by default', () => {
    expect(DEFAULT_COMPOSER_CAPABILITIES.permissions.modes).toEqual(PERMISSION_MODE_ORDER)
    expect(DEFAULT_COMPOSER_CAPABILITIES.contextUsage).toEqual({
      kind: 'unavailable',
      reason: 'unknown',
      refresh: false,
    })
  })
})
