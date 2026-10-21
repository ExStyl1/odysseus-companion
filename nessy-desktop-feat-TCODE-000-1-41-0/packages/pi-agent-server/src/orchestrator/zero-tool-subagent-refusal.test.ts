import { describe, expect, it } from 'bun:test'

import type { PiChildSessionPort, PiChildStartInput } from '../../../shared/src/agent/pi-harness/child-session-port.ts'
import { buildPiRuntimeAgentDefinitions } from './runtime-agent-definitions.ts'
import { configureSpawner, spawnChildSession } from './spawner.ts'

/**
 * P6.17 — a subagent whose EVERY declared tool fails to resolve is refused at
 * spawn instead of launching a worker that can do nothing.
 *
 * THE DISTINCTION THIS ROW TURNS ON, stated first because without it the row
 * reads as reversing P2.202: the refusal needs a NON-EMPTY declared list whose
 * entries all fail. `errors.md#agent-would-be-spawned-with-zero-tools` fixes
 * both halves in one paragraph — "Every entry in the subagent's `tools` list
 * failed to match a usable tool, so Claude Code refused to launch the subagent:
 * with no tools, it couldn't act" — and, three sentences later, "Omitting the
 * `tools` field never triggers this refusal. If you leave the `tools` list
 * empty, or `disallowedTools` removes every entry in it, Claude Code also skips
 * the refusal and launches the subagent without tools." An authored-empty list
 * is the empty SET and still launches; that is P2.202's decision and every case
 * below leaves it standing.
 *
 * NATIVE-FIRST, asked before building: nothing under this spawn path already
 * does it. `resolveExplicitTools`' own docblock said so in as many words —
 * "(Not implemented here: the 'spawned with zero tools' refusal itself. It is a
 * spawn-time diagnostic, and this builder cannot refuse a spawn.)" — and
 * `agents/definitions.ts` QUOTES the contract sentence ("If no entry in the list
 * resolves to a tool, the subagent usually fails to launch with an error naming
 * the entries") beside a parser that has never enforced it. So the mechanism was
 * quoted twice and implemented nowhere, and the spawner is the only layer that
 * can refuse a spawn.
 */

const base = {
  schemaVersion: 2 as const,
  key: 'plugin://acme#agent.zero-tool-probe@workspace',
  name: 'zero-tool-probe',
  description: 'Reviews code',
  selectedAsUnqualifiedAlias: true,
  systemPrompt: 'Review carefully.',
  sha256: 'a'.repeat(64),
  provenance: 'plugin://acme#agent.zero-tool-probe@workspace@generation-1',
  capabilityGeneration: 'generation-1',
  definitionDigest: 'b'.repeat(64),
}

/** A production-shaped pool: working tools, orchestration, and the task tools. */
const POOL = [
  'read', 'grep', 'find', 'ls', 'bash', 'write', 'edit',
  'ask_user', 'subagent', 'review', 'get_subagent_result', 'stopTask', 'workflow',
  'mcp__session__TaskCreate', 'mcp__session__TaskUpdate', 'mcp__session__ReportFindings',
]

const BELOW_LIMIT = { sessionDepth: 0, maxDepth: 3 }
const AT_LIMIT = { sessionDepth: 2, maxDepth: 3 }

function port(started: PiChildStartInput[]): PiChildSessionPort {
  return {
    start: async input => {
      started.push(structuredClone(input))
      return { agentId: input.requestedAgentId ?? 'child', status: 'completed', output: 'ok', result: 'ok' }
    },
    resume: async agentId => ({ agentId, status: 'completed', output: '' }),
    steer: async () => {},
    getResult: async agentId => ({ agentId, status: 'completed', output: '' }),
    stop: async () => {},
    stopTask: async () => {},
    sealOwnerTask: async () => {},
    searchOutput: async agentId => ({ agentId, cursor: 0, status: 'completed', results: [] }),
    attach: async agentId => ({ agentId, cursor: 0, output: '', status: 'completed' }),
    monitor: async agentId => ({ agentId, status: 'completed', output: 'ok', result: 'ok' }),
  }
}

