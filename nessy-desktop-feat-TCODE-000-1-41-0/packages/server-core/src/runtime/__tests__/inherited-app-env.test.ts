/**
 * UB7.13 — the inherited-app-env guard's arms, ported from
 * `v0.15.1:packages/server-core/src/runtime/inherited-app-env.test.ts`
 * (first shipped v0.15.0; fixtures rebranded to Nessy-shaped checkout names).
 */
import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { isPathInside, resolveInheritedAppEnv, sourceCheckoutRoot } from '../inherited-app-env'
import { createHeadlessPlatform } from '../platform-headless'

const own = '/work/NessyDesktopDev/sdk-uplift-release'
const app = '/work/NessyDesktopDev/nessy-desktop-design-remake'

describe('resolveInheritedAppEnv', () => {
  it("ignores a running app's NESSY_APP_ROOT and every NESSY_* path inside it", () => {
    const env = {
      NESSY_APP_ROOT: app,
      NESSY_RESOURCES_BASE: `${app}/apps/electron`,
      NESSY_UV: `${app}/apps/electron/resources/bin/darwin-arm64/uv`,
      NESSY_CLI_ENTRY: `${app}/packages/nessy-cli/src/cli.ts`,
      NESSY_SESSION_DIR: '/work/NessyAgentWS/sessions/261010-onyx-heron',
      NESSY_CONFIG_DIR: '',
      NESSY_DEBUG: '1',
      PATH: `${app}/bin:/usr/bin`,
    }
    const result = resolveInheritedAppEnv(env, own, own)
    expect(result.ignoredAppRoot).toBe(app)
    expect(result.appRootPath).toBe(own)
    expect(result.dropKeys.sort()).toEqual(['NESSY_APP_ROOT', 'NESSY_CLI_ENTRY', 'NESSY_RESOURCES_BASE', 'NESSY_UV'])
  })

  it('falls back to the checkout root when the cwd is outside it', () => {
    expect(resolveInheritedAppEnv({ NESSY_APP_ROOT: app }, own, '/tmp').appRootPath).toBe(own)
  })

  it('keeps a NESSY_APP_ROOT inside its own checkout', () => {
    const result = resolveInheritedAppEnv({ NESSY_APP_ROOT: `${own}/apps/electron` }, own, own)
    expect(result).toEqual({ appRootPath: `${own}/apps/electron`, dropKeys: [] })
  })

  it('honors NESSY_APP_ROOT for bundled servers (no source checkout)', () => {
    expect(resolveInheritedAppEnv({ NESSY_APP_ROOT: '/app' }, null, '/srv')).toEqual({ appRootPath: '/app', dropKeys: [] })
  })

  it('defaults to the cwd when NESSY_APP_ROOT is unset', () => {
    expect(resolveInheritedAppEnv({}, own, own)).toEqual({ appRootPath: own, dropKeys: [] })
  })
})

describe('sourceCheckoutRoot', () => {
  it('finds this monorepo when server-core runs from source', () => {
    const root = sourceCheckoutRoot()
    expect(root).not.toBeNull()
    expect(isPathInside(join(root!, 'packages', 'server-core'), root!)).toBe(true)
  })

  it('returns null outside a checkout (bundled builds) or without a module folder', () => {
    expect(sourceCheckoutRoot('/a/b/c/d')).toBeNull()
    expect(sourceCheckoutRoot(null)).toBeNull()
  })
})

describe('isPathInside', () => {
  it('treats a sibling with a shared prefix as outside', () => {
    expect(isPathInside('/work/repo-2/x', '/work/repo')).toBe(false)
    expect(isPathInside('/work/repo/x', '/work/repo')).toBe(true)
    expect(isPathInside('/work/repo', '/work/repo')).toBe(true)
  })
})

/**
 * The createHeadlessPlatform-level arms (UB7.13's Tests line): the row's
 * positive is a source-run server (this suite IS one — sourceCheckoutRoot()
 * finds this repo) under a FOREIGN NESSY_APP_ROOT: it is ignored with a warning
 * naming the dropped keys. The negative control — a bundled server keeps
 * honouring NESSY_APP_ROOT — is the resolver arm above (`honors NESSY_APP_ROOT
 * for bundled servers`), which is the exact function the platform applies; the
 * own-checkout arm pins the not-foreign reading at this level too.
 */
describe('createHeadlessPlatform × inherited app env', () => {
  // Bun defines `delete`-then-assign on process.env visibly (the Bun 1.3.14
  // env trap); save and restore every key these arms touch.
  const saved: Record<string, string | undefined> = {}
  const readEnv = (): Record<string, string | undefined> => ({ ...process.env })

  function withEnv(overrides: Record<string, string | undefined>, run: () => void): { warnings: string[] } {
    const keys = Object.keys(overrides)
    const before: Record<string, string | undefined> = {}
    for (const key of keys) { before[key] = process.env[key] }
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => { warnings.push(args.map(a => (typeof a === 'string' ? a : String(a))).join(' ')) }
    try {
      for (const key of keys) {
        delete process.env[key]
        const value = overrides[key]
        if (value !== undefined) process.env[key] = value
      }
      run()
    } finally {
      console.warn = originalWarn
      for (const key of keys) {
        delete process.env[key]
        if (before[key] !== undefined) process.env[key] = before[key]
      }
    }
    return { warnings }
  }

  it('positive: a foreign NESSY_APP_ROOT is ignored, its NESSY_* paths dropped, and the warning names them', () => {
    const foreign = '/opt/some-other-nessy-checkout'
    let platform!: ReturnType<typeof createHeadlessPlatform>
    let envAfterCall: Record<string, string | undefined> = {}
    const { warnings } = withEnv({
      NESSY_APP_ROOT: foreign,
      NESSY_UV: `${foreign}/apps/electron/resources/bin/darwin-arm64/uv`,
      NESSY_RESOURCES_BASE: `${foreign}/apps/electron`,
    }, () => {
      platform = createHeadlessPlatform()
      // Captured INSIDE the window: withEnv restores the caller's env on the way out.
      envAfterCall = readEnv()
    })

    expect(platform.appRootPath).not.toBe(foreign)
    expect(platform.appRootPath).toBe(process.cwd())
    expect(envAfterCall.NESSY_APP_ROOT).toBe(process.cwd())
    expect(envAfterCall.NESSY_UV).toBeUndefined()
    expect(envAfterCall.NESSY_RESOURCES_BASE).toBeUndefined()
    expect(warnings.some(w => w.includes(`Ignoring NESSY_APP_ROOT=${foreign}`) && w.includes('NESSY_UV') && w.includes('NESSY_RESOURCES_BASE'))).toBe(true)
  })

  it('own checkout: a NESSY_APP_ROOT inside this repo is honoured without a warning', () => {
    const root = sourceCheckoutRoot()
    expect(root).not.toBeNull()
    let platform!: ReturnType<typeof createHeadlessPlatform>
    const { warnings } = withEnv({ NESSY_APP_ROOT: join(root!, 'apps', 'electron') }, () => {
      platform = createHeadlessPlatform()
    })

    expect(platform.appRootPath).toBe(join(root!, 'apps', 'electron'))
    expect(warnings.some(w => w.includes('Ignoring NESSY_APP_ROOT'))).toBe(false)
  })
})
