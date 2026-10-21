/**
 * T3 (plugin-install plan § 4): install ends in a setup checklist, not
 * silence.
 *
 * The derive half pins the checklist's truth-telling against a
 * nessy-default-extension-shaped install result (9 dp servers, first-use
 * connectors, a missing userConfig value); the render half pins the § 0b-2
 * contract — dp and userConfig actionable, connector rows with NO buttons.
 *
 * Mutation probe: suppressing the checklist (derive returning null for a
 * result that still needs setup) turns the first block red.
 */

import * as React from 'react'
import { beforeAll, describe, expect, it } from 'bun:test'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SafeMarketplacePluginInstallResult } from '@nessy-agent/shared/protocol/capabilities'
import {
  derivePluginSetupChecklist,
  PluginInstallChecklistBody,
  type PluginInstallChecklistState,
} from '../PluginInstallChecklist'

const translations = {
  'pluginChecklist.configure': 'Configure',
  'pluginChecklist.connectorHint': 'No sign-in is needed now — the session notice offers it when a chat starts.',
  'pluginChecklist.connectorRow': '{{server}} will ask to connect when first used.',
  'pluginChecklist.dpError': 'Sign-in failed.',
  'pluginChecklist.dpRow_one': 'Sign in to Developer Platform to unblock {{count}} server.',
  'pluginChecklist.dpRow_other': 'Sign in to Developer Platform to unblock {{count}} servers.',
  'pluginChecklist.dpSignIn': 'Sign in',
  'pluginChecklist.dpSignedIn': 'Signed in',
  'pluginChecklist.dpSigningIn': 'Signing in...',
  'pluginChecklist.environmentRow_one': '{{count}} server needs configuration values ({{names}}).',
  'pluginChecklist.environmentRow_other': '{{count}} servers need configuration values ({{names}}).',
  'pluginChecklist.userConfigRow_one': 'Fill in {{count}} plugin configuration value.',
  'pluginChecklist.userConfigRow_other': 'Fill in {{count}} plugin configuration values.',
}

let testI18n: I18nInstance

beforeAll(async () => {
  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: translations } },
    interpolation: { escapeValue: false },
  })
})

/** The measured shape of a nessy-default-extension install after T1/T2. */
function defaultExtensionResult(): Pick<
  SafeMarketplacePluginInstallResult,
  'ok' | 'pendingAuth' | 'authRequirements' | 'configuration'
> {
  return {
    ok: true,
    authRequirements: [
      {
        kind: 'dp',
        capabilityIds: ['cap-1'],
        serverNames: ['dp-1', 'dp-2', 'dp-3', 'dp-4', 'dp-5', 'dp-6', 'dp-7', 'dp-8', 'dp-9'],
        sharedProvider: 'dp',
        timing: 'ON_FIRST_USE',
      },
      {
        kind: 'oauth',
        connectorIds: ['jira', 'wiki', 'tracker'],
        serverNames: ['jira', 'wiki', 'tracker'],
        timing: 'ON_FIRST_USE',
      },
    ],
    pendingAuth: [
      { workspaceId: 'ws-1', sourceSlug: 'jira', serverName: 'jira', timing: 'ON_FIRST_USE' },
      { workspaceId: 'ws-1', sourceSlug: 'wiki', serverName: 'wiki', timing: 'ON_FIRST_USE' },
      { workspaceId: 'ws-1', sourceSlug: 'tracker', serverName: 'tracker', timing: 'ON_FIRST_USE' },
      // ON_INSTALL. Nothing chained it: `PluginManagementResult.authRequests`
      // is assigned nowhere service-side, so no install-time OAuth has ever
      // run and this server is exactly as unauthenticated as the three above.
      { workspaceId: 'ws-1', sourceSlug: 'chained', serverName: 'chained', timing: 'ON_INSTALL' },
    ],
    configuration: {
      state: 'needs_configuration',
      fields: [
        { key: 'api_token', valueType: 'string', required: true, hasDefault: false, configured: false, missing: true, sensitive: true },
        { key: 'timeout', valueType: 'number', required: false, hasDefault: true, configured: false, missing: false, sensitive: false },
      ],
    },
  }
}

