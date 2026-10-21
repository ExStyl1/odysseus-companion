/**
 * P6.500 — reopening a long, idle conversation asks compact-or-keep, once.
 *
 * Two halves, and they are tested with two different instruments on purpose.
 *
 * The TRIGGER is six conditions, every one of which is a way the dialog must NOT
 * appear. An end-to-end test that only drives the two answers cannot see one of
 * them silently ceasing to be checked, so `shouldOfferReopenCompaction` is a pure
 * function and each condition gets its own case.
 *
 * The ANSWERS are driven through the real `offerCompactOnReopen` against the real
 * `requestPiToolApproval`, because what the row asks for is that a click reaches
 * the runtime's own compaction and that the choice is remembered. The card is
 * settled where a user would settle it: `requestPiToolApproval` registers its
 * resolver BEFORE handing the request on, so answering from the stubbed
 * `handleAgentPermissionRequest` is the same route a click takes, and everything
 * the row is about — the payload, the wording, the dispatch — is built by the
 * method under test.
 *
 * Per-runtime: there is no provider branch anywhere in this row. The answer is
 * dispatched as a plain `/compact` through `sendMessage`, which reaches
 * `BaseAgent.chat`'s compact arm and therefore each runtime's own mechanism, so
 * Pi, claude and codex behave identically by construction rather than by three
 * parallel implementations.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { rmSync } from 'node:fs'
import { SESSION_PERSISTENT_FIELDS } from '@nessy-agent/shared/sessions/types'
import {
  REOPEN_COMPACT_IDLE_MS,
  createManagedSession,
  shouldOfferReopenCompaction,
} from '../SessionManager'
import { createTestSessionManager } from './test-session-manager'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** The shape that WOULD offer: every condition satisfied, one at a time flipped. */
const offerable = {
  answered: false,
  hidden: false,
  ephemeral: false,
  contextTokens: 150_000,
  thresholdTokens: 100_000,
  idleMs: REOPEN_COMPACT_IDLE_MS + 1,
  compactWithdrawn: false,
} as const

function fixture(options: { answer: boolean; contextTokens?: number; idleMs?: number } ) {
  const manager = createTestSessionManager() as any
  const workspace = {
    id: 'ws-reopen-compact',
    name: 'Reopen Workspace',
    slug: 'reopen-workspace',
    rootPath: '/tmp/nessy-reopen-compact-workspace',
    createdAt: Date.now(),
  }
  const idleMs = options.idleMs ?? REOPEN_COMPACT_IDLE_MS * 24
  const managed = createManagedSession(
    { id: 'session-1', lastMessageAt: Date.now() - idleMs },
    workspace,
    { messagesLoaded: true },
  )
  managed.tokenUsage = {
    inputTokens: options.contextTokens ?? 150_000,
    outputTokens: 0,
    totalTokens: options.contextTokens ?? 150_000,
    contextTokens: options.contextTokens ?? 150_000,
    costUsd: 0,
  }
  manager.sessions.set(`${workspace.id}:${managed.id}`, managed)

  const asked: Array<Record<string, unknown>> = []
  manager.handleAgentPermissionRequest = (_managed: unknown, request: Record<string, unknown>) => {
    asked.push(request)
    const requestId = request.requestId as string
    const resolver = manager.directPermissionResolvers.get(requestId)
    manager.directPermissionResolvers.delete(requestId)
    resolver?.resolve(options.answer)
  }

  const persisted: unknown[] = []
  manager.persistSession = (target: unknown) => { persisted.push(target) }
  const sent: Array<{ sessionId: string; message: string }> = []
  manager.sendMessage = async (sessionId: string, message: string) => {
    sent.push({ sessionId, message })
  }

  return { manager, managed, asked, persisted, sent }
}

