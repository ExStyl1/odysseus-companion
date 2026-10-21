/**
 * T4 (plugin-install plan § 5): the pending-auth summary tells the whole
 * truth — the dp set, sources awaiting sign-in, credential-parked servers,
 * and broken servers — and stays EMPTY when everything is ready (the
 * positive control the notice's absence relies on).
 *
 * Mutation probe: dropping any feed from `buildPendingAuthSummary` turns the
 * corresponding assertion red.
 */

import { describe, expect, test } from 'bun:test'
import type { LoadedSource } from '@nessy-agent/shared/sources'
import {
  CREDENTIAL_EXPIRY_NOTICE_DAYS,
  buildPendingAuthSummary,
  isPendingAuthEmpty,
} from '../pending-auth-summary.ts'

function oauthSource(slug: string, options: { authenticated?: boolean; enabled?: boolean } = {}): LoadedSource {
  return {
    config: {
      slug,
      name: `Source ${slug}`,
      type: 'mcp',
      enabled: options.enabled ?? true,
      isAuthenticated: options.authenticated ?? false,
      mcp: { transport: 'http', url: `https://example.test/${slug}`, authType: 'oauth' },
    },
    guide: null,
    folderPath: `/tmp/sources/${slug}`,
    workspaceRootPath: '/tmp/ws',
    workspaceId: 'ws-1',
  } as unknown as LoadedSource
}

/** A source that declares no auth at all — nothing to sign into. */
function openSource(slug: string): LoadedSource {
  return {
    config: {
      slug,
      name: `Source ${slug}`,
      type: 'mcp',
      enabled: true,
      isAuthenticated: false,
      mcp: { transport: 'http', url: `https://example.test/${slug}`, authType: 'none' },
    },
    guide: null,
    folderPath: `/tmp/sources/${slug}`,
    workspaceRootPath: '/tmp/ws',
    workspaceId: 'ws-1',
  } as unknown as LoadedSource
}

const parkedEntry = (
  logicalName: string,
  kind: 'source' | 'mcp',
  unavailableReason: string,
) => ({
  summary: {
    kind,
    logicalName,
    displayName: `Display ${logicalName}`,
    ...(kind === 'source' ? { sourceType: 'mcp' } : {}),
    enabled: false,
    unavailableReason,
  },
})

