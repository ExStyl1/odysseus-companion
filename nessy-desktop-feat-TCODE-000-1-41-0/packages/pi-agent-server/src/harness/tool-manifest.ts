import type { ToolDefinition } from '@earendil-works/pi-coding-agent'

import {
  assertPiExecutionManifestIdentity,
  hashPiModelVisibleToolContract,
  normalizePiOrchestratorConfig,
  sealPiExecutionManifest,
  type PiOrchestratorConfig,
  type PiExecutionManifestV2,
} from '../../../shared/src/agent/pi-harness/harness-manifest.ts'
import {
  PI_STATIC_MODEL_CONTRACT_HASHES,
  PI_TOOL_PRESENTATION_REWRITES,
  getHarnessToolDescriptor,
  getPiToolBindingByBindingName,
} from '../../../shared/src/agent/pi-harness/harness-tool-descriptor.ts'

type ExpectedManifestIdentity = {
  generation: string
  manifestHash: string
  sessionKey: { workspaceId: string; sessionId: string }
  orchestrator: PiOrchestratorConfig
}

export interface PiManifestWireDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  promptSnippet?: string
  promptGuidelines?: readonly string[]
}

export interface PreparedPiManifestRegistration {
  manifest: PiExecutionManifestV2
  definitions: PiManifestWireDefinition[]
}

/**
 * THE presentedName resolution rule for the manifest. Projected, model-facing
 * definitions present the canonical piName (`notebook_edit`) while raw host
 * definitions keep the bindingName (`NotebookEdit`), and both reach the runtime
 * as `presentedName`. Manifest validation rejects duplicates on both axes, so
 * the union lookup is unambiguous — and a lookup keyed on one axis silently
 * misses every binding whose two spellings diverge.
 *
 * Session tools stopped being an example of that after the wire-name
 * unification put the registry id on both of their axes; the two natives
 * (`notebook_edit`/`NotebookEdit`, `stop_task`/`stopTask`) are what the union
 * still serves, and dynamic MCP bindings set the two equal by construction.
 */
export function findPiManifestToolsByPresentedName(
  manifest: PiExecutionManifestV2,
  presentedName: string,
): PiExecutionManifestV2['tools'][number][] {
  return manifest.tools.filter(value => value.binding.piName === presentedName
    || value.binding.bindingName === presentedName)
}

export function findPiManifestToolByPresentedName(
  manifest: PiExecutionManifestV2,
  presentedName: string,
): PiExecutionManifestV2['tools'][number] | undefined {
  return findPiManifestToolsByPresentedName(manifest, presentedName)[0]
}

/**
 * Child-agent restrictions are expressed with model-visible Pi names, while
 * runtime definitions retain their host binding names. Resolve that boundary
 * through the signed manifest so renamed tools (for example BashOutput) stay
 * callable without accepting an unadvertised spelling.
 */
export function resolvePiAllowedBindingNames(
  manifest: PiExecutionManifestV2,
  allowedToolNames?: readonly string[],
): ReadonlySet<string> | null {
  if (!allowedToolNames) return null
  const bindings = new Set<string>()
  for (const allowedName of allowedToolNames) {
    const matches = findPiManifestToolsByPresentedName(manifest, allowedName)
    if (matches.length > 1) {
      throw new Error(`Ambiguous allowed Pi tool spelling: ${allowedName}`)
    }
    if (matches[0]) bindings.add(matches[0].binding.bindingName)
  }
  return bindings
}

/**
 * This session's own model-visible tool pool, in the same Pi-name spelling a
 * child's `restrictions.tools` uses.
 *
 * sub-agents.md:324 — "[Forks](#fork-the-current-conversation) skip both filters
 * and receive the main conversation's exact tool pool." That is why this is the
 * manifest verbatim (plus the deferred-MCP candidates, which the session can
 * still load mid-turn) and NOT the narrowed list
 * `buildPiRuntimeAgentDefinitions` computes for an imported agent: that one
 * subtracts `ORCHESTRATION_TOOLS` and `SUBAGENT_UNAVAILABLE_TOOLS`, which is
 * exactly the filtering a fork is documented to skip.
 *
 * `allowedToolNames` is this session's OWN ceiling (a child session receives one
 * as `piAllowedTools`); a fork of a restricted session inherits the restricted
 * pool, since that session is its "main conversation".
 */