describe('the reopen trigger — six ways it must NOT ask', () => {
  it('asks when every condition is satisfied — the control', () => {
    expect(shouldOfferReopenCompaction({ ...offerable })).toBe(true)
  })

  it('never asks twice for one conversation', () => {
    expect(shouldOfferReopenCompaction({ ...offerable, answered: true })).toBe(false)
  })

  it('leaves hidden children and scratch sessions alone', () => {
    // A hidden child is not a conversation a person reopens, and an ephemeral
    // session cannot remember an answer — asking would repeat forever.
    expect(shouldOfferReopenCompaction({ ...offerable, hidden: true })).toBe(false)
    expect(shouldOfferReopenCompaction({ ...offerable, ephemeral: true })).toBe(false)
  })

  it('is OFF at zero or below, which is the documented off switch', () => {
    expect(shouldOfferReopenCompaction({ ...offerable, thresholdTokens: 0 })).toBe(false)
    expect(shouldOfferReopenCompaction({ ...offerable, thresholdTokens: -1 })).toBe(false)
  })

  it('asks at the threshold and not below it', () => {
    expect(shouldOfferReopenCompaction({ ...offerable, contextTokens: 100_000 })).toBe(true)
    expect(shouldOfferReopenCompaction({ ...offerable, contextTokens: 99_999 })).toBe(false)
  })

  it('waits out the page’s hour, to the millisecond', () => {
    expect(shouldOfferReopenCompaction({ ...offerable, idleMs: REOPEN_COMPACT_IDLE_MS })).toBe(true)
    expect(shouldOfferReopenCompaction({ ...offerable, idleMs: REOPEN_COMPACT_IDLE_MS - 1 })).toBe(false)
  })

  it('never offers what the composer withdraws', () => {
    // `composer-capabilities.ts` excludes `compact` where manual compaction is
    // unavailable. Offering a compaction `BaseAgent.chat` would refuse is the
    // advertised-and-unavailable defect that exclusion list exists to end.
    expect(shouldOfferReopenCompaction({ ...offerable, compactWithdrawn: true })).toBe(false)
  })
})

describe('the first two answers, driven through the real card', () => {
  it('runs the runtime’s own compaction when the user picks the summary', async () => {
    const rig = fixture({ answer: true })
    await rig.manager.offerCompactOnReopen(rig.managed)

    // One card, and its payload carries the three facts the dialog shows so the
    // choice is informed rather than taken on trust.
    expect(rig.asked).toHaveLength(1)
    const card = rig.asked[0]!
    expect(card.reopenCompact).toEqual({
      contextTokens: 150_000,
      thresholdTokens: 100_000,
      idleHours: 24,
    })
    // The GENERIC Always Allow is withheld — its label and scope are the wrong
    // question for one conversation, and a client that does not know the
    // `reopenCompact` payload therefore shows exactly these two. P6.950's third
    // answer is the card's own button and rides `alwaysAllow` into
    // `respondToPermission`; the describe below drives that route.
    expect(card.noAlwaysAllow).toBe(true)

    // The compaction is the plain `/compact` a user would type — one dispatch,
    // no provider branch.
    expect(rig.sent).toEqual([{ sessionId: 'session-1', message: '/compact' }])
    expect(rig.managed.reopenCompactChoice).toBe('summary')
    expect(rig.persisted).toEqual([rig.managed])
  })

  it('keeps the conversation as it is, and sends nothing, when the user says so', async () => {
    const rig = fixture({ answer: false })
    await rig.manager.offerCompactOnReopen(rig.managed)

    expect(rig.asked).toHaveLength(1)
    // The control that makes the case above mean something: "as-is" must not
    // reach the model at all.
    expect(rig.sent).toEqual([])
    expect(rig.managed.reopenCompactChoice).toBe('as-is')
    expect(rig.persisted).toEqual([rig.managed])
  })

  it('asks ONCE — a second open of the same conversation is silent', async () => {
    const rig = fixture({ answer: false })
    await rig.manager.offerCompactOnReopen(rig.managed)
    await rig.manager.offerCompactOnReopen(rig.managed)

    expect(rig.asked).toHaveLength(1)
  })

  it('says nothing for a conversation that is short, or was just used', async () => {
    const small = fixture({ answer: true, contextTokens: 10_000 })
    await small.manager.offerCompactOnReopen(small.managed)
    expect(small.asked).toEqual([])

    const fresh = fixture({ answer: true, idleMs: 60_000 })
    await fresh.manager.offerCompactOnReopen(fresh.managed)
    expect(fresh.asked).toEqual([])
  })
})