describe('buildPendingAuthSummary', () => {
  test('reports dp, unauthenticated sources, parked servers and failures with true counts', () => {
    const summary = buildPendingAuthSummary({
      workspaceId: 'ws-1',
      snapshotEntries: [
        parkedEntry('parked-connector', 'source', 'credential-missing'),
        parkedEntry('plugin-native', 'mcp', 'credential-expired'),
        // Not credential-related: must NOT appear.
        parkedEntry('disabled-source', 'source', 'session-disabled'),
      ],
      materializedSources: [
        oauthSource('jira'),
        oauthSource('wiki', { authenticated: true }),
        oauthSource('tracker', { enabled: false }),
      ],
      externalAuthRequirements: [
        {
          provider: 'dp',
          wireNames: ['dp-b', 'dp-a'],
          pluginInstanceIds: ['plugin-1'],
          state: 'needs-login',
        },
      ],
      failedSlugs: ['broken-server', 'jira'],
    })

    expect(summary.dp).toEqual({ state: 'needs-login', serverNames: ['dp-a', 'dp-b'] })
    expect(summary.sources).toEqual([
      { workspaceId: 'ws-1', sourceSlug: 'jira', name: 'Source jira', reason: 'needs-auth', canSignIn: true },
      { workspaceId: 'ws-1', sourceSlug: 'parked-connector', name: 'Display parked-connector', reason: 'credential-missing', canSignIn: true },
      { workspaceId: 'ws-1', sourceSlug: 'plugin-native', name: 'Display plugin-native', reason: 'credential-expired', canSignIn: false },
    ])
    // A slug already listed as pending-auth is not double-reported as broken.
    expect(summary.failedServers).toEqual(['broken-server'])
    expect(isPendingAuthEmpty(summary)).toBe(false)
  })

  test('positive control: dp ready and every source authed yields an EMPTY summary', () => {
    const summary = buildPendingAuthSummary({
      workspaceId: 'ws-1',
      snapshotEntries: [parkedEntry('disabled-source', 'source', 'session-disabled')],
      materializedSources: [oauthSource('wiki', { authenticated: true })],
      externalAuthRequirements: [
        { provider: 'dp', wireNames: ['dp-a'], pluginInstanceIds: ['p'], state: 'ready' },
      ],
      failedSlugs: [],
    })

    expect(summary).toEqual({ sources: [], failedServers: [] })
    expect(isPendingAuthEmpty(summary)).toBe(true)
  })

  /**
   * The two-tier dp gate (owner decision 2026-08-06): a BUILT-IN dp server
   * carries no credential of its own, so it is withheld only on a positive
   * `needs-login` verdict — `unavailable` (transient probe failure, the
   * non-Pi preflight's hardcoded value) must leave it connected. Before this
   * fix the row rendered "N servers await dp sign-in" for a builtin-only
   * `unavailable` requirement even though those servers stayed connected —
   * an untruthful row. `builtinWireNames` on the requirement is what lets
   * this summary tell the two cases apart.
   */
  test('builtin-only dp requirement in state unavailable: no dp row (builtins stay connected)', () => {
    const summary = buildPendingAuthSummary({
      workspaceId: 'ws-1',
      snapshotEntries: [],
      materializedSources: [],
      externalAuthRequirements: [
        {
          provider: 'dp',
          wireNames: ['dpGitlab'],
          pluginInstanceIds: [],
          state: 'unavailable',
          builtinWireNames: ['dpGitlab'],
        },
      ],
      failedSlugs: [],
    })

    expect(summary.dp).toBeUndefined()
    expect(isPendingAuthEmpty(summary)).toBe(true)
  })

  test('builtin-only dp requirement in state needs-login: row names the withheld builtins', () => {
    const summary = buildPendingAuthSummary({
      workspaceId: 'ws-1',
      snapshotEntries: [],
      materializedSources: [],
      externalAuthRequirements: [
        {
          provider: 'dp',
          wireNames: ['dpGitlab', 'dpJira'],
          pluginInstanceIds: [],
          state: 'needs-login',
          builtinWireNames: ['dpGitlab', 'dpJira'],
        },
      ],
      failedSlugs: [],
    })

    expect(summary.dp).toEqual({ state: 'needs-login', serverNames: ['dpGitlab', 'dpJira'] })
  })

  /**
   * H1. The defect: a source that IS authenticated — `isAuthenticated: true`,
   * so feed 1 sees nothing — whose server now answers 401/403 because the
   * provider revoked the token. Before H1 the only trace was `failedSlugs`,
   * i.e. "Failed to connect: jira", with no sign-in offered anywhere.
   */
  test('a 401/403 from an AUTHENTICATED source is offered sign-in, not reported broken', () => {
    const summary = buildPendingAuthSummary({
      workspaceId: 'ws-1',
      snapshotEntries: [],
      materializedSources: [oauthSource('jira', { authenticated: true })],
      externalAuthRequirements: [],
      failedSlugs: ['jira'],
      authFailedSlugs: ['jira'],
    })

    expect(summary.sources).toEqual([{
      workspaceId: 'ws-1',
      sourceSlug: 'jira',
      name: 'Source jira',
      reason: 'credential-expired',
      canSignIn: true,
    }])
    // Promoted, not duplicated: it is no longer merely a broken server.
    expect(summary.failedServers).toEqual([])
  })

  /**
   * The mirror-image defect. A 500, a timeout or a refused socket is a broken
   * server; only the pool's 401/403 verdict rides `authFailedSlugs`, and
   * without it nothing is promoted.
   */
  test('a failure that is NOT a 401/403 stays a broken server', () => {
    const summary = buildPendingAuthSummary({
      workspaceId: 'ws-1',
      snapshotEntries: [],
      materializedSources: [oauthSource('jira', { authenticated: true })],
      externalAuthRequirements: [],
      failedSlugs: ['jira'],
      authFailedSlugs: [],
    })

    expect(summary.sources).toEqual([])
    expect(summary.failedServers).toEqual(['jira'])
  })

  /**
   * `authType: 'none'` + 401 is a MISCONFIGURATION: there is no credential slot
   * to write and `performOAuth` would have nothing to do, so the honest row is
   * still "broken server" rather than a button that cannot help.
   */
  test('a 401 from a source that declares no auth stays a broken server', () => {
    const summary = buildPendingAuthSummary({
      workspaceId: 'ws-1',
      snapshotEntries: [],
      materializedSources: [openSource('open-mcp')],
      externalAuthRequirements: [],
      failedSlugs: ['open-mcp'],
      authFailedSlugs: ['open-mcp'],
    })

    expect(summary.sources).toEqual([])
    expect(summary.failedServers).toEqual(['open-mcp'])
  })

  /**
   * A plugin/builtin wire name has no materialized source, so the one-click
   * flow has no `pluginServer` target — the row still tells the truth about
   * WHY the server is unusable, without a button that cannot complete.
   */
  test('a 401 from a server with no materialized source is informational', () => {
    const summary = buildPendingAuthSummary({
      workspaceId: 'ws-1',
      snapshotEntries: [],
      materializedSources: [],
      externalAuthRequirements: [],
      failedSlugs: [],
      authFailedSlugs: ['figma'],
    })

    expect(summary.sources).toEqual([{
      workspaceId: 'ws-1',
      sourceSlug: 'figma',
      name: 'figma',
      reason: 'credential-expired',
      canSignIn: false,
    }])
  })

  /**
   * A connector-materialized source's OAuth lives on the capability path —
   * `oauth:start` throws `plugin-mcp-server-capability-path-required` for a
   * bare slug — so its row must carry the plugin target or its button breaks.
   */
  test('a 401 from a CONNECTOR source signs in through its plugin target', () => {
    const source = oauthSource('figma', { authenticated: true })
    ;(source.config as { connectorOrigin?: unknown }).connectorOrigin = {
      pluginKey: 'registry.figma',
      connectorId: 'figma',
      serverName: 'figma-mcp',
    }

    const summary = buildPendingAuthSummary({
      workspaceId: 'ws-1',
      snapshotEntries: [],
      materializedSources: [source],
      externalAuthRequirements: [],
      failedSlugs: [],
      authFailedSlugs: ['figma'],
    })

    expect(summary.sources).toEqual([{
      workspaceId: 'ws-1',
      sourceSlug: 'figma',
      name: 'Source figma',
      reason: 'credential-expired',
      canSignIn: true,
      pluginServer: { pluginKey: 'registry.figma', serverName: 'figma-mcp' },
    }])
  })

  /**
   * Recoverability, at this layer: the pool clears its verdict on the first
   * successful connect or call after the re-auth, so the row disappears.
   */
  test('positive control: once the pool clears the 401 the summary is empty again', () => {
    const summary = buildPendingAuthSummary({
      workspaceId: 'ws-1',
      snapshotEntries: [],
      materializedSources: [oauthSource('jira', { authenticated: true })],
      externalAuthRequirements: [],
      failedSlugs: [],
      authFailedSlugs: [],
    })

    expect(isPendingAuthEmpty(summary)).toBe(true)
  })

  test('mixed plugin + builtin dp requirement in state unavailable: row names ONLY the plugin servers', () => {
    const summary = buildPendingAuthSummary({
      workspaceId: 'ws-1',
      snapshotEntries: [],
      materializedSources: [],
      externalAuthRequirements: [
        {
          provider: 'dp',
          wireNames: ['dpGitlab', 'dpJira'],
          pluginInstanceIds: ['plugin://default'],
          state: 'unavailable',
          // dpJira is the plugin-bound server; dpGitlab is the builtin.
          builtinWireNames: ['dpGitlab'],
        },
      ],
      failedSlugs: [],
    })

    expect(summary.dp).toEqual({ state: 'unavailable', serverNames: ['dpJira'] })
  })

  /**
   * T8: an outdated dp binary lacks `dp ai mcp`, so every builtin dp server
   * fails connect regardless of login — the banner must name the real cause
   * instead of listing opaque server names.
   */
  test('dpOutdated rides through when set and failed servers exist', () => {
    const summary = buildPendingAuthSummary({
      workspaceId: 'w',
      snapshotEntries: [],
      materializedSources: [],
      externalAuthRequirements: [],
      failedSlugs: ['dpJira'],
      dpOutdated: true,
    })

    expect(summary.dpOutdated).toBe(true)
    expect(summary.failedServers).toEqual(['dpJira'])
  })

  test('dpOutdated stays absent by default', () => {
    const summary = buildPendingAuthSummary({
      workspaceId: 'w',
      snapshotEntries: [],
      materializedSources: [],
      externalAuthRequirements: [],
      failedSlugs: [],
    })

    expect(summary.dpOutdated).toBeUndefined()
  })
})

