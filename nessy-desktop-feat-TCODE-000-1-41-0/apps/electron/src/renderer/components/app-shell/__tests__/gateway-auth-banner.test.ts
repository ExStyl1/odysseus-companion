import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'bun:test'
import { DpAuthError } from '@nessy-agent/shared/auth/dp/errors'
import en from '@nessy-agent/shared/i18n/locales/en.json'
import ru from '@nessy-agent/shared/i18n/locales/ru.json'
import { computeGatewayBannerView } from '../GatewayAuthBanner'
import { gatewaySignInFailureView } from '@/hooks/useNessyGatewayAuth'

describe('computeGatewayBannerView', () => {
  it('idle/login-required shows sign-in CTA', () => {
    expect(computeGatewayBannerView('login-required')).toEqual({
      titleKey: 'auth.nessyGatewaySignInRequired',
      buttonKey: 'auth.nessyGatewaySignIn',
      busy: false,
    })
  })
  it('progress phases disable the button with progress labels', () => {
    expect(computeGatewayBannerView('checking').busy).toBe(true)
    expect(computeGatewayBannerView('exchanging').buttonKey).toBe('onboarding.gatewayConnect.connecting')
    expect(computeGatewayBannerView('waiting-browser')).toEqual({
      titleKey: 'auth.nessyGatewaySignInRequired',
      buttonKey: 'onboarding.gatewayConnect.waitingBrowser',
      busy: true,
    })
  })
  it('error keeps the DpNotFound corp-IT sentence byte-for-byte (F1.361 control)', () => {
    expect(computeGatewayBannerView('error', 'DpNotFound')).toEqual({
      titleKey: 'onboarding.gatewayConnect.errorDpNotFound',
      buttonKey: 'onboarding.gatewayConnect.retry',
      busy: false,
    })
  })

  /**
   * F1.361 — every other code used to collapse into 'Sign-in failed. Please try
   * again.', so a user whose browser never showed up (LoginBrowserTimeout) read
   * the same sentence as a user whose token exchange failed. The per-code
   * sentences already existed for the in-chat card (`chat.dpAuth.errors.<code>`);
   * the banner now reads the same ones.
   */
  it('error renders LoginBrowserTimeout in its OWN sentence, with the sign-in-again next step (F1.361 +)', () => {
    expect(computeGatewayBannerView('error', 'LoginBrowserTimeout')).toEqual({
      titleKey: 'chat.dpAuth.errors.LoginBrowserTimeout',
      nextStepKey: 'onboarding.gatewayConnect.nextStepSignIn',
      buttonKey: 'onboarding.gatewayConnect.retry',
      busy: false,
    })
    expect(computeGatewayBannerView('error', 'NeedsLogin').nextStepKey).toBe('onboarding.gatewayConnect.nextStepSignIn')
    expect(computeGatewayBannerView('error', 'ExchangeFailed')).toEqual({
      titleKey: 'chat.dpAuth.errors.ExchangeFailed',
      buttonKey: 'onboarding.gatewayConnect.retry',
      busy: false,
    })
  })

  it('an UNMAPPED or missing code keeps the generic sentence (F1.361 -)', () => {
    for (const code of ['SomethingDpWillSayNextYear', '', undefined]) {
      expect({ code, view: computeGatewayBannerView('error', code) }).toEqual({
        code,
        view: { titleKey: 'onboarding.gatewayConnect.errorGeneric', buttonKey: 'onboarding.gatewayConnect.retry', busy: false },
      })
    }
  })

  it('every DpAuthError code resolves to a key BOTH locales carry (F1.361)', () => {
    const missing: string[] = []
    for (const code of Object.values(DpAuthError)) {
      const view = gatewaySignInFailureView(code)
      for (const key of [view.reasonKey, view.nextStepKey].filter((k): k is string => k !== undefined)) {
        for (const [name, locale] of [['en', en], ['ru', ru]] as const) {
          if (typeof (locale as Record<string, unknown>)[key] !== 'string') missing.push(`${name}:${key}`)
        }
      }
    }
    expect(missing).toEqual([])
  })
})

/**
 * F1.361 — the onboarding step read DpNotFound or the generic sentence and
 * nothing else. `bun test` has no DOM here, so the RULE is the pure function
 * above and the WIRING is pinned by source match (the instrument
 * `ai-settings-reconnect.test.ts` uses for the same reason).
 */
describe('GatewayConnectStep routes its error through the per-code view', () => {
  const source = readFileSync(fileURLToPath(new URL('../../onboarding/GatewayConnectStep.tsx', import.meta.url)), 'utf8')

  it('reads gatewaySignInFailureView, not a DpNotFound-or-generic ternary', () => {
    expect({ reads: source.includes('gatewaySignInFailureView(errorCode)') }).toEqual({ reads: true })
    expect({ oldTernary: source.includes("errorCode === 'DpNotFound'") }).toEqual({ oldTernary: false })
  })
})

/**
 * F1.2 — the three facade surfaces show the captured URL while the browser wait
 * lasts. The rule is `reduceGatewayAuthUrl` (hook suite); these pin the wiring.
 */
describe('the captured authorization URL reaches the banner, onboarding and Settings (F1.2)', () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

  it('the banner renders the URL hint while waiting for the browser', () => {
    const banner = read('../GatewayAuthBanner.tsx')
    expect({ hint: banner.includes("phase === 'waiting-browser' && authUrl") }).toEqual({ hint: true })
    expect({ component: banner.includes('<GatewayAuthUrlHint') }).toEqual({ component: true })
  })

  it('the onboarding step renders it in the waiting-browser state', () => {
    const step = read('../../onboarding/GatewayConnectStep.tsx')
    expect({ hint: step.includes('isWaitingBrowser && authUrl') }).toEqual({ hint: true })
    expect({ component: step.includes('<GatewayAuthUrlHint') }).toEqual({ component: true })
  })

  it('Settings → Reconnect offers it while its own run waits for the browser', () => {
    const page = read('../../../pages/settings/AiSettingsPage.tsx')
    expect({ reads: page.includes('authUrl: gatewayAuthUrl } = useNessyGatewayAuth()') }).toEqual({ reads: true })
    expect({ notice: page.includes('useGatewayAuthUrlToast(gatewayAuthUrl, reconnectingSlug !== null, t)') }).toEqual({ notice: true })
  })
})

/**
 * F1.366 rule 6 — a sign-in that used dp's STORED session says so. The banner
 * is the one mount every main-window surface shares (Settings included); the
 * onboarding step runs before it exists. Both raise the same toast id, so one
 * run shows one note.
 */
describe('the stored-dp-session note reaches the user (F1.366)', () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

  it('the banner and the onboarding step both raise it, under one toast id', () => {
    for (const rel of ['../GatewayAuthBanner.tsx', '../../onboarding/GatewayConnectStep.tsx']) {
      const source = read(rel)
      expect({ rel, reads: source.includes('dpSessionFileUsed') }).toEqual({ rel, reads: true })
      expect({
        rel,
        key: source.includes('onboarding.gatewayConnect.dpSessionFileUsed'),
        id: source.includes('{ id: DP_SESSION_FILE_TOAST_ID }'),
      }).toEqual({ rel, key: true, id: true })
    }
  })

  it('the sentence exists in both locales', () => {
    for (const [name, locale] of [['en', en], ['ru', ru]] as const) {
      expect({ name, has: typeof (locale as Record<string, unknown>)['onboarding.gatewayConnect.dpSessionFileUsed'] }).toEqual({ name, has: 'string' })
    }
  })
})