describe('derivePluginSetupChecklist', () => {
  it('reports true counts for a connector-heavy install (the checklist is NOT suppressed)', () => {
    const checklist = derivePluginSetupChecklist(defaultExtensionResult())
    // Mutation probe target: a suppressed checklist returns null here.
    expect(checklist).not.toBeNull()
    expect(checklist!.dp?.serverNames).toHaveLength(9)
    // B6: `chained` is ON_INSTALL and it IS listed. It used to be filtered out
    // on the premise that install-time OAuth had already run for it; that chain
    // does not exist, so the filter hid the one server that most needed naming
    // (figma is exactly this shape). Mutation probe: restore either
    // `timing !== 'ON_INSTALL'` filter and this list loses `chained`.
    expect(checklist!.connectors.map(connector => connector.serverName)).toEqual([
      'chained', 'jira', 'tracker', 'wiki',
    ])
    expect(checklist!.userConfig?.missingCount).toBe(1)
    // 9 dp + 4 connectors, both timings.
    expect(checklist!.serversNeedingSetup).toBe(13)
  })

  it('stays silent when nothing needs setup, and for a failed install', () => {
    expect(derivePluginSetupChecklist({ ok: true })).toBeNull()
    expect(derivePluginSetupChecklist({
      ok: true,
      configuration: { state: 'ready', fields: [] },
    })).toBeNull()
    expect(derivePluginSetupChecklist({ ...defaultExtensionResult(), ok: false })).toBeNull()
  })

  it('falls back to manifest-derived first-use names when no pendingAuth crossed', () => {
    const result = defaultExtensionResult()
    delete result.pendingAuth
    const checklist = derivePluginSetupChecklist(result)
    expect(checklist!.connectors.map(connector => connector.serverName)).toEqual([
      'jira', 'tracker', 'wiki',
    ])
  })
})

function renderBody(state: PluginInstallChecklistState, dpState: 'pending' | 'done' = 'pending'): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={testI18n}>
      <PluginInstallChecklistBody
        state={state}
        dpState={dpState}
        onDpSignIn={() => {}}
        onConfigure={() => {}}
      />
    </I18nextProvider>,
  )
}

describe('PluginInstallChecklistBody', () => {
  const state: PluginInstallChecklistState = {
    pluginKey: 'nessy.default-extension',
    workspaceId: 'ws-1',
    displayName: 'Nessy Default Extension',
    checklist: derivePluginSetupChecklist(defaultExtensionResult())!,
  }

  it('renders the actionable dp and userConfig rows with true counts', () => {
    const html = renderBody(state)
    expect(html).toContain('Sign in to Developer Platform to unblock 9 servers.')
    expect(html).toContain('Fill in 1 plugin configuration value.')
    expect(html).toContain('Configure')
  })

  it('renders connector rows as informational — named, pointed at the notice, and with NO buttons', () => {
    const html = renderBody(state)
    expect(html).toContain('jira will ask to connect when first used.')
    expect(html).toContain('wiki will ask to connect when first used.')
    expect(html).toContain('the session notice offers it when a chat starts')
    // § 0b-2: no per-connector OAuth buttons. The connector section is the
    // last testid block; it must contain no <button>.
    const connectorSection = html.slice(html.indexOf('checklist-connector-rows'))
    expect(connectorSection).not.toContain('<button')
  })

  it('flips the dp row to its signed-in state without an action button', () => {
    const html = renderBody(state, 'done')
    expect(html).toContain('Signed in')
    const dpSection = html.slice(
      html.indexOf('checklist-dp-row'),
      html.indexOf('checklist-config-row'),
    )
    expect(dpSection).not.toContain('<button')
  })
})
