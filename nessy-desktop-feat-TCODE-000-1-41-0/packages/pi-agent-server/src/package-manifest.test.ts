import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'

function readJson<T>(url: URL): T {
  return JSON.parse(readFileSync(url, 'utf-8')) as T
}

/** Must match `SUPPORTED_PI_RUNTIME_VERSION` in `compat/pi-runtime-adapter.ts`. */
const APPROVED_PI_VERSION = '0.87.1'

/**
 * Pi 0.84 split the runtime into seven packages: `pi-coding-agent` gained
 * `pi-client`, `pi-protocol` and `pi-tui` as direct dependencies, and both
 * `pi-ai` and `pi-agent-core` gained `pi-telemetry`. They all move in lockstep,
 * so the whole family is still pinned to one approved version — the list just
 * grew from four names to seven. Only the first three are DIRECT dependencies
 * of our manifests; the rest arrive transitively and are asserted in the lock.
 *
 * 0.85.1 (F1.255, 2026-09-24) moved the INSTALLED family, and this list is what
 * the lock carries: `chord` arrived as a direct dependency of `pi-coding-agent`,
 * and `pi-client` / `pi-protocol` became its devDependencies — still published
 * in lockstep, no longer installed, absent from `bun.lock`. Six names.
 */
const PI_FAMILY_NAMES = [
  '@earendil-works/chord',
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-ai',
  '@earendil-works/pi-coding-agent',
  '@earendil-works/pi-telemetry',
  '@earendil-works/pi-tui',
] as const

function parsePiFamilyLockResolutions(lock: string) {
  const family = '@earendil-works/(?:chord|pi-(?:agent-core|ai|client|coding-agent|protocol|telemetry|tui))'
  const keyPattern = new RegExp(`^(${family})(?:@(.+))?$`)
  const resolutionPattern = new RegExp(`^(${family})@(.+)$`)
  return [...lock.matchAll(/^[ \t]*"([^"]+)":\s+\["([^"]+)"/gm)]
    .map(([, key, resolution]) => {
      const keyMatch = key.match(keyPattern)
      const resolutionMatch = resolution.match(resolutionPattern)
      return {
        key,
        keyName: keyMatch?.[1] ?? null,
        resolution,
        name: resolutionMatch?.[1] ?? null,
        version: resolutionMatch?.[2] ?? null,
      }
    })
    .filter(({ keyName, name }) => keyName !== null || name !== null)
}

function assertApprovedPiFamilyLock(lock: string) {
  const resolutions = parsePiFamilyLockResolutions(lock)
  for (const { key, keyName, resolution, name, version } of resolutions) {
    if (!keyName || name !== keyName) {
      throw new Error(`Pi lock alias/mismatch: ${key} -> ${resolution}`)
    }
    if (version !== APPROVED_PI_VERSION) {
      throw new Error(`Unapproved Pi lock resolution: ${key} -> ${resolution}`)
    }
  }
  const names = [...new Set(resolutions.map(({ name }) => name))].sort()
  if (JSON.stringify(names) !== JSON.stringify([...PI_FAMILY_NAMES].sort())) {
    throw new Error(`Incomplete Pi lock family: ${names.join(', ')}`)
  }
  return resolutions
}

