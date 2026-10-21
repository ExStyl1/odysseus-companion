/**
 * N2 — a wire-name mismatch drops the tool, not the session.
 *
 * Field incident 2026-08-10: a marketplace plugin's MCP server collided by
 * name with a built-in dp server, so the seed carried the same wireName
 * twice and every chat turn threw `Pi execution manifest MCP wireName must
 * resolve exactly once: t-tracker` — the whole session died on one bad tool.
 *
 * Only the wire-name RESOLUTION paths degrade here (dedupe at seed build,
 * drop at dynamic-tool resolution). The schema-version and provenance-capture
 * throws in `resolveDynamicTool` are host-authored integrity checks and stay
 * fatal — see `harness-manifest.test.ts`'s
 * "fails closed on collisions, schema gaps and invalid orchestrator values"
 * and "rejects dynamic provenance outside the captured snapshot generation".
 */
import { describe, expect, test } from 'bun:test'

import type { EffectiveCapabilitySnapshot } from '../../../capabilities/resolver.ts'
import type { AgentRuntimeView } from '../../../capabilities/views.ts'
import {
  createPiExecutionManifestSeed,
  finalizePiExecutionManifest,
  tryParsePiDynamicMcpBindingName,
} from '../harness-manifest.ts'

const sessionKey = { workspaceId: 'ws', sessionId: 's1' }
const generation = 'generation-1'

/**
 * Builds a real, structurally valid seed input for the given mcp servers —
 * copying the required-field shapes from the production-path test
 * (`packages/pi-agent-server/src/harness/live-manifest-contract.test.ts:62-90`)
 * rather than inventing a partial fixture. Each server also gets a matching
 * `snapshot.entries` row, because `createPiExecutionManifestSeed` only
 * carries a capability into `seed.provenance` when its key is BOTH in the
 * view (`view.mcpServers[].key`) AND in the snapshot's resolved entries
 * (`snapshot.entries[].summary.key`) — the seed's `provenance` is what
 * `resolveDynamicTool`'s (deliberately kept) provenance-capture throw checks
 * against, so a dynamic tool that's supposed to resolve needs both.
 */
function seedInput(mcpServers: { key: string; wireName: string }[]) {
  const view: AgentRuntimeView = {
    generation,
    sources: [],
    skills: [],
    mcpServers: mcpServers.map(server => ({
      key: server.key,
      wireName: server.wireName,
      logicalName: server.wireName,
      definition: { type: 'stdio', command: 'noop' },
    })),
    hooks: [],
    automations: [],
    agents: [],
    promptLayers: [],
    memory: [],
    permissionLayers: [],
    commands: [],
    promptCommands: [],
    apps: [],
  }
  const snapshot = {
    context: {
      workspaceId: sessionKey.workspaceId,
      sessionId: sessionKey.sessionId,
      projectTrustState: 'none',
      projectTrustRevision: '',
    },
    generation,
    leaseId: 'lease-1',
    entries: mcpServers.map(server => ({
      summary: {
        key: server.key,
        kind: 'mcp' as const,
        logicalName: server.key,
        origin: 'native' as const,
        scope: { kind: 'workspace' as const, workspaceId: sessionKey.workspaceId },
        enabled: true,
        selectedAsUnqualifiedAlias: false,
        readOnly: false,
        trustState: 'not-required' as const,
        credentialState: 'not-required' as const,
        diagnostics: [],
      },
      runtimeBinding: {
        kind: 'mcp' as const,
        server: {
          key: server.key,
          wireName: server.wireName,
          // Matches the view entry's `logicalName` above, not `server.key`.
          // Production keeps ONE shared value here: `views.ts` forwards
          // `runtimeBinding.server` into `AgentRuntimeView.mcpServers`
          // unchanged, so the two are literally the same object with the same
          // field in a real resolve() — this fixture was inconsistent
          // (review finding, task 2, 2026-08-10).
          logicalName: server.wireName,
          definition: { type: 'stdio' as const, command: 'noop' },
        },
      },
    })),
    installedPlugins: [],
    diagnostics: [],
  } as EffectiveCapabilitySnapshot
  return {
    snapshot,
    sessionKey,
    view,
    // keep the managed-model seam deterministic in tests: `undefined` would
    // fall through `??` into managedModelAllowlist() and read host state
    orchestrator: { availableModels: [] },
  } as Parameters<typeof createPiExecutionManifestSeed>[0]
}

function dynamicTool(bindingName: string, capabilityKey: string) {
  return {
    bindingName,
    description: 'd',
    inputSchema: { type: 'object', properties: {} },
    modelSchemaVersion: 1 as const,
    bindingSchemaVersion: 1 as const,
    provenance: { capabilityKey, generation },
  }
}

describe('N2 degrade', () => {
  test('tryParse returns null instead of throwing', () => {
    expect(tryParsePiDynamicMcpBindingName('not-an-mcp-name')).toBeNull()
    expect(tryParsePiDynamicMcpBindingName('mcp__t-tracker__list')).toEqual({ wireName: 't-tracker', toolName: 'list' })
  })

  test('duplicate seed wireNames dedupe deterministically with a debug line', () => {
    const lines: string[] = []
    const seed = createPiExecutionManifestSeed({
      ...seedInput([
        { key: 'b-key', wireName: 't-tracker' },
        { key: 'a-key', wireName: 't-tracker' },
      ]),
      debug: line => lines.push(line),
    })
    expect(seed.mcpSources).toHaveLength(1)
    expect(seed.mcpSources[0]!.capabilityKey).toBe('a-key') // lexically-smallest key wins
    expect(lines.some(line => line.includes('t-tracker'))).toBe(true)
  })

  test('a tool whose wireName is missing from the seed is dropped, not fatal', () => {
    const seed = createPiExecutionManifestSeed(seedInput([{ key: 'k', wireName: 'present' }]))
    const manifest = finalizePiExecutionManifest(seed, [
      dynamicTool('mcp__present__list', 'k'),
      dynamicTool('mcp__absent__list', 'k'),
    ])
    const names = manifest.tools.map(tool => tool.binding.bindingName)
    expect(names).toContain('mcp__present__list')
    expect(names).not.toContain('mcp__absent__list')
  })
})
