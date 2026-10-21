import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadAgentDefinitions } from '../../../shared/src/agents/definitions.ts'
import { materializePiRuntimeAgentDefinitions } from '../../../shared/src/agent/pi-harness/runtime-agent-definition.ts'
import { buildPiRuntimeAgentDefinitions } from './runtime-agent-definitions.ts'

/**
 * P3.232 — ONE agent file, TWO loaders, and until this commit they answered the
 * declared-`tools` question differently.
 *
 * `~/.nessy-agent/agents/x.md`, a workspace `config.json` entry and a trusted
 * project's `.nessy-agent/agents/x.md` are all read twice in this fork:
 *
 *  - the CAPABILITY route — `buildPiRuntimeAgentDescriptor` (host) →
 *    `buildPiRuntimeAgentDefinitions` (here) — which holds the session manifest
 *    and resolves every declared entry against it; and
 *  - the FALLBACK loader — `loadAgentDefinitions`' filesystem branch in
 *    `shared/src/agents/definitions.ts` — which is session-free and took the
 *    list verbatim.
 *
 * These arms pin the half of the rule that needs no manifest on BOTH routes, and
 * pin the half that does need one as a stated residue rather than a silent
 * difference. Every arm feeds the two loaders the SAME file body, because a
 * difference that only shows up under different inputs is not the difference
 * this row is about.
 */

const POOL = [
  'read', 'find', 'grep', 'bash', 'subagent', 'ask_user',
  'mcp__session__TaskCreate', 'mcp__session__ReportFindings',
]

/** The capability route, from the same file body a real session materializes. */
async function throughCapabilityRoute(body: string) {
  const materializer = { assertActive() {}, readText: async () => body } as never
  const view = {
    generation: 'g1', sources: [], hooks: [], automations: [], promptLayers: [], memory: [],
    permissionLayers: [], commands: [], promptCommands: [], apps: [], skills: [], mcpServers: [],
    agents: [{
      key: 'agent://project/probe', name: 'probe', description: 'probe',
      selectedAsUnqualifiedAlias: true,
      instructionsResource: {
        source: 'project', scope: { kind: 'project' }, resourceId: 'probe',
        absolutePath: '/tmp/probe.md', revision: '1', contentHash: 'a'.repeat(64),
      },
    }],
  } as never
  const descriptors = await materializePiRuntimeAgentDefinitions({ view, materializer })
  const built = buildPiRuntimeAgentDefinitions(
    descriptors, POOL, 'g1', { sessionDepth: 0, maxDepth: 3 },
  )
  return built[0]!
}

/** The fallback loader, from the same file body on disk. */
function throughFallbackLoader(body: string) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'two-routes-'))
  mkdirSync(join(projectRoot, '.nessy-agent', 'agents'), { recursive: true })
  writeFileSync(join(projectRoot, '.nessy-agent', 'agents', 'probe.md'), body)
  const definition = loadAgentDefinitions({ projectRoot, projectTrusted: true })
    .find(candidate => candidate.name === 'probe')
  if (!definition) throw new Error('the fallback loader did not load the probe file')
  return definition
}

function agentFile(frontmatter: string[]): string {
  return ['---', 'name: probe', 'description: probe', ...frontmatter, '---', '', 'Probe body.', ''].join('\n')
}