export function resolvePiSessionToolPool(
  manifest: PiExecutionManifestV2,
  allowedToolNames?: readonly string[],
): readonly string[] {
  const allowedBindings = resolvePiAllowedBindingNames(manifest, allowedToolNames)
  const names = manifest.tools
    .filter(tool => !allowedBindings || allowedBindings.has(tool.binding.bindingName))
    .map(tool => tool.binding.piName)
  const deferred = allowedToolNames
    ? manifest.deferredMcp.candidatePiNames.filter(name => allowedToolNames.includes(name))
    : manifest.deferredMcp.candidatePiNames
  return [...new Set([...names, ...deferred])]
}

export function validatePiExecutionManifest(
  manifest: PiExecutionManifestV2,
  expected: ExpectedManifestIdentity,
): void {
  assertPiExecutionManifestIdentity(manifest, expected)
  if (manifest.sessionKey.workspaceId !== expected.sessionKey.workspaceId
    || manifest.sessionKey.sessionId !== expected.sessionKey.sessionId) {
    throw new Error('Pi execution manifest SessionKey mismatch')
  }
  const normalizedOrchestrator = normalizePiOrchestratorConfig(manifest.orchestrator)
  if (canonical(normalizedOrchestrator) !== canonical(manifest.orchestrator)
    || canonical(manifest.orchestrator) !== canonical(expected.orchestrator)) {
    throw new Error('Pi execution manifest orchestrator mismatch')
  }
  if (new Set(manifest.mcpSources.map(source => source.wireName)).size !== manifest.mcpSources.length) {
    throw new Error('Pi execution manifest contains an ambiguous MCP wireName')
  }
  const provenance = new Set(manifest.provenance.map(value => `${value.capabilityKey}\0${value.generation}`))
  for (const value of manifest.provenance) {
    if (value.generation !== manifest.snapshotGeneration) {
      throw new Error('Pi execution manifest provenance generation mismatch')
    }
  }
  for (const source of manifest.mcpSources) {
    if (source.generation !== manifest.snapshotGeneration
      || !provenance.has(`${source.capabilityKey}\0${source.generation}`)) {
      throw new Error(`Pi execution manifest MCP provenance mismatch: ${source.wireName}`)
    }
  }
  const piNames = new Set<string>()
  const bindingNames = new Set<string>()
  for (const tool of manifest.tools) {
    const { binding, descriptor } = tool
    if (!binding.piName || !binding.bindingName || !binding.handlerName) {
      throw new Error('Pi execution manifest contains an incomplete binding')
    }
    if (binding.provider !== 'pi' || binding.surfaceVersion !== 2
      || binding.modelSchemaVersion !== 1 || binding.bindingSchemaVersion !== 1
      || binding.handlerSchemaVersion !== 1 || descriptor.schemaVersion !== 1) {
      throw new Error(`Pi execution manifest schema version gap for ${binding.piName}`)
    }
    if (binding.descriptorId !== descriptor.id
      || canonical(getHarnessToolDescriptor(binding.descriptorId)) !== canonical(descriptor)) {
      throw new Error(`Pi execution manifest descriptor mismatch for ${binding.piName}`)
    }
    const known = getPiToolBindingByBindingName(binding.bindingName)
    if (known) {
      if (canonical(known) !== canonical(binding)
        || tool.source.kind !== 'piBuiltin'
        || tool.source.bindingId !== binding.bindingName) {
        throw new Error(`Pi execution manifest binding mismatch for ${binding.piName}`)
      }
      if (tool.description === undefined
        && PI_STATIC_MODEL_CONTRACT_HASHES[binding.bindingName]
        && !/^[a-f0-9]{64}$/.test(tool.modelContractHash ?? '')) {
        throw new Error(`Pi execution manifest static model contract missing for ${binding.piName}`)
      }
    } else {
      if (tool.source.kind !== 'resolvedCapability') {
        throw new Error(`Pi execution manifest dynamic binding/provenance mismatch for ${binding.piName}`)
      }
      const source = tool.source
      if (binding.descriptorId !== 'mcp_dynamic'
        || binding.piName !== binding.bindingName
        || binding.handlerName !== binding.bindingName
        || !provenance.has(`${source.capabilityKey}\0${source.generation}`)
        || !manifest.mcpSources.some(value => value.capabilityKey === source.capabilityKey
          && value.generation === source.generation)) {
        throw new Error(`Pi execution manifest dynamic binding/provenance mismatch for ${binding.piName}`)
      }
      if (typeof tool.description !== 'string' || !tool.modelSchema) {
        throw new Error(`Pi execution manifest dynamic schema missing for ${binding.piName}`)
      }
    }
    if (piNames.has(binding.piName)) throw new Error(`Pi execution manifest duplicate piName: ${binding.piName}`)
    if (bindingNames.has(binding.bindingName)) throw new Error(`Pi execution manifest duplicate bindingName: ${binding.bindingName}`)
    piNames.add(binding.piName)
    bindingNames.add(binding.bindingName)
  }
}

