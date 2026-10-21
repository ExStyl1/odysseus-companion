/**
 * Fail-closed startup under `forceRemoteSettingsRefresh` —
 * `server-managed-settings.md#enforce-fail-closed-startup`.
 *
 * Every citation below is that section plus the verbatim sentence. It used to
 * cite `:185`-`:205` and eleven line numbers inside them; re-checked 2026-08-28
 * that section had NOT moved and thirteen of fourteen still landed — the
 * exception was `:139`, noted at its own site. They are anchors now anyway: a
 * line number that happens to land today is still a line number.
 *
 * "When this setting is active in a session that fetches server-managed
 * settings, the CLI blocks at startup until remote settings are freshly
 * fetched. If the fetch fails, the CLI exits rather than proceeding without the
 * policy."
 *
 * ## The lockout this module is mostly about
 *
 * The same section exempts the auth path — "The `claude auth` subcommands such
 * as `claude auth login` are exempt from this check and from the gateway
 * startup exit, so users can re-authenticate when expired credentials are the
 * reason the settings fetch fails". (The exemption GREW a clause since this
 * file quoted it: "and from the gateway startup exit".) Upstream
 * that exemption is cheap: `claude auth login` is a SEPARATE process invocation,
 * so exempting it is exempting an entry point.
 *
 * We have no such process. `apps/cli` has no `auth` subcommand and the desktop
 * app authenticates in-process through `ensureNessyGatewayAuth()`. A literal
 * port — "exit at startup on any fetch failure" — would therefore make expired
 * credentials UNRECOVERABLE: the fetch needs a JWT, the JWT needs a sign-in, and
 * the sign-in lives inside the process that just exited. The user would have to
 * hand-delete a cache file to start the app again.
 *
 * So the failure is classified instead of collapsed. The gate has exactly one
 * question — did a fresh fetch succeed this session? — and exactly two reasons
 * it can answer no:
 *
 * 1. We could not make the request at all, because there are no valid gateway
 *    credentials. This is the auth exemption's case, and it resolves to
 *    `needs-authentication`: the app routes to the sign-in flow and re-runs the
 *    gate afterwards. It never exits, because exiting is what removes the
 *    remedy.
 * 2. The request was made and failed. This is the blocks-at-startup sentence
 *    plus "If that endpoint is unreachable, the CLI exits at startup and users
 *    cannot start Claude Code", and it resolves to `blocked` with a recovery
 *    message.
 *
 * There is no third cause, so the exemption is complete by construction rather
 * than by enumerating functions. The corresponding rule at the call sites is
 * that the gateway-auth entry points (`nessy:ensureGatewayAuth`,
 * `nessy:cancelGatewayAuth`, `nessy:getGatewayJwt`, and the silent launch probe
 * `ensureGatewayAuthForLaunch`) must stay reachable inside a gated process —
 * they are this repo's `claude auth`, and the launch probe in particular would
 * deadlock the gate if it were itself gated.
 */

import type { ManagedPiPolicyV1 } from '../agent/pi-harness/managed-policy.ts'
import {
  getManagedDeliveryState,
  loadCachedManagedDelivery,
  NESSY_MANAGED_SETTINGS_URL,
  refreshManagedDelivery,
  type ManagedDeliveryStateV1,
} from './managed-delivery.ts'

/**
 * `#enforce-fail-closed-startup` — an exception to the precedence rule.
 * Normally the managed tier picks ONE source: `#settings-precedence` says
 * "Within the managed tier, Claude Code by default uses the first source that
 * delivers at least one policy key, checking server-managed settings first and
 * then endpoint-managed settings, apart from the exception keys covered next."
 * (That precedence claim was cited as `:139`, which is the ONE citation in this
 * file that had gone dead — `:139` is a blank line today.) This one key is
 * honoured "when set in any admin-controlled managed source even if a cached
 * server-managed payload is also present", so an MDM-delivered value is not
 * swallowed when a server payload exists.
 *
 * The host-owned policy file and its drop-in fragments are our
 * admin-controlled endpoint source; the delivered cache is the server one.
 * Either turning it on turns it on.
 */
export function isForceRemoteSettingsRefreshRequired(sources: {
  /** The host-owned `managed-policy.json` (+ `managed-policy.d/`) policy. */
  managedFile?: ManagedPiPolicyV1 | undefined
  /** The server-delivered cache, already parsed. */
  cached?: ManagedPiPolicyV1 | undefined
}): boolean {
  return sources.managedFile?.forceRemoteSettingsRefresh === true
    || sources.cached?.forceRemoteSettingsRefresh === true
}

