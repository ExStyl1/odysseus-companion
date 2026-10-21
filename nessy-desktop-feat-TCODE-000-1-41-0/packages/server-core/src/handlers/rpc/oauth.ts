import { randomUUID } from 'node:crypto'
import {
  OAUTH_FAILURE_CODES,
  RPC_CHANNELS,
  type OAuthFailureCode,
} from '@nessy-agent/shared/protocol'
import { getWorkspaceOrThrow } from '../utils'
import { loadSource, getSourceCredentialManager } from '@nessy-agent/shared/sources'
import {
  deletePluginMcpServerCredentials,
  savePluginMcpCredential,
  type PluginMcpDescriptor,
} from '@nessy-agent/shared/plugins'
import {
  createPendingFlow,
  exchangeEndpointOAuth,
  prepareEndpointOAuth,
  type OAuthFlowTakeResult,
  type OAuthFlowWaiter,
  type PendingOAuthFlow,
} from '@nessy-agent/shared/auth'
import { emitCapabilityCatalogInvalidation } from '@nessy-agent/shared/capabilities/invalidation'
import { pushTyped, type RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import type { IOAuthFlowStore } from '../oauth-flow-store-interface'
import type { AuthRequestClaim } from '../session-manager-interface'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.oauth.START,
  RPC_CHANNELS.oauth.COMPLETE,
  RPC_CHANNELS.oauth.CANCEL,
  RPC_CHANNELS.oauth.FAIL,
  // UB3.10: polled by clients that JOINED a live sign-in — still live, or how it ended.
  RPC_CHANNELS.oauth.STATUS,
  RPC_CHANNELS.oauth.REVOKE,
] as const

const OAUTH_FAILURE_MESSAGES: Readonly<Record<OAuthFailureCode, string>> = {
  [OAUTH_FAILURE_CODES.CALLBACK_SERVER_FAILED]: 'Unable to start the OAuth callback server.',
  [OAUTH_FAILURE_CODES.METADATA_UNAVAILABLE]: 'This endpoint does not advertise MCP OAuth. Fix the source configuration or use the supported DP-backed plugin MCP.',
  [OAUTH_FAILURE_CODES.START_FAILED]: 'Unable to start OAuth authentication.',
  [OAUTH_FAILURE_CODES.BROWSER_OPEN_FAILED]: 'Unable to open the OAuth sign-in page.',
  [OAUTH_FAILURE_CODES.PROVIDER_CALLBACK_FAILED]: 'The OAuth provider did not complete authentication.',
  [OAUTH_FAILURE_CODES.AUTHORIZATION_CODE_MISSING]: 'The OAuth provider did not return an authorization code.',
  [OAUTH_FAILURE_CODES.COMPLETE_FAILED]: 'OAuth credential exchange failed.',
}

export function getOAuthFailureMessage(code: OAuthFailureCode): string {
  return OAUTH_FAILURE_MESSAGES[code]
}

/** What an OAuth start failure records about the error it is replacing. */
export interface OAuthStartDiagnostic {
  code: OAuthFailureCode
  /** Server name or source slug the flow was starting for. */
  target: string
  /** Endpoint identity, host + path only — never the query. */
  endpoint?: string
  errorName: string
  errorMessage: string
}

/**
 * Endpoint identity that is safe to log: origin + path, never the query or the
 * fragment. An OAuth URL's query is where `code`, `state` and tokens live.
 */
function redactUrlForDiagnostic(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    return `${url.origin}${url.pathname}`
  } catch {
    return '<unparseable-url>'
  }
}

function describeThrown(error: unknown): { errorName: string; errorMessage: string } {
  if (error instanceof Error) return { errorName: error.name, errorMessage: error.message }
  return { errorName: typeof error, errorMessage: String(error) }
}

/**
 * Build the typed failure the UI switches on WITHOUT discarding what actually
 * failed.
 *
 * `message` stays EXACTLY the failure code: `oauth-orchestration.ts` matches on
 * it, and the RPC wire carries only `{code, message}` (`transport/server.ts`
 * `sendResponseError`) so nothing else survives the hop. The original error
 * therefore rides three other channels — `cause` for in-process callers, a
 * `diagnostic` property for anything reading the thrown value, and an
 * `error`-level log line, which is the only one the packaged app's owner can
 * read after the fact.
 *
 * A bare `throw new Error(CODE)` here is what made a live OAuth failure
 * unreadable from the product: the UI said "Unable to start OAuth
 * authentication" and the log said nothing at all.
 */
function oauthStartFailure(
  log: { error(...args: unknown[]): void },
  code: OAuthFailureCode,
  error: unknown,
  context: { target: string; endpoint?: string },
): Error {
  const endpoint = redactUrlForDiagnostic(context.endpoint)
  const diagnostic: OAuthStartDiagnostic = {
    code,
    target: context.target,
    ...(endpoint ? { endpoint } : {}),
    ...describeThrown(error),
  }
  log.error('[OAuth] Start failed', diagnostic)
  return Object.assign(new Error(code, { cause: error }), { diagnostic })
}

