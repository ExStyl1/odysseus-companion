import { existsSync, readFileSync } from 'fs'
import {
  ensureNessyGatewayAuth,
  getCredsPath,
  isJwtShaped,
  DpAuthError,
  DpAuthServiceError,
  type GatewayAuthStatus,
  type GatewayAuthResult,
} from '@nessy-agent/shared/auth/dp'
import { isGatewayBackedConnection } from '@nessy-agent/shared/agent/backend'
import { isCodexRuntimeEnabled, resolveProviderFlags } from '@nessy-agent/shared/feature-flags'

export const NESSY_GATEWAY_JWT_CHANNEL = 'nessy:getGatewayJwt'
export const NESSY_GATEWAY_ENSURE_AUTH_CHANNEL = 'nessy:ensureGatewayAuth'
export const NESSY_GATEWAY_AUTH_STATUS_CHANNEL = 'nessy:gatewayAuthStatus'
export const NESSY_GATEWAY_CANCEL_AUTH_CHANNEL = 'nessy:cancelGatewayAuth'
export const NESSY_CODEX_RUNTIME_ENABLED_CHANNEL = 'nessy:isCodexRuntimeEnabled'
export const NESSY_PROVIDER_FLAGS_CHANNEL = 'nessy:getProviderFlags'

/** Status codes broadcast on NESSY_GATEWAY_AUTH_STATUS_CHANNEL. The facade codes
 * plus `login-required`, which the launch check emits (Task 2.3). */
export type GatewayAuthStatusEvent = GatewayAuthStatus | 'login-required'

/** Renderer-facing ensure result — never carries the JWT value (the renderer
 * reads it via NESSY_GATEWAY_JWT_CHANNEL after auth resolves). */
export type EnsureGatewayAuthResult =
  | { ok: true; username: string }
  | { ok: false; code: DpAuthError }

/**
 * P3.143: the default was `join(homedir(), '.nessy', 'dp_auth_creds.json')` —
 * a SECOND hand-written resolution of the file `auth/dp/creds-store.ts` calls
 * the single source of truth for. Two consequences, and the second is the one
 * that mattered: the literal could drift from the writer's, and it read a live
 * `os.homedir()`, so a confirmed managed `HOME` moved the READ side of the
 * credential mid-session in the Electron main process — which is Node, and is
 * the same process that applies the managed `env` block. Delegating to
 * `getCredsPath()` fixes both at once; the latch lives there.
 */
export function readNessyGatewayJwt(credsPath = getCredsPath()): { jwt: string } | null {
  try {
    if (!existsSync(credsPath)) return null
    const parsed = JSON.parse(readFileSync(credsPath, 'utf8')) as { jwt?: unknown }
    return typeof parsed.jwt === 'string' && parsed.jwt.trim() && isJwtShaped(parsed.jwt)
      ? { jwt: parsed.jwt }
      : null
  } catch {
    return null
  }
}

interface GatewayAuthControllerDeps {
  ensure: typeof ensureNessyGatewayAuth
  broadcastStatus: (status: GatewayAuthStatusEvent) => void
}

/**
 * Main-process single-flight for the gateway auth run. Concurrent renderer
 * `ensure` invokes share one run + one AbortController so a `cancel` from any
 * window kills the pending `dp auth login`. The facade single-flights too; this
 * mirror owns the AbortController and the status fan-out to windows.
 *
 * Composition with that facade single-flight (DA1.1). This mirror only ever
 * ORIGINATES forced runs, so it cannot hand a click the cached JWT held by the
 * silent launch ensure: `ensureNessyGatewayAuth` now makes a `forceRefresh`
 * caller await a non-forced run in flight and then re-mint, instead of joining
 * it. One join survives here on purpose — a second click arriving after the
 * forced attempt has already failed joins this run's FALLBACK, which is
 * deliberately non-forced and warm. Splitting the single-flight at that
 * boundary was weighed and declined: the fallback runs precisely because the
 * forced path failed, so a fresh forced run would re-derive the same failure
 * and could spend the user's second browser prompt on it, which the note below
 * exists to prevent. The wait the facade now adds is bounded by the 30 s dp
 * exec budget.
 */