function validateDefinitions(
  manifest: PiExecutionManifestV2,
  definitions: ReadonlyMap<string, ToolDefinition<any, any>>,
): void {
  for (const tool of manifest.tools) {
    const definition = definitions.get(tool.binding.bindingName)
    if (!definition && manifest.deferredMcp.candidatePiNames.includes(tool.binding.piName)) continue
    if (!definition) throw new Error(`Pi execution manifest definition mismatch for ${tool.binding.piName}: missing binding`)
    const promptGuidelines = (definition as { promptGuidelines?: readonly string[] }).promptGuidelines
    if (tool.description !== undefined && (definition.description !== tool.description
      || canonical(definition.parameters) !== canonical(tool.modelSchema)
      || canonical(definition.promptSnippet) !== canonical(tool.promptSnippet)
      || canonical(promptGuidelines) !== canonical(tool.promptGuidelines))) {
      throw new Error(`Pi execution manifest definition mismatch for ${tool.binding.piName}`)
    }
  }
}

export function validatePiManifestWireDefinitions(
  manifest: PiExecutionManifestV2,
  definitions: readonly PiManifestWireDefinition[],
): void {
  const seen = new Set<string>()
  for (const definition of definitions) {
    if (seen.has(definition.name)) throw new Error(`Duplicate Pi tool definition binding: ${definition.name}`)
    seen.add(definition.name)
    const tool = manifest.tools.find(value => value.binding.bindingName === definition.name)
    if (!tool || tool.description !== definition.description
      || canonical(tool.modelSchema) !== canonical(definition.inputSchema)
      || canonical(tool.promptSnippet) !== canonical(definition.promptSnippet)
      || canonical(tool.promptGuidelines) !== canonical(definition.promptGuidelines ?? [])) {
      throw new Error(`Pi execution manifest definition mismatch for ${definition.name}`)
    }
  }
  for (const tool of manifest.tools) {
    if (tool.modelSchema && !seen.has(tool.binding.bindingName)) {
      throw new Error(`Pi execution manifest missing wire definition: ${tool.binding.bindingName}`)
    }
  }
}

export function preparePiManifestRegistration(input: {
  current: { generation: string; manifestHash: string }
  previous: { generation: string; manifestHash: string }
  manifest: PiExecutionManifestV2
  definitions: readonly PiManifestWireDefinition[]
  sessionKey: { workspaceId: string; sessionId: string }
  orchestrator: PiOrchestratorConfig
}): PreparedPiManifestRegistration {
  if (input.current.generation !== input.previous.generation
    || input.current.manifestHash !== input.previous.manifestHash) {
    throw new Error('Pi execution manifest previous identity mismatch')
  }
  validatePiExecutionManifest(input.manifest, {
    generation: input.manifest.snapshotGeneration,
    manifestHash: input.manifest.manifestHash,
    sessionKey: input.sessionKey,
    orchestrator: input.orchestrator,
  })
  validatePiManifestWireDefinitions(input.manifest, input.definitions)
  return {
    manifest: sealPiExecutionManifest(input.manifest),
    definitions: input.definitions.map(definition => ({
      ...definition,
      inputSchema: structuredClone(definition.inputSchema),
      ...(definition.promptGuidelines
        ? { promptGuidelines: Object.freeze([...definition.promptGuidelines]) }
        : {}),
    })),
  }
}

