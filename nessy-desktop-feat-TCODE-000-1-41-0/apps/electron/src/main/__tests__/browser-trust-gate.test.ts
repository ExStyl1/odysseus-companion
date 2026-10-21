/**
 * P6.536 — the two gates, and the clause `done_means` puts last:
 * *"removing either gate fails a test"*.
 *
 * These assertions are written against the GATE rather than against the store
 * (which has its own suite on values in `packages/shared`), because the defect
 * the row closed was not a missing rule — it was a missing CALL.
 *
 * The other half — that `BrowserCDP.ensureAttached` actually asks — lives in
 * `browser-cdp.test.ts` and NOT here, for a measured reason:
 * `browser-pane-manager.test.ts` replaces the whole `../browser-cdp` module with
 * a stub, and a `mock.module` amputates that module for every LATER test file in
 * the process (AGENTS.md §Traps). Run alone this file was green with the attach
 * assertions in it; run in a batch it measured the stub. `browser-cdp.test.ts`
 * sorts before the pane-manager suite, so the assertions live there.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

mock.module('../logger', () => {
  const stubLog = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} }
  return {
    mainLog: stubLog,
    sessionLog: stubLog,
    handlerLog: stubLog,
    windowLog: stubLog,
    agentLog: stubLog,
    searchLog: stubLog,
    isDebugMode: false,
    getLogFilePath: () => '/tmp/main.log',
  }
})

const { registerBrowserTrustPrompter, requireBrowserTrust, requireBrowserTrustOrThrow } =
  await import('../browser-trust-gate')
const { resetBrowserTrustForTests, listBrowserTrust, browserOriginsSeenThisSession } =
  await import('../browser-origin-trust-store')
const {
  registerManagedBrowserCdpDisabledProvider,
  registerManagedBrowserExternalNavigationDisabledProvider,
  registerManagedBrowserExternalPageToolsDisabledProvider,
  registerManagedBrowserHostAllowlistProvider,
} = await import('@nessy-agent/shared/config/managed-in-app-browser')

/** P6.338 — every graded lock back to "no opinion". */
function clearManagedBrowserLocks(): void {
  registerManagedBrowserCdpDisabledProvider(undefined)
  registerManagedBrowserExternalNavigationDisabledProvider(undefined)
  registerManagedBrowserExternalPageToolsDisabledProvider(undefined)
  registerManagedBrowserHostAllowlistProvider(undefined)
}

// Never the developer's own config directory: a DENY persists, and a test that
// writes into `~/.nessy-agent` changes the machine it runs on.
const TRUST_DIR = mkdtempSync(join(tmpdir(), 'w8o-browser-trust-'))

beforeEach(() => {
  resetBrowserTrustForTests(join(TRUST_DIR, `trust-${Math.random().toString(36).slice(2)}.json`))
  registerBrowserTrustPrompter(undefined)
  clearManagedBrowserLocks()
})

afterEach(() => {
  registerBrowserTrustPrompter(undefined)
  clearManagedBrowserLocks()
})

describe('the gate itself', () => {
  it('FAILS CLOSED when there is no way to ask', async () => {
    const grant = await requireBrowserTrust('https://a.example/x', 'navigation')
    expect(grant).toEqual({ allowed: false, reason: 'unanswerable', origin: 'https://a.example' })
  })

  it('asks once and then stops asking, per gate', async () => {
    let asked = 0
    registerBrowserTrustPrompter(async () => { asked += 1; return 'always-allow' })

    expect((await requireBrowserTrust('https://a.example/1', 'navigation')).allowed).toBe(true)
    expect((await requireBrowserTrust('https://a.example/2', 'navigation')).allowed).toBe(true)
    expect(asked).toBe(1)

    // The CDP grant is a separate power over the same origin.
    expect((await requireBrowserTrust('https://a.example/1', 'cdp')).allowed).toBe(true)
    expect(asked).toBe(2)
  })

  it('a denial sticks, and the settings list can see it', async () => {
    registerBrowserTrustPrompter(async () => 'deny')
    const grant = await requireBrowserTrust('https://bad.example/', 'navigation')
    expect(grant).toEqual({ allowed: false, reason: 'denied', origin: 'https://bad.example' })
    expect(listBrowserTrust().map(e => [e.origin, e.navigation]))
      .toEqual([['https://bad.example', 'deny']])
  })

  it('a prompt that throws is an unanswered question, never a yes', async () => {
    registerBrowserTrustPrompter(async () => { throw new Error('window closed') })
    expect((await requireBrowserTrust('https://a.example/', 'cdp')).reason).toBe('unanswerable')
  })

  it('never asks about the pane\'s own idle state', async () => {
    let asked = 0
    registerBrowserTrustPrompter(async () => { asked += 1; return 'allow-once' })
    expect((await requireBrowserTrust('about:blank', 'navigation')).allowed).toBe(true)
    expect(asked).toBe(0)
  })

  it('the managed CDP lock is SEPARATE from the pane, and is asked first', async () => {
    registerBrowserTrustPrompter(async () => 'always-allow')
    registerManagedBrowserCdpDisabledProvider(() => true)

    expect(await requireBrowserTrust('https://a.example/', 'cdp'))
      .toEqual({ allowed: false, reason: 'managed' })
    // Navigation is untouched by the CDP lock: an operator can forbid the
    // debugger without taking the browser away.
    expect((await requireBrowserTrust('https://a.example/', 'navigation')).allowed).toBe(true)
  })

  it('records which origins the session touched, on the navigation path', async () => {
    registerBrowserTrustPrompter(async () => 'allow-once')
    await requireBrowserTrustOrThrow('https://a.example/x', 'navigation')
    await requireBrowserTrustOrThrow('https://b.example/y', 'navigation')
    expect(browserOriginsSeenThisSession()).toEqual(['https://a.example', 'https://b.example'])
  })
})

