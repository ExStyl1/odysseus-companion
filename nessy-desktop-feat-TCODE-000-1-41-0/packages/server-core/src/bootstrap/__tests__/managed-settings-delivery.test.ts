/**
 * Server-delivered managed settings in the HEADLESS hosts.
 *
 * `server-managed-settings.md` describes one lifecycle, and it used to run only
 * in the desktop shell. Because delivery is off by default in the library,
 * `nessy-server` — and the CLI, which spawns exactly this server as a child
 * process (`apps/cli/src/server-spawner.ts`) — never fetched, never cached and
 * never applied a delivered `env` block, so `forceRemoteSettingsRefresh` could
 * not have been satisfied there even if the gate had been wired.
 */
import { describe, expect, it, afterEach } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  clearManagedDeliveryCache,
  getManagedDeliveryCachePath,
  isManagedDeliveryEnabled,
  isManagedDeliveryPolling,
  refreshManagedDelivery,
  resetManagedDeliverySession,
  setManagedDeliveryEnabled,
  writeManagedDeliveryCache,
} from '@nessy-agent/shared/config/managed-delivery'
import type { StorageHostLease, VerifiedStorageLayoutV2 } from '@nessy-agent/shared/workspaces'
import type { PlatformServices } from '../../runtime/platform'
import type { WsRpcServer } from '../../transport/server'
import {
  assertManagedVersionAllowed,
  bootstrapServer,
  ManagedSettingsStartupError,
  startManagedSettingsDelivery,
  type HeadlessStorageBootstrap,
} from '../headless-start'

const TOKEN = '0123456789abcdef0123456789abcdef'
const LAYOUT: VerifiedStorageLayoutV2 = { storageLayoutVersion: 2, verificationId: 'verified' }

function platform(warnings: string[]): PlatformServices {
  return {
    appRootPath: '/test',
    resourcesPath: '/test',
    isPackaged: false,
    appVersion: 'test',
    imageProcessor: {
      getMetadata: async () => null,
      process: async () => Buffer.alloc(0),
    },
    logger: {
      info: () => {},
      warn: (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) },
      error: () => {},
      debug: () => {},
    },
    isDebugMode: false,
  } as unknown as PlatformServices
}

function rpcServer(): WsRpcServer {
  return {
    protocol: 'ws',
    port: 9123,
    listen: async () => {},
    close: () => {},
    push: (channel: string) => {
      if (channel === 'server:shuttingDown') throw new Error('skip drain')
    },
    getConnectedClientCount: () => 0,
  } as unknown as WsRpcServer
}

function options(warnings: string[]) {
  const hostLease: StorageHostLease = { assertHeld: () => {} }
  const storageBootstrap: HeadlessStorageBootstrap = {
    acquireHostLease: () => hostLease,
    releaseHostLease: () => {},
    ensureStorageLayout: async () => ({ status: 'ready', layout: LAYOUT }),
  }
  return {
    serverToken: TOKEN,
    platformFactory: () => platform(warnings),
    storageBootstrap,
    bundledAssetsRoot: '/test',
    applyPlatformToSubsystems: () => {},
    configArtifactsInitializer: () => {},
    globalConfigInitializer: () => {},
    initModelRefreshService: () => ({ startAll: () => {}, stopAll: () => {} }),
    createSessionManager: async () => ({ id: 'session-manager' }),
    rpcServerFactory: () => rpcServer(),
    bindRpcServer: () => {},
    createHandlerDeps: () => ({}),
    registerAllRpcHandlers: () => {},
    setSessionEventSink: () => {},
    initializeSessionManager: async () => {},
    cleanupSessionManager: async () => {},
  }
}

afterEach(() => {
  resetManagedDeliverySession()
  clearManagedDeliveryCache()
})

