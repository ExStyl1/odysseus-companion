import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import { resolveAutomationsConfigPath } from '@nessy-agent/shared/automations'
import type { AutomationCreateInput, AutomationUpdateInput } from '@nessy-agent/shared/automations'
import type { HandlerDeps } from '../../handler-deps'
import type { HandlerFn, RequestContext, RpcServer } from '../../../transport/types'

let tempDir = ''
let workspaceRoot = ''
const originalFetch = globalThis.fetch

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'automations-rpc-test-'))
  workspaceRoot = join(tempDir, 'workspace')
})

afterEach(() => {
  globalThis.fetch = originalFetch
  if (tempDir) rmSync(tempDir, { recursive: true, force: true })
  tempDir = ''
  workspaceRoot = ''
})

describe('registerAutomationsHandlers management', () => {
  it('redacts saved webhook execution data from GET without changing the stored definition', async () => {
    const { handlers } = await createHarness()
    const created = await handlers.get(RPC_CHANNELS.automations.CREATE)!(
      ctx(),
      'workspace-1',
      {
        kind: 'event',
        event: 'LabelAdd',
        actions: [{
          type: 'webhook',
          url: 'https://example.test/hook',
          method: 'POST',
          headers: { Authorization: 'secret-header' },
          bodyFormat: 'json',
          body: { secret: 'request-body' },
          captureResponse: true,
          auth: { type: 'basic', username: 'user', password: 'secret-password' },
        }],
      } satisfies AutomationCreateInput,
    ) as { automationId: string }

    await handlers.get(RPC_CHANNELS.automations.UPDATE)!(
      ctx(),
      'workspace-1',
      {
        automationId: created.automationId,
        patch: {
          actions: [
            {
              type: 'webhook',
              url: 'https://example.test/basic?token=get-secret',
              method: 'POST',
              headers: { Authorization: 'updated-secret-header' },
              bodyFormat: 'json',
              body: { secret: 'updated-request-body' },
              captureResponse: true,
              auth: { type: 'basic', username: 'user', password: 'updated-secret-password' },
            },
            {
              type: 'webhook',
              url: 'malformed-secret-token-value',
              auth: { type: 'bearer', token: 'secret-token' },
            },
          ],
        },
      } satisfies AutomationUpdateInput,
    )

    const response = await handlers.get(RPC_CHANNELS.automations.GET)!(
      ctx(),
      'workspace-1',
    ) as { automations: Record<string, Array<{ actions: Array<Record<string, unknown>> }>> }
    expect(response.automations.LabelAdd![0]!.actions).toEqual([
      {
        type: 'webhook',
        url: 'https://example.test/basic',
        method: 'POST',
        bodyFormat: 'json',
        captureResponse: true,
      },
      {
        type: 'webhook',
        url: '[redacted]',
      },
    ])

    const storedAction = readConfig().automations.LabelAdd![0]!.actions as Array<Record<string, unknown>>
    expect(storedAction).toEqual([
      {
        type: 'webhook',
        url: 'https://example.test/basic?token=get-secret',
        method: 'POST',
        headers: { Authorization: 'updated-secret-header' },
        bodyFormat: 'json',
        body: { secret: 'updated-request-body' },
        captureResponse: true,
        auth: { type: 'basic', username: 'user', password: 'updated-secret-password' },
      },
      {
        type: 'webhook',
        url: 'malformed-secret-token-value',
        auth: { type: 'bearer', token: 'secret-token' },
      },
    ])
    expect(JSON.stringify(response)).not.toContain('get-secret')
    expect(JSON.stringify(response)).not.toContain('malformed-secret-token-value')
  })

  it('tests a saved automation from its raw server definition', async () => {
    const { handlers, executePromptAutomation } = await createHarness()
    const created = await handlers.get(RPC_CHANNELS.automations.CREATE)!(
      ctx(),
      'workspace-1',
      {
        kind: 'event',
        event: 'LabelAdd',
        actions: [
          { type: 'decision', decision: 'allow' },
          { type: 'prompt', prompt: 'server-owned prompt' },
        ],
      } satisfies AutomationCreateInput,
    ) as { automationId: string }

    await handlers.get(RPC_CHANNELS.automations.TEST)!(ctx(), {
      workspaceId: 'workspace-1',
      automationId: created.automationId,
      actions: [{ type: 'prompt', prompt: 'renderer placeholder' }],
    })

    expect(executePromptAutomation).toHaveBeenCalledTimes(1)
    expect(executePromptAutomation.mock.calls[0]?.[0]).toMatchObject({
      prompt: 'server-owned prompt',
      matcherId: created.automationId,
    })
  })

  it('tests a saved webhook with raw server data but returns no raw webhook secret', async () => {
    const fetchMock = mock(async (_input: string | URL | Request, _init?: RequestInit) => (
      new Response('secret-response', { status: 200 })
    ))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const { handlers } = await createHarness()
    const created = await handlers.get(RPC_CHANNELS.automations.CREATE)!(
      ctx(),
      'workspace-1',
      {
        kind: 'event',
        event: 'LabelAdd',
        actions: [{
          type: 'webhook',
          url: 'https://example.test/secret-hook?token=url-secret',
          headers: { 'X-Secret': 'secret-header' },
          bodyFormat: 'json',
          body: { secret: 'secret-body' },
          captureResponse: true,
          auth: { type: 'bearer', token: 'secret-token' },
        }],
      } satisfies AutomationCreateInput,
    ) as { automationId: string; event: string; matcherIndex: number }

    const result = await handlers.get(RPC_CHANNELS.automations.TEST)!(ctx(), {
      workspaceId: 'workspace-1',
      automationId: created.automationId,
      actions: [{ type: 'webhook', url: 'https://renderer.invalid/redacted' }],
    }) as { actions: Array<Record<string, unknown>> }

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://example.test/secret-hook?token=url-secret')
    expect(result.actions[0]?.url).toBe('https://example.test/secret-hook')
    expect(JSON.stringify(result)).not.toContain('url-secret')
    expect(JSON.stringify(result)).not.toContain('secret-header')
    expect(JSON.stringify(result)).not.toContain('secret-body')
    expect(JSON.stringify(result)).not.toContain('secret-token')
    expect(JSON.stringify(result)).not.toContain('secret-response')
  })

  it('returns renderer-safe automation history while preserving raw stored history', async () => {
    const { handlers } = await createHarness()
    const created = await createEventAutomation(handlers)
    const rawEntry = {
      id: created.automationId,
      ts: 123,
      ok: false,
      sessionId: 'session-1',
      prompt: 'prompt-secret',
      error: 'top-level-secret',
      webhook: {
        method: 'POST',
        url: 'https://example.test/hook?token=query-secret',
        statusCode: 401,
        durationMs: 42,
        attempts: 2,
        // UB4.27 passes these two to the timeline on purpose (upstream v0.15.1 carries
        // both; the host caps them at write), so they are not the secrets pinned below.
        error: 'webhook-failure',
        responseBody: 'response-body',
      },
    }
    const historyPath = join(workspaceRoot, 'automations-history.jsonl')
    const rawHistory = `${JSON.stringify(rawEntry)}\n`
    writeFileSync(historyPath, rawHistory)

    const result = await handlers.get(RPC_CHANNELS.automations.GET_HISTORY)!(
      ctx(),
      'workspace-1',
      created.automationId,
    )

    expect(result).toEqual([{
      id: created.automationId,
      ts: 123,
      ok: false,
      sessionId: 'session-1',
      error: 'Automation failed',
      webhook: {
        method: 'POST',
        url: 'https://example.test/hook',
        statusCode: 401,
        durationMs: 42,
        attempts: 2,
        error: 'webhook-failure',
        responseBody: 'response-body',
      },
    }])
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(readFileSync(historyPath, 'utf8')).toBe(rawHistory)
  })

  // UB12.20 — the loop guard's arm code reaches the renderer so the timeline can
  // localise the reason; only a code the renderer has a key for passes.
  it('passes a loop-guard skip\'s arm code to the renderer, and drops an unknown or absent one', async () => {
    const { handlers } = await createHarness()
    const created = await createEventAutomation(handlers)
    const skipped = { id: created.automationId, ok: true, skipped: 'the event is about a session this automation created (loop guard)' }
    writeFileSync(join(workspaceRoot, 'automations-history.jsonl'), [
      { ...skipped, ts: 1, skippedLoopGuard: 'self-trigger' },
      { ...skipped, ts: 2, skippedLoopGuard: 'chain-depth' },
      { ...skipped, ts: 3, skippedLoopGuard: 'not-a-code' },
      { ...skipped, ts: 4 }, // a row written before UB12.20
    ].map(row => JSON.stringify(row)).join('\n') + '\n')

    const result = await handlers.get(RPC_CHANNELS.automations.GET_HISTORY)!(
      ctx(),
      'workspace-1',
      created.automationId,
    ) as Array<Record<string, unknown>>

    // Newest first.
    expect(result.map(row => row.ts)).toEqual([4, 3, 2, 1])
    expect(result[3]!.skippedLoopGuard).toBe('self-trigger')
    expect(result[2]!.skippedLoopGuard).toBe('chain-depth')
    expect('skippedLoopGuard' in result[1]!).toBe(false)
    expect('skippedLoopGuard' in result[0]!).toBe(false)
    // The stored English reason passes on every row, so an un-coded one still reads.
    for (const row of result) expect(row.skipped).toBe(skipped.skipped)
  })

  it('replays raw webhook data server-side but returns only safe execution fields', async () => {
    const fetchMock = mock(async (_input: string | URL | Request, _init?: RequestInit) => (
      new Response('response-secret', { status: 401 })
    ))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const { handlers } = await createHarness()
    const created = await handlers.get(RPC_CHANNELS.automations.CREATE)!(
      ctx(),
      'workspace-1',
      {
        kind: 'event',
        event: 'LabelAdd',
        actions: [{
          type: 'webhook',
          url: 'https://example.test/replay?token=query-secret',
          headers: { 'X-Secret': 'header-secret' },
          body: { secret: 'body-secret' },
          captureResponse: true,
          auth: { type: 'bearer', token: 'auth-secret' },
        }],
      } satisfies AutomationCreateInput,
    ) as { automationId: string }

    const result = await handlers.get(RPC_CHANNELS.automations.REPLAY)!(
      ctx(),
      'workspace-1',
      created.automationId,
      'LabelAdd',
    ) as { results: Array<Record<string, unknown>> }

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://example.test/replay?token=query-secret')
    expect(result.results).toEqual([{
      type: 'webhook',
      url: 'https://example.test/replay',
      statusCode: 401,
      success: false,
      error: 'HTTP 401',
      duration: expect.any(Number),
    }])
    expect(JSON.stringify(result)).not.toContain('secret')
  })

  it('creates a scheduled automation through RPC', async () => {
    const { handlers } = await createHarness()

    const result = await handlers.get(RPC_CHANNELS.automations.CREATE)!(
      ctx(),
      'workspace-1',
      {
        kind: 'scheduled',
        cron: '0 9 * * 1-5',
        actions: [{ type: 'prompt', prompt: 'Summarize blockers' }],
      } satisfies AutomationCreateInput,
    ) as { automationId: string; event: string; matcherIndex: number }

    const config = readConfig()
    expect(result.event).toBe('SchedulerTick')
    expect(result.matcherIndex).toBe(0)
    expect(result).toEqual({
      automationId: result.automationId,
      event: 'SchedulerTick',
      matcherIndex: 0,
    })
    expect(config.automations.SchedulerTick![0]!.id).toBe(result.automationId)
  })

  it('updates a matcher by id through RPC', async () => {
    const { handlers } = await createHarness()
    const created = await createEventAutomation(handlers)

    const result = await handlers.get(RPC_CHANNELS.automations.UPDATE)!(
      ctx(),
      'workspace-1',
      {
        automationId: created.automationId,
        patch: { name: 'Urgent responder' },
      } satisfies AutomationUpdateInput,
    ) as { automationId: string; event: string; matcherIndex: number }

    expect(readConfig().automations.LabelAdd![0]!.name).toBe('Urgent responder')
    expect(result).toEqual({
      automationId: created.automationId,
      event: 'LabelAdd',
      matcherIndex: 0,
    })
  })

  it('sets enabled by id through RPC', async () => {
    const { handlers } = await createHarness()
    const created = await createEventAutomation(handlers)

    const result = await handlers.get(RPC_CHANNELS.automations.SET_ENABLED)!(
      ctx(),
      'workspace-1',
      created.automationId,
      false,
    ) as { automationId: string; event: string; matcherIndex: number }

    expect(readConfig().automations.LabelAdd![0]!.enabled).toBe(false)
    expect(result).toEqual({
      automationId: created.automationId,
      event: 'LabelAdd',
      matcherIndex: 0,
    })
  })

  it('duplicates with a new id through RPC', async () => {
    const { handlers } = await createHarness()
    const created = await createEventAutomation(handlers)

    const duplicate = await handlers.get(RPC_CHANNELS.automations.DUPLICATE)!(
      ctx(),
      'workspace-1',
      created.automationId,
    ) as { automationId: string; event: string; matcherIndex: number }

    const matchers = readConfig().automations.LabelAdd
    expect(matchers).toBeDefined()
    expect(matchers).toHaveLength(2)
    expect(duplicate.automationId).not.toBe(created.automationId)
    expect(matchers!.map((matcher) => matcher.id)).toEqual([created.automationId, duplicate.automationId])
    expect(duplicate).toEqual({
      automationId: duplicate.automationId,
      event: 'LabelAdd',
      matcherIndex: 1,
    })
  })

  it('deletes by id and removes an empty event bucket through RPC', async () => {
    const { handlers } = await createHarness()
    const created = await createEventAutomation(handlers)

    await handlers.get(RPC_CHANNELS.automations.DELETE)!(
      ctx(),
      'workspace-1',
      created.automationId,
    )

    expect(readConfig().automations.LabelAdd).toBeUndefined()
  })
})

