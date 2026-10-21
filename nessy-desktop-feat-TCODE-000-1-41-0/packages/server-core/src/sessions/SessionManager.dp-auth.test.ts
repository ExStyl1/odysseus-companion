import { describe, expect, mock, test } from 'bun:test'
import { DpAuthError, DpAuthServiceError, type DpSessionBroker } from '@nessy-agent/shared/auth/dp'
import { CapabilityMaterializationError } from '@nessy-agent/shared/capabilities/materializer'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { createManagedSession, SessionManager } from './SessionManager.ts'
import { createTestSessionManager } from './__tests__/test-session-manager.ts'

const runtime = {
  provider: 'pi' as const,
  view: { generation: 'generation-dp', sources: [], skills: [], mcpServers: [], promptLayers: [], memory: [] },
  materializer: { assertActive() {} },
}

const originalTurn = {
  message: 'use the developer platform',
  modelMessage: 'use the developer platform',
  userMessageId: 'user-dp',
  attachments: [],
  storedAttachments: [],
  options: {},
}

function materialized(state: 'ready' | 'needs-login' | 'unavailable', count = 1) {
  return {
    sources: [],
    mcpServers: {},
    apiServers: {},
    mergedMcpServers: {},
    externalAuthRequirements: Array.from({ length: count }, (_, index) => ({
      provider: 'dp' as const,
      wireNames: [`dp-${index}`],
      pluginInstanceIds: [`plugin-${index}`],
      state,
    })),
  }
}

function fixture(
  dpSessionBroker?: Pick<DpSessionBroker, 'probe' | 'subscribe' | 'ensure' | 'cancel'>,
) {
  const invalidate = mock(() => {})
  const manager = createTestSessionManager({
    resolver: {
      resolve: async () => { throw new Error('unused') },
      releaseSnapshot() {},
      invalidate,
      isLeaseActive: () => true,
      referencedInstances: () => new Set(),
      leaseCount: () => 0,
    },
    ...(dpSessionBroker ? { dpSessionBroker } : {}),
  })
  const managed = createManagedSession({
    id: 'session-dp',
    llmConnection: 'pi',
  }, {
    id: 'workspace-dp',
    name: 'Workspace DP',
    rootPath: '/tmp/workspace-dp',
    createdAt: 1,
  }, {
    messagesLoaded: true,
    ephemeral: true,
  })
  managed.isProcessing = true
  managed.processingGeneration = 7
  managed.messages.push({
    id: originalTurn.userMessageId,
    role: 'user',
    content: originalTurn.message,
    timestamp: 1,
  })
  managed.agent = {
    interruptForHandoff: mock(() => {}),
  } as never

  const sync = mock(async () => {})
  const materializeRuntime = mock(async () => materialized('needs-login'))
  managed.mcpPoolLease = {
    key: { workspaceId: managed.workspace.id },
    pool: { sync } as never,
    leaserId: 'session-dp-lease',
    ensureSynced: async () => {},
    materializeRuntime,
    release: async () => {},
  }

  const internal = manager as any
  internal.sessions.set(encodeSessionKey({
    workspaceId: managed.workspace.id,
    sessionId: managed.id,
  }), managed)
  internal.sendEvent = mock(() => {})
  internal.persistSession = mock(() => {})
  internal.flushSession = mock(async () => {})

  return { manager, managed, internal, invalidate, materializeRuntime, sync }
}

/** Every `sendEvent({ type: 'info' })` message this fixture's manager emitted. */
function noticeMessages(internal: any): string[] {
  return internal.sendEvent.mock.calls
    .map(([event]: [{ type?: string; message?: string }]) => (event?.type === 'info' ? event.message : undefined))
    .filter((message: unknown): message is string => typeof message === 'string')
}

