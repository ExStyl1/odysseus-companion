/**
 * F1.401 (origin: the WJ-ff verifier on F1.263) — a turn's end declines only the
 * host cards THAT turn raised.
 *
 * ## What was measured first
 *
 * F1.263 made every turn end call `releaseTurnBoundHostCards`, which picked the
 * cards by session id and `releaseOnStop` alone — with no record of which turn
 * raised them. A claude background subagent has no ManagedSession of its own,
 * inherits `mcp__session__Monitor` and `archive_session`, and outlives the parent
 * turn by design (P6.793's `perTaskStopAffordance`), so its card sits on the
 * parent session while no parent turn runs. The verifier's probe P1 raised such a
 * card with `isProcessing` false and let a LATER turn complete: the card was
 * cancelled "because the turn ended" by a turn that never raised it. The arms
 * below are that probe over the four turn-bound raise sites and five ways a later
 * turn ends, before any fix.
 *
 * ## The decision (controller, 2026-09-23) and how much of it the host can see
 *
 * Stamp the raising turn's `processingGeneration` on each resolver entry and
 * release only entries of the ending turn. A card raised while no turn runs
 * belongs to no turn, and no turn end declines it. The decision's second half —
 * "and the SDK agent id when a subagent raised it" — has no source at these raise
 * sites: a session tool reaches the host with the session key and nothing else
 * (the Monitor port is bound to the session; the codex bridge body carries
 * `sessionId` only). What remains is stated where the stamp is written.
 *
 * ## The rig
 *
 * `host-card-user-stop.test.ts`'s, unchanged in kind: the real raise sites, the
 * real turn ends, `sendEvent` as the instrument.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'

import { createTestSessionManager } from './test-session-manager.ts'

type SessionStub = {
  id: string
  workspace: { id: string; rootPath: string }
  isProcessing: boolean
  processingGeneration: number
  [key: string]: unknown
}

function sessionStub(id: string, extra: Record<string, unknown> = {}): SessionStub {
  return {
    id: `session-${id}`,
    activeProvider: 'claude',
    permissionMode: 'default',
    // No turn runs: the call below comes from something that outlived its turn.
    isProcessing: false,
    processingGeneration: 3,
    messages: [],
    messageQueue: [],
    backgroundShellCommands: new Map<string, unknown>(),
    workspace: { id: `workspace-${id}`, rootPath: process.cwd() },
    workingDirectory: process.cwd(),
    ...extra,
  }
}

function harness(...sessions: SessionStub[]) {
  const manager = createTestSessionManager() as any
  manager.persistSession = () => undefined
  manager.emitPiHarnessInvalidation = () => undefined
  for (const session of sessions) {
    manager.sessions.set(
      encodeSessionKey({ workspaceId: session.workspace.id, sessionId: session.id }),
      session,
    )
  }
  return manager
}

function watch(manager: any) {
  const rig = { raised: [] as string[], withdrawn: [] as string[] }
  manager.sendEvent = (event: any) => {
    if (event?.type === 'permission_request_cancelled') { rig.withdrawn.push(event.requestId); return }
    if (event?.type === 'permission_request') rig.raised.push(event.request?.requestId as string)
  }
  return rig
}

async function state(wait: Promise<unknown>): Promise<unknown> {
  return Promise.race([wait, new Promise(resolve => { setTimeout(() => resolve('STILL WAITING'), 30) })])
}

const raiseSettles = () => new Promise<void>(resolve => { setTimeout(resolve, 20) })

type Raised = { manager: any; shownIn: SessionStub; rig: ReturnType<typeof watch>; wait: Promise<unknown>; cleanup?: () => Promise<void> }

function raiseSites(processing: boolean): Array<{ name: string; raise: () => Promise<Raised> }> {
  return [
    {
      name: 'authorizeMonitor (ws)',
      raise: async () => {
        const shownIn = sessionStub(`raising-monitor-ws-${processing}`, { isProcessing: processing })
        const manager = harness(shownIn)
        manager.resolveMonitorTargetHost = async () => 'example.test'
        manager.resolveNetworkAddressesFn = async () => ['93.184.216.34']
        const rig = watch(manager)
        const wait = manager.authorizeMonitor({
          sessionKey: { workspaceId: shownIn.workspace.id, sessionId: shownIn.id },
          ws: { url: 'wss://example.test/feed' },
        }).then(() => 'allowed', (error: Error) => error.message)
        return { manager, shownIn, rig, wait }
      },
    },
    {
      name: 'authorizeMonitorCommand',
      raise: async () => {
        const shownIn = sessionStub(`raising-monitor-command-${processing}`, { isProcessing: processing })
        const manager = harness(shownIn)
        manager.monitorGateSessionIsPi = () => false
        manager.evaluateMonitorCommandRules = () => undefined
        const rig = watch(manager)
        const wait = manager.authorizeMonitorCommand({
          sessionKey: { workspaceId: shownIn.workspace.id, sessionId: shownIn.id },
          command: 'tail -f build.log',
        }).then(() => 'allowed', (error: Error) => error.message)
        return { manager, shownIn, rig, wait }
      },
    },
    {
      name: 'authorizeWorktreeEnter',
      raise: async () => {
        const repoRoot = await mkdtemp(join(tmpdir(), 'f1401-repo-'))
        const shownIn = sessionStub(`raising-worktree-${processing}`, { isProcessing: processing, projectKey: repoRoot, workingDirectory: repoRoot })
        const manager = harness(shownIn)
        const rig = watch(manager)
        const wait = manager.authorizeWorktreeEnter(shownIn, { path: join(tmpdir(), 'f1401-elsewhere') })
          .then(() => 'allowed', (error: Error) => error.message)
        return { manager, shownIn, rig, wait, cleanup: () => rm(repoRoot, { recursive: true, force: true }) }
      },
    },
    {
      name: 'archiveSessionForAgent',
      raise: async () => {
        const shownIn = sessionStub(`raising-archive-caller-${processing}`, { isProcessing: processing })
        const target = sessionStub(`raising-archive-target-${processing}`, { workspace: shownIn.workspace, isArchived: false })
        const manager = harness(shownIn, target)
        manager.archiveSession = async () => undefined
        const rig = watch(manager)
        const wait = manager.archiveSessionForAgent(shownIn, target.id, true)
          .then((verdict: { status: string; note?: string }) => (verdict.status === 'applied' ? 'allowed' : `${verdict.status}: ${verdict.note}`), (error: Error) => error.message)
        return { manager, shownIn, rig, wait }
      },
    },
  ]
}

/** A LATER turn starts (as `sendMessage` does: the generation moves first) and ends. */
const laterTurnEnds: Array<{ name: string; end: (manager: any, shownIn: SessionStub) => Promise<unknown> }> = [
  { name: 'completes', end: (m, s) => m.onProcessingStopped(s.id, 'complete', s.workspace.id) },
  { name: 'errors', end: (m, s) => m.onProcessingStopped(s.id, 'error', s.workspace.id) },
  { name: 'times out', end: (m, s) => m.onProcessingStopped(s.id, 'timeout', s.workspace.id) },
  { name: 'is stopped by the user', end: (m, s) => m.cancelProcessing(s.id, false, s.workspace.id) },
  {
    name: 'hands off to an auth request',
    end: async (m, s) => {
      s.agent = { interruptForHandoff: () => undefined }
      await m.beginAuthRequest(s, {
        type: 'oauth', provider: 'github', requestId: `f1401-auth-${s.id}`, sessionId: s.id, sourceSlug: 'github', sourceName: 'GitHub',
      })
    },
  },
]

