import { describe, expect, it } from 'bun:test'
import * as constants from './constants.ts'
import { THINKING_TO_PI } from './constants.ts'
import { getPiToolBinding } from '../../pi-harness/harness-tool-descriptor.ts'

describe('THINKING_TO_PI', () => {
  it('maps xhigh to Pi xhigh natively', () => {
    expect(THINKING_TO_PI.xhigh).toBe('xhigh')
  })

  /**
   * This test used to read "saturates Nessy max to Pi xhigh (Pi has no higher
   * tier)" and it PINNED A HOST CAP as if it were an SDK limit. Measured against
   * the installed `@earendil-works/pi-agent-core` 0.84.2, and re-measured
   * unchanged at 0.84.3 (W11-pi, 2026-09-11), `ThinkingLevel`
   * includes `max` and `pi-ai`'s `clampThinkingLevel` narrows per model — so the
   * saturation was overriding Pi's own table on every model that supports `max`.
   */
  it('sends Nessy max to Pi as max, leaving the narrowing to Pi', () => {
    expect(THINKING_TO_PI.max).toBe('max')
  })

  it('is an identity map, so a level can never be quietly demoted on the way in', () => {
    // The discriminating half: a per-key table would still pass the four
    // assertions around it while collapsing two levels onto one. Six distinct
    // Nessy levels must produce six distinct Pi levels.
    const emitted = Object.values(THINKING_TO_PI)
    expect(new Set(emitted).size).toBe(emitted.length)
    for (const [nessyLevel, piLevel] of Object.entries(THINKING_TO_PI)) {
      expect(piLevel).toBe(nessyLevel as typeof piLevel)
    }
  })

  it('passes lower tiers through unchanged', () => {
    expect(THINKING_TO_PI.off).toBe('off')
    expect(THINKING_TO_PI.low).toBe('low')
    expect(THINKING_TO_PI.medium).toBe('medium')
    expect(THINKING_TO_PI.high).toBe('high')
  })
})

describe('Pi tool identity authority', () => {
  it('uses the versioned descriptor registry instead of a name-map export', () => {
    expect('PI_TOOL_NAME_MAP' in constants).toBe(false)
    expect(getPiToolBinding('find').permissionName).toBe('Find')
    expect(getPiToolBinding('bash_background').permissionName).toBe('Bash')
  })
})
