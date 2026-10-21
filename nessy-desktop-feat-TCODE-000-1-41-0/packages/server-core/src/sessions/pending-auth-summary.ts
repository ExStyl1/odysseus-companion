/**
 * Pending-auth summary (T4, plugin-install plan § 5).
 *
 * The pure shaping half of `SessionManager.getWorkspacePendingAuth`: given the
 * workspace's resolved snapshot entries, the materialized runtime sources, the
 * dp external-auth requirements and the pool's failed slugs, produce the
 * value-only summary the session-start notice renders. Extracted so the
 * truth-telling is unit-testable without a live resolver or pool.
 *
 * Three feeds, matching the plan's "every server needing auth":
 *
 * 1. `getSourcesNeedingAuth` over the materialized sources — ENABLED sources
 *    whose oauth/bearer/api credential is not yet present (sign-in works).
 * 1b. (H1) Servers the POOL saw answer 401/403, at connect or on a tool call.
 *    Feed 1 cannot see these: a credential the provider revoked leaves
 *    `isAuthenticated` true, so an empty-slot test reports nothing and the
 *    server surfaced only as "failed to connect".
 * 2. Snapshot entries parked with `credential-missing`/`credential-expired` —
 *    the resolver disables these, so feed 1 cannot see them. Source-kind rows
 *    keep the one-click sign-in; capability-kind rows are informational.
 * 3. The dp requirement `materializeRuntimePoolServers` computed — the
 *    silently-dropped dp set, with the one-login-unblocks-N server list.
 *
 * Plus the pool's failed slugs, so a broken server surfaces at start (T10's
 * notice gate) instead of at first tool call.
 */

import type { LoadedSource } from '@nessy-agent/shared/sources'
import { getSourcesNeedingAuth, sourceSupportsAuthentication } from '@nessy-agent/shared/sources'
import type { RuntimeExternalAuthRequirement } from '@nessy-agent/shared/mcp'
import type { SafeWorkspacePendingAuth } from '@nessy-agent/shared/protocol'

/** The subset of a resolved snapshot entry this summary reads. */
export interface PendingAuthSnapshotEntry {
  summary: {
    kind: string
    logicalName: string
    displayName?: string
    sourceType?: string
    enabled: boolean
    unavailableReason?: string
  }
}

export interface PendingAuthSummaryInput {
  workspaceId: string
  snapshotEntries: readonly PendingAuthSnapshotEntry[]
  materializedSources: readonly LoadedSource[]
  externalAuthRequirements: readonly RuntimeExternalAuthRequirement[]
  failedSlugs: readonly string[]
  /**
   * H1: slugs whose server answered 401/403 (`McpClientPool.authNeededSlugs`).
   * Defaulted so a caller that has no pool — and every existing test — keeps
   * its exact behaviour.
   */
  authFailedSlugs?: readonly string[]
  /**
   * P6.256: stored credential expiries the caller read, so the notice can warn
   * BEFORE the credential dies instead of only after. Absent means the caller
   * did not look, which is the state every existing caller and test is in.
   */
  credentialExpiries?: readonly StoredCredentialExpiryV1[]
  /** Test seam over the clock; production passes nothing. */
  now?: number
  /**
   * T8: true when the dp session broker's probe reports an outdated dp
   * binary. Defaulted so every existing caller/test keeps its exact
   * behaviour — the field is OMITTED from the summary unless true.
   */
  dpOutdated?: boolean
}

const CREDENTIAL_REASONS = new Set(['credential-missing', 'credential-expired'])

/**
 * P6.256 — how far ahead a stored credential's expiry is worth saying.
 *
 * A CONSTANT, and the row says so in as many words: *"the threshold is a
 * constant, not a question."* Seven days is one working week — long enough that
 * a user who signs in on Monday is warned before the weekend, short enough that
 * the notice is not permanent furniture on a machine whose tokens all last a
 * year.
 */
export const CREDENTIAL_EXPIRY_NOTICE_DAYS = 7

const MS_PER_DAY = 24 * 60 * 60 * 1000

