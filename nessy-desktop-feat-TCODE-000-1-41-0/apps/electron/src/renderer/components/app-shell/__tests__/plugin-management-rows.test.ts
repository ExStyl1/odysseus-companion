/**
 * U4 — Plugins subsection row projection (pure).
 *
 * Proves the plugins subsection maps installed plugins onto management rows:
 *   - one row per installed plugin (empty → empty list → the panel's honest
 *     empty-state placeholder),
 *   - the row dims iff the plugin is not effectively active,
 *   - per-scope activation is carried through for the menu labels,
 *   - the row summary is path-free and plugin-origin.
 *
 * Dependency-light (no info barrel / pdfjs / React).
 */

import { describe, expect, it } from 'bun:test'
import {
  buildPluginRowProjections,
  pluginRowProjection,
} from '../plugin-management-rows.ts'
import type { SafeInstalledPluginSummary } from '@nessy-agent/shared/protocol/capabilities'

function installed(over: Partial<SafeInstalledPluginSummary> = {}): SafeInstalledPluginSummary {
  return {
    pluginKey: 'pk-1',
    activeInstanceId: 'inst-1',
    origin: { marketplaceId: 'm', pluginId: 'p' },
    presentation: { format: 'nessy', acquisition: 'nessy-marketplace' },
    name: 'Plugin P',
    version: '1.0.0',
    installedAt: 1000,
    lifecycleState: 'ready',
    capabilityKinds: ['skill', 'mcp'],
    activation: { effective: 'active', global: 'unset', workspace: 'enabled' },
    actions: { canEnable: true, canDisable: true, canUpdate: false, canRepair: false, canUninstall: true, reasonCodes: [] },
    ...over,
  }
}

describe('pluginRowProjection (U4 plugins subsection)', () => {
  it('active plugin → enabled row, plugin-origin summary, plugin badge kind', () => {
    const row = pluginRowProjection(installed())
    expect(row.id).toBe('pk-1')
    expect(row.enabled).toBe(true)
    expect(row.workspaceEnabled).toBe(true)
    expect(row.projectEnabled).toBe(false)
    expect(row.summary.origin).toBe('plugin')
    expect(row.summary.kind).toBe('app')
    expect(row.summary.presentation).toEqual({ format: 'nessy', acquisition: 'nessy-marketplace' })
  })

  it('inactive plugin → row not enabled (the row dims)', () => {
    const row = pluginRowProjection(installed({
      activation: { effective: 'inactive', global: 'unset', workspace: 'disabled' },
    }))
    expect(row.enabled).toBe(false)
    expect(row.workspaceEnabled).toBe(false)
  })

  it('project-enabled plugin carries the project scope through', () => {
    const row = pluginRowProjection(installed({
      activation: { effective: 'active', global: 'unset', workspace: 'unset', project: 'enabled' },
    }))
    expect(row.projectEnabled).toBe(true)
  })

  it('the summary carries no path/hash (safe management identity)', () => {
    const json = JSON.stringify(pluginRowProjection(installed()).summary)
    expect(json).not.toMatch(/Root|Path|hash|cache/i)
  })
})

describe('buildPluginRowProjections (list ↔ empty state)', () => {
  it('one projection per installed plugin', () => {
    const rows = buildPluginRowProjections([
      installed({ pluginKey: 'a', name: 'A' }),
      installed({ pluginKey: 'b', name: 'B' }),
    ])
    expect(rows.map(r => r.id)).toEqual(['a', 'b'])
  })

  it('empty install set → empty list (the panel renders its empty-state)', () => {
    expect(buildPluginRowProjections([])).toEqual([])
  })
})
