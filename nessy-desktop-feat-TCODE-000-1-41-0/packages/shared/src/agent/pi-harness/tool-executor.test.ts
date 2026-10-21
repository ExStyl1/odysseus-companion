import { describe, expect, test } from 'bun:test'

import type { HarnessToolDescriptor } from './harness-tool-descriptor.ts'
import {
  createToolExecutor,
  TOOL_CALL_HEARTBEAT_INTERVAL_MS,
  type ToolExecutionPort,
  type ToolExecutionRequest,
} from './tool-executor.ts'
import {
  MAX_TOOL_USE_CONCURRENCY_COMPAT_ENV,
  MAX_TOOL_USE_CONCURRENCY_DEFAULT,
  MAX_TOOL_USE_CONCURRENCY_ENV,
  resolveMaxToolUseConcurrency,
  ToolScheduler,
} from './tool-scheduler.ts'

const descriptor = (
  scheduling: HarnessToolDescriptor['scheduling'],
  mutationScope?: HarnessToolDescriptor['mutationScope'],
): HarnessToolDescriptor => ({
  id: `${scheduling}-${mutationScope ?? 'none'}`,
  schemaVersion: 1,
  effect: mutationScope ? 'workspaceMutation' : 'read',
  risk: 'low',
  scheduling,
  ...(mutationScope ? { mutationScope } : {}),
  sandboxProfile: 'workspace',
  backgroundable: false,
  cancellable: true,
  timeoutMs: 120_000,
})

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

const approve = async (_request: ToolExecutionRequest, input: Record<string, unknown>) => ({
  allowed: true,
  decisionId: 'test-approved',
  canonicalInput: input,
})

interface FakeTimerHandle {
  id: number
  unref(): void
}

/**
 * A deterministic clock for the heartbeat tests: `now` and `timers` are the
 * seams the executor already exposes, so no global timer patching is involved.
 */
const fakeClock = () => {
  let current = 0
  let nextId = 1
  const scheduled = new Map<number, { at: number; callback: () => void }>()
  const unreffed = new Set<number>()
  return {
    now: () => current,
    pendingCount: () => scheduled.size,
    unreffedCount: () => unreffed.size,
    timers: {
      setTimeout(callback: () => void, timeoutMs: number): FakeTimerHandle {
        const id = nextId
        nextId += 1
        scheduled.set(id, { at: current + timeoutMs, callback })
        return { id, unref() { unreffed.add(id) } }
      },
      clearTimeout(handle: unknown) {
        if (handle && typeof handle === 'object' && 'id' in handle) {
          scheduled.delete((handle as FakeTimerHandle).id)
        }
      },
    },
    advance(ms: number) {
      const target = current + ms
      for (;;) {
        let dueId: number | undefined
        let dueAt = Number.POSITIVE_INFINITY
        for (const [id, entry] of scheduled) {
          if (entry.at <= target && entry.at < dueAt) {
            dueAt = entry.at
            dueId = id
          }
        }
        if (dueId === undefined) break
        const entry = scheduled.get(dueId)!
        scheduled.delete(dueId)
        current = entry.at
        entry.callback()
      }
      current = target
    },
  }
}

const heartbeatsOf = (
  events: readonly { executionId: string; value: { text: string; details?: Record<string, unknown> } }[],
) => events.filter(event => event.value.details?.toolCallHeartbeat === true)

