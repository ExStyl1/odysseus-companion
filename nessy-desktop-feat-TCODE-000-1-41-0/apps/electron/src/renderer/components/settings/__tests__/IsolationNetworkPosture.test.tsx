/**
 * The isolation section states the egress posture, and names every configured
 * network entry that binds nothing.
 *
 * R19 (the egress proxy) stays parked — this asserts DISCLOSURE only. Nothing
 * here gates an execution, and the component under test has no path that can.
 *
 * The unenforceable lines are asserted VERBATIM against the resolver's own
 * output rather than against a copy: the whole point of routing them through
 * `resolveSandboxNetworkEnforcement` is that the page cannot say something the
 * supervisor does not do, and a test carrying its own wording would let the two
 * drift without failing.
 */
import * as React from 'react'
import { beforeAll, describe, expect, it } from 'bun:test'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import { resolveSandboxNetworkEnforcement } from '@nessy-agent/shared/config'
import { IsolationNetworkPosture } from '../IsolationNetworkPosture'
import en from '@nessy-agent/shared/i18n/locales/en.json'

let testI18n: I18nInstance

beforeAll(async () => {
  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: en as Record<string, string> } },
    interpolation: { escapeValue: false },
  })
})

function render(props: React.ComponentProps<typeof IsolationNetworkPosture>): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={testI18n}>
      <IsolationNetworkPosture {...props} />
    </I18nextProvider>,
  )
}

/** The posture the report carries, built by the unit the supervisor enforces from. */
function posture(network: Parameters<typeof resolveSandboxNetworkEnforcement>[0]) {
  const enforcement = resolveSandboxNetworkEnforcement(network)
  return {
    egress: enforcement.egress,
    source: enforcement.source,
    unenforceable: enforcement.unenforceable,
  }
}

describe('IsolationNetworkPosture', () => {
  it('says outbound network is unrestricted, and why, on the shipped default', () => {
    const html = render({
      posture: posture({ deniedDomains: [], allowedDomains: [], allowManagedDomainsOnly: false }),
    })
    expect(html).toContain('outbound network')
    expect(html).toContain('Unrestricted')
    expect(html).toContain('can reach any host')
    // Factual, not a bug report: it names the setting that closes it.
    expect(html).toContain('sandbox.network.allowManagedDomainsOnly')
  })

  it("names each deniedDomains entry that is not enforced, in the resolver's own words", () => {
    const network = { deniedDomains: ['*.example.com', 'pastebin.com'], allowedDomains: [], allowManagedDomainsOnly: false }
    const html = render({ posture: posture(network) })
    expect(html).toContain('do not bind a sandboxed command')
    for (const line of resolveSandboxNetworkEnforcement(network).unenforceable) {
      // Rendered text, so only the entity-escaped quotes differ from the source.
      expect(html).toContain(line.replace(/"/g, '&quot;'))
    }
  })

  it('says egress is denied, and names each allowedDomains entry the deny makes unreachable', () => {
    const network = { deniedDomains: [], allowedDomains: ['registry.npmjs.org'], allowManagedDomainsOnly: true }
    const html = render({ posture: posture(network) })
    expect(html).toContain('Denied')
    expect(html).toContain('no sandboxed command can open an outbound connection')
    expect(html).toContain('sandbox.network.allowedDomains &quot;registry.npmjs.org&quot;')
  })

  /**
   * P2.365 — both `…Desc` sentences are correctly scoped to SANDBOXED commands,
   * so neither is the false copy P2.331 closed. With `sandbox.enabled` off
   * there are no sandboxed commands, and a sentence true about an empty
   * category reads as a claim about the session.
   */
  it('says the posture is not in force when the isolation master switch is off', () => {
    const network = { deniedDomains: [], allowedDomains: [], allowManagedDomainsOnly: true }
    const off = render({ posture: posture(network), sandboxEnabled: false })
    // The disclosure still renders — an administrator asking what a profile
    // WOULD grant is the reason this block exists.
    expect(off).toContain('no sandboxed command can open an outbound connection')
    expect(off).toContain('nothing is running under these profiles right now')

    // On, and unreported, both stay silent: `undefined` is "not reported",
    // which is not the same as off.
    for (const sandboxEnabled of [true, undefined]) {
      const html = render({ posture: posture(network), ...(sandboxEnabled === undefined ? {} : { sandboxEnabled }) })
      expect(html).toContain('no sandboxed command can open an outbound connection')
      expect(html).not.toContain('nothing is running under these profiles right now')
    }
  })

  it('renders nothing when the host reported no posture', () => {
    // Absent is "not reported", never "restricted": inventing a line here would
    // tell an administrator the opposite of the truth on a standalone server.
    expect(render({})).toBe('')
  })
})
