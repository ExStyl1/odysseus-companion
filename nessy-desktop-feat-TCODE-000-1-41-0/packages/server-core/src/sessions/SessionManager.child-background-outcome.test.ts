/**
 * A BACKGROUND child that dies must reach its parent as a failure, with the
 * child's own reason.
 *
 * Q8-D1. `b97c774c0` taught `runPiChildTurn` to let the child's transcript
 * decide, and `SessionManager.child-error-outcome.test.ts` proves that reader.
 * Live on the packaged 1.25.1 the parent was STILL told
 * `1. q8-badtool - done\nagent_id: …\n(no output)` while the child's own session
 * held one `[error] errorCode=invalid_api_key :: Invalid API Key…` row.
 *
 * The reason is the seam, not the reader. A top-level spawn is BACKGROUND by
 * default (`spawner.ts`: `args.background ?? (depth === 1)`), so
 * `startPiChildRuntime` returns `status: 'running'` and `void`s the run — and
 * the spawner then settles the child through `ChildRuntime.monitor` instead.
 * That path consults `piChildRuns` first, but `runPiChildTurn` EVICTS its own
 * promise the moment it settles, and an auth failure settles in about a second
 * — long before the subprocess's `monitor` RPC arrives. The fallback below it
 * then hard-coded `status: 'completed'` and read only assistant messages, so
 * the error row was never consulted on the one path a top-level subagent takes.
 *
 * These tests drive the service the spawner actually talks to
 * (`ChildSessionService.monitor`, whose return value IS the spawner's
 * `PiChildResult`), with the run promise already evicted — the live ordering.
 */
import { describe, expect, test } from 'bun:test'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import type { PiChildSessionRecordV1 } from '@nessy-agent/shared/agent/pi-harness/child-session-port'
import { createTestSessionManager } from './__tests__/test-session-manager.ts'
import { createManagedSession, setSessionPlatform } from './SessionManager.ts'
import { createHeadlessPlatform } from '../runtime/platform-headless.ts'

const workspace = { id: 'workspace-bg-child', name: 'Background child', rootPath: process.cwd(), createdAt: 1 }
const parentKey = { workspaceId: workspace.id, sessionId: 'parent-bg' }
const AGENT_ID = 'agent-subagent-msr5fwfa-2pil3j-1'