describe('P6.338 — the graded managed locks, at the gate that already exists', () => {
  it('POSITIVE: an off-allowlist origin is refused BY NAME, over a stored Always allow', async () => {
    // The two halves of the row in one assertion. The origin was approved for
    // ever by the person BEFORE the policy arrived, and the operator's list
    // still wins — which is the whole reason the lock lives in this gate and
    // not beside the trust store.
    registerBrowserTrustPrompter(async () => 'always-allow')
    expect((await requireBrowserTrust('https://off.example/x', 'navigation')).allowed).toBe(true)

    registerManagedBrowserHostAllowlistProvider(() => ['docs.example.com', '*.internal.example.com'])
    const refused = await requireBrowserTrust('https://off.example/x', 'navigation')
    expect(refused.allowed).toBe(false)
    expect(refused.reason).toBe('managed')
    // Named, so the administrator knows which line of which document to change.
    expect(refused.managedMessage).toContain('browserHostAllowlist')
    await expect(requireBrowserTrustOrThrow('https://off.example/x', 'navigation'))
      .rejects.toThrow(/browserHostAllowlist/)

    // The listed host and its wildcard child still pass, and a managed ALLOW
    // does not skip the card: this origin was never approved, so it is asked.
    let asked = 0
    registerBrowserTrustPrompter(async () => { asked += 1; return 'allow-once' })
    expect((await requireBrowserTrust('https://docs.example.com/', 'navigation')).allowed).toBe(true)
    expect((await requireBrowserTrust('https://build.internal.example.com/', 'navigation')).allowed)
      .toBe(true)
    expect(asked).toBe(2)
  })

  it('NEGATIVE: localhost is exempt from every lock, and the person is exempt from the tools lock', async () => {
    // The boundary the vendor states in the same words for both keys —
    // "Localhost dev server previews keep working" — plus the one distinction
    // `browserExternalPageTools` exists for: it is about Claude's tools, so the
    // person's own browsing is untouched by it.
    registerBrowserTrustPrompter(async () => 'always-allow')
    registerManagedBrowserExternalNavigationDisabledProvider(() => true)
    registerManagedBrowserHostAllowlistProvider(() => [])
    for (const url of ['http://localhost:5173/', 'http://127.0.0.1:3000/x', 'about:blank']) {
      expect((await requireBrowserTrust(url, 'navigation')).allowed, url).toBe(true)
    }
    // And the whole-pane lock does refuse an external origin, for both actors.
    expect((await requireBrowserTrust('https://a.example/', 'navigation', { actor: 'person' })).reason)
      .toBe('managed')

    clearManagedBrowserLocks()
    registerManagedBrowserExternalPageToolsDisabledProvider(() => true)
    expect((await requireBrowserTrust('https://a.example/', 'navigation', { actor: 'agent' })).reason)
      .toBe('managed')
    expect((await requireBrowserTrust('https://a.example/', 'navigation', { actor: 'person' })).allowed)
      .toBe(true)
    // An absent actor reads as the person: a caller that forgot must not have a
    // user's browsing blocked by a key about Claude's tools.
    expect((await requireBrowserTrust('https://a.example/', 'navigation')).allowed).toBe(true)
  })
})