describe('P3.232 — one declared-tools rule, two loaders', () => {
  it('denies a parametrized specifier by omission on BOTH routes', async () => {
    // The half that needs no manifest, and the one with a measured live cost:
    // the official `claude-security` plugin's `Agent(scan-inventory,
    // scan-researcher)` lost its whole subagent grant to a shredded entry, and
    // `Bash(git diff:*)` must NEVER be read as bare `bash` — that would grant
    // authority its author did not write.
    const body = agentFile(['tools: Read, Agent(scan-inventory, scan-researcher), Bash(git diff:*)'])

    const fallback = throughFallbackLoader(body)
    expect(fallback.tools).toEqual(['Read', 'Agent'])
    expect(fallback.zeroToolResolution).toBeUndefined()

    const capability = await throughCapabilityRoute(body)
    // The capability route reaches further because it HAS the pool: `Read` and
    // the reduced `Agent` resolve to their Pi names. The rule that produced the
    // two survivors is the same one; only the lookup afterwards differs.
    expect(capability.tools).toContain('read')
    expect(capability.tools).toContain('subagent')
    expect(capability.tools).not.toContain('bash')
    expect(capability.zeroToolResolution).toBeUndefined()
  })

  it('records the zero-tools verdict on BOTH routes when the whole list is specifiers', async () => {
    // `errors.md#agent-would-be-spawned-with-zero-tools`: "Every entry in the
    // subagent's `tools` list failed to match a usable tool, so Claude Code
    // refused to launch the subagent: with no tools, it couldn't act." The
    // spawner acts on this marker (P6.17); before this commit the fallback
    // loader could never set it, so the refusal was unreachable from that route
    // no matter what the author wrote.
    const body = agentFile(['tools: Bash(git diff:*), Workflow(scan)'])

    const fallback = throughFallbackLoader(body)
    expect(fallback.tools).toEqual([])
    expect(fallback.zeroToolResolution).toEqual({
      unmatched: ['Bash(git diff:*)', 'Workflow(scan)'],
      withheld: [],
    })

    const capability = await throughCapabilityRoute(body)
    expect(capability.zeroToolResolution).toEqual({
      unmatched: ['Bash(git diff:*)', 'Workflow(scan)'],
      withheld: [],
    })
  })

  it('withholds `ask_user` and separates it from an unmatched entry on BOTH routes', async () => {
    // `agent-sdk/user-input.md`: AskUserQuestion "is not currently available in
    // subagents spawned via the Agent tool". It is `errors.md`'s SECOND group,
    // which that page counts toward the refusal, so a list that resolves only to
    // withheld tools has to stay distinguishable from one that resolved to
    // nothing at all.
    const body = agentFile(['tools: ask_user'])

    const fallback = throughFallbackLoader(body)
    expect(fallback.tools).toEqual([])
    expect(fallback.zeroToolResolution).toEqual({ unmatched: [], withheld: ['ask_user'] })

    const capability = await throughCapabilityRoute(body)
    expect(capability.zeroToolResolution).toEqual({ unmatched: [], withheld: ['ask_user'] })
  })

  it('leaves omitted and authored-empty lists launching on BOTH routes (P2.202)', async () => {
    // The same page, three sentences later: "Omitting the `tools` field never
    // triggers this refusal. If you leave the `tools` list empty, or
    // `disallowedTools` removes every entry in it, Claude Code also skips the
    // refusal and launches the subagent without tools." THE NON-EMPTY CONDITION
    // IS THE ROW — without this arm the fix above reverses P2.202.
    const omitted = agentFile(['toolset: full'])
    expect(throughFallbackLoader(omitted).zeroToolResolution).toBeUndefined()
    expect(throughFallbackLoader(omitted).tools.length).toBeGreaterThan(0)
    expect((await throughCapabilityRoute(omitted)).zeroToolResolution).toBeUndefined()

    for (const spelling of ['tools: []', 'tools: ""', 'tools:']) {
      const authoredEmpty = agentFile([spelling])
      const fallback = throughFallbackLoader(authoredEmpty)
      expect(fallback.tools).toEqual([])
      expect(fallback.zeroToolResolution).toBeUndefined()
      expect((await throughCapabilityRoute(authoredEmpty)).zeroToolResolution).toBeUndefined()
    }
  })

  it('states the residue: only the manifest-holding route can judge an unknown NAME', async () => {
    // The half that is NOT decidable without a session, kept honest rather than
    // invented. `Grpe`/`Reed` are the shape x4 drove this row on: the capability
    // route drops both and records the verdict, and the fallback loader — which
    // has no manifest to ask — keeps them as names that grant nothing.
    //
    // This is a RESIDUE, not a divergence in the rule: the names the fallback
    // loader keeps are a subset of what the capability route would consider, and
    // a name it keeps is never a grant the capability route would have refused.
    const body = agentFile(['tools: Grpe, Reed'])

    const fallback = throughFallbackLoader(body)
    expect(fallback.tools).toEqual(['Grpe', 'Reed'])
    expect(fallback.zeroToolResolution).toBeUndefined()

    const capability = await throughCapabilityRoute(body)
    expect(capability.zeroToolResolution).toEqual({ unmatched: ['Grpe', 'Reed'], withheld: [] })
  })
})
