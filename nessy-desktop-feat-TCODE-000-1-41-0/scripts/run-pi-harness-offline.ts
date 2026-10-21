#!/usr/bin/env bun

import {
  chmodSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const EX_USAGE = 64
const TEMP_PREFIX = 'nessy-pi-harness-'
const DARWIN_SANDBOX_EXEC = '/usr/bin/sandbox-exec'
const SYSTEM_PATH = '/Library/Developer/CommandLineTools/usr/bin:/Applications/Xcode.app/Contents/Developer/usr/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/opt/homebrew/sbin'
const TERMINATION_GRACE_MS = 1_500
const KILL_GRACE_MS = 1_500
const SIGNAL_EXIT_CODES: Partial<Record<NodeJS.Signals, number>> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
}

const AMBIENT_ENV_ALLOWLIST = new Set([
  'COLORTERM',
  'FORCE_COLOR',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'NO_COLOR',
  'TERM',
  'TZ',
])

const BUN_OFFLINE_FLAGS = [
  '--no-env-file',
  '--no-install',
  '--prefer-offline',
  '--no-orphans',
  '--bun',
] as const

export interface OfflineCliArgs {
  cwd?: string
  directReadonly?: boolean
  command: string[]
}

export interface OfflineRunOptions extends OfflineCliArgs {
  repoRoot?: string
  environment?: NodeJS.ProcessEnv
  tempParent?: string
  captureOutput?: boolean
}

export interface OfflineRunResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface OfflineRunDependencies {
  spawnChild?: typeof Bun.spawn
  platform?: NodeJS.Platform
  sandboxExecutable?: string | null
  copyRepository?: (sourceRoot: string, copiedRoot: string) => void
}

export interface PhaseAcceptanceManifest {
  id: 'A0'
  gate: string
  testPaths: readonly string[]
  expected: Readonly<{
    pass: number
    fail: number
    expect: number
  }>
}

export interface PhaseAcceptanceResult {
  phase: string
  gate: string
  exitCode: number
  pass: number
  fail: number
  expect: number
  durationMs: number
}

export interface PhaseAcceptanceOptions {
  repoRoot?: string
  tempParent?: string
  now?: () => number
  runOffline?: (options: OfflineRunOptions) => Promise<OfflineRunResult>
  writeStdout?: (value: string) => void
  writeStderr?: (value: string) => void
}

type RunnerCliArgs =
  | { kind: 'phase-acceptance'; phase: 'A0' }
  | { kind: 'command'; options: OfflineCliArgs }

const A0_LINEAGE_TEST = 'packages/pi-agent-server/src/__tests__/pi-session-lineage-real-server.test.ts'

export const A0_PHASE_MANIFEST: PhaseAcceptanceManifest = {
  id: 'A0',
  gate: 'pi-session-lineage-real-server',
  testPaths: [A0_LINEAGE_TEST],
  expected: { pass: 7, fail: 0, expect: 63 },
}

interface IsolationRoots {
  root: string
  home: string
  userProfile: string
  config: string
  data: string
  cache: string
  temp: string
  repositories: string
  workspaces: string
  sessions: string
  repository: string
  bin: string
}

interface ChildLike {
  pid: number
  exited: Promise<number>
  stdout: ReadableStream<Uint8Array> | number | null | undefined
  stderr: ReadableStream<Uint8Array> | number | null | undefined
}

function isWithin(root: string, candidate: string): boolean {
  const delta = relative(root, candidate)
  return delta === '' || (!delta.startsWith(`..${sep}`) && delta !== '..' && !isAbsolute(delta))
}

function resolveProspectivePath(path: string): string {
  const suffix: string[] = []
  let existing = resolve(path)
  while (!existsSync(existing)) {
    suffix.unshift(basename(existing))
    const parent = dirname(existing)
    if (parent === existing) throw new Error('offline-runner-temp-parent-unresolvable')
    existing = parent
  }
  return resolve(realpathSync(existing), ...suffix)
}

