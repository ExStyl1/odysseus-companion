import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyDeliveredDocument,
  clearManagedDeliveryCache,
  fetchManagedSettings,
  getManagedDeliveryCachePath,
  getManagedDeliveryState,
  initializeManagedDeliveryFromCache,
  loadCachedManagedDelivery,
  ManagedDeliveryFetchError,
  MANAGED_DELIVERY_CACHE_FILENAME,
  MANAGED_DELIVERY_POLL_INTERVAL_MS,
  NESSY_MANAGED_SETTINGS_URL,
  onNessyGatewayAuthenticated,
  readManagedDeliveryCache,
  refreshManagedDelivery,
  resetManagedDeliverySession,
  salvageDeliveredPayload,
  setManagedDeliveryEnabled,
  setManagedDeliveryReporter,
  startManagedDeliveryPolling,
  isManagedDeliveryPolling,
  isManagedDeliveryEnabled,
  writeManagedDeliveryCache,
} from '../managed-delivery.ts'

let dir: string
let cachePath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nessy-managed-delivery-'))
  cachePath = join(dir, MANAGED_DELIVERY_CACHE_FILENAME)
  resetManagedDeliverySession()
})

afterEach(() => {
  resetManagedDeliverySession()
  // The OPT-IN is module-scope and `resetManagedDeliverySession` does not clear
  // it, so four cases below left it ON for every later file in the same `bun
  // test` process. `server-core`'s `managed-settings-delivery.test.ts` opens by
  // asserting the library default is OFF — "importing auth/dp never makes an
  // unannounced request" — and that case passed ALONE and failed in the
  // whole-repo run on CI job 630520568. Restored HERE, at the suite that
  // mutates it, so the victim keeps a real assertion instead of resetting a
  // precondition it is supposed to be measuring.
  setManagedDeliveryEnabled(false)
  rmSync(dir, { recursive: true, force: true })
})

const VALID = {
  schemaVersion: 1,
  deniedMcpServers: ['blocked'],
  cleanupPeriodDays: 30,
}

describe('the cache file', () => {
  test('lands at mode 0600 and round-trips', () => {
    writeManagedDeliveryCache(
      { schemaVersion: 1, fetchedAt: 1234, payload: { schemaVersion: 1 } },
      cachePath,
    )
    expect(statSync(cachePath).mode & 0o777).toBe(0o600)
    expect(readManagedDeliveryCache(cachePath)).toMatchObject({ fetchedAt: 1234 })
  })

  test('lives under the Nessy config dir, never beside the dp credentials', () => {
    const path = getManagedDeliveryCachePath()
    expect(path.endsWith(MANAGED_DELIVERY_CACHE_FILENAME)).toBe(true)
    expect(path).not.toContain('dp_auth_creds')
    expect(path).not.toContain(`${'.nessy'}/`)
  })

  test('a corrupt or foreign-version file reads as no cache', () => {
    writeManagedDeliveryCache({ schemaVersion: 1, fetchedAt: 1, payload: { schemaVersion: 1 } }, cachePath)
    expect(readManagedDeliveryCache(cachePath)).not.toBeNull()
    Bun.write(cachePath, '{not json')
    expect(readManagedDeliveryCache(cachePath)).toBeNull()
    Bun.write(cachePath, JSON.stringify({ schemaVersion: 99, fetchedAt: 1, payload: {} }))
    expect(readManagedDeliveryCache(cachePath)).toBeNull()
    expect(readManagedDeliveryCache(join(dir, 'absent.json'))).toBeNull()
  })
})