describe('the headless host runs the delivery lifecycle', () => {
  it('opts in, seeds from the cache, arms the hourly poll, and tears it down', async () => {
    // The PRECONDITION is established rather than assumed, and the reason is
    // worth reading before restoring the old `expect(...).toBe(false)` here.
    //
    // "Off by default in the library so that importing auth/dp never makes an
    // unannounced request; a HOST says so once, at startup" is TRUE and is a
    // claim about a FRESH PROCESS. This file does not get one: the opt-in is
    // module-scope, `bootstrapServer` is what turns it on, and three sibling
    // suites in this very directory bootstrap a server too
    // (`shutdown-reentry`, `storage-readiness-order`, `webui-upgrade-authority`)
    // — so in the whole-repo `bun test` the flag arrives here already true. This
    // case passed ALONE and failed in that run on CI jobs 630520568 and
    // 630550597, asserting a process default no suite can guarantee.
    //
    // Nothing is weakened: the library default is pinned where it can actually
    // be measured, in `packages/shared/src/config/__tests__/managed-delivery.test.ts`,
    // and what THIS case is named for — bootstrap opts in, arms the poll, and
    // tear-down stops it — still fails if any of those three stop being true.
    setManagedDeliveryEnabled(false)
    expect(isManagedDeliveryEnabled()).toBe(false)

    const instance = await bootstrapServer(options([]))

    expect(isManagedDeliveryEnabled()).toBe(true)
    // :147 — "polls for updates hourly during active sessions".
    expect(isManagedDeliveryPolling()).toBe(true)

    await instance.stop()
    // A background refresh must never be the reason the server refuses to exit.
    expect(isManagedDeliveryPolling()).toBe(false)
  })

  /**
   * P3.64 — REFUTED, and pinned so it cannot become true again.
   *
   * The row read: "the headless host applies no managed env at all … an
   * administrator's environment policy is enforced or not depending on which
   * binary the user runs, with nothing saying so." Measured 2026-09-03 against
   * HEAD, that is false in both halves, and it was already false when the row
   * was written on 2026-08-28: `a13bc633b` (2026-07-29) moved the whole delivery
   * lifecycle into this host, and P3.254's note on `agent/claude-managed-settings.ts`
   * (`env`) had already recorded `startManagedDeliveryEnvApplication` running at
   * boot in BOTH hosts by name and line.
   *
   * The owner's decision (2026-09-02, §C1) is *one administrator environment
   * policy, both binaries*, so what was owed was evidence rather than code. The
   * suite above proved the lifecycle STARTS; nothing proved a delivered `env`
   * block reaches an environment, which is the only thing an administrator
   * actually cares about — so a regression that broke the application while
   * leaving the poll armed would have gone unseen.
   *
   * `managed-settings.md` was read for the "may legitimately differ for a server
   * deployment" arm the row asked about and says nothing of the kind: it
   * describes one managed tier per machine with no host distinction, and
   * `server-managed-settings.md#fetch-and-caching-behavior` describes one `env`
   * block with one release rule. The page does not carve out a headless host, so
   * neither do we.
   *
   * The variable is chosen for what it is NOT: `OTEL_EXPORTER_OTLP_PROTOCOL` is
   * `immediate` (not withheld before the fetch confirms) and is one of the three
   * names still in `MANAGED_ENV_SAFE_ALLOWLIST` after P3.210, so the assertion
   * measures the applier rather than the withhold rule or the approval gate.
   */
  it('P3.64: a delivered env block reaches this host\'s process environment', async () => {
    const NAME = 'OTEL_EXPORTER_OTLP_PROTOCOL'
    const before = process.env[NAME]
    // `delete` first — AGENTS.md's Bun env-slot rule; a bare assign can leave a
    // name readable by property and invisible to `{...process.env}`.
    delete process.env[NAME]
    try {
      writeManagedDeliveryCache({
        schemaVersion: 1,
        fetchedAt: Date.now(),
        payload: { schemaVersion: 1, env: { [NAME]: 'http/protobuf' } },
      })
      // Nothing has applied it yet: the cache on disk is not an environment.
      expect(process.env[NAME]).toBeUndefined()

      const instance = await bootstrapServer(options([]))
      // The whole point of the row. One applier, and it ran in the server.
      expect(process.env[NAME]).toBe('http/protobuf')
      await instance.stop()
    } finally {
      delete process.env[NAME]
      if (before !== undefined) process.env[NAME] = before
    }
  })
})

/**
 * P3.64 clause two, and P3.53 — ORDERING, asserted against the source.
 *
 * Both facts below are invisible at runtime: every call succeeds in either
 * order, and only what an administrator's policy governs differs. That is the
 * shape `managed-update-registration.test.ts` established for the desktop's
 * twin ordering, and it is used here for the same reason.
 *
 * 1. `bootstrapConfigArtifacts` registers the enforced-policy provider — which
 *    is also where `registerComposedManagedEnvProvider` is folded in, so it is
 *    the FILE tier's only route into the applier — before the delivery
 *    lifecycle applies anything. Registered after, the file tier would be
 *    parsed, validated and never applied, which is precisely the defect P3.63
 *    measured and fixed.
 *
 * 2. The block is applied before `createSessionManager`, and therefore before
 *    `createStorageRuntime` builds the OTLP exporter from `process.env`. This is
 *    P3.53's real question, and the answer moves that row's premise: `immediate`
 *    is not a promise about mid-session delivery, it is
 *    `server-managed-settings.md#fetch-and-caching-behavior`'s remainder rule —
 *    "Every other key in the cached `env` block, such as telemetry and
 *    OpenTelemetry configuration, applies at startup as before" — and *at
 *    startup* is exactly what this ordering keeps. The residue P3.53 named is
 *    real but narrower than the row states, and is recorded on
 *    `createPiOtlpTelemetry`'s call site rather than left implied.
 */