describe('SessionManager DP auth preflight', () => {
  /**
   * C3.381 (owner decision 2026-09-12, option A). This case asserted the
   * opposite — one pending auth request, one `auth-request` message and one
   * `interruptForHandoff` — which is the turn pause the decision removed. The
   * rig day priced that pause: a Pi arm lost half a day to a lapsed `dp` CLI
   * session while claude and codex answered on the same machine (R1/R5/R6b).
   */
  test('observes needs-login and lets the turn run: no card, no pause, one notice', async () => {
    const { managed, internal, materializeRuntime } = fixture()

    const preflight = await internal.preflightDpAuth(managed, runtime)

    expect(preflight).toBe('needs-login')
    expect(materializeRuntime).toHaveBeenCalledWith(runtime)
    expect(managed.pendingAuthRequest).toBeUndefined()
    expect(managed.dpAuthReplay).toBeUndefined()
    expect(managed.messages.filter(message => message.role === 'auth-request')).toHaveLength(0)
    expect((managed.agent as any).interruptForHandoff).not.toHaveBeenCalled()
    expect(noticeMessages(internal)).toHaveLength(1)
  })

  test('the notice is once per session, and a timeout is a different notice from a sign-out', async () => {
    const { managed, internal, materializeRuntime } = fixture()

    await internal.preflightDpAuth(managed, runtime)
    await internal.preflightDpAuth(managed, runtime)
    expect(noticeMessages(internal)).toHaveLength(1)
    const signedOut = noticeMessages(internal)[0]

    // C3.391's clause: the broker collapses a `Timeout` into `'unavailable'`,
    // and a user who is signed IN and met a slow dp must not be told to sign in.
    // A plugin-bound dp requirement is what reaches `'unavailable'` — a builtin
    // one is not actionable there (the two-tier gate below).
    materializeRuntime.mockImplementation(async () => materialized('unavailable'))
    expect(await internal.preflightDpAuth(managed, runtime)).toBe('unavailable')
    const notices = noticeMessages(internal)
    expect(notices).toHaveLength(2)
    expect(notices[1]).not.toBe(signedOut)
  })

  test('syncs a ready lease and says nothing; a DP-free turn reports unavailable', async () => {
    const { managed, internal, materializeRuntime, sync } = fixture()
    materializeRuntime.mockImplementation(async () => materialized('ready'))

    expect(await internal.preflightDpAuth(managed, runtime)).toBe('ready')
    expect(sync).toHaveBeenCalledTimes(1)
    expect(managed.pendingAuthRequest).toBeUndefined()
    expect(noticeMessages(internal)).toHaveLength(0)

    materializeRuntime.mockImplementation(async () => ({
      ...materialized('ready'),
      externalAuthRequirements: [],
    }))
    expect(await internal.preflightDpAuth(managed, runtime)).toBe('unavailable')
    expect(managed.pendingAuthRequest).toBeUndefined()
    // No DP server in the turn: the value is never consulted downstream, and
    // there is nothing to tell the user about.
    expect(noticeMessages(internal)).toHaveLength(0)
  })

  /**
   * C3.381's "identical on Pi, claude and codex". The method used to OPEN with
   * `if (runtime.provider !== 'pi') return … 'unavailable'`, so claude and codex
   * never observed the state at all — and `'unavailable'` is the one verdict the
   * two-tier gate treats as "do not evict", so a signed-out dp still had its
   * builtin servers spawned on those two runtimes while Pi paused the turn.
   */
  test('every runtime observes the same state and hears the same notice', async () => {
    const perProvider = new Map<string, string[]>()
    for (const provider of ['pi', 'claude', 'codex'] as const) {
      const { managed, internal, materializeRuntime } = fixture()
      const providerRuntime = { ...runtime, provider }

      expect(await internal.preflightDpAuth(managed, providerRuntime)).toBe('needs-login')
      expect(materializeRuntime).toHaveBeenCalledWith(providerRuntime)
      expect(managed.messages.filter(message => message.role === 'auth-request')).toHaveLength(0)
      perProvider.set(provider, noticeMessages(internal))
    }
    // One host notice, the same bytes on all three — not three implementations.
    expect([...perProvider.values()].map(notices => notices.length)).toEqual([1, 1, 1])
    expect(new Set([...perProvider.values()].map(notices => notices[0])).size).toBe(1)
  })

  /**
   * The two-tier dp gate (owner decision 2026-08-06), applied here via
   * `builtinWireNames` (DPK-6/DPK-7): a builtin dp server carries no credential
   * of its own, so it is actionable only at `needs-login`. That gate SURVIVES
   * C3.381 — what C3.381 moved is where it is enforced, from the TURN to the
   * TOOL: the state this method returns is the one the send path materializes
   * the desired server set under, so the withholding still happens and the turn
   * no longer stops for it.
   */
  test('builtin-only dp requirement in unavailable: reported ready, nothing said', async () => {
    const { managed, internal, materializeRuntime, sync } = fixture()
    materializeRuntime.mockImplementation(async () => ({
      ...materialized('unavailable'),
      externalAuthRequirements: [{
        provider: 'dp' as const,
        wireNames: ['dpGitlab'],
        pluginInstanceIds: [],
        state: 'unavailable' as const,
        builtinWireNames: ['dpGitlab'],
      }],
    }))

    expect(await internal.preflightDpAuth(managed, runtime)).toBe('ready')
    expect(sync).toHaveBeenCalledTimes(1)
    expect(managed.pendingAuthRequest).toBeUndefined()
    // A transient probe hiccup is not a sign-out and must not be announced as one.
    expect(noticeMessages(internal)).toHaveLength(0)
  })

  test('builtin-only dp requirement in needs-login: the tool gate applies, the turn does not stop', async () => {
    const { managed, internal, materializeRuntime } = fixture()
    materializeRuntime.mockImplementation(async () => ({
      ...materialized('needs-login'),
      externalAuthRequirements: [{
        provider: 'dp' as const,
        wireNames: ['dpGitlab'],
        pluginInstanceIds: [],
        state: 'needs-login' as const,
        builtinWireNames: ['dpGitlab'],
      }],
    }))

    // needs-login is the ONE state that means "the user must sign in": it is
    // what the send path withholds the builtin under, and what the notice names.
    expect(await internal.preflightDpAuth(managed, runtime)).toBe('needs-login')
    expect(managed.pendingAuthRequest).toBeUndefined()
    expect(noticeMessages(internal)).toHaveLength(1)
  })

  /**
   * DA1.37 — the lease-less branch, which `a40a13193` added at the 1.38.0
   * close-out and nothing pinned.
   *
   * It exists because C3.381 routed every runtime through this preflight and
   * four SessionManager rigs that build a session with no pool lease then met a
   * `dp-auth-runtime-lease-required` throw only Pi turns had ever reached. The
   * production posture is the one the materialization-failure arm below states:
   * a preflight OBSERVES, it is never the reason a turn dies — and a session
   * with no lease has no dp server to observe, so the honest degraded answer is
   * the one the no-dp-server exit already returns.
   *
   * The pin is what makes that branch discriminating. Without it the line is
   * indistinguishable from the throw it replaced for every reader who does not
   * run a lease-less rig, and re-introducing the throw would go green here.
   */
  test('a session with no pool lease degrades to unavailable and the turn proceeds (DA1.37)', async () => {
    const { managed, internal, materializeRuntime, sync } = fixture()
    managed.mcpPoolLease = undefined

    // No throw, and the degraded verdict rather than a state the two-tier gate
    // would read as actionable.
    expect(await internal.preflightDpAuth(managed, runtime)).toBe('unavailable')

    // Nothing was observed, because there was nothing to observe.
    expect(materializeRuntime).not.toHaveBeenCalled()
    expect(sync).not.toHaveBeenCalled()

    // And the turn proceeds: no card, no replay envelope, no auth-request row,
    // no handoff interrupt — and no user-facing notice, because a missing lease
    // is a host condition and not a sign-out the user can act on.
    expect(managed.pendingAuthRequest).toBeUndefined()
    expect(managed.dpAuthReplay).toBeUndefined()
    expect(managed.messages.filter(message => message.role === 'auth-request')).toHaveLength(0)
    expect((managed.agent as any).interruptForHandoff).not.toHaveBeenCalled()
    expect(noticeMessages(internal)).toHaveLength(0)
  })

  test('degrades instead of taking the send down when materialization fails', async () => {
    // F1. A preflight OBSERVES dp readiness; it is not entitled to end a turn.
    // An installed-but-not-authorized OAuth plugin made every materialization in
    // the workspace throw `capability-snapshot-revoked`, and this unguarded call
    // turned that into a raw error in place of every answer, for every send,
    // until the app restarted.
    for (const failure of [
      new CapabilityMaterializationError('revoked'),
      new Error('dp-session-state-unstable'),
    ]) {
      const { managed, internal, materializeRuntime } = fixture()
      materializeRuntime.mockImplementation(async () => { throw failure })

      expect(await internal.preflightDpAuth(managed, runtime)).toBe('unavailable')
      expect(managed.pendingAuthRequest).toBeUndefined()
      expect(managed.messages.filter(message => message.role === 'auth-request')).toHaveLength(0)
    }
  })

  test('hands the preflight-observed DP state to the send path materialization', async () => {
    // The preflight and `setSourceServers` sync under the SAME leaser id, so the
    // later call wins. Dropping the state here re-materialized under the
    // `'unavailable'` fallback and evicted the DP servers the preflight had just
    // authorized — with no type error and no other test covering the wiring.
    for (const observed of ['ready', 'unavailable'] as const) {
      const { manager, managed, internal } = fixture()
      const optionCalls: Array<Record<string, unknown> | undefined> = []
      internal.preflightDpAuth = async () => observed
      internal.getOrCreateAgent = async () => ({
        isProcessing: () => false,
        setAutomationSystem() {},
        setCapabilityTurnRuntime() {},
        drainAutomationEvents: async () => {},
        postInit: async () => ({}),
        setAllSources() {},
        setSourceServers: async (
          _mcp: unknown,
          _api: unknown,
          _slugs: unknown,
          options?: Record<string, unknown>,
        ) => { optionCalls.push(options) },
        getModel: () => 'test-model',
        chat: () => (async function* () {})(),
        getSessionId: () => undefined,
        endLifecycle: async () => {},
        forceAbort() {},
        dispose() {},
      })
      internal.acquireCapabilityTurn = async () => () => {}
      internal.createCapabilityTurn = async () => ({
        runtime,
        snapshot: { leaseId: 'lease-dp-send' },
      })
      internal.createRetainedCapabilityLease = () => ({ retain: () => () => {}, release() {} })
      managed.isProcessing = false

      await manager.sendMessage(
        managed.id, 'use dp', undefined, undefined, undefined, undefined, undefined, undefined,
        { workspaceId: managed.workspace.id },
      )

      // Asserts the VALUE, both times: a hardcoded `'ready'` would pass the first
      // iteration and fail the second.
      expect(optionCalls[0]).toMatchObject({ awaitConnect: false, dpSessionState: observed })
      // `getOrCreateAgent` is stubbed, so `managed.agent` is still the fixture's
      // minimal mock; teardown would call lifecycle methods it does not have.
      managed.agent = null as never
      await manager.cleanup()
    }
  })
})