describe('salvage (:179, :181)', () => {
  test('a payload with one invalid entry stores the salvaged form only', () => {
    const state = applyDeliveredDocument({
      document: { ...VALID, cleanupPeriodDays: 'thirty' },
      cachePath,
      now: 7,
    })
    expect(state.source).toBe('server')
    expect(state.policy.deniedMcpServers).toEqual([{ serverName: 'blocked' }])
    expect(state.policy.cleanupPeriodDays).toBeUndefined()
    // `disabledPermissionModes` is mandatory in this schema, so a document that
    // omits it always records a drop too — R25a behaviour, pinned here so the
    // salvage classification is never re-based on the drop COUNT.
    expect(state.drops.map(drop => drop.field)).toContain('cleanupPeriodDays')

    // The raw invalid payload never reaches disk (`:179`).
    const onDisk = readFileSync(cachePath, 'utf8')
    expect(onDisk).not.toContain('thirty')
    expect(readManagedDeliveryCache(cachePath)!.payload).toEqual({
      schemaVersion: 1,
      disabledPermissionModes: [],
      // The cache stores the PARSED policy, so the wire's bare string is
      // written back in the documented entry form — which re-parses to itself.
      deniedMcpServers: [{ serverName: 'blocked' }],
    })
  })

  test('nothing salvageable keeps the last-accepted cache and records a fatal error', () => {
    applyDeliveredDocument({ document: VALID, cachePath, now: 1 })
    const before = readFileSync(cachePath, 'utf8')

    // REWRITTEN. The old fixture was `{ schemaVersion: 4, deniedMcpServers:
    // ['x'] }`, which only counted as unsalvageable because a wrong stamp used
    // to discard the whole document. It no longer does — `managed-settings.md`
    // `#invalid-entries-in-managed-settings` drops the offending ENTRY and keeps
    // enforcing the rest — so an unsalvageable payload now has to be one where
    // every DELIVERED SETTING fails, which is what
    // `server-managed-settings.md#invalid-entries-in-delivered-settings` is
    // actually about: "When no field in the payload can be salvaged and the
    // payload isn't only those retention keys, Claude Code rejects the payload,
    // keeps the last-accepted cached settings".
    const state = applyDeliveredDocument({
      document: { schemaVersion: 1, deniedMcpServers: 42, cleanupPeriodDays: 'thirty' },
      cachePath,
      now: 2,
    })

    expect(state.fatalError).toBeDefined()
    expect(state.policy.deniedMcpServers).toEqual([{ serverName: 'blocked' }])
    expect(state.confirmed).toBe(true)
    // Not a silent wipe: the file is byte-identical.
    expect(readFileSync(cachePath, 'utf8')).toBe(before)
  })

  /**
   * `:180` requires a fatal error to be RECORDED. Until U-E it was recorded in
   * a field with no reader outside this file, which is not a record.
   */
  test('the fatal error reaches a reporter once, without repeating on the next poll', async () => {
    const said: string[] = []
    setManagedDeliveryReporter(message => { said.push(message) })
    const unsalvageable = { schemaVersion: 1, deniedMcpServers: 42, cleanupPeriodDays: 'thirty' }
    const serve = (() => Promise.resolve(new Response(JSON.stringify(unsalvageable), { status: 200 }))) as unknown as typeof fetch

    const state = await refreshManagedDelivery({ jwt: 'j', cachePath, now: 1, force: true, fetchImpl: serve })
    expect(state.fatalError).toBeDefined()
    expect(said).toHaveLength(1)
    expect(said[0]).toContain('[managed-settings]')
    expect(said[0]).toContain('keeping the last accepted settings')

    // The hourly poll must not say it again every hour.
    await refreshManagedDelivery({ jwt: 'j', cachePath, now: 2, force: true, fetchImpl: serve })
    expect(said).toHaveLength(1)
  })

  test('a held-back payload says why, and names no field or value', () => {
    // `:218` — not applied, last approved kept. Without a reader the only
    // symptom is a policy that quietly stays old.
    const said: string[] = []
    setManagedDeliveryReporter(message => { said.push(message) })
    writeManagedDeliveryCache({
      schemaVersion: 1,
      fetchedAt: 1,
      // Needs approval (a custom env var) and carries no matching approval
      // digest, so the startup read holds it back as tampered-with.
      payload: { schemaVersion: 1, env: { NESSY_SECRET_TOKEN: 'shhh' } },
    }, cachePath)

    const state = initializeManagedDeliveryFromCache(cachePath)
    expect(state.awaitingApproval).toBeDefined()
    expect(said).toHaveLength(1)
    expect(said[0]).toContain('need approval')
    expect(said[0]).toContain('env')
    // A managed `env` block routinely holds a credential: neither the variable
    // name nor its value may appear in a log line.
    expect(said[0]).not.toContain('NESSY_SECRET_TOKEN')
    expect(said[0]).not.toContain('shhh')
  })

  test('a wrong stamp beside a valid setting is DELIVERED, not fatal', () => {
    // The other half of the rewrite above: `:181`'s fatal branch must not fire
    // for a document that still carries an enforceable policy.
    const state = applyDeliveredDocument({
      document: { schemaVersion: 4, deniedMcpServers: ['x'] },
      cachePath,
      now: 3,
    })
    expect(state.fatalError).toBeUndefined()
    expect(state.source).toBe('server')
    expect(state.policy.deniedMcpServers).toEqual([{ serverName: 'x' }])
    expect(state.drops.map(drop => drop.field)).toContain('schemaVersion')
  })

  test('a re-parse of the cached salvaged payload produces no further drops', () => {
    applyDeliveredDocument({ document: { ...VALID, cleanupPeriodDays: 'thirty' }, cachePath, now: 1 })
    const cached = readManagedDeliveryCache(cachePath)!
    expect(salvageDeliveredPayload(cached.payload).drops).toEqual([])
    expect(loadCachedManagedDelivery(cachePath).policy.deniedMcpServers).toEqual([{ serverName: 'blocked' }])
  })

  test('an empty delivery supersedes the cache (:143), an absent one is not an error', () => {
    applyDeliveredDocument({ document: VALID, cachePath, now: 1 })
    expect(existsSync(cachePath)).toBe(true)
    const state = applyDeliveredDocument({ document: undefined, cachePath, now: 2 })
    expect(state.source).toBe('server')
    expect(state.confirmed).toBe(true)
    expect(existsSync(cachePath)).toBe(false)
  })

  test('persist: false applies without writing the cache (:221)', () => {
    const state = applyDeliveredDocument({ document: VALID, cachePath, now: 1, persist: false })
    expect(state.policy.deniedMcpServers).toEqual([{ serverName: 'blocked' }])
    expect(existsSync(cachePath)).toBe(false)
  })
})

