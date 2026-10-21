/**
 * F1.756 (origin release sitting SIT-j, case D13, 2026-09-25) — a call to a
 * tool a whole-tool deny rule removed is a REFUSAL that names the rule, not an
 * internal-error row.
 *
 * `permissions.md#manage-permissions`: a bare tool name "removes the tool from
 * Claude's context entirely", and "If you add such a rule mid-session, Claude
 * can't call the tool from its next tool call on". On Pi the removal is the
 * manifest's whole-tool deny filter. A model that loaded the tool before the
 * rule landed can still call it: the Pi SDK emits `tool_execution_start` for
 * every call before it looks the tool up, then answers "Tool <name> not found".
 * The adapter found no manifest entry and threw, so the transcript showed "A Pi
 * subprocess event (tool_execution_start) could not be processed: Pi tool event
 * is not advertised by the active manifest: …" and no rule was ever named.
 *
 * Every piece below is production's: the manifest seed, the deny filter, the
 * refusal builder, the adapter, and — in the last block — PiAgent's own build
 * and publish of the manifest.
 */
import { describe, expect, it, spyOn } from 'bun:test'

import type { EffectiveCapabilitySnapshot } from '../../../capabilities/resolver.ts'
import type { AgentRuntimeView } from '../../../capabilities/views.ts'
import { permissionsConfigCache } from '../../permissions-config.ts'
import { PiAgent } from '../../pi-agent.ts'
import { parseClaudeRuleString } from '../../pi-harness/claude-permission-rules.ts'
import {
  createPiExecutionManifestSeed,
  finalizePiExecutionManifest,
  type PiDynamicToolDefinition,
  type PiExecutionManifestSeedV2,
  type ResolvedHarnessTool,
} from '../../pi-harness/harness-manifest.ts'
import { compilePermissionDslV1 } from '../../pi-harness/permission-dsl.ts'
import {
  filterCapabilityIdentitiesByWholeToolDenyUnderSessionToolAlias,
  piManifestCapabilityIdentities,
  piWholeToolDenyRefusals,
} from '../../pi-harness/session-tool-rule-alias.ts'
import { canonicalizeForDecision } from '../../session-filesystem-scope.ts'
import type { BackendConfig, CapabilityTurnRuntime } from '../types.ts'
import { PiEventAdapter } from './event-adapter.ts'

const GENERATION = 'generation-f1-756'
const SERVER = 'sit-probe'
const DENIED = `mcp__${SERVER}__get_note`
const KEPT = `mcp__${SERVER}__archive_note`
const RULE_SENTENCE = `Denied by readable permission policy rule \`${DENIED}\` (project scope).`
const SDK_NOT_FOUND = `Tool ${DENIED} not found`

const view: AgentRuntimeView = {
  generation: GENERATION,
  sources: [], skills: [], mcpServers: [], hooks: [], automations: [], agents: [],
  promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [],
}

const snapshot = {
  context: { workspaceId: 'ws', sessionId: 'parent', projectTrustState: 'none', projectTrustRevision: '' },
  generation: GENERATION,
  leaseId: 'lease-f1-756',
  entries: [],
  installedPlugins: [],
  diagnostics: [],
} as EffectiveCapabilitySnapshot

const capabilityKey = `native:workspace:mcp:${SERVER}`

function seed(): PiExecutionManifestSeedV2 {
  return {
    ...createPiExecutionManifestSeed({ snapshot, view, sessionKey: { workspaceId: 'ws', sessionId: 'parent' } }),
    provenance: [{ capabilityKey, generation: GENERATION }],
    mcpSources: [{ wireName: SERVER, capabilityKey, generation: GENERATION }],
  }
}

const mcpTool = (bindingName: string): PiDynamicToolDefinition => ({
  bindingName,
  description: 'A proxied MCP tool.',
  inputSchema: { type: 'object', properties: {} },
  modelSchemaVersion: 1,
  bindingSchemaVersion: 1,
  provenance: { capabilityKey, generation: GENERATION },
})

