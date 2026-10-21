/**
 * F1.208 (origin WJ-o P-WJ-o-1) — a user Stop declines the host-raised cards
 * that belong to the turn it stops.
 *
 * ## What was read, and what this file measures first
 *
 * WJ-o's F1.186 census (`SessionManager.host-card-withdrawn.test.ts`) left five
 * of `countHostRaisedCard`'s seven callers with no ABORT path: `authorizeMonitor`
 * (ws), `authorizeMonitorCommand`, `authorizeWorktreeEnter`,
 * `archiveSessionForAgent` and `requestDirectShellPermission`. Their resolvers
 * live in `directPermissionResolvers`, and the one sweep that resolves that map —
 * `clearPendingPermissionRequestsForSession` — runs on a Pi drain, a runtime
 * switch, a rewind and a delete, never on a Stop. So the row's reading was: after
 * a Stop the host promise hangs, the card stays up, and `awaitingApprovalCount`
 * stays at 1. The DEFECT arms below are that measurement, taken on the real
 * raise sites and the real `cancelProcessing` before any fix: card raised and
 * counted, Stop, then the count, the resolver map, the withdrawal list and
 * whether the wait settled.
 *
 * ## Which of the five a Stop can reach
 *
 * FOUR are raised from inside a model turn — a tool call the agent made (Monitor,
 * EnterWorktree, archive_session) — and wait on the person while the turn waits
 * on them; a Stop ends that turn, so an answer given afterwards would start a
 * watch, move the working directory or archive a session for a turn nobody is
 * running any more. The FIFTH is not: `runShellCommand` refuses to run while the
 * session is processing, so the composer `!` card is raised only between turns,
 * and `cancelProcessing` returns before doing anything when nothing is
 * processing. If a turn starts while that card is still up, the card is not that
 * turn's, and stopping the turn must leave it — the CONTROL arm pins exactly
 * that, beside the cross-session dialog (shown in its target, answered by a
 * person about a message from elsewhere, and never part of the target's turn).
 *
 * ## The rig
 *
 * F1.186's, unchanged in kind: the real raise sites, the real `cancelProcessing`,
 * `sendEvent` as the instrument.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'

import { createTestSessionManager } from './test-session-manager.ts'

type SessionStub = {
  id: string
  workspace: { id: string; rootPath: string }
  isProcessing: boolean
  [key: string]: unknown
}

function sessionStub(id: string, extra: Record<string, unknown> = {}): SessionStub {
  return {
    id: `session-${id}`,
    activeProvider: 'pi',
    permissionMode: 'default',
    // A model turn is running: the card below was raised by one of its tool calls.
    isProcessing: true,
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

/** Records the cards raised and withdrawn, and every turn-end marker the Stop sends. */
function watch(manager: any) {
  const rig = { raised: [] as string[], withdrawn: [] as string[], order: [] as string[] }
  manager.sendEvent = (event: any) => {
    if (event?.type === 'permission_request_cancelled') {
      rig.withdrawn.push(event.requestId)
      rig.order.push('withdrawn')
      return
    }
    if (event?.type === 'interrupted') rig.order.push('interrupted')
    if (event?.type !== 'permission_request') return
    rig.raised.push(event.request?.requestId as string)
  }
  return rig
}

/** Settled within a few ticks, or still waiting on the person. */
async function state(wait: Promise<unknown>): Promise<unknown> {
  return Promise.race([wait, new Promise(resolve => { setTimeout(() => resolve('STILL WAITING'), 30) })])
}

type Raised = { manager: any; shownIn: SessionStub; rig: ReturnType<typeof watch>; wait: Promise<unknown>; cleanup?: () => Promise<void> }

