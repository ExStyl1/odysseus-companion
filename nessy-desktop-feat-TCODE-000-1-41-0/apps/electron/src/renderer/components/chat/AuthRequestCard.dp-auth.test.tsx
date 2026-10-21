import * as React from 'react'
import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import { DpAuthError } from '@nessy-agent/shared/auth/dp/errors'
import type { DpAuthStatusEvent } from '@nessy-agent/shared/protocol'
import type { Message } from '../../../shared/types'
/*
 * P6.844 — the card is a STATIC import and the `@nessy-agent/ui` carve-out that
 * stood here is gone. `AuthRequestCard` took `Spinner` from the BARREL, whose
 * module graph reaches the Vite-only `pdfjs-dist/...?url` specifier bun cannot
 * resolve, so this file replaced the whole package with a one-export
 * `mock.module` — no spread, no restore: the amputation `AGENTS.md` describes,
 * process-wide for every later file in the batch, and it forced the four
 * bindings below through a dynamic import. The card now imports
 * `@nessy-agent/ui/ui/LoadingIndicator`, so the SHIPPED spinner renders here
 * instead of a stub and no mock is needed anywhere.
 */
import {
  AuthRequestCard,
  runDpAuthAttempt,
  dpAuthStatusForResult,
  resolveDpAuthUi,
  routeDpAuthStatus,
} from './AuthRequestCard'
import { GatewayAuthUrlHint } from '../apisetup/GatewayAuthUrlHint'

type DpSessionStatus = DpAuthStatusEvent['status']

let testI18n: I18nInstance

beforeAll(async () => {
  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: {
      en: {
        translation: {
          // UA12.206 — the credential form's hint reads this key now; without it the hint-absent negative below
          // could not see the hint render (t() would answer the key itself). UB14.26 — upstream's name for it.
          'chat.authCard.encryptedAtRest': 'Credentials are encrypted at rest',
          'chat.authCard.titleDp': '{{name}} Sign-In',
          'chat.dpAuth.cancel': 'Cancel',
          'chat.dpAuth.failed': 'Developer Platform Sign-In Failed',
          'chat.dpAuth.title': 'Sign in to Developer Platform',
          'chat.dpAuth.checking': 'Checking Developer Platform session',
          'chat.dpAuth.waitingBrowser': 'Complete sign-in in your browser',
          'chat.dpAuth.connected': 'Developer Platform Connected',
          'chat.dpAuth.cancelled': 'Developer Platform Cancelled',
          'chat.dpAuth.retry': 'Retry',
          [`chat.dpAuth.errors.${DpAuthError.ExecFailed}`]: 'Developer Platform command failed',
          [`chat.dpAuth.errors.${DpAuthError.NeedsLogin}`]: 'Developer Platform sign-in is required',
          'onboarding.gatewayConnect.authUrlHint': 'No browser tab? Copy the sign-in link',
          'onboarding.gatewayConnect.copyAuthUrl': 'Copy sign-in link',
        },
      },
    },
    interpolation: { escapeValue: false },
  })
})

function message(status: Message['authStatus'], error?: string): Message {
  return {
    id: 'auth-dp',
    role: 'auth-request',
    content: 'Authentication required',
    timestamp: 1,
    authRequestId: 'request-dp',
    authRequestType: 'dp',
    authSourceSlug: 'dp',
    authSourceName: 'Developer Platform',
    authStatus: status,
    authError: error,
  }
}

function renderCard(
  value: Message,
  initialAttempt?: { submitting?: boolean; dpStatus?: DpSessionStatus; dpAuthUrl?: string },
): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={testI18n}>
      <AuthRequestCard message={value} sessionId="session-dp" initialAttempt={initialAttempt} />
    </I18nextProvider>,
  )
}

/** The opening tag of the button whose label is `label`. */
function buttonTag(html: string, label: string): string {
  const at = html.indexOf(`${label}</button>`)
  expect({ label, found: at > -1 }).toEqual({ label, found: true })
  const start = html.lastIndexOf('<button', at)
  return html.slice(start, html.indexOf('>', start) + 1)
}

