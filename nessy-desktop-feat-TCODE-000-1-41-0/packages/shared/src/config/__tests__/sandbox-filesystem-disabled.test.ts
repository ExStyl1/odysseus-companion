/**
 * `sandbox.filesystem.disabled` (`sandboxing.md#disable-filesystem-isolation`,
 * `#protect-credentials`, `#protected-paths`).
 *
 * Every `sandboxing.md` citation in THIS FILE names the page's own SECTION
 * ANCHOR, not a line number, and every quote was re-measured verbatim against
 * the 2026-08-25 fetch (`curl -s https://code.claude.com/docs/en/sandboxing.md`,
 * HTTP 200, 677 lines, md5 `3538c3dd04b83d8bbaa35d0fad0ccb88`). Numbers are gone
 * because this page's have moved on three consecutive fetches — the whole
 * "Protected paths" section shifted up 14 lines between the 2026-08-23 and
 * 2026-08-25 fetches — so a number is stale before the next reader opens the
 * file, while a section anchor is part of the page's own link contract. No claim
 * is made here about citations to any OTHER page.
 *
 * The four numbers this header used to carry — `:201`, `:317`, `:365`, `:478` —
 * were all dead on the 2026-08-25 fetch: `:201` is `    }`, `:317` is `{`, `:365`
 * is `    "credentials": {`, and `:478` is the network-proxy line.
 *
 * Two things are being proved: that a CONFORMING settings file is accepted at
 * all (it used to be rejected by `assertKnownKeys`), and that the coupling
 * `#protected-paths` documents is stated where the setting is read rather than
 * discovered by an administrator after the fact.
 */
import { describe, expect, it } from 'bun:test'
import {
  parseManagedSandboxSettingsV1,
  resolveSandboxFilesystemConsequences,
  resolveSandboxNetworkEnforcement,
  resolveSandboxSettings,
  type SandboxSettingsV1,
} from '../sandbox-settings.ts'
import { STRICT_DROP_SINK, collectingDropSink, type ManagedPolicyDropV1 } from '../managed-drops.ts'

/**
 * The example `sandboxing.md#disable-filesystem-isolation` writes, verbatim in
 * shape.
 */
const CONFORMING: unknown = {
  filesystem: { disabled: true },
  network: { allowedDomains: ['registry.npmjs.org'], allowManagedDomainsOnly: true },
}

describe('the key is accepted', () => {
  it('no longer rejects a conforming settings file', () => {
    expect(() => parseManagedSandboxSettingsV1(CONFORMING)).not.toThrow()
    expect(parseManagedSandboxSettingsV1(CONFORMING)).toMatchObject({
      filesystem: { disabled: true },
    })
    expect(() => resolveSandboxSettings([parseManagedSandboxSettingsV1(CONFORMING)])).not.toThrow()
  })

  it('still rejects an unknown key inside the sub-block', () => {
    // Only the FIRST of these three is the unknown-key refusal this test's name
    // promises; the other two are a bad value and a bad shape. A shared bare
    // `toThrow()` reported all three as the same gate.
    expect(() => parseManagedSandboxSettingsV1({ filesystem: { enabled: false } }))
      .toThrow('invalid sandbox filesystem setting: enabled')
    expect(() => parseManagedSandboxSettingsV1({ filesystem: { disabled: 'true' } }))
      .toThrow('invalid sandbox filesystem disabled')
    expect(() => parseManagedSandboxSettingsV1({ filesystem: [] }))
      .toThrow('invalid sandbox filesystem settings')
  })

  it('reads a malformed managed value at its enforcing pole, keeping the layer on', () => {
    const drops: ManagedPolicyDropV1[] = []
    const parsed = parseManagedSandboxSettingsV1(
      { filesystem: { disabled: 'yes' } },
      { sink: collectingDropSink('managed', drops) },
    )
    expect(parsed).toMatchObject({ filesystem: { disabled: false } })
    expect(drops.map(drop => drop.disposition)).toContain('tightened')
    expect(STRICT_DROP_SINK.tolerant).toBe(false)
  })
})