describe('the cached startup read (:157)', () => {
  test('applies immediately but is NOT confirmed', () => {
    applyDeliveredDocument({ document: VALID, cachePath, now: 1 })
    resetManagedDeliverySession()
    const state = initializeManagedDeliveryFromCache(cachePath)
    expect(state.source).toBe('cache')
    expect(state.confirmed).toBe(false)
    expect(state.policy.deniedMcpServers).toEqual([{ serverName: 'blocked' }])
  })

  test('a hand-edited cache entry is stripped like any other managed source (:254)', () => {
    writeManagedDeliveryCache({
      schemaVersion: 1,
      fetchedAt: 1,
      payload: { schemaVersion: 1, deniedMcpServers: ['ok'], allowPluginHooks: 'yes' },
    }, cachePath)
    const state = loadCachedManagedDelivery(cachePath)
    expect(state.policy.deniedMcpServers).toEqual([{ serverName: 'ok' }])
    // The security switch is read at its ENFORCING pole, not at the edit.
    expect(state.policy.allowPluginHooks).toBe(false)
  })
})

describe('fetch (:201)', () => {
  function transport(handler: (request: Request) => Response): typeof fetch {
    return ((input: string | URL | Request, init?: RequestInit) =>
      Promise.resolve(handler(new Request(input as string, init)))) as unknown as typeof fetch
  }

  test('sends Cache-Control: no-cache and the gateway auth header', async () => {
    let seen: Request | undefined
    const result = await fetchManagedSettings({
      jwt: 'jwt-value',
      fetchImpl: transport(request => {
        seen = request
        return new Response(JSON.stringify(VALID), { status: 200 })
      }),
    })
    expect(seen!.headers.get('Cache-Control')).toBe('no-cache')
    expect(seen!.headers.get('Nestor-Token')).toBe('jwt-value')
    expect(seen!.url).toBe(NESSY_MANAGED_SETTINGS_URL)
    expect(result.document).toMatchObject({ schemaVersion: 1 })
  })

  test('404 and 204 mean the org delivered nothing, not a failure', async () => {
    for (const status of [404, 204]) {
      const result = await fetchManagedSettings({
        jwt: 'j',
        fetchImpl: transport(() => new Response(null, { status })),
      })
      expect(result.document).toBeUndefined()
    }
  })

  test('a transport failure never echoes the request URL', async () => {
    const credentialed = 'https://user:hunter2@proxy.example/managed'
    const error = await fetchManagedSettings({
      jwt: 'j',
      url: credentialed,
      fetchImpl: (() => Promise.reject(new Error(`connect ECONNREFUSED ${credentialed}`))) as unknown as typeof fetch,
    }).catch((err: unknown) => err)
    expect(error).toBeInstanceOf(ManagedDeliveryFetchError)
    expect((error as Error).message).not.toContain('hunter2')
    expect((error as Error).message).not.toContain('proxy.example')
  })

  test('a non-2xx status is a fetch failure', async () => {
    await expect(fetchManagedSettings({
      jwt: 'j',
      fetchImpl: transport(() => new Response('nope', { status: 500 })),
    })).rejects.toThrow(ManagedDeliveryFetchError)
  })
})