/** The code an OAuth preparation error maps to, before the original is wrapped. */
function classifyOAuthStartError(error: unknown): OAuthFailureCode {
  return error instanceof Error && error.message.startsWith('No OAuth metadata found')
    ? OAUTH_FAILURE_CODES.METADATA_UNAVAILABLE
    : OAUTH_FAILURE_CODES.START_FAILED
}

function parseOAuthFailureCode(value: unknown): OAuthFailureCode {
  if (typeof value !== 'string'
    || !Object.values(OAUTH_FAILURE_CODES).includes(value as OAuthFailureCode)) {
    throw new Error('Invalid OAuth failure code')
  }
  return value as OAuthFailureCode
}

type TerminalAuthSessionManager = Pick<
  HandlerDeps['sessionManager'],
  'claimAuthRequest' | 'completeClaimedAuthRequest'
>

/** What completing a flow may call on the session manager (UB3.10 adds the fan-out). */
type CompletionAuthSessionManager = TerminalAuthSessionManager & Pick<
  HandlerDeps['sessionManager'],
  'completeAuthRequestsForSource'
>

function claimFlowAuthRequest(
  sessionManager: TerminalAuthSessionManager,
  flow: Pick<PendingOAuthFlow, 'workspaceId' | 'sessionId' | 'authRequestId' | 'sourceSlug'>,
): AuthRequestClaim | undefined {
  if (!flow.sessionId && !flow.authRequestId) return undefined
  if (!flow.sessionId || !flow.authRequestId) {
    throw new Error('Incomplete OAuth auth request binding')
  }
  try {
    return sessionManager.claimAuthRequest(
      flow.sessionId,
      flow.authRequestId,
      flow.sourceSlug,
      flow.workspaceId,
    )
  } catch (error) {
    if (error instanceof Error && (error.message === 'auth-request-stale' || error.message === 'dp-auth-stale')) {
      throw new Error('OAuth auth request binding mismatch')
    }
    throw error
  }
}

function claimTerminalAuthRequest(
  sessionManager: TerminalAuthSessionManager,
  binding: Pick<PendingOAuthFlow, 'workspaceId' | 'sessionId' | 'authRequestId' | 'sourceSlug'>,
  fallbackFromMissingFlow: boolean,
): AuthRequestClaim {
  try {
    const claim = claimFlowAuthRequest(sessionManager, binding)
    if (!claim) throw new Error('OAuth auth request binding mismatch')
    return claim
  } catch (error) {
    if (fallbackFromMissingFlow
      && error instanceof Error
      && error.message === 'OAuth auth request binding mismatch') {
      throw new Error('OAuth flow ownership mismatch')
    }
    throw error
  }
}

async function settleClaimedOAuthFailure(
  sessionManager: TerminalAuthSessionManager,
  claim: AuthRequestClaim,
  code: OAuthFailureCode,
): Promise<void> {
  await sessionManager.completeClaimedAuthRequest(claim, {
    requestId: claim.requestId,
    sourceSlug: claim.sourceSlug,
    success: false,
    error: OAUTH_FAILURE_MESSAGES[code],
  })
}

function throwForCompleteFlowMismatch(
  result: Extract<OAuthFlowTakeResult, { status: 'mismatch' }>,
): never {
  if (result.reason === 'request') {
    throw new Error('OAuth auth request binding mismatch')
  }
  if (result.reason === 'flow-id') {
    throw new Error('Flow ID mismatch')
  }
  throw new Error('OAuth flow ownership mismatch')
}

function throwForTerminalFlowMismatch(
  result: Extract<OAuthFlowTakeResult, { status: 'mismatch' }>,
): never {
  if (result.reason === 'request') {
    throw new Error('OAuth auth request binding mismatch')
  }
  throw new Error('OAuth flow ownership mismatch')
}

/**
 * Complete an OAuth flow: validate state, exchange code for tokens, store credentials.
 *
 * Shared between the `oauth:complete` RPC handler (called by Electron) and the
 * `/api/oauth/callback` HTTP route (called by the relay for WebUI).
 *
 * A successful sign-in answers every session in the workspace waiting on the
 * source (UB3.10), not just the one whose card started the flow. Joined clients
 * that polled `oauth:status` learn the outcome either way.
 *
 * @param opts.owner - Transport-bound RPC owner. Omit for the state-authenticated HTTP callback.
 */
