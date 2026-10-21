import { constants, existsSync, realpathSync, statSync } from 'node:fs'
import { copyFile, lstat, mkdir, readFile, readdir, rm, statfs, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { basename, dirname, isAbsolute, join } from 'node:path'
import type { PluginRuntimeDependencyInstaller } from '@nessy-agent/shared/plugins'
import { getPluginNetworkEnvVars } from '@nessy-agent/shared/config/proxy-env'

const INSTALL_ARGS = [
  'install',
  '--production',
  '--ignore-scripts',
  '--no-env-file',
  '--backend=copyfile',
  '--linker=hoisted',
] as const
const INSTALL_TIMEOUT_MS = 5 * 60_000
/** Includes the installer cache and materialized node_modules output. */
export const PLUGIN_RUNTIME_DEPENDENCY_MAX_BYTES = 1024 * 1024 * 1024
/** Never let an untrusted dependency graph consume the host's final GiB. */
export const PLUGIN_RUNTIME_DEPENDENCY_MIN_FREE_BYTES = 1024 * 1024 * 1024
const INSTALL_QUOTA_POLL_MS = 100
const PASSTHROUGH_ENV = [
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'BUN_CONFIG_REGISTRY',
  'NPM_CONFIG_REGISTRY',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
  'SystemRoot',
  'WINDIR',
] as const

export function buildPluginRuntimeDependencyInstallInvocation(
  bunPath: string,
  directory: string,
  hostEnvironment: NodeJS.ProcessEnv,
  frozenLockfile = true,
) {
  const temporaryRoot = join(dirname(directory), '.runtime-dependencies')
  const temporaryDirectory = join(temporaryRoot, 'tmp')
  const cacheDirectory = join(temporaryRoot, 'cache')
  const homeDirectory = join(temporaryRoot, 'home')
  const configDirectory = join(temporaryRoot, 'config')
  const dataDirectory = join(temporaryRoot, 'data')
  const appDataDirectory = join(temporaryRoot, 'app-data')
  const localAppDataDirectory = join(temporaryRoot, 'local-app-data')
  const configPath = join(temporaryRoot, 'bunfig.toml')
  const npmrcPath = join(homeDirectory, '.npmrc')
  const env: NodeJS.ProcessEnv = {
    ...(frozenLockfile ? { CI: '1' } : {}),
    NO_COLOR: '1',
    TMPDIR: temporaryDirectory,
    TMP: temporaryDirectory,
    TEMP: temporaryDirectory,
    BUN_INSTALL_CACHE_DIR: cacheDirectory,
    HOME: homeDirectory,
    USERPROFILE: homeDirectory,
    XDG_CONFIG_HOME: configDirectory,
    XDG_CACHE_HOME: cacheDirectory,
    XDG_DATA_HOME: dataDirectory,
    APPDATA: appDataDirectory,
    LOCALAPPDATA: localAppDataDirectory,
  }
  for (const name of PASSTHROUGH_ENV) {
    if (hostEnvironment[name]) env[name] = hostEnvironment[name]
  }
  return {
    command: bunPath,
    args: [
      ...INSTALL_ARGS.slice(0, 1),
      `--config=${configPath}`,
      // Bun does not emit bun.lock with --production. Generated manifests
      // contain dependencies only, so this still materializes production code.
      ...(frozenLockfile ? [INSTALL_ARGS[1]] : []),
      INSTALL_ARGS[2],
      ...(frozenLockfile ? ['--frozen-lockfile'] : []),
      ...INSTALL_ARGS.slice(3),
    ],
    options: {
      cwd: directory,
      env,
      shell: false as const,
      stdio: 'ignore' as const,
      windowsHide: true,
      timeout: INSTALL_TIMEOUT_MS,
      killSignal: 'SIGKILL' as const,
    },
    temporaryRoot,
    temporaryDirectory,
    cacheDirectory,
    homeDirectory,
    configDirectory,
    dataDirectory,
    appDataDirectory,
    localAppDataDirectory,
    configPath,
    npmrcPath,
  }
}

export async function prepareBunCompatibleLockfile(directory: string, lockfilePath: string) {
  if (basename(lockfilePath) !== 'npm-shrinkwrap.json') return undefined
  const shrinkwrapBytes = await readFile(lockfilePath)
  const packageLockPath = join(directory, 'package-lock.json')
  let createdPackageLock = false
  if (!existsSync(packageLockPath)) {
    await copyFile(lockfilePath, packageLockPath, constants.COPYFILE_EXCL)
    createdPackageLock = true
  }
  const packageLockBytes = await readFile(packageLockPath)
  if (!shrinkwrapBytes.equals(packageLockBytes)) {
    throw new Error('plugin-runtime-dependency-lock-changed')
  }
  return { shrinkwrapBytes, packageLockPath, createdPackageLock }
}

export function resolvePluginRuntimeDependencyBun(
  environment: NodeJS.ProcessEnv,
  currentBunExecutable?: string,
  host?: PluginRuntimeDependencyHostContext,
): string | undefined {
  const bunName = (host?.platform ?? process.platform) === 'win32' ? 'bun.exe' : 'bun'
  const resourcesBase = environment.NESSY_RESOURCES_BASE
  const bundledAssetsRoot = environment.NESSY_BUNDLED_ASSETS_ROOT
  const appRoot = environment.NESSY_APP_ROOT
  const candidates = [
    environment.NESSY_BUN,
    ...(host?.isPackaged ? [
      join(host.resourcesPath, 'vendor', 'bun', bunName),
      join(host.appRootPath, 'vendor', 'bun', bunName),
    ] : []),
    resourcesBase ? join(resourcesBase, 'vendor', 'bun', bunName) : undefined,
    resourcesBase ? join(dirname(resourcesBase), 'vendor', 'bun', bunName) : undefined,
    bundledAssetsRoot ? join(bundledAssetsRoot, 'vendor', 'bun', bunName) : undefined,
    appRoot ? join(appRoot, 'vendor', 'bun', bunName) : undefined,
    appRoot ? join(appRoot, 'apps', 'electron', 'vendor', 'bun', bunName) : undefined,
    currentBunExecutable,
  ]
  for (const candidate of candidates) {
    if (!candidate || !isAbsolute(candidate) || !existsSync(candidate)) continue
    try {
      const canonical = realpathSync(candidate)
      if (statSync(canonical).isFile()) return canonical
    } catch {
      // Try the next host-owned location.
    }
  }
  return undefined
}

export interface PluginRuntimeDependencyHostContext {
  appRootPath: string
  resourcesPath: string
  isPackaged: boolean
  platform: NodeJS.Platform
}

export interface PluginRuntimeDependencyQuotaSnapshot {
  usedBytes: number
  availableBytes: number
  exceeded: boolean
}

/**
 * Inspect only installer-owned roots. Symlinks are counted as directory entries
 * and never followed, so an untrusted package cannot make the quota walker scan
 * arbitrary host paths.
 */
export async function inspectPluginRuntimeDependencyQuota(options: {
  roots: readonly string[]
  filesystemPath: string
  maxBytes?: number
  minFreeBytes?: number
}): Promise<PluginRuntimeDependencyQuotaSnapshot> {
  const maxBytes = options.maxBytes ?? PLUGIN_RUNTIME_DEPENDENCY_MAX_BYTES
  const minFreeBytes = options.minFreeBytes ?? PLUGIN_RUNTIME_DEPENDENCY_MIN_FREE_BYTES
  let usedBytes = 0
  for (const root of options.roots) {
    usedBytes += await directoryEntryBytes(root, maxBytes + 1 - Math.min(usedBytes, maxBytes + 1))
    if (usedBytes > maxBytes) break
  }
  const filesystem = await statfs(options.filesystemPath)
  const availableBytes = Number(filesystem.bavail) * Number(filesystem.bsize)
  return {
    usedBytes,
    availableBytes,
    exceeded: usedBytes > maxBytes || availableBytes < minFreeBytes,
  }
}

async function directoryEntryBytes(path: string, remaining: number): Promise<number> {
  if (remaining <= 0) return 1
  let stats
  try {
    stats = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) return stats.size

  let total = stats.size
  for (const entry of await readdir(path)) {
    total += await directoryEntryBytes(join(path, entry), remaining - total)
    if (total > remaining) break
  }
  return total
}

export async function runDependencyInstallerWithQuota(
  invocation: ReturnType<typeof buildPluginRuntimeDependencyInstallInvocation>,
  directory: string,
  quotaOptions: { maxBytes?: number; minFreeBytes?: number; pollIntervalMs?: number } = {},
): Promise<void> {
  const nodeModulesPath = join(directory, 'node_modules')
  const inspectQuota = () => inspectPluginRuntimeDependencyQuota({
    roots: [nodeModulesPath, invocation.temporaryRoot],
    filesystemPath: directory,
    ...(quotaOptions.maxBytes === undefined ? {} : { maxBytes: quotaOptions.maxBytes }),
    ...(quotaOptions.minFreeBytes === undefined ? {} : { minFreeBytes: quotaOptions.minFreeBytes }),
  })
  if ((await inspectQuota()).exceeded) {
    throw new Error('plugin-runtime-dependency-quota-exceeded')
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, invocation.options)
    let settled = false
    let quotaError: Error | undefined
    let activeCheck: Promise<void> | undefined

    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearInterval(timer)
      if (error) reject(error)
      else resolve()
    }
    const check = (): Promise<void> => {
      if (settled) return Promise.resolve()
      if (activeCheck) return activeCheck
      const run = (async () => {
        try {
          if ((await inspectQuota()).exceeded) {
            quotaError = new Error('plugin-runtime-dependency-quota-exceeded')
            child.kill('SIGKILL')
          }
        } catch {
          quotaError = new Error('plugin-runtime-dependency-quota-check-failed')
          child.kill('SIGKILL')
        }
      })()
      const tracked = run.finally(() => {
        if (activeCheck === tracked) activeCheck = undefined
      })
      activeCheck = tracked
      return activeCheck
    }
    const timer = setInterval(() => { void check() }, quotaOptions.pollIntervalMs ?? INSTALL_QUOTA_POLL_MS)
    timer.unref?.()
    child.once('error', error => finish(error))
    child.once('exit', code => {
      clearInterval(timer)
      void (async () => {
        // An installer can create its final bytes and exit between polling
        // ticks. Await any in-flight check, then inspect once more before a
        // successful exit is accepted.
        await activeCheck
        if (!quotaError) {
          try {
            if ((await inspectQuota()).exceeded) {
              quotaError = new Error('plugin-runtime-dependency-quota-exceeded')
            }
          } catch {
            quotaError = new Error('plugin-runtime-dependency-quota-check-failed')
          }
        }
        if (quotaError) finish(quotaError)
        else if (code === 0) finish()
        else finish(new Error('plugin-runtime-dependency-install-failed'))
      })()
    })
  })
}