describe('the session refresh', () => {
  const ok = (body: unknown): typeof fetch =>
    (() => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))) as unknown as typeof fetch

  test('confirms the session and caches', async () => {
    const state = await refreshManagedDelivery({ jwt: 'j', cachePath, now: 5, fetchImpl: ok(VALID) })
    expect(state.confirmed).toBe(true)
    expect(readManagedDeliveryCache(cachePath)!.fetchedAt).toBe(5)
  })

  test('rate-limits to the documented hourly cadence unless forced', async () => {
    let calls = 0
    const counting = (() => {
      calls += 1
      return Promise.resolve(new Response(JSON.stringify(VALID), { status: 200 }))
    }) as unknown as typeof fetch

    await refreshManagedDelivery({ jwt: 'j', cachePath, now: 1000, fetchImpl: counting })
    await refreshManagedDelivery({ jwt: 'j', cachePath, now: 2000, fetchImpl: counting })
    expect(calls).toBe(1)

    await refreshManagedDelivery({
      jwt: 'j',
      cachePath,
      now: 1000 + MANAGED_DELIVERY_POLL_INTERVAL_MS + 1,
      fetchImpl: counting,
    })
    expect(calls).toBe(2)
  })

  test('a failed fetch leaves the cached state in place, unconfirmed (:159)', async () => {
    applyDeliveredDocument({ document: VALID, cachePath, now: 1 })
    resetManagedDeliverySession()
    initializeManagedDeliveryFromCache(cachePath)

    await expect(refreshManagedDelivery({
      jwt: 'j',
      cachePath,
      fetchImpl: (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch,
    })).rejects.toThrow(ManagedDeliveryFetchError)

    expect(readManagedDeliveryCache(cachePath)).not.toBeNull()
  })

  test('the sign-in hook is inert until a host opts in', async () => {
    let calls = 0
    const counting = (() => {
      calls += 1
      return Promise.resolve(new Response(JSON.stringify(VALID), { status: 200 }))
    }) as unknown as typeof fetch

    // Off by default: importing auth/dp must never make an unannounced request.
    expect(isManagedDeliveryEnabled()).toBe(false)
    onNessyGatewayAuthenticated('jwt')
    await Promise.resolve()
    expect(calls).toBe(0)

    // An explicit refresh still fetches — the caller asked for it by name.
    await refreshManagedDelivery({ jwt: 'j', cachePath, force: true, fetchImpl: counting })
    expect(calls).toBe(1)
  })

  test('the sign-in hook never throws when the endpoint is unreachable (:152)', () => {
    setManagedDeliveryEnabled(true)
    expect(() => onNessyGatewayAuthenticated('jwt')).not.toThrow()
  })
})

describe('clearing', () => {
  test('is idempotent', () => {
    writeManagedDeliveryCache({ schemaVersion: 1, fetchedAt: 1, payload: { schemaVersion: 1 } }, cachePath)
    clearManagedDeliveryCache(cachePath)
    clearManagedDeliveryCache(cachePath)
    expect(existsSync(cachePath)).toBe(false)
  })
})