/**
 * P3.289 — the desktop ran this lifecycle TWICE, and the first pass had no
 * modal.
 *
 * `bootstrapServer` installs a `non-interactive` gate and then runs the
 * fail-closed refresh; the electron shell installed its own `interactive` gate
 * several hundred lines LATER. So a payload the desktop resolved in that
 * window applied with no dialog, and
 * `server-managed-settings.md#security-approval-dialogs`'s "If a user rejects
 * the settings, Claude Code exits" branch could not fire for it.
 *
 * The fix is a seam, not a re-order: a host that owns a gate hands it in, and
 * the built-in `non-interactive` one stays the default for a host that has
 * nobody to ask. Both arms are pinned here because the DEFAULT is the half a
 * seam quietly breaks.
 */
describe('P3.289: the host owns the approval gate when it has one', () => {
  const serve = (() => Promise.resolve(
    new Response(JSON.stringify({ schemaVersion: 1, env: { FOO: 'bar' } }), { status: 200 }),
  )) as unknown as typeof fetch

  it('uses the gate the host supplied', async () => {
    const seen: string[] = []
    const stop = await startManagedSettingsDelivery(platform([]), {
      jwt: () => null,
      managedFilePolicy: () => ({ schemaVersion: 1 } as never),
      approval: async () => {
        seen.push('host')
        return { apply: false, persist: false }
      },
    })
    try {
      await refreshManagedDelivery({ jwt: 'j', force: true, now: 1, fetchImpl: serve })
      expect(seen).toEqual(['host'])
    } finally {
      stop()
    }
  })

  it('falls back to the non-interactive resolution when the host supplies none', async () => {
    const stop = await startManagedSettingsDelivery(platform([]), {
      jwt: () => null,
      managedFilePolicy: () => ({ schemaVersion: 1 } as never),
    })
    try {
      // A gate IS installed — a host that registers none applies payloads
      // unprompted, and the whole point of the built-in one is that a headless
      // embedder still passes through the classification. `#approval-memory`:
      // a non-interactive run applies for that run only and persists nothing,
      // so the observable difference is `persist`.
      const state = await refreshManagedDelivery({ jwt: 'j', force: true, now: 1, fetchImpl: serve })
      expect(state.confirmed).toBe(true)
    } finally {
      stop()
    }
  })
})

describe('P3.53/P3.64: the managed env block is applied before anything reads it', () => {
  const source = readFileSync(new URL('../headless-start.ts', import.meta.url), 'utf8')

  function position(needle: string): number {
    const index = source.indexOf(needle)
    expect(index, `missing source anchor: ${needle}`).toBeGreaterThanOrEqual(0)
    return index
  }

  it('registers the composed-policy provider before the delivery lifecycle applies env', () => {
    // Two hops, because a raw text offset would compare the two FUNCTIONS'
    // positions in the file rather than their call order — the first draft of
    // this assertion did exactly that and failed against a correct ordering.
    // (a) the default initializer is where the registration lives…
    const body = source.slice(
      position('function bootstrapConfigArtifacts'),
      position('function ensureGlobalConfigExists'),
    )
    expect(body).toContain('registerEnforcedManagedPolicyProvider()')
    // …(b) and `bootstrapServer` runs it before it starts delivery.
    // The anchor stops at the open paren: P3.289 gave the call an argument and
    // the formatter broke it across lines, which a whole-call pin cannot
    // survive. A single-line pin on multi-line code is this tree's most
    // frequently re-measured trap.
    expect(position('initializeConfigArtifacts(platform)'))
      .toBeLessThan(position('stopManagedSettingsDelivery = await startManagedSettingsDelivery('))
  })

  it('applies the block before the session manager, and so before the OTLP exporter', () => {
    expect(position('stopManagedSettingsDelivery = await startManagedSettingsDelivery('))
      .toBeLessThan(position('await options.createSessionManager(storageLayout)'))
  })
})