async function createHarness() {
  const handlers = new Map<string, HandlerFn>()
  const executePromptAutomation = mock(async (_input: unknown) => ({ sessionId: 'automation-session' }))
  const logger = {
    info: mock((_message?: unknown, ..._args: unknown[]) => {}),
    warn: mock((_message?: unknown, ..._args: unknown[]) => {}),
    error: mock((_message?: unknown, ..._args: unknown[]) => {}),
    debug: mock((_message?: unknown, ..._args: unknown[]) => {}),
  }
  const server: RpcServer = {
    handle(channel, handler) {
      handlers.set(channel, handler)
    },
    push() {},
    async invokeClient() {
      return undefined
    },
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  }
  const deps = {
    platform: { logger },
    sessionManager: { executePromptAutomation },
    oauthFlowStore: {},
    workspaceService: {
      resolve(workspaceId: string) {
        if (workspaceId !== 'workspace-1') throw new Error('Workspace not found')
        return {
          id: workspaceId,
          workspaceRootPath: workspaceRoot,
          sessionRootPath: join(tempDir, 'sessions', workspaceId),
          config: { id: workspaceId, name: 'Workspace One', createdAt: 1, updatedAt: 1 },
          lastAccessedAt: 1,
        }
      },
    },
  } as unknown as HandlerDeps

  const { registerAutomationsHandlers } = await import('../automations')
  registerAutomationsHandlers(server, deps)

  return { handlers, executePromptAutomation }
}

