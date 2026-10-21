/**
 * F1.369 (a) (origin WJ-hh P-WJ-hh-3; closes F1.275, WJ-z P-WJ-z-4) — tearing a
 * claude or codex session's agent runtime down takes that runtime's question
 * dialogs off the host.
 *
 * ## What was wrong
 *
 * The non-Pi runtimes put a question on the host through the shared ask-user
 * bridge (`agent/elicitation-ask-user.ts`): an MCP server's elicitation
 * (`mcp-elicit-…`, `BaseAgent.elicitationAsk`) and the model's own question
 * (`claude-ask-…`, `codex-ask-…`, `modelQuestionAsk`). The host keeps a record of
 * each card (`pendingPermissionRequests`) and the card on screen. When
 * `disposeManagedAgentRuntime` tore the runtime down — the idle reaper, the
 * live-agent ceiling, an auth retry, a runtime restart — nothing on the host
 * removed those records: `clearPendingPermissionRequestsForSession` is called
 * only by a Pi drain, a runtime switch, a rewind and a delete, and the backend's
 * own withdrawal had no channel outside a turn (F1.275). So the card stayed on
 * screen, counted in `awaitingApprovalCount`, and its click answered a bridge
 * that no longer existed.
 *
 * ## The two halves pinned here
 *
 * - the SWEEP: after the agent is disposed, every pending `ask_user` record of
 *   this session whose id carries one of the bridges' prefixes is removed and the
 *   renderer is sent `permission_request_cancelled` — the prefixes read from the
 *   three `idPrefix:` literals in the backends, so a fourth bridge goes red here;
 * - the WIRING: `onPermissionRequestWithdrawn` (F1.369 (b)) reaches
 *   `processEvent`'s `permission_request_cancelled` arm, so a dialog withdrawn
 *   between turns leaves the host with the session alive, and a teardown whose
 *   agent already withdrew its card sends ONE cancellation, not two.
 *
 * ## NEGATIVES
 *
 * An answered card (no longer pending) is not re-cancelled; Pi's durable
 * `ask_user` (its ids are not the bridges') is untouched; a non-question card and
 * another session's question survive.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'

import { createTestSessionManager } from './test-session-manager.ts'

type SessionStub = {
  id: string
  workspace: { id: string; rootPath: string }
  agent: unknown
  [key: string]: unknown
}

function sessionStub(id: string, extra: Record<string, unknown> = {}): SessionStub {
  return {
    id: `session-${id}`,
    activeProvider: 'codex',
    permissionMode: 'default',
    isProcessing: false,
    processingGeneration: 1,
    messages: [],
    messageQueue: [],
    backgroundShellCommands: new Map<string, unknown>(),
    workspace: { id: 'workspace-f1369', rootPath: process.cwd() },
    workingDirectory: process.cwd(),
    agent: null,
    ...extra,
  }
}

function harness(...sessions: SessionStub[]) {
  const manager = createTestSessionManager() as any
  manager.persistSession = () => undefined
  manager.emitPiHarnessInvalidation = () => undefined
  for (const session of sessions) {
    manager.sessions.set(encodeSessionKey({ workspaceId: session.workspace.id, sessionId: session.id }), session)
  }
  const rig = { raised: [] as string[], withdrawn: [] as string[] }
  manager.sendEvent = (event: any) => {
    if (event?.type === 'permission_request_cancelled') { rig.withdrawn.push(event.requestId); return }
    if (event?.type === 'permission_request') rig.raised.push(event.request?.requestId as string)
  }
  return { manager, rig }
}

/** Raise a question card the way a backend's `onPermissionRequest` does. */
function raiseQuestion(manager: any, session: SessionStub, requestId: string): void {
  manager.handleAgentPermissionRequest(session, {
    requestId,
    toolName: 'ask_user',
    type: 'ask_user',
    command: 'Which workspace should I connect?',
    description: 'Which workspace should I connect?',
    askUser: { question: 'Which workspace should I connect?', options: ['personal', 'team'], allowFreeText: false },
  })
}

function raiseBash(manager: any, session: SessionStub, requestId: string): void {
  manager.handleAgentPermissionRequest(session, {
    requestId, toolName: 'Bash', type: 'bash', command: 'ls', description: 'ls',
  })
}

/** Every teardown step past the sweep is out of scope here; a throw from one is not this row's reading. */
async function dispose(manager: any, session: SessionStub, reason: string): Promise<void> {
  await manager.disposeManagedAgentRuntime(session, reason).catch(() => undefined)
}

const repo = (relative: string) => readFileSync(new URL(`../../../../../${relative}`, import.meta.url), 'utf8')