/** Each turn-bound site's own way to raise its card, with the instrument in place first. */
const turnSites: Array<{ name: string; raise: () => Promise<Raised> }> = [
  {
    name: 'authorizeMonitor (ws)',
    raise: async () => {
      const shownIn = sessionStub('stop-monitor-ws')
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
      const shownIn = sessionStub('stop-monitor-command')
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
      const repoRoot = await mkdtemp(join(tmpdir(), 'f1208-repo-'))
      const shownIn = sessionStub('stop-worktree-enter', { projectKey: repoRoot, workingDirectory: repoRoot })
      const manager = harness(shownIn)
      const rig = watch(manager)
      const wait = manager.authorizeWorktreeEnter(shownIn, { path: join(tmpdir(), 'f1208-elsewhere') })
        .then(() => 'allowed', (error: Error) => error.message)
      return { manager, shownIn, rig, wait, cleanup: () => rm(repoRoot, { recursive: true, force: true }) }
    },
  },
  {
    name: 'archiveSessionForAgent',
    raise: async () => {
      const shownIn = sessionStub('stop-archive-caller')
      const target = sessionStub('stop-archive-target', { workspace: shownIn.workspace, isArchived: false, isProcessing: false })
      const manager = harness(shownIn, target)
      const rig = watch(manager)
      const wait = manager.archiveSessionForAgent(shownIn, target.id, true)
        .then((verdict: { status: string }) => verdict.status, (error: Error) => error.message)
      return { manager, shownIn, rig, wait }
    },
  },
]

/** Past the raise's own awaits (the target-host guard, the worktree verdict). */
const raiseSettles = () => new Promise<void>(resolve => { setTimeout(resolve, 20) })

/** The 5 s stop safety timer reads these two; leave nothing for it to act on. */
function settleStub(shownIn: SessionStub) {
  shownIn.isProcessing = false
  shownIn.stopRequested = false
}

describe('F1.208 — a user Stop declines the card its turn raised, one arm per site', () => {
  for (const site of turnSites) {
    test(`${site.name}: Stop → the card leaves the screen and the count, and the wait settles as declined`, async () => {
      const { manager, shownIn, rig, wait, cleanup } = await site.raise()
      try {
        await raiseSettles()
        // The card is up and counted before the Stop arrives (positive control).
        expect(rig.raised).toHaveLength(1)
        const requestId = rig.raised[0]!
        expect(manager.awaitingApprovalCount(shownIn)).toBe(1)
        expect(manager.directPermissionResolvers.has(requestId)).toBe(true)

        await manager.cancelProcessing(shownIn.id, false, shownIn.workspace.id)

        const after = await state(wait)
        expect({
          count: manager.awaitingApprovalCount(shownIn),
          resolverLeft: manager.directPermissionResolvers.has(requestId),
          withdrawn: rig.withdrawn,
          settled: after !== 'STILL WAITING',
        }).toEqual({ count: 0, resolverLeft: false, withdrawn: [requestId], settled: true })
        // Declined, never allowed: an answer the turn can no longer use grants nothing.
        expect(after).not.toBe('allowed')
        // The card leaves the screen before the turn-end marker does.
        expect(rig.order).toEqual(['withdrawn', 'interrupted'])
      } finally {
        settleStub(shownIn)
        await cleanup?.()
      }
    })
  }
})

describe('F1.208 — CONTROLS: a Stop leaves the cards that are not its turn\'s', () => {
  test('the composer `!` card (raised between turns) survives a Stop of a turn that started after it', async () => {
    const shownIn = sessionStub('stop-direct-shell', { isProcessing: false })
    const manager = harness(shownIn)
    const rig = watch(manager)
    const wait = manager.requestDirectShellPermission(shownIn, 'ls -la')
    try {
      await raiseSettles()
      expect(rig.raised).toHaveLength(1)
      const requestId = rig.raised[0]!
      // With nothing processing, a Stop has nothing to stop — `cancelProcessing` returns first.
      await manager.cancelProcessing(shownIn.id, false, shownIn.workspace.id)
      expect(rig.order).toEqual([])
      // A turn starts while the card is still up, and is stopped.
      shownIn.isProcessing = true
      await manager.cancelProcessing(shownIn.id, false, shownIn.workspace.id)
      expect(rig.order).toEqual(['interrupted'])
      expect(rig.withdrawn).toEqual([])
      expect(manager.awaitingApprovalCount(shownIn)).toBe(1)
      expect(await state(wait)).toBe('STILL WAITING')
      // The person can still answer it.
      manager.respondToPermission(shownIn.id, requestId, true, false, undefined, shownIn.workspace.id)
      expect(await wait).toBe(true)
    } finally {
      settleStub(shownIn)
    }
  })

  test('the cross-session dialog shown in the stopped session is not that turn\'s card', async () => {
    const sender = sessionStub('stop-xsession-sender', { isProcessing: false })
    const target = sessionStub('stop-xsession-target')
    const manager = harness(sender, target)
    const rig = watch(manager)
    try {
      manager.raiseCrossSessionApprovalDialog(sender, target, 'please look at this', 'f1208-xsession')
      expect(rig.raised).toEqual(['f1208-xsession'])
      await manager.cancelProcessing(target.id, false, target.workspace.id)
      expect(rig.withdrawn).toEqual([])
      expect(manager.awaitingApprovalCount(target)).toBe(1)
      expect(manager.directPermissionResolvers.has('f1208-xsession')).toBe(true)
    } finally {
      manager.cancelCrossSessionApprovalDialog(target, 'f1208-xsession')
      settleStub(target)
    }
  })

  test('an ANSWERED turn card is untouched by a later Stop (nothing left to decline)', async () => {
    const shownIn = sessionStub('stop-monitor-answered')
    const manager = harness(shownIn)
    manager.resolveMonitorTargetHost = async () => 'example.test'
    manager.resolveNetworkAddressesFn = async () => ['93.184.216.34']
    const rig = watch(manager)
    const wait = manager.authorizeMonitor({
      sessionKey: { workspaceId: shownIn.workspace.id, sessionId: shownIn.id },
      ws: { url: 'wss://example.test/feed' },
    }).then(() => 'allowed', (error: Error) => error.message)
    try {
      await raiseSettles()
      manager.respondToPermission(shownIn.id, rig.raised[0]!, true, false, undefined, shownIn.workspace.id)
      expect(await wait).toBe('allowed')
      await manager.cancelProcessing(shownIn.id, false, shownIn.workspace.id)
      expect(rig.withdrawn).toEqual([])
      expect(manager.awaitingApprovalCount(shownIn)).toBe(0)
    } finally {
      settleStub(shownIn)
    }
  })
})