/**
 * C3.371 — the same three answers on a session that has NO AGENT, which is the
 * only kind of session this card is ever raised on.
 *
 * The rig above plants `managed.agent`, and that is exactly what hid the defect:
 * the offer is raised from `getSession`, BEFORE the reopened conversation's first
 * message has created an agent, while `respondToPermission` gated its whole body
 * — the pending-record removal, the reopen host effect, and the direct resolver
 * this card is registered under — on `managed?.agent`. On the packaged 1.36.0
 * build (rig day R6b: five sessions, two launches, two click mechanisms) every
 * answer therefore fell through to `Cannot respond to permission - no agent for
 * session`: the card left the screen, `awaitingApprovalCount` stayed 1, the await
 * in `offerCompactOnReopen` never returned, so no choice was persisted and no
 * compaction ever started. The ORDINARY permission card was R6b's control and
 * answered correctly in the same profile — it is raised during a turn, so it has
 * an agent.
 *
 * Driven end to end through the real `offerCompactOnReopen`,
 * `requestPiToolApproval`, `handleAgentPermissionRequest` and
 * `respondToPermission`; only `persistSession` and `sendMessage` are stubbed, to
 * keep the assertions off the disk and off a model. The DETECTOR is the
 * backend's own `awaitingApprovalCount` — the one R6b used — because the screen
 * clears either way.
 */
function noAgentRig(): {
  manager: ReturnType<typeof createTestSessionManager>
  managed: ReturnType<typeof createManagedSession>
  persisted: unknown[]
  sent: Array<{ sessionId: string; message: string }>
  raise: () => { offer: Promise<void>; requestId: string }
  answer: (allowed: boolean, alwaysAllow: boolean, requestId: string) => boolean
  awaiting: () => number
} {
  const manager = createTestSessionManager()
  const workspace = {
    id: 'ws-reopen-no-agent',
    name: 'Reopen Workspace',
    slug: 'reopen-no-agent',
    rootPath: '/tmp/nessy-reopen-compact-no-agent',
    createdAt: Date.now(),
  }
  const contextTokens = 150_000
  // DELIBERATELY no `managed.agent`: a reopened session has none until its first
  // message, and reopen is when this card appears.
  const managed = createManagedSession(
    { id: 'session-no-agent', lastMessageAt: Date.now() - REOPEN_COMPACT_IDLE_MS * 3 },
    workspace,
    { messagesLoaded: true },
  )
  managed.tokenUsage = {
    inputTokens: contextTokens,
    outputTokens: 0,
    totalTokens: contextTokens,
    contextTokens,
    costUsd: 0,
  }
  const inner = manager as unknown as {
    sessions: Map<string, unknown>
    pendingPermissionRequests: Map<string, unknown>
    awaitingApprovalCount(managed: unknown): number
    offerCompactOnReopen(managed: unknown): Promise<void>
    persistSession: (managed: unknown) => void
    sendMessage: (...args: unknown[]) => Promise<unknown>
    respondToPermission: (
      sessionId: string, requestId: string, allowed: boolean, alwaysAllow: boolean,
      options?: unknown, workspaceId?: string,
    ) => boolean
  }
  inner.sessions.set(`${workspace.id}:${managed.id}`, managed)
  const persisted: unknown[] = []
  inner.persistSession = (target: unknown) => { persisted.push(target) }
  const sent: Array<{ sessionId: string; message: string }> = []
  inner.sendMessage = async (...args: unknown[]) => {
    sent.push({ sessionId: args[0] as string, message: args[1] as string })
  }

  return {
    manager,
    managed,
    persisted,
    sent,
    // The card, and the id a click answers under. `requestPiToolApproval` runs
    // its executor synchronously, so the pending record exists the moment the
    // un-awaited offer returns its promise.
    raise: () => {
      const offer = inner.offerCompactOnReopen(managed)
      const ids = [...inner.pendingPermissionRequests.keys()]
      expect(ids).toHaveLength(1)
      return { offer, requestId: ids[0]! }
    },
    answer: (allowed, alwaysAllow, requestId) =>
      inner.respondToPermission(managed.id, requestId, allowed, alwaysAllow, undefined, workspace.id),
    awaiting: () => inner.awaitingApprovalCount(managed),
  }
}