export async function completeOAuthFlow(opts: {
  code: string
  state: string
  flowStore: {
    takeByStateMatching: HandlerDeps['oauthFlowStore']['takeByStateMatching']
    recordOutcome: IOAuthFlowStore['recordOutcome']
  }
  credManager: { exchangeAndStore(...args: any[]): Promise<any> }
  sessionManager: CompletionAuthSessionManager
  pushSourcesChanged: (workspaceId: string) => void
  logger: { info(msg: string): void; }
  flowId?: string
  owner?: { clientId: string; workspaceId: string }
}): Promise<{ success: boolean; error?: string; email?: string }> {
  const { code, state, flowStore, credManager, sessionManager, pushSourcesChanged, logger } = opts

  if (opts.owner && !opts.flowId) throw new Error('Flow ID mismatch')
  const claimedFlow = flowStore.takeByStateMatching(
    state,
    opts.owner
      ? {
          kind: 'owner',
          flowId: opts.flowId!,
          ownerClientId: opts.owner.clientId,
          workspaceId: opts.owner.workspaceId,
        }
      : { kind: 'state-bearer' },
  )
  if (claimedFlow.status === 'missing') throw new Error('Unknown or expired OAuth flow')
  if (claimedFlow.status === 'mismatch') throwForCompleteFlowMismatch(claimedFlow)
  const flow = claimedFlow.flow

  const authClaim = claimFlowAuthRequest(sessionManager, flow)

  // The reason the exchange failed, for the joined clients' oauth:status outcome
  // (the wire result keeps our COMPLETE_FAILED code — this is the diagnostic arm).
  let exchangeFailure: string | undefined

  const exchange = async () => {
    await flow.validateBeforeExchange?.()
    try {
      // C3 (capability-path): a plugin-server flow stores into the server's
      // GLOBAL plugin credential slot — no Source is involved at any point.
      if (flow.pluginServer) {
        const result = await exchangeEndpointOAuth({
          code,
          codeVerifier: flow.codeVerifier,
          tokenEndpoint: flow.tokenEndpoint,
          clientId: flow.clientId,
          clientSecret: flow.clientSecret,
          redirectUri: flow.redirectUri,
          oauthResource: flow.oauthResource,
        })
        if (!result.success) {
          // D5 live find (2026-08-14): this branch used to discard the reason,
          // so a figma sign-in that reached the callback and then failed the
          // token exchange logged only `success=false` — undiagnosable for the
          // user AND for us. Never log token material; the failure text only.
          logger.info(`[OAuth] Token exchange rejected for ${flow.sourceSlug}: ${result.error ?? 'no reason reported by the exchange'}`)
          return { success: false }
        }
        await savePluginMcpCredential('oauth', flow.pluginServer.pluginKey, flow.pluginServer.serverName, {
          value: result.accessToken!,
          refreshToken: result.refreshToken,
          expiresAt: result.expiresAt,
          clientId: result.oauthClientId,
          clientSecret: result.oauthClientSecret,
        })
        return { success: true }
      }
      return await credManager.exchangeAndStore(flow.source!, flow.provider, {
        code,
        codeVerifier: flow.codeVerifier,
        tokenEndpoint: flow.tokenEndpoint,
        clientId: flow.clientId,
        clientSecret: flow.clientSecret,
        redirectUri: flow.redirectUri,
        oauthResource: flow.oauthResource,
      })
    } catch (error) {
      // Same D5 find: a bare `catch` here erased network/4xx/parse failures
      // entirely. The message is the whole diagnostic budget a user gets.
      exchangeFailure = error instanceof Error ? error.message : String(error)
      logger.info(`[OAuth] Token exchange threw for ${flow.sourceSlug}: ${exchangeFailure}`)
      return { success: false }
    }
  }
  let exchangeResult: Awaited<ReturnType<typeof exchange>>
  try {
    exchangeResult = flow.runExclusive ? await flow.runExclusive(exchange) : await exchange()
  } catch (error) {
    if (!authClaim) {
      // UB3.10: the flow already left the store with our take; joined clients
      // polling oauth:status still need to learn it ended, and why.
      flowStore.recordOutcome(flow, { success: false, error: describeThrown(error).errorMessage })
      throw error
    }
    exchangeResult = { success: false }
  }
  const settlementError = exchangeResult.success
    ? undefined
    : OAUTH_FAILURE_MESSAGES[OAUTH_FAILURE_CODES.COMPLETE_FAILED]
  const result: { success: boolean; error?: string; email?: string } = exchangeResult.success
    ? { success: true, ...(exchangeResult.email ? { email: exchangeResult.email } : {}) }
    : { success: false, error: OAUTH_FAILURE_CODES.COMPLETE_FAILED }

  // UB3.10: how the flow ended, for the clients that joined it and poll
  // oauth:status. Our take removed the flow before the exchange, so this
  // recording is the only trace they can read.
  flowStore.recordOutcome(
    flow,
    result.success
      ? { success: true, ...(result.email ? { email: result.email } : {}) }
      : {
          success: false,
          error: (exchangeResult as { error?: string }).error ?? exchangeFailure ?? settlementError,
        },
  )

  // If this was triggered from a session auth card, complete it
  if (authClaim) {
    await sessionManager.completeClaimedAuthRequest(authClaim, {
      requestId: authClaim.requestId,
      sourceSlug: authClaim.sourceSlug,
      success: result.success,
      email: result.email,
      error: settlementError,
    })
  }

  if (result.success) {
    // UB3.10: one sign-in serves every session waiting on the source. The cards
    // that started or joined the flow count even if their session forgot the
    // request (pendingAuthRequest is not persisted); every other pending OAuth
    // card for the slug in this workspace resumes too. A failed exchange fails
    // only the card that started the flow — joined cards stay pending above.
    const boundRequests = [flow, ...(flow.waiters ?? [])].flatMap(({ sessionId, authRequestId }) =>
      sessionId && authRequestId ? [{ sessionId, authRequestId }] : [],
    )
    const resumed = await sessionManager.completeAuthRequestsForSource(
      flow.workspaceId,
      flow.sourceSlug,
      { email: result.email },
      boundRequests,
    )
    if (resumed.length > 1) logger.info(`[OAuth] ${flow.sourceSlug} sign-in answered ${resumed.length} sessions`)
  }

  // Push source status update to all clients in this workspace
  pushSourcesChanged(flow.workspaceId)

  logger.info(`[OAuth] Flow complete for ${flow.sourceSlug} (success=${result.success})`)
  return result
}

