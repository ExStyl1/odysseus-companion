import { describe, expect, it } from 'bun:test'

import type { BackendConfig, CapabilityTurnRuntime } from '../../../shared/src/agent/backend/types.ts'
import { PiAgent } from '../../../shared/src/agent/pi-agent.ts'
import {
  normalizePiOrchestratorConfig,
  piStaticModelContractPinKey,
  type PiExecutionManifestSeedV2,
  type ResolvedHarnessTool,
} from '../../../shared/src/agent/pi-harness/harness-manifest.ts'
import {
  getHarnessToolDescriptor,
  getPiStaticModelContractHash,
  getPiToolBinding,
} from '../../../shared/src/agent/pi-harness/harness-tool-descriptor.ts'
import { preparePiManifestRegistration } from './tool-manifest.ts'

// F1.706, second half. Since 809f2cd2b `finalizePiExecutionManifest` keeps the
// FIRST tool of a repeated name and drops the later one, but the host's
// `PiAgent.buildExecutionManifestForCurrentTurn` still sent the subprocess every
// proxy definition whose name the manifest registered: both definitions of a
// repeat, and a proxy definition named like a host tool. The subprocess's own
// `preparePiManifestRegistration` refused both (measured before the fix: "Pi
// execution manifest definition mismatch for mcp__dup__x", and "... for read"),
// on the spawn and on every turn. These tests drive the host build and hand its
// output to that subprocess check, so they read what Pi accepts.

const GENERATION = 'gen-f1706'
const SESSION_KEY = { workspaceId: 'ws', sessionId: 'parent' }
const ORCHESTRATOR = normalizePiOrchestratorConfig({})

type ProxyDef = { name: string; description: string; inputSchema: Record<string, unknown> }

const X_FIRST: ProxyDef = { name: 'mcp__dup__x', description: 'first x', inputSchema: { type: 'object', properties: { a: { type: 'string' } } } }
const X_SECOND: ProxyDef = { name: 'mcp__dup__x', description: 'second x', inputSchema: { type: 'object', properties: { b: { type: 'number' } } } }
const PLAIN: ProxyDef = { name: 'mcp__dup__plain', description: 'plain tool', inputSchema: { type: 'object', properties: {} } }
/** A proxy definition carrying a HOST tool's name (`read` is a static binding). */
const READ_PROXY: ProxyDef = { name: 'read', description: 'not the host read', inputSchema: { type: 'object', properties: {} } }

function pool(defs: readonly ProxyDef[]) {
  return {
    getProxyToolDefs: () => defs.map(def => ({ ...def })),
    alwaysLoadProxyToolNames: () => new Set<string>(),
    slugsForLeaser: () => new Set<string>(),
    hasResourceCapability: () => false,
    isProxyTool: () => false,
    getInstructions: () => undefined,
    getConnectedSlugs: () => [],
    setElicitationHandler: () => {},
    registerElicitationHandler: () => () => {},
  }
}

/** The host build for `defs`, its debug lines, and the host-side seed it was built from. */
function build(defs: readonly ProxyDef[], options: { hostRead?: boolean } = {}) {
  const allowed = [...new Set(defs.map(def => def.name))]
  const config = {
    provider: 'pi', isHeadless: true, skipConfigWatcher: true,
    // Narrows the build to the fixture's names so the session-tool surface stays out of it.
    piAllowedTools: options.hostRead ? [...allowed, 'read'] : allowed,
    mcpPool: pool(defs),
    workspace: { id: 'ws', name: 'ws', rootPath: '/tmp/ws', workspaceRootPath: '/tmp/ws', sessionRootPath: '/tmp/sessions/ws' },
    session: { id: 'parent', workspaceId: 'ws', createdAt: 1, lastUsedAt: 1 },
  } as unknown as BackendConfig
  const hostTools = options.hostRead ? [hostRead()] : []
  const seed: PiExecutionManifestSeedV2 = {
    surfaceVersion: 2,
    snapshotGeneration: GENERATION,
    sessionKey: SESSION_KEY,
    provenance: [{ capabilityKey: 'dup', generation: GENERATION }],
    mcpSources: [{ wireName: 'dup', capabilityKey: 'dup', generation: GENERATION }],
    orchestrator: ORCHESTRATOR,
    staticTools: hostTools,
  }
  const runtime = {
    view: { generation: GENERATION, sources: [], skills: [], mcpServers: [], hooks: [], automations: [], agents: [], promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [] },
    materializer: { assertActive() {}, async verifyPlugin() {}, async resolvePath() { return '' }, async readText() { return '' }, resolveCredential() { throw new Error('unused') } },
    piExecutionManifestSeed: seed,
  } as unknown as CapabilityTurnRuntime
  const agent = new PiAgent(config)
  const lines: string[] = []
  agent.onDebug = line => { lines.push(line) }
  try {
    agent.setCapabilityTurnRuntime(runtime)
    const built = (agent as unknown as {
      buildExecutionManifestForCurrentTurn(): {
        manifest: Parameters<typeof preparePiManifestRegistration>[0]['manifest']
        tools: Array<ProxyDef & { promptSnippet?: string; promptGuidelines?: readonly string[] }>
      }
    }).buildExecutionManifestForCurrentTurn()
    return { ...built, lines: lines.filter(line => line.includes('pi-manifest:')) }
  } finally {
    agent.destroy()
  }
}