describe('resolution', () => {
  const resolve = (layers: readonly SandboxSettingsV1[], floor?: SandboxSettingsV1) =>
    resolveSandboxSettings(layers, floor ? { floor } : {}).filesystem.disabled

  it('is off by default, so nothing changes for anyone who never sets it', () => {
    expect(resolve([])).toBe(false)
    expect(resolve([{ deniedWriteRoots: ['/etc'] }])).toBe(false)
  })

  it('turns off when any layer asks', () => {
    expect(resolve([{}, { filesystem: { disabled: true } }])).toBe(true)
  })

  it('lets an explicit false LOCK the layer on, from the floor or any layer', () => {
    expect(resolve([{ filesystem: { disabled: true } }], { filesystem: { disabled: false } })).toBe(false)
    expect(resolve([{ filesystem: { disabled: false } }, { filesystem: { disabled: true } }])).toBe(false)
  })
})

describe('the coupling `sandboxing.md#protected-paths` documents', () => {
  const settings = resolveSandboxSettings([{
    filesystem: { disabled: true },
    deniedWriteRoots: ['/opt/policy'],
    deniedReadRoots: ['/opt/secrets'],
  }])

  it('says nothing at all while the layer is on', () => {
    expect(resolveSandboxFilesystemConsequences(resolveSandboxSettings([
      { deniedWriteRoots: ['/opt/policy'] },
    ]))).toEqual([])
  })

  it('names the self-config protection the key surrenders', () => {
    const lines = resolveSandboxFilesystemConsequences(settings)
    expect(lines.some(line => line.includes('Self-config protection is SURRENDERED'))).toBe(true)
    // Pins the CITATION FORM in the user-facing consequences line, not just the
    // prose: this string ships to a diagnostics surface, so a dead line number
    // here is a dead pointer handed to an administrator. A section anchor is part
    // of the page's own link contract and does not decay when the page grows.
    expect(lines.some(line => line.includes('sandboxing.md#protected-paths'))).toBe(true)
    // Everything else riding the same deny roots is named too.
    expect(lines.some(line => line.includes('.git/hooks'))).toBe(true)
    expect(lines.some(line => line.includes('sandbox.deniedWriteRoots "/opt/policy"'))).toBe(true)
    expect(lines.some(line => line.includes('sandbox.deniedReadRoots "/opt/secrets"'))).toBe(true)
  })

  // The half this report used to get WRONG. It was written against the intended
  // behaviour — the funnel composed every deny root unconditionally — and said
  // the credential floor died with the layer. `resolveProcessIsolation` keeps the
  // floor (it is composed there, not from a settings file), so the report has to
  // say so, and a settings-file root that IS the floor must not be listed as
  // surrendered.
  it('reports the credential floor as RETAINED, and does not list its roots as surrendered', () => {
    const seeded = resolveSandboxSettings([{
      filesystem: { disabled: true },
      deniedReadRoots: ['/home/probe/.ssh', '/opt/secrets'],
    }])
    const lines = resolveSandboxFilesystemConsequences(seeded, 'linux', {
      credentialFloor: ['/home/probe/.ssh'],
    })
    expect(lines.some(line => line.includes('credential deny floor is RETAINED'))).toBe(true)
    expect(lines.some(line => line.includes('/home/probe/.ssh'))).toBe(false)
    expect(lines.some(line => line.includes('sandbox.deniedReadRoots "/opt/secrets"'))).toBe(true)
    // Stated even with no floor to filter by: it is a product invariant, not a
    // property of what the caller happened to pass.
    expect(resolveSandboxFilesystemConsequences(seeded, 'linux')
      .some(line => line.includes('credential deny floor is RETAINED'))).toBe(true)
  })

  it('keeps network isolation — the whole point of the key', () => {
    // Same layer, filesystem off: the network dimension is untouched.
    const withNetwork = resolveSandboxSettings([{
      filesystem: { disabled: true },
      network: { allowedDomains: ['registry.npmjs.org'], allowManagedDomainsOnly: true },
    }])
    expect(withNetwork.filesystem.disabled).toBe(true)
    expect(resolveSandboxNetworkEnforcement(withNetwork.network)).toMatchObject({
      egress: 'denied',
      source: 'allowManagedDomainsOnly',
    })
    // And the network verdict does not change when the filesystem layer is on.
    const filesystemOn = resolveSandboxSettings([{
      network: { allowedDomains: ['registry.npmjs.org'], allowManagedDomainsOnly: true },
    }])
    expect(resolveSandboxNetworkEnforcement(filesystemOn.network))
      .toEqual(resolveSandboxNetworkEnforcement(withNetwork.network))
  })
})