function backgroundRecord(childSessionId: string): PiChildSessionRecordV1 {
  return {
    schemaVersion: 1,
    agentId: AGENT_ID,
    parentSessionKey: parentKey,
    childSessionKey: { workspaceId: workspace.id, sessionId: childSessionId },
    agent: 'q8-badtool',
    task: 'Read src/inventory-tag.txt and reply TAG=<its first line>',
    background: true,
    restrictions: { prompt: 'p', model: 'gateway-model', tools: ['read'], thinkingLevel: 'off', worktreePolicy: 'shared' },
    budgets: {
      depth: 1, maxDepth: 3, fanout: 1, concurrency: 1,
      tokenLimit: 100_000, costLimitUsd: 100, deadlineAt: Date.now() + 60_000, ancestry: [],
    },
    // What `startPiChildRuntime` durably records for a background spawn: the
    // run is detached, so the record says `running` with no output at all.
    status: 'running',
    output: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

/**
 * The live rig: a parent whose background child has already settled (its
 * `piChildRuns` entry evicted) and whose transcript is `messages`. Returns what
 * the Pi spawner receives from `childSessionPort.monitor(agentId)`.
 */
async function monitorSettledBackgroundChild(
  messages: Array<{ role: string; content: string }>,
  options: { pendingRun?: Promise<unknown>; processing?: boolean } = {},
): Promise<{ status: string; output: string; error?: string }> {
  setSessionPlatform(createHeadlessPlatform())
  const manager = createTestSessionManager()
  const childSessionId = `child-${Math.random().toString(36).slice(2)}`
  const record = backgroundRecord(childSessionId)

  const parent: any = createManagedSession(
    { id: parentKey.sessionId, name: 'Parent', ephemeral: true },
    workspace as never,
    { messagesLoaded: true },
  )
  parent.childSessionState = { schemaVersion: 1, revision: 1, sealedOwnerTaskIds: [], children: [record] }

  const child: any = createManagedSession(
    { id: childSessionId, name: 'Child', ephemeral: true },
    workspace as never,
    { messagesLoaded: true },
  )
  child.messages = messages
  child.agent = options.processing ? { isProcessing: () => true } : null

  ;(manager as any).sessions.set(encodeSessionKey(parentKey), parent)
  ;(manager as any).sessions.set(encodeSessionKey({ workspaceId: workspace.id, sessionId: childSessionId }), child)
  ;(manager as any).persistSession = () => {}
  ;(manager as any).ensureMessagesLoaded = async () => {}
  if (options.pendingRun) {
    ;(manager as any).piChildRuns.set((manager as any).piChildRunKey(parentKey, AGENT_ID), options.pendingRun)
  }

  const service = (manager as any).getOrCreatePiChildSessionService(parent, {} as never)
  try {
    return await service.monitor(AGENT_ID)
  } finally {
    // Test-rig teardown only: the seeded run promise, the stub agent and a
    // deliberately still-running record are fixtures the manager's strict drain
    // would otherwise report as residue.
    ;(manager as any).piChildRuns.clear()
    child.agent = null
    for (const seeded of (service as any).state.children) {
      if (seeded.status === 'running' || seeded.status === 'starting') seeded.status = 'stopped'
    }
    await manager.cleanup()
  }
}

describe('a background child that dies tells its parent why', () => {
  test('an error-terminated background child settles as failed, naming the reason', async () => {
    const result = await monitorSettledBackgroundChild([
      { role: 'user', content: 'Read src/inventory-tag.txt and reply TAG=<its first line>' },
      { role: 'error', content: 'Invalid API Key: Your API key was rejected. It may be invalid or expired.' },
    ])

    // `spawner.ts` maps `failed` -> `'error'`, and `subagent-tool.ts`'s
    // `contentForResults` renders an `error` result as
    // `[ERROR] 1. <agent> - error\n<reason>` — the shape the parent already
    // gets everywhere else. `completed` here is the live `done … (no output)`.
    expect(result.status).toBe('failed')
    expect(result.error).toBe('Invalid API Key: Your API key was rejected. It may be invalid or expired.')
  })

  test('a healthy background child still settles as completed with its answer', async () => {
    const result = await monitorSettledBackgroundChild([
      { role: 'user', content: 'do the work' },
      { role: 'assistant', content: 'TAG=Q8TAG-7120B4B8' },
    ])

    expect(result.status).toBe('completed')
    expect(result.output).toBe('TAG=Q8TAG-7120B4B8')
    expect(result.error).toBeUndefined()
  })

  test('a child that recovered after an error is not failed by the old row', async () => {
    const result = await monitorSettledBackgroundChild([
      { role: 'user', content: 'do the work' },
      { role: 'error', content: 'transient provider hiccup' },
      { role: 'assistant', content: 'TAG=recovered' },
    ])

    expect(result.status).toBe('completed')
    expect(result.output).toBe('TAG=recovered')
  })

  test('the still-pending run keeps deciding when it has not been evicted yet', async () => {
    // The other half of the race, pinned so the fix cannot regress it: when the
    // turn is still in flight, its own outcome — not the transcript read — is
    // what the parent gets.
    const result = await monitorSettledBackgroundChild(
      [{ role: 'user', content: 'do the work' }],
      { pendingRun: Promise.resolve({ status: 'failed', output: '', error: 'child-session-token-budget-exceeded' }) },
    )

    expect(result.status).toBe('failed')
    expect(result.error).toBe('child-session-token-budget-exceeded')
  })

  test('a child still working is reported as running, not settled by its transcript', async () => {
    const result = await monitorSettledBackgroundChild(
      [
        { role: 'user', content: 'do the work' },
        { role: 'error', content: 'transient provider hiccup' },
      ],
      { processing: true },
    )

    expect(result.status).toBe('running')
  })
})