describe('SessionManager DP auth settlement', () => {
  function pendingDp(result = fixture()) {
    const { managed, internal } = result
    const request = {
      type: 'dp' as const,
      provider: 'dp' as const,
      requestId: 'request-dp',
      sessionId: managed.id,
      sourceSlug: 'dp',
      sourceName: 'Developer Platform',
    }
    managed.pendingAuthRequestId = request.requestId
    managed.pendingAuthRequest = request
    managed.messages.push({
      id: 'auth-dp',
      role: 'auth-request',
      content: 'Sign in to Developer Platform',
      timestamp: 2,
      authRequestId: request.requestId,
      authRequestType: 'dp',
      authSourceSlug: 'dp',
      authSourceName: 'Developer Platform',
      authStatus: 'pending',
    })
    managed.dpAuthReplay = {
      workspaceId: managed.workspace.id,
      sessionId: managed.id,
      userMessageId: originalTurn.userMessageId,
      pendingRequestId: request.requestId,
      processingGeneration: managed.processingGeneration,
      message: originalTurn.message,
      modelMessage: originalTurn.modelMessage,
      attachments: originalTurn.attachments,
      storedAttachments: originalTurn.storedAttachments,
      options: originalTurn.options,
    }
    internal.sendMessage = mock(async () => {})
    internal.workspaceMcpPools.invalidateWorkspace = mock(() => {})
    return result
  }

  test('success settles, invalidates, resyncs, and replays the original user turn once', async () => {
    const { manager, managed, internal, invalidate } = pendingDp()

    await manager.completeAuthRequest(managed.id, {
      requestId: 'request-dp',
      sourceSlug: 'dp',
      success: true,
    }, managed.workspace.id)
    await expect(manager.completeAuthRequest(managed.id, {
      requestId: 'request-dp',
      sourceSlug: 'dp',
      success: true,
    }, managed.workspace.id)).rejects.toThrow('dp-auth-stale')

    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(internal.workspaceMcpPools.invalidateWorkspace).toHaveBeenCalledWith(managed.workspace.id)
    expect(internal.sendMessage).toHaveBeenCalledTimes(1)
    expect(internal.sendMessage.mock.calls[0]?.[1]).toBe(originalTurn.message)
    expect(internal.sendMessage.mock.calls[0]?.[5]).toBe(originalTurn.userMessageId)
    expect(internal.sendMessage.mock.calls[0]?.[9]).toBe(originalTurn.modelMessage)
    expect(managed.dpAuthReplay).toBeUndefined()
  })

  test('a failed attempt is terminal but keeps the same request retryable without a DP tool turn', async () => {
    const { manager, managed, internal } = pendingDp()

    await manager.completeAuthRequest(managed.id, {
      requestId: 'request-dp',
      sourceSlug: 'dp',
      success: false,
      error: 'ExecFailed',
    }, managed.workspace.id)

    expect(internal.sendMessage).not.toHaveBeenCalled()
    expect(managed.pendingAuthRequest?.requestId).toBe('request-dp')
    expect(managed.dpAuthReplay?.pendingRequestId).toBe('request-dp')
    expect(managed.messages.find(message => message.id === 'auth-dp')?.authStatus).toBe('failed')
  })

  test('coalesces concurrent ensure attempts and permits a later retry', async () => {
    let attempt = 0
    const ensure = mock(async () => {
      attempt += 1
      await Promise.resolve()
      if (attempt === 1) throw new DpAuthServiceError(DpAuthError.ExecFailed)
      return { state: 'ready' as const, version: null, outdated: false as const }
    })
    const broker = {
      probe: async () => ({ state: 'needs-login' as const, version: null, outdated: false as const }),
      subscribe: () => () => {},
      ensure,
      cancel: mock(() => true),
    }
    const { manager, managed, internal } = pendingDp(fixture(broker))

    const first = manager.ensureDpAuth(managed.id, 'request-dp', managed.workspace.id)
    const second = manager.ensureDpAuth(managed.id, 'request-dp', managed.workspace.id)

    expect(await Promise.all([first, second])).toEqual([
      { ok: false, code: DpAuthError.ExecFailed },
      { ok: false, code: DpAuthError.ExecFailed },
    ])
    expect(ensure).toHaveBeenCalledTimes(1)
    expect(internal.persistSession).toHaveBeenCalledTimes(1)
    expect(internal.sendEvent).toHaveBeenCalledTimes(1)
    expect(internal.sendMessage).not.toHaveBeenCalled()

    expect(await manager.ensureDpAuth(
      managed.id,
      'request-dp',
      managed.workspace.id,
    )).toEqual({ ok: true })
    expect(ensure).toHaveBeenCalledTimes(2)
    expect(internal.sendMessage).toHaveBeenCalledTimes(1)
  })

  test('cancel clears pending state and never resumes the DP tool turn', async () => {
    const { manager, managed, internal } = pendingDp()

    await manager.completeAuthRequest(managed.id, {
      requestId: 'request-dp',
      sourceSlug: 'dp',
      success: false,
      cancelled: true,
    }, managed.workspace.id)

    expect(internal.sendMessage).not.toHaveBeenCalled()
    expect(managed.pendingAuthRequest).toBeUndefined()
    expect(managed.dpAuthReplay).toBeUndefined()
    expect(managed.messages.find(message => message.id === 'auth-dp')?.authStatus).toBe('cancelled')
  })

  test('routes a generic OAuth request whose source slug is dp through generic completion', async () => {
    const { manager, managed, internal } = fixture()
    managed.pendingAuthRequestId = 'request-oauth'
    managed.pendingAuthRequest = {
      type: 'oauth',
      provider: 'oauth',
      requestId: 'request-oauth',
      sessionId: managed.id,
      sourceSlug: 'dp',
      sourceName: 'DP-named OAuth source',
    } as never
    managed.messages.push({
      id: 'auth-oauth',
      role: 'auth-request',
      content: 'Sign in to the source',
      timestamp: 2,
      authRequestId: 'request-oauth',
      authRequestType: 'oauth',
      authSourceSlug: 'dp',
      authSourceName: 'DP-named OAuth source',
      authStatus: 'pending',
    })
    internal.sendMessage = mock(async () => {})

    await manager.completeAuthRequest(managed.id, {
      requestId: 'request-oauth',
      sourceSlug: 'dp',
      success: true,
    }, managed.workspace.id)

    expect(managed.messages.find(message => message.id === 'auth-oauth')?.authStatus).toBe('completed')
    expect(managed.pendingAuthRequest).toBeUndefined()
    expect(internal.sendMessage).toHaveBeenCalledTimes(1)
  })

  test('rejects a success completion whose processing generation is stale', async () => {
    const { manager, managed, internal } = pendingDp()
    managed.processingGeneration += 1

    await expect(manager.completeAuthRequest(managed.id, {
      requestId: 'request-dp',
      sourceSlug: 'dp',
      success: true,
    }, managed.workspace.id)).rejects.toThrow('dp-auth-stale')
    expect(internal.sendMessage).not.toHaveBeenCalled()
  })

  test('retries the same pending request with the same broker owner and replays only after success', async () => {
    const owners: string[] = []
    let attempt = 0
    const broker = {
      probe: async () => ({ state: 'needs-login' as const, version: null, outdated: false as const }),
      subscribe: () => () => {},
      ensure: mock(async (options?: Parameters<DpSessionBroker['ensure']>[0]) => {
        owners.push(options?.ownerId ?? '')
        attempt += 1
        if (attempt === 1) throw new DpAuthServiceError(DpAuthError.ExecFailed)
        return { state: 'ready' as const, version: null, outdated: false as const }
      }),
      cancel: mock(() => true),
    }
    const { manager, managed, internal } = pendingDp(fixture(broker))

    expect(await manager.ensureDpAuth(
      managed.id,
      'request-dp',
      managed.workspace.id,
    )).toEqual({ ok: false, code: DpAuthError.ExecFailed })
    expect(managed.pendingAuthRequest?.requestId).toBe('request-dp')
    expect(internal.sendMessage).not.toHaveBeenCalled()

    expect(await manager.ensureDpAuth(
      managed.id,
      'request-dp',
      managed.workspace.id,
    )).toEqual({ ok: true })
    expect(owners).toHaveLength(2)
    expect(owners[0]).toBe(owners[1])
    expect(internal.sendMessage).toHaveBeenCalledTimes(1)
  })

  test('settles an unavailable interactive broker as a retryable stable failure', async () => {
    const { manager, managed, internal } = pendingDp()

    expect(await manager.ensureDpAuth(
      managed.id,
      'request-dp',
      managed.workspace.id,
    )).toEqual({
      ok: false,
      code: DpAuthError.InteractiveLoginUnavailable,
    })
    expect(managed.pendingAuthRequest?.requestId).toBe('request-dp')
    expect(managed.dpAuthReplay?.pendingRequestId).toBe('request-dp')
    expect(managed.messages.find(message => message.id === 'auth-dp')?.authStatus).toBe('failed')
    expect(internal.sendMessage).not.toHaveBeenCalled()
  })

  test('cancels through the request owner and clears the replay without resuming', async () => {
    const cancel = mock(() => true)
    const broker = {
      probe: async () => ({ state: 'needs-login' as const, version: null, outdated: false as const }),
      subscribe: () => () => {},
      ensure: async () => ({ state: 'ready' as const, version: null, outdated: false as const }),
      cancel,
    }
    const { manager, managed, internal } = pendingDp(fixture(broker))

    expect(await manager.cancelDpAuth(
      managed.id,
      'request-dp',
      managed.workspace.id,
    )).toEqual({ ok: false, code: DpAuthError.Cancelled })
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(managed.pendingAuthRequest).toBeUndefined()
    expect(managed.dpAuthReplay).toBeUndefined()
    expect(internal.sendMessage).not.toHaveBeenCalled()
  })

  test('session stop clears an idle DP handoff through the same request owner', async () => {
    const cancel = mock(() => true)
    const broker = {
      probe: async () => ({ state: 'needs-login' as const, version: null, outdated: false as const }),
      subscribe: () => () => {},
      ensure: async () => ({ state: 'ready' as const, version: null, outdated: false as const }),
      cancel,
    }
    const { manager, managed, internal } = pendingDp(fixture(broker))
    managed.isProcessing = false

    await manager.cancelProcessing(managed.id, false, managed.workspace.id)

    expect(cancel).toHaveBeenCalledTimes(1)
    expect(managed.pendingAuthRequest).toBeUndefined()
    expect(managed.dpAuthReplay).toBeUndefined()
    expect(internal.sendMessage).not.toHaveBeenCalled()
  })

  test('rejects a second user turn before it can stale the pending handoff, then Stop cancels it', async () => {
    const cancel = mock(() => true)
    const broker = {
      probe: async () => ({ state: 'needs-login' as const, version: null, outdated: false as const }),
      subscribe: () => () => {},
      ensure: async () => ({ state: 'ready' as const, version: null, outdated: false as const }),
      cancel,
    }
    const { manager, managed, internal } = pendingDp(fixture(broker))
    managed.isProcessing = false
    const generation = managed.processingGeneration
    const userMessages = managed.messages.filter(message => message.role === 'user').length

    await expect(SessionManager.prototype.sendMessage.call(
      manager,
      managed.id,
      'second user turn',
      [],
      [],
      {},
      undefined,
      undefined,
      undefined,
      { workspaceId: managed.workspace.id },
    )).rejects.toThrow('dp-auth-pending')

    expect(managed.processingGeneration).toBe(generation)
    expect(managed.messages.filter(message => message.role === 'user')).toHaveLength(userMessages)

    await manager.cancelProcessing(managed.id, false, managed.workspace.id)

    expect(cancel).toHaveBeenCalledTimes(1)
    expect(managed.pendingAuthRequest).toBeUndefined()
    expect(managed.dpAuthReplay).toBeUndefined()
    expect(internal.sendMessage).not.toHaveBeenCalled()
  })

  test('normalizes orphaned actionable DP cards without touching generic auth cards', () => {
    const { managed, internal } = fixture()
    managed.messages.push(
      {
        id: 'auth-dp-pending',
        role: 'auth-request',
        content: 'Sign in',
        timestamp: 2,
        authRequestId: 'request-pending',
        authRequestType: 'dp',
        authSourceSlug: 'dp',
        authSourceName: 'Developer Platform',
        authStatus: 'pending',
      },
      {
        id: 'auth-dp-failed',
        role: 'auth-request',
        content: 'Retry sign in',
        timestamp: 3,
        authRequestId: 'request-failed',
        authRequestType: 'dp',
        authSourceSlug: 'dp',
        authSourceName: 'Developer Platform',
        authStatus: 'failed',
      },
      {
        id: 'auth-oauth-pending',
        role: 'auth-request',
        content: 'OAuth',
        timestamp: 4,
        authRequestId: 'request-oauth',
        authRequestType: 'oauth',
        authSourceSlug: 'source',
        authSourceName: 'Source',
        authStatus: 'pending',
      },
    )

    expect(internal.normalizeOrphanedDpAuthCards(managed)).toBe(true)
    expect(managed.messages.find(message => message.id === 'auth-dp-pending')).toMatchObject({
      authStatus: 'cancelled',
      authError: DpAuthError.Cancelled,
    })
    expect(managed.messages.find(message => message.id === 'auth-dp-failed')).toMatchObject({
      authStatus: 'cancelled',
      authError: DpAuthError.Cancelled,
    })
    expect(managed.messages.find(message => message.id === 'auth-oauth-pending')?.authStatus).toBe('pending')
  })

  test('reload durably normalizes a persisted DP card that has no server-only replay', async () => {
    const { managed, internal } = fixture()
    managed.messages = []
    managed.messagesLoaded = false
    internal.sessionStore.load = mock(() => ({
      id: managed.id,
      workspaceId: managed.workspace.id,
      messages: [{
        id: 'auth-dp-reloaded',
        role: 'auth-request',
        content: 'Sign in',
        timestamp: 2,
        authRequestId: 'request-reloaded',
        authRequestType: 'dp',
        authSourceSlug: 'dp',
        authSourceName: 'Developer Platform',
        authStatus: 'failed',
      }],
    }))

    await internal.loadMessagesFromDisk(managed)

    expect(managed.messages.find(message => message.id === 'auth-dp-reloaded')).toMatchObject({
      authStatus: 'cancelled',
      authError: DpAuthError.Cancelled,
    })
    expect(internal.persistSession).toHaveBeenCalledWith(managed, true)
    expect(internal.flushSession).toHaveBeenCalledWith(
      managed.id,
      managed.workspace.id,
      { strict: true },
    )
  })

  test('cleanup settlement persists a terminal card before discarding replay state', async () => {
    const { managed, internal } = pendingDp()

    await internal.settleDpAuthForCleanup(managed)

    expect(managed.messages.find(message => message.id === 'auth-dp')).toMatchObject({
      authStatus: 'cancelled',
      authError: DpAuthError.Cancelled,
    })
    expect(managed.pendingAuthRequest).toBeUndefined()
    expect(managed.dpAuthReplay).toBeUndefined()
    expect(internal.persistSession).toHaveBeenCalledWith(managed, true)
    expect(internal.flushSession).toHaveBeenCalledWith(
      managed.id,
      managed.workspace.id,
      { strict: true },
    )
  })
})

