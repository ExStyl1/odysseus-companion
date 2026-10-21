import { describe, expect, it } from 'bun:test'
import { HOOK_REGISTRY_TEXT_CAP, hookTaskRegistryInput } from '@nessy-agent/shared/automations'
import { projectBackgroundTasks, projectSessionCrons } from './hook-task-registry-projection.ts'

const NO_SOURCES = {
  monitors: [],
  children: [],
  evaluatorKinds: [],
  shells: [],
} as const

describe('projectBackgroundTasks (hooks.md :2196-:2208)', () => {
  it('is EMPTY, not absent, when nothing is in flight', () => {
    // `:2194` — "empty when nothing is in flight". The caller emits whatever
    // this returns, so returning `[]` here is what keeps the key present.
    expect(projectBackgroundTasks(NO_SOURCES)).toEqual([])
  })

  it('passes a monitor entry through with its server/tool intact', () => {
    const monitor = {
      id: 'process_1', type: 'monitor' as const, status: 'running' as const,
      description: 'watch the socket', server: 'example.test', tool: 'ws',
    }
    expect(projectBackgroundTasks({ ...NO_SOURCES, monitors: [monitor] })).toEqual([monitor])
  })

  it('gives a running child session the subagent label and agent_type', () => {
    expect(projectBackgroundTasks({
      ...NO_SOURCES,
      children: [{ agentId: 'agent_1', agent: 'Explore', task: 'sweep the adapters', status: 'running' }],
    })).toEqual([{
      id: 'agent_1', type: 'subagent', status: 'running',
      description: 'sweep the adapters', agent_type: 'Explore',
    }])
  })

  it('omits a child that has already reached a terminal status', () => {
    expect(projectBackgroundTasks({
      ...NO_SOURCES,
      children: [
        { agentId: 'done', agent: 'Explore', task: 'finished', status: 'completed' },
        { agentId: 'live', agent: 'Plan', task: 'still going', status: 'starting' },
      ],
    }).map(entry => entry.id)).toEqual(['live'])
  })

  it('reports a backgrounded child ONCE, keeping the richer child entry', () => {
    // The evaluator map and the child record describe the same task under the
    // same id. Reporting both would double-count what the session is waiting on.
    const entries = projectBackgroundTasks({
      ...NO_SOURCES,
      children: [{ agentId: 'agent_9', backgroundTaskId: 'task_9', agent: 'Explore', task: 'deep audit', status: 'running' }],
      evaluatorKinds: [['task_9', 'subagent']],
    })
    expect(entries).toHaveLength(1)
    expect(entries[0]).toEqual({
      id: 'task_9', type: 'subagent', status: 'running',
      description: 'deep audit', agent_type: 'Explore',
    })
  })

  it('maps evaluator kinds onto the friendly vocabulary and keeps an unknown one raw', () => {
    // `:2201` — "Falls back to the raw discriminant for unrecognized types."
    expect(projectBackgroundTasks({
      ...NO_SOURCES,
      evaluatorKinds: [['t1', 'mcp'], ['t2', 'workflow'], ['t3', 'quantum_evaluator']],
    }).map(entry => entry.type)).toEqual(['MCP task', 'workflow', 'quantum_evaluator'])
  })

  it('prefers an evaluator summary over the bare task id for description', () => {
    expect(projectBackgroundTasks({
      ...NO_SOURCES,
      evaluatorKinds: [['t1', 'workflow']],
      evaluatorSummaries: new Map([['t1', { summary: 'release rehearsal' }]]),
    })[0]?.description).toBe('release rehearsal')
  })

  it("carries the shell's command line, which is what :2204 is for", () => {
    // `:2204` — "Shell command line, capped at 1000 characters. Present only for
    // `shell` tasks". A fleet Stop hook logs or blocks on THIS; the handle alone
    // says nothing about what the agent left running.
    const entries = projectBackgroundTasks({
      ...NO_SOURCES,
      shells: [['process_ab', 'npm run build -- --watch']],
    })
    expect(entries).toEqual([{
      id: 'process_ab', type: 'shell', status: 'running',
      description: 'npm run build -- --watch', command: 'npm run build -- --watch',
    }])
  })

  it('falls back to the handle when a legacy record carries no command', () => {
    // Records written before the field existed, and adopted after a restart.
    // An absent `command` is honest; a `command` filled with the handle is not.
    const entries = projectBackgroundTasks({ ...NO_SOURCES, shells: [['process_ab', '']] })
    expect(entries).toEqual([{ id: 'process_ab', type: 'shell', status: 'running', description: 'process_ab' }])
    expect(entries[0]).not.toHaveProperty('command')
  })

  it('caps the command with the same documented marker as description', () => {
    const entry = projectBackgroundTasks({
      ...NO_SOURCES,
      shells: [['process_ab', `sleep 1 # ${'z'.repeat(1500)}`]],
    })[0]
    expect(entry?.command?.length).toBe(HOOK_REGISTRY_TEXT_CAP)
    expect(entry?.command?.endsWith('… [+524 chars]')).toBe(true)
  })

  it('never puts a command on a non-shell entry', () => {
    // `:2204` scopes the field to shell tasks. A subagent or monitor entry that
    // carried one would be reporting a field the contract does not give it.
    const entries = projectBackgroundTasks({
      ...NO_SOURCES,
      children: [{ agentId: 'agent_1', agent: 'Explore', task: 'sweep', status: 'running' }],
      evaluatorKinds: [['t1', 'workflow']],
      monitors: [{ id: 'process_m', type: 'monitor', status: 'running', description: 'watch' }],
    })
    for (const entry of entries) expect(entry).not.toHaveProperty('command')
  })

  it('caps a long child description with the documented marker', () => {
    const description = projectBackgroundTasks({
      ...NO_SOURCES,
      children: [{ agentId: 'agent_1', agent: 'Explore', task: 'w'.repeat(1500), status: 'running' }],
    })[0]?.description ?? ''
    expect(description.length).toBe(HOOK_REGISTRY_TEXT_CAP)
    expect(description.endsWith('… [+514 chars]')).toBe(true)
  })
})

