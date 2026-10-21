import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  buildPluginRuntimeDependencyInstallInvocation,
  inspectPluginRuntimeDependencyQuota,
  prepareBunCompatibleLockfile,
  resolvePluginRuntimeDependencyBun,
  runDependencyInstallerWithQuota,
} from './plugin-runtime-dependencies'

let testDirectory = ''

afterEach(() => {
  if (testDirectory) rmSync(testDirectory, { recursive: true, force: true })
  testDirectory = ''
})

describe('plugin runtime dependency installer', () => {
  it('builds a fixed production-only Bun invocation with a cleared environment', () => {
    const directory = join(process.cwd(), 'stage', 'normalized')
    const temporaryRoot = join(dirname(directory), '.runtime-dependencies')
    const invocation = buildPluginRuntimeDependencyInstallInvocation(
      '/runtime/bun',
      directory,
      {
        LANG: 'en_US.UTF-8',
        NODE_EXTRA_CA_CERTS: '/approved/ca.pem',
        SECRET_TOKEN: 'must-not-pass',
      },
    )

    expect(invocation.command).toBe('/runtime/bun')
    expect(invocation.args).toEqual([
      'install',
      `--config=${join(temporaryRoot, 'bunfig.toml')}`,
      '--production',
      '--ignore-scripts',
      '--frozen-lockfile',
      '--no-env-file',
      '--backend=copyfile',
      '--linker=hoisted',
    ])
    expect(invocation.options).toMatchObject({
      cwd: directory,
      shell: false,
      stdio: 'ignore',
      timeout: 300_000,
      killSignal: 'SIGKILL',
      env: {
        LANG: 'en_US.UTF-8',
        NODE_EXTRA_CA_CERTS: '/approved/ca.pem',
        TMPDIR: join(temporaryRoot, 'tmp'),
        BUN_INSTALL_CACHE_DIR: join(temporaryRoot, 'cache'),
        HOME: join(temporaryRoot, 'home'),
        USERPROFILE: join(temporaryRoot, 'home'),
        XDG_CONFIG_HOME: join(temporaryRoot, 'config'),
        APPDATA: join(temporaryRoot, 'app-data'),
        LOCALAPPDATA: join(temporaryRoot, 'local-app-data'),
      },
    })
    expect(invocation.options.env.SECRET_TOKEN).toBeUndefined()
    expect(invocation.options.env.PATH).toBeUndefined()
  })

  it('bootstraps a registry package lock without widening the installer environment', () => {
    const directory = join(process.cwd(), 'stage', 'normalized', '.nessy-runtime', 'npx', 'package')
    const invocation = buildPluginRuntimeDependencyInstallInvocation(
      '/runtime/bun',
      directory,
      {
        HTTPS_PROXY: 'http://approved-proxy',
        NODE_EXTRA_CA_CERTS: '/approved/ca.pem',
        NPM_TOKEN: 'must-not-pass',
      },
      false,
    )

    expect(invocation.args).toEqual([
      'install',
      `--config=${join(dirname(directory), '.runtime-dependencies', 'bunfig.toml')}`,
      '--ignore-scripts',
      '--no-env-file',
      '--backend=copyfile',
      '--linker=hoisted',
    ])
    expect(invocation.options.env).toMatchObject({
      HTTPS_PROXY: 'http://approved-proxy',
      NODE_EXTRA_CA_CERTS: '/approved/ca.pem',
    })
    expect(invocation.options.env.NPM_TOKEN).toBeUndefined()
    expect(invocation.options.env.HOME).toBe(join(dirname(directory), '.runtime-dependencies', 'home'))
  })

  it('adapts the publishable npm shrinkwrap to Bun package-lock input without changing bytes', async () => {
    testDirectory = mkdtempSync(join(tmpdir(), 'plugin-runtime-dependencies-'))
    const shrinkwrapPath = join(testDirectory, 'npm-shrinkwrap.json')
    const bytes = '{"lockfileVersion":3,"packages":{}}\n'
    writeFileSync(shrinkwrapPath, bytes)

    const prepared = await prepareBunCompatibleLockfile(testDirectory, shrinkwrapPath)

    expect(prepared?.packageLockPath).toBe(join(testDirectory, 'package-lock.json'))
    expect(readFileSync(prepared?.packageLockPath ?? '', 'utf-8')).toBe(bytes)
  })

  it('resolves host-owned Bun for Electron dev and the packaged headless layout without PATH', () => {
    testDirectory = mkdtempSync(join(tmpdir(), 'plugin-runtime-dependencies-'))
    const bunName = process.platform === 'win32' ? 'bun.exe' : 'bun'
    const electronBun = join(testDirectory, 'electron', 'vendor', 'bun', bunName)
    const headlessBun = join(testDirectory, 'headless', 'vendor', 'bun', bunName)
    mkdirSync(dirname(electronBun), { recursive: true })
    mkdirSync(dirname(headlessBun), { recursive: true })
    writeFileSync(electronBun, '')
    writeFileSync(headlessBun, '')

    expect(resolvePluginRuntimeDependencyBun({
      NESSY_RESOURCES_BASE: join(testDirectory, 'electron'),
      PATH: '/untrusted/path',
    })).toBe(realpathSync(electronBun))
    expect(resolvePluginRuntimeDependencyBun({
      NESSY_BUNDLED_ASSETS_ROOT: join(testDirectory, 'headless'),
      PATH: '/untrusted/path',
    })).toBe(realpathSync(headlessBun))
  })

  it.each(['darwin', 'linux'] as const)('resolves packaged %s Bun from external Electron resources', platform => {
    testDirectory = mkdtempSync(join(tmpdir(), 'plugin-runtime-dependencies-'))
    const bun = join(testDirectory, 'resources', 'vendor', 'bun', 'bun')
    mkdirSync(dirname(bun), { recursive: true })
    writeFileSync(bun, '')

    expect(resolvePluginRuntimeDependencyBun({}, undefined, {
      appRootPath: join(testDirectory, 'app'),
      resourcesPath: join(testDirectory, 'resources'),
      isPackaged: true,
      platform,
    })).toBe(realpathSync(bun))
  })

  it('resolves packaged Windows Bun from Electron resources', () => {
    testDirectory = mkdtempSync(join(tmpdir(), 'plugin-runtime-dependencies-'))
    const bun = join(testDirectory, 'resources', 'vendor', 'bun', 'bun.exe')
    mkdirSync(dirname(bun), { recursive: true })
    writeFileSync(bun, '')

    expect(resolvePluginRuntimeDependencyBun({}, undefined, {
      appRootPath: join(testDirectory, 'resources', 'app'),
      resourcesPath: join(testDirectory, 'resources'),
      isPackaged: true,
      platform: 'win32',
    })).toBe(realpathSync(bun))
  })

  it('fails closed when installer-owned output exceeds its byte quota', async () => {
    testDirectory = mkdtempSync(join(tmpdir(), 'plugin-runtime-dependencies-'))
    const nodeModules = join(testDirectory, 'node_modules')
    mkdirSync(nodeModules)
    writeFileSync(join(nodeModules, 'oversized.bin'), Buffer.alloc(64))

    const snapshot = await inspectPluginRuntimeDependencyQuota({
      roots: [nodeModules],
      filesystemPath: testDirectory,
      maxBytes: 32,
      minFreeBytes: 0,
    })

    expect(snapshot.exceeded).toBe(true)
    expect(snapshot.usedBytes).toBeGreaterThan(32)
  })

  it('does not follow symlinks while measuring installer output', async () => {
    if (process.platform === 'win32') return
    testDirectory = mkdtempSync(join(tmpdir(), 'plugin-runtime-dependencies-'))
    const outside = mkdtempSync(join(tmpdir(), 'plugin-runtime-dependencies-outside-'))
    try {
      const quotaBytes = 1024 * 1024
      writeFileSync(join(outside, 'large.bin'), Buffer.alloc(quotaBytes * 2))
      const nodeModules = join(testDirectory, 'node_modules')
      mkdirSync(nodeModules)
      const { symlinkSync } = await import('node:fs')
      symlinkSync(outside, join(nodeModules, 'outside'))

      const snapshot = await inspectPluginRuntimeDependencyQuota({
        roots: [nodeModules],
        filesystemPath: testDirectory,
        maxBytes: quotaBytes,
        minFreeBytes: 0,
      })

      expect(snapshot.exceeded).toBe(false)
      expect(snapshot.usedBytes).toBeLessThan(quotaBytes)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('performs an awaited final quota check after a fast installer exits', async () => {
    testDirectory = mkdtempSync(join(tmpdir(), 'plugin-runtime-dependencies-'))
    const base = buildPluginRuntimeDependencyInstallInvocation(process.execPath, testDirectory, {})
    const nodeModules = join(testDirectory, 'node_modules')
    const script = [
      'const fs = require("node:fs")',
      `fs.mkdirSync(${JSON.stringify(nodeModules)}, { recursive: true })`,
      `fs.writeFileSync(${JSON.stringify(join(nodeModules, 'late.bin'))}, Buffer.alloc(64))`,
    ].join(';')

    await expect(runDependencyInstallerWithQuota({
      ...base,
      command: process.execPath,
      args: ['-e', script] as unknown as typeof base.args,
    }, testDirectory, {
      maxBytes: 32,
      minFreeBytes: 0,
      // Ensure the periodic poll cannot observe the final write; only the
      // awaited exit-boundary inspection can reject it.
      pollIntervalMs: 60_000,
    })).rejects.toThrow('plugin-runtime-dependency-quota-exceeded')
  })
})