export function createGatewayAuthController(deps: GatewayAuthControllerDeps) {
  let inflight: Promise<GatewayAuthResult> | null = null
  let inflightController: AbortController | null = null

  const mapOk = (r: GatewayAuthResult): EnsureGatewayAuthResult => ({
    ok: true,
    username: r.username,
  })
  const mapErr = (err: unknown): EnsureGatewayAuthResult => ({
    ok: false,
    code: err instanceof DpAuthServiceError ? err.code : DpAuthError.ExecFailed,
  })
  const isCancelled = (err: unknown): boolean =>
    err instanceof DpAuthServiceError && err.code === DpAuthError.Cancelled

  /**
   * Explicit user-initiated Sign-in: force a re-mint FIRST rather than
   * replaying a cached JWT the user may be clicking through specifically
   * because it stopped working (a rejected, not just expired, token — the
   * whole point of T5). The silent launch path (ensureGatewayAuthForLaunch)
   * deliberately keeps the warm path instead — startup must stay cheap.
   *
   * But `forceRefresh` skips BOTH the warm cached-creds path AND the
   * nessy-cli seed (T6), so a user whose creds legitimately came from
   * nessy-cli — dp missing or outdated — would see Sign-in fail even though a
   * perfectly usable cached/seeded JWT already exists. A non-cancel failure
   * therefore falls back to ONE non-forced, non-interactive attempt: it
   * re-checks the warm cache and the seed without re-running the interactive
   * dp login the forced attempt just went through (and failed) — the forced
   * attempt already gave the user their one browser prompt.
   *
   * A cancellation is never masked by the fallback: it means the user closed
   * the browser window, not that dp is unusable, and silently trying a
   * different path behind their back would report a login they explicitly
   * refused as having succeeded.
   */
  async function runForcedThenFallback(controller: AbortController): Promise<GatewayAuthResult> {
    const onStatus = (status: GatewayAuthStatus) => deps.broadcastStatus(status)
    try {
      return await deps.ensure({ signal: controller.signal, onStatus, forceRefresh: true })
    } catch (forcedError) {
      if (isCancelled(forcedError)) throw forcedError
      try {
        return await deps.ensure({
          signal: controller.signal,
          onStatus,
          forceRefresh: false,
          interactive: false,
        })
      } catch (fallbackError) {
        // A cancellation raised DURING the fallback is real too. Anything
        // else is not a usable JWT (rule: never report success without one)
        // — surface the FORCED attempt's error, since that is the one the
        // user's click actually triggered and is typically the more
        // actionable of the two (e.g. DpNotFound vs. the fallback's generic
        // NeedsLogin).
        throw isCancelled(fallbackError) ? fallbackError : forcedError
      }
    }
  }

  async function ensure(): Promise<EnsureGatewayAuthResult> {
    if (inflight) return inflight.then(mapOk, mapErr)
    const controller = new AbortController()
    inflightController = controller
    inflight = runForcedThenFallback(controller)
    try {
      return await inflight.then(mapOk, mapErr)
    } finally {
      inflight = null
      inflightController = null
    }
  }

  function cancel(): void {
    inflightController?.abort()
  }

  return { ensure, cancel }
}

/*
 * DA1.31 — the gateway predicate this module used to declare for itself is gone,
 * and the three functions below read the ONE exported rule
 * (`isGatewayBackedConnection`, `@nessy-agent/shared`
 * `agent/backend/internal/drivers/upstream-target.ts`). The removed copy carried
 * the reason for its own existence in its docblock — the SessionManager twin was
 * "a private method, not an export, so it cannot be imported here" — and DA1.13
 * exported the rule, so that reason has dissolved.
 *
 * Two consequences, both deliberate. (1) `gatewayBaseUrl` is no longer a
 * parameter anywhere in this file: the import IS the boundary, derived from the
 * URL the adapter actually posts to, so no caller can supply a different one.
 * That also drops this main-process module's only reason to reach into the
 * RENDERER tree for `NESSY_GATEWAY_BASE_URL`. (2) the base-URL comparison is now
 * NORMALISED (space and trailing slashes trimmed) where it used to be a raw
 * `===`, so a card whose stored URL carries a trailing slash is recognised here
 * as it already is everywhere else. That is strictly fewer false negatives and
 * no new false positive: a blank base URL is still not the gateway.
 */

export async function ensureGatewayAuthForLaunch(deps: {
  connections: Array<{ providerType?: string; baseUrl?: string }>
  hasValidCreds: boolean
  ensure?: typeof ensureNessyGatewayAuth
}): Promise<boolean> {
  if (deps.hasValidCreds) return true
  if (!deps.connections.some((c) => isGatewayBackedConnection(c))) return false

  try {
    await (deps.ensure ?? ensureNessyGatewayAuth)({ interactive: false })
    return true
  } catch (err) {
    if (err instanceof DpAuthServiceError && err.code === DpAuthError.NeedsLogin) return false
    return false
  }
}

/** True when a gateway connection exists but there is no valid cached JWT — the
 * launch check uses this to prompt a one-click sign-in. */
export function shouldPromptGatewayLogin(
  connections: Array<{ providerType?: string; baseUrl?: string }>,
  hasValidCreds: boolean,
): boolean {
  if (hasValidCreds) return false
  return connections.some((c) => isGatewayBackedConnection(c))
}

/**
 * Launch check: emit ONE `login-required` status if a gateway connection needs
 * a JWT it doesn't have. Fully injected so it is unit-tested without Electron;
 * the caller (main/index.ts) supplies real connections/creds/broadcast.
 */
export function runGatewayLoginCheck(deps: {
  connections: Array<{ providerType?: string; baseUrl?: string }>
  hasValidCreds: boolean
  broadcast: (status: GatewayAuthStatusEvent) => void
}): boolean {
  const prompt = shouldPromptGatewayLogin(deps.connections, deps.hasValidCreds)
  if (prompt) deps.broadcast('login-required')
  return prompt
}

export function registerNessyAuthIpcHandlers(): void {
  const { ipcMain, BrowserWindow } = require('electron') as typeof import('electron')

  ipcMain.handle(NESSY_GATEWAY_JWT_CHANNEL, () => readNessyGatewayJwt())

  const controller = createGatewayAuthController({
    ensure: ensureNessyGatewayAuth,
    broadcastStatus: (status) => {
      for (const win of appWindows(BrowserWindow.getAllWindows())) { // UA12.80 — not the hidden capture window
        win.webContents.send(NESSY_GATEWAY_AUTH_STATUS_CHANNEL, status)
      }
    },
  })

  ipcMain.handle(NESSY_GATEWAY_ENSURE_AUTH_CHANNEL, () => controller.ensure())
  ipcMain.handle(NESSY_GATEWAY_CANCEL_AUTH_CHANNEL, () => {
    controller.cancel()
  })
  ipcMain.handle(NESSY_CODEX_RUNTIME_ENABLED_CHANNEL, () => isCodexRuntimeEnabled())
  ipcMain.handle(NESSY_PROVIDER_FLAGS_CHANNEL, () => resolveProviderFlags())
}

// UA12.80 — appended below the lines the docs cite (import declarations are hoisted).
import { appWindows } from '../app-windows'
