/**
 * UB14.23 — the credential card on v0.15.1's decision anatomy (`structured/CredentialRequest.tsx`), with OUR
 * i18n re-applied where upstream still ships English.
 *
 * Instruments, both without a DOM (this repo ships none):
 * - `renderToStaticMarkup` with the REAL en/ru bundles for what the card draws and says;
 * - the ELEMENT TREE the component returns, captured by calling it inside a probe component's render (its
 *   hooks run as the probe's), so the handlers it wires are its own functions we can call — "Escape answers
 *   cancelled with no value" is asserted by pressing, not by reading source (the UB14.28 recipe).
 *
 * Positive: Save is the form's one submit path (`type="submit"`, no onClick) and Cancel is `type="button"`
 * (UB1.15's invariant, already true here before v0.15.0), both inside `DecisionActions`; the reveal toggle is
 * named by upstream's keys. Negative (control): Escape and Cancel each answer exactly once with
 * `{type:'credential', cancelled:true}` and no value field; Enter on an empty field answers nothing.
 */
import * as React from 'react'
import { beforeAll, describe, expect, it } from 'bun:test'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import enMessages from '../../../../../../../../../packages/shared/src/i18n/locales/en.json'
import ruMessages from '../../../../../../../../../packages/shared/src/i18n/locales/ru.json'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { CredentialRequest as CredentialRequestType, CredentialResponse } from '../../../../../../shared/types'
import { CredentialRequest } from '../CredentialRequest'
import { DecisionActions, DecisionFoot } from '../DecisionCard'

const instances: Partial<Record<'en' | 'ru', I18nInstance>> = {}

beforeAll(async () => {
  for (const lng of ['en', 'ru'] as const) {
    const instance = createInstance()
    await instance.use(initReactI18next).init({
      lng,
      fallbackLng: 'en',
      resources: { en: { translation: enMessages }, ru: { translation: ruMessages } },
      interpolation: { escapeValue: false },
    })
    instances[lng] = instance
  }
})

const HEADER_REQUEST: CredentialRequestType = {
  type: 'credential',
  requestId: 'cred-1',
  sessionId: 'session-1',
  sourceSlug: 'linear-api',
  sourceName: 'Linear',
  mode: 'header',
  headerName: 'Authorization',
  labels: { credential: 'API Key' },
  description: 'Paste a personal API key.',
  hint: 'Settings → API',
  sourceUrl: 'https://linear.app',
}

const BASIC_REQUEST: CredentialRequestType = {
  ...HEADER_REQUEST,
  requestId: 'cred-2',
  mode: 'basic',
  headerName: undefined,
  labels: undefined,
  passwordRequired: false,
}

type Props = React.ComponentProps<typeof CredentialRequest>

function wrap(lng: 'en' | 'ru', node: React.ReactNode): React.ReactElement {
  return <I18nextProvider i18n={instances[lng]!}>{node}</I18nextProvider>
}

const render = (props: Props, lng: 'en' | 'ru' = 'en') => renderToStaticMarkup(wrap(lng, <CredentialRequest {...props} />))

/** The markup's visible text: tags dropped, the entities the copy uses decoded. */
function visibleText(markup: string): string {
  return markup.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()
}

/** The element tree `CredentialRequest` returns for these props (its hooks run inside the probe's render). */
function treeOf(props: Props): React.ReactNode {
  let tree: React.ReactNode = null
  function Probe() {
    tree = CredentialRequest(props)
    return null
  }
  renderToStaticMarkup(wrap('en', <Probe />))
  return tree
}

type Element = React.ReactElement<Record<string, unknown>>

function findAll(node: React.ReactNode, match: (el: Element) => boolean, out: Element[] = []): Element[] {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, match, out)
    return out
  }
  if (!React.isValidElement<Record<string, unknown>>(node)) return out
  if (match(node)) out.push(node)
  findAll(node.props.children as React.ReactNode, match, out)
  return out
}

function only(node: React.ReactNode, match: (el: Element) => boolean): Element {
  const found = findAll(node, match)
  expect(found).toHaveLength(1)
  return found[0]!
}

function recorder() {
  const calls: CredentialResponse[] = []
  return { calls, onResponse: (response: CredentialResponse) => { calls.push(response) } }
}

