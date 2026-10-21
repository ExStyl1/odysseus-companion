import { describe, expect, it } from 'bun:test'

import type { PiChildSessionPort, PiChildStartInput } from '../../../shared/src/agent/pi-harness/child-session-port.ts'
import type { AgentDefinition } from '../../../shared/src/agents/index.ts'
import { FORK_AGENT_DEFINITION } from '../../../shared/src/agents/index.ts'
import { computeEffectiveConcurrency, configureSpawner, DEFAULT_MAX_DEPTH, Semaphore, spawnChildSession, type SpawnerRuntime } from './spawner.ts'
import { DEFAULT_PI_ORCHESTRATOR_CONFIG } from '../../../shared/src/agent/pi-harness/harness-manifest.ts'
import { DEFAULT_MAX_SUBAGENT_SPAWN_DEPTH, resolveMaxSubagentSpawnDepth } from '../../../shared/src/config/subagent-spawn-depth.ts'
import { availableParallelism } from 'node:os'

const worker: AgentDefinition = {
  name: 'worker', description: 'Worker', systemPrompt: 'Worker prompt', toolset: 'full',
  tools: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'], tier: 'big',
}
const scout: AgentDefinition = {
  name: 'scout', description: 'Scout', systemPrompt: 'Scout prompt', toolset: 'read-only',
  tools: ['read', 'grep', 'find', 'ls'], tier: 'small',
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Wait for the EFFECT, not for a fixed number of microtasks.
 *
 * `await Promise.resolve()` twice is a budget, and how many ticks a spawn needs
 * to reach the port is an implementation detail of everything it awaits on the
 * way. Four concurrent spawns on a loaded CI runner did not all arrive inside
 * that budget, so `counts a fork against the ceiling …` failed there while
 * passing on every developer machine — the assertion read a race, not the
 * ceiling rule it exists to prove.
 */
async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitUntil timed out after ${timeoutMs}ms: ${label}`)
    await sleep(1)
  }
}

function port(overrides: Partial<PiChildSessionPort> = {}): PiChildSessionPort {
  return {
    start: async input => ({ agentId: input.requestedAgentId ?? 'child', status: 'completed', output: 'child result', result: 'child result' }),
    resume: async agentId => ({ agentId, status: 'completed', output: '' }),
    steer: async () => {}, getResult: async agentId => ({ agentId, status: 'completed', output: '' }),
    stop: async () => {}, stopTask: async () => {}, sealOwnerTask: async () => {},
    searchOutput: async agentId => ({ agentId, cursor: 0, status: 'completed', results: [] }),
    attach: async agentId => ({ agentId, cursor: 0, output: '', status: 'completed' }),
    monitor: async agentId => ({ agentId, status: 'completed', output: 'child result', result: 'child result' }),
    ...overrides,
  }
}

function configure(childSessionPort: PiChildSessionPort, overrides: Partial<SpawnerRuntime> = {}): void {
  configureSpawner({
    childSessionPort, modelId: 'default-model', retryBaseDelayMs: () => 0,
    ...overrides,
  })
}

describe('child session spawner', () => {
  it('transfers a released semaphore slot to a queued waiter before same-tick acquires', async () => {
    const semaphore = new Semaphore(1) as unknown as { active: number; acquire(): Promise<void>; release(): void }
    await semaphore.acquire()
    const queued = semaphore.acquire()
    semaphore.release()
    const sameTick = semaphore.acquire()
    await Promise.resolve()
    expect(semaphore.active).toBe(1)
    semaphore.release()
    await sameTick
    semaphore.release()
    await queued
    expect(semaphore.active).toBe(0)
  })

  it('submits one restricted durable child request with safety prompt, model precedence and distinct IDs', async () => {
    const captured: PiChildStartInput[] = []
    configure(port({ start: async input => {
      captured.push(structuredClone(input))
      return { agentId: input.requestedAgentId!, ownerTaskId: input.ownerTaskId, status: 'completed', output: 'ok', inputTokens: 7, outputTokens: 5, costUsd: 0.2 }
    } }), { tierModelMap: { small: 'small-model' }, maxDepth: 3, maxFanout: 5, tokenBudget: 99 })

    const result = await spawnChildSession({
      agentDef: { ...scout, model: 'agent-model', disallowedTools: ['grep'] },
      model: 'call-model', effort: 'high', task: 'inspect', cwd: '/tmp/ws', ownerTaskId: 'task-1', depth: 1,
    })

    expect(result).toMatchObject({ status: 'done', text: 'ok', tokensIn: 7, tokensOut: 5, costUsd: 0.2 })
    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({
      agent: 'scout', task: 'inspect', ownerTaskId: 'task-1', background: false,
      restrictions: { model: 'call-model', tools: ['read', 'find', 'ls'], thinkingLevel: 'high', worktreePolicy: 'shared' },
      budgets: { depth: 2, maxDepth: 3, fanout: 5, tokenLimit: 99 },
    })
    expect(captured[0]!.restrictions.prompt).toContain('## Subagent Safety Core')
    expect(captured[0]!.restrictions.prompt).toContain('Scout prompt')
    expect(captured[0]!.requestedAgentId).not.toBe('task-1')
  })

  it('forwards agent-def maxTurns and permissionMode into restrictions, omitting them when unset', async () => {
    const captured: PiChildStartInput[] = []
    const capture = () => port({ start: async input => { captured.push(structuredClone(input)); return { agentId: input.requestedAgentId!, status: 'completed', output: 'ok' } } })

    configure(capture())
    await spawnChildSession({ agentDef: { ...scout, maxTurns: 4, permissionMode: 'plan' }, task: 'inspect', cwd: '/tmp', background: false })
    expect(captured[0]!.restrictions).toMatchObject({ maxTurns: 4, permissionMode: 'plan' })

    // Unset on the def => absent from restrictions (legacy byte-identity).
    captured.length = 0
    configure(capture())
    await spawnChildSession({ agentDef: scout, task: 'inspect', cwd: '/tmp', background: false })
    expect(captured[0]!.restrictions).not.toHaveProperty('maxTurns')
    expect(captured[0]!.restrictions).not.toHaveProperty('permissionMode')
  })

  /**
   * P12, the Pi half. Raw page
   * (`curl -sL https://code.claude.com/docs/en/sub-agents.md`),
   * § *Available tools*: "Both fields accept MCP server-level patterns in
   * addition to exact tool names: `mcp__<server>` or `mcp__<server>__*` grants
   * or removes every tool from the named server. In `disallowedTools`,
   * `mcp__*` also removes every MCP tool from any server."
   *
   * BOTH fields. This filter read the glob alone, where a bare `mcp__deploy`
   * compiles to `^mcp__deploy$` and matches no `mcp__deploy__<tool>` name — so
   * the author's denial removed nothing and every tool of that server shipped
   * in the child's pool.
   *
   * The host half is `SessionManager.orchestration.test.ts`
   * ("refuses a tool a bare server-level denial removes"), and the pair is the
   * agreement: fix this side alone and the host still admits a denied tool a
   * buggy or hostile caller re-adds to `restrictions.tools`; fix that side
   * alone and this pool still carries it.
   */
  it('removes a server tools from the child pool for a BARE server-level denial', async () => {
    const captured: PiChildStartInput[] = []
    const capture = () => port({ start: async input => { captured.push(structuredClone(input)); return { agentId: input.requestedAgentId!, status: 'completed', output: 'ok' } } })
    const deployer: AgentDefinition = {
      ...worker,
      tools: ['read', 'mcp__deploy__release', 'mcp__deploy__rollback', 'mcp__deployextra__status'],
    }

    configure(capture())
    await spawnChildSession({ agentDef: { ...deployer, disallowedTools: ['mcp__deploy'] }, task: 'ship', cwd: '/tmp', background: false })
    // The prefix boundary rides along: `deployextra` is a different server that
    // `deploy` merely begins, and it stays granted.
    expect(captured[0]!.restrictions.tools).toEqual(['read', 'mcp__deployextra__status'])

    // Control — the parametrized spelling, which already worked, still does.
    captured.length = 0
    configure(capture())
    await spawnChildSession({ agentDef: { ...deployer, disallowedTools: ['mcp__deploy__*'] }, task: 'ship', cwd: '/tmp', background: false })
    expect(captured[0]!.restrictions.tools).toEqual(['read', 'mcp__deployextra__status'])

    // Control — `mcp__*` removes every MCP tool from any server, per the same
    // sentence, and leaves the built-in alone.
    captured.length = 0
    configure(capture())
    await spawnChildSession({ agentDef: { ...deployer, disallowedTools: ['mcp__*'] }, task: 'ship', cwd: '/tmp', background: false })
    expect(captured[0]!.restrictions.tools).toEqual(['read'])

    // NO WIDENING — a plain-name denial still denies, and an undeclared
    // denial still removes nothing.
    captured.length = 0
    configure(capture())
    await spawnChildSession({ agentDef: { ...deployer, disallowedTools: ['read'] }, task: 'ship', cwd: '/tmp', background: false })
    expect(captured[0]!.restrictions.tools).toEqual(['mcp__deploy__release', 'mcp__deploy__rollback', 'mcp__deployextra__status'])

    captured.length = 0
    configure(capture())
    await spawnChildSession({ agentDef: deployer, task: 'ship', cwd: '/tmp', background: false })
    expect(captured[0]!.restrictions.tools).toEqual(['read', 'mcp__deploy__release', 'mcp__deploy__rollback', 'mcp__deployextra__status'])
  })

  it('forwards the memory scope without widening tools, the prompt or the worktree policy', async () => {
    const captured: PiChildStartInput[] = []
    const capture = () => port({ start: async input => { captured.push(structuredClone(input)); return { agentId: input.requestedAgentId!, status: 'completed', output: 'ok' } } })

    configure(capture())
    await spawnChildSession({ agentDef: { ...scout, memory: 'user' }, task: 'inspect', cwd: '/tmp', background: false })
    expect(captured[0]!.restrictions.memory).toBe('user')
    // sub-agents.md:527's read/write/edit grant is applied HOST-side, after the
    // pinned-definition tool check. Unioning it in here instead would make the
    // request fail that check with `runtime-agent-tool-unavailable:write` — for
    // a `toolset: read-only` agent, i.e. exactly the case the field is for.
    expect(captured[0]!.restrictions.tools).toEqual(['read', 'grep', 'find', 'ls'])
    // And the memory block is NOT a fourth prompt segment: the host asserts the
    // child prompt ends with the pinned system prompt.
    expect(captured[0]!.restrictions.prompt.trim().endsWith(scout.systemPrompt)).toBe(true)
    // The toolset is not recomputed from the grant, so a read-only memory agent
    // stays in the shared tree — a worktree would take its memory with it.
    expect(captured[0]!.restrictions.worktreePolicy).toBe('shared')

    // Unset on the def => absent from restrictions (legacy byte-identity).
    captured.length = 0
    configure(capture())
    await spawnChildSession({ agentDef: scout, task: 'inspect', cwd: '/tmp', background: false })
    expect(captured[0]!.restrictions).not.toHaveProperty('memory')
  })

  /**
   * `sub-agents.md:289` — subagent frontmatter `effort` "Overrides the session
   * effort level. Default: inherits from session." `model-config.md:506` —
   * "Frontmatter effort applies when that skill or subagent is active,
   * overriding the session level but not the environment variable."
   *
   * OVERRIDE, NOT CLAMP: the `child-higher-than-parent` rows are the ones the
   * old `Math.min` got wrong, and the `parent-unset` rows are the ones it
   * answered `off` to — inheriting `off` because nobody set a level is not the
   * same fact as a parent that chose `off`.
   */
  it.each([
    // parent level          child frontmatter   per-call effort  resolved
    ['high',                 undefined,          undefined,       'high'],   // inherit
    ['high',                 'low',              undefined,       'low'],    // override down
    ['low',                  'max',              undefined,       'max'],    // override UP — wrong before
    ['off',                  'high',             undefined,       'high'],   // a parent that chose off
    ['medium',               'medium',           undefined,       'medium'], // no-op override
    [undefined,              undefined,          undefined,       'medium'], // parent unset => session default
    [undefined,              'xhigh',            undefined,       'xhigh'],  // parent unset, child declares
    ['low',                  'medium',           'max',           'max'],    // per-call outranks frontmatter
    ['high',                 undefined,          'low',           'low'],    // per-call outranks the session
  ] as const)('resolves parent %p + frontmatter %p + per-call %p to %p', async (parent, declared, requested, expected) => {
    const captured: PiChildStartInput[] = []
    configure(
      port({ start: async input => { captured.push(structuredClone(input)); return { agentId: input.requestedAgentId!, status: 'completed', output: 'ok' } } }),
      parent === undefined ? {} : { thinkingLevel: () => parent },
    )

    await spawnChildSession({
      agentDef: declared === undefined ? scout : { ...scout, effort: declared },
      ...(requested === undefined ? {} : { effort: requested }),
      task: 'inspect', cwd: '/tmp', background: false,
    })

    expect(captured[0]!.restrictions.thinkingLevel).toBe(expected)
  })

  /**
   * The staleness seam: `configureSpawner` runs only when a capability
   * generation commits, while `set_thinking_level` can move the session level at
   * any point in the conversation. A level captured at configure time is stale
   * for every child spawned in between, so the runtime carries a reader instead
   * of a value. Spawning once proves nothing here — the second spawn is the test.
   */
  it('reads the session level at spawn time, so a mid-session change reaches the NEXT child', async () => {
    const captured: PiChildStartInput[] = []
    let sessionLevel: 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' = 'low'
    configure(
      port({ start: async input => { captured.push(structuredClone(input)); return { agentId: input.requestedAgentId!, status: 'completed', output: 'ok' } } }),
      { thinkingLevel: () => sessionLevel },
    )

    await spawnChildSession({ agentDef: scout, task: 'first', cwd: '/tmp', background: false })
    expect(captured[0]!.restrictions.thinkingLevel).toBe('low')

    // `/effort xhigh` mid-conversation. No reconfigure: none happens in
    // production either until the next generation commits.
    sessionLevel = 'xhigh'

    await spawnChildSession({ agentDef: scout, task: 'second', cwd: '/tmp', background: false })
    expect(captured[1]!.restrictions.thinkingLevel).toBe('xhigh')
  })

  it('gives a fork the session level as of the spawn, not as of the last reconfigure', async () => {
    const captured: PiChildStartInput[] = []
    let sessionLevel: 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' = 'medium'
    configure(
      port({ start: async input => { captured.push(structuredClone(input)); return { agentId: input.requestedAgentId!, status: 'completed', output: 'ok' } } }),
      { thinkingLevel: () => sessionLevel, modelId: 'session-model', sessionToolNames: ['read'] },
    )

    await spawnChildSession({ agentDef: FORK_AGENT_DEFINITION, task: 'first', cwd: '/tmp', background: false })
    expect(captured[0]!.restrictions.thinkingLevel).toBe('medium')

    sessionLevel = 'max'

    await spawnChildSession({ agentDef: FORK_AGENT_DEFINITION, task: 'second', cwd: '/tmp', background: false })
    expect(captured[1]!.restrictions.thinkingLevel).toBe('max')
  })

  /**
   * `model-config.md:452` — "If you set a level the active model does not
   * support, Claude Code falls back to the highest supported level at or below
   * the one you set. For example, `xhigh` runs as `high` on Opus 4.6."
   *
   * Applied against the CHILD's resolved model, which is not necessarily the
   * session's: a tier map or a frontmatter `model` can put a subagent on a
   * narrower model than its parent.
   */
  it('narrows the resolved level to what the child model supports', async () => {
    const captured: PiChildStartInput[] = []
    configure(
      port({ start: async input => { captured.push(structuredClone(input)); return { agentId: input.requestedAgentId!, status: 'completed', output: 'ok' } } }),
      { thinkingLevel: () => 'max', modelId: 'claude-opus-4-8' },
    )

    // The child asks for `xhigh` and lands on Opus 4.6 through its own
    // frontmatter `model`, while the parent stays on a model that supports it.
    await spawnChildSession({
      agentDef: { ...scout, effort: 'xhigh', model: 'claude-opus-4-6' },
      task: 'inspect', cwd: '/tmp', background: false,
    })
    expect(captured[0]!.restrictions).toMatchObject({ model: 'claude-opus-4-6', thinkingLevel: 'high' })

    // Same request, a model that supports it: untouched.
    await spawnChildSession({
      agentDef: { ...scout, effort: 'xhigh' },
      task: 'inspect', cwd: '/tmp', background: false,
    })
    expect(captured[1]!.restrictions).toMatchObject({ model: 'claude-opus-4-8', thinkingLevel: 'xhigh' })
  })

  it('forwards pinned identity/resource narrowing and applies the agent effort override', async () => {
    const captured: PiChildStartInput[] = []
    configure(port({ start: async input => { captured.push(structuredClone(input)); return { agentId: input.requestedAgentId!, status: 'completed', output: 'ok' } } }), { thinkingLevel: () => 'high' })
    await spawnChildSession({
      agentDef: {
        ...scout, effort: 'low', capabilityGeneration: 'generation-1', definitionKey: 'agent://reviewer', definitionDigest: 'a'.repeat(64),
        skillKeys: ['skill://review'], mcpServerKeys: ['mcp://gitlab'],
      },
      task: 'inspect', cwd: '/tmp', background: false,
    })
    expect(captured[0]!.restrictions).toMatchObject({
      thinkingLevel: 'low', capabilityGeneration: 'generation-1', definitionKey: 'agent://reviewer', definitionDigest: 'a'.repeat(64),
      skillKeys: ['skill://review'], mcpServerKeys: ['mcp://gitlab'],
    })
  })

  /**
   * Q6-D2, measured live on the packaged 1.25.1: `claude-security`'s own
   * `model: sonnet` agents could not be spawned at all on the Nessy gateway —
   * `Agent model unavailable: sonnet` — while a large share of the public
   * catalogue names a Claude model the same way.
   *
   * `sub-agents.md` § *Choose a model*: "For any other blocked value, on
   * providers where that substitution doesn't operate, or when the allowlist
   * permits no version of the family, Claude Code runs the subagent on the
   * inherited model instead." And the visibility half, same section: "In
   * interactive sessions, Claude Code shows a warning naming the requested model
   * and the model the subagent runs on, for either substitution."
   */
  it('falls back to the inherited model when a pinned definition names a model this session cannot serve', async () => {
    const models: string[] = []
    configure(port({ start: async input => {
      models.push(input.restrictions.model)
      return { agentId: input.requestedAgentId!, status: 'completed', output: 'ok', result: 'ok' }
    } }), { tierModelMap: { small: 'small-model' } })
    const result = await spawnChildSession({
      agentDef: { ...scout, model: 'sonnet', capabilityGeneration: 'generation-1' },
      task: 'inspect', cwd: '/tmp', background: false,
    })
    // It RUNS — on the model this session's tier map resolves for it.
    expect(result).toMatchObject({ status: 'done', text: 'ok' })
    expect(models).toEqual(['small-model'])
    // And the substitution is named, both sides of it, rather than silent.
    expect(result.modelSubstitution).toEqual({ requested: 'sonnet', resolved: 'small-model' })
  })

  it('names the substitution for a per-call model this session cannot serve, and still runs', async () => {
    const models: string[] = []
    configure(port({ start: async input => {
      models.push(input.restrictions.model)
      return { agentId: input.requestedAgentId!, status: 'completed', output: 'ok', result: 'ok' }
    } }))
    const result = await spawnChildSession({
      agentDef: { ...scout, capabilityGeneration: 'generation-1' },
      model: 'opus', task: 'inspect', cwd: '/tmp', background: false,
    })
    expect(models).toEqual(['default-model'])
    expect(result.modelSubstitution).toEqual({ requested: 'opus', resolved: 'default-model' })
  })

  it('says nothing when the requested model IS available', async () => {
    configure(port(), { tierModelMap: { small: 'small-model' } })
    const result = await spawnChildSession({
      agentDef: { ...scout, model: 'small-model', capabilityGeneration: 'generation-1' },
      task: 'inspect', cwd: '/tmp', background: false,
    })
    expect(result.modelSubstitution).toBeUndefined()
  })

  it('rejects a per-call model override that widens a pinned agent model', async () => {
    configure(port(), { tierModelMap: { small: 'small-model' } })
    await expect(spawnChildSession({
      agentDef: { ...scout, model: 'small-model', capabilityGeneration: 'generation-1' },
      model: 'default-model', task: 'inspect', cwd: '/tmp', background: false,
    })).resolves.toMatchObject({ status: 'error', error: 'Agent model ceiling mismatch: default-model' })
  })

  it('defaults top-level spawns to background, awaits monitor, and returns completed results', async () => {
    const captured: PiChildStartInput[] = []
    const monitored: string[] = []
    configure(port({
      start: async input => { captured.push(structuredClone(input)); return { agentId: input.requestedAgentId!, status: 'running', output: 'partial' } },
      monitor: async agentId => { monitored.push(agentId); return { agentId, status: 'completed', output: 'monitored result', result: 'monitored result' } },
    }))
    const result = await spawnChildSession({ agentDef: scout, task: 'inspect', cwd: '/tmp' })
    expect(captured[0]!.background).toBe(true)
    expect(monitored).toHaveLength(1)
    expect(result).toMatchObject({ status: 'done', text: 'monitored result' })
  })

  /**
   * Q8-D1's other half. A top-level spawn is background, so `monitor` — not
   * `start` — is what settles it, and the host only started reporting a dead
   * child's reason on that path in `fix(pi): a child that dies tells its parent
   * why`. This pins the mapping the parent's tool result is rendered from: a
   * failed monitor becomes `status: 'error'` carrying the child's own reason,
   * which `subagent-tool.ts`'s `contentForResults` prints as
   * `[ERROR] 1. <agent> - error\n<reason>` instead of `done … (no output)`.
   */
  it('carries a background child\'s failure reason back to the parent', async () => {
    configure(port({
      start: async input => ({ agentId: input.requestedAgentId!, status: 'running', output: '' }),
      monitor: async agentId => ({
        agentId, status: 'failed', output: '',
        error: 'Invalid API Key: Your API key was rejected. It may be invalid or expired.',
      }),
    }))
    const result = await spawnChildSession({ agentDef: scout, task: 'inspect', cwd: '/tmp' })
    expect(result).toMatchObject({
      status: 'error',
      error: 'Invalid API Key: Your API key was rejected. It may be invalid or expired.',
    })
  })

  it('lets an explicit background:false win over the top-level default without monitoring', async () => {
    const captured: PiChildStartInput[] = []
    let monitors = 0
    configure(port({
      start: async input => { captured.push(structuredClone(input)); return { agentId: input.requestedAgentId!, status: 'completed', output: 'inline result', result: 'inline result' } },
      monitor: async agentId => { monitors += 1; return { agentId, status: 'completed', output: '' } },
    }))
    const result = await spawnChildSession({ agentDef: scout, task: 'inspect', cwd: '/tmp', background: false })
    expect(captured[0]!.background).toBe(false)
    expect(monitors).toBe(0)
    expect(result).toMatchObject({ status: 'done', text: 'inline result' })
  })

  it('inserts the context seed between the safety core and the agent prompt without touching restrictions', async () => {
    const captured: PiChildStartInput[] = []
    const capture = () => port({ start: async input => { captured.push(structuredClone(input)); return { agentId: input.requestedAgentId!, status: 'completed', output: 'ok' } } })
    // maxDepth is explicit so this test pins its own ceiling instead of riding
    // the repo default (now 3): the test is about prompt composition, and the
    // nested (depth-1) spawn must stay admitted whatever the default becomes.
    configure(capture(), { contextSeed: '## Parent Workspace Context\n- Workspace root: /tmp/ws', maxDepth: 3 })
    await spawnChildSession({ agentDef: { ...scout, disallowedTools: ['grep'] }, task: 'inspect', cwd: '/tmp/ws', depth: 1, background: false })

    const prompt = captured[0]!.restrictions.prompt
    const safetyAt = prompt.indexOf('## Subagent Safety Core')
    const seedAt = prompt.indexOf('## Parent Workspace Context')
    const agentAt = prompt.indexOf('Scout prompt')
    expect(safetyAt).toBeGreaterThanOrEqual(0)
    expect(seedAt).toBeGreaterThan(safetyAt)
    expect(agentAt).toBeGreaterThan(seedAt)
    // Scope safety: the seed is prose only — tool/permission restrictions and budgets are unchanged.
    expect(captured[0]!.restrictions.tools).toEqual(['read', 'find', 'ls'])
    expect(captured[0]!.restrictions.worktreePolicy).toBe('shared')
    expect(captured[0]!.budgets).toMatchObject({ depth: 2, maxDepth: 3 })

    // Without a configured seed the prompt is safety core + agent prompt only.
    captured.length = 0
    configure(capture())
    await spawnChildSession({ agentDef: scout, task: 'inspect', cwd: '/tmp/ws', background: false })
    expect(captured[0]!.restrictions.prompt).not.toContain('## Parent Workspace Context')
    expect(captured[0]!.restrictions.prompt).toContain('## Subagent Safety Core')
    expect(captured[0]!.restrictions.prompt).toContain('Scout prompt')
  })

  it('lets a definition background:true override a caller asking for the result inline', async () => {
    const backgrounds: boolean[] = []
    configure(port({ start: async input => {
      backgrounds.push(input.background === true)
      return { agentId: input.requestedAgentId!, status: 'completed', output: '' }
    } }))

    // depth 0 -> depth 1, whose default is already background; force the
    // foreground case explicitly so the override is the only thing under test.
    await spawnChildSession({ agentDef: scout, task: 'a', cwd: '/tmp', background: false })
    await spawnChildSession({
      agentDef: { ...scout, background: true }, task: 'b', cwd: '/tmp', background: false,
    })
    // An unset `background` leaves the existing depth default in charge.
    await spawnChildSession({ agentDef: scout, task: 'c', cwd: '/tmp' })

    expect(backgrounds).toEqual([false, true, true])
  })

  it('uses agent then tier then default model precedence', async () => {
    const models: string[] = []
    const worktreePolicies: string[] = []
    configure(port({ start: async input => {
      models.push(input.restrictions.model)
      worktreePolicies.push(input.restrictions.worktreePolicy)
      return { agentId: input.requestedAgentId!, status: 'completed', output: '' }
    } }), { tierModelMap: { small: 'small-model' } })
    await spawnChildSession({ agentDef: { ...scout, model: 'agent-model' }, task: 'a', cwd: '/tmp' })
    await spawnChildSession({ agentDef: scout, task: 'b', cwd: '/tmp' })
    await spawnChildSession({ agentDef: worker, task: 'c', cwd: '/tmp' })
    expect(models).toEqual(['agent-model', 'small-model', 'default-model'])
    expect(worktreePolicies).toEqual(['shared', 'shared', 'isolated-worktree'])
  })

  it('drops a subagent model the managed allowlist excludes, in both delegated inputs', async () => {
    // `settings-reference.md#availablemodels` — the allowlist covers
    // "subagents"; `model-config.md:154`
    // names the two inputs the spawner owns (frontmatter `model`, the Agent
    // tool's `model` parameter). `:167` — the override "falls back to the
    // inherited or default model rather than failing the request", which is why
    // this asserts a substitution and not an error.
    const models: string[] = []
    configure(port({ start: async input => {
      models.push(input.restrictions.model)
      return { agentId: input.requestedAgentId!, status: 'completed', output: '' }
    } }), { tierModelMap: { small: 'small-model' }, availableModels: ['small-model', 'default-model'] })
    // Frontmatter override, excluded → the tier model.
    await spawnChildSession({ agentDef: { ...scout, model: 'forbidden-model' }, task: 'a', cwd: '/tmp' })
    // Per-call override, excluded → the tier model.
    await spawnChildSession({ agentDef: scout, model: 'forbidden-model', task: 'b', cwd: '/tmp' })
    // An allowlisted override is untouched.
    await spawnChildSession({ agentDef: worker, model: 'default-model', task: 'c', cwd: '/tmp' })
    expect(models).toEqual(['small-model', 'small-model', 'default-model'])
  })

  /**
   * `model-config.md:611` — the variable "overrides the per-invocation `model`
   * parameter and the subagent definition's `model` frontmatter. Set to
   * `inherit` to use normal model resolution instead"; `workflows.md:357`
   * repeats it for workflow stages ("which overrides both").
   */
  describe('the subagent model env override', () => {
    const capture = (overrides: Partial<SpawnerRuntime> = {}) => {
      const models: string[] = []
      configure(port({ start: async input => {
        models.push(input.restrictions.model)
        return { agentId: input.requestedAgentId!, status: 'completed', output: '' }
      } }), { tierModelMap: { small: 'small-model' }, ...overrides })
      return models
    }
    const withEnv = async (values: Record<string, string | undefined>, body: () => Promise<void>) => {
      const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]))
      for (const [key, value] of Object.entries(values)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      try {
        await body()
      } finally {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      }
    }

    // P6.364 (K11). This assertion used to read "beats both a per-invocation
    // model and a frontmatter model" and it was pinned to the SUPERSEDED page
    // row. `sub-agents.md#choose-a-model` now orders the sources 1 per-invocation,
    // 2 frontmatter, 3 environment variable, 4 main conversation — and says so
    // about the change in its own words: "Before v2.1.251,
    // `CLAUDE_CODE_SUBAGENT_MODEL` came first in this order and overrode both the
    // per-invocation parameter and the frontmatter, including `model: inherit`."
    it.each(['NESSY_SUBAGENT_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL'] as const)(
      'is a DEFAULT: it loses to a frontmatter model and to a per-invocation one under %s',
      async name => {
        const models = capture()
        await withEnv({ [name]: 'env-model' }, async () => {
          await spawnChildSession({ agentDef: { ...scout, model: 'agent-model' }, task: 'a', cwd: '/tmp' })
          await spawnChildSession({ agentDef: scout, model: 'call-model', task: 'b', cwd: '/tmp' })
          await spawnChildSession({
            agentDef: { ...scout, model: 'agent-model' }, model: 'call-model', task: 'c', cwd: '/tmp',
          })
          // Tier 3 is where it DOES bind: nothing else names a model.
          await spawnChildSession({ agentDef: scout, task: 'd', cwd: '/tmp' })
        })
        expect(models).toEqual(['agent-model', 'call-model', 'call-model', 'env-model'])
      },
    )

    // `#run-every-subagent-on-one-model`: "To apply one model to every subagent,
    // teammate, and workflow agent, also set `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`
    // to `1`."
    it('restores the pre-v2.1.251 order under `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`', async () => {
      const models = capture()
      await withEnv({ NESSY_SUBAGENT_MODEL: 'env-model', CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' }, async () => {
        await spawnChildSession({ agentDef: { ...scout, model: 'agent-model' }, task: 'a', cwd: '/tmp' })
        await spawnChildSession({ agentDef: scout, model: 'call-model', task: 'b', cwd: '/tmp' })
      })
      expect(models).toEqual(['env-model', 'env-model'])
    })

    // Same section: "If you set only `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`,
    // subagents run on the main conversation's model." FORCE names no model, so
    // it decides nothing on its own.
    it('changes nothing when FORCE is set and no model is named', async () => {
      const models = capture()
      await withEnv({ NESSY_SUBAGENT_MODEL: undefined, CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' }, async () => {
        await spawnChildSession({ agentDef: { ...scout, model: 'agent-model' }, task: 'a', cwd: '/tmp' })
        await spawnChildSession({ agentDef: scout, task: 'b', cwd: '/tmp' })
      })
      expect(models).toEqual(['agent-model', 'small-model'])
    })

    // Tier 2's `inherit` is a DECISION, not a fall-through — the page defines it
    // as "selects the main conversation's model", so it must not slide into the
    // environment variable at tier 3. Unobservable before this row, because
    // tier 3 was resolved above both.
    it('lets a frontmatter `inherit` win over the environment variable', async () => {
      const models = capture()
      await withEnv({ NESSY_SUBAGENT_MODEL: 'env-model' }, async () => {
        await spawnChildSession({ agentDef: { ...scout, model: 'inherit' }, task: 'a', cwd: '/tmp' })
        await spawnChildSession({ agentDef: scout, model: 'inherit', task: 'b', cwd: '/tmp' })
      })
      expect(models).toEqual(['small-model', 'small-model'])
    })

    it('restores the existing order on `inherit`, and changes nothing when unset', async () => {
      const models = capture()
      await withEnv({ NESSY_SUBAGENT_MODEL: 'inherit', CLAUDE_CODE_SUBAGENT_MODEL: undefined }, async () => {
        await spawnChildSession({ agentDef: { ...scout, model: 'agent-model' }, task: 'a', cwd: '/tmp' })
        await spawnChildSession({ agentDef: scout, model: 'call-model', task: 'b', cwd: '/tmp' })
        await spawnChildSession({ agentDef: scout, task: 'c', cwd: '/tmp' })
      })
      await withEnv({ NESSY_SUBAGENT_MODEL: undefined, CLAUDE_CODE_SUBAGENT_MODEL: undefined }, async () => {
        await spawnChildSession({ agentDef: { ...scout, model: 'agent-model' }, task: 'd', cwd: '/tmp' })
      })
      expect(models).toEqual(['agent-model', 'call-model', 'small-model', 'agent-model'])
    })

    it('lets the Nessy spelling win when both are set', async () => {
      const models = capture()
      await withEnv({ NESSY_SUBAGENT_MODEL: 'nessy-model', CLAUDE_CODE_SUBAGENT_MODEL: 'claude-model' }, async () => {
        await spawnChildSession({ agentDef: scout, task: 'a', cwd: '/tmp' })
      })
      expect(models).toEqual(['nessy-model'])
    })

    // Q6-D2 moved BOTH sides of this symmetry from "fails" to "falls back and
    // says so" — the symmetry is the point of the test and it is preserved:
    // `sub-agents.md` § *Choose a model* gives the environment variable, the
    // per-invocation parameter and the frontmatter one substitution rule.
    it('falls back for an unresolvable env model exactly as for an unresolvable frontmatter model', async () => {
      configure(port(), { tierModelMap: { small: 'small-model' } })
      const frontmatter = await spawnChildSession({
        agentDef: { ...scout, model: 'unknown-model', capabilityGeneration: 'generation-1' },
        task: 'a', cwd: '/tmp', background: false,
      })
      let fromEnv: Awaited<ReturnType<typeof spawnChildSession>> | undefined
      await withEnv({ NESSY_SUBAGENT_MODEL: 'unknown-model' }, async () => {
        fromEnv = await spawnChildSession({
          agentDef: { ...scout, capabilityGeneration: 'generation-1' },
          task: 'b', cwd: '/tmp', background: false,
        })
      })
      const substituted = { requested: 'unknown-model', resolved: 'small-model' }
      expect(frontmatter).toMatchObject({ status: 'done', modelSubstitution: substituted })
      expect(fromEnv).toMatchObject({ status: 'done', modelSubstitution: substituted })
    })

    it('stays under the managed allowlist, dropping to normal resolution', async () => {
      const models = capture({ availableModels: ['small-model', 'default-model'] })
      await withEnv({ NESSY_SUBAGENT_MODEL: 'forbidden-model' }, async () => {
        await spawnChildSession({ agentDef: scout, task: 'a', cwd: '/tmp' })
      })
      expect(models).toEqual(['small-model'])
    })
  })

  it('blocks every named subagent override under an empty allowlist', async () => {
    // `managed-settings.md#keys-that-fail-closed`'s `availableModels` row — the
    // enforced reading of an invalid value: no
    // named selection survives, and the inherited session model is what remains.
    const models: string[] = []
    configure(port({ start: async input => {
      models.push(input.restrictions.model)
      return { agentId: input.requestedAgentId!, status: 'completed', output: '' }
    } }), { availableModels: [] })
    await spawnChildSession({ agentDef: { ...scout, model: 'agent-model' }, task: 'a', cwd: '/tmp' })
    expect(models).toEqual(['default-model'])
  })

  it('moves a read-only agent into an isolated worktree when isolation is declared', async () => {
    const worktreePolicies: string[] = []
    configure(port({ start: async input => {
      worktreePolicies.push(input.restrictions.worktreePolicy)
      return { agentId: input.requestedAgentId!, status: 'completed', output: '' }
    } }))

    // `scout` is read-only, so its default is the shared live tree. Declaring
    // isolation narrows it to an isolated copy; it never widens the other way.
    await spawnChildSession({ agentDef: scout, task: 'a', cwd: '/tmp' })
    await spawnChildSession({ agentDef: { ...scout, isolation: 'worktree' }, task: 'b', cwd: '/tmp' })
    await spawnChildSession({ agentDef: { ...worker, isolation: 'worktree' }, task: 'c', cwd: '/tmp' })

    expect(worktreePolicies).toEqual(['shared', 'isolated-worktree', 'isolated-worktree'])
  })

  it('caps WORKFLOW host submissions and rejects depth overflow before the port', async () => {
    let active = 0
    let maxActive = 0
    let calls = 0
    // Effective cap = clamp(requested, cpuCores - 2); compute the expectation
    // from the same helper so the test is core-count independent on any host.
    const requestedConcurrency = 2
    const expectedCap = computeEffectiveConcurrency(requestedConcurrency)
    configure(port({ start: async input => {
      calls += 1; active += 1; maxActive = Math.max(maxActive, active)
      await sleep(10); active -= 1
      return { agentId: input.requestedAgentId!, status: 'completed', output: '' }
    } }), { concurrency: requestedConcurrency, maxDepth: 2 })
    await Promise.all(Array.from({ length: 5 }, () => spawnChildSession({ agentDef: worker, task: 'work', cwd: '/tmp', limitScope: 'workflow' })))
    expect(maxActive).toBe(expectedCap)
    const rejected = await spawnChildSession({ agentDef: worker, task: 'deep', cwd: '/tmp', depth: 2, limitScope: 'workflow' })
    expect(rejected.error).toContain('depth limit')
    expect(calls).toBe(5)
  })

  it('clamps effective concurrency to cpuCores - 2, floored at 1, ceilinged by the request', () => {
    // The config ceiling is machine-independent; the semaphore narrows it to the
    // host's spare cores (cores - 2), never below 1, never above the request.
    expect(computeEffectiveConcurrency(16, 32)).toBe(16)   // request is the ceiling
    expect(computeEffectiveConcurrency(16, 8)).toBe(6)     // cores - 2 narrows it
    expect(computeEffectiveConcurrency(16, 3)).toBe(1)     // 1 spare core
    expect(computeEffectiveConcurrency(16, 2)).toBe(1)     // floor at 1 (0 spare)
    expect(computeEffectiveConcurrency(16, 1)).toBe(1)     // single-core floor
    expect(computeEffectiveConcurrency(2, 32)).toBe(2)     // small explicit request wins
    // Unset/invalid request falls back to the default-16 ceiling before clamping.
    expect(computeEffectiveConcurrency(undefined, 32)).toBe(16)
    expect(computeEffectiveConcurrency(0, 32)).toBe(16)
    // Live detection produces a positive integer bounded by real parallelism.
    const live = computeEffectiveConcurrency(16)
    expect(live).toBeGreaterThanOrEqual(1)
    expect(live).toBeLessThanOrEqual(Math.max(1, availableParallelism()))
  })

  it('rejects a spawn that would exceed the configured depth ceiling before hitting the port', async () => {
    let started = 0
    configure(port({ start: async input => { started += 1; return { agentId: input.requestedAgentId!, status: 'completed', output: '' } } }), { maxDepth: 5 })
    // depth arg is the PARENT depth; child depth = arg + 1. maxDepth 5 admits a
    // depth-5 child (parent depth 4) and rejects a depth-6 child (parent depth 5).
    const admitted = await spawnChildSession({ agentDef: worker, task: 'deep-ok', cwd: '/tmp', depth: 4, background: false })
    expect(admitted.status).toBe('done')
    const rejected = await spawnChildSession({ agentDef: worker, task: 'too-deep', cwd: '/tmp', depth: 5, background: false })
    expect(rejected.status).toBe('error')
    expect(rejected.error).toContain('depth limit')
    // Only the admitted spawn reached the port; the over-depth one was rejected first.
    expect(started).toBe(1)
  })

  /**
   * Every place that defines a nesting-depth default must agree, or whichever
   * one is higher silently wins as a fallback wherever the other is unset
   * (historically two of them disagreed and moving one restored 5). The value
   * itself is bound by sub-agents.md:867 / env-vars.md:281: THREE subagent
   * layers below the main conversation — v2.1.219 raised Claude's default from
   * 1, so our old 1 was parity with v2.1.217-218, not a different rule. The
   * fourth definer, `SessionManager.ts`'s plugin-hook budgets fallback, calls
   * `resolveMaxSubagentSpawnDepth()`, whose no-override answer is asserted here.
   */
  it('defaults nesting depth to 3 in every place that defines a default', () => {
    expect(DEFAULT_MAX_SUBAGENT_SPAWN_DEPTH).toBe(3)
    expect(DEFAULT_MAX_DEPTH).toBe(DEFAULT_MAX_SUBAGENT_SPAWN_DEPTH)
    expect(DEFAULT_PI_ORCHESTRATOR_CONFIG.depth).toBe(DEFAULT_MAX_SUBAGENT_SPAWN_DEPTH)
    expect(resolveMaxSubagentSpawnDepth({})).toBe(DEFAULT_MAX_SUBAGENT_SPAWN_DEPTH)
  })

  it('admits child, grandchild and third-layer spawns at the default depth and refuses the fourth layer', async () => {
    let started = 0
    configure(port({ start: async input => { started += 1; return { agentId: input.requestedAgentId!, status: 'completed', output: '' } } }))

    // env-vars.md:281 — "At the default, subagents can spawn their own
    // subagents, and a subagent at the third layer can't spawn further."
    const child = await spawnChildSession({ agentDef: worker, task: 'layer one', cwd: '/tmp', background: false })
    expect(child.status).toBe('done')
    const grandchild = await spawnChildSession({ agentDef: worker, task: 'layer two', cwd: '/tmp', depth: 1, background: false })
    expect(grandchild.status).toBe('done')
    const thirdLayer = await spawnChildSession({ agentDef: worker, task: 'layer three', cwd: '/tmp', depth: 2, background: false })
    expect(thirdLayer.status).toBe('done')
    const fourthLayer = await spawnChildSession({ agentDef: worker, task: 'layer four', cwd: '/tmp', depth: 3, background: false })
    expect(fourthLayer.status).toBe('error')
    expect(fourthLayer.error).toContain('depth limit')
    // Only the three admitted layers reached the port; the refusal never did.
    expect(started).toBe(3)
  })

  it('still allows a fourth layer when the config raises the depth above the default', async () => {
    configure(port(), { maxDepth: 4 })

    const fourthLayer = await spawnChildSession({ agentDef: worker, task: 'four levels', cwd: '/tmp', depth: 3, background: false })
    expect(fourthLayer.status).toBe('done')
  })

  it('maxDepth 1 — the documented nesting-off value — still refuses a grandchild', async () => {
    // sub-agents.md:873-884 — "Set `1` to turn nesting off."
    let started = 0
    configure(port({ start: async input => { started += 1; return { agentId: input.requestedAgentId!, status: 'completed', output: '' } } }), { maxDepth: 1 })

    const child = await spawnChildSession({ agentDef: worker, task: 'one level', cwd: '/tmp', background: false })
    expect(child.status).toBe('done')
    const grandchild = await spawnChildSession({ agentDef: worker, task: 'two levels', cwd: '/tmp', depth: 1, background: false })
    expect(grandchild.status).toBe('error')
    expect(grandchild.error).toContain('depth limit')
    expect(started).toBe(1)
  })

  it('returns the text a child produced before its retries were exhausted', async () => {
    // `failure()` hardcoded `text: ''`. The host writes a child's output onto its
    // durable record before a failure propagates, so the record can hold real
    // work even when the start call rejected — that work is now recovered.
    let attempts = 0
    configure(port({
      start: async () => { attempts += 1; throw Object.assign(new Error('429 rate limit'), { status: 429 }) },
      getResult: async agentId => ({ agentId, status: 'failed', output: 'Partial analysis: found 3 issues.' }),
    }))

    const result = await spawnChildSession({ agentDef: worker, task: 'analyse', cwd: '/tmp', background: false })

    expect(attempts).toBe(3)
    expect(result.text).toContain('Partial analysis')
    // Failure shape otherwise unchanged.
    expect(result.status).toBe('error')
    expect(result.error).toContain('429')
  })

  it('keeps the empty failure text when the child produced nothing to recover', async () => {
    configure(port({
      start: async () => { throw new Error('child-session-budgets-invalid') },
      getResult: async () => { throw new Error('unknown-agent-id') },
    }))

    const result = await spawnChildSession({ agentDef: worker, task: 'analyse', cwd: '/tmp', background: false })

    expect(result.text).toBe('')
    expect(result.status).toBe('error')
    expect(result.error).toBe('child-session-budgets-invalid')
  })

  it('stops a child admitted before caller abort and returns aborted', async () => {
    const controller = new AbortController()
    let release!: () => void
    let markStarted!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const startEntered = new Promise<void>(resolve => { markStarted = resolve })
    const stopped: string[] = []
    configure(port({
      start: async input => { markStarted(); await pending; return { agentId: input.requestedAgentId!, status: 'running', output: '' } },
      stop: async agentId => { stopped.push(agentId) },
    }))
    const run = spawnChildSession({ agentDef: worker, task: 'work', cwd: '/tmp', signal: controller.signal })
    await startEntered
    controller.abort(); release()
    const result = await run
    expect(result.status).toBe('aborted')
    // The post-settlement stop is intentionally idempotent: it closes the
    // host window where the first stop can arrive before durable admission.
    expect(stopped.length).toBeGreaterThanOrEqual(1)
    expect(new Set(stopped)).toEqual(new Set([stopped[0]!]))
  })

  it('does not start a semaphore-queued child after caller abort', async () => {
    let releaseFirst!: () => void
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
    const startedTasks: string[] = []
    configure(port({
      start: async input => {
        startedTasks.push(input.task)
        if (input.task === 'first') await firstGate
        return { agentId: input.requestedAgentId!, status: 'completed', output: input.task }
      },
    }), { concurrency: 1 })

    // The semaphore is the WORKFLOW ceiling since R60; an Agent-tool spawn is
    // refused rather than queued and would never reach this queue.
    const first = spawnChildSession({ agentDef: worker, task: 'first', cwd: '/tmp', background: false, limitScope: 'workflow' })
    await Promise.resolve()
    const controller = new AbortController()
    const queued = spawnChildSession({ agentDef: worker, task: 'queued', cwd: '/tmp', background: false, signal: controller.signal, limitScope: 'workflow' })
    controller.abort()
    releaseFirst()

    expect(await first).toMatchObject({ status: 'done' })
    expect(await queued).toMatchObject({ status: 'aborted', error: 'aborted' })
    expect(startedTasks).toEqual(['first'])
  })

  it('stops an admitted background child when abort wins a pending monitor', async () => {
    const controller = new AbortController()
    let markMonitorEntered!: () => void
    let releaseMonitor!: () => void
    const monitorEntered = new Promise<void>(resolve => { markMonitorEntered = resolve })
    const monitorGate = new Promise<void>(resolve => { releaseMonitor = resolve })
    const stopped: string[] = []
    configure(port({
      start: async input => ({ agentId: input.requestedAgentId!, status: 'running', output: '' }),
      monitor: async agentId => {
        markMonitorEntered()
        await monitorGate
        return { agentId, status: 'completed', output: 'late' }
      },
      stop: async agentId => { stopped.push(agentId) },
    }))

    const run = spawnChildSession({
      agentDef: worker, task: 'monitored', cwd: '/tmp', background: true,
      requestedAgentId: 'monitor-child', signal: controller.signal,
    })
    await monitorEntered
    controller.abort()
    const settledBeforeMonitor = await Promise.race([
      run.then(result => ({ result })),
      sleep(25).then(() => null),
    ])
    releaseMonitor()
    await run

    expect(settledBeforeMonitor?.result).toMatchObject({ status: 'aborted', error: 'aborted' })
    expect(stopped).toEqual(['monitor-child'])
  })

  it('retries only rate limits and surfaces ordinary port failures', async () => {
    let attempts = 0
    const requestedIds: string[] = []
    configure(port({ start: async input => {
      attempts += 1
      requestedIds.push(input.requestedAgentId!)
      if (attempts < 3) throw Object.assign(new Error('HTTP 429'), { status: 429 })
      return { agentId: input.requestedAgentId!, status: 'completed', output: 'ok' }
    } }))
    const admitted: string[] = []
    expect((await spawnChildSession({ agentDef: worker, task: 'work', cwd: '/tmp', requestedAgentId: 'reserved', onAdmitted: id => admitted.push(id) })).status).toBe('done')
    expect(attempts).toBe(3)
    expect(new Set(requestedIds).size).toBe(3)
    expect(admitted).toEqual([requestedIds[2]!])

    configure(port({ start: async () => { throw new Error('child exploded') } }))
    expect(await spawnChildSession({ agentDef: worker, task: 'work', cwd: '/tmp' }))
      .toMatchObject({ status: 'error', error: 'child exploded' })
  })

  it('honors cfg.retryBaseDelayMs for rate-limit backoff, doubling each attempt', async () => {
    // The knob is what `configureSpawnerForGeneration` raises to 5s on the
    // gateway. Every other case in this file pins it to 0 to stay fast, so
    // without this one nothing proves a throttled child actually WAITS before
    // re-hitting the limiter that just rejected it — the 250ms default is the
    // bug being fixed and a silently ignored knob would look identical.
    const startedAt: number[] = []
    configure(port({ start: async () => {
      startedAt.push(Date.now())
      throw Object.assign(new Error('HTTP 429 rate limit'), { status: 429 })
    } }), { retryBaseDelayMs: () => 40 })

    const result = await spawnChildSession({ agentDef: worker, task: 'work', cwd: '/tmp', background: false })

    expect(result.status).toBe('error')
    expect(startedAt).toHaveLength(3)
    // base x 2^(attempt-1): 40ms then 80ms. Lower bounds carry a small timer
    // tolerance; a dropped knob (0ms) or a flat ladder (40/40) both fail.
    expect(startedAt[1]! - startedAt[0]!).toBeGreaterThanOrEqual(35)
    expect(startedAt[2]! - startedAt[1]!).toBeGreaterThanOrEqual(75)
  })

  it('reads the backoff base at spawn time, so an endpoint switch is not snapshotted', async () => {
    // `update_runtime_config` moves a session on and off the gateway at any
    // point, but the spawner is only reconfigured when a capability generation
    // commits. A value captured at `configureSpawner` time would leave children
    // hammering a freshly-throttled gateway at the old 250ms base — the same
    // staleness class already documented for `thinkingLevel`.
    let onGateway = false
    const startedAt: number[] = []
    configure(port({ start: async () => {
      startedAt.push(Date.now())
      throw Object.assign(new Error('HTTP 429'), { status: 429 })
    } }), { retryBaseDelayMs: () => (onGateway ? 60 : 0) })

    await spawnChildSession({ agentDef: worker, task: 'before', cwd: '/tmp', background: false })
    expect(startedAt[2]! - startedAt[0]!).toBeLessThan(35)

    onGateway = true
    startedAt.length = 0
    await spawnChildSession({ agentDef: worker, task: 'after', cwd: '/tmp', background: false })
    // 60 + 120 with no reconfigure in between.
    expect(startedAt[2]! - startedAt[0]!).toBeGreaterThanOrEqual(170)
  })

  it('keeps a throttled batch alive: retry-exhausted children degrade to error results without failing peers', async () => {
    // At the raised concurrency, many children stream against the gateway at once.
    // A child whose starts keep returning 429 exhausts its bounded retries and
    // resolves to an error result — it must NOT reject and abort sibling children.
    const attemptsByTask = new Map<string, number>()
    configure(port({ start: async input => {
      const task = input.task
      const n = (attemptsByTask.get(task) ?? 0) + 1
      attemptsByTask.set(task, n)
      // Odd-indexed tasks are permanently throttled; even-indexed succeed first try.
      if (task.startsWith('throttled')) {
        throw Object.assign(new Error('HTTP 429 rate limit'), { status: 429 })
      }
      return { agentId: input.requestedAgentId!, status: 'completed', output: 'ok', result: 'ok' }
    } }))

    const tasks = ['ok-1', 'throttled-2', 'ok-3', 'throttled-4', 'ok-5']
    const results = await Promise.all(
      tasks.map(task => spawnChildSession({ agentDef: worker, task, cwd: '/tmp', background: false })),
    )

    // The batch as a whole resolves — no spawn rejected the whole Promise.all.
    expect(results).toHaveLength(5)
    const ok = results.filter(r => r.status === 'done')
    const errored = results.filter(r => r.status === 'error')
    expect(ok).toHaveLength(3)
    expect(errored).toHaveLength(2)
    // Throttled children exhausted the bounded retry budget (3 attempts each)
    // rather than blocking forever or taking down the batch.
    expect(attemptsByTask.get('throttled-2')).toBe(3)
    expect(attemptsByTask.get('throttled-4')).toBe(3)
    for (const r of errored) expect(r.error).toContain('429')
  })
  // ---- Conversation forks (sub-agents.md § Fork the current conversation) ----

  it('gives a fork this session model, tool pool and thinking level, and no policy of its own', async () => {
    const captured: PiChildStartInput[] = []
    configure(port({ start: async input => { captured.push(structuredClone(input)); return { agentId: input.requestedAgentId!, status: 'completed', output: 'forked' } } }), {
      modelId: 'session-model',
      // A tier map would steer a NAMED subagent to another model; :1042 says a
      // fork uses the main session's model, so it must not be consulted.
      tierModelMap: { small: 'small-model', medium: 'medium-model', big: 'big-model' },
      thinkingLevel: () => 'high',
      sessionToolNames: ['read', 'bash', 'subagent', 'ask_user', 'mcp__github__list_issues'],
      contextSeed: 'SEED_BLOCK',
    })

    const result = await spawnChildSession({
      agentDef: FORK_AGENT_DEFINITION, task: 'draft the tests', cwd: '/tmp/ws', background: false,
      // A per-call model would win for a named subagent; a fork ignores it.
      model: 'call-model', effort: 'low',
    })

    expect(result).toMatchObject({ status: 'done', text: 'forked' })
    expect(captured).toHaveLength(1)
    const restrictions = captured[0]!.restrictions
    expect(captured[0]!.agent).toBe('fork')
    expect(restrictions.fork).toBe(true)
    expect(restrictions.model).toBe('session-model')
    expect(restrictions.tools).toEqual(['read', 'bash', 'subagent', 'ask_user', 'mcp__github__list_issues'])
    expect(restrictions.thinkingLevel).toBe('high')
    // Empty, not "safety core + seed + agent prompt": the child backend appends
    // this to its own base prompt, so an empty value reproduces the parent's.
    expect(restrictions.prompt).toBe('')
    // Absent => the host inherits the parent mode verbatim. A present mode is
    // the only value `clampPermissionModeToParent` could act on, so a fork must
    // never carry one.
    expect(restrictions).not.toHaveProperty('permissionMode')
    expect(restrictions).not.toHaveProperty('maxTurns')
    expect(restrictions).not.toHaveProperty('capabilityGeneration')
    expect(restrictions).not.toHaveProperty('definitionKey')
    expect(restrictions).not.toHaveProperty('skillKeys')
  })

  it('fails a fork loudly on a host that cannot supply the parent tool pool', async () => {
    configure(port(), { modelId: 'session-model' })
    await expect(spawnChildSession({ agentDef: FORK_AGENT_DEFINITION, task: 'draft', cwd: '/tmp', background: false }))
      .resolves.toMatchObject({ status: 'error', error: expect.stringContaining('fork-session-tool-pool-unavailable') })
  })
  it('keeps subagent listed in a fork at the depth limit and fails the call instead of withholding the tool', async () => {
    // :326 and :862 — "A fork at the limit keeps `Agent` in its inherited tool
    // list, but the tool returns an error instead of spawning."
    const captured: PiChildStartInput[] = []
    configure(port({ start: async input => { captured.push(structuredClone(input)); return { agentId: input.requestedAgentId!, status: 'completed', output: 'forked' } } }), {
      modelId: 'session-model', maxDepth: 2, sessionToolNames: ['read', 'subagent'],
    })

    // One below the limit: the fork spawns, and `subagent` is in the pool it is
    // admitted with — that is the "stays listed" half.
    await spawnChildSession({ agentDef: FORK_AGENT_DEFINITION, task: 'draft', cwd: '/tmp', depth: 1, background: false })
    expect(captured).toHaveLength(1)
    expect(captured[0]!.restrictions.tools).toContain('subagent')
    expect(captured[0]!.budgets).toMatchObject({ depth: 2, maxDepth: 2 })

    // At the limit: the call returns an error rather than the tool disappearing.
    const atLimit = await spawnChildSession({ agentDef: FORK_AGENT_DEFINITION, task: 'draft', cwd: '/tmp', depth: 2, background: false })
    expect(atLimit).toMatchObject({ agent: 'fork', status: 'error', error: 'Subagent depth limit exceeded (2)' })
    expect(captured).toHaveLength(1)
  })

  it('refuses a nested fork with headroom in the depth budget, naming the fork rule not the depth rule', async () => {
    // :1052 — "A fork can't spawn further forks." Unconditional: this runs at
    // depth 0 of a maxDepth-3 tree, so the depth budget cannot be what fails.
    const captured: PiChildStartInput[] = []
    configure(port({ start: async input => { captured.push(structuredClone(input)); return { agentId: input.requestedAgentId!, status: 'completed', output: 'ok' } } }), {
      modelId: 'session-model', maxDepth: 3, sessionToolNames: ['read', 'subagent'], isForkSession: true,
    })

    const nested = await spawnChildSession({ agentDef: FORK_AGENT_DEFINITION, task: 'fork again', cwd: '/tmp', depth: 0, background: false })
    expect(nested.status).toBe('error')
    expect(nested.error).toContain('a fork cannot spawn another fork')
    expect(nested.error).not.toContain('depth limit')
    expect(captured).toHaveLength(0)

    // A fork may still delegate to a NAMED subagent: only forking is barred.
    const named = await spawnChildSession({ agentDef: scout, task: 'inspect', cwd: '/tmp', depth: 0, background: false })
    expect(named.status).toBe('done')
    expect(captured).toHaveLength(1)
    expect(captured[0]!.agent).toBe('scout')
  })

  // ---- Concurrent subagent limit (sub-agents.md § Concurrent subagent limit) ----

  /**
   * A held gate plus a port that parks every start, so "N are running" is a real
   * state rather than a simulated counter.
   */
  function gatedPort(): { port: PiChildSessionPort; started: string[]; release: () => void } {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const started: string[] = []
    return {
      started,
      release,
      port: port({
        start: async input => {
          started.push(input.task)
          await gate
          return { agentId: input.requestedAgentId!, status: 'completed', output: input.task, result: input.task }
        },
      }),
    }
  }

  // AWAITS `run` before restoring. A synchronous `try { return run() } finally`
  // hands the env back the moment the body first suspends, so every assertion
  // after the first `await` would read the real environment instead.
  async function withCeiling<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
    const previous = process.env.NESSY_MAX_CONCURRENT_SUBAGENTS
    if (value === undefined) delete process.env.NESSY_MAX_CONCURRENT_SUBAGENTS
    else process.env.NESSY_MAX_CONCURRENT_SUBAGENTS = value
    try {
      return await run()
    } finally {
      if (previous === undefined) delete process.env.NESSY_MAX_CONCURRENT_SUBAGENTS
      else process.env.NESSY_MAX_CONCURRENT_SUBAGENTS = previous
    }
  }

  it('fails the over-limit Agent-tool spawn with the documented message instead of queueing it', async () => {
    // :898 — "spawning another with the Agent tool FAILS with `Concurrent
    // subagent limit reached`, and the error tells Claude not to retry". A queue
    // eventually succeeds, so the model never learns it over-fanned-out; that is
    // the half of f086 nothing in the product ever printed.
    await withCeiling('2', async () => {
      const { port: gated, started, release } = gatedPort()
      configure(gated)

      const first = spawnChildSession({ agentDef: worker, task: 'one', cwd: '/tmp', background: false })
      const second = spawnChildSession({ agentDef: worker, task: 'two', cwd: '/tmp', background: false })
      await Promise.resolve()
      await Promise.resolve()

      const refused = await spawnChildSession({ agentDef: worker, task: 'three', cwd: '/tmp', background: false })
      expect(refused.status).toBe('error')
      expect(refused.error).toContain('Concurrent subagent limit reached')
      expect(refused.error).toContain('2 subagents are already running')
      expect(refused.error).toContain('Do not retry')
      // Refused BEFORE the port: no third child was ever created.
      expect(started).toEqual(['one', 'two'])

      release()
      expect(await first).toMatchObject({ status: 'done' })
      expect(await second).toMatchObject({ status: 'done' })

      // "Spawning succeeds again when the running count drops below the limit."
      const after = await spawnChildSession({ agentDef: worker, task: 'four', cwd: '/tmp', background: false })
      expect(after.status).toBe('done')
      expect(started).toEqual(['one', 'two', 'four'])
    })
  })

  it('counts a fork against the ceiling but never refuses one, and leaves workflow and judge children alone', async () => {
    // :902 — a fork "takes a slot while it runs and is NEVER blocked by the
    // limit"; :905 — workflow agents and other features' agents "follow their own
    // limits instead", so they are neither counted nor refused here.
    await withCeiling('1', async () => {
      const { port: gated, started, release } = gatedPort()
      // A fork composes its restrictions from the session's own tool pool.
      // `concurrency: 1` pins the shared semaphore to ONE slot on every machine
      // — `computeEffectiveConcurrency` is `max(1, min(ceiling, cpuCores - 2))`,
      // so a 2-core CI container gets 1 while a developer laptop gets many.
      // Pinning it reproduces the tightest case deterministically instead of
      // letting the host's core count decide what this test measures.
      configure(gated, { sessionToolNames: ['read', 'subagent'], concurrency: 1 })

      const held = spawnChildSession({ agentDef: worker, task: 'held', cwd: '/tmp', background: false, limitScope: 'agent-tool' })
      await Promise.resolve()
      await Promise.resolve()

      // At the limit an Agent-tool spawn is refused...
      expect((await spawnChildSession({ agentDef: worker, task: 'blocked', cwd: '/tmp', background: false }))
        .error).toContain('Concurrent subagent limit reached')

      // ...while the fork, the workflow stage and the judge are none of them
      // REFUSED. Refusal is the rule under test; arrival ORDER and simultaneity
      // are not, and asserting them made this case fail on CI while passing on
      // every developer machine. `workflow` and `internal` children share the
      // `cpuCores - 2` semaphore (`computeEffectiveConcurrency`), which is 1 on
      // a 2-core runner — so the judge legitimately QUEUES behind the workflow
      // stage until the gate opens. Queuing is not refusing, and the previous
      // "all four reached the port" assertion could not tell the two apart.
      const fork = spawnChildSession({ agentDef: FORK_AGENT_DEFINITION, task: 'user fork', cwd: '/tmp', background: false, limitScope: 'fork' })
      const flow = spawnChildSession({ agentDef: worker, task: 'workflow stage', cwd: '/tmp', background: false, limitScope: 'workflow' })
      const judge = spawnChildSession({ agentDef: scout, task: 'guardian', cwd: '/tmp', background: false, limitScope: 'internal' })

      // The fork is the one that must not merely avoid refusal but START while
      // the ceiling is full — that is ":902, takes a slot and is NEVER blocked".
      await waitUntil(() => started.includes('user fork'), 'the fork started while the ceiling was full')

      release()
      const settled = await Promise.all([held, fork, flow, judge])
      expect(settled.map(r => r.status)).toEqual(['done', 'done', 'done', 'done'])
      expect(settled.every(r => r.error === undefined)).toBe(true)
      // All four reached the port; the three non-agent-tool scopes were never
      // refused, whatever order the semaphore let them through in.
      expect([...started].sort()).toEqual(['guardian', 'held', 'user fork', 'workflow stage'])
    })
  })

  it('exempts an ultracode session from the check while still counting the slot', async () => {
    // :898 — "Sessions with ultracode active are exempt: the limit isn't
    // enforced there." Exempt from the CHECK, not from the COUNT.
    await withCeiling('1', async () => {
      const { port: gated, started, release } = gatedPort()
      configure(gated, { thinkingLevel: () => 'max' })

      const held = spawnChildSession({ agentDef: worker, task: 'one', cwd: '/tmp', background: false })
      await Promise.resolve()
      const extra = spawnChildSession({ agentDef: worker, task: 'two', cwd: '/tmp', background: false })
      await Promise.resolve()
      await Promise.resolve()
      expect(started).toEqual(['one', 'two'])

      release()
      expect(await held).toMatchObject({ status: 'done' })
      expect(await extra).toMatchObject({ status: 'done' })
    })
  })

  it('still gates the level just BELOW max, pinning the exemption to the effort level', async () => {
    // The BOUNDARY that says which predicate `:898`'s "ultracode" is.
    // `sub-agents.md#concurrent-subagent-limit` links the word to
    // `model-config#adjust-effort-level`, so the exemption is the max EFFORT
    // level and `xhigh` — the level immediately below it in
    // `THINKING_LEVEL_IDS` — is still gated.
    //
    // Without this case the exemption test above is satisfied by ANY predicate
    // that happens to be true at `max`, including the unrelated `ultracode`
    // prompt keyword (`WORKFLOW_TRIGGER_KEYWORD`) that P2.341 proposed keying it
    // on. This is the assertion that would fail on that fix.
    await withCeiling('1', async () => {
      const { port: gated, started, release } = gatedPort()
      configure(gated, { thinkingLevel: () => 'xhigh' })

      const held = spawnChildSession({ agentDef: worker, task: 'one', cwd: '/tmp', background: false })
      await Promise.resolve()
      const refused = await spawnChildSession({ agentDef: worker, task: 'two', cwd: '/tmp', background: false })
      expect(refused.status).toBe('error')
      expect(refused.error).toContain('Concurrent subagent limit reached')
      // Refused BEFORE the port: no second child was created.
      expect(started).toEqual(['one'])

      release()
      expect(await held).toMatchObject({ status: 'done' })
    })
  })

  it('keeps the Agent-tool path out of the cpuCores-narrowed workflow semaphore', async () => {
    // With the semaphore at 1 an Agent-tool fan-out must still run in parallel —
    // otherwise the documented 20 is unreachable on any machine with <= 21 cores,
    // which is what made the old shared semaphore the wrong gate.
    await withCeiling('5', async () => {
      let active = 0
      let maxActive = 0
      configure(port({ start: async input => {
        active += 1; maxActive = Math.max(maxActive, active)
        await sleep(5); active -= 1
        return { agentId: input.requestedAgentId!, status: 'completed', output: '' }
      } }), { concurrency: 1 })

      await Promise.all(Array.from({ length: 3 }, (_unused, index) =>
        spawnChildSession({ agentDef: worker, task: `t${index}`, cwd: '/tmp', background: false })))
      expect(maxActive).toBe(3)
    })
  })

  it('sends the host a per-parent backstop above BOTH scoped ceilings, not either one', async () => {
    // Gate (b) counts every scope's children against one number, so sending a
    // scoped ceiling would kill the other scope's spawns. It has to stay a
    // runaway detector.
    await withCeiling('20', async () => {
      const captured: PiChildStartInput[] = []
      configure(port({ start: async input => {
        captured.push(structuredClone(input))
        return { agentId: input.requestedAgentId!, status: 'completed', output: '' }
      } }), { concurrency: 16 })

      await spawnChildSession({ agentDef: worker, task: 'work', cwd: '/tmp', background: false })
      const backstop = captured[0]!.budgets.concurrency
      expect(backstop).toBeGreaterThan(20)
      expect(backstop).toBe(20 + computeEffectiveConcurrency(16) + 4)
    })
  })

  /**
   * F1.225 — the host's `turnLimitReached` (a child run stopped at its
   * `maxTurns` cap) reaches the parent's result on both settling paths, and a
   * run that was not capped carries nothing.
   */
  it('F1.225: carries the host\'s turn-limit mark onto the result, foreground and background', async () => {
    configure(port({ start: async input => ({ agentId: input.requestedAgentId!, status: 'completed', output: 'half done', result: 'half done', turnLimitReached: true }) }))
    const foreground = await spawnChildSession({ agentDef: worker, task: 'work', cwd: '/tmp', background: false })
    expect(foreground.status).toBe('done')
    expect(foreground.text).toBe('half done')
    expect(foreground.turnLimitReached).toBe(true)

    configure(port({
      start: async input => ({ agentId: input.requestedAgentId!, status: 'running', output: '' }),
      monitor: async agentId => ({ agentId, status: 'completed', output: 'half done', turnLimitReached: true }),
    }))
    const background = await spawnChildSession({ agentDef: worker, task: 'work', cwd: '/tmp', background: true })
    expect(background.turnLimitReached).toBe(true)

    configure(port())
    const plain = await spawnChildSession({ agentDef: worker, task: 'work', cwd: '/tmp', background: false })
    expect(plain).not.toHaveProperty('turnLimitReached')
  })
})
