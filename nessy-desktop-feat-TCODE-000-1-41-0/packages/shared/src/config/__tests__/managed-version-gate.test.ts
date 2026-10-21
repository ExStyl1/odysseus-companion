/**
 * `requiredMinimumVersion` / `requiredMaximumVersion` —
 * `settings-reference.md#requiredminimumversion` ("`claude update`,
 * `claude install`, and `claude doctor` keep working below the floor so users
 * can recover.") and `settings-reference.md#requiredmaximumversion` ("…keep
 * working above the ceiling so users can recover."), with the fail-open rule of
 * `managed-settings.md#keys-that-fail-closed`: "`requiredMinimumVersion` and
 * `requiredMaximumVersion` fail open by design: an invalid value is dropped
 * rather than enforced."
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  compareManagedVersions,
  enforceManagedVersionGate,
  MANAGED_VERSION_PATTERN,
} from '../managed-version-gate.ts'
import { parseManagedPiPolicyTolerantV1 } from '../../agent/pi-harness/managed-policy.ts'

const tolerant = (value: Record<string, unknown>) => parseManagedPiPolicyTolerantV1(
  { schemaVersion: 1, disabledPermissionModes: [], ...value },
  { source: '/etc/nessy/managed-policy.json' },
)

describe('version comparison', () => {
  test('orders numeric segments and treats missing trailing segments as zero', () => {
    expect(compareManagedVersions('2.1.150', '2.1.150')).toBe(0)
    expect(compareManagedVersions('2.1', '2.1.0')).toBe(0)
    expect(compareManagedVersions('2.1.149', '2.1.150')).toBe(-1)
    expect(compareManagedVersions('2.2.0', '2.1.999')).toBe(1)
    expect(compareManagedVersions('10.0.0', '9.9.9')).toBe(1) // not lexicographic
  })

  test('a prerelease suffix is IGNORED, never ordered below its release', () => {
    // Full semver precedence would sort `2.1.150-beta.1` BELOW `2.1.150`, so an
    // org that pinned a minimum of 2.1.150 would refuse to start a build it had
    // itself approved — a refusal invented by ordering rules the admin never
    // wrote.
    expect(compareManagedVersions('2.1.150-beta.1', '2.1.150')).toBe(0)
  })

  test('an uncomparable side yields undefined, which the gate reads as allowed', () => {
    expect(compareManagedVersions('latest', '2.1.150')).toBeUndefined()
    expect(compareManagedVersions('', '2.1.150')).toBeUndefined()
  })
})

describe('the gate (settings-reference.md#requiredminimumversion / #requiredmaximumversion)', () => {
  test('refuses below the floor and above the ceiling, with a recovery message', () => {
    const below = enforceManagedVersionGate({ version: '1.2.0', requiredMinimumVersion: '1.3.0' })
    expect(below.outcome).toBe('below-minimum')
    expect(below.reason).toContain('1.2.0')
    expect(below.recovery).toContain('1.3.0')

    const above = enforceManagedVersionGate({ version: '2.0.0', requiredMaximumVersion: '1.9.0' })
    expect(above.outcome).toBe('above-maximum')
    expect(above.recovery).toContain('approved method')
  })

  test('allows the boundary values themselves and everything between', () => {
    const between = { requiredMinimumVersion: '1.3.0', requiredMaximumVersion: '1.9.0' }
    for (const version of ['1.3.0', '1.5.2', '1.9.0']) {
      expect(enforceManagedVersionGate({ version, ...between }).outcome).toBe('allowed')
    }
  })

  test('FAILS OPEN on an unparseable running version', () => {
    // `managed-settings.md#keys-that-fail-closed` — "`requiredMinimumVersion`
    // and `requiredMaximumVersion` fail open by design: an invalid value is
    // dropped rather than enforced." The reassurance this test used to quote —
    // that a bad policy push cannot prevent Claude Code from starting — is on no
    // Claude page any more (checked 2026-09-10; "bad policy push" and "prevent
    // Claude Code from starting" both score 0 across the four successor pages,
    // positive control "fail open" 1), so the fail-open RULE is carried and the
    // reassurance is dropped rather than re-anchored. Refusing because we could
    // not read OUR OWN version string would be that failure, self-inflicted.
    expect(enforceManagedVersionGate({
      version: 'dev', requiredMinimumVersion: '99.0.0',
    }).outcome).toBe('allowed')
  })

  test('no bound is no gate', () => {
    expect(enforceManagedVersionGate({ version: '1.0.0' }).outcome).toBe('allowed')
  })
})

describe('the bounds FAIL OPEN at parse time (managed-settings.md#keys-that-fail-closed)', () => {
  test('an invalid bound is stripped, never enforced', () => {
    for (const bad of ['latest', '', 'v1.2.3', 1.2, null, {}, '1.'.repeat(40)]) {
      const { policy, drops } = tolerant({ requiredMinimumVersion: bad })
      expect(policy.requiredMinimumVersion).toBeUndefined()
      expect(drops.map(drop => drop.field)).toEqual(['requiredMinimumVersion'])
      expect(drops[0]!.disposition).toBe('stripped')
    }
  })

  test('a valid bound is carried and no longer refused as an unknown key', () => {
    // Both keys used to be rejected outright by the 22-key allowlist, so an
    // admin who wrote either got a drop reading `invalid managed Pi policy key`
    // and no enforcement at all.
    const { policy, drops } = tolerant({
      requiredMinimumVersion: '1.3.0',
      requiredMaximumVersion: '2.0.0-rc.1',
    })
    expect(drops).toEqual([])
    expect(policy.requiredMinimumVersion).toBe('1.3.0')
    expect(policy.requiredMaximumVersion).toBe('2.0.0-rc.1')
    expect(MANAGED_VERSION_PATTERN.test('2.0.0-rc.1')).toBe(true)
  })
})

/**
 * P6.243 — the other two documented version keys are recorded `n/a` for a
 * single-channel product, and these are the pins that keep the record honest.
 *
 * The reason lives on `managed-version-gate.ts`; this file makes it a check.
 * The failure it exists to prevent is a HALF implementation: `autoUpdatesChannel`
 * wired through `autoUpdater.channel` would flip `allowDowngrade` to `true` (the
 * setter does it), and the protection `minimumVersion` provides upstream would
 * be gone in the same commit that looked like it added a feature.
 */