/**
 * F1.263 (origin WJ-y P-WJ-y-1) — a turn that ends any way OTHER than Stop
 * declines the same cards.
 *
 * F1.208 wired the release to `cancelProcessing` only. A turn also ends through
 * `onProcessingStopped` (an error, the 5 s stop timeout, a completion) and through
 * the three handoffs that end it directly (`beginAuthRequest`,
 * `projectPiPlanSubmission`, `projectAdjacentPlanSubmission`), none of which
 * passes through `cancelProcessing` — so a Monitor / EnterWorktree / archive card
 * raised by that turn stayed up, counted, and answerable for a turn nobody runs.
 * Same instrument as above: count, resolver map, withdrawal list, and whether the
 * wait settled — after the turn ended the other way.
 */
const writeStubPlan = async (): Promise<{ planPath: string; dir: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'f1263-plan-'))
  const planPath = join(dir, 'plan.md')
  await writeFile(planPath, '# Plan\n\n1. do the thing\n')
  return { planPath, dir }
}

const turnEnds: Array<{ name: string; end: (manager: any, shownIn: SessionStub) => Promise<unknown> }> = [
  { name: 'an error (onProcessingStopped … error)', end: (m, s) => m.onProcessingStopped(s.id, 'error', s.workspace.id) },
  { name: 'the stop timeout (onProcessingStopped … timeout)', end: (m, s) => m.onProcessingStopped(s.id, 'timeout', s.workspace.id) },
  { name: 'a completion (onProcessingStopped … complete)', end: (m, s) => m.onProcessingStopped(s.id, 'complete', s.workspace.id) },
  {
    name: 'an auth handoff (beginAuthRequest)',
    end: async (m, s) => {
      s.agent = { interruptForHandoff: () => undefined }
      await m.beginAuthRequest(s, {
        type: 'oauth', provider: 'github', requestId: `f1263-auth-${s.id}`, sessionId: s.id, sourceSlug: 'github', sourceName: 'GitHub',
      })
    },
  },
  {
    name: 'a Pi plan handoff (projectPiPlanSubmission)',
    end: async (m, s) => {
      s.agent = { interruptForHandoff: () => undefined }
      const { planPath, dir } = await writeStubPlan()
      // F1.400 — the Pi runtime's OWN branch runs only when the session carries a plan projection id; without one
      // `projectPiPlanSubmission` hands off to `projectAdjacentPlanSubmission`, and this arm used to measure that
      // one twice (deleting the Pi branch's release call left every arm green). The matching plan message is the
      // one a Pi `SubmitPlan` projects before the handoff.
      const projectionId = `f1400-plan-${s.id}`
      s.piPlanProjectionId = projectionId
      ;(s.messages as unknown[]).push({ id: projectionId, role: 'plan', content: '# Plan\n\n1. do the thing\n', timestamp: 1, planPath })
      try { await m.projectPiPlanSubmission(s, planPath) } finally { await rm(dir, { recursive: true, force: true }) }
    },
  },
  {
    name: 'an adjacent plan handoff (projectAdjacentPlanSubmission)',
    end: async (m, s) => {
      s.agent = { interruptForHandoff: () => undefined }
      const { planPath, dir } = await writeStubPlan()
      try { await m.projectAdjacentPlanSubmission(s, planPath) } finally { await rm(dir, { recursive: true, force: true }) }
    },
  },
]

