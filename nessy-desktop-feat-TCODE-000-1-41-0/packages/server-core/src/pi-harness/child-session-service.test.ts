import { describe, expect, it } from 'bun:test'
import type { PiChildSessionRecordV1 } from '@nessy-agent/shared/agent/pi-harness/child-session-port'
import type { SessionKey } from '@nessy-agent/shared/sessions/session-key'
import { CHILD_SESSION_AGENT_VIEW_DISABLED_ERROR, CHILD_SESSION_BUDGET_EXHAUSTED_ERROR, ChildSessionService } from './child-session-service'

const parent: SessionKey = { workspaceId: 'w1', sessionId: 'parent' }

describe('ChildSessionService', () => {
  it('persists before runtime publication and restores durable children', async () => {
    const order: string[] = []
    let persisted: unknown
    const service = new ChildSessionService({
      parentSessionKey: parent,
      persist: async state => { order.push('persist'); persisted = structuredClone(state) },
      runtime: {
        start: async record => {
          order.push('start')
          return { childSessionKey: record.childSessionKey, transcriptId: 'transcript-1' }
        },
        resume: async () => ({ status: 'completed' }), steer: async () => {}, stop: async () => {},
      },
      makeId: () => 'child-1',
    })

    const started = await service.start({
      agent: 'worker', task: 'inspect', ownerTaskId: 'task-7', background: true,
      restrictions: { prompt: 'worker', model: 'm1', tools: ['read'], worktreePolicy: 'shared', thinkingLevel: 'off' },
      budgets: { depth: 1, maxDepth: 2, fanout: 2, concurrency: 1, tokenLimit: 100, costLimitUsd: 1, deadlineAt: Date.now() + 5000, ancestry: [] },
    })
    expect(order.slice(0, 2)).toEqual(['persist', 'start'])
    expect(started.agentId).toBe('child-1')
    expect(started.ownerTaskId).toBe('task-7')
    expect(started.agentId).not.toBe(started.ownerTaskId)

    const restored = new ChildSessionService({
      parentSessionKey: parent,
      initialState: persisted,
      persist: async () => {},
      runtime: { start: async () => { throw new Error('unused') }, resume: async () => ({ status: 'completed' }), steer: async () => {}, stop: async () => {} },
    })
    expect(restored.get('child-1')?.transcriptId).toBe('transcript-1')
  })

  it('injects SubagentStart context before runtime start without changing the durable task', async () => {
    const order: string[] = []
    let runtimeTask = ''
    const service = new ChildSessionService({
      parentSessionKey: parent,
      persist: async () => { order.push('persist') },
      beforeStart: async record => {
        order.push(`hook:${record.agentId}`)
        return { additionalContext: 'Honey worker directive' }
      },
      runtime: {
        start: async record => {
          order.push('start')
          runtimeTask = record.task
          return { childSessionKey: record.childSessionKey, transcriptId: 't1', status: 'running' }
        },
        resume: async () => ({ status: 'completed' }), steer: async () => {}, stop: async () => {},
      },
      makeId: () => 'child-1',
    })
    await service.start({
      agent: 'worker', task: 'inspect repository', background: true,
      restrictions: { prompt: 'p', model: 'm', tools: ['read'], worktreePolicy: 'shared', thinkingLevel: 'off' },
      budgets: { depth: 1, maxDepth: 2, fanout: 1, concurrency: 1, tokenLimit: 100, costLimitUsd: 1, deadlineAt: Date.now() + 5_000, ancestry: [] },
    })

    expect(order.slice(0, 3)).toEqual(['persist', 'hook:child-1', 'start'])
    expect(runtimeTask).toBe('Honey worker directive\n\ninspect repository')
    expect(service.get('child-1')?.task).toBe('inspect repository')
  })

  it('does not publish a child runtime stopped while its SubagentStart hook is pending', async () => {
    let enterHook!: () => void
    let releaseHook!: () => void
    const hookEntered = new Promise<void>(resolve => { enterHook = resolve })
    const hookRelease = new Promise<void>(resolve => { releaseHook = resolve })
    let starts = 0
    const service = new ChildSessionService({
      parentSessionKey: parent,
      persist: async () => {},
      beforeStart: async () => {
        enterHook()
        await hookRelease
        return { additionalContext: 'late context' }
      },
      runtime: {
        start: async record => {
          starts += 1
          return { childSessionKey: record.childSessionKey, transcriptId: 'unexpected' }
        },
        resume: async () => ({ status: 'completed' }), steer: async () => {},
        stop: async () => { throw new Error('runtime-not-admitted') },
      },
      makeId: () => 'child-race',
    })

    const starting = service.start({
      agent: 'worker', task: 'inspect repository', background: true,
      restrictions: { prompt: 'p', model: 'm', tools: ['read'], worktreePolicy: 'shared', thinkingLevel: 'off' },
      budgets: { depth: 1, maxDepth: 2, fanout: 1, concurrency: 1, tokenLimit: 100, costLimitUsd: 1, deadlineAt: Date.now() + 5_000, ancestry: [] },
    })
    await hookEntered
    await service.stop('child-race')
    releaseHook()

    expect(await starting).toMatchObject({ agentId: 'child-race', status: 'stopped' })
    expect(starts).toBe(0)
  })

  it('cancels an owner-backed admission before it becomes durable', async () => {
    let ownerLookupEntered!: () => void
    let releaseOwnerLookup!: () => void
    const ownerLookupStarted = new Promise<void>(resolve => { ownerLookupEntered = resolve })
    const ownerLookupGate = new Promise<void>(resolve => { releaseOwnerLookup = resolve })
    let runtimeStarts = 0
    const service = new ChildSessionService({
      parentSessionKey: parent,
      persist: async () => {},
      ensureOwnerTaskId: async () => {
        ownerLookupEntered()
        await ownerLookupGate
      },
      runtime: {
        start: async record => {
          runtimeStarts += 1
          return { childSessionKey: record.childSessionKey, transcriptId: record.agentId, status: 'running' }
        },
        resume: async () => ({ status: 'completed' }), steer: async () => {}, stop: async () => {},
      },
    })
    const starting = service.start({
      requestedAgentId: 'cancelled-admission', ownerTaskId: 'owner', agent: 'worker', task: 'inspect', background: true,
      restrictions: { prompt: 'p', model: 'm', tools: [], worktreePolicy: 'shared', thinkingLevel: 'off' },
      budgets: { depth: 1, maxDepth: 2, fanout: 1, concurrency: 1, tokenLimit: 10, costLimitUsd: 1, deadlineAt: Date.now() + 5_000, ancestry: [] },
    })
    await ownerLookupStarted
    const stopped = service.stop('cancelled-admission')
    const settled = Promise.all([starting, stopped])
    releaseOwnerLookup()

    const [result] = await settled
    expect(result).toMatchObject({ agentId: 'cancelled-admission', status: 'stopped' })
    expect(runtimeStarts).toBe(0)
    expect(service.get('cancelled-admission')).toBeUndefined()
    expect(service.snapshot().children).toEqual([])
  })

  it('routes resume, steer, result and stop by agent_id and rejects cycles/budget overflow', async () => {
    const calls: string[] = []
    const service = new ChildSessionService({
      parentSessionKey: parent,
      persist: async () => {},
      runtime: {
        start: async record => ({ childSessionKey: record.childSessionKey, transcriptId: 't1' }),
        resume: async (_record, input) => { calls.push(`resume:${input}`); return { status: 'running' } },
        steer: async (_record, message) => { calls.push(`steer:${message}`) },
        stop: async () => { calls.push('stop') },
      },
      makeId: () => 'child-1',
    })
    await service.start({
      agent: 'worker', task: 'work', background: false,
      restrictions: { prompt: 'p', model: 'm', tools: [], worktreePolicy: 'shared', thinkingLevel: 'off' },
      budgets: { depth: 1, maxDepth: 2, fanout: 1, concurrency: 1, tokenLimit: 10, costLimitUsd: 1, deadlineAt: Date.now() + 5000, ancestry: [] },
    })
    await expect(service.start({
      agent: 'scout', task: 'parallel', background: false, requestedAgentId: 'child-2',
      restrictions: { prompt: 'p', model: 'm', tools: [], worktreePolicy: 'shared', thinkingLevel: 'off' },
      budgets: { depth: 1, maxDepth: 2, fanout: 2, concurrency: 1, tokenLimit: 10, costLimitUsd: 1, deadlineAt: Date.now() + 5000, ancestry: [] },
    })).rejects.toThrow('child-session-concurrency-limit')
    await service.stop('child-1')
    await service.resume('child-1', 'continue')
    await service.steer('child-1', 'focus')
    expect(service.result('child-1').agentId).toBe('child-1')
    await service.stop('child-1')
    expect(calls).toEqual(['stop', 'resume:continue', 'steer:focus', 'stop'])

    await expect(service.start({
      agent: 'scout', task: 'fanout', background: false, requestedAgentId: 'child-3',
      restrictions: { prompt: 'p', model: 'm', tools: [], worktreePolicy: 'shared', thinkingLevel: 'off' },
      budgets: { depth: 1, maxDepth: 2, fanout: 1, concurrency: 2, tokenLimit: 10, costLimitUsd: 1, deadlineAt: Date.now() + 5000, ancestry: [] },
    })).rejects.toThrow('child-session-fanout-limit')

    await expect(service.start({
      agent: 'worker', task: 'cycle', background: false,
      restrictions: { prompt: 'p', model: 'm', tools: [], worktreePolicy: 'shared', thinkingLevel: 'off' },
      budgets: { depth: 2, maxDepth: 2, fanout: 1, concurrency: 1, tokenLimit: 10, costLimitUsd: 1, deadlineAt: Date.now() + 5000, ancestry: ['child-1'] },
      requestedAgentId: 'child-1',
    })).rejects.toThrow('child-session-cycle')
  })

  it('keeps the host-side depth floor intact independently of the spawner default', async () => {
    // The spawner's nesting-depth default is 1, but the host does not trust it:
    // it rejects depth > maxDepth on its own, so a subprocess that forged a
    // deeper budget is still refused here.
    const service = new ChildSessionService({
      parentSessionKey: parent,
      persist: async () => {},
      runtime: {
        start: async record => ({ childSessionKey: record.childSessionKey, transcriptId: 't', status: 'completed' }),
        resume: async () => ({ status: 'completed' }), steer: async () => {}, stop: async () => {},
      },
      makeId: () => 'child-deep',
    })

    await expect(service.start({
      agent: 'worker', task: 'too deep', background: false,
      restrictions: { prompt: 'p', model: 'm', tools: [], worktreePolicy: 'shared', thinkingLevel: 'off' },
      budgets: { depth: 3, maxDepth: 1, fanout: 1, concurrency: 1, tokenLimit: 10, costLimitUsd: 1, deadlineAt: Date.now() + 5000, ancestry: [] },
    })).rejects.toThrow('child-session-budgets-invalid')
  })

  it('F1.224: a capped child resumes past its maxTurns — the bound is per run, not per start', async () => {
    const resumed: string[] = []
    const service = new ChildSessionService({
      parentSessionKey: parent,
      persist: async () => {},
      runtime: {
        start: async record => ({ childSessionKey: record.childSessionKey, transcriptId: 't', status: 'completed' }),
        resume: async (_record, input) => { resumed.push(input); return { status: 'completed' } },
        steer: async () => {}, stop: async () => {},
      },
      makeId: () => 'child-1',
    })
    await service.start({
      agent: 'worker', task: 'work', background: false,
      // maxTurns: 2 used to admit the start plus exactly ONE resume (a start count).
      restrictions: { prompt: 'p', model: 'm', tools: [], worktreePolicy: 'shared', thinkingLevel: 'off', maxTurns: 2 },
      budgets: { depth: 1, maxDepth: 2, fanout: 1, concurrency: 1, tokenLimit: 10, costLimitUsd: 1, deadlineAt: Date.now() + 5000, ancestry: [] },
    })
    // No run counter is kept: the child's own loop spends `maxTurns` per run (F1.83).
    expect(service.get('child-1')).not.toHaveProperty('turnsUsed')

    // sub-agents.md: a capped child's output is partial "and Claude can resume it to continue".
    await service.resume('child-1', 'continue-1')
    expect(service.get('child-1')).not.toHaveProperty('turnsUsed')

    // The run the old start counter refused (`child-session-max-turns-exceeded`) now runs.
    await service.resume('child-1', 'continue-2')
    expect(resumed).toEqual(['continue-1', 'continue-2'])
    expect(service.get('child-1')?.restrictions.maxTurns).toBe(2)
  })

  it('F1.224: the exact maxTurns:1 boundary — the first resume RUNS (it used to be refused)', async () => {
    const resumed: string[] = []
    const service = new ChildSessionService({
      parentSessionKey: parent,
      persist: async () => {},
      runtime: {
        start: async record => ({ childSessionKey: record.childSessionKey, transcriptId: 't', status: 'completed' }),
        resume: async (_record, input) => { resumed.push(input); return { status: 'completed' } },
        steer: async () => {}, stop: async () => {},
      },
      makeId: () => 'child-1',
    })
    await service.start({
      agent: 'worker', task: 'work', background: false,
      // maxTurns: 1 -> one round trip per RUN, inside the child; the host counts no runs.
      restrictions: { prompt: 'p', model: 'm', tools: [], worktreePolicy: 'shared', thinkingLevel: 'off', maxTurns: 1 },
      budgets: { depth: 1, maxDepth: 2, fanout: 1, concurrency: 1, tokenLimit: 10, costLimitUsd: 1, deadlineAt: Date.now() + 5000, ancestry: [] },
    })
    expect(service.get('child-1')?.status).toBe('completed')
    // The very first resume reaches the runtime and the record says it ran.
    await service.resume('child-1', 'continue')
    expect(resumed).toEqual(['continue'])
    expect(service.get('child-1')?.status).toBe('completed')
  })

  it('leaves resume unbounded and turnsUsed absent when maxTurns is unset (legacy byte-identity)', async () => {
    const service = new ChildSessionService({
      parentSessionKey: parent,
      persist: async () => {},
      runtime: {
        start: async record => ({ childSessionKey: record.childSessionKey, transcriptId: 't', status: 'completed' }),
        resume: async () => ({ status: 'completed' }), steer: async () => {}, stop: async () => {},
      },
      makeId: () => 'child-1',
    })
    await service.start({
      agent: 'worker', task: 'work', background: false,
      restrictions: { prompt: 'p', model: 'm', tools: [], worktreePolicy: 'shared', thinkingLevel: 'off' },
      budgets: { depth: 1, maxDepth: 2, fanout: 1, concurrency: 1, tokenLimit: 10, costLimitUsd: 1, deadlineAt: Date.now() + 5000, ancestry: [] },
    })
    expect(service.get('child-1')).not.toHaveProperty('turnsUsed')
    // Many resumes stay allowed with no counter growth.
    for (let i = 0; i < 5; i += 1) await service.resume('child-1', `r${i}`)
    expect(service.get('child-1')).not.toHaveProperty('turnsUsed')
  })

  it('rolls back failed persistence, rejects reused IDs and returns defensive records', async () => {
    let fail = true
    let starts = 0
    const service = new ChildSessionService({
      parentSessionKey: parent,
      persist: async () => { if (fail) throw new Error('persist-failed') },
      runtime: {
        start: async record => { starts += 1; return { childSessionKey: record.childSessionKey, transcriptId: 't', status: 'running' } },
        resume: async () => ({ status: 'completed' }), steer: async () => {}, stop: async () => {},
      },
      makeId: () => 'child-stable',
    })
    const input = {
      agent: 'worker', task: 'work', ownerTaskId: 'task-owner', backgroundTaskId: 'task-bg', background: true,
      restrictions: { prompt: 'p', model: 'm', tools: ['read'], worktreePolicy: 'shared' as const, thinkingLevel: 'off' as const },
      budgets: { depth: 1, maxDepth: 2, fanout: 1, concurrency: 1, tokenLimit: 10, costLimitUsd: 1, deadlineAt: Date.now() + 5000, ancestry: [] },
    }
    await expect(service.start(input)).rejects.toThrow('persist-failed')
    expect(starts).toBe(0)
    expect(service.get('child-stable')).toBeUndefined()
    fail = false
    await service.start(input)
    const record = service.get('child-stable')!
    // `tools` is optional since P2.301 (absent = inherit); this input authors a
    // list, so the assertion is still about the clone, not about presence.
    record.restrictions.tools!.push('write')
    expect(service.get('child-stable')?.restrictions.tools).toEqual(['read'])
    await expect(service.start(input)).rejects.toThrow('child-session-id-reused')
    await service.stopTask('task-bg')
    expect(service.result('child-stable').status).toBe('stopped')
  })

  it('rejects malformed bounded budgets before persistence', async () => {
    let persists = 0
    const service = new ChildSessionService({
      parentSessionKey: parent,
      persist: async () => { persists += 1 },
      runtime: { start: async () => { throw new Error('unreachable') }, resume: async () => ({ status: 'completed' }), steer: async () => {}, stop: async () => {} },
    })
    for (const budgets of [
      { depth: 0, maxDepth: 2, fanout: 1, concurrency: 1, tokenLimit: 1, costLimitUsd: 1, deadlineAt: 1, ancestry: [] },
      { depth: 3, maxDepth: 2, fanout: 1, concurrency: 1, tokenLimit: 1, costLimitUsd: 1, deadlineAt: Date.now() + 1_000, ancestry: [] },
      { depth: 1, maxDepth: 2, fanout: 1, concurrency: 1, tokenLimit: 1, costLimitUsd: 1, deadlineAt: Date.now() + 1_000, ancestry: ['worker'] },
      { depth: 1, maxDepth: 2, fanout: 1, concurrency: 1, tokenLimit: 1, costLimitUsd: -1, deadlineAt: 1, ancestry: [] },
      { depth: 1, maxDepth: 2, fanout: 1, concurrency: 1, tokenLimit: 1, costLimitUsd: 1, deadlineAt: 0, ancestry: [] },
    ]) {
      await expect(service.start({ agent: 'worker', task: 'x', background: false, restrictions: { prompt: 'p', model: 'm', tools: [], worktreePolicy: 'shared', thinkingLevel: 'off' }, budgets }))
        .rejects.toThrow('child-session-budgets-invalid')
    }
    expect(persists).toBe(0)
  })

  it('atomically reserves distinct background IDs and keeps terminal lifecycle monotonic', async () => {
    let releaseStart!: () => void
    const startGate = new Promise<void>(resolve => { releaseStart = resolve })
    const events: string[] = []
    let stops = 0
    const service = new ChildSessionService({
      parentSessionKey: parent,
      persist: async () => {},
      runtime: {
        start: async record => { await startGate; return { childSessionKey: record.childSessionKey, transcriptId: record.agentId } },
        resume: async record => {
          expect(service.get(record.agentId)?.status).toBe('running')
          return { status: 'completed', output: 'resumed' }
        },
        steer: async () => {},
        stop: async () => { stops += 1 },
      },
      emit: async event => { events.push(event) },
    })
    const input = (agentId: string, backgroundTaskId: string) => ({
      requestedAgentId: agentId, backgroundTaskId, ownerTaskId: 'dag-1',
      agent: 'worker', task: 'work', background: true,
      restrictions: { prompt: 'p', model: 'm', tools: [], worktreePolicy: 'shared' as const, thinkingLevel: 'high' as const },
      budgets: { depth: 1, maxDepth: 2, fanout: 2, concurrency: 1, tokenLimit: 10, costLimitUsd: 1, deadlineAt: Date.now() + 5_000, ancestry: [] },
    })
    const first = service.start(input('agent-1', 'bg-1') as any)
    const second = service.start(input('agent-2', 'bg-2') as any)
    releaseStart()
    await expect(second).rejects.toThrow('child-session-concurrency-limit')
    const started = await first
    expect(started).toMatchObject({ agentId: 'agent-1', backgroundTaskId: 'bg-1', ownerTaskId: 'dag-1' })
    await expect(service.stopTask('dag-1')).rejects.toThrow('unknown-task-id:dag-1')
    await service.stopTask('bg-1')
    await service.stop('agent-1')
    expect(stops).toBe(1)
    expect(events.filter(event => event === 'SubagentStop')).toHaveLength(1)
    await service.resume('agent-1', 'again')
    await expect(service.steer('agent-1', 'late')).rejects.toThrow('child-session-not-active')
  })

  it('persists runtime failures, ignores observer failures and bounds usage/output projections', async () => {
    const events: string[] = []
    let failRuntime = true
    const service = new ChildSessionService({
      parentSessionKey: parent,
      persist: async () => {},
      runtime: {
        start: async record => {
          if (failRuntime) throw new Error('runtime-start-failed')
          return {
            childSessionKey: record.childSessionKey,
            transcriptId: record.agentId,
            status: 'completed',
            output: `${'x'.repeat(80_000)}\nneedle\n${'needle\n'.repeat(200)}`,
            result: 'r'.repeat(80_000),
            inputTokens: 11,
            outputTokens: 7,
            costUsd: 0.25,
          } as any
        },
        resume: async () => ({ status: 'completed' }), steer: async () => {}, stop: async () => {},
      },
      emit: async event => { events.push(event); if (event === 'SubagentStart') throw new Error('observer-failed') },
    })
    const base = {
      agent: 'worker', task: 'work', background: false,
      restrictions: { prompt: 'p', model: 'm', tools: [], worktreePolicy: 'shared' as const, thinkingLevel: 'off' as const },
      budgets: { depth: 1, maxDepth: 2, fanout: 3, concurrency: 1, tokenLimit: 100, costLimitUsd: 1, deadlineAt: Date.now() + 5_000, ancestry: [] },
    }
    await expect(service.start({ ...base, requestedAgentId: 'failed' } as any)).rejects.toThrow('runtime-start-failed')
    expect(service.get('failed')).toMatchObject({ status: 'failed', error: 'runtime-start-failed', terminalEventEmitted: true })
    expect(events).toContain('SubagentStop')
    failRuntime = false
    const result = await service.start({ ...base, requestedAgentId: 'ok' } as any)
    expect(result).toMatchObject({ status: 'completed', inputTokens: 11, outputTokens: 7, costUsd: 0.25 })
    expect(Buffer.byteLength(result.output, 'utf8')).toBeLessThanOrEqual(65_536)
    expect((await service.getResult('ok', { verbose: true } as any)).agentId).toBe('ok')
    const search = service.searchOutput('ok', 'needle')
    expect(search.agentId).toBe('ok')
    expect(search.results).toHaveLength(100)
    const attachment = await service.attach('ok')
    expect(attachment.agentId).toBe('ok')
    expect(Buffer.byteLength(attachment.output, 'utf8')).toBeLessThanOrEqual(65_536)
  })

  /**
   * P2.393 — a child result the parent MODEL reads was cut with no signal.
   *
   * `get_subagent_result` puts `result.result ?? result.output` straight into
   * the text it hands the parent model, and `boundUtf8` truncated it silently at
   * 16 KiB (64 KiB with `verbose`). A model cannot tell truncation from
   * completion, which is the same defect `config/bash-output-limits.ts` was
   * opened for, on a second model-facing path. The marker names both byte counts
   * and, at the default tier, the flag that buys more.
   */
  it('announces a truncated child result, and names the verbose tier that buys more', async () => {
    const long = 'z'.repeat(70_000)
    const service = new ChildSessionService({
      parentSessionKey: parent,
      persist: async () => {},
      runtime: {
        start: async record => ({ childSessionKey: record.childSessionKey, transcriptId: record.agentId, status: 'completed', result: long }),
        resume: async () => ({ status: 'completed' }), steer: async () => {}, stop: async () => {},
      },
    })
    await service.start({
      requestedAgentId: 'chatty', agent: 'worker', task: 'talk', background: true,
      restrictions: { prompt: 'p', model: 'm', tools: [], worktreePolicy: 'shared', thinkingLevel: 'off' },
      budgets: { depth: 1, maxDepth: 2, fanout: 1, concurrency: 1, tokenLimit: 10, costLimitUsd: 1, deadlineAt: Date.now() + 5_000, ancestry: [] },
    })

    const quiet = await service.getResult('chatty')
    expect(quiet.result).toContain(
      '[truncated to fit 16384 bytes; 70000 bytes total; ask again with verbose: true for up to 65536 bytes]',
    )
    // The marker is RESERVED OUT OF the cap, not added to it: the field still
    // satisfies the byte bound its sibling rows assert.
    expect(Buffer.byteLength(quiet.result ?? '', 'utf8')).toBeLessThanOrEqual(16_384)

    const verbose = await service.getResult('chatty', { verbose: true })
    // The top tier offers nothing that does not exist: there is no wider tier,
    // so no advice is given.
    expect(verbose.result).toContain('[truncated to fit 65536 bytes; 70000 bytes total]')
    expect(verbose.result).not.toContain('verbose: true')
    expect(Buffer.byteLength(verbose.result ?? '', 'utf8')).toBeLessThanOrEqual(65_536)
    expect((verbose.result ?? '').length).toBeGreaterThan((quiet.result ?? '').length)

    // BOUNDED ONCE: both markers name 70000, the TRUE original. Bounding a
    // bounded value made the narrow tier report the wide tier's length as the
    // original — a marker that lies about how much is missing.
    expect(quiet.result).toContain('70000 bytes total')
    expect(verbose.result).toContain('70000 bytes total')

    // THE CONTROL: a payload that fits is returned byte-for-byte, so the marker
    // cannot be an unconditional suffix, and the kept head is really the head.
    expect(quiet.result?.startsWith('zzzz')).toBe(true)
    expect(quiet.status).toBe('completed')
    expect(quiet.agentId).toBe('chatty')
  })

  it('waits through the runtime monitor and coalesces concurrent terminal observers', async () => {
    let monitors = 0
    const events: string[] = []
    const service = new ChildSessionService({
      parentSessionKey: parent,
      persist: async () => {},
      runtime: {
        start: async record => ({ childSessionKey: record.childSessionKey, transcriptId: record.agentId, status: 'running' }),
        resume: async () => ({ status: 'completed' }), steer: async () => {}, stop: async () => {},
        monitor: async () => { monitors += 1; return { status: 'completed', result: 'done', inputTokens: 2, outputTokens: 3, costUsd: 0.1 } },
      },
      emit: async event => { events.push(event) },
    })
    await service.start({
      requestedAgentId: 'waited', agent: 'worker', task: 'wait', background: true,
      restrictions: { prompt: 'p', model: 'm', tools: [], worktreePolicy: 'shared', thinkingLevel: 'off' },
      budgets: { depth: 1, maxDepth: 2, fanout: 1, concurrency: 1, tokenLimit: 10, costLimitUsd: 1, deadlineAt: Date.now() + 5_000, ancestry: [] },
    })
    const [first, second] = await Promise.all([
      service.getResult('waited', { wait: true }),
      service.monitor('waited'),
    ])
    expect([first.status, second.status]).toEqual(['completed', 'completed'])
    expect(monitors).toBeGreaterThanOrEqual(1)
    expect(events.filter(event => event === 'SubagentStop')).toHaveLength(1)
  })

  it('atomically admits one resume and coalesces concurrent stops', async () => {
    let resumeCalls = 0
    let stopCalls = 0
    let releaseResume!: () => void
    let releaseStop!: () => void
    const resumeGate = new Promise<void>(resolve => { releaseResume = resolve })
    const stopGate = new Promise<void>(resolve => { releaseStop = resolve })
    const service = new ChildSessionService({
      parentSessionKey: parent, persist: async () => {},
      runtime: {
        start: async record => ({ childSessionKey: record.childSessionKey, transcriptId: record.agentId, status: 'completed' }),
        resume: async () => { resumeCalls += 1; await resumeGate; return { status: 'running' } },
        steer: async () => {},
        stop: async () => { stopCalls += 1; await stopGate },
      },
    })
    const input = {
      requestedAgentId: 'atomic', agent: 'worker', task: 'work', background: true,
      restrictions: { prompt: 'p', model: 'm', tools: [], worktreePolicy: 'shared' as const, thinkingLevel: 'off' as const },
      budgets: { depth: 1, maxDepth: 2, fanout: 1, concurrency: 1, tokenLimit: 10, costLimitUsd: 1, deadlineAt: Date.now() + 5_000, ancestry: [] },
    }
    await service.start(input)
    const firstResume = service.resume('atomic', 'one')
    const secondResume = service.resume('atomic', 'two')
    await Promise.resolve()
    const firstStop = service.stop('atomic')
    const secondStop = service.stop('atomic')
    await Promise.resolve()
    releaseStop()
    await Promise.all([firstStop, secondStop])
    releaseResume()
    await firstResume
    await expect(secondResume).rejects.toThrow('child-session-already-active')
    expect(service.result('atomic').status).toBe('stopped')
    expect(resumeCalls).toBe(1)
    expect(stopCalls).toBe(1)
  })

  it('preserves a concurrent terminal state when start or resume fails', async () => {
    let rejectStart!: (error: Error) => void
    let rejectResume!: (error: Error) => void
    let markStartEntered!: () => void
    let markResumeEntered!: () => void
    const startGate = new Promise<never>((_resolve, reject) => { rejectStart = reject })
    const resumeGate = new Promise<never>((_resolve, reject) => { rejectResume = reject })
    const startEntered = new Promise<void>(resolve => { markStartEntered = resolve })
    const resumeEntered = new Promise<void>(resolve => { markResumeEntered = resolve })
    let starting = true
    const service = new ChildSessionService({
      parentSessionKey: parent, persist: async () => {},
      runtime: {
        start: async record => {
          if (!starting) return { childSessionKey: record.childSessionKey, transcriptId: record.agentId, status: 'completed' }
          markStartEntered()
          return await startGate
        },
        resume: async () => { markResumeEntered(); return await resumeGate },
        steer: async () => {}, stop: async () => {},
      },
    })
    const input = (id: string) => ({
      requestedAgentId: id, agent: 'worker', task: 'work', background: true,
      restrictions: { prompt: 'p', model: 'm', tools: [], worktreePolicy: 'shared' as const, thinkingLevel: 'off' as const },
      budgets: { depth: 1, maxDepth: 2, fanout: 2, concurrency: 2, tokenLimit: 10, costLimitUsd: 1, deadlineAt: Date.now() + 5_000, ancestry: [] },
    })
    const start = service.start(input('starting'))
    await startEntered
    await service.stop('starting')
    rejectStart(new Error('late-start-failure'))
    await expect(start).rejects.toThrow('late-start-failure')
    expect(service.result('starting').status).toBe('stopped')

    starting = false
    await service.start(input('resuming'))
    const resume = service.resume('resuming', 'again')
    await resumeEntered
    await service.stop('resuming')
    rejectResume(new Error('late-resume-failure'))
    await expect(resume).rejects.toThrow('late-resume-failure')
    expect(service.result('resuming').status).toBe('stopped')
  })

  it('coalesces sibling owner completion and retries after an observer failure', async () => {
    let completeCalls = 0
    let failCompletion = true
    const service = new ChildSessionService({
      parentSessionKey: parent, persist: async () => {}, ensureOwnerTaskId: async () => {}, validateOwnerTaskId: () => {},
      completeOwnerTaskId: async () => { completeCalls += 1; if (failCompletion) throw new Error('task-complete-failed') },
      runtime: {
        start: async record => ({ childSessionKey: record.childSessionKey, transcriptId: record.agentId, status: 'running' }),
        resume: async () => ({ status: 'completed' }), steer: async () => {}, stop: async () => {},
        monitor: async () => ({ status: 'completed' }),
      },
    })
    const input = (id: string) => ({
      requestedAgentId: id, ownerTaskId: 'owner', agent: 'worker', task: id, background: true,
      restrictions: { prompt: 'p', model: 'm', tools: [], worktreePolicy: 'shared' as const, thinkingLevel: 'off' as const },
      budgets: { depth: 1, maxDepth: 2, fanout: 2, concurrency: 2, tokenLimit: 10, costLimitUsd: 1, deadlineAt: Date.now() + 5_000, ancestry: [] },
    })
    await Promise.all([service.start(input('one')), service.start(input('two'))])
    await service.sealOwnerTask('owner')
    await expect(Promise.all([service.monitor('one'), service.monitor('two')])).rejects.toThrow('task-complete-failed')
    expect(service.result('one').status).toBe('completed')
    expect(service.result('two').status).toBe('completed')
    expect(completeCalls).toBe(1)
    failCompletion = false
    await service.getResult('one', { wait: true })
    expect(completeCalls).toBe(2)
    expect(service.snapshot().children.every(child => child.ownerTaskCompletionEmitted)).toBe(true)
  })

  it('completes a sealed owner only after every admitted child is terminal', async () => {
    let completeCalls = 0
    const events: string[] = []
    const service = new ChildSessionService({
      parentSessionKey: parent, persist: async () => {}, ensureOwnerTaskId: async () => {}, validateOwnerTaskId: () => {},
      completeOwnerTaskId: async () => { completeCalls += 1 },
      emit: async event => { events.push(event) },
      runtime: {
        start: async record => ({ childSessionKey: record.childSessionKey, transcriptId: record.agentId, status: record.agentId === 'first' ? 'completed' : 'running' }),
        resume: async () => ({ status: 'completed' }), steer: async () => {}, stop: async () => {},
        monitor: async () => ({ status: 'completed' }),
      },
    })
    const input = (requestedAgentId: string) => ({
      requestedAgentId, ownerTaskId: 'owner-sealed', agent: 'worker', task: requestedAgentId, background: true,
      restrictions: { prompt: 'p', model: 'm', tools: [], worktreePolicy: 'shared' as const, thinkingLevel: 'off' as const },
      budgets: { depth: 1, maxDepth: 2, fanout: 3, concurrency: 2, tokenLimit: 10, costLimitUsd: 1, deadlineAt: Date.now() + 5_000, ancestry: [] },
    })
    await service.start(input('first'))
    expect(completeCalls).toBe(0)
    await service.start(input('second'))
    await (service as any).sealOwnerTask('owner-sealed')
    expect(completeCalls).toBe(0)
    await expect(service.start(input('late'))).rejects.toThrow('child-session-owner-sealed')
    await service.monitor('second')
    expect(completeCalls).toBe(1)
    await (service as any).sealOwnerTask('owner-sealed')
    expect(completeCalls).toBe(1)
    await service.resume('second', 'again')
    expect(completeCalls).toBe(1)
    expect(events.filter(event => event === 'SubagentStop')).toHaveLength(3)
  })

  it('drains pending starts and rejects later admissions after settlement', async () => {
    let enterHook!: () => void
    let releaseHook!: () => void
    const hookEntered = new Promise<void>(resolve => { enterHook = resolve })
    const hookRelease = new Promise<void>(resolve => { releaseHook = resolve })
    let runtimeStarts = 0
    const service = new ChildSessionService({
      parentSessionKey: parent,
      persist: async () => {},
      beforeStart: async () => {
        enterHook()
        await hookRelease
      },
      runtime: {
        start: async record => {
          runtimeStarts += 1
          return { childSessionKey: record.childSessionKey, transcriptId: record.agentId, status: 'running' }
        },
        resume: async () => ({ status: 'completed' }),
        steer: async () => {},
        stop: async () => {},
      },
      makeId: () => 'draining-child',
    })
    const input = {
      agent: 'worker', task: 'inspect', background: true,
      restrictions: { prompt: 'p', model: 'm', tools: [], worktreePolicy: 'shared' as const, thinkingLevel: 'off' as const },
      budgets: { depth: 1, maxDepth: 2, fanout: 1, concurrency: 1, tokenLimit: 10, costLimitUsd: 1, deadlineAt: Date.now() + 5_000, ancestry: [] },
    }

    const starting = service.start(input)
    await hookEntered
    const draining = service.drain()
    releaseHook()

    await expect(starting).resolves.toMatchObject({ status: 'stopped' })
    await expect(draining).resolves.toBeUndefined()
    expect(runtimeStarts).toBeLessThanOrEqual(1)
    expect(service.snapshot().children.every(child => child.status !== 'starting' && child.status !== 'running')).toBe(true)
    await expect(service.start(input)).rejects.toThrow('child-session-service-draining')
  })

  it('retains active child ownership when strict drain fails', async () => {
    const service = new ChildSessionService({
      parentSessionKey: parent,
      persist: async () => {},
      runtime: {
        start: async record => ({ childSessionKey: record.childSessionKey, transcriptId: record.agentId, status: 'running' }),
        resume: async () => ({ status: 'completed' }),
        steer: async () => {},
        stop: async () => { throw new Error('child-stop-failed') },
      },
      makeId: () => 'owned-child',
    })
    await service.start({
      agent: 'worker', task: 'inspect', background: true,
      restrictions: { prompt: 'p', model: 'm', tools: [], worktreePolicy: 'shared', thinkingLevel: 'off' },
      budgets: { depth: 1, maxDepth: 2, fanout: 1, concurrency: 1, tokenLimit: 10, costLimitUsd: 1, deadlineAt: Date.now() + 5_000, ancestry: [] },
    })

    await expect(service.drain()).rejects.toThrow('child-session-drain-failed')
    expect(service.get('owned-child')?.status).toBe('running')
  })

  /**
   * L1. `sub-agents.md:1019` — a fork "runs in the background while you keep
   * working". A background child's `start` resolves the instant it is spawned, so
   * `record.output` stays `''` for the whole time it works, and `attach` served
   * nothing: measured live on 2026-07-30, `read_child` returned 0 characters on
   * every poll while the child's own session already held four assistant messages.
   */
  it('serves a working child its live output, and a settled one its record', async () => {
    let live = ''
    let liveReads = 0
    const service = new ChildSessionService({
      parentSessionKey: parent,
      persist: async () => {},
      runtime: {
        // Exactly the background shape: running, no output, nothing else to come
        // until the child settles.
        start: async record => ({ childSessionKey: record.childSessionKey, transcriptId: record.agentId, status: 'running' }),
        resume: async () => ({ status: 'completed' }),
        steer: async () => {},
        stop: async () => {},
        readLiveOutput: async () => { liveReads += 1; return live },
      },
      makeId: () => 'watched',
    })
    await service.start({
      agent: 'fork', task: 'write at length', background: true,
      restrictions: { prompt: 'p', model: 'm', tools: [], worktreePolicy: 'shared', thinkingLevel: 'off' },
      budgets: { depth: 1, maxDepth: 2, fanout: 1, concurrency: 1, tokenLimit: 10, costLimitUsd: 1, deadlineAt: Date.now() + 5_000, ancestry: [] },
    })
    expect(service.get('watched')?.output).toBe('')

    // Nothing yet: a live read that has nothing to say still answers the record.
    expect((await service.attach('watched')).output).toBe('')
    live = 'first half'
    const partial = await service.attach('watched')
    expect(partial).toMatchObject({ output: 'first half', status: 'running' })
    // And the cursor follows it, so a watching pane appends rather than repeats.
    live = 'first half and the rest'
    expect((await service.attach('watched', partial.cursor)).output).toBe(' and the rest')

    // Terminal is unchanged: the record is served and the live seam is not asked.
    await service.stop('watched')
    const before = liveReads
    const settled = await service.attach('watched')
    expect(liveReads).toBe(before)
    expect(settled.output).toBe(service.get('watched')?.output ?? '<missing record>')
  })

  // R48 — the WebSearch tree count crosses the service in both directions:
  // the start input's used count seeds the record the runtime starts with, and
  // the runtime's consumed count comes back on the result (and survives on the
  // persisted record for later get_result reads).
  it('threads the WebSearch seed to the runtime and the consumption back on the result', async () => {
    let seedSeenByRuntime: number | undefined
    const service = new ChildSessionService({
      parentSessionKey: parent,
      persist: async () => {},
      runtime: {
        start: async record => {
          seedSeenByRuntime = record.webSearchesUsed
          return { childSessionKey: record.childSessionKey, transcriptId: 't1', status: 'completed', output: 'done', webSearchesConsumed: 3 }
        },
        resume: async () => ({ status: 'completed', webSearchesConsumed: 5 }),
        steer: async () => {}, stop: async () => {},
      },
      makeId: () => 'child-searches',
    })

    const started = await service.start({
      agent: 'worker', task: 'research', background: false,
      restrictions: { prompt: 'p', model: 'm', tools: ['read'], worktreePolicy: 'shared', thinkingLevel: 'off' },
      budgets: { depth: 1, maxDepth: 2, fanout: 1, concurrency: 1, tokenLimit: 100, costLimitUsd: 1, deadlineAt: Date.now() + 5_000, ancestry: [] },
      webSearchesUsed: 12,
    })
    expect(seedSeenByRuntime).toBe(12)
    expect(started.webSearchesConsumed).toBe(3)
    expect(service.get('child-searches')?.webSearchesUsed).toBe(12)
    expect(service.get('child-searches')?.webSearchesConsumed).toBe(3)
    expect(service.result('child-searches').webSearchesConsumed).toBe(3)

    // A resume's terminal report replaces the cumulative count on the record.
    const resumed = await service.resume('child-searches', 'keep going')
    expect(resumed.webSearchesConsumed).toBe(5)
  })

  it('drops a malformed WebSearch seed and omits the fields for legacy callers', async () => {
    let runtimeRecord: PiChildSessionRecordV1 | undefined
    const service = new ChildSessionService({
      parentSessionKey: parent,
      persist: async () => {},
      runtime: {
        start: async record => {
          runtimeRecord = record
          return { childSessionKey: record.childSessionKey, transcriptId: 't1', status: 'completed', output: 'done' }
        },
        resume: async () => ({ status: 'completed' }), steer: async () => {}, stop: async () => {},
      },
      makeId: () => 'child-legacy',
    })

    const result = await service.start({
      agent: 'worker', task: 'research', background: false,
      restrictions: { prompt: 'p', model: 'm', tools: ['read'], worktreePolicy: 'shared', thinkingLevel: 'off' },
      budgets: { depth: 1, maxDepth: 2, fanout: 1, concurrency: 1, tokenLimit: 100, costLimitUsd: 1, deadlineAt: Date.now() + 5_000, ancestry: [] },
      webSearchesUsed: Number.NaN,
    })
    expect(runtimeRecord && 'webSearchesUsed' in runtimeRecord).toBe(false)
    expect('webSearchesConsumed' in result).toBe(false)
    expect(service.get('child-legacy') && 'webSearchesConsumed' in service.get('child-legacy')!).toBe(false)
  })
})