async function spawnOne(
  descriptor: Record<string, unknown>,
  depthBudget = BELOW_LIMIT,
): Promise<{ started: PiChildStartInput[]; status: string; text: string }> {
  const [definition] = buildPiRuntimeAgentDefinitions(
    [descriptor as never],
    POOL,
    undefined,
    depthBudget,
  )
  const started: PiChildStartInput[] = []
  configureSpawner({ childSessionPort: port(started), modelId: 'default-model', retryBaseDelayMs: () => 0 })
  const result = await spawnChildSession({ agentDef: definition!, task: 'go', cwd: '/tmp/ws' })
  return { started, status: result.status, text: result.text || result.error || '' }
}

describe('P6.17 zero-tool subagent refusal', () => {
  it('refuses the spawn when every declared entry matched no tool in this session', async () => {
    const { started, status, text } = await spawnOne({ ...base, tools: ['Grpe', 'mcp__absent__thing'] })

    expect(started).toHaveLength(0)
    expect(status).toBe('error')
    expect(text).toBe(
      "Agent 'zero-tool-probe' would be spawned with zero tools — refusing. "
      + 'Its tools list resolved to nothing: matched no tool in this session [Grpe, mcp__absent__thing]. '
      + "Fix the agent's tools frontmatter or pass a different subagent_type.",
    )
  })

  it('refuses a list that resolves only to tools a subagent never gets', async () => {
    // errors.md's second group: "the entry names a real tool that subagents
    // can't use". `ask_user` is ours — agent-sdk/user-input.md, AskUserQuestion
    // "is not currently available in subagents spawned via the Agent tool".
    const { started, status, text } = await spawnOne({ ...base, tools: ['AskUserQuestion'] })

    expect(started).toHaveLength(0)
    expect(status).toBe('error')
    expect(text).toContain('would be spawned with zero tools')
    expect(text).toContain('withheld from every subagent [ask_user]')
  })

  it('refuses a list containing only Agent when the child is at the depth limit', async () => {
    // errors.md, the fix list: "For a `tools` list that contains only `Agent`,
    // raise the depth limit or give the agent at least one other tool: Claude
    // Code withholds `Agent` at that limit, so a list with nothing else in it
    // resolves to no tools."
    const { started, status, text } = await spawnOne({ ...base, tools: ['Agent'] }, AT_LIMIT)

    expect(started).toHaveLength(0)
    expect(status).toBe('error')
    expect(text).toContain('would be spawned with zero tools')
    expect(text).toContain('withheld from every subagent [subagent]')
  })

  it('launches an AUTHORED-EMPTY list without tools — P2.202 stands', async () => {
    // "If you leave the `tools` list empty … Claude Code also skips the refusal
    // and launches the subagent without tools."
    const { started, status } = await spawnOne({ ...base, tools: [] })

    expect(started).toHaveLength(1)
    expect(status).toBe('done')
  })

  it('launches when the tools field is omitted entirely', async () => {
    // "Omitting the `tools` field never triggers this refusal."
    const { started, status } = await spawnOne({ ...base })

    expect(started).toHaveLength(1)
    expect(status).toBe('done')
  })

  it('launches when at least one declared entry survives', async () => {
    // The negative boundary: one good entry among failures is not zero tools.
    const { started, status } = await spawnOne({ ...base, tools: ['Read', 'Grpe'] })

    expect(started).toHaveLength(1)
    expect(status).toBe('done')
    expect(started[0]!.restrictions.tools).toContain('read')
  })

  it('launches when disallowedTools — not resolution — emptied the list', async () => {
    // "…or `disallowedTools` removes every entry in it, Claude Code also skips
    // the refusal and launches the subagent without tools." The entries RESOLVED
    // here; the denial is applied later, in the spawner's own filter.
    const { started, status } = await spawnOne({ ...base, tools: ['Read'], disallowedTools: ['Read'] })

    expect(started).toHaveLength(1)
    expect(status).toBe('done')
    expect(started[0]!.restrictions.tools).not.toContain('read')
  })
})
