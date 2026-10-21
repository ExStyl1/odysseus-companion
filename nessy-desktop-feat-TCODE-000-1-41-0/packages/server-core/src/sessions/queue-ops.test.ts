import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { QueuedMessageDto, SessionEvent } from '@nessy-agent/shared/protocol'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'

const configDir = mkdtempSync(join(tmpdir(), 'sm-queue-config-'))
const configWorkspaceRoot = join(configDir, 'workspaces', 'queue-workspace')
mkdirSync(configWorkspaceRoot, { recursive: true })
writeFileSync(
  join(configWorkspaceRoot, 'config.json'),
  JSON.stringify({
    id: 'ws-config-queue',
    name: 'Queue Workspace',
    slug: 'queue-workspace',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }, null, 2),
  'utf-8',
)
writeFileSync(
  join(configDir, 'config.json'),
  JSON.stringify({
    workspaces: [{ id: 'ws-config-queue', name: 'Queue Workspace', rootPath: configWorkspaceRoot, createdAt: Date.now() }],
    activeWorkspaceId: 'ws-config-queue',
    activeSessionId: null,
    defaultLlmConnection: 'queue-conn',
    llmConnections: [{
      slug: 'queue-conn',
      name: 'Queue Connection',
      providerType: 'pi',
      authType: 'api_key',
      createdAt: Date.now(),
      midStreamBehavior: 'queue',
    }],
  }, null, 2),
  'utf-8',
)
const originalConfigDir = process.env.NESSY_CONFIG_DIR
process.env.NESSY_CONFIG_DIR = configDir

let createManagedSessionFn: typeof import('./SessionManager.ts')['createManagedSession']
let createTestSessionManagerFn: typeof import('./__tests__/test-session-manager.ts')['createTestSessionManager']

type SessionManagerInstance = InstanceType<typeof import('./SessionManager.ts')['SessionManager']>

type ManagedForTest = {
  isProcessing: boolean
  agent: unknown
  messageQueue: Array<{ message: string; messageId?: string }>
  queuePaused?: boolean
}

type QueueApi = {
  getQueuedMessages(sessionId: string): { queue: QueuedMessageDto[]; paused: boolean }
  deleteQueuedMessage(sessionId: string, messageId: string): void
  sendQueuedNow(sessionId: string, messageId: string): Promise<void>
  resumeQueue(sessionId: string): Promise<void>
}

function queueApi(sm: SessionManagerInstance): QueueApi {
  return sm as unknown as QueueApi
}

function lastEvent<T extends SessionEvent['type']>(
  events: SessionEvent[],
  type: T,
): Extract<SessionEvent, { type: T }> | undefined {
  return events.filter((event): event is Extract<SessionEvent, { type: T }> => event.type === type).at(-1)
}

