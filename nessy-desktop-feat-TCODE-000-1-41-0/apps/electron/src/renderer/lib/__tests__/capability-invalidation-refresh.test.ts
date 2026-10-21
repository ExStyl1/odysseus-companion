import { describe, expect, it } from 'bun:test'
import { refreshCapabilityDependentsOnChange } from '../capability-invalidation-refresh'

describe('refreshCapabilityDependentsOnChange', () => {
  it('refreshes capability views, custom slash commands, and marketplace data for a matching event', () => {
    const calls: string[] = []

    const refreshed = refreshCapabilityDependentsOnChange(
      { workspaceId: 'workspace-a', sessionId: 'session-a' },
      { workspaceId: 'workspace-a', sessionId: 'session-a' },
      {
        refreshCapabilityViews: () => { calls.push('capabilities') },
        refreshCustomSlashCommands: () => { calls.push('slash-commands') },
        invalidateMarketplaceQueries: () => { calls.push('marketplace') },
      },
    )

    expect(refreshed).toBe(true)
    expect(calls).toEqual(['capabilities', 'slash-commands', 'marketplace'])
  })

  it('ignores changes for another workspace or explicitly targeted session', () => {
    const calls: string[] = []
    const refreshers = {
      refreshCapabilityViews: () => { calls.push('capabilities') },
      refreshCustomSlashCommands: () => { calls.push('slash-commands') },
      invalidateMarketplaceQueries: () => { calls.push('marketplace') },
    }

    expect(refreshCapabilityDependentsOnChange(
      { workspaceId: 'workspace-b' },
      { workspaceId: 'workspace-a', sessionId: 'session-a' },
      refreshers,
    )).toBe(false)
    expect(refreshCapabilityDependentsOnChange(
      { workspaceId: 'workspace-a', sessionId: 'session-b' },
      { workspaceId: 'workspace-a', sessionId: 'session-a' },
      refreshers,
    )).toBe(false)
    expect(calls).toEqual([])
  })
})