export async function failOAuthCallbackFlow(opts: {
  state: string
  code: OAuthFailureCode
  /** The provider's own reason (`error_description` or `error`) — recorded for the clients that joined the flow (UB3.10). */
  error?: string
  flowStore: {
    takeByStateMatching: HandlerDeps['oauthFlowStore']['takeByStateMatching']
    recordOutcome: IOAuthFlowStore['recordOutcome']
  }
  sessionManager: TerminalAuthSessionManager
}): Promise<void> {
  const claimedFlow = opts.flowStore.takeByStateMatching(
    opts.state,
    { kind: 'state-bearer' },
  )
  if (claimedFlow.status !== 'taken') return
  const flow = claimedFlow.flow

  // UB3.10: clients that joined the flow read the failure from oauth:status.
  opts.flowStore.recordOutcome(flow, { success: false, error: opts.error ?? OAUTH_FAILURE_MESSAGES[opts.code] })

  let claim: AuthRequestClaim | undefined
  try {
    claim = claimFlowAuthRequest(opts.sessionManager, flow)
  } catch (error) {
    if (error instanceof Error && error.message === 'OAuth auth request binding mismatch') {
      return
    }
    throw error
  }
  if (claim) await settleClaimedOAuthFailure(opts.sessionManager, claim, opts.code)
}

/** What oauth:start answers: a new flow to open in the browser, or the live one to wait on. */
export type OAuthStartResponse =
  | { joined: true; flowId: string; expiresInMs: number }
  | { authUrl: string; state: string; flowId: string; expiresInMs: number }

/** The part of an oauth:start request the single-flight starter reads (source branch). */
export interface SourceFlowStartRequest {
  workspaceId: string
  clientId: string
  sourceSlug: string
  callbackPort?: number
  callbackUrl?: string
  sessionId?: string
  authRequestId?: string
  /** The client can wait on a live flow (older clients always get their own) */
  joinLive?: boolean
  /** Replace the live flow, e.g. after its sign-in window was lost */
  restart?: boolean
}

/**
 * Start a sign-in for a source, or join the live one: single flight per
 * (workspace, source), so parallel sessions that need the same sign-in share
 * one flow (UB3.10, upstream v0.15.1). A caller that arrives while a flow is
 * live gets `{ joined: true }`, opens nothing, and polls oauth:status until it
 * ends.
 *
 * Our specifics kept on top of the upstream shape: the JOINING caller's
 * auth-request binding is validated like a start's (`assertJoinBinding` — our
 * claim model), and `run` prepares and stores the new flow with our
 * post-discovery revalidation, receiving the waiters carried over from a flow
 * the restart replaced.
 *
 * Exported for tests; the oauth:start handler resolves the workspace and source
 * first.
 */
export function createOAuthFlowStarter(deps: {
  flowStore: Pick<IOAuthFlowStore, 'getLiveForSource' | 'join' | 'remove'>
  logger: { info(msg: string): void }
  /** Validated before a caller JOINs: its card must still be pending (our claim model). */
  assertJoinBinding?: (request: SourceFlowStartRequest) => Promise<void>
  /** Prepare + store the NEW flow (ours revalidates after discovery); gets the carried waiters. */
  run: (
    request: SourceFlowStartRequest,
    carriedWaiters: OAuthFlowWaiter[],
  ) => Promise<{ authUrl: string; state: string; flowId: string; expiresInMs: number }>
}) {
  const { flowStore, logger } = deps
  // Starts still preparing their flow (MCP discovery is a network round trip), so a second
  // start for the same source waits for that flow instead of racing it with another
  const preparing = new Map<string, Promise<unknown>>()

  return async function startOAuthFlow(request: SourceFlowStartRequest): Promise<OAuthStartResponse> {
    const { workspaceId, sourceSlug, restart } = request
    const key = `${workspaceId}\u0000${sourceSlug}`

    if (request.joinLive && !restart) {
      // Only yield when there is something to wait for: until this start registers its own
      // preparation below, a concurrent start must not slip past this check too
      const pending = preparing.get(key)
      if (pending) await pending.catch(() => {})
      const live = flowStore.getLiveForSource(workspaceId, sourceSlug)
      if (live) {
        if (deps.assertJoinBinding) await deps.assertJoinBinding(request)
        flowStore.join(live.state, {
          clientId: request.clientId,
          sessionId: request.sessionId,
          authRequestId: request.authRequestId,
        })
        logger.info(`[OAuth] Joined live flow for ${sourceSlug} (flow=${live.flowId}, waiters=${live.waiters.length})`)
        return { joined: true, flowId: live.flowId, expiresInMs: live.expiresAt - Date.now() }
      }
    }

    const preparation = (async () => {
      // Starting over ends the live flow; its cards carry over so they complete with the new one
      let carriedWaiters: OAuthFlowWaiter[] = []
      const replaced = restart ? flowStore.getLiveForSource(workspaceId, sourceSlug) : null
      if (replaced) {
        flowStore.remove(replaced.state, { success: false, error: 'The sign-in was restarted.' })
        carriedWaiters = [
          {
            clientId: replaced.ownerClientId,
            sessionId: replaced.sessionId,
            authRequestId: replaced.authRequestId,
          },
          ...replaced.waiters,
        ].filter(w =>
          w.sessionId
          && w.authRequestId
          && !(w.sessionId === request.sessionId && w.authRequestId === request.authRequestId),
        )
      }
      const stored = await deps.run(request, carriedWaiters)
      return { ...stored, replaced: replaced != null }
    })()

    preparing.set(key, preparation)
    try {
      const stored = await preparation
      logger.info(`[OAuth] Flow ${stored.replaced ? 'restarted' : 'started'} for ${sourceSlug} (flow=${stored.flowId})`)
      return {
        authUrl: stored.authUrl,
        state: stored.state,
        flowId: stored.flowId,
        expiresInMs: stored.expiresInMs,
      }
    } finally {
      if (preparing.get(key) === preparation) preparing.delete(key)
    }
  }
}

