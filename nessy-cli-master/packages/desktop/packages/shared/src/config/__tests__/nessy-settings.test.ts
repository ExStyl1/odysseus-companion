import { describe, expect, it } from 'bun:test'
import { normalizeNessyMemorySettings } from '../nessy-settings.ts'

describe('Nessy memory settings', () => {
  it('defaults missing memory settings', () => {
    expect(normalizeNessyMemorySettings(undefined)).toEqual({
      enableManagedAutoMemory: true,
      enableManagedAutoDream: false,
      enableAutoSkill: false,
    })
  })

  it('keeps boolean values and ignores non-boolean values', () => {
    expect(
      normalizeNessyMemorySettings({
        enableManagedAutoMemory: false,
        enableManagedAutoDream: 'yes',
        enableAutoSkill: true,
      }),
    ).toEqual({
      enableManagedAutoMemory: false,
      enableManagedAutoDream: false,
      enableAutoSkill: true,
    })
  })
})