describe('AuthRequestCard DP auth', () => {
  test('renders the dedicated sign-in action without credential fields', () => {
    const html = renderCard(message('pending'))

    expect(html).toContain('Sign in to Developer Platform')
    expect(html).not.toContain('<input')
    expect(html).not.toContain('Credentials are encrypted at rest')
  })

  // DA1.4 / Target scheme clause 2 — a card raised by a FAILED FORCED RE-MINT
  // (`SessionManager.raiseGatewayReMintAuthCard`) is PENDING, not failed: the
  // user still has the one button that fixes it. Before this row the pending
  // card rendered its title alone, so the reason the re-mint failed had nowhere
  // to land and the user could not tell a signed-out dp from a missing binary.
  test('names the reason on a PENDING card raised with a re-mint failure code', () => {
    const html = renderCard(message('pending', DpAuthError.NeedsLogin))

    expect(html).toContain('Sign in to Developer Platform')
    expect(html).toContain('Developer Platform sign-in is required')
    // The one button clause 2 names is still there — this is not a dead card.
    expect(html).toContain('Sign in')
    expect(html).not.toContain('<input')
  })

  // The negative the row asks for, in both of its shapes: an ABSENT code and an
  // UNMAPPED one both fall back to today's card. `dpErrorCode` defaults to
  // `ExecFailed`, so a pending card that read THAT would claim "Developer
  // Platform command failed" on every ordinary sign-in prompt.
  for (const [name, code] of [
    ['no code at all', undefined],
    ['a code outside the DpAuthError members', 'SomeCodeWeDoNotKnow'],
  ] as Array<[string, string | undefined]>) {
    test(`renders today's card with ${name}`, () => {
      const html = renderCard(message('pending', code))

      expect(html).toContain('Sign in to Developer Platform')
      expect(html).not.toContain('Developer Platform sign-in is required')
      expect(html).not.toContain('Developer Platform command failed')
      expect(html).not.toContain('chat.dpAuth.errors.')
    })
  }

  test('renders a localized stable error and retry after a terminal failed attempt', () => {
    const html = renderCard(message('failed', DpAuthError.ExecFailed))

    expect(html).toContain('Developer Platform command failed')
    expect(html).toContain('Retry')
    expect(html).not.toContain('<input')
  })

  test('invokes the DP API for the same pending request and forwards attempt statuses', async () => {
    const statuses: string[] = []
    const performDpAuth = mock(async (
      args: { sessionId: string; requestId: string },
      onStatus?: (status: DpSessionStatus) => void,
    ) => {
      onStatus?.('checking')
      onStatus?.('waiting-browser')
      return { ok: false as const, code: DpAuthError.ExecFailed }
    })

    const result = await runDpAuthAttempt(
      performDpAuth,
      'session-dp',
      'request-dp',
      status => statuses.push(status),
    )

    expect(performDpAuth).toHaveBeenCalledWith(
      { sessionId: 'session-dp', requestId: 'request-dp' },
      expect.any(Function),
    )
    expect(statuses).toEqual([
      'checking',
      'waiting-browser',
      `error:${DpAuthError.ExecFailed}`,
    ])
    expect(result).toEqual({ ok: false, code: DpAuthError.ExecFailed })
  })

  test('keeps Cancel enabled while an ensure attempt disables the primary action', () => {
    expect(resolveDpAuthUi('pending', 'checking', true, false)).toMatchObject({
      state: 'checking',
      showActions: true,
      primaryDisabled: true,
      cancelDisabled: false,
    })
  })

  test('preserves a stable cancel transport failure instead of rendering Cancelled', () => {
    const status = dpAuthStatusForResult({
      ok: false,
      code: DpAuthError.ExecFailed,
    })

    expect(status).toBe(`error:${DpAuthError.ExecFailed}`)
    expect(resolveDpAuthUi('pending', status, false, false)).toMatchObject({
      state: 'failed',
      errorCode: DpAuthError.ExecFailed,
      showActions: true,
    })
  })

  test('renders local success as terminal Connected without waiting for a push event', async () => {
    const statuses: DpSessionStatus[] = []
    const result = await runDpAuthAttempt(
      mock(async () => ({ ok: true as const })),
      'session-dp',
      'request-dp',
      status => statuses.push(status),
    )
    const status = statuses.at(-1)

    expect(result).toEqual({ ok: true })
    expect(status).toBe('ready')
    expect(resolveDpAuthUi('pending', status, false, false)).toMatchObject({
      state: 'connected',
      showActions: false,
    })
  })
})

/**
 * UB14.26 — the dp card (ours) on v0.15.1's decision material: pending and in-flight states are a standalone
 * `DecisionCard`, Connected and Cancelled are upstream's `AuthOutcome`, and a failed attempt keeps Retry and
 * Cancel on a danger-toned decision card (upstream's failures carry no action; ours retries).
 */
