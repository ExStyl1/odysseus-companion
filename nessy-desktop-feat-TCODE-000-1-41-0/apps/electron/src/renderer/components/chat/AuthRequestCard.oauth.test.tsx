import * as React from 'react'
import { beforeAll, describe, expect, test } from 'bun:test'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import type { SafePluginMcpAuthRequirement } from '@nessy-agent/shared/protocol/capabilities'
import {
  createOAuthOperation,
  type OAuthOrchestrationDeps,
} from '../../../preload/oauth-orchestration'
import type { Message } from '../../../shared/types'
/*
 * P6.844 — the card is a STATIC import and the `@nessy-agent/ui` carve-out that
 * stood here is gone. `AuthRequestCard` took `Spinner` from the BARREL, whose
 * module graph reaches the Vite-only `pdfjs-dist/...?url` specifier bun cannot
 * resolve, so this file replaced the whole package with a one-export
 * `mock.module` — no spread, no restore: the amputation `AGENTS.md` describes,
 * process-wide for every later file in the batch, and it forced the five
 * bindings below through a dynamic import. The card now imports
 * `@nessy-agent/ui/ui/LoadingIndicator`, so the SHIPPED spinner renders here
 * instead of a stub and no mock is needed anywhere.
 */
import {
  AuthRequestCard,
  resolveOAuthUi,
  shouldAbortOAuthOperation,
  buildOAuthCardRequest,
  OAUTH_CANCEL_FAILURE_MESSAGE_KEY,
} from './AuthRequestCard'

let testI18n: I18nInstance

beforeAll(async () => {
  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    // UA12.206 follow-up — the status titles read these keys now; without them t() answers the key itself.
    // UA12.209 — so do the sign-in button and the waiting title. UB14.26 — upstream's `chat.authCard.*` names.
    resources: {
      en: {
        translation: {
          'chat.authCard.authenticating': '{{name}} Authenticating...',
          'chat.authCard.cancelFailed': 'Unable to cancel OAuth authentication. Try again.',
          'chat.authCard.cancelled': '{{name}} Cancelled',
          'chat.authCard.completeInBrowser': 'Complete authentication in your browser',
          'chat.authCard.connected': '{{name}} Connected',
          'chat.authCard.failed': '{{name}} Failed',
          'chat.authCard.restartSignIn': 'Restart sign-in',
          'chat.authCard.signInWith': 'Sign in with {{provider}}',
          'chat.authCard.signedInAs': 'Signed in as {{email}}',
          'chat.authCard.titleCredential': '{{name}} Authentication',
          'chat.authCard.titleGoogle': '{{name}} Google Sign-In',
          'chat.authCard.titleOAuth': '{{name}} OAuth',
          'chat.authCard.workspace': 'Workspace: {{workspace}}',
          'common.cancel': 'Cancel',
        },
      },
    },
    interpolation: { escapeValue: false },
  })
})

function message(status: Message['authStatus'], error?: string): Message {
  return {
    id: 'auth-oauth',
    role: 'auth-request',
    content: 'Authentication required',
    timestamp: 1,
    authRequestId: 'request-oauth',
    authRequestType: 'oauth',
    authSourceSlug: 'gitlab',
    authSourceName: 'GitLab TCS',
    authStatus: status,
    authError: error,
  }
}

function renderCard(
  value: Message,
  extra: { isInteractive?: boolean; initialAttempt?: { submitting?: boolean } } = {},
): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={testI18n}>
      <AuthRequestCard message={value} sessionId="session-oauth" {...extra} />
    </I18nextProvider>,
  )
}