// T3 (plugin-install plan): the standalone probe is the seam that lets a
// completed SYSTEM dp sign-in reach the pool registry (broker publish →
// observeDpSessionState → resync) without a chat message or an auth card.
describe('SessionManager DP session probe', () => {
  test('probes the broker and returns the value-only state', async () => {
    const probe = mock(async () => ({ state: 'ready' as const, version: '1.0.0', outdated: false }))
    const { manager } = fixtureWithBroker({ probe, subscribe: () => () => undefined })

    await expect(manager.probeDpSessionState()).resolves.toBe('ready')
    expect(probe).toHaveBeenCalledTimes(1)
  })

  test('maps error/unavailable broker states to unavailable, and a throw never escapes', async () => {
    const errorBroker = {
      probe: async () => ({ state: 'error' as const, code: DpAuthError.ExecFailed }),
      subscribe: () => () => undefined,
    }
    await expect(fixtureWithBroker(errorBroker).manager.probeDpSessionState())
      .resolves.toBe('unavailable')

    const throwingBroker = {
      probe: async () => { throw new DpAuthServiceError(DpAuthError.ExecFailed) },
      subscribe: () => () => undefined,
    }
    await expect(fixtureWithBroker(throwingBroker).manager.probeDpSessionState())
      .resolves.toBe('unavailable')
  })
})

