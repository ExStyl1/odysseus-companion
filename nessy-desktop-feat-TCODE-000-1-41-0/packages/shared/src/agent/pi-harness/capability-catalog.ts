import { createHash } from 'node:crypto'

export const CAPABILITY_CATALOG_VERSION = 1 as const
export const MAX_CAPABILITY_CATALOG_ENTRIES = 10_000
export const DEFAULT_CAPABILITY_SEARCH_RESULTS = 8
export const MAX_CAPABILITY_SEARCH_RESULTS = 50
export const MAX_CAPABILITY_ACTIVATIONS = 64

export type CapabilityCatalogKindV1 = 'builtin' | 'session' | 'plugin' | 'mcp' | 'app'

export interface CapabilityCatalogEntryInputV1 {
  semanticId: string
  displayName: string
  modelName: string
  kind: CapabilityCatalogKindV1
  description: string
  inputSummary: string
  effect: string
  risk: string
  source: string
  enabled?: boolean
  trusted?: boolean
  available?: boolean
  digest?: string
}

export interface CapabilityCatalogEntryV1 extends Omit<CapabilityCatalogEntryInputV1, 'enabled' | 'trusted' | 'available' | 'digest'> {
  availability: 'available'
  digest: string
}

export interface CapabilityCatalogV1 {
  schemaVersion: typeof CAPABILITY_CATALOG_VERSION
  generation: string
  entries: readonly CapabilityCatalogEntryV1[]
}

export interface CapabilityActivationLeaseV1 {
  schemaVersion: typeof CAPABILITY_CATALOG_VERSION
  semanticId: string
  capabilityGeneration: string
  digest: string
}

export interface CapabilityLeaseRevocationV1 {
  semanticId: string
  reason: 'generation-changed' | 'unavailable' | 'digest-changed'
}