export function resolveCommandCwd(repoRoot: string, requested = '.'): string {
  if (!requested || requested.includes('\0')) {
    throw new Error('offline-runner-cwd-invalid')
  }
  if (isAbsolute(requested)) {
    throw new Error('offline-runner-cwd-absolute')
  }
  if (requested.split(/[\\/]+/).includes('..')) {
    throw new Error('offline-runner-cwd-traversal')
  }

  const canonicalRoot = realpathSync(repoRoot)
  const lexicalCandidate = resolve(canonicalRoot, requested)
  if (!isWithin(canonicalRoot, lexicalCandidate) || !existsSync(lexicalCandidate)) {
    throw new Error('offline-runner-cwd-outside-repository')
  }

  const canonicalCandidate = realpathSync(lexicalCandidate)
  if (!isWithin(canonicalRoot, canonicalCandidate)) {
    throw new Error('offline-runner-cwd-symlink-escape')
  }
  return canonicalCandidate
}

export function parseOfflineCliArgs(argv: string[]): OfflineCliArgs {
  const separatorIndex = argv.indexOf('--')
  if (separatorIndex < 0) {
    throw new Error('Usage: run-pi-harness-offline.ts [--direct-readonly] [--cwd <repo-relative-directory>] -- <command...>')
  }

  const runnerArgs = argv.slice(0, separatorIndex)
  const command = argv.slice(separatorIndex + 1)
  let cwd: string | undefined
  let directReadonly = false

  for (let index = 0; index < runnerArgs.length; index += 1) {
    const arg = runnerArgs[index]
    if (arg === '--direct-readonly' && !directReadonly) {
      directReadonly = true
      continue
    }
    if (arg === '--cwd' && cwd === undefined && index + 1 < runnerArgs.length) {
      cwd = runnerArgs[index + 1]
      index += 1
      continue
    }
    throw new Error(`Unknown or incomplete offline-runner argument: ${arg ?? ''}`)
  }

  if (command.length === 0 || !command[0]) {
    throw new Error('offline-runner-command-required')
  }
  return { ...(directReadonly ? { directReadonly: true } : {}), cwd, command }
}

function commandCliArgs(argv: string[]): OfflineCliArgs {
  // Bun consumes the runner's first `--`. Only parse runner options when they
  // are still present; otherwise every remaining token, including `--`, is the
  // child command vector.
  if (argv[0] === '--' || argv[0] === '--cwd' || argv[0] === '--direct-readonly') {
    return parseOfflineCliArgs(argv)
  }
  if (argv.length === 0) throw new Error('offline-runner-command-required')
  return { command: argv }
}

export function parseRunnerCliArgs(argv: string[]): RunnerCliArgs {
  if (argv[0] !== '--phase-acceptance') {
    return { kind: 'command', options: commandCliArgs(argv) }
  }
  if (argv.length !== 2 || !argv[1]) {
    throw new Error('Usage: run-pi-harness-offline.ts --phase-acceptance A0')
  }
  if (argv[1] !== 'A0') {
    throw new Error(`unsupported phase acceptance: ${argv[1]}`)
  }
  return { kind: 'phase-acceptance', phase: 'A0' }
}

export function parseBunTestSummary(output: string): { pass: number; fail: number; expect: number } {
  const plain = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
  const collect = (pattern: RegExp): number[] => [...plain.matchAll(pattern)].map(match => Number(match[1]))
  const pass = collect(/^\s*(\d+) pass\s*$/gm)
  const fail = collect(/^\s*(\d+) fail\s*$/gm)
  const expect = collect(/^\s*(\d+) expect\(\) calls\s*$/gm)
  if (pass.length === 0 || fail.length === 0 || expect.length === 0) {
    throw new Error('missing Bun test summary')
  }
  if (pass.length !== 1 || fail.length !== 1 || expect.length !== 1) {
    throw new Error('ambiguous Bun test summary')
  }
  return { pass: pass[0]!, fail: fail[0]!, expect: expect[0]! }
}

