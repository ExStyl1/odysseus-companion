import type { CallbackServer } from '@nessy-agent/shared/auth/callback-server'
import {
  OAUTH_FAILURE_CODES,
  RPC_CHANNELS,
  type OAuthFailureCode,
} from '@nessy-agent/shared/protocol'
import { DEFAULT_OAUTH_FLOW_TTL_MS, SIGN_IN_RESTARTED, waitForJoinedOAuthFlow } from '../transport/source-oauth'

export const OAUTH_CLIENT_CODES = {
  CANCELLED: 'cancelled',
  CANCEL_FAILED: 'cancel-failed',
  SETTLEMENT_FAILED: 'settlement-failed',
} as const

export type OAuthClientCode = typeof OAUTH_CLIENT_CODES[keyof typeof OAUTH_CLIENT_CODES]

export interface OAuthOperationArgs {
  workspaceId?: string
  sourceSlug: string
  /**
   * C6 (capability-path): plugin-server target. When present the server-side
   * flow authenticates the server's GLOBAL plugin credential slot;
   * `sourceSlug` then carries the serverName as binding/display identity only
   * and is NOT sent to `oauth:start` (the RPC accepts exactly one target).
   */
  pluginServer?: { pluginKey: string; serverName: string }
  sessionId?: string
  authRequestId?: string
  /**
   * UB3.10: replace the live sign-in for this source (its browser window was
   * closed or lost). The server ends the replaced flow — its joined cards carry
   * over to the new one — and this client's other sign-ins for the source are
   * abandoned.
   */
  restart?: boolean
}

export interface OAuthOperationResult {
  success: boolean
  /**
   * A typed failure code when this operation owns a diagnosis; a joined flow's
   * own ending reason (UB3.10 — the provider's `error`, or the server's
   * outcome sentence) otherwise. The card only switches on the typed codes.
   */
  error?: OAuthFailureCode | OAuthClientCode | (string & {})
  email?: string
  /**
   * Why `oauth:start` was rejected, when the typed `error` alone cannot say.
   *
   * `error` stays the code every caller switches on; this is the ORIGINAL
   * rejection reason beside it, redacted (see `redactOAuthDiagnostic`). Set only
   * on the start path — the one place a rejection used to be flattened to
   * `START_FAILED` and lost, which is how a live "Unable to start OAuth
   * authentication" reached the user with `Source not found: figma` as its
   * actual cause and nothing anywhere saying so.
   */
  diagnostic?: string
}

/** Longest diagnostic we keep; a transport can reject with a whole body. */
const MAX_DIAGNOSTIC_LENGTH = 300

const DIAGNOSTIC_URL_PATTERN = /[a-z][a-z0-9+.-]*:\/\/\S+/gi

/**
 * Endpoint identity that is safe to surface: origin + pathname, never the query
 * or the fragment — an OAuth URL's query is exactly where `code`, `state` and
 * tokens live.
 *
 * Mirrors `redactUrlForDiagnostic` in `server-core/handlers/rpc/oauth.ts`. The
 * two run in different processes with different module graphs and cannot share
 * one implementation, so they are kept deliberately identical instead.
 */
function redactOAuthDiagnostic(message: string): string {
  const redacted = message.replace(DIAGNOSTIC_URL_PATTERN, match => {
    try {
      const url = new URL(match)
      return `${url.origin}${url.pathname}`
    } catch {
      return '<unparseable-url>'
    }
  })
  return redacted.length > MAX_DIAGNOSTIC_LENGTH
    ? `${redacted.slice(0, MAX_DIAGNOSTIC_LENGTH)}…`
    : redacted
}

function describeOAuthStartRejection(error: unknown): string {
  const raw = error instanceof Error
    ? (error.message || error.name)
    : String(error)
  return redactOAuthDiagnostic(raw)
}

export type OAuthCancelResult =
  | { ok: true }
  | { ok: false; code: typeof OAUTH_CLIENT_CODES.CANCEL_FAILED }

export interface OAuthOrchestrationDeps {
  createCallbackServer(): Promise<CallbackServer>
  openExternal(url: string): Promise<unknown>
  invoke(channel: string, args: Record<string, unknown>): Promise<any>
}

export interface OAuthOperation {
  result: Promise<OAuthOperationResult>
  cancel(): Promise<OAuthCancelResult>
}

export class OAuthOperationRegistry {
  private operations = new Map<string, { sourceSlug: string; operation: OAuthOperation }>()

