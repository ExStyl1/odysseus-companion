import { describe, expect, it } from 'bun:test'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { getToolDefsAsJsonSchema } from '../../../session-tools-core/src/tool-defs.ts'

import {
  finalizePiExecutionManifest,
  type PiExecutionManifestSeedV2,
  type PiExecutionManifestV2,
} from '../../../shared/src/agent/pi-harness/harness-manifest.ts'
import {
  getHarnessToolDescriptor,
  getPiStaticModelContractHash,
  getPiToolBinding,
} from '../../../shared/src/agent/pi-harness/harness-tool-descriptor.ts'
import { buildPiRuntimeAgentDefinitions } from '../orchestrator/runtime-agent-definitions.ts'
import { createBackgroundBashTool } from '../tools/background-bash.ts'
import {
  hashProjectedPiToolDefinition,
  preparePiManifestRegistration,
  projectPiManifestTools,
  resolvePiAllowedBindingNames,
  resolvePiSessionToolPool,
  validatePiExecutionManifest,
} from './tool-manifest.ts'

function definition(name: string, calls: string[]): ToolDefinition<any, any> {
  return {
    name,
    label: name,
    description: name,
    promptSnippet: name,
    promptGuidelines: [],
    parameters: { type: 'object' } as never,
    execute: async () => {
      calls.push(name)
      return { content: [{ type: 'text', text: name }], details: {} }
    },
  }
}

function manifest(snapshotGeneration = 'generation-1'): PiExecutionManifestV2 {
  const seed: PiExecutionManifestSeedV2 = {
    surfaceVersion: 2,
    snapshotGeneration,
    sessionKey: { workspaceId: 'workspace-1', sessionId: 'session-1' },
    provenance: [{ capabilityKey: 'github', generation: snapshotGeneration }],
    mcpSources: [{ wireName: 'GitHub', capabilityKey: 'github', generation: snapshotGeneration }],
    orchestrator: {
      concurrency: 4,
      depth: 2,
      maxParallelTasks: 8,
      maxAgents: 100,
      tierModelMap: null,
      tokenBudget: null,
    },
    staticTools: [
      {
        descriptor: getHarnessToolDescriptor('notebook_edit'),
        binding: getPiToolBinding('notebook_edit'),
        source: { kind: 'piBuiltin', bindingId: 'NotebookEdit' },
        description: 'NotebookEdit',
        modelSchema: { type: 'object' },
        promptSnippet: 'NotebookEdit',
        promptGuidelines: [],
      },
    ],
  }
  return finalizePiExecutionManifest(seed, [{
    bindingName: 'mcp__GitHub__CreateIssue',
    description: 'Create issue',
    inputSchema: { type: 'object' },
    promptSnippet: 'Create issue',
    promptGuidelines: [],
    modelSchemaVersion: 1,
    bindingSchemaVersion: 1,
    provenance: { capabilityKey: 'github', generation: snapshotGeneration },
  }])
}

