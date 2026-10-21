/**
 * U4 — plugin-detail component inventory grouping (pure).
 *
 * Proves the renderer-side projection of the additive `components` payload:
 *   - one group per kind, kinds mapped to the Codex-style section labels
 *     (skill / mcp / connector[source] / hook / command),
 *   - skills / sources / mcp rows are CLICKABLE (carry a capability key) → route
 *     to their own detail page,
 *   - toggleable kinds emit a `toggle` bound to the manifest capability id;
 *     sources/apps and legacy payloads (no capabilityId/enabled) stay inert,
 *   - a capability-disabled component renders dimmed with its reason key.
 *
 * Imported from the dependency-light module (not PluginInfoPage) so the test
 * never pulls the info barrel → pdfjs worker URLs bun cannot resolve.
 */

import { describe, expect, it } from 'bun:test'
import { componentKindFor, toGroups } from '../plugin-components-groups.ts'
import type { SafePluginComponent } from '@nessy-agent/shared/protocol/capabilities'

const COMPONENTS: SafePluginComponent[] = [
  { kind: 'skill', name: 'Alpha', description: 'A skill', capabilityKey: 'plug:skill:alpha' },
  { kind: 'mcp', name: 'FS', capabilityKey: 'plug:mcp:fs' },
  { kind: 'source', name: 'GitHub', capabilityKey: 'plug:source:github' },
  { kind: 'hook', name: 'pre-commit' }, // no capabilityKey → inert
]

describe('componentKindFor', () => {
  it('maps resolved kinds onto section kinds (source → connector)', () => {
    expect(componentKindFor('skill')).toBe('skill')
    expect(componentKindFor('mcp')).toBe('mcp')
    expect(componentKindFor('source')).toBe('connector')
    expect(componentKindFor('hook')).toBe('hook')
    expect(componentKindFor('command')).toBe('command')
    expect(componentKindFor('prompt-command')).toBe('command')
  })
})

describe('toGroups (U4 inventory)', () => {
  it('groups one section per kind', () => {
    const groups = toGroups(COMPONENTS)
    expect(groups.map(g => g.kind).sort()).toEqual(['connector', 'hook', 'mcp', 'skill'])
  })

  it('clickable rows carry the capability key; a keyless kind is inert', () => {
    const groups = toGroups(COMPONENTS)
    const skill = groups.find(g => g.kind === 'skill')!.items[0]!
    expect(skill.key).toBe('plug:skill:alpha')
    expect(skill.clickable).toBe(true)
    expect(skill.description).toBe('A skill')

    const hook = groups.find(g => g.kind === 'hook')!.items[0]!
    expect(hook.clickable).toBeUndefined() // no detail page → not clickable
    expect(hook.key).toBe('hook:pre-commit') // synthesized, stable
  })

  it('legacy payloads without capabilityId/enabled stay toggle-free', () => {
    for (const group of toGroups(COMPONENTS)) {
      for (const item of group.items) {
        expect(item.toggle).toBeUndefined()
      }
    }
  })

  it('emits toggles for toggleable kinds only, keyed by the manifest capability id', () => {
    const groups = toGroups([
      { kind: 'skill', name: 'Alpha', capabilityKey: 'plug:skill:alpha', capabilityId: 'c-skill', enabled: true },
      { kind: 'mcp', name: 'FS', capabilityKey: 'plug:mcp:fs', capabilityId: 'c-mcp', enabled: false, unavailableReason: 'capability-disabled' },
      { kind: 'hook', name: 'pre-commit', description: 'PostToolUse · command', capabilityId: 'c-hook', enabled: true },
      { kind: 'command', name: 'legacy command', capabilityId: 'c-command', enabled: true },
      { kind: 'prompt-command', name: 'review', capabilityId: 'c-prompt', enabled: true },
      // Connector-materialized sources and apps stay read-only.
      { kind: 'source', name: 'GitHub', capabilityKey: 'plug:source:github', capabilityId: 'c-src', enabled: true },
      { kind: 'app', name: 'Board', capabilityId: 'c-app', enabled: true },
    ], { pendingCapabilityId: 'c-hook' })

    const skill = groups.find(g => g.kind === 'skill')!.items[0]!
    expect(skill.toggle).toEqual({ capabilityId: 'c-skill', enabled: true })
    expect(skill.dimmed).toBeUndefined()

    const mcp = groups.find(g => g.kind === 'mcp')!.items[0]!
    expect(mcp.toggle).toEqual({ capabilityId: 'c-mcp', enabled: false })
    expect(mcp.dimmed).toBe(true)
    expect(mcp.disabledReasonKey).toBe('pluginDetail.componentCapabilityDisabled')

    const hook = groups.find(g => g.kind === 'hook')!.items[0]!
    expect(hook.toggle).toEqual({ capabilityId: 'c-hook', enabled: true, pending: true })
    expect(hook.description).toBe('PostToolUse · command')

    const commands = groups.find(g => g.kind === 'command')!.items
    expect(commands.find(item => item.name === 'legacy command')!.toggle).toBeUndefined()
    expect(commands.find(item => item.name === 'review')!.toggle)
      .toEqual({ capabilityId: 'c-prompt', enabled: true })

    expect(groups.find(g => g.kind === 'connector')!.items[0]!.toggle).toBeUndefined()
    expect(groups.find(g => g.kind === 'app')!.items[0]!.toggle).toBeUndefined()
  })

  it('dims a plugin-level-disabled row without naming the per-capability reason', () => {
    const groups = toGroups([
      { kind: 'skill', name: 'Alpha', capabilityId: 'c-skill', enabled: false, unavailableReason: 'policy-disabled' },
    ])
    const skill = groups.find(g => g.kind === 'skill')!.items[0]!
    expect(skill.dimmed).toBe(true)
    expect(skill.disabledReasonKey).toBeUndefined()
  })

  it('explains an unsupported runtime without exposing package or path details', () => {
    const groups = toGroups([
      { kind: 'mcp', name: 'xcodebuildmcp', enabled: false, unavailableReason: 'unsupported-runtime' },
    ])
    const mcp = groups.find(g => g.kind === 'mcp')!.items[0]!
    expect(mcp.dimmed).toBe(true)
    expect(mcp.toggle).toBeUndefined()
    expect(mcp.disabledReasonKey).toBe('pluginDetail.componentUnsupportedRuntime')
  })

  it('empty inventory → no groups (section renders its own placeholder)', () => {
    expect(toGroups([])).toEqual([])
  })
})