describe('minimumVersion / autoUpdatesChannel — recorded n/a, pinned in both directions', () => {
  const ROOT = resolve(import.meta.dir, '../../../../..')

  test('neither key is carried, so an administrator who writes one gets a drop naming it', () => {
    const { policy, drops } = tolerant({ minimumVersion: '1.3.0', autoUpdatesChannel: 'stable' })
    expect(new Set(drops.map(drop => drop.field))).toEqual(new Set(['minimumVersion', 'autoUpdatesChannel']))
    expect(drops.every(drop => drop.disposition === 'stripped')).toBe(true)
    // The adjacent stronger key still works — the control that proves the drop
    // is about these two keys and not about the parser.
    expect(tolerant({ requiredMinimumVersion: '1.3.0' }).policy.requiredMinimumVersion).toBe('1.3.0')
    expect(policy.requiredMinimumVersion).toBeUndefined()
  })

  test('the channel is a BUILD-time property of the artifact, not a runtime choice', () => {
    const builder = readFileSync(resolve(ROOT, 'apps/electron/electron-builder.yml'), 'utf8')
    expect(builder).toContain('channel: "${env.NESSY_DESKTOP_UPDATE_CHANNEL}"')
    expect(builder).toContain('url: "${env.NESSY_DESKTOP_UPDATE_URL}"')
  })

  test('the downgrade refusal is electron-updater\'s own default, and nothing here overrides it', () => {
    const vendored = readFileSync(resolve(ROOT, 'node_modules/electron-updater/out/AppUpdater.js'), 'utf8')
    // The default, and the line that consumes it.
    expect(vendored).toContain('this.allowDowngrade = false')
    expect(vendored).toContain('return this.allowDowngrade && isLatestVersionOlder')
    // The coupling: the channel setter turns the protection off. Matched
    // whitespace-insensitively so a reformat of the vendored file does not read
    // as the coupling disappearing.
    expect(vendored.replace(/\s+/g, ' '))
      .toContain('this._channel = value; this.allowDowngrade = true;')

    const updater = readFileSync(resolve(ROOT, 'apps/electron/src/main/auto-update.ts'), 'utf8')
    expect(updater).not.toContain('allowDowngrade')
    expect(updater).not.toContain('autoUpdater.channel')
    // Positive control on the same file: it DOES configure the updater, so a
    // read that found nothing would not be mistaken for a clean absence.
    expect(updater).toContain('autoUpdater')
  })
})