export function registerOAuthHandlers(server: RpcServer, deps: HandlerDeps): void {
  const log = deps.platform.logger
  const flowStore = deps.oauthFlowStore
  const credManager = getSourceCredentialManager()

  /**
   * C3 (capability-path): resolve one plugin-owned MCP server's OAuth endpoint
   * from the ACTIVE installed manifest, enforcing plugin + capability policy.
   * Throws when the server is missing, not http/sse OAuth, or disabled.
   */
  const resolvePluginServerEndpoint = async (
    workspaceId: string,
    pluginServer: { pluginKey: string; serverName: string },
  ): Promise<PluginMcpDescriptor> => {
    if (!deps.pluginStore || !deps.capabilityPolicyStore) {
      throw new Error('plugin-runtime-unavailable')
    }
    const registry = await deps.pluginStore.readInstalledRegistry()
    const instanceId = registry.active[pluginServer.pluginKey]
    const installed = instanceId
      ? registry.plugins.find(entry => entry.pluginInstanceId === instanceId)
      : undefined
    if (!installed) throw new Error('plugin-mcp-server-unavailable')
    const capability = installed.manifest.capabilities
      .flatMap(entry => (entry.kind === 'mcp' ? [entry] : []))
      .find(entry => (
        entry.mcp.serverName === pluginServer.serverName
        && entry.mcp.transport !== 'stdio'
        && entry.mcp.authType === 'oauth'
        && !!entry.mcp.url
      ))
    if (!capability?.mcp) throw new Error('plugin-mcp-server-unavailable')
    const activation = deps.capabilityPolicyStore.resolve(
      { pluginKey: pluginServer.pluginKey, pluginInstanceId: installed.pluginInstanceId },
      { workspaceId },
    )
    if (!activation.enabled
      || activation.suppressed
      || activation.capabilities[capability.id] === false) {
      throw new Error('plugin-oauth-flow-invalidated')
    }
    return capability.mcp
  }

  const startPluginServerFlow = async (options: {
    ownerClientId: string
    workspaceId: string
    pluginServer: { pluginKey: string; serverName: string }
    callbackPort?: number
    callbackUrl?: string
    sessionId?: string
    authRequestId?: string
  }): Promise<{ authUrl: string; state: string; flowId: string }> => {
    const { workspaceId, pluginServer, sessionId, authRequestId } = options
    const serverName = pluginServer.serverName
    const mcp = await resolvePluginServerEndpoint(workspaceId, pluginServer)
    await assertPendingAuthRequestBinding(deps.sessionManager, {
      workspaceId,
      sourceSlug: serverName,
      sessionId,
      authRequestId,
    })
    let prepared: Awaited<ReturnType<typeof prepareEndpointOAuth>>
    try {
      prepared = await prepareEndpointOAuth(
        {
          url: mcp.url!,
          authType: 'oauth',
          ...(mcp.oauthResource ? { oauthResource: mcp.oauthResource } : {}),
          ...(mcp.clientId ? { clientId: mcp.clientId } : {}),
        },
        { callbackPort: options.callbackPort, callbackUrl: options.callbackUrl },
      )
    } catch (error) {
      throw oauthStartFailure(log, classifyOAuthStartError(error), error, {
        target: serverName,
        endpoint: mcp.url,
      })
    }
    // Pin the endpoint the flow was prepared against: a plugin update that
    // moves the endpoint between start and complete invalidates the flow
    // rather than binding a token minted for the old endpoint.
    const expected = { url: mcp.url, oauthResource: mcp.oauthResource, clientId: mcp.clientId }
    const validateBeforeExchange = async () => {
      const current = await resolvePluginServerEndpoint(workspaceId, pluginServer)
      if (current.url !== expected.url
        || current.oauthResource !== expected.oauthResource
        || current.clientId !== expected.clientId) {
        throw new Error('plugin-oauth-flow-invalidated')
      }
    }
    await validateBeforeExchange()
    await assertPendingAuthRequestBinding(deps.sessionManager, {
      workspaceId,
      sourceSlug: serverName,
      sessionId,
      authRequestId,
    })
    const flowId = randomUUID()
    flowStore.store(createPendingFlow({
      flowId,
      state: prepared.state,
      codeVerifier: prepared.codeVerifier,
      redirectUri: prepared.redirectUri,
      pluginServer,
      clientId: prepared.clientId,
      clientSecret: prepared.clientSecret,
      tokenEndpoint: prepared.tokenEndpoint,
      oauthResource: prepared.oauthResource,
      provider: prepared.provider,
      validateBeforeExchange,
      ownerClientId: options.ownerClientId,
      workspaceId,
      sourceSlug: serverName,
      sessionId,
      authRequestId,
    }))
    log.info(`[OAuth] Plugin-server flow started for ${serverName} (flow=${flowId})`)
    return { authUrl: prepared.authUrl, state: prepared.state, flowId }
  }

  // UB3.10: the source branch's single flight. `run` keeps OUR start sequence —
  // discovery, then the post-discovery revalidation of the auth-request binding
  // — and receives the waiters a restart carried over.
  const startSourceFlow = createOAuthFlowStarter({
    flowStore,
    logger: log,
    assertJoinBinding: (request) => assertPendingAuthRequestBinding(deps.sessionManager, {
      workspaceId: request.workspaceId,
      sourceSlug: request.sourceSlug,
      sessionId: request.sessionId,
      authRequestId: request.authRequestId,
    }),
    run: async (request, carriedWaiters) => {
      const workspace = getWorkspaceOrThrow(deps.workspaceService, request.workspaceId)
      const source = loadSource(workspace.workspaceRootPath, request.sourceSlug)
      if (!source) throw new Error(`Source not found: ${request.sourceSlug}`)
      // Binding validation is serialized, but discovery/DCR network work is not:
      // uninstall/update must never wait on a remote OAuth server. Revalidate
      // after preparation before publishing the pending flow.
      let prepared: Awaited<ReturnType<typeof credManager.prepareOAuth>>
      try {
        prepared = await credManager.prepareOAuth(source, {
          callbackPort: request.callbackPort,
          callbackUrl: request.callbackUrl,
        })
      } catch (error) {
        throw oauthStartFailure(log, classifyOAuthStartError(error), error, {
          target: request.sourceSlug,
          endpoint: source.config.mcp?.url,
        })
      }
      await assertPendingAuthRequestBinding(deps.sessionManager, {
        workspaceId: request.workspaceId,
        sourceSlug: request.sourceSlug,
        sessionId: request.sessionId,
        authRequestId: request.authRequestId,
      })
      const flow = createPendingFlow({
        flowId: randomUUID(),
        state: prepared.state,
        codeVerifier: prepared.codeVerifier,
        redirectUri: prepared.redirectUri,
        source,
        clientId: prepared.clientId,
        clientSecret: prepared.clientSecret,
        tokenEndpoint: prepared.tokenEndpoint,
        oauthResource: prepared.oauthResource,
        provider: prepared.provider,
        ownerClientId: request.clientId,
        workspaceId: request.workspaceId,
        sourceSlug: request.sourceSlug,
        sessionId: request.sessionId,
        authRequestId: request.authRequestId,
        waiters: carriedWaiters,
      })
      flowStore.store(flow)
      return {
        authUrl: prepared.authUrl,
        state: prepared.state,
        flowId: flow.flowId,
        expiresInMs: flow.expiresAt - Date.now(),
      }
    },
  })

  // ── oauth:start ──────────────────────────────────────────────
  server.handle(RPC_CHANNELS.oauth.START, async (ctx, args: {
    sourceSlug?: string
    /** C3 (capability-path): plugin-server target instead of a source. */
    pluginServer?: { pluginKey: string; serverName: string }
    callbackPort?: number
    callbackUrl?: string
    sessionId?: string
    authRequestId?: string
    /** UB3.10: wait on the live flow for this source instead of opening another sign-in. */
    joinLive?: boolean
    /** UB3.10: replace the live flow (its browser window was lost). */
    restart?: boolean
  }) => {
    const { sourceSlug, callbackPort, callbackUrl, sessionId, authRequestId } = args

    const workspaceId = ctx.workspaceId
    if (!workspaceId) {
      throw new Error('No workspace bound to this client')
    }

    if (args.pluginServer) {
      if (sourceSlug) throw new Error('Pass either sourceSlug or pluginServer, not both')
      return startPluginServerFlow({
        ownerClientId: ctx.clientId,
        workspaceId,
        pluginServer: args.pluginServer,
        callbackPort,
        callbackUrl,
        sessionId,
        authRequestId,
      })
    }
    if (!sourceSlug) throw new Error('sourceSlug or pluginServer is required')

    const workspace = getWorkspaceOrThrow(deps.workspaceService, workspaceId)

    const source = loadSource(workspace.workspaceRootPath, sourceSlug)
    if (!source) {
      // Reached whenever a caller sends a bare `sourceSlug` for a target that is
      // NOT a Source — a plugin-owned MCP server, whose only OAuth route is the
      // `pluginServer` branch above. The client collapses every `oauth:start`
      // rejection into START_FAILED, so without this line the product shows
      // "Unable to start OAuth authentication" and the log shows nothing.
      log.error('[OAuth] Start rejected: no such source', {
        sourceSlug,
        hint: 'a plugin-owned MCP server must be targeted with pluginServer, not sourceSlug',
      })
      throw new Error(`Source not found: ${sourceSlug}`)
    }
    await assertPendingAuthRequestBinding(deps.sessionManager, {
      workspaceId,
      sourceSlug,
      sessionId,
      authRequestId,
    })

    if (source.config.connectorOrigin) {
      // C5: connector-origin source directories are unserved rollback
      // material. Their servers ride the capability path — the plugin-server
      // target above is the only OAuth route for them.
      throw new Error('plugin-mcp-server-capability-path-required')
    }

    return startSourceFlow({
      workspaceId,
      clientId: ctx.clientId,
      sourceSlug,
      callbackPort,
      callbackUrl,
      sessionId,
      authRequestId,
      joinLive: args.joinLive,
      restart: args.restart,
    })
  })

  // ── oauth:complete ───────────────────────────────────────────
  server.handle(RPC_CHANNELS.oauth.COMPLETE, async (ctx, args: {
    flowId: string
    code: string
    state: string
  }) => {
    const { flowId, code, state } = args

    if (!ctx.workspaceId) {
      throw new Error('No workspace bound to this client')
    }

    return completeOAuthFlow({
      code,
      state,
      flowId,
      flowStore,
      credManager,
      sessionManager: deps.sessionManager,
      pushSourcesChanged: (workspaceId) => {
        notifyCredentialCatalogChanged(server, workspaceId, 'source-credential-ready', 'refresh-before-next-turn')
      },
      logger: log,
      owner: { clientId: ctx.clientId, workspaceId: ctx.workspaceId },
    })
  })

  // ── oauth:cancel ─────────────────────────────────────────────
  server.handle(RPC_CHANNELS.oauth.CANCEL, async (ctx, args: {
    flowId?: string
    state?: string
    sessionId?: string
    authRequestId?: string
    sourceSlug?: string
    /** Why the owner gave up (provider error, timeout) — reported to clients that joined (UB3.10). */
    error?: string
  }) => {
    const { flowId, state, sessionId, authRequestId, sourceSlug } = args
    const workspaceId = ctx.workspaceId
    if (!workspaceId) throw new Error('No workspace bound to this client')
    const hasFlowBinding = flowId !== undefined || state !== undefined
    const requestBinding = sessionId && authRequestId && sourceSlug
      ? { workspaceId, sourceSlug, sessionId, authRequestId }
      : null
    const hasRequestBinding = sessionId !== undefined
      || authRequestId !== undefined
      || sourceSlug !== undefined
    if (hasRequestBinding && !requestBinding) {
      throw new Error('OAuth auth request binding mismatch')
    }
    let flow: PendingOAuthFlow | null = null
    let fallbackFromMissingFlow = false
    if (hasFlowBinding) {
      if (!flowId || !state) throw new Error('OAuth flow ownership mismatch')
      const claimedFlow = flowStore.takeByStateMatching(state, {
        kind: 'owner',
        flowId,
        ownerClientId: ctx.clientId,
        workspaceId,
        requestBinding,
      })
      if (claimedFlow.status === 'missing') {
        if (!requestBinding || flowStore.hasLiveByRequest(requestBinding)) {
          throw new Error('OAuth flow ownership mismatch')
        }
        fallbackFromMissingFlow = true
      } else if (claimedFlow.status === 'mismatch') {
        throwForTerminalFlowMismatch(claimedFlow)
      } else {
        flow = claimedFlow.flow
      }
    }

    if (flow) {
      // UB3.10: the joined clients' polls read why the flow they waited on ended.
      flowStore.recordOutcome(flow, args.error ? { success: false, error: args.error } : { success: false, error: 'The sign-in was cancelled.' })
    }
    if (flow && !flow.sessionId && !flow.authRequestId) {
      log.info(`[OAuth] Flow cancelled for ${flow.sourceSlug}`)
      return { success: true }
    }
    if (!requestBinding) {
      throw new Error('OAuth auth request binding mismatch')
    }
    flowStore.takeByRequest(requestBinding)
    const claim = claimTerminalAuthRequest(
      deps.sessionManager,
      requestBinding,
      fallbackFromMissingFlow,
    )
    await deps.sessionManager.completeClaimedAuthRequest(claim, {
      requestId: requestBinding.authRequestId,
      sourceSlug: requestBinding.sourceSlug,
      success: false,
      cancelled: true,
    })
    log.info(`[OAuth] Flow cancelled for ${requestBinding.sourceSlug}`)
    return { success: true }
  })

  server.handle(RPC_CHANNELS.oauth.FAIL, async (ctx, args: {
    flowId?: string
    state?: string
    sessionId: string
    authRequestId: string
    sourceSlug: string
    code: unknown
  }) => {
    const workspaceId = ctx.workspaceId
    if (!workspaceId) throw new Error('No workspace bound to this client')
    const code = parseOAuthFailureCode(args.code)
    const hasFlowBinding = args.flowId !== undefined || args.state !== undefined
    const requestBinding = {
      workspaceId,
      sourceSlug: args.sourceSlug,
      sessionId: args.sessionId,
      authRequestId: args.authRequestId,
    }
    let flow: PendingOAuthFlow | null = null
    let fallbackFromMissingFlow = false
    if (hasFlowBinding) {
      if (!args.flowId || !args.state) throw new Error('OAuth flow ownership mismatch')
      const claimedFlow = flowStore.takeByStateMatching(args.state, {
        kind: 'owner',
        flowId: args.flowId,
        ownerClientId: ctx.clientId,
        workspaceId,
        requestBinding,
      })
      if (claimedFlow.status === 'missing') {
        if (flowStore.hasLiveByRequest(requestBinding)) {
          throw new Error('OAuth flow ownership mismatch')
        }
        fallbackFromMissingFlow = true
      } else if (claimedFlow.status === 'mismatch') {
        throwForTerminalFlowMismatch(claimedFlow)
      } else {
        flow = claimedFlow.flow
      }
    }
    if (flow) {
      // UB3.10: clients that joined the flow read the failure from oauth:status.
      flowStore.recordOutcome(flow, { success: false, error: OAUTH_FAILURE_MESSAGES[code] })
    }
    flowStore.takeByRequest(requestBinding)
    const claim = claimTerminalAuthRequest(
      deps.sessionManager,
      requestBinding,
      fallbackFromMissingFlow,
    )
    await deps.sessionManager.completeClaimedAuthRequest(claim, {
      requestId: args.authRequestId,
      sourceSlug: args.sourceSlug,
      success: false,
      error: OAUTH_FAILURE_MESSAGES[code],
    })
    return { success: false, code }
  })

  // ── oauth:status ─────────────────────────────────────────────
  // Polled by clients that joined a flow (UB3.10): still live, or how it ended.
  server.handle(RPC_CHANNELS.oauth.STATUS, async (ctx, args: { flowId: string }) => {
    if (!ctx.workspaceId) {
      throw new Error('No workspace bound to this client')
    }
    return flowStore.getStatus(args.flowId, ctx.workspaceId)
  })

  // ── oauth:revoke ─────────────────────────────────────────────
  server.handle(RPC_CHANNELS.oauth.REVOKE, async (ctx, args: {
    sourceSlug?: string
    /** C3 (capability-path): revoke a plugin server's global credential slot. */
    pluginServer?: { pluginKey: string; serverName: string }
  }) => {
    const { sourceSlug } = args

    if (!ctx.workspaceId) {
      throw new Error('No workspace bound to this client')
    }

    if (args.pluginServer) {
      if (sourceSlug) throw new Error('Pass either sourceSlug or pluginServer, not both')
      await deletePluginMcpServerCredentials(args.pluginServer.pluginKey, args.pluginServer.serverName)
      notifyCredentialCatalogChanged(server, ctx.workspaceId, 'source-credential-revoked', 'revoke-active-snapshot')
      log.info(`[OAuth] Revoked plugin-server credentials for ${args.pluginServer.serverName}`)
      return { success: true }
    }
    if (!sourceSlug) throw new Error('sourceSlug or pluginServer is required')

    const workspace = getWorkspaceOrThrow(deps.workspaceService, ctx.workspaceId)

    const source = loadSource(workspace.workspaceRootPath, sourceSlug)
    if (!source) {
      throw new Error(`Source not found: ${sourceSlug}`)
    }

    await credManager.delete(source)
    credManager.markSourceNeedsReauth(source, 'Signed out by user')

    // Push source status update
    notifyCredentialCatalogChanged(server, ctx.workspaceId, 'source-credential-revoked', 'revoke-active-snapshot')

    log.info(`[OAuth] Revoked credentials for ${sourceSlug}`)
    return { success: true }
  })
}

