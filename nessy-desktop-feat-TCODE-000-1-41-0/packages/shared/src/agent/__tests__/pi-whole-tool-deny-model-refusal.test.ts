import { describe, expect, it } from 'bun:test'

import { PiAgent } from '../pi-agent.ts'
import type { BackendConfig, CapabilityTurnRuntime } from '../backend/types.ts'
import { finalizePiExecutionManifest, type PiExecutionManifestSeedV2 } from '../pi-harness/harness-manifest.ts'
import { getHarnessToolDescriptor, getPiToolBinding } from '../pi-harness/harness-tool-descriptor.ts'

// F1.1100 — the host hands the Pi subprocess the refusal of every tool a whole-tool deny removed, with every manifest
// registration, so the subprocess can show the MODEL the rule instead of the Pi SDK's "Tool <name> not found"
// (`pi-agent-server/src/extensions/whole-tool-deny-context.ts`). F1.756 put the same sentences on the user's card.

function config(): BackendConfig {
  return {
    provider: 'pi',
    workspace: { id: 'workspace-1', name: 'Workspace', rootPath: '/tmp/f1100-ws', workspaceRootPath: '/tmp/f1100-ws', sessionRootPath: '/tmp/f1100-sessions' } as never,
    session: { id: 'session-1', createdAt: 0, lastUsedAt: 0 } as never,
    isHeadless: true,
  }
}

function runtimeAndManifest() {
  const seed: PiExecutionManifestSeedV2 = {
    surfaceVersion: 2,
    snapshotGeneration: 'generation-1',
    sessionKey: { workspaceId: 'workspace-1', sessionId: 'session-1' },
    provenance: [],
    mcpSources: [],
    orchestrator: { concurrency: 4, depth: 2, maxParallelTasks: 8, maxAgents: 100, tierModelMap: null, tokenBudget: null },
    staticTools: [{
      descriptor: getHarnessToolDescriptor('notebook_edit'),
      binding: getPiToolBinding('notebook_edit'),
      source: { kind: 'piBuiltin', bindingId: 'NotebookEdit' },
      modelSchema: { type: 'object' },
    }],
  }
  const manifest = finalizePiExecutionManifest(seed, [])
  const runtime = {
    view: { generation: 'generation-1', sources: [], skills: [], mcpServers: [], hooks: [], automations: [], agents: [], promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [] },
    materializer: {
      assertActive() {}, async verifyPlugin() {}, async resolvePath() { return '/tmp/f1100-resource' },
      async readText() { return '' }, resolveCredential() { throw new Error('unused') },
    },
    piExecutionManifestSeed: seed,
  } as CapabilityTurnRuntime
  return { runtime, manifest }
}

async function registration(wholeToolDenyRefusals?: Map<string, { toolName: string; refusal: string }>) {
  const agent = new PiAgent(config())
  const { runtime, manifest } = runtimeAndManifest()
  const sent: Array<Record<string, unknown>> = []
  const state = agent as unknown as {
    subprocess: { stdin: { writable: boolean } } | null
    send(message: Record<string, unknown>): void
    publishExecutionManifest(execution: unknown, previous: unknown): Promise<void>
    pendingManifestRegistrations: Map<string, { resolve(identity: { generation: string; manifestHash: string }): void }>
  }
  state.send = message => { sent.push(message) }
  state.subprocess = { stdin: { writable: true } }
  agent.setCapabilityTurnRuntime(runtime)
  const pending = state.publishExecutionManifest({ manifest, tools: [], ...(wholeToolDenyRefusals ? { wholeToolDenyRefusals } : {}) }, manifest)
  await Promise.resolve()
  ;[...state.pendingManifestRegistrations.values()][0]!.resolve({ generation: manifest.snapshotGeneration, manifestHash: manifest.manifestHash })
  await pending
  state.subprocess = null
  agent.destroy()
  return sent.find(message => message.type === 'register_tools')
}

describe('F1.1100: register_tools carries each deny-removed tool\'s refusal', () => {
  it('sends the Pi name and the rule sentence of every removed tool', async () => {
    const message = await registration(new Map([
      ['bash', { toolName: 'Bash', refusal: 'Tool blocked: deny rule "Bash".' }],
      ['web_fetch', { toolName: 'WebFetch', refusal: 'Tool blocked: deny rule "WebFetch".' }],
    ]))
    expect(message?.wholeToolDenyRefusals).toEqual([
      { name: 'bash', refusal: 'Tool blocked: deny rule "Bash".' },
      { name: 'web_fetch', refusal: 'Tool blocked: deny rule "WebFetch".' },
    ])
  })

  it('CONTROL: with no whole-tool deny the list is empty, so the subprocess clears what an earlier registration set', async () => {
    expect((await registration())?.wholeToolDenyRefusals).toEqual([])
  })
})