describe('F1.401 — a card raised while no turn runs is not declined by a later turn\'s end', () => {
  for (const site of raiseSites(false)) {
    for (const ending of laterTurnEnds) {
      test(`${site.name}: raised between turns, a later turn ${ending.name} → the card stays up and answerable`, async () => {
        const { manager, shownIn, rig, wait, cleanup } = await site.raise()
        try {
          await raiseSettles()
          expect(rig.raised).toHaveLength(1)
          const requestId = rig.raised[0]!
          expect(manager.awaitingApprovalCount(shownIn)).toBe(1)

          shownIn.processingGeneration += 1
          shownIn.isProcessing = true
          await ending.end(manager, shownIn)
          shownIn.isProcessing = false
          shownIn.stopRequested = false

          expect({
            count: manager.awaitingApprovalCount(shownIn),
            resolverLeft: manager.directPermissionResolvers.has(requestId),
            withdrawn: rig.withdrawn,
            after: await state(wait),
          }).toEqual({ count: 1, resolverLeft: true, withdrawn: [], after: 'STILL WAITING' })
          // The person can still answer it, and the answer is theirs.
          manager.respondToPermission(shownIn.id, requestId, true, false, undefined, shownIn.workspace.id)
          expect(await wait).toBe('allowed')
          expect(manager.awaitingApprovalCount(shownIn)).toBe(0)
        } finally {
          shownIn.isProcessing = false
          shownIn.stopRequested = false
          await cleanup?.()
        }
      })
    }
  }
})

describe('F1.401 — CONTROL: a card raised DURING a turn is still declined by that turn\'s end', () => {
  for (const site of raiseSites(true)) {
    test(`${site.name}: raised mid-turn, the same turn completes → declined, "was cancelled because the turn ended"`, async () => {
      const { manager, shownIn, rig, wait, cleanup } = await site.raise()
      try {
        await raiseSettles()
        expect(rig.raised).toHaveLength(1)
        await manager.onProcessingStopped(shownIn.id, 'complete', shownIn.workspace.id)
        expect({ count: manager.awaitingApprovalCount(shownIn), withdrawn: rig.withdrawn }).toEqual({ count: 0, withdrawn: rig.raised.slice(0, 1) })
        const after = await state(wait)
        expect(after).not.toBe('STILL WAITING')
        expect(after).not.toBe('allowed')
        expect(String(after)).toContain('was cancelled because the turn ended')
      } finally {
        shownIn.isProcessing = false
        shownIn.stopRequested = false
        await cleanup?.()
      }
    })
  }
})
