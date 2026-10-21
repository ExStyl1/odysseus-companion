/**
 * UB1.15 (B3-14) — Cancelling a credential prompt must never submit the typed
 * credential.
 *
 * The defect, measured at HEAD before the fix: the card's Save and Cancel
 * buttons are OUR `Button` with no `type`, and `ui/button.tsx` sets none, so
 * inside the card's 1Password wrapper `<form onSubmit={handleFormSubmit}
 * method="post">` HTML makes BOTH buttons submits. A Cancel click ran
 * `handleCancel` — one `{cancelled:true}` response — and then the browser's
 * default action submitted the form, so `handleFormSubmit` → `handleSubmit`
 * sent the typed credential as a SECOND response with `cancelled:false`. The
 * server's `claimAuthRequest` clears the pending request synchronously
 * (`SessionManager.ts`, the `pendingAuthRequestId = undefined` clear), so the
 * second response is usually not stored — but the secret already crossed the
 * wire to the server.
 *
 * The fix: Cancel `type="button"` (v0.15.0's change and its comment), Save
 * `type="submit"` with NO onClick — one submit path.
 *
 * The runner has no DOM (no happy-dom/jsdom/testing-library in this repo; the
 * convention `ModelCatalogPicker.test.tsx` calls "its honest equivalent"), so
 * this file reproduces the FORM SEMANTICS on the real component instead:
 *
 * - `mock.module` on `react/jsx-dev-runtime` (and its prod twin) wraps the jsx
 *   factories to CAPTURE the real props of every `form`/`button` element the
 *   render creates, delegating unchanged (spread + restore, per the
 *   `claude-gateway-adapter.test.ts` recipe);
 * - `mock.module` on `react` wraps `useState` so the `''`-initialised
 *   credential states render with the fixture value a keystroke would have
 *   produced — the runner cannot type into a static render;
 * - the click dispatcher encodes the HTML default-button rule once: a click
 *   runs the button's own onClick (if any), then submits the form ONLY when
 *   the button's effective type is `submit` (an absent `type` IS `submit` —
 *   exactly what `ui/button.tsx` never set) — so the call COUNT fails on a
 *   regression of the attribute, the onClick, or the form wiring alike.
 *
 * The dispatched handlers are the card's own; nothing is stubbed except the
 * state a keystroke would have set.
 */
import * as React from 'react'
import * as JsxDevRuntime from 'react/jsx-dev-runtime'
import * as JsxRuntime from 'react/jsx-runtime'
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CredentialResponse, Message } from '../../../shared/types'

// -- Snapshots BEFORE mocking; the afterAll restores from these, never from the
// live namespaces (mock.module mutates them in place). -----------------------
const realJsxDev: Record<string, unknown> = { ...JsxDevRuntime }
const realJsx: Record<string, unknown> = { ...JsxRuntime }
const realReact: Record<string, unknown> = { ...React }

type CapturedElement = { tag: string; props: Record<string, unknown> }
const captured: CapturedElement[] = []

function captureJsx(real: (...args: unknown[]) => unknown) {
  return (...args: unknown[]) => {
    const tag = args[0]
    const props = args[1]
    if ((tag === 'form' || tag === 'button') && props && typeof props === 'object') {
      captured.push({ tag: tag as string, props: { ...(props as Record<string, unknown>) } })
    }
    return real(...args)
  }
}

// Every module here was already loaded by this file's imports, so per the
// measured load-order semantics (F1.561, `scripts/mock-module-load-order.test.ts`
// case A) each stub applies IN PLACE: every importer — this render included —
// sees the listed names wrapped and everything else real.
mock.module('react/jsx-dev-runtime', () => ({
  ...realJsxDev,
  jsx: captureJsx(realJsxDev.jsx as (...args: unknown[]) => unknown),
  jsxs: captureJsx(realJsxDev.jsxs as (...args: unknown[]) => unknown),
  jsxDEV: captureJsx(realJsxDev.jsxDEV as (...args: unknown[]) => unknown),
  jsxsDEV: captureJsx(realJsxDev.jsxsDEV as (...args: unknown[]) => unknown),
}))
mock.module('react/jsx-runtime', () => ({
  ...realJsx,
  jsx: captureJsx(realJsx.jsx as (...args: unknown[]) => unknown),
  jsxs: captureJsx(realJsx.jsxs as (...args: unknown[]) => unknown),
}))
// The three credential states are the `''`-initialised ones (value, username,
// password); seeding them is what "type a value" reduces to without a DOM.
const FIXTURE_VALUE = 'ub1-15-fixture-value'
const realUseState = React.useState
mock.module('react', () => ({
  ...realReact,
  useState: (init: unknown) => realUseState(init === '' ? FIXTURE_VALUE : init),
}))

