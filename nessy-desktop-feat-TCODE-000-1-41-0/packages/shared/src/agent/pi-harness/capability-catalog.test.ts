import { describe, expect, it } from 'bun:test'
import {
  MAX_CAPABILITY_CATALOG_ENTRIES,
  activateCapabilityCatalogEntries,
  createCapabilityCatalogV1,
  revalidateCapabilityActivationLeases,
  searchCapabilityCatalogV1,
  type CapabilityCatalogEntryInputV1,
} from './capability-catalog.ts'

const entry = (semanticId: string, description: string, overrides: Partial<CapabilityCatalogEntryInputV1> = {}): CapabilityCatalogEntryInputV1 => ({
  semanticId,
  displayName: semanticId,
  modelName: semanticId,
  kind: 'mcp',
  description,
  inputSummary: 'owner: string',
  effect: 'external-read',
  risk: 'low',
  source: 'mcp:fixture',
  ...overrides,
})

describe('CapabilityCatalogV1', () => {
  it('searches exact names, synonyms and descriptions deterministically while excluding unavailable entries', () => {
    const catalog = createCapabilityCatalogV1('generation-1', [
      entry('read', 'Read a workspace file', { kind: 'builtin', source: 'pi:read' }),
      entry('mcp__session__ask_user', 'Ask the current user', { kind: 'session', source: 'pi:session' }),
      entry('mcp__plugin__inspect', 'Inspect plugin state', { kind: 'plugin', source: 'plugin:honey' }),
      entry('mcp__calendar__list_events', 'List calendar events', { kind: 'app', source: 'app:calendar' }),
      entry('mcp__gitlab__list_repositories', 'List projects owned by a user'),
      entry('mcp__jira__find_issues', 'Search work items'),
      entry('mcp__slack__send_message', 'Post a chat message'),
      entry('mcp__hidden__secret', 'Should not appear', { enabled: false }),
      entry('mcp__blocked__secret', 'Should not appear', { trusted: false }),
    ])

    expect(searchCapabilityCatalogV1(catalog, 'mcp__jira__find_issues')[0]?.semanticId).toBe('mcp__jira__find_issues')
    expect(searchCapabilityCatalogV1(catalog, 'repo')[0]?.semanticId).toBe('mcp__gitlab__list_repositories')
    expect(searchCapabilityCatalogV1(catalog, 'chat')[0]?.semanticId).toBe('mcp__slack__send_message')
    expect(searchCapabilityCatalogV1(catalog, 'does-not-exist')).toEqual([])
    expect(catalog.entries.map(value => value.semanticId)).not.toContain('mcp__hidden__secret')
    expect(new Set(catalog.entries.map(value => value.kind))).toEqual(new Set(['builtin', 'session', 'plugin', 'app', 'mcp']))
  })

  it('truncates an overlong description instead of failing the whole catalog', () => {
    // Real MCP servers ship descriptions well past 512 chars. Throwing here took
    // down Pi spawn for every plugin-backed turn.
    const catalog = createCapabilityCatalogV1('gen-1', [entry('mcp__verbose__do', 'x'.repeat(900))])

    const value = catalog.entries.find(item => item.semanticId === 'mcp__verbose__do')!
    expect(value.description.length).toBeLessThanOrEqual(512)
    expect(value.description.endsWith('…')).toBe(true)
    expect(/^[a-f0-9]{64}$/.test(value.digest)).toBe(true)
  })

  it('truncates an overlong inputSummary the same way', () => {
    const catalog = createCapabilityCatalogV1('gen-1', [
      entry('mcp__verbose__args', 'Short enough', { inputSummary: 'y'.repeat(900) }),
    ])
    expect(catalog.entries[0]!.inputSummary.length).toBeLessThanOrEqual(512)
    expect(catalog.entries[0]!.inputSummary.endsWith('…')).toBe(true)
  })

  it('still rejects an overlong identity field, and names the entry', () => {
    // An overlong semanticId or risk is a contract bug, not user content.
    expect(() => createCapabilityCatalogV1('gen-1', [
      entry('mcp__x__y', 'Fine', { risk: 'r'.repeat(200) }),
    ])).toThrow(/mcp__x__y/)
  })

  it('still rejects an empty description, and names the entry', () => {
    expect(() => createCapabilityCatalogV1('gen-1', [entry('mcp__x__empty', '   ')])).toThrow(/mcp__x__empty/)
  })

  it('caps results/catalog and fails closed for stale generation, digest changes and missing entries', () => {
    const inputs = Array.from({ length: 80 }, (_, index) => entry(`mcp__fixture__tool_${index}`, 'fixture capability'))
    const catalog = createCapabilityCatalogV1('generation-1', inputs)
    expect(searchCapabilityCatalogV1(catalog, 'fixture', 1_000)).toHaveLength(50)
    const maximumCatalog = createCapabilityCatalogV1('generation-1', Array.from(
      { length: MAX_CAPABILITY_CATALOG_ENTRIES },
      (_, index) => entry(`mcp__stress__tool_${index}`, 'stress fixture'),
    ))
    expect(maximumCatalog.entries).toHaveLength(MAX_CAPABILITY_CATALOG_ENTRIES)
    expect(searchCapabilityCatalogV1(maximumCatalog, 'stress', 1_000)).toHaveLength(50)
    expect(() => createCapabilityCatalogV1('generation-1', Array.from({ length: MAX_CAPABILITY_CATALOG_ENTRIES + 1 }, (_, index) => entry(`tool-${index}`, 'x')))).toThrow('exceeds')

    const [lease] = activateCapabilityCatalogEntries(catalog, ['mcp__fixture__tool_0'])
    expect(revalidateCapabilityActivationLeases(catalog, [lease!]).active).toHaveLength(1)
    expect(revalidateCapabilityActivationLeases(createCapabilityCatalogV1('generation-2', inputs), [lease!]).revoked[0]?.reason).toBe('generation-changed')
    expect(revalidateCapabilityActivationLeases(createCapabilityCatalogV1('generation-1', inputs.map(value => value.semanticId === lease!.semanticId ? { ...value, description: 'changed' } : value)), [lease!]).revoked[0]?.reason).toBe('digest-changed')
    expect(revalidateCapabilityActivationLeases(createCapabilityCatalogV1('generation-1', inputs.slice(1)), [lease!]).revoked[0]?.reason).toBe('unavailable')
    expect(() => activateCapabilityCatalogEntries(catalog, ['unknown'])).toThrow('Capability unavailable')
  })
})