/**
 * P6.256 — the ADVANCE warning: the only row in this summary that fires while
 * the session still works.
 *
 * Denominator C13, `partial` on all three runtimes: the expiry instant has been
 * ours since `auth/oauth.ts` started writing `expiresAt`, and nothing read it
 * ahead of time — the earliest a user could learn a credential was about to die
 * was the turn it died on.
 */
describe('P6.256 — a credential about to expire', () => {
  const NOW = 1_700_000_000_000
  const DAY = 24 * 60 * 60 * 1000
  const base = {
    workspaceId: 'ws-1',
    snapshotEntries: [],
    materializedSources: [],
    externalAuthRequirements: [],
    failedSlugs: [],
    now: NOW,
  }

  test('warns inside the threshold, naming the connection and the days left', () => {
    const summary = buildPendingAuthSummary({
      ...base,
      credentialExpiries: [
        { sourceSlug: 'jira', name: 'Jira', expiresAt: NOW + 3 * DAY },
        { sourceSlug: 'gh', name: 'GitHub', expiresAt: NOW + 1 * DAY },
      ],
    })
    // Oldest deadline first, so the one that matters most is read first.
    expect(summary.expiringSoon).toEqual([
      { sourceSlug: 'gh', name: 'GitHub', daysLeft: 1 },
      { sourceSlug: 'jira', name: 'Jira', daysLeft: 3 },
    ])
    // And it alone raises the notice — the whole point of the row.
    expect(isPendingAuthEmpty(summary)).toBe(false)
  })

  test('says nothing about a credential that renews itself, or one past the threshold', () => {
    // The exclusion that keeps this notice worth reading: an hourly OAuth token
    // renews without the user, and warning about it every hour would train
    // everyone to skip the notice long before a real deadline arrives.
    const summary = buildPendingAuthSummary({
      ...base,
      credentialExpiries: [
        { sourceSlug: 'renews', name: 'Renews', expiresAt: NOW + 1 * DAY, renewable: true },
        { sourceSlug: 'far', name: 'Far', expiresAt: NOW + (CREDENTIAL_EXPIRY_NOTICE_DAYS + 1) * DAY },
        // Already gone is `credential-expired`'s subject, with a sign-in
        // button; saying it twice in two voices is worse than saying it once.
        { sourceSlug: 'gone', name: 'Gone', expiresAt: NOW - DAY },
      ],
    })
    expect(summary.expiringSoon).toBeUndefined()
    expect(isPendingAuthEmpty(summary)).toBe(true)
  })

  test('rounds up rather than down, and never says a working credential has zero days', () => {
    const summary = buildPendingAuthSummary({
      ...base,
      credentialExpiries: [{ sourceSlug: 'soon', name: 'Soon', expiresAt: NOW + 4 * 60 * 60 * 1000 }],
    })
    expect(summary.expiringSoon?.[0]?.daysLeft).toBe(1)
  })

  test('yields to a source that already has a row — one source, one sentence', () => {
    const summary = buildPendingAuthSummary({
      ...base,
      materializedSources: [oauthSource('needy')],
      credentialExpiries: [{ sourceSlug: 'needy', name: 'Needy', expiresAt: NOW + DAY }],
    })
    expect(summary.sources.map(row => row.sourceSlug)).toEqual(['needy'])
    expect(summary.expiringSoon).toBeUndefined()
  })
})