export function projectPiManifestTools(input: {
  manifest: PiExecutionManifestV2
  definitions: readonly ToolDefinition<any, any>[]
  expectedGeneration: string
  expectedManifestHash: string
  expectedSessionKey?: { workspaceId: string; sessionId: string }
  expectedOrchestrator?: PiOrchestratorConfig
}): ToolDefinition<any, any>[] {
  validatePiExecutionManifest(input.manifest, {
    generation: input.expectedGeneration,
    manifestHash: input.expectedManifestHash,
    sessionKey: input.expectedSessionKey ?? input.manifest.sessionKey,
    orchestrator: input.expectedOrchestrator ?? input.manifest.orchestrator,
  })
  const definitions = new Map<string, ToolDefinition<any, any>>()
  for (const definition of input.definitions) {
    if (definitions.has(definition.name)) throw new Error(`Duplicate Pi tool definition binding: ${definition.name}`)
    definitions.set(definition.name, definition)
  }
  validateDefinitions(input.manifest, definitions)
  return input.manifest.tools.flatMap(tool => {
    const definition = definitions.get(tool.binding.bindingName)
    if (!definition) {
      if (input.manifest.deferredMcp.candidatePiNames.includes(tool.binding.piName)) return []
      throw new Error(`Pi execution manifest missing binding: ${tool.binding.bindingName}`)
    }
    const projected = projectPiToolDefinition(input.manifest, tool, definition)
    if (tool.modelContractHash
      && hashProjectedPiToolDefinition(input.manifest, tool, definition) !== tool.modelContractHash) {
      throw new Error(`Pi execution manifest model contract mismatch for ${tool.binding.piName}`)
    }
    return [projected]
  })
}

/**
 * {@link PI_TOOL_PRESENTATION_REWRITES}, compiled once as WORD matches.
 *
 * Q10-3: the rewrite ran through `String.replaceAll`, which has no notion of a
 * word, so `Ls` — the permissionName of the `ls` binding — was replaced inside
 * the English word `URLs`. `web_search`'s description ("Returns titles, URLs,
 * and snippets") and `workflow`'s guidance ("paths, URLs, and inline source are
 * rejected") reached the model as `URls`: corrupted prose in the one text whose
 * job is to tell the model how to call the tool.
 *
 * The constant's own note already warns that the rewritable spellings "include
 * ordinary English words (`Read`, `Write`, `Edit`, `Find`, `Task`, `Ls`)" and
 * that keeping them out of pinned text "cannot be kept by inspection". This is
 * the rule that makes that warning enforceable instead of aspirational.
 *
 * Lookarounds rather than `\b`, and over the same `[A-Za-z0-9_]` class a tool
 * name is built from: `\b` is defined relative to `\w`, so it would sit in the
 * wrong place for any name that began or ended with `_` — and every session
 * binding's spelling is `mcp__session__…`. The names contain no regex
 * metacharacter today, and are escaped anyway so that a later one cannot turn a
 * rewrite into a wildcard.
 *
 * Two pinned model contracts move with this — `web_search` and `workflow` — and
 * their hashes in `PI_STATIC_MODEL_CONTRACT_HASHES` are regenerated in the same
 * commit. That the pin loop in `live-manifest-contract.test.ts` reports exactly
 * those two, and no third, is the evidence that no OTHER pinned text was relying
 * on a substring match.
 */
const PRESENTATION_REWRITE_PATTERNS: readonly { pattern: RegExp; piName: string }[] = Object.freeze(
  PI_TOOL_PRESENTATION_REWRITES.map(replacement => Object.freeze({
    pattern: new RegExp(
      `(?<![A-Za-z0-9_])${replacement.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`,
      'g',
    ),
    piName: replacement.piName,
  })),
)