function fixtureWithBroker(
  dpSessionBroker: Pick<DpSessionBroker, 'probe' | 'subscribe'>,
): { manager: SessionManager } {
  return {
    manager: createTestSessionManager({
      dpSessionBroker: dpSessionBroker as SessionManagerRuntimeDependenciesBroker,
    }),
  }
}

type SessionManagerRuntimeDependenciesBroker =
  Parameters<typeof createTestSessionManager>[0] extends { dpSessionBroker?: infer T } ? T : never

/**
 * F1's second user-visible consequence. An `authType: oauth` plugin MCP server
 * is signed into through the session-start pending-auth notice, and that notice
 * is the ONLY entry point the product ships for it. The summary that feeds it
 * already failed soft — so a revoked lease produced an EMPTY summary, which
 * renders no notice, which is indistinguishable from "nothing needs signing in".
 * Installing Figma therefore removed the ability to authorize Figma.
 *
 * Failing soft is not the fix here: re-resolving is.
 */
describe('workspace pending-auth summary survives a moved capability generation', () => {
  const oauthRequirement = {
    provider: 'oauth' as const,
    wireNames: ['figma'],
    pluginInstanceIds: ['plugin://figma'],
    state: 'needs-login' as const,
    servers: [{ wireName: 'figma', pluginKey: 'registry.figma', serverName: 'figma' }],
  }

  /** `revokedResolves` snapshots read as revoked; every later one is live. */
  function summaryFixture(revokedResolves: number) {
    const base = fixture()
    const { internal, managed } = base
    let resolves = 0
    const revoked = new Set<string>()
    internal.resolveWorkspace = () => managed.workspace
    internal.capabilityResolver = {
      resolve: async () => {
        resolves += 1
        const leaseId = `lease-${resolves}`
        if (resolves <= revokedResolves) revoked.add(leaseId)
        return { context: {}, generation: `g-${resolves}`, leaseId, entries: [], installedPlugins: [], diagnostics: [] }
      },
      releaseSnapshot: () => {},
      invalidate: () => {},
      isLeaseActive: (leaseId: string) => !revoked.has(leaseId),
      referencedInstances: () => new Set(),
      leaseCount: () => 0,
    }
    internal.workspaceMcpPools.lease = () => ({
      key: { workspaceId: managed.workspace.id },
      pool: { health: () => ({ status: 'ready', connected: [], failed: [] }), authNeededSlugs: () => [] },
      leaserId: 'browse',
      ensureSynced: async () => {},
      materializeRuntime: async () => ({
        sources: [],
        mcpServers: {},
        apiServers: {},
        mergedMcpServers: {},
        externalAuthRequirements: [oauthRequirement],
      }),
      release: async () => {},
    })
    return { ...base, resolveCount: () => resolves }
  }

  test('re-resolves once and still names the server awaiting sign-in', async () => {
    const { manager, resolveCount } = summaryFixture(1)

    const summary = await manager.getWorkspacePendingAuth('workspace-dp')

    expect(resolveCount()).toBe(2)
    expect(summary.sources).toEqual([{
      workspaceId: 'workspace-dp',
      sourceSlug: 'figma',
      name: 'figma',
      reason: 'needs-auth',
      // The one-click sign-in target. Without this row the plugin cannot be
      // authorized anywhere in the product.
      canSignIn: true,
      pluginServer: { pluginKey: 'registry.figma', serverName: 'figma' },
    }])
  })

  test('reports empty only when the re-resolve is revoked too', async () => {
    const { manager, resolveCount } = summaryFixture(Number.POSITIVE_INFINITY)

    const summary = await manager.getWorkspacePendingAuth('workspace-dp')

    expect(resolveCount()).toBe(2)
    expect(summary).toEqual({ sources: [], failedServers: [] })
  })
})