/**
 * P2.5 — the `--max-budget-usd` ceiling reaches SUBAGENTS, not only the parent
 * turn.
 *
 * The cap's producer is the backend chat loop (`pi-agent.ts` /
 * `base-agent.ts`), which ends the parent's turn with
 * `terminalReason: 'max_budget_usd'` and aborts the parent's own session. That
 * abort reaches nothing below it: a background child is a separate managed
 * session with its own agent, so at the cap new children still started and
 * running ones still burned. `budgetExhausted` is how the session's verdict
 * arrives here, and `stopActive` is how the running children leave.
 */
describe('ChildSessionService — the session USD cap', () => {
  const restrictions = { prompt: 'p', model: 'm', tools: ['read'], worktreePolicy: 'shared' as const, thinkingLevel: 'off' as const }
  const budgets = () => ({ depth: 1, maxDepth: 2, fanout: 4, concurrency: 4, tokenLimit: 100, costLimitUsd: 1, deadlineAt: Date.now() + 5_000, ancestry: [] })

  function cappedService(exhausted: () => boolean, makeId = () => 'child-capped') {
    const runtimeStarts: string[] = []
    const service = new ChildSessionService({
      parentSessionKey: parent,
      persist: async () => {},
      budgetExhausted: exhausted,
      runtime: {
        start: async record => {
          runtimeStarts.push(record.agentId)
          return { childSessionKey: record.childSessionKey, transcriptId: 't1', status: 'running' as const }
        },
        resume: async () => ({ status: 'completed' as const }), steer: async () => {}, stop: async () => {},
      },
      makeId,
    })
    return { service, runtimeStarts }
  }

  // Table-driven: the SAME start, refused or admitted by the cap alone.
  for (const row of [
    { name: 'refuses a new child once the cap is reached', exhausted: true },
    { name: 'admits a new child while the cap has headroom', exhausted: false },
  ]) {
    it(row.name, async () => {
      const { service, runtimeStarts } = cappedService(() => row.exhausted)
      const start = service.start({ agent: 'worker', task: 'inspect', background: true, restrictions, budgets: budgets() })
      if (row.exhausted) {
        await expect(start).rejects.toThrow(CHILD_SESSION_BUDGET_EXHAUSTED_ERROR)
        // Not a silent no-op: nothing was admitted, nothing was published.
        expect(runtimeStarts).toEqual([])
        expect(service.snapshot().children).toEqual([])
      } else {
        await start
        expect(runtimeStarts).toEqual(['child-capped'])
        expect(service.get('child-capped')?.status).toBe('running')
      }
    })
  }

  it('refuses a resume once the cap is reached', async () => {
    // A resume spends exactly like a spawn does, so the same ceiling binds it.
    let exhausted = false
    const { service } = cappedService(() => exhausted, () => 'child-resume')
    await service.start({ agent: 'worker', task: 'inspect', background: false, restrictions, budgets: budgets() })
    await service.stop('child-resume')
    exhausted = true
    await expect(service.resume('child-resume', 'keep going')).rejects.toThrow(CHILD_SESSION_BUDGET_EXHAUSTED_ERROR)
  })

  it('stops every running child through the existing stop path and leaves settled ones alone', async () => {
    const stopped: string[] = []
    const observed: Array<{ event: string; agentId: string }> = []
    let nextId = 0
    const service = new ChildSessionService({
      parentSessionKey: parent,
      persist: async () => {},
      emit: async (event, record) => { observed.push({ event, agentId: record.agentId }) },
      runtime: {
        start: async record => ({
          childSessionKey: record.childSessionKey,
          transcriptId: 't1',
          status: record.task === 'settle' ? ('completed' as const) : ('running' as const),
          ...(record.task === 'settle' ? { output: 'done', result: 'done' } : {}),
        }),
        resume: async () => ({ status: 'completed' as const }),
        steer: async () => {},
        stop: async record => { stopped.push(record.agentId) },
      },
      makeId: () => `child-${(nextId += 1)}`,
    })

    await service.start({ agent: 'worker', task: 'run', background: true, restrictions, budgets: budgets() })
    await service.start({ agent: 'worker', task: 'settle', background: true, restrictions, budgets: budgets() })
    await service.start({ agent: 'worker', task: 'run', background: false, restrictions, budgets: budgets() })

    const outcome = await service.stopActive()
    expect(outcome).toEqual({ stopped: ['child-1', 'child-3'], failed: [], residual: [] })
    // The EXISTING stop path: the runtime's own `stop`, the `stopped` status it
    // already writes, and one SubagentStop apiece — no new terminal kind.
    expect(stopped).toEqual(['child-1', 'child-3'])
    expect(service.get('child-1')?.status).toBe('stopped')
    expect(service.get('child-3')?.status).toBe('stopped')
    expect(service.get('child-2')?.status).toBe('completed')
    expect(observed.filter(entry => entry.event === 'SubagentStop').map(entry => entry.agentId).sort())
      .toEqual(['child-1', 'child-2', 'child-3'])

    // Idempotent: a second sweep has nothing left to stop, and nothing residual
    // either — an empty third bucket is the caller's proof that "stopped 2"
    // means the fleet really is down.
    expect(await service.stopActive()).toEqual({ stopped: [], failed: [], residual: [] })
    expect(stopped).toEqual(['child-1', 'child-3'])
  })

  it('stops a child that is admitted after the first sweep read the list', async () => {
    // The one child that would otherwise keep burning: a start already past the
    // budget gate but not yet committed when the cap trips. `drain` makes a
    // second pass for exactly this shape, and so does this.
    let releaseOwner!: () => void
    let ownerEntered!: () => void
    const entered = new Promise<void>(resolve => { ownerEntered = resolve })
    const gate = new Promise<void>(resolve => { releaseOwner = resolve })
    const stopped: string[] = []
    const service = new ChildSessionService({
      parentSessionKey: parent,
      persist: async () => {},
      ensureOwnerTaskId: async () => { ownerEntered(); await gate },
      runtime: {
        start: async record => ({ childSessionKey: record.childSessionKey, transcriptId: 't1', status: 'running' as const }),
        resume: async () => ({ status: 'completed' as const }),
        steer: async () => {},
        stop: async record => { stopped.push(record.agentId) },
      },
      makeId: () => 'child-late',
    })

    const started = service.start({ agent: 'worker', task: 'run', background: true, ownerTaskId: 'task-1', restrictions, budgets: budgets() })
    await entered
    // Nothing is committed yet, so the first sweep sees an empty list.
    const sweeping = service.stopActive()
    releaseOwner()
    await started
    expect(await sweeping).toEqual({ stopped: ['child-late'], failed: [], residual: [] })
    expect(stopped).toEqual(['child-late'])
    expect(service.get('child-late')?.status).toBe('stopped')
  })

  it('reports a child left running by the sweep as residual, not as stopped', async () => {
    // The bucket the two-bucket shape had no room for. `stopped` and `failed`
    // report what the stop CALLS returned; this asserts the third bucket is read
    // from the state the children are actually IN, so a stop that returned
    // without taking the child down is reported as still running rather than
    // counted as a success. `drain` reaches the same verdict by a different
    // route — `child-session-residual:<id>:running`.
    //
    // The seam is doubled at `stop`, because the real shapes that produce a
    // residual (a child re-admitted behind the sweep, a child published after
    // both passes read the list) are races the service is deliberately hard to
    // lose: the second pass awaits `startsInFlight`, which catches every one of
    // them. So the CONDITION is staged directly instead of raced into being.
    const service = new ChildSessionService({
      parentSessionKey: parent,
      persist: async () => {},
      runtime: {
        start: async record => ({ childSessionKey: record.childSessionKey, transcriptId: 't1', status: 'running' as const }),
        resume: async () => ({ status: 'completed' as const }),
        steer: async () => {},
        stop: async () => {},
      },
      makeId: () => 'child-unreached',
    })
    await service.start({ agent: 'worker', task: 'run', background: true, restrictions, budgets: budgets() })
    // A stop that reports success and changes nothing.
    ;(service as unknown as { stop(agentId: string): Promise<void> }).stop = async () => {}

    const outcome = await service.stopActive()
    expect(outcome.stopped).toEqual([])
    expect(outcome.failed).toEqual([])
    expect(outcome.residual).toEqual(['child-unreached'])
    expect(service.get('child-unreached')?.status).toBe('running')
  })

  it('reports a child whose stop failed instead of dropping it', async () => {
    const service = new ChildSessionService({
      parentSessionKey: parent,
      persist: async () => {},
      runtime: {
        start: async record => ({ childSessionKey: record.childSessionKey, transcriptId: 't1', status: 'running' as const }),
        resume: async () => ({ status: 'completed' as const }),
        steer: async () => {},
        stop: async () => { throw new Error('runtime-stop-failed') },
      },
      makeId: () => 'child-stubborn',
    })
    await service.start({ agent: 'worker', task: 'run', background: true, restrictions, budgets: budgets() })
    // A REFUSED stop stays in `failed` even though the child is still running:
    // that bucket's sentence already says "may still be running", and moving it
    // to `residual` would lose the fact that the service tried and was told no.
    expect(await service.stopActive()).toEqual({ stopped: [], failed: ['child-stubborn'], residual: [] })
  })
})