describe('the three answers reach the backend with no agent (C3.371)', () => {
  it('compacts when the user picks the summary', async () => {
    const rig = noAgentRig()
    try {
      const { offer, requestId } = rig.raise()
      expect(rig.awaiting()).toBe(1)
      expect(rig.answer(true, false, requestId)).toBe(true)
      await offer
      expect(rig.managed.reopenCompactChoice).toBe('summary')
      expect(rig.sent).toEqual([{ sessionId: 'session-no-agent', message: '/compact' }])
      expect(rig.persisted).toEqual([rig.managed])
      // The live failure's own detector: the record must be GONE, or the
      // conversation shows a pending approval for the life of the process.
      expect(rig.awaiting()).toBe(0)
    } finally {
      rig.manager.cleanup()
    }
  })

  it('resumes the full session as it is, and sends nothing', async () => {
    const rig = noAgentRig()
    try {
      const { offer, requestId } = rig.raise()
      expect(rig.answer(false, false, requestId)).toBe(true)
      await offer
      expect(rig.managed.reopenCompactChoice).toBe('as-is')
      expect(rig.sent).toEqual([])
      expect(rig.persisted).toEqual([rig.managed])
      expect(rig.awaiting()).toBe(0)
    } finally {
      rig.manager.cleanup()
    }
  })

  it('leaves the count at 1 while the card is UNANSWERED — the negative', () => {
    // "An unanswered card decides nothing" is the documented safe half, and it
    // is also what a broken answer looks like, so the pair is what makes either
    // case mean anything.
    const rig = noAgentRig()
    try {
      rig.raise()
      expect(rig.awaiting()).toBe(1)
      expect(rig.managed.reopenCompactChoice).toBeUndefined()
      expect(rig.sent).toEqual([])
      expect(rig.persisted).toEqual([])
    } finally {
      rig.manager.cleanup()
    }
  })

  // LAST of the offer-driven cases ON PURPOSE, and worth keeping last: answering
  // with `alwaysAllow` runs the real `disableReopenCompactPrompt()`, which is a
  // write of `reopenCompactPromptTokens = 0` into this PROCESS's config dir —
  // the knob every case above reads through `getReopenCompactPromptTokens()`.
  // Measured in this suite it is a NO-OP and says so
  // (`disableReopenCompactPrompt: config.json is absent — the change was NOT
  // persisted`), because the isolated config dir holds no `config.json`; the
  // ordering is kept anyway, so a suite that ever seeds one cannot silently stop
  // the cases above from offering at all. `raise()`'s own length assertion is
  // the only thing that would say so if it did.
  it('remembers “don’t ask me again”, and still resumes the conversation', async () => {
    const rig = noAgentRig()
    try {
      const { offer, requestId } = rig.raise()
      expect(rig.answer(false, true, requestId)).toBe(true)
      await offer
      expect(rig.managed.reopenCompactChoice).toBe('as-is')
      expect(rig.sent).toEqual([])
      expect(rig.awaiting()).toBe(0)
    } finally {
      rig.manager.cleanup()
    }
  })
})

/**
 * P6.950 — the page's THIRD answer, driven through the real
 * `requestPiToolApproval` + the real `respondToPermission`, because what the row
 * is about is a ROUTE: a click has to reach the host effect, and the two answers
 * P6.500 shipped never travelled that method in a test (their rig stubs
 * `handleAgentPermissionRequest` and settles the resolver itself).
 *
 * The file WRITE is pinned next door, in `storage-reopen-compact.test.ts`, which
 * owns a private `NESSY_CONFIG_DIR` per subprocess. Asserting it from here would
 * mean seeding a `config.json` into the config directory this whole `bun test`
 * process shares, which is module-scope state every other suite in the run reads.
 */