describe('the hourly poll (:147)', () => {
  const settle = () => new Promise(resolve => setTimeout(resolve, 5))

  test('does not arm until a host opts in', () => {
    const stop = startManagedDeliveryPolling({ jwt: () => 'jwt' })
    expect(isManagedDeliveryPolling()).toBe(false)
    stop()
  })

  test('refreshes on every tick and is fail-open (:240)', async () => {
    setManagedDeliveryEnabled(true)
    const seen: string[] = []
    let fail = true
    startManagedDeliveryPolling({
      jwt: () => 'jwt-1',
      intervalMs: 5,
      refresh: async (jwt) => {
        seen.push(jwt)
        // The first tick fails. A fail-open refresh must neither throw out of
        // the timer nor stop later ticks — :240 makes the background refresh
        // fail-open on both channels.
        if (fail) { fail = false; throw new Error('offline') }
      },
    })
    expect(isManagedDeliveryPolling()).toBe(true)
    await settle()
    await settle()
    expect(seen.length).toBeGreaterThanOrEqual(2)
    expect(seen.every(jwt => jwt === 'jwt-1')).toBe(true)
  })

  test('reads the credential per tick, so a later sign-in starts polling', async () => {
    setManagedDeliveryEnabled(true)
    const seen: string[] = []
    let jwt: string | null = null
    startManagedDeliveryPolling({
      jwt: () => jwt,
      intervalMs: 5,
      refresh: async (token) => { seen.push(token) },
    })
    await settle()
    expect(seen).toEqual([])   // no credential is not a failure
    jwt = 'arrived'
    await settle()
    await settle()
    expect(seen).toContain('arrived')
  })

  test('is idempotent and stops cleanly', async () => {
    setManagedDeliveryEnabled(true)
    let calls = 0
    const refresh = async () => { calls += 1 }
    startManagedDeliveryPolling({ jwt: () => 'j', intervalMs: 5, refresh })
    const stop = startManagedDeliveryPolling({ jwt: () => 'j', intervalMs: 5, refresh })
    await settle()
    const afterOne = calls
    // One timer, not two: a host that re-runs its startup path must not double
    // the request rate.
    expect(afterOne).toBeLessThanOrEqual(2)
    stop()
    expect(isManagedDeliveryPolling()).toBe(false)
    await settle()
    await settle()
    expect(calls).toBe(afterOne)
  })

  test('the documented cadence is one hour', () => {
    expect(MANAGED_DELIVERY_POLL_INTERVAL_MS).toBe(3_600_000)
  })
})

/**
 * P6.246(c) — the failure CAUSE, recorded rather than only thrown.
 *
 * READER CORRECTED by the row itself: the state object did NOT already hold the
 * outcome. `ManagedDeliveryFetchError` propagated out of
 * `refreshManagedDelivery` and published nothing, so nothing downstream — not
 * the doctor, not an `onManagedDeliveryChange` listener — could say why the
 * organisation's settings had not arrived.
 */
describe('P6.246(c) — a failed fetch records its cause', () => {
  const failing = (() => Promise.resolve(new Response('nope', { status: 503 }))) as unknown as typeof fetch
  const ok = (body: unknown): typeof fetch =>
    (() => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))) as unknown as typeof fetch

  test('the cause lands on the published state, and the throw still happens', async () => {
    // Both halves matter: the throw is the contract (`refreshManagedDelivery`
    // does not decide what a failure MEANS — its two callers implement the
    // page's opposite fail-open and fail-closed answers), and the record is what
    // makes the failure legible without changing either answer.
    await expect(refreshManagedDelivery({
      jwt: 'j', cachePath, now: 1, force: true, fetchImpl: failing,
    })).rejects.toThrow(ManagedDeliveryFetchError)

    const state = getManagedDeliveryState()
    expect(state.fetchError?.cause).toContain('503')
    expect(state.fetchError?.at).toBe(1)
  })

  test('a later success clears it — by construction, not by remembering to', async () => {
    // The negative control. `applyDeliveredDocument` builds a fresh state
    // object, so a recovered fetch cannot leave a stale cause behind.
    await expect(refreshManagedDelivery({
      jwt: 'j', cachePath, now: 1, force: true, fetchImpl: failing,
    })).rejects.toThrow(ManagedDeliveryFetchError)
    expect(getManagedDeliveryState().fetchError).toBeDefined()

    const recovered = await refreshManagedDelivery({
      jwt: 'j', cachePath, now: 2, force: true, fetchImpl: ok(VALID),
    })
    expect(recovered.confirmed).toBe(true)
    expect(recovered.fetchError).toBeUndefined()
    expect(getManagedDeliveryState().fetchError).toBeUndefined()
  })
})