/**
 * T8 review gap (Important finding): `resolveWorkspacePendingAuth` probes the
 * dp session broker and threads `dpOutdated` into `buildPendingAuthSummary`,
 * but every existing test drove either `buildPendingAuthSummary` directly or a
 * broker hardcoded to `outdated: false` — so a dropped argument, or a broken
 * `'outdated' in dpState` narrowing, would stay green while the hint silently
 * stopped appearing in production. This drives the wiring through the real
 * public entry point instead of the pure summary builder.
 *
 * Final-review fix: the probe now only runs when a server failed (see the
 * sibling describe block below), so this fixture needs a non-empty `failed`
 * list to keep exercising the outdated-probe wiring at all — a workspace with
 * nothing failed would never reach `this.dpSessionBroker.probe()` regardless
 * of what the broker returns, and the assertion would pass for the wrong
 * reason (or not at all). The fixture is adjusted; the assertion's intent
 * (an outdated probe rides through as `dpOutdated`) is unchanged.
 */
describe('workspace pending-auth summary carries the dp-outdated probe hint', () => {
  test('an outdated dp probe rides through getWorkspacePendingAuth as dpOutdated', async () => {
    const broker = {
      probe: async () => ({ state: 'needs-login' as const, version: '1.0.0', outdated: true }),
      subscribe: () => () => undefined,
      ensure: async () => { throw new Error('unused') },
      cancel: () => { throw new Error('unused') },
    }
    const { manager, managed, internal } = fixture(broker)
    internal.resolveWorkspace = () => managed.workspace
    internal.capabilityResolver = {
      resolve: async () => ({
        context: {},
        generation: 'g-outdated',
        leaseId: 'lease-outdated',
        entries: [],
        installedPlugins: [],
        diagnostics: [],
      }),
      releaseSnapshot: () => {},
      invalidate: () => {},
      isLeaseActive: () => true,
      referencedInstances: () => new Set(),
      leaseCount: () => 0,
    }
    internal.workspaceMcpPools.lease = () => ({
      key: { workspaceId: managed.workspace.id },
      // Non-empty `failed`: the probe only runs when a failed server makes
      // its result renderable (PendingAuthNotice.tsx gates on
      // `failedServers.length > 0 && dpOutdated`).
      pool: { health: () => ({ status: 'ready', connected: [], failed: ['broken-server'] }), authNeededSlugs: () => [] },
      leaserId: 'browse',
      ensureSynced: async () => {},
      materializeRuntime: async () => ({
        sources: [],
        mcpServers: {},
        apiServers: {},
        mergedMcpServers: {},
        externalAuthRequirements: [],
      }),
      release: async () => {},
    })

    const summary = await manager.getWorkspacePendingAuth('workspace-dp')

    expect(summary.dpOutdated).toBe(true)
    expect(summary.failedServers).toEqual(['broken-server'])
  })
})

