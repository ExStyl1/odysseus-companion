import { describe, expect, it } from 'bun:test'
import { PiAgent } from '../pi-agent.ts'
import type { BackendConfig, CapabilityTurnRuntime } from '../backend/types.ts'
import { finalizePiExecutionManifest, type PiExecutionManifestSeedV2 } from '../pi-harness/harness-manifest.ts'
import {
  PI_STATIC_MODEL_CONTRACT_HASHES,
  PI_TOOL_BINDINGS,
  getHarnessToolDescriptor,
} from '../pi-harness/harness-tool-descriptor.ts'
import { parseAndFreezePiPermissionReceipt, type PiPermissionServicePort } from '../pi-harness/permission-receipt.ts'

const permissionServicePort: PiPermissionServicePort = {
  async authorize(request) {
    return parseAndFreezePiPermissionReceipt({
      version: 1,
      sessionKey: request.subject.sessionKey,
      binding: {
        provider: 'pi',
        surfaceVersion: request.subject.surfaceVersion,
        piName: request.subject.piName,
        bindingName: request.subject.bindingName,
        semanticId: request.subject.semanticId,
        descriptorId: request.subject.descriptorId,
      },
      manifest: {
        generation: request.subject.manifestGeneration,
        hash: request.subject.manifestHash,
        provenance: request.subject.manifestProvenance,
        responseEpoch: request.subject.responseEpoch,
      },
      decisionId: 'labels-read-allow',
      outcome: 'allow',
      canonicalInput: request.canonicalInput,
      contextProfile: request.subject.contextProfile,
      sandboxRequirement: request.subject.sandboxRequirement,
    }, request.subject)
  },
}

function createConfig(overrides?: {
  workspaceRootPath?: string
  workingDirectory?: string
}): BackendConfig {
  const workspaceRootPath = overrides?.workspaceRootPath ?? '/tmp/ws-root'
  const workingDirectory = overrides?.workingDirectory ?? '/tmp/project-root'

  return {
    provider: 'pi',
    workspace: {
      id: 'ws-test',
      name: 'Test Workspace',
      rootPath: workspaceRootPath,
      workspaceRootPath,
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-test',
    } as any,
    session: {
      id: 'session-test',
      workspaceRootPath,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory,
    } as any,
    isHeadless: true,
    contextProfile: 'bare',
    permissionServicePort,
  }
}

function installReadManifest(agent: PiAgent) {
  const seed: PiExecutionManifestSeedV2 = {
    surfaceVersion: 2,
    snapshotGeneration: 'generation-labels-read',
    sessionKey: { workspaceId: 'ws-test', sessionId: 'session-test' },
    provenance: [],
    mcpSources: [],
    orchestrator: { concurrency: 4, depth: 2, maxParallelTasks: 8, maxAgents: 100, tierModelMap: null, tokenBudget: null },
    staticTools: PI_TOOL_BINDINGS.flatMap(binding => {
      const modelContractHash = PI_STATIC_MODEL_CONTRACT_HASHES[binding.bindingName]
      return modelContractHash ? [{
        descriptor: getHarnessToolDescriptor(binding.descriptorId),
        binding,
        source: { kind: 'piBuiltin' as const, bindingId: binding.bindingName },
        modelContractHash,
      }] : []
    }),
  }
  const manifest = finalizePiExecutionManifest(seed, [])
  const tool = manifest.tools.find(candidate => candidate.binding.permissionName === 'Read')
  if (!tool) throw new Error('missing Read test tool')
  const runtime = {
    view: {
      generation: manifest.snapshotGeneration,
      sources: [], skills: [], mcpServers: [], hooks: [], automations: [], agents: [],
      promptLayers: [], memory: [], permissionLayers: [], commands: [], apps: [],
    },
    materializer: { assertActive() {} },
    piExecutionManifestSeed: seed,
  } as unknown as CapabilityTurnRuntime
  agent.setCapabilityTurnRuntime(runtime)
  ;(agent as any).activeExecutionManifest = manifest
  return {
    semanticId: tool.descriptor.id,
    piName: tool.binding.piName,
    surfaceVersion: manifest.surfaceVersion,
    manifestResponseEpoch: 0,
    manifestGeneration: manifest.snapshotGeneration,
    manifestHash: manifest.manifestHash,
  }
}

describe('PiAgent pre-tool labels guard', () => {
  it('allows Read on workspace labels/config.json even when session workingDirectory is outside workspace root', async () => {
    const workspaceRootPath = '/tmp/ws-root'
    const workingDirectory = '/tmp/project-root'
    const agent = new PiAgent(createConfig({ workspaceRootPath, workingDirectory }))

    const sent: Array<Record<string, unknown>> = []
    ;(agent as any).send = (message: Record<string, unknown>) => {
      sent.push(message)
    }
    ;(agent as any).emitAutomationEvent = async () => {}
    agent.setPermissionMode('bypassPermissions')
    const identity = installReadManifest(agent)

    await (agent as any).handlePreToolUseRequest({
      requestId: 'req-1',
      toolName: 'Read',
      ...identity,
      input: { file_path: `${workspaceRootPath}/labels/config.json` },
    })

    expect(sent.length).toBeGreaterThan(0)

    const response = sent.at(-1)
    expect(response?.type).toBe('pre_tool_use_response')
    expect(response?.action).toBe('allow')

    agent.destroy()
  })
})