function precheckPhasePaths(repoRoot: string, manifest: PhaseAcceptanceManifest): void {
  const canonicalRoot = realpathSync(repoRoot)
  if (manifest.testPaths.length === 0) {
    throw new Error(`phase acceptance manifest ${manifest.id} has no test paths`)
  }
  for (const testPath of manifest.testPaths) {
    const printablePath = testPath.replaceAll('\0', '\\0')
    const segments = testPath.split('/')
    if (!testPath || testPath.includes('\0') || testPath.includes('\\') || isAbsolute(testPath)
      || /^[A-Za-z]:/.test(testPath)
      || segments.some(segment => !segment || segment === '.' || segment === '..')) {
      throw new Error(`phase acceptance path is invalid: ${printablePath}`)
    }
    const candidate = resolve(canonicalRoot, ...segments)
    if (!existsSync(candidate)) {
      throw new Error(`phase acceptance path does not exist: ${testPath}`)
    }
    if (realpathSync(candidate) !== candidate) {
      throw new Error(`phase acceptance path is not canonical: ${testPath}`)
    }
    if (!lstatSync(candidate).isFile()) {
      throw new Error(`phase acceptance path is not a regular file: ${testPath}`)
    }
  }
}

export async function runPhaseAcceptance(
  manifest: PhaseAcceptanceManifest,
  options: PhaseAcceptanceOptions = {},
): Promise<PhaseAcceptanceResult> {
  const repoRoot = realpathSync(options.repoRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '..'))
  precheckPhasePaths(repoRoot, manifest)
  const now = options.now ?? Date.now
  const writeStdout = options.writeStdout ?? (value => process.stdout.write(value))
  const writeStderr = options.writeStderr ?? (value => process.stderr.write(value))
  const runOffline = options.runOffline ?? runOfflineCommand
  const startedAt = now()
  const result = await runOffline({
    repoRoot,
    directReadonly: true,
    captureOutput: true,
    ...(options.tempParent ? { tempParent: options.tempParent } : {}),
    command: [process.execPath, 'test', ...manifest.testPaths.map(path => `./${path.replace(/^\.\//, '')}`)],
  })
  const durationMs = Math.max(0, now() - startedAt)
  if (result.stdout) writeStdout(result.stdout)
  if (result.stderr) writeStderr(result.stderr)
  let summary: ReturnType<typeof parseBunTestSummary> | undefined
  let summaryError: unknown
  try {
    summary = parseBunTestSummary(`${result.stdout}\n${result.stderr}`)
  } catch (error) {
    summaryError = error
  }

  const counts = summary
    ? `pass=${summary.pass} fail=${summary.fail} expect=${summary.expect}`
    : 'pass=unavailable fail=unavailable expect=unavailable'
  writeStdout(`phase=${manifest.id} gate=${manifest.gate} exit=${result.exitCode} ${counts} duration_ms=${durationMs}\n`)
  if (result.exitCode !== 0) {
    const failure = new Error(`phase acceptance ${manifest.id} exited ${result.exitCode}`)
    if (summaryError !== undefined) failure.cause = summaryError
    throw failure
  }
  if (!summary) throw summaryError
  const expected = manifest.expected
  if (summary.pass !== expected.pass || summary.fail !== expected.fail || summary.expect !== expected.expect) {
    throw new Error(
      `phase acceptance ${manifest.id} count drift: expected ${expected.pass}/${expected.fail}/${expected.expect}, received ${summary.pass}/${summary.fail}/${summary.expect}`,
    )
  }
  const report: PhaseAcceptanceResult = {
    phase: manifest.id,
    gate: manifest.gate,
    exitCode: result.exitCode,
    ...summary,
    durationMs,
  }
  return report
}

export function shouldStripOfflineEnv(name: string): boolean {
  const upper = name.toUpperCase()
  if (AMBIENT_ENV_ALLOWLIST.has(upper)) return false
  return true
}