function ctx(): RequestContext {
  return { clientId: 'client-1', workspaceId: 'workspace-1', webContentsId: 1 }
}

async function createEventAutomation(handlers: Map<string, HandlerFn>): Promise<{ automationId: string }> {
  return await handlers.get(RPC_CHANNELS.automations.CREATE)!(
    ctx(),
    'workspace-1',
    {
      kind: 'event',
      event: 'LabelAdd',
      matcher: 'urgent',
      actions: [{ type: 'prompt', prompt: 'Draft next steps' }],
    } satisfies AutomationCreateInput,
  ) as { automationId: string }
}

function readConfig(): {
  automations: Record<string, Array<Record<string, unknown>>>;
} {
  return JSON.parse(readFileSync(resolveAutomationsConfigPath(workspaceRoot), 'utf8'))
}

// F1.795 (origin: release sitting SIT-m F8) — the Automations page listed a scheduled automation the managed codex
// policy had declined as "Scheduled", with no note. automations:get now says the policy is on, and the page marks.
describe('automations:get names the managed local-automation policy (F1.795)', () => {
  it('carries managedLocalAutomationDisabled while the codex tier disables local automations, and not otherwise', async () => {
    const { recordCodexLocalAutomationRequirement, resetManagedLocalAutomationForTests } =
      await import('@nessy-agent/shared/config/managed-local-automation')
    const { handlers } = await createHarness()
    await createEventAutomation(handlers)
    try {
      recordCodexLocalAutomationRequirement(true)
      const declined = await handlers.get(RPC_CHANNELS.automations.GET)!(ctx(), 'workspace-1') as Record<string, unknown>
      expect(declined.managedLocalAutomationDisabled).toBe(true)
      recordCodexLocalAutomationRequirement(false)
      const allowed = await handlers.get(RPC_CHANNELS.automations.GET)!(ctx(), 'workspace-1') as Record<string, unknown>
      expect('managedLocalAutomationDisabled' in allowed).toBe(false)
    } finally {
      resetManagedLocalAutomationForTests()
    }
  })
})
