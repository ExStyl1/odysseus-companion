/**
 * UA8.3 — the script action's approval on the wire (ours; spec §15 item 3): `automations:get` carries each saved
 * script action with its ledger state, `automations:approveScript` records the person's approval of the SAVED
 * action's current bytes (the digest the row showed), and history carries the host's refusal reason.
 *
 * - positive: GET shows `unapproved` with the current digest; approving that digest records a MACed ledger entry, after
 *   which GET shows `approved` and the Test button runs the script (the reader `runApprovedScript` accepts the writer's
 *   shape);
 * - negative: a digest other than the current bytes is refused and records nothing; a non-script or missing action
 *   is refused; a caller bound to another workspace is refused (`automations-workspace-mismatch`) and records nothing;
 *   a refused run's history entry carries the refusal reason, while a script's own failure output is not forwarded.
 * Harness shape from `automations-script-test.test.ts` (UA8.1).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import type { SafeAutomationHistoryEntry, SafeAutomationsConfig, SafeScriptAutomationAction, TestAutomationResult } from '@nessy-agent/shared/protocol'
import { SCRIPT_APPROVAL_KIND, scriptApprovalSubject } from '@nessy-agent/shared/automations'
import { findHostApproval, setHostApprovalsKeyProvider } from '@nessy-agent/shared/approvals/host-approvals'
// UA12.129 — same gate finding as automations-script-test.test.ts, hidden behind gate 11's REFUSED: the hand-written
// 180_000 becomes the family's shared hook budget (this hook pays the same two dynamic imports; the floor it was
// sized from is the sibling's ~40 s reading of 2026-10-02, 0.07 of 600 000).
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'
import type { HandlerDeps } from '../../handler-deps'
import type { HandlerFn, RequestContext, RpcServer } from '../../../transport/types'

const KEY = randomBytes(32)
let tempDir = ''
let workspaceRoot = ''

// Module graph priced once, as in automations-script-test.test.ts.
beforeAll(async () => {
  await import('../automations')
  await import('@nessy-agent/shared/automations')
}, MODULE_GRAPH_HOOK_BUDGET_MS)

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'automations-approve-script-'))
  workspaceRoot = join(tempDir, 'workspace')
  mkdirSync(workspaceRoot, { recursive: true })
  setHostApprovalsKeyProvider({ getKey: async () => KEY })
})

afterEach(() => {
  setHostApprovalsKeyProvider(undefined)
  if (tempDir) rmSync(tempDir, { recursive: true, force: true })
})

const ACTION = { type: 'script' as const, script: 'probe.ts', runtime: 'bun' as const }

function save(actions: unknown[]): void {
  writeFileSync(join(workspaceRoot, 'automations.json'), JSON.stringify({
    version: 2,
    automations: { SchedulerTick: [{ id: 'm-script', cron: '0 9 * * *', actions }] },
  }, null, 2))
}

function ctx(workspaceId = 'workspace-1'): RequestContext {
  return { clientId: 'client-1', workspaceId, webContentsId: null }
}

async function harness() {
  const handlers = new Map<string, HandlerFn>()
  const logger = { info() {}, warn() {}, error() {}, debug() {} }
  const server = {
    handle(channel: string, handler: HandlerFn) { handlers.set(channel, handler) },
    push() {},
    async invokeClient() { return undefined },
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  } as unknown as RpcServer
  const deps = {
    platform: { logger },
    sessionManager: {},
    workspaceService: {
      resolve(workspaceId: string) {
        if (workspaceId !== 'workspace-1') throw new Error('Workspace not found')
        return { id: workspaceId, workspaceRootPath: workspaceRoot, sessionRootPath: join(tempDir, 'sessions'), config: { id: workspaceId, name: 'One', createdAt: 1, updatedAt: 1 }, lastAccessedAt: 1 }
      },
    },
  } as unknown as HandlerDeps
  const { registerAutomationsHandlers } = await import('../automations')
  registerAutomationsHandlers(server, deps)
  const call = async <T>(channel: string, ...args: unknown[]): Promise<T> => await handlers.get(channel)!(ctx(), ...args) as T
  return { handlers, call }
}

async function scriptRow(call: Awaited<ReturnType<typeof harness>>['call']): Promise<SafeScriptAutomationAction> {
  const config = await call<SafeAutomationsConfig>(RPC_CHANNELS.automations.GET, 'workspace-1')
  return config.automations.SchedulerTick![0]!.actions[0] as SafeScriptAutomationAction
}

describe('automations:approveScript and the script row on the wire (UA8.3)', () => {
  it('positive: GET shows unapproved + digest; approving that digest records the ledger entry, GET shows approved, and Test runs it', async () => {
    const { call } = await harness()
    writeFileSync(join(workspaceRoot, ACTION.script), 'console.log("approved run")')
    save([ACTION])
    const before = await scriptRow(call)
    expect(before).toMatchObject({ type: 'script', script: 'probe.ts', runtime: 'bun' })
    expect(before.approval?.state).toBe('unapproved')
    expect(before.approval?.sha256).toMatch(/^[0-9a-f]{64}$/)

    const approved = await call<{ state: string }>(RPC_CHANNELS.automations.APPROVE_SCRIPT, 'workspace-1', 'm-script', 0, before.approval!.sha256)
    expect(approved.state).toBe('approved')
    expect(findHostApproval(workspaceRoot, KEY, SCRIPT_APPROVAL_KIND, scriptApprovalSubject(ACTION))?.digest).toBe(before.approval!.sha256)
    expect((await scriptRow(call)).approval?.state).toBe('approved')

    const test = await call<TestAutomationResult>(RPC_CHANNELS.automations.TEST, { workspaceId: 'workspace-1', automationId: 'm-script', actions: [] })
    expect(test.actions[0]).toMatchObject({ type: 'script', success: true, stdout: 'approved run' })
  })

  it('negative: a swapped digest, a non-script action and a missing action are refused and record nothing', async () => {
    const { call } = await harness()
    writeFileSync(join(workspaceRoot, ACTION.script), 'console.log("v1")')
    save([ACTION, { type: 'webhook', url: 'https://example.invalid/x' }])
    const shown = (await scriptRow(call)).approval!.sha256!
    writeFileSync(join(workspaceRoot, ACTION.script), 'console.log("swapped")')
    await expect(call(RPC_CHANNELS.automations.APPROVE_SCRIPT, 'workspace-1', 'm-script', 0, shown)).rejects.toThrow('changed while it was being reviewed')
    await expect(call(RPC_CHANNELS.automations.APPROVE_SCRIPT, 'workspace-1', 'm-script', 1)).rejects.toThrow('Script action not found')
    await expect(call(RPC_CHANNELS.automations.APPROVE_SCRIPT, 'workspace-1', 'nope', 0)).rejects.toThrow('Script action not found')
    expect(findHostApproval(workspaceRoot, KEY, SCRIPT_APPROVAL_KIND, scriptApprovalSubject(ACTION))).toBeUndefined()
  })

  it('negative: a caller bound to another workspace is refused and records nothing', async () => {
    const { handlers } = await harness()
    writeFileSync(join(workspaceRoot, ACTION.script), 'console.log("v1")')
    save([ACTION])
    await expect(Promise.resolve(handlers.get(RPC_CHANNELS.automations.APPROVE_SCRIPT)!(ctx('ws-elsewhere'), 'workspace-1', 'm-script', 0)))
      .rejects.toThrow('automations-workspace-mismatch')
    expect(findHostApproval(workspaceRoot, KEY, SCRIPT_APPROVAL_KIND, scriptApprovalSubject(ACTION))).toBeUndefined()
  })

  it('negative: a refused run\'s history carries the host\'s reason; a script\'s own failure output is not forwarded', async () => {
    const { call } = await harness()
    writeFileSync(join(workspaceRoot, ACTION.script), 'console.log("never approved")')
    save([ACTION])
    await call(RPC_CHANNELS.automations.TEST, { workspaceId: 'workspace-1', automationId: 'm-script', actions: [] })
    writeFileSync(join(workspaceRoot, 'automations-history.jsonl'), [
      JSON.stringify({ id: 'm-script', ts: 2, ok: false, script: { script: 'probe.ts', exitCode: 1, durationMs: 5, error: 'TOKEN=secret-ish output' } }),
    ].join('\n') + '\n', { flag: 'a' })
    const history = await call<SafeAutomationHistoryEntry[]>(RPC_CHANNELS.automations.GET_HISTORY, 'workspace-1', 'm-script')
    const refused = history.find(entry => entry.script?.blocked)
    expect(refused?.error).toContain('Script not approved')
    const failed = history.find(entry => entry.ts === 2)
    expect(failed?.script).toMatchObject({ script: 'probe.ts', exitCode: 1 })
    expect(failed?.error).toBe('Automation failed')
  })
})