function nextTick(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

describe('queue ops', () => {
  let tmpRoot: string
  let sm: SessionManagerInstance
  let events: SessionEvent[]

  beforeAll(async () => {
    const mod = await import('./SessionManager.ts')
    createManagedSessionFn = mod.createManagedSession
    createTestSessionManagerFn = (await import('./__tests__/test-session-manager.ts')).createTestSessionManager
  }, MODULE_GRAPH_HOOK_BUDGET_MS)

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-queue-ops-'))
    sm = createTestSessionManagerFn()
    events = []
    const sink = (...args: unknown[]) => {
      events.push(args[2] as SessionEvent)
    }
    sm.setEventSink(sink as Parameters<SessionManagerInstance['setEventSink']>[0])
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  afterAll(() => {
    rmSync(configDir, { recursive: true, force: true })
    if (originalConfigDir === undefined) {
      delete process.env.NESSY_CONFIG_DIR
    } else {
      process.env.NESSY_CONFIG_DIR = originalConfigDir
    }
  })

  function buildSession(id: string): ManagedForTest {
    const workspace = {
      id: 'ws_test',
      name: 'Test Workspace',
      rootPath: tmpRoot,
      createdAt: Date.now(),
    }
    const managed = createManagedSessionFn(
      { id, name: 'queue ops test', llmConnection: 'queue-conn' },
      workspace as never,
      { messagesLoaded: true },
    ) as ManagedForTest
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(`ws_test:${id}`, managed)
    return managed
  }

  async function enqueueMidStream(
    sessionId: string,
    managed: ManagedForTest,
    messages: string[],
  ): Promise<void> {
    managed.isProcessing = true
    for (const message of messages) {
      await sm.sendMessage(sessionId, message)
    }
  }

  it('getQueuedMessages returns queued mid-stream sends with stable ids', async () => {
    const sessionId = 'queue-stable-ids'
    const managed = buildSession(sessionId)

    await enqueueMidStream(sessionId, managed, ['first follow-up', 'second follow-up'])

    const state = queueApi(sm).getQueuedMessages(sessionId)

    expect(state.paused).toBe(false)
    expect(state.queue.map(item => item.text)).toEqual(['first follow-up', 'second follow-up'])
    expect(state.queue.map(item => item.attachmentsCount)).toEqual([0, 0])
    expect(state.queue.every(item => item.id.length > 0)).toBe(true)
    expect(new Set(state.queue.map(item => item.id)).size).toBe(2)
  })

  it('deleteQueuedMessage removes one item and emits queue_changed', async () => {
    const sessionId = 'queue-delete-one'
    const managed = buildSession(sessionId)

    await enqueueMidStream(sessionId, managed, ['delete me', 'keep me'])
    const firstId = managed.messageQueue[0]?.messageId
    expect(firstId).toBeTruthy()

    queueApi(sm).deleteQueuedMessage(sessionId, firstId!)

    const state = queueApi(sm).getQueuedMessages(sessionId)
    expect(state.queue.map(item => item.text)).toEqual(['keep me'])
    const queueChanged = lastEvent(events, 'queue_changed')
    expect(queueChanged?.queue.map(item => item.text)).toEqual(['keep me'])
    expect(queueChanged?.paused).toBe(false)
  })

  it('interrupt pauses queue instead of flushing texts', async () => {
    const sessionId = 'queue-interrupt-pauses'
    const managed = buildSession(sessionId)

    await enqueueMidStream(sessionId, managed, ['stay queued'])
    await sm.cancelProcessing(sessionId)

    const state = queueApi(sm).getQueuedMessages(sessionId)
    expect(state.queue.map(item => item.text)).toEqual(['stay queued'])
    expect(state.paused).toBe(true)
    const queueChanged = lastEvent(events, 'queue_changed')
    expect(queueChanged?.queue.map(item => item.text)).toEqual(['stay queued'])
    expect(queueChanged?.paused).toBe(true)
    expect(lastEvent(events, 'interrupted')).toBeDefined()
  })

  it('resumeQueue unpauses and replays', async () => {
    const sessionId = 'queue-resume'
    const managed = buildSession(sessionId)

    await enqueueMidStream(sessionId, managed, ['resume me'])
    managed.isProcessing = false
    managed.queuePaused = true

    const sent: string[] = []
    ;(sm as unknown as { sendMessage: (id: string, message: string) => Promise<void> }).sendMessage = async (_id, message) => {
      sent.push(message)
    }

    await queueApi(sm).resumeQueue(sessionId)
    await nextTick()

    expect(queueApi(sm).getQueuedMessages(sessionId).paused).toBe(false)
    expect(sent).toEqual(['resume me'])
  })

  it('sendQueuedNow steers when agent.redirect returns true', async () => {
    const sessionId = 'queue-send-now-steer'
    const managed = buildSession(sessionId)
    const redirect = jest.fn(() => true)

    await enqueueMidStream(sessionId, managed, ['steer me'])
    managed.agent = {
      redirect,
      forceAbort: jest.fn(),
    }

    const messageId = managed.messageQueue[0]?.messageId
    expect(messageId).toBeTruthy()

    await queueApi(sm).sendQueuedNow(sessionId, messageId!)

    // F1.238 — the steer carries its transcript id, so a refusal can name it back.
    expect(redirect).toHaveBeenCalledWith('steer me', { messageId })
    expect(queueApi(sm).getQueuedMessages(sessionId).queue).toHaveLength(0)
    expect(lastEvent(events, 'queue_changed')?.queue).toHaveLength(0)
  })
})
