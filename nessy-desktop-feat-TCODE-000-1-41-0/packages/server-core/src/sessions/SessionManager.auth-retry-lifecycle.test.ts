import { describe, expect, mock, test } from 'bun:test'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { DpAuthError, DpAuthServiceError } from '@nessy-agent/shared/auth/dp'
import { providerTypeToAgentProvider } from '@nessy-agent/shared/agent/backend'
import { SessionManager, createManagedSession } from './SessionManager.ts'
import { createTestSessionManager } from './__tests__/test-session-manager.ts'

/**
 * Mirrors `NESSY_GATEWAY_BASE_URL`
 * (apps/electron/src/renderer/components/apisetup/nessy-gateway.ts), also
 * documented in AGENTS.md's "Gateway Facts". Kept as a local literal so this
 * server-core test does not reach into the renderer package for one string.
 */
const NESSY_GATEWAY_BASE_URL = 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

function harnessDiagnostics() {
  return {
    surfaceVersion: 2 as const,
    generation: 'generation-auth-retry',
    manifestHash: 'manifest-auth-retry',
    provenance: [],
    contextProfile: 'normal' as const,
    responseEpoch: 1,
  }
}

function authRetryFixture() {
  const manager = createTestSessionManager()
  const workspace = {
    id: 'workspace-auth-retry',
    name: 'Auth retry',
    rootPath: '/tmp/auth-retry',
    createdAt: 1,
  }
  const managed = createManagedSession(
    { id: 'session-auth-retry', name: 'Auth retry' },
    workspace,
    { messagesLoaded: true },
  )
  managed.ephemeral = true
  managed.isProcessing = true
  managed.lastSentMessage = 'retry this message'
  managed.lastSentModelMessage = 'retry this model message'
  managed.envOverrides = { AUTH_RETRY_ENV: 'preserved' }
  managed.messages.push({
    id: 'user-message',
    role: 'user',
    content: managed.lastSentMessage,
    timestamp: 1,
  })
  managed.lastSentUserMessageId = 'user-message'
  managed.piBackgroundTaskKinds?.set('workflow-1', 'workflow')
  managed.childSessionState = {
    schemaVersion: 1,
    revision: 1,
    sealedOwnerTaskIds: [],
    children: [{
      schemaVersion: 1,
      agentId: 'child-1',
      parentSessionKey: { workspaceId: workspace.id, sessionId: managed.id },
      childSessionKey: { workspaceId: workspace.id, sessionId: 'child-session-1' },
      agent: 'worker',
      task: 'child task',
      restrictions: {
        prompt: 'child task',
        model: 'test-model',
        tools: [],
        thinkingLevel: 'off',
        worktreePolicy: 'shared',
      },
      budgets: {
        depth: 1,
        maxDepth: 1,
        fanout: 1,
        concurrency: 1,
        tokenLimit: 1,
        costLimitUsd: 1,
        deadlineAt: 2,
        ancestry: [],
      },
      status: 'running',
      background: true,
      output: '',
      createdAt: 1,
      updatedAt: 1,
    }],
  }

  const internal = manager as any
  internal.sessions.set(encodeSessionKey({
    workspaceId: managed.workspace.id,
    sessionId: managed.id,
  }), managed)
  internal.resolveManagedProvider = () => 'pi'
  internal.sendEvent = mock(() => {})

  return {
    manager,
    managed,
    internal,
    cleanup: async () => {
      internal.sessions.clear()
      await manager.cleanup()
    },
  }
}