describe('projectSessionCrons (hooks.md :2210-:2217)', () => {
  it('is EMPTY, not absent, when nothing is scheduled', () => {
    expect(projectSessionCrons([])).toEqual([])
  })

  it('selects the four documented fields and preserves recurring in both directions', () => {
    // `:2216` — `false` for a one-shot whose schedule encodes a single fire
    // time, `true` for a task that re-fires on every match.
    expect(projectSessionCrons([
      { id: 'abcd1234', schedule: '0 9 * * 1-5', recurring: true, prompt: 'check the build' },
      { id: 'efgh5678', schedule: '30 14 3 8 *', recurring: false, prompt: 'ship it' },
    ])).toEqual([
      { id: 'abcd1234', schedule: '0 9 * * 1-5', recurring: true, prompt: 'check the build' },
      { id: 'efgh5678', schedule: '30 14 3 8 *', recurring: false, prompt: 'ship it' },
    ])
  })

  it('caps a long prompt with the same in-string marker', () => {
    const prompt = projectSessionCrons([
      { id: 'abcd1234', schedule: '* * * * *', recurring: true, prompt: 'p'.repeat(1500) },
    ])[0]?.prompt ?? ''
    expect(prompt.length).toBe(HOOK_REGISTRY_TEXT_CAP)
    expect(prompt).toBe(`${'p'.repeat(986)}… [+514 chars]`)
  })
})

describe('hookTaskRegistryInput scoping (hooks.md :2046, :2194)', () => {
  // `:2046` — "Both arrays are scoped to the parent session, not the subagent."
  // A parent still waiting on a sibling monitor and a scheduled cron, and a
  // child whose own registry is empty. Reporting the CHILD's arrays here would
  // tell a SubagentStop hook "nothing is in flight" at the moment the parent is
  // still waiting — confidently wrong, and worse than omitting the field.
  const parentSources = {
    monitors: [{ id: 'process_p', type: 'monitor' as const, status: 'running' as const, description: 'parent watch' }],
    children: [],
    evaluatorKinds: [['task_p', 'workflow'] as const],
    shells: [['process_shell', 'tail -f server.log'] as const],
  }
  const parentPort = {
    backgroundTasks: () => projectBackgroundTasks(parentSources),
    sessionCrons: () => projectSessionCrons([
      { id: 'parentcr', schedule: '0 9 * * 1-5', recurring: true, prompt: 'parent cron' },
    ]),
  }
  const childPort = {
    backgroundTasks: () => projectBackgroundTasks(NO_SOURCES),
    sessionCrons: () => projectSessionCrons([]),
  }

  it("reports the PARENT's arrays, which differ from the subagent's", () => {
    const input = hookTaskRegistryInput(parentPort)

    expect(input.background_tasks?.map(entry => entry.id)).toEqual(['process_p', 'task_p', 'process_shell'])
    expect(input.session_crons?.map(entry => entry.id)).toEqual(['parentcr'])

    // The same fixture through the child's registry is empty in both arrays, so
    // this assertion fails the moment the wiring passes the wrong session.
    const childInput = hookTaskRegistryInput(childPort)
    expect(childInput.background_tasks).toEqual([])
    expect(childInput.session_crons).toEqual([])
    expect(input.background_tasks).not.toEqual(childInput.background_tasks)
    expect(input.session_crons).not.toEqual(childInput.session_crons)
  })

  it('emits both keys as present empty arrays when the parent registry is idle', () => {
    expect(hookTaskRegistryInput(childPort)).toEqual({ background_tasks: [], session_crons: [] })
  })

  it('omits both keys only when the registry is unreachable', () => {
    // `:2194` — "present when the task registry is reachable". No port is the
    // one and only case for a missing key.
    expect(hookTaskRegistryInput(undefined)).toEqual({})
  })
})