describe('UB14.23 · the credential card on the decision anatomy', () => {
  it('POSITIVE — Save is the one submit path and Cancel is a plain button, both inside DecisionActions', () => {
    const { onResponse } = recorder()
    const tree = treeOf({ request: HEADER_REQUEST, onResponse })
    const actions = only(tree, el => el.type === DecisionActions)
    const buttons = findAll(actions, el => el.type === Button)
    expect(buttons.map(el => [el.props.type, el.props.variant])).toEqual([['submit', 'primary'], ['button', 'ghost']])
    const [save, cancel] = buttons as [Element, Element]
    // One submit path: the form's onSubmit, never a click handler on Save as well (UB1.15).
    expect(save.props.onClick).toBeUndefined()
    expect(save.props.disabled).toBe(true) // nothing typed yet
    expect(typeof cancel.props.onClick).toBe('function')
    // No Button lives outside the actions row.
    expect(findAll(tree, el => el.type === Button)).toHaveLength(2)
    const form = only(tree, el => el.type === 'form')
    expect(form.props.action).toBe(HEADER_REQUEST.sourceUrl)
  })

  it('POSITIVE — the card draws the anatomy in its own language: info tile, translated actions and foot, a named reveal toggle', () => {
    const en = render({ request: HEADER_REQUEST, onResponse: () => {} })
    expect(en).toContain('data-decision-tone="info"')
    expect(en).toContain('bg-info-tint text-info') // the 28px icon tile
    expect(en).toContain('ring-[color:var(--info-border)]') // standalone: the card draws its own ring
    expect(en).toContain(`aria-label="${enMessages['chat.credentials.showValue']}"`)
    const enText = visibleText(en)
    for (const copy of [enMessages['auth.authenticationRequired'], '(Linear)', enMessages['common.save'], enMessages['common.cancel'], enMessages['auth.credentialsEncryptedAtRest'], HEADER_REQUEST.description!, HEADER_REQUEST.hint!, '(Authorization)']) {
      expect({ copy, shown: enText.includes(copy) }).toEqual({ copy, shown: true })
    }
    expect(en).toContain('placeholder="Enter api key"')

    const ru = render({ request: HEADER_REQUEST, onResponse: () => {} }, 'ru')
    expect(ru).toContain(`aria-label="${ruMessages['chat.credentials.showValue']}"`)
    const ruText = visibleText(ru)
    for (const english of ['Save', 'Cancel', 'Credentials are encrypted at rest', 'Authentication Required', 'Show value']) {
      expect({ english, found: (ruText + ru).includes(english) }).toEqual({ english, found: false })
    }
    expect(ruText).toContain(ruMessages['common.save'])
    expect(ruText).toContain(ruMessages['auth.credentialsEncryptedAtRest'])
  })

  it('the foot sits under the actions, and a hosted card (composer slot) draws no material of its own', () => {
    const tree = treeOf({ request: HEADER_REQUEST, onResponse: () => {} })
    const form = only(tree, el => el.type === 'form')
    const order = (form.props.children as React.ReactNode[]).filter(React.isValidElement).map(el => (el as Element).type)
    expect(order.indexOf(DecisionFoot)).toBe(order.indexOf(DecisionActions) + 1)
    const hosted = render({ request: HEADER_REQUEST, onResponse: () => {}, unstyled: true })
    expect(hosted).not.toContain('shadow-elev-2')
    expect(hosted).not.toContain('ring-[color:var(--info-border)]')
  })

  it('basic auth: two fields, the optional password named so, one reveal toggle', () => {
    const tree = treeOf({ request: BASIC_REQUEST, onResponse: () => {} })
    const inputs = findAll(tree, el => el.type === Input)
    expect(inputs.map(el => el.props.name)).toEqual(['username', 'password'])
    expect(inputs.map(el => el.props.autoComplete)).toEqual(['username', 'current-password'])
    const reveal = findAll(tree, el => el.type === 'button')
    expect(reveal).toHaveLength(1)
    expect(reveal[0]!.props.type).toBe('button')
    expect(reveal[0]!.props['aria-label']).toBe(enMessages['chat.credentials.showValue'])
  })

  it('NEGATIVE (control) — Escape answers exactly once, cancelled, carrying no value', () => {
    const { calls, onResponse } = recorder()
    const tree = treeOf({ request: HEADER_REQUEST, onResponse })
    const field = only(tree, el => el.type === Input)
    ;(field.props.onKeyDown as (e: { key: string }) => void)({ key: 'Escape' })
    expect(calls).toEqual([{ type: 'credential', cancelled: true }])
    for (const secret of ['value', 'username', 'password', 'headers'] as const) expect(secret in calls[0]!).toBe(false)
  })

  it('NEGATIVE (control) — Cancel answers exactly once, cancelled; Enter or a submit on an empty field answers nothing', () => {
    const { calls, onResponse } = recorder()
    const tree = treeOf({ request: HEADER_REQUEST, onResponse })
    const cancel = findAll(only(tree, el => el.type === DecisionActions), el => el.type === Button)[1]!
    ;(cancel.props.onClick as () => void)()
    expect(calls).toEqual([{ type: 'credential', cancelled: true }])

    const empty = recorder()
    const emptyTree = treeOf({ request: HEADER_REQUEST, onResponse: empty.onResponse })
    ;(only(emptyTree, el => el.type === Input).props.onKeyDown as (e: { key: string }) => void)({ key: 'Enter' })
    let prevented = 0
    ;(only(emptyTree, el => el.type === 'form').props.onSubmit as (e: { preventDefault: () => void }) => void)({ preventDefault: () => { prevented++ } })
    expect(prevented).toBe(1) // the native post never runs
    expect(empty.calls).toEqual([])
  })
})
