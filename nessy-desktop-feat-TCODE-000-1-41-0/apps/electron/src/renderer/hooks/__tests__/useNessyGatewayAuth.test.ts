import { describe, it, expect } from 'bun:test'
import {
  reduceGatewayAuthStatus,
  initialGatewayAuthState,
  gatewayReconnectFailureNotice,
  gatewaySignInFailureView,
  parseGatewayAuthUrlStatus,
  reduceDpSessionFileUsed,
  reduceGatewayAuthUrl,
  type GatewayAuthState,
} from '../useNessyGatewayAuth'

function run(statuses: string[], start: GatewayAuthState = initialGatewayAuthState): GatewayAuthState {
  return statuses.reduce(reduceGatewayAuthStatus, start)
}

describe('reduceGatewayAuthStatus', () => {
  it('drives the happy path to done', () => {
    const end = run(['checking', 'waiting-browser', 'exchanging', 'done'])
    expect(end.phase).toBe('done')
    expect(end.errorCode).toBeUndefined()
  })

  it('carries the error code', () => {
    const end = run(['checking', 'error:DpNotFound'])
    expect(end.phase).toBe('error')
    expect(end.errorCode).toBe('DpNotFound')
  })

  it('treats cancellation as a return to idle, not an error', () => {
    const end = run(['checking', 'waiting-browser', 'error:Cancelled'])
    expect(end.phase).toBe('idle')
    expect(end.errorCode).toBeUndefined()
  })

  it('sets dpOutdated without changing the phase', () => {
    const end = run(['checking', 'dp-outdated', 'waiting-browser'])
    expect(end.dpOutdated).toBe(true)
    expect(end.phase).toBe('waiting-browser')
  })

  it('handles the launch-check login-required event', () => {
    const end = run(['login-required'])
    expect(end.phase).toBe('login-required')
  })

  it('ignores unknown status codes', () => {
    const start: GatewayAuthState = { phase: 'exchanging', dpOutdated: false, dpUnrunnable: false }
    expect(run(['something-else'], start)).toEqual(start)
  })

  it('sets dpUnrunnable without changing the phase (DA1.79)', () => {
    const end = run(['checking', 'dp-unrunnable', 'waiting-browser'])
    expect(end.dpUnrunnable).toBe(true)
    expect(end.phase).toBe('waiting-browser')
    // The NEGATIVE that keeps the two hints apart: a fallback ladder says
    // nothing about the version of the dp that answered.
    expect(end.dpOutdated).toBe(false)
  })

  it('carries both advisories at once — they are about different binaries', () => {
    const end = run(['checking', 'dp-outdated', 'dp-unrunnable', 'waiting-browser'])
    expect(end.dpOutdated).toBe(true)
    expect(end.dpUnrunnable).toBe(true)
    expect(end.phase).toBe('waiting-browser')
  })

  it('clears a prior error when a new run starts', () => {
    const errored = run(['checking', 'error:ExchangeFailed'])
    expect(errored.phase).toBe('error')
    const restarted = reduceGatewayAuthStatus(errored, 'checking')
    expect(restarted.phase).toBe('checking')
    expect(restarted.errorCode).toBeUndefined()
  })
})

/**
 * F1.361 — Settings → Reconnect returned SILENTLY on every failure: the row's
 * spinner stopped and nothing said why. The notice is what the page toasts.
 */
describe('gatewayReconnectFailureNotice', () => {
  it('a success and a user cancel say nothing', () => {
    expect(gatewayReconnectFailureNotice({ ok: true, username: 'u' })).toBeNull()
    expect(gatewayReconnectFailureNotice({ ok: false, code: 'Cancelled' })).toBeNull()
  })

  it('a failure carries its own reason and, where one exists, the next step', () => {
    expect(gatewayReconnectFailureNotice({ ok: false, code: 'LoginBrowserTimeout' })).toEqual({
      reasonKey: 'chat.dpAuth.errors.LoginBrowserTimeout',
      nextStepKey: 'onboarding.gatewayConnect.nextStepSignIn',
    })
    expect(gatewayReconnectFailureNotice({ ok: false, code: 'DpNotFound' })).toEqual({
      reasonKey: 'onboarding.gatewayConnect.errorDpNotFound',
    })
  })

  it('no result at all (the bridge is missing) is still a visible generic failure', () => {
    expect(gatewayReconnectFailureNotice(undefined)).toEqual({ reasonKey: 'onboarding.gatewayConnect.errorGeneric' })
    expect(gatewaySignInFailureView('NotACode')).toEqual({ reasonKey: 'onboarding.gatewayConnect.errorGeneric' })
  })
})

/**
 * F1.2 — the authorization URL dp handed its browser rides the status stream as
 * `auth-url:<url>`. It is kept ONLY while a login can still use it: every
 * status that ends or restarts the run clears it (a URL whose login was killed
 * has no callback listening any more).
 */
describe('reduceGatewayAuthUrl', () => {
  const url = 'https://as.example.invalid/oauth2/auth?state=abc'

  it('takes an http(s) URL from an auth-url status', () => {
    expect(reduceGatewayAuthUrl(undefined, `auth-url:${url}`)).toBe(url)
    expect(parseGatewayAuthUrlStatus(`auth-url:${url}`)).toBe(url)
  })

  it('refuses anything that is not an http(s) URL, and a status that is not auth-url', () => {
    for (const status of ['auth-url:file:///etc/hosts', 'auth-url:javascript:alert(1)', 'auth-url:not a url', 'auth-url:', 'waiting-browser']) {
      expect({ status, url: parseGatewayAuthUrlStatus(status) }).toEqual({ status, url: undefined })
    }
    expect(reduceGatewayAuthUrl(undefined, 'auth-url:file:///etc/hosts')).toBeUndefined()
  })

  it('keeps it while the browser wait lasts and drops it when the run ends or restarts', () => {
    expect(reduceGatewayAuthUrl(url, 'waiting-browser')).toBe(url)
    expect(reduceGatewayAuthUrl(url, 'dp-outdated')).toBe(url)
    for (const status of ['checking', 'exchanging', 'done', 'error:LoginBrowserTimeout', 'error:Cancelled', 'login-required']) {
      expect({ status, url: reduceGatewayAuthUrl(url, status) }).toEqual({ status, url: undefined })
    }
  })

  it('an auth-url status leaves the PHASE reducer untouched (it is not a phase)', () => {
    const waiting = run(['checking', 'waiting-browser'])
    expect(reduceGatewayAuthStatus(waiting, `auth-url:${url}`)).toEqual(waiting)
  })
})

/**
 * F1.366 rule 6 — the user SEES that dp's stored session was used. The facade
 * emits `dp-session-file`; the flag lives until the next run starts.
 */
describe('reduceDpSessionFileUsed', () => {
  it('turns on at dp-session-file, survives the rest of that run, and resets at the next checking', () => {
    const statuses = ['checking', 'dp-session-file', 'exchanging', 'done']
    expect(statuses.reduce(reduceDpSessionFileUsed, false)).toBe(true)
    expect(reduceDpSessionFileUsed(true, 'checking')).toBe(false)
    expect(['checking', 'exchanging', 'done'].reduce(reduceDpSessionFileUsed, false)).toBe(false)
  })

  it('is not a phase: the phase reducer ignores it', () => {
    const exchanging = run(['checking', 'exchanging'])
    expect(reduceGatewayAuthStatus(exchanging, 'dp-session-file')).toEqual(exchanging)
  })
})