describe('pi-agent-server package manifest', () => {
  it('pins one exact approved Pi family without a direct pi-tui dependency', () => {
    const expectedDirectDependencies = new Map([
      ['package.json', ['@earendil-works/pi-ai', '@earendil-works/pi-coding-agent']],
      ['packages/pi-agent-server/package.json', [
        '@earendil-works/pi-agent-core',
        '@earendil-works/pi-ai',
        '@earendil-works/pi-coding-agent',
      ]],
      ['packages/shared/package.json', [
        '@earendil-works/pi-agent-core',
        '@earendil-works/pi-ai',
        '@earendil-works/pi-coding-agent',
      ]],
      ['packages/server-core/package.json', ['@earendil-works/pi-ai']],
    ])
    const manifestUrls = new Map([
      ['package.json', new URL('../../../package.json', import.meta.url)],
      ['packages/pi-agent-server/package.json', new URL('../package.json', import.meta.url)],
      ['packages/shared/package.json', new URL('../../shared/package.json', import.meta.url)],
      ['packages/server-core/package.json', new URL('../../server-core/package.json', import.meta.url)],
    ])
    const familyPattern = /^@earendil-works\/pi-(?:agent-core|ai|coding-agent|tui)$/

    for (const [path, expectedNames] of expectedDirectDependencies) {
      const manifest = readJson<{ dependencies?: Record<string, string> }>(manifestUrls.get(path)!)
      const actual = Object.entries(manifest.dependencies ?? {})
        .filter(([name]) => familyPattern.test(name))
        .sort(([left], [right]) => left.localeCompare(right))
      expect(actual).toEqual(
        expectedNames.map(name => [name, APPROVED_PI_VERSION]).sort(([left], [right]) => left.localeCompare(right)),
      )
    }

    const lock = readFileSync(new URL('../../../bun.lock', import.meta.url), 'utf8')
    const lockResolutions = assertApprovedPiFamilyLock(lock)
    expect([...new Set(lockResolutions.map(({ name }) => name))].sort()).toEqual([...PI_FAMILY_NAMES].sort())
    expect(lockResolutions.length).toBeGreaterThanOrEqual(PI_FAMILY_NAMES.length)
    expect(new Set(lockResolutions.map(({ version }) => version))).toEqual(new Set([APPROVED_PI_VERSION]))
  })

  it('audits suffixed, prerelease, alias, and mismatched Pi lock resolutions', () => {
    const approved = PI_FAMILY_NAMES
      .map(name => `"${name}@optional": ["${name}@${APPROVED_PI_VERSION}", "", {}, "sha"]`)
      .join('\n')
    expect(() => assertApprovedPiFamilyLock(approved)).not.toThrow()

    expect(() => assertApprovedPiFamilyLock(
      approved.replace(
        `@earendil-works/pi-ai@${APPROVED_PI_VERSION}`,
        `@earendil-works/pi-ai@${APPROVED_PI_VERSION}-rc.1`,
      ),
    )).toThrow(/Unapproved Pi lock resolution/)
    expect(() => assertApprovedPiFamilyLock(
      approved.replace(
        `"@earendil-works/pi-ai@optional": ["@earendil-works/pi-ai@${APPROVED_PI_VERSION}"`,
        `"pi-ai-alias": ["@earendil-works/pi-ai@${APPROVED_PI_VERSION}"`,
      ),
    )).toThrow(/alias\/mismatch/)
    expect(() => assertApprovedPiFamilyLock(
      approved.replace(
        `"@earendil-works/pi-ai@optional": ["@earendil-works/pi-ai@${APPROVED_PI_VERSION}"`,
        `"@earendil-works/pi-ai@optional": ["@earendil-works/pi-tui@${APPROVED_PI_VERSION}"`,
      ),
    )).toThrow(/alias\/mismatch/)
  })

  it('keeps koffi runtime packaging entries explicit', () => {
    const piPackage = readJson<{
      dependencies?: Record<string, string>
      scripts?: Record<string, string>
    }>(new URL('../package.json', import.meta.url))
    const rootPackage = readJson<{ trustedDependencies?: string[] }>(
      new URL('../../../package.json', import.meta.url),
    )
    const bunLock = readFileSync(new URL('../../../bun.lock', import.meta.url), 'utf-8')
    const packagingScript = readFileSync(
      new URL('../../../scripts/build/common.ts', import.meta.url),
      'utf-8',
    )

    expect(piPackage.dependencies?.koffi).toBe('2.16.2')
    expect(piPackage.scripts?.build).not.toContain('koffi')
    expect(rootPackage.trustedDependencies ?? []).toContain('koffi')
    expect(bunLock).toContain('"koffi": "2.16.2"')
    expect(bunLock).toContain('koffi@2.16.2')
    expect(packagingScript).toContain('--external koffi')
    expect(packagingScript).toContain("node_modules', 'koffi'")
  })

  it('ships the Pi package identity next to the bundled server', () => {
    // The bundle inlines pi-coding-agent, whose config resolves VERSION/piConfig
    // from the nearest package.json above the bundle. Without this identity file
    // the walk lands on an unrelated manifest and sessions fail version validation.
    const buildScript = readJson<{ scripts?: Record<string, string> }>(
      new URL('../package.json', import.meta.url),
    ).scripts?.build ?? ''
    expect(buildScript).toContain('write-dist-package.ts')

    const packagingScript = readFileSync(
      new URL('../../../scripts/build/common.ts', import.meta.url),
      'utf-8',
    )
    expect(packagingScript).toContain("join(piSourceDir, 'package.json')")
    expect(packagingScript).toContain("join(piDestDir, 'package.json')")

    if (existsSync(new URL('../dist/index.js', import.meta.url))) {
      const identity = readJson<{ name?: string; version?: string; type?: string }>(
        new URL('../dist/package.json', import.meta.url),
      )
      expect(identity.name).toBe('@earendil-works/pi-coding-agent')
      expect(identity.version).toBe(APPROVED_PI_VERSION)
      expect(identity.type).toBe('module')
    }
  })

  it('registers the packaged Bedrock provider before Pi runtime construction', () => {
    const entrypoint = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
    expect(entrypoint).toMatch(
      /import\s*\{[^}]*\bsetBedrockProviderModule\b[^}]*\}\s*from '@earendil-works\/pi-ai\/compat';/,
    )
    expect(entrypoint).toContain(
      "import { bedrockProviderModule } from '@earendil-works/pi-ai/bedrock-provider';",
    )
    const registration = entrypoint.indexOf('setBedrockProviderModule(bedrockProviderModule);')
    const main = entrypoint.indexOf('function main(): void')
    expect(registration).toBeGreaterThan(-1)
    expect(registration).toBeLessThan(main)
  })
})
