import { describe, expect, it } from 'bun:test'
import {
  clearDomSelection,
  restoreDomSelection,
  scheduleDomSelectionRestore,
} from '../selection-restore'

describe('selection restore helpers', () => {
  it('returns false when selection is missing', () => {
    const restored = restoreDomSelection({} as HTMLElement, null)
    expect(restored).toBe(false)
  })

  // RELABELLED, not strengthened. `not.toThrow()` cannot see a no-op: a helper
  // that scheduled a restore against a null ref would satisfy it just as well.
  // Proving the no-op needs a scheduler seam these helpers do not expose (they
  // read the ambient `window`), so the names now claim only what is checked.
  it('does not throw when scheduled restore has no selection', () => {
    expect(() => scheduleDomSelectionRestore({ current: null }, null)).not.toThrow()
  })

  it('does not throw when scheduled restore runs without window', () => {
    expect(() => scheduleDomSelectionRestore({ current: null }, { start: 1, end: 2 })).not.toThrow()
  })

  it('clearDomSelection is safe in non-DOM test environments', () => {
    expect(() => clearDomSelection()).not.toThrow()
  })
})