describe('ToolScheduler', () => {
  test('runs reads and different mutation scopes concurrently, serializes one scope, and makes terminal work exclusive', async () => {
    const scheduler = new ToolScheduler()
    const first = deferred()
    const order: string[] = []
    const readA = scheduler.run(descriptor('parallel'), async () => {
      order.push('read-a:start')
      await first.promise
      order.push('read-a:end')
    })
    const readB = scheduler.run(descriptor('parallel'), async () => { order.push('read-b') })
    await Promise.resolve()
    expect(order).toEqual(['read-a:start', 'read-b'])
    first.resolve()
    await Promise.all([readA, readB])

    const workspace = deferred()
    const sameA = scheduler.run(descriptor('serialByScope', 'workspace'), async () => {
      order.push('workspace-a:start')
      await workspace.promise
      order.push('workspace-a:end')
    })
    const sameB = scheduler.run(descriptor('serialByScope', 'workspace'), async () => { order.push('workspace-b') })
    const different = scheduler.run(descriptor('serialByScope', 'session'), async () => { order.push('session') })
    await Promise.resolve()
    expect(order).toContain('workspace-a:start')
    expect(order).toContain('session')
    expect(order).not.toContain('workspace-b')
    workspace.resolve()
    await Promise.all([sameA, sameB, different])
    expect(order.indexOf('workspace-a:end')).toBeLessThan(order.indexOf('workspace-b'))

    const active = deferred()
    const normal = scheduler.run(descriptor('parallel'), async () => {
      order.push('normal:start')
      await active.promise
      order.push('normal:end')
    })
    const terminal = scheduler.run(descriptor('exclusive'), async () => { order.push('terminal') })
    const blocked = scheduler.run(descriptor('parallel'), async () => { order.push('after-terminal') })
    await Promise.resolve()
    expect(order).not.toContain('terminal')
    expect(order).not.toContain('after-terminal')
    active.resolve()
    await Promise.all([normal, terminal, blocked])
    expect(order.indexOf('normal:end')).toBeLessThan(order.indexOf('terminal'))
    expect(order.indexOf('terminal')).toBeLessThan(order.indexOf('after-terminal'))
  })

  /**
   * P6.490 — `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY`, the documented ceiling on
   * "read-only tools and subagents that can execute in parallel (default: 10)"
   * (`env-vars.md#variables`). Before this row the scheduler started every
   * eligible queued call at once, so the key was read by nothing on Pi.
   */
  test('bounds parallel tool calls at the ceiling and resumes as each finishes', async () => {
    const scheduler = new ToolScheduler(2)
    const gate = deferred()
    const started: string[] = []
    const runs = ['a', 'b', 'c'].map(name => scheduler.run(descriptor('parallel'), async () => {
      started.push(name)
      await gate.promise
    }))

    await Promise.resolve()
    // The third is DEFERRED, not refused — it is still queued.
    expect(started).toEqual(['a', 'b'])

    gate.resolve()
    await Promise.all(runs)
    expect(started).toEqual(['a', 'b', 'c'])
  })

  test('an unbounded batch still runs to completion under the ceiling', async () => {
    // The boundary the case above cannot see: a batch LARGER than the ceiling
    // must not deadlock — every call has to finish, in order.
    const scheduler = new ToolScheduler(2)
    const finished: number[] = []
    await Promise.all(Array.from({ length: 7 }, (_, index) => scheduler.run(
      descriptor('parallel'),
      async () => { finished.push(index) },
    )))
    expect(finished).toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  test('the ceiling is read from either spelling, and a malformed value keeps the documented default', () => {
    expect(resolveMaxToolUseConcurrency({})).toBe(MAX_TOOL_USE_CONCURRENCY_DEFAULT)
    expect(resolveMaxToolUseConcurrency({ [MAX_TOOL_USE_CONCURRENCY_COMPAT_ENV]: '4' })).toBe(4)
    // The Nessy name wins when both are set — the aliased-pair discipline every
    // sibling ceiling reader in this tree follows.
    expect(resolveMaxToolUseConcurrency({
      [MAX_TOOL_USE_CONCURRENCY_ENV]: '3',
      [MAX_TOOL_USE_CONCURRENCY_COMPAT_ENV]: '4',
    })).toBe(3)
    // Fail CLOSED: a typo must not buy an unbounded batch.
    for (const raw of ['0', '-1', 'ten', '', '1e3', ' ']) {
      expect(resolveMaxToolUseConcurrency({ [MAX_TOOL_USE_CONCURRENCY_COMPAT_ENV]: raw }))
        .toBe(MAX_TOOL_USE_CONCURRENCY_DEFAULT)
    }
  })
})

describe('ToolExecutor', () => {
  test('fails closed before scheduling or dispatch when the permission bridge is missing', async () => {
    let dispatches = 0
    const executor = createToolExecutor({
      runtime: { executeAuthorized: async () => ({ content: '', isError: false }) },
      authority: authority(),
      ports: [{
        semanticId: 'read',
        canonicalize: input => input as Record<string, unknown>,
        dispatch: {
          kind: 'semantic',
          async execute() {
            dispatches += 1
            return { content: 'unsafe', isError: false }
          },
        },
      }],
    })

    expect(await executor.execute(request('missing-bridge', 'read'))).toMatchObject({
      outcome: 'denied',
      code: 'missing_permission_bridge',
    })
    expect(dispatches).toBe(0)
  })

  test('admits the typed nestor-a2a source through the same authority path', async () => {
    epoch = 1
    const executor = createToolExecutor({
      runtime: { executeAuthorized: async () => ({ content: 'ok', isError: false }) },
      authority: authority(),
      ports: [{
        semanticId: 'read',
        canonicalize: input => input as Record<string, unknown>,
        dispatch: {
          kind: 'local',
          toLocalCall: (_input, executionRequest) => ({
            id: executionRequest.executionId,
            displayName: executionRequest.presentedName,
            operation: { kind: 'read_file', path: 'README.md' },
            permission: { toolName: 'Read', input: { file_path: 'README.md' } },
          }),
        },
      }],
      permissionBridge: approve,
    })

    expect(await executor.execute(request('nestor', 'read', { source: 'nestor-a2a' }))).toMatchObject({
      outcome: 'success',
      semanticId: 'read',
      result: { content: 'ok' },
    })
    expect(await executor.execute(request('unknown-source', 'read', { source: 'unknown' as never }))).toMatchObject({
      outcome: 'error',
      code: 'unsupported_execution_source',
    })
  })
  let epoch = 1
  const authority = () => ({
    sessionKey: { workspaceId: 'workspace-1', sessionId: 'session-1' },
    manifestIdentity: { generation: 'generation-1', manifestHash: 'hash-1', responseEpoch: epoch },
    getCurrentResponseEpoch: () => epoch,
  })
  const request = (
    executionId: string,
    semanticId = 'read',
    overrides: Partial<ToolExecutionRequest> = {},
  ): ToolExecutionRequest => ({
    executionId,
    sessionKey: { workspaceId: 'workspace-1', sessionId: 'session-1' },
    manifestIdentity: { generation: 'generation-1', manifestHash: 'hash-1', responseEpoch: 1 },
    semanticId,
    canonicalInput: {},
    source: 'pi',
    presentedName: semanticId,
    abortSignal: new AbortController().signal,
    ...overrides,
  })

  test('owns canonicalization, permission, descriptor resolution, and dispatch outside the request', async () => {
    epoch = 1
    const permissionInputs: unknown[] = []
    const effects: unknown[] = []
    const port: ToolExecutionPort = {
      semanticId: 'read',
      canonicalize(input) {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid input')
        const value = input as Record<string, unknown>
        if (Object.keys(value).some(key => key !== 'path') || typeof value.path !== 'string') throw new Error('invalid input')
        return { path: value.path }
      },
      dispatch: {
        kind: 'semantic',
        async execute(input) {
          effects.push(input)
          return { content: 'unreachable', isError: false }
        },
      },
    }
    const executor = createToolExecutor({
      runtime: { executeAuthorized: async () => ({ content: '', isError: false }) },
      authority: authority(),
      ports: [port],
      async permissionBridge(_request, input) {
        permissionInputs.push(input)
        return { allowed: true, decisionId: 'approval-1', canonicalInput: { ...input, extra: true } }
      },
    })

    const malformed = await executor.execute(request('invalid', 'read', { canonicalInput: { path: 'a', extra: true } }))
    expect(malformed.outcome).toBe('error')
    expect(permissionInputs).toHaveLength(0)

    const modified = await executor.execute(request('modified-invalid', 'read', { canonicalInput: { path: 'a' } }))
    expect(modified.outcome).toBe('error')
    expect(modified.decisionId).toBe('approval-1')
    expect(permissionInputs).toEqual([{ path: 'a' }])
    expect(effects).toEqual([])
    expect(Object.keys(request('shape'))).toEqual([
      'executionId', 'sessionKey', 'manifestIdentity', 'semanticId', 'canonicalInput', 'source', 'presentedName', 'abortSignal',
    ])
  })

  test('rejects every session and manifest authority mismatch before the bridge or dispatch', async () => {
    epoch = 1
    const bridges: unknown[] = []
    const dispatches: unknown[] = []
    const executor = createToolExecutor({
      runtime: { executeAuthorized: async () => ({ content: '', isError: false }) },
      authority: authority(),
      ports: [{
        semanticId: 'read',
        canonicalize: input => input as Record<string, unknown>,
        dispatch: {
          kind: 'semantic',
          async execute(input) {
            dispatches.push(input)
            return { content: 'unreachable', isError: false }
          },
        },
      }],
      async permissionBridge(executionRequest, input) {
        bridges.push([executionRequest, input])
        return { allowed: true, decisionId: 'approval', canonicalInput: input }
      },
    })
    const mismatches: ToolExecutionRequest[] = [
      request('wrong-workspace', 'read', { sessionKey: { workspaceId: 'wrong', sessionId: 'session-1' } }),
      request('wrong-session', 'read', { sessionKey: { workspaceId: 'workspace-1', sessionId: 'wrong' } }),
      request('wrong-generation', 'read', { manifestIdentity: { generation: 'wrong', manifestHash: 'hash-1', responseEpoch: 1 } }),
      request('wrong-hash', 'read', { manifestIdentity: { generation: 'generation-1', manifestHash: 'wrong', responseEpoch: 1 } }),
    ]

    for (const mismatch of mismatches) {
      expect(await executor.execute(mismatch)).toMatchObject({ outcome: 'cancelled', result: { isError: true } })
    }
    expect(bridges).toEqual([])
    expect(dispatches).toEqual([])
  })

  test('emits one denied receipt with the bridge decision and no dispatch', async () => {
    epoch = 1
    const receipts: unknown[] = []
    const dispatches: unknown[] = []
    const executor = createToolExecutor({
      runtime: { executeAuthorized: async () => ({ content: '', isError: false }) },
      authority: authority(),
      ports: [{
        semanticId: 'read',
        canonicalize: input => input as Record<string, unknown>,
        dispatch: {
          kind: 'semantic',
          async execute(input) {
            dispatches.push(input)
            return { content: 'unreachable', isError: false }
          },
        },
      }],
      permissionBridge: async () => ({ allowed: false, decisionId: 'decision-denied', reason: 'blocked' }),
      onReceipt: receipt => receipts.push(receipt),
    })

    const receipt = await executor.execute(request('denied', 'read'))
    expect(receipt).toMatchObject({
      executionId: 'denied', semanticId: 'read', outcome: 'denied', decisionId: 'decision-denied',
      result: { isError: true },
    })
    expect(dispatches).toEqual([])
    expect(receipts).toEqual([receipt])
  })

  test('cancels a pending permission wait and ignores late approval', async () => {
    epoch = 1
    let resolvePermission!: (value: { allowed: boolean; decisionId: string; canonicalInput: unknown }) => void
    let dispatches = 0
    const receipts: unknown[] = []
    const executor = createToolExecutor({
      runtime: { executeAuthorized: async () => ({ content: '', isError: false }) },
      authority: authority(),
      ports: [{
        semanticId: 'read',
        canonicalize: input => input as Record<string, unknown>,
        dispatch: {
          kind: 'semantic',
          async execute() {
            dispatches += 1
            return { content: 'unexpected', isError: false }
          },
        },
      }],
      permissionBridge: () => new Promise(resolve => { resolvePermission = resolve }),
      onReceipt: receipt => receipts.push(receipt),
    })
    const controller = new AbortController()
    const pending = executor.execute(request('pending-permission', 'read', { abortSignal: controller.signal }))
    controller.abort()

    expect(await pending).toMatchObject({ outcome: 'cancelled', code: 'aborted' })
    resolvePermission({ allowed: true, decisionId: 'late', canonicalInput: {} })
    await Promise.resolve()
    expect(dispatches).toBe(0)
    expect(receipts).toHaveLength(1)
  })

  test('uses one injected runtime for repeated local dispatch', async () => {
    epoch = 1
    const calls: unknown[] = []
    let permissionDecisions = 0
    let semanticPreEffects = 0
    const runtime = {
      executeAuthorized: async (call: unknown) => {
        calls.push(call)
        return {
          content: 'runtime',
          isError: false,
          isolationProfile: 'read-only:test',
          environmentProfile: 'restricted',
          environmentDigest: 'a'.repeat(64),
        }
      },
    }
    const port: ToolExecutionPort = {
      semanticId: 'read',
      canonicalize: input => input as Record<string, unknown>,
      dispatch: {
        kind: 'local',
        toLocalCall: (input, executionRequest) => ({
          id: executionRequest.executionId,
          displayName: executionRequest.presentedName,
          operation: { kind: 'read_file', path: String(input.path) },
          permission: { toolName: 'Read', input },
          abortSignal: executionRequest.abortSignal,
        }),
      },
    }
    const executor = createToolExecutor({
      runtime,
      authority: authority(),
      ports: [port],
      permissionBridge: async (_request, input) => {
        permissionDecisions += 1
        return { allowed: true, decisionId: 'approved', canonicalInput: input }
      },
      beforeDispatch: async () => { semanticPreEffects += 1 },
    })
    const first = await executor.execute(request('read-1', 'read', { canonicalInput: { path: 'one' } }))
    await executor.execute(request('read-2', 'read', { canonicalInput: { path: 'two' } }))
    expect(calls).toHaveLength(2)
    expect(permissionDecisions).toBe(2)
    expect(semanticPreEffects).toBe(2)
    expect(first.isolationProfile).toBe('read-only:test')
    expect(first.environmentProfile).toBe('restricted')
    expect(first.environmentDigest).toBe('a'.repeat(64))
    expect(first).not.toHaveProperty('environment')
    expect(calls.map(call => (call as { operation: { path: string } }).operation.path)).toEqual(['one', 'two'])
  })

  test('cancels stale queued work with one required bounded receipt and no effect, result, or progress escape', async () => {
    epoch = 1
    const receipts: unknown[] = []
    const effects: string[] = []
    const progress: string[] = []
    let semanticPreEffects = 0
    const held = deferred()
    const started = deferred()
    const queuedPermission = deferred()
    let invocation = 0
    let permissions = 0
    const port: ToolExecutionPort = {
      semanticId: 'write',
      canonicalize: input => input as Record<string, unknown>,
      dispatch: {
        kind: 'semantic',
        async execute(_input, context) {
          invocation += 1
          if (invocation === 1) {
            started.resolve()
            await held.promise
          }
          else effects.push('effect')
          context.emitProgress({ text: 'progress' })
          return { content: 'result', isError: false }
        },
      },
    }
    const executor = createToolExecutor({
      runtime: { executeAuthorized: async () => ({ content: '', isError: false }) },
      authority: authority(),
      ports: [port],
      onReceipt: receipt => receipts.push(receipt),
      onProgress: (_executionId, value) => progress.push(value.text),
      maxProgressEvents: 1,
      maxResultBytes: 8,
      beforeDispatch: async () => { semanticPreEffects += 1 },
      permissionBridge: async (_request, input) => {
        permissions += 1
        if (permissions === 2) queuedPermission.resolve()
        return { allowed: true, decisionId: 'approved', canonicalInput: input }
      },
    })
    const blocker = executor.execute(request('blocker', 'write'))
    await started.promise
    const stale = executor.execute(request('stale', 'write'))
    await queuedPermission.promise
    epoch = 2
    held.resolve()
    await blocker
    const receipt = await stale

    expect(receipt).toMatchObject({
      executionId: 'stale', semanticId: 'write', outcome: 'cancelled', code: 'stale_response_epoch',
      result: { isError: true },
    })
    expect(effects).toEqual([])
    expect(progress).toEqual([])
    expect(semanticPreEffects).toBe(1)
    expect(receipts).toHaveLength(2)
  })

  test('revalidates authority after an awaited semantic pre-effect hook', async () => {
    epoch = 1
    const held = deferred()
    const preEffectStarted = deferred()
    let dispatches = 0
    const pendingCheckpoints = new Set<string>()
    const finalizations: Array<{ result?: unknown; error?: unknown }> = []
    const executor = createToolExecutor({
      runtime: { executeAuthorized: async () => ({ content: '', isError: false }) },
      authority: authority(),
      ports: [{
        semanticId: 'write',
        canonicalize: input => input as Record<string, unknown>,
        dispatch: {
          kind: 'semantic',
          async execute() {
            dispatches += 1
            return { content: 'unexpected', isError: false }
          },
        },
      }],
      permissionBridge: approve,
      beforeDispatch: async executionRequest => {
        pendingCheckpoints.add(executionRequest.executionId)
        preEffectStarted.resolve()
        await held.promise
        return { checkpointId: `checkpoint-${executionRequest.executionId}` }
      },
      afterDispatch: (executionRequest, _descriptor, _input, outcome) => {
        pendingCheckpoints.delete(executionRequest.executionId)
        finalizations.push(outcome)
      },
    })
    const pending = executor.execute(request('stale-hook', 'write'))
    await preEffectStarted.promise
    epoch = 2
    held.resolve()

    expect(await pending).toMatchObject({ outcome: 'cancelled', code: 'stale_response_epoch' })
    expect(dispatches).toBe(0)
    expect(pendingCheckpoints.size).toBe(0)
    expect(finalizations).toHaveLength(1)
    expect(finalizations[0]?.error).toBeDefined()
  })

  test('awaits and finalizes a checkpoint pre-effect when cancellation races its persistence', async () => {
    epoch = 1
    const preEffectStarted = deferred()
    const releasePreEffect = deferred()
    const pendingCheckpoints = new Set<string>()
    const finalizations: Array<{ result?: unknown; error?: unknown }> = []
    let dispatches = 0
    const executor = createToolExecutor({
      runtime: { executeAuthorized: async () => ({ content: '', isError: false }) },
      authority: authority(),
      ports: [{
        semanticId: 'write',
        canonicalize: input => input as Record<string, unknown>,
        dispatch: {
          kind: 'semantic',
          async execute() {
            dispatches += 1
            return { content: 'unexpected', isError: false }
          },
        },
      }],
      permissionBridge: approve,
      beforeDispatch: async executionRequest => {
        pendingCheckpoints.add(executionRequest.executionId)
        preEffectStarted.resolve()
        await releasePreEffect.promise
        return { checkpointId: `checkpoint-${executionRequest.executionId}` }
      },
      afterDispatch: (executionRequest, _descriptor, _input, outcome) => {
        pendingCheckpoints.delete(executionRequest.executionId)
        finalizations.push(outcome)
      },
    })
    const controller = new AbortController()
    let settled = false
    const pending = executor.execute(request('abort-pre-effect', 'write', { abortSignal: controller.signal }))
      .finally(() => { settled = true })
    await preEffectStarted.promise
    controller.abort()
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(pendingCheckpoints).toEqual(new Set(['abort-pre-effect']))

    releasePreEffect.resolve()
    expect(await pending).toMatchObject({ outcome: 'cancelled', code: 'aborted' })
    expect(dispatches).toBe(0)
    expect(pendingCheckpoints.size).toBe(0)
    expect(finalizations).toHaveLength(1)
    expect(finalizations[0]?.error).toBeDefined()
  })

  test('uses descriptor deadline and emits one bounded terminal receipt for abort, timeout, and late completion', async () => {
    epoch = 1
    const receipts: Array<{
      executionId: string
      outcome: string
      result: { content: string }
      progress?: readonly { text: string; details?: Record<string, unknown> }[]
    }> = []
    const scheduledTimeouts: number[] = []
    const port: ToolExecutionPort = {
      semanticId: 'read',
      canonicalize: input => input as Record<string, unknown>,
      dispatch: {
        kind: 'semantic',
        async execute(_input, context) {
          context.emitProgress({ text: 'first' })
          context.emitProgress({ text: 'second' })
          return new Promise(resolve => context.signal.addEventListener(
            'abort',
            () => resolve({ content: 'late-result', isError: false }),
            { once: true },
          ))
        },
      },
    }
    const executor = createToolExecutor({
      runtime: { executeAuthorized: async () => ({ content: '', isError: false }) },
      authority: authority(),
      ports: [port],
      permissionBridge: approve,
      onReceipt: receipt => receipts.push(receipt),
      maxProgressEvents: 1,
      maxResultBytes: 4,
      timers: {
        setTimeout(callback, timeoutMs) {
          scheduledTimeouts.push(timeoutMs)
          queueMicrotask(callback)
          return 1
        },
        clearTimeout() {},
      },
    })
    const controller = new AbortController()
    controller.abort()
    expect((await executor.execute(request('abort', 'read', { abortSignal: controller.signal }))).outcome).toBe('cancelled')
    const timedOut = await executor.execute(request('timeout'))
    expect(timedOut).toMatchObject({ outcome: 'timed-out', result: { isError: true } })
    expect(scheduledTimeouts).toEqual([getTimeout('read')])
    expect(receipts.filter(receipt => receipt.executionId === 'timeout')).toHaveLength(1)
    expect(receipts).toHaveLength(2)
    for (const receipt of receipts) {
      expect(receipt.result.content.length).toBeLessThanOrEqual(4)
      expect(receipt).toMatchObject({
        decisionId: receipt.executionId === 'abort' ? 'not-requested' : 'test-approved',
        isolationProfile: 'no-host-isolation',
      })
    }
  })

  test('bounds structured results and keeps throwing observers non-authoritative', async () => {
    epoch = 1
    let receiptObservations = 0
    let progressObservations = 0
    const executor = createToolExecutor({
      runtime: { executeAuthorized: async () => ({ content: '', isError: false }) },
      authority: authority(),
      ports: [{
        semanticId: 'read',
        canonicalize: input => input as Record<string, unknown>,
        dispatch: {
          kind: 'semantic',
          async execute(_input, context) {
            context.emitProgress({
              text: 'visible',
              details: { progress: { payload: 'x'.repeat(10_000) } },
            })
            return {
              content: 'ok',
              isError: false,
              structuredContent: { payload: 'x'.repeat(10_000) },
            }
          },
        },
      }],
      permissionBridge: approve,
      maxResultBytes: 128,
      onProgress: () => {
        progressObservations += 1
        throw new Error('observer progress failure')
      },
      onReceipt: () => {
        receiptObservations += 1
        throw new Error('observer receipt failure')
      },
    })

    const receipt = await executor.execute(request('bounded-observers'))
    expect(receipt).toMatchObject({
      outcome: 'success',
      result: { isError: false, structuredContent: { truncated: true } },
    })
    expect((receipt.result.structuredContent?.originalBytes as number)).toBeGreaterThan(10_000)
    expect(new TextEncoder().encode(
      receipt.result.content + JSON.stringify(receipt.result.structuredContent),
    ).byteLength).toBeLessThanOrEqual(128)
    expect(receipt.progress).toEqual([{
      text: expect.any(String),
      details: { truncated: true, originalBytes: expect.any(Number) },
    }])
    expect(new TextEncoder().encode(
      receipt.progress![0]!.text + JSON.stringify(receipt.progress![0]!.details),
    ).byteLength).toBeLessThanOrEqual(128)
    expect(progressObservations).toBe(1)
    expect(receiptObservations).toBe(1)
  })

  test('includes duplicated error text in the bounded receipt budget without a result transformer', async () => {
    epoch = 1
    const huge = `error-head-${'🙂'.repeat(5_000)}-error-tail`
    const executor = createToolExecutor({
      runtime: { executeAuthorized: async () => ({ content: '', isError: false }) },
      authority: authority(),
      ports: [{
        semanticId: 'read',
        canonicalize: input => input as Record<string, unknown>,
        dispatch: {
          kind: 'semantic',
          async execute() {
            return {
              content: huge,
              error: huge,
              isError: true,
              structuredContent: { diagnostic: 'x'.repeat(10_000) },
            }
          },
        },
      }],
      permissionBridge: approve,
      maxResultBytes: 128,
    })

    const receipt = await executor.execute(request('bounded-error'))
    // `originalBytes` is deliberately NOT matched here: on bun 1.3.14 an
    // asymmetric matcher inside `toMatchObject` OVERWRITES the matched leaf of
    // the RECEIVED object, so `expect.any(Number)` replaced the real count with
    // a matcher that serialises as `{}` and shrank the budget measured below by
    // three bytes. `truncated: true` proves the marker anyway — the bounder
    // builds it as one literal, `{ truncated: true, originalBytes }`.
    expect(receipt).toMatchObject({
      outcome: 'error',
      result: {
        isError: true,
        structuredContent: { truncated: true },
      },
    })
    // P2.391 — DISTINCT bytes, and the change of unit is the posture statement.
    // This summed `content + error + reason` while all three hold the SAME
    // string, so a failure was charged three times for one payload and received
    // a third of the budget a success received. The bound now charges a
    // duplicate once; what it still guarantees, and what is asserted here, is
    // that the DISTINCT payload stays under the cap.
    const distinct = new Set([
      receipt.result.content,
      ...(receipt.result.error === undefined ? [] : [receipt.result.error]),
      ...(receipt.reason === undefined ? [] : [receipt.reason]),
    ])
    expect(new TextEncoder().encode(
      [...distinct].join('') + JSON.stringify(receipt.result.structuredContent ?? {}),
    ).byteLength).toBeLessThanOrEqual(128)
    // The duplicate really is one: if these three ever diverge, the line above
    // stops measuring what it claims to and the budget silently triples.
    expect(distinct.size).toBe(1)
    expect(receipt.result.content).not.toContain('error-tail')
    expect(receipt.result.error).not.toContain('error-tail')
    expect(receipt.reason).not.toContain('error-tail')
    expect(receipt.result.content).not.toContain('\uFFFD')
    expect(receipt.result.error).not.toContain('\uFFFD')
  })

  test('classifies an ordinary thrown execution error as one bounded execution_error receipt', async () => {
    epoch = 1
    const receipts: Array<{ executionId: string; outcome: string; code?: string }> = []
    const failure = `ordinary-failure-${'🙂'.repeat(5_000)}-tail`
    const executor = createToolExecutor({
      runtime: { executeAuthorized: async () => ({ content: '', isError: false }) },
      authority: authority(),
      ports: [{
        semanticId: 'read',
        canonicalize: input => input as Record<string, unknown>,
        dispatch: {
          kind: 'semantic',
          async execute() {
            throw new Error(failure)
          },
        },
      }],
      permissionBridge: approve,
      maxResultBytes: 128,
      onReceipt: receipt => receipts.push(receipt),
    })

    const receipt = await executor.execute(request('ordinary-failure'))
    expect(receipt).toMatchObject({
      outcome: 'error',
      code: 'execution_error',
      result: { isError: true },
    })
    expect(receipt).not.toMatchObject({ outcome: 'cancelled', code: 'aborted' })
    expect(receipts).toHaveLength(1)
    expect(new TextEncoder().encode(
      receipt.result.content
      + (receipt.result.error ?? '')
      + JSON.stringify(receipt.result.structuredContent ?? {})
      + (receipt.reason ?? ''),
    ).byteLength).toBeLessThanOrEqual(128)
    expect(receipt.result.content).not.toContain('-tail')
    expect(receipt.result.error).not.toContain('-tail')
    expect(receipt.reason).not.toContain('-tail')
  })

  test('releases scheduler ownership when abort interrupts result transformation', async () => {
    epoch = 1
    const transformStarted = deferred()
    const releaseTransform = deferred()
    const receipts: Array<{ executionId: string; outcome: string }> = []
    const progress: string[] = []
    let dispatches = 0
    const executor = createToolExecutor({
      runtime: { executeAuthorized: async () => ({ content: '', isError: false }) },
      authority: authority(),
      ports: [{
        semanticId: 'write',
        canonicalize: input => input as Record<string, unknown>,
        dispatch: {
          kind: 'semantic',
          async execute() {
            dispatches += 1
            return { content: 'raw', isError: false }
          },
        },
      }],
      permissionBridge: approve,
      async transformResult(executionRequest, _input, result) {
        if (executionRequest.executionId === 'held-transform') {
          transformStarted.resolve()
          await releaseTransform.promise
        }
        return result
      },
      onReceipt: receipt => receipts.push(receipt),
      onProgress: (_executionId, value) => progress.push(value.text),
    })
    const controller = new AbortController()
    const held = executor.execute(request('held-transform', 'write', { abortSignal: controller.signal }))
    await transformStarted.promise
    controller.abort()
    expect(await held).toMatchObject({ outcome: 'cancelled', code: 'aborted' })

    expect(await executor.execute(request('after-transform-abort', 'write'))).toMatchObject({ outcome: 'success' })
    expect(dispatches).toBe(2)
    expect(receipts).toHaveLength(2)
    expect(progress).toEqual([])

    releaseTransform.resolve()
    await Promise.resolve()
    expect(receipts).toHaveLength(2)
    expect(progress).toEqual([])
  })

  test('retains safe manifest, effect and execution correlations without result parsing downstream', async () => {
    epoch = 1
    const executor = createToolExecutor({
      runtime: { executeAuthorized: async () => ({ content: '', isError: false }) },
      authority: authority(),
      ports: [{
        semanticId: 'mcp_dynamic',
        canonicalize: input => input as Record<string, unknown>,
        dispatch: {
          kind: 'semantic',
          async execute() {
            return {
              content: 'private output',
              isError: false,
              isolationProfile: 'plugin-mcp',
              structuredContent: {
                shellId: 'process-1',
                agentIds: ['child-1'],
                progress: { kind: 'workflow', runId: 'workflow-1' },
              },
            }
          },
        },
      }],
      permissionBridge: approve,
      beforeDispatch: () => ({ checkpointId: 'checkpoint-1', parentExecutionId: 'parent-1' }),
    })

    expect(await executor.execute(request('call-1', 'mcp_dynamic', { presentedName: 'mcp__gitlab__get_repo' }))).toMatchObject({
      manifestGeneration: 'generation-1',
      responseEpoch: 1,
      effect: 'externalMutation',
      correlation: {
        parentExecutionId: 'parent-1',
        checkpointId: 'checkpoint-1',
        processId: 'process-1',
        childIds: ['child-1'],
        workflowId: 'workflow-1',
        mcpServer: 'gitlab',
        mcpTool: 'get_repo',
      },
    })
  })
  test('emits an elapsed heartbeat every 30s a running tool stays silent, without spending the receipt progress budget', async () => {
    epoch = 1
    const clock = fakeClock()
    const started = deferred()
    const release = deferred()
    const emitted: { executionId: string; value: { text: string; details?: Record<string, unknown> } }[] = []
    const executor = createToolExecutor({
      runtime: { executeAuthorized: async () => ({ content: '', isError: false }) },
      authority: authority(),
      ports: [{
        semanticId: 'read',
        canonicalize: input => input as Record<string, unknown>,
        dispatch: {
          kind: 'semantic',
          async execute() {
            started.resolve()
            await release.promise
            return { content: 'done', isError: false }
          },
        },
      }],
      permissionBridge: approve,
      onProgress: (executionId, value) => { emitted.push({ executionId, value }) },
      now: clock.now,
      timers: clock.timers,
    })

    const pending = executor.execute(request('silent'))
    await started.promise
    clock.advance(TOOL_CALL_HEARTBEAT_INTERVAL_MS - 1)
    expect(heartbeatsOf(emitted)).toHaveLength(0)

    clock.advance(1)
    expect(heartbeatsOf(emitted)).toEqual([{
      executionId: 'silent',
      value: { text: 'Still running (30s)', details: { toolCallHeartbeat: true, elapsedSeconds: 30 } },
    }])

    clock.advance(TOOL_CALL_HEARTBEAT_INTERVAL_MS)
    expect(heartbeatsOf(emitted).map(event => event.value.details?.elapsedSeconds)).toEqual([30, 60])
    // The timer never holds the Pi subprocess open on its own.
    expect(clock.unreffedCount()).toBeGreaterThan(0)

    release.resolve()
    const receipt = await pending
    expect(receipt).toMatchObject({ outcome: 'success', result: { content: 'done' } })
    // Heartbeats are liveness for the renderer, not execution evidence: they must
    // not displace real tool progress inside the receipt's bounded budget.
    expect(receipt.progress).toBeUndefined()
  })

  test('lets a push progress event reset the heartbeat quiet window', async () => {
    epoch = 1
    const clock = fakeClock()
    const started = deferred()
    const release = deferred()
    const emitted: { executionId: string; value: { text: string; details?: Record<string, unknown> } }[] = []
    let push!: (value: { text: string }) => void
    const executor = createToolExecutor({
      runtime: { executeAuthorized: async () => ({ content: '', isError: false }) },
      authority: authority(),
      ports: [{
        semanticId: 'read',
        canonicalize: input => input as Record<string, unknown>,
        dispatch: {
          kind: 'semantic',
          async execute(_input, context) {
            push = value => context.emitProgress(value)
            started.resolve()
            await release.promise
            return { content: 'done', isError: false }
          },
        },
      }],
      permissionBridge: approve,
      onProgress: (executionId, value) => { emitted.push({ executionId, value }) },
      now: clock.now,
      timers: clock.timers,
    })

    const pending = executor.execute(request('chatty'))
    await started.promise
    clock.advance(TOOL_CALL_HEARTBEAT_INTERVAL_MS - 1_000)
    push({ text: 'reading chunk 1' })
    expect(emitted).toHaveLength(1)

    // 30s after the call started, but only 1s after it last spoke.
    clock.advance(1_000)
    expect(heartbeatsOf(emitted)).toHaveLength(0)

    clock.advance(TOOL_CALL_HEARTBEAT_INTERVAL_MS - 1_000)
    expect(heartbeatsOf(emitted).map(event => event.value.details?.elapsedSeconds)).toEqual([59])

    release.resolve()
    expect(await pending).toMatchObject({ outcome: 'success', progress: [{ text: 'reading chunk 1' }] })
  })

  test('arms no heartbeat timer when the caller attached no progress observer', async () => {
    epoch = 1
    const clock = fakeClock()
    const started = deferred()
    const executor = createToolExecutor({
      runtime: { executeAuthorized: async () => ({ content: '', isError: false }) },
      authority: authority(),
      ports: [{
        semanticId: 'read',
        canonicalize: input => input as Record<string, unknown>,
        dispatch: {
          kind: 'semantic',
          execute() {
            started.resolve()
            return new Promise<never>(() => {})
          },
        },
      }],
      permissionBridge: approve,
      now: clock.now,
      timers: clock.timers,
    })

    const controller = new AbortController()
    const pending = executor.execute(request('unobserved', 'read', { abortSignal: controller.signal }))
    await started.promise
    // The descriptor deadline, and nothing else — the A2A executor takes no
    // `onProgress`, so a beat would go nowhere.
    expect(clock.pendingCount()).toBe(1)
    clock.advance(3 * TOOL_CALL_HEARTBEAT_INTERVAL_MS)
    expect(clock.pendingCount()).toBe(1)
    controller.abort()
    expect(await pending).toMatchObject({ outcome: 'cancelled' })
    expect(clock.pendingCount()).toBe(0)
  })

  test('clears the heartbeat timer on completion and on abort', async () => {
    epoch = 1
    const completedClock = fakeClock()
    const completedStarted = deferred()
    const completedEmissions: { executionId: string; value: { text: string; details?: Record<string, unknown> } }[] = []
    const completedExecutor = createToolExecutor({
      runtime: { executeAuthorized: async () => ({ content: '', isError: false }) },
      authority: authority(),
      ports: [{
        semanticId: 'read',
        canonicalize: input => input as Record<string, unknown>,
        dispatch: {
          kind: 'semantic',
          async execute() {
            completedStarted.resolve()
            return { content: 'done', isError: false }
          },
        },
      }],
      permissionBridge: approve,
      onProgress: (executionId, value) => { completedEmissions.push({ executionId, value }) },
      now: completedClock.now,
      timers: completedClock.timers,
    })
    expect(await completedExecutor.execute(request('completes'))).toMatchObject({ outcome: 'success' })
    await completedStarted.promise
    expect(completedClock.pendingCount()).toBe(0)
    completedClock.advance(10 * TOOL_CALL_HEARTBEAT_INTERVAL_MS)
    expect(completedEmissions).toHaveLength(0)

    const abortedClock = fakeClock()
    const abortedStarted = deferred()
    const abortedEmissions: { executionId: string; value: { text: string; details?: Record<string, unknown> } }[] = []
    const abortedExecutor = createToolExecutor({
      runtime: { executeAuthorized: async () => ({ content: '', isError: false }) },
      authority: authority(),
      ports: [{
        semanticId: 'read',
        canonicalize: input => input as Record<string, unknown>,
        dispatch: {
          kind: 'semantic',
          execute() {
            abortedStarted.resolve()
            return new Promise<never>(() => {})
          },
        },
      }],
      permissionBridge: approve,
      onProgress: (executionId, value) => { abortedEmissions.push({ executionId, value }) },
      now: abortedClock.now,
      timers: abortedClock.timers,
    })
    const controller = new AbortController()
    const aborting = abortedExecutor.execute(request('aborts', 'read', { abortSignal: controller.signal }))
    await abortedStarted.promise
    abortedClock.advance(29_000)
    controller.abort()
    expect(await aborting).toMatchObject({ outcome: 'cancelled', code: 'aborted' })
    expect(abortedClock.pendingCount()).toBe(0)
    abortedClock.advance(10 * TOOL_CALL_HEARTBEAT_INTERVAL_MS)
    expect(abortedEmissions).toHaveLength(0)
  })
})

function getTimeout(semanticId: string): number {
  return semanticId === 'read' ? 120_000 : 0
}