/** Use only verified host-owned locations; never discover a package manager from PATH. */
export function createPluginRuntimeDependencyInstaller(
  host?: PluginRuntimeDependencyHostContext,
): PluginRuntimeDependencyInstaller | undefined {
  const bunPath = resolvePluginRuntimeDependencyBun(
    process.env,
    process.versions.bun ? process.execPath : undefined,
    host,
  )
  if (!bunPath) return undefined

  return async request => {
    const { directory } = request
    const invocation = buildPluginRuntimeDependencyInstallInvocation(
      bunPath,
      directory,
      // Settings-derived proxy/CA join the ambient env so the installer can
      // traverse the corporate network even when the app was launched
      // without shell-exported proxy variables. PASSTHROUGH_ENV filters the
      // result; the mTLS client identity is plugin-scoped-excluded anyway.
      { ...process.env, ...getPluginNetworkEnvVars() },
      request.frozenLockfile,
    )
    const compatibleLockfile = request.mode === 'locked'
      ? await prepareBunCompatibleLockfile(directory, request.lockfilePath)
      : undefined
    try {
      await Promise.all([
        mkdir(invocation.temporaryDirectory, { recursive: true }),
        mkdir(invocation.cacheDirectory, { recursive: true }),
        mkdir(invocation.homeDirectory, { recursive: true }),
        mkdir(invocation.configDirectory, { recursive: true }),
        mkdir(invocation.dataDirectory, { recursive: true }),
        mkdir(invocation.appDataDirectory, { recursive: true }),
        mkdir(invocation.localAppDataDirectory, { recursive: true }),
      ])
      await Promise.all([
        writeFile(invocation.configPath, 'env = false\ntelemetry = false\n[install]\nignoreScripts = true\n'),
        writeFile(invocation.npmrcPath, ''),
      ])
      try {
        await runDependencyInstallerWithQuota(invocation, directory)
        if (compatibleLockfile) {
          const packageLockBytes = await readFile(compatibleLockfile.packageLockPath)
          if (!compatibleLockfile.shrinkwrapBytes.equals(packageLockBytes)) {
            throw new Error('plugin-runtime-dependency-lock-changed')
          }
        }
      } finally {
        await rm(invocation.temporaryRoot, { recursive: true, force: true })
      }
    } finally {
      if (compatibleLockfile?.createdPackageLock) {
        await rm(compatibleLockfile.packageLockPath, { force: true })
      }
    }
  }
}