async function assertPendingAuthRequestBinding(
  sessionManager: Pick<HandlerDeps['sessionManager'], 'getSession'>,
  flow: {
    workspaceId: string
    sourceSlug: string
    sessionId?: string
    authRequestId?: string
  },
): Promise<void> {
  if (!flow.sessionId && !flow.authRequestId) return
  if (!flow.sessionId || !flow.authRequestId) {
    throw new Error('Incomplete OAuth auth request binding')
  }
  const session = await sessionManager.getSession(flow.sessionId, flow.workspaceId)
  const matches = session?.messages.some(message => (
    message.role === 'auth-request'
    && message.authRequestType !== 'dp'
    && message.authStatus === 'pending'
    && message.authRequestId === flow.authRequestId
    && message.authSourceSlug === flow.sourceSlug
  ))
  if (!matches) throw new Error('OAuth auth request binding mismatch')
}

function notifyCredentialCatalogChanged(
  server: RpcServer,
  workspaceId: string,
  reasonCode: string,
  effect: 'refresh-before-next-turn' | 'revoke-active-snapshot',
): void {
  emitCapabilityCatalogInvalidation({
    scope: { kind: 'workspace', workspaceId },
    reason: reasonCode,
    effect,
  })
  pushTyped(
    server,
    RPC_CHANNELS.capabilities.CHANGED,
    { to: 'workspace', workspaceId },
    { workspaceId, generation: '', reasonCode, effect },
  )
}