/**
 * Final-review finding 3 (dp-auth-resilience): the probe is two dp execs (5s
 * timeouts each) and a non-'ready' result is deliberately never cached
 * (session-broker.ts), yet the hint it feeds only ever renders alongside a
 * failed server (`PendingAuthNotice.tsx`). Unconditionally probing therefore
 * re-executed dp on every signed-out banner refresh for a result the UI could
 * never show. `resolveWorkspacePendingAuth` now computes the failed slugs
 * first and probes only when that list is non-empty.
 */
describe('workspace pending-auth summary probes dp only when something failed', () => {
  function dpProbeFixture(failedSlugs: string[]) {
    let probeCalls = 0
    const broker = {
      probe: async () => {
        probeCalls += 1
        return { state: 'needs-login' as const, version: '1.0.0', outdated: true }
      },
      subscribe: () => () => undefined,
      ensure: async () => { throw new Error('unused') },
      cancel: () => { throw new Error('unused') },
    }
    const base = fixture(broker)
    const { internal, managed } = base
    internal.resolveWorkspace = () => managed.workspace
    internal.capabilityResolver = {
      resolve: async () => ({
        context: {},
        generation: 'g-probe-gate',
        leaseId: 'lease-probe-gate',
        entries: [],
        installedPlugins: [],
        diagnostics: [],
      }),
      releaseSnapshot: () => {},
      invalidate: () => {},
      isLeaseActive: () => true,
      referencedInstances: () => new Set(),
      leaseCount: () => 0,
    }
    internal.workspaceMcpPools.lease = () => ({
      key: { workspaceId: managed.workspace.id },
      pool: { health: () => ({ status: 'ready', connected: [], failed: failedSlugs }), authNeededSlugs: () => [] },
      leaserId: 'browse',
      ensureSynced: async () => {},
      materializeRuntime: async () => ({
        sources: [],
        mcpServers: {},
        apiServers: {},
        mergedMcpServers: {},
        externalAuthRequirements: [],
      }),
      release: async () => {},
    })
    return { ...base, probeCalls: () => probeCalls }
  }

  test('no failed servers: the probe never runs and dpOutdated is omitted', async () => {
    const { manager, probeCalls } = dpProbeFixture([])

    const summary = await manager.getWorkspacePendingAuth('workspace-dp')

    expect(probeCalls()).toBe(0)
    expect(summary.dpOutdated).toBeUndefined()
  })

  test('a failed server: the probe runs and dpOutdated rides through', async () => {
    const { manager, probeCalls } = dpProbeFixture(['broken-server'])

    const summary = await manager.getWorkspacePendingAuth('workspace-dp')

    expect(probeCalls()).toBe(1)
    expect(summary.dpOutdated).toBe(true)
    expect(summary.failedServers).toEqual(['broken-server'])
  })
})