/** One stored credential's expiry, as the caller read it. NEVER the token. */
export interface StoredCredentialExpiryV1 {
  readonly sourceSlug: string
  /** The source's display name, when the caller has one. */
  readonly name?: string
  /** Epoch milliseconds, as the OAuth exchange wrote it. */
  readonly expiresAt: number
  /**
   * True when a refresh token can renew it WITHOUT the user.
   *
   * The single most important field here. An ordinary OAuth access token lasts
   * an hour and renews itself; warning about one every hour would train every
   * user to ignore this notice long before a credential that really is about to
   * die reaches them. Only a credential the user must act on is announced.
   */
  readonly renewable?: boolean
}

export function buildPendingAuthSummary(input: PendingAuthSummaryInput): SafeWorkspacePendingAuth {
  const rows = new Map<string, SafeWorkspacePendingAuth['sources'][number]>()

  // Feed 1: enabled sources awaiting authentication (actionable sign-in).
  for (const source of getSourcesNeedingAuth([...input.materializedSources])) {
    rows.set(source.config.slug, {
      workspaceId: input.workspaceId,
      sourceSlug: source.config.slug,
      name: source.config.name || source.config.slug,
      reason: 'needs-auth',
      canSignIn: true,
    })
  }

  // Feed 1b (H1): the server itself rejected the credential with 401/403.
  //
  // `credential-expired` rather than `needs-auth` because that is what happened
  // and what the row already says ("the stored credential expired. Sign in
  // again") — a filled slot the provider no longer honours.
  //
  // The promotion is EVIDENCE-GATED in both directions, because conflating a
  // broken server with a signed-out one is the mirror-image defect:
  // - A matched source that declares no auth (`authType` unset/'none', or
  //   stdio) is MISCONFIGURED, not signed out. There is no credential slot to
  //   write and `performOAuth` would have nothing to do, so it stays in
  //   `failedServers` and the user is pointed at the server, not at a button
  //   that cannot help.
  // - A slug with no materialized source is a plugin/builtin wire name. A
  //   401/403 is still positive evidence its credential was rejected, so the
  //   row is told truthfully — but without `canSignIn`, since the one-click
  //   flow needs a `pluginServer` target that a wire name alone cannot yield
  //   (a plugin server's OAuth slot lives on its own page, and
  //   `externalAuthRequirements` names it only while the slot is EMPTY).
  //
  // A CONNECTOR-materialized source carries its plugin target, and `oauth:start`
  // refuses a bare slug for one (`plugin-mcp-server-capability-path-required`),
  // so the row hands over `pluginServer` exactly as feed 2b does — otherwise the
  // button would exist and always throw.
  const sourcesBySlug = new Map(input.materializedSources.map(source => [source.config.slug, source]))
  for (const slug of input.authFailedSlugs ?? []) {
    if (rows.has(slug)) continue
    const source = sourcesBySlug.get(slug)
    if (source && !sourceSupportsAuthentication(source)) continue
    const connectorOrigin = source?.config.connectorOrigin
    rows.set(slug, {
      workspaceId: input.workspaceId,
      sourceSlug: slug,
      name: source?.config.name || slug,
      reason: 'credential-expired',
      canSignIn: !!source,
      ...(connectorOrigin
        ? { pluginServer: { pluginKey: connectorOrigin.pluginKey, serverName: connectorOrigin.serverName } }
        : {}),
    })
  }

  // Feed 2: credential-parked entries the resolver disabled — invisible to
  // feed 1 precisely because parking disables them.
  for (const entry of input.snapshotEntries) {
    const { summary } = entry
    if (!summary.unavailableReason || !CREDENTIAL_REASONS.has(summary.unavailableReason)) continue
    if (summary.kind !== 'source' && summary.kind !== 'mcp') continue
    if (rows.has(summary.logicalName)) continue
    rows.set(summary.logicalName, {
      workspaceId: input.workspaceId,
      sourceSlug: summary.logicalName,
      name: summary.displayName ?? summary.logicalName,
      reason: summary.unavailableReason === 'credential-expired' ? 'credential-expired' : 'credential-missing',
      // Only a Source row has the oauth flow behind its slug; a capability
      // (native plugin MCP) row is informational — its values are filled on
      // the plugin's page.
      canSignIn: summary.kind === 'source',
    })
  }

  // Feed 2b (C6): the GENERALIZED needs-auth feed — plugin servers whose
  // global credential slot is empty ride `externalAuthRequirements` as
  // 'oauth'/'bearer' entries (ADR § 4). OAuth rows get the one-click
  // plugin-server sign-in; bearer rows are informational.
  for (const requirement of input.externalAuthRequirements) {
    if (requirement.provider === 'dp' || requirement.state === 'ready') continue
    for (const server of requirement.servers ?? []) {
      if (rows.has(server.serverName)) continue
      rows.set(server.serverName, {
        workspaceId: input.workspaceId,
        sourceSlug: server.serverName,
        name: server.serverName,
        reason: 'needs-auth',
        canSignIn: requirement.provider === 'oauth',
        pluginServer: { pluginKey: server.pluginKey, serverName: server.serverName },
      })
    }
  }

  const dpRequirement = input.externalAuthRequirements.find(
    requirement => requirement.provider === 'dp' && requirement.state !== 'ready',
  )
  const builtinNames = new Set(dpRequirement?.builtinWireNames ?? [])
  // needs-login blocks everything; any other non-ready state blocks only
  // plugin-bound servers — builtins stay connected and must not be listed.
  const blockedDpNames = dpRequirement
    ? (dpRequirement.state === 'needs-login'
        ? [...dpRequirement.wireNames]
        : dpRequirement.wireNames.filter(name => !builtinNames.has(name)))
    : []

  // P6.256 — the ADVANCE notice. Everything above this line reports a
  // credential that is already missing, already rejected or already expired;
  // this is the only thing in the summary that fires while the session still
  // works, which is the whole point: at HEAD the earliest a user could learn
  // that a credential was about to die was the turn it died on.
  //
  // Four exclusions, and each is a way the notice would otherwise become noise
  // and be ignored by the time it mattered:
  //  - a RENEWABLE credential (see the field's own note) — an hourly OAuth
  //    token renews itself and warning about it teaches the user to skip this
  //    whole notice;
  //  - one that has ALREADY expired — that is `credential-expired` above, with
  //    a sign-in button, and saying it twice in two voices is worse than once;
  //  - a slug that already has a row — the same source cannot be both "sign in
  //    now" and "sign in within a week";
  //  - anything beyond the threshold, which is most credentials most days.
  const now = input.now ?? Date.now()
  const expiringSoon = (input.credentialExpiries ?? [])
    .filter(entry => !entry.renewable
      && entry.expiresAt > now
      && entry.expiresAt - now <= CREDENTIAL_EXPIRY_NOTICE_DAYS * MS_PER_DAY
      && !rows.has(entry.sourceSlug))
    .map(entry => ({
      sourceSlug: entry.sourceSlug,
      name: entry.name || entry.sourceSlug,
      // At least one: a credential dying in four hours is "1 day", not "0
      // days", which reads as already gone. `Math.ceil` alone would say 1 for
      // anything under a day and 0 only for an exact instant, but the floor is
      // written down rather than inferred.
      daysLeft: Math.max(1, Math.ceil((entry.expiresAt - now) / MS_PER_DAY)),
    }))
    .sort((a, b) => a.daysLeft - b.daysLeft || a.sourceSlug.localeCompare(b.sourceSlug))

  const pendingSlugs = new Set(rows.keys())
  const failedServers = [...new Set(input.failedSlugs)]
    .filter(slug => !pendingSlugs.has(slug))
    .sort()

  return {
    ...(dpRequirement && blockedDpNames.length > 0
      ? {
          dp: {
            state: dpRequirement.state === 'needs-login' ? 'needs-login' : 'unavailable',
            serverNames: [...blockedDpNames].sort(),
          },
        }
      : {}),
    ...(input.dpOutdated ? { dpOutdated: true } : {}),
    ...(expiringSoon.length > 0 ? { expiringSoon } : {}),
    sources: [...rows.values()].sort((a, b) => a.sourceSlug.localeCompare(b.sourceSlug)),
    failedServers,
  }
}

/** True when the summary carries nothing worth a notice (positive control). */
export function isPendingAuthEmpty(summary: SafeWorkspacePendingAuth): boolean {
  return !summary.dp
    && summary.sources.length === 0
    && summary.failedServers.length === 0
    // P6.256 — an advance warning alone is enough to raise the notice. Without
    // this the summary would carry the one row it exists to deliver and the
    // notice would render nothing.
    && (summary.expiringSoon?.length ?? 0) === 0
}