export type ForceRefreshOutcomeV1 =
  /**
   * No admin source asks for it. Startup proceeds as usual — the section's
   * default: "if the remote settings fetch fails at startup, the CLI continues
   * with the settings cached from the last successful fetch".
   */
  | 'not-required'
  /** An authentication entry point — the `claude auth` exemption. */
  | 'exempt'
  /** A fresh fetch succeeded, in this call or earlier this session. */
  | 'satisfied'
  /** No usable credentials, so sign in and run the gate again. Never exits. */
  | 'needs-authentication'
  /** The fetch was made and failed — exit rather than proceed. */
  | 'blocked'

export interface ForceRefreshDecisionV1 {
  readonly outcome: ForceRefreshOutcomeV1
  /** Admin-facing cause. Never carries a token, payload or credentialed URL. */
  readonly reason?: string
  /**
   * What the user or admin can do about it — the section's connectivity
   * warning, "ensure your network policies allow connectivity to
   * `api.anthropic.com`".
   */
  readonly recovery?: string
  readonly state?: ManagedDeliveryStateV1
}

export interface ForceRefreshGateOptions {
  managedFilePolicy?: ManagedPiPolicyV1 | undefined
  cachePath?: string
  /**
   * True when this entry point exists to obtain credentials. The `claude auth`
   * exemption, expressed as a flag because our auth entry points are IPC
   * channels inside the process rather than separate binaries.
   */
  exempt?: boolean
  /**
   * The gateway JWT, or `null`/`undefined` when there is none. Absent
   * credentials are the `needs-authentication` branch, never `blocked`.
   */
  jwt?: string | null
  /** Injectable refresh — the only seam tests use. */
  refresh?: (jwt: string) => Promise<ManagedDeliveryStateV1>
  /** Injectable read of the current session state. */
  currentState?: () => ManagedDeliveryStateV1
}

const RECOVERY = (
  'Managed settings could not be refreshed and this organization requires a fresh '
  + 'policy before startup. Check network access to '
  + `${NESSY_MANAGED_SETTINGS_URL}, then start Nessy Desktop again. `
  + 'If you were signed out, sign in to the Nessy Gateway first.'
)

/**
 * Run the gate. Returns a decision; it never exits the process itself, because
 * "how to refuse" differs between the desktop shell (an error dialog then quit)
 * and the headless server (stderr then a non-zero exit).
 */
export async function enforceForceRemoteSettingsRefresh(
  options: ForceRefreshGateOptions = {},
): Promise<ForceRefreshDecisionV1> {
  const cached = loadCachedManagedDelivery(
    options.cachePath ?? undefined,
  ).policy
  const required = isForceRemoteSettingsRefreshRequired({
    managedFile: options.managedFilePolicy,
    cached,
  })
  if (!required) return Object.freeze({ outcome: 'not-required' as const })
  if (options.exempt) return Object.freeze({ outcome: 'exempt' as const })

  const current = (options.currentState ?? getManagedDeliveryState)()
  if (current.confirmed) {
    return Object.freeze({ outcome: 'satisfied' as const, state: current })
  }

  const jwt = options.jwt
  if (typeof jwt !== 'string' || jwt.length === 0) {
    return Object.freeze({
      outcome: 'needs-authentication' as const,
      reason: 'no Nessy Gateway credentials are available to fetch managed settings',
      recovery: RECOVERY,
    })
  }

  const refresh = options.refresh
    ?? ((token: string) => refreshManagedDelivery({
      jwt: token,
      force: true,
      ...(options.cachePath === undefined ? {} : { cachePath: options.cachePath }),
    }))
  try {
    const state = await refresh(jwt)
    if (!state.confirmed) {
      return Object.freeze({
        outcome: 'blocked' as const,
        reason: 'the managed settings fetch did not confirm the payload',
        recovery: RECOVERY,
      })
    }
    return Object.freeze({ outcome: 'satisfied' as const, state })
  } catch (error) {
    // The message is the fetch module's own, which is already scrubbed of the
    // request URL — a proxied URL can carry credentials.
    return Object.freeze({
      outcome: 'blocked' as const,
      reason: error instanceof Error ? error.message : 'managed settings fetch failed',
      recovery: RECOVERY,
    })
  }
}