// `settings-reference.md#requiredminimumversion` and `#requiredmaximumversion`
// — "`claude update`, `claude install`, and `claude doctor` keep working below
// the floor so users can recover." / "… keep working above the ceiling so users
// can recover."
describe('the admin version gate (requiredMinimumVersion / requiredMaximumVersion)', () => {
  const policy = (over: Record<string, unknown>) => ({
    schemaVersion: 1 as const,
    disabledPermissionModes: Object.freeze([]),
    ...over,
  })

  it('refuses a build below the floor and above the ceiling', () => {
    expect(() => assertManagedVersionAllowed(
      policy({ requiredMinimumVersion: '2.0.0' }), '1.9.9',
    )).toThrow(ManagedSettingsStartupError)
    expect(() => assertManagedVersionAllowed(
      policy({ requiredMaximumVersion: '1.9.0' }), '2.0.0',
    )).toThrow(ManagedSettingsStartupError)
  })

  it('allows an in-range build, an absent bound, and an unknown running version', () => {
    // The last one is the fail-open rule of
    // `managed-settings.md#keys-that-fail-closed` — "`requiredMinimumVersion`
    // and `requiredMaximumVersion` fail open by design: an invalid value is
    // dropped rather than enforced." Refusing because we could not read our own
    // version string would be a self-inflicted outage.
    expect(() => assertManagedVersionAllowed(
      policy({ requiredMinimumVersion: '1.0.0', requiredMaximumVersion: '2.0.0' }), '1.5.0',
    )).not.toThrow()
    expect(() => assertManagedVersionAllowed(policy({}), '1.5.0')).not.toThrow()
    expect(() => assertManagedVersionAllowed(
      policy({ requiredMinimumVersion: '99.0.0' }), undefined,
    )).not.toThrow()
  })
})

describe('the fail-closed gate now runs in the headless host (#enforce-fail-closed-startup)', () => {
  // Driven through the seams rather than through `bootstrapServer`, so the
  // suite never reads the developer's real gateway credentials and never makes
  // an outbound request.
  const REQUIRED = Object.freeze({
    schemaVersion: 1 as const,
    disabledPermissionModes: Object.freeze([]),
    forceRemoteSettingsRefresh: true,
  })

  it('does not exit when there are no credentials — it awaits sign-in', async () => {
    const warnings: string[] = []
    const stop = await startManagedSettingsDelivery(platform(warnings), {
      jwt: () => null,
      managedFilePolicy: () => REQUIRED,
      cachePath: getManagedDeliveryCachePath(),
    })
    // The same section's exemption, in our shape: "The `claude auth` subcommands
    // such as `claude auth login` are exempt from this check and from the gateway
    // startup exit". This host has no separate `auth` binary to
    // exempt, so exiting on absent credentials is what would make an expired
    // credential unrecoverable.
    expect(warnings.some(line => line.includes('awaiting gateway sign-in'))).toBe(true)
    stop()
  })

  it('refuses to start when the fetch was made and failed', async () => {
    let error: unknown
    try {
      await startManagedSettingsDelivery(platform([]), {
        jwt: () => 'a-token',
        managedFilePolicy: () => REQUIRED,
        refresh: () => Promise.reject(new Error('managed settings request failed')),
        cachePath: getManagedDeliveryCachePath(),
      })
    } catch (caught) {
      error = caught
    }
    // `server-managed-settings.md#enforce-fail-closed-startup` — "If the fetch
    // fails, the CLI exits rather than proceeding without the policy." Thrown
    // out of bootstrap, which is how this host exits non-zero.
    expect(error).toBeInstanceOf(ManagedSettingsStartupError)
    expect((error as ManagedSettingsStartupError).message).toContain('Managed settings could not be refreshed')
    // The timers it armed are torn down before the throw, so a refused startup
    // leaves no interval behind.
    expect(isManagedDeliveryPolling()).toBe(false)
  })

  it('is satisfied by a fresh fetch and starts normally', async () => {
    const stop = await startManagedSettingsDelivery(platform([]), {
      jwt: () => 'a-token',
      managedFilePolicy: () => REQUIRED,
      refresh: async () => ({
        policy: REQUIRED,
        source: 'server' as const,
        confirmed: true,
        drops: [],
      }),
      cachePath: getManagedDeliveryCachePath(),
    })
    expect(isManagedDeliveryPolling()).toBe(true)
    stop()
  })
})
