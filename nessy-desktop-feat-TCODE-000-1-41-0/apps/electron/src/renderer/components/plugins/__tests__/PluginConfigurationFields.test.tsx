/**
 * D15 — the user is asked before they are broken.
 *
 * `plugins/manifest-reference.md#user-configuration` makes `title` "Label shown in the configuration
 * dialog" and `:570` makes `description` "Help text shown beneath the field";
 * both are REQUIRED fields of an option declaration, both were imported by the
 * adapter, and neither was ever rendered — every field was labelled with its raw
 * key. `:571` — a sensitive option "masks input and stores the value in secure
 * storage"; masking used to key off MCPB's `secret-ref` spelling alone, so a
 * Claude `{"type": "string", "sensitive": true}` token rendered as plain text.
 *
 * Rendered to static markup, so every assertion about a value is an assertion
 * about what a user (or a DOM inspector) can actually see.
 */

import * as React from 'react'
import { beforeAll, describe, expect, it } from 'bun:test'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  PluginConfigurationFields,
  configurationFieldLabel,
  isSensitiveConfigurationField,
  pluginConfigurationValues,
} from '@/components/plugins/PluginConfigurationFields'
import type { SafePluginConfigurationFieldStatus } from '@nessy-agent/shared/protocol/capabilities'

const KEYS = [
  'pluginDetail.configurationRequiredMark',
  'pluginDetail.configurationConfigured',
  'pluginDetail.configurationSetBoolean',
  'pluginDetail.configurationConfiguredPlaceholder',
  'pluginDetail.configurationDefaultPlaceholder',
  'pluginDetail.configurationMissing',
  'pluginDetail.configurationOptional',
]

let testI18n: I18nInstance

beforeAll(async () => {
  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: Object.fromEntries(KEYS.map(key => [key, key])) } },
    interpolation: { escapeValue: false },
  })
})

const SECRET: SafePluginConfigurationFieldStatus = {
  key: 'api_token',
  valueType: 'string',
  required: true,
  hasDefault: false,
  configured: false,
  missing: true,
  sensitive: true,
  title: 'API token',
  description: 'API authentication token',
}

const PLAIN: SafePluginConfigurationFieldStatus = {
  key: 'api_endpoint',
  valueType: 'string',
  required: true,
  hasDefault: false,
  configured: false,
  missing: true,
  sensitive: false,
  title: 'API endpoint',
  description: "Your team's API endpoint",
}

function render(fields: SafePluginConfigurationFieldStatus[], draft: Record<string, string | boolean> = {}) {
  return renderToStaticMarkup(
    <I18nextProvider i18n={testI18n}>
      <PluginConfigurationFields fields={fields} draft={draft} onDraftChange={() => {}} />
    </I18nextProvider>,
  )
}

describe('the imported title and description are rendered', () => {
  it('labels the field by its imported title and shows the description beneath', () => {
    const markup = render([PLAIN])
    expect(markup).toContain('API endpoint')
    expect(markup).toContain("Your team&#x27;s API endpoint")
  })

  it('falls back to the raw key only when the bundle omitted the title', () => {
    const { title: _title, description: _description, ...untitled } = PLAIN
    const markup = render([untitled])
    expect(markup).toContain('api_endpoint')
    expect(markup).not.toContain("Your team")
  })

  it('exposes the same label decision as one function, so the prompt cannot disagree', () => {
    expect(configurationFieldLabel(PLAIN)).toBe('API endpoint')
    const { title: _title, ...untitled } = PLAIN
    expect(configurationFieldLabel(untitled)).toBe('api_endpoint')
  })
})

describe('a secret field stays masked', () => {
  it('masks a sensitive field whichever spelling declared it', () => {
    // Claude's spelling: `{"type": "string", "sensitive": true}`.
    expect(render([SECRET])).toContain('type="password"')
    // MCPB's spelling: the `secret-ref` value type.
    expect(isSensitiveConfigurationField({ ...PLAIN, valueType: 'secret-ref' })).toBe(true)
    expect(isSensitiveConfigurationField(PLAIN)).toBe(false)
  })

  it('renders a non-sensitive field as plain text, so masking is a decision and not a default', () => {
    expect(render([PLAIN])).toContain('type="text"')
  })

  it('echoes a typed secret nowhere except the masked input it was typed into', () => {
    // A controlled input necessarily holds what the user typed — that is true
    // of every password field on the web and is not something a component can
    // prevent. What IS preventable is the value appearing a SECOND time, in a
    // title, an aria-label, a data-* hook or the help text, where a screenshot
    // or an accessibility tree would carry it. Strip the one legitimate
    // occurrence and assert on everything else.
    const markup = render([SECRET], { api_token: 'TYPED_SECRET_CANARY' })
    expect(markup.replace('value="TYPED_SECRET_CANARY"', '')).not.toContain('TYPED_SECRET_CANARY')
    // And it is masked where it does appear.
    expect(markup).toContain('type="password"')
  })

  it('carries no configured value across the boundary at all', () => {
    // `SafePluginConfigurationFieldStatus` is value-free by construction: a
    // configured field says so and shows a placeholder, never the value.
    const markup = render([{ ...SECRET, configured: true, missing: false }])
    expect(markup).toContain('pluginDetail.configurationConfiguredPlaceholder')
  })
})

describe('the draft becomes the one-way configure payload', () => {
  it('drops blanks so an untouched masked field keeps its stored value', () => {
    expect(pluginConfigurationValues([SECRET, PLAIN], {
      api_token: '',
      api_endpoint: 'https://internal.example.invalid',
    })).toEqual({ api_endpoint: 'https://internal.example.invalid' })
  })

  it('coerces a number field, so the stored value round-trips to the substitution site as a number', () => {
    const timeout: SafePluginConfigurationFieldStatus = {
      key: 'timeout', valueType: 'number', required: false, hasDefault: true,
      configured: false, missing: false, sensitive: false,
    }
    expect(pluginConfigurationValues([timeout], { timeout: '30' })).toEqual({ timeout: 30 })
  })
})