describe('F1.263 — a turn that ends other than by Stop declines the card it raised', () => {
  for (const site of turnSites) {
    for (const ending of turnEnds) {
      test(`${site.name}: ${ending.name} → the card leaves the screen and the count, and the wait settles as declined`, async () => {
        const { manager, shownIn, rig, wait, cleanup } = await site.raise()
        try {
          await raiseSettles()
          expect(rig.raised).toHaveLength(1)
          const requestId = rig.raised[0]!
          expect(manager.awaitingApprovalCount(shownIn)).toBe(1)

          await ending.end(manager, shownIn)

          const after = await state(wait)
          expect({
            count: manager.awaitingApprovalCount(shownIn),
            resolverLeft: manager.directPermissionResolvers.has(requestId),
            withdrawn: rig.withdrawn,
            settled: after !== 'STILL WAITING',
          }).toEqual({ count: 0, resolverLeft: false, withdrawn: [requestId], settled: true })
          expect(after).not.toBe('allowed')
        } finally {
          settleStub(shownIn)
          await cleanup?.()
        }
      })
    }
  }
})

describe('F1.263 — CONTROLS: a turn end leaves the cards that are not its turn\'s', () => {
  for (const ending of turnEnds) {
    test(`the cross-session dialog survives ${ending.name}`, async () => {
      const sender = sessionStub('end-xsession-sender', { isProcessing: false })
      const target = sessionStub('end-xsession-target')
      const manager = harness(sender, target)
      const rig = watch(manager)
      try {
        manager.raiseCrossSessionApprovalDialog(sender, target, 'please look at this', 'f1263-xsession')
        expect(rig.raised).toEqual(['f1263-xsession'])
        await ending.end(manager, target)
        expect(rig.withdrawn).toEqual([])
        expect(manager.awaitingApprovalCount(target)).toBe(1)
        expect(manager.directPermissionResolvers.has('f1263-xsession')).toBe(true)
      } finally {
        manager.cancelCrossSessionApprovalDialog(target, 'f1263-xsession')
        settleStub(target)
      }
    })
  }

  test('a turn card of ANOTHER session is untouched when this session\'s turn ends', async () => {
    const other = sessionStub('end-other-monitor')
    const ending = sessionStub('end-this-session', { workspace: other.workspace })
    const manager = harness(other, ending)
    manager.resolveMonitorTargetHost = async () => 'example.test'
    manager.resolveNetworkAddressesFn = async () => ['93.184.216.34']
    const rig = watch(manager)
    const wait = manager.authorizeMonitor({
      sessionKey: { workspaceId: other.workspace.id, sessionId: other.id },
      ws: { url: 'wss://example.test/feed' },
    }).then(() => 'allowed', (error: Error) => error.message)
    try {
      await raiseSettles()
      const requestId = rig.raised[0]!
      await manager.onProcessingStopped(ending.id, 'error', ending.workspace.id)
      expect(rig.withdrawn).toEqual([])
      expect(manager.awaitingApprovalCount(other)).toBe(1)
      expect(await state(wait)).toBe('STILL WAITING')
      manager.respondToPermission(other.id, requestId, true, false, undefined, other.workspace.id)
      expect(await wait).toBe('allowed')
    } finally {
      settleStub(other)
      settleStub(ending)
    }
  })
})

/**
 * F1.264 (origin WJ-y P-WJ-y-2) — a card the turn's end declined says so; it
 * does not say "was denied".
 *
 * The four resolvers carry a boolean only, so after F1.208/F1.263 the stopped
 * tool call recorded each site's own denial sentence ("Monitor ws connection …
 * was denied") for a card nobody denied. DECIDED by the controller (2026-09-23):
 * the reason rides beside the boolean and ONE shared sentence is written at the
 * four sites. Read here is exactly the text the site settles with — the error a
 * Monitor / EnterWorktree call throws, the note archive_session returns — for a
 * Stop, for another turn end, and (CONTROL) for a person's own denial.
 */