function createIsolationRoots(parent: string): IsolationRoots {
  mkdirSync(parent, { recursive: true })
  const root = realpathSync(mkdtempSync(join(parent, TEMP_PREFIX)))
  const roots: IsolationRoots = {
    root,
    home: join(root, 'home'),
    userProfile: join(root, 'userprofile'),
    config: join(root, 'config'),
    data: join(root, 'data'),
    cache: join(root, 'cache'),
    temp: join(root, 'tmp'),
    repositories: join(root, 'repositories'),
    workspaces: join(root, 'workspaces'),
    sessions: join(root, 'sessions'),
    repository: join(root, 'repository'),
    bin: join(root, 'bin'),
  }
  for (const path of Object.values(roots)) mkdirSync(path, { recursive: true })
  return roots
}

function hostSpawn(command: string[], cwd?: string): { exitCode: number; stderr: string; stdout: string } {
  const result = Bun.spawnSync(command, {
    cwd,
    env: {
      HOME: '/var/empty',
      PATH: SYSTEM_PATH,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

function isAmbientEnvFile(name: string): boolean {
  return name === '.env'
    || name.startsWith('.env.')
    || ['.npmrc', '.yarnrc', '.pypirc', '.netrc'].includes(name)
}

function collectAmbientEnvFiles(root: string, current = root, result: string[] = []): string[] {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name)
    if (isAmbientEnvFile(entry.name)) {
      result.push(relative(root, path))
    } else if (entry.isDirectory() && !entry.isSymbolicLink()) {
      collectAmbientEnvFiles(root, path, result)
    }
  }
  return result
}

function inventoryAmbientEnvFiles(sourceRoot: string): string[] {
  if (!existsSync(join(sourceRoot, '.git'))) {
    return collectAmbientEnvFiles(sourceRoot).sort()
  }

  const pathspecs = [
    '.env',
    '.env.*',
    '.npmrc',
    '.yarnrc',
    '.pypirc',
    '.netrc',
    ':(glob)**/.env',
    ':(glob)**/.env.*',
    ':(glob)**/.npmrc',
    ':(glob)**/.yarnrc',
    ':(glob)**/.pypirc',
    ':(glob)**/.netrc',
  ]
  const commands = [
    ['/usr/bin/git', '-C', sourceRoot, 'ls-files', '-z', '--', ...pathspecs],
    ['/usr/bin/git', '-C', sourceRoot, 'ls-files', '-z', '--others', '--exclude-standard', '--', ...pathspecs],
    ['/usr/bin/git', '-C', sourceRoot, 'ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', ...pathspecs],
  ]
  const inventory = new Set<string>()
  for (const command of commands) {
    const result = hostSpawn(command)
    if (result.exitCode !== 0) {
      throw new Error(`offline-runner-env-inventory-failed: ${result.stderr.trim()}`)
    }
    for (const relativePath of result.stdout.split('\0').filter(Boolean)) {
      const target = resolve(sourceRoot, relativePath)
      if (!isWithin(sourceRoot, target)) throw new Error('offline-runner-env-inventory-escape')
      inventory.add(relativePath)
    }
  }
  return [...inventory].sort()
}

function removeAmbientEnvFiles(sourceRoot: string, copiedRoot: string): void {
  for (const relativePath of inventoryAmbientEnvFiles(sourceRoot)) {
    rmSync(resolve(copiedRoot, relativePath), { recursive: true, force: true })
  }
}

function copyRepository(sourceRoot: string, copiedRoot: string): void {
  rmSync(copiedRoot, { recursive: true, force: true })
  let result = hostSpawn(['/bin/cp', '-cR', sourceRoot, copiedRoot])
  if (result.exitCode !== 0) {
    rmSync(copiedRoot, { recursive: true, force: true })
    result = hostSpawn(['/bin/cp', '-R', sourceRoot, copiedRoot])
  }
  if (result.exitCode !== 0) {
    throw new Error(`offline-runner-repository-copy-failed: ${result.stderr.trim()}`)
  }
  removeAmbientEnvFiles(sourceRoot, copiedRoot)
}

function installIsolatedBun(roots: IsolationRoots): string {
  const source = realpathSync(process.execPath)
  const target = join(roots.bin, 'bun')
  try {
    copyFileSync(source, target, fsConstants.COPYFILE_FICLONE)
  } catch {
    copyFileSync(source, target)
  }
  chmodSync(target, 0o755)
  linkSync(target, join(roots.bin, 'node'))
  return target
}

function isBunCommand(command: string): boolean {
  if (basename(command).toLowerCase() === 'bun') return true
  if (!isAbsolute(command) || !existsSync(command)) return false
  try {
    return realpathSync(command) === realpathSync(process.execPath)
  } catch {
    return false
  }
}

function prepareCommand(command: string[], isolatedBun: string): string[] {
  if (!command[0]) throw new Error('offline-runner-command-required')
  if (!isBunCommand(command[0])) return [...command]
  return [isolatedBun, ...BUN_OFFLINE_FLAGS, ...command.slice(1)]
}

function buildOfflineEnvironment(source: NodeJS.ProcessEnv, roots: IsolationRoots): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && !shouldStripOfflineEnv(name)) env[name] = value
  }

  return {
    ...env,
    PATH: `${roots.bin}:${SYSTEM_PATH}`,
    HOME: roots.home,
    USERPROFILE: roots.userProfile,
    XDG_CONFIG_HOME: roots.config,
    XDG_DATA_HOME: roots.data,
    XDG_CACHE_HOME: roots.cache,
    TMPDIR: roots.temp,
    TEMP: roots.temp,
    TMP: roots.temp,
    NESSY_CONFIG_DIR: roots.config,
    NESSY_DATA_DIR: roots.data,
    NESSY_CACHE_DIR: roots.cache,
    NESSY_TEMP_DIR: roots.temp,
    NESSY_REPOSITORIES_DIR: roots.repositories,
    NESSY_WORKSPACES_DIR: roots.workspaces,
    NESSY_SESSION_ROOT: roots.sessions,
    BUN_INSTALL_CACHE_DIR: join(roots.cache, 'bun-install'),
    npm_config_offline: 'true',
    NPM_CONFIG_OFFLINE: 'true',
    YARN_ENABLE_NETWORK: '0',
    CARGO_NET_OFFLINE: 'true',
    PIP_NO_INDEX: '1',
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    UV_OFFLINE: '1',
    GIT_TERMINAL_PROMPT: '0',
    HOMEBREW_NO_AUTO_UPDATE: '1',
    NESSY_OFFLINE: '1',
    BUN_OPTIONS: '--no-env-file',
  }
}