const TOKEN_ALIASES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  add: ['create'],
  create: ['add'],
  delete: ['remove'],
  find: ['search'],
  issue: ['ticket'],
  remove: ['delete'],
  repo: ['repository'],
  repository: ['repo'],
  search: ['find'],
  ticket: ['issue'],
})

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
    .join(',')}}`
}

export function digestCapabilityCatalogEntry(input: Omit<CapabilityCatalogEntryV1, 'digest'>): string {
  return createHash('sha256').update(canonical(input)).digest('hex')
}

function boundedText(value: string, field: string, max: number, context?: string): string {
  const normalized = value.trim().replace(/\s+/g, ' ')
  if (!normalized || normalized.length > max) {
    throw new Error(`Invalid capability ${field}${context ? ` for ${context}` : ''}`)
  }
  return normalized
}

/**
 * Free text shown to the model in `mcp__tool_search` results. An MCP server's own
 * description regularly exceeds the cap, and rejecting it took down Pi spawn for
 * the whole session — so the cap clamps instead of throwing. Emptiness is still a
 * contract violation: an entry with no description is not searchable.
 *
 * The truncated text is what gets digested, so a lease taken against the previous
 * text is dropped by `revalidateCapabilityActivationLeases` rather than silently
 * matching.
 */
function clampedText(value: string, field: string, max: number, context: string): string {
  const normalized = value.trim().replace(/\s+/g, ' ')
  if (!normalized) throw new Error(`Invalid capability ${field} for ${context}`)
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized
}

function normalizeInput(input: CapabilityCatalogEntryInputV1): CapabilityCatalogEntryV1 | null {
  if (input.enabled === false || input.trusted === false || input.available === false) return null
  const semanticId = boundedText(input.semanticId, 'semanticId', 256)
  const unsigned = {
    semanticId,
    displayName: boundedText(input.displayName, 'displayName', 160, semanticId),
    modelName: boundedText(input.modelName, 'modelName', 256, semanticId),
    kind: input.kind,
    description: clampedText(input.description, 'description', 512, semanticId),
    inputSummary: clampedText(input.inputSummary || 'No arguments.', 'inputSummary', 512, semanticId),
    effect: boundedText(input.effect, 'effect', 64, semanticId),
    risk: boundedText(input.risk, 'risk', 64, semanticId),
    source: boundedText(input.source, 'source', 256, semanticId),
    availability: 'available' as const,
  }
  const digest = input.digest ?? digestCapabilityCatalogEntry(unsigned)
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`Invalid capability digest: ${unsigned.semanticId}`)
  return Object.freeze({ ...unsigned, digest })
}

export function createCapabilityCatalogV1(
  generation: string,
  inputs: readonly CapabilityCatalogEntryInputV1[],
): CapabilityCatalogV1 {
  const normalizedGeneration = boundedText(generation, 'generation', 256)
  if (inputs.length > MAX_CAPABILITY_CATALOG_ENTRIES) {
    throw new Error(`Capability catalog exceeds ${MAX_CAPABILITY_CATALOG_ENTRIES} entries`)
  }
  const entries = inputs.flatMap(input => {
    const entry = normalizeInput(input)
    return entry ? [entry] : []
  }).sort((left, right) => left.semanticId.localeCompare(right.semanticId))
  if (new Set(entries.map(entry => entry.semanticId)).size !== entries.length) {
    throw new Error('Capability catalog contains duplicate semantic IDs')
  }
  return Object.freeze({
    schemaVersion: CAPABILITY_CATALOG_VERSION,
    generation: normalizedGeneration,
    entries: Object.freeze(entries),
  })
}

function tokens(value: string): string[] {
  return value.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
}

function expandedQuery(value: string): string[] {
  const result = new Set<string>()
  for (const token of tokens(value)) {
    result.add(token)
    for (const alias of TOKEN_ALIASES[token] ?? []) result.add(alias)
  }
  return [...result]
}

function scoreEntry(entry: CapabilityCatalogEntryV1, rawQuery: string, queryTokens: readonly string[]): number {
  const query = rawQuery.toLowerCase().trim()
  const modelName = entry.modelName.toLowerCase()
  const semanticId = entry.semanticId.toLowerCase()
  const displayName = entry.displayName.toLowerCase()
  if (query === modelName || query === semanticId || query === displayName) return 100_000
  const names = new Set(tokens(`${entry.semanticId} ${entry.modelName} ${entry.displayName}`))
  const description = new Set(tokens(`${entry.description} ${entry.inputSummary} ${entry.source}`))
  let score = modelName.includes(query) || semanticId.includes(query) || displayName.includes(query) ? 5_000 : 0
  for (const token of queryTokens) {
    if (names.has(token)) score += 500
    else if (description.has(token)) score += 100
  }
  return score
}

export function searchCapabilityCatalogV1(
  catalog: CapabilityCatalogV1,
  query: string,
  limit = DEFAULT_CAPABILITY_SEARCH_RESULTS,
): readonly CapabilityCatalogEntryV1[] {
  const normalizedQuery = query.trim()
  if (!normalizedQuery) return Object.freeze(catalog.entries.slice(0, Math.min(MAX_CAPABILITY_SEARCH_RESULTS, Math.max(1, Math.floor(limit)))))
  const queryTokens = expandedQuery(normalizedQuery)
  const capped = Math.min(MAX_CAPABILITY_SEARCH_RESULTS, Math.max(1, Math.floor(limit)))
  return Object.freeze(catalog.entries
    .map(entry => ({ entry, score: scoreEntry(entry, normalizedQuery, queryTokens) }))
    .filter(result => result.score > 0)
    .sort((left, right) => right.score - left.score || left.entry.semanticId.localeCompare(right.entry.semanticId))
    .slice(0, capped)
    .map(result => result.entry))
}

export function activateCapabilityCatalogEntries(
  catalog: CapabilityCatalogV1,
  semanticIds: readonly string[],
): readonly CapabilityActivationLeaseV1[] {
  const ids = [...new Set(semanticIds)]
  if (ids.length > MAX_CAPABILITY_ACTIVATIONS) throw new Error(`Capability activation exceeds ${MAX_CAPABILITY_ACTIVATIONS} entries`)
  const byId = new Map(catalog.entries.map(entry => [entry.semanticId, entry]))
  return Object.freeze(ids.map(semanticId => {
    const entry = byId.get(semanticId)
    if (!entry) throw new Error(`Capability unavailable: ${semanticId}`)
    return Object.freeze({
      schemaVersion: CAPABILITY_CATALOG_VERSION,
      semanticId,
      capabilityGeneration: catalog.generation,
      digest: entry.digest,
    })
  }))
}

export function revalidateCapabilityActivationLeases(
  catalog: CapabilityCatalogV1,
  leases: readonly CapabilityActivationLeaseV1[],
): { active: readonly CapabilityActivationLeaseV1[]; revoked: readonly CapabilityLeaseRevocationV1[] } {
  const byId = new Map(catalog.entries.map(entry => [entry.semanticId, entry]))
  const active: CapabilityActivationLeaseV1[] = []
  const revoked: CapabilityLeaseRevocationV1[] = []
  for (const lease of leases.slice(0, MAX_CAPABILITY_ACTIVATIONS)) {
    if (lease.capabilityGeneration !== catalog.generation) {
      revoked.push({ semanticId: lease.semanticId, reason: 'generation-changed' })
      continue
    }
    const entry = byId.get(lease.semanticId)
    if (!entry) {
      revoked.push({ semanticId: lease.semanticId, reason: 'unavailable' })
      continue
    }
    if (entry.digest !== lease.digest) {
      revoked.push({ semanticId: lease.semanticId, reason: 'digest-changed' })
      continue
    }
    active.push(Object.freeze({ ...lease }))
  }
  return { active: Object.freeze(active), revoked: Object.freeze(revoked) }
}