/**
 * F1.1151 — a Pi Guardian judge child (its own `piChildRestrictions` led by
 * GUARDIAN_POLICY_PROMPT, the isHostConsultRecord identity) runs no dp preflight:
 * the preflight's background sync connected the built-in dp servers under the
 * judge's leaser for the moment before F1.893's empty set superseded it.
 */
describe('F1.1151 — no dp preflight under a Guardian judge child', () => {
  test('a judge child materializes nothing, syncs nothing and says nothing', async () => {
    const { GUARDIAN_POLICY_PROMPT } = await import('@nessy-agent/shared/prompts/guardian')
    const { managed, internal, materializeRuntime, sync } = fixture()
    materializeRuntime.mockImplementation(async () => materialized('ready'))
    managed.piChildRestrictions = { prompt: `${GUARDIAN_POLICY_PROMPT}\n\nJudge this.` } as never

    expect(await internal.preflightDpAuth(managed, runtime)).toBe('unavailable')
    expect(materializeRuntime).not.toHaveBeenCalled()
    expect(sync).not.toHaveBeenCalled()
    expect(noticeMessages(internal)).toHaveLength(0)
  })

  test('CONTROL: an ordinary subagent child still observes dp and syncs the ready lease', async () => {
    const { managed, internal, materializeRuntime, sync } = fixture()
    materializeRuntime.mockImplementation(async () => materialized('ready'))
    managed.piChildRestrictions = { prompt: 'You are scout, a read-only explorer.' } as never

    expect(await internal.preflightDpAuth(managed, runtime)).toBe('ready')
    expect(materializeRuntime).toHaveBeenCalledWith(runtime)
    expect(sync).toHaveBeenCalledTimes(1)
  })
})
