import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseManagedPiPolicyTolerantV1 } from '../../agent/pi-harness/managed-policy.ts'
import {
  applyDeliveredDocument,
  MANAGED_DELIVERY_CACHE_FILENAME,
  resetManagedDeliverySession,
  type ManagedDeliveryStateV1,
} from '../managed-delivery.ts'
import {
  enforceForceRemoteSettingsRefresh,
  isForceRemoteSettingsRefreshRequired,
} from '../managed-refresh-gate.ts'

let dir: string
let cachePath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nessy-force-refresh-'))
  cachePath = join(dir, MANAGED_DELIVERY_CACHE_FILENAME)
  resetManagedDeliverySession()
})

afterEach(() => {
  resetManagedDeliverySession()
  rmSync(dir, { recursive: true, force: true })
})

const policy = (value: unknown) =>
  parseManagedPiPolicyTolerantV1({ schemaVersion: 1, forceRemoteSettingsRefresh: value }, { source: 't' }).policy

const CONFIRMED: ManagedDeliveryStateV1 = Object.freeze({
  policy: policy(true),
  source: 'server',
  confirmed: true,
  drops: [],
})

describe('the key itself', () => {
  test('an invalid value is STRIPPED, never read as "refuse to start"', () => {
    const parsed = parseManagedPiPolicyTolerantV1(
      { schemaVersion: 1, forceRemoteSettingsRefresh: 'yes' },
      { source: 't' },
    )
    expect(parsed.policy.forceRemoteSettingsRefresh).toBeUndefined()
    expect(parsed.drops.map(drop => drop.field)).toContain('forceRemoteSettingsRefresh')
  })
})

describe('precedence (:199)', () => {
  test('an MDM-style file wins even with a cached server payload present', () => {
    expect(isForceRemoteSettingsRefreshRequired({
      managedFile: policy(true),
      cached: policy(undefined),
    })).toBe(true)
  })

  test('a server-delivered value alone is enough — it self-perpetuates (:189)', () => {
    expect(isForceRemoteSettingsRefreshRequired({ cached: policy(true) })).toBe(true)
  })

  test('neither source asking leaves startup alone', () => {
    expect(isForceRemoteSettingsRefreshRequired({
      managedFile: policy(undefined),
      cached: policy(false),
    })).toBe(false)
  })

  test('the cached value survives a restart because the cache stores it', () => {
    applyDeliveredDocument({
      document: { schemaVersion: 1, forceRemoteSettingsRefresh: true },
      cachePath,
      now: 1,
    })
    resetManagedDeliverySession()
    // A fresh process reads it straight back off disk, before any fetch.
    return enforceForceRemoteSettingsRefresh({ cachePath, jwt: null })
      .then(decision => expect(decision.outcome).toBe('needs-authentication'))
  })
})

describe('the gate', () => {
  const requiredFile = policy(true)

  test('does nothing when no admin source asks for it', async () => {
    const decision = await enforceForceRemoteSettingsRefresh({ cachePath, jwt: 'j' })
    expect(decision.outcome).toBe('not-required')
  })

  test('a failed fetch blocks with a recovery message (:189, :203)', async () => {
    const decision = await enforceForceRemoteSettingsRefresh({
      managedFilePolicy: requiredFile,
      cachePath,
      jwt: 'j',
      refresh: () => Promise.reject(new Error('managed settings request failed')),
    })
    expect(decision.outcome).toBe('blocked')
    expect(decision.recovery).toContain('sign in')
  })

  test('a successful fetch satisfies it', async () => {
    const decision = await enforceForceRemoteSettingsRefresh({
      managedFilePolicy: requiredFile,
      cachePath,
      jwt: 'j',
      refresh: () => Promise.resolve(CONFIRMED),
    })
    expect(decision.outcome).toBe('satisfied')
  })

  test('a fetch that resolves UNCONFIRMED still blocks', async () => {
    const decision = await enforceForceRemoteSettingsRefresh({
      managedFilePolicy: requiredFile,
      cachePath,
      jwt: 'j',
      refresh: () => Promise.resolve({ ...CONFIRMED, confirmed: false }),
    })
    expect(decision.outcome).toBe('blocked')
  })

  test('an already-confirmed session is satisfied without a second fetch', async () => {
    let calls = 0
    const decision = await enforceForceRemoteSettingsRefresh({
      managedFilePolicy: requiredFile,
      cachePath,
      jwt: 'j',
      currentState: () => CONFIRMED,
      refresh: () => { calls += 1; return Promise.resolve(CONFIRMED) },
    })
    expect(decision.outcome).toBe('satisfied')
    expect(calls).toBe(0)
  })
})

describe('the exemption (:205) — no credential expiry becomes a lockout', () => {
  const requiredFile = policy(true)

  test('an authentication entry point is exempt outright', async () => {
    const decision = await enforceForceRemoteSettingsRefresh({
      managedFilePolicy: requiredFile,
      cachePath,
      exempt: true,
      jwt: null,
      refresh: () => Promise.reject(new Error('must not be called')),
    })
    expect(decision.outcome).toBe('exempt')
  })

  test('missing credentials route to sign-in, never to exit', async () => {
    let calls = 0
    for (const jwt of [null, undefined, '']) {
      const decision = await enforceForceRemoteSettingsRefresh({
        managedFilePolicy: requiredFile,
        cachePath,
        jwt,
        refresh: () => { calls += 1; return Promise.resolve(CONFIRMED) },
      })
      expect(decision.outcome).toBe('needs-authentication')
      expect(decision.recovery).toBeDefined()
    }
    // The request is never even attempted without a credential — that is what
    // separates this branch from `blocked`.
    expect(calls).toBe(0)
  })

  test('signing in and re-running the gate recovers', async () => {
    const first = await enforceForceRemoteSettingsRefresh({
      managedFilePolicy: requiredFile, cachePath, jwt: null,
    })
    expect(first.outcome).toBe('needs-authentication')

    const second = await enforceForceRemoteSettingsRefresh({
      managedFilePolicy: requiredFile,
      cachePath,
      jwt: 'fresh-jwt',
      refresh: () => Promise.resolve(CONFIRMED),
    })
    expect(second.outcome).toBe('satisfied')
  })

  test('no decision ever carries a token or a credentialed URL', async () => {
    const decision = await enforceForceRemoteSettingsRefresh({
      managedFilePolicy: requiredFile,
      cachePath,
      jwt: 'super-secret-jwt',
      refresh: () => Promise.reject(new Error('managed settings HTTP 502')),
    })
    const rendered = JSON.stringify({ reason: decision.reason, recovery: decision.recovery })
    expect(rendered).not.toContain('super-secret-jwt')
    expect(rendered).not.toContain('@')
  })
})