describe('AuthRequestCard DP auth on the decision material (UB14.26)', () => {
  test('POSITIVE — the pending dp card: info decision card, the titleDp header, the sign-in primary and Cancel', () => {
    const html = renderCard(message('pending'))
    expect(html).toContain('data-decision-tone="info"')
    expect(html).toContain('Developer Platform Sign-In') // chat.authCard.titleDp with the source name
    expect(buttonTag(html, 'Sign in to Developer Platform')).toContain('data-variant="primary"')
    expect(buttonTag(html, 'Cancel')).toContain('data-variant="ghost"')
  })

  test('POSITIVE — the dp card reaches Connected on `ready`: the success outcome, no action', () => {
    expect(resolveDpAuthUi('pending', 'ready', false, false).state).toBe('connected')
    const html = renderCard(message('pending'), { dpStatus: 'ready' })
    expect(html).toContain('Developer Platform Connected')
    expect(html).toContain('bg-success-tint')
    expect(html).not.toContain('data-decision-tone')
    expect(html).not.toContain('<button')
  })

  test('POSITIVE — waiting for the browser: the copy-link hint, the primary disabled, Cancel enabled', () => {
    const url = 'https://as.example.invalid/oauth2/auth?state=card-state'
    const html = renderCard(message('pending'), { submitting: true, dpStatus: 'waiting-browser', dpAuthUrl: url })
    expect(html).toContain('Checking Developer Platform session')
    expect(html).toContain('Complete sign-in in your browser')
    expect(html).toContain('data-testid="gateway-auth-url-hint"')
    expect(html).toContain('as.example.invalid')
    expect(html).not.toContain('card-state')
    // The ATTRIBUTE (`disabled=""`): every button's class carries `disabled:` variants.
    expect(buttonTag(html, 'Sign in to Developer Platform')).toContain('disabled=""')
    expect(buttonTag(html, 'Cancel')).not.toContain('disabled=""')
  })

  test('a failed attempt keeps Retry and Cancel on a danger-toned decision card', () => {
    const html = renderCard(message('failed', DpAuthError.ExecFailed))
    expect(html).toContain('data-decision-tone="danger"')
    expect(html).toContain('Developer Platform Sign-In Failed')
    expect(html).toContain('Developer Platform command failed')
    expect(buttonTag(html, 'Retry')).toContain('data-variant="primary"')
    expect(buttonTag(html, 'Cancel')).not.toContain('disabled=""')
  })

  test('NEGATIVE (control) — a cancelled dp code is `cancelled`, not `failed`: the muted outcome, no Retry', () => {
    expect(resolveDpAuthUi('pending', `error:${DpAuthError.Cancelled}`, false, false)).toMatchObject({
      state: 'cancelled',
      showActions: false,
    })
    for (const html of [
      renderCard(message('pending'), { dpStatus: `error:${DpAuthError.Cancelled}` }),
      renderCard(message('failed', DpAuthError.Cancelled)),
    ]) {
      expect(html).toContain('Developer Platform Cancelled')
      expect(html).toContain('bg-fill-hover')
      expect(html).not.toContain('bg-destructive-tint')
      expect(html).not.toContain('data-decision-tone="danger"')
      expect(html).not.toContain('Retry')
    }
  })
})

/**
 * F1.2 — the in-chat card receives the broker's `auth-url:<url>` status on the
 * same stream as its phases. It must NOT become the card's phase (that would
 * knock the card out of its waiting-browser view at the very moment the URL
 * arrives); it is routed to the URL slot instead.
 */
describe('AuthRequestCard DP auth — the authorization URL (F1.2)', () => {
  test('routes an auth-url status to the URL slot and every other status to the phase', () => {
    const phases: string[] = []
    const urls: string[] = []
    const url = 'https://as.example.invalid/oauth2/auth?state=card'
    for (const status of ['checking', 'waiting-browser', `auth-url:${url}`, 'auth-url:file:///etc/hosts', 'ready']) {
      routeDpAuthStatus(status as DpSessionStatus, (s) => phases.push(s), (u) => urls.push(u))
    }
    expect(phases).toEqual(['checking', 'waiting-browser', 'ready'])
    expect(urls).toEqual([url])
  })

  test('the hint names the host and offers the copy action, never the query in the visible text', () => {
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={testI18n}>
        <GatewayAuthUrlHint url="https://as.example.invalid/oauth2/auth?state=secret-state" />
      </I18nextProvider>,
    )
    expect(html).toContain('No browser tab? Copy the sign-in link')
    expect(html).toContain('Copy sign-in link')
    expect(html).toContain('as.example.invalid')
    expect(html).not.toContain('secret-state')
  })
})