/**
 * P6.237 — the operator's OFF SWITCH for background agents.
 *
 * `admin-setup.md#decide-what-to-enforce`; the managed key is `disableAgentView`,
 * which is also the claude SDK's own spelling. Enforced HERE because `start()` is
 * the single admission point every background surface reaches — the background
 * CLI surface, the flag, the slash command and the on-demand supervisor — so one
 * `if` binds Pi, claude and codex identically.
 *
 * Driven through `disabledByPolicy`, the seam, rather than through the
 * process-scoped managed floor: a test that wrote the global would leak into
 * every later file in the runner.
 */
describe('ChildSessionService — the managed disableAgentView switch', () => {
  const restrictions = { prompt: 'p', model: 'm', tools: ['read'], worktreePolicy: 'shared' as const, thinkingLevel: 'off' as const }
  const budgets = () => ({ depth: 1, maxDepth: 2, fanout: 4, concurrency: 4, tokenLimit: 100, costLimitUsd: 1, deadlineAt: Date.now() + 5_000, ancestry: [] })

  function policedService(disabled: boolean) {
    const runtimeStarts: string[] = []
    const service = new ChildSessionService({
      parentSessionKey: parent,
      persist: async () => {},
      disabledByPolicy: () => disabled,
      runtime: {
        start: async record => {
          runtimeStarts.push(record.agentId)
          return { childSessionKey: record.childSessionKey, transcriptId: 't1', status: 'running' as const }
        },
        resume: async () => ({ status: 'completed' as const }), steer: async () => {}, stop: async () => {},
      },
      makeId: () => 'child-policed',
    })
    return { service, runtimeStarts }
  }

  it('refuses a background child by name, admitting nothing', async () => {
    const { service, runtimeStarts } = policedService(true)
    await expect(service.start({
      agent: 'worker', task: 'inspect', background: true, restrictions, budgets: budgets(),
    })).rejects.toThrow(CHILD_SESSION_AGENT_VIEW_DISABLED_ERROR)
    // Refused BEFORE admission and before the durable record, like the cap: a
    // silent no-op, or a half-created child a sweep has to reconcile, are both
    // the failure this row exists to close.
    expect(runtimeStarts).toEqual([])
    expect(service.snapshot().children).toEqual([])
  })

  it('admits the same background child with the key unset — the control', async () => {
    const { service, runtimeStarts } = policedService(false)
    await service.start({ agent: 'worker', task: 'inspect', background: true, restrictions, budgets: budgets() })
    expect(runtimeStarts).toEqual(['child-policed'])
    expect(service.get('child-policed')?.status).toBe('running')
  })

  it('leaves a FOREGROUND child alone — the key names the background surface', async () => {
    // The key's subject on every runtime that has one is the background surface
    // ("`claude agents`, `--bg`, /background, the on-demand daemon"), not
    // delegation as such. A foreground subagent returns into the same turn and
    // is visible in it; taking it here would be a broader posture than the key
    // names, and a lane does not decide one.
    const { service, runtimeStarts } = policedService(true)
    await service.start({ agent: 'worker', task: 'inspect', background: false, restrictions, budgets: budgets() })
    expect(runtimeStarts).toEqual(['child-policed'])
  })
})

