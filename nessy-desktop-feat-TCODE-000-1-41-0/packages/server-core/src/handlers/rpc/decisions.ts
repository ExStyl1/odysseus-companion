/**
 * Decision layer (Jev / TypeSafe System One) RPC handlers. UB6.3.
 *
 * Copied from craft-agents-oss `v0.15.1:packages/server-core/src/handlers/rpc/decisions.ts`
 * (first appeared v0.13.6; `decisions:getUsage` is v0.14.1; Apache-2.0) and ADAPTED
 * per the row's SEC-8 line: a provider, base URL, connection or key change is
 * REFUSED from a non-local client — the same posture
 * `REMOTE_CLIENT_PERMISSION_MODE_CEILING` takes for permission modes. A non-local
 * client is one that did not arrive from a local Electron window
 * (`ctx.webContentsId == null`, or the window is unknown — the `dp-auth.ts`
 * `isLocalElectronOwner` shape): remote webui clients and the headless server's
 * own clients read everything but change nothing. The Refusal names the posture
 * so a client can map it. Reads stay REMOTE_ELIGIBLE (routing.ts).
 *
 * The `probeServer` `baseUrl` override is guarded by the same refusal (a remote
 * client must not point the server at an arbitrary URL to probe) — stated
 * extension of SEC-8, logged in the plan's Extensions log.
 *
 * Everything here is opt-in configuration; no handler runs a decision that
 * affects permissions or session behaviour.
 */

import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import { isDecisionProviderId, type DecisionProviderId } from '@nessy-agent/shared/decisions/types'
import type { DecisionLayerSettingsPatch } from '@nessy-agent/shared/decisions/settings'
import type { RequestContext, RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.decisions.GET_SETTINGS,
  RPC_CHANNELS.decisions.SET_SETTINGS,
  RPC_CHANNELS.decisions.GET_STATUS,
  RPC_CHANNELS.decisions.SET_API_KEY,
  RPC_CHANNELS.decisions.DELETE_API_KEY,
  RPC_CHANNELS.decisions.TEST,
  RPC_CHANNELS.decisions.PROBE_SERVER,
  RPC_CHANNELS.decisions.GET_USAGE,
] as const

/** Settings shows what each feature did over this window. */
const USAGE_WINDOW_MS = 7 * 24 * 3_600_000

/** The refusal a non-local client gets for a provider, URL, connection or key change (SEC-8). */
const LOCAL_ONLY_CHANGE_ERROR = 'decision-provider-change-local-only'

/** The settings fields whose change is a provider/endpoint change (SEC-8). */
const ENDPOINT_FIELDS = ['provider', 'baseUrl', 'connectionSlug'] as const;

/** A non-local client cannot change where the server sends decision state or keys. */
function assertLocalClient(ctx: RequestContext, deps: HandlerDeps): void {
  if (ctx.webContentsId == null || !deps.windowManager || !deps.windowManager.getWindowByWebContentsId(ctx.webContentsId)) {
    throw new Error(LOCAL_ONLY_CHANGE_ERROR)
  }
}

/** True when the patch touches a field only a local client may change. */
function patchTouchesEndpointFields(patch: Record<string, unknown>): boolean {
  return ENDPOINT_FIELDS.some(field => field in patch)
}

function assertProvider(provider: unknown): asserts provider is DecisionProviderId {
  if (!isDecisionProviderId(provider)) {
    throw new Error(`Invalid decision provider: ${String(provider)}`)
  }
}

export function registerDecisionsHandlers(server: RpcServer, deps: HandlerDeps): void {
  server.handle(RPC_CHANNELS.decisions.GET_SETTINGS, async () => {
    const { getDecisionLayerSettings } = await import('@nessy-agent/shared/config/storage')
    return getDecisionLayerSettings()
  })

  server.handle(RPC_CHANNELS.decisions.SET_SETTINGS, async (ctx, patch: Record<string, unknown>) => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new Error('Decision settings patch must be an object')
    }
    if (patchTouchesEndpointFields(patch)) {
      assertLocalClient(ctx, deps)
    }
    const { setDecisionLayerSettings } = await import('@nessy-agent/shared/config/storage')
    return setDecisionLayerSettings(patch)
  })

  server.handle(RPC_CHANNELS.decisions.GET_STATUS, async () => {
    const { getDecisionLayerStatus } = await import('@nessy-agent/shared/decisions')
    return getDecisionLayerStatus()
  })

  server.handle(RPC_CHANNELS.decisions.SET_API_KEY, async (ctx, provider: string, apiKey: string) => {
    assertProvider(provider)
    assertLocalClient(ctx, deps)
    if (typeof apiKey !== 'string' || !apiKey.trim()) {
      throw new Error('API key must not be empty')
    }
    const { getCredentialManager } = await import('@nessy-agent/shared/credentials')
    await getCredentialManager().setDecisionApiKey(provider, apiKey.trim())
  })

  server.handle(RPC_CHANNELS.decisions.DELETE_API_KEY, async (ctx, provider: string) => {
    assertProvider(provider)
    assertLocalClient(ctx, deps)
    const { getCredentialManager } = await import('@nessy-agent/shared/credentials')
    return getCredentialManager().deleteDecisionApiKey(provider)
  })

  // Local servers (Laya, custom): GET {baseUrl}/health so the Settings card can say whether
  // the server is up and which checkpoints it loaded. Never throws; no key is sent.
  // A non-local client may probe the CONFIGURED server but may not hand the server an
  // arbitrary URL (SEC-8 extension, stated above).
  server.handle(RPC_CHANNELS.decisions.PROBE_SERVER, async (ctx, options?: { baseUrl?: string }) => {
    const baseUrlOverride = typeof options?.baseUrl === 'string' ? options.baseUrl : undefined
    if (baseUrlOverride !== undefined) {
      assertLocalClient(ctx, deps)
    }
    const { probeConfiguredDecisionServer } = await import('@nessy-agent/shared/decisions')
    return probeConfiguredDecisionServer(undefined, { baseUrlOverride })
  })

  // Per-toggle checks, failures and changes from decisions.jsonl (and its rotated copy).
  server.handle(RPC_CHANNELS.decisions.GET_USAGE, async () => {
    const { readDecisionToggleUsage } = await import('@nessy-agent/shared/decisions')
    return readDecisionToggleUsage(new Date(Date.now() - USAGE_WINDOW_MS))
  })

  server.handle(RPC_CHANNELS.decisions.TEST, async (ctx, options?: { settings?: Record<string, unknown>; apiKey?: string }) => {
    const patch = options?.settings
    if (patch && typeof patch === 'object' && !Array.isArray(patch) && patchTouchesEndpointFields(patch as Record<string, unknown>)) {
      assertLocalClient(ctx, deps)
    }
    if (typeof options?.apiKey === 'string' && options.apiKey.trim()) {
      // An unsaved key typed into the card: a remote client must not plant key material
      // on the server either (SEC-8, same posture as SET_API_KEY).
      assertLocalClient(ctx, deps)
    }
    const { testDecisionConnection } = await import('@nessy-agent/shared/decisions')
    return testDecisionConnection({
      settings: patch as DecisionLayerSettingsPatch | undefined,
      apiKey: typeof options?.apiKey === 'string' ? options.apiKey : undefined,
    })
  })
}
