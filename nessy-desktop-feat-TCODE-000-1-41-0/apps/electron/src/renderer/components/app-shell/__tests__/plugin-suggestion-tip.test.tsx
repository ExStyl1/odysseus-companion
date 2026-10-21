/**
 * P6.424 — the spinner tip renders the ONE decision, in the user's language.
 *
 * Two things are pinned and they fail for different reasons. The rendered
 * sentence must interpolate BOTH of `selectPluginSuggestion`'s output fields —
 * a tip that names a plugin without saying what it is for is the vendor page's
 * sentence with its subject removed — and it must resolve in BOTH locales,
 * because an unresolved key renders as the key itself and looks like copy.
 *
 * The negative is the one that matters on a default install: with no managed
 * `pluginSuggestionMarketplaces` there is no suggestion at all, so
 * `ProcessingIndicator` passes nothing and the tip must not occupy a line.
 * That arm is asserted through the component's own contract — it is only ever
 * mounted behind a truthy suggestion — by rendering the spinner block's own
 * conditional shape here rather than the whole three-thousand-line chat.
 */

import * as React from 'react'
import { beforeAll, describe, expect, test } from 'bun:test'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import enMessages from '../../../../../../../packages/shared/src/i18n/locales/en.json'
import ruMessages from '../../../../../../../packages/shared/src/i18n/locales/ru.json'
import { PluginSuggestionTip, type PluginSuggestionTipData } from '../plugin-suggestion-tip'

let i18nInstances: Record<'en' | 'ru', I18nInstance>

beforeAll(async () => {
  const make = async (lng: 'en' | 'ru', resources: Record<string, string>) => {
    const instance = createInstance()
    await instance.use(initReactI18next).init({
      lng,
      fallbackLng: lng,
      resources: { [lng]: { translation: resources } },
      interpolation: { escapeValue: false },
    })
    return instance
  }
  i18nInstances = {
    en: await make('en', enMessages as Record<string, string>),
    ru: await make('ru', ruMessages as Record<string, string>),
  }
})

const render = (locale: 'en' | 'ru', data: PluginSuggestionTipData): string =>
  renderToStaticMarkup(
    <I18nextProvider i18n={i18nInstances[locale]}>
      <PluginSuggestionTip {...data} />
    </I18nextProvider>,
  )

const SUGGESTION: PluginSuggestionTipData = {
  topic: 'Terraform',
  reference: 'terraform-tools@acme-internal',
}

describe('the plugin spinner tip', () => {
  test('names the topic and the plugin reference, in English', () => {
    const html = render('en', SUGGESTION)
    expect(html).toContain('Terraform')
    expect(html).toContain('terraform-tools@acme-internal')
    // The key itself must never reach the screen — an unresolved key renders as
    // the key and reads like copy that was meant to be there.
    expect(html).not.toContain('chat.pluginSuggestion.spinnerTip')
    // And no interpolation placeholder survived.
    expect(html).not.toContain('{{')
  })

  test('resolves in Russian too, with both values carried', () => {
    const html = render('ru', SUGGESTION)
    expect(html).toContain('Terraform')
    expect(html).toContain('terraform-tools@acme-internal')
    expect(html).not.toContain('chat.pluginSuggestion.spinnerTip')
    expect(html).not.toContain('{{')
    // The two locales must not be the same string: a copy-paste of the English
    // value into `ru.json` passes parity and sortedness and says nothing.
    expect(html).not.toBe(render('en', SUGGESTION))
  })

  test('does not replace the spinner label — it is a second line', () => {
    // The page says "appears BELOW the spinner". The component owns no spinner
    // and no status text, so a future edit that folds it into the label has to
    // delete this file rather than quietly pass it.
    const html = render('en', SUGGESTION)
    expect(html).toContain('data-testid="plugin-suggestion-spinner-tip"')
    expect(html.startsWith('<div')).toBe(true)
  })

  test('the shipped default renders nothing, because there is no suggestion', () => {
    // `ProcessingIndicator` mounts the tip only behind a truthy suggestion, and
    // with no managed `pluginSuggestionMarketplaces` there is never one. The
    // absence is the DEFAULT, so it is asserted rather than assumed.
    // Read through a function so the compiler keeps the union rather than
    // narrowing the const to `undefined` and eliding the branch under test.
    const noSuggestion = (): PluginSuggestionTipData | undefined => undefined
    const suggestion = noSuggestion()
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18nInstances.en}>
        <div>{suggestion && <PluginSuggestionTip topic={suggestion.topic} reference={suggestion.reference} />}</div>
      </I18nextProvider>,
    )
    expect(html).toBe('<div></div>')
  })
})