/**
 * F1.225 — the durable record carries a run's `maxTurns` stop to every reader
 * (`result`, `getResult`, `monitor`), and a RESUME clears it: the new run is not
 * the capped one until its own runtime says so.
 */
describe('ChildSessionService — a run stopped at its maxTurns cap', () => {
  it('keeps the mark on the record and the result, and a resume that finishes clears it', async () => {
    let capped = true
    const service = new ChildSessionService({
      parentSessionKey: parent,
      persist: async () => {},
      runtime: {
        start: async record => ({ childSessionKey: record.childSessionKey, transcriptId: 't', status: 'completed', output: 'half', turnLimitReached: true }),
        resume: async () => (capped ? { status: 'completed', output: 'more', turnLimitReached: true } : { status: 'completed', output: 'done' }),
        steer: async () => {}, stop: async () => {},
      },
      makeId: () => 'child-capped',
    })
    const started = await service.start({
      agent: 'worker', task: 'work', background: false,
      restrictions: { prompt: 'p', model: 'm', tools: [], worktreePolicy: 'shared', thinkingLevel: 'off', maxTurns: 1 },
      budgets: { depth: 1, maxDepth: 2, fanout: 1, concurrency: 1, tokenLimit: 10, costLimitUsd: 1, deadlineAt: Date.now() + 5000, ancestry: [] },
    })
    expect(started.turnLimitReached).toBe(true)
    expect((await service.getResult('child-capped')).turnLimitReached).toBe(true)
    // Capped again on the resumed run: still marked.
    expect((await service.resume('child-capped', 'continue')).turnLimitReached).toBe(true)
    // A resumed run that finishes: the mark from the earlier run is gone.
    capped = false
    const finished = await service.resume('child-capped', 'finish')
    expect(finished.output).toBe('done')
    expect(finished).not.toHaveProperty('turnLimitReached')
  })
})