describe('AuthRequestCard OAuth', () => {
  test('renders the server-owned terminal failure without a local final state', () => {
    const html = renderCard(message(
      'failed',
      'This endpoint does not advertise MCP OAuth. Fix the source configuration or use the supported DP-backed plugin MCP.',
    ))

    expect(html).toContain('GitLab TCS Failed')
    expect(html).toContain('This endpoint does not advertise MCP OAuth.')
    expect(html).not.toContain('Authenticating')
  })

  test('renders a fresh pending request as a new OAuth flow action', () => {
    const fresh = message('pending')
    fresh.authRequestId = 'request-oauth-retry'
    const html = renderCard(fresh)

    expect(html).toContain('Sign in with OAuth')
  })

  test('renders auth_completed cancellation without a competing local state', () => {
    const html = renderCard(message('cancelled'))

    expect(html).toContain('GitLab TCS Cancelled')
    expect(html).not.toContain('Authenticating')
    expect(html).not.toContain('Sign in with OAuth')
  })

  test('keeps Cancel actionable while OAuth is waiting in the browser', () => {
    expect(resolveOAuthUi('pending', true, false)).toEqual({
      showActions: true,
      primaryDisabled: true,
      cancelDisabled: false,
      transientMessageKey: undefined,
    })
  })

  test('keeps cancel failure transient and uses a stable message', () => {
    expect(resolveOAuthUi('pending', false, false, 'cancel-failed')).toEqual({
      showActions: true,
      primaryDisabled: false,
      cancelDisabled: false,
      transientMessageKey: OAUTH_CANCEL_FAILURE_MESSAGE_KEY,
    })
    // UB14.26 — the message is a KEY in both locales now, never an English literal on the card.
    expect(OAUTH_CANCEL_FAILURE_MESSAGE_KEY).toBe('chat.authCard.cancelFailed')
    expect(testI18n.t(OAUTH_CANCEL_FAILURE_MESSAGE_KEY)).toBe('Unable to cancel OAuth authentication. Try again.')
  })

  test('stops local OAuth orchestration when auth_completed becomes terminal', () => {
    expect(shouldAbortOAuthOperation('completed', true, true)).toBe(true)
    expect(shouldAbortOAuthOperation('failed', true, true)).toBe(true)
    expect(shouldAbortOAuthOperation('cancelled', true, true)).toBe(true)
    expect(shouldAbortOAuthOperation('pending', true, true)).toBe(false)
  })
})

/**
 * UB14.26 — the card on v0.15.1's decision material. A finished request is upstream's `AuthOutcome`
 * (a tinted block, no actions); a pending one is a standalone `DecisionCard` with the sign-in primary,
 * and while the browser sign-in runs, the restart (v0.15.1) beside OUR cancel.
 */
describe('AuthRequestCard OAuth on the decision material (UB14.26)', () => {
  test('POSITIVE — a completed OAuth card is the success outcome: signed in as, the workspace, no action', () => {
    const done = message('completed')
    done.authEmail = 'user@example.test'
    done.authWorkspace = 'Platform Team'
    const html = renderCard(done)

    expect(html).toContain('GitLab TCS Connected')
    expect(html).toContain('Signed in as user@example.test')
    expect(html).toContain('Workspace: Platform Team')
    expect(html).toContain('bg-success-tint')
    expect(html).not.toContain('data-decision-tone')
    expect(html).not.toContain('<button')

    // The compact twin (after the next message) keeps the outcome and the email, sized to its content.
    const compact = renderCard(done, { isInteractive: false })
    expect(compact).toContain('Signed in as user@example.test')
    expect(compact).toContain('w-fit')
  })

  test('POSITIVE — a pending OAuth card is the info decision card with the provider on its sign-in button', () => {
    const html = renderCard(message('pending'))
    expect(html).toContain('data-decision-tone="info"')
    expect(html).toContain('rounded-xl bg-raised shadow-elev-2') // standalone: the card draws its own material
    expect(html).toContain('GitLab TCS OAuth')
    expect(html).toContain('data-tutorial="oauth-sign-in-button"')

    const google = message('pending')
    google.authRequestType = 'oauth-google'
    const googleHtml = renderCard(google)
    expect(googleHtml).toContain('GitLab TCS Google Sign-In')
    expect(googleHtml).toContain('Sign in with Google')
  })

  test('POSITIVE — while the browser sign-in runs: the restart and our cancel, both enabled, no sign-in button', () => {
    const html = renderCard(message('pending'), { initialAttempt: { submitting: true } })
    expect(html).toContain('GitLab TCS Authenticating...')
    expect(html).toContain('Complete authentication in your browser')
    for (const label of ['Restart sign-in', 'Cancel']) {
      const at = html.indexOf(`${label}</button>`)
      expect({ label, found: at > -1 }).toEqual({ label, found: true })
      const tag = html.slice(html.lastIndexOf('<button', at), html.indexOf('>', html.lastIndexOf('<button', at)) + 1)
      // The ATTRIBUTE (`disabled=""`): every button's class carries `disabled:` variants.
      expect({ label, disabled: tag.includes('disabled=""') }).toEqual({ label, disabled: false })
    }
    expect(html).not.toContain('Sign in with OAuth')
  })

  test('NEGATIVE (control) — no Slack or Microsoft title ever renders, not even for a type the union lacks', () => {
    for (const type of ['oauth-slack', 'oauth-microsoft']) {
      const foreign = message('pending')
      foreign.authRequestType = type as Message['authRequestType']
      foreign.authSourceName = 'Team Chat'
      const html = renderCard(foreign)
      expect({ type, slack: html.includes('Slack'), microsoft: html.includes('Microsoft') })
        .toEqual({ type, slack: false, microsoft: false })
      // Upstream's default arms: the generic title and the generic provider.
      expect(html).toContain('Team Chat Authentication')
      expect(html).toContain('Sign in with OAuth')
    }
  })
})