function sandboxQuote(path: string): string {
  return `\"${path.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}\"`
}

function sandboxSubpath(path: string): string {
  return `(subpath ${sandboxQuote(path)})`
}

function buildSandboxProfile(
  roots: IsolationRoots,
  sourceRoot: string,
  sourceEnv: NodeJS.ProcessEnv,
  directReadonly: boolean,
  sensitiveFiles: string[],
): string {
  const systemReadRoots = [
    '/System',
    '/usr',
    '/bin',
    '/sbin',
    '/Library',
    '/Library/Developer',
    '/Applications/Xcode.app/Contents/Developer',
    '/private/etc',
    '/dev',
    '/opt/homebrew',
  ].filter(existsSync).map(path => realpathSync(path))
  const readRoots = [...new Set([...systemReadRoots, roots.root, ...(directReadonly ? [sourceRoot] : [])])]
  const deniedRoots = new Set(directReadonly ? [] : [sourceRoot])
  for (const name of ['HOME', 'USERPROFILE']) {
    const value = sourceEnv[name]
    if (!value || !isAbsolute(value) || !existsSync(value)) continue
    const canonical = realpathSync(value)
    if (isWithin(sourceRoot, canonical)) {
      throw new Error('offline-runner-real-home-inside-source-checkout')
    }
    if (isWithin(canonical, roots.root)) {
      throw new Error('offline-runner-isolation-root-inside-real-home')
    }
    if (directReadonly && isWithin(canonical, sourceRoot)) continue
    deniedRoots.add(canonical)
  }

  return [
    '(version 1)',
    '(deny default)',
    '(import "system.sb")',
    '(deny network*)',
    '(allow network* (local ip))',
    '(allow process*)',
    '(allow signal (target same-sandbox))',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    '(allow file-read-metadata)',
    `(allow file-test-existence ${readRoots.map(sandboxSubpath).join(' ')} ${readRoots.map(path => `(path-ancestors ${sandboxQuote(path)})`).join(' ')})`,
    `(allow file-read* ${readRoots.map(sandboxSubpath).join(' ')} ${readRoots.map(path => `(path-ancestors ${sandboxQuote(path)})`).join(' ')})`,
    `(allow file-write* ${sandboxSubpath(roots.root)} (literal "/dev/null"))`,
    ...(directReadonly ? [`(deny file-write* ${sandboxSubpath(sourceRoot)})`] : []),
    ...[...deniedRoots].flatMap(path => [
      `(deny file-read* ${sandboxSubpath(path)})`,
      `(deny file-write* ${sandboxSubpath(path)})`,
    ]),
    ...sensitiveFiles.flatMap(path => [
      `(deny file-read* (literal ${sandboxQuote(path)}))`,
      `(deny file-read-metadata (literal ${sandboxQuote(path)}))`,
      `(deny file-test-existence (literal ${sandboxQuote(path)}))`,
      `(deny file-write* (literal ${sandboxQuote(path)}))`,
    ]),
  ].join('\n')
}