/** A project-scope rule, as `.claude/settings.json`'s `deny` array carries it in D13. */
function compile(rule: string) {
  const parsed = parseClaudeRuleString(rule, 'deny')
  if (!parsed.rule) throw new Error(`Rule is inert and cannot be compiled: ${rule}`)
  return compilePermissionDslV1({
    generation: GENERATION,
    projectTrusted: true,
    canonicalizeRoot: canonicalizeForDecision,
    layers: [{
      scope: 'project',
      sourceDigest: 'f1-756',
      document: { version: 1, rules: [{ id: 'f1-756', ...parsed.rule, text: rule }] },
    }],
  })
}

/** `buildExecutionManifestForCurrentTurn`'s derivation, then the refusals it hands the adapter. */
function denied(rule: string) {
  const manifestSeed = seed()
  const dynamicTools = [mcpTool(DENIED), mcpTool(KEPT)]
  const program = compile(rule)
  const identities = piManifestCapabilityIdentities(manifestSeed.staticTools, dynamicTools)
  const allowedBindingNames = filterCapabilityIdentitiesByWholeToolDenyUnderSessionToolAlias(identities, program)
    .map(identity => identity.bindingName)
  const manifest = finalizePiExecutionManifest(manifestSeed, dynamicTools, { allowedBindingNames })
  return { manifest, refusals: piWholeToolDenyRefusals(manifest, identities, program) }
}

function adapterFor(rule: string) {
  const { manifest, refusals } = denied(rule)
  const adapter = new PiEventAdapter()
  adapter.setExecutionManifest(manifest, refusals)
  adapter.startTurn()
  return { adapter, manifest }
}

const events = (adapter: PiEventAdapter, event: Record<string, unknown>) => [...adapter.adaptEvent(event as never)] as Array<Record<string, unknown>>

const start = (toolCallId: string, toolName: string) => ({ type: 'tool_execution_start', toolCallId, toolName, args: {} })
const end = (toolCallId: string, text: string, isError: boolean) => ({
  type: 'tool_execution_end', toolCallId, isError, result: { content: [{ type: 'text', text }] },
})

describe('F1.756 · a whole-tool-denied call names the rule', () => {
  it('draws a card for the removed tool and its result names the rule, beside what the model was told', () => {
    const { adapter, manifest } = adapterFor(DENIED)
    // Precondition: the rule really removed it, and only it.
    expect(manifest.tools.map(tool => tool.binding.piName)).not.toContain(DENIED)
    expect(manifest.tools.map(tool => tool.binding.piName)).toContain(KEPT)

    const started = events(adapter, start('call-denied', DENIED))
    expect(started).toHaveLength(1)
    expect(started[0]).toMatchObject({ type: 'tool_start', toolName: DENIED, toolUseId: 'call-denied' })
    // The manifest holds no entry for it, so the card claims none.
    expect(started[0]).not.toHaveProperty('manifestHash')
    expect(started[0]).not.toHaveProperty('semanticId')

    const ended = events(adapter, end('call-denied', SDK_NOT_FOUND, true))
    expect(ended).toHaveLength(1)
    expect(ended[0]).toMatchObject({ type: 'tool_result', toolUseId: 'call-denied', isError: true })
    const result = String(ended[0]!.result)
    expect(result.startsWith(RULE_SENTENCE)).toBe(true)
    expect(result).toContain(`the Pi runtime answered the model: ${SDK_NOT_FOUND}`)
  })

  it('still throws for an unadvertised name no deny rule removed, and leaves advertised tools and real output alone', () => {
    const { adapter, manifest } = adapterFor(DENIED)
    // The integrity check the throw exists for is kept.
    expect(() => events(adapter, start('call-unknown', `mcp__${SERVER}__made_up`))).toThrow('not advertised by the active manifest')

    // The tool the rule did not name resolves through the manifest, as before.
    const kept = events(adapter, start('call-kept', KEPT))
    expect(kept[0]).toMatchObject({ type: 'tool_start', toolName: KEPT, manifestHash: manifest.manifestHash })
    expect(String(events(adapter, end('call-kept', 'archived', false))[0]!.result)).toBe('archived')

    // A result the SDK did NOT fail is shown as it came, never relabelled as a refusal.
    events(adapter, start('call-ran', DENIED))
    expect(String(events(adapter, end('call-ran', 'note body', false))[0]!.result)).toBe('note body')
  })

  it('lists nothing when no rule removes a whole tool (a scoped rule gates, it does not remove)', () => {
    const { manifest, refusals } = denied('Bash(rm *)')
    expect(manifest.tools.map(tool => tool.binding.piName)).toContain(DENIED)
    expect(refusals).toBeUndefined()
    const adapter = new PiEventAdapter()
    adapter.setExecutionManifest(manifest, refusals)
    adapter.startTurn()
    expect(() => events(adapter, start('call-unknown', `mcp__${SERVER}__made_up`))).toThrow('not advertised by the active manifest')
  })
})