const settledText: Array<{ name: string; subject: string; personDeclined: string; raise: () => Promise<Raised> }> = [
  { name: 'authorizeMonitor (ws)', subject: 'Monitor ws connection to wss://example.test/feed', personDeclined: 'was denied', raise: turnSites[0]!.raise },
  { name: 'authorizeMonitorCommand', subject: 'Monitor command watch of tail -f build.log', personDeclined: 'was denied', raise: turnSites[1]!.raise },
  {
    name: 'authorizeWorktreeEnter',
    subject: `Entering the worktree at ${join(tmpdir(), 'f1208-elsewhere')}`,
    personDeclined: 'was denied',
    raise: turnSites[2]!.raise,
  },
  {
    name: 'archiveSessionForAgent',
    subject: 'Archive of session session-stop-archive-target',
    personDeclined: 'was declined',
    raise: async () => {
      const shownIn = sessionStub('stop-archive-caller')
      const target = sessionStub('stop-archive-target', { workspace: shownIn.workspace, isArchived: false, isProcessing: false })
      const manager = harness(shownIn, target)
      const rig = watch(manager)
      const wait = manager.archiveSessionForAgent(shownIn, target.id, true)
        .then((verdict: { status: string; note?: string }) => `${verdict.status}: ${verdict.note}`, (error: Error) => error.message)
      return { manager, shownIn, rig, wait }
    },
  },
]

/** What the site settles with, for the words after its subject. */
const expectedText = (siteName: string, subject: string, words: string): string => siteName === 'archiveSessionForAgent'
  ? `denied: ${subject} ${words}. The session is unchanged.`
  : `${subject} ${words}.`

describe('F1.264 — the settled text names a cancelled card as cancelled, and a denied one as denied', () => {
  for (const site of settledText) {
    test(`${site.name}: a Stop → "${site.subject} was cancelled because the turn was stopped"`, async () => {
      const { manager, shownIn, rig, wait, cleanup } = await site.raise()
      try {
        await raiseSettles()
        expect(rig.raised).toHaveLength(1)
        await manager.cancelProcessing(shownIn.id, false, shownIn.workspace.id)
        expect(await state(wait)).toBe(expectedText(site.name, site.subject, 'was cancelled because the turn was stopped'))
        expect(manager.hostCardCancellations).toBeInstanceOf(Map) // F1.405 — the field itself, no `?.`/`?? 0`: a rename is a red
        expect(manager.hostCardCancellations.size).toBe(0)
      } finally {
        settleStub(shownIn)
        await cleanup?.()
      }
    })

    test(`${site.name}: an error ends the turn → "${site.subject} was cancelled because the turn ended"`, async () => {
      const { manager, shownIn, rig, wait, cleanup } = await site.raise()
      try {
        await raiseSettles()
        expect(rig.raised).toHaveLength(1)
        await manager.onProcessingStopped(shownIn.id, 'error', shownIn.workspace.id)
        expect(await state(wait)).toBe(expectedText(site.name, site.subject, 'was cancelled because the turn ended'))
        expect(manager.hostCardCancellations).toBeInstanceOf(Map) // F1.405 — the field itself, no `?.`/`?? 0`: a rename is a red
        expect(manager.hostCardCancellations.size).toBe(0)
      } finally {
        settleStub(shownIn)
        await cleanup?.()
      }
    })

    test(`${site.name}: CONTROL — the person denies → "${site.subject} ${site.personDeclined}", unchanged`, async () => {
      const { manager, shownIn, rig, wait, cleanup } = await site.raise()
      try {
        await raiseSettles()
        expect(rig.raised).toHaveLength(1)
        manager.respondToPermission(shownIn.id, rig.raised[0]!, false, false, undefined, shownIn.workspace.id)
        expect(await state(wait)).toBe(expectedText(site.name, site.subject, site.personDeclined))
        // A later Stop finds nothing to cancel and rewrites nothing.
        await manager.cancelProcessing(shownIn.id, false, shownIn.workspace.id)
        expect(manager.hostCardCancellations).toBeInstanceOf(Map) // F1.405 — the field itself, no `?.`/`?? 0`: a rename is a red
        expect(manager.hostCardCancellations.size).toBe(0)
      } finally {
        settleStub(shownIn)
        await cleanup?.()
      }
    })
  }
})