describe('SessionManager auth retry lifecycle', () => {
  test('reserves the session synchronously and retries the exact failed turn snapshot', async () => {
    const fixture = authRetryFixture()
    const { managed, internal } = fixture
    const retried = deferred()
    managed.piBackgroundTaskKinds?.clear()
    managed.childSessionState!.children[0]!.status = 'stopped'
    managed.messages.push({
      id: 'newer-queued-user',
      role: 'user',
      content: 'newer queued message',
      timestamp: 2,
    })
    managed.agent = {
      forceAbort: () => {},
    } as never
    internal.strictDrainPiSession = mock(async () => {
      managed.agent = null
    })
    let retryArgs: unknown[] = []
    internal.sendMessage = mock(async (...args: unknown[]) => {
      retryArgs = args
      retried.resolve()
    })

    try {
      expect(internal.attemptAuthRetry(
        managed.id,
        managed,
        managed.workspace.id,
        'expired_oauth_token',
      )).toBe(true)
      expect(internal.projectMutationSessions.has(encodeSessionKey({
        workspaceId: managed.workspace.id,
        sessionId: managed.id,
      }))).toBe(true)

      managed.lastSentMessage = 'overwritten after reservation'
      managed.lastSentModelMessage = 'overwritten model'
      await retried.promise

      expect(retryArgs[1]).toBe('retry this message')
      expect(retryArgs[9]).toBe('retry this model message')
      expect(managed.messages.some(message => message.id === 'user-message')).toBe(false)
      expect(managed.messages.some(message => message.id === 'newer-queued-user')).toBe(true)
    } finally {
      await fixture.cleanup()
    }
  })

  test('awaits evaluator, child, and process settlement before replacement', async () => {
    const fixture = authRetryFixture()
    const { manager, managed, internal } = fixture
    const disposalStarted = deferred()
    const releaseSettlement = deferred()
    const replacementStarted = deferred()
    const evaluator = new AbortController()
    const sequence: string[] = []
    let processRunning = true

    internal.piProcessSupervisor = {
      drainSession: async () => {
        if (processRunning) throw new Error('process-still-running')
      },
      // P2.210 — the strict drain's residual sweep takes the COUNT here (uncapped)
      // and uses `snapshot` only to name handles, so the two must agree: a stub
      // that answers one and not the other makes the drain throw a TypeError
      // instead of reporting the running process this fixture is about.
      countActive: async () => processRunning ? 1 : 0,
      snapshot: async () => processRunning ? [{
        handle: 'process-1',
        semanticId: 'bash',
        startedAt: 1,
        deadlineAt: 2,
        status: 'running',
        exitCode: null,
        signal: null,
        isolationProfile: 'workspace',
        nextCursor: 0,
      }] : [],
    }

    const failedAgent = {
      captureLifecycleState: () => ({
        sessionStartEmitted: true,
        sessionEndEmitted: false,
        sessionStartHooksApplied: true,
      }),
      dispose: () => {},
      disposeForRestart: async () => {
        evaluator.abort()
        sequence.push('abort')
        disposalStarted.resolve()
        await releaseSettlement.promise
        managed.childSessionState!.children[0]!.status = 'stopped'
        processRunning = false
        sequence.push('settled')
      },
      drainAutomationEvents: async () => {},
      getHarnessDiagnostics: harnessDiagnostics,
      setAutomationSystem: () => {},
      setCapabilityTurnRuntime: () => {},
    }
    managed.agent = failedAgent as never

    let beforeReplacementSettlement: unknown
    internal.sendMessage = mock(async () => {
      beforeReplacementSettlement = (
        await manager.getPiHarnessRuntimeSnapshot({
          workspaceId: managed.workspace.id,
          sessionId: managed.id,
        })
      ).settlement
      sequence.push('replacement')
      managed.agent = { getHarnessDiagnostics: harnessDiagnostics } as never
      replacementStarted.resolve()
    })

    try {
      expect(internal.attemptAuthRetry(
        managed.id,
        managed,
        managed.workspace.id,
        'expired_oauth_token',
      )).toBe(true)
      await disposalStarted.promise

      const whileDisposing = await manager.getPiHarnessRuntimeSnapshot({
        workspaceId: managed.workspace.id,
        sessionId: managed.id,
      })
      expect(evaluator.signal.aborted).toBe(true)
      expect((managed as any).agent).toBe(failedAgent)
      expect(internal.sendMessage).not.toHaveBeenCalled()
      expect(whileDisposing.settlement).toEqual({
        schemaVersion: 1,
        settled: false,
        pending: ['foreground_model_turn', 'workflow_evaluator', 'child', 'process'],
      })

      releaseSettlement.resolve()
      await replacementStarted.promise

      expect(sequence).toEqual(['abort', 'settled', 'replacement'])
      expect(beforeReplacementSettlement).toEqual({
        schemaVersion: 1,
        settled: true,
        pending: [],
      })
      expect(managed.piBackgroundTaskKinds?.size).toBe(0)
      expect(managed.envOverrides).toEqual({ AUTH_RETRY_ENV: 'preserved' })
    } finally {
      releaseSettlement.resolve()
      await fixture.cleanup()
    }
  })

  test('keeps the failed runtime authoritative when strict disposal fails', async () => {
    const fixture = authRetryFixture()
    const { manager, managed, internal } = fixture
    const failureHandled = deferred()
    let processRunning = true

    internal.piProcessSupervisor = {
      drainSession: async () => {
        if (processRunning) throw new Error('process-still-running')
      },
      // P2.210 — the strict drain's residual sweep takes the COUNT here (uncapped)
      // and uses `snapshot` only to name handles, so the two must agree: a stub
      // that answers one and not the other makes the drain throw a TypeError
      // instead of reporting the running process this fixture is about.
      countActive: async () => processRunning ? 1 : 0,
      snapshot: async () => processRunning ? [{
        handle: 'process-1',
        semanticId: 'bash',
        startedAt: 1,
        deadlineAt: 2,
        status: 'running',
        exitCode: null,
        signal: null,
        isolationProfile: 'workspace',
        nextCursor: 0,
      }] : [],
    }
    const failedAgent = {
      captureLifecycleState: () => ({
        sessionStartEmitted: true,
        sessionEndEmitted: false,
        sessionStartHooksApplied: true,
      }),
      dispose: () => {},
      disposeForRestart: async () => { throw new Error('subprocess-settlement-failed') },
      drainAutomationEvents: async () => {},
      getHarnessDiagnostics: harnessDiagnostics,
      setAutomationSystem: () => {},
      setCapabilityTurnRuntime: () => {},
    }
    managed.agent = failedAgent as never
    internal.sendMessage = mock(async () => {})
    internal.onProcessingStopped = mock(async () => {
      managed.isProcessing = false
      failureHandled.resolve()
    })

    try {
      expect(internal.attemptAuthRetry(
        managed.id,
        managed,
        managed.workspace.id,
        'expired_oauth_token',
      )).toBe(true)
      await failureHandled.promise

      expect(internal.sendMessage).not.toHaveBeenCalled()
      expect((managed as any).agent).toBe(failedAgent)
      expect(managed.piBackgroundTaskKinds?.size).toBe(1)
      expect(managed.authRetryInProgress).toBe(false)
      const afterFailure = await manager.getPiHarnessRuntimeSnapshot({
        workspaceId: managed.workspace.id,
        sessionId: managed.id,
      })
      expect(afterFailure.settlement).toEqual({
        schemaVersion: 1,
        settled: false,
        pending: ['workflow_evaluator', 'child', 'process'],
      })
      processRunning = false
    } finally {
      await fixture.cleanup()
    }
  })

  // Finding 2 (T5 review): the gatewayBacked branch and the ensureNessyGatewayAuth
  // call previously had no coverage — authRetryFixture() never set
  // managed.llmConnection, so both were dead in every existing test. These two
  // exercise resolveGatewayAuthRetryConnection + the real gatewayBacked boolean
  // (including the codex-runtime fix) through the injectable seams, without
  // touching real config storage or the @nessy-agent/shared/auth/dp module.
  test('re-mints the gateway JWT before disposing the agent for a codex-runtime gateway-backed connection', async () => {
    const fixture = authRetryFixture()
    const { managed, internal } = fixture
    const retried = deferred()
    const sequence: string[] = []
    managed.agent = {
      forceAbort: () => {},
    } as never
    // codex-runtime specifically: Finding 1's fix. claude-runtime and
    // pi_compat were already classified gateway-backed before this task; a
    // codex-gateway session (slug `codex-gateway`, providerType
    // `codex-runtime` — apps/electron/.../apisetup/nessy-gateway.ts
    // codexGatewayConnectionDefaults) previously fell through to `return`
    // here and replayed the rejected token, which is the bug this pair guards.
    internal.resolveGatewayAuthRetryConnection = () => ({
      slug: 'codex-gateway',
      name: 'Codex (Nessy Gateway)',
      providerType: 'codex-runtime',
      baseUrl: NESSY_GATEWAY_BASE_URL,
      authType: 'api_key_with_endpoint',
      createdAt: 1,
    })
    let gatewayAuthArgs: unknown[] = []
    internal.ensureNessyGatewayAuthForRetry = mock(async (...args: unknown[]) => {
      gatewayAuthArgs = args
      sequence.push('gateway-auth')
      return { jwt: 'test-jwt', username: 'test-user' }
    })
    internal.strictDrainPiSession = mock(async () => {
      sequence.push('dispose')
      managed.agent = null
    })
    internal.sendMessage = mock(async () => {
      sequence.push('retry')
      retried.resolve()
    })

    try {
      expect(internal.attemptAuthRetry(
        managed.id,
        managed,
        managed.workspace.id,
        'expired_oauth_token',
      )).toBe(true)
      await retried.promise

      expect(internal.ensureNessyGatewayAuthForRetry).toHaveBeenCalledTimes(1)
      expect(gatewayAuthArgs[0]).toEqual({ interactive: false, forceRefresh: true })
      expect(sequence).toEqual(['gateway-auth', 'dispose', 'retry'])
    } finally {
      await fixture.cleanup()
    }
  })

  test('does not re-mint the gateway JWT for a non-gateway-backed (BYO) connection', async () => {
    const fixture = authRetryFixture()
    const { managed, internal } = fixture
    const retried = deferred()
    managed.agent = {
      forceAbort: () => {},
    } as never
    internal.resolveGatewayAuthRetryConnection = () => ({
      slug: 'byo-claude',
      name: 'My Own Claude Endpoint',
      providerType: 'claude-runtime',
      baseUrl: 'https://byo.example.com/v1',
      authType: 'api_key_with_endpoint',
      createdAt: 1,
    })
    internal.ensureNessyGatewayAuthForRetry = mock(async () => ({ jwt: 'test-jwt', username: 'test-user' }))
    internal.strictDrainPiSession = mock(async () => {
      managed.agent = null
    })
    internal.sendMessage = mock(async () => {
      retried.resolve()
    })

    try {
      expect(internal.attemptAuthRetry(
        managed.id,
        managed,
        managed.workspace.id,
        'expired_oauth_token',
      )).toBe(true)
      await retried.promise

      expect(internal.ensureNessyGatewayAuthForRetry).not.toHaveBeenCalled()
      expect(internal.strictDrainPiSession).toHaveBeenCalledTimes(1)
      expect(internal.sendMessage).toHaveBeenCalledTimes(1)
    } finally {
      await fixture.cleanup()
    }
  })

  // DA1.31 (the negative that pins what the row CHANGED). The classification
  // above used to read `!connection.baseUrl || isNessyGatewayBaseUrl(...)`, so a
  // connection of one of the three gateway provider types with NO endpoint at
  // all counted as gateway-backed and got a forced re-mint. The exported
  // predicate is the STRICT form and that arm is gone on purpose: DA1.4 made a
  // wide guess non-harmless, because a forced re-mint that FAILS now raises a
  // full-screen dp sign-in card, and a card about dp cannot fix a 401 from a
  // connection that names no gateway endpoint. Nothing real is lost — all three
  // one-click cards always carry the gateway base URL, which is what the
  // codex-runtime positive above asserts.
  test('does not re-mint for a gateway provider type with NO endpoint at all (DA1.31)', async () => {
    const fixture = authRetryFixture()
    const { managed, internal } = fixture
    const retried = deferred()
    managed.agent = {
      forceAbort: () => {},
    } as never
    internal.resolveGatewayAuthRetryConnection = () => ({
      slug: 'codex-no-endpoint',
      name: 'Codex with no endpoint',
      providerType: 'codex-runtime',
      authType: 'api_key_with_endpoint',
      createdAt: 1,
    })
    internal.ensureNessyGatewayAuthForRetry = mock(async () => ({ jwt: 'test-jwt', username: 'test-user' }))
    internal.strictDrainPiSession = mock(async () => {
      managed.agent = null
    })
    internal.sendMessage = mock(async () => {
      retried.resolve()
    })

    try {
      expect(internal.attemptAuthRetry(
        managed.id,
        managed,
        managed.workspace.id,
        'expired_oauth_token',
      )).toBe(true)
      await retried.promise

      expect(internal.ensureNessyGatewayAuthForRetry).not.toHaveBeenCalled()
      // And the ordinary retry still happens: the turn is re-sent, it is only
      // the dp re-mint (and therefore the dp card) that is skipped.
      expect(managed.gatewayReMintFailureCode).toBeUndefined()
      expect(internal.sendMessage).toHaveBeenCalledTimes(1)
    } finally {
      await fixture.cleanup()
    }
  })

  test('claims a matching generic auth request before emitting or resuming', async () => {
    const fixture = authRetryFixture()
    const { manager, managed, internal } = fixture
    const requestId = 'oauth-request'
    managed.pendingAuthRequestId = requestId
    managed.pendingAuthRequest = {
      type: 'oauth',
      requestId,
      sourceSlug: 'mail',
      sourceName: 'Mail',
    } as never
    managed.messages.push({
      id: 'oauth-card',
      role: 'auth-request',
      content: 'OAuth authentication for Mail',
      timestamp: 3,
      authRequestId: requestId,
      authRequestType: 'oauth',
      authSourceSlug: 'mail',
      authSourceName: 'Mail',
      authStatus: 'pending',
    })
    internal.persistSession = mock(() => {})
    internal.sendMessage = mock(async () => {})

    try {
      const result = {
        requestId,
        sourceSlug: 'mail',
        success: true,
      }
      const settled = await Promise.allSettled([
        manager.completeAuthRequest(managed.id, result, managed.workspace.id),
        manager.completeAuthRequest(managed.id, result, managed.workspace.id),
      ])

      expect(settled.filter(entry => entry.status === 'fulfilled')).toHaveLength(1)
      expect(settled.filter(entry => entry.status === 'rejected')).toHaveLength(1)
      expect(internal.sendEvent.mock.calls.filter(([event]: [{ type: string }]) => (
        event.type === 'auth_completed'
      ))).toHaveLength(1)
      expect(internal.persistSession).toHaveBeenCalledTimes(1)
      expect(internal.sendMessage).toHaveBeenCalledTimes(1)
    } finally {
      await fixture.cleanup()
    }
  })

  test('exposes a synchronous generic request claim before any terminal await', async () => {
    const fixture = authRetryFixture()
    const { manager, managed, internal } = fixture
    const requestId = 'oauth-request-token'
    managed.pendingAuthRequestId = requestId
    managed.pendingAuthRequest = {
      type: 'oauth',
      requestId,
      sourceSlug: 'mail',
      sourceName: 'Mail',
    } as never
    const authMessage = {
      id: 'oauth-token-card',
      role: 'auth-request' as const,
      content: 'OAuth authentication for Mail',
      timestamp: 3,
      authRequestId: requestId,
      authRequestType: 'oauth' as const,
      authSourceSlug: 'mail',
      authSourceName: 'Mail',
      authStatus: 'pending' as 'pending' | 'completed' | 'failed' | 'cancelled',
    }
    managed.messages.push(authMessage)
    internal.persistSession = mock(() => {})
    internal.sendMessage = mock(async () => {})

    try {
      const claim = manager.claimAuthRequest(
        managed.id,
        requestId,
        'mail',
        managed.workspace.id,
      )

      expect(managed.pendingAuthRequest).toBeUndefined()
      expect(authMessage.authStatus).toBe('pending')
      expect(() => manager.claimAuthRequest(
        managed.id,
        requestId,
        'mail',
        managed.workspace.id,
      )).toThrow('auth-request-stale')

      await manager.completeClaimedAuthRequest(claim, {
        requestId,
        sourceSlug: 'mail',
        success: false,
        cancelled: true,
      })
      expect(authMessage.authStatus).toBe('cancelled')
      expect(internal.sendEvent).toHaveBeenCalledTimes(1)
      expect(internal.persistSession).toHaveBeenCalledTimes(1)
      expect(internal.sendMessage).toHaveBeenCalledTimes(1)
    } finally {
      await fixture.cleanup()
    }
  })

  /*
   * DA1.4 / Target scheme clause 2 — a FORCED re-mint that fails must name its
   * cause on the card the user is looking at, on every runtime, instead of
   * replaying the JWT the gateway just rejected.
   *
   * The failure is driven through `ensureNessyGatewayAuthForRetry`, the seam the
   * two tests above already use, so no `mock.module` of
   * `@nessy-agent/shared/auth/dp` is needed (AGENTS.md: a spreadless
   * `mock.module` amputates the module for some other file in the batch and
   * cannot choose which).
   */
  function gatewayCardFixture(
    providerType: 'pi_compat' | 'claude-runtime' | 'codex-runtime',
    failure: unknown,
  ) {
    const fixture = authRetryFixture()
    const { managed, internal } = fixture
    // REVIEW R12 — the SESSION runtime follows the CONNECTION's provider type.
    //
    // `authRetryFixture` pins `resolveManagedProvider` at `'pi'`, and with that
    // pin the three-runtime loop below varied only the connection: step 0b's
    // `resolveManagedProvider(managed) === 'pi'` branch ran three times and the
    // `disposeManagedAgentRuntime` arm DA1.46 added was executed by no test in
    // this file (it occurred zero times in it). The loop still discriminates
    // `isGatewayBackedConnection`'s membership either way — what it could not
    // see is the seam the disposal actually goes through.
    //
    // Derived through the PRODUCTION mapping rather than a table written here:
    // `pi_compat` → `pi`, `claude-runtime` → `anthropic` (the claude gateway
    // card and a BYO anthropic key fold together), `codex-runtime` → itself.
    // A second spelling of that mapping in a test is a thing that drifts.
    internal.resolveManagedProvider = () => providerTypeToAgentProvider(providerType)
    managed.agent = {
      forceAbort: () => {},
      interruptForHandoff: () => {},
    } as never
    internal.resolveGatewayAuthRetryConnection = () => ({
      slug: `${providerType}-gateway`,
      name: 'Nessy Gateway',
      providerType,
      baseUrl: NESSY_GATEWAY_BASE_URL,
      authType: 'api_key_with_endpoint',
      createdAt: 1,
    })
    internal.ensureNessyGatewayAuthForRetry = mock(async () => {
      if (failure) throw failure
      return { jwt: 'test-jwt', username: 'test-user' }
    })
    internal.strictDrainPiSession = mock(async () => { managed.agent = null })
    internal.disposeManagedAgentRuntime = mock(async () => { managed.agent = null })
    internal.sendMessage = mock(async () => {})
    internal.sendTurnEndEvent = mock(async () => {})
    internal.persistSession = mock(() => {})
    return fixture
  }

  function dpCard(managed: ReturnType<typeof createManagedSession>) {
    return managed.messages.find(message =>
      message.role === 'auth-request' && message.authRequestType === 'dp'
    )
  }

  for (const providerType of ['pi_compat', 'claude-runtime', 'codex-runtime'] as const) {
    test(`${providerType}: a failed forced re-mint raises the dp card with the reason instead of replaying the rejected token`, async () => {
      const fixture = gatewayCardFixture(
        providerType,
        new DpAuthServiceError(DpAuthError.NeedsLogin, 'dp is not logged in'),
      )
      const { managed, internal } = fixture

      try {
        expect(internal.attemptAuthRetry(
          managed.id,
          managed,
          managed.workspace.id,
          'expired_oauth_token',
        )).toBe(true)
        // The card is raised from the same `setImmediate` the retry runs in.
        await new Promise(resolve => setImmediate(resolve))
        await new Promise(resolve => setImmediate(resolve))

        // The reason reached the session and the card.
        expect(managed.gatewayReMintFailureCode).toBe(DpAuthError.NeedsLogin)
        const card = dpCard(managed)
        expect(card?.authStatus).toBe('pending')
        expect(card?.authError).toBe(DpAuthError.NeedsLogin)
        // Codes only — never a token value or its length (clause 2).
        expect(card?.content).not.toContain('jwt')

        // The turn was NOT replayed with the credential the gateway rejected.
        expect(internal.sendMessage).not.toHaveBeenCalled()
        // DA1.46 — THIS ASSERTION IS FLIPPED, and the flip is the row. It read
        // `not.toHaveBeenCalled()`, because the early return skipped step 1
        // entirely. The agent it skipped disposing is the one holding the token
        // the gateway had just rejected (on Pi the JWT is read at SPAWN time),
        // so the post-sign-in replay went out with the dead credential and cost
        // the user a second failed turn. DA1.4's reason for stopping — do not
        // REPLAY a dead token — is untouched; only the agent's survival changed.
        //
        // R12 — and through the seam THIS runtime disposes with. Step 0b runs
        // the same two-armed branch step 1 does, so asserting only that the
        // agent ended up null would pass against a step 0b that reached for the
        // wrong arm: both stubs null it. The OTHER seam not being called is the
        // half that fails in that case.
        const [disposalSeam, otherSeam] = providerType === 'pi_compat'
          ? [internal.strictDrainPiSession, internal.disposeManagedAgentRuntime]
          : [internal.disposeManagedAgentRuntime, internal.strictDrainPiSession]
        expect(disposalSeam).toHaveBeenCalledTimes(1)
        expect(otherSeam).not.toHaveBeenCalled()
        expect(managed.agent).toBeNull()
        expect(managed.authRetryInProgress).toBe(false)

        // The card the RPC gate will accept: `hasPendingDpAuthRequest` reads
        // every field of the replay envelope, so an envelope this test did not
        // check would give the user a button that answers `dp-auth-stale`.
        expect(fixture.manager.hasPendingDpAuthRequest(
          managed.id,
          card!.authRequestId!,
          managed.workspace.id,
        )).toBe(true)
        // And signing in re-sends THIS message under its existing id.
        expect(managed.dpAuthReplay).toMatchObject({
          sessionId: managed.id,
          workspaceId: managed.workspace.id,
          userMessageId: 'user-message',
          message: 'retry this message',
          modelMessage: 'retry this model message',
        })
      } finally {
        await fixture.cleanup()
      }
    })
  }

  // DA1.46 — the SECOND half: signing in re-mints ONCE before the replay.
  //
  // The card's button runs `dp auth login`, which repairs the dp SESSION and
  // mints no gateway JWT, so without this the replay re-sends the very token the
  // gateway rejected. The mint is FORCED (DA1.1's split) so it cannot join a
  // warm run and is guaranteed to post-date the sign-in.
  test('signing in re-mints the gateway JWT BEFORE the replay, once (DA1.46)', async () => {
    const fixture = gatewayCardFixture('pi_compat', new DpAuthServiceError(DpAuthError.NeedsLogin))
    const { managed, internal } = fixture

    try {
      expect(internal.attemptAuthRetry(
        managed.id, managed, managed.workspace.id, 'expired_oauth_token',
      )).toBe(true)
      await new Promise(resolve => setImmediate(resolve))
      await new Promise(resolve => setImmediate(resolve))

      const card = dpCard(managed)
      expect(card?.authRequestId).toBeTruthy()

      // One forced call so far: the one that FAILED and raised the card.
      expect(internal.ensureNessyGatewayAuthForRetry).toHaveBeenCalledTimes(1)

      // Now the sign-in succeeds. Re-arm the seam and record the ORDER, which is
      // the whole point: a mint after the replay would be worthless.
      const sequence: string[] = []
      internal.ensureNessyGatewayAuthForRetry = mock(async (...args: unknown[]) => {
        sequence.push(`mint:${JSON.stringify(args[0])}`)
        return { jwt: 'fresh-jwt', username: 'test-user' }
      })
      internal.sendMessage = mock(async () => { sequence.push('replay') })

      await internal.completeDpAuthRequest(managed, {
        requestId: card!.authRequestId!,
        sourceSlug: 'dp',
        success: true,
      })

      expect(sequence).toEqual(['mint:{"interactive":false,"forceRefresh":true}', 'replay'])
      expect(internal.ensureNessyGatewayAuthForRetry).toHaveBeenCalledTimes(1)
    } finally {
      await fixture.cleanup()
    }
  })

  // DA1.46 (negative/boundary). A mint that FAILS must not strand the user's
  // stashed message: the replay still goes out, and its 401 re-enters the
  // ordinary auth-retry cycle, which raises the card again with the reason.
  test('a failed post-sign-in re-mint still replays rather than stranding the turn (DA1.46)', async () => {
    const fixture = gatewayCardFixture('pi_compat', new DpAuthServiceError(DpAuthError.NeedsLogin))
    const { managed, internal } = fixture

    try {
      expect(internal.attemptAuthRetry(
        managed.id, managed, managed.workspace.id, 'expired_oauth_token',
      )).toBe(true)
      await new Promise(resolve => setImmediate(resolve))
      await new Promise(resolve => setImmediate(resolve))
      const card = dpCard(managed)

      internal.ensureNessyGatewayAuthForRetry = mock(async () => {
        throw new DpAuthServiceError(DpAuthError.ExecFailed)
      })
      internal.sendMessage = mock(async () => {})

      await internal.completeDpAuthRequest(managed, {
        requestId: card!.authRequestId!,
        sourceSlug: 'dp',
        success: true,
      })

      expect(internal.sendMessage).toHaveBeenCalledTimes(1)
    } finally {
      await fixture.cleanup()
    }
  })

  // DA1.45 (REVIEW R-c0) — a connection on the gateway HOST but not a gateway
  // ENDPOINT. What this pins is the DECISION, not the diagnostic: the branch
  // must NOT raise a dp card (`gatewayReMintFailureCode` stays unset, and a dp
  // card cannot fix a 401 from the user's own endpoint), and the ordinary retry
  // must still happen. The legibility the row asked for is an operator log line,
  // which this rig does not capture; the user-facing half is declined with its
  // reason in the branch's own comment.
  test('a gateway-HOST non-gateway endpoint gets no re-mint and no dp card (DA1.45)', async () => {
    const fixture = authRetryFixture()
    const { managed, internal } = fixture
    const retried = deferred()
    managed.agent = { forceAbort: () => {} } as never
    internal.resolveGatewayAuthRetryConnection = () => ({
      slug: 'byo-on-gateway-host',
      name: 'My own proxy on the gateway host',
      providerType: 'pi_compat',
      baseUrl: 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/byo-proxy/v1',
      authType: 'api_key_with_endpoint',
      createdAt: 1,
    })
    internal.ensureNessyGatewayAuthForRetry = mock(async () => ({ jwt: 'test-jwt', username: 'test-user' }))
    internal.strictDrainPiSession = mock(async () => { managed.agent = null })
    internal.sendMessage = mock(async () => { retried.resolve() })

    try {
      expect(internal.attemptAuthRetry(
        managed.id, managed, managed.workspace.id, 'expired_oauth_token',
      )).toBe(true)
      await retried.promise

      expect(internal.ensureNessyGatewayAuthForRetry).not.toHaveBeenCalled()
      expect(managed.gatewayReMintFailureCode).toBeUndefined()
      expect(managed.messages.filter(m => m.role === 'auth-request')).toHaveLength(0)
      expect(internal.sendMessage).toHaveBeenCalledTimes(1)
    } finally {
      await fixture.cleanup()
    }
  })

  test('a SUCCESSFUL forced re-mint retries as before and raises no card', async () => {
    const fixture = gatewayCardFixture('pi_compat', undefined)
    const { managed, internal } = fixture
    const retried = deferred()
    internal.sendMessage = mock(async () => { retried.resolve() })

    try {
      expect(internal.attemptAuthRetry(
        managed.id,
        managed,
        managed.workspace.id,
        'expired_oauth_token',
      )).toBe(true)
      await retried.promise

      expect(managed.gatewayReMintFailureCode).toBeUndefined()
      expect(dpCard(managed)).toBeUndefined()
      expect(managed.dpAuthReplay).toBeUndefined()
      expect(internal.strictDrainPiSession).toHaveBeenCalledTimes(1)
    } finally {
      await fixture.cleanup()
    }
  })

  test('a stale code from an earlier gateway failure never raises a card on a later BYO retry', async () => {
    // The field describes ONE re-mint. `refreshGatewayAuthForRetry` returns
    // early for a BYO connection, so without the clear on entry a previous
    // gateway failure would raise a dp sign-in card for an endpoint dp has
    // nothing to do with.
    const fixture = authRetryFixture()
    const { managed, internal } = fixture
    const retried = deferred()
    managed.agent = { forceAbort: () => {}, interruptForHandoff: () => {} } as never
    managed.gatewayReMintFailureCode = DpAuthError.NeedsLogin
    internal.resolveGatewayAuthRetryConnection = () => ({
      slug: 'byo-claude',
      name: 'My Own Claude Endpoint',
      providerType: 'claude-runtime',
      baseUrl: 'https://byo.example.com/v1',
      authType: 'api_key_with_endpoint',
      createdAt: 1,
    })
    internal.ensureNessyGatewayAuthForRetry = mock(async () => ({ jwt: 'test-jwt', username: 'test-user' }))
    internal.strictDrainPiSession = mock(async () => { managed.agent = null })
    internal.sendMessage = mock(async () => { retried.resolve() })

    try {
      expect(internal.attemptAuthRetry(
        managed.id,
        managed,
        managed.workspace.id,
        'expired_oauth_token',
      )).toBe(true)
      await retried.promise

      expect(managed.gatewayReMintFailureCode).toBeUndefined()
      expect(dpCard(managed)).toBeUndefined()
      expect(internal.ensureNessyGatewayAuthForRetry).not.toHaveBeenCalled()
    } finally {
      await fixture.cleanup()
    }
  })

  test('a CANCELLED forced re-mint raises no card — the renderer would draw it without a button (review R1)', async () => {
    // `DpAuthError.Cancelled` is the one member `AuthRequestCard.tsx` maps to a
    // terminal `cancelled` state with no action, so a card carrying it is a
    // dead end for every later turn in the session. A cancelled forced run
    // means the run was aborted, not that dp refused: it takes the uncoded
    // fallback (banner, retry as before), and records no code.
    const fixture = gatewayCardFixture('pi_compat', new DpAuthServiceError(DpAuthError.Cancelled, 'dp auth cancelled'))
    const { managed, internal } = fixture
    const retried = deferred()
    internal.sendMessage = mock(async () => { retried.resolve() })

    try {
      expect(internal.attemptAuthRetry(
        managed.id,
        managed,
        managed.workspace.id,
        'expired_oauth_token',
      )).toBe(true)
      await retried.promise

      expect(managed.gatewayReMintFailureCode).toBeUndefined()
      expect(dpCard(managed)).toBeUndefined()
      expect(internal.strictDrainPiSession).toHaveBeenCalledTimes(1)
    } finally {
      await fixture.cleanup()
    }
  })

  test('a re-mint failure that carries no DpAuthError falls back to today, banner and all', async () => {
    // The row's stated fallback. Only `runEnsure` normalises into a
    // `DpAuthServiceError`; anything thrown by the CONNECTION LOOKUP above it
    // carries no code, and an uncoded failure must not raise a card that would
    // then have to invent a reason.
    const fixture = gatewayCardFixture('pi_compat', new Error('config storage unavailable'))
    const { managed, internal } = fixture
    const retried = deferred()
    internal.sendMessage = mock(async () => { retried.resolve() })

    try {
      expect(internal.attemptAuthRetry(
        managed.id,
        managed,
        managed.workspace.id,
        'expired_oauth_token',
      )).toBe(true)
      await retried.promise

      expect(managed.gatewayReMintFailureCode).toBeUndefined()
      expect(dpCard(managed)).toBeUndefined()
      expect(internal.strictDrainPiSession).toHaveBeenCalledTimes(1)
    } finally {
      await fixture.cleanup()
    }
  })

  test('rejects a forged generic source before auth_completed or resume', async () => {
    const fixture = authRetryFixture()
    const { manager, managed, internal } = fixture
    const requestId = 'oauth-forged'
    managed.pendingAuthRequestId = requestId
    managed.pendingAuthRequest = {
      type: 'oauth',
      requestId,
      sourceSlug: 'mail',
      sourceName: 'Mail',
    } as never
    const authMessage = {
      id: 'oauth-forged-card',
      role: 'auth-request' as const,
      content: 'OAuth authentication for Mail',
      timestamp: 3,
      authRequestId: requestId,
      authRequestType: 'oauth' as const,
      authSourceSlug: 'mail',
      authSourceName: 'Mail',
      authStatus: 'pending' as const,
    }
    managed.messages.push(authMessage)
    internal.persistSession = mock(() => {})
    internal.sendMessage = mock(async () => {})

    try {
      await expect(manager.completeAuthRequest(managed.id, {
        requestId,
        sourceSlug: 'forged',
        success: false,
      }, managed.workspace.id)).rejects.toThrow('auth-request-stale')

      expect(authMessage.authStatus).toBe('pending')
      expect(internal.sendEvent).not.toHaveBeenCalled()
      expect(internal.persistSession).not.toHaveBeenCalled()
      expect(internal.sendMessage).not.toHaveBeenCalled()
    } finally {
      await fixture.cleanup()
    }
  })
})
