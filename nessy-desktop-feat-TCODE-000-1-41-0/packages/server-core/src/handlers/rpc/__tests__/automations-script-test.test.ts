/**
 * UA8.1 — "Run test" of a saved script action goes through `runApprovedScript` (the one script entry), so the Test
 * button follows the automation's rule: an approved script runs, a changed one does not, and a script action the
 * client sends without its saved automation is refused. Harness shape from `automations-management.test.ts`.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import type { TestAutomationResult } from '@nessy-agent/shared/protocol'
import {
  SCRIPT_APPROVAL_KIND,
  scriptApprovalRecord,
  scriptApprovalSubject,
  scriptSha256,
  type ScriptAction,
} from '@nessy-agent/shared/automations'
import { recordHostApproval, setHostApprovalsKeyProvider } from '@nessy-agent/shared/approvals/host-approvals'
// UA12.129 — the hand-written 180_000 was a numeric literal nothing can re-derive (the module-graph gate's own
// finding, invisible while gate 11's REFUSED stood): this IS the hook shape — a beforeAll paying dynamic imports —
// so it takes the family's shared hook budget. The floor it was sized from (~40 s, 2026-10-02, load 8.9) is 0.07 of
// 600 000; one budget covering the family's largest member is the point of the shared module.
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'
import type { HandlerDeps } from '../../handler-deps'
import type { HandlerFn, RequestContext, RpcServer } from '../../../transport/types'

const KEY = randomBytes(32)
let tempDir = ''
let workspaceRoot = ''

// The handler's module graph (shared automations + the server-core handler) is priced ONCE here rather than inside
// the first test's 5 s budget: measured 2026-10-02 at ~40 s for the first test on a loaded rig (load average 8.9),
// 15 ms and 4 ms for the next two (AGENTS.md: a timeout with zero assertion failures is usually the module graph).
beforeAll(async () => {
  await import('../automations')
  await import('@nessy-agent/shared/automations')
}, MODULE_GRAPH_HOOK_BUDGET_MS)

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'automations-script-test-'))
  workspaceRoot = join(tempDir, 'workspace')
  mkdirSync(workspaceRoot, { recursive: true })
  setHostApprovalsKeyProvider({ getKey: async () => KEY })
})

afterEach(() => {
  setHostApprovalsKeyProvider(undefined)
  if (tempDir) rmSync(tempDir, { recursive: true, force: true })
  tempDir = ''
  workspaceRoot = ''
})

const ACTION: ScriptAction = { type: 'script', script: 'probe.ts', runtime: 'bun' }

function writeProbe(source: string): void {
  writeFileSync(join(workspaceRoot, ACTION.script), source)
}

function approveCurrentBytes(): void {
  recordHostApproval(workspaceRoot, KEY, {
    kind: SCRIPT_APPROVAL_KIND,
    subject: scriptApprovalSubject(ACTION),
    ...scriptApprovalRecord(ACTION, scriptSha256(readFileSync(join(workspaceRoot, ACTION.script)))),
  })
}

function saveAutomation(): void {
  writeFileSync(join(workspaceRoot, 'automations.json'), JSON.stringify({
    version: 2,
    automations: { SchedulerTick: [{ id: 'm-script', cron: '0 9 * * *', actions: [ACTION] }] },
  }, null, 2))
}

async function runTest(handlers: Map<string, HandlerFn>, automationId?: string, actions: unknown[] = []): Promise<TestAutomationResult> {
  return await handlers.get(RPC_CHANNELS.automations.TEST)!(ctx(), {
    workspaceId: 'workspace-1',
    ...(automationId ? { automationId } : {}),
    actions,
  }) as TestAutomationResult
}

describe('automations TEST — a saved script action (UA8.1)', () => {
  it('positive: an approved saved script runs through the Test button and its run is recorded in history', async () => {
    const { handlers } = await createHarness()
    writeProbe('console.log("tested")')
    approveCurrentBytes()
    saveAutomation()
    const result = await runTest(handlers, 'm-script')
    expect(result.actions).toHaveLength(1)
    expect(result.actions[0]).toMatchObject({ type: 'script', success: true, exitCode: 0, stdout: 'tested' })
    const history = readFileSync(join(workspaceRoot, 'automations-history.jsonl'), 'utf-8').trim().split('\n').map(line => JSON.parse(line))
    expect(history.at(-1)).toMatchObject({ id: 'm-script', ok: true })
  })

  it('negative: a changed digest does not run from Test either', async () => {
    const { handlers } = await createHarness()
    writeProbe('console.log("v1")')
    approveCurrentBytes()
    saveAutomation()
    writeProbe(`require('node:fs').writeFileSync(${JSON.stringify(join(workspaceRoot, 'ran'))}, 'x')`)
    const result = await runTest(handlers, 'm-script')
    const only = result.actions[0] as { type: string; success: boolean; blocked?: boolean; error?: string }
    expect(only.type).toBe('script')
    expect(only.success).toBe(false)
    expect(only.blocked).toBe(true)
    expect(only.error).toContain('changed since it was approved')
    expect(existsSync(join(workspaceRoot, 'ran'))).toBe(false)
  })

  it('negative: a script action sent in the payload without its saved automation is refused', async () => {
    const { handlers } = await createHarness()
    writeProbe(`require('node:fs').writeFileSync(${JSON.stringify(join(workspaceRoot, 'ran'))}, 'x')`)
    approveCurrentBytes()
    const result = await runTest(handlers, undefined, [ACTION])
    const only = result.actions[0] as { type: string; success: boolean; error?: string }
    expect(only).toMatchObject({ type: 'script', success: false })
    expect(only.error).toContain('saved automation')
    expect(existsSync(join(workspaceRoot, 'ran'))).toBe(false)
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