  run(
    args: OAuthOperationArgs,
    factory: () => OAuthOperation,
  ): Promise<OAuthOperationResult> {
    const key = this.key(args)
    if (args.restart) {
      // UB3.10: a restart abandons every running sign-in for the source, and
      // only that source — each aborted operation reports the replacement.
      for (const [otherKey, running] of this.operations) {
        if (running.sourceSlug !== args.sourceSlug) continue
        void running.operation.cancel().catch(() => undefined)
        this.operations.delete(otherKey)
      }
    } else {
      const active = this.operations.get(key)
      if (active) return active.operation.result
    }

    const operation = factory()
    this.operations.set(key, { sourceSlug: args.sourceSlug, operation })
    void operation.result.finally(() => {
      const running = this.operations.get(key)
      if (running?.operation === operation) this.operations.delete(key)
    }).catch(() => undefined)
    return operation.result
  }

  get(args: OAuthOperationArgs): OAuthOperation | undefined {
    return this.operations.get(this.key(args))?.operation
  }

  private key(args: OAuthOperationArgs): string {
    return JSON.stringify([
      args.workspaceId ?? null,
      args.sessionId ?? null,
      args.authRequestId ?? null,
      args.sourceSlug,
    ])
  }
}

function waitForCallback(
  promise: CallbackServer['promise'],
  signal: AbortSignal,
): CallbackServer['promise'] {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = () => finish(() => reject(new Error(OAUTH_CLIENT_CODES.CANCELLED)))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(error)),
    )
    if (signal.aborted) onAbort()
  })
}