/**
 * The live 2026-08-01 failure: the model offered a `figma` OAuth card, the card
 * sent a bare `sourceSlug`, and `oauth:start` looked for a Source that does not
 * exist. `figma` is a plugin-owned MCP server; its only route is `pluginServer`.
 *
 * The requirement shape below is exactly what `derivePluginMcpAuthRequirements`
 * produces from the installed Figma manifest — its `mcp` capability carries
 * `authType: 'oauth'` with a remote URL, so the server name lands in an `oauth`
 * requirement with `ON_FIRST_USE` timing.
 */
const FIGMA_PLUGIN_KEY = 'cmVnaXN0cnktNjEzNWNjYTM.ZmlnbWE'

function plugins(...requirements: SafePluginMcpAuthRequirement[]) {
  return [{ pluginKey: FIGMA_PLUGIN_KEY, authRequirements: requirements }]
}

const figmaOAuth: SafePluginMcpAuthRequirement = {
  kind: 'oauth',
  connectorIds: ['mcp.connector_68df038e.figma'],
  serverNames: ['figma'],
  timing: 'ON_FIRST_USE',
}

function cardRequest(sourceSlug: string, installedPlugins?: ReturnType<typeof plugins>) {
  return buildOAuthCardRequest({
    sourceSlug,
    sessionId: 'session-oauth',
    authRequestId: 'request-oauth',
    ...(installedPlugins ? { installedPlugins } : {}),
  })
}

describe('AuthRequestCard OAuth target resolution', () => {
  test('a plugin-owned MCP server resolves to its pluginServer target', () => {
    expect(cardRequest('figma', plugins(figmaOAuth))).toEqual({
      sourceSlug: 'figma',
      sessionId: 'session-oauth',
      authRequestId: 'request-oauth',
      pluginServer: { pluginKey: FIGMA_PLUGIN_KEY, serverName: 'figma' },
    })
  })

  test('a plain source keeps the bare sourceSlug shape', () => {
    // Both arms of the negative: no catalog at all, and a catalog that simply
    // does not declare this name.
    for (const installed of [undefined, plugins(figmaOAuth)]) {
      expect(cardRequest('gitlab', installed)).toEqual({
        sourceSlug: 'gitlab',
        sessionId: 'session-oauth',
        authRequestId: 'request-oauth',
      })
    }
  })

  test('a non-OAuth plugin server is not routed through the OAuth flow', () => {
    const notOAuth: SafePluginMcpAuthRequirement[] = [
      { kind: 'bearer', connectorIds: ['c'], serverNames: ['billing'], timing: 'ON_FIRST_USE' },
      { kind: 'dp', capabilityIds: ['c'], serverNames: ['tracker'], sharedProvider: 'dp', timing: 'ON_FIRST_USE' },
      { kind: 'environment', capabilityIds: ['c'], serverNames: ['envsrv'], requiredNames: ['TOKEN'] },
    ]
    for (const name of ['billing', 'tracker', 'envsrv']) {
      expect(cardRequest(name, plugins(...notOAuth))).not.toHaveProperty('pluginServer')
    }
  })

  test('the payload that crosses the wire carries pluginServer, not sourceSlug', async () => {
    const starts: Record<string, unknown>[] = []
    const deps: OAuthOrchestrationDeps = {
      createCallbackServer: async () => ({
        url: 'http://localhost:6477',
        close: () => {},
        promise: Promise.resolve({ query: { code: 'authorization-code' } }),
      }),
      openExternal: async () => {},
      invoke: async (channel, request) => {
        if (channel === RPC_CHANNELS.oauth.START) {
          starts.push(request)
          return { authUrl: 'https://auth.example.test', flowId: 'f', state: 's' }
        }
        if (channel === RPC_CHANNELS.oauth.COMPLETE) return { success: true }
        throw new Error(`unexpected channel ${channel}`)
      },
    }

    // What `handleOAuthClick` hands to `performOAuth`, run through the same
    // preload orchestration the click reaches.
    await createOAuthOperation(deps, cardRequest('figma', plugins(figmaOAuth))).result
    await createOAuthOperation(deps, cardRequest('gitlab', plugins(figmaOAuth))).result

    expect(starts[0]).toHaveProperty('pluginServer', {
      pluginKey: FIGMA_PLUGIN_KEY,
      serverName: 'figma',
    })
    expect(starts[0]).not.toHaveProperty('sourceSlug')
    expect(starts[1]).toHaveProperty('sourceSlug', 'gitlab')
    expect(starts[1]).not.toHaveProperty('pluginServer')
  })
})