/** The host `read` tool, built the way the seed's `staticTools` builds each host tool. */
function hostRead(): ResolvedHarnessTool {
  const binding = getPiToolBinding('read')
  return {
    descriptor: getHarnessToolDescriptor(binding.descriptorId),
    binding,
    source: { kind: 'piBuiltin', bindingId: binding.bindingName },
    modelContractHash: getPiStaticModelContractHash(piStaticModelContractPinKey(binding.bindingName, ORCHESTRATOR)),
  }
}

/** What the subprocess does with the host's `register_tools` payload: it throws on anything it refuses. */
function register(built: ReturnType<typeof build>) {
  const identity = { generation: built.manifest.snapshotGeneration, manifestHash: built.manifest.manifestHash }
  return preparePiManifestRegistration({
    current: identity, previous: identity, manifest: built.manifest, definitions: built.tools as never,
    sessionKey: SESSION_KEY, orchestrator: ORCHESTRATOR,
  })
}

describe('F1.706 — the host sends Pi one wire definition per tool the manifest kept', () => {
  it('a name listed twice reaches the subprocess once, as the FIRST definition, and the drop is reported', () => {
    const built = build([X_FIRST, PLAIN, X_SECOND])
    expect(built.tools.map(tool => [tool.name, tool.description])).toEqual([['mcp__dup__x', 'first x'], ['mcp__dup__plain', 'plain tool']])
    expect(built.tools[0]!.inputSchema).toEqual(X_FIRST.inputSchema)
    expect(() => register(built)).not.toThrow()
    expect(built.lines).toEqual([
      '[pi] pi-manifest: duplicate piName "mcp__dup__x" — keeping the tool already in the manifest, dropping the later one from dup',
    ])
  })

  it('BOUNDARY — a proxy definition named like a host tool is not sent, and the host tool stays', () => {
    const built = build([PLAIN, READ_PROXY], { hostRead: true })
    expect(built.manifest.tools.map(tool => [tool.binding.bindingName, tool.description])).toEqual([['mcp__dup__plain', 'plain tool'], ['read', undefined]])
    expect(built.tools.map(tool => tool.name)).toEqual(['mcp__dup__plain'])
    expect(() => register(built)).not.toThrow()
    expect(built.lines).toEqual(['[pi] pi-manifest: duplicate piName "read" — keeping the tool already in the manifest, dropping the later one from binding read'])
  })

  it('CONTROL — unique names: every definition is sent, in order, with its prompt metadata, and nothing is reported', () => {
    const built = build([X_FIRST, PLAIN])
    expect(built.tools.map(tool => [tool.name, tool.description])).toEqual([['mcp__dup__x', 'first x'], ['mcp__dup__plain', 'plain tool']])
    for (const tool of built.tools) {
      const kept = built.manifest.tools.find(entry => entry.binding.bindingName === tool.name)!
      expect([tool.promptSnippet, tool.promptGuidelines]).toEqual([kept.promptSnippet, kept.promptGuidelines])
    }
    expect(() => register(built)).not.toThrow()
    expect(built.lines).toEqual([])
  })
})
