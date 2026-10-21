/**
 * P6.447 — the connection pane, INSIDE the settings-provenance view.
 *
 * The row's own sequencing rule is that it "must not open a competing page", so
 * the assertion that matters most here is a NEGATIVE one: the pane rides the
 * channel P6.168 already owns and no second channel was minted for it.
 *
 * `bun test` has no DOM in this repo, so the wiring is pinned by source match —
 * the instrument `config-doctor-settings-surface.test.ts` uses beside it, and
 * for the same reason: importing the component drags in the `@nessy-agent/ui`
 * barrel for no gain.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'
import en from '@nessy-agent/shared/i18n/locales/en.json'
import ru from '@nessy-agent/shared/i18n/locales/ru.json'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol/channels'

const section = readFileSync(
  fileURLToPath(new URL('../SettingsProvenanceSection.tsx', import.meta.url)),
  'utf8',
)

const CONNECTION_KEYS = [
  'settings.provenance.connectionTitle',
  'settings.provenance.connectionScopeNote',
  'settings.provenance.connectionGateway',
  'settings.provenance.connectionByo',
  'settings.provenance.connectionProvider',
  'settings.provenance.connectionBaseUrl',
  'settings.provenance.connectionCredential',
  'settings.provenance.connectionProxy',
  'settings.provenance.connectionProxyNone',
  'settings.provenance.connectionNone',
] as const

describe('the connection pane (P6.447)', () => {
  it('names all four facts and renders the gateway and BYO cases differently', () => {
    expect(section).toContain('ConnectionPane')
    for (const key of CONNECTION_KEYS) expect(section).toContain(key)
    // The distinction is the row's requirement, so it must be a BRANCH and not
    // one sentence covering both: a user who cannot tell a BYO endpoint from the
    // verified gateway cannot reason about where their key is going.
    expect(section).toContain('connection.verifiedGateway')
    expect(section).toContain('connection-byo')
  })

  it('opens no competing page — it rides the channel P6.168 already owns', () => {
    expect(section).toContain('getSettingsProvenance')
    // The negative: no second channel was minted for this pane.
    const otherChannels = Object.values(RPC_CHANNELS.settings)
      .filter(channel => channel !== RPC_CHANNELS.settings.GET_PROVENANCE)
    for (const channel of otherChannels) expect(section).not.toContain(channel)
  })

  it('has every key in both locales — the six credential values included', () => {
    const credentialKeys = [
      'settings.provenance.connectionCredentialStoredKey',
      'settings.provenance.connectionCredentialStoredOauth',
      'settings.provenance.connectionCredentialStoredToken',
      'settings.provenance.connectionCredentialEnvironment',
      'settings.provenance.connectionCredentialPlatform',
      'settings.provenance.connectionCredentialNone',
    ]
    // Bracket access, not `toHaveProperty`: these keys CONTAIN dots and
    // `toHaveProperty` reads a dot as a path segment, so it looks for a nested
    // object that does not exist and fails on keys that are present.
    const enKeys = en as Record<string, string>
    const ruKeys = ru as Record<string, string>
    for (const key of [...CONNECTION_KEYS, ...credentialKeys]) {
      expect(typeof enKeys[key]).toBe('string')
      expect(typeof ruKeys[key]).toBe('string')
    }
  })
})
