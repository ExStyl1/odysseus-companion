import { describe, expect, it } from 'bun:test'
import { buildRuntimeResourceRows, canRevealResourceRow, firstSelectableRowId } from '../runtime-resource-rows'
import { capabilityDisplayName } from '../capability-catalog'
import type { SafeCapabilitySummary } from '@nessy-agent/shared/protocol/capabilities'

describe('runtime resource rows', () => {
  const capabilities = [
    capability('source-api', 'source', 'api'),
    capability('source-mcp', 'mcp', 'mcp', 'plugin'),
    capability('source-local', 'source', 'local'),
    capability('skill-one', 'skill'),
  ]

  it('keeps native and plugin capabilities in one safe catalog order', () => {
    const rows = buildRuntimeResourceRows({ capabilities })
    expect(rows.map(row => row.kind)).toEqual(['source', 'source', 'source', 'skill'])
    expect(rows.every(row => 'item' in row)).toBe(true)
    expect(JSON.stringify(rows)).not.toMatch(/folderPath|sourcePath|command/)
  })

  it('filters by path-free source subtype', () => {
    expect(buildRuntimeResourceRows({ capabilities, filter: { kind: 'type', sourceType: 'mcp' } }).map(row => row.item.key)).toEqual(['source-mcp'])
    expect(buildRuntimeResourceRows({ capabilities, filter: { kind: 'type', sourceType: 'local' } }).map(row => row.item.key)).toEqual(['source-local'])
  })

  it('uses route-safe IDs for auto-selection', () => {
    const rows = buildRuntimeResourceRows({ capabilities: [capability('native/source:one', 'source', 'api')] })
    expect(firstSelectableRowId(rows)).toBe('native%2Fsource%3Aone')
  })

  it('prefers mention labels, then safe display names, then logical names', () => {
    const source = capability('source', 'source', 'api')
    source.displayName = 'Source Display'
    source.mention = {
      type: 'source',
      id: 'source',
      qualifiedId: source.key,
      selectedAsShortAlias: true,
      label: 'Source Mention',
    }
    const mcp = capability('mcp', 'mcp', 'mcp')
    mcp.displayName = 'MCP Display'

    expect(capabilityDisplayName(source)).toBe('Source Mention')
    expect(capabilityDisplayName(mcp)).toBe('MCP Display')
    expect(capabilityDisplayName(capability('plain', 'skill'))).toBe('plain')
  })

  it('enables Show-in-Finder for a file-backed row, disables it for a catalog-only/non-file one', () => {
    const rows = buildRuntimeResourceRows({
      capabilities: [
        capability('source-api', 'source', 'api'),
        { ...capability('source-deferred', 'source', 'api'), state: 'unsupported-runtime', unavailableReason: 'unsupported-runtime' },
      ],
    })
    expect(rows.map(row => ({ key: row.item.key, canReveal: canRevealResourceRow(row) }))).toEqual([
      { key: 'source-api', canReveal: true },
      { key: 'source-deferred', canReveal: false },
    ])
  })
})

function capability(
  key: string,
  kind: SafeCapabilitySummary['kind'],
  sourceType?: 'api' | 'mcp' | 'local',
  origin: SafeCapabilitySummary['origin'] = 'native',
): SafeCapabilitySummary {
  return {
    key,
    kind,
    logicalName: key,
    ...(sourceType ? { sourceType } : {}),
    origin,
    scope: { kind: 'workspace', workspaceId: 'ws-1' },
    state: 'active',
    readOnly: origin === 'plugin',
    trustState: 'not-required',
    credentialState: 'not-required',
    selectedAsUnqualifiedAlias: true,
    diagnosticCodes: [],
  }
}
