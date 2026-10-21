/**
 * F1.461 — a user WITHOUT dp is told why a built-in dp MCP server cannot start,
 * on the detail page the row opens.
 *
 * The `builtin_dp_mcp.dp_not_found` sentence used to ride ONLY
 * `McpServerRow.unavailableReason` (`buildBuiltinDpMcpRows`, the renderer's
 * `capability-catalog.ts`), and nothing rendered it: badge parity removed the
 * row's `Needs dp` badge, and the detail page (`SourceInfoPage`) reads
 * `capabilities.getDetail`, whose built-in summary comes from
 * `builtinDpMcpCapabilityRecords` — which never resolves dp, by design (every
 * turn resolves). So GET_DETAIL makes the one filesystem lookup itself, for a
 * built-in dp row only, through the SAME reader the MCP list's RPC uses
 * (`readBuiltinDpMcpSettingsView`), and `CapabilityDetailTemplate` renders the
 * free string it already passes through (`CapabilityDetailTemplate.test.tsx`,
 * "falls back to the raw string for an unrecognized `unavailableReason`").
 */
import { describe, expect, it } from 'bun:test'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import { createCapabilityResolver, type CapabilityResolutionInputs } from '@nessy-agent/shared/capabilities/resolver'
import { readBuiltinDpMcpSettingsView, type BuiltinDpMcpSettingsViewV1 } from '@nessy-agent/shared/config'
import { ProjectHandleService } from '@nessy-agent/shared/projects/project-handle-service'
import type { HandlerFn, RequestContext, RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../../handler-deps'
import { builtinDpMcpCapabilityRecords } from '../../../bootstrap/storage-runtime'
import { registerCapabilitiesHandlers, type CapabilitiesHandlerOptions } from '../capabilities'

function inputs(): CapabilityResolutionInputs {
  return {
    nativeInventory: {
      records: [
        ...builtinDpMcpCapabilityRecords({ builtinDpMcpServers: { enabled: { dpJira: true } } }),
        {
          key: 'mcp:workspace:ws-1:mymcp',
          kind: 'mcp',
          scope: { kind: 'workspace', workspaceId: 'ws-1' },
          logicalName: 'mymcp',
          sourcePath: '/abs/managed/mcp/mymcp.json',
          revision: 'r3',
          contentHash: 'h3',
          mutable: true,
        },
      ],
      blockedLayers: [],
    },
    installedPlugins: [],
    activePluginInstances: {},
    pluginCandidates: [],
    resolveActivation: () => ({ enabled: true, suppressed: false, capabilities: {} }),
    resolveTrust: () => 'not-required',
  }
}

function harness(builtinDpView: () => BuiltinDpMcpSettingsViewV1) {
  const handlers = new Map<string, HandlerFn>()
  const server: RpcServer = {
    handle(channel, handler) { handlers.set(channel, handler) },
    push() {},
    async invokeClient() { return undefined },
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  }
  const deps = {
    platform: { logger: { info() {}, warn() {}, error() {}, debug() {} } },
    sessionManager: {},
  } as unknown as HandlerDeps
  const options: CapabilitiesHandlerOptions = {
    resolver: createCapabilityResolver({ inputs: () => inputs() }),
    handleService: new ProjectHandleService({
      identityOptions: {
        realpathSync: path => path,
        statSync: () => ({ dev: 1n, ino: 1n }),
        processSalt: 'builtin-dp-detail-test',
      },
    }),
    builtinDpView,
  }
  registerCapabilitiesHandlers(server, deps, options)
  const ctx: RequestContext = { clientId: 'client-1', workspaceId: 'ws-1', webContentsId: 1 }
  return async (capabilityKey: string) => await handlers.get(RPC_CHANNELS.capabilities.GET_DETAIL)!(
    ctx,
    { workspaceId: 'ws-1' },
    capabilityKey,
  ) as { summary: { key: string; unavailableReason?: string } }
}

// The REAL composer of the sentence, with only the filesystem lookup injected —
// the same function the MCP list's `builtinDpMcp:list` RPC answers with.
const DP_MISSING = () => readBuiltinDpMcpSettingsView({ resolveDpPath: () => null })
const DP_PRESENT = () => readBuiltinDpMcpSettingsView({ resolveDpPath: () => '/opt/fake/bin/dp' })

describe('F1.461 — GET_DETAIL tells a dp-less user why a built-in dp server cannot start', () => {
  it('a built-in dp row carries the dp_not_found sentence when dp is missing', async () => {
    const missing = DP_MISSING()
    expect(missing.available).toBe(false)
    const sentence = missing.diagnostics.map(diagnostic => diagnostic.message).join(' ')
    expect(missing.diagnostics.map(diagnostic => diagnostic.code)).toContain('builtin_dp_mcp.dp_not_found')
    expect(sentence.length).toBeGreaterThan(0)

    const detail = await harness(DP_MISSING)('builtin:mcp:dpJira')
    expect(detail.summary.key).toBe('builtin:mcp:dpJira')
    expect(detail.summary.unavailableReason).toBe(sentence)
  })

  it('NEGATIVE: with dp present the same row carries no reason', async () => {
    const detail = await harness(DP_PRESENT)('builtin:mcp:dpJira')
    expect(detail.summary.key).toBe('builtin:mcp:dpJira')
    expect(detail.summary.unavailableReason).toBeUndefined()
  })

  it('BOUNDARY: a non-built-in MCP detail never pays the dp lookup, and a failed lookup never breaks the page', async () => {
    let reads = 0
    const counted = () => { reads += 1; return DP_MISSING() }
    const userServer = await harness(counted)('mcp:workspace:ws-1:mymcp')
    expect(userServer.summary.key).toBe('mcp:workspace:ws-1:mymcp')
    expect(userServer.summary.unavailableReason).toBeUndefined()
    expect(reads).toBe(0)
    // Positive control on the same counter: the built-in row DOES read.
    await harness(counted)('builtin:mcp:dpJira')
    expect(reads).toBe(1)

    const throwing = await harness(() => { throw new Error('lookup failed') })('builtin:mcp:dpJira')
    expect(throwing.summary.key).toBe('builtin:mcp:dpJira')
    expect(throwing.summary.unavailableReason).toBeUndefined()
  })
})
