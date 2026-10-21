/**
 * UB4.26 (R2-12 functional half; upstream v0.15.1 `MainContentPanel.tsx`) —
 * the automations fallback pane must not deny a list it sits beside.
 *
 * At HEAD the fallback rendered `automations.noAutomationsConfigured`
 * unconditionally: with automations configured and none selected, the pane read
 * "No automations configured" next to a populated list. Upstream v0.15.1 shows
 * "Select an automation" in that state. The split lives in the pure helper so
 * both arms are asserted without mounting the panel.
 */
import { describe, expect, it } from 'bun:test'
import { automationsEmptyMessageKey } from '../MainContentPanel.automations-message'

describe('automationsEmptyMessageKey', () => {
  it('names "Select an automation" when the list is not empty (the HEAD bug arm)', () => {
    expect(automationsEmptyMessageKey(2)).toBe('automations.selectAutomation')
  })

  it('keeps "No automations configured" for an empty list (control)', () => {
    expect(automationsEmptyMessageKey(0)).toBe('automations.noAutomationsConfigured')
  })

  it('treats one configured automation as a populated list (boundary)', () => {
    expect(automationsEmptyMessageKey(1)).toBe('automations.selectAutomation')
  })
})
