/**
 * F1.112 (origin WI-bx, D1.425's residue) — the workspace BROWSE pool is
 * UNFILTERED by the external-model MCP policy, on purpose, and this file is the
 * control that keeps the decision from becoming a drift.
 *
 * The row was a question rather than a defect: `WorkspaceMcpPoolRegistry` passes
 * no `modelTarget`, so browsing lists every server whatever the session's model,
 * and that asymmetry lived only as prose inside
 * `applyExternalModelMcpWhitelist` — in the OTHER package, where nobody reading
 * this registry would meet it.
 *
 * OWNER-LEVEL DECISION, 2026-09-20 (AGENTS.md, transparent-and-simple): browse
 * STAYS unfiltered, because browsing runs no tool and the per-session path
 * carries the verdict at the one reader every runtime crosses. The reason now
 * sits on the registry's own options literal; these two cases are what make the
 * decision falsifiable rather than a comment somebody can delete.
 *
 * Two arms, and they answer different questions:
 *
 * 1. The registry really does pass an absent verdict, and says why. Source text,
 *    with a positive control on the same read, because the alternative — driving
 *    a private `materializeRuntime` through the dp broker and the resolver — is
 *    a rig whose failure modes would swamp the one fact under test.
 * 2. An absent verdict is byte-identical to the pre-DA2.2 behaviour on the very
 *    materializer both pools share, while the same call carrying a session's
 *    verdict withholds. That is the row's own control: whichever way browse is
 *    decided, the per-session arms do not move.
 */
import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { materializeRuntimePoolServers } from '@nessy-agent/shared/mcp/runtime-pool-servers'
import { classifyModelTarget } from '@nessy-agent/shared/agent/backend/internal/drivers/upstream-target'
import type { CapabilityTurnRuntime } from '@nessy-agent/shared/agent/backend'

const REGISTRY = join(import.meta.dir, '..', 'workspace-mcp-pool-registry.ts')

/** One whitelisted wire name and one that is not — a policy pair, not a nonsense pair. */
function runtimeWithTwoServers(): CapabilityTurnRuntime {
  return {
    view: {
      generation: 'g',
      sources: [], skills: [], hooks: [], automations: [], agents: [],
      promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [],
      apps: [], lspServers: [],
      mcpServers: [
        { key: 'k1', wireName: 'dpJira', definition: { type: 'http', url: 'https://mcp.test/jira' } },
        { key: 'k2', wireName: 'dpFs', definition: { type: 'http', url: 'https://mcp.test/fs' } },
      ],
    },
    materializer: {
      assertActive() {},
      async verifyPlugin() {},
      async resolvePath() { return '/abs/path' },
      async readText() { return '{}' },
      resolveCredential() { throw new Error('credential-not-ready') },
    },
  } as unknown as CapabilityTurnRuntime
}

const BASE = { workspaceRootPath: '/ws', workspaceId: 'ws-1', builtinDpMcpServers: false } as const

describe('F1.112 — the browse pool passes no model-target verdict, deliberately', () => {
  it('the registry spells the absence and carries the decision beside it', () => {
    const source = readFileSync(REGISTRY, 'utf8')
    // The positive control FIRST: this read really reaches the options literal
    // the registry hands `materializeRuntimePoolServers`.
    expect(source).toContain('builtinDpMcpServers: { enabled: getBuiltinDpMcpServerPreferences() }')

    expect(source).toContain('modelTarget: undefined')
    expect(source).toContain('F1.112')
    expect(source).toContain('browse stays unfiltered because browsing RUNS NO TOOL')
  })

  it('an absent verdict keeps every server, and a session verdict on the same call withholds', async () => {
    const browse = await materializeRuntimePoolServers(runtimeWithTwoServers(), { ...BASE })
    expect(Object.keys(browse.mergedMcpServers).sort()).toEqual(['dpFs', 'dpJira'])

    // The same materializer, the same view, the only difference being the option
    // the registry declines to pass. `dpFs` is a shipped built-in that is NOT on
    // the whitelist, so the pair is a policy test rather than a naming test.
    const session = await materializeRuntimePoolServers(runtimeWithTwoServers(), {
      ...BASE,
      modelTarget: classifyModelTarget({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', providerType: 'pi_compat' }),
    })
    expect(Object.keys(session.mergedMcpServers)).toEqual(['dpJira'])
  })
})