function answerRig() {
  const manager = createTestSessionManager()
  const managed = createManagedSession({ id: 'session-reopen' }, {
    id: 'ws-reopen',
    name: 'Reopen Workspace',
    rootPath: '/tmp/nessy-reopen-compact-answer',
    createdAt: 1,
  }, { messagesLoaded: true, ephemeral: true })
  managed.agent = { respondToPermission: () => {} } as never
  const inner = manager as unknown as {
    sessions: Map<string, unknown>
    piAskUserServices: Map<string, unknown>
    managedKey(managed: unknown): string
    requestPiToolApproval(managed: unknown, request: Record<string, unknown>): Promise<{ allowed: boolean }>
    respondToPermission: (
      sessionId: string, requestId: string, allowed: boolean, alwaysAllow: boolean,
      options?: unknown, workspaceId?: string,
    ) => boolean
    pendingPermissionRequests: Map<string, { reopenCompact?: unknown }>
  }
  inner.sessions.set('ws-reopen:session-reopen', managed)
  return { manager, inner, managed }
}

/** The card, raised the way `offerCompactOnReopen` raises it. */
function raiseCard(inner: ReturnType<typeof answerRig>['inner'], managed: unknown): Promise<{ allowed: boolean }> {
  return inner.requestPiToolApproval(managed, {
    decisionId: 'decision-reopen-1',
    toolName: 'ResumeConversation',
    type: 'ask_user',
    description: 'idle and large',
    noAlwaysAllow: true,
    reopenCompact: { contextTokens: 150_000, thresholdTokens: 100_000, idleHours: 24 },
  })
}

/**
 * P6.1017 — asked whether this pin belongs in a permissions suite instead, and
 * the measured answer is that it STAYS.
 *
 * No permissions suite owns `respondToPermission`. Measured over
 * `packages/server-core` on 2026-09-10: seven suites call it and every one is the
 * FEATURE suite that raises its own card — `monitor-command-gate`,
 * `monitor-ws-approval`, `outside-working-directory-read-answer`,
 * `workflow-launch-approval`, `usage-metrics-emission`, `agent-message-delivery`,
 * and this one. The six `*permission*`-named suites beside this file (request
 * origin, policy notice, refusal wording, the cd gate, project mode, the resume
 * table) call it ZERO times, and the two nearest candidates one directory up test
 * something else: `durable-approvals.test.ts` pins that an `ask_user` prompt is
 * not double-persisted, `permission-remember.test.ts` pins the `alwaysAllow`
 * memory on tool cards.
 *
 * The arms also cannot move without their rig. The negative one needs the reopen
 * card that `answerRig()` and `raiseCard()` build, and the positive one is its
 * control — a pair split across two files can be satisfied by deleting both
 * halves, which is the failure the pair exists to prevent.
 */
