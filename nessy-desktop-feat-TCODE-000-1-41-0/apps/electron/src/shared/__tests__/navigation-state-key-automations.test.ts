/**
 * F1.254 (b) — `parseNavigationStateKey` returns an automation id without a leading slash.
 *
 * The automations branch sliced the 23-character `automations/automation/` prefix at 22, so
 * `automations/automation/abc` came back as automation `/abc`. Its siblings slice correctly
 * (`sources/plugins/plugin/` at 23, `sources/source/` at 15, `skills/skill/` at 13). The
 * function has no production caller today — routing goes through `parseCompoundRoute` — so
 * this is latent; upstream (craft-agents-oss v0.13.4, `apps/electron/src/shared/types.ts`,
 * Apache-2.0) slices at 23. The round trip through `getNavigationStateKey` is the pin.
 */
import { describe, expect, it } from 'bun:test'
import { getNavigationStateKey, parseNavigationStateKey } from '../types'

describe('parseNavigationStateKey — automations (F1.254 b)', () => {
  it('returns the id as written, and round-trips through getNavigationStateKey', () => {
    const state = parseNavigationStateKey('automations/automation/abc-123')
    expect(state).toEqual({ navigator: 'automations', details: { type: 'automation', automationId: 'abc-123' } })
    expect(getNavigationStateKey(state!)).toBe('automations/automation/abc-123')
  })

  it('a bare prefix is the list, not an automation named by an empty id', () => {
    expect(parseNavigationStateKey('automations/automation/')).toEqual({ navigator: 'automations', details: null })
    expect(parseNavigationStateKey('automations')).toEqual({ navigator: 'automations', details: null })
  })
})