describe('Pi child tool manifest projection', () => {
  it('creates model-facing wrappers without renaming shared definitions', async () => {
    const calls: string[] = []
    const prepareArguments = (input: unknown) => input
    const notebook = { ...definition('NotebookEdit', calls), prepareArguments } as ToolDefinition<any, any> & {
      prepareArguments: typeof prepareArguments
    }
    const github = {
      ...definition('mcp__GitHub__CreateIssue', calls),
      description: 'Create issue',
      promptSnippet: 'Create issue',
    }
    const projected = projectPiManifestTools({
      manifest: manifest(),
      definitions: [notebook, github],
      expectedGeneration: 'generation-1',
      expectedManifestHash: manifest().manifestHash,
    })

    expect(projected.map(tool => tool.name)).toEqual(['mcp__GitHub__CreateIssue', 'notebook_edit'])
    expect(notebook.name).toBe('NotebookEdit')
    const projectedNotebook = projected.find(tool => tool.name === 'notebook_edit')
    expect(projectedNotebook).toBeDefined()
    expect(projectedNotebook!.execute).toBe(notebook.execute)
    expect((projectedNotebook as typeof notebook).prepareArguments).toBe(prepareArguments)
    await projectedNotebook!.execute('call-1', {}, undefined, undefined, undefined as never)
    expect(calls).toEqual(['NotebookEdit'])
  })

  it('rejects stale identity and missing bindings before execution', () => {
    const value = manifest()
    expect(() => projectPiManifestTools({
      manifest: value,
      definitions: [definition('NotebookEdit', [])],
      expectedGeneration: 'stale',
      expectedManifestHash: value.manifestHash,
    })).toThrow('generation mismatch')
    expect(() => projectPiManifestTools({
      manifest: value,
      definitions: [definition('NotebookEdit', [])],
      expectedGeneration: value.snapshotGeneration,
      expectedManifestHash: value.manifestHash,
    })).toThrow('definition mismatch')
  })

  it('validates SessionKey, orchestrator and descriptor-binding consistency against trusted init state', () => {
    const value = manifest()
    const expected = {
      generation: value.snapshotGeneration,
      manifestHash: value.manifestHash,
      sessionKey: { workspaceId: 'workspace-1', sessionId: 'session-1' },
      orchestrator: value.orchestrator,
    }
    expect(() => validatePiExecutionManifest(value, {
      ...expected,
      sessionKey: { workspaceId: 'workspace-1', sessionId: 'other-session' },
    } as never)).toThrow('SessionKey')
    expect(() => validatePiExecutionManifest(value, {
      ...expected,
      orchestrator: { ...value.orchestrator, concurrency: 99 },
    } as never)).toThrow('orchestrator')

    const seed: PiExecutionManifestSeedV2 = {
      surfaceVersion: 2,
      snapshotGeneration: 'generation-1',
      sessionKey: { workspaceId: 'workspace-1', sessionId: 'session-1' },
      provenance: [],
      mcpSources: [],
      orchestrator: value.orchestrator,
      staticTools: [{
        descriptor: { id: 'read', schemaVersion: 1, effect: 'read', risk: 'sensitiveRead', scheduling: 'parallel', sandboxProfile: 'workspace', backgroundable: false, cancellable: true, timeoutMs: 120_000 },
        binding: { ...value.tools.find(tool => tool.binding.piName === 'notebook_edit')!.binding },
        source: { kind: 'piBuiltin', bindingId: 'NotebookEdit' },
        modelSchema: { type: 'object' },
      }],
    }
    const inconsistent = finalizePiExecutionManifest(seed, [])
    expect(() => validatePiExecutionManifest(inconsistent, {
      generation: inconsistent.snapshotGeneration,
      manifestHash: inconsistent.manifestHash,
      sessionKey: inconsistent.sessionKey,
      orchestrator: inconsistent.orchestrator,
    } as never)).toThrow('descriptor')
  })

  it('rejects wire definitions that disagree with hashed schema or description', () => {
    const value = manifest()
    expect(() => projectPiManifestTools({
      manifest: value,
      definitions: [
        definition('NotebookEdit', []),
        { ...definition('mcp__GitHub__CreateIssue', []), description: 'changed description', parameters: { type: 'object', properties: { changed: { type: 'boolean' } } } as never },
      ],
      expectedGeneration: value.snapshotGeneration,
      expectedManifestHash: value.manifestHash,
    })).toThrow('definition mismatch')

    expect(() => projectPiManifestTools({
      manifest: value,
      definitions: [
        { ...definition('NotebookEdit', []), description: 'changed static description' },
        { ...definition('mcp__GitHub__CreateIssue', []), description: 'Create issue', promptSnippet: 'Create issue' },
      ],
      expectedGeneration: value.snapshotGeneration,
      expectedManifestHash: value.manifestHash,
    })).toThrow('definition mismatch')
  })

  it('rejects a static definition whose projected model contract misses its manifest digest', () => {
    const value = manifest()
    const notebook = value.tools.find(tool => tool.binding.piName === 'notebook_edit')!
    const tampered = finalizePiExecutionManifest({
      surfaceVersion: 2,
      snapshotGeneration: value.snapshotGeneration,
      sessionKey: value.sessionKey,
      provenance: value.provenance,
      mcpSources: value.mcpSources,
      orchestrator: value.orchestrator,
      staticTools: [{
        descriptor: notebook.descriptor,
        binding: notebook.binding,
        source: notebook.source,
        modelContractHash: '0'.repeat(64),
      }],
    } as PiExecutionManifestSeedV2, [])

    expect(() => projectPiManifestTools({
      manifest: tampered,
      definitions: [definition('NotebookEdit', [])],
      expectedGeneration: tampered.snapshotGeneration,
      expectedManifestHash: tampered.manifestHash,
    })).toThrow('model contract')
  })

  it('keeps the real bash_background contract stable with the ProcessStop session proxy', () => {
    const binding = getPiToolBinding('bash_background')
    const expectedHash = getPiStaticModelContractHash(binding.bindingName)
    const seed: PiExecutionManifestSeedV2 = {
      surfaceVersion: 2,
      snapshotGeneration: 'generation-1',
      sessionKey: { workspaceId: 'workspace-1', sessionId: 'session-1' },
      provenance: [],
      mcpSources: [],
      orchestrator: manifest().orchestrator,
      staticTools: [{
        descriptor: getHarnessToolDescriptor(binding.descriptorId),
        binding,
        source: { kind: 'piBuiltin', bindingId: binding.bindingName },
        modelContractHash: expectedHash,
      }],
    }
    const background = createBackgroundBashTool({
      emitEvent: () => undefined,
      start: async () => ({
        handle: 'process_0123456789abcdef0123456789abcdef',
        output: '',
        nextCursor: 0,
        isRunning: true,
        exitCode: null,
        signal: null,
        isolationProfile: 'workspace',
      }),
    })
    const processStop = getToolDefsAsJsonSchema({ prefix: 'mcp__session__', projection: 'pi' })
      .find(tool => tool.name === 'mcp__session__ProcessStop')!
    const withoutProxy = finalizePiExecutionManifest(seed, [])
    const withProxy = finalizePiExecutionManifest(seed, [{
      bindingName: processStop.name,
      description: processStop.description,
      inputSchema: processStop.inputSchema,
      modelSchemaVersion: 1,
      bindingSchemaVersion: 1,
      provenance: { capabilityKey: 'session', generation: seed.snapshotGeneration },
    }])

    for (const value of [withoutProxy, withProxy]) {
      const tool = value.tools.find(candidate => candidate.binding.bindingName === binding.bindingName)!
      expect(hashProjectedPiToolDefinition(value, tool, background)).toBe(expectedHash)
    }

  })

  it('accepts one CAS manifest transition only after full validation', () => {
    const current = manifest('generation-a')
    const next = manifest('generation-b')
    const definitions = [
      { name: 'NotebookEdit', description: 'NotebookEdit', inputSchema: { type: 'object' }, promptSnippet: 'NotebookEdit', promptGuidelines: [] },
      { name: 'mcp__GitHub__CreateIssue', description: 'Create issue', inputSchema: { type: 'object' }, promptSnippet: 'Create issue', promptGuidelines: [] },
    ]
    let active = current
    expect(() => validatePiExecutionManifest(active, {
      generation: next.snapshotGeneration,
      manifestHash: next.manifestHash,
      sessionKey: next.sessionKey,
      orchestrator: next.orchestrator,
    })).toThrow('generation mismatch')

    const prepared = preparePiManifestRegistration({
      current: { generation: current.snapshotGeneration, manifestHash: current.manifestHash },
      previous: { generation: current.snapshotGeneration, manifestHash: current.manifestHash },
      manifest: next,
      definitions,
      sessionKey: next.sessionKey,
      orchestrator: next.orchestrator,
    })
    active = prepared.manifest
    expect(active).not.toBe(next)
    const committed = active
    expect(prepared.definitions).toEqual(definitions)
    expect(() => validatePiExecutionManifest(active, {
      generation: next.snapshotGeneration,
      manifestHash: next.manifestHash,
      sessionKey: next.sessionKey,
      orchestrator: next.orchestrator,
    })).not.toThrow()

    expect(() => preparePiManifestRegistration({
      current: { generation: current.snapshotGeneration, manifestHash: current.manifestHash },
      previous: { generation: 'stale', manifestHash: current.manifestHash },
      manifest: next,
      definitions,
      sessionKey: next.sessionKey,
      orchestrator: next.orchestrator,
    })).toThrow('previous identity mismatch')
    expect(() => preparePiManifestRegistration({
      current: { generation: current.snapshotGeneration, manifestHash: current.manifestHash },
      previous: { generation: current.snapshotGeneration, manifestHash: current.manifestHash },
      manifest: next,
      definitions: [{ ...definitions[0]!, description: 'changed' }, definitions[1]!],
      sessionKey: next.sessionKey,
      orchestrator: next.orchestrator,
    })).toThrow('definition mismatch')
    expect(active).toBe(committed)
  })

  it('prepares a complete registration without mutating or aliasing inputs', () => {
    const current = manifest('generation-a')
    const next = manifest('generation-b')
    const definitions = [
      { name: 'NotebookEdit', description: 'NotebookEdit', inputSchema: { type: 'object' }, promptSnippet: 'NotebookEdit', promptGuidelines: [] },
      { name: 'mcp__GitHub__CreateIssue', description: 'Create issue', inputSchema: { type: 'object' }, promptSnippet: 'Create issue', promptGuidelines: [] },
    ]
    const wireManifest = structuredClone(next)
    const manifestBefore = structuredClone(wireManifest)
    const definitionsBefore = structuredClone(definitions)
    const prepared = preparePiManifestRegistration({
      current: { generation: current.snapshotGeneration, manifestHash: current.manifestHash },
      previous: { generation: current.snapshotGeneration, manifestHash: current.manifestHash },
      manifest: wireManifest,
      definitions,
      sessionKey: next.sessionKey,
      orchestrator: next.orchestrator,
    })
    expect(wireManifest).toEqual(manifestBefore)
    expect(prepared.manifest).not.toBe(wireManifest)
    expect(Object.isFrozen(prepared.manifest)).toBe(true)
    expect(Object.isFrozen(prepared.manifest.tools)).toBe(true)
    expect(Object.isFrozen(prepared.manifest.tools[0]!.binding)).toBe(true)
    expect(definitions).toEqual(definitionsBefore)
    expect(prepared.definitions).not.toBe(definitions)
    expect(prepared.definitions[0]).not.toBe(definitions[0])
    expect(prepared.definitions[0]!.inputSchema).not.toBe(definitions[0]!.inputSchema)
    expect(prepared.definitions[0]!.promptGuidelines).not.toBe(definitions[0]!.promptGuidelines)

    const rejectedDefinitions = structuredClone(definitions)
    const rejectedBefore = structuredClone(rejectedDefinitions)
    expect(() => preparePiManifestRegistration({
      current: { generation: current.snapshotGeneration, manifestHash: current.manifestHash },
      previous: { generation: current.snapshotGeneration, manifestHash: current.manifestHash },
      manifest: wireManifest,
      definitions: [{ ...rejectedDefinitions[0]!, description: 'tampered' }, rejectedDefinitions[1]!],
      sessionKey: next.sessionKey,
      orchestrator: next.orchestrator,
    })).toThrow('definition mismatch')
    expect(wireManifest).toEqual(manifestBefore)
    expect(rejectedDefinitions).toEqual(rejectedBefore)
  })

  it('projects only callable Pi names in model-facing static tool text', async () => {
    const calls: string[] = []
    const stopTask = {
      ...definition('stopTask', calls),
      description: 'Call stopTask to stop work; inspect BashOutput first.',
      promptSnippet: 'Use stopTask after BashOutput.',
      promptGuidelines: ['Call stopTask, not another tool.'],
      parameters: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description: 'Reason passed to stopTask after BashOutput.',
            enum: ['stopTask'],
            const: 'BashOutput',
          },
        },
      },
    }
    const bashOutput = {
      ...definition('mcp__session__BashOutput', calls),
      description: 'Read BashOutput.',
      parameters: { type: 'object', properties: { shellId: { type: 'string', description: 'BashOutput shell id.' } } },
    }
    const sourceDefinitions = new Map([
      ['stop_task', stopTask],
      ['mcp__session__BashOutput', bashOutput],
    ])
    const seed: PiExecutionManifestSeedV2 = {
      surfaceVersion: 2,
      snapshotGeneration: 'generation-1',
      sessionKey: { workspaceId: 'workspace-1', sessionId: 'session-1' },
      provenance: [],
      mcpSources: [],
      orchestrator: manifest().orchestrator,
      staticTools: ['stop_task', 'mcp__session__BashOutput'].map(piName => {
        const binding = getPiToolBinding(piName)
        const source = sourceDefinitions.get(piName)!
        return {
          descriptor: getHarnessToolDescriptor(binding.descriptorId),
          binding,
          source: { kind: 'piBuiltin' as const, bindingId: binding.bindingName },
          description: source.description,
          modelSchema: source.parameters,
          promptSnippet: source.promptSnippet,
          promptGuidelines: source.promptGuidelines,
        }
      }),
    }
    const value = finalizePiExecutionManifest(seed, [])
    expect([...resolvePiAllowedBindingNames(value, ['mcp__session__BashOutput'])!])
      .toEqual(['mcp__session__BashOutput'])
    expect([...resolvePiAllowedBindingNames(value, ['not-advertised'])!]).toEqual([])
    expect(resolvePiAllowedBindingNames(value)).toBeNull()
    const projected = projectPiManifestTools({
      manifest: value,
      definitions: [stopTask, bashOutput] as never,
      expectedGeneration: value.snapshotGeneration,
      expectedManifestHash: value.manifestHash,
    })
    const modelText = JSON.stringify(projected.map(tool => ({
      name: tool.name,
      description: tool.description,
      promptSnippet: tool.promptSnippet,
      promptGuidelines: (tool as { promptGuidelines?: string[] }).promptGuidelines,
      schemaDescription: (tool.parameters as any)?.properties?.reason?.description,
    })))
    expect(modelText).toContain('stop_task')
    expect(modelText).toContain('mcp__session__BashOutput')
    // The bare host spelling must be gone — but `BashOutput` is now a SUBSTRING
    // of its own piName (`mcp__session__BashOutput`), so a plain `not.toContain`
    // can no longer say that. The bounded form is the rewrite's own rule
    // (`PRESENTATION_REWRITE_PATTERNS`, `(?<![A-Za-z0-9_])`), which is also why
    // the piName is not re-rewritten into itself.
    expect(modelText).not.toMatch(/(?<![A-Za-z0-9_])stopTask(?![A-Za-z0-9_])/)
    expect(modelText).not.toMatch(/(?<![A-Za-z0-9_])BashOutput(?![A-Za-z0-9_])/)
    const projectedReason = (projected.find(tool => tool.name === 'stop_task')!.parameters as any)
      .properties.reason
    expect(projectedReason.description).toBe('Reason passed to stop_task after mcp__session__BashOutput.')
    expect(projectedReason.enum).toEqual(['stopTask'])
    expect(projectedReason.const).toBe('BashOutput')
    await projected.find(tool => tool.name === 'stop_task')!.execute('call-1', {}, undefined, undefined, undefined as never)
    expect(calls).toEqual(['stopTask'])
  })
  // sub-agents.md:324 — "[Forks](#fork-the-current-conversation) skip both
  // filters and receive the main conversation's exact tool pool."
  it('gives a fork this session exact tool pool, skipping the narrowing an imported agent gets', () => {
    const value = manifest()
    const pool = resolvePiSessionToolPool(value)

    // Everything the session itself advertises, model-visible spelling.
    expect(pool.sort()).toEqual(['mcp__GitHub__CreateIssue', 'notebook_edit'])

    // A tool-less imported agent is narrowed by our own subtractions —
    // `ask_user` always, `subagent` at the depth limit (sub-agents.md:331:
    // "`Agent`, when the subagent is at the depth limit"; nesting off here,
    // maxDepth 1, so the built child sits at the limit). A fork must not be.
    const availableToolNames = ['read', 'subagent', 'stopTask', 'ask_user', 'grep']
    const [imported] = buildPiRuntimeAgentDefinitions(
      [{
        key: 'plugin://x#agent.helper', name: 'helper', description: 'Helper',
        systemPrompt: 'Help.', capabilityGeneration: 'generation-1',
        definitionDigest: 'a'.repeat(64), provenance: 'plugin://x@generation-1',
      } as never],
      availableToolNames,
      'generation-1',
      { sessionDepth: 0, maxDepth: 1 },
    )
    expect(imported!.tools).not.toContain('subagent')
    expect(imported!.tools).not.toContain('ask_user')

    const restrictedSessionPool = resolvePiSessionToolPool(value, ['notebook_edit'])
    expect(restrictedSessionPool).toEqual(['notebook_edit'])
    // A fork of a RESTRICTED session inherits that session's pool: it is the
    // fork's "main conversation".
    expect(resolvePiSessionToolPool(value, ['mcp__GitHub__CreateIssue', 'notebook_edit']).sort())
      .toEqual(['mcp__GitHub__CreateIssue', 'notebook_edit'])
  })
})