afterAll(() => {
  mock.module('react/jsx-dev-runtime', () => realJsxDev)
  mock.module('react/jsx-runtime', () => realJsx)
  mock.module('react', () => realReact)
})

let testI18n: I18nInstance

beforeAll(async () => {
  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: {} } },
    interpolation: { escapeValue: false },
  })
})

const { AuthRequestCard } = await import('./AuthRequestCard')

function credentialMessage(): Message {
  return {
    id: 'auth-cred',
    role: 'auth-request',
    content: 'Authentication required',
    timestamp: 1,
    authRequestId: 'request-cred',
    authRequestType: 'credential',
    authSourceSlug: 'github',
    authSourceName: 'GitHub',
    authStatus: 'pending',
  }
}

const responses: CredentialResponse[] = []

function renderCard(): string {
  captured.length = 0
  responses.length = 0
  return renderToStaticMarkup(
    <I18nextProvider i18n={testI18n}>
      <AuthRequestCard
        message={credentialMessage()}
        sessionId="session-cred"
        onRespondToCredential={(_sessionId, _requestId, response) => responses.push(response)}
      />
    </I18nextProvider>,
  )
}

function childText(props: Record<string, unknown>): string {
  const out: string[] = []
  const walk = (node: unknown): void => {
    if (typeof node === 'string') out.push(node)
    else if (Array.isArray(node)) node.forEach(walk)
  }
  walk(props.children)
  return out.join(' ')
}

/** The captured button whose label resolves to `labelKey` through i18n. */
function capturedButton(labelKey: string): Record<string, unknown> {
  const hit = captured.find(el => el.tag === 'button' && childText(el.props) === labelKey)
  expect(hit).toBeDefined()
  return hit!.props
}

function capturedForm(): Record<string, unknown> {
  const hit = captured.find(el => el.tag === 'form')
  expect(hit).toBeDefined()
  return hit!.props
}

/** The `<button …>` opening tag that precedes `labelKey` in the markup. */
function buttonOpenTag(html: string, labelKey: string): string {
  const labelAt = html.indexOf(labelKey)
  expect(labelAt).toBeGreaterThan(-1)
  const tagStart = html.lastIndexOf('<button', labelAt)
  expect(tagStart).toBeGreaterThan(-1)
  return html.slice(tagStart, html.indexOf('>', tagStart) + 1)
}

/**
 * The browser's default-button rule, stated once: a click on a button inside a
 * form runs the button's onClick, then dispatches the form's `submit` only
 * when the button's effective type is `submit`.
 */
function clickButtonInForm(button: Record<string, unknown>): void {
  ;(button.onClick as (() => void) | undefined)?.()
  const effectiveType = (button.type as string | undefined) ?? 'submit'
  if (effectiveType === 'submit') {
    ;(capturedForm().onSubmit as ((e: { preventDefault(): void }) => void) | undefined)?.({
      preventDefault: () => {},
    })
  }
}

describe('UB1.15 — the credential form answers exactly once', () => {
  test('control: Save submits once, carrying the typed value', () => {
    const html = renderCard()

    const save = capturedButton('common.save')
    clickButtonInForm(save)

    expect(responses).toHaveLength(1)
    expect(responses[0]).toEqual({ type: 'credential', value: FIXTURE_VALUE, cancelled: false })

    // The rendered contract the browser acts on: the form wrapper, and Save as
    // its one submit button. One submit path — the button itself carries NO
    // click handler, so a Save click reaches the response only through the
    // form's submit.
    expect(html).toContain('<form')
    expect(html).toContain('method="post"')
    expect(buttonOpenTag(html, 'common.save')).toContain('type="submit"')
    expect(save.type).toBe('submit')
    expect(save.onClick).toBeUndefined()
  })

  test('Cancel answers once, cancelled, and never with the typed value', () => {
    const html = renderCard()

    const cancel = capturedButton('common.cancel')
    clickButtonInForm(cancel)

    expect(responses).toHaveLength(1)
    expect(responses[0]).toEqual({ type: 'credential', cancelled: true })
    // No value of any shape rides along with the cancellation.
    expect('value' in responses[0]).toBe(false)
    expect('username' in responses[0]).toBe(false)
    expect('password' in responses[0]).toBe(false)
    expect('headers' in responses[0]).toBe(false)

    // The rendered contract: Cancel must not be a submit inside the form.
    expect(buttonOpenTag(html, 'common.cancel')).toContain('type="button"')
    expect(cancel.type).toBe('button')
    expect(cancel.onClick).toBeDefined()
  })
})
