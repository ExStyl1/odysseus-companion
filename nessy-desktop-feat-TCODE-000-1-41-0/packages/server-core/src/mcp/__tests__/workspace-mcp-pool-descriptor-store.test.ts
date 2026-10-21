/**
 * Proves the descriptor store is actually WIRED, not merely available.
 *
 * `toolDescriptorStore` sat unused in production for a while: the option existed
 * on `McpClientPool`, `hydrateDescriptorsFromStore` returned early at
 * `if (!store) return` and `write` was a no-op. Since the send path stopped
 * awaiting connect, that gap meant a cold pool's first turn advertised no MCP
 * tools at all. A test asserting the option exists would not have caught it —
 * this one goes through the real `defaultCreatePool` path.
 *
 * The suite's own preload already points `CONFIG_DIR` at an isolated temp
 * directory, so the store under test writes there rather than into a developer's
 * real config directory.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import type { SdkMcpServerConfig } from '@nessy-agent/shared/agent/backend'
import { createToolDescriptorStore } from '@nessy-agent/shared/mcp'
import { CONFIG_DIR } from '@nessy-agent/shared/workspaces'
import { WorkspaceMcpPoolRegistry } from '../workspace-mcp-pool-registry.ts'

const descriptorRoot = join(CONFIG_DIR, 'mcp', 'tool-descriptors')
const CONFIG: SdkMcpServerConfig = { type: 'stdio', command: '/bin/true', args: [] }
const TOOLS: Tool[] = [
  { name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: {} } },
]

function newRegistry(): WorkspaceMcpPoolRegistry {
  // No `createPool` dep, so pools come from the real `defaultCreatePool`.
  return new WorkspaceMcpPoolRegistry({
    resolver: {
      resolve: async () => { throw new Error('unused') },
      releaseSnapshot: () => {},
    } as unknown as WorkspaceMcpPoolRegistry['deps']['resolver'],
    resolveCredential: () => { throw new Error('unused') },
    resolveWorkspaceRootPath: () => undefined,
    dpSessionBroker: { probe: async () => ({ state: 'unavailable' }), subscribe: () => () => {} },
  } as unknown as ConstructorParameters<typeof WorkspaceMcpPoolRegistry>[0])
}

afterEach(() => {
  rmSync(descriptorRoot, { recursive: true, force: true })
})

describe('production pool construction', () => {
  it('gives every pool it builds a descriptor store rooted in the config dir', async () => {
    const first = newRegistry()
    const lease = first.lease({ workspaceId: 'workspace-1' })
    await lease.pool.sync({ alpha: CONFIG }, {}, { leaserId: 'L' })
    const connectionKey = lease.pool.connectionKeyForDesired('alpha', 'L')
    expect(connectionKey).toBeTruthy()
    await first.dispose()

    // Write the record where the wired store must be looking.
    createToolDescriptorStore(descriptorRoot).write(connectionKey!, TOOLS)
    expect(readdirSync(descriptorRoot).some(entry => entry.endsWith('.json'))).toBe(true)

    // A pool built through the same production path must now advertise the
    // server without connecting to it.
    const second = newRegistry()
    const rebuilt = second.lease({ workspaceId: 'workspace-2' })
    await rebuilt.pool.sync({ alpha: CONFIG }, {}, { leaserId: 'L' })

    expect(rebuilt.pool.isConnected('alpha', 'L')).toBe(false)
    expect(rebuilt.pool.getTools('alpha', 'L')).toEqual(TOOLS)
    expect(rebuilt.pool.getProxyToolDefs(['alpha'], 'L').map(def => def.name))
      .toEqual(['mcp__alpha__echo'])
    await second.dispose()
  })

  it('persists descriptors under the config dir and nowhere else', async () => {
    expect(existsSync(descriptorRoot)).toBe(false)
    createToolDescriptorStore(descriptorRoot).write(JSON.stringify(['mcp', 'beta', 'c'.repeat(64)]), TOOLS)
    expect(descriptorRoot.startsWith(CONFIG_DIR)).toBe(true)
    expect(readdirSync(descriptorRoot)).toHaveLength(1)
  })
})

/**
 * P6.351 (denominator J44) — the documented switch over the cache above.
 *
 * The row's verdict was `absent` on all three, and that is refuted: the
 * capability is built and shipping, under the name `toolDescriptorStore`. What
 * `MCP_DISCOVERY_CACHE` adds is the documented SPELLING of the off switch, so
 * these two cases assert the switch and not the cache — the case above is the
 * cache's own positive control.
 *
 * `delete` before assign, per the AGENTS.md env-slot rule, so the name is
 * enumerable for anything that spreads `process.env` in between.
 */
describe('MCP_DISCOVERY_CACHE', () => {
  const previous = process.env.MCP_DISCOVERY_CACHE

  afterEach(() => {
    delete process.env.MCP_DISCOVERY_CACHE
    if (previous !== undefined) process.env.MCP_DISCOVERY_CACHE = previous
  })

  async function advertisedAfterRestart(): Promise<Tool[] | undefined> {
    const first = newRegistry()
    const lease = first.lease({ workspaceId: 'workspace-switch' })
    await lease.pool.sync({ alpha: CONFIG }, {}, { leaserId: 'L' })
    const connectionKey = lease.pool.connectionKeyForDesired('alpha', 'L')
    await first.dispose()
    createToolDescriptorStore(descriptorRoot).write(connectionKey!, TOOLS)

    const second = newRegistry()
    const rebuilt = second.lease({ workspaceId: 'workspace-switch-2' })
    await rebuilt.pool.sync({ alpha: CONFIG }, {}, { leaserId: 'L' })
    const advertised = rebuilt.pool.getTools('alpha', 'L')
    await second.dispose()
    return advertised
  }

  it('`0` turns the cache off, so a cold pool advertises nothing before it connects', async () => {
    delete process.env.MCP_DISCOVERY_CACHE
    process.env.MCP_DISCOVERY_CACHE = '0'
    expect(await advertisedAfterRestart()).not.toEqual(TOOLS)
  })

  it('any other value leaves our default on — a stated divergence from the page default', async () => {
    // The page's default is OFF pending a vendor rollout this product is not
    // part of; ours has been on since the cache was built. An unrecognised
    // value must not silently mean off, or a typo would delete the capability.
    delete process.env.MCP_DISCOVERY_CACHE
    process.env.MCP_DISCOVERY_CACHE = 'yes'
    expect(await advertisedAfterRestart()).toEqual(TOOLS)
  })
})