export function createOAuthOperation(
  deps: OAuthOrchestrationDeps,
  args: OAuthOperationArgs,
): OAuthOperation {
  const abortController = new AbortController()
  let callbackServer: CallbackServer | null = null
  let flowId: string | undefined
  let state: string | undefined
  let cancelRequested = false
  let cancelPromise: Promise<OAuthCancelResult> | null = null
  let lateBoundCleanupAttempted = false

  const workspaceArgs = args.workspaceId ? { workspaceId: args.workspaceId } : {}
  const requestArgs = args.sessionId && args.authRequestId
    ? {
        sessionId: args.sessionId,
        authRequestId: args.authRequestId,
        sourceSlug: args.sourceSlug,
      }
    : {}

  const closeCallbackServer = async () => {
    const current = callbackServer
    callbackServer = null
    if (current) await Promise.resolve(current.close()).catch(() => undefined)
  }

  const cancel = (): Promise<OAuthCancelResult> => {
    if (cancelPromise) return cancelPromise
    cancelRequested = true
    abortController.abort()
    cancelPromise = (async () => {
      await closeCallbackServer()
      if (!flowId && !args.sessionId) {
        return { ok: false, code: OAUTH_CLIENT_CODES.CANCEL_FAILED }
      }
      try {
        const response = await deps.invoke(RPC_CHANNELS.oauth.CANCEL, {
          ...(flowId && state ? { flowId, state } : {}),
          ...requestArgs,
          ...workspaceArgs,
        })
        return response?.success === true
          ? { ok: true }
          : { ok: false, code: OAUTH_CLIENT_CODES.CANCEL_FAILED }
      } catch {
        return { ok: false, code: OAUTH_CLIENT_CODES.CANCEL_FAILED }
      }
    })()
    return cancelPromise
  }

  const cancelledResult = async (): Promise<OAuthOperationResult> => {
    const result = await (cancelPromise ?? cancel())
    return {
      success: false,
      error: result.ok ? OAUTH_CLIENT_CODES.CANCELLED : result.code,
    }
  }

  const cleanupLateBoundFlow = async (): Promise<void> => {
    if (lateBoundCleanupAttempted || !flowId || !state) return
    lateBoundCleanupAttempted = true
    try {
      await deps.invoke(RPC_CHANNELS.oauth.CANCEL, {
        flowId,
        state,
        ...requestArgs,
        ...workspaceArgs,
        // UB3.10: an abort with no user cancel behind it is a restart — the
        // clients that joined this flow read this reason from oauth:status.
        ...(abortController.signal.aborted && !cancelRequested ? { error: SIGN_IN_RESTARTED.error } : {}),
      })
    } catch {
      // The request-only cancellation may already have won on the server.
    }
  }

  const fail = async (code: OAuthFailureCode): Promise<OAuthOperationResult> => {
    await closeCallbackServer()
    try {
      if (args.sessionId && args.authRequestId) {
        const response = await deps.invoke(RPC_CHANNELS.oauth.FAIL, {
          ...(flowId && state ? { flowId, state } : {}),
          ...requestArgs,
          code,
          ...workspaceArgs,
        })
        if (response?.code !== code) throw new Error(OAUTH_CLIENT_CODES.SETTLEMENT_FAILED)
      } else if (flowId && state) {
        const response = await deps.invoke(RPC_CHANNELS.oauth.CANCEL, {
          flowId,
          state,
          ...workspaceArgs,
        })
        if (response?.success !== true) throw new Error(OAUTH_CLIENT_CODES.SETTLEMENT_FAILED)
      }
      return { success: false, error: code }
    } catch {
      return { success: false, error: OAUTH_CLIENT_CODES.SETTLEMENT_FAILED }
    }
  }

  const run = async (): Promise<OAuthOperationResult> => {
    try {
      try {
        callbackServer = await deps.createCallbackServer()
        // Closing before the callback arrives leaves this promise pending.
        // Attach a rejection observer immediately so later server errors cannot
        // become unhandled after cancellation wins the abortable race.
        void callbackServer.promise.catch(() => undefined)
      } catch {
        return await fail(OAUTH_FAILURE_CODES.CALLBACK_SERVER_FAILED)
      }
      if (cancelRequested) return await cancelledResult()

      const callbackUrl = `${callbackServer.url}/callback`
      let startResult: {
        authUrl?: string
        state?: string
        flowId: string
        joined?: true
        expiresInMs?: number
      }
      try {
        startResult = await deps.invoke(RPC_CHANNELS.oauth.START, {
          ...workspaceArgs,
          ...(args.pluginServer
            ? { pluginServer: args.pluginServer }
            : { sourceSlug: args.sourceSlug }),
          callbackUrl,
          sessionId: args.sessionId,
          authRequestId: args.authRequestId,
          // UB3.10: while a sign-in for this source is live, wait on it instead
          // of opening a second browser flow. `restart` replaces it instead.
          joinLive: !args.pluginServer,
          restart: args.restart,
        })
      } catch (error) {
        if (cancelRequested) return await cancelledResult()
        const code = error instanceof Error
          && error.message.includes(OAUTH_FAILURE_CODES.METADATA_UNAVAILABLE)
          ? OAUTH_FAILURE_CODES.METADATA_UNAVAILABLE
          : OAUTH_FAILURE_CODES.START_FAILED
        // Keep the typed code the UI switches on AND the reason it replaced.
        // Two channels, because neither alone reaches everyone: the result is
        // what a caller can render, the console line is what an owner can read
        // afterwards. Target only — never the callback URL, the auth URL, the
        // state or the code.
        const diagnostic = describeOAuthStartRejection(error)
        console.error('[OAuth] start rejected', {
          code,
          target: args.pluginServer
            ? `${args.pluginServer.pluginKey}/${args.pluginServer.serverName}`
            : args.sourceSlug,
          reason: diagnostic,
        })
        return { ...(await fail(code)), diagnostic }
      }
      flowId = startResult.flowId
      state = startResult.state
      if (startResult.joined) {
        // UB3.10: another window/session is already signing in to this source.
        // No browser, no callback route of our own — poll oauth:status until
        // the shared flow ends and report how it ended.
        await closeCallbackServer()
        if (abortController.signal.aborted) return { success: false, error: SIGN_IN_RESTARTED.error }
        return await waitForJoinedOAuthFlow(deps.invoke, startResult.flowId, {
          timeoutMs: startResult.expiresInMs ?? DEFAULT_OAUTH_FLOW_TTL_MS,
          signal: abortController.signal,
        })
      }
      if (cancelRequested) {
        await cleanupLateBoundFlow()
        return await cancelledResult()
      }

      try {
        await deps.openExternal(startResult.authUrl!)
      } catch {
        return await fail(OAUTH_FAILURE_CODES.BROWSER_OPEN_FAILED)
      }
      if (cancelRequested) return await cancelledResult()

      let callback: Awaited<CallbackServer['promise']>
      try {
        callback = await waitForCallback(callbackServer.promise, abortController.signal)
      } catch {
        if (cancelRequested) return await cancelledResult()
        return await fail(OAUTH_FAILURE_CODES.PROVIDER_CALLBACK_FAILED)
      }
      if (callback.query.error) {
        return await fail(OAUTH_FAILURE_CODES.PROVIDER_CALLBACK_FAILED)
      }
      const code = callback.query.code
      if (!code) return await fail(OAUTH_FAILURE_CODES.AUTHORIZATION_CODE_MISSING)

      try {
        const result = await deps.invoke(RPC_CHANNELS.oauth.COMPLETE, {
          flowId,
          code,
          state,
          ...workspaceArgs,
        })
        if (!result?.success) {
          return {
            success: false,
            error: result?.error === OAUTH_FAILURE_CODES.COMPLETE_FAILED
              ? OAUTH_FAILURE_CODES.COMPLETE_FAILED
              : OAUTH_CLIENT_CODES.SETTLEMENT_FAILED,
          }
        }
        return {
          success: true,
          ...(typeof result.email === 'string' ? { email: result.email } : {}),
        }
      } catch {
        if (cancelRequested) return await cancelledResult()
        return await fail(OAUTH_FAILURE_CODES.COMPLETE_FAILED)
      }
    } finally {
      await closeCallbackServer()
    }
  }

  return { result: run(), cancel }
}