/** The bridges' id prefixes, read from the backends rather than restated. */
const BRIDGE_PREFIXES = [
  'packages/shared/src/agent/base-agent.ts',
  'packages/shared/src/agent/claude-agent.ts',
  'packages/shared/src/agent/codex-agent.ts',
].flatMap(file => [...repo(file).matchAll(/idPrefix: '([a-z-]+)'/g)].map(match => match[1]!))

describe('F1.369 (a) — a runtime teardown takes that runtime\'s question dialogs off the host', () => {
  test('the three bridges are the ones the backends construct', () => {
    expect([...BRIDGE_PREFIXES].sort()).toEqual(['claude-ask', 'codex-ask', 'mcp-elicit'])
  })

  for (const prefix of BRIDGE_PREFIXES) {
    for (const reason of ['idle-agent reaper', 'auth retry', 'runtime config refresh']) {
      test(`${prefix}: disposeManagedAgentRuntime(…, '${reason}') removes the record, the count and the card`, async () => {
        const session = sessionStub(`${prefix}-${reason.replace(/\W+/g, '-')}`)
        const { manager, rig } = harness(session)
        const requestId = `${prefix}-1700000000000-1`
        raiseQuestion(manager, session, requestId)
        expect(rig.raised).toEqual([requestId])
        expect(manager.awaitingApprovalCount(session)).toBe(1)

        await dispose(manager, session, reason)

        expect({
          pending: manager.pendingPermissionRequests.has(requestId),
          count: manager.awaitingApprovalCount(session),
          withdrawn: rig.withdrawn,
        }).toEqual({ pending: false, count: 0, withdrawn: [requestId] })
      })
    }
  }
})

describe('F1.369 — the out-of-turn channel reaches the host', () => {
  test('a dialog the backend withdraws BETWEEN turns leaves the host with the session alive', () => {
    const agent: Record<string, unknown> = {}
    const session = sessionStub('between-turns', { agent })
    const { manager, rig } = harness(session)
    manager.wireOutOfTurnCardWithdrawal(session)
    const requestId = 'mcp-elicit-1700000000000-7'
    raiseQuestion(manager, session, requestId)

    ;(agent.onPermissionRequestWithdrawn as (id: string) => void)(requestId)

    expect({
      pending: manager.pendingPermissionRequests.has(requestId),
      count: manager.awaitingApprovalCount(session),
      withdrawn: rig.withdrawn,
    }).toEqual({ pending: false, count: 0, withdrawn: [requestId] })
  })

  test('a teardown whose agent already withdrew its card sends ONE cancellation, not two', async () => {
    const requestId = 'codex-ask-1700000000000-3'
    const agent: Record<string, unknown> = {
      setCapabilityTurnRuntime: () => undefined,
      setAutomationSystem: () => undefined,
      dispose: () => { (agent.onPermissionRequestWithdrawn as (id: string) => void)(requestId) },
    }
    const session = sessionStub('withdrawn-by-dispose', { agent })
    const { manager, rig } = harness(session)
    manager.wireOutOfTurnCardWithdrawal(session)
    raiseQuestion(manager, session, requestId)

    await dispose(manager, session, 'idle-agent reaper')

    expect(rig.withdrawn).toEqual([requestId])
    expect(manager.pendingPermissionRequests.has(requestId)).toBe(false)
  })
})

describe('F1.369 — NEGATIVES: what a teardown leaves', () => {
  test('an ANSWERED question is not re-cancelled', async () => {
    const session = sessionStub('answered')
    const { manager, rig } = harness(session)
    const requestId = 'claude-ask-1700000000000-2'
    raiseQuestion(manager, session, requestId)
    manager.removePendingPermissionRequest(session, requestId, 'ask_user')

    await dispose(manager, session, 'idle-agent reaper')

    expect(rig.withdrawn).toEqual([])
  })

  test('Pi\'s durable ask_user, a command card and another session\'s question survive', async () => {
    const disposed = sessionStub('disposed', { activeProvider: 'pi' })
    const other = sessionStub('other')
    const { manager, rig } = harness(disposed, other)
    raiseQuestion(manager, disposed, 'pi-ask-1700000000000-abc123')
    raiseQuestion(manager, disposed, 'askuser-host-durable-1')
    raiseBash(manager, disposed, 'codex-approval-1')
    raiseQuestion(manager, other, 'codex-ask-1700000000000-9')

    await dispose(manager, disposed, 'idle-agent reaper')

    expect(rig.withdrawn).toEqual([])
    for (const id of ['pi-ask-1700000000000-abc123', 'askuser-host-durable-1', 'codex-approval-1', 'codex-ask-1700000000000-9']) {
      expect(manager.pendingPermissionRequests.has(id)).toBe(true)
    }
  })
})