function resolveSandboxExecutable(dependencies: OfflineRunDependencies): string {
  const platform = dependencies.platform ?? process.platform
  const configured = dependencies.sandboxExecutable
  if (platform !== 'darwin') {
    throw new Error(`offline-runner-isolation-unavailable: unsupported platform ${platform}`)
  }
  if (configured === null) {
    throw new Error('offline-runner-isolation-unavailable: sandbox backend disabled or missing')
  }
  const executable = configured ?? DARWIN_SANDBOX_EXEC
  if (!existsSync(executable) || !lstatSync(executable).isFile()) {
    throw new Error(`offline-runner-isolation-unavailable: ${executable}`)
  }
  return executable
}

async function streamText(stream: ReadableStream<Uint8Array> | number | null | undefined): Promise<string> {
  if (!stream || typeof stream === 'number') return ''
  return await new Response(stream).text()
}

async function waitForExit(child: ChildLike, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      child.exited.then(() => true),
      new Promise<boolean>(resolveTimeout => {
        timer = setTimeout(() => resolveTimeout(false), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function waitForProcessGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (processGroupExists(pid)) {
    if (Date.now() >= deadline) return false
    await new Promise(resolve => { setTimeout(resolve, 25) })
  }
  return true
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

async function terminateProcessGroup(child: ChildLike, signal: NodeJS.Signals): Promise<void> {
  signalProcessGroup(child.pid, signal)
  if (await waitForProcessGroupExit(child.pid, TERMINATION_GRACE_MS)) {
    await waitForExit(child, KILL_GRACE_MS)
    return
  }
  signalProcessGroup(child.pid, 'SIGKILL')
  await Promise.all([
    waitForProcessGroupExit(child.pid, KILL_GRACE_MS),
    waitForExit(child, KILL_GRACE_MS),
  ])
}

export async function runOfflineCommand(
  options: OfflineRunOptions,
  dependencies: OfflineRunDependencies = {},
): Promise<OfflineRunResult> {
  const sourceRoot = realpathSync(options.repoRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '..'))
  resolveCommandCwd(sourceRoot, options.cwd)
  const directReadonly = options.directReadonly === true
  const tempParent = options.tempParent ?? tmpdir()
  if (directReadonly && isWithin(sourceRoot, resolveProspectivePath(tempParent))) {
    throw new Error('offline-runner-temp-overlaps-source')
  }
  const roots = createIsolationRoots(tempParent)
  if (isWithin(sourceRoot, roots.root) || isWithin(roots.root, sourceRoot)) {
    rmSync(roots.root, { recursive: true, force: true })
    throw new Error('offline-runner-isolation-root-overlaps-source')
  }
  const cleanup = () => rmSync(roots.root, { recursive: true, force: true })
  const signalHandlers = new Map<NodeJS.Signals, () => void>()
  let child: ChildLike | undefined
  let receivedSignal: NodeJS.Signals | undefined
  let signalCount = 0
  let resolveSignal: ((signal: NodeJS.Signals) => void) | undefined
  const signalPromise = new Promise<NodeJS.Signals>(resolve => { resolveSignal = resolve })

  for (const signal of Object.keys(SIGNAL_EXIT_CODES) as NodeJS.Signals[]) {
    const handler = () => {
      signalCount += 1
      if (!receivedSignal) {
        receivedSignal = signal
        resolveSignal?.(signal)
      }
      if (child) signalProcessGroup(child.pid, signalCount > 1 ? 'SIGKILL' : signal)
    }
    signalHandlers.set(signal, handler)
    process.on(signal, handler)
  }

  try {
    const sandboxExecutable = resolveSandboxExecutable(dependencies)
    if (!directReadonly) {
      const repositoryCopy = dependencies.copyRepository ?? copyRepository
      repositoryCopy(sourceRoot, roots.repository)
    }
    const executionRoot = directReadonly ? sourceRoot : roots.repository
    const disposableCwd = resolveCommandCwd(executionRoot, options.cwd)
    const isolatedBun = installIsolatedBun(roots)
    const command = prepareCommand(options.command, isolatedBun)
    const environment = buildOfflineEnvironment(options.environment ?? process.env, roots)
    const sensitiveFiles = directReadonly
      ? inventoryAmbientEnvFiles(sourceRoot).map(relativePath => resolve(sourceRoot, relativePath))
      : []
    const sandboxProfile = buildSandboxProfile(
      roots,
      sourceRoot,
      options.environment ?? process.env,
      directReadonly,
      sensitiveFiles,
    )
    const spawnChild = dependencies.spawnChild ?? Bun.spawn

    if (receivedSignal) {
      return {
        exitCode: SIGNAL_EXIT_CODES[receivedSignal] ?? 1,
        stdout: '',
        stderr: '',
      }
    }

    child = spawnChild([sandboxExecutable, '-p', sandboxProfile, ...command], {
      cwd: disposableCwd,
      env: environment,
      detached: true,
      stdin: 'inherit',
      stdout: options.captureOutput ? 'pipe' : 'inherit',
      stderr: options.captureOutput ? 'pipe' : 'inherit',
    }) as ChildLike

    const stdoutPromise = streamText(child.stdout)
    const stderrPromise = streamText(child.stderr)
    const outcome = await Promise.race([
      child.exited.then(exitCode => ({ kind: 'exit' as const, exitCode })),
      signalPromise.then(signal => ({ kind: 'signal' as const, signal })),
    ])

    let exitCode: number
    if (outcome.kind === 'signal' || receivedSignal) {
      const signal = receivedSignal ?? (outcome.kind === 'signal' ? outcome.signal : undefined)
      if (!signal) throw new Error('offline-runner-signal-state-invalid')
      await terminateProcessGroup(child, signal)
      exitCode = SIGNAL_EXIT_CODES[signal] ?? 1
    } else {
      exitCode = outcome.exitCode
      if (processGroupExists(child.pid)) await terminateProcessGroup(child, 'SIGTERM')
    }
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise])
    if (receivedSignal) exitCode = SIGNAL_EXIT_CODES[receivedSignal] ?? 1
    return { exitCode, stdout, stderr }
  } finally {
    try {
      if (child && processGroupExists(child.pid)) await terminateProcessGroup(child, 'SIGKILL')
      cleanup()
    } finally {
      for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler)
    }
  }
}

async function main(): Promise<void> {
  try {
    const args = parseRunnerCliArgs(process.argv.slice(2))
    if (args.kind === 'phase-acceptance') {
      await runPhaseAcceptance(A0_PHASE_MANIFEST)
      process.exitCode = 0
    } else {
      const result = await runOfflineCommand(args.options)
      process.exitCode = result.exitCode
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`${message}\n`)
    process.exitCode = message.startsWith('Usage:') ? EX_USAGE : 1
  }
}

if (import.meta.main) await main()
