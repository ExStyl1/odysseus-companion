import { describe, expect, it } from 'bun:test'
import type { BackendConfig } from '../backend/types.ts'
import { PiAgent } from '../pi-agent.ts'

// F1.1119 — a Pi subprocess respawned inside one PiAgent (a capability refresh, a
// crash, a model switch) is seeded with the deferred tools already loaded. The
// subprocess reports its loaded set after every load (`continuation_state`); the
// persisted continuation envelope is written only at a compaction boundary. Before
// F1.1119 the init read the envelope alone, so a tool loaded after the last
// compaction (or in a chat never compacted) was gone after the respawn while the
// resumed conversation still showed it loaded.

const lease = (semanticId: string, generation = 'g1') => ({
  schemaVersion: 1 as const,
  semanticId,
  capabilityGeneration: generation,
  digest: semanticId.length % 2 ? 'a'.repeat(64) : 'b'.repeat(64),
})

function agentWithEnvelope(activatedTools: unknown[] | undefined): PiAgent {
  const config: BackendConfig = {
    provider: 'pi', isHeadless: true, skipConfigWatcher: true,
    workspace: { id: 'ws', name: 'ws', rootPath: '/tmp/ws', workspaceRootPath: '/tmp/ws', sessionRootPath: '/tmp/sessions/ws' } as any,
    session: { id: 'pi-respawn', workspaceId: 'ws', createdAt: 1, lastUsedAt: 1 } as any,
    getPiContinuationEnvelope: () => (activatedTools ? { activatedTools } as any : undefined),
  }
  return new PiAgent(config)
}

const seeded = (agent: PiAgent) =>
  ((agent as any).initContinuationActivatedTools() ?? []).map((value: { semanticId: string }) => value.semanticId)

const report = (agent: PiAgent, tools: unknown[], generation = 'g1') =>
  (agent as any).handleLine(JSON.stringify({ type: 'continuation_state', capabilityGeneration: generation, activatedTools: tools }))

describe('F1.1119: a respawned Pi subprocess keeps the tools loaded since the last compaction', () => {
  it('seeds the set the subprocess last reported, not the older envelope', () => {
    const agent = agentWithEnvelope([lease('mcp__docs__search')])
    try {
      report(agent, [lease('mcp__docs__search'), lease('mcp__tracker__list_issues')])
      expect(seeded(agent)).toEqual(['mcp__docs__search', 'mcp__tracker__list_issues'])
    } finally {
      agent.destroy()
    }
  })

  it('a reported EMPTY set is the truth too: the envelope does not resurrect a tool', () => {
    const agent = agentWithEnvelope([lease('mcp__docs__search')])
    try {
      report(agent, [])
      expect(seeded(agent)).toEqual([])
    } finally {
      agent.destroy()
    }
  })

  it('CONTROL: before the subprocess reported anything (a new agent after an app restart), the envelope seeds it', () => {
    const agent = agentWithEnvelope([lease('mcp__docs__search')])
    try {
      expect(seeded(agent)).toEqual(['mcp__docs__search'])
    } finally {
      agent.destroy()
    }
  })

  it('/clear forgets the reported set, so the next spawn is seeded exactly as before F1.1119', async () => {
    const agent = agentWithEnvelope([lease('mcp__docs__search')])
    try {
      report(agent, [lease('mcp__docs__search'), lease('mcp__tracker__list_issues')])
      await agent.clearHistory()
      expect(seeded(agent)).toEqual(['mcp__docs__search'])
    } finally {
      agent.destroy()
    }
  })
})