// ------------------------------------------------------------------
// PiAgent: the refusals ride its own manifest build into its own adapter
// ------------------------------------------------------------------

function agentConfig(): BackendConfig {
  return {
    provider: 'pi', isHeadless: true, skipConfigWatcher: true,
    workspace: { id: 'ws', name: 'ws', rootPath: '/tmp/ws', workspaceRootPath: '/tmp/ws', sessionRootPath: '/tmp/sessions/ws' } as never,
    session: { id: 'parent', workspaceId: 'ws', createdAt: 1, lastUsedAt: 1 } as never,
  } as BackendConfig
}

/** An MCP proxy tool as a static fixture, the way `pi-agent-mcp-pattern-alias.test.ts` builds one. */
function staticMcpTool(name: string): ResolvedHarnessTool {
  return {
    descriptor: { id: 'mcp_dynamic' },
    binding: {
      provider: 'pi', surfaceVersion: 2, piName: name, modelSchemaVersion: 1, bindingName: name,
      bindingSchemaVersion: 1, handlerName: 'mcp_dynamic', handlerSchemaVersion: 1,
      descriptorId: 'mcp_dynamic', permissionName: name,
    },
    source: { kind: 'piBuiltin', bindingId: name },
  } as never
}

describe('F1.756 · PiAgent hands the refusals to its adapter with the manifest', () => {
  it('a manifest PiAgent builds under a whole-tool deny and publishes makes its adapter name the rule', async () => {
    const agent = new PiAgent(agentConfig())
    const state = agent as never as {
      subprocess: unknown
      send(message: Record<string, unknown>): void
      pendingManifestRegistrations: Map<string, { resolve(value: unknown): void }>
      permissionManager: { getCapabilityPermissionsContext?: () => unknown }
      buildExecutionManifestForCurrentTurn(): { manifest: { manifestHash: string; tools: Array<{ binding: { piName: string } }> } }
      publishExecutionManifest(execution: unknown): Promise<void>
      adapter: PiEventAdapter
    }
    const manifestSeed = seed()
    agent.setCapabilityTurnRuntime({
      view,
      materializer: {
        assertActive() {}, async verifyPlugin() {}, async resolvePath() { return '' },
        async readText() { return '' }, resolveCredential() { throw new Error('unused') },
      },
      piExecutionManifestSeed: { ...manifestSeed, staticTools: [...manifestSeed.staticTools, staticMcpTool(DENIED), staticMcpTool(KEPT)] },
    } as CapabilityTurnRuntime)
    state.permissionManager.getCapabilityPermissionsContext = () => ({ workspaceRootPath: '/tmp/ws' })
    const merged = spyOn(permissionsConfigCache, 'getMergedConfig').mockReturnValue({ permissionDsl: compile(DENIED) } as never)
    try {
      const execution = state.buildExecutionManifestForCurrentTurn()
      expect(execution.manifest.tools.map(tool => tool.binding.piName)).not.toContain(DENIED)

      state.subprocess = { stdin: { writable: true } }
      state.send = (message) => {
        if (message.type === 'register_tools') {
          state.pendingManifestRegistrations.get(message.id as string)
            ?.resolve({ generation: GENERATION, manifestHash: execution.manifest.manifestHash })
        }
      }
      await state.publishExecutionManifest(execution)

      state.adapter.startTurn()
      expect(events(state.adapter, start('call-denied', DENIED))[0]).toMatchObject({ type: 'tool_start', toolName: DENIED })
      expect(String(events(state.adapter, end('call-denied', SDK_NOT_FOUND, true))[0]!.result).startsWith(RULE_SENTENCE)).toBe(true)
    } finally {
      merged.mockRestore()
      state.subprocess = null
      agent.destroy()
    }
  })
})