describe('the third answer reaches the host effect (P6.950)', () => {
  it('carries the payload on the pending request, which is what routes the answer', async () => {
    const { manager, inner, managed } = answerRig()
    try {
      const card = raiseCard(inner, managed)
      // The discriminant. Without it `respondToPermission` has no way to tell
      // this `ask_user` card from Pi's own durable one.
      expect(inner.pendingPermissionRequests.get('decision-reopen-1')?.reopenCompact)
        .toEqual({ contextTokens: 150_000, thresholdTokens: 100_000, idleHours: 24 })

      // "Don't ask me again" = resume as-is (`allowed: false`) AND stop asking
      // (`alwaysAllow`). The resolver must still settle as-is, or the card would
      // hang and the conversation would never resume.
      expect(inner.respondToPermission('session-reopen', 'decision-reopen-1', false, true, undefined, 'ws-reopen'))
        .toBe(true)
      await expect(card).resolves.toMatchObject({ allowed: false })
    } finally {
      manager.cleanup()
    }
  })

  it('settles even when the session has an AskUserService that never held it', async () => {
    // NEGATIVE, and it is the defect this row met. `ask_user` is a shared card
    // type: every Pi session owns an `AskUserService`, and the branch used to
    // fire on the service EXISTING. `cancel()` throws `unknown-request` for an id
    // it never held, the rejection was logged, and this method returned true with
    // the card's resolver still pending — so on Pi the answer did nothing and
    // nothing said so.
    const { manager, inner, managed } = answerRig()
    try {
      let cancelled = 0
      inner.piAskUserServices.set(inner.managedKey(managed), {
        pending: () => undefined,
        cancel: async () => { cancelled += 1; throw new Error('unknown-request') },
        answer: async () => { throw new Error('unknown-request') },
      })
      const card = raiseCard(inner, managed)
      expect(inner.respondToPermission('session-reopen', 'decision-reopen-1', false, true, undefined, 'ws-reopen'))
        .toBe(true)
      await expect(card).resolves.toMatchObject({ allowed: false })
      // The durable service was never asked to settle a request it never had.
      expect(cancelled).toBe(0)
    } finally {
      manager.cleanup()
    }
  })

  it('still hands a durable ask_user to its own service — the control', async () => {
    // POSITIVE for the other side of the same guard: when the service DOES hold
    // the request, the durable path must keep winning, or Pi's own `ask_user`
    // tool would settle through the wrong seam.
    const { manager, inner, managed } = answerRig()
    try {
      let cancelled = 0
      inner.piAskUserServices.set(inner.managedKey(managed), {
        pending: () => ({ requestId: 'decision-durable-1' }),
        cancel: async () => { cancelled += 1 },
        answer: async () => {},
      })
      inner.pendingPermissionRequests.set('decision-durable-1', {
        workspaceId: 'ws-reopen', sessionId: 'session-reopen', type: 'ask_user',
      } as never)
      expect(inner.respondToPermission('session-reopen', 'decision-durable-1', false, false, undefined, 'ws-reopen'))
        .toBe(true)
      await Promise.resolve()
      expect(cancelled).toBe(1)
    } finally {
      manager.cleanup()
    }
  })
})

describe('the answer survives a restart', () => {
  it('is a PERSISTED session field, which is what makes “once” true across a reopen', () => {
    // The dialog exists for the case that spans a restart, so an in-memory flag
    // would ask again on the next launch. `SESSION_PERSISTENT_FIELDS` is the
    // mechanism — "add it to this array and serialization is automatic" — so
    // membership is the assertion, not a round trip through a fake disk.
    expect(SESSION_PERSISTENT_FIELDS).toContain('reopenCompactChoice')
  })
})

describe('C3.375 — opening a session must not float the offer', () => {
  it('observes a rejected offer and still returns the session', async () => {
    // F3's reading beside C3.371: `getSession` started this offer with no `void`
    // and no `.catch()`, so a rejection anywhere inside it — the card, the
    // persist, the runtime — surfaced as an unobserved rejection raised from the
    // middle of opening a session, naming neither the session nor the offer. The
    // method's own body is `try/finally` with no `catch`, which is what left the
    // hole reachable.
    //
    // The instrument is a SCOPED `unhandledRejection` collector: installing a
    // listener also suppresses the runner's own default handling, so the arm is
    // discriminating in both directions — the collector holds the rejection
    // without the fix and is empty with it.
    const rig = fixture({ answer: false })
    const failure = new Error('the offer blew up')
    rig.manager.offerCompactOnReopen = async () => { throw failure }

    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    let dto: unknown
    try {
      dto = await rig.manager.getSession('session-1', 'ws-reopen-compact')
      // Let the floating rejection, if there is one, reach the loop.
      await new Promise(resolve => setTimeout(resolve, 50))
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }

    expect(unhandled).toEqual([])
    // The open still SUCCEEDS — a failed offer must never fail the open, which
    // is the other half of the contract and the reason this is a `.catch` and
    // not an `await`.
    expect(dto).toBeDefined()
    expect((dto as { id?: string }).id).toBe('session-1')
  })
})