/**
 * The presentation rewrite is a property of the static binding REGISTRY
 * ({@link PI_TOOL_PRESENTATION_REWRITES}), never of this manifest's tool list.
 *
 * Deriving it from `manifest.tools` made a pinned tool's model-visible text
 * depend on which OTHER tools the session carried, and a child session's pool is
 * an arbitrary subset its agent author wrote — so `subagent`, whose guidance
 * names `stopTask`, hashed one way in a parent and another in any child granted
 * `Agent` without `TaskStop`, and every such child died on its first turn with
 * the mismatch below (Q6-D1). See the constant for the full reasoning.
 *
 * `manifest` is still taken so a projection is always made against the manifest
 * it belongs to, and so the two exported entry points keep one shape.
 */
function projectPiToolDefinition(
  manifest: PiExecutionManifestV2,
  tool: PiExecutionManifestV2['tools'][number],
  definition: ToolDefinition<any, any>,
): ToolDefinition<any, any> {
  if (!definition.parameters || typeof definition.parameters !== 'object') {
    throw new Error(`Pi execution manifest schema missing for binding: ${tool.binding.bindingName}`)
  }
  const rewriteText = (text: string | undefined): string | undefined => {
    if (text === undefined) return undefined
    return PRESENTATION_REWRITE_PATTERNS.reduce(
      (value, replacement) => value.replace(replacement.pattern, replacement.piName),
      text,
    )
  }
  const rewriteSchemaDescriptions = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(child => (
      child && typeof child === 'object' ? rewriteSchemaDescriptions(child) : child
    ))
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key,
      key === 'description' && typeof child === 'string'
        ? rewriteText(child)
        : rewriteSchemaDescriptions(child),
    ]))
  }
  const sourceDescription = tool.description ?? definition.description
  const sourcePromptSnippet = tool.description === undefined ? definition.promptSnippet : tool.promptSnippet
  const sourcePromptGuidelines = tool.description === undefined
    ? (definition as { promptGuidelines?: readonly string[] }).promptGuidelines
    : tool.promptGuidelines
  const sourceParameters = tool.description === undefined ? definition.parameters : tool.modelSchema
  return {
    ...definition,
    name: tool.binding.piName,
    label: tool.binding.piName,
    description: rewriteText(sourceDescription) ?? tool.binding.piName,
    parameters: rewriteSchemaDescriptions(sourceParameters) as ToolDefinition<any, any>['parameters'],
    promptSnippet: rewriteText(sourcePromptSnippet),
    promptGuidelines: sourcePromptGuidelines?.map(value => rewriteText(value)!),
  }
}

export function hashProjectedPiToolDefinition(
  manifest: PiExecutionManifestV2,
  tool: PiExecutionManifestV2['tools'][number],
  definition: ToolDefinition<any, any>,
): string {
  const projected = projectPiToolDefinition(manifest, tool, definition)
  return hashPiModelVisibleToolContract({
    name: projected.name,
    description: projected.description,
    schema: projected.parameters,
    promptSnippet: projected.promptSnippet,
    promptGuidelines: (projected as { promptGuidelines?: readonly string[] }).promptGuidelines,
    provenance: tool.source,
  })
}

function canonical(value: unknown): string {
  if (value === undefined || value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`
  }
  throw new Error(`Unsupported manifest value: ${typeof value}`)
}

/**
 * F1.1127 — the eager projection of ONE manifest tool ({@link projectPiManifestTools}' per-tool step, model-contract
 * check included), for a tool registered after the session started: `mcp__tool_load`'s registration
 * (`extensions/deferred-mcp-extension.ts`). The result is a fresh, unfrozen copy, so the adapter can widen its schema
 * for Nessy's metadata as it does on the eager path.
 */
export function projectPiManifestTool(
  manifest: PiExecutionManifestV2,
  tool: PiExecutionManifestV2['tools'][number],
  definition: ToolDefinition<any, any>,
): ToolDefinition<any, any> {
  const projected = projectPiToolDefinition(manifest, tool, definition)
  if (tool.modelContractHash && hashProjectedPiToolDefinition(manifest, tool, definition) !== tool.modelContractHash) {
    throw new Error(`Pi execution manifest model contract mismatch for ${tool.binding.piName}`)
  }
  return projected
}
