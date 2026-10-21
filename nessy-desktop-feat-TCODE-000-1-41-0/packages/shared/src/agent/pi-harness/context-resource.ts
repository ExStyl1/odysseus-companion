import { createHash } from 'node:crypto'
import type { CapabilitySnapshotMaterializer } from '../../capabilities/materializer.ts'
import type { AgentRuntimeView } from '../../capabilities/views.ts'
import { composeMemoryLayerBodies } from '../memory/memory-layers.ts'

export interface PiContextResourceDescriptor {
  schemaVersion: 1
  id: string
  kind: 'prompt' | 'agent-instruction' | 'context'
  content: string
  sha256: string
  provenance: string
}

export interface PiMcpContextResource {
  sourceSlug: string
  kind: 'resource' | 'prompt'
  value: unknown
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function idPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 96) || 'resource'
}

function mcpLocator(value: unknown, contentHash: string): string {
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of ['uri', 'name', 'id']) {
      if (typeof record[key] === 'string' && record[key]) return record[key].slice(0, 256)
    }
  }
  return contentHash.slice(0, 12)
}

export async function materializePiContextResources(input: {
  view: AgentRuntimeView
  materializer: CapabilitySnapshotMaterializer
  mcpResources: readonly PiMcpContextResource[]
}): Promise<readonly PiContextResourceDescriptor[]> {
  const descriptors: PiContextResourceDescriptor[] = []
  const addPinned = async (
    resourceType: 'instruction' | 'memory',
    key: string,
    kind: PiContextResourceDescriptor['kind'],
    resource: AgentRuntimeView['skills'][number]['resource'],
    providedContent?: string,
  ) => {
    const content = providedContent ?? await input.materializer.readText(resource)
    const contentHash = sha256(content)
    descriptors.push({
      schemaVersion: 1,
      id: `cap-${resourceType}-${idPart(key)}-${sha256(`${resourceType}:${key}`).slice(0, 8)}-${contentHash.slice(0, 12)}`,
      kind,
      content,
      sha256: contentHash,
      provenance: `${key}@${input.view.generation}`,
    })
  }

  // ONE composer call over BOTH pinned lists, exactly as the host's block does
  // (R77). An instruction file's `@path` import can name a sibling instruction
  // file the inventory already discovered — `memory.md:95`'s own flagship shape
  // — and only a pass that sees `promptLayers` and `memory` together can decide,
  // once, which delivery carries that body.
  const composedLayers = await composeMemoryLayerBodies(
    [...input.view.promptLayers, ...input.view.memory],
    layer => input.materializer.readText(layer.resource),
  )
  for (const layer of input.view.promptLayers) {
    // `memory.md:161` — block-level HTML comments are stripped from a CLAUDE.md
    // before its content is injected. The composer owns that strip now, so the
    // host's promptLayers loop and this one cannot drift apart.
    //
    // An inlined layer already rides inside its importer's descriptor.
    if (composedLayers.inlined.has(layer)) continue
    await addPinned('instruction', layer.key, 'agent-instruction', layer.resource, composedLayers.bodies.get(layer) ?? '')
  }
  // The SECOND live delivery of a memory body — the descriptor's content is
  // registered as a curated Pi resource and its `estimateTokens` is what
  // `/context` reports under `memory_files`. It runs the SAME composer as the
  // host's pinned block (`BaseAgent.composePinnedCapabilityContext`): the
  // 200-line / 25 KB index cap (`memory.md:384`), the block-HTML-comment strip
  // (`memory.md:161`) and `@path` expansion (`memory.md:95`) are one rule
  // applied once. Doing any of the three at one site and not the other ships two
  // different bodies for one file and makes the context readout disagree with
  // the block the model sees — which is exactly what expansion did before this:
  // the host deleted every recognised import line and this projection kept it as
  // literal prose.
  for (const memory of input.view.memory) {
    // An inlined layer already rides inside its importer's descriptor; a second
    // descriptor would bundle the same bytes twice and double-count it in
    // `/context`.
    if (composedLayers.inlined.has(memory)) continue
    await addPinned('memory', memory.key, 'context', memory.resource, composedLayers.bodies.get(memory))
  }
  for (const resource of input.mcpResources) {
    // `resources/list` is server-controlled discovery metadata, not trusted
    // instruction content. It must be read explicitly through the MCP boundary
    // and never enter Pi's high-authority agentsFiles/system prompt projection.
    if (resource.kind === 'resource') continue
    let content: string | undefined
    try { content = JSON.stringify(resource.value) }
    catch { throw new Error(`Invalid MCP context resource value: ${idPart(resource.sourceSlug)}/${resource.kind}`) }
    if (content === undefined) {
      throw new Error(`Invalid MCP context resource value: ${idPart(resource.sourceSlug)}/${resource.kind}`)
    }
    const contentHash = sha256(content)
    const locator = mcpLocator(resource.value, contentHash)
    const identityHash = sha256(`${resource.sourceSlug}:${resource.kind}:${locator}`).slice(0, 8)
    descriptors.push({
      schemaVersion: 1,
      id: `mcp-${idPart(resource.sourceSlug)}-${resource.kind}-${identityHash}-${contentHash.slice(0, 12)}`,
      kind: resource.kind === 'prompt' ? 'prompt' : 'context',
      content,
      sha256: contentHash,
      provenance: `mcp:${idPart(resource.sourceSlug)}:${resource.kind}:${identityHash}:${contentHash.slice(0, 12)}@${input.view.generation}`,
    })
  }

  if (new Set(descriptors.map(resource => resource.id)).size !== descriptors.length) {
    throw new Error('Duplicate Pi context resource id')
  }
  for (const descriptor of descriptors) Object.freeze(descriptor)
  return Object.freeze(descriptors)
}
